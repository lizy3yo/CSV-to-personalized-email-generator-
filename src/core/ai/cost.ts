import {
  BATCH_MULTIPLIER,
  CACHE_READ_MULTIPLIER,
  CACHE_WRITE_MULTIPLIER,
  modelInfo,
  type ModelId,
} from './models'

/**
 * Cost accounting.
 *
 * Two distinct jobs, deliberately separated:
 *
 *   `costOf`      — what a call ACTUALLY cost, from the `usage` block the API
 *                   returned. This drives the running total and the spend cap.
 *
 *   `estimate`    — what a campaign will PROBABLY cost, from token counts we
 *                   guessed. Shown before generation, always labelled as an
 *                   estimate.
 *
 * Conflating them is how a cost meter ends up confidently wrong.
 */

/** The token counts Anthropic returns on every response. */
export interface Usage {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens?: number | null
  cache_read_input_tokens?: number | null
}

export interface CostBreakdown {
  inputTokens: number
  cacheWriteTokens: number
  cacheReadTokens: number
  outputTokens: number
  costUsd: number
}

/**
 * Cost of one real call.
 *
 * `input_tokens` excludes cached tokens — the API reports them separately, so
 * these are added rather than being three views of the same number.
 */
export function costOf(model: ModelId | string, usage: Usage, batch = false): CostBreakdown {
  const info = modelInfo(model)
  const inputTokens = usage.input_tokens ?? 0
  const cacheWriteTokens = usage.cache_creation_input_tokens ?? 0
  const cacheReadTokens = usage.cache_read_input_tokens ?? 0
  const outputTokens = usage.output_tokens ?? 0

  const inputRate = info.inputPerMTok / 1_000_000
  const outputRate = info.outputPerMTok / 1_000_000

  const raw =
    inputTokens * inputRate +
    cacheWriteTokens * inputRate * CACHE_WRITE_MULTIPLIER +
    cacheReadTokens * inputRate * CACHE_READ_MULTIPLIER +
    outputTokens * outputRate

  return {
    inputTokens,
    cacheWriteTokens,
    cacheReadTokens,
    outputTokens,
    costUsd: raw * (batch ? BATCH_MULTIPLIER : 1),
  }
}

export interface EstimateInput {
  model: ModelId | string
  rows: number
  /** Tokens in the shared prefix — identical for every row, so cacheable. */
  systemTokens: number
  /** Tokens unique to each row. */
  perRowInputTokens: number
  /** Expected tokens generated per row. */
  perRowOutputTokens: number
  /** One call per slot, so this multiplies everything. */
  slotsPerRow?: number
  useCaching?: boolean
  useBatch?: boolean
}

export interface Estimate {
  calls: number
  costUsd: number
  /** What it would cost with caching and batching off, for comparison. */
  costWithoutOptimisationsUsd: number
  cachingApplies: boolean
}

/**
 * Estimate a campaign.
 *
 * The first call of a run writes the cache; the rest read it. That is why the
 * shared prefix is billed once at the write rate and then at a tenth of the
 * input rate, and why a long, stable system prompt is cheaper than a short
 * one repeated in full.
 */
export function estimate({
  model,
  rows,
  systemTokens,
  perRowInputTokens,
  perRowOutputTokens,
  slotsPerRow = 1,
  useCaching = true,
  useBatch = false,
}: EstimateInput): Estimate {
  const calls = Math.max(0, rows) * Math.max(1, slotsPerRow)
  if (calls === 0) {
    return { calls: 0, costUsd: 0, costWithoutOptimisationsUsd: 0, cachingApplies: false }
  }

  const price = (batch: boolean, caching: boolean) => {
    let total = 0
    for (let i = 0; i < calls; i++) {
      const usage: Usage = caching
        ? {
            input_tokens: perRowInputTokens,
            output_tokens: perRowOutputTokens,
            // The first call pays to write the prefix; every later one reads it.
            cache_creation_input_tokens: i === 0 ? systemTokens : 0,
            cache_read_input_tokens: i === 0 ? 0 : systemTokens,
          }
        : {
            input_tokens: systemTokens + perRowInputTokens,
            output_tokens: perRowOutputTokens,
          }
      total += costOf(model, usage, batch).costUsd
    }
    return total
  }

  return {
    calls,
    costUsd: price(useBatch, useCaching),
    costWithoutOptimisationsUsd: price(false, false),
    cachingApplies: useCaching,
  }
}

/**
 * Format a cost for display.
 *
 * Sub-cent amounts are common per row, and rounding them to `$0.00` makes the
 * meter look broken — so small values keep more decimals.
 */
export function formatUsd(amount: number): string {
  if (amount === 0) return '$0.00'
  if (amount < 0.01) return `$${amount.toFixed(4)}`
  if (amount < 1) return `$${amount.toFixed(3)}`
  return `$${amount.toFixed(2)}`
}

/**
 * Rough token count for estimation only.
 *
 * Never used for billing or for deciding whether something fits in context —
 * for that the API's own counts are authoritative. Roughly four characters per
 * token holds well enough for English prose to size an estimate.
 */
export function approximateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}
