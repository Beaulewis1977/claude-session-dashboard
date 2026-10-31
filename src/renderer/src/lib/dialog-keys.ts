// Keyboard rules for the launch dialog.

/**
 * Enter launches from anywhere in the dialog except a button (Ctrl+Enter
 * launches from buttons too). Never from inside a menu: React passes events
 * up from a portal, so Enter on a picker's item (Model, Effort, Billing)
 * reaches the dialog after the item has handled it. Nor when something has
 * already handled the key (e.g. the custom model field).
 */
export function launchesOnEnter(e: {
  defaultPrevented: boolean
  ctrlKey: boolean
  metaKey: boolean
  target: EventTarget | null
}): boolean {
  if (e.defaultPrevented) return false
  const t = e.target as HTMLElement | null
  if (t?.closest?.('[role="menu"], [role^="menuitem"]')) return false
  return e.ctrlKey || e.metaKey || t?.tagName !== 'BUTTON'
}
