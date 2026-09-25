/*
 * 匯出前的檢查：每筆記錄的必填欄位有沒有填。
 *
 * 預設規則（跟使用者確認過的）：
 *   必填：付錢人、受益人（至少一位）、錢
 *   二選一：付款時間 或 備注（其中一個有就好）
 *   圖片不算必填——手動新增的記錄本來就可以沒有圖片。
 *
 * 這些規則使用者可以在設定頁自己改（每一項都可以設成「不檢查」，
 * 付款時間與備注還可以改成兩個都要／只要其中一個）。
 */

export const DEFAULT_EXPORT_RULES = {
  payer: 'require',
  beneficiary: 'require',
  amount: 'require',
  /* one = 二選一、both = 兩個都要、time = 只要付款時間、note = 只要備注、off = 不檢查 */
  timeNote: 'one',
}

/** 設定頁下拉選單的選項 */
export const RULE_FIELDS = [
  {
    key: 'payer',
    name: '付錢人',
    options: [
      { value: 'require', label: '必填' },
      { value: 'off', label: '不檢查' },
    ],
  },
  {
    key: 'beneficiary',
    name: '受益人',
    options: [
      { value: 'require', label: '必填' },
      { value: 'off', label: '不檢查' },
    ],
  },
  {
    key: 'amount',
    name: '錢',
    options: [
      { value: 'require', label: '必填' },
      { value: 'off', label: '不檢查' },
    ],
  },
  {
    key: 'timeNote',
    name: '付款時間與備注',
    options: [
      { value: 'one', label: '二選一' },
      { value: 'both', label: '兩個都要' },
      { value: 'time', label: '只要付款時間' },
      { value: 'note', label: '只要備注' },
      { value: 'off', label: '不檢查' },
    ],
  },
]

/** 把存下來的規則補成完整的（舊資料沒有這個設定就用預設值） */
export function normalizeRules(saved) {
  const rules = { ...DEFAULT_EXPORT_RULES }
  if (!saved || typeof saved !== 'object') return rules
  for (const field of RULE_FIELDS) {
    const value = saved[field.key]
    if (field.options.some((o) => o.value === value)) rules[field.key] = value
  }
  return rules
}

/** 一句話說明目前檢查什麼（設定頁收合起來時顯示） */
export function describeRules(rules) {
  const r = normalizeRules(rules)
  const parts = []
  if (r.payer === 'require') parts.push('付錢人')
  if (r.beneficiary === 'require') parts.push('受益人')
  if (r.amount === 'require') parts.push('錢')
  if (r.timeNote === 'one') parts.push('時間或備注')
  else if (r.timeNote === 'both') parts.push('時間＋備注')
  else if (r.timeNote === 'time') parts.push('付款時間')
  else if (r.timeNote === 'note') parts.push('備注')
  return parts.length ? parts.join('・') : '不檢查'
}

/**
 * 這筆記錄還缺哪些欄位（回傳中文欄位名稱，空陣列代表都填好了）。
 * rules 沒給就用預設規則。
 */
export function missingFields(record, rules = DEFAULT_EXPORT_RULES) {
  if (!record) return []
  const r = normalizeRules(rules)
  const missing = []

  if (r.payer === 'require' && !String(record.payerId ?? '').trim()) missing.push('付錢人')
  if (r.beneficiary === 'require' && !(record.beneficiaryIds ?? []).length) missing.push('受益人')
  if (r.amount === 'require' && !String(record.amount ?? '').trim()) missing.push('錢')

  const hasTime = !!String(record.paidAtText ?? '').trim()
  const hasNote = !!String(record.note ?? '').trim()
  if (r.timeNote === 'one' && !hasTime && !hasNote) missing.push('付款時間或備注')
  if (r.timeNote === 'both') {
    if (!hasTime) missing.push('付款時間')
    if (!hasNote) missing.push('備注')
  }
  if (r.timeNote === 'time' && !hasTime) missing.push('付款時間')
  if (r.timeNote === 'note' && !hasNote) missing.push('備注')

  return missing
}

/**
 * 找出所有還沒填完的記錄。
 * labelOf 用來給人看得懂的標籤（例如「本機-3」），沒給就用檔名。
 * 使用者把它設成「不用檢查」的記錄（checkExport === false）會直接跳過。
 * 回傳 [{ id, label, missing: ['付錢人', …] }]
 */
export function findIncomplete(records, labelOf = () => '', rules = DEFAULT_EXPORT_RULES) {
  return (records ?? [])
    .filter((r) => r.checkExport !== false)
    .map((r) => ({
      id: r.id,
      label: labelOf(r) || r.fileName || '（未命名）',
      missing: missingFields(r, rules),
    }))
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
