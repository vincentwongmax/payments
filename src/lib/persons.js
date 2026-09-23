/* 人物與記錄之間的關聯。純函式，方便測試，也不依賴瀏覽器。 */

/** 這個人物被哪些記錄用到（付錢人或受益人）。 */
export function recordsUsingPerson(records, personId) {
  if (!personId) return []
  return (records ?? []).filter(
    (r) => r?.payerId === personId || (r?.beneficiaryIds ?? []).includes(personId),
  )
}

/**
 * 記錄裡要存一份「人物 id → 名字」的快照。
 * 平常只是備份，真正的作用是：人物不見了（匯入對不到、資料寫到一半中斷…）
 * 的時候還知道要把他補回成什麼名字。
 */
export function personNameSnapshot(record, persons) {
  const byId = new Map((persons ?? []).map((p) => [p.id, p.name]))
  const ids = [record?.payerId, ...(record?.beneficiaryIds ?? [])].filter(Boolean)
  const out = {}
  for (const id of ids) {
    const name = byId.get(id)
    if (name) out[id] = name
  }
  return out
}

/**
 * 記錄指到的人物如果不在清單裡就用快照的名字補回來。
 * 沒有名字可用的（這個功能之前就壞掉的舊資料）不亂補，留給使用者自己重選，
 * 免得畫面上多出一位不知道是誰的人物。
 */
export function restoreMissingPersons(persons, records) {
  const list = [...(persons ?? [])]
  const known = new Set(list.map((p) => p.id))
  const restored = []

  for (const r of records ?? []) {
    const names = r?.personNames ?? {}
    for (const id of [r?.payerId, ...(r?.beneficiaryIds ?? [])]) {
      if (!id || known.has(id)) continue
      const name = names[id]
      if (!name) continue
      known.add(id)
      const person = { id, name, isSelf: false, aliases: [] }
      list.push(person)
      restored.push(person)
    }
  }

  return { persons: list, restored }
}

/** 記錄用到、但人物清單裡找不到的 id（沒有名字快照、補不回來的那些）。 */
export function missingPersonIds(persons, record) {
  const known = new Set((persons ?? []).map((p) => p.id))
  return [record?.payerId, ...(record?.beneficiaryIds ?? [])].filter((id) => id && !known.has(id))
}
