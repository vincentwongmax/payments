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
 *   /?persons=Vincent,Ben,Ken&currency=CNY
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
  return { names, currency: /^[A-Z]{3}$/.test(currency) ? currency : '' }
}

/**
 * 同一組名字的指紋（忽略大小寫與順序），用來記住「這個分享連結的名單已經套用過了」。
 * 有指紋之後，使用者把連結帶進來的人物刪掉，重新整理也不會又長回來。
 */
export const shareLinkKey = (names) =>
  [...new Set((names ?? []).map((n) => String(n).trim().toLowerCase()).filter(Boolean))]
    .sort()
    .join('|')
