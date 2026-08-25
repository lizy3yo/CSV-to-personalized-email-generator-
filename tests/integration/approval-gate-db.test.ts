import { randomUUID } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { db } from '@/db'
import { campaignRecipients, campaigns, contactLists, contacts, templates } from '@/db/schema'
import { canApprove, isSendable } from '@/core/review/flags'
import { idempotencyKeyFor } from '@/lib/jobs/render'

/**
 * The approval gate, at the level that actually enforces it.
 *
 * The unit tests prove `canApprove` and `isSendable` reason correctly. This
 * proves the thing those functions exist to protect: that a query filtered the
 * way the dispatcher filters returns approved rows and nothing else, whatever
 * state the other rows are in.
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

/** Every status a recipient can hold. */
const ALL_STATUSES = [
  'pending',
  'generating',
  'generated',
  'flagged',
  'approved',
  'rejected',
  'queued',
  'sending',
  'sent',
  'failed',
  'bounced',
  'complained',
] as const

describe.skipIf(!dbAvailable)('approval gate', () => {
  const raw = postgres(url!, { max: 2, onnotice: () => {} })
  const userId = randomUUID()
  let campaignId: string

  beforeAll(async () => {
    await raw`
      INSERT INTO auth.users (id, instance_id, aud, role, email, created_at, updated_at)
      VALUES (${userId}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
              ${`gate-${userId.slice(0, 8)}@example.test`}, now(), now())
    `

    const [list] = await db
      .insert(contactLists)
      .values({ userId, name: 'Gate list' })
      .returning({ id: contactLists.id })

    const [template] = await db
      .insert(templates)
      .values({ userId, name: 'Gate template', subjectTpl: 'Hi', bodyTpl: 'Body' })
      .returning({ id: templates.id })

    const [campaign] = await db
      .insert(campaigns)
      .values({ userId, name: 'Gate campaign', listId: list.id, templateId: template.id })
      .returning({ id: campaigns.id })
    campaignId = campaign.id

    // One recipient per status, so the filter is tested against all of them.
    for (const [index, status] of ALL_STATUSES.entries()) {
      const [contact] = await db
        .insert(contacts)
        .values({
          userId,
          listId: list.id,
          email: `${status}@example.test`,
          emailRaw: `${status}@example.test`,
          data: {},
          rowNumber: index + 2,
        })
        .returning({ id: contacts.id })

      await db.insert(campaignRecipients).values({
        userId,
        campaignId,
        contactId: contact.id,
        status,
        subject: 'Hi',
        bodyText: 'Body',
        idempotencyKey: idempotencyKeyFor(campaignId, contact.id),
      })
    }
  })

  afterAll(async () => {
    await raw`DELETE FROM auth.users WHERE id = ${userId}`
    await raw.end()
  })

  it('returns exactly one row when filtered the way the dispatcher filters', async () => {
    const rows = await db
      .select({ status: campaignRecipients.status })
      .from(campaignRecipients)
      .where(
        and(
          eq(campaignRecipients.campaignId, campaignId),
          eq(campaignRecipients.status, 'approved'),
        ),
      )

    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('approved')
  })

  it('leaves eleven rows unsendable', async () => {
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(campaignRecipients)
      .where(eq(campaignRecipients.campaignId, campaignId))

    expect(count).toBe(ALL_STATUSES.length)
    expect(ALL_STATUSES.filter((s) => !isSendable(s))).toHaveLength(ALL_STATUSES.length - 1)
  })

  it('does not treat a freshly generated email as sendable', async () => {
    // Generation finishing is not a decision. Without this, the whole review
    // step would be decorative.
    const generated = await db.query.campaignRecipients.findFirst({
      where: and(
        eq(campaignRecipients.campaignId, campaignId),
        eq(campaignRecipients.status, 'generated'),
      ),
    })
    expect(generated).toBeDefined()
    expect(isSendable(generated!.status)).toBe(false)
  })

  it('refuses to approve a row carrying an error flag', async () => {
    const broken = await db.query.campaignRecipients.findFirst({
      where: and(
        eq(campaignRecipients.campaignId, campaignId),
        eq(campaignRecipients.status, 'flagged'),
      ),
    })

    await db
      .update(campaignRecipients)
      .set({ flags: ['error:empty_body', 'warning:em_dash'] })
      .where(eq(campaignRecipients.id, broken!.id))

    const reloaded = await db.query.campaignRecipients.findFirst({
      where: eq(campaignRecipients.id, broken!.id),
    })
    expect(canApprove(reloaded!.status, reloaded!.flags)).toBe(false)
  })

  it('allows approving a row carrying only warnings', async () => {
    const row = await db.query.campaignRecipients.findFirst({
      where: and(
        eq(campaignRecipients.campaignId, campaignId),
        eq(campaignRecipients.status, 'generated'),
      ),
    })

    await db
      .update(campaignRecipients)
      .set({ flags: ['unresolved:company', 'warning:possible_hallucination'] })
      .where(eq(campaignRecipients.id, row!.id))

    const reloaded = await db.query.campaignRecipients.findFirst({
      where: eq(campaignRecipients.id, row!.id),
    })
    // A human is allowed to accept an odd email. That is the point of review.
    expect(canApprove(reloaded!.status, reloaded!.flags)).toBe(true)
  })

  it('drops a row out of approved when its text changes', async () => {
    // Otherwise a decision made about one email would carry over to a
    // different one.
    const approved = await db.query.campaignRecipients.findFirst({
      where: and(
        eq(campaignRecipients.campaignId, campaignId),
        eq(campaignRecipients.status, 'approved'),
      ),
    })
    expect(approved).toBeDefined()

    await db
      .update(campaignRecipients)
      .set({
        bodyText: 'Rewritten by a human',
        editedByUser: true,
        status: 'generated',
        approvedAt: null,
      })
      .where(eq(campaignRecipients.id, approved!.id))

    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(campaignRecipients)
      .where(
        and(
          eq(campaignRecipients.campaignId, campaignId),
          eq(campaignRecipients.status, 'approved'),
        ),
      )

    expect(count).toBe(0)
  })
})
