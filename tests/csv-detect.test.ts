import { describe, expect, it } from 'vitest'
import {
  detectColumns,
  findEmailColumn,
  toVariableName,
  uniqueVariableNames,
} from '@/core/csv/detect'
import type { DetectedColumn, RawRow } from '@/core/csv/types'

function roleOf(columns: DetectedColumn[], header: string) {
  return columns.find((c) => c.header === header)?.role
}

describe('toVariableName', () => {
  it('slugifies headers', () => {
    expect(toVariableName('First Name')).toBe('first_name')
    expect(toVariableName('Company (Legal)')).toBe('company_legal')
    expect(toVariableName('  Job-Title  ')).toBe('job_title')
  })

  it('prefixes names that would start with a digit', () => {
    // `{{2024_spend}}` is not a usable variable name.
    expect(toVariableName('2024 Spend')).toBe('col_2024_spend')
  })

  it('falls back when a header slugifies to nothing', () => {
    expect(toVariableName('!!!')).toBe('column')
  })
})

describe('uniqueVariableNames', () => {
  it('disambiguates headers that slugify identically', () => {
    const columns = [
      {
        header: 'First Name',
        role: 'merge_var',
        variable: 'first_name',
        samples: [],
        reason: '',
        confidence: 1,
      },
      {
        header: 'first-name',
        role: 'merge_var',
        variable: 'first_name',
        samples: [],
        reason: '',
        confidence: 1,
      },
    ] satisfies DetectedColumn[]

    expect(uniqueVariableNames(columns).map((c) => c.variable)).toEqual([
      'first_name',
      'first_name_2',
    ])
  })
})

describe('detectColumns', () => {
  const rows: RawRow[] = [
    {
      'Email Address': 'a.chen@northwind.io',
      'First Name': 'Ana',
      Company: 'Northwind Traders',
      'Last Touch': '2026-07-14',
      Notes: 'Asked about SSO pricing and whether SCIM provisioning is on the roadmap.',
      'Internal ID': '88213',
    },
    {
      'Email Address': 'b.park@cascade.dev',
      'First Name': 'Bo',
      Company: 'Cascade',
      'Last Touch': '2026-06-02',
      Notes: 'Trialled the product last quarter, went quiet after the pilot ended.',
      'Internal ID': '88214',
    },
  ]
  const headers = Object.keys(rows[0])

  it('finds the email column', () => {
    expect(findEmailColumn(detectColumns(headers, rows))).toBe('Email Address')
  })

  it('classifies known personal fields as merge variables', () => {
    const columns = detectColumns(headers, rows)
    expect(roleOf(columns, 'First Name')).toBe('merge_var')
    expect(roleOf(columns, 'Company')).toBe('merge_var')
  })

  it('classifies free text as AI context', () => {
    expect(roleOf(detectColumns(headers, rows), 'Notes')).toBe('ai_context')
  })

  it('names AI context columns too', () => {
    // The model refers to these fields by name in the prompt, and the mapping
    // UI displays it — an undefined name rendered as an empty `{{}}`.
    const columns = detectColumns(headers, rows)
    expect(columns.find((c) => c.header === 'Notes')?.variable).toBe('notes')
    expect(columns.find((c) => c.header === 'Last Touch')?.variable).toBe('last_touch')
  })

  it('gives a variable to every column except email and ignore', () => {
    for (const column of detectColumns(headers, rows)) {
      if (column.role === 'email' || column.role === 'ignore') {
        expect(column.variable).toBeUndefined()
      } else {
        expect(column.variable, `${column.header} has no variable name`).toBeTruthy()
      }
    }
  })

  it('ignores internal identifiers', () => {
    expect(roleOf(detectColumns(headers, rows), 'Internal ID')).toBe('ignore')
  })

  it('finds an email column from its values even when the header does not say so', () => {
    // A column of addresses headed "Contact" is an email column whatever it is
    // called — getting this wrong breaks the entire import.
    const disguised: RawRow[] = [
      { Contact: 'a.chen@northwind.io', Who: 'Ana' },
      { Contact: 'b.park@cascade.dev', Who: 'Bo' },
    ]
    expect(findEmailColumn(detectColumns(['Contact', 'Who'], disguised))).toBe('Contact')
  })

  it('does not trust a header that says email over values that are not', () => {
    const mislabelled: RawRow[] = [
      { 'Email Preference': 'weekly', Name: 'Ana' },
      { 'Email Preference': 'never', Name: 'Bo' },
    ]
    expect(findEmailColumn(detectColumns(['Email Preference', 'Name'], mislabelled))).toBeNull()
  })

  it('picks exactly one email column when several look plausible', () => {
    // Two dedupe keys would be ambiguous, so the runner-up is demoted.
    const two: RawRow[] = [
      { 'Work Email': 'a@x.com', 'Personal Email': 'a@home.com' },
      { 'Work Email': 'b@x.com', 'Personal Email': 'b@home.com' },
    ]
    const columns = detectColumns(['Work Email', 'Personal Email'], two)
    expect(columns.filter((c) => c.role === 'email')).toHaveLength(1)
    expect(columns.filter((c) => c.role === 'merge_var')).toHaveLength(1)
  })

  it('ignores list-management columns', () => {
    const rows: RawRow[] = [{ Unsubscribed: 'false', Status: 'active', Tags: 'lead' }]
    const columns = detectColumns(['Unsubscribed', 'Status', 'Tags'], rows)
    expect(columns.every((c) => c.role === 'ignore')).toBe(true)
  })

  it('reports low confidence for unrecognised columns', () => {
    const rows: RawRow[] = [{ Widget: 'blue' }]
    const [column] = detectColumns(['Widget'], rows)
    expect(column.role).toBe('merge_var')
    expect(column.confidence).toBeLessThan(0.6)
  })

  it('always gives a reason for its guess', () => {
    for (const column of detectColumns(headers, rows)) {
      expect(column.reason.length).toBeGreaterThan(0)
    }
  })

  it('collects sample values for the mapping UI', () => {
    const columns = detectColumns(headers, rows)
    expect(columns.find((c) => c.header === 'First Name')?.samples).toEqual(['Ana', 'Bo'])
  })

  it('handles an empty file', () => {
    expect(detectColumns([], [])).toEqual([])
  })
})
