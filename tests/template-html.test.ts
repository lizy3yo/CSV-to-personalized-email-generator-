import { describe, expect, it } from 'vitest'
import { escapeHtml, textToHtml, wrapHtmlDocument } from '@/core/template/html'
import { render } from '@/core/template/render'

describe('escapeHtml', () => {
  it('escapes the five characters that matter', () => {
    expect(escapeHtml(`<a href="x">&'`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;')
  })

  it('handles ampersands in ordinary company names', () => {
    expect(escapeHtml('Smith & Sons')).toBe('Smith &amp; Sons')
  })
})

describe('textToHtml', () => {
  it('makes blank-line-separated blocks into paragraphs', () => {
    expect(textToHtml('One.\n\nTwo.')).toBe('<p>One.</p>\n<p>Two.</p>')
  })

  it('turns single newlines into line breaks, so a signature keeps its shape', () => {
    expect(textToHtml('Sam Reyes\nAcme')).toBe('<p>Sam Reyes<br>Acme</p>')
  })

  it('escapes before linkifying, so markup in data cannot survive', () => {
    // The order matters: escape first, then linkify the escaped text.
    expect(textToHtml('<script>alert(1)</script>')).toBe(
      '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>',
    )
  })

  it('autolinks a bare URL', () => {
    expect(textToHtml('See https://example.com now')).toBe(
      '<p>See <a href="https://example.com">https://example.com</a> now</p>',
    )
  })

  it('does not swallow trailing punctuation into the link', () => {
    expect(textToHtml('Visit https://example.com.')).toContain(
      '<a href="https://example.com">https://example.com</a>.',
    )
  })

  it('autolinks an email address as mailto', () => {
    expect(textToHtml('Reply to sam@acme.com')).toContain('<a href="mailto:sam@acme.com">')
  })

  it('can be told not to autolink', () => {
    expect(textToHtml('https://example.com', { autolink: false })).toBe(
      '<p>https://example.com</p>',
    )
  })

  it('returns nothing for empty input', () => {
    expect(textToHtml('')).toBe('')
    expect(textToHtml('\n\n  \n')).toBe('')
  })
})

describe('text and HTML stay in step', () => {
  // One source for both halves of a multipart message, so the plain-text
  // alternative can never drift from the HTML.
  const template = 'Hi {{first_name}},\n\nWe work with {{company}} & others.\n\n— Sam'
  const context = { data: { first_name: 'Ana', company: 'Smith & Sons' } }

  it('derives the HTML from the same rendered text', () => {
    const { text } = render(template, context)
    const html = textToHtml(text)

    expect(text).toContain('Smith & Sons')
    expect(html).toContain('Smith &amp; Sons')
    expect(html).toContain('<p>Hi Ana,</p>')
  })

  it('escapes merge values that arrive containing markup', () => {
    const { text } = render('Company: {{company}}', {
      data: { company: '<b>Acme</b>' },
    })
    expect(text).toContain('<b>Acme</b>')
    expect(textToHtml(text)).toBe('<p>Company: &lt;b&gt;Acme&lt;/b&gt;</p>')
  })
})

describe('wrapHtmlDocument', () => {
  it('produces a document with a charset and inline styles only', () => {
    const doc = wrapHtmlDocument('<p>Hi</p>')
    expect(doc).toContain('<!doctype html>')
    expect(doc).toContain('charset="utf-8"')
    expect(doc).toContain('<p>Hi</p>')
    // Mail clients strip <style> blocks to varying degrees; anything that has
    // to survive must be on the element.
    expect(doc).not.toContain('<style')
  })
})
