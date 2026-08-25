'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { AlertTriangle, Check, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input, Label, Textarea } from '@/components/ui/select'
import { buildFooterText, DEFAULT_OPT_OUT_LINE } from '@/core/compliance/footer'
import { updateComplianceSettings } from '../actions'

export function ComplianceSettings({
  initial,
}: {
  initial: { senderName: string; postalAddress: string; optOutLine: string }
}) {
  const router = useRouter()
  const [senderName, setSenderName] = useState(initial.senderName)
  const [postalAddress, setPostalAddress] = useState(initial.postalAddress)
  const [optOutLine, setOptOutLine] = useState(initial.optOutLine)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [pending, startTransition] = useTransition()

  const previewOneToOne = buildFooterText({
    profile: 'one_to_one',
    postalAddress,
    optOutLine,
    unsubscribeUrl: 'https://example.test/api/unsubscribe/…',
  })
  const previewBulk = buildFooterText({
    profile: 'bulk',
    postalAddress,
    unsubscribeUrl: 'https://example.test/unsubscribe/…',
    consentSource: 'you signed up on our website',
  })

  function save() {
    setError(null)
    setSaved(false)
    startTransition(async () => {
      const result = await updateComplianceSettings({ senderName, postalAddress, optOutLine })
      if (!result.ok) {
        setError(result.error)
        return
      }
      setSaved(true)
      router.refresh()
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

      {!postalAddress.trim() && (
        <div className="border-danger/30 bg-danger/10 text-danger flex items-start gap-2 rounded-lg border p-3 text-sm">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span>
            No postal address is set, so sending is blocked. CAN-SPAM requires a valid physical
            address in every commercial email — including 1:1 outreach.
          </span>
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Sender identity</CardTitle>
          <CardDescription>
            Used in the From header and the compliance footer of every message.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="sender-name">Display name</Label>
            <Input
              id="sender-name"
              value={senderName}
              onChange={(e) => setSenderName(e.target.value)}
              placeholder="Sam Reyes"
            />
            <p className="text-ink-subtle text-xs">
              Optional. Without it, mail goes out under the bare address.
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="postal">
              Physical postal address <span className="text-danger">required</span>
            </Label>
            <Textarea
              id="postal"
              value={postalAddress}
              onChange={(e) => setPostalAddress(e.target.value)}
              rows={3}
              className="font-sans"
              placeholder={'Acme Ltd\n1 Main Street\nBristol BS1 4ST\nUnited Kingdom'}
            />
            <p className="text-ink-subtle text-xs leading-relaxed">
              A real address where post can reach you — a registered office or a PO box both
              qualify. This is a legal requirement, so the send preflight blocks without it rather
              than warning.
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="opt-out">Opt-out sentence for 1:1 outreach</Label>
            <Input
              id="opt-out"
              value={optOutLine}
              onChange={(e) => setOptOutLine(e.target.value)}
              placeholder={DEFAULT_OPT_OUT_LINE}
            />
            <p className="text-ink-subtle text-xs leading-relaxed">
              A personal email gets a human sentence rather than a newsletter footer. The
              machine-readable opt-out still rides in the List-Unsubscribe headers, where Gmail
              turns it into a native unsubscribe control.
            </p>
          </div>

          <div className="flex items-center gap-3">
            <Button onClick={save} disabled={pending}>
              {pending ? <Loader2 className="animate-spin" /> : <Check />} Save
            </Button>
            {saved && !pending && (
              <span className="text-success flex items-center gap-1 text-sm">
                <Check className="size-4" /> Saved
              </span>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>What gets appended</CardTitle>
          <CardDescription>
            Composed at send time, not at generation — so a corrected address applies to everything
            still unsent, and the unsubscribe link is unique per recipient.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div>
            <p className="text-ink-muted mb-1.5 text-xs font-medium">1:1 outreach</p>
            <pre className="border-border bg-surface-muted text-ink rounded-lg border p-3 font-sans text-sm whitespace-pre-wrap">
              {previewOneToOne || <span className="text-ink-subtle italic">nothing yet</span>}
            </pre>
          </div>
          <div>
            <p className="text-ink-muted mb-1.5 text-xs font-medium">Bulk / marketing</p>
            <pre className="border-border bg-surface-muted text-ink rounded-lg border p-3 font-sans text-sm whitespace-pre-wrap">
              {previewBulk}
            </pre>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
