<script setup lang="ts">
// 主题切换按钮：与左栏图标风格一致（48px方形卡片）并拥有切换动效
// - 动效：icon 在切换时旋转并轻微缩放（300ms），与全局主题过渡配合
// - 可访问性：aria-pressed 与 aria-label
import { THEME_EVENT, toggleTheme } from '@/utils/theme'

// 当前主题是否为暗色
// 使用可变的 ref，并通过主题事件保持同步，避免刷新后才更新图标
const isDark = ref(document.documentElement.getAttribute('data-theme') === 'dark')

// 切换时触发图标动效
const isAnimating = ref(false)

function onToggle() {
  isAnimating.value = true
  toggleTheme()
  setTimeout(() => {
    isAnimating.value = false
  }, 320)
}

onMounted(() => {
  const handler = (e: Event) => {
    const detail = (e as CustomEvent).detail as { theme: 'light' | 'dark' }
    if (detail && detail.theme)
      isDark.value = detail.theme === 'dark'
  }
  window.addEventListener(THEME_EVENT, handler)
  onBeforeUnmount(() => window.removeEventListener(THEME_EVENT, handler))
})
</script>

<template>
  <!-- 与左侧游戏/Github图标一致的外观：圆角+边框+悬浮态；暗色时高亮边框 -->
  <div
    class="overflow-hidden rounded-xl border-2 border-transparent transition-all duration-300 hover:border-gray-300"
    :class="{ '!border-blue-500': isDark }"
    title="主题切换"
    :aria-pressed="isDark ? 'true' : 'false'"
    aria-label="主题切换"
    @click="onToggle"
  >
    <div class="size-[48px] flex items-center justify-center" :style="{ color: 'var(--color-text)' }">
      <!-- 图标颜色跟随主题，通过 currentColor 实现；切换时旋转缩放动效 -->
      <ThemeIcon
        :name="isDark ? 'moon' : 'sun'"
        :size="28"
        class="transition-transform ease-out duration-300"
        :class="{ 'rotate-180 scale-90': isAnimating }"
      />
    </div>
  </div>
</template>
