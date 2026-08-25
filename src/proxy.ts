import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import { clientEnv } from '@/env'

/**
 * Next.js 16 renamed `middleware.ts` to `proxy.ts` and the `middleware` export
 * to `proxy`. The proxy always runs on the Node.js runtime; the edge runtime is
 * not supported here and cannot be configured.
 *
 * Two jobs:
 *   1. Refresh the Supabase session cookie on every request. Server Components
 *      cannot write cookies, so without this a session would silently expire
 *      mid-visit.
 *   2. Gate the authenticated area.
 */

const PUBLIC_PATHS = ['/login', '/auth', '/unsubscribe', '/api/unsubscribe']

export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request })

  const supabase = createServerClient(
    clientEnv.NEXT_PUBLIC_SUPABASE_URL,
    clientEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value)
          }
          response = NextResponse.next({ request })
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options)
          }
        },
      },
    },
  )

  // Must be getUser(), not getSession(): only getUser() revalidates the token
  // against the auth server. Do not "optimise" this into getSession().
  const {
    data: { user },
  } = await supabase.auth.getUser()

  const { pathname } = request.nextUrl
  const isPublic = PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))

  if (!user && !isPublic) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    // Preserve where they were heading so login can return them there.
    url.searchParams.set('next', pathname)
    return NextResponse.redirect(url)
  }

  if (user && pathname === '/login') {
    const url = request.nextUrl.clone()
    url.pathname = '/campaigns'
    url.search = ''
    return NextResponse.redirect(url)
  }

  return response
}

export const config = {
  matcher: [
    /*
     * Everything except static assets and image files. Keeping the proxy off
     * static requests matters — it does a network round-trip to the auth
     * server on every match.
     */
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
  ],
}
