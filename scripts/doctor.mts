import { config } from 'dotenv'
import { existsSync } from 'node:fs'
import postgres from 'postgres'

/**
 * Check the setup and say exactly what is missing.  `npm run doctor`
 *
 * Every check here corresponds to something that, left unset, produces a
 * confusing failure much later — a Google error with no mention of
 * configuration, a send that blocks at preflight, a worker that finds no
 * database. Better to fail here, by name.
 */

config({ path: ['.env.local', '.env'], quiet: true })

type Status = 'ok' | 'warn' | 'fail'
const results: { status: Status; label: string; detail: string }[] = []

function check(status: Status, label: string, detail: string) {
  results.push({ status, label, detail })
}

function isBase64Bytes(value: string | undefined, bytes: number): boolean {
  if (!value) return false
  try {
    return Buffer.from(value, 'base64').length === bytes
  } catch {
    return false
  }
}

// ── files ────────────────────────────────────────────────────────────────────
check(
  existsSync('.env.local') ? 'ok' : 'fail',
  '.env.local exists',
  existsSync('.env.local') ? 'found' : 'copy .env.example to .env.local',
)

// ── secrets ──────────────────────────────────────────────────────────────────
for (const key of ['ENCRYPTION_KEY', 'UNSUBSCRIBE_SECRET'] as const) {
  const value = process.env[key]
  check(
    isBase64Bytes(value, 32) ? 'ok' : 'fail',
    key,
    isBase64Bytes(value, 32)
      ? '32 bytes, base64'
      : value
        ? 'must be 32 random bytes base64 — regenerate with `npm run keygen`'
        : 'not set — generate one with `npm run keygen`',
  )
}

if (process.env.ENCRYPTION_KEY && process.env.ENCRYPTION_KEY === process.env.UNSUBSCRIBE_SECRET) {
  check(
    'warn',
    'Secrets are distinct',
    'ENCRYPTION_KEY and UNSUBSCRIBE_SECRET are the same value — generate a second one',
  )
}

// ── supabase ─────────────────────────────────────────────────────────────────
for (const key of ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY'] as const) {
  check(
    process.env[key] ? 'ok' : 'fail',
    key,
    process.env[key] ? 'set' : 'copy from `npm run db:start` output',
  )
}

// ── google ───────────────────────────────────────────────────────────────────
const hasGoogle = Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET)
check(
  hasGoogle ? 'ok' : 'fail',
  'Google OAuth credentials',
  hasGoogle
    ? 'set'
    : 'GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are empty — see SETUP.md step 5. Sign-in cannot work without them.',
)

// ── database ─────────────────────────────────────────────────────────────────
const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL

if (!url) {
  check('fail', 'Database URL', 'DIRECT_URL is not set')
} else {
  const client = postgres(url, { max: 1, connect_timeout: 4, onnotice: () => {} })
  try {
    const [{ count }] = await client<{ count: number }[]>`
      SELECT count(*)::int AS count FROM pg_tables WHERE schemaname = 'public'
    `
    check('ok', 'Database reachable', `${count} tables`)
    check(
      count >= 13 ? 'ok' : 'fail',
      'Migrations applied',
      count >= 13 ? 'schema is present' : 'run `npm run db:migrate`',
    )
  } catch {
    check('fail', 'Database reachable', 'run `npm run db:start`, then `npm run db:migrate`')
  } finally {
    await client.end({ timeout: 1 })
  }
}

// ── the trap this script exists for ──────────────────────────────────────────
if (hasGoogle) {
  try {
    const response = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/settings`, {
      signal: AbortSignal.timeout(4000),
    })
    const settings = (await response.json()) as { external?: Record<string, boolean> }
    check(
      settings.external?.google ? 'ok' : 'fail',
      'Supabase Google provider',
      settings.external?.google
        ? 'enabled'
        : 'not enabled — check [auth.external.google] in supabase/config.toml',
    )
  } catch {
    check('warn', 'Supabase Google provider', 'could not reach the auth service')
  }
}

// ── gmail grant ──────────────────────────────────────────────────────────────
// Checked against what Google RETURNED, not what the app requested. Google
// silently drops a scope it will not grant and still issues a valid token, so
// the request says nothing about what was approved.
if (url) {
  const client = postgres(url, { max: 1, connect_timeout: 4, onnotice: () => {} })
  try {
    const rows = await client<{ google_email: string; scopes: string[] }[]>`
      SELECT google_email, scopes FROM google_accounts WHERE revoked_at IS NULL LIMIT 1
    `
    if (rows.length === 0) {
      check('warn', 'Gmail connected', 'not connected yet — sign in with Google in the app')
    } else {
      const canSend = rows[0].scopes.includes('https://www.googleapis.com/auth/gmail.send')
      check(
        canSend ? 'ok' : 'fail',
        'Gmail send permission',
        canSend
          ? `granted for ${rows[0].google_email}`
          : `NOT granted for ${rows[0].google_email}. Add https://www.googleapis.com/auth/gmail.send under Data Access in the Google console, then sign out and in again.`,
      )
    }
  } catch {
    check('warn', 'Gmail send permission', 'could not read google_accounts')
  } finally {
    await client.end({ timeout: 1 })
  }
}

// ── report ───────────────────────────────────────────────────────────────────
const icon = { ok: '✓', warn: '!', fail: '✗' } as const
console.log()
for (const result of results) {
  console.log(`  ${icon[result.status]} ${result.label.padEnd(30)} ${result.detail}`)
}

const failures = results.filter((r) => r.status === 'fail').length
console.log(
  failures === 0
    ? '\n  Everything needed is in place.\n'
    : `\n  ${failures} thing${failures === 1 ? '' : 's'} to fix before the app will work end to end.\n`,
)

process.exit(failures > 0 ? 1 : 0)
