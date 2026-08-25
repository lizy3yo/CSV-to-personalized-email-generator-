import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import postgres from 'postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { db } from '@/db'
import {
  auditLog,
  campaignRecipients,
  campaigns,
  contactLists,
  contacts,
  googleAccounts,
  jobs,
  suppressions,
  templates,
} from '@/db/schema'
import { seal, signUnsubscribeToken } from '@/lib/crypto'
import { peekToken, suppressByToken } from '@/lib/compliance/unsubscribe'
import { handleCampaignDispatch } from '@/lib/jobs/send'
import { idempotencyKeyFor } from '@/lib/jobs/render'
import type { JobRow } from '@/lib/queue'

/**
 * The unsubscribe loop, end to end.
 *
 * A recipient unsubscribes, and the very next dispatch of that same campaign
 * drops them. That is the whole point of checking suppression at dispatch
 * rather than at generation, and it can only be shown against a real database.
 */

const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL

async function probe(): Promise<boolean> {
  if (!url) return false
  const client = postgres(url, { max: 1, connect_timeout: 3, onnotice: () => {} })
  try {
    await client`select 1`
    return true
  } catch {
    return false
  } finally {
    await client.end({ timeout: 1 })
  }
}

const dbAvailable = await probe()

function fakeJob(userId: string, campaignId: string): JobRow {
  return {
    id: randomUUID(),
    userId,
    type: 'campaign.dispatch',
    payload: { campaignId },
    status: 'claimed',
    attempts: 1,
    maxAttempts: 500,
    runAfter: new Date(),
    lockedBy: 'test',
    lockedAt: new Date(),
    lastError: null,
    createdAt: new Date(),
    completedAt: null,
  }
}

describe.skipIf(!dbAvailable)('unsubscribe', () => {
  const raw = postgres(url!, { max: 2, onnotice: () => {} })
  const userId = randomUUID()
  let listId: string
  let templateId: string
  let campaignId: string
  let recipientId: string
  const email = 'leaving@example.test'

  beforeAll(async () => {
    await raw`
      INSERT INTO auth.users (id, instance_id, aud, role, email, created_at, updated_at)
      VALUES (${userId}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
              ${`unsub-${userId.slice(0, 8)}@example.test`}, now(), now())
    `
    // A postal address, so compliance does not block the dispatch under test.
    await raw`UPDATE profiles SET postal_address = 'Acme Ltd, 1 Main Street' WHERE id = ${userId}`

    const sealed = seal('not-a-real-refresh-token', userId)
    await db.insert(googleAccounts).values({
      userId,
      googleEmail: 'sender@example.test',
      refreshTokenCiphertext: sealed.ciphertext,
      refreshTokenIv: sealed.iv,
      refreshTokenTag: sealed.tag,
      scopes: ['https://www.googleapis.com/auth/gmail.send'],
      dailyQuotaLimit: 500,
    })

    const [list] = await db
      .insert(contactLists)
      .values({ userId, name: 'Unsub list' })
      .returning({ id: contactLists.id })
    listId = list.id

    const [template] = await db
      .insert(templates)
      .values({ userId, name: 'Unsub template', subjectTpl: 'Hi', bodyTpl: 'Body' })
      .returning({ id: templates.id })
    templateId = template.id
  })

  afterAll(async () => {
    await raw`DELETE FROM auth.users WHERE id = ${userId}`
    await raw.end()
  })

  beforeEach(async () => {
    await db.delete(campaigns).where(eq(campaigns.userId, userId))
    await db.delete(contacts).where(eq(contacts.userId, userId))
    await db.delete(suppressions).where(eq(suppressions.userId, userId))
    await db.delete(jobs).where(eq(jobs.userId, userId))
    // Cleared too, or entries accumulate across tests in this block.
    await db.delete(auditLog).where(eq(auditLog.userId, userId))

    const [campaign] = await db
      .insert(campaigns)
      .values({
        userId,
        name: 'Unsub campaign',
        listId,
        templateId,
        status: 'sending',
        sendWindowStartHour: 0,
        sendWindowEndHour: 24,
        sendWindowDays: [1, 2, 3, 4, 5, 6, 7],
      })
      .returning({ id: campaigns.id })
    campaignId = campaign.id

    const [contact] = await db
      .insert(contacts)
      .values({ userId, listId, email, emailRaw: email, data: {}, rowNumber: 2 })
      .returning({ id: contacts.id })

    const [recipient] = await db
      .insert(campaignRecipients)
      .values({
        userId,
        campaignId,
        contactId: contact.id,
        status: 'approved',
        subject: 'Hi',
        bodyText: 'Body',
        bodyHtml: '<p>Body</p>',
        idempotencyKey: idempotencyKeyFor(campaignId, contact.id),
      })
      .returning({ id: campaignRecipients.id })
    recipientId = recipient.id
  })

  it('round-trips a signed token back to the address', () => {
    const token = signUnsubscribeToken(recipientId, email)
    expect(peekToken(token)).toEqual({ recipientId, email })
  })

  it('suppresses the address behind a valid token', async () => {
    const outcome = await suppressByToken(signUnsubscribeToken(recipientId, email), 'test')

    expect(outcome.ok).toBe(true)
    expect(outcome.email).toBe(email)

    const row = await db.query.suppressions.findFirst({
      where: and(eq(suppressions.userId, userId), eq(suppressions.email, email)),
    })
    expect(row?.reason).toBe('unsubscribed')
    expect(row?.campaignId).toBe(campaignId)
  })

  it('is idempotent — a retried one-click is not an error', async () => {
    const token = signUnsubscribeToken(recipientId, email)
    const first = await suppressByToken(token, 'test')
    const second = await suppressByToken(token, 'test')

    expect(first.alreadySuppressed).toBe(false)
    expect(second.ok).toBe(true)
    expect(second.alreadySuppressed).toBe(true)

    const rows = await db
      .select({ id: suppressions.id })
      .from(suppressions)
      .where(eq(suppressions.userId, userId))
    expect(rows).toHaveLength(1)
  })

  it('records the unsubscribe once, not on every retry', async () => {
    const token = signUnsubscribeToken(recipientId, email)
    await suppressByToken(token, 'test')
    await suppressByToken(token, 'test')

    const entries = await db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(and(eq(auditLog.userId, userId), eq(auditLog.action, 'recipient.unsubscribed')))
    expect(entries).toHaveLength(1)
  })

  it('refuses a forged token', async () => {
    const token = signUnsubscribeToken(recipientId, email)
    const [payload] = token.split('.')
    expect(await suppressByToken(`${payload}.forged`, 'test')).toEqual({ ok: false })

    const rows = await db.select({ id: suppressions.id }).from(suppressions)
    expect(rows).toHaveLength(0)
  })

  it('refuses a token whose payload was swapped for another address', async () => {
    // The signature covers the address, so pointing a valid signature at a
    // different recipient does not work.
    const token = signUnsubscribeToken(recipientId, email)
    const [, mac] = token.split('.')
    const forged = Buffer.from(`${recipientId}:someone-else@example.test`).toString('base64url')
    expect(await suppressByToken(`${forged}.${mac}`, 'test')).toEqual({ ok: false })
  })

  it('drops the recipient at the very next dispatch', async () => {
    // The end-to-end point of the whole design: unsubscribing during review
    // still takes effect, because suppression is checked at dispatch.
    await suppressByToken(signUnsubscribeToken(recipientId, email), 'One-click unsubscribe')

    await handleCampaignDispatch(fakeJob(userId, campaignId))

    const after = await db.query.campaignRecipients.findFirst({
      where: eq(campaignRecipients.id, recipientId),
    })
    expect(after?.status).toBe('rejected')
    expect(after?.error).toContain('Suppressed')
    expect(after?.sentAt).toBeNull()
  })

  it('pauses the campaign rather than sending without a postal address', async () => {
    // CAN-SPAM is not negotiable, so an address deleted mid-run stops the send
    // instead of quietly posting non-compliant mail.
    await raw`UPDATE profiles SET postal_address = NULL WHERE id = ${userId}`

    await handleCampaignDispatch(fakeJob(userId, campaignId))

    const campaign = await db.query.campaigns.findFirst({ where: eq(campaigns.id, campaignId) })
    expect(campaign?.status).toBe('paused')

    const recipient = await db.query.campaignRecipients.findFirst({
      where: eq(campaignRecipients.id, recipientId),
    })
    // Returned to approved, not consumed — nothing was sent.
    expect(recipient?.status).toBe('approved')
    expect(recipient?.error).toContain('CAN-SPAM')

    await raw`UPDATE profiles SET postal_address = 'Acme Ltd, 1 Main Street' WHERE id = ${userId}`
  })
})
