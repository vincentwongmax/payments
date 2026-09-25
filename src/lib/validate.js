/*
 * 匯出前的檢查：每筆記錄的必填欄位有沒有填。
 *
 * 規則（跟使用者確認過的）：
 *   必填：付錢人、受益人（至少一位）、錢
 *   二選一：付款時間 或 備注（其中一個有就好）
 *   圖片不算必填——手動新增的記錄本來就可以沒有圖片。
 */

/** 這筆記錄還缺哪些欄位（回傳中文欄位名稱，空陣列代表都填好了） */
export function missingFields(record) {
  if (!record) return []
  const missing = []
  if (!String(record.payerId ?? '').trim()) missing.push('付錢人')
  if (!(record.beneficiaryIds ?? []).length) missing.push('受益人')
  if (!String(record.amount ?? '').trim()) missing.push('錢')
  const hasTime = !!String(record.paidAtText ?? '').trim()
  const hasNote = !!String(record.note ?? '').trim()
  if (!hasTime && !hasNote) missing.push('付款時間或備注')
  return missing
}

/**
 * 找出所有還沒填完的記錄。
 * labelOf 用來給人看得懂的標籤（例如「本機-3」），沒給就用檔名。
 * 回傳 [{ id, label, missing: ['付錢人', …] }]
 */
export function findIncomplete(records, labelOf = () => '') {
  return (records ?? [])
    .map((r) => ({ id: r.id, label: labelOf(r) || r.fileName || '（未命名）', missing: missingFields(r) }))
    .filter((item) => item.missing.length > 0)
}

/** 把檢查結果寫成給使用者看的訊息（最多列 max 筆，其餘用「還有 N 筆」收掉） */
export function incompleteMessage(items, max = 8) {
  const list = items ?? []
  const lines = list.slice(0, max).map((it) => `・${it.label}：缺 ${it.missing.join('、')}`)
  const rest = list.length - lines.length
  if (rest > 0) lines.push(`・…還有 ${rest} 筆`)
  return lines.join('\n')
}
