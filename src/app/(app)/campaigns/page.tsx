import type { Metadata } from 'next'
import Link from 'next/link'
import { desc, eq, sql } from 'drizzle-orm'
import { Check, Circle, LayoutList, Plus } from 'lucide-react'
import { db } from '@/db'
import { aiCredentials, campaignRecipients, campaigns, googleAccounts } from '@/db/schema'
import { requireUser } from '@/lib/auth/require-user'
import { hasSendScope } from '@/core/gmail/scopes'
import { Badge } from '@/components/ui/badge'
import { buttonStyles } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

export const metadata: Metadata = { title: 'Campaigns' }

const STATUS_TONE: Record<string, 'neutral' | 'success' | 'warning' | 'accent' | 'danger'> = {
  draft: 'neutral',
  generating: 'accent',
  reviewing: 'warning',
  scheduled: 'accent',
  sending: 'accent',
  completed: 'success',
  failed: 'danger',
  cancelled: 'neutral',
  paused: 'neutral',
}

export default async function CampaignsPage() {
  const user = await requireUser()

  const [rows, google, ai] = await Promise.all([
    db
      .select({
        id: campaigns.id,
        name: campaigns.name,
        status: campaigns.status,
        createdAt: campaigns.createdAt,
        recipients: sql<number>`count(${campaignRecipients.id})::int`,
      })
      .from(campaigns)
      .leftJoin(campaignRecipients, eq(campaignRecipients.campaignId, campaigns.id))
      .where(eq(campaigns.userId, user.id))
      .groupBy(campaigns.id)
      .orderBy(desc(campaigns.createdAt)),
    db.query.googleAccounts.findFirst({ where: eq(googleAccounts.userId, user.id) }),
    db.query.aiCredentials.findFirst({ where: eq(aiCredentials.userId, user.id) }),
  ])

  const gmailReady = Boolean(google && !google.revokedAt && hasSendScope(google.scopes))

  return (
    <>
      <header className="border-border flex h-14 shrink-0 items-center justify-between border-b px-6">
        <h1 className="text-sm font-semibold tracking-tight">Campaigns</h1>
        <Link href="/campaigns/new" className={buttonStyles({ size: 'sm' })}>
          <Plus /> New campaign
        </Link>
      </header>

      <main className="flex-1 p-6">
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
          {rows.length === 0 ? (
            <Card>
              <CardContent className="flex flex-col items-center gap-3 p-12 text-center">
                <LayoutList className="text-ink-subtle size-8" />
                <div>
                  <p className="text-sm font-medium">No campaigns yet</p>
                  <p className="text-ink-muted mt-1 text-sm">
                    A campaign pairs a contact list with a template, then generates one email per
                    contact in the background.
                  </p>
                </div>
                <Link href="/campaigns/new" className={buttonStyles({ className: 'mt-2' })}>
                  <Plus /> New campaign
                </Link>
              </CardContent>
            </Card>
          ) : (
            <div className="flex flex-col gap-3">
              {rows.map((campaign) => (
                <Link key={campaign.id} href={`/campaigns/${campaign.id}`}>
                  <Card className="hover:border-border-strong transition-colors">
                    <CardContent className="flex items-center justify-between gap-4 p-5">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{campaign.name}</p>
                        <p className="text-ink-muted mt-0.5 text-sm">
                          {new Date(campaign.createdAt).toLocaleDateString(undefined, {
                            year: 'numeric',
                            month: 'short',
                            day: 'numeric',
                          })}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        {campaign.recipients > 0 && (
                          <Badge>{campaign.recipients.toLocaleString()} recipients</Badge>
                        )}
                        <Badge tone={STATUS_TONE[campaign.status] ?? 'neutral'}>
                          {campaign.status}
                        </Badge>
                      </div>
                    </CardContent>
                  </Card>
                </Link>
              ))}
            </div>
          )}

          <Card>
            <CardHeader>
              <CardTitle>Setup</CardTitle>
              <CardDescription>
                Checked live against the database. The Gmail and AI rows are the same checks the
                send preflight runs.
              </CardDescription>
            </CardHeader>
            <CardContent className="divide-border flex flex-col divide-y">
              <StatusRow done label="Signed in" detail={user.email ?? 'unknown account'} />
              <StatusRow
                done={gmailReady}
                label="Gmail connected"
                detail={
                  gmailReady
                    ? `${google?.googleEmail} · ${google?.dailyQuotaLimit}/day sending limit`
                    : 'Sign out and back in to grant send permission (used from phase 6)'
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
              <StatusRow
                done={false}
                label="Background worker"
                detail="Run `npm run worker` in a second terminal to process generation"
                optional
              />
            </CardContent>
          </Card>
        </div>
      </main>
    </>
  )
}

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
