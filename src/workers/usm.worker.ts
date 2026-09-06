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

interface ResetChannel {
  channel: number
  header: ArrayBuffer
  skip: number
}

interface ResetRequest {
  type: 'reset'
  sessionId: number
  ivfHeader: ArrayBuffer
  channels: ResetChannel[]
  baseOffset: number
}

interface DecodeMkvRequest {
  type: 'decodeMkv'
  id: number
  data: ArrayBuffer
  keyHex: string
  chIndex?: number | null
  audioCodec: 'wav' | 'flac'
}

type WorkerRequest = CreateDecoderRequest | PushRequest | FinishRequest | FreeRequest | ResetRequest | DecodeMkvRequest

interface PcmPlaneChunk {
  channel: number
  sample_rate: number
  channel_count: number
  timestamp_ms: number
  planes: Float32Array[]
}

interface HcaHeaderOut {
  channel: number
  header: Uint8Array
}

interface PushResult {
  init_segment: Uint8Array | null
  clusters: Uint8Array[]
  audio_pcm_chunks: PcmPlaneChunk[]
  duration_ms: number | null
  ivf_header: Uint8Array | null
  hca_headers: HcaHeaderOut[]
  keyframes: number[]
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
let flacReady: Promise<any> | null = null

function initWasm(): Promise<void> {
  if (!wasmReady) {
    wasmReady = (async () => {
      const mod = await import('@/assets/usm/usm_decoder.js')
      await mod.default()
    })()
  }
  return wasmReady
}

async function getFlac() {
  if (!flacReady) {
    flacReady = import('libflacjs/dist/libflac.js').then(async (flacModule) => {
      const Flac = (flacModule as any).default ?? flacModule
      if (!Flac.isReady())
        await new Promise<void>(resolve => Flac.on('ready', resolve))
      return Flac
    })
  }
  return flacReady
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.byteLength
  }
  return out
}

async function encodeFlacTrack(track: any) {
  const Flac = await getFlac()
  const pcmBytes = new Uint8Array(track.pcm_i16_bytes)
  const pcm = new Int16Array(pcmBytes.buffer, pcmBytes.byteOffset, pcmBytes.byteLength / 2)
  const channels = Number(track.channel_count)
  const totalSamples = pcm.length / channels
  const chunks: Uint8Array[] = []
  const encoderId = Flac.create_libflac_encoder(
    Number(track.sample_rate),
    channels,
    16,
    5,
    totalSamples,
  )
  if (!encoderId)
    throw new Error('libflac.js 编码器创建失败')
  try {
    const initState = Flac.init_encoder_stream(
      encoderId,
      (data: Uint8Array) => chunks.push(new Uint8Array(data)),
      () => {},
    )
    if (initState !== 0)
      throw new Error(`libflac.js 编码器初始化失败（state=${initState}）`)
    const framesPerPush = 16384
    for (let frame = 0; frame < totalSamples; frame += framesPerPush) {
      const count = Math.min(framesPerPush, totalSamples - frame)
      const input = new Int32Array(count * channels)
      const start = frame * channels
      for (let i = 0; i < input.length; i++)
        input[i] = pcm[start + i]
      if (!Flac.FLAC__stream_encoder_process_interleaved(encoderId, input, count))
        throw new Error(`libflac.js 编码失败（frame=${frame}）`)
    }
    if (!Flac.FLAC__stream_encoder_finish(encoderId))
      throw new Error('libflac.js 无法结束编码流')

    const firstFrame = chunks.findIndex(chunk => chunk.length >= 2 && chunk[0] === 0xFF && (chunk[1] & 0xFC) === 0xF8)
    if (firstFrame <= 0)
      throw new Error('libflac.js 未产出有效 FLAC 帧')
    const codecPrivate = concatBytes(chunks.slice(0, firstFrame))
    if (codecPrivate.length < 12 || String.fromCharCode(...codecPrivate.slice(0, 4)) !== 'fLaC')
      throw new Error('libflac.js 产出的 FLAC metadata 无效')
    const minBlockSize = (codecPrivate[8] << 8) | codecPrivate[9]
    const maxBlockSize = (codecPrivate[10] << 8) | codecPrivate[11]
    if (minBlockSize !== maxBlockSize)
      throw new Error(`暂不支持可变 FLAC block size：${minBlockSize}-${maxBlockSize}`)
    return {
      channel: Number(track.channel),
      sample_rate: Number(track.sample_rate),
      channel_count: channels,
      samples_per_frame: maxBlockSize,
      codec_private: codecPrivate,
      frames: chunks.slice(firstFrame),
    }
  }
  finally {
    Flac.FLAC__stream_encoder_delete(encoderId)
  }
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
    timestamp_ms: Number(pcm.timestamp_ms),
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
  if (result.ivf_header)
    transfer.push(result.ivf_header.buffer as ArrayBuffer)
  for (const h of result.hca_headers)
    transfer.push(h.header.buffer as ArrayBuffer)
  return transfer
}

/** 把 WASM push/finish 原始结果转换为可传输的 PushResult */
function toPushResult(raw: any): PushResult {
  return {
    init_segment: raw.init_segment ? new Uint8Array(raw.init_segment) : null,
    clusters: (raw.clusters ?? []).map((c: Uint8Array) => new Uint8Array(c)),
    audio_pcm_chunks: (raw.audio_pcm_chunks ?? []).map(convertPcmToPlanes),
    duration_ms: typeof raw.duration_ms === 'number' ? raw.duration_ms : null,
    ivf_header: raw.ivf_header ? new Uint8Array(raw.ivf_header) : null,
    hca_headers: (raw.hca_headers ?? []).map((h: any) => ({
      channel: h.channel,
      header: new Uint8Array(h.header),
    })),
    keyframes: Array.isArray(raw.keyframes) ? Array.from(raw.keyframes) : [],
  }
}

const sessions = new Map<number, any>()
/** sessionId → 创建完成 promise；push/finish 需等待对应 session 创建完成，避免首次播放时 createDecoder 尚未完成（wasm 初始化慢）导致竞态 */
const sessionReady = new Map<number, Promise<void>>()

async function waitSessionReady(sessionId: number): Promise<any> {
  const ready = sessionReady.get(sessionId)
  if (ready)
    await ready
  return sessions.get(sessionId)
}

globalThis.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data

  try {
    await initWasm()

    if (msg.type === 'createDecoder') {
      // 先注册 ready promise（在 await 之前），让后续 push/finish 可以等待创建完成
      let resolveReady!: () => void
      const ready = new Promise<void>((resolve) => {
        resolveReady = resolve
      })
      sessionReady.set(msg.sessionId, ready)
      try {
        const { UsmStreamDecoder } = await import('@/assets/usm/usm_decoder.js')
        const dec = new UsmStreamDecoder(msg.keyHex)
        // 若创建期间已被 free，则释放刚创建的 decoder，避免泄漏
        if (!sessionReady.has(msg.sessionId)) {
          try {
            dec.free()
          }
          catch {}
          return
        }
        sessions.set(msg.sessionId, dec)
        resolveReady()
      }
      catch (error) {
        sessionReady.delete(msg.sessionId)
        resolveReady()
        throw error
      }
      return
    }

    if (msg.type === 'push') {
      const dec = await waitSessionReady(msg.sessionId)
      if (!dec)
        throw new Error(`USM 解码会话不存在：${msg.sessionId}`)
      const raw = dec.push(new Uint8Array(msg.data))
      const result: PushResult = toPushResult(raw)
      const response: PushResponse = { type: 'pushed', sessionId: msg.sessionId, result }
      globalThis.postMessage(response, collectTransferables(result))
      return
    }

    if (msg.type === 'finish') {
      const dec = await waitSessionReady(msg.sessionId)
      if (!dec)
        throw new Error(`USM 解码会话不存在：${msg.sessionId}`)
      const raw = dec.finish()
      const result: PushResult = toPushResult(raw)
      const response: FinishResponse = { type: 'finished', sessionId: msg.sessionId, result }
      globalThis.postMessage(response, collectTransferables(result))
      return
    }

    if (msg.type === 'reset') {
      const dec = await waitSessionReady(msg.sessionId)
      if (!dec)
        throw new Error(`USM 解码会话不存在：${msg.sessionId}`)
      const channels = msg.channels.map(c => ({
        channel: c.channel,
        header: new Uint8Array(c.header),
        skip: c.skip,
      }))
      dec.reset(new Uint8Array(msg.ivfHeader), channels, BigInt(msg.baseOffset))
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
      sessionReady.delete(msg.sessionId)
      return
    }

    if (msg.type === 'decodeMkv') {
      const wasm = await import('@/assets/usm/usm_decoder.js')
      let mkv: Uint8Array
      if (msg.audioCodec === 'flac') {
        const prepared = wasm.prepare_usm_mkv(new Uint8Array(msg.data), msg.keyHex, msg.chIndex ?? undefined) as any
        const tracks = []
        for (const track of prepared.audio_tracks)
          tracks.push(await encodeFlacTrack(track))
        mkv = wasm.mux_ivf_flac_to_mkv(prepared.ivf, tracks) as Uint8Array
      }
      else {
        mkv = wasm.decode_usm_to_mkv(new Uint8Array(msg.data), msg.keyHex, msg.chIndex ?? undefined) as Uint8Array
      }
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
