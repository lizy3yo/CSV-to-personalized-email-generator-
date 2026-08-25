import { describe, expect, it } from 'vitest'
import {
  clean,
  countSentences,
  hasBlockingViolation,
  process,
  suspectProperNouns,
  validate,
} from '@/core/ai/guardrails'
import type { SlotConfig } from '@/core/ai/types'

const slot: SlotConfig = { name: 'opening', brief: 'Reference their last touch.', maxSentences: 2 }
const data = { first_name: 'Ana', company: 'Northwind Traders', notes: 'Asked about SSO pricing' }

const kinds = (text: string, guardrails: Parameters<typeof validate>[0]['guardrails'] = []) =>
  validate({ text, slot, guardrails, data }).map((v) => v.kind)

describe('clean', () => {
  it('strips wrapping quotes, which models add habitually', () => {
    expect(clean('"Since you asked about SSO, we shipped SCIM."')).toBe(
      'Since you asked about SSO, we shipped SCIM.',
    )
    expect(clean('“Smart quotes too.”')).toBe('Smart quotes too.')
  })

  it('strips a greeting the template already provides', () => {
    expect(clean('Hi Ana, since you asked about SSO we shipped SCIM.')).toBe(
      'since you asked about SSO we shipped SCIM.',
    )
    expect(clean('Hello there — we shipped SCIM.')).toBe('we shipped SCIM.')
  })

  it('strips a sign-off the template already provides', () => {
    expect(clean('We shipped SCIM.\n\nBest,\nSam')).toBe('We shipped SCIM.')
    expect(clean('We shipped SCIM.\n\n— Sam')).toBe('We shipped SCIM.')
    expect(clean('We shipped SCIM.\n\nThanks')).toBe('We shipped SCIM.')
  })

  it('collapses stray blank lines', () => {
    expect(clean('One.\n\n\n\nTwo.')).toBe('One.\n\nTwo.')
  })

  it('leaves a clean passage untouched', () => {
    const good = 'Since you asked about SSO pricing in July, we have shipped SCIM.'
    expect(clean(good)).toBe(good)
  })

  it('does not mangle a legitimate mid-sentence "hi"', () => {
    const text = 'They said hi at the conference, which is where this started.'
    expect(clean(text)).toBe(text)
  })
})

describe('countSentences', () => {
  it('counts terminated sentences', () => {
    expect(countSentences('One. Two. Three.')).toBe(3)
    expect(countSentences('Really? Yes! Good.')).toBe(3)
  })

  it('counts unterminated text as one sentence', () => {
    expect(countSentences('No full stop here')).toBe(1)
  })

  it('counts a trailing fragment', () => {
    expect(countSentences('One. And a trailing bit')).toBe(2)
  })

  it('is zero for empty input', () => {
    expect(countSentences('   ')).toBe(0)
  })
})

describe('validate', () => {
  it('passes a good passage', () => {
    expect(kinds('Since you asked about SSO pricing, we have shipped SCIM.')).toEqual([])
  })

  it('errors on empty output, and reports nothing else', () => {
    const violations = validate({ text: '   ', slot, data })
    expect(violations).toHaveLength(1)
    expect(violations[0].kind).toBe('empty')
    expect(hasBlockingViolation(violations)).toBe(true)
  })

  it('errors on template syntax, which would be sent literally', () => {
    const violations = validate({ text: 'Hello {{first_name}}, welcome.', slot, data })
    expect(violations.map((v) => v.kind)).toContain('contains_template_syntax')
    expect(hasBlockingViolation(violations)).toBe(true)
  })

  it('errors on an essay', () => {
    expect(kinds('x'.repeat(2000))).toContain('too_long')
  })

  it('warns when over the sentence limit', () => {
    expect(kinds('One. Two. Three.')).toContain('too_many_sentences')
  })

  it('warns about a greeting or sign-off that survived cleaning', () => {
    expect(kinds('Hi Ana, this is a passage.')).toContain('contains_greeting')
    expect(kinds('A passage.\n\nBest,\nSam')).toContain('contains_signoff')
  })

  it('only applies style guardrails that are switched on', () => {
    expect(kinds('A passage — with an em-dash.')).not.toContain('em_dash')
    expect(kinds('A passage — with an em-dash.', ['no_em_dash'])).toContain('em_dash')

    expect(kinds('Great news!')).not.toContain('exclamation')
    expect(kinds('Great news!', ['no_exclamation'])).toContain('exclamation')

    expect(kinds('Worth a chat?', ['no_questions'])).toContain('question')
    expect(kinds('A game-changing platform.', ['no_superlatives'])).toContain('superlative')
  })

  it('never blocks on a style guardrail — those are for a human to judge', () => {
    const violations = validate({
      text: 'A game-changing platform — really!',
      slot,
      guardrails: ['no_em_dash', 'no_exclamation', 'no_superlatives'],
      data,
    })
    expect(violations.length).toBeGreaterThan(0)
    expect(hasBlockingViolation(violations)).toBe(false)
  })
})

describe('suspectProperNouns — the hallucination check', () => {
  it('flags a company that is not in the row data', () => {
    // The worst thing this app could send is an invented fact about someone.
    expect(suspectProperNouns('I saw your work with Contoso recently.', data)).toContain('Contoso')
  })

  it('does not flag a name that IS in the row data', () => {
    expect(suspectProperNouns('Your team at Northwind Traders is growing.', data)).toEqual([])
  })

  it('ignores the first word of a sentence, capitalised by grammar', () => {
    expect(suspectProperNouns('Sadly there is no news. Perhaps next quarter.', data)).toEqual([])
  })

  it('ignores ordinary capitalised English', () => {
    expect(suspectProperNouns('We could talk Monday. I think AI helps here.', data)).toEqual([])
  })

  it('matches case-insensitively against the data', () => {
    expect(suspectProperNouns('Your work at NORTHWIND stands out.', data)).toEqual([])
  })

  it('is reported as a warning, not an error', () => {
    const violations = validate({ text: 'Your work with Contoso is great.', slot, data })
    const hallucination = violations.find((v) => v.kind === 'possible_hallucination')
    expect(hallucination?.severity).toBe('warning')
    expect(hallucination?.message).toContain('Contoso')
  })
})

describe('process', () => {
  it('cleans then validates, keeping the raw output for review', () => {
    const result = process('"Hi Ana, we shipped SCIM."', slot, [], data)
    expect(result.text).toBe('we shipped SCIM.')
    expect(result.raw).toBe('"Hi Ana, we shipped SCIM."')
    expect(result.slot).toBe('opening')
    // The greeting was removed by cleaning, so it is not also reported.
    expect(result.violations.map((v) => v.kind)).not.toContain('contains_greeting')
  })

  it('reports empty when the model returns only a greeting', () => {
    const result = process('Hi Ana,', slot, [], data)
    expect(result.text).toBe('')
    expect(hasBlockingViolation(result.violations)).toBe(true)
  })
})
