import { describe, expect, it } from 'vitest'
import { parse } from '@/core/template/parse'

describe('parse — variables', () => {
  it('reads a bare variable', () => {
    const { nodes, variables, errors } = parse('Hi {{first_name}}')
    expect(errors).toEqual([])
    expect(variables).toEqual(['first_name'])
    expect(nodes).toEqual([
      { type: 'text', value: 'Hi ' },
      { type: 'var', name: 'first_name', filters: [] },
    ])
  })

  it('tolerates whitespace inside the tag', () => {
    expect(parse('{{  first_name  }}').variables).toEqual(['first_name'])
  })

  it('reads filters left to right', () => {
    const [node] = parse('{{ name | default: there | capitalize }}').nodes
    expect(node).toEqual({
      type: 'var',
      name: 'name',
      filters: [
        { name: 'default', arg: 'there' },
        { name: 'capitalize', arg: undefined },
      ],
    })
  })

  it('keeps multi-word default arguments intact', () => {
    const [node] = parse('{{ company | default: your team }}').nodes
    expect(node).toMatchObject({ filters: [{ name: 'default', arg: 'your team' }] })
  })

  it('rejects an unknown filter but keeps parsing', () => {
    const { errors, variables } = parse('{{ name | shout }}')
    expect(errors[0].message).toContain('Unknown filter "shout"')
    expect(variables).toEqual(['name'])
  })

  it('requires an argument for default', () => {
    expect(parse('{{ name | default }}').errors[0].message).toContain('default needs a value')
  })

  it('rejects an invalid variable name', () => {
    expect(parse('{{ 2bad }}').errors[0].message).toContain('not a valid variable name')
  })

  it('reports an empty tag', () => {
    expect(parse('a {{}} b').errors[0].message).toBe('Empty tag')
  })
})

describe('parse — conditionals', () => {
  it('builds an if block', () => {
    const { nodes, errors } = parse('{{#if company}}at {{company}}{{/if}}')
    expect(errors).toEqual([])
    expect(nodes).toEqual([
      {
        type: 'if',
        name: 'company',
        then: [
          { type: 'text', value: 'at ' },
          { type: 'var', name: 'company', filters: [] },
        ],
        otherwise: [],
      },
    ])
  })

  it('builds an if/else block', () => {
    const [node] = parse('{{#if c}}yes{{else}}no{{/if}}').nodes
    expect(node).toMatchObject({
      type: 'if',
      then: [{ type: 'text', value: 'yes' }],
      otherwise: [{ type: 'text', value: 'no' }],
    })
  })

  it('nests', () => {
    const { errors, nodes } = parse('{{#if a}}{{#if b}}deep{{/if}}{{/if}}')
    expect(errors).toEqual([])
    expect(nodes[0]).toMatchObject({ type: 'if', name: 'a' })
    expect((nodes[0] as { then: unknown[] }).then[0]).toMatchObject({ type: 'if', name: 'b' })
  })

  it('collects variables used only inside a conditional', () => {
    expect(parse('{{#if company}}{{company}}{{/if}}').variables).toEqual(['company'])
  })

  it('reports an unclosed if, naming it', () => {
    expect(parse('{{#if company}}hello').errors[0].message).toBe(
      '{{#if company}} is never closed — add {{/if}}',
    )
  })

  it('reports a stray close', () => {
    expect(parse('hello{{/if}}').errors[0].message).toBe('{{/if}} with no matching {{#if}}')
  })

  it('reports a stray else', () => {
    expect(parse('a{{else}}b').errors[0].message).toBe('{{else}} outside of an {{#if}}')
  })

  it('reports two else branches', () => {
    expect(parse('{{#if a}}1{{else}}2{{else}}3{{/if}}').errors[0].message).toBe(
      'Two {{else}} in the same {{#if}}',
    )
  })

  it('rejects an unknown block type', () => {
    expect(parse('{{#each rows}}{{/each}}').errors[0].message).toContain('Unknown block')
  })
})

describe('parse — AI slots', () => {
  it('reads a slot', () => {
    const { nodes, slots } = parse('Hi.\n\n{{ai:opening}}\n\nBye.')
    expect(slots).toEqual(['opening'])
    expect(nodes).toContainEqual({ type: 'ai', slot: 'opening' })
  })

  it('lists each slot once, in source order', () => {
    expect(parse('{{ai:b}} {{ai:a}} {{ai:b}}').slots).toEqual(['b', 'a'])
  })

  it('does not treat a slot as a merge variable', () => {
    expect(parse('{{ai:opening}}').variables).toEqual([])
  })
})

describe('parse — malformed input', () => {
  it('reports an unclosed tag rather than silently dropping the text', () => {
    const { errors } = parse('Hi {{first_name')
    expect(errors.some((e) => e.message.includes('Unclosed {{'))).toBe(true)
  })

  it('gives line and column for editor highlighting', () => {
    const { errors } = parse('line one\nline two {{ 1bad }}')
    expect(errors[0].line).toBe(2)
    expect(errors[0].column).toBeGreaterThan(1)
  })

  it('never throws, whatever it is given', () => {
    for (const bad of ['{{', '}}', '{{{{', '{{#if}}', '{{/if}}{{/if}}', '{{ | | }}', '']) {
      expect(() => parse(bad)).not.toThrow()
    }
  })

  it('reports errors in source order', () => {
    const { errors } = parse('{{ 1bad }} then {{ 2bad }}')
    expect(errors).toHaveLength(2)
    expect(errors[0].index).toBeLessThan(errors[1].index)
  })
})
