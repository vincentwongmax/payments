/*
 * 第二輪驗證：QR 傳輸頁「關掉再打開」能不能真的再用一次
 *   1. 關掉之後，decimen 的背景計時器（即時診斷）不會繼續跑
 *   2. 關閉時收起進度 DOM，再打開接收頁會恢復中斷中的進度
 *   3. 再打開之後相機還開得起來，而且進度條／狀態列都還在、可以用
 */
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PROFILE = join(tmpdir(), `dsh-reuse-${process.pid}`)
const SHOTS = join(tmpdir(), 'dsh-reuse-shots')
const PORT = 9615
const ORIGIN = process.env.CHECK_ORIGIN ?? 'http://127.0.0.1:5173'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

rmSync(PROFILE, { recursive: true, force: true })
mkdirSync(SHOTS, { recursive: true })

const chrome = spawn(
  CHROME,
  ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--user-data-dir=${PROFILE}`, `--remote-debugging-port=${PORT}`, `${ORIGIN}/?persons=Vincent,Ben`],
  { stdio: 'ignore' },
)

let target = null
for (let i = 0; i < 90 && !target; i++) {
  await sleep(400)
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    target = list.find((t) => t.type === 'page' && t.url.startsWith(ORIGIN))
  } catch {
    /* 等 */
  }
}
if (!target) {
  console.log('找不到頁面')
  chrome.kill()
  process.exit(2)
}

const ws = new WebSocket(target.webSocketDebuggerUrl)
let msgId = 0
const pending = new Map()
const pageErrors = []
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.method === 'Runtime.exceptionThrown') {
    pageErrors.push((m.params.exceptionDetails?.exception?.description ?? 'unknown').slice(0, 160))
  }
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m)
    pending.delete(m.id)
  }
})
const send = (method, params = {}) =>
  new Promise((r) => {
    const id = ++msgId
    pending.set(id, r)
    ws.send(JSON.stringify({ id, method, params }))
  })
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r?.result?.exceptionDetails) {
    console.log(`  [頁面例外] ${(r.result.exceptionDetails.exception?.description ?? '').slice(0, 160)}`)
    return undefined
  }
  return r?.result?.result?.value
}
const j = (t, f = null) => {
  try {
    return JSON.parse(t)
  } catch {
    return f
  }
}
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ← ${detail}` : ''}`)
}
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' })
  const bytes = Buffer.from(r?.result?.data ?? '', 'base64')
  if (bytes.length) writeFileSync(join(SHOTS, `${name}.png`), bytes)
}
const clickText = (re) =>
  evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find((b) => ${re}.test(b.innerText.trim()))
    if (!b) return 'no-button'
    b.click()
    return 'ok'
  })()`)
const openFolds = () =>
  evaluate(`(() => {
    for (const d of document.querySelectorAll('.view-settings details.fold')) d.open = true
    return 1
  })()`)
const goReceive = async () => {
  await clickText(`/^設定$/`)
  await sleep(800)
  await openFolds()
  await sleep(400)
  await clickText(`/QR CODE 匯入/`)
  await sleep(2200)
}
/* 診斷是每秒跳一次；而且 #metrics 平常是 display:none，innerText 會拿到空的，
   所以要讀 textContent（不受顯示狀態影響） */
const gauges = () =>
  evaluate(`document.getElementById('metrics').textContent.replace(/\\s+/g, ' ').trim()`)

await new Promise((r) => ws.addEventListener('open', r))
await send('Runtime.enable')
await send('Page.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
await sleep(3200)
for (let i = 0; i < 40; i++) {
  if (await evaluate(`document.querySelectorAll('.person').length >= 2`)) break
  await sleep(400)
}

/* ---------- 第一次：開鏡頭、跑一下 ---------- */
await goReceive()
await evaluate(`document.getElementById('start').click()`)
await sleep(4000)
const firstRun = j(
  await evaluate(`JSON.stringify({
    hasStream: !!document.getElementById('video').srcObject,
    preview: document.getElementById('preview').style.display,
    gauges: document.getElementById('metrics').innerText.replace(/\\s+/g, ' ').trim(),
    startText: document.getElementById('start').innerText.trim(),
    startDisabled: document.getElementById('start').disabled,
    progressExists: !!document.getElementById('progress'),
    barExists: !!document.getElementById('bar'),
    statusExists: !!document.getElementById('progress-status'),
  })`),
)
check(
  '第一次掃描：相機開起來、預覽出現，進度條那幾個節點都在',
  firstRun?.hasStream === true &&
    firstRun?.preview === '' &&
    firstRun?.progressExists === true &&
    firstRun?.barExists === true &&
    firstRun?.statusExists === true,
  JSON.stringify(firstRun),
)
await shot('first-camera')

/* 診斷是每秒跳一次，等它跳起來再读（headless 的假鏡頭 fps 不一定馬上算出來） */
let firstGauges = ''
for (let i = 0; i < 20; i++) {
  firstGauges = await gauges()
  if (/\d/.test(firstGauges)) break
  await sleep(500)
}
check('第一次掃描：即時診斷有在跑（capture fps 出現數字）', /\d/.test(firstGauges), firstGauges)

const hasResetHook = await evaluate(`(() => {
  const reset = window.__appResetDecimenReceive
  if (typeof reset !== 'function') return false
  window.__appResetCalls = 0
  window.__appResetResult = false
  window.__appResetDecimenReceive = () => {
    window.__appResetCalls++
    window.__appResetResult = reset()
    return window.__appResetResult
  }
  return true
})()`)
check('接收 runtime：提供完整 session 重置入口', hasResetHook === true)

/* 模擬接收中斷時 runtime 留下的進度 DOM */
await evaluate(`(() => {
  const progress = document.getElementById('progress')
  const status = document.getElementById('progress-status')
  const bar = document.getElementById('bar')
  progress.style.display = 'block'
  progress.setAttribute('aria-valuenow', '42')
  status.style.display = 'flex'
  document.getElementById('progress-label').textContent = '42% · interrupted'
  bar.style.width = '42%'
  return 1
})()`)

/* ---------- 關掉 → 背景計時器不該再跑 ---------- */
await evaluate(`document.querySelector('.dt-close').click()`)
await sleep(1200)
const closedProgress = j(
  await evaluate(`JSON.stringify({
    progress: document.getElementById('progress').style.display,
    status: document.getElementById('progress-status').style.display,
    value: document.getElementById('progress').getAttribute('aria-valuenow'),
    width: document.getElementById('bar').style.width,
    label: document.getElementById('progress-label').textContent,
    resetCalls: window.__appResetCalls,
    resetOk: window.__appResetResult,
  })`),
)
check(
  '按右上角關閉：runtime session 與進度 DOM 都確實清空',
  closedProgress?.resetCalls >= 1 &&
    closedProgress?.resetOk === true &&
    closedProgress?.progress === 'none' &&
    closedProgress?.status === 'none' &&
    closedProgress?.value === '0' &&
    closedProgress?.width === '' &&
    closedProgress?.label === '0% · 0 frames',
  JSON.stringify(closedProgress),
)
const gaugesA = await gauges()
await sleep(4000)
const gaugesB = await gauges()
check(
  '關掉之後：decimen 的即時診斷不會繼續在背景跑（數字凍結）',
  !!gaugesA && gaugesA === gaugesB,
  `關掉後 ${gaugesA} → 4 秒後 ${gaugesB}`,
)

/* ---------- 第二次打開：畫面要是全新的 ---------- */
await goReceive()
const second = j(
  await evaluate(`JSON.stringify({
    open: document.querySelector('.dt-root').classList.contains('is-open'),
    gauges: document.getElementById('metrics').innerText.replace(/\\s+/g, ' ').trim(),
    startText: document.getElementById('start').innerText.trim(),
    startDisabled: document.getElementById('start').disabled,
    hasStream: !!document.getElementById('video').srcObject,
    preview: getComputedStyle(document.getElementById('preview')).display,
    resultLinks: document.querySelectorAll('#result a.download').length,
    progress: getComputedStyle(document.getElementById('progress')).display,
    progressStatus: getComputedStyle(document.getElementById('progress-status')).display,
    progressValue: document.getElementById('progress').getAttribute('aria-valuenow'),
    progressWidth: document.getElementById('bar').style.width,
    progressLabel: document.getElementById('progress-label').textContent,
    resetOk: window.__appResetResult,
    cameraActual: document.getElementById('camera-actual').textContent.trim(),
    cameraOptions: document.getElementById('cfg-camera').options.length,
  })`),
)
check(
  '重新打開：沒有舊進度、診斷數字清空、相機按鈕回到待機',
  second?.open === true &&
    !/\d/.test(second?.gauges ?? 'x') &&
    second?.startText === 'Start camera' &&
    second?.startDisabled === false &&
    second?.hasStream === false &&
    second?.resultLinks === 0 &&
    second?.progress === 'none' &&
    second?.progressStatus === 'none' &&
    second?.progressValue === '0' &&
    second?.progressWidth === '' &&
    second?.progressLabel === '0% · 0 frames' &&
    second?.resetOk === true,
  JSON.stringify(second),
)
check(
  '重新打開：設定選單還在（相機選單沒有被清成空的）',
  (second?.cameraOptions ?? 0) >= 1 && (second?.cameraActual ?? '').length > 0,
  JSON.stringify({ options: second?.cameraOptions, actual: second?.cameraActual }),
)
await shot('second-open')

/* ---------- 第二次真的能再掃一次 ---------- */
await evaluate(`document.getElementById('start').click()`)
await sleep(4000)
const secondRun = j(
  await evaluate(`JSON.stringify({
    hasStream: !!document.getElementById('video').srcObject,
    preview: document.getElementById('preview').style.display,
    startText: document.getElementById('start').innerText.trim(),
    progressExists: !!document.getElementById('progress'),
    barExists: !!document.getElementById('bar'),
    statusExists: !!document.getElementById('progress-status'),
    progressValue: document.getElementById('progress').getAttribute('aria-valuenow'),
    progressWidth: document.getElementById('bar').style.width,
    stats: document.getElementById('stats').innerText.trim(),
  })`),
)
check(
  '第二次掃描：相機照樣開得起來，進度條與狀態列都還在',
  secondRun?.hasStream === true &&
    secondRun?.preview === '' &&
    secondRun?.progressExists === true &&
    secondRun?.barExists === true &&
    secondRun?.statusExists === true &&
    secondRun?.progressValue === '0' &&
    secondRun?.progressWidth === '',
  JSON.stringify(secondRun),
)
let secondGauges = ''
for (let i = 0; i < 20; i++) {
  secondGauges = await gauges()
  if (/\d/.test(secondGauges)) break
  await sleep(500)
}
check('第二次掃描：即時診斷也重新跑起來了', /\d/.test(secondGauges), secondGauges)
await shot('second-camera')

const noisy = pageErrors.filter((t) => !/favicon/i.test(t))
check('整個流程沒有未捕捉的頁面例外', noisy.length === 0, noisy.slice(0, 2).join(' | '))

const failed = results.filter((r) => !r.ok)
console.log(`\n總計 ${results.length} 項，失敗 ${failed.length} 項`)
console.log(`截圖在 ${SHOTS}`)
chrome.kill()
process.exit(failed.length ? 1 : 0)
