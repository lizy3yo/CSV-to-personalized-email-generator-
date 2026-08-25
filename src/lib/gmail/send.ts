/**
 * NOT marked `server-only` — see the note in src/lib/queue/index.ts. The
 * worker imports this by design.
 */

import { getAccessToken, GoogleAuthError } from './auth'
import { buildRawMessage, toBase64Url, type BuildMessageInput } from '@/core/gmail/message'

/**
 * Sending, via `users.messages.send`.
 *
 * Plain `fetch` rather than the `googleapis` package: this needs one endpoint
 * and one token refresh, and the SDK is a large dependency to carry for that.
 *
 * The important thing this module does NOT do is retry. Gmail's API has no
 * idempotency parameter, so a request that times out may or may not have
 * delivered — and blindly retrying it is how someone gets the same email
 * twice. Retry decisions belong to the caller, which knows the recipient's
 * state; see `SendOutcome.retryable`.
 */

const SEND_ENDPOINT = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send'

export interface SendResult {
  messageId: string
  threadId: string
}

export class GmailSendError extends Error {
  readonly status: number
  /** Safe to try again — the message was NOT accepted. */
  readonly retryable: boolean
  readonly needsReconnect: boolean

  constructor(message: string, status: number, retryable: boolean, needsReconnect = false) {
    super(message)
    this.name = 'GmailSendError'
    this.status = status
    this.retryable = retryable
    this.needsReconnect = needsReconnect
  }
}

export interface SendMessageInput extends BuildMessageInput {
  userId: string
  googleAccountId?: string
  /** Gmail thread to attach this message to, for a threaded follow-up. */
  threadId?: string
}

export async function sendMessage(input: SendMessageInput): Promise<SendResult> {
  const { accessToken } = await getAccessToken(input.userId, input.googleAccountId)

  const raw = toBase64Url(buildRawMessage(input))

  const response = await fetch(SEND_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(input.threadId ? { raw, threadId: input.threadId } : { raw }),
  })

  if (response.ok) {
    const payload = (await response.json()) as { id: string; threadId: string }
    return { messageId: payload.id, threadId: payload.threadId }
  }

  const body = (await response.json().catch(() => ({}))) as {
    error?: { message?: string; status?: string; errors?: { reason?: string }[] }
  }
  const detail = body.error?.message ?? `HTTP ${response.status}`
  const reason = body.error?.errors?.[0]?.reason ?? ''

  if (response.status === 401) {
    throw new GmailSendError(`Gmail rejected the token: ${detail}`, 401, true, true)
  }

  if (response.status === 403) {
    // Two very different 403s share a status code. Exceeding the send quota is
    // temporary; missing the scope is not, and retrying it just burns attempts.
    const isQuota = /quota|rateLimit|userRateLimitExceeded|limitExceeded/i.test(
      `${reason} ${detail}`,
    )
    throw new GmailSendError(
      isQuota
        ? `Gmail daily sending limit reached: ${detail}`
        : `Gmail refused the request: ${detail}. The gmail.send scope may be missing — sign in again.`,
      403,
      isQuota,
      !isQuota,
    )
  }

  if (response.status === 429) {
    throw new GmailSendError(`Gmail rate-limited the request: ${detail}`, 429, true)
  }

  if (response.status >= 500) {
    throw new GmailSendError(`Gmail server error: ${detail}`, response.status, true)
  }

  // A 400 means the message itself is wrong. Retrying an identical malformed
  // message cannot succeed.
  throw new GmailSendError(`Gmail rejected the message: ${detail}`, response.status, false)
}

/** Turn any send-path error into something a person can act on. */
export function describeSendError(error: unknown): {
  message: string
  retryable: boolean
  needsReconnect: boolean
} {
  if (error instanceof GmailSendError) {
    return {
      message: error.message,
      retryable: error.retryable,
      needsReconnect: error.needsReconnect,
    }
  }
  if (error instanceof GoogleAuthError) {
    return { message: error.message, retryable: false, needsReconnect: error.needsReconnect }
  }
  if (error instanceof TypeError) {
    // fetch throws TypeError on a network failure — nothing was delivered.
    return {
      message: `Could not reach Gmail: ${error.message}`,
      retryable: true,
      needsReconnect: false,
    }
  }
  return {
    message: error instanceof Error ? error.message : 'Send failed',
    retryable: false,
    needsReconnect: false,
  }
}
