'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { AlertTriangle, Check, Eye, KeyRound, Loader2, Trash2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input, Label } from '@/components/ui/select'
import { MODELS, MODEL_IDS, type ModelId } from '@/core/ai/models'
import { estimate, formatUsd } from '@/core/ai/cost'
import { removeApiKey, saveApiKey, updateAiSettings, type UsageSummary } from '../actions'

interface Props {
  credential: {
    keyLast4: string
    defaultModel: string
    usePromptCaching: boolean
    useBatchApi: boolean
    lastValidatedAt: Date | null
  } | null
  usage: UsageSummary
}

/** Representative shape of one slot generation, for the cost illustration. */
const TYPICAL = { systemTokens: 1500, perRowInputTokens: 200, perRowOutputTokens: 250 }

export function AiSettings({ credential, usage }: Props) {
  const router = useRouter()
  const [keyInput, setKeyInput] = useState('')
  const [reveal, setReveal] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const [model, setModel] = useState<ModelId>(
    (MODEL_IDS.includes(credential?.defaultModel as ModelId)
      ? credential?.defaultModel
      : 'claude-haiku-4-5') as ModelId,
  )
  const [caching, setCaching] = useState(credential?.usePromptCaching ?? true)
  const [batch, setBatch] = useState(credential?.useBatchApi ?? true)

  const perThousand = estimate({
    model,
    rows: 1000,
    ...TYPICAL,
    useCaching: caching,
    useBatch: batch,
  })
  const unoptimised = estimate({
    model,
    rows: 1000,
    ...TYPICAL,
    useCaching: false,
    useBatch: false,
  })

  function save() {
    setError(null)
    setNotice(null)
    startTransition(async () => {
      const result = await saveApiKey(keyInput)
      if (!result.ok) {
        setError(result.error)
        return
      }
      setKeyInput('')
      setNotice(`Key ending ${result.data.last4} verified and saved.`)
      router.refresh()
    })
  }

  function remove() {
    setError(null)
    setNotice(null)
    startTransition(async () => {
      const result = await removeApiKey()
      if (!result.ok) {
        setError(result.error)
        return
      }
      setNotice('Key removed. Template-only mode still works.')
      router.refresh()
    })
  }

  function saveSettings(next: Partial<{ model: ModelId; caching: boolean; batch: boolean }>) {
    const payload = {
      defaultModel: next.model ?? model,
      usePromptCaching: next.caching ?? caching,
      useBatchApi: next.batch ?? batch,
    }
    startTransition(async () => {
      const result = await updateAiSettings(payload)
      if (!result.ok) setError(result.error)
    })
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
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
        <div className="border-success/30 bg-success/10 text-success flex items-start gap-2 rounded-lg border p-3 text-sm">
          <Check className="mt-0.5 size-4 shrink-0" />
          {notice}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Anthropic API key</CardTitle>
          <CardDescription>
            This app ships no key of its own. Yours is encrypted with AES-256-GCM before it is
            stored and is never sent back to the browser.
          </CardDescription>
        </CardHeader>

        <CardContent className="flex flex-col gap-4">
          {credential ? (
            <div className="border-border bg-surface-muted flex items-center justify-between gap-3 rounded-lg border p-3">
              <div className="flex items-center gap-2.5">
                <KeyRound className="text-ink-muted size-4" />
                <div>
                  <p className="font-mono text-sm">sk-ant-…{credential.keyLast4}</p>
                  <p className="text-ink-subtle text-xs">
                    {credential.lastValidatedAt
                      ? `Verified ${new Date(credential.lastValidatedAt).toLocaleDateString()}`
                      : 'Not yet verified'}
                  </p>
                </div>
              </div>
              <Button variant="ghost" size="sm" onClick={remove} disabled={pending}>
                <Trash2 /> Remove
              </Button>
            </div>
          ) : (
            <div className="border-warning/30 bg-warning/10 text-warning rounded-lg border p-3 text-sm">
              No key configured. AI slots stay empty; everything else — merge variables,
              conditionals, preview, review, send — works exactly as it does with one.
            </div>
          )}

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="api-key">{credential ? 'Replace key' : 'Add key'}</Label>
            <div className="flex gap-2">
              <Input
                id="api-key"
                type={reveal ? 'text' : 'password'}
                value={keyInput}
                onChange={(e) => setKeyInput(e.target.value)}
                placeholder="sk-ant-api03-…"
                className="font-mono"
                autoComplete="off"
                spellCheck={false}
              />
              <Button
                variant="secondary"
                size="md"
                aria-label={reveal ? 'Hide key' : 'Show key'}
                onClick={() => setReveal((v) => !v)}
              >
                <Eye />
              </Button>
              <Button onClick={save} disabled={pending || keyInput.trim().length < 20}>
                {pending ? <Loader2 className="animate-spin" /> : <Check />}
                Verify &amp; save
              </Button>
            </div>
            <p className="text-ink-subtle text-xs">
              Checked against Anthropic before saving, so a truncated paste fails here rather than
              partway through a campaign. Get one at console.anthropic.com.
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Model and cost</CardTitle>
          <CardDescription>
            Applies to new generation. Existing campaigns keep the model they were generated with.
          </CardDescription>
        </CardHeader>

        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            {MODEL_IDS.map((id) => {
              const info = MODELS[id]
              const cost = estimate({
                model: id,
                rows: 1000,
                ...TYPICAL,
                useCaching: caching,
                useBatch: batch,
              })
              return (
                <label
                  key={id}
                  className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors ${
                    model === id
                      ? 'border-accent bg-accent/5'
                      : 'border-border hover:border-border-strong'
                  }`}
                >
                  <input
                    type="radio"
                    name="model"
                    value={id}
                    checked={model === id}
                    disabled={!credential || pending}
                    onChange={() => {
                      setModel(id)
                      saveSettings({ model: id })
                    }}
                    className="mt-1"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-2">
                      <span className="text-sm font-medium">{info.label}</span>
                      <span className="text-ink-subtle font-mono text-xs">
                        ${info.inputPerMTok}/${info.outputPerMTok} per MTok
                      </span>
                    </div>
                    <p className="text-ink-muted mt-0.5 text-sm">{info.blurb}</p>
                    <p className="text-ink-subtle mt-1 text-xs">
                      ≈ {formatUsd(cost.costUsd)} per 1,000 emails
                    </p>
                  </div>
                </label>
              )
            })}
          </div>

          <div className="border-border flex flex-col gap-3 border-t pt-4">
            <label className="flex items-start gap-2.5 text-sm">
              <input
                type="checkbox"
                checked={caching}
                disabled={!credential || pending}
                onChange={(e) => {
                  setCaching(e.target.checked)
                  saveSettings({ caching: e.target.checked })
                }}
                className="mt-0.5"
              />
              <span>
                <span className="font-medium">Prompt caching</span>
                <span className="text-ink-muted block text-xs">
                  The brief, guardrails and template are identical for every recipient, so they are
                  cached once and billed at a tenth of the input rate thereafter. This is where most
                  of the saving comes from.
                </span>
              </span>
            </label>

            <label className="flex items-start gap-2.5 text-sm">
              <input
                type="checkbox"
                checked={batch}
                disabled={!credential || pending}
                onChange={(e) => {
                  setBatch(e.target.checked)
                  saveSettings({ batch: e.target.checked })
                }}
                className="mt-0.5"
              />
              <span>
                <span className="font-medium">Batch API for bulk generation</span>
                <span className="text-ink-muted block text-xs">
                  Half price, results within 24 hours. You are reviewing tomorrow anyway. Single-row
                  regeneration always runs immediately regardless. Used from phase 4.
                </span>
              </span>
            </label>
          </div>

          <div className="border-border bg-surface-muted rounded-lg border p-3 text-sm">
            <div className="flex items-baseline justify-between">
              <span className="text-ink-muted">Estimated per 1,000 emails</span>
              <span className="font-medium tabular-nums">{formatUsd(perThousand.costUsd)}</span>
            </div>
            {perThousand.costUsd < unoptimised.costUsd && (
              <p className="text-ink-subtle mt-1 text-xs">
                {formatUsd(unoptimised.costUsd)} without caching and batching — a{' '}
                {Math.round((1 - perThousand.costUsd / unoptimised.costUsd) * 100)}% saving.
              </p>
            )}
            <p className="text-ink-subtle mt-1 text-xs">
              An estimate from typical token counts. The figure below is what you were actually
              billed.
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Actual usage</CardTitle>
          <CardDescription>
            Summed from the usage reported on every API response — measured, not estimated.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex items-baseline justify-between">
            <span className="text-ink-muted text-sm">This month</span>
            <span className="text-lg font-medium tabular-nums">
              {formatUsd(usage.monthCostUsd)}
            </span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <Badge>{usage.monthCalls.toLocaleString()} calls</Badge>
            <Badge>{usage.inputTokens.toLocaleString()} input</Badge>
            {usage.cacheReadTokens > 0 && (
              <Badge tone="success">{usage.cacheReadTokens.toLocaleString()} cached at 10%</Badge>
            )}
            <Badge>{usage.outputTokens.toLocaleString()} output</Badge>
          </div>
          {usage.totalCostUsd > usage.monthCostUsd && (
            <p className="text-ink-subtle text-xs">{formatUsd(usage.totalCostUsd)} all time.</p>
          )}
          {usage.monthCalls === 0 && (
            <p className="text-ink-subtle text-sm">Nothing generated yet.</p>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
