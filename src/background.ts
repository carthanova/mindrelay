import { dbClear, dbCount, dbDelete, dbDeleteBySource, dbEvictByAge, dbEvictOldest, dbFindByUrl, dbGetAll, dbPut } from "./lib/db"
import { log } from "./lib/log"
import { sendToHost, sendToHostAck } from "./lib/native-messaging"
import type { Transcript } from "./lib/storage"
import { fetchAndCacheConfig } from "./lib/config"

// ─── Tier limits ─────────────────────────────────────────────────────────────
// Without the native app the extension is a limited preview. Conversations
// older than MAX_AGE_MS are evicted first (age-based, graceful). If the count
// still reaches MAX_TRANSCRIPTS and the native host is not available, new
// conversations are blocked — the user must install the desktop app to continue.
// When the native host IS available the vault holds everything; the extension
// cache can evict freely via the count cap.

const MAX_TRANSCRIPTS = 200
const WARN_THRESHOLD = 150
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000  // 30 days

// Tracks whether the native host responded successfully on the last attempt.
// Updated on every DB_PUT so the popup can read it via HOST_PING.
let hostAvailable = false

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

// ─── Startup sync: bidirectional IndexedDB ↔ native vault ────────────────────
// On every service-worker startup:
//   Pull: host → IDB  (vault records the extension doesn't have yet)
//   Push: IDB → host  (extension records the vault doesn't have yet)
//
// One GET_ALL call covers both directions. After the initial full push the
// ongoing per-save DB_PUT keeps the two sides in sync, so subsequent startups
// typically push 0 records.

async function syncWithHost(): Promise<void> {
  const ack = await sendToHostAck({ type: "GET_ALL" }, 30_000)
  if (!ack.ok) {
    if (ack.error !== "host not available") {
      log("[MindRelay] startup sync failed:", ack.error)
    }
    return
  }
  hostAvailable = true

  const hostTranscripts = (ack.data as Transcript[] | undefined) ?? []
  const hostIds = new Set(hostTranscripts.map((t) => t.id))

  const localTranscripts = await dbGetAll()
  const localIds = new Set(localTranscripts.map((t) => t.id))

  // Pull: vault → IDB
  const toImport = hostTranscripts.filter((t) => !localIds.has(t.id))
  for (const t of toImport) await dbPut(t)
  if (toImport.length > 0) {
    log(`[MindRelay] sync: pulled ${toImport.length} from vault into IDB`)
    updateBadge().catch(console.error)
  }

  // Push: IDB → vault (covers data captured before the native host was installed)
  const toPush = localTranscripts.filter((t) => !hostIds.has(t.id))
  let pushed = 0
  for (const t of toPush) {
    const result = await sendToHostAck({ type: "PUT", data: t })
    if (result.ok) {
      pushed++
    } else if (result.error !== "host not available") {
      log("[MindRelay] sync: push failed for", t.id, result.error)
    }
  }
  if (pushed > 0) {
    log(`[MindRelay] sync: pushed ${pushed} conversations to vault`)
  }
}

syncWithHost().catch(console.error)

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

// ─── Remote selector config ───────────────────────────────────────────────────

const CONFIG_ALARM = "mindrelay-config-refresh"

// Fetch on startup and schedule daily refresh
fetchAndCacheConfig().catch(console.error)

chrome.alarms.get(CONFIG_ALARM, (alarm) => {
  if (!alarm) {
    chrome.alarms.create(CONFIG_ALARM, { periodInMinutes: 60 * 24 })
  }
})

// ─── Schedule daily backup ────────────────────────────────────────────────────

chrome.alarms.get(BACKUP_ALARM, (alarm) => {
  if (!alarm) {
    chrome.alarms.create(BACKUP_ALARM, { periodInMinutes: 60 * 24 })
  }
})

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === BACKUP_ALARM) performAutoBackup().catch(console.error)
  if (alarm.name === CONFIG_ALARM) fetchAndCacheConfig().catch(console.error)
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
    case "DB_PUT": {
      const incoming = msg.data as Transcript

      // Step 1: Age eviction — always, regardless of host presence.
      // Removes conversations not touched in 30 days before we count anything.
      await dbEvictByAge(Date.now() - MAX_AGE_MS)

      // Step 2: Hard stop for NEW conversations when host is unavailable and
      // the cap is full. Updates to existing conversations always go through.
      const isExisting = incoming.url
        ? !!(await dbFindByUrl(incoming.url))
        : false

      if (!isExisting && !hostAvailable) {
        const countAfterEviction = await dbCount()
        if (countAfterEviction >= MAX_TRANSCRIPTS) {
          return { ok: false, atLimit: true, hostAvailable: false, count: countAfterEviction }
        }
      }

      // Step 3: Save.
      await dbPut(incoming)

      // Step 4: Sync to native host.
      const ack = await sendToHostAck({ type: "PUT", data: incoming })
      hostAvailable = ack.ok
      if (!ack.ok && ack.error !== "host not available") {
        log("[MindRelay] host PUT failed:", ack.error)
      }

      // Step 5: Count safety cap — only when host is available (vault has everything).
      if (ack.ok) {
        await dbEvictOldest(MAX_TRANSCRIPTS)
      }

      const count = await dbCount()
      updateBadge().catch(console.error)
      maybeBackup().catch(console.error)
      return { ok: true, hostSaved: ack.ok, id: ack.id, count, hostAvailable: ack.ok }
    }
    case "DB_DELETE":
      await dbDelete(msg.id as string)
      sendToHost({ type: "DELETE", id: msg.id })
      updateBadge().catch(console.error)
      return
    case "DB_DELETE_BY_SOURCE":
      await dbDeleteBySource(msg.source as Transcript["source"])
      sendToHost({ type: "DELETE_BY_SOURCE", source: msg.source })
      updateBadge().catch(console.error)
      return
    case "DB_CLEAR":
      await dbClear()
      sendToHost({ type: "CLEAR" })
      updateBadge().catch(console.error)
      return
    case "DB_FIND_BY_URL":
      return dbFindByUrl(msg.url as string)
    case "HOST_SEARCH": {
      const ack = await sendToHostAck({
        type: "RELEVANCE_SEARCH",
        query: msg.query,
        sessionId: msg.sessionId,
        topK: msg.topK ?? 5
      }, 5_000)
      if (!ack.ok) return { ok: false, results: [] }
      // RELEVANCE_SEARCH response shape: { ok, sessionId, results, dedupFiltered }
      const raw = ack as unknown as { results?: unknown[] }
      return { ok: true, results: raw.results ?? [] }
    }
    case "HOST_SESSION_END":
      sendToHost({ type: "SESSION_END", sessionId: msg.sessionId })
      return
    case "OPEN_APP": {
      const ack = await sendToHostAck({ type: "OPEN_APP" })
      return { ok: ack.ok, error: ack.error }
    }
    case "HOST_PING":
      return { available: hostAvailable, count: await dbCount(), warnThreshold: WARN_THRESHOLD, maxTranscripts: MAX_TRANSCRIPTS }
    default:
      return null
  }
}
