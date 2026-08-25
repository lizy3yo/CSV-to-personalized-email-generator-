/**
 * Review flags.
 *
 * Flags are stored as plain strings on `campaign_recipients.flags` so the
 * shape can grow without a migration. This module is the single place that
 * knows how to read them, and it draws the one distinction that matters:
 *
 *   error   — the email is broken. Approval is blocked. No human judgement
 *             can make an empty body sendable.
 *   warning — the email is odd. A human looks at it and decides. Most flags
 *             are warnings, because most "problems" are contextual.
 *
 * Getting that split wrong in either direction is costly: too many errors and
 * the reviewer cannot work; too few and something genuinely broken slips past.
 */

export type FlagSeverity = 'error' | 'warning'

export interface ParsedFlag {
  raw: string
  severity: FlagSeverity
  /** Short human label for a badge. */
  label: string
  /** Why it matters, for a tooltip or the detail row. */
  detail: string
}

const KIND_LABELS: Record<string, { label: string; detail: string }> = {
  empty: {
    label: 'AI returned nothing',
    detail: 'The model produced no text for this slot',
  },
  too_long: {
    label: 'Too long',
    detail: 'The generated passage is longer than a slot should be',
  },
  too_many_sentences: {
    label: 'Over sentence limit',
    detail: 'More sentences than the slot allows',
  },
  contains_greeting: {
    label: 'Duplicate greeting',
    detail: 'The generated text opens with a greeting the template already has',
  },
  contains_signoff: {
    label: 'Duplicate sign-off',
    detail: 'The generated text ends with a sign-off the template already has',
  },
  contains_template_syntax: {
    label: 'Template syntax',
    detail: 'Contains {{ }} which would be sent to the recipient literally',
  },
  em_dash: { label: 'Em-dash', detail: 'Contains an em-dash, which you asked to avoid' },
  exclamation: { label: 'Exclamation', detail: 'Contains an exclamation mark' },
  question: { label: 'Question', detail: 'Contains a question' },
  superlative: { label: 'Hype word', detail: 'Contains a marketing superlative' },
  possible_hallucination: {
    label: 'Possible invention',
    detail: 'Mentions something that does not appear in this contact’s data',
  },
  empty_subject: { label: 'No subject', detail: 'The subject line rendered empty' },
  empty_body: { label: 'No body', detail: 'The body rendered empty' },
}

export function parseFlag(raw: string): ParsedFlag {
  const separator = raw.indexOf(':')
  const prefix = separator === -1 ? raw : raw.slice(0, separator)
  const rest = separator === -1 ? '' : raw.slice(separator + 1)

  if (prefix === 'unresolved') {
    return {
      raw,
      severity: 'warning',
      label: `{{${rest}}} empty`,
      // The classic merge-template embarrassment, and the reason the review
      // screen exists at all.
      detail: `This contact has no value for ${rest}, so it renders as nothing`,
    }
  }

  if (prefix === 'unfilled_slot') {
    return {
      raw,
      severity: 'warning',
      label: `AI slot ${rest} empty`,
      detail: `The {{ai:${rest}}} slot was never filled`,
    }
  }

  if (prefix === 'error' || prefix === 'warning') {
    const known = KIND_LABELS[rest]
    return {
      raw,
      severity: prefix,
      label: known?.label ?? rest.replace(/_/g, ' '),
      detail: known?.detail ?? rest.replace(/_/g, ' '),
    }
  }

  // Unrecognised flags are surfaced rather than swallowed — a flag nobody can
  // read is still a signal that something needs looking at.
  return { raw, severity: 'warning', label: raw, detail: raw }
}

export function parseFlags(flags: readonly string[]): ParsedFlag[] {
  return flags.map(parseFlag)
}

export function hasBlockingFlag(flags: readonly string[]): boolean {
  return flags.some((flag) => parseFlag(flag).severity === 'error')
}

export function countBySeverity(flags: readonly string[]): { errors: number; warnings: number } {
  let errors = 0
  let warnings = 0
  for (const flag of flags) {
    if (parseFlag(flag).severity === 'error') errors += 1
    else warnings += 1
  }
  return { errors, warnings }
}

/**
 * Can this row be approved?
 *
 * Warnings never block — that is the whole point of a human review step. An
 * error does, because no amount of judgement makes an empty body sendable.
 */
export function canApprove(status: string, flags: readonly string[]): boolean {
  if (status === 'rejected') return false
  if (!['generated', 'flagged', 'approved'].includes(status)) return false
  return !hasBlockingFlag(flags)
}

/** Statuses the send path is permitted to read. Deliberately a single value. */
export const SENDABLE_STATUSES = ['approved'] as const

export function isSendable(status: string): boolean {
  return (SENDABLE_STATUSES as readonly string[]).includes(status)
}
