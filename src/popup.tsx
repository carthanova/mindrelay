import "./popup.css"
import icon from "url:../assets/icon.png"
import { useEffect, useState } from "react"
import {
  clearAllTranscripts,
  clearBySource,
  deleteTranscript,
  getAllTranscripts,
  type Transcript
} from "./lib/storage"

// ─── Constants ───────────────────────────────────────────────────────────────

const SOURCE_COLORS: Record<string, string> = {
  claude: "#cc785c",
  chatgpt: "#10a37f",
  gemini: "#4285f4",
  grok: "#ff6250",
  obsidian: "#7c6af7"
}

function timeAgo(timestamp: number): string {
  const diff = Date.now() - timestamp
  const mins = Math.floor(diff / 60_000)
  const hours = Math.floor(diff / 3_600_000)
  const days = Math.floor(diff / 86_400_000)
  if (mins < 1) return "just now"
  if (mins < 60) return `${mins}m ago`
  if (hours < 24) return `${hours}h ago`
  return `${days}d ago`
}

function snippet(t: Transcript): string {
  const first = t.messages.find((m) => m.role === "user") ?? t.messages[0]
  if (!first) return ""
  const clean = first.content
    .replace(/^#{1,6}\s+.+$/gm, "")
    .replace(/\*\*|__|`/g, "")
    .replace(/\n+/g, " ")
    .trim()
  return clean.slice(0, 90) + (clean.length > 90 ? "…" : "")
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function IndexPopup() {
  const [transcripts, setTranscripts] = useState<Transcript[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState("")
  const [sourceFilter, setSourceFilter] = useState<string>("all")
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [showClearMenu, setShowClearMenu] = useState(false)
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [statusMsg, setStatusMsg] = useState<string | null>(null)

  useEffect(() => {
    if (!showClearMenu) return
    const close = () => setShowClearMenu(false)
    document.addEventListener("click", close)
    return () => document.removeEventListener("click", close)
  }, [showClearMenu])

  useEffect(() => {
    getAllTranscripts().then((data) => {
      setTranscripts(data)
      setLoading(false)
    })
  }, [])

  function showStatus(msg: string) {
    setStatusMsg(msg)
    setTimeout(() => setStatusMsg(null), 2500)
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

  async function handleDelete(id: string, e: React.MouseEvent) {
    e.stopPropagation()
    await deleteTranscript(id)
    setTranscripts((prev) => prev.filter((t) => t.id !== id))
    if (expandedId === id) setExpandedId(null)
  }

  async function handleClearSource(source: Transcript["source"]) {
    if (!confirm(`Clear all ${source} memory? This cannot be undone.`)) return
    await clearBySource(source)
    setTranscripts((prev) => prev.filter((t) => t.source !== source))
    setShowClearMenu(false)
    if (sourceFilter === source) setSourceFilter("all")
  }

  async function handleClearAll() {
    if (!confirm("Clear all saved memory? This cannot be undone.")) return
    await clearAllTranscripts()
    setTranscripts([])
    setShowClearMenu(false)
    setSourceFilter("all")
  }


  return (
    <div style={{
      width: 380,
      minHeight: 200,
      fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      background: "#0d0d1a",
      color: "#e0e0e0"
    }}>

      {/* ── Gradient accent bar ── */}
      <div style={{
        height: 3,
        background: "linear-gradient(90deg, #7c6af7 0%, #4285f4 50%, #10a37f 100%)"
      }} />

      {/* ── Header ── */}
      <div style={{ padding: "12px 16px 10px", borderBottom: "1px solid #1e1e2e" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
            <img src={icon} width={18} height={18} style={{ borderRadius: 4 }} />
            <span style={{ fontWeight: 700, fontSize: 14, color: "#fff", letterSpacing: "-0.01em" }}>MindRelay</span>
            {transcripts.length > 0 && (
              <span style={{
                fontSize: 11,
                color: "#7c6af7",
                background: "rgba(124,106,247,0.1)",
                border: "1px solid rgba(124,106,247,0.2)",
                borderRadius: 99,
                padding: "2px 8px",
                fontWeight: 500
              }}>
                {transcripts.length} saved
              </span>
            )}
          </div>
          {transcripts.length > 0 && (
            <div style={{ position: "relative" }}>
              <button
                onClick={(e) => { e.stopPropagation(); setShowClearMenu((v) => !v) }}
                style={{
                  background: "transparent",
                  border: "1px solid rgba(204,85,85,0.2)",
                  color: "#cc5555",
                  borderRadius: 7,
                  padding: "4px 10px",
                  fontSize: 11,
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  gap: 5
                }}
              >
                Clear
                <span style={{ fontSize: 9, opacity: 0.7 }}>▾</span>
              </button>
              {showClearMenu && (
                <div style={{
                  position: "absolute",
                  top: "calc(100% + 6px)",
                  right: 0,
                  background: "#161625",
                  border: "1px solid #252535",
                  borderRadius: 8,
                  overflow: "hidden",
                  zIndex: 50,
                  minWidth: 150,
                  boxShadow: "0 8px 24px rgba(0,0,0,0.4)"
                }}>
                  <button
                    onClick={() => { setShowClearMenu(false); handleClearAll() }}
                    style={{
                      display: "block", width: "100%", textAlign: "left",
                      background: "transparent", border: "none",
                      borderBottom: "1px solid #1e1e2e",
                      color: "#cc5555", padding: "9px 14px", fontSize: 12, cursor: "pointer"
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = "#1e1e35")}
                    onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                  >
                    Clear All
                  </button>
                  {presentSources.map((src) => {
                    const isGrokSrc = src === "grok"
                    const c = SOURCE_COLORS[src] ?? "#888"
                    return (
                      <button
                        key={src}
                        onClick={() => { setShowClearMenu(false); handleClearSource(src as Transcript["source"]) }}
                        style={{
                          display: "block", width: "100%", textAlign: "center",
                          background: isGrokSrc ? "#000000" : `${c}28`,
                          border: "none", borderBottom: "1px solid #1e1e2e",
                          color: isGrokSrc ? "#ffffff" : c,
                          padding: "8px 14px", fontSize: 12, cursor: "pointer",
                          textTransform: "capitalize"
                        }}
                        onMouseEnter={(e) => (e.currentTarget.style.opacity = "0.8")}
                        onMouseLeave={(e) => (e.currentTarget.style.opacity = "1")}
                      >
                        {src}
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Search */}
        <div style={{ position: "relative", marginBottom: presentSources.length > 0 ? 10 : 0 }}>
          <input
            type="text"
            placeholder="Search memories..."
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
              padding: "7px 10px",
              outline: "none"
            }}
          />
        </div>

        {/* Source filter tabs */}
        {presentSources.length > 0 && (
          <div className="no-scrollbar" style={{ display: "flex", gap: 5, overflowX: "auto" }}>
            {["all", ...presentSources].map((src) => {
              const active = sourceFilter === src
              const color = src === "all" ? "#888" : (SOURCE_COLORS[src] ?? "#888")
              const isGrokSrc = src === "grok"
              const count = src === "all"
                ? transcripts.length
                : transcripts.filter((t) => t.source === src).length
              return (
                <button
                  key={src}
                  onClick={() => setSourceFilter(src)}
                  style={{
                    flexShrink: 0,
                    background: active ? (isGrokSrc ? "#000000" : `${color}1a`) : "transparent",
                    border: `1px solid ${active ? (isGrokSrc ? "#444" : color + "44") : "#252535"}`,
                    color: active ? (src === "all" ? "#bbb" : isGrokSrc ? "#ffffff" : color) : "#555",
                    borderRadius: 20,
                    padding: "3px 9px",
                    fontSize: 11,
                    cursor: "pointer",
                    textTransform: "capitalize",
                    transition: "all 0.12s",
                    fontWeight: active ? 600 : 400
                  }}
                >
                  {src === "all" ? "All" : src}{" "}
                  <span style={{ opacity: 0.6 }}>{count}</span>
                </button>
              )
            })}
          </div>
        )}
      </div>

      {/* ── Memory List ── */}
      <div style={{ maxHeight: 400, overflowY: "auto" }}>
        {loading && (
          <div style={{ padding: 28, textAlign: "center", color: "#444", fontSize: 13 }}>
            Loading...
          </div>
        )}

        {!loading && transcripts.length === 0 && (
          <div style={{ padding: "20px 16px 24px", textAlign: "center" }}>

            {/* Recovery banner */}
            <div
              onClick={() => chrome.tabs.create({ url: chrome.runtime.getURL("tabs/library.html") })}
              style={{
                background: "rgba(124,106,247,0.08)",
                border: "1px solid rgba(124,106,247,0.3)",
                borderRadius: 10,
                padding: "14px 16px",
                marginBottom: 20,
                cursor: "pointer",
                textAlign: "left",
                display: "flex",
                alignItems: "center",
                gap: 12
              }}
            >
              <div style={{ fontSize: 22, flexShrink: 0 }}>💾</div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: "#a78bfa", marginBottom: 3 }}>
                  Recover your memories
                </div>
                <div style={{ fontSize: 11, color: "#555", lineHeight: 1.5 }}>
                  Had conversations before? Open the library to restore from backup.
                </div>
              </div>
              <div style={{ fontSize: 11, color: "#7c6af7", flexShrink: 0 }}>Open →</div>
            </div>

            <div style={{ marginBottom: 12 }}>
              <img src={icon} width={40} height={40} style={{ borderRadius: 10 }} />
            </div>
            <div style={{ fontSize: 14, fontWeight: 700, color: "#e0e0f0", marginBottom: 4, letterSpacing: "-0.01em" }}>
              Your AI memory,
            </div>
            <div style={{ fontSize: 14, fontWeight: 700, color: "#7c6af7", marginBottom: 16, letterSpacing: "-0.01em" }}>
              across every platform.
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 10, textAlign: "left", marginBottom: 16 }}>
              {[
                { n: "①", title: "Start a conversation", sub: "Claude · ChatGPT · Gemini · Grok" },
                { n: "②", title: "It saves automatically", sub: "No setup. No copy-paste." },
                { n: "③", title: "Open any new chat", sub: "Your context follows you." }
              ].map(({ n, title, sub }) => (
                <div key={n} style={{ display: "flex", alignItems: "flex-start", gap: 12, padding: "10px 12px", background: "rgba(255,255,255,0.02)", borderRadius: 10, border: "1px solid #1e1e2e" }}>
                  <span style={{ fontSize: 16, flexShrink: 0, marginTop: 1 }}>{n}</span>
                  <div>
                    <div style={{ fontSize: 13, color: "#d0d0e0", fontWeight: 500, marginBottom: 2 }}>{title}</div>
                    <div style={{ fontSize: 11, color: "#444" }}>{sub}</div>
                  </div>
                </div>
              ))}
            </div>

            <button
              onClick={() => chrome.tabs.create({ url: chrome.runtime.getURL("tabs/library.html") })}
              style={{
                background: "rgba(124,106,247,0.08)",
                border: "1px solid rgba(124,106,247,0.2)",
                color: "#7c6af7",
                borderRadius: 8,
                padding: "7px 16px",
                fontSize: 12,
                cursor: "pointer",
                width: "100%"
              }}
            >
              Import existing memories
            </button>
          </div>
        )}

        {!loading && transcripts.length > 0 && filtered.length === 0 && (
          <div style={{ padding: 20, textAlign: "center", color: "#444", fontSize: 13 }}>
            No results for "{search}"
          </div>
        )}

        {!loading && filtered.map((t) => {
          const isExpanded = expandedId === t.id
          const isHovered = hoveredId === t.id
          const color = SOURCE_COLORS[t.source] ?? "#888"

          return (
            <div
              key={t.id}
              onMouseEnter={() => setHoveredId(t.id)}
              onMouseLeave={() => setHoveredId(null)}
              onClick={() => setExpandedId(isExpanded ? null : t.id)}
              style={{
                borderBottom: "1px solid #1a1a28",
                borderLeft: `3px solid ${isHovered || isExpanded ? color : "transparent"}`,
                paddingLeft: 13,
                paddingRight: 16,
                paddingTop: 10,
                paddingBottom: 10,
                cursor: "pointer",
                background: isExpanded ? "rgba(255,255,255,0.015)" : "transparent",
                transition: "border-color 0.12s, background 0.12s"
              }}
            >
              {/* Row 1: source chip + time */}
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                <span style={{
                  fontSize: 9,
                  fontWeight: 700,
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                  color: t.source === "grok" ? "#ffffff" : color,
                  background: t.source === "grok" ? "#000000" : `${color}18`,
                  padding: "2px 6px",
                  borderRadius: 4
                }}>
                  {t.source}
                </span>
                <span style={{ fontSize: 10, color: "#3a3a4a", marginLeft: "auto" }}>
                  {timeAgo(t.timestamp)}
                </span>
              </div>

              {/* Row 2: title */}
              <div style={{
                fontSize: 13,
                color: isHovered || isExpanded ? "#e8e8f0" : "#b8b8c8",
                fontWeight: 500,
                lineHeight: 1.35,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                marginBottom: 3,
                transition: "color 0.12s"
              }}>
                {t.title}
              </div>

              {/* Row 3: snippet */}
              <div style={{
                fontSize: 11,
                color: "#3a3a50",
                lineHeight: 1.4,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap"
              }}>
                {snippet(t)}
              </div>

              {/* Row 4: count + delete button */}
              <div style={{ display: "flex", alignItems: "center", marginTop: 7, gap: 4 }}>
                <span style={{ fontSize: 10, color: "#2e2e3e" }}>
                  {t.messages.length} {t.messages.length === 1 ? "message" : "messages"}
                </span>
                <div style={{
                  marginLeft: "auto",
                  opacity: isHovered ? 1 : 0,
                  transition: "opacity 0.12s",
                  pointerEvents: isHovered ? "auto" : "none"
                }}>
                  <button
                    onClick={(e) => handleDelete(t.id, e)}
                    style={{
                      background: "none",
                      border: "none",
                      color: "#cc5555",
                      cursor: "pointer",
                      fontSize: 13,
                      padding: "2px 5px",
                      borderRadius: 4,
                      lineHeight: 1
                    }}
                  >
                    ✕
                  </button>
                </div>
              </div>

              {/* Expanded preview */}
              {isExpanded && (
                <div style={{
                  marginTop: 10,
                  paddingTop: 10,
                  borderTop: "1px solid #1e1e2e",
                  maxHeight: 130,
                  overflowY: "auto"
                }}>
                  {t.messages.slice(0, 4).map((m, i) => (
                    <div key={i} style={{ marginBottom: 6, display: "flex", gap: 6 }}>
                      <span style={{
                        fontSize: 10,
                        fontWeight: 700,
                        textTransform: "uppercase",
                        color: m.role === "user" ? "#7c6af7" : color,
                        flexShrink: 0,
                        paddingTop: 1
                      }}>
                        {m.role === "user" ? "You" : "AI"}
                      </span>
                      <span style={{ fontSize: 11, color: "#555", lineHeight: 1.5 }}>
                        {m.content.slice(0, 120)}{m.content.length > 120 ? "…" : ""}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* ── Footer ── */}
      <div style={{ padding: "10px 16px", borderTop: "1px solid #1e1e2e" }}>
        {statusMsg && (
          <div style={{
            fontSize: 12,
            color: "#a78bfa",
            marginBottom: 8,
            textAlign: "center",
            background: "rgba(124,106,247,0.08)",
            border: "1px solid rgba(124,106,247,0.15)",
            borderRadius: 6,
            padding: "5px 10px"
          }}>
            {statusMsg}
          </div>
        )}

        <button
          onClick={() => chrome.tabs.create({ url: chrome.runtime.getURL("tabs/library.html") })}
          style={{
            width: "100%",
            background: "rgba(255,255,255,0.03)",
            border: "1px solid #252535",
            color: "#777",
            borderRadius: 7,
            padding: "8px 12px",
            fontSize: 12,
            cursor: "pointer"
          }}
        >
          Open library
        </button>

      </div>
    </div>
  )
}
