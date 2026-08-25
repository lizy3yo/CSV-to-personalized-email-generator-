'use server'

import { and, eq, gte, sql } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { db } from '@/db'
import { aiCredentials, aiUsage, auditLog, profiles } from '@/db/schema'
import { requireUserId } from '@/lib/auth/require-user'
import { fingerprint, seal } from '@/lib/crypto'
import { validateApiKey } from '@/lib/ai/client'
import { MODEL_IDS } from '@/core/ai/models'

/**
 * Settings for the bring-your-own-key AI layer.
 *
 * The key is validated against Anthropic before it is stored, encrypted with
 * the user id as AAD, and never sent back to the browser — the UI only ever
 * receives the last four characters.
 */

export type ActionResult<T = void> = { ok: true; data: T } | { ok: false; error: string }

function fail(error: unknown): { ok: false; error: string } {
  if (error instanceof z.ZodError) {
    return { ok: false, error: error.issues.map((i) => i.message).join('; ') }
  }
  // Deliberately not logging the error object here: a failure while handling a
  // key must not risk the key reaching a log line.
  console.error('[settings/actions] failed:', error instanceof Error ? error.name : 'unknown')
  return { ok: false, error: error instanceof Error ? error.message : 'Something went wrong' }
}

const keySchema = z
  .string()
  .trim()
  .min(20, 'That key looks too short — copy the whole thing')
  .max(500)
  .refine((v) => v.startsWith('sk-ant-'), 'An Anthropic key starts with "sk-ant-"')

export async function saveApiKey(rawKey: string): Promise<ActionResult<{ last4: string }>> {
  try {
    const userId = await requireUserId()
    const apiKey = keySchema.parse(rawKey)

    // Checked before storing, so a typo surfaces now rather than on row 1 of
    // 1,200. countTokens is free and still exercises authentication.
    const check = await validateApiKey(apiKey)
    if (!check.ok) return { ok: false, error: check.error }

    const sealed = seal(apiKey, userId)
    const last4 = fingerprint(apiKey)

    const existing = await db.query.aiCredentials.findFirst({
      where: and(eq(aiCredentials.userId, userId), eq(aiCredentials.provider, 'anthropic')),
    })

    const values = {
      userId,
      provider: 'anthropic',
      keyCiphertext: sealed.ciphertext,
      keyIv: sealed.iv,
      keyTag: sealed.tag,
      keyLast4: last4,
      lastValidatedAt: new Date(),
      updatedAt: new Date(),
    }

    if (existing) {
      await db.update(aiCredentials).set(values).where(eq(aiCredentials.id, existing.id))
    } else {
      await db.insert(aiCredentials).values(values)
    }

    // The audit trail records that a key was set, never any part of the key
    // beyond the display fingerprint.
    await db.insert(auditLog).values({
      userId,
      action: existing ? 'ai_key.replaced' : 'ai_key.added',
      entityType: 'ai_credential',
      after: { last4 },
    })

    revalidatePath('/settings/ai')
    return { ok: true, data: { last4 } }
  } catch (error) {
    return fail(error)
  }
}

export async function removeApiKey(): Promise<ActionResult> {
  try {
    const userId = await requireUserId()
    await db.delete(aiCredentials).where(eq(aiCredentials.userId, userId))
    await db.insert(auditLog).values({
      userId,
      action: 'ai_key.removed',
      entityType: 'ai_credential',
    })
    revalidatePath('/settings/ai')
    return { ok: true, data: undefined }
  } catch (error) {
    return fail(error)
  }
}

const settingsSchema = z.object({
  defaultModel: z.enum(MODEL_IDS as [string, ...string[]]),
  usePromptCaching: z.boolean(),
  useBatchApi: z.boolean(),
})

export async function updateAiSettings(
  input: z.input<typeof settingsSchema>,
): Promise<ActionResult> {
  try {
    const userId = await requireUserId()
    const parsed = settingsSchema.parse(input)

    const updated = await db
      .update(aiCredentials)
      .set({ ...parsed, updatedAt: new Date() })
      .where(eq(aiCredentials.userId, userId))
      .returning({ id: aiCredentials.id })

    if (updated.length === 0) return { ok: false, error: 'Add a key first' }

    revalidatePath('/settings/ai')
    return { ok: true, data: undefined }
  } catch (error) {
    return fail(error)
  }
}

export interface UsageSummary {
  monthCostUsd: number
  monthCalls: number
  totalCostUsd: number
  inputTokens: number
  cacheReadTokens: number
  outputTokens: number
}

/** Real spend, summed from what the API actually reported. */
export async function getUsageSummary(): Promise<UsageSummary> {
  const userId = await requireUserId()

  const monthStart = new Date()
  monthStart.setUTCDate(1)
  monthStart.setUTCHours(0, 0, 0, 0)

  const [month] = await db
    .select({
      cost: sql<string>`coalesce(sum(${aiUsage.costUsd}), 0)`,
      calls: sql<number>`count(*)::int`,
      input: sql<number>`coalesce(sum(${aiUsage.inputTokens}), 0)::int`,
      cacheRead: sql<number>`coalesce(sum(${aiUsage.cacheReadTokens}), 0)::int`,
      output: sql<number>`coalesce(sum(${aiUsage.outputTokens}), 0)::int`,
    })
    .from(aiUsage)
    .where(and(eq(aiUsage.userId, userId), gte(aiUsage.createdAt, monthStart)))

  const [total] = await db
    .select({ cost: sql<string>`coalesce(sum(${aiUsage.costUsd}), 0)` })
    .from(aiUsage)
    .where(eq(aiUsage.userId, userId))

  return {
    monthCostUsd: Number(month?.cost ?? 0),
    monthCalls: month?.calls ?? 0,
    totalCostUsd: Number(total?.cost ?? 0),
    inputTokens: month?.input ?? 0,
    cacheReadTokens: month?.cacheRead ?? 0,
    outputTokens: month?.output ?? 0,
  }
}

// ─── compliance ──────────────────────────────────────────────────────────────

const complianceSchema = z.object({
  senderName: z.string().trim().max(200).optional(),
  /**
   * Required to send. CAN-SPAM asks for a valid physical postal address in
   * every commercial email, and 1:1 sales outreach is commercial — so this is
   * a legal requirement rather than a preference, and the send preflight
   * blocks without it.
   */
  postalAddress: z.string().trim().max(1000).optional(),
  optOutLine: z.string().trim().max(500).optional(),
})

export async function updateComplianceSettings(
  input: z.input<typeof complianceSchema>,
): Promise<ActionResult> {
  try {
    const userId = await requireUserId()
    const parsed = complianceSchema.parse(input)

    await db
      .update(profiles)
      .set({
        senderName: parsed.senderName || null,
        postalAddress: parsed.postalAddress || null,
        optOutLine: parsed.optOutLine || null,
        updatedAt: new Date(),
      })
      .where(eq(profiles.id, userId))

    await db.insert(auditLog).values({
      userId,
      action: 'compliance.updated',
      entityType: 'profile',
      entityId: userId,
      after: { hasPostalAddress: Boolean(parsed.postalAddress) },
    })

    revalidatePath('/settings/compliance')
    return { ok: true, data: undefined }
  } catch (error) {
    return fail(error)
  }
}

export async function getComplianceSettings() {
  const userId = await requireUserId()
  const profile = await db.query.profiles.findFirst({ where: eq(profiles.id, userId) })
  return {
    senderName: profile?.senderName ?? '',
    postalAddress: profile?.postalAddress ?? '',
    optOutLine: profile?.optOutLine ?? '',
  }
}
