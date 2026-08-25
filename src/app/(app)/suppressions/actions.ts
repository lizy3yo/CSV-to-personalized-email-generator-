'use server'

import { and, desc, eq } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { db } from '@/db'
import { auditLog, suppressions } from '@/db/schema'
import { requireUserId } from '@/lib/auth/require-user'
import { normalizeEmail, validateEmail } from '@/core/csv/email'

/**
 * The suppression list.
 *
 * Global to the account and enforced at DISPATCH time rather than at
 * generation, so someone who unsubscribes while a campaign is being reviewed
 * is still dropped before their email goes out.
 */

export type ActionResult<T = void> = { ok: true; data: T } | { ok: false; error: string }

function fail(error: unknown): { ok: false; error: string } {
  if (error instanceof z.ZodError) {
    return { ok: false, error: error.issues.map((i) => i.message).join('; ') }
  }
  console.error('[suppressions/actions]', error)
  return { ok: false, error: error instanceof Error ? error.message : 'Something went wrong' }
}

const addSchema = z.object({
  emails: z.string().min(1, 'Enter at least one address').max(100_000),
  reason: z.enum(['unsubscribed', 'hard_bounce', 'complaint', 'manual', 'invalid']),
  source: z.string().max(500).optional(),
})

/**
 * Add addresses, pasted one per line or comma-separated.
 *
 * Accepts a messy paste on purpose: this list gets fed from replies, bounce
 * notifications and forwarded complaints, none of which arrive tidy.
 */
export async function addSuppressions(
  input: z.input<typeof addSchema>,
): Promise<ActionResult<{ added: number; skipped: number; invalid: string[] }>> {
  try {
    const userId = await requireUserId()
    const parsed = addSchema.parse(input)

    const candidates = parsed.emails
      .split(/[\n,;]+/)
      .map((value) => normalizeEmail(value))
      .filter(Boolean)

    const invalid: string[] = []
    const valid: string[] = []
    for (const email of candidates) {
      if (validateEmail(email).valid) valid.push(email)
      else invalid.push(email)
    }

    const unique = [...new Set(valid)]
    if (unique.length === 0) {
      return { ok: true, data: { added: 0, skipped: 0, invalid } }
    }

    // Already-suppressed addresses are a no-op, not an error — re-pasting a
    // list is the normal way this gets used.
    const inserted = await db
      .insert(suppressions)
      .values(
        unique.map((email) => ({
          userId,
          email,
          reason: parsed.reason,
          source: parsed.source?.trim() || 'Added manually',
        })),
      )
      .onConflictDoNothing({ target: [suppressions.userId, suppressions.email] })
      .returning({ id: suppressions.id })

    await db.insert(auditLog).values({
      userId,
      action: 'suppressions.added',
      entityType: 'suppression',
      after: { added: inserted.length, reason: parsed.reason },
    })

    revalidatePath('/suppressions')
    return {
      ok: true,
      data: { added: inserted.length, skipped: unique.length - inserted.length, invalid },
    }
  } catch (error) {
    return fail(error)
  }
}

export async function removeSuppression(id: string): Promise<ActionResult> {
  try {
    const userId = await requireUserId()
    const suppressionId = z.uuid().parse(id)

    const removed = await db
      .delete(suppressions)
      .where(and(eq(suppressions.id, suppressionId), eq(suppressions.userId, userId)))
      .returning({ email: suppressions.email })

    if (removed.length === 0) return { ok: false, error: 'Not found' }

    // Removing someone from a suppression list is a decision worth recording:
    // it means they may be contacted again.
    await db.insert(auditLog).values({
      userId,
      action: 'suppression.removed',
      entityType: 'suppression',
      entityId: suppressionId,
      before: { email: removed[0].email },
    })

    revalidatePath('/suppressions')
    return { ok: true, data: undefined }
  } catch (error) {
    return fail(error)
  }
}

export async function listSuppressions(limit = 500) {
  const userId = await requireUserId()
  return db
    .select()
    .from(suppressions)
    .where(eq(suppressions.userId, userId))
    .orderBy(desc(suppressions.createdAt))
    .limit(limit)
}
