/*
 * 只匯出文字（不含圖片）。Tab 分隔，第一行是欄位名稱，
 * 直接貼到 Excel / Google 試算表就會自動分欄。
 * 純函式，方便測試。
 */

export const TEXT_COLUMNS = ['付錢人', '受益人', '錢', '備注', '付款時間']

/* 欄位裡不能有 Tab 或換行，不然欄位會跑掉 */
const cell = (value) =>
  String(value ?? '')
    .replace(/[\t\r\n]+/g, ' ')
    .trim()

/**
 * 每一筆記錄的 5 個欄位值（付錢人／受益人／錢／備注／付款時間）。
 * 「普通文字模式」的表格與匯出的文字都用這一份，兩邊才會一致。
 */
export function recordCells(records, persons) {
  const byId = new Map((persons ?? []).map((p) => [p.id, p.name]))
  const nameOf = (id) => byId.get(id) ?? ''

  return (records ?? []).map((r) => {
    const beneficiaries = [...new Set((r?.beneficiaryIds ?? []).map(nameOf).filter(Boolean))].sort(
      (a, b) => a.toLowerCase().localeCompare(b.toLowerCase()),
    )
    return [
      cell(nameOf(r?.payerId)),
      cell(beneficiaries.join(',')),
      cell(r?.amount),
      cell(r?.note),
      cell(r?.paidAtText),
    ]
  })
}

/**
 * 把記錄轉成文字表。
 * 付錢人＝付款人的名字；受益人＝多個名字用逗號接起來（依名字排序）；
 * 錢＝只有數字；備注＝備注原文；付款時間＝畫面上那個付款時間（沒有就留空）。
 */
export function recordsToText(records, persons) {
  const lines = [TEXT_COLUMNS.join('\t')]
  for (const cells of recordCells(records, persons)) lines.push(cells.join('\t'))
  return lines.join('\n')
}
