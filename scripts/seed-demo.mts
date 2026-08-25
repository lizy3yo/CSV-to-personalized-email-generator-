import { config } from 'dotenv'
config({ path: ['.env.local', '.env'] })

import { randomUUID } from 'node:crypto'
import postgres from 'postgres'

/**
 * Seed a template-only campaign and queue it.  `npm run db:seed-demo [rows]`
 *
 * Development utility: creates a throwaway user, contact list, template and
 * campaign, then enqueues generation so `npm run worker` has real work to do.
 * Template-only means no Anthropic key is required, so this exercises the
 * queue, the handlers and the render path on their own.
 *
 * Every tenth contact deliberately has no first name, so some rows come back
 * flagged rather than clean — a run where everything passes proves less.
 *
 * Clean up with:  npm run db:seed-clean
 */
const url = process.env.DIRECT_URL!
const sql = postgres(url, { max: 2, onnotice: () => {} })

const ROWS = Number(process.argv[2] ?? 50)

const userId = randomUUID()
const email = `worker-test-${userId.slice(0, 8)}@example.test`

await sql`
  INSERT INTO auth.users (id, instance_id, aud, role, email, created_at, updated_at)
  VALUES (${userId}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
          ${email}, now(), now())
`

const [list] = await sql`
  INSERT INTO contact_lists (user_id, name, source_filename, column_map, consent_basis)
  VALUES (${userId}, 'Worker test list', 'seed.csv',
          ${sql.json({
            email: { role: 'email' },
            first_name: { role: 'merge_var', variable: 'first_name' },
            company: { role: 'merge_var', variable: 'company' },
          })}, 'legitimate_interest')
  RETURNING id
`

const contacts = Array.from({ length: ROWS }, (_, i) => ({
  user_id: userId,
  list_id: list.id,
  email: `person${i}@example.test`,
  email_raw: `person${i}@example.test`,
  // Every 10th row has no first name, so some rows must come out flagged.
  data: sql.json(
    i % 10 === 0
      ? { company: `Company ${i}` }
      : { first_name: `Person${i}`, company: `Company ${i}` },
  ),
  row_number: i + 2,
}))
await sql`INSERT INTO contacts ${sql(contacts as never[])}`

const [template] = await sql`
  INSERT INTO templates (user_id, name, subject_tpl, body_tpl, variables, ai_config, compliance_profile)
  VALUES (${userId}, 'Worker test template',
          'Quick question{{#if company}}, {{company}}{{/if}}',
          ${'Hi {{ first_name | default: there }},\n\nWe work with teams like {{company}}.\n\nWorth a chat?\n\n— Sam'},
          ${sql.array(['first_name', 'company'])},
          ${sql.json({ enabled: false })}, 'one_to_one')
  RETURNING id
`

const [campaign] = await sql`
  INSERT INTO campaigns (user_id, name, list_id, template_id, status, compliance_profile)
  VALUES (${userId}, 'Worker test campaign', ${list.id}, ${template.id}, 'generating', 'one_to_one')
  RETURNING id
`

await sql`
  INSERT INTO jobs (user_id, type, payload)
  VALUES (${userId}, 'campaign.generate', ${sql.json({ campaignId: campaign.id })})
`

console.log(
  JSON.stringify(
    {
      userId,
      email,
      listId: list.id,
      templateId: template.id,
      campaignId: campaign.id,
      rows: ROWS,
    },
    null,
    2,
  ),
)

await sql.end()
