const DEV_PROXY_HOSTS = new Set([
  'autopatchcn.yuanshen.com',
  'autopatchcn.bhsr.com',
  'autopatchcn.juequling.com',
  'autopatchcn.bh3.com',
])

/** 开发环境将游戏 CDN 请求改写到 Vite 同源代理，生产环境保持原始 URL。 */
export function toRequestUrl(url: string): string {
  if (!import.meta.env.DEV || !/^https?:\/\//i.test(url))
    return url

  const parsed = new URL(url)
  if (!DEV_PROXY_HOSTS.has(parsed.hostname))
    return url

  return `/__dev_proxy/${parsed.hostname}${parsed.pathname}${parsed.search}${parsed.hash}`
}
