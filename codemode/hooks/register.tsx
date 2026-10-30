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
// Cut outputs kept whole on disk, newest first.
const KEEP_SPILLS = 20

const DESCRIPTION = `Run a JavaScript script that calls tools. This is the only tool that does work: every other tool (Read, Bash, Agent, AskUserQuestion, Skill, MCP tools, ...) is called from inside a script, and calling one directly is refused. Only what the script outputs reaches you, so batch independent calls with Promise.all and cut large results down before returning them.

Input \`script\` is the body of an async function: top-level await and return work. An optional first line sets limits:
// @options: {"timeout_ms": 600000, "max_output_chars": 20000}
Longer output is cut in the middle, and the cut names a file that holds all of it.

Globals:
- tools.<Name>(args): call a tool by its exact name (characters invalid in identifiers become _, e.g. tools.mcp__lean_ctx__ctx_read for mcp__lean-ctx__ctx_read). Resolves to the result text; rejects with an Error on a denied or failed call. Promise.allSettled keeps partial results.
- call(name, args): the same, but never throws: { ok, text, result, error }, result being the tool's structured output.
- text(value) and a top-level return add output items; console.log/info/warn/error(...) add lines to a <console_output> block.
- describeTool(name): async { name, description, input }, input being the tool's arguments as a TypeScript type. Far cheaper than ToolSearch. A call with bad arguments gets the type in its error too.
- ask(prompt, { model = "haiku", system, maxTokens = 1024 }?): async; one completion by another model, without tools, resolving to its text. Boil large data down with it so only the answer reaches you.
- Images and PDFs from tools arrive as markers like [image #1 image/png 12KB]; a marker in the output attaches the picture for you to see.
- ALL_TOOLS: [{ name, description }]; searchTools(query, { limit = 8 }?) ranks them (sync).
- store(key, value) / load(key): async; small JSON values kept across runs. exit(): stop successfully.
No fetch, timers, process, require or import: only tools reach the outside world.

Common arguments (ALL_TOOLS lists what this session has; describeTool gives the rest):
- Read({ file_path, offset?, limit? })   - Write({ file_path, content })
- Edit({ file_path, old_string, new_string, replace_all? })   (Read the file first)
- Bash({ command, description?, timeout?, run_in_background? })
- Agent({ description, prompt, subagent_type? })   - Skill({ skill, args? })
- AskUserQuestion({ questions: [{ question, header, multiSelect, options: [{ label, description }] }] })

Tool calls are real: a later failure undoes nothing, and calls still running when the script ends or times out are abandoned, not stopped.

Example:
const [a, b] = await Promise.all([
  tools.Read({ file_path: "/repo/src/a.ts" }),
  tools.Bash({ command: "git -C /repo status --short" }),
])
return a.split("\\n").filter(l => l.includes("export")).join("\\n") + "\\n---\\n" + b`

// The mod runtime refuses code generation, so scripts run in a Node child
// under the permission model (no network, no subprocesses, file access only to
// its run directory). The child asks for tool calls on stdout, one marked JSON
// line each, and the mod answers by writing `<run dir>/<id>.json`.
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
const show = (v) => {
  if (typeof v === 'string') return v
  if (v === undefined) return 'undefined'
  try { const s = JSON.stringify(v, null, 2); return s === undefined ? String(v) : s } catch { return String(v) }
}
const ident = (n) => n.replace(/[^A-Za-z0-9_$]/g, '_')
class Exit extends Error {}
// Frames of the runner and of Node say nothing about the script; keep its own.
const clean = (err) => {
  const stack = err && typeof err.stack === 'string' ? err.stack : ''
  if (!stack) return (err && err.message) || show(err)
  return stack.split('\n').filter((l) => !/^\s+at /.test(l) || l.includes('script.js')).join('\n')
}
async function main({ script, tools: all, dir, timeout }) {
  fs.mkdirSync(dir, { recursive: true })
  const items = [], logs = []
  let room = 1000000
  const keep = (list, s) => {
    if (room <= 0) return
    if (s.length > room) s = s.slice(0, room) + '\n…output cut at 1000000 chars…'
    room -= s.length
    list.push(s)
  }
  let finished = false
  const finish = (failure) => {
    if (finished) return
    finished = true
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
    if (failure && failure.length > 100000) failure = failure.slice(0, 100000) + '…'
    send({ done: true, items, logs, failure }, () => process.exit(0))
  }
  setTimeout(() => finish('timed out after ' + timeout + 'ms'), timeout)
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
  const resolve = (name) => names.has(String(name)) ? String(name) : byIdent.get(ident(String(name))) ?? String(name)
  const call = (name, args) => req('call', { tool: resolve(name), args: args ?? {} })
  const tools = new Proxy({}, {
    get: (_, key) => {
      if (typeof key !== 'string' || key === 'then' || key === 'toJSON') return undefined
      return async (args) => {
        const r = await call(key, args)
        if (!r.ok) throw new Error(key + ': ' + r.error)
        return r.text
      }
    },
    has: (_, key) => typeof key === 'string' && byIdent.has(key),
    ownKeys: () => [...byIdent.keys()],
    getOwnPropertyDescriptor: (_, key) => typeof key === 'string' && byIdent.has(key) ? { enumerable: true, configurable: true } : undefined,
  })
  const searchTools = (query, opts) => {
    const words = String(query).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
    return all.map((t) => {
      let score = 0
      for (const w of words) {
        if (t.name.toLowerCase().includes(w)) score += 5
        if (t.description.toLowerCase().includes(w)) score += 1
      }
      return { t, score }
    }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, (opts && opts.limit) || 8).map((x) => x.t)
  }
  const log = (...a) => { keep(logs, a.map(show).join(' ')) }
  const ctx = vm.createContext({
    tools, call, ALL_TOOLS: all, searchTools,
    text: (v) => { keep(items, show(v)) },
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
  let failure
  try {
    const fn = vm.runInContext('(async () => {"use strict";\n' + script + '\n})', ctx, { filename: 'script.js', lineOffset: -1 })
    const value = await fn()
    if (value !== undefined) keep(items, show(value))
  } catch (err) {
    if (!(err instanceof Exit)) failure = clean(err)
  }
  finish(failure)
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

// Keeps the head and the tail; `file`, when given, holds the whole output.
export const clip = (out: string, max: number, file?: string) => {
  if (out.length <= max) return out
  const half = Math.floor(max / 2)
  const note = file ? `; all of it is in ${file}` : ''
  return `${out.slice(0, half)}\n…${out.length - max} chars cut${note}…\n${out.slice(out.length - half)}`
}

// A run that worked says nothing about itself: only its output reaches the model.
export const format = (ms: number, d: { items: string[]; logs: string[]; failure?: string }) => {
  const parts: string[] = []
  if (d.items.length > 1) d.items.forEach((t, i) => parts.push(`==> text ${i + 1}/${d.items.length} <==\n${t}`))
  else parts.push(...d.items)
  if (d.logs.length) parts.push(`<console_output>\n${d.logs.join('\n')}\n</console_output>`)
  if (d.failure) parts.push(`Script failed after ${ms}ms: ${d.failure}`)
  return parts.join('\n') || '(no output)'
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

const show = (v: unknown): string => {
  if (typeof v === 'string') return v
  try {
    return JSON.stringify(v, null, 2) ?? String(v)
  } catch {
    return String(v)
  }
}

type Request = { id: number; kind: 'call' | 'describe' | 'store' | 'load' | 'ask'; payload: Record<string, unknown> }
type Done = { done: true; items: string[]; logs: string[]; failure?: string }
const KINDS = new Set(['call', 'describe', 'store', 'load', 'ask'])

// Keys `$.tool.call` reads beside a tool's arguments. `consent` would stand in
// for the user's own approval, so a script never gets to set any of them.
const RESERVED = new Set(['tool', 'tool_use_id', 'consent', 'agentId', 'requestMeta'])

const num = (v: unknown, fallback: number, min: number, max: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(Math.max(v, min), max) : fallback

let runs = 0

// Tool input types: the generated `.d.ts` files, read once, then the schemas
// that calls with bad arguments brought back.
let typeSources: string[] | undefined
const learned = new Map<string, string>()

// The Skill tool's result is only "Launching skill: x"; the engine sends the
// skill's text to the model as a separate message, which a script never sees.
// The text expanded at `skill.prompt` is kept here and handed back instead.
const skillTexts = new Map<string, string>()
const skillKey = (name: string) => name.replace(/^\//, '').split(':').pop() ?? name

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: NAME,
      description: DESCRIPTION,
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
    skillTexts.set(key, r.text)
    return r
  })

  // Only the script tool and ToolSearch stay in the prompt; every other tool
  // waits deferred and is reached from scripts.
  on('tool.describe', async ($, e, next) => {
    const r = await next(e)
    return { ...r, isDeferred: e.tool !== FULL && e.tool !== SEARCH }
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

    const script = String((e as unknown as { script?: unknown }).script ?? '')
    const { options, error } = parseOptions(script)
    if (error) return { result: format(0, { items: [], logs: [], failure: error }) }
    const timeout = num(options.timeout_ms, DEFAULT_TIMEOUT_MS, 1_000, 3_600_000)
    const maxChars = num(options.max_output_chars, DEFAULT_MAX_CHARS, 1_000, 1_000_000)

    const all = (await $.tool.list())
      .filter((t) => t.name !== FULL && t.name !== AGENTS_TOOL)
      .map((t) => ({ name: t.name, description: t.description }))
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
        if (!t) return { ok: true, value: undefined }
        if (typeSources === undefined) {
          const found: string[] = []
          for (const f of ['claude-code-tools', 'claude-code-mcp']) {
            const text = await $.fs.read(`${$.plugin.root}/.claude-plugin/types/${f}/index.d.ts`).catch(() => '')
            if (typeof text === 'string' && text) found.push(text.split('interface BuiltinToolResults')[0] ?? text)
          }
          typeSources = found
        }
        const input = typeSources.map((s) => inputType(s, t.name)).find(Boolean) ?? learned.get(t.name)
        return { ok: true, value: { ...t, input: input ?? `not known here; ToolSearch "select:${t.name}" loads its schema` } }
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
      const args = Object.fromEntries(
        Object.entries((p.args as Record<string, unknown> | null) ?? {}).filter(([k]) => !RESERVED.has(k)),
      )
      // Plugins cannot run the Agent tool; codemode-agents spawns instead.
      const target = tool === 'Agent' || tool === 'Task' ? AGENTS_TOOL : tool
      const key = skillKey(String(args.skill ?? ''))
      // Only text expanded during this call counts, not an earlier expansion.
      if (tool === 'Skill') skillTexts.delete(key)
      const r = await $.tool.call({ ...args, tool: target } as never)
      if (r.deny !== undefined) return { ok: false, error: r.deny }
      const markers: string[] = []
      const result = strip(r.result, pictures, markers)
      let text = r.text ?? show(result)
      if (tool === 'Skill' && !r.isError) {
        const body = skillTexts.get(key)
        skillTexts.delete(key)
        if (body !== undefined) text = `${text}\n\n${body}`
      }
      if (markers.length) text = [text.trim(), ...markers].filter(Boolean).join('\n')
      if (!r.isError) return { ok: true, text, result }
      const bad = tidy(tool, text)
      if (bad.type) learned.set(tool, bad.type)
      return { ok: false, error: bad.message, text: bad.message, result }
    }

    let over = false
    const writes = new Set<Promise<unknown>>()
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
        input: JSON.stringify({ script, tools: all, dir, timeout }),
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
          let m: Partial<Request & Done & { pid: number }>
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
            done = { done: true, items: m.items ?? [], logs: m.logs ?? [], failure: m.failure }
            over = true
          } else if (Number.isSafeInteger(m.id) && (m.id as number) > 0 && KINDS.has(m.kind as string) && m.payload && typeof m.payload === 'object')
            void respond(m as Request)
        }
        if (buf.length > 8_000_000) buf = ''
      }
    } catch (err) {
      stderr += `\n${(err as Error)?.message ?? String(err)}`
    }
    over = true
    watchdog.cancel()
    // A reply already being written could recreate the dir after it is removed.
    await Promise.allSettled([...writes])
    await $.process.run(['rm', '-rf', dir]).catch(() => {})
    const ended =
      done ??
      (killed
        ? { items: [], logs: [], failure: `timed out after ${timeout}ms (the script never yielded, so its runner was killed)` }
        : { items: [], logs: [], failure: `script runner exited without a result.\n${stderr.trim()}` })
    const full = format(Date.now() - started, ended)
    // A cut output is kept whole on disk, so nothing in it needs a second run.
    let file: string | undefined
    if (full.length > maxChars) {
      const spills = `${home}/.claude/codemode/out`
      const path = `${spills}/${dir.slice(root.length + 1)}.txt`
      file = await $.fs.write(path, full).then(() => path, () => undefined)
      const old = ((await $.fs.list(spills).catch(() => [])) ?? [])
        .filter((x) => x.name.endsWith('.txt'))
        .sort((a, b) => b.mtimeMs - a.mtimeMs)
        .slice(KEEP_SPILLS)
      if (old.length) await $.process.run(['rm', '-f', ...old.map((x) => `${spills}/${x.name}`)]).catch(() => {})
    }
    const out = clip(full, maxChars, file)
    // A marker the cut removed still counts: the script chose to show it.
    const blocks = attach(full, pictures)
    return { result: blocks.length ? ([{ type: 'text', text: out }, ...blocks] as never) : out }
  })
}
