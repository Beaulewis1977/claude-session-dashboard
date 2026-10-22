// Export a session as a readable Markdown document.

import { formatDateTime } from './format'
import type { ContentBlock, SessionDetail, ToolResult } from './types'

function fence(text: string, lang = ''): string {
  // Use a fence longer than any backtick run inside the text.
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((m) => m.length))
  const f = '`'.repeat(longest + 1)
  return `${f}${lang}\n${text.replace(/\n+$/, '')}\n${f}`
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function toolInput(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>
  if ((name === 'Bash' || name === 'PowerShell') && typeof i.command === 'string')
    return fence(i.command, 'bash')
  if (name === 'Edit' && typeof i.old_string === 'string' && typeof i.new_string === 'string') {
    const diff = [
      ...i.old_string.split('\n').map((l) => `- ${l}`),
      ...i.new_string.split('\n').map((l) => `+ ${l}`)
    ].join('\n')
    return fence(diff, 'diff')
  }
  if (name === 'Write' && typeof i.content === 'string') return fence(i.content)
  return fence(JSON.stringify(input, null, 2), 'json')
}

function toolResult(r: ToolResult): string {
  const head = r.isError ? '**Error:**\n\n' : ''
  return head + (r.text ? fence(r.text) : '_(no output)_')
}

function block(b: ContentBlock): string {
  switch (b.type) {
    case 'text':
      return b.text
    case 'thinking':
      return b.redacted
        ? '> _Thinking (redacted)_'
        : `<details>\n<summary>Thinking</summary>\n\n${b.text}\n\n</details>`
    case 'tool_use':
      return [
        `<details>\n<summary>🔧 ${escapeHtml(b.label)}</summary>\n`,
        toolInput(b.name, b.input),
        b.result ? `\n${toolResult(b.result)}` : '',
        '\n</details>'
      ].join('\n')
    case 'tool_result':
      return `<details>\n<summary>Tool result</summary>\n\n${toolResult(b.result)}\n\n</details>`
    case 'image':
      return '_[image]_'
  }
}

export function sessionToMarkdown(detail: SessionDetail): string {
  const s = detail.summary
  const lines: string[] = [`# ${s.title}`, '']
  if (s.meta.description)
    lines.push(
      s.meta.description
        .split('\n')
        .map((l) => `> ${l}`)
        .join('\n'),
      ''
    )
  const facts: [string, string | undefined][] = [
    ['Session', `\`${s.sessionId}\``],
    ['Environment', s.env === 'wsl' ? `WSL: ${s.distro}` : 'Windows'],
    ['Project', s.cwd ? `\`${s.cwd}\`` : undefined],
    ['Branch', s.gitBranch ? `\`${s.gitBranch}\`` : undefined],
    ['Started', formatDateTime(s.startedAt)],
    ['Last activity', formatDateTime(s.lastActivityAt)],
    ['Messages', String(s.messageCount)],
    ['Tags', s.meta.tags?.length ? s.meta.tags.join(', ') : undefined]
  ]
  for (const [k, v] of facts) if (v) lines.push(`- **${k}:** ${v}`)
  lines.push('', '---', '')

  for (const m of detail.messages) {
    const when = m.timestamp ? ` · ${formatDateTime(m.timestamp)}` : ''
    if (m.role === 'system' || m.kind === 'compact') {
      lines.push(
        `_${m.kind === 'compact' ? 'Conversation compacted' : m.blocks.map(block).join(' ')}${when}_`,
        ''
      )
      continue
    }
    if (m.kind === 'command') {
      lines.push(`**You** ran \`${m.blocks.map(block).join(' ')}\`${when}`, '')
      continue
    }
    const who = m.role === 'user' ? '## 🧑 You' : '## 🤖 Claude'
    lines.push(`${who}${when}`, '')
    for (const b of m.blocks)
      lines.push(m.kind === 'command-output' && b.type === 'text' ? fence(b.text) : block(b), '')
  }
  return (
    lines
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trimEnd() + '\n'
  )
}
