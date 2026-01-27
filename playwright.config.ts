import { defineConfig, devices } from '@playwright/test'

const PORT = process.env.PORT || '5173'

export default defineConfig({
  testDir: './e2e/tests',
  fullyParallel: false,  // Disabled: WASM is CPU/memory intensive; parallel execution causes GC pauses
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 1,
  workers: 1,  // Single worker prevents memory contention with DuckDB-WASM
  reporter: [
    ['html', { outputFolder: 'playwright-report' }],
    ['list'],
  ],
  timeout: 60000,
  expect: {
    timeout: 15000,  // Increased from 10s for DuckDB queries under load
  },
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    // Custom userAgent for test detection - allows DuckDB to use lower memory limit
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Playwright/Test',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          args: ['--js-flags=--max-old-space-size=4096'],
        },
      },
    },
  ],
  webServer: {
    command: `npm run dev -- --port ${PORT}`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120000,
  },
})
