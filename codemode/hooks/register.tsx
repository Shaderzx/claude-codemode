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
const DEFAULT_MAX_CHARS = 40_000

const DESCRIPTION = `Run a JavaScript script that calls tools. This is the only tool that does work: every other tool (Read, Bash, Agent, AskUserQuestion, Skill, MCP tools, ...) is called from inside a script, and calling one directly is refused. ToolSearch is the one exception, and only for loading a tool's schema so you know its arguments; the call itself still goes in a script. Only what the script outputs reaches you, so batch independent calls with Promise.all and cut large results down before returning them.

Input \`script\` is raw JavaScript, the body of an async function: top-level await and return work. An optional first line sets limits:
// @options: {"timeout_ms": 600000, "max_output_chars": 40000}

Globals:
- tools.<Name>(args): call a tool by its exact name (characters invalid in identifiers become _, e.g. tools.mcp__lean_ctx__ctx_read for mcp__lean-ctx__ctx_read). Resolves to the result text the tool would have shown you; rejects with an Error on a denied or failed call. Use Promise.allSettled to keep partial results.
- call(name, args): the same, but never throws. Resolves to { ok, text, result, error }, where result is the tool's structured output.
- text(value): add an output item (non-strings as JSON). A top-level return value is added too.
- console.log/info/warn/error(...): lines in a <console_output> block after the other output.
- ALL_TOOLS: [{ name, description }] for every tool a script can call.
- searchTools(query, { limit = 8 }?): rank ALL_TOOLS by name and description match. Sync.
- describeTool(name): async; { name, description } with the tool's full description.
- store(key, value) / load(key): async; keep small JSON values across runs.
- exit(): stop the script successfully.
Scripts have no fetch, timers, process, require or import: they reach the outside world only through tools.

Common arguments (check ALL_TOOLS for what this session has):
- Read({ file_path, offset?, limit? })   - Write({ file_path, content })
- Edit({ file_path, old_string, new_string, replace_all? })   (Read the file first)
- Bash({ command, description?, timeout?, run_in_background? })
- Agent({ description, prompt, subagent_type? })   - Skill({ skill, args? })
- AskUserQuestion({ questions: [{ question, header, multiSelect, options: [{ label, description }] }] })
For any other tool whose arguments you have not seen, load its schema first with ToolSearch ("select:<name>").

Tool calls are real and are not undone when a later line fails. Calls still running when the script ends or times out are abandoned, not stopped.

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
    store: async (key, value) => { const r = await req('store', { key: String(key), value }); if (!r.ok) throw new Error('store: ' + r.error) },
    load: async (key) => (await req('load', { key: String(key) })).value,
    exit: () => { throw new Exit() },
  })
  let failure
  try {
    const fn = vm.runInContext('(async () => {"use strict";\n' + script + '\n})', ctx, { filename: 'script.js' })
    const value = await fn()
    if (value !== undefined) keep(items, show(value))
  } catch (err) {
    if (!(err instanceof Exit)) failure = (err && (err.stack || err.message)) || show(err)
  }
  finish(failure)
}
`

type Options = { timeout_ms?: number; max_output_chars?: number }

export const parseOptions = (script: string): { options: Options; error?: string } => {
  const lines = script.split('\n')
  const at = lines.findIndex((l) => /^\s*\/\/\s*@options:/.test(l))
  if (at > 0) return { options: {}, error: 'The // @options: line must be the first line of the script.' }
  if (at === -1) return { options: {} }
  try {
    const options: unknown = JSON.parse((lines[0] ?? '').trim().replace(/^\/\/\s*@options:/, '').trim())
    if (!options || typeof options !== 'object' || Array.isArray(options))
      return { options: {}, error: 'The // @options: line must hold a JSON object.' }
    return { options: options as Options }
  } catch (err) {
    return { options: {}, error: `Bad // @options: JSON: ${(err as Error).message}` }
  }
}

export const clip = (out: string, max: number) =>
  out.length <= max
    ? out
    : `${out.slice(0, Math.floor(max / 2))}\n…${out.length - max} chars truncated…\n${out.slice(out.length - Math.floor(max / 2))}`

export const format = (ms: number, d: { items: string[]; logs: string[]; failure?: string }) => {
  const parts = [`Script ${d.failure ? 'failed' : 'completed'} in ${ms}ms`]
  if (d.items.length > 1) d.items.forEach((t, i) => parts.push(`==> text ${i + 1}/${d.items.length} <==\n${t}`))
  else parts.push(...d.items)
  if (d.logs.length) parts.push(`<console_output>\n${d.logs.join('\n')}\n</console_output>`)
  if (d.failure) parts.push(`Script error: ${d.failure}`)
  return parts.join('\n')
}

const ident = (name: string) => name.replace(/[^A-Za-z0-9_$]/g, '_')

const show = (v: unknown): string => {
  if (typeof v === 'string') return v
  try {
    return JSON.stringify(v, null, 2) ?? String(v)
  } catch {
    return String(v)
  }
}

type Request = { id: number; kind: 'call' | 'describe' | 'store' | 'load'; payload: Record<string, unknown> }
type Done = { done: true; items: string[]; logs: string[]; failure?: string }
const KINDS = new Set(['call', 'describe', 'store', 'load'])

// Keys `$.tool.call` reads beside a tool's arguments. `consent` would stand in
// for the user's own approval, so a script never gets to set any of them.
const RESERVED = new Set(['tool', 'tool_use_id', 'consent', 'agentId', 'requestMeta'])

const num = (v: unknown, fallback: number, min: number, max: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(Math.max(v, min), max) : fallback

let runs = 0

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
        return { ok: true, value: t ? { ...t, schema: `load it with ToolSearch "select:${t.name}"` } : undefined }
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
      let text = r.text ?? show(r.result)
      if (tool === 'Skill' && !r.isError) {
        const body = skillTexts.get(key)
        skillTexts.delete(key)
        if (body !== undefined) text = `${text}\n\n${body}`
      }
      return r.isError ? { ok: false, error: text, text, result: r.result } : { ok: true, text, result: r.result }
    }

    let over = false
    const writes = new Set<Promise<unknown>>()
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
        argv: ['node', '--permission', `--allow-fs-read=${dir}`, `--allow-fs-write=${dir}`, '-e', RUNNER],
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
    const result =
      done ??
      (killed
        ? { items: [], logs: [], failure: `timed out after ${timeout}ms (the script never yielded, so its runner was killed)` }
        : { items: [], logs: [], failure: `script runner exited without a result.\n${stderr.trim()}` })
    return { result: clip(format(Date.now() - started, result), maxChars) }
  })
}
