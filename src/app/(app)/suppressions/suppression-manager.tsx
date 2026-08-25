'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { AlertTriangle, Plus, Trash2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input, Label, Select, Textarea } from '@/components/ui/select'
import { addSuppressions, removeSuppression } from './actions'

export interface SuppressionRow {
  id: string
  email: string
  reason: string
  source: string | null
  createdAt: Date
}

const REASONS = [
  { value: 'unsubscribed', label: 'Unsubscribed' },
  { value: 'hard_bounce', label: 'Hard bounce' },
  { value: 'complaint', label: 'Spam complaint' },
  { value: 'manual', label: 'Added manually' },
  { value: 'invalid', label: 'Invalid address' },
] as const

const REASON_TONE: Record<string, 'neutral' | 'danger' | 'warning'> = {
  unsubscribed: 'neutral',
  hard_bounce: 'danger',
  complaint: 'danger',
  manual: 'neutral',
  invalid: 'warning',
}

export function SuppressionManager({ rows }: { rows: SuppressionRow[] }) {
  const router = useRouter()
  const [emails, setEmails] = useState('')
  const [reason, setReason] = useState<(typeof REASONS)[number]['value']>('unsubscribed')
  const [source, setSource] = useState('')
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  function add() {
    setError(null)
    setNotice(null)
    startTransition(async () => {
      const result = await addSuppressions({ emails, reason, source })
      if (!result.ok) {
        setError(result.error)
        return
      }
      const parts = [`${result.data.added} added`]
      if (result.data.skipped > 0) parts.push(`${result.data.skipped} already suppressed`)
      if (result.data.invalid.length > 0) {
        parts.push(`${result.data.invalid.length} not valid addresses`)
      }
      setNotice(parts.join(' · '))
      setEmails('')
      router.refresh()
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
          <CardTitle>Add addresses</CardTitle>
          <CardDescription>
            Checked at dispatch, not at generation — so someone who unsubscribes while a campaign is
            being reviewed is still dropped before their email goes out.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="emails">Addresses</Label>
            <Textarea
              id="emails"
              value={emails}
              onChange={(e) => setEmails(e.target.value)}
              rows={4}
              placeholder={'ana@northwind.io\nbo@cascade.dev'}
              className="font-sans"
            />
            <p className="text-ink-subtle text-xs">
              One per line, or comma-separated. Pasting a list that is already suppressed is
              harmless.
            </p>
          </div>

          <div className="flex flex-wrap gap-3">
            <div className="flex w-48 flex-col gap-1.5">
              <Label htmlFor="reason">Reason</Label>
              <Select
                id="reason"
                value={reason}
                onChange={(e) => setReason(e.target.value as typeof reason)}
              >
                {REASONS.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </Select>
            </div>
            <div className="flex min-w-48 flex-1 flex-col gap-1.5">
              <Label htmlFor="source">Where from? (optional)</Label>
              <Input
                id="source"
                value={source}
                onChange={(e) => setSource(e.target.value)}
                placeholder="Reply from Ana, 25 Aug"
              />
            </div>
          </div>

          <div>
            <Button onClick={add} disabled={pending || !emails.trim()}>
              <Plus /> Add to suppression list
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Suppressed ({rows.length.toLocaleString()})</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {rows.length === 0 ? (
            <p className="text-ink-muted p-8 text-center text-sm">Nobody is suppressed yet.</p>
          ) : (
            <div className="divide-border divide-y">
              {rows.map((row) => (
                <div key={row.id} className="flex items-center justify-between gap-3 px-5 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm">{row.email}</p>
                    <p className="text-ink-subtle text-xs">
                      {row.source ?? 'no source recorded'} ·{' '}
                      {new Date(row.createdAt).toLocaleDateString()}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Badge tone={REASON_TONE[row.reason] ?? 'neutral'}>
                      {REASONS.find((r) => r.value === row.reason)?.label ?? row.reason}
                    </Badge>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Remove ${row.email}`}
                      disabled={pending}
                      onClick={() =>
                        startTransition(async () => {
                          const result = await removeSuppression(row.id)
                          if (!result.ok) setError(result.error)
                          router.refresh()
                        })
                      }
                    >
                      <Trash2 />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
