'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import Papa from 'papaparse'
import { AlertTriangle, ArrowLeft, Check, FileUp, Info, Loader2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input, Label, Select } from '@/components/ui/select'
import { detectColumns, toVariableName } from '@/core/csv/detect'
import { importableRows, ingest } from '@/core/csv/ingest'
import { looksLikeCsvFile } from '@/core/csv/sanitize'
import {
  AMBIGUOUS_THRESHOLD,
  LIMITS,
  type ColumnMap,
  type ColumnRole,
  type DetectedColumn,
  type RawRow,
} from '@/core/csv/types'
import {
  appendContacts,
  createContactList,
  finalizeContactList,
  getSuppressedEmails,
} from '../actions'

type Stage = 'upload' | 'parsing' | 'map' | 'importing' | 'done'

const ROLE_LABELS: Record<ColumnRole, string> = {
  email: 'Email',
  merge_var: 'Merge variable',
  ai_context: 'AI context',
  ignore: 'Ignore',
}

const CONSENT_OPTIONS = [
  { value: 'consent', label: 'Explicit consent — they opted in' },
  { value: 'legitimate_interest', label: 'Legitimate interest — existing business relationship' },
  { value: 'contract', label: 'Contract — necessary to fulfil an agreement' },
  { value: 'unknown', label: 'Not recorded' },
] as const

export function ImportWizard() {
  const router = useRouter()
  const fileInput = useRef<HTMLInputElement>(null)

  const [stage, setStage] = useState<Stage>('upload')
  const [error, setError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)

  const [filename, setFilename] = useState('')
  const [rows, setRows] = useState<RawRow[]>([])
  const [columns, setColumns] = useState<DetectedColumn[]>([])
  const [suppressed, setSuppressed] = useState<ReadonlySet<string>>(new Set())

  const [listName, setListName] = useState('')
  const [consentBasis, setConsentBasis] =
    useState<(typeof CONSENT_OPTIONS)[number]['value']>('legitimate_interest')
  const [consentSource, setConsentSource] = useState('')

  const [showIssues, setShowIssues] = useState(false)
  const [progress, setProgress] = useState({ done: 0, total: 0 })

  // Fetched up front so the preview can report suppressed rows before import.
  // appendContacts re-checks server-side; this copy is for the summary only.
  useEffect(() => {
    getSuppressedEmails()
      .then((list) => setSuppressed(new Set(list)))
      .catch(() => setSuppressed(new Set()))
  }, [])

  const columnMap: ColumnMap = useMemo(() => {
    const map: ColumnMap = {}
    for (const column of columns) {
      map[column.header] = {
        role: column.role,
        variable:
          column.role === 'merge_var' || column.role === 'ai_context'
            ? (column.variable ?? toVariableName(column.header))
            : undefined,
      }
    }
    return map
  }, [columns])

  const result = useMemo(
    () => ingest({ rows, columnMap, suppressed }),
    [rows, columnMap, suppressed],
  )

  const emailColumnChosen = columns.some((c) => c.role === 'email')
  const importable = useMemo(() => importableRows(result), [result])
  const issues = useMemo(() => result.rows.filter((r) => r.status !== 'valid'), [result])
  const ambiguous = columns.filter((c) => c.confidence < AMBIGUOUS_THRESHOLD)

  const handleFile = useCallback((file: File) => {
    setError(null)

    const check = looksLikeCsvFile(file)
    if (!check.ok) {
      setError(check.reason ?? 'That file cannot be imported')
      return
    }

    setStage('parsing')
    setFilename(file.name)
    setListName(file.name.replace(/\.(csv|tsv|txt)$/i, ''))

    Papa.parse<RawRow>(file, {
      header: true,
      skipEmptyLines: 'greedy',
      transformHeader: (header) => header.trim(),
      complete: ({ data, meta, errors }) => {
        const headers = (meta.fields ?? []).filter(Boolean)

        if (headers.length === 0) {
          setError('No column headers found. The first row must contain header names.')
          setStage('upload')
          return
        }
        if (data.length === 0) {
          setError('The file has headers but no data rows.')
          setStage('upload')
          return
        }
        if (data.length > LIMITS.MAX_ROWS) {
          setError(
            `${data.length.toLocaleString()} rows exceeds the ${LIMITS.MAX_ROWS.toLocaleString()} row limit. Split the file and import it in parts.`,
          )
          setStage('upload')
          return
        }

        // Ragged rows are reported but not fatal — a trailing comma should not
        // block an import that is otherwise fine, and per-row validation will
        // catch anything that actually matters.
        const fatal = errors.filter((e) => e.type === 'Quotes')
        if (fatal.length > 0) {
          setError(`Malformed quoting on row ${(fatal[0].row ?? 0) + 2}. Check the file and retry.`)
          setStage('upload')
          return
        }

        setRows(data)
        setColumns(detectColumns(headers, data))
        setStage('map')
      },
      error: (parseError: Error) => {
        setError(`Could not read the file: ${parseError.message}`)
        setStage('upload')
      },
    })
  }, [])

  function setRole(header: string, role: ColumnRole) {
    setColumns((current) =>
      current.map((column) => {
        // Exactly one email column: choosing a new one demotes the old.
        if (role === 'email' && column.role === 'email' && column.header !== header) {
          return {
            ...column,
            role: 'merge_var',
            variable: column.variable ?? toVariableName(column.header),
          }
        }
        if (column.header !== header) return column
        return {
          ...column,
          role,
          variable:
            role === 'merge_var' || role === 'ai_context'
              ? (column.variable ?? toVariableName(column.header))
              : undefined,
          confidence: 1,
          reason: 'Set by you',
        }
      }),
    )
  }

  async function runImport() {
    setError(null)
    setStage('importing')
    setProgress({ done: 0, total: importable.length })

    const created = await createContactList({
      name: listName.trim() || filename,
      sourceFilename: filename,
      columnMap,
      consentBasis,
      consentSource: consentSource.trim() || undefined,
    })

    if (!created.ok) {
      setError(created.error)
      setStage('map')
      return
    }

    const { listId } = created.data

    for (let i = 0; i < importable.length; i += LIMITS.CHUNK_SIZE) {
      const chunk = importable.slice(i, i + LIMITS.CHUNK_SIZE).map((row) => ({
        email: row.email,
        emailRaw: row.emailRaw,
        data: row.data,
        rowNumber: row.rowNumber,
      }))

      const appended = await appendContacts({ listId, rows: chunk })
      if (!appended.ok) {
        setError(`${appended.error} (stopped after ${i} of ${importable.length} rows)`)
        setStage('map')
        return
      }
      setProgress({
        done: Math.min(i + LIMITS.CHUNK_SIZE, importable.length),
        total: importable.length,
      })
    }

    const finalized = await finalizeContactList({ listId, summary: result.summary })
    if (!finalized.ok) {
      setError(finalized.error)
      setStage('map')
      return
    }

    setStage('done')
    router.push('/contacts')
  }

  // ── upload ────────────────────────────────────────────────────────────────
  if (stage === 'upload' || stage === 'parsing') {
    return (
      <div className="mx-auto w-full max-w-2xl">
        {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

        <div
          onDragOver={(e) => {
            e.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault()
            setDragging(false)
            const file = e.dataTransfer.files[0]
            if (file) handleFile(file)
          }}
          className={`rounded-card border-2 border-dashed p-12 text-center transition-colors ${
            dragging ? 'border-accent bg-accent/5' : 'border-border'
          }`}
        >
          {stage === 'parsing' ? (
            <>
              <Loader2 className="text-accent mx-auto size-8 animate-spin" />
              <p className="mt-4 text-sm font-medium">Reading {filename}…</p>
            </>
          ) : (
            <>
              <FileUp className="text-ink-subtle mx-auto size-8" />
              <p className="mt-4 text-sm font-medium">Drop a CSV here</p>
              <p className="text-ink-muted mt-1 text-sm">or</p>
              <Button
                variant="secondary"
                className="mt-3"
                onClick={() => fileInput.current?.click()}
              >
                Choose a file
              </Button>
              <input
                ref={fileInput}
                type="file"
                accept=".csv,.tsv,.txt,text/csv"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  if (file) handleFile(file)
                  e.target.value = ''
                }}
              />
              <p className="text-ink-subtle mt-6 text-xs leading-relaxed">
                Up to {LIMITS.MAX_ROWS.toLocaleString()} rows.
                <br />
                The file is read in your browser and never uploaded — only the columns you map are
                sent to the server.
              </p>
            </>
          )}
        </div>
      </div>
    )
  }

  // ── importing ─────────────────────────────────────────────────────────────
  if (stage === 'importing' || stage === 'done') {
    const percent = progress.total === 0 ? 100 : Math.round((progress.done / progress.total) * 100)
    return (
      <div className="mx-auto w-full max-w-md text-center">
        <Loader2 className="text-accent mx-auto size-8 animate-spin" />
        <p className="mt-4 text-sm font-medium">Importing contacts…</p>
        <div className="bg-surface-muted mt-4 h-2 overflow-hidden rounded-full">
          <div
            className="bg-accent h-full transition-[width] duration-300"
            style={{ width: `${percent}%` }}
          />
        </div>
        <p className="text-ink-muted mt-2 text-sm tabular-nums">
          {progress.done.toLocaleString()} of {progress.total.toLocaleString()}
        </p>
      </div>
    )
  }

  // ── map ───────────────────────────────────────────────────────────────────
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <div>
            <CardTitle>Map your columns</CardTitle>
            <p className="text-ink-muted mt-1 text-sm">
              {filename} · {rows.length.toLocaleString()} rows
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={() => setStage('upload')}>
            <ArrowLeft /> Change file
          </Button>
        </CardHeader>

        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-border text-ink-muted border-y text-left text-xs">
                  <th className="px-5 py-2 font-medium">CSV column</th>
                  <th className="px-3 py-2 font-medium">Sample</th>
                  <th className="px-3 py-2 font-medium">Role</th>
                  <th className="px-5 py-2 font-medium">Variable</th>
                </tr>
              </thead>
              <tbody className="divide-border divide-y">
                {columns.map((column) => (
                  <tr key={column.header}>
                    <td className="max-w-[12rem] px-5 py-2.5">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate font-medium" title={column.header}>
                          {column.header}
                        </span>
                        <span title={column.reason}>
                          <Info className="text-ink-subtle size-3.5 shrink-0" />
                        </span>
                      </div>
                    </td>
                    <td className="text-ink-muted max-w-[14rem] px-3 py-2.5">
                      <span className="block truncate" title={column.samples.join(' · ')}>
                        {column.samples[0] ?? <span className="text-ink-subtle">empty</span>}
                      </span>
                    </td>
                    <td className="w-44 px-3 py-2.5">
                      <Select
                        value={column.role}
                        aria-label={`Role for ${column.header}`}
                        onChange={(e) => setRole(column.header, e.target.value as ColumnRole)}
                      >
                        {(Object.keys(ROLE_LABELS) as ColumnRole[]).map((role) => (
                          <option key={role} value={role}>
                            {ROLE_LABELS[role]}
                          </option>
                        ))}
                      </Select>
                    </td>
                    <td className="w-44 px-5 py-2.5">
                      {column.role === 'merge_var' || column.role === 'ai_context' ? (
                        <code className="text-ink-muted text-xs">
                          {'{{'}
                          {column.variable}
                          {'}}'}
                        </code>
                      ) : (
                        <span className="text-ink-subtle text-xs">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {!emailColumnChosen && (
        <div className="border-warning/30 bg-warning/10 text-warning rounded-lg border p-3 text-sm">
          <AlertTriangle className="mr-1.5 inline size-4" />
          No column is mapped to Email. Pick one to continue.
        </div>
      )}

      {ambiguous.length > 0 && emailColumnChosen && (
        <div className="border-border bg-surface-muted text-ink-muted rounded-lg border p-3 text-sm">
          <Info className="mr-1.5 inline size-4" />
          {ambiguous.length} column{ambiguous.length === 1 ? '' : 's'} could not be identified
          confidently ({ambiguous.map((c) => c.header).join(', ')}). Check the role is right.
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>What will be imported</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-wrap gap-2">
            <Badge tone="success">{result.summary.valid.toLocaleString()} ready</Badge>
            {result.summary.duplicate > 0 && (
              <Badge tone="warning">{result.summary.duplicate.toLocaleString()} duplicate</Badge>
            )}
            {result.summary.invalidEmail > 0 && (
              <Badge tone="danger">
                {result.summary.invalidEmail.toLocaleString()} invalid address
              </Badge>
            )}
            {result.summary.missingEmail > 0 && (
              <Badge tone="danger">
                {result.summary.missingEmail.toLocaleString()} missing address
              </Badge>
            )}
            {result.summary.suppressed > 0 && (
              <Badge tone="neutral">{result.summary.suppressed.toLocaleString()} suppressed</Badge>
            )}
            {issues.length > 0 && (
              <button
                type="button"
                onClick={() => setShowIssues((v) => !v)}
                className="text-accent text-xs underline underline-offset-2"
              >
                {showIssues ? 'Hide' : 'View'} {issues.length.toLocaleString()} issue
                {issues.length === 1 ? '' : 's'}
              </button>
            )}
          </div>

          {showIssues && (
            <div className="border-border max-h-72 overflow-auto rounded-lg border">
              <table className="w-full text-sm">
                <thead className="bg-surface-muted sticky top-0">
                  <tr className="text-ink-muted text-left text-xs">
                    <th className="px-3 py-2 font-medium">Row</th>
                    <th className="px-3 py-2 font-medium">Value</th>
                    <th className="px-3 py-2 font-medium">Problem</th>
                  </tr>
                </thead>
                <tbody className="divide-border divide-y">
                  {issues.slice(0, 500).map((row) => (
                    <tr key={row.rowNumber}>
                      <td className="text-ink-muted px-3 py-1.5 tabular-nums">{row.rowNumber}</td>
                      <td className="max-w-[16rem] truncate px-3 py-1.5">
                        {row.emailRaw || <span className="text-ink-subtle">empty</span>}
                      </td>
                      <td className="text-ink-muted px-3 py-1.5">{row.issue}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {issues.length > 500 && (
                <p className="text-ink-subtle border-border border-t px-3 py-2 text-xs">
                  Showing the first 500 of {issues.length.toLocaleString()}.
                </p>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>List details</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="list-name">List name</Label>
            <Input
              id="list-name"
              value={listName}
              onChange={(e) => setListName(e.target.value)}
              placeholder="Q3 outreach"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="consent-basis">Lawful basis for contacting these people</Label>
            <Select
              id="consent-basis"
              value={consentBasis}
              onChange={(e) =>
                setConsentBasis(e.target.value as (typeof CONSENT_OPTIONS)[number]['value'])
              }
            >
              {CONSENT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
            <p className="text-ink-subtle text-xs leading-relaxed">
              Recorded at import because it cannot be reconstructed afterwards. GDPR and CASL both
              expect you to know why you hold an address.
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="consent-source">Where did this list come from? (optional)</Label>
            <Input
              id="consent-source"
              value={consentSource}
              onChange={(e) => setConsentSource(e.target.value)}
              placeholder="Website signup form, June–August 2026"
            />
          </div>
        </CardContent>
      </Card>

      <div className="flex items-center justify-between pb-10">
        <p className="text-ink-muted text-sm">
          {importable.length.toLocaleString()} contact
          {importable.length === 1 ? '' : 's'} will be imported.
        </p>
        <Button onClick={runImport} disabled={!emailColumnChosen || importable.length === 0}>
          <Check /> Import {importable.length.toLocaleString()}
        </Button>
      </div>
    </div>
  )
}

function ErrorBanner({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div
      role="alert"
      className="border-danger/30 bg-danger/10 text-danger mb-4 flex items-start gap-2 rounded-lg border p-3 text-sm"
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0" />
      <span className="flex-1">{message}</span>
      <button type="button" onClick={onDismiss} aria-label="Dismiss">
        <X className="size-4" />
      </button>
    </div>
  )
}
