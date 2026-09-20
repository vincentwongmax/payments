/* MD5（RFC 1321）：用來判斷圖片是否 100% 重複。純函式，可被 node 測試。 */

const S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9,
  14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
]

const K = new Uint32Array(64)
for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296)

/** 輸入 Uint8Array 或 ArrayBuffer，回傳 32 字元小寫 hex。 */
export function md5Hex(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input)
  const len = bytes.length
  const buffer = new ArrayBuffer((((len + 8) >> 6) + 1) * 64)
  const view = new Uint8Array(buffer)
  view.set(bytes)
  view[len] = 0x80

  const dv = new DataView(buffer)
  const bitLen = len * 8
  dv.setUint32(buffer.byteLength - 8, bitLen >>> 0, true)
  dv.setUint32(buffer.byteLength - 4, Math.floor(bitLen / 4294967296), true)

  let a0 = 0x67452301
  let b0 = 0xefcdab89
  let c0 = 0x98badcfe
  let d0 = 0x10325476
  const M = new Uint32Array(16)

  for (let chunk = 0; chunk < buffer.byteLength; chunk += 64) {
    for (let i = 0; i < 16; i++) M[i] = dv.getUint32(chunk + i * 4, true)

    let A = a0
    let B = b0
    let C = c0
    let D = d0

    for (let i = 0; i < 64; i++) {
      let f
      let g
      if (i < 16) {
        f = (B & C) | (~B & D)
        g = i
      } else if (i < 32) {
        f = (D & B) | (~D & C)
        g = (5 * i + 1) % 16
      } else if (i < 48) {
        f = B ^ C ^ D
        g = (3 * i + 5) % 16
      } else {
        f = C ^ (B | ~D)
        g = (7 * i) % 16
      }
      f = (f + A + K[i] + M[g]) | 0
      A = D
      D = C
      C = B
      B = (B + ((f << S[i]) | (f >>> (32 - S[i])))) | 0
    }

    a0 = (a0 + A) | 0
    b0 = (b0 + B) | 0
    c0 = (c0 + C) | 0
    d0 = (d0 + D) | 0
  }

  return [a0, b0, c0, d0]
    .map((word) => {
      const hex = (word >>> 0).toString(16).padStart(8, '0')
      return hex.match(/../g).reverse().join('')
    })
    .join('')
}

/** 檔案內容的 MD5。 */
export async function hashFile(file) {
  return md5Hex(new Uint8Array(await file.arrayBuffer()))
}
