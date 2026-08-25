import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { and, desc, eq, sql } from 'drizzle-orm'
import { AlertTriangle, ArrowLeft, Info } from 'lucide-react'
import { db } from '@/db'
import { campaignRecipients, campaigns, contacts, events, googleAccounts } from '@/db/schema'
import { requireUser } from '@/lib/auth/require-user'
import {
  bounceRate,
  BOUNCE_RATE_WARNING,
  complaintRate,
  COMPLAINT_RATE_LIMIT,
} from '@/core/gmail/bounce'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

export const metadata: Metadata = { title: 'Report' }

function percent(value: number): string {
  if (value === 0) return '0%'
  if (value < 0.001) return '<0.1%'
  return `${(value * 100).toFixed(1)}%`
}

export default async function ReportPage(props: PageProps<'/campaigns/[id]/report'>) {
  const { id } = await props.params
  const user = await requireUser()

  const campaign = await db.query.campaigns.findFirst({
    where: and(eq(campaigns.id, id), eq(campaigns.userId, user.id)),
  })
  if (!campaign) notFound()

  const [counts] = await db
    .select({
      total: sql<number>`count(*)::int`,
      sent: sql<number>`count(*) filter (where status = 'sent')::int`,
      bounced: sql<number>`count(*) filter (where status = 'bounced')::int`,
      complained: sql<number>`count(*) filter (where status = 'complained')::int`,
      failed: sql<number>`count(*) filter (where status = 'failed')::int`,
      rejected: sql<number>`count(*) filter (where status = 'rejected')::int`,
      approved: sql<number>`count(*) filter (where status = 'approved')::int`,
      sending: sql<number>`count(*) filter (where status = 'sending')::int`,
    })
    .from(campaignRecipients)
    .where(eq(campaignRecipients.campaignId, id))

  // Replies live in `events` rather than as a recipient status: a reply is
  // engagement, not a delivery state, and one person may send several.
  const [replyRow] = await db
    .select({ count: sql<number>`count(distinct ${events.recipientId})::int` })
    .from(events)
    .innerJoin(campaignRecipients, eq(campaignRecipients.id, events.recipientId))
    .where(and(eq(campaignRecipients.campaignId, id), sql`${events.type} like 'reply:%'`))

  const recent = await db
    .select({
      id: events.id,
      type: events.type,
      raw: events.raw,
      createdAt: events.createdAt,
      email: contacts.email,
    })
    .from(events)
    .innerJoin(campaignRecipients, eq(campaignRecipients.id, events.recipientId))
    .innerJoin(contacts, eq(contacts.id, campaignRecipients.contactId))
    .where(eq(campaignRecipients.campaignId, id))
    .orderBy(desc(events.createdAt))
    .limit(25)

  const account = await db.query.googleAccounts.findFirst({
    where: eq(googleAccounts.userId, user.id),
  })

  const delivered = counts.sent + counts.bounced
  const replies = replyRow?.count ?? 0
  const bounces = bounceRate(counts.bounced, delivered)
  const complaints = complaintRate(counts.complained, delivered)
  const replyPct = delivered === 0 ? 0 : replies / delivered

  return (
    <>
      <header className="border-border flex h-14 shrink-0 items-center gap-3 border-b px-6">
        <Link
          href={`/campaigns/${id}`}
          className="text-ink-muted hover:text-ink flex items-center gap-1.5 text-sm transition-colors"
        >
          <ArrowLeft className="size-4" />
          {campaign.name}
        </Link>
        <span className="text-ink-subtle">/</span>
        <h1 className="text-sm font-semibold tracking-tight">Report</h1>
      </header>

      <main className="flex-1 p-6">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
          {complaints > COMPLAINT_RATE_LIMIT && (
            <div className="border-danger/30 bg-danger/10 text-danger flex items-start gap-2 rounded-lg border p-3 text-sm">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <span>
                Complaint rate is {percent(complaints)}, above the {percent(COMPLAINT_RATE_LIMIT)}{' '}
                ceiling in Gmail and Yahoo&apos;s bulk sender rules. Sustained, this costs
                deliverability across your whole account — not just this campaign. Stop and review
                the list.
              </span>
            </div>
          )}

          {bounces > BOUNCE_RATE_WARNING && (
            <div className="border-warning/30 bg-warning/10 text-warning flex items-start gap-2 rounded-lg border p-3 text-sm">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <span>
                {percent(bounces)} of delivered mail hard-bounced, which usually means a stale or
                bought list. Every bounce is a signal to the receiving provider that you do not know
                who you are writing to.
              </span>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Sent" value={counts.sent} tone="success" />
            <Stat label="Replied" value={replies} tone="accent" sub={percent(replyPct)} />
            <Stat label="Bounced" value={counts.bounced} tone="danger" sub={percent(bounces)} />
            <Stat label="Failed" value={counts.failed} tone="danger" />
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Where every recipient ended up</CardTitle>
              <CardDescription>
                {counts.total.toLocaleString()} in this campaign. The numbers add up to the total —
                nothing is unaccounted for.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-1.5">
              <Badge tone="success">{counts.sent.toLocaleString()} sent</Badge>
              {counts.bounced > 0 && (
                <Badge tone="danger">{counts.bounced.toLocaleString()} bounced</Badge>
              )}
              {counts.complained > 0 && (
                <Badge tone="danger">{counts.complained.toLocaleString()} complained</Badge>
              )}
              {counts.failed > 0 && (
                <Badge tone="danger">{counts.failed.toLocaleString()} failed</Badge>
              )}
              {counts.rejected > 0 && (
                <Badge tone="neutral">
                  {counts.rejected.toLocaleString()} rejected or suppressed
                </Badge>
              )}
              {counts.approved > 0 && (
                <Badge tone="warning">{counts.approved.toLocaleString()} still to send</Badge>
              )}
              {counts.sending > 0 && (
                <Badge tone="warning" title="Delivery unknown — never resent automatically">
                  {counts.sending.toLocaleString()} in flight
                </Badge>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Reply rate</CardTitle>
              <CardDescription>
                The only engagement signal here. There is no open tracking by design — a tracking
                pixel on 1:1 outreach costs more in deliverability and trust than the data is worth.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {account?.inboxPollingEnabled ? (
                <p className="text-2xl font-medium tabular-nums">
                  {percent(replyPct)}{' '}
                  <span className="text-ink-muted text-sm font-normal">
                    — {replies.toLocaleString()} of {delivered.toLocaleString()} delivered
                  </span>
                </p>
              ) : (
                <p className="text-ink-muted flex items-start gap-2 text-sm">
                  <Info className="mt-0.5 size-4 shrink-0" />
                  <span>
                    Replies and bounces are not being detected. Gmail pushes neither, so seeing them
                    means reading the mailbox — turn it on in{' '}
                    <Link href="/settings/compliance" className="text-accent underline">
                      Settings → Compliance
                    </Link>
                    .
                  </span>
                </p>
              )}
            </CardContent>
          </Card>

          {recent.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Recent events</CardTitle>
              </CardHeader>
              <CardContent className="divide-border flex flex-col divide-y p-0">
                {recent.map((event) => {
                  const kind = String(event.raw.kind ?? event.type.split(':')[0])
                  return (
                    <div
                      key={event.id}
                      className="flex flex-wrap items-center gap-2 px-5 py-3 text-sm"
                    >
                      <Badge
                        tone={kind === 'reply' ? 'accent' : kind === 'hard' ? 'danger' : 'warning'}
                      >
                        {kind === 'reply' ? 'reply' : `${kind} bounce`}
                      </Badge>
                      <span className="text-ink-muted truncate">{event.email}</span>
                      {typeof event.raw.status === 'string' && (
                        <span className="text-ink-subtle font-mono text-xs">
                          {event.raw.status}
                        </span>
                      )}
                      <span className="text-ink-subtle ml-auto text-xs">
                        {new Date(event.createdAt).toLocaleString()}
                      </span>
                    </div>
                  )
                })}
              </CardContent>
            </Card>
          )}
        </div>
      </main>
    </>
  )
}

function Stat({
  label,
  value,
  tone,
  sub,
}: {
  label: string
  value: number
  tone: 'success' | 'danger' | 'accent'
  sub?: string
}) {
  const colour =
    tone === 'success' ? 'text-success' : tone === 'danger' ? 'text-danger' : 'text-accent'
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-ink-muted text-xs">{label}</p>
        <p className={`mt-1 text-2xl font-medium tabular-nums ${value > 0 ? colour : 'text-ink'}`}>
          {value.toLocaleString()}
        </p>
        {sub && <p className="text-ink-subtle mt-0.5 text-xs tabular-nums">{sub}</p>}
      </CardContent>
    </Card>
  )
}
