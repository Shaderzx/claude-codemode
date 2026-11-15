import type { E2EConfig } from 'e2e';

export default {
  targets: [{ name: 'mod', platform: 'api' }],
  workers: 4,
  retries: 0,
  timeout: 60_000,
} satisfies E2EConfig;
