import { describe, expect, it } from 'vitest'
import {
  contextFieldsOf,
  emailColumnOf,
  importableRows,
  ingest,
  mergeSummaries,
  variablesOf,
} from '@/core/csv/ingest'
import type { ColumnMap, RawRow } from '@/core/csv/types'

const MAP: ColumnMap = {
  Email: { role: 'email' },
  'First Name': { role: 'merge_var', variable: 'first_name' },
  Company: { role: 'merge_var', variable: 'company' },
  Notes: { role: 'ai_context', variable: 'notes' },
  'Internal ID': { role: 'ignore' },
}

const rows: RawRow[] = [
  {
    Email: 'a.chen@northwind.io',
    'First Name': 'Ana',
    Company: 'Northwind',
    Notes: 'SSO',
    'Internal ID': '1',
  },
  {
    Email: 'b.park@cascade.dev',
    'First Name': 'Bo',
    Company: 'Cascade',
    Notes: '',
    'Internal ID': '2',
  },
]

describe('mapping helpers', () => {
  it('finds the email column', () => {
    expect(emailColumnOf(MAP)).toBe('Email')
    expect(emailColumnOf({ Name: { role: 'merge_var' } })).toBeNull()
  })

  it('lists merge variables and context fields separately', () => {
    expect(variablesOf(MAP)).toEqual(['first_name', 'company'])
    expect(contextFieldsOf(MAP)).toEqual(['notes'])
  })
})

describe('ingest', () => {
  it('accepts valid rows', () => {
    const result = ingest({ rows, columnMap: MAP })
    expect(result.summary).toEqual({
      total: 2,
      valid: 2,
      invalidEmail: 0,
      missingEmail: 0,
      duplicate: 0,
      suppressed: 0,
    })
  })

  it('numbers rows the way the spreadsheet does', () => {
    // Row 1 is the header, so the first data row is row 2.
    expect(ingest({ rows, columnMap: MAP }).rows.map((r) => r.rowNumber)).toEqual([2, 3])
  })

  it('drops ignored columns before they leave the browser', () => {
    const [first] = ingest({ rows, columnMap: MAP }).rows
    expect(first.data).toEqual({ first_name: 'Ana', company: 'Northwind', notes: 'SSO' })
    expect(first.data).not.toHaveProperty('Internal ID')
  })

  it('omits empty cells rather than storing empty strings', () => {
    const [, second] = ingest({ rows, columnMap: MAP }).rows
    expect(second.data).not.toHaveProperty('notes')
  })

  it('keeps the raw address alongside the normalised one', () => {
    const [row] = ingest({
      rows: [{ Email: '  Ana.Chen@Northwind.IO ' }],
      columnMap: { Email: { role: 'email' } },
    }).rows
    expect(row.email).toBe('ana.chen@northwind.io')
    expect(row.emailRaw).toBe('Ana.Chen@Northwind.IO')
  })

  it('flags invalid addresses with a reason', () => {
    const result = ingest({
      rows: [{ Email: 'not-an-email' }],
      columnMap: { Email: { role: 'email' } },
    })
    expect(result.rows[0].status).toBe('invalid_email')
    expect(result.rows[0].issue).toBe('No @ sign')
    expect(result.summary.invalidEmail).toBe(1)
  })

  it('flags empty address cells', () => {
    const result = ingest({ rows: [{ Email: '   ' }], columnMap: { Email: { role: 'email' } } })
    expect(result.rows[0].status).toBe('missing_email')
    expect(result.rows[0].issue).toBe('Email cell is empty')
  })

  it('flags every row when no column is mapped to email', () => {
    const result = ingest({ rows, columnMap: { 'First Name': { role: 'merge_var' } } })
    expect(result.summary.missingEmail).toBe(2)
    expect(result.rows[0].issue).toBe('No column is mapped to Email')
  })

  it('detects duplicates case- and whitespace-insensitively, pointing at the first', () => {
    const result = ingest({
      rows: [{ Email: 'ana@x.com' }, { Email: '  ANA@X.com ' }],
      columnMap: { Email: { role: 'email' } },
    })
    expect(result.rows[1].status).toBe('duplicate')
    expect(result.rows[1].duplicateOf).toBe(2)
    expect(result.rows[1].issue).toBe('Same address as row 2')
    expect(result.summary.duplicate).toBe(1)
  })

  it('flags suppressed addresses', () => {
    const result = ingest({
      rows: [{ Email: 'ana@x.com' }],
      columnMap: { Email: { role: 'email' } },
      suppressed: new Set(['ana@x.com']),
    })
    expect(result.rows[0].status).toBe('suppressed')
    expect(result.rows[0].issue).toBe('On your suppression list')
  })

  it('counts a repeated suppressed address once, with the rest as duplicates', () => {
    // Otherwise "5 suppressed" would overstate a single suppressed contact.
    const result = ingest({
      rows: [{ Email: 'ana@x.com' }, { Email: 'ana@x.com' }, { Email: 'ana@x.com' }],
      columnMap: { Email: { role: 'email' } },
      suppressed: new Set(['ana@x.com']),
    })
    expect(result.summary.suppressed).toBe(1)
    expect(result.summary.duplicate).toBe(2)
  })

  it('gives every row exactly one status, so the summary adds up', () => {
    const mixed: RawRow[] = [
      { Email: 'ok@x.com' },
      { Email: 'bad' },
      { Email: '' },
      { Email: 'ok@x.com' },
      { Email: 'blocked@x.com' },
    ]
    const { summary } = ingest({
      rows: mixed,
      columnMap: { Email: { role: 'email' } },
      suppressed: new Set(['blocked@x.com']),
    })
    const parts =
      summary.valid +
      summary.invalidEmail +
      summary.missingEmail +
      summary.duplicate +
      summary.suppressed
    expect(parts).toBe(summary.total)
    expect(summary.total).toBe(5)
  })

  it('only marks valid rows as importable', () => {
    const result = ingest({
      rows: [{ Email: 'ok@x.com' }, { Email: 'bad' }],
      columnMap: { Email: { role: 'email' } },
    })
    expect(importableRows(result).map((r) => r.email)).toEqual(['ok@x.com'])
  })

  it('handles an empty file', () => {
    const result = ingest({ rows: [], columnMap: MAP })
    expect(result.summary.total).toBe(0)
    expect(result.rows).toEqual([])
  })
})

describe('chunked ingest', () => {
  it('dedupes across chunks via a shared seen map', () => {
    // A large file is sliced, but a duplicate must still be caught when the two
    // occurrences land in different slices.
    const seen = new Map<string, number>()
    const columnMap: ColumnMap = { Email: { role: 'email' } }

    const first = ingest({ rows: [{ Email: 'ana@x.com' }], columnMap, seen, rowOffset: 0 })
    const second = ingest({ rows: [{ Email: 'ana@x.com' }], columnMap, seen, rowOffset: 1 })

    expect(first.rows[0].status).toBe('valid')
    expect(second.rows[0].status).toBe('duplicate')
    expect(second.rows[0].duplicateOf).toBe(2)
  })

  it('keeps row numbers continuous across chunks', () => {
    const columnMap: ColumnMap = { Email: { role: 'email' } }
    const second = ingest({
      rows: [{ Email: 'c@x.com' }, { Email: 'd@x.com' }],
      columnMap,
      rowOffset: 2,
    })
    expect(second.rows.map((r) => r.rowNumber)).toEqual([4, 5])
  })

  it('merges summaries', () => {
    const merged = mergeSummaries([
      { total: 2, valid: 2, invalidEmail: 0, missingEmail: 0, duplicate: 0, suppressed: 0 },
      { total: 3, valid: 1, invalidEmail: 1, missingEmail: 0, duplicate: 1, suppressed: 0 },
    ])
    expect(merged).toEqual({
      total: 5,
      valid: 3,
      invalidEmail: 1,
      missingEmail: 0,
      duplicate: 1,
      suppressed: 0,
    })
  })
})
