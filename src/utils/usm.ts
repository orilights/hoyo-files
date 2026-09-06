/**
 * USM WASM 解码器的 Web Worker 封装。
 * 解码（push/finish/decode_usm_to_mkv）是 CPU 密集的同步 WASM 调用，
 * 移入 worker 避免阻塞主线程；PCM 数据在 worker 内已转换为 Float32 平面。
 */

export interface UsmPcmPlaneChunk {
  channel: number
  sample_rate: number
  channel_count: number
  timestamp_ms: number
  planes: Float32Array[]
}

export interface UsmHcaHeader {
  channel: number
  header: Uint8Array
}

export interface UsmPushResult {
  init_segment: Uint8Array | null
  clusters: Uint8Array[]
  audio_pcm_chunks: UsmPcmPlaneChunk[]
  duration_ms: number | null
  ivf_header: Uint8Array | null
  hca_headers: UsmHcaHeader[]
  keyframes: number[]
}

export interface UsmResetChannel {
  channel: number
  header: Uint8Array
  skip: number
}

export interface UsmStreamDecoderProxy {
  push: (data: Uint8Array) => Promise<UsmPushResult>
  finish: () => Promise<UsmPushResult>
  reset: (ivfHeader: Uint8Array, channels: UsmResetChannel[], baseOffset: number) => Promise<void>
  free: () => Promise<void>
}

interface UsmStreamDecoderProxyInternal extends UsmStreamDecoderProxy {
  _resolvePush?: (r: UsmPushResult) => void
  _rejectPush?: (e: Error) => void
  _resolveFinish?: (r: UsmPushResult) => void
  _rejectFinish?: (e: Error) => void
}

export interface UsmAudioChannel {
  channel: number
  wav: Uint8Array
}

export interface DecodeUsmResult {
  videoWebm: Uint8Array
  audioChannels: UsmAudioChannel[]
}

let worker: Worker | null = null
let nextSessionId = 1
let nextRequestId = 1

const sessionProxies = new Map<number, UsmStreamDecoderProxyInternal>()
const pending = new Map<number, {
  resolve: (data: any) => void
  reject: (error: Error) => void
}>()

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('../workers/usm.worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (event: MessageEvent) => {
      const msg = event.data
      if (msg.type === 'pushed' || msg.type === 'finished') {
        const proxy = sessionProxies.get(msg.sessionId)
        if (proxy) {
          const result: UsmPushResult = {
            init_segment: msg.result.init_segment ? new Uint8Array(msg.result.init_segment) : null,
            clusters: (msg.result.clusters ?? []).map((c: ArrayBuffer) => new Uint8Array(c)),
            audio_pcm_chunks: (msg.result.audio_pcm_chunks ?? []).map((p: any) => ({
              channel: p.channel,
              sample_rate: p.sample_rate,
              channel_count: p.channel_count,
              timestamp_ms: p.timestamp_ms,
              planes: (p.planes ?? []).map((buf: ArrayBuffer) => new Float32Array(buf)),
            })),
            duration_ms: msg.result.duration_ms ?? null,
            ivf_header: msg.result.ivf_header ? new Uint8Array(msg.result.ivf_header) : null,
            hca_headers: (msg.result.hca_headers ?? []).map((h: any) => ({
              channel: h.channel,
              header: new Uint8Array(h.header),
            })),
            keyframes: msg.result.keyframes ?? [],
          }
          if (msg.type === 'pushed')
            proxy._resolvePush?.(result)
          else
            proxy._resolveFinish?.(result)
        }
        return
      }
      if (msg.type === 'mkv') {
        const entry = pending.get(msg.id)
        if (entry) {
          pending.delete(msg.id)
          entry.resolve(new Uint8Array(msg.data))
        }
        return
      }
      if (msg.type === 'error') {
        const error = new Error(msg.message ?? 'USM 解码失败')
        if (msg.id !== undefined) {
          const entry = pending.get(msg.id)
          if (entry) {
            pending.delete(msg.id)
            entry.reject(error)
          }
        }
        if (msg.sessionId !== undefined) {
          const proxy = sessionProxies.get(msg.sessionId)
          if (proxy) {
            proxy._rejectPush?.(error)
            proxy._rejectFinish?.(error)
          }
        }
      }
    }
    worker.onerror = (event) => {
      const error = new Error(event.message || 'USM worker 错误')
      for (const [, entry] of pending)
        entry.reject(error)
      pending.clear()
      for (const [, proxy] of sessionProxies) {
        proxy._rejectPush?.(error)
        proxy._rejectFinish?.(error)
      }
    }
  }
  return worker
}

/** 若 data 是子视图（byteOffset ≠ 0 或 byteLength ≠ buffer.byteLength），先拷贝成整块再 transfer */
function toTransferable(data: Uint8Array): ArrayBuffer {
  if (data.byteOffset === 0 && data.byteLength === data.buffer.byteLength)
    return data.buffer as ArrayBuffer
  return data.slice().buffer as ArrayBuffer
}

/**
 * 创建流式解码会话代理。
 * `push` 返回的 `audio_pcm_chunks` 中 `planes` 为 Float32 平面（每声道一个），
 * 主线程可直接 copyToChannel 到 AudioBuffer。
 */
export async function getUsmStreamDecoder(keyHex: string): Promise<UsmStreamDecoderProxy> {
  const w = getWorker()
  const sessionId = nextSessionId++

  let resolvePush: ((r: UsmPushResult) => void) | null = null
  let rejectPush: ((e: Error) => void) | null = null
  let resolveFinish: ((r: UsmPushResult) => void) | null = null
  let rejectFinish: ((e: Error) => void) | null = null

  const proxy: UsmStreamDecoderProxyInternal = {
    push(data: Uint8Array) {
      return new Promise<UsmPushResult>((resolve, reject) => {
        resolvePush = resolve
        rejectPush = reject
        const transferable = toTransferable(data)
        w.postMessage({ type: 'push', sessionId, data: transferable }, [transferable])
      })
    },
    finish() {
      return new Promise<UsmPushResult>((resolve, reject) => {
        resolveFinish = resolve
        rejectFinish = reject
        w.postMessage({ type: 'finish', sessionId })
      })
    },
    async reset(ivfHeader: Uint8Array, channels: UsmResetChannel[], baseOffset: number) {
      // 缓存头需在后续 seek 复用，而 transfer 会 detach 原 buffer，
      // 因此这里必须拷贝副本再转移，避免第二次 seek 复用已 detached 的缓冲。
      const ivfBuf = ivfHeader.slice().buffer as ArrayBuffer
      const chanBufs = channels.map(c => ({
        channel: c.channel,
        header: c.header.slice().buffer as ArrayBuffer,
        skip: c.skip,
      }))
      const transfer = [ivfBuf, ...chanBufs.map(c => c.header)]
      w.postMessage({ type: 'reset', sessionId, ivfHeader: ivfBuf, channels: chanBufs, baseOffset }, transfer)
    },
    async free() {
      w.postMessage({ type: 'free', sessionId })
      sessionProxies.delete(sessionId)
    },
  }

  proxy._resolvePush = (r) => {
    resolvePush?.(r)
    resolvePush = null
    rejectPush = null
  }
  proxy._rejectPush = (e) => {
    rejectPush?.(e)
    resolvePush = null
    rejectPush = null
  }
  proxy._resolveFinish = (r) => {
    resolveFinish?.(r)
    resolveFinish = null
    rejectFinish = null
  }
  proxy._rejectFinish = (e) => {
    rejectFinish?.(e)
    resolveFinish = null
    rejectFinish = null
  }

  sessionProxies.set(sessionId, proxy)
  w.postMessage({ type: 'createDecoder', sessionId, keyHex })
  return proxy
}

/** 整段解码为 WebM（当前无调用方，保留导出以兼容） */
export async function decodeUsm(data: Uint8Array, keyHex: string): Promise<DecodeUsmResult> {
  const dec = await getUsmStreamDecoder(keyHex)
  await dec.push(data)
  const finalResult = await dec.finish()
  await dec.free()

  const videoWebm = finalResult.init_segment
    ? concatBytes([finalResult.init_segment, ...finalResult.clusters])
    : concatBytes(finalResult.clusters)

  return {
    videoWebm,
    audioChannels: [],
  }
}

/** 整段解码为 MKV（导出用），在 worker 中执行 */
export async function decodeUsmToMkv(data: Uint8Array, keyHex: string, chIndex: number | null | undefined, audioCodec: 'wav' | 'flac'): Promise<Uint8Array> {
  const w = getWorker()
  const id = nextRequestId++
  const transferable = toTransferable(data)

  return new Promise<Uint8Array>((resolve, reject) => {
    pending.set(id, { resolve, reject })
    w.postMessage({ type: 'decodeMkv', id, data: transferable, keyHex, chIndex, audioCodec }, [transferable])
  })
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((s, p) => s + p.length, 0)
  const result = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    result.set(part, offset)
    offset += part.length
  }
  return result
}
