import { toVariableName } from './detect'
import { normalizeEmail, validateEmail } from './email'
import { sanitizeCell } from './sanitize'
import type {
  ColumnMap,
  IngestResult,
  IngestedRow,
  IngestSummary,
  RawRow,
  RowStatus,
} from './types'

/**
 * Turn parsed CSV rows plus a column mapping into classified, deduped rows.
 *
 * Pure: no I/O, no framework. The suppression list is passed in rather than
 * queried here, which keeps this testable and makes the caller's data
 * dependency explicit.
 *
 * Every row gets exactly one status, so the summary counts always add up to
 * the row total — a summary whose parts do not sum to the whole is worse than
 * no summary.
 *
 * Order of checks: missing → invalid → duplicate → suppressed.
 * Duplicates are resolved *before* suppression on purpose. If the same
 * suppressed address appears five times, that is one suppressed contact and
 * four duplicates, not five suppressed ones.
 */

export interface IngestOptions {
  rows: RawRow[]
  columnMap: ColumnMap
  /** Normalised addresses already on the suppression list. */
  suppressed?: ReadonlySet<string>
  /** Offset for row numbers when ingesting in chunks. Defaults to 0. */
  rowOffset?: number
  /** Addresses already imported in earlier chunks, for cross-chunk dedupe. */
  seen?: Map<string, number>
}

/** The column mapped to `email`, or null if the user has not chosen one yet. */
export function emailColumnOf(columnMap: ColumnMap): string | null {
  for (const [header, mapping] of Object.entries(columnMap)) {
    if (mapping.role === 'email') return header
  }
  return null
}

/** Template variables this mapping makes available. */
export function variablesOf(columnMap: ColumnMap): string[] {
  const out: string[] = []
  for (const [header, mapping] of Object.entries(columnMap)) {
    if (mapping.role === 'merge_var') out.push(mapping.variable ?? toVariableName(header))
  }
  return out
}

/** Columns fed to the model as background but never merged verbatim. */
export function contextFieldsOf(columnMap: ColumnMap): string[] {
  const out: string[] = []
  for (const [header, mapping] of Object.entries(columnMap)) {
    if (mapping.role === 'ai_context') out.push(mapping.variable ?? toVariableName(header))
  }
  return out
}

function emptySummary(): IngestSummary {
  return { total: 0, valid: 0, invalidEmail: 0, missingEmail: 0, duplicate: 0, suppressed: 0 }
}

const SUMMARY_KEY: Record<RowStatus, keyof IngestSummary> = {
  valid: 'valid',
  invalid_email: 'invalidEmail',
  missing_email: 'missingEmail',
  duplicate: 'duplicate',
  suppressed: 'suppressed',
}

export function ingest({
  rows,
  columnMap,
  suppressed = new Set<string>(),
  rowOffset = 0,
  seen = new Map<string, number>(),
}: IngestOptions): IngestResult {
  const emailColumn = emailColumnOf(columnMap)
  const summary = emptySummary()
  const out: IngestedRow[] = []

  // Precompute the kept columns so the per-row loop stays cheap on 50k rows.
  const kept = Object.entries(columnMap)
    .filter(([, mapping]) => mapping.role === 'merge_var' || mapping.role === 'ai_context')
    .map(([header, mapping]) => ({ header, variable: mapping.variable ?? toVariableName(header) }))

  rows.forEach((row, index) => {
    // 1-based and offset by the header line, so it matches what the user sees
    // in their spreadsheet.
    const rowNumber = rowOffset + index + 2

    const data: Record<string, string> = {}
    for (const { header, variable } of kept) {
      const value = sanitizeCell(row[header] ?? '')
      if (value) data[variable] = value
    }

    const emailRaw = emailColumn ? sanitizeCell(row[emailColumn] ?? '') : ''
    const email = normalizeEmail(emailRaw)

    let status: RowStatus = 'valid'
    let issue: string | undefined
    let duplicateOf: number | undefined

    if (!emailColumn) {
      status = 'missing_email'
      issue = 'No column is mapped to Email'
    } else if (!email) {
      status = 'missing_email'
      issue = 'Email cell is empty'
    } else {
      const validation = validateEmail(email)
      if (!validation.valid) {
        status = 'invalid_email'
        issue = validation.reason
      } else if (seen.has(email)) {
        status = 'duplicate'
        duplicateOf = seen.get(email)
        issue = `Same address as row ${duplicateOf}`
      } else if (suppressed.has(email)) {
        status = 'suppressed'
        issue = 'On your suppression list'
        seen.set(email, rowNumber)
      } else {
        seen.set(email, rowNumber)
      }
    }

    summary.total += 1
    summary[SUMMARY_KEY[status]] += 1

    out.push({ rowNumber, status, email, emailRaw, data, issue, duplicateOf })
  })

  return { rows: out, summary, variables: variablesOf(columnMap) }
}

/** Rows that will actually be imported. */
export function importableRows(result: IngestResult): IngestedRow[] {
  return result.rows.filter((row) => row.status === 'valid')
}

/**
 * Merge summaries across chunks.
 *
 * A large file is ingested in slices sharing one `seen` map, so the per-chunk
 * summaries have to be added up to describe the whole import.
 */
export function mergeSummaries(summaries: IngestSummary[]): IngestSummary {
  return summaries.reduce<IngestSummary>((acc, next) => {
    acc.total += next.total
    acc.valid += next.valid
    acc.invalidEmail += next.invalidEmail
    acc.missingEmail += next.missingEmail
    acc.duplicate += next.duplicate
    acc.suppressed += next.suppressed
    return acc
  }, emptySummary())
}
