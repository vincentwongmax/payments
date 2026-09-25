/*
 * 一筆記錄可以有好幾張圖片：
 *   - 主要圖片（main）：卡片縮圖、看圖預設顯示、OCR 辨識的那一張
 *   - 附加圖片（extraImages）：後期補上來的收據、明細…
 * 這裡只放不動到瀏覽器 API 的純邏輯，方便測試。
 * 注意：主要圖片的檔名一律用「記錄的檔名」，換縮圖不會把記錄改名。
 */
import { uid } from './util.js'

export const MAIN_ID = 'main'

/* 圖片本身的欄位（不含檔名與 id） */
const fields = (source) => ({
  file: source?.file ?? null,
  url: source?.url ?? '',
  hash: source?.hash ?? '',
  fileTime: source?.fileTime ?? 0,
  fileTimeSource: source?.fileTimeSource ?? 'file',
})

const asExtra = (source) => ({
  ...fields(source),
  id: source?.id ?? uid(),
  fileName: source?.fileName ?? '',
})

/** 看圖用的圖片清單：第一張一定是主要圖片 */
export function recordImages(record) {
  if (!record) return []
  const list = []
  if (record.url || record.file) {
    list.push({ ...fields(record), id: MAIN_ID, fileName: record.fileName ?? '', isMain: true })
  }
  for (const img of record.extraImages ?? []) {
    list.push({ ...asExtra(img), isMain: false })
  }
  return list
}

/** 這筆記錄總共有幾張圖片 */
export const imageCount = (record) => recordImages(record).length

/** 一筆記錄所有圖片的 MD5（主要圖片＋附加圖片），用來擋重複上傳 */
export const imageHashes = (record) =>
  recordImages(record)
    .map((img) => img.hash)
    .filter(Boolean)

/**
 * 把某張圖片換成主要圖片（其他圖片的相對順序不變，原來的主要圖片退到附加圖片最前面）。
 * 回傳 { main, extras }，不改動傳進來的 record。
 */
export function promoteImage(record, imageId) {
  const name = record.fileName ?? ''
  const main = { ...fields(record), fileName: name }
  const extras = (record.extraImages ?? []).map(asExtra)
  if (!main.url || imageId === MAIN_ID) return { main, extras }

  const at = extras.findIndex((img) => img.id === imageId)
  if (at < 0) return { main, extras }

  const picked = extras.splice(at, 1)[0]
  extras.unshift({ ...main, id: uid() })
  return { main: { ...fields(picked), fileName: name }, extras }
}

/**
 * 刪掉某張圖片。
 * 刪掉主要圖片時，第一張附加圖片會遞補成主要圖片；沒有其他圖片就變成「無圖」。
 * 回傳 { main, extras, removed }（removed 是拿掉的那張，呼叫端可以回收 blob URL）。
 */
export function removeImage(record, imageId) {
  const name = record.fileName ?? ''
  const main = { ...fields(record), fileName: name }
  const extras = (record.extraImages ?? []).map(asExtra)

  if (imageId === MAIN_ID) {
    const next = extras.shift()
    if (!next) {
      return { main: { ...fields(null), fileName: name }, extras: [], removed: main }
    }
    return { main: { ...fields(next), fileName: name }, extras, removed: main }
  }

  const at = extras.findIndex((img) => img.id === imageId)
  if (at < 0) return { main, extras, removed: null }
  const removed = extras.splice(at, 1)[0]
  return { main, extras, removed }
}

/**
 * 這個 MD5 是不是已經被某一筆記錄的某一張圖片用過了（用來擋重複上傳）。
 * 回傳 { record, imageId } 或 null。
 */
export function findImageOwner(records, hash) {
  if (!hash) return null
  for (const r of records ?? []) {
    if (r.hash === hash) return { record: r, imageId: MAIN_ID }
    const hit = (r.extraImages ?? []).find((img) => img.hash === hash)
    if (hit) return { record: r, imageId: hit.id }
  }
  return null
}
