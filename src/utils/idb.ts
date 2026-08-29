import type { ParsedManifest } from '@/types'
import { openDB } from 'idb'

const DB_NAME = 'hoyo-files-cache'
const DB_VERSION = 2
const STORE_NAME = 'manifests'
const ZIP_DIR_STORE_NAME = 'zipDirs'
const MAX_SIZE = 500 * 1024 * 1024 // 500MB

interface ManifestRecord {
  key: string
  data: ParsedManifest
  size: number
  timestamp: number
}

/** ZIP 中央目录原始字节缓存（按虚拟文件偏移定位） */
export interface ZipDirRecord {
  key: string
  offset: number
  data: Uint8Array
  size: number
  timestamp: number
}

interface AppDB {
  manifests: { key: string, value: ManifestRecord }
  zipDirs: { key: string, value: ZipDirRecord }
}

let dbPromise: ReturnType<typeof openDB<AppDB>> | null = null

function getDB() {
  if (!dbPromise) {
    dbPromise = openDB<AppDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'key' })
        }
        if (!db.objectStoreNames.contains(ZIP_DIR_STORE_NAME)) {
          db.createObjectStore(ZIP_DIR_STORE_NAME, { keyPath: 'key' })
        }
      },
    })
  }
  return dbPromise
}

export async function getManifest(key: string): Promise<ParsedManifest | null> {
  try {
    const db = await getDB()
    const record = await db.get(STORE_NAME, key)
    return record?.data ?? null
  }
  catch {
    return null
  }
}

export async function setManifest(key: string, data: ParsedManifest, size: number): Promise<void> {
  try {
    const db = await getDB()
    await evictIfNeeded(db, size)
    const record: ManifestRecord = { key, data, size, timestamp: Date.now() }
    await db.put(STORE_NAME, record)
  }
  catch { }
}

async function evictIfNeeded(db: Awaited<ReturnType<typeof getDB>>, incoming: number) {
  const all = [
    ...(await db.getAll(STORE_NAME)).map(r => ({ key: r.key, size: r.size, timestamp: r.timestamp })),
    ...(await db.getAll(ZIP_DIR_STORE_NAME)).map(r => ({ key: r.key, size: r.size, timestamp: r.timestamp })),
  ]
  let total = all.reduce((s, r) => s + r.size, 0)
  if (total + incoming <= MAX_SIZE)
    return

  all.sort((a, b) => a.timestamp - b.timestamp)
  for (const record of all) {
    if (total + incoming <= MAX_SIZE)
      break
    await db.delete(STORE_NAME, record.key)
    await db.delete(ZIP_DIR_STORE_NAME, record.key)
    total -= record.size
  }
}

export async function getZipDir(key: string): Promise<ZipDirRecord | null> {
  try {
    const db = await getDB()
    const record = await db.get(ZIP_DIR_STORE_NAME, key)
    return record ?? null
  }
  catch {
    return null
  }
}

export async function setZipDir(key: string, offset: number, data: Uint8Array): Promise<void> {
  try {
    const db = await getDB()
    const size = data.byteLength
    await evictIfNeeded(db, size)
    const record: ZipDirRecord = { key, offset, data, size, timestamp: Date.now() }
    await db.put(ZIP_DIR_STORE_NAME, record)
  }
  catch { }
}

export interface CacheStats {
  available: true
  totalSize: number
  count: number
}

export interface CacheUnavailable {
  available: false
}

export async function getCacheStats(): Promise<CacheStats | CacheUnavailable> {
  try {
    const db = await getDB()
    const all = [
      ...(await db.getAll(STORE_NAME)),
      ...(await db.getAll(ZIP_DIR_STORE_NAME)),
    ]
    return {
      available: true,
      totalSize: all.reduce((s, r) => s + r.size, 0),
      count: all.length,
    }
  }
  catch {
    return { available: false }
  }
}

export async function clearCache(): Promise<void> {
  const db = await getDB()
  await db.clear(STORE_NAME)
  await db.clear(ZIP_DIR_STORE_NAME)
}
