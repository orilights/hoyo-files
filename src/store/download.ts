import type { ChunkManifest, DownloadStatus, DownloadTask, GameFileRecord, ParsedFile, ZipSource } from '@/types'
import { defineStore } from 'pinia'
import { API_BASE } from '@/constants/core'
import { downloadChunks } from '@/utils/chunk'
import { fetchAndParseManifest } from '@/utils/manifest'
import { decodeUsmToMkv } from '@/utils/usm'
import { extractZipFile, getZipDirCacheKey } from '@/utils/zip'

const MAX_CONCURRENT = 3

function makeId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function triggerDownload(filename: string, data: Uint8Array | string, mimeType: string) {
  const blobPart = typeof data === 'string' ? data : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
  const blob = new Blob([blobPart], { type: mimeType })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 30000)
}

export const useDownload = defineStore('download', () => {
  const tasks = ref<DownloadTask[]>([])
  const isListOpen = ref(false)
  const controllers = new Map<string, AbortController>()

  const downloadingCount = computed(
    () => tasks.value.filter(t => t.status === 'downloading').length,
  )

  const activeCount = computed(
    () => tasks.value.filter(t => t.status === 'pending' || t.status === 'downloading' || t.status === 'decompressing' || t.status === 'merging').length,
  )

  function openList() {
    isListOpen.value = true
  }
  function closeList() {
    isListOpen.value = false
  }
  function toggleList() {
    isListOpen.value = !isListOpen.value
  }

  function clearCompleted() {
    tasks.value = tasks.value.filter(
      t => t.status !== 'success' && t.status !== 'failed' && t.status !== 'cancelled',
    )
  }

  function setTaskStatus(id: string, status: DownloadStatus, error?: string) {
    const task = tasks.value.find(t => t.id === id)
    if (!task)
      return
    task.status = status
    if (error !== undefined)
      task.error = error
  }

  function setTaskProgress(id: string, progress: number) {
    const task = tasks.value.find(t => t.id === id)
    if (task)
      task.progress = progress
  }

  function cancelTask(id: string) {
    const task = tasks.value.find(t => t.id === id)
    if (!task)
      return
    if (task.status === 'pending') {
      task.status = 'cancelled'
      return
    }
    if (task.status === 'downloading') {
      controllers.get(id)?.abort()
      controllers.delete(id)
      task.status = 'cancelled'
      processQueue()
    }
  }

  function processQueue() {
    while (downloadingCount.value < MAX_CONCURRENT) {
      const pending = [...tasks.value].reverse().find(t => t.status === 'pending')
      if (!pending)
        break

      pending.status = 'downloading'
      executeTask(pending)
    }
  }

  async function executeTask(task: DownloadTask) {
    try {
      if (task.type === 'manifest-json') {
        await runManifestJsonTask(task)
      }
      else if (task.type === 'usm-mkv-export') {
        await runUsmMkvExportTask(task)
      }
      else if (task.type === 'zip-file') {
        await runZipFileTask(task)
      }
      else {
        await runChunkFileTask(task)
      }
    }
    catch (e) {
      if ((e as Error).name !== 'AbortError') {
        setTaskStatus(task.id, 'failed', (e as Error).message)
      }
    }
    finally {
      controllers.delete(task.id)
      processQueue()
    }
  }

  const manifestTaskData = new Map<string, {
    manifest: ChunkManifest
    gameId: string
    version: string
  }>()

  const chunkTaskData = new Map<string, {
    file: GameFileRecord
    manifests: ChunkManifest[]
    gameId: string
    version: string
  }>()

  const zipTaskData = new Map<string, {
    file: GameFileRecord
    gameId: string
    version: string
  }>()

  async function runManifestJsonTask(task: DownloadTask) {
    const data = manifestTaskData.get(task.id)
    if (!data)
      throw new Error('任务数据丢失')

    const { manifest, gameId, version } = data
    const url = `${manifest.manifest_download.url_prefix}/${manifest.manifest.id}`
    const cacheKey = `${gameId}_${version}_${manifest.manifest.id}`
    const uncompressedSize = Number(manifest.manifest.uncompressed_size)

    const controller = new AbortController()
    controllers.set(task.id, controller)

    if (tasks.value.find(t => t.id === task.id)?.status === 'cancelled')
      return

    setTaskStatus(task.id, 'decompressing')

    const parsed = await fetchAndParseManifest(url, cacheKey, uncompressedSize, controller.signal)

    if (tasks.value.find(t => t.id === task.id)?.status === 'cancelled')
      return

    const json = JSON.stringify(parsed, null, 2)
    triggerDownload(`${manifest.manifest.id}.json`, json, 'application/json')

    setTaskStatus(task.id, 'success')
    setTaskProgress(task.id, 100)
    manifestTaskData.delete(task.id)
  }

  async function runChunkFileTask(task: DownloadTask) {
    const data = chunkTaskData.get(task.id)
    if (!data)
      throw new Error('任务数据丢失')

    const { file, manifests, gameId, version } = data
    const controller = new AbortController()
    controllers.set(task.id, controller)

    if (tasks.value.find(t => t.id === task.id)?.status === 'cancelled')
      return

    let foundFile: ParsedFile | null = null
    let chunkUrlPrefix = ''

    for (const m of manifests) {
      const cacheKey = `${gameId}_${version}_${m.manifest.id}`
      const url = `${m.manifest_download.url_prefix}/${m.manifest.id}`
      const uncompressedSize = Number(m.manifest.uncompressed_size)

      let parsed
      try {
        parsed = await fetchAndParseManifest(url, cacheKey, uncompressedSize, controller.signal)
      }
      catch (e) {
        if ((e as Error).name === 'AbortError' || e instanceof TypeError)
          throw e
        continue
      }

      const match = parsed.files.find(f => f.path === file.remoteName)
      if (match) {
        foundFile = match
        chunkUrlPrefix = m.chunk_download.url_prefix
        break
      }

      if (tasks.value.find(t => t.id === task.id)?.status === 'cancelled')
        return
    }

    if (!foundFile) {
      chunkTaskData.delete(task.id)
      throw new Error('无可用资源')
    }

    if (tasks.value.find(t => t.id === task.id)?.status === 'cancelled')
      return

    const chunks = [...foundFile.chunks].sort((a, b) => a.offset - b.offset)
    const buffers: Uint8Array[] = []

    setTaskStatus(task.id, 'downloading')
    setTaskProgress(task.id, 0)

    await downloadChunks(chunks, chunkUrlPrefix, controller.signal, (decompressed, i, total) => {
      buffers.push(decompressed)
      setTaskProgress(task.id, Math.round(((i + 1) / total) * 90))
    })

    if (tasks.value.find(t => t.id === task.id)?.status === 'cancelled')
      return

    setTaskStatus(task.id, 'merging')

    const totalSize = buffers.reduce((s, b) => s + b.length, 0)
    const merged = new Uint8Array(totalSize)
    let offset = 0
    for (const buf of buffers) {
      merged.set(buf, offset)
      offset += buf.length
    }

    const filename = file.remoteName.slice(file.remoteName.lastIndexOf('/') + 1)
    triggerDownload(filename, merged, 'application/octet-stream')

    setTaskStatus(task.id, 'success')
    setTaskProgress(task.id, 100)
    chunkTaskData.delete(task.id)
  }

  function addManifestJsonTask(manifest: ChunkManifest, gameId: string, version: string) {
    const id = makeId()
    const task: DownloadTask = {
      id,
      type: 'manifest-json',
      status: 'pending',
      name: `${manifest.manifest.id}.json`,
      progress: 0,
    }
    manifestTaskData.set(id, { manifest, gameId, version })
    tasks.value.unshift(task)
    processQueue()
  }

  function addChunkFileTask(file: GameFileRecord, manifests: ChunkManifest[], gameId: string, version: string) {
    const id = makeId()
    const filename = file.remoteName.slice(file.remoteName.lastIndexOf('/') + 1)
    const task: DownloadTask = {
      id,
      type: 'chunk-file',
      status: 'pending',
      name: filename,
      progress: 0,
    }
    chunkTaskData.set(id, { file, manifests, gameId, version })
    tasks.value.unshift(task)
    processQueue()
  }

  async function runZipFileTask(task: DownloadTask) {
    const data = zipTaskData.get(task.id)
    if (!data)
      throw new Error('任务数据丢失')

    const { file, gameId, version } = data
    const zipSource = file.zipSource
    if (!zipSource)
      throw new Error('无可用 ZIP 来源')

    const controller = new AbortController()
    controllers.set(task.id, controller)
    const { signal } = controller

    if (tasks.value.find(t => t.id === task.id)?.status === 'cancelled')
      return

    const cacheKey = getZipDirCacheKey(gameId, version, zipSource.parts)
    const filename = file.remoteName.slice(file.remoteName.lastIndexOf('/') + 1)

    setTaskStatus(task.id, 'downloading')
    setTaskProgress(task.id, 0)

    const dataBytes = await extractZipFile(zipSource.parts, file.remoteName, cacheKey, signal, (received, total) => {
      if (total > 0)
        setTaskProgress(task.id, Math.round((received / total) * 100))
    })

    if (tasks.value.find(t => t.id === task.id)?.status === 'cancelled')
      return

    triggerDownload(filename, dataBytes, 'application/octet-stream')

    setTaskStatus(task.id, 'success')
    setTaskProgress(task.id, 100)
    zipTaskData.delete(task.id)
  }

  function addZipFileTask(file: GameFileRecord, gameId: string, version: string) {
    const id = makeId()
    const filename = file.remoteName.slice(file.remoteName.lastIndexOf('/') + 1)
    const task: DownloadTask = {
      id,
      type: 'zip-file',
      status: 'pending',
      name: filename,
      progress: 0,
    }
    zipTaskData.set(id, { file, gameId, version })
    tasks.value.unshift(task)
    processQueue()
  }

  const mkvExportTaskData = new Map<string, {
    filename: string
    filePath: string
    keyHex: string
    directDownloadUrl: string | null
    bestChunkVersion: string | null
    zipSource: ZipSource | null
    gameId: string
    version: string
    chIndex?: number
    manifests?: ChunkManifest[]
  }>()

  async function runUsmMkvExportTask(task: DownloadTask) {
    const data = mkvExportTaskData.get(task.id)
    if (!data)
      throw new Error('任务数据丢失')

    const { filename, filePath, keyHex, directDownloadUrl, bestChunkVersion, zipSource, gameId } = data
    const controller = new AbortController()
    controllers.set(task.id, controller)
    const { signal } = controller

    if (tasks.value.find(t => t.id === task.id)?.status === 'cancelled')
      return

    let usmBytes: Uint8Array

    if (directDownloadUrl) {
      setTaskStatus(task.id, 'downloading')
      setTaskProgress(task.id, 0)
      const res = await fetch(directDownloadUrl, { signal })
      if (!res.ok)
        throw new Error(`HTTP ${res.status}`)
      const total = Number(res.headers.get('Content-Length') ?? 0)
      const reader = res.body!.getReader()
      const buffers: Uint8Array[] = []
      let received = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done)
          break
        buffers.push(value)
        received += value.byteLength
        if (total > 0)
          setTaskProgress(task.id, Math.round((received / total) * 80))
      }
      const totalSize = buffers.reduce((s, b) => s + b.length, 0)
      usmBytes = new Uint8Array(totalSize)
      let off = 0
      for (const buf of buffers) {
        usmBytes.set(buf, off)
        off += buf.length
      }
    }
    else if (bestChunkVersion) {
      setTaskStatus(task.id, 'downloading')
      setTaskProgress(task.id, 0)

      let manifests = data.manifests
      if (!manifests) {
        const res = await fetch(`${API_BASE}/chunk/${gameId}_${bestChunkVersion}.json`, { signal })
        if (!res.ok)
          throw new Error(`Chunk 列表获取失败：HTTP ${res.status}`)
        const json = await res.json()
        manifests = json.data?.manifests ?? []
      }

      let chunkUrlPrefix = ''
      let foundFile: ParsedFile | null = null
      for (const m of manifests!) {
        if (signal.aborted)
          return
        const cacheKey = `${gameId}_${bestChunkVersion}_${m.manifest.id}`
        const url = `${m.manifest_download.url_prefix}/${m.manifest.id}`
        let parsed
        try {
          parsed = await fetchAndParseManifest(url, cacheKey, Number(m.manifest.uncompressed_size), signal)
        }
        catch (e) {
          if ((e as Error).name === 'AbortError' || e instanceof TypeError)
            throw e
          continue
        }
        const match = parsed.files.find(f => f.path === filePath)
        if (match) {
          foundFile = match
          chunkUrlPrefix = m.chunk_download.url_prefix
          break
        }
      }
      if (!foundFile)
        throw new Error('无可用资源')

      const chunks = [...foundFile.chunks].sort((a, b) => a.offset - b.offset)
      const buffers: Uint8Array[] = []

      await downloadChunks(chunks, chunkUrlPrefix, signal, (decompressed, i, total) => {
        buffers.push(decompressed)
        setTaskProgress(task.id, Math.round(((i + 1) / total) * 80))
      })

      if (tasks.value.find(t => t.id === task.id)?.status === 'cancelled')
        return

      setTaskStatus(task.id, 'merging')
      const totalSize = buffers.reduce((s, b) => s + b.length, 0)
      usmBytes = new Uint8Array(totalSize)
      let off = 0
      for (const buf of buffers) {
        usmBytes.set(buf, off)
        off += buf.length
      }
    }
    else if (zipSource) {
      setTaskStatus(task.id, 'downloading')
      setTaskProgress(task.id, 0)

      const cacheKey = getZipDirCacheKey(gameId, data.version ?? '', zipSource.parts)
      usmBytes = await extractZipFile(zipSource.parts, filePath, cacheKey, signal, (received, total) => {
        if (total > 0)
          setTaskProgress(task.id, Math.round((received / total) * 80))
      })
    }
    else {
      throw new Error('无可用下载源')
    }

    if (tasks.value.find(t => t.id === task.id)?.status === 'cancelled')
      return

    setTaskStatus(task.id, 'merging')
    setTaskProgress(task.id, 85)

    const mkvData = await decodeUsmToMkv(usmBytes!, keyHex, data.chIndex ?? undefined)
    const baseName = filename.replace(/\.usm$/i, '')
    triggerDownload(`${baseName}.mkv`, mkvData, 'video/x-matroska')

    setTaskStatus(task.id, 'success')
    setTaskProgress(task.id, 100)
    mkvExportTaskData.delete(task.id)
  }

  function addUsmMkvExportTask(params: {
    filename: string
    filePath: string
    keyHex: string
    directDownloadUrl: string | null
    bestChunkVersion: string | null
    zipSource: ZipSource | null
    gameId: string
    version: string
    chIndex?: number
  }) {
    const id = makeId()
    const baseName = params.filename.replace(/\.usm$/i, '')
    const task: DownloadTask = {
      id,
      type: 'usm-mkv-export',
      status: 'pending',
      name: `${baseName}.mkv`,
      progress: 0,
    }
    mkvExportTaskData.set(id, params)
    tasks.value.unshift(task)
    processQueue()
  }

  return {
    tasks,
    isListOpen,
    downloadingCount,
    activeCount,
    openList,
    closeList,
    toggleList,
    clearCompleted,
    cancelTask,
    addManifestJsonTask,
    addChunkFileTask,
    addZipFileTask,
    addUsmMkvExportTask,
  }
})
