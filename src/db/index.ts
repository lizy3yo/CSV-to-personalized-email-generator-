import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { serverEnv } from '@/env'
import * as schema from './schema'

/**
 * Database connection.
 *
 * `prepare: false` is required, not optional. On Supabase Cloud the runtime
 * connection goes through Supavisor in transaction-pooling mode, which cannot
 * hold prepared statements across a pooled connection. Leaving prepare on
 * produces intermittent "prepared statement already exists" errors that only
 * appear under concurrency — exactly the hardest kind to reproduce.
 *
 * Migrations do NOT use this client; they use DIRECT_URL. See migrate.ts.
 */

declare global {
  var __dbClient: ReturnType<typeof postgres> | undefined
}

function createClient() {
  return postgres(serverEnv().DATABASE_URL, {
    prepare: false,
    max: 10,
    idle_timeout: 20,
    connect_timeout: 10,
  })
}

/**
 * Cached on globalThis in development so Next.js hot reload does not open a
 * new pool on every edit and exhaust Postgres connections.
 */
const client =
  process.env.NODE_ENV === 'production'
    ? createClient()
    : (globalThis.__dbClient ??= createClient())

export const db = drizzle(client, { schema, casing: 'snake_case' })

export type Database = typeof db
export { schema }
