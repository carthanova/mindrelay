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

// ─── Auto-backup ─────────────────────────────────────────────────────────────

const BACKUP_ALARM = "mindrelay-auto-backup"
const LAST_BACKUP_KEY = "mindrelay_last_backup_count"

async function performAutoBackup(): Promise<void> {
  const all = await dbGetAll()
  if (all.length === 0) return

  // Only backup if data has changed since last backup
  const stored = await chrome.storage.local.get(LAST_BACKUP_KEY)
  if (stored[LAST_BACKUP_KEY] === all.length) return

  const json = JSON.stringify(all, null, 2)
  const date = new Date().toISOString().split("T")[0]
  const url = `data:application/json;charset=utf-8,${encodeURIComponent(json)}`

  await chrome.downloads.download({
    url,
    filename: `mindrelay-backup-${date}.json`,
    saveAs: false,
    conflictAction: "overwrite"
  })

  await chrome.storage.local.set({ [LAST_BACKUP_KEY]: all.length })
  log("[MindRelay] auto-backup saved:", `mindrelay-backup-${date}.json`)
}

// Schedule daily backup
chrome.alarms.get(BACKUP_ALARM, (alarm) => {
  if (!alarm) {
    chrome.alarms.create(BACKUP_ALARM, { periodInMinutes: 60 * 24 })
  }
})

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === BACKUP_ALARM) {
    performAutoBackup().catch(console.error)
  }
})

// Also backup whenever new data is saved (triggered after DB_PUT)
async function maybeBackup(): Promise<void> {
  const all = await dbGetAll()
  const stored = await chrome.storage.local.get(LAST_BACKUP_KEY)
  const lastCount = stored[LAST_BACKUP_KEY] ?? 0
  // Only auto-backup when count grows by 5+ to avoid spamming Downloads
  if (all.length >= lastCount + 5) {
    await performAutoBackup()
  }
}

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
      maybeBackup().catch(console.error)
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
