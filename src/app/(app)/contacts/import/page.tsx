import type { Metadata } from 'next'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { ImportWizard } from './import-wizard'

export const metadata: Metadata = { title: 'Import contacts' }

export default function ImportPage() {
  return (
    <>
      <header className="border-border flex h-14 shrink-0 items-center gap-3 border-b px-6">
        <Link
          href="/contacts"
          className="text-ink-muted hover:text-ink flex items-center gap-1.5 text-sm transition-colors"
        >
          <ArrowLeft className="size-4" />
          Contacts
        </Link>
        <span className="text-ink-subtle">/</span>
        <h1 className="text-sm font-semibold tracking-tight">Import</h1>
      </header>

      <main className="flex-1 p-6">
        <ImportWizard />
      </main>
    </>
  )
}
