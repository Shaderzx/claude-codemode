import type { Register } from 'claude-code'

// codemode scripts call Agent through this plugin's tool. A subagent skips
// every hook of the plugin whose hook chain spawned it, so a spawn from
// codemode, or from anything codemode's hook called, would leave the subagent
// unable to run scripts and free to call tools directly. Spawns therefore run
// from this plugin's session-long loop, outside codemode's chain.
const NAME = 'spawn'
const FULL = `mcp__codemode-agents__${NAME}`
// Longest a script's foreground subagent is waited for.
const MAX_WAIT_MS = 3_600_000

type Spawned = { deny?: string; agentId?: string; teammateId?: string; model?: string }
type Job = { request: Record<string, unknown>; resolve: (s: Spawned) => void; reject: (err: unknown) => void }

const jobs: Job[] = []
let wake: (() => void) | undefined
const answers = new Map<string, { answer: string; reason: string }>()

const enqueue = (request: Record<string, unknown>) =>
  new Promise<Spawned>((resolve, reject) => {
    jobs.push({ request, resolve, reject })
    wake?.()
    wake = undefined
  })

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    void (async () => {
      for (;;) {
        const job = jobs.shift()
        if (job) $.agent.spawn(job.request as never).then(job.resolve as never, job.reject)
        else await new Promise<void>((r) => (wake = r))
      }
    })()
    await $.tool.register({
      name: NAME,
      description: 'Internal to codemode: call Agent from a codemode script instead.',
      isDeferred: true,
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string' },
          description: { type: 'string' },
          subagent_type: { type: 'string' },
          model: { type: 'string' },
          name: { type: 'string' },
          run_in_background: { type: 'boolean' },
        },
        required: ['prompt'],
      },
    })
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId) {
      // Background and engine-forked agents are never collected; drop the oldest.
      if (answers.size >= 200) answers.delete(answers.keys().next().value as string)
      answers.set(e.agentId, { answer: e.answer, reason: e.reason })
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    if ((e.tool as string) !== FULL) return next(e)
    if (next.origin.plugin !== 'codemode') return { deny: 'Call Agent from a codemode script instead.' }
    const a = e as unknown as Record<string, unknown>
    // `$.agent.spawn` cannot express these; refuse rather than drop them.
    for (const k of ['isolation', 'effort'])
      if (a[k] !== undefined) return { deny: `Agent's ${k} is not supported from a codemode script.` }
    const s = await enqueue({
      prompt: String(a.prompt ?? ''),
      description: String(a.description ?? 'codemode subagent'),
      ...(a.subagent_type ? { subagentType: String(a.subagent_type) } : {}),
      ...(a.model ? { model: String(a.model) } : {}),
      ...(a.name ? { name: String(a.name) } : {}),
    })
    if (s.deny !== undefined) return { deny: s.deny }
    const id = s.agentId
    if (a.run_in_background || !id) return { result: `Started agent ${id ?? s.teammateId ?? ''} (${s.model}).` }
    // A hook's own waiting counts against its 10 s budget and a `$` call's does
    // not, so the wait for the answer is spent inside short `$.process.run`s.
    const deadline = Date.now() + MAX_WAIT_MS
    while (!answers.has(id)) {
      if (next.signal.aborted) return { deny: `Stopped waiting for agent ${id}: the call was abandoned.` }
      if (Date.now() > deadline) return { deny: `Agent ${id} gave no answer within ${MAX_WAIT_MS / 60_000} minutes.` }
      await $.process.run(['sleep', '0.3'])
    }
    const done = answers.get(id) ?? { answer: '', reason: 'answer' }
    answers.delete(id)
    if (done.reason !== 'answer') return { deny: `Agent ${id} ended with ${done.reason}.${done.answer ? `\n${done.answer}` : ''}` }
    return { result: done.answer }
  })
}
