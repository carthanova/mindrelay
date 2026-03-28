// Shared DOM injection utilities for MindRelay content scripts.
// All helpers are React-compatible — they trigger native input events that
// React's event delegation observes, so framework state stays in sync.

// ─── Read ─────────────────────────────────────────────────────────────────────

/**
 * Returns the visible text content of a (possibly nested) editable element.
 * Handles Gemini's rich-textarea wrapper by looking for the inner contenteditable.
 */
export function getEditableText(el: HTMLElement): string {
  const inner = el.querySelector('[contenteditable="true"]') as HTMLElement | null
  return ((inner ?? el).textContent ?? "").trim()
}

// ─── Write ────────────────────────────────────────────────────────────────────

/**
 * Sets the full text content of an editable element in a React-compatible way.
 *
 * For <textarea>/<input>: uses the native value setter so React's onChange fires.
 * For contenteditable: uses execCommand('insertText') which triggers the native
 * input event that React observes via event delegation.
 *
 * Returns true if the write succeeded.
 */
export function setEditableText(el: HTMLElement, text: string): boolean {
  try {
    // textarea / input
    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
      const proto = el.tagName === "TEXTAREA"
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype
      const nativeSetter = Object.getOwnPropertyDescriptor(proto, "value")?.set
      if (nativeSetter) {
        nativeSetter.call(el, text)
        el.dispatchEvent(new Event("input", { bubbles: true }))
        el.dispatchEvent(new Event("change", { bubbles: true }))
        return true
      }
    }

    // contenteditable (including Gemini's rich-textarea wrapper)
    const target = (el.querySelector('[contenteditable="true"]') as HTMLElement | null) ?? el
    target.focus()
    document.execCommand("selectAll", false, undefined)
    return document.execCommand("insertText", false, text)
  } catch {
    return false
  }
}

// ─── Find ─────────────────────────────────────────────────────────────────────

/**
 * Returns the first element matching any of the provided CSS selectors.
 * Silently skips invalid selectors.
 */
export function findElement(selectors: string[]): HTMLElement | null {
  for (const sel of selectors) {
    try {
      const el = document.querySelector(sel) as HTMLElement | null
      if (el) return el
    } catch {}
  }
  return null
}

// ─── Submit re-dispatch ───────────────────────────────────────────────────────

/**
 * Fires a synthetic Enter keydown on `target` after a short delay,
 * allowing React to flush state updates from a preceding setEditableText call.
 */
export function redispatchEnter(target: EventTarget): void {
  setTimeout(() => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true,
        composed: true
      })
    )
  }, 50)
}
