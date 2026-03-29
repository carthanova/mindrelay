import type { PlasmoCSConfig } from "plasmo"
import { buildMarkdown, getAllTranscripts, saveTranscript, type Message } from "../lib/storage"
import type { Transcript } from "../lib/storage"
import { showSaveToast } from "../lib/toast"
import { log, warn } from "../lib/log"
import { rankTranscripts, buildCombinedContext } from "../lib/relevance"
import { getEditableText, setEditableText, findElement, redispatchEnter } from "../lib/inject"
import { getModelSelectors } from "../lib/config"

export const config: PlasmoCSConfig = {
  matches: ["https://chatgpt.com/*"],
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

// ─── Capture ──────────────────────────────────────────────────────────────────

function findTurns(): { el: Element; role: "user" | "assistant" }[] {
  const p1 = Array.from(document.querySelectorAll("[data-testid^='conversation-turn']"))
  if (p1.length > 0) {
    const mapped = p1.flatMap((turn) => {
      const roleEl = turn.querySelector("[data-message-author-role]")
      const role = roleEl?.getAttribute("data-message-author-role") as "user" | "assistant" | null
      return role ? [{ el: turn, role }] : []
    })
    if (mapped.length > 0) return mapped
  }

  const p2 = Array.from(document.querySelectorAll("[data-message-author-role]"))
  if (p2.length > 0) {
    warn("[MindRelay] ChatGPT selector: using fallback P2")
    return p2.flatMap((el) => {
      const role = el.getAttribute("data-message-author-role") as "user" | "assistant" | null
      return role === "user" || role === "assistant" ? [{ el, role }] : []
    })
  }

  const userEls = Array.from(document.querySelectorAll('[data-testid*="user-message"], [data-testid*="human-message"]'))
  const aiEls = Array.from(document.querySelectorAll('[data-testid*="assistant-message"], [data-testid*="bot-message"]'))
  if (userEls.length > 0 || aiEls.length > 0) {
    warn("[MindRelay] ChatGPT selector: using fallback P3")
    const result: { el: Element; role: "user" | "assistant" }[] = [
      ...userEls.map((el) => ({ el, role: "user" as const })),
      ...aiEls.map((el) => ({ el, role: "assistant" as const }))
    ]
    return result.sort((a, b) =>
      a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
    )
  }

  return []
}

function extractMessages(): Message[] {
  return findTurns().flatMap(({ el, role }) => {
    const text = el.textContent?.trim() ?? ""
    return text.length > 2 ? [{ role, content: text }] : []
  })
}

function getTitleFromMessages(messages: Message[]): string {
  const pageTitle = document.title.replace(/\s*[-|–]\s*ChatGPT\s*$/i, "").trim()
  if (pageTitle && !/^chatgpt$/i.test(pageTitle)) return pageTitle

  const firstUser = messages.find((m) => m.role === "user")
  if (!firstUser) return "ChatGPT conversation"
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
  const markdown = buildMarkdown("ChatGPT", title, messages, timestamp)

  const saved = await saveTranscript({ source: "chatgpt", title, messages, markdown, timestamp, url: window.location.href })
  if (saved) showSaveToast()
}

// ─── Injection ────────────────────────────────────────────────────────────────

async function refreshTranscripts(): Promise<void> {
  const all = await getAllTranscripts()
  cachedTranscripts = all.filter(t => t.source !== "chatgpt")
  log("[MindRelay] ChatGPT: loaded", cachedTranscripts.length, "transcripts for injection")
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
    log("[MindRelay] ChatGPT: injected", newOnes.length, "transcripts via DOM")
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
  const target = (e.target as Element).closest('[data-testid="create-new-chat-button"]')
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
    if (!inputEl) { warn("[MindRelay] ChatGPT: popup inject — input not found"); return }
    const current = getEditableText(inputEl)
    setEditableText(inputEl, `${current}\n\n---\n\n${msg.context}`)
    log("[MindRelay] ChatGPT: injected from popup")
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
  const selectors = await getModelSelectors("chatgpt")
  inputSelectors = selectors.inputSelectors
  submitSelectors = selectors.submitSelectors
  await refreshTranscripts()
  setupInjection()
}

init().catch(console.error)
log("[MindRelay] ChatGPT script loaded:", window.location.href)
