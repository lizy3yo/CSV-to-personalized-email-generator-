'use server'

import { and, eq, sql } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { db } from '@/db'
import { auditLog, campaignRecipients, campaigns, contacts, templates } from '@/db/schema'
import { requireUserId } from '@/lib/auth/require-user'
import { enqueue } from '@/lib/queue'

export type ActionResult<T = void> = { ok: true; data: T } | { ok: false; error: string }

function fail(error: unknown): { ok: false; error: string } {
  if (error instanceof z.ZodError) {
    return { ok: false, error: error.issues.map((i) => i.message).join('; ') }
  }
  console.error('[campaigns/actions]', error)
  return { ok: false, error: error instanceof Error ? error.message : 'Something went wrong' }
}

const createSchema = z.object({
  name: z.string().trim().min(1, 'Give the campaign a name').max(200),
  listId: z.uuid('Choose a contact list'),
  templateId: z.uuid('Choose a template'),
})

export async function createCampaign(
  input: z.input<typeof createSchema>,
): Promise<ActionResult<{ id: string }>> {
  try {
    const userId = await requireUserId()
    const parsed = createSchema.parse(input)

    const template = await db.query.templates.findFirst({
      where: and(eq(templates.id, parsed.templateId), eq(templates.userId, userId)),
    })
    if (!template) return { ok: false, error: 'Template not found' }

    const [row] = await db
      .insert(campaigns)
      .values({
        userId,
        name: parsed.name,
        listId: parsed.listId,
        templateId: parsed.templateId,
        // Inherited from the template so the send path does not have to guess.
        complianceProfile: template.complianceProfile,
      })
      .returning({ id: campaigns.id })

    await db.insert(auditLog).values({
      userId,
      action: 'campaign.created',
      entityType: 'campaign',
      entityId: row.id,
      after: { name: parsed.name },
    })

    revalidatePath('/campaigns')
    return { ok: true, data: { id: row.id } }
  } catch (error) {
    return fail(error)
  }
}

/**
 * Queue generation.
 *
 * The action only enqueues; the worker does the work. That is what keeps a
 * 1,200-row campaign from being bounded by an HTTP request, and what lets the
 * run resume if the machine goes to sleep halfway through.
 *
 * Enqueuing twice is harmless — the handler tops up missing recipient rows
 * rather than duplicating the ones already there — but the guard below keeps
 * the queue tidy.
 */
export async function startGeneration(campaignId: string): Promise<ActionResult> {
  try {
    const userId = await requireUserId()
    const id = z.uuid().parse(campaignId)

    const campaign = await db.query.campaigns.findFirst({
      where: and(eq(campaigns.id, id), eq(campaigns.userId, userId)),
    })
    if (!campaign) return { ok: false, error: 'Campaign not found' }
    if (campaign.status === 'generating') {
      return { ok: false, error: 'Generation is already running' }
    }
    if (!campaign.listId || !campaign.templateId) {
      return { ok: false, error: 'Campaign needs both a contact list and a template' }
    }

    await enqueue({ userId, type: 'campaign.generate', payload: { campaignId: id } })
    await db.update(campaigns).set({ status: 'generating' }).where(eq(campaigns.id, id))

    revalidatePath('/campaigns')
    revalidatePath(`/campaigns/${id}`)
    return { ok: true, data: undefined }
  } catch (error) {
    return fail(error)
  }
}

export async function deleteCampaign(campaignId: string): Promise<ActionResult> {
  try {
    const userId = await requireUserId()
    const id = z.uuid().parse(campaignId)

    const deleted = await db
      .delete(campaigns)
      .where(and(eq(campaigns.id, id), eq(campaigns.userId, userId)))
      .returning({ id: campaigns.id })

    if (deleted.length === 0) return { ok: false, error: 'Campaign not found' }

    revalidatePath('/campaigns')
    return { ok: true, data: undefined }
  } catch (error) {
    return fail(error)
  }
}

export interface CampaignProgress {
  status: string
  total: number
  byStatus: Record<string, number>
  costUsd: number
}

/** Polled by the campaign page while generation runs. */
export async function getCampaignProgress(campaignId: string): Promise<CampaignProgress | null> {
  const userId = await requireUserId()
  const id = z.uuid().parse(campaignId)

  const campaign = await db.query.campaigns.findFirst({
    where: and(eq(campaigns.id, id), eq(campaigns.userId, userId)),
  })
  if (!campaign) return null

  const rows = await db
    .select({ status: campaignRecipients.status, count: sql<number>`count(*)::int` })
    .from(campaignRecipients)
    .where(eq(campaignRecipients.campaignId, id))
    .groupBy(campaignRecipients.status)

  const byStatus: Record<string, number> = {}
  let total = 0
  for (const row of rows) {
    byStatus[row.status] = row.count
    total += row.count
  }

  const [cost] = await db
    .select({ sum: sql<string>`coalesce(sum(cost_usd), 0)` })
    .from(sql`ai_usage`)
    .where(sql`campaign_id = ${id}`)

  return { status: campaign.status, total, byStatus, costUsd: Number(cost?.sum ?? 0) }
}

/** Lists and templates that can be used to start a campaign. */
export async function getCampaignOptions() {
  const userId = await requireUserId()

  const lists = await db
    .select({
      id: sql<string>`cl.id`,
      name: sql<string>`cl.name`,
      contactCount: sql<number>`count(${contacts.id})::int`,
    })
    .from(sql`contact_lists cl`)
    .leftJoin(contacts, sql`${contacts.listId} = cl.id`)
    .where(sql`cl.user_id = ${userId}`)
    .groupBy(sql`cl.id, cl.name`)

  const templateRows = await db
    .select({ id: templates.id, name: templates.name })
    .from(templates)
    .where(eq(templates.userId, userId))

  return { lists, templates: templateRows }
}
