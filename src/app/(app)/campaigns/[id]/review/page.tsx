import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { and, asc, eq } from 'drizzle-orm'
import { ArrowLeft, ShieldCheck } from 'lucide-react'
import { db } from '@/db'
import { aiCredentials, campaignRecipients, campaigns, contacts, templates } from '@/db/schema'
import { requireUser } from '@/lib/auth/require-user'
import { parse } from '@/core/template/parse'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { getReviewCounts, getSendableCount } from './actions'
import { ReviewTable, type ReviewRow } from './review-table'

export const metadata: Metadata = { title: 'Review' }

/** Reviewing thousands of rows in one DOM is not useful; the filters are. */
const MAX_ROWS = 500

export default async function ReviewPage(props: PageProps<'/campaigns/[id]/review'>) {
  const { id } = await props.params
  const user = await requireUser()

  const campaign = await db.query.campaigns.findFirst({
    where: and(eq(campaigns.id, id), eq(campaigns.userId, user.id)),
  })
  if (!campaign) notFound()

  const template = campaign.templateId
    ? await db.query.templates.findFirst({ where: eq(templates.id, campaign.templateId) })
    : null

  const [rows, counts, sendable, credential] = await Promise.all([
    db
      .select({
        id: campaignRecipients.id,
        email: contacts.email,
        subject: campaignRecipients.subject,
        bodyText: campaignRecipients.bodyText,
        status: campaignRecipients.status,
        flags: campaignRecipients.flags,
        editedByUser: campaignRecipients.editedByUser,
      })
      .from(campaignRecipients)
      .innerJoin(contacts, eq(contacts.id, campaignRecipients.contactId))
      .where(eq(campaignRecipients.campaignId, id))
      .orderBy(asc(contacts.rowNumber))
      .limit(MAX_ROWS),
    getReviewCounts(id),
    getSendableCount(id),
    db.query.aiCredentials.findFirst({ where: eq(aiCredentials.userId, user.id) }),
  ])

  const hasAiSlots = template
    ? parse(template.bodyTpl).slots.length > 0 || parse(template.subjectTpl).slots.length > 0
    : false

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
        <h1 className="text-sm font-semibold tracking-tight">Review</h1>
      </header>

      <main className="flex-1 p-6">
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-4">
          <Card>
            <CardContent className="flex flex-wrap items-center gap-3 p-4">
              <ShieldCheck className="text-success size-5 shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">
                  {sendable.toLocaleString()} of {counts.total.toLocaleString()} approved to send
                </p>
                <p className="text-ink-muted text-sm">
                  Only approved emails are ever read by the send path. Everything else — generated,
                  flagged, rejected — is structurally unsendable.
                </p>
              </div>
              {counts.blocked > 0 && (
                <Badge tone="danger">{counts.blocked} blocked by errors</Badge>
              )}
            </CardContent>
          </Card>

          {counts.total > MAX_ROWS && (
            <p className="text-ink-subtle text-xs">
              Showing the first {MAX_ROWS.toLocaleString()} of {counts.total.toLocaleString()}. Use
              the filters — reviewing every row in one list is not the point.
            </p>
          )}

          <ReviewTable
            campaignId={id}
            rows={rows as ReviewRow[]}
            counts={counts}
            hasAiSlots={hasAiSlots}
            hasApiKey={Boolean(credential)}
          />
        </div>
      </main>
    </>
  )
}
