export interface GameConfig {
  id: string
  name: string
  pages: string[]
  domains: string[]
  audioLangs?: string[]
  features?: ('usm-decode')[]
}

export interface AppPage {
  id: string
  name: string
  component: () => Promise<unknown>
}

export interface PkgFile {
  name: string
  url: string
  checksum: string
  size: number
}

/**
 * ZIP 提取来源：一个游戏包（`game.full` 单文件）或一组分卷（`game.segments`）。
 * `parts` 按顺序拼接成虚拟连续文件，`label` 用于 UI 展示。
 */
export interface ZipSource {
  label: string
  parts: PkgFile[]
}

export interface VoiceMap {
  'zh-cn'?: PkgFile
  'en-us'?: PkgFile
  'ja-jp'?: PkgFile
  'ko-kr'?: PkgFile
}

export interface UpdateEntry {
  game?: PkgFile
  voice: VoiceMap
}

export interface ChunkInfo {
  branch: string
  package_id: string
  password: string
  tag: string
  diff_tags?: string[]
}

export interface VersionData {
  game: {
    full?: PkgFile
    segments?: PkgFile[]
  }
  voice: VoiceMap
  update: Record<string, UpdateEntry>
  decompressed_path: string | null
  chunk: ChunkInfo | null
}

export interface ChunkManifestStats {
  compressed_size: string
  uncompressed_size: string
  file_count: string
  chunk_count: string
}

export interface ChunkManifest {
  category_id: string
  category_name: string
  manifest: {
    id: string
    checksum: string
    compressed_size: string
    uncompressed_size: string
  }
  chunk_download: {
    encryption: number
    password: string
    compression: number
    url_prefix: string
    url_suffix: string
  }
  manifest_download: {
    encryption: number
    password: string
    compression: number
    url_prefix: string
    url_suffix: string
  }
  matching_field: string
  stats: ChunkManifestStats
  deduplicated_stats: ChunkManifestStats
}

export interface GameFileRecord {
  remoteName: string
  md5: string
  hash?: string
  fileSize: number
  /** 该文件可从中提取的 ZIP 来源（游戏包或语音包），由页面在合并文件列表时标注 */
  zipSource?: ZipSource
}

export interface VersionEntry {
  version: string
  state: 'AVAILABLE' | 'DELETED'
  md5: string | null
  size: number | null
}

export interface FileRecord {
  filename: string
  state: 'AVAILABLE' | 'DELETED'
  versions: VersionEntry[]
}

export interface ParsedChunk {
  id: string
  checksum: string
  offset: number
  compressedSize: number
  uncompressedSize: number
}

export interface ParsedFile {
  path: string
  chunks: ParsedChunk[]
  isFolder: boolean
  size: number
  checksum: string
}

export interface ParsedManifest {
  files: ParsedFile[]
}

export type DownloadStatus
  = | 'pending'
    | 'downloading'
    | 'decompressing'
    | 'merging'
    | 'success'
    | 'failed'
    | 'cancelled'

export interface DownloadTask {
  id: string
  type: 'manifest-json' | 'chunk-file' | 'usm-mkv-export' | 'zip-file'
  status: DownloadStatus
  name: string
  progress: number
  error?: string
}

export interface FileBrowserAudioOption {
  lang: string
  label: string
  active: boolean
  loading: boolean
}

export interface FileBrowserSource {
  version: string
  files: GameFileRecord[]
  isLoading: boolean
  error: string | null
  decompressedPath: string | null
  hasChunk: boolean
  audioOptions?: FileBrowserAudioOption[]
}

/** USM 数据源类型：直链 / Chunk / ZIP */
export type UsmSourceKind = 'direct' | 'chunk' | 'zip'

/** USM 播放/导出数据源选项（弹窗展示用） */
export interface UsmSourceOption {
  kind: UsmSourceKind
  /** 数据源标题，如「直链」「Chunk」「ZIP」 */
  label: string
  /** 数据源版本（直链/Chunk/ZIP 对应的游戏版本） */
  version: string | null
  /** 直链下载地址（kind === 'direct' 时有效） */
  directDownloadUrl: string | null
  /** Chunk 版本（kind === 'chunk' 时有效） */
  chunkVersion: string | null
  /** ZIP 来源（kind === 'zip' 时有效） */
  zipSource: ZipSource | null
  /** ZIP 版本（kind === 'zip' 时有效） */
  zipVersion: string | null
}
