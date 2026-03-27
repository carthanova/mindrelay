/**
 * IndexedDB wrapper for MemoryMesh transcript storage.
 * Replaces chrome.storage.local (5MB limit) with unlimited local storage.
 * All functions mirror the chrome.storage.local interface so storage.ts
 * swaps transparently.
 */

import type { Transcript } from "./storage"

const DB_NAME = "mindrelay_db"
const DB_VERSION = 1
const STORE = "transcripts"

let _db: IDBDatabase | null = null

function openDB(): Promise<IDBDatabase> {
  if (_db) return Promise.resolve(_db)
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)

    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "id" })
        store.createIndex("timestamp", "timestamp")
        store.createIndex("url", "url")
        store.createIndex("source", "source")
      }
    }

    req.onsuccess = () => {
      _db = req.result
      // Re-open if connection is closed (e.g. after version upgrade)
      _db.onclose = () => { _db = null }
      resolve(_db)
    }

    req.onerror = () => reject(req.error)
  })
}

/** Return all transcripts sorted newest first. */
export async function dbGetAll(): Promise<Transcript[]> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly")
    const req = tx.objectStore(STORE).getAll()
    req.onsuccess = () => {
      const sorted = (req.result as Transcript[]).sort((a, b) => b.timestamp - a.timestamp)
      resolve(sorted)
    }
    req.onerror = () => reject(req.error)
  })
}

/** Insert or overwrite a single transcript by ID. */
export async function dbPut(transcript: Transcript): Promise<void> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite")
    const req = tx.objectStore(STORE).put(transcript)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
  })
}

/** Delete a single transcript by ID. */
export async function dbDelete(id: string): Promise<void> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite")
    const req = tx.objectStore(STORE).delete(id)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
  })
}

/** Delete all transcripts from a given source. */
export async function dbDeleteBySource(source: Transcript["source"]): Promise<void> {
  const all = await dbGetAll()
  const db = await openDB()
  const toDelete = all.filter((t) => t.source === source)
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite")
    const store = tx.objectStore(STORE)
    toDelete.forEach((t) => store.delete(t.id))
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

/** Clear the entire store. */
export async function dbClear(): Promise<void> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite")
    const req = tx.objectStore(STORE).clear()
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
  })
}

/** Delete oldest transcripts so count stays at or below maxCount. */
export async function dbEvictOldest(maxCount: number): Promise<void> {
  const all = await dbGetAll() // already sorted newest-first
  if (all.length <= maxCount) return
  const toEvict = all.slice(maxCount) // oldest entries beyond the cap
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite")
    const store = tx.objectStore(STORE)
    toEvict.forEach((t) => store.delete(t.id))
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

/** Find a transcript by URL. Returns null if not found. */
export async function dbFindByUrl(url: string): Promise<Transcript | null> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly")
    const req = tx.objectStore(STORE).index("url").get(url)
    req.onsuccess = () => resolve((req.result as Transcript) ?? null)
    req.onerror = () => reject(req.error)
  })
}
