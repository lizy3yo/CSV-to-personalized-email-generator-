import type { GuardrailKey } from './prompt'
import type { GeneratedSlot, SlotConfig, Violation } from './types'

/**
 * What comes back from the model is not trusted.
 *
 * Two stages, and the order matters:
 *
 *   clean()    removes the things models reliably add despite being told not
 *              to — wrapping quotes, a greeting, a sign-off. Deterministic
 *              tidying, not censorship.
 *
 *   validate() reports what is still wrong. It never rewrites; it flags, and
 *              the review screen in phase 5 is where a human decides.
 *
 * Nothing here can make a bad passage good. It exists so a bad one is visible
 * before it is sent, which is the only guarantee worth making.
 */

const SMART_QUOTES = /^["'“”‘’]+|["'“”‘’]+$/g

/** `Hi Ana,` / `Hello there —` / `Hey Bo:` at the very start. */
const LEADING_GREETING = /^\s*(hi|hello|hey|dear|greetings)\b[^\n,:—-]{0,40}[,:—-]?\s*/i

/** `Best,` / `Regards,` / `— Sam` / `Thanks,` trailing a passage. */
const TRAILING_SIGNOFF =
  /\n+\s*(best( regards| wishes)?|regards|kind regards|thanks( again)?|cheers|sincerely|warmly|all the best)\s*[,.]?\s*(\n.*)?$/i
const TRAILING_DASH_NAME = /\n+\s*[—–-]\s*[A-Z][a-zA-Z.'-]{1,30}\s*$/

const SUPERLATIVES =
  /\b(revolutionary|game[- ]?chang(ing|er)|cutting[- ]edge|best[- ]in[- ]class|world[- ]class|unlock(ing)?|leverage|synerg(y|ies|istic)|paradigm|disrupt(ive|ing)?|supercharge|turbocharge|seamlessly)\b/i

/** Capitalised words that are ordinary English, not a claim about the recipient. */
const COMMON_CAPITALS = new Set([
  'I',
  "I'm",
  "I've",
  "I'd",
  "I'll",
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
  'AI',
  'CEO',
  'CTO',
  'COO',
  'VP',
  'HR',
  'IT',
  'API',
  'SaaS',
  'B2B',
  'SSO',
  'SCIM',
])

export const MAX_SLOT_CHARS = 1200

/** Strip the artefacts models add despite instructions. */
export function clean(raw: string): string {
  let text = raw.trim()

  // Models often wrap a requested passage in quotes.
  text = text.replace(SMART_QUOTES, '').trim()

  // A greeting here would duplicate the one already in the template.
  text = text.replace(LEADING_GREETING, '').trim()

  text = text.replace(TRAILING_SIGNOFF, '').trim()
  text = text.replace(TRAILING_DASH_NAME, '').trim()

  // Collapse runs of blank lines; a slot is a passage, not a document.
  text = text
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  return text
}

/** Sentence count. Abbreviations make this approximate, which is fine for a cap. */
export function countSentences(text: string): number {
  const trimmed = text.trim()
  if (!trimmed) return 0
  const matches = trimmed.match(/[^.!?]+[.!?]+(\s|$)/g)
  // Text with no terminator at all is still one sentence.
  if (!matches) return 1
  const consumed = matches.join('').length
  return matches.length + (consumed < trimmed.length ? 1 : 0)
}

/**
 * Proper nouns in the passage that do not appear anywhere in the row's data.
 *
 * A weak signal deliberately reported as a warning, never an error: it has
 * false positives (an unusual sentence opener, a capitalised common noun).
 * But an invented company name or mutual contact is the single worst thing
 * this app could send, so a noisy check that surfaces it is worth the noise.
 */
export function suspectProperNouns(text: string, data: Record<string, string>): string[] {
  const haystack = Object.values(data).join(' ').toLowerCase()
  const suspects: string[] = []

  for (const sentence of text.split(/(?<=[.!?])\s+/)) {
    const words = sentence.trim().split(/\s+/)
    words.forEach((word, index) => {
      // Skip the first word of each sentence — capitalised by grammar, not by claim.
      if (index === 0) return
      // Trailing punctuation must go, including the full stop — otherwise
      // `Monday.` never matches `Monday` and every sentence-final proper noun
      // is reported as invented.
      const bare = word.replace(/^[^A-Za-z]+/, '').replace(/[^A-Za-z0-9'’]+$/, '')
      if (bare.length < 2) return
      if (!/^[A-Z]/.test(bare)) return
      if (COMMON_CAPITALS.has(bare)) return
      if (haystack.includes(bare.toLowerCase())) return
      if (!suspects.includes(bare)) suspects.push(bare)
    })
  }

  return suspects
}

export interface ValidateInput {
  text: string
  slot: SlotConfig
  guardrails?: GuardrailKey[]
  /** The row's fields, for the hallucination check. */
  data?: Record<string, string>
}

export function validate({ text, slot, guardrails = [], data = {} }: ValidateInput): Violation[] {
  const violations: Violation[] = []
  const enabled = new Set(guardrails)

  if (!text.trim()) {
    // Nothing to send, and nothing to review. Always an error.
    return [{ kind: 'empty', message: 'The model returned nothing', severity: 'error' }]
  }

  if (text.length > MAX_SLOT_CHARS) {
    violations.push({
      kind: 'too_long',
      message: `${text.length} characters — a slot should be a passage, not an essay`,
      severity: 'error',
    })
  }

  if (slot.maxSentences && slot.maxSentences > 0) {
    const count = countSentences(text)
    if (count > slot.maxSentences) {
      violations.push({
        kind: 'too_many_sentences',
        message: `${count} sentences, limit is ${slot.maxSentences}`,
        severity: 'warning',
      })
    }
  }

  if (LEADING_GREETING.test(text)) {
    violations.push({
      kind: 'contains_greeting',
      message: 'Starts with a greeting — the template already has one',
      severity: 'warning',
    })
  }

  if (TRAILING_SIGNOFF.test(text) || TRAILING_DASH_NAME.test(text)) {
    violations.push({
      kind: 'contains_signoff',
      message: 'Ends with a sign-off — the template already has one',
      severity: 'warning',
    })
  }

  if (/\{\{|\}\}/.test(text)) {
    violations.push({
      kind: 'contains_template_syntax',
      message: 'Contains template syntax, which would be sent literally',
      severity: 'error',
    })
  }

  if (enabled.has('no_em_dash') && /[—–]/.test(text)) {
    violations.push({ kind: 'em_dash', message: 'Contains an em-dash', severity: 'warning' })
  }

  if (enabled.has('no_exclamation') && text.includes('!')) {
    violations.push({
      kind: 'exclamation',
      message: 'Contains an exclamation mark',
      severity: 'warning',
    })
  }

  if (enabled.has('no_questions') && text.includes('?')) {
    violations.push({ kind: 'question', message: 'Contains a question', severity: 'warning' })
  }

  if (enabled.has('no_superlatives')) {
    const match = SUPERLATIVES.exec(text)
    if (match) {
      violations.push({
        kind: 'superlative',
        message: `Contains "${match[0]}"`,
        severity: 'warning',
      })
    }
  }

  const suspects = suspectProperNouns(text, data)
  if (suspects.length > 0) {
    violations.push({
      kind: 'possible_hallucination',
      message: `Mentions ${suspects.map((s) => `"${s}"`).join(', ')}, which is not in this contact's data`,
      severity: 'warning',
    })
  }

  return violations
}

/** Clean then validate. What callers should use. */
export function process(
  raw: string,
  slot: SlotConfig,
  guardrails: GuardrailKey[] = [],
  data: Record<string, string> = {},
): GeneratedSlot {
  const text = clean(raw)
  return { slot: slot.name, text, raw, violations: validate({ text, slot, guardrails, data }) }
}

export function hasBlockingViolation(violations: Violation[]): boolean {
  return violations.some((v) => v.severity === 'error')
}
