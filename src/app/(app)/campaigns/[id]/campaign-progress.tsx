'use client'

import { useEffect, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { AlertTriangle, Loader2, Play, RefreshCw } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { formatUsd } from '@/core/ai/cost'
import { startGeneration, type CampaignProgress } from '../actions'

const TONE: Record<string, 'neutral' | 'success' | 'warning' | 'danger' | 'accent'> = {
  pending: 'neutral',
  generating: 'accent',
  generated: 'success',
  flagged: 'warning',
  approved: 'success',
  rejected: 'danger',
  failed: 'danger',
}

const POLL_MS = 2000

/**
 * Live view of a generation run.
 *
 * Deliberately holds no copy of the progress in React state. While the run is
 * active it calls `router.refresh()` on an interval and the Server Component
 * above re-queries — so there is one source of truth (the database) rather
 * than a client cache that can drift from it.
 *
 * That also sidesteps the whole class of "setState from an effect" problems:
 * `router.refresh()` is not state, so there is nothing to synchronise.
 */
export function CampaignProgressPanel({
  campaignId,
  progress,
}: {
  campaignId: string
  progress: CampaignProgress
}) {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const running = progress.status === 'generating'

  useEffect(() => {
    if (!running) return
    const id = setInterval(() => router.refresh(), POLL_MS)
    return () => clearInterval(id)
  }, [running, router])

  function generate() {
    setError(null)
    startTransition(async () => {
      const result = await startGeneration(campaignId)
      if (!result.ok) {
        setError(result.error)
        return
      }
      router.refresh()
    })
  }

  const done =
    (progress.byStatus.generated ?? 0) +
    (progress.byStatus.flagged ?? 0) +
    (progress.byStatus.approved ?? 0)
  const percent = progress.total === 0 ? 0 : Math.round((done / progress.total) * 100)

  return (
    <div className="flex flex-col gap-4">
      {error && (
        <div
          role="alert"
          className="border-danger/30 bg-danger/10 text-danger flex items-start gap-2 rounded-lg border p-3 text-sm"
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          {error}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Badge tone={running ? 'accent' : progress.status === 'reviewing' ? 'success' : 'neutral'}>
          {running && <Loader2 className="size-3 animate-spin" />}
          {progress.status}
        </Badge>
        {progress.total > 0 && (
          <span className="text-ink-muted text-sm tabular-nums">
            {done.toLocaleString()} of {progress.total.toLocaleString()} generated
          </span>
        )}
        {progress.costUsd > 0 && <Badge tone="neutral">{formatUsd(progress.costUsd)} spent</Badge>}

        <div className="ml-auto flex gap-2">
          <Button variant="ghost" size="sm" aria-label="Refresh" onClick={() => router.refresh()}>
            <RefreshCw />
          </Button>
          {!running && (
            <Button size="sm" onClick={generate} disabled={pending}>
              {pending ? <Loader2 className="animate-spin" /> : <Play />}
              {progress.total > 0 ? 'Generate again' : 'Generate'}
            </Button>
          )}
        </div>
      </div>

      {progress.total > 0 && (
        <div className="bg-surface-muted h-2 overflow-hidden rounded-full">
          <div
            className="bg-accent h-full transition-[width] duration-500"
            style={{ width: `${percent}%` }}
          />
        </div>
      )}

      <div className="flex flex-wrap gap-1.5">
        {Object.entries(progress.byStatus).map(([status, count]) => (
          <Badge key={status} tone={TONE[status] ?? 'neutral'}>
            {count.toLocaleString()} {status}
          </Badge>
        ))}
      </div>

      {running && (
        <p className="text-ink-subtle text-xs">
          The background worker is doing this. Close the tab if you like — progress lives in the
          database, not on this page. If nothing moves, check that{' '}
          <code className="font-mono">npm run worker</code> is running.
        </p>
      )}
    </div>
  )
}
