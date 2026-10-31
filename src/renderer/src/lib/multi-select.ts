// Picking several sessions in the list for a bulk action (desktop only).
//
// Mouse: Ctrl/⌘+click adds or removes a session, Shift+click picks a range.
// Keyboard (list focused): Space toggles the focused session, Shift+↑/↓
// extends a range, Ctrl/⌘+↑/↓ moves the focus without changing the picks,
// Ctrl/⌘+A picks every visible session, Esc clears. Plain ↑/↓ select one
// session, as before.

export interface Picked {
  /** The focused session (shown in the viewer). */
  selectedKey: string | null
  /** Where a range starts. */
  anchorKey: string | null
  /** The picked sessions. Empty = a plain single selection. */
  checked: string[]
}

/** The picks to start from: the explicit ones, else the selected session. */
function basePicks(keys: readonly string[], cur: Picked): string[] {
  const visible = new Set(keys)
  if (cur.checked.length) return cur.checked.filter((k) => visible.has(k))
  return cur.selectedKey && visible.has(cur.selectedKey) ? [cur.selectedKey] : []
}

function range(keys: readonly string[], from: string | null, to: string): string[] | undefined {
  const a = from ? keys.indexOf(from) : -1
  const b = keys.indexOf(to)
  if (a < 0 || b < 0) return undefined
  return keys.slice(Math.min(a, b), Math.max(a, b) + 1)
}

/** Ctrl/⌘+click: add or remove a session; it becomes the focused one and the anchor. */
export function toggleClick(keys: readonly string[], cur: Picked, key: string): Picked {
  const base = basePicks(keys, cur)
  const checked = base.includes(key) ? base.filter((k) => k !== key) : [...base, key]
  return { selectedKey: key, anchorKey: key, checked }
}

/** Shift+click: the range from the anchor to the clicked session. */
export function rangeClick(keys: readonly string[], cur: Picked, key: string): Picked {
  const anchor = cur.anchorKey ?? cur.selectedKey
  const r = range(keys, anchor, key)
  if (!r) return { selectedKey: key, anchorKey: key, checked: [] }
  return { selectedKey: key, anchorKey: anchor, checked: r }
}

/** Space: pick or unpick the focused session. */
export function toggleFocused(keys: readonly string[], cur: Picked): Picked {
  const key = cur.selectedKey
  if (!key || !keys.includes(key)) return cur
  // From a plain selection, Space marks that session as the first pick.
  if (!cur.checked.length) return { ...cur, anchorKey: key, checked: [key] }
  const base = basePicks(keys, cur)
  const checked = base.includes(key) ? base.filter((k) => k !== key) : [...base, key]
  return { ...cur, anchorKey: key, checked }
}

function stepKey(keys: readonly string[], from: string | null, delta: 1 | -1): string | null {
  if (!keys.length) return null
  const i = from ? keys.indexOf(from) : -1
  if (i < 0) return keys[delta > 0 ? 0 : keys.length - 1]
  return keys[Math.min(keys.length - 1, Math.max(0, i + delta))]
}

/** Shift+↑/↓: move the focus and pick the range from the anchor to it. */
export function extend(keys: readonly string[], cur: Picked, delta: 1 | -1): Picked {
  const next = stepKey(keys, cur.selectedKey, delta)
  if (!next) return cur
  const anchor = cur.anchorKey && keys.includes(cur.anchorKey) ? cur.anchorKey : cur.selectedKey
  const r = range(keys, anchor ?? next, next) ?? [next]
  return { selectedKey: next, anchorKey: anchor ?? next, checked: r }
}

/** Ctrl/⌘+↑/↓: move the focus, keep the picks (the selected session becomes one). */
export function moveFocus(keys: readonly string[], cur: Picked, delta: 1 | -1): Picked {
  const next = stepKey(keys, cur.selectedKey, delta)
  if (!next) return cur
  return { ...cur, selectedKey: next, checked: basePicks(keys, cur) }
}

/** Ctrl/⌘+A: every session in the list. */
export function selectAll(keys: readonly string[], cur: Picked): Picked {
  if (!keys.length) return cur
  return {
    selectedKey: cur.selectedKey && keys.includes(cur.selectedKey) ? cur.selectedKey : keys[0],
    anchorKey: keys[0],
    checked: [...keys]
  }
}

/** The picked sessions that are still in the list (filters may have hidden some). */
export function pickedVisible(keys: readonly string[], checked: readonly string[]): string[] {
  if (!checked.length) return []
  const set = new Set(checked)
  return keys.filter((k) => set.has(k))
}
