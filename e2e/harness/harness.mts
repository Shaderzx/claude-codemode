// Runs codemode's real mod source under Node with a stand-in for Claude Code's $:
// real files, a real Node runner child, real shell commands, and tools that behave
// the way the week of logs showed (Read's token limit, ctx_shell's 8 KB limit, a
// hook that denies Bash, an MCP server that rejects bad arguments).
// Usage: node harness.mts <case.json>   prints one JSON object.
import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

type Case = {
  tools?: string[]
  denied?: string[]
  home?: string
  cwd?: string
  env?: Record<string, string>
  store?: Record<string, unknown>
  steps: Step[]
  abortAfterMs?: number
  mcpFlaky?: number
}
type Step = { script?: string; direct?: { tool: string; args: Record<string, unknown> }; search?: string; describe?: string; newSession?: boolean }

const root = join(import.meta.dirname, '..', '..')
const c: Case = JSON.parse(readFileSync(process.argv[2] as string, 'utf8'))
const work = mkdtempSync(join(tmpdir(), 'codemode-mod-'))
copyFileSync(join(root, 'codemode/hooks/register.tsx'), join(work, 'register.mts'))
const mod = await import(join(work, 'register.mts'))

const home = c.home ?? mkdtempSync(join(tmpdir(), 'codemode-home-'))
const cwd = c.cwd ?? home
const store: Record<string, unknown> = { ...(c.store ?? {}) }
const calls: { tool: string; args: Record<string, unknown> }[] = []
let flaky = c.mcpFlaky ?? 0

const DESCRIPTIONS: Record<string, string> = {
  Read: 'Reads a file from the local filesystem.',
  Bash: 'Executes a given bash command.',
  Write: 'Writes a file to the local filesystem.',
  Edit: 'Performs exact string replacements in files.',
  Skill: 'Execute a skill within the main conversation.',
  ToolSearch: 'Fetches full schema definitions for deferred tools.',
  'mcp__lean-ctx__ctx_shell': 'Run a shell command with compressed output.',
  'mcp__lean-ctx__ctx_patch': 'Safe file edit.',
  'mcp__t3-code__thread_note': 'Adds a note to a thread.',
}
const names = c.tools ?? ['Read', 'Bash', 'Write', 'Edit', 'Skill', 'ToolSearch', 'mcp__lean-ctx__ctx_shell', 'mcp__lean-ctx__ctx_patch', 'mcp__t3-code__thread_note']
const NOTE_SCHEMA = { type: 'object', properties: { threadId: { type: 'string' }, note: { type: 'string' } }, required: ['threadId', 'note'] }

const err = (text: string) => ({ isError: true, text, result: text })
const ok = (text: string, result: unknown = text) => ({ text, result })

const numbered = (lines: string[], from: number) => lines.map((l, i) => String(from + i).padStart(6) + '\t' + l).join('\n')

const shell = (command: string) => {
  const r = spawnSync('bash', ['-c', command], { cwd, encoding: 'utf8', env: { ...process.env, HOME: home } })
  return { code: r.status ?? 1, out: (r.stdout ?? '') + (r.stderr ?? '') }
}

const fake = async (tool: string, a: Record<string, unknown>) => {
  calls.push({ tool, args: a })
  if ((c.denied ?? []).includes(tool))
    return err('PreToolUse:' + tool + ' hook error: [DENIED] Native Shell blocked. Use: ctx_shell(command="<command>") — lean-ctx replace mode is active.')
  if (!names.includes(tool)) throw new Error('codemode: $.tool.call: no tool named "' + tool + '" in this session')
  switch (tool) {
    case 'Read': {
      const p = String(a.file_path ?? '')
      if (!p.startsWith('/') || !existsSync(p)) return err('File does not exist. Note: your current working directory is ' + cwd + '.')
      const text = readFileSync(p, 'utf8')
      const lines = text.split('\n')
      if (text.endsWith('\n')) lines.pop()
      const offset = typeof a.offset === 'number' ? a.offset : 1
      const limit = typeof a.limit === 'number' ? a.limit : 2000
      const part = lines.slice(offset - 1, offset - 1 + limit)
      const tokens = Math.ceil(part.join('\n').length / 4)
      if (tokens > 25000)
        return err('File content (' + tokens + ' tokens) exceeds maximum allowed tokens (25000). Use offset and limit parameters to read specific portions of the file, or search for specific content instead of reading the whole file.')
      return ok(numbered(part, offset))
    }
    case 'Write': {
      writeFileSync(String(a.file_path), String(a.content))
      return ok('File created successfully at: ' + a.file_path)
    }
    case 'Edit': {
      const p = String(a.file_path)
      const s = readFileSync(p, 'utf8')
      if (!s.includes(String(a.old_string))) return err('String to replace not found in file.')
      writeFileSync(p, s.replace(String(a.old_string), () => String(a.new_string)))
      return ok('The file ' + p + ' has been updated.')
    }
    case 'Bash':
    case 'mcp__lean-ctx__ctx_shell': {
      const command = String(a.command ?? '')
      if (tool !== 'Bash' && Buffer.byteLength(command) > 8192)
        return err('ERROR: Command too large (' + Buffer.byteLength(command) + ' bytes, limit 8192). If you\'re writing file content, use the native Write/Edit tool instead. ctx_shell is for reading command output only (git, cargo, npm, etc.).')
      const r = shell(command)
      if (tool === 'Bash') return r.code ? err(r.out + '\nExit code ' + r.code) : ok(r.out)
      return r.code ? err(r.out + '\n[exit:' + r.code + ']') : ok(r.out || '(' + tool + ' completed with no output)')
    }
    case 'mcp__lean-ctx__ctx_patch': {
      const p = String(a.path)
      if (a.op === 'create') {
        if (existsSync(p)) return err('ERROR: ' + p + ' already exists — create is for new files only. Use anchored ops')
        mkdirSync(dirname(p), { recursive: true })
        writeFileSync(p, String(a.new_text ?? ''))
        return ok('created ' + p)
      }
      if (a.op === 'replace_unique') {
        const s = readFileSync(p, 'utf8')
        const old = String(a.old_text ?? '')
        const n = s.split(old).length - 1
        if (n !== 1) return err('ERROR: old_string ' + (n ? 'found ' + n + ' times' : 'not found') + ' in ' + p)
        writeFileSync(p, s.replace(old, () => String(a.new_text ?? '')))
        return ok('patched ' + p)
      }
      return err("missing 'op'")
    }
    case 'mcp__t3-code__thread_note': {
      if (flaky > 0) {
        flaky--
        throw new Error('MCP error -32000: Connection closed')
      }
      if (typeof a.threadId !== 'string') return err("Invalid parameters for tool 'thread_note': Expected string")
      return ok('noted on ' + a.threadId, { structuredContent: { noted: true, threadId: a.threadId } })
    }
    case 'ToolSearch': {
      const q = String(a.query ?? '')
      if (q.includes('thread_note'))
        return ok('<functions>\n<function>' + JSON.stringify({ description: DESCRIPTIONS['mcp__t3-code__thread_note'], name: 'mcp__t3-code__thread_note', parameters: NOTE_SCHEMA }) + '</function>\n</functions>')
      return ok('No matching deferred tools found')
    }
    case 'Skill':
      return ok('Launching skill: ' + a.skill)
  }
  return err('unhandled tool ' + tool)
}

const handlers: Record<string, (...x: unknown[]) => Promise<unknown>> = {}
mod.register((name: string, h: (...x: unknown[]) => Promise<unknown>) => {
  handlers[name] = h
  return { catch: () => {} }
})

const registered: Record<string, unknown>[] = []
let started = Date.now()
const $ = {
  plugin: { root: join(root, 'codemode') },
  tool: {
    list: async () => names.map((n) => ({ name: n, description: DESCRIPTIONS[n] ?? n, mcp: n.startsWith('mcp__') })),
    register: async (d: Record<string, unknown>) => {
      registered.push(d)
      return { tool: 'mcp__codemode__' + d.name }
    },
    call: async (args: Record<string, unknown>) => {
      const { tool, ...rest } = args
      return fake(String(tool), rest)
    },
  },
  env: { get: async (k: string) => ({ HOME: home, CODEMODE_NODE: process.execPath, PWD: cwd, ...(c.env ?? {}) } as Record<string, string>)[k] },
  fs: {
    write: async (p: string, t: string) => {
      mkdirSync(dirname(p), { recursive: true })
      writeFileSync(p, t)
      return p
    },
    read: async (p: string) => readFileSync(p, 'utf8'),
    list: async (p: string) => readdirSync(p).map((n) => ({ name: n, mtimeMs: statSync(join(p, n)).mtimeMs })),
    exists: async (p: string) => existsSync(p),
  },
  process: {
    spawn: ({ argv, input }: { argv: string[]; input?: string }) => {
      const child = spawn(argv[0] as string, argv.slice(1), { stdio: ['pipe', 'pipe', 'pipe'] })
      child.stdin.end(input ?? '')
      const queue: { stream: string; text: string }[] = []
      let wake: (() => void) | undefined
      let ended = false
      child.stdout.setEncoding('utf8').on('data', (t: string) => { queue.push({ stream: 'stdout', text: t }); wake?.() })
      child.stderr.setEncoding('utf8').on('data', (t: string) => { queue.push({ stream: 'stderr', text: t }); wake?.() })
      child.on('close', () => { ended = true; wake?.() })
      const abortAt = c.abortAfterMs === undefined ? undefined : started + c.abortAfterMs
      return (async function* () {
        while (true) {
          if (abortAt !== undefined && Date.now() >= abortAt) {
            child.kill('SIGKILL')
            throw new Error('codemode: $.process.spawn(node) aborted')
          }
          const piece = queue.shift()
          if (piece) { yield piece; continue }
          if (ended) return
          await new Promise<void>((r) => { wake = r; setTimeout(r, 20) })
          wake = undefined
        }
      })()
    },
    run: async (argv: string[]) => {
      const r = spawnSync(argv[0] as string, argv.slice(1), { encoding: 'utf8' })
      return { exitCode: r.status ?? 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
    },
  },
  clock: {
    after: (ms: number, fn: () => void) => {
      const h = setTimeout(fn, ms)
      return { cancel: () => clearTimeout(h) }
    },
  },
  store: {
    get: async (k: string) => store[k],
    set: async (k: string, v: unknown) => { store[k] = v },
    delete: async (k: string) => { delete store[k] },
  },
  session: { version: async () => ({ version: '2.1.325' }) },
  model: { complete: async (r: { model: string; prompt: string }) => ({ isAnswered: true, text: 'answer from ' + r.model + ' to: ' + r.prompt.slice(0, 60) }) },
}

const engine = (f: (e: Record<string, unknown>) => Promise<unknown>) => Object.assign(f, { origin: { plugin: 'engine' } })
const flatten = (r: unknown): { text: string; attachments: number } => {
  const v = (r as { result?: unknown })?.result ?? (r as { deny?: string })?.deny ?? r
  if (typeof v === 'string') return { text: v, attachments: 0 }
  if (Array.isArray(v)) return { text: v.filter((b) => b?.type === 'text').map((b) => b.text).join('\n'), attachments: v.filter((b) => b?.type !== 'text').length }
  return { text: JSON.stringify(v), attachments: 0 }
}

const out: { description?: string; results: { text: string; attachments: number; ms: number }[]; calls: typeof calls; store: typeof store } = { results: [], calls, store }
const startSession = async () => {
  registered.length = 0
  await handlers['session.start']?.($, { cwd }, engine(async () => ({})))
  out.description = String(registered.at(-1)?.description ?? '')
}
await startSession()
for (const s of c.steps) {
  started = Date.now()
  if (s.newSession) { await startSession(); continue }
  if (s.script !== undefined) {
    const r = await handlers['tool.call']?.($, { tool: 'mcp__codemode__run', script: s.script }, engine(async () => ({})))
    out.results.push({ ...flatten(r), ms: Date.now() - started })
  } else if (s.direct) {
    const r = await handlers['tool.call']?.($, { tool: s.direct.tool, ...s.direct.args }, engine(async (e) => fake(String(e.tool), s.direct!.args)))
    out.results.push({ ...flatten(r), ms: Date.now() - started })
  } else if (s.search !== undefined) {
    const r = await handlers['tool.call']?.($, { tool: 'ToolSearch', query: s.search }, engine(async () => fake('ToolSearch', { query: s.search })))
    out.results.push({ ...flatten(r), ms: Date.now() - started })
  } else if (s.describe !== undefined) {
    const r = await handlers['tool.describe']?.($, { tool: s.describe }, engine(async () => ({ description: DESCRIPTIONS[s.describe!] ?? s.describe, isDeferred: true })))
    out.results.push({ text: String((r as { description?: string })?.description ?? ''), attachments: 0, ms: 0 })
  }
}
rmSync(work, { recursive: true, force: true })
process.stdout.write(JSON.stringify(out), () => process.exit(0))
