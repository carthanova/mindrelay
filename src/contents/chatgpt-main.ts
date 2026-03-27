import type { PlasmoCSConfig } from "plasmo"
import { rankTranscripts, buildCombinedContext } from "../lib/relevance"
import type { Transcript } from "../lib/storage"
import { log, warn } from "../lib/log"

// Runs in the PAGE's main world — can override window.fetch.
// Cannot use chrome.storage. Receives context from chatgpt.ts (isolated world)
// via CustomEvents dispatched on window.
export const config: PlasmoCSConfig = {
  matches: ["https://chatgpt.com/*"],
  run_at: "document_start",
  world: "MAIN"
}

let allTranscripts: Transcript[] = []
let pendingContext: string | null = null // manual inject from library — takes priority
let contextInjected = false
let trustedNonce: string | null = null

window.addEventListener("memorymesh:memory-loaded", (e: Event) => {
  const detail = (e as CustomEvent<string>).detail
  try {
    const parsed = JSON.parse(detail) as { nonce: string; data: Transcript[] }
    if (!parsed.nonce || !Array.isArray(parsed.data)) return
    if (!trustedNonce) trustedNonce = parsed.nonce
    else if (parsed.nonce !== trustedNonce) { warn("[MemoryMesh] memory-loaded nonce mismatch — ignored"); return }
    allTranscripts = parsed.data
    contextInjected = false
    log("[MemoryMesh] loaded", allTranscripts.length, "transcripts for smart retrieval")
  } catch (err) {
    warn("[MemoryMesh] failed to parse memory-loaded event:", err)
  }
})

window.addEventListener("memorymesh:context", (e: Event) => {
  const detail = (e as CustomEvent<string>).detail
  try {
    const parsed = JSON.parse(detail) as { nonce: string; context: string }
    if (!parsed.nonce || !parsed.context) return
    if (!trustedNonce || parsed.nonce !== trustedNonce) { warn("[MemoryMesh] context nonce mismatch — ignored"); return }
    pendingContext = parsed.context
    contextInjected = false
    log("[MemoryMesh] manual context ready for injection into ChatGPT")
  } catch {
    warn("[MemoryMesh] failed to parse context event")
  }
})

// Reset injection state on SPA navigation to new chat
const _pushState = history.pushState.bind(history)
history.pushState = function (...args: Parameters<typeof history.pushState>) {
  _pushState(...args)
  if (location.pathname === "/" || location.pathname === "") {
    pendingContext = null
    contextInjected = false
    // Keep allTranscripts — avoids race where user sends before async reload completes
  }
}

// Override fetch in the page's main world
const originalFetch = window.fetch.bind(window)
window.fetch = async function (
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : (input as Request).url

  if (
    !contextInjected &&
    (url.includes("/backend-api/conversation") || url.includes("/backend-api/f/conversation")) &&
    init?.body
  ) {
    try {
      const body = JSON.parse(init.body as string)
      const firstMsg = body?.messages?.[0]
      if (
        firstMsg?.content?.parts?.[0] != null &&
        typeof firstMsg.content.parts[0] === "string"
      ) {
        let context: string | null = null

        if (pendingContext) {
          // Manual library inject takes priority
          context = pendingContext
          log("[MemoryMesh] using manual inject context")
        } else if (allTranscripts.length > 0) {
          // Smart retrieval: rank transcripts against this message
          const userQuery = firstMsg.content.parts[0]
          const ranked = rankTranscripts(userQuery, allTranscripts, 3)
          if (ranked.length > 0) {
            context = buildCombinedContext(ranked)
            log("[MemoryMesh] smart retrieval matched", ranked.length, "transcripts")
          }
        }

        if (context) {
          firstMsg.content.parts[0] = `${context}\n\n---\n\n${firstMsg.content.parts[0]}`
          contextInjected = true
          init = { ...init, body: JSON.stringify(body) }
          log("[MemoryMesh] context injected into ChatGPT request")
        }
      }
    } catch (e) {
      warn("[MemoryMesh] fetch intercept error:", e)
    }
  }

  return originalFetch(input, init)
}

log("[MemoryMesh] ChatGPT fetch interceptor active (main world)")
