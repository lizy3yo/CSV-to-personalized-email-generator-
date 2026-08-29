'use server'

import { and, eq, sql } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { db } from '@/db'
import { auditLog, contactLists, contactRejects, contacts, suppressions } from '@/db/schema'
import { requireUserId } from '@/lib/auth/require-user'
import { normalizeEmail } from '@/core/csv/email'
import { LIMITS } from '@/core/csv/types'

/**
 * Server Actions for CSV import.
 *
 * The file itself never arrives here. It is parsed and mapped in the browser;
 * what crosses the wire is validated rows in chunks of `LIMITS.CHUNK_SIZE`,
 * because Server Actions cap request bodies (1 MB by default) and a 50k-row
 * file in one request would exceed it.
 *
 * Every input is re-validated with Zod. Client-side checks are for the user's
 * benefit; they are not a security boundary.
 */

const columnMapSchema = z.record(
  z.string(),
  z.object({
    role: z.enum(['email', 'merge_var', 'ai_context', 'ignore']),
    variable: z.string().optional(),
    // Position in the file. jsonb will not preserve key order for us.
    order: z.number().int().nonnegative().optional(),
  }),
)

const createListSchema = z.object({
  name: z.string().trim().min(1, 'Give the list a name').max(200),
  sourceFilename: z.string().max(500).optional(),
  columnMap: columnMapSchema,
  consentBasis: z.enum(['consent', 'legitimate_interest', 'contract', 'unknown']),
  consentSource: z.string().trim().max(500).optional(),
})

const rowSchema = z.object({
  email: z.string().min(1).max(254),
  emailRaw: z.string().max(254),
  data: z.record(z.string(), z.string()),
  rowNumber: z.number().int().positive(),
})

const appendSchema = z.object({
  listId: z.uuid(),
  rows: z.array(rowSchema).max(LIMITS.CHUNK_SIZE),
})

const rejectSchema = z.object({
  rowNumber: z.number().int().positive(),
  reason: z.enum(['missing_email', 'invalid_email', 'duplicate', 'suppressed']),
  // Not validated as an email — being unusable is the whole reason it is here.
  emailRaw: z.string().max(254),
  issue: z.string().max(300).optional(),
  duplicateOf: z.number().int().positive().optional(),
  data: z.record(z.string(), z.string()),
})

const appendRejectsSchema = z.object({
  listId: z.uuid(),
  rows: z.array(rejectSchema).max(LIMITS.CHUNK_SIZE),
})

const finalizeSchema = z.object({
  listId: z.uuid(),
  summary: z.object({
    total: z.number().int().nonnegative(),
    valid: z.number().int().nonnegative(),
    invalidEmail: z.number().int().nonnegative(),
    missingEmail: z.number().int().nonnegative(),
    duplicate: z.number().int().nonnegative(),
    suppressed: z.number().int().nonnegative(),
  }),
})

export type ActionResult<T = void> = { ok: true; data: T } | { ok: false; error: string }

function fail(error: unknown): { ok: false; error: string } {
  if (error instanceof z.ZodError) {
    return { ok: false, error: error.issues.map((i) => i.message).join('; ') }
  }
  console.error('[contacts/actions]', error)
  return { ok: false, error: error instanceof Error ? error.message : 'Something went wrong' }
}

/**
 * The user's suppression list, for classifying rows in the preview.
 *
 * Sent to the browser so the summary can show suppressed counts before import.
 * It is the user's own data, so this leaks nothing — and `appendContacts`
 * re-checks server-side regardless, because the preview is a convenience and
 * the dispatch gate is the real one.
 */
export async function getSuppressedEmails(): Promise<string[]> {
  const userId = await requireUserId()
  const rows = await db
    .select({ email: suppressions.email })
    .from(suppressions)
    .where(eq(suppressions.userId, userId))
  return rows.map((r) => r.email)
}

export async function createContactList(
  input: z.input<typeof createListSchema>,
): Promise<ActionResult<{ listId: string }>> {
  try {
    const userId = await requireUserId()
    const parsed = createListSchema.parse(input)

    const emailColumns = Object.values(parsed.columnMap).filter((c) => c.role === 'email')
    if (emailColumns.length !== 1) {
      return { ok: false, error: 'Map exactly one column to Email' }
    }

    const [list] = await db
      .insert(contactLists)
      .values({
        userId,
        name: parsed.name,
        sourceFilename: parsed.sourceFilename,
        columnMap: parsed.columnMap,
        consentBasis: parsed.consentBasis,
        consentSource: parsed.consentSource,
      })
      .returning({ id: contactLists.id })

    await db.insert(auditLog).values({
      userId,
      action: 'contact_list.created',
      entityType: 'contact_list',
      entityId: list.id,
      after: { name: parsed.name, consentBasis: parsed.consentBasis },
    })

    return { ok: true, data: { listId: list.id } }
  } catch (error) {
    return fail(error)
  }
}

/**
 * Insert one chunk of contacts.
 *
 * Idempotent: `onConflictDoNothing` on the (list_id, email) unique index means
 * a retried chunk after a dropped connection cannot create duplicates.
 */
export async function appendContacts(
  input: z.input<typeof appendSchema>,
): Promise<ActionResult<{ inserted: number; skipped: number }>> {
  try {
    const userId = await requireUserId()
    const parsed = appendSchema.parse(input)

    // The list must belong to the caller. Without this check, a valid listId
    // from another account would accept writes.
    const list = await db.query.contactLists.findFirst({
      where: and(eq(contactLists.id, parsed.listId), eq(contactLists.userId, userId)),
    })
    if (!list) return { ok: false, error: 'List not found' }

    if (parsed.rows.length === 0) return { ok: true, data: { inserted: 0, skipped: 0 } }

    // Authoritative suppression check. The browser already filtered these out;
    // this is the boundary that actually counts.
    const suppressedRows = await db
      .select({ email: suppressions.email })
      .from(suppressions)
      .where(eq(suppressions.userId, userId))
    const suppressed = new Set(suppressedRows.map((r) => r.email))

    const values = parsed.rows
      .map((row) => ({ ...row, email: normalizeEmail(row.email) }))
      .filter((row) => row.email && !suppressed.has(row.email))
      .map((row) => ({
        userId,
        listId: parsed.listId,
        email: row.email,
        emailRaw: row.emailRaw || row.email,
        data: row.data,
        rowNumber: row.rowNumber,
        isValid: true,
      }))

    if (values.length === 0) {
      return { ok: true, data: { inserted: 0, skipped: parsed.rows.length } }
    }

    const inserted = await db
      .insert(contacts)
      .values(values)
      .onConflictDoNothing({ target: [contacts.listId, contacts.email] })
      .returning({ id: contacts.id })

    return {
      ok: true,
      data: { inserted: inserted.length, skipped: parsed.rows.length - inserted.length },
    }
  } catch (error) {
    return fail(error)
  }
}

/**
 * Insert one chunk of rows that did not make it in.
 *
 * Idempotent the same way `appendContacts` is: the unique index on
 * (list_id, row_number) turns a retried chunk into a no-op.
 */
export async function appendRejects(
  input: z.input<typeof appendRejectsSchema>,
): Promise<ActionResult<{ inserted: number }>> {
  try {
    const userId = await requireUserId()
    const parsed = appendRejectsSchema.parse(input)

    const list = await db.query.contactLists.findFirst({
      where: and(eq(contactLists.id, parsed.listId), eq(contactLists.userId, userId)),
    })
    if (!list) return { ok: false, error: 'List not found' }

    if (parsed.rows.length === 0) return { ok: true, data: { inserted: 0 } }

    const inserted = await db
      .insert(contactRejects)
      .values(
        parsed.rows.map((row) => ({
          userId,
          listId: parsed.listId,
          rowNumber: row.rowNumber,
          reason: row.reason,
          emailRaw: row.emailRaw,
          issue: row.issue ?? null,
          duplicateOf: row.duplicateOf ?? null,
          data: row.data,
        })),
      )
      .onConflictDoNothing({ target: [contactRejects.listId, contactRejects.rowNumber] })
      .returning({ id: contactRejects.id })

    return { ok: true, data: { inserted: inserted.length } }
  } catch (error) {
    return fail(error)
  }
}

/** Record the final counts. Called once, after the last chunk. */
export async function finalizeContactList(
  input: z.input<typeof finalizeSchema>,
): Promise<ActionResult<{ imported: number }>> {
  try {
    const userId = await requireUserId()
    const parsed = finalizeSchema.parse(input)

    const list = await db.query.contactLists.findFirst({
      where: and(eq(contactLists.id, parsed.listId), eq(contactLists.userId, userId)),
    })
    if (!list) return { ok: false, error: 'List not found' }

    // Count from the table rather than trusting the client's tally.
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(contacts)
      .where(eq(contacts.listId, parsed.listId))

    await db
      .update(contactLists)
      .set({
        rowCount: parsed.summary.total,
        validCount: count,
        duplicateCount: parsed.summary.duplicate,
        // One counter per outcome. A malformed address and a blank cell are
        // different problems with different fixes, and the import wizard has
        // always shown them apart — the list card should not disagree with it.
        invalidCount: parsed.summary.invalidEmail,
        missingCount: parsed.summary.missingEmail,
        suppressedCount: parsed.summary.suppressed,
      })
      .where(eq(contactLists.id, parsed.listId))

    await db.insert(auditLog).values({
      userId,
      action: 'contact_list.imported',
      entityType: 'contact_list',
      entityId: parsed.listId,
      after: { imported: count, ...parsed.summary },
    })

    revalidatePath('/contacts')
    return { ok: true, data: { imported: count } }
  } catch (error) {
    return fail(error)
  }
}

export async function deleteContactList(listId: string): Promise<ActionResult> {
  try {
    const userId = await requireUserId()
    const id = z.uuid().parse(listId)

    const deleted = await db
      .delete(contactLists)
      .where(and(eq(contactLists.id, id), eq(contactLists.userId, userId)))
      .returning({ id: contactLists.id })

    if (deleted.length === 0) return { ok: false, error: 'List not found' }

    await db.insert(auditLog).values({
      userId,
      action: 'contact_list.deleted',
      entityType: 'contact_list',
      entityId: id,
    })

    revalidatePath('/contacts')
    return { ok: true, data: undefined }
  } catch (error) {
    return fail(error)
  }
}
