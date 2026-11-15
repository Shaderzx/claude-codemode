import type { Register } from 'claude-code'

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
// A tool a hook denied is remembered this long, then tried as new again.
const DENIED_MS = 14 * 86_400_000

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

// The run tool's description for a session whose tools are `names`; an empty
// set (the engine had no list yet) describes every common tool. `denied` holds the
// tools a hook refused in an earlier session, with what replaces each.
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
  const example = has('Read')
    ? 'const [a, b] = await Promise.all([\n  read("/repo/src/a.ts"),\n  sh("git -C /repo log --oneline -5"),\n])\nconst imports = a.split("\\n").filter((l) => l.includes("import"))\nreturn { imports: imports.join("\\n"), log: b }'
    : has('Bash')
      ? 'const [log, st] = await Promise.all([\n  sh("git -C /repo log --oneline -5"),\n  sh("git -C /repo status --short"),\n])\nreturn { log, st }'
      : 'const [a, b] = await Promise.all([tools.X({ ... }), tools.Y({ ... })])\nreturn { a, b: b.slice(0, 2000) }'
  return [
    'Run a JavaScript script that calls tools. It is the only tool that does work: every other tool is called from inside a script, and a direct call is refused. Only what the script outputs reaches you.',
    '',
    'Each run is a round trip that re-sends the whole conversation, so do a whole step in one script: start every call you can already name at once with Promise.all, and chain the steps that need no judgment in between (search, then read the hits, then filter) inside the script. Return when the next step needs your judgment, with only what you need.',
    '',
    '`script` is the body of an async function: top-level await and return work. An optional first line sets limits:',
    '// @options: {"timeout_ms": 600000, "max_output_chars": 20000}',
    'Longer output is cut, each item keeping a share, and the cut names a file that holds all of it.',
    'Text holding ${, backticks or # (shell, Python, HTML) goes in a raw block, never in a template literal: a line // @text NAME, the text, then a line // @end; the script reads it as TEXT.NAME.',
    '',
    'Globals:',
    '- sh(cmd) runs a command on the session\'s shell (Bash or what replaces it) and resolves to its text, with .exitCode and .ok; a non-zero exit does not throw. quote(s) makes s one safe shell word.',
    '- read(path) is a file\'s whole text without line numbers; write(path, text) and edit(path, old, new) go through Write/Edit or the session\'s patch tool. Relative paths start at the session folder.',
    '- waitFor(check, { every = 1000, timeout }) calls check until it returns something truthy, and returns that; deadline() is the ms left before the run times out.',
    '- tools.<Name>(args): call a tool by its exact name (characters invalid in identifiers become _: tools.mcp__lean_ctx__ctx_read for mcp__lean-ctx__ctx_read; a unique suffix such as tools.ctx_read works too). Resolves to the result text; rejects on a denied or failed call.',
    '- call(name, args): the same, but never throws: { ok, text, result, error, exitCode? }, result being the structured output; String(r) is its text. Promise.allSettled also keeps partial results.',
    '- A returned value and text(value) add output items (an object holding multi-line strings prints them raw, one heading per key); console.log/warn/error add lines to a <console_output> block.',
    '- describeTool(name): async { name, description, input }, input being the arguments as a TypeScript type when known. A built-in tool called with bad arguments answers with its type.',
    '- ask(prompt, { model = "haiku", system, maxTokens = 1024 }?): one completion by another model, without tools; boil large data down with it so only the answer reaches you.',
    '- Images and PDFs arrive as markers like [image #1 image/png 12KB]; a marker in the output attaches the picture for you to see.',
    '- ALL_TOOLS: [{ name, description }] (first sentences); searchTools(query, { limit = 8 }?) ranks them.',
    '- store(key, value) / load(key): small JSON values kept across runs. exit(): stop successfully. btoa, atob, TextEncoder, TextDecoder and Buffer work.',
    'No fetch, timers, process, require or import: only tools reach the outside world.',
    '',
    'Common arguments:',
    ...common,
    ...(missing.length ? [`Not in this session: ${missing.join(', ')}. searchTools() finds other tools.`] : []),
    ...(refused.length ? [`${refused.join(', ')}: denied by a hook here.`] : []),
    '',
    'Tool calls are real: a later failure undoes nothing, and calls still running when the script ends or times out are abandoned, not stopped.',
    '',
    'Example:',
    example,
  ].join('\n')
}

// The mod runtime refuses code generation, so scripts run in a Node child
// under the permission model (no network, no subprocesses, file access only to
// its run directory). The child asks for tool calls on stdout, one marked JSON
// line each, and the mod answers by writing `<run dir>/<id>.json`. Its output
// (text, returns, console lines) goes out the same way as it is made.
// `vm` is not a boundary: a script can reach the child's `process` through
// any host function it is given. The permission model is the boundary, so the
// child drops its environment and reports its pid before the script starts.
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
send({ pid: process.pid })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const thenable = (v) => {
  try { return v !== null && (typeof v === 'object' || typeof v === 'function') && typeof v.then === 'function' } catch { return false }
}
const NOT_AWAITED = '[Promise: not awaited; put await before the call]'
const tag = (v) => { try { return Object.prototype.toString.call(v) } catch { return '' } }
const errText = (e) => { try { return (e.name || 'Error') + ': ' + e.message } catch { return 'Error' } }
// Values JSON drops or garbles print as what they are: an unawaited call, an Error's message.
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
const ident = (n) => n.replace(/[^A-Za-z0-9_$]/g, '_')
class Exit extends Error {}
// Globals scripts reach for that do not exist here, and what to use instead.
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
  }
  // A shell variable in braces inside a template literal: JS reads it as its own variable.
  else if (missing && typeof script === 'string' && script.includes(DB + missing[1])) lines.push(TEMPLATE)
  return lines.join('\n')
}
// A script that does not parse: its message, the lines around it, and the usual cause.
const syntax = (err, script) => {
  const m = /script\.js:(\d+)/.exec(String(err && err.stack))
  const n = m ? +m[1] : 0
  const lines = script.split('\n')
  const out = [errText(err) + (n ? ' (script line ' + n + ')' : '')]
  if (n) for (let i = Math.max(1, n - 2); i <= Math.min(lines.length, n + 2); i++) out.push((i === n ? '> ' : '  ') + String(i).padStart(4) + ' | ' + String(lines[i - 1]).slice(0, 300))
  const msg = String(err && err.message)
  if (script.includes(BT) && (script.includes(DB) || /template|Unexpected|Invalid or unexpected|Missing \}/.test(msg))) out.push(TEMPLATE)
  if (/Private field '#/.test(msg)) out.push('Hint: a line starting with # (a shell or Python comment) reached JS code; JS comments start with //, and other languages belong in a // @text block.')
  if (/import statement|Cannot use import/.test(msg)) out.push('Hint: scripts have no modules; use the globals the run tool lists and tools.<Name>().')
  return out.join('\n')
}
const quote = (s) => "'" + String(s).split("'").join("'\\''") + "'"
const DEDUP = /\[unchanged [^\]\n]*read-dedup\]|Unchanged since your last Read/
async function main({ script, tools: all, dir, timeout, texts, cwd, home, denied: deniedList }) {
  fs.mkdirSync(dir, { recursive: true })
  const started = Date.now()
  // Output goes to the mod as it is made, so an abort or a kill keeps what was printed.
  let room = 1000000
  const keep = (out, s) => {
    if (room <= 0) return
    if (s.length > room) s = s.slice(0, room) + '\n…output cut at 1000000 chars…'
    room -= s.length
    send({ out, text: s })
  }
  let finished = false
  const finish = (failure, kind) => {
    if (finished) return
    finished = true
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
    if (failure && failure.length > 100000) failure = failure.slice(0, 100000) + '…'
    send({ done: true, failure, kind }, () => process.exit(0))
  }
  setTimeout(() => finish('timed out after ' + timeout + 'ms', 'timeout'), timeout)
  let seq = 0
  const req = async (kind, payload) => {
    const id = ++seq
    // The mod drops a line this long, which would leave the call waiting forever.
    if (JSON.stringify(payload).length > 7000000) return { ok: false, error: 'The request is too large to pass to the mod.' }
    send({ id, kind, payload })
    const file = dir + '/' + id + '.json'
    for (let wait = 1; ; wait = Math.min(wait * 2, 25)) {
      await sleep(wait)
      let res
      try { res = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { continue }
      try { fs.unlinkSync(file) } catch {}
      return res
    }
  }
  const byIdent = new Map(all.map((t) => [ident(t.name), t.name]))
  const names = new Set(all.map((t) => t.name))
  const denied = new Set(deniedList || [])
  // An exact name, its identifier form, or the one tool whose name ends in it (ctx_shell).
  const resolve = (name) => {
    const n = String(name)
    if (names.has(n)) return n
    const byId = byIdent.get(ident(n))
    if (byId) return byId
    const tail = all.filter((t) => t.name.endsWith('__' + n) || ident(t.name).endsWith('__' + ident(n)))
    return tail.length === 1 ? tail[0].name : n
  }
  const toolError = (message) => {
    const e = new Error(message)
    e.codemodeTool = true
    return e
  }
  // String(r) and template text of a call() result are its text.
  const textual = (r) => {
    const s = () => (r.ok ? String(r.text ?? '') : 'Error: ' + r.error)
    try {
      Object.defineProperty(r, 'toString', { value: s, enumerable: false })
      Object.defineProperty(r, Symbol.toPrimitive, { value: (hint) => (hint === 'number' ? NaN : s()), enumerable: false })
    } catch {}
    return r
  }
  const call = async (name, args) => textual(await req('call', { tool: resolve(name), args: args ?? {} }))
  const tools = new Proxy({}, {
    get: (_, key) => {
      if (typeof key !== 'string' || key === 'then' || key === 'toJSON') return undefined
      return async (args) => {
        const r = await req('call', { tool: resolve(key), args: args ?? {} })
        if (!r.ok) throw toolError(key + ': ' + r.error)
        return r.text
      }
    },
    has: (_, key) => typeof key === 'string' && byIdent.has(key),
    ownKeys: () => [...byIdent.keys()],
    getOwnPropertyDescriptor: (_, key) => typeof key === 'string' && byIdent.has(key) ? { enumerable: true, configurable: true } : undefined,
  })
  const abs = (p) => {
    const s = String(p)
    if (s.startsWith('/')) return s
    if (s === '~' || s.startsWith('~/')) return home ? home + s.slice(1) : s
    return cwd ? cwd.replace(/\/$/, '') + '/' + s.replace(/^\.\//, '') : s
  }
  const usable = (n) => names.has(n) && !denied.has(n)
  const named = (re) => all.map((t) => t.name).filter((n) => re.test(n) && !denied.has(n))
  // The session's shells, best first: Bash, then a replacement such as ctx_shell.
  const shells = () => [...(usable('Bash') ? ['Bash'] : []), ...named(/(?:^|_)shell$/i).filter((n) => n !== 'Bash')]
  const patcher = () => named(/(?:^|_)patch$/i)[0]
  const shResult = (text, code, tool) => Object.assign(new String(text), { exitCode: code, ok: code === 0, tool })
  // A command longer than the shell tool takes goes to a scratch file in pieces,
  // each one a visible printf the tool's own checks see, and then runs from there.
  const CHUNK = 1500
  let pieces = 0
  const chunked = async (tool, cmd, extra) => {
    const f = '/tmp/codemode-sh-' + started.toString(36) + '-' + (++pieces) + '.sh'
    for (let i = 0; i < cmd.length;) {
      let j = Math.min(cmd.length, i + CHUNK)
      if (j < cmd.length && /[\uD800-\uDBFF]/.test(cmd[j - 1])) j--
      const r = await req('call', { tool, args: { command: 'printf %s ' + quote(cmd.slice(i, j)) + (i ? ' >> ' : ' > ') + f } })
      if (!r.ok) throw toolError('sh: writing the long command to ' + f + ' failed: ' + r.error)
      i = j
    }
    return run(tool, 'bash ' + f + '; rc=$?; rm -f ' + f + '; exit $rc', extra, false)
  }
  const LIMIT = 7000
  const run = async (tool, cmd, extra, mayChunk) => {
    if (mayChunk && tool !== 'Bash' && Buffer.byteLength(cmd) > LIMIT) return chunked(tool, cmd, extra)
    const r = await req('call', { tool, args: { ...extra, command: cmd } })
    if (r.denied) return r
    if (!r.ok && mayChunk && /too large|too long/i.test(String(r.error))) return chunked(tool, cmd, extra)
    if (r.ok || typeof r.exitCode === 'number') return shResult(r.shellText ?? (r.ok ? r.text : r.error), typeof r.exitCode === 'number' ? r.exitCode : 0, tool)
    throw toolError('sh: ' + tool + ': ' + r.error)
  }
  const sh = async (command, opts) => {
    const extra = opts && typeof opts === 'object' ? { ...opts } : {}
    let last
    for (const tool of shells()) {
      const r = await run(tool, String(command), extra, true)
      if (!r || !r.denied) return r
      denied.add(tool)
      last = r
    }
    throw toolError('sh: ' + (last ? 'every shell tool was denied: ' + last.error : 'this session has no shell tool (no Bash, nothing named *shell)'))
  }
  // A file's text without Read's line numbers, all of it: pages of 2000 lines,
  // halved while a page is over the model's limit.
  const read = async (path) => {
    if (!names.has('Read')) throw toolError('read: this session has no Read tool')
    const file = abs(path)
    const rows = []
    let offset = 1
    let limit = 2000
    let stubbed = 0
    for (;;) {
      // A stub read() handles itself is no news for the output.
      const r = await req('call', { tool: 'Read', args: { file_path: file, offset, limit }, handled: true })
      if (!r.ok) {
        if (/exceeds maximum allowed/i.test(String(r.error)) && limit > 25) { limit = Math.floor(limit / 2); continue }
        throw toolError('read: ' + r.error)
      }
      const t = String(r.text)
      // A hook's stub for a read it has seen before (lean-ctx's read-dedup) is not the file:
      // the same lines asked for as a slightly different range come back whole.
      if (DEDUP.test(t)) {
        if (++stubbed > 3) throw toolError('read: Read keeps answering with a stub, not the file: ' + t.slice(0, 200))
        limit = Math.max(1, limit - 1)
        continue
      }
      const got = t.split('\n').filter((l) => /^\s*\d+\t/.test(l)).map((l) => l.replace(/^\s*\d+\t/, ''))
      rows.push(...got)
      if (got.length < limit) break
      offset += got.length
    }
    // Read shows a final newline as one last, empty line, so the rows joined are the file.
    return rows.join('\n')
  }
  const write = async (path, content) => {
    const file = abs(path)
    const body = String(content)
    if (usable('Write')) {
      let r = await req('call', { tool: 'Write', args: { file_path: file, content: body } })
      if (!r.ok && /read it first|has not been read/i.test(String(r.error))) {
        await req('call', { tool: 'Read', args: { file_path: file, limit: 1 } })
        r = await req('call', { tool: 'Write', args: { file_path: file, content: body } })
      }
      if (r.ok) return 'wrote ' + file
      if (!r.denied) throw toolError('write: ' + r.error)
      denied.add('Write')
    }
    const patch = patcher()
    if (!patch) throw toolError('write: this session has no Write tool and no patch tool')
    let r = await req('call', { tool: patch, args: { op: 'create', path: file, new_text: body } })
    if (r.ok) return 'wrote ' + file
    if (!/exist/i.test(String(r.error))) throw toolError('write: ' + r.error)
    // An existing file: its whole text is unique, so one exact replacement swaps it.
    const now = await read(file)
    for (const old of [now, now.replace(/\n$/, '')]) {
      if (!old) continue
      r = await req('call', { tool: patch, args: { op: 'replace_unique', path: file, old_text: old, new_text: body } })
      if (r.ok) return 'wrote ' + file
    }
    throw toolError('write: ' + r.error)
  }
  const edit = async (path, from, to) => {
    const file = abs(path)
    if (usable('Edit')) {
      // Claude Code's Edit needs the file read in this session first.
      if (names.has('Read')) await req('call', { tool: 'Read', args: { file_path: file, limit: 1 } })
      const r = await req('call', { tool: 'Edit', args: { file_path: file, old_string: String(from), new_string: String(to) } })
      if (r.ok) return 'edited ' + file
      if (!r.denied) throw toolError('edit: ' + r.error)
      denied.add('Edit')
    }
    const patch = patcher()
    if (!patch) throw toolError('edit: this session has no Edit tool and no patch tool')
    const r = await req('call', { tool: patch, args: { op: 'replace_unique', path: file, old_text: String(from), new_text: String(to) } })
    if (r.ok) return 'edited ' + file
    throw toolError('edit: ' + r.error)
  }
  const deadline = () => Math.max(0, started + timeout - Date.now())
  const waitFor = async (check, opts) => {
    const o = opts && typeof opts === 'object' ? opts : {}
    const every = Math.max(10, Number(o.every) || 1000)
    const limit = Number.isFinite(o.timeout) ? Math.max(0, o.timeout) : Math.max(0, deadline() - 1000)
    const t0 = Date.now()
    for (;;) {
      const v = await check()
      if (v) return v
      if (Date.now() - t0 + every > limit) throw new Error('waitFor timed out after ' + limit + 'ms; the check last returned ' + show(v))
      await sleep(every)
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
  const ctx = vm.createContext({
    tools, call, ALL_TOOLS: listed, searchTools,
    TEXT: Object.freeze({ ...(texts || {}) }),
    sh, quote, read, write, edit, waitFor, deadline,
    btoa, atob, TextEncoder, TextDecoder, Buffer,
    text: (v) => { keep('item', show(v)) },
    console: { log, info: log, warn: log, error: log, debug: log },
    describeTool: async (name) => (await req('describe', { tool: resolve(name) })).value,
    ask: async (prompt, opts) => {
      const o = opts && typeof opts === 'object' ? opts : {}
      const r = await req('ask', { prompt: String(prompt), model: o.model, system: o.system, maxTokens: o.maxTokens, effort: o.effort })
      if (!r.ok) throw new Error('ask: ' + r.error)
      return r.text
    },
    store: async (key, value) => { const r = await req('store', { key: String(key), value }); if (!r.ok) throw new Error('store: ' + r.error) },
    load: async (key) => (await req('load', { key: String(key) })).value,
    exit: () => { throw new Exit() },
  })
  // JSON.parse of text that is not JSON (a compressed stub, an error) says what the text was.
  vm.runInContext('(() => { const parse = JSON.parse; JSON.parse = function (text, reviver) { try { return parse.call(JSON, text, reviver) } catch (e) { const s = String(text); throw new SyntaxError(e.message + " (the text starts: " + JSON.stringify(s.slice(0, 60)) + (s.length > 60 ? "…" : "") + ")") } } })()', ctx, { filename: 'codemode-prelude.js' })
  let fn
  try {
    fn = vm.runInContext('(async () => {"use strict";\n' + script + '\n})', ctx, { filename: 'script.js', lineOffset: -1 })
  } catch (err) {
    finish(syntax(err, script), 'syntax')
    return
  }
  let failure
  let kind
  try {
    const value = await fn()
    if (value !== undefined) keep('item', show(value))
  } catch (err) {
    if (!(err instanceof Exit)) {
      failure = clean(err, script)
      kind = err && err.codemodeTool ? 'tool' : 'script'
    }
  }
  finish(failure, kind)
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

// Raw text blocks: the lines between "// @text NAME" and "// @end" become TEXT.NAME
// and are never parsed as JS, so shell, Python and HTML need no escaping. Each line
// of a block is left blank, so the script's line numbers stay those the model wrote.
export const extractText = (script: string): { script: string; texts: Record<string, string>; error?: string } => {
  const lines = script.split('\n')
  const texts: Record<string, string> = {}
  let name: string | undefined
  let start = 0
  let body: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i] as string
    if (name === undefined) {
      const m = /^\s*\/\/\s*@text\s+([A-Za-z_$][\w$]*)\s*$/.exec(l)
      if (!m) continue
      name = m[1] as string
      start = i
      body = []
      lines[i] = ''
    } else if (/^\s*\/\/\s*@end\s*$/.test(l)) {
      texts[name] = body.join('\n')
      lines[i] = ''
      name = undefined
    } else {
      body.push(l)
      lines[i] = ''
    }
  }
  if (name !== undefined) return { script, texts: {}, error: `the // @text ${name} block that starts on line ${start + 1} has no // @end line` }
  return { script: lines.join('\n'), texts }
}

// Keeps the head and the tail; `file`, when given, holds the whole output.
export const clip = (out: string, max: number, file?: string) => {
  if (out.length <= max) return out
  const half = Math.floor(max / 2)
  const end = out.length - half
  // The cut's line numbers let the next run read back only the part it needs.
  const line = (at: number) => {
    let n = 1
    for (let i = out.indexOf('\n'); i >= 0 && i < at; i = out.indexOf('\n', i + 1)) n++
    return n
  }
  // A trailing newline ends the last line; it does not start another.
  const where = `lines ${line(half)}-${line(end - 1)} of ${line(out.endsWith('\n') ? out.length - 1 : out.length)}`
  const note = file ? `; all of it is in ${file}, so read back only the lines you need` : ''
  return `${out.slice(0, half)}\n…${out.length - max} chars cut (${where})${note}…\n${out.slice(end)}`
}

export type Ended = { items: string[]; logs: string[]; failure?: string; kind?: string; notes?: string[] }

// The output's parts, in order: each item (an object's keys each their own part),
// the console block, notes, and the failure with its kind. A cut gives each part a share.
export const sections = (ms: number, d: Ended): string[] => {
  const parts: string[] = []
  d.items.forEach((t, i) => {
    const head = d.items.length > 1 ? `==> text ${i + 1}/${d.items.length} <==\n` : ''
    const keys = t.startsWith('== ') ? t.split(/\n(?=== [^\n]* ==\n)/) : [t]
    keys.forEach((k, j) => parts.push(j === 0 ? head + k : k))
  })
  if (d.logs.length) parts.push(`<console_output>\n${d.logs.join('\n')}\n</console_output>`)
  parts.push(...(d.notes ?? []))
  if (d.failure)
    parts.push(
      d.kind === 'aborted' ? `Script stopped after ${ms}ms [aborted]: ${d.failure}` : `Script failed after ${ms}ms [${d.kind ?? 'script'}]: ${d.failure}`,
    )
  return parts.length ? parts : ['(no output)']
}

// A run that worked says nothing about itself: only its output reaches the model.
export const format = (ms: number, d: Ended) => sections(ms, d).join('\n')

const ERRORISH = /\b(?:error|errors|fatal|failed|failure|exception|traceback|panic|denied|refused)\b/i
const countLines = (s: string) => {
  let n = 0
  for (let i = s.indexOf('\n'); i >= 0; i = s.indexOf('\n', i + 1)) n++
  return n
}

// One part cut to about `budget` chars: its head and tail on line ends, the lines
// that look like errors kept from the middle, and a ready Read call for the rest.
export const cutPart = (s: string, budget: number, firstLine: number, file?: string) => {
  const half = Math.max(1, Math.floor(budget / 2))
  let a = half
  const ha = s.lastIndexOf('\n', half - 1) + 1
  if (ha > half / 2) a = ha
  let b = s.length - half
  const tb = s.indexOf('\n', b - 1) + 1
  if (tb > 0 && tb - b < half / 2) b = tb
  if (b <= a) return s
  const gone = s.slice(a, b)
  const from = firstLine + countLines(s.slice(0, a))
  const to = Math.max(from, firstLine + countLines(s.slice(0, b)) - (s[b - 1] === '\n' ? 1 : 0))
  const back = file ? `; read them back with tools.Read({ file_path: ${JSON.stringify(file)}, offset: ${from}, limit: ${to - from + 1} })` : ''
  const errs = gone
    .split('\n')
    .filter((l) => ERRORISH.test(l))
    .slice(0, 8)
    .map((l) => (l.length > 300 ? `${l.slice(0, 300)}…` : l))
  const kept = errs.length ? `\n…lines kept from the cut:\n${errs.join('\n')}` : ''
  const glue = a > 0 && s[a - 1] !== '\n' ? '\n' : ''
  return `${s.slice(0, a)}${glue}…${gone.length} chars cut (lines ${from}-${to})${back}…${kept}\n${s.slice(b)}`
}

// Fits the parts into about `max` chars: the small ones whole, the others an even
// share of what is left. `file` holds the whole output, so each cut says where.
export const fit = (parts: string[], max: number, file?: string): string => {
  const full = parts.join('\n')
  if (full.length <= max) return full
  const NOTE = 220
  const budget = parts.map(() => 0)
  let left = max
  const order = parts.map((p, i) => [p.length, i] as const).sort((x, y) => x[0] - y[0])
  order.forEach(([len, i], k) => {
    const share = Math.floor(left / (order.length - k))
    budget[i] = Math.min(len, share)
    left -= budget[i] as number
  })
  let line = 1
  return parts
    .map((p, i) => {
      const at = line
      line += countLines(p) + 1
      const room = budget[i] as number
      return p.length <= room ? p : cutPart(p, Math.max(200, room - NOTE), at, file)
    })
    .join('\n')
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

type Tally = { ok: number; failed: number; open: number; arg?: string }

// What a run had called by the time it failed: those side effects stand, and
// the next run should not repeat them blind.
export const ledger = (calls: Map<string, Tally>): string =>
  [...calls]
    .map(([n, t]) => {
      const parts = [t.ok ? `${t.ok} ok` : '', t.failed ? `${t.failed} failed${t.arg ? ` (${t.arg})` : ''}` : '', t.open ? `${t.open} still running (may still finish)` : '']
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

type Request = { id: number; kind: 'call' | 'describe' | 'store' | 'load' | 'ask'; payload: Record<string, unknown> }
type Done = { done: true; failure?: string; kind?: string }
const KINDS = new Set(['call', 'describe', 'store', 'load', 'ask'])

// Keys `$.tool.call` reads beside a tool's arguments. `consent` would stand in
// for the user's own approval, so a script never gets to set any of them.
const RESERVED = new Set(['tool', 'tool_use_id', 'consent', 'agentId', 'requestMeta'])

const num = (v: unknown, fallback: number, min: number, max: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(Math.max(v, min), max) : fallback

let runs = 0
// The session's folder (relative paths start there), the tools a hook refused
// with what replaces each, and the last run that failed.
let sessionCwd: string | undefined
const deniedTools = new Map<string, string | undefined>()
let lastFailed: { script: string; first: string; at: number } | undefined

const SHELL_RE = /^Bash$|(?:^|_)shell$/i
const DENY_RE = /\[DENIED\]|hook (?:error|denied)[^\n]*(?:denied|blocked)/i
const STUB_RE = /^\s*\[(?:Firewalled \S+ output|lean-ctx gateway: content withheld|untrusted input: tool_output overflow)|stored out-of-band|\[unchanged [^\]\n]*read-dedup\]/

// The argument a failed or running call is known by: its command, path or query.
export const firstArg = (args: Record<string, unknown>): string | undefined => {
  const keys = ['command', 'file_path', 'path', 'query', 'url', 'pattern', 'skill', 'prompt']
  const key = keys.find((k) => typeof args[k] === 'string')
  const v = key ? (args[key] as string) : Object.values(args).find((x) => typeof x === 'string')
  if (typeof v !== 'string') return undefined
  // A path is known by its end, anything else by its start.
  if (v.length <= 80) return JSON.stringify(v)
  return JSON.stringify(key === 'file_path' || key === 'path' ? `…${v.slice(-79)}` : `${v.slice(0, 79)}…`)
}

export const absolute = (p: string, cwd?: string, home?: string) => {
  if (p.startsWith('/')) return p
  if ((p === '~' || p.startsWith('~/')) && home) return home + p.slice(1)
  return cwd ? `${cwd.replace(/\/$/, '')}/${p.replace(/^\.\//, '')}` : p
}

// A shell result's exit code and its output without the marker that carried it:
// Bash's "Exit code N", lean-ctx's "[exit:N]". A result that worked exited 0.
export const exitOf = (text: string, worked: boolean): { code?: number; out: string } => {
  for (const re of [/\n?\[exit:(\d+)[^\]\n]*\]\s*$/, /(?:^|\n)Exit code (\d+)\s*$/, /^Exit code (\d+)(?:\n|$)/]) {
    const m = re.exec(text)
    if (m) return { code: Number(m[1]), out: text.slice(0, m.index) + text.slice(m.index + m[0].length) }
  }
  return worked ? { code: 0, out: text } : { out: text }
}

// CODEMODE_TOOL_DEFAULTS: {"tool name": {default arguments}}; a script's own arguments win.
export const toolDefaults = (raw: string | undefined): Record<string, Record<string, unknown>> => {
  if (!raw) return {}
  try {
    const v: unknown = JSON.parse(raw)
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .filter(([, d]) => d && typeof d === 'object' && !Array.isArray(d))
        .map(([t, d]) => [t, Object.fromEntries(Object.entries(d as Record<string, unknown>).filter(([k]) => !RESERVED.has(k)))]),
    )
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

// Up to three names in a folder close to the one that was not there.
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

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    // The session's own tools pick the description's argument lines; a list the
    // engine cannot give yet leaves the full description.
    const names = new Set(await $.tool.list().then((l) => l.map((t) => t.name), () => [] as string[]))
    const cwd = (e as { cwd?: unknown }).cwd
    if (typeof cwd === 'string' && cwd) sessionCwd = cwd
    // Tools a hook refused in an earlier session are named as denied, with their replacement.
    const kept = (await $.store.get('denied').catch(() => undefined)) as Record<string, { alt?: string; at?: number }> | undefined
    for (const [n, v] of Object.entries(kept ?? {})) if (v && Date.now() - Number(v.at ?? 0) < DENIED_MS) deniedTools.set(n, v.alt)
    await $.tool.register({
      name: NAME,
      description: describeRun(names, deniedTools),
      isDeferred: false,
      inputSchema: {
        type: 'object',
        properties: { script: { type: 'string', description: 'JavaScript source (async function body).' } },
        required: ['script'],
      },
    })
    return next(e)
  })

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
    const { options, error } = parseOptions(raw)
    if (error) return { result: format(0, { items: [], logs: [], failure: error, kind: 'syntax' }) }
    const pre = extractText(raw)
    if (pre.error) return { result: format(0, { items: [], logs: [], failure: pre.error, kind: 'syntax' }) }
    const script = pre.script
    const timeout = num(options.timeout_ms, DEFAULT_TIMEOUT_MS, 1_000, 3_600_000)
    const maxChars = num(options.max_output_chars, DEFAULT_MAX_CHARS, 1_000, 1_000_000)

    const listing = (await $.tool.list()).filter((t) => t.name !== FULL && t.name !== AGENTS_TOOL)
    const all = listing.map((t) => ({ name: t.name, description: t.description }))
    const isMcp = new Set(listing.filter((t) => (t as { mcp?: boolean }).mcp ?? t.name.startsWith('mcp__')).map((t) => t.name))
    // Every tool call this run made, so a failure can say what already ran.
    const calls = new Map<string, Tally>()
    // Calls still running, for a timeout to name; tools whose result was a compressed stub.
    const open = new Map<number, { tool: string; arg?: string; at: number }>()
    const stubs = new Set<string>()
    let deduped = false
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
    const home = (await $.env.get('HOME')) ?? '/tmp'
    // A host whose own node is older than 25 points this at a newer one.
    const node = (await $.env.get('CODEMODE_NODE')) || 'node'
    const root = `${home}/.claude/codemode/runs`
    const dir = `${root}/${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}-${++runs}`

    const handle = async (m: Request): Promise<Record<string, unknown>> => {
      const p = m.payload
      if (m.kind === 'store') {
        const key = `script:${String(p.key)}`
        if (p.value === undefined) await $.store.delete(key)
        else await $.store.set(key, p.value as never)
        return { ok: true }
      }
      if (m.kind === 'load') return { ok: true, value: await $.store.get(`script:${String(p.key)}`) }
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
      if (tool === 'Read' && typeof args.file_path === 'string') args.file_path = absolute(args.file_path, cwd, home)
      // Plugins cannot run the Agent tool; codemode-agents spawns instead.
      const target = tool === 'Agent' || tool === 'Task' ? AGENTS_TOOL : tool
      const key = skillKey(String(args.skill ?? ''))
      // Calls to one skill take turns, so each gets its own expansion (its args may
      // differ); only text expanded after this call started counts.
      const timer: { handle?: { cancel: () => unknown } } = {}
      const release =
        tool === 'Skill' ? await skillTurn(key, new Promise((r) => (timer.handle = $.clock.after(60_000, () => r(undefined))))) : undefined
      timer.handle?.cancel()
      if (tool === 'Skill' && !release)
        return { ok: false, error: `An earlier Skill call for ${key} is still running after 60 s, so this one did not start; call it again once that one is done.` }
      const since = skillSeq
      const tally = calls.get(tool) ?? { ok: 0, failed: 0, open: 0 }
      calls.set(tool, tally)
      tally.open++
      open.set(m.id, { tool, arg: firstArg(args), at: Date.now() })
      let r = await $.tool.call({ ...args, tool: target } as never).catch((err: unknown) => {
        open.delete(m.id)
        tally.open--
        tally.failed++
        tally.arg ??= firstArg(args)
        release?.()
        const msg = (err as Error)?.message ?? String(err)
        // A tool a setting or another mod removed: name what may replace it.
        const near = msg.includes('no tool named') ? similar(tool, all.map((x) => x.name)) : []
        throw new Error(near.length ? `${msg}; similar: ${near.join(', ')}` : msg)
      })
      open.delete(m.id)
      const body = release ? skillTexts.get(key) : undefined
      release?.()
      // A file over the model's limit is read in pages here: the script, not the model, takes the text.
      if (tool === 'Read' && r.isError && args.offset === undefined && args.limit === undefined && /exceeds maximum allowed (?:tokens|size)/i.test(String(r.text ?? show(r.result)))) {
        const paged = await pageRead(args)
        if (paged !== undefined) r = { result: paged, text: paged } as typeof r
      }
      tally.open--
      if (r.deny !== undefined || r.isError) {
        tally.failed++
        tally.arg ??= firstArg(args)
      } else tally.ok++
      // A hook that refuses a tool is remembered, and the refusal names what replaces it.
      const said = String(r.deny ?? (r.isError ? (r.text ?? show(r.result)) : ''))
      if ((r.deny !== undefined || r.isError) && DENY_RE.test(said)) {
        const alt = similar(tool, all.map((x) => x.name)).find((n) => !deniedTools.has(n))
        if (!deniedTools.has(tool)) {
          deniedTools.set(tool, alt)
          const saved = Object.fromEntries([...deniedTools].map(([n, a]) => [n, { alt: a, at: Date.now() }]))
          await $.store.set('denied', saved as never).catch(() => {})
        }
        const plain = said.replace(/^<tool_use_error>/, '').replace(/<\/tool_use_error>$/, '')
        return { ok: false, error: `${plain}\n${tool} is denied by a hook in this session${alt ? `; use tools.${ident(alt)}({...}) instead` : ''}.`, denied: true }
      }
      if (r.deny !== undefined) return { ok: false, error: r.deny }
      const markers: string[] = []
      const result = strip(r.result, pictures, markers)
      let text = r.text ?? show(result)
      if (tool === 'Skill' && !r.isError) {
        if (body && body.seq > since) text = `${text}\n\n${body.text}`
      }
      if (markers.length) text = [text.trim(), ...markers].filter(Boolean).join('\n')
      const shell = SHELL_RE.test(tool) ? exitOf(text, !r.isError) : undefined
      const exit = shell ? { ...(shell.code === undefined ? {} : { exitCode: shell.code }), shellText: shell.out } : {}
      if (!r.isError) {
        if (STUB_RE.test(text) && p.handled !== true) {
          stubs.add(tool)
          if (/read-dedup/.test(text)) deduped = true
        }
        return { ok: true, text, result, ...exit }
      }
      const bad = tidy(tool, text)
      // A path that is not there: the names in its folder that come close.
      if (tool === 'Read' && /File does not exist/i.test(bad.message) && typeof args.file_path === 'string' && args.file_path.startsWith('/')) {
        const at = args.file_path.lastIndexOf('/')
        const folder = args.file_path.slice(0, at) || '/'
        const listed = ((await $.fs.list(folder).catch(() => [])) ?? []).map((x) => x.name)
        const near = nearNames(args.file_path.slice(at + 1), listed).map((n) => `${folder === '/' ? '' : folder}/${n}`)
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
      return { ok: false, error: bad.message, text: bad.message, result, ...exit }
    }

    // Read in pages of 2000 lines, halved while a page is still over the limit;
    // undefined when a page fails for another reason.
    const pageRead = async (args: Record<string, unknown>): Promise<string | undefined> => {
      const pages: string[] = []
      let offset = 1
      let limit = 2000
      for (let guard = 0; guard < 10_000; guard++) {
        const r = await $.tool.call({ ...args, offset, limit, tool: 'Read' } as never).catch(() => undefined)
        if (!r) return undefined
        const t = String(r.text ?? show(r.result))
        if (r.isError) {
          if (/exceeds maximum allowed/i.test(t) && limit > 25) {
            limit = Math.floor(limit / 2)
            continue
          }
          return undefined
        }
        const rows = t.split('\n').filter((l) => /^\s*\d+\t/.test(l))
        if (rows.length) pages.push(rows.join('\n'))
        if (rows.length < limit) break
        offset += rows.length
      }
      return pages.join('\n')
    }

    let over = false
    const writes = new Set<Promise<unknown>>()
    // Every reply still being made, so a failed run can let its last calls settle.
    const replies = new Set<Promise<unknown>>()
    const items: string[] = []
    const logs: string[] = []
    let aborted = false
    const pictures: Picture[] = []
    const respond = async (m: Request) => {
      let out: Record<string, unknown>
      try {
        out = await handle(m)
      } catch (err) {
        out = { ok: false, error: (err as Error)?.message ?? String(err) }
      }
      // The child is gone after a timeout; writing would recreate its run dir.
      if (over) return
      const file = `${dir}/${m.id}.json`
      // Tracked whole, fallbacks included, so the run dir is removed only after it.
      const reply = (async () => {
        try {
          await $.fs.write(file, JSON.stringify(out))
        } catch {
          // Over the 4 MiB write limit, or a result that is not JSON: keep the text.
          const slim = { ok: out.ok, error: out.error, text: typeof out.text === 'string' ? clip(out.text, 1_000_000) : undefined }
          await $.fs.write(file, JSON.stringify(slim)).catch(() =>
            $.fs.write(file, JSON.stringify({ ok: false, error: 'The tool result was too large to pass to the script.' })).catch(() => {}),
          )
        }
      })()
      writes.add(reply)
      await reply
    }

    // The child may only touch its own run dir, so it has to exist before the child starts.
    await $.fs.write(`${dir}/.keep`, '')

    const started = Date.now()
    let done: Done | undefined
    let stderr = ''
    let buf = ''
    let pid: number | undefined
    let killed = false
    // The child's own timer cannot fire while a script spins synchronously, so
    // the mod kills it a little after the deadline.
    const watchdog = $.clock.after(timeout + 5_000, () => {
      killed = true
      if (pid) void $.process.run(['kill', '-9', String(pid)]).catch(() => {})
    })
    try {
      const child = $.process.spawn({
        argv: [node, '--permission', `--allow-fs-read=${dir}`, `--allow-fs-write=${dir}`, '-e', RUNNER],
        input: JSON.stringify({ script, tools: all, dir, timeout, texts: pre.texts, cwd, home, denied: [...deniedTools.keys()] }),
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
          let m: Partial<Request & Done & { pid: number; out: string; text: string }>
          try {
            m = JSON.parse(line.slice(3))
          } catch {
            continue
          }
          // The pid is the runner's first line, before any script code runs.
          if (pid === undefined) {
            pid = Number.isSafeInteger(m.pid) && (m.pid as number) > 1 ? m.pid : 0
            if (killed && pid) void $.process.run(['kill', '-9', String(pid)]).catch(() => {})
            continue
          }
          if (m.done === true) {
            done = { done: true, failure: m.failure, kind: m.kind }
            over = true
          } else if ((m.out === 'item' || m.out === 'log') && typeof m.text === 'string') (m.out === 'item' ? items : logs).push(m.text)
          else if (Number.isSafeInteger(m.id) && (m.id as number) > 0 && KINDS.has(m.kind as string) && m.payload && typeof m.payload === 'object') {
            const reply = respond(m as Request)
            replies.add(reply)
            void reply.finally(() => replies.delete(reply))
          }
        }
        if (buf.length > 8_000_000) buf = ''
      }
    } catch (err) {
      const msg = (err as Error)?.message ?? String(err)
      // The session stopped the run (an interrupt, a cancelled turn): not a crash.
      if (/abort/i.test(msg)) aborted = true
      else stderr += `\n${msg}`
    }
    // A run that failed on its own lets calls it started settle for a moment, so
    // the ledger says what really happened to them.
    if (done?.failure && done.kind !== 'timeout' && open.size)
      await Promise.race([Promise.allSettled([...replies]), new Promise((r) => $.clock.after(1_500, () => r(undefined)))])
    over = true
    watchdog.cancel()
    // A reply already being written could recreate the dir after it is removed.
    await Promise.allSettled([...writes])
    await $.process.run(['rm', '-rf', dir]).catch(() => {})
    let ended: Ended = done
      ? { items, logs, failure: done.failure, kind: done.kind }
      : aborted
        ? { items, logs, kind: 'aborted', failure: 'the run was interrupted before it finished (the session stopped it); what it printed is above, and its tool calls may have run.' }
        : killed
          ? { items, logs, kind: 'timeout', failure: `timed out after ${timeout}ms (the script never yielded, so its runner was killed)` }
          : { items, logs, kind: 'runner', failure: `script runner exited without a result.\n${stderr.trim()}` }
    const first = ended.failure?.split('\n')[0] ?? ''
    if (ended.failure && ended.kind === 'timeout' && open.size) {
      const now = Date.now()
      const still = [...open.values()].map((o) => `${o.tool} (${((now - o.at) / 1000).toFixed(1)}s${o.arg ? `, ${o.arg}` : ''})`)
      ended = { ...ended, failure: `${ended.failure}\nstill running when it timed out (abandoned, not stopped: they may still finish, so do not repeat them blind): ${still.join('; ')}` }
    }
    if (stubs.size)
      ended = {
        ...ended,
        notes: [
          `Note: a result from ${[...stubs].join(', ')} was a compressed stub, not the tool's full text; ${deduped ? 'read(path) gets a whole file past a repeated-read stub, and ' : ''}call the tool with raw: true, or set CODEMODE_TOOL_DEFAULTS, to get the full text.`,
        ],
      }
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
    const succeeded = [...calls.values()].reduce((n, t) => n + t.ok, 0)
    if (ended.failure && ended.kind === 'tool' && succeeded > 0)
      ended = {
        ...ended,
        failure: `${ended.failure}\n${succeeded} other call${succeeded === 1 ? '' : 's'} had succeeded; their results are lost with this failure: use call(), which never throws, or Promise.allSettled to keep them.`,
      }
    // The same script failing again gets told so, with how long ago the first one failed.
    if (ended.failure) {
      if (lastFailed?.script === raw)
        ended = {
          ...ended,
          failure: `${ended.failure}\nThis is the same script as a run that failed ${Math.round((Date.now() - lastFailed.at) / 1000)}s ago${lastFailed.first === first ? ' with the same error' : ''}: change the script, not just run it again.`,
        }
      lastFailed = { script: raw, first, at: Date.now() }
    } else lastFailed = undefined
    const parts = sections(Date.now() - started, ended)
    const full = parts.join('\n')
    // A cut output is kept whole on disk, so nothing in it needs a second run.
    let file: string | undefined
    if (full.length > maxChars) {
      const spills = `${home}/.claude/codemode/out`
      const path = `${spills}/${dir.slice(root.length + 1)}.txt`
      file = await $.fs.write(path, full).then(() => path, () => undefined)
      const old = ((await $.fs.list(spills).catch(() => [])) ?? [])
        .filter((x) => x.name.endsWith('.txt'))
        .sort((a, b) => b.mtimeMs - a.mtimeMs)
        .filter((x, i) => i >= KEEP_SPILLS || Date.now() - x.mtimeMs > SPILL_AGE_MS)
      if (old.length) await $.process.run(['rm', '-f', ...old.map((x) => `${spills}/${x.name}`)]).catch(() => {})
    }
    const out = fit(parts, maxChars, file)
    // A marker the cut removed still counts: the script chose to show it.
    const blocks = attach(full, pictures)
    return { result: blocks.length ? ([{ type: 'text', text: out }, ...blocks] as never) : out }
  })
}
