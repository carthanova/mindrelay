import type { PlasmoCSConfig } from "plasmo"
import { buildCombinedContext, rankTranscripts } from "../lib/relevance"
import type { Transcript } from "../lib/storage"
import { log, warn } from "../lib/log"

// Runs in the PAGE's main world — can override window.fetch.
// Cannot use chrome.storage. Receives context from gemini.ts (isolated world)
// via CustomEvents dispatched on window.
//
// NOTE: Gemini uses protobuf-encoded requests, not plain JSON.
// Injection intercepts the StreamGenerate endpoint and attempts to prepend
// context into the detected text field. This is best-effort — Gemini may
// change its request format without notice.
export const config: PlasmoCSConfig = {
  matches: ["https://gemini.google.com/*"],
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
    else if (parsed.nonce !== trustedNonce) { warn("[MemoryMesh] Gemini: nonce mismatch — ignored"); return }
    allTranscripts = parsed.data
    contextInjected = false
    log("[MemoryMesh] Gemini: loaded", allTranscripts.length, "transcripts")
  } catch (err) {
    warn("[MemoryMesh] Gemini: failed to parse memory-loaded event:", err)
  }
})

window.addEventListener("memorymesh:context", (e: Event) => {
  const detail = (e as CustomEvent<string>).detail
  try {
    const parsed = JSON.parse(detail) as { nonce: string; context: string }
    if (!parsed.nonce || !parsed.context) return
    if (!trustedNonce || parsed.nonce !== trustedNonce) { warn("[MemoryMesh] Gemini: context nonce mismatch — ignored"); return }
    pendingContext = parsed.context
    contextInjected = false
    log("[MemoryMesh] Gemini: manual context ready")
  } catch {
    warn("[MemoryMesh] Gemini: failed to parse context event")
  }
})

const _pushState = history.pushState.bind(history)
history.pushState = function (...args: Parameters<typeof history.pushState>) {
  _pushState(...args)
  if (location.pathname === "/app" || location.pathname === "/app/") {
    pendingContext = null
    contextInjected = false
    // Keep allTranscripts — avoids race where user sends before async reload completes
    // Notify isolated world immediately — URL polling can miss this fast transition
    window.dispatchEvent(new CustomEvent("memorymesh:gemini-new-chat"))
  }
}

// ─── Fetch intercept ────────────────────────────────────────────────────────
// Gemini's API endpoint: /_/BardChatUi/data/.../StreamGenerate
// The request body is protobuf-encoded. We attempt to find the user's text
// in the raw body and prepend context before it. This works as long as the
// text appears as a UTF-8 string in the payload.

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

  const isGeminiApi =
    url.includes("/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate")

  if (!contextInjected && isGeminiApi && init?.body) {
    try {
      const rawBody = init.body as string

      // Determine context to inject
      let context: string | null = null
      if (pendingContext) {
        context = pendingContext
      } else if (allTranscripts.length > 0) {
        // Extract user query from body: outer[1] → inner[0][0]
        let userQuery = ""
        try {
          const outer = JSON.parse(rawBody) as [null, string, ...unknown[]]
          const inner = JSON.parse(outer[1]) as unknown[][]
          const msg = inner?.[0]?.[0]
          if (typeof msg === "string") userQuery = msg
        } catch {}
        if (userQuery) {
          const ranked = rankTranscripts(userQuery, allTranscripts, 3)
          if (ranked.length > 0) {
            context = buildCombinedContext(ranked)
            log("[MemoryMesh] Gemini: smart retrieval matched", ranked.length, "transcripts")
          }
        }
      }

      if (context) {
        try {
          // Request body format: [null, "[[\"user message\", 0, ...], [\"en\"], ...]"]
          // outer[1] is a JSON-encoded string; inner[0][0] is the user's message
          const outer = JSON.parse(rawBody) as [null, string, ...unknown[]]
          const inner = JSON.parse(outer[1]) as unknown[][]
          const userMsg = inner?.[0]?.[0]

          if (typeof userMsg === "string" && userMsg.length > 0) {
            inner[0][0] = `${context}\n\n---\n\n${userMsg}`;
            (outer as unknown[])[1] = JSON.stringify(inner)
            contextInjected = true
            init = { ...init, body: JSON.stringify(outer) }
            log("[MemoryMesh] Gemini: context injected into request")
          } else {
            warn("[MemoryMesh] Gemini: unexpected body structure, skipping injection")
          }
        } catch (err) {
          warn("[MemoryMesh] Gemini: injection failed:", err)
        }
      }
    } catch (e) {
      warn("[MemoryMesh] Gemini fetch intercept error:", e)
    }
  }

  return originalFetch(input, init)
}

log("[MemoryMesh] Gemini fetch interceptor active (main world)")
