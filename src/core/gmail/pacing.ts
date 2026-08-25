/**
 * When may the next email go out?
 *
 * Three independent limits, all of which must allow the send:
 *
 *   quota    Gmail's own cap — 500 recipients/day on a consumer account,
 *            2,000 on Workspace. It is a ROLLING 24-hour window, not a
 *            midnight reset, and exceeding it risks a temporary sending
 *            suspension on the account.
 *
 *   rate     The user's per-hour throttle, defaulting well under the cap.
 *            Sending 500 emails in ten minutes looks like a script; sending
 *            them over a day looks like a person.
 *
 *   window   Business hours and days. An outreach email arriving at 03:00
 *            reads as automated whatever it says.
 *
 * Pure and time-injected, so every branch is testable without waiting.
 */

export type BlockReason = 'quota' | 'rate' | 'window'

export interface PacingDecision {
  allowed: boolean
  reason?: BlockReason
  /** When to try again. Absent when allowed. */
  retryAt?: Date
  /** Human explanation, shown in the UI. */
  message?: string
}

export interface PacingInput {
  now: Date
  /** Timestamps of sends already made on this account, newest first or any order. */
  recentSends: Date[]
  /** Gmail's cap for this account type. */
  dailyLimit: number
  ratePerHour: number
  /** Local hour the window opens, inclusive. */
  windowStartHour: number
  /** Local hour the window closes, exclusive. */
  windowEndHour: number
  /** ISO weekday numbers, 1 = Monday .. 7 = Sunday. */
  windowDays: number[]
  /** Skip the business-hours check entirely. */
  ignoreWindow?: boolean
}

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

/** JS `getDay()` is 0=Sunday; ISO is 1=Monday..7=Sunday. */
export function isoWeekday(date: Date): number {
  const day = date.getDay()
  return day === 0 ? 7 : day
}

/** Sends within the last 24 hours — the window Gmail actually enforces. */
export function countInLast24h(sends: Date[], now: Date): number {
  const cutoff = now.getTime() - DAY_MS
  return sends.filter((sent) => sent.getTime() > cutoff).length
}

export function countInLastHour(sends: Date[], now: Date): number {
  const cutoff = now.getTime() - HOUR_MS
  return sends.filter((sent) => sent.getTime() > cutoff).length
}

/**
 * The next moment inside the sending window.
 *
 * Walks forward day by day rather than doing arithmetic, because "next
 * Tuesday at 09:00 unless Monday is also allowed" is easy to get subtly wrong
 * and cheap to compute directly. Bounded at 14 days.
 */
export function nextWindowOpening(
  now: Date,
  startHour: number,
  endHour: number,
  days: number[],
): Date {
  // No allowed day means there is no next opening. Returning `now` would make
  // the caller reschedule immediately and spin — so this reports the same
  // far-future time as the unschedulable case below.
  if (days.length === 0) return new Date(now.getTime() + 14 * DAY_MS)

  const candidate = new Date(now)

  // Today, later on: the window has not opened yet.
  if (days.includes(isoWeekday(candidate)) && candidate.getHours() < startHour) {
    candidate.setHours(startHour, 0, 0, 0)
    return candidate
  }

  for (let offset = 1; offset <= 14; offset++) {
    const day = new Date(now)
    day.setDate(day.getDate() + offset)
    day.setHours(startHour, 0, 0, 0)
    if (days.includes(isoWeekday(day))) return day
  }

  // No allowed day within a fortnight — treat as unschedulable rather than
  // looping forever.
  return new Date(now.getTime() + 14 * DAY_MS)
}

export function isInsideWindow(
  now: Date,
  startHour: number,
  endHour: number,
  days: number[],
): boolean {
  if (!days.includes(isoWeekday(now))) return false
  const hour = now.getHours()
  return hour >= startHour && hour < endHour
}

export function canSendNow(input: PacingInput): PacingDecision {
  const {
    now,
    recentSends,
    dailyLimit,
    ratePerHour,
    windowStartHour,
    windowEndHour,
    windowDays,
    ignoreWindow = false,
  } = input

  // Quota first: it is the limit with real consequences for the account.
  const inDay = countInLast24h(recentSends, now)
  if (inDay >= dailyLimit) {
    // The window frees up when the OLDEST send in it ages past 24 hours.
    const sorted = [...recentSends].sort((a, b) => a.getTime() - b.getTime())
    const oldestInWindow = sorted.find((sent) => sent.getTime() > now.getTime() - DAY_MS)
    const retryAt = oldestInWindow
      ? new Date(oldestInWindow.getTime() + DAY_MS + 1000)
      : new Date(now.getTime() + HOUR_MS)

    return {
      allowed: false,
      reason: 'quota',
      retryAt,
      message: `Gmail's ${dailyLimit}/day limit is reached. Sending resumes as the rolling window clears.`,
    }
  }

  const inHour = countInLastHour(recentSends, now)
  if (ratePerHour > 0 && inHour >= ratePerHour) {
    const sorted = [...recentSends].sort((a, b) => a.getTime() - b.getTime())
    const oldestInHour = sorted.find((sent) => sent.getTime() > now.getTime() - HOUR_MS)
    const retryAt = oldestInHour
      ? new Date(oldestInHour.getTime() + HOUR_MS + 1000)
      : new Date(now.getTime() + 60_000)

    return {
      allowed: false,
      reason: 'rate',
      retryAt,
      message: `Throttled to ${ratePerHour}/hour to protect your sending reputation.`,
    }
  }

  if (!ignoreWindow && !isInsideWindow(now, windowStartHour, windowEndHour, windowDays)) {
    return {
      allowed: false,
      reason: 'window',
      retryAt: nextWindowOpening(now, windowStartHour, windowEndHour, windowDays),
      message: 'Outside the sending window.',
    }
  }

  return { allowed: true }
}

/**
 * How long a campaign will take, given the limits.
 *
 * Shown in the preflight, because "1,240 emails at 500/day" being three days
 * is the kind of thing to learn before pressing send rather than after.
 */
export function estimateDuration(
  remaining: number,
  ratePerHour: number,
  dailyLimit: number,
  windowHoursPerDay: number,
): { hours: number; days: number; perDay: number } {
  if (remaining <= 0) return { hours: 0, days: 0, perDay: 0 }

  const byRate = ratePerHour > 0 ? ratePerHour * Math.max(1, windowHoursPerDay) : dailyLimit
  const perDay = Math.max(1, Math.min(byRate, dailyLimit))
  const days = remaining / perDay

  return {
    perDay,
    days: Math.ceil(days),
    hours: ratePerHour > 0 ? Math.ceil(remaining / ratePerHour) : 0,
  }
}
