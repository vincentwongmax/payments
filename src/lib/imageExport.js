/*
 * 匯出圖片用的檔名：純函式，方便測試。
 *
 * 規則（使用者選的）：`序號-付錢人-金額-幣別-付款時間`
 *   例：`001-Vincent-45-MOP-2026-09-06.jpg`
 * 同一筆記錄的第 2 張以後加 `-2`、`-3`；空的部分自動跳過；
 * 不合法的檔名字元會被去掉；真的撞名（兩筆資料一樣）就加 `~2`。
 */
import { safeFileNamePart } from './util.js'

const EXT_BY_TYPE = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/avif': 'avif',
  'image/bmp': 'bmp',
}

/** 依 MIME 型別決定副檔名，認不出來就用原本檔名的副檔名，最後退回 jpg */
export function imageExt(type, originalName = '') {
  const byType = EXT_BY_TYPE[String(type ?? '').toLowerCase()]
  if (byType) return byType
  const fromName = /\.([a-z0-9]{2,5})$/i.exec(String(originalName))
  return fromName ? fromName[1].toLowerCase() : 'jpg'
}

/** 付款時間只留日期（2026-09-06），沒有就留空 */
export function datePart(paidAtText) {
  const text = String(paidAtText ?? '').trim()
  const hit = /(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(text)
  if (!hit) return ''
  const [, y, m, d] = hit
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

/**
 * @param {object} info
 * @param {number} info.index 1 開始的序號（全部記錄的順序）
 * @param {string} info.payer 付錢人的名字
 * @param {string} info.amount 金額
 * @param {string} info.currency 幣別
 * @param {string} info.paidAtText 付款時間
 * @param {number} info.part 同一筆的第幾張（1 = 主圖）
 * @param {string} info.type 圖片型別
 * @param {string} info.originalName 原始檔名（型別認不出來時用）
 */
export function imageExportName(info) {
  const seq = String(Math.max(1, info.index)).padStart(3, '0')
  const payer = safeFileNamePart(info.payer).replace(/\s+/g, '')
  const money = [safeFileNamePart(info.amount), safeFileNamePart(info.currency)].filter(Boolean).join('')
  const date = datePart(info.paidAtText)
  const base = [seq, payer, money, date].filter(Boolean).join('-') || seq
  const part = Number(info.part) > 1 ? `-${Number(info.part)}` : ''
  return `${base}${part}.${imageExt(info.type, info.originalName)}`
}

/** 撞名（兩筆資料一模一樣）時加 ~2、~3… */
export function uniqueExportName(name, used) {
  if (!used.has(name)) {
    used.add(name)
    return name
  }
  const dot = name.lastIndexOf('.')
  const base = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  for (let i = 2; i < 500; i++) {
    const next = `${base}~${i}${ext}`
    if (!used.has(next)) {
      used.add(next)
      return next
    }
  }
  return name
}
