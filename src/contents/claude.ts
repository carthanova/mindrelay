import type { PlasmoCSConfig } from "plasmo"
import { buildMarkdown, getAllTranscripts, saveTranscript, type Message } from "../lib/storage"
import { showSaveToast } from "../lib/toast"
import { log, warn } from "../lib/log"

export const config: PlasmoCSConfig = {
  matches: ["https://claude.ai/*"],
  run_at: "document_idle"
}

// Shared secret for isolated→main world event authentication
const MM_NONCE = Array.from(crypto.getRandomValues(new Uint8Array(16)))
  .map((b) => b.toString(16).padStart(2, "0")).join("")

let lastSavedHash = ""
let saveTimer: ReturnType<typeof setTimeout> | null = null

function findUserEls(): Element[] {
  // P1 — confirmed working selector
  const p1 = Array.from(document.querySelectorAll('[data-testid="user-message"]'))
  if (p1.length > 0) return p1

  // P2 — fallback: any element whose testid contains "human" or "user-turn"
  const p2 = Array.from(document.querySelectorAll('[data-testid*="human-turn"], [data-testid*="user-turn"]'))
  if (p2.length > 0) { warn("[MindRelay] Claude user selector: using fallback P2"); return p2 }

  // P3 — last resort: elements with an explicit user role attribute
  const p3 = Array.from(document.querySelectorAll('[data-message-author-role="human"], [data-message-author-role="user"]'))
  if (p3.length > 0) { warn("[MindRelay] Claude user selector: using fallback P3"); return p3 }

  return []
}

function findAiEls(): Element[] {
  // P1 — retry button → .group parent (confirmed working)
  const retryBtns = Array.from(document.querySelectorAll('[data-testid="action-bar-retry"]'))
  if (retryBtns.length > 0) {
    const els = retryBtns
      .map((btn) => btn.closest(".group"))
      .filter((el): el is Element => el !== null)
      .filter((el, i, arr) => arr.indexOf(el) === i)
    if (els.length > 0) return els
  }

  // P2 — fallback: .group elements that directly follow a user message (no retry dependency)
  const p2 = Array.from(document.querySelectorAll(".group"))
    .filter((el) => !el.querySelector('[data-testid="user-message"]') && el.textContent!.trim().length > 10)
  if (p2.length > 0) { warn("[MindRelay] Claude AI selector: using fallback P2"); return p2 }

  // P3 — last resort: any element whose testid suggests an assistant response
  const p3 = Array.from(document.querySelectorAll('[data-testid*="assistant"], [data-testid*="response-"]'))
  if (p3.length > 0) { warn("[MindRelay] Claude AI selector: using fallback P3"); return p3 }

  return []
}

function extractMessages(): Message[] {
  const messages: Message[] = []

  const userEls = findUserEls()
  const aiEls = findAiEls()

  if (userEls.length === 0 && aiEls.length === 0) {
    log("[MindRelay] no user or AI elements found")
    return []
  }

  // Sort all turns by DOM order
  const allTurns = [...userEls, ...aiEls].sort((a, b) =>
    a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
  )

  for (const el of allTurns) {
    const isUser = el.getAttribute("data-testid") === "user-message"

    let text: string

    if (isUser) {
      text = el.textContent?.trim() ?? ""
    } else {
      // AI turn: exclude the action bar (4 levels up from retry button)
      const retryBtn = el.querySelector('[data-testid="action-bar-retry"]')
      let actionBar: Element | null = retryBtn
      for (let i = 0; i < 4; i++) {
        actionBar = actionBar?.parentElement ?? null
      }

      const clone = el.cloneNode(true) as Element
      if (actionBar) {
        // Find the matching node in the clone and remove it
        const retryInClone = clone.querySelector('[data-testid="action-bar-retry"]')
        let actionBarInClone: Element | null = retryInClone
        for (let i = 0; i < 4; i++) {
          actionBarInClone = actionBarInClone?.parentElement ?? null
        }
        actionBarInClone?.remove()
      }

      // Also strip "Thought for Xs" thinking indicators
      clone.querySelectorAll('[class*="thinking"], [class*="Thinking"]').forEach((n) => n.remove())
      text = clone.textContent?.trim() ?? ""

      // Remove "Thought for Xs" prefix if still present
      text = text.replace(/^Thought for \d+s\s*/i, "").trim()
    }

    if (text.length > 2) {
      messages.push({ role: isUser ? "user" : "assistant", content: text })
    }
  }

  log("[MindRelay] extracted messages:", messages.length)
  return messages
}

function getTitleFromMessages(messages: Message[]): string {
  const firstUser = messages.find((m) => m.role === "user")
  if (!firstUser) return document.title || "Claude conversation"
  const text = firstUser.content.slice(0, 60)
  return text.length < firstUser.content.length ? `${text}...` : text
}

function hashMessages(messages: Message[]): string {
  return messages.map((m) => m.content.slice(0, 50)).join("|")
}

async function captureAndSave(): Promise<void> {
  let messages = extractMessages()
  if (messages.length < 2) return

  // Strip injected MemoryMesh context from the first user message so we
  // never save the context header as if it were real conversation content.
  if (messages[0]?.role === "user" && messages[0].content.startsWith("[MindRelay")) {
    const separatorIndex = messages[0].content.indexOf("---\n\n")
    if (separatorIndex !== -1) {
      const cleaned = messages[0].content.slice(separatorIndex + 5).trim()
      messages = [{ role: "user", content: cleaned }, ...messages.slice(1)]
    } else {
      // Entire first message is just the header — skip saving this turn
      messages = messages.slice(1)
    }
    if (messages.length < 2) return
  }

  const hash = hashMessages(messages)
  if (hash === lastSavedHash) return
  lastSavedHash = hash

  const title = getTitleFromMessages(messages)
  const timestamp = Date.now()
  const markdown = buildMarkdown("Claude", title, messages, timestamp)

  await saveTranscript({
    source: "claude",
    title,
    messages,
    markdown,
    timestamp,
    url: window.location.href
  })

  showSaveToast()
  log("[MindRelay] saved:", title)
}

// ─── Load memory for new chat (smart auto-retrieval only) ─────────────────

async function loadMemoryForNewChat(): Promise<void> {
  const all = await getAllTranscripts()
  const others = all.filter((t) => t.source !== "claude")
  if (others.length === 0) return

  window.dispatchEvent(new CustomEvent("mindrelay:memory-loaded", {
    detail: JSON.stringify({ nonce: MM_NONCE, data: others })
  }))
}

// URL polling — reliable in isolated world; pushState override only works in main world
let lastUrl = location.href
setInterval(() => {
  if (location.href === lastUrl) return
  lastUrl = location.href
  if (location.pathname === "/new" || location.pathname.startsWith("/new/")) {
    loadMemoryForNewChat()
  }
}, 300)

// New Chat button click — Claude links to /new
document.addEventListener("click", (e) => {
  const target = (e.target as Element).closest('a[href="/new"]')
  if (target) setTimeout(loadMemoryForNewChat, 150)
}, true)

// Direct page load on /new
if (location.pathname === "/new" || location.pathname.startsWith("/new/")) {
  setTimeout(loadMemoryForNewChat, 500)
}

// ─── Save ──────────────────────────────────────────────────────────────────

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
// Inject from popup — user clicked Inject on a specific memory
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (sender.id !== chrome.runtime.id) return
  if (msg.type === "mindrelay:inject" && typeof msg.context === "string" && msg.context.length <= 100_000) {
    window.dispatchEvent(new CustomEvent("mindrelay:context", { detail: JSON.stringify({ nonce: MM_NONCE, context: msg.context }) }))
    log("[MindRelay] injected from popup")
  }
})

log("[MindRelay] Claude script loaded:", window.location.href)
