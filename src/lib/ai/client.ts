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

import Anthropic from '@anthropic-ai/sdk'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { aiCredentials, aiUsage } from '@/db/schema'
import { open } from '@/lib/crypto'
import { costOf, type Usage } from '@/core/ai/cost'
import { modelInfo, type ModelId } from '@/core/ai/models'
import { buildSystemPrompt, buildUserPrompt, type GuardrailKey } from '@/core/ai/prompt'
import { process as processSlot } from '@/core/ai/guardrails'
import type { GeneratedSlot, SlotConfig } from '@/core/ai/types'

/**
 * Anthropic client, built from the signed-in user's own key.
 *
 * This app ships no key. The user's is decrypted per call and never cached in
 * a module-level variable — a long-lived process must not hold someone's
 * plaintext credential in memory between requests.
 *
 * `server-only` makes importing this from a client component a build error
 * rather than a runtime leak.
 */

export class NoApiKeyError extends Error {
  constructor() {
    super('No Anthropic API key is configured. Add one in Settings → AI.')
    this.name = 'NoApiKeyError'
  }
}

export class SpendCapError extends Error {
  constructor(capUsd: number) {
    super(`Spend cap of $${capUsd.toFixed(2)} reached for this campaign.`)
    this.name = 'SpendCapError'
  }
}

interface Credentials {
  client: Anthropic
  model: ModelId | string
  useCaching: boolean
  useBatch: boolean
}

export async function loadCredentials(userId: string): Promise<Credentials> {
  const row = await db.query.aiCredentials.findFirst({
    where: eq(aiCredentials.userId, userId),
  })
  if (!row) throw new NoApiKeyError()

  // AAD binds the ciphertext to this user; a row copied from another account
  // fails to decrypt rather than yielding a usable key.
  const apiKey = open({ ciphertext: row.keyCiphertext, iv: row.keyIv, tag: row.keyTag }, userId)

  return {
    client: new Anthropic({ apiKey, maxRetries: 2 }),
    model: row.defaultModel,
    useCaching: row.usePromptCaching,
    useBatch: row.useBatchApi,
  }
}

/**
 * Validate a key by making the smallest possible authenticated request.
 *
 * `countTokens` costs nothing and still exercises authentication, so a typo is
 * caught at paste time rather than at generation time on row 1 of 1,200.
 */
export async function validateApiKey(
  apiKey: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const client = new Anthropic({ apiKey, maxRetries: 0 })
  try {
    await client.messages.countTokens({
      model: 'claude-haiku-4-5',
      messages: [{ role: 'user', content: 'x' }],
    })
    return { ok: true }
  } catch (error) {
    return { ok: false, error: describeError(error) }
  }
}

/** Turn an SDK error into something a person can act on. */
export function describeError(error: unknown): string {
  if (error instanceof Anthropic.AuthenticationError) {
    return 'That key was rejected. Check it was copied in full from console.anthropic.com.'
  }
  if (error instanceof Anthropic.PermissionDeniedError) {
    return 'That key is valid but not permitted to use this model.'
  }
  if (error instanceof Anthropic.RateLimitError) {
    return 'Anthropic rate-limited the request. Wait a moment and try again.'
  }
  if (error instanceof Anthropic.BadRequestError) {
    return `Anthropic rejected the request: ${error.message}`
  }
  // APIConnectionError extends APIError in the TypeScript SDK, so it is
  // checked before the general case.
  if (error instanceof Anthropic.APIConnectionError) {
    return 'Could not reach Anthropic. Check your connection.'
  }
  if (error instanceof Anthropic.APIError) {
    return `Anthropic returned ${error.status}: ${error.message}`
  }
  if (error instanceof NoApiKeyError || error instanceof SpendCapError) return error.message
  return error instanceof Error ? error.message : 'Generation failed'
}

/**
 * Build the Messages request for one slot.
 *
 * Shared by the synchronous path and the Batch API path deliberately: if the
 * two built their requests separately they would drift, and a drifted system
 * block is a different cache prefix — silently turning a 10% read into a full
 * -price write on every row.
 */
export function buildSlotRequest(input: {
  bodyTemplate: string
  slot: SlotConfig
  data: Record<string, string>
  availableFields: string[]
  tone?: string
  guardrails?: GuardrailKey[]
  model: ModelId | string
  useCaching: boolean
}) {
  const system = buildSystemPrompt({
    bodyTemplate: input.bodyTemplate,
    slot: input.slot,
    tone: input.tone,
    guardrails: input.guardrails,
    availableFields: input.availableFields,
  })
  const info = modelInfo(input.model)

  return {
    model: input.model,
    max_tokens: 2000,
    system: input.useCaching
      ? // Byte-identical for every row — that is what makes it cacheable.
        // Nothing row-specific may go in here.
        [{ type: 'text' as const, text: system, cache_control: { type: 'ephemeral' as const } }]
      : system,
    messages: [{ role: 'user' as const, content: buildUserPrompt(input.data) }],
    // `effort` is rejected by models that do not support it, and the user
    // chooses the model. Low effort suits a short, tightly-briefed passage.
    ...(info.supportsEffort ? { output_config: { effort: 'low' as const } } : {}),
  }
}

/** Extract the text a model returned, ignoring any non-text blocks. */
export function textOf(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('')
}

export interface GenerateSlotInput {
  userId: string
  bodyTemplate: string
  slot: SlotConfig
  data: Record<string, string>
  availableFields: string[]
  tone?: string
  guardrails?: GuardrailKey[]
  campaignId?: string
  /** Overrides the stored default, for a one-off retry at a stronger model. */
  model?: ModelId | string
}

export interface GenerateSlotResult {
  generated: GeneratedSlot
  usage: Usage
  costUsd: number
  model: string
  cacheHit: boolean
}

/**
 * Generate one slot for one recipient.
 *
 * One call per slot rather than one call filling all slots at once. The reason
 * is robustness in a bring-your-own-key app: structured output and tool
 * schemas are not supported identically across every model a user might
 * choose, whereas "return a short passage as plain text" works everywhere.
 * The shared prefix is cached either way, so for the common single-slot
 * template the cost is the same.
 */
export async function generateSlot(input: GenerateSlotInput): Promise<GenerateSlotResult> {
  const credentials = await loadCredentials(input.userId)
  const model = input.model ?? credentials.model

  const response = await credentials.client.messages.create(
    buildSlotRequest({
      bodyTemplate: input.bodyTemplate,
      slot: input.slot,
      data: input.data,
      availableFields: input.availableFields,
      tone: input.tone,
      guardrails: input.guardrails,
      model,
      useCaching: credentials.useCaching,
    }),
  )

  const raw = textOf(response.content)

  const usage: Usage = {
    input_tokens: response.usage.input_tokens,
    output_tokens: response.usage.output_tokens,
    cache_creation_input_tokens: response.usage.cache_creation_input_tokens,
    cache_read_input_tokens: response.usage.cache_read_input_tokens,
  }
  const breakdown = costOf(model, usage)

  // Recorded from the response, never estimated. This is what the meter and
  // the spend cap read.
  await db.insert(aiUsage).values({
    userId: input.userId,
    campaignId: input.campaignId,
    model,
    inputTokens: breakdown.inputTokens,
    cacheReadTokens: breakdown.cacheReadTokens,
    cacheWriteTokens: breakdown.cacheWriteTokens,
    outputTokens: breakdown.outputTokens,
    costUsd: breakdown.costUsd.toFixed(6),
  })

  return {
    generated: processSlot(raw, input.slot, input.guardrails ?? [], input.data),
    usage,
    costUsd: breakdown.costUsd,
    model,
    cacheHit: (usage.cache_read_input_tokens ?? 0) > 0,
  }
}
