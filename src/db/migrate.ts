import { config } from 'dotenv'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'

// Next.js loads .env.local automatically; plain Node does not.
// Later files do not override earlier ones, so .env.local wins.
config({ path: ['.env.local', '.env'] })

/**
 * Apply pending migrations.  `npm run db:migrate`
 *
 * Runs over DIRECT_URL (session mode) with a single connection. DDL through a
 * transaction pooler fails intermittently, so this deliberately does not reuse
 * the pooled runtime client from ./index.ts.
 *
 * Wrapped in a function rather than using top-level await: package.json has no
 * `"type": "module"`, so tsx resolves this as CommonJS and top-level await
 * throws ERR_REQUIRE_ASYNC_MODULE.
 */
async function main() {
  const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL

  if (!url) {
    console.error('\n  DIRECT_URL is not set. Copy .env.example to .env.local and fill it in.\n')
    process.exit(1)
  }

  const client = postgres(url, { max: 1, onnotice: () => {} })

  try {
    console.log('  Applying migrations...')
    await migrate(drizzle(client), { migrationsFolder: './drizzle' })
    console.log('  Migrations applied.\n')
  } finally {
    await client.end()
  }
}

main().catch((error) => {
  console.error('\n  Migration failed:\n', error, '\n')
  process.exit(1)
})
