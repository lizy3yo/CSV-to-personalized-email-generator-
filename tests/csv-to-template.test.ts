import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import Papa from 'papaparse'
import { describe, expect, it } from 'vitest'
import { detectColumns } from '@/core/csv/detect'
import { importableRows, ingest } from '@/core/csv/ingest'
import type { ColumnMap, RawRow } from '@/core/csv/types'
import { textToHtml } from '@/core/template/html'
import { render, renderSubject } from '@/core/template/render'

/**
 * Phase 1 and phase 2 composed: a real CSV file all the way through to a
 * rendered email, per row.
 *
 * This is the scenario the editor's row stepper exists for. Each row here
 * fails differently, and the point of stepping through real data is that you
 * see those failures before anything is generated:
 *
 *   row 1  ordinary
 *   row 2  empty first_name  → "Hi ," unless a default is set
 *   row 3  empty company     → "Quick question," with a dangling comma
 *          and a shouty CARLOS unless a filter cleans it up
 */

const SUBJECT = 'Quick question{{#if company}}, {{company}}{{/if}}'
const BODY = [
  'Hi {{ first_name | capitalize | default: there }},',
  '',
  '{{ai:opening}}',
  '',
  '{{#if city}}We work with a few teams in {{city}}.{{/if}}',
  '',
  'Worth a short call?',
  '',
  '— Sam',
].join('\n')

function pipeline() {
  const text = readFileSync(
    resolve(import.meta.dirname, 'fixtures', 'template-preview.csv'),
    'utf8',
  )
  const { data, meta } = Papa.parse<RawRow>(text, {
    header: true,
    skipEmptyLines: 'greedy',
    transformHeader: (h) => h.trim(),
  })

  const columnMap: ColumnMap = {}
  for (const column of detectColumns((meta.fields ?? []).filter(Boolean), data)) {
    columnMap[column.header] = { role: column.role, variable: column.variable }
  }

  return importableRows(ingest({ rows: data, columnMap })).map((row) => ({
    email: row.email,
    subject: renderSubject(SUBJECT, { data: row.data }).text,
    body: render(BODY, { data: row.data }).text,
    unresolved: render(BODY, { data: row.data }).unresolved,
  }))
}

describe('CSV through to rendered email', () => {
  const rendered = pipeline()

  it('imports every row', () => {
    expect(rendered.map((r) => r.email)).toEqual([
      'a.chen@northwind.io',
      'b.park@cascade.dev',
      'c.diaz@vertex.io',
    ])
  })

  it('renders the ordinary row', () => {
    expect(rendered[0].subject).toBe('Quick question, Northwind Traders')
    expect(rendered[0].body).toContain('Hi Ana,')
    expect(rendered[0].body).toContain('We work with a few teams in Bristol.')
  })

  it('falls back when first_name is empty, instead of "Hi ,"', () => {
    expect(rendered[1].body).toContain('Hi there,')
    expect(rendered[1].body).not.toContain('Hi ,')
  })

  it('drops the dangling comma when company is empty', () => {
    // Without the conditional this subject reads "Quick question," — which is
    // the kind of thing only visible by stepping through real rows.
    expect(rendered[2].subject).toBe('Quick question')
    expect(rendered[2].subject).not.toMatch(/,\s*$/)
  })

  it('tidies a shouty CSV export', () => {
    expect(rendered[2].body).toContain('Hi Carlos,')
    expect(rendered[2].body).not.toContain('CARLOS')
  })

  it('leaves no gap where an unfilled AI slot sits', () => {
    // The slot is empty until phase 3; the body must not show a hole.
    for (const row of rendered) {
      expect(row.body).not.toMatch(/\n{3,}/)
      expect(row.body).not.toContain('{{ai:')
    }
  })

  it('reports the empty company on the row that has one', () => {
    expect(rendered[0].unresolved).toEqual([])
    expect(rendered[2].unresolved).toEqual([])
  })

  it('produces HTML that matches the text for every row', () => {
    for (const row of rendered) {
      const html = textToHtml(row.body)
      expect(html.startsWith('<p>')).toBe(true)
      expect(html).not.toContain('{{')
    }
  })
})
