import type { Metadata } from 'next'
import { requireUser } from '@/lib/auth/require-user'
import { listSuppressions } from './actions'
import { SuppressionManager, type SuppressionRow } from './suppression-manager'

export const metadata: Metadata = { title: 'Suppressions' }

export default async function SuppressionsPage() {
  await requireUser()
  const rows = await listSuppressions()

  return (
    <>
      <header className="border-border flex h-14 shrink-0 items-center border-b px-6">
        <h1 className="text-sm font-semibold tracking-tight">Suppressions</h1>
      </header>
      <main className="flex-1 p-6">
        <div className="mx-auto w-full max-w-2xl">
          <SuppressionManager rows={rows as SuppressionRow[]} />
        </div>
      </main>
    </>
  )
}
