import type { ParsedChunk } from '@/types'
import { decodeZstd } from './zstdWorker'

const CHUNK_CONCURRENCY = 4

export async function downloadChunks(
  chunks: ParsedChunk[],
  chunkUrlPrefix: string,
  signal: AbortSignal,
  onChunk: (decompressed: Uint8Array, index: number, total: number) => void | Promise<void>,
): Promise<void> {
  const total = chunks.length
  const readyChunks = new Map<number, Uint8Array>()
  const stateWaiters: Array<() => void> = []
  let nextFetchIndex = 0
  let nextConsumeIndex = 0
  let activeFetches = 0
  let fatalError: Error | null = null

  function notifyStateChange() {
    while (stateWaiters.length)
      stateWaiters.shift()?.()
  }

  function toError(error: unknown) {
    return error instanceof Error ? error : new Error(String(error))
  }

  function pumpFetches() {
    while (
      !signal.aborted
      && !fatalError
      && nextFetchIndex < total
      && activeFetches + readyChunks.size < CHUNK_CONCURRENCY
    ) {
      const index = nextFetchIndex++
      const chunk = chunks[index]
      activeFetches++

      fetch(`${chunkUrlPrefix}/${chunk.id}`, { signal })
        .then(async (res) => {
          if (!res.ok)
            throw new Error(`Chunk 下载失败：${res.status}`)
          return new Uint8Array(await res.arrayBuffer())
        })
        .then((compressed) => {
          readyChunks.set(index, compressed)
        })
        .catch((error) => {
          if (!fatalError)
            fatalError = toError(error)
        })
        .finally(() => {
          activeFetches--
          notifyStateChange()
          if (!fatalError)
            pumpFetches()
        })
    }
  }

  async function waitForStateChange() {
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

  pumpFetches()

  while (nextConsumeIndex < total) {
    if (signal.aborted)
      return
    if (fatalError)
      throw fatalError

    const compressed = readyChunks.get(nextConsumeIndex)
    if (!compressed) {
      if (activeFetches === 0 && nextFetchIndex >= total)
        throw new Error('Chunk 下载中断')

      await waitForStateChange()
      continue
    }

    readyChunks.delete(nextConsumeIndex)
    pumpFetches()

    const decompressed = await decodeZstd(compressed, chunks[nextConsumeIndex].uncompressedSize)
    await onChunk(decompressed, nextConsumeIndex, total)
    nextConsumeIndex++
  }
}
