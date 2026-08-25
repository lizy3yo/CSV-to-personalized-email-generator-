import { randomUUID } from 'node:crypto'
import { eq, sql } from 'drizzle-orm'
import postgres from 'postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { db } from '@/db'
import { jobs } from '@/db/schema'
import {
  claim,
  complete,
  enqueue,
  enqueueMany,
  fail,
  prune,
  reclaimStale,
  stats,
} from '@/lib/queue'

/**
 * The queue, against a real Postgres.
 *
 * These are the guarantees the whole design rests on, and none of them can be
 * demonstrated with a mock — `FOR UPDATE SKIP LOCKED` either behaves or it
 * does not, and only the database can say.
 */

const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL

async function probe(): Promise<boolean> {
  if (!url) return false
  const client = postgres(url, { max: 1, connect_timeout: 3, onnotice: () => {} })
  try {
    await client`select 1`
    return true
  } catch {
    return false
  } finally {
    await client.end({ timeout: 1 })
  }
}

const dbAvailable = await probe()

describe.skipIf(!dbAvailable)('job queue', () => {
  const raw = postgres(url!, { max: 4, onnotice: () => {} })
  const userId = randomUUID()

  beforeAll(async () => {
    await raw`
      INSERT INTO auth.users (id, instance_id, aud, role, email, created_at, updated_at)
      VALUES (${userId}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
              ${`queue-${userId.slice(0, 8)}@example.test`}, now(), now())
      ON CONFLICT (id) DO NOTHING
    `
  })

  afterAll(async () => {
    await raw`DELETE FROM auth.users WHERE id = ${userId}`
    await raw.end()
  })

  beforeEach(async () => {
    await db.delete(jobs).where(eq(jobs.userId, userId))
  })

  it('enqueues and claims a job', async () => {
    const id = await enqueue({ userId, type: 'test.echo', payload: { hello: 'world' } })
    const [claimed] = await claim('worker-a', 5)

    expect(claimed.id).toBe(id)
    expect(claimed.type).toBe('test.echo')
    expect(claimed.payload).toEqual({ hello: 'world' })
    expect(claimed.status).toBe('claimed')
    expect(claimed.lockedBy).toBe('worker-a')
  })

  it('increments attempts at claim time, not on failure', async () => {
    // This is what stops a job that kills its worker every time from looping
    // forever: the count rises even when nothing reports a failure.
    await enqueue({ userId, type: 'test.echo' })
    const [first] = await claim('worker-a', 1)
    expect(first.attempts).toBe(1)

    await reclaimStale(0)
    const [second] = await claim('worker-a', 1)
    expect(second.attempts).toBe(2)
  })

  it('never hands the same job to two workers', async () => {
    // The property SKIP LOCKED exists for. Two workers claim concurrently and
    // must partition the work, not duplicate it.
    await enqueueMany(
      Array.from({ length: 20 }, (_, i) => ({ userId, type: 'test.echo', payload: { i } })),
    )

    const [a, b] = await Promise.all([claim('worker-a', 10), claim('worker-b', 10)])
    const ids = [...a.map((j) => j.id), ...b.map((j) => j.id)]

    expect(ids).toHaveLength(20)
    expect(new Set(ids).size).toBe(20)
  })

  it('does not claim a job scheduled for the future', async () => {
    await enqueue({ userId, type: 'test.later', runAfter: new Date(Date.now() + 60_000) })
    expect(await claim('worker-a', 5)).toHaveLength(0)
  })

  it('claims oldest-due first', async () => {
    const older = await enqueue({
      userId,
      type: 'test.echo',
      payload: { order: 'first' },
      runAfter: new Date(Date.now() - 10_000),
    })
    await enqueue({ userId, type: 'test.echo', payload: { order: 'second' } })

    const [claimed] = await claim('worker-a', 1)
    expect(claimed.id).toBe(older)
  })

  it('completes a job', async () => {
    await enqueue({ userId, type: 'test.echo' })
    const [job] = await claim('worker-a', 1)
    await complete(job.id)

    const after = await db.query.jobs.findFirst({ where: eq(jobs.id, job.id) })
    expect(after?.status).toBe('done')
    expect(after?.completedAt).toBeInstanceOf(Date)
    expect(after?.lockedBy).toBeNull()
  })

  it('reschedules a failure with backoff', async () => {
    await enqueue({ userId, type: 'test.echo', maxAttempts: 3 })
    const [job] = await claim('worker-a', 1)

    const outcome = await fail(job, new Error('boom'))
    expect(outcome).toBe('retry')

    const after = await db.query.jobs.findFirst({ where: eq(jobs.id, job.id) })
    expect(after?.status).toBe('pending')
    expect(after?.lastError).toBe('boom')
    expect(after?.runAfter.getTime()).toBeGreaterThan(Date.now())
    // Not immediately re-claimable — the backoff is real.
    expect(await claim('worker-a', 5)).toHaveLength(0)
  })

  it('parks a job in dead once attempts are exhausted', async () => {
    await enqueue({ userId, type: 'test.echo', maxAttempts: 1 })
    const [job] = await claim('worker-a', 1)

    expect(await fail(job, new Error('permanent'))).toBe('dead')

    const after = await db.query.jobs.findFirst({ where: eq(jobs.id, job.id) })
    expect(after?.status).toBe('dead')
    // Stays visible with its last error rather than vanishing.
    expect(after?.lastError).toBe('permanent')
  })

  it('truncates a very long error rather than failing the update', async () => {
    await enqueue({ userId, type: 'test.echo' })
    const [job] = await claim('worker-a', 1)
    await fail(job, new Error('x'.repeat(5000)))

    const after = await db.query.jobs.findFirst({ where: eq(jobs.id, job.id) })
    expect(after?.lastError?.length).toBe(2000)
  })

  describe('crash and resume', () => {
    it('reclaims a job abandoned by a dead worker', async () => {
      const id = await enqueue({ userId, type: 'test.echo' })
      const [claimed] = await claim('worker-that-dies', 1)
      expect(claimed.id).toBe(id)

      // The worker vanishes: no complete, no fail. The row sits in `claimed`.
      expect(await claim('worker-b', 5)).toHaveLength(0)

      // Once the lease lapses, the work comes back.
      const reclaimed = await reclaimStale(0)
      expect(reclaimed).toBe(1)

      const [again] = await claim('worker-b', 1)
      expect(again.id).toBe(id)
      expect(again.attempts).toBe(2)
    })

    it('leaves a freshly claimed job alone', async () => {
      // Otherwise a slow-but-healthy worker would have its work stolen.
      await enqueue({ userId, type: 'test.echo' })
      await claim('worker-a', 1)
      expect(await reclaimStale(5 * 60 * 1000)).toBe(0)
    })

    it('loses nothing across a simulated restart mid-run', async () => {
      await enqueueMany(
        Array.from({ length: 10 }, (_, i) => ({ userId, type: 'test.echo', payload: { i } })),
      )

      // Worker A claims 5, finishes 2, then dies.
      const firstBatch = await claim('worker-a', 5)
      await complete(firstBatch[0].id)
      await complete(firstBatch[1].id)

      // Worker B starts up and reclaims what A abandoned.
      await reclaimStale(0)

      const seen = new Set([firstBatch[0].id, firstBatch[1].id])
      for (let i = 0; i < 5; i++) {
        const batch = await claim('worker-b', 10)
        if (batch.length === 0) break
        for (const job of batch) {
          expect(seen.has(job.id), 'a completed job was handed out again').toBe(false)
          seen.add(job.id)
          await complete(job.id)
        }
      }

      // All ten accounted for exactly once.
      expect(seen.size).toBe(10)
      const [{ count }] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(jobs)
        .where(eq(jobs.userId, userId))
      expect(count).toBe(10)
    })
  })

  it('reports queue depth by status', async () => {
    await enqueueMany([
      { userId, type: 'a' },
      { userId, type: 'b' },
      { userId, type: 'c' },
    ])
    const [claimed] = await claim('worker-a', 1)
    await complete(claimed.id)

    const counts = await stats(userId)
    expect(counts.done).toBe(1)
    expect(counts.pending).toBe(2)
  })

  it('prunes old completed jobs but keeps dead ones', async () => {
    await enqueue({ userId, type: 'old' })
    const [job] = await claim('worker-a', 1)
    await complete(job.id)
    // Backdate it past the pruning horizon.
    await raw`UPDATE jobs SET completed_at = now() - interval '30 days' WHERE id = ${job.id}`

    await enqueue({ userId, type: 'doomed', maxAttempts: 1 })
    const [doomed] = await claim('worker-a', 1)
    await fail(doomed, new Error('nope'))
    await raw`UPDATE jobs SET completed_at = now() - interval '30 days' WHERE id = ${doomed.id}`

    await prune(7)

    // A dead job is evidence, not litter.
    const survivors = await db.select({ id: jobs.id }).from(jobs).where(eq(jobs.userId, userId))
    expect(survivors.map((s) => s.id)).toEqual([doomed.id])
  })
})
