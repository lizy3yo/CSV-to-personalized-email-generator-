import { randomBytes } from 'node:crypto'

/**
 * Test environment. Runs before any module is imported, so `serverEnv()` sees
 * valid values. Keys are generated per-run — nothing here is a real secret.
 *
 * NODE_ENV is not set here: Vitest already sets it to `test`, and the type is
 * read-only.
 */
process.env.ENCRYPTION_KEY ??= randomBytes(32).toString('base64')
process.env.UNSUBSCRIBE_SECRET ??= randomBytes(32).toString('base64')
process.env.DATABASE_URL ??= 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
process.env.DIRECT_URL ??= 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'http://127.0.0.1:54321'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'test-anon-key'
process.env.NEXT_PUBLIC_SITE_URL ??= 'http://localhost:3000'
