import { config } from 'dotenv'
import { hostname } from 'node:os'
import { randomUUID } from 'node:crypto'

// Next.js loads .env.local automatically; a plain Node process does not.
config({ path: ['.env.local', '.env'] })

/**
 * Background worker.  `npm run worker`
 *
 * A plain long-lived Node process, which is what removes the serverless
 * timeout ceiling from the architecture — there is no function limit to design
 * around and no external cron to depend on.
 *
 * Shutdown is graceful: SIGINT stops the loop claiming new work and waits for
 * the jobs already in flight. Killed harder than that, the abandoned jobs sit
 * in `claimed` until their lease lapses and are then reclaimed. Either way
 * nothing is lost and nothing runs twice.
 */

const WORKER_ID = `${hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`
const IDLE_POLL_MS = 2_000
const RECLAIM_EVERY_MS = 60_000
const CONCURRENCY = 3

let running = true
let inFlight = 0

function log(message: string, extra: Record<string, unknown> = {}) {
  const parts = Object.entries(extra).map(([k, v]) => `${k}=${v}`)
  console.log(
    `[worker ${new Date().toISOString()}] ${message}${parts.length ? ' ' + parts.join(' ') : ''}`,
  )
}

async function main() {
  // Imported after dotenv has run, because these modules read env at import time.
  const { claim, complete, fail, reclaimStale, stats } = await import('@/lib/queue')
  const { HANDLERS } = await import('@/lib/jobs/handlers')

  log('starting', { worker: WORKER_ID, handlers: Object.keys(HANDLERS).join(',') })

  // On startup, take back anything a previous run abandoned mid-flight.
  const reclaimed = await reclaimStale()
  if (reclaimed > 0) log('reclaimed abandoned jobs from a previous run', { count: reclaimed })

  const initial = await stats()
  log('queue', initial as unknown as Record<string, unknown>)

  let lastReclaim = Date.now()

  while (running) {
    if (Date.now() - lastReclaim > RECLAIM_EVERY_MS) {
      lastReclaim = Date.now()
      const count = await reclaimStale()
      if (count > 0) log('reclaimed stale jobs', { count })
    }

    const capacity = CONCURRENCY - inFlight
    if (capacity <= 0) {
      await sleep(200)
      continue
    }

    const batch = await claim(WORKER_ID, capacity)
    if (batch.length === 0) {
      await sleep(IDLE_POLL_MS)
      continue
    }

    for (const job of batch) {
      inFlight += 1
      void (async () => {
        const started = Date.now()
        try {
          const handler = HANDLERS[job.type]
          if (!handler) throw new Error(`No handler registered for "${job.type}"`)
          await handler(job)
          await complete(job.id)
          log('done', { type: job.type, id: job.id.slice(0, 8), ms: Date.now() - started })
        } catch (error) {
          const outcome = await fail(job, error)
          log(outcome === 'dead' ? 'DEAD' : 'retrying', {
            type: job.type,
            id: job.id.slice(0, 8),
            attempt: job.attempts,
            of: job.maxAttempts,
            error: error instanceof Error ? error.message : String(error),
          })
        } finally {
          inFlight -= 1
        }
      })()
    }
  }

  // Let in-flight work finish rather than abandoning it to a lease timeout.
  log('draining', { inFlight })
  while (inFlight > 0) await sleep(200)
  log('stopped')
  process.exit(0)
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (!running) process.exit(1) // second signal: give up and exit now
    log(`${signal} received — finishing in-flight jobs, press again to force quit`)
    running = false
  })
}

main().catch((error) => {
  console.error('[worker] fatal:', error)
  process.exit(1)
})
