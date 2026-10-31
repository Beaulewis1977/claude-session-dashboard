// Picking several sessions in the list (Ctrl/⌘+click, Shift+click) for a bulk action.

export interface Picked {
  selectedKey: string | null
  /** Empty for a single selection. */
  checked: string[]
}

/**
 * Ctrl/⌘+click (`toggle`) adds or removes one session; Shift+click (`range`)
 * picks everything between the selected session and the clicked one, in list
 * order. Picking one or none is a plain selection again (`checked` empty).
 */
export function pick(
  keys: readonly string[],
  current: Picked,
  key: string,
  mode: 'toggle' | 'range'
): Picked {
  const visible = new Set(keys)
  if (mode === 'range') {
    const anchor = current.selectedKey
    const from = anchor ? keys.indexOf(anchor) : -1
    const to = keys.indexOf(key)
    if (from < 0 || to < 0) return { selectedKey: key, checked: [] }
    const range = keys.slice(Math.min(from, to), Math.max(from, to) + 1)
    return { selectedKey: anchor, checked: range.length > 1 ? range : [] }
  }
  const base = current.checked.length
    ? current.checked.filter((k) => visible.has(k))
    : current.selectedKey && visible.has(current.selectedKey)
      ? [current.selectedKey]
      : []
  const next = base.includes(key) ? base.filter((k) => k !== key) : [...base, key]
  const selectedKey = next.includes(key) ? key : (next[next.length - 1] ?? key)
  return { selectedKey, checked: next.length > 1 ? next : [] }
}

/** The picked sessions that are still in the list (filters may have hidden some). */
export function pickedVisible(keys: readonly string[], checked: readonly string[]): string[] {
  if (!checked.length) return []
  const set = new Set(checked)
  return keys.filter((k) => set.has(k))
}
