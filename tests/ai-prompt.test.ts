import { describe, expect, it } from 'vitest'
import { buildSystemPrompt, buildUserPrompt } from '@/core/ai/prompt'
import type { SlotConfig } from '@/core/ai/types'

const BODY = 'Hi {{first_name}},\n\n{{ai:opening}}\n\nWorth a call?\n\n— Sam'
const slot: SlotConfig = { name: 'opening', brief: 'Reference their last touch.', maxSentences: 2 }
const fields = ['first_name', 'company', 'notes']

describe('buildSystemPrompt', () => {
  const system = buildSystemPrompt({ bodyTemplate: BODY, slot, availableFields: fields })

  it('shows the model where its text will land', () => {
    expect(system).toContain('>>> WRITE YOUR PASSAGE HERE <<<')
    expect(system).toContain('Worth a call?')
    expect(system).not.toContain('{{ai:opening}}')
  })

  it('carries the brief and the sentence limit', () => {
    expect(system).toContain('Reference their last touch.')
    expect(system).toContain('at most 2 sentences')
  })

  it('always forbids inventing facts', () => {
    expect(system).toContain('Never invent')
  })

  it('is byte-identical for every row — that is what makes it cacheable', () => {
    // Any row-specific content here would invalidate the cache on every call,
    // which is the single most expensive mistake available in this file.
    const a = buildSystemPrompt({ bodyTemplate: BODY, slot, availableFields: fields })
    const b = buildSystemPrompt({ bodyTemplate: BODY, slot, availableFields: fields })
    expect(a).toBe(b)
    expect(a).not.toContain('Ana')
    expect(a).not.toContain('Northwind')
  })

  it('adds only the guardrails that are enabled', () => {
    expect(system).not.toContain('em-dash')
    const strict = buildSystemPrompt({
      bodyTemplate: BODY,
      slot,
      availableFields: fields,
      guardrails: ['no_em_dash', 'no_superlatives'],
    })
    expect(strict).toContain('em-dashes')
    expect(strict).toContain('revolutionary')
  })

  it('includes the tone when given, and omits the section when not', () => {
    expect(system).not.toContain('<tone>')
    expect(
      buildSystemPrompt({
        bodyTemplate: BODY,
        slot,
        availableFields: fields,
        tone: 'warm but professional',
      }),
    ).toContain('warm but professional')
  })

  it('names the fields the model can expect', () => {
    expect(system).toContain('first_name, company, notes')
  })

  it('handles a template with no fields at all', () => {
    const bare = buildSystemPrompt({ bodyTemplate: BODY, slot, availableFields: [] })
    expect(bare).toContain('Keep the passage general')
  })

  it('omits the sentence limit when the slot has none', () => {
    const unlimited = buildSystemPrompt({
      bodyTemplate: BODY,
      slot: { name: 'opening', brief: 'Anything.' },
      availableFields: fields,
    })
    expect(unlimited).not.toContain('at most')
  })
})

describe('buildUserPrompt', () => {
  it('carries only this row, which is the volatile half of the prompt', () => {
    const user = buildUserPrompt({ first_name: 'Ana', company: 'Northwind Traders' })
    expect(user).toContain('first_name: Ana')
    expect(user).toContain('company: Northwind Traders')
  })

  it('omits empty fields rather than sending blanks', () => {
    // `company: ` invites the model to work around a gap it should simply not
    // know exists.
    const user = buildUserPrompt({ first_name: 'Ana', company: '   ', notes: '' })
    expect(user).toContain('first_name: Ana')
    expect(user).not.toContain('company')
    expect(user).not.toContain('notes')
  })

  it('handles a row with nothing usable', () => {
    expect(buildUserPrompt({})).toContain('no details available')
  })

  it('differs per row — the part that must not be cached', () => {
    expect(buildUserPrompt({ first_name: 'Ana' })).not.toBe(buildUserPrompt({ first_name: 'Bo' }))
  })
})
