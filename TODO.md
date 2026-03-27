# MemoryMesh — What's Next

## Phase 3 — Storage Upgrade (PRIORITY)
- [ ] Migrate from `chrome.storage.local` (5MB hard limit) to IndexedDB (unlimited)
- [ ] Write backwards-compatible migration so existing saved data carries over
- [ ] Add a storage usage indicator in the popup/library so users know how full they are

## Gemini
- [ ] Verify DOM selectors (`user-query`, `model-response`) still work — Gemini uses Web Components that may shadow DOM
- [ ] Confirm the API endpoint URL for fetch interception (current intercept is best-effort on `StreamGenerate`)
- [ ] Test full capture + injection loop end-to-end

## Import Fix
- [x] Remove `webkitdirectory` — users can now multi-select `.md` or `.json` files directly
- [ ] Add drag-and-drop support to the library page as a secondary way to import

## Reliability
- [ ] Multi-fallback selectors for Claude and ChatGPT — AI platforms update their DOM and single selectors break silently
- [ ] Add a visible capture indicator in the banner so users know a save just happened
- [ ] Detect and warn when `chrome.storage.local` is near the 5MB limit

## Firefox
- [ ] Run `plasmo build --target=firefox-mv2` and test
- [ ] Verify `chrome.*` API calls work under the `browser.*` namespace shim

## Future (Post-MVP)
- [ ] Gemini capture via `chrome.debugger` API as fallback if DOM selectors fail
- [ ] MCP server — lets any MCP-compatible AI query your memory directly
- [ ] Pro tier: encrypted cross-device sync via Supabase
- [ ] Perplexity, Grok, and other AI platform support
