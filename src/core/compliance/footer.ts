/**
 * Compliance footers.
 *
 * Two profiles, because one shape does not fit both jobs:
 *
 *   one_to_one  A personal email. It gets a human sentence — "tell me to stop
 *               and I will" — and the machine-readable opt-out rides in the
 *               List-Unsubscribe headers, invisible to the reader. A
 *               newsletter footer on a personal note is self-defeating: it
 *               announces that the message was produced in bulk.
 *
 *   bulk        A marketing email. It gets the full CAN-SPAM treatment: a
 *               visible unsubscribe link, a reason the person is receiving it,
 *               and the postal address set out plainly.
 *
 * Both carry a physical postal address, and both set List-Unsubscribe. The
 * address is not optional for either — CAN-SPAM applies to any commercial
 * email, and 1:1 sales outreach is commercial.
 */

export type ComplianceProfile = 'one_to_one' | 'bulk'

export const DEFAULT_OPT_OUT_LINE =
  'If you would rather I did not follow up, just reply and say so.'

export interface FooterInput {
  profile: ComplianceProfile
  /** Signed, per-recipient. Absent only when previewing. */
  unsubscribeUrl?: string
  postalAddress?: string | null
  /** Overrides DEFAULT_OPT_OUT_LINE for the 1:1 profile. */
  optOutLine?: string | null
  /** Where the list came from, e.g. "you signed up on our website". */
  consentSource?: string | null
}

/** Collapse a multi-line address onto one line, for a discreet footer. */
export function oneLineAddress(address: string): string {
  return address
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(', ')
}

/**
 * The text appended to the body at SEND time, not at generation.
 *
 * Deliberately late: the unsubscribe token is per-recipient, and a postal
 * address changed after generation must apply to everything still unsent.
 */
export function buildFooterText(input: FooterInput): string {
  const address = input.postalAddress?.trim()

  if (input.profile === 'one_to_one') {
    const lines: string[] = []
    const optOut = (input.optOutLine?.trim() || DEFAULT_OPT_OUT_LINE).trim()
    lines.push(optOut)
    // One line, small print. Present because the law requires it, not because
    // it belongs in a personal email.
    if (address) lines.push(oneLineAddress(address))
    return lines.join('\n\n')
  }

  const lines: string[] = ['—']
  lines.push(
    input.consentSource?.trim()
      ? `You are receiving this because ${input.consentSource.trim()}.`
      : 'You are receiving this because you are on our contact list.',
  )
  if (input.unsubscribeUrl) {
    lines.push(`Unsubscribe: ${input.unsubscribeUrl}`)
  }
  if (address) {
    lines.push('')
    lines.push(address.trim())
  }
  return lines.join('\n')
}

/** Append the footer to a rendered body, separated by a blank line. */
export function appendFooter(bodyText: string, input: FooterInput): string {
  const footer = buildFooterText(input)
  if (!footer.trim()) return bodyText.trim()
  return `${bodyText.trim()}\n\n${footer}`
}

export interface ComplianceIssue {
  code: 'no_postal_address' | 'no_unsubscribe_url' | 'no_opt_out_line' | 'bulk_needs_link'
  message: string
  /** Blocking issues stop a send. There is no override. */
  blocking: boolean
}

/**
 * What is wrong with this send, from a compliance standpoint.
 *
 * Everything returned as `blocking: true` is a legal requirement rather than
 * a recommendation, which is why the send button honours it with no override.
 */
export function checkCompliance(input: FooterInput): ComplianceIssue[] {
  const issues: ComplianceIssue[] = []

  if (!input.postalAddress?.trim()) {
    issues.push({
      code: 'no_postal_address',
      message:
        'CAN-SPAM requires a valid physical postal address in every commercial email, including 1:1 outreach. Add one in Settings → Compliance.',
      blocking: true,
    })
  }

  if (!input.unsubscribeUrl) {
    issues.push({
      code: 'no_unsubscribe_url',
      message:
        'No unsubscribe URL could be built. Check NEXT_PUBLIC_SITE_URL and UNSUBSCRIBE_SECRET.',
      blocking: true,
    })
  }

  if (input.profile === 'one_to_one' && !(input.optOutLine?.trim() || DEFAULT_OPT_OUT_LINE)) {
    issues.push({
      code: 'no_opt_out_line',
      message: 'The 1:1 profile needs an opt-out sentence.',
      blocking: true,
    })
  }

  return issues
}

/** The List-Unsubscribe headers for a message. */
export function unsubscribeHeaders(
  unsubscribeUrl: string | undefined,
  mailto?: string,
): { url?: string; mailto?: string } | undefined {
  if (!unsubscribeUrl && !mailto) return undefined
  return { url: unsubscribeUrl, mailto }
}
