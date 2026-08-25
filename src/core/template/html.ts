/**
 * Plain text to HTML.
 *
 * The template is authored as text and the HTML part is derived from it, so a
 * multipart/alternative message always has two halves that say the same thing.
 * Maintaining a second HTML template is how the plain-text alternative ends up
 * stale, empty, or quietly different from what most recipients read.
 *
 * The markup is deliberately plain — paragraphs, line breaks, and links. A 1:1
 * outreach email that arrives wrapped in table layout and a hero image does
 * not look like it was written by a person.
 */

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

/**
 * Escape text for HTML.
 *
 * Applied AFTER merge substitution, so a company name like `Smith & Sons` or a
 * note containing `<3` cannot break the markup or inject a tag.
 */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ESCAPES[char])
}

/** A bare URL or an email address, for auto-linking. */
const AUTOLINK = /(https?:\/\/[^\s<]+[^\s<.,:;"')\]]|[^\s<@]+@[^\s<@]+\.[a-z]{2,})/gi

function linkify(escaped: string): string {
  return escaped.replace(AUTOLINK, (match) => {
    const href = match.includes('@') && !match.startsWith('http') ? `mailto:${match}` : match
    return `<a href="${href}">${match}</a>`
  })
}

export interface HtmlOptions {
  /** Turn bare URLs and addresses into links. Default true. */
  autolink?: boolean
}

/**
 * Convert rendered plain text into a simple HTML body.
 *
 * Blank-line-separated blocks become paragraphs; single newlines inside a
 * block become `<br>`, so a hand-formatted signature keeps its shape.
 */
export function textToHtml(text: string, options: HtmlOptions = {}): string {
  const { autolink = true } = options

  const paragraphs = text
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter((block) => block !== '')

  if (paragraphs.length === 0) return ''

  return paragraphs
    .map((block) => {
      const escaped = escapeHtml(block)
      const linked = autolink ? linkify(escaped) : escaped
      return `<p>${linked.replace(/\n/g, '<br>')}</p>`
    })
    .join('\n')
}

/**
 * Wrap a body fragment in a minimal, mail-client-safe document.
 *
 * Inline styles only: Gmail, Outlook and Apple Mail all strip or ignore
 * `<style>` blocks to varying degrees, so anything that must survive has to be
 * on the element.
 */
export function wrapHtmlDocument(bodyHtml: string): string {
  return [
    '<!doctype html>',
    '<html><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '</head>',
    '<body style="margin:0;padding:0;background:#ffffff;">',
    '<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;' +
      'font-size:15px;line-height:1.5;color:#1a1a1a;max-width:600px;padding:16px;">',
    bodyHtml,
    '</div></body></html>',
  ].join('\n')
}
