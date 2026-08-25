import type { Metadata } from 'next'
import { peekToken, suppressByToken } from '@/lib/compliance/unsubscribe'

export const metadata: Metadata = { title: 'Unsubscribe' }
export const dynamic = 'force-dynamic'

/**
 * The confirmation page.
 *
 * Reached from the visible link in a bulk footer, or by anyone who follows the
 * List-Unsubscribe URL in a browser. Rendering it changes nothing — the
 * suppression happens only when the form is submitted, because link scanners
 * fetch every URL in a message and a GET that acted would unsubscribe people
 * who never clicked.
 *
 * Deliberately outside the authenticated layout: the recipient has no account
 * here and must never be asked to sign in to stop receiving mail.
 */
export default async function UnsubscribePage(props: PageProps<'/unsubscribe/[token]'>) {
  const { token } = await props.params
  const search = await props.searchParams
  const done = search.done === '1'

  const peeked = peekToken(token)

  async function confirm() {
    'use server'
    await suppressByToken(token, 'Confirmed from the unsubscribe page')
    const { redirect } = await import('next/navigation')
    redirect(`/unsubscribe/${token}?done=1`)
  }

  return (
    <main className="flex min-h-dvh items-center justify-center p-6">
      <div className="border-border bg-surface w-full max-w-md rounded-xl border p-8 shadow-sm">
        {done ? (
          <>
            <h1 className="text-lg font-semibold tracking-tight">You have been unsubscribed</h1>
            <p className="text-ink-muted mt-3 text-sm leading-relaxed">
              {peeked?.email ? (
                <>
                  <span className="text-ink font-medium">{peeked.email}</span> will not receive
                  further messages from this sender.
                </>
              ) : (
                'You will not receive further messages from this sender.'
              )}
            </p>
            <p className="text-ink-subtle mt-4 text-xs">You can close this page.</p>
          </>
        ) : !peeked ? (
          <>
            <h1 className="text-lg font-semibold tracking-tight">This link is not valid</h1>
            <p className="text-ink-muted mt-3 text-sm leading-relaxed">
              It may have been altered in transit or truncated by a mail client. Replying to the
              message and asking to be removed works just as well.
            </p>
          </>
        ) : (
          <>
            <h1 className="text-lg font-semibold tracking-tight">Unsubscribe</h1>
            <p className="text-ink-muted mt-3 text-sm leading-relaxed">
              Stop sending messages to <span className="text-ink font-medium">{peeked.email}</span>?
            </p>
            <form action={confirm} className="mt-6">
              <button
                type="submit"
                className="bg-accent text-accent-fg hover:bg-accent-hover h-11 w-full rounded-lg text-sm font-medium transition-colors"
              >
                Yes, unsubscribe me
              </button>
            </form>
            <p className="text-ink-subtle mt-4 text-xs leading-relaxed">
              Nothing has happened yet. Confirming is required because mail scanners open links
              automatically, and a link that acted on being opened would unsubscribe people who
              never clicked.
            </p>
          </>
        )}
      </div>
    </main>
  )
}
