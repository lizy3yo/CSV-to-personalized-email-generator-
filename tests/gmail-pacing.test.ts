import { describe, expect, it } from 'vitest'
import {
  canSendNow,
  countInLast24h,
  countInLastHour,
  estimateDuration,
  isInsideWindow,
  isoWeekday,
  nextWindowOpening,
} from '@/core/gmail/pacing'

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

/** A Tuesday at 11:00 local — inside a Mon–Fri 09:00–17:00 window. */
const TUESDAY_11AM = new Date(2026, 7, 25, 11, 0, 0)

const BASE = {
  now: TUESDAY_11AM,
  recentSends: [] as Date[],
  dailyLimit: 500,
  ratePerHour: 40,
  windowStartHour: 9,
  windowEndHour: 17,
  windowDays: [1, 2, 3, 4, 5],
}

const ago = (ms: number, from = TUESDAY_11AM) => new Date(from.getTime() - ms)

describe('isoWeekday', () => {
  it('maps Sunday to 7, not 0', () => {
    expect(isoWeekday(new Date(2026, 7, 23))).toBe(7) // Sunday
    expect(isoWeekday(new Date(2026, 7, 24))).toBe(1) // Monday
    expect(isoWeekday(TUESDAY_11AM)).toBe(2)
  })
})

describe('rolling counts', () => {
  it('counts only the last 24 hours', () => {
    // Gmail's limit is a rolling window, not a midnight reset — counting by
    // calendar day would let a burst through just after midnight.
    const sends = [ago(1 * HOUR), ago(23 * HOUR), ago(25 * HOUR), ago(48 * HOUR)]
    expect(countInLast24h(sends, TUESDAY_11AM)).toBe(2)
  })

  it('counts only the last hour', () => {
    expect(countInLastHour([ago(10 * 60_000), ago(90 * 60_000)], TUESDAY_11AM)).toBe(1)
  })

  it('is zero for no sends', () => {
    expect(countInLast24h([], TUESDAY_11AM)).toBe(0)
  })
})

describe('isInsideWindow', () => {
  it('allows a weekday inside the hours', () => {
    expect(isInsideWindow(TUESDAY_11AM, 9, 17, [1, 2, 3, 4, 5])).toBe(true)
  })

  it('rejects before the window opens and at or after it closes', () => {
    expect(isInsideWindow(new Date(2026, 7, 25, 8, 59), 9, 17, [1, 2, 3, 4, 5])).toBe(false)
    expect(isInsideWindow(new Date(2026, 7, 25, 17, 0), 9, 17, [1, 2, 3, 4, 5])).toBe(false)
    expect(isInsideWindow(new Date(2026, 7, 25, 16, 59), 9, 17, [1, 2, 3, 4, 5])).toBe(true)
  })

  it('rejects a day not in the list', () => {
    // Saturday.
    expect(isInsideWindow(new Date(2026, 7, 29, 11, 0), 9, 17, [1, 2, 3, 4, 5])).toBe(false)
  })
})

describe('nextWindowOpening', () => {
  it('returns later today when the window has not opened yet', () => {
    const opening = nextWindowOpening(new Date(2026, 7, 25, 7, 30), 9, 17, [1, 2, 3, 4, 5])
    expect(opening.getDate()).toBe(25)
    expect(opening.getHours()).toBe(9)
  })

  it('rolls to tomorrow once the window has closed', () => {
    const opening = nextWindowOpening(new Date(2026, 7, 25, 18, 0), 9, 17, [1, 2, 3, 4, 5])
    expect(opening.getDate()).toBe(26)
    expect(opening.getHours()).toBe(9)
  })

  it('skips the weekend', () => {
    // Friday evening → Monday morning.
    const opening = nextWindowOpening(new Date(2026, 7, 28, 18, 0), 9, 17, [1, 2, 3, 4, 5])
    expect(isoWeekday(opening)).toBe(1)
    expect(opening.getDate()).toBe(31)
  })

  it('handles a single allowed day', () => {
    const opening = nextWindowOpening(TUESDAY_11AM, 9, 17, [3])
    expect(isoWeekday(opening)).toBe(3)
  })

  it('reports a far-future time when no day is allowed, never now', () => {
    // Returning `now` would make the dispatcher reschedule immediately and
    // spin, re-enqueuing itself thousands of times a second.
    const opening = nextWindowOpening(TUESDAY_11AM, 9, 17, [])
    expect(opening.getTime()).toBeGreaterThan(TUESDAY_11AM.getTime() + 13 * DAY)
  })
})

describe('canSendNow', () => {
  it('allows a send inside every limit', () => {
    expect(canSendNow(BASE)).toEqual({ allowed: true })
  })

  it('blocks on the daily quota and says when it clears', () => {
    // The window frees up as the OLDEST send in it ages past 24 hours.
    const oldest = ago(23 * HOUR)
    const decision = canSendNow({
      ...BASE,
      dailyLimit: 2,
      recentSends: [oldest, ago(2 * HOUR)],
    })
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toBe('quota')
    expect(decision.retryAt!.getTime()).toBeGreaterThan(oldest.getTime() + DAY)
    expect(decision.message).toContain('2/day')
  })

  it('checks quota before rate, because quota has real consequences', () => {
    // Both limits are breached; the report names the one that matters.
    const decision = canSendNow({
      ...BASE,
      dailyLimit: 1,
      ratePerHour: 1,
      recentSends: [ago(5 * 60_000), ago(10 * 60_000)],
    })
    expect(decision.reason).toBe('quota')
  })

  it('blocks on the hourly throttle and says when it clears', () => {
    const oldest = ago(50 * 60_000)
    const decision = canSendNow({
      ...BASE,
      ratePerHour: 2,
      recentSends: [oldest, ago(10 * 60_000)],
    })
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toBe('rate')
    expect(decision.retryAt!.getTime()).toBeGreaterThan(oldest.getTime() + HOUR)
  })

  it('ignores sends older than the hour when throttling', () => {
    expect(
      canSendNow({ ...BASE, ratePerHour: 2, recentSends: [ago(2 * HOUR), ago(3 * HOUR)] }),
    ).toEqual({ allowed: true })
  })

  it('treats a rate of zero as unthrottled', () => {
    expect(
      canSendNow({ ...BASE, ratePerHour: 0, recentSends: Array(50).fill(ago(60_000)) }).allowed,
    ).toBe(true)
  })

  it('blocks outside the sending window and names the next opening', () => {
    const saturday = new Date(2026, 7, 29, 11, 0)
    const decision = canSendNow({ ...BASE, now: saturday })
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toBe('window')
    expect(isoWeekday(decision.retryAt!)).toBe(1)
  })

  it('can be told to ignore the window', () => {
    const saturday = new Date(2026, 7, 29, 11, 0)
    expect(canSendNow({ ...BASE, now: saturday, ignoreWindow: true })).toEqual({ allowed: true })
  })

  it('still enforces quota when the window is ignored', () => {
    // Ignoring business hours must not become a way to bypass Gmail's cap.
    const decision = canSendNow({
      ...BASE,
      now: new Date(2026, 7, 29, 3, 0),
      ignoreWindow: true,
      dailyLimit: 1,
      recentSends: [ago(1 * HOUR, new Date(2026, 7, 29, 3, 0))],
    })
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toBe('quota')
  })
})

describe('estimateDuration', () => {
  it('reports the multi-day reality of a large campaign at Gmail limits', () => {
    // 1,240 emails at 500/day is three days — worth knowing before pressing
    // send, not after.
    const estimate = estimateDuration(1240, 0, 500, 8)
    expect(estimate.perDay).toBe(500)
    expect(estimate.days).toBe(3)
  })

  it('uses the hourly throttle when it is the tighter limit', () => {
    const estimate = estimateDuration(1000, 40, 500, 8)
    expect(estimate.perDay).toBe(320) // 40/hour across an 8-hour window
    expect(estimate.hours).toBe(25)
  })

  it('never exceeds the daily cap', () => {
    expect(estimateDuration(10_000, 1000, 500, 8).perDay).toBe(500)
  })

  it('is zero for nothing to send', () => {
    expect(estimateDuration(0, 40, 500, 8)).toEqual({ hours: 0, days: 0, perDay: 0 })
  })
})
