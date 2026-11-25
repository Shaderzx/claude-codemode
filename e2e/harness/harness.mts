import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

type Case = {
  clockEarlyMs?: number
  clockFrozen?: boolean
  killDelayMs?: number
  writeDelayMs?: number
  statDelayMs?: number
  hangListMs?: number
  hangListCount?: number
  loadDelayMs?: number
  failReplyAfter?: { fail: number; after: number }
  surfaces?: string[]
  submitDelayMs?: number
  hangListDuringRuns?: boolean
  submitRefusals?: number
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
  detachAfterMs?: number
  slowWritesMs?: number
  leanTimeoutMs?: number
  archiveWithheld?: boolean
  archiveTruncated?: boolean
  deniedReplaceMessage?: string
  archiveWithheldText?: string
  jobNoExit?: boolean
  headerOnly?: boolean
  pageWithheld?: boolean
  leanCap?: number
  noSwap?: boolean
  archiveWithheldError?: boolean
  shellWithheld?: boolean
  expandEmptyBody?: boolean
  shellAdvice?: string
  bytesShort?: boolean
  swapFormat?: string
  archiveBytes?: string
  shortPages?: number
}
type Step = { abortDuringNext?: { abort: string; start: string }; keepTurn?: boolean; agentId?: string; interrupt?: boolean; stop?: boolean; untilRunsDone?: boolean; collect?: boolean; untilWake?: boolean; turnStart?: string; turnComplete?: string; stopAborted?: boolean; clear?: boolean; reload?: boolean; turnAborted?: string; untilRunDone?: string; untilQuiet?: boolean; ageSpills?: boolean; abortAndStart?: { abort: string; start: string }; link?: { from: string; to: string }; untilFile?: string; untilStatPending?: boolean; stopAbortAfterMs?: number; agentEnd?: string; untilTool?: string; touch?: string; subagentStopWithoutId?: boolean; compact?: boolean; compactAgent?: string; compactSkipped?: boolean; script?: string; direct?: { tool: string; args: Record<string, unknown> }; search?: string; describe?: string; newSession?: boolean; setDenied?: string[]; setCwd?: string }

const root = join(import.meta.dirname, '..', '..')
const c: Case = JSON.parse(readFileSync(process.argv[2] as string, 'utf8'))
const work = mkdtempSync(join(tmpdir(), 'codemode-mod-'))
const live = new Set<number>()
const stop = (pid: number | undefined) => {
  if (pid === undefined) return
  live.delete(pid)
  try { process.kill(-pid, 'SIGKILL') } catch {}
}
const home = c.home ?? mkdtempSync(join(tmpdir(), 'codemode-home-'))
process.on('exit', () => {
  for (const pid of [...live]) stop(pid)
  rmSync(work, { recursive: true, force: true })
  if (c.home === undefined) rmSync(home, { recursive: true, force: true })
})
copyFileSync(join(root, 'codemode/hooks/register.tsx'), join(work, 'register.mts'))
const mod = await import(join(work, 'register.mts'))
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
  'mcp__lean-ctx__ctx_expand': 'Expands an archived output.',
}
const names = c.tools ?? ['Read', 'Bash', 'Write', 'Edit', 'Skill', 'ToolSearch', 'mcp__lean-ctx__ctx_shell', 'mcp__lean-ctx__ctx_patch', 'mcp__t3-code__thread_note']
const NOTE_SCHEMA = { type: 'object', properties: { threadId: { type: 'string' }, note: { type: 'string' } }, required: ['threadId', 'note'] }

const err = (text: string) => ({ isError: true, text, result: text })
const ok = (text: string, result: unknown = text) => ({ text, result })

const readTimes = new Map<string, number>()
const jobs = new Map<string, { done?: { code: number; out: string } }>()
const jobArchive = new Map<string, string>()
const shellOk = (t: string) => ok(t, [{ type: 'text', text: t }])
const firewalled = (id: string, body: string) => '[Firewalled ctx_shell output — ' + body.length + ' chars, ' + body.split('\n').length + ' lines stored out-of-band]\n--- head ---\n' + body.slice(0, 200) + '\n--- retrieve full output ---\nFull:    ctx_expand(id="' + id + '")'
const archive = (id: string) => join(home, '.local', 'share', 'lean-ctx', 'archives', id.slice(0, 2), id + '.txt')
let archived = 0
let swapped = 0
const tokensOf = (rows: string[]) => rows.reduce((n, l) => n + (l.length > 200 && !/\s/.test(l) ? l.length : Math.ceil(l.length / 4)) + 1, 0)
const leanReply = (tool: string, r: { code: number; out: string }) => {
  if (c.shellWithheld) return ok('[lean-ctx gateway: retained output withheld by storage policy]')
  const advice = c.shellAdvice === undefined ? '' : '\n' + c.shellAdvice
  const full = r.code ? r.out + '\n[exit:' + r.code + ']' : r.out || '(' + tool + ' completed with no output)'
  const cap = c.leanCap ?? 56000
  if (full.length <= cap) return r.code ? err(full + advice) : shellOk(full + advice)
  const aid = (++archived).toString(16).padStart(16, 'c')
  mkdirSync(dirname(archive(aid)), { recursive: true })
  writeFileSync(archive(aid), r.code ? r.out + '\n[exit:' + r.code + ']' : r.out)
  const kept: string[] = []
  let size = 0
  for (const l of r.out.split('\n')) {
    if (size + l.length + 1 > cap) break
    kept.push(l)
    size += l.length + 1
  }
  const text = kept.join('\n') + '\n[… truncated at ~' + Math.round(cap / 1.7) + ' of ' + Math.round(r.out.length / 1.7) + ' tokens — the full output is archived — see the next line]\n[Original available via ctx_expand id=' + aid + ']'
  return r.code ? err(text) : shellOk(text)
}
let bashCwd = ''
const writePath = (raw: unknown) => {
  const p = String(raw ?? '').trim()
  if (p === '~' || p.startsWith('~/')) return home + p.slice(1)
  return p.startsWith('/') ? p : join(bashCwd || cwd, p)
}
const numbered = (lines: string[], from: number) => lines.map((l, i) => String(from + i) + '\t' + l).join('\n')
const seen = new Map<string, number>()

const shell = (command: string, keepCwd = false) => {
  let pid: number | undefined
  const done = new Promise<{ code: number; out: string }>((finish) => {
    const marker = join(home, '.bash-cwd')
    const run = keepCwd ? command + '\n__cm_rc=$?; pwd > ' + JSON.stringify(marker) + '; exit $__cm_rc' : command
    const p = spawn('bash', ['-c', run], { cwd: keepCwd ? bashCwd || cwd : cwd, env: { ...process.env, HOME: home }, detached: true })
    pid = p.pid
    if (pid !== undefined) live.add(pid)
    if (keepCwd) p.on('close', () => { try { bashCwd = readFileSync(marker, 'utf8').trim() } catch {} })
    let out = ''
    p.stdout.setEncoding('utf8').on('data', (t: string) => { out += t })
    p.stderr.setEncoding('utf8').on('data', (t: string) => { out += t })
    p.on('error', (e) => finish({ code: 127, out: String(e.message) }))
    p.on('close', (code) => {
      if (p.pid !== undefined) live.delete(p.pid)
      finish({ code: code ?? 1, out })
    })
  })
  return Object.assign(done, { stop: () => stop(pid) })
}

const fake = async (tool: string, a: Record<string, unknown>): Promise<Record<string, unknown>> => {
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
      let part = lines.slice(offset - 1, offset - 1 + Math.min(limit, c.shortPages ?? limit))
      const tokens = tokensOf(part)
      let cut = false
      if (tokens > 25000) {
        if (typeof a.limit === 'number' && !c.truncateLimited)
          return err('File content (' + tokens + ' tokens) exceeds maximum allowed tokens (25000). Use offset and limit parameters to read specific portions of the file, or search for specific content instead of reading the whole file.')
        let n = 0
        for (let used = 0; n < part.length && used + tokensOf([part[n] as string]) <= 25000; n++) used += tokensOf([part[n] as string])
        part = n ? part.slice(0, n) : [(part[0] as string).slice(0, /\s/.test(part[0] as string) ? 100000 : 21000)]
        cut = true
      }
      seen.set(key, statSync(p).mtimeMs)
      readTimes.set(p, statSync(p).mtimeMs)
      if (typeof a.limit === 'number' && c.changeAfterPage === offset) writeFileSync(p, text + 'changed meanwhile\n')
      return ok(numbered(part, offset), { type: 'text', file: { filePath: p, content: part.join('\n'), numLines: part.length, startLine: offset, totalLines: lines.length, ...(cut ? { truncatedByTokenCap: true } : {}) } })
    }
    case 'Write': {
      if (c.writeDelayMs) await new Promise((r) => setTimeout(r, c.writeDelayMs))
      if (c.deniedWriteMessage !== undefined) return err(c.deniedWriteMessage)
      const w = writePath(a.file_path)
      if (!c.engineForgets && existsSync(w) && readTimes.has(w) && statSync(w).mtimeMs !== readTimes.get(w)) return err('<tool_use_error>File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.</tool_use_error>')
      mkdirSync(dirname(w), { recursive: true })
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
        const bg = spawn('bash', ['-c', command], { cwd, detached: true, stdio: 'ignore' })
        bg.on('error', () => {})
        if (bg.pid !== undefined) live.add(bg.pid)
        bg.unref()
        return ok('Command running in background with ID: bg1. Output is being written to: /tmp/bg1.output')
      }
      if (tool !== 'Bash' && Buffer.byteLength(command) > 8192)
        return err('ERROR: Command too large (' + Buffer.byteLength(command) + ' bytes, limit 8192). If you\'re writing file content, use the native Write/Edit tool instead. ctx_shell is for reading command output only (git, cargo, npm, etc.).')
      if (tool !== 'Bash' && a.background_action === 'status') {
        const id = String(a.job_id)
        const j = jobs.get(id)
        if (!j) return err('unknown job ' + id)
        if (!j.done) return ok(JSON.stringify({ jobId: id, state: 'running', summary: 'running' }))
        if (!j.done.out && !j.done.code) return ok(JSON.stringify({ capturedChars: 0, exitCode: 0, jobId: id, state: 'completed', summary: 'no output' }))
        const aid = 'a' + id.slice(-15)
        if (!c.archiveWithheld) {
          mkdirSync(dirname(archive(aid)), { recursive: true })
          writeFileSync(archive(aid), c.archiveBytes !== undefined ? Buffer.from(c.archiveBytes, 'base64') : j.done.code ? j.done.out + '\n[exit:' + j.done.code + ']' : j.done.out)
        }
        jobArchive.set(id, aid)
        if (c.jobNoExit && !j.done.code) return ok(JSON.stringify({ archiveId: aid, jobId: id, state: 'completed', summary: 'done' }))
        if (j.done.code) return err('[background:' + id + ' failed, exit ' + j.done.code + ']\n' + (j.done.out.length > 2000 && a.raw !== true ? firewalled(aid, j.done.out) : j.done.out) + '\n\n[exit:' + j.done.code + ']')
        return ok(JSON.stringify({ archiveId: aid, archiveTruncated: !!c.archiveTruncated, archivedChars: j.done.out.length, exitCode: 0, jobId: id, state: 'completed', summary: j.done.out.length + ' chars archived' }))
      }
      if (tool !== 'Bash' && c.leanTimeoutMs !== undefined) {
        const limit = typeof a.timeout_ms === 'number' ? a.timeout_ms : c.leanTimeoutMs
        const running = shell(command)
        const raced = await Promise.race([running, new Promise<undefined>((r) => setTimeout(() => r(undefined), limit))])
        if (raced === undefined) running.stop()
        if (raced === undefined) return err('(timed out after ' + limit + 'ms)\n[exit:124]')
        return leanReply(tool, raced)
      }
      if (tool !== 'Bash' && c.detachAfterMs !== undefined) {
        const running = shell(command)
        const raced = await Promise.race([running, new Promise<undefined>((r) => setTimeout(() => r(undefined), c.detachAfterMs))])
        if (raced === undefined) {
          const id = 'shell_' + String(jobs.size + 1).padStart(16, '0')
          const j: { done?: { code: number; out: string } } = {}
          jobs.set(id, j)
          void running.then((d) => { j.done = d })
          return ok(JSON.stringify({ jobId: id, state: 'running', summary: 'auto-detached job is still running' }))
        }
        return leanReply(tool, raced)
      }
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
      if (tool === 'Bash' && c.bytesShort && command.endsWith('| base64') && !r.code) return ok(r.out.trim().slice(0, -4))
      if (tool === 'Bash') return r.code ? err('<tool_use_error>Exit code ' + r.code + '\n' + r.out + '</tool_use_error>') : ok(r.out)
      return leanReply(tool, r)
    }
    case 'mcp__lean-ctx__ctx_patch': {
      if (Array.isArray(a.ops)) {
        const said: string[] = []
        for (const o of a.ops as Record<string, unknown>[]) {
          const r = await fake('mcp__lean-ctx__ctx_patch', { ...(a.path === undefined ? {} : { path: a.path }), ...o })
          if ((r as { isError?: boolean }).isError) return r
          said.push(String((r as { text?: string }).text))
        }
        return ok(said.join('\n'))
      }
      const p = String(a.path).startsWith('/') ? String(a.path) : join(cwd, String(a.path))
      if (a.op === 'create' && c.deniedCreateMessage !== undefined) return err(c.deniedCreateMessage)
      if (a.op === 'create') {
        if (existsSync(dirname(p)) && !statSync(dirname(p)).isDirectory()) return err('ERROR: parent directory does not exist for ' + p)
        if (existsSync(p)) return err('ERROR: ' + p + ' already exists — create is for new files only. Use anchored ops')
        mkdirSync(dirname(p), { recursive: true })
        writeFileSync(p, String(a.new_text ?? ''))
        return ok('created ' + p)
      }
      if (a.op === 'replace_unique' && c.deniedReplaceMessage !== undefined && !String(a.old_text ?? '').includes('\r')) return err(c.deniedReplaceMessage)
      if (a.op === 'set_line') {
        const lines = readFileSync(p, 'utf8').split('\n')
        lines[Number(a.line) - 1] = String(a.new_text ?? '')
        writeFileSync(p, lines.join('\n'))
        return ok('set line ' + a.line + ' in ' + p)
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
    case 'mcp__lean-ctx__ctx_expand': {
      if (jobs.get(String(a.id))?.done && !jobArchive.has(String(a.id))) return ok("Background job '" + String(a.id) + "' finished (exit " + jobs.get(String(a.id))!.done!.code + ') without output.')
      const id = jobArchive.get(String(a.id)) ?? String(a.id)
      if (c.archiveWithheld) return (c.archiveWithheldError ? err : ok)(c.archiveWithheldText ?? '[lean-ctx gateway: retained output withheld by storage policy]')
      if (!existsSync(archive(id))) return err('no archive ' + id)
      const body = readFileSync(archive(id), 'utf8')
      const rows = body.replace(/\n$/, '').split('\n')
      const footer = '\n[… truncated at ~4071 of 11023 tokens — use ctx_read with lines= parameter to see specific sections]'
      const head = 'Archive ' + id + ' (' + Buffer.byteLength(body) + ' chars, ' + rows.length + ' lines):\n'
      if (a.start_line === undefined && c.headerOnly) return ok(head.replace(/\n$/, ''))
      if (a.start_line === undefined && c.expandEmptyBody) return ok(head)
      if (a.start_line !== undefined && c.pageWithheld) return ok('[lean-ctx: content withheld — policy]')
      if (a.start_line === undefined && rows.length === 1 && (rows[0] as string).length > 16000) return ok(head + footer.slice(1))
      if (a.start_line === undefined) {
        const preview: string[] = []
        let size = 0
        for (const l of rows.slice(0, 50)) {
          if (size + l.length + 1 > 16000) break
          preview.push(l)
          size += l.length + 1
        }
        return ok(head + preview.join('\n') + (preview.length < rows.length ? footer : ''))
      }
      const from = Number(a.start_line)
      const to = Math.min(Number(a.end_line ?? rows.length), rows.length, from + 99)
      const shown = rows.slice(from - 1, to).map((l, k) => (l.length <= 16000 ? String(from + k).padStart(6) + '|' + l : '')).filter(Boolean).join('\n')
      return ok('Archive ' + id + ' lines ' + from + '-' + to + ':\n' + shown + (to < Number(a.end_line ?? rows.length) ? footer : ''))
    }
    case 'mcp__t3-code__big_report':
      return ok('x'.repeat(2_100_000), { structuredContent: { data: 'y'.repeat(2_100_000) } })
    case 'mcp__shots__snap':
      return { text: '', result: { type: 'image', file: { base64: 'QUJDREVG', type: 'image/png', originalSize: 6 } } }
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
const submitted: string[] = []
const stops: string[] = []
type Result = { text: string; attachments: number; ms: number; id?: string; immediate?: string; immediateMs?: number; heldMs?: number }
const byRun = new Map<string, Result>()
const SECTION = /^\[(r\d+) (?:finished|stopped) after [^\]\n]*\]$/gm
const absorb = (text: string) => {
  const heads = [...text.matchAll(SECTION)]
  heads.forEach((m, i) => {
    const r = byRun.get(m[1] as string)
    if (!r) return
    const from = (m.index ?? 0) + m[0].length + 1
    const to = i + 1 < heads.length ? (heads[i + 1]!.index ?? text.length) : text.length
    r.text = text.slice(from, to).replace(/\n\n$/, '')
  })
}
let inTurn = false
let sessionStarted = false
let wakesPending = 0
let wakesSeen = 0
let statsPending = 0
let bashWaits = 0
let listsHanging = 0
const writtenReplies = new Set<string>()
const failedReplies = new Set<string>()
let listsHung = 0
let fakesPending = 0
let lastActivity = Date.now()
let wakeAttempts = 0
let refusals = c.submitRefusals ?? 0
const kills: string[][] = []
const waits = new Set<number>()
let runsStarted = 0
let inflight = 0
const until = async (check: () => boolean, ms: number, what = 'a harness wait') => {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() >= end) throw new Error(what + ' never happened within ' + ms + 'ms')
    await new Promise((r) => setTimeout(r, 20))
  }
}
let started = Date.now()
const $ = {
  plugin: { root: join(root, 'codemode') },
  tool: {
    list: async () => {
      if (!listing) throw new Error('$.tool.list failed')
      if (c.hangListDuringRuns && sessionStarted) await new Promise(() => {})
      if (c.hangListMs && sessionStarted && (c.hangListCount === undefined || listsHung++ < c.hangListCount)) {
        listsHanging++
        await new Promise((r) => setTimeout(r, c.hangListMs))
        listsHanging--
        lastActivity = Date.now()
      }
      return names.map((n) => ({ name: n, description: DESCRIPTIONS[n] ?? n, mcp: n.startsWith('mcp__') }))
    },
    register: async (d: Record<string, unknown>) => {
      registered.push(d)
      return { tool: 'mcp__codemode__' + d.name }
    },
    call: async (args: Record<string, unknown>) => {
      const { tool, ...rest } = args
      fakesPending++
      const r = await fake(String(tool), rest).finally(() => {
        fakesPending--
        lastActivity = Date.now()
      })
      const t = typeof r.text === 'string' ? r.text : undefined
      if (r.isError !== true && t !== undefined && t.length > 50000 && String(tool).startsWith('mcp__') && !c.noSwap) {
        const saved = join(c.env?.CLAUDE_CONFIG_DIR ?? join(home, '.claude'), 'projects', 'p', 's', 'tool-results', String(tool).slice(5).replace(/__/g, '-') + '-' + Date.now() + '-' + ++swapped + '.txt')
        mkdirSync(dirname(saved), { recursive: true })
        writeFileSync(saved, t)
        const said = 'Error: result (' + t.length.toLocaleString('en-US') + ' characters across ' + t.split('\n').length.toLocaleString('en-US') + ' lines) exceeds maximum allowed tokens. Output has been saved to ' + saved + '.\nFormat: ' + (c.swapFormat ?? 'Plain text') + '\n- For targeted searches (find a line, locate a string): use grep on the file directly.\n- For analysis or summarization that requires reading the full content: read ' + saved + ' in chunks of ~816 lines using offset/limit until you have read 100% of it.\n'
        return { text: said, result: [{ type: 'text', text: said }] }
      }
      if (r.isError === true && t !== undefined && t.length > 10000) {
        const cut = t.slice(0, 5000) + '\n\n... [' + (t.length - 10000) + ' characters truncated] ...\n\n' + t.slice(-5000)
        return { ...r, text: cut, result: cut }
      }
      return r
    },
  },
  env: { get: async (k: string) => (lastActivity = Date.now(), { HOME: home, CODEMODE_NODE: process.execPath, PWD: cwd, ...(c.env ?? {}) } as Record<string, string>)[k] },
  fs: {
    write: async (p: string, t: string) => {
      inflight++
      try {
        writtenReplies.add(p)
        const failing = c.failReplyAfter
        if (failing && p.endsWith('/' + failing.fail + '.json') && t.includes('"ok":true')) {
          const after = p.slice(0, p.lastIndexOf('/') + 1) + failing.after + '.json'
          if (!failedReplies.has(p)) await until(() => writtenReplies.has(after), 30_000, 'reply ' + failing.after + ' being written')
          failedReplies.add(p)
          throw new Error('fs.write: failed on purpose')
        }
        if (Buffer.byteLength(t) > 4 * 1024 * 1024) throw new Error('fs.write: over the 4 MiB limit')
        mkdirSync(dirname(p), { recursive: true })
        writeFileSync(p, t)
        if (c.slowWritesMs) await new Promise((r) => setTimeout(r, c.slowWritesMs))
        return p
      } finally {
        inflight--
      }
    },
    read: async (p: string) => readFileSync(p, 'utf8'),
    list: async (p: string) => readdirSync(p).map((n) => ({ name: n, mtimeMs: statSync(join(p, n)).mtimeMs })),
    exists: async (p: string) => existsSync(p),
    stat: async (p: string) => {
      if (c.statDelayMs && sessionStarted) {
        statsPending++
        await new Promise((r) => setTimeout(r, c.statDelayMs))
        statsPending--
      }
      const s = statSync(p)
      return { kind: s.isDirectory() ? 'dir' : s.isFile() ? 'file' : 'other', size: s.size, mtimeMs: s.mtimeMs, isLink: false }
    },
  },
  process: {
    spawn: ({ argv, input }: { argv: string[]; input?: string }) => {
      if (argv.includes('--permission')) runsStarted++
      const child = spawn(argv[0] as string, argv.slice(1), { stdio: ['pipe', 'pipe', 'pipe'] })
      const runner = argv.includes('--permission')
      if (!runner && child.pid) {
        waits.add(child.pid)
        child.on('close', () => waits.delete(child.pid as number))
      }
      child.stdin.end(input ?? '')
      const queue: { stream: string; text: string }[] = []
      let wake: (() => void) | undefined
      let ended = false
      child.stdout.setEncoding('utf8').on('data', (t: string) => { queue.push({ stream: 'stdout', text: t }); wake?.() })
      child.stderr.setEncoding('utf8').on('data', (t: string) => { queue.push({ stream: 'stderr', text: t }); wake?.() })
      child.on('close', () => { ended = true; wake?.() })
      child.on('error', (e) => { queue.push({ stream: 'stderr', text: String(e.message) }); ended = true; wake?.() })
      const abortAt = c.abortAfterMs === undefined ? undefined : started + c.abortAfterMs
      return (async function* () {
        try {
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
        } finally {
          if (!ended && !runner) child.kill('SIGKILL')
        }
      })()
    },
    run: (argv: string[], _init?: unknown) =>
      (argv[0] === 'kill' ? kills.push([...argv]) : 0, (argv[0] === 'kill' && c.killDelayMs ? new Promise((r) => setTimeout(r, c.killDelayMs)) : Promise.resolve()).then(() => new Promise<{ exitCode: number; stdout: string; stderr: string }>((done) => {
        const p = spawn(argv[0] as string, argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] })
        if (p.pid !== undefined) live.add(p.pid)
        if (argv[0] === 'bash') bashWaits++
        if (p.pid) {
          waits.add(p.pid)
          p.on('close', () => waits.delete(p.pid as number))
        }
        let stdout = ''
        let stderr = ''
        p.stdout.setEncoding('utf8').on('data', (t: string) => { stdout += t })
        p.stderr.setEncoding('utf8').on('data', (t: string) => { stderr += t })
        p.on('error', (e) => done({ exitCode: 127, stdout, stderr: stderr + String(e.message) }))
        p.on('close', (code) => {
          done({ exitCode: code ?? 1, stdout, stderr })
        })
      }))),
  },
  clock: {
    after: (ms: number, fn: () => void) => {
      if (c.clockFrozen && sessionStarted) return { cancel: () => undefined }
      const h = setTimeout(fn, Math.max(0, ms - (c.clockEarlyMs ?? 0)))
      return { cancel: () => clearTimeout(h) }
    },
  },
  store: {
    get: async (k: string) => {
      if (c.loadDelayMs && k.startsWith('script:')) await new Promise((r) => setTimeout(r, c.loadDelayMs))
      return store[k]
    },
    set: async (k: string, v: unknown) => { store[k] = v },
    delete: async (k: string) => { delete store[k] },
  },
  session: { version: async () => ({ version: '2.1.325' }), surfaces: async () => c.surfaces ?? [] },
  prompt: {
    submit: async (a: { text: string }) => {
      wakeAttempts++
      wakesPending++
      try {
        if (c.submitDelayMs) await new Promise((r) => setTimeout(r, c.submitDelayMs))
      } finally {
        wakesPending--
      }
      if (refusals > 0) {
        refusals--
        throw new Error('prompt.submit refused')
      }
      submitted.push(a.text)
      return { text: a.text, origin: { kind: 'plugin', name: 'codemode' } }
    },
  },
  model: { complete: async (r: { model: string; prompt: string }) => ({ isAnswered: true, text: 'answer from ' + r.model + ' to: ' + r.prompt.slice(0, 60) }) },
}

const engine = (f: (e: Record<string, unknown>) => Promise<unknown>) => Object.assign(f, { origin: { plugin: 'engine' } })
const flatten = (r: unknown): { text: string; attachments: number } => {
  const v = (r as { result?: unknown })?.result ?? (r as { deny?: string })?.deny ?? r
  if (typeof v === 'string') return { text: v, attachments: 0 }
  if (Array.isArray(v)) return { text: v.filter((b) => b?.type === 'text').map((b) => b.text).join('\n'), attachments: v.filter((b) => b?.type !== 'text').length }
  return { text: JSON.stringify(v), attachments: 0 }
}

const out: { description?: string; results: Result[]; calls: typeof calls; store: typeof store; submitted: string[]; stops: string[]; collected: string[]; collectedAttachments: number[]; kills: string[][]; waitsAlive: number; wakeAttempts: number; bashWaits?: number; runnersSpawned?: number } = { results: [], calls, store, submitted, stops, collected: [], collectedAttachments: [], kills, waitsAlive: 0, wakeAttempts: 0 }
const collect = async (agentId?: string) => {
  const r = await handlers['tool.call']?.($, { tool: 'mcp__codemode__run', script: '', ...(agentId ? { agentId } : {}) }, engine(async () => ({})))
  const flat = flatten(r)
  out.collected.push(flat.text)
  out.collectedAttachments.push(flat.attachments)
  absorb(flat.text)
  return flat
}
const endTurn = async (agentId: string | undefined, interrupt: boolean) => {
  const t0 = Date.now()
  if (interrupt) {
    inTurn = false
    await handlers['turn.complete']?.($, { turnId: 'turn', isAborted: true }, engine(async () => ({})))
    return Date.now() - t0
  }
  const hook = agentId ? handlers['classic.SubagentStop'] : handlers['classic.Stop']
  const e = agentId ? { hook_event_name: 'SubagentStop', agent_id: agentId, stop_hook_active: false } : { hook_event_name: 'Stop', stop_hook_active: false, background_tasks: [] }
  const r = (await hook?.($, e, engine(async () => ({})))) as { block?: string } | undefined
  if (typeof r?.block === 'string') {
    stops.push(r.block)
    absorb(r.block)
    if (/empty script/.test(r.block)) {
      await collect(agentId)
      const again = (await hook?.($, { ...e, stop_hook_active: true }, engine(async () => ({})))) as { block?: string } | undefined
      if (typeof again?.block === 'string') stops.push(again.block)
    }
  }
  const stopped = Date.now() - t0
  if (!agentId) {
    inTurn = false
    await handlers['turn.complete']?.($, { turnId: 'turn' }, engine(async () => ({})))
  }
  return stopped
}
const startSession = async () => {
  registered.length = 0
  await handlers['session.start']?.($, { cwd }, engine(async () => ({})))
  out.description = String(registered.at(-1)?.description ?? '')
}
await startSession()
sessionStarted = true
if (c.listThrows) listing = false
for (const s of c.steps) {
  started = Date.now()
  if (s.setDenied) { c.denied = s.setDenied; continue }
  if (s.setCwd) { cwd = s.setCwd; continue }
  if (s.compact) {
    await handlers['session.compact']?.($, { trigger: 'manual', ...(s.compactAgent ? { agentId: s.compactAgent } : {}) }, engine(async () => (s.compactSkipped ? { skip: 'kept by a hook' } : { messages: [] })))
    continue
  }
  if (s.newSession) {
    await handlers['session.end']?.($, { reason: 'clear' }, engine(async () => ({})))
    await startSession()
    continue
  }
  if (s.clear) {
    await handlers['session.end']?.($, { reason: 'clear' }, engine(async () => ({})))
    continue
  }
  if (s.reload) {
    await startSession()
    continue
  }
  if (s.turnAborted !== undefined) {
    inTurn = false
    await handlers['turn.complete']?.($, { ...(s.turnAborted ? { turnId: s.turnAborted } : {}), isAborted: true }, engine(async () => ({})))
    continue
  }
  if (s.untilRunsDone) {
    await until(() => mod.openRunIds().length === 0 && inflight === 0 && statsPending === 0, 60_000, 'every run settling')
    await new Promise((r) => setTimeout(r, 0))
    continue
  }
  if (s.stop) {
    await endTurn(s.agentId, !!s.interrupt)
    continue
  }
  if (s.untilRunDone) {
    await until(() => !mod.openRunIds().includes(s.untilRunDone) && inflight === 0, 60_000, s.untilRunDone + ' settling')
    await new Promise((r) => setTimeout(r, 0))
    continue
  }
  if (s.ageSpills) {
    const spills = join(home, '.claude', 'codemode', 'out')
    const old = (Date.now() - 3 * 86_400_000) / 1000
    for (const n of existsSync(spills) ? readdirSync(spills) : []) utimesSync(join(spills, n), old, old)
    continue
  }
  if (s.abortDuringNext) {
    const { abort, start } = s.abortDuringNext
    inTurn = false
    await handlers['turn.complete']?.($, { ...(abort ? { turnId: abort } : {}), isAborted: true }, engine(async () => {
      inTurn = true
      await handlers['turn.start']?.($, start ? { turnId: start } : {}, engine(async () => ({})))
      return {}
    }))
    continue
  }
  if (s.abortAndStart) {
    inTurn = false
    const aborting = handlers['turn.complete']?.($, { turnId: s.abortAndStart.abort, isAborted: true }, engine(async () => ({})))
    await until(() => kills.length > 0, 30_000, 'the abort sending its kill')
    inTurn = true
    await handlers['turn.start']?.($, { turnId: s.abortAndStart.start }, engine(async () => ({})))
    await aborting
    continue
  }
  if (s.link) {
    symlinkSync(s.link.to, s.link.from)
    continue
  }
  if (s.untilQuiet) {
    await until(() => listsHanging === 0 && inflight === 0 && fakesPending === 0 && statsPending === 0 && Date.now() - lastActivity > 500, 60_000, 'the mod going quiet')
    continue
  }
  if (s.untilFile) {
    await until(() => existsSync(s.untilFile as string), 30_000, s.untilFile + ' appearing')
    continue
  }
  if (s.untilStatPending) {
    await until(() => statsPending > 0, 30_000, 'a file check starting')
    continue
  }
  if (s.stopAbortAfterMs !== undefined) {
    const ac = new AbortController()
    setTimeout(() => ac.abort(), s.stopAbortAfterMs)
    const r = (await handlers['classic.Stop']?.($, { hook_event_name: 'Stop', stop_hook_active: false }, Object.assign(engine(async () => ({})), { signal: ac.signal }))) as { block?: string } | undefined
    stops.push(String(r?.block ?? ''))
    await new Promise((r) => setTimeout(r, 400))
    continue
  }
  if (s.turnStart !== undefined) {
    inTurn = true
    await handlers['turn.start']?.($, s.turnStart ? { turnId: s.turnStart } : {}, engine(async () => ({})))
    continue
  }
  if (s.turnComplete !== undefined) {
    await handlers['turn.complete']?.($, s.turnComplete ? { turnId: s.turnComplete } : {}, engine(async () => ({})))
    continue
  }
  if (s.stopAborted) {
    const ac = new AbortController()
    ac.abort()
    const r = (await handlers['classic.Stop']?.($, { hook_event_name: 'Stop', stop_hook_active: false }, Object.assign(engine(async () => ({})), { signal: ac.signal }))) as { block?: string } | undefined
    stops.push(String(r?.block ?? ''))
    continue
  }
  if (s.untilWake) {
    await until(() => wakeAttempts > wakesSeen && wakesPending === 0, 30_000, 'a wake prompt')
    wakesSeen = wakeAttempts
    continue
  }
  if (s.collect) {
    await collect(s.agentId)
    continue
  }
  if (s.agentEnd) {
    await handlers['turn.complete']?.($, { turnId: 'agent-turn', agentId: s.agentEnd }, engine(async () => ({})))
    continue
  }
  if (s.subagentStopWithoutId) {
    const r = (await handlers['classic.SubagentStop']?.($, { hook_event_name: 'SubagentStop', stop_hook_active: false }, engine(async () => ({})))) as { block?: string } | undefined
    stops.push(String(r?.block ?? ''))
    continue
  }
  if (s.untilTool) {
    await until(() => calls.some((x) => x.tool === s.untilTool), 30_000, 'a ' + s.untilTool + ' call')
    continue
  }
  if (s.touch) {
    writeFileSync(s.touch, '')
    continue
  }
  if (s.script !== undefined) {
    if (!inTurn && !s.agentId) {
      inTurn = true
      await handlers['turn.start']?.($, { turnId: 'turn' }, engine(async () => ({})))
    }
    const r = await handlers['tool.call']?.($, { tool: 'mcp__codemode__run', script: s.script, ...(s.agentId ? { agentId: s.agentId } : {}) }, engine(async () => ({})))
    const flat = flatten(r)
    const result: Result = { ...flat, ms: Date.now() - started, immediate: flat.text, immediateMs: Date.now() - started }
    const id = /^Started (r\d+) in the background/.exec(flat.text)?.[1]
    absorb(flat.text)
    if (id) {
      result.id = id
      byRun.set(id, result)
    }
    out.results.push(result)
    if (!s.keepTurn) result.heldMs = await endTurn(s.agentId, !!s.interrupt)
    result.ms = Date.now() - started
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
out.waitsAlive = waits.size
out.bashWaits = bashWaits
out.runnersSpawned = runsStarted
out.wakeAttempts = wakeAttempts
process.stdout.write(JSON.stringify(out), () => process.exit(0))
