import "./library.css"
import { useEffect, useMemo, useState } from "react"
import {
  buildContextSummary,
  clearAllTranscripts,
  clearBySource,
  deleteTranscript,
  getAllTranscripts,
  importTranscripts,
  type Message,
  type Transcript
} from "../lib/storage"

// ─── MD import helpers ────────────────────────────────────────────────────────

function parseFrontmatter(content: string): { date: string | null } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n/)
  if (!match) return { date: null }
  const dateMatch = match[1].match(/date:\s*(.+)/)
  return { date: dateMatch ? dateMatch[1].trim() : null }
}

function extractH1(content: string, filename: string): string {
  const h1 = content.match(/^#\s+(.+)$/m)
  if (h1) return h1[1].trim()
  return filename
    .replace(/^conversation_/, "")
    .replace(/_\d{4}-\d{2}-\d{2}\.md$/, "")
    .replace(/\.md$/, "")
    .replace(/_/g, " ")
}

function mdToTranscript(filename: string, content: string): Transcript {
  const { date } = parseFrontmatter(content)
  const title = extractH1(content, filename)
  const body = content.replace(/^---\n[\s\S]*?\n---\n/, "").trim()
  const timestamp = date ? new Date(date).getTime() : Date.now()
  const messages: Message[] = [{ role: "assistant", content: body }]
  return {
    id: `obsidian_${filename.replace(/\.md$/, "")}`,
    source: "obsidian",
    title,
    messages,
    markdown: content,
    timestamp,
    url: filename
  }
}

// ─── Security helpers ─────────────────────────────────────────────────────────

const ALLOWED_ORIGINS = /^https:\/\/(claude\.ai|chatgpt\.com|gemini\.google\.com|grok\.com|x\.com)\//

function isSafeUrl(url: unknown): url is string {
  return typeof url === "string" && ALLOWED_ORIGINS.test(url)
}

const VALID_SOURCES = new Set(["claude", "chatgpt", "gemini", "grok", "obsidian"])
const MAX_FIELD_LEN = 100_000

function validateTranscript(obj: unknown): obj is Transcript {
  if (!obj || typeof obj !== "object") return false
  const t = obj as Record<string, unknown>
  return (
    typeof t.id === "string" && t.id.length <= 200 &&
    typeof t.source === "string" && VALID_SOURCES.has(t.source) &&
    typeof t.title === "string" && t.title.length <= 500 &&
    typeof t.timestamp === "number" && isFinite(t.timestamp) &&
    Array.isArray(t.messages) && t.messages.length <= 500 &&
    (t.messages as unknown[]).every(
      (m) => m && typeof m === "object" &&
        ((m as Record<string, unknown>).role === "user" || (m as Record<string, unknown>).role === "assistant") &&
        typeof (m as Record<string, unknown>).content === "string" &&
        ((m as Record<string, unknown>).content as string).length <= MAX_FIELD_LEN
    )
  )
}

// ─── Constants ────────────────────────────────────────────────────────────────

const SOURCE_COLORS: Record<string, string> = {
  claude: "#cc785c",
  chatgpt: "#10a37f",
  gemini: "#4285f4",
  grok: "#ff6250",
  obsidian: "#7c6af7"
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric"
  })
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit"
  })
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function LibraryPage() {
  const [transcripts, setTranscripts] = useState<Transcript[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState("")
  const [sourceFilter, setSourceFilter] = useState("all")
  const [selected, setSelected] = useState<Transcript | null>(null)
  const [injectStatus, setInjectStatus] = useState<string | null>(null)
  const [isDragOver, setIsDragOver] = useState(false)

  useEffect(() => {
    getAllTranscripts().then((data) => {
      setTranscripts(data)
      setLoading(false)
    })
  }, [])

  const storageInfo = useMemo(() => {
    if (transcripts.length === 0) return "0 KB"
    const bytes = new TextEncoder().encode(JSON.stringify(transcripts)).length
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
  }, [transcripts])

  function showStatus(msg: string) {
    setInjectStatus(msg)
    setTimeout(() => setInjectStatus(null), 2500)
  }

  const presentSources = [...new Set(transcripts.map((t) => t.source))]

  const filtered = transcripts.filter((t) => {
    const matchSource = sourceFilter === "all" || t.source === sourceFilter
    const matchSearch =
      !search.trim() ||
      t.title.toLowerCase().includes(search.toLowerCase()) ||
      t.messages.some((m) => m.content.toLowerCase().includes(search.toLowerCase()))
    return matchSource && matchSearch
  })

  async function handleInject(t: Transcript) {
    const context = buildContextSummary(t)
    const tabs = await chrome.tabs.query({
      url: ["https://claude.ai/*", "https://chatgpt.com/*", "https://gemini.google.com/*", "https://grok.com/*"]
    })
    const aiTab = tabs.find((tab) => tab.url != null)
    if (!aiTab?.id) {
      showStatus("No Claude, ChatGPT, or Gemini tab found")
      return
    }
    try {
      await chrome.tabs.sendMessage(aiTab.id, { type: "mindrelay:inject", context })
      await chrome.tabs.update(aiTab.id, { active: true })
      const name = aiTab.url?.includes("claude.ai")
        ? "Claude"
        : aiTab.url?.includes("chatgpt.com")
          ? "ChatGPT"
          : "Gemini"
      showStatus(`Injected into ${name}`)
    } catch {
      showStatus("Injection failed — reload the AI tab")
    }
  }

  async function handleDelete(id: string) {
    if (!confirm("Delete this memory?")) return
    await deleteTranscript(id)
    setTranscripts((prev) => prev.filter((t) => t.id !== id))
    if (selected?.id === id) setSelected(null)
  }

  async function handleClearSource(source: string) {
    if (!confirm(`Clear all ${source} memories?`)) return
    await clearBySource(source as Transcript["source"])
    setTranscripts((prev) => prev.filter((t) => t.source !== source))
    if (selected?.source === source) setSelected(null)
    if (sourceFilter === source) setSourceFilter("all")
  }

  async function handleClearAll() {
    if (!confirm("Clear ALL saved memory? This cannot be undone.")) return
    await clearAllTranscripts()
    setTranscripts([])
    setSelected(null)
    setSourceFilter("all")
  }

  function handleExport() {
    const blob = new Blob([JSON.stringify(transcripts, null, 2)], { type: "application/json" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `mindrelay-backup-${new Date().toISOString().split("T")[0]}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  async function processFiles(files: File[]) {
    try {
      const incoming: Transcript[] = []
      for (const file of files) {
        const text = await file.text()
        if (file.name.endsWith(".json")) {
          const data = JSON.parse(text)
          if (!Array.isArray(data)) throw new Error("Invalid JSON")
          const valid = (data as unknown[]).filter(validateTranscript)
          if (valid.length === 0 && data.length > 0) throw new Error("No valid transcripts found")
          incoming.push(...valid)
        } else if (file.name.endsWith(".md")) {
          incoming.push(mdToTranscript(file.name, text))
        }
      }
      const count = await importTranscripts(incoming)
      const updated = await getAllTranscripts()
      setTranscripts(updated)
      showStatus(`Imported ${count} new ${count === 1 ? "memory" : "memories"}`)
    } catch {
      showStatus("Import failed — check file format")
    }
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    setIsDragOver(false)
    const files = Array.from(e.dataTransfer.files).filter(
      (f) => f.name.endsWith(".json") || f.name.endsWith(".md")
    )
    if (files.length > 0) processFiles(files)
  }

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setIsDragOver(true) }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setIsDragOver(false) }}
      onDrop={handleDrop}
      style={{
        minHeight: "100vh",
        background: "#0a0a14",
        color: "#e0e0e0",
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        display: "flex",
        flexDirection: "column",
        position: "relative"
      }}
    >
      {/* ── Drag overlay ── */}
      {isDragOver && (
        <div style={{
          position: "fixed",
          inset: 0,
          background: "rgba(124,106,247,0.08)",
          border: "2px dashed rgba(124,106,247,0.4)",
          zIndex: 100,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          pointerEvents: "none"
        }}>
          <div style={{
            background: "#161625",
            border: "1px solid rgba(124,106,247,0.35)",
            borderRadius: 16,
            padding: "24px 48px",
            textAlign: "center"
          }}>
            <div style={{ fontSize: 36, marginBottom: 10 }}>📂</div>
            <div style={{ fontSize: 15, color: "#a78bfa", fontWeight: 600 }}>Drop to import</div>
            <div style={{ fontSize: 12, color: "#555", marginTop: 4 }}>.json or .md files</div>
          </div>
        </div>
      )}

      {/* ── Top gradient bar ── */}
      <div style={{
        height: 3,
        background: "linear-gradient(90deg, #7c6af7 0%, #4285f4 50%, #10a37f 100%)",
        flexShrink: 0
      }} />

      {/* ── Top bar ── */}
      <div style={{
        padding: "13px 28px",
        borderBottom: "1px solid #1e1e2e",
        display: "flex",
        alignItems: "center",
        gap: 16,
        background: "#0d0d1a",
        position: "sticky",
        top: 0,
        zIndex: 10,
        flexShrink: 0
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginRight: 4 }}>
          <svg width="20" height="20" viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M9 0.5L17.5 9L9 17.5L0.5 9Z" fill="url(#mr_lib)"/>
            <defs><linearGradient id="mr_lib" x1="0.5" y1="0.5" x2="17.5" y2="17.5" gradientUnits="userSpaceOnUse"><stop stopColor="#9d8ff5"/><stop offset="1" stopColor="#4285f4"/></linearGradient></defs>
          </svg>
          <span style={{ fontWeight: 700, fontSize: 16, color: "#fff", letterSpacing: "-0.01em" }}>
            MindRelay
          </span>
          <span style={{ fontSize: 12, color: "#333", marginLeft: 2 }}>/ Library</span>
        </div>

        {/* Search */}
        <div style={{ position: "relative", flex: 1, maxWidth: 420 }}>
          <span style={{
            position: "absolute",
            left: 10,
            top: "50%",
            transform: "translateY(-50%)",
            fontSize: 12,
            color: "#333",
            pointerEvents: "none"
          }}>
            🔍
          </span>
          <input
            type="text"
            placeholder="Search all memories..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{
              width: "100%",
              boxSizing: "border-box",
              background: "#161625",
              border: "1px solid #252535",
              borderRadius: 8,
              color: "#ddd",
              fontSize: 13,
              padding: "7px 12px 7px 28px",
              outline: "none"
            }}
          />
        </div>

        {/* Source filter tabs */}
        <div style={{ display: "flex", gap: 5 }}>
          {["all", ...presentSources].map((src) => {
            const active = sourceFilter === src
            const color = src === "all" ? "#888" : (SOURCE_COLORS[src] ?? "#888")
            const count = src === "all"
              ? transcripts.length
              : transcripts.filter((t) => t.source === src).length
            return (
              <button
                key={src}
                onClick={() => setSourceFilter(src)}
                style={{
                  background: active ? `${color}1a` : "transparent",
                  border: `1px solid ${active ? color + "44" : "#252535"}`,
                  color: active ? (src === "all" ? "#bbb" : color) : "#444",
                  borderRadius: 20,
                  padding: "4px 12px",
                  fontSize: 12,
                  cursor: "pointer",
                  textTransform: "capitalize",
                  transition: "all 0.12s",
                  fontWeight: active ? 600 : 400,
                  whiteSpace: "nowrap"
                }}
              >
                {src === "all" ? "All" : src}{" "}
                <span style={{ opacity: 0.6 }}>{count}</span>
              </button>
            )
          })}
        </div>

        {/* Actions */}
        <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
          {injectStatus && (
            <span style={{
              fontSize: 12,
              color: "#a78bfa",
              background: "rgba(124,106,247,0.1)",
              border: "1px solid rgba(124,106,247,0.2)",
              borderRadius: 6,
              padding: "3px 10px"
            }}>
              {injectStatus}
            </span>
          )}
          <button
            onClick={handleExport}
            style={{
              background: "rgba(124,106,247,0.1)",
              border: "1px solid rgba(124,106,247,0.25)",
              color: "#7c6af7",
              borderRadius: 7,
              padding: "6px 14px",
              fontSize: 12,
              cursor: "pointer"
            }}
          >
            Export
          </button>
          <button
            onClick={handleClearAll}
            style={{
              background: "transparent",
              border: "1px solid rgba(204,85,85,0.2)",
              color: "#cc5555",
              borderRadius: 7,
              padding: "6px 14px",
              fontSize: 12,
              cursor: "pointer"
            }}
          >
            Clear all
          </button>
        </div>
      </div>

      {/* ── Body: sidebar + detail ── */}
      <div style={{ display: "flex", flex: 1, overflow: "hidden", height: "calc(100vh - 68px)" }}>

        {/* Sidebar */}
        <div style={{
          width: 320,
          flexShrink: 0,
          borderRight: "1px solid #1e1e2e",
          background: "#0d0d1a",
          display: "flex",
          flexDirection: "column"
        }}>
          <div style={{ flex: 1, overflowY: "auto" }}>
            {loading && (
              <div style={{ padding: 32, textAlign: "center", color: "#444" }}>Loading...</div>
            )}

            {!loading && filtered.length === 0 && (
              <div style={{ padding: 32, textAlign: "center", color: "#444", fontSize: 13, lineHeight: 1.6 }}>
                {search ? `No results for "${search}"` : "No memories saved yet"}
              </div>
            )}

            {!loading && filtered.map((t) => {
              const isSelected = selected?.id === t.id
              const color = SOURCE_COLORS[t.source] ?? "#888"
              const rawSnippet = t.messages.find((m) => m.role === "user")?.content
                ?? t.messages[0]?.content ?? ""
              const cleanSnippet = rawSnippet.replace(/\n+/g, " ").trim()

              return (
                <div
                  key={t.id}
                  onClick={() => setSelected(t)}
                  style={{
                    padding: "11px 16px",
                    borderBottom: "1px solid #161625",
                    borderLeft: `3px solid ${isSelected ? color : "transparent"}`,
                    cursor: "pointer",
                    background: isSelected ? "#13132a" : "transparent",
                    transition: "background 0.1s, border-color 0.1s"
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                    <span style={{
                      fontSize: 9,
                      fontWeight: 700,
                      textTransform: "uppercase",
                      letterSpacing: "0.05em",
                      color,
                      background: `${color}18`,
                      padding: "2px 6px",
                      borderRadius: 4
                    }}>
                      {t.source}
                    </span>
                    <span style={{ fontSize: 10, color: "#333", marginLeft: "auto" }}>
                      {formatDate(t.timestamp)}
                    </span>
                  </div>
                  <div style={{
                    fontSize: 13,
                    color: isSelected ? "#e8e8f0" : "#b0b0c0",
                    fontWeight: isSelected ? 500 : 400,
                    lineHeight: 1.35,
                    overflow: "hidden",
                    display: "-webkit-box",
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: "vertical",
                    marginBottom: 3
                  }}>
                    {t.title}
                  </div>
                  <div style={{
                    fontSize: 11,
                    color: "#303045",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap"
                  }}>
                    {cleanSnippet.slice(0, 60)}{cleanSnippet.length > 60 ? "…" : ""}
                  </div>
                  <div style={{ fontSize: 10, color: "#2a2a3a", marginTop: 4 }}>
                    {t.messages.length} {t.messages.length === 1 ? "message" : "messages"}
                  </div>
                </div>
              )
            })}
          </div>

          {/* Storage indicator footer */}
          <div style={{
            padding: "9px 16px",
            borderTop: "1px solid #1e1e2e",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            flexShrink: 0
          }}>
            <span style={{ fontSize: 11, color: "#333" }}>
              {transcripts.length} {transcripts.length === 1 ? "memory" : "memories"}
            </span>
            <span style={{ fontSize: 11, color: "#333" }}>{storageInfo}</span>
          </div>
        </div>

        {/* Detail pane */}
        <div style={{ flex: 1, overflowY: "auto", padding: "32px 44px" }}>
          {!selected ? (
            <div style={{ textAlign: "center", marginTop: 110 }}>
              <div style={{ marginBottom: 16, opacity: 0.15 }}>
                <svg width="48" height="48" viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M9 0.5L17.5 9L9 17.5L0.5 9Z" fill="url(#mr_detail)"/>
                  <defs><linearGradient id="mr_detail" x1="0.5" y1="0.5" x2="17.5" y2="17.5" gradientUnits="userSpaceOnUse"><stop stopColor="#9d8ff5"/><stop offset="1" stopColor="#4285f4"/></linearGradient></defs>
                </svg>
              </div>
              <div style={{ fontSize: 14, color: "#333" }}>Select a memory to view it</div>
              <div style={{ fontSize: 12, color: "#252535", marginTop: 6 }}>
                or drop .json / .md files anywhere to import
              </div>
            </div>
          ) : (
            <>
              {/* Detail header */}
              <div style={{ marginBottom: 24 }}>
                <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                      <span style={{
                        fontSize: 10,
                        fontWeight: 700,
                        textTransform: "uppercase",
                        letterSpacing: "0.05em",
                        color: SOURCE_COLORS[selected.source] ?? "#888",
                        background: `${SOURCE_COLORS[selected.source] ?? "#888"}18`,
                        padding: "3px 8px",
                        borderRadius: 4
                      }}>
                        {selected.source}
                      </span>
                      <span style={{ fontSize: 12, color: "#444" }}>
                        {formatDate(selected.timestamp)} at {formatTime(selected.timestamp)}
                      </span>
                    </div>
                    <h1 style={{ margin: "0 0 8px", fontSize: 20, fontWeight: 700, color: "#fff", lineHeight: 1.3 }}>
                      {selected.title}
                    </h1>
                    <div style={{ fontSize: 12, color: "#444" }}>
                      {selected.messages.length} {selected.messages.length === 1 ? "message" : "messages"}
                      {selected.source !== "obsidian" && isSafeUrl(selected.url) && (
                        <span>
                          {" · "}
                          <a
                            href={selected.url}
                            target="_blank"
                            rel="noreferrer"
                            style={{ color: SOURCE_COLORS[selected.source] ?? "#888", textDecoration: "none" }}
                          >
                            Open original →
                          </a>
                        </span>
                      )}
                    </div>
                  </div>

                  <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
                    <button
                      onClick={() => handleInject(selected)}
                      style={{
                        background: `${SOURCE_COLORS[selected.source] ?? "#888"}1a`,
                        border: `1px solid ${SOURCE_COLORS[selected.source] ?? "#888"}44`,
                        color: SOURCE_COLORS[selected.source] ?? "#888",
                        borderRadius: 7,
                        padding: "7px 16px",
                        fontSize: 13,
                        cursor: "pointer",
                        fontWeight: 600
                      }}
                    >
                      Inject into AI
                    </button>
                    <button
                      onClick={() => handleDelete(selected.id)}
                      style={{
                        background: "transparent",
                        border: "1px solid rgba(204,85,85,0.2)",
                        color: "#cc5555",
                        borderRadius: 7,
                        padding: "7px 14px",
                        fontSize: 13,
                        cursor: "pointer"
                      }}
                    >
                      Delete
                    </button>
                    <button
                      onClick={() => handleClearSource(selected.source)}
                      style={{
                        background: "transparent",
                        border: "1px solid #252535",
                        color: "#444",
                        borderRadius: 7,
                        padding: "7px 14px",
                        fontSize: 13,
                        cursor: "pointer"
                      }}
                    >
                      Clear {selected.source}
                    </button>
                  </div>
                </div>
              </div>

              <div style={{ borderTop: "1px solid #1e1e2e", marginBottom: 32 }} />

              {/* Chat bubbles */}
              <div style={{ display: "flex", flexDirection: "column" }}>
                {selected.messages.map((msg, i) => {
                  const isUser = msg.role === "user"
                  const sourceColor = SOURCE_COLORS[selected.source] ?? "#888"
                  return (
                    <div
                      key={i}
                      style={{
                        display: "flex",
                        justifyContent: isUser ? "flex-end" : "flex-start",
                        marginBottom: 18
                      }}
                    >
                      <div style={{ maxWidth: "78%", display: "flex", flexDirection: "column", gap: 5 }}>
                        <div style={{
                          fontSize: 10,
                          fontWeight: 700,
                          textTransform: "uppercase",
                          letterSpacing: "0.05em",
                          color: isUser ? "#7c6af7" : sourceColor,
                          textAlign: isUser ? "right" : "left",
                          paddingLeft: isUser ? 0 : 4,
                          paddingRight: isUser ? 4 : 0
                        }}>
                          {isUser ? "You" : selected.source === "obsidian" ? "Note" : "Assistant"}
                        </div>
                        <div style={{
                          background: isUser ? "rgba(124,106,247,0.12)" : "#141428",
                          border: `1px solid ${isUser ? "rgba(124,106,247,0.2)" : "#1e1e35"}`,
                          borderRadius: isUser ? "12px 12px 4px 12px" : "12px 12px 12px 4px",
                          padding: "11px 15px",
                          fontSize: 14,
                          color: isUser ? "#c4b5fd" : "#c0c0d0",
                          lineHeight: 1.7,
                          whiteSpace: "pre-wrap",
                          wordBreak: "break-word"
                        }}>
                          {msg.content}
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
