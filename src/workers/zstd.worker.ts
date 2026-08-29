/// <reference lib="webworker" />

import { ZSTDDecoder } from 'zstddec'

interface DecodeRequest {
  type: 'decode'
  id: number
  data: ArrayBuffer
  uncompressedSize: number
}

interface DecodeResponse {
  type: 'decoded'
  id: number
  data: ArrayBuffer
}

interface ErrorResponse {
  type: 'error'
  id: number
  message: string
}

let decoder: ZSTDDecoder | null = null

async function getDecoder(): Promise<ZSTDDecoder> {
  if (!decoder) {
    decoder = new ZSTDDecoder()
    await decoder.init()
  }
  return decoder
}

globalThis.onmessage = async (event: MessageEvent<DecodeRequest>) => {
  const msg = event.data
  if (msg.type !== 'decode')
    return

  try {
    const dec = await getDecoder()
    const decompressed = dec.decode(new Uint8Array(msg.data), msg.uncompressedSize)
    const response: DecodeResponse = {
      type: 'decoded',
      id: msg.id,
      data: decompressed.buffer as ArrayBuffer,
    }
    globalThis.postMessage(response, [decompressed.buffer as ArrayBuffer])
  }
  catch (error) {
    const response: ErrorResponse = {
      type: 'error',
      id: msg.id,
      message: error instanceof Error ? error.message : String(error),
    }
    globalThis.postMessage(response)
  }
}
