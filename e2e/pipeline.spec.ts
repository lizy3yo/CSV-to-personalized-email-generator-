import { csvFile, expect, runWorker, test } from './fixtures'

/**
 * The whole pipeline, in one run.
 *
 * Import → template → campaign → generate → review → approve, driven through
 * the real UI against the real database and the real queue. Everything except
 * the Gmail call itself.
 *
 * The template deliberately has no `{{ai:}}` slot, so this needs no Anthropic
 * key and asserts something worth asserting on its own: the app is fully
 * usable in template-only mode.
 */

const CONTACTS = [
  'email,first_name,company',
  'ana@northwind.io,Ana,Northwind Traders',
  'bo@cascade.dev,,Cascade',
  'carlos@vertex.io,CARLOS,',
].join('\n')

const SUBJECT = 'Quick question{{#if company}}, {{company}}{{/if}}'
const BODY = [
  'Hi {{ first_name | capitalize | default: there }},',
  '',
  'We work with teams like yours.',
  '',
  '— Sam',
].join('\n')

test('import, template, generate, review, approve', async ({ page, db, user }) => {
  // ── 1. import ──────────────────────────────────────────────────────────────
  await page.goto('/contacts/import')
  await page.setInputFiles('input[type=file]', csvFile('contacts.csv', CONTACTS))
  await page.getByRole('button', { name: /^Import 3$/ }).click()
  await expect(page).toHaveURL(/\/contacts$/)
  await expect(page.getByText('3 contacts')).toBeVisible()

  // ── 2. template ────────────────────────────────────────────────────────────
  await page.goto('/templates/new')
  await page.getByLabel('Template name').fill('E2E template')
  await page.locator('#subject').fill(SUBJECT)
  await page.locator('#body').fill(BODY)

  // The preview runs against a sample contact until a list is chosen.
  await expect(page.getByText('Quick question, Northwind Traders')).toBeVisible()

  await page.getByRole('button', { name: /^Create$/ }).click()
  await expect(page).toHaveURL(/\/templates\/[0-9a-f-]{36}$/)

  // ── 3. campaign ────────────────────────────────────────────────────────────
  await page.goto('/campaigns/new')
  await page.getByLabel('Campaign name').fill('E2E campaign')
  await page.getByRole('button', { name: /Create and generate/ }).click()
  await expect(page).toHaveURL(/\/campaigns\/[0-9a-f-]{36}$/)

  // ── 4. generate ────────────────────────────────────────────────────────────
  // No long-running worker here; the cron endpoint runs the same handlers.
  await runWorker(page)
  await page.reload()

  await expect(page.getByText('3 of 3 generated')).toBeVisible()

  // Rendering is correct per row, including the cases that only appear in data.
  const rendered = await db<{ email: string; subject: string; body_text: string }[]>`
    SELECT c.email, r.subject, r.body_text
    FROM campaign_recipients r JOIN contacts c ON c.id = r.contact_id
    WHERE r.user_id = ${user.id} ORDER BY c.row_number
  `
  expect(rendered).toHaveLength(3)
  expect(rendered[0].subject).toBe('Quick question, Northwind Traders')
  expect(rendered[0].body_text).toContain('Hi Ana,')
  // Empty first_name falls back rather than rendering "Hi ,".
  expect(rendered[1].body_text).toContain('Hi there,')
  // Empty company drops the dangling comma; the filter tidies a shouty export.
  expect(rendered[2].subject).toBe('Quick question')
  expect(rendered[2].body_text).toContain('Hi Carlos,')

  // ── 5. review ──────────────────────────────────────────────────────────────
  const campaignUrl = page.url()
  await page.goto(`${campaignUrl}/review`)

  await expect(page.getByText('0 of 3 approved to send')).toBeVisible()

  // Generation finishing is not a decision — nothing is sendable yet.
  const [before] = await db<{ count: number }[]>`
    SELECT count(*)::int AS count FROM campaign_recipients
    WHERE user_id = ${user.id} AND status = 'approved'
  `
  expect(before.count).toBe(0)

  // ── 6. approve ─────────────────────────────────────────────────────────────
  await page.getByRole('button', { name: /^All \d+$/ }).click()
  await page.locator('input[type=checkbox]').first().check()
  await page.getByRole('button', { name: 'Approve', exact: true }).click()

  await expect(page.getByText('3 of 3 approved to send')).toBeVisible()

  const [after] = await db<{ count: number }[]>`
    SELECT count(*)::int AS count FROM campaign_recipients
    WHERE user_id = ${user.id} AND status = 'approved'
  `
  expect(after.count).toBe(3)
})

test('an error-flagged row cannot be approved', async ({ page, db, user }) => {
  await page.goto('/contacts/import')
  await page.setInputFiles('input[type=file]', csvFile('c.csv', CONTACTS))
  await page.getByRole('button', { name: /^Import 3$/ }).click()
  await expect(page).toHaveURL(/\/contacts$/)

  await page.goto('/templates/new')
  await page.getByLabel('Template name').fill('Gate template')
  await page.locator('#subject').fill('Hi')
  await page.locator('#body').fill('Body')
  await page.getByRole('button', { name: /^Create$/ }).click()
  await expect(page).toHaveURL(/\/templates\/[0-9a-f-]{36}$/)

  await page.goto('/campaigns/new')
  await page.getByLabel('Campaign name').fill('Gate campaign')
  await page.getByRole('button', { name: /Create and generate/ }).click()
  await expect(page).toHaveURL(/\/campaigns\/[0-9a-f-]{36}$/)
  const campaignUrl = page.url()

  await runWorker(page)

  // Break one row the way a real generation failure would.
  await db`
    UPDATE campaign_recipients
    SET status = 'flagged', flags = ARRAY['error:empty_body'], body_text = ''
    WHERE user_id = ${user.id}
      AND id = (SELECT id FROM campaign_recipients WHERE user_id = ${user.id} LIMIT 1)
  `

  await page.goto(`${campaignUrl}/review`)
  await page.getByRole('button', { name: /^All \d+$/ }).click()
  await page.locator('input[type=checkbox]').first().check()
  await page.getByRole('button', { name: 'Approve', exact: true }).click()

  // Partial success, reported precisely — the two good rows go through and the
  // broken one is named rather than the whole batch being refused.
  await expect(page.getByText(/2 of 3 approved to send/)).toBeVisible()
  await expect(page.getByText(/could not be approved — they have errors/)).toBeVisible()
  await expect(page.getByText('1 blocked by errors')).toBeVisible()

  const [approved] = await db<{ count: number }[]>`
    SELECT count(*)::int AS count FROM campaign_recipients
    WHERE user_id = ${user.id} AND status = 'approved'
  `
  expect(approved.count).toBe(2)
})
