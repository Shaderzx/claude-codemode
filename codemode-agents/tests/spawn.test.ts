import { expect, test } from 'claude-code/testing'

test('the spawn tool refuses callers other than codemode', async ($, on) => {
  on('session.start', async () => ({ cwd: '/tmp' }))
  on('tool.register', async () => ({ value: { tool: 'mcp__codemode-agents__spawn' } }))
  await $.session.start({ cwd: '/tmp', surface: null, isInteractive: false } as never)
  const r = await $.tool.call({ tool: 'mcp__codemode-agents__spawn', prompt: 'hi' } as never)
  expect(r.deny).toContain('codemode script')
})
