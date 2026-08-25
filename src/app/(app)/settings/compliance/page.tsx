import type { Metadata } from 'next'
import Link from 'next/link'
import { requireUser } from '@/lib/auth/require-user'
import { getComplianceSettings } from '../actions'
import { ComplianceSettings } from './compliance-settings'

export const metadata: Metadata = { title: 'Compliance settings' }

export default async function CompliancePage() {
  await requireUser()
  const initial = await getComplianceSettings()

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
        <ComplianceSettings initial={initial} />
      </main>
    </>
  )
}
