import { describe, expect, it } from 'vitest'
import { escapeForSpreadsheet, looksLikeCsvFile, sanitizeCell } from '@/core/csv/sanitize'
import { LIMITS } from '@/core/csv/types'

describe('sanitizeCell', () => {
  it('trims and strips control characters', () => {
    expect(sanitizeCell(`  Ana${String.fromCharCode(0x00)}  `)).toBe('Ana')
  })

  it('caps very long cells', () => {
    expect(sanitizeCell('x'.repeat(LIMITS.MAX_CELL_LENGTH + 500))).toHaveLength(
      LIMITS.MAX_CELL_LENGTH,
    )
  })

  it('leaves formula-looking values untouched on import', () => {
    // Escaping here would corrupt legitimate data the user typed. Formula
    // injection is an export-time concern — see escapeForSpreadsheet.
    expect(sanitizeCell('-5')).toBe('-5')
    expect(sanitizeCell('+44 20 7946 0958')).toBe('+44 20 7946 0958')
    expect(sanitizeCell('=SUM(A1:A2)')).toBe('=SUM(A1:A2)')
  })

  it('leaves template syntax untouched', () => {
    // The renderer substitutes merge values as literal text and never re-scans
    // them, so a value containing template syntax is inert by construction.
    expect(sanitizeCell('{{ai:opening}}')).toBe('{{ai:opening}}')
  })
})

describe('escapeForSpreadsheet', () => {
  for (const prefix of ['=', '+', '-', '@']) {
    it(`neutralises a leading ${prefix}`, () => {
      expect(escapeForSpreadsheet(`${prefix}cmd`)).toBe(`'${prefix}cmd`)
    })
  }

  it('neutralises a leading tab and carriage return', () => {
    expect(escapeForSpreadsheet(`${String.fromCharCode(0x09)}x`)).toBe(
      `'${String.fromCharCode(0x09)}x`,
    )
    expect(escapeForSpreadsheet(`${String.fromCharCode(0x0d)}x`)).toBe(
      `'${String.fromCharCode(0x0d)}x`,
    )
  })

  it('leaves ordinary values alone', () => {
    expect(escapeForSpreadsheet('Ana Chen')).toBe('Ana Chen')
    expect(escapeForSpreadsheet('ana@northwind.io')).toBe('ana@northwind.io')
    expect(escapeForSpreadsheet('')).toBe('')
  })
})

describe('looksLikeCsvFile', () => {
  const file = (over: Partial<{ name: string; type: string; size: number }> = {}) => ({
    name: 'contacts.csv',
    type: 'text/csv',
    size: 1024,
    ...over,
  })

  it('accepts a plain csv', () => {
    expect(looksLikeCsvFile(file()).ok).toBe(true)
  })

  it('accepts the MIME types browsers actually report for CSV', () => {
    // Chrome, Firefox and Excel-installed Windows all disagree here.
    expect(looksLikeCsvFile(file({ type: '' })).ok).toBe(true)
    expect(looksLikeCsvFile(file({ type: 'application/vnd.ms-excel' })).ok).toBe(true)
    expect(looksLikeCsvFile(file({ type: 'text/plain' })).ok).toBe(true)
  })

  it('accepts tsv and txt', () => {
    expect(looksLikeCsvFile(file({ name: 'contacts.tsv' })).ok).toBe(true)
    expect(looksLikeCsvFile(file({ name: 'contacts.txt' })).ok).toBe(true)
  })

  it('rejects the wrong extension', () => {
    expect(looksLikeCsvFile(file({ name: 'contacts.xlsx' })).reason).toBe(
      'Expected a .csv, .tsv or .txt file',
    )
  })

  it('rejects an empty file', () => {
    expect(looksLikeCsvFile(file({ size: 0 })).reason).toBe('File is empty')
  })

  it('rejects an oversized file', () => {
    expect(looksLikeCsvFile(file({ size: LIMITS.MAX_FILE_BYTES + 1 })).ok).toBe(false)
  })
})
