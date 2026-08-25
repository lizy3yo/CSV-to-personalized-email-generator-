/**
 * Google OAuth scopes.
 *
 * `gmail.send` is a restricted-tier scope. A publicly distributed app would
 * need Google's OAuth verification review — but this app does not: keeping the
 * Cloud Console consent screen in "Testing" mode and adding yourself as a test
 * user (up to 100 are allowed) skips verification entirely.
 *
 * `gmail.readonly` is deliberately NOT requested by default. It is only needed
 * for the opt-in phase-8 feature that polls the inbox for mailer-daemon bounces
 * and replies — Gmail has no bounce webhooks, so that is the only way to detect
 * them. Asking for read access to someone's whole mailbox is not something to
 * do by default.
 */

export const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send'
export const GMAIL_READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly'

/** Requested at sign-in. Identity plus the ability to send as the user. */
export const BASE_SCOPES = ['openid', 'email', 'profile', GMAIL_SEND_SCOPE] as const

export const DEFAULT_SCOPE_STRING = BASE_SCOPES.join(' ')

/** Consumer Gmail: 500 recipients/day. Google Workspace: 2,000. Rolling 24h. */
export const CONSUMER_DAILY_LIMIT = 500
export const WORKSPACE_DAILY_LIMIT = 2000

export function hasSendScope(scopes: readonly string[]): boolean {
  return scopes.includes(GMAIL_SEND_SCOPE)
}

export function hasReadScope(scopes: readonly string[]): boolean {
  return scopes.includes(GMAIL_READONLY_SCOPE)
}

/**
 * Scopes to request at sign-in.
 *
 * `gmail.readonly` is added only when the user has opted into bounce and reply
 * detection — Gmail pushes neither, so the only way to see them is to read the
 * mailbox. That is a far broader permission than sending, so it is never
 * requested by default.
 */
export function scopeStringFor(includeRead: boolean): string {
  return includeRead ? [...BASE_SCOPES, GMAIL_READONLY_SCOPE].join(' ') : DEFAULT_SCOPE_STRING
}
