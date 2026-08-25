import { describe, expect, it } from 'vitest'
import {
  BASE_SCOPES,
  DEFAULT_SCOPE_STRING,
  GMAIL_READONLY_SCOPE,
  GMAIL_SEND_SCOPE,
  hasSendScope,
} from '@/core/gmail/scopes'

describe('gmail scopes', () => {
  it('requests send permission at sign-in', () => {
    expect(DEFAULT_SCOPE_STRING).toContain(GMAIL_SEND_SCOPE)
  })

  it('does not request mailbox read access by default', () => {
    // Reading the user's whole mailbox is opt-in (phase 8 bounce detection),
    // never part of the default consent.
    expect(DEFAULT_SCOPE_STRING).not.toContain(GMAIL_READONLY_SCOPE)
    expect(BASE_SCOPES).not.toContain(GMAIL_READONLY_SCOPE)
  })

  it('detects send capability', () => {
    expect(hasSendScope([...BASE_SCOPES])).toBe(true)
    expect(hasSendScope(['openid', 'email'])).toBe(false)
    expect(hasSendScope([])).toBe(false)
  })
})
