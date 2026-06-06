<script setup lang="ts">
import type { ChunkManifest, FileBrowserSource, GameFileRecord, VersionData } from '@/types'
import {
  fetchFileList,
  useChunkInfo,
  useGameVersions,
} from '@/api/files'
import { AUDIO_LANG_FILES, AUDIO_LANG_LABELS, GameList } from '@/constants/core'
import { useDownload } from '@/store/download'
import { formatBytes } from '@/utils/file'
import { compareSemver, sortVersions } from '@/utils/semver'

const route = useRoute()
const gameId = computed(() => route.params.gameId as string)
const download = useDownload()

const versionsQuery = useGameVersions(gameId)

const sortedVersionListDesc = computed<string[]>(() => {
  if (!versionsQuery.data.value)
    return []
  return [...sortVersions(Object.keys(versionsQuery.data.value))].reverse()
})

const latestVersion = computed(() => sortedVersionListDesc.value[0] ?? null)

const selectedVersion = ref<string | null>(null)

const isLoadingFiles = ref(false)
const fileLoadError = ref<string | null>(null)
const mainFileList = ref<GameFileRecord[]>([])
const audioFileLists = ref<Map<string, GameFileRecord[]>>(new Map())
const activeAudioLangs = ref<Set<string>>(new Set())
const loadingAudioLangs = ref<Set<string>>(new Set())

function resetFileState() {
  mainFileList.value = []
  audioFileLists.value = new Map()
  activeAudioLangs.value = new Set()
  loadingAudioLangs.value = new Set()
  isLoadingFiles.value = false
  fileLoadError.value = null
}

watch(latestVersion, (v) => {
  if (v && !selectedVersion.value)
    selectedVersion.value = v
}, { immediate: true })

watch(gameId, () => {
  selectedVersion.value = null
  resetFileState()
})

const versionData = computed<VersionData | null>(() => {
  if (!selectedVersion.value || !versionsQuery.data.value)
    return null
  return versionsQuery.data.value[selectedVersion.value] ?? null
})

interface VersionTag {
  label: string
  color: string
}

function getVersionTags(vd: VersionData, simp: boolean = false): VersionTag[] {
  const tags: VersionTag[] = []
  if (vd.game?.full || vd.game?.segments?.length)
    tags.push({ label: '游戏包', color: 'blue' })
  if (Object.keys(vd.update ?? {}).length > 0)
    tags.push({ label: '更新包', color: 'amber' })
  if (vd.chunk)
    tags.push({ label: simp ? 'Chunk' : '包含Chunk数据', color: 'purple' })
  if (vd.decompressed_path)
    tags.push({ label: simp ? '直链下载' : '支持直链下载文件', color: 'green' })
  return tags
}

const versionTagsMap = computed<Map<string, VersionTag[]>>(() => {
  const map = new Map<string, VersionTag[]>()
  const data = versionsQuery.data.value
  if (!data)
    return map
  for (const [ver, vd] of Object.entries(data))
    map.set(ver, getVersionTags(vd, true))
  return map
})

const currentVersionTags = computed<VersionTag[]>(() => {
  const vd = versionData.value
  if (!vd)
    return []
  return getVersionTags(vd)
})

type TabId = 'packages' | 'files' | 'chunk'

const hasPackages = computed(() => {
  const vd = versionData.value
  if (!vd)
    return false
  return !!(vd.game?.full || vd.game?.segments?.length || Object.keys(vd.update ?? {}).length > 0 || Object.keys(vd.voice ?? {}).length > 0)
})

const hasChunk = computed(() => !!versionData.value?.chunk)

const availableTabs = computed<{ id: TabId, label: string }[]>(() => {
  const tabs: { id: TabId, label: string }[] = []
  if (hasPackages.value)
    tabs.push({ id: 'packages', label: '压缩包' })
  tabs.push({ id: 'files', label: '文件列表' })
  if (hasChunk.value)
    tabs.push({ id: 'chunk', label: 'Chunk 信息' })
  return tabs
})

const activeTab = ref<TabId>('packages')

watch(availableTabs, (tabs) => {
  if (tabs.length && !tabs.some(t => t.id === activeTab.value))
    activeTab.value = tabs[0].id
}, { immediate: true })

watch(selectedVersion, () => {
  resetFileState()
  const tabs = availableTabs.value
  if (tabs.length && !tabs.some(t => t.id === activeTab.value))
    activeTab.value = tabs[0].id
  if (activeTab.value === 'files')
    loadMainFileList()
}, { immediate: true })

interface PackageEntry {
  name: string
  url: string
  size: number
  md5: string
  label: string
  sublabel?: string
}

const packageEntries = computed<PackageEntry[]>(() => {
  const vd = versionData.value
  if (!vd)
    return []
  const entries: PackageEntry[] = []

  if (vd.game?.full) {
    const f = vd.game.full
    entries.push({ name: f.name, url: f.url, size: f.size, md5: f.checksum, label: '游戏包' })
  }
  if (vd.game?.segments?.length) {
    const total = vd.game.segments.length
    vd.game.segments.forEach((seg, i) => {
      entries.push({ name: seg.name, url: seg.url, size: seg.size, md5: seg.checksum, label: '游戏包分卷', sublabel: `${i + 1}/${total}` })
    })
  }

  for (const [lang, pkg] of Object.entries(vd.voice ?? {})) {
    if (pkg) {
      entries.push({
        name: pkg.name,
        url: pkg.url,
        size: pkg.size,
        md5: pkg.checksum,
        label: '语音包',
        sublabel: AUDIO_LANG_LABELS[lang] ?? lang,
      })
    }
  }

  const updateVersions = sortVersions(Object.keys(vd.update ?? {})).reverse()
  for (const fromVer of updateVersions) {
    const upd = vd.update[fromVer]
    if (upd?.game) {
      entries.push({
        name: upd.game.name,
        url: upd.game.url,
        size: upd.game.size,
        md5: upd.game.checksum,
        label: '游戏包更新',
        sublabel: `${fromVer} -> ${selectedVersion.value}`,
      })
    }
    for (const [lang, pkg] of Object.entries(upd?.voice ?? {})) {
      if (pkg) {
        entries.push({
          name: pkg.name,
          url: pkg.url,
          size: pkg.size,
          md5: pkg.checksum,
          label: '语音包更新',
          sublabel: `${AUDIO_LANG_LABELS[lang] ?? lang} ${fromVer} -> ${selectedVersion.value}`,
        })
      }
    }
  }

  return entries
})

const copyState = ref<Record<string, boolean>>({})

async function copyUrl(url: string, key: string) {
  await navigator.clipboard.writeText(url)
  copyState.value[key] = true
  setTimeout(() => {
    copyState.value[key] = false
  }, 2000)
}

async function copyMd5(md5: string, key: string) {
  await navigator.clipboard.writeText(md5)
  copyState.value[key] = true
  setTimeout(() => {
    copyState.value[key] = false
  }, 2000)
}

const supportedAudioLangs = computed(() => {
  const game = GameList.find(g => g.id === gameId.value)
  return game?.audioLangs ?? []
})

function mergeFiles(mainFiles: GameFileRecord[], audioLists: Map<string, GameFileRecord[]>) {
  const merged = [...mainFiles]
  for (const lang of activeAudioLangs.value) {
    const list = audioLists.get(lang)
    if (list)
      merged.push(...list)
  }
  return merged
}

const browserAudioOptions = computed(() => {
  return supportedAudioLangs.value.map(lang => ({
    lang,
    label: AUDIO_LANG_LABELS[lang] ?? lang,
    active: activeAudioLangs.value.has(lang),
    loading: loadingAudioLangs.value.has(lang),
  }))
})

async function loadMainFileList(force: boolean = false) {
  if (!selectedVersion.value || isLoadingFiles.value)
    return
  if (!force && mainFileList.value.length > 0)
    return
  isLoadingFiles.value = true
  fileLoadError.value = null
  try {
    mainFileList.value = await fetchFileList(gameId.value, selectedVersion.value, 'pkg_version')
  }
  catch (e) {
    fileLoadError.value = (e as Error).message
  }
  finally {
    isLoadingFiles.value = false
  }
}

async function toggleAudioLang(lang: string) {
  const active = new Set(activeAudioLangs.value)
  if (active.has(lang)) {
    active.delete(lang)
    activeAudioLangs.value = active
    return
  }

  active.add(lang)
  activeAudioLangs.value = active

  if (audioFileLists.value.has(lang))
    return

  const loading = new Set(loadingAudioLangs.value)
  loading.add(lang)
  loadingAudioLangs.value = loading

  try {
    const filename = AUDIO_LANG_FILES[lang]
    const list = await fetchFileList(gameId.value, selectedVersion.value!, filename)
    const newMap = new Map(audioFileLists.value)
    newMap.set(lang, list)
    audioFileLists.value = newMap
  }
  catch {
    const next = new Set(activeAudioLangs.value)
    next.delete(lang)
    activeAudioLangs.value = next
  }
  finally {
    const nextLoading = new Set(loadingAudioLangs.value)
    nextLoading.delete(lang)
    loadingAudioLangs.value = nextLoading
  }
}

watch(activeTab, (tab) => {
  if (tab === 'files' && mainFileList.value.length === 0 && !isLoadingFiles.value)
    loadMainFileList()
}, { immediate: true })

const chunkVersion = computed(() => {
  if (!selectedVersion.value || !hasChunk.value)
    return null
  return selectedVersion.value
})

const chunkQuery = useChunkInfo(gameId, chunkVersion)

const chunkTotalStats = computed(() => {
  const manifests = chunkQuery.data.value?.manifests
  if (!manifests?.length)
    return null
  return manifests.reduce(
    (acc, m) => ({
      file_count: acc.file_count + Number(m.stats.file_count),
      chunk_count: acc.chunk_count + Number(m.stats.chunk_count),
      compressed_size: acc.compressed_size + Number(m.stats.compressed_size),
      uncompressed_size: acc.uncompressed_size + Number(m.stats.uncompressed_size),
      manifest_count: acc.manifest_count + 1,
    }),
    { file_count: 0, chunk_count: 0, compressed_size: 0, uncompressed_size: 0, manifest_count: 0 },
  )
})

const CHUNK_ONLY_THRESHOLDS: Record<string, string> = {
  hk4e: '5.6.0',
  bh3: '8.5.0',
}

const gameName = computed(() => {
  const game = GameList.find(g => g.id === gameId.value)
  return game?.name ?? '该游戏'
})

const chunkOnlyBanner = computed(() => {
  const threshold = CHUNK_ONLY_THRESHOLDS[gameId.value]
  if (!threshold || !selectedVersion.value)
    return null
  if (compareSemver(selectedVersion.value, threshold) >= 0)
    return threshold
  return null
})

function onDownloadManifestJson(manifest: ChunkManifest) {
  if (!selectedVersion.value)
    return
  download.addManifestJsonTask(manifest, gameId.value, selectedVersion.value)
  download.openList()
}

function onDownloadChunkFile(payload: { file: GameFileRecord, version: string }) {
  if (!selectedVersion.value || payload.version !== selectedVersion.value || !chunkQuery.data.value?.manifests)
    return
  download.addChunkFileTask(payload.file, chunkQuery.data.value.manifests, gameId.value, selectedVersion.value)
  download.openList()
}

const currentFileSource = computed<FileBrowserSource>(() => ({
  version: selectedVersion.value ?? '',
  files: mergeFiles(mainFileList.value, audioFileLists.value),
  isLoading: isLoadingFiles.value,
  error: fileLoadError.value,
  decompressedPath: versionData.value?.decompressed_path ?? null,
  hasChunk: hasChunk.value,
  audioOptions: browserAudioOptions.value,
}))

function onBrowserLoad() {
  loadMainFileList(true)
}
</script>

<template>
  <div class="flex h-full flex-col overflow-hidden">
    <div
      v-if="versionsQuery.isPending.value"
      class="flex h-full items-center justify-center text-gray-400 dark:text-gray-500"
    >
      <LucideLoader2 class="mr-2 h-5 w-5 animate-spin" />
      <span>加载版本列表...</span>
    </div>

    <div
      v-else-if="versionsQuery.isError.value"
      class="flex h-full items-center justify-center text-red-500"
    >
      <LucideAlertCircle class="mr-2 h-5 w-5" />
      <span>加载失败</span>
    </div>

    <template v-else>
      <div class="shrink-0 border-b border-gray-200 bg-white px-4 py-3 dark:border-gray-700 dark:bg-gray-900">
        <div class="flex items-center gap-2">
          <span class="text-xs text-gray-500 dark:text-gray-400">版本选择</span>
          <DropdownSelect
            v-model="selectedVersion"
            :options="sortedVersionListDesc.map(ver => ({ value: ver, label: ver }))"
            placeholder="选择版本"
          >
            <template #trigger="{ label }">
              <span class="font-mono">{{ label }}</span>
            </template>
            <template #option="{ option }">
              <span class="mr-2 font-medium font-mono">{{ option.label }}</span>
              <TagBadge
                v-for="tag in versionTagsMap.get(option.value!)"
                :key="tag.label"
                :label="tag.label"
                :color="tag.color"
              />
            </template>
          </DropdownSelect>
        </div>
        <div v-if="currentVersionTags.length" class="mt-2 flex flex-wrap gap-1.5">
          <TagBadge
            v-for="tag in currentVersionTags"
            :key="tag.label"
            :label="tag.label"
            :color="tag.color"
          />
        </div>
      </div>

      <div
        v-if="chunkOnlyBanner"
        class="flex shrink-0 items-center gap-2 border-b border-amber-300 bg-amber-50 px-4 py-2.5 dark:border-amber-700/60 dark:bg-amber-900/25"
      >
        <LucideTriangleAlert class="h-4 w-4 shrink-0 text-amber-500 dark:text-amber-400" />
        <p class="text-xs font-medium text-amber-800 dark:text-amber-300">
          {{ gameName }}已从 {{ chunkOnlyBanner }} 版本起停止使用压缩包分发游戏资源，后续版本仅可通过 Chunk 获取游戏文件。
        </p>
      </div>

      <div class="flex shrink-0 items-center gap-1 border-b border-gray-200 bg-gray-50 px-3 py-1.5 dark:border-gray-700 dark:bg-gray-800/50">
        <button
          v-for="tab in availableTabs"
          :key="tab.id"
          class="rounded-md px-3 py-1 text-sm font-medium transition-colors focus:outline-none"
          :class="activeTab === tab.id
            ? 'bg-white text-blue-600 shadow-sm dark:bg-gray-700 dark:text-blue-400'
            : 'text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200'"
          @click="activeTab = tab.id"
        >
          {{ tab.label }}
        </button>
      </div>

      <div
        v-if="activeTab === 'packages'"
        class="min-h-0 flex-1 overflow-y-auto p-4"
      >
        <div v-if="packageEntries.length === 0" class="flex h-full items-center justify-center text-gray-400 dark:text-gray-500">
          <LucidePackageOpen class="mr-2 h-5 w-5" />
          <span>该版本无包数据</span>
        </div>
        <div v-else class="space-y-2">
          <div
            v-for="(entry, i) in packageEntries"
            :key="i"
            class="flex flex-col gap-2 rounded-lg border border-gray-200 bg-white px-4 py-3 lg:flex-row lg:items-center lg:gap-3 dark:border-gray-700 dark:bg-gray-800"
          >
            <div class="flex min-w-0 flex-1 items-center gap-3">
              <LucidePackage class="h-5 w-5 shrink-0 text-blue-400" />
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-2">
                  <span class="rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-700 dark:bg-blue-900/30 dark:text-blue-300">{{ entry.label }}</span>
                  <span v-if="entry.sublabel" class="text-xs text-gray-400 dark:text-gray-500">{{ entry.sublabel }}</span>
                  <span>{{ entry.name }}</span>
                </div>
                <div class="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5">
                  <span class="flex items-center gap-1 text-xs text-gray-400 dark:text-gray-500">
                    <LucideHardDrive class="h-3 w-3 shrink-0" />
                    {{ formatBytes(entry.size) }}
                  </span>
                  <button
                    v-if="entry.md5"
                    class="flex items-center gap-1 text-xs text-gray-400 transition-colors hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300"
                    :title="entry.md5"
                    @click="copyMd5(entry.md5, `md5-${i}`)"
                  >
                    <LucideCheck v-if="copyState[`md5-${i}`]" class="h-3 w-3 shrink-0 text-green-500" />
                    <LucideHash v-else class="h-3 w-3 shrink-0" />
                    <span class="max-w-56 truncate font-mono">{{ entry.md5 }}</span>
                  </button>
                </div>
              </div>
            </div>
            <div class="flex shrink-0 items-center gap-2">
              <button
                class="flex items-center gap-1 rounded-md border border-gray-200 bg-gray-50 px-2.5 py-1.5 text-xs text-gray-600 transition-colors hover:bg-gray-100 focus:outline-none dark:border-gray-600 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
                title="复制链接"
                @click="copyUrl(entry.url, `${i}`)"
              >
                <LucideCheck v-if="copyState[`${i}`]" class="h-3.5 w-3.5 text-green-500" />
                <LucideCopy v-else class="h-3.5 w-3.5" />
                {{ copyState[`${i}`] ? '已复制' : '复制链接' }}
              </button>
              <a
                :href="entry.url"
                target="_blank"
                rel="noopener noreferrer"
                class="flex items-center gap-1 rounded-md border border-gray-200 bg-gray-50 px-2.5 py-1.5 text-xs text-gray-600 transition-colors hover:bg-gray-100 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
                :download="entry.name"
                title="下载"
              >
                <LucideDownload class="h-3.5 w-3.5" />
                下载
              </a>
            </div>
          </div>
        </div>
      </div>

      <FileBrowser
        v-else-if="activeTab === 'files'"
        :source-a="currentFileSource"
        @load="onBrowserLoad"
        @toggle-audio="toggleAudioLang"
        @download-chunk-file="onDownloadChunkFile"
      />

      <div
        v-else-if="activeTab === 'chunk'"
        class="min-h-0 flex-1 overflow-y-auto p-4"
      >
        <div
          v-if="chunkQuery.isPending.value"
          class="flex h-full items-center justify-center text-gray-400 dark:text-gray-500"
        >
          <LucideLoader2 class="mr-2 h-5 w-5 animate-spin" />
          <span>加载 Chunk 信息...</span>
        </div>
        <div
          v-else-if="chunkQuery.isError.value"
          class="flex h-full items-center justify-center text-red-500"
        >
          <LucideAlertCircle class="mr-2 h-5 w-5" />
          <span>Chunk 信息加载失败</span>
        </div>
        <template v-else-if="chunkQuery.data.value">
          <div class="mb-4 flex items-center gap-3">
            <span class="text-sm font-semibold text-gray-700 dark:text-gray-200">Build Id :</span>
            <span class="font-mono text-sm text-gray-500 dark:text-gray-400">{{ chunkQuery.data.value.build_id }}</span>
          </div>
          <div v-if="chunkTotalStats" class="mb-4 grid grid-cols-2 gap-2 rounded-lg border border-blue-200 bg-blue-50 p-3 text-xs dark:border-blue-800/50 dark:bg-blue-900/20 sm:grid-cols-5">
            <div>
              <p class="text-blue-500 dark:text-blue-400">
                总 Manifest 数
              </p>
              <p class="text-sm font-bold text-blue-700 dark:text-blue-300">
                {{ chunkTotalStats.manifest_count.toLocaleString() }}
              </p>
            </div>
            <div>
              <p class="text-blue-500 dark:text-blue-400">
                总文件数
              </p>
              <p class="text-sm font-bold text-blue-700 dark:text-blue-300">
                {{ chunkTotalStats.file_count.toLocaleString() }}
              </p>
            </div>
            <div>
              <p class="text-blue-500 dark:text-blue-400">
                总文件块数
              </p>
              <p class="text-sm font-bold text-blue-700 dark:text-blue-300">
                {{ chunkTotalStats.chunk_count.toLocaleString() }}
              </p>
            </div>
            <div>
              <p class="text-blue-500 dark:text-blue-400">
                总压缩大小
              </p>
              <p class="text-sm font-bold text-blue-700 dark:text-blue-300">
                {{ formatBytes(chunkTotalStats.compressed_size) }}
              </p>
            </div>
            <div>
              <p class="text-blue-500 dark:text-blue-400">
                总解压大小
              </p>
              <p class="text-sm font-bold text-blue-700 dark:text-blue-300">
                {{ formatBytes(chunkTotalStats.uncompressed_size) }}
              </p>
            </div>
          </div>
          <div class="space-y-3">
            <div
              v-for="manifest in chunkQuery.data.value.manifests"
              :key="manifest.category_id"
              class="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800"
            >
              <div class="mb-3">
                <span class="text-sm font-semibold text-gray-800 dark:text-gray-100">{{ manifest.category_name }}</span>
                <span class="ml-2 text-xs text-gray-400 dark:text-gray-500">id : {{ manifest.category_id }}</span>
              </div>
              <div class="mb-2 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
                <div class="rounded-md bg-gray-50 p-2 dark:bg-gray-700/50">
                  <p class="text-gray-500 dark:text-gray-400">
                    文件数
                  </p>
                  <p class="font-semibold text-gray-800 dark:text-gray-100">
                    {{ Number(manifest.stats.file_count).toLocaleString() }}
                  </p>
                </div>
                <div class="rounded-md bg-gray-50 p-2 dark:bg-gray-700/50">
                  <p class="text-gray-500 dark:text-gray-400">
                    文件块数
                  </p>
                  <p class="font-semibold text-gray-800 dark:text-gray-100">
                    {{ Number(manifest.stats.chunk_count).toLocaleString() }}
                  </p>
                </div>
                <div class="rounded-md bg-gray-50 p-2 dark:bg-gray-700/50">
                  <p class="text-gray-500 dark:text-gray-400">
                    压缩大小
                  </p>
                  <p class="font-semibold text-gray-800 dark:text-gray-100">
                    {{ formatBytes(Number(manifest.stats.compressed_size)) }}
                  </p>
                </div>
                <div class="rounded-md bg-gray-50 p-2 dark:bg-gray-700/50">
                  <p class="text-gray-500 dark:text-gray-400">
                    解压大小
                  </p>
                  <p class="font-semibold text-gray-800 dark:text-gray-100">
                    {{ formatBytes(Number(manifest.stats.uncompressed_size)) }}
                  </p>
                </div>
              </div>
              <div class="text-xs text-gray-400 dark:text-gray-500">
                <div>
                  <span class="mr-2">manifest id :</span>
                  <span class="break-all font-mono">{{ manifest.manifest.id }}</span>
                </div>
                <div>
                  <span class="mr-2">matching field :</span>
                  <span class="break-all font-mono">{{ manifest.matching_field }}</span>
                </div>
              </div>
              <div class="mt-3 flex items-center gap-2">
                <a
                  :href="`${manifest.manifest_download.url_prefix}/${manifest.manifest.id}`"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="flex items-center gap-1 rounded-md border border-gray-200 bg-gray-50 px-2.5 py-1.5 text-xs text-gray-600 transition-colors hover:bg-gray-100 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
                  :download="manifest.manifest.id"
                >
                  <LucideDownload class="h-3.5 w-3.5" />
                  下载 Manifest
                </a>
                <button
                  class="flex items-center gap-1 rounded-md border border-gray-200 bg-gray-50 px-2.5 py-1.5 text-xs text-gray-600 transition-colors hover:bg-gray-100 focus:outline-none dark:border-gray-600 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
                  @click="onDownloadManifestJson(manifest)"
                >
                  <LucideFileJson class="h-3.5 w-3.5" />
                  导出为 JSON
                </button>
              </div>
            </div>
          </div>
        </template>
      </div>
    </template>
  </div>
</template>

<style scoped>
.dropdown-enter-active,
.dropdown-leave-active {
  transition: opacity 0.1s ease, transform 0.1s ease;
}

.dropdown-enter-from,
.dropdown-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
</style>
