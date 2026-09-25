export const uid = () =>
  crypto.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`

const pad = (n) => String(n).padStart(2, '0')

/** 轉成 <input type="datetime-local"> 用的 "YYYY-MM-DDTHH:mm" */
export function toLocalInput(ms) {
  if (!ms) return ''
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}`
}

/** 顯示用 "YYYY-MM-DD HH:mm" */
export function fmtDateTime(ms) {
  if (!ms) return ''
  return toLocalInput(ms).replace('T', ' ')
}

export function fmtSize(bytes) {
  if (!bytes) return ''
  const units = ['B', 'KB', 'MB']
  let i = 0
  let n = bytes
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${n.toFixed(i ? 1 : 0)} ${units[i]}`
}

/** 檔名用的片段：拿掉 Windows 不接受的字元，並限制長度。 */
export const safeFileNamePart = (text) =>
  String(text ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 40)

/**
 * 金額輸入框只留數字與一個小數點：其他字元（字母、國字、逗號、負號…）一律去掉。
 * 給「付款多少錢」用，避免使用者打到不該打的字。
 */
export function toAmountText(text) {
  const raw = String(text ?? '').replace(/[^\d.]/g, '')
  const firstDot = raw.indexOf('.')
  if (firstDot < 0) return raw
  /* 只留第一個小數點，後面的去掉 */
  return raw.slice(0, firstDot + 1) + raw.slice(firstDot + 1).replace(/\./g, '')
}

const DAY_MS = 86400000

/**
 * 「多久以前」：剛剛／N 分鐘前／N 小時前／昨天／前天／N 天前／日期。
 * 用日曆天判斷昨天與前天（不是用 24 小時），跟一般 App 的講法一致。
 */
export function relativeTime(ms, now = Date.now()) {
  if (!ms) return ''
  const diff = now - ms
  if (diff < 60000) return '剛剛'
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分鐘前`

  const startOfDay = (value) => {
    const d = new Date(value)
    d.setHours(0, 0, 0, 0)
    return d.getTime()
  }
  /* 用「日曆天」算，不是用 24 小時：昨晚 11 點也是「昨天」 */
  const dayDiff = Math.round((startOfDay(now) - startOfDay(ms)) / DAY_MS)

  if (dayDiff <= 0) return `${Math.floor(diff / 3600000)} 小時前`
  if (dayDiff === 1) return '昨天'
  if (dayDiff === 2) return '前天'
  if (dayDiff < 30) return `${dayDiff} 天前`

  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/**
 * 每筆記錄左邊的「來源-序號」標籤。
 * 序號在同一個來源內從 1 開始，不同來源各自編號，所以匯入檔和自己上傳的可以區分。
 */
export function labelBySource(records, defaultSource = '本機') {
  const counters = new Map()
  const labels = new Map()
  for (const r of records ?? []) {
    const source = r.source || defaultSource
    const n = (counters.get(source) ?? 0) + 1
    counters.set(source, n)
    labels.set(r.id, `${source}-${n}`)
  }
  return labels
}

/**
 * 解析分享連結的參數，例如：
 *   /?persons=Vincent,Ben,Ken&currency=CNY&notes=吃_早餐,打車(去程)
 * 名稱接受逗號、中文逗號、頓號分隔；順手擋掉控制字元與過長的輸入。
 */
export function parseShareParams(search) {
  const params = new URLSearchParams(search ?? '')
  const seen = new Set()
  const names = []

  for (const part of (params.get('persons') ?? '').split(/[,，、;；]/)) {
    const name = part
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .trim()
      .replace(/\s+/g, ' ')
      .slice(0, 40)
    if (!name) continue
    /* 跟人物比對規則一致：忽略大小寫，避免同一個連結建出 Vincent 和 vincent */
    const key = name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    names.push(name)
    if (names.length >= 30) break
  }

  const currency = (params.get('currency') ?? '').trim().toUpperCase()

  /* 備注分類：允許空白與各種括號，所以只清掉控制字元與前後空白 */
  const noteSeen = new Set()
  const notes = []
  for (const part of (params.get('notes') ?? '').split(/[,，、;；]/)) {
    const note = part.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40)
    if (!note) continue
    const key = note.toLowerCase()
    if (noteSeen.has(key)) continue
    noteSeen.add(key)
    notes.push(note)
    if (notes.length >= 60) break
  }

  return { names, currency: /^[A-Z]{3}$/.test(currency) ? currency : '', notes }
}

/**
 * 同一組名字的指紋（忽略大小寫與順序），用來記住「這個分享連結的名單已經套用過了」。
 * 有指紋之後，使用者把連結帶進來的人物刪掉，重新整理也不會又長回來。
 */
export const shareLinkKey = (names) =>
  [...new Set((names ?? []).map((n) => String(n).trim().toLowerCase()).filter(Boolean))]
    .sort()
    .join('|')

/**
 * 從使用者貼上的文字取出查詢字串。可能貼的是一整串網址、
 * 只有 `?persons=…` 這一段，或只有 `persons=…&currency=CNY`。
 */
export function searchFromText(text) {
  const t = String(text ?? '').trim()
  if (!t) return ''
  const at = t.indexOf('?')
  if (at >= 0) return t.slice(at)
  if (t.includes('=')) return `?${t}`
  return ''
}

/* 分隔字元用逗號：名字與分類裡如果本來就有逗號，parseShareParams 會把它拆成兩個，這裡先清掉 */
const sharePart = (text) =>
  String(text ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[,，、;；]/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 40)

/**
 * 依現在的資料生出分享連結的查詢字串（設定頁的「生成」按鈕用）。
 * 人物用 name、分類用 text；重複的（忽略大小寫）只留第一個。
 * 回傳不含 "?" 的字串，例如 persons=Vincent,Ben&currency=CNY&notes=吃_早餐
 */
export function buildShareQuery({ persons = [], currency = '', notes = [] } = {}) {
  const params = new URLSearchParams()
  const seen = new Set()
  const names = []
  for (const p of persons) {
    const name = sharePart(p?.name ?? p)
    if (!name) continue
    const key = name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    names.push(name)
    if (names.length >= 30) break
  }
  if (names.length) params.set('persons', names.join(','))

  const code = String(currency ?? '').trim().toUpperCase()
  if (/^[A-Z]{3}$/.test(code)) params.set('currency', code)

  const noteSeen = new Set()
  const noteList = []
  for (const c of notes) {
    const text = sharePart(c?.text ?? c)
    if (!text) continue
    const key = text.toLowerCase()
    if (noteSeen.has(key)) continue
    noteSeen.add(key)
    noteList.push(text)
    if (noteList.length >= 60) break
  }
  if (noteList.length) params.set('notes', noteList.join(','))

  return params.toString()
}

