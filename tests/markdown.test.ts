import { describe, expect, it } from 'vitest'
import { blockToMarkdown, sessionToMarkdown } from '@shared/markdown'
import type { ContentBlock, SessionDetail } from '@shared/types'

function detail(
  blocks: ContentBlock[],
  kind: 'response' | 'command-output' = 'response'
): SessionDetail {
  return {
    summary: {
      key: 'source:session',
      sessionId: 'session',
      sourceId: 'source',
      sourceLabel: 'Windows',
      env: 'windows',
      filePath: 'session.jsonl',
      originalPath: 'session.jsonl',
      availability: 'live',
      projectDir: 'project',
      projectName: 'project',
      messageCount: 1,
      userMessageCount: 0,
      assistantMessageCount: 1,
      toolCallCount: 0,
      malformedLines: 0,
      sizeBytes: 0,
      models: [],
      meta: {},
      title: 'Whitespace',
      titleSource: 'name',
      source: 'terminal-windows',
      sourceReason: 'fixture'
    },
    messages: [{ id: 'message', role: 'assistant', kind, blocks }]
  }
}

describe('Markdown source preservation', () => {
  const code = '\n  text = """first\n\n\nlast"""\n  print(text)\n\n'

  it('fences tool payloads without stripping source whitespace', () => {
    const markdown = blockToMarkdown({
      type: 'tool_use',
      id: 'write',
      name: 'Write',
      label: 'Write example.py',
      input: { content: code },
      result: { text: code, isError: false }
    })
    expect(markdown).toContain(`\`\`\`\n${code}\n\`\`\``)
    expect(markdown.match(/text =/g)).toHaveLength(2)
  })

  it('does not overflow the argument stack for many backtick runs', () => {
    const source = '`x'.repeat(200_000) + '\n````\n'
    const markdown = blockToMarkdown({
      type: 'tool_use',
      id: 'write',
      name: 'Write',
      label: 'Write large.txt',
      input: { content: source }
    })
    expect(markdown).toContain(`\`\`\`\`\`\n${source}\n\`\`\`\`\``)
  })

  it('preserves message code and surrounding source whitespace in conversation exports', () => {
    const source = `\n\n\`\`\`python\n${code}\n\`\`\`\n\n  `
    expect(sessionToMarkdown(detail([{ type: 'text', text: source }]))).toContain(source)
  })

  it('preserves command output whitespace inside its generated code fence', () => {
    expect(sessionToMarkdown(detail([{ type: 'text', text: code }], 'command-output'))).toContain(
      `\`\`\`\n${code}\n\`\`\``
    )
  })

  it('can fence an empty tool payload', () => {
    expect(
      blockToMarkdown({
        type: 'tool_use',
        id: 'write',
        name: 'Write',
        label: 'Write empty.txt',
        input: { content: '' }
      })
    ).toContain('```\n\n```')
  })
})
