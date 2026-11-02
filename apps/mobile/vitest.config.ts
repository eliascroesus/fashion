import { defineConfig } from 'vitest/config';

// Plain-logic tests only (API client, translations). Screens are tested with Maestro.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
});
