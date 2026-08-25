import { describe, expect, it } from 'vitest'
import { render, renderSubject, tidy } from '@/core/template/render'

const row = { data: { first_name: 'Ana', company: 'Northwind', city: '' } }

describe('render — substitution', () => {
  it('substitutes a variable', () => {
    expect(render('Hi {{first_name}}', row).text).toBe('Hi Ana')
  })

  it('renders a missing variable as nothing, and reports it', () => {
    const result = render('Hi {{nickname}}!', row)
    expect(result.text).toBe('Hi !')
    // "Hi !" is exactly the embarrassment the review screen has to catch.
    expect(result.unresolved).toEqual(['nickname'])
  })

  it('treats a present-but-blank cell as unresolved', () => {
    expect(render('{{city}}', row).unresolved).toEqual(['city'])
  })

  it('does not report a variable that has a default', () => {
    const result = render('Hi {{nickname | default: there}}', row)
    expect(result.text).toBe('Hi there')
    expect(result.unresolved).toEqual([])
  })
})

describe('render — filters', () => {
  const messy = { data: { name: 'aNA cHEN', blank: '   ' } }

  it('capitalize fixes shouty and lowercase exports', () => {
    expect(render('{{name | capitalize}}', messy).text.trim()).toBe('Ana chen')
  })

  it('title-cases each word', () => {
    expect(render('{{name | title}}', messy).text.trim()).toBe('Ana Chen')
  })

  it('uppers and lowers', () => {
    expect(render('{{name | upper}}', messy).text.trim()).toBe('ANA CHEN')
    expect(render('{{name | lower}}', messy).text.trim()).toBe('ana chen')
  })

  it('applies filters left to right', () => {
    // default first: the fallback then gets capitalized.
    expect(render('{{missing | default: there | capitalize}}', messy).text.trim()).toBe('There')
    // default last: the fallback is used verbatim.
    expect(render('{{missing | capitalize | default: there}}', messy).text.trim()).toBe('there')
  })

  it('treats a whitespace-only cell as empty for default', () => {
    expect(render('{{blank | default: fallback}}', messy).text.trim()).toBe('fallback')
  })
})

describe('render — conditionals', () => {
  it('takes the then branch when the value is present', () => {
    expect(render('Hi{{#if company}} at {{company}}{{/if}}.', row).text.trim()).toBe(
      'Hi at Northwind.',
    )
  })

  it('takes the else branch when it is absent', () => {
    expect(render('{{#if nickname}}A{{else}}B{{/if}}', row).text.trim()).toBe('B')
  })

  it('treats blank, "false" and "0" as absent', () => {
    for (const value of ['', '   ', 'false', 'FALSE', '0']) {
      expect(
        render('{{#if flag}}yes{{else}}no{{/if}}', { data: { flag: value } }).text.trim(),
      ).toBe('no')
    }
  })

  it('treats any other value as present', () => {
    for (const value of ['true', 'yes', '1', 'anything']) {
      expect(
        render('{{#if flag}}yes{{else}}no{{/if}}', { data: { flag: value } }).text.trim(),
      ).toBe('yes')
    }
  })

  it('does not report variables in the branch that was not taken', () => {
    // Otherwise every optional paragraph would flag on every row.
    expect(render('{{#if nickname}}{{nickname}}{{/if}}', row).unresolved).toEqual([])
  })

  it('collapses the gap left by a conditional that renders nothing', () => {
    const template = 'One.\n\n{{#if missing}}Two.{{/if}}\n\nThree.'
    expect(render(template, row).text).toBe('One.\n\nThree.')
  })
})

describe('render — AI slots', () => {
  it('renders an unfilled slot as nothing and reports it', () => {
    const result = render('A {{ai:opening}} B', row)
    expect(result.text.trim()).toBe('A  B')
    expect(result.unfilledSlots).toEqual(['opening'])
  })

  it('renders a filled slot', () => {
    const result = render('A {{ai:opening}} B', { ...row, slots: { opening: 'hello' } })
    expect(result.text.trim()).toBe('A hello B')
    expect(result.unfilledSlots).toEqual([])
  })

  it('treats a blank slot value as unfilled', () => {
    expect(render('{{ai:x}}', { ...row, slots: { x: '  ' } }).unfilledSlots).toEqual(['x'])
  })
})

describe('render — template injection', () => {
  // The security property the whole design leans on: merge values are
  // substituted as literal text and the output is never re-parsed.
  it('does not execute template syntax coming from CSV data', () => {
    const hostile = { data: { company: '{{ai:opening}}' } }
    expect(render('Company: {{company}}', hostile).text.trim()).toBe('Company: {{ai:opening}}')
    expect(render('Company: {{company}}', hostile).unfilledSlots).toEqual([])
  })

  it('does not let a cell open a conditional', () => {
    const hostile = { data: { note: '{{#if secret}}leaked{{/if}}' } }
    expect(render('{{note}}', hostile).text.trim()).toBe('{{#if secret}}leaked{{/if}}')
  })

  it('does not let a cell reference another variable', () => {
    const hostile = { data: { a: '{{b}}', b: 'SECRET' } }
    expect(render('{{a}}', hostile).text.trim()).toBe('{{b}}')
  })
})

describe('renderSubject', () => {
  it('collapses newlines, because a newline in a subject is header injection', () => {
    const hostile = { data: { name: 'Ana\nBcc: evil@example.com' } }
    expect(renderSubject('Hello {{name}}', hostile).text).toBe('Hello Ana Bcc: evil@example.com')
  })

  it('trims and collapses runs of whitespace', () => {
    expect(renderSubject('  Hi   {{first_name}}  ', row).text).toBe('Hi Ana')
  })
})

describe('tidy', () => {
  it('leaves no trailing newline — it would show as a blank line in the email', () => {
    expect(tidy('a\n\n')).toBe('a')
  })

  it('collapses three or more newlines to two', () => {
    expect(tidy('a\n\n\n\nb')).toBe('a\n\nb')
  })

  it('strips trailing whitespace per line', () => {
    expect(tidy('a   \nb\t\n')).toBe('a\nb')
  })

  it('preserves a deliberate single blank line', () => {
    expect(tidy('a\n\nb')).toBe('a\n\nb')
  })
})
