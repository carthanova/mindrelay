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
  matches: ["https://grok.com/*", "https://x.com/i/grok*"],
  run_at: "document_idle"
}

const MM_NONCE = Array.from(crypto.getRandomValues(new Uint8Array(16)))
  .map((b) => b.toString(16).padStart(2, "0")).join("")

let lastSavedHash = ""
let saveTimer: ReturnType<typeof setTimeout> | null = null

// ─── Capture ─────────────────────────────────────────────────────────────────

// Grok uses pure Tailwind — no semantic class names or data-testid on message containers.
// Both user and AI turns use `.response-content-markdown` as their content wrapper.
// They appear interleaved in DOM order: user at even indices (0,2,4…), AI at odd (1,3,5…).
function allMessageEls(): Element[] {
  return Array.from(document.querySelectorAll(".response-content-markdown"))
}

function findUserEls(): Element[] {
  return allMessageEls().filter((_, i) => i % 2 === 0)
}

function findAiEls(): Element[] {
  return allMessageEls().filter((_, i) => i % 2 === 1)
}

// Strip MemoryMesh context prepended to the first user message so it doesn't
// pollute the saved transcript. Context is now appended after the user's
// message with a --- separator. The separator renders as <hr> in Grok's DOM
// (no textContent), so we strip everything from [MindRelay onward instead.
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
    if (text.length >= 2) {
      messages.push({ role: isUser ? "user" : "assistant", content: text })
    }
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
    if (messages.length < 2) return

    const hash = hashMessages(messages)
    if (hash === lastSavedHash) return
    lastSavedHash = hash

    const title = getTitleFromMessages(messages)
    const timestamp = Date.now()
    const markdown = buildMarkdown("Grok", title, messages, timestamp)

    await saveTranscript({
      source: "grok",
      title,
      messages,
      markdown,
      timestamp,
      url: window.location.href
    })

    showSaveToast()
    log("[MindRelay] Grok saved:", title)
  } catch (err) {
    console.error("[MindRelay] Grok captureAndSave error:", err)
  }
}

// ─── Load memory for new chat (smart auto-retrieval only) ─────────────────────

async function loadMemoryForNewChat(): Promise<void> {
  const all = await getAllTranscripts()
  const others = all.filter((t) => t.source !== "grok")
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
    log("[MindRelay] injected from popup into Grok")
  }
})

// ─── Init ─────────────────────────────────────────────────────────────────────

window.addEventListener("beforeunload", captureAndSave)
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") captureAndSave()
})

const observer = new MutationObserver(() => {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(captureAndSave, 3_000)
})
observer.observe(document.body, { childList: true, subtree: true })

// New chat detection via main world pushState override
window.addEventListener("mindrelay:grok-new-chat", () => {
  setTimeout(loadMemoryForNewChat, 300)
})

// URL polling fallback
let lastUrl = location.href
setInterval(() => {
  if (location.href === lastUrl) return
  lastUrl = location.href
  // grok.com root = new chat; x.com/i/grok is always same URL
  if (location.pathname === "/" || location.pathname === "/i/grok") {
    setTimeout(loadMemoryForNewChat, 400)
  }
}, 300)

// Direct page load on new chat
if (location.pathname === "/" || location.pathname === "/i/grok") {
  setTimeout(loadMemoryForNewChat, 600)
}

log("[MindRelay] Grok script loaded:", window.location.href)
