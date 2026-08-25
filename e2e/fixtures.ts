import { randomUUID } from 'node:crypto'
import { test as base, type BrowserContext, type Page } from '@playwright/test'
import postgres from 'postgres'
import { E2E_CRON_SECRET } from '../playwright.config'

/**
 * Test fixtures.
 *
 * Signing in is the awkward part: the app authenticates through Google, and a
 * test suite cannot — and should not — drive a real Google consent screen. So
 * a session is minted directly against the local Supabase auth service and
 * injected as a cookie, which is the standard pattern for this and exercises
 * exactly the same session handling the app uses at runtime.
 *
 * What is NOT faked: the database, the server actions, the queue, the
 * rendering. Everything below the sign-in is real.
 */

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'http://127.0.0.1:54321'
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? ''
const DB_URL = process.env.DIRECT_URL ?? process.env.DATABASE_URL ?? ''

/**
 * The cookie name @supabase/ssr uses.
 *
 * supabase-js derives it from the first label of the API hostname, so
 * `http://127.0.0.1:54321` becomes `sb-127-auth-token`. Derived rather than
 * hardcoded so a different Supabase URL does not silently break every test.
 */
function storageKey(): string {
  const host = new URL(SUPABASE_URL).hostname
  return `sb-${host.split('.')[0]}-auth-token`
}

export interface TestUser {
  id: string
  email: string
  password: string
}

async function createUser(): Promise<{ user: TestUser; session: unknown }> {
  const email = `e2e-${randomUUID().slice(0, 12)}@example.test`
  const password = `pw-${randomUUID()}`

  const response = await fetch(`${SUPABASE_URL}/auth/v1/signup`, {
    method: 'POST',
    headers: { apikey: ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })

  const payload = (await response.json()) as {
    access_token?: string
    refresh_token?: string
    expires_in?: number
    expires_at?: number
    token_type?: string
    user?: { id: string }
    msg?: string
  }

  if (!payload.access_token || !payload.user) {
    throw new Error(`Could not create a test user: ${payload.msg ?? JSON.stringify(payload)}`)
  }

  return {
    user: { id: payload.user.id, email, password },
    session: {
      access_token: payload.access_token,
      refresh_token: payload.refresh_token,
      expires_in: payload.expires_in,
      expires_at: payload.expires_at,
      token_type: payload.token_type,
      user: payload.user,
    },
  }
}

function sessionCookieValue(session: unknown): string {
  const encoded = Buffer.from(JSON.stringify(session), 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '')
  return `base64-${encoded}`
}

/** Remove the user and, by cascade, everything they created. */
async function deleteUser(userId: string): Promise<void> {
  if (!DB_URL) return
  const sql = postgres(DB_URL, { max: 1, onnotice: () => {} })
  try {
    await sql`DELETE FROM auth.users WHERE id = ${userId}`
  } finally {
    await sql.end({ timeout: 2 })
  }
}

export const test = base.extend<{
  user: TestUser
  authedContext: BrowserContext
  page: Page
  db: postgres.Sql
}>({
  user: async ({}, use) => {
    const { user, session } = await createUser()
    // Stashed so the context fixture can build the cookie without a second signup.
    ;(user as TestUser & { session?: unknown }).session = session
    await use(user)
    await deleteUser(user.id)
  },

  authedContext: async ({ browser, user }, use) => {
    const context = await browser.newContext()
    const session = (user as TestUser & { session?: unknown }).session

    await context.addCookies([
      {
        name: storageKey(),
        value: sessionCookieValue(session),
        url: 'http://localhost:3000',
        httpOnly: false,
        sameSite: 'Lax',
      },
    ])

    await use(context)
    await context.close()
  },

  page: async ({ authedContext }, use) => {
    const page = await authedContext.newPage()
    await use(page)
    await page.close()
  },

  db: async ({ user }, use) => {
    const sql = postgres(DB_URL, { max: 2, onnotice: () => {} })
    // `user` is a dependency so the connection outlives nothing that needs it.
    void user
    await use(sql)
    await sql.end({ timeout: 2 })
  },
})

export { expect } from '@playwright/test'

/**
 * Drain the job queue by poking the worker endpoint.
 *
 * The E2E environment has no long-running worker; `/api/cron/worker` is the
 * same handler registry driven one tick at a time, which is exactly what this
 * needs and avoids managing a second process from the test run.
 */
export async function runWorker(page: Page, ticks = 5): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    const response = await page.request.post('/api/cron/worker', {
      // Required: the endpoint refuses to run unauthenticated in production,
      // and the E2E server is a production build.
      headers: { Authorization: `Bearer ${E2E_CRON_SECRET}` },
    })
    if (!response.ok()) {
      throw new Error(`worker tick failed: ${response.status()} ${await response.text()}`)
    }
    const body = (await response.json()) as { processed: number }
    if (body.processed === 0) return
  }
}

/** A small CSV, as a Playwright file payload. */
export function csvFile(name: string, content: string) {
  return { name, mimeType: 'text/csv', buffer: Buffer.from(content, 'utf8') }
}

/**
 * The app's own alert region.
 *
 * A bare `getByRole('alert')` also matches Next.js's route announcer, which it
 * injects into every page as `#__next-route-announcer__` — two matches, and
 * Playwright's strict mode fails. Scoping to `main` excludes it.
 */
export function appAlert(page: Page) {
  return page.getByRole('main').getByRole('alert')
}
