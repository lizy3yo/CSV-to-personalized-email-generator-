/**
 * Template language.
 *
 *   {{ first_name }}                        substitute a merge variable
 *   {{ first_name | capitalize }}           apply a filter
 *   {{ first_name | default: there }}       fall back when the cell is empty
 *   {{ first_name | default: there | capitalize }}   filters run left to right
 *   {{#if company}}at {{company}}{{/if}}    conditional block
 *   {{#if company}}…{{else}}…{{/if}}        with an alternative
 *   {{ai:opening}}                          a bounded AI slot (filled in phase 3)
 *
 * Deliberately small. Every construct here earns its place in a merge
 * template; loops, partials and arbitrary expressions do not, and each one
 * would be another way for a template to fail on row 900 of 1,000.
 *
 * SECURITY: merge values are substituted as literal text and the result is
 * never re-parsed. A CSV cell containing `{{ai:opening}}` renders as those
 * characters — it cannot inject a slot, a conditional, or another variable.
 */

export type FilterName = 'capitalize' | 'upper' | 'lower' | 'title' | 'trim' | 'default'

export interface Filter {
  name: FilterName
  /** Only `default` takes one — the literal text after the colon. */
  arg?: string
}

export type Node =
  | { type: 'text'; value: string }
  | { type: 'var'; name: string; filters: Filter[] }
  | { type: 'ai'; slot: string }
  | { type: 'if'; name: string; then: Node[]; otherwise: Node[] }

export interface TemplateError {
  message: string
  /** Character offset into the source, for editor highlighting. */
  index: number
  line: number
  column: number
}

export interface ParseResult {
  nodes: Node[]
  errors: TemplateError[]
  /** Merge variables referenced anywhere, including inside conditionals. */
  variables: string[]
  /** AI slot names referenced, in source order. */
  slots: string[]
}

export interface RenderResult {
  text: string
  /**
   * Variables that resolved to nothing and had no `default`.
   *
   * Not an error — an empty optional field is normal — but the review screen
   * flags them, because `Hi ,` is how a merge template embarrasses you.
   */
  unresolved: string[]
  /** AI slots left unfilled. Expected until phase 3 supplies values. */
  unfilledSlots: string[]
}

export const FILTER_NAMES: readonly FilterName[] = [
  'capitalize',
  'upper',
  'lower',
  'title',
  'trim',
  'default',
]

/** Values available when rendering one row. */
export interface RenderContext {
  /** Merge variables, keyed by variable name. */
  data: Record<string, string>
  /** Resolved AI slot text, keyed by slot name. Empty until phase 3. */
  slots?: Record<string, string>
}
