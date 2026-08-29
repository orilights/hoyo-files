# Hoyo Files 项目指引

米哈游游戏资源包与文件列表查看工具（Vue 3 + TypeScript + Vite + Tailwind CSS 4 + Pinia + TanStack Vue Query）。支持原神 / 星穹铁道 / 绝区零 / 崩坏3 的文件浏览、Chunk 下载、版本对比、USM 视频在线播放与导出。

## 常用命令

- `pnpm dev` — 启动开发服务器
- `pnpm build` — 类型检查（`vue-tsc -b`）+ 构建；类型错误会阻断构建
- `pnpm lint` / `pnpm lintf` — ESLint 检查 / 自动修复
- 包管理器为 pnpm（v10）；项目无测试脚本

## 架构

- `src/constants/core.ts` — 单一事实来源：`GameList`（游戏配置）、`PageList`（页面注册表）、`PAGE_COMPONENT_MAP`、`API_BASE`
- `src/router/routes.ts` — 仅 4 条路由；页面组件不直接注册，由 `Game.vue` 通过 `PAGE_COMPONENT_MAP` 动态渲染，并校验 `game.pages.includes(pageId)`
- `src/store/` — Pinia setup 语法；`settings.ts` 用 `pinia-plugin-persistedstate` 持久化（仅 pick 4 项，`isDark` 是派生值不持久化）；`download.ts` 不持久化，任务上下文放模块级 `Map`（避免响应式开销）
- `src/api/` — TanStack Vue Query；查询函数以 `use` 开头，queryKey 用 `computed(() => [...])` 响应式形式
- `src/utils/` — `manifest.ts`（protobuf + ZSTD 解析）、`idb.ts`（IndexedDB 缓存）、`chunk.ts`（chunk 下载）、`usm.ts`（WASM 解码器）、`semver.ts`、`file.ts`

## 约定

- **组件/图标自动导入**：模板中直接用 `<FileBrowser>`、`<LucideX>`，禁止手动 import 组件与 Lucide 图标；脚本中需要图标时才手动 `import { X } from '@lucide/vue'`
- **Vue 组合式 API 自动导入**：`ref`/`computed`/`watch`/`useRoute` 等全局可用，无需 import
- **路径别名**：`@` → `src`，所有内部导入一律用 `@/...`，不用相对路径
- **类型组织**：共享类型集中在 `src/types/index.ts`；组件内部专用类型就地定义在组件内
- **代码风格**：无分号、单引号、2 空格缩进、多行尾逗号（`@antfu/eslint-config`）；类型导入用 `import type`；`erasableSyntaxOnly` 禁止 enum/namespace 等非可擦除语法
- **UI**：Tailwind 类，深色模式用 `dark:` 前缀；中文文案直接写在模板中

## 陷阱（易错点）

1. **vue-query 结果带 `.value`**：模板与脚本中均为 `query.data.value`、`query.isPending.value`
2. **缓存 key 格式**：`${gameId}_${version}_${manifest.id}`，新增调用点必须沿用，否则缓存失效
3. **MediaSource 回压**：`UsmPlayerModal.vue` 中必须 `await sbQueue.waitForCapacity(signal)`，否则 `QuotaExceededError`
4. **`API_BASE` 已含 `/pkg_version` 路径段**（`core.ts` 中定义，`.env` 配置），拼接 URL 不要重复该段
5. **新增页面要改两处**：`PageList`（core.ts）+ 对应游戏的 `GameConfig.pages`，否则路由无法访问
6. **`fetchFileList` 返回逐行 JSON 文本**（非 JSON 数组），需 `split('\n')` 后逐行 parse
7. **`fetchChunkInfo` 解包 `{retcode, data}`**，返回 `json.data`
8. **WASM 初始化幂等**：用 `initWasm()` 单例 promise，不要重复初始化
9. **IDB 缓存静默失败**：所有操作 try/catch，缓存不可用时降级为直接 fetch，不要抛错
10. **`downloadChunks` 并发 4 但按序消费**：必须按 index 顺序回调 `onChunk`，乱序会破坏流式解码
11. **自动生成文件勿手改**：`src/auto-imports.d.ts`、`src/components.d.ts`
12. **`src/assets/usm/**` 被 eslint ignore**（WASM 胶水代码）

## 参考

- Chunk 下载与流式播放：`src/utils/chunk.ts`、`src/utils/manifest.ts`、`src/components/UsmPlayerModal.vue`
- 文件加载与竞态处理：`src/views/pages/Files.vue`、`src/components/FileBrowser.vue`
- 下载队列：`src/store/download.ts`、`src/components/DownloadList.vue`
- 部署：Vercel（`vercel.json` SPA rewrite，`API_BASE` 为 `.`）与 EdgeOne