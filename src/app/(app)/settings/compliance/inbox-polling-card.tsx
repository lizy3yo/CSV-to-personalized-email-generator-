'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { AlertTriangle, Eye, Loader2, ShieldAlert } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { createClient } from '@/lib/supabase/client'
import { scopeStringFor } from '@/core/gmail/scopes'
import { setInboxPolling } from '../actions'

/**
 * The opt-in for bounce and reply detection.
 *
 * Presented honestly, because the trade-off is real: Gmail pushes neither
 * bounces nor replies, so the only way to see them is to read the mailbox —
 * and `gmail.readonly` grants far more than the app needs for sending.
 */
export function InboxPollingCard({
  enabled,
  hasReadScope,
  lastPolledAt,
}: {
  enabled: boolean
  hasReadScope: boolean
  lastPolledAt: Date | null
}) {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  async function grantAccess() {
    setError(null)
    const supabase = createClient()
    const redirect = new URL('/auth/callback', window.location.origin)
    redirect.searchParams.set('next', '/settings/compliance')
    redirect.searchParams.set('scopes', 'read')

    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        scopes: scopeStringFor(true),
        redirectTo: redirect.toString(),
        // A fresh consent is required to widen a grant; without prompt=consent
        // Google returns the existing, narrower one.
        queryParams: { access_type: 'offline', prompt: 'consent' },
      },
    })
    if (error) setError(error.message)
  }

  function toggle(next: boolean) {
    setError(null)
    startTransition(async () => {
      const result = await setInboxPolling(next)
      if (!result.ok) {
        setError(result.error)
        return
      }
      router.refresh()
    })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Eye className="size-4" />
          Bounce and reply detection
        </CardTitle>
        <CardDescription>Off by default, and worth reading before turning on.</CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        {error && (
          <div
            role="alert"
            className="border-danger/30 bg-danger/10 text-danger flex items-start gap-2 rounded-lg border p-3 text-sm"
          >
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            {error}
          </div>
        )}

        <div className="border-warning/30 bg-warning/10 text-warning flex items-start gap-2 rounded-lg border p-3 text-sm">
          <ShieldAlert className="mt-0.5 size-4 shrink-0" />
          <span className="leading-relaxed">
            This needs <code className="font-mono">gmail.readonly</code>, which grants read access
            to your <em>entire</em> mailbox — far more than sending requires. Gmail offers no
            narrower permission and pushes no bounce notifications, so there is no way to detect a
            failed delivery without it. Leaving this off costs you automatic suppression; you can
            still add bounced addresses by hand.
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={enabled ? 'success' : 'neutral'}>{enabled ? 'On' : 'Off'}</Badge>
          <Badge tone={hasReadScope ? 'success' : 'warning'}>
            {hasReadScope ? 'Read access granted' : 'Read access not granted'}
          </Badge>
          {lastPolledAt && (
            <Badge tone="neutral">Last checked {new Date(lastPolledAt).toLocaleString()}</Badge>
          )}
        </div>

        <ul className="text-ink-muted flex list-disc flex-col gap-1 pl-5 text-sm">
          <li>Hard bounces are suppressed automatically; soft ones are only recorded.</li>
          <li>Replies are matched by thread and shown on the campaign report.</li>
          <li>Checked every 15 minutes by the background worker.</li>
        </ul>

        <div className="flex flex-wrap gap-2">
          {!hasReadScope && (
            <Button variant="secondary" onClick={grantAccess} disabled={pending}>
              <Eye /> Grant mailbox read access
            </Button>
          )}
          {enabled ? (
            <Button variant="ghost" onClick={() => toggle(false)} disabled={pending}>
              {pending ? <Loader2 className="animate-spin" /> : null} Turn off
            </Button>
          ) : (
            <Button onClick={() => toggle(true)} disabled={pending || !hasReadScope}>
              {pending ? <Loader2 className="animate-spin" /> : null} Turn on
            </Button>
          )}
        </div>

        {!hasReadScope && (
          <p className="text-ink-subtle text-xs">
            Granting access signs you in again through Google and asks for the wider permission.
            Nothing is read until you also turn detection on.
          </p>
        )}
      </CardContent>
    </Card>
  )
}
