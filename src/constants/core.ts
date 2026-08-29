import type { AppPage, GameConfig } from '@/types'
import { Monitor, Moon, Sun } from '@lucide/vue'

export const GameList: GameConfig[] = [
  {
    id: 'hk4e',
    name: '原神',
    pages: ['home', 'files', 'version-compare', 'usm-history'],
    domains: ['autopatchcn.yuanshen.com'],
    audioLangs: ['zh-cn', 'en-us', 'ja-jp', 'ko-kr'],
    features: ['usm-decode'],
  },
  {
    id: 'hkrpg',
    name: '崩坏：星穹铁道',
    pages: ['home', 'files', 'version-compare', 'usm-history'],
    domains: ['autopatchcn.bhsr.com'],
  },
  {
    id: 'nap',
    name: '绝区零',
    pages: ['home', 'files', 'version-compare', 'usm-history'],
    domains: ['autopatchcn.juequling.com'],
    audioLangs: ['zh-cn', 'en-us', 'ja-jp', 'ko-kr'],
  },
  {
    id: 'bh3',
    name: '崩坏3',
    pages: ['home', 'files', 'version-compare'],
    domains: ['autopatchcn.bh3.com'],
  },
]

export const PageList: AppPage[] = [
  { id: 'home', name: '主页', component: () => import('@/views/pages/Home.vue') },
  { id: 'files', name: '文件列表', component: () => import('@/views/pages/Files.vue') },
  { id: 'version-compare', name: '版本对比', component: () => import('@/views/pages/VersionCompare.vue') },
  { id: 'usm-history', name: 'USM文件历史', component: () => import('@/views/pages/UsmHistory.vue') },
  { id: 'stats', name: '数据统计', component: () => import('@/views/pages/Stats.vue') },
]

export const ThemeOptions = [
  { value: 'device' as const, label: '设备', icon: Monitor },
  { value: 'light' as const, label: '亮色', icon: Sun },
  { value: 'dark' as const, label: '暗色', icon: Moon },
]

export const PAGE_COMPONENT_MAP = Object.fromEntries(PageList.map(page => [page.id, page.component]))

export const DEFAULT_GAME_ID = GameList[0].id
export const DEFAULT_PAGE_ID = PageList[0].id

export const AUDIO_LANG_FILES: Record<string, string> = {
  'zh-cn': 'Audio_Chinese_pkg_version',
  'en-us': 'Audio_English(US)_pkg_version',
  'ja-jp': 'Audio_Japanese_pkg_version',
  'ko-kr': 'Audio_Korean_pkg_version',
}

export const AUDIO_LANG_LABELS: Record<string, string> = {
  'zh-cn': '汉语',
  'en-us': '英语',
  'ja-jp': '日语',
  'ko-kr': '韩语',
}

export const CHUNK_ONLY_THRESHOLDS: Record<string, string> = {
  hk4e: '5.6.0',
  bh3: '8.5.0',
  hkrpg: '4.5.0',
}

export const API_BASE = import.meta.env.VITE_API_BASE || '.'
