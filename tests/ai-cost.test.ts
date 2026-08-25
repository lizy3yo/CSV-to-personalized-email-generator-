import { describe, expect, it } from 'vitest'
import { approximateTokens, costOf, estimate, formatUsd } from '@/core/ai/cost'
import { MODELS } from '@/core/ai/models'

describe('costOf', () => {
  it('prices plain input and output at the model rate', () => {
    // Haiku 4.5: $1/MTok in, $5/MTok out.
    const cost = costOf('claude-haiku-4-5', { input_tokens: 1_000_000, output_tokens: 0 })
    expect(cost.costUsd).toBeCloseTo(1, 6)

    const out = costOf('claude-haiku-4-5', { input_tokens: 0, output_tokens: 1_000_000 })
    expect(out.costUsd).toBeCloseTo(5, 6)
  })

  it('charges cache writes at 1.25x input', () => {
    const cost = costOf('claude-haiku-4-5', {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 1_000_000,
    })
    expect(cost.costUsd).toBeCloseTo(1.25, 6)
  })

  it('charges cache reads at 0.1x input — the whole point of caching', () => {
    const cost = costOf('claude-haiku-4-5', {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 1_000_000,
    })
    expect(cost.costUsd).toBeCloseTo(0.1, 6)
  })

  it('treats cached tokens as additional to input_tokens, not a subset', () => {
    // The API reports them separately; double-counting or omitting either one
    // would make the meter quietly wrong.
    const cost = costOf('claude-haiku-4-5', {
      input_tokens: 1_000_000,
      output_tokens: 0,
      cache_read_input_tokens: 1_000_000,
    })
    expect(cost.costUsd).toBeCloseTo(1.1, 6)
  })

  it('halves everything under the Batch API', () => {
    const normal = costOf('claude-haiku-4-5', { input_tokens: 1000, output_tokens: 500 })
    const batched = costOf('claude-haiku-4-5', { input_tokens: 1000, output_tokens: 500 }, true)
    expect(batched.costUsd).toBeCloseTo(normal.costUsd / 2, 10)
  })

  it('handles a missing usage field as zero', () => {
    expect(costOf('claude-haiku-4-5', { input_tokens: 0, output_tokens: 0 }).costUsd).toBe(0)
  })

  it('falls back to the default model for an unknown id', () => {
    const unknown = costOf('some-future-model', { input_tokens: 1_000_000, output_tokens: 0 })
    expect(unknown.costUsd).toBeCloseTo(MODELS['claude-haiku-4-5'].inputPerMTok, 6)
  })

  it('prices the tiers in the expected order', () => {
    const usage = { input_tokens: 100_000, output_tokens: 50_000 }
    const haiku = costOf('claude-haiku-4-5', usage).costUsd
    const sonnet = costOf('claude-sonnet-5', usage).costUsd
    const opus = costOf('claude-opus-5', usage).costUsd
    expect(haiku).toBeLessThan(sonnet)
    expect(sonnet).toBeLessThan(opus)
  })
})

describe('estimate', () => {
  const base = {
    model: 'claude-haiku-4-5' as const,
    rows: 1000,
    systemTokens: 1500,
    perRowInputTokens: 200,
    perRowOutputTokens: 250,
  }

  it('lands around a dollar per thousand emails on Haiku with caching', () => {
    // The number quoted throughout the spec — worth pinning so it cannot drift
    // silently.
    const result = estimate(base)
    expect(result.calls).toBe(1000)
    expect(result.costUsd).toBeGreaterThan(1.4)
    expect(result.costUsd).toBeLessThan(1.7)
  })

  it('caching is cheaper than not caching', () => {
    const withCache = estimate(base).costUsd
    const without = estimate({ ...base, useCaching: false }).costUsd
    expect(withCache).toBeLessThan(without)
  })

  it('reports the unoptimised cost for comparison', () => {
    const result = estimate(base)
    expect(result.costWithoutOptimisationsUsd).toBeGreaterThan(result.costUsd)
  })

  it('batching roughly halves it', () => {
    const normal = estimate(base).costUsd
    const batched = estimate({ ...base, useBatch: true }).costUsd
    expect(batched).toBeCloseTo(normal / 2, 6)
  })

  it('charges the cache write exactly once, however many rows', () => {
    const one = estimate({ ...base, rows: 1 })
    const two = estimate({ ...base, rows: 2 })
    // Row two reads the cache rather than writing it again, so the increment
    // is much smaller than the first row's total.
    expect(two.costUsd - one.costUsd).toBeLessThan(one.costUsd)
  })

  it('multiplies by slots per row', () => {
    const one = estimate(base)
    const two = estimate({ ...base, slotsPerRow: 2 })
    expect(two.calls).toBe(2000)
    expect(two.costUsd).toBeGreaterThan(one.costUsd)
  })

  it('costs nothing for no rows', () => {
    expect(estimate({ ...base, rows: 0 })).toEqual({
      calls: 0,
      costUsd: 0,
      costWithoutOptimisationsUsd: 0,
      cachingApplies: false,
    })
  })
})

describe('formatUsd', () => {
  it('keeps decimals on sub-cent amounts rather than showing $0.00', () => {
    expect(formatUsd(0.0009)).toBe('$0.0009')
    expect(formatUsd(0.004)).toBe('$0.0040')
  })

  it('formats larger amounts conventionally', () => {
    expect(formatUsd(0.5)).toBe('$0.500')
    expect(formatUsd(12.5)).toBe('$12.50')
    expect(formatUsd(0)).toBe('$0.00')
  })
})

describe('approximateTokens', () => {
  it('is a rough sizing aid, not a billing figure', () => {
    expect(approximateTokens('')).toBe(0)
    expect(approximateTokens('a'.repeat(400))).toBe(100)
  })
})
