import { defineConfig, devices } from '@playwright/test'
import { config } from 'dotenv'

config({ path: ['.env.local', '.env'], quiet: true })

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:3000'

/**
 * The worker endpoint refuses to run unauthenticated in production, and the
 * E2E server IS a production build. Tests drive the queue through it, so they
 * need a secret — a fixed one, since it never leaves this machine.
 */
export const E2E_CRON_SECRET = process.env.CRON_SECRET ?? 'e2e-cron-secret'

/**
 * End-to-end tests.
 *
 * These drive the real app against the real local database — no mocking of
 * the layers underneath. What they deliberately do NOT touch is Gmail: a test
 * suite must never send actual email, so the send tests assert that the
 * preflight and the approval gate behave, and stop at the point where a
 * message would leave.
 */
export default defineConfig({
  testDir: './e2e',
  // Tests share one database. Running them in parallel would have them
  // deleting each other's rows.
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],

  timeout: 30_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],

  webServer: {
    // Production build: `next dev` compiles routes on first hit, which turns
    // the first assertion of every spec into a timeout race.
    command: 'npm run build && npm run start',
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    env: { ...process.env, CRON_SECRET: E2E_CRON_SECRET } as Record<string, string>,
  },
})
