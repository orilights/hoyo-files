<script setup lang="ts">
import type { MkvAudioCodec, MkvExportLang, UsmAudioLang } from '@/store/settings'
import type { CacheStats, CacheUnavailable } from '@/utils/idb'
import { AUDIO_LANG_LABELS, ThemeOptions } from '@/constants/core'
import { useSettings } from '@/store/settings'
import { formatBytes } from '@/utils/file'
import { clearCache, getCacheStats } from '@/utils/idb'

const settings = useSettings()

const usmAudioLangOptions: { value: UsmAudioLang, label: string }[] = [
  { value: 'zh-cn', label: AUDIO_LANG_LABELS['zh-cn'] },
  { value: 'en-us', label: AUDIO_LANG_LABELS['en-us'] },
  { value: 'ja-jp', label: AUDIO_LANG_LABELS['ja-jp'] },
  { value: 'ko-kr', label: AUDIO_LANG_LABELS['ko-kr'] },
]

const mkvExportLangOptions: { value: MkvExportLang, label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'zh-cn', label: AUDIO_LANG_LABELS['zh-cn'] },
  { value: 'en-us', label: AUDIO_LANG_LABELS['en-us'] },
  { value: 'ja-jp', label: AUDIO_LANG_LABELS['ja-jp'] },
  { value: 'ko-kr', label: AUDIO_LANG_LABELS['ko-kr'] },
]

const mkvAudioCodecOptions: { value: MkvAudioCodec, label: string }[] = [
  { value: 'flac', label: 'FLAC（无损压缩）' },
  { value: 'wav', label: 'WAV（无损 PCM）' },
]

type StatsResult = CacheStats | CacheUnavailable | null

const cacheStats = ref<StatsResult>(null)
const isClearing = ref(false)

async function loadStats() {
  cacheStats.value = await getCacheStats()
}

async function handleClearCache() {
  isClearing.value = true
  try {
    await clearCache()
    await loadStats()
  }
  finally {
    isClearing.value = false
  }
}

onMounted(() => {
  loadStats()
})
</script>

<template>
  <div class="flex min-h-full flex-col items-center justify-center gap-3 py-6">
    <div class="w-full max-w-sm rounded-xl bg-white p-4 shadow-sm dark:bg-gray-800">
      <p class="mb-3 text-xs font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">
        设置
      </p>
      <div class="flex items-center gap-3 justify-between">
        <span class="text-sm text-gray-600 dark:text-gray-300">主题</span>
        <div class="flex items-center gap-1 rounded-lg border border-gray-200 p-0.5 dark:border-gray-600">
          <button
            v-for="opt in ThemeOptions"
            :key="opt.value"
            class="flex items-center gap-1.5 rounded-md px-2.5 py-1 text-sm transition-colors focus:outline-none"
            :class="settings.theme === opt.value
              ? 'bg-gray-100 font-medium text-gray-800 dark:bg-gray-700 dark:text-gray-100'
              : 'text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200'"
            @click="settings.setTheme(opt.value)"
          >
            <component :is="opt.icon" class="h-3.5 w-3.5" />
            {{ opt.label }}
          </button>
        </div>
      </div>
    </div>

    <div class="w-full max-w-sm rounded-xl bg-white p-4 shadow-sm dark:bg-gray-800">
      <p class="mb-3 text-xs font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">
        USM 播放
      </p>
      <div class="flex items-center gap-3 justify-between">
        <span class="text-sm text-gray-600 dark:text-gray-300">默认音频语言</span>
        <DropdownSelect v-model="settings.usmDefaultAudioLang" :options="usmAudioLangOptions" />
      </div>
    </div>

    <div class="w-full max-w-sm rounded-xl bg-white p-4 shadow-sm dark:bg-gray-800">
      <p class="mb-3 text-xs font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">
        MKV 导出
      </p>
      <div class="flex items-center gap-3 justify-between">
        <span class="text-sm text-gray-600 dark:text-gray-300">默认导出语言</span>
        <DropdownSelect v-model="settings.mkvExportLang" :options="mkvExportLangOptions" />
      </div>
      <div class="mt-3 flex items-center gap-3 justify-between">
        <div>
          <div class="text-sm text-gray-600 dark:text-gray-300">
            音频编码
          </div>
          <div class="mt-0.5 text-xs text-gray-400 dark:text-gray-500">
            FLAC 文件更小，编码耗时更长
          </div>
        </div>
        <DropdownSelect v-model="settings.mkvAudioCodec" :options="mkvAudioCodecOptions" />
      </div>
    </div>

    <div class="w-full max-w-sm rounded-xl bg-white p-4 shadow-sm dark:bg-gray-800">
      <p class="mb-3 text-xs font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">
        缓存管理
      </p>
      <p v-if="cacheStats && !cacheStats.available" class="text-sm font-medium text-red-500">
        IndexedDB 不可用
      </p>
      <template v-else-if="cacheStats && cacheStats.available">
        <div class="mb-3 flex items-center justify-between text-sm">
          <span class="text-gray-600 dark:text-gray-300">Manifest 缓存</span>
          <span class="font-medium text-gray-800 dark:text-gray-100">
            {{ formatBytes(cacheStats.totalSize) }}（{{ cacheStats.count }} 条）
          </span>
        </div>
        <button
          class="flex w-full items-center justify-center gap-1.5 rounded-lg border border-red-200 px-3 py-1.5 text-sm text-red-500 transition-colors hover:bg-red-50 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 dark:border-red-800/50 dark:text-red-400 dark:hover:bg-red-900/20"
          :disabled="isClearing || cacheStats.count === 0"
          @click="handleClearCache"
        >
          <LucideLoader2 v-if="isClearing" class="h-3.5 w-3.5 animate-spin" />
          <LucideTrash2 v-else class="h-3.5 w-3.5" />
          {{ isClearing ? '清空中...' : '清空缓存' }}
        </button>
      </template>
      <div v-else class="flex items-center gap-2 text-sm text-gray-400 dark:text-gray-500">
        <LucideLoader2 class="h-4 w-4 animate-spin" />
        <span>加载中...</span>
      </div>
    </div>

    <div class="w-full max-w-sm rounded-xl bg-white p-4 shadow-sm dark:bg-gray-800">
      <p class="mb-3 text-xs font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">
        关于
      </p>
      <div class="space-y-2">
        <a
          href="https://github.com/orilights/hoyo-files"
          target="_blank"
          rel="noopener noreferrer"
          class="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm text-gray-700 transition-colors hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-gray-700"
        >
          <svg class="h-4 w-4 shrink-0 text-gray-500 dark:text-gray-400" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M12 0C5.37 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0 1 12 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z" />
          </svg>
          <span>前端仓库</span>
          <span class="ml-auto text-xs text-gray-400 dark:text-gray-500">orilights/hoyo-files</span>
        </a>
        <a
          href="https://github.com/orilights/pkg_version"
          target="_blank"
          rel="noopener noreferrer"
          class="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm text-gray-700 transition-colors hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-gray-700"
        >
          <svg class="h-4 w-4 shrink-0 text-gray-500 dark:text-gray-400" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M12 0C5.37 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0 1 12 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z" />
          </svg>
          <span>数据仓库</span>
          <span class="ml-auto text-xs text-gray-400 dark:text-gray-500">orilights/pkg_version</span>
        </a>
        <a
          href="https://orilight.top/"
          target="_blank"
          rel="noopener noreferrer"
          class="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm text-gray-700 transition-colors hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-gray-700"
        >
          <LucideUser class="h-4 w-4 shrink-0 text-gray-500 dark:text-gray-400" />
          <span>作者主页</span>
          <span class="ml-auto text-xs text-gray-400 dark:text-gray-500">orilight.top</span>
        </a>
      </div>
    </div>
  </div>
</template>
