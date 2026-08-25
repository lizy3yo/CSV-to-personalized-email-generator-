import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import Papa from 'papaparse'
import { describe, expect, it } from 'vitest'
import { detectColumns, findEmailColumn } from '@/core/csv/detect'
import { ingest } from '@/core/csv/ingest'
import type { ColumnMap, RawRow } from '@/core/csv/types'

/**
 * End-to-end over the browser-side pipeline, against real CSV files.
 *
 * These fixtures carry the byte-level quirks that synthetic objects never
 * reproduce — CRLF line endings, a UTF-8 BOM, commas and newlines inside
 * quoted fields, ragged rows. Those are exactly the things that break a CSV
 * importer in the field, so the parser is exercised for real rather than
 * stubbed.
 */

function parseFixture(name: string) {
  const text = readFileSync(resolve(import.meta.dirname, 'fixtures', name), 'utf8')
  const { data, meta, errors } = Papa.parse<RawRow>(text, {
    header: true,
    skipEmptyLines: 'greedy',
    transformHeader: (h) => h.trim(),
  })
  return { rows: data, headers: (meta.fields ?? []).filter(Boolean), errors }
}

function mapFrom(headers: string[], rows: RawRow[]): ColumnMap {
  const map: ColumnMap = {}
  for (const column of detectColumns(headers, rows)) {
    map[column.header] = { role: column.role, variable: column.variable }
  }
  return map
}

describe('messy.csv — the realistic case', () => {
  const { rows, headers } = parseFixture('messy.csv')

  it('parses CRLF line endings', () => {
    expect(rows).toHaveLength(7)
  })

  it('keeps commas inside quoted fields', () => {
    expect(rows[0].Company).toBe('Northwind Traders, Inc.')
  })

  it('keeps newlines inside quoted fields', () => {
    expect(rows[1].Notes).toContain('\n')
    expect(rows[1].Notes).toBe('Trialled last quarter.\nWent quiet after the pilot.')
  })

  it('detects the right columns', () => {
    const columns = detectColumns(headers, rows)
    expect(findEmailColumn(columns)).toBe('Email Address')
    expect(columns.find((c) => c.header === 'Notes')?.role).toBe('ai_context')
    expect(columns.find((c) => c.header === 'Internal ID')?.role).toBe('ignore')
  })

  it('classifies every row correctly', () => {
    const result = ingest({
      rows,
      columnMap: mapFrom(headers, rows),
      suppressed: new Set(['blocked@example.com']),
    })

    expect(result.summary).toEqual({
      total: 7,
      valid: 2, // a.chen, b.park
      duplicate: 1, // a.chen again, different case
      invalidEmail: 2, // "not-an-email", and the unicode address
      missingEmail: 1, // empty cell
      suppressed: 1, // blocked@example.com
    })
  })

  it('matches duplicates across case differences', () => {
    // Row 2 is a.chen@northwind.io; row 4 is a.chen@NORTHWIND.io.
    const result = ingest({ rows, columnMap: mapFrom(headers, rows) })
    const duplicate = result.rows.find((r) => r.status === 'duplicate')
    expect(duplicate?.rowNumber).toBe(4)
    expect(duplicate?.duplicateOf).toBe(2)
  })

  it('normalises the uppercase address but keeps the original for display', () => {
    const result = ingest({ rows, columnMap: mapFrom(headers, rows) })
    const bo = result.rows.find((r) => r.email === 'b.park@cascade.dev')
    expect(bo?.emailRaw).toBe('B.PARK@Cascade.dev')
  })

  it('rejects a non-ASCII address with a usable reason', () => {
    // Internationalised addresses need punycode encoding before they can be
    // sent to. Accepting one here would produce a guaranteed bounce.
    const result = ingest({ rows, columnMap: mapFrom(headers, rows) })
    const unicode = result.rows.find((r) => r.emailRaw.includes('ren'))
    expect(unicode?.status).toBe('invalid_email')
    expect(unicode?.issue).toBe('Invalid character before the @')
  })

  it('drops the ignored column from what would be sent to the server', () => {
    const result = ingest({ rows, columnMap: mapFrom(headers, rows) })
    for (const row of result.rows) {
      expect(row.data).not.toHaveProperty('internal_id')
    }
  })

  it('keeps AI context separate from merge variables', () => {
    const columnMap = mapFrom(headers, rows)
    const result = ingest({ rows, columnMap })
    // `notes` is available to the model but is not offered as a merge variable,
    // so it can never be pasted verbatim into an email.
    expect(result.variables).not.toContain('notes')
    expect(result.rows[0].data).toHaveProperty('notes')
  })
})

describe('bom.csv — UTF-8 byte order mark', () => {
  it('does not let a BOM corrupt the first header', () => {
    // Left unhandled, the first header becomes "﻿email" and the email
    // column is never found — a classic Excel-export failure.
    const { rows, headers } = parseFixture('bom.csv')
    expect(findEmailColumn(detectColumns(headers, rows))).toBeTruthy()

    const result = ingest({ rows, columnMap: mapFrom(headers, rows) })
    expect(result.summary.valid).toBe(1)
    expect(result.rows[0].email).toBe('ana@northwind.io')
  })
})

describe('disguised-header.csv — values beat headers', () => {
  it('finds the address column even when it is called "Contact"', () => {
    const { rows, headers } = parseFixture('disguised-header.csv')
    expect(findEmailColumn(detectColumns(headers, rows))).toBe('Contact')

    const result = ingest({ rows, columnMap: mapFrom(headers, rows) })
    expect(result.summary.valid).toBe(2)
  })
})

describe('ragged.csv — a short row', () => {
  it('imports the row rather than failing the whole file', () => {
    // A trailing comma or a short last line should not block an import that is
    // otherwise fine.
    const { rows, headers } = parseFixture('ragged.csv')
    const result = ingest({ rows, columnMap: mapFrom(headers, rows) })
    expect(result.summary.valid).toBe(1)
    expect(result.rows[0].email).toBe('only@row.com')
  })
})
