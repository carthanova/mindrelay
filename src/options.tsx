import "./popup.css"
import icon from "url:../assets/icon.png"

export default function IndexOptions() {
  return (
    <div style={{
      minHeight: "100vh",
      background: "#0d0d1a",
      color: "#e0e0e0",
      fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      display: "flex",
      alignItems: "center",
      justifyContent: "center"
    }}>
      <div style={{ maxWidth: 480, width: "90%", textAlign: "center" }}>
        <img src={icon} width={52} height={52} style={{ borderRadius: 14, marginBottom: 20 }} />
        <div style={{ fontSize: 22, fontWeight: 700, color: "#fff", marginBottom: 8, letterSpacing: "-0.02em" }}>Mindrelay</div>
        <div style={{ fontSize: 13, color: "#555", marginBottom: 36, lineHeight: 1.6 }}>
          Your AI conversations, saved locally and injected as context across Claude, ChatGPT, Gemini, and Grok.
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 12, textAlign: "left" }}>
          <div style={{ background: "#12121f", border: "1px solid #1e1e2e", borderRadius: 12, padding: "16px 20px" }}>
            <div style={{ fontSize: 12, color: "#a78bfa", fontWeight: 600, marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.05em" }}>Storage</div>
            <div style={{ fontSize: 13, color: "#888", lineHeight: 1.5 }}>
              Conversations are stored locally in your browser and synced to your vault folder via the Mindrelay desktop app.
            </div>
          </div>

          <div style={{ background: "#12121f", border: "1px solid #1e1e2e", borderRadius: 12, padding: "16px 20px" }}>
            <div style={{ fontSize: 12, color: "#a78bfa", fontWeight: 600, marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.05em" }}>Free tier</div>
            <div style={{ fontSize: 13, color: "#888", lineHeight: 1.5 }}>
              50 conversations are kept locally. The oldest are automatically removed when the limit is reached. Unlimited storage is coming with Mindrelay Sync.
            </div>
          </div>

          <div style={{ background: "#12121f", border: "1px solid #1e1e2e", borderRadius: 12, padding: "16px 20px" }}>
            <div style={{ fontSize: 12, color: "#a78bfa", fontWeight: 600, marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.05em" }}>Privacy</div>
            <div style={{ fontSize: 13, color: "#888", lineHeight: 1.5 }}>
              All data stays on your device. Nothing is sent to external servers. The vault is a plain folder on your filesystem — you own your data.
            </div>
          </div>
        </div>

      </div>
    </div>
  )
}
