import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { and, asc, eq, sql } from 'drizzle-orm'
import { ArrowLeft } from 'lucide-react'
import { db } from '@/db'
import { campaignRecipients, campaigns, contactLists, contacts, profiles } from '@/db/schema'
import { requireUser } from '@/lib/auth/require-user'
import { getSendReadiness, stuckSending } from '@/lib/jobs/send'
import { hasSendScope } from '@/core/gmail/scopes'
import { buildFooterText, checkCompliance } from '@/core/compliance/footer'
import { SendPanel, type PreflightCheck } from './send-panel'

export const metadata: Metadata = { title: 'Send' }

export default async function SendPage(props: PageProps<'/campaigns/[id]/send'>) {
  const { id } = await props.params
  const user = await requireUser()

  const campaign = await db.query.campaigns.findFirst({
    where: and(eq(campaigns.id, id), eq(campaigns.userId, user.id)),
  })
  if (!campaign) notFound()

  const readiness = await getSendReadiness(user.id, id)
  if (!readiness) notFound()

  const [counts] = await db
    .select({
      failed: sql<number>`count(*) filter (where status = 'failed')::int`,
      total: sql<number>`count(*)::int`,
    })
    .from(campaignRecipients)
    .where(eq(campaignRecipients.campaignId, id))

  const stuck = await stuckSending(id)

  const [sample] = await db
    .select({ subject: campaignRecipients.subject, bodyText: campaignRecipients.bodyText })
    .from(campaignRecipients)
    .innerJoin(contacts, eq(contacts.id, campaignRecipients.contactId))
    .where(eq(campaignRecipients.campaignId, id))
    .orderBy(asc(contacts.rowNumber))
    .limit(1)

  const profile = await db.query.profiles.findFirst({ where: eq(profiles.id, user.id) })
  const list = campaign.listId
    ? await db.query.contactLists.findFirst({ where: eq(contactLists.id, campaign.listId) })
    : null

  // Exactly the input the dispatcher will build, so the preflight cannot
  // pass something the send path would then refuse.
  const footerInput = {
    profile: campaign.complianceProfile,
    unsubscribeUrl: 'https://example.test/unsubscribe/preview',
    postalAddress: profile?.postalAddress,
    optOutLine: profile?.optOutLine,
    consentSource: list?.consentSource,
  }
  const complianceIssues = checkCompliance(footerInput)
  const footerPreview = buildFooterText(footerInput)

  const account = readiness.account
  const scopeOk = Boolean(account && hasSendScope(account.scopes))
  const headroom = readiness.dailyLimit - readiness.sentLast24h

  const checks: PreflightCheck[] = [
    {
      ok: Boolean(account) && !account?.revokedAt,
      blocking: true,
      label: 'Gmail connected',
      detail: account
        ? account.revokedAt
          ? 'Access was revoked — sign in with Google again'
          : `Sending as ${account.googleEmail}`
        : 'Sign in with Google to grant send permission',
    },
    {
      ok: scopeOk,
      blocking: true,
      label: 'Send permission granted',
      detail: scopeOk
        ? 'gmail.send is present on the stored grant'
        : 'The stored grant has no gmail.send scope — sign in again',
    },
    {
      ok: readiness.tokenOk,
      blocking: true,
      label: 'Access token works',
      detail: readiness.tokenOk
        ? 'Refreshed successfully just now'
        : (readiness.tokenError ?? 'Could not mint an access token'),
    },
    {
      ok: readiness.approved > 0,
      blocking: true,
      label: 'Emails approved',
      detail:
        readiness.approved > 0
          ? `${readiness.approved.toLocaleString()} approved and ready`
          : 'Nothing is approved. Only approved emails are ever sent.',
    },
    {
      ok: headroom >= readiness.approved,
      blocking: false,
      label: 'Daily quota headroom',
      detail:
        headroom >= readiness.approved
          ? `${headroom.toLocaleString()} of ${readiness.dailyLimit.toLocaleString()} remaining today — enough for all of them`
          : `${headroom.toLocaleString()} remaining today; the rest will go out as the rolling window clears`,
    },
    {
      ok: true,
      blocking: false,
      label: 'Plain-text alternative',
      detail: 'Every message is multipart/alternative — an HTML-only send reads as bulk mail',
    },
    {
      ok: true,
      blocking: false,
      label: 'SPF, DKIM and DMARC',
      detail: 'Handled by Google for the account you send from',
    },
    {
      ok: true,
      blocking: false,
      label: 'One-click unsubscribe',
      detail:
        'List-Unsubscribe and List-Unsubscribe-Post headers are attached to every message, so Gmail shows its native unsubscribe control',
    },
    ...complianceIssues.map((issue) => ({
      ok: false,
      blocking: issue.blocking,
      label:
        issue.code === 'no_postal_address'
          ? 'Physical postal address'
          : issue.code === 'no_unsubscribe_url'
            ? 'Unsubscribe URL'
            : 'Opt-out sentence',
      detail: issue.message,
    })),
    ...(complianceIssues.length === 0
      ? [
          {
            ok: true,
            blocking: false,
            label: 'Physical postal address',
            detail: 'Present, and appended to every message',
          },
        ]
      : []),
  ]

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
        <h1 className="text-sm font-semibold tracking-tight">Send</h1>
      </header>

      <main className="flex-1 p-6">
        <div className="mx-auto w-full max-w-2xl">
          <SendPanel
            campaignId={id}
            status={campaign.status}
            approved={readiness.approved}
            sent={readiness.sent}
            failed={counts?.failed ?? 0}
            stuck={stuck.length}
            fromEmail={account?.googleEmail ?? null}
            dailyLimit={readiness.dailyLimit}
            sentLast24h={readiness.sentLast24h}
            checks={checks}
            settings={{
              ratePerHour: campaign.ratePerHour,
              sendWindowStartHour: campaign.sendWindowStartHour,
              sendWindowEndHour: campaign.sendWindowEndHour,
              sendWindowDays: campaign.sendWindowDays,
              threadFollowUps: campaign.threadFollowUps,
            }}
            complianceProfile={campaign.complianceProfile}
            footerPreview={footerPreview}
            sampleSubject={sample?.subject ?? campaign.name}
            sampleBody={sample?.bodyText ?? 'No generated email to preview yet.'}
          />
        </div>
      </main>
    </>
  )
}
