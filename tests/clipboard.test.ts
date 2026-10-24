// Clipboard writes and viewer actions use DOM types, so tsconfig.web.json checks this file.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sessionToMarkdown } from '@shared/markdown'
import type { SessionDetail, SessionSummary } from '@shared/types'
import { copyConversation, copyText } from '@/lib/actions'
import { copyWithTextarea, writeClipboard } from '@/lib/clipboard'

const { copyToClipboard, showToast, showError } = vi.hoisted(() => ({
  copyToClipboard: vi.fn(),
  showToast: vi.fn(),
  showError: vi.fn()
}))

vi.mock('@/lib/api', () => ({ api: { copyText: copyToClipboard } }))
vi.mock('sonner', () => ({ toast: Object.assign(showToast, { error: showError }) }))

function fakeDocument({
  copyResult = true,
  copyEvent = true,
  deliveredText,
  scope = null as null | { appendChild: ReturnType<typeof vi.fn> }
}: {
  copyResult?: boolean
  copyEvent?: boolean
  deliveredText?: string
  scope?: null | { appendChild: ReturnType<typeof vi.fn> }
} = {}) {
  const state = { clipboard: 'previous clipboard', parent: null as unknown }
  const listeners = new Set<(event: ClipboardEvent) => void>()
  const ta = {
    value: '',
    style: { cssText: '' },
    setAttribute: vi.fn(),
    focus: vi.fn(() => {
      // Model a focus trap rejecting focus moved outside its scope.
      if (!scope || state.parent === scope) doc.activeElement = ta
    }),
    select: vi.fn(),
    setSelectionRange: vi.fn(),
    remove: vi.fn()
  }
  const doc = {
    createElement: vi.fn(() => ta),
    activeElement: null as unknown,
    getSelection: () => null as Selection | null,
    body: { appendChild: vi.fn(() => (state.parent = doc.body)) },
    addEventListener: vi.fn((_type: string, listener: (event: ClipboardEvent) => void) =>
      listeners.add(listener)
    ),
    removeEventListener: vi.fn((_type: string, listener: (event: ClipboardEvent) => void) =>
      listeners.delete(listener)
    ),
    execCommand: vi.fn(() => {
      if (copyResult && copyEvent && doc.activeElement === ta) {
        const data = new Map<string, string>()
        let prevented = false
        const event = {
          get defaultPrevented() {
            return prevented
          },
          clipboardData: {
            setData: (type: string, value: string) => data.set(type, deliveredText ?? value),
            getData: (type: string) => data.get(type) ?? ''
          },
          preventDefault: () => (prevented = true)
        }
        for (const listener of listeners) listener(event as unknown as ClipboardEvent)
        if (prevented) state.clipboard = data.get('text/plain') ?? ''
      }
      return copyResult
    })
  }
  if (scope) scope.appendChild.mockImplementation(() => (state.parent = scope))
  return { doc: doc as unknown as Document, ta, state, listeners }
}

describe('clipboard', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('explicitly delivers the requested text during copy and cleans up', () => {
    const { doc, ta, state, listeners } = fakeDocument()
    expect(copyWithTextarea('hello\n  indented', doc)).toBe(true)
    expect(state.clipboard).toBe('hello\n  indented')
    expect(ta.setSelectionRange).toHaveBeenCalledWith(0, 16)
    expect(ta.remove).toHaveBeenCalled()
    expect(listeners.size).toBe(0)
  })

  it('rejects execCommand true without a copy event delivering text', () => {
    const { doc, state } = fakeDocument({ copyEvent: false })
    expect(copyWithTextarea('hello', doc)).toBe(false)
    expect(state.clipboard).toBe('previous clipboard')
  })

  it('rejects a clipboard data mismatch instead of reporting success', () => {
    const { doc } = fakeDocument({ deliveredText: 'other selected text' })
    expect(copyWithTextarea('hello', doc)).toBe(false)
  })

  it.each(['menu', 'dialog', 'alertdialog'])('copies inside an active %s focus trap', (role) => {
    const scope = { appendChild: vi.fn() }
    const { doc, state } = fakeDocument({ scope })
    Object.defineProperty(doc, 'activeElement', {
      value: {
        closest: (selector: string) => (selector.includes(`[role="${role}"]`) ? scope : null),
        focus: vi.fn()
      },
      writable: true
    })
    expect(copyWithTextarea('inside the focus trap', doc)).toBe(true)
    expect(state.clipboard).toBe('inside the focus trap')
    expect(state.parent).toBe(scope)
  })

  it('restores focus before restoring the previous DOM selection', () => {
    const { doc } = fakeDocument()
    const range = { cloneRange: () => range } as unknown as Range
    const ranges = [range]
    const selection = {
      rangeCount: 1,
      getRangeAt: () => range,
      removeAllRanges: () => ranges.splice(0),
      addRange: (r: Range) => ranges.push(r)
    }
    const active = { closest: () => null, focus: vi.fn(() => ranges.splice(0)) }
    Object.defineProperty(doc, 'activeElement', { value: active, writable: true })
    doc.getSelection = () => selection as unknown as Selection

    expect(copyWithTextarea('hello', doc)).toBe(true)
    expect(active.focus).toHaveBeenCalledWith({ preventScroll: true })
    expect(ranges).toEqual([range])
  })

  it('restores an input selection and scroll after document ranges are restored', () => {
    const { doc, ta } = fakeDocument()
    const active = {
      closest: () => null,
      selectionStart: 2,
      selectionEnd: 8,
      selectionDirection: 'backward',
      scrollLeft: 70,
      scrollTop: 12,
      focus: vi.fn(),
      setSelectionRange: vi.fn((start: number, end: number, direction: string) => {
        active.selectionStart = start
        active.selectionEnd = end
        active.selectionDirection = direction
        active.scrollLeft = 0
        active.scrollTop = 0
      })
    }
    Object.defineProperty(doc, 'activeElement', { value: active, writable: true })
    const range = { cloneRange: () => range } as unknown as Range
    doc.getSelection = () =>
      ({
        rangeCount: 1,
        getRangeAt: () => range,
        removeAllRanges: vi.fn(),
        // Chromium exposes a BODY range while an input is focused; restoring
        // that DOM range resets the control's own selection.
        addRange: () => {
          active.selectionStart = 0
          active.selectionEnd = 0
          active.selectionDirection = 'forward'
        }
      }) as unknown as Selection
    ta.focus.mockImplementation(() => {
      Object.defineProperty(doc, 'activeElement', { value: ta, writable: true })
      active.selectionStart = 0
      active.selectionEnd = 0
      active.selectionDirection = 'none'
    })

    expect(copyWithTextarea('hello', doc)).toBe(true)
    expect({
      start: active.selectionStart,
      end: active.selectionEnd,
      direction: active.selectionDirection,
      scrollLeft: active.scrollLeft,
      scrollTop: active.scrollTop
    }).toEqual({ start: 2, end: 8, direction: 'backward', scrollLeft: 70, scrollTop: 12 })
  })

  it('reports when the browser refuses and removes the temporary textarea', () => {
    const { doc, ta, listeners } = fakeDocument({ copyResult: false })
    expect(copyWithTextarea('hello', doc)).toBe(false)
    expect(ta.remove).toHaveBeenCalled()
    expect(listeners.size).toBe(0)
  })

  it('uses navigator.clipboard in a secure context without clipboard reads', async () => {
    const writeText = vi.fn(async () => undefined)
    const readText = vi.fn()
    const query = vi.fn()
    vi.stubGlobal('navigator', { clipboard: { writeText, readText }, permissions: { query } })
    vi.stubGlobal('isSecureContext', true)
    await writeClipboard('abc')
    expect(writeText).toHaveBeenCalledWith('abc')
    expect(readText).not.toHaveBeenCalled()
    expect(query).not.toHaveBeenCalled()
  })

  it('falls back when navigator.clipboard is missing (plain HTTP)', async () => {
    const { doc, state } = fakeDocument()
    vi.stubGlobal('navigator', {})
    vi.stubGlobal('isSecureContext', false)
    vi.stubGlobal('document', doc)
    await writeClipboard('abc')
    expect(state.clipboard).toBe('abc')
  })

  it('falls back when the native Clipboard API rejects', async () => {
    const { doc, state } = fakeDocument()
    vi.stubGlobal('navigator', {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error('Permission denied')) }
    })
    vi.stubGlobal('isSecureContext', true)
    vi.stubGlobal('document', doc)
    await writeClipboard('after rejection')
    expect(state.clipboard).toBe('after rejection')
  })

  it('throws if the native API rejects and fallback does not deliver text', async () => {
    const { doc } = fakeDocument({ copyEvent: false })
    vi.stubGlobal('navigator', {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error('Permission denied')) }
    })
    vi.stubGlobal('document', doc)
    await expect(writeClipboard('abc')).rejects.toThrow()
  })
})

describe('viewer copy actions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    copyToClipboard.mockResolvedValue(undefined)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('shows manual selection guidance and no success when both clipboard paths fail', async () => {
    const { doc } = fakeDocument({ copyEvent: false })
    vi.stubGlobal('navigator', {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error('Permission denied')) }
    })
    vi.stubGlobal('document', doc)
    copyToClipboard.mockImplementation(writeClipboard)

    await expect(copyText('copy this')).resolves.toBe(false)
    expect(showError).toHaveBeenCalledWith(
      "Couldn't copy, select the text manually",
      expect.any(Object)
    )
    expect(showToast).not.toHaveBeenCalled()
  })

  it('copies the complete Export Markdown with the current session metadata', async () => {
    const summary: SessionSummary = {
      key: 'windows:session-1',
      sessionId: 'session-1',
      sourceId: 'windows',
      sourceLabel: 'Windows',
      env: 'windows',
      filePath: 'C:/sessions/session-1.jsonl',
      originalPath: 'C:/sessions/session-1.jsonl',
      availability: 'live',
      projectDir: 'example',
      projectName: 'example',
      cwd: 'C:/example',
      gitBranch: 'main',
      messageCount: 2,
      userMessageCount: 1,
      assistantMessageCount: 1,
      toolCallCount: 1,
      malformedLines: 0,
      sizeBytes: 200,
      models: [],
      meta: { description: 'Current description', tags: ['copy', 'export'] },
      title: 'Current title',
      titleSource: 'name',
      source: 'terminal-windows',
      sourceReason: 'fixture'
    }
    const detail: SessionDetail = {
      summary: { ...summary, title: 'Stale title', meta: { description: 'Stale description' } },
      messages: [
        {
          id: 'user-1',
          role: 'user',
          kind: 'prompt',
          blocks: [
            { type: 'text', text: 'Keep [the reference][doc].\n\n[doc]: https://example.test' }
          ]
        },
        {
          id: 'assistant-1',
          role: 'assistant',
          kind: 'response',
          blocks: [
            { type: 'text', text: '```ts\n  const answer = 42\n```' },
            { type: 'thinking', text: 'Check the whitespace.' },
            {
              type: 'tool_use',
              id: 'tool-1',
              name: 'Bash',
              input: { command: 'printf "done"' },
              label: 'Bash: printf',
              result: { text: 'done', isError: false }
            }
          ]
        }
      ]
    }
    const expected = [
      '# Current title',
      '',
      '> Current description',
      '',
      '- **Session:** `session-1`',
      '- **Environment:** Windows',
      '- **Project:** `C:/example`',
      '- **Branch:** `main`',
      '- **Started:** —',
      '- **Last activity:** —',
      '- **Messages:** 2',
      '- **Tags:** copy, export',
      '',
      '---',
      '',
      '## 🧑 You',
      '',
      'Keep [the reference][doc].',
      '',
      '[doc]: https://example.test',
      '',
      '## 🤖 Claude',
      '',
      '```ts',
      '  const answer = 42',
      '```',
      '',
      '<details>',
      '<summary>Thinking</summary>',
      '',
      'Check the whitespace.',
      '',
      '</details>',
      '',
      '<details>',
      '<summary>🔧 Bash: printf</summary>',
      '',
      '```bash',
      'printf "done"',
      '```',
      '',
      '```',
      'done',
      '```',
      '',
      '</details>',
      ''
    ].join('\n')
    expect(sessionToMarkdown({ ...detail, summary })).toBe(expected)

    copyConversation(detail, summary)
    await vi.waitFor(() =>
      expect(showToast).toHaveBeenCalledWith('Conversation copied ✓', {
        duration: 1500
      })
    )
    expect(copyToClipboard).toHaveBeenCalledExactlyOnceWith(expected)
    expect(showError).not.toHaveBeenCalled()
  })
})
