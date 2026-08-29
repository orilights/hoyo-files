<script setup lang="ts">
import type { GameFileRecord, UsmSourceKind, UsmSourceOption, VersionEntry, ZipSource } from '@/types'
import { useGameVersions } from '@/api/files'
import { useUsmHistory } from '@/api/usm'
import { API_BASE, GameList } from '@/constants/core'
import { useDownload } from '@/store/download'
import { useSettings } from '@/store/settings'
import { formatBytes, highlightText } from '@/utils/file'
import { compareSemver, sortVersions } from '@/utils/semver'
import { getGameZipSource } from '@/utils/zip'

const route = useRoute()
const gameId = computed(() => route.params.gameId as string)

const usmDecodeEnabled = computed(() => {
  const game = GameList.find(g => g.id === gameId.value)
  return game?.features?.includes('usm-decode') ?? false
})

const usmKeyMap = ref<Record<string, string> | null>(null)

watch(gameId, async () => {
  usmKeyMap.value = null
  if (!usmDecodeEnabled.value)
    return
  try {
    const res = await fetch(`${API_BASE}/usm/${gameId.value}_keys.json`)
    if (res.ok)
      usmKeyMap.value = await res.json()
  }
  catch {}
}, { immediate: true })

function findUsmKey(base: string): string | null {
  return usmKeyMap.value?.[base] ?? null
}

interface ProcessedFile {
  path: string
  filename: string
  state: 'AVAILABLE' | 'DELETED'
  addedVersion: string
  deletedVersion: string | null
  currentVersion: string | null
  latestSize: number | null
  versionCount: number
  versions: VersionEntry[]
}

type ChangeType = 'added' | 'changed' | 'deleted'

interface DisplayFile extends ProcessedFile {
  changeType?: ChangeType
  versionSize?: number | null
  previousSize?: number | null
}

const versionsQuery = useGameVersions(gameId)
const historyQuery = useUsmHistory(gameId)

const sortedVersionList = computed<string[]>(() => {
  if (!versionsQuery.data.value)
    return []
  return sortVersions(Object.keys(versionsQuery.data.value))
})

const sortedVersionListDesc = computed<string[]>(() => [...sortedVersionList.value].reverse())

const latestVersion = computed(() => sortedVersionList.value[sortedVersionList.value.length - 1] ?? null)

const allFiles = computed<ProcessedFile[]>(() => {
  if (!historyQuery.data.value)
    return []

  return Object.entries(historyQuery.data.value).map(([path, record]) => {
    const versions = record.versions ?? []
    const sortedVers = [...versions].sort((a, b) => compareSemver(a.version, b.version))

    const firstAvail = sortedVers.find(v => v.state === 'AVAILABLE')
    const addedVersion = firstAvail?.version ?? sortedVers[0]?.version ?? '?'

    const deletedEntry = sortedVers.filter(v => v.state === 'DELETED').at(-1)
    const deletedVersion = record.state === 'DELETED' ? (deletedEntry?.version ?? null) : null

    const latestAvail = [...sortedVers].reverse().find(v => v.state === 'AVAILABLE')
    const currentVersion = latestAvail?.version ?? null

    const displayCurrentVersion = currentVersion && currentVersion !== addedVersion ? currentVersion : null

    return {
      path,
      filename: record.filename,
      state: record.state as 'AVAILABLE' | 'DELETED',
      addedVersion,
      deletedVersion,
      currentVersion: displayCurrentVersion,
      latestSize: latestAvail?.size ?? null,
      versionCount: sortedVers.filter(v => v.state === 'AVAILABLE').length,
      versions: sortedVers,
    } satisfies ProcessedFile
  })
})

const allFilesTotalSize = computed(() => {
  return allFiles.value.reduce((sum, file) => {
    return sum + (file.latestSize ?? 0)
  }, 0)
})

const selectedVersion = ref<string | null>(null)
const selectedFile = ref<ProcessedFile | null>(null)

const changeTypeFilter = ref<ChangeType | null>(null)

watch(gameId, () => {
  selectedVersion.value = null
  selectedFile.value = null
  changeTypeFilter.value = null
})

watch(selectedVersion, () => {
  changeTypeFilter.value = null
})

const filteredFiles = computed<DisplayFile[]>(() => {
  const files = allFiles.value
  const ver = selectedVersion.value
  if (!ver)
    return files

  const result: DisplayFile[] = []
  for (const file of files) {
    const entryAtVer = file.versions.find(v => v.version === ver)
    if (!entryAtVer)
      continue

    let changeType: ChangeType
    if (entryAtVer.state === 'DELETED') {
      changeType = 'deleted'
    }
    else {
      const hasEarlierAvailable = file.versions.some(
        v => v.state === 'AVAILABLE' && compareSemver(v.version, ver) < 0,
      )
      changeType = hasEarlierAvailable ? 'changed' : 'added'
    }

    const previousEntry = file.versions
      .filter(v => v.state === 'AVAILABLE' && compareSemver(v.version, ver) < 0)
      .at(-1)

    result.push({
      ...file,
      changeType,
      versionSize: entryAtVer.state === 'AVAILABLE' ? entryAtVer.size : null,
      previousSize: previousEntry?.size ?? null,
    })
  }
  return result
})

const versionStats = computed(() => {
  if (!selectedVersion.value)
    return null
  const ver = selectedVersion.value
  const changedFiles = filteredFiles.value

  let totalSizeBefore = 0
  let totalSizeAfter = 0
  for (const file of allFiles.value) {
    const beforeEntry = file.versions
      .filter(v => compareSemver(v.version, ver) < 0)
      .at(-1)
    if (beforeEntry?.state === 'AVAILABLE')
      totalSizeBefore += beforeEntry.size ?? 0

    const atEntry = file.versions
      .filter(v => compareSemver(v.version, ver) <= 0)
      .at(-1)
    if (atEntry?.state === 'AVAILABLE')
      totalSizeAfter += atEntry.size ?? 0
  }

  return {
    added: changedFiles.filter(f => f.changeType === 'added').length,
    changed: changedFiles.filter(f => f.changeType === 'changed').length,
    deleted: changedFiles.filter(f => f.changeType === 'deleted').length,
    totalSizeBefore,
    totalSizeAfter,
    sizeDiff: totalSizeAfter - totalSizeBefore,
  }
})

const latestVersionStats = computed(() => {
  const lv = latestVersion.value
  if (!lv || !allFiles.value.length)
    return { count: 0, totalSize: 0 }

  const inLatest = allFiles.value.filter((f) => {
    const relevant = f.versions.filter(v => compareSemver(v.version, lv) <= 0)
    if (relevant.length === 0)
      return false
    return relevant.at(-1)!.state === 'AVAILABLE'
  })

  const totalSize = inLatest.reduce((sum, f) => {
    const relevant = f.versions.filter(v => compareSemver(v.version, lv) <= 0)
    const latest = relevant.filter(v => v.state === 'AVAILABLE').at(-1)
    return sum + (latest?.size ?? 0)
  }, 0)

  return { count: inLatest.length, totalSize }
})

const searchQuery = ref('')
const sortMode = ref<'name-asc' | 'name-desc' | 'version-asc' | 'version-desc'>('name-asc')

const sortOptions = [
  { value: 'name-asc', label: '文件名升序' },
  { value: 'name-desc', label: '文件名降序' },
  { value: 'version-asc', label: '加入版本升序' },
  { value: 'version-desc', label: '加入版本降序' },
]

const displayFiles = computed<DisplayFile[]>(() => {
  const q = searchQuery.value.trim().toLowerCase()
  let files = filteredFiles.value
  if (q) {
    files = files.filter(f =>
      f.filename.toLowerCase().includes(q) || f.path.toLowerCase().includes(q),
    )
  }
  if (changeTypeFilter.value) {
    files = files.filter(f => f.changeType === changeTypeFilter.value)
  }
  if (sortMode.value === 'version-asc') {
    return [...files].sort((a, b) => {
      const vCmp = compareSemver(a.addedVersion, b.addedVersion)
      if (vCmp !== 0)
        return vCmp
      return a.filename.localeCompare(b.filename)
    })
  }
  if (sortMode.value === 'version-desc') {
    return [...files].sort((a, b) => {
      const vCmp = compareSemver(b.addedVersion, a.addedVersion)
      if (vCmp !== 0)
        return vCmp
      return a.filename.localeCompare(b.filename)
    })
  }
  if (sortMode.value === 'name-desc')
    return [...files].sort((a, b) => b.filename.localeCompare(a.filename))
  return [...files].sort((a, b) => a.filename.localeCompare(b.filename))
})

function getEntryCandidates(
  fileVersions: VersionEntry[],
  entryVersion: string,
  availableVersions: string[],
  allGameVersions: string[],
): string[] {
  const idx = availableVersions.indexOf(entryVersion)
  const nextAvailChange = idx >= 0 && idx + 1 < availableVersions.length
    ? availableVersions[idx + 1]
    : null
  const nextDeletion = fileVersions
    .filter(v => v.state === 'DELETED' && compareSemver(v.version, entryVersion) > 0)
    .map(v => v.version)
    .sort(compareSemver)[0] ?? null
  const nextChange = [nextAvailChange, nextDeletion]
    .filter((v): v is string => v !== null)
    .sort(compareSemver)[0] ?? null

  return allGameVersions.filter((gv) => {
    if (compareSemver(gv, entryVersion) < 0)
      return false
    if (nextChange && compareSemver(gv, nextChange) >= 0)
      return false
    return true
  })
}

const selectedFileVersions = computed(() => {
  if (!selectedFile.value)
    return []

  const vData = versionsQuery.data.value ?? {}
  const allGameVersions = sortedVersionList.value
  const fileVersions = selectedFile.value.versions

  const availableVersions = fileVersions
    .filter(v => v.state === 'AVAILABLE')
    .map(v => v.version)
    .sort(compareSemver)

  let firstAvailSeen = false
  return fileVersions.map((entry) => {
    let label: string
    if (entry.state === 'DELETED') {
      label = '删除'
    }
    else if (!firstAvailSeen) {
      firstAvailSeen = true
      label = '新增'
    }
    else {
      label = '变更'
    }

    let directDownloadUrl: string | null = null
    let bestLinkVersion: string | null = null
    let bestChunkVersion: string | null = null
    let bestZipSource: ZipSource | null = null
    let bestZipVersion: string | null = null

    if (entry.state === 'AVAILABLE') {
      const candidates = getEntryCandidates(fileVersions, entry.version, availableVersions, allGameVersions)
      for (let i = candidates.length - 1; i >= 0; i--) {
        const gv = candidates[i]
        if (!directDownloadUrl && vData[gv]?.decompressed_path) {
          bestLinkVersion = gv
          directDownloadUrl = `${vData[gv].decompressed_path!.replace(/\/$/, '')}/${selectedFile.value!.path}`
        }
        if (!bestChunkVersion && vData[gv]?.chunk)
          bestChunkVersion = gv
        if (!bestZipSource) {
          const src = getGameZipSource(vData[gv])
          if (src) {
            bestZipSource = src
            bestZipVersion = gv
          }
        }
        if (directDownloadUrl && bestChunkVersion && bestZipSource)
          break
      }
    }

    return { ...entry, label, bestLinkVersion, directDownloadUrl, bestChunkVersion, bestZipSource, bestZipVersion }
  })
})

function selectFile(file: ProcessedFile) {
  selectedFile.value = selectedFile.value?.path === file.path ? null : file
}

const download = useDownload()
const settings = useSettings()

const chunkLoadingVersion = ref<string | null>(null)

const playableSet = computed<Set<string>>(() => {
  const set = new Set<string>()
  const vData = versionsQuery.data.value ?? {}
  const allGameVersions = sortedVersionList.value

  for (const file of allFiles.value) {
    const base = file.filename.replace(/\.usm$/i, '')
    if (findUsmKey(base) === null)
      continue

    const availableVersions = file.versions
      .filter(v => v.state === 'AVAILABLE')
      .map(v => v.version)
      .sort(compareSemver)

    const hasResource = file.versions.some((entry) => {
      if (entry.state !== 'AVAILABLE')
        return false
      const candidates = getEntryCandidates(file.versions, entry.version, availableVersions, allGameVersions)
      return candidates.some(gv => vData[gv]?.decompressed_path || vData[gv]?.chunk || getGameZipSource(vData[gv]))
    })

    if (hasResource)
      set.add(base)
  }
  return set
})

function isFilePlayable(file: ProcessedFile): boolean {
  const base = file.filename.replace(/\.usm$/i, '')
  return playableSet.value.has(base)
}

interface PlayerState {
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

const playerState = ref<PlayerState | null>(null)

interface SourcePickerState {
  mode: 'play' | 'export'
  entry: SelectedFileVersionEntry
}

type SelectedFileVersionEntry = VersionEntry & {
  label: string
  bestLinkVersion: string | null
  directDownloadUrl: string | null
  bestChunkVersion: string | null
  bestZipSource: ZipSource | null
  bestZipVersion: string | null
}

const sourcePickerState = ref<SourcePickerState | null>(null)

function buildSourceOptions(entry: SelectedFileVersionEntry): UsmSourceOption[] {
  const options: UsmSourceOption[] = []
  if (entry.directDownloadUrl) {
    options.push({
      kind: 'direct',
      label: '直链',
      version: entry.bestLinkVersion,
      directDownloadUrl: entry.directDownloadUrl,
      chunkVersion: null,
      zipSource: null,
      zipVersion: null,
    })
  }
  if (entry.bestChunkVersion) {
    options.push({
      kind: 'chunk',
      label: 'Chunk',
      version: entry.bestChunkVersion,
      directDownloadUrl: null,
      chunkVersion: entry.bestChunkVersion,
      zipSource: null,
      zipVersion: null,
    })
  }
  if (entry.bestZipSource) {
    options.push({
      kind: 'zip',
      label: 'ZIP',
      version: entry.bestZipVersion,
      directDownloadUrl: null,
      chunkVersion: null,
      zipSource: entry.bestZipSource,
      zipVersion: entry.bestZipVersion,
    })
  }
  return options
}

function onDirectDownload(url: string, filename: string) {
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
}

async function onChunkDownload(chunkVersion: string, entryVersion: string) {
  if (!selectedFile.value || chunkLoadingVersion.value)
    return
  chunkLoadingVersion.value = chunkVersion
  try {
    const res = await fetch(`${API_BASE}/chunk/${gameId.value}_${chunkVersion}.json`)
    if (!res.ok)
      throw new Error(`${res.status}`)
    const json = await res.json()
    const manifests = json.data?.manifests ?? []
    const entry = selectedFile.value.versions.find(v => v.version === entryVersion)!
    const file: GameFileRecord = {
      remoteName: selectedFile.value.path,
      md5: entry.md5 ?? '',
      fileSize: entry.size ?? 0,
    }
    download.addChunkFileTask(file, manifests, gameId.value, chunkVersion)
    download.openList()
  }
  catch {}
  finally {
    chunkLoadingVersion.value = null
  }
}

function onZipDownload(zipSource: ZipSource, zipVersion: string | null, entryVersion: string) {
  if (!selectedFile.value)
    return
  const entry = selectedFile.value.versions.find(v => v.version === entryVersion)
  const file: GameFileRecord = {
    remoteName: selectedFile.value.path,
    md5: entry?.md5 ?? '',
    fileSize: entry?.size ?? 0,
    zipSource,
  }
  download.addZipFileTask(file, gameId.value, zipVersion ?? '')
  download.openList()
}

function getEntryKeyHex(filename: string): string | null {
  const base = filename.replace(/\.usm$/i, '')
  return findUsmKey(base)
}

function onPlay(entry: SelectedFileVersionEntry) {
  if (!selectedFile.value)
    return
  const keyHex = getEntryKeyHex(selectedFile.value.filename)
  if (!keyHex)
    return
  sourcePickerState.value = { mode: 'play', entry }
}

function onExportMkv(entry: SelectedFileVersionEntry) {
  if (!selectedFile.value)
    return
  const keyHex = getEntryKeyHex(selectedFile.value.filename)
  if (!keyHex)
    return
  sourcePickerState.value = { mode: 'export', entry }
}

function onSourcePick(option: UsmSourceOption) {
  if (!selectedFile.value || !sourcePickerState.value)
    return
  const keyHex = getEntryKeyHex(selectedFile.value.filename)
  if (!keyHex)
    return

  if (sourcePickerState.value.mode === 'play') {
    playerState.value = {
      filename: selectedFile.value.filename,
      keyHex,
      sourceKind: option.kind,
      directDownloadUrl: option.directDownloadUrl,
      bestChunkVersion: option.chunkVersion,
      zipSource: option.zipSource,
      zipVersion: option.zipVersion,
      gameId: gameId.value,
      filePath: selectedFile.value.path,
    }
  }
  else {
    const prefLang = settings.mkvExportLang
    const gameAudioLangs = GameList.find(g => g.id === gameId.value)?.audioLangs ?? []
    const prefIdx = prefLang === 'all' ? -1 : gameAudioLangs.indexOf(prefLang)
    const chIndex = prefIdx >= 0 ? prefIdx : undefined
    download.addUsmMkvExportTask({
      filename: selectedFile.value.filename,
      filePath: selectedFile.value.path,
      keyHex,
      sourceKind: option.kind,
      directDownloadUrl: option.directDownloadUrl,
      bestChunkVersion: option.chunkVersion,
      zipSource: option.zipSource,
      gameId: gameId.value,
      version: option.zipVersion ?? '',
      chIndex,
    })
    download.openList()
  }
}
</script>

<template>
  <div class="flex h-full flex-col overflow-hidden">
    <div
      v-if="versionsQuery.isPending.value || historyQuery.isPending.value"
      class="flex h-full items-center justify-center text-gray-400 dark:text-gray-500"
    >
      <LucideLoader2 class="mr-2 h-5 w-5 animate-spin" />
      <span>加载中...</span>
    </div>

    <div
      v-else-if="versionsQuery.isError.value || historyQuery.isError.value"
      class="flex h-full items-center justify-center text-red-500"
    >
      <LucideAlertCircle class="mr-2 h-5 w-5" />
      <span>数据加载失败，请重试</span>
    </div>

    <template v-else>
      <div class="flex shrink-0 items-center gap-6 border-b border-gray-200 bg-white px-4 py-3 dark:border-gray-700 dark:bg-gray-900">
        <div class="flex items-center gap-1.5">
          <span class="text-xs text-gray-500 dark:text-gray-400">最新版本</span>
          <span class="text-sm font-semibold text-gray-800 dark:text-gray-100">{{ latestVersion ?? '-' }}</span>
        </div>
        <div class="flex items-center gap-1.5">
          <LucideFileVideo class="h-4 w-4 text-blue-500" />
          <span class="text-xs text-gray-500 dark:text-gray-400">文件总数</span>
          <span class="text-sm font-semibold text-gray-800 dark:text-gray-100">{{ latestVersionStats.count.toLocaleString() }} / {{ allFiles.length.toLocaleString() }}</span>
        </div>
        <div class="flex items-center gap-1.5">
          <LucideHardDrive class="h-4 w-4 text-green-500" />
          <span class="text-xs text-gray-500 dark:text-gray-400">总大小</span>
          <span class="text-sm font-semibold text-gray-800 dark:text-gray-100">{{ formatBytes(latestVersionStats.totalSize) }} / {{ formatBytes(allFilesTotalSize) }}</span>
        </div>
        <div class="ml-auto text-xs text-gray-400 dark:text-gray-500">
          共 {{ allFiles.length.toLocaleString() }} 条记录
        </div>
      </div>

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
            <DropdownSelect
              v-model="selectedVersion"
              :options="[{ value: null, label: '全部版本' }, ...sortedVersionListDesc.map(ver => ({ value: ver, label: ver }))]"
            />
            <DropdownSelect
              v-model="sortMode"
              :options="sortOptions"
            />
            <span class="shrink-0 text-xs text-gray-400 dark:text-gray-500">{{ displayFiles.length.toLocaleString() }} 条记录</span>
          </div>

          <div
            v-if="versionStats"
            class="flex shrink-0 items-center gap-3 border-b border-gray-200 bg-white px-3 py-2 dark:border-gray-700 dark:bg-gray-900"
          >
            <span class="text-xs text-gray-500 dark:text-gray-400">
              版本
              <span class="font-semibold text-gray-700 dark:text-gray-200">{{ selectedVersion }}</span>
            </span>
            <button
              class="flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium transition-colors focus:outline-none"
              :class="changeTypeFilter === 'added'
                ? 'bg-green-500 text-white dark:bg-green-600'
                : 'bg-green-100 text-green-700 hover:bg-green-200 dark:bg-green-900/30 dark:text-green-400 dark:hover:bg-green-900/50'"
              @click="changeTypeFilter = changeTypeFilter === 'added' ? null : 'added'"
            >
              <LucidePlus class="h-3 w-3" />新增 {{ versionStats.added }}
            </button>
            <button
              class="flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium transition-colors focus:outline-none"
              :class="changeTypeFilter === 'changed'
                ? 'bg-blue-500 text-white dark:bg-blue-600'
                : 'bg-blue-100 text-blue-700 hover:bg-blue-200 dark:bg-blue-900/30 dark:text-blue-400 dark:hover:bg-blue-900/50'"
              @click="changeTypeFilter = changeTypeFilter === 'changed' ? null : 'changed'"
            >
              <LucideRefreshCw class="h-3 w-3" />变更 {{ versionStats.changed }}
            </button>
            <button
              class="flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium transition-colors focus:outline-none"
              :class="changeTypeFilter === 'deleted'
                ? 'bg-red-500 text-white dark:bg-red-600'
                : 'bg-red-100 text-red-700 hover:bg-red-200 dark:bg-red-900/30 dark:text-red-400 dark:hover:bg-red-900/50'"
              @click="changeTypeFilter = changeTypeFilter === 'deleted' ? null : 'deleted'"
            >
              <LucideTrash2 class="h-3 w-3" />删除 {{ versionStats.deleted }}
            </button>
            <div class="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
              <span class="text-gray-400 dark:text-gray-500">{{ formatBytes(versionStats.totalSizeBefore) }}</span>
              <LucideArrowRight class="h-3 w-3 shrink-0" />
              <span>{{ formatBytes(versionStats.totalSizeAfter) }}</span>
              <span
                class="font-medium"
                :class="versionStats.sizeDiff > 0
                  ? 'text-green-600 dark:text-green-400'
                  : versionStats.sizeDiff < 0
                    ? 'text-red-500 dark:text-red-400'
                    : 'text-gray-400 dark:text-gray-500'"
              >
                {{ versionStats.sizeDiff > 0 ? '+' : versionStats.sizeDiff < 0 ? '-' : '' }}{{ formatBytes(Math.abs(versionStats.sizeDiff)) }}
              </span>
            </div>
          </div>

          <div class="flex-1 overflow-y-auto">
            <div
              v-if="displayFiles.length === 0"
              class="flex h-full items-center justify-center text-gray-400 dark:text-gray-500"
            >
              <span class="text-sm">无匹配文件</span>
            </div>
            <button
              v-for="file in displayFiles"
              :key="file.path"
              class="flex w-full items-start gap-3 border-b border-gray-100 px-3 py-2.5 text-left transition-colors last:border-0 hover:bg-gray-100 dark:border-gray-800 dark:hover:bg-gray-800/50"
              :class="selectedFile?.path === file.path ? 'bg-blue-100! dark:bg-blue-900/20!' : ''"
              @click="selectFile(file)"
            >
              <LucideFileVideo class="mt-0.5 h-4 w-4 shrink-0 text-blue-400" />
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-1.5 truncate">
                  <template v-if="file.changeType">
                    <span v-if="file.changeType === 'added'" class="shrink-0 rounded px-1 py-0.5 text-[10px] font-medium leading-none bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400">新增</span>
                    <span v-else-if="file.changeType === 'changed'" class="shrink-0 rounded px-1 py-0.5 text-[10px] font-medium leading-none bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400">变更</span>
                    <span v-else class="shrink-0 rounded px-1 py-0.5 text-[10px] font-medium leading-none bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400">删除</span>
                  </template>

                  <span
                    class="truncate text-sm font-medium"
                    :class="file.changeType === 'added'
                      ? 'text-green-700 dark:text-green-400'
                      : file.changeType === 'changed'
                        ? 'text-blue-700 dark:text-blue-400'
                        : file.changeType === 'deleted' || file.state === 'DELETED'
                          ? 'text-red-600 dark:text-red-400'
                          : 'text-gray-800 dark:text-gray-100'"
                    v-html="highlightText(file.filename, searchQuery)"
                  />
                  <span
                    v-if="!file.changeType && file.state === 'DELETED'"
                    class="shrink-0 rounded px-1 py-0.5 text-[10px] font-medium leading-none bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400"
                  >已删除</span>
                  <span
                    v-if="isFilePlayable(file)"
                    class="shrink-0 rounded px-1 py-0.5 text-[10px] font-medium leading-none bg-green-100 text-green-600 dark:bg-green-900/30 dark:text-green-400"
                  >可播放</span>
                </div>
                <div class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-gray-500 dark:text-gray-400">
                  <span v-if="file.changeType" class="flex items-center">
                    <template v-if="file.changeType === 'changed'">
                      <span
                        v-if="file.versionSize != null && file.previousSize != null"
                        class="font-medium"
                        :class="file.versionSize - file.previousSize > 0
                          ? 'text-green-600 dark:text-green-400'
                          : file.versionSize - file.previousSize < 0
                            ? 'text-red-500 dark:text-red-400'
                            : 'text-gray-400 dark:text-gray-500'"
                      >
                        {{ file.versionSize - file.previousSize > 0 ? '+' : file.versionSize - file.previousSize < 0 ? '-' : '=' }}{{ formatBytes(Math.abs(file.versionSize - file.previousSize)) }}
                      </span>
                    </template>
                    <template v-else-if="file.changeType === 'added'">
                      <span v-if="file.versionSize != null" class="font-medium text-green-600 dark:text-green-400">+{{ formatBytes(file.versionSize) }}</span>
                    </template>
                    <template v-else-if="file.changeType === 'deleted'">
                      <span v-if="file.previousSize != null" class="font-medium text-red-500 dark:text-red-400">-{{ formatBytes(file.previousSize) }}</span>
                    </template>
                  </span>
                  <span v-if="!file.changeType" class="w-17">{{ formatBytes(file.latestSize) }}</span>
                  <span class="ml-auto">加入 <span class="text-green-600 dark:text-green-400">{{ file.addedVersion }}</span></span>
                  <span v-if="file.deletedVersion">删除 <span class="text-red-500 dark:text-red-400">{{ file.deletedVersion }}</span></span>
                  <span v-if="file.currentVersion">最新 <span class="text-blue-500 dark:text-blue-400">{{ file.currentVersion }}</span></span>
                  <span>版本数 {{ file.versionCount }}</span>
                </div>
              </div>
            </button>
          </div>
        </div>

        <div
          class="flex flex-col bg-white dark:bg-gray-900"
          :class="selectedFile
            ? 'fixed inset-0 z-50 md:relative md:inset-auto md:z-auto md:w-96 md:shrink-0'
            : 'hidden md:flex md:w-96 md:shrink-0'"
        >
          <div
            v-if="!selectedFile"
            class="flex h-full items-center justify-center text-gray-300 dark:text-gray-600"
          >
            <div class="flex flex-col items-center gap-2">
              <LucideMousePointer2 class="h-8 w-8" />
              <span class="text-sm">选择左侧文件查看详情</span>
            </div>
          </div>

          <template v-else>
            <div class="border-b border-gray-200 px-4 py-3 dark:border-gray-700">
              <div class="flex items-start gap-2">
                <LucideFileVideo class="mt-0.5 h-5 w-5 shrink-0 text-blue-500" />
                <div class="min-w-0 flex-1">
                  <div class="flex items-center gap-1.5">
                    <p class="truncate text-sm font-semibold text-gray-800 dark:text-gray-100">
                      {{ selectedFile.filename }}
                    </p>
                    <span
                      v-if="selectedFile.state === 'DELETED'"
                      class="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400"
                    >已删除</span>
                  </div>
                  <p class="mt-1 break-all text-[11px] text-gray-400 dark:text-gray-500">
                    {{ selectedFile.path }}
                  </p>
                </div>
                <button
                  class="ml-auto shrink-0 rounded p-0.5 text-gray-400 hover:text-gray-600 focus:outline-none dark:hover:text-gray-200 md:hidden"
                  @click="selectedFile = null"
                >
                  <LucideX class="h-4 w-4" />
                </button>
              </div>
            </div>

            <div class="flex-1 overflow-y-auto px-4 py-3">
              <p class="mb-2 text-xs font-medium text-gray-500 uppercase tracking-wide dark:text-gray-400">
                版本历史（{{ selectedFile.versionCount }} 条）
              </p>
              <div class="space-y-2">
                <div
                  v-for="entry in selectedFileVersions"
                  :key="entry.version"
                  class="rounded-lg border p-3"
                  :class="entry.label === '删除'
                    ? 'border-red-200 bg-red-50 dark:border-red-800/50 dark:bg-red-900/10'
                    : 'border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-800/50'"
                >
                  <div class="flex items-center justify-between">
                    <span class="text-sm font-semibold" :class="entry.label === '删除' ? 'text-red-600 dark:text-red-400' : 'text-blue-600 dark:text-blue-400'">v{{ entry.version }}</span>
                    <span
                      class="rounded px-1.5 py-0.5 text-[10px] font-medium"
                      :class="entry.label === '新增'
                        ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                        : entry.label === '变更'
                          ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400'
                          : 'bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400'"
                    >{{ entry.label }}</span>
                  </div>
                  <template v-if="entry.label !== '删除'">
                    <div class="mt-1.5 space-y-1">
                      <div class="flex items-center justify-between">
                        <span class="text-xs text-gray-500 dark:text-gray-400">大小</span>
                        <span class="text-xs font-medium text-gray-700 dark:text-gray-300">{{ formatBytes(entry.size) }}</span>
                      </div>
                      <div v-if="entry.md5" class="flex items-center justify-between gap-2">
                        <span class="shrink-0 text-xs text-gray-500 dark:text-gray-400">MD5</span>
                        <span class="truncate font-mono text-xs text-gray-500 dark:text-gray-400">{{ entry.md5 }}</span>
                      </div>
                    </div>
                    <div class="mt-2 flex flex-wrap gap-1.5">
                      <span
                        v-if="!entry.directDownloadUrl && !entry.bestChunkVersion && !entry.bestZipSource"
                        class="text-xs text-gray-400 dark:text-gray-500"
                      >
                        无可用资源
                      </span>
                      <template v-else>
                        <template v-if="getEntryKeyHex(selectedFile!.filename)">
                          <button
                            class="inline-flex items-center gap-1 rounded-md bg-green-50 px-2 py-1 text-xs font-medium text-green-600 hover:bg-green-100 dark:bg-green-900/20 dark:text-green-400 dark:hover:bg-green-900/40"
                            @click="onPlay(entry)"
                          >
                            <LucidePlay class="h-3 w-3" />
                            在线播放
                          </button>
                          <button
                            class="inline-flex items-center gap-1 rounded-md bg-orange-50 px-2 py-1 text-xs font-medium text-orange-600 hover:bg-orange-100 dark:bg-orange-900/20 dark:text-orange-400 dark:hover:bg-orange-900/40"
                            @click="onExportMkv(entry)"
                          >
                            <LucideDownload class="h-3 w-3" />
                            导出 MKV
                          </button>
                        </template>
                      </template>
                      <button
                        v-if="entry.directDownloadUrl"
                        class="inline-flex items-center gap-1 rounded-md bg-blue-50 px-2 py-1 text-xs font-medium text-blue-600 hover:bg-blue-100 dark:bg-blue-900/20 dark:text-blue-400 dark:hover:bg-blue-900/40"
                        @click="onDirectDownload(entry.directDownloadUrl, selectedFile!.filename)"
                      >
                        <LucideLink class="h-3 w-3" />
                        直链下载
                      </button>

                      <button
                        v-if="entry.bestChunkVersion"
                        class="inline-flex items-center gap-1 rounded-md bg-purple-50 px-2 py-1 text-xs font-medium text-purple-600 hover:bg-purple-100 disabled:opacity-50 dark:bg-purple-900/20 dark:text-purple-400 dark:hover:bg-purple-900/40"
                        :disabled="chunkLoadingVersion === entry.bestChunkVersion"
                        @click="onChunkDownload(entry.bestChunkVersion, entry.version)"
                      >
                        <LucideBoxes class="h-3 w-3" />
                        {{ chunkLoadingVersion === entry.bestChunkVersion ? '加载中...' : '通过 Chunk 下载' }}
                      </button>
                      <button
                        v-if="entry.bestZipSource"
                        class="inline-flex items-center gap-1 rounded-md bg-cyan-50 px-2 py-1 text-xs font-medium text-cyan-600 hover:bg-cyan-100 dark:bg-cyan-900/20 dark:text-cyan-400 dark:hover:bg-cyan-900/40"
                        :title="entry.bestZipSource.label"
                        @click="onZipDownload(entry.bestZipSource, entry.bestZipVersion, entry.version)"
                      >
                        <LucideArchive class="h-3 w-3" />
                        从 ZIP 中提取
                      </button>
                    </div>
                  </template>
                </div>
              </div>
            </div>
          </template>
        </div>
      </div>
    </template>
  </div>

  <UsmPlayerModal
    v-if="playerState"
    :filename="playerState.filename"
    :key-hex="playerState.keyHex"
    :source-kind="playerState.sourceKind"
    :direct-download-url="playerState.directDownloadUrl"
    :best-chunk-version="playerState.bestChunkVersion"
    :zip-source="playerState.zipSource"
    :zip-version="playerState.zipVersion"
    :game-id="playerState.gameId"
    :file-path="playerState.filePath"
    @close="playerState = null"
  />

  <UsmSourcePickerModal
    v-if="sourcePickerState"
    :filename="selectedFile?.filename ?? ''"
    :file-path="selectedFile?.path ?? ''"
    :mode="sourcePickerState.mode"
    :sources="buildSourceOptions(sourcePickerState.entry)"
    @select="onSourcePick"
    @close="sourcePickerState = null"
  />
</template>
