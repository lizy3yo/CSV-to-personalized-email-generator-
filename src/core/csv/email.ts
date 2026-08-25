/**
 * Email normalisation and validation.
 *
 * Deliberately not a full RFC 5322 implementation. RFC 5322 permits quoted
 * local parts, comments and nested groups that no mail provider accepts in
 * practice; a validator that allows them lets typos through, which for this
 * app means a bounce and a hit to sending reputation. This is the pragmatic
 * subset every provider actually accepts.
 */

/** RFC 5321 limits. */
const MAX_TOTAL = 254
const MAX_LOCAL = 64
const MAX_LABEL = 63

/**
 * Normalise for comparison.
 *
 * Lowercased and trimmed, because dedupe and the suppression list must both
 * treat `Ana@X.com` and `ana@x.com` as the same person. Collation is never
 * relied on for this — the value is normalised before it reaches the database.
 *
 * Gmail dot-and-plus normalisation is deliberately NOT applied: it is a Gmail
 * convention, and silently merging `a.b@gmail.com` with `ab@gmail.com` would
 * drop a contact the user believes they imported.
 */
export function normalizeEmail(input: string): string {
  return stripControl(input).trim().toLowerCase()
}

/**
 * Strip control characters and zero-width marks.
 *
 * Both turn up routinely in spreadsheet exports and in addresses pasted out
 * of web pages. A zero-width space inside an address is invisible in the UI
 * but makes the value unequal to the same address typed by hand, which would
 * silently defeat both dedupe and the suppression list.
 *
 * Tab (09), newline (0A) and carriage return (0D) are kept: they are legal
 * inside a quoted CSV field, and trimming deals with them.
 */
export function stripControl(input: string): string {
  let out = ''
  for (const ch of input) {
    const code = ch.codePointAt(0) ?? 0
    const isWhitespace = code === 0x09 || code === 0x0a || code === 0x0d
    const isControl = (code < 0x20 && !isWhitespace) || code === 0x7f
    const isZeroWidth = code === 0x200b || code === 0x200c || code === 0x200d || code === 0xfeff
    if (!isControl && !isZeroWidth) out += ch
  }
  return out
}

export interface EmailValidation {
  valid: boolean
  reason?: string
}

export function validateEmail(input: string): EmailValidation {
  const email = normalizeEmail(input)

  if (!email) return { valid: false, reason: 'Empty' }
  if (email.length > MAX_TOTAL)
    return { valid: false, reason: `Longer than ${MAX_TOTAL} characters` }
  if (/\s/.test(email)) return { valid: false, reason: 'Contains a space' }

  const at = email.lastIndexOf('@')
  if (at === -1) return { valid: false, reason: 'No @ sign' }
  if (email.indexOf('@') !== at) return { valid: false, reason: 'More than one @ sign' }

  const local = email.slice(0, at)
  const domain = email.slice(at + 1)

  if (!local) return { valid: false, reason: 'Nothing before the @' }
  if (local.length > MAX_LOCAL) return { valid: false, reason: 'Part before @ is too long' }
  if (local.startsWith('.') || local.endsWith('.')) {
    return { valid: false, reason: 'Part before @ starts or ends with a dot' }
  }
  if (local.includes('..')) return { valid: false, reason: 'Consecutive dots before the @' }
  if (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local)) {
    return { valid: false, reason: 'Invalid character before the @' }
  }

  if (!domain) return { valid: false, reason: 'Nothing after the @' }
  if (domain.startsWith('.') || domain.endsWith('.')) {
    return { valid: false, reason: 'Domain starts or ends with a dot' }
  }
  if (domain.includes('..')) return { valid: false, reason: 'Consecutive dots in the domain' }

  const labels = domain.split('.')
  if (labels.length < 2) return { valid: false, reason: 'Domain has no dot' }

  for (const label of labels) {
    if (!label) return { valid: false, reason: 'Empty part in the domain' }
    if (label.length > MAX_LABEL) return { valid: false, reason: 'Domain part is too long' }
    if (label.startsWith('-') || label.endsWith('-')) {
      return { valid: false, reason: 'Domain part starts or ends with a hyphen' }
    }
    if (!/^[a-z0-9-]+$/.test(label))
      return { valid: false, reason: 'Invalid character in the domain' }
  }

  const tld = labels[labels.length - 1]
  if (!/^[a-z]{2,}$/.test(tld)) {
    return { valid: false, reason: 'Top-level domain must be at least two letters' }
  }

  return { valid: true }
}

export function isValidEmail(input: string): boolean {
  return validateEmail(input).valid
}

/**
 * Does this value look like an email?
 *
 * Used only for column detection, where a loose check is correct: the goal is
 * to guess which column holds addresses, not to decide whether one is
 * deliverable.
 */
export function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(value.trim())
}
