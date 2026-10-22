// claude.ai data exports (Settings → Privacy → Export data): a zip with
// `conversations.json`, an array of conversations with their messages.
// Each conversation becomes a view-only session in the app's archive, stored
// as JSONL events in Claude Code's shape so the viewer, search and Markdown
// export work unchanged. They carry no token usage and can't be resumed.

export interface ClaudeAiConversation {
  uuid: string
  name: string
  createdAt?: string
  updatedAt?: string
  messages: number
  /** JSONL text for the app's archive. */
  jsonl: string
}

function obj(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined
}

function iso(v: unknown): string | undefined {
  const s = str(v)
  if (!s) return undefined
  const t = Date.parse(s)
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined
}

const UUID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/

/** Message blocks in Claude Code's shape. Unknown block types are skipped. */
function blocks(m: Record<string, unknown>, assistant: boolean): unknown[] {
  const out: unknown[] = []
  const content = Array.isArray(m.content) ? m.content : []
  for (const b of content) {
    const o = obj(b)
    if (!o) continue
    if (o.type === 'text' && str(o.text)) out.push({ type: 'text', text: o.text })
    else if (assistant && o.type === 'thinking' && str(o.thinking))
      out.push({ type: 'thinking', thinking: o.thinking })
    else if (assistant && o.type === 'tool_use' && str(o.name))
      out.push({
        type: 'tool_use',
        id: str(o.id) ?? `toolu_${out.length}`,
        name: o.name,
        input: obj(o.input) ?? {}
      })
  }
  // Older exports only have `text`.
  if (!out.some((b) => obj(b)?.type === 'text') && str(m.text))
    out.unshift({ type: 'text', text: m.text })
  const files = [
    ...(Array.isArray(m.attachments) ? m.attachments : []),
    ...(Array.isArray(m.files) ? m.files : [])
  ]
    .map((f) => str(obj(f)?.file_name))
    .filter((f): f is string => !!f)
  if (files.length) out.push({ type: 'text', text: `Attached: ${[...new Set(files)].join(', ')}` })
  return out
}

/** Convert `conversations.json` (already parsed). Bad entries are skipped and counted. */
export function convertClaudeAiExport(data: unknown): {
  conversations: ClaudeAiConversation[]
  skipped: number
} {
  const list = Array.isArray(data) ? data : (obj(data)?.conversations as unknown[] | undefined)
  if (!Array.isArray(list)) throw new Error("conversations.json isn't a list of conversations")
  const conversations: ClaudeAiConversation[] = []
  let skipped = 0
  for (const c of list) {
    const o = obj(c)
    const uuid = str(o?.uuid)
    if (!o || !uuid || !UUID_RE.test(uuid)) {
      skipped++
      continue
    }
    const name = str(o.name)?.trim() || 'Untitled conversation'
    const msgs = Array.isArray(o.chat_messages) ? o.chat_messages : []
    const lines: string[] = []
    lines.push(JSON.stringify({ type: 'summary', summary: name, importedFrom: 'claude.ai' }))
    let parent: string | null = null
    let count = 0
    const fallbackTime = iso(o.created_at)
    for (const raw of msgs) {
      const m = obj(raw)
      if (!m) continue
      const assistant = m.sender === 'assistant'
      if (!assistant && m.sender !== 'human') continue
      const content = blocks(m, assistant)
      if (!content.length) continue
      const id = str(m.uuid) ?? `${uuid}-${count}`
      const timestamp = iso(m.created_at) ?? fallbackTime
      const e: Record<string, unknown> = {
        parentUuid: parent,
        isSidechain: false,
        type: assistant ? 'assistant' : 'user',
        uuid: id,
        sessionId: uuid,
        importedFrom: 'claude.ai',
        message: assistant
          ? { id, type: 'message', role: 'assistant', content }
          : { role: 'user', content }
      }
      if (timestamp) e.timestamp = timestamp
      lines.push(JSON.stringify(e))
      parent = id
      count++
    }
    if (!count) {
      skipped++
      continue
    }
    conversations.push({
      uuid,
      name,
      createdAt: iso(o.created_at),
      updatedAt: iso(o.updated_at),
      messages: count,
      jsonl: lines.join('\n') + '\n'
    })
  }
  return { conversations, skipped }
}
