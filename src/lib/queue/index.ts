/**
 * NOT marked `server-only`.
 *
 * That package throws unless a bundler selects its react-server condition, so
 * it breaks any plain Node process — including `npm run worker`, which imports
 * this module by design. The guard it offers is real but incompatible with
 * running the same code both inside Next.js and in a standalone worker.
 *
 * The convention that replaces it: `src/core/**` is safe to import anywhere,
 * `src/lib/**` is server-side only. A client component that imports this would
 * fail to bundle regardless, because it reaches the Postgres driver.
 */

import { and, eq, lt, sql } from 'drizzle-orm'
import { db } from '@/db'
import { jobs } from '@/db/schema'

/**
 * Durable job queue in Postgres.
 *
 * Claiming uses `SELECT ... FOR UPDATE SKIP LOCKED`, which is a correct queue
 * primitive: concurrent workers never hand the same row to two consumers, and
 * a slow consumer never blocks a fast one. No Redis, no extra service.
 *
 * The crash-safety story has two halves:
 *
 *   1. `attempts` is incremented AT CLAIM TIME, not on failure. A job that
 *      kills its worker every time still exhausts its retries and lands in
 *      `dead` rather than looping forever.
 *
 *   2. A worker that dies leaves its jobs in `claimed`. `reclaimStale` returns
 *      them to `pending` once the lease expires, so another worker — or the
 *      same one restarting — picks them up. This is what makes "close the
 *      laptop, reopen it, the campaign resumes" true.
 */

export type JobRow = typeof jobs.$inferSelect

/** How long a claim is honoured before another worker may take the job. */
export const LEASE_MS = 5 * 60 * 1000

const BACKOFF_BASE_MS = 5_000
const BACKOFF_MAX_MS = 10 * 60 * 1000

/**
 * Exponential backoff with jitter.
 *
 * The jitter matters: without it, a batch of jobs that fail together retry
 * together, and a struggling downstream service gets hit by a synchronised
 * wave every time.
 */
export function backoffMs(attempts: number, random: () => number = Math.random): number {
  const exponential = Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1), BACKOFF_MAX_MS)
  return Math.round(exponential * (0.5 + random() * 0.5))
}

export interface EnqueueInput {
  userId: string
  type: string
  payload?: Record<string, unknown>
  runAfter?: Date
  maxAttempts?: number
}

export async function enqueue(input: EnqueueInput): Promise<string> {
  const [row] = await db
    .insert(jobs)
    .values({
      userId: input.userId,
      type: input.type,
      payload: input.payload ?? {},
      runAfter: input.runAfter ?? new Date(),
      maxAttempts: input.maxAttempts ?? 5,
    })
    .returning({ id: jobs.id })
  return row.id
}

export async function enqueueMany(inputs: EnqueueInput[]): Promise<number> {
  if (inputs.length === 0) return 0
  const rows = await db
    .insert(jobs)
    .values(
      inputs.map((input) => ({
        userId: input.userId,
        type: input.type,
        payload: input.payload ?? {},
        runAfter: input.runAfter ?? new Date(),
        maxAttempts: input.maxAttempts ?? 5,
      })),
    )
    .returning({ id: jobs.id })
  return rows.length
}

/**
 * Claim up to `limit` due jobs for this worker.
 *
 * `SKIP LOCKED` is what makes this safe to run from several workers at once:
 * rows another transaction has locked are passed over rather than waited on.
 */
export async function claim(workerId: string, limit = 5): Promise<JobRow[]> {
  // Deliberately the query builder with `.returning()` rather than
  // `db.execute(sql\`... RETURNING *\`)`. A raw execute hands back the
  // database's snake_case columns, so `maxAttempts` would be `undefined` and
  // `fail()` would compare against it, never reach the limit, and retry a
  // doomed job forever. Only the sub-select needs raw SQL, for SKIP LOCKED.
  return db
    .update(jobs)
    .set({
      status: 'claimed',
      lockedBy: workerId,
      lockedAt: new Date(),
      attempts: sql`${jobs.attempts} + 1`,
    })
    .where(
      sql`${jobs.id} IN (
        SELECT id FROM ${jobs}
        WHERE status = 'pending' AND run_after <= now()
        ORDER BY run_after ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )`,
    )
    .returning()
}

export async function complete(jobId: string): Promise<void> {
  await db
    .update(jobs)
    .set({ status: 'done', completedAt: new Date(), lockedBy: null, lockedAt: null })
    .where(eq(jobs.id, jobId))
}

/**
 * Record a failure.
 *
 * Reschedules with backoff until `maxAttempts` is exhausted, then parks the
 * job in `dead` — where it stays visible with its last error, rather than
 * disappearing or retrying forever.
 */
export async function fail(job: JobRow, error: unknown): Promise<'retry' | 'dead'> {
  const message = error instanceof Error ? error.message : String(error)
  const exhausted = job.attempts >= job.maxAttempts

  await db
    .update(jobs)
    .set({
      status: exhausted ? 'dead' : 'pending',
      lastError: message.slice(0, 2000),
      lockedBy: null,
      lockedAt: null,
      runAfter: exhausted ? job.runAfter : new Date(Date.now() + backoffMs(job.attempts)),
      completedAt: exhausted ? new Date() : null,
    })
    .where(eq(jobs.id, job.id))

  return exhausted ? 'dead' : 'retry'
}

/**
 * Return jobs abandoned by a dead worker to the pending pool.
 *
 * Called on worker startup and periodically. This is the mechanism behind
 * resume-after-crash: nothing is lost, it is just waiting for its lease to
 * lapse.
 */
export async function reclaimStale(leaseMs = LEASE_MS): Promise<number> {
  const cutoff = new Date(Date.now() - leaseMs)
  const rows = await db
    .update(jobs)
    .set({ status: 'pending', lockedBy: null, lockedAt: null })
    .where(and(eq(jobs.status, 'claimed'), lt(jobs.lockedAt, cutoff)))
    .returning({ id: jobs.id })
  return rows.length
}

export interface QueueStats {
  pending: number
  claimed: number
  done: number
  dead: number
}

export async function stats(userId?: string): Promise<QueueStats> {
  const rows = await db
    .select({ status: jobs.status, count: sql<number>`count(*)::int` })
    .from(jobs)
    .where(userId ? eq(jobs.userId, userId) : undefined)
    .groupBy(jobs.status)

  const out: QueueStats = { pending: 0, claimed: 0, done: 0, dead: 0 }
  for (const row of rows) {
    if (row.status in out) out[row.status as keyof QueueStats] = row.count
  }
  return out
}

/** Remove finished jobs older than `olderThanDays`. Dead jobs are kept. */
export async function prune(olderThanDays = 7): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000)
  const rows = await db
    .delete(jobs)
    .where(and(eq(jobs.status, 'done'), lt(jobs.completedAt, cutoff)))
    .returning({ id: jobs.id })
  return rows.length
}
