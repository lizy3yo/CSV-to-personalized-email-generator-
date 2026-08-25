'use server'

import { and, eq, inArray, sql } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { db } from '@/db'
import { auditLog, campaignRecipients, campaigns, contacts, templates } from '@/db/schema'
import { requireUserId } from '@/lib/auth/require-user'
import { describeError, generateSlot } from '@/lib/ai/client'
import { canApprove, hasBlockingFlag } from '@/core/review/flags'
import { textToHtml } from '@/core/template/html'
import { parse } from '@/core/template/parse'
import type { GuardrailKey } from '@/core/ai/prompt'

/**
 * The approval gate.
 *
 * Every transition here is recorded in `audit_log`, and approval is refused
 * for any row carrying an error-severity flag — a human can accept an odd
 * email but cannot make an empty one sendable.
 */

export type ActionResult<T = void> = { ok: true; data: T } | { ok: false; error: string }

function fail(error: unknown): { ok: false; error: string } {
  if (error instanceof z.ZodError) {
    return { ok: false, error: error.issues.map((i) => i.message).join('; ') }
  }
  console.error('[review/actions]', error)
  return { ok: false, error: error instanceof Error ? error.message : 'Something went wrong' }
}

/** Confirms the recipients belong to the caller before anything touches them. */
async function ownedRecipients(userId: string, campaignId: string, ids: string[]) {
  if (ids.length === 0) return []
  return db
    .select({
      id: campaignRecipients.id,
      status: campaignRecipients.status,
      flags: campaignRecipients.flags,
    })
    .from(campaignRecipients)
    .where(
      and(
        eq(campaignRecipients.userId, userId),
        eq(campaignRecipients.campaignId, campaignId),
        inArray(campaignRecipients.id, ids),
      ),
    )
}

const idsSchema = z.object({
  campaignId: z.uuid(),
  recipientIds: z.array(z.uuid()).min(1).max(5000),
})

export async function approveRecipients(
  input: z.input<typeof idsSchema>,
): Promise<ActionResult<{ approved: number; blocked: number }>> {
  try {
    const userId = await requireUserId()
    const { campaignId, recipientIds } = idsSchema.parse(input)

    const rows = await ownedRecipients(userId, campaignId, recipientIds)

    // Partitioned rather than rejected wholesale: approving 900 of 1,000 and
    // being told which 100 could not is more useful than approving none.
    const allowed = rows.filter((row) => canApprove(row.status, row.flags)).map((row) => row.id)
    const blocked = rows.length - allowed.length

    if (allowed.length > 0) {
      await db
        .update(campaignRecipients)
        .set({ status: 'approved', approvedAt: new Date() })
        .where(inArray(campaignRecipients.id, allowed))

      await db.insert(auditLog).values({
        userId,
        action: 'recipients.approved',
        entityType: 'campaign',
        entityId: campaignId,
        after: { count: allowed.length, blocked },
      })
    }

    revalidatePath(`/campaigns/${campaignId}/review`)
    return { ok: true, data: { approved: allowed.length, blocked } }
  } catch (error) {
    return fail(error)
  }
}

export async function rejectRecipients(
  input: z.input<typeof idsSchema>,
): Promise<ActionResult<{ rejected: number }>> {
  try {
    const userId = await requireUserId()
    const { campaignId, recipientIds } = idsSchema.parse(input)

    const updated = await db
      .update(campaignRecipients)
      .set({ status: 'rejected', approvedAt: null })
      .where(
        and(
          eq(campaignRecipients.userId, userId),
          eq(campaignRecipients.campaignId, campaignId),
          inArray(campaignRecipients.id, recipientIds),
        ),
      )
      .returning({ id: campaignRecipients.id })

    await db.insert(auditLog).values({
      userId,
      action: 'recipients.rejected',
      entityType: 'campaign',
      entityId: campaignId,
      after: { count: updated.length },
    })

    revalidatePath(`/campaigns/${campaignId}/review`)
    return { ok: true, data: { rejected: updated.length } }
  } catch (error) {
    return fail(error)
  }
}

/** Return approved or rejected rows to the review pool. */
export async function resetRecipients(
  input: z.input<typeof idsSchema>,
): Promise<ActionResult<{ reset: number }>> {
  try {
    const userId = await requireUserId()
    const { campaignId, recipientIds } = idsSchema.parse(input)

    const rows = await ownedRecipients(userId, campaignId, recipientIds)
    if (rows.length === 0) return { ok: true, data: { reset: 0 } }

    // Back to `flagged` or `generated` depending on what is still wrong.
    for (const row of rows) {
      await db
        .update(campaignRecipients)
        .set({ status: row.flags.length > 0 ? 'flagged' : 'generated', approvedAt: null })
        .where(eq(campaignRecipients.id, row.id))
    }

    revalidatePath(`/campaigns/${campaignId}/review`)
    return { ok: true, data: { reset: rows.length } }
  } catch (error) {
    return fail(error)
  }
}

const editSchema = z.object({
  campaignId: z.uuid(),
  recipientId: z.uuid(),
  subject: z.string().max(2000),
  bodyText: z.string().max(100_000),
})

/**
 * Save a hand-edited email.
 *
 * Flags are recomputed from the edited text rather than carried over: fixing
 * the empty greeting should clear the flag that reported it, otherwise the
 * reviewer is left arguing with a stale warning.
 *
 * Editing always drops the row out of `approved`, so a change cannot slip past
 * a decision that was made about different text.
 */
export async function updateRecipient(
  input: z.input<typeof editSchema>,
): Promise<ActionResult<{ flags: string[]; status: string }>> {
  try {
    const userId = await requireUserId()
    const parsed = editSchema.parse(input)

    const existing = await db.query.campaignRecipients.findFirst({
      where: and(
        eq(campaignRecipients.id, parsed.recipientId),
        eq(campaignRecipients.userId, userId),
      ),
    })
    if (!existing) return { ok: false, error: 'Recipient not found' }

    const subject = parsed.subject.replace(/[\r\n]+/g, ' ').trim()
    const bodyText = parsed.bodyText.trim()

    // Only the checks that still apply to text a human wrote. Guardrail
    // violations from generation are dropped — the human has superseded them.
    const flags: string[] = []
    if (!subject) flags.push('error:empty_subject')
    if (!bodyText) flags.push('error:empty_body')
    if (/\{\{|\}\}/.test(`${subject}\n${bodyText}`)) {
      flags.push('error:contains_template_syntax')
    }

    await db
      .update(campaignRecipients)
      .set({
        subject,
        bodyText,
        bodyHtml: textToHtml(bodyText),
        flags,
        editedByUser: true,
        status: flags.length > 0 ? 'flagged' : 'generated',
        approvedAt: null,
      })
      .where(eq(campaignRecipients.id, parsed.recipientId))

    await db.insert(auditLog).values({
      userId,
      action: 'recipient.edited',
      entityType: 'campaign_recipient',
      entityId: parsed.recipientId,
      before: { subject: existing.subject, bodyText: existing.bodyText },
      after: { subject, bodyText },
    })

    revalidatePath(`/campaigns/${parsed.campaignId}/review`)
    return { ok: true, data: { flags, status: flags.length > 0 ? 'flagged' : 'generated' } }
  } catch (error) {
    return fail(error)
  }
}

const regenerateSchema = z.object({
  campaignId: z.uuid(),
  recipientId: z.uuid(),
  /** Optional one-off override, e.g. retrying a weak row at a stronger model. */
  model: z.string().max(100).optional(),
})

/**
 * Regenerate one row's AI slots, synchronously.
 *
 * Synchronous because a human is watching this particular row. Bulk work goes
 * through the queue; this does not.
 */
export async function regenerateRecipient(
  input: z.input<typeof regenerateSchema>,
): Promise<ActionResult<{ status: string; flags: string[]; costUsd: number }>> {
  try {
    const userId = await requireUserId()
    const parsed = regenerateSchema.parse(input)

    const recipient = await db.query.campaignRecipients.findFirst({
      where: and(
        eq(campaignRecipients.id, parsed.recipientId),
        eq(campaignRecipients.userId, userId),
      ),
    })
    if (!recipient) return { ok: false, error: 'Recipient not found' }

    const campaign = await db.query.campaigns.findFirst({
      where: eq(campaigns.id, recipient.campaignId),
    })
    if (!campaign?.templateId) return { ok: false, error: 'Campaign has no template' }

    const template = await db.query.templates.findFirst({
      where: eq(templates.id, campaign.templateId),
    })
    if (!template) return { ok: false, error: 'Template not found' }

    const contact = await db.query.contacts.findFirst({
      where: eq(contacts.id, recipient.contactId),
    })
    if (!contact) return { ok: false, error: 'Contact not found' }

    const slotNames = [
      ...new Set([...parse(template.bodyTpl).slots, ...parse(template.subjectTpl).slots]),
    ]
    if (slotNames.length === 0) {
      return { ok: false, error: 'This template has no AI slots to regenerate' }
    }

    const slots: Record<string, string> = {}
    let costUsd = 0
    const violations = []

    for (const name of slotNames) {
      const result = await generateSlot({
        userId,
        bodyTemplate: template.bodyTpl,
        slot: {
          name,
          brief: template.aiConfig.slots?.[name]?.brief ?? '',
          maxSentences: template.aiConfig.slots?.[name]?.maxSentences,
        },
        data: contact.data,
        availableFields: template.variables,
        tone: template.aiConfig.tone,
        guardrails: template.aiConfig.guardrails as GuardrailKey[] | undefined,
        campaignId: recipient.campaignId,
        model: parsed.model,
      })
      slots[name] = result.generated.text
      costUsd += result.costUsd
      violations.push(...result.generated.violations)
    }

    // Reuse the same render-and-flag path the worker uses, so a regenerated
    // row is judged by exactly the same rules as a generated one.
    const { renderAndSaveRecipient } = await import('@/lib/jobs/render')
    const rendered = await renderAndSaveRecipient({
      recipientId: parsed.recipientId,
      subjectTpl: template.subjectTpl,
      bodyTpl: template.bodyTpl,
      data: contact.data,
      slots,
      violations,
    })

    await db.insert(auditLog).values({
      userId,
      action: 'recipient.regenerated',
      entityType: 'campaign_recipient',
      entityId: parsed.recipientId,
      after: { status: rendered.status, costUsd: costUsd.toFixed(6) },
    })

    revalidatePath(`/campaigns/${parsed.campaignId}/review`)
    return { ok: true, data: { status: rendered.status, flags: rendered.flags, costUsd } }
  } catch (error) {
    return { ok: false, error: describeError(error) }
  }
}

export interface ReviewCounts {
  total: number
  approved: number
  rejected: number
  flagged: number
  generated: number
  edited: number
  blocked: number
}

export async function getReviewCounts(campaignId: string): Promise<ReviewCounts> {
  const userId = await requireUserId()
  const id = z.uuid().parse(campaignId)

  const rows = await db
    .select({
      status: campaignRecipients.status,
      flags: campaignRecipients.flags,
      edited: campaignRecipients.editedByUser,
    })
    .from(campaignRecipients)
    .where(and(eq(campaignRecipients.campaignId, id), eq(campaignRecipients.userId, userId)))

  const counts: ReviewCounts = {
    total: rows.length,
    approved: 0,
    rejected: 0,
    flagged: 0,
    generated: 0,
    edited: 0,
    blocked: 0,
  }

  for (const row of rows) {
    if (row.status === 'approved') counts.approved += 1
    else if (row.status === 'rejected') counts.rejected += 1
    else if (row.status === 'flagged') counts.flagged += 1
    else if (row.status === 'generated') counts.generated += 1
    if (row.edited) counts.edited += 1
    if (hasBlockingFlag(row.flags)) counts.blocked += 1
  }

  return counts
}

/**
 * How many emails this campaign would actually send right now.
 *
 * Deliberately computed with the same `approved`-only filter the dispatcher
 * will use, so the number on screen is the number that would go out.
 */
export async function getSendableCount(campaignId: string): Promise<number> {
  const userId = await requireUserId()
  const id = z.uuid().parse(campaignId)

  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(campaignRecipients)
    .where(
      and(
        eq(campaignRecipients.campaignId, id),
        eq(campaignRecipients.userId, userId),
        eq(campaignRecipients.status, 'approved'),
      ),
    )

  return row?.count ?? 0
}
