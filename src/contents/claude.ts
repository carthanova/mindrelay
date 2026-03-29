import type { PlasmoCSConfig } from "plasmo"
import { buildMarkdown, getAllTranscripts, saveTranscript, type Message } from "../lib/storage"
import type { Transcript } from "../lib/storage"
import { showSaveToast } from "../lib/toast"
import { log, warn } from "../lib/log"
import { rankTranscripts, buildCombinedContext } from "../lib/relevance"
import { getEditableText, setEditableText, findElement, redispatchEnter } from "../lib/inject"
import { getModelSelectors } from "../lib/config"

export const config: PlasmoCSConfig = {
  matches: ["https://claude.ai/*"],
  run_at: "document_idle"
}

// ─── State ───────────────────────────────────────────────────────────────────

let cachedTranscripts: Transcript[] = []
let injectedIds = new Set<string>()
let isInjecting = false
let lastSavedHash = ""
let saveTimer: ReturnType<typeof setTimeout> | null = null
let inputSelectors: string[] = []
let submitSelectors: string[] = []

// ─── Capture ──────────────────────────────────────────────────────────────────

function findUserEls(): Element[] {
  const p1 = Array.from(document.querySelectorAll('[data-testid="user-message"]'))
  if (p1.length > 0) return p1

  const p2 = Array.from(document.querySelectorAll('[data-testid*="human-turn"], [data-testid*="user-turn"]'))
  if (p2.length > 0) { warn("[MindRelay] Claude user selector: using fallback P2"); return p2 }

  const p3 = Array.from(document.querySelectorAll('[data-message-author-role="human"], [data-message-author-role="user"]'))
  if (p3.length > 0) { warn("[MindRelay] Claude user selector: using fallback P3"); return p3 }

  return []
}

function findAiEls(): Element[] {
  const retryBtns = Array.from(document.querySelectorAll('[data-testid="action-bar-retry"]'))
  if (retryBtns.length > 0) {
    const els = retryBtns
      .map((btn) => btn.closest(".group"))
      .filter((el): el is Element => el !== null)
      .filter((el, i, arr) => arr.indexOf(el) === i)
    if (els.length > 0) return els
  }

  const p2 = Array.from(document.querySelectorAll(".group"))
    .filter((el) => !el.querySelector('[data-testid="user-message"]') && el.textContent!.trim().length > 10)
  if (p2.length > 0) { warn("[MindRelay] Claude AI selector: using fallback P2"); return p2 }

  const p3 = Array.from(document.querySelectorAll('[data-testid*="assistant"], [data-testid*="response-"]'))
  if (p3.length > 0) { warn("[MindRelay] Claude AI selector: using fallback P3"); return p3 }

  return []
}

function extractMessages(): Message[] {
  const messages: Message[] = []
  const userEls = findUserEls()
  const aiEls = findAiEls()
  if (userEls.length === 0 && aiEls.length === 0) return []

  const allTurns = [...userEls, ...aiEls].sort((a, b) =>
    a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
  )

  for (const el of allTurns) {
    const isUser = el.getAttribute("data-testid") === "user-message"
    let text: string

    if (isUser) {
      text = el.textContent?.trim() ?? ""
    } else {
      const retryBtn = el.querySelector('[data-testid="action-bar-retry"]')
      let actionBar: Element | null = retryBtn
      for (let i = 0; i < 4; i++) actionBar = actionBar?.parentElement ?? null

      const clone = el.cloneNode(true) as Element
      if (actionBar) {
        const retryInClone = clone.querySelector('[data-testid="action-bar-retry"]')
        let actionBarInClone: Element | null = retryInClone
        for (let i = 0; i < 4; i++) actionBarInClone = actionBarInClone?.parentElement ?? null
        actionBarInClone?.remove()
      }
      clone.querySelectorAll('[class*="thinking"], [class*="Thinking"]').forEach((n) => n.remove())
      text = clone.textContent?.trim() ?? ""
      text = text.replace(/^Thought for \d+s\s*/i, "").trim()
    }

    if (text.length > 2) messages.push({ role: isUser ? "user" : "assistant", content: text })
  }

  log("[MindRelay] extracted messages:", messages.length)
  return messages
}

function getTitleFromMessages(messages: Message[]): string {
  const pageTitle = document.title.replace(/\s*[-|–]\s*Claude\s*$/i, "").trim()
  if (pageTitle && !/^claude$/i.test(pageTitle)) return pageTitle

  const firstUser = messages.find((m) => m.role === "user")
  if (!firstUser) return document.title || "Claude conversation"
  const text = firstUser.content.slice(0, 80)
  return text.length < firstUser.content.length ? `${text}...` : text
}

function hashMessages(messages: Message[]): string {
  return messages.map((m) => m.content.slice(0, 50)).join("|")
}

async function captureAndSave(): Promise<void> {
  let messages = extractMessages()
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
  if (hash === lastSavedHash) return
  lastSavedHash = hash

  const title = getTitleFromMessages(messages)
  const timestamp = Date.now()
  const markdown = buildMarkdown("Claude", title, messages, timestamp)

  const saved = await saveTranscript({ source: "claude", title, messages, markdown, timestamp, url: window.location.href })
  if (saved) showSaveToast()
  log("[MindRelay] saved:", title, saved ? "" : "(storage error)")
}

// ─── Injection ────────────────────────────────────────────────────────────────

async function refreshTranscripts(): Promise<void> {
  const all = await getAllTranscripts()
  cachedTranscripts = all.filter(t => t.source !== "claude")
  log("[MindRelay] Claude: loaded", cachedTranscripts.length, "transcripts for injection")
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
    log("[MindRelay] Claude: injected", newOnes.length, "transcripts via DOM")
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

let lastUrl = location.href
setInterval(() => {
  if (location.href === lastUrl) return
  lastUrl = location.href
  injectedIds = new Set()
  refreshTranscripts()
}, 300)

document.addEventListener("click", (e) => {
  const target = (e.target as Element).closest('a[href="/new"]')
  if (target) {
    injectedIds = new Set()
    setTimeout(refreshTranscripts, 150)
  }
}, true)

// ─── Popup inject ─────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (sender.id !== chrome.runtime.id) return
  if (msg.type === "mindrelay:inject" && typeof msg.context === "string" && msg.context.length <= 100_000) {
    const inputEl = findElement(inputSelectors)
    if (!inputEl) { warn("[MindRelay] Claude: popup inject — input not found"); return }
    const current = getEditableText(inputEl)
    setEditableText(inputEl, `${current}\n\n---\n\n${msg.context}`)
    log("[MindRelay] Claude: injected from popup")
  }
})

// ─── Save triggers ────────────────────────────────────────────────────────────

window.addEventListener("beforeunload", () => captureAndSave())
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") captureAndSave()
})

const observer = new MutationObserver(() => {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(captureAndSave, 3_000)
})
observer.observe(document.body, { childList: true, subtree: true })
setTimeout(captureAndSave, 5_000)

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init(): Promise<void> {
  const selectors = await getModelSelectors("claude")
  inputSelectors = selectors.inputSelectors
  submitSelectors = selectors.submitSelectors
  await refreshTranscripts()
  setupInjection()
}

init().catch(console.error)
log("[MindRelay] Claude script loaded:", window.location.href)
