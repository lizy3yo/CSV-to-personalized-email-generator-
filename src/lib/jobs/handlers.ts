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

import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { db } from '@/db'
import { aiUsage, auditLog, campaignRecipients, campaigns, contacts, templates } from '@/db/schema'
import { enqueue, enqueueMany, type JobRow } from '@/lib/queue'
import {
  buildSlotRequest,
  loadCredentials,
  NoApiKeyError,
  textOf,
  generateSlot,
} from '@/lib/ai/client'
import { costOf } from '@/core/ai/cost'
import { process as processSlot } from '@/core/ai/guardrails'
import type { GuardrailKey } from '@/core/ai/prompt'
import type { SlotConfig, Violation } from '@/core/ai/types'
import { parse } from '@/core/template/parse'
import { idempotencyKeyFor, renderAndSaveRecipient } from './render'
import { handleCampaignDispatch } from './send'
import { handleInboxPoll } from './inbox'

/**
 * Job handlers.
 *
 * Every handler must be safe to run twice. The worker increments `attempts` at
 * claim time and a crashed worker's jobs are reclaimed after their lease
 * lapses, so "ran halfway, died, ran again" is the normal case rather than the
 * exceptional one.
 */

export type JobHandler = (job: JobRow) => Promise<void>

/** Below this, generating inline is faster than waiting on a batch. */
const BATCH_THRESHOLD = 20

/** How long to wait between polls of a submitted batch. */
const BATCH_POLL_INTERVAL_MS = 60_000

function slotConfigsFor(
  aiConfig: { slots?: Record<string, { brief: string; maxSentences?: number }> },
  slotNames: string[],
): SlotConfig[] {
  return slotNames.map((name) => ({
    name,
    brief: aiConfig.slots?.[name]?.brief ?? '',
    maxSentences: aiConfig.slots?.[name]?.maxSentences,
  }))
}

async function loadCampaignContext(campaignId: string) {
  const campaign = await db.query.campaigns.findFirst({ where: eq(campaigns.id, campaignId) })
  if (!campaign) throw new Error(`Campaign ${campaignId} not found`)
  if (!campaign.templateId) throw new Error('Campaign has no template')
  if (!campaign.listId) throw new Error('Campaign has no contact list')

  const template = await db.query.templates.findFirst({
    where: eq(templates.id, campaign.templateId),
  })
  if (!template) throw new Error('Template not found')

  const parsed = parse(template.bodyTpl)
  const subjectParsed = parse(template.subjectTpl)
  const slotNames = [...new Set([...parsed.slots, ...subjectParsed.slots])]

  return { campaign, template, slotNames }
}

// ─── campaign.generate ───────────────────────────────────────────────────────

/**
 * Create a row for every contact, then decide how to fill it.
 *
 * Recipient creation is idempotent through a deterministic idempotency key and
 * `onConflictDoNothing`, so a retry after a partial run tops up the missing
 * rows rather than duplicating the ones already there.
 */
export const handleCampaignGenerate: JobHandler = async (job) => {
  const campaignId = String(job.payload.campaignId)
  const { campaign, template, slotNames } = await loadCampaignContext(campaignId)

  await db
    .update(campaigns)
    .set({ status: 'generating', startedAt: campaign.startedAt ?? new Date() })
    .where(eq(campaigns.id, campaignId))

  const list = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(eq(contacts.listId, campaign.listId!))
    .orderBy(asc(contacts.rowNumber))

  if (list.length > 0) {
    await db
      .insert(campaignRecipients)
      .values(
        list.map((contact) => ({
          userId: campaign.userId,
          campaignId,
          contactId: contact.id,
          idempotencyKey: idempotencyKeyFor(campaignId, contact.id),
        })),
      )
      .onConflictDoNothing({
        target: [campaignRecipients.campaignId, campaignRecipients.contactId],
      })
  }

  // Only rows that still need work — a retry must not redo finished ones.
  const pending = await db
    .select({ id: campaignRecipients.id })
    .from(campaignRecipients)
    .where(
      and(
        eq(campaignRecipients.campaignId, campaignId),
        inArray(campaignRecipients.status, ['pending', 'generating']),
      ),
    )

  if (pending.length === 0) {
    await finishGeneration(campaignId)
    return
  }

  // No AI slots: rendering is pure and local, so it happens here.
  if (slotNames.length === 0) {
    await renderPending(campaignId, template.subjectTpl, template.bodyTpl, {})
    await finishGeneration(campaignId)
    return
  }

  let hasKey = true
  try {
    await loadCredentials(campaign.userId)
  } catch (error) {
    if (!(error instanceof NoApiKeyError)) throw error
    hasKey = false
  }

  if (!hasKey) {
    // Render anyway. The slots come out empty and every row is flagged, which
    // is honest and reviewable — better than refusing to generate at all.
    await renderPending(campaignId, template.subjectTpl, template.bodyTpl, {})
    await finishGeneration(campaignId)
    return
  }

  const credentials = await loadCredentials(campaign.userId)
  const useBatch = credentials.useBatch && pending.length >= BATCH_THRESHOLD

  if (useBatch) {
    await enqueue({ userId: campaign.userId, type: 'batch.submit', payload: { campaignId } })
    return
  }

  await enqueueMany(
    pending.map((recipient) => ({
      userId: campaign.userId,
      type: 'recipient.generate',
      payload: { campaignId, recipientId: recipient.id },
    })),
  )
}

/** Render every pending recipient with the slot values given (possibly none). */
async function renderPending(
  campaignId: string,
  subjectTpl: string,
  bodyTpl: string,
  slotsByRecipient: Record<string, Record<string, string>>,
  violationsByRecipient: Record<string, Violation[]> = {},
): Promise<void> {
  const rows = await db
    .select({
      id: campaignRecipients.id,
      data: contacts.data,
    })
    .from(campaignRecipients)
    .innerJoin(contacts, eq(contacts.id, campaignRecipients.contactId))
    .where(
      and(
        eq(campaignRecipients.campaignId, campaignId),
        inArray(campaignRecipients.status, ['pending', 'generating']),
      ),
    )

  for (const row of rows) {
    await renderAndSaveRecipient({
      recipientId: row.id,
      subjectTpl,
      bodyTpl,
      data: row.data,
      slots: slotsByRecipient[row.id] ?? {},
      violations: violationsByRecipient[row.id],
    })
  }
}

/** Move the campaign to review once nothing is outstanding. */
async function finishGeneration(campaignId: string): Promise<void> {
  const [outstanding] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(campaignRecipients)
    .where(
      and(
        eq(campaignRecipients.campaignId, campaignId),
        inArray(campaignRecipients.status, ['pending', 'generating']),
      ),
    )

  if (outstanding.count > 0) return

  const campaign = await db.query.campaigns.findFirst({ where: eq(campaigns.id, campaignId) })
  if (!campaign) return

  await db.update(campaigns).set({ status: 'reviewing' }).where(eq(campaigns.id, campaignId))
  await db.insert(auditLog).values({
    userId: campaign.userId,
    action: 'campaign.generated',
    entityType: 'campaign',
    entityId: campaignId,
  })
}

// ─── recipient.generate ──────────────────────────────────────────────────────

/** Fill one recipient's slots synchronously, then render. */
export const handleRecipientGenerate: JobHandler = async (job) => {
  const campaignId = String(job.payload.campaignId)
  const recipientId = String(job.payload.recipientId)

  const recipient = await db.query.campaignRecipients.findFirst({
    where: eq(campaignRecipients.id, recipientId),
  })
  if (!recipient) return
  // Already done by an earlier attempt, or rejected by a human since.
  if (recipient.status !== 'pending' && recipient.status !== 'generating') return

  const { campaign, template, slotNames } = await loadCampaignContext(campaignId)

  const contact = await db.query.contacts.findFirst({
    where: eq(contacts.id, recipient.contactId),
  })
  if (!contact) throw new Error('Contact not found')

  await db
    .update(campaignRecipients)
    .set({ status: 'generating' })
    .where(eq(campaignRecipients.id, recipientId))

  const slots: Record<string, string> = {}
  const violations: Violation[] = []

  for (const slot of slotConfigsFor(template.aiConfig, slotNames)) {
    const result = await generateSlot({
      userId: campaign.userId,
      bodyTemplate: template.bodyTpl,
      slot,
      data: contact.data,
      availableFields: template.variables,
      tone: template.aiConfig.tone,
      guardrails: template.aiConfig.guardrails as GuardrailKey[] | undefined,
      campaignId,
    })
    slots[slot.name] = result.generated.text
    violations.push(...result.generated.violations)
  }

  await renderAndSaveRecipient({
    recipientId,
    subjectTpl: template.subjectTpl,
    bodyTpl: template.bodyTpl,
    data: contact.data,
    slots,
    violations,
  })

  await finishGeneration(campaignId)
}

// ─── batch.submit ────────────────────────────────────────────────────────────

/** custom_id encodes which recipient and which slot a result belongs to. */
function customId(recipientId: string, slotName: string): string {
  return `${recipientId}__${slotName}`
}
function parseCustomId(value: string): { recipientId: string; slotName: string } | null {
  const index = value.indexOf('__')
  if (index === -1) return null
  return { recipientId: value.slice(0, index), slotName: value.slice(index + 2) }
}

export const handleBatchSubmit: JobHandler = async (job) => {
  const campaignId = String(job.payload.campaignId)
  const { campaign, template, slotNames } = await loadCampaignContext(campaignId)

  // Already submitted by an attempt that died before enqueuing the poll.
  // Submitting again would create — and bill for — a second batch.
  if (campaign.generationBatchId) {
    await enqueue({
      userId: campaign.userId,
      type: 'batch.poll',
      payload: { campaignId, batchId: campaign.generationBatchId },
      runAfter: new Date(Date.now() + BATCH_POLL_INTERVAL_MS),
    })
    return
  }

  const rows = await db
    .select({ id: campaignRecipients.id, data: contacts.data })
    .from(campaignRecipients)
    .innerJoin(contacts, eq(contacts.id, campaignRecipients.contactId))
    .where(
      and(
        eq(campaignRecipients.campaignId, campaignId),
        inArray(campaignRecipients.status, ['pending', 'generating']),
      ),
    )

  if (rows.length === 0) {
    await finishGeneration(campaignId)
    return
  }

  const credentials = await loadCredentials(campaign.userId)
  const slotConfigs = slotConfigsFor(template.aiConfig, slotNames)

  const requests = rows.flatMap((row) =>
    slotConfigs.map((slot) => ({
      custom_id: customId(row.id, slot.name),
      params: buildSlotRequest({
        bodyTemplate: template.bodyTpl,
        slot,
        data: row.data,
        availableFields: template.variables,
        tone: template.aiConfig.tone,
        guardrails: template.aiConfig.guardrails as GuardrailKey[] | undefined,
        model: credentials.model,
        useCaching: credentials.useCaching,
      }),
    })),
  )

  const batch = await credentials.client.messages.batches.create({ requests })

  // Recorded immediately, before anything else can fail. The window in which
  // a crash could cause a duplicate submission is now a single UPDATE wide.
  await db
    .update(campaigns)
    .set({ generationBatchId: batch.id })
    .where(eq(campaigns.id, campaignId))

  await db
    .update(campaignRecipients)
    .set({ status: 'generating' })
    .where(
      and(eq(campaignRecipients.campaignId, campaignId), eq(campaignRecipients.status, 'pending')),
    )

  await enqueue({
    userId: campaign.userId,
    type: 'batch.poll',
    payload: { campaignId, batchId: batch.id },
    runAfter: new Date(Date.now() + BATCH_POLL_INTERVAL_MS),
    // Long-lived: a batch may take up to 24 hours, so polling must outlast
    // the default retry budget.
    maxAttempts: 200,
  })
}

// ─── batch.poll ──────────────────────────────────────────────────────────────

export const handleBatchPoll: JobHandler = async (job) => {
  const campaignId = String(job.payload.campaignId)
  const batchId = String(job.payload.batchId)

  const { campaign, template, slotNames } = await loadCampaignContext(campaignId)
  const credentials = await loadCredentials(campaign.userId)

  const batch = await credentials.client.messages.batches.retrieve(batchId)

  if (batch.processing_status !== 'ended') {
    // Not an error, so it does not consume the retry budget: this job finishes
    // and schedules its own successor.
    await enqueue({
      userId: campaign.userId,
      type: 'batch.poll',
      payload: { campaignId, batchId },
      runAfter: new Date(Date.now() + BATCH_POLL_INTERVAL_MS),
      maxAttempts: 200,
    })
    return
  }

  const slotConfigs = new Map(slotConfigsFor(template.aiConfig, slotNames).map((s) => [s.name, s]))
  const slotsByRecipient: Record<string, Record<string, string>> = {}
  const violationsByRecipient: Record<string, Violation[]> = {}
  const usageRows: (typeof aiUsage.$inferInsert)[] = []

  // Results arrive in any order — keyed by custom_id, never by position.
  for await (const result of await credentials.client.messages.batches.results(batchId)) {
    const parsed = parseCustomId(result.custom_id)
    if (!parsed) continue
    const slot = slotConfigs.get(parsed.slotName)
    if (!slot) continue

    slotsByRecipient[parsed.recipientId] ??= {}
    violationsByRecipient[parsed.recipientId] ??= []

    if (result.result.type !== 'succeeded') {
      violationsByRecipient[parsed.recipientId].push({
        kind: 'empty',
        message:
          result.result.type === 'errored'
            ? `Batch request failed: ${result.result.error.type}`
            : `Batch request ${result.result.type}`,
        severity: 'error',
      })
      slotsByRecipient[parsed.recipientId][parsed.slotName] = ''
      continue
    }

    const message = result.result.message
    const contact = await db
      .select({ data: contacts.data })
      .from(campaignRecipients)
      .innerJoin(contacts, eq(contacts.id, campaignRecipients.contactId))
      .where(eq(campaignRecipients.id, parsed.recipientId))
      .limit(1)

    const generated = processSlot(
      textOf(message.content),
      slot,
      template.aiConfig.guardrails as GuardrailKey[] | undefined,
      contact[0]?.data ?? {},
    )

    slotsByRecipient[parsed.recipientId][parsed.slotName] = generated.text
    violationsByRecipient[parsed.recipientId].push(...generated.violations)

    // Batch pricing is half, and `costOf` is told so.
    const breakdown = costOf(
      message.model,
      {
        input_tokens: message.usage.input_tokens,
        output_tokens: message.usage.output_tokens,
        cache_creation_input_tokens: message.usage.cache_creation_input_tokens,
        cache_read_input_tokens: message.usage.cache_read_input_tokens,
      },
      true,
    )
    usageRows.push({
      userId: campaign.userId,
      campaignId,
      model: message.model,
      inputTokens: breakdown.inputTokens,
      cacheReadTokens: breakdown.cacheReadTokens,
      cacheWriteTokens: breakdown.cacheWriteTokens,
      outputTokens: breakdown.outputTokens,
      costUsd: breakdown.costUsd.toFixed(6),
    })
  }

  if (usageRows.length > 0) await db.insert(aiUsage).values(usageRows)

  await renderPending(
    campaignId,
    template.subjectTpl,
    template.bodyTpl,
    slotsByRecipient,
    violationsByRecipient,
  )
  await finishGeneration(campaignId)
}

// ─── registry ────────────────────────────────────────────────────────────────

export const HANDLERS: Record<string, JobHandler> = {
  'campaign.generate': handleCampaignGenerate,
  'recipient.generate': handleRecipientGenerate,
  'batch.submit': handleBatchSubmit,
  'batch.poll': handleBatchPoll,
  // Sends one approved email, then reschedules itself at the pace interval.
  'campaign.dispatch': handleCampaignDispatch,
  // Opt-in. Reads the mailbox for bounces and replies, then reschedules.
  'inbox.poll': handleInboxPoll,
}
