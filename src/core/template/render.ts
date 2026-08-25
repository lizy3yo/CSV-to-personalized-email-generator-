import { parse } from './parse'
import type { Filter, Node, RenderContext, RenderResult } from './types'

/**
 * Render a parsed template against one row.
 *
 * The output is plain text. HTML is generated from it afterwards (see
 * `html.ts`) rather than being a second template — one source means the text
 * and HTML parts of a multipart message can never drift apart, which is a
 * classic way for the plain-text alternative to end up stale or empty.
 */

function applyFilter(value: string, filter: Filter): string {
  switch (filter.name) {
    case 'trim':
      return value.trim()
    case 'upper':
      return value.toUpperCase()
    case 'lower':
      return value.toLowerCase()
    case 'capitalize':
      // CSV exports arrive as ANA CHEN or ana chen more often than Ana Chen.
      return value ? value.charAt(0).toUpperCase() + value.slice(1).toLowerCase() : value
    case 'title':
      return value.replace(
        /\S+/g,
        (word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase(),
      )
    case 'default':
      return value.trim() === '' ? (filter.arg ?? '') : value
  }
}

/** Truthiness for `{{#if}}`: present and not blank. */
function isTruthy(value: string | undefined): boolean {
  if (value === undefined) return false
  const trimmed = value.trim()
  return trimmed !== '' && trimmed.toLowerCase() !== 'false' && trimmed !== '0'
}

interface RenderState {
  out: string[]
  unresolved: Set<string>
  unfilledSlots: Set<string>
}

function walk(nodes: Node[], context: RenderContext, state: RenderState): void {
  for (const node of nodes) {
    switch (node.type) {
      case 'text':
        state.out.push(node.value)
        break

      case 'var': {
        const raw = context.data[node.name] ?? ''
        let value = raw
        for (const filter of node.filters) {
          value = applyFilter(value, filter)
        }

        // Only unresolved if nothing came out AND no default was offered.
        if (value.trim() === '' && !node.filters.some((f) => f.name === 'default')) {
          state.unresolved.add(node.name)
        }

        // Substituted as literal text. The result is never re-parsed, so a
        // cell containing {{ai:opening}} renders as those characters.
        state.out.push(value)
        break
      }

      case 'ai': {
        const filled = context.slots?.[node.slot]
        if (filled === undefined || filled.trim() === '') {
          state.unfilledSlots.add(node.slot)
        }
        state.out.push(filled ?? '')
        break
      }

      case 'if':
        walk(isTruthy(context.data[node.name]) ? node.then : node.otherwise, context, state)
        break
    }
  }
}

/**
 * Tidy the output.
 *
 * A conditional that renders nothing leaves the blank lines that surrounded
 * it, so a template with two optional paragraphs can produce an email with a
 * four-line gap in the middle. Collapsing runs of blank lines is what makes
 * conditionals usable in practice.
 */
export function tidy(text: string): string {
  return (
    text
      .split('\n')
      .map((line) => line.replace(/[ \t]+$/, ''))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      // No trailing newline. An email body that ends in blank lines shows them
      // in the plain-text part, where they read as a formatting mistake.
      .trim()
  )
}

export function renderNodes(nodes: Node[], context: RenderContext): RenderResult {
  const state: RenderState = { out: [], unresolved: new Set(), unfilledSlots: new Set() }
  walk(nodes, context, state)
  return {
    text: tidy(state.out.join('')),
    unresolved: [...state.unresolved],
    unfilledSlots: [...state.unfilledSlots],
  }
}

/** Parse and render in one step. Convenient for previews and tests. */
export function render(source: string, context: RenderContext): RenderResult {
  return renderNodes(parse(source).nodes, context)
}

/**
 * Render a subject line.
 *
 * Same engine, but newlines are collapsed to spaces — a newline in a subject
 * header is header injection, and mail servers reject or truncate it.
 */
export function renderSubject(source: string, context: RenderContext): RenderResult {
  const result = renderNodes(parse(source).nodes, context)
  return {
    ...result,
    text: result.text
      .replace(/[\r\n]+/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim(),
  }
}
