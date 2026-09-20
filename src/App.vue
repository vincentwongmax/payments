<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import RecordCard from './components/RecordCard.vue'
import { addAlias, blobToBase64, fromBackup, mergeRecords, normalizeName, remapRecords, resolvePersons, toBackup } from './lib/backup.js'
import { clear, del, getAll, put, wipe } from './lib/db.js'
import { compressImage, extFromMime, fileToStored, heicToJpeg, isHeic, readImageTime, sniffImageType, storedToFile } from './lib/image.js'
import { hashFile } from './lib/md5.js'
import { mergeParsed, parsePaymentText, pickDate, pickDefaultAmount, preloadOcr, recognizePasses } from './lib/ocr.js'
import { fmtDateTime, labelBySource, parseShareParams, safeFileNamePart, shareLinkKey, uid } from './lib/util.js'

/* ---------- 人物 ---------- */
const persons = ref([])
const selfPerson = computed(() => persons.value.find((p) => p.isSelf) ?? null)
const defaultPayerId = computed(() => selfPerson.value?.id ?? persons.value[0]?.id ?? '')

const personDialogEl = ref(null)
const draft = ref({ id: null, name: '', isSelf: false, aliasesText: '' })
const err = ref('')

function openCreatePerson() {
  draft.value = { id: null, name: '', isSelf: persons.value.length === 0, aliasesText: '' }
  err.value = ''
  nextTick(() => personDialogEl.value.showModal())
}

function openEditPerson(person) {
  draft.value = {
    id: person.id,
    name: person.name,
    isSelf: person.isSelf,
    aliasesText: (person.aliases ?? []).join('、'),
  }
  err.value = ''
  nextTick(() => personDialogEl.value.showModal())
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

function removePerson(person) {
  if (!confirm(`確定要刪除「${person.name}」嗎？`)) return
  persons.value = persons.value.filter((p) => p.id !== person.id)
  /* 記錄裡指向他的欄位也要清掉，避免留下無效的 id */
  records.value.forEach((r) => {
    if (r.payerId === person.id) r.payerId = defaultPayerId.value
    r.beneficiaryIds = r.beneficiaryIds.filter((id) => id !== person.id)
  })
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

/* ---------- 合併重複的人物 ---------- */
const mergeDialogEl = ref(null)
const mergeDraft = ref({ source: null, targetId: '' })

function openMergePerson(person) {
  mergeDraft.value = { source: person, targetId: '' }
  nextTick(() => mergeDialogEl.value.showModal())
}

function confirmMerge() {
  const { source, targetId } = mergeDraft.value
  const target = persons.value.find((p) => p.id === targetId)
  if (!source || !target) return

  records.value.forEach((r) => {
    if (r.payerId === source.id) r.payerId = target.id
    r.beneficiaryIds = [...new Set(r.beneficiaryIds.map((id) => (id === source.id ? target.id : id)))]
  })

  /* 被合併的名字與它的別名，全部變成目標人物的別名 */
  addAlias(target, source.name)
  for (const alias of source.aliases ?? []) addAlias(target, alias)
  if (source.isSelf) target.isSelf = true
  persons.value = persons.value.filter((p) => p.id !== source.id)

  mergeDialogEl.value.close()
  backupNotice.value = `已把「${source.name}」合併到「${target.name}」`
}

/* ---------- 記錄 ---------- */
const records = ref([])
const fileInputEl = ref(null)
const storageError = ref('')

let seqCounter = 0
const nextSeq = () => ++seqCounter
const stamp = () => fmtDateTime(Date.now()).replace(/[-: ]/g, '')

/* 手動新增的記錄標題：手動新增1、手動新增2…（號碼不重用，刪掉舊的也不會補回來） */
const MANUAL_PREFIX = '手動新增'
let manualCounter = 0
const MANUAL_NAME_RE = /^手動新增([0-9]+)$/
const nextManualName = () => `${MANUAL_PREFIX}${++manualCounter}`

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

/** 沒有圖片也能先開一筆，金額與時間自己填 */
function addBlankRecord() {
  requireSelf(() => {
    const rec = baseRecord()
    rec.fileName = nextManualName()
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
function applyShareParams() {
  const { names, currency } = parseShareParams(window.location.search)
  if (!names.length && !currency) return

  /* 這組名單之前套用過就不再動作，才不會把使用者刪掉的人物加回來 */
  const key = shareLinkKey(names)
  if (key && appliedLinks.includes(key)) return

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

  let currencySet = ''
  if (currency && currency !== defaultCurrency.value) {
    defaultCurrency.value = currency
    applyDefaultCurrency()
    currencySet = currency
  }

  const bits = []
  if (added.length) bits.push(`新增人物 ${added.join('、')}`)
  if (currencySet) bits.push(`預設幣別設為 ${currencySet}`)
  if (bits.length) backupNotice.value = `從連結套用：${bits.join('、')}`

  if (key) {
    /* 只留最近 20 組，免得一直累積 */
    appliedLinks = [...appliedLinks, key].slice(-20)
    put('settings', { id: 'appliedShareLinks', value: appliedLinks }).catch(() => {})
  }
}

/* 已經套用過的分享連結名單（存在本機，「重置」時會一起清掉） */
let appliedLinks = []

const actionNotice = ref('')

/* 每筆記錄左邊的「來源-序號」，序號依來源各自從 1 開始 */
const sourceOf = (record) => record.source || DEFAULT_SOURCE
const seqLabels = computed(() => labelBySource(records.value, DEFAULT_SOURCE))

/** 重新命名來源：同一個來源的記錄會一起改，改成既有名稱就等於合併 */
function renameSource(current) {
  const count = records.value.filter((r) => sourceOf(r) === current).length
  const next = prompt(`重新命名來源「${current}」（${count} 筆會一起改）`, current)
  if (next === null) return
  const name = next.trim().replace(/\s+/g, ' ').slice(0, 40)
  if (!name || name === current) return
  records.value.forEach((r) => {
    if (sourceOf(r) === current) r.source = name
  })
  backupNotice.value = `已把來源「${current}」改名為「${name}」`
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

  /* MD5 完全相同就是同一張圖，不新增記錄 */
  const known = new Set(records.value.map((r) => r.hash).filter(Boolean))
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
const ocrStop = ref(false)
const pendingOcrCount = computed(
  () => records.value.filter((r) => r.ocrStatus === 'pending').length,
)

/** 使用者按「跳過」：這張不再辨識，圖與其他欄位都留著 */
function skipOcr(record) {
  if (!record) return
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
    /* OCR 途中又上傳新圖時，這裡會再撿起來跑一輪 */
    let queue = records.value.filter((r) => r.ocrStatus === 'pending')
    while (queue.length && !ocrStop.value) {
      ocrDone.value = 0
      ocrTotal.value = queue.length
      for (const rec of queue) {
        if (ocrStop.value) break
        rec.ocrStatus = 'running'
        ocrLabel.value = rec.fileName
        try {
          /* 兩種模式並行跑，進度取兩邊平均 */
          const passProgress = [0, 0]
          const passes = await recognizePasses(rec.file, (m, pass, count) => {
            passProgress[pass] = m.progress ?? 0
            rec.ocrProgress = Math.round(
              (passProgress.reduce((sum, p) => sum + p, 0) / count) * 100,
            )
            ocrLabel.value = `${rec.fileName}｜${m.status ?? ''}`
          })
          /* 辨識期間使用者按了「跳過」或「全部停止」→ 結果就不要了 */
          if (rec.ocrStatus !== 'running') {
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
      queue = records.value.filter((r) => r.ocrStatus === 'pending')
    }
  } finally {
    ocrBusy.value = false
    ocrLabel.value = ''
  }
}

function applyDefaultCurrency() {
  records.value.forEach((r) => {
    if (r.currencyLocked || !r.amounts?.length) return
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
    /* 同一張圖已經在別的記錄裡就擋下來，免得同一筆帳記兩次 */
    const twin = records.value.find((r) => r.id !== record.id && r.hash && r.hash === hash)
    if (twin) {
      actionNotice.value = `這張圖已經用在「${twin.fileName}」（${
        seqLabels.value.get(twin.id) ?? ''
      }），沒有重複加上去。`
      return
    }

    const time = await readImageTime(picked)
    /* 使用者已經自己填過的金額與時間不要被辨識結果蓋掉 */
    if (record.amount !== '') record.currencyLocked = true
    if (record.paidAtText !== '') record.paidAtManual = true

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

function removeRecord(record) {
  if (!confirm(`確定要刪除「${record.fileName}」這筆記錄嗎？`)) return
  revoke(record.url)
  records.value = records.value.filter((r) => r.id !== record.id)
}

/* 辨識失敗或逾時後，讓使用者可以重試 */
function retryOcr(record) {
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

/* 看圖 */
const viewing = ref(null)
const viewerEl = ref(null)
const zoom = ref(1)

function openViewer(record) {
  if (!record.url) return
  viewing.value = record
  zoom.value = 1
  nextTick(() => viewerEl.value.showModal())
}

const zoomBy = (factor) => {
  zoom.value = Math.min(6, Math.max(0.25, Number((zoom.value * factor).toFixed(3))))
}
const resetZoom = () => (zoom.value = 1)

/* 手機版（RWD）：點圖片就等於按關閉；桌機版不變，點圖不會關 */
const onViewerImageClick = () => {
  if (window.matchMedia?.('(max-width: 560px)').matches) viewerEl.value?.close()
}

/* ---------- 重置：什麼都不留 ---------- */
async function resetAll() {
  const ok = confirm(
    '重置會刪除全部的付款記錄、圖片、人物清單與設定，而且無法復原。\n\n確定要重置嗎？',
  )
  if (!ok) return

  records.value.forEach((r) => revoke(r.url))
  records.value = []
  persons.value = []
  defaultCurrency.value = ''
  actionNotice.value = ''
  actionNotice.value = ''
  savedSigs.clear()
  seqCounter = 0
  manualCounter = 0
  /* 重置連「套用過的分享連結」也清掉，重新整理才會再套用一次連結 */
  appliedLinks = []

  try {
    await wipe()
    storageError.value = ''
  } catch (e) {
    storageError.value = `重置失敗：${e?.message ?? e}`
  }
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

    let shareFailed = false
    if (useShareSheet() && navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: fileName })
        backupNotice.value = `已開啟分享面板：${fileName}`
        return
      } catch (e) {
        /* 使用者按取消就不算失敗；其他錯誤則退回下載 */
        if (e?.name === 'AbortError') return
        shareFailed = true
      }
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
    const shareNote = shareFailed ? '\n（分享面板打不開，已改成直接下載）' : ''
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
    payerId: r.payerId,
    beneficiaryIds: [...r.beneficiaryIds],
    note: r.note,
  }
}

/* 圖片本身不進比對字串，避免每次打字都重寫 blob */
const signature = (plain) => JSON.stringify(plain)

/* 這幾筆的圖片讀不到（Safari 舊資料損毀），只是記錄起來通知使用者 */
const brokenImageNames = ref([])

/* 存圖片 bytes 而不是 Blob，見 image.js 的說明 */
const IMAGE_STORE_VERSION = 2

async function persist() {
  try {
    const alive = new Set()
    const broken = []
    for (const r of records.value) {
      alive.add(r.id)
      const plain = serializeRecord(r)
      const sig = signature(plain)
      if (savedSigs.get(r.id) === sig) continue

      if (r.file) {
        try {
          Object.assign(plain, await fileToStored(r.file))
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
    storageError.value = ''
  } catch (e) {
    storageError.value = `資料無法存到本機：${e?.message ?? e}`
  }
}

let saveTimer
watch(
  [records, persons, defaultCurrency],
  () => {
    clearTimeout(saveTimer)
    saveTimer = setTimeout(persist, 300)
  },
  { deep: true },
)

onMounted(async () => {
  /* 直接按 Ctrl+V 也能貼上圖片 */
  document.addEventListener('paste', onPaste)
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
        return {
          ...r,
          file,
          url: file ? URL.createObjectURL(file) : '',
          ocrStatus: r.ocrStatus === 'running' ? 'pending' : r.ocrStatus,
        }
      })
    seqCounter = records.value.reduce((max, r) => Math.max(max, r.seq ?? 0), 0)
    defaultCurrency.value = settings.find((s) => s.id === 'defaultCurrency')?.value ?? ''
    const links = settings.find((s) => s.id === 'appliedShareLinks')?.value
    appliedLinks = Array.isArray(links) ? links : []
    /* 手動新增的編號接續舊資料（沒有編號的「手動新增」不算），號碼不重用 */
    const fromRecords = records.value.reduce((max, r) => {
      const m = MANUAL_NAME_RE.exec(r.fileName ?? '')
      return m ? Math.max(max, Number(m[1])) : max
    }, 0)
    manualCounter = Math.max(fromRecords, Number(settings.find((s) => s.id === 'manualCounter')?.value) || 0)
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
  runOcr()
})

onUnmounted(() => {
  document.removeEventListener('paste', onPaste)
  window.removeEventListener('app-error', onAppError)
})
</script>

<template>
  <div class="page">
    <header class="head">
      <div class="head-text">
        <h1>付款記錄</h1>
        <p class="hint">上傳付款截圖，自動整理成可編輯的記錄。資料只存在這台裝置的瀏覽器裡。</p>
      </div>
      <div class="head-btns">
        <button class="btn" @click="exportBackup">匯出</button>
        <button class="btn" @click="importInputEl.click()">匯入</button>
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
        還沒有任何人物。先新增一位並勾選「這是我自己」，之後的付款人預設就是他。
      </p>

      <ul v-else class="people">
        <li v-for="p in persons" :key="p.id" class="person">
          <span class="avatar" aria-hidden="true">{{ p.name.slice(0, 1) }}</span>
          <span class="person-name">{{ p.name }}</span>
          <span v-if="p.isSelf" class="tag">自己</span>
          <span v-if="p.aliases?.length" class="aliases" :title="p.aliases.join('、')">
            別名 {{ p.aliases.join('、') }}
          </span>
          <span class="spacer" />
          <button v-if="persons.length > 1" class="btn btn-icon" @click="openMergePerson(p)">
            合併
          </button>
          <button class="btn btn-icon" @click="openEditPerson(p)">修改</button>
          <button class="btn btn-icon btn-danger" @click="removePerson(p)">刪除</button>
        </li>
      </ul>

      <p v-if="persons.length && !selfPerson" class="hint">
        目前沒有指定「自己」，請選擇誰是自己。
      </p>
    </section>

    <section class="card">
      <div class="card-head">
        <h2>付款記錄 <span class="count">{{ records.length }}</span></h2>
        <div class="head-actions">
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
        <div class="ocr-track"><div class="ocr-fill" :style="{ width: `${(ocrDone / ocrTotal) * 100}%` }" /></div>
        <div class="ocr-row">
          <span class="hint">辨識中 {{ ocrDone }}/{{ ocrTotal }}｜{{ ocrLabel }}</span>
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

      <div v-else class="recs">
        <RecordCard
          v-for="r in records"
          :key="r.id"
          :record="r"
          :persons="persons"
          :index-label="seqLabels.get(r.id) ?? ''"
          @view="openViewer"
          @remove="removeRecord"
          @retry="retryOcr"
          @skip="skipOcr"
          @rename-source="renameSource"
          @attach="attachImage"
        />
      </div>
    </section>

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

    <dialog ref="mergeDialogEl" class="dialog">
      <form @submit.prevent="confirmMerge">
        <h3 class="dialog-head">合併人物</h3>
        <div class="dialog-body">
          <p class="hint">
            把「{{ mergeDraft.source?.name }}」合併到另一位人物。記錄裡的付錢人與受益人都會一起改過去，
            原來的名字會變成別名，之後匯入同樣的寫法會自動對上。
          </p>
          <div class="field">
            <label for="merge-target">合併到</label>
            <select id="merge-target" v-model="mergeDraft.targetId" class="input">
              <option value="" disabled>請選擇</option>
              <option
                v-for="p in persons.filter((x) => x.id !== mergeDraft.source?.id)"
                :key="p.id"
                :value="p.id"
              >
                {{ p.name }}{{ p.isSelf ? '（自己）' : '' }}
              </option>
            </select>
          </div>
        </div>
        <div class="dialog-foot">
          <button type="button" class="btn" @click="mergeDialogEl.close()">取消</button>
          <button type="submit" class="btn btn-primary" :disabled="!mergeDraft.targetId">
            合併
          </button>
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

    <dialog ref="viewerEl" class="dialog viewer" @close="viewing = null">
      <div v-if="viewing" class="viewer-body">
        <div class="viewer-bar">
          <span class="file" :title="viewing.fileName">{{ viewing.fileName }}</span>
          <span class="hint">{{ fmtDateTime(viewing.fileTime) }}</span>
          <!-- 手機版：百分比放在日期右邊；桌機版這顆隱藏，用下面群組裡那顆 -->
          <span class="zoom-value only-rwd">{{ Math.round(zoom * 100) }}%</span>
          <span class="spacer" />
          <span class="zoom-group">
            <!-- 桌機版：百分比放在「縮小」左邊 -->
            <span class="zoom-value">{{ Math.round(zoom * 100) }}%</span>
            <button type="button" class="btn btn-icon" @click="zoomBy(1 / 1.25)">縮小 −</button>
            <button type="button" class="btn btn-icon" @click="zoomBy(1.25)">放大 ＋</button>
            <button type="button" class="btn btn-icon" @click="resetZoom">還原</button>
          </span>
        </div>
        <div class="viewer-stage" @wheel.ctrl.prevent="zoomBy($event.deltaY < 0 ? 1.1 : 1 / 1.1)">
          <img
            :src="viewing.url"
            :alt="viewing.fileName"
            :style="{ width: `${zoom * 100}%` }"
            @click="onViewerImageClick"
          />
        </div>
        <div class="viewer-foot">
          <span class="hint hide-rwd">Ctrl + 滾輪也可以縮放</span>
          <span class="spacer" />
          <!-- 手機版才出現：縮放按鈕排在關閉的左邊（桌機版用上面那一組） -->
          <span class="zoom-group">
            <button type="button" class="btn btn-icon" @click="zoomBy(1 / 1.25)">縮小 −</button>
            <button type="button" class="btn btn-icon" @click="zoomBy(1.25)">放大 ＋</button>
            <button type="button" class="btn btn-icon" @click="resetZoom">還原</button>
          </span>
          <button type="button" class="btn" @click="viewerEl.close()">關閉</button>
        </div>
      </div>
    </dialog>

    <dialog ref="personDialogEl" class="dialog">
      <form @submit.prevent="savePerson">
        <h3 class="dialog-head">{{ draft.id ? '修改人物' : '新增人物' }}</h3>
        <div class="dialog-body">
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

.person {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
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
  min-width: 0;
  overflow: hidden;
  font-weight: 550;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tag {
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 12px;
  font-weight: 600;
}

.aliases {
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

.viewer-stage {
  max-height: 68vh;
  overflow: auto;
  border-radius: var(--radius-sm);
  background: #eceee9;
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
  }

  /* 名字（或別名）太長就用 … 收掉，按鈕一律留在同一行 */
  .person .avatar,
  .person .tag,
  .person .btn {
    flex: 0 0 auto;
  }

  .person-name {
    flex: 1 1 auto;
  }

  .person .aliases {
    flex: 0 1 auto;
    max-width: 34%;
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
