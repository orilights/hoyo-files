<script setup lang="ts">
import type { ChunkData, ChunkInfo, FileInfoWithType, FileListState, FileNode, PkgVersionFile, VersionData } from '@/types'
import { useUrlSearchParams } from '@vueuse/core'
import { API_BASE, API_BASE_FALLBACK, DEFAULT_GAME, GAME_CONFIG, GITHUB_REPO_URL, VOICEPACK_LIST } from '@/constants'
import { NodeType } from '@/types'
import { formatBytes, openLink, sortTree } from '@/utils'

let apiBase: string = API_BASE

const params = useUrlSearchParams('history')

const game = computed({
  get: () => GAME_CONFIG[params.game as string] ? params.game as string : DEFAULT_GAME,
  set: value => params.game = value,
})
const version = ref('')
const useFallback = ref(false)
const versionListData = ref<
  Record<string, VersionData>
>({})
const versionList = ref<string[]>([])
const loadVoicePackList = ref([])

const loading = ref({
  versionList: false,
  chunkData: false,
  fileList: false,
})
const collapseState = ref<string[]>(['game', 'update', 'chunk', 'file-list'])
const updateCollapseState = ref<string[]>([])
const packageList = ref<{
  game: FileInfoWithType[]
  update: Record<string, FileInfoWithType[]>
}>({
  game: [],
  update: {},
})
const chunkState = ref<{
  info: ChunkInfo | null
  data: ChunkData | null
}>({
  info: null,
  data: null,
})
const fileListState = ref<FileListState>({
  game: '',
  version: '',
  voice: [],
  decompressedPath: '',
  tree: null,
  count: 0,
  size: 0,
})
const fileBrowser = ref()

watchEffect(() => {
  document.title = loading.value.versionList
    ? 'HoyoFiles'
    : `${GAME_CONFIG[game.value].name} ${version.value} 版本文件列表 - HoyoFiles`
})

function handleSelectGame(gameName: string) {
  game.value = gameName
  loadGameVersionList()
}

function handleSelectVersion(newVersion: string) {
  version.value = newVersion
  refreshVersionData()
}

function refreshVersionData() {
  const versionData = versionListData.value[version.value]
  packageList.value.game = []
  if (versionData.game.full) {
    packageList.value.game.push({
      ...versionData.game.full,
      type: '游戏本体',
    })
  }
  if (versionData.game.segments) {
    packageList.value.game.push(...versionData.game.segments.map(
      segment => ({
        ...segment,
        type: '游戏本体(分卷)',
      }),
    ))
  }
  for (const langKey of Object.keys(versionData.voice)) {
    packageList.value.game.push({
      ...versionData.voice[langKey],
      type: '语音包',
    })
  }
  packageList.value.update = {}
  Object.keys(versionData.update).forEach((version) => {
    packageList.value.update[version] = []
    packageList.value.update[version].push({
      ...versionData.update[version].game,
      type: '游戏本体',
    })
    Object.keys(versionData.update[version].voice).forEach((langKey) => {
      packageList.value.update[version].push({
        ...versionData.update[version].voice[langKey],
        type: '语音包',
      })
    })
  })
  chunkState.value.info = versionData.chunk
  const updateKeys = Object.keys(packageList.value.update)
  updateCollapseState.value = updateKeys.length ? [`${updateKeys[0]}-${version.value}`] : []
  loadChunkData()
  loadFileList()
}

async function fetchPkgVersion(filename: string) {
  const data = await fetch(`${apiBase}/${game.value}/${version.value}/${filename}`)
  return await data.text()
}

function loadGameVersionList() {
  loading.value.versionList = true
  fetch(`${apiBase}/${game.value}_versions.json`)
    .then(res => res.json())
    .then((data) => {
      versionListData.value = data
      versionList.value = Object.keys(versionListData.value).reverse()
      version.value = versionList.value[0]
      loadVoicePackList.value = []
      refreshVersionData()
    })
    .catch((err) => {
      if (!useFallback.value && API_BASE_FALLBACK !== '') {
        useFallback.value = true
        apiBase = API_BASE_FALLBACK
        ElMessage.warning(`版本列表加载失败 尝试使用备用源`)
        loadGameVersionList()
        return
      }
      ElMessage.error(`版本列表加载失败 ${err}`)
    })
    .finally(() => {
      loading.value.versionList = false
    })
}

function loadChunkData() {
  if (!chunkState.value.info)
    return
  loading.value.chunkData = true
  fetch(`${apiBase}/chunk/${game.value}_${version.value}.json`)
    .then(res => res.json())
    .then((res) => {
      chunkState.value.data = res.data
    })
    .catch((err) => {
      ElMessage.error(`chunk 数据加载失败 ${err}`)
    })
    .finally(() => {
      loading.value.chunkData = false
    })
}

async function loadFileList() {
  loading.value.fileList = true
  const loadedVoicePackList: string[] = []
  try {
    const newFileTree: FileNode = {
      type: NodeType.Directory,
      name: '',
      children: [],
      size: 0,
    }
    const loadKey = `${game.value}_${version.value}`

    const gameData = await fetchPkgVersion('pkg_version')

    const fileData: PkgVersionFile[] = []
    gameData.split('\n').forEach((line) => {
      if (line === '')
        return
      fileData.push(JSON.parse(line))
    })
    for (const key of loadVoicePackList.value) {
      try {
        const voiceData = await fetchPkgVersion(VOICEPACK_LIST[key])
        voiceData.split('\n').forEach((line) => {
          if (line === '')
            return
          fileData.push(JSON.parse(line))
        })
        loadedVoicePackList.push(key)
      }
      catch (e) {
        ElMessage.error(`语音包[${key}]加载失败 ${e}`)
      }
    }
    if (loadKey !== `${game.value}_${version.value}`) {
      return
    }
    fileData.forEach((file) => {
      const path = file.remoteName.replace(/\\/g, '/').split('/')
      let tree = newFileTree
      for (let i = 0; i < path.length; i++) {
        const name = path[i]
        if (i === path.length - 1) {
          tree.size += file.fileSize
          tree.children.push({
            type: NodeType.File,
            name,
            children: [],
            size: file.fileSize,
            fileData: file,
          })
        }
        else {
          tree.size += file.fileSize
          const child = tree.children.find(child => child.name === name)
          if (child) {
            tree = child
          }
          else {
            const newTree = {
              type: NodeType.Directory,
              name,
              children: [],
              size: 0,
            }
            tree.children.push(newTree)
            tree = newTree
          }
        }
      }
    })
    sortTree(newFileTree)
    fileListState.value = {
      game: GAME_CONFIG[game.value].name,
      version: version.value,
      voice: loadedVoicePackList,
      decompressedPath: versionListData.value[version.value].decompressed_path,
      tree: newFileTree,
      count: fileData.length,
      size: newFileTree.size,
    }
    nextTick(() => {
      fileBrowser.value.refresh()
    })
  }
  catch (e) {
    ElMessage.error(`文件列表加载失败 ${e}`)
    loading.value.fileList = false
  }
  loading.value.fileList = false
}

onMounted(() => {
  handleSelectGame(game.value)
})
</script>

<template>
  <el-container class="h-screen min-w-[900px] overflow-auto">
    <!-- 固定高度的左侧容器栏，避免占满全屏，同时支持纵向滚动 -->
    <el-aside
      class="h-screen border-r p-4" width="auto"
    >
      <!-- 主题切换按钮：位于左侧栏顶部 -->
      <div class="mb-3 flex justify-center">
        <ThemeToggle />
      </div>
      <el-space direction="vertical" size="large" alignment="center">
        <div
          v-for="[key, gameConfig] in Object.entries(GAME_CONFIG)" :key="key"
          class="overflow-hidden rounded-xl border-2 border-transparent transition-all duration-300 hover:border-gray-300"
          :class="{
            '!border-blue-500': game === key,
          }"
          :title="gameConfig.name"
          @click="handleSelectGame(key)"
        >
          <img
            :src="gameConfig.icon" :alt="gameConfig.name"
            class="size-[48px]"
          >
        </div>
        <div
          class="overflow-hidden rounded-xl border-2 border-transparent transition-all  duration-300 hover:border-gray-300"
          title="Github"
          @click="openLink(GITHUB_REPO_URL)"
        >
          <img
            src="https://files.hk4e.com/icon/github.png" alt="GithubRepoUrl"
            class="size-[48px]"
          >
        </div>
      </el-space>
    </el-aside>
    <el-aside v-loading="loading.versionList" width="160px" class="border-r">
      <el-scrollbar>
        <div class="p-3">
          <div
            v-for="ver in versionList" :key="ver"
            class="my-1 cursor-pointer rounded-lg px-4 py-1.5 text-sm transition-colors hover:bg-gray-100"
            :style="version === ver ? { backgroundColor: 'var(--selected-bg)', color: 'var(--selected-text)' } : {}"
            @click="handleSelectVersion(ver)"
          >
            {{ ver }}
          </div>
        </div>
      </el-scrollbar>
    </el-aside>
    <el-scrollbar class="w-full">
      <el-main>
        <el-collapse v-model="collapseState">
          <div class="xl:flex xl:gap-4">
            <div class="mb-2 min-w-0 xl:flex-1">
              <el-collapse-item name="game" title="游戏包" class="mb-2 rounded-lg border px-4 shadow-md">
                <el-empty
                  v-if="packageList.game.length === 0"
                  description="无数据" :image-size="100"
                />
                <GamePackageTable v-else :data="packageList.game" />
              </el-collapse-item>
              <el-collapse-item name="update" title="升级包" class="mb-2 rounded-lg border px-4 shadow-md">
                <div v-loading="loading.versionList">
                  <el-empty
                    v-if="Object.keys(packageList.update).length === 0"
                    description="无数据" :image-size="100"
                  />
                  <el-collapse v-else v-model="updateCollapseState">
                    <el-collapse-item
                      v-for="[versionKey, updateData] in Object.entries(packageList.update)" :key="versionKey"
                      :title="versionKey"
                      :name="`${versionKey}-${version}`"
                      class="mb-1 rounded-lg border px-4"
                    >
                      <GamePackageTable :data="updateData" />
                    </el-collapse-item>
                  </el-collapse>
                </div>
              </el-collapse-item>
            </div>
            <div class="mb-2 min-w-0 xl:flex-1">
              <el-collapse-item
                name="chunk"
                title="文件块信息"
                class="mb-2 rounded-lg border px-4 shadow-md"
              >
                <div v-loading="loading.chunkData">
                  <el-empty
                    v-if="!chunkState.info"
                    description="无数据" :image-size="100"
                  />
                  <ChunkInfo v-else :info="chunkState.info" :data="chunkState.data" />
                </div>
              </el-collapse-item>
              <el-collapse-item name="file-list" title="文件列表" class="mb-2 rounded-lg border px-4 shadow-md">
                <div v-loading="loading.fileList || loading.versionList">
                  <el-space class="mb-2" wrap>
                    <status-tag title="游戏">
                      {{ fileListState.game }}
                    </status-tag>
                    <status-tag title="版本">
                      {{ fileListState.version }}
                    </status-tag>
                    <status-tag title="语音包">
                      <template v-if="GAME_CONFIG[game].voice.length">
                        <el-select
                          v-model="loadVoicePackList"
                          multiple
                          collapse-tags
                          collapse-tags-tooltip
                          clearable
                          :max-collapse-tags="2"
                          placeholder="选择语音包"
                          class="w-[180px]"
                          size="small"
                          @blur="loadFileList"
                        >
                          <el-option
                            v-for="item in GAME_CONFIG[game].voice"
                            :key="item"
                            :label="item"
                            :value="item"
                          />
                        </el-select>
                      </template>
                      <span v-else>
                        无
                      </span>
                    </status-tag>
                    <status-tag title="文件数量">
                      {{ fileListState.count }}
                    </status-tag>
                    <status-tag title="文件大小">
                      {{ formatBytes(fileListState.size) }}
                    </status-tag>
                  </el-space>
                  <FileBrowser ref="fileBrowser" :file-tree="fileListState.tree" :decompressed-path="fileListState.decompressedPath" />
                </div>
              </el-collapse-item>
            </div>
          </div>
        </el-collapse>
      </el-main>
    </el-scrollbar>
  </el-container>
</template>
