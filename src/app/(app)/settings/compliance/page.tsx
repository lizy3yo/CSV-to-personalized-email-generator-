import type { Metadata } from 'next'
import Link from 'next/link'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { googleAccounts } from '@/db/schema'
import { hasReadScope } from '@/core/gmail/scopes'
import { requireUser } from '@/lib/auth/require-user'
import { getComplianceSettings } from '../actions'
import { ComplianceSettings } from './compliance-settings'
import { InboxPollingCard } from './inbox-polling-card'

export const metadata: Metadata = { title: 'Compliance settings' }

export default async function CompliancePage() {
  const user = await requireUser()
  const initial = await getComplianceSettings()
  const account = await db.query.googleAccounts.findFirst({
    where: eq(googleAccounts.userId, user.id),
  })

  return (
    <>
      <header className="border-border flex h-14 shrink-0 items-center gap-3 border-b px-6">
        <Link
          href="/settings/ai"
          className="text-ink-muted hover:text-ink text-sm transition-colors"
        >
          Settings
        </Link>
        <span className="text-ink-subtle">/</span>
        <h1 className="text-sm font-semibold tracking-tight">Compliance</h1>
      </header>
      <main className="flex-1 p-6">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
          <ComplianceSettings initial={initial} />
          <InboxPollingCard
            enabled={account?.inboxPollingEnabled ?? false}
            hasReadScope={hasReadScope(account?.scopes ?? [])}
            lastPolledAt={account?.lastInboxPollAt ?? null}
          />
        </div>
      </main>
    </>
  )
}
