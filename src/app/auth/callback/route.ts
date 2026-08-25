import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { storeGoogleCredentials } from '@/lib/auth/google-credentials'
import { syncGrantedScopes } from '@/lib/gmail/auth'
import { scopeStringFor } from '@/core/gmail/scopes'

/**
 * OAuth callback.
 *
 * Exchanges the code for a session, then captures the Google refresh token —
 * this is the only moment it is ever visible. Supabase does not store or
 * refresh provider tokens for us.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl
  const code = searchParams.get('code')
  const next = searchParams.get('next') ?? '/campaigns'
  // Set by the settings page when re-consenting for mailbox read access.
  // Google grants what was asked for or the user declines outright, so the
  // requested scope is what gets recorded.
  const includeRead = searchParams.get('scopes') === 'read'
  const oauthError = searchParams.get('error')

  if (oauthError) {
    const description = searchParams.get('error_description') ?? oauthError
    return NextResponse.redirect(`${origin}/login?error=${encodeURIComponent(description)}`)
  }

  if (!code) {
    return NextResponse.redirect(
      `${origin}/login?error=${encodeURIComponent('No authorization code returned')}`,
    )
  }

  const supabase = await createClient()
  const { data, error } = await supabase.auth.exchangeCodeForSession(code)

  if (error || !data.session) {
    return NextResponse.redirect(
      `${origin}/login?error=${encodeURIComponent(error?.message ?? 'Sign-in failed')}`,
    )
  }

  const { session } = data
  const email = session.user.email

  if (email) {
    try {
      await storeGoogleCredentials({
        userId: session.user.id,
        googleEmail: email,
        // Present only on a fresh grant. storeGoogleCredentials keeps any
        // existing token when this is null.
        refreshToken: session.provider_refresh_token ?? null,
        scopes: scopeStringFor(includeRead).split(' '),
      })

      // Replace the requested scopes with the ones Google actually granted.
      // Without this the app can believe it may send when it may not, and the
      // discrepancy only appears as a 403 partway through a campaign.
      await syncGrantedScopes(session.user.id)
    } catch (cause) {
      // Sign-in itself succeeded. A failure to persist the Gmail credential
      // must not lock the user out — the app is fully usable without send
      // capability, and Settings shows a "reconnect Gmail" prompt.
      console.error('[auth/callback] failed to store Google credentials:', cause)
    }
  }

  // Only relative paths, so a crafted `next` cannot bounce the user off-site.
  const target = next.startsWith('/') ? next : '/campaigns'
  return NextResponse.redirect(`${origin}${target}`)
}
