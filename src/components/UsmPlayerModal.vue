<script setup lang="ts">
import type { UsmSourceKind, ZipSource } from '@/types'
import type { UsmPushResult, UsmStreamDecoderProxy } from '@/utils/usm'
import type { UsmKeyframe, UsmScanStart } from '@/utils/usmScan'
import { AUDIO_LANG_LABELS, GameList } from '@/constants/core'
import { useSettings } from '@/store/settings'
import { getUsmStreamDecoder } from '@/utils/usm'
import { streamUsmFrom } from '@/utils/usmRange'
import { parseIvfFps, planScanStart, scanUsmKeyframes } from '@/utils/usmScan'

interface Props {
  filename: string
  keyHex: string
  sourceKind: UsmSourceKind
  directDownloadUrl: string | null
  bestChunkVersion: string | null
  zipSource: ZipSource | null
  zipVersion: string | null
  gameId: string
  filePath: string
}

const props = defineProps<Props>()
const emit = defineEmits<{ close: [] }>()

const videoRef = ref<HTMLVideoElement | null>(null)
const playerShellRef = ref<HTMLElement | null>(null)
const phase = ref<'init' | 'buffering' | 'playing' | 'error'>('init')
const errorMsg = ref('')
const progress = ref(0)
const showHelp = ref(false)
const progressLabel = ref('')

const audioChannelList = ref<number[]>([])
const currentChannel = ref(0)
const audioStatusText = ref('')

let mediaSource: MediaSource | null = null
let objectUrl: string | null = null

let audioCtx: AudioContext | null = null
let gainNode: GainNode | null = null
const settings = useSettings()

const audioVolume = computed({
  get: () => settings.usmPlayerVolume,
  set: (val: number) => { settings.usmPlayerVolume = val },
})

function getChannelLabel(ch: number): string {
  const langs = GameList.find(g => g.id === props.gameId)?.audioLangs ?? []
  return AUDIO_LANG_LABELS[langs[ch] ?? ''] ?? `通道 ${ch}`
}
watch(audioVolume, (val) => {
  if (gainNode)
    gainNode.gain.value = val
})

let hasAutoSwitched = false
watch(audioChannelList, (channels) => {
  if (hasAutoSwitched || channels.length === 0)
    return
  const langs = GameList.find(g => g.id === props.gameId)?.audioLangs ?? []
  const prefIdx = langs.indexOf(settings.usmDefaultAudioLang)
  if (prefIdx >= 0 && channels.includes(prefIdx)) {
    switchChannel(prefIdx)
    hasAutoSwitched = true
  }
}, { deep: true })

const audioPcmByChannel = new Map<number, any[]>()
let streamAudioNodes: AudioBufferSourceNode[] = []
let streamAudioActive = false
let streamAudioReady = false
let audioTimeBase = 0
let pendingPcmChunks: any[] = []
let audioTimestampCorrectionCount = 0
let maxAudioTimestampCorrectionMs = 0
let audioLateTrimCount = 0
let audioLateDropCount = 0
let maxAudioLateMs = 0

let videoAudioSyncCleanup: (() => void) | null = null

const ESTIMATE_THRESHOLD_MS = 30000
const bufferedProgress = ref(0)
const durationMs = ref<number | null>(null)
let ivfHeader: Uint8Array | null = null
const hcaHeaders = new Map<number, Uint8Array>()
const keyframes: Array<{ ptsMs: number, offset: number }> = []
// 已索引到的最大关键帧 ptsMs。关键帧 offset 与 ptsMs 随文件位置单调递增，
// 但 seek 回 0 重建解码器重新播放时会追加小 offset/小 ptsMs 到数组末尾，破坏升序，
// 故「是否需扫描」不能看末项，必须看已索引最大值。
let maxKeyframePtsMs = 0
let decoder: UsmStreamDecoderProxy | null = null
let sbRef: SourceBuffer | null = null
let sbQueueRef: ReturnType<typeof makeSourceBufferQueue> | null = null
let streamController: AbortController | null = null
let streamToken = 0
let manualSeeking = false
let queuedSeekMs: number | null = null

// ── 自绘进度条状态 ──────────────────────────────────────────────
const currentTimeMs = ref(0)
const isPlaying = ref(false)
const isDraggingSeek = ref(false)
const seekPreviewMs = ref(0)
const showControls = ref(true)
const CONTROLS_HIDE_DELAY_MS = 2800
let controlsHideTimer: ReturnType<typeof setTimeout> | null = null
const playProgressPercent = computed(() => {
  if (durationMs.value == null || durationMs.value <= 0)
    return 0
  const base = isDraggingSeek.value ? seekPreviewMs.value : currentTimeMs.value
  return Math.min(100, base / durationMs.value * 100)
})

// ── 调试面板状态 ──────────────────────────────────────────────
const showDebug = ref(false)
const debugTab = ref<'status' | 'log'>('status')
const debugText = ref('')
const copyState = ref<'idle' | 'ok' | 'fail'>('idle')
let loadedBytes = 0
let loadedChunksCount = 0
let clusterCount = 0
let initSegCount = 0
let audioChunkCount = 0
let seekCount = 0
let lastSeekInfo = ''
let debugTimer: ReturnType<typeof setInterval> | null = null
let scanController: AbortController | null = null

// ── 事件日志 ──────────────────────────────────────────────
const MAX_LOG_ENTRIES = 500
const logEntries = ref<Array<{ time: string, msg: string }>>([])
const logText = computed(() => {
  if (logEntries.value.length === 0)
    return '（暂无日志）'
  return logEntries.value.map(e => `[${e.time}] ${e.msg}`).join('\n')
})

function log(msg: string) {
  const now = new Date()
  const time = `${now.toLocaleTimeString()}.${String(now.getMilliseconds()).padStart(3, '0')}`
  logEntries.value.push({ time, msg })
  if (logEntries.value.length > MAX_LOG_ENTRIES)
    logEntries.value.splice(0, logEntries.value.length - MAX_LOG_ENTRIES)
}

// ── 扫描遮罩状态 ──────────────────────────────────────────────
const isScanning = ref(false)
const scanProgressText = ref('')

const mimeType = 'video/webm; codecs="vp9"'
const MAX_SOURCE_BUFFER_QUEUE_BYTES = 16 * 1024 * 1024
const MAX_BUFFER_AHEAD_SECONDS = 18
const MAX_PAUSED_BUFFER_AHEAD_SECONDS = 45

function makeSourceBufferQueue(sb: SourceBuffer, video: HTMLVideoElement) {
  const queue: Uint8Array[] = []
  const stateWaiters: Array<() => void> = []
  let queuedBytes = 0
  let activeOp: 'append' | null = null
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let fatalError: Error | null = null
  let quotaRetryCount = 0

  function notifyStateChange() {
    while (stateWaiters.length)
      stateWaiters.shift()?.()
  }

  function scheduleRetry() {
    if (retryTimer !== null)
      return
    retryTimer = setTimeout(() => {
      retryTimer = null
      notifyStateChange()
      drain()
    }, 50)
  }

  function getBufferedAhead() {
    const currentTime = video.currentTime
    const { buffered } = sb

    for (let i = 0; i < buffered.length; i++) {
      const start = buffered.start(i)
      const end = buffered.end(i)

      if (end <= currentTime)
        continue
      if (start <= currentTime + 0.1)
        return end - currentTime
      return end - start
    }

    return 0
  }

  function drain() {
    if (fatalError || activeOp !== null || sb.updating)
      return

    if (!queue.length) {
      notifyStateChange()
      return
    }

    activeOp = 'append'

    try {
      sb.appendBuffer(queue[0] as BufferSource)
    }
    catch (error) {
      activeOp = null

      if (error instanceof DOMException && error.name === 'QuotaExceededError') {
        quotaRetryCount++
        log(`[MSE] SourceBuffer 空间不足，第 ${quotaRetryCount} 次等待重试`)
        scheduleRetry()
        return
      }

      fatalError = error instanceof Error ? error : new Error(String(error))
      notifyStateChange()
    }
  }

  sb.addEventListener('updateend', () => {
    if (activeOp === 'append') {
      const appended = queue.shift()
      if (appended)
        queuedBytes -= appended.byteLength
    }
    activeOp = null
    notifyStateChange()
    drain()
  })

  async function waitForStateChange(signal: AbortSignal) {
    if (signal.aborted)
      return

    await new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout>
      let onStateChange: () => void
      let onAbort: () => void

      const cleanup = () => {
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        const index = stateWaiters.indexOf(onStateChange)
        if (index >= 0)
          stateWaiters.splice(index, 1)
      }
      onStateChange = () => {
        cleanup()
        resolve()
      }
      onAbort = () => {
        cleanup()
        resolve()
      }
      timer = setTimeout(() => {
        cleanup()
        resolve()
      }, 120)

      stateWaiters.push(onStateChange)
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  return {
    append(data: Uint8Array) {
      if (fatalError)
        throw fatalError

      const copy = data.slice()
      queue.push(copy)
      queuedBytes += copy.byteLength
      drain()
    },
    async waitForCapacity(signal: AbortSignal) {
      while (!signal.aborted) {
        if (fatalError)
          throw fatalError

        const maxBufferedAhead = video.paused ? MAX_PAUSED_BUFFER_AHEAD_SECONDS : MAX_BUFFER_AHEAD_SECONDS
        if (queuedBytes <= MAX_SOURCE_BUFFER_QUEUE_BYTES && getBufferedAhead() < maxBufferedAhead)
          return

        await waitForStateChange(signal)
      }
    },
    async waitDrained(signal: AbortSignal) {
      while (!signal.aborted) {
        if (fatalError)
          throw fatalError
        if (activeOp === null && !sb.updating && queue.length === 0 && retryTimer === null)
          return

        await waitForStateChange(signal)
      }
    },
    getStats() {
      return {
        queueLength: queue.length,
        queuedBytes,
        activeOp,
        retry: retryTimer !== null,
        quotaRetryCount,
        fatalError: fatalError?.message ?? null,
      }
    },
  }
}

function audioChunkStartMs(chunk: any): number {
  return chunk.playback_timestamp_ms ?? chunk.timestamp_ms
}

function audioChunkDurationMs(chunk: any): number {
  return (chunk.planes[0]?.length ?? 0) * 1000 / chunk.sample_rate
}

function scheduleOnePcmChunk(chunk: any) {
  if (!audioCtx)
    return
  const sr: number = chunk.sample_rate
  const nc: number = chunk.channel_count
  const frameCount = chunk.planes[0]?.length ?? 0
  if (frameCount === 0)
    return
  const t = audioTimeBase + audioChunkStartMs(chunk) / 1000
  const duration = frameCount / sr
  const lateBy = Math.max(0, audioCtx.currentTime - t)
  if (lateBy >= duration) {
    audioLateDropCount++
    maxAudioLateMs = Math.max(maxAudioLateMs, lateBy * 1000)
    return
  }
  if (lateBy > 0) {
    audioLateTrimCount++
    maxAudioLateMs = Math.max(maxAudioLateMs, lateBy * 1000)
  }
  const abuf = audioCtx.createBuffer(nc, frameCount, sr)
  // worker 已把 Int16 交织 PCM 转为 Float32 平面，这里直接 memcpy 到 AudioBuffer
  for (let ch = 0; ch < nc; ch++)
    abuf.copyToChannel(chunk.planes[ch], ch)
  const src = audioCtx.createBufferSource()
  src.buffer = abuf
  src.connect(gainNode ?? audioCtx.destination)
  // 块迟到时从正确的样本偏移开始，避免完整块延后播放并与下一块重叠。
  src.start(Math.max(t, audioCtx.currentTime), lateBy)
  streamAudioNodes.push(src)
  src.onended = () => {
    const index = streamAudioNodes.indexOf(src)
    if (index >= 0)
      streamAudioNodes.splice(index, 1)
    src.disconnect()
  }
}

function stopAllStreamNodes() {
  for (const node of streamAudioNodes) {
    try {
      node.stop(0)
    }
    catch {}
    node.disconnect()
  }
  streamAudioNodes.length = 0
}

function rescheduleStreamAudio() {
  if (!streamAudioActive || !streamAudioReady || !videoRef.value || !audioCtx)
    return
  stopAllStreamNodes()
  audioTimeBase = audioCtx.currentTime - videoRef.value.currentTime
  const vt = videoRef.value.currentTime
  const chunks = audioPcmByChannel.get(currentChannel.value) ?? []
  for (const chunk of chunks) {
    if ((audioChunkStartMs(chunk) + audioChunkDurationMs(chunk)) / 1000 >= vt - 0.05)
      scheduleOnePcmChunk(chunk)
  }
}

function feedAudioChunk(chunk: any) {
  const chNo: number = chunk.channel
  if (!audioPcmByChannel.has(chNo)) {
    audioPcmByChannel.set(chNo, [])
    if (!audioChannelList.value.includes(chNo))
      audioChannelList.value.push(chNo)
  }
  const chChunks = audioPcmByChannel.get(chNo)!
  const previous = chChunks[chChunks.length - 1]
  if (previous) {
    const expectedMs = audioChunkStartMs(previous) + audioChunkDurationMs(previous)
    const correctionMs = Math.abs(chunk.timestamp_ms - expectedMs)
    const discontinuityThresholdMs = Math.max(5, audioChunkDurationMs(chunk) / 2)
    if (correctionMs <= discontinuityThresholdMs) {
      chunk.playback_timestamp_ms = expectedMs
      if (correctionMs > 0.001) {
        audioTimestampCorrectionCount++
        maxAudioTimestampCorrectionMs = Math.max(maxAudioTimestampCorrectionMs, correctionMs)
      }
    }
    else {
      chunk.playback_timestamp_ms = chunk.timestamp_ms
      log(`[audio] 通道 ${chNo} 时间轴跳变 ${correctionMs.toFixed(3)}ms，重新锚定`)
    }
  }
  else {
    chunk.playback_timestamp_ms = chunk.timestamp_ms
  }
  chChunks.push(chunk)
  const cutoffMs = (videoRef.value?.currentTime ?? 0) * 1000 - 120000
  while (chChunks.length > 0 && audioChunkStartMs(chChunks[0]) < cutoffMs)
    chChunks.shift()
  if (chNo !== currentChannel.value)
    return
  if (streamAudioReady)
    scheduleOnePcmChunk(chunk)
  else
    pendingPcmChunks.push(chunk)
}

function onStreamVideoPlaying() {
  log(`[video] playing @ ${(videoRef.value?.currentTime ?? 0).toFixed(3)}s`)
  // 视频开始播放即隐藏 loading（后台可能仍在继续解压/缓冲）
  phase.value = 'playing'
  if (!streamAudioActive || streamAudioReady || !audioCtx || !videoRef.value)
    return
  streamAudioReady = true
  audioTimeBase = audioCtx.currentTime - videoRef.value.currentTime
  audioStatusText.value = ''
  for (const chunk of pendingPcmChunks)
    scheduleOnePcmChunk(chunk)
  pendingPcmChunks.length = 0
}

function switchChannel(chNo: number) {
  currentChannel.value = chNo
  if (!streamAudioReady) {
    pendingPcmChunks.length = 0
    const newChunks = audioPcmByChannel.get(chNo) ?? []
    pendingPcmChunks.push(...newChunks)
  }
  else {
    rescheduleStreamAudio()
    if (videoRef.value?.paused)
      audioCtx?.suspend()
  }
}

function onAudioChannelChange(event: Event) {
  switchChannel(Number((event.target as HTMLSelectElement).value))
}

function buildSource() {
  return {
    kind: props.sourceKind,
    directDownloadUrl: props.directDownloadUrl,
    chunkVersion: props.bestChunkVersion,
    zipSource: props.zipSource,
    zipVersion: props.zipVersion,
    gameId: props.gameId,
    filePath: props.filePath,
  }
}

async function handlePushResult(r: UsmPushResult) {
  if (r.init_segment) {
    initSegCount++
    sbQueueRef!.append(r.init_segment)
  }
  for (const c of r.clusters) {
    clusterCount++
    sbQueueRef!.append(c)
  }
  for (const chunk of r.audio_pcm_chunks) {
    audioChunkCount++
    feedAudioChunk(chunk)
  }

  // 需求 1：首次拿到总时长即设置，使 <video> 立即显示正确时长与进度条
  if (durationMs.value == null && r.duration_ms != null && r.duration_ms > 0) {
    durationMs.value = r.duration_ms
    log(`解析到总时长 ${formatTime(r.duration_ms)}`)
    void applyDurationWhenIdle()
  }
  // seek 重建所需的明文头
  if (!ivfHeader && r.ivf_header) {
    ivfHeader = r.ivf_header
    log(`缓存 IVF 头（${r.ivf_header.byteLength} B）`)
  }
  for (const h of r.hca_headers) {
    if (!hcaHeaders.has(h.channel)) {
      hcaHeaders.set(h.channel, h.header)
      log(`缓存 HCA 头 通道 ${h.channel}（${h.header.byteLength} B）`)
    }
  }
  // 关键帧索引（扁平数组 [pts0, off0, pts1, off1, ...]），去重合并
  // Rust reset 已接受 base_offset，此处 offset 均为绝对字节偏移
  const flat = r.keyframes
  const newKfs: UsmKeyframe[] = []
  for (let i = 0; i + 1 < flat.length; i += 2)
    newKfs.push({ ptsMs: flat[i], offset: flat[i + 1] })
  if (newKfs.length > 0) {
    const before = keyframes.length
    mergeKeyframes(newKfs)
    if (keyframes.length > before)
      log(`关键帧索引 +${keyframes.length - before}（共 ${keyframes.length}）`)
  }
}

/** 等待 SourceBuffer 空闲后再设置 duration（append 期间 updating=true 会抛错） */
async function applyDurationWhenIdle() {
  for (;;) {
    if (!mediaSource || mediaSource.readyState !== 'open' || durationMs.value == null)
      return
    if (sbRef && sbRef.updating) {
      await new Promise<void>((resolve) => {
        const onEnd = () => {
          sbRef?.removeEventListener('updateend', onEnd)
          resolve()
        }
        sbRef?.addEventListener('updateend', onEnd)
      })
      continue
    }
    try {
      mediaSource.duration = durationMs.value / 1000
    }
    catch {}
    return
  }
}

/** 从 offset 起流式拉取到 EOF，逐段解码 + append（带背压） */
async function runStream(offset: number) {
  const token = ++streamToken
  streamController?.abort()
  const controller = new AbortController()
  streamController = controller
  const signal = controller.signal
  let receivedBytes = 0

  log(`[流] 从偏移 ${offset} 开始拉取（token ${token}）`)

  try {
    await streamUsmFrom(buildSource(), offset, async (data) => {
      if (token !== streamToken)
        return
      // push() 会 transfer data.buffer，await 返回后 data 已 detach、byteLength 变为 0。
      const dataByteLength = data.byteLength
      const r = await decoder!.push(data)
      if (token !== streamToken)
        return
      await handlePushResult(r)
      receivedBytes += dataByteLength
      loadedBytes += dataByteLength
      loadedChunksCount++
      progressLabel.value = `已加载 ${formatBytes(receivedBytes)}`
      await sbQueueRef!.waitForCapacity(signal)
    }, signal)

    if (token !== streamToken || signal.aborted) {
      log(`[流] token ${token} 中止（已接收 ${formatBytes(receivedBytes)}）`)
      return
    }

    const r = await decoder!.finish()
    if (token !== streamToken)
      return
    await handlePushResult(r)
    await sbQueueRef!.waitDrained(signal)

    // 兜底：此时缓冲已排空、SourceBuffer 必然空闲，确保时长已设置
    if (durationMs.value != null && mediaSource?.readyState === 'open') {
      try {
        mediaSource.duration = durationMs.value / 1000
      }
      catch {}
    }

    progress.value = 100
    progressLabel.value = '加载完成'
    log(`[流] token ${token} 加载完成（${formatBytes(receivedBytes)}，${loadedChunksCount} 段）`)
    // 不调用 endOfStream：保持 MediaSource 打开，支持按需 seek
  }
  catch (e) {
    if ((e as Error).name === 'AbortError') {
      log(`[流] token ${token} 被取消`)
      return
    }
    if (token !== streamToken)
      return
    log(`[流] token ${token} 错误：${(e as Error).message || String(e)}`)
    phase.value = 'error'
    errorMsg.value = (e as Error).message || String(e)
  }
}

function resetAudioForSeek() {
  audioPcmByChannel.clear()
  pendingPcmChunks = []
  stopAllStreamNodes()
  if (audioCtx && videoRef.value)
    audioTimeBase = audioCtx.currentTime - videoRef.value.currentTime
}

/** 移除 startSec 之后的缓冲，保留之前（避免 seekable 清空导致 currentTime 被重置而卡死） */
async function clearSourceBufferFrom(startSec: number) {
  const sb = sbRef
  const q = sbQueueRef
  if (!sb || !q)
    return
  try {
    await q.waitDrained(new AbortController().signal)
    const removals: Array<[number, number]> = []
    for (let i = 0; i < sb.buffered.length; i++) {
      const s = sb.buffered.start(i)
      const e = sb.buffered.end(i)
      if (e > startSec)
        removals.push([Math.max(s, startSec), e])
    }
    for (const [s, e] of removals) {
      try {
        sb.remove(s, e)
      }
      catch {}
      await q.waitDrained(new AbortController().signal)
    }
  }
  catch {}
}

function findKeyframeBefore(targetMs: number) {
  let best: { ptsMs: number, offset: number } | null = null
  for (const kf of keyframes) {
    if (kf.ptsMs <= targetMs + 50 && (best == null || kf.ptsMs > best.ptsMs))
      best = kf
  }
  return best
}

function isTimeBuffered(ms: number): boolean {
  if (!sbRef)
    return false
  const t = ms / 1000
  for (let i = 0; i < sbRef.buffered.length; i++) {
    if (t >= sbRef.buffered.start(i) - 0.05 && t <= sbRef.buffered.end(i) + 0.05)
      return true
  }
  return false
}

/** 判断目标时间是否被当前音频流的 PCM 数据覆盖。 */
function isAudioCovered(ms: number): boolean {
  if (audioChannelList.value.length === 0)
    return true
  const chunks = audioPcmByChannel.get(currentChannel.value)
  if (!chunks || chunks.length === 0)
    return false
  const first = chunks[0]
  const last = chunks[chunks.length - 1]
  const endMs = audioChunkStartMs(last) + audioChunkDurationMs(last)
  return ms >= audioChunkStartMs(first) - 50 && ms <= endMs + 50
}

function waitForBuffered(ms: number, timeoutMs = 6000, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs
    const tick = () => {
      if (signal?.aborted) {
        resolve(false)
        return
      }
      if (isTimeBuffered(ms)) {
        resolve(true)
        return
      }
      if (Date.now() >= deadline) {
        resolve(false)
        return
      }
      setTimeout(tick, 40)
    }
    tick()
  })
}

function formatTime(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

function togglePlay() {
  const v = videoRef.value
  if (!v)
    return
  showControlsTemporarily()
  if (v.paused)
    void v.play()
  else
    v.pause()
}

function clearControlsHideTimer() {
  if (controlsHideTimer != null) {
    clearTimeout(controlsHideTimer)
    controlsHideTimer = null
  }
}

function scheduleControlsHide() {
  clearControlsHideTimer()
  if (!isPlaying.value || phase.value !== 'playing' || isDraggingSeek.value)
    return
  controlsHideTimer = setTimeout(() => {
    if (isPlaying.value && phase.value === 'playing' && !isDraggingSeek.value)
      showControls.value = false
    controlsHideTimer = null
  }, CONTROLS_HIDE_DELAY_MS)
}

function showControlsTemporarily() {
  showControls.value = true
  scheduleControlsHide()
}

function onPlayerActivity() {
  showControlsTemporarily()
}

watch([isPlaying, phase, isDraggingSeek], () => {
  if (!isPlaying.value || phase.value !== 'playing' || isDraggingSeek.value) {
    clearControlsHideTimer()
    showControls.value = true
    return
  }
  scheduleControlsHide()
})

function toggleFullscreen() {
  const shell = playerShellRef.value
  if (!shell)
    return
  if (document.fullscreenElement)
    void document.exitFullscreen()
  else
    void shell.requestFullscreen()
}

function onPlayerKeydown(event: KeyboardEvent) {
  showControlsTemporarily()
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement)
    return
  if (event.key === ' ' || event.key.toLowerCase() === 'k') {
    event.preventDefault()
    togglePlay()
  }
  else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    event.preventDefault()
    const delta = event.key === 'ArrowLeft' ? -5000 : 5000
    void performSeek(currentTimeMs.value + delta)
  }
  else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
    event.preventDefault()
    const delta = event.key === 'ArrowUp' ? 0.05 : -0.05
    audioVolume.value = Math.max(0, Math.min(1, audioVolume.value + delta))
  }
  else if (event.key.toLowerCase() === 'f') {
    event.preventDefault()
    toggleFullscreen()
  }
}

/** 统一 seek 入口：已缓冲直接跳，未缓冲走重建式 seek */
async function performSeek(targetMs: number) {
  if (durationMs.value == null || durationMs.value <= 0)
    return
  const clamped = Math.max(0, Math.min(durationMs.value, targetMs))

  // 视频已缓冲且音频数据也覆盖目标时，直接 seek；
  // 否则（尤其往回拖到已被清空的音频区域）走重建式 seek。
  if (isTimeBuffered(clamped) && isAudioCovered(clamped)) {
    log(`[seek] 目标 ${formatTime(clamped)} 已缓冲，直接跳转`)
    if (videoRef.value)
      videoRef.value.currentTime = clamped / 1000
    return
  }

  if (manualSeeking) {
    queuedSeekMs = clamped
    scanController?.abort()
    streamController?.abort()
    log(`[seek] 已排队最新目标 ${formatTime(clamped)}`)
    return
  }
  manualSeeking = true
  log(`[seek] 目标 ${formatTime(clamped)} 未缓冲，触发重建式 seek`)

  const wasPlaying = videoRef.value ? !videoRef.value.paused : false
  try {
    // 向后 seek 到尚未顺序解码过的区域：关键帧索引未覆盖目标时，
    // 先明文扫描到目标（无需解密），否则 findKeyframeBefore 会回退到
    // 最后一个已知关键帧，导致进度条回跳/卡死。
    if (maxKeyframePtsMs < clamped) {
      videoRef.value?.pause()
      progressLabel.value = '正在定位关键帧...'
      isScanning.value = true
      scanProgressText.value = '正在扫描关键帧...'
      scanController = new AbortController()

      // 方案 A：找「目标之前最近的关键帧」作锚点，从其偏移续扫，避免从 0 重扫。
      // 首视频块 offset 全局最小，用于判断锚点是否仍需按「首块」格式解析（IVF 头）。
      let anchor: UsmKeyframe | null = null
      let firstVideoOffset = Infinity
      for (const kf of keyframes) {
        if (kf.offset < firstVideoOffset)
          firstVideoOffset = kf.offset
        if (kf.ptsMs < clamped && (anchor == null || kf.ptsMs > anchor.ptsMs))
          anchor = kf
      }
      let start: UsmScanStart | undefined
      if (anchor != null && ivfHeader) {
        const { fpsNum, fpsDen } = parseIvfFps(ivfHeader)
        start = { offset: anchor.offset, fpsNum, fpsDen, sawFirstVideo: anchor.offset !== firstVideoOffset }
        log(`[扫描] 从锚点 ${formatTime(anchor.ptsMs)}（偏移 ${anchor.offset}）续扫`)

        // 方案 C：锚点距目标过远时，用「总时长线性映射 + 魔数重新同步」二次跳，
        // 直接落到目标附近，避免顺序扫过中间整段。
        if (clamped - anchor.ptsMs > ESTIMATE_THRESHOLD_MS) {
          const planned = await planScanStart(
            buildSource(),
            clamped,
            durationMs.value,
            fpsNum,
            fpsDen,
            anchor.offset,
            scanController.signal,
          )
          if (planned) {
            start = planned
            log(`[扫描] 估算跳转到偏移 ${planned.offset}（目标 ${formatTime(clamped)}）`)
          }
        }
      }

      log(`[扫描] 开始（目标 ${formatTime(clamped)}，已索引最大 ${formatTime(maxKeyframePtsMs)}）`)
      const newKfs = await scanUsmKeyframes(buildSource(), clamped, scanController.signal, (info) => {
        scanProgressText.value = `已扫描 ${formatBytes(info.bytes)} · 已定位 ${info.keyframeCount} 个关键帧`
      }, start)
      mergeKeyframes(newKfs)
      scanController = null
      isScanning.value = false
      log(`[扫描] 完成（新增 ${newKfs.length} 个关键帧，索引共 ${keyframes.length}）`)
    }

    await rebuildSeek(clamped)
    if (wasPlaying && videoRef.value)
      void videoRef.value.play()
  }
  catch (e) {
    if ((e as Error).name !== 'AbortError') {
      log(`[seek] 错误：${(e as Error).message || String(e)}`)
      phase.value = 'error'
      errorMsg.value = (e as Error).message || String(e)
    }
  }
  finally {
    scanController = null
    isScanning.value = false
    manualSeeking = false
    if (queuedSeekMs != null) {
      const next = queuedSeekMs
      queuedSeekMs = null
      queueMicrotask(() => void performSeek(next))
    }
  }
}

/** 合并扫描结果（按 offset 去重） */
function mergeKeyframes(newKfs: UsmKeyframe[]) {
  const seen = new Set(keyframes.map(k => k.offset))
  for (const kf of newKfs) {
    if (seen.has(kf.offset))
      continue
    keyframes.push(kf)
    seen.add(kf.offset)
    if (kf.ptsMs > maxKeyframePtsMs)
      maxKeyframePtsMs = kf.ptsMs
  }
}

function seekFromEvent(e: PointerEvent): number | null {
  const el = e.currentTarget as HTMLElement
  const rect = el.getBoundingClientRect()
  if (rect.width <= 0 || durationMs.value == null || durationMs.value <= 0)
    return null
  const ratio = (e.clientX - rect.left) / rect.width
  return Math.max(0, Math.min(durationMs.value, ratio * durationMs.value))
}

function onSeekPointerDown(e: PointerEvent) {
  showControls.value = true
  clearControlsHideTimer()
  const ms = seekFromEvent(e)
  if (ms == null)
    return
  isDraggingSeek.value = true
  seekPreviewMs.value = ms
  ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
}

function onSeekPointerMove(e: PointerEvent) {
  if (!isDraggingSeek.value)
    return
  showControls.value = true
  const ms = seekFromEvent(e)
  if (ms != null)
    seekPreviewMs.value = ms
}

function onSeekPointerUp(e: PointerEvent) {
  if (!isDraggingSeek.value)
    return
  const ms = seekFromEvent(e)
  isDraggingSeek.value = false
  ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
  if (ms != null)
    void performSeek(ms)
  scheduleControlsHide()
}

/** 兜底：仅当浏览器因键盘等非自绘进度条方式 seek 到未缓冲区域时介入 */
function onStreamSeeking() {
  if (manualSeeking)
    return
  const targetMs = (videoRef.value?.currentTime ?? 0) * 1000
  if (isTimeBuffered(targetMs))
    return
  void performSeek(targetMs)
}

async function rebuildSeek(targetMs: number) {
  const kf = findKeyframeBefore(targetMs)
  if (!kf)
    return

  seekCount++
  lastSeekInfo = `${formatTime(targetMs)} → 关键帧 ${formatTime(kf.ptsMs)}（偏移 ${kf.offset}）`
  log(`[seek] ${lastSeekInfo}`)

  // 立即使旧流失效，防止其迟到结果污染新缓冲
  streamToken++
  streamController?.abort()
  // 只移除关键帧之后的缓冲，保留之前，避免 seekable 清空导致卡死
  await clearSourceBufferFrom(kf.ptsMs / 1000)

  // 关键修复：先把播放头拨到关键帧，再开始拉取。
  // 否则背压 getBufferedAhead 会把「旧缓冲相对旧播放位置」误判为已超前缓冲，
  // 阻塞新流（waitForCapacity 永不返回），导致 waitForBuffered 超时、seek 失败。
  if (videoRef.value)
    videoRef.value.currentTime = kf.ptsMs / 1000

  const canReset = ivfHeader != null && hcaHeaders.size > 0
  if (kf.ptsMs === 0 || !canReset) {
    // 首个关键帧（或元数据缺失）：重建全新解码器并从 0 开始
    log(`[seek] 重建全新解码器（kf.ptsMs=${kf.ptsMs}，canReset=${canReset}）`)
    if (decoder) {
      try {
        await decoder.free()
      }
      catch {}
      decoder = null
    }
    decoder = await getUsmStreamDecoder(props.keyHex)
    resetAudioForSeek()
  }
  else {
    const channels = [...hcaHeaders.entries()].map(([channel, header]) => ({
      channel,
      header,
      skip: 0,
    }))
    await decoder!.reset(ivfHeader!, channels, kf.offset)
    resetAudioForSeek()
    log(`[seek] 解码器 reset 完成（${channels.length} 通道，baseOffset=${kf.offset}）`)
  }

  // 后台开始流式拉取（从关键帧到 EOF，带背压）
  void runStream(kf.offset)
  const signal = streamController?.signal

  // 等目标所在 GOP 缓冲完成后精确落到用户请求时间，而不是停在关键帧。
  const ok = await waitForBuffered(targetMs, 15000, signal)
  if (signal?.aborted)
    throw new DOMException('Seek superseded', 'AbortError')
  log(`[seek] 等待目标 ${formatTime(targetMs)} 缓冲：${ok ? '成功' : '超时'}`)
  if (!ok)
    throw new Error(`定位 ${formatTime(targetMs)} 超时`)
  if (videoRef.value)
    videoRef.value.currentTime = targetMs / 1000
}

function updateBufferedProgress() {
  if (!sbRef || durationMs.value == null || durationMs.value <= 0) {
    bufferedProgress.value = 0
    return
  }
  const b = sbRef.buffered
  if (b.length === 0) {
    bufferedProgress.value = 0
    return
  }
  const end = b.end(b.length - 1)
  bufferedProgress.value = Math.min(1, end * 1000 / durationMs.value)
}

async function startStreaming() {
  if (!videoRef.value)
    return

  log(`开始播放（源 ${props.sourceKind}）`)

  if (!MediaSource.isTypeSupported(mimeType)) {
    phase.value = 'error'
    errorMsg.value = '当前浏览器不支持 WebM VP9 流式播放（建议使用 Chrome/Edge）'
    log(`错误：浏览器不支持 ${mimeType}`)
    return
  }

  audioCtx = new AudioContext()
  gainNode = audioCtx.createGain()
  gainNode.gain.value = audioVolume.value
  gainNode.connect(audioCtx.destination)
  streamAudioActive = true
  streamAudioReady = false
  audioPcmByChannel.clear()
  streamAudioNodes = []
  pendingPcmChunks = []
  audioTimestampCorrectionCount = 0
  maxAudioTimestampCorrectionMs = 0
  audioLateTrimCount = 0
  audioLateDropCount = 0
  maxAudioLateMs = 0
  audioChannelList.value = []
  currentChannel.value = 0
  audioStatusText.value = ''
  hasAutoSwitched = false
  keyframes.length = 0
  maxKeyframePtsMs = 0
  hcaHeaders.clear()
  ivfHeader = null
  durationMs.value = null
  bufferedProgress.value = 0
  streamToken = 0
  manualSeeking = false

  mediaSource = new MediaSource()
  objectUrl = URL.createObjectURL(mediaSource)
  videoRef.value.src = objectUrl

  await new Promise<void>((resolve, reject) => {
    mediaSource!.addEventListener('sourceopen', () => resolve(), { once: true })
    mediaSource!.addEventListener('error', () => reject(new Error('MediaSource error')), { once: true })
  })

  const sb = mediaSource.addSourceBuffer(mimeType)
  sbRef = sb
  const sbQueue = makeSourceBufferQueue(sb, videoRef.value)
  sbQueueRef = sbQueue

  phase.value = 'buffering'
  progress.value = 0

  const onStreamPause = () => {
    log(`[video] pause @ ${(videoRef.value?.currentTime ?? 0).toFixed(3)}s`)
    isPlaying.value = false
    if (streamAudioActive)
      audioCtx?.suspend()
  }
  const onStreamPlay = () => {
    log(`[video] play @ ${(videoRef.value?.currentTime ?? 0).toFixed(3)}s`)
    isPlaying.value = true
    if (streamAudioActive)
      audioCtx?.resume()
  }
  const onStreamSeeked = () => {
    log(`[video] seeked @ ${(videoRef.value?.currentTime ?? 0).toFixed(3)}s`)
    if (!streamAudioActive)
      return
    rescheduleStreamAudio()
    if (videoRef.value?.paused)
      audioCtx?.suspend()
  }
  const onStreamEnded = () => {
    log('[video] ended')
    isPlaying.value = false
    stopAllStreamNodes()
  }
  const onStreamTimeUpdate = () => {
    if (videoRef.value && !isDraggingSeek.value)
      currentTimeMs.value = videoRef.value.currentTime * 1000
    updateBufferedProgress()
  }

  videoRef.value.addEventListener('playing', onStreamVideoPlaying, { once: true })
  videoRef.value.addEventListener('pause', onStreamPause)
  videoRef.value.addEventListener('play', onStreamPlay)
  videoRef.value.addEventListener('seeked', onStreamSeeked)
  videoRef.value.addEventListener('seeking', onStreamSeeking)
  videoRef.value.addEventListener('timeupdate', onStreamTimeUpdate)
  videoRef.value.addEventListener('ended', onStreamEnded)
  videoRef.value.addEventListener('waiting', () => log(`[video] waiting @ ${(videoRef.value?.currentTime ?? 0).toFixed(3)}s`))
  videoRef.value.addEventListener('stalled', () => log(`[video] stalled @ ${(videoRef.value?.currentTime ?? 0).toFixed(3)}s`))
  videoRef.value.addEventListener('canplay', () => log(`[video] canplay @ ${(videoRef.value?.currentTime ?? 0).toFixed(3)}s`))
  videoRef.value.addEventListener('error', () => log(`[video] error ${videoRef.value?.error?.code ?? '-'} ${videoRef.value?.error?.message ?? ''}`))

  refreshDebugInfo()
  debugTimer = setInterval(refreshDebugInfo, 500)

  try {
    decoder = await getUsmStreamDecoder(props.keyHex)
    log('解码器创建成功')
    await runStream(0)
  }
  catch (e) {
    if ((e as Error).name === 'AbortError')
      return
    log(`播放初始化错误：${(e as Error).message || String(e)}`)
    phase.value = 'error'
    errorMsg.value = (e as Error).message || String(e)
  }
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3)
    return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  if (bytes >= 1024 ** 2)
    return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  if (bytes >= 1024)
    return `${(bytes / 1024).toFixed(0)} KB`
  return `${bytes} B`
}

function formatRanges(tr: TimeRanges | null | undefined): string {
  if (!tr || tr.length === 0)
    return '（空）'
  const parts: string[] = []
  for (let i = 0; i < tr.length; i++)
    parts.push(`[${tr.start(i).toFixed(2)}, ${tr.end(i).toFixed(2)}]`)
  return parts.join(' ')
}

function collectDebugInfo(): string {
  const v = videoRef.value
  const sb = sbRef
  const stats = sbQueueRef?.getStats()
  const now = new Date()
  const L: string[] = []
  const kv = (k: string, val: unknown) => L.push(`${k}: ${val}`)

  L.push('===== USM 播放器调试信息 =====')
  L.push(`时间: ${now.toLocaleTimeString()}.${String(now.getMilliseconds()).padStart(3, '0')}`)
  L.push('')

  L.push('--- 基本信息 ---')
  kv('文件名', props.filename)
  kv('游戏', props.gameId)
  kv('文件路径', props.filePath)
  kv('源类型', props.sourceKind)
  kv('Chunk 版本', props.bestChunkVersion ?? '-')
  kv('Zip 版本', props.zipVersion ?? '-')
  kv('直链', props.directDownloadUrl ?? '-')
  kv('密钥', props.keyHex)
  L.push('')

  L.push('--- 播放状态 ---')
  kv('phase', phase.value)
  kv('当前时间', formatTime(currentTimeMs.value))
  kv('总时长', durationMs.value != null ? formatTime(durationMs.value) : '-')
  kv('缓冲进度', `${(bufferedProgress.value * 100).toFixed(1)}%`)
  kv('加载进度', `${progress.value}%（${progressLabel.value}）`)
  kv('isPlaying', isPlaying.value)
  kv('isDraggingSeek', isDraggingSeek.value)
  kv('manualSeeking', manualSeeking)
  kv('queuedSeek', queuedSeekMs != null ? formatTime(queuedSeekMs) : '-')
  kv('错误信息', errorMsg.value || '-')
  L.push('')

  L.push('--- 视频元素 ---')
  kv('readyState', v?.readyState)
  kv('networkState', v?.networkState)
  kv('paused', v?.paused)
  kv('ended', v?.ended)
  kv('video.buffered', formatRanges(v?.buffered))
  kv('video.seekable', formatRanges(v?.seekable))
  kv('video.error', v?.error ? `${v.error.code} ${v.error.message}` : '-')
  L.push('')

  L.push('--- SourceBuffer ---')
  kv('updating', sb?.updating)
  kv('buffered', formatRanges(sb?.buffered))
  kv('mode', sb?.mode)
  kv('队列长度', stats?.queueLength ?? '-')
  kv('队列字节', stats != null ? formatBytes(stats.queuedBytes) : '-')
  kv('activeOp', stats?.activeOp ?? '-')
  kv('retry 等待', stats?.retry ?? '-')
  kv('Quota 重试', stats?.quotaRetryCount ?? '-')
  kv('队列错误', stats?.fatalError ?? '-')
  L.push('')

  L.push('--- 流式 / 解码器 ---')
  kv('streamToken', streamToken)
  kv('decoder', decoder ? 'active' : 'null')
  kv('已接收字节', formatBytes(loadedBytes))
  kv('已接收段数', loadedChunksCount)
  kv('init_segment 次数', initSegCount)
  kv('cluster 总数', clusterCount)
  kv('音频块总数', audioChunkCount)
  kv('关键帧索引', keyframes.length)
  kv('ivfHeader', ivfHeader ? `${ivfHeader.byteLength} B` : '-')
  kv('hcaHeaders', [...hcaHeaders.keys()].join(',') || '-')
  kv('seek 次数', seekCount)
  kv('最近 seek', lastSeekInfo || '-')
  L.push('')

  L.push('--- 音频 ---')
  kv('streamAudioActive', streamAudioActive)
  kv('streamAudioReady', streamAudioReady)
  kv('audioCtx.state', audioCtx?.state ?? '-')
  kv('音频通道', audioChannelList.value.join(',') || '-')
  kv('当前通道', currentChannel.value)
  kv('音频状态', audioStatusText.value || '-')
  kv('时间戳连续化', `${audioTimestampCorrectionCount} 次 · 最大 ${maxAudioTimestampCorrectionMs.toFixed(3)}ms`)
  kv('迟到块裁剪/丢弃', `${audioLateTrimCount}/${audioLateDropCount} · 最大 ${maxAudioLateMs.toFixed(3)}ms`)
  for (const [ch, chunks] of audioPcmByChannel) {
    const first = chunks[0] ? audioChunkStartMs(chunks[0]) : null
    const last = chunks[chunks.length - 1]
    const end = last ? audioChunkStartMs(last) + audioChunkDurationMs(last) : null
    kv(`PCM 通道 ${ch}`, `${chunks.length} 块 · ${first == null ? '-' : formatTime(first)}–${end == null ? '-' : formatTime(end)}`)
  }
  kv('调度节点数', streamAudioNodes.length)
  L.push('')

  return L.join('\n')
}

function refreshDebugInfo() {
  debugText.value = collectDebugInfo()
}

async function copyDebug() {
  const text = debugTab.value === 'log' ? logText.value : debugText.value
  let ok = false
  try {
    await navigator.clipboard.writeText(text)
    ok = true
  }
  catch {
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      ok = document.execCommand('copy')
      document.body.removeChild(ta)
    }
    catch {
      ok = false
    }
  }
  copyState.value = ok ? 'ok' : 'fail'
  setTimeout(() => {
    copyState.value = 'idle'
  }, 1500)
}

function handleClose() {
  clearControlsHideTimer()
  if (debugTimer) {
    clearInterval(debugTimer)
    debugTimer = null
  }
  scanController?.abort()
  streamController?.abort()
  if (decoder) {
    try {
      void decoder.free()
    }
    catch {}
    decoder = null
  }
  if (streamAudioActive) {
    stopAllStreamNodes()
    streamAudioActive = false
  }
  if (videoAudioSyncCleanup) {
    videoAudioSyncCleanup()
    videoAudioSyncCleanup = null
  }
  if (audioCtx) {
    audioCtx.close()
    audioCtx = null
    gainNode = null
  }
  if (mediaSource && mediaSource.readyState === 'open') {
    try {
      mediaSource.endOfStream()
    }
    catch {}
  }
  if (objectUrl)
    URL.revokeObjectURL(objectUrl)
  emit('close')
}

onMounted(() => startStreaming())
onUnmounted(() => {
  clearControlsHideTimer()
  if (debugTimer) {
    clearInterval(debugTimer)
    debugTimer = null
  }
  scanController?.abort()
  streamController?.abort()
  if (decoder) {
    try {
      void decoder.free()
    }
    catch {}
    decoder = null
  }
  stopAllStreamNodes()
  if (videoAudioSyncCleanup)
    videoAudioSyncCleanup()
  if (audioCtx) {
    audioCtx.close()
    gainNode = null
  }
  if (objectUrl)
    URL.revokeObjectURL(objectUrl)
})
</script>

<template>
  <Teleport to="body">
    <div class="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div class="absolute inset-0 bg-black/70" @click="handleClose" />
      <div class="relative flex w-full max-w-3xl flex-col rounded-2xl border border-gray-200 bg-white shadow-2xl dark:border-gray-700 dark:bg-gray-900">
        <div class="flex items-center gap-2 border-b border-gray-200 px-5 py-3 dark:border-gray-700">
          <LucideFileVideo class="h-4 w-4 shrink-0 text-blue-500" />
          <span class="min-w-0 flex-1 truncate text-sm font-semibold text-gray-800 dark:text-gray-100">{{ filename }}</span>
          <button
            class="shrink-0 rounded-md p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700 dark:hover:text-gray-200"
            @click="handleClose"
          >
            <LucideX class="h-4 w-4" />
          </button>
        </div>

        <div class="p-4">
          <div
            v-if="phase === 'error'"
            class="flex flex-col items-center gap-2 py-12 text-red-500"
          >
            <LucideAlertCircle class="h-8 w-8 shrink-0" />
            <p class="max-h-48 w-full max-w-full overflow-y-auto whitespace-pre-wrap break-all px-2 text-center text-sm">
              {{ errorMsg }}
            </p>
            <button
              class="mt-2 text-xs text-blue-500 hover:text-blue-600"
              @click="showHelp = true"
            >
              出现 Failed to fetch？点击查看帮助
            </button>
          </div>

          <template v-else>
            <div
              ref="playerShellRef"
              class="player-shell relative overflow-hidden rounded-lg bg-black outline-none"
              :class="!showControls && isPlaying ? 'cursor-none' : ''"
              tabindex="0"
              @keydown="onPlayerKeydown"
              @pointerdown="onPlayerActivity"
              @pointermove="onPlayerActivity"
            >
              <video
                ref="videoRef"
                autoplay
                class="block max-h-[60vh] w-full object-contain"
                @click="togglePlay"
                @dblclick="toggleFullscreen"
              />
              <div
                v-if="phase === 'init' || (phase === 'buffering' && progress === 0) || isScanning"
                class="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/60"
              >
                <LucideLoader2 class="h-8 w-8 animate-spin text-white" />
                <span v-if="isScanning" class="px-4 text-center text-xs tabular-nums text-white">
                  {{ scanProgressText }}
                </span>
              </div>

              <!-- 自绘控制栏 -->
              <div
                class="absolute inset-x-0 bottom-0 flex items-center gap-3 bg-gradient-to-t from-black/80 to-transparent px-3 pb-2.5 pt-8 transition-opacity duration-200"
                :class="showControls ? 'opacity-100' : 'pointer-events-none opacity-0'"
              >
                <button
                  class="shrink-0 rounded-full p-1 text-white transition-colors hover:bg-white/20"
                  @click.stop="togglePlay"
                >
                  <LucidePause v-if="isPlaying" class="h-5 w-5" />
                  <LucidePlay v-else class="h-5 w-5" />
                </button>
                <span class="shrink-0 text-xs tabular-nums text-white">
                  {{ formatTime(isDraggingSeek ? seekPreviewMs : currentTimeMs) }}
                </span>
                <div
                  class="group relative h-1.5 flex-1 cursor-pointer touch-none"
                  @pointerdown.stop="onSeekPointerDown"
                  @pointermove="onSeekPointerMove"
                  @pointerup="onSeekPointerUp"
                >
                  <div class="absolute inset-0 rounded-full bg-white/20" />
                  <div
                    class="absolute inset-y-0 left-0 rounded-full bg-white/40"
                    :style="{ width: `${Math.round(bufferedProgress * 100)}%` }"
                  />
                  <div
                    class="absolute inset-y-0 left-0 rounded-full bg-blue-500"
                    :style="{ width: `${playProgressPercent}%` }"
                  />
                  <div
                    class="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow"
                    :style="{ left: `${playProgressPercent}%` }"
                  />
                </div>
                <span class="shrink-0 text-xs tabular-nums text-white">{{ formatTime(durationMs ?? 0) }}</span>
                <select
                  v-if="audioChannelList.length > 0"
                  :value="currentChannel"
                  aria-label="音频通道"
                  class="max-w-24 shrink-0 rounded bg-black/40 px-1.5 py-1 text-xs text-white outline-none ring-1 ring-white/20 hover:bg-black/60"
                  @click.stop
                  @change="onAudioChannelChange"
                >
                  <option v-for="ch in audioChannelList" :key="ch" :value="ch" class="bg-gray-900">
                    {{ getChannelLabel(ch) }}
                  </option>
                </select>
                <div v-if="audioChannelList.length > 0" class="hidden shrink-0 items-center gap-1.5 sm:flex" @click.stop>
                  <LucideVolume2 class="h-4 w-4 text-white" />
                  <input
                    v-model.number="audioVolume"
                    aria-label="音量"
                    type="range"
                    min="0"
                    max="1"
                    step="0.01"
                    class="h-1 w-20 cursor-pointer accent-blue-500"
                  >
                </div>
                <button
                  class="shrink-0 rounded-full p-1 text-white transition-colors hover:bg-white/20"
                  @click.stop="toggleFullscreen"
                >
                  <LucideMaximize class="h-5 w-5" />
                </button>
              </div>
            </div>

            <div class="mt-3 space-y-1.5">
              <div class="flex items-center justify-between text-xs text-gray-400 dark:text-gray-500">
                <span>{{ progressLabel || '正在初始化...' }}</span>
                <span v-if="durationMs != null" class="tabular-nums">总时长 {{ formatTime(durationMs) }}</span>
                <span v-else class="tabular-nums">{{ progress }}%</span>
              </div>
              <div v-if="audioStatusText" class="text-xs text-gray-400 dark:text-gray-500">
                {{ audioStatusText }}
              </div>
              <div class="text-xs text-gray-400 dark:text-gray-500">
                未缓冲区域拖动进度条时，将从最近的关键帧重新加载并继续播放
              </div>

              <!-- 调试信息面板 -->
              <div class="border-t border-gray-100 pt-1.5 dark:border-gray-700">
                <button
                  class="flex items-center gap-1 text-xs text-gray-400 transition-colors hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300"
                  @click="showDebug = !showDebug"
                >
                  <LucideBug class="h-3.5 w-3.5" />
                  调试信息
                  <LucideChevronDown
                    class="h-3.5 w-3.5 transition-transform"
                    :class="showDebug ? 'rotate-180' : ''"
                  />
                </button>
                <div v-if="showDebug" class="mt-1.5 space-y-1.5">
                  <div class="flex items-center gap-1 rounded bg-gray-100 p-0.5 dark:bg-gray-700">
                    <button
                      class="flex-1 rounded px-2 py-0.5 text-xs font-medium transition-colors"
                      :class="debugTab === 'status'
                        ? 'bg-white text-gray-800 shadow dark:bg-gray-800 dark:text-gray-100'
                        : 'text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200'"
                      @click="debugTab = 'status'"
                    >
                      播放器状态
                    </button>
                    <button
                      class="flex-1 rounded px-2 py-0.5 text-xs font-medium transition-colors"
                      :class="debugTab === 'log'
                        ? 'bg-white text-gray-800 shadow dark:bg-gray-800 dark:text-gray-100'
                        : 'text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200'"
                      @click="debugTab = 'log'"
                    >
                      日志记录
                    </button>
                  </div>
                  <div class="flex items-center gap-2">
                    <button
                      class="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-600 transition-colors hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
                      @click="copyDebug"
                    >
                      一键复制
                    </button>
                    <span v-if="copyState === 'ok'" class="text-xs text-green-500">已复制到剪贴板</span>
                    <span v-else-if="copyState === 'fail'" class="text-xs text-red-500">复制失败</span>
                    <span class="ml-auto text-xs text-gray-400 dark:text-gray-500">
                      {{ debugTab === 'status' ? '每 0.5s 自动刷新' : `${logEntries.length} 条` }}
                    </span>
                  </div>
                  <pre v-if="debugTab === 'status'" class="max-h-64 overflow-auto rounded bg-gray-50 p-2 text-[11px] leading-relaxed text-gray-600 dark:bg-gray-800 dark:text-gray-300">{{ debugText }}</pre>
                  <pre v-else class="max-h-64 overflow-auto rounded bg-gray-50 p-2 text-[11px] leading-relaxed text-gray-600 dark:bg-gray-800 dark:text-gray-300">{{ logText }}</pre>
                </div>
              </div>
            </div>
          </template>
        </div>
      </div>
    </div>
  </Teleport>

  <HelpModal v-if="showHelp" @close="showHelp = false" />
</template>

<style scoped>
.player-shell:fullscreen {
  width: 100vw;
  height: 100vh;
  border-radius: 0;
}

.player-shell:fullscreen video {
  width: 100%;
  height: 100%;
  max-height: none;
}
</style>
