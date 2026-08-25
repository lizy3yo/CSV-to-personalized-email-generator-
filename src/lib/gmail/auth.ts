/**
 * NOT marked `server-only` — see the note in src/lib/queue/index.ts. The
 * worker imports this by design.
 */

import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { googleAccounts } from '@/db/schema'
import { open, seal } from '@/lib/crypto'
import { serverEnv } from '@/env'

/**
 * Google access tokens, from the refresh token we captured at sign-in.
 *
 * Supabase performs the initial handshake but does not refresh provider
 * tokens, so this is ours to run. The access token is cached — encrypted,
 * like the refresh token — because minting a new one before every send would
 * add a round trip to Google for each email and hit their token endpoint far
 * harder than necessary.
 */

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'

/** Refresh this long before actual expiry, so a send never races the clock. */
const EXPIRY_SKEW_MS = 5 * 60 * 1000

export class GoogleAuthError extends Error {
  /** True when the user must re-consent; retrying will not help. */
  readonly needsReconnect: boolean

  constructor(message: string, needsReconnect = false) {
    super(message)
    this.name = 'GoogleAuthError'
    this.needsReconnect = needsReconnect
  }
}

export interface GoogleAccountToken {
  accessToken: string
  googleEmail: string
  dailyQuotaLimit: number
  accountId: string
}

export async function getAccessToken(
  userId: string,
  accountId?: string,
): Promise<GoogleAccountToken> {
  const account = accountId
    ? await db.query.googleAccounts.findFirst({ where: eq(googleAccounts.id, accountId) })
    : await db.query.googleAccounts.findFirst({ where: eq(googleAccounts.userId, userId) })

  if (!account) {
    throw new GoogleAuthError('No Gmail account is connected. Sign in with Google again.', true)
  }
  if (account.userId !== userId) {
    throw new GoogleAuthError('That Gmail account belongs to a different user.', false)
  }
  if (account.revokedAt) {
    throw new GoogleAuthError('Access to Gmail was revoked. Sign in again to reconnect.', true)
  }

  const cached = readCachedToken(account, userId)
  if (cached) {
    return {
      accessToken: cached,
      googleEmail: account.googleEmail,
      dailyQuotaLimit: account.dailyQuotaLimit,
      accountId: account.id,
    }
  }

  const refreshToken = open(
    {
      ciphertext: account.refreshTokenCiphertext,
      iv: account.refreshTokenIv,
      tag: account.refreshTokenTag,
    },
    userId,
  )

  const env = serverEnv()
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    throw new GoogleAuthError(
      'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not configured. See SETUP.md step 5.',
      false,
    )
  }

  const response = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  })

  const payload = (await response.json().catch(() => ({}))) as {
    access_token?: string
    expires_in?: number
    /** Space-separated list of what was actually granted. */
    scope?: string
    error?: string
    error_description?: string
  }

  if (!response.ok || !payload.access_token) {
    // `invalid_grant` means the user revoked access or changed their password.
    // Recorded so the UI can prompt a reconnect rather than retrying forever.
    if (payload.error === 'invalid_grant') {
      await db
        .update(googleAccounts)
        .set({ revokedAt: new Date() })
        .where(eq(googleAccounts.id, account.id))
      throw new GoogleAuthError(
        'Google rejected the stored credential. Sign in again to reconnect Gmail.',
        true,
      )
    }
    throw new GoogleAuthError(
      `Could not refresh the Google token: ${payload.error_description ?? payload.error ?? response.status}`,
      false,
    )
  }

  const expiresAt = new Date(Date.now() + (payload.expires_in ?? 3600) * 1000)
  const sealed = seal(payload.access_token, userId)

  await db
    .update(googleAccounts)
    .set({
      accessTokenCiphertext: sealed.ciphertext,
      accessTokenIv: sealed.iv,
      accessTokenTag: sealed.tag,
      accessTokenExpiresAt: expiresAt,
      // The scopes Google ACTUALLY granted, not the ones we asked for.
      //
      // Google silently drops a scope it will not grant — a restricted scope
      // missing from the consent screen, or one the user declined — and still
      // returns a perfectly valid token. Recording the request instead of the
      // response makes the app believe it can send when it cannot, and the
      // truth only surfaces as a 403 partway through a campaign.
      ...(payload.scope ? { scopes: payload.scope.split(' ').filter(Boolean) } : {}),
      revokedAt: null,
      updatedAt: new Date(),
    })
    .where(eq(googleAccounts.id, account.id))

  return {
    accessToken: payload.access_token,
    googleEmail: account.googleEmail,
    dailyQuotaLimit: account.dailyQuotaLimit,
    accountId: account.id,
  }
}

type AccountRow = typeof googleAccounts.$inferSelect

function readCachedToken(account: AccountRow, userId: string): string | null {
  if (
    !account.accessTokenCiphertext ||
    !account.accessTokenIv ||
    !account.accessTokenTag ||
    !account.accessTokenExpiresAt
  ) {
    return null
  }
  if (account.accessTokenExpiresAt.getTime() - EXPIRY_SKEW_MS < Date.now()) return null

  try {
    return open(
      {
        ciphertext: account.accessTokenCiphertext,
        iv: account.accessTokenIv,
        tag: account.accessTokenTag,
      },
      userId,
    )
  } catch {
    // A cached token that will not decrypt (rotated ENCRYPTION_KEY, corrupted
    // row) is not fatal — mint a fresh one.
    return null
  }
}

/**
 * Confirm what Google actually granted, and record it.
 *
 * Called right after sign-in. Forces a refresh so the token response reports
 * the real scope list, which is the only trustworthy source — the request we
 * made says nothing about what was approved.
 *
 * Returns the granted scopes, or null if a token could not be minted at all.
 */
export async function syncGrantedScopes(userId: string): Promise<string[] | null> {
  const account = await db.query.googleAccounts.findFirst({
    where: eq(googleAccounts.userId, userId),
  })
  if (!account) return null

  // Clearing the cached access token forces a real refresh rather than a
  // cache hit, which is what carries the scope list.
  await db
    .update(googleAccounts)
    .set({ accessTokenExpiresAt: null })
    .where(eq(googleAccounts.id, account.id))

  try {
    await getAccessToken(userId, account.id)
  } catch {
    return null
  }

  const updated = await db.query.googleAccounts.findFirst({
    where: eq(googleAccounts.id, account.id),
  })
  return updated?.scopes ?? null
}
