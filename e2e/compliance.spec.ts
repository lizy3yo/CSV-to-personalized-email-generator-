import { csvFile, expect, runWorker, test } from './fixtures'
import { test as base } from '@playwright/test'

/**
 * The gates.
 *
 * These are the checks that stop something being sent, so an E2E run is where
 * they are worth asserting: a unit test proves the rule, this proves the rule
 * is actually wired to the button.
 *
 * Nothing here sends mail. The furthest any test goes is confirming that the
 * send button is disabled and why.
 */

const CONTACTS = 'email,first_name\nana@northwind.io,Ana\n'

async function buildApprovedCampaign(page: import('@playwright/test').Page): Promise<string> {
  await page.goto('/contacts/import')
  await page.setInputFiles('input[type=file]', csvFile('c.csv', CONTACTS))
  await page.getByRole('button', { name: /^Import 1$/ }).click()
  await expect(page).toHaveURL(/\/contacts$/)

  await page.goto('/templates/new')
  await page.getByLabel('Template name').fill('Gate template')
  await page.locator('#subject').fill('Hello')
  await page.locator('#body').fill('Hi {{ first_name | default: there }},\n\nBody.\n\n— Sam')
  await page.getByRole('button', { name: /^Create$/ }).click()
  await expect(page).toHaveURL(/\/templates\/[0-9a-f-]{36}$/)

  await page.goto('/campaigns/new')
  await page.getByLabel('Campaign name').fill('Gate campaign')
  await page.getByRole('button', { name: /Create and generate/ }).click()
  await expect(page).toHaveURL(/\/campaigns\/[0-9a-f-]{36}$/)
  const url = page.url()

  await runWorker(page)

  await page.goto(`${url}/review`)
  await page.getByRole('button', { name: /^All \d+$/ }).click()
  await page.locator('input[type=checkbox]').first().check()
  await page.getByRole('button', { name: 'Approve', exact: true }).click()
  await expect(page.getByText('1 of 1 approved to send')).toBeVisible()

  return url
}

test('the send preflight blocks without Gmail and without a postal address', async ({ page }) => {
  const url = await buildApprovedCampaign(page)
  await page.goto(`${url}/send`)

  // Gmail is not connected in a test account, and no address has been set.
  await expect(page.getByText('Sign in with Google to grant send permission')).toBeVisible()
  await expect(page.getByText(/CAN-SPAM requires a valid physical postal address/)).toBeVisible()

  // The button exists but cannot be used, and the page says how many checks fail.
  await expect(page.getByRole('button', { name: /Start sending/ })).toBeDisabled()
  await expect(page.getByText(/preflight check/)).toBeVisible()
})

test('setting a postal address clears that one blocker', async ({ page }) => {
  const url = await buildApprovedCampaign(page)

  await page.goto('/settings/compliance')
  await expect(page.getByText(/No postal address is set, so sending is blocked/)).toBeVisible()

  await page.locator('#postal').fill('Acme Ltd\n1 Main Street\nBristol BS1 4ST')
  await page.getByRole('button', { name: /^Save$/ }).click()
  await expect(page.getByText('Saved')).toBeVisible()

  // The footer preview shows exactly what will be appended at send time.
  await expect(page.getByText(/Acme Ltd, 1 Main Street, Bristol BS1 4ST/)).toBeVisible()

  await page.goto(`${url}/send`)
  await expect(page.getByText('Present, and appended to every message')).toBeVisible()
  // Still blocked, but on Gmail now rather than compliance.
  await expect(page.getByRole('button', { name: /Start sending/ })).toBeDisabled()
})

test('a suppressed contact never becomes sendable', async ({ page, db, user }) => {
  await page.goto('/suppressions')
  await page.locator('#emails').fill('ana@northwind.io')
  await page.getByRole('button', { name: /Add to suppression list/ }).click()
  await expect(page.getByText(/1 added/)).toBeVisible()

  await page.goto('/contacts/import')
  await page.setInputFiles('input[type=file]', csvFile('c.csv', CONTACTS))

  // The suppression is reported before import, not discovered at send time.
  await expect(page.getByText('1 suppressed')).toBeVisible()
  await expect(page.getByRole('button', { name: /^Import 0$/ })).toBeDisabled()

  const [row] = await db<{ count: number }[]>`
    SELECT count(*)::int AS count FROM contacts WHERE user_id = ${user.id}
  `
  expect(row.count).toBe(0)
})

base.describe('unsubscribe', () => {
  base('a GET does not unsubscribe anyone', async ({ page }) => {
    // Mail scanners prefetch every link in a message. A GET that acted would
    // unsubscribe people who never clicked.
    await page.goto('/unsubscribe/some-token-shaped-string')
    await expect(page.getByRole('heading')).toContainText(/Unsubscribe|not valid/)
    await expect(page.getByText(/Nothing has happened yet|link is not valid/)).toBeVisible()
  })

  base('the one-click endpoint answers 200 even for a bad token', async ({ request }) => {
    // A non-2xx would tell a caller whether an address is on a list, and RFC
    // 8058 clients treat it as a failure worth retrying.
    const response = await request.post('/api/unsubscribe/definitely-not-a-valid-token')
    expect(response.status()).toBe(200)
  })
})
