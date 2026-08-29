import type { ParsedManifest } from '@/types'
import protobuf from 'protobufjs/light'
import { getManifest, setManifest } from './idb'
import { decodeZstd } from './zstdWorker'

const root = new protobuf.Root()

root.add(
  new protobuf.Type('Chunk')
    .add(new protobuf.Field('id', 1, 'string'))
    .add(new protobuf.Field('checksum', 2, 'string'))
    .add(new protobuf.Field('offset', 3, 'int32'))
    .add(new protobuf.Field('compressedSize', 4, 'int32'))
    .add(new protobuf.Field('uncompressedSize', 5, 'int32')),
)

root.add(
  new protobuf.Type('File')
    .add(new protobuf.Field('path', 1, 'string'))
    .add(new protobuf.Field('chunks', 2, 'Chunk', 'repeated'))
    .add(new protobuf.Field('isFolder', 3, 'bool'))
    .add(new protobuf.Field('size', 4, 'int32'))
    .add(new protobuf.Field('checksum', 5, 'string')),
)

root.add(
  new protobuf.Type('Manifest')
    .add(new protobuf.Field('files', 1, 'File', 'repeated')),
)

const ManifestMsg = root.lookupType('Manifest')

export async function parseManifestBinary(data: Uint8Array, uncompressedSize: number): Promise<ParsedManifest> {
  // ZSTD 解压移入 worker；protobuf 解码留在主线程（避免大 ParsedManifest 跨线程序列化）
  const decompressed = await decodeZstd(data, uncompressedSize)
  const msg = ManifestMsg.decode(decompressed)
  return ManifestMsg.toObject(msg, {
    longs: Number,
    defaults: true,
    arrays: true,
    objects: true,
  }) as ParsedManifest
}

export async function fetchAndParseManifest(
  url: string,
  cacheKey: string,
  uncompressedSize: number,
  signal?: AbortSignal,
): Promise<ParsedManifest> {
  const cached = await getManifest(cacheKey)
  if (cached)
    return cached

  const res = await fetch(url, { signal })
  if (!res.ok)
    throw new Error(`Manifest 下载失败：${res.status}`)

  const buffer = await res.arrayBuffer()
  const parsed = await parseManifestBinary(new Uint8Array(buffer), uncompressedSize)

  const size = JSON.stringify(parsed).length * 2
  await setManifest(cacheKey, parsed, size)

  return parsed
}
