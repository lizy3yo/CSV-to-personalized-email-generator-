import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { and, asc, eq } from 'drizzle-orm'
import { ArrowLeft, Send, ShieldCheck } from 'lucide-react'
import { db } from '@/db'
import { campaignRecipients, campaigns, contacts } from '@/db/schema'
import { requireUser } from '@/lib/auth/require-user'
import { Badge } from '@/components/ui/badge'
import { buttonStyles } from '@/components/ui/button'
import { parseFlags } from '@/core/review/flags'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { getCampaignProgress } from '../actions'
import { getSendableCount } from './review/actions'
import { CampaignProgressPanel } from './campaign-progress'

export const metadata: Metadata = { title: 'Campaign' }

export default async function CampaignPage(props: PageProps<'/campaigns/[id]'>) {
  const { id } = await props.params
  const user = await requireUser()

  const campaign = await db.query.campaigns.findFirst({
    where: and(eq(campaigns.id, id), eq(campaigns.userId, user.id)),
  })
  if (!campaign) notFound()

  const progress = await getCampaignProgress(id)
  if (!progress) notFound()

  const sendable = await getSendableCount(id)

  // A sample of generated emails. The full review screen arrives in phase 5.
  const sample = await db
    .select({
      id: campaignRecipients.id,
      email: contacts.email,
      subject: campaignRecipients.subject,
      bodyText: campaignRecipients.bodyText,
      status: campaignRecipients.status,
      flags: campaignRecipients.flags,
    })
    .from(campaignRecipients)
    .innerJoin(contacts, eq(contacts.id, campaignRecipients.contactId))
    .where(eq(campaignRecipients.campaignId, id))
    .orderBy(asc(contacts.rowNumber))
    .limit(10)

  return (
    <>
      <header className="border-border flex h-14 shrink-0 items-center gap-3 border-b px-6">
        <Link
          href="/campaigns"
          className="text-ink-muted hover:text-ink flex items-center gap-1.5 text-sm transition-colors"
        >
          <ArrowLeft className="size-4" />
          Campaigns
        </Link>
        <span className="text-ink-subtle">/</span>
        <h1 className="truncate text-sm font-semibold tracking-tight">{campaign.name}</h1>
      </header>

      <main className="flex-1 p-6">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
          <Card>
            <CardContent className="p-5">
              <CampaignProgressPanel campaignId={id} progress={progress} />
            </CardContent>
          </Card>

          {sample.length > 0 && (
            <Card>
              <CardHeader className="flex-row items-start justify-between gap-4">
                <div>
                  <CardTitle>Generated emails</CardTitle>
                  <p className="text-ink-muted mt-1 text-sm">
                    {sendable.toLocaleString()} of {progress.total.toLocaleString()} approved.
                    Nothing can be sent until it is approved.
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <Link
                    href={`/campaigns/${id}/review`}
                    className={buttonStyles({ size: 'sm', variant: 'secondary' })}
                  >
                    <ShieldCheck /> Review
                  </Link>
                  <Link href={`/campaigns/${id}/send`} className={buttonStyles({ size: 'sm' })}>
                    <Send /> Send
                  </Link>
                </div>
              </CardHeader>
              <CardContent className="divide-border flex flex-col divide-y p-0">
                {sample.map((row) => (
                  <div key={row.id} className="flex flex-col gap-1.5 p-5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-ink-muted text-sm">{row.email}</span>
                      <Badge
                        tone={
                          row.status === 'approved'
                            ? 'success'
                            : row.status === 'flagged'
                              ? 'warning'
                              : 'neutral'
                        }
                      >
                        {row.status}
                      </Badge>
                      {parseFlags(row.flags).map((flag) => (
                        <Badge
                          key={flag.raw}
                          tone={flag.severity === 'error' ? 'danger' : 'warning'}
                          title={flag.detail}
                        >
                          {flag.label}
                        </Badge>
                      ))}
                    </div>
                    <p className="text-sm font-medium">{row.subject}</p>
                    <pre className="text-ink-muted font-sans text-sm whitespace-pre-wrap">
                      {row.bodyText}
                    </pre>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}
        </div>
      </main>
    </>
  )
}
