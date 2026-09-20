/* 讀取圖片「本身的時間」：優先 EXIF 拍攝時間，其次檔案時間。 */

const TAG_DATETIME = 0x0132
const TAG_EXIF_IFD = 0x8769
const TAG_DATETIME_ORIGINAL = 0x9003
const TAG_DATETIME_DIGITIZED = 0x9004

function entryOffset(dv, ifd, tag, le) {
  if (ifd <= 0 || ifd + 2 > dv.byteLength) return -1
  const count = dv.getUint16(ifd, le)
  for (let i = 0; i < count; i++) {
    const e = ifd + 2 + i * 12
    if (e + 12 > dv.byteLength) return -1
    if (dv.getUint16(e, le) === tag) return e
  }
  return -1
}

function asciiValue(dv, base, ifd, tag, le) {
  const e = entryOffset(dv, ifd, tag, le)
  if (e < 0 || dv.getUint16(e + 2, le) !== 2) return ''
  const len = dv.getUint32(e + 4, le)
  const at = len <= 4 ? e + 8 : base + dv.getUint32(e + 8, le)
  let out = ''
  for (let i = 0; i < len && at + i < dv.byteLength; i++) {
    const c = dv.getUint8(at + i)
    if (!c) break
    out += String.fromCharCode(c)
  }
  return out
}

function uintValue(dv, base, ifd, tag, le) {
  const e = entryOffset(dv, ifd, tag, le)
  if (e < 0) return 0
  return dv.getUint32(e + 8, le)
}

function exifStringToMs(text) {
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(text)
  if (!m) return 0
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number)
  if (y < 1900 || mo < 1 || mo > 12 || d < 1 || d > 31) return 0
  return new Date(y, mo - 1, d, h, mi, s).getTime()
}

/** 從 JPEG 的 bytes 取出 EXIF 時間，失敗回傳 0。 */
export function parseExifTime(buffer) {
  try {
    const dv = new DataView(buffer)
    if (dv.byteLength < 16 || dv.getUint16(0) !== 0xffd8) return 0

    let off = 2
    let tiff = -1
    while (off + 4 <= dv.byteLength) {
      if (dv.getUint8(off) !== 0xff) {
        off++
        continue
      }
      const marker = dv.getUint8(off + 1)
      if (marker === 0xff) {
        off++
        continue
      }
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) {
        off += 2
        continue
      }
      if (marker === 0xda || marker === 0xd9) break
      const size = dv.getUint16(off + 2)
      if (marker === 0xe1 && dv.getUint32(off + 4) === 0x45786966) {
        tiff = off + 10
        break
      }
      off += 2 + size
    }
    if (tiff < 0 || tiff + 8 > dv.byteLength) return 0

    const le = dv.getUint16(tiff) === 0x4949
    if (dv.getUint16(tiff + 2, le) !== 42) return 0
    const ifd0 = tiff + dv.getUint32(tiff + 4, le)
    const exifIfd = tiff + uintValue(dv, tiff, ifd0, TAG_EXIF_IFD, le)

    const candidates = [
      asciiValue(dv, tiff, exifIfd, TAG_DATETIME_ORIGINAL, le),
      asciiValue(dv, tiff, exifIfd, TAG_DATETIME_DIGITIZED, le),
      asciiValue(dv, tiff, ifd0, TAG_DATETIME, le),
    ]
    for (const text of candidates) {
      const ms = exifStringToMs(text)
      if (ms) return ms
    }
    return 0
  } catch {
    return 0
  }
}

/** 圖片本身的時間：EXIF 優先，否則用檔案時間。 */
export async function readImageTime(file) {
  try {
    const head = await file.slice(0, 256 * 1024).arrayBuffer()
    const ms = parseExifTime(head)
    if (ms) return { ms, source: 'exif' }
  } catch {
    /* 讀不到就退回檔案時間 */
  }
  return { ms: file.lastModified || Date.now(), source: 'file' }
}

/* ---------------- HEIC（iPhone 相機預設格式） ---------------- */

/* ISO-BMFF 的 major brand。AVIF 也用 ftyp，但它到處都解得到，故意不列進來 */
const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'heif'])

/**
 * 用檔頭 16 bytes 判斷是不是 HEIC，不看副檔名也不看 MIME——
 * 改名叫 .jpg 的 HEIC 一樣要抓出來。
 */
export async function isHeic(file) {
  try {
    const head = new Uint8Array(await file.slice(0, 16).arrayBuffer())
    if (head.length < 12) return false
    const box = String.fromCharCode(...head.slice(4, 8))
    if (box !== 'ftyp') return false
    const brand = String.fromCharCode(...head.slice(8, 12)).toLowerCase()
    return HEIC_BRANDS.has(brand)
  } catch {
    return false
  }
}

/**
 * 把 HEIC 轉成 JPEG。
 * iPhone 的 Safari 讀得到 HEIC，所以這一步在 iPhone 上會成功；
 * 電腦版瀏覽器讀不到時會丟錯，交給呼叫端顯示「這個瀏覽器讀不到」。
 * 長邊超過 4096 的會縮下來（48MP 的照片 OCR 會慢到不能忍受，12MP 的不受影響）。
 */
export async function heicToJpeg(file, { maxSide = 4096, quality = 0.92 } = {}) {
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bitmap.width * scale)
  canvas.height = Math.round(bitmap.height * scale)
  const ctx = canvas.getContext('2d')
  ctx.imageSmoothingQuality = 'high'
  /* 不在這裡處理方向：Safari 解碼時已經套用 HEIF 的 irot，再套一次會轉兩次 */
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close?.()

  const blob = await new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('HEIC 轉檔失敗'))), 'image/jpeg', quality),
  )
  /* 名字保留原樣，方便你認出是哪張照片；內容已經是 JPEG */
  return new File([blob], file.name, { type: 'image/jpeg' })
}

/* ---------------- 判斷圖片的真實型別 ---------------- */

/*
 * iOS 貼上圖片時，Blob 的 type 常常是 **UTI**（例如 public.jpeg）而不是 MIME
 * （image/jpeg）。用 type.startsWith('image/') 過濾會把圖整批丟掉，
 * 所以這裡一律先看檔頭（magic number），認不出來才退回 UTI 對照表／宣告值。
 */
const UTI_TO_MIME = {
  'public.jpeg': 'image/jpeg',
  'public.jpg': 'image/jpeg',
  'public.png': 'image/png',
  'public.heic': 'image/heic',
  'public.heif': 'image/heic',
  'public.tiff': 'image/tiff',
  'com.compuserve.gif': 'image/gif',
  'org.webmproject.webp': 'image/webp',
  'public.webp': 'image/webp',
  'public.bmp': 'image/bmp',
}

const ascii = (bytes, from, to) => String.fromCharCode(...bytes.slice(from, to))

/** 依檔頭判斷 MIME；認不出來時把 UTI 轉成 MIME，最後才用宣告值 */
export function sniffImageType(bytes, declared = '') {
  const b = bytes ?? []
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return 'image/png'
  }
  if (b.length >= 6 && ascii(b, 0, 3) === 'GIF') return 'image/gif'
  if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP') return 'image/webp'
  if (b.length >= 12 && ascii(b, 4, 8) === 'ftyp') {
    const brand = ascii(b, 8, 12).toLowerCase()
    if (['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1'].includes(brand)) {
      return 'image/heic'
    }
    if (brand === 'avif') return 'image/avif'
  }
  if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp'
  const lower = String(declared ?? '').toLowerCase()
  if (UTI_TO_MIME[lower]) return UTI_TO_MIME[lower]
  if (lower.startsWith('image/')) return lower
  return lower
}

/** MIME → 副檔名（記錄標題用） */
export const extFromMime = (type) =>
  ({
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/heic': 'heic',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/avif': 'avif',
    'image/tiff': 'tiff',
    'image/bmp': 'bmp',
  })[String(type ?? '').toLowerCase()] ?? 'png'

/* ---------------- 存進 IndexedDB 用的圖片格式 ---------------- */

/**
 * Safari 把 Blob／File 存進 IndexedDB 之後會壞掉（WebKit #240216），
 * 之後讀取會丟 NotFoundError: The object can not be found here.——
 * 尤其是從相簿選的檔案，關掉瀏覽器後那個暫存檔就沒了。
 * 所以存的是 bytes，要用時再組回 File。
 */
export async function fileToStored(file) {
  return {
    fileBytes: await file.arrayBuffer(),
    fileType: file.type || '',
    fileLastModified: file.lastModified || 0,
  }
}

/** 把存下來的資料組回 File；舊格式（直接存 File）也讀得回來。 */
export function storedToFile(row) {
  if (row?.fileBytes) {
    return new File([row.fileBytes], row.fileName || 'image', {
      type: row.fileType || 'image/jpeg',
      lastModified: row.fileLastModified || row.fileTime || Date.now(),
    })
  }
  return row?.file ?? null
}
/* ---------------- 匯出時的圖片壓縮 ---------------- */

/** 縮放比例：短邊不低於 minShortSide，而且絕不放大（比例完全不變）。 */
export function fitScale(width, height, minShortSide) {
  const short = Math.min(width, height)
  if (!short || !minShortSide) return 1
  return Math.min(1, minShortSide / short)
}

/* 由高到低試品質，先滿足檔案大小就不再往下壓 */
const EXPORT_QUALITIES = [0.72, 0.6, 0.5, 0.4]

/**
 * 匯出備份用：等比縮到短邊至少 minShortSide，再逐步降 JPEG 品質，
 * 直到檔案不超過原檔的 1/targetRatio；真的降不下去就用最小的那個。
 * 回傳 null 代表這個瀏覽器解不開這張圖，呼叫端改用原檔。
 */
export async function compressImage(file, { minShortSide = 700, targetRatio = 3 } = {}) {
  try {
    const bitmap = await createImageBitmap(file)
    const scale = fitScale(bitmap.width, bitmap.height, minShortSide)
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(bitmap.width * scale))
    canvas.height = Math.max(1, Math.round(bitmap.height * scale))
    const ctx = canvas.getContext('2d')
    ctx.imageSmoothingQuality = 'high'
    /* JPEG 沒有透明，先鋪白底免得透明的地方變黑 */
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    bitmap.close?.()

    const target = Math.max(1, Math.floor(file.size / targetRatio))
    let best = null
    for (const quality of EXPORT_QUALITIES) {
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality))
      if (!blob) continue
      if (!best || blob.size < best.size) best = blob
      if (blob.size <= target) return blob
    }
    return best
  } catch {
    return null
  }
}
