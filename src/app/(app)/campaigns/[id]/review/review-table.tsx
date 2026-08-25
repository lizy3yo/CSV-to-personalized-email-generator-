'use client'

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  Loader2,
  Pencil,
  Sparkles,
  Undo2,
  X,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input, Textarea } from '@/components/ui/select'
import { canApprove, parseFlags } from '@/core/review/flags'
import { formatUsd } from '@/core/ai/cost'
import {
  approveRecipients,
  regenerateRecipient,
  rejectRecipients,
  resetRecipients,
  updateRecipient,
  type ReviewCounts,
} from './actions'

export interface ReviewRow {
  id: string
  email: string
  subject: string | null
  bodyText: string | null
  status: string
  flags: string[]
  editedByUser: boolean
}

type Filter = 'all' | 'needs_review' | 'flagged' | 'approved' | 'rejected' | 'edited' | 'blocked'

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'needs_review', label: 'Needs review' },
  { key: 'flagged', label: 'Flagged' },
  { key: 'blocked', label: 'Blocked' },
  { key: 'edited', label: 'Edited' },
  { key: 'approved', label: 'Approved' },
  { key: 'rejected', label: 'Rejected' },
  { key: 'all', label: 'All' },
]

const STATUS_TONE: Record<string, 'neutral' | 'success' | 'warning' | 'danger' | 'accent'> = {
  generated: 'neutral',
  flagged: 'warning',
  approved: 'success',
  rejected: 'danger',
}

export function ReviewTable({
  campaignId,
  rows,
  counts,
  hasAiSlots,
  hasApiKey,
}: {
  campaignId: string
  rows: ReviewRow[]
  counts: ReviewCounts
  hasAiSlots: boolean
  hasApiKey: boolean
}) {
  const router = useRouter()
  const [filter, setFilter] = useState<Filter>(counts.flagged > 0 ? 'needs_review' : 'all')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [expanded, setExpanded] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const visible = useMemo(() => {
    switch (filter) {
      case 'needs_review':
        return rows.filter((r) => r.status === 'generated' || r.status === 'flagged')
      case 'flagged':
        return rows.filter((r) => r.status === 'flagged')
      case 'blocked':
        return rows.filter((r) => !canApprove(r.status, r.flags) && r.status !== 'rejected')
      case 'edited':
        return rows.filter((r) => r.editedByUser)
      case 'approved':
        return rows.filter((r) => r.status === 'approved')
      case 'rejected':
        return rows.filter((r) => r.status === 'rejected')
      default:
        return rows
    }
  }, [rows, filter])

  const countFor = (key: Filter) => {
    switch (key) {
      case 'needs_review':
        return counts.generated + counts.flagged
      case 'flagged':
        return counts.flagged
      case 'blocked':
        return counts.blocked
      case 'edited':
        return counts.edited
      case 'approved':
        return counts.approved
      case 'rejected':
        return counts.rejected
      default:
        return counts.total
    }
  }

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function run(fn: () => Promise<void>) {
    setError(null)
    setNotice(null)
    startTransition(async () => {
      await fn()
      setSelected(new Set())
      router.refresh()
    })
  }

  const ids = () => [...selected]

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
      {notice && (
        <div className="border-accent/30 bg-accent/10 text-accent rounded-lg border p-3 text-sm">
          {notice}
        </div>
      )}

      {/* ── filters ─────────────────────────────────────────────────── */}
      <div className="flex flex-wrap gap-1.5">
        {FILTERS.map(({ key, label }) => (
          <button
            key={key}
            type="button"
            onClick={() => setFilter(key)}
            className={`rounded-lg border px-2.5 py-1 text-xs transition-colors ${
              filter === key
                ? 'border-accent bg-accent/10 text-accent'
                : 'border-border text-ink-muted hover:border-border-strong hover:text-ink'
            }`}
          >
            {label} <span className="tabular-nums">{countFor(key)}</span>
          </button>
        ))}
      </div>

      {/* ── bulk actions ────────────────────────────────────────────── */}
      <div className="border-border bg-surface-muted flex flex-wrap items-center gap-2 rounded-lg border p-2.5">
        <label className="text-ink-muted flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={visible.length > 0 && selected.size === visible.length}
            onChange={(e) =>
              setSelected(e.target.checked ? new Set(visible.map((r) => r.id)) : new Set())
            }
          />
          {selected.size > 0 ? `${selected.size} selected` : 'Select all shown'}
        </label>

        <div className="ml-auto flex flex-wrap gap-2">
          <Button
            size="sm"
            disabled={pending || selected.size === 0}
            onClick={() =>
              run(async () => {
                const result = await approveRecipients({ campaignId, recipientIds: ids() })
                if (!result.ok) setError(result.error)
                else if (result.data.blocked > 0) {
                  // Partial success is reported precisely rather than as a
                  // vague failure — knowing which rows were refused is the
                  // useful part.
                  setNotice(
                    `Approved ${result.data.approved}. ${result.data.blocked} could not be approved — they have errors, not just warnings.`,
                  )
                }
              })
            }
          >
            {pending ? <Loader2 className="animate-spin" /> : <Check />} Approve
          </Button>

          <Button
            variant="secondary"
            size="sm"
            disabled={pending || selected.size === 0}
            onClick={() =>
              run(async () => {
                const result = await rejectRecipients({ campaignId, recipientIds: ids() })
                if (!result.ok) setError(result.error)
              })
            }
          >
            <X /> Reject
          </Button>

          <Button
            variant="ghost"
            size="sm"
            disabled={pending || selected.size === 0}
            onClick={() =>
              run(async () => {
                const result = await resetRecipients({ campaignId, recipientIds: ids() })
                if (!result.ok) setError(result.error)
              })
            }
          >
            <Undo2 /> Undo
          </Button>
        </div>
      </div>

      {/* ── rows ────────────────────────────────────────────────────── */}
      {visible.length === 0 ? (
        <p className="text-ink-muted p-8 text-center text-sm">Nothing in this view.</p>
      ) : (
        <div className="border-border divide-border divide-y rounded-lg border">
          {visible.map((row) => (
            <RecipientRow
              key={row.id}
              campaignId={campaignId}
              row={row}
              selected={selected.has(row.id)}
              expanded={expanded === row.id}
              hasAiSlots={hasAiSlots}
              hasApiKey={hasApiKey}
              onToggle={() => toggle(row.id)}
              onExpand={() => setExpanded(expanded === row.id ? null : row.id)}
              onChanged={() => router.refresh()}
              onError={setError}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function RecipientRow({
  campaignId,
  row,
  selected,
  expanded,
  hasAiSlots,
  hasApiKey,
  onToggle,
  onExpand,
  onChanged,
  onError,
}: {
  campaignId: string
  row: ReviewRow
  selected: boolean
  expanded: boolean
  hasAiSlots: boolean
  hasApiKey: boolean
  onToggle: () => void
  onExpand: () => void
  onChanged: () => void
  onError: (message: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [subject, setSubject] = useState(row.subject ?? '')
  const [bodyText, setBodyText] = useState(row.bodyText ?? '')
  const [busy, setBusy] = useState<'save' | 'regen' | null>(null)
  const [lastCost, setLastCost] = useState<number | null>(null)

  const flags = parseFlags(row.flags)
  const blocked = !canApprove(row.status, row.flags)

  async function save() {
    setBusy('save')
    const result = await updateRecipient({ campaignId, recipientId: row.id, subject, bodyText })
    setBusy(null)
    if (!result.ok) {
      onError(result.error)
      return
    }
    setEditing(false)
    onChanged()
  }

  async function regenerate() {
    setBusy('regen')
    const result = await regenerateRecipient({ campaignId, recipientId: row.id })
    setBusy(null)
    if (!result.ok) {
      onError(result.error)
      return
    }
    setLastCost(result.data.costUsd)
    onChanged()
  }

  return (
    <div className={selected ? 'bg-accent/5' : undefined}>
      <div className="flex items-start gap-3 p-3">
        <input type="checkbox" checked={selected} onChange={onToggle} className="mt-1" />

        <button
          type="button"
          onClick={onExpand}
          aria-label={expanded ? 'Collapse' : 'Expand'}
          className="text-ink-subtle hover:text-ink mt-0.5 transition-colors"
        >
          {expanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
        </button>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-ink-muted truncate text-sm">{row.email}</span>
            <Badge tone={STATUS_TONE[row.status] ?? 'neutral'}>{row.status}</Badge>
            {row.editedByUser && <Badge tone="accent">edited</Badge>}
            {flags.map((flag) => (
              <Badge
                key={flag.raw}
                tone={flag.severity === 'error' ? 'danger' : 'warning'}
                title={flag.detail}
              >
                {flag.label}
              </Badge>
            ))}
          </div>
          <p className="mt-1 truncate text-sm font-medium">
            {row.subject || <span className="text-ink-subtle italic">no subject</span>}
          </p>
        </div>
      </div>

      {expanded && (
        <div className="border-border border-t p-4 pl-12">
          {blocked && (
            <p className="border-danger/30 bg-danger/10 text-danger mb-3 rounded-lg border p-2.5 text-xs">
              This row cannot be approved until the error is fixed. Edit it or regenerate it.
            </p>
          )}

          {editing ? (
            <div className="flex flex-col gap-3">
              <Input
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder="Subject"
                aria-label="Subject"
              />
              <Textarea
                value={bodyText}
                onChange={(e) => setBodyText(e.target.value)}
                rows={12}
                aria-label="Body"
                className="font-sans"
              />
              <div className="flex gap-2">
                <Button size="sm" onClick={save} disabled={busy !== null}>
                  {busy === 'save' ? <Loader2 className="animate-spin" /> : <Check />} Save
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy !== null}
                  onClick={() => {
                    setSubject(row.subject ?? '')
                    setBodyText(row.bodyText ?? '')
                    setEditing(false)
                  }}
                >
                  Cancel
                </Button>
              </div>
              <p className="text-ink-subtle text-xs">
                Saving re-checks the text and drops this row out of approved, so a decision made
                about different wording cannot carry over.
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <pre className="text-ink font-sans text-sm leading-relaxed whitespace-pre-wrap">
                {row.bodyText || <span className="text-ink-subtle italic">empty</span>}
              </pre>

              <div className="flex flex-wrap items-center gap-2">
                <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
                  <Pencil /> Edit
                </Button>
                {hasAiSlots && hasApiKey && (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={regenerate}
                    disabled={busy !== null}
                  >
                    {busy === 'regen' ? <Loader2 className="animate-spin" /> : <Sparkles />}
                    Regenerate
                  </Button>
                )}
                {lastCost !== null && (
                  <Badge tone="neutral">{formatUsd(lastCost)} for that regeneration</Badge>
                )}
              </div>

              {flags.length > 0 && (
                <ul className="text-ink-muted flex flex-col gap-1 text-xs">
                  {flags.map((flag) => (
                    <li key={flag.raw}>
                      <span className={flag.severity === 'error' ? 'text-danger' : 'text-warning'}>
                        {flag.severity}
                      </span>{' '}
                      · {flag.detail}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
