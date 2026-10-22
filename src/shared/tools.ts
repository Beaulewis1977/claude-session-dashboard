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

export function toolLabel(name: string, input: unknown, cwd?: string): string {
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
