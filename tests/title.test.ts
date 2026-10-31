import { describe, expect, it } from 'vitest'
import { computeTitle, truncate } from '@shared/title'

describe('computeTitle', () => {
  it('prefers my name', () => {
    expect(computeTitle({ name: '  My name ' }, undefined, 'Summary', 'Prompt')).toEqual({
      title: 'My name',
      titleSource: 'name'
    })
  })
  it('falls back to the summary when the name is blank', () => {
    expect(computeTitle({ name: '   ' }, undefined, 'Claude summary', 'Prompt')).toEqual({
      title: 'Claude summary',
      titleSource: 'summary'
    })
  })
  it('falls back to the first prompt, cut short', () => {
    const prompt =
      'I want to migrate our date handling from moment.js to date-fns across the whole app. There are about 40 files.'
    const r = computeTitle(undefined, undefined, undefined, prompt)
    expect(r.titleSource).toBe('first-prompt')
    expect(r.title.length).toBeLessThanOrEqual(80)
    expect(r.title.endsWith('…')).toBe(true)
    expect(prompt.startsWith(r.title.slice(0, -1))).toBe(true)
  })
  it('uses a placeholder when nothing is known', () => {
    expect(computeTitle({}, undefined, '', '')).toEqual({
      title: 'Untitled session',
      titleSource: 'fallback'
    })
  })
})

describe('truncate', () => {
  it('collapses whitespace and leaves short text alone', () => {
    expect(truncate('a\n\n  b')).toBe('a b')
  })
  it('cuts long words hard when there is no good boundary', () => {
    const r = truncate('x'.repeat(200), 10)
    expect(r).toBe('xxxxxxxxx…')
  })
})
