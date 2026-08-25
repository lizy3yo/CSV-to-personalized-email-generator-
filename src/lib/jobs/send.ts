/**
 * NOT marked `server-only` — see the note in src/lib/queue/index.ts. The
 * worker imports this by design.
 */

import { and, eq, gte, inArray, sql } from 'drizzle-orm'
import { db } from '@/db'
import {
  auditLog,
  campaignRecipients,
  campaigns,
  contacts,
  googleAccounts,
  suppressions,
} from '@/db/schema'
import { enqueue, type JobRow } from '@/lib/queue'
import { getAccessToken } from '@/lib/gmail/auth'
import { describeSendError, sendMessage } from '@/lib/gmail/send'
import { canSendNow } from '@/core/gmail/pacing'
import { messageIdFor } from '@/core/gmail/message'
import { appendFooter, checkCompliance } from '@/core/compliance/footer'
import { unsubscribePageUrlFor, unsubscribeUrlFor } from '@/lib/compliance/unsubscribe'
import { textToHtml } from '@/core/template/html'
import { profiles, contactLists } from '@/db/schema'

/**
 * The dispatcher.
 *
 * One email per job run, then the job reschedules itself at the pace interval.
 * A batch-per-run would be less overhead, but pacing would become approximate
 * — and the limit being respected is worth more than the saved job rows.
 *
 * Three properties this is built around:
 *
 *  1. **The approved-only gate.** The claim query filters on `status =
 *     'approved'` and nothing else. Every other state is unreachable from here.
 *
 *  2. **Claim before send.** A recipient moves `approved → sending` in one
 *     conditional UPDATE. Whoever wins that row sends it; a second worker sees
 *     no rows and does nothing.
 *
 *  3. **No blind retry of an in-flight send.** Gmail has no idempotency
 *     parameter, so a request that times out may or may not have delivered.
 *     Such rows stay in `sending` and are surfaced for a human, never
 *     silently resent.
 */

const DAY_MS = 24 * 60 * 60 * 1000

/** Sends made by this user in the last 24 hours, for quota and throttle. */
async function recentSends(userId: string): Promise<Date[]> {
  const rows = await db
    .select({ sentAt: campaignRecipients.sentAt })
    .from(campaignRecipients)
    .where(
      and(
        eq(campaignRecipients.userId, userId),
        eq(campaignRecipients.status, 'sent'),
        gte(campaignRecipients.sentAt, new Date(Date.now() - DAY_MS)),
      ),
    )
  return rows.map((row) => row.sentAt).filter((d): d is Date => d !== null)
}

/**
 * Take exactly one approved recipient, atomically.
 *
 * `FOR UPDATE SKIP LOCKED` inside the sub-select means two dispatchers running
 * at once take different rows rather than the same one.
 */
async function claimOneApproved(campaignId: string) {
  const [claimed] = await db
    .update(campaignRecipients)
    .set({ status: 'sending', attempts: sql`${campaignRecipients.attempts} + 1` })
    .where(
      sql`${campaignRecipients.id} IN (
        SELECT id FROM ${campaignRecipients}
        WHERE campaign_id = ${campaignId} AND status = 'approved'
        ORDER BY created_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )`,
    )
    .returning()
  return claimed ?? null
}

async function remainingApproved(campaignId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(campaignRecipients)
    .where(
      and(eq(campaignRecipients.campaignId, campaignId), eq(campaignRecipients.status, 'approved')),
    )
  return row?.count ?? 0
}

async function finishCampaign(campaignId: string, userId: string): Promise<void> {
  await db
    .update(campaigns)
    .set({ status: 'completed', completedAt: new Date() })
    .where(eq(campaigns.id, campaignId))

  await db.insert(auditLog).values({
    userId,
    action: 'campaign.send_completed',
    entityType: 'campaign',
    entityId: campaignId,
  })
}

/** Milliseconds between sends implied by the throttle. */
function paceIntervalMs(ratePerHour: number): number {
  if (ratePerHour <= 0) return 1000
  return Math.max(1000, Math.round((60 * 60 * 1000) / ratePerHour))
}

export const handleCampaignDispatch = async (job: JobRow): Promise<void> => {
  const campaignId = String(job.payload.campaignId)

  const campaign = await db.query.campaigns.findFirst({ where: eq(campaigns.id, campaignId) })
  if (!campaign) throw new Error(`Campaign ${campaignId} not found`)

  // A pause or cancel takes effect by simply not rescheduling.
  if (campaign.status === 'paused' || campaign.status === 'cancelled') return
  if (campaign.status !== 'sending') {
    await db.update(campaigns).set({ status: 'sending' }).where(eq(campaigns.id, campaignId))
  }

  if ((await remainingApproved(campaignId)) === 0) {
    await finishCampaign(campaignId, campaign.userId)
    return
  }

  const account = campaign.googleAccountId
    ? await db.query.googleAccounts.findFirst({
        where: eq(googleAccounts.id, campaign.googleAccountId),
      })
    : await db.query.googleAccounts.findFirst({
        where: eq(googleAccounts.userId, campaign.userId),
      })

  if (!account) throw new Error('No Gmail account is connected')

  const decision = canSendNow({
    now: new Date(),
    recentSends: await recentSends(campaign.userId),
    dailyLimit: account.dailyQuotaLimit,
    ratePerHour: campaign.ratePerHour,
    windowStartHour: campaign.sendWindowStartHour,
    windowEndHour: campaign.sendWindowEndHour,
    windowDays: campaign.sendWindowDays,
  })

  if (!decision.allowed) {
    // Not a failure — the campaign is simply waiting. Rescheduling rather than
    // throwing keeps the retry budget for real errors.
    //
    // The floor is deliberate: any pacing bug that produced a past or present
    // `retryAt` would otherwise turn this into a hot loop, re-enqueuing itself
    // thousands of times a second.
    const earliest = Date.now() + 30_000
    const retryAt = new Date(Math.max(decision.retryAt?.getTime() ?? 0, earliest))

    await enqueue({
      userId: campaign.userId,
      type: 'campaign.dispatch',
      payload: { campaignId },
      runAfter: retryAt,
      maxAttempts: 500,
    })
    return
  }

  const recipient = await claimOneApproved(campaignId)
  if (!recipient) {
    await finishCampaign(campaignId, campaign.userId)
    return
  }

  const contact = await db.query.contacts.findFirst({
    where: eq(contacts.id, recipient.contactId),
  })

  if (!contact) {
    await db
      .update(campaignRecipients)
      .set({ status: 'failed', error: 'Contact no longer exists' })
      .where(eq(campaignRecipients.id, recipient.id))
    await scheduleNext(campaign.userId, campaignId, campaign.ratePerHour)
    return
  }

  // Suppression is checked HERE, at dispatch, not at generation. Someone who
  // unsubscribed while the campaign was being reviewed must still be dropped.
  const suppressed = await db.query.suppressions.findFirst({
    where: and(eq(suppressions.userId, campaign.userId), eq(suppressions.email, contact.email)),
  })

  if (suppressed) {
    await db
      .update(campaignRecipients)
      .set({ status: 'rejected', error: `Suppressed: ${suppressed.reason}` })
      .where(eq(campaignRecipients.id, recipient.id))

    await db.insert(auditLog).values({
      userId: campaign.userId,
      action: 'recipient.suppressed_at_dispatch',
      entityType: 'campaign_recipient',
      entityId: recipient.id,
      after: { email: contact.email, reason: suppressed.reason },
    })

    await scheduleNext(campaign.userId, campaignId, campaign.ratePerHour)
    return
  }

  const domain = account.googleEmail.split('@')[1] ?? 'localhost'

  // Compliance is composed at SEND time, not at generation: the unsubscribe
  // token is per-recipient, and a postal address corrected after generation
  // must apply to everything still unsent.
  const profile = await db.query.profiles.findFirst({ where: eq(profiles.id, campaign.userId) })
  const list = campaign.listId
    ? await db.query.contactLists.findFirst({ where: eq(contactLists.id, campaign.listId) })
    : null

  const oneClickUrl = unsubscribeUrlFor(recipient.id, contact.email)
  const visibleUrl = unsubscribePageUrlFor(recipient.id, contact.email)

  const footerInput = {
    profile: campaign.complianceProfile,
    unsubscribeUrl: campaign.complianceProfile === 'bulk' ? visibleUrl : oneClickUrl,
    postalAddress: profile?.postalAddress,
    optOutLine: profile?.optOutLine,
    consentSource: list?.consentSource,
  }

  // Last line of defence. The preflight blocks a non-compliant campaign before
  // it starts, but a postal address deleted mid-run must stop the send rather
  // than quietly post non-compliant mail.
  const blocking = checkCompliance(footerInput).filter((issue) => issue.blocking)
  if (blocking.length > 0) {
    await db
      .update(campaignRecipients)
      .set({ status: 'approved', error: blocking.map((i) => i.message).join(' ') })
      .where(eq(campaignRecipients.id, recipient.id))

    await db.update(campaigns).set({ status: 'paused' }).where(eq(campaigns.id, campaignId))
    await db.insert(auditLog).values({
      userId: campaign.userId,
      action: 'campaign.paused_non_compliant',
      entityType: 'campaign',
      entityId: campaignId,
      after: { issues: blocking.map((i) => i.code) },
    })
    return
  }

  const bodyText = appendFooter(recipient.bodyText ?? '', footerInput)

  try {
    const result = await sendMessage({
      userId: campaign.userId,
      googleAccountId: account.id,
      fromEmail: account.googleEmail,
      fromName: profile?.senderName ?? undefined,
      to: contact.email,
      subject: recipient.subject ?? '',
      text: bodyText,
      // Regenerated from the footered text so the two halves of the multipart
      // message cannot disagree about the unsubscribe link.
      html: textToHtml(bodyText),
      // Deterministic, so a resend of this row carries the identical id.
      messageId: messageIdFor(recipient.idempotencyKey, domain),
      // Gmail shows its native one-click control when both headers are present.
      listUnsubscribe: { url: oneClickUrl },
      threadId: campaign.threadFollowUps ? (recipient.gmailThreadId ?? undefined) : undefined,
    })

    await db
      .update(campaignRecipients)
      .set({
        status: 'sent',
        sentAt: new Date(),
        gmailMessageId: result.messageId,
        gmailThreadId: result.threadId,
        error: null,
      })
      .where(eq(campaignRecipients.id, recipient.id))
  } catch (error) {
    const described = describeSendError(error)

    // Retryable means the message was NOT accepted, so returning the row to
    // `approved` cannot cause a duplicate. Anything else stops here for a
    // human, because a resend might be a second delivery.
    await db
      .update(campaignRecipients)
      .set({
        status: described.retryable && recipient.attempts < 5 ? 'approved' : 'failed',
        error: described.message.slice(0, 2000),
      })
      .where(eq(campaignRecipients.id, recipient.id))

    if (described.needsReconnect) {
      await db.update(campaigns).set({ status: 'paused' }).where(eq(campaigns.id, campaignId))
      await db.insert(auditLog).values({
        userId: campaign.userId,
        action: 'campaign.paused_needs_reconnect',
        entityType: 'campaign',
        entityId: campaignId,
        after: { error: described.message },
      })
      return
    }
  }

  await scheduleNext(campaign.userId, campaignId, campaign.ratePerHour)
}

async function scheduleNext(userId: string, campaignId: string, ratePerHour: number) {
  await enqueue({
    userId,
    type: 'campaign.dispatch',
    payload: { campaignId },
    runAfter: new Date(Date.now() + paceIntervalMs(ratePerHour)),
    // A long campaign runs for days; the retry budget must outlast it.
    maxAttempts: 500,
  })
}

/**
 * Rows stuck mid-send.
 *
 * A worker that died between the Gmail call and recording the result leaves a
 * row in `sending`. It is NOT auto-retried: the message may already have been
 * delivered, and a duplicate is worse than a gap. Surfaced for a person to
 * decide.
 */
export async function stuckSending(campaignId: string, olderThanMs = 10 * 60 * 1000) {
  return db
    .select({
      id: campaignRecipients.id,
      email: contacts.email,
      attempts: campaignRecipients.attempts,
    })
    .from(campaignRecipients)
    .innerJoin(contacts, eq(contacts.id, campaignRecipients.contactId))
    .where(
      and(
        eq(campaignRecipients.campaignId, campaignId),
        inArray(campaignRecipients.status, ['sending']),
        sql`${campaignRecipients.createdAt} < now() - ${sql.raw(`interval '${Math.round(olderThanMs / 1000)} seconds'`)}`,
      ),
    )
}

/** Preflight input for the send screen. */
export async function getSendReadiness(userId: string, campaignId: string) {
  const campaign = await db.query.campaigns.findFirst({ where: eq(campaigns.id, campaignId) })
  if (!campaign) return null

  const account = await db.query.googleAccounts.findFirst({
    where: eq(googleAccounts.userId, userId),
  })

  const [{ approved }] = await db
    .select({ approved: sql<number>`count(*) filter (where status = 'approved')::int` })
    .from(campaignRecipients)
    .where(eq(campaignRecipients.campaignId, campaignId))

  const [{ sent }] = await db
    .select({ sent: sql<number>`count(*) filter (where status = 'sent')::int` })
    .from(campaignRecipients)
    .where(eq(campaignRecipients.campaignId, campaignId))

  const sends = await recentSends(userId)

  let tokenOk = false
  let tokenError: string | null = null
  if (account && !account.revokedAt) {
    try {
      await getAccessToken(userId, account.id)
      tokenOk = true
    } catch (error) {
      tokenError = error instanceof Error ? error.message : 'Token check failed'
    }
  }

  return {
    campaign,
    account,
    approved,
    sent,
    tokenOk,
    tokenError,
    sentLast24h: sends.filter((d) => d.getTime() > Date.now() - DAY_MS).length,
    dailyLimit: account?.dailyQuotaLimit ?? 0,
  }
}
