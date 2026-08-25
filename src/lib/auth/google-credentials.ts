import { and, eq } from 'drizzle-orm'
import { db } from '@/db'
import { googleAccounts } from '@/db/schema'
import { seal } from '@/lib/crypto'
import { CONSUMER_DAILY_LIMIT, WORKSPACE_DAILY_LIMIT } from '@/core/gmail/scopes'

/**
 * Ownership of the Gmail credential.
 *
 * Supabase Auth runs the Google handshake, but it does not refresh provider
 * tokens and returns `provider_refresh_token` only on the FIRST consent for a
 * given grant. That is why the refresh token is captured here and encrypted
 * into our own table: from this point on, its lifecycle is ours.
 */

interface StoreArgs {
  userId: string
  googleEmail: string
  refreshToken: string | null
  scopes: string[]
}

/** A Workspace account is anything not on a consumer gmail.com/googlemail.com address. */
function dailyLimitFor(email: string): number {
  const domain = email.split('@')[1]?.toLowerCase() ?? ''
  return domain === 'gmail.com' || domain === 'googlemail.com'
    ? CONSUMER_DAILY_LIMIT
    : WORKSPACE_DAILY_LIMIT
}

/**
 * Persist the Gmail credential after sign-in.
 *
 * A null `refreshToken` is normal on re-authentication — Google reissues one
 * only when `prompt=consent` forces a fresh grant. When it is null we keep the
 * token already on file rather than wiping a working credential.
 */
export async function storeGoogleCredentials({
  userId,
  googleEmail,
  refreshToken,
  scopes,
}: StoreArgs): Promise<void> {
  const existing = await db.query.googleAccounts.findFirst({
    where: and(eq(googleAccounts.userId, userId), eq(googleAccounts.googleEmail, googleEmail)),
  })

  if (!refreshToken) {
    if (!existing) {
      // No token now and none stored: the account cannot send. The UI surfaces
      // this as "reconnect required" rather than failing at dispatch time.
      return
    }
    await db
      .update(googleAccounts)
      .set({ scopes, revokedAt: null, updatedAt: new Date() })
      .where(eq(googleAccounts.id, existing.id))
    return
  }

  // AAD binds the ciphertext to the owning user: a row copied to another
  // user's record fails to decrypt instead of leaking a working credential.
  const sealed = seal(refreshToken, userId)

  const values = {
    userId,
    googleEmail,
    refreshTokenCiphertext: sealed.ciphertext,
    refreshTokenIv: sealed.iv,
    refreshTokenTag: sealed.tag,
    scopes,
    dailyQuotaLimit: dailyLimitFor(googleEmail),
    revokedAt: null,
    updatedAt: new Date(),
  }

  if (existing) {
    await db.update(googleAccounts).set(values).where(eq(googleAccounts.id, existing.id))
  } else {
    await db.insert(googleAccounts).values(values)
  }
}
