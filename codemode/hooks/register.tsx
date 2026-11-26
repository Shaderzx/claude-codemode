import type { Hook, Register } from 'claude-code'

// The one tool the model calls. Every other tool is deferred and refused when
// the model calls it directly; scripts reach them through `tools.<name>()`.
// ToolSearch stays callable only to load schemas, which a mod cannot read.
const PLUGIN = 'codemode'
const NAME = 'run'
const FULL = `mcp__${PLUGIN}__${NAME}`
const SEARCH = 'ToolSearch'
const AGENTS_PLUGIN = 'codemode-agents'
const AGENTS_TOOL = `mcp__${AGENTS_PLUGIN}__spawn`
const DEFAULT_TIMEOUT_MS = 600_000
const DEFAULT_MAX_CHARS = 20_000
// Images and PDFs attached to one script's output, at most.
const MAX_PICTURES = 10
// Cut outputs kept whole on disk: those under a day old, at most 200. Every
// session shares the folder, so a count alone would let busy parallel sessions
// delete a file another session's cut still points to.
const KEEP_SPILLS = 200
const SPILL_AGE_MS = 86_400_000
const DENIED_MS = 86_400_000
const MAX_REPLY = 3_800_000

// Argument lines for the built-in tools scripts call most. The description
// names only the ones this session has, so it never offers a tool that a
// setting or another mod removed (a call to it is a wasted round trip).
const COMMON: [string, string][] = [
  ['Read', 'Read({ file_path, offset?, limit? })'],
  ['Write', 'Write({ file_path, content })'],
  ['Edit', 'Edit({ file_path, old_string, new_string, replace_all? })   (Read the file first)'],
  ['Bash', 'Bash({ command, description?, timeout?, run_in_background? })'],
  ['Agent', 'Agent({ description, prompt, subagent_type? })'],
  ['Skill', 'Skill({ skill, args? })'],
  ['AskUserQuestion', 'AskUserQuestion({ questions: [{ question, header, multiSelect, options: [{ label, description }] }] })'],
]

export const describeRun = (names: ReadonlySet<string>, denied: ReadonlyMap<string, string | undefined> = new Map()): string => {
  const has = (n: string) => (names.size === 0 || names.has(n)) && !denied.has(n)
  const common = COMMON.filter(([n]) => has(n)).map(([, l]) => `- ${l}`)
  // Built-ins a model reaches for by habit; a missing one is named, with the
  // session's likeliest replacement, so the first call goes to a tool that exists.
  const missing = [...COMMON.map(([n]) => n), 'Grep', 'Glob']
    .filter((n) => !has(n) && !denied.has(n))
    .map((n) => {
      const alt = ALIKE[n.toLowerCase()] ? similar(n, [...names])[0] : undefined
      // In its script form: named bare, a model loads it with ToolSearch and calls it directly (refused).
      return alt ? `${n} (use tools.${ident(alt)})` : n
    })
  const refused = [...denied].map(([n, alt]) => (alt ? `${n} (use tools.${ident(alt)})` : n))
  const shell = has('Bash') || names.size === 0 || [...names].some((n) => /^mcp__lean[-_]ctx__(?:ctx_)?shell$/.test(n))
  const example = has('Read') && shell
    ? 'const [a, b] = await Promise.all([\n  read("/repo/src/a.ts"),\n  sh("git -C /repo log --oneline -5"),\n])\nconst imports = a.split("\\n").filter((l) => l.includes("import"))\nreturn { imports: imports.join("\\n"), log: b }'
    : has('Read')
      ? 'const [a, b] = await Promise.all([\n  read("/repo/src/a.ts"),\n  read("/repo/src/b.ts"),\n])\nreturn { a, b: b.slice(0, 2000) }'
    : shell
      ? 'const [log, st] = await Promise.all([\n  sh("git -C /repo log --oneline -5"),\n  sh("git -C /repo status --short"),\n])\nreturn { log, st }'
      : 'const [a, b] = await Promise.all([tools.X({ ... }), tools.Y({ ... })])\nreturn { a, b: b.slice(0, 2000) }'
  return [
    'Run a JavaScript script that calls tools. It is the only tool that does work: every other tool is called from inside a script, and a direct call is refused. Only what the script outputs reaches you.',
    '',
    'Every run goes to the background: the call answers at once with its id (r1, r2, ...). A finished run\'s output comes with your next run\'s reply, and an empty script runs nothing and fetches it. End your turn with runs going and a notice comes when they finish. Never poll (empty scripts, jobs() or a waiting script): work on, or end your turn. Esc stops runs.',
    '',
    'Each run re-sends the whole conversation, so do a whole step per script: start every call you can already name at once with Promise.all, and chain steps that need no judgment inside the script.',
    '',
    '`script` is the body of an async function: top-level await and return work. An optional first line sets limits:',
    '// @options: {"timeout_ms": 600000, "max_output_chars": 20000}',
    'Longer output is cut, and the cut names a file that holds all of it.',
    'Text holding ${, backticks or # (shell, Python, HTML) goes in a raw block, never in a template literal: a line // @text NAME, the text, then a line // @end; the script reads it as TEXT.NAME.',
    '',
    'Globals:',
    '- sh(cmd): runs a command on the session\'s shell; resolves to its text with .exitCode and .ok, never throws on a non-zero exit. quote(s) makes s one shell word.',
    '- read(path): a file\'s whole text, no line numbers, line endings as \\n; a relative path starts at the session folder. write(path, text, { force }?), edit(path, old, new, { all, force }?): absolute paths, read the file first ({ force: true } reads it for you).',
    '- waitFor(check, { every = 1000, timeout }): calls check until it returns something truthy; deadline(): ms left.',
    '- tools.<Name>(args): call a tool by its exact name (invalid characters become _: tools.mcp__lean_ctx__ctx_read; a unique suffix such as tools.ctx_read works). Resolves to its text; rejects on failure.',
    '- call(name, args): the same, never throws: { ok, text, result, error, exitCode? }; String(r) is its text. Promise.allSettled also keeps partial results.',
    '- A returned value and text(value) add output items; console.log adds lines.',
    '- describeTool(name): { name, description, input } with input as a TypeScript type when known.',
    '- ask(prompt, { model = "haiku", system, maxTokens }?): one completion by another model, no tools.',
    '- Images and PDFs arrive as markers like [image #1 image/png 12KB]; a marker in the output attaches the picture.',
    '- ALL_TOOLS: [{ name, description }]; searchTools(query, { limit = 8 }?) ranks them.',
    '- jobs(): promise of your other runs still going, [{ id, state, seconds }]; cancel(id) stops one, and its output comes back marked [cancelled].',
    '- store(key, value) / load(key): small JSON kept across runs. exit(): stop successfully. btoa, atob, TextEncoder, TextDecoder, Buffer.',
    'No fetch, timers, process, require or import: only tools reach the outside world.',
    '',
    'Common arguments:',
    ...common,
    ...(missing.length ? [`Not in this session: ${missing.join(', ')}. searchTools() finds other tools.`] : []),
    ...(refused.length ? [`${refused.join(', ')}: denied by a hook here.`] : []),
    '',
    'Tool calls are real: a later failure undoes none, and calls still running when a run ends are abandoned, not stopped.',
    '',
    'Example:',
    example,
  ].join('\n')
}

const RUNNER = String.raw`
// Before Node 25 the permission model does not block the network.
const fs = require('node:fs')
if (+process.versions.node.split('.')[0] < 25) { fs.writeSync(2, 'codemode needs node 25 or later\n'); process.exit(1) }
const vm = require('node:vm')
const MARK = '\x1eCM'
let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (d) => { input += d })
process.stdin.on('end', () => { main(JSON.parse(input)) })
const send = (o, cb) => process.stdout.write(MARK + JSON.stringify(o) + '\n', cb)
for (const k of Object.keys(process.env)) delete process.env[k]
const booted = Date.now()
send({ pid: process.pid, started: booted })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const thenable = (v) => {
  try { return v !== null && (typeof v === 'object' || typeof v === 'function') && typeof v.then === 'function' } catch { return false }
}
const NOT_AWAITED = '[Promise: not awaited; put await before the call]'
const tag = (v) => { try { return Object.prototype.toString.call(v) } catch { return '' } }
const frames = (e) => {
  try { return String(e.stack || '').split('\n').filter((l) => /^\s+at /.test(l) && l.includes('script.js')).slice(0, 5).map((l) => l.trim()) } catch { return [] }
}
const errText = (e) => {
  try { const f = frames(e); return (e.name || 'Error') + ': ' + e.message + (f.length ? ' (' + f.join(', ') + ')' : '') } catch { return 'Error' }
}
const replacer = (k, v) => {
  if (thenable(v)) return NOT_AWAITED
  if (tag(v) === '[object Error]') return errText(v)
  if (typeof v === 'bigint') return String(v)
  return v
}
const json = (v) => {
  try { const s = JSON.stringify(v, replacer, 2); return s === undefined ? String(v) : s } catch { try { return String(v) } catch { return '[a value that cannot be printed]' } }
}
// The script's objects come from the vm context's realm, so plainness is read
// from the prototype chain, not compared with this realm's Object.prototype.
const plain = (v) => {
  try {
    if (Array.isArray(v)) return true
    if (v === null || typeof v !== 'object') return false
    const proto = Object.getPrototypeOf(v)
    return proto === null || (Object.getPrototypeOf(proto) === null && Object.prototype.toString.call(v) === '[object Object]')
  } catch { return false }
}
// Multi-line text inside an object prints raw under one heading per key, not
// as JSON full of \n and \" escapes; other values stay JSON.
const show = (v) => {
  if (typeof v === 'string') return v
  if (tag(v) === '[object String]') return String(v)
  if (v === undefined) return 'undefined'
  if (thenable(v)) return NOT_AWAITED
  if (tag(v) === '[object Error]') return errText(v)
  if (plain(v)) {
    let entries
    try { entries = Object.entries(v) } catch { return json(v) }
    if (entries.length && entries.length <= 100 && entries.some(([, x]) => (typeof x === 'string' || tag(x) === '[object String]') && String(x).includes('\n')))
      return entries.map(([k, x]) => '== ' + k.replace(/\s+/g, ' ') + ' ==\n' + (typeof x === 'string' || tag(x) === '[object String]' ? String(x) : json(x))).join('\n')
  }
  return json(v)
}
const keysOf = (v) => {
  if (!plain(v) || Array.isArray(v)) return undefined
  let entries
  try {
    if (typeof v.toJSON === 'function') return undefined
    entries = Object.entries(v)
  } catch { return undefined }
  const str = (x) => typeof x === 'string' || tag(x) === '[object String]'
  const multi = entries.length <= 100 && entries.some(([, x]) => str(x) && String(x).includes('\n'))
  if (!multi) entries = entries.filter(([, x]) => { try { return JSON.stringify(x, replacer) !== undefined } catch { return true } })
  if (entries.length < 2) return undefined
  return entries.map(([k, x]) => (multi ? '== ' + k.replace(/\s+/g, ' ') + ' ==\n' + (str(x) ? String(x) : json(x)) : JSON.stringify(k) + ': ' + json(x)))
}
const lowAt = (s, i) => { const c = s.charCodeAt(i); return c >= 0xdc00 && c < 0xe000 }
const highAt = (s, i) => { const c = s.charCodeAt(i); return c >= 0xd800 && c < 0xdc00 }
const safeEnd = (s, i) => (i > 0 && i < s.length && lowAt(s, i) && highAt(s, i - 1) ? i - 1 : i)
const safeStart = (s, i) => (i > 0 && i < s.length && lowAt(s, i) && highAt(s, i - 1) ? i + 1 : i)
const shareKeys = (keys, budget) => {
  const out = keys.slice()
  let left = Math.max(0, budget)
  const order = keys.map((k, i) => [k.length, i]).sort((a, b) => a[0] - b[0])
  order.forEach(([len, i], n) => {
    const share = Math.max(0, Math.floor(left / (order.length - n)))
    if (len > share) {
      const note = '…' + (len - share) + ' chars cut past the 1000000-char cap…'
      const k = keys[i]
      if (share > note.length + 20) {
        const half = Math.floor((share - note.length) / 2)
        out[i] = k.slice(0, safeEnd(k, half)) + note + k.slice(safeStart(k, len - half))
      } else out[i] = k.slice(0, safeEnd(k, share))
    }
    left = Math.max(0, left - out[i].length)
  })
  return out
}
const NOTICE = /^\s*<system-reminder>Warning: the file exists but (?:the contents are empty|is shorter than the provided offset \(\d+\)\. The file has \d+ lines)\.<\/system-reminder>\s*$/
const withheldText = (t) => /^\s*\[lean-ctx[^\]\n]*withheld/i.test(String(t)) || (String(t).length < 600 && /^\s*(?:\[(?:POLICY BLOCKED\][^\n]*withheld|withheld by the context gateway\])|(?:stored output (?:is )?withheld by the context gateway|archive withheld by current policy|Tool may have completed; output withheld by policy)\.?\s*$)/i.test(String(t)))
const isStubText = (t) => /^\s*\[(?:Firewalled \S+ output|lean-ctx[^\]\n]*withheld|untrusted input: tool_output overflow)/.test(String(t)) || withheldText(t) || isDedup(t)
const fileLines = (t) => String(t).split('\n').filter((l) => /^\s*\d+\t/.test(l))
const pickLimit = (limit, tried, cap, down) => {
  for (let n = Math.min(down, cap); n >= 1; n--) if (!tried.has(n)) return n
  for (let n = limit + 1; n <= Math.min(2000, cap); n++) if (!tried.has(n)) return n
  return 0
}
const ENDINGS = ' (read() and Read give a file\'s line endings back as \\n, so text taken from a file with CRLF line endings does not match it; for such a file use sh() with sed or perl, or replace the whole file with write())'
const endings = (e) => (/not found/i.test(String(e)) ? ENDINGS : '')
const ident = (n) => n.replace(/[^A-Za-z0-9_$]/g, '_')
class Exit extends Error {}
const TIMERS = 'is not available: use waitFor(check, { every, timeout }) to wait for something, and deadline() for the time left'
const MISSING = {
  fetch: 'fetch is not available in codemode scripts (they have no network): call a tool instead, such as a shell tool or tools.WebFetch',
  XMLHttpRequest: 'XMLHttpRequest is not available in codemode scripts (they have no network): call a tool instead',
  require: 'require is not available: scripts have no modules; use the globals the run tool lists and tools.<Name>()',
  process: 'process is not available: scripts see no environment; ask a shell tool for environment variables',
  setTimeout: 'setTimeout ' + TIMERS,
  setInterval: 'setInterval ' + TIMERS,
  setImmediate: 'setImmediate ' + TIMERS,
  ToolSearch: 'ToolSearch is not a script global: the model calls ToolSearch directly to load a schema; inside a script use describeTool(name) or searchTools(query)',
}
const BT = String.fromCharCode(96)
const DB = '$' + '{'
const TEMPLATE = 'Hint: text from a shell, Python or HTML file inside a template literal breaks it: there ' + DB + ' starts a JS expression and a backtick ends the string. Put such text in a raw block (a line // @text NAME, the text, then a line // @end; the script reads it as TEXT.NAME), or escape them as \\' + DB + ' and \\' + BT + '.'
// Frames of the runner and of Node say nothing about the script; keep its own.
const clean = (err, script) => {
  const stack = err && typeof err.stack === 'string' ? err.stack : ''
  let msg = (err && err.message) || show(err)
  const missing = err && err.name === 'ReferenceError' && /^(\S+) is not defined/.exec(String(err.message))
  const hint = missing && Object.prototype.hasOwnProperty.call(MISSING, missing[1]) ? MISSING[missing[1]] : undefined
  if (!stack) return hint ? 'ReferenceError: ' + hint : msg
  const lines = stack.split('\n').filter((l) => !/^\s+at /.test(l) || l.includes('script.js'))
  if (hint) {
    const at = lines.findIndex((l) => l.startsWith('ReferenceError:'))
    if (at >= 0) lines[at] = 'ReferenceError: ' + hint
  } else if (missing && typeof script === 'string' && script.includes(DB + missing[1])) lines.push(TEMPLATE)
  return lines.join('\n')
}
const syntax = (err, script) => {
  const m = /script\.js:(\d+)/.exec(String(err && err.stack))
  const lines = script.split('\n')
  const n = m ? Math.min(+m[1], lines.length) : 0
  const out = [errText(err) + (n ? ' (script line ' + n + ')' : '')]
  if (n) for (let i = Math.max(1, n - 2); i <= Math.min(lines.length, n + 2); i++) out.push((i === n ? '> ' : '  ') + String(i).padStart(4) + ' | ' + String(lines[i - 1]).slice(0, 300))
  const msg = String(err && err.message)
  const inTemplate = n > 0 && (lines.slice(0, n - 1).join('\n').split(BT).length % 2 === 0 || String(lines[n - 1]).includes(BT) || String(lines[n - 1]).includes(DB))
  if (inTemplate) out.push(TEMPLATE)
  if (/Private field '#/.test(msg)) out.push('Hint: a line starting with # (a shell or Python comment) reached JS code; JS comments start with //, and other languages belong in a // @text block.')
  if (/import statement|Cannot use import/.test(msg)) out.push('Hint: scripts have no modules; use the globals the run tool lists and tools.<Name>().')
  return out.join('\n')
}
const quote = (s) => "'" + String(s).split("'").join("'\\''") + "'"
const isDedup = (t) => {
  const rows = String(t).split('\n').filter((l) => /^\s*\d+\t/.test(l))
  return rows.length <= 2 && /^\s*1\t\S[^\n]* \[unchanged \d+L · lean-ctx read-dedup\]\s*$/.test(rows[0] || '')
}
async function main({ script, tools: all, dir, timeout, texts, cwd, home, denied: deniedList, shell: shellPref, seen: seenList }) {
  fs.mkdirSync(dir, { recursive: true })
  const started = booted
  let room = 1000000
  const keep = (out, s, v) => {
    if (room <= 0) return
    const had = room
    const over = s.length > room ? keysOf(v) : undefined
    if (over) {
      const asJson = !String(over[0]).startsWith('== ')
      const lines = (k) => k.split('\n').length - 1
      const frameOf = (ks) => (asJson ? 4 + ks.reduce((n, k) => n + 4 + 2 * lines(k), 0) : ks.length)
      let budget = room - (asJson ? 4 + 4 * over.length : over.length)
      let fitted = shareKeys(over, budget)
      for (let excess = fitted.reduce((n, k) => n + k.length, 0) + frameOf(fitted) - room, guard = 0; excess > 0 && guard < 30; guard++) {
        budget -= excess + 64
        fitted = shareKeys(over, budget)
        excess = fitted.reduce((n, x) => n + x.length, 0) + frameOf(fitted) - room
      }
      room -= fitted.reduce((n, k) => n + k.length, 0) + frameOf(fitted)
      send({ out, keys: fitted, json: asJson })
      return
    }
    if (s.length > room) s = s.slice(0, safeEnd(s, room)) + '\n…output cut at 1000000 chars…'
    room -= s.length
    const keys = s.length > 1000 && s.length <= had ? keysOf(v) : undefined
    const json = keys && !String(keys[0]).startsWith('== ')
    send(keys ? (s.length * 2 <= had ? { out, text: s, keys } : { out, keys, json }) : { out, text: s })
  }
  let finished = false
  const finish = (failure, kind, failedId) => {
    if (finished) return
    finished = true
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
    if (failure && failure.length > 100000) failure = failure.slice(0, safeEnd(failure, 100000)) + '…'
    send({ done: true, failure, kind, failedId, alongside: failedId ? alongsideOf(failedId) : 0 }, () => process.exit(0))
  }
  const timedOut = () => finish('timed out after ' + timeout + 'ms', 'timeout')
  const endTimedOut = () => {
    timedOut()
    return new Promise(() => {})
  }
  setTimeout(timedOut, Math.max(0, started + timeout - Date.now()))
  const unhandled = new Map()
  process.on('unhandledRejection', (err, p) => { unhandled.set(p, err) })
  process.on('rejectionHandled', (p) => { unhandled.delete(p) })
  const leftover = () => (unhandled.size ? { reason: unhandled.values().next().value } : undefined)
  let seq = 0
  let tick = 0
  const timing = new Map()
  const alongsideOf = (id) => {
    const f = timing.get(id)
    if (!f) return 0
    let n = 0
    for (const [k, t] of timing) if (k !== id && (t.ok || t.answered === undefined) && t.sent < (f.answered ?? Infinity) && (t.answered ?? Infinity) > f.sent) n++
    return n
  }
  const req = async (kind, payload) => {
    const id = ++seq
    // The mod drops a line this long, which would leave the call waiting forever.
    if (JSON.stringify(payload).length > 7000000) return { ok: false, error: 'The request is too large to pass to the mod.', id }
    if (Date.now() >= started + timeout) return endTimedOut()
    const t = { sent: ++tick }
    if (kind === 'call') timing.set(id, t)
    send({ id, kind, payload })
    const file = dir + '/' + id + '.json'
    for (let wait = 1; ; wait = Math.min(wait * 2, 25)) {
      await sleep(wait)
      let res
      try { res = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { continue }
      try { fs.unlinkSync(file) } catch {}
      t.answered = ++tick
      t.ok = !!(res && res.ok)
      if (res && typeof res === 'object') {
        if (res.resultIsText) res.result = res.text
        if (res.droppedResult) res.resultDropped = true
        delete res.resultIsText
        delete res.droppedResult
        Object.defineProperty(res, 'id', { value: id, enumerable: false })
      }
      return res
    }
  }
  const byIdent = new Map(all.map((t) => [ident(t.name), t.name]))
  const names = new Set(all.map((t) => t.name))
  const denied = new Set(deniedList || [])
  const seen = new Set(seenList || [])
  const resolve = (name) => {
    const n = String(name)
    if (names.has(n)) return n
    const byId = byIdent.get(ident(n))
    if (byId) return byId
    const tail = all.filter((t) => t.name.endsWith('__' + n) || ident(t.name).endsWith('__' + ident(n)))
    return tail.length === 1 ? tail[0].name : n
  }
  const toolError = (message, r) => {
    const e = new Error(message)
    e.codemodeTool = true
    if (r && r.id) e.codemodeId = r.id
    return e
  }
  const textual = (r) => {
    const s = () => (r.ok ? String(r.text ?? '') : 'Error: ' + r.error)
    try {
      Object.defineProperty(r, 'toString', { value: s, enumerable: false })
      Object.defineProperty(r, Symbol.toPrimitive, { value: (hint) => (hint === 'number' ? NaN : s()), enumerable: false })
    } catch {}
    return r
  }
  const norm = (s) => {
    if (!s.startsWith('/')) return s
    return '/' + s.split('/').filter((seg) => seg !== '' && seg !== '.').join('/')
  }
  const abs = (p) => {
    const s = String(p).trim()
    if (s.startsWith('/')) return norm(s)
    if (s === '~' || s.startsWith('~/')) return home ? norm(home + s.slice(1)) : s
    return cwd ? norm(cwd.replace(/\/$/, '') + '/' + s.replace(/^\.\//, '')) : s
  }
  const noteRead = (tool, args, r) => {
    const target = args && (typeof args.file_path === 'string' ? args.file_path : args.path)
    if (r.ok && r.whole === true && typeof target === 'string') seen.add(abs(target))
    if (r.ok && Array.isArray(r.readNow)) for (const f of r.readNow) seen.add(f)
    delete r.whole
    delete r.readNow
    if (r.denied && r.alt) denied.add(tool)
    else if (r.ok) denied.delete(tool)
  }
  const call = async (name, args) => {
    const tool = resolve(name)
    const r = await req('call', { tool, args: args ?? {} })
    noteRead(tool, args, r)
    for (const k of ['shellText', 'denied', 'alt', 'refused', 'cut']) delete r[k]
    return textual(r)
  }
  const tools = new Proxy({}, {
    get: (_, key) => {
      if (typeof key !== 'string' || key === 'then' || key === 'toJSON') return undefined
      return async (args) => {
        const tool = resolve(key)
        const r = await req('call', { tool, args: args ?? {} })
        noteRead(tool, args, r)
        if (!r.ok) throw toolError(key + ': ' + r.error, r)
        return r.text
      }
    },
    has: (_, key) => typeof key === 'string' && byIdent.has(key),
    ownKeys: () => [...byIdent.keys()],
    getOwnPropertyDescriptor: (_, key) => typeof key === 'string' && byIdent.has(key) ? { enumerable: true, configurable: true } : undefined,
  })
  const absOnly = (p, who) => {
    const s = String(p).trim()
    if (s.startsWith('/') || s === '~' || s.startsWith('~/')) return abs(s)
    throw toolError(who + ': give an absolute path; ' + s + ' is relative, and the session folder may not be where it started')
  }
  const usable = (n) => names.has(n) && !denied.has(n)
  const named = (re) => all.map((t) => t.name).filter((n) => re.test(n) && !denied.has(n))
  const LEAN_SHELL = /^mcp__lean[-_]ctx__(?:ctx_)?shell$/
  const shells = () => {
    const order = [...new Set([...(shellPref && usable(shellPref) ? [shellPref] : []), ...(usable('Bash') ? ['Bash'] : []), ...named(LEAN_SHELL)])]
    return order.length || !names.has('Bash') ? order : ['Bash']
  }
  const patcher = () => named(/^mcp__lean[-_]ctx__(?:ctx_)?patch$/)[0]
  const shResult = (text, code, tool) => Object.assign(new String(text), { exitCode: code, ok: code === 0, tool }, text && text.withheld === true ? { withheld: true, truncated: true } : {})
  const withheldOutput = (t) => Object.assign(new String(t), { withheld: true })
  const LIMIT = 7000
  const viaFile = async (tool, cmd, extra) => {
    const folder = '/tmp/codemode-' + require('node:crypto').randomBytes(12).toString('hex')
    const clear = () => run(tool, 'rm -rf ' + folder, extra).catch(() => {})
    const made = await run(tool, 'mkdir -m 700 ' + folder, extra)
    if (made.denied || made.exitCode !== 0) throw toolError('sh: the command is ' + Buffer.byteLength(cmd) + ' bytes, over what ' + tool + ' takes, and a private folder for it could not be made: ' + (made.error || String(made)))
    const file = folder + '/command.sh'
    try {
      await write(file, cmd)
    } catch (e) {
      await clear()
      throw toolError('sh: the command is ' + Buffer.byteLength(cmd) + ' bytes, over what ' + tool + ' takes, and writing it to ' + file + ' failed (' + e.message + '); write it to a file yourself and run sh("bash <file>")', { id: e && e.codemodeId })
    }
    let r
    try {
      r = await run(tool, 'bash ' + file + '; rc=$?; rm -rf ' + folder + '; exit $rc', extra)
    } catch (e) {
      await clear()
      throw e
    }
    if (r.denied || typeof r.exitCode !== 'number') await clear()
    return r
  }
  const endLine = (text, bytes) => (Buffer.byteLength(text) + 1 === bytes ? text + '\n' : text)
  const refusedRead = (expand, r) => toolError('sh: the command finished, but reading its output through ' + expand + ' was refused: ' + r.error, r)
  const outOfTime = (id) => toolError('sh: the command finished, but the run ran out of time while fetching its output from lean-ctx archive ' + id + '; fetch it in a new run with ctx_expand(id="' + id + '") in pages (start_line, end_line)')
  const expandPages = async (expand, id, total, chars) => {
    const rows = []
    for (let s = 1; s <= total; ) {
      if (deadline() < 1500) throw outOfTime(id)
      const pageArgs = { id, start_line: s, end_line: Math.min(total, s + 499) }
      const r = await req('call', { tool: expand, args: pageArgs, handled: true })
      if (r.refused || r.denied) throw refusedRead(expand, r)
      if (withheldText(said(r))) {
        const again = await req('call', { tool: expand, args: pageArgs })
        return withheldOutput(withheldText(said(again)) ? said(again) : said(r))
      }
      const got = r.ok ? String(r.text).split('\n').map((l) => /^\s*(\d+)\|([^\n]*)$/.exec(l)).filter(Boolean) : []
      if (!got.length || got.some((m, k) => Number(m[1]) !== s + k)) return undefined
      for (const m of got) rows.push(m[2])
      const next = Number(got[got.length - 1][1]) + 1
      if (next <= s) return undefined
      s = next
    }
    return endLine(rows.join('\n'), chars)
  }
  const fromFile = async (id) => {
    if (!names.has('Read') || !home) throw toolError('sh: the command finished, but its output in lean-ctx archive ' + id + ' could not be fetched (no ctx_expand and no Read here)')
    const file = home + '/.local/share/lean-ctx/archives/' + id.slice(0, 2) + '/' + id + '.txt'
    try {
      return await read(file)
    } catch (e) {
      const why = toolError('sh: the command finished, but its output in lean-ctx archive ' + id + ' could not be read: ' + e.message)
      if (!/over Read's token cap/.test(e.message)) throw why
      return inBytes(file, why)
    }
  }
  const BYTE_STEP = 21000
  const inBytes = async (file, why) => {
    const order = shells()
    if (!order.length) throw why
    const extra = LEAN_SHELL.test(order[0]) ? { raw: true } : {}
    const sized = await run(order[0], 'wc -c < ' + quote(file), extra)
    const size = Number(String(sized).trim())
    if (sized.denied || sized.exitCode !== 0 || !/^\d+$/.test(String(sized).trim())) throw why
    const parts = []
    for (let at = 0; at < size; at += BYTE_STEP) {
      if (deadline() < 1500) throw why
      const r = await run(order[0], 'tail -c +' + (at + 1) + ' ' + quote(file) + ' | head -c ' + BYTE_STEP + ' | base64', extra)
      const text = String(r).replace(/\s+/g, '')
      if (r.denied || r.exitCode !== 0 || r.truncated || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) throw why
      const part = Buffer.from(text, 'base64')
      if (part.length !== Math.min(BYTE_STEP, size - at)) throw why
      parts.push(part)
    }
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts))
    } catch {
      throw why
    }
  }
  const archived = async (id) => {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(id)) return ''
    const expand = named(/^mcp__lean[-_]ctx__(?:ctx_)?expand$/)[0]
    if (expand) {
      const r = await req('call', { tool: expand, args: { id } })
      if (r.refused || r.denied) throw refusedRead(expand, r)
      const t = String(r.text ?? '')
      if (withheldText(said(r))) return withheldOutput(said(r))
      if (r.ok && isStubText(t)) return fromFile(namedArchive(t) ?? id)
      if (r.ok && /^Background job '[^']+' finished \(exit \d+\) without output\.\s*$/.test(t)) return ''
      const head = r.ok ? /^Archive ([A-Za-z0-9_-]+) [^\n]*?\((\d+) chars, (\d+) lines\):(?:\n|$)/.exec(t) : null
      if (head) {
        const aid = head[1]
        const chars = Number(head[2])
        const total = Number(head[3])
        const shown = t.slice(head[0].length)
        const body = shown.replace(/(?:^|\n)\[… truncated at [^\n]*\](?:\n\[Original available[^\n]*\])?\s*$/, '')
        const fits = Math.abs(Buffer.byteLength(body) - chars) <= 1
        if (body === shown && fits && (head[0].endsWith('\n') || chars === 0) && body.split('\n').length >= total) return endLine(body, chars)
        const paged = await expandPages(expand, aid, total, chars)
        if (paged !== undefined) return paged
        return fromFile(aid)
      }
    }
    return fromFile(id)
  }
  const said = (r) => String((r.ok ? r.text : r.error) ?? '')
  const namedArchive = (t) => /ctx_expand\(id="?([A-Za-z0-9_-]+)"?\)|ctx_expand id=([A-Za-z0-9_-]+)/.exec(String(t))?.slice(1).find(Boolean)
  const jobOutput = async (body, id) => {
    if (withheldText(body)) return withheldOutput(body)
    if (!isStubText(body) && !/^\s*\[Firewalled /.test(body)) return body
    return archived(namedArchive(body) ?? id)
  }
  const EXIT_TAIL = /\n\[exit:(\d+)\]\n?$/
  const exitless = (text, code) => {
    const m = EXIT_TAIL.exec(String(text))
    if (!m || (code !== undefined && Number(m[1]) !== code)) return { text, code }
    return { text: Object.assign(new String(String(text).slice(0, m.index)), text && text.withheld === true ? { withheld: true } : {}), code: Number(m[1]) }
  }
  const LEAN_CUT = /\n?\[… truncated at ~\d+ of \d+ tokens — the full output is archived — see the next line\]\n\[Original available via ctx_expand id=([A-Za-z0-9_-]+)\]\s*$/
  const ADVICE = /\n\[ctx_shell: [^\n]*\]\s*$/
  const follow = async (tool, id) => {
    for (let wait = 200; ; wait = Math.min(wait * 2, 2000)) {
      if (deadline() < wait + 500)
        throw toolError('sh: ' + tool + ' moved the command to background job ' + id + ', still running as the run ends; check it with tools.' + ident(tool) + '({ background_action: "status", job_id: "' + id + '" })')
      await sleep(wait)
      const s = await req('call', { tool, args: { background_action: 'status', job_id: id }, handled: true, poll: true })
      if (s.ok) {
        let j
        try { j = JSON.parse(String(s.shellText ?? s.text)) } catch { j = undefined }
        if (j && j.state === 'running') continue
        if (j && j.state === 'completed') {
          const quiet = j.archiveId === undefined && (j.capturedChars === 0 || j.summary === 'no output')
          const done = shResult(quiet ? '' : await archived(j.archiveId ?? id), typeof j.exitCode === 'number' ? j.exitCode : quiet ? 0 : undefined, tool)
          if (j.archiveTruncated === true) done.truncated = true
          return done
        }
        throw toolError('sh: background job ' + id + ' on ' + tool + ' answered: ' + String(s.text).slice(0, 300), s)
      }
      const err = String(s.error ?? '')
      const failed = /^\s*\[background:[^\]\n]*failed, exit (\d+)\]\n([\s\S]*?)\n\n\[exit:\d+[^\]\n]*\]\s*$/.exec(err) ?? /^\s*\[background:[^\]\n]*failed, exit (\d+)\]\n?([\s\S]*?)\n*(?:\[exit:\d+[^\]\n]*\])?\s*$/.exec(err)
      if (failed) {
        const inline = failed[2]
        const whole = !s.cut && !isStubText(inline) && !/^\s*\[Firewalled /.test(inline)
        const expandable = named(/^mcp__lean[-_]ctx__(?:ctx_)?expand$/).length > 0
        const fetched = expandable ? await archived(namedArchive(inline) ?? id).then((t) => exitless(t, Number(failed[1])).text, (e) => (whole ? inline : Promise.reject(e))) : await jobOutput(inline, id)
        const out = expandable ? fetched : exitless(fetched, Number(failed[1])).text
        const done = shResult(out, Number(failed[1]), tool)
        if (s.cut && !expandable) {
          done.truncated = true
          await req('cut', { tool })
        }
        return done
      }
      if (typeof s.exitCode === 'number') return shResult(await jobOutput(String(s.shellText ?? '').replace(/^\s*\[background:[^\]\n]*\]\n?/, ''), id), s.exitCode, tool)
      throw toolError('sh: background job ' + id + ' on ' + tool + ': ' + s.error, s)
    }
  }
  const tooLong = (cmd, tool) =>
    toolError('sh: the command is ' + Buffer.byteLength(cmd) + ' bytes, over the ' + LIMIT + '-byte limit of ' + tool + '; pass { stage: true } to run it from a private file written through write(), and know that the shell tool\'s hooks then only see "bash <file>" (the write tool\'s hooks see the whole command), or write it yourself and run sh("bash <file>")')
  const run = async (tool, cmd, extra, stage = false) => {
    if (LEAN_SHELL.test(tool) && Buffer.byteLength(cmd) > LIMIT) {
      if (stage) return viaFile(tool, cmd, extra)
      throw tooLong(cmd, tool)
    }
    const lean = LEAN_SHELL.test(tool)
    const fill = lean ? { fill: { raw: true, timeout_ms: Math.max(1000, Math.min(3600000, deadline())) } } : {}
    const r = await req('call', { tool, args: { ...extra, command: cmd }, foreground: true, ...fill })
    if (r.denied) return r
    const job = r.ok && lean && typeof r.job === 'string' ? r.job : undefined
    if (job) return follow(tool, job)
    if (lean && !r.denied) {
      const out = String(r.shellText ?? r.text ?? r.error ?? '').replace(ADVICE, '')
      const kept = LEAN_CUT.exec(out)
      if (kept) {
        const whole = await archived(kept[1])
        if (r.ok) return shResult(whole, typeof r.exitCode === 'number' ? r.exitCode : 0, tool)
        const back = exitless(whole, typeof r.exitCode === 'number' ? r.exitCode : undefined)
        return shResult(back.text, back.code, tool)
      }
      if (withheldText(out)) return shResult(withheldOutput(out), typeof r.exitCode === 'number' ? r.exitCode : r.ok ? 0 : undefined, tool)
      if (r.shellText !== undefined) r.shellText = out
    }
    if (typeof r.exitCode === 'number') {
      const done = shResult(r.shellText ?? r.text ?? r.error ?? '', r.exitCode, tool)
      if (r.cut) done.truncated = true
      return done
    }
    if (r.ok) return shResult(r.shellText ?? r.text, 0, tool)
    if (/^\s*ERROR: Command too large \(\d+ bytes, limit \d+\)/.test(String(r.error))) {
      if (stage) return viaFile(tool, cmd, extra)
      throw tooLong(cmd, tool)
    }
    throw toolError('sh: ' + tool + ': ' + r.error, r)
  }
  const sh = async (command, opts) => {
    const extra = opts && typeof opts === 'object' ? { ...opts } : {}
    const stage = extra.stage === true
    delete extra.stage
    for (const k of Object.keys(extra)) if (/background/i.test(k) && !extra[k]) delete extra[k]
    if (Object.keys(extra).some((k) => /background/i.test(k))) throw toolError('sh() waits for its command and gives its exit code, so it starts no background job; call the shell tool directly for that')
    const order = shells()
    if (!order.length) throw toolError('sh: this session has no shell tool (no Bash, and no lean-ctx shell; CODEMODE_SHELL can name one)')
    const r = await run(order[0], String(command), extra, stage)
    if (!r.denied) return r
    if (r.alt) denied.add(order[0])
    throw toolError('sh: ' + r.error, r)
  }
  let readSeq = 0
  const read = (path) => readText(path, false)
  const readText = async (path, internal) => {
    const readId = ++readSeq
    if (!names.has('Read')) throw toolError('read: this session has no Read tool')
    const file = abs(path)
    const rows = []
    let offset = 1
    let limit = 2000
    let stubbed = 0
    let tried = new Set()
    let cap = 2000
    let whole = false
    for (;;) {
      const r = await req('call', { tool: 'Read', args: { file_path: file, offset, limit }, handled: true, readId, ...(internal ? { internal: true } : {}) })
      const cutAtCap = r.ok && r.result && r.result.file && r.result.file.truncatedByTokenCap === true
      if (!r.ok || cutAtCap) {
        if (cutAtCap || /exceeds maximum allowed/i.test(String(r.error))) {
          tried.add(limit)
          cap = Math.min(cap, limit - 1)
          limit = pickLimit(limit, tried, cap, Math.floor(limit / 2))
          if (limit) continue
          throw toolError('read: ' + file + ' has a line over Read\'s token cap at line ' + offset + ', so it cannot be read in pages; read part of it with sh() and head -c', r)
        }
        if (/EISDIR/.test(String(r.error))) throw toolError('read: ' + file + ' is a folder, not a file', r)
        throw toolError('read: ' + r.error, r)
      }
      if (r.whole === true) whole = true
      const t = String(r.text)
      if (isDedup(t)) {
        tried.add(limit)
        limit = ++stubbed > 6 ? 0 : pickLimit(limit, tried, cap, Math.max(1, Math.min(limit, 2000) - 1 - Math.floor(Math.random() * Math.min(400, Math.floor(limit / 2)))))
        if (!limit) throw toolError('read: Read keeps answering with a stub, not the file: ' + t.slice(0, 200), r)
        continue
      }
      const got = fileLines(t).map((l) => l.replace(/^\s*\d+\t/, ''))
      if (!got.length && !NOTICE.test(t))
        throw toolError('read: Read answered with no file lines (a picture, a binary file, or a hook rewrote the answer): ' + t.slice(0, 200), r)
      rows.push(...got)
      const total = r.result && r.result.file && typeof r.result.file.totalLines === 'number' ? r.result.file.totalLines : undefined
      const more = total !== undefined && offset + got.length - 1 < total
      if ((got.length < limit && !more) || r.whole === true) break
      offset += got.length
      tried = new Set()
      cap = 2000
      limit = Math.min(2000, limit * 2)
      stubbed = 0
    }
    if (whole && !internal) seen.add(file)
    return rows.join('\n')
  }
  const UNREAD = /read it first|has not been read|modified since read|changed since (?:it was )?last read/i
  const MOVED = /modified since read|changed since (?:it was )?last read/i
  const wrote = (file, verb = 'wrote') => {
    seen.add(file)
    return verb + ' ' + file
  }
  const timeToRetry = (tryStarted) => started + timeout - Date.now() > Math.max(500, Date.now() - tryStarted + 100)
  const pause = (n) => sleep(Math.min(Math.min(500, 10 * 2 ** n) * (1 + Math.random()), Math.max(0, started + timeout - Date.now() - 400)))
  const freshOf = async (file, what) => {
    const check = await req('fresh', { path: file })
    if (!check || check.ok === false) throw toolError(what + ': ' + (check && check.error), check)
    return check
  }
  const forcedRead = async (file, what) => {
    const settleBy = Date.now() + 5000
    for (let n = 0; ; n++) {
      if (n) await pause(n)
      let text
      try {
        text = await read(file)
      } catch (err) {
        if (!/changed while it was read/i.test(String(err && err.message))) throw err
      }
      if (text !== undefined) {
        const check = await freshOf(file, what)
        if (check.fresh === true && typeof check.version === 'string') return { text, check }
      }
      if (started + timeout - Date.now() < 300) throw toolError(what + ': ' + file + ' was not replaced: the run ran out of time while it kept changing; try again once it settles, or give the run a longer timeout_ms')
      if (Date.now() >= settleBy) throw toolError(what + ': ' + file + ' keeps changing while it is read, so it was not replaced; try again once it settles')
    }
  }
  const guardOf = (check) => (typeof check.version === 'string' ? { expectedVersion: check.version, ...(typeof check.real === 'string' ? { expectedReal: check.real } : {}) } : {})
  const unreadWrite = (r) => !r.ok && !r.refused && !r.denied && UNREAD.test(String(r.error))
  const write = async (path, content, opts) => {
    const file = absOnly(path, 'write')
    const body = String(content)
    const force = !!(opts && typeof opts === 'object' && opts.force)
    if (usable('Write')) {
      let r = await req('call', { tool: 'Write', args: { file_path: file, content: body } })
      if (unreadWrite(r) && !force && MOVED.test(String(r.error))) throw toolError('write: ' + file + ' changed since this session read it: read(path) it again, or pass { force: true } to replace it', r)
      if (unreadWrite(r) && !force) throw toolError('write: ' + file + ' exists and this session has not read it: read(path) it first, or pass { force: true } to replace it unread', r)
      for (let n = 0; unreadWrite(r); n++) {
        if (n) await pause(n)
        const tryStarted = Date.now()
        await forcedRead(file, 'write')
        r = await req('call', { tool: 'Write', args: { file_path: file, content: body } })
        if (!timeToRetry(tryStarted)) break
      }
      if (r.ok) return wrote(file)
      if (r.denied && r.alt) denied.add('Write')
      throw toolError('write: ' + r.error, r)
    }
    const patch = patcher()
    if (!patch) throw toolError('write: this session has no Write tool and no patch tool')
    let r = await req('call', { tool: patch, args: { op: 'create', path: file, new_text: body } })
    if (r.ok) return wrote(file)
    if (r.refused || r.denied || !/already exists/i.test(String(r.error))) throw toolError('write: ' + r.error, r)
    const moved = () => toolError('write: ' + file + ' changed since this session read it: read(path) it again, or pass { force: true } to replace it', r)
    const empty = () => toolError('write: ' + file + ' exists and is empty, and the patch tool cannot replace an empty file; use Write, or remove the file first')
    const replaceWhole = async (now, check) => {
      const guard = guardOf(check)
      const once = (old) => req('call', { tool: patch, args: { op: 'replace_unique', path: file, old_text: old, new_text: body }, ...guard })
      const first = await once(now)
      const crlf = !first.ok && !first.refused && !first.denied && !unreadWrite(first) && /not found/i.test(String(first.error)) && !now.includes('\r')
      return crlf ? once(now.split('\n').join('\r\n')) : first
    }
    if (!force) {
      const check = await freshOf(file, 'write')
      if (!check.read) throw toolError('write: ' + file + ' exists and this session has not read it: read(path) it first, or pass { force: true } to replace its whole text unread', r)
      if (check.fresh === false) throw moved()
      const now = await readText(file, true)
      if (!now) throw empty()
      r = await replaceWhole(now, check)
      if (r.ok) return wrote(file)
      if (unreadWrite(r) && !MOVED.test(String(r.error))) throw toolError('write: ' + file + ' exists and this session has not read it: read(path) it first, or pass { force: true } to replace its whole text unread', r)
      if (unreadWrite(r)) throw moved()
      throw toolError('write: ' + r.error + endings(r.error), r)
    }
    for (let n = 0; ; n++) {
      if (n) await pause(n)
      const tryStarted = Date.now()
      const { text: now, check } = await forcedRead(file, 'write')
      if (!now) throw empty()
      r = await replaceWhole(now, check)
      if (r.ok) return wrote(file)
      if (!unreadWrite(r) || !timeToRetry(tryStarted)) break
    }
    throw toolError('write: ' + r.error + endings(r.error), r)
  }
  const edit = async (path, from, to, opts) => {
    const file = absOnly(path, 'edit')
    const o = opts && typeof opts === 'object' ? opts : {}
    const force = !!o.force
    const all = !!o.all
    const unread = (r) => toolError('edit: ' + file + ' has not been read in this session: read(path) it first, or pass { force: true } to read it and edit it', r)
    if (usable('Edit')) {
      const args = { file_path: file, old_string: String(from), new_string: String(to), ...(all ? { replace_all: true } : {}) }
      let r = await req('call', { tool: 'Edit', args })
      if (unreadWrite(r) && !force && MOVED.test(String(r.error))) throw toolError('edit: ' + file + ' changed since this session read it: read(path) it again, or pass { force: true }', r)
      if (unreadWrite(r) && !force) throw unread(r)
      for (let n = 0; unreadWrite(r); n++) {
        if (n) await pause(n)
        const tryStarted = Date.now()
        await forcedRead(file, 'edit')
        r = await req('call', { tool: 'Edit', args })
        if (!timeToRetry(tryStarted)) break
      }
      if (r.ok) return wrote(file, 'edited')
      if (r.denied && r.alt) denied.add('Edit')
      throw toolError('edit: ' + r.error + endings(r.error), r)
    }
    const patch = patcher()
    if (!patch) throw toolError('edit: this session has no Edit tool and no patch tool')
    const moved = (r) => toolError('edit: ' + file + ' changed since this session read it: read(path) it again, or pass { force: true }', r)
    let tryStarted = Date.now()
    let check = await freshOf(file, 'edit')
    let reread = false
    if (!check.read || check.fresh === false) {
      if (!force) throw check.read ? moved() : unread()
      check = (await forcedRead(file, 'edit')).check
      reread = true
    }
    const args = { op: all ? 'replace_all' : 'replace_unique', path: file, old_text: String(from), new_text: String(to) }
    let r = await req('call', { tool: patch, args, ...guardOf(check) })
    for (let n = 1; force && unreadWrite(r) && (!reread || timeToRetry(tryStarted)); n++) {
      if (reread) await pause(n)
      reread = true
      tryStarted = Date.now()
      r = await req('call', { tool: patch, args, ...guardOf((await forcedRead(file, 'edit')).check) })
    }
    if (r.ok) return wrote(file, 'edited')
    if (unreadWrite(r) && !force && !MOVED.test(String(r.error))) throw unread(r)
    if (unreadWrite(r)) throw moved(r)
    throw toolError('edit: ' + r.error + endings(r.error), r)
  }
  const deadline = () => Math.max(0, started + timeout - Date.now())
  const waitFor = async (check, opts) => {
    if (typeof check !== 'function') throw new Error('waitFor: check must be a function, such as () => sh("test -f /tmp/ready")')
    const o = opts && typeof opts === 'object' ? opts : {}
    const every = Math.max(10, o.every === undefined || !Number.isFinite(Number(o.every)) ? 1000 : Number(o.every))
    const asked = o.timeout === undefined || o.timeout === null || o.timeout === '' ? NaN : Number(o.timeout)
    const limit = Math.max(0, Math.min(Number.isFinite(asked) ? asked : deadline() - 1000, deadline()))
    const t0 = Date.now()
    const LATE = {}
    const done = (v) => {
      if (!v) return false
      try { return v.ok !== false } catch { return true }
    }
    let last
    for (let first = true; ; first = false) {
      const left = limit - (Date.now() - t0)
      if (left <= 0 && !first) throw new Error('waitFor timed out after ' + limit + 'ms; the check last returned ' + show(last))
      const pending = Promise.resolve().then(check)
      const v = await Promise.race([pending, sleep(Math.max(1, left)).then(() => LATE)])
      if (v === LATE) pending.catch(() => {})
      if (v === LATE) throw new Error('waitFor timed out after ' + limit + 'ms while a check was still running (its tool calls may still finish)')
      if (done(v)) return v
      last = v
      const rest = limit - (Date.now() - t0)
      if (rest <= 0) throw new Error('waitFor timed out after ' + limit + 'ms; the check last returned ' + show(last))
      await sleep(Math.min(every, rest))
    }
  }
  // A listing carries each tool's first sentence; describeTool has the rest.
  const brief = (d) => {
    // The first line with words (some start with a blank line or a heading), up to
    // its first sentence end that is not an abbreviation.
    const s = String(d).split('\n').map((l) => l.trim().replace(/^(?:[-*]|\d+[.)])\s+/, '')).find((l) => l && !l.startsWith('#') && !/^[-*=_\s]+$/.test(l)) || ''
    let o = s
    for (const m of s.matchAll(/[.!?](?=\s|$)/g)) {
      if (/\b(?:e\.g|i\.e|etc|vs)$/i.test(s.slice(0, m.index))) continue
      o = s.slice(0, m.index + 1)
      break
    }
    if (o.length <= 120) return o
    const cut = o.lastIndexOf(' ', 119)
    return o.slice(0, cut > 60 ? cut : 119) + '…'
  }
  const listed = all.map((t) => ({ name: t.name, description: brief(t.description) }))
  const searchTools = (query, opts) => {
    const words = String(query).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
    return all.map((t, i) => {
      let score = 0
      for (const w of words) {
        if (t.name.toLowerCase().includes(w)) score += 5
        if (t.description.toLowerCase().includes(w)) score += 1
      }
      return { t: listed[i], score }
    }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, (opts && opts.limit) || 8).map((x) => x.t)
  }
  const log = (...a) => { keep('log', a.map(show).join(' ')) }
  const answer = async (name, kind, payload) => {
    const r = await req(kind, payload)
    if (!r.ok) throw new Error(name + ': ' + r.error)
    return r.value
  }
  const ctx = vm.createContext({
    tools, call, ALL_TOOLS: listed, searchTools,
    TEXT: new Proxy(Object.freeze(Object.assign(Object.create(null), texts || {})), {
      get: (t, k) => {
        if (typeof k !== 'string' || k in t || k === 'then' || k === 'toJSON') return t[k]
        throw new ReferenceError('TEXT.' + k + ' is no // @text block; the blocks here are: ' + (Object.keys(t).join(', ') || 'none'))
      },
    }),
    sh, quote, read, write, edit, waitFor, deadline,
    btoa, atob, TextEncoder, TextDecoder, Buffer,
    text: (v) => { keep('item', show(v), v) },
    console: { log, info: log, warn: log, error: log, debug: log },
    describeTool: (name) => answer('describeTool', 'describe', { tool: resolve(name) }),
    ask: async (prompt, opts) => {
      const o = opts && typeof opts === 'object' ? opts : {}
      const r = await req('ask', { prompt: String(prompt), model: o.model, system: o.system, maxTokens: o.maxTokens, effort: o.effort })
      if (!r.ok) throw new Error('ask: ' + r.error)
      return r.text
    },
    store: async (key, value) => { const r = await req('store', { key: String(key), value }); if (!r.ok) throw new Error('store: ' + r.error) },
    load: (key) => answer('load', 'load', { key: String(key) }),
    jobs: () => answer('jobs', 'jobs', {}),
    cancel: async (id) => { const r = await req('cancel', { id: String(id) }); if (!r.ok) throw new Error('cancel: ' + r.error); return r.value },
    exit: () => { throw new Exit() },
  })
  vm.runInContext('(() => { const parse = JSON.parse; JSON.parse = function (text, reviver) { let tried = false; const watch = typeof reviver === "function" ? function (...a) { tried = true; return reviver.apply(this, a) } : reviver; try { return parse.call(JSON, text, watch) } catch (e) { if (tried || !(e instanceof SyntaxError)) throw e; let s; try { s = String(text) } catch { s = typeof text }; throw new SyntaxError(e.message + " (the text starts: " + JSON.stringify(s.slice(0, 60)) + (s.length > 60 ? "…" : "") + ")") } } })()', ctx, { filename: 'codemode-prelude.js' })
  let fn
  try {
    fn = vm.runInContext('(async () => {"use strict";\n' + script + '\n})', ctx, { filename: 'script.js', lineOffset: -1 })
  } catch (err) {
    finish(syntax(err, script), 'syntax')
    return
  }
  let failure
  let kind
  let failedId
  try {
    const value = await fn()
    if (value !== undefined) keep('item', show(value), value)
    await sleep(0)
    const late = leftover()
    if (late) throw late.reason === undefined ? new Error('a promise was rejected with no reason (undefined), and nothing handled it') : late.reason
  } catch (err) {
    if (!(err instanceof Exit)) {
      failure = clean(err, script)
      kind = err && err.codemodeTool ? 'tool' : 'script'
      failedId = err && err.codemodeId
    }
  }
  if (Date.now() >= started + timeout) timedOut()
  else finish(failure, kind, failedId)
}

`

type Options = { timeout_ms?: number; max_output_chars?: number }

export const parseOptions = (script: string): { options: Options; error?: string } => {
  // Only the first non-blank line counts, so a script can carry the text in a string.
  const first = script.split('\n').find((l) => l.trim()) ?? ''
  if (!/^\s*\/\/\s*@options:/.test(first)) return { options: {} }
  try {
    const options: unknown = JSON.parse(first.trim().replace(/^\/\/\s*@options:/, '').trim())
    if (!options || typeof options !== 'object' || Array.isArray(options))
      return { options: {}, error: 'The // @options: line must hold a JSON object.' }
    return { options: options as Options }
  } catch (err) {
    return { options: {}, error: `Bad // @options: JSON: ${(err as Error).message}` }
  }
}

export const extractText = (script: string): { script: string; texts: Record<string, string>; error?: string } => {
  const lines = script.split('\n')
  const texts: Record<string, string> = Object.create(null)
  const opened: Record<string, number> = Object.create(null)
  const stack: ('tpl' | number)[] = []
  let comment = false
  let prev = ''
  let word = ''
  const KEYWORDS = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'await', 'yield', 'instanceof', 'debugger', 'break', 'continue'])
  const parens: string[] = []
  const braces: boolean[] = []
  let fn: { expression: boolean; depth: number } | undefined
  let asyncOpens = false
  const keyword = (w: string) => KEYWORDS.has(w) && (w !== 'of' || parens[parens.length - 1] === 'for')
  let lead = false
  let caseAt = -1
  let before = ''
  const closeQuote = (l: string, from: number, q: string) => {
    for (let i = from; i < l.length; i++) {
      if (l[i] === '\\') i++
      else if (l[i] === q) return i
    }
    return -1
  }
  const continues = (l: string) => (/\\+$/.exec(l)?.[0].length ?? 0) % 2 === 1
  let quote = ''
  let lineNo = 0
  let asyncLine = -1
  const scan = (l: string) => {
    lineNo++
    let start = 0
    if (quote) {
      const end = closeQuote(l, 0, quote)
      if (end < 0) {
        if (!continues(l)) quote = ''
        return
      }
      quote = ''
      prev = '"'
      word = ''
      start = end + 1
    }
    for (let i = start; i < l.length; i++) {
      const ch = l[i] as string
      const top = stack[stack.length - 1]
      if (comment) {
        if (ch === '*' && l[i + 1] === '/') {
          comment = false
          i++
        }
        continue
      }
      if (top === 'tpl') {
        if (ch === '\\') i++
        else if (ch === '`') {
          stack.pop()
          prev = '"'
          word = ''
        } else if (ch === '$' && l[i + 1] === '{') {
          stack.push(0)
          i++
          prev = '{'
        }
        continue
      }
      if (/\s/.test(ch)) continue
      if (ch === '/' && l[i + 1] === '/') return
      if (ch === '/' && l[i + 1] === '*') {
        comment = true
        i++
        continue
      }
      if (ch === '/' && (prev === '' || '(,=:[!&|?{};+-*%<>~^}A'.includes(prev) || keyword(word))) {
        let cls = false
        for (i++; i < l.length; i++) {
          const c = l[i]
          if (c === '\\') i++
          else if (c === '[') cls = true
          else if (c === ']') cls = false
          else if (c === '/' && !cls) break
        }
        while (i + 1 < l.length && /[a-z]/i.test(l[i + 1] as string)) i++
        prev = '"'
        word = ''
        continue
      }
      if (ch === '"' || ch === "'") {
        const end = closeQuote(l, i + 1, ch)
        if (end < 0) {
          if (continues(l)) quote = ch
          return
        }
        i = end
        prev = '"'
        word = ''
        continue
      }
      if (/[\w$]/.test(ch)) {
        let j = i
        while (j < l.length && /[\w$]/.test(l[j] as string)) j++
        before = word
        word = prev === '.' ? '' : l.slice(i, j)
        lead = word !== '' && typeof top !== 'number' && (prev === '' || prev === ';' || prev === '}' || (prev === '{' && braces[braces.length - 1] === false))
        if (lead && (word === 'case' || word === 'default')) caseAt = parens.length + braces.length
        const opens = (prev !== '' && '(,=:[!&|?+-*%<>~^A'.includes(prev)) || (prev === 'a' && keyword(before))
        if (word === 'async') {
          asyncOpens = opens
          asyncLine = lineNo
        }
        if (word === 'function' || word === 'class') fn = { expression: before === 'async' && prev === 'a' && asyncLine === lineNo ? asyncOpens : opens, depth: parens.length }
        prev = 'a'
        i = j - 1
        continue
      }
      if ((ch === '+' || ch === '-') && l[i + 1] === ch && (prev === 'a' || prev === ')' || prev === ']')) {
        i++
        prev = ')'
        word = ''
        continue
      }
      if (ch === '(') parens.push(['if', 'while', 'for', 'with'].includes(word) ? word : word === 'await' && before === 'for' ? 'for' : '')
      if (ch === ')') {
        prev = parens.pop() ? ';' : ')'
        word = ''
        continue
      }
      if (ch === '>' && prev === '=') {
        prev = 'A'
        word = ''
        continue
      }
      if (ch === '{') {
        if (fn && parens.length === fn.depth) {
          braces.push(fn.expression)
          fn = undefined
        } else braces.push(prev !== '' && prev !== 'A' && '(,=:[!&|?+-*%<>~^'.includes(prev) || (prev === 'a' && keyword(word) && word !== 'else' && word !== 'do'))
      }
      if (ch === '}' && !(typeof top === 'number' && top === 0)) {
        const expression = braces.pop()
        if (typeof top === 'number') stack[stack.length - 1] = top - 1
        prev = expression ? ')' : '}'
        word = ''
        continue
      }
      if (fn && parens.length === fn.depth && (ch === ':' || ch === ',' || ch === ';')) fn = undefined
      if (ch === ':' && (caseAt === parens.length + braces.length || (prev === 'a' && lead))) {
        caseAt = -1
        lead = false
        prev = ';'
        word = ''
        continue
      }
      prev = ch
      word = ''
      if (ch === '`') {
        stack.push('tpl')
        continue
      }
      if (typeof top === 'number') {
        if (ch === '{') stack[stack.length - 1] = top + 1
        else if (ch === '}') {
          stack.pop()
          prev = '"'
        }
      }
    }
  }
  const OPEN = /^\s*\/\/\s*@text\s+([A-Za-z_$][\w$]*)\s*$/
  const END = /^\s*\/\/\s*@end(?:\s+([A-Za-z_$][\w$]*))?\s*$/
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i] as string
    const inText = comment || quote !== '' || stack[stack.length - 1] === 'tpl'
    const m = inText ? null : OPEN.exec(l)
    if (!m) {
      scan(l)
      continue
    }
    const name = m[1] as string
    if (name in opened) return { script, texts: {}, error: 'the // @text ' + name + ' block on line ' + (i + 1) + ' uses a name used twice (first on line ' + opened[name] + '); give each block its own name' }
    opened[name] = i + 1
    let end = -1
    for (let j = i + 1; j < lines.length; j++) {
      const e = END.exec(lines[j] as string)
      if (e && (e[1] === undefined || e[1] === name)) {
        end = j
        break
      }
    }
    if (end < 0) return { script, texts: {}, error: 'the // @text ' + name + ' block that starts on line ' + (i + 1) + ' has no // @end line' }
    texts[name] = lines
      .slice(i + 1, end)
      .map((x) => x.replace(/^(\s*\/\/\s*)@@(?=(?:text|end)\b)/, '$1@'))
      .join('\n')
    for (let j = i; j <= end; j++) lines[j] = ''
    i = end
  }
  return { script: lines.join('\n'), texts }
}

export type Ended = { items: string[]; keys?: (string[] | undefined)[]; logs: string[]; failure?: string; kind?: string; notes?: string[] }

export const sections = (ms: number, d: Ended, split = false): string[] => {
  const parts: string[] = []
  d.items.forEach((t, i) => {
    const head = d.items.length > 1 ? `==> text ${i + 1}/${d.items.length} <==\n` : ''
    const keys = (split && d.keys?.[i]) || [t]
    keys.forEach((k, j) => parts.push(j === 0 ? head + k : k))
  })
  if (d.logs.length) parts.push(`<console_output>\n${d.logs.join('\n')}\n</console_output>`)
  parts.push(...(d.notes ?? []))
  if (d.failure)
    parts.push(
      d.kind === 'aborted' || d.kind === 'cancelled' ? `Script stopped after ${ms}ms [${d.kind}]: ${d.failure}` : `Script failed after ${ms}ms [${d.kind ?? 'script'}]: ${d.failure}`,
    )
  return parts.length ? parts : ['(no output)']
}

export const format = (ms: number, d: Ended) => sections(ms, d).join('\n')

const ERRORISH = /\b(?:error|errors|fatal|failed|failure|exception|traceback|panic|denied|refused)\b/i
const countLines = (s: string) => {
  let n = 0
  for (let i = s.indexOf('\n'); i >= 0; i = s.indexOf('\n', i + 1)) n++
  return n
}

const utf8 = (s: string) => {
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c < 0xdc00 && i + 1 < s.length && isLow(s.charCodeAt(i + 1))) {
      n += 4
      i++
    } else n += 3
  }
  return n
}
const LONG_LINE = 50_000
const longest = (s: string) => {
  let most = 0
  for (let at = 0; at < s.length; ) {
    const nl = s.indexOf('\n', at)
    const end = nl < 0 ? s.length : nl
    most = Math.max(most, end - at)
    at = end + 1
  }
  return most
}
const shellWord = (s: string) => `'${s.split("'").join("'\\''")}'`

export const cutPart = (s: string, budget: number, firstLine: number, file?: string, firstByte = 0) => {
  const noteRoom = 70 + (file ? file.length + 80 : 0)
  const keptRoom = Math.min(1200, Math.floor(budget / 4))
  const room = Math.max(0, budget - noteRoom - keptRoom)
  const half = Math.floor(room / 2)
  let a = half
  const ha = s.lastIndexOf('\n', half - 1) + 1
  if (half > 0 && ha > half / 2) a = ha
  let b = s.length - half
  const tb = s.indexOf('\n', b - 1) + 1
  if (half > 0 && tb > 0 && tb - b < half / 2) b = tb
  a = safeEnd(s, a)
  b = safeStart(s, b)
  if (b <= a) return s
  const gone = s.slice(a, b)
  const from = firstLine + countLines(s.slice(0, a))
  const to = Math.max(from, firstLine + countLines(s.slice(0, b)) - (s[b - 1] === '\n' ? 1 : 0))
  const byRange = file !== undefined && longest(gone) > LONG_LINE
  const range = byRange ? `tail -c +${firstByte + utf8(s.slice(0, a)) + 1} ${shellWord(file)} | head -c ${utf8(gone)}` : ''
  const back = !file ? '' : byRange ? `; read them back with sh(${JSON.stringify(range)})` : `; read them back with tools.Read({ file_path: ${JSON.stringify(file)}, offset: ${from}, limit: ${to - from + 1} })`
  const errs: string[] = []
  let used = 0
  for (const l of gone.split('\n')) {
    if (errs.length >= 8 || !ERRORISH.test(l)) continue
    const line = l.length > 200 ? `${l.slice(0, 200)}…` : l
    if (used + line.length + 1 > keptRoom - 30) break
    errs.push(line)
    used += line.length + 1
  }
  const kept = errs.length ? `\n…lines kept from the cut:\n${errs.join('\n')}` : ''
  const glue = a > 0 && s[a - 1] !== '\n' ? '\n' : ''
  const full = `${s.slice(0, a)}${glue}…${gone.length} chars cut (lines ${from}-${to})${back}…${kept}${b < s.length ? `\n${s.slice(b)}` : ''}`
  if (full.length <= budget) return full
  const note = `\n…${gone.length} chars cut (lines ${from}-${to})…\n`
  const side = Math.floor((budget - note.length) / 2)
  if (side <= 0) return s.slice(0, safeEnd(s, Math.max(0, budget)))
  return s.slice(0, safeEnd(s, side)) + note + s.slice(safeStart(s, s.length - side))
}

export const fit = (all: string[], max: number, file?: string, tailCount = 0): string => {
  const full = all.join('\n')
  if (full.length <= max) return full
  const keep = Math.min(tailCount, all.length)
  const body = all.slice(0, all.length - keep)
  const bodyText = body.join('\n')
  let tail = all.slice(all.length - keep).join('\n')
  const tailLine = body.length ? countLines(bodyText) + 2 : 1
  if (tail.length > max / 2) tail = cutPart(tail, Math.floor(max / 2), tailLine, file, body.length ? utf8(bodyText) + 1 : 0)
  const room = Math.max(0, max - tail.length - (tail && body.length ? 1 : 0))
  const groups = Math.max(1, Math.min(40, Math.floor(room / 400)))
  const smallMax = Math.floor(room / (2 * groups))
  const units: { small: boolean; parts: string[] }[] = []
  for (const p of body) {
    const small = p.length <= smallMax
    const u = units[units.length - 1]
    if (u && u.small === small) u.parts.push(p)
    else units.push({ small, parts: [p] })
  }
  const length = (u: { parts: string[] }) => u.parts.reduce((n, p) => n + p.length + 1, 0)
  while (units.length > groups) {
    let best = 0
    for (let k = 1; k + 1 < units.length; k++) if (length(units[k] as never) + length(units[k + 1] as never) < length(units[best] as never) + length(units[best + 1] as never)) best = k
    units.splice(best, 2, { small: false, parts: [...(units[best] as { parts: string[] }).parts, ...(units[best + 1] as { parts: string[] }).parts] })
  }
  const spare = groups - units.length
  const bigLength = units.filter((u) => !u.small).reduce((n, u) => n + length(u), 0)
  const parts: string[] = []
  for (const u of units) {
    if (u.small) {
      parts.push(u.parts.join('\n'))
      continue
    }
    const share = 1 + (bigLength ? Math.floor((spare * length(u)) / bigLength) : 0)
    const per = Math.ceil(u.parts.length / share)
    for (let g = 0; g < u.parts.length; g += per) parts.push(u.parts.slice(g, g + per).join('\n'))
  }
  const budget = parts.map(() => 0)
  let left = Math.max(0, room - Math.max(0, parts.length - 1))
  const order = parts.map((p, i) => [p.length, i] as const).sort((x, y) => x[0] - y[0])
  order.forEach(([len, i], k) => {
    const share = Math.floor(left / (order.length - k))
    budget[i] = Math.min(len, share)
    left -= budget[i] as number
  })
  let line = 1
  let byte = 0
  let out = parts
    .map((p, i) => {
      const at = line
      const from = byte
      line += countLines(p) + 1
      byte += utf8(p) + 1
      const b = budget[i] as number
      return p.length <= b ? p : cutPart(p, b, at, file, from)
    })
    .join('\n')
  if (out.length > room) {
    const note = file ? '\n…output cut at ' + max + ' chars; all of it is in ' + file + '…' : '\n…output cut at ' + max + ' chars…'
    out = out.slice(0, safeEnd(out, Math.max(0, room - note.length))) + note
  }
  if (!tail) return out
  return body.length ? out + '\n' + tail : tail
}

// A tool's arguments as one TypeScript type, from a JSON schema.
export const tsType = (s: unknown, depth = 0): string => {
  if (!s || typeof s !== 'object' || depth > 6) return 'unknown'
  const o = s as Record<string, unknown>
  if (Array.isArray(o.enum)) return o.enum.map((v) => JSON.stringify(v)).join(' | ')
  if ('const' in o) return JSON.stringify(o.const)
  const alts = o.anyOf ?? o.oneOf
  if (Array.isArray(alts)) return alts.map((a) => tsType(a, depth + 1)).join(' | ')
  const types = Array.isArray(o.type) ? o.type : [o.type]
  if (types.includes('array')) {
    const item = tsType(o.items, depth + 1)
    return /[ |]/.test(item) ? `(${item})[]` : `${item}[]`
  }
  if (types.includes('object') || o.properties) {
    const required = new Set(Array.isArray(o.required) ? o.required : [])
    const props = Object.entries((o.properties ?? {}) as Record<string, unknown>).map(
      ([k, v]) => `${/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k)}${required.has(k) ? '' : '?'}: ${tsType(v, depth + 1)}`,
    )
    return props.length ? `{ ${props.join('; ')} }` : 'object'
  }
  const named = types.filter((t): t is string => typeof t === 'string').map((t) => (t === 'integer' ? 'number' : t))
  return named.length ? named.join(' | ') : 'unknown'
}

// One tool's input type from a `.d.ts` Claude Code generates for mods: the
// block under its key, dedented.
export const inputType = (source: string, tool: string): string | undefined => {
  const lines = source.split('\n')
  const key = tool.replace(/[.*+?^$|{}()[\]\\]/g, '\\$&')
  const head = new RegExp(`^    (?:${key}|"${key}"|'${key}'): (.*)$`)
  const at = lines.findIndex((l) => head.test(l))
  if (at < 0) return undefined
  const body = [(lines[at] as string).replace(head, '$1')]
  if (body[0]?.trim() !== '{}')
    for (const l of lines.slice(at + 1)) {
      // The next key (or its doc comment) at the same depth, or the interface's end.
      if (/^ {4}[^ }]/.test(l) || /^ {0,3}\S/.test(l)) break
      body.push(l.slice(4))
    }
  return body.join('\n').trimEnd()
}

// Bad arguments come back with advice to load the tool through ToolSearch and
// its whole JSON schema. A script needs neither: keep the engine's first lines
// and give the arguments as one TypeScript type.
export const tidy = (tool: string, message: string): { message: string; type?: string } => {
  const plain = message.replace(/^<tool_use_error>/, '').replace(/<\/tool_use_error>$/, '')
  // Only the engine's own validation error counts: a failing command's output
  // could print the same advice and plant a type.
  if (!plain.startsWith(`InputValidationError: ${tool} failed due to the following issue`)) return { message: plain }
  const at = plain.indexOf("This tool's schema was not sent to the API")
  const marker = "this tool's input schema is: "
  const from = plain.indexOf(marker, at)
  if (at < 0 || from < 0) return { message: plain }
  try {
    const type = tsType(JSON.parse(plain.slice(from + marker.length, plain.lastIndexOf('}') + 1)))
    return { message: `${plain.slice(0, at).trimEnd()}\n${tool} takes ${type}`, type }
  } catch {
    return { message: plain }
  }
}

type Picture = { kind: 'image' | 'document'; media: string; data: string }

// An image or PDF in a tool's result: the API's block, an MCP block, Read's
// image or PDF, or a page image Read extracted.
const pictureOf = (o: Record<string, unknown>): Picture | undefined => {
  const src = o.source as Record<string, unknown> | undefined
  const file = o.file as Record<string, unknown> | undefined
  if (o.type === 'image' && src?.type === 'base64' && typeof src.data === 'string')
    return { kind: 'image', media: String(src.media_type), data: src.data }
  if (o.type === 'image' && typeof o.data === 'string') return { kind: 'image', media: String(o.mimeType ?? 'image/png'), data: o.data }
  if (o.type === 'image' && typeof file?.base64 === 'string') return { kind: 'image', media: String(file.type), data: file.base64 }
  if (o.type === 'pdf' && typeof file?.base64 === 'string') return { kind: 'document', media: 'application/pdf', data: file.base64 }
  if (typeof o.base64 === 'string' && o.base64 && typeof o.mediaType === 'string') return { kind: 'image', media: o.mediaType, data: o.base64 }
  return undefined
}

// Swaps each picture in a result for a short marker and keeps it aside, so no
// base64 reaches the script; a marker in the output brings the picture back.
export const strip = (v: unknown, pictures: Picture[], markers: string[], depth = 0): unknown => {
  if (v === null || typeof v !== 'object' || depth > 8) return v
  if (Array.isArray(v)) return v.map((x) => strip(x, pictures, markers, depth + 1))
  const p = pictureOf(v as Record<string, unknown>)
  if (!p) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, strip(x, pictures, markers, depth + 1)]))
  pictures.push(p)
  const kb = Math.max(1, Math.round((p.data.length * 3) / 4 / 1024))
  const marker = `[${p.kind === 'image' ? 'image' : 'pdf'} #${pictures.length} ${p.media} ${kb}KB]`
  markers.push(marker)
  return marker
}

// The pictures whose markers made it into the output, as content blocks.
export const attach = (out: string, pictures: Picture[]) =>
  [...new Set([...out.matchAll(/\[(?:image|pdf) #(\d+) /g)].map((m) => Number(m[1])))]
    .flatMap((n) => {
      const p = pictures[n - 1]
      return p ? [{ type: p.kind, source: { type: 'base64', media_type: p.media, data: p.data } }] : []
    })
    .slice(0, MAX_PICTURES)

const ident = (name: string) => name.replace(/[^A-Za-z0-9_$]/g, '_')

// Words that also find the tools settings or mods most often put in place of a
// built-in (lean-ctx's ctx_shell for Bash, ctx_patch for Edit and Write, ...).
export const ALIKE: Record<string, string[]> = {
  bash: ['shell'],
  edit: ['patch'],
  write: ['patch'],
  grep: ['search'],
  glob: [],
  read: [],
}

// A tool name's words: mcp__lean-ctx__ctx_shell is lean, ctx, ctx, shell.
const words = (name: string) =>
  name
    .replace(/^mcp__/, '')
    .split(/[^A-Za-z0-9]+|(?<=[a-z])(?=[A-Z])/)
    .map((w) => w.toLowerCase())
    .filter(Boolean)

// Up to three tool names that share a word with `name` (or with what replaces
// it), best first. Whole words, so "ask" never finds TaskStop.
export const similar = (name: string, names: string[]): string[] => {
  const own = words(name).filter((w) => w.length > 2)
  const wanted = [...new Set(own.flatMap((w) => [w, ...(ALIKE[w] ?? [])]))]
  // ToolSearch replaces nothing; a removed built-in is most often replaced by an MCP tool.
  return names
    .filter((n) => n !== name && n !== SEARCH && n !== FULL)
    .map((n) => {
      const own = words(n)
      const has = new Set(own)
      // A name ending in the wanted word (ctx_search for Grep) beats one that only
      // holds it (hindsight_search_knowledge_pages); then the shorter name wins.
      const last = wanted.includes(own[own.length - 1] ?? '') ? 2 : 0
      return { n, size: own.length, score: wanted.filter((w) => has.has(w)).length * 2 + last + (n.startsWith('mcp__') ? 1 : 0) }
    })
    .filter((x) => x.score > 1)
    .sort((a, b) => b.score - a.score || a.size - b.size)
    .slice(0, 3)
    .map((x) => x.n)
}

type Tally = { ok: number; failed: number; open: number; cutOff?: number; arg?: string }

// What a run had called by the time it failed: those side effects stand, and
// the next run should not repeat them blind.
export const ledger = (calls: Map<string, Tally>): string =>
  [...calls]
    .map(([n, t]) => {
      const parts = [t.ok ? `${t.ok} ok` : '', t.failed ? `${t.failed} failed${t.arg ? ` (${t.arg})` : ''}` : '', t.cutOff ? `${t.cutOff} cut off by the run's end (the mod stopped reading it)` : '', t.open ? `${t.open} still running (may still finish)` : '']
      return `${n} ${parts.filter(Boolean).join(', ')}`
    })
    .slice(0, 12)
    .join('; ') + (calls.size > 12 ? `; ${calls.size - 12} more tools` : '')

const show = (v: unknown): string => {
  if (typeof v === 'string') return v
  try {
    return JSON.stringify(v, null, 2) ?? String(v)
  } catch {
    return String(v)
  }
}

type Request = { id: number; kind: 'call' | 'describe' | 'store' | 'load' | 'ask' | 'fresh' | 'cut' | 'jobs' | 'cancel'; payload: Record<string, unknown> }
type Done = { done: true; failure?: string; kind?: string; failedId?: number; alongside?: number }
const KINDS = new Set(['call', 'describe', 'store', 'load', 'ask', 'fresh', 'cut', 'jobs', 'cancel'])

// Keys `$.tool.call` reads beside a tool's arguments. `consent` would stand in
// for the user's own approval, so a script never gets to set any of them.
const RESERVED = new Set(['tool', 'tool_use_id', 'consent', 'agentId', 'requestMeta'])

const num = (v: unknown, fallback: number, min: number, max: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(Math.max(v, min), max) : fallback

let runs = 0
let sessionCwd: string | undefined
const readPaths = new Set<string>()
const deniedTools = new Map<string, { alt?: string; at: number }>()
const failedScripts = new Map<string, { first: string; at: number }>()

const READ = Symbol('read')
const readProgress = new Map<string, { next: number; version?: string }>()
const readVersions = new Map<string, string>()
const NOTICE = /^\s*<system-reminder>Warning: the file exists but (?:the contents are empty|is shorter than the provided offset \(\d+\)\. The file has \d+ lines)\.<\/system-reminder>\s*$/
const pickLimit = (limit: number, tried: Set<number>, cap: number, down: number) => {
  for (let n = Math.min(down, cap); n >= 1; n--) if (!tried.has(n)) return n
  for (let n = limit + 1; n <= Math.min(2000, cap); n++) if (!tried.has(n)) return n
  return 0
}
type Receipt = { file: string; whole: boolean; next?: number; version?: string }
type FileInfo = { startLine?: unknown; numLines?: unknown; totalLines?: unknown; truncatedByTokenCap?: unknown }
const infoOf = (result: unknown): FileInfo | undefined => {
  const f = result && typeof result === 'object' ? (result as { file?: unknown }).file : undefined
  return f && typeof f === 'object' ? (f as FileInfo) : undefined
}
const reachesEnd = (info: FileInfo | undefined) =>
  !!info && typeof info.startLine === 'number' && typeof info.numLines === 'number' && typeof info.totalLines === 'number' && info.startLine + info.numLines - 1 >= info.totalLines
const receiptOf = (file: string, offset: unknown, limit: unknown, text: string, result: unknown, version: string | undefined, chains: ({ next: number; version?: string } | undefined)[]): Receipt | undefined => {
  if (version === undefined) return undefined
  if (isStub(text)) return undefined
  const info = infoOf(result)
  if (info?.truncatedByTokenCap === true) return undefined
  const rows = text.split('\n').filter((l) => /^\s*\d+\t/.test(l)).length
  if (!rows && !NOTICE.test(text)) return undefined
  const from = typeof offset === 'number' ? offset : 1
  if (from !== 1 && !chains.some((c) => c?.next === from && c.version === version)) return undefined
  if (!rows) return { file, whole: true, version }
  if (!info || rows !== info.numLines) return undefined
  return reachesEnd(info) ? { file, whole: true, version } : { file, whole: false, next: from + rows, version }
}
const PERSISTED = /^(\s*(?:<tool_use_error>)?(?:Exit code \d+\n)?)<persisted-output>\n(?:[^\n]*\n){0,5}?Output too large \([^)\n]*\)\. Full output saved to: ([^\n]+)\n\nPreview \([^)\n]*\):\n([\s\S]*?)\n?<\/persisted-output>(\s*(?:<\/tool_use_error>)?\s*)$/
const isLow = (c: number) => c >= 0xdc00 && c < 0xe000
const isHigh = (c: number) => c >= 0xd800 && c < 0xdc00
const safeEnd = (s: string, i: number) => (i > 0 && i < s.length && isLow(s.charCodeAt(i)) && isHigh(s.charCodeAt(i - 1)) ? i - 1 : i)
const safeStart = (s: string, i: number) => (i > 0 && i < s.length && isLow(s.charCodeAt(i)) && isHigh(s.charCodeAt(i - 1)) ? i + 1 : i)
export const normal = (p: string) => {
  if (!p.startsWith('/')) return p
  const out: string[] = []
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') out.pop()
    else out.push(seg)
  }
  return '/' + out.join('/')
}
const SHELL_RE = /^Bash$|(?:^|_)shell$/i
const HOOK_RE = /^\s*(?:<tool_use_error>)?\s*PreToolUse:\S+ hook (?:error|denied)/i
const WHOLE_RE = /^\s*(?:<tool_use_error>)?\s*PreToolUse:(\S+) hook error: \[DENIED\] [A-Za-z ]{1,60} blocked\. Use: ([A-Za-z0-9_-]+)\(/
const LEAN_WITHHELD = /^\s*\[lean-ctx[^\]\n]*withheld/i
const GATEWAY_WITHHELD = /^\s*(?:\[(?:POLICY BLOCKED\][^\n]*withheld|withheld by the context gateway\])|(?:stored output (?:is )?withheld by the context gateway|archive withheld by current policy|Tool may have completed; output withheld by policy)\.?\s*$)/i
const ENGINE_CUT = /\n\n\.\.\. \[\d+ characters truncated\] \.\.\.\n\n/
const LEAN_ARCHIVED = /\[Original available via ctx_expand id=[A-Za-z0-9_-]+\]\s*$/
const SAVED = /^Error: result \(([\d,]+) characters across [\d,]+ lines\) exceeds maximum allowed tokens\. Output has been saved to (\/[^\n]+?\.txt)\.\nFormat: [^\n]+\n/
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const shellQuote = (s: string) => "'" + s.split("'").join("'\\''") + "'"
export const bytesOf = (s: string): number[] | undefined => {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s) || s.length % 4 !== 0) return undefined
  const out: number[] = []
  let acc = 0
  let bits = 0
  for (const ch of s.replace(/=+$/, '')) {
    acc = ((acc << 6) | B64.indexOf(ch)) & 0xffffff
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out.push((acc >> bits) & 255)
    }
  }
  return out
}
export const fromUtf8 = (bytes: number[]): string | undefined => {
  const hex: string[] = []
  for (const b of bytes) hex.push('%' + b.toString(16).padStart(2, '0'))
  try {
    return decodeURIComponent(hex.join(''))
  } catch {
    return undefined
  }
}
const isWithheld = (t: string, tool?: string) => LEAN_WITHHELD.test(t) || (t.length < 600 && (tool === undefined || /lean[-_]ctx/.test(tool)) && GATEWAY_WITHHELD.test(t))
const jobOf = (t: string): string | undefined => {
  try {
    const j = JSON.parse(t) as { jobId?: unknown; state?: unknown; summary?: unknown }
    return typeof j?.jobId === 'string' && /^shell_[0-9a-f]{16}$/.test(j.jobId) && j.state === 'running' && typeof j.summary === 'string' ? j.jobId : undefined
  } catch {
    return undefined
  }
}
export const isStub = (t: string, tool?: string) =>
  /^\s*\[(?:Firewalled \S+ output|lean-ctx[^\]\n]*withheld|untrusted input: tool_output overflow)/.test(t) ||
  isWithheld(t, tool) ||
  (countLines(t) <= 2 && /^\s*1\t\S[^\n]* \[unchanged \d+L · lean-ctx read-dedup\]/.test(t))
const short = (n: string) => n.split('__').pop() ?? n
const escape = (s: string) => s.replace(/[.*+?^$|{}()[\]\\]/g, '\\$&')

export const firstArg = (args: Record<string, unknown>): string | undefined => {
  const keys = ['command', 'file_path', 'path', 'query', 'url', 'pattern', 'skill', 'prompt']
  const key = keys.find((k) => typeof args[k] === 'string')
  const v = key ? (args[key] as string) : Object.values(args).find((x) => typeof x === 'string')
  if (typeof v !== 'string') return undefined
  if (v.length <= 80) return JSON.stringify(v)
  return JSON.stringify(key === 'file_path' || key === 'path' ? `…${v.slice(-79)}` : `${v.slice(0, 79)}…`)
}

export const absolute = (p: string, cwd?: string, home?: string) => {
  if (p.startsWith('/')) return normal(p)
  if ((p === '~' || p.startsWith('~/')) && home) return normal(home + p.slice(1))
  return cwd ? normal(`${cwd.replace(/\/$/, '')}/${p.replace(/^\.\//, '')}`) : p
}

export const exitOf = (raw: string, worked: boolean, tool = 'Bash'): { code?: number; out: string } => {
  if (worked) return { code: 0, out: raw }
  const text = raw.replace(/^\s*<tool_use_error>/, '').replace(/<\/tool_use_error>\s*$/, '')
  for (const re of tool === 'Bash' ? [/^Exit code (\d+)(?:\n|$)/] : [/\n?\[exit:(\d+)[^\]\n]*\]\s*$/]) {
    const m = re.exec(text)
    if (m) return { code: Number(m[1]), out: text.slice(0, m.index) + text.slice(m.index + m[0].length) }
  }
  return worked ? { code: 0, out: text } : { out: text }
}

export const toolDefaults = (raw: string | undefined): Record<string, Record<string, unknown>> => {
  if (!raw) return {}
  try {
    const v: unknown = JSON.parse(raw)
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
    const out: Record<string, Record<string, unknown>> = Object.create(null)
    for (const [t, d] of Object.entries(v as Record<string, unknown>))
      if (d && typeof d === 'object' && !Array.isArray(d)) out[t] = Object.fromEntries(Object.entries(d as Record<string, unknown>).filter(([k]) => !RESERVED.has(k)))
    return out
  } catch {
    return {}
  }
}

const distance = (a: string, b: string) => {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0] as number
    row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const here = row[j] as number
      row[j] = Math.min(here + 1, (row[j - 1] as number) + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = here
    }
  }
  return row[b.length] as number
}

export const nearNames = (want: string, have: string[]): string[] => {
  const w = want.toLowerCase()
  const stem = (s: string) => s.replace(/\.[^.]*$/, '')
  return have
    .map((n) => ({ n, d: distance(n.toLowerCase(), w) }))
    .filter(({ n, d }) => d <= Math.max(2, Math.floor(w.length / 4)) || (stem(w).length >= 3 && stem(n.toLowerCase()) === stem(w)))
    .sort((x, y) => x.d - y.d)
    .slice(0, 3)
    .map((x) => x.n)
}

// Tool input types: the generated `.d.ts` files, read once, then the schemas
// that calls with bad arguments brought back.
let typeSources: string[] | undefined
const learned = new Map<string, string>()

// The Skill tool's result is only "Launching skill: x"; the engine sends the
// skill's text to the model as a separate message, which a script never sees.
// The text expanded at `skill.prompt` is kept here, numbered, and handed to
// every Skill call that started before it, so calls running at once all get it.
const skillTexts = new Map<string, { text: string; seq: number }>()
let skillSeq = 0
const skillKey = (name: string) => name.replace(/^\//, '').split(':').pop() ?? name
const skillTurns = new Map<string, Promise<void>>()

// Waits for earlier calls to the same skill; resolves to the end of this call's
// turn, or to undefined when one of them has not settled by `limit`. Two calls
// never share a turn, since each must get the text expanded for its own args.
export const skillTurn = async (key: string, limit: Promise<unknown>): Promise<(() => void) | undefined> => {
  const before = skillTurns.get(key) ?? Promise.resolve()
  let end = () => {}
  const mine = new Promise<void>((r) => (end = r))
  // Chained on `before` even past a time-out, so no later call overlaps one still running.
  const turn = before.then(() => mine)
  skillTurns.set(key, turn)
  const ready = await Promise.race([before.then(() => true), limit.then(() => false)])
  if (!ready) {
    end()
    return undefined
  }
  return () => {
    end()
    if (skillTurns.get(key) === turn) skillTurns.delete(key)
  }
}

type Dollar = Parameters<Hook<'tool.call'>>[0]
type RunResult = string | { type: string; text?: string }[]
type Job = {
  id: string
  agent: string
  turnId?: string
  turnSeq: number
  started: number
  deadline: number
  pid?: number
  exited: boolean
  cancelledBy?: string
  stopKind?: 'cancelled' | 'aborted'
  stopped: boolean
  settled: boolean
  text: string
  blocks: { type: string }[]
  ms: number
  delivered: boolean
  noticed: boolean
  quiet: boolean
  reads: Map<string, string | undefined>
  readAt: Map<string, number>
  progress: Map<string, { next: number; version?: string }>
  progressAt: Map<string, number>
  gen: number
  spill?: string
  pidKnown: Promise<void>
  onPid: () => void
  expiry?: { cancel: () => unknown }
  done: Promise<void>
}
const MAIN = 'main'
const jobsById = new Map<string, Job>()
const deliveredIds = new Map<string, string>()
const handedSpills = new Map<string, number>()
const ownSpills = new Set<string>()
const progressAt = new Map<string, number>()
const versionAt = new Map<string, number>()
let readClock = 0
let jobSeq = 0
let mainTurn = false
let mainTurnId: string | undefined
let turnSeq = 0
let sessionGen = 0
let waking = false
let wakeAgain = false
const fileLocks = new Map<string, Promise<void>>()
const lockFile = async (path: string): Promise<() => void> => {
  const before = fileLocks.get(path) ?? Promise.resolve()
  let release: () => void = () => undefined
  const mine = new Promise<void>((r) => (release = r))
  const chained = before.then(() => mine)
  fileLocks.set(path, chained)
  await before
  return () => {
    release()
    if (fileLocks.get(path) === chained) fileLocks.delete(path)
  }
}
const writeTargets = (m: Request, cwd: string | undefined, home: string, defaults: Record<string, Record<string, unknown>>): string[] => {
  if (m.kind !== 'call') return []
  const tool = String(m.payload.tool)
  const args = { ...(defaults[tool] ?? {}), ...((m.payload.args ?? {}) as Record<string, unknown>) }
  const ops = Array.isArray(args.ops) ? (args.ops as Record<string, unknown>[]) : []
  const raws = /^(?:Write|Edit|MultiEdit)$/.test(tool)
    ? [args.file_path]
    : tool === 'NotebookEdit'
      ? [args.notebook_path]
      : /^mcp__lean[-_]ctx__(?:ctx_)?patch$/.test(tool)
        ? [args.path, ...ops.map((o) => o?.path ?? args.path)]
        : []
  const paths = raws.filter((r): r is string => typeof r === 'string' && !!r.trim()).map((r) => normal(absolute(r.trim(), cwd, home)))
  return [...new Set(paths)].sort()
}
const expire = (j: Job) => {
  j.cancelledBy = 'its start deadline'
  j.stopKind = 'cancelled'
  j.stopped = true
  settle(j, format(Date.now() - j.started, { items: [], logs: [], kind: 'runner', failure: 'the run never started its runner within its time; none of its tool calls ran, and it will not start now.' }))
  j.exited = true
  j.onPid()
}
export const openRunIds = () => [...jobsById.values()].filter((j) => !j.settled).map((j) => j.id)
const agentOf = (id: unknown) => (typeof id === 'string' && id ? `agent:${id}` : MAIN)
const startJob = (agent: string, timeout: number): Job => {
  const job: Job = { id: `r${++jobSeq}`, agent, turnId: agent === MAIN ? mainTurnId : undefined, turnSeq, started: Date.now(), deadline: Date.now() + timeout + 10_000, exited: false, stopped: false, settled: false, text: '', blocks: [], ms: 0, delivered: false, noticed: false, quiet: false, reads: new Map(), readAt: new Map(), progress: new Map(), progressAt: new Map(), gen: sessionGen, pidKnown: Promise.resolve(), onPid: () => undefined, done: Promise.resolve() }
  job.pidKnown = new Promise<void>((r) => (job.onPid = r))
  jobsById.set(job.id, job)
  return job
}
const settle = (job: Job, result: RunResult) => {
  if (job.settled) return
  job.expiry?.cancel()
  const parts = typeof result === 'string' ? [{ type: 'text', text: result }] : result
  job.text = parts.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n')
  job.blocks = parts.filter((b) => b.type !== 'text')
  job.ms = Date.now() - job.started
  job.settled = true
}
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`
const agentJobs = (agent: string) => [...jobsById.values()].filter((j) => j.agent === agent)
const openJobs = (agent: string) => agentJobs(agent).filter((j) => !j.settled)
const readyJobs = (agent: string) => agentJobs(agent).filter((j) => j.settled && !j.delivered)
const running = (asker: Job) =>
  openJobs(asker.agent)
    .filter((j) => j !== asker)
    .map((j) => ({ id: j.id, state: j.exited ? 'finishing' : 'running', seconds: Math.round((Date.now() - j.started) / 1000) }))
const LATER_ROOM = 300
const promoteReads = (j: Job) => {
  if (j.stopped || j.gen !== sessionGen) return
  for (const [p, v] of j.reads) {
    const at = j.readAt.get(p) ?? 0
    if (at < (versionAt.get(p) ?? 0)) continue
    readPaths.delete(p)
    readPaths.add(p)
    versionAt.delete(p)
    versionAt.set(p, at)
    readVersions.delete(p)
    if (v !== undefined) readVersions.set(p, v)
  }
  for (const [p, chain] of j.progress) {
    const at = j.progressAt.get(p) ?? 0
    if (at < (progressAt.get(p) ?? 0)) continue
    progressAt.delete(p)
    progressAt.set(p, at)
    readProgress.delete(p)
    readProgress.set(p, chain)
  }
  const readStamp = (k: string) => versionAt.get(k) ?? 0
  const pageStamp = (k: string) => progressAt.get(k) ?? 0
  dropOldest(readPaths, 2000, readStamp, (k) => {
    readPaths.delete(k)
    readVersions.delete(k)
  })
  dropOldest(readVersions.keys(), 2000, readStamp, (k) => readVersions.delete(k), readVersions.size)
  const forgottenReads = [...versionAt.keys()].filter((k) => !readPaths.has(k) && !readVersions.has(k))
  dropOldest(forgottenReads, 2000, readStamp, (k) => versionAt.delete(k), forgottenReads.length)
  dropOldest(readProgress.keys(), 200, pageStamp, (k) => readProgress.delete(k), readProgress.size)
  const forgottenPages = [...progressAt.keys()].filter((k) => !readProgress.has(k))
  dropOldest(forgottenPages, 2000, pageStamp, (k) => progressAt.delete(k), forgottenPages.length)
}
const dropOldest = (keys: Iterable<string>, cap: number, stampOf: (k: string) => number, drop: (k: string) => void, size = (keys as Set<string>).size) => {
  if (size <= cap) return
  for (const k of [...keys].sort((a, b) => stampOf(a) - stampOf(b)).slice(0, size - cap)) drop(k)
}
const deliver = (agent: string, room: number): { text: string; blocks: { type: string }[] } => {
  const texts: string[] = []
  const blocks: { type: string }[] = []
  const later: string[] = []
  let used = 0
  for (const j of readyJobs(agent)) {
    const attached = j.blocks.length ? `, ${j.blocks.length} attachment${j.blocks.length === 1 ? '' : 's'}` : ''
    const section = `[${j.id} ${j.stopped ? 'stopped' : 'finished'} after ${seconds(j.ms)}${attached}]\n${j.text}`
    if (later.length || (texts.length && (used + section.length > room || blocks.length + j.blocks.length > MAX_PICTURES))) {
      later.push(j.id)
      j.noticed = false
      continue
    }
    texts.push(section)
    used += section.length + 2
    blocks.push(...j.blocks)
    j.delivered = true
    promoteReads(j)
    jobsById.delete(j.id)
    if (j.spill) handedSpills.set(j.spill, Date.now())
    while (handedSpills.size > 500) handedSpills.delete(handedSpills.keys().next().value as string)
    deliveredIds.set(j.id, j.agent)
    if (deliveredIds.size > 500) deliveredIds.delete(deliveredIds.keys().next().value as string)
  }
  if (later.length) texts.push(`${later.slice(0, NAMED).join(', ')}${later.length > NAMED ? ` and ${later.length - NAMED} more` : ''} finished too; ${later.length === 1 ? 'its' : 'their'} output comes with the reply to your next run (an empty script fetches it).`)
  return { text: texts.join('\n\n'), blocks }
}
const NAMED = 9
const stillRunning = (agent: string, except?: Job) => {
  const others = openJobs(agent).filter((j) => j !== except)
  const more = others.length > NAMED ? ` and ${others.length - NAMED} more` : ''
  return others.length ? ` Still running: ${others.slice(0, NAMED).map((j) => `${j.id} (${seconds(Date.now() - j.started)})`).join(', ')}${more}.` : ''
}
const withBlocks = (text: string, blocks: { type: string }[]): RunResult => (blocks.length ? [{ type: 'text', text }, ...blocks] : text)
const startedReply = (job: Job): RunResult => {
  const head = `Started ${job.id} in the background.${stillRunning(job.agent, job)}`
  const finished = deliver(job.agent, DEFAULT_MAX_CHARS - head.length - LATER_ROOM)
  return withBlocks(`${head}${finished.text ? `\n\n${finished.text}` : ''}`, finished.blocks)
}
const collectReply = (agent: string): RunResult => {
  const still = stillRunning(agent).trim()
  const finished = deliver(agent, DEFAULT_MAX_CHARS - still.length - LATER_ROOM - 200)
  const advice = still ? ` ${still} If you need their output before you can go on, end your turn: a notice comes when they finish, so do not call again to check.` : ''
  return withBlocks(finished.text ? `${finished.text}${still ? `\n\n${still}` : ''}` : `No run has finished output waiting.${advice}`, finished.blocks)
}
const notice = (jobs: Job[]) =>
  `Background run${jobs.length === 1 ? '' : 's'} ${jobs.map((j) => j.id).join(', ')} finished. Call ${FULL} with an empty script to read the output.`
const wake = async ($: Dollar) => {
  if (waking) {
    wakeAgain = true
    return
  }
  waking = true
  try {
    const surfaces: unknown = await $.session.surfaces().catch(() => [])
    if (!Array.isArray(surfaces) || !surfaces.length) return
    for (;;) {
      wakeAgain = false
      if (mainTurn) return
      const ready = readyJobs(MAIN).filter((j) => !j.noticed && !j.quiet)
      if (!ready.length) return
      for (const j of ready) j.noticed = true
      const sent = await $.prompt.submit({ text: notice(ready) }).then(() => true, () => false)
      if (!sent) {
        for (const j of ready) j.noticed = false
        if (!wakeAgain) return
      }
    }
  } finally {
    waking = false
  }
}
const clockNow = async ($: Dollar): Promise<number> => {
  const fallback: { handle?: { cancel: () => unknown } } = {}
  try {
    const now = await Promise.race([$.clock.now(), new Promise<undefined>((r) => (fallback.handle = $.clock.after(1000, () => r(undefined))))])
    return typeof now === 'number' ? now : Date.now()
  } catch {
    return Date.now()
  } finally {
    fallback.handle?.cancel()
  }
}
const expireLater = ($: Dollar, job: Job) => {
  job.expiry = $.clock.after(Math.max(0, job.deadline - Date.now()), () => {
    if (job.settled || job.pid || job.exited || job.cancelledBy) return
    if (Date.now() < job.deadline) return expireLater($, job)
    expire(job)
    if (job.agent === MAIN) void wake($)
  })
}
const stopJobs = async ($: Dollar, jobs: Job[], by: string, kind: 'cancelled' | 'aborted') => {
  const stopping = jobs.filter((j) => !j.settled && !j.exited && !j.cancelledBy)
  for (const j of stopping) {
    j.cancelledBy = by
    j.stopKind = kind
    if (j.pid) continue
    j.stopped = true
    j.exited = true
    j.onPid()
    const why = kind === 'aborted' ? 'stopped because its turn was interrupted before its runner started' : `stopped by cancel() from ${by} before its runner started`
    settle(j, format(Date.now() - j.started, { items: [], logs: [], kind, failure: `${why}; none of its tool calls ran.` }))
  }
  if (stopping.some((j) => j.settled && j.agent === MAIN && !j.quiet)) void wake($)
  const pids = stopping.map((j) => j.pid).filter((p): p is number => typeof p === 'number')
  await Promise.all(pids.map((p) => $.process.run(['kill', '-9', String(p)]).catch(() => undefined)))
  return stopping.length
}
const RUNNERS_GONE = 'S=$1; N=$2; shift 2; trap \'rm -f "$S"\' EXIT; for i in $(seq "$N"); do if [ -e "$S" ]; then rm -f "$S"; exit 0; fi; if [ "$#" -gt 0 ]; then alive=0; for p in "$@"; do kill -0 "$p" 2>/dev/null && alive=1; done; if [ "$alive" = 0 ]; then exit 0; fi; fi; sleep 0.2; done'
const holdTurn = async ($: Dollar, agent: string, signal: AbortSignal | undefined): Promise<Job[]> => {
  const aborted = new Promise<void>((r) => signal?.addEventListener('abort', () => r(), { once: true }))
  const home = (await $.env.get('HOME')) || '/tmp'
  let failures = 0
  for (let round = 0; ; round++) {
    for (const j of openJobs(agent))
      if (!j.pid && !j.exited && !j.cancelledBy && Date.now() > j.deadline) expire(j)
    const open = openJobs(agent)
    if (!open.length || signal?.aborted || failures >= 3) break
    const pids = open.map((j) => j.pid).filter((p): p is number => typeof p === 'number')
    const waitingForPid = open.filter((j) => !j.pid && !j.exited)
    const stopFile = `${home}/.claude/codemode/runs/hold-${Date.now().toString(36)}-${round}-${Math.random().toString(36).slice(2, 8)}`
    const untilDeadline = waitingForPid.length ? Math.min(...waitingForPid.map((j) => j.deadline)) - Date.now() : 5_000
    const ticks = Math.max(1, Math.min(25, Math.ceil(untilDeadline / 200)))
    const pause = $.process.run(['bash', '-c', RUNNERS_GONE, 'runners', stopFile, String(ticks), ...pids.map(String)], { timeoutMs: 30_000 }).then((r) => r.exitCode === 0, () => false)
    const settled = Promise.all(open.map((j) => j.done)).then(() => 'settled' as const)
    const started = waitingForPid.length ? Promise.race(waitingForPid.map((j) => j.pidKnown)).then(() => 'started' as const) : new Promise<never>(() => undefined)
    const first = await Promise.race([settled, started, pause.then((ok) => (ok ? ('paused' as const) : ('failed' as const))), aborted.then(() => 'aborted' as const)])
    failures = first === 'failed' ? failures + 1 : 0
    if (first === 'paused' || first === 'failed') continue
    await $.fs.write(stopFile, '').catch(() => undefined)
    await pause
    await $.process.run(['rm', '-f', stopFile]).catch(() => undefined)
  }
  if (signal?.aborted) return []
  return readyJobs(agent).filter((j) => !j.noticed && !j.quiet)
}
const withHeld = (r: unknown, held: string) => {
  if (!held) return r
  const base = r && typeof r === 'object' ? (r as { block?: unknown }) : {}
  return { ...base, block: typeof base.block === 'string' && base.block ? `${base.block}\n\n${held}` : held }
}
const execute = async ($: Dollar, job: Job, raw: string, script: string, texts: Record<string, string>, timeout: number, maxChars: number): Promise<{ result: RunResult }> => {
  const pagesStarted = new Map<string, { version?: string; real?: string; next?: number }>()
  const listing = (await $.tool.list()).filter((t) => t.name !== FULL && t.name !== AGENTS_TOOL)
  const all = listing.map((t) => ({ name: t.name, description: t.description }))
  const isMcp = new Set(listing.filter((t) => (t as { mcp?: boolean }).mcp ?? t.name.startsWith('mcp__')).map((t) => t.name))
  // Every tool call this run made, so a failure can say what already ran.
  const calls = new Map<string, Tally>()
  const open = new Map<number, { tool: string; arg?: string; at: number }>()
  const stubs = new Set<string>()
  let deduped = false
  let persisted = false
  const withheld = new Set<string>()
  const cut = new Set<string>()
  const savedAway = new Set<string>()
  const defaults = toolDefaults(await $.env.get('CODEMODE_TOOL_DEFAULTS'))
  const cwd = sessionCwd ?? (await $.env.get('PWD')) ?? undefined
  // Stored types belong to one engine version: an upgrade can change a schema.
  // No version known: nothing is stored or read, rather than a key every version shares.
  let version: Promise<string> | undefined
  const typeKey = async (tool: string): Promise<string | undefined> => {
    version ??= Promise.resolve()
      .then(() => $.session.version())
      .then((v) => (typeof v?.version === 'string' ? v.version : ''), () => '')
    const v = await version
    return v ? `type:${v}:${tool}` : undefined
  }
  const home = (await $.env.get('HOME')) || '/tmp'
  const configDir = normal((await $.env.get('CLAUDE_CONFIG_DIR')) || `${home}/.claude`)
  // A host whose own node is older than 25 points this at a newer one.
  const node = (await $.env.get('CODEMODE_NODE')) || 'node'
  const root = `${home}/.claude/codemode/runs`
  const dir = `${root}/${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}-${++runs}`

  const lockedReals = new WeakMap<Request, Set<string>>()
  const climbedFrom = new WeakMap<Request, Map<string, [string, boolean][]>>()
  const movedSinceLocked = async (m: Request, path: string, real: string) => {
    if (!(lockedReals.get(m)?.has(real) ?? true)) return true
    const spellings = climbedFrom.get(m)?.get(path) ?? []
    for (const [given, relative] of spellings) {
      const now = await onDisk(given, relative)
      if (now === undefined || (await realOf(now)) !== real) return true
    }
    return (await realOf(path)) !== real
  }

  const versionOf = (path: string): Promise<string | undefined> =>
    $.fs.stat(path, { resolve: true }).then(
      (s) => (typeof s?.mtimeMs === 'number' ? `${s.mtimeMs}:${s.size}` : undefined),
      () => undefined,
    )

  const handle = async (m: Request): Promise<Record<string, unknown>> => {
    const p = m.payload
    if (late()) return refusal('request')
    if (m.kind === 'store') {
      const key = `script:${String(p.key)}`
      if (p.value === undefined) await $.store.delete(key)
      else await $.store.set(key, p.value as never)
      return { ok: true }
    }
    if (m.kind === 'fresh') {
      const asked = normal(String(p.path))
      const path = await realOf(asked)
      const read = job.reads.has(path) || readPaths.has(path)
      const was = job.reads.has(path) ? job.reads.get(path) : readPaths.has(path) ? readVersions.get(path) : undefined
      const now = was === undefined ? undefined : await versionOf(path)
      return { ok: true, read, fresh: was !== undefined && now !== undefined && now === was, version: was, real: path }
    }
    if (m.kind === 'load') return { ok: true, value: await $.store.get(`script:${String(p.key)}`) }
    if (m.kind === 'jobs') return { ok: true, value: running(job) }
    if (m.kind === 'cancel') {
      const target = jobsById.get(String(p.id))
      if (!target && deliveredIds.get(String(p.id)) === job.agent) return { ok: true, value: false }
      if (!target || target.agent !== job.agent) return { ok: false, error: `there is no run ${String(p.id)} here; jobs() lists the runs still going` }
      if (target === job) return { ok: false, error: 'a run cannot cancel itself; exit() ends it' }
      if (target.settled || target.exited || target.cancelledBy) return { ok: true, value: false }
      return { ok: true, value: (await stopJobs($, [target], job.id, 'cancelled')) > 0 }
    }
    if (m.kind === 'cut') {
      if (typeof p.tool === 'string' && SHELL_RE.test(p.tool)) cut.add(p.tool)
      return { ok: true }
    }
    if (m.kind === 'describe') {
      const t = all.find((x) => x.name === p.tool)
      if (!t) {
        const near = similar(String(p.tool), all.map((x) => x.name))
        return { ok: true, value: { name: String(p.tool), description: '', input: `not in this session${near.length ? `; similar: ${near.join(', ')}` : ''}` } }
      }
      if (typeSources === undefined) {
        const found: string[] = []
        for (const f of ['claude-code-tools', 'claude-code-mcp']) {
          const text = await $.fs.read(`${$.plugin.root}/.claude-plugin/types/${f}/index.d.ts`).catch(() => '')
          if (typeof text === 'string' && text) found.push(text.split('interface BuiltinToolResults')[0] ?? text)
        }
        typeSources = found
      }
      // A type this process just learned beats a generated file, which beats one stored earlier.
      let input = learned.get(t.name) ?? typeSources.map((s) => inputType(s, t.name)).find(Boolean)
      if (input === undefined && !isMcp.has(t.name)) {
        const k = await typeKey(t.name)
        const kept = k ? await $.store.get(k).catch(() => undefined) : undefined
        if (typeof kept === 'string') input = kept
      }
      // Only a built-in's bad-arguments error carries its type; an MCP server's does not.
      const unknown = isMcp.has(t.name)
        ? `not known here; call ToolSearch "select:${t.name}" directly to load its schema`
        : `not known here; a call with wrong arguments answers with its type (never probe a tool that changes things), or call ToolSearch "select:${t.name}" directly`
      return { ok: true, value: { ...t, input: input ?? unknown } }
    }
    if (m.kind === 'ask') {
      const effort = ['low', 'medium', 'high', 'xhigh', 'max'].includes(String(p.effort)) ? (p.effort as 'low') : undefined
      const r = await $.model.complete({
        model: typeof p.model === 'string' && p.model ? p.model : 'haiku',
        prompt: String(p.prompt ?? ''),
        ...(typeof p.system === 'string' ? { system: p.system } : {}),
        maxTokens: Math.floor(num(p.maxTokens, 1024, 1, 64_000)),
        ...(effort ? { effort } : {}),
        timeoutMs: timeout,
      })
      if (r.isAnswered) return { ok: true, text: r.text }
      return { ok: false, error: r.reason === 'api-error' ? `api-error ${r.status ?? ''} ${r.error}` : r.reason }
    }
    const tool = String(p.tool)
    if (tool === FULL) return { ok: false, error: 'A script cannot run another script.' }
    // Agents a Workflow starts inside this call would skip codemode's hooks.
    if (tool === 'Workflow') return { ok: false, error: 'Workflow cannot run from a codemode script.' }
    const given = Object.fromEntries(
      Object.entries((p.args as Record<string, unknown> | null) ?? {}).filter(([k]) => !RESERVED.has(k)),
    )
    const args: Record<string, unknown> = { ...(defaults[tool] ?? {}), ...given }
    if (p.foreground === true) for (const k of Object.keys(args)) if (/background/i.test(k)) delete args[k]
    const fill = p.fill && typeof p.fill === 'object' && /^mcp__lean[-_]ctx__(?:ctx_)?shell$/.test(tool) ? (p.fill as Record<string, unknown>) : undefined
    if (fill && typeof fill.raw === 'boolean' && !('raw' in args)) args.raw = fill.raw
    if (fill && typeof fill.timeout_ms === 'number' && Number.isFinite(fill.timeout_ms) && !('timeout_ms' in args)) args.timeout_ms = fill.timeout_ms
    if ((tool === 'Write' || tool === 'Edit') && args.file_path !== undefined) {
      const given = String(args.file_path).trim()
      const expanded = given === '~' || given.startsWith('~/') ? home + given.slice(1) : given
      if (!expanded.startsWith('/')) return { ok: false, error: `${tool} takes an absolute path from a script: ${given} is relative, and a shell cd can move where it lands` }
      const path = normal(expanded)
      args.file_path = path
      const key = await realOf(path)
      const exists = await $.fs.exists(key).catch(() => true)
      if (!readPaths.has(key) && !job.reads.has(key) && exists) return { ok: false, error: `File has not been read yet. Read it first before writing to it: ${path}` }
      if (exists) {
        const was = job.reads.has(key) ? job.reads.get(key) : readVersions.get(key)
        const now = await versionOf(key)
        if (was === undefined || now === undefined || now !== was || (await movedSinceLocked(m, path, key)))
          return { ok: false, error: `File has been modified since read, either by the user or by a linter. Read it again before attempting to write it: ${path}` }
        args.file_path = key
      } else {
        if (await movedSinceLocked(m, path, key)) return { ok: false, error: `${path} now names another file than the one this write waited to lock, so nothing was created; write it again` }
        args.file_path = key
      }
    }
    if (typeof p.expectedVersion === 'string' && /^mcp__lean[-_]ctx__(?:ctx_)?patch$/.test(tool) && typeof args.path === 'string') {
      const path = normal(absolute(args.path.trim(), cwd, home))
      const real = typeof p.expectedReal === 'string' ? p.expectedReal : await realOf(path)
      if (!job.reads.has(real) && !readPaths.has(real)) return { ok: false, error: `File has not been read yet. Read it first before writing to it: ${path}` }
      const recorded = job.reads.has(real) ? job.reads.get(real) : readVersions.get(real)
      if (recorded !== p.expectedVersion || (await versionOf(real)) !== p.expectedVersion || (await movedSinceLocked(m, path, real))) return { ok: false, error: `File has been modified since read, either by the user or by a linter. Read it again before attempting to write it: ${path}` }
      args.path = real
    }
    if (tool === 'Read' && typeof args.file_path === 'string') args.file_path = absolute(args.file_path.trim(), cwd, home)
    // Plugins cannot run the Agent tool; codemode-agents spawns instead.
    const target = tool === 'Agent' || tool === 'Task' ? AGENTS_TOOL : tool
    const key = skillKey(String(args.skill ?? ''))
    // Calls to one skill take turns, so each gets its own expansion (its args may
    // differ); only text expanded after this call started counts.
    if (late()) return refusal('call')
    const timer: { handle?: { cancel: () => unknown } } = {}
    const release =
      tool === 'Skill' ? await skillTurn(key, new Promise((r) => (timer.handle = $.clock.after(60_000, () => r(undefined))))) : undefined
    timer.handle?.cancel()
    if (tool === 'Skill' && !release)
      return { ok: false, error: `An earlier Skill call for ${key} is still running after 60 s, so this one did not start; call it again once that one is done.` }
    const since = skillSeq
    const readBefore = tool === 'Read' && typeof args.file_path === 'string' ? await versionOf(args.file_path) : undefined
    const realBefore = tool === 'Read' && typeof args.file_path === 'string' ? await realOf(args.file_path) : undefined
    const patchPath = (v: unknown) => (typeof v === 'string' && !!v.trim() && !v.trim().startsWith('~') ? absolute(v.trim(), cwd, home) : undefined)
    const isPatch = /^mcp__lean[-_]ctx__(?:ctx_)?patch$/.test(tool)
    const patchPaths = isPatch ? [args.path, ...(Array.isArray(args.ops) ? (args.ops as Record<string, unknown>[]).map((o) => o?.path) : [])] : []
    if (patchPaths.some((v) => typeof v === 'string' && v.trim().startsWith('~')))
      return { ok: false, error: 'The patch tool reads a path starting with ~ as a folder named ~ inside its working folder, not as your home folder; give the full path' }
    const patchOps = isPatch
      ? (Array.isArray(args.ops) ? (args.ops as Record<string, unknown>[]) : [args])
          .map((o) => ({ op: String(o?.op ?? ''), path: patchPath(o?.path ?? args.path) }))
          .filter((o): o is { op: string; path: string } => !!o.path && o.path.startsWith('/'))
      : []
    const patchFresh = new Map<string, boolean>()
    const patchKeys = new Map<string, string>()
    for (const o of patchOps) if (!patchKeys.has(o.path)) patchKeys.set(o.path, await realOf(o.path))
    for (const [given, real] of patchKeys)
      if (await movedSinceLocked(m, given, real)) return { ok: false, error: `${given} now names another file than the one this patch waited to lock, so nothing was changed; patch it again` }
    const pinned = (v: unknown) => patchKeys.get(patchPath(v) ?? '') ?? v
    if (patchOps.length) {
      if (typeof args.path === 'string') args.path = pinned(args.path)
      if (Array.isArray(args.ops)) args.ops = (args.ops as Record<string, unknown>[]).map((o) => (o && typeof o.path === 'string' ? { ...o, path: pinned(o.path) } : o))
    }
    for (const o of patchOps)
      if (o.op !== 'create' && !patchFresh.has(patchKeys.get(o.path) as string)) {
        const key = patchKeys.get(o.path) as string
        const was = job.reads.has(key) ? job.reads.get(key) : readPaths.has(key) ? readVersions.get(key) : undefined
        patchFresh.set(key, was !== undefined && was === (await versionOf(key)))
      }
    if (late()) {
      release?.()
      return refusal('call')
    }
    const counted = p.poll !== true
    const tally = (counted ? calls.get(tool) : undefined) ?? { ok: 0, failed: 0, open: 0 }
    if (counted) calls.set(tool, tally)
    tally.open++
    if (counted) open.set(m.id, { tool, arg: firstArg(args), at: Date.now() })
    let r = await $.tool.call({ ...args, tool: target } as never).catch((err: unknown) => {
      tally.open--
      tally.failed++
      tally.arg ??= firstArg(args)
      release?.()
      const msg = (err as Error)?.message ?? String(err)
      // A tool a setting or another mod removed: name what may replace it.
      const near = msg.includes('no tool named') ? similar(tool, all.map((x) => x.name)) : []
      throw new Error(near.length ? `${msg}; similar: ${near.join(', ')}` : msg)
    })
    const body = release ? skillTexts.get(key) : undefined
    release?.()
    const capped =
      tool === 'Read' &&
      !r.isError &&
      args.limit === undefined &&
      (infoOf(r.result)?.truncatedByTokenCap === true || ((args.offset === undefined || args.offset === 1) && isStub(String(r.text ?? '')) && /read-dedup/.test(String(r.text ?? ''))))
    if (tool === 'Read' && args.limit === undefined && (capped || (r.isError && /exceeds maximum allowed (?:tokens|size)/i.test(String(r.text ?? show(r.result)))))) {
      const paged = await pageRead(args)
      if (paged === undefined && late()) {
        tally.open--
        tally.cutOff = (tally.cutOff ?? 0) + 1
        tally.arg ??= firstArg(args)
        return refusal('call')
      }
      if (paged?.text !== undefined) r = { text: paged.text, result: paged.result } as typeof r
      else if (paged?.error !== undefined) r = { isError: true, text: paged.error } as typeof r
      else if (capped)
        r = { isError: true, text: `${String(args.file_path)} is over Read's token cap and could not be read in pages (a single line may be over the cap); read part of it with sh() and head -c, or with offset and limit` } as typeof r
    }
    tally.open--
    const failed = r.deny !== undefined || r.isError === true
    if (failed) {
      tally.failed++
      tally.arg ??= firstArg(args)
    } else tally.ok++
    const saveDenied = () =>
      $.store.set('denied', Object.fromEntries([...deniedTools].map(([n, v]) => [n, { alt: v.alt, at: v.at }])) as never).catch(() => {})
    if (!failed && job.gen === sessionGen && deniedTools.delete(tool)) await saveDenied()
    const said = String(r.deny ?? (r.isError ? (r.text ?? show(r.result)) : ''))
    const refused = r.deny !== undefined || (r.isError === true && HOOK_RE.test(said) && !(SHELL_RE.test(tool) && exitOf(said, false, tool).code !== undefined))
    if (refused) {
      const plain = said.replace(/^\s*<tool_use_error>/, '').replace(/<\/tool_use_error>\s*$/, '')
      const whole = WHOLE_RE.exec(plain)
      const wants = whole && whole[1] === tool ? all.map((x) => x.name).filter((n) => n !== tool && (n === whole[2] || short(n) === whole[2])) : []
      const fits = (n: string) => (tool === 'Bash' ? /^mcp__lean[-_]ctx__(?:ctx_)?shell$/.test(n) : /^(?:Write|Edit)$/.test(tool) && /^mcp__lean[-_]ctx__(?:ctx_)?patch$/.test(n))
      const alt = wants.length === 1 && fits(wants[0] as string) ? wants[0] : undefined
      if (!alt) return { ok: false, error: plain, refused: true }
      if (!deniedTools.has(tool) && job.gen === sessionGen) {
        deniedTools.set(tool, { alt, at: Date.now() })
        await saveDenied()
      }
      return { ok: false, error: `${plain}\n${tool} is denied by a hook in this session; use tools.${ident(alt)}({...}) instead.`, denied: true, alt }
    }
    const markers: string[] = []
    const result = strip(r.result, pictures, markers)
    let text = r.text ?? show(result)
    if (tool === 'Skill' && !r.isError) {
      if (body && body.seq > since) text = `${text}\n\n${body.text}`
    }
    if (markers.length) text = [text.trim(), ...markers].filter(Boolean).join('\n')
    const toolResult = (path: string) => path.startsWith(`${configDir}/projects/`) && /\/tool-results\/[^/]+\.txt$/.test(path)
    const readBack = async (path: string, shell?: string) => {
      const paged = await pageRead({ file_path: path })
      if (paged?.text !== undefined) return paged.text.split('\n').map((l) => l.replace(/^\s*\d+\t/, '')).join('\n')
      if (shell && (paged === undefined || /over Read's token cap/.test(paged.error ?? ''))) return viaBytes(shell, path)
      return undefined
    }
    const saved = tool === 'Bash' ? PERSISTED.exec(text) : null
    if (saved) {
      const path = normal((saved[2] as string).trim())
      const head = (saved[3] as string).replace(/\r/g, '').slice(0, 1000)
      const whole = toolResult(path) ? await readBack(path, 'Bash') : undefined
      if (whole !== undefined && head && whole.replace(/\r/g, '').startsWith(head)) text = (saved[1] as string) + whole + (saved[4] as string)
      else persisted = true
    }
    const swapped = !r.isError && isMcp.has(tool) ? SAVED.exec(text) : null
    if (swapped) {
      const path = normal((swapped[2] as string).trim())
      const size = Number((swapped[1] as string).replace(/,/g, ''))
      const lean = /^mcp__lean[-_]ctx__(?:ctx_)?shell$/.test(tool) ? tool : undefined
      const back = toolResult(path) ? await readBack(path, lean) : undefined
      const whole = back !== undefined && back.length + 1 === size ? back + '\n' : back
      if (whole !== undefined && whole.length === size) text = whole
      else savedAway.add(tool)
    }
    const shell = SHELL_RE.test(tool) ? exitOf(text, !r.isError, tool) : undefined
    const exit = shell ? { ...(shell.code === undefined ? {} : { exitCode: shell.code }), shellText: shell.out } : {}
    if (!r.isError) {
      if (text.length > MAX_REPLY) {
        tally.ok--
        tally.failed++
        tally.arg ??= firstArg(args)
        return { ok: false, error: `The result of ${tool} is ${text.length} chars, too large to pass to the script whole; read a file with read(path), which reads in pages, or ask for less (offset and limit, a narrower command).` }
      }
      const target = typeof args.file_path === 'string' ? args.file_path : undefined
      const wrote = tool === 'Write' || tool === 'Edit'
      const moved = p.foreground === true && tool === 'Bash' ? (r.result as { backgroundTaskId?: unknown } | undefined)?.backgroundTaskId : undefined
      if (moved !== undefined) {
        tally.ok--
        tally.failed++
        tally.arg ??= firstArg(args)
        return { ok: false, error: `Bash moved the command to the background before it finished (task ${String(moved ?? 'unknown')}), so sh() cannot give its exit code: ${text.trim().slice(0, 300)} Wait for its output with waitFor, or give sh() a longer { timeout }.` }
      }
      const readNow: string[] = []
      const created = new Set(patchOps.filter((o) => o.op === 'create').map((o) => patchKeys.get(o.path) as string))
      const forgetEverywhere = (k: string) => {
        const forgetIn = (j: Job) => {
          j.reads.delete(k)
          j.readAt.delete(k)
          j.progress.delete(k)
          j.progressAt.delete(k)
        }
        forgetIn(job)
        if (job.gen !== sessionGen) return
        for (const j of jobsById.values()) if (j.gen === sessionGen) forgetIn(j)
        readPaths.delete(k)
        readVersions.delete(k)
        readProgress.delete(k)
        versionAt.delete(k)
        versionAt.set(k, ++readClock)
        progressAt.delete(k)
        progressAt.set(k, readClock)
      }
      for (const o of patchOps) {
        const key = patchKeys.get(o.path) as string
        if (created.has(key) || patchFresh.get(key) === true) {
          const version = await versionOf(key)
          job.progress.delete(key)
          job.progressAt.delete(key)
          job.reads.delete(key)
          job.reads.set(key, version)
          job.readAt.delete(key)
          job.readAt.set(key, ++readClock)
          readNow.push(o.path)
        } else forgetEverywhere(key)
      }
      const readAfter = tool === 'Read' && typeof args.file_path === 'string' ? await versionOf(args.file_path) : undefined
      const realAfter = tool === 'Read' && typeof args.file_path === 'string' ? await realOf(args.file_path) : undefined
      if (tool === 'Read' && p.handled === true && typeof args.file_path === 'string') {
        const from = typeof args.offset === 'number' ? args.offset : 1
        const pages = typeof p.readId === 'number' ? `#${p.readId}` : args.file_path
        const first = pagesStarted.get(pages)
        const heldStill = readBefore !== undefined && readBefore === readAfter && realBefore === realAfter
        if (from === 1) pagesStarted.set(pages, heldStill ? { version: readBefore, real: realBefore } : {})
        else if (first !== undefined && (!heldStill || readBefore !== first.version || realBefore !== first.real)) {
          tally.ok--
          tally.failed++
          return { ok: false, error: `${args.file_path} changed while it was read in pages; read it again` }
        }
      }
      const ownPages = tool === 'Read' && p.handled === true && typeof p.readId === 'number' ? pagesStarted.get(`#${p.readId}`) : undefined
      const ownChain = ownPages?.next !== undefined ? { next: ownPages.next, version: ownPages.version } : undefined
      const receipt =
        tool === 'Read' && p.internal !== true && typeof args.file_path === 'string'
          ? receiptOf(args.file_path, args.offset, args.limit, text, r.result, readBefore !== undefined && readBefore === readAfter && realBefore === realAfter ? readBefore : undefined, [ownChain, job.progress.get(realAfter ?? args.file_path), readProgress.get(realAfter ?? args.file_path)])
          : wrote && typeof target === 'string' && target.startsWith('/')
            ? ({ file: normal(target), whole: true } as Receipt)
            : undefined
      if (receipt?.whole && receipt.version === undefined) receipt.version = await versionOf(receipt.file)
      if (ownPages && receipt && !receipt.whole && receipt.next !== undefined) ownPages.next = receipt.next
      if (receipt) receipt.file = tool === 'Read' && realAfter !== undefined ? realAfter : await realOf(receipt.file)
      if (isStub(text, tool) && p.handled !== true && isWithheld(text, tool)) withheld.add(tool)
      else if (isStub(text, tool) && p.handled !== true) {
        stubs.add(tool)
        if (/read-dedup/.test(text)) deduped = true
      }
      const leanJob = /^mcp__lean[-_]ctx__(?:ctx_)?shell$/.test(tool) && typeof r.result === 'string' ? jobOf(r.result) : undefined
      return { ok: true, text, result, ...exit, ...(leanJob ? { job: leanJob } : {}), ...(receipt?.whole ? { whole: true } : {}), ...(readNow.length ? { readNow } : {}), ...(receipt ? { [READ]: receipt } : {}) }
    }
    const bad = tidy(tool, text)
    if (tool === 'Read' && /File does not exist/i.test(bad.message) && typeof args.file_path === 'string' && args.file_path.startsWith('/')) {
      const at = args.file_path.lastIndexOf('/')
      const folder = args.file_path.slice(0, at) || '/'
      const root = cwd ? normal(cwd) : undefined
      const inside = root !== undefined && (folder === root || folder.startsWith(root === '/' ? '/' : `${root}/`))
      const listed = inside ? ((await $.fs.list(folder).catch(() => [])) ?? []).map((x) => x.name) : []
      const near: string[] = []
      for (const n of nearNames(args.file_path.slice(at + 1), listed)) {
        const path = `${folder === '/' ? '' : folder}/${n}`
        const probe = late() ? undefined : await $.tool.call({ file_path: path, limit: 1, tool: 'Read' } as never).catch(() => undefined)
        const said = String(probe?.text ?? '')
        if (probe && probe.deny === undefined && (probe.isError !== true || /exceeds maximum allowed/i.test(said))) near.push(path)
      }
      if (near.length) bad.message = `${bad.message} Similar files: ${near.join(', ')}`
    }
    // Learned from built-ins only: an MCP server writes its own error text.
    if (bad.type && !isMcp.has(tool)) {
      if (learned.size >= 200) learned.delete(learned.keys().next().value as string)
      learned.set(tool, bad.type)
      // Kept across sessions: the engine no longer writes the type files, so a
      // built-in's bad-arguments error is the only other source of its type.
      const k = await typeKey(tool)
      if (k) await $.store.set(k, bad.type as never).catch(() => {})
    }
    const engineCut = SHELL_RE.test(tool) && ENGINE_CUT.test(text) && !LEAN_ARCHIVED.test(text)
    if (engineCut && p.poll !== true) cut.add(tool)
    return { ok: false, error: bad.message, text: bad.message, result, ...exit, ...(engineCut ? { cut: true } : {}) }
  }

  const viaBytes = async (shell: string, path: string): Promise<string | undefined> => {
    const step = 21000
    const extra = shell === 'Bash' ? {} : { raw: true }
    const ask = (command: string) => (late() ? Promise.resolve(undefined) : $.tool.call({ ...extra, command, tool: shell } as never).catch(() => undefined))
    const sized = await ask('wc -c < ' + shellQuote(path))
    const size = Number(String(sized?.text ?? '').trim())
    if (!sized || sized.isError || sized.deny !== undefined || !Number.isInteger(size)) return undefined
    const bytes: number[] = []
    for (let at = 0; at < size; at += step) {
      if (over) return undefined
      const r = await ask('tail -c +' + (at + 1) + ' ' + shellQuote(path) + ' | head -c ' + step + ' | base64')
      if (!r || r.isError || r.deny !== undefined) return undefined
      const part = bytesOf(String(r.text ?? '').replace(/\s+/g, ''))
      if (!part || part.length !== Math.min(step, size - at)) return undefined
      for (const b of part) bytes.push(b)
    }
    return bytes.length === size ? fromUtf8(bytes) : undefined
  }
  const pageRead = async (args: Record<string, unknown>): Promise<{ text?: string; error?: string; result?: unknown } | undefined> => {
    const pages: string[] = []
    let size = 0
    let offset = typeof args.offset === 'number' && args.offset > 1 ? args.offset : 1
    let limit = 2000
    let stubbed = 0
    let tried = new Set<number>()
    let cap = 2000
    let total: number | undefined
    const start = offset
    const file = String(args.file_path)
    const version = await versionOf(file)
    const real = await realOf(file)
    const moved = async () => version === undefined || (await versionOf(file)) !== version || (await realOf(file)) !== real
    for (let guard = 0; guard < 10_000; guard++) {
      if (over) return undefined
      const r = late() ? undefined : await $.tool.call({ ...args, offset, limit, tool: 'Read' } as never).catch(() => undefined)
      if (r && !r.isError && r.deny === undefined && (await moved())) return { error: `${file} changed while it was read in pages; read it again` }
      if (!r) return undefined
      if (r.deny !== undefined) return { error: `Reading ${file} in pages stopped at line ${offset}: ${r.deny}` }
      const t = String(r.text ?? show(r.result))
      const cutAtCap = !r.isError && infoOf(r.result)?.truncatedByTokenCap === true
      if (r.isError || cutAtCap) {
        if (cutAtCap || /exceeds maximum allowed/i.test(t)) {
          tried.add(limit)
          cap = Math.min(cap, limit - 1)
          limit = pickLimit(limit, tried, cap, Math.floor(limit / 2))
          if (limit) continue
          if (offset === 1) return undefined
          return { error: `${file} has a line over Read's token cap at line ${offset}, so it cannot be read in pages; read part of it with sh() and head -c` }
        }
        return { error: offset > 1 ? `Reading ${file} in pages stopped at line ${offset}: ${t.slice(0, 300)}` : t.slice(0, 2000) }
      }
      if (isStub(t) && /read-dedup/.test(t)) {
        tried.add(limit)
        limit = ++stubbed > 6 ? 0 : pickLimit(limit, tried, cap, Math.max(1, Math.min(limit, 2000) - 1 - Math.floor(Math.random() * Math.min(400, Math.floor(limit / 2)))))
        if (!limit) return { error: `Reading ${file} in pages: Read keeps answering with a stub, not the file` }
        continue
      }
      const rows = t.split('\n').filter((l) => /^\s*\d+\t/.test(l))
      if (!rows.length && !NOTICE.test(t)) return { error: `Reading ${file} in pages stopped at line ${offset}: Read answered with no file lines: ${t.slice(0, 200)}` }
      size += t.length
      if (size > MAX_REPLY) return { error: `${file} is too large to pass to the script whole (over ${MAX_REPLY} chars); read it with read(path), which reads in pages, or with offset and limit` }
      if (rows.length) pages.push(rows.join('\n'))
      const info = infoOf(r.result)
      if (typeof info?.totalLines === 'number') total = info.totalLines
      if (rows.length < limit && !(total !== undefined && offset + rows.length - 1 < total)) break
      offset += rows.length
      tried = new Set()
      cap = 2000
      limit = Math.min(2000, limit * 2)
      stubbed = 0
      if (guard === 9_999) return { error: `Reading ${file} in pages stopped after 10000 pages` }
    }
    const text = pages.join('\n')
    const lines = text ? text.split('\n') : []
    const content = lines.map((l) => l.replace(/^\s*\d+\t/, '')).join('\n')
    return { text, result: { type: 'text', file: { filePath: file, content, numLines: lines.length, startLine: start, totalLines: total ?? start + lines.length - 1 } } }
  }

  let over = false
  const late = () => over || !!job.cancelledBy || killed || Date.now() >= started + timeout
  const refusal = (what: string) => ({ ok: false, error: `the run was stopped by ${job.cancelledBy ?? 'its timeout'} before this ${what} started` })
  const writes = new Set<Promise<unknown>>()
  const replies = new Set<Promise<unknown>>()
  const items: string[] = []
  const keys: (string[] | undefined)[] = []
  const logs: string[] = []
  let aborted = false
  let printed = 0
  const take = (s: string): string | undefined => {
    const left = 1_000_000 - printed
    if (left <= 0) return undefined
    const kept = s.length > left ? `${s.slice(0, safeEnd(s, left))}\n…output cut at 1000000 chars…` : s
    printed += Math.min(s.length, left)
    return kept
  }
  const pictures: Picture[] = []
  const realpath = (p: string) => $.process.run(['realpath', p]).then((r) => (r.exitCode === 0 && r.stdout.trim() ? r.stdout.trim() : undefined), () => undefined)
  const readlink = (p: string) => $.process.run(['readlink', p]).then((r) => (r.exitCode === 0 && r.stdout.trim() ? r.stdout.trim() : undefined), () => undefined)
  const realOf = async (p: string) => {
    let path = p
    for (let hops = 0; hops < 40; hops++) {
      const next = await resolveOnce(path)
      if (next.done) return next.path
      path = next.path
    }
    return path
  }
  const resolveOnce = async (p: string): Promise<{ done: boolean; path: string }> => {
    let missing = ''
    for (let head = p; ; ) {
      const found = await realpath(head)
      if (found) return { done: true, path: found.replace(/\/$/, '') + missing }
      const target = await readlink(head)
      if (target) {
        const parent = head.slice(0, head.lastIndexOf('/')) || '/'
        const base = target.startsWith('/') ? '' : ((await realpath(parent)) ?? parent).replace(/\/$/, '') + '/'
        return { done: false, path: (base + target + missing).replace(/\/(?:\.?\/)+/g, '/') }
      }
      const slash = head.lastIndexOf('/')
      if (slash <= 0) return { done: true, path: p }
      missing = head.slice(slash) + missing
      head = head.slice(0, slash)
    }
  }
  const climbs = (v: unknown) => typeof v === 'string' && /(^|\/)\.\.(\/|$)/.test(v.trim())
  const isFolder = (p: string) => $.fs.stat(p, { resolve: true }).then((st) => st?.kind === 'dir', () => false)
  const climb = async (p: string, hops = 0): Promise<string | undefined> => {
    const segs = p.split('/').filter((seg) => seg !== '' && seg !== '.')
    const kept: string[] = []
    for (let i = 0; i < segs.length; i++) {
      if (segs[i] !== '..') {
        kept.push(segs[i] as string)
        continue
      }
      if (hops >= 40) return undefined
      const link = kept.length ? await readlink('/' + kept.join('/')) : undefined
      if (link === undefined) {
        if (hops && kept.length && !(await isFolder('/' + kept.join('/')))) return undefined
        kept.pop()
        continue
      }
      const into = link.startsWith('/') ? link : '/' + kept.slice(0, -1).join('/') + '/' + link
      return climb(into + '/' + segs.slice(i).join('/'), hops + 1)
    }
    return '/' + kept.join('/')
  }
  const onDisk = async (v: string, relative = true) => {
    const t = v.trim()
    const e = t === '~' || t.startsWith('~/') ? home + t.slice(1) : t
    if (e.startsWith('/')) return climb(e)
    return relative && cwd ? climb(`${cwd.replace(/\/$/, '')}/${e}`) : v
  }
  const namesNoFile = (v: string) => `${v} climbs out of a symlinked folder and then through a folder that does not exist there, so it names no file on disk`
  const resolveClimbs = async (m: Request): Promise<string | undefined> => {
    if (m.kind === 'fresh' && climbs(m.payload.path)) {
      const found = await onDisk(String(m.payload.path))
      if (found === undefined) return namesNoFile(String(m.payload.path).trim())
      m.payload.path = found
    }
    if (m.kind !== 'call') return undefined
    const tool = String(m.payload.tool)
    const lean = /^mcp__lean[-_]ctx__/.test(tool)
    if (!lean && !/^(?:Read|Write|Edit|MultiEdit|NotebookEdit|NotebookRead|Grep|Glob|LS)$/.test(tool)) return undefined
    const relative = lean || /^(?:Read|NotebookRead|Grep|Glob|LS)$/.test(tool)
    const given = (m.payload.args && typeof m.payload.args === 'object' ? m.payload.args : {}) as Record<string, unknown>
    const preset = defaults[tool] ?? {}
    const args = { ...given }
    const lost: string[] = []
    const climbed = new Map<string, [string, boolean][]>()
    climbedFrom.set(m, climbed)
    const place = async (v: unknown) => {
      const found = await onDisk(String(v), relative)
      if (found === undefined) lost.push(String(v).trim())
      else climbed.set(found, [...(climbed.get(found) ?? []), [String(v), relative]])
      return found ?? String(v)
    }
    const climbable = (v: unknown) => climbs(v) && !(lean && String(v).trim().startsWith('~'))
    for (const k of ['file_path', 'notebook_path', 'path']) {
      const v = k in given ? given[k] : preset[k]
      if (climbable(v)) args[k] = await place(v)
    }
    if (Array.isArray(args.ops)) args.ops = await Promise.all((args.ops as Record<string, unknown>[]).map(async (o) => (o && climbable(o.path) ? { ...o, path: await place(o.path) } : o)))
    m.payload.args = args
    return lost.length ? namesNoFile(lost[0] as string) : undefined
  }
  const respond = async (m: Request) => {
    const lost = await resolveClimbs(m)
    let out: Record<string, unknown>
    const unlocks: (() => void)[] = []
    const real = await Promise.all(writeTargets(m, cwd, home, defaults).map(realOf))
    lockedReals.set(m, new Set(real))
    for (const path of [...new Set(real)].sort()) unlocks.push(await lockFile(path))
    try {
      out = lost ? { ok: false, error: lost } : await handle(m)
    } catch (err) {
      out = { ok: false, error: (err as Error)?.message ?? String(err) }
    } finally {
      for (const unlock of unlocks.reverse()) unlock()
    }
    open.delete(m.id)
    // The child is gone after a timeout; writing would recreate its run dir.
    if (over) return
    const file = `${dir}/${m.id}.json`
    const receipt = out[READ as never] as Receipt | undefined
    let undo: (() => void) | undefined
    if (receipt) {
      const f = receipt.file
      const stamp = ++readClock
      const read = { had: job.reads.has(f), value: job.reads.get(f), at: job.readAt.get(f) }
      const page = { value: job.progress.get(f), at: job.progressAt.get(f) }
      const restorePage = () => {
        if (page.value === undefined) job.progress.delete(f)
        else job.progress.set(f, page.value)
        if (page.at === undefined) job.progressAt.delete(f)
        else job.progressAt.set(f, page.at)
      }
      if (receipt.whole) {
        job.progress.delete(f)
        job.progressAt.delete(f)
        job.reads.delete(f)
        job.reads.set(f, receipt.version)
        job.readAt.delete(f)
        job.readAt.set(f, stamp)
        undo = () => {
          if (job.readAt.get(f) !== stamp) return
          if (read.had) job.reads.set(f, read.value)
          else job.reads.delete(f)
          if (read.at === undefined) job.readAt.delete(f)
          else job.readAt.set(f, read.at)
          if (!job.progress.has(f)) restorePage()
        }
      } else if (receipt.next !== undefined) {
        job.progress.delete(f)
        job.progress.set(f, { next: receipt.next, version: receipt.version })
        job.progressAt.delete(f)
        job.progressAt.set(f, stamp)
        undo = () => {
          if (job.progressAt.get(f) === stamp) restorePage()
        }
      }
    }
    // Tracked whole, fallbacks included, so the run dir is removed only after it.
    const delivered = (async () => {
      if (await $.fs.write(file, JSON.stringify(out)).then(() => true, () => false)) return true
      const size = typeof out.text === 'string' ? out.text.length : 0
      const tool = String((m.payload as { tool?: unknown }).tool ?? 'the tool')
      const sameText = out.result === out.text
      const base = { ok: out.ok, error: out.error, text: out.shellText ?? out.text, exitCode: out.exitCode, whole: out.whole }
      const slim = sameText ? { ...base, resultIsText: true } : { ...base, result: out.result }
      if (await $.fs.write(file, JSON.stringify(slim)).then(() => true, () => false)) return true
      if (!sameText && (await $.fs.write(file, JSON.stringify({ ...base, droppedResult: true })).then(() => true, () => false))) return true
      const failed = { ok: false, error: `The result of ${tool} is ${size} chars, too large to pass to the script whole; read a file with read(path), which reads in pages, or ask for less (offset and limit, a narrower command).` }
      const t = calls.get(tool)
      if (t && out.ok) {
        t.ok--
        t.failed++
        t.arg ??= firstArg(((m.payload as { args?: unknown }).args ?? {}) as Record<string, unknown>)
      }
      await $.fs.write(file, JSON.stringify(failed)).catch(() => {})
      return false
    })()
    const reply = delivered.then((ok) => {
      if (!ok) undo?.()
    })
    writes.add(reply)
    void reply.finally(() => writes.delete(reply))
    await reply
  }

  // The child may only touch its own run dir, so it has to exist before the child starts.
  if (job.cancelledBy) {
    if (!job.settled) job.stopped = true
    return { result: format(0, { items: [], logs: [], kind: job.stopKind ?? 'cancelled', failure: `stopped before it started, by ${job.cancelledBy}; none of its tool calls ran.` }) }
  }
  const shellPref = await $.env.get('CODEMODE_SHELL')
  await $.fs.write(`${dir}/.keep`, '')

  let started = Date.now()
  let done: Done | undefined
  let stderr = ''
  let buf = ''
  let pid: number | undefined
  let discard = false
  let killed = false
  // The child's own timer cannot fire while a script spins synchronously, so
  // the mod kills it a little after the deadline.
  let gone = false
  const killRunner = () => {
    killed = true
    if (pid) void $.process.run(['kill', '-9', String(pid)]).catch(() => {})
  }
  let watchdog: { cancel: () => unknown } = { cancel: () => undefined }
  const armWatchdog = (ms: number) => {
    watchdog.cancel()
    watchdog = $.clock.after(ms, async () => {
      const now = await clockNow($)
      if (gone || pid === undefined) return
      const left = started + timeout + 5_000 - now
      if (left > 0) armWatchdog(Math.max(50, left))
      else killRunner()
    })
  }
  armWatchdog(timeout + 5_000)
  try {
    if (!job.cancelledBy && !job.pid && Date.now() > job.deadline) expire(job)
    if (job.cancelledBy) throw new Error('codemode: stopped before its runner started')
    const child = $.process.spawn({
      argv: [node, '--permission', `--allow-fs-read=${dir}`, `--allow-fs-write=${dir}`, '-e', RUNNER],
      input: JSON.stringify({ script, tools: all, dir, timeout, texts, cwd, home, denied: [...deniedTools.keys()], shell: shellPref, seen: [...readPaths] }),
    })
    for await (const piece of child) {
      if (piece.stream === 'stderr') {
        stderr = (stderr + piece.text).slice(-20_000)
        continue
      }
      buf += piece.text
      for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        if (!line.startsWith('\x1eCM')) continue
        let m: Partial<Request & Done & { pid: number; out: string; text: string; keys: unknown }>
        try {
          m = JSON.parse(line.slice(3))
        } catch {
          continue
        }
        // The pid is the runner's first line, before any script code runs.
        if (pid === undefined) {
          pid = Number.isSafeInteger(m.pid) && (m.pid as number) > 1 ? m.pid : 0
          const childStarted = (m as { started?: unknown }).started
          if (typeof childStarted === 'number' && childStarted >= started && childStarted <= Date.now()) started = childStarted
          watchdog.cancel()
          armWatchdog(Math.max(0, started + timeout + 5_000 - Date.now()))
          job.pid = pid || undefined
          job.onPid()
          if (killed || job.cancelledBy) {
            discard = true
            if (pid) void $.process.run(['kill', '-9', String(pid)]).catch(() => {})
          }
          continue
        }
        if (discard) continue
        if (m.done === true && job.cancelledBy) {
          over = true
          continue
        }
        if (m.done === true) {
          job.exited = true
          done = { done: true, failure: m.failure, kind: m.kind, failedId: (m as { failedId?: number }).failedId, alongside: Number((m as { alongside?: unknown }).alongside) || 0 }
          over = true
        } else if (m.out === 'log' && typeof m.text === 'string') {
          const t = take(m.text)
          if (t !== undefined) logs.push(t)
        } else if (m.out === 'item' && (typeof m.text === 'string' || Array.isArray(m.keys))) {
          const parts = Array.isArray(m.keys) && m.keys.every((k) => typeof k === 'string') ? (m.keys as string[]) : undefined
          const whole =
            typeof m.text === 'string'
              ? m.text
              : (m as { json?: unknown }).json === true
                ? `{\n${(parts ?? []).map((k) => `  ${k.split('\n').join('\n  ')}`).join(',\n')}\n}`
                : (parts ?? []).join('\n')
          const t = take(whole)
          if (t !== undefined) {
            items.push(t)
            keys.push(t === whole ? parts : undefined)
          }
        }
        else if (!done && !killed && !job.cancelledBy && Number.isSafeInteger(m.id) && (m.id as number) > 0 && KINDS.has(m.kind as string) && m.payload && typeof m.payload === 'object') {
          const reply = respond(m as Request)
          replies.add(reply)
          void reply.finally(() => replies.delete(reply))
        }
      }
      if (buf.length > 8_000_000) buf = ''
    }
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err)
    if ((err as Error)?.name === 'AbortError' || /\$\.process\.spawn\([^)]*\) aborted|AbortError/.test(msg)) aborted = true
    else stderr += `\n${msg}`
  }
  gone = true
  job.exited = true
  job.pid = undefined
  watchdog.cancel()
  if (done?.failure && done.kind !== 'timeout' && open.size)
  {
    const grace: { handle?: { cancel: () => unknown } } = {}
    await Promise.race([Promise.allSettled([...replies]), new Promise((r) => (grace.handle = $.clock.after(1_500, () => r(undefined))))])
    grace.handle?.cancel()
  }
  over = true
  watchdog.cancel()
  // A reply already being written could recreate the dir after it is removed.
  await Promise.allSettled([...writes])
  await $.process.run(['rm', '-rf', dir]).catch(() => {})
  let ended: Ended = job.cancelledBy
    ? { items, keys, logs, kind: job.stopKind ?? 'cancelled', failure: job.stopKind === 'aborted' ? 'stopped because its turn was interrupted; what it printed is above, and its tool calls may have run.' : `stopped by cancel() from ${job.cancelledBy}; what it printed is above, and its tool calls may have run.` }
    : done
    ? { items, keys, logs, failure: done.failure, kind: done.kind }
    : aborted
      ? { items, keys, logs, kind: 'aborted', failure: 'the run was interrupted before it finished (the session stopped it); what it printed is above, and its tool calls may have run.' }
      : killed
        ? { items, keys, logs, kind: 'timeout', failure: `timed out after ${timeout}ms (the script never yielded, so its runner was killed)` }
        : { items, keys, logs, kind: 'runner', failure: `script runner exited without a result.\n${stderr.trim()}` }
  if (!job.settled) job.stopped = !!job.cancelledBy || ended.kind === 'aborted'
  const first = ended.failure?.split('\n')[0] ?? ''
  if (ended.failure && (ended.kind === 'timeout' || job.stopped) && open.size) {
    const now = Date.now()
    const still = [...open.values()].map((o) => `${o.tool} (${((now - o.at) / 1000).toFixed(1)}s${o.arg ? `, ${o.arg}` : ''})`)
    const when = ended.kind === 'timeout' ? 'when it timed out' : 'when it was stopped'
    ended = { ...ended, failure: `${ended.failure}\nstill running ${when} (abandoned, not stopped: they may still finish, so do not repeat them blind): ${still.join('; ')}` }
  }
  const notes = [
    ...(stubs.size
      ? [`Note: a result from ${[...stubs].join(', ')} was a compressed stub, not the tool's full text; ${deduped ? 'read(path) gets a whole file past a repeated-read stub, and ' : ''}call the tool with raw: true, or set CODEMODE_TOOL_DEFAULTS, to get the full text.`]
      : []),
    ...(cut.size
      ? [`Note: Claude Code cut the middle out of a failed command's output from ${[...cut].join(', ')} (it keeps the first and last 5,000 chars of a failed result over 10,000); that sh() result is marked .truncated, and sending the output to a file (cmd > /tmp/out.txt 2>&1) and reading it with read(path) gets all of it.`]
      : []),
    ...(savedAway.size
      ? [`Note: Claude Code saved a result from ${[...savedAway].join(', ')} to a file instead of returning it (it was over its token limit), and it could not be read back here; read(path) of the file the result names gets it where Read may open it.`]
      : []),
    ...(withheld.size ? [`Note: lean-ctx withheld a result from ${[...withheld].join(', ')} by its storage policy; that text is not available to scripts here.`] : []),
    ...(persisted ? ['Note: Bash saved a big output to a file instead of returning it (<persisted-output>), and it could not be read back here; read(path) of the file it names gets it whole where Read may open it.'] : []),
  ]
  if (notes.length) ended = { ...ended, notes }
  // A failed call can have changed things too (a command that wrote, then exited non-zero).
  const only = calls.size === 1 ? [...calls][0] : undefined
  // One failed call whose own error ended the run says nothing the error does not.
  const echo =
    only !== undefined &&
    only[1].ok + only[1].open === 0 &&
    only[1].failed === 1 &&
    [only[0], ident(only[0])].some((n) => ended.failure?.includes(`Error: ${n}: `) === true)
  const ran = echo ? '' : ledger(calls)
  if (ended.failure && ran) ended = { ...ended, failure: `${ended.failure}\nTool calls before the failure: ${ran}` }
  const now = Date.now()
  const alongside = done?.failedId ? (done.alongside ?? 0) : 0
  if (ended.failure && ended.kind === 'tool' && alongside > 0)
    ended = {
      ...ended,
      failure: `${ended.failure}\n${alongside} call${alongside === 1 ? '' : 's'} that ran alongside it had succeeded or were still running; their results are lost with this failure: use call(), which never throws, or Promise.allSettled to keep them.`,
    }
  const current = job.gen === sessionGen
  const before = current ? failedScripts.get(raw) : undefined
  if (ended.failure && ended.kind !== 'aborted' && ended.kind !== 'cancelled') {
    if (before)
      ended = {
        ...ended,
        failure:
          before.first === first
            ? `${ended.failure}\nThis is the same script as a run that failed ${Math.round((now - before.at) / 1000)}s ago with the same error: change the script, not just run it again.`
            : `${ended.failure}\nThis is the same script as a run that failed ${Math.round((now - before.at) / 1000)}s ago with: ${before.first.slice(0, 200)}`,
      }
    if (current) {
      failedScripts.delete(raw)
      failedScripts.set(raw, { first, at: now })
    }
    if (failedScripts.size > 20) failedScripts.delete(failedScripts.keys().next().value as string)
  } else if (!ended.failure && current) failedScripts.delete(raw)
  const room = maxChars - 400
  let parts = sections(now - started, ended)
  let full = parts.join('\n')
  if (full.length > room) {
    parts = sections(now - started, ended, true)
    full = parts.join('\n')
  }
  // A cut output is kept whole on disk, so nothing in it needs a second run.
  let file: string | undefined
  if (full.length > room) {
    const spills = `${home}/.claude/codemode/out`
    const path = `${spills}/${dir.slice(root.length + 1)}.txt`
    job.spill = `${dir.slice(root.length + 1)}.txt`
    ownSpills.add(job.spill)
    while (ownSpills.size > 1000) ownSpills.delete(ownSpills.values().next().value as string)
    const waiting = new Set([...jobsById.values()].filter((j) => !j.delivered && j.spill).map((j) => j.spill))
    file = await $.fs.write(path, full).then(() => path, () => undefined)
    let mine = 0
    const old = ((await $.fs.list(spills).catch(() => [])) ?? [])
      .filter((x) => x.name.endsWith('.txt'))
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .filter((x) => {
        const aged = Date.now() - x.mtimeMs > SPILL_AGE_MS
        if (!ownSpills.has(x.name)) return aged
        const extra = mine++ >= KEEP_SPILLS
        return !waiting.has(x.name) && Date.now() - (handedSpills.get(x.name) ?? 0) > SPILL_AGE_MS && (extra || aged)
      })
    if (old.length) await $.process.run(['rm', '-f', ...old.map((x) => `${spills}/${x.name}`)]).catch(() => {})
  }
  const out = fit(parts, room, file, (ended.notes?.length ?? 0) + (ended.failure ? 1 : 0))
  // A marker the cut removed still counts: the script chose to show it.
  const blocks = attach(full, pictures)
  return { result: blocks.length ? ([{ type: 'text', text: out }, ...blocks] as never) : out }
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    // The session's own tools pick the description's argument lines; a list the
    // engine cannot give yet leaves the full description.
    const names = new Set(await $.tool.list().then((l) => l.map((t) => t.name), () => [] as string[]))
    const cwd = (e as { cwd?: unknown }).cwd
    sessionCwd = typeof cwd === 'string' && cwd ? cwd : undefined
    const kept = (await $.store.get('denied').catch(() => undefined)) as Record<string, { alt?: string; at?: number }> | undefined
    deniedTools.clear()
    for (const [n, v] of Object.entries(kept && typeof kept === 'object' ? kept : {}))
      if (v && Date.now() - Number(v.at ?? 0) < DENIED_MS && (names.size === 0 || (typeof v.alt === 'string' && names.has(v.alt)))) deniedTools.set(n, { alt: v.alt, at: Number(v.at) })
    await $.tool.register({
      name: NAME,
      description: describeRun(names, new Map([...deniedTools].map(([n, v]) => [n, v.alt]))),
      isDeferred: false,
      inputSchema: {
        type: 'object',
        properties: { script: { type: 'string', description: 'JavaScript source (async function body).' } },
        required: ['script'],
      },
    })
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    sessionGen++
    const jobs = [...jobsById.values()]
    for (const j of jobs) j.quiet = true
    void stopJobs($, jobs, 'the end of its session', 'aborted')
    jobsById.clear()
    deliveredIds.clear()
    versionAt.clear()
    for (const j of jobs) j.expiry?.cancel()
    mainTurn = false
    mainTurnId = undefined
    readPaths.clear()
    readProgress.clear()
    progressAt.clear()
    readVersions.clear()
    failedScripts.clear()
    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    const skipped = !!r && typeof r === 'object' && 'skip' in r && (r as { skip?: unknown }).skip !== undefined
    if (!e.agentId && e.trigger !== 'precompute' && !skipped) {
      readPaths.clear()
      readProgress.clear()
      progressAt.clear()
      readVersions.clear()
      versionAt.clear()
    }
    return r
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    if (agentOf((e as { agentId?: unknown }).agentId) === MAIN) {
      mainTurn = true
      turnSeq++
      mainTurnId = String((e as { turnId?: unknown }).turnId ?? '') || undefined
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const agent = agentOf((e as { agentId?: unknown }).agentId)
    const turnId = String((e as { turnId?: unknown }).turnId ?? '') || undefined
    const seq = turnSeq
    const current = !mainTurnId || !turnId || turnId === mainTurnId
    try {
      return await next(e)
    } finally {
      if (agent !== MAIN) {
        const jobs = agentJobs(agent)
        await stopJobs($, jobs, 'the end of its agent\'s turn', 'cancelled')
        for (const j of jobs) {
          j.expiry?.cancel()
          jobsById.delete(j.id)
        }
      } else {
        if ((e as { isAborted?: unknown }).isAborted === true) {
          const jobs = agentJobs(MAIN).filter((j) => (turnId ? j.turnId === turnId : current && j.turnSeq === seq))
          for (const j of jobs) j.quiet = true
          await stopJobs($, jobs, 'the interrupt', 'aborted')
        }
        if (current && turnSeq === seq) {
          mainTurn = false
          mainTurnId = undefined
          await wake($)
        }
      }
    }
  })

  on('classic.Stop', async ($, e, next) => {
    const surfaces: unknown = await $.session.surfaces().catch(() => [])
    const watched = Array.isArray(surfaces) && surfaces.length > 0
    if (watched) return next(e)
    const signal = (next as { signal?: AbortSignal }).signal
    const ready = await holdTurn($, MAIN, signal)
    const r = await next(e)
    if (!ready.length || signal?.aborted) return r
    for (const j of ready) j.noticed = true
    return withHeld(r, notice(ready)) as never
  }).catch(($, e, next) => next(e))

  on('classic.SubagentStop', async ($, e, next) => {
    const id = (e as { agent_id?: unknown }).agent_id
    if (typeof id !== 'string' || !id) return next(e)
    const signal = (next as { signal?: AbortSignal }).signal
    const ready = await holdTurn($, agentOf(id), signal)
    const r = await next(e)
    if (!ready.length || signal?.aborted) return r
    for (const j of ready) j.noticed = true
    return withHeld(r, notice(ready)) as never
  }).catch(($, e, next) => next(e))

  on('skill.prompt', async ($, e, next) => {
    const r = await next(e)
    const key = skillKey(e.skill)
    skillTexts.delete(key)
    if (skillTexts.size >= 50) skillTexts.delete(skillTexts.keys().next().value as string)
    skillTexts.set(key, { text: r.text, seq: ++skillSeq })
    return r
  })

  // Only the script tool and ToolSearch stay in the prompt; every other tool
  // waits deferred and is reached from scripts.
  on('tool.describe', async ($, e, next) => {
    const r = await next(e)
    // A schema ToolSearch loads tempts a direct call, which is refused: one wasted round trip.
    if (e.tool === SEARCH)
      return { ...r, isDeferred: false, description: `${r.description}\n\nUnder codemode a loaded tool is still called from a ${FULL} script (tools.<Name>(args)), never directly.` }
    if (e.tool === FULL) return { ...r, isDeferred: false }
    // Neither is called as tools.<name>: the spawn tool's own description sends
    // callers to Agent, and Workflow is refused from scripts as well.
    if (e.tool === AGENTS_TOOL || e.tool === 'Workflow') return { ...r, isDeferred: true }
    // The loaded schema is what the model reads as it decides how to call, so it
    // names the script form too: GLM 5.3 read the note above, loaded a tool and
    // still called it directly. Deferred, the line costs nothing until loaded.
    return {
      ...r,
      isDeferred: true,
      description: `${r.description}\n\nUnder codemode, call this only inside a ${FULL} script: await tools.${ident(e.tool)}({...}). A direct call is refused.`,
    }
  })

  on('tool.call', async ($, e, next) => {
    if ((e.tool as string) !== FULL) {
      // The model's own calls come from the engine, and a subagent a script
      // started calls under codemode-agents' origin. A script's own calls skip
      // this hook entirely; other plugins' calls pass through.
      // codemode-agents' own spawn runs the Agent tool outside any subagent.
      const isSpawn = e.tool === 'Agent' && next.origin.plugin === AGENTS_PLUGIN && !e.agentId
      const fromModel = next.origin.plugin === 'engine' || next.origin.plugin === AGENTS_PLUGIN
      if (fromModel && !isSpawn && e.tool !== SEARCH)
        return {
          deny: `Direct tool calls are disabled. Call ${e.tool} from a script with ${FULL}: return await tools.${ident(e.tool)}({...})`,
        }
      return next(e)
    }

    const raw = String((e as unknown as { script?: unknown }).script ?? '')
    const caller = agentOf((e as { agentId?: unknown }).agentId)
    if (caller === MAIN) mainTurn = true
    if (!raw.trim()) return { result: collectReply(caller) as never }
    const { options, error } = parseOptions(raw)
    if (error) return { result: format(0, { items: [], logs: [], failure: error, kind: 'syntax' }) }
    const pre = extractText(raw)
    if (pre.error) return { result: format(0, { items: [], logs: [], failure: pre.error, kind: 'syntax' }) }
    const script = pre.script
    const timeout = num(options.timeout_ms, DEFAULT_TIMEOUT_MS, 1_000, 3_600_000)
    const maxChars = num(options.max_output_chars, DEFAULT_MAX_CHARS, 1_000, 1_000_000)
    const job = startJob(caller, timeout)
    expireLater($, job)
    job.done = execute($, job, raw, script, pre.texts, timeout, maxChars).then(
      (r) => settle(job, r.result),
      (err: unknown) => settle(job, format(0, { items: [], logs: [], failure: `codemode's own hook failed: ${(err as Error)?.message ?? String(err)}`, kind: 'runner' })),
    )
    if (job.agent === MAIN) void job.done.then(() => wake($))
    return { result: startedReply(job) as never }
  }).catch(($, e, next) => {
    const why = next.error?.message ?? next.error?.kind ?? 'unknown failure'
    if ((e.tool as string) === FULL) return { result: format(0, { items: [], logs: [], failure: `codemode's own hook failed: ${why}`, kind: 'runner' }) }
    return next.called ? next(e) : { deny: `codemode could not check this call (${why}), so it is refused; call ${e.tool} from a ${FULL} script.` }
  })
}
