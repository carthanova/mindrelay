export interface Message {
  role: "user" | "assistant"
  content: string
}

export interface Transcript {
  id: string
  source: "claude" | "chatgpt" | "gemini" | "grok" | "obsidian"
  title: string
  messages: Message[]
  markdown: string
  timestamp: number
  url: string
}

// ─── Background message bridge ───────────────────────────────────────────────
// All storage operations are routed through the background service worker so
// that content scripts (web page origin) and extension pages (extension origin)
// share the same IndexedDB instance.

function send<T>(msg: Record<string, unknown>): Promise<T> {
  return chrome.runtime.sendMessage(msg) as Promise<T>
}

// ─── Public API ──────────────────────────────────────────────────────────────

export async function getAllTranscripts(): Promise<Transcript[]> {
  return send<Transcript[]>({ type: "DB_GET_ALL" })
}

export async function getLatestTranscript(): Promise<Transcript | null> {
  const all = await getAllTranscripts()
  return all?.[0] ?? null
}

export async function saveTranscript(data: Omit<Transcript, "id">): Promise<boolean> {
  const existing = data.url
    ? await send<Transcript | null>({ type: "DB_FIND_BY_URL", url: data.url })
    : null

  const id = existing ? existing.id : `${data.source}_${Date.now()}`
  const result = await send<{ ok: boolean; hostSaved: boolean; id?: string } | null>({
    type: "DB_PUT",
    data: { ...data, id }
  })

  // Return true when IndexedDB confirmed the save (ok: true).
  // hostSaved tells callers whether the durable vault also confirmed —
  // false when the native host is not installed, which is acceptable.
  return result?.ok === true
}

export async function deleteTranscript(id: string): Promise<void> {
  await send({ type: "DB_DELETE", id })
}

export async function clearBySource(source: Transcript["source"]): Promise<void> {
  await send({ type: "DB_DELETE_BY_SOURCE", source })
}

export async function clearAllTranscripts(): Promise<void> {
  await send({ type: "DB_CLEAR" })
}

// ─── Native host search bridge ───────────────────────────────────────────────

/**
 * Ask the native host to run an FTS5 BM25 relevance search against the vault.
 * Returns the matched transcripts (best first) or [] when the host is not
 * installed or returns no results.  Never throws.
 */
export interface HostStatus {
  available: boolean
  count: number
  warnThreshold: number
  maxTranscripts: number
}

export async function getHostStatus(): Promise<HostStatus> {
  try {
    const result = await send<HostStatus>({ type: "HOST_PING" })
    return result ?? { available: false, count: 0, warnThreshold: 150, maxTranscripts: 200 }
  } catch {
    return { available: false, count: 0, warnThreshold: 150, maxTranscripts: 200 }
  }
}

/** Transcript returned by the native host search, with an optional BM25 score. */
export type ScoredTranscript = Transcript & { _score?: number }

export async function searchTranscripts(
  query: string,
  sessionId: string,
  topK = 5
): Promise<ScoredTranscript[]> {
  try {
    const resp = await send<{ ok: boolean; results?: ScoredTranscript[] }>({
      type: "HOST_SEARCH",
      query,
      sessionId,
      topK
    })
    return resp?.results ?? []
  } catch {
    return []
  }
}

/**
 * Notify the native host that a conversation session has ended so it can
 * clear the deduplication state for that sessionId.  Fire-and-forget.
 */
export function endSession(sessionId: string): void {
  chrome.runtime.sendMessage({ type: "HOST_SESSION_END", sessionId }).catch(() => {})
}

// ─── Formatters (pure — no storage calls) ────────────────────────────────────

export function buildMarkdown(
  source: string,
  title: string,
  messages: Message[],
  timestamp: number
): string {
  const date = new Date(timestamp).toISOString().split("T")[0]
  const lines = [
    `---`,
    `date: ${date}`,
    `source: ${source}`,
    `---`,
    ``,
    `# ${title}`,
    ``
  ]
  for (const msg of messages) {
    const label = msg.role === "user" ? "**You:**" : "**Assistant:**"
    lines.push(label)
    lines.push(msg.content.trim())
    lines.push("")
  }
  return lines.join("\n")
}

export function buildContextSummary(transcript: Transcript): string {
  const date = new Date(transcript.timestamp).toLocaleString()
  const lines = transcript.messages.slice(0, 20).map((m) => {
    const isUser = m.role === "user"
    const label = isUser ? "User" : "Assistant"
    const limit = isUser ? 400 : 800
    const text = m.content.trim()
    const body = text.length > limit ? `${text.slice(0, limit)}...` : text
    return `${label}: ${body}`
  })
  return [
    `[MindRelay — context from ${transcript.source} | ${date}]`,
    `The user is continuing work from a previous AI session. Use this context immediately without asking them to re-explain. If they reference a project, idea, or topic — assume it is the one below. Pick up naturally from where they left off.`,
    `Topic: "${transcript.title}"`,
    ``,
    ...lines,
    ``,
    `[End of context.]`
  ].join("\n\n")
}
