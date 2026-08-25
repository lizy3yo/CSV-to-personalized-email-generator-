import { describe, expect, it } from 'vitest'
import {
  isValidEmail,
  looksLikeEmail,
  normalizeEmail,
  stripControl,
  validateEmail,
} from '@/core/csv/email'

describe('normalizeEmail', () => {
  it('trims and lowercases', () => {
    expect(normalizeEmail('  Ana.Chen@Northwind.IO  ')).toBe('ana.chen@northwind.io')
  })

  it('strips zero-width characters', () => {
    // Invisible in the UI, but without this the value would not equal the same
    // address typed by hand — defeating dedupe and the suppression list.
    const zwsp = String.fromCharCode(0x200b)
    expect(normalizeEmail(`ana${zwsp}@northwind.io`)).toBe('ana@northwind.io')
  })

  it('strips a BOM', () => {
    expect(normalizeEmail(`${String.fromCharCode(0xfeff)}ana@northwind.io`)).toBe(
      'ana@northwind.io',
    )
  })

  it('does not apply Gmail dot or plus folding', () => {
    // Deliberate: folding these would silently merge two contacts the user
    // believes they imported separately.
    expect(normalizeEmail('a.b@gmail.com')).toBe('a.b@gmail.com')
    expect(normalizeEmail('ana+news@gmail.com')).toBe('ana+news@gmail.com')
  })
})

describe('stripControl', () => {
  it('removes control characters but keeps tab, newline and return', () => {
    const input = `a${String.fromCharCode(0x00)}b${String.fromCharCode(0x09)}c`
    expect(stripControl(input)).toBe(`ab${String.fromCharCode(0x09)}c`)
  })

  it('removes DEL', () => {
    expect(stripControl(`a${String.fromCharCode(0x7f)}b`)).toBe('ab')
  })
})

describe('validateEmail', () => {
  const valid = [
    'ana@northwind.io',
    'ana.chen@northwind.io',
    'ana+campaign@northwind.co.uk',
    "o'brien@example.com",
    'a@b.co',
    'first_last@sub.domain.example.org',
    'user123@example-host.com',
  ]

  for (const email of valid) {
    it(`accepts ${email}`, () => {
      expect(isValidEmail(email)).toBe(true)
    })
  }

  const invalid: [string, string][] = [
    ['', 'Empty'],
    ['ana', 'No @ sign'],
    ['ana@@northwind.io', 'More than one @ sign'],
    ['@northwind.io', 'Nothing before the @'],
    ['ana@', 'Nothing after the @'],
    ['ana@northwind', 'Domain has no dot'],
    ['.ana@northwind.io', 'Part before @ starts or ends with a dot'],
    ['ana.@northwind.io', 'Part before @ starts or ends with a dot'],
    ['a..b@northwind.io', 'Consecutive dots before the @'],
    ['ana@northwind..io', 'Consecutive dots in the domain'],
    ['ana@-northwind.io', 'Domain part starts or ends with a hyphen'],
    ['ana@northwind.io-', 'Domain part starts or ends with a hyphen'],
    ['ana@northwind.i', 'Top-level domain must be at least two letters'],
    ['ana@northwind.123', 'Top-level domain must be at least two letters'],
    ['ana chen@northwind.io', 'Contains a space'],
  ]

  for (const [email, reason] of invalid) {
    it(`rejects ${JSON.stringify(email)} — ${reason}`, () => {
      const result = validateEmail(email)
      expect(result.valid).toBe(false)
      expect(result.reason).toBe(reason)
    })
  }

  it('rejects an address over 254 characters', () => {
    const long = `${'a'.repeat(60)}@${'b'.repeat(190)}.com`
    expect(validateEmail(long).reason).toBe('Longer than 254 characters')
  })

  it('rejects a local part over 64 characters', () => {
    expect(validateEmail(`${'a'.repeat(65)}@example.com`).reason).toBe('Part before @ is too long')
  })

  it('validates case-insensitively', () => {
    expect(isValidEmail('ANA@NORTHWIND.IO')).toBe(true)
  })
})

describe('looksLikeEmail', () => {
  it('is loose on purpose — it only guesses which column holds addresses', () => {
    expect(looksLikeEmail('ana@northwind.io')).toBe(true)
    expect(looksLikeEmail('  ana@northwind.io  ')).toBe(true)
    expect(looksLikeEmail('Northwind Traders')).toBe(false)
    expect(looksLikeEmail('2026-07-14')).toBe(false)
    expect(looksLikeEmail('')).toBe(false)
  })
})
