import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { and, asc, eq } from 'drizzle-orm'
import { ArrowLeft, Info } from 'lucide-react'
import { db } from '@/db'
import { contactLists, contactRejects, contacts } from '@/db/schema'
import { requireUser } from '@/lib/auth/require-user'
import { MAX_STORED_REJECTS } from '@/core/csv/ingest'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'

export const metadata: Metadata = { title: 'Contact list' }

/**
 * One imported list, opened up.
 *
 * The point of this screen is that "3 of 12 rows were not imported" on the
 * previous page is a claim, and a claim about your own data should be
 * openable. Both halves live here: what got in, and what did not with the
 * reason attached.
 *
 * Filtering is a query parameter rather than client state, because a list can
 * hold 50k contacts and shipping all of them to the browser to filter three of
 * them would be absurd. The database does the filtering; each view is a link.
 */

/** Rendering thousands of rows in one DOM helps nobody. */
const MAX_ROWS = 200

const REASON_LABELS = {
  duplicate: 'Duplicate',
  invalid_email: 'Invalid address',
  missing_email: 'Missing address',
  suppressed: 'Suppressed',
} as const

type Reason = keyof typeof REASON_LABELS
type View = 'contacts' | Reason

const VIEWS = ['contacts', 'duplicate', 'invalid_email', 'missing_email', 'suppressed'] as const

function isView(value: string | undefined): value is View {
  return VIEWS.includes((value ?? '') as View)
}

interface Column {
  key: string
  label: string
}

export default async function ContactListPage(props: PageProps<'/contacts/[id]'>) {
  const { id } = await props.params
  const search = await props.searchParams
  const user = await requireUser()

  const list = await db.query.contactLists.findFirst({
    where: and(eq(contactLists.id, id), eq(contactLists.userId, user.id)),
  })
  if (!list) notFound()

  const requested = Array.isArray(search.show) ? search.show[0] : search.show
  const view: View = isView(requested) ? requested : 'contacts'

  const rejectedTotal = list.rowCount - list.validCount

  const [rows, rejects, storedRejectCount] = await Promise.all([
    view === 'contacts'
      ? db
          .select({
            id: contacts.id,
            emailRaw: contacts.emailRaw,
            data: contacts.data,
            rowNumber: contacts.rowNumber,
          })
          .from(contacts)
          .where(eq(contacts.listId, id))
          .orderBy(asc(contacts.rowNumber))
          .limit(MAX_ROWS)
      : Promise.resolve([]),

    view === 'contacts'
      ? Promise.resolve([])
      : db
          .select({
            id: contactRejects.id,
            rowNumber: contactRejects.rowNumber,
            emailRaw: contactRejects.emailRaw,
            issue: contactRejects.issue,
            data: contactRejects.data,
          })
          .from(contactRejects)
          .where(and(eq(contactRejects.listId, id), eq(contactRejects.reason, view)))
          .orderBy(asc(contactRejects.rowNumber))
          .limit(MAX_ROWS),

    db.$count(contactRejects, eq(contactRejects.listId, id)),
  ])

  // A list imported before rejects were recorded has counts but no rows. That
  // is a different statement from "nothing was rejected", and saying so beats
  // showing an empty table that implies the rows were fine.
  const rejectsUnrecorded = rejectedTotal > 0 && storedRejectCount === 0

  // Labelled with the spreadsheet's own header rather than the derived
  // variable name — `First Name` is what the user will look for, not
  // `first_name`. The variable is only the key the data is stored under.
  //
  // Sorted by the recorded position, because Object.entries over a jsonb
  // column yields Postgres's key order (by length, then bytewise), which puts
  // `First Name` after `Notes` and makes the table unrecognisable. Lists
  // imported before `order` was recorded fall back to that order rather than
  // dropping their columns.
  const dataColumns: Column[] = Object.entries(list.columnMap)
    .filter(([, m]) => m.role === 'merge_var' || m.role === 'ai_context')
    .map(([header, m], index) => ({
      key: m.variable ?? '',
      label: header,
      order: m.order ?? index,
    }))
    .filter((c) => c.key)
    .sort((a, b) => a.order - b.order)

  const rejectCounts: Record<Reason, number> = {
    duplicate: list.duplicateCount,
    invalid_email: list.invalidCount,
    missing_email: list.missingCount,
    suppressed: list.suppressedCount,
  }

  // Built from REASON_LABELS so a new reject reason cannot be added to the
  // enum and silently go unlisted here.
  const tabs: { view: View; label: string; count: number }[] = [
    { view: 'contacts', label: 'Contacts', count: list.validCount },
    ...(Object.keys(REASON_LABELS) as Reason[]).map((reason) => ({
      view: reason,
      label: REASON_LABELS[reason],
      count: rejectCounts[reason],
    })),
  ]

  const contactColumns: Column[] = [
    { key: '__row', label: 'Row' },
    { key: '__email', label: 'Email' },
    ...dataColumns,
  ]

  const rejectColumns: Column[] = [
    { key: '__row', label: 'Row' },
    { key: '__email', label: 'Email as written' },
    { key: '__issue', label: 'Why' },
    ...dataColumns,
  ]

  return (
    <>
      <header className="border-border flex h-14 shrink-0 items-center gap-3 border-b px-4 sm:px-6">
        <Link
          href="/contacts"
          className="text-ink-muted hover:text-ink flex shrink-0 items-center gap-1.5 text-sm transition-colors"
        >
          <ArrowLeft className="size-4" />
          Contacts
        </Link>
        <span className="text-ink-subtle">/</span>
        <h1 className="truncate text-sm font-semibold tracking-tight">{list.name}</h1>
      </header>

      <main className="min-w-0 flex-1 p-4 sm:p-6">
        <div className="mx-auto flex w-full max-w-5xl min-w-0 flex-col gap-4">
          <p className="text-ink-muted text-sm">
            {list.sourceFilename ?? 'Manual list'} · {list.rowCount.toLocaleString()} rows read ·{' '}
            {list.validCount.toLocaleString()} imported
            {rejectedTotal > 0 && `, ${rejectedTotal.toLocaleString()} not`}
          </p>

          {/* Tabs, not filters: each is a link, so the view is shareable and
              the back button works. Same active treatment as the review
              screen's chips — a filled dark pill has no readable foreground
              token in either theme. */}
          <div className="flex flex-wrap gap-1.5">
            {tabs
              .filter((tab) => tab.count > 0 || tab.view === 'contacts')
              .map((tab) => (
                <Link
                  key={tab.view}
                  href={
                    tab.view === 'contacts' ? `/contacts/${id}` : `/contacts/${id}?show=${tab.view}`
                  }
                  aria-current={view === tab.view ? 'page' : undefined}
                  className={`rounded-lg border px-2.5 py-1 text-xs transition-colors ${
                    view === tab.view
                      ? 'border-accent bg-accent/10 text-accent'
                      : 'border-border text-ink-muted hover:border-border-strong hover:text-ink'
                  }`}
                >
                  {tab.label} <span className="tabular-nums">{tab.count.toLocaleString()}</span>
                </Link>
              ))}
          </div>

          {view === 'contacts' ? (
            rows.length === 0 ? (
              <EmptyNote>Nothing was imported into this list.</EmptyNote>
            ) : (
              <DataTable
                columns={contactColumns}
                rows={rows.map((row) => ({
                  id: row.id,
                  cells: {
                    __row: row.rowNumber,
                    __email: row.emailRaw,
                    ...row.data,
                  },
                }))}
                footer={
                  list.validCount > MAX_ROWS
                    ? `Showing the first ${MAX_ROWS} of ${list.validCount.toLocaleString()}.`
                    : null
                }
              />
            )
          ) : rejectsUnrecorded ? (
            <EmptyNote>
              This list was imported before rejected rows were kept, so the individual rows are not
              available — only the counts. Re-import the file to see them.
            </EmptyNote>
          ) : rejects.length === 0 ? (
            <EmptyNote>No rows in this category.</EmptyNote>
          ) : (
            <DataTable
              columns={rejectColumns}
              rows={rejects.map((row) => ({
                id: row.id,
                cells: {
                  __row: row.rowNumber,
                  __email: row.emailRaw || <span className="text-ink-subtle">empty</span>,
                  __issue: row.issue,
                  ...row.data,
                },
              }))}
              footer={rejects.length >= MAX_ROWS ? `Showing the first ${MAX_ROWS}.` : null}
            />
          )}

          {rejectedTotal > MAX_STORED_REJECTS && !rejectsUnrecorded && (
            <p className="text-ink-subtle text-xs">
              {rejectedTotal.toLocaleString()} rows were rejected; the first{' '}
              {MAX_STORED_REJECTS.toLocaleString()} were kept. The counts above are exact.
            </p>
          )}

          <div className="text-ink-subtle flex flex-wrap items-start gap-2 text-xs">
            <Badge tone={list.consentBasis === 'unknown' ? 'warning' : 'neutral'}>
              {list.consentBasis.replace(/_/g, ' ')}
            </Badge>
            {list.consentSource && <span className="pt-0.5">{list.consentSource}</span>}
          </div>
        </div>
      </main>
    </>
  )
}

interface DataRow {
  id: string
  cells: Record<string, React.ReactNode>
}

/**
 * A CSV can have any number of columns, so no layout fits every file.
 *
 * Wide screens get a real table that scrolls sideways inside its own card —
 * the page itself never scrolls horizontally. Narrow screens get one labelled
 * block per row instead, because a table squeezed into 375px is unreadable
 * however it is styled.
 */
function DataTable({
  columns,
  rows,
  footer,
}: {
  columns: Column[]
  rows: DataRow[]
  footer?: string | null
}) {
  return (
    <Card>
      <CardContent className="min-w-0 p-0">
        <div className="hidden overflow-x-auto md:block">
          <table className="w-full min-w-max text-left text-sm">
            <thead className="border-border text-ink-muted border-b text-xs">
              <tr>
                {columns.map((column) => (
                  <th key={column.key} className="px-3 py-2 font-medium whitespace-nowrap">
                    {column.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-border divide-y">
              {rows.map((row) => (
                <tr key={row.id}>
                  {columns.map((column) => (
                    <td
                      key={column.key}
                      className={
                        column.key === '__row'
                          ? 'text-ink-muted px-3 py-1.5 tabular-nums'
                          : column.key === '__email'
                            ? 'max-w-[18rem] truncate px-3 py-1.5'
                            : 'text-ink-muted max-w-[16rem] truncate px-3 py-1.5'
                      }
                    >
                      {row.cells[column.key] ?? ''}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <ul className="divide-border divide-y md:hidden">
          {rows.map((row) => (
            <li key={row.id} className="flex flex-col gap-1.5 p-4">
              {columns.map((column) => {
                const value = row.cells[column.key]
                if (value === undefined || value === '' || value === null) return null
                return (
                  <div key={column.key} className="flex gap-3 text-sm">
                    <span className="text-ink-subtle w-24 shrink-0 text-xs leading-5">
                      {column.label}
                    </span>
                    <span className="min-w-0 break-words">{value}</span>
                  </div>
                )
              })}
            </li>
          ))}
        </ul>

        {footer && (
          <p className="text-ink-subtle border-border border-t px-3 py-2 text-xs">{footer}</p>
        )}
      </CardContent>
    </Card>
  )
}

function EmptyNote({ children }: { children: React.ReactNode }) {
  return (
    <Card>
      <CardContent className="text-ink-muted flex items-start gap-2.5 p-5 text-sm">
        <Info className="text-ink-subtle mt-0.5 size-4 shrink-0" />
        <p>{children}</p>
      </CardContent>
    </Card>
  )
}
