import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';

// Measurement-only suite. It is outside the default `tests/e2e` testDir, so the
// normal `npx playwright test --config playwright.config.ts` never runs it.
// Requires a running Vite dev server; PERF_BASE_URL defaults to the usual port.
const results = fileURLToPath(new URL('../../test-results/perf/', import.meta.url));

export default defineConfig({
  testDir: '.',
  testMatch: '*.perf.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 180_000,
  outputDir: `${results}artifacts`,
  reporter: [['list'], ['json', { outputFile: `${results}results.json` }]],
  use: {
    baseURL: process.env.PERF_BASE_URL ?? 'http://127.0.0.1:1420',
    channel: 'chrome',
    viewport: { width: 1280, height: 800 },
    trace: 'off',
    screenshot: 'off',
  },
});
