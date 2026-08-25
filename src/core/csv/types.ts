/**
 * Types for the CSV ingest pipeline.
 *
 * Everything here is framework-free and operates on already-parsed rows. The
 * file itself is parsed in the browser (PapaParse) and never uploaded — only
 * the mapped, validated values are sent to the server.
 */

/**
 * What a CSV column is for.
 *
 * The distinction between `merge_var` and `ai_context` is the important one:
 *   • `merge_var` is substituted literally as `{{name}}`. Deterministic.
 *   • `ai_context` is fed to the model as background but never inserted
 *     verbatim — it informs what the model writes without appearing raw.
 *   • `ignore` never leaves the browser.
 */
export type ColumnRole = 'email' | 'merge_var' | 'ai_context' | 'ignore'

export interface ColumnMapping {
  /** The CSV header, verbatim. */
  header: string
  role: ColumnRole
  /** Template variable name for `merge_var` columns, e.g. `first_name`. */
  variable?: string
}

export type ColumnMap = Record<string, { role: ColumnRole; variable?: string }>

/** A parsed CSV row: header → cell value. */
export type RawRow = Record<string, string>

export type RowStatus = 'valid' | 'invalid_email' | 'missing_email' | 'duplicate' | 'suppressed'

export interface IngestedRow {
  /** 1-based, matching the spreadsheet the user is looking at (header is row 1). */
  rowNumber: number
  status: RowStatus
  /** Normalised: trimmed and lowercased. The dedupe and suppression key. */
  email: string
  /** As it appeared in the file, for display. */
  emailRaw: string
  /** Mapped columns only — `ignore` columns are dropped here, not on the server. */
  data: Record<string, string>
  /** Human-readable reason, present when status is not `valid`. */
  issue?: string
  /** For duplicates: the row number this collides with. */
  duplicateOf?: number
}

export interface IngestSummary {
  total: number
  valid: number
  invalidEmail: number
  missingEmail: number
  duplicate: number
  suppressed: number
}

export interface IngestResult {
  rows: IngestedRow[]
  summary: IngestSummary
  /** Merge variables actually available, derived from the mapping. */
  variables: string[]
}

export interface DetectedColumn {
  header: string
  role: ColumnRole
  variable?: string
  /** First few non-empty values, for the mapping UI. */
  samples: string[]
  /** How the role was chosen. Shown as a tooltip so the guess is not magic. */
  reason: string
  /** 0–1. Below `AMBIGUOUS_THRESHOLD` the UI asks the user to confirm. */
  confidence: number
}

/** Guard rails on import size. */
export const LIMITS = {
  MAX_ROWS: 50_000,
  MAX_CELL_LENGTH: 10_000,
  MAX_FILE_BYTES: 25 * 1024 * 1024,
  /** Rows per server round-trip. Server Actions cap request bodies. */
  CHUNK_SIZE: 500,
} as const

export const AMBIGUOUS_THRESHOLD = 0.6
