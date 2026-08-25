import { parse } from './parse'
import type { TemplateError } from './types'

/**
 * Template-level checks that the parser cannot make on its own, because they
 * depend on which columns the chosen contact list actually provides.
 *
 * The distinction that matters: a parse error means the template is broken.
 * A warning means it will render, but probably not the way the author expects
 * on every row — which is the failure mode that only shows up at row 900.
 */

export interface TemplateWarning {
  message: string
  /** `unknown_variable` is the one that silently produces `Hi ,`. */
  kind: 'unknown_variable' | 'no_variables' | 'empty_subject' | 'long_subject' | 'risky_greeting'
}

export interface TemplateCheck {
  errors: TemplateError[]
  warnings: TemplateWarning[]
  variables: string[]
  slots: string[]
  usesAi: boolean
}

/** Most clients truncate somewhere near here; mobile is tighter still. */
const SUBJECT_LIMIT = 78

/**
 * A greeting that ends in punctuation immediately after a variable, e.g.
 * `Hi {{first_name}},`. If the cell is empty the recipient reads `Hi ,`.
 * The fix is a `default`, so the warning names it.
 */
const RISKY_GREETING = /\{\{\s*([a-z_][a-z0-9_]*)\s*\}\}\s*[,.!?]/i

export function checkTemplate(
  subject: string,
  body: string,
  availableVariables: readonly string[] = [],
): TemplateCheck {
  const subjectParse = parse(subject)
  const bodyParse = parse(body)

  const errors = [...subjectParse.errors, ...bodyParse.errors]
  const warnings: TemplateWarning[] = []

  const variables = [...new Set([...subjectParse.variables, ...bodyParse.variables])]
  const slots = [...new Set([...subjectParse.slots, ...bodyParse.slots])]

  if (subject.trim() === '') {
    warnings.push({ kind: 'empty_subject', message: 'The subject is empty' })
  } else if (subject.length > SUBJECT_LIMIT) {
    warnings.push({
      kind: 'long_subject',
      message: `Subject is ${subject.length} characters — most clients truncate around ${SUBJECT_LIMIT}`,
    })
  }

  if (availableVariables.length > 0) {
    const available = new Set(availableVariables)
    for (const name of variables) {
      if (!available.has(name)) {
        warnings.push({
          kind: 'unknown_variable',
          message: `{{${name}}} is not a column in this list — it will render as nothing`,
        })
      }
    }
  }

  if (variables.length === 0 && slots.length === 0) {
    warnings.push({
      kind: 'no_variables',
      message: 'Nothing is personalised — every recipient gets an identical email',
    })
  }

  for (const source of [subject, body]) {
    const match = RISKY_GREETING.exec(source)
    if (match) {
      warnings.push({
        kind: 'risky_greeting',
        message: `If {{${match[1]}}} is empty this reads as "Hi ,". Add a fallback: {{ ${match[1]} | default: there }}`,
      })
      break
    }
  }

  return { errors, warnings, variables, slots, usesAi: slots.length > 0 }
}
