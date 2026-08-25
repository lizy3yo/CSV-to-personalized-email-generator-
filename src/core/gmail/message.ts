/**
 * RFC 2822 message assembly.
 *
 * Gmail's `users.messages.send` takes a complete raw message, base64url
 * encoded — so this module is where a mistake becomes a malformed or
 * dangerous email rather than an API error.
 *
 * Two things it is strict about:
 *
 *  1. **Header injection.** A CR or LF in any header value ends that header
 *     and starts a new one. A contact called `Ana\nBcc: everyone@corp.com`
 *     would silently add a recipient. Every value is stripped, without
 *     exception and without a way to opt out.
 *
 *  2. **multipart/alternative always.** Every message carries both a plain
 *     text and an HTML part. A send that is HTML-only reads as bulk mail to
 *     both spam filters and people.
 */

const CRLF = '\r\n'

/** Remove anything that could terminate a header line. */
export function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim()
}

function isAscii(value: string): boolean {
  return !/[^\u0000-\u007F]/.test(value)
}

/**
 * RFC 2047 encoded-word, for header values containing non-ASCII.
 *
 * Without this a subject like "Café" arrives as mojibake in clients that do
 * not guess the charset.
 */
export function encodeHeaderValue(value: string): string {
  const clean = sanitizeHeaderValue(value)
  if (isAscii(clean)) return clean
  return `=?UTF-8?B?${Buffer.from(clean, 'utf8').toString('base64')}?=`
}

/** `Name <addr>` with the display name encoded and quoted if needed. */
export function formatAddress(email: string, name?: string): string {
  const address = sanitizeHeaderValue(email)
  if (!name?.trim()) return address

  const clean = sanitizeHeaderValue(name)
  if (!isAscii(clean)) return `${encodeHeaderValue(clean)} <${address}>`
  // Quote when the display name contains characters that are special in a
  // header, so `Reyes, Sam` does not read as two addresses.
  const needsQuoting = /[(),.:;<>@[\]\\"]/.test(clean)
  return needsQuoting
    ? `"${clean.replace(/(["\\])/g, '\\$1')}" <${address}>`
    : `${clean} <${address}>`
}

/** RFC 2822 date: `Tue, 25 Aug 2026 18:00:00 +0000`. */
export function formatDate(date: Date): string {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ]
  const pad = (n: number) => String(n).padStart(2, '0')

  return (
    `${days[date.getUTCDay()]}, ${date.getUTCDate()} ${months[date.getUTCMonth()]} ` +
    `${date.getUTCFullYear()} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:` +
    // `+0000`, not `GMT` — RFC 2822 wants a numeric offset.
    `${pad(date.getUTCSeconds())} +0000`
  )
}

/** Base64, wrapped at 76 characters as the MIME spec requires. */
function base64Body(text: string): string {
  const encoded = Buffer.from(text, 'utf8').toString('base64')
  return (encoded.match(/.{1,76}/g) ?? []).join(CRLF)
}

export interface BuildMessageInput {
  fromEmail: string
  fromName?: string
  to: string
  subject: string
  text: string
  html: string
  /** Defaults to `fromEmail`. */
  replyTo?: string
  /**
   * Stable per recipient. Derived from the idempotency key so a resend
   * attempt carries the same Message-ID, which lets a mail server recognise
   * the duplicate even though Gmail's API has no idempotency parameter.
   */
  messageId: string
  date?: Date
  /** Threading a follow-up onto an earlier message. */
  inReplyTo?: string
  references?: string[]
  /**
   * One-click unsubscribe. Gmail honours these natively, so a 1:1 email can
   * be unsubscribable without carrying a newsletter footer.
   */
  listUnsubscribe?: { mailto?: string; url?: string }
}

/** A boundary that cannot collide with the content it separates. */
function boundaryFor(messageId: string): string {
  return `----=_Part_${Buffer.from(messageId).toString('hex').slice(0, 24)}`
}

export function buildRawMessage(input: BuildMessageInput): string {
  const boundary = boundaryFor(input.messageId)
  const date = input.date ?? new Date()

  const headers: [string, string][] = [
    ['From', formatAddress(input.fromEmail, input.fromName)],
    ['To', sanitizeHeaderValue(input.to)],
    ['Reply-To', sanitizeHeaderValue(input.replyTo ?? input.fromEmail)],
    ['Subject', encodeHeaderValue(input.subject)],
    ['Date', formatDate(date)],
    ['Message-ID', `<${sanitizeHeaderValue(input.messageId)}>`],
    ['MIME-Version', '1.0'],
  ]

  if (input.inReplyTo) {
    headers.push(['In-Reply-To', `<${sanitizeHeaderValue(input.inReplyTo)}>`])
  }
  if (input.references?.length) {
    headers.push([
      'References',
      input.references.map((r) => `<${sanitizeHeaderValue(r)}>`).join(' '),
    ])
  }

  if (input.listUnsubscribe) {
    const targets: string[] = []
    if (input.listUnsubscribe.mailto) {
      targets.push(`<mailto:${sanitizeHeaderValue(input.listUnsubscribe.mailto)}>`)
    }
    if (input.listUnsubscribe.url) {
      targets.push(`<${sanitizeHeaderValue(input.listUnsubscribe.url)}>`)
    }
    if (targets.length > 0) {
      headers.push(['List-Unsubscribe', targets.join(', ')])
      // Without the Post header the URL is only a link; with it, Gmail shows
      // a native one-click unsubscribe control.
      if (input.listUnsubscribe.url) {
        headers.push(['List-Unsubscribe-Post', 'List-Unsubscribe=One-Click'])
      }
    }
  }

  headers.push(['Content-Type', `multipart/alternative; boundary="${boundary}"`])

  const lines: string[] = headers.map(([name, value]) => `${name}: ${value}`)
  lines.push('')

  // Plain text first: a client that understands only one part should get the
  // readable one, and the last part listed is the preferred one.
  lines.push(`--${boundary}`)
  lines.push('Content-Type: text/plain; charset="UTF-8"')
  lines.push('Content-Transfer-Encoding: base64')
  lines.push('')
  lines.push(base64Body(input.text))
  lines.push('')

  lines.push(`--${boundary}`)
  lines.push('Content-Type: text/html; charset="UTF-8"')
  lines.push('Content-Transfer-Encoding: base64')
  lines.push('')
  lines.push(base64Body(input.html))
  lines.push('')

  lines.push(`--${boundary}--`)

  return lines.join(CRLF)
}

/** Gmail's `raw` field wants base64url. */
export function toBase64Url(raw: string): string {
  return Buffer.from(raw, 'utf8').toString('base64url')
}

/**
 * A deterministic RFC 2822 Message-ID for a recipient.
 *
 * Derived from the idempotency key, so a retry produces the identical id
 * rather than a second distinct message.
 */
export function messageIdFor(idempotencyKey: string, domain: string): string {
  const safeDomain = sanitizeHeaderValue(domain).replace(/[^a-zA-Z0-9.-]/g, '') || 'localhost'
  return `${idempotencyKey}@${safeDomain}`
}
