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
  matches: ["https://gemini.google.com/*"],
  run_at: "document_idle"
}

const MM_NONCE = Array.from(crypto.getRandomValues(new Uint8Array(16)))
  .map((b) => b.toString(16).padStart(2, "0")).join("")

let lastSavedHash = ""
let saveTimer: ReturnType<typeof setTimeout> | null = null

// ─── Capture ────────────────────────────────────────────────────────────────

function findUserEls(): Element[] {
  // P1 — custom element user-query (confirmed working)
  const p1 = Array.from(document.querySelectorAll("user-query"))
  if (p1.length > 0) return p1

  // P2 — fallback: role or testid attributes suggesting user turn
  const p2 = Array.from(document.querySelectorAll(
    '[data-testid*="user-query"], [data-testid*="human-turn"], [class*="user-query"]'
  ))
  if (p2.length > 0) { warn("[MindRelay] Gemini user selector: using fallback P2"); return p2 }

  // P3 — last resort: aria role="region" labelled as user input
  const p3 = Array.from(document.querySelectorAll('[aria-label*="You"], [aria-label*="user"]'))
  if (p3.length > 0) { warn("[MindRelay] Gemini user selector: using fallback P3"); return p3 }

  return []
}

function findAiEls(): Element[] {
  // P1 — custom element model-response (confirmed working)
  const p1 = Array.from(document.querySelectorAll("model-response"))
  if (p1.length > 0) return p1

  // P2 — fallback: testid or class patterns for model response
  const p2 = Array.from(document.querySelectorAll(
    '[data-testid*="model-response"], [data-testid*="assistant-turn"], [class*="model-response"]'
  ))
  if (p2.length > 0) { warn("[MindRelay] Gemini AI selector: using fallback P2"); return p2 }

  // P3 — last resort: aria labels for Gemini responses
  const p3 = Array.from(document.querySelectorAll('[aria-label*="Gemini"], [aria-label*="response"]'))
  if (p3.length > 0) { warn("[MindRelay] Gemini AI selector: using fallback P3"); return p3 }

  return []
}

function extractTextFromUserEl(el: Element): string {
  // user-query-content is the inner element with clean text
  const inner = el.querySelector("user-query-content")
  let text = (inner ?? el).textContent?.trim() ?? ""
  return text.replace(/^You said[:\s]*/i, "").trim()
}

function extractTextFromAiEl(el: Element): string {
  // message-content holds the actual response text
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
    if (text.length >= 2) {
      messages.push({ role: isUser ? "user" : "assistant", content: text })
    }
  }
  return messages
}

function getTitleFromMessages(messages: Message[]): string {
  const pageTitle = document.title
    .replace(/\s*[-|–]\s*Gemini\s*$/i, "")
    .replace(/\s*[-|–]\s*Google DeepMind\s*$/i, "")
    .trim()
  if (pageTitle && !/^gemini$/i.test(pageTitle)) return pageTitle

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
    if (messages.length < 2) return

    if (messages[0]?.role === "user" && messages[0].content.startsWith("[MindRelay")) {
      let cleaned: string | null = null
      for (const marker of ["[End of retrieved memory.]", "[End of context.]"]) {
        const idx = messages[0].content.indexOf(marker)
        if (idx !== -1) { cleaned = messages[0].content.slice(idx + marker.length).trim(); break }
      }
      messages = cleaned
        ? [{ role: "user", content: cleaned }, ...messages.slice(1)]
        : messages.slice(1)
      if (messages.length < 2) return
    }

    const hash = hashMessages(messages)
    if (hash === lastSavedHash) return
    lastSavedHash = hash

    const title = getTitleFromMessages(messages)
    const timestamp = Date.now()
    const markdown = buildMarkdown("Gemini", title, messages, timestamp)

    await saveTranscript({
      source: "gemini",
      title,
      messages,
      markdown,
      timestamp,
      url: window.location.href
    })

    showSaveToast()
    log("[MindRelay] Gemini saved:", title)
  } catch (err) {
    console.error("[MindRelay] Gemini captureAndSave error:", err)
  }
}

// ─── Load memory for new chat (smart auto-retrieval only) ───────────────────

async function loadMemoryForNewChat(): Promise<void> {
  const all = await getAllTranscripts()
  const others = all.filter((t) => t.source !== "gemini")
  if (others.length === 0) return

  window.dispatchEvent(new CustomEvent("mindrelay:memory-loaded", {
    detail: JSON.stringify({ nonce: MM_NONCE, data: others })
  }))
}

// Inject from popup
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (sender.id !== chrome.runtime.id) return
  if (msg.type === "mindrelay:inject" && typeof msg.context === "string" && msg.context.length <= 100_000) {
    window.dispatchEvent(new CustomEvent("mindrelay:context", { detail: JSON.stringify({ nonce: MM_NONCE, context: msg.context }) }))
    log("[MindRelay] injected from popup into Gemini")
  }
})

// ─── Init ───────────────────────────────────────────────────────────────────

window.addEventListener("beforeunload", captureAndSave)
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") captureAndSave()
})

const observer = new MutationObserver(() => {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(captureAndSave, 3_000)
})
observer.observe(document.body, { childList: true, subtree: true })

// Main world detects pushState to /app instantly and notifies us
window.addEventListener("mindrelay:gemini-new-chat", () => {
  setTimeout(loadMemoryForNewChat, 300)
})

// URL polling — fallback for cases pushState doesn't fire (e.g. direct load)
let lastUrl = location.href
setInterval(() => {
  if (location.href === lastUrl) return
  lastUrl = location.href
  if (location.pathname === "/app" || location.pathname === "/app/") {
    setTimeout(loadMemoryForNewChat, 300)
  }
}, 300)

// Direct page load on /app
if (location.pathname === "/app" || location.pathname === "/app/") {
  setTimeout(loadMemoryForNewChat, 800)
}

log("[MindRelay] Gemini script loaded:", window.location.href)
