'use client'

import { useMemo, useRef, useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  AlertTriangle,
  Check,
  ChevronLeft,
  ChevronRight,
  Code,
  Info,
  Loader2,
  Sparkles,
  Type,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input, Label, Select, Textarea } from '@/components/ui/select'
import { textToHtml } from '@/core/template/html'
import { render, renderSubject } from '@/core/template/render'
import { checkTemplate } from '@/core/template/validate'
import { formatUsd } from '@/core/ai/cost'
import { GUARDRAIL_LABELS, type GuardrailKey } from '@/core/ai/prompt'
import {
  createTemplate,
  generateSlotPreview,
  getPreviewRows,
  updateTemplate,
  type GeneratePreviewResult,
} from './actions'

interface ListOption {
  id: string
  name: string
  contactCount: number
}

interface Props {
  hasApiKey: boolean
  templateId?: string
  initial: {
    name: string
    subjectTpl: string
    bodyTpl: string
    complianceProfile: 'one_to_one' | 'bulk'
  }
  lists: ListOption[]
}

type PreviewRow = { email: string; data: Record<string, string> }

/** Shown when no contact list is chosen, so the preview is never blank. */
const SAMPLE_ROW: PreviewRow = {
  email: 'a.chen@northwind.io',
  data: {
    first_name: 'Ana',
    last_name: 'Chen',
    company: 'Northwind Traders',
    city: 'Bristol',
    title: 'Head of Operations',
  },
}
const SAMPLE_VARIABLES = Object.keys(SAMPLE_ROW.data)

export function TemplateEditor({ hasApiKey, templateId, initial, lists }: Props) {
  const router = useRouter()
  const bodyRef = useRef<HTMLTextAreaElement>(null)

  const [name, setName] = useState(initial.name)
  const [subjectTpl, setSubjectTpl] = useState(initial.subjectTpl)
  const [bodyTpl, setBodyTpl] = useState(initial.bodyTpl)
  const [complianceProfile, setComplianceProfile] = useState(initial.complianceProfile)

  const [listId, setListId] = useState<string>('')
  // Keyed by the list it belongs to, so switching lists derives an empty
  // preview rather than needing a synchronous setState to clear one.
  const [fetched, setFetched] = useState<{
    listId: string
    rows: PreviewRow[]
    variables: string[]
  } | null>(null)
  const [rowIndex, setRowIndex] = useState(0)
  const [loadingRows, setLoadingRows] = useState(false)

  // AI slot configuration. Persisted with the template in phase 4; for now
  // it drives the try-it-on-this-row button.
  const [brief, setBrief] = useState(
    'Reference something specific from their data in one sentence.',
  )
  const [tone, setTone] = useState('Warm but professional. Plain words, no hype.')
  const [maxSentences, setMaxSentences] = useState(2)
  const [guardrails, setGuardrails] = useState<GuardrailKey[]>(['no_superlatives'])
  const [slotFills, setSlotFills] = useState<Record<string, GeneratePreviewResult>>({})
  const [generating, setGenerating] = useState(false)
  const [genError, setGenError] = useState<string | null>(null)

  const [view, setView] = useState<'text' | 'html'>('text')
  const [saving, startSaving] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  // Deliberately not a useEffect. Loading rows is a response to the user
  // picking a list, not state that needs synchronising — so it lives in the
  // event handler, which is also what React recommends.
  const latestRequest = useRef(0)

  async function selectList(id: string) {
    setListId(id)
    setRowIndex(0)
    if (!id) return

    const request = ++latestRequest.current
    setLoadingRows(true)
    try {
      const result = await getPreviewRows(id)
      // Ignore a slow response for a list the user has already moved off.
      if (request !== latestRequest.current) return
      if (result.ok) {
        setFetched({ listId: id, rows: result.data.rows, variables: result.data.variables })
      } else {
        setError(result.error)
      }
    } finally {
      if (request === latestRequest.current) setLoadingRows(false)
    }
  }

  const active = fetched?.listId === listId ? fetched : null
  const usingSample = !active || active.rows.length === 0
  const previewRows = usingSample ? [SAMPLE_ROW] : active.rows
  const variables = usingSample ? SAMPLE_VARIABLES : active.variables
  const current = previewRows[Math.min(rowIndex, previewRows.length - 1)]

  const check = useMemo(
    () => checkTemplate(subjectTpl, bodyTpl, usingSample ? [] : variables),
    [subjectTpl, bodyTpl, variables, usingSample],
  )

  const preview = useMemo(() => {
    const slots = Object.fromEntries(
      Object.entries(slotFills).map(([name, fill]) => [name, fill.text]),
    )
    const context = { data: current.data, slots }
    const subject = renderSubject(subjectTpl, context)
    const body = render(bodyTpl, context)
    return {
      subject: subject.text,
      body: body.text,
      html: textToHtml(body.text),
      unresolved: [...new Set([...subject.unresolved, ...body.unresolved])],
      slots: [...new Set([...subject.unfilledSlots, ...body.unfilledSlots])],
    }
  }, [subjectTpl, bodyTpl, current, slotFills])

  /** Insert at the caret rather than appending — appending is never what you want. */
  function insert(snippet: string) {
    const el = bodyRef.current
    if (!el) {
      setBodyTpl((v) => v + snippet)
      return
    }
    const start = el.selectionStart
    const end = el.selectionEnd
    setBodyTpl((v) => v.slice(0, start) + snippet + v.slice(end))
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(start + snippet.length, start + snippet.length)
    })
  }

  /**
   * Fill every AI slot for the row currently shown.
   *
   * Runs synchronously because a person is watching. Bulk generation goes
   * through the queue and the Batch API in phase 4.
   */
  async function generate() {
    setGenError(null)
    setGenerating(true)
    try {
      const fills: Record<string, GeneratePreviewResult> = {}
      for (const slotName of check.slots) {
        const result = await generateSlotPreview({
          bodyTemplate: bodyTpl,
          slotName,
          brief,
          maxSentences: maxSentences || undefined,
          tone,
          guardrails,
          data: current.data,
          availableFields: variables,
        })
        if (!result.ok) {
          setGenError(result.error)
          return
        }
        fills[slotName] = result.data
      }
      setSlotFills(fills)
    } finally {
      setGenerating(false)
    }
  }

  function save() {
    setError(null)
    setSaved(false)
    startSaving(async () => {
      const payload = { name, subjectTpl, bodyTpl, complianceProfile }
      const result = templateId
        ? await updateTemplate(templateId, payload)
        : await createTemplate(payload)

      if (!result.ok) {
        setError(result.error)
        return
      }
      setSaved(true)
      if (!templateId && 'id' in result.data) {
        router.push(`/templates/${result.data.id}`)
      } else {
        router.refresh()
      }
    })
  }

  const blocked = check.errors.length > 0 || name.trim() === ''

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-border flex shrink-0 flex-wrap items-center gap-3 border-b px-6 py-3">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Template name"
          className="h-9 max-w-xs"
          aria-label="Template name"
        />

        <Select
          value={complianceProfile}
          onChange={(e) => setComplianceProfile(e.target.value as 'one_to_one' | 'bulk')}
          className="h-9 w-auto"
          aria-label="Compliance profile"
        >
          <option value="one_to_one">1:1 outreach</option>
          <option value="bulk">Bulk / marketing</option>
        </Select>

        <div className="ml-auto flex items-center gap-3">
          {saved && !saving && (
            <span className="text-success flex items-center gap-1 text-sm">
              <Check className="size-4" /> Saved
            </span>
          )}
          <Button onClick={save} disabled={saving || blocked} size="sm">
            {saving ? <Loader2 className="animate-spin" /> : <Check />}
            {templateId ? 'Save' : 'Create'}
          </Button>
        </div>
      </div>

      {error && (
        <div
          role="alert"
          className="border-danger/30 bg-danger/10 text-danger m-6 mb-0 rounded-lg border p-3 text-sm"
        >
          {error}
        </div>
      )}

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-6 p-6 lg:grid-cols-2">
        {/* ── editor ─────────────────────────────────────────────────── */}
        <div className="flex min-w-0 flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="subject">Subject</Label>
            <Input
              id="subject"
              value={subjectTpl}
              onChange={(e) => setSubjectTpl(e.target.value)}
              placeholder="Quick question, {{company}}"
              className="font-mono"
            />
          </div>

          <div className="flex min-h-0 flex-1 flex-col gap-1.5">
            <Label htmlFor="body">Body</Label>
            <Textarea
              id="body"
              ref={bodyRef}
              value={bodyTpl}
              onChange={(e) => setBodyTpl(e.target.value)}
              placeholder={'Hi {{ first_name | default: there }},\n\n…\n\n— Sam'}
              className="min-h-[22rem] flex-1"
              spellCheck
            />
          </div>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">Insert</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-1.5">
              {variables.map((variable) => (
                <button
                  key={variable}
                  type="button"
                  onClick={() => insert(`{{${variable}}}`)}
                  className="border-border bg-surface-muted text-ink-muted hover:border-border-strong hover:text-ink rounded-md border px-2 py-1 font-mono text-xs transition-colors"
                >
                  {`{{${variable}}}`}
                </button>
              ))}
              <button
                type="button"
                onClick={() => insert('{{ai:opening}}')}
                className="border-accent/30 bg-accent/10 text-accent hover:bg-accent/20 rounded-md border px-2 py-1 font-mono text-xs transition-colors"
                title="A bounded slot the model fills per recipient (phase 3)"
              >
                <Sparkles className="mr-1 inline size-3" />
                {'{{ai:opening}}'}
              </button>
              <button
                type="button"
                onClick={() => insert('{{#if company}}\n\n{{/if}}')}
                className="border-border bg-surface-muted text-ink-muted hover:border-border-strong hover:text-ink rounded-md border px-2 py-1 font-mono text-xs transition-colors"
              >
                {'{{#if …}}'}
              </button>
            </CardContent>
          </Card>

          {check.slots.length > 0 && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-1.5 text-sm">
                  <Sparkles className="size-4" />
                  AI slot: {check.slots.join(', ')}
                </CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="brief">What should the model write?</Label>
                  <Textarea
                    id="brief"
                    value={brief}
                    onChange={(e) => setBrief(e.target.value)}
                    rows={2}
                    className="min-h-0 font-sans"
                  />
                </div>

                <div className="flex flex-wrap gap-3">
                  <div className="flex min-w-40 flex-1 flex-col gap-1.5">
                    <Label htmlFor="tone">Tone</Label>
                    <Input id="tone" value={tone} onChange={(e) => setTone(e.target.value)} />
                  </div>
                  <div className="flex w-32 flex-col gap-1.5">
                    <Label htmlFor="max-sentences">Max sentences</Label>
                    <Input
                      id="max-sentences"
                      type="number"
                      min={0}
                      max={10}
                      value={maxSentences}
                      onChange={(e) => setMaxSentences(Number(e.target.value))}
                    />
                  </div>
                </div>

                <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                  {(Object.keys(GUARDRAIL_LABELS) as GuardrailKey[]).map((key) => (
                    <label key={key} className="text-ink-muted flex items-center gap-1.5 text-xs">
                      <input
                        type="checkbox"
                        checked={guardrails.includes(key)}
                        onChange={(e) =>
                          setGuardrails((current) =>
                            e.target.checked ? [...current, key] : current.filter((k) => k !== key),
                          )
                        }
                      />
                      {GUARDRAIL_LABELS[key]}
                    </label>
                  ))}
                </div>

                {hasApiKey ? (
                  <Button onClick={generate} disabled={generating} size="sm" variant="secondary">
                    {generating ? <Loader2 className="animate-spin" /> : <Sparkles />}
                    {generating ? 'Generating…' : 'Try it on this contact'}
                  </Button>
                ) : (
                  <p className="text-ink-subtle text-xs">
                    Add an Anthropic key in{' '}
                    <Link href="/settings/ai" className="text-accent underline">
                      Settings → AI
                    </Link>{' '}
                    to fill this slot. Everything else works without one.
                  </p>
                )}

                {genError && (
                  <p role="alert" className="text-danger text-xs">
                    {genError}
                  </p>
                )}
              </CardContent>
            </Card>
          )}

          {(check.errors.length > 0 || check.warnings.length > 0) && (
            <div className="flex flex-col gap-1.5">
              {check.errors.map((e, i) => (
                <p
                  key={`e${i}`}
                  className="border-danger/30 bg-danger/10 text-danger rounded-lg border px-3 py-2 text-sm"
                >
                  <AlertTriangle className="mr-1.5 inline size-3.5" />
                  Line {e.line}: {e.message}
                </p>
              ))}
              {check.warnings.map((w, i) => (
                <p
                  key={`w${i}`}
                  className="border-warning/30 bg-warning/10 text-warning rounded-lg border px-3 py-2 text-sm"
                >
                  <Info className="mr-1.5 inline size-3.5" />
                  {w.message}
                </p>
              ))}
            </div>
          )}
        </div>

        {/* ── preview ────────────────────────────────────────────────── */}
        <div className="flex min-w-0 flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={listId}
              onChange={(e) => void selectList(e.target.value)}
              className="h-8 w-auto text-xs"
              aria-label="Preview against list"
            >
              <option value="">Sample contact</option>
              {lists.map((list) => (
                <option key={list.id} value={list.id}>
                  {list.name} ({list.contactCount})
                </option>
              ))}
            </Select>

            {previewRows.length > 1 && (
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label="Previous contact"
                  disabled={rowIndex === 0}
                  onClick={() => setRowIndex((i) => Math.max(0, i - 1))}
                >
                  <ChevronLeft />
                </Button>
                <span className="text-ink-muted text-xs tabular-nums">
                  {rowIndex + 1} of {previewRows.length}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label="Next contact"
                  disabled={rowIndex >= previewRows.length - 1}
                  onClick={() => setRowIndex((i) => Math.min(previewRows.length - 1, i + 1))}
                >
                  <ChevronRight />
                </Button>
              </div>
            )}

            {loadingRows && <Loader2 className="text-ink-subtle size-4 animate-spin" />}

            <div className="border-border ml-auto flex overflow-hidden rounded-lg border">
              <button
                type="button"
                onClick={() => setView('text')}
                className={`px-2.5 py-1 text-xs transition-colors ${
                  view === 'text' ? 'bg-surface-muted text-ink' : 'text-ink-muted'
                }`}
              >
                <Type className="mr-1 inline size-3" />
                Text
              </button>
              <button
                type="button"
                onClick={() => setView('html')}
                className={`border-border border-l px-2.5 py-1 text-xs transition-colors ${
                  view === 'html' ? 'bg-surface-muted text-ink' : 'text-ink-muted'
                }`}
              >
                <Code className="mr-1 inline size-3" />
                HTML
              </button>
            </div>
          </div>

          <Card className="flex min-h-0 flex-1 flex-col">
            <div className="border-border flex flex-col gap-1 border-b p-4 text-sm">
              <div className="flex gap-2">
                <span className="text-ink-subtle w-12 shrink-0">To</span>
                <span className="truncate">{current.email}</span>
              </div>
              <div className="flex gap-2">
                <span className="text-ink-subtle w-12 shrink-0">Subject</span>
                <span className="font-medium">
                  {preview.subject || <span className="text-ink-subtle italic">empty</span>}
                </span>
              </div>
            </div>

            <CardContent className="min-h-0 flex-1 overflow-auto p-4">
              {view === 'text' ? (
                <pre className="text-ink font-sans text-sm leading-relaxed whitespace-pre-wrap">
                  {preview.body || <span className="text-ink-subtle italic">empty</span>}
                </pre>
              ) : (
                <div
                  className="text-ink prose-sm text-sm leading-relaxed [&_a]:underline [&_p]:mb-3"
                  // The rendered HTML is produced by textToHtml, which escapes
                  // every merge value before markup is added — see html.ts.
                  dangerouslySetInnerHTML={{ __html: preview.html }}
                />
              )}
            </CardContent>

            {(preview.unresolved.length > 0 || preview.slots.length > 0) && (
              <div className="border-border flex flex-wrap gap-1.5 border-t p-3">
                {preview.unresolved.map((variable) => (
                  <Badge key={variable} tone="warning">
                    {`{{${variable}}}`} is empty on this row
                  </Badge>
                ))}
                {preview.slots.map((slot) => (
                  <Badge key={slot} tone="accent">
                    <Sparkles className="size-3" />
                    {`{{ai:${slot}}}`} fills at generation
                  </Badge>
                ))}
              </div>
            )}

            {Object.entries(slotFills).length > 0 && (
              <div className="border-border flex flex-col gap-1.5 border-t p-3">
                {Object.entries(slotFills).map(([slot, fill]) => (
                  <div key={slot} className="flex flex-wrap items-center gap-1.5">
                    <Badge tone="accent">
                      <Sparkles className="size-3" />
                      {slot}
                    </Badge>
                    <Badge tone={fill.cacheHit ? 'success' : 'neutral'}>
                      {formatUsd(fill.costUsd)}
                      {fill.cacheHit ? ' · cached prefix' : ' · cache written'}
                    </Badge>
                    {fill.violations.map((violation, i) => (
                      <Badge key={i} tone={violation.severity === 'error' ? 'danger' : 'warning'}>
                        {violation.message}
                      </Badge>
                    ))}
                    {fill.violations.length === 0 && (
                      <Badge tone="success">passed guardrails</Badge>
                    )}
                  </div>
                ))}
              </div>
            )}
          </Card>

          {usingSample && (
            <p className="text-ink-subtle text-xs">
              Previewing against a sample contact. Choose a list to step through your real rows —
              that is where empty cells and odd casing show up.
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
