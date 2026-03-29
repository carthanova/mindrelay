// Bridge to the mindrelay-host native binary.
//
// Every outgoing message is stamped with:
//   requestId   — crypto.randomUUID() (collision-proof across SW restarts)
//   version     — 1 (protocol version)
//   timestamp   — Date.now() (for host-side log correlation)
//
// The host echoes requestId back so outstanding requests can be matched to
// their responses.
//
// Large GET_ALL responses are automatically delivered as a CHUNK_START →
// N × CHUNK_DATA → CHUNK_END sequence.  The reassembler below buffers the
// parts and resolves the caller's promise only after CHUNK_END arrives.

const HOST_NAME = "com.mindrelay.host"

// Raised from 5 s → 10 s to give chunked GET_ALL room.
// Callers that need more (e.g. a first-run sync of a very large vault) can
// pass an explicit timeoutMs to sendToHostAck.
const DEFAULT_TIMEOUT_MS = 10_000

export interface HostResponse {
  ok: boolean
  requestId?: string
  version?: number
  id?: string       // transcript ID echoed by a successful PUT
  data?: unknown    // GET_ALL → Transcript[];  FIND_BY_URL → Transcript | null
  error?: string
}

let port: chrome.runtime.Port | null = null

// Post-disconnect reconnect guard.  While set, getPort() will not attempt
// to call connect() — the timer fires and clears itself after 1 s.
let reconnectTimer: ReturnType<typeof setTimeout> | null = null

// After a synchronous connectNative failure (host not installed), block
// further attempts for 2 s to avoid hammering the browser.
let connectFailedUntil = 0

// requestId → { resolve, cleanup timer }
const pending = new Map<string, {
  resolve: (r: HostResponse) => void
  timer: ReturnType<typeof setTimeout>
}>()

// Chunk reassembly state.  An entry is created on CHUNK_START and removed
// on CHUNK_END (or on disconnect / timeout).
interface ChunkAccumulator {
  totalChunks: number
  chunks: Map<number, unknown[]>   // chunkIndex → data array
  received: number
}
const assembling = new Map<string, ChunkAccumulator>()

// ─── Connection management ───────────────────────────────────────────────────

function connect(): chrome.runtime.Port | null {
  if (Date.now() < connectFailedUntil) return null

  try {
    const p = chrome.runtime.connectNative(HOST_NAME)

    p.onMessage.addListener((raw: Record<string, unknown>) => {
      const rid = raw.requestId as string | undefined
      if (!rid) return

      // ── CHUNK_START ────────────────────────────────────────────────────────
      if (raw.type === "CHUNK_START") {
        assembling.set(rid, {
          totalChunks: (raw.totalChunks as number) ?? 0,
          chunks: new Map(),
          received: 0
        })
        return
      }

      // ── CHUNK_DATA ─────────────────────────────────────────────────────────
      if (raw.type === "CHUNK_DATA") {
        const acc = assembling.get(rid)
        if (!acc) return   // CHUNK_START was lost — discard orphan
        acc.chunks.set((raw.chunkIndex as number) ?? 0, raw.data as unknown[])
        acc.received++
        return
      }

      // ── CHUNK_END — reassemble and resolve ─────────────────────────────────
      if (raw.type === "CHUNK_END") {
        const acc = assembling.get(rid)
        assembling.delete(rid)

        const cb = pending.get(rid)
        if (!cb) return
        pending.delete(rid)
        clearTimeout(cb.timer)

        if (!raw.ok) {
          cb.resolve({ ok: false, error: (raw.error as string) ?? "chunk transfer failed" })
          return
        }
        if (acc && acc.received !== acc.totalChunks) {
          cb.resolve({
            ok: false,
            error: `chunk sequence incomplete: received ${acc.received}/${acc.totalChunks}`
          })
          return
        }
        const allData: unknown[] = []
        for (let i = 0; i < (acc?.totalChunks ?? 0); i++) {
          const chunk = acc?.chunks.get(i)
          if (chunk) allData.push(...chunk)
        }
        cb.resolve({ ok: true, requestId: rid, version: raw.version as number, data: allData })
        return
      }

      // ── Normal (non-chunked) response ──────────────────────────────────────
      const cb = pending.get(rid)
      if (!cb) return
      pending.delete(rid)
      clearTimeout(cb.timer)
      cb.resolve(raw as unknown as HostResponse)
    })

    p.onDisconnect.addListener(() => {
      port = null

      // Resolve any in-progress chunk assemblies before draining pending,
      // so callers get a descriptive error rather than a generic one.
      for (const [rid] of assembling) {
        const cb = pending.get(rid)
        if (cb) {
          clearTimeout(cb.timer)
          cb.resolve({ ok: false, error: "host disconnected mid-chunk" })
          pending.delete(rid)
        }
      }
      assembling.clear()

      // Drain remaining non-chunked in-flight requests.
      for (const [, cb] of pending) {
        clearTimeout(cb.timer)
        cb.resolve({ ok: false, error: "host disconnected" })
      }
      pending.clear()

      // Back off 1 s before the next connect attempt.
      reconnectTimer = setTimeout(() => { reconnectTimer = null }, 1_000)
    })

    return p
  } catch {
    // connectNative threw synchronously — host binary not installed / not registered.
    connectFailedUntil = Date.now() + 2_000
    return null
  }
}

function getPort(): chrome.runtime.Port | null {
  // Don't attempt a new connection while a post-disconnect cooldown is active.
  if (!port && !reconnectTimer) port = connect()
  return port
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Send a message and wait for the host's acknowledgement.
 *
 * Always resolves — never rejects.  Returns { ok: false } when:
 *   • the native host is not installed
 *   • the message cannot be sent (port closed)
 *   • no response arrives within timeoutMs
 *   • the connection drops before a response arrives
 *
 * @param timeoutMs  Override the default (10 s).  Pass a larger value for
 *                   operations that stream back many chunks (e.g. GET_ALL over
 *                   a large vault).
 */
export function sendToHostAck(
  message: Record<string, unknown>,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<HostResponse> {
  const p = getPort()
  if (!p) return Promise.resolve({ ok: false, error: "host not available" })

  const requestId = crypto.randomUUID()

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(requestId)
      assembling.delete(requestId)   // also clean up any partial chunk buffer
      resolve({ ok: false, error: "host timeout" })
    }, timeoutMs)

    pending.set(requestId, { resolve, timer })

    try {
      p.postMessage({ ...message, requestId, version: 1, timestamp: Date.now() })
    } catch {
      pending.delete(requestId)
      assembling.delete(requestId)
      clearTimeout(timer)
      port = null
      resolve({ ok: false, error: "send failed" })
    }
  })
}

/**
 * Fire-and-forget for operations that do not need confirmation
 * (DELETE, DELETE_BY_SOURCE, CLEAR — IndexedDB is authoritative for those).
 */
export function sendToHost(message: Record<string, unknown>): void {
  const p = getPort()
  if (!p) return
  try {
    p.postMessage({ ...message, version: 1, timestamp: Date.now() })
  } catch {
    port = null
  }
}
