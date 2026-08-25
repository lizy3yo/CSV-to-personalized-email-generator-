import {
  FILTER_NAMES,
  type Filter,
  type FilterName,
  type Node,
  type ParseResult,
  type TemplateError,
} from './types'

/**
 * Parse a template into an AST.
 *
 * Two passes: scan `{{…}}` tags into a flat token list, then fold the
 * conditional tokens into a tree. Separating them keeps the block-matching
 * logic (which is where the useful error messages live) away from the
 * character scanning.
 *
 * Parsing never throws. A malformed template still returns nodes plus a list
 * of errors, so the editor can render a live preview of the parts that do
 * work while showing what is broken.
 */

/** `}` is not permitted inside a tag, which keeps the scan unambiguous. */
const TAG = /\{\{([^}]*)\}\}/g

type Token =
  | { kind: 'text'; value: string }
  | { kind: 'var'; name: string; filters: Filter[]; index: number }
  | { kind: 'ai'; slot: string; index: number }
  | { kind: 'ifOpen'; name: string; index: number }
  | { kind: 'else'; index: number }
  | { kind: 'ifClose'; index: number }

/** A valid variable or slot name. */
const NAME = /^[a-z_][a-z0-9_]*$/i

function positionOf(source: string, index: number) {
  let line = 1
  let lastBreak = -1
  for (let i = 0; i < index; i++) {
    if (source[i] === '\n') {
      line += 1
      lastBreak = i
    }
  }
  return { line, column: index - lastBreak }
}

function parseFilters(
  raw: string[],
  index: number,
  errors: TemplateError[],
  source: string,
): Filter[] {
  const filters: Filter[] = []

  for (const segment of raw) {
    const colon = segment.indexOf(':')
    const name = (colon === -1 ? segment : segment.slice(0, colon)).trim().toLowerCase()
    // Everything after the colon is the literal argument. No quoting rules to
    // remember, and a fallback like `there` or `your team` just works.
    const arg = colon === -1 ? undefined : segment.slice(colon + 1).trim()

    if (!FILTER_NAMES.includes(name as FilterName)) {
      errors.push({
        message: `Unknown filter "${name}". Available: ${FILTER_NAMES.join(', ')}`,
        index,
        ...positionOf(source, index),
      })
      continue
    }

    if (name === 'default' && arg === undefined) {
      errors.push({
        message: 'default needs a value, for example {{ first_name | default: there }}',
        index,
        ...positionOf(source, index),
      })
      continue
    }

    filters.push({ name: name as FilterName, arg })
  }

  return filters
}

function tokenize(source: string, errors: TemplateError[]): Token[] {
  const tokens: Token[] = []
  let cursor = 0

  TAG.lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = TAG.exec(source)) !== null) {
    if (match.index > cursor) {
      tokens.push({ kind: 'text', value: source.slice(cursor, match.index) })
    }
    cursor = match.index + match[0].length

    const body = match[1].trim()
    const index = match.index

    if (body === '') {
      errors.push({ message: 'Empty tag', index, ...positionOf(source, index) })
      continue
    }

    if (body === 'else') {
      tokens.push({ kind: 'else', index })
      continue
    }

    if (body === '/if') {
      tokens.push({ kind: 'ifClose', index })
      continue
    }

    if (body.startsWith('#if')) {
      const name = body.slice(3).trim()
      if (!NAME.test(name)) {
        errors.push({
          message: name
            ? `"${name}" is not a valid variable name`
            : '#if needs a variable, for example {{#if company}}',
          index,
          ...positionOf(source, index),
        })
        continue
      }
      tokens.push({ kind: 'ifOpen', name, index })
      continue
    }

    if (body.startsWith('#') || body.startsWith('/')) {
      errors.push({
        message: `Unknown block "${body}". Only {{#if …}}, {{else}} and {{/if}} are supported.`,
        index,
        ...positionOf(source, index),
      })
      continue
    }

    if (body.startsWith('ai:')) {
      const slot = body.slice(3).trim()
      if (!NAME.test(slot)) {
        errors.push({
          message: `"${slot}" is not a valid AI slot name`,
          index,
          ...positionOf(source, index),
        })
        continue
      }
      tokens.push({ kind: 'ai', slot, index })
      continue
    }

    const [head, ...rest] = body.split('|')
    const name = head.trim()
    if (!NAME.test(name)) {
      errors.push({
        message: `"${name}" is not a valid variable name`,
        index,
        ...positionOf(source, index),
      })
      continue
    }

    tokens.push({ kind: 'var', name, filters: parseFilters(rest, index, errors, source), index })
  }

  if (cursor < source.length) {
    tokens.push({ kind: 'text', value: source.slice(cursor) })
  }

  // An unclosed `{{` would otherwise vanish silently — the author sees their
  // text disappear from the preview with no explanation.
  const stray = source.lastIndexOf('{{')
  if (stray !== -1 && source.indexOf('}}', stray) === -1) {
    errors.push({
      message: 'Unclosed {{ — every tag needs a matching }}',
      index: stray,
      ...positionOf(source, stray),
    })
  }

  return tokens
}

function build(tokens: Token[], source: string, errors: TemplateError[]): Node[] {
  const root: Node[] = []
  // Each frame holds the open `{{#if}}` and which branch is being filled.
  const stack: {
    node: Extract<Node, { type: 'if' }>
    branch: 'then' | 'otherwise'
    index: number
  }[] = []

  const target = () => {
    const top = stack[stack.length - 1]
    if (!top) return root
    return top.branch === 'then' ? top.node.then : top.node.otherwise
  }

  for (const token of tokens) {
    switch (token.kind) {
      case 'text':
        target().push({ type: 'text', value: token.value })
        break

      case 'var':
        target().push({ type: 'var', name: token.name, filters: token.filters })
        break

      case 'ai':
        target().push({ type: 'ai', slot: token.slot })
        break

      case 'ifOpen': {
        const node: Extract<Node, { type: 'if' }> = {
          type: 'if',
          name: token.name,
          then: [],
          otherwise: [],
        }
        target().push(node)
        stack.push({ node, branch: 'then', index: token.index })
        break
      }

      case 'else': {
        const top = stack[stack.length - 1]
        if (!top) {
          errors.push({
            message: '{{else}} outside of an {{#if}}',
            index: token.index,
            ...positionOf(source, token.index),
          })
          break
        }
        if (top.branch === 'otherwise') {
          errors.push({
            message: 'Two {{else}} in the same {{#if}}',
            index: token.index,
            ...positionOf(source, token.index),
          })
          break
        }
        top.branch = 'otherwise'
        break
      }

      case 'ifClose':
        if (stack.length === 0) {
          errors.push({
            message: '{{/if}} with no matching {{#if}}',
            index: token.index,
            ...positionOf(source, token.index),
          })
          break
        }
        stack.pop()
        break
    }
  }

  for (const unclosed of stack) {
    errors.push({
      message: `{{#if ${unclosed.node.name}}} is never closed — add {{/if}}`,
      index: unclosed.index,
      ...positionOf(source, unclosed.index),
    })
  }

  return root
}

function collect(nodes: Node[], variables: Set<string>, slots: string[]): void {
  for (const node of nodes) {
    switch (node.type) {
      case 'var':
        variables.add(node.name)
        break
      case 'ai':
        if (!slots.includes(node.slot)) slots.push(node.slot)
        break
      case 'if':
        variables.add(node.name)
        collect(node.then, variables, slots)
        collect(node.otherwise, variables, slots)
        break
    }
  }
}

export function parse(source: string): ParseResult {
  const errors: TemplateError[] = []
  const nodes = build(tokenize(source, errors), source, errors)

  const variables = new Set<string>()
  const slots: string[] = []
  collect(nodes, variables, slots)

  return {
    nodes,
    errors: errors.sort((a, b) => a.index - b.index),
    variables: [...variables],
    slots,
  }
}
