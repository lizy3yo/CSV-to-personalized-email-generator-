import { describe, expect, it } from 'vitest'
import { backoffMs } from '@/lib/queue'

describe('backoffMs', () => {
  // Deterministic "random" so the jitter can be reasoned about.
  const mid = () => 0.5
  const low = () => 0
  const high = () => 1

  it('grows exponentially', () => {
    const first = backoffMs(1, mid)
    const second = backoffMs(2, mid)
    const third = backoffMs(3, mid)
    expect(second).toBeGreaterThan(first)
    expect(third).toBeGreaterThan(second)
    expect(second / first).toBeCloseTo(2, 1)
  })

  it('applies jitter of 50–100% of the base delay', () => {
    // Without jitter, jobs that fail together retry together and hit a
    // struggling service in a synchronised wave.
    expect(backoffMs(3, low)).toBeLessThan(backoffMs(3, high))
    expect(backoffMs(3, low)).toBeCloseTo(backoffMs(3, high) / 2, -2)
  })

  it('caps at ten minutes however many attempts', () => {
    for (const attempts of [10, 50, 1000]) {
      expect(backoffMs(attempts, high)).toBeLessThanOrEqual(10 * 60 * 1000)
    }
  })

  it('never returns zero or negative', () => {
    for (let attempts = 0; attempts < 12; attempts++) {
      expect(backoffMs(attempts, low)).toBeGreaterThan(0)
    }
  })

  it('handles attempt 0 as if it were the first', () => {
    expect(backoffMs(0, mid)).toBe(backoffMs(1, mid))
  })
})
