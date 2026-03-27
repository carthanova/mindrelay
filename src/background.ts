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

const LEGACY_KEY = "mindrelay_transcripts"
const MIGRATION_FLAG = "mindrelay_idb_migrated"

async function runMigration(): Promise<void> {
  const flag = await chrome.storage.local.get(MIGRATION_FLAG)
  if (flag[MIGRATION_FLAG]) return

  const old = await chrome.storage.local.get(LEGACY_KEY)
  const legacy: Transcript[] = old[LEGACY_KEY] ?? []

  if (legacy.length > 0) {
    for (const t of legacy) await dbPut(t)
    log(`[MindRelay] migrated ${legacy.length} transcripts to IndexedDB`)
  }

  await chrome.storage.local.set({ [MIGRATION_FLAG]: true })
  await chrome.storage.local.remove(LEGACY_KEY)
}

runMigration().catch(console.error)

// ─── One-time migration from memorymesh_db → mindrelay_db (rename) ──────────

const DB_RENAME_FLAG = "mindrelay_db_rename_migrated"

async function runDbRenameMigration(): Promise<void> {
  const flag = await chrome.storage.local.get(DB_RENAME_FLAG)
  if (flag[DB_RENAME_FLAG]) return

  const transcripts = await new Promise<Transcript[]>((resolve) => {
    const req = indexedDB.open("memorymesh_db", 1)
    req.onerror = () => resolve([])
    req.onblocked = () => resolve([])
    req.onsuccess = () => {
      const db = req.result
      if (!db.objectStoreNames.contains("transcripts")) { db.close(); resolve([]); return }
      const tx = db.transaction("transcripts", "readonly")
      const all = tx.objectStore("transcripts").getAll()
      all.onsuccess = () => { db.close(); resolve(all.result as Transcript[]) }
      all.onerror = () => { db.close(); resolve([]) }
    }
    req.onupgradeneeded = (e) => {
      // DB didn't exist before — nothing to migrate
      ;(e.target as IDBOpenDBRequest).transaction?.abort()
      resolve([])
    }
  })

  if (transcripts.length > 0) {
    for (const t of transcripts) await dbPut(t)
    log(`[MindRelay] migrated ${transcripts.length} transcripts from memorymesh_db`)
  }

  await chrome.storage.local.set({ [DB_RENAME_FLAG]: true })
}

runDbRenameMigration().catch(console.error)

// ─── Storage message handler ─────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return
  handleMessage(msg)
    .then(sendResponse)
    .catch((err) => {
      console.error("[MindRelay] background storage error:", err)
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
