// 主题管理工具：CSS变量 + Element Plus暗色
// 提供：初始化、切换、设置、状态查询、系统偏好监听与动效

type Theme = 'light' | 'dark'

const STORAGE_KEY = 'hoyo-theme'
const TRANSITION_CLASS = 'theme-transition'
const FADE_CLASS = 'theme-fade'
export const THEME_EVENT = 'theme-changed'

// 读取本地持久化主题偏好
export function getStoredTheme(): Theme | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    return v === 'light' || v === 'dark' ? v : null
  }
  catch {
    return null
  }
}

// 写入本地持久化主题偏好
export function setStoredTheme(theme: Theme) {
  try {
    localStorage.setItem(STORAGE_KEY, theme)
  }
  catch {}
}

// 检测系统暗色偏好
export function systemPrefersDark(): boolean {
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
}

// 应用主题到文档：设置 data-theme 与 Element Plus 的暗色 class
export function applyTheme(theme: Theme) {
  const isDark = theme === 'dark'
  const root = document.documentElement
  root.setAttribute('data-theme', theme)
  root.classList.toggle('dark', isDark)
  // 广播主题变更事件，供组件实时响应图标与UI状态
  try {
    window.dispatchEvent(new CustomEvent(THEME_EVENT, { detail: { theme } }))
  }
  catch {}
}

// 切换主题同时写入持久化，并触发转场动效
export function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme') as Theme | null
  const next: Theme = current === 'dark' ? 'light' : 'dark'
  setStoredTheme(next)
  runThemeTransition(() => applyTheme(next))
}

// 初始化主题：优先本地偏好，否则根据系统偏好
export function initTheme() {
  const stored = getStoredTheme()
  const initial: Theme = stored ?? (systemPrefersDark() ? 'dark' : 'light')
  applyTheme(initial)
  setupSystemListener()
}

// 监听系统主题变化：仅在用户未保存偏好时自动同步
export function setupSystemListener() {
  const media = window.matchMedia('(prefers-color-scheme: dark)')
  const handler = () => {
    const stored = getStoredTheme()
    if (stored) {
      return
    }
    const next: Theme = media.matches ? 'dark' : 'light'
    runThemeTransition(() => applyTheme(next))
  }
  try {
    media.addEventListener('change', handler)
  }
  catch {
    media.addListener(handler)
  }
}

// 执行主题切换转场：全局淡入淡出 + 遮罩扩散
export function runThemeTransition(apply: () => void) {
  const root = document.documentElement
  root.classList.add(FADE_CLASS)
  root.classList.add(TRANSITION_CLASS)
  requestAnimationFrame(() => {
    apply()
    setTimeout(() => {
      root.classList.remove(TRANSITION_CLASS)
      root.classList.remove(FADE_CLASS)
    }, 400)
  })
}
