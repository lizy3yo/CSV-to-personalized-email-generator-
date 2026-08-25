import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto'
import { serverEnv } from '@/env'

/**
 * Authenticated encryption for credentials at rest.
 *
 * Two secrets live in the database and neither may ever be stored in plaintext:
 *   • the user's Google refresh token (grants Gmail send on their behalf)
 *   • the user's Anthropic API key (spends their money)
 *
 * AES-256-GCM gives confidentiality AND integrity — a tampered ciphertext
 * fails to decrypt rather than silently producing garbage.
 */

const ALGORITHM = 'aes-256-gcm'
const IV_BYTES = 12 // 96 bits — the GCM standard; never reuse an IV with a key
const KEY_BYTES = 32

export interface Sealed {
  ciphertext: string
  iv: string
  tag: string
}

function key(): Buffer {
  const k = Buffer.from(serverEnv().ENCRYPTION_KEY, 'base64')
  if (k.length !== KEY_BYTES) {
    throw new Error(`ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes, got ${k.length}`)
  }
  return k
}

/**
 * Encrypt a secret.
 *
 * `aad` (additional authenticated data) binds the ciphertext to a context —
 * pass the owning user id. A row copied to another user's record then fails
 * to decrypt instead of leaking a working credential.
 */
export function seal(plaintext: string, aad?: string): Sealed {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, key(), iv)
  if (aad) cipher.setAAD(Buffer.from(aad, 'utf8'))
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  }
}

/** Decrypt a secret. Throws if the ciphertext, tag, key, or `aad` do not match. */
export function open(sealed: Sealed, aad?: string): string {
  const decipher = createDecipheriv(ALGORITHM, key(), Buffer.from(sealed.iv, 'base64'))
  if (aad) decipher.setAAD(Buffer.from(aad, 'utf8'))
  decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'))
  return Buffer.concat([
    decipher.update(Buffer.from(sealed.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8')
}

/**
 * Last 4 characters of a secret, for display.
 * Lets the UI show `sk-ant-…4f2a` so a user can confirm *which* key is stored
 * without the plaintext ever being readable again.
 */
export function fingerprint(secret: string): string {
  return secret.slice(-4)
}

/**
 * Sign a one-click unsubscribe token.
 *
 * HMAC rather than a database table: the token is self-verifying, so an
 * unsubscribe link keeps working even if the campaign row is deleted, and
 * there is no per-recipient row to look up on a hot public endpoint.
 */
export function signUnsubscribeToken(recipientId: string, email: string): string {
  const payload = `${recipientId}:${email.toLowerCase()}`
  const mac = createHmac('sha256', Buffer.from(serverEnv().UNSUBSCRIBE_SECRET, 'base64'))
    .update(payload)
    .digest('base64url')
  return `${Buffer.from(payload, 'utf8').toString('base64url')}.${mac}`
}

/** Verify an unsubscribe token in constant time. Returns null if invalid. */
export function verifyUnsubscribeToken(
  token: string,
): { recipientId: string; email: string } | null {
  const [encoded, mac] = token.split('.')
  if (!encoded || !mac) return null

  let payload: string
  try {
    payload = Buffer.from(encoded, 'base64url').toString('utf8')
  } catch {
    return null
  }

  const expected = createHmac('sha256', Buffer.from(serverEnv().UNSUBSCRIBE_SECRET, 'base64'))
    .update(payload)
    .digest('base64url')

  const a = Buffer.from(mac)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null

  const idx = payload.indexOf(':')
  if (idx === -1) return null
  return { recipientId: payload.slice(0, idx), email: payload.slice(idx + 1) }
}
