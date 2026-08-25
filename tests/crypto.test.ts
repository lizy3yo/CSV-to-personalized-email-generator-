import { describe, expect, it } from 'vitest'
import { fingerprint, open, seal, signUnsubscribeToken, verifyUnsubscribeToken } from '@/lib/crypto'

describe('seal / open', () => {
  it('round-trips a secret', () => {
    const secret = 'sk-ant-api03-abcdefghijklmnop'
    expect(open(seal(secret))).toBe(secret)
  })

  it('produces a different ciphertext each time', () => {
    // A fresh IV per call. Identical ciphertexts would leak that two users
    // stored the same credential.
    const a = seal('same-input')
    const b = seal('same-input')
    expect(a.ciphertext).not.toBe(b.ciphertext)
    expect(a.iv).not.toBe(b.iv)
    expect(open(a)).toBe(open(b))
  })

  it('round-trips with additional authenticated data', () => {
    const userId = '11111111-1111-4111-8111-111111111111'
    expect(open(seal('token', userId), userId)).toBe('token')
  })

  it('refuses to decrypt under a different aad', () => {
    // This is the property that matters: a credential row copied onto another
    // user cannot be decrypted, so it cannot leak a working token.
    const sealed = seal('token', 'user-a')
    expect(() => open(sealed, 'user-b')).toThrow()
  })

  it('refuses to decrypt when aad is omitted', () => {
    const sealed = seal('token', 'user-a')
    expect(() => open(sealed)).toThrow()
  })

  it('detects a tampered ciphertext', () => {
    const sealed = seal('token')
    const bytes = Buffer.from(sealed.ciphertext, 'base64')
    bytes[0] ^= 0xff
    expect(() => open({ ...sealed, ciphertext: bytes.toString('base64') })).toThrow()
  })

  it('detects a tampered auth tag', () => {
    const sealed = seal('token')
    const tag = Buffer.from(sealed.tag, 'base64')
    tag[0] ^= 0xff
    expect(() => open({ ...sealed, tag: tag.toString('base64') })).toThrow()
  })

  it('handles unicode and empty input', () => {
    expect(open(seal('café ☕ 日本語'))).toBe('café ☕ 日本語')
    expect(open(seal(''))).toBe('')
  })
})

describe('fingerprint', () => {
  it('returns the last four characters for display', () => {
    expect(fingerprint('sk-ant-api03-abcd4f2a')).toBe('4f2a')
  })
})

describe('unsubscribe tokens', () => {
  const id = '22222222-2222-4222-8222-222222222222'

  it('round-trips id and email', () => {
    const token = signUnsubscribeToken(id, 'Ana.Chen@Northwind.io')
    expect(verifyUnsubscribeToken(token)).toEqual({
      recipientId: id,
      // Normalised, so the suppression list matches regardless of the casing
      // the address was typed in.
      email: 'ana.chen@northwind.io',
    })
  })

  it('rejects a tampered signature', () => {
    const token = signUnsubscribeToken(id, 'a@b.com')
    const [payload] = token.split('.')
    expect(verifyUnsubscribeToken(`${payload}.forged-signature`)).toBeNull()
  })

  it('rejects a tampered payload', () => {
    const token = signUnsubscribeToken(id, 'a@b.com')
    const [, mac] = token.split('.')
    const forged = Buffer.from(`${id}:attacker@evil.com`).toString('base64url')
    expect(verifyUnsubscribeToken(`${forged}.${mac}`)).toBeNull()
  })

  it('rejects malformed tokens', () => {
    for (const bad of ['', 'nodot', '.', 'a.', '.b']) {
      expect(verifyUnsubscribeToken(bad)).toBeNull()
    }
  })
})
