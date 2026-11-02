import { existsSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

const envFile = new URL('../../.env', import.meta.url);
if (existsSync(envFile)) process.loadEnvFile(envFile);

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['../../packages/db/test/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
