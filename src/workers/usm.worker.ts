/// <reference lib="webworker" />

/**
 * USM WASM 解码器 worker。
 * 解码（push/finish/decode_usm_to_mkv）是 CPU 密集的同步 WASM 调用，移入 worker 避免阻塞主线程。
 * 同时把 PCM Int16 交织数据转换为 Float32 平面（每声道一个 Float32Array），
 * 主线程只需 copyToChannel 到 AudioBuffer。
 */

interface CreateDecoderRequest {
  type: 'createDecoder'
  sessionId: number
  keyHex: string
}

interface PushRequest {
  type: 'push'
  sessionId: number
  data: ArrayBuffer
}

interface FinishRequest {
  type: 'finish'
  sessionId: number
}

interface FreeRequest {
  type: 'free'
  sessionId: number
}

interface DecodeMkvRequest {
  type: 'decodeMkv'
  id: number
  data: ArrayBuffer
  keyHex: string
  chIndex?: number | null
}

type WorkerRequest = CreateDecoderRequest | PushRequest | FinishRequest | FreeRequest | DecodeMkvRequest

interface PcmPlaneChunk {
  channel: number
  sample_rate: number
  channel_count: number
  planes: Float32Array[]
}

interface PushResult {
  init_segment: Uint8Array | null
  clusters: Uint8Array[]
  audio_pcm_chunks: PcmPlaneChunk[]
}

interface PushResponse {
  type: 'pushed'
  sessionId: number
  result: PushResult
}

interface FinishResponse {
  type: 'finished'
  sessionId: number
  result: PushResult
}

interface DecodeMkvResponse {
  type: 'mkv'
  id: number
  data: ArrayBuffer
}

interface ErrorResponse {
  type: 'error'
  id?: number
  sessionId?: number
  message: string
}

let wasmReady: Promise<void> | null = null

function initWasm(): Promise<void> {
  if (!wasmReady) {
    wasmReady = (async () => {
      const mod = await import('@/assets/usm/usm_decoder.js')
      await mod.default()
    })()
  }
  return wasmReady
}

/** Int16 交织 PCM → Float32 平面（每声道一个 Float32Array），并 transfer 返回 */
function convertPcmToPlanes(pcm: any): PcmPlaneChunk {
  const i16 = new Int16Array(pcm.pcm_i16_bytes.buffer, pcm.pcm_i16_bytes.byteOffset, pcm.pcm_i16_bytes.byteLength / 2)
  const nc: number = pcm.channel_count
  const frames = i16.length / nc
  const planes: Float32Array[] = []
  for (let ch = 0; ch < nc; ch++) {
    const plane = new Float32Array(frames)
    for (let i = 0; i < frames; i++)
      plane[i] = i16[i * nc + ch] / 32768.0
    planes.push(plane)
  }
  return {
    channel: pcm.channel,
    sample_rate: pcm.sample_rate,
    channel_count: nc,
    planes,
  }
}

/** 把解码结果中的 Uint8Array 全部转为可 transfer 的 ArrayBuffer，并收集 transfer 列表 */
function collectTransferables(result: PushResult): ArrayBuffer[] {
  const transfer: ArrayBuffer[] = []
  if (result.init_segment) {
    transfer.push(result.init_segment.buffer as ArrayBuffer)
  }
  for (const c of result.clusters)
    transfer.push(c.buffer as ArrayBuffer)
  for (const pcm of result.audio_pcm_chunks) {
    for (const plane of pcm.planes)
      transfer.push(plane.buffer as ArrayBuffer)
  }
  return transfer
}

const sessions = new Map<number, any>()

globalThis.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data

  try {
    await initWasm()

    if (msg.type === 'createDecoder') {
      const { UsmStreamDecoder } = await import('@/assets/usm/usm_decoder.js')
      sessions.set(msg.sessionId, new UsmStreamDecoder(msg.keyHex))
      return
    }

    if (msg.type === 'push') {
      const dec = sessions.get(msg.sessionId)
      if (!dec)
        throw new Error(`USM 解码会话不存在：${msg.sessionId}`)
      const raw = dec.push(new Uint8Array(msg.data))
      const result: PushResult = {
        init_segment: raw.init_segment ? new Uint8Array(raw.init_segment) : null,
        clusters: (raw.clusters ?? []).map((c: Uint8Array) => new Uint8Array(c)),
        audio_pcm_chunks: (raw.audio_pcm_chunks ?? []).map(convertPcmToPlanes),
      }
      const response: PushResponse = { type: 'pushed', sessionId: msg.sessionId, result }
      globalThis.postMessage(response, collectTransferables(result))
      return
    }

    if (msg.type === 'finish') {
      const dec = sessions.get(msg.sessionId)
      if (!dec)
        throw new Error(`USM 解码会话不存在：${msg.sessionId}`)
      const raw = dec.finish()
      const result: PushResult = {
        init_segment: raw.init_segment ? new Uint8Array(raw.init_segment) : null,
        clusters: (raw.clusters ?? []).map((c: Uint8Array) => new Uint8Array(c)),
        audio_pcm_chunks: (raw.audio_pcm_chunks ?? []).map(convertPcmToPlanes),
      }
      const response: FinishResponse = { type: 'finished', sessionId: msg.sessionId, result }
      globalThis.postMessage(response, collectTransferables(result))
      return
    }

    if (msg.type === 'free') {
      const dec = sessions.get(msg.sessionId)
      if (dec) {
        try {
          dec.free()
        }
        catch {}
        sessions.delete(msg.sessionId)
      }
      return
    }

    if (msg.type === 'decodeMkv') {
      const { decode_usm_to_mkv } = await import('@/assets/usm/usm_decoder.js')
      const mkv = decode_usm_to_mkv(new Uint8Array(msg.data), msg.keyHex, msg.chIndex ?? undefined) as Uint8Array
      const response: DecodeMkvResponse = { type: 'mkv', id: msg.id, data: mkv.buffer as ArrayBuffer }
      globalThis.postMessage(response, [mkv.buffer as ArrayBuffer])
    }
  }
  catch (error) {
    const response: ErrorResponse = {
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
    }
    if ('sessionId' in msg)
      response.sessionId = msg.sessionId
    if ('id' in msg)
      response.id = msg.id
    globalThis.postMessage(response)
  }
}
