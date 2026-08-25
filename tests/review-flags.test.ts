import { describe, expect, it } from 'vitest'
import {
  canApprove,
  countBySeverity,
  hasBlockingFlag,
  isSendable,
  parseFlag,
  parseFlags,
  SENDABLE_STATUSES,
} from '@/core/review/flags'

describe('parseFlag', () => {
  it('reads an unresolved merge variable', () => {
    const flag = parseFlag('unresolved:first_name')
    expect(flag.severity).toBe('warning')
    expect(flag.label).toBe('{{first_name}} empty')
    expect(flag.detail).toContain('first_name')
  })

  it('reads an unfilled AI slot', () => {
    const flag = parseFlag('unfilled_slot:opening')
    expect(flag.severity).toBe('warning')
    expect(flag.label).toContain('opening')
  })

  it('reads a guardrail violation with its severity', () => {
    expect(parseFlag('error:empty').severity).toBe('error')
    expect(parseFlag('warning:em_dash').severity).toBe('warning')
    expect(parseFlag('warning:em_dash').label).toBe('Em-dash')
  })

  it('gives a readable label for an unknown kind rather than dropping it', () => {
    const flag = parseFlag('warning:some_future_check')
    expect(flag.label).toBe('some future check')
    expect(flag.severity).toBe('warning')
  })

  it('surfaces a completely unrecognised flag as a warning', () => {
    // A flag nobody can read is still a signal that something needs a look.
    const flag = parseFlag('totally-unknown')
    expect(flag.severity).toBe('warning')
    expect(flag.raw).toBe('totally-unknown')
  })

  it('parses a list', () => {
    expect(parseFlags(['unresolved:a', 'error:empty_body'])).toHaveLength(2)
  })
})

describe('severity split', () => {
  it('treats a broken email as an error', () => {
    // No human judgement makes an empty body or literal {{ }} sendable.
    expect(hasBlockingFlag(['error:empty_body'])).toBe(true)
    expect(hasBlockingFlag(['error:contains_template_syntax'])).toBe(true)
    expect(hasBlockingFlag(['error:empty_subject'])).toBe(true)
  })

  it('treats an odd-but-sendable email as a warning', () => {
    // These are contextual — that is what the human is there to judge.
    expect(hasBlockingFlag(['unresolved:company'])).toBe(false)
    expect(hasBlockingFlag(['warning:em_dash'])).toBe(false)
    expect(hasBlockingFlag(['warning:possible_hallucination'])).toBe(false)
    expect(hasBlockingFlag(['unfilled_slot:opening'])).toBe(false)
  })

  it('counts each severity', () => {
    expect(countBySeverity(['error:empty_body', 'warning:em_dash', 'unresolved:x'])).toEqual({
      errors: 1,
      warnings: 2,
    })
  })

  it('is clean for no flags', () => {
    expect(hasBlockingFlag([])).toBe(false)
    expect(countBySeverity([])).toEqual({ errors: 0, warnings: 0 })
  })
})

describe('canApprove', () => {
  it('allows a clean generated row', () => {
    expect(canApprove('generated', [])).toBe(true)
  })

  it('allows a row with only warnings — that is the point of review', () => {
    expect(canApprove('flagged', ['unresolved:company', 'warning:em_dash'])).toBe(true)
  })

  it('blocks a row with an error however many warnings accompany it', () => {
    expect(canApprove('flagged', ['warning:em_dash', 'error:empty_body'])).toBe(false)
  })

  it('blocks a rejected row', () => {
    expect(canApprove('rejected', [])).toBe(false)
  })

  it('blocks a row that has not finished generating', () => {
    expect(canApprove('pending', [])).toBe(false)
    expect(canApprove('generating', [])).toBe(false)
  })

  it('allows re-approving an approved row', () => {
    expect(canApprove('approved', [])).toBe(true)
  })
})

describe('the send gate', () => {
  it('permits exactly one status', () => {
    // The narrowness is the guarantee. Widening this list is how a review gate
    // stops being one.
    expect(SENDABLE_STATUSES).toEqual(['approved'])
  })

  it('refuses every other status', () => {
    for (const status of [
      'pending',
      'generating',
      'generated',
      'flagged',
      'rejected',
      'queued',
      'sending',
      'sent',
      'failed',
      'bounced',
      'complained',
    ]) {
      expect(isSendable(status), `${status} must not be sendable`).toBe(false)
    }
    expect(isSendable('approved')).toBe(true)
  })

  it('does not treat a merely generated email as ready to send', () => {
    // Generation finishing is not a decision. A human has to make one.
    expect(isSendable('generated')).toBe(false)
  })
})
