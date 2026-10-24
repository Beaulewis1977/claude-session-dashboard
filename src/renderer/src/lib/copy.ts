// What the viewer's copy buttons put on the clipboard: a message as plain text
// or as Markdown, and a tool call's input or output.

import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { gfm } from 'micromark-extension-gfm'
import type { Nodes } from 'mdast'
import type { ContentBlock, ToolResult } from '@shared/types'
import { blockToMarkdown } from '@shared/markdown'

type ToolUse = Extract<ContentBlock, { type: 'tool_use' }>

function inline(node: Nodes): string {
  switch (node.type) {
    case 'text':
    case 'inlineCode':
    case 'html':
      return node.value
    case 'break':
      return '\n'
    case 'image':
      return node.alt ?? ''
    case 'link': {
      const text = node.children.map(inline).join('')
      return text && text !== node.url && !node.url.startsWith('mailto:')
        ? `${text} (${node.url})`
        : text || node.url
    }
    case 'footnoteReference':
      return `[${node.label ?? node.identifier}]`
    default:
      return 'children' in node ? node.children.map((c) => inline(c as Nodes)).join('') : ''
  }
}

function blocks(nodes: Nodes[], indent = ''): string {
  return nodes
    .map((n) => block(n, indent))
    .filter((s) => s !== '')
    .join('\n\n')
}

function block(node: Nodes, indent: string): string {
  switch (node.type) {
    case 'root':
    case 'blockquote':
    case 'footnoteDefinition':
      return blocks(node.children, indent)
    case 'paragraph':
    case 'heading':
      return indentLines(inline(node), indent)
    case 'code':
      return indentLines(node.value, indent)
    case 'html':
      return indentLines(node.value, indent)
    case 'thematicBreak':
    case 'definition':
      return ''
    case 'list':
      return node.children
        .map((item, i) => {
          const marker = node.ordered ? `${(node.start ?? 1) + i}. ` : '- '
          const check = item.checked === true ? '[x] ' : item.checked === false ? '[ ] ' : ''
          const body = item.children
            .map((c) => block(c, ' '.repeat(marker.length)))
            .filter(Boolean)
            .join(node.spread || item.spread ? '\n\n' : '\n')
          return indentLines(marker + check + body.trimStart(), indent)
        })
        .join(node.spread ? '\n\n' : '\n')
    case 'table':
      return node.children
        .map((row) => row.children.map((cell) => inline(cell)).join('\t'))
        .map((line) => indent + line)
        .join('\n')
    default:
      return indentLines(inline(node), indent)
  }
}

function indentLines(text: string, indent: string): string {
  if (!indent) return text
  return text
    .split('\n')
    .map((l) => (l ? indent + l : l))
    .join('\n')
}

/**
 * Markdown as the text a reader sees: no `#`, `**`, backticks or code fences,
 * links as "text (url)", list markers kept so lists still read as lists.
 */
export function markdownToPlainText(markdown: string): string {
  try {
    const tree = fromMarkdown(markdown, {
      extensions: [gfm()],
      mdastExtensions: [gfmFromMarkdown()]
    })
    return block(tree, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  } catch {
    return markdown.trim()
  }
}

/** One message (or a group of blocks shown as one bubble) as Markdown. */
export function blocksToMarkdown(list: ContentBlock[]): string {
  return list
    .map(blockToMarkdown)
    .filter(Boolean)
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** One message (or a group of blocks shown as one bubble) as plain text. */
export function blocksToPlainText(list: ContentBlock[]): string {
  return list
    .map((b) => {
      switch (b.type) {
        case 'text':
          return markdownToPlainText(b.text)
        case 'thinking':
          return b.redacted ? '' : markdownToPlainText(b.text)
        case 'tool_use':
          return [b.label, toolInputText(b), b.result ? toolOutputText(b.result) : '']
            .filter(Boolean)
            .join('\n\n')
        case 'tool_result':
          return toolOutputText(b.result)
        case 'image':
          return '[image]'
      }
    })
    .filter(Boolean)
    .join('\n\n')
    .trim()
}

/** A tool call's input as the text it was given: the command, the file content, the prompt, or JSON. */
export function toolInputText(tool: ToolUse): string {
  const i = (tool.input ?? {}) as Record<string, unknown>
  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
  switch (tool.name) {
    case 'Bash':
    case 'PowerShell':
      if (str(i.command) !== undefined) return str(i.command)!
      break
    case 'Write':
      if (str(i.content) !== undefined) return str(i.content)!
      break
    case 'Task':
    case 'Agent':
      if (str(i.prompt)) return str(i.prompt)!
      break
  }
  return JSON.stringify(tool.input, null, 2) ?? ''
}

/** A tool result's full text (never the truncated preview). */
export function toolOutputText(result: ToolResult): string {
  return result.text
}
