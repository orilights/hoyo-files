<script setup lang="ts">
import type { GameFileRecord, ZipSource } from '@/types'
import { formatBytes } from '@/utils/file'

interface Props {
  file: GameFileRecord
  title?: string
  downloadUrl?: string | null
  hasChunk?: boolean
  version?: string | null
  zipSource?: ZipSource | null
  boxed?: boolean
}

withDefaults(defineProps<Props>(), {
  title: '',
  downloadUrl: null,
  hasChunk: false,
  version: null,
  zipSource: null,
  boxed: false,
})

const emit = defineEmits<{
  downloadChunkFile: [payload: { file: GameFileRecord, version: string }]
  extractZipFile: [payload: { file: GameFileRecord, version: string }]
}>()

function getFilename(path: string) {
  return path.slice(path.lastIndexOf('/') + 1)
}
</script>

<template>
  <div :class="boxed ? 'space-y-3 rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-800' : 'space-y-3'">
    <div v-if="title" class="flex items-center justify-between gap-2">
      <span class="text-xs font-medium text-gray-500 dark:text-gray-400">{{ title }}</span>
    </div>

    <div>
      <p class="mb-1 text-xs font-medium text-gray-500 dark:text-gray-400">
        大小
      </p>
      <p class="text-sm font-semibold text-gray-800 dark:text-gray-100">
        {{ formatBytes(file.fileSize) }}
      </p>
      <p class="text-xs text-gray-400 dark:text-gray-500">
        {{ file.fileSize.toLocaleString() }} 字节
      </p>
    </div>

    <div>
      <p class="mb-1 text-xs font-medium text-gray-500 dark:text-gray-400">
        MD5
      </p>
      <p class="break-all font-mono text-xs text-gray-700 dark:text-gray-200">
        {{ file.md5 }}
      </p>
    </div>

    <div v-if="file.hash">
      <p class="mb-1 text-xs font-medium text-gray-500 dark:text-gray-400">
        xxHash64
      </p>
      <p class="break-all font-mono text-xs text-gray-700 dark:text-gray-200">
        {{ file.hash }}
      </p>
    </div>

    <div v-if="downloadUrl || (hasChunk && version) || (zipSource && version)" class="flex flex-col gap-2">
      <a
        v-if="downloadUrl"
        :href="downloadUrl"
        target="_blank"
        rel="noopener noreferrer"
        class="flex items-center justify-center gap-1.5 rounded-md bg-green-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-600 focus:outline-none dark:bg-green-600 dark:hover:bg-green-700"
        :download="getFilename(file.remoteName)"
      >
        <LucideDownload class="h-3.5 w-3.5" />
        直链下载
      </a>
      <button
        v-if="hasChunk && version"
        class="flex items-center justify-center gap-1.5 rounded-md bg-purple-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-purple-600 focus:outline-none dark:bg-purple-600 dark:hover:bg-purple-700"
        @click="emit('downloadChunkFile', { file, version })"
      >
        <LucideBoxes class="h-3.5 w-3.5" />
        通过 Chunk 下载
      </button>
      <button
        v-if="zipSource && version"
        class="flex items-center justify-center gap-1.5 rounded-md bg-cyan-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-cyan-600 focus:outline-none dark:bg-cyan-600 dark:hover:bg-cyan-700"
        :title="zipSource.label"
        @click="emit('extractZipFile', { file, version })"
      >
        <LucideArchive class="h-3.5 w-3.5" />
        从 ZIP 中提取
      </button>
    </div>
  </div>
</template>
