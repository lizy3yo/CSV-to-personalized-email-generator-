import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import postgres from 'postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { db } from '@/db'
import {
  campaignRecipients,
  campaigns,
  contactLists,
  contacts,
  googleAccounts,
  jobs,
  suppressions,
  templates,
} from '@/db/schema'
import { seal } from '@/lib/crypto'
import { handleCampaignDispatch } from '@/lib/jobs/send'
import { idempotencyKeyFor } from '@/lib/jobs/render'
import type { JobRow } from '@/lib/queue'

/**
 * The dispatcher, against a real database.
 *
 * Everything up to the Gmail call is exercised: the approved-only claim, the
 * suppression check, and the pacing gate. None of these reach the network —
 * a suppressed or unapproved recipient is resolved before a request would be
 * made, which is exactly the property worth proving.
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

describe.skipIf(!dbAvailable)('campaign dispatch', () => {
  const raw = postgres(url!, { max: 2, onnotice: () => {} })
  const userId = randomUUID()
  let listId: string
  let templateId: string
  let campaignId: string

  beforeAll(async () => {
    await raw`
      INSERT INTO auth.users (id, instance_id, aud, role, email, created_at, updated_at)
      VALUES (${userId}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
              ${`dispatch-${userId.slice(0, 8)}@example.test`}, now(), now())
    `

    // A Gmail account row so the dispatcher gets past its connectivity check.
    // The refresh token is nonsense — nothing here should ever reach Google.
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
      .values({ userId, name: 'Dispatch list' })
      .returning({ id: contactLists.id })
    listId = list.id

    const [template] = await db
      .insert(templates)
      .values({ userId, name: 'Dispatch template', subjectTpl: 'Hi', bodyTpl: 'Body' })
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

    const [campaign] = await db
      .insert(campaigns)
      .values({
        userId,
        name: 'Dispatch campaign',
        listId,
        templateId,
        status: 'sending',
        ratePerHour: 40,
        // The window is deliberately wide so these tests are not
        // time-of-day dependent.
        sendWindowStartHour: 0,
        sendWindowEndHour: 24,
        sendWindowDays: [1, 2, 3, 4, 5, 6, 7],
      })
      .returning({ id: campaigns.id })
    campaignId = campaign.id
  })

  async function addRecipient(email: string, status: 'approved' | 'generated' | 'flagged') {
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
        status,
        subject: 'Hi',
        bodyText: 'Body',
        bodyHtml: '<p>Body</p>',
        idempotencyKey: idempotencyKeyFor(campaignId, contact.id),
      })
      .returning({ id: campaignRecipients.id })

    return recipient.id
  }

  it('drops a suppressed recipient without attempting a send', async () => {
    // The suppression list is checked at DISPATCH, not at generation — someone
    // who unsubscribes mid-review must still be dropped.
    const id = await addRecipient('blocked@example.test', 'approved')
    await db.insert(suppressions).values({
      userId,
      email: 'blocked@example.test',
      reason: 'unsubscribed',
      source: 'test',
    })

    // Reaching Google would throw, because the refresh token is nonsense.
    await handleCampaignDispatch(fakeJob(userId, campaignId))

    const after = await db.query.campaignRecipients.findFirst({
      where: eq(campaignRecipients.id, id),
    })
    expect(after?.status).toBe('rejected')
    expect(after?.error).toContain('Suppressed')
    expect(after?.gmailMessageId).toBeNull()
    expect(after?.sentAt).toBeNull()
  })

  it('never claims a recipient that is not approved', async () => {
    // The one guarantee the whole review step exists to provide.
    await addRecipient('generated@example.test', 'generated')
    await addRecipient('flagged@example.test', 'flagged')

    await handleCampaignDispatch(fakeJob(userId, campaignId))

    const rows = await db
      .select({ status: campaignRecipients.status })
      .from(campaignRecipients)
      .where(eq(campaignRecipients.campaignId, campaignId))

    expect(rows.map((r) => r.status).sort()).toEqual(['flagged', 'generated'])
  })

  it('completes the campaign when nothing is approved', async () => {
    await addRecipient('generated@example.test', 'generated')

    await handleCampaignDispatch(fakeJob(userId, campaignId))

    const campaign = await db.query.campaigns.findFirst({ where: eq(campaigns.id, campaignId) })
    expect(campaign?.status).toBe('completed')
    expect(campaign?.completedAt).toBeInstanceOf(Date)
  })

  it('reschedules instead of failing when the window is closed', async () => {
    await addRecipient('waiting@example.test', 'approved')
    // A window that cannot be open right now.
    await db
      .update(campaigns)
      .set({ sendWindowStartHour: 3, sendWindowEndHour: 4, sendWindowDays: [] })
      .where(eq(campaigns.id, campaignId))

    await handleCampaignDispatch(fakeJob(userId, campaignId))

    const queued = await db
      .select({ type: jobs.type, runAfter: jobs.runAfter })
      .from(jobs)
      .where(and(eq(jobs.userId, userId), eq(jobs.type, 'campaign.dispatch')))

    // Waiting is not failing — the job reschedules rather than burning a retry.
    expect(queued).toHaveLength(1)
    expect(queued[0].runAfter.getTime()).toBeGreaterThan(Date.now())

    const recipient = await db.query.campaignRecipients.findFirst({
      where: eq(campaignRecipients.campaignId, campaignId),
    })
    expect(recipient?.status).toBe('approved')
  })

  it('does nothing at all while paused', async () => {
    await addRecipient('paused@example.test', 'approved')
    await db.update(campaigns).set({ status: 'paused' }).where(eq(campaigns.id, campaignId))

    await handleCampaignDispatch(fakeJob(userId, campaignId))

    const recipient = await db.query.campaignRecipients.findFirst({
      where: eq(campaignRecipients.campaignId, campaignId),
    })
    expect(recipient?.status).toBe('approved')

    const queued = await db.select({ id: jobs.id }).from(jobs).where(eq(jobs.userId, userId))
    // Pausing works by declining to reschedule.
    expect(queued).toHaveLength(0)
  })

  it('marks a recipient failed rather than sent when Gmail cannot be reached', async () => {
    // The refresh token is nonsense, so the token exchange fails. The row must
    // not end up looking sent.
    const id = await addRecipient('real@example.test', 'approved')

    await handleCampaignDispatch(fakeJob(userId, campaignId))

    const after = await db.query.campaignRecipients.findFirst({
      where: eq(campaignRecipients.id, id),
    })
    expect(after?.status).not.toBe('sent')
    expect(after?.sentAt).toBeNull()
    expect(after?.gmailMessageId).toBeNull()
    expect(after?.error).toBeTruthy()
  })
})
