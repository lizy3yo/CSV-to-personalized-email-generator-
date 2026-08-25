import type { Metadata } from 'next'
import { eq } from 'drizzle-orm'
import { Check, Circle } from 'lucide-react'
import { db } from '@/db'
import { aiCredentials, googleAccounts } from '@/db/schema'
import { getCurrentUser } from '@/lib/supabase/server'
import { hasSendScope } from '@/core/gmail/scopes'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

export const metadata: Metadata = { title: 'Campaigns' }

/**
 * Phase 0 dashboard.
 *
 * There are no campaigns yet, so this shows what is actually wired up. It is
 * a real readiness check against the database, not placeholder copy — the
 * Gmail and AI rows here are the same checks the send preflight will use.
 */
export default async function CampaignsPage() {
  const user = await getCurrentUser()

  const [google, ai] = user
    ? await Promise.all([
        db.query.googleAccounts.findFirst({ where: eq(googleAccounts.userId, user.id) }),
        db.query.aiCredentials.findFirst({ where: eq(aiCredentials.userId, user.id) }),
      ])
    : [undefined, undefined]

  const gmailReady = Boolean(google && !google.revokedAt && hasSendScope(google.scopes))

  return (
    <>
      <header className="border-border flex h-14 shrink-0 items-center justify-between border-b px-6">
        <h1 className="text-sm font-semibold tracking-tight">Campaigns</h1>
      </header>

      <main className="flex-1 p-6">
        <div className="mx-auto flex max-w-3xl flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Setup</CardTitle>
              <CardDescription>
                Checked live against the database. The Gmail and AI rows are the same checks the
                send preflight runs.
              </CardDescription>
            </CardHeader>
            <CardContent className="divide-border flex flex-col divide-y">
              <StatusRow done label="Signed in" detail={user?.email ?? 'unknown account'} />
              <StatusRow
                done={gmailReady}
                label="Gmail connected"
                detail={
                  gmailReady
                    ? `${google?.googleEmail} · ${google?.dailyQuotaLimit}/day sending limit`
                    : 'Sign out and back in to grant send permission'
                }
              />
              <StatusRow
                done={Boolean(ai)}
                label="Anthropic key"
                detail={
                  ai
                    ? `sk-ant-…${ai.keyLast4} · ${ai.defaultModel}`
                    : 'Optional — template-only mode works without one'
                }
                optional
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Build progress</CardTitle>
              <CardDescription>Phase 2 of 9 complete.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              {PHASES.map((phase) => {
                const done = phase.n <= COMPLETED_PHASE
                return (
                  <div key={phase.n} className="flex items-baseline gap-3 text-sm">
                    <span
                      className={`w-14 shrink-0 font-mono text-xs ${
                        done ? 'text-success' : 'text-ink-subtle'
                      }`}
                    >
                      {done ? 'done' : `phase ${phase.n}`}
                    </span>
                    <span className={done ? 'text-ink' : 'text-ink-muted'}>{phase.label}</span>
                  </div>
                )
              })}
            </CardContent>
          </Card>
        </div>
      </main>
    </>
  )
}

const COMPLETED_PHASE = 2

const PHASES = [
  { n: 0, label: 'Scaffold, database, Google auth, CI' },
  { n: 1, label: 'CSV upload, column mapping, validation' },
  { n: 2, label: 'Template engine and live preview' },
  { n: 3, label: 'AI slots with your own Anthropic key' },
  { n: 4, label: 'Job queue, worker, batch generation' },
  { n: 5, label: 'Review screen and approval gate' },
  { n: 6, label: 'Gmail send with throttling' },
  { n: 7, label: 'Unsubscribe, suppression, preflight' },
  { n: 8, label: 'Bounce detection and reporting' },
  { n: 9, label: 'End-to-end tests and docs' },
]

function StatusRow({
  done,
  label,
  detail,
  optional,
}: {
  done: boolean
  label: string
  detail: string
  optional?: boolean
}) {
  return (
    <div className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
      {done ? (
        <Check className="text-success mt-0.5 size-4 shrink-0" />
      ) : (
        <Circle
          className={`mt-0.5 size-4 shrink-0 ${optional ? 'text-ink-subtle' : 'text-warning'}`}
        />
      )}
      <div className="min-w-0">
        <p className="text-sm font-medium">
          {label}
          {optional && !done && (
            <span className="text-ink-subtle ml-2 text-xs font-normal">optional</span>
          )}
        </p>
        <p className="text-ink-muted truncate text-sm">{detail}</p>
      </div>
    </div>
  )
}
