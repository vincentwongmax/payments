import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
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
