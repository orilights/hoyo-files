<script setup lang="ts">
import type { ChunkManifest, FileBrowserSource, GameFileRecord, VersionData } from '@/types'
import { fetchChunkInfo, fetchFileList, useGameVersions } from '@/api/files'
import { AUDIO_LANG_FILES, AUDIO_LANG_LABELS, GameList } from '@/constants/core'
import { useDownload } from '@/store/download'
import { sortVersions } from '@/utils/semver'
import { annotateZipSource, getGameZipSource, getVoiceZipSource } from '@/utils/zip'

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

const diffVersionA = ref<string | null>(null)
const diffVersionB = ref<string | null>(null)
const activeAudioLangs = ref<Set<string>>(new Set())
const loadingAudioLangs = ref<Set<string>>(new Set())

const diffVersionMainFileLists = ref<Record<string, GameFileRecord[]>>({})
const diffAudioFileLists = ref<Record<string, Record<string, GameFileRecord[]>>>({})
const loadingDiffVersions = ref<Set<string>>(new Set())
const diffVersionErrors = ref<Record<string, string | null>>({})
const chunkManifestCache = ref<Record<string, ChunkManifest[]>>({})
const diffVersionLoadTasks = new Map<string, Promise<void>>()
const diffAudioLoadTasks = new Map<string, Promise<void>>()

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

function resetDiffState() {
  diffVersionMainFileLists.value = {}
  diffAudioFileLists.value = {}
  loadingDiffVersions.value = new Set()
  diffVersionErrors.value = {}
  chunkManifestCache.value = {}
  diffVersionLoadTasks.clear()
  diffAudioLoadTasks.clear()
}

watch(gameId, () => {
  diffVersionA.value = null
  diffVersionB.value = null
  activeAudioLangs.value = new Set()
  loadingAudioLangs.value = new Set()
  resetDiffState()
})

function initDiffVersions() {
  const versions = sortedVersionListDesc.value
  if (versions.length < 2)
    return
  diffVersionB.value = versions[0]
  diffVersionA.value = versions[1]
}

watch(latestVersion, (version) => {
  if (version && (!diffVersionA.value || !diffVersionB.value))
    initDiffVersions()
}, { immediate: true })

const supportedAudioLangs = computed(() => {
  const game = GameList.find(g => g.id === gameId.value)
  return game?.audioLangs ?? []
})

const browserAudioOptions = computed(() => {
  return supportedAudioLangs.value.map(lang => ({
    lang,
    label: AUDIO_LANG_LABELS[lang] ?? lang,
    active: activeAudioLangs.value.has(lang),
    loading: loadingAudioLangs.value.has(lang),
  }))
})

function hasDiffMainFileList(version: string) {
  return Object.hasOwn(diffVersionMainFileLists.value, version)
}

function hasDiffAudioFileList(version: string, lang: string) {
  return Object.hasOwn(diffAudioFileLists.value[version] ?? {}, lang)
}

function mergeFiles(
  mainFiles: GameFileRecord[],
  audioLists: Record<string, GameFileRecord[]>,
  version: string,
) {
  const vd = versionsQuery.data.value?.[version] ?? null
  const gameSource = getGameZipSource(vd)
  const merged = annotateZipSource(mainFiles, gameSource)
  for (const lang of activeAudioLangs.value) {
    const list = audioLists[lang]
    if (list)
      merged.push(...annotateZipSource(list, getVoiceZipSource(vd, lang)))
  }
  return merged
}

async function loadDiffVersionFileList(version: string, force: boolean = false) {
  if (!force && hasDiffMainFileList(version))
    return

  const pendingTask = diffVersionLoadTasks.get(version)
  if (pendingTask) {
    await pendingTask
    if (!force || hasDiffMainFileList(version))
      return
  }

  const task = (async () => {
    const nextLoading = new Set(loadingDiffVersions.value)
    nextLoading.add(version)
    loadingDiffVersions.value = nextLoading
    diffVersionErrors.value = { ...diffVersionErrors.value, [version]: null }

    try {
      const fileList = await fetchFileList(gameId.value, version, 'pkg_version')
      diffVersionMainFileLists.value = {
        ...diffVersionMainFileLists.value,
        [version]: fileList,
      }
    }
    catch (e) {
      diffVersionErrors.value = {
        ...diffVersionErrors.value,
        [version]: (e as Error).message,
      }
    }
    finally {
      const loading = new Set(loadingDiffVersions.value)
      loading.delete(version)
      loadingDiffVersions.value = loading
      diffVersionLoadTasks.delete(version)
    }
  })()

  diffVersionLoadTasks.set(version, task)
  await task
}

async function ensureDiffAudioFileList(version: string, lang: string, force: boolean = false) {
  if (!force && hasDiffAudioFileList(version, lang))
    return

  const taskKey = `${version}:${lang}`
  const pendingTask = diffAudioLoadTasks.get(taskKey)
  if (pendingTask) {
    await pendingTask
    if (!force || hasDiffAudioFileList(version, lang))
      return
  }

  const filename = AUDIO_LANG_FILES[lang]
  const task = (async () => {
    const list = await fetchFileList(gameId.value, version, filename)
    diffAudioFileLists.value = {
      ...diffAudioFileLists.value,
      [version]: {
        ...(diffAudioFileLists.value[version] ?? {}),
        [lang]: list,
      },
    }
  })()

  diffAudioLoadTasks.set(taskKey, task)

  try {
    await task
  }
  finally {
    diffAudioLoadTasks.delete(taskKey)
  }
}

async function loadDiffSources(force: boolean = false) {
  const versions = [...new Set([diffVersionA.value, diffVersionB.value].filter(Boolean) as string[])]
  if (versions.length < 2)
    return

  await Promise.all(versions.map(version => loadDiffVersionFileList(version, force)))

  if (!activeAudioLangs.value.size)
    return

  await Promise.all(
    versions.flatMap(version => [...activeAudioLangs.value].map(lang => ensureDiffAudioFileList(version, lang, force))),
  )
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

  const loading = new Set(loadingAudioLangs.value)
  loading.add(lang)
  loadingAudioLangs.value = loading

  try {
    await loadDiffSources()
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

watch([diffVersionA, diffVersionB], ([vA, vB], [oldA, oldB]) => {
  if (vA === oldA && vB === oldB)
    return
  if (vA && vB)
    loadDiffSources()
}, { immediate: true })

async function getChunkManifests(version: string) {
  if (chunkManifestCache.value[version])
    return chunkManifestCache.value[version]
  const chunkInfo = await fetchChunkInfo(gameId.value, version)
  chunkManifestCache.value = {
    ...chunkManifestCache.value,
    [version]: chunkInfo.manifests,
  }
  return chunkInfo.manifests
}

async function onDownloadChunkFile(payload: { file: GameFileRecord, version: string }) {
  const manifests = await getChunkManifests(payload.version)
  download.addChunkFileTask(payload.file, manifests, gameId.value, payload.version)
  download.openList()
}

function onExtractZipFile(payload: { file: GameFileRecord, version: string }) {
  download.addZipFileTask(payload.file, gameId.value, payload.version)
  download.openList()
}

function buildDiffSource(version: string | null): FileBrowserSource | null {
  if (!version)
    return null
  const versionInfo = versionsQuery.data.value?.[version] ?? null
  return {
    version,
    files: mergeFiles(diffVersionMainFileLists.value[version] ?? [], diffAudioFileLists.value[version] ?? {}, version),
    isLoading: loadingDiffVersions.value.has(version),
    error: diffVersionErrors.value[version] ?? null,
    decompressedPath: versionInfo?.decompressed_path ?? null,
    hasChunk: !!versionInfo?.chunk,
    audioOptions: browserAudioOptions.value,
  }
}

const diffSourceA = computed(() => buildDiffSource(diffVersionA.value))
const diffSourceB = computed(() => buildDiffSource(diffVersionB.value))

function swapDiffVersions() {
  const temp = diffVersionA.value
  diffVersionA.value = diffVersionB.value
  diffVersionB.value = temp
}

function onBrowserLoad() {
  loadDiffSources(true)
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
      <span>版本列表加载失败，请重试</span>
    </div>

    <template v-else-if="sortedVersionListDesc.length >= 2">
      <div class="shrink-0 border-b border-gray-200 bg-white px-4 py-3 dark:border-gray-700 dark:bg-gray-900">
        <div class="flex flex-wrap items-center gap-2">
          <span class="shrink-0 text-xs text-gray-500 dark:text-gray-400">基于</span>
          <DropdownSelect
            v-model="diffVersionA"
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

          <span class="shrink-0 text-xs text-gray-500 dark:text-gray-400">对比</span>
          <DropdownSelect
            v-model="diffVersionB"
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

          <button
            class="rounded-md border border-gray-200 bg-gray-50 p-1.5 text-gray-500 transition-colors hover:bg-gray-100 focus:outline-none dark:border-gray-600 dark:bg-gray-700 dark:text-gray-400 dark:hover:bg-gray-600"
            title="互换版本"
            @click="swapDiffVersions"
          >
            <LucideArrowLeftRight class="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <FileBrowser
        v-if="diffSourceA && diffSourceB"
        :source-a="diffSourceA"
        :source-b="diffSourceB"
        @load="onBrowserLoad"
        @toggle-audio="toggleAudioLang"
        @download-chunk-file="onDownloadChunkFile"
        @extract-zip-file="onExtractZipFile"
      />
    </template>

    <div
      v-else
      class="flex h-full items-center justify-center text-gray-400 dark:text-gray-500"
    >
      <LucideFiles class="mr-2 h-5 w-5" />
      <span>至少需要两个版本才能进行文件对比</span>
    </div>
  </div>
</template>
