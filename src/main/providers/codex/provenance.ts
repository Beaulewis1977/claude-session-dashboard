// Who wrote a user message's text in a Codex rollout: me, or Codex (the
// context it adds as "user" text: the environment, AGENTS.md, plugin
// suggestions, …). Used by the reader (context is kept short, so it never
// fills the size budget) and by the parser (context is never a prompt).

/**
 * Context Codex adds as user text, by the tags Codex itself uses. Only for
 * rollouts that don't say who wrote each item (see whoWrote): a tag's
 * spelling doesn't prove where it came from, so only Codex's own tags count,
 * never any tag that merely looks like them (a prompt like
 * `<user_input>…</user_input>` I typed stays a prompt). Matched at the start,
 * so the start of the text is enough.
 */
const INJECTED_RE =
  /^\s*(<(environment_context|user_instructions|permissions instructions|collaboration_mode|apps_instructions|skills_instructions|turn_aborted|user_shell_command|subagent_notification|personality_spec|recommended_plugins|external_codex_apps_open_page|codex_internal_context)\b|# AGENTS\.md instructions\b|<INSTRUCTIONS>)/i

/** Context Codex added, by its tags only (for rollouts without provenance; see whoWrote). */
export function isInjected(text: string): boolean {
  return INJECTED_RE.test(text)
}

/**
 * Who wrote a message's content item, as the rollout records it. Newer
 * Codex keeps, per item, `internal_chat_message_metadata_passthrough`
 * `.content_item_metadata[i].provenance.type` ("user", "harness",
 * "agents_md", …) and `.content_item_kinds[i]` ("user.text", "user.image",
 * "environments.environment_context", "plugins.recommendations", …).
 * undefined: the rollout doesn't say (older Codex).
 */
export function whoWrote(p: Record<string, unknown>, i: number): 'user' | 'codex' | undefined {
  const m = p.internal_chat_message_metadata_passthrough
  if (!m || typeof m !== 'object') return undefined
  const { content_item_metadata: metas, content_item_kinds: kinds } = m as Record<string, unknown>
  const content = Array.isArray(p.content) ? p.content.length : 0
  // Only arrays that line up with the content items.
  if (Array.isArray(metas) && metas.length === content) {
    const prov = (metas[i] as { provenance?: { type?: unknown } } | null)?.provenance?.type
    if (typeof prov === 'string') return prov === 'user' ? 'user' : 'codex'
  }
  if (Array.isArray(kinds) && kinds.length === content) {
    const kind = kinds[i]
    if (typeof kind === 'string') return kind.startsWith('user.') ? 'user' : 'codex'
  }
  return undefined
}

/** Is the i-th text item of a user message context Codex added? */
export function isContextItem(p: Record<string, unknown>, i: number, text: string): boolean {
  const who = whoWrote(p, i)
  return who === 'codex' || (who === undefined && isInjected(text))
}
