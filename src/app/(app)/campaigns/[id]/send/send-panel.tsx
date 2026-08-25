'use client'

import { useEffect, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { AlertTriangle, Check, Info, Loader2, Mail, Pause, Play, Send, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input, Label } from '@/components/ui/select'
import { estimateDuration } from '@/core/gmail/pacing'
import { pauseSending, sendTestToSelf, startSending, updateSendSettings } from './actions'

export interface PreflightCheck {
  ok: boolean
  blocking: boolean
  label: string
  detail: string
}

interface Props {
  campaignId: string
  status: string
  approved: number
  sent: number
  failed: number
  stuck: number
  fromEmail: string | null
  dailyLimit: number
  sentLast24h: number
  checks: PreflightCheck[]
  settings: {
    ratePerHour: number
    sendWindowStartHour: number
    sendWindowEndHour: number
    sendWindowDays: number[]
    threadFollowUps: boolean
  }
  sampleSubject: string
  sampleBody: string
}

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

export function SendPanel({
  campaignId,
  status,
  approved,
  sent,
  failed,
  stuck,
  fromEmail,
  dailyLimit,
  sentLast24h,
  checks,
  settings,
  sampleSubject,
  sampleBody,
}: Props) {
  const router = useRouter()
  const [ratePerHour, setRatePerHour] = useState(settings.ratePerHour)
  const [startHour, setStartHour] = useState(settings.sendWindowStartHour)
  const [endHour, setEndHour] = useState(settings.sendWindowEndHour)
  const [days, setDays] = useState<number[]>(settings.sendWindowDays)
  const [thread, setThread] = useState(settings.threadFollowUps)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const sending = status === 'sending'

  useEffect(() => {
    if (!sending) return
    const id = setInterval(() => router.refresh(), 5000)
    return () => clearInterval(id)
  }, [sending, router])

  const windowHours = Math.max(1, endHour - startHour)
  const duration = estimateDuration(approved, ratePerHour, dailyLimit, windowHours)
  const blocking = checks.filter((c) => c.blocking && !c.ok)
  const warnings = checks.filter((c) => !c.blocking && !c.ok)

  function saveSettings(next: Partial<Props['settings']>) {
    startTransition(async () => {
      const result = await updateSendSettings({
        campaignId,
        ratePerHour: next.ratePerHour ?? ratePerHour,
        sendWindowStartHour: next.sendWindowStartHour ?? startHour,
        sendWindowEndHour: next.sendWindowEndHour ?? endHour,
        sendWindowDays: next.sendWindowDays ?? days,
        threadFollowUps: next.threadFollowUps ?? thread,
      })
      if (!result.ok) setError(result.error)
    })
  }

  return (
    <div className="flex flex-col gap-6">
      {error && (
        <div
          role="alert"
          className="border-danger/30 bg-danger/10 text-danger flex items-start gap-2 rounded-lg border p-3 text-sm"
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          {error}
        </div>
      )}
      {notice && (
        <div className="border-success/30 bg-success/10 text-success rounded-lg border p-3 text-sm">
          {notice}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>From</CardTitle>
          <CardDescription>
            Sent through your own Gmail, so replies arrive in your inbox and stay in the thread.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-3">
          <Mail className="text-ink-muted size-4" />
          <span className="text-sm font-medium">{fromEmail ?? 'Not connected'}</span>
          {dailyLimit > 0 ? (
            <Badge tone="neutral">
              {sentLast24h}/{dailyLimit} used in the last 24h
            </Badge>
          ) : (
            // Without a connected account there is no quota to report, and a
            // "0 / 0" badge reads as an error rather than an absence.
            <Badge tone="warning">No sending quota until Gmail is connected</Badge>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Pacing</CardTitle>
          <CardDescription>
            Gmail&apos;s cap is a rolling 24-hour window, not a midnight reset. Sustained overage
            risks a temporary suspension on your account, so the default sits well under it.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-wrap gap-4">
            <div className="flex w-32 flex-col gap-1.5">
              <Label htmlFor="rate">Per hour</Label>
              <Input
                id="rate"
                type="number"
                min={0}
                max={2000}
                value={ratePerHour}
                disabled={sending}
                onChange={(e) => setRatePerHour(Number(e.target.value))}
                onBlur={() => saveSettings({ ratePerHour })}
              />
            </div>
            <div className="flex w-28 flex-col gap-1.5">
              <Label htmlFor="from-hour">From</Label>
              <Input
                id="from-hour"
                type="number"
                min={0}
                max={23}
                value={startHour}
                disabled={sending}
                onChange={(e) => setStartHour(Number(e.target.value))}
                onBlur={() => saveSettings({ sendWindowStartHour: startHour })}
              />
            </div>
            <div className="flex w-28 flex-col gap-1.5">
              <Label htmlFor="to-hour">Until</Label>
              <Input
                id="to-hour"
                type="number"
                min={1}
                max={24}
                value={endHour}
                disabled={sending}
                onChange={(e) => setEndHour(Number(e.target.value))}
                onBlur={() => saveSettings({ sendWindowEndHour: endHour })}
              />
            </div>
          </div>

          <div className="flex flex-wrap gap-1.5">
            {DAY_LABELS.map((label, index) => {
              const day = index + 1
              const on = days.includes(day)
              return (
                <button
                  key={day}
                  type="button"
                  disabled={sending}
                  onClick={() => {
                    const next = on ? days.filter((d) => d !== day) : [...days, day].sort()
                    setDays(next)
                    saveSettings({ sendWindowDays: next })
                  }}
                  className={`rounded-lg border px-2.5 py-1 text-xs transition-colors ${
                    on
                      ? 'border-accent bg-accent/10 text-accent'
                      : 'border-border text-ink-subtle hover:border-border-strong'
                  }`}
                >
                  {label}
                </button>
              )
            })}
          </div>

          <label className="flex items-start gap-2.5 text-sm">
            <input
              type="checkbox"
              checked={thread}
              disabled={sending}
              onChange={(e) => {
                setThread(e.target.checked)
                saveSettings({ threadFollowUps: e.target.checked })
              }}
              className="mt-0.5"
            />
            <span>
              <span className="font-medium">Keep follow-ups in the same thread</span>
              <span className="text-ink-muted block text-xs">
                Uses Gmail&apos;s threadId so a later message attaches to the original conversation
                in both your Sent folder and the recipient&apos;s inbox.
              </span>
            </span>
          </label>

          {approved > 0 && dailyLimit > 0 && (
            <div className="border-border bg-surface-muted rounded-lg border p-3 text-sm">
              <p>
                {approved.toLocaleString()} approved · about {duration.perDay.toLocaleString()}/day
                {duration.days > 1 && (
                  <span className="text-warning"> · roughly {duration.days} days to finish</span>
                )}
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Preflight</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {checks.map((check) => (
            <div key={check.label} className="flex items-start gap-2.5 text-sm">
              {check.ok ? (
                <Check className="text-success mt-0.5 size-4 shrink-0" />
              ) : check.blocking ? (
                <X className="text-danger mt-0.5 size-4 shrink-0" />
              ) : (
                <Info className="text-warning mt-0.5 size-4 shrink-0" />
              )}
              <div className="min-w-0">
                <p className="font-medium">{check.label}</p>
                <p className="text-ink-muted">{check.detail}</p>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      {(sent > 0 || failed > 0 || stuck > 0) && (
        <Card>
          <CardHeader>
            <CardTitle>Progress</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-1.5">
            <Badge tone="success">{sent.toLocaleString()} sent</Badge>
            <Badge tone="neutral">{approved.toLocaleString()} remaining</Badge>
            {failed > 0 && <Badge tone="danger">{failed.toLocaleString()} failed</Badge>}
            {stuck > 0 && (
              <Badge tone="warning" title="Delivery unknown — not retried automatically">
                {stuck} in flight when a worker stopped
              </Badge>
            )}
          </CardContent>
        </Card>
      )}

      {stuck > 0 && (
        <div className="border-warning/30 bg-warning/10 text-warning rounded-lg border p-3 text-sm">
          <AlertTriangle className="mr-1.5 inline size-4" />
          {stuck} message{stuck === 1 ? '' : 's'} were in flight when a worker stopped. Gmail has no
          way to tell us whether they were delivered, so they are not resent automatically — a
          duplicate is worse than a gap. Check your Sent folder and decide.
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 pb-10">
        <Button
          variant="secondary"
          disabled={pending || !fromEmail}
          onClick={() =>
            startTransition(async () => {
              setError(null)
              setNotice(null)
              const result = await sendTestToSelf(campaignId, sampleSubject, sampleBody)
              if (!result.ok) setError(result.error)
              else setNotice(`Test sent to ${result.data.to}. Check how it actually renders.`)
            })
          }
        >
          {pending ? <Loader2 className="animate-spin" /> : <Send />} Send test to myself
        </Button>

        {sending ? (
          <Button
            variant="secondary"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                const result = await pauseSending(campaignId)
                if (!result.ok) setError(result.error)
                router.refresh()
              })
            }
          >
            <Pause /> Pause
          </Button>
        ) : (
          <Button
            disabled={pending || blocking.length > 0 || approved === 0}
            onClick={() =>
              startTransition(async () => {
                setError(null)
                const result = await startSending(campaignId)
                if (!result.ok) setError(result.error)
                router.refresh()
              })
            }
          >
            {pending ? <Loader2 className="animate-spin" /> : <Play />}
            Start sending {approved.toLocaleString()}
          </Button>
        )}
      </div>

      {blocking.length > 0 && (
        <p className="text-danger -mt-6 text-right text-xs">
          {blocking.length} preflight check{blocking.length === 1 ? '' : 's'} must pass first.
        </p>
      )}
      {warnings.length > 0 && blocking.length === 0 && (
        <p className="text-ink-subtle -mt-6 text-right text-xs">
          {warnings.length} warning{warnings.length === 1 ? '' : 's'} — sending is allowed, but read
          them.
        </p>
      )}
    </div>
  )
}
