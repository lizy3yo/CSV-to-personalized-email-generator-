import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { and, desc, eq, sql } from 'drizzle-orm'
import { ArrowLeft } from 'lucide-react'
import { db } from '@/db'
import { contactLists, contacts, templates } from '@/db/schema'
import { requireUser } from '@/lib/auth/require-user'
import { TemplateEditor } from '../template-editor'

export const metadata: Metadata = { title: 'Edit template' }

export default async function EditTemplatePage(props: PageProps<'/templates/[id]'>) {
  // params is a Promise in Next.js 16.
  const { id } = await props.params
  const user = await requireUser()

  const template = await db.query.templates.findFirst({
    where: and(eq(templates.id, id), eq(templates.userId, user.id)),
  })
  if (!template) notFound()

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
        <h1 className="truncate text-sm font-semibold tracking-tight">{template.name}</h1>
      </header>

      <TemplateEditor
        templateId={template.id}
        lists={lists}
        initial={{
          name: template.name,
          subjectTpl: template.subjectTpl,
          bodyTpl: template.bodyTpl,
          complianceProfile: template.complianceProfile,
        }}
      />
    </>
  )
}
