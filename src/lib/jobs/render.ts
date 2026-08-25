/**
 * NOT marked `server-only`.
 *
 * That package throws unless a bundler selects its react-server condition, so
 * it breaks any plain Node process — including `npm run worker`, which imports
 * this module by design. The guard it offers is real but incompatible with
 * running the same code both inside Next.js and in a standalone worker.
 *
 * The convention that replaces it: `src/core/**` is safe to import anywhere,
 * `src/lib/**` is server-side only. A client component that imports this would
 * fail to bundle regardless, because it reaches the Postgres driver.
 */

import { createHash } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { campaignRecipients } from '@/db/schema'
import { render, renderSubject } from '@/core/template/render'
import { textToHtml } from '@/core/template/html'
import type { Violation } from '@/core/ai/types'

/**
 * Turn a recipient's data plus generated slots into a finished email, and
 * decide whether a human needs to look at it.
 *
 * Nothing here ever produces `approved`. A row lands in `generated` or
 * `flagged`, and only the review screen moves it on. The send path reads only
 * `approved`, so this function structurally cannot cause something to be sent.
 */

/**
 * Deterministic per (campaign, contact).
 *
 * Deterministic on purpose: re-running generation after a crash produces the
 * same key, so the unique index turns a duplicate insert into a no-op instead
 * of a second email.
 */
export function idempotencyKeyFor(campaignId: string, contactId: string): string {
  return createHash('sha256').update(`${campaignId}:${contactId}`).digest('hex').slice(0, 40)
}

export interface RenderRecipientInput {
  recipientId: string
  subjectTpl: string
  bodyTpl: string
  data: Record<string, string>
  slots: Record<string, string>
  /** Guardrail results carried over from generation. */
  violations?: Violation[]
}

export interface RenderRecipientResult {
  status: 'generated' | 'flagged'
  flags: string[]
}

export async function renderAndSaveRecipient(
  input: RenderRecipientInput,
): Promise<RenderRecipientResult> {
  const context = { data: input.data, slots: input.slots }
  const subject = renderSubject(input.subjectTpl, context)
  const body = render(input.bodyTpl, context)

  const flags: string[] = []

  // A merge variable that resolved to nothing is not an error — an optional
  // field can legitimately be empty — but "Hi ," is exactly what the review
  // screen exists to catch.
  for (const variable of new Set([...subject.unresolved, ...body.unresolved])) {
    flags.push(`unresolved:${variable}`)
  }
  for (const slot of new Set([...subject.unfilledSlots, ...body.unfilledSlots])) {
    flags.push(`unfilled_slot:${slot}`)
  }
  for (const violation of input.violations ?? []) {
    flags.push(`${violation.severity}:${violation.kind}`)
  }
  if (!subject.text.trim()) flags.push('error:empty_subject')
  if (!body.text.trim()) flags.push('error:empty_body')

  const status = flags.length > 0 ? 'flagged' : 'generated'

  await db
    .update(campaignRecipients)
    .set({
      subject: subject.text,
      bodyText: body.text,
      bodyHtml: textToHtml(body.text),
      aiSlots: input.slots,
      flags,
      status,
      generatedAt: new Date(),
      error: null,
    })
    .where(eq(campaignRecipients.id, input.recipientId))

  return { status, flags }
}
