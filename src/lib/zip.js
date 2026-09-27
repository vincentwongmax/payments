/*
 * 極簡 ZIP 產生器（只用「儲存」不壓縮）。
 *
 * 為什麼要自己寫：匯出圖片時，手機用系統分享面板、電腦用資料夾寫檔，
 * 兩個都不支援的瀏覽器才需要「打包成一個檔」，而那種情況很少見，
 * 不需要為它加一個壓縮函式庫（而且圖片本身早就壓過了，再壓也沒用）。
 *
 * 只支援 store（method 0）、UTF-8 檔名、單一磁碟、ZIP64 以前的格式，
 * 對「幾十張圖片」這個情境完全夠用。純函式，可以獨立測試。
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c >>> 0
  }
  return table
})()

/** 標準 CRC-32（ZIP 每一筆都要） */
export function crc32(bytes) {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** 檔名轉成 UTF-8 位元組 */
const utf8 = (text) => new TextEncoder().encode(text)

/** JS 的 Date → DOS 時間／日期（ZIP 用的舊格式，1980 年起算） */
function dosStamp(date) {
  const year = Math.max(1980, date.getFullYear())
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  }
}

/**
 * 把 [{ name, bytes }] 打包成一個 ZIP（不壓縮）。
 * @param {{ name: string, bytes: Uint8Array }[]} entries
 * @param {Date} [now] 檔案時間（測試用）
 * @returns {Blob}
 */
export function zipStore(entries, now = new Date()) {
  const { time, date } = dosStamp(now)
  const locals = []
  const centrals = []
  let offset = 0

  for (const entry of entries) {
    const name = utf8(String(entry.name ?? 'file'))
    const data = entry.bytes instanceof Uint8Array ? entry.bytes : new Uint8Array(entry.bytes)
    const sum = crc32(data)

    const local = new Uint8Array(30 + name.length + data.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true) // PK\x03\x04
    lv.setUint16(4, 20, true) // 版本
    lv.setUint16(6, 0x0800, true) // 檔名是 UTF-8
    lv.setUint16(8, 0, true) // 不壓縮
    lv.setUint16(10, time, true)
    lv.setUint16(12, date, true)
    lv.setUint32(14, sum, true)
    lv.setUint32(18, data.length, true)
    lv.setUint32(22, data.length, true)
    lv.setUint16(26, name.length, true)
    lv.setUint16(28, 0, true) // 沒有 extra
    local.set(name, 30)
    local.set(data, 30 + name.length)
    locals.push(local)

    const central = new Uint8Array(46 + name.length)
    const cv = new DataView(central.buffer)
    cv.setUint32(0, 0x02014b50, true) // PK\x01\x02
    cv.setUint16(4, 20, true) // 建立版本
    cv.setUint16(6, 20, true) // 需要版本
    cv.setUint16(8, 0x0800, true)
    cv.setUint16(10, 0, true)
    cv.setUint16(12, time, true)
    cv.setUint16(14, date, true)
    cv.setUint32(16, sum, true)
    cv.setUint32(20, data.length, true)
    cv.setUint32(24, data.length, true)
    cv.setUint16(28, name.length, true)
    cv.setUint16(30, 0, true) // extra
    cv.setUint16(32, 0, true) // 註解
    cv.setUint16(34, 0, true) // 磁碟編號
    cv.setUint16(36, 0, true) // 內部屬性
    cv.setUint32(38, 0, true) // 外部屬性
    cv.setUint32(42, offset, true) // 這筆的 local header 位置
    central.set(name, 46)
    centrals.push(central)

    offset += local.length
  }

  const centralSize = centrals.reduce((sum, c) => sum + c.length, 0)
  const end = new Uint8Array(22)
  const ev = new DataView(end.buffer)
  ev.setUint32(0, 0x06054b50, true) // PK\x05\x06
  ev.setUint16(4, 0, true)
  ev.setUint16(6, 0, true)
  ev.setUint16(8, entries.length, true)
  ev.setUint16(10, entries.length, true)
  ev.setUint32(12, centralSize, true)
  ev.setUint32(16, offset, true)
  ev.setUint16(20, 0, true)

  return new Blob([...locals, ...centrals, end], { type: 'application/zip' })
}
