import { appAlert, csvFile, expect, test } from './fixtures'

/**
 * CSV import, through the real UI.
 *
 * The file is parsed in the browser, so this is the one flow where the unit
 * tests genuinely cannot stand in for an end-to-end run — PapaParse, the
 * detection heuristics and the chunked upload only meet each other here.
 */

const MESSY = [
  'Email Address,First Name,Company,Notes,Internal ID',
  'a.chen@northwind.io,Ana,"Northwind Traders, Inc.",Asked about SSO pricing and whether SCIM is coming,88213',
  'B.PARK@Cascade.dev,Bo,Cascade,Trialled last quarter then went quiet,88214',
  'a.chen@NORTHWIND.io,Ana,Northwind Traders,Duplicate row,88215',
  'not-an-email,Kim,Vertex,Bad address,88216',
  ',Lee,Delta,Missing address,88217',
].join('\r\n')

test('imports a messy CSV and reports every problem', async ({ page }) => {
  await page.goto('/contacts/import')

  await page.setInputFiles('input[type=file]', csvFile('messy.csv', MESSY))

  await expect(page.getByText('Map your columns')).toBeVisible()
  await expect(page.getByText(/messy\.csv · 5 rows/)).toBeVisible()

  // Detection: the address column found, free text as context, ids ignored.
  await expect(page.getByLabel('Role for Email Address')).toHaveValue('email')
  await expect(page.getByLabel('Role for First Name')).toHaveValue('merge_var')
  await expect(page.getByLabel('Role for Notes')).toHaveValue('ai_context')
  await expect(page.getByLabel('Role for Internal ID')).toHaveValue('ignore')

  // Classification: 2 valid, and one of each failure mode.
  await expect(page.getByText('2 ready')).toBeVisible()
  await expect(page.getByText('1 duplicate')).toBeVisible()
  await expect(page.getByText('1 invalid address')).toBeVisible()
  await expect(page.getByText('1 missing address')).toBeVisible()

  await page.getByRole('button', { name: /View 3 issues/ }).click()
  await expect(page.getByText('Same address as row 2')).toBeVisible()
  await expect(page.getByText('No @ sign')).toBeVisible()
  await expect(page.getByText('Email cell is empty')).toBeVisible()

  await page.getByRole('button', { name: /^Import 2$/ }).click()

  await expect(page).toHaveURL(/\/contacts$/)
  await expect(page.getByText('2 contacts')).toBeVisible()
  await expect(page.getByText(/3 of 5 rows were not imported/)).toBeVisible()
})

test('preserves quoted commas and normalises the address', async ({ page, db, user }) => {
  await page.goto('/contacts/import')
  await page.setInputFiles('input[type=file]', csvFile('messy.csv', MESSY))
  await page.getByRole('button', { name: /^Import 2$/ }).click()
  await expect(page).toHaveURL(/\/contacts$/)

  const rows = await db<{ email: string; email_raw: string; data: Record<string, string> }[]>`
    SELECT email, email_raw, data FROM contacts WHERE user_id = ${user.id} ORDER BY row_number
  `

  expect(rows).toHaveLength(2)
  // A comma inside a quoted field must survive the whole round trip.
  expect(rows[0].data.company).toBe('Northwind Traders, Inc.')
  // Normalised for dedupe, but the original kept for display.
  expect(rows[1].email).toBe('b.park@cascade.dev')
  expect(rows[1].email_raw).toBe('B.PARK@Cascade.dev')
  // An ignored column never leaves the browser.
  expect(rows[0].data).not.toHaveProperty('internal_id')
})

test('opens an imported list and shows which rows failed, not just how many', async ({ page }) => {
  await page.goto('/contacts/import')
  await page.setInputFiles('input[type=file]', csvFile('messy.csv', MESSY))
  await page.getByRole('button', { name: /^Import 2$/ }).click()
  await expect(page).toHaveURL(/\/contacts$/)

  // The card separates a malformed address from a blank cell, matching what
  // the import wizard said a moment earlier.
  await expect(page.getByText('1 invalid address')).toBeVisible()
  await expect(page.getByText('1 missing address')).toBeVisible()

  // The card is a link — the whole point is that the claim can be opened.
  await page.locator('a[href^="/contacts/"]:not([href$="/import"])').first().click()
  await expect(page).toHaveURL(/\/contacts\/[0-9a-f-]{36}$/)

  await expect(page.getByRole('link', { name: 'Contacts 2' })).toBeVisible()
  // The two rows that made it, with their data.
  await expect(page.getByRole('cell', { name: 'a.chen@northwind.io' })).toBeVisible()
  await expect(page.getByRole('cell', { name: 'Northwind Traders, Inc.' })).toBeVisible()

  // Each rejected row, with the reason attached.
  await page.getByRole('link', { name: 'Invalid address 1' }).click()
  await expect(page.getByRole('cell', { name: 'not-an-email' })).toBeVisible()
  await expect(page.getByRole('cell', { name: 'No @ sign' })).toBeVisible()

  await page.getByRole('link', { name: 'Duplicate 1' }).click()
  await expect(page.getByRole('cell', { name: 'Same address as row 2' })).toBeVisible()

  await page.getByRole('link', { name: 'Missing address 1' }).click()
  await expect(page.getByRole('cell', { name: 'Email cell is empty' })).toBeVisible()
  await expect(page.getByRole('cell', { name: 'empty', exact: true })).toBeVisible()
})

test('refuses a file that is not a CSV', async ({ page }) => {
  await page.goto('/contacts/import')
  await page.setInputFiles('input[type=file]', {
    name: 'contacts.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: Buffer.from('not a csv'),
  })
  await expect(appAlert(page)).toContainText('Expected a .csv, .tsv or .txt file')
})

test('refuses a file with headers but no rows', async ({ page }) => {
  await page.goto('/contacts/import')
  await page.setInputFiles('input[type=file]', csvFile('empty.csv', 'email,name\n'))
  await expect(appAlert(page)).toContainText('no data rows')
})

test('blocks the import when no column is mapped to email', async ({ page }) => {
  await page.goto('/contacts/import')
  await page.setInputFiles('input[type=file]', csvFile('x.csv', 'thing,other\na,b\n'))

  // Nothing here looks like an address, so nothing is mapped to email.
  await expect(page.getByText(/No column is mapped to Email/)).toBeVisible()
  await expect(page.getByRole('button', { name: /^Import 0$/ })).toBeDisabled()
})
