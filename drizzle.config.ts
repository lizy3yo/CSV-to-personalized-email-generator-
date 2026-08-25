import { config } from 'dotenv'
import { defineConfig } from 'drizzle-kit'

// .env.local first — Next.js loads it automatically, drizzle-kit does not.
config({ path: ['.env.local', '.env'] })

/**
 * Drizzle is the single source of truth for schema migrations.
 *
 * The Supabase CLI is used only to run the local stack (`supabase start`);
 * `supabase/migrations/` is deliberately left empty so there is exactly one
 * migration history, not two competing ones.
 *
 * Migrations run over DIRECT_URL (session mode, port 5432 on Cloud).
 * DDL through a transaction pooler fails intermittently.
 */
export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DIRECT_URL ?? process.env.DATABASE_URL ?? '',
  },
  verbose: true,
  strict: true,
  casing: 'snake_case',
})
