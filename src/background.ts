import { dbClear, dbDelete, dbDeleteBySource, dbEvictOldest, dbFindByUrl, dbGetAll, dbPut } from "./lib/db"
import { log } from "./lib/log"
import type { Transcript } from "./lib/storage"

// Free tier cap. Pro tier (200) and Unlimited tier to be enforced once
// monetization is implemented.
const MAX_TRANSCRIPTS = 50

// ─── Extension badge ──────────────────────────────────────────────────────────

async function updateBadge(): Promise<void> {
  const all = await dbGetAll()
  const count = all.length
  chrome.action.setBadgeText({ text: count > 0 ? String(count) : "" })
  chrome.action.setBadgeBackgroundColor({ color: "#7c6af7" })
}

updateBadge().catch(console.error)

// ─── One-time migration from chrome.storage.local → IndexedDB ───────────────

const LEGACY_KEY = "memorymesh_transcripts"
const MIGRATION_FLAG = "memorymesh_idb_migrated"

async function runMigration(): Promise<void> {
  const flag = await chrome.storage.local.get(MIGRATION_FLAG)
  if (flag[MIGRATION_FLAG]) return

  const old = await chrome.storage.local.get(LEGACY_KEY)
  const legacy: Transcript[] = old[LEGACY_KEY] ?? []

  if (legacy.length > 0) {
    for (const t of legacy) await dbPut(t)
    log(`[MemoryMesh] migrated ${legacy.length} transcripts to IndexedDB`)
  }

  await chrome.storage.local.set({ [MIGRATION_FLAG]: true })
  await chrome.storage.local.remove(LEGACY_KEY)
}

runMigration().catch(console.error)

// ─── Storage message handler ─────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return
  handleMessage(msg)
    .then(sendResponse)
    .catch((err) => {
      console.error("[MemoryMesh] background storage error:", err)
      sendResponse(null)
    })
  return true
})

async function handleMessage(msg: {
  type: string
  [key: string]: unknown
}): Promise<unknown> {
  switch (msg.type) {
    case "DB_GET_ALL":
      return dbGetAll()
    case "DB_PUT":
      await dbPut(msg.data as Transcript)
      await dbEvictOldest(MAX_TRANSCRIPTS)
      updateBadge().catch(console.error)
      return
    case "DB_DELETE":
      await dbDelete(msg.id as string)
      updateBadge().catch(console.error)
      return
    case "DB_DELETE_BY_SOURCE":
      await dbDeleteBySource(msg.source as Transcript["source"])
      updateBadge().catch(console.error)
      return
    case "DB_CLEAR":
      await dbClear()
      updateBadge().catch(console.error)
      return
    case "DB_FIND_BY_URL":
      return dbFindByUrl(msg.url as string)
    default:
      return null
  }
}
