import App from '@/App.vue'
// 初始化主题：本地偏好优先，其次系统偏好；并监听系统变化
import { initTheme } from '@/utils/theme'
import '@/assets/tailwind.css'
import '@/assets/custom.css'
// 引入 Element Plus 暗色CSS变量支持
import 'element-plus/theme-chalk/dark/css-vars.css'

const app = createApp(App)

initTheme()

app.mount('#app')
