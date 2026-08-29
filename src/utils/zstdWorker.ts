/**
 * ZSTD 解压的 Web Worker 封装。
 * 解压是 CPU 密集操作，移入 worker 避免阻塞主线程。
 * worker 为懒加载单例，所有调用共享同一个 worker。
 */

let worker: Worker | null = null
let nextId = 1
const pending = new Map<number, {
  resolve: (data: Uint8Array) => void
  reject: (error: Error) => void
}>()

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('../workers/zstd.worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (event: MessageEvent) => {
      const msg = event.data
      const entry = pending.get(msg.id)
      if (!entry)
        return
      pending.delete(msg.id)
      if (msg.type === 'decoded') {
        entry.resolve(new Uint8Array(msg.data))
      }
      else {
        entry.reject(new Error(msg.message ?? 'ZSTD 解压失败'))
      }
    }
    worker.onerror = (event) => {
      for (const [, entry] of pending) {
        entry.reject(new Error(event.message || 'ZSTD worker 错误'))
      }
      pending.clear()
    }
  }
  return worker
}

/**
 * 在 worker 中解压 ZSTD 数据。
 * 注意：`data` 的底层 ArrayBuffer 会被转移（transfer）到 worker，调用后不可再使用。
 * 若传入的是子视图（byteOffset ≠ 0 或 byteLength ≠ buffer.byteLength），会先拷贝成整块再转移。
 */
export function decodeZstd(data: Uint8Array, uncompressedSize: number): Promise<Uint8Array> {
  const id = nextId++
  const w = getWorker()

  let transferable: ArrayBuffer
  if (data.byteOffset === 0 && data.byteLength === data.buffer.byteLength) {
    transferable = data.buffer as ArrayBuffer
  }
  else {
    transferable = data.slice().buffer as ArrayBuffer
  }

  return new Promise<Uint8Array>((resolve, reject) => {
    pending.set(id, { resolve, reject })
    w.postMessage(
      { type: 'decode', id, data: transferable, uncompressedSize },
      [transferable],
    )
  })
}
