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
      name: 'variant-a',
      testMatch: '**/variant-a.spec.ts',
      use: {
        ...devices['Desktop Chrome'],
        // Opt-in override for users who already have Chrome for Testing
        // installed via @puppeteer/browsers and want to skip Playwright's
        // own install. Only set CHROME_EXECUTABLE when you know the binary
        // exists at that path — an invalid path will fail every test with
        // a cryptic "Executable doesn't exist" error from Playwright.
        ...(process.env['CHROME_EXECUTABLE']
          ? { launchOptions: { executablePath: process.env['CHROME_EXECUTABLE'] } }
          : {}),
      },
    },
  ],
});
