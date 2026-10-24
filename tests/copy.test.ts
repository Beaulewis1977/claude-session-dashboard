import { describe, expect, it } from 'vitest'
import type { ContentBlock } from '@shared/types'
import { buildMessages, parseJsonl } from '@shared/jsonl'
import {
  blocksToMarkdown,
  blocksToPlainText,
  markdownToPlainText,
  toolInputText,
  toolOutputText
} from '@/lib/copy'
import { SESSIONS, read } from './helpers'

const MD = [
  '## Fix the login loop',
  '',
  'The **cookie** had `SameSite=None` but no [Secure flag](https://example.com/secure).',
  '',
  '- one',
  '- two with _emphasis_',
  '',
  '1. first',
  '2. second',
  '',
  '> quoted line',
  '',
  '```ts',
  'const a = 1 // keep **this** as-is',
  'console.log(`x`)',
  '```'
].join('\n')

describe('markdownToPlainText', () => {
  const plain = markdownToPlainText(MD)

  it('drops Markdown syntax but keeps the words', () => {
    expect(plain).toContain('Fix the login loop')
    expect(plain).not.toContain('##')
    expect(plain).not.toContain('**cookie**')
    expect(plain).toContain(
      'The cookie had SameSite=None but no Secure flag (https://example.com/secure).'
    )
    expect(plain).toContain('quoted line')
    expect(plain).not.toMatch(/^>/m)
  })

  it('keeps list markers so lists still read as lists', () => {
    expect(plain).toContain('- one\n- two with emphasis')
    expect(plain).toContain('1. first\n2. second')
  })

  it('keeps code exactly, without the fences', () => {
    expect(plain).toContain('const a = 1 // keep **this** as-is\nconsole.log(`x`)')
    expect(plain).not.toContain('```')
  })

  it('leaves snake_case and single newlines in plain text alone', () => {
    expect(markdownToPlainText('call my_func_name now')).toBe('call my_func_name now')
    expect(markdownToPlainText('line one\nline two')).toBe('line one\nline two')
  })

  it('handles GFM tables, task lists and bare links', () => {
    expect(markdownToPlainText('| a | b |\n|---|---|\n| 1 | 2 |')).toBe('a\tb\n1\t2')
    expect(markdownToPlainText('- [x] done\n- [ ] todo')).toBe('- [x] done\n- [ ] todo')
    expect(markdownToPlainText('see https://example.com')).toBe('see https://example.com')
  })

  it('preserves code indentation, blank lines and multiline string contents', () => {
    const code = '\n  message = """first\n\n\nlast"""\n  print(message)\n\n'
    expect(markdownToPlainText(`\`\`\`python\n${code}\n\`\`\``)).toBe(code)
  })

  it('preserves code indentation when a list starts with a code block', () => {
    expect(markdownToPlainText('- ```python\n    print("indented")\n  ```')).toBe(
      '-   print("indented")'
    )
  })

  it.each([
    ['[read][guide]\n\n[guide]: https://example.com/docs', 'read (https://example.com/docs)'],
    ['[read][]\n\n[read]: https://example.com/docs', 'read (https://example.com/docs)'],
    ['[read]\n\n[read]: https://example.com/docs', 'read (https://example.com/docs)'],
    ['[**read**][GUIDE]\n\n[guide]: https://example.com/docs', 'read (https://example.com/docs)'],
    ['[email][contact]\n\n[contact]: mailto:a@example.com', 'email'],
    ['[missing][guide]', '[missing][guide]']
  ])('resolves reference links like inline links: %s', (markdown, expected) => {
    expect(markdownToPlainText(markdown)).toBe(expected)
  })

  it.each([
    ['![diagram](https://example.com/diagram.png)', 'diagram (https://example.com/diagram.png)'],
    ['![](https://example.com/diagram.png)', 'https://example.com/diagram.png'],
    [
      '![diagram][fig]\n\n[fig]: https://example.com/diagram.png',
      'diagram (https://example.com/diagram.png)'
    ],
    [
      '![diagram][]\n\n[diagram]: https://example.com/diagram.png',
      'diagram (https://example.com/diagram.png)'
    ],
    [
      '![diagram]\n\n[diagram]: https://example.com/diagram.png',
      'diagram (https://example.com/diagram.png)'
    ],
    ['![][fig]\n\n[fig]: https://example.com/diagram.png', 'https://example.com/diagram.png'],
    ['![missing][fig]', '![missing][fig]']
  ])('includes image alt text and available URLs: %s', (markdown, expected) => {
    expect(markdownToPlainText(markdown)).toBe(expected)
  })

  it('uses the first definition and omits definition text from the copied result', () => {
    expect(
      markdownToPlainText('[read][some  guide]\n\n[Some Guide]: /first\n[some guide]: /second')
    ).toBe('read (/first)')
  })

  it('returns empty text for empty content', () => {
    expect(markdownToPlainText('')).toBe('')
    expect(markdownToPlainText('```\n```')).toBe('')
  })
})

describe('copying a message', () => {
  const text: ContentBlock = { type: 'text', text: MD }

  it('Markdown is the original text, fences and all', () => {
    expect(blocksToMarkdown([text])).toBe(MD)
  })

  it('plain text differs from Markdown only in the syntax', () => {
    expect(blocksToPlainText([text])).toBe(markdownToPlainText(MD))
  })

  it('joins several blocks and skips redacted thinking', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', text: 'First **part**' },
      { type: 'thinking', text: 'secret', redacted: true },
      { type: 'text', text: 'Second part' }
    ]
    expect(blocksToPlainText(blocks)).toBe('First part\n\nSecond part')
    expect(blocksToMarkdown(blocks)).toContain('First **part**')
  })

  it('works on a real session', () => {
    const messages = buildMessages(parseJsonl(read(SESSIONS.safari)).events)
    const user = messages.find((m) => m.role === 'user' && m.kind === 'prompt')!
    const first = user.blocks.find((b) => b.type === 'text')
    expect(first).toBeDefined()
    expect(blocksToPlainText(user.blocks).length).toBeGreaterThan(0)
    expect(blocksToMarkdown(user.blocks)).toContain((first as { text: string }).text.trim())
  })

  it('preserves original Markdown whitespace within and around blocks', () => {
    const source = '\n\n  ```python\n  text = """first\n\n\nlast"""\n  ```\n\n'
    expect(blocksToMarkdown([{ type: 'text', text: source }])).toBe(source)
    expect(
      blocksToMarkdown([
        { type: 'text', text: source },
        { type: 'text', text: 'next' }
      ])
    ).toBe(`${source}\n\nnext`)
  })

  it('preserves tool output whitespace when copying a message as plain text', () => {
    const output = '\n  first\n\n\nlast\n\n'
    expect(
      blocksToPlainText([
        { type: 'tool_result', toolUseId: 'result', result: { text: output, isError: false } }
      ])
    ).toBe(output)
  })

  it('returns empty text for an empty message', () => {
    expect(blocksToMarkdown([])).toBe('')
    expect(blocksToPlainText([])).toBe('')
  })
})

describe('copying a tool call', () => {
  const bash: Extract<ContentBlock, { type: 'tool_use' }> = {
    type: 'tool_use',
    id: 't1',
    name: 'Bash',
    label: 'Bash: npm test',
    input: { command: 'npm test -- --run', description: 'Run tests' },
    result: { text: 'x'.repeat(10_000), isError: false }
  }

  it('copies the command for Bash and JSON for other tools', () => {
    expect(toolInputText(bash)).toBe('npm test -- --run')
    const edit = {
      ...bash,
      name: 'Edit',
      input: { file_path: 'a.ts', old_string: 'a', new_string: 'b' }
    }
    expect(JSON.parse(toolInputText(edit))).toEqual(edit.input)
    const write = { ...bash, name: 'Write', input: { file_path: 'a.ts', content: 'hello\n' } }
    expect(toolInputText(write)).toBe('hello\n')
  })

  it('copies the full output, not the truncated preview', () => {
    expect(toolOutputText(bash.result!)).toHaveLength(10_000)
  })

  it('fences tool input in Markdown and leaves it bare in plain text', () => {
    expect(blocksToMarkdown([bash])).toContain('```bash\nnpm test -- --run\n```')
    const plain = blocksToPlainText([bash])
    expect(plain.startsWith('Bash: npm test\n\nnpm test -- --run')).toBe(true)
    expect(plain).not.toContain('```')
  })
})
