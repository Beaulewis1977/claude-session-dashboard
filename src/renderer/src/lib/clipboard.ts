// Clipboard writes for the phone app. navigator.clipboard only exists in a
// secure context (HTTPS or localhost), so a phone that reaches the PC over
// plain HTTP falls back to the old select-and-execCommand('copy') way.

/**
 * Copies with a hidden textarea. Runs synchronously so it still counts as
 * part of the tap that asked for it. Returns false if the browser refused.
 */
export function copyWithTextarea(text: string, doc: Document = document): boolean {
  const ta = doc.createElement('textarea')
  ta.value = text
  ta.setAttribute('readonly', '')
  // 16px stops iOS zooming in; off-screen so nothing flashes.
  ta.style.cssText =
    'position:fixed;top:0;left:-9999px;width:1px;height:1px;opacity:0;font-size:16px;'
  const active = doc.activeElement as HTMLElement | null
  const selection = doc.getSelection()
  const ranges: Range[] = []
  if (selection) for (let i = 0; i < selection.rangeCount; i++) ranges.push(selection.getRangeAt(i))
  doc.body.appendChild(ta)
  let ok: boolean
  try {
    ta.focus({ preventScroll: true })
    ta.select()
    ta.setSelectionRange(0, text.length)
    ok = doc.execCommand('copy')
  } catch {
    ok = false
  } finally {
    ta.remove()
    if (selection) {
      selection.removeAllRanges()
      for (const r of ranges) selection.addRange(r)
    }
    active?.focus?.({ preventScroll: true })
  }
  return ok
}

/** Writes text to the clipboard: the async Clipboard API when available, else the textarea fallback. */
export async function writeClipboard(text: string): Promise<void> {
  const clip = typeof navigator !== 'undefined' ? navigator.clipboard : undefined
  if (clip?.writeText && (typeof isSecureContext === 'undefined' || isSecureContext)) {
    try {
      await clip.writeText(text)
      return
    } catch {
      // Permission refused or the document lost focus: try the fallback.
    }
  }
  if (!copyWithTextarea(text)) throw new Error('The browser blocked copying')
}
