import { expect, test } from './fixtures'
import { test as base } from '@playwright/test'

/**
 * The route gate.
 *
 * proxy.ts is the only thing standing between an unauthenticated request and
 * every page holding contact data, so it gets checked directly rather than
 * assumed.
 */

// A separate, unauthenticated test object — the shared fixture injects a session.
base.describe('unauthenticated', () => {
  for (const path of [
    '/',
    '/campaigns',
    '/contacts',
    '/contacts/import',
    '/templates',
    '/settings/ai',
    '/settings/compliance',
    '/suppressions',
  ]) {
    base(`redirects ${path} to login`, async ({ page }) => {
      await page.goto(path)
      await expect(page).toHaveURL(/\/login/)
    })
  }

  base('preserves where you were heading', async ({ page }) => {
    await page.goto('/templates')
    await expect(page).toHaveURL(/next=%2Ftemplates/)
  })

  base('shows the Google sign-in button and says what it will ask for', async ({ page }) => {
    await page.goto('/login')
    await expect(page.getByRole('button', { name: /Continue with Google/ })).toBeVisible()
    // The permission being requested should be stated before it is asked for.
    await expect(page.getByText(/never reads your mailbox/i)).toBeVisible()
  })

  base('leaves the unsubscribe page reachable without a session', async ({ page }) => {
    // A recipient is not a user of this app and must never be asked to sign in
    // to stop receiving mail.
    const response = await page.goto('/unsubscribe/not-a-real-token')
    expect(response?.status()).toBe(200)
    await expect(page).not.toHaveURL(/\/login/)
    await expect(page.getByText(/link is not valid/i)).toBeVisible()
  })
})

test.describe('authenticated', () => {
  test('reaches the campaigns page', async ({ page, user }) => {
    await page.goto('/campaigns')
    await expect(page).not.toHaveURL(/\/login/)
    await expect(page.getByRole('heading', { name: 'Campaigns' })).toBeVisible()
    // Scoped: the address renders in both the sidebar and the Setup card, and
    // an unscoped locator matching two elements fails Playwright's strict mode.
    await expect(page.getByRole('main').getByText(user.email)).toBeVisible()
  })

  test('reports Gmail as not connected for a fresh account', async ({ page }) => {
    await page.goto('/campaigns')
    await expect(page.getByText(/Sign out and back in to grant send permission/)).toBeVisible()
  })
})
