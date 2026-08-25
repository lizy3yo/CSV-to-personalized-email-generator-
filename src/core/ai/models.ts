/**
 * Model catalog.
 *
 * Prices are USD per million tokens, from Anthropic's published rates. They
 * are used for the cost estimate shown before generation AND for the running
 * total, which is computed from the `usage` block of each real response — the
 * meter is never a guess about how many tokens were used, only about what a
 * token costs.
 *
 * If a rate changes, this table is the single place to fix it.
 */

export type ModelId = 'claude-haiku-4-5' | 'claude-sonnet-5' | 'claude-opus-5'

export interface ModelInfo {
  id: ModelId
  label: string
  /** USD per million input tokens. */
  inputPerMTok: number
  /** USD per million output tokens. */
  outputPerMTok: number
  contextWindow: number
  /**
   * `effort` and adaptive thinking are not accepted by every model — sending
   * them to one that does not support them is a 400, and this app lets the
   * user pick the model, so the request has to adapt.
   */
  supportsEffort: boolean
  blurb: string
}

/**
 * Claude Sonnet 5 has introductory pricing of $2/$10 through 2026-08-31,
 * after which it moves to $3/$15. The table carries the standard rate so
 * estimates are never optimistic; during the intro window the real bill comes
 * in under what is shown here.
 */
export const MODELS: Record<ModelId, ModelInfo> = {
  'claude-haiku-4-5': {
    id: 'claude-haiku-4-5',
    label: 'Claude Haiku 4.5',
    inputPerMTok: 1,
    outputPerMTok: 5,
    contextWindow: 200_000,
    supportsEffort: false,
    blurb: 'Fastest and cheapest. Ample for filling a short, well-briefed slot.',
  },
  'claude-sonnet-5': {
    id: 'claude-sonnet-5',
    label: 'Claude Sonnet 5',
    inputPerMTok: 3,
    outputPerMTok: 15,
    contextWindow: 1_000_000,
    supportsEffort: true,
    blurb: 'Better at drawing a specific detail out of messy notes.',
  },
  'claude-opus-5': {
    id: 'claude-opus-5',
    label: 'Claude Opus 5',
    inputPerMTok: 5,
    outputPerMTok: 25,
    contextWindow: 1_000_000,
    supportsEffort: true,
    blurb: 'Most capable. Worth it when the personalisation carries the email.',
  },
}

export const MODEL_IDS = Object.keys(MODELS) as ModelId[]

export const DEFAULT_MODEL: ModelId = 'claude-haiku-4-5'

export function isModelId(value: string): value is ModelId {
  return value in MODELS
}

export function modelInfo(id: string): ModelInfo {
  return isModelId(id) ? MODELS[id] : MODELS[DEFAULT_MODEL]
}

/** Cache writes cost more than ordinary input; cache reads cost far less. */
export const CACHE_WRITE_MULTIPLIER = 1.25
export const CACHE_READ_MULTIPLIER = 0.1

/** The Batch API halves everything. Used from phase 4. */
export const BATCH_MULTIPLIER = 0.5

/**
 * Prompt caching does not engage below roughly this many tokens — shorter
 * prefixes are silently not cached. Worth surfacing, because a user who wrote
 * a two-line brief and expected a 90% discount would otherwise just see a
 * bigger bill than the estimate implied.
 */
export const MIN_CACHEABLE_TOKENS = 1024
