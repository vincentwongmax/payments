/* 匯出／匯入：單一 JSON 檔，圖片以 base64 夾在裡面。
   toBackup / fromBackup 的圖片轉換由外部注入，方便測試。 */

const APP_ID = 'payment-records'
/* v2：備份檔裡改成 sheets: [{ name, persons, records }]（一個檔案可以裝多個分頁）
   v1（persons／records 直接放在最上層）還是讀得回來。 */
export const BACKUP_VERSION = 2

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

/** 一個分頁的內容 → 備份裡的一段（圖片以 base64 夾進去） */
export async function toBackupSheet(sheet, encodeImage = blobToBase64) {
  const persons = sheet?.persons ?? []
  const records = sheet?.records ?? []
  return {
    name: sheet?.name ?? '',
    defaultCurrency: sheet?.defaultCurrency ?? '',
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
        /* 附加圖片（後期補上的）也一起帶走 */
        const extras = []
        for (const img of r.extraImages ?? []) {
          const buf = img.file ? await encodeImage(img.file) : null
          extras.push({
            image: typeof buf === 'string' ? buf : (buf?.base64 ?? ''),
            fileType: buf?.type ?? img.file?.type ?? '',
            hash: img.hash ?? '',
            fileTime: img.fileTime ?? 0,
            fileTimeSource: img.fileTimeSource ?? 'file',
          })
        }
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
          images: extras,
        }
      }),
    ),
  }
}

/**
 * 一份備份檔（可以裝多個分頁）。
 * sheets: [{ name, persons, records, defaultCurrency }]
 */
export async function toBackup(sheets, encodeImage = blobToBase64) {
  return {
    app: APP_ID,
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    sheets: await Promise.all((sheets ?? []).map((s) => toBackupSheet(s, encodeImage))),
  }
}

/** 讀備份檔 → 一律正規化成 [{ name, persons, records, defaultCurrency }]（v1 也算一個分頁） */
export function sheetsFromBackup(payload) {
  if (!payload || payload.app !== APP_ID) throw new Error('這不是本程式匯出的備份檔')
  if (Array.isArray(payload.sheets)) {
    const sheets = payload.sheets
      .filter((s) => s && Array.isArray(s.records))
      .map((s) => ({
        name: String(s.name ?? ''),
        defaultCurrency: s.defaultCurrency ?? '',
        persons: Array.isArray(s.persons) ? s.persons : [],
        records: s.records,
      }))
    if (!sheets.length) throw new Error('這不是本程式匯出的備份檔')
    return sheets
  }
  if (Array.isArray(payload.records)) {
    return [
      {
        name: String(payload.sheetName ?? ''),
        defaultCurrency: payload.defaultCurrency ?? '',
        persons: Array.isArray(payload.persons) ? payload.persons : [],
        records: payload.records,
      },
    ]
  }
  throw new Error('這不是本程式匯出的備份檔')
}

/**
 * 這個檔案「看起來」是不是本程式匯出的備份。
 * QR CODE 傳輸可以收到任何檔案，匯入前先用這個判斷：
 * 不是備份的話就交給使用者自己分享／儲存，不要硬丟進匯入流程。
 */
export async function isBackupFile(file) {
  try {
    /* 先用開頭幾個位元組判斷有沒有一點像 JSON，二進位檔就不必整包讀進來 */
    const head = await file.slice(0, 64).text()
    if (!head.trimStart().startsWith('{')) return false
    const payload = JSON.parse(await file.text())
    return (
      !!payload &&
      payload.app === APP_ID &&
      (Array.isArray(payload.records) || Array.isArray(payload.sheets))
    )
  } catch {
    return false
  }
}

/**
 * 讀一份備份檔，準備併進目前的分頁。
 * 備份檔裡可能有好多個分頁，匯入一律把它們攤平併進目前分頁
 * （跟以前一樣是「合併」而不是「還原」，要乾淨還原請先按重置）。
 */
export async function fromBackup(payload, decodeImage = base64ToBlob) {
  const sheets = sheetsFromBackup(payload)

  const persons = []
  const seenPersonIds = new Set()
  const records = []
  const seenRecordIds = new Set()

  for (const sheet of sheets) {
    for (const p of sheet.persons) {
      if (!p || !p.id || !p.name) continue
      /* 不同分頁用了同一個 id 就重新編一個，免得多個分頁互相蓋掉 */
      const id = seenPersonIds.has(p.id) ? `${p.id}-${persons.length}` : p.id
      seenPersonIds.add(id)
      persons.push({
        id,
        name: p.name,
        isSelf: !!p.isSelf,
        aliases: [...(p.aliases ?? [])],
      })
    }

    for (const raw of [...sheet.records].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))) {
      /* 附加圖片：舊備份沒有這個欄位，沒有就是空陣列 */
      const extraImages = []
      for (const [i, img] of (raw.images ?? []).entries()) {
        const file = img?.image ? await decodeImage(img.image, img.fileType ?? '') : null
        if (!file) continue
        extraImages.push({
          id: `extra-${i + 1}`,
          file,
          fileName: `${raw.fileName ?? '圖片'}-${i + 2}`,
          hash: img.hash ?? '',
          fileTime: img.fileTime ?? 0,
          fileTimeSource: img.fileTimeSource ?? 'file',
        })
      }
      const baseId = raw.id ?? `imported-${records.length}`
      const id = seenRecordIds.has(baseId) ? `${baseId}-${records.length}` : baseId
      seenRecordIds.add(id)
      records.push({
        id,
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
        extraImages,
        payerId: raw.payerId ?? '',
        beneficiaryIds: [...(raw.beneficiaryIds ?? [])],
        note: raw.note ?? '',
      })
    }
  }

  return {
    persons,
    records,
    defaultCurrency: sheets[0]?.defaultCurrency ?? '',
    sheetNames: sheets.map((s) => s.name).filter(Boolean),
  }
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
