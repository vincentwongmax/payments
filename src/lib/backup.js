/* 匯出／匯入：單一 JSON 檔，圖片以 base64 夾在裡面。
   toBackup / fromBackup 的圖片轉換由外部注入，方便測試。 */

const APP_ID = 'payment-records'
export const BACKUP_VERSION = 1

export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

export function base64ToBlob(base64, type = '') {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new Blob([bytes], { type })
}

export async function toBackup(records, persons, defaultCurrency, encodeImage = blobToBase64) {
  return {
    app: APP_ID,
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    defaultCurrency,
    persons: persons.map((p) => ({
      id: p.id,
      name: p.name,
      isSelf: !!p.isSelf,
      aliases: [...(p.aliases ?? [])],
    })),
    records: await Promise.all(
      records.map(async (r, seq) => {
        /* encodeImage 可以回傳 base64 字串，或 { base64, type }——壓縮後格式可能從 PNG 變成 JPEG */
        const encoded = r.file ? await encodeImage(r.file) : null
        return {
          id: r.id,
          seq,
          createdAt: r.createdAt ?? 0,
          fileName: r.fileName,
          fileType: encoded?.type ?? r.file?.type ?? '',
          fileTime: r.fileTime,
          fileTimeSource: r.fileTimeSource,
          hash: r.hash,
          ocrStatus: r.ocrStatus === 'running' ? 'done' : r.ocrStatus,
          ocrText: r.ocrText ?? '',
          ocrError: r.ocrError ?? '',
          amounts: (r.amounts ?? []).map((a) => ({ ...a })),
          currency: r.currency ?? '',
          currencyLocked: !!r.currencyLocked,
          amount: r.amount ?? '',
          paidAtText: r.paidAtText ?? '',
          paidAtManual: !!r.paidAtManual,
          locked: !!r.locked,
          amountChooserOff: !!r.amountChooserOff,
          payerId: r.payerId ?? '',
          beneficiaryIds: [...(r.beneficiaryIds ?? [])],
          note: r.note ?? '',
          image: typeof encoded === 'string' ? encoded : (encoded?.base64 ?? ''),
        }
      }),
    ),
  }
}

export async function fromBackup(payload, decodeImage = base64ToBlob) {
  if (!payload || payload.app !== APP_ID || !Array.isArray(payload.records))
    throw new Error('這不是本程式匯出的備份檔')

  const persons = (payload.persons ?? [])
    .filter((p) => p && p.id && p.name)
    .map((p) => ({
      id: p.id,
      name: p.name,
      isSelf: !!p.isSelf,
      aliases: [...(p.aliases ?? [])],
    }))

  const records = []
  for (const raw of [...payload.records].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))) {
    records.push({
      id: raw.id ?? `imported-${records.length}`,
      createdAt: raw.createdAt ?? 0,
      fileName: raw.fileName ?? '未命名圖片',
      /* 手動新增的記錄沒有圖片 */
      file: raw.image ? await decodeImage(raw.image, raw.fileType ?? '') : null,
      fileTime: raw.fileTime ?? 0,
      fileTimeSource: raw.fileTimeSource ?? 'file',
      hash: raw.hash ?? '',
      ocrStatus: raw.ocrStatus === 'running' ? 'pending' : (raw.ocrStatus ?? 'pending'),
      ocrProgress: 0,
      ocrText: raw.ocrText ?? '',
      ocrError: raw.ocrError ?? '',
      amounts: (raw.amounts ?? []).map((a) => ({ ...a })),
      currency: raw.currency ?? '',
      currencyLocked: !!raw.currencyLocked,
      amount: raw.amount ?? '',
      paidAtText: raw.paidAtText ?? '',
      paidAtManual: !!raw.paidAtManual,
      locked: !!raw.locked,
      amountChooserOff: !!raw.amountChooserOff,
      payerId: raw.payerId ?? '',
      beneficiaryIds: [...(raw.beneficiaryIds ?? [])],
      note: raw.note ?? '',
    })
  }

  return { persons, records, defaultCurrency: payload.defaultCurrency ?? '' }
}

/* ---------------- 人物比對與對齊 ---------------- */

/** 比對用：忽略大小寫與多餘空白，所以 Vincent = vincent。 */
export const normalizeName = (name) =>
  String(name ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()

/** 幫人物加上別名；自己的名字、重複的別名不會再加。 */
export function addAlias(person, name) {
  const clean = String(name ?? '')
    .trim()
    .replace(/\s+/g, ' ')
  if (!clean || normalizeName(clean) === normalizeName(person.name)) return false
  person.aliases ??= []
  if (person.aliases.some((a) => normalizeName(a) === normalizeName(clean))) return false
  person.aliases.push(clean)
  return true
}

/**
 * 把匯入檔的人物對到現有的人物。
 * - 同 id、同名字、同別名（忽略大小寫）會自動對上，並把新的寫法記成別名
 * - 對不上的會放進 needsDecision，等使用者指定要對應到誰或建立新人物
 * - decisions: { [匯入檔人物id]: 'new' | 現有人物id }
 * - 目前完全沒有其他人物時（例如第一次匯入）一律視為新人物
 *
 * 回傳 { persons, idMap, needsDecision }
 */
export function resolvePersons(existing, incoming, decisions = {}) {
  const persons = existing.map((p) => ({ ...p, aliases: [...(p.aliases ?? [])] }))
  const byId = new Map(persons.map((p) => [p.id, p]))
  const byKey = new Map()
  const index = (p) => {
    byKey.set(normalizeName(p.name), p)
    for (const alias of p.aliases) byKey.set(normalizeName(alias), p)
  }
  persons.forEach(index)

  const nothingToAlignWith = persons.length === 0
  const idMap = new Map()
  const needsDecision = []
  let selfTaken = persons.some((p) => p.isSelf)

  for (const p of incoming) {
    let target = byId.get(p.id) ?? byKey.get(normalizeName(p.name))

    if (target) {
      idMap.set(p.id, target.id)
      addAlias(target, p.name)
      if (p.isSelf && !selfTaken) {
        target.isSelf = true
        selfTaken = true
      }
      continue
    }

    const decision = nothingToAlignWith ? 'new' : decisions[p.id]
    if (decision === undefined) {
      needsDecision.push(p)
      continue
    }

    if (decision === 'new') {
      const created = {
        id: p.id,
        name: p.name.trim(),
        isSelf: !!p.isSelf && !selfTaken,
        aliases: [],
      }
      if (created.isSelf) selfTaken = true
      persons.push(created)
      byId.set(created.id, created)
      index(created)
      idMap.set(p.id, created.id)
      continue
    }

    target = byId.get(decision)
    if (!target) {
      needsDecision.push(p)
      continue
    }
    idMap.set(p.id, target.id)
    addAlias(target, p.name)
  }

  return { persons, idMap, needsDecision }
}

/** 把記錄裡的付錢人與受益人換成對齊後的 id；對不到的原樣保留。 */
export function remapRecords(records, idMap) {
  return records.map((r) => ({
    ...r,
    payerId: idMap.get(r.payerId) ?? r.payerId,
    beneficiaryIds: [...new Set((r.beneficiaryIds ?? []).map((id) => idMap.get(id) ?? id))],
  }))
}

/** 只加入目前沒有的記錄（MD5 相同或 id 相同就跳過）。 */
export function mergeRecords(existing, incoming) {
  const hashes = new Set(existing.map((r) => r.hash).filter(Boolean))
  const ids = new Set(existing.map((r) => r.id))
  const added = []
  let skipped = 0

  for (const r of incoming) {
    if (ids.has(r.id) || (r.hash && hashes.has(r.hash))) {
      skipped++
      continue
    }
    ids.add(r.id)
    if (r.hash) hashes.add(r.hash)
    added.push(r)
  }
  return { added, skipped }
}
