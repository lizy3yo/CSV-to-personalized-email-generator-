/**
 * NOT marked `server-only` — see the note in src/lib/queue/index.ts. The
 * worker imports this by design.
 */

import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { auditLog, campaignRecipients, suppressions } from '@/db/schema'
import { signUnsubscribeToken, verifyUnsubscribeToken } from '@/lib/crypto'
import { clientEnv } from '@/env'

/**
 * Unsubscribe handling, shared by the one-click POST endpoint and the
 * confirmation page.
 *
 * The token is an HMAC over `recipientId:email`, so it verifies itself. There
 * is no per-recipient lookup table to hit on a public endpoint, and a link
 * keeps working even if the campaign row is later deleted.
 */

export function unsubscribeUrlFor(recipientId: string, email: string): string {
  const base = clientEnv.NEXT_PUBLIC_SITE_URL.replace(/\/+$/, '')
  return `${base}/api/unsubscribe/${signUnsubscribeToken(recipientId, email)}`
}

/** The human-facing page, used for the visible link in a bulk footer. */
export function unsubscribePageUrlFor(recipientId: string, email: string): string {
  const base = clientEnv.NEXT_PUBLIC_SITE_URL.replace(/\/+$/, '')
  return `${base}/unsubscribe/${signUnsubscribeToken(recipientId, email)}`
}

export interface UnsubscribeOutcome {
  ok: boolean
  email?: string
  /** True when the address was already on the list. Still a success. */
  alreadySuppressed?: boolean
}

/**
 * Suppress the address behind a token.
 *
 * Idempotent, and quiet about failure: a caller must never learn whether a
 * given address is on someone's list, and an RFC 8058 client retrying a
 * request should not see an error.
 */
export async function suppressByToken(token: string, source: string): Promise<UnsubscribeOutcome> {
  const verified = verifyUnsubscribeToken(token)
  if (!verified) return { ok: false }

  const recipient = await db.query.campaignRecipients.findFirst({
    where: eq(campaignRecipients.id, verified.recipientId),
  })
  // The token verifies on its own, but without the row there is no account to
  // attribute the suppression to.
  if (!recipient) return { ok: false }

  const inserted = await db
    .insert(suppressions)
    .values({
      userId: recipient.userId,
      email: verified.email,
      reason: 'unsubscribed',
      source,
      campaignId: recipient.campaignId,
    })
    .onConflictDoNothing({ target: [suppressions.userId, suppressions.email] })
    .returning({ id: suppressions.id })

  if (inserted.length > 0) {
    await db.insert(auditLog).values({
      userId: recipient.userId,
      action: 'recipient.unsubscribed',
      entityType: 'campaign_recipient',
      entityId: recipient.id,
      after: { email: verified.email, source },
    })
  }

  return { ok: true, email: verified.email, alreadySuppressed: inserted.length === 0 }
}

/** Read the address a token refers to, without changing anything. */
export function peekToken(token: string): { recipientId: string; email: string } | null {
  return verifyUnsubscribeToken(token)
}
