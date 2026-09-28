/*
 * 分頁（sheets）：一個分頁＝一組「人物 ＋ 付款記錄」。
 * 其他設定（顏色、匯出檢查規則、備注分類、幣別預設、顯示模式…）是所有分頁共用的。
 *
 * 只有一個分頁時，主畫面的標題維持「付款記錄」；兩個以上才顯示分頁名稱。
 */
import { uid } from './util.js'

export const DEFAULT_SHEET_NAME = '預設'
/* 主畫面的付款記錄卡片標題：多個分頁時變成「<分頁名>_付款記錄」 */
export const SHEET_TITLE_SUFFIX = '_付款記錄'

/** 分頁名稱：把多餘空白收掉、太長截短、空白就退回預設名稱 */
export function cleanSheetName(name, fallback = DEFAULT_SHEET_NAME) {
  const text = String(name ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40)
  return text || fallback
}

/** 取一個不撞名的分頁名稱：日常 → 日常（2）→ 日常（3）… */
export function uniqueSheetName(sheets, name) {
  const base = cleanSheetName(name)
  const used = new Set((sheets ?? []).map((s) => s.name))
  if (!used.has(base)) return base
  for (let i = 2; i < 999; i++) {
    const next = `${base}（${i}）`
    if (!used.has(next)) return next
  }
  return `${base}（${Date.now()}）`
}

export const makeSheet = (name, seq = 0) => ({
  id: uid(),
  name: cleanSheetName(name),
  seq,
  createdAt: Date.now(),
})

/** 依 seq（再依建立時間）排序，順序才穩定 */
export const sortSheets = (sheets) =>
  [...(sheets ?? [])].sort(
    (a, b) => (a.seq ?? 0) - (b.seq ?? 0) || (a.createdAt ?? 0) - (b.createdAt ?? 0),
  )

/** 只有一個分頁時主畫面維持「付款記錄」，多個才加上分頁名稱 */
export function sheetCardTitle(sheets, currentId, base = '付款記錄') {
  const list = sheets ?? []
  if (list.length <= 1) return base
  const current = list.find((s) => s.id === currentId)
  return current ? `${current.name}${SHEET_TITLE_SUFFIX}` : base
}

/** 這一筆記錄／人物屬於哪個分頁；舊資料沒有 sheetId 時算在 fallback */
export const sheetOf = (row, fallbackId) => row?.sheetId || fallbackId

/** 下一個沒被用到的 seq（新增分頁排在最後） */
export const nextSheetSeq = (sheets) =>
  (sheets ?? []).reduce((max, s) => Math.max(max, Number(s.seq) || 0), 0) + 1
