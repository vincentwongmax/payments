/*
 * 匯出前的檢查：每筆記錄的必填欄位有沒有填。
 *
 * 規則（設定頁可以自己改）：
 *   checked：勾選的欄位＝一定要填（付錢人／受益人／錢／付款時間／備注）
 *   groups ：N選M 群組——「這幾個欄位裡至少要有 N 個」的關係。
 *            放進群組的欄位由群組決定要填幾個，不再個別要求；
 *            欄位可以同時放進多個群組，但一定要先在上面勾選才能放進群組。
 *
 * 預設（跟使用者確認過的）：付錢人、受益人、錢必填，付款時間與備注二選一。
 * 圖片不算必填——手動新增的記錄本來就可以沒有圖片。
 */
import { uid } from './util.js'

/** 可以檢查的欄位（順序就是設定頁的顯示順序） */
export const EXPORT_FIELDS = [
  { key: 'payer', name: '付錢人' },
  { key: 'beneficiary', name: '受益人' },
  { key: 'amount', name: '錢' },
  { key: 'paidAt', name: '付款時間' },
  { key: 'note', name: '備注' },
]

export const FIELD_KEYS = EXPORT_FIELDS.map((f) => f.key)
export const fieldName = (key) => EXPORT_FIELDS.find((f) => f.key === key)?.name ?? key

export const DEFAULT_EXPORT_RULES = {
  checked: [...FIELD_KEYS],
  groups: [{ id: 'default-group', fields: ['paidAt', 'note'], min: 1 }],
}

/** 這個欄位填了沒 */
export function fieldFilled(record, key) {
  if (!record) return false
  switch (key) {
    case 'payer':
      return !!String(record.payerId ?? '').trim()
    case 'beneficiary':
      return (record.beneficiaryIds ?? []).length > 0
    case 'amount':
      return !!String(record.amount ?? '').trim()
    case 'paidAt':
      return !!String(record.paidAtText ?? '').trim()
    case 'note':
      return !!String(record.note ?? '').trim()
    default:
      return false
  }
}

/** 群組的一句話說明：二選一 → 「付款時間或備注」；至少 2 個 → 「付款時間、備注 至少 2 個」 */
export function groupLabel(group) {
  const names = (group?.fields ?? []).map(fieldName)
  if (!names.length) return ''
  if (names.length === 1) return names[0]
  const min = Math.max(1, Number(group?.min) || 1)
  return min <= 1 ? names.join('或') : `${names.join('、')} 至少 ${min} 個`
}

/**
 * 把存下來的規則補成完整的、可用的規則。
 * 也吃舊版格式（{ payer: 'require', timeNote: 'one', … }），會轉成新的 checked／groups。
 */
export function normalizeRules(saved) {
  const fallback = () => ({
    checked: [...DEFAULT_EXPORT_RULES.checked],
    groups: DEFAULT_EXPORT_RULES.groups.map((g) => ({ ...g, fields: [...g.fields] })),
  })
  if (!saved || typeof saved !== 'object') return fallback()

  /* 舊版：每個欄位是 'require' / 'off'，時間與備注是一個模式 */
  if (!Array.isArray(saved.checked)) {
    /* 有舊版欄位才是舊設定；完全認不出來的（例如空物件）就用預設值 */
    if (!['payer', 'beneficiary', 'amount', 'timeNote'].some((key) => key in saved)) return fallback()
    const checked = []
    for (const key of ['payer', 'beneficiary', 'amount']) {
      if (saved[key] === 'require') checked.push(key)
    }
    const mode = saved.timeNote
    if (mode === 'both') checked.push('paidAt', 'note')
    else if (mode === 'time') checked.push('paidAt')
    else if (mode === 'note') checked.push('note')
    else if (mode === 'one') checked.push('paidAt', 'note')
    const groups = mode === 'one' ? [{ id: uid(), fields: ['paidAt', 'note'], min: 1 }] : []
    return { checked, groups }
  }

  const checked = [...new Set(saved.checked.filter((k) => FIELD_KEYS.includes(k)))]
  const groups = []
  for (const raw of Array.isArray(saved.groups) ? saved.groups : []) {
    /* 只有「已勾選」的欄位可以留在群組裡 */
    const fields = [...new Set((raw?.fields ?? []).filter((k) => checked.includes(k)))]
    if (!fields.length) continue
    const min = Math.min(Math.max(1, Number(raw?.min) || 1), fields.length)
    groups.push({ id: raw?.id || uid(), fields, min })
  }
  return { checked, groups }
}

/** 目前規則的一句話說明（設定頁收合起來的小標籤） */
export function describeRules(rules) {
  const r = normalizeRules(rules)
  const inGroups = new Set(r.groups.flatMap((g) => g.fields))
  const parts = r.checked.filter((key) => !inGroups.has(key)).map(fieldName)
  for (const g of r.groups) parts.push(groupLabel(g))
  return parts.length ? parts.join('・') : '不檢查'
}

/**
 * 這筆記錄還缺哪些欄位（回傳中文說明，空陣列代表都填好了）。
 * rules 沒給就用預設規則。
 */
export function missingFields(record, rules = DEFAULT_EXPORT_RULES) {
  if (!record) return []
  const r = normalizeRules(rules)
  const inGroups = new Set(r.groups.flatMap((g) => g.fields))
  const missing = []

  /* 個別必填：有勾選、而且沒有被任何群組管到的欄位 */
  for (const key of r.checked) {
    if (inGroups.has(key)) continue
    if (!fieldFilled(record, key)) missing.push(fieldName(key))
  }

  /* N選M 群組：這一組裡至少要有 min 個填了 */
  for (const g of r.groups) {
    const filled = g.fields.filter((key) => fieldFilled(record, key)).length
    if (filled < g.min) missing.push(groupLabel(g))
  }

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
