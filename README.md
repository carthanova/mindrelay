# MindRelay

**Your AI memory across every platform.**

MindRelay is a local-first browser extension that automatically captures your AI conversations and injects relevant context into new chats — so you never have to re-explain yourself when switching between AI models.

> Built with AI assistance (Claude) by someone who had an idea and ran with it. Not here to take credit as a software engineer — just someone having fun building his own ideas with AI.

---

## What It Does

- **Captures** conversations from Claude, ChatGPT, Gemini, and Grok automatically
- **Injects** relevant context into new chats using smart relevance ranking
- **Stores** everything locally on your device — no servers, no accounts, no cloud
- **Browses** your saved memory via a built-in popup and full library view
- **Imports** Obsidian notes as memory (.md or .json)
- **Stores up to 50 conversations** on the free tier — paid tiers unlock more

The more you use it, the more valuable it gets. Memory compounds.

---

## Supported Platforms

| Platform | Capture | Injection |
|---|---|---|
| Claude (claude.ai) | ✓ | ✓ |
| ChatGPT (chatgpt.com) | ✓ | ✓ |
| Gemini (gemini.google.com) | ✓ | ✓ |
| Grok (grok.com + x.com) | ✓ | ✓ |
| Obsidian (import) | ✓ | — |

---

## Tech Stack

- **[Plasmo](https://plasmo.com)** — Chrome extension framework (React + TypeScript, MV3)
- **IndexedDB** — local-first storage via background service worker
- **Smart retrieval** — TF-based relevance ranking across saved transcripts

---

## Architecture

```
Isolated World (claude.ts / chatgpt.ts / gemini.ts / grok.ts)
  ├── Captures DOM → saves to IndexedDB via background service worker
  ├── On new chat: loads transcripts → dispatches to main world (nonce-authenticated)
  └── chrome.runtime.onMessage → dispatches manual context inject

Main World (*-main.ts)
  ├── Validates nonce on all cross-world events
  ├── window.fetch intercept → injects ranked context into first message
  └── pushState override → detects new chat navigation

Background (background.ts)
  └── IndexedDB owner — all storage routed through here from any context
```

---

## Security

- Nonce-authenticated CustomEvents (prevents page script spoofing)
- `sender.id` validation on all `chrome.runtime.onMessage` handlers
- JSON import schema validation with source allowlist and length caps
- Safe URL validation before rendering as anchor tags
- Production logging gated behind `NODE_ENV === "development"`

---

## Local Development

```bash
npm install
npm run dev
```

Load `build/chrome-mv3-dev` as an unpacked extension in `chrome://extensions`.

## Production Build

```bash
npm run build       # Chrome MV3
npm run build:firefox  # Firefox MV2
npm run package     # Zip for store submission
```

---

## Privacy

Everything stays on your device. No server. No analytics. No account required.
Full privacy policy: `store/privacy-policy.md`

---

## Status

Version 1.0.0 — built March 2026. First public release.
