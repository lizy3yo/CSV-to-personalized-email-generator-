import type { GuardrailKey } from './prompt'
import type { ModelId } from './models'

export interface SlotConfig {
  /** Matches the `{{ai:name}}` in the template. */
  name: string
  /** What the model should write. Free text from the user. */
  brief: string
  maxSentences?: number
}

export interface AiConfig {
  enabled: boolean
  model?: ModelId | string
  tone?: string
  slots?: Record<string, { brief: string; maxSentences?: number }>
  guardrails?: GuardrailKey[]
}

/** Why a generated passage was flagged for a human to look at. */
export type ViolationKind =
  | 'empty'
  | 'too_long'
  | 'too_many_sentences'
  | 'contains_greeting'
  | 'contains_signoff'
  | 'contains_template_syntax'
  | 'em_dash'
  | 'exclamation'
  | 'question'
  | 'superlative'
  | 'possible_hallucination'

export interface Violation {
  kind: ViolationKind
  message: string
  /** `error` blocks approval; `warning` marks the row for review. */
  severity: 'error' | 'warning'
}

export interface GeneratedSlot {
  slot: string
  /** After cleaning. This is what gets inserted. */
  text: string
  /** Exactly what the model returned, kept for the review screen. */
  raw: string
  violations: Violation[]
}
