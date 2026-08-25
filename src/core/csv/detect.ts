import { looksLikeEmail } from './email'
import type { ColumnRole, DetectedColumn, RawRow } from './types'

/**
 * Guess what each CSV column is for.
 *
 * Two signals, in order of trust:
 *   1. The header name. Explicit and usually right.
 *   2. The values. Catches an email column headed `Contact` or `Primary`,
 *      which header matching alone would miss.
 *
 * Every guess carries a confidence and a reason. The mapping UI shows the
 * reason, so the user can see why a column was classified rather than having
 * to trust it — and low-confidence guesses are flagged for confirmation.
 */

/** Normalise a header for matching: lowercase, punctuation collapsed to spaces. */
function key(header: string): string {
  return header
    .toLowerCase()
    .replace(/[_\-.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Turn a header into a template variable name.
 * `First Name` → `first_name`, `Company (Legal)` → `company_legal`.
 */
export function toVariableName(header: string): string {
  const slug = header
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  // A variable must not start with a digit — `{{2024_spend}}` is not a usable name.
  return /^[0-9]/.test(slug) ? `col_${slug}` : slug || 'column'
}

/** Ensure variable names are unique, since two headers can slugify identically. */
export function uniqueVariableNames(columns: DetectedColumn[]): DetectedColumn[] {
  const seen = new Map<string, number>()
  return columns.map((column) => {
    if (!column.variable) return column
    const count = seen.get(column.variable) ?? 0
    seen.set(column.variable, count + 1)
    return count === 0 ? column : { ...column, variable: `${column.variable}_${count + 1}` }
  })
}

interface Rule {
  role: ColumnRole
  test: RegExp
  reason: string
  confidence: number
}

/**
 * Order matters — the first match wins, so specific patterns precede general
 * ones. `ignore` rules come first so an `email_id` column is dropped rather
 * than mistaken for an address.
 */
const RULES: Rule[] = [
  // Internal identifiers and bookkeeping columns.
  {
    role: 'ignore',
    test: /^(id|_id|uuid|guid|row|row (num|number|id)|index|record id|internal( id)?|crm id|contact id|external id)$/,
    reason: 'Looks like an internal identifier',
    confidence: 0.9,
  },
  {
    role: 'ignore',
    test: /^(created( at| on| date)?|updated( at| on| date)?|modified( at| on)?|imported( at| on)?)$/,
    reason: 'Looks like a bookkeeping timestamp',
    confidence: 0.85,
  },
  {
    role: 'ignore',
    test: /(unsubscrib|opt out|opted out|do not (contact|email)|bounced|status|tags?|source|owner|assigned)/,
    reason: 'List-management column, not useful in a message',
    confidence: 0.7,
  },

  // The address.
  {
    role: 'email',
    test: /^(e ?mail|email address|e mail address|primary email|work email|business email|contact email|address email)$/,
    reason: 'Header names an email address',
    confidence: 1,
  },
  { role: 'email', test: /\bemail\b/, reason: 'Header mentions email', confidence: 0.8 },

  // Personal merge fields.
  {
    role: 'merge_var',
    test: /^(first name|firstname|fname|given name|first|forename)$/,
    reason: 'First name',
    confidence: 1,
  },
  {
    role: 'merge_var',
    test: /^(last name|lastname|lname|surname|family name|last)$/,
    reason: 'Last name',
    confidence: 1,
  },
  {
    role: 'merge_var',
    test: /^(full name|name|contact name|display name)$/,
    reason: 'Full name',
    confidence: 0.9,
  },
  {
    role: 'merge_var',
    test: /^(company|company name|organi[sz]ation|organi[sz]ation name|org|account|account name|business|employer)$/,
    reason: 'Company',
    confidence: 1,
  },
  {
    role: 'merge_var',
    test: /^(title|job title|position|role|job role|occupation)$/,
    reason: 'Job title',
    confidence: 0.95,
  },
  {
    role: 'merge_var',
    test: /^(city|town|country|state|region|industry|sector|website|url|domain|department|team)$/,
    reason: 'Short attribute, safe to merge literally',
    confidence: 0.85,
  },

  // Free text worth showing the model but never inserting verbatim.
  {
    role: 'ai_context',
    test: /(note|notes|comment|description|summary|about|bio|context|background|history|activity|last (touch|contact|meeting|call|email)|interest|pain point|research|detail)/,
    reason: 'Free text — useful as background for the model',
    confidence: 0.9,
  },
]

/** Longer free text is context, not something to paste into a sentence. */
const AI_CONTEXT_LENGTH = 60

function sample(rows: RawRow[], header: string, limit = 3): string[] {
  const out: string[] = []
  for (const row of rows) {
    const value = row[header]?.trim()
    if (value) out.push(value)
    if (out.length >= limit) break
  }
  return out
}

function averageLength(rows: RawRow[], header: string): number {
  let total = 0
  let count = 0
  for (const row of rows) {
    const value = row[header]?.trim()
    if (value) {
      total += value.length
      count += 1
    }
  }
  return count === 0 ? 0 : total / count
}

/** Share of non-empty values in this column that look like an address. */
function emailRatio(rows: RawRow[], header: string): number {
  let hits = 0
  let count = 0
  for (const row of rows) {
    const value = row[header]?.trim()
    if (!value) continue
    count += 1
    if (looksLikeEmail(value)) hits += 1
  }
  return count === 0 ? 0 : hits / count
}

function detectOne(header: string, rows: RawRow[]): DetectedColumn {
  const samples = sample(rows, header)
  const normalized = key(header)

  // Values beat the header. A column of addresses headed `Contact` is an email
  // column whatever it is called, and getting this wrong breaks the whole import.
  const ratio = emailRatio(rows, header)
  if (ratio >= 0.8) {
    return {
      header,
      role: 'email',
      samples,
      reason: `${Math.round(ratio * 100)}% of values are email addresses`,
      confidence: 1,
    }
  }

  for (const rule of RULES) {
    if (rule.test.test(normalized)) {
      // A header that says "email" over values that are not addresses is a
      // mislabelled column, not an address column.
      if (rule.role === 'email' && samples.length > 0 && ratio < 0.5) continue

      return {
        header,
        // `ai_context` needs a name too: the model refers to these fields by
        // name in the prompt, and the mapping UI shows it. Only `email` and
        // `ignore` have no variable.
        variable:
          rule.role === 'merge_var' || rule.role === 'ai_context'
            ? toVariableName(header)
            : undefined,
        role: rule.role,
        samples,
        reason: rule.reason,
        confidence: rule.confidence,
      }
    }
  }

  // No rule matched: fall back to value shape.
  if (averageLength(rows, header) > AI_CONTEXT_LENGTH) {
    return {
      header,
      role: 'ai_context',
      variable: toVariableName(header),
      samples,
      reason: 'Long free text — treated as background, not merged literally',
      confidence: 0.55,
    }
  }

  return {
    header,
    role: 'merge_var',
    variable: toVariableName(header),
    samples,
    reason: 'Unrecognised column — available as a merge variable',
    confidence: 0.4,
  }
}

/**
 * Classify every column.
 *
 * Exactly one column ends up as `email`: if the heuristics pick more than one,
 * the highest-confidence wins and the rest become merge variables. Two email
 * columns would make the dedupe key ambiguous.
 */
export function detectColumns(headers: string[], rows: RawRow[]): DetectedColumn[] {
  const detected = headers.map((header) => detectOne(header, rows))

  const emailColumns = detected
    .map((column, index) => ({ column, index }))
    .filter(({ column }) => column.role === 'email')

  if (emailColumns.length > 1) {
    const best = emailColumns.reduce((a, b) => (b.column.confidence > a.column.confidence ? b : a))
    for (const { column, index } of emailColumns) {
      if (index === best.index) continue
      detected[index] = {
        ...column,
        role: 'merge_var',
        variable: toVariableName(column.header),
        reason: `Another column (${detected[best.index].header}) is a better match for the address`,
        confidence: 0.5,
      }
    }
  }

  return uniqueVariableNames(detected)
}

/** The detected address column, if the heuristics found one. */
export function findEmailColumn(columns: DetectedColumn[]): string | null {
  return columns.find((column) => column.role === 'email')?.header ?? null
}
