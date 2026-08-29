/**
 * 压缩包链接可用性检查脚本
 *
 * 读取各游戏 `xx_versions.json`（API_BASE 下），对其中所有压缩包链接
 * （game.full / game.segments / voice / update.game / update.voice）发起 HEAD 请求，
 * 输出一份 Markdown 情况报告。
 *
 * 用法：
 *   node scripts/check-zip-links.mjs [--concurrency 8] [--timeout 15000] [--output report.md]
 *
 * 说明：
 * - 默认并发 8、单请求超时 15s；HEAD 失败（超时/网络错误）自动重试 1 次
 * - 报告输出到 stdout，同时写入 `scripts/zip-links-report.md`
 * - 分卷（segments）按「整组」统计：组内任一链接失败即整组标记为失败
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

const API_BASE = process.env.API_BASE || 'https://autopatch.amarea.cn/pkg_version'
const GAME_IDS = ['hk4e', 'hkrpg', 'nap', 'bh3']
const GAME_NAMES = { hk4e: '原神', hkrpg: '崩坏：星穹铁道', nap: '绝区零', bh3: '崩坏3' }
const LANG_LABELS = { 'zh-cn': '汉语', 'en-us': '英语', 'ja-jp': '日语', 'ko-kr': '韩语' }

const CONCURRENCY = Number(process.argv.find(a => a.startsWith('--concurrency='))?.split('=')[1] ?? 8)
const TIMEOUT_MS = Number(process.argv.find(a => a.startsWith('--timeout='))?.split('=')[1] ?? 15000)
const OUTPUT_ARG = process.argv.find(a => a.startsWith('--output='))?.split('=')[1]
const OUTPUT_PATH = OUTPUT_ARG ? resolve(ROOT, OUTPUT_ARG) : resolve(__dirname, 'zip-links-report.md')

const RETRIES = 1

/* -------------------------------------------------------------------------- */
/* 工具函数                                                                    */
/* -------------------------------------------------------------------------- */

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0)
    return '-'
  if (bytes === 0)
    return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 2)} ${units[i]}`
}

function formatDuration(ms) {
  if (ms < 1000)
    return `${ms.toFixed(0)}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

/** 并发受限的 map：fn 返回 Promise，按输入顺序收集结果 */
async function mapLimit(items, limit, fn) {
  const results = Array.from({ length: items.length })
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await fn(items[index], index)
    }
  })
  await Promise.all(workers)
  return results
}

/** 对单个 URL 发起 HEAD 请求（带超时与重试），返回 { ok, status, size, ms } */
async function headUrl(url, timeoutMs) {
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const start = performance.now()
    try {
      const res = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: controller.signal })
      const ms = performance.now() - start
      const size = Number(res.headers.get('content-length') ?? -1)
      return { ok: res.ok, status: res.status, size: Number.isFinite(size) ? size : -1, ms }
    }
    catch (err) {
      const ms = performance.now() - start
      if (attempt < RETRIES)
        continue
      return { ok: false, status: 0, size: -1, ms, error: err.name === 'AbortError' ? 'timeout' : err.message }
    }
    finally {
      clearTimeout(timer)
    }
  }
}

/* -------------------------------------------------------------------------- */
/* 数据收集                                                                    */
/* -------------------------------------------------------------------------- */

/** 收集一个版本下所有压缩包链接，返回 { version, packages: [{ kind, label, url, size }] } */
function collectPackages(version, vd) {
  const packages = []
  const push = (kind, label, pkg) => {
    if (pkg?.url)
      packages.push({ kind, label, url: pkg.url, size: pkg.size ?? -1 })
  }

  if (vd.game?.full)
    push('game-full', '游戏包', vd.game.full)
  if (vd.game?.segments?.length) {
    vd.game.segments.forEach((seg, i) => push('game-segment', `游戏包分卷 ${i + 1}`, seg))
  }
  for (const [lang, pkg] of Object.entries(vd.voice ?? {}))
    push('voice', `语音包（${LANG_LABELS[lang] ?? lang}）`, pkg)

  for (const [from, entry] of Object.entries(vd.update ?? {})) {
    if (entry?.game)
      push('update-game', `更新包（自 ${from}）`, entry.game)
    for (const [lang, pkg] of Object.entries(entry?.voice ?? {}))
      push('update-voice', `更新语音包（自 ${from}，${LANG_LABELS[lang] ?? lang}）`, pkg)
  }

  return { version, packages }
}

/** 拉取一个游戏的 versions.json 并收集全部压缩包链接 */
async function collectGame(gameId) {
  const url = `${API_BASE}/${gameId}_versions.json`
  const res = await fetch(url)
  if (!res.ok)
    throw new Error(`GET ${url}: HTTP ${res.status}`)
  const data = await res.json()

  const versions = []
  for (const [version, vd] of Object.entries(data))
    versions.push(collectPackages(version, vd))
  return { gameId, versions }
}

/* -------------------------------------------------------------------------- */
/* 报告生成                                                                    */
/* -------------------------------------------------------------------------- */

function buildReport(results) {
  const lines = []
  const now = new Date()
  lines.push(`# 压缩包链接可用性报告`)
  lines.push('')
  lines.push(`- 生成时间：${now.toLocaleString('zh-CN')}`)
  lines.push(`- 数据源：\`${API_BASE}/{gameId}_versions.json\``)
  lines.push(`- 检查方式：HEAD 请求（并发 ${CONCURRENCY}，超时 ${TIMEOUT_MS / 1000}s，失败重试 ${RETRIES} 次）`)
  lines.push('')

  let totalLinks = 0
  let totalOk = 0
  let totalFailed = 0
  let totalVersions = 0
  let totalVersionsWithPackages = 0

  for (const { gameId, versions } of results) {
    const gameName = GAME_NAMES[gameId] ?? gameId
    const versionsWithPackages = versions.filter(v => v.packages.length > 0)
    const gameLinks = versionsWithPackages.reduce((sum, v) => sum + v.packages.length, 0)
    const gameOk = versionsWithPackages.reduce(
      (sum, v) => sum + v.packages.filter(p => p.ok).length,
      0,
    )
    const gameFailed = gameLinks - gameOk
    totalVersions += versions.length
    totalVersionsWithPackages += versionsWithPackages.length
    totalLinks += gameLinks
    totalOk += gameOk
    totalFailed += gameFailed

    lines.push(`## ${gameName}（${gameId}）`)
    lines.push('')
    lines.push(
      `共 ${versions.length} 个版本，其中 ${versionsWithPackages.length} 个版本含压缩包；`
      + `链接 ${gameLinks} 个，可用 ${gameOk} 个，失败 ${gameFailed} 个`
      + `（可用率 ${gameLinks ? ((gameOk / gameLinks) * 100).toFixed(1) : '-'}%）`,
    )
    lines.push('')

    if (versionsWithPackages.length === 0) {
      lines.push('_无压缩包数据_')
      lines.push('')
      continue
    }

    lines.push('| 版本 | 链接数 | 可用 | 失败 | 可用率 | 状态 |')
    lines.push('| --- | ---: | ---: | ---: | ---: | --- |')
    for (const v of versionsWithPackages) {
      const ok = v.packages.filter(p => p.ok).length
      const failed = v.packages.length - ok
      const rate = v.packages.length ? ((ok / v.packages.length) * 100).toFixed(1) : '-'
      const status = failed === 0 ? '✅' : '❌'
      lines.push(`| ${v.version} | ${v.packages.length} | ${ok} | ${failed} | ${rate}% | ${status} |`)
    }
    lines.push('')

    const failedVersions = versionsWithPackages.filter(v => v.packages.some(p => !p.ok))
    if (failedVersions.length > 0) {
      lines.push(`### 失败明细（${gameName}）`)
      lines.push('')
      for (const v of failedVersions) {
        lines.push(`**${v.version}**`)
        lines.push('')
        lines.push('| 类型 | 链接 | 状态码 | 实际大小 | 耗时 |')
        lines.push('| --- | --- | ---: | ---: | ---: |')
        for (const p of v.packages) {
          if (p.ok)
            continue
          const statusText = p.status === 0 ? (p.error ?? 'error') : `HTTP ${p.status}`
          lines.push(`| ${p.label} | \`${p.url}\` | ${statusText} | ${formatBytes(p.size)} | ${formatDuration(p.ms)} |`)
        }
        lines.push('')
      }
    }
  }

  lines.push('---')
  lines.push('')
  lines.push('## 汇总')
  lines.push('')
  lines.push(`| 游戏 | 版本数 | 含包版本数 | 链接数 | 可用 | 失败 | 可用率 |`)
  lines.push(`| --- | ---: | ---: | ---: | ---: | ---: | ---: |`)
  for (const { gameId, versions } of results) {
    const gameName = GAME_NAMES[gameId] ?? gameId
    const versionsWithPackages = versions.filter(v => v.packages.length > 0)
    const gameLinks = versionsWithPackages.reduce((sum, v) => sum + v.packages.length, 0)
    const gameOk = versionsWithPackages.reduce((sum, v) => sum + v.packages.filter(p => p.ok).length, 0)
    lines.push(
      `| ${gameName} | ${versions.length} | ${versionsWithPackages.length} | ${gameLinks} | ${gameOk} | ${gameLinks - gameOk} | `
      + `${gameLinks ? ((gameOk / gameLinks) * 100).toFixed(1) : '-'}% |`,
    )
  }
  lines.push(
    `| **合计** | **${totalVersions}** | **${totalVersionsWithPackages}** | **${totalLinks}** | **${totalOk}** | **${totalFailed}** | `
    + `**${totalLinks ? ((totalOk / totalLinks) * 100).toFixed(1) : '-'}%** |`,
  )
  lines.push('')

  return lines.join('\n')
}

/* -------------------------------------------------------------------------- */
/* 主流程                                                                      */
/* -------------------------------------------------------------------------- */

async function main() {
  console.log(`数据源：${API_BASE}`)
  console.log(`并发 ${CONCURRENCY}，超时 ${TIMEOUT_MS / 1000}s，重试 ${RETRIES} 次`)
  console.log('')

  // 1. 拉取各游戏 versions.json 并收集链接
  const collected = []
  for (const gameId of GAME_IDS) {
    process.stdout.write(`[1/2] 拉取 ${gameId}_versions.json ... `)
    try {
      const game = await collectGame(gameId)
      const count = game.versions.reduce((sum, v) => sum + v.packages.length, 0)
      console.log(`共 ${game.versions.length} 个版本，${count} 个链接`)
      collected.push(game)
    }
    catch (err) {
      console.log(`失败：${err.message}`)
      collected.push({ gameId, versions: [], error: err.message })
    }
  }

  // 2. 并发 HEAD 检查所有链接
  const allPackages = collected.flatMap(game => game.versions.flatMap(v => v.packages))
  console.log(`[2/2] 开始 HEAD 检查 ${allPackages.length} 个链接（并发 ${CONCURRENCY}）...`)

  const start = performance.now()
  const checked = await mapLimit(allPackages, CONCURRENCY, async (pkg) => {
    const result = await headUrl(pkg.url, TIMEOUT_MS)
    return { ...pkg, ...result }
  })
  const elapsed = performance.now() - start

  // 回填检查结果（合并 status/size/ms/error 等字段，覆盖 versions.json 中的原始 size）
  let index = 0
  for (const game of collected) {
    for (const v of game.versions) {
      for (const pkg of v.packages)
        Object.assign(pkg, checked[index++])
    }
  }

  const okCount = checked.filter(p => p.ok).length
  const failCount = checked.length - okCount
  console.log(`检查完成：${okCount} 可用，${failCount} 失败，耗时 ${formatDuration(elapsed)}`)
  console.log('')

  // 3. 生成报告
  const report = buildReport(collected)
  await mkdir(dirname(OUTPUT_PATH), { recursive: true })
  await writeFile(OUTPUT_PATH, report, 'utf8')
  console.log(`报告已写入：${OUTPUT_PATH}`)
  console.log('')
  console.log(report)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
