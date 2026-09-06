/**
 * USM 三种数据源（direct / chunk / zip）的统一「从指定字节偏移开始流式读取」抽象。
 *
 * 直链、Chunk、ZIP 的远端服务器均支持 HTTP Range 请求，因此统一为：
 * `streamUsmFrom(source, offset, onData, signal)` —— 从 USM 文件内字节偏移 `offset`
 * 开始顺序读取，逐段回调解压后的原始 USM 字节。
 *
 * `onData` 返回 Promise，用于向读取端传递背压（解码 + appendBuffer 排队完成后再读下一段）。
 */

import type { ChunkManifest, ParsedChunk, UsmSourceKind, ZipSource } from '@/types'
import { API_BASE } from '@/constants/core'
import { toRequestUrl } from '@/utils/request'
import { downloadChunks } from './chunk'
import { fetchAndParseManifest } from './manifest'
import { getZipDirCacheKey, streamZipFile } from './zip'

export interface UsmStreamSource {
  kind: UsmSourceKind
  directDownloadUrl: string | null
  chunkVersion: string | null
  zipSource: ZipSource | null
  zipVersion: string | null
  gameId: string
  filePath: string
}

/**
 * 从 `offset`（USM 文件内字节偏移）开始流式读取，逐段回调。
 */
export async function streamUsmFrom(
  source: UsmStreamSource,
  offset: number,
  onData: (data: Uint8Array) => Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  if (source.kind === 'direct' && source.directDownloadUrl) {
    await streamDirectFrom(source.directDownloadUrl, offset, onData, signal)
    return
  }
  if (source.kind === 'chunk' && source.chunkVersion) {
    await streamChunkFrom(source, offset, onData, signal)
    return
  }
  if (source.kind === 'zip' && source.zipSource) {
    await streamZipFrom(source, offset, onData, signal)
    return
  }
  throw new Error('无可用资源')
}

/**
 * 获取 USM 文件总字节数（用于「总时长 → 字节偏移」线性估算）。
 *
 * - direct：Range 0-0 读 Content-Range 总大小（fallback Content-Length）
 * - chunk：最后一个 chunk 的 offset + uncompressedSize
 * - zip：返回 null（解压流无法真正随机访问，估算跳转收益有限，调用方回退顺序扫）
 */
export async function getUsmFileSize(source: UsmStreamSource, signal?: AbortSignal): Promise<number | null> {
  if (source.kind === 'direct' && source.directDownloadUrl)
    return getDirectFileSize(source.directDownloadUrl, signal)
  if (source.kind === 'chunk' && source.chunkVersion) {
    try {
      const { chunks } = await resolveChunkFile(source)
      const last = chunks[chunks.length - 1]
      return last ? last.offset + last.uncompressedSize : null
    }
    catch {
      return null
    }
  }
  return null
}

/** direct：轻量请求仅取文件总大小（不读 body） */
async function getDirectFileSize(url: string, signal?: AbortSignal): Promise<number | null> {
  try {
    const res = await fetch(toRequestUrl(url), {
      signal,
      headers: { Range: 'bytes=0-0' },
    })
    const contentRange = res.headers.get('Content-Range')
    if (contentRange) {
      const m = /bytes\s+\d+-\d+\/(\d+)/.exec(contentRange)
      if (m)
        return Number(m[1])
    }
    const len = res.headers.get('Content-Length')
    if (len)
      return Number(len)
    return null
  }
  catch {
    return null
  }
}

/** direct：单次 Range 请求从 offset 读到末尾 */
async function streamDirectFrom(
  url: string,
  offset: number,
  onData: (data: Uint8Array) => Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  const res = await fetch(toRequestUrl(url), {
    signal,
    headers: offset > 0 ? { Range: `bytes=${offset}-` } : {},
  })
  if (!res.ok)
    throw new Error(`HTTP ${res.status}`)
  if (offset > 0 && res.status !== 206)
    throw new Error('服务器未支持 Range 请求（HTTP 200，期望 206）')

  const reader = res.body!.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done)
      break
    if (signal.aborted)
      return
    await onData(value)
  }
}

/** chunk：定位 offset 所在 chunk，从该 chunk 解压后切片，顺序衔接后续 chunk */
const chunkFileCache = new Map<string, { chunks: ParsedChunk[], chunkUrlPrefix: string }>()

async function resolveChunkFile(source: UsmStreamSource): Promise<{ chunks: ParsedChunk[], chunkUrlPrefix: string }> {
  const key = `${source.gameId}_${source.chunkVersion}_${source.filePath}`
  const hit = chunkFileCache.get(key)
  if (hit)
    return hit

  const res = await fetch(`${API_BASE}/chunk/${source.gameId}_${source.chunkVersion}.json`)
  if (!res.ok)
    throw new Error(`Chunk 列表获取失败：HTTP ${res.status}`)
  const json = await res.json()
  const manifests: ChunkManifest[] = json.data?.manifests ?? []

  let chunkUrlPrefix = ''
  let foundFile: { chunks: ParsedChunk[] } | null = null

  for (const m of manifests) {
    const cacheKey = `${source.gameId}_${source.chunkVersion}_${m.manifest.id}`
    const url = `${m.manifest_download.url_prefix}/${m.manifest.id}`
    let parsed
    try {
      parsed = await fetchAndParseManifest(url, cacheKey, Number(m.manifest.uncompressed_size))
    }
    catch (e) {
      if (e instanceof TypeError)
        throw e
      continue
    }
    const match = parsed.files.find(f => f.path === source.filePath)
    if (match) {
      foundFile = match
      chunkUrlPrefix = m.chunk_download.url_prefix
      break
    }
  }

  if (!foundFile)
    throw new Error('无可用资源')

  const result = {
    chunks: [...foundFile.chunks].sort((a, b) => a.offset - b.offset),
    chunkUrlPrefix,
  }
  chunkFileCache.set(key, result)
  return result
}

async function streamChunkFrom(
  source: UsmStreamSource,
  offset: number,
  onData: (data: Uint8Array) => Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  const { chunks, chunkUrlPrefix } = await resolveChunkFile(source)

  // 定位包含 offset 的 chunk（chunks 已按 offset 升序）
  let startIndex = chunks.length - 1
  let skipBytes = Math.max(0, offset - (chunks[startIndex]?.offset ?? 0))
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i]
    if (offset < c.offset + c.uncompressedSize) {
      startIndex = i
      skipBytes = offset - c.offset
      break
    }
  }

  await downloadChunks(
    chunks,
    chunkUrlPrefix,
    signal,
    async (decompressed) => {
      await onData(decompressed)
    },
    { startIndex, skipBytes },
  )
}

/** zip：从 entry 头部解压，丢弃 offset 之前的字节（网络仍走 Range，仅解压前缀浪费） */
async function streamZipFrom(
  source: UsmStreamSource,
  offset: number,
  onData: (data: Uint8Array) => Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  const cacheKey = getZipDirCacheKey(source.gameId, source.zipVersion ?? '', source.zipSource!.parts)
  await streamZipFile(
    source.zipSource!.parts,
    source.filePath,
    cacheKey,
    signal,
    async (decompressed) => {
      await onData(decompressed)
    },
    offset,
  )
}
