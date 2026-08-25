import { NextResponse, type NextRequest } from 'next/server'
import { claim, complete, fail, reclaimStale } from '@/lib/queue'
import { HANDLERS } from '@/lib/jobs/handlers'

/**
 * Alternate worker driver: one tick per request.
 *
 * The primary driver is `npm run worker`, a long-lived process with no timeout
 * ceiling. This endpoint exists for the hosted case, where something external
 * has to poke the queue — an external cron service, a GitHub Actions schedule,
 * or Supabase's own `pg_cron` plus `pg_net`.
 *
 * It claims only a few jobs and returns quickly, because a serverless platform
 * will cut the request off. That is why it is a tick rather than a loop.
 */

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/** Small enough to finish inside a serverless request. */
const JOBS_PER_TICK = 3

export async function POST(request: NextRequest) {
  const secret = process.env.CRON_SECRET

  // Unauthenticated by design when no secret is set — locally there is nothing
  // to protect. Deployed, CRON_SECRET is required and checked.
  if (secret) {
    const provided = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
    if (provided !== secret) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
  } else if (process.env.NODE_ENV === 'production') {
    return NextResponse.json(
      { error: 'CRON_SECRET is not set. Refusing to run an open worker endpoint.' },
      { status: 500 },
    )
  }

  const reclaimed = await reclaimStale()
  const batch = await claim(`cron-${Date.now()}`, JOBS_PER_TICK)

  const results: { id: string; type: string; ok: boolean; error?: string }[] = []

  for (const job of batch) {
    try {
      const handler = HANDLERS[job.type]
      if (!handler) throw new Error(`No handler registered for "${job.type}"`)
      await handler(job)
      await complete(job.id)
      results.push({ id: job.id, type: job.type, ok: true })
    } catch (error) {
      const outcome = await fail(job, error)
      results.push({
        id: job.id,
        type: job.type,
        ok: false,
        error: `${outcome}: ${error instanceof Error ? error.message : String(error)}`,
      })
    }
  }

  return NextResponse.json({ reclaimed, processed: results.length, results })
}

/** Convenience for a browser or a health check. */
export async function GET(request: NextRequest) {
  return POST(request)
}
