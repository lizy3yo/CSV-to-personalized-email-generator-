import { LIMITS } from './types'
import { stripControl } from './email'

/**
 * Cell sanitisation.
 *
 * Two different threats, handled at two different points, deliberately:
 *
 *  1. **Spreadsheet formula injection** — a cell beginning `=`, `+`, `-`, `@`
 *     or a tab is executed as a formula when the file is opened in Excel or
 *     Sheets. This is escaped **on export**, never on import: mangling on
 *     import would corrupt legitimate values (`-5`, `+44 20 7946 0958`) and
 *     the user would see data they never typed.
 *
 *  2. **Template injection** — a cell containing `{{ai:opening}}` must not be
 *     re-parsed when it is merged into a template. That is the renderer's
 *     job (phase 2): merge values are substituted as literal text and never
 *     re-scanned for template syntax. Escaping here would not help, because
 *     the value must still display as typed.
 *
 * What import does do is trim, strip control characters, and cap length.
 */

/** Clean a cell on the way in. Preserves what the user actually typed. */
export function sanitizeCell(value: string): string {
  const cleaned = stripControl(value).trim()
  return cleaned.length > LIMITS.MAX_CELL_LENGTH
    ? cleaned.slice(0, LIMITS.MAX_CELL_LENGTH)
    : cleaned
}

/** Characters a spreadsheet treats as the start of a formula. */
const FORMULA_PREFIXES = ['=', '+', '-', '@', String.fromCharCode(0x09), String.fromCharCode(0x0d)]

/**
 * Escape a value for CSV export so spreadsheets treat it as text.
 *
 * Prefixing with an apostrophe is the conventional fix: Excel and Sheets both
 * read it as "this is text", and it is not shown in the cell.
 *
 * Used at export time (phases 8–9). Tested now so the rule exists before
 * anything depends on it.
 */
export function escapeForSpreadsheet(value: string): string {
  if (!value) return value
  return FORMULA_PREFIXES.some((prefix) => value.startsWith(prefix)) ? `'${value}` : value
}

/** Is this file plausibly a CSV? Checked before parsing, on name and type. */
export function looksLikeCsvFile(file: { name: string; type: string; size: number }): {
  ok: boolean
  reason?: string
} {
  if (file.size > LIMITS.MAX_FILE_BYTES) {
    return {
      ok: false,
      reason: `File is larger than ${Math.round(LIMITS.MAX_FILE_BYTES / 1024 / 1024)} MB`,
    }
  }
  if (file.size === 0) return { ok: false, reason: 'File is empty' }

  const name = file.name.toLowerCase()
  const extensionOk = name.endsWith('.csv') || name.endsWith('.tsv') || name.endsWith('.txt')

  // Browsers report CSV inconsistently — text/csv, application/vnd.ms-excel,
  // and empty string are all common for the same file — so the extension is
  // the primary signal and an empty type is not treated as suspicious.
  const typeOk =
    file.type === '' ||
    file.type.startsWith('text/') ||
    file.type === 'application/csv' ||
    file.type === 'application/vnd.ms-excel'

  if (!extensionOk) return { ok: false, reason: 'Expected a .csv, .tsv or .txt file' }
  if (!typeOk) return { ok: false, reason: `Unexpected file type: ${file.type}` }

  return { ok: true }
}
