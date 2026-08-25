/**
 * Bounce parsing.
 *
 * Gmail has no bounce webhook. A failed delivery comes back as a message in
 * your own inbox from mailer-daemon, so detecting one means reading and
 * interpreting that message — which is why inbox polling is opt-in and needs
 * a scope the app does not otherwise request.
 *
 * Two formats, tried in order:
 *
 *   1. RFC 3464 delivery status notification — a `message/delivery-status`
 *      part with `Final-Recipient`, `Action` and `Status` fields. Structured,
 *      unambiguous, and what most modern servers send.
 *
 *   2. Free text. Older or non-conforming servers just describe the failure,
 *      so the fallback looks for an SMTP code and an address near it.
 *
 * The hard/soft distinction is what matters: a hard bounce means the address
 * will never work and must be suppressed; a soft bounce is temporary and
 * suppressing on one would lose a real contact over a full mailbox.
 */

export type BounceType = 'hard' | 'soft' | 'unknown'

export interface ParsedBounce {
  type: BounceType
  /** The address that failed, normalised to lowercase. */
  recipient: string | null
  /** Enhanced status code, e.g. `5.1.1`. */
  status: string | null
  /** SMTP reply code, e.g. `550`. */
  smtpCode: number | null
  /** The most useful line of explanation found. */
  diagnostic: string | null
}

/** `Final-Recipient: rfc822; ana@northwind.io` */
const FINAL_RECIPIENT = /^final-recipient:\s*(?:rfc822|x-unix)\s*;\s*(.+)$/im
const ORIGINAL_RECIPIENT = /^original-recipient:\s*(?:rfc822)\s*;\s*(.+)$/im
/** `Status: 5.1.1` */
const STATUS_FIELD = /^status:\s*([245])\.(\d{1,3})\.(\d{1,3})\s*$/im
/** `Action: failed` */
const ACTION_FIELD = /^action:\s*(failed|delayed|delivered|relayed|expanded)\s*$/im
const DIAGNOSTIC_FIELD = /^diagnostic-code:\s*(?:smtp\s*;\s*)?(.+)$/im

/** A bare enhanced status code anywhere in free text. */
const LOOSE_STATUS = /\b([245])\.(\d{1,3})\.(\d{1,3})\b/
/** A three-digit SMTP reply code at the start of a quoted server response. */
const LOOSE_SMTP = /\b([45]\d{2})[\s-]/

const EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi

/**
 * Addresses that appear in every bounce and are never the failed recipient.
 * Without this the parser happily reports `mailer-daemon@googlemail.com` as
 * the address to suppress.
 */
const NEVER_THE_RECIPIENT =
  /^(mailer-daemon|postmaster|no-?reply|do-?not-?reply|bounce[sd]?|abuse)@/i

function normalise(address: string): string {
  return address
    .trim()
    .replace(/^[<"']+|[>"';,.]+$/g, '')
    .toLowerCase()
}

function classify(
  statusClass: string | null,
  action: string | null,
  smtp: number | null,
): BounceType {
  if (statusClass === '5') return 'hard'
  if (statusClass === '4') return 'soft'
  if (smtp !== null) {
    if (smtp >= 500) return 'hard'
    if (smtp >= 400) return 'soft'
  }
  // `failed` without a code still means it did not arrive, but not that the
  // address is dead — suppressing on that would lose real contacts.
  if (action === 'failed') return 'unknown'
  if (action === 'delayed') return 'soft'
  return 'unknown'
}

/**
 * Pull the failed address out of free text.
 *
 * Deliberately skips the sender's own address and the daemon's, since both
 * appear in every bounce.
 */
function findRecipientInText(text: string, ownAddress?: string): string | null {
  const own = ownAddress?.toLowerCase()
  const seen = new Set<string>()

  for (const match of text.matchAll(EMAIL)) {
    const candidate = normalise(match[0])
    if (seen.has(candidate)) continue
    seen.add(candidate)

    if (NEVER_THE_RECIPIENT.test(candidate)) continue
    if (own && candidate === own) continue
    return candidate
  }
  return null
}

export interface ParseBounceInput {
  /** The whole bounce message: headers, delivery-status part, and body. */
  raw: string
  /** The account's own address, so it is not mistaken for the failure. */
  ownAddress?: string
}

export function parseBounce({ raw, ownAddress }: ParseBounceInput): ParsedBounce {
  const statusMatch = STATUS_FIELD.exec(raw) ?? LOOSE_STATUS.exec(raw)
  const statusClass = statusMatch?.[1] ?? null
  const status = statusMatch ? `${statusMatch[1]}.${statusMatch[2]}.${statusMatch[3]}` : null

  const actionMatch = ACTION_FIELD.exec(raw)
  const action = actionMatch?.[1]?.toLowerCase() ?? null

  const smtpMatch = LOOSE_SMTP.exec(raw)
  const smtpCode = smtpMatch ? Number(smtpMatch[1]) : null

  // A structured Final-Recipient is authoritative; free text is the fallback.
  const finalMatch = FINAL_RECIPIENT.exec(raw) ?? ORIGINAL_RECIPIENT.exec(raw)
  const recipient = finalMatch ? normalise(finalMatch[1]) : findRecipientInText(raw, ownAddress)

  const diagnosticMatch = DIAGNOSTIC_FIELD.exec(raw)
  const diagnostic = diagnosticMatch
    ? diagnosticMatch[1].trim().slice(0, 500)
    : firstUsefulLine(raw)

  return {
    type: classify(statusClass, action, smtpCode),
    recipient: recipient && !NEVER_THE_RECIPIENT.test(recipient) ? recipient : null,
    status,
    smtpCode,
    diagnostic,
  }
}

/** The most explanatory line in a free-text bounce. */
function firstUsefulLine(raw: string): string | null {
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed.length < 12 || trimmed.length > 300) continue
    if (/^[a-z-]+:\s/i.test(trimmed)) continue // a header
    if (LOOSE_STATUS.test(trimmed) || LOOSE_SMTP.test(trimmed)) return trimmed.slice(0, 500)
  }
  return null
}

/** Is this message a bounce at all? Checked before parsing. */
export function looksLikeBounce(from: string, subject: string): boolean {
  const sender = from.toLowerCase()
  if (/mailer-daemon|postmaster/.test(sender)) return true

  const line = subject.toLowerCase()
  return (
    /delivery status notification|undelivered mail|returned to sender|delivery failure|mail delivery failed|undeliverable/.test(
      line,
    ) && /fail|error|undeliver|returned/.test(line)
  )
}

/**
 * Should this bounce suppress the address?
 *
 * Only a confirmed hard bounce. A soft bounce is a full mailbox or a server
 * having a bad day, and suppressing on one would quietly lose a real contact.
 * An unknown bounce is recorded but never acted on automatically.
 */
export function shouldSuppress(bounce: ParsedBounce): boolean {
  return bounce.type === 'hard' && Boolean(bounce.recipient)
}

/**
 * Spam complaint rate, as a fraction.
 *
 * Gmail and Yahoo's bulk sender rules put the ceiling at 0.3%; sustained
 * breach costs deliverability across the whole account, not just one campaign.
 */
export const COMPLAINT_RATE_LIMIT = 0.003

export function complaintRate(complaints: number, sent: number): number {
  return sent === 0 ? 0 : complaints / sent
}

/** Hard-bounce rate above this suggests a stale or purchased list. */
export const BOUNCE_RATE_WARNING = 0.05

export function bounceRate(bounces: number, sent: number): number {
  return sent === 0 ? 0 : bounces / sent
}
