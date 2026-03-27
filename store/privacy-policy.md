# MindRelay Privacy Policy

**Last updated: March 27, 2026**

---

## Overview

MindRelay is a local-first browser extension. Your data stays on your device. We do not operate servers, collect analytics, or transmit your conversations anywhere.

---

## What We Collect

MindRelay captures text from AI conversations you have on:
- Claude (claude.ai)
- ChatGPT (chatgpt.com)
- Gemini (gemini.google.com)
- Grok (grok.com, x.com)

This includes the messages you send and the responses you receive during those conversations.

---

## Where It's Stored

All data is stored exclusively in **IndexedDB** — a local browser database on your device. It is never uploaded, synced, or transmitted to any server. MindRelay has no backend.

---

## How It's Used

Saved conversations are used solely to provide the core feature: injecting relevant context into new AI chats so you can continue work without re-explaining yourself. Context is matched and ranked locally in your browser.

---

## What We Do NOT Do

- We do not send your data to any server
- We do not collect analytics or usage statistics
- We do not require an account or login
- We do not share your data with third parties
- We do not access any pages outside the supported AI platforms

---

## Your Control

You can delete any saved conversation at any time from the MindRelay popup. You can clear all data by source or all at once. Uninstalling the extension removes all stored data.

---

## Permissions Explained

| Permission | Why |
|---|---|
| `storage` | Saves a migration flag in chrome.storage.local |
| `tabs` | Opens the memory library page in a new tab |
| `activeTab` | Reserved for future use |
| Host permissions (claude.ai, chatgpt.com, etc.) | Required to run content scripts that capture and inject context on those pages |

---

## Changes

If this policy changes materially, the updated version will be posted at this URL with a new "Last updated" date.

---

## Contact

For questions or concerns, open an issue at: (your GitHub repo URL)
