/**
 * 把建置結果發布到 gh-pages 分支，不需要 GitHub Actions。
 * 用法：npm run deploy
 *
 * 作法是開一個暫存資料夾當成獨立的 git repo，把 dist 的內容
 * 做成一個 commit 推上 origin/gh-pages。專案本身的歷史完全不受影響。
 */
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const run = (args, cwd) => execFileSync('git', args, { cwd, stdio: 'inherit' })
const capture = (args) => execFileSync('git', args, { encoding: 'utf8' }).trim()

console.log('[1/5] 測試…')
execFileSync(process.execPath, ['test/run.js'], { stdio: 'inherit' })

console.log('[2/5] 建置…')
execFileSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build'], { stdio: 'inherit' })

if (!existsSync('dist/index.html')) {
  console.error('建置失敗：找不到 dist/index.html')
  process.exit(1)
}

console.log('[3/5] 準備發布內容…')
const remote = capture(['remote', 'get-url', 'origin'])
const staging = mkdtempSync(join(tmpdir(), 'gh-pages-'))
cpSync('dist', staging, { recursive: true })
/* 不要讓 GitHub Pages 用 Jekyll 處理這些檔案 */
writeFileSync(join(staging, '.nojekyll'), '')

console.log('[4/5] 建立 gh-pages commit…')
run(['init', '-q', '-b', 'gh-pages'], staging)
run(['add', '-A'], staging)
run(['commit', '-q', '-m', `build ${new Date().toISOString()}`], staging)

console.log(`[5/5] 推送到 ${remote} …`)
run(['remote', 'add', 'origin', remote], staging)
run(['push', '-q', '-f', 'origin', 'gh-pages'], staging)

rmSync(staging, { recursive: true, force: true })
console.log('\n完成。網址：https://vincentwongmax.github.io/payments/')
