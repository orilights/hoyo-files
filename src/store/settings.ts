import { defineStore } from 'pinia'

export type Theme = 'device' | 'light' | 'dark'
export type UsmAudioLang = 'zh-cn' | 'en-us' | 'ja-jp' | 'ko-kr'
export type MkvExportLang = 'all' | UsmAudioLang
export type MkvAudioCodec = 'wav' | 'flac'

export const useSettings = defineStore('settings', () => {
  const theme = ref<Theme>('device')
  const usmPlayerVolume = ref(0.5)
  const usmDefaultAudioLang = ref<UsmAudioLang>('zh-cn')
  const mkvExportLang = ref<MkvExportLang>('all')
  const mkvAudioCodec = ref<MkvAudioCodec>('flac')

  const isDark = ref(false)
  const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')

  function updateIsDark() {
    isDark.value = theme.value === 'device' ? mediaQuery.matches : theme.value === 'dark'
  }

  function applyTheme() {
    document.documentElement.classList.toggle('dark', isDark.value)
  }

  function onSystemChange() {
    if (theme.value === 'device') {
      updateIsDark()
      applyTheme()
    }
  }

  function initTheme() {
    updateIsDark()
    applyTheme()
    mediaQuery.addEventListener('change', onSystemChange)
  }

  function setTheme(t: Theme) {
    theme.value = t
    updateIsDark()
    applyTheme()
  }

  function cycleTheme() {
    setTheme(isDark.value ? 'light' : 'dark')
  }

  return { theme, isDark, usmPlayerVolume, usmDefaultAudioLang, mkvExportLang, mkvAudioCodec, initTheme, setTheme, cycleTheme }
}, {
  persist: {
    pick: ['theme', 'usmPlayerVolume', 'usmDefaultAudioLang', 'mkvExportLang', 'mkvAudioCodec'],
  },
})
