import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, copyFileSync } from 'node:fs'
import { extname, join, relative, resolve, sep } from 'node:path'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { scopeCss } from './src/decimen/scopeCss.js'

/*
 * QR CODE 傳輸用的是 decimen 的「已建置」光學傳輸程式（AGPL-3.0-or-later，
 * 見 src/decimen/LICENSE、NOTICE）。那份程式是照它自己的目錄結構寫死的：
 *
 *   - worker 用 new URL("worker-xxxx.js", import.meta.url) 找自己，
 *   - worker 再用 new URL("decimen_codec-xxxx.wasm", self.location.href) 找 wasm，
 *   - 語系用 import("./en-xxxx.js") 相對載入。
 *
 * 檔名裡帶著建置雜湊，任何「打包後重新命名」都會把這些相對路徑拆掉，
 * 所以這裡的做法是：原封不動地照目錄供應（開發時用中介層、建置時複製），
 * 完全不讓 Vite 去處理它們。
 */
const RUNTIME_DIR = resolve('src/decimen/runtime')
const RUNTIME_URL = 'decimen-rt'

const CONTENT_TYPES = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.json': 'application/json; charset=utf-8',
}

/* 只允許直接躺在 runtime 目錄裡的檔案，避免被 ../ 走出目錄 */
const runtimeFile = (urlPath) => {
  const name = urlPath.replace(/^\/+/, '')
  if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) return null
  const full = join(RUNTIME_DIR, name)
  return existsSync(full) && statSync(full).isFile() ? full : null
}

const readRuntime = (name) => {
  const text = readFileSync(join(RUNTIME_DIR, name), 'utf8')
  return extname(name) === '.css' ? scopeCss(text) : text
}

function decimenRuntime() {
  return {
    name: 'decimen-runtime',

    /* 開發：把 runtime 目錄原樣供應在 /decimen-rt/ 底下（不經過 Vite 的轉換） */
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? '').split('?')[0]
        if (!path.startsWith(`/${RUNTIME_URL}/`)) return next()
        const full = runtimeFile(path.slice(RUNTIME_URL.length + 2))
        if (!full) return next()
        res.setHeader('Content-Type', CONTENT_TYPES[extname(full)] ?? 'application/octet-stream')
        res.end(readRuntime(relative(RUNTIME_DIR, full).split(sep).join('/')))
      })
    },

    /* 建置：整包複製到 dist/decimen-rt/，相對路徑原封不動。
       樣式不用複製——它是被 decimen-css 外掛讀進去、縮好之後內嵌在 bundle 裡。 */
    closeBundle() {
      const copyAll = (from, to) => {
        mkdirSync(to, { recursive: true })
        for (const entry of readdirSync(from, { withFileTypes: true })) {
          const src = join(from, entry.name)
          const dst = join(to, entry.name)
          if (entry.isDirectory()) copyAll(src, dst)
          else if (extname(entry.name) !== '.css') copyFileSync(src, dst)
        }
      }
      copyAll(RUNTIME_DIR, resolve('dist', RUNTIME_URL))
    },
  }
}

/* 面板的 CSS：建置時就把 decimen 的樣式縮好，當成字串匯進元件 */
function decimenCss() {
  const VIRTUAL = 'virtual:decimen-css'
  const RESOLVED = `\0${VIRTUAL}`
  return {
    name: 'decimen-css',
    resolveId: (id) => (id === VIRTUAL ? RESOLVED : null),
    load: (id) =>
      id === RESOLVED ? `export default ${JSON.stringify(readRuntime('dialog-lwSt6g5n.css'))}` : null,
  }
}

export default defineConfig({
  plugins: [vue(), decimenRuntime(), decimenCss()],
  base: './',
  /* 設定頁的「版本資訊」用得到：每次建置記下時間，方便確認手機上是不是最新版 */
  define: {
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  server: {
    watch: {
      ignored: [
        '**/.git/**',
        '**/node_modules/**',
        // 編輯器的原子寫入會產生 *.tmpdir，監看它會讓 watcher 掛掉
        '**/*.tmpdir/**',
        // 付款截圖：本程式只從檔案選擇器讀圖，不需要監看。
        // Windows 上被鎖住的圖檔會讓 watcher 以 EBUSY 直接崩潰。
        '**/*.{png,PNG,jpg,JPG,jpeg,JPEG,webp,WEBP,gif,GIF,heic,HEIC}',
        '**/付款記錄/**',
        '**/圖片/**',
      ],
    },
  },
})
