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

/*
 * 離線可用：Service Worker（public/sw.js）會把畫面檔案、OCR 引擎與
 * 用得到的東西快取起來，第一次用過之後就算完全沒網路也打得開、也能辨識。
 * 只在 build 出來的版本註冊——開發時被快取住會很難改東西。
 */
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      await navigator.serviceWorker.register(new URL('sw.js', document.baseURI).href)
      const reg = await navigator.serviceWorker.ready
      /*
       * 第一次打開時 Service Worker 還沒接管這一頁，這頁抓過的檔案不是它抓的，
       * 所以不會進快取（例如 tesseract.js 那個動態載入的 chunk）。
       * 把這一頁用過的站內檔案清單交給它補齊，第二次開始（就算沒網路）才開得起來。
       * QR CODE 傳輸那兩個頁面用不到就先抓下來，之後完全沒網路也能做光學傳輸。
       */
      const urls = [
        ...performance
          .getEntriesByType('resource')
          .map((entry) => entry.name)
          .filter((url) => url.startsWith(location.origin)),
        new URL('decimen/sender.html', document.baseURI).href,
        new URL('decimen/receiver.html', document.baseURI).href,
      ]
      if (reg.active && urls.length) reg.active.postMessage({ type: 'warm', urls })
    } catch {
      /* 註冊失敗（例如隱私模式）就照舊：有網路才用 */
    }
  })
}

/*
 * 要求「永久儲存」。付款記錄、照片、OCR 模型都在 IndexedDB，
 * 沒有這個授權時瀏覽器在空間不足時可以直接清掉（iOS 對沒加到主畫面的網站
 * 更是 7 天沒用就清）。拿不到就算了，不影響使用。
 */
navigator.storage?.persist?.().catch(() => {})

