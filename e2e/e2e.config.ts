import type { E2EConfig } from 'e2e';

// codemode's mod source runs under Node with a stand-in for Claude Code's $ (harness/harness.mts);
// the runner child, the files and the shell commands are real.
export default {
  targets: [{ name: 'mod', platform: 'api' }],
  workers: 4,
  retries: 0,
  timeout: 60_000,
} satisfies E2EConfig;
