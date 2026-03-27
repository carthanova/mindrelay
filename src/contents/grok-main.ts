import type { PlasmoCSConfig } from "plasmo"
import { buildCombinedContext, rankTranscripts } from "../lib/relevance"
import type { Transcript } from "../lib/storage"
import { log, warn } from "../lib/log"

// Runs in the PAGE's main world — can override window.fetch.
// Cannot use chrome.storage. Receives context from grok.ts (isolated world)
// via CustomEvents dispatched on window.
//
// Grok's API (grok.com): POST /rest/app-chat/conversations/{id}/responses
// Request body: { "message": "...", "conversationId": "...", ... }
// Injection prepends context into body.message.
//
// NOTE: Grok may change its API format without notice. Selectors and endpoint
// patterns here are best-effort and may need updating.
export const config: PlasmoCSConfig = {
  matches: ["https://grok.com/*", "https://x.com/i/grok*"],
  run_at: "document_start",
  world: "MAIN"
}

let allTranscripts: Transcript[] = []
let pendingContext: string | null = null
let contextInjected = false
let trustedNonce: string | null = null

window.addEventListener("memorymesh:memory-loaded", (e: Event) => {
  const detail = (e as CustomEvent<string>).detail
  try {
    const parsed = JSON.parse(detail) as { nonce: string; data: Transcript[] }
    if (!parsed.nonce || !Array.isArray(parsed.data)) return
    if (!trustedNonce) trustedNonce = parsed.nonce
    else if (parsed.nonce !== trustedNonce) { warn("[MemoryMesh] Grok: nonce mismatch — ignored"); return }
    allTranscripts = parsed.data
    contextInjected = false
    log("[MemoryMesh] Grok: loaded", allTranscripts.length, "transcripts")
  } catch (err) {
    warn("[MemoryMesh] Grok: failed to parse memory-loaded event:", err)
  }
})

window.addEventListener("memorymesh:context", (e: Event) => {
  const detail = (e as CustomEvent<string>).detail
  try {
    const parsed = JSON.parse(detail) as { nonce: string; context: string }
    if (!parsed.nonce || !parsed.context) return
    if (!trustedNonce || parsed.nonce !== trustedNonce) { warn("[MemoryMesh] Grok: context nonce mismatch — ignored"); return }
    pendingContext = parsed.context
    contextInjected = false
    log("[MemoryMesh] Grok: manual context ready")
  } catch {
    warn("[MemoryMesh] Grok: failed to parse context event")
  }
})

// Override pushState so isolated world knows about new chats instantly
const _pushState = history.pushState.bind(history)
history.pushState = function (...args: Parameters<typeof history.pushState>) {
  _pushState(...args)
  // grok.com root = new conversation
  if (location.pathname === "/" || location.pathname === "") {
    pendingContext = null
    contextInjected = false
    // Keep allTranscripts — avoids race where user sends before async reload completes
    window.dispatchEvent(new CustomEvent("memorymesh:grok-new-chat"))
  }
}

// ─── Fetch intercept ──────────────────────────────────────────────────────────
// Grok API endpoint: /rest/app-chat/conversations/{id}/responses
// Body JSON: { "message": "user text", "conversationId": "...", ... }

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

  const isGrokApi =
    url.includes("/rest/app-chat/conversations") ||
    url.includes("/2/grok/add_response")

  if (!contextInjected && isGrokApi && init?.body && typeof init.body === "string") {
    try {
      const body = JSON.parse(init.body) as Record<string, unknown>

      // Determine context to inject
      let context: string | null = null
      if (pendingContext) {
        context = pendingContext
      } else if (allTranscripts.length > 0) {
        // Extract user query for smart ranking
        const userQuery =
          typeof body.message === "string" ? body.message : ""
        if (userQuery) {
          const ranked = rankTranscripts(userQuery, allTranscripts, 3)
          if (ranked.length > 0) {
            context = buildCombinedContext(ranked)
            log("[MemoryMesh] Grok: smart retrieval matched", ranked.length, "transcripts")
          }
        }
      }

      if (context) {
        // Primary format: body.message is a string
        if (typeof body.message === "string" && body.message.length > 0) {
          body.message = `${context}\n\n---\n\n${body.message}`
          contextInjected = true
          init = { ...init, body: JSON.stringify(body) }
          log("[MemoryMesh] Grok: context injected into body.message")
        } else {
          // Alternate format: body.responses[0] or body.query
          const alt =
            (Array.isArray(body.responses) && typeof body.responses[0] === "string")
              ? "responses"
              : typeof body.query === "string"
                ? "query"
                : null

          if (alt === "responses") {
            ;(body.responses as string[])[0] = `${context}\n\n---\n\n${(body.responses as string[])[0]}`
            contextInjected = true
            init = { ...init, body: JSON.stringify(body) }
            log("[MemoryMesh] Grok: context injected into body.responses[0]")
          } else if (alt === "query") {
            body.query = `${context}\n\n---\n\n${body.query as string}`
            contextInjected = true
            init = { ...init, body: JSON.stringify(body) }
            log("[MemoryMesh] Grok: context injected into body.query")
          } else {
            warn("[MemoryMesh] Grok: unexpected body structure, skipping injection:", Object.keys(body))
          }
        }
      }
    } catch (err) {
      warn("[MemoryMesh] Grok fetch intercept error:", err)
    }
  }

  return originalFetch(input, init)
}

log("[MemoryMesh] Grok fetch interceptor active (main world)")
