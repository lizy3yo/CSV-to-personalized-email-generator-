/**
 * NOT marked `server-only` — see the note in src/lib/queue/index.ts. The
 * worker imports this by design.
 */

import { and, eq, inArray, isNotNull } from 'drizzle-orm'
import { db } from '@/db'
import {
  auditLog,
  campaignRecipients,
  contacts,
  events,
  googleAccounts,
  suppressions,
} from '@/db/schema'
import { enqueue, type JobRow } from '@/lib/queue'
import { bounceQuery, getMessage, listMessages, replyQuery } from '@/lib/gmail/read'
import { looksLikeBounce, parseBounce, shouldSuppress } from '@/core/gmail/bounce'

/**
 * Inbox polling.
 *
 * Gmail pushes nothing — no bounce webhook, no delivery receipt. A failed
 * delivery comes back as a message from mailer-daemon in your own inbox, and a
 * reply is just an ordinary message on the thread you started. Detecting
 * either means reading the mailbox.
 *
 * That is why this is opt-in and gated on a scope the app does not otherwise
 * request. Reading someone's whole mailbox is a much bigger ask than sending
 * on their behalf.
 *
 * Reschedules itself, like the dispatcher — polling is a standing background
 * task rather than a one-off.
 */

const POLL_INTERVAL_MS = 15 * 60 * 1000
/** First run has no watermark; look back a week rather than forever. */
const INITIAL_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000
const MAX_MESSAGES_PER_POLL = 50

export const handleInboxPoll = async (job: JobRow): Promise<void> => {
  const userId = job.userId

  const account = await db.query.googleAccounts.findFirst({
    where: eq(googleAccounts.userId, userId),
  })

  // Turning polling off takes effect by the job declining to reschedule.
  if (!account || !account.inboxPollingEnabled || account.revokedAt) return

  const since = account.lastInboxPollAt ?? new Date(Date.now() - INITIAL_LOOKBACK_MS)

  const bounces = await pollBounces(userId, account.id, account.googleEmail, since)
  const replies = await pollReplies(userId, account.id, since)

  await db
    .update(googleAccounts)
    .set({ lastInboxPollAt: new Date() })
    .where(eq(googleAccounts.id, account.id))

  if (bounces > 0 || replies > 0) {
    await db.insert(auditLog).values({
      userId,
      action: 'inbox.polled',
      entityType: 'google_account',
      entityId: account.id,
      after: { bounces, replies },
    })
  }

  await enqueue({
    userId,
    type: 'inbox.poll',
    runAfter: new Date(Date.now() + POLL_INTERVAL_MS),
    maxAttempts: 1000,
  })
}

async function pollBounces(
  userId: string,
  accountId: string,
  ownAddress: string,
  since: Date,
): Promise<number> {
  const summaries = await listMessages(userId, bounceQuery(since), {
    accountId,
    max: MAX_MESSAGES_PER_POLL,
  })

  let handled = 0

  for (const summary of summaries) {
    // Already processed on an earlier poll — the watermark is coarse, so
    // overlap is expected and must not double-record.
    const seen = await db.query.events.findFirst({
      where: and(eq(events.userId, userId), eq(events.type, `bounce:${summary.id}`)),
    })
    if (seen) continue

    const message = await getMessage(userId, summary.id, accountId)
    if (!looksLikeBounce(message.from, message.subject)) continue

    const bounce = parseBounce({ raw: message.raw, ownAddress })
    if (!bounce.recipient) continue

    // Match back to the recipient we sent to, so the bounce lands on the row.
    const [match] = await db
      .select({ id: campaignRecipients.id, campaignId: campaignRecipients.campaignId })
      .from(campaignRecipients)
      .innerJoin(contacts, eq(contacts.id, campaignRecipients.contactId))
      .where(
        and(
          eq(campaignRecipients.userId, userId),
          eq(contacts.email, bounce.recipient),
          inArray(campaignRecipients.status, ['sent', 'bounced']),
        ),
      )
      .limit(1)

    await db.insert(events).values({
      userId,
      recipientId: match?.id,
      // The Gmail message id is in the type so a repeat poll can skip it.
      type: `bounce:${summary.id}`,
      raw: {
        kind: bounce.type,
        recipient: bounce.recipient,
        status: bounce.status,
        diagnostic: bounce.diagnostic,
        gmailMessageId: summary.id,
      },
    })

    if (match && bounce.type === 'hard') {
      await db
        .update(campaignRecipients)
        .set({
          status: 'bounced',
          error: bounce.diagnostic ?? `Hard bounce ${bounce.status ?? ''}`,
        })
        .where(eq(campaignRecipients.id, match.id))
    }

    // Only a confirmed hard bounce suppresses. A soft one is a full mailbox
    // or a bad afternoon, and suppressing would lose a real contact.
    if (shouldSuppress(bounce)) {
      await db
        .insert(suppressions)
        .values({
          userId,
          email: bounce.recipient,
          reason: 'hard_bounce',
          source: bounce.status ? `Hard bounce ${bounce.status}` : 'Hard bounce',
          campaignId: match?.campaignId,
        })
        .onConflictDoNothing({ target: [suppressions.userId, suppressions.email] })
    }

    handled += 1
  }

  return handled
}

/**
 * Match inbound messages to threads we started.
 *
 * A reply is the only real signal of engagement available here — there is no
 * open tracking, by design — and it is also the signal that should stop a
 * follow-up sequence.
 */
async function pollReplies(userId: string, accountId: string, since: Date): Promise<number> {
  const summaries = await listMessages(userId, replyQuery(since), {
    accountId,
    max: MAX_MESSAGES_PER_POLL,
  })
  if (summaries.length === 0) return 0

  const threadIds = [...new Set(summaries.map((s) => s.threadId))]

  const ours = await db
    .select({
      id: campaignRecipients.id,
      threadId: campaignRecipients.gmailThreadId,
    })
    .from(campaignRecipients)
    .where(
      and(
        eq(campaignRecipients.userId, userId),
        isNotNull(campaignRecipients.gmailThreadId),
        inArray(campaignRecipients.gmailThreadId, threadIds),
      ),
    )

  const byThread = new Map(ours.map((row) => [row.threadId!, row.id]))
  let handled = 0

  for (const summary of summaries) {
    const recipientId = byThread.get(summary.threadId)
    // An inbound message on a thread we never started is just ordinary mail.
    if (!recipientId) continue

    const seen = await db.query.events.findFirst({
      where: and(eq(events.userId, userId), eq(events.type, `reply:${summary.id}`)),
    })
    if (seen) continue

    await db.insert(events).values({
      userId,
      recipientId,
      type: `reply:${summary.id}`,
      raw: { kind: 'reply', threadId: summary.threadId, gmailMessageId: summary.id },
    })
    handled += 1
  }

  return handled
}

/** Start or stop the standing poll job. */
export async function ensureInboxPolling(userId: string, enabled: boolean): Promise<void> {
  if (!enabled) return
  await enqueue({ userId, type: 'inbox.poll', maxAttempts: 1000 })
}
