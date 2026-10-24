// Clipboard writes in the phone app. Uses DOM types, so tsconfig.web.json checks
// this file instead of tsconfig.node.json.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { copyWithTextarea, writeClipboard } from '@/lib/clipboard'

describe('clipboard', () => {
  afterEach(() => vi.unstubAllGlobals())

  function fakeDocument(copyResult: boolean) {
    const ta = {
      value: '',
      style: { cssText: '' },
      setAttribute: vi.fn(),
      focus: vi.fn(),
      select: vi.fn(),
      setSelectionRange: vi.fn(),
      remove: vi.fn()
    }
    const doc = {
      createElement: vi.fn(() => ta),
      activeElement: null,
      getSelection: () => null,
      body: { appendChild: vi.fn() },
      execCommand: vi.fn(() => copyResult)
    }
    return { doc: doc as unknown as Document, ta }
  }

  it('falls back to a hidden textarea and cleans up after itself', () => {
    const { doc, ta } = fakeDocument(true)
    expect(copyWithTextarea('hello', doc)).toBe(true)
    expect(ta.value).toBe('hello')
    expect(ta.setSelectionRange).toHaveBeenCalledWith(0, 5)
    expect(doc.execCommand).toHaveBeenCalledWith('copy')
    expect(ta.remove).toHaveBeenCalled()
  })

  it('reports when the browser refuses', () => {
    const { doc, ta } = fakeDocument(false)
    expect(copyWithTextarea('hello', doc)).toBe(false)
    expect(ta.remove).toHaveBeenCalled()
  })

  it('uses navigator.clipboard in a secure context', async () => {
    const writeText = vi.fn(async () => undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    vi.stubGlobal('isSecureContext', true)
    await writeClipboard('abc')
    expect(writeText).toHaveBeenCalledWith('abc')
  })

  it('falls back when navigator.clipboard is missing (plain HTTP)', async () => {
    const { doc } = fakeDocument(true)
    vi.stubGlobal('navigator', {})
    vi.stubGlobal('isSecureContext', false)
    vi.stubGlobal('document', doc)
    await writeClipboard('abc')
    expect(doc.execCommand).toHaveBeenCalledWith('copy')
  })

  it('throws if neither way works', async () => {
    const { doc } = fakeDocument(false)
    vi.stubGlobal('navigator', {})
    vi.stubGlobal('document', doc)
    await expect(writeClipboard('abc')).rejects.toThrow()
  })
})
