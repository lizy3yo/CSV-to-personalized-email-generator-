import { NextResponse, type NextRequest } from 'next/server'
import { suppressByToken } from '@/lib/compliance/unsubscribe'
import { clientEnv } from '@/env'

/**
 * One-click unsubscribe (RFC 8058).
 *
 * This is the URL named by the `List-Unsubscribe` header, and it is what
 * Gmail's native unsubscribe control POSTs to. It must work with no session:
 * the recipient is not a user of this app.
 *
 * GET does NOT unsubscribe. Corporate mail scanners and Gmail itself prefetch
 * links inside messages, so a GET that changed state would unsubscribe people
 * who never clicked anything. GET redirects to the confirmation page.
 */

export const dynamic = 'force-dynamic'

export async function POST(
  request: NextRequest,
  context: RouteContext<'/api/unsubscribe/[token]'>,
) {
  const { token } = await context.params

  // Gmail POSTs `List-Unsubscribe=One-Click` as a form body. Acting does not
  // depend on it, so it is not parsed.
  await suppressByToken(token, 'One-click unsubscribe')

  // Always 200, even for a bad token. A non-2xx tells the caller the token was
  // invalid — which leaks whether an address is on a list — and RFC 8058
  // clients treat it as a failure worth retrying, which helps nobody.
  return new NextResponse('Unsubscribed', {
    status: 200,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  })
}

export async function GET(request: NextRequest, context: RouteContext<'/api/unsubscribe/[token]'>) {
  const { token } = await context.params
  const base = clientEnv.NEXT_PUBLIC_SITE_URL.replace(/\/+$/, '')
  return NextResponse.redirect(`${base}/unsubscribe/${token}`, 302)
}
