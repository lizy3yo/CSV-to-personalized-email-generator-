import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { clientEnv } from '@/env'

/**
 * Server-side Supabase client for Server Components, Server Actions and
 * Route Handlers.
 *
 * `cookies()` is async in Next.js 16 — synchronous access was removed, not
 * just deprecated.
 */
export async function createClient() {
  const cookieStore = await cookies()

  return createServerClient(
    clientEnv.NEXT_PUBLIC_SUPABASE_URL,
    clientEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options)
            }
          } catch {
            // Server Components cannot set cookies. This is expected and safe:
            // proxy.ts refreshes the session on every request, so the cookie is
            // already current by the time a Server Component reads it.
          }
        },
      },
    },
  )
}

/**
 * The signed-in user, or null.
 *
 * Uses `getUser()` rather than `getSession()` — `getSession()` reads the cookie
 * without revalidating it, so it can return a forged or stale identity.
 * `getUser()` verifies against the auth server. Never trust `getSession()` for
 * authorization decisions.
 */
export async function getCurrentUser() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  return user
}
