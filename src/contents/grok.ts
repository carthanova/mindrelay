import type { PlasmoCSConfig } from "plasmo"
import { buildMarkdown, getAllTranscripts, saveTranscript, type Message } from "../lib/storage"
import type { Transcript } from "../lib/storage"
import { showSaveToast } from "../lib/toast"
import { log, warn } from "../lib/log"
import { rankTranscripts, buildCombinedContext } from "../lib/relevance"
import { getEditableText, setEditableText, findElement, redispatchEnter } from "../lib/inject"
import { getModelSelectors } from "../lib/config"

export const config: PlasmoCSConfig = {
  matches: ["https://grok.com/*", "https://x.com/i/grok*"],
  run_at: "document_idle"
}

// ─── State ────────────────────────────────────────────────────────────────────

let cachedTranscripts: Transcript[] = []
let injectedIds = new Set<string>()
let isInjecting = false
let lastSavedHash = ""
let saveTimer: ReturnType<typeof setTimeout> | null = null
let inputSelectors: string[] = []
let submitSelectors: string[] = []

/** Strip query params and fragments for a clean URL. */
function getConversationUrl(): string {
  const { origin, pathname } = new URL(window.location.href)
  return origin + pathname
}

// Grok often redirects from /chat → /c/<id> after the first message is sent,
// changing the path mid-conversation. We lock onto the URL at the start of each
// session and only update it when we detect a genuinely empty new conversation.
// This ensures all saves for one conversation land under the same DB entry.
let sessionUrl = getConversationUrl()

// ─── Capture ──────────────────────────────────────────────────────────────────

function allMessageEls(): Element[] {
  return Array.from(document.querySelectorAll(".response-content-markdown"))
}

function findUserEls(): Element[] {
  return allMessageEls().filter((_, i) => i % 2 === 0)
}

function findAiEls(): Element[] {
  return allMessageEls().filter((_, i) => i % 2 === 1)
}

function cleanUserText(raw: string): string {
  const idx = raw.indexOf("[MindRelay")
  if (idx === -1) return raw
  return raw.slice(0, idx).trim()
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
    const raw = el.textContent?.trim() ?? ""
    const text = isUser ? cleanUserText(raw) : raw
    if (text.length >= 2) messages.push({ role: isUser ? "user" : "assistant", content: text })
  }
  return messages
}

function getTitleFromMessages(messages: Message[]): string {
  const pageTitle = document.title.replace(/\s*[-|–\/]\s*Grok\s*$/i, "").trim()
  if (pageTitle && !/^grok$/i.test(pageTitle)) return pageTitle

  const firstUser = messages.find((m) => m.role === "user")
  if (!firstUser) return "Grok conversation"
  const text = firstUser.content.slice(0, 80)
  return text.length < firstUser.content.length ? `${text}...` : text
}

function hashMessages(messages: Message[]): string {
  return messages.map((m) => m.content.slice(0, 50)).join("|")
}

async function captureAndSave(): Promise<void> {
  try {
    const messages = extractMessages()
    if (!messages.some(m => m.role === "user" && m.content.trim().length > 0)) return
    if (!messages.some(m => m.role === "assistant" && m.content.trim().length > 0)) return

    const hash = hashMessages(messages)
    if (hash === lastSavedHash) return
    lastSavedHash = hash

    const title = getTitleFromMessages(messages)
    const timestamp = Date.now()
    const markdown = buildMarkdown("Grok", title, messages, timestamp)

    const saved = await saveTranscript({ source: "grok", title, messages, markdown, timestamp, url: sessionUrl })
    if (saved) showSaveToast()
    log("[MindRelay] Grok saved:", title, saved ? "" : "(storage error)")
  } catch (err) {
    console.error("[MindRelay] Grok captureAndSave error:", err)
  }
}

// ─── Injection ────────────────────────────────────────────────────────────────

async function refreshTranscripts(): Promise<void> {
  const all = await getAllTranscripts()
  cachedTranscripts = all.filter(t => t.source !== "grok")
  log("[MindRelay] Grok: loaded", cachedTranscripts.length, "transcripts for injection")
}

function tryInjectContext(inputEl: HTMLElement): boolean {
  if (cachedTranscripts.length === 0) return false

  const userQuery = getEditableText(inputEl)
  if (!userQuery || userQuery.length < 3) return false

  const ranked = rankTranscripts(userQuery, cachedTranscripts, 3)
  const newOnes = ranked.filter(t => !injectedIds.has(t.id))
  if (newOnes.length === 0) return false

  const context = buildCombinedContext(newOnes)
  const success = setEditableText(inputEl, `${userQuery}\n\n---\n\n${context}`)
  if (success) {
    newOnes.forEach(t => injectedIds.add(t.id))
    log("[MindRelay] Grok: injected", newOnes.length, "transcripts via DOM")
  }
  return success
}

function setupInjection(): void {
  document.addEventListener("keydown", (e: KeyboardEvent) => {
    if (isInjecting) return
    if (e.key !== "Enter" || e.shiftKey || e.ctrlKey || e.metaKey) return

    const inputEl = findElement(inputSelectors)
    if (!inputEl) return
    if (!inputEl.contains(e.target as Node) && inputEl !== e.target) return

    if (!tryInjectContext(inputEl)) return

    e.preventDefault()
    isInjecting = true
    redispatchEnter(e.target as EventTarget)
    setTimeout(() => { isInjecting = false }, 200)
  }, true)
}

// ─── Navigation / reset ───────────────────────────────────────────────────────

let lastUrl = getConversationUrl()
setInterval(() => {
  const current = getConversationUrl()
  if (current === lastUrl) return
  lastUrl = current

  // Only treat as a new conversation when the DOM is empty.
  // If messages are present, Grok just assigned a conversation ID to the same
  // session (/chat → /c/<id>) — keep sessionUrl so saves stay under one DB entry.
  const hasMessages = extractMessages().length > 0
  if (!hasMessages) {
    sessionUrl = current
    lastSavedHash = ""
    injectedIds = new Set()
    refreshTranscripts()
  }
}, 300)

// ─── Popup inject ─────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (sender.id !== chrome.runtime.id) return
  if (msg.type === "mindrelay:inject" && typeof msg.context === "string" && msg.context.length <= 100_000) {
    const inputEl = findElement(inputSelectors)
    if (!inputEl) { warn("[MindRelay] Grok: popup inject — input not found"); return }
    const current = getEditableText(inputEl)
    setEditableText(inputEl, `${current}\n\n---\n\n${msg.context}`)
    log("[MindRelay] Grok: injected from popup")
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

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init(): Promise<void> {
  const selectors = await getModelSelectors("grok")
  inputSelectors = selectors.inputSelectors
  submitSelectors = selectors.submitSelectors
  await refreshTranscripts()
  setupInjection()
}

init().catch(console.error)
log("[MindRelay] Grok script loaded:", window.location.href)
