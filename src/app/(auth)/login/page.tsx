import type { Metadata } from 'next'
import { GoogleSignInButton } from './google-signin-button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

export const metadata: Metadata = { title: 'Sign in' }

export default async function LoginPage(props: PageProps<'/login'>) {
  // searchParams is a Promise in Next.js 16 — synchronous access was removed.
  const params = await props.searchParams
  const error = typeof params.error === 'string' ? params.error : null
  const next = typeof params.next === 'string' ? params.next : undefined

  return (
    <main className="flex min-h-dvh items-center justify-center p-6">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">CSV → Personalized Email</h1>
          <p className="text-ink-muted mt-2 text-sm">
            Turn a spreadsheet into individually written emails, reviewed before anything sends.
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Sign in</CardTitle>
            <CardDescription>
              Signing in with Google also connects the mailbox you will send from. Replies come back
              to your own inbox and stay in the thread.
            </CardDescription>
          </CardHeader>

          <CardContent className="flex flex-col gap-4">
            {error && (
              <div
                role="alert"
                className="border-danger/30 bg-danger/10 text-danger rounded-lg border p-3 text-sm"
              >
                {error}
              </div>
            )}

            <GoogleSignInButton next={next} />

            <p className="text-ink-subtle text-xs leading-relaxed">
              Requests permission to send mail as you. It never reads your mailbox — inbox access is
              a separate, optional setting used only for bounce detection. Your credentials are
              encrypted before they are stored.
            </p>
          </CardContent>
        </Card>
      </div>
    </main>
  )
}
