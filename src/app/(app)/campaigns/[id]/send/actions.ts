'use server'

import { and, eq } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { db } from '@/db'
import { auditLog, campaigns, googleAccounts } from '@/db/schema'
import { requireUserId } from '@/lib/auth/require-user'
import { enqueue } from '@/lib/queue'
import { getAccessToken } from '@/lib/gmail/auth'
import { sendMessage } from '@/lib/gmail/send'
import { messageIdFor } from '@/core/gmail/message'
import { textToHtml } from '@/core/template/html'

export type ActionResult<T = void> = { ok: true; data: T } | { ok: false; error: string }

function fail(error: unknown): { ok: false; error: string } {
  if (error instanceof z.ZodError) {
    return { ok: false, error: error.issues.map((i) => i.message).join('; ') }
  }
  console.error('[send/actions]', error)
  return { ok: false, error: error instanceof Error ? error.message : 'Something went wrong' }
}

const settingsSchema = z.object({
  campaignId: z.uuid(),
  ratePerHour: z.number().int().min(0).max(2000),
  sendWindowStartHour: z.number().int().min(0).max(23),
  sendWindowEndHour: z.number().int().min(1).max(24),
  sendWindowDays: z.array(z.number().int().min(1).max(7)).max(7),
  threadFollowUps: z.boolean(),
})

export async function updateSendSettings(
  input: z.input<typeof settingsSchema>,
): Promise<ActionResult> {
  try {
    const userId = await requireUserId()
    const parsed = settingsSchema.parse(input)

    if (parsed.sendWindowEndHour <= parsed.sendWindowStartHour) {
      return { ok: false, error: 'The window must end after it starts' }
    }

    const updated = await db
      .update(campaigns)
      .set({
        ratePerHour: parsed.ratePerHour,
        sendWindowStartHour: parsed.sendWindowStartHour,
        sendWindowEndHour: parsed.sendWindowEndHour,
        sendWindowDays: parsed.sendWindowDays,
        threadFollowUps: parsed.threadFollowUps,
        updatedAt: new Date(),
      })
      .where(and(eq(campaigns.id, parsed.campaignId), eq(campaigns.userId, userId)))
      .returning({ id: campaigns.id })

    if (updated.length === 0) return { ok: false, error: 'Campaign not found' }

    revalidatePath(`/campaigns/${parsed.campaignId}/send`)
    return { ok: true, data: undefined }
  } catch (error) {
    return fail(error)
  }
}

/**
 * Send one email to the signed-in user's own address.
 *
 * The last thing anyone should do before a real send, and the only way to see
 * how the message actually renders in a mail client rather than in a preview
 * pane. Does not touch any recipient row.
 */
export async function sendTestToSelf(
  campaignId: string,
  subject: string,
  bodyText: string,
): Promise<ActionResult<{ to: string }>> {
  try {
    const userId = await requireUserId()
    const id = z.uuid().parse(campaignId)

    const account = await db.query.googleAccounts.findFirst({
      where: eq(googleAccounts.userId, userId),
    })
    if (!account) return { ok: false, error: 'No Gmail account is connected' }

    const domain = account.googleEmail.split('@')[1] ?? 'localhost'

    await sendMessage({
      userId,
      googleAccountId: account.id,
      fromEmail: account.googleEmail,
      to: account.googleEmail,
      subject: `[TEST] ${subject}`,
      text: bodyText,
      html: textToHtml(bodyText),
      messageId: messageIdFor(`test-${id}-${Date.now()}`, domain),
    })

    await db.insert(auditLog).values({
      userId,
      action: 'campaign.test_sent',
      entityType: 'campaign',
      entityId: id,
      after: { to: account.googleEmail },
    })

    return { ok: true, data: { to: account.googleEmail } }
  } catch (error) {
    return fail(error)
  }
}

/**
 * Begin sending.
 *
 * Only queues the dispatcher — the worker does the sending, paced. Refuses
 * when the token cannot be minted, because discovering that on recipient one
 * of nine hundred is worse than discovering it here.
 */
export async function startSending(campaignId: string): Promise<ActionResult> {
  try {
    const userId = await requireUserId()
    const id = z.uuid().parse(campaignId)

    const campaign = await db.query.campaigns.findFirst({
      where: and(eq(campaigns.id, id), eq(campaigns.userId, userId)),
    })
    if (!campaign) return { ok: false, error: 'Campaign not found' }
    if (campaign.status === 'sending') return { ok: false, error: 'Already sending' }

    const account = await db.query.googleAccounts.findFirst({
      where: eq(googleAccounts.userId, userId),
    })
    if (!account) {
      return { ok: false, error: 'No Gmail account is connected. Sign in with Google again.' }
    }

    try {
      await getAccessToken(userId, account.id)
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'Gmail token check failed',
      }
    }

    await db
      .update(campaigns)
      .set({
        status: 'sending',
        googleAccountId: account.id,
        startedAt: campaign.startedAt ?? new Date(),
      })
      .where(eq(campaigns.id, id))

    await enqueue({
      userId,
      type: 'campaign.dispatch',
      payload: { campaignId: id },
      maxAttempts: 500,
    })

    await db.insert(auditLog).values({
      userId,
      action: 'campaign.send_started',
      entityType: 'campaign',
      entityId: id,
      after: { ratePerHour: campaign.ratePerHour, from: account.googleEmail },
    })

    revalidatePath(`/campaigns/${id}`)
    revalidatePath(`/campaigns/${id}/send`)
    return { ok: true, data: undefined }
  } catch (error) {
    return fail(error)
  }
}

/**
 * Stop sending.
 *
 * Takes effect by the dispatcher declining to reschedule itself, so an email
 * already in flight completes rather than being abandoned halfway.
 */
export async function pauseSending(campaignId: string): Promise<ActionResult> {
  try {
    const userId = await requireUserId()
    const id = z.uuid().parse(campaignId)

    const updated = await db
      .update(campaigns)
      .set({ status: 'paused' })
      .where(and(eq(campaigns.id, id), eq(campaigns.userId, userId)))
      .returning({ id: campaigns.id })

    if (updated.length === 0) return { ok: false, error: 'Campaign not found' }

    await db.insert(auditLog).values({
      userId,
      action: 'campaign.send_paused',
      entityType: 'campaign',
      entityId: id,
    })

    revalidatePath(`/campaigns/${id}/send`)
    return { ok: true, data: undefined }
  } catch (error) {
    return fail(error)
  }
}
