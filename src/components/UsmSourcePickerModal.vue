<script setup lang="ts">
import type { UsmSourceOption } from '@/types'

interface Props {
  filename: string
  filePath: string
  mode: 'play' | 'export'
  sources: UsmSourceOption[]
}

const props = defineProps<Props>()
const emit = defineEmits<{ select: [option: UsmSourceOption], close: [] }>()

const modeTitle = computed(() => (props.mode === 'play' ? '在线播放' : '导出 MKV'))
const modeHint = computed(() => (props.mode === 'play' ? '选择数据源开始播放' : '选择数据源开始导出'))

function onSelect(option: UsmSourceOption) {
  emit('select', option)
  emit('close')
}
</script>

<template>
  <Teleport to="body">
    <div class="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div class="absolute inset-0 bg-black/50" @click="emit('close')" />
      <div class="relative w-full max-w-md rounded-2xl border border-gray-200 bg-white shadow-2xl dark:border-gray-700 dark:bg-gray-900">
        <div class="flex items-center gap-2 border-b border-gray-200 px-5 py-4 dark:border-gray-700">
          <LucidePlay v-if="mode === 'play'" class="h-5 w-5 text-green-500" />
          <LucideDownload v-else class="h-5 w-5 text-orange-500" />
          <div class="min-w-0 flex-1">
            <p class="font-semibold text-gray-800 dark:text-gray-100">
              {{ modeTitle }}
            </p>
            <p class="mt-0.5 truncate text-xs text-gray-400 dark:text-gray-500">
              {{ filename }}
            </p>
          </div>
          <button
            class="rounded-md p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700 dark:hover:text-gray-200"
            @click="emit('close')"
          >
            <LucideX class="h-4 w-4" />
          </button>
        </div>

        <div class="space-y-2.5 px-5 py-4">
          <p class="text-xs text-gray-400 dark:text-gray-500">
            {{ modeHint }}
          </p>

          <button
            v-for="source in sources"
            :key="source.kind"
            class="flex w-full items-center gap-3 rounded-xl border border-gray-200 bg-gray-50 p-3 text-left transition-colors hover:border-blue-300 hover:bg-blue-50 dark:border-gray-700 dark:bg-gray-800/50 dark:hover:border-blue-700 dark:hover:bg-blue-900/20"
            @click="onSelect(source)"
          >
            <span class="mt-0.5 shrink-0">
              <LucideLink v-if="source.kind === 'direct'" class="h-5 w-5 text-blue-500" />
              <LucideBoxes v-else-if="source.kind === 'chunk'" class="h-5 w-5 text-purple-500" />
              <LucideArchive v-else class="h-5 w-5 text-cyan-500" />
            </span>
            <span class="flex-1 flex items-center gap-2">
              <span class="text-sm font-semibold text-gray-800 dark:text-gray-100">{{ source.label }}</span>
              <span v-if="source.version" class="rounded bg-gray-200 px-1.5 py-0.5 text-[10px] font-medium text-gray-600 dark:bg-gray-700 dark:text-gray-300">
                {{ source.version }}
              </span>
            </span>
            <LucideChevronRight class="mt-1 h-4 w-4 shrink-0 text-gray-300 dark:text-gray-600" />
          </button>

          <p v-if="sources.length === 0" class="py-4 text-center text-sm text-gray-400 dark:text-gray-500">
            无可用数据源
          </p>
        </div>

        <div class="flex justify-end border-t border-gray-200 px-5 py-3 dark:border-gray-700">
          <button
            class="rounded-lg px-4 py-1.5 text-sm text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200"
            @click="emit('close')"
          >
            取消
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
