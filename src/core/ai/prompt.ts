import type { SlotConfig } from './types'

/**
 * Prompt construction.
 *
 * The split between system and user is the whole cost model:
 *
 *   SYSTEM — the task, the template, the slot brief, the rules. Byte-identical
 *            for every row in a campaign, so it is the cached prefix and bills
 *            at a tenth of the input rate after the first call.
 *
 *   USER   — this recipient's fields, and nothing else. The only part that
 *            varies.
 *
 * Anything row-specific that leaks into the system prompt invalidates the
 * cache for every subsequent row. That is the single most expensive mistake
 * available here, so the system builder deliberately takes no row data.
 */

/** Rules the model must follow regardless of what the user asked for. */
const CORE_RULES = [
  'Write ONLY the passage that belongs in the slot. No greeting, no sign-off, no subject line, no preamble, no quotation marks around it.',
  'Use only facts present in the recipient data below. If a detail is not there, do not mention it. Never invent a job title, a mutual contact, a product they use, or a recent event.',
  'If the recipient data is too thin to say anything specific, write a short neutral sentence that would be true of anyone. A bland sentence is better than an invented one.',
  'Match the surrounding email: same voice, same level of formality. It must read as one continuous message written by one person.',
  'Do not use template syntax such as {{ }} in your output.',
] as const

/** Optional style constraints. Off by default; the user turns them on. */
export const GUARDRAIL_LABELS = {
  no_em_dash: 'No em-dashes',
  no_exclamation: 'No exclamation marks',
  no_questions: 'No questions',
  no_superlatives: 'No hype words (revolutionary, game-changing, cutting-edge)',
  lowercase_start: 'Continue the sentence flow — do not start with a capital greeting',
} as const

export type GuardrailKey = keyof typeof GUARDRAIL_LABELS

const GUARDRAIL_RULES: Record<GuardrailKey, string> = {
  no_em_dash: 'Do not use em-dashes (—). Use commas or full stops.',
  no_exclamation: 'Do not use exclamation marks.',
  no_questions: 'Do not ask a question.',
  no_superlatives:
    'Do not use marketing superlatives such as "revolutionary", "game-changing", "cutting-edge", "best-in-class", or "unlock".',
  lowercase_start:
    "The passage continues an existing paragraph. Do not open with a greeting or the recipient's name.",
}

export interface BuildSystemInput {
  /** The whole body template, so the model can see where its text lands. */
  bodyTemplate: string
  slot: SlotConfig
  /** e.g. "warm but professional". Free text from the user. */
  tone?: string
  guardrails?: GuardrailKey[]
  /** Field names the recipient block will carry, so the model knows what to expect. */
  availableFields: string[]
}

/**
 * Mark the target slot inside the template.
 *
 * Showing the model the surrounding text is what stops the passage reading
 * like it was written in isolation — it can see the sentence before and after.
 */
function markSlot(bodyTemplate: string, slotName: string): string {
  return bodyTemplate.replace(
    new RegExp(`\\{\\{\\s*ai:${slotName}\\s*\\}\\}`, 'g'),
    '>>> WRITE YOUR PASSAGE HERE <<<',
  )
}

export function buildSystemPrompt({
  bodyTemplate,
  slot,
  tone,
  guardrails = [],
  availableFields,
}: BuildSystemInput): string {
  // Widened from the `as const` literal union so per-slot rules can be added.
  const rules: string[] = [...CORE_RULES]

  if (slot.maxSentences && slot.maxSentences > 0) {
    rules.push(`Write at most ${slot.maxSentences} sentence${slot.maxSentences === 1 ? '' : 's'}.`)
  }
  for (const key of guardrails) {
    const rule = GUARDRAIL_RULES[key]
    if (rule) rules.push(rule)
  }

  return [
    'You write a single short passage that will be inserted into an outreach email at a marked position.',
    'The rest of the email is already written. Your passage is the only part that changes per recipient.',
    '',
    '<email_template>',
    markSlot(bodyTemplate, slot.name).trim(),
    '</email_template>',
    '',
    '<your_task>',
    slot.brief.trim() || 'Write one sentence that connects the email to this specific recipient.',
    '</your_task>',
    '',
    tone?.trim() ? `<tone>\n${tone.trim()}\n</tone>\n` : '',
    '<recipient_fields>',
    availableFields.length > 0
      ? `Each recipient carries: ${availableFields.join(', ')}. Some may be empty for a given person.`
      : 'No recipient fields are available. Keep the passage general.',
    '</recipient_fields>',
    '',
    '<rules>',
    ...rules.map((rule) => `- ${rule}`),
    '</rules>',
  ]
    .filter((line) => line !== '')
    .join('\n')
}

/**
 * The per-row half of the prompt.
 *
 * Empty fields are omitted rather than sent as blanks: an explicit
 * `company: ` invites the model to work around a gap it should simply not
 * know about.
 */
export function buildUserPrompt(data: Record<string, string>): string {
  const entries = Object.entries(data)
    .filter(([, value]) => value?.trim())
    .map(([key, value]) => `${key}: ${value.trim()}`)

  if (entries.length === 0) {
    return '<recipient>\n(no details available for this person)\n</recipient>\n\nWrite the passage.'
  }

  return ['<recipient>', ...entries, '</recipient>', '', 'Write the passage.'].join('\n')
}
