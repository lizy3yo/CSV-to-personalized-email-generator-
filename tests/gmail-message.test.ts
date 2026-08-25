import { describe, expect, it } from 'vitest'
import {
  buildRawMessage,
  encodeHeaderValue,
  formatAddress,
  formatDate,
  messageIdFor,
  sanitizeHeaderValue,
  toBase64Url,
} from '@/core/gmail/message'

const BASE = {
  fromEmail: 'sam@acme.com',
  fromName: 'Sam Reyes',
  to: 'ana@northwind.io',
  subject: 'Quick question',
  text: 'Hi Ana,\n\nWorth a chat?\n\n— Sam',
  html: '<p>Hi Ana,</p>\n<p>Worth a chat?</p>',
  messageId: 'abc123@acme.com',
  date: new Date(Date.UTC(2026, 7, 25, 18, 0, 0)),
}

function headersOf(raw: string): Record<string, string> {
  const [head] = raw.split('\r\n\r\n')
  const out: Record<string, string> = {}
  for (const line of head.split('\r\n')) {
    const idx = line.indexOf(': ')
    if (idx > 0) out[line.slice(0, idx)] = line.slice(idx + 2)
  }
  return out
}

describe('sanitizeHeaderValue — header injection', () => {
  it('strips a newline that would start a new header', () => {
    // A contact named this way would otherwise silently add a recipient.
    expect(sanitizeHeaderValue('Ana\nBcc: everyone@corp.com')).toBe('Ana Bcc: everyone@corp.com')
  })

  it('strips carriage returns and CRLF pairs', () => {
    expect(sanitizeHeaderValue('a\r\nb')).toBe('a b')
    expect(sanitizeHeaderValue('a\rb')).toBe('a b')
  })

  it('trims', () => {
    expect(sanitizeHeaderValue('  Ana  ')).toBe('Ana')
  })
})

describe('encodeHeaderValue', () => {
  it('leaves ASCII alone', () => {
    expect(encodeHeaderValue('Quick question')).toBe('Quick question')
  })

  it('RFC 2047 encodes non-ASCII', () => {
    const encoded = encodeHeaderValue('Café résumé')
    expect(encoded.startsWith('=?UTF-8?B?')).toBe(true)
    expect(encoded.endsWith('?=')).toBe(true)
    const payload = encoded.slice('=?UTF-8?B?'.length, -2)
    expect(Buffer.from(payload, 'base64').toString('utf8')).toBe('Café résumé')
  })

  it('sanitises before encoding', () => {
    expect(encodeHeaderValue('a\nb')).toBe('a b')
  })
})

describe('formatAddress', () => {
  it('formats a plain address', () => {
    expect(formatAddress('ana@x.com')).toBe('ana@x.com')
  })

  it('formats a display name', () => {
    expect(formatAddress('sam@acme.com', 'Sam Reyes')).toBe('Sam Reyes <sam@acme.com>')
  })

  it('quotes a name containing header-special characters', () => {
    // Unquoted, `Reyes, Sam` would parse as two addresses.
    expect(formatAddress('sam@acme.com', 'Reyes, Sam')).toBe('"Reyes, Sam" <sam@acme.com>')
  })

  it('escapes quotes inside a quoted name', () => {
    expect(formatAddress('x@y.com', 'Sam "Sammy" Reyes')).toContain('\\"Sammy\\"')
  })

  it('encodes a non-ASCII name', () => {
    expect(formatAddress('rene@x.com', 'René Dupont')).toContain('=?UTF-8?B?')
  })

  it('strips injection from both parts', () => {
    const formatted = formatAddress('x@y.com\nBcc: a@b.com', 'Ana\nBcc: c@d.com')
    expect(formatted).not.toContain('\n')
    expect(formatted).not.toContain('\r')
  })
})

describe('formatDate', () => {
  it('uses a numeric offset, not GMT', () => {
    // `toUTCString()` produces "GMT", which RFC 2822 does not want.
    expect(formatDate(new Date(Date.UTC(2026, 7, 25, 18, 5, 9)))).toBe(
      'Tue, 25 Aug 2026 18:05:09 +0000',
    )
  })

  it('zero-pads time components', () => {
    expect(formatDate(new Date(Date.UTC(2026, 0, 5, 3, 4, 5)))).toBe(
      'Mon, 5 Jan 2026 03:04:05 +0000',
    )
  })
})

describe('buildRawMessage', () => {
  const raw = buildRawMessage(BASE)
  const headers = headersOf(raw)

  it('uses CRLF line endings throughout', () => {
    expect(raw).toContain('\r\n')
    // A bare LF anywhere would break strict parsers.
    expect(/[^\r]\n/.test(raw)).toBe(false)
  })

  it('sets the required headers', () => {
    expect(headers.From).toBe('Sam Reyes <sam@acme.com>')
    expect(headers.To).toBe('ana@northwind.io')
    expect(headers.Subject).toBe('Quick question')
    expect(headers['MIME-Version']).toBe('1.0')
    expect(headers['Message-ID']).toBe('<abc123@acme.com>')
    expect(headers.Date).toBe('Tue, 25 Aug 2026 18:00:00 +0000')
  })

  it('defaults Reply-To to the sender', () => {
    expect(headers['Reply-To']).toBe('sam@acme.com')
  })

  it('honours an explicit Reply-To', () => {
    expect(headersOf(buildRawMessage({ ...BASE, replyTo: 'inbox@acme.com' }))['Reply-To']).toBe(
      'inbox@acme.com',
    )
  })

  it('is always multipart/alternative with both parts', () => {
    // HTML-only reads as bulk mail to filters and to people.
    expect(headers['Content-Type']).toMatch(/^multipart\/alternative; boundary="/)
    expect(raw).toContain('Content-Type: text/plain; charset="UTF-8"')
    expect(raw).toContain('Content-Type: text/html; charset="UTF-8"')
  })

  it('puts plain text before HTML', () => {
    // The last part is the preferred one, so HTML must come second.
    expect(raw.indexOf('text/plain')).toBeLessThan(raw.indexOf('text/html'))
  })

  it('base64-encodes both bodies, recoverably', () => {
    const boundary = headers['Content-Type'].match(/boundary="([^"]+)"/)![1]
    const parts = raw.split(`--${boundary}`).slice(1, 3)
    const decoded = parts.map((part) => {
      const body = part.split('\r\n\r\n').slice(1).join('\r\n\r\n').replace(/--$/, '').trim()
      return Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8')
    })
    expect(decoded[0]).toBe(BASE.text)
    expect(decoded[1]).toBe(BASE.html)
  })

  it('closes the multipart block', () => {
    const boundary = headers['Content-Type'].match(/boundary="([^"]+)"/)![1]
    expect(raw.trimEnd().endsWith(`--${boundary}--`)).toBe(true)
  })

  it('survives a subject and body full of injection attempts', () => {
    const hostile = buildRawMessage({
      ...BASE,
      subject: 'Hi\r\nBcc: everyone@corp.com',
      to: 'ana@x.com\r\nBcc: sneaky@x.com',
    })
    const h = headersOf(hostile)
    expect(h.Subject).not.toContain('Bcc:\r')
    expect(h.To).toBe('ana@x.com Bcc: sneaky@x.com')
    expect(Object.keys(h)).not.toContain('Bcc')
  })

  it('encodes a non-ASCII subject', () => {
    expect(headersOf(buildRawMessage({ ...BASE, subject: 'Café' })).Subject).toContain('=?UTF-8?B?')
  })

  it('omits threading headers when not threading', () => {
    expect(headers['In-Reply-To']).toBeUndefined()
    expect(headers.References).toBeUndefined()
  })

  it('adds threading headers for a follow-up', () => {
    const h = headersOf(
      buildRawMessage({ ...BASE, inReplyTo: 'first@acme.com', references: ['first@acme.com'] }),
    )
    expect(h['In-Reply-To']).toBe('<first@acme.com>')
    expect(h.References).toBe('<first@acme.com>')
  })

  it('omits List-Unsubscribe unless asked for', () => {
    expect(headers['List-Unsubscribe']).toBeUndefined()
  })

  it('adds one-click unsubscribe headers together', () => {
    // The URL alone is just a link; the Post header is what makes Gmail show
    // its native unsubscribe control.
    const h = headersOf(
      buildRawMessage({
        ...BASE,
        listUnsubscribe: { url: 'https://app.test/u/tok', mailto: 'unsub@acme.com' },
      }),
    )
    expect(h['List-Unsubscribe']).toBe('<mailto:unsub@acme.com>, <https://app.test/u/tok>')
    expect(h['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click')
  })

  it('omits the Post header when only a mailto is given', () => {
    const h = headersOf(buildRawMessage({ ...BASE, listUnsubscribe: { mailto: 'unsub@acme.com' } }))
    expect(h['List-Unsubscribe']).toBe('<mailto:unsub@acme.com>')
    expect(h['List-Unsubscribe-Post']).toBeUndefined()
  })

  it('gives different messages different boundaries', () => {
    const other = buildRawMessage({ ...BASE, messageId: 'zzz@acme.com' })
    expect(headers['Content-Type']).not.toBe(headersOf(other)['Content-Type'])
  })
})

describe('toBase64Url', () => {
  it('produces URL-safe base64 with no padding', () => {
    const encoded = toBase64Url(buildRawMessage(BASE))
    expect(encoded).not.toContain('+')
    expect(encoded).not.toContain('/')
    expect(encoded).not.toContain('=')
  })

  it('round-trips', () => {
    const raw = buildRawMessage(BASE)
    expect(Buffer.from(toBase64Url(raw), 'base64url').toString('utf8')).toBe(raw)
  })
})

describe('messageIdFor', () => {
  it('is deterministic, so a retry reuses the same id', () => {
    // Gmail's API has no idempotency parameter; a stable Message-ID is the
    // only signal a receiving server gets that a resend is a duplicate.
    expect(messageIdFor('key1', 'acme.com')).toBe(messageIdFor('key1', 'acme.com'))
    expect(messageIdFor('key1', 'acme.com')).not.toBe(messageIdFor('key2', 'acme.com'))
  })

  it('strips characters that are illegal in a domain', () => {
    expect(messageIdFor('k', 'ac me.com\n')).toBe('k@acme.com')
  })

  it('falls back when the domain is unusable', () => {
    expect(messageIdFor('k', '!!!')).toBe('k@localhost')
  })
})
