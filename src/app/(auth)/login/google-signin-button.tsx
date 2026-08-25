'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { createClient } from '@/lib/supabase/client'
import { DEFAULT_SCOPE_STRING } from '@/core/gmail/scopes'

export function GoogleSignInButton({ next }: { next?: string }) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function signIn() {
    setPending(true)
    setError(null)

    const supabase = createClient()
    const redirect = new URL('/auth/callback', window.location.origin)
    if (next) redirect.searchParams.set('next', next)

    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        scopes: DEFAULT_SCOPE_STRING,
        redirectTo: redirect.toString(),
        queryParams: {
          // Both are required to receive a refresh token. Without
          // access_type=offline Google issues none; without prompt=consent it
          // reissues one only on the very first grant, so a user who has
          // signed in before would come back with no way to send.
          access_type: 'offline',
          prompt: 'consent',
        },
      },
    })

    if (error) {
      setError(error.message)
      setPending(false)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <Button onClick={signIn} disabled={pending} size="lg" className="w-full">
        <GoogleMark />
        {pending ? 'Redirecting to Google…' : 'Continue with Google'}
      </Button>
      {error && (
        <p role="alert" className="text-danger text-sm">
          {error}
        </p>
      )}
    </div>
  )
}

function GoogleMark() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="size-5">
      <path
        fill="#4285F4"
        d="M23.5 12.27c0-.79-.07-1.54-.2-2.27H12v4.51h6.47a5.53 5.53 0 0 1-2.4 3.58v3h3.86c2.26-2.09 3.57-5.17 3.57-8.82Z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.86-3c-1.08.72-2.45 1.16-4.07 1.16-3.13 0-5.78-2.11-6.73-4.96H1.29v3.09A11.99 11.99 0 0 0 12 24Z"
      />
      <path
        fill="#FBBC05"
        d="M5.27 14.29a7.2 7.2 0 0 1 0-4.58V6.62H1.29a12 12 0 0 0 0 10.76l3.98-3.09Z"
      />
      <path
        fill="#EA4335"
        d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.7 0 3.99 2.47 1.29 6.62l3.98 3.09C6.22 6.86 8.87 4.75 12 4.75Z"
      />
    </svg>
  )
}
