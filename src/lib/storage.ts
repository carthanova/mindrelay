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

export async function saveTranscript(data: Omit<Transcript, "id">): Promise<void> {
  const existing = data.url
    ? await send<Transcript | null>({ type: "DB_FIND_BY_URL", url: data.url })
    : null

  if (existing) {
    await send({ type: "DB_PUT", data: { ...data, id: existing.id } })
  } else {
    await send({ type: "DB_PUT", data: { ...data, id: `${data.source}_${Date.now()}` } })
  }
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

export async function importTranscripts(incoming: Transcript[]): Promise<number> {
  const existing = await getAllTranscripts()
  const existingIds = new Set(existing.map((t) => t.id))
  const fresh = incoming.filter((t) => !existingIds.has(t.id))
  for (const t of fresh) {
    await send({ type: "DB_PUT", data: t })
  }
  return fresh.length
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
    `# ${title}`,
    `**Source:** ${source} | **Date:** ${date}`,
    `---`,
    ""
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
