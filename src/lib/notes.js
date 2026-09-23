/*
 * 備注的分類（常用字串）。
 * 純函式，方便測試；實際的清單存在 settings 裡，重置時可以選擇保留。
 */

/* 內建的預設分類，使用者可以自己再加 */
export const DEFAULT_NOTE_CATEGORIES = [
  '吃_早餐',
  '吃_午餐',
  '吃_晚餐',
  '租車_停車費',
  '租車_高速費(去程)',
  '租車_高速費(回程)',
  '租車_加油',
  '打車(去程)',
  '打車(回程)',
  '飲_廢水( )',
]

const clean = (text) =>
  String(text ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 40)

/** 比對用的鍵：忽略大小寫與多餘空白 */
export const noteKey = (text) => clean(text).replace(/\s+/g, ' ').toLowerCase()

/**
 * 把清單整理成 { text, link } 陣列：去重、去空白、保留「是不是從連結來的」。
 * link = true 的代表來自分享連結，重置時永遠保留（不讓使用者選）。
 */
export function normalizeNoteCategories(list) {
  const out = []
  const seen = new Set()
  for (const item of list ?? []) {
    const text = clean(typeof item === 'string' ? item : item?.text)
    if (!text) continue
    const key = noteKey(text)
    if (seen.has(key)) {
      /* 已經有同一個分類，只要有一個是從連結來的就標成連結 */
      if (typeof item === 'object' && item?.link) {
        const hit = out.find((c) => noteKey(c.text) === key)
        if (hit) hit.link = true
      }
      continue
    }
    seen.add(key)
    out.push({ text, link: !!item?.link })
  }
  return out
}

/** 內建預設 + 使用者自己加過的（保留原本的 link 標記） */
export const seedNoteCategories = () =>
  normalizeNoteCategories(DEFAULT_NOTE_CATEGORIES.map((text) => ({ text, link: false })))

/**
 * 重置時要留下哪些分類：
 *   從連結來的一定留；使用者勾了「保留備注分類」就全部留。
 */
export function keepNoteCategories(categories, keepAll) {
  const list = normalizeNoteCategories(categories)
  return keepAll ? list : list.filter((c) => c.link)
}

/** 把第 index 個分類往上／往下移一格（delta = -1 / 1）；移不動就回傳原清單 */
export function moveNoteCategory(categories, index, delta) {
  const list = normalizeNoteCategories(categories)
  const to = index + delta
  if (index < 0 || index >= list.length || to < 0 || to >= list.length) return list
  const [item] = list.splice(index, 1)
  list.splice(to, 0, item)
  return list
}

/** 刪掉一個分類 */
export const removeNoteCategory = (categories, text) =>
  normalizeNoteCategories(categories).filter((c) => noteKey(c.text) !== noteKey(text))

/**
 * 把一個分類改名（位置與「從連結來」的標記都保留）。
 * 改成空的、跟原本一樣、或跟其他分類撞名時回傳 null（呼叫端顯示錯誤）。
 */
export function renameNoteCategory(categories, from, to) {
  const list = normalizeNoteCategories(categories)
  const name = clean(to)
  if (!name) return null
  const index = list.findIndex((c) => noteKey(c.text) === noteKey(from))
  if (index < 0) return null
  if (noteKey(name) === noteKey(list[index].text)) return list
  if (list.some((c, i) => i !== index && noteKey(c.text) === noteKey(name))) return null
  list[index] = { text: name, link: list[index].link }
  return list
}
