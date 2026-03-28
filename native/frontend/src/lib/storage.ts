import { invoke } from "@tauri-apps/api/core"

export interface Message {
  role: "user" | "assistant"
  content: string
}

export interface Transcript {
  id: string
  source: "claude" | "chatgpt" | "gemini" | "grok" | "obsidian"
  title: string
  url: string
  timestamp: number
  messages: Message[]
  markdown: string
}

export function getAllTranscripts(): Promise<Transcript[]> {
  return invoke("get_all_transcripts")
}

export function deleteTranscript(id: string): Promise<void> {
  return invoke("delete_transcript", { id })
}

export function clearBySource(source: Transcript["source"]): Promise<void> {
  return invoke("delete_by_source", { source })
}

export function clearAllTranscripts(): Promise<void> {
  return invoke("clear_all")
}

export async function importTranscripts(incoming: Transcript[]): Promise<number> {
  const existing = await getAllTranscripts()
  const existingIds = new Set(existing.map((t) => t.id))
  const newOnes = incoming.filter((t) => !existingIds.has(t.id))
  for (const t of newOnes) {
    await invoke("put_transcript", { transcript: t })
  }
  return newOnes.length
}

export function buildMarkdown(
  source: string,
  title: string,
  messages: Message[],
  timestamp: number
): string {
  const date = new Date(timestamp).toISOString().split("T")[0]
  const lines = [
    `---`,
    `source: ${source}`,
    `title: ${title}`,
    `date: ${date}`,
    `---`,
    ``,
    `# ${title}`,
    ``
  ]
  for (const m of messages) {
    lines.push(`**${m.role === "user" ? "You" : "Assistant"}:**`)
    lines.push(m.content)
    lines.push(``)
  }
  return lines.join("\n")
}
