<script setup>
/*
 * QR CODE 傳輸面板：把 decimen 光學傳輸（AGPL-3.0-or-later，見 src/decimen/LICENSE）
 * 直接掛進這個 App 裡，不再開新分頁、也不再放 public/ 的獨立 HTML。
 *
 * 這裡有兩件事要特別注意：
 *
 * 1. 下方的 HTML **不是**普通的樣板。decimen 的 runtime 是用 document.getElementById()
 *    直接綁 DOM，而且只在模組第一次載入時綁一次，所以：
 *      - 整份標記必須一直留在 DOM 裡（不能 v-if 拆掉），面板只用 CSS 切換顯示；
 *      - 標記本身完全不綁 Vue（不加 :class、不用 v-show），免得 Vue 跟 runtime
 *        互相覆蓋同一批屬性或 style。要切換的只有最外層我自己的 .dt-root。
 *    需要的 id 一個都不能少，少一個 runtime 會在模組層就丟例外。
 *
 * 2. runtime 的檔案（JS chunk + wasm）因為檔名帶著建置雜湊、而且彼此用相對路徑互找，
 *    所以由 vite.config.js 的 decimen-runtime 外掛原封不動地供應在 /decimen-rt/ 底下。
 */
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
/* decimen 的樣式（已經被外掛縮進 #decimen-app，不會汙染本來的 App） */
import decimenCss from 'virtual:decimen-css'
import { isBackupFile } from '../lib/backup.js'
import { shareOrSaveFile } from '../lib/util.js'

/* 由 App 的 view 控制（跟設定頁一樣是一個「頁面」，不是在頁面上蓋一層） */
const props = defineProps({ open: { type: Boolean, default: false } })
const emit = defineEmits(['received', 'foreign', 'close', 'refresh'])

const mode = ref('send')
const status = ref('')
const failed = ref('')
/* 收到「不是本程式備份檔」的檔案時放這裡，讓使用者自己分享／儲存 */
const foreign = ref(null)
const foreignNote = ref('')

/* runtime 只載入一次；兩份 entry 各自對應一半的介面 */
let loaded = null
let cssInjected = false

const runtimeVersion = typeof __BUILD_TIME__ === 'string' ? __BUILD_TIME__ : 'development'
const runtimeUrl = (name) => {
  const url = new URL(`decimen-rt/${name}`, document.baseURI)
  url.searchParams.set('build', runtimeVersion)
  return url.href
}

async function loadRuntime() {
  if (loaded) return loaded
  loaded = (async () => {
    if (!cssInjected) {
      const style = document.createElement('style')
      style.dataset.decimen = 'style'
      style.textContent = decimenCss
      document.head.append(style)
      cssInjected = true
    }
    /*
     * 面板只留英文：decimen 用 <html data-i18n-static> 當「這一頁已經是哪個語言」的
     * 依據，設成 en 就不會再去載入其他語系檔（那些檔案我們沒有一起放進來）。
     * 順手把「換語言」提示關掉，免得瀏覽器是中文時它去要一個不存在的語系檔。
     */
    document.documentElement.dataset.i18nStatic = 'en'
    try {
      localStorage.setItem('decimen:locale-banner-dismissed', '1')
    } catch {
      /* 無痕模式擋 localStorage 就算了，不影響 */
    }
    /* decimen 會把 <html lang> 改成它自己的語言，載入完要還原成本頁原本的 */
    const pageLang = document.documentElement.lang
    /* 一定要在 decimen 之前裝好，才追得到它建的計時器（見 patchTimers） */
    patchTimers()
    await Promise.all([
      import(/* @vite-ignore */ runtimeUrl('send-Bd5Iw8X4.js')),
      import(/* @vite-ignore */ runtimeUrl('receive-CLE1NPaP.js')),
    ])
    if (pageLang) document.documentElement.lang = pageLang
  })().catch((e) => {
    /* 載入失敗（例如第一次真的沒網路）就別把失敗的 promise 一直留著，下次再試 */
    loaded = null
    throw e
  })
  return loaded
}

async function ensureLoaded() {
  try {
    await loadRuntime()
  } catch (e) {
    failed.value = `QR 傳輸程式載入失敗：${e?.message ?? e}`
    throw e
  }
}

/*
 * 每一次「進到這一頁」都重新開始：
 *   - 先把上一次的東西收乾淨（停掉串流、關掉鏡頭、關掉對話框、離開全螢幕）
 *   - 再把 decimen 自己會改的那些節點還原成載入前的樣子（見 snapshot()）
 * 這樣就不會看到上一趟的檔名、上一顆 QR、上一次收到的檔案。
 *
 * 注意：不能改用「重新 import runtime」來達成，因為模組層會註冊 window／document
 * 的監聽、也會留下解碼 worker；而且 decimen 是載入時就把 DOM 節點抓在閉包裡，
 * 把標記重建（innerHTML）會讓它指到已經被丟掉的節點。所以只能就地還原。
 */
/*
 * 只有文字的節點：可以直接還原 textContent（同時把 runtime 追加的子節點清掉）。
 * 容器節點不能碰 textContent——那只會把底下原本的標記（例如 #stage 裡的 canvas、
 * #pane-file 裡的按鈕）整批刪掉。
 */
const TEXT_IDS = [
  'start',
  'stats',
  'progress-label',
  'eta-label',
  'camera-actual',
  'specs',
  'export-estimate',
  'file-picker-label',
  'file-picker-button',
]

/* 裡面還有子節點的容器：只還原屬性，textContent 一律不碰 */
const BOX_IDS = [
  'preview',
  'progress',
  'progress-status',
  'metrics',
  'diagnostics',
  'settings',
  'no-signal',
  'stage',
  'stream-specs',
  'export-panel',
  'pane-file',
  'pane-snippet',
]

/* 內容是 runtime 自己長出來的，還原時直接清空 */
const EMPTY_IDS = ['result', 'no-signal-tips']

/*
 * 診斷數字（Live diagnostics）的每一格。decimen 會逐格寫值進去，
 * 還原時要逐項寫回原本的「—」，不能把容器清掉（它把節點抓在閉包裡）。
 */
const GAUGE_IDS = ['m-cap', 'm-dec', 'm-rate', 'm-time', 'm-frames', 'm-k', 'm-block', 'm-payload']

/*
 * 設定類的下拉／勾選：還原成「載入前的值」。
 * decimen 會在啟動相機時改這些（相機清單、decode workers 依硬體調整），
 * 清成空白會讓下一次的選單少東西，所以是還原而不是清空。
 */
const FORM_IDS = [
  'cfg-camera',
  'cfg-width',
  'cfg-capfps',
  'cfg-workers',
  'cfg-autoshow',
  'cfg-fps',
  'cfg-bytes',
  'cfg-ecc',
  'cfg-grid',
  'cfg-size',
  'cfg-export-format',
  'cfg-export-fps',
  'cfg-export-scale',
  'cfg-export-cycles',
]

let pristine = null

/** 在 decimen 還沒載入前，先記下這些節點原本的樣子 */
function snapshot() {
  const grab = (ids, withText) =>
    ids.map((id) => {
      const el = document.getElementById(id)
      if (!el) return null
      const isForm =
        el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement
      return {
        id,
        withText,
        text: withText ? el.textContent : '',
        hidden: el.hidden,
        display: el.style.display,
        className: el.className,
        disabled: el.disabled,
        value: isForm ? el.value : undefined,
        checked: el instanceof HTMLInputElement && el.type === 'checkbox' ? el.checked : undefined,
      }
    })
  pristine = [...grab(TEXT_IDS, true), ...grab(BOX_IDS, false), ...grab(FORM_IDS, false)]
}

/** 把 decimen 動過的節點還原成全新的樣子 */
function restoreSnapshot() {
  for (const saved of pristine ?? []) {
    if (!saved) continue
    const el = document.getElementById(saved.id)
    if (!el) continue
    el.hidden = saved.hidden
    el.style.display = saved.display
    el.className = saved.className
    if (saved.disabled !== undefined) el.disabled = saved.disabled
    if (saved.withText) el.textContent = saved.text
    /* 表單元件的值還原成原本的（清成空字串會讓下一次的選單少東西） */
    if (saved.value !== undefined) el.value = saved.value
    if (saved.checked !== undefined) el.checked = saved.checked
    /* 沒有特別記錄值的輸入框（檔案欄位、文字框）一律清空 */
    if (
      saved.value === undefined &&
      (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)
    ) {
      el.value = ''
    }
  }
  for (const id of EMPTY_IDS) document.getElementById(id)?.replaceChildren()
  /*
   * 診斷數字：decimen 是逐格填進去的（capture fps、decode fps、goodput…）。
   * 注意不能把容器清空——它把這些節點抓在閉包裡，清掉會讓它下次寫入時爆掉，
   * 所以要逐項還原成原本的文字。
   */
  for (const id of GAUGE_IDS) {
    const el = document.getElementById(id)
    if (el) el.textContent = '—'
  }
  document.getElementById('progress')?.setAttribute('aria-valuenow', '0')
  const bar = document.getElementById('bar')
  if (bar) bar.style.width = ''
  /* 送出／接收的狀態文字與說明也一起回到待機 */
  const cameraActual = document.getElementById('camera-actual')
  if (cameraActual) cameraActual.textContent = 'Applied when the camera starts.'
  /* 送出模式回到「檔案」，並讓 decimen 自己切換對應的面板 */
  const radio = document.querySelector('#mode-picker input[value="file"]')
  if (radio && !radio.checked) {
    radio.checked = true
    radio.dispatchEvent(new Event('change', { bubbles: true }))
  }
}

/** 上一次的串流／鏡頭／對話框／全螢幕全部收掉 */
function teardown() {
  stopCamera()
  stopSend()
  /* decimen 的即時診斷計時器要一起停掉，不然它會在背景一直跑 */
  clearPendingTimers()
  /* decimen 的說明／分享對話框是 top layer，祖先 display:none 蓋不掉，要自己關 */
  for (const dialog of document.querySelectorAll('#decimen-app dialog[open]')) dialog.close()
  document.body.classList.remove('qr-full')
}

/**
 * 停止鏡頭與傳送串流。接收解碼器是模組層單例，沒有公開的重置 API；
 * 未完成的接收工作階段會保留在 runtime，關閉面板時由 pausedReceiveProgress 暫存其畫面，
 * 重新開啟接收頁後再顯示，讓 runtime 收到相同 session 的影格時能繼續更新進度。
 */
function resetInnerState() {
  stopSend()
  stopCamera()
}

function resetSession() {
  teardown()
  if (loaded) {
    const resetReceive = window.__appResetDecimenReceive
    if (typeof resetReceive !== 'function') {
      failed.value = 'QR 接收程式版本不一致，請重新整理 App 後再試。'
    } else if (!resetReceive()) {
      failed.value = 'QR 接收狀態未能清乾淨，請重新整理 App 後再試。'
    }
  }
  resetInnerState()
  restoreSnapshot()
}

/** 傳送中就把 decimen 自己的「Stop transfer」按下去，內部串流才會真的停 */
function stopSend() {
  const pane = document.getElementById('pane-file')
  if (!pane?.classList.contains('has-file')) return
  document.getElementById('file-picker-button')?.click()
}

/** 進到某一頁：收乾淨上一次的、還原成全新、再確認 runtime 已經載入 */
async function enter(which) {
  mode.value = which
  failed.value = ''
  status.value = ''
  foreign.value = null
  foreignNote.value = ''
  await nextTick()
  resetSession()
  /* 掃描頁固定先提示要按哪一顆（匯出那邊由 decimen 自己的狀態列負責） */
  if (which === 'receive') status.value = '按「Start camera」開始掃描對方螢幕上的 QR 動畫'
  await ensureLoaded()
}

/**
 * 匯出：把備份檔交給 decimen 的傳送介面。
 * decimen 的檔案選擇器是 #cfg-file，用 DataTransfer 直接塞檔案再丟 change，
 * 等於使用者自己選了那個檔。
 */
async function sendFile(file) {
  await enter('send')
  const input = document.getElementById('cfg-file')
  if (!input) throw new Error('找不到 decimen 的檔案欄位')
  const dt = new DataTransfer()
  dt.items.add(file)
  input.files = dt.files
  input.dispatchEvent(new Event('change', { bubbles: true }))
  status.value = `已把「${file.name}」（${(file.size / 1048576).toFixed(1)} MB）交給傳送畫面`
}

/** 接收：開掃描介面，收到檔案時由 watchResult 丟出 received */
async function receive() {
  await enter('receive')
}

/*
 * decimen 收到檔案後會把結果寫進 #result，內容是一個帶 download 屬性的連結
 * （href 是 blob:）。這裡盯著它，一出現就把檔案接過來交給 App 匯入。
 */
let observer = null
let taking = false

async function takeResult(link) {
  taking = true
  const name = link.getAttribute('download') || 'received.json'
  try {
    const blob = await (await fetch(link.href)).blob()
    const file = new File([blob], name, { type: blob.type || 'application/json' })
    if (await isBackupFile(file)) {
      status.value = `已收到「${name}」，開始匯入…`
      emit('received', file)
    } else {
      /* 不是本程式的備份檔：不硬匯入，交給使用者自己帶走 */
      await takeForeign(file)
    }
  } catch (e) {
    failed.value = `收下檔案失敗：${e?.message ?? e}`
  } finally {
    taking = false
  }
}

/*
 * 收到別的檔案（照片、PDF、文字…都可以）：
 * 先自動試開系統分享面板；分享面板要「使用者手勢」才一定開得起來，
 * 被擋下來就退回下載，並且留一顆按鈕讓使用者自己按（點按就一定會開）。
 */
async function takeForeign(file) {
  foreign.value = file
  foreignNote.value = ''
  status.value = `收到「${file.name}」（${(file.size / 1048576).toFixed(1)} MB）——不是本程式的備份檔`
  emit('foreign', file)
  const how = await shareOrSaveFile(file)
  if (how === 'shared') foreignNote.value = '已開啟分享面板。'
  else if (how === 'saved') foreignNote.value = '分享面板打不開，已經直接下載。'
  /* 使用者按取消就甚麼都不說，按鈕還留著讓他再試 */
}

/** 使用者自己按「分享／儲存」：有手勢就一定開得起來 */
async function shareForeign() {
  const file = foreign.value
  if (!file) return
  const how = await shareOrSaveFile(file)
  if (how === 'shared') foreignNote.value = '已開啟分享面板。'
  else if (how === 'saved') foreignNote.value = '這個瀏覽器沒有分享面板，已經直接下載。'
}

/** ✕ 或手機返回：真的收掉面板（歷史記錄由 App 負責，這裡只收拾乾淨） */
function close() {
  resetSession()
  emit('close')
}

function refresh() {
  emit('refresh', mode.value)
}

/* 切換傳送／接收：一樣走 enter()，離開的那一邊會一起收乾淨（串流／鏡頭都不留） */
async function setMode(which) {
  if (mode.value === which) return
  await enter(which)
}

/*
 * 這一頁關掉之後，decimen 自己的「即時診斷」計時器還會繼續跑（實測：關掉之後
 * capture fps 還從 14 一路掉到 0，等於有一個背景 timer 一直在動）。它把 timer id
 * 存在模組層的變數裡、外面拿不到。
 *
 * 作法是只攔「週期性的 setInterval」——診斷就是靠它跳的。
 * 千萬不要連 setTimeout 一起攔再全部清掉：Vue 的排程、對話框、App 自己的延遲工作
 * 都會用到 setTimeout，一起清會把它們弄死（實際發生過：關閉面板會卡住）。
 * 只清理「decimen 載入之後才建立、而且現在還活著」的 interval，並避開 App 自己用的。
 */
let patchedIntervals = new Set()
let timerPatched = false

function patchTimers() {
  if (timerPatched) return
  timerPatched = true
  const originalSetInterval = window.setInterval
  const originalClearInterval = window.clearInterval

  window.setInterval = function (...args) {
    const id = originalSetInterval.apply(this, args)
    patchedIntervals.add(id)
    return id
  }
  window.clearInterval = function (id) {
    patchedIntervals.delete(id)
    return originalClearInterval.call(this, id)
  }
}

/**
 * 停掉 decimen 留下來的週期性計時器（即時診斷）。
 * 只碰 interval，不動任何 setTimeout，所以不會影響 Vue 或 App 自己的排程。
 */
function clearPendingTimers() {
  for (const id of [...patchedIntervals]) {
    clearInterval(id)
  }
  patchedIntervals.clear()
}

function watchResult() {
  const result = document.getElementById('result')
  if (!result || observer) return
  observer = new MutationObserver(() => {
    if (taking) return
    /* 一次收到多個連結時只匯入第一個；全部先標記，免得又被掃一次 */
    const links = [...result.querySelectorAll('a.download:not([data-taken])')]
    if (!links.length) return
    for (const link of links) link.dataset.taken = '1'
    takeResult(links[0])
  })
  observer.observe(result, { childList: true, subtree: true })
}

/*
 * 傳送中的狀態列（#specs）decimen 會塞一顆「Share receiver link」按鈕進去，
 * 那是連到 decimen.app 的接收頁、順便開分享對話框用的；這個 App 不做這件事
 * （兩台都開同一個 App，不需要分享連結），所以按鈕一出現就拿掉。
 * 拿掉之後尾巴會留下一個孤零零的破折號，一起收乾淨。
 */
let specsObserver = null

function tidySpecs() {
  const specs = document.getElementById('specs')
  if (!specs) return
  for (const btn of specs.querySelectorAll('button.text-button')) btn.remove()
  const last = specs.lastChild
  if (last?.nodeType === Node.TEXT_NODE && /^[\s—–-]+$/.test(last.textContent ?? '')) last.textContent = ''
}

function watchSpecs() {
  const specs = document.getElementById('specs')
  if (!specs || specsObserver) return
  specsObserver = new MutationObserver(tidySpecs)
  specsObserver.observe(specs, { childList: true })
}

/* 面板關掉時把相機確實關掉（只是 display:none 的話鏡頭會一直亮著） */
function stopCamera() {
  const video = document.getElementById('video')
  const stream = video?.srcObject
  if (stream?.getTracks) for (const track of stream.getTracks()) track.stop()
  if (video) video.srcObject = null
}

onMounted(() => {
  snapshot()
  watchResult()
  watchSpecs()
})

/*
 * 這一頁被收掉時一定要收拾乾淨——不管是按 ✕ 還是手機的返回手勢／返回鍵。
 * 返回手勢只會讓 App 把 view 切走（open 變成 false），不會經過 close()，
 * 所以這裡盯著 open：一關掉就停串流、關鏡頭、關對話框、離開全螢幕。
 * 漏掉的話：鏡頭會一直亮、QR 串流會一直在背景跑，而且 decimen 的對話框要是
 * 還開著，style.css 的 `body:has(dialog[open]) { overflow: hidden }` 會讓整個
 * 頁面不能捲動（看起來就是半屏空白、要滑一下才正常）。
 */
watch(
  () => props.open,
  (isOpen) => {
    if (!isOpen) resetSession()
  },
)

onBeforeUnmount(() => {
  observer?.disconnect()
  observer = null
  specsObserver?.disconnect()
  specsObserver = null
  teardown()
})

defineExpose({ sendFile, receive, close })
</script>

<template>
  <!--
    這一頁跟設定頁一樣是「一個頁面」（由 App 的 view 決定顯示），不是在頁面上蓋一層。
    但 decimen 的標記必須一直留在 DOM 裡（runtime 只綁一次），所以關掉時只是藏起來。
  -->
  <div class="dt-root" :class="[`mode-${mode}`, { 'is-open': open }]">
    <div class="dt-bar">
      <div class="dt-tabs" role="tablist" aria-label="QR CODE 傳輸">
        <button
          type="button"
          class="dt-tab"
          :class="{ on: mode === 'send' }"
          role="tab"
          :aria-selected="mode === 'send'"
          @click="setMode('send')"
        >
          傳送（這台播 QR）
        </button>
        <button
          type="button"
          class="dt-tab"
          :class="{ on: mode === 'receive' }"
          role="tab"
          :aria-selected="mode === 'receive'"
          @click="setMode('receive')"
        >
          接收（用鏡頭掃）
        </button>
      </div>
      <button type="button" class="dt-refresh" title="重新整理" aria-label="重新整理" @click="refresh">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M20 7v5h-5M4 17v-5h5" />
          <path d="M5.6 9a7 7 0 0 1 11.6-2L20 12M4 12l2.8 5a7 7 0 0 0 11.6-2" />
        </svg>
      </button>
      <button type="button" class="dt-close" title="關閉" aria-label="關閉" @click="close">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>
    </div>

    <p v-if="status" class="dt-status">{{ status }}</p>
    <p v-if="failed" class="dt-error">{{ failed }}</p>

    <!-- 收到的不是本程式的備份檔：讓使用者自己分享／儲存帶走 -->
    <div v-if="foreign" class="dt-foreign">
      <p class="dt-foreign-text">
        <strong>{{ foreign.name }}</strong
        >（{{ (foreign.size / 1048576).toFixed(1) }} MB）不是本程式的備份檔，所以沒有匯入。
        要留下的話可以自己分享或儲存。
      </p>
      <div class="dt-foreign-actions">
        <button type="button" class="dt-btn-primary" @click="shareForeign">分享／儲存</button>
      </div>
      <p v-if="foreignNote" class="dt-foreign-note">{{ foreignNote }}</p>
    </div>

    <div class="dt-body">
      <!-- ↓↓↓ decimen 的介面：整份靜態，任何一個 id 都不能少 ↓↓↓ -->
      <div id="decimen-app">
        <!-- ===== 傳送（原本的 send/index.html） ===== -->
        <main class="send-shell">
          <section class="tool-intro">
            <p class="eyebrow">Screen → camera</p>
            <h1 id="tool-title">Send a file</h1>
            <p>Nothing leaves your device until you scan with a receiver.</p>
          </section>

          <div class="mode-picker" id="mode-picker" role="radiogroup" aria-label="What to send">
            <label>
              <input type="radio" name="send-mode" value="file" checked />
              <span>File</span>
            </label>
            <label>
              <input type="radio" name="send-mode" value="snippet" />
              <span>Text snippet</span>
            </label>
          </div>

          <label class="file-picker" id="pane-file">
            <span class="file-picker-button" id="file-picker-button">Select File</span>
            <span class="file-picker-text" id="file-picker-label">Any file · up to 64 MB</span>
            <input id="cfg-file" type="file" />
          </label>

          <!-- 原版的示範 payload 會去 decimen.app 抓圖，這裡不需要；留下容器就好（runtime 會找它） -->
          <div class="demo-picker" id="pane-demo" hidden>
            <span>Demo payload</span>
            <div class="demo-buttons"></div>
          </div>

          <div class="note-composer" id="pane-snippet" hidden>
            <label for="snippet-text" id="snippet-label">Text to send</label>
            <textarea id="snippet-text" rows="7" placeholder="Paste or type anything — a URL, a config, a wall of text…"></textarea>
            <button id="send-snippet" type="button">Start text stream</button>
          </div>

          <div class="stage" id="stage" hidden><canvas id="qr" width="16" height="16"></canvas></div>

          <details class="settings">
            <summary>Transfer settings</summary>
            <div class="row">
              <label>
                <span>tx fps</span>
                <select id="cfg-fps"><option>10</option><option>15</option><option>20</option><option>24</option><option>30</option><option>55</option><option selected>60</option></select>
              </label>
              <label>
                <span>bytes / frame</span>
                <select id="cfg-bytes"><option>500</option><option>1000</option><option>1465</option><option>1850</option><option>2331</option><option selected>2953</option></select>
              </label>
              <label>
                <span>error correction</span>
                <select id="cfg-ecc">
                  <option selected>L</option><option>M</option><option>Q</option><option>H</option>
                </select>
              </label>
              <label>
                <span>layout</span>
                <select id="cfg-grid">
                  <option value="1" selected>1 code</option><option value="2">2 codes (1×2)</option><option value="4">4 codes (2×2)</option><option value="6">6 codes (2×3)</option>
                </select>
              </label>
              <label>
                <span>display size</span>
                <input id="cfg-size" type="range" min="300" max="1200" step="50" value="900" />
              </label>
            </div>
            <dl class="stream-specs" id="stream-specs" hidden>
              <div><dt>tx rate</dt><dd id="spec-fps">—</dd></div>
              <div><dt>frame payload</dt><dd id="spec-frame">—</dd></div>
              <div><dt>qr</dt><dd id="spec-qr">—</dd></div>
              <div><dt>sending</dt><dd id="spec-payload">—</dd></div>
              <div><dt>compression</dt><dd id="spec-compression">—</dd></div>
              <div><dt>fountain blocks</dt><dd id="spec-k">—</dd></div>
            </dl>
            <details class="settings subsection" id="export-panel" hidden>
              <summary>Export animation</summary>
              <p class="hint">
                Save this stream as a looping animation file. Embed it in a video or a page —
                any camera pointed at the playing loop can receive the file.
              </p>
              <div class="row">
                <label>
                  <span>format</span>
                  <select id="cfg-export-format">
                    <option value="apng" selected>APNG</option><option value="zip">PNG sequence (ZIP)</option>
                  </select>
                </label>
                <label>
                  <span>frame rate</span>
                  <select id="cfg-export-fps">
                    <option>5</option><option selected>10</option><option>15</option><option>30</option><option>60</option>
                  </select>
                </label>
                <label>
                  <span>module scale</span>
                  <select id="cfg-export-scale">
                    <option value="1">1×</option><option value="2">2×</option><option value="4" selected>4×</option><option value="8">8×</option>
                  </select>
                </label>
                <label>
                  <span>cycles</span>
                  <select id="cfg-export-cycles">
                    <option>1</option><option selected>2</option><option>3</option><option>4</option><option>5</option>
                  </select>
                </label>
              </div>
              <p class="hint" id="export-estimate">—</p>
              <div class="note-actions">
                <button id="export-start" type="button">Export</button>
              </div>
            </details>
          </details>

          <div class="hint status-line" id="specs">Choose a file to begin</div>

          <!--
            這個對話框我們沒有做按鈕去開它（沒有要「分享接收端連結」的功能）。
            但 decimen 的 runtime 在載入時就會去綁 #share-close，少了它整個傳送介面會直接
            掛掉，所以標記要留著。
          -->
          <dialog class="help-dialog share-dialog" id="share-dialog" aria-labelledby="share-title" data-share-title="Decimen Optical Transfer — receiver">
            <h2 id="share-title" tabindex="-1" autofocus>Share the receiver</h2>
            <p class="share-hint">Scan this with the other device's camera, or send it the link.</p>
            <canvas id="share-qr" width="16" height="16"></canvas>
            <div class="share-url-row">
              <input id="share-url" readonly value="https://decimen.app/receive/" aria-label="Receiver link" />
              <button id="share-copy" class="secondary-button" type="button">Copy</button>
            </div>
            <div class="note-actions">
              <button id="share-native" class="secondary-button" type="button" hidden>Share…</button>
              <button id="share-close" class="secondary-button" type="button">Close</button>
            </div>
          </dialog>

          <div class="hint footer-hint" id="footer-hint" hidden>
            Open Receive on the other device. Turn up this screen's brightness.
          </div>
        </main>

        <!-- ===== 接收（原本的 receive/index.html） ===== -->
        <main class="receiver-shell">
          <section class="receiver-primary">
            <div class="receiver-heading">
              <div>
                <p class="eyebrow">Camera → your device</p>
                <h1>Receive</h1>
              </div>
              <div class="hint status-line" id="stats">Ready to scan a file or text stream</div>
            </div>
            <button id="start">Start camera</button>
            <div class="preview-zone" id="preview" style="display: none">
              <div class="no-signal-toast" id="no-signal" role="status" hidden>
                <span>Nothing happening?</span>
                <button id="no-signal-help" class="text-button" type="button">Help</button>
                <button id="no-signal-dismiss" class="text-button no-signal-dismiss" type="button">Dismiss</button>
              </div>
              <div class="preview">
                <video id="video" muted playsinline></video>
                <canvas id="detect-overlay" class="detect-overlay" aria-hidden="true"></canvas>
                <div class="transfer-hud">
                  <div class="progress-status" id="progress-status" style="display: none" aria-live="polite">
                    <strong id="progress-label">0% · 0 frames</strong>
                    <span id="eta-label">Estimating time…</span>
                  </div>
                  <div
                    class="progress"
                    id="progress"
                    style="display: none"
                    role="progressbar"
                    aria-label="Transfer recovery progress"
                    aria-valuemin="0"
                    aria-valuemax="100"
                    aria-valuenow="0"
                  ><div id="bar"></div></div>
                </div>
              </div>
            </div>
            <div id="result"></div>
            <dialog class="help-dialog" id="no-signal-dialog" aria-labelledby="no-signal-title">
              <h2 id="no-signal-title" tabindex="-1" autofocus>Troubleshooting tips</h2>
              <ul id="no-signal-tips"></ul>
              <button id="no-signal-close" class="secondary-button" type="button">Got it</button>
            </dialog>
            <details class="settings diagnostics" id="diagnostics" style="display: none">
              <summary>Live diagnostics</summary>
              <div class="metrics" id="metrics" style="display: none">
                <div class="metric"><div class="k">capture fps</div><div class="v" id="m-cap">—</div></div>
                <div class="metric"><div class="k">decode fps</div><div class="v amber" id="m-dec">—</div></div>
                <div class="metric"><div class="k">goodput</div><div class="v amber" id="m-rate">—</div></div>
                <div class="metric"><div class="k">elapsed</div><div class="v" id="m-time">—</div></div>
                <div class="metric"><div class="k">frames new/dup</div><div class="v" id="m-frames">—</div></div>
                <div class="metric"><div class="k">blocks K</div><div class="v" id="m-k">—</div></div>
                <div class="metric"><div class="k">block len</div><div class="v" id="m-block">—</div></div>
                <div class="metric"><div class="k">transfer</div><div class="v" id="m-payload">—</div></div>
              </div>
            </details>
            <details class="settings" id="settings">
              <summary>Receive settings</summary>
              <div class="row">
                <label class="camera-pick"><span>camera</span>
                  <select id="cfg-camera"><option value="" selected>auto</option></select>
                </label>
                <label><span>capture width</span>
                  <select id="cfg-width"><option>960</option><option selected>1280</option><option>1920</option><option>2560</option><option>3840</option></select>
                </label>
                <label><span>capture fps</span>
                  <select id="cfg-capfps"><option>30</option><option selected>60</option></select>
                </label>
                <label><span>decode workers</span>
                  <select id="cfg-workers"><option>1</option><option>2</option><option>3</option><option>4</option><option>5</option><option>6</option></select>
                </label>
              </div>
              <label class="check">
                <input type="checkbox" id="cfg-autoshow" checked />
                <span>Show received files automatically</span>
              </label>
              <p class="hint settings-actual" id="camera-actual">Applied when the camera starts.</p>
            </details>
          </section>
        </main>
      </div>
      <!-- ↑↑↑ decimen 的介面結束 ↑↑↑ -->
    </div>
  </div>
</template>

<style scoped>
/*
 * 面板本體：這是一個「頁面」（跟設定頁一樣佔滿整個畫面），不是蓋在內容上面的浮層。
 * 預設藏起來，view 切到 decimen 時才用 .is-open 顯示。
 */
.dt-root {
  display: none;
  flex-direction: column;
  min-height: 100vh;
  background: #070a11;
  color-scheme: dark;
}

.dt-root.is-open {
  display: flex;
}

/* 頂部：傳送／接收切換 + 關閉（往下捲也固定在最上面，跟設定頁的返回列一致） */
.dt-bar {
  position: sticky;
  top: 0;
  z-index: 5;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 8px 8px 12px;
  background: #0d1220;
  border-bottom: 1px solid #1d2740;
  padding-top: max(8px, env(safe-area-inset-top));
}

.dt-tabs {
  display: flex;
  flex: 1;
  gap: 6px;
  min-width: 0;
}

.dt-tab {
  flex: 1;
  min-width: 0;
  padding: 9px 10px;
  border: 1px solid #24304d;
  border-radius: 9px;
  background: transparent;
  color: #9fb0d0;
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}

.dt-tab.on {
  background: #16305a;
  border-color: #3f6fbe;
  color: #eaf1ff;
}

.dt-refresh,
.dt-close {
  flex: none;
  display: grid;
  place-items: center;
  width: 38px;
  height: 38px;
  padding: 0;
  border: 1px solid #24304d;
  border-radius: 9px;
  background: transparent;
  color: #cbd7ee;
  cursor: pointer;
}

.dt-status,
.dt-error {
  margin: 0;
  padding: 8px 14px;
  font-size: 13px;
  text-align: center;
}

.dt-status {
  background: #0f2036;
  color: #a8c6f0;
}

.dt-error {
  background: #35141a;
  color: #ffb3bd;
}

/* 收到別的檔案時的說明與「分享／儲存」 */
.dt-foreign {
  margin: 0;
  padding: 10px 14px;
  background: #1d1a08;
  border-bottom: 1px solid #4a4118;
  color: #f2e2a8;
  text-align: center;
}

.dt-foreign-text {
  margin: 0;
  font-size: 13px;
  line-height: 1.6;
}

.dt-foreign-actions {
  display: flex;
  justify-content: center;
  margin-top: 8px;
}

.dt-btn-primary {
  padding: 9px 18px;
  border: 0;
  border-radius: 9px;
  background: #3f6fbe;
  color: #fff;
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}

.dt-btn-primary:hover {
  background: #4d80d4;
}

.dt-foreign-note {
  margin: 6px 0 0;
  font-size: 12px;
  color: #cbbd8c;
}

/* 內容區（頁面本身就隨文件捲動，這裡不需要再一層自己的捲軸） */
.dt-body {
  flex: 1;
  min-height: 0;
}

/* decimen 的 body 規則是 100vh，縮進面板後改成自然高度 */
#decimen-app {
  min-height: 0;
  padding: 16px 14px calc(24px + env(safe-area-inset-bottom));
}

/*
 * 一次只顯示一半。
 * decimen 的樣式都被縮進 #decimen-app，等於每條都帶一個 id，所以這裡要一起用
 * #decimen-app 才壓得過去（只寫 .send-shell 會被 decimen 自己的規則蓋掉）。
 */
.dt-root.mode-send #decimen-app > .receiver-shell {
  display: none;
}

.dt-root.mode-receive #decimen-app > .send-shell {
  display: none;
}

/*
 * decimen 把 QR 放大到全螢幕時會在自己的 <body> 上掛 qr-full，
 * 那時候連頂部列一起收掉，整個畫面讓給 QR（點 QR 或按 Esc 可以退出全螢幕）。
 */
body.qr-full .dt-bar,
body.qr-full .dt-status,
body.qr-full .dt-error,
body.qr-full .dt-foreign {
  display: none;
}

/* 全螢幕播 QR 時整頁不要跟著捲（畫布是照視窗大小畫的）。
   注意這裡要 :global()：scoped 樣式會在選擇器最後補一個 [data-v-…]，
   而 <body> 不屬於這個元件、沒有那個屬性，写成 body.qr-full 永遠不會生效。 */
:global(body.qr-full) {
  overflow: hidden;
}

body.qr-full .dt-body {
  overflow: hidden;
}

body.qr-full #decimen-app {
  padding: 0;
}
</style>
