import { describe, expect, it } from 'vitest'
import { checkTemplate } from '@/core/template/validate'

const available = ['first_name', 'company', 'city']

function kinds(subject: string, body: string, vars = available) {
  return checkTemplate(subject, body, vars).warnings.map((w) => w.kind)
}

describe('checkTemplate', () => {
  it('passes a well-formed template', () => {
    const result = checkTemplate(
      'Quick question, {{company}}',
      'Hi {{first_name | default: there}},\n\nWe help teams like yours.\n\n— Sam',
      available,
    )
    expect(result.errors).toEqual([])
    expect(result.warnings).toEqual([])
    expect(result.variables.sort()).toEqual(['company', 'first_name'])
  })

  it('surfaces parse errors from both subject and body', () => {
    const result = checkTemplate('{{ 1bad }}', '{{#if x}}unclosed', available)
    expect(result.errors).toHaveLength(2)
  })

  it('warns about a variable the list does not provide', () => {
    const result = checkTemplate('Hi', '{{revenue}}', available)
    expect(result.warnings[0].kind).toBe('unknown_variable')
    expect(result.warnings[0].message).toContain('{{revenue}}')
  })

  it('does not warn about unknown variables when no list is chosen yet', () => {
    expect(checkTemplate('Hi', '{{anything}}', []).warnings).toEqual([])
  })

  it('warns when nothing is personalised', () => {
    expect(kinds('Newsletter', 'Same text for everyone.')).toContain('no_variables')
  })

  it('counts an AI slot as personalisation', () => {
    expect(kinds('Hi', '{{ai:opening}}')).not.toContain('no_variables')
  })

  it('warns about an empty subject', () => {
    expect(kinds('', 'Body {{first_name}}')).toContain('empty_subject')
  })

  it('warns about a subject clients will truncate', () => {
    expect(kinds('x'.repeat(90), '{{first_name}}')).toContain('long_subject')
  })

  it('catches the "Hi ," greeting and names the fix', () => {
    const result = checkTemplate('Hi', 'Hi {{first_name}},\n\nBody.', available)
    const warning = result.warnings.find((w) => w.kind === 'risky_greeting')
    expect(warning?.message).toContain('default: there')
  })

  it('does not flag a greeting that already has a fallback', () => {
    expect(kinds('Hi', 'Hi {{first_name | default: there}},\n\nBody.')).not.toContain(
      'risky_greeting',
    )
  })

  it('reports AI usage from slots', () => {
    expect(checkTemplate('Hi', '{{ai:opening}}', available).usesAi).toBe(true)
    expect(checkTemplate('Hi', '{{first_name}}', available).usesAi).toBe(false)
  })
})
