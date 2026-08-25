import type { Metadata } from 'next'
import Link from 'next/link'
import { desc, eq, sql } from 'drizzle-orm'
import { ArrowLeft } from 'lucide-react'
import { db } from '@/db'
import { aiCredentials, contactLists, contacts } from '@/db/schema'
import { requireUser } from '@/lib/auth/require-user'
import { TemplateEditor } from '../template-editor'

export const metadata: Metadata = { title: 'New template' }

const STARTER_BODY = `Hi {{ first_name | default: there }},

{{ai:opening}}

We help teams like yours turn a spreadsheet of contacts into emails that read
as though they were written one at a time — because they were.

Worth a short call?

— Sam
`

export default async function NewTemplatePage() {
  const user = await requireUser()

  const lists = await db
    .select({
      id: contactLists.id,
      name: contactLists.name,
      contactCount: sql<number>`count(${contacts.id})::int`,
    })
    .from(contactLists)
    .leftJoin(contacts, eq(contacts.listId, contactLists.id))
    .where(eq(contactLists.userId, user.id))
    .groupBy(contactLists.id)
    .orderBy(desc(contactLists.createdAt))

  // Drives whether the editor offers the generate button or points at
  // Settings. The key itself never leaves the server.
  const credential = await db.query.aiCredentials.findFirst({
    where: eq(aiCredentials.userId, user.id),
  })

  return (
    <>
      <header className="border-border flex h-14 shrink-0 items-center gap-3 border-b px-6">
        <Link
          href="/templates"
          className="text-ink-muted hover:text-ink flex items-center gap-1.5 text-sm transition-colors"
        >
          <ArrowLeft className="size-4" />
          Templates
        </Link>
        <span className="text-ink-subtle">/</span>
        <h1 className="text-sm font-semibold tracking-tight">New</h1>
      </header>

      <TemplateEditor
        hasApiKey={Boolean(credential)}
        lists={lists}
        initial={{
          name: '',
          subjectTpl: 'Quick question, {{company}}',
          bodyTpl: STARTER_BODY,
          complianceProfile: 'one_to_one',
        }}
      />
    </>
  )
}
