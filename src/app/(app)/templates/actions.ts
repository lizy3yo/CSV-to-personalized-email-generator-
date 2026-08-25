'use server'

import { and, asc, eq } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { db } from '@/db'
import { auditLog, contactLists, contacts, templates } from '@/db/schema'
import { requireUserId } from '@/lib/auth/require-user'
import { checkTemplate } from '@/core/template/validate'

/**
 * Server Actions for templates.
 *
 * Variables and AI slots are derived from the template text on save rather
 * than trusted from the client, so the stored `variables` column always
 * matches the body it describes. Phase 3 reads that column to decide what to
 * generate, and phase 5 reads it to flag unresolved merges.
 */

const templateSchema = z.object({
  name: z.string().trim().min(1, 'Give the template a name').max(200),
  subjectTpl: z.string().max(2000),
  bodyTpl: z.string().max(100_000),
  complianceProfile: z.enum(['one_to_one', 'bulk']),
})

export type ActionResult<T = void> = { ok: true; data: T } | { ok: false; error: string }

function fail(error: unknown): { ok: false; error: string } {
  if (error instanceof z.ZodError) {
    return { ok: false, error: error.issues.map((i) => i.message).join('; ') }
  }
  console.error('[templates/actions]', error)
  return { ok: false, error: error instanceof Error ? error.message : 'Something went wrong' }
}

/** Rows for the live preview. Capped — the editor steps through, it does not scroll a list. */
export async function getPreviewRows(
  listId: string,
  limit = 50,
): Promise<
  ActionResult<{ variables: string[]; rows: { email: string; data: Record<string, string> }[] }>
> {
  try {
    const userId = await requireUserId()
    const id = z.uuid().parse(listId)

    const list = await db.query.contactLists.findFirst({
      where: and(eq(contactLists.id, id), eq(contactLists.userId, userId)),
    })
    if (!list) return { ok: false, error: 'List not found' }

    const rows = await db
      .select({ email: contacts.email, data: contacts.data })
      .from(contacts)
      .where(eq(contacts.listId, id))
      .orderBy(asc(contacts.rowNumber))
      .limit(Math.min(limit, 200))

    // Both merge variables and AI-context fields are available to the preview:
    // context fields are not merged verbatim, but the editor still shows what
    // the row carries.
    const variables = Object.values(list.columnMap)
      .filter((c) => c.role === 'merge_var' && c.variable)
      .map((c) => c.variable!)

    return { ok: true, data: { variables, rows } }
  } catch (error) {
    return fail(error)
  }
}

export async function createTemplate(
  input: z.input<typeof templateSchema>,
): Promise<ActionResult<{ id: string }>> {
  try {
    const userId = await requireUserId()
    const parsed = templateSchema.parse(input)
    const check = checkTemplate(parsed.subjectTpl, parsed.bodyTpl)

    const [row] = await db
      .insert(templates)
      .values({
        userId,
        name: parsed.name,
        subjectTpl: parsed.subjectTpl,
        bodyTpl: parsed.bodyTpl,
        complianceProfile: parsed.complianceProfile,
        variables: check.variables,
        aiConfig: { enabled: check.usesAi },
      })
      .returning({ id: templates.id })

    await db.insert(auditLog).values({
      userId,
      action: 'template.created',
      entityType: 'template',
      entityId: row.id,
      after: { name: parsed.name, variables: check.variables, slots: check.slots },
    })

    revalidatePath('/templates')
    return { ok: true, data: { id: row.id } }
  } catch (error) {
    return fail(error)
  }
}

export async function updateTemplate(
  id: string,
  input: z.input<typeof templateSchema>,
): Promise<ActionResult<{ version: number }>> {
  try {
    const userId = await requireUserId()
    const templateId = z.uuid().parse(id)
    const parsed = templateSchema.parse(input)

    const existing = await db.query.templates.findFirst({
      where: and(eq(templates.id, templateId), eq(templates.userId, userId)),
    })
    if (!existing) return { ok: false, error: 'Template not found' }

    const check = checkTemplate(parsed.subjectTpl, parsed.bodyTpl)
    // Bumped only when the text actually changed, so an unrelated rename does
    // not invalidate work generated against this version.
    const changed = existing.subjectTpl !== parsed.subjectTpl || existing.bodyTpl !== parsed.bodyTpl
    const version = changed ? existing.version + 1 : existing.version

    await db
      .update(templates)
      .set({
        name: parsed.name,
        subjectTpl: parsed.subjectTpl,
        bodyTpl: parsed.bodyTpl,
        complianceProfile: parsed.complianceProfile,
        variables: check.variables,
        aiConfig: { ...existing.aiConfig, enabled: check.usesAi },
        version,
        updatedAt: new Date(),
      })
      .where(eq(templates.id, templateId))

    revalidatePath('/templates')
    revalidatePath(`/templates/${templateId}`)
    return { ok: true, data: { version } }
  } catch (error) {
    return fail(error)
  }
}

export async function deleteTemplate(id: string): Promise<ActionResult> {
  try {
    const userId = await requireUserId()
    const templateId = z.uuid().parse(id)

    const deleted = await db
      .delete(templates)
      .where(and(eq(templates.id, templateId), eq(templates.userId, userId)))
      .returning({ id: templates.id })

    if (deleted.length === 0) return { ok: false, error: 'Template not found' }

    await db.insert(auditLog).values({
      userId,
      action: 'template.deleted',
      entityType: 'template',
      entityId: templateId,
    })

    revalidatePath('/templates')
    return { ok: true, data: undefined }
  } catch (error) {
    return fail(error)
  }
}
