/**
 * USM 明文关键帧扫描器（无需解密、无需 key）。
 *
 * USM 的块头链、IVF 帧头（pts）以及 VP9 关键帧判定位（帧数据首字节的
 * `frame_type`）均位于 XOR 解密区（payload 偏移 0x40 之后）之外，因此可以
 * 完全不解密地顺序扫描整个文件，建立「关键帧 pts → USM 文件字节偏移」索引。
 *
 * 用于向后 seek 到尚未顺序解码过的区域时，先快速定位目标附近的关键帧，
 * 避免因索引不完整而回退到「最后一个已知关键帧」。
 */

import type { UsmStreamSource } from './usmRange'
import { getUsmFileSize, streamUsmFrom } from './usmRange'

export interface UsmKeyframe {
  /** 关键帧时间戳（毫秒） */
  ptsMs: number
  /** 该 @SFV 块头在 USM 文件中的绝对字节偏移 */
  offset: number
}

export interface UsmScanProgress {
  /** 已扫描的绝对字节数 */
  bytes: number
  /** 已定位的关键帧数 */
  keyframeCount: number
}

/** 扫描起点状态：从已知锚点（目标之前最近的关键帧）续扫时提供 */
export interface UsmScanStart {
  /** 起始扫描的绝对字节偏移（对齐到 chunk 头） */
  offset: number
  /** 已知 fps 分子（IVF 头 offset 16，LE u32） */
  fpsNum: number
  /** 已知 fps 分母（IVF 头 offset 20，LE u32） */
  fpsDen: number
  /** 起始偏移是否已越过首视频块（决定首个视频块按「后续块」还是「首块」格式解析） */
  sawFirstVideo: boolean
}

/** 从缓存的 32B IVF 头读取 fps（与扫描器读取首视频块时字段偏移一致） */
export function parseIvfFps(ivfHeader: Uint8Array): { fpsNum: number, fpsDen: number } {
  return { fpsNum: readU32LE(ivfHeader, 16), fpsDen: readU32LE(ivfHeader, 20) }
}

const SIG_VIDEO = 0x40534656 // @SFV
const SIG_AUDIO = 0x40534641 // @SFA

/** 提前停止信号：已扫到目标关键帧 */
class ScanDoneError extends Error {
  constructor() {
    super('scan done')
    this.name = 'ScanDoneError'
  }
}

/** 提前停止信号：已找到 chunk 边界对齐点 */
class SyncDoneError extends Error {
  constructor() {
    super('sync done')
    this.name = 'SyncDoneError'
  }
}

/** VP9 关键帧判定（与 Rust `usm_stream.rs::is_vp9_keyframe` 完全一致） */
function isVp9Keyframe(b: number): boolean {
  if ((b >> 6) !== 0b10)
    return false
  const profile = ((b >> 5) & 1) | (((b >> 4) & 1) << 1)
  const showBit = profile === 3 ? 2 : 3
  if (((b >> showBit) & 1) === 1)
    return false
  return ((b >> (showBit - 1)) & 1) === 0
}

function readU32LE(b: Uint8Array, off: number): number {
  return (b[off] | (b[off + 1] << 8) | (b[off + 2] << 16) | (b[off + 3] << 24)) >>> 0
}

function readU32BE(b: Uint8Array, off: number): number {
  return ((b[off] << 24) | (b[off + 1] << 16) | (b[off + 2] << 8) | b[off + 3]) >>> 0
}

function readU64LE(b: Uint8Array, off: number): number {
  const lo = readU32LE(b, off)
  const hi = readU32LE(b, off + 4)
  return hi * 0x100000000 + lo
}

/**
 * 从文件头顺序扫描 USM 明文，收集视频关键帧索引。
 *
 * @param source USM 数据源
 * @param targetMs 扫到首个 `ptsMs >= targetMs` 的关键帧即停止；传 null 扫到 EOF
 * @param signal 外部取消信号
 * @param onProgress 可选进度回调（已扫描的绝对字节数）
 */
export async function scanUsmKeyframes(
  source: UsmStreamSource,
  targetMs: number | null,
  signal: AbortSignal,
  onProgress?: (info: UsmScanProgress) => void,
  start?: UsmScanStart,
): Promise<UsmKeyframe[]> {
  const keyframes: UsmKeyframe[] = []
  let fpsNum = start?.fpsNum ?? 30
  let fpsDen = start?.fpsDen ?? 1
  let sawFirstVideo = start?.sawFirstVideo ?? false
  let bytesConsumed = start?.offset ?? 0
  let buf = new Uint8Array(0)

  const parse = () => {
    for (;;) {
      if (buf.length < 8)
        return
      const sig = (buf[0] << 24) | (buf[1] << 16) | (buf[2] << 8) | buf[3]
      const dataSize = ((buf[4] << 24) | (buf[5] << 16) | (buf[6] << 8) | buf[7]) >>> 0
      if (buf.length < 8 + dataSize)
        return

      const chunkOffset = bytesConsumed
      const dataOffset = buf[8 + 1]
      const paddingSize = ((buf[8 + 2] << 8) | buf[8 + 3]) >>> 0
      const dataType = buf[8 + 7]

      if (sig === SIG_VIDEO && dataType === 0) {
        const payloadStart = 8 + dataOffset
        const payloadSize = dataSize - dataOffset - paddingSize

        if (!sawFirstVideo) {
          // 首个视频块：payload = [IVF 头 32B] + [帧头 12B] + [VP9 帧数据]
          if (payloadSize >= 32 + 12 + 1) {
            fpsNum = readU32LE(buf, payloadStart + 16)
            fpsDen = readU32LE(buf, payloadStart + 20)
            const pts = readU64LE(buf, payloadStart + 32 + 4)
            const firstByte = buf[payloadStart + 32 + 12]
            if (isVp9Keyframe(firstByte))
              keyframes.push({ ptsMs: pts * fpsDen * 1000 / fpsNum, offset: chunkOffset })
            sawFirstVideo = true
          }
        }
        else if (payloadSize >= 12 + 1) {
          // 后续视频块：payload = [帧头 12B] + [VP9 帧数据]
          const pts = readU64LE(buf, payloadStart + 4)
          const firstByte = buf[payloadStart + 12]
          if (isVp9Keyframe(firstByte))
            keyframes.push({ ptsMs: pts * fpsDen * 1000 / fpsNum, offset: chunkOffset })
        }
      }

      buf = buf.slice(8 + dataSize)
      bytesConsumed += 8 + dataSize
    }
  }

  try {
    await streamUsmFrom(source, start?.offset ?? 0, async (data) => {
      const merged = new Uint8Array(buf.length + data.length)
      merged.set(buf, 0)
      merged.set(data, buf.length)
      buf = merged
      parse()
      onProgress?.({ bytes: bytesConsumed, keyframeCount: keyframes.length })

      if (targetMs != null) {
        const last = keyframes[keyframes.length - 1]
        if (last != null && last.ptsMs >= targetMs)
          throw new ScanDoneError()
      }
    }, signal)
  }
  catch (e) {
    if (e instanceof ScanDoneError)
      return keyframes
    throw e
  }

  return keyframes
}

/** 估算安全边距（毫秒）：估算点「宁早勿晚」向前退让的时长，覆盖码率波动与关键帧间隔 */
const ESTIMATE_SAFETY_MS = 8000
/** 跳转收益阈值（字节）：估算跳转省下的字节低于此值则不值得，回退顺序扫 */
const MIN_ESTIMATE_SKIP_BYTES = 4 * 1024 * 1024

/** 校验某个候选位置是否为合法 chunk 头（sig 合法 + dataSize 合理 + body 结构合法） */
function isPlausibleChunkHeader(buf: Uint8Array, i: number): boolean {
  const sig = readU32BE(buf, i)
  if (sig !== SIG_VIDEO && sig !== SIG_AUDIO)
    return false
  const dataSize = readU32BE(buf, i + 4)
  if (dataSize < 8 || dataSize > 0x08000000)
    return false
  // body 前 8 字节结构：dataOffset=body[1]、dataType=body[7]
  if (i + 8 + 8 > buf.length)
    return true // body 尚未读全，先按头 8B 合法通过
  const dataOffset = buf[i + 8 + 1]
  const dataType = buf[i + 8 + 7]
  if (dataType !== 0)
    return false
  if (dataOffset < 8 || dataOffset > dataSize)
    return false
  return true
}

/**
 * 从 `estOffset` 起读取，逐字节定位到下一个 chunk 头边界（魔数重新同步）。
 * chunk 头 8B 为明文，`@SFV`/`@SFA` 只出现在 chunk 头（payload 被 XOR 打散），
 * 连续 2 块校验可排除 payload 内部偶然匹配。
 *
 * @returns 对齐后的绝对字节偏移；同步失败返回 null
 */
async function syncToChunkBoundary(
  source: UsmStreamSource,
  estOffset: number,
  signal: AbortSignal,
): Promise<number | null> {
  let buf = new Uint8Array(0)
  let absBase = estOffset
  let result: number | null = null

  try {
    await streamUsmFrom(source, estOffset, async (data) => {
      const merged = new Uint8Array(buf.length + data.length)
      merged.set(buf, 0)
      merged.set(data, buf.length)
      buf = merged

      for (let i = 0; i + 8 <= buf.length; i++) {
        if (!isPlausibleChunkHeader(buf, i))
          continue
        // 验证下一块头也合法（多块对齐排除误判）
        const dataSize = readU32BE(buf, i + 4)
        const next = i + 8 + dataSize
        if (next + 8 > buf.length) {
          // 下一块头未读全，放宽为单块验证（已通过 isPlausibleChunkHeader）
          result = absBase + i
          break
        }
        if (isPlausibleChunkHeader(buf, next)) {
          result = absBase + i
          break
        }
      }

      if (result != null)
        throw new SyncDoneError()

      // 未找到：仅保留末尾 7 字节，避免 chunk 头跨段边界漏检
      if (buf.length > 7) {
        absBase += buf.length - 7
        buf = buf.slice(buf.length - 7)
      }
    }, signal)
  }
  catch (e) {
    if (e instanceof SyncDoneError)
      return result
    return null
  }

  return result
}

/**
 * 规划扫描起点：用「总时长 → 文件大小」线性估算目标字节偏移，经魔数
 * 重新同步后返回一个对齐到 chunk 头的续扫起点。失败（文件大小未知、同步
 * 失败、收益太小）时返回 null，由调用方回退到锚点顺序扫。
 */
export async function planScanStart(
  source: UsmStreamSource,
  targetMs: number,
  durationMs: number,
  fpsNum: number,
  fpsDen: number,
  minOffset: number,
  signal: AbortSignal,
): Promise<UsmScanStart | null> {
  if (durationMs <= 0 || targetMs <= 0)
    return null
  const fileSize = await getUsmFileSize(source, signal)
  if (fileSize == null || fileSize <= 0)
    return null

  const bytesPerMs = fileSize / durationMs
  let estOffset = Math.floor(targetMs * bytesPerMs - bytesPerMs * ESTIMATE_SAFETY_MS)
  estOffset = Math.max(0, estOffset)

  // 跳转省下的字节太少则不值得，回退顺序扫
  if (estOffset - minOffset < MIN_ESTIMATE_SKIP_BYTES)
    return null

  const aligned = await syncToChunkBoundary(source, estOffset, signal)
  if (aligned == null)
    return null

  return { offset: aligned, fpsNum, fpsDen, sawFirstVideo: true }
}
