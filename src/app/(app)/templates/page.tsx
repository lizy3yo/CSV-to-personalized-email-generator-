import type { Metadata } from 'next'
import Link from 'next/link'
import { desc, eq } from 'drizzle-orm'
import { Mail, Plus, Sparkles } from 'lucide-react'
import { db } from '@/db'
import { templates } from '@/db/schema'
import { requireUser } from '@/lib/auth/require-user'
import { Badge } from '@/components/ui/badge'
import { buttonStyles } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { DeleteTemplateButton } from './delete-template-button'

export const metadata: Metadata = { title: 'Templates' }

export default async function TemplatesPage() {
  const user = await requireUser()

  const rows = await db
    .select()
    .from(templates)
    .where(eq(templates.userId, user.id))
    .orderBy(desc(templates.updatedAt))

  return (
    <>
      <header className="border-border flex h-14 shrink-0 items-center justify-between border-b px-6">
        <h1 className="text-sm font-semibold tracking-tight">Templates</h1>
        <Link href="/templates/new" className={buttonStyles({ size: 'sm' })}>
          <Plus /> New template
        </Link>
      </header>

      <main className="flex-1 p-6">
        <div className="mx-auto w-full max-w-4xl">
          {rows.length === 0 ? (
            <Card>
              <CardContent className="flex flex-col items-center gap-3 p-12 text-center">
                <Mail className="text-ink-subtle size-8" />
                <div>
                  <p className="text-sm font-medium">No templates yet</p>
                  <p className="text-ink-muted mt-1 text-sm">
                    Write one with merge variables and preview it against your real contacts before
                    anything is generated.
                  </p>
                </div>
                <Link href="/templates/new" className={buttonStyles({ className: 'mt-2' })}>
                  <Plus /> New template
                </Link>
              </CardContent>
            </Card>
          ) : (
            <div className="flex flex-col gap-3">
              {rows.map((template) => (
                <Card key={template.id}>
                  <CardContent className="flex items-start justify-between gap-4 p-5">
                    <Link href={`/templates/${template.id}`} className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{template.name}</p>
                      <p className="text-ink-muted mt-0.5 truncate text-sm">
                        {template.subjectTpl || <span className="italic">no subject</span>}
                      </p>
                      <div className="mt-2.5 flex flex-wrap gap-1.5">
                        <Badge tone={template.complianceProfile === 'bulk' ? 'warning' : 'neutral'}>
                          {template.complianceProfile === 'bulk'
                            ? 'Bulk / marketing'
                            : '1:1 outreach'}
                        </Badge>
                        <Badge>v{template.version}</Badge>
                        {template.variables.length > 0 && (
                          <Badge>
                            {template.variables.length} variable
                            {template.variables.length === 1 ? '' : 's'}
                          </Badge>
                        )}
                        {template.aiConfig.enabled && (
                          <Badge tone="accent">
                            <Sparkles className="size-3" /> AI slots
                          </Badge>
                        )}
                      </div>
                    </Link>

                    <DeleteTemplateButton templateId={template.id} name={template.name} />
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </div>
      </main>
    </>
  )
}
