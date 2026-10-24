// Clipboard writes for the phone app. navigator.clipboard only exists in a
// secure context (HTTPS or localhost), so a phone that reaches the PC over
// plain HTTP falls back to the old select-and-execCommand('copy') way.

/**
 * Copies with a hidden textarea. Runs synchronously so it still counts as
 * part of the tap that asked for it. Requires the copy event to accept the
 * requested text; execCommand can return true without actually copying it.
 */
export function copyWithTextarea(text: string, doc: Document = document): boolean {
  const ta = doc.createElement('textarea')
  ta.value = text
  ta.setAttribute('readonly', '')
  // 16px stops iOS zooming in; off-screen so nothing flashes.
  ta.style.cssText =
    'position:fixed;top:0;left:-9999px;width:1px;height:1px;opacity:0;font-size:16px;'
  const active = doc.activeElement as HTMLInputElement | HTMLTextAreaElement | null
  const inputSelection =
    active && typeof active.selectionStart === 'number' && typeof active.selectionEnd === 'number'
      ? {
          start: active.selectionStart,
          end: active.selectionEnd,
          direction: active.selectionDirection ?? undefined,
          scrollLeft: active.scrollLeft,
          scrollTop: active.scrollTop
        }
      : null
  const selection = doc.getSelection()
  const endpoints =
    selection?.anchorNode && selection.focusNode
      ? {
          anchorNode: selection.anchorNode,
          anchorOffset: selection.anchorOffset,
          focusNode: selection.focusNode,
          focusOffset: selection.focusOffset
        }
      : null
  const ranges: Range[] = []
  if (selection)
    for (let i = 0; i < selection.rangeCount; i++) ranges.push(selection.getRangeAt(i).cloneRange())
  // Radix menus and dialogs trap focus inside their content. Keep the temporary
  // textarea there so selecting it is allowed while the menu is still open.
  const scope = active?.closest('[role="menu"], [role="dialog"], [role="alertdialog"]')
  ;(scope ?? doc.body).appendChild(ta)
  let delivered = false
  const onCopy = (event: ClipboardEvent): void => {
    if (!event.clipboardData) return
    try {
      event.clipboardData.setData('text/plain', text)
      if (event.clipboardData.getData('text/plain') !== text) return
      event.preventDefault()
      delivered = event.defaultPrevented
    } catch {
      // A refused payload must not be reported as a successful copy.
    }
  }
  doc.addEventListener('copy', onCopy, true)
  let ok: boolean
  try {
    ta.focus({ preventScroll: true })
    ta.select()
    ta.setSelectionRange(0, text.length)
    ok = doc.execCommand('copy') && delivered
  } catch {
    ok = false
  } finally {
    doc.removeEventListener('copy', onCopy, true)
    ta.remove()
    // Focusing an input can clear the DOM selection, so restore focus first.
    active?.focus?.({ preventScroll: true })
    if (selection) {
      selection.removeAllRanges()
      if (endpoints && ranges.length === 1) {
        selection.setBaseAndExtent(
          endpoints.anchorNode,
          endpoints.anchorOffset,
          endpoints.focusNode,
          endpoints.focusOffset
        )
      } else {
        for (const r of ranges) selection.addRange(r)
      }
    }
    // Restoring DOM ranges can reset a focused input's selection in Chromium.
    if (active && inputSelection) {
      active.setSelectionRange(inputSelection.start, inputSelection.end, inputSelection.direction)
      active.scrollLeft = inputSelection.scrollLeft
      active.scrollTop = inputSelection.scrollTop
    }
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
