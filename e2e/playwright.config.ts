import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  fullyParallel: false,
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 1 : 0,
  workers: 1,
  reporter: [
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
    ['list'],
  ],
  outputDir: 'test-results',
  use: {
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'variant-b',
      testMatch: '**/variant-b.spec.ts',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'variant-a',
      testMatch: '**/variant-a.spec.ts',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
