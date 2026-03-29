import type { PlasmoCSConfig } from "plasmo"
import { buildMarkdown, getAllTranscripts, saveTranscript, searchTranscripts, endSession, type Message } from "../lib/storage"
import type { Transcript } from "../lib/storage"
import { showSaveToast } from "../lib/toast"
import { log, warn } from "../lib/log"
import { rankTranscripts, buildCombinedContext } from "../lib/relevance"
import { getEditableText, setEditableText, findElement, redispatchEnter } from "../lib/inject"
import { getModelSelectors } from "../lib/config"

export const config: PlasmoCSConfig = {
  matches: ["https://gemini.google.com/*"],
  run_at: "document_idle"
}

// ─── State ────────────────────────────────────────────────────────────────────

let cachedTranscripts: Transcript[] = []
let injectedIds = new Set<string>()
let isInjecting = false
let sessionId = crypto.randomUUID()
let lastSavedHash = ""
let lastSavedTitle = ""
let saveTimer: ReturnType<typeof setTimeout> | null = null
let inputSelectors: string[] = []
let submitSelectors: string[] = []

// ─── Capture ──────────────────────────────────────────────────────────────────

function findUserEls(): Element[] {
  const p1 = Array.from(document.querySelectorAll("user-query"))
  if (p1.length > 0) return p1

  const p2 = Array.from(document.querySelectorAll(
    '[data-testid*="user-query"], [data-testid*="human-turn"], [class*="user-query"]'
  ))
  if (p2.length > 0) { warn("[MindRelay] Gemini user selector: using fallback P2"); return p2 }

  const p3 = Array.from(document.querySelectorAll('[aria-label*="You"], [aria-label*="user"]'))
  if (p3.length > 0) { warn("[MindRelay] Gemini user selector: using fallback P3"); return p3 }

  return []
}

function findAiEls(): Element[] {
  const p1 = Array.from(document.querySelectorAll("model-response"))
  if (p1.length > 0) return p1

  const p2 = Array.from(document.querySelectorAll(
    '[data-testid*="model-response"], [data-testid*="assistant-turn"], [class*="model-response"]'
  ))
  if (p2.length > 0) { warn("[MindRelay] Gemini AI selector: using fallback P2"); return p2 }

  const p3 = Array.from(document.querySelectorAll('[aria-label*="Gemini"], [aria-label*="response"]'))
  if (p3.length > 0) { warn("[MindRelay] Gemini AI selector: using fallback P3"); return p3 }

  return []
}

function extractTextFromUserEl(el: Element): string {
  const inner = el.querySelector("user-query-content")
  let text = (inner ?? el).textContent?.trim() ?? ""
  return text.replace(/^You said[:\s]*/i, "").trim()
}

function extractTextFromAiEl(el: Element): string {
  const inner = el.querySelector("message-content")
  return (inner ?? el).textContent?.trim() ?? ""
}

function extractMessages(): Message[] {
  const userEls = findUserEls()
  const aiEls = findAiEls()
  if (userEls.length === 0 && aiEls.length === 0) return []

  const allTurns = [
    ...userEls.map((el) => ({ el, isUser: true })),
    ...aiEls.map((el) => ({ el, isUser: false }))
  ].sort((a, b) =>
    a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
  )

  const messages: Message[] = []
  for (const { el, isUser } of allTurns) {
    const text = isUser ? extractTextFromUserEl(el) : extractTextFromAiEl(el)
    if (text.length >= 2) messages.push({ role: isUser ? "user" : "assistant", content: text })
  }
  return messages
}

function getTitleFromPage(): string {
  // Strategy 1: document.title — Gemini sets it to "Title - Gemini" when available
  const stripped = document.title
    .replace(/\s*[|\-–—]\s*Gemini\s*$/i, "")
    .replace(/\s*[|\-–—]\s*Google\s*Gemini\s*$/i, "")
    .replace(/\s*[|\-–—]\s*Google\s*DeepMind\s*$/i, "")
    .replace(/^Gemini\s*[|\-–—]\s*/i, "")
    .trim()
  if (stripped && !/^(gemini|google gemini|google deepmind)$/i.test(stripped)) return stripped

  // Strategy 2: Gemini sidebar — each conversation is an <a href="/app/<id>">.
  // The one matching the current path is the title shown in the UI.
  try {
    const path = location.pathname
    if (path.startsWith("/app/") && path.length > 5) {
      const anchor = document.querySelector(`a[href="${path}"]`) as HTMLElement | null
      const text = anchor?.textContent?.trim()
      if (text && text.length > 2 && !/^(gemini|google|new chat|new conversation)$/i.test(text)) return text
    }
  } catch { /* ignore */ }

  return ""
}

function getTitleFromMessages(messages: Message[]): string {
  const pageTitle = getTitleFromPage()
  if (pageTitle) return pageTitle

  const firstUser = messages.find((m) => m.role === "user")
  if (!firstUser) return "Gemini conversation"
  const text = firstUser.content.slice(0, 80)
  return text.length < firstUser.content.length ? `${text}...` : text
}

function hashMessages(messages: Message[]): string {
  return messages.map((m) => m.content.slice(0, 50)).join("|")
}

async function captureAndSave(): Promise<void> {
  try {
    let messages = extractMessages()
    log("[MindRelay] Gemini extractMessages:", messages.length)
    if (!messages.some(m => m.role === "user" && m.content.trim().length > 0)) return
    if (!messages.some(m => m.role === "assistant" && m.content.trim().length > 0)) return

    if (messages[0]?.role === "user" && messages[0].content.includes("[MindRelay")) {
      const sep = messages[0].content.indexOf("\n\n---\n\n")
      if (sep !== -1) {
        const cleaned = messages[0].content.slice(0, sep).trim()
        messages = cleaned.length > 0
          ? [{ role: "user", content: cleaned }, ...messages.slice(1)]
          : messages.slice(1)
      }
      if (messages.length < 2) return
    }

    const hash = hashMessages(messages)
    const title = getTitleFromMessages(messages)
    if (hash === lastSavedHash && title === lastSavedTitle) return
    lastSavedHash = hash
    lastSavedTitle = title
    const timestamp = Date.now()
    const markdown = buildMarkdown("Gemini", title, messages, timestamp)

    const saved = await saveTranscript({ source: "gemini", title, messages, markdown, timestamp, url: window.location.href })
    if (saved) showSaveToast()
    log("[MindRelay] Gemini saved:", title, saved ? "" : "(storage error)")
  } catch (err) {
    console.error("[MindRelay] Gemini captureAndSave error:", err)
  }
}

// ─── Injection ────────────────────────────────────────────────────────────────

async function refreshTranscripts(): Promise<void> {
  const all = await getAllTranscripts()
  cachedTranscripts = all.filter(t => t.source !== "gemini")
  log("[MindRelay] Gemini: loaded", cachedTranscripts.length, "transcripts for injection")
}

async function tryInjectContextAsync(inputEl: HTMLElement, target: EventTarget): Promise<void> {
  const userQuery = getEditableText(inputEl)
  if (!userQuery || userQuery.length < 3) {
    redispatchEnter(target)
    setTimeout(() => { isInjecting = false }, 200)
    return
  }

  let toInject: Transcript[] = []

  const hostResults = await searchTranscripts(userQuery, sessionId, 5)
  const freshHost = hostResults.filter(t => !injectedIds.has(t.id))
  if (freshHost.length > 0) {
    toInject = freshHost.slice(0, 3)
    log("[MindRelay] Gemini: host FTS5 →", toInject.length, "results")
  }

  if (toInject.length === 0 && cachedTranscripts.length > 0) {
    const localRanked = rankTranscripts(userQuery, cachedTranscripts, 3)
    toInject = localRanked.filter(t => !injectedIds.has(t.id))
    if (toInject.length > 0) log("[MindRelay] Gemini: local TF →", toInject.length, "results")
  }

  if (toInject.length > 0) {
    const context = buildCombinedContext(toInject)
    const success = setEditableText(inputEl, `${userQuery}\n\n---\n\n${context}`)
    if (success) toInject.forEach(t => injectedIds.add(t.id))
  }

  redispatchEnter(target)
  setTimeout(() => { isInjecting = false }, 200)
}

function setupInjection(): void {
  document.addEventListener("keydown", (e: KeyboardEvent) => {
    if (isInjecting) return
    if (e.key !== "Enter" || e.shiftKey || e.ctrlKey || e.metaKey) return

    const inputEl = findElement(inputSelectors)
    if (!inputEl) return
    if (!inputEl.contains(e.target as Node) && inputEl !== e.target) return

    const userQuery = getEditableText(inputEl)
    if (!userQuery || userQuery.length < 3) return

    e.preventDefault()
    isInjecting = true
    tryInjectContextAsync(inputEl, e.target as EventTarget).catch(() => {
      redispatchEnter(e.target as EventTarget)
      isInjecting = false
    })
  }, true)
}

// ─── Navigation / reset ───────────────────────────────────────────────────────

let lastUrl = location.href
setInterval(() => {
  if (location.href === lastUrl) return
  lastUrl = location.href
  endSession(sessionId)
  sessionId = crypto.randomUUID()
  injectedIds = new Set()
  refreshTranscripts()
}, 300)

// ─── Popup inject ─────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (sender.id !== chrome.runtime.id) return
  if (msg.type === "mindrelay:inject" && typeof msg.context === "string" && msg.context.length <= 100_000) {
    const inputEl = findElement(inputSelectors)
    if (!inputEl) { warn("[MindRelay] Gemini: popup inject — input not found"); return }
    const current = getEditableText(inputEl)
    setEditableText(inputEl, `${current}\n\n---\n\n${msg.context}`)
    log("[MindRelay] Gemini: injected from popup")
  }
})

// ─── Save triggers ────────────────────────────────────────────────────────────

window.addEventListener("beforeunload", captureAndSave)
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") captureAndSave()
})

const observer = new MutationObserver(() => {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(captureAndSave, 3_000)
})
observer.observe(document.body, { childList: true, subtree: true })

// Gemini sets the conversation title asynchronously. It may appear in document.title
// OR only in the sidebar <a href="/app/..."> element (which lives in document.body).
// The body MutationObserver already covers sidebar changes via the 3s debounce.
// This head observer catches document.title updates as a fast path (500ms vs 3s).
let lastSeenTitle = document.title
new MutationObserver(() => {
  if (document.title === lastSeenTitle) return
  lastSeenTitle = document.title
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(captureAndSave, 500)
}).observe(document.head, { childList: true, subtree: true, characterData: true })

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init(): Promise<void> {
  const selectors = await getModelSelectors("gemini")
  inputSelectors = selectors.inputSelectors
  submitSelectors = selectors.submitSelectors
  await refreshTranscripts()
  setupInjection()
}

init().catch(console.error)
log("[MindRelay] Gemini script loaded:", window.location.href)
