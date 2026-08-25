/**
 * NOT marked `server-only` — see the note in src/lib/queue/index.ts. The
 * worker imports this by design.
 */

import { getAccessToken } from './auth'
import { GmailSendError } from './send'

/**
 * Reading the mailbox.
 *
 * Only used by the opt-in bounce and reply poller. Everything here needs the
 * `gmail.readonly` scope, which the app does not request unless the user turns
 * polling on — reading someone's whole mailbox is a much bigger ask than
 * sending on their behalf, and it should not be the default.
 */

const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me'

export interface GmailMessageSummary {
  id: string
  threadId: string
}

export interface GmailMessage {
  id: string
  threadId: string
  labelIds: string[]
  internalDate: number
  from: string
  subject: string
  /** Decoded text of the message, headers included, for the bounce parser. */
  raw: string
}

async function call<T>(userId: string, path: string, accountId?: string): Promise<T> {
  const { accessToken } = await getAccessToken(userId, accountId)
  const response = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })

  if (response.ok) return (await response.json()) as T

  const body = (await response.json().catch(() => ({}))) as { error?: { message?: string } }
  const detail = body.error?.message ?? `HTTP ${response.status}`

  if (response.status === 403) {
    // Almost always the missing readonly scope rather than a quota problem,
    // because reading is cheap. Retrying will not fix it.
    throw new GmailSendError(
      `Gmail refused the read: ${detail}. Inbox polling needs the gmail.readonly scope — enable it in Settings → Compliance and sign in again.`,
      403,
      false,
      true,
    )
  }
  if (response.status === 401) {
    throw new GmailSendError(`Gmail rejected the token: ${detail}`, 401, true, true)
  }
  if (response.status === 429 || response.status >= 500) {
    throw new GmailSendError(`Gmail unavailable: ${detail}`, response.status, true)
  }
  throw new GmailSendError(`Gmail read failed: ${detail}`, response.status, false)
}

/**
 * Search the mailbox.
 *
 * `q` uses Gmail's own search syntax, which is what keeps this cheap: the
 * filtering happens on Google's side rather than by fetching everything.
 */
export async function listMessages(
  userId: string,
  query: string,
  options: { accountId?: string; max?: number } = {},
): Promise<GmailMessageSummary[]> {
  const max = Math.min(options.max ?? 50, 200)
  const params = new URLSearchParams({ q: query, maxResults: String(max) })

  const payload = await call<{ messages?: GmailMessageSummary[] }>(
    userId,
    `/messages?${params}`,
    options.accountId,
  )
  return payload.messages ?? []
}

interface RawPayload {
  id: string
  threadId: string
  labelIds?: string[]
  internalDate?: string
  raw?: string
}

/**
 * Fetch one message in `raw` format.
 *
 * Raw rather than parsed: the bounce parser wants the delivery-status part
 * verbatim, and Gmail's structured `payload` view splits it across nested
 * parts that would have to be reassembled anyway.
 */
export async function getMessage(
  userId: string,
  messageId: string,
  accountId?: string,
): Promise<GmailMessage> {
  const payload = await call<RawPayload>(userId, `/messages/${messageId}?format=raw`, accountId)

  const raw = payload.raw ? Buffer.from(payload.raw, 'base64url').toString('utf8') : ''

  return {
    id: payload.id,
    threadId: payload.threadId,
    labelIds: payload.labelIds ?? [],
    internalDate: Number(payload.internalDate ?? 0),
    from: headerOf(raw, 'From'),
    subject: headerOf(raw, 'Subject'),
    raw,
  }
}

/** Read one header out of a raw message, unfolding continuation lines. */
export function headerOf(raw: string, name: string): string {
  const [head] = raw.split(/\r?\n\r?\n/)
  if (!head) return ''

  // RFC 5322 allows a header to continue on an indented line.
  const unfolded = head.replace(/\r?\n[ \t]+/g, ' ')
  const pattern = new RegExp(`^${name}:\\s*(.*)$`, 'im')
  return pattern.exec(unfolded)?.[1]?.trim() ?? ''
}

/** Gmail search query for bounces since a given time. */
export function bounceQuery(since: Date): string {
  const days = Math.max(1, Math.ceil((Date.now() - since.getTime()) / (24 * 60 * 60 * 1000)))
  return `(from:mailer-daemon OR from:postmaster OR subject:"delivery status notification" OR subject:undeliverable) newer_than:${days}d`
}

/** Gmail search query for inbound replies since a given time. */
export function replyQuery(since: Date): string {
  const days = Math.max(1, Math.ceil((Date.now() - since.getTime()) / (24 * 60 * 60 * 1000)))
  // `in:inbox` excludes the copies of what we sent, which live in Sent.
  return `in:inbox -from:mailer-daemon -from:postmaster newer_than:${days}d`
}
