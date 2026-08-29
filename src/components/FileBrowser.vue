<script setup lang="ts">
import type { FileBrowserAudioOption, FileBrowserSource, GameFileRecord } from '@/types'
import { formatBytes, highlightText } from '@/utils/file'

type ChangeType = 'added' | 'changed' | 'deleted' | 'unchanged'

interface BrowserFileItem {
  remoteName: string
  sourceA: GameFileRecord | null
  sourceB: GameFileRecord | null
  changeType: ChangeType
}

interface NormalFolderStats {
  directObjectCount: number
  totalSize: number
}

interface DiffFolderStats {
  added: number
  changed: number
  deleted: number
  sizeDelta: number
}

interface FileInfoPanelItem {
  key: string
  file: GameFileRecord
  version: string
  downloadUrl: string | null
  hasChunk: boolean
}

interface Props {
  sourceA: FileBrowserSource
  sourceB?: FileBrowserSource | null
}

const props = defineProps<Props>()

const emit = defineEmits<{
  load: []
  toggleAudio: [lang: string]
  downloadChunkFile: [payload: { file: GameFileRecord, version: string }]
  extractZipFile: [payload: { file: GameFileRecord, version: string }]
}>()

const currentPath = ref<string[]>([])
const searchQuery = ref('')
const changeTypeFilter = ref<Exclude<ChangeType, 'unchanged'> | null>(null)
const selectedFile = ref<BrowserFileItem | null>(null)

const sourceA = computed(() => props.sourceA)
const sourceB = computed(() => props.sourceB ?? null)
const isDiffMode = computed(() => !!props.sourceB)
const audioOptions = computed<FileBrowserAudioOption[]>(() => props.sourceA.audioOptions ?? props.sourceB?.audioOptions ?? [])
const isLoading = computed(() => props.sourceA.isLoading || !!props.sourceB?.isLoading)
const error = computed(() => props.sourceA.error || props.sourceB?.error || null)

watch(
  () => [
    props.sourceA.version,
    props.sourceA.files,
    props.sourceB?.version ?? null,
    props.sourceB?.files ?? null,
  ],
  () => {
    currentPath.value = []
    searchQuery.value = ''
    changeTypeFilter.value = null
    selectedFile.value = null
  },
)

const browserFiles = computed<BrowserFileItem[]>(() => {
  if (!isDiffMode.value) {
    return [...props.sourceA.files]
      .sort((a, b) => a.remoteName.localeCompare(b.remoteName))
      .map(file => ({
        remoteName: file.remoteName,
        sourceA: file,
        sourceB: null,
        changeType: 'unchanged' as const,
      }))
  }

  const sourceB = props.sourceB
  if (!sourceB)
    return []

  const mapA = new Map(props.sourceA.files.map(file => [file.remoteName, file]))
  const mapB = new Map(sourceB.files.map(file => [file.remoteName, file]))
  const result: BrowserFileItem[] = []

  for (const [remoteName, fileA] of mapA) {
    const fileB = mapB.get(remoteName)
    if (!fileB) {
      result.push({ remoteName, sourceA: fileA, sourceB: null, changeType: 'deleted' })
      continue
    }

    result.push({
      remoteName,
      sourceA: fileA,
      sourceB: fileB,
      changeType: fileA.md5 === fileB.md5 ? 'unchanged' : 'changed',
    })
  }

  for (const [remoteName, fileB] of mapB) {
    if (!mapA.has(remoteName))
      result.push({ remoteName, sourceA: null, sourceB: fileB, changeType: 'added' })
  }

  return result.sort((a, b) => a.remoteName.localeCompare(b.remoteName))
})

const fileStats = computed(() => {
  if (isDiffMode.value || !props.sourceA.files.length)
    return null

  return {
    count: props.sourceA.files.length,
    totalSize: props.sourceA.files.reduce((sum, file) => sum + file.fileSize, 0),
  }
})

const diffStats = computed(() => {
  if (!isDiffMode.value)
    return null

  let added = 0
  let changed = 0
  let deleted = 0
  let totalSizeA = 0
  let totalSizeB = 0

  for (const file of browserFiles.value) {
    totalSizeA += file.sourceA?.fileSize ?? 0
    totalSizeB += file.sourceB?.fileSize ?? 0

    if (file.changeType === 'added')
      added++
    else if (file.changeType === 'changed')
      changed++
    else if (file.changeType === 'deleted')
      deleted++
  }

  return {
    added,
    changed,
    deleted,
    totalSizeA,
    totalSizeB,
    sizeDiff: totalSizeB - totalSizeA,
  }
})

function enterFolder(name: string) {
  currentPath.value = [...currentPath.value, name]
  selectedFile.value = null
}

function navigateTo(index: number) {
  currentPath.value = currentPath.value.slice(0, index)
  selectedFile.value = null
}

function selectFile(file: BrowserFileItem) {
  selectedFile.value = selectedFile.value?.remoteName === file.remoteName ? null : file
}

function getFilename(path: string) {
  return path.slice(path.lastIndexOf('/') + 1)
}

function getFileDisplaySize(file: BrowserFileItem) {
  if (!isDiffMode.value)
    return formatBytes(file.sourceA?.fileSize ?? 0)
  if (file.changeType === 'added')
    return `+${formatBytes(file.sourceB?.fileSize ?? 0)}`
  if (file.changeType === 'deleted')
    return `-${formatBytes(file.sourceA?.fileSize ?? 0)}`
  if (file.changeType === 'changed')
    return `${formatBytes(file.sourceA?.fileSize ?? 0)} → ${formatBytes(file.sourceB?.fileSize ?? 0)}`
  return formatBytes(file.sourceB?.fileSize ?? file.sourceA?.fileSize ?? 0)
}

function getFileColor(changeType: ChangeType) {
  if (changeType === 'added')
    return 'text-green-600 dark:text-green-400'
  if (changeType === 'changed')
    return 'text-blue-600 dark:text-blue-400'
  if (changeType === 'deleted')
    return 'text-red-600 dark:text-red-400'
  return 'text-gray-700 dark:text-gray-200'
}

function getChangeLabel(changeType: ChangeType) {
  if (changeType === 'added')
    return '新增'
  if (changeType === 'changed')
    return '变更'
  if (changeType === 'deleted')
    return '删除'
  return '未变更'
}

function getChangeBadgeClass(changeType: ChangeType) {
  if (changeType === 'added')
    return 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
  if (changeType === 'changed')
    return 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400'
  if (changeType === 'deleted')
    return 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
  return 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300'
}

function getFolderColor(stats: DiffFolderStats) {
  const total = stats.added + stats.changed + stats.deleted
  if (total === 0)
    return 'text-gray-700 dark:text-gray-200'
  if (stats.deleted === 0 && stats.changed === 0)
    return 'text-green-600 dark:text-green-400'
  if (stats.added === 0 && stats.changed === 0)
    return 'text-red-600 dark:text-red-400'
  return 'text-blue-600 dark:text-blue-400'
}

function getFolderDiffStats(folderPath: string): DiffFolderStats {
  const prefix = `${folderPath}/`
  let added = 0
  let changed = 0
  let deleted = 0
  let sizeDelta = 0

  for (const file of browserFiles.value) {
    if (!file.remoteName.startsWith(prefix))
      continue
    if (file.changeType === 'added') {
      added++
      sizeDelta += file.sourceB?.fileSize ?? 0
    }
    else if (file.changeType === 'changed') {
      changed++
      sizeDelta += (file.sourceB?.fileSize ?? 0) - (file.sourceA?.fileSize ?? 0)
    }
    else if (file.changeType === 'deleted') {
      deleted++
      sizeDelta -= file.sourceA?.fileSize ?? 0
    }
  }

  return { added, changed, deleted, sizeDelta }
}

const currentDirItems = computed(() => {
  const prefix = currentPath.value.length ? `${currentPath.value.join('/')}/` : ''

  if (!isDiffMode.value) {
    const folderStats = new Map<string, NormalFolderStats>()
    const seenSubfolders = new Map<string, Set<string>>()
    const files: BrowserFileItem[] = []

    for (const file of browserFiles.value) {
      if (!file.remoteName.startsWith(prefix))
        continue

      const rest = file.remoteName.slice(prefix.length)
      const slashIdx = rest.indexOf('/')
      if (slashIdx === -1) {
        files.push(file)
        continue
      }

      const folderName = rest.slice(0, slashIdx)
      const stats = folderStats.get(folderName) ?? { directObjectCount: 0, totalSize: 0 }
      const afterFolder = rest.slice(slashIdx + 1)
      if (!afterFolder.includes('/')) {
        stats.directObjectCount++
      }
      else {
        const subfolderName = afterFolder.slice(0, afterFolder.indexOf('/'))
        const seen = seenSubfolders.get(folderName) ?? new Set<string>()
        if (!seen.has(subfolderName)) {
          seen.add(subfolderName)
          stats.directObjectCount++
          seenSubfolders.set(folderName, seen)
        }
      }
      stats.totalSize += file.sourceA?.fileSize ?? 0
      folderStats.set(folderName, stats)
    }

    return {
      folders: [...folderStats.keys()].sort((a, b) => a.localeCompare(b)).map(name => ({
        name,
        normalStats: folderStats.get(name)!,
        diffStats: null,
      })),
      files: files.sort((a, b) => a.remoteName.localeCompare(b.remoteName)),
    }
  }

  const allFolders = new Set<string>()
  const matchedFolders = new Set<string>()
  const files: BrowserFileItem[] = []

  for (const file of browserFiles.value) {
    if (!file.remoteName.startsWith(prefix))
      continue

    const rest = file.remoteName.slice(prefix.length)
    const slashIdx = rest.indexOf('/')
    if (slashIdx === -1) {
      if (!changeTypeFilter.value || file.changeType === changeTypeFilter.value)
        files.push(file)
      continue
    }

    const folderName = rest.slice(0, slashIdx)
    allFolders.add(folderName)
    if (!changeTypeFilter.value || file.changeType === changeTypeFilter.value)
      matchedFolders.add(folderName)
  }

  const folderNames = changeTypeFilter.value ? matchedFolders : allFolders

  return {
    folders: [...folderNames].sort((a, b) => a.localeCompare(b)).map(name => ({
      name,
      normalStats: null,
      diffStats: getFolderDiffStats(`${prefix}${name}`),
    })),
    files: files.sort((a, b) => a.remoteName.localeCompare(b.remoteName)),
  }
})

const shouldUseFlatList = computed(() => {
  return !!searchQuery.value.trim() || !!(isDiffMode.value && changeTypeFilter.value)
})

const flatResults = computed<BrowserFileItem[]>(() => {
  const query = searchQuery.value.trim().toLowerCase()
  if (!shouldUseFlatList.value)
    return []

  return browserFiles.value.filter((file) => {
    if (isDiffMode.value && changeTypeFilter.value && file.changeType !== changeTypeFilter.value)
      return false
    if (!query)
      return true
    return file.remoteName.toLowerCase().includes(query)
  })
})

function getFileDownloadUrl(source: FileBrowserSource | null | undefined, file: GameFileRecord | null) {
  if (!source?.decompressedPath || !file)
    return null
  const prefix = source.decompressedPath.endsWith('/') ? source.decompressedPath : `${source.decompressedPath}/`
  return `${prefix}${file.remoteName}`
}

const selectedSourceA = computed(() => selectedFile.value?.sourceA ?? null)
const selectedSourceB = computed(() => selectedFile.value?.sourceB ?? null)
const fileDownloadUrlA = computed(() => getFileDownloadUrl(sourceA.value, selectedSourceA.value))
const fileDownloadUrlB = computed(() => getFileDownloadUrl(sourceB.value, selectedSourceB.value))
const diffFileInfoPanels = computed<FileInfoPanelItem[]>(() => {
  const items: FileInfoPanelItem[] = []

  if (selectedSourceA.value) {
    items.push({
      key: 'sourceA',
      file: selectedSourceA.value,
      version: sourceA.value.version,
      downloadUrl: fileDownloadUrlA.value,
      hasChunk: sourceA.value.hasChunk,
    })
  }

  if (sourceB.value && selectedSourceB.value) {
    items.push({
      key: 'sourceB',
      file: selectedSourceB.value,
      version: sourceB.value.version,
      downloadUrl: fileDownloadUrlB.value,
      hasChunk: sourceB.value.hasChunk,
    })
  }

  return items
})
</script>

<template>
  <div class="flex min-h-0 flex-1 overflow-hidden">
    <div class="flex min-w-0 flex-1 flex-col border-r border-gray-200 dark:border-gray-700">
      <div class="flex shrink-0 items-center gap-2 border-b border-gray-200 bg-gray-50 px-3 py-2 dark:border-gray-700 dark:bg-gray-800/50">
        <div class="relative flex-1">
          <LucideSearch class="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" />
          <input
            v-model="searchQuery"
            type="text"
            placeholder="搜索文件"
            class="w-full rounded-lg border border-gray-200 bg-white py-1.5 pl-7 pr-3 text-sm text-gray-700 placeholder-gray-400 focus:border-blue-400 focus:outline-none dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:placeholder-gray-500"
          >
        </div>
        <template v-if="audioOptions.length">
          <div class="h-4 w-px bg-gray-200 dark:bg-gray-700" />
          <button
            v-for="option in audioOptions"
            :key="option.lang"
            class="flex items-center gap-1 rounded-lg border px-2 py-1 text-xs font-medium transition-colors focus:outline-none"
            :class="option.active
              ? 'border-blue-400 bg-blue-50 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400'
              : 'border-gray-200 bg-white text-gray-500 hover:border-gray-300 hover:text-gray-700 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-400 dark:hover:text-gray-200'"
            :disabled="option.loading"
            @click="emit('toggleAudio', option.lang)"
          >
            <LucideLoader2 v-if="option.loading" class="h-3 w-3 animate-spin" />
            <LucideMusic v-else class="h-3 w-3" />
            {{ option.label }}
          </button>
        </template>
      </div>

      <div
        v-if="isDiffMode && diffStats"
        class="flex shrink-0 flex-wrap items-center gap-3 border-b border-gray-200 bg-white px-3 py-2 dark:border-gray-700 dark:bg-gray-900"
      >
        <span class="text-xs text-gray-500 dark:text-gray-400">
          {{ sourceA.version }} → {{ sourceB?.version }}
        </span>
        <button
          class="flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium transition-colors focus:outline-none"
          :class="changeTypeFilter === 'added'
            ? 'bg-green-500 text-white dark:bg-green-600'
            : 'bg-green-100 text-green-700 hover:bg-green-200 dark:bg-green-900/30 dark:text-green-400 dark:hover:bg-green-900/50'"
          @click="changeTypeFilter = changeTypeFilter === 'added' ? null : 'added'"
        >
          <LucidePlus class="h-3 w-3" />新增 {{ diffStats.added }}
        </button>
        <button
          class="flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium transition-colors focus:outline-none"
          :class="changeTypeFilter === 'changed'
            ? 'bg-blue-500 text-white dark:bg-blue-600'
            : 'bg-blue-100 text-blue-700 hover:bg-blue-200 dark:bg-blue-900/30 dark:text-blue-400 dark:hover:bg-blue-900/50'"
          @click="changeTypeFilter = changeTypeFilter === 'changed' ? null : 'changed'"
        >
          <LucideRefreshCw class="h-3 w-3" />变更 {{ diffStats.changed }}
        </button>
        <button
          class="flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium transition-colors focus:outline-none"
          :class="changeTypeFilter === 'deleted'
            ? 'bg-red-500 text-white dark:bg-red-600'
            : 'bg-red-100 text-red-700 hover:bg-red-200 dark:bg-red-900/30 dark:text-red-400 dark:hover:bg-red-900/50'"
          @click="changeTypeFilter = changeTypeFilter === 'deleted' ? null : 'deleted'"
        >
          <LucideTrash2 class="h-3 w-3" />删除 {{ diffStats.deleted }}
        </button>
        <div class="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
          <span class="text-gray-400 dark:text-gray-500">{{ formatBytes(diffStats.totalSizeA) }}</span>
          <LucideArrowRight class="h-3 w-3 shrink-0" />
          <span>{{ formatBytes(diffStats.totalSizeB) }}</span>
          <span
            class="font-medium"
            :class="diffStats.sizeDiff > 0
              ? 'text-green-600 dark:text-green-400'
              : diffStats.sizeDiff < 0
                ? 'text-red-500 dark:text-red-400'
                : 'text-gray-400 dark:text-gray-500'"
          >
            {{ diffStats.sizeDiff > 0 ? '+' : diffStats.sizeDiff < 0 ? '-' : '' }}{{ formatBytes(Math.abs(diffStats.sizeDiff)) }}
          </span>
        </div>
      </div>

      <div
        v-if="!isDiffMode && fileStats"
        class="flex shrink-0 items-center gap-4 border-b border-gray-200 bg-white px-3 py-1.5 text-xs dark:border-gray-700 dark:bg-gray-900/50"
      >
        <div class="flex items-center gap-1.5">
          <LucideFiles class="h-3.5 w-3.5 text-blue-500" />
          <span class="text-gray-500 dark:text-gray-400">文件总数</span>
          <span class="font-semibold text-gray-800 dark:text-gray-100">{{ fileStats.count.toLocaleString() }}</span>
        </div>
        <div class="flex items-center gap-1.5">
          <LucideHardDrive class="h-3.5 w-3.5 text-green-500" />
          <span class="text-gray-500 dark:text-gray-400">总大小</span>
          <span class="font-semibold text-gray-800 dark:text-gray-100">{{ formatBytes(fileStats.totalSize) }}</span>
        </div>
      </div>

      <div
        v-if="isLoading"
        class="flex flex-1 items-center justify-center text-gray-400 dark:text-gray-500"
      >
        <LucideLoader2 class="mr-2 h-5 w-5 animate-spin" />
        <span>{{ isDiffMode ? '加载对比文件列表...' : '加载文件列表...' }}</span>
      </div>

      <div
        v-else-if="error"
        class="flex flex-1 flex-col items-center justify-center gap-2 text-red-500"
      >
        <LucideAlertCircle class="h-6 w-6" />
        <span class="text-sm">{{ isDiffMode ? '文件对比加载失败' : '文件列表加载失败' }}</span>
        <button
          class="rounded-md border border-red-300 px-3 py-1 text-xs hover:bg-red-50 dark:border-red-700 dark:hover:bg-red-900/20"
          @click="emit('load')"
        >
          重试
        </button>
      </div>

      <template v-else-if="browserFiles.length">
        <template v-if="shouldUseFlatList">
          <div class="shrink-0 border-b border-gray-200 px-3 py-1.5 text-xs text-gray-400 dark:border-gray-700 dark:text-gray-500">
            {{ searchQuery.trim() ? '找到' : '筛选到' }} {{ flatResults.length.toLocaleString() }} 个文件
          </div>
          <div class="min-h-0 flex-1 overflow-y-auto">
            <div
              v-for="file in flatResults"
              :key="file.remoteName"
              class="flex cursor-pointer items-center gap-2 border-b border-gray-100 px-3 py-2 text-sm hover:bg-gray-50 dark:border-gray-800 dark:hover:bg-gray-800/60"
              :class="selectedFile?.remoteName === file.remoteName ? 'bg-blue-50 dark:bg-blue-900/20' : ''"
              @click="selectFile(file)"
            >
              <LucideFile class="h-4 w-4 shrink-0 text-gray-400" />
              <span class="min-w-0 break-all text-xs" :class="getFileColor(file.changeType)" v-html="highlightText(file.remoteName, searchQuery)" />
              <span class="ml-auto shrink-0 text-xs text-gray-400 dark:text-gray-500">{{ getFileDisplaySize(file) }}</span>
            </div>
            <div v-if="flatResults.length === 0" class="py-8 text-center text-sm text-gray-400 dark:text-gray-500">
              无匹配文件
            </div>
          </div>
        </template>

        <template v-else>
          <div class="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-gray-200 px-3 py-1.5 dark:border-gray-700">
            <button
              class="shrink-0 text-xs text-blue-500 hover:underline focus:outline-none dark:text-blue-400"
              @click="navigateTo(0)"
            >
              根目录
            </button>
            <template v-for="(seg, i) in currentPath" :key="i">
              <LucideChevronRight class="h-3 w-3 shrink-0 text-gray-400" />
              <button
                class="shrink-0 text-xs text-blue-500 hover:underline focus:outline-none dark:text-blue-400"
                :class="i === currentPath.length - 1 ? 'pointer-events-none text-gray-600 dark:text-gray-300' : ''"
                @click="navigateTo(i + 1)"
              >
                {{ seg }}
              </button>
            </template>
          </div>

          <div class="min-h-0 flex-1 overflow-y-auto">
            <div
              v-for="folder in currentDirItems.folders"
              :key="`dir-${folder.name}`"
              class="flex cursor-pointer items-center gap-2 border-b border-gray-100 px-3 py-2 hover:bg-gray-50 dark:border-gray-800 dark:hover:bg-gray-800/60"
              @click="enterFolder(folder.name)"
            >
              <LucideFolder class="h-4 w-4 shrink-0 text-yellow-400" />
              <span
                class="text-sm"
                :class="folder.diffStats ? `font-medium ${getFolderColor(folder.diffStats)}` : 'text-gray-700 dark:text-gray-200'"
              >
                {{ folder.name }}
              </span>
              <span v-if="folder.normalStats" class="text-xs text-gray-500 dark:text-gray-400">{{ folder.normalStats.directObjectCount }}</span>
              <div v-if="folder.diffStats" class="ml-1 flex items-center gap-1.5 text-xs">
                <span v-if="folder.diffStats.added > 0" class="text-green-600 dark:text-green-400">+{{ folder.diffStats.added }}</span>
                <span v-if="folder.diffStats.changed > 0" class="text-blue-500 dark:text-blue-400">~{{ folder.diffStats.changed }}</span>
                <span v-if="folder.diffStats.deleted > 0" class="text-red-500 dark:text-red-400">-{{ folder.diffStats.deleted }}</span>
              </div>
              <span
                class="ml-auto shrink-0 text-xs"
                :class="folder.diffStats
                  ? folder.diffStats.sizeDelta > 0
                    ? 'font-medium text-green-600 dark:text-green-400'
                    : folder.diffStats.sizeDelta < 0
                      ? 'font-medium text-red-500 dark:text-red-400'
                      : 'text-gray-400 dark:text-gray-500'
                  : 'text-gray-400 dark:text-gray-500'"
              >
                <template v-if="folder.normalStats">
                  {{ formatBytes(folder.normalStats.totalSize) }}
                </template>
                <template v-else-if="folder.diffStats && folder.diffStats.sizeDelta !== 0">
                  {{ folder.diffStats.sizeDelta > 0 ? '+' : '-' }}{{ formatBytes(Math.abs(folder.diffStats.sizeDelta)) }}
                </template>
                <template v-else>-</template>
              </span>
            </div>

            <div
              v-for="file in currentDirItems.files"
              :key="`file-${file.remoteName}`"
              class="flex cursor-pointer items-center gap-2 border-b border-gray-100 px-3 py-2 hover:bg-gray-50 dark:border-gray-800 dark:hover:bg-gray-800/60"
              :class="selectedFile?.remoteName === file.remoteName ? 'bg-blue-50 dark:bg-blue-900/20' : ''"
              @click="selectFile(file)"
            >
              <LucideFile class="h-4 w-4 shrink-0 text-gray-400" />
              <div class="min-w-0 flex-1">
                <span class="min-w-0 truncate text-sm" :class="getFileColor(file.changeType)">
                  {{ getFilename(file.remoteName) }}
                </span>
              </div>
              <span class="ml-auto shrink-0 text-xs text-gray-400 dark:text-gray-500">{{ getFileDisplaySize(file) }}</span>
            </div>

            <div
              v-if="currentDirItems.folders.length === 0 && currentDirItems.files.length === 0"
              class="py-8 text-center text-sm text-gray-400 dark:text-gray-500"
            >
              此目录为空
            </div>
          </div>
        </template>
      </template>

      <div
        v-else
        class="flex flex-1 flex-col items-center justify-center gap-3 text-gray-400 dark:text-gray-500"
      >
        <LucideFiles class="h-8 w-8" />
        <p class="text-sm">
          {{ isDiffMode ? '暂无可对比文件' : '尚未加载文件列表' }}
        </p>
        <button
          class="flex items-center gap-1.5 rounded-lg bg-blue-500 px-4 py-2 text-sm text-white hover:bg-blue-600 focus:outline-none dark:bg-blue-600 dark:hover:bg-blue-700"
          @click="emit('load')"
        >
          <LucideDownload class="h-4 w-4" />
          {{ isDiffMode ? '重新加载对比' : '加载文件列表' }}
        </button>
      </div>
    </div>

    <div
      v-if="selectedFile"
      class="fixed inset-0 z-50 flex flex-col border-l border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-800 md:relative md:inset-auto md:z-auto md:w-80 md:shrink-0 md:dark:bg-gray-800/30"
    >
      <div class="flex items-center justify-between border-b border-gray-200 px-3 py-2 dark:border-gray-700">
        <div class="flex items-center gap-2">
          <span class="text-xs font-medium text-gray-600 dark:text-gray-300">文件详情</span>
          <span
            v-if="isDiffMode"
            class="rounded px-1.5 py-0.5 text-[10px] font-medium"
            :class="getChangeBadgeClass(selectedFile.changeType)"
          >
            {{ getChangeLabel(selectedFile.changeType) }}
          </span>
        </div>
        <button
          class="rounded p-0.5 text-gray-400 hover:text-gray-600 focus:outline-none dark:hover:text-gray-200"
          @click="selectedFile = null"
        >
          <LucideX class="h-4 w-4" />
        </button>
      </div>
      <div class="min-h-0 flex-1 overflow-y-auto p-3">
        <div class="space-y-3">
          <div>
            <p class="mb-1 text-xs font-medium text-gray-500 dark:text-gray-400">
              文件路径
            </p>
            <p class="break-all text-xs text-gray-700 dark:text-gray-200">
              {{ selectedFile.remoteName }}
            </p>
          </div>

          <template v-if="!isDiffMode && selectedSourceA">
            <FileInfoPanel
              :file="selectedSourceA"
              :download-url="fileDownloadUrlA"
              :has-chunk="sourceA.hasChunk"
              :version="sourceA.version"
              :zip-source="selectedSourceA.zipSource ?? null"
              @download-chunk-file="emit('downloadChunkFile', $event)"
              @extract-zip-file="emit('extractZipFile', $event)"
            />
          </template>

          <template v-else>
            <FileInfoPanel
              v-for="panel in diffFileInfoPanels"
              :key="panel.key"
              :file="panel.file"
              :title="`版本 ${panel.version}`"
              :download-url="panel.downloadUrl"
              :has-chunk="panel.hasChunk"
              :version="panel.version"
              :zip-source="panel.file.zipSource ?? null"
              boxed
              @download-chunk-file="emit('downloadChunkFile', $event)"
              @extract-zip-file="emit('extractZipFile', $event)"
            />
          </template>
        </div>
      </div>
    </div>
  </div>
</template>
