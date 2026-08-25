import { config } from 'dotenv'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'

/**
 * Start the local Supabase stack with the right environment.  `npm run db:start`
 *
 * Why this wrapper exists:
 *
 * `supabase/config.toml` refers to secrets as `env(GOOGLE_CLIENT_ID)`, and the
 * Supabase CLI resolves those against the SHELL ENVIRONMENT at start time. It
 * does not read `.env`, and it does not read `.env.local`. Run `supabase start`
 * directly with the variables only in a file and the container receives the
 * literal string `env(GOOGLE_CLIENT_ID)` as its client id — Google then
 * rejects sign-in with an opaque error that says nothing about configuration.
 *
 * So this loads `.env.local` and passes the values through, and says plainly
 * when something needed is missing.
 */

const loaded = config({ path: ['.env.local', '.env'], quiet: true })

if (!existsSync('.env.local')) {
  console.error('\n  .env.local not found. Copy .env.example to .env.local first.\n')
  process.exit(1)
}

const google = process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET

console.log(`\n  Loaded ${Object.keys(loaded.parsed ?? {}).length} variables from .env.local`)
console.log(
  google
    ? '  Google sign-in: configured'
    : '  Google sign-in: NOT configured — set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET\n' +
        '                  in .env.local and run this again. Everything else works\n' +
        '                  without them; only signing in does not.',
)
console.log()

const result = spawnSync('npx', ['supabase', 'start'], {
  stdio: 'inherit',
  shell: true,
  env: process.env,
})

process.exit(result.status ?? 1)
