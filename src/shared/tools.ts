// Short, human labels for tool calls, e.g. "Edit src/app.ts" or "Bash: npm test".

function s(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}

function oneLine(text: string, max = 80): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/** Make a path relative to the session cwd when it is inside it. */
export function relativeTo(path: string, cwd?: string): string {
  if (!cwd) return path
  const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '')
  const p = norm(path)
  const c = norm(cwd)
  const windows = /^[a-zA-Z]:\//.test(c)
  const pc = windows ? p.toLowerCase() : p
  const cc = windows ? c.toLowerCase() : c
  if (pc.startsWith(cc + '/')) return p.slice(c.length + 1)
  return path
}

/** Longest tool name and label kept: both come from session files, which can hold anything. */
const MAX_NAME = 200
const MAX_LABEL = 300

export function toolLabel(name: string, input: unknown, cwd?: string): string {
  const label = rawLabel(name.slice(0, MAX_NAME), input, cwd)
  return label.length > MAX_LABEL ? `${label.slice(0, MAX_LABEL - 1)}…` : label
}

/**
 * "Bash: npm test" → ["Bash:", "npm test"], "Edit src/a.ts" → ["Edit", "src/a.ts"]:
 * the first word (with its colon), then the rest after one space. One pass
 * over the label, however long or odd it is.
 */
export function splitToolLabel(label: string): [string, string?] {
  let i = 0
  while (i < label.length && label[i] !== ':' && !/\s/.test(label[i])) i++
  if (i === 0) return [label]
  if (label[i] === ':') i++
  return i < label.length && /\s/.test(label[i]) ? [label.slice(0, i), label.slice(i + 1)] : [label]
}

function record(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined
}

const text = (v: unknown): string => (typeof v === 'string' ? v : '')

/** TodoWrite's list, as plain strings (anything else in the file is dropped). */
export function todoItems(input: unknown): { content: string; status: string }[] {
  const todos = record(input)?.todos
  if (!Array.isArray(todos)) return []
  return todos
    .map(record)
    .filter((t): t is Record<string, unknown> => !!t)
    .map((t) => ({ content: text(t.content), status: text(t.status) }))
}

/** MultiEdit's edits, as plain strings. */
export function editItems(input: unknown): { oldText: string; newText: string }[] {
  const edits = record(input)?.edits
  if (!Array.isArray(edits)) return []
  return edits
    .map(record)
    .filter((e): e is Record<string, unknown> => !!e)
    .map((e) => ({ oldText: text(e.old_string), newText: text(e.new_string) }))
}

function rawLabel(name: string, input: unknown, cwd?: string): string {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const path = s(i.file_path) ?? s(i.notebook_path) ?? s(i.path)
  switch (name) {
    case 'Bash':
    case 'PowerShell':
      return `${name}: ${oneLine(s(i.command) ?? s(i.description) ?? '')}`.trim()
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'Read':
    case 'NotebookEdit':
    case 'NotebookRead':
      return path ? `${name} ${relativeTo(path, cwd)}` : name
    case 'Grep':
      return `Grep ${JSON.stringify(s(i.pattern) ?? '')}${path ? ` in ${relativeTo(path, cwd)}` : ''}`
    case 'Glob':
      return `Glob ${s(i.pattern) ?? ''}`.trim()
    case 'LS':
      return path ? `LS ${relativeTo(path, cwd)}` : 'LS'
    case 'WebFetch':
      return `WebFetch ${s(i.url) ?? ''}`.trim()
    case 'WebSearch':
      return `WebSearch: ${oneLine(s(i.query) ?? '')}`
    case 'Task':
    case 'Agent':
      return `${name}: ${oneLine(s(i.description) ?? s(i.prompt) ?? '')}`
    case 'TodoWrite':
      return 'Update todos'
    case 'ExitPlanMode':
      return 'Plan ready'
    default: {
      const mcp = /^mcp__(.+?)__(.+)$/.exec(name)
      if (mcp) return `${mcp[1]} · ${mcp[2]}`
      return name
    }
  }
}
