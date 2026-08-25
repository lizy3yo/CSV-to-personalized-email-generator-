import { config } from 'dotenv'
config({ path: ['.env.local', '.env'] })

import postgres from 'postgres'

/**
 * Remove everything created by `npm run db:seed-demo`.
 *
 * Deleting the auth user cascades through profiles and every table below it,
 * which is the same path a GDPR erasure request takes.
 */
const sql = postgres(process.env.DIRECT_URL!, { max: 1, onnotice: () => {} })

const deleted = await sql`
  DELETE FROM auth.users WHERE email LIKE 'worker-test-%@example.test' RETURNING id
`
console.log(`removed ${deleted.length} demo user(s) and everything they owned`)

await sql.end()
