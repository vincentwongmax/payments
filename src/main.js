import { createApp } from 'vue'
import App from './App.vue'
import './style.css'

const app = createApp(App)

/*
 * 任何元件出錯都不要讓整頁「卡住不動」（曾經因為一張卡片的錯誤，
 * 之後上傳的圖片都不會出現在畫面上，要 F5 才看到）。
 * 這裡把錯誤往外丟一個事件，App.vue 會顯示出來，使用者才知道發生什麼事。
 */
app.config.errorHandler = (err, _instance, info) => {
  const message = String(err?.message ?? err)
  console.error('[app error]', info, err)
  window.dispatchEvent(
    new CustomEvent('app-error', { detail: { message, info: String(info ?? '') } }),
  )
}

/* 非同步、事件回呼裡沒被接住的錯誤也一起報出來 */
window.addEventListener('unhandledrejection', (event) => {
  const message = String(event.reason?.message ?? event.reason ?? '')
  if (!message) return
  console.error('[unhandled rejection]', event.reason)
  window.dispatchEvent(new CustomEvent('app-error', { detail: { message, info: 'unhandledrejection' } }))
})

app.mount('#app')
