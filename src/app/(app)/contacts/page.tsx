import type { Metadata } from 'next'
import Link from 'next/link'
import { desc, eq } from 'drizzle-orm'
import { FileSpreadsheet, Plus } from 'lucide-react'
import { db } from '@/db'
import { contactLists } from '@/db/schema'
import { requireUser } from '@/lib/auth/require-user'
import { Badge } from '@/components/ui/badge'
import { buttonStyles } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { DeleteListButton } from './delete-list-button'

export const metadata: Metadata = { title: 'Contacts' }

const CONSENT_LABELS: Record<string, string> = {
  consent: 'Explicit consent',
  legitimate_interest: 'Legitimate interest',
  contract: 'Contract',
  unknown: 'Basis not recorded',
}

export default async function ContactsPage() {
  const user = await requireUser()

  const lists = await db
    .select()
    .from(contactLists)
    .where(eq(contactLists.userId, user.id))
    .orderBy(desc(contactLists.createdAt))

  return (
    <>
      <header className="border-border flex h-14 shrink-0 items-center justify-between border-b px-6">
        <h1 className="text-sm font-semibold tracking-tight">Contacts</h1>
        <Link href="/contacts/import" className={buttonStyles({ size: 'sm' })}>
          <Plus /> Import CSV
        </Link>
      </header>

      <main className="flex-1 p-6">
        <div className="mx-auto w-full max-w-4xl">
          {lists.length === 0 ? (
            <Card>
              <CardContent className="flex flex-col items-center gap-3 p-12 text-center">
                <FileSpreadsheet className="text-ink-subtle size-8" />
                <div>
                  <p className="text-sm font-medium">No contact lists yet</p>
                  <p className="text-ink-muted mt-1 text-sm">
                    Import a CSV to get started. It is read in your browser — the file is never
                    uploaded.
                  </p>
                </div>
                <Link href="/contacts/import" className={buttonStyles({ className: 'mt-2' })}>
                  <Plus /> Import a CSV
                </Link>
              </CardContent>
            </Card>
          ) : (
            <div className="flex flex-col gap-3">
              {lists.map((list) => {
                const rejected = list.rowCount - list.validCount
                return (
                  <Card key={list.id}>
                    <CardContent className="flex items-start justify-between gap-4 p-5">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{list.name}</p>
                        <p className="text-ink-muted mt-0.5 truncate text-sm">
                          {list.sourceFilename ?? 'Manual list'} ·{' '}
                          {new Date(list.createdAt).toLocaleDateString(undefined, {
                            year: 'numeric',
                            month: 'short',
                            day: 'numeric',
                          })}
                        </p>
                        <div className="mt-2.5 flex flex-wrap gap-1.5">
                          <Badge tone="success">{list.validCount.toLocaleString()} contacts</Badge>
                          {list.duplicateCount > 0 && (
                            <Badge tone="warning">
                              {list.duplicateCount.toLocaleString()} duplicate
                            </Badge>
                          )}
                          {list.invalidCount > 0 && (
                            <Badge tone="danger">
                              {list.invalidCount.toLocaleString()} invalid
                            </Badge>
                          )}
                          <Badge tone={list.consentBasis === 'unknown' ? 'warning' : 'neutral'}>
                            {CONSENT_LABELS[list.consentBasis] ?? list.consentBasis}
                          </Badge>
                        </div>
                        {rejected > 0 && (
                          <p className="text-ink-subtle mt-2 text-xs">
                            {rejected.toLocaleString()} of {list.rowCount.toLocaleString()} rows
                            were not imported.
                          </p>
                        )}
                      </div>

                      <DeleteListButton listId={list.id} listName={list.name} />
                    </CardContent>
                  </Card>
                )
              })}
            </div>
          )}
        </div>
      </main>
    </>
  )
}
