import type { PlasmoCSConfig } from "plasmo"
import {
  buildMarkdown,
  getAllTranscripts,
  saveTranscript,
  type Message
} from "../lib/storage"
import { showSaveToast } from "../lib/toast"
import { log, warn } from "../lib/log"

export const config: PlasmoCSConfig = {
  matches: ["https://chatgpt.com/*"],
  run_at: "document_idle"
}

const MM_NONCE = Array.from(crypto.getRandomValues(new Uint8Array(16)))
  .map((b) => b.toString(16).padStart(2, "0")).join("")

let lastSavedHash = ""

// ─── Capture ───────────────────────────────────────────────────────────────

function findTurns(): { el: Element; role: "user" | "assistant" }[] {
  // P1 — conversation-turn testid wrappers (confirmed working)
  const p1 = Array.from(document.querySelectorAll("[data-testid^='conversation-turn']"))
  if (p1.length > 0) {
    const mapped = p1.flatMap((turn) => {
      const roleEl = turn.querySelector("[data-message-author-role]")
      const role = roleEl?.getAttribute("data-message-author-role") as "user" | "assistant" | null
      return role ? [{ el: turn, role }] : []
    })
    if (mapped.length > 0) return mapped
  }

  // P2 — fallback: query role elements directly (turn wrapper may have changed)
  const p2 = Array.from(document.querySelectorAll("[data-message-author-role]"))
  if (p2.length > 0) {
    warn("[MindRelay] ChatGPT selector: using fallback P2")
    return p2.flatMap((el) => {
      const role = el.getAttribute("data-message-author-role") as "user" | "assistant" | null
      return role === "user" || role === "assistant" ? [{ el, role }] : []
    })
  }

  // P3 — last resort: testid patterns for message containers
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
  const turns = findTurns()
  return turns.flatMap(({ el, role }) => {
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
  if (messages.length < 2) return

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

  await saveTranscript({
    source: "chatgpt",
    title,
    messages,
    markdown,
    timestamp,
    url: window.location.href
  })
  showSaveToast()
}

// ─── Load memory for new chat (smart auto-retrieval only) ──────────────────

async function loadMemoryForNewChat(): Promise<void> {
  const all = await getAllTranscripts()
  const others = all.filter((t) => t.source !== "chatgpt")
  if (others.length === 0) return

  window.dispatchEvent(new CustomEvent("mindrelay:memory-loaded", {
    detail: JSON.stringify({ nonce: MM_NONCE, data: others })
  }))
}

// ─── Init ──────────────────────────────────────────────────────────────────

let saveTimer: ReturnType<typeof setTimeout> | null = null

window.addEventListener("beforeunload", captureAndSave)
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") captureAndSave()
})

// Watch DOM for new messages
const observer = new MutationObserver(() => {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(captureAndSave, 3_000)
})
observer.observe(document.body, { childList: true, subtree: true })

// URL polling — reliable in isolated world
let lastUrl = location.href
setInterval(() => {
  if (location.href === lastUrl) return
  lastUrl = location.href
  const path = location.pathname
  if (path === "/" || path === "") loadMemoryForNewChat()
}, 300)

// New Chat button click — confirmed selector from earlier DOM inspection
document.addEventListener("click", (e) => {
  const target = (e.target as Element).closest('[data-testid="create-new-chat-button"]')
  if (target) setTimeout(loadMemoryForNewChat, 150)
}, true)

// Direct page load on /
if (location.pathname === "/" || location.pathname === "") {
  setTimeout(loadMemoryForNewChat, 500)
}

// Inject from popup — user clicked Inject on a specific memory
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (sender.id !== chrome.runtime.id) return
  if (msg.type === "mindrelay:inject" && typeof msg.context === "string" && msg.context.length <= 100_000) {
    window.dispatchEvent(new CustomEvent("mindrelay:context", { detail: JSON.stringify({ nonce: MM_NONCE, context: msg.context }) }))
    log("[MindRelay] injected from popup")
  }
})

log("[MindRelay] ChatGPT script loaded:", window.location.href)
