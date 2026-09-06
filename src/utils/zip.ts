import type { GameFileRecord, PkgFile, VersionData, ZipSource } from '@/types'
import { configure, Reader, Uint8ArrayWriter, ZipReader } from '@zip.js/zip.js'
import zipWasmUrl from '@zip.js/zip.js/dist/zip-module.wasm?url'
import zipWorkerUrl from '@zip.js/zip.js/dist/zip-web-worker.js?url'
import { toRequestUrl } from '@/utils/request'
import { getZipDir, setZipDir } from './idb'

/** 下载块大小：8 MiB（zip.js 默认 64 KiB 会导致串行小 Range 请求，速度极慢） */
const READ_CHUNK_SIZE = 8 * 1024 * 1024

/**
 * zip.js 解压走内置 Web Worker，避免大文件解压阻塞主线程。
 * worker 脚本与 wasm 通过 Vite `?url` 导入获得哈希资源 URL（无需 Vite worker 配置）；
 * 若 worker 启动失败，zip.js 会自动回退主线程解压，功能不受影响。
 */
configure({
  useWebWorkers: true,
  workerURI: zipWorkerUrl,
  wasmURI: zipWasmUrl,
})

interface Part {
  url: string
  size: number
  start: number
  end: number
}

interface CachedDirectory {
  offset: number
  data: Uint8Array
}

/**
 * 将游戏包（单文件或分卷）转换为虚拟连续文件的读取器。
 * 分卷数量通常很少，线性查找即可。
 */
class VirtualHttpReader {
  private readonly parts: Part[]
  readonly size: number
  private cachedDirectory: CachedDirectory | null = null

  constructor(parts: Part[], cachedDirectory: CachedDirectory | null = null) {
    this.parts = parts
    this.size = parts.length ? parts[parts.length - 1].end : 0
    this.cachedDirectory = cachedDirectory
  }

  /**
   * 将虚拟 ZIP 中的 [offset, offset + length) 映射为一个或多个 HTTP Range 请求。
   * 命中中央目录缓存时直接从缓存回源，避免重复读取中央目录。
   */
  async read(offset: number, length: number): Promise<Uint8Array> {
    if (length <= 0)
      return new Uint8Array()

    if (offset < 0 || offset >= this.size)
      throw new RangeError(`Invalid read offset: ${offset}, size=${this.size}`)

    const end = Math.min(offset + length, this.size)

    const cached = this.cachedDirectory
    if (cached && offset >= cached.offset && end <= cached.offset + cached.data.length) {
      const start = offset - cached.offset
      return cached.data.slice(start, start + (end - offset))
    }

    const chunks: Uint8Array[] = []
    let cursor = offset

    while (cursor < end) {
      const part = this.findPart(cursor)

      const partOffset = cursor - part.start
      const available = part.size - partOffset
      const readLength = Math.min(available, end - cursor)

      const rangeStart = partOffset
      const rangeEnd = partOffset + readLength - 1

      const response = await fetch(toRequestUrl(part.url), {
        headers: {
          Range: `bytes=${rangeStart}-${rangeEnd}`,
        },
      })

      if (!response.ok) {
        throw new Error(
          `HTTP ${response.status} ${response.statusText}: ${part.url}`,
        )
      }

      // 防止服务器忽略 Range，直接返回整个文件。
      if (response.status !== 206) {
        throw new Error(
          `Server did not honor Range request: ${part.url} `
          + `(HTTP ${response.status}, Content-Range=${response.headers.get('content-range')})`,
        )
      }

      const data = new Uint8Array(await response.arrayBuffer())

      if (data.length !== readLength) {
        throw new Error(
          `Unexpected response length: expected ${readLength}, got ${data.length}`,
        )
      }

      chunks.push(data)
      cursor += data.length
    }

    const result = new Uint8Array(end - offset)
    let writeOffset = 0
    for (const chunk of chunks) {
      result.set(chunk, writeOffset)
      writeOffset += chunk.length
    }
    return result
  }

  private findPart(offset: number): Part {
    for (const part of this.parts) {
      if (offset >= part.start && offset < part.end)
        return part
    }
    throw new Error(`No part found for offset ${offset}`)
  }
}

/**
 * 将 VirtualHttpReader 适配成 zip.js Reader。
 * 继承 Reader 基类以获得基于 readUint8Array 的默认 createReadable() 实现。
 */
class ZipVirtualReader extends Reader<VirtualHttpReader> {
  private readonly reader: VirtualHttpReader

  constructor(reader: VirtualHttpReader) {
    super(reader)
    this.reader = reader
    this.size = reader.size
  }

  async init() {
    // zip.js Reader 接口允许 init。
  }

  async readUint8Array(index: number, length: number): Promise<Uint8Array> {
    return this.reader.read(index, length)
  }

  createReadable(options: { offset?: number, size?: number } = {}): ReadableStream<Uint8Array> {
    const { offset = 0, size = this.size - offset } = options
    const reader = this.reader
    let position = 0

    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (position >= size) {
          controller.close()
          return
        }
        const length = Math.min(READ_CHUNK_SIZE, size - position)
        const data = await reader.read(offset + position, length)
        if (data.length === 0) {
          controller.close()
          return
        }
        controller.enqueue(data)
        position += data.length
      },
    })
  }
}

/**
 * 通过 HEAD 获取每个分片的大小，组装为虚拟连续文件的 Part 列表。
 * `size > 0` 时直接使用（versions.json 中部分分卷 size 为 -1，需 HEAD）。
 */
async function buildParts(pkgs: PkgFile[], signal?: AbortSignal): Promise<Part[]> {
  const parts: Part[] = []
  let start = 0

  for (const pkg of pkgs) {
    let size = pkg.size
    if (!Number.isSafeInteger(size) || size <= 0) {
      const response = await fetch(toRequestUrl(pkg.url), { method: 'HEAD', signal })
      if (!response.ok)
        throw new Error(`HEAD ${pkg.url}: HTTP ${response.status} ${response.statusText}`)
      const contentLength = response.headers.get('content-length')
      if (!contentLength)
        throw new Error(`Missing Content-Length: ${pkg.url}`)
      size = Number(contentLength)
      if (!Number.isSafeInteger(size) || size <= 0)
        throw new Error(`Invalid Content-Length: ${pkg.url}`)
    }

    parts.push({ url: pkg.url, size, start, end: start + size })
    start += size
  }

  return parts
}

/** 由分卷列表派生稳定的缓存 key（用首分卷的 name/url 标识同一压缩包） */
function getZipDirCacheKey(gameId: string, version: string, pkgs: PkgFile[]): string {
  const first = pkgs[0]
  const identity = first ? `${first.name}_${first.url}` : 'unknown'
  return `${gameId}_${version}_${identity}`
}

/**
 * 打开 ZIP 并读取中央目录。
 * 若 IDB 已有该压缩包的中央目录缓存则直接注入（重复提取不再重读中央目录）；
 * 否则在 getEntries() 后把中央目录区间写回 IDB。
 */
async function openZip(
  pkgs: PkgFile[],
  cacheKey: string,
  signal?: AbortSignal,
): Promise<{ reader: ZipReader<VirtualHttpReader>, entries: Awaited<ReturnType<ZipReader<VirtualHttpReader>['getEntries']>> }> {
  const parts = await buildParts(pkgs, signal)
  const cached = await getZipDir(cacheKey)
  const virtualReader = new VirtualHttpReader(parts, cached ?? null)
  const reader = new ZipReader(new ZipVirtualReader(virtualReader))

  try {
    const entries = await reader.getEntries()

    // 缓存中央目录原始字节（仅首次需要额外读取一次）
    if (!cached && reader.directoryOffset !== undefined && reader.directoryLength) {
      const data = await virtualReader.read(reader.directoryOffset, reader.directoryLength)
      await setZipDir(cacheKey, reader.directoryOffset, data)
    }

    return { reader, entries }
  }
  catch (error) {
    await reader.close()
    throw error
  }
}

/**
 * 从 ZIP 中提取单个文件（精确匹配 entry.filename === filename），返回完整字节。
 * 用于普通文件下载与 USM 导出 MKV。
 */
export async function extractZipFile(
  pkgs: PkgFile[],
  filename: string,
  cacheKey: string,
  signal?: AbortSignal,
  onProgress?: (received: number, total: number) => void,
): Promise<Uint8Array> {
  const { reader, entries } = await openZip(pkgs, cacheKey, signal)

  try {
    const entry = entries.find(e => e.filename === filename)
    if (!entry)
      throw new Error(`ZIP 中未找到文件：${filename}`)
    if (entry.directory)
      throw new Error(`${filename} 是目录`)

    const data = await entry.getData(new Uint8ArrayWriter(), {
      onprogress: (index, max) => onProgress?.(index, max),
    })
    return data
  }
  finally {
    await reader.close()
  }
}

/**
 * 从 ZIP 中流式提取单个文件，逐块回调解压后的数据（供 USM 流式解码）。
 * 注意：不能手动锁定传入 zip.js 的 WritableStream（zip.js 内部会 pipeTo 它），
 * 因此这里用自定义 WritableStream 的 write 回调逐块消费。
 * `onChunk` 回调携带累计解压字节数 `received` 与文件总大小 `total`（用于进度展示）。
 */
export async function streamZipFile(
  pkgs: PkgFile[],
  filename: string,
  cacheKey: string,
  signal: AbortSignal,
  onChunk: (decompressed: Uint8Array, received: number, total: number) => void | Promise<void>,
  skipBytes = 0,
): Promise<void> {
  const { reader, entries } = await openZip(pkgs, cacheKey, signal)

  try {
    const entry = entries.find(e => e.filename === filename)
    if (!entry)
      throw new Error(`ZIP 中未找到文件：${filename}`)
    if (entry.directory)
      throw new Error(`${filename} 是目录`)

    const total = entry.uncompressedSize
    let received = 0
    let skipRemaining = skipBytes

    const writable = new WritableStream<Uint8Array>({
      write(chunk) {
        if (signal.aborted)
          return
        // seek：丢弃前 skipBytes 字节（仍会从 entry 头部解压，仅丢弃输出）
        if (skipRemaining > 0) {
          if (skipRemaining >= chunk.byteLength) {
            skipRemaining -= chunk.byteLength
            return
          }
          chunk = chunk.slice(skipRemaining)
          skipRemaining = 0
        }
        received += chunk.byteLength
        return onChunk(chunk, received, total)
      },
    })

    await entry.getData(writable)
  }
  finally {
    await reader.close()
  }
}

/* -------------------------------------------------------------------------- */
/* 来源标注 helper（Files.vue 与 VersionCompare.vue 共用）                    */
/* -------------------------------------------------------------------------- */

/** 取游戏包 ZIP 来源：`game.full` 优先，否则 `game.segments` */
export function getGameZipSource(vd: VersionData | null | undefined): ZipSource | null {
  if (!vd)
    return null
  if (vd.game?.full) {
    return { label: '游戏包', parts: [vd.game.full] }
  }
  if (vd.game?.segments?.length) {
    return { label: `游戏包分卷`, parts: vd.game.segments }
  }
  return null
}

/** 取指定语言的语音包 ZIP 来源 */
export function getVoiceZipSource(vd: VersionData | null | undefined, lang: string): ZipSource | null {
  const pkg = vd?.voice?.[lang as keyof typeof vd.voice]
  if (!pkg)
    return null
  return { label: `语音包（${lang}）`, parts: [pkg] }
}

/** 给文件列表标注 ZIP 来源；source 为 null 时原样返回 */
export function annotateZipSource(files: GameFileRecord[], source: ZipSource | null): GameFileRecord[] {
  if (!source)
    return files
  return files.map(file => ({ ...file, zipSource: source }))
}

export { getZipDirCacheKey }
