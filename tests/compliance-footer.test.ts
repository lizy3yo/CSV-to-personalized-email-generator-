import { describe, expect, it } from 'vitest'
import {
  appendFooter,
  buildFooterText,
  checkCompliance,
  DEFAULT_OPT_OUT_LINE,
  oneLineAddress,
  unsubscribeHeaders,
} from '@/core/compliance/footer'

const ADDRESS = 'Acme Ltd\n1 Main Street\nBristol BS1 4ST\nUnited Kingdom'
const URL = 'https://app.test/api/unsubscribe/tok'

describe('oneLineAddress', () => {
  it('collapses a multi-line address', () => {
    expect(oneLineAddress(ADDRESS)).toBe('Acme Ltd, 1 Main Street, Bristol BS1 4ST, United Kingdom')
  })

  it('drops blank lines and stray whitespace', () => {
    expect(oneLineAddress('A\n\n  B  \n')).toBe('A, B')
  })
})

describe('buildFooterText — 1:1 outreach', () => {
  const footer = buildFooterText({
    profile: 'one_to_one',
    unsubscribeUrl: URL,
    postalAddress: ADDRESS,
  })

  it('uses a human sentence, not a newsletter footer', () => {
    expect(footer).toContain(DEFAULT_OPT_OUT_LINE)
  })

  it('does NOT show an unsubscribe link', () => {
    // A visible unsubscribe link announces that the message was produced in
    // bulk. The machine-readable opt-out rides in the headers instead.
    expect(footer).not.toContain(URL)
    expect(footer.toLowerCase()).not.toContain('unsubscribe')
  })

  it('still carries the postal address, on one line', () => {
    // CAN-SPAM applies to 1:1 sales outreach too — it is commercial email.
    expect(footer).toContain('Acme Ltd, 1 Main Street, Bristol BS1 4ST, United Kingdom')
  })

  it('honours a custom opt-out sentence', () => {
    const custom = buildFooterText({
      profile: 'one_to_one',
      optOutLine: 'Say the word and I will stop.',
      postalAddress: ADDRESS,
    })
    expect(custom).toContain('Say the word and I will stop.')
    expect(custom).not.toContain(DEFAULT_OPT_OUT_LINE)
  })

  it('falls back to the default when the custom line is blank', () => {
    expect(buildFooterText({ profile: 'one_to_one', optOutLine: '   ' })).toContain(
      DEFAULT_OPT_OUT_LINE,
    )
  })
})

describe('buildFooterText — bulk', () => {
  const footer = buildFooterText({
    profile: 'bulk',
    unsubscribeUrl: URL,
    postalAddress: ADDRESS,
    consentSource: 'you signed up on our website',
  })

  it('shows a visible unsubscribe link', () => {
    expect(footer).toContain(`Unsubscribe: ${URL}`)
  })

  it('says why the person is receiving it', () => {
    expect(footer).toContain('you signed up on our website')
  })

  it('falls back to a generic reason when no source was recorded', () => {
    expect(buildFooterText({ profile: 'bulk', unsubscribeUrl: URL })).toContain(
      'you are on our contact list',
    )
  })

  it('sets the postal address out in full rather than on one line', () => {
    expect(footer).toContain('1 Main Street\nBristol BS1 4ST')
  })
})

describe('appendFooter', () => {
  it('separates the footer from the body with a blank line', () => {
    const result = appendFooter('Hi Ana,\n\nWorth a chat?', {
      profile: 'one_to_one',
      postalAddress: ADDRESS,
    })
    expect(result.startsWith('Hi Ana,\n\nWorth a chat?\n\n')).toBe(true)
    expect(result).toContain(DEFAULT_OPT_OUT_LINE)
  })

  it('trims the body rather than doubling blank lines', () => {
    expect(appendFooter('Body\n\n\n', { profile: 'one_to_one', postalAddress: 'X' })).not.toMatch(
      /\n{3,}/,
    )
  })

  it('returns the body untouched when there is no footer to add', () => {
    expect(appendFooter('Body', { profile: 'bulk' })).toContain('Body')
  })
})

describe('checkCompliance', () => {
  it('passes a fully configured 1:1 send', () => {
    expect(
      checkCompliance({ profile: 'one_to_one', unsubscribeUrl: URL, postalAddress: ADDRESS }),
    ).toEqual([])
  })

  it('blocks when no postal address is set', () => {
    // A legal requirement, so it blocks rather than warns — there is no
    // override anywhere in the UI.
    const issues = checkCompliance({ profile: 'one_to_one', unsubscribeUrl: URL })
    expect(issues).toHaveLength(1)
    expect(issues[0].code).toBe('no_postal_address')
    expect(issues[0].blocking).toBe(true)
    expect(issues[0].message).toContain('CAN-SPAM')
  })

  it('treats a whitespace-only address as missing', () => {
    expect(
      checkCompliance({ profile: 'bulk', unsubscribeUrl: URL, postalAddress: '   ' })[0].code,
    ).toBe('no_postal_address')
  })

  it('blocks when no unsubscribe URL could be built', () => {
    const issues = checkCompliance({ profile: 'bulk', postalAddress: ADDRESS })
    expect(issues.map((i) => i.code)).toContain('no_unsubscribe_url')
    expect(issues.every((i) => i.blocking)).toBe(true)
  })

  it('reports every problem at once rather than one at a time', () => {
    expect(checkCompliance({ profile: 'bulk' })).toHaveLength(2)
  })
})

describe('unsubscribeHeaders', () => {
  it('returns nothing when there is nothing to advertise', () => {
    expect(unsubscribeHeaders(undefined)).toBeUndefined()
  })

  it('carries the URL', () => {
    expect(unsubscribeHeaders(URL)).toEqual({ url: URL, mailto: undefined })
  })

  it('carries a mailto alone', () => {
    expect(unsubscribeHeaders(undefined, 'unsub@acme.com')).toEqual({
      url: undefined,
      mailto: 'unsub@acme.com',
    })
  })
})
