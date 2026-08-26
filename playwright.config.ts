import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT || 3100);
const baseURL = process.env.E2E_BASE_URL || `http://localhost:${PORT}`;
// Same derivation as tests/e2e/seed.ts — one shared throwaway database.
const pgBase = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';

export default defineConfig({
  testDir: './tests/e2e',
  outputDir: 'tests/e2e/.artifacts',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    actionTimeout: 20_000,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: `npx next dev -p ${PORT}`,
        url: `${baseURL}/api/health`,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
        env: {
          NODE_ENV: 'development',
          DATABASE_URL: process.env.E2E_DATABASE_URL || `${pgBase}/workai_test_e2e?schema=public`,
          JWT_SECRET: 'e2e-jwt-secret-0123456789abcdef-test',
          SUPER_ADMIN_EMAIL: 'super@e2e.local',
          SUPER_ADMIN_PASSWORD: 'Super!E2e-1234',
          STORAGE_DRIVER: 'local',
        },
      },
});
