import { describe, expect, it } from 'vitest'
import {
  bounceRate,
  BOUNCE_RATE_WARNING,
  complaintRate,
  COMPLAINT_RATE_LIMIT,
  looksLikeBounce,
  parseBounce,
  shouldSuppress,
} from '@/core/gmail/bounce'

/** A realistic RFC 3464 report, as Gmail actually returns one. */
const RFC3464_HARD = `From: Mail Delivery Subsystem <mailer-daemon@googlemail.com>
To: sam@acme.com
Subject: Delivery Status Notification (Failure)
Content-Type: multipart/report; report-type=delivery-status; boundary="000"

--000
Content-Type: text/plain; charset=UTF-8

Address not found. Your message wasn't delivered to ana@northwind.io because
the address couldn't be found, or is unable to receive mail.

--000
Content-Type: message/delivery-status

Reporting-MTA: dns; googlemail.com
Final-Recipient: rfc822; ana@northwind.io
Action: failed
Status: 5.1.1
Diagnostic-Code: smtp; 550 5.1.1 The email account that you tried to reach does not exist.

--000--`

const RFC3464_SOFT = `From: Mail Delivery Subsystem <mailer-daemon@googlemail.com>
To: sam@acme.com
Subject: Delivery Status Notification (Delay)
Content-Type: message/delivery-status

Final-Recipient: rfc822; bo@cascade.dev
Action: delayed
Status: 4.2.2
Diagnostic-Code: smtp; 452 4.2.2 The recipient's mailbox is over its storage quota.`

const FREE_TEXT = `From: postmaster@mail.example.com
To: sam@acme.com
Subject: Undeliverable: Quick question

Your message could not be delivered.

   kim@vertex.io
   550 5.1.1 unknown or illegal alias`

describe('looksLikeBounce', () => {
  it('recognises the daemon by sender', () => {
    expect(looksLikeBounce('Mail Delivery Subsystem <mailer-daemon@googlemail.com>', 'x')).toBe(
      true,
    )
    expect(looksLikeBounce('postmaster@example.com', 'anything')).toBe(true)
  })

  it('recognises a bounce by subject when the sender is unhelpful', () => {
    expect(
      looksLikeBounce('noreply@mail.example.com', 'Delivery Status Notification (Failure)'),
    ).toBe(true)
    expect(looksLikeBounce('x@y.com', 'Undeliverable: Quick question')).toBe(true)
  })

  it('does not treat an ordinary reply as a bounce', () => {
    // The whole point of polling is to distinguish these two.
    expect(looksLikeBounce('ana@northwind.io', 'Re: Quick question')).toBe(false)
    expect(looksLikeBounce('ana@northwind.io', 'Out of office')).toBe(false)
  })
})

describe('parseBounce — RFC 3464', () => {
  const bounce = parseBounce({ raw: RFC3464_HARD, ownAddress: 'sam@acme.com' })

  it('reads the failed recipient from Final-Recipient', () => {
    expect(bounce.recipient).toBe('ana@northwind.io')
  })

  it('reads the enhanced status code', () => {
    expect(bounce.status).toBe('5.1.1')
  })

  it('classifies a 5.x.x as hard', () => {
    expect(bounce.type).toBe('hard')
    expect(shouldSuppress(bounce)).toBe(true)
  })

  it('keeps the diagnostic for the report', () => {
    expect(bounce.diagnostic).toContain('does not exist')
  })

  it('classifies a 4.x.x as soft and does not suppress', () => {
    // A full mailbox is temporary. Suppressing would lose a real contact.
    const soft = parseBounce({ raw: RFC3464_SOFT, ownAddress: 'sam@acme.com' })
    expect(soft.type).toBe('soft')
    expect(soft.recipient).toBe('bo@cascade.dev')
    expect(soft.status).toBe('4.2.2')
    expect(shouldSuppress(soft)).toBe(false)
  })
})

describe('parseBounce — free text', () => {
  const bounce = parseBounce({ raw: FREE_TEXT, ownAddress: 'sam@acme.com' })

  it('finds the recipient without a Final-Recipient field', () => {
    expect(bounce.recipient).toBe('kim@vertex.io')
  })

  it('finds the status code in the body', () => {
    expect(bounce.status).toBe('5.1.1')
    expect(bounce.type).toBe('hard')
  })
})

describe('parseBounce — picking the right address', () => {
  it('never reports the daemon as the failed recipient', () => {
    // It appears in every bounce; reporting it would suppress your own
    // provider's address.
    const bounce = parseBounce({
      raw: 'From: mailer-daemon@googlemail.com\n\n550 5.1.1 failure for ana@northwind.io',
      ownAddress: 'sam@acme.com',
    })
    expect(bounce.recipient).toBe('ana@northwind.io')
  })

  it('never reports the sender as the failed recipient', () => {
    // The To: header of a bounce is you.
    const bounce = parseBounce({
      raw: 'From: postmaster@x.com\nTo: sam@acme.com\n\n550 5.1.1 no such user ana@northwind.io',
      ownAddress: 'sam@acme.com',
    })
    expect(bounce.recipient).toBe('ana@northwind.io')
  })

  it('skips no-reply and bounce addresses', () => {
    const bounce = parseBounce({
      raw: 'From: no-reply@x.com\n\nbounces@x.com reported: 550 5.1.1 ana@northwind.io failed',
      ownAddress: 'sam@acme.com',
    })
    expect(bounce.recipient).toBe('ana@northwind.io')
  })

  it('strips angle brackets and trailing punctuation', () => {
    const bounce = parseBounce({
      raw: 'Final-Recipient: rfc822; <Ana@Northwind.IO>\nStatus: 5.1.1',
    })
    expect(bounce.recipient).toBe('ana@northwind.io')
  })
})

describe('parseBounce — refusing to guess', () => {
  it('returns unknown when there is no code at all', () => {
    // `failed` with no status means it did not arrive, but not that the
    // address is dead — so nothing is suppressed.
    const bounce = parseBounce({ raw: 'Final-Recipient: rfc822; a@b.com\nAction: failed' })
    expect(bounce.type).toBe('unknown')
    expect(shouldSuppress(bounce)).toBe(false)
  })

  it('never suppresses without a recipient', () => {
    const bounce = parseBounce({ raw: 'Status: 5.1.1\nSomething went wrong' })
    expect(bounce.type).toBe('hard')
    expect(bounce.recipient).toBeNull()
    expect(shouldSuppress(bounce)).toBe(false)
  })

  it('handles an empty message without throwing', () => {
    const bounce = parseBounce({ raw: '' })
    expect(bounce).toEqual({
      type: 'unknown',
      recipient: null,
      status: null,
      smtpCode: null,
      diagnostic: null,
    })
  })

  it('falls back to the SMTP reply code when there is no enhanced status', () => {
    expect(parseBounce({ raw: 'Final-Recipient: rfc822; a@b.com\n550 No such user' }).type).toBe(
      'hard',
    )
    expect(parseBounce({ raw: 'Final-Recipient: rfc822; a@b.com\n451 Try later' }).type).toBe(
      'soft',
    )
  })
})

describe('rates', () => {
  it('uses the 0.3% complaint ceiling from the bulk sender rules', () => {
    expect(COMPLAINT_RATE_LIMIT).toBe(0.003)
    expect(complaintRate(3, 1000)).toBe(0.003)
    expect(complaintRate(4, 1000)).toBeGreaterThan(COMPLAINT_RATE_LIMIT)
  })

  it('does not divide by zero', () => {
    expect(complaintRate(0, 0)).toBe(0)
    expect(bounceRate(0, 0)).toBe(0)
  })

  it('flags a bounce rate that suggests a stale list', () => {
    expect(bounceRate(60, 1000)).toBeGreaterThan(BOUNCE_RATE_WARNING)
    expect(bounceRate(10, 1000)).toBeLessThan(BOUNCE_RATE_WARNING)
  })
})
