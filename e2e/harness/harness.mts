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
  dedupReads?: boolean
  deniedCommands?: string[]
  deniedMessage?: string
  readRewrite?: string
  denyReadFrom?: number
  rewriteFromOffset?: string
  compressShell?: boolean
  denyReadPaths?: string[]
  deniedShellCommands?: string[]
  hugePageAt?: number
  persistBash?: boolean
  deniedWriteMessage?: string
  deniedCreateMessage?: string
  pageErrorAt?: number
  truncateLimited?: boolean
  abortStyle?: string
  engineForgets?: boolean
  changeAfterPage?: number
  readDelayMs?: number
  listThrows?: boolean
}
type Step = { compact?: boolean; script?: string; direct?: { tool: string; args: Record<string, unknown> }; search?: string; describe?: string; newSession?: boolean; setDenied?: string[]; setCwd?: string }

const root = join(import.meta.dirname, '..', '..')
const c: Case = JSON.parse(readFileSync(process.argv[2] as string, 'utf8'))
const work = mkdtempSync(join(tmpdir(), 'codemode-mod-'))
copyFileSync(join(root, 'codemode/hooks/register.tsx'), join(work, 'register.mts'))
const mod = await import(join(work, 'register.mts'))

const home = c.home ?? mkdtempSync(join(tmpdir(), 'codemode-home-'))
let cwd = c.cwd ?? home
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
  'mcp__aaa-ssh__remote_shell': 'Runs a command on a remote host.',
  'mcp__other__git_patch': 'Applies a git patch.',
  'mcp__t3-code__big_report': 'Returns a big report.',
}
const names = c.tools ?? ['Read', 'Bash', 'Write', 'Edit', 'Skill', 'ToolSearch', 'mcp__lean-ctx__ctx_shell', 'mcp__lean-ctx__ctx_patch', 'mcp__t3-code__thread_note']
const NOTE_SCHEMA = { type: 'object', properties: { threadId: { type: 'string' }, note: { type: 'string' } }, required: ['threadId', 'note'] }

const err = (text: string) => ({ isError: true, text, result: text })
const ok = (text: string, result: unknown = text) => ({ text, result })

const readTimes = new Map<string, number>()
let bashCwd = ''
const writePath = (raw: unknown) => {
  const p = String(raw ?? '').trim()
  if (p === '~' || p.startsWith('~/')) return home + p.slice(1)
  return p.startsWith('/') ? p : join(bashCwd || cwd, p)
}
const numbered = (lines: string[], from: number) => lines.map((l, i) => String(from + i) + '\t' + l).join('\n')
const seen = new Map<string, number>()

const shell = (command: string, keepCwd = false) =>
  new Promise<{ code: number; out: string }>((done) => {
    const marker = join(home, '.bash-cwd')
    const run = keepCwd ? command + '\n__cm_rc=$?; pwd > ' + JSON.stringify(marker) + '; exit $__cm_rc' : command
    const p = spawn('bash', ['-c', run], { cwd: keepCwd ? bashCwd || cwd : cwd, env: { ...process.env, HOME: home } })
    if (keepCwd) p.on('close', () => { try { bashCwd = readFileSync(marker, 'utf8').trim() } catch {} })
    let out = ''
    p.stdout.setEncoding('utf8').on('data', (t: string) => { out += t })
    p.stderr.setEncoding('utf8').on('data', (t: string) => { out += t })
    p.on('close', (code) => done({ code: code ?? 1, out }))
  })

const fake = async (tool: string, a: Record<string, unknown>) => {
  calls.push({ tool, args: a })
  if (tool === 'Bash' && (c.deniedCommands ?? []).some((d) => String(a.command ?? '').includes(d)))
    return err(c.deniedMessage ?? 'PreToolUse:Bash hook error: blocked: this command is not allowed here')
  if ((c.denied ?? []).includes(tool))
    return err('PreToolUse:' + tool + ' hook error: [DENIED] Native Shell blocked. Use: ctx_shell(command="<command>") — lean-ctx replace mode is active.')
  if (!names.includes(tool)) throw new Error('codemode: $.tool.call: no tool named "' + tool + '" in this session')
  switch (tool) {
    case 'Read': {
      if (c.readDelayMs) await new Promise((r) => setTimeout(r, c.readDelayMs))
      if ((c.denyReadPaths ?? []).some((d) => String(a.file_path ?? '').endsWith(d))) return { deny: 'Permission to read ' + String(a.file_path) + ' has been denied.' }
      if (c.readRewrite !== undefined) return ok(c.readRewrite)
      if (c.denyReadFrom !== undefined && Number(a.offset ?? 1) >= c.denyReadFrom) return { deny: 'Read of this range is denied by policy' }
      if (c.rewriteFromOffset !== undefined && Number(a.offset ?? 1) > 1) return ok(c.rewriteFromOffset)
      const p = String(a.file_path ?? '').trim()
      if (!p.startsWith('/') || !existsSync(p)) return err('File does not exist. Note: your current working directory is ' + cwd + '.')
      const text = readFileSync(p, 'utf8')
      if (!text) return ok('<system-reminder>Warning: the file exists but the contents are empty.</system-reminder>')
      const lines = text.split('\n').map((l) => l.replace(/\r$/, ''))
      const key = p + ':' + String(a.offset) + ':' + String(a.limit)
      if (c.dedupReads && seen.get(key) === statSync(p).mtimeMs)
        return ok('1\t' + p + ' [unchanged ' + lines.length + 'L · lean-ctx read-dedup]\n2\tUnchanged since your last Read in this session — the full line-numbered content is already in this conversation above.')
      const offset = typeof a.offset === 'number' ? a.offset : 1
      const limit = typeof a.limit === 'number' ? a.limit : lines.length
      if (offset > lines.length) return ok('<system-reminder>Warning: the file exists but is shorter than the provided offset (' + offset + '). The file has ' + lines.length + ' lines.</system-reminder>')
      if (typeof a.limit === 'number' && c.pageErrorAt === offset) return err('EACCES: permission denied, open ' + p)
      if (a.limit === undefined && statSync(p).size > 256 * 1024)
        return err('File content (' + Math.round(statSync(p).size / 1024) + 'KB) exceeds maximum allowed size (256KB). Use offset and limit parameters to read specific portions of the file, or search for specific content instead of reading the whole file.')
      if (c.hugePageAt === offset) return ok(numbered(['\\'.repeat(1_200_000), '\\'.repeat(1_200_000)], offset))
      let part = lines.slice(offset - 1, offset - 1 + limit)
      const tokens = Math.ceil(part.join('\n').length / 4)
      let cut = false
      if (tokens > 25000) {
        if (typeof a.limit === 'number' && !c.truncateLimited)
          return err('File content (' + tokens + ' tokens) exceeds maximum allowed tokens (25000). Use offset and limit parameters to read specific portions of the file, or search for specific content instead of reading the whole file.')
        let n = 0
        for (let size = 0; n < part.length && Math.ceil((size + (part[n] as string).length + 1) / 4) <= 25000; n++) size += (part[n] as string).length + 1
        part = n ? part.slice(0, n) : [(part[0] as string).slice(0, 100000)]
        cut = true
      }
      seen.set(key, statSync(p).mtimeMs)
      readTimes.set(p, statSync(p).mtimeMs)
      if (typeof a.limit === 'number' && c.changeAfterPage === offset) writeFileSync(p, text + 'changed meanwhile\n')
      return ok(numbered(part, offset), { type: 'text', file: { filePath: p, content: part.join('\n'), numLines: part.length, startLine: offset, totalLines: lines.length, ...(cut ? { truncatedByTokenCap: true } : {}) } })
    }
    case 'Write': {
      if (c.deniedWriteMessage !== undefined) return err(c.deniedWriteMessage)
      const w = writePath(a.file_path)
      if (!c.engineForgets && existsSync(w) && readTimes.has(w) && statSync(w).mtimeMs !== readTimes.get(w)) return err('<tool_use_error>File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.</tool_use_error>')
      writeFileSync(w, String(a.content))
      readTimes.set(w, statSync(w).mtimeMs)
      return ok('File created successfully at: ' + a.file_path)
    }
    case 'Edit': {
      const p = writePath(a.file_path)
      if (c.deniedWriteMessage !== undefined) return err(c.deniedWriteMessage)
      if (!c.engineForgets && existsSync(p) && readTimes.has(p) && statSync(p).mtimeMs !== readTimes.get(p)) return err('<tool_use_error>File content has changed since it was last read. Read it again before attempting to edit it.</tool_use_error>')
      const s = readFileSync(p, 'utf8')
      const n = s.split(String(a.old_string)).length - 1
      if (!n) return err('String to replace not found in file.')
      if (n > 1 && a.replace_all !== true) return err('Found ' + n + ' matches of the string to replace, but replace_all is false.')
      writeFileSync(p, a.replace_all === true ? s.split(String(a.old_string)).join(String(a.new_string)) : s.replace(String(a.old_string), () => String(a.new_string)))
      readTimes.set(p, statSync(p).mtimeMs)
      return ok('The file ' + p + ' has been updated.')
    }
    case 'Bash':
    case 'mcp__lean-ctx__ctx_shell': {
      const command = String(a.command ?? '')
      if (tool !== 'Bash' && (c.deniedShellCommands ?? []).some((d) => command.includes(d)))
        return err('PreToolUse:' + tool + ' hook error: blocked: this command is not allowed here')
      if (tool === 'Bash' && a.run_in_background === true) {
        spawn('bash', ['-c', command], { cwd, detached: true, stdio: 'ignore' }).unref()
        return ok('Command running in background with ID: bg1. Output is being written to: /tmp/bg1.output')
      }
      if (tool !== 'Bash' && Buffer.byteLength(command) > 8192)
        return err('ERROR: Command too large (' + Buffer.byteLength(command) + ' bytes, limit 8192). If you\'re writing file content, use the native Write/Edit tool instead. ctx_shell is for reading command output only (git, cargo, npm, etc.).')
      if (tool === 'Bash' && typeof a.timeout === 'number') {
        const limit = a.timeout
        const raced = await Promise.race([shell(command, true), new Promise<undefined>((r) => setTimeout(() => r(undefined), limit))])
        if (raced === undefined)
          return ok('Command did not complete within its ' + Math.round(limit / 1000) + 's timeout and was moved to the background (ID: bg2). Output is being written to: /tmp/bg2.output', { backgroundTaskId: 'bg2', timedOutAfterMs: limit })
        return raced.code ? err('<tool_use_error>Exit code ' + raced.code + '\n' + raced.out + '</tool_use_error>') : ok(raced.out)
      }
      const r = await shell(command, tool === 'Bash')
      if (tool !== 'Bash' && c.compressShell && a.raw !== true) return ok('[Firewalled ' + tool + ' output — ' + r.out.length + ' chars, stored out-of-band]')
      if (tool === 'Bash' && c.persistBash && r.out.length > 30000) {
        const saved = join(c.env?.CLAUDE_CONFIG_DIR ?? join(home, '.claude'), 'projects', 'p', 's', 'tool-results', 'toolu_' + calls.length + '.txt')
        mkdirSync(dirname(saved), { recursive: true })
        writeFileSync(saved, r.out)
        r.out = '<persisted-output>\nOutput too large (' + (r.out.length / 1024).toFixed(1) + 'KB). Full output saved to: ' + saved + '\n\nPreview (first 2KB):\n' + r.out.slice(0, 2000) + '\n</persisted-output>'
      }
      if (tool === 'Bash') return r.code ? err('<tool_use_error>Exit code ' + r.code + '\n' + r.out + '</tool_use_error>') : ok(r.out)
      return r.code ? err(r.out + '\n[exit:' + r.code + ']') : ok(r.out || '(' + tool + ' completed with no output)')
    }
    case 'mcp__lean-ctx__ctx_patch': {
      const p = String(a.path)
      if (a.op === 'create' && c.deniedCreateMessage !== undefined) return err(c.deniedCreateMessage)
      if (a.op === 'create') {
        if (existsSync(dirname(p)) && !statSync(dirname(p)).isDirectory()) return err('ERROR: parent directory does not exist for ' + p)
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
      if (a.op === 'replace_all') {
        const s = readFileSync(p, 'utf8')
        const old = String(a.old_text ?? '')
        const n = s.split(old).length - 1
        if (!n) return err('ERROR: old_text not found in ' + p)
        writeFileSync(p, s.split(old).join(String(a.new_text ?? '')))
        return ok('Replaced ' + n + ' occurrence(s) in ' + p)
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
    case 'mcp__t3-code__big_report':
      return ok('x'.repeat(2_100_000), { structuredContent: { data: 'y'.repeat(2_100_000) } })
    case 'mcp__other__git_patch':
      return err('git_patch must never be chosen by write() or edit()')
    case 'mcp__aaa-ssh__remote_shell':
      return err('remote_shell must never be chosen by sh()')
  }
  return err('unhandled tool ' + tool)
}

const hooks: Record<string, (...x: unknown[]) => Promise<unknown>> = {}
const catches: Record<string, (...x: unknown[]) => Promise<unknown>> = {}
mod.register((name: string, h: (...x: unknown[]) => Promise<unknown>) => {
  hooks[name] = h
  return { catch: (f: (...x: unknown[]) => Promise<unknown>) => { catches[name] = f } }
})
const handlers: Record<string, (...x: unknown[]) => Promise<unknown>> = Object.fromEntries(
  Object.keys(hooks).map((name) => [
    name,
    async (...x: unknown[]) => {
      const [$, e, next] = x as [unknown, unknown, (y: unknown) => Promise<unknown>]
      try {
        return await hooks[name]!($, e, next)
      } catch (error) {
        const f = catches[name]
        if (!f) throw error
        return f($, e, Object.assign((y: unknown) => next(y), next, { error: { kind: 'throw', message: String((error as Error)?.message ?? error) }, called: false }))
      }
    },
  ]),
)
let listing = true

const registered: Record<string, unknown>[] = []
let started = Date.now()
const $ = {
  plugin: { root: join(root, 'codemode') },
  tool: {
    list: async () => {
      if (!listing) throw new Error('$.tool.list failed')
      return names.map((n) => ({ name: n, description: DESCRIPTIONS[n] ?? n, mcp: n.startsWith('mcp__') }))
    },
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
      if (Buffer.byteLength(t) > 4 * 1024 * 1024) throw new Error('fs.write: over the 4 MiB limit')
      mkdirSync(dirname(p), { recursive: true })
      writeFileSync(p, t)
      return p
    },
    read: async (p: string) => readFileSync(p, 'utf8'),
    list: async (p: string) => readdirSync(p).map((n) => ({ name: n, mtimeMs: statSync(join(p, n)).mtimeMs })),
    exists: async (p: string) => existsSync(p),
    stat: async (p: string) => {
      const s = statSync(p)
      return { kind: s.isDirectory() ? 'dir' : s.isFile() ? 'file' : 'other', size: s.size, mtimeMs: s.mtimeMs, isLink: false }
    },
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
            if (c.abortStyle === 'dom') throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })
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
if (c.listThrows) listing = false
for (const s of c.steps) {
  started = Date.now()
  if (s.setDenied) { c.denied = s.setDenied; continue }
  if (s.setCwd) { cwd = s.setCwd; continue }
  if (s.compact) { await handlers['session.compact']?.($, {}, engine(async () => ({}))); continue }
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
