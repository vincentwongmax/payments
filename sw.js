/*
 * 離線可用：用過一次之後，沒網路也要打得開、也要能辨識。
 *
 * 快取策略
 *   換頁        先試網路（才知道有沒有新版），失敗就用快取開
 *   其他靜態檔  先用快取（快），同時在背景抓新的版本，下次才會是新的
 *
 * 語言模型（tesseract/lang/*.traineddata.gz，約 30MB）刻意不在這裡快取：
 * tesseract 自己會把模型存進 IndexedDB（見 src/lib/ocr.js 的 cachePath），
 * 這裡再存一份只是多佔 30MB，對離線沒有任何幫助。
 */

/*
 * 版號只有在「快取的內容格式改變」時才要改（改了 activate 會把舊快取全部丟掉）。
 * 平常改版不要動它：舊的 JS/CSS 留在快取裡，才不會讓還開著舊 index.html 的人
 * 拿到已經被刪掉的舊檔名。
 */
const CACHE = 'payments-2'

/* 沒有網路也要能開畫面的最小集合 */
const SHELL = ['./', './index.html', './manifest.json', './icons/icon-192.png']

/* 語言模型交給 tesseract 的 IndexedDB 快取處理 */
const isLangModel = (url) => /traineddata/.test(url.pathname) || /\/tesseract\/lang\//.test(url.pathname)

/*
 * 存進快取之前先重新包一個「乾淨」的回應。
 * 直接把 fetch 回來的回應存起來會留著 Content-Encoding: gzip、Vary: Origin
 * 這些「上一次傳輸」的標頭；離線時再拿出來用，瀏覽器會想再解一次 gzip，
 * script 與 stylesheet 就載入失敗（實測 ERR_FAILED，畫面全白）。
 * manifest 與 PNG 沒有被壓縮，所以當時看起來只有它們正常。
 */
async function putClean(cache, key, res) {
  const headers = new Headers()
  const type = res.headers.get('content-type')
  if (type) headers.set('content-type', type)
  const body = await res.blob()
  await cache.put(key, new Response(body, { status: res.status, statusText: res.statusText, headers }))
}

const sameOrigin = (raw) => {
  try {
    const url = new URL(raw, self.location.href)
    return url.origin === self.location.origin && !isLangModel(url) ? url : null
  } catch {
    return null
  }
}

/*
 * 安裝時把「開畫面需要的檔案」抓好。
 * 第一次打開時 Service Worker 還沒接管那一頁，index.html 裡的 JS/CSS 不是它抓的，
 * 所以不會自己進快取——照著 index.html 補起來，第二次開始就完全離線可用。
 */
async function precacheShell() {
  const cache = await caches.open(CACHE)

  for (const raw of SHELL) {
    const url = sameOrigin(raw)
    if (!url) continue
    const res = await fetch(url.href, { cache: 'no-cache' })
    if (res.ok) await putClean(cache, url.href, res)
  }

  const htmlRes = await cache.match('./index.html')
  if (!htmlRes) return
  const shellUrls = [...(await htmlRes.text()).matchAll(/(?:src|href)="([^"]+)"/g)]
    .map((m) => m[1])
    .filter((u) => u && !/^(?:[a-z]+:|\/\/|#)/i.test(u))

  for (const raw of shellUrls) {
    const url = sameOrigin(raw)
    if (!url || (await cache.match(url.href))) continue
    try {
      const res = await fetch(url.href, { cache: 'no-cache' })
      if (res.ok) await putClean(cache, url.href, res)
    } catch {
      /* 個別檔案失敗就算了，其他還是要抓好 */
    }
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    precacheShell()
      .catch(() => {})
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys()
      await Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n)))
      await self.clients.claim()
    })(),
  )
})

/*
 * 第一頁用過的檔案由頁面自己回報（見 src/main.js）：像 tesseract.js 這種
 * 動態載入的 chunk 不在 index.html 裡，Service Worker 光看 HTML 找不到。
 */
self.addEventListener('message', (event) => {
  const urls = event.data?.type === 'warm' ? event.data.urls : null
  if (!urls?.length) return

  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE)
      for (const raw of urls) {
        const url = sameOrigin(raw)
        if (!url || (await cache.match(url.href))) continue
        try {
          const res = await fetch(url.href, { cache: 'no-cache' })
          if (res.ok) await putClean(cache, url.href, res)
        } catch {
          /* 個別檔案抓不到就算了，其他還是要補 */
        }
      }
    })(),
  )
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return

  let url
  try {
    url = new URL(req.url)
  } catch {
    return
  }
  if (url.origin !== self.location.origin) return
  if (isLangModel(url)) return

  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE)
        try {
          const fresh = await fetch(req)
          if (fresh.ok) await putClean(cache, './index.html', fresh.clone())
          return fresh
        } catch {
          return (await cache.match('./index.html')) ?? (await cache.match('./')) ?? Response.error()
        }
      })(),
    )
    return
  }

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE)
      const hit = await cache.match(req)
      const fromNetwork = (async () => {
        const res = await fetch(req)
        if (res.ok) await putClean(cache, req, res.clone())
        return res
      })()

      if (hit) {
        /* 有快取就先給，背景更新失敗也不用管 */
        fromNetwork.catch(() => {})
        return hit
      }
      try {
        return await fromNetwork
      } catch {
        return Response.error()
      }
    })(),
  )
})
