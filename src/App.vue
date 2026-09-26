<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import RecordCard from './components/RecordCard.vue'
import { addAlias, blobToBase64, fromBackup, mergeRecords, normalizeName, remapRecords, resolvePersons, toBackup } from './lib/backup.js'
import { clear, del, getAll, put, wipe } from './lib/db.js'
import { compressImage, extFromMime, fileToStored, heicToJpeg, isHeic, readImageTime, sniffImageType, storedToFile } from './lib/image.js'
import { hashFile } from './lib/md5.js'
import {
  findImageOwner,
  imageCount,
  imageHashes,
  MAIN_ID,
  promoteImage,
  recordImages,
  removeImage,
} from './lib/images.js'
import { mergeParsed, parsePaymentText, pickDate, pickDefaultAmount, preloadOcr, recognizePasses } from './lib/ocr.js'
/* 對話框統一走 src/lib/dialog.js（SweetAlert2，樣式在 style.css） */
import { askChecklist, askConfirm, askText, askTextWithList, pickFromList, warn } from './lib/dialog.js'
import {
  keepNoteCategories,
  moveNoteCategory,
  noteKey,
  normalizeNoteCategories,
  removeNoteCategory,
  renameNoteCategory,
  seedNoteCategories,
} from './lib/notes.js'
import { recordCells, recordsToText } from './lib/textExport.js'
import {
  DEFAULT_EXPORT_RULES,
  describeRules,
  EXPORT_FIELDS,
  fieldName,
  findIncomplete,
  incompleteMessage,
  normalizeRules,
} from './lib/validate.js'
import { missingPersonIds, personNameSnapshot, recordsUsingPerson, restoreMissingPersons } from './lib/persons.js'
import { buildShareQuery, fmtDateTime, labelBySource, parseShareParams, safeFileNamePart, searchFromText, shareLinkKey, toAmountText, uid } from './lib/util.js'

/* ---------- 人物 ---------- */
const persons = ref([])
const selfPerson = computed(() => persons.value.find((p) => p.isSelf) ?? null)
const defaultPayerId = computed(() => selfPerson.value?.id ?? persons.value[0]?.id ?? '')

const personDialogEl = ref(null)
const draft = ref({ id: null, name: '', isSelf: false, aliasesText: '' })
const err = ref('')

/**
 * 開人物視窗。
 * showModal() 會自己找第一個可以聚焦的元素（在 iPhone 上就是名稱輸入框），
 * 手機一開就跳鍵盤很干擾，所以焦點改放在對話框本身——用 Tab 還是進得去輸入框。
 */
function openPersonDialog() {
  nextTick(() => {
    const dialog = personDialogEl.value
    dialog?.showModal()
    dialog?.focus?.()
  })
}

function openCreatePerson() {
  draft.value = { id: null, name: '', isSelf: persons.value.length === 0, aliasesText: '' }
  mergeTargetId.value = ''
  err.value = ''
  openPersonDialog()
}

function openEditPerson(person) {
  draft.value = {
    id: person.id,
    name: person.name,
    isSelf: person.isSelf,
    aliasesText: (person.aliases ?? []).join('、'),
  }
  mergeTargetId.value = ''
  err.value = ''
  openPersonDialog()
}

/** 這個人物被記錄用到的次數，分開算付款人與受益人 */
function personUsage(id) {
  let payer = 0
  let beneficiary = 0
  for (const r of records.value) {
    if (r.payerId === id) payer++
    if ((r.beneficiaryIds ?? []).includes(id)) beneficiary++
  }
  return { payer, beneficiary }
}

function parseAliases(text) {
  const seen = new Set()
  const out = []
  for (const part of String(text ?? '').split(/[,，、;；]/)) {
    const clean = part.trim().replace(/\s+/g, ' ')
    const key = normalizeName(clean)
    if (!clean || seen.has(key)) continue
    seen.add(key)
    out.push(clean)
  }
  return out
}

function savePerson() {
  const name = draft.value.name.trim()
  if (!name) return (err.value = '請輸入名稱')

  const aliases = parseAliases(draft.value.aliasesText).filter(
    (a) => normalizeName(a) !== normalizeName(name),
  )

  /* 名字與別名是匯入時的比對依據，不能有兩個人搶同一個寫法 */
  const keys = new Set([name, ...aliases].map(normalizeName))
  const clash = persons.value.some(
    (p) =>
      p.id !== draft.value.id &&
      [p.name, ...(p.aliases ?? [])].some((n) => keys.has(normalizeName(n))),
  )
  if (clash) return (err.value = '這個名字或別名已經有其他人物在用了')

  if (draft.value.isSelf) persons.value.forEach((p) => (p.isSelf = false))

  if (draft.value.id) {
    Object.assign(persons.value.find((p) => p.id === draft.value.id), {
      name,
      isSelf: draft.value.isSelf,
      aliases,
    })
  } else {
    persons.value.push({ id: uid(), name, isSelf: draft.value.isSelf, aliases })
  }
  personDialogEl.value.close()

  /* 如果是因為「還沒有自己」才被叫來新增人物，補完就繼續原本的動作 */
  const action = pendingAction
  pendingAction = null
  if (action && persons.value.some((p) => p.isSelf)) action()
}

async function removePerson(person) {
  /* 記錄還在用他（付錢人或受益人）就不能刪，不然那些記錄會變成找不到人 */
  const used = recordsUsingPerson(records.value, person.id)
  if (used.length) {
    const { payer, beneficiary } = personUsage(person.id)
    await warn(
      `「${person.name}」不能刪除`,
      `還有 ${used.length} 筆記錄用到（付款人 ${payer} 筆、受益人 ${beneficiary} 筆）。\n` +
        '如果不再需要這位，請先把那些記錄改成別人。',
    )
    return
  }

  const ok = await askConfirm({
    title: `確定要刪除「${person.name}」嗎？`,
    text: '這位人物沒有被任何記錄用到，刪除後不會影響現有記錄。',
    confirmText: '刪除',
    icon: 'warning',
  })
  if (!ok) return

  persons.value = persons.value.filter((p) => p.id !== person.id)
  /* 保險：記錄裡指向他的欄位也要清掉，避免留下無效的 id */
  records.value.forEach((r) => {
    if (r.payerId === person.id) r.payerId = defaultPayerId.value
    r.beneficiaryIds = r.beneficiaryIds.filter((id) => id !== person.id)
  })
}

/* 人物列上的「N 筆」標籤：一眼看出誰被記錄用到（也就不能刪） */
const usedCount = (person) => recordsUsingPerson(records.value, person.id).length

/*
 * iPhone：在畫面上連點兩下，Safari 會把整個畫面放大。
 * touch-action: manipulation 在 Safari 只認手指底下那一個元素（不會往上找），
 * 遇到 disabled 的按鈕或某些非互動元素時還是照樣放大，所以這裡統一處理：
 * 「同一個位置在 350 毫秒內被點第二下」就把那一下的預設行為擋掉。
 * 有滑動過（捲動結束順手點一下）、或手指不只一隻（雙指縮放）都不算，
 * 正常操作不會被吃掉。
 */
const DOUBLE_TAP_MS = 350
const DOUBLE_TAP_PX = 24
let lastTap = { at: 0, x: 0, y: 0 }
let gestureMoved = false
/* 預設 1：真的收到 touchstart 才會被改寫，這樣少收到一個事件也不會整組失效 */
let gestureTouches = 1

function onTouchStart(event) {
  gestureMoved = false
  gestureTouches = event.touches?.length ?? 1
}

/*
 * 兩件事：
 *   1. 標記「這一下有滑動」（捲動結束順手點一下不算連點）
 *   2. 兩指以上＝雙指縮放：整頁一律擋掉，只有「看圖」那張圖例外
 *      （touch-action 在 iOS 上不一定擋得住，直接 preventDefault 最實在）
 */
function onTouchMove(event) {
  gestureMoved = true
  if ((event.touches?.length ?? 0) > 1 && !event.target?.closest?.('.viewer')) {
    event.preventDefault()
  }
}

function onTouchEnd(event) {
  const touch = event.changedTouches?.[0]
  const now = Date.now()
  const gap = now - lastTap.at
  const sameSpot =
    !!touch &&
    Math.abs(touch.clientX - lastTap.x) <= DOUBLE_TAP_PX &&
    Math.abs(touch.clientY - lastTap.y) <= DOUBLE_TAP_PX
  const isTap =
    !gestureMoved &&
    gestureTouches <= 1 &&
    (event.changedTouches?.length ?? 0) === 1 &&
    (event.touches?.length ?? 0) === 0

  /* 只有「乾淨的一下」才記成上一次點擊，滑動結束那一下不算 */
  if (isTap && touch) lastTap = { at: now, x: touch.clientX, y: touch.clientY }
  if (!isTap || !sameSpot || gap > DOUBLE_TAP_MS) return
  event.preventDefault()
}

/*
 * 手動套用分享連結：貼上的內容會存在本機（settings 的 shareLinkText），
 * 使用者沒有改的話就一直在輸入框裡，連「重置」也不會清掉。
 */
const linkInput = ref('')

function applyLinkInput() {
  const search = searchFromText(linkInput.value)
  const { names, currency, notes } = parseShareParams(search)
  if (!names.length && !currency && !notes.length) {
    backupNotice.value =
      '這個連結裡沒有可用的人物、幣別或備注分類。要像這樣：…?persons=Vincent,Ben&currency=CNY&notes=吃_早餐'
    return
  }

  const result = applyShareParams(search, true)
  if (!result.added.length && !result.currencySet && !result.notesAdded.length) {
    backupNotice.value = `連結裡的內容都已經有了（${[...names, currency, ...notes].filter(Boolean).join('、')}）`
  }
}

/**
 * 生成分享連結：把「現在的人物、預設幣別、備注分類」做成連結，
 * 填進下面的框（可以自己再改或複製）並順便複製到剪貼簿。
 */
async function generateShareLink() {
  const query = buildShareQuery({
    persons: persons.value,
    currency: defaultCurrency.value,
    notes: noteCategories.value,
  })
  if (!query) {
    warn('還沒有可以分享的內容', '先新增人物、選預設幣別或建立備注分類，再按「生成」。')
    return
  }
  const url = `${location.origin}${location.pathname}?${query}`
  linkInput.value = url
  const { names, currency, notes } = parseShareParams(`?${query}`)
  const parts = [
    names.length ? `${names.length} 位人物` : '',
    currency ? `幣別 ${currency}` : '',
    notes.length ? `${notes.length} 個備注分類` : '',
  ].filter(Boolean)
  let copied = false
  try {
    await navigator.clipboard.writeText(url)
    copied = true
  } catch {
    /* 沒有 https 或沒有權限：還是把連結留在框裡讓使用者自己複製 */
  }
  backupNotice.value =
    `已生成連結（${parts.join('、')}）${copied ? '並複製到剪貼簿' : '，請從下面的框複製'}。`
}

/**
 * 複製分享連結：把框裡的內容複製到剪貼簿（框裡沒東西就提示先「生成」或貼上）。
 */
async function copyShareLink() {
  const text = linkInput.value.trim()
  if (!text) {
    warn('框裡還沒有連結', '先按「生成」做一個，或貼上別人給你的分享連結，再按「複製」。')
    return
  }
  try {
    await navigator.clipboard.writeText(text)
    backupNotice.value = '已複製分享連結到剪貼簿。'
  } catch {
    backupNotice.value = '這個瀏覽器不能自動複製（Web Share／剪貼簿要 https 或 localhost），請長按上面的框自己複製。'
  }
}

/* ---------- 還沒有「自己」就先問 ---------- */
const selfDialogEl = ref(null)
const selfChoice = ref('')
let pendingAction = null

/** 上傳圖片、貼上圖片、新增記錄之前都要先確定「自己」是誰 */
function requireSelf(action) {
  if (persons.value.some((p) => p.isSelf)) {
    action()
    return
  }

  pendingAction = action
  if (!persons.value.length) {
    /* 連人物都沒有，先新增；第一個人物預設就會勾「這是我自己」 */
    openCreatePerson()
    return
  }

  selfChoice.value = ''
  nextTick(() => selfDialogEl.value.showModal())
}

function confirmSelf() {
  const chosen = persons.value.find((p) => p.id === selfChoice.value)
  if (!chosen) return

  persons.value.forEach((p) => (p.isSelf = false))
  chosen.isSelf = true
  /* 之前還沒有「自己」時建立的記錄，付錢人是空的，一起補上 */
  records.value.forEach((r) => {
    if (!r.payerId) r.payerId = chosen.id
  })

  selfDialogEl.value.close()
  const action = pendingAction
  pendingAction = null
  action?.()
}

/* 取消（或按 Esc 關掉）就放棄原本的動作 */
function onSelfDialogClose() {
  if (!pendingAction) return
  pendingAction = null
  backupNotice.value = '已取消：請先設定誰是「自己」'
}

/* ---------- 合併重複的人物（放在「修改人物」的視窗裡） ---------- */
const mergeTargetId = ref('')
const otherPersons = computed(() => persons.value.filter((p) => p.id !== draft.value.id))

/** 把正在修改的這個人合併到選好的另一個人 */
async function mergeInto() {
  const source = persons.value.find((p) => p.id === draft.value.id)
  const target = persons.value.find((p) => p.id === mergeTargetId.value)
  if (!source || !target) return

  /*
   * 原生 <dialog showModal> 在最上層，SweetAlert2 是普通元素，開著的話會被蓋住，
   * 所以先關掉修改視窗再問；取消就把它開回來。
   */
  personDialogEl.value?.close()

  const ok = await askConfirm({
    title: `把「${source.name}」合併到「${target.name}」？`,
    text:
      `記錄裡的付款人與受益人都會改成「${target.name}」，` +
      `「${source.name}」會變成別名，之後匯入同樣的寫法會自動對上。合併後無法復原。`,
    confirmText: '合併',
    icon: 'warning',
  })
  if (!ok) {
    /* 取消就回到修改視窗，讓使用者可以改別的 */
    openPersonDialog()
    return
  }

  records.value.forEach((r) => {
    if (r.payerId === source.id) r.payerId = target.id
    r.beneficiaryIds = [...new Set(r.beneficiaryIds.map((id) => (id === source.id ? target.id : id)))]
  })

  /* 被合併的名字與它的別名，全部變成目標人物的別名 */
  addAlias(target, source.name)
  for (const alias of source.aliases ?? []) addAlias(target, alias)
  if (source.isSelf) target.isSelf = true
  persons.value = persons.value.filter((p) => p.id !== source.id)

  personDialogEl.value.close()
  backupNotice.value = `已把「${source.name}」合併到「${target.name}」`
}

/* ---------- 記錄 ---------- */
const records = ref([])
const fileInputEl = ref(null)
const storageError = ref('')

let seqCounter = 0
const nextSeq = () => ++seqCounter
const stamp = () => fmtDateTime(Date.now()).replace(/[-: ]/g, '')

/*
 * 手動新增的記錄標題：手動新增1、手動新增2…
 * 號碼照「建立順序」重新排：刪掉中間那一筆，後面的會往前補
 * （1、2、3、4 刪掉 2 → 變成 1、2、3；下一個新增的是 4），見 renumberManualRecords。
 */
const MANUAL_PREFIX = '手動新增'
let manualCounter = 0
const MANUAL_NAME_RE = /^手動新增([0-9]+)$/
const nextManualName = () => `${MANUAL_PREFIX}${++manualCounter}`

/** 把「手動新增」的記錄照建立順序重新編號（刪除後補號碼、舊資料也順一次） */
function renumberManualRecords() {
  const manuals = records.value
    .filter((r) => MANUAL_NAME_RE.test(r.fileName ?? ''))
    .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
  manuals.forEach((r, i) => {
    const name = `${MANUAL_PREFIX}${i + 1}`
    if (r.fileName !== name) r.fileName = name
  })
  manualCounter = manuals.length
}

/* 預設幣別：還沒上傳任何圖片也可以先選 */
const STANDARD_CURRENCIES = ['CNY', 'MOP', 'HKD', 'USD', 'TWD', 'JPY', 'EUR', 'GBP', 'SGD', 'AUD']
const defaultCurrency = ref('')
const currencyOptions = computed(() => {
  const set = new Set(STANDARD_CURRENCIES)
  records.value.forEach((r) => r.amounts?.forEach((a) => a.currency && set.add(a.currency)))
  return [...set].sort()
})

/* 自己上傳與手動新增的記錄，來源名稱 */
const DEFAULT_SOURCE = '本機'

function baseRecord() {
  return {
    id: uid(),
    seq: nextSeq(),
    /* 這筆記錄加進 App 的時間（記錄卡片上顯示的「剛剛／幾分鐘前」就是用它） */
    createdAt: Date.now(),
    source: DEFAULT_SOURCE,
    hash: '',
    fileName: '',
    file: null,
    url: '',
    fileTime: 0,
    fileTimeSource: 'file',
    ocrStatus: 'none',
    ocrProgress: 0,
    ocrText: '',
    ocrError: '',
    amounts: [],
    currency: '',
    currencyLocked: false,
    amount: '',
    paidAtText: '',
    paidAtManual: false,
    /* 鎖定：欄位、受益人、重新辨識、補圖全部停用（圖片還是可以放大看） */
    locked: false,
    /* 鎖定過一次之後，「這張圖有多個金額，用哪一個？」就不再出現 */
    amountChooserOff: false,
    /* 同一個記錄的其他圖片（主要圖片在 file／url，這裡放後期補上的） */
    extraImages: [],
    payerId: defaultPayerId.value,
    beneficiaryIds: [],
    note: '',
  }
}

function newRecord(file, time, hash) {
  return {
    ...baseRecord(),
    hash,
    fileName: file.name,
    file,
    url: URL.createObjectURL(file),
    fileTime: time.ms,
    fileTimeSource: time.source,
    ocrStatus: 'pending',
  }
}

/**
 * 沒有圖片也能先開一筆，金額與時間自己填。
 * 付款時間一開始就等於「建立這筆的時間」，使用者再自己改。
 */
function addBlankRecord() {
  requireSelf(() => {
    const rec = baseRecord()
    rec.fileName = nextManualName()
    rec.paidAtText = fmtDateTime(rec.createdAt)
    records.value.push(rec)
  })
}

const revoke = (url) => {
  if (url) URL.revokeObjectURL(url)
}

/**
 * 分享連結帶入人物與幣別，例如：
 *   /?persons=Vincent,Ben,Ken&currency=CNY
 * 已經有的人（含別名比對）直接沿用，不會重複建立。
 * 同一組名單只套用一次：之後使用者就算把人物刪掉，重新整理也不會自動加回來
 * （要重新套用同一個連結，得先按「重置」把資料清掉）。
 */
/**
 * 網址上的參數來源。
 * iOS 把網站加到主畫面時只會保留 start_url（見 manifest.json 的說明），
 * 一般查詢字串有可能整個不見，所以 `#` 後面寫的參數也一起支援，
 * 讓分享連結有第二種寫法可以試。
 */
function shareSearch() {
  if (window.location.search) return window.location.search
  const hash = window.location.hash.replace(/^#/, '')
  return hash.includes('=') ? `?${hash}` : ''
}

/**
 * 套用分享連結裡的參數（新增缺少的人物、設定預設幣別）。
 * 已經有的人（含別名比對）直接沿用，不會重複建立。
 * 同一組名單預設只套用一次：之後使用者就算把人物刪掉，重新整理也不會自動加回來
 * （force = true 是使用者自己按「套用」時用的，那時就以他的意思為準）。
 */
function applyShareParams(search = shareSearch(), force = false) {
  const { names, currency, notes } = parseShareParams(search)
  if (!names.length && !currency && !notes.length) {
    return { added: [], currencySet: '', notesAdded: [], skipped: true }
  }

  /* 這組名單之前套用過就不再動作，才不會把使用者刪掉的人物加回來 */
  const key = shareLinkKey(names)
  if (key && appliedLinks.includes(key) && !force) {
    return { added: [], currencySet: '', notesAdded: [], skipped: true }
  }

  const added = []
  for (const name of names) {
    const exists = persons.value.some((p) =>
      [p.name, ...(p.aliases ?? [])].some((n) => normalizeName(n) === normalizeName(name)),
    )
    if (exists) continue
    /* 連結不預設誰是「自己」，等使用者上傳或新增記錄時再問 */
    persons.value.push({ id: uid(), name, isSelf: false, aliases: [] })
    added.push(name)
  }

  /* 連結帶進來的備注分類：標成 link，重置時永遠保留 */
  const notesAdded = []
  for (const note of notes) {
    const exists = noteCategories.value.some((c) => noteKey(c.text) === noteKey(note))
    if (exists) continue
    noteCategories.value.push({ text: note, link: true })
    notesAdded.push(note)
  }

  let currencySet = ''
  if (currency && currency !== defaultCurrency.value) {
    defaultCurrency.value = currency
    applyDefaultCurrency()
    currencySet = currency
  }

  const bits = []
  if (added.length) bits.push(`新增人物 ${added.join('、')}`)
  if (notesAdded.length) bits.push(`新增備注分類 ${notesAdded.join('、')}`)
  if (currencySet) bits.push(`預設幣別設為 ${currencySet}`)
  if (bits.length) backupNotice.value = `從連結套用：${bits.join('、')}`

  if (key) {
    /* 只留最近 20 組，免得一直累積 */
    appliedLinks = [...appliedLinks, key].slice(-20)
    put('settings', { id: 'appliedShareLinks', value: appliedLinks }).catch(() => {})
  }
  return { added, currencySet, notesAdded, skipped: false }
}

/* 已經套用過的分享連結名單（存在本機，「重置」時會一起清掉） */
let appliedLinks = []

/* ---------- 備注的分類（常用字串） ---------- */
const noteCategories = ref(seedNoteCategories())

/** 這個備注存成常用分類（已經有就什麼都不做） */
function addNoteCategory(text) {
  const clean = String(text ?? '').trim()
  if (!clean) return false
  if (noteCategories.value.some((c) => noteKey(c.text) === noteKey(clean))) return false
  noteCategories.value.push({ text: clean, link: false })
  return true
}

/** 從記錄卡片按「＋ 常用」 */
function onSaveNoteCategory(text) {
  const clean = String(text ?? '').trim()
  if (!clean) {
    backupNotice.value = '備注是空的，先打點字再存成常用。'
    return
  }
  const added = addNoteCategory(clean)
  backupNotice.value = added ? `已把「${clean}」存成常用的備注分類` : `「${clean}」已經在常用的備注分類裡了`
}

/** 從記錄卡片按「分類」：使用者挑一個填進那一筆的備注 */
async function onPickNoteCategory(record) {
  if (!noteCategories.value.length) {
    await warn('還沒有備注分類', '先在某筆記錄的備注打字，再按「＋ 常用」，分類就會出現在這裡。')
    return
  }
  const chosen = await pickFromList({
    title: '選一個備注分類',
    options: noteCategories.value.map((c) => c.text),
  })
  if (chosen !== null) record.note = chosen
}

/* ---------- 設定頁（整頁切換） ---------- */
const view = ref('main')
const newCategory = ref('')
const storageInfo = ref({ usage: 0, quota: 0, persisted: false })
const offlineReady = ref(false)
const buildTime = typeof __BUILD_TIME__ === 'string' ? __BUILD_TIME__ : ''
const buildTimeText = buildTime
  ? fmtDateTime(new Date(buildTime).getTime())
  : '（開發模式沒有建置時間）'

/*
 * 設定頁＝同一個頁面換一個畫面，所以手機的「返回手勢」（iOS 從左邊緣往右滑）
 * 與 Android 的系統返回鍵原本會直接離開整個 App。
 * 開設定頁時自己補一筆歷史記錄，返回手勢／返回鍵就會回到主畫面。
 */
const SETTINGS_STATE = 'settings'

const openSettings = async () => {
  if (view.value === 'settings') return
  view.value = 'settings'
  newCategory.value = ''
  window.scrollTo({ top: 0 })
  try {
    history.pushState({ [SETTINGS_STATE]: true }, '')
  } catch {
    /* 不能操作歷史記錄（例如無網址的環境）不影響看設定 */
  }
  await Promise.all([loadStorageInfo(), loadOfflineState()])
}

/* ---------- 設定頁 ---------- */
/*
 * 設定頁的說明文字平常只顯示一行（超出用 … 收掉），點一下才展開看全部。
 * 群組裡那句「這一組有 X 個欄位…」是動態資訊，不套用這個行為。
 */
function toggleHint(event) {
  const hint = event.target?.closest?.('.view-settings .hint')
  if (!hint || hint.closest('.rule-group')) return
  hint.classList.toggle('open')
}

/** 這台裝置現在是不是已經可以用離線（Service Worker 已經接管） */
async function loadOfflineState() {
  try {
    if (!('serviceWorker' in navigator)) {
      offlineReady.value = false
      return
    }
    if (navigator.serviceWorker.controller) {
      offlineReady.value = true
      return
    }
    const reg = await navigator.serviceWorker.getRegistration()
    offlineReady.value = !!reg?.active
  } catch {
    offlineReady.value = false
  }
}

const closeSettings = () => {
  /* 有自己補的那筆歷史記錄就退回去（讓 popstate 負責切畫面） */
  if (history.state?.[SETTINGS_STATE]) {
    history.back()
    return
  }
  view.value = 'main'
  window.scrollTo({ top: 0 })
}

/* 返回手勢／返回鍵：切回主畫面就好，不要離開整個 App */
function onPopState() {
  const wantSettings = !!history.state?.[SETTINGS_STATE]
  if ((view.value === 'settings') === wantSettings) return
  view.value = wantSettings ? 'settings' : 'main'
  window.scrollTo({ top: 0 })
  if (wantSettings) Promise.all([loadStorageInfo(), loadOfflineState()])
}

async function loadStorageInfo() {
  try {
    const estimate = await navigator.storage?.estimate?.()
    storageInfo.value = {
      usage: estimate?.usage ?? 0,
      quota: estimate?.quota ?? 0,
      persisted: (await navigator.storage?.persisted?.()) ?? false,
    }
  } catch {
    /* 拿不到就顯示 0，不影響使用 */
  }
}

const mb = (bytes) => (bytes ? `${(bytes / 1048576).toFixed(1)} MB` : '0 MB')

function addCategoryFromInput() {
  const text = newCategory.value.trim()
  if (!text) return
  const added = addNoteCategory(text)
  newCategory.value = ''
  backupNotice.value = added ? `已新增分類「${text}」` : `「${text}」已經在分類清單裡了`
}

async function renameCategory(text) {
  const next = await askText({
    title: '重新命名分類',
    text: '只會改清單裡的名字，已經填在記錄備注上的文字不會跟著改。',
    value: text,
    placeholder: '分類名稱',
  })
  if (next === null) return
  const result = renameNoteCategory(noteCategories.value, text, next)
  if (result === null) {
    await warn('改不了', '名稱不能空白，也不能跟其他分類重複。')
    return
  }
  noteCategories.value = result
}

async function deleteCategory(text) {
  const ok = await askConfirm({
    title: `刪除分類「${text}」？`,
    text: '只會從常用清單移除；已經填在記錄備注上的文字不會被改掉。',
    confirmText: '刪除',
    icon: 'warning',
  })
  if (!ok) return
  noteCategories.value = removeNoteCategory(noteCategories.value, text)
}

const moveCategory = (index, delta) => {
  noteCategories.value = moveNoteCategory(noteCategories.value, index, delta)
}

/* ---------- 記錄的選取（點一下外框亮起來）與「幾分鐘前」 ---------- */
const selectedId = ref('')

const selectRecord = (record) => {
  selectedId.value = record?.id ?? ''
}

/*
 * 點畫面空白的地方就取消選取。對話框（看圖、SweetAlert2）裡面的點擊不算，
 * 所以看完圖關掉之後，原本亮起來的那一筆還是亮的。
 */
function onPageClick(event) {
  const target = event.target
  if (target?.closest?.('.rec, .plain-table tbody tr, dialog, .swal2-container')) return
  selectedId.value = ''
}

/* 每半分鐘更新一次，卡片上的「剛剛／幾分鐘前」才會自己往前走 */
const nowMs = ref(Date.now())
const nowTimer = setInterval(() => (nowMs.value = Date.now()), 30000)

/* ---------- 普通文字模式（只影響「付款記錄」那一區） ---------- */
const plainMode = ref(false)
const plainRows = computed(() => recordCells(records.value, persons.value))

function togglePlainMode() {
  plainMode.value = !plainMode.value
  backupNotice.value = plainMode.value
    ? '已切換成普通文字模式，按「返回」就會看到（點欄位可以直接改）'
    : '已切換回正常模式，按「返回」就會看到'
}

/* ---------- 顏色：鎖定框線與選取外框可以自己選 ---------- */
const COLOR_PRESETS = [
  { hex: '#e07297', name: '玫瑰粉' },
  { hex: '#2f6f4e', name: '森林綠' },
  { hex: '#2f6fb0', name: '海藍' },
  { hex: '#7a52c7', name: '紫' },
  { hex: '#c8860a', name: '琥珀' },
  { hex: '#a5342c', name: '磚紅' },
  { hex: '#4a4f46', name: '墨灰' },
]
const DEFAULT_LOCK_COLOR = '#e07297'
const DEFAULT_PICK_COLOR = '#2f6f4e'

const lockColor = ref(DEFAULT_LOCK_COLOR)
const pickColor = ref(DEFAULT_PICK_COLOR)
/* 輸入框裡的字（按 Enter 或離開欄位才套用，打錯就還原） */
const lockDraft = ref(DEFAULT_LOCK_COLOR)
const pickDraft = ref(DEFAULT_PICK_COLOR)
const badColor = ref('')

/** `#rgb`／`#rrggbb`（# 可以省略）才收，其他一律當成沒填 */
function normalizeHex(value) {
  const text = String(value ?? '').trim()
  if (!/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.test(text)) return ''
  const hex = text.replace('#', '').toLowerCase()
  return `#${hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex}`
}

/** 把顏色往白色（淡）或黑色（深）混，用來做 soft／dark 兩個附屬色 */
function mixHex(hex, target, ratio) {
  const from = parseInt(hex.slice(1), 16)
  const to = parseInt(target.slice(1), 16)
  const part = (shift) => {
    const a = (from >> shift) & 255
    const b = (to >> shift) & 255
    return Math.round(a * (1 - ratio) + b * ratio)
      .toString(16)
      .padStart(2, '0')
  }
  return `#${part(16)}${part(8)}${part(0)}`
}

/*
 * 直接改 :root 上的 CSS 變數，卡片（RecordCard.vue）、表格與對話框都吃得到。
 * 選回預設色時把變數移除，讓 style.css 原本的值生效（外觀跟以前完全一樣）。
 */
function applyColors() {
  const root = document.documentElement
  const set = (name, value) => (value ? root.style.setProperty(name, value) : root.style.removeProperty(name))
  const lock = lockColor.value
  const lockIsDefault = lock === DEFAULT_LOCK_COLOR
  set('--lock', lockIsDefault ? '' : lock)
  set('--lock-dark', lockIsDefault ? '' : mixHex(lock, '#000000', 0.22))
  set('--lock-soft', lockIsDefault ? '' : mixHex(lock, '#ffffff', 0.88))
  const pick = pickColor.value
  const pickIsDefault = pick === DEFAULT_PICK_COLOR
  set('--pick', pickIsDefault ? '' : pick)
  set('--pick-soft', pickIsDefault ? '' : mixHex(pick, '#ffffff', 0.88))
}

watch(
  [lockColor, pickColor],
  () => {
    lockDraft.value = lockColor.value
    pickDraft.value = pickColor.value
    applyColors()
  },
  { immediate: true },
)

/** 輸入框套用：合法就直接用，不合法就提示並還原成目前用的顏色 */
function applyColorDraft(which) {
  const draft = which === 'lock' ? lockDraft : pickDraft
  const color = which === 'lock' ? lockColor : pickColor
  const hex = normalizeHex(draft.value)
  if (!hex) {
    badColor.value = which
    draft.value = color.value
    return
  }
  badColor.value = ''
  color.value = hex
}

/**
 * 普通文字模式：點表格裡的欄位就直接改那一筆（沒有其他按鈕）。
 * 付錢人＝單選、受益人＝多選、金額／備注／付款時間＝輸入。
 */
async function editPlainCell(record, key) {
  if (!record) return
  /* 鎖定的記錄不能改：先問要不要解除，解除後接著做原本要做的動作 */
  if (record.locked && !(await unlockToEdit(record))) return

  if (key === 'payer') {
    const chosen = await pickFromList({
      title: '付錢人',
      options: persons.value.map((p) => p.name),
      confirmText: '清除',
    })
    if (chosen === null) return
    const hit = persons.value.find((p) => p.name === chosen)
    record.payerId = hit ? hit.id : ''
    return
  }

  if (key === 'beneficiaries') {
    if (!persons.value.length) {
      await warn('還沒有人物', '先到上面的「人物」新增人物，才能選受益人。')
      return
    }
    const picked = await askChecklist({
      title: '受益人（可多選）',
      confirmText: '套用',
      icon: 'question',
      selectAll: true,
      options: persons.value.map((p) => ({
        key: p.id,
        label: p.name,
        checked: (record.beneficiaryIds ?? []).includes(p.id),
      })),
    })
    if (picked === null) return
    record.beneficiaryIds = persons.value.filter((p) => picked[p.id]).map((p) => p.id)
    return
  }

  if (key === 'amount') {
    const next = await askText({
      title: '金額',
      text: '只收數字（需要小數點也可以打）。',
      value: record.amount ?? '',
      placeholder: '0.00',
    })
    if (next === null) return
    record.amount = toAmountText(next)
    return
  }

  if (key === 'note') {
    const next = await askTextWithList({
      title: '備注',
      value: record.note ?? '',
      placeholder: '例如：停車費(15:14)',
      options: noteCategories.value.map((c) => c.text),
    })
    if (next === null) return
    record.note = next.trim()
    return
  }

  if (key === 'time') {
    const next = await askText({
      title: '付款時間',
      text: '格式：YYYY-MM-DD HH:mm（可以留空）',
      value: record.paidAtText ?? '',
      placeholder: '2026-08-02 15:23',
    })
    if (next === null) return
    record.paidAtText = next.trim()
    record.paidAtManual = true
  }
}

/* ---------- 匯出前檢查必填欄位 ---------- */
/*
 * 匯出（JSON 備份與設定頁的 .txt）之前先看每一筆有沒有填完：
 * 付錢人、受益人、錢是必填，付款時間與備注則二選一。
 * 「複製文字」不檢查（只是複製到剪貼簿，不算正式匯出）。
 * 不想每次檢查的人可以在設定頁把「匯出前先檢查」關掉。
 */
const checkBeforeExport = ref(true)

/* 要檢查哪些欄位（使用者可以在設定頁改） */
const exportRules = ref(normalizeRules(null))

/** 目前規則的一句話說明 */
const exportRuleSummary = computed(() => describeRules(exportRules.value))

/** 有勾選的欄位（N選M 群組只挑得到這些） */
const exportCheckedFields = computed(() =>
  EXPORT_FIELDS.filter((f) => exportRules.value.checked.includes(f.key)),
)

/** 這個欄位被哪些群組用到（被用到就由群組決定要填幾個，不再個別要求） */
const groupsUsingField = (key) =>
  exportRules.value.groups.filter((g) => g.fields.includes(key)).length

const isFieldChecked = (key) => exportRules.value.checked.includes(key)

/** 勾選／取消一個欄位；取消時要把它從所有 N選M 群組移除 */
function toggleFieldChecked(key, on) {
  if (on) {
    if (!exportRules.value.checked.includes(key)) exportRules.value.checked.push(key)
    return
  }
  exportRules.value.checked = exportRules.value.checked.filter((k) => k !== key)
  exportRules.value.groups = exportRules.value.groups
    .map((g) => ({ ...g, fields: g.fields.filter((f) => f !== key) }))
    .filter((g) => g.fields.length > 0)
}

/** 增加一個 N選M 群組（可以加很多個） */
function addRuleGroup() {
  exportRules.value.groups.push({ id: uid(), fields: [], min: 1 })
}

function removeRuleGroup(group) {
  exportRules.value.groups = exportRules.value.groups.filter((g) => g.id !== group.id)
}

function toggleGroupField(group, key, on) {
  const target = exportRules.value.groups.find((g) => g.id === group.id)
  if (!target) return
  if (on && !target.fields.includes(key)) target.fields.push(key)
  if (!on) target.fields = target.fields.filter((k) => k !== key)
  /* 欄位變少時，最少要填的數量不能超過欄位數 */
  target.min = Math.min(Math.max(1, target.min), Math.max(1, target.fields.length))
}

function setGroupMin(group, value) {
  const target = exportRules.value.groups.find((g) => g.id === group.id)
  if (!target) return
  const max = Math.max(1, target.fields.length)
  target.min = Math.min(Math.max(1, Number(value) || 1), max)
}

/** 有幾筆會被檢查（沒被設成「不用檢查」的） */
const exportCheckedCount = computed(() => records.value.filter((r) => r.checkExport !== false).length)

/** 單筆要不要檢查 */
function setExportCheck(record, checked) {
  record.checkExport = checked
}

const setAllExportCheck = (checked) => {
  records.value.forEach((r) => (r.checkExport = checked))
}

/** DEFAULT：回到原本的規則（付錢人／受益人／錢必填，付款時間與備注二選一），並把所有記錄都設回要檢查 */
async function resetExportRules() {
  exportRules.value = normalizeRules(null)
  records.value.forEach((r) => (r.checkExport = true))
  backupNotice.value = '匯出前檢查已回到預設：付錢人、受益人、錢必填，付款時間與備注二選一'
}

/** 通過回傳 true；有缺就跳出清單並回傳 false */
async function exportAllowed() {
  if (!checkBeforeExport.value) return true
  const bad = findIncomplete(records.value, (r) => seqLabels.value.get(r.id) ?? r.fileName, exportRules.value)
  if (!bad.length) return true
  await warn(
    `有 ${bad.length} 筆還沒填完`,
    `下面這些記錄少了要檢查的欄位（目前規則是「${describeRules(exportRules.value)}」）：\n\n` +
      `${incompleteMessage(bad)}\n\n` +
      '補齊之後再匯出就不會看到這個訊息；也可以到「設定」調整要檢查哪些欄位、或把某幾筆設成不用檢查。',
  )
  return false
}

/* ---------- 匯出文字（只文字、不含圖片） ---------- */
const recordsText = () => recordsToText(records.value, persons.value)

function textFileName(ext = 'txt') {
  return ['付款記錄', safeFileNamePart(selfPerson.value?.name), stamp(), '文字']
    .filter(Boolean)
    .join('-')
    .concat(`.${ext}`)
}

async function exportTextOnly() {
  if (!records.value.length) {
    warn('還沒有記錄', '目前沒有任何付款記錄可以匯出。')
    return
  }
  if (!(await exportAllowed())) return
  const fileName = textFileName()
  const file = new File([recordsText()], fileName, { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(file)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
  backupNotice.value = `已匯出 ${records.value.length} 筆的文字（不含圖片）→ ${fileName}`
}

async function copyTextOnly() {
  if (!records.value.length) {
    warn('還沒有記錄', '目前沒有任何付款記錄可以複製。')
    return
  }
  const text = recordsText()

  /* 先試剪貼簿 API（https 或加到主畫面的 App 才有），失敗再退回舊寫法 */
  try {
    await navigator.clipboard.writeText(text)
    backupNotice.value = `已複製 ${records.value.length} 筆的文字，可以直接貼到 Excel 或記事本`
    return
  } catch {
    /* 繼續往下試 */
  }

  try {
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.top = '-1000px'
    document.body.appendChild(area)
    area.select()
    const ok = document.execCommand('copy')
    area.remove()
    if (ok) {
      backupNotice.value = `已複製 ${records.value.length} 筆的文字`
      return
    }
  } catch {
    /* 繼續往下 */
  }

  /* 都不行就把文字顯示出來讓使用者自己長按複製 */
  await Swal.fire({
    title: '複製這段文字',
    html: `<textarea class="copy-area" readonly>${text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')}</textarea>`,
    confirmButtonText: '關閉',
    customClass: { popup: 'copy-popup' },
  })
}

const actionNotice = ref('')

/* 每筆記錄左邊的「來源-序號」，序號依來源各自從 1 開始 */
const sourceOf = (record) => record.source || DEFAULT_SOURCE
const seqLabels = computed(() => labelBySource(records.value, DEFAULT_SOURCE))

/** 重新命名來源：同一個來源的記錄會一起改，改成既有名稱就等於合併 */
/** 重新命名來源：同一個來源的記錄會一起改，改成既有名稱就等於合併 */
async function renameSource(current) {
  const same = records.value.filter((r) => sourceOf(r) === current)
  const target = same.filter((r) => !r.locked)
  if (!target.length) {
    warn('這個來源的記錄都鎖定了', '要改來源名稱，請先解除鎖定。')
    return
  }
  const next = await askText({
    title: '重新命名來源',
    text: `「${current}」的 ${target.length} 筆記錄會一起改。改成已經存在的來源名稱，就等於把兩批合併編號。`,
    value: current,
    placeholder: '來源名稱',
  })
  if (next === null) return
  const name = next.trim().replace(/\s+/g, ' ').slice(0, 40)
  if (!name || name === current) return
  target.forEach((r) => {
    r.source = name
  })
  const lockedCount = same.length - target.length
  backupNotice.value =
    `已把來源「${current}」改名為「${name}」` +
    (lockedCount ? `（有 ${lockedCount} 筆已鎖定，維持原本的來源名稱）` : '')
}

/** 序號上的重新命名：鎖定的要先解除才能改（正常模式與純文字模式都走這裡） */
async function renameSourceFrom(record) {
  if (record?.locked && !(await unlockToEdit(record))) return
  await renameSource(record?.source || DEFAULT_SOURCE)
}

function dismissNotices() {
  actionNotice.value = ''
}

/**
 * 這個瀏覽器解不開的圖先擋下來，不要建出縮圖破圖、也辨識不了的記錄。
 * 最常見的來源是 iPhone 相機的 HEIC——只有 Safari 17+ 能解。
 */
async function canDecode(file) {
  if (typeof createImageBitmap !== 'function') return true
  try {
    const bitmap = await createImageBitmap(file)
    bitmap.close?.()
    return true
  } catch {
    return false
  }
}

/** 所有圖片來源（選檔、貼上）都走這裡 */
async function addFiles(files) {
  const incoming = (files ?? []).filter(Boolean)
  if (!incoming.length) return 0

  /*
   * iOS 貼上圖片時，Blob 的 type 可能是 **UTI**（public.jpeg）或空的，
   * 用 type.startsWith('image/') 過濾會把圖整批丟掉（而且無聲）。
   * 所以型別不對的就看檔頭再判斷，並把真的不是圖的記錄下來。
   */
  const images = []
  const notImage = []
  for (const file of incoming) {
    if (file.type?.startsWith('image/')) {
      images.push(file)
      continue
    }
    try {
      const head = new Uint8Array(await file.slice(0, 32).arrayBuffer())
      const type = sniffImageType(head, file.type)
      if (type.startsWith('image/')) images.push(new File([file], file.name, { type }))
      else notImage.push(`${file.name || '(無名)'}（${file.type || '無型別'}）`)
    } catch {
      notImage.push(`${file.name || '(無名)'}（讀不到檔頭）`)
    }
  }
  if (!images.length) {
    actionNotice.value = notImage.length
      ? `略過 ${notImage.length} 個不是圖片的檔案：${notImage.join('、')}`
      : ''
    return 0
  }

  /* iPhone 相機的 HEIC 先轉成 JPEG，之後在電腦上也看得到 */
  let converted = 0
  const prepared = await Promise.all(
    images.map(async (file) => {
      if (!(await isHeic(file))) return file
      try {
        const jpeg = await heicToJpeg(file)
        converted++
        return jpeg
      } catch {
        /* 這個瀏覽器解不開 HEIC，原檔留著讓下面判斷並提示 */
        return file
      }
    }),
  )

  const checked = await Promise.all(
    prepared.map(async (file) => ({ file, ok: await canDecode(file) })),
  )
  const broken = checked.filter((c) => !c.ok).map((c) => c.file.name)
  const usable = checked.filter((c) => c.ok).map((c) => c.file)

  const notices = []
  if (converted) notices.push(`已把 ${converted} 張 HEIC 照片轉成 JPEG`)
  if (notImage.length) notices.push(`略過 ${notImage.length} 個不是圖片的檔案：${notImage.join('、')}`)
  if (broken.length) {
    notices.push(
      `略過 ${broken.length} 張這個瀏覽器讀不到的圖片：${broken.join('、')}。` +
        'iPhone 相機的 HEIC 照片在電腦版瀏覽器無法顯示，請改用截圖，或在 iPhone 上上傳（iPhone 會自動轉檔）。',
    )
  }

  const picked = await Promise.all(
    usable.map(async (file) => ({
      file,
      time: await readImageTime(file),
      hash: await hashFile(file),
    })),
  )
  /* 依圖片本身的時間排序後，接在最後一筆之後新增 */
  picked.sort((a, b) => a.time.ms - b.time.ms)

  /* MD5 完全相同就是同一張圖（主要圖片或附加圖片都算），不新增記錄 */
  const known = new Set(records.value.flatMap((r) => imageHashes(r)))
  const skipped = []
  let added = 0
  for (const { file, time, hash } of picked) {
    if (known.has(hash)) {
      skipped.push(file.name)
      continue
    }
    known.add(hash)
    records.value.push(newRecord(file, time, hash))
    added++
  }
  if (skipped.length) notices.push(`略過 ${skipped.length} 張重複圖片：${skipped.join('、')}`)

  actionNotice.value = notices.join('\n')
  runOcr()
  /* 回報新增幾筆，呼叫端才知道有沒有成功 */
  return added
}

function onPickImages(event) {
  const files = [...event.target.files]
  event.target.value = ''
  if (!files.length) return
  /* 包 try/catch：addFiles 若丟錯，先前會無聲無息（畫面像卡住） */
  requireSelf(async () => {
    try {
      await addFiles(files)
    } catch (e) {
      actionNotice.value = `上傳圖片失敗：${e?.message ?? e}`
    }
  })
}

/* ---------- 貼上診斷（網址加 ?paste=1）：用來查 WeChat 複製的圖片格式 ---------- */
const pasteDiagOn = new URLSearchParams(window.location.search).get('paste') === '1'
const diagBoxEl = ref(null)
const pasteDiag = ref({ api: '', event: '', dom: '', grab: '', result: '' })

async function readClipboardDiag() {
  const out = []
  out.push(`網址：${location.origin}／安全來源（https 或 localhost）：${window.isSecureContext ? '是' : '否'}`)
  try {
    if (typeof navigator.clipboard?.read !== 'function') {
      out.push('navigator.clipboard.read：不存在')
    } else {
      const items = await navigator.clipboard.read()
      out.push(`items = ${items.length}`)
      for (const [i, item] of items.entries()) {
        out.push(`#${i} types = [${item.types.join('、')}]`)
        for (const type of item.types) {
          try {
            const blob = await item.getType(type)
            out.push(`　${type} → ${blob.size} bytes${type.startsWith('image/') ? '（圖片）' : ''}`)
          } catch (e) {
            out.push(`　${type} → 讀不到（${e?.name ?? e}）`)
          }
        }
      }
    }
  } catch (e) {
    out.push(`錯誤：${e?.name ?? ''} ${e?.message ?? e}`)
  }
  pasteDiag.value.api = out.join('\n')
}

function onDiagPaste(event) {
  const dt = event.clipboardData
  const lines = []
  if (!dt) {
    lines.push('clipboardData = null')
  } else {
    lines.push(`types = [${[...dt.types].join('、')}]`)
    lines.push(`items = [${[...dt.items].map((i) => `${i.kind}:${i.type}`).join('、')}]`)
    lines.push(
      `files = [${[...dt.files]
        .map((f) => `${f.name || '(無名)'}｜${f.type || '(無型別)'}｜${f.size}B`)
        .join('、')}]`,
    )
    for (const type of ['text/plain', 'text/html', 'text/uri-list']) {
      const value = dt.getData?.(type)
      if (value) lines.push(`${type} = ${value.slice(0, 150)}`)
    }
  }
  pasteDiag.value.event = lines.join('\n')
  const before = records.value.length
  /* Safari 是把圖插進 DOM，而且圖會比文字晚到，所以要等它穩定下來 */
  waitForPastedImages(diagBoxEl.value).then(async () => {
    const box = diagBoxEl.value
    if (!box) return
    const imgs = [...box.querySelectorAll('img')].map(
      (img) => (img.getAttribute('src') ?? '').slice(0, 60),
    )
    pasteDiag.value.dom = `DOM：${box.childNodes.length} 個節點、${imgs.length} 張圖${
      imgs.length ? `\nsrc：${imgs.join('\n')}` : ''
    }`

    /* 測試頁：逐張記錄「fetch / canvas / 解碼」過程，並真的把圖加進記錄 */
    const log = []
    const files = await extractPastedFiles(box, '貼上', log)
    pasteDiag.value.grab = log.join('\n')
    if (!files.length) {
      pasteDiag.value.result = `沒有抓到可用的圖（記錄仍為 ${records.value.length} 筆）`
      return
    }
    try {
      const added = await addFiles(files)
      pasteDiag.value.result = `addFiles：新增 ${added} 筆\n記錄：貼上前 ${before} 筆 → 現在 ${records.value.length} 筆`
      if (added > 0) {
        backupNotice.value = `已貼上 ${files.length} 張圖片，新增 ${added} 筆記錄（和「上傳圖片」一樣，會自動辨識金額與時間）`
      }
    } catch (e) {
      pasteDiag.value.result = `addFiles 失敗：${e?.message ?? e}`
    }
  })
}

/* ---------- 貼上圖片 ---------- */

/*
 * iPhone Safari：用手機開 http://192.168.x.x（不是 https）時沒有剪貼簿 API，
 * 有些 App（例如 WeChat）複製的圖 API 也讀不到。
 * 這兩種情況就彈出一個框，請使用者長按 →「貼上」，
 * 瀏覽器會把圖插進那個框裡，程式再從 DOM 把圖抓回來。
 *
 * 兩個地雷：
 *   1. 不要自動對焦那個框——一對焦 iOS 就跳鍵盤並把整頁放大。
 *   2. 框裡的字級要 ≥16px——iOS 對小於 16px 的輸入框也會自動放大畫面。
 */
const pasteDialogEl = ref(null)
const pasteBoxEl = ref(null)
const pasteHint = ref('')

/** 把 blob:/data: 的網址抓回來變成檔案（Safari 長按貼上時只會給 DOM 的 <img>） */
async function urlToFile(url, name) {
  const res = await fetch(url)
  const blob = await res.blob()
  const buffer = await blob.arrayBuffer()
  const type = blob.type || 'image/png'
  const ext = (type.split('/')[1] ?? 'png').replace('jpeg', 'jpg')
  return new File([buffer], name || `貼上-${stamp()}.${ext}`, { type })
}

function closePasteDialog() {
  const box = pasteBoxEl.value
  if (box) box.innerHTML = ''
  pasteDialogEl.value?.close?.()
}

/**
 * 等 Safari 把圖插進框裡。
 * 關鍵：貼上的**文字是立刻到的，圖片常常慢好幾百毫秒才插進來**，
 * 所以不能只看一次（先前只等 80ms，圖還沒到就被判「沒有圖」）。
 */
function waitForPastedImages(box, { timeoutMs = 5000, settleMs = 400 } = {}) {
  return new Promise((resolve) => {
    if (!box) return resolve(0)
    const started = Date.now()
    let lastCount = 0
    let lastChange = Date.now()
    const timer = setInterval(() => {
      const count = box.querySelectorAll('img').length
      if (count !== lastCount) {
        lastCount = count
        lastChange = Date.now()
      }
      const settled = lastCount > 0 && Date.now() - lastChange >= settleMs
      if (settled || Date.now() - started >= timeoutMs) {
        clearInterval(timer)
        resolve(lastCount)
      }
    }, 200)
  })
}

/**
 * 把框裡的圖抓成檔案。
 * 兩條路，逐張試：
 *   1. fetch(blob URL) 後立刻讀成 bytes（最快、不失真）
 *   2. fetch 被擋時（iOS 有時不給）改畫到 canvas 再匯出：
 *      用**同一個 canvas、長邊上限 2000**，畫完立刻釋放，避免記憶體爆掉閃退。
 * log 陣列有給的話，會把每一步寫進去（測試頁用）。
 */
async function extractPastedFiles(box, tag = '貼上', log = null) {
  if (!box) return []
  const files = []
  const canvas = document.createElement('canvas')
  const imgs = [...box.querySelectorAll('img')]
  if (log) log.push(`框裡：${box.childNodes.length} 個節點、${imgs.length} 張圖`)

  for (const [i, img] of imgs.entries()) {
    const src = img.getAttribute('src') ?? ''
    const px = `${img.naturalWidth || img.width || 0}x${img.naturalHeight || img.height || 0}`
    const name = (ext) => `${tag}-${stamp()}-${i + 1}.${ext}`

    if (!/^(blob:|data:)/i.test(src)) {
      if (log) log.push(`#${i + 1} 不是 blob/data（${src.slice(0, 20)}）`)
      continue
    }

    /* 路 1：fetch */
    try {
      const blob = await (await fetch(src)).blob()
      const buffer = await blob.arrayBuffer()
      if (buffer.byteLength) {
        /* iOS 給的可能是 UTI（public.jpeg）→ 用檔頭換成正確 MIME */
        const sniffed = sniffImageType(new Uint8Array(buffer.slice(0, 32)), blob.type)
        const type = sniffed.startsWith('image/') ? sniffed : 'image/jpeg'
        const file = new File([buffer], name(extFromMime(type)), { type })
        files.push(file)
        if (log) {
          log.push(
            `#${i + 1} ${px}｜fetch OK｜${blob.type || '(無型別)'} → ${type}｜${Math.round(
              buffer.byteLength / 1024,
            )}KB｜解碼${(await canDecode(file)) ? 'OK' : '失敗'}`,
          )
        }
        continue
      }
      if (log) log.push(`#${i + 1} ${px}｜fetch 得到 0 bytes，改用 canvas`)
    } catch (e) {
      if (log) log.push(`#${i + 1} ${px}｜fetch 失敗（${e?.name ?? e}），改用 canvas`)
    }

    /* 路 2：canvas（記憶體安全版） */
    try {
      const w = img.naturalWidth || img.width
      const h = img.naturalHeight || img.height
      if (!w || !h) {
        if (log) log.push(`　└ canvas 也不行：圖沒有尺寸`)
        continue
      }
      /* 長邊上限 2800：一般手機截圖（約 1290×2796）不會被縮小，OCR 更準；
         同一個 canvas 逐張重用、畫完立刻釋放，所以記憶體不會累積 */
      const scale = Math.min(1, 2800 / Math.max(w, h))
      const outW = Math.round(w * scale)
      const outH = Math.round(h * scale)
      canvas.width = outW
      canvas.height = outH
      canvas.getContext('2d').drawImage(img, 0, 0, outW, outH)
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92))
      canvas.width = 0
      canvas.height = 0
      if (blob?.size) {
        files.push(new File([blob], name('jpg'), { type: 'image/jpeg' }))
        if (log) log.push(`　└ canvas 救回 ${outW}x${outH}｜jpeg｜${Math.round(blob.size / 1024)}KB`)
      } else if (log) {
        log.push(`　└ canvas 失敗（toBlob 回空）`)
      }
    } catch (e) {
      if (log) log.push(`　└ canvas 失敗（${e?.name ?? e}）`)
    }
  }
  return files
}

/**
 * 等圖插進來、抓成檔案，成功就加記錄。
 * 不管成功或失敗，貼上完就把「貼上圖片」視窗關掉（不要留著擋畫面），
 * 有問題改成在頁面上方提示。
 */
async function harvestPasteBox() {
  const box = pasteBoxEl.value
  if (!box) return 0
  await waitForPastedImages(box)
  const files = await extractPastedFiles(box, '貼上')
  if (!files.length) {
    closePasteDialog()
    backupNotice.value =
      '這次貼上的內容裡沒有可用的圖片。\n請再試一次，或改用「上傳圖片」從相簿選圖。'
    return 0
  }
  try {
    const added = await addFiles(files)
    closePasteDialog()
    if (added > 0) {
      /* 明確告訴使用者：跟一般上傳一樣，已經變成記錄了（辨識中） */
      backupNotice.value = `已貼上 ${files.length} 張圖片，新增 ${added} 筆記錄（和「上傳圖片」一樣，會自動辨識金額與時間）`
    } else {
      backupNotice.value = `抓到了 ${files.length} 張圖，但沒有新增記錄。\n${
        actionNotice.value || '（沒有其他說明）'
      }`
    }
    return added
  } catch (e) {
    closePasteDialog()
    backupNotice.value = `貼上圖片失敗：${e?.message ?? e}\n請再試一次，或改用「上傳圖片」。`
    return 0
  }
}

function onPasteBox(event) {
  const files = [...(event.clipboardData?.files ?? [])].filter((f) =>
    f.type?.startsWith('image/'),
  )
  if (files.length) {
    event.preventDefault()
    closePasteDialog()
    requireSelf(() => addFiles(files))
    return
  }
  /* 剪貼簿沒給檔案：等 Safari 把圖插進 DOM，再抓出來（文字一律丟掉） */
  harvestPasteBox()
}

/**
 * 彈出貼上框：打開後自動對焦貼上框（iOS 才會出現內建「貼上」選單），
 * 但貼上框有 inputmode="none"，所以不會跳鍵盤、也不會把畫面放大。
 */
function openPasteDialog(message) {
  pasteHint.value = message
  pasteDialogEl.value?.showModal()
  nextTick(() => pasteBoxEl.value?.focus())
}

async function pasteImages() {
  actionNotice.value = ''
  requireSelf(async () => {
    if (typeof navigator.clipboard?.read !== 'function') {
      openPasteDialog(
        window.isSecureContext
          ? '這個瀏覽器不能直接讀取剪貼簿。\n請長按下面那格，選「貼上」。'
          : `目前網址是 ${location.origin}，不是 https，瀏覽器不給用剪貼簿。\n請長按下面那格，選「貼上」，一樣可以把圖加進來。`,
      )
      return
    }
    try {
      const items = await navigator.clipboard.read()
      const files = []
      for (const item of items) {
        const type = item.types.find((t) => t.startsWith('image/'))
        if (!type) continue
        const blob = await item.getType(type)
        const ext = type.split('/')[1] ?? 'png'
        files.push(new File([blob], `貼上-${stamp()}.${ext}`, { type }))
      }
      if (!files.length) {
        openPasteDialog(
          `剪貼簿 API 讀不到圖片（讀到 ${items.length} 個項目）。\n請長按下面那格，選「貼上」。`,
        )
        return
      }
      addFiles(files)
    } catch (e) {
      openPasteDialog(`讀不到剪貼簿（${e?.message ?? e}）。\n請長按下面那格，選「貼上」。`)
    }
  })
}

/* 直接按 Ctrl+V 也能貼上（貼上框自己會處理，不要重複加） */
function onPaste(event) {
  /* 診斷模式不要真的加記錄，才看得清楚剪貼簿裡有什麼 */
  if (pasteDiagOn) return
  if (pasteBoxEl.value?.contains(event.target)) return
  const files = [...(event.clipboardData?.files ?? [])]
  if (!files.some((f) => f.type?.startsWith('image/'))) return
  event.preventDefault()
  requireSelf(() => addFiles(files))
}

/* ---------- 離線 OCR ---------- */
const ocrBusy = ref(false)
const ocrDone = ref(0)
const ocrTotal = ref(0)
const ocrLabel = ref('')
/* 正在辨識的這一張跑到幾 %（進度條要顯示「這一張」的進度，不能只跳張數） */
const ocrFilePercent = ref(0)
const ocrStage = ref('')
const ocrStop = ref(false)
const pendingOcrCount = computed(
  () => records.value.filter((r) => r.ocrStatus === 'pending').length,
)

/*
 * 進度條的位置＝已經辨識完的張數 ＋ 正在跑的這一張的百分比。
 * 這樣一張大圖在辨識時，條子會順順地走，而不是整張跑完才跳一格。
 */
const ocrPercent = computed(() => {
  if (!ocrTotal.value) return 0
  const inside = Math.min(100, Math.max(0, ocrFilePercent.value)) / 100
  return Math.min(100, ((ocrDone.value + inside) / ocrTotal.value) * 100)
})

/** 使用者按「跳過」：這張不再辨識，圖與其他欄位都留著 */
function skipOcr(record) {
  if (!record) return
  if (record.locked) return
  if (record.ocrStatus === 'pending' || record.ocrStatus === 'running') {
    record.ocrStatus = 'skipped'
    record.ocrProgress = 0
  }
}

/** 跳過目前正在辨識的那一張 */
function skipCurrentOcr() {
  skipOcr(records.value.find((r) => r.ocrStatus === 'running'))
}

/** 全部停止：正在跑的結果不要、排隊的留在「等待辨識」 */
function stopOcr() {
  ocrStop.value = true
  records.value.forEach((r) => {
    if (r.ocrStatus === 'running' || r.ocrStatus === 'pending') r.ocrStatus = 'pending'
  })
}

async function runOcr() {
  if (ocrBusy.value) return
  ocrBusy.value = true
  ocrStop.value = false
  try {
    /* OCR 途中又上傳新圖時，這裡會再撿起來跑一輪（鎖定的不辨識、也不會被改到） */
    let queue = records.value.filter((r) => r.ocrStatus === 'pending' && !r.locked)
    while (queue.length && !ocrStop.value) {
      ocrDone.value = 0
      ocrTotal.value = queue.length
      for (const rec of queue) {
        if (ocrStop.value) break
        rec.ocrStatus = 'running'
        ocrLabel.value = rec.fileName
        ocrFilePercent.value = 0
        ocrStage.value = ''
        try {
          /* 兩種模式並行跑，進度取兩邊平均 */
          const passProgress = [0, 0]
          const passes = await recognizePasses(rec.file, (m, pass, count) => {
            passProgress[pass] = m.progress ?? 0
            rec.ocrProgress = Math.round(
              (passProgress.reduce((sum, p) => sum + p, 0) / count) * 100,
            )
            ocrFilePercent.value = rec.ocrProgress
            ocrStage.value = m.status ?? ''
          })
          /* 辨識期間使用者按了「跳過」或「全部停止」→ 結果就不要了 */
          if (rec.ocrStatus !== 'running') {
            ocrDone.value++
            continue
          }
          /* 辨識期間被鎖定：結果一樣不要寫進去（要改就得先解鎖重新辨識） */
          if (rec.locked) {
            rec.ocrStatus = 'skipped'
            rec.ocrProgress = 0
            ocrDone.value++
            continue
          }
          rec.ocrText = passes.map((p) => p.text).join('\n----------\n')
          const { dates, amounts } = mergeParsed(
            passes.map((p) => parsePaymentText(p.text, p.heights)),
          )
          rec.amounts = amounts
          const ms = pickDate(dates)
          if (ms && !rec.paidAtManual) rec.paidAtText = fmtDateTime(ms)
          const pick = pickDefaultAmount(amounts, defaultCurrency.value)
          if (pick && !rec.currencyLocked) {
            rec.currency = pick.currency
            rec.amount = String(pick.value)
          }
          rec.ocrStatus = 'done'
        } catch (e) {
          rec.ocrStatus = 'error'
          rec.ocrError = `辨識失敗：${e?.message ?? e}`
        }
        rec.ocrProgress = 100
        ocrDone.value++
      }
      if (ocrStop.value) break
      queue = records.value.filter((r) => r.ocrStatus === 'pending' && !r.locked)
    }
  } finally {
    ocrBusy.value = false
    ocrLabel.value = ''
    ocrFilePercent.value = 0
    ocrStage.value = ''
  }
}

function applyDefaultCurrency() {
  records.value.forEach((r) => {
    if (r.locked || r.currencyLocked || !r.amounts?.length) return
    const hit = r.amounts.find((a) => a.currency === defaultCurrency.value)
    if (hit) {
      r.currency = hit.currency
      r.amount = String(hit.value)
    }
  })
}

/**
 * 手動新增的記錄（沒有圖片）點「無圖」就能補一張圖上去。
 * 標題維持使用者原本看到的「手動新增N」；補完圖會重新跑辨識。
 */
async function attachImage(record, file) {
  try {
    /* 鎖定的記錄不能補圖（要換圖請先解除鎖定） */
    if (record.locked) {
      actionNotice.value = `「${record.fileName}」已鎖定，要補圖片請先解除鎖定。`
      return
    }
    let picked = file
    if (await isHeic(picked)) {
      try {
        picked = await heicToJpeg(picked)
      } catch {
        /* 這個瀏覽器解不開 HEIC，原檔留著讓下面判斷並提示 */
      }
    }
    if (!(await canDecode(picked))) {
      actionNotice.value = `這個瀏覽器讀不到「${file.name}」，請換一張，或改用截圖。`
      return
    }

    const hash = await hashFile(picked)
    /* 同一張圖已經用過就擋下來（別筆記錄的主要圖片或附加圖片都算），免得同一筆帳記兩次 */
    const twin = findImageOwner(records.value, hash)
    if (twin) {
      actionNotice.value = `這張圖已經用在「${twin.record.fileName}」（${
        seqLabels.value.get(twin.record.id) ?? ''
      }），沒有重複加上去。`
      return
    }

    const time = await readImageTime(picked)
    /*
     * 使用者自己填過的金額與時間不要被辨識結果蓋掉
     * （手動新增時自動帶入的付款時間不算「自己填的」，所以還是讓辨識結果更新它）
     */
    if (record.amount !== '') record.currencyLocked = true

    revoke(record.url)
    record.file = picked
    record.hash = hash
    if (!record.fileTime) {
      record.fileTime = time.ms
      record.fileTimeSource = time.source
    }
    record.url = URL.createObjectURL(picked)
    record.ocrStatus = 'pending'
    record.ocrProgress = 0
    record.ocrError = ''
    actionNotice.value = ''
    runOcr()
  } catch (e) {
    actionNotice.value = `加圖片失敗：${e?.message ?? e}`
  }
}

async function removeRecord(record) {
  const ok = await askConfirm({
    title: '確定要刪除這筆記錄嗎？',
    text: record.locked
      ? `${record.fileName || '這筆記錄'} 已鎖定，刪除後圖片與辨識結果都不會留下。`
      : `${record.fileName || '這筆記錄'} 的圖片與辨識結果都會一起刪掉。`,
    confirmText: '刪除',
    icon: 'warning',
  })
  if (!ok) return
  revoke(record.url)
  records.value = records.value.filter((r) => r.id !== record.id)
  /* 刪掉中間的「手動新增」之後，後面的號碼要往前補（順序更新） */
  renumberManualRecords()
}

/* ---------- 更多：鎖定／解除與刪除（刪除鈕從卡片搬到這裡） ---------- */
const moreDialogEl = ref(null)
const moreRecord = ref(null)

function openMoreRecord(record) {
  moreRecord.value = record
  nextTick(() => moreDialogEl.value?.showModal())
}

const closeMoreRecord = () => moreDialogEl.value?.close()

/**
 * 鎖定／解除。
 * 鎖定過的記錄，之後就算解除，「這張圖有多個金額，用哪一個？」也不會再出現
 * （amountChooserOff 會一直留著）。
 */
function setLocked(record, locked) {
  if (!record) return
  record.locked = locked
  if (locked) record.amountChooserOff = true
}

/** 從「更多」按鎖定／解除；解除後就停在同一個對話框，可以接著刪除或關閉 */
function toggleLockFromMore() {
  const record = moreRecord.value
  if (!record) return
  setLocked(record, !record.locked)
  actionNotice.value = record.locked
    ? `已鎖定「${record.fileName}」。這筆記錄的欄位、受益人、重新辨識與補圖都停用了，圖片還是可以放大看。`
    : `已解除鎖定「${record.fileName}」。`
}

/** 「更多」裡的刪除：先把對話框關掉，SweetAlert2 才不會被壓在下面 */
async function deleteFromMore() {
  const record = moreRecord.value
  if (!record) return
  closeMoreRecord()
  /* 等對話框真的關好（close 事件是非同步的）再跳確認視窗 */
  await nextTick()
  await removeRecord(record)
}

/**
 * 純文字模式點到已鎖定的那一列：先問要不要解除。
 * 使用者按「解除並修改」就解除鎖定，接著照原本的動作繼續（等於解鎖後直接改）。
 */
async function unlockToEdit(record) {
  const ok = await askConfirm({
    title: '這筆記錄已鎖定',
    text: `${record.fileName} 已經鎖定，要修改就要先解除。`,
    confirmText: '解除並修改',
    icon: 'warning',
  })
  if (!ok) return false
  setLocked(record, false)
  return true
}

/* 辨識失敗或逾時後，讓使用者可以重試 */
function retryOcr(record) {
  if (record.locked) return
  record.ocrStatus = 'pending'
  record.ocrError = ''
  record.ocrProgress = 0
  runOcr()
}

/* 元件或非同步流程出錯時，直接在畫面上說出來（不然會像「卡住」，得 F5） */
function onAppError(event) {
  const message = event?.detail?.message ?? '未知錯誤'
  actionNotice.value = `程式發生錯誤（畫面可能沒有更新）：${message}\n如果剛剛上傳／貼上的圖片沒出現，請按下面「知道了」後再試一次；再不行就重新整理。`
}

/* ---------- 看圖（一筆記錄可以有很多張） ---------- */
const viewing = ref(null)
const viewerEl = ref(null)
/* 在看圖頁選「上傳圖片」用的檔案欄位 */
const viewerPickEl = ref(null)
const zoom = ref(1)
/* 現在看的是第幾張（0 = 主要圖片） */
const viewIndex = ref(0)
/* 看圖頁的小訊息（加入幾張、哪張重複了…） */
const viewerMsg = ref('')

const viewingImages = computed(() => recordImages(viewing.value))
const currentImage = computed(() => viewingImages.value[viewIndex.value] ?? viewingImages.value[0] ?? null)

function openViewer(record) {
  if (!record.url) return
  viewing.value = record
  viewIndex.value = 0
  viewerMsg.value = ''
  zoom.value = 1
  nextTick(() => viewerEl.value.showModal())
}

function closeViewer() {
  viewerEl.value?.close()
}

/* 換上一張／下一張（繞回去） */
function stepImage(delta) {
  const total = viewingImages.value.length
  if (total < 2) return
  viewIndex.value = (viewIndex.value + delta + total) % total
  viewerMsg.value = ''
}

/** 把目前這張換成主要圖片（縮圖、OCR 都用它） */
function setViewerImageAsMain() {
  const record = viewing.value
  const image = currentImage.value
  if (!record || !image || image.isMain) return
  const { main, extras } = promoteImage(record, image.id)
  record.file = main.file
  record.url = main.url
  record.hash = main.hash
  record.fileTime = main.fileTime
  record.fileTimeSource = main.fileTimeSource
  record.extraImages = extras
  /* 主要圖片換人了 → 用新的一張重新辨識金額與時間（自己填過的內容不覆蓋） */
  record.ocrStatus = 'pending'
  record.ocrProgress = 0
  record.ocrError = ''
  viewIndex.value = 0
  viewerMsg.value = '已設為縮圖，並重新辨識這一張的金額與時間'
  runOcr()
}

/** 刪掉目前這張圖片；按確認前先關掉對話框，免得確認視窗被壓在下面 */
async function deleteViewerImage() {
  const record = viewing.value
  const image = currentImage.value
  if (!record || !image) return
  const wasMain = image.isMain
  const at = viewIndex.value
  const remaining = viewingImages.value.length - 1
  closeViewer()
  await nextTick()
  const ok = await askConfirm({
    title: '刪除這張圖片？',
    text:
      `這張圖片會從「${record.fileName}」移除` +
      (remaining > 0
        ? wasMain
          ? '，並改用下一張當縮圖。'
          : `，這筆記錄還有 ${remaining} 張圖片。`
        : '，這筆記錄就變成沒有圖片的記錄（欄位資料都留著）。'),
    confirmText: '刪除',
    icon: 'warning',
  })
  if (!ok) {
    reopenViewer(record, at)
    return
  }
  const { main, extras, removed } = removeImage(record, image.id)
  record.file = main.file
  record.url = main.url
  record.hash = main.hash
  record.fileTime = main.fileTime
  record.fileTimeSource = main.fileTimeSource
  record.extraImages = extras
  revoke(removed?.url)
  /* 刪掉的是主要圖片而且還有別的圖片 → 新的主要圖片要重新辨識 */
  if (wasMain && main.file) {
    record.ocrStatus = 'pending'
    record.ocrProgress = 0
    record.ocrError = ''
    runOcr()
  }
  const nextAt = Math.min(at, recordImages(record).length - 1)
  if (record.url) reopenViewer(record, nextAt)
}

/** 重新打開看圖（刪圖片時關掉過） */
function reopenViewer(record, index = 0) {
  if (!record?.url) return
  viewing.value = record
  viewIndex.value = Math.max(0, Math.min(index, recordImages(record).length - 1))
  zoom.value = 1
  viewerMsg.value = ''
  nextTick(() => viewerEl.value?.showModal())
}

/* ---------- 普通文字模式：沒有圖片的那一列按「無」補圖 ---------- */
const plainPickEl = ref(null)
let plainPickTarget = null

function pickPlainImage(record) {
  if (record.locked) return
  plainPickTarget = record
  plainPickEl.value?.click()
}

function onPlainPick(event) {
  const file = event.target.files?.[0]
  event.target.value = ''
  const record = plainPickTarget
  plainPickTarget = null
  if (file && record) attachImage(record, file)
}

/* 在看圖頁後期補上圖片（可以一次選多張） */
async function addViewerImages(event) {
  const files = [...(event.target.files ?? [])]
  event.target.value = ''
  const record = viewing.value
  if (!record || !files.length) return
  const notices = []
  const added = []
  for (const file of files) {
    try {
      let picked = file
      if (await isHeic(picked)) {
        try {
          picked = await heicToJpeg(picked)
        } catch {
          /* 解不開就用原檔，下面 canDecode 會擋 */
        }
      }
      if (!(await canDecode(picked))) {
        notices.push(`${file.name}：這個瀏覽器讀不到`)
        continue
      }
      const hash = await hashFile(picked)
      const twin = findImageOwner(records.value, hash)
      if (twin) {
        notices.push(
          `${file.name}：已經用在「${twin.record.fileName}」（${
            seqLabels.value.get(twin.record.id) ?? ''
          }）`,
        )
        continue
      }
      const time = await readImageTime(picked)
      added.push({
        id: uid(),
        file: picked,
        url: URL.createObjectURL(picked),
        fileName: file.name,
        hash,
        fileTime: time.ms,
        fileTimeSource: time.source,
      })
    } catch (e) {
      notices.push(`${file.name}：${e?.message ?? e}`)
    }
  }
  if (added.length) {
    record.extraImages = [...(record.extraImages ?? []), ...added]
    viewerMsg.value = `已加入 ${added.length} 張圖片`
  }
  if (notices.length) {
    viewerMsg.value = `${viewerMsg.value ? `${viewerMsg.value}；` : ''}${notices.join('；')}`
  }
}

const zoomBy = (factor) => {
  zoom.value = Math.min(6, Math.max(0.25, Number((zoom.value * factor).toFixed(3))))
}
const resetZoom = () => (zoom.value = 1)

/* 手機版（RWD）：點圖片就等於按關閉；桌機版不變，點圖不會關 */
const onViewerImageClick = () => {
  if (window.matchMedia?.('(max-width: 560px)').matches) viewerEl.value?.close()
}

/* ---------- 刷新：加到手機主畫面之後沒有網址列，也沒有下拉重新整理 ---------- */
const refreshing = ref(false)

async function refreshApp() {
  if (refreshing.value) return
  refreshing.value = true
  try {
    /* 先問 Service Worker 有沒有新版，有就等它接手再重載，這樣才會真的更新 */
    const reg = navigator.serviceWorker?.getRegistration
      ? await navigator.serviceWorker.getRegistration()
      : null
    if (reg) {
      await reg.update().catch(() => {})
      if (reg.installing || reg.waiting) {
        await Promise.race([
          new Promise((resolve) =>
            navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }),
          ),
          new Promise((resolve) => setTimeout(resolve, 3000)),
        ])
      }
    }
  } catch {
    /* 隱私模式之類的：直接重載就好 */
  }
  /* 重載沒有發生（例如被擋下來）也要把按鈕恢復成可以按 */
  refreshing.value = false
  location.reload()
}

/* ---------- 重置：可以選擇要保留什麼 ---------- */
async function resetAll() {
  /*
   * 重置時讓使用者勾選要保留什麼。
   * 從連結帶進來的備注分類永遠保留（不用選），所以不列在選項裡。
   */
  const keep = await askChecklist({
    title: '確定要重置嗎？',
    confirmText: '重置',
    options: [
      { key: 'persons', label: '保留人物', checked: false },
      { key: 'currency', label: '保留預設幣別', checked: false },
      { key: 'notes', label: '保留備注分類', checked: false },
    ],
    note: '不勾的項目會被清掉；付款記錄與圖片一律刪除，無法復原。',
  })
  if (keep === null) return

  records.value.forEach((r) => revoke(r.url))
  records.value = []
  if (!keep.persons) persons.value = []
  if (!keep.currency) defaultCurrency.value = ''
  /* 連結帶進來的一定留著，其他的看使用者有沒有勾 */
  noteCategories.value = keepNoteCategories(noteCategories.value, keep.notes)
  actionNotice.value = ''
  savedSigs.clear()
  seqCounter = 0
  manualCounter = 0
  /* 重置連「套用過的分享連結」也清掉，重新整理才會再套用一次連結 */
  appliedLinks = []

  try {
    await wipe()
    storageError.value = ''
    /* wipe() 會清掉 settings，保留下來的東西要補寫回去 */
    await persist()
  } catch (e) {
    storageError.value = `重置失敗：${e?.message ?? e}`
  }

  const kept = []
  if (persons.value.length) kept.push(`人物 ${persons.value.length} 位`)
  if (defaultCurrency.value) kept.push(`預設幣別 ${defaultCurrency.value}`)
  if (noteCategories.value.length) {
    const fromLink = noteCategories.value.filter((c) => c.link).length
    kept.push(
      `備注分類 ${noteCategories.value.length} 個${fromLink ? `（其中 ${fromLink} 個來自連結）` : ''}`,
    )
  }
  backupNotice.value = kept.length ? `已重置，保留：${kept.join('、')}` : '已重置，所有資料都清空了'
}

/* ---------- 匯出／匯入 ---------- */
const importInputEl = ref(null)
const backupNotice = ref('')

/* 手機／平板：用系統分享面板（iPhone 的分享畫面），桌機才直接下載 */
const useShareSheet = () =>
  window.matchMedia?.('(pointer: coarse)').matches ||
  window.matchMedia?.('(max-width: 560px)').matches

/* 匯出時把圖片壓小：等比縮到短邊至少 700px（比例不變），再降 JPEG 品質，
   目標是原始檔案的 1/3 以下。解不開的圖就原樣帶出去，至少不會掉資料。 */
const unreadableImages = []
async function encodeForExport(file) {
  try {
    const blob = await compressImage(file, { minShortSide: 700, targetRatio: 3 })
    if (blob) return { base64: await blobToBase64(blob), type: blob.type }
    return { base64: await blobToBase64(file), type: file.type }
  } catch {
    /* 單張圖讀不到（Safari 舊資料損毀）不該讓整個匯出失敗，記錄下來最後一起講 */
    unreadableImages.push(file?.name || '（沒有檔名）')
    return ''
  }
}

async function exportBackup() {
  try {
    if (!records.value.length) {
      warn('還沒有記錄', '目前沒有任何付款記錄可以匯出。')
      return
    }
    if (!(await exportAllowed())) return
    unreadableImages.length = 0
    const payload = await toBackup(
      records.value,
      persons.value,
      defaultCurrency.value,
      encodeForExport,
    )
    /* 檔名帶上「自己」的名字，方便分辨這份是誰的記錄 */
    const name = ['付款記錄', safeFileNamePart(selfPerson.value?.name), stamp()]
      .filter(Boolean)
      .join('-')
    const fileName = `${name}.json`
    const file = new File([JSON.stringify(payload)], fileName, { type: 'application/json' })

    let shareNote = ''
    if (useShareSheet() && typeof navigator.share === 'function' && typeof navigator.canShare === 'function') {
      if (navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({ files: [file], title: fileName })
          backupNotice.value = `已開啟分享面板：${fileName}`
          return
        } catch (e) {
          /* 使用者按取消就不算失敗；其他錯誤則退回下載 */
          if (e?.name === 'AbortError') return
          shareNote = '\n（分享面板打不開，已改成直接下載）'
        }
      }
    } else if (useShareSheet()) {
      /*
       * 手機上沒有分享面板：系統分享面板（Web Share）只在安全來源提供，
       * 用區域網的 http://192.168.x.x 開就不會有——說清楚原因，免得以為壞了。
       */
      shareNote = window.isSecureContext
        ? '\n（這個瀏覽器不支援系統分享面板，已改成直接下載）'
        : `\n（目前網址是 ${location.origin}，不是 https，瀏覽器不提供系統分享面板，已改成直接下載。用手機開 https 的網址，或加到主畫面用 App 開，就會出現分享面板）`
    }

    const url = URL.createObjectURL(file)
    const a = document.createElement('a')
    a.href = url
    a.download = fileName
    a.rel = 'noopener'
    /* 有些瀏覽器要求連結真的在文件裡才肯下載 */
    document.body.append(a)
    a.click()
    a.remove()
    /* 下載不是同步完成的，太早回收會讓檔案存不出來 */
    setTimeout(() => URL.revokeObjectURL(url), 10000)
    const skipped = unreadableImages.length
      ? `\n有 ${unreadableImages.length} 張圖片讀不到、沒有放進備份：${unreadableImages
          .slice(0, 5)
          .join('、')}${unreadableImages.length > 5 ? '…' : ''}（其他資料都在）`
      : ''
    backupNotice.value = `已匯出 ${records.value.length} 筆記錄、${persons.value.length} 位人物 → ${fileName}${skipped}${shareNote}`
  } catch (e) {
    backupNotice.value = `匯出失敗：${e?.message ?? e}`
  }
}

/* 匯入來源的名稱預設就是 JSON 檔名（去掉 .json），之後可以重新命名 */
const importSource = (fileName) =>
  String(fileName ?? '')
    .replace(/\.json$/i, '')
    .trim()
    .slice(0, 40) || '匯入'

/* 一次可以匯入多個 JSON：逐檔處理，遇到要對齊人物就停下來等使用者選完再換下一個 */
const importQueue = []
let importing = false

function applyImport(incoming, decisions, sourceName) {
  const before = persons.value.length
  const { persons: nextPersons, idMap } = resolvePersons(persons.value, incoming.persons, decisions)
  persons.value = nextPersons

  const { added, skipped } = mergeRecords(records.value, remapRecords(incoming.records, idMap))
  for (const r of added) {
    records.value.push({
      ...r,
      seq: nextSeq(),
      source: sourceName || DEFAULT_SOURCE,
      url: r.file ? URL.createObjectURL(r.file) : '',
    })
  }
  if (!defaultCurrency.value && incoming.defaultCurrency) {
    defaultCurrency.value = incoming.defaultCurrency
  }
  /* 匯入的可能也有「手動新增N」，一起重排才不會撞號 */
  renumberManualRecords()
  runOcr()
  return { added: added.length, persons: nextPersons.length - before, skipped }
}

/** 匯入一個檔案；要對齊人物時會等使用者按確定或取消，取消回傳 null */
function importOne(file) {
  return new Promise((resolve, reject) => {
    ;(async () => {
      const incoming = await fromBackup(JSON.parse(await file.text()))
      const sourceName = importSource(file.name)
      const probe = resolvePersons(persons.value, incoming.persons)

      /* 有對不上的名字就先問使用者要對應到誰 */
      if (probe.needsDecision.length) {
        const decisions = {}
        probe.needsDecision.forEach((p) => (decisions[p.id] = 'new'))
        pendingImport.value = {
          incoming,
          decisions,
          needsDecision: probe.needsDecision,
          sourceName,
          resolve,
        }
        nextTick(() => alignDialogEl.value.showModal())
        return
      }

      resolve(applyImport(incoming, {}, sourceName))
    })().catch(reject)
  })
}

async function onImportFile(event) {
  const files = [...(event.target.files ?? [])]
  event.target.value = ''
  if (!files.length) return

  importQueue.push(...files)
  if (importing) return
  importing = true

  const total = { files: 0, added: 0, persons: 0, skipped: 0, cancelled: 0, failed: [] }
  const sources = []
  try {
    while (importQueue.length) {
      const file = importQueue.shift()
      try {
        const one = await importOne(file)
        if (!one) {
          total.cancelled++
          continue
        }
        total.files++
        sources.push(importSource(file.name))
        total.added += one.added
        total.persons += one.persons
        total.skipped += one.skipped
      } catch (e) {
        total.failed.push(`${file.name}（${e?.message ?? e}）`)
      }
    }
  } finally {
    importing = false
  }

  if (!total.files && total.cancelled === 1 && !total.failed.length) {
    backupNotice.value = '已取消匯入'
    return
  }

  const bits = [
    total.files === 1
      ? `匯入完成（來源「${sources[0] || DEFAULT_SOURCE}」）`
      : `匯入完成：${total.files} 個檔案`,
    `新增 ${total.added} 筆記錄、${total.persons} 位人物`,
  ]
  if (total.skipped) bits.push(`略過 ${total.skipped} 筆已經有的`)
  if (total.cancelled) bits.push(`${total.cancelled} 個檔案取消`)
  if (total.failed.length) bits.push(`失敗：${total.failed.join('、')}`)
  backupNotice.value = bits.join('，')
}

const alignDialogEl = ref(null)
const pendingImport = ref(null)

function confirmAlign() {
  const { incoming, decisions, sourceName, resolve } = pendingImport.value
  const result = applyImport(incoming, decisions, sourceName)
  alignDialogEl.value.close()
  pendingImport.value = null
  resolve?.(result)
}

function cancelAlign() {
  /* 關掉對話框就會走 onAlignDialogClose，那裡會把這一個檔案算成取消 */
  alignDialogEl.value.close()
}

/** 不管是按取消還是按 Esc 關掉，都要讓前面那個檔案結束，才不會卡住後面的匯入 */
function onAlignDialogClose() {
  const pending = pendingImport.value
  pendingImport.value = null
  pending?.resolve?.(null)
}

/* ---------- 本機儲存（IndexedDB）：刷新、關掉瀏覽器都不會不見 ---------- */
const savedSigs = new Map()

function serializeRecord(r) {
  return {
    id: r.id,
    seq: r.seq,
    createdAt: r.createdAt ?? 0,
    source: r.source || DEFAULT_SOURCE,
    fileName: r.fileName,
    fileTime: r.fileTime,
    fileTimeSource: r.fileTimeSource,
    hash: r.hash,
    ocrStatus: r.ocrStatus,
    ocrProgress: r.ocrProgress,
    ocrText: r.ocrText,
    ocrError: r.ocrError,
    amounts: (r.amounts ?? []).map((a) => ({ ...a })),
    currency: r.currency,
    currencyLocked: r.currencyLocked,
    amount: r.amount,
    paidAtText: r.paidAtText,
    paidAtManual: r.paidAtManual,
    locked: !!r.locked,
    amountChooserOff: !!r.amountChooserOff,
    /* 匯出前檢查：這筆要不要檢查（預設要） */
    checkExport: r.checkExport !== false,
    /* 附加圖片只存「是哪一張」的資料，bytes 由 persist() 補上 */
    extraImages: (r.extraImages ?? []).map((img) => ({
      id: img.id,
      fileName: img.fileName ?? '',
      hash: img.hash ?? '',
      fileTime: img.fileTime ?? 0,
      fileTimeSource: img.fileTimeSource ?? 'file',
    })),
    payerId: r.payerId,
    beneficiaryIds: [...r.beneficiaryIds],
    /* 人物名字的快照：人物不見時才有辦法把他補回來（見 lib/persons.js） */
    personNames: personNameSnapshot(r, persons.value),
    note: r.note,
  }
}

/* 圖片本身不進比對字串，避免每次打字都重寫 blob */
const signature = (plain) => JSON.stringify(plain)

/* 這幾筆的圖片讀不到（Safari 舊資料損毀），只是記錄起來通知使用者 */
const brokenImageNames = ref([])

/* 存圖片 bytes 而不是 Blob，見 image.js 的說明 */
const IMAGE_STORE_VERSION = 2

/** 把 Vue 的 Proxy 轉成純資料，才存得進 IndexedDB（Proxy 不能結構化複製） */
const plainCopy = (value) => JSON.parse(JSON.stringify(value ?? null))

async function persist() {
  try {
    const alive = new Set()
    const broken = []
    for (const r of records.value) {
      alive.add(r.id)
      const plain = serializeRecord(r)
      const sig = signature(plain)
      if (savedSigs.get(r.id) === sig) continue

      if (r.file || r.extraImages?.length) {
        try {
          if (r.file) Object.assign(plain, await fileToStored(r.file))
          /* 附加圖片的 bytes 也要一起存（附加圖片讀不到就整筆先不覆蓋） */
          plain.extraImages = []
          for (const img of r.extraImages ?? []) {
            plain.extraImages.push({
              id: img.id,
              fileName: img.fileName ?? '',
              hash: img.hash ?? '',
              fileTime: img.fileTime ?? 0,
              fileTimeSource: img.fileTimeSource ?? 'file',
              ...(await fileToStored(img.file)),
            })
          }
        } catch {
          /* 讀不到就不要覆蓋原本那筆，免得把僅有的資料也弄掉 */
          broken.push(r.fileName)
          savedSigs.set(r.id, sig)
          continue
        }
      }
      await put('records', plain)
      savedSigs.set(r.id, sig)
    }
    brokenImageNames.value = broken
    for (const id of [...savedSigs.keys()]) {
      if (alive.has(id)) continue
      await del('records', id)
      savedSigs.delete(id)
    }

    await clear('persons')
    for (const p of persons.value) {
      await put('persons', {
        id: p.id,
        name: p.name,
        isSelf: p.isSelf,
        aliases: [...(p.aliases ?? [])],
      })
    }
    await put('settings', { id: 'defaultCurrency', value: defaultCurrency.value })
    await put('settings', { id: 'manualCounter', value: manualCounter })
    await put('settings', { id: 'noteCategories', value: noteCategories.value.map((c) => ({ ...c })) })
    /* 貼上的分享連結：使用者沒改就一直留著，重置也保留（見 resetAll） */
    await put('settings', { id: 'shareLinkText', value: linkInput.value })
    /* 匯出前要不要先檢查必填欄位 */
    await put('settings', { id: 'checkBeforeExport', value: checkBeforeExport.value })
    /*
     * 要檢查哪些欄位。Vue 的 ref 內容是 Proxy，IndexedDB 不能直接存（會丟
     * DataCloneError），所以要轉成純物件再寫進去。
     */
    await put('settings', { id: 'exportRules', value: plainCopy(exportRules.value) })
    /* 外觀：鎖定框線與選取外框的顏色 */
    await put('settings', { id: 'lockColor', value: lockColor.value })
    await put('settings', { id: 'pickColor', value: pickColor.value })
    storageError.value = ''
  } catch (e) {
    storageError.value = `資料無法存到本機：${e?.message ?? e}`
  }
}

let saveTimer
watch(
  [
    records,
    persons,
    defaultCurrency,
    noteCategories,
    linkInput,
    checkBeforeExport,
    exportRules,
    lockColor,
    pickColor,
  ],
  () => {
    clearTimeout(saveTimer)
    saveTimer = setTimeout(persist, 300)
  },
  { deep: true },
)

/*
 * 手機版：往下滑到「幣別／新增／貼上／上傳」那一列離開畫面時，把記錄清單的左右內距
 * 收掉（記錄框擴到卡片的內緣），這樣同一個方向只會看到卡片框＋記錄框，不會覺得
 * 框線很多層；那一列又滑回來就還原。只動左右，卡片自己的框與上下內距都不變，
 * 桌機（>560px）完全不受影響。
 */
const payBarEl = ref(null)
const recFlush = ref(false)
let payBarObserver = null

function watchPayBar() {
  payBarObserver?.disconnect()
  recFlush.value = false
  const bar = payBarEl.value
  if (!bar || typeof IntersectionObserver !== 'function') return
  payBarObserver = new IntersectionObserver(
    (entries) => {
      const entry = entries[entries.length - 1]
      const mobile = window.matchMedia?.('(max-width: 560px)').matches
      /* 只有「整列滑到畫面上面去」才算，還看得到一點點就還原 */
      recFlush.value = !!mobile && !entry.isIntersecting && entry.boundingClientRect.bottom <= 0
    },
    { threshold: 0 },
  )
  payBarObserver.observe(bar)
}

/* 設定頁開著時記錄卡片不在 DOM 裡，回到主畫面要重新掛一次 */
watch(view, async () => {
  await nextTick()
  watchPayBar()
})

onMounted(async () => {
  /*
   * 重新整理時人可能停在設定頁，歷史記錄裡就留著那個記號；
   * 先清掉才不會發生「按返回卻沒有反應」。
   */
  try {
    if (history.state) history.replaceState(null, '')
  } catch {
    /* 不能操作歷史記錄就算了 */
  }
  /* 直接按 Ctrl+V 也能貼上圖片 */
  document.addEventListener('paste', onPaste)
  /* 連點兩下不要放大畫面、雙指也不要縮放（見 onTouchMove 的說明） */
  document.addEventListener('touchstart', onTouchStart, { passive: true })
  document.addEventListener('touchmove', onTouchMove, { passive: false })
  document.addEventListener('touchend', onTouchEnd, { passive: false })
  /* 手機的返回手勢／返回鍵：設定頁要能退回主畫面（見 onPopState） */
  window.addEventListener('popstate', onPopState)
  /* 點空白的地方＝取消選取那一筆（記錄、表格列與對話框裡的點擊不算） */
  document.addEventListener('click', onPageClick)
  /* 程式出錯時顯示出來（不然畫面會像「卡住」，要 F5 才知道） */
  window.addEventListener('app-error', onAppError)
  /* 先開背景載入 OCR 引擎，第一次上傳就不用等 */
  preloadOcr()

  if (pasteDiagOn) {
    pasteDiag.value.api = `navigator.clipboard：${navigator.clipboard ? '有' : '沒有'}／read：${
      typeof navigator.clipboard?.read === 'function' ? '有' : '沒有'
    }／write：${typeof navigator.clipboard?.write === 'function' ? '有' : '沒有'}`
  }

  try {
    const [recs, ps, settings] = await Promise.all([
      getAll('records'),
      getAll('persons'),
      getAll('settings'),
    ])
    persons.value = ps.map((p) => ({
      id: p.id,
      name: p.name,
      isSelf: !!p.isSelf,
      aliases: p.aliases ?? [],
    }))
    records.value = recs
      .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
      .map((r) => {
        const file = storedToFile(r)
        const extraImages = (r.extraImages ?? [])
          .map((img) => {
            const extraFile = storedToFile({ ...img, fileName: `${r.fileName}-${img.id}` })
            return extraFile
              ? { ...img, file: extraFile, url: URL.createObjectURL(extraFile) }
              : null
          })
          .filter(Boolean)
        return {
          ...r,
          file,
          url: file ? URL.createObjectURL(file) : '',
          extraImages,
          ocrStatus: r.ocrStatus === 'running' ? 'pending' : r.ocrStatus,
        }
      })
    seqCounter = records.value.reduce((max, r) => Math.max(max, r.seq ?? 0), 0)
    /*
     * 記錄指到的人物不見了（匯入對不到、資料寫到一半中斷…）就自動補回來，
     * 名字用記錄裡存的快照。補不回來的（舊資料沒有名字）只提示，不亂補。
     */
    const healed = restoreMissingPersons(persons.value, records.value)
    if (healed.restored.length) persons.value = healed.persons
    const stillMissing = records.value.filter((r) => missingPersonIds(persons.value, r).length)
    const personNotices = []
    if (healed.restored.length) {
      personNotices.push(
        `已自動補回 ${healed.restored.length} 位人物：${healed.restored.map((p) => p.name).join('、')}`,
      )
    }
    if (stillMissing.length) {
      personNotices.push(
        `${stillMissing.length} 筆記錄的付錢人或受益人不在人物清單裡，` +
          '而且沒有留下名字可以補回來，請在那幾筆記錄上重新選擇。',
      )
    }
    if (personNotices.length) actionNotice.value = personNotices.join('\n')
    defaultCurrency.value = settings.find((s) => s.id === 'defaultCurrency')?.value ?? ''
    /* 備注分類：第一次用給預設清單，之後以存下來的為準 */
    const savedNotes = settings.find((s) => s.id === 'noteCategories')?.value
    if (Array.isArray(savedNotes)) noteCategories.value = normalizeNoteCategories(savedNotes)
    /* 上次貼上的分享連結：使用者沒改就一直在（重置也不會清掉） */
    linkInput.value = settings.find((s) => s.id === 'shareLinkText')?.value ?? ''
    /* 匯出前檢查：預設要檢查（舊資料沒有這個設定時也是要檢查） */
    checkBeforeExport.value = settings.find((s) => s.id === 'checkBeforeExport')?.value !== false
    /* 要檢查哪些欄位：舊資料沒有就用預設規則 */
    exportRules.value = normalizeRules(settings.find((s) => s.id === 'exportRules')?.value)
    /* 外觀顏色：存壞了或沒存過就回到預設色 */
    lockColor.value = normalizeHex(settings.find((s) => s.id === 'lockColor')?.value) || DEFAULT_LOCK_COLOR
    pickColor.value = normalizeHex(settings.find((s) => s.id === 'pickColor')?.value) || DEFAULT_PICK_COLOR
    const links = settings.find((s) => s.id === 'appliedShareLinks')?.value
    appliedLinks = Array.isArray(links) ? links : []
    /* 手動新增的編號：照建立順序重排一次（刪過的話號碼會補回來） */
    renumberManualRecords()
    records.value.forEach((r) => savedSigs.set(r.id, signature(serializeRecord(r))))
    /* 讀完本機資料才處理分享連結，才知道哪些人物已經有了 */
    applyShareParams()

    /* 舊版把 File 直接存進 IndexedDB，Safari 會讀不回來：全部改存 bytes 一次 */
    const storeVersion = settings.find((s) => s.id === 'imageStore')?.value ?? 1
    if (storeVersion < IMAGE_STORE_VERSION) {
      savedSigs.clear()
      await persist()
      await put('settings', { id: 'imageStore', value: IMAGE_STORE_VERSION })
      if (brokenImageNames.value.length) {
        actionNotice.value = `有 ${brokenImageNames.value.length} 張圖片的資料已經損毀、讀不到：${brokenImageNames.value
          .slice(0, 5)
          .join('、')}${brokenImageNames.value.length > 5 ? '…' : ''}\n這幾筆記錄的其他資料都在，但圖片請重新上傳。`
      }
    }
  } catch (e) {
    storageError.value = `讀不到本機資料：${e?.message ?? e}`
  }
  await nextTick()
  watchPayBar()
  runOcr()
})

onUnmounted(() => {
  payBarObserver?.disconnect()
  document.removeEventListener('paste', onPaste)
  document.removeEventListener('touchstart', onTouchStart)
  document.removeEventListener('touchmove', onTouchMove)
  document.removeEventListener('touchend', onTouchEnd)
  window.removeEventListener('popstate', onPopState)
  document.removeEventListener('click', onPageClick)
  clearInterval(nowTimer)
  window.removeEventListener('app-error', onAppError)
})
</script>

<template>
  <div class="page">
    <!-- ================= 設定頁 ================= -->
    <div v-if="view === 'settings'" class="view-settings" @click="toggleHint">
      <header class="head head-settings">
        <div class="head-text">
          <h1>設定</h1>
          <p class="hint">分類管理、顏色、更新、資料統計與版本資訊。</p>
        </div>
        <div class="head-btns">
          <!-- 手機版做成 iOS 那樣的「‹ 主頁」（這一條會固定在畫面最上面，往下捲也不會消失） -->
          <button class="btn back-btn" @click="closeSettings">
            <svg
              class="back-chevron only-rwd"
              viewBox="0 0 24 24"
              width="15"
              height="15"
              fill="none"
              stroke="currentColor"
              stroke-width="2.6"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M15 5l-7 7 7 7" />
            </svg>
            <span class="full-label">返回</span><span class="short-label">主頁</span>
          </button>
        </div>
      </header>

      <p v-if="backupNotice" class="notice">
        {{ backupNotice }}
        <button type="button" class="link" @click="backupNotice = ''">知道了</button>
      </p>

      <!-- 分類管理：平常收起來，按標題才展開 -->
      <section class="card">
        <details class="fold">
          <summary>
            <span class="fold-title">備注分類管理</span>
            <span class="count">{{ noteCategories.length }}</span>
          </summary>
          <div class="fold-body">
            <p class="hint">
              這些是備注欄位右邊圖示按下去會出現的常用分類。點名稱可以改名，箭頭調整順序。
            </p>

            <div class="cat-add">
              <input
                v-model="newCategory"
                class="input"
                placeholder="輸入新的分類名稱…"
                @keyup.enter="addCategoryFromInput"
              />
              <button
                class="btn btn-primary"
                :class="{ 'is-busy': !newCategory.trim() }"
                :aria-disabled="!newCategory.trim()"
                @click="addCategoryFromInput"
              >
                新增
              </button>
            </div>

            <p v-if="!noteCategories.length" class="empty">還沒有任何分類，先在上面輸入一個。</p>

            <ul v-else class="cat-list">
              <li v-for="(c, i) in noteCategories" :key="`${c.text}-${i}`" class="cat">
                <button type="button" class="cat-name" title="點一下改名" @click="renameCategory(c.text)">
                  {{ c.text }}
                </button>
                <span v-if="c.link" class="tag">連結</span>
                <span class="spacer" />
                <button
                  class="btn btn-icon"
                  :class="{ 'is-busy': i === 0 }"
                  :aria-disabled="i === 0"
                  title="往上移"
                  @click="moveCategory(i, -1)"
                >
                  ↑
                </button>
                <button
                  class="btn btn-icon"
                  :class="{ 'is-busy': i === noteCategories.length - 1 }"
                  :aria-disabled="i === noteCategories.length - 1"
                  title="往下移"
                  @click="moveCategory(i, 1)"
                >
                  ↓
                </button>
                <button class="btn btn-icon btn-danger" title="刪除" @click="deleteCategory(c.text)">
                  刪除
                </button>
              </li>
            </ul>
          </div>
        </details>
      </section>

      <section class="card">
        <div class="card-head card-head-inline">
          <h2>分享連結</h2>
        </div>
        <p class="hint">
          貼上分享連結可以把人物、預設幣別與備注分類一次帶進來（例如
          <code>?persons=Vincent,Ben&amp;currency=CNY&amp;notes=吃_早餐</code>）。
          加到手機主畫面的 App 有可能讀不到網址上的參數，就在這裡貼。
        </p>
        <div class="apply-link-row">
          <input
            v-model="linkInput"
            class="input"
            type="text"
            inputmode="url"
            autocapitalize="off"
            autocorrect="off"
            spellcheck="false"
            placeholder="貼上分享連結…"
            @keyup.enter="applyLinkInput"
          />
          <!-- 生成：把現在的人物、預設幣別與備注分類做成連結（放在「套用」左邊） -->
          <button class="btn btn-icon generate-btn" @click="generateShareLink">生成</button>
          <!-- 複製：把框裡的連結複製到剪貼簿（也在「套用」左邊，整排不換行） -->
          <button
            class="btn btn-icon copy-btn"
            :class="{ 'is-busy': !linkInput.trim() }"
            :aria-disabled="!linkInput.trim()"
            title="複製框裡的分享連結"
            @click="copyShareLink"
          >
            複製
          </button>
          <button
            class="btn btn-icon btn-primary"
            :class="{ 'is-busy': !linkInput.trim() }"
            :aria-disabled="!linkInput.trim()"
            @click="applyLinkInput"
          >
            套用
          </button>
        </div>
        <p class="hint">
          「生成」會把<strong>現在的人物、預設幣別與所有備注分類</strong>做成上面那種連結，
          填進框裡並複製到剪貼簿，可以傳給別人（或自己在另一台裝置開）。
        </p>
        <p class="hint">
          貼上的內容會留在這個框裡（除非你自己改掉或清空），重置也不會消失；
          從連結帶進來的備注分類也一樣會保留。
        </p>
      </section>

      <section class="card">
        <div class="card-head card-head-inline">
          <h2>顯示模式</h2>
        </div>
        <p class="hint">
          普通文字模式只會把「付款記錄」那一區變成表格（每列只剩一個「圖片」按鈕），
          其他區塊都不變。再按一次這個按鈕就會切回正常模式；重新整理或重新打開 App
          也會回到正常模式。
        </p>
        <button
          class="btn"
          :class="{ 'btn-primary': plainMode }"
          :aria-pressed="plainMode ? 'true' : 'false'"
          @click="togglePlainMode"
        >
          {{ plainMode ? '切換回正常模式' : '切換成普通文字模式' }}
        </button>
        <p class="hint">目前：{{ plainMode ? '普通文字模式' : '正常模式' }}</p>
      </section>

      <!-- 顏色：鎖定框線與選取外框（7 個內建色 ＋ 自己輸入 HTML 色碼） -->
      <section class="card">
        <div class="card-head card-head-inline">
          <h2>顏色</h2>
        </div>
        <p class="hint">
          「鎖定框線」是鎖定那一筆記錄時的外框與標記；「選取顏色」是你點某一筆時亮起來的外框
          （正常模式的卡片與普通文字模式的整列都是）。除了下面七個內建色，也可以直接輸入自己的
          HTML 色碼，例如 <code>#e07297</code>。
        </p>

        <div class="color-row">
          <span class="lbl">鎖定框線顏色</span>
          <div class="swatches">
            <button
              v-for="c in COLOR_PRESETS"
              :key="`lock-${c.hex}`"
              type="button"
              class="swatch"
              :class="{ on: lockColor === c.hex }"
              :style="{ background: c.hex }"
              :title="c.name"
              :aria-label="`鎖定框線用${c.name}`"
              :aria-pressed="lockColor === c.hex ? 'true' : 'false'"
              @click="lockColor = c.hex"
            />
          </div>
          <div class="color-code-row">
            <input
              v-model="lockDraft"
              class="input color-code"
              type="text"
              maxlength="7"
              spellcheck="false"
              autocapitalize="off"
              autocorrect="off"
              placeholder="#e07297"
              aria-label="鎖定框線的 HTML 色碼"
              @change="applyColorDraft('lock')"
              @keyup.enter="applyColorDraft('lock')"
            />
            <button type="button" class="btn btn-icon" @click="lockColor = DEFAULT_LOCK_COLOR">預設色</button>
          </div>
          <p v-if="badColor === 'lock'" class="hint color-bad">
            色碼要像 <code>#e07297</code>（3 或 6 位十六進位），已還原成目前用的顏色。
          </p>
        </div>

        <div class="color-row">
          <span class="lbl">選取顏色</span>
          <div class="swatches">
            <button
              v-for="c in COLOR_PRESETS"
              :key="`pick-${c.hex}`"
              type="button"
              class="swatch"
              :class="{ on: pickColor === c.hex }"
              :style="{ background: c.hex }"
              :title="c.name"
              :aria-label="`選取外框用${c.name}`"
              :aria-pressed="pickColor === c.hex ? 'true' : 'false'"
              @click="pickColor = c.hex"
            />
          </div>
          <div class="color-code-row">
            <input
              v-model="pickDraft"
              class="input color-code"
              type="text"
              maxlength="7"
              spellcheck="false"
              autocapitalize="off"
              autocorrect="off"
              placeholder="#2f6f4e"
              aria-label="選取外框的 HTML 色碼"
              @change="applyColorDraft('pick')"
              @keyup.enter="applyColorDraft('pick')"
            />
            <button type="button" class="btn btn-icon" @click="pickColor = DEFAULT_PICK_COLOR">預設色</button>
          </div>
          <p v-if="badColor === 'pick'" class="hint color-bad">
            色碼要像 <code>#2f6f4e</code>（3 或 6 位十六進位），已還原成目前用的顏色。
          </p>
        </div>

        <p class="hint">顏色存在本機，重新整理或重開 App 都還在；「重置」不會清掉這個設定。</p>
      </section>

      <section class="card">
        <div class="card-head card-head-inline">
          <h2>匯出文字（不含圖片）</h2>
        </div>
        <p class="hint">
          <code>付錢人 → 受益人 → 錢 → 備注 → 付款時間</code>，Tab 分隔、第一行是欄位名稱；
          貼到 Excel 會自動分欄。付款時間沒填的就留空。
        </p>
        <div class="head-actions">
          <button class="btn" @click="exportTextOnly">下載 .txt</button>
          <button class="btn btn-primary" @click="copyTextOnly">複製文字</button>
        </div>
      </section>

      <!-- 匯出前的檢查：預設要檢查，關掉之後就不會擋 -->
      <section class="card">
        <div class="card-head card-head-inline">
          <h2>匯出前先檢查</h2>
        </div>
        <label class="checkbox">
          <input v-model="checkBeforeExport" type="checkbox" />
          匯出前先檢查每筆記錄的必填欄位
        </label>
        <p class="hint">
          勾選時，按「匯出」（JSON 備份）或上面的「下載 .txt」會先檢查每筆記錄；有缺會列出是哪幾筆、
          缺什麼，並停下不匯出。<strong>圖片不算必填</strong>（手動新增的記錄可以沒有圖片）。
          「複製文字」不受這個設定影響。
        </p>

        <!-- 檢查哪些欄位：勾選框 ＋ N選M 群組 -->
        <details class="fold">
          <summary>
            <span class="fold-title">檢查哪些欄位</span>
            <span class="count">{{ exportRuleSummary }}</span>
          </summary>
          <div class="fold-body">
            <p class="hint">
              勾選＝這個欄位一定要填。下面的 <strong>N選M 群組</strong>則是「這幾個欄位裡至少要有 N 個」，
              例如付款時間與備注「二選一」。同一個欄位可以放進多個群組，但<strong>要先在上面勾選</strong>
              才能選進群組；被群組用到的欄位就由群組決定要填幾個。
            </p>

            <div class="field-picks">
              <label v-for="f in EXPORT_FIELDS" :key="f.key" class="checkbox">
                <input
                  type="checkbox"
                  :checked="isFieldChecked(f.key)"
                  @change="toggleFieldChecked(f.key, $event.target.checked)"
                />
                {{ f.name }}
                <span v-if="groupsUsingField(f.key)" class="tag-in-group">在 N選M 裡</span>
              </label>
            </div>

            <div v-for="(g, i) in exportRules.groups" :key="g.id" class="rule-group">
              <div class="rule-group-head">
                <span class="rule-group-title">N選M 群組 {{ i + 1 }}</span>
                <span class="spacer" />
                <button type="button" class="btn btn-icon btn-danger" @click="removeRuleGroup(g)">
                  刪除群組
                </button>
              </div>
              <p v-if="!exportCheckedFields.length" class="hint">先在上面勾選欄位，這裡才挑得到。</p>
              <div v-else class="rule-group-fields">
                <label v-for="f in exportCheckedFields" :key="f.key" class="checkbox">
                  <input
                    type="checkbox"
                    :checked="g.fields.includes(f.key)"
                    @change="toggleGroupField(g, f.key, $event.target.checked)"
                  />
                  {{ f.name }}
                </label>
              </div>
              <div class="rule-row">
                <span class="rule-name">至少要填</span>
                <input
                  class="input rule-min"
                  type="number"
                  min="1"
                  :max="Math.max(1, g.fields.length)"
                  :value="g.min"
                  @input="setGroupMin(g, $event.target.value)"
                />
                <span class="hint">
                  個（這一組有 {{ g.fields.length }} 個欄位{{
                    g.fields.length ? `：${g.fields.map(fieldName).join('、')}` : ''
                  }}）
                </span>
              </div>
            </div>

            <div class="rule-actions">
              <button type="button" class="btn" @click="addRuleGroup">＋ 增加 N選M 群組</button>
              <button type="button" class="btn" @click="resetExportRules">DEFAULT（回復預設）</button>
            </div>
          </div>
        </details>

        <!-- 要檢查哪幾筆：新上傳的記錄預設都要檢查 -->
        <details class="fold">
          <summary>
            <span class="fold-title">要檢查哪幾筆記錄</span>
            <span class="count">{{ exportCheckedCount }} / {{ records.length }}</span>
          </summary>
          <div class="fold-body">
            <p class="hint">
              取消勾選的記錄，匯出時就不會檢查它（例如某一筆本來就沒有備注）。
              新上傳的記錄預設都會檢查。
            </p>
            <div v-if="records.length" class="rule-actions">
              <button type="button" class="btn btn-icon" @click="setAllExportCheck(true)">全部都要檢查</button>
              <button type="button" class="btn btn-icon" @click="setAllExportCheck(false)">全部都不用檢查</button>
            </div>
            <ul v-if="records.length" class="check-list">
              <li v-for="r in records" :key="r.id" class="check-item">
                <label class="checkbox">
                  <input
                    type="checkbox"
                    :checked="r.checkExport !== false"
                    @change="setExportCheck(r, $event.target.checked)"
                  />
                  <span class="check-seq">{{ seqLabels.get(r.id) ?? '' }}</span>
                  <span class="check-file" :title="r.fileName">{{ r.fileName }}</span>
                </label>
              </li>
            </ul>
            <p v-else class="hint">還沒有任何記錄。</p>
          </div>
        </details>
      </section>

      <section class="card">
        <div class="card-head card-head-inline">
          <h2>更新</h2>
        </div>
        <p class="hint">
          按下去會先問有沒有新版本，有就更新完再重新載入。加到手機主畫面的 App 沒有網址列，
          平常就用這個按鈕更新。
        </p>
        <button
          class="btn"
          :class="{ 'is-busy': refreshing }"
          :aria-disabled="refreshing"
          @click="refreshApp"
        >
          {{ refreshing ? '更新中…' : '檢查更新並重新載入' }}
        </button>
      </section>

      <section class="card">
        <div class="card-head card-head-inline">
          <h2>資料統計</h2>
        </div>
        <ul class="stat-list">
          <li><span>付款記錄</span><strong>{{ records.length }} 筆</strong></li>
          <li><span>人物</span><strong>{{ persons.length }} 位</strong></li>
          <li><span>備注分類</span><strong>{{ noteCategories.length }} 個</strong></li>
          <li>
            <span>瀏覽器已用空間</span>
            <strong>{{ mb(storageInfo.usage) }}<template v-if="storageInfo.quota"> / {{ mb(storageInfo.quota) }}</template></strong>
          </li>
          <li>
            <span>永久儲存</span>
            <strong>{{ storageInfo.persisted ? '已取得' : '未取得（空間不足時可能被清掉）' }}</strong>
          </li>
          <li>
            <span>離線快取</span>
            <strong>{{ offlineReady ? '已就緒' : '尚未就緒' }}</strong>
          </li>
        </ul>
      </section>

      <section class="card">
        <div class="card-head card-head-inline">
          <h2>版本資訊</h2>
        </div>
        <ul class="stat-list">
          <li><span>建置時間</span><strong>{{ buildTimeText }}</strong></li>
          <li><span>離線可用</span><strong>{{ offlineReady ? '是' : '重新載入一次就會好' }}</strong></li>
        </ul>
        <p class="hint">
          手機上打開時如果建置時間跟電腦看到的不一樣，就按上面的「檢查更新並重新載入」。
        </p>
      </section>
    </div>

    <!-- ================= 主畫面 ================= -->
    <template v-else>
    <header class="head">
      <div class="head-text">
        <h1>付款記錄</h1>
        <p class="hint">上傳付款截圖，自動整理成可編輯的記錄。資料只存在這台裝置的瀏覽器裡。</p>
      </div>
      <div class="head-btns">
        <button class="btn" @click="exportBackup">匯出</button>
        <button class="btn" @click="importInputEl.click()">匯入</button>
        <button class="btn" @click="openSettings">設定</button>
        <button class="btn btn-danger" @click="resetAll">重置</button>
      </div>
      <input
        ref="importInputEl"
        class="sr-only"
        type="file"
        accept="application/json,.json"
        multiple
        @change="onImportFile"
      />
    </header>

    <p v-if="backupNotice" class="notice">
      {{ backupNotice }}
      <button type="button" class="link" @click="backupNotice = ''">知道了</button>
    </p>

    <p v-if="storageError" class="alert">{{ storageError }}</p>

    <!-- 網址加 ?paste=1 才會出現：貼上測試頁（每一步都會寫出來，並且真的新增記錄） -->
    <section v-if="pasteDiagOn" class="card">
      <div class="card-head card-head-inline">
        <h2>貼上測試</h2>
      </div>
      <p class="hint">
        1. 先去 WeChat 長按圖片 → 複製。2. 在下面虛線格裡長按 →「貼上」→ 等 2～5 秒。
        3. 面板會逐張寫出「fetch / canvas / 解碼」的結果，以及最後新增了幾筆記錄。
        4. 把整段畫面截圖給我（連同微信原文純文字）。
      </p>
      <button class="btn" @click="readClipboardDiag">用剪貼簿 API 讀一次（https 才有用）</button>
      <pre v-if="pasteDiag.api" class="diag-out">{{ pasteDiag.api }}</pre>
      <div
        ref="diagBoxEl"
        class="paste-box"
        contenteditable="true"
        role="textbox"
        aria-label="長按這裡貼上圖片"
        inputmode="none"
        @paste="onDiagPaste"
      />
      <pre v-if="pasteDiag.event" class="diag-out">{{ pasteDiag.event }}</pre>
      <pre v-if="pasteDiag.dom" class="diag-out">{{ pasteDiag.dom }}</pre>
      <pre v-if="pasteDiag.grab" class="diag-out">{{ pasteDiag.grab }}</pre>
      <pre v-if="pasteDiag.result" class="diag-out">{{ pasteDiag.result }}</pre>
    </section>

    <section class="card">
      <div class="card-head card-head-inline">
        <h2>人物</h2>
        <button class="btn btn-primary" @click="openCreatePerson">新增人物</button>
      </div>

      <p v-if="!persons.length" class="empty">
        還沒有任何人物。先新增一位並勾選「這是我自己」，之後的付款人預設就是他；
        也可以到「設定」貼上分享連結，一次把人物、幣別與備注分類帶進來。
      </p>

      <ul v-else class="people">
        <li v-for="p in persons" :key="p.id" class="person">
          <span class="avatar" aria-hidden="true">{{ p.name.slice(0, 1) }}</span>
          <span class="person-name" :title="p.name">{{ p.name }}</span>
          <!-- 固定寬度的一欄：每一列的「自己」「N 筆」標籤才會左右對齊 -->
          <span class="person-meta">
            <!-- 「自己」也佔一個固定格子，沒有的時候留空，後面的標籤才不會位移 -->
            <span class="person-self">
              <span v-if="p.isSelf" class="tag">自己</span>
            </span>
            <span
              v-if="usedCount(p)"
              class="tag tag-used"
              :title="`付款人 ${personUsage(p.id).payer} 筆、受益人 ${personUsage(p.id).beneficiary} 筆，不能刪除`"
            >
              {{ usedCount(p) }} 筆
            </span>
            <span v-if="p.aliases?.length" class="aliases" :title="p.aliases.join('、')">
              別名 {{ p.aliases.join('、') }}
            </span>
          </span>
          <span class="spacer" />
          <button class="btn btn-icon" @click="openEditPerson(p)">修改</button>
          <button class="btn btn-icon btn-danger" @click="removePerson(p)">刪除</button>
        </li>
      </ul>

      <p v-if="persons.length && !selfPerson" class="hint">
        目前沒有指定「自己」，請選擇誰是自己。
      </p>
    </section>

    <section class="card card-records" :class="{ 'is-flush': recFlush }">
      <div class="card-head">
        <h2>付款記錄 <span class="count">{{ records.length }}</span></h2>
        <div ref="payBarEl" class="head-actions">
          <label class="inline-field">
            <span class="lbl"
              ><span class="full-label">預設幣別</span><span class="short-label">幣別</span></span
            >
            <select v-model="defaultCurrency" class="input" @change="applyDefaultCurrency">
              <option value="">自動</option>
              <option v-for="c in currencyOptions" :key="c" :value="c">{{ c }}</option>
            </select>
          </label>
          <button class="btn" @click="addBlankRecord">
            <span class="full-label">新增記錄</span><span class="short-label">新增</span>
          </button>
          <button class="btn" @click="pasteImages">
            <span class="full-label">貼上圖片</span><span class="short-label">貼上</span>
          </button>
          <button class="btn btn-primary" @click="fileInputEl.click()">
            <span class="full-label">上傳圖片</span><span class="short-label">上傳</span>
          </button>
        </div>
      </div>

      <input
        ref="fileInputEl"
        class="sr-only"
        type="file"
        accept="image/*"
        multiple
        @change="onPickImages"
      />

      <div v-if="ocrBusy" class="ocr-bar">
        <div class="ocr-track">
          <div class="ocr-fill" :style="{ width: `${ocrPercent}%` }" />
        </div>
        <div class="ocr-row">
          <!--
            張數是整個佇列，百分比是「這一張」現在跑到哪裡。
            百分比排在檔名前面：手機上這一行會被截掉，重要的數字要留在前面。
          -->
          <span class="hint ocr-now">
            辨識中 {{ ocrDone }}/{{ ocrTotal }}（<strong class="ocr-percent">{{ ocrFilePercent }}%</strong>）｜{{ ocrLabel }}<span
              v-if="ocrStage"
              class="ocr-stage"
              >｜{{ ocrStage }}</span
            >
          </span>
          <span class="spacer" />
          <button type="button" class="btn btn-icon" @click="skipCurrentOcr">跳過這張</button>
          <button type="button" class="btn btn-icon" @click="stopOcr">全部停止</button>
        </div>
      </div>

      <!-- 停止後還有沒辨識的：給一個繼續的按鈕 -->
      <div v-else-if="pendingOcrCount" class="ocr-bar">
        <div class="ocr-row">
          <span class="hint">有 {{ pendingOcrCount }} 張等待辨識</span>
          <span class="spacer" />
          <button type="button" class="btn btn-icon" @click="runOcr">繼續辨識</button>
        </div>
      </div>

      <p v-if="actionNotice" class="notice">
        {{ actionNotice }}
        <button type="button" class="link" @click="dismissNotices">知道了</button>
      </p>

      <p v-if="!records.length" class="empty">
        還沒有記錄。可以「上傳圖片」一次選多張、「貼上圖片」貼上剪貼簿的截圖，或「新增記錄」自己填。
      </p>

      <!-- 普通文字模式：只有文字與一個「圖片」按鈕，點欄位可以直接改 -->
      <div v-else-if="plainMode" class="plain-wrap">
        <p class="hint plain-tip">點欄位就可以直接修改（付錢人、受益人也可以選）。</p>
        <!-- 沒有圖片的那一列按「無」補圖用（跟卡片上的「無圖」一樣） -->
        <input
          ref="plainPickEl"
          class="sr-only"
          type="file"
          accept="image/*"
          @change="onPlainPick"
        />
        <table class="plain-table">
          <thead>
            <tr>
              <th>序號</th>
              <th>付錢人</th>
              <th>受益人</th>
              <th>錢</th>
              <th>備注</th>
              <th>付款時間</th>
              <th />
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="(r, i) in records"
              :key="r.id"
              class="plain-row"
              :class="{ on: selectedId === r.id, locked: r.locked }"
              @click="selectRecord(r)"
            >
              <td
                class="plain-seq"
                :title="
                  r.locked
                    ? '這筆記錄已鎖定｜點一下可以解除'
                    : `來源：${r.source || '本機'}｜點一下可重新命名`
                "
                @click="renameSourceFrom(r)"
              >
                {{ seqLabels.get(r.id) ?? '' }}
              </td>
              <td
                v-for="(cell, j) in plainRows[i] ?? []"
                :key="j"
                class="plain-cell"
                :title="r.locked ? '這筆記錄已鎖定｜點一下可以解除' : '點一下修改'"
                @click="editPlainCell(r, ['payer', 'beneficiaries', 'amount', 'note', 'time'][j])"
              >
                {{ cell || '—' }}
              </td>
              <td class="plain-img">
                <button
                  v-if="r.url"
                  class="btn btn-icon"
                  :title="imageCount(r) > 1 ? `這筆有 ${imageCount(r)} 張圖片` : '看圖片'"
                  @click="openViewer(r)"
                >
                  圖片
                  <!-- 多張圖片：加一個「多張」圖示 -->
                  <svg
                    v-if="imageCount(r) > 1"
                    viewBox="0 0 24 24"
                    width="14"
                    height="14"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    aria-hidden="true"
                  >
                    <rect x="9" y="3" width="12" height="12" rx="2" />
                    <path d="M15 21H5a2 2 0 0 1-2-2V9" />
                  </svg>
                </button>
                <!-- 沒有圖片時也可以補圖（跟卡片上的「無圖」縮圖一樣） -->
                <button
                  v-else
                  class="btn btn-icon"
                  :disabled="r.locked"
                  :title="r.locked ? '已鎖定，要補圖片請先解除' : '點一下上傳這筆的圖片'"
                  @click="pickPlainImage(r)"
                >
                  無
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-else class="recs">
        <RecordCard
          v-for="r in records"
          :key="r.id"
          :record="r"
          :persons="persons"
          :note-categories="noteCategories"
          :index-label="seqLabels.get(r.id) ?? ''"
          :active="selectedId === r.id"
          :now="nowMs"
          @view="openViewer"
          @remove="removeRecord"
          @more="openMoreRecord"
          @retry="retryOcr"
          @skip="skipOcr"
          @rename-source="renameSourceFrom"
          @pick-note="onPickNoteCategory"
          @save-note="onSaveNoteCategory"
          @attach="attachImage"
          @select="selectRecord"
        />
      </div>
    </section>
    </template>

    <dialog ref="selfDialogEl" class="dialog" @close="onSelfDialogClose">
      <form @submit.prevent="confirmSelf">
        <h3 class="dialog-head">請選擇誰是自己</h3>
        <div class="dialog-body">
          <p class="hint">
            付款記錄要知道「自己」是誰（付錢人預設就是他）。選好之後才能上傳圖片或新增記錄。
          </p>
          <div class="self-options">
            <button
              v-for="p in persons"
              :key="p.id"
              type="button"
              class="self-option"
              :class="{ on: selfChoice === p.id }"
              @click="selfChoice = p.id"
            >
              {{ p.name }}
            </button>
          </div>
        </div>
        <div class="dialog-foot">
          <button type="button" class="btn" @click="selfDialogEl.close()">取消</button>
          <button type="submit" class="btn btn-primary" :disabled="!selfChoice">確定</button>
        </div>
      </form>
    </dialog>

    <!-- 剪貼簿讀不到圖時彈出來請使用者長按貼上（iPhone Safari）。刻意不自動對焦 -->
    <dialog ref="pasteDialogEl" class="dialog paste-dialog">
      <h3 class="dialog-head">貼上圖片</h3>
      <div class="dialog-body">
        <p class="hint">{{ pasteHint }}</p>
        <div
          ref="pasteBoxEl"
          class="paste-box"
          contenteditable="true"
          role="textbox"
          aria-label="長按這裡貼上圖片"
          inputmode="none"
          @paste="onPasteBox"
        />
      </div>
      <div class="dialog-foot">
        <button type="button" class="btn" @click="closePasteDialog()">關閉</button>
      </div>
    </dialog>

    <dialog ref="alignDialogEl" class="dialog align" @close="onAlignDialogClose">
      <form @submit.prevent="confirmAlign">
        <h3 class="dialog-head">對齊人物</h3>
        <div class="dialog-body">
          <p class="hint">
            這幾個名字在匯入檔裡沒見過。請確認要對應到已經有的人，還是建立新人物。
            對應過的寫法會記成別名，以後匯入會自動套用。
          </p>
          <div v-for="p in pendingImport?.needsDecision ?? []" :key="p.id" class="align-row">
            <span class="align-name">{{ p.name }}</span>
            <select v-model="pendingImport.decisions[p.id]" class="input">
              <option value="new">建立新人物</option>
              <option v-for="e in persons" :key="e.id" :value="e.id">
                對應到 {{ e.name }}{{ e.isSelf ? '（自己）' : '' }}
              </option>
            </select>
          </div>
        </div>
        <div class="dialog-foot">
          <button type="button" class="btn" @click="cancelAlign">取消匯入</button>
          <button type="submit" class="btn btn-primary">確定並匯入</button>
        </div>
      </form>
    </dialog>

    <!-- 更多：鎖定／解除與刪除（刪除鈕從卡片搬到這裡，免得誤按） -->
    <dialog ref="moreDialogEl" class="dialog more" @close="moreRecord = null">
      <h3 class="dialog-head">更多</h3>
      <div v-if="moreRecord" class="dialog-body">
        <p class="more-title">
          <span class="more-seq">{{ seqLabels.get(moreRecord.id) ?? '' }}</span>
          <span class="more-file" :title="moreRecord.fileName">{{ moreRecord.fileName }}</span>
        </p>

        <p v-if="moreRecord.locked" class="more-state more-state-locked">
          已鎖定：這筆記錄的付錢人、付款時間、金額、備注、受益人、重新辨識與補圖都不能改，
          圖片還是可以按「圖片」放大看。
        </p>
        <p v-else class="more-state">
          鎖定之後，這筆記錄的欄位、受益人、重新辨識與補圖都會停用（圖片還是可以放大看）；
          之後按「解除」就會恢復正常編輯，但「這張圖有多個金額，用哪一個？」不會再出現。
        </p>

        <button
          type="button"
          class="btn more-lock"
          :class="{ 'btn-primary': !moreRecord.locked }"
          @click="toggleLockFromMore"
        >
          {{ moreRecord.locked ? '解除鎖定' : '鎖定這筆記錄' }}
        </button>
        <button type="button" class="btn btn-danger more-delete" @click="deleteFromMore">
          刪除這筆記錄
        </button>
      </div>
      <div class="dialog-foot">
        <button type="button" class="btn" @click="closeMoreRecord()">關閉</button>
      </div>
    </dialog>

    <dialog ref="viewerEl" class="dialog viewer" @close="viewing = null">
      <div v-if="viewing" class="viewer-body">
        <div class="viewer-bar">
          <span class="file" :title="currentImage?.fileName || viewing.fileName">
            {{ currentImage?.fileName || viewing.fileName }}
          </span>
          <!-- 這一筆有幾張圖片、現在看第幾張 -->
          <span v-if="viewingImages.length > 1" class="img-counter">
            {{ viewIndex + 1 }} / {{ viewingImages.length }}
          </span>
          <span v-else-if="viewingImages.length === 1" class="img-counter">1 / 1</span>
          <span class="hint">{{ fmtDateTime(viewing.fileTime) }}</span>
          <!-- 手機版：百分比放在日期右邊；桌機版這顆隱藏，用下面群組裡那顆 -->
          <span class="zoom-value only-rwd">{{ Math.round(zoom * 100) }}%</span>
          <span class="spacer" />
          <span class="zoom-group">
            <!-- 桌機版：百分比放在「縮小」左邊 -->
            <span class="zoom-value">{{ Math.round(zoom * 100) }}%</span>
            <button type="button" class="btn btn-icon" aria-label="縮小" title="縮小" @click="zoomBy(1 / 1.25)">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <circle cx="10.5" cy="10.5" r="6.5" />
                <path d="M15.2 15.2 20 20" />
                <path d="M7.5 10.5h6" />
              </svg>
            </button>
            <button type="button" class="btn btn-icon" aria-label="放大" title="放大" @click="zoomBy(1.25)">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <circle cx="10.5" cy="10.5" r="6.5" />
                <path d="M15.2 15.2 20 20" />
                <path d="M10.5 7.5v6M7.5 10.5h6" />
              </svg>
            </button>
            <button type="button" class="btn btn-icon" @click="resetZoom">還原</button>
          </span>
        </div>

        <!-- 上一張／下一張與圖片管理（鎖定時只能看） -->
        <div class="viewer-gal">
          <button
            type="button"
            class="btn btn-icon gal-nav"
            :class="{ 'is-busy': viewingImages.length < 2 }"
            :aria-disabled="viewingImages.length < 2"
            aria-label="上一張"
            title="上一張"
            @click="stepImage(-1)"
          >
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M15 5l-7 7 7 7" />
            </svg>
          </button>
          <button
            type="button"
            class="btn btn-icon gal-nav"
            :class="{ 'is-busy': viewingImages.length < 2 }"
            :aria-disabled="viewingImages.length < 2"
            aria-label="下一張"
            title="下一張"
            @click="stepImage(1)"
          >
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M9 5l7 7-7 7" />
            </svg>
          </button>
          <span class="spacer" />
          <template v-if="!viewing.locked">
            <button type="button" class="btn btn-icon" aria-label="上傳圖片" title="上傳圖片" @click="viewerPickEl.click()">
              上傳
            </button>
            <button
              type="button"
              class="btn btn-icon"
              :class="{ 'is-busy': currentImage?.isMain }"
              :aria-disabled="currentImage?.isMain"
              aria-label="設為縮圖"
              title="設為縮圖：把目前這張變成卡片的縮圖（並用它重新辨識）"
              @click="setViewerImageAsMain"
            >
              預設
            </button>
            <button
              type="button"
              class="btn btn-icon btn-danger gal-trash"
              aria-label="刪除這張"
              title="刪除這張圖片"
              @click="deleteViewerImage"
            >
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M4 7h16" />
                <path d="M9 7V5h6v2" />
                <path d="M6 7l1 13h10l1-13" />
                <path d="M10 11v6M14 11v6" />
              </svg>
            </button>
          </template>
          <span v-else class="hint">已鎖定：只能看圖，要加圖或刪圖請先解除</span>
          <input
            ref="viewerPickEl"
            class="sr-only"
            type="file"
            accept="image/*"
            multiple
            @change="addViewerImages"
          />
        </div>

        <p v-if="viewerMsg" class="viewer-msg">{{ viewerMsg }}</p>

        <div class="viewer-stage" @wheel.ctrl.prevent="zoomBy($event.deltaY < 0 ? 1.1 : 1 / 1.1)">
          <img
            v-if="currentImage"
            :src="currentImage.url"
            :alt="currentImage.fileName"
            :style="{ width: `${zoom * 100}%` }"
            @click="onViewerImageClick"
          />
        </div>
        <div class="viewer-foot">
          <span class="hint hide-rwd">
            Ctrl + 滾輪也可以縮放｜一筆記錄可以放多張圖片，第三顆按鈕是「設為縮圖」
          </span>
          <span class="spacer" />
          <!-- 手機版才出現：縮放按鈕排在關閉的左邊（桌機版用上面那一組） -->
          <span class="zoom-group">
            <button type="button" class="btn btn-icon" aria-label="縮小" title="縮小" @click="zoomBy(1 / 1.25)">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <circle cx="10.5" cy="10.5" r="6.5" />
                <path d="M15.2 15.2 20 20" />
                <path d="M7.5 10.5h6" />
              </svg>
            </button>
            <button type="button" class="btn btn-icon" aria-label="放大" title="放大" @click="zoomBy(1.25)">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <circle cx="10.5" cy="10.5" r="6.5" />
                <path d="M15.2 15.2 20 20" />
                <path d="M10.5 7.5v6M7.5 10.5h6" />
              </svg>
            </button>
            <button type="button" class="btn btn-icon" @click="resetZoom">還原</button>
          </span>
          <button type="button" class="btn" @click="closeViewer()">關閉</button>
        </div>
      </div>
    </dialog>

    <!-- autofocus 放在對話框本身：不要讓瀏覽器自動聚焦名稱輸入框（手機會跳鍵盤） -->
    <dialog ref="personDialogEl" class="dialog" autofocus>
      <form @submit.prevent="savePerson">
        <h3 class="dialog-head">{{ draft.id ? '修改人物' : '新增人物' }}</h3>
        <div class="dialog-body">
          <p v-if="draft.id" class="usage-line">
            記錄使用：
            <strong>付款人 {{ personUsage(draft.id).payer }} 筆</strong>
            <span class="sep">·</span>
            <strong>受益人 {{ personUsage(draft.id).beneficiary }} 筆</strong>
          </p>
          <div class="field">
            <label for="person-name">名稱</label>
            <input
              id="person-name"
              v-model="draft.name"
              class="input"
              autocomplete="off"
              placeholder="例如：我自己、陳大文"
            />
          </div>
          <label class="checkbox">
            <input v-model="draft.isSelf" type="checkbox" />
            這是我自己（付款人預設選他）
          </label>
          <div class="field">
            <label for="person-aliases">別名（用逗號分隔，可以留空）</label>
            <input
              id="person-aliases"
              v-model="draft.aliasesText"
              class="input"
              autocomplete="off"
              placeholder="例如：vincent、餅"
            />
            <span class="hint">匯入時遇到這些寫法，會自動對到這個人。</span>
          </div>
          <p v-if="err" class="err">{{ err }}</p>

          <!-- 合併：把這個人併到另一位（記錄會一起改過去） -->
          <div v-if="draft.id && otherPersons.length" class="merge-box">
            <h4 class="merge-title">合併到另一位人物</h4>
            <p class="hint">
              記錄裡的付款人與受益人都會改成對方，「{{ draft.name }}」會變成別名，
              之後匯入同樣的寫法也會自動對上。
            </p>
            <div class="merge-row">
              <select v-model="mergeTargetId" class="input" aria-label="合併到">
                <option value="">請選擇要合併到誰</option>
                <option v-for="p in otherPersons" :key="p.id" :value="p.id">
                  {{ p.name }}{{ p.isSelf ? '（自己）' : '' }}
                </option>
              </select>
              <button
                type="button"
                class="btn btn-danger"
                :class="{ 'is-busy': !mergeTargetId }"
                :aria-disabled="!mergeTargetId"
                @click="mergeInto"
              >
                合併
              </button>
            </div>
          </div>
        </div>
        <div class="dialog-foot">
          <button type="button" class="btn" @click="personDialogEl.close()">取消</button>
          <button type="submit" class="btn btn-primary">儲存</button>
        </div>
      </form>
    </dialog>
  </div>
</template>

<style scoped>
.page {
  max-width: 1080px;
  margin: 0 auto;
  padding: 28px 16px 72px;
}

.head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 18px;
}

.head-btns {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.head h1 {
  font-size: 26px;
  letter-spacing: -0.02em;
}

.card {
  margin-bottom: 16px;
  padding: 20px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface);
  box-shadow: var(--shadow);
}

.card-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 16px;
}

.card-head h2 {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 15px;
  letter-spacing: 0.01em;
}

.card-head h2::before {
  content: '';
  width: 4px;
  height: 15px;
  border-radius: 2px;
  background: var(--accent);
}

.head-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.inline-field {
  display: flex;
  align-items: center;
  gap: 6px;
}

.inline-field .input {
  width: auto;
  min-height: 34px;
}

.count {
  margin-left: 2px;
  padding: 1px 8px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--surface-2);
  color: var(--muted);
  font-size: 12px;
  font-weight: 550;
  font-variant-numeric: tabular-nums;
}

.people {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}

/* ---------- 設定頁：可收合區塊、分類管理與資料統計 ---------- */
/* 設定頁：說明文字平常只有一行，點一下才展開（見 toggleHint） */
.view-settings .hint {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: pointer;
}

.view-settings .hint.open {
  white-space: normal;
  overflow: visible;
}

/* 收合的小標籤（幾筆／幾個）不是說明文字，不要被截成一行 */
.view-settings .fold summary .count {
  flex: 0 0 auto;
}

.fold summary {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  list-style: none;
}

.fold summary::-webkit-details-marker {
  display: none;
}

.fold-title {
  font-size: 16px;
  font-weight: 640;
}

/* 收合指示：收起時指右邊，展開時指下面 */
.fold summary::after {
  content: '';
  margin-left: auto;
  width: 8px;
  height: 8px;
  border-right: 2px solid var(--muted);
  border-bottom: 2px solid var(--muted);
  transform: rotate(-45deg);
  transition: transform 0.15s;
}

.fold[open] summary::after {
  transform: rotate(45deg);
}

.fold-body {
  margin-top: 12px;
}

/* 匯出前檢查：欄位與群組裡的選項都一行一個（從上到下、不要並排） */
.rule-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.rule-name {
  flex: 0 0 auto;
  width: 72px;
  color: var(--muted);
  font-size: 13px;
}

.rule-row .input {
  flex: 0 0 auto;
  min-width: 0;
}

/* 檢查哪些欄位：一行一個勾選框 */
.field-picks {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 12px;
}

.field-picks .checkbox {
  font-size: 14px;
}

/* 在 N選M 群組裡的欄位加一個小標記 */
.tag-in-group {
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 11px;
  font-weight: 600;
}

/* 一個 N選M 群組 */
.rule-group {
  margin-bottom: 10px;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--surface-2);
}

.rule-group-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.rule-group-title {
  font-size: 13px;
  font-weight: 650;
}

.rule-group-fields {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 10px;
}

/* 「至少要填 N 個」的數字框窄一點 */
.rule-min {
  flex: 0 0 auto;
  width: 84px;
  min-width: 0;
}

.rule-group .rule-row {
  margin-bottom: 0;
}

/* 「這一組有 X 個欄位…」這一句自己一行（手機上不會擠在數字旁邊） */
.rule-group .rule-row .hint {
  flex: 1 0 100%;
}

.rule-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 10px;
}

/* 要檢查哪幾筆：一列一筆（序號＋檔名） */
.check-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 300px;
  overflow: auto;
  margin: 0;
  padding: 0;
  list-style: none;
}

.check-item {
  padding: 6px 10px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--surface-2);
}

.check-item .checkbox {
  width: 100%;
  min-width: 0;
}

.check-seq {
  flex: 0 0 auto;
  color: var(--muted);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.check-file {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
}

.fold + .fold {
  margin-top: 10px;
}

.cat-add {
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
}

.cat-add .input {
  flex: 1 1 auto;
  min-width: 0;
}

.cat-add .btn {
  flex: 0 0 auto;
}

.cat-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.cat {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--surface-2);
}

.cat-name {
  min-width: 0;
  overflow: hidden;
  padding: 4px 6px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--text);
  font: inherit;
  font-size: 14px;
  text-align: left;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
}

.cat-name:hover {
  background: var(--accent-soft);
  color: var(--accent);
}

.cat .btn-icon {
  flex: 0 0 auto;
  min-width: 36px;
  padding: 0 8px;
}

/* ---------- 普通文字模式：表格（同一列的資料不分行，太寬就橫向捲動） ---------- */
.plain-wrap {
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
}

.plain-tip {
  margin-bottom: 8px;
}

.plain-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
  /* 同一列的資料不分行 */
  white-space: nowrap;
}

.plain-table th,
.plain-table td {
  padding: 8px 10px;
  border-bottom: 1px solid var(--line);
  text-align: left;
  vertical-align: top;
}

.plain-table th {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--surface);
  color: var(--muted);
  font-size: 12px;
  font-weight: 600;
}

.plain-table td {
  font-variant-numeric: tabular-nums;
}

/*
 * 表格裡的欄位格：不要圓角——選取時畫出來的外框是直的（方框），
 * 有圓角的話每一格的框會變成弧形，看起來像一排小按鈕。
 */
.plain-cell {
  border-radius: 0;
  cursor: pointer;
}

/*
 * 被點到的那一列：整列的外框亮起來（跟正常模式的卡片一樣）。
 * 用 inset 的 box-shadow 畫框，表格列（tr）在 Safari 上不吃 outline。
 * 顏色跟著「設定 → 顏色 → 選取顏色」（--pick，預設＝原本的綠色）。
 */
.plain-row.on td {
  background: var(--pick-soft);
  box-shadow: inset 0 2px 0 var(--pick), inset 0 -2px 0 var(--pick);
}

.plain-row.on td:first-child {
  box-shadow: inset 2px 0 0 var(--pick), inset 0 2px 0 var(--pick), inset 0 -2px 0 var(--pick);
}

.plain-row.on td:last-child {
  box-shadow: inset -2px 0 0 var(--pick), inset 0 2px 0 var(--pick), inset 0 -2px 0 var(--pick);
}

.plain-row.on .plain-seq {
  color: var(--pick);
  font-weight: 600;
}

/* 已鎖定的那一列：框改成玫瑰色（跟卡片一樣），內容文字全部變灰，點下去只會問要不要解除 */
.plain-row.locked td {
  color: var(--muted);
  box-shadow: inset 0 2px 0 var(--lock), inset 0 -2px 0 var(--lock);
}

/* 鎖定時滑過去看起來像「不能改」，不要再用綠色騙人 */
.plain-row.locked .plain-cell:hover {
  background: var(--lock-soft);
  color: var(--muted);
}

.plain-row.locked td:first-child {
  box-shadow: inset 2px 0 0 var(--lock), inset 0 2px 0 var(--lock), inset 0 -2px 0 var(--lock);
}

.plain-row.locked td:last-child {
  box-shadow: inset -2px 0 0 var(--lock), inset 0 2px 0 var(--lock), inset 0 -2px 0 var(--lock);
}

.plain-row.locked.on td {
  background: var(--lock-soft);
}

.plain-row.locked .plain-seq {
  color: var(--lock-dark);
  font-weight: 600;
}

.plain-cell:hover {
  background: var(--accent-soft);
  color: var(--accent);
}

/* 序號（來源-序號）：點一下可以重新命名來源，跟正常模式一樣 */
.plain-table td.plain-seq {
  color: var(--muted);
  font-size: 12px;
  cursor: pointer;
}

.plain-table td.plain-seq:hover {
  color: var(--accent);
}

.plain-table td.plain-img {
  text-align: right;
}

.stat-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.stat-list li {
  display: flex;
  align-items: baseline;
  gap: 12px;
  font-size: 14px;
}

.stat-list span {
  color: var(--muted);
}

.stat-list strong {
  margin-left: auto;
  font-weight: 600;
  text-align: right;
}

/* 分享連結：輸入框 + 生成 + 複製 + 套用（手機上也要擠得進同一行，不換行） */
.apply-link-row {
  display: flex;
  flex-wrap: nowrap;
  gap: 6px;
}

.apply-link-row .input {
  flex: 1 1 auto;
  min-width: 0;
}

.apply-link-row .btn {
  flex: 0 0 auto;
  padding: 0 10px;
}

/* 三個按鈕都在同一行：手機上把左右內距縮小一點，輸入框才不會被擠到換行 */
@media (max-width: 560px) {
  .apply-link-row {
    gap: 5px;
  }

  .apply-link-row .btn {
    padding: 0 8px;
  }
}

/* ---------- 設定 → 顏色 ---------- */
.color-row {
  margin-top: 14px;
}

.color-row .lbl {
  display: block;
  margin-bottom: 6px;
}

.swatches {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 10px;
}

.swatch {
  width: 30px;
  height: 30px;
  padding: 0;
  border: 1px solid rgba(0, 0, 0, 0.14);
  border-radius: 50%;
  cursor: pointer;
  transition: box-shadow 0.14s, transform 0.14s;
}

.swatch:hover {
  transform: scale(1.06);
}

/* 選到的那一個：外面再套一圈深色（用兩層 box-shadow 畫，不會影響版面） */
.swatch.on {
  box-shadow: 0 0 0 2px var(--surface), 0 0 0 4px var(--text);
}

.color-code-row {
  display: flex;
  align-items: center;
  gap: 6px;
}

.color-code {
  flex: 0 0 auto;
  width: 118px;
  font-variant-numeric: tabular-nums;
}

.color-bad {
  color: var(--danger);
}

.apply-link-row code,
.card .hint code {
  padding: 1px 5px;
  border: 1px solid var(--line);
  border-radius: 5px;
  background: var(--surface);
  font-size: 12px;
  word-break: break-all;
}

.person {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--surface-2);
  transition: border-color 0.14s, background 0.14s;
}

.person:hover {
  border-color: var(--line-strong);
  background: var(--surface);
}

.avatar {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border-radius: 50%;
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 14px;
  font-weight: 650;
}

.person-name {
  /* 固定寬度：名字長短不一樣時，「自己」「N 筆」的欄位才會對齊 */
  flex: 0 0 auto;
  width: 104px;
  min-width: 0;
  overflow: hidden;
  font-weight: 550;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/*
 * 標籤欄：固定寬度，每一列的標籤都從同一個位置開始。
 * 名字太長的用 … 收掉（滑過去看得到全名）。
 */
.person-meta {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 6px;
  width: 158px;
  min-width: 0;
}

/* 「自己」的固定格子：沒有這個標籤時也留著同樣的寬度 */
.person-self {
  display: flex;
  flex: 0 0 auto;
  width: 46px;
}

.tag {
  flex: 0 0 auto;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 12px;
  font-weight: 600;
}

/* 有記錄用到的人物：不能刪除 */
.tag-used {
  background: var(--warn-soft);
  color: var(--warn);
  font-variant-numeric: tabular-nums;
}

.aliases {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  padding: 2px 8px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--surface);
  color: var(--muted);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.align {
  width: min(520px, calc(100vw - 32px));
}

.align-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr);
  align-items: center;
  gap: 10px;
}

.align-name {
  overflow: hidden;
  padding: 8px 11px;
  border: 1px dashed var(--line-strong);
  border-radius: var(--radius-sm);
  background: var(--surface-2);
  font-weight: 550;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.self-options {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.self-option {
  min-height: 40px;
  padding: 0 15px;
  border: 1px solid var(--line-strong);
  border-radius: 999px;
  background: var(--surface);
  font-size: 14px;
  cursor: pointer;
  transition: background 0.14s, border-color 0.14s, color 0.14s;
}

.self-option:hover {
  border-color: var(--muted);
}

.self-option.on {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent);
  font-weight: 600;
}

.spacer {
  flex: 1;
}

.recs {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* 長按貼上框（彈出視窗與貼上診斷都用這個） */
.paste-dialog {
  width: min(420px, calc(100vw - 32px));
}

/*
 * 字級刻意設 16px：iOS 對小於 16px 的輸入框會在對焦時把整頁放大。
 * 高度固定住，不會因為貼上內容而變形。
 */
.paste-box {
  margin: 12px 0;
  padding: 18px 14px;
  min-height: 96px;
  border: 1px dashed var(--line-strong);
  border-radius: var(--radius-sm);
  background: var(--surface-2);
  color: var(--muted);
  font-size: 16px;
  line-height: 1.5;
  text-align: center;
  cursor: text;
  overflow: hidden;
}

.paste-box img {
  max-width: 100%;
  max-height: 160px;
}

.paste-box:empty::before {
  content: '長按這裡 → 選「貼上」';
}

.paste-box:focus {
  border-color: var(--accent);
  color: var(--accent);
  outline: none;
}

/* 診斷輸出（可直接選取、複製） */
.diag-out {
  margin: 10px 0 0;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--surface);
  color: var(--text);
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-all;
}

.ocr-bar {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 14px;
  padding: 11px 13px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--surface-2);
}

/* 辨識進度那一行：文字 + 跳過／停止按鈕 */
.ocr-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.ocr-row .hint {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 「這一張」的百分比：跟後面的英文階段說明分開，數字用等寬字才不會一直跳動 */
.ocr-percent {
  color: var(--text);
  font-weight: 650;
  font-variant-numeric: tabular-nums;
}

.ocr-stage {
  opacity: 0.75;
}

.ocr-track {
  height: 6px;
  overflow: hidden;
  border-radius: 999px;
  background: #e6e8e2;
}

.ocr-fill {
  height: 100%;
  background-color: var(--accent);
  background-image: linear-gradient(
    45deg,
    rgba(255, 255, 255, 0.24) 25%,
    transparent 25%,
    transparent 50%,
    rgba(255, 255, 255, 0.24) 50%,
    rgba(255, 255, 255, 0.24) 75%,
    transparent 75%
  );
  background-size: 14px 14px;
  transition: width 0.25s ease;
  animation: ocr-stripes 0.7s linear infinite;
}

@keyframes ocr-stripes {
  to {
    background-position: 14px 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .ocr-fill {
    animation: none;
  }
}

.viewer {
  width: min(860px, calc(100vw - 24px));
  /* 全頁都停用雙指縮放，看圖這個對話框是唯一的例外 */
  touch-action: pan-x pan-y pinch-zoom;
}

/*
 * 有對話框（看圖／更多／人物…）打開時，背景那一頁不要跟著捲動。
 * 這個規則要放在全域（style.css），這裡只留對話框自己的高度限制。
 */
.dialog {
  max-height: calc(100vh - 24px);
  max-height: calc(100dvh - 24px);
  overflow: auto;
  overscroll-behavior: contain;
}

.viewer-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
}

.viewer-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.zoom-group {
  display: flex;
  flex-wrap: nowrap;
  align-items: center;
  gap: 8px;
}

/* 下面那一組縮放按鈕只有手機版才出現（桌機版用標題列那一組） */
.viewer-foot .zoom-group {
  display: none;
}

.zoom-value {
  min-width: 46px;
  color: var(--muted);
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  text-align: center;
}

/* 一筆記錄有幾張圖片時，標題旁邊顯示「2 / 3」 */
.img-counter {
  flex: none;
  padding: 1px 8px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--surface-2);
  color: var(--muted);
  font-size: 12px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

/* 上一張／下一張與圖片管理那一排 */
.viewer-gal {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 8px 0;
  border-top: 1px solid var(--line);
  border-bottom: 1px solid var(--line);
}

/* 箭頭與垃圾桶圖示：跟文字按鈕一樣高，圖示自己置中 */
.gal-nav,
.gal-trash {
  padding: 0 9px;
}

.gal-nav svg,
.gal-trash svg {
  display: block;
}

.viewer-msg {
  margin: 0;
  padding: 7px 10px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--surface-2);
  color: var(--muted);
  font-size: 13px;
}

.viewer-stage {
  max-height: 68vh;
  overflow: auto;
  border-radius: var(--radius-sm);
  background: #eceee9;
  overscroll-behavior: contain;
  /* 全頁都停用雙指縮放，只有看圖這一區例外（單指捲動要留著） */
  touch-action: pan-x pan-y pinch-zoom;
}

.viewer-stage img {
  display: block;
  max-width: none;
  margin: 0 auto;
  transition: width 0.12s ease;
}

.viewer-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

/* ---------- 更多對話框 ---------- */
.more-title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--line);
  font-weight: 600;
}

.more-seq {
  flex: none;
  padding: 2px 8px;
  border: 1px dashed var(--line-strong);
  border-radius: 999px;
  background: var(--surface-2);
  color: var(--muted);
  font-size: 12px;
}

.more-file {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.more-state {
  margin: 0;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--surface-2);
  color: var(--muted);
  font-size: 13px;
  line-height: 1.6;
}

/* 已鎖定：跟卡片一樣的玫瑰色，一眼看出現在是什麼狀態 */
.more-state-locked {
  border-color: var(--lock);
  background: var(--lock-soft);
  color: var(--lock-dark);
}

.more-lock,
.more-delete {
  width: 100%;
}

/* 刪除排在最後、跟鎖定分開一點，才不會按錯 */
.more-delete {
  margin-top: 2px;
}

.alert {
  margin: 0 0 14px;
  padding: 10px 12px;
  border: 1px solid var(--danger);
  border-radius: var(--radius-sm);
  background: var(--danger-soft);
  color: var(--danger);
  font-size: 14px;
}

.notice {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0 0 12px;
  padding: 8px 12px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--surface-2);
  color: var(--muted);
  font-size: 13px;
}

.link {
  padding: 0;
  border: 0;
  background: none;
  color: var(--accent);
  font-size: 13px;
  font-weight: 600;
  text-decoration: underline;
  cursor: pointer;
}

@media (max-width: 560px) {
  /* 手機版：訊息文字與「知道了」各自固定位置，不會隨文字長短走位 */
  .notice {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .notice .link {
    align-self: flex-end;
  }

  .page {
    padding: 18px 12px calc(56px + env(safe-area-inset-bottom));
  }

  .head h1 {
    font-size: 21px;
  }

  /* 設定頁：返回鍵放在左上角（標題在它右邊），而且整條固定在畫面上方不會捲走 */
  .head-settings {
    position: sticky;
    top: 0;
    z-index: 20;
    /* 左右貼齊螢幕、往上貼齊頂端（.page 在手機是 18px／12px 的 padding） */
    margin: -18px -12px 14px;
    padding: 10px 12px;
    border-bottom: 1px solid var(--line);
    background: var(--bg);
    align-items: center;
    justify-content: flex-start;
    gap: 10px;
  }

  .head-settings h1 {
    font-size: 20px;
  }

  .head-settings .hint {
    font-size: 12px;
  }

  .head-settings .head-btns {
    order: -1;
    width: auto;
  }

  .head-settings .head-btns .btn {
    flex: 0 0 auto;
  }

  /* iOS 風格的返回：沒有框線，主色文字＋「‹」 */
  .head-settings .back-btn {
    min-height: 30px;
    padding: 0;
    border: 0;
    background: none;
    box-shadow: none;
    color: var(--accent);
    font-size: 16px;
    font-weight: 550;
  }

  .head-settings .back-btn:hover:not(:disabled),
  .head-settings .back-btn:active:not(:disabled) {
    border: 0;
    background: none;
    box-shadow: none;
    color: var(--accent-dark);
  }

  .head-settings .back-btn:active:not(:disabled) {
    opacity: 0.5;
    transform: none;
  }

  .back-chevron {
    margin-right: 1px;
  }

  .card {
    padding: 14px;
  }

  .card-head {
    align-items: stretch;
  }

  .card-head h2 {
    flex: 1 0 100%;
  }

  /* 人物那一列例外：標題與「新增人物」同一行，按鈕靠在最右邊 */
  .card-head-inline {
    align-items: center;
  }

  .card-head-inline h2 {
    flex: 0 1 auto;
  }

  .card-head-inline .btn {
    flex: 0 0 auto;
    margin-left: auto;
  }

  /* 記錄由下往上排：陣列最後一筆（最新、序號最大）顯示在最上面 */
  .recs {
    flex-direction: column-reverse;
  }

  /*
   * 滑到「幣別／新增／貼上／上傳」那一列離開畫面時（.is-flush，見 watchPayBar）：
   * 付款記錄那張卡片整張消失（框、白底、陰影全部變透明），只留下每一筆記錄，
   * 記錄清單同時往左右各擴 15px（卡片的 14px 內距 ＋ 1px 卡片框），記錄就填滿
   * 卡片原本的寬度、直接落在頁面底色上。滑回來就還原（0.25 秒過渡）。
   * :has(.recs) 是為了普通文字模式（表格）不受影響——那裡沒有記錄卡片。
   */
  .card-records:has(.recs) {
    transition: background-color 0.25s ease, border-color 0.25s ease, box-shadow 0.25s ease;
  }

  .card-records.is-flush:has(.recs) {
    border-color: transparent;
    background-color: transparent;
    box-shadow: none;
  }

  .card-records .recs {
    transition: margin 0.25s ease;
  }

  .card-records.is-flush .recs {
    margin-left: -15px;
    margin-right: -15px;
  }

  .head-actions {
    justify-content: space-between;
    width: 100%;
  }

  .head-btns {
    width: 100%;
  }

  .head-btns .btn {
    flex: 1;
  }

  .person {
    flex-wrap: nowrap;
    gap: 6px;
    /* 右邊留 12px：按鈕不會貼著卡片的邊線（以前是 10px，這裡多給一點） */
    padding: 8px 12px;
  }

  .person .avatar,
  .person .btn {
    flex: 0 0 auto;
  }

  /*
   * 手機版也固定欄寬（「自己」「N 筆」的標籤才會上下對齊），
   * 但每一欄都要縮小，不然整列會超過卡片寬度、把「刪除」擠到邊線上。
   */
  .person .avatar {
    width: 26px;
    height: 26px;
    font-size: 13px;
  }

  .person-name {
    flex: 0 0 auto;
    width: 66px;
  }

  .person-meta {
    width: 96px;
    gap: 4px;
  }

  .person-self {
    width: 40px;
  }

  .person .tag {
    padding: 2px 6px;
    font-size: 11px;
  }

  .person .btn {
    min-height: 30px;
    padding: 0 8px;
  }

  .inline-field {
    flex: 1;
  }

  /* 手機版：縮放按鈕改到最下面、排在「關閉」的左邊 */
  .viewer-foot {
    flex-wrap: wrap;
  }

  .viewer-foot .hint {
    flex: 1 0 100%;
  }

  .viewer-foot .zoom-group {
    display: flex;
  }

  .viewer-bar .zoom-group {
    display: none;
  }
}
</style>
