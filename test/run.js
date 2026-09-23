/* 純邏輯自我檢查：node test/run.js */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import {
  extFromMime,
  fileToStored,
  fitScale,
  isHeic,
  parseExifTime,
  sniffImageType,
  storedToFile,
} from '../src/lib/image.js'
import {
  extractHeights,
  mergeParsed,
  parsePaymentText,
  pickDate,
  pickDefaultAmount,
} from '../src/lib/ocr.js'
import { labelBySource, parseShareParams, safeFileNamePart, searchFromText, shareLinkKey } from '../src/lib/util.js'
import {
  DEFAULT_NOTE_CATEGORIES,
  keepNoteCategories,
  noteKey,
  normalizeNoteCategories,
  seedNoteCategories,
} from '../src/lib/notes.js'
import {
  missingPersonIds,
  personNameSnapshot,
  recordsUsingPerson,
  restoreMissingPersons,
} from '../src/lib/persons.js'
import { md5Hex } from '../src/lib/md5.js'
import { fromBackup, mergeRecords, remapRecords, resolvePersons, toBackup } from '../src/lib/backup.js'

/* ---------- 建立一張帶 EXIF 的假 JPEG ---------- */
function buildJpeg({ ifdDateTime, originalDateTime }) {
  const tiff = new DataView(new ArrayBuffer(96))
  const LE = true
  tiff.setUint16(0, 0x4949, LE) // 'II' little-endian
  tiff.setUint16(2, 42, LE)
  tiff.setUint32(4, 8, LE) // IFD0 位置
  tiff.setUint16(8, 2, LE) // IFD0 兩個欄位
  tiff.setUint16(10, 0x0132, LE) // DateTime
  tiff.setUint16(12, 2, LE)
  tiff.setUint32(14, 20, LE)
  tiff.setUint32(18, 38, LE)
  tiff.setUint16(22, 0x8769, LE) // Exif IFD 指標
  tiff.setUint16(24, 4, LE)
  tiff.setUint32(26, 1, LE)
  tiff.setUint32(30, 58, LE)
  tiff.setUint32(34, 0, LE)
  tiff.setUint16(58, 1, LE) // Exif IFD：一個欄位
  tiff.setUint16(60, 0x9003, LE) // DateTimeOriginal
  tiff.setUint16(62, 2, LE)
  tiff.setUint32(64, 20, LE)
  tiff.setUint32(68, 76, LE)
  tiff.setUint32(72, 0, LE)
  const writeText = (at, text) => {
    for (let i = 0; i < text.length; i++) tiff.setUint8(at + i, text.charCodeAt(i))
  }
  writeText(38, ifdDateTime)
  writeText(76, originalDateTime)

  const payload = new Uint8Array(6 + 96)
  payload.set([0x45, 0x78, 0x69, 0x66, 0, 0], 0) // "Exif\0\0"
  payload.set(new Uint8Array(tiff.buffer), 6)

  const jpeg = new Uint8Array(6 + payload.length + 2)
  jpeg.set([0xff, 0xd8], 0)
  jpeg.set([0xff, 0xe1], 2)
  new DataView(jpeg.buffer).setUint16(4, 2 + payload.length, false)
  jpeg.set(payload, 6)
  jpeg.set([0xff, 0xd9], 6 + payload.length)
  return jpeg.buffer
}

const jpeg = buildJpeg({
  ifdDateTime: '2020:01:01 00:00:00\0',
  originalDateTime: '2024:03:05 14:22:33\0',
})
assert.equal(parseExifTime(jpeg), new Date(2024, 2, 5, 14, 22, 33).getTime())

/* 沒有 Exif 的 JPEG */
assert.equal(parseExifTime(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]).buffer), 0)
/* PNG 不是 JPEG */
assert.equal(parseExifTime(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]).buffer), 0)
/* 亂數不應該爆掉 */
assert.equal(parseExifTime(new Uint8Array(64).buffer), 0)

/* ---------- OCR 文字解析 ---------- */
const alipay = `賬單詳情
付款金額
¥ 128.50
商戶名稱：某某餐廳
付款時間 2024-03-05 14:22:33
付款方式 餘額
交易號 2024030522001234567`

const alipayResult = parsePaymentText(alipay)
assert.equal(alipayResult.amounts.length, 1, '19 位交易號不該被當成金額')
assert.equal(alipayResult.amounts[0].currency, 'CNY')
assert.equal(alipayResult.amounts[0].value, 128.5)
assert.equal(pickDate(alipayResult.dates), new Date(2024, 2, 5, 14, 22, 33).getTime())

/* 同一張圖多個幣別，各自要抓對 */
const macau = `消費金額 MOP 88.00
CNY 79.60
交易日期 2024/03/05 14:22`
const macauResult = parsePaymentText(macau)
const mop = macauResult.amounts.find((a) => a.currency === 'MOP')
const cny = macauResult.amounts.find((a) => a.currency === 'CNY')
assert.equal(mop?.value, 88)
assert.equal(cny?.value, 79.6)
assert.equal(pickDate(macauResult.dates), new Date(2024, 2, 5, 14, 22).getTime())
assert.equal(pickDefaultAmount(macauResult.amounts, 'CNY').value, 79.6)
assert.equal(pickDefaultAmount(macauResult.amounts, 'MOP').value, 88)

/* 中文日期、含千分位、幣別未標示 */
const chinese = `支付成功
金額：1,234.56 元
2024年3月5日 14:22`
const chineseResult = parsePaymentText(chinese)
assert.equal(chineseResult.amounts.length, 1)
assert.equal(chineseResult.amounts[0].value, 1234.56)
assert.equal(chineseResult.amounts[0].currency, '')
assert.equal(pickDate(chineseResult.dates), new Date(2024, 2, 5, 14, 22).getTime())

/* ---------- 真實截圖的 OCR 文字（含 OCR 插入的空格） ---------- */

/* 云闪付：20 位凭证号與信用卡末四碼曾被誤判成金額 */
const yunflash = `一 半 239.93
优惠 信息 云 闪 付 支 付 满 5 元 随机 立 减 -#0.07
当前 状态 交易 成 功
订单 金额 ¥240.00
付款 方式 中 银 信用 卡 [9668]
订单 时 间 2026.9.12 09:44:21
交易 流水 号 20260912094421T07999
付款 凭证 号 70260912350934479451`
const yun = parsePaymentText(yunflash)
assert.equal(yun.amounts[0].value, 240, '應該優先選「订单金额」')
assert.equal(yun.amounts[0].currency, 'CNY')
assert.equal(yun.amounts[0].labeled, true, '中文之間有空格也要認得「金 额」')
assert.ok(!yun.amounts.some((a) => a.value === 9668), '信用卡末四碼不該是金額')
assert.ok(!yun.amounts.some((a) => a.value >= 1e7), '流水號不該是金額')
assert.equal(pickDate(yun.dates), new Date(2026, 8, 12, 9, 44, 21).getTime())

/* 微信账单：54 是「积分」不是金額，28 位訂單號也不是 */
const wechat = `支付 时 间 2026-09-12 13:24:26
商品 褒 明 收 钱 码 收 款
支付 奖励 已 领取 54 积 分 >
订 单 号 2026091223001447561421506993
商家 订单 号 17891906627802375647565`
const wx = parsePaymentText(wechat)
assert.equal(wx.amounts.length, 0, '積分與單號都不該被當成金額')

/* 澳門雙幣別：卡片、百分比、匯率都不該混進來 */
const macauCard = `mor 192.74
MOP 192.74 (CNY 158.00)
[EZR CNY 1 = MOP 1.21990000
付款 方式 151% R17 (CBEF9)(2535)
付款 时 间 2026-09-12 20:49:58
交易 编号 2026091220495375439708`
const mc = parsePaymentText(macauCard)
assert.equal(mc.amounts.find((a) => a.currency === 'MOP')?.value, 192.74)
assert.equal(mc.amounts.find((a) => a.currency === 'CNY')?.value, 158)
for (const bad of [151, 17, 2535, 9, 1.21]) {
  assert.ok(!mc.amounts.some((a) => a.value === bad), `${bad} 不該是金額`)
}

/* ---------- 字級：大字才是實際付款金額 ---------- */
const fakeTesseract = {
  blocks: [
    {
      paragraphs: [
        {
          lines: [
            {
              words: [
                {
                  text: '订单 金额 ¥240.00',
                  bbox: { x0: 0, y0: 200, x1: 300, y1: 232 },
                  symbols: [
                    { text: '2', bbox: { x0: 0, y0: 200, x1: 16, y1: 232 } },
                    { text: '4', bbox: { x0: 16, y0: 200, x1: 32, y1: 232 } },
                  ],
                },
                {
                  text: '—¥239.93',
                  bbox: { x0: 0, y0: 100, x1: 400, y1: 152 },
                  symbols: [
                    { text: '—', bbox: { x0: 0, y0: 140, x1: 40, y1: 150 } },
                    { text: '2', bbox: { x0: 40, y0: 100, x1: 66, y1: 151 } },
                    { text: '3', bbox: { x0: 66, y0: 100, x1: 92, y1: 151 } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  ],
}
const heights = extractHeights(fakeTesseract)
assert.equal(heights.get(240), 32, '一般字級')
assert.equal(heights.get(239.93), 51, '大字：用數字字元高度，不受破折號影響')

const sized = parsePaymentText(`—¥239.93\n订单 金额 ¥240.00`, heights)
assert.equal(sized.amounts[0].value, 239.93, '字級大的要排前面')
assert.equal(sized.amounts[0].height, 51)
assert.equal(sized.amounts[1].value, 240)
assert.equal(pickDefaultAmount(sized.amounts, '').value, 239.93, '預設選字級最大的')

/* 幣別不同時要並存，指定幣別優先於字級 */
const twoCurrencies = parsePaymentText(
  `MOP 192.74\nCNY 158.00`,
  new Map([
    [192.74, 51],
    [158, 32],
  ]),
)
assert.equal(twoCurrencies.amounts.length, 2, '不同幣別都要保留')
assert.equal(twoCurrencies.amounts[0].value, 192.74)
assert.equal(pickDefaultAmount(twoCurrencies.amounts, 'CNY').value, 158, '指定幣別優先於字級')

/* 小數點被讀丟時（8.92 讀成 892），留有小數點的那個 */
const dotTwins = parsePaymentText(
  `拼单价 ¥8.92\n实付 ¥892`,
  new Map([
    [892, 44],
    [8.92, 35],
  ]),
)
assert.equal(dotTwins.amounts.length, 1, '同一個數字的無小數點讀法要丟掉')
assert.equal(dotTwins.amounts[0].value, 8.92)
assert.equal(pickDefaultAmount(dotTwins.amounts, 'CNY').value, 8.92, '預設要是 8.92 而不是 892')

/* 合併兩個模式時也適用 */
const dotTwinsMerged = mergeParsed([
  { dates: [], amounts: [{ currency: 'CNY', value: 892, text: '892', labeled: false, score: 5, height: 44 }] },
  { dates: [], amounts: [{ currency: 'CNY', value: 8.92, text: '8.92', labeled: false, score: 3, height: 35 }] },
])
assert.equal(dotTwinsMerged.amounts.length, 1)
assert.equal(dotTwinsMerged.amounts[0].value, 8.92)

/* 同一個數字出現很多次時取中位數，不能被某一次的異常大字拉走 */
const digitWord = (text, height) => ({
  text,
  bbox: { x0: 0, y0: 0, x1: 10, y1: height },
  symbols: [{ text: (text.match(/\d/) ?? ['1'])[0], bbox: { x0: 0, y0: 0, x1: 10, y1: height } }],
})
const medianHeights = extractHeights({
  blocks: [
    {
      paragraphs: [
        {
          lines: [
            { words: [digitWord('5', 67), digitWord('-¥5', 35), digitWord('5', 28)] },
          ],
        },
      ],
    },
  ],
})
assert.equal(medianHeights.get(5), 35, '取中位數，不是最大值')

/* 「共5件」的 5 不是金額，它的字框不能算進來（實測會被讀成 67） */
const quantityHeights = extractHeights({
  blocks: [
    {
      paragraphs: [
        {
          lines: [{ words: [digitWord('5', 67), digitWord('件', 20), digitWord('46.39', 40)] }],
        },
      ],
    },
  ],
})
assert.equal(quantityHeights.get(5), undefined, '數量詞前面的數字不算金額的字級')
assert.equal(quantityHeights.get(46.39), 40, '同一行的金額不受影響')

/* ¥ 被讀成 y 或羊時還是要認得出來 */
const misreadYen = parsePaymentText('共 5 件 , 合 计 y 46.39\n实付 羊 12.30')
assert.equal(misreadYen.amounts[0].value, 46.39)
assert.equal(misreadYen.amounts[0].currency, 'CNY')
assert.equal(misreadYen.amounts[0].labeled, true, 'y 要當成 ¥，前面的「合计」才算標籤')
assert.equal(misreadYen.amounts[1].currency, 'CNY')
/* 英文字尾的 y 不能被當成幣別 */
assert.equal(parsePaymentText('Delivery 5').amounts.length, 0)

/* 合併兩種模式時，同一個金額取字級較大的描述 */
const mergedByHeight = mergeParsed([
  { dates: [], amounts: [{ currency: 'CNY', value: 95, labeled: false, score: 1, height: 20 }] },
  { dates: [], amounts: [{ currency: 'CNY', value: 95, labeled: true, score: 5, height: 51 }] },
])
assert.equal(mergedByHeight.amounts[0].height, 51)

/* ---------- 兩次辨識結果合併 ---------- */
const merged = mergeParsed([
  {
    dates: [{ ms: 1000, hasTime: true, text: 'a' }],
    amounts: [
      { currency: 'CNY', value: 95, labeled: false, score: 1 },
      { currency: 'MOP', value: 20, labeled: true, score: 2 },
    ],
  },
  {
    dates: [{ ms: 1000, hasTime: false, text: 'b' }],
    amounts: [
      { currency: 'CNY', value: 95, labeled: true, score: 5 },
      { currency: 'CNY', value: 7, labeled: false, score: 1 },
    ],
  },
])
assert.equal(merged.dates.length, 1, '同一時間只留一筆')
assert.equal(merged.amounts.length, 3)
assert.equal(merged.amounts[0].value, 95, '分數高的要排前面')
assert.equal(merged.amounts[0].labeled, true, '同一筆金額要取分數高的那份')
assert.deepEqual(parsePaymentText(''), { dates: [], amounts: [] })
assert.deepEqual(mergeParsed([]), { dates: [], amounts: [] })

/* 停車費：真實金額在 67.00，同一頁的流水號裡也有 67 但不該被算進去 */
const parking = `23:05 al = (6% AR EE 台山 港 航 经 营 开 发 有 限 公 司 -67.00
目前 状态 支付 成 功
支付 时 间 2026/9/13 18:01:50
商家 单 号 201211030016000532609130067961`
const pk = parsePaymentText(parking)
assert.equal(pk.amounts.length, 1, '流水號裡的 67 不該被算成金額')
assert.equal(pk.amounts[0].value, 67)
assert.equal(pk.amounts[0].text, '67.00')
assert.equal(pickDate(pk.dates), new Date(2026, 8, 13, 18, 1, 50).getTime())

/* 沒有金額也無日期時要安全回傳 */
assert.deepEqual(parsePaymentText(''), { dates: [], amounts: [] })
assert.equal(pickDate([]), 0)
assert.equal(pickDefaultAmount([], 'MOP'), null)

/* ---------- MD5 ---------- */
const md5 = (s) => md5Hex(new TextEncoder().encode(s))
assert.equal(md5(''), 'd41d8cd98f00b204e9800998ecf8427e')
assert.equal(md5('abc'), '900150983cd24fb0d6963f7d28e17f72')
assert.equal(md5('message digest'), 'f96b697d7cb7938d525a2f31aaf161d0')
assert.equal(
  md5('The quick brown fox jumps over the lazy dog'),
  '9e107d9d372bb6826bd81d3542a419d6',
)
/* 跨 64 byte 邊界 */
assert.equal(
  md5('12345678901234567890123456789012345678901234567890123456789012345678901234567890'),
  '57edf4a22be3c955ac49da2e2107b67a',
)
/* 相同內容必相同、不同內容必不同 */
assert.equal(md5('payment'), md5('payment'))
assert.notEqual(md5('payment'), md5('paymenT'))

/* ---------- 匯出／匯入：來回必須一模一樣 ---------- */
const encode = async (blob) => `B64:${blob.tag}`
const decode = async (b64) => ({ tag: String(b64).slice(4) })

const makeRecord = (over = {}) => ({
  id: 'r1',
  fileName: 'a.png',
  file: { tag: 'AAA' },
  fileTime: 1700000000000,
  fileTimeSource: 'exif',
  hash: 'h1',
  ocrStatus: 'done',
  ocrText: '付款金額 ¥ 128.50',
  ocrError: '',
  amounts: [{ currency: 'CNY', value: 128.5, labeled: true, text: '128.50' }],
  currency: 'CNY',
  currencyLocked: true,
  amount: '128.5',
  paidAtText: '2024-03-05 14:22',
  paidAtManual: false,
  payerId: 'p1',
  beneficiaryIds: ['p2'],
  note: '午餐',
  ...over,
})

const originals = [
  makeRecord(),
  makeRecord({ id: 'r2', fileName: 'b.png', file: { tag: 'BBB' }, hash: 'h2', note: '', amount: '' }),
]
const personList = [
  { id: 'p1', name: '我', isSelf: true },
  { id: 'p2', name: '小明', isSelf: false },
]

const backup1 = await toBackup(originals, personList, 'MOP', encode)
const restored = await fromBackup(backup1, decode)
const backup2 = await toBackup(restored.records, restored.persons, restored.defaultCurrency, encode)

assert.deepEqual(backup2.records, backup1.records, '匯入後的資料必須和匯出前一樣')
assert.deepEqual(backup2.persons, backup1.persons)
assert.equal(backup2.defaultCurrency, 'MOP')

/* 合併：空的全部進，再一次就全部略過 */
const first = mergeRecords([], restored.records)
assert.equal(first.added.length, 2)
assert.equal(first.skipped, 0)
const second = mergeRecords(first.added, restored.records)
assert.equal(second.added.length, 0)
assert.equal(second.skipped, 2)

/* ---------- 人物對齊（別名） ---------- */
const existingPeople = [
  { id: 'a1', name: 'Vincent', isSelf: true, aliases: [] },
  { id: 'a2', name: 'Ben', isSelf: false, aliases: [] },
]

/* 只差大小寫或頭尾空白 → 自動同一人，比對本來就忽略大小寫，不必存別名 */
const caseOnly = resolvePersons(existingPeople, [
  { id: 'x1', name: 'VINCENT', isSelf: false, aliases: [] },
  { id: 'x2', name: '  Ben ', isSelf: false, aliases: [] },
])
assert.equal(caseOnly.needsDecision.length, 0)
assert.equal(caseOnly.idMap.get('x1'), 'a1')
assert.equal(caseOnly.idMap.get('x2'), 'a2')
assert.equal(caseOnly.persons.length, 2)
assert.deepEqual(caseOnly.persons.find((p) => p.id === 'a1').aliases, [])
assert.deepEqual(caseOnly.persons.find((p) => p.id === 'a2').aliases, [])

/* 完全不同的寫法（餅 vs Ben）對不上，要問使用者 */
const needAsk = resolvePersons(existingPeople, [
  { id: 'y1', name: '餅', isSelf: false, aliases: [] },
])
assert.equal(needAsk.needsDecision.length, 1)
assert.equal(needAsk.needsDecision[0].name, '餅')
assert.equal(needAsk.idMap.size, 0)

/* 選「對應到 Ben」→ 記成別名 */
const aligned = resolvePersons(
  existingPeople,
  [{ id: 'y1', name: '餅', isSelf: false, aliases: [] }],
  { y1: 'a2' },
)
assert.equal(aligned.needsDecision.length, 0)
assert.equal(aligned.idMap.get('y1'), 'a2')
assert.equal(aligned.persons.length, 2)
assert.deepEqual(aligned.persons.find((p) => p.id === 'a2').aliases, ['餅'])

/* 別名記住之後，下次同一個寫法不用再問 */
const again = resolvePersons(aligned.persons, [
  { id: 'y1', name: '餅', isSelf: false, aliases: [] },
])
assert.equal(again.needsDecision.length, 0)
assert.equal(again.idMap.get('y1'), 'a2')

/* 選「建立新人物」→ 增加新人物 */
const asNew = resolvePersons(
  existingPeople,
  [{ id: 'y1', name: '餅', isSelf: false, aliases: [] }],
  { y1: 'new' },
)
assert.equal(asNew.persons.length, 3)
assert.equal(asNew.idMap.get('y1'), 'y1')
assert.equal(asNew.persons.find((p) => p.id === 'y1').name, '餅')

/* 匯入檔裡的「自己」不會蓋掉現有的自己 */
const selfKeep = resolvePersons(
  existingPeople,
  [{ id: 'z1', name: '小明', isSelf: true, aliases: [] }],
  { z1: 'new' },
)
assert.equal(selfKeep.persons.filter((p) => p.isSelf).length, 1)
assert.equal(selfKeep.persons.find((p) => p.id === 'a1').isSelf, true)
assert.equal(selfKeep.persons.find((p) => p.id === 'z1').isSelf, false)

/* 目前完全沒有其他人物時（第一次匯入）不應該問任何問題 */
const firstImport = resolvePersons([], restored.persons)
assert.equal(firstImport.needsDecision.length, 0)
assert.equal(firstImport.persons.length, 2)

/* 記錄的付錢人／受益人會換成對齊後的 id，重複的會去掉 */
const mapped = remapRecords(
  [
    { id: 'r1', payerId: 'y1', beneficiaryIds: ['y1', 'y2'] },
    { id: 'r2', payerId: 'unknown', beneficiaryIds: [] },
  ],
  new Map([
    ['y1', 'a2'],
    ['y2', 'a2'],
  ]),
)
assert.equal(mapped[0].payerId, 'a2')
assert.deepEqual(mapped[0].beneficiaryIds, ['a2'])
assert.equal(mapped[1].payerId, 'unknown')

/* 壞掉的檔案要擋下來 */
await assert.rejects(() => fromBackup({ app: 'other' }, decode), /不是本程式/)
await assert.rejects(() => fromBackup(null, decode), /不是本程式/)

/* ---------- 分享連結參數 ---------- */
assert.deepEqual(parseShareParams('?persons=Vincent,Ben,Ken&currency=CNY'), {
  names: ['Vincent', 'Ben', 'Ken'],
  currency: 'CNY',
  notes: [],
})
/* 備注分類也可以從連結帶進來（空白、括號都要保留） */
assert.deepEqual(parseShareParams('?notes=吃_早餐,租車_高速費(去程),飲_廢水( )').notes, [
  '吃_早餐',
  '租車_高速費(去程)',
  '飲_廢水( )',
])
assert.deepEqual(parseShareParams('?notes=吃_早餐,吃_早餐').notes, ['吃_早餐'], '重複只留一個')
assert.deepEqual(parseShareParams('?notes=a、b；c').notes, ['a', 'b', 'c'], '中文分隔號也要能用')
/* 中文逗號、頓號、分號都要能分隔；空白要去掉 */
assert.deepEqual(parseShareParams('?persons=%E9%99%B3%E5%A4%A7%E6%96%87%E3%80%81Ben%3BKen').names, [
  '陳大文',
  'Ben',
  'Ken',
])
/* 重複的名字只留一個（忽略大小寫） */
assert.deepEqual(parseShareParams('?persons=Vincent,vincent,VINCENT').names, ['Vincent'])
/* 幣別只收 3 個英文字母 */
assert.equal(parseShareParams('?currency=cny').currency, 'CNY')
assert.equal(parseShareParams('?currency=人民幣').currency, '')
assert.equal(parseShareParams('?currency=ABCD').currency, '')
/* 沒有參數、空字串都不該出錯 */
assert.deepEqual(parseShareParams(''), { names: [], currency: '', notes: [] })
assert.deepEqual(parseShareParams('?foo=bar'), { names: [], currency: '', notes: [] })
assert.deepEqual(parseShareParams('?persons=,,, ,').names, [])
/* 數量與長度要設上限，避免有人用超長網址灌爆資料 */
assert.equal(parseShareParams(`?persons=${Array.from({ length: 50 }, (_, i) => `n${i}`).join(',')}`).names.length, 30)
assert.equal(parseShareParams(`?persons=${'x'.repeat(200)}`).names[0].length, 40)
/* 控制字元要清掉 */
assert.deepEqual(parseShareParams('?persons=%00A%1FB').names, ['AB'])

/* ---------- HEIC 偵測（看檔頭，不看副檔名） ---------- */
const ftyp = (brand, len = 24) => {
  const b = new Uint8Array(len)
  b.set([...'ftyp'].map((c) => c.charCodeAt(0)), 4)
  b.set([...brand].map((c) => c.charCodeAt(0)), 8)
  return new Blob([b])
}

assert.equal(await isHeic(ftyp('heic')), true, 'iPhone 相機的 HEIC')
assert.equal(await isHeic(ftyp('heix')), true)
assert.equal(await isHeic(ftyp('hevc')), true)
assert.equal(await isHeic(ftyp('mif1')), false, 'mif1 太籠統，交給後面解碼檢查處理')
assert.equal(await isHeic(ftyp('avif')), false, 'AVIF 到處都解得到，不該被當成 HEIC')
assert.equal(await isHeic(ftyp('mp42')), false, 'MP4 影片')

/* 真的 JPEG / PNG 不能被誤判 */
const jpegHead = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1])
assert.equal(await isHeic(new Blob([jpegHead])), false)
const pngHead = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
assert.equal(await isHeic(new Blob([pngHead])), false)

/* 太短或有 ftyp 但位置不對，都不算 */
assert.equal(await isHeic(new Blob([new Uint8Array(4)])), false)
const shifted = new Uint8Array(16)
shifted.set([...'ftyp'].map((c) => c.charCodeAt(0)), 8)
assert.equal(await isHeic(new Blob([shifted])), false, 'ftyp 位置不對')

/* ---------- 來源-序號 ---------- */
const labelled = labelBySource([
  { id: 'a', source: '本機' },
  { id: 'b', source: '本機' },
  { id: 'c', source: '一月帳單' },
  { id: 'd', source: '本機' },
  { id: 'e' },
])
assert.equal(labelled.get('a'), '本機-1')
assert.equal(labelled.get('b'), '本機-2')
assert.equal(labelled.get('c'), '一月帳單-1', '不同來源各自從 1 開始')
assert.equal(labelled.get('d'), '本機-3', '同來源要接續編號')
assert.equal(labelled.get('e'), '本機-4', '沒有來源的視為預設來源')
assert.equal(labelBySource([]).size, 0)

/* ---------- 匯出檔名的名字片段 ---------- */
assert.equal(safeFileNamePart('Vincent'), 'Vincent')
assert.equal(safeFileNamePart('陳大文'), '陳大文')
assert.equal(safeFileNamePart('Ben/Ken'), 'BenKen', '斜線不能留在檔名裡')
assert.equal(safeFileNamePart('A:B*C?D"E<F>G|H\\I'), 'ABCDEFGHI')
assert.equal(safeFileNamePart('  spaced  '), 'spaced')
assert.equal(safeFileNamePart(''), '')
assert.equal(safeFileNamePart(undefined), '')
assert.equal(safeFileNamePart(`a${String.fromCharCode(0)}b${String.fromCharCode(31)}c`), 'abc')
assert.equal(safeFileNamePart('x'.repeat(100)).length, 40)

/* ---------- 匯出壓縮：縮放比例 ---------- */
/* 1290×2796 的手機截圖：短邊要留在 700，比例不能走掉 */
assert.equal(fitScale(1290, 2796, 700), 700 / 1290)
assert.equal(Math.round(1290 * fitScale(1290, 2796, 700)), 700)
assert.equal(Math.round(2796 * fitScale(1290, 2796, 700)), 1517)
/* 比例（長寬比）必須跟原圖一樣 */
const ratio = (w, h, s) => (w * s) / (h * s)
assert.equal(ratio(1290, 2796, fitScale(1290, 2796, 700)), 1290 / 2796)
/* 橫向圖片也看短邊 */
assert.equal(Math.round(1000 * fitScale(4000, 1000, 700)), 700)
/* 比門檻小的圖不放大 */
assert.equal(fitScale(600, 900, 700), 1)
assert.equal(fitScale(1290, 2796, 0), 1)
assert.equal(fitScale(0, 0, 700), 1)

/* ---------- 存進 IndexedDB 的圖片格式（Safari 不能直接存 Blob） ---------- */
const srcFile = new File([new Uint8Array([1, 2, 3, 4, 5])], 'IMG_1.PNG', {
  type: 'image/png',
  lastModified: 1234,
})
const storedRow = { fileName: 'IMG_1.PNG', fileTime: 999, ...(await fileToStored(srcFile)) }
assert.equal(storedRow.file, undefined, '存下來的資料不能有 file 這個欄位')
assert.equal(storedRow.fileType, 'image/png')
assert.ok(storedRow.fileBytes instanceof ArrayBuffer, '要存 bytes')

const revived = storedToFile(storedRow)
assert.equal(revived.name, 'IMG_1.PNG')
assert.equal(revived.type, 'image/png')
assert.equal(revived.lastModified, 1234)
assert.equal(revived.size, 5)
assert.deepEqual([...new Uint8Array(await revived.arrayBuffer())], [1, 2, 3, 4, 5], '讀回來的內容要一樣')

/* 舊格式（直接把 File 存進去）也要讀得回來 */
assert.equal(storedToFile({ file: srcFile }), srcFile)
/* 沒有 lastModified 就退回 fileTime */
assert.equal(storedToFile({ fileName: 'a', fileBytes: new ArrayBuffer(1), fileTime: 777 }).lastModified, 777)
/* 手動新增的記錄沒有圖片 */
assert.equal(storedToFile({}), null)
assert.equal(storedToFile(null), null)
assert.equal(storedToFile(undefined), null)

/* ---------- 分享連結名單的指紋（用來記住已經套用過） ---------- */
assert.equal(shareLinkKey(['Vincent', 'Ben']), shareLinkKey(['ben', 'VINCENT']), '大小寫與順序不影響')
assert.equal(shareLinkKey(['Vincent']), 'vincent')
assert.notEqual(shareLinkKey(['Vincent']), shareLinkKey(['Vincent', 'Ben']), '不同名單要不同指紋')
assert.equal(shareLinkKey(['Vincent', 'Vincent']), 'vincent', '重複的名字只算一次')
assert.equal(shareLinkKey([]), '')
assert.equal(shareLinkKey(undefined), '')

/* ---------- 圖片型別判斷（iOS 貼上會給 UTI：public.jpeg） ---------- */
const sniffJpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46])
const sniffPng = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const chars = (s) => new Uint8Array([...s].map((c) => c.charCodeAt(0)))

/* 真實情境：宣告值是 UTI（public.jpeg），檔頭是 JPEG */
assert.equal(sniffImageType(sniffJpeg, 'public.jpeg'), 'image/jpeg')
assert.equal(sniffImageType(sniffPng, 'public.png'), 'image/png')
/* 檔頭優先於錯誤的宣告值 */
assert.equal(sniffImageType(sniffJpeg, 'text/plain'), 'image/jpeg')
/* 認不出檔頭時，把 UTI 轉成 MIME */
assert.equal(sniffImageType(new Uint8Array(4), 'public.jpeg'), 'image/jpeg')
assert.equal(sniffImageType(new Uint8Array(4), 'public.heic'), 'image/heic')
/* 空型別＋認不出檔頭 → 空字串，呼叫端才知道「不是圖」 */
assert.equal(sniffImageType(new Uint8Array(4), ''), '')
assert.equal(sniffImageType(new Uint8Array(4), 'application/pdf'), 'application/pdf')
/* 其他檔頭 */
assert.equal(sniffImageType(chars('GIF89a')), 'image/gif')
assert.equal(sniffImageType(chars('RIFF0000WEBPVP8 ')), 'image/webp')
assert.equal(sniffImageType(chars('0000ftypheic0000')), 'image/heic')
assert.equal(sniffImageType(new Uint8Array([0x42, 0x4d, 0x00])), 'image/bmp')

/* ---------- MIME → 副檔名 ---------- */
assert.equal(extFromMime('image/jpeg'), 'jpg')
assert.equal(extFromMime('image/png'), 'png')
assert.equal(extFromMime('image/heic'), 'heic')
assert.equal(extFromMime('something-else'), 'png')

/* ---------- 人物與記錄的關聯 ---------- */
const recA = { id: 'r1', payerId: 'p1', beneficiaryIds: ['p2', 'p3'] }
const recB = { id: 'r2', payerId: 'p2', beneficiaryIds: [] }
assert.equal(recordsUsingPerson([recA, recB], 'p1').length, 1, '付款人也算用到')
assert.equal(recordsUsingPerson([recA, recB], 'p3').length, 1, '受益人也算用到')
assert.equal(recordsUsingPerson([recA, recB], 'p2').length, 2, '兩種身分都算')
assert.equal(recordsUsingPerson([recA, recB], 'p9').length, 0, '沒用到就沒有')
assert.equal(recordsUsingPerson([recA, recB], '').length, 0, '空 id 不算')

const people = [
  { id: 'p1', name: 'Vincent' },
  { id: 'p2', name: 'Ben' },
]
assert.deepEqual(
  personNameSnapshot(recA, people),
  { p1: 'Vincent', p2: 'Ben' },
  '快照只存認得出來的名字（p3 不在清單裡就不存）',
)

/* 人物不見了：有名字快照就補回來，沒名字的不亂補 */
const dangling = [
  { id: 'r1', payerId: 'pX', beneficiaryIds: ['p1'], personNames: { pX: '阿明' } },
  { id: 'r2', payerId: 'pY', beneficiaryIds: [], personNames: {} },
]
const healed = restoreMissingPersons(people, dangling)
assert.equal(healed.restored.length, 1, '只有有名字的補回來')
assert.equal(healed.restored[0].name, '阿明')
assert.equal(healed.persons.length, 3)
assert.equal(healed.persons.filter((p) => p.id === 'p3').length, 0, '不重複補')
assert.deepEqual(
  restoreMissingPersons(healed.persons, dangling).restored.length,
  0,
  '補過就不再補一次',
)
assert.deepEqual(missingPersonIds(people, dangling[0]), ['pX'], '還缺的 id 要能查出來')
assert.deepEqual(missingPersonIds(healed.persons, dangling[0]), [], '補回來之後就不缺了')

/* ---------- 從貼上的文字取出分享參數 ---------- */
assert.equal(
  searchFromText('https://vincentwongmax.github.io/payments/?persons=A,B&currency=CNY'),
  '?persons=A,B&currency=CNY',
  '整串網址',
)
assert.equal(searchFromText('?persons=A'), '?persons=A', '只有查詢字串')
assert.equal(searchFromText('persons=A&currency=CNY'), '?persons=A&currency=CNY', '只有參數')
assert.equal(searchFromText('  Vincent,Ben  '), '', '看不出參數就當作沒有')
assert.equal(searchFromText(''), '')
assert.deepEqual(parseShareParams(searchFromText('x.com/?persons=Vincent,Ben&currency=CNY')), {
  names: ['Vincent', 'Ben'],
  currency: 'CNY',
  notes: [],
})

/* ---------- 備注分類 ---------- */
assert.ok(DEFAULT_NOTE_CATEGORIES.includes('吃_早餐'))
assert.ok(DEFAULT_NOTE_CATEGORIES.includes('飲_廢水( )'), '空白括號要原樣保留')
assert.equal(DEFAULT_NOTE_CATEGORIES.length, 10)
assert.deepEqual(
  seedNoteCategories().slice(0, 3).map((c) => c.text),
  ['吃_早餐', '吃_午餐', '吃_晚餐'],
)
assert.ok(seedNoteCategories().every((c) => c.link === false), '預設的不是從連結來的')

/* 去重（忽略大小寫與前後空白）、空的丟掉、連結標記要保留 */
const mergedNotes = normalizeNoteCategories([
  '吃_早餐',
  { text: ' 吃_早餐 ', link: true },
  { text: '打車(去程)', link: true },
  { text: '   ' },
  'AB',
  'ab',
])
assert.deepEqual(
  mergedNotes.map((c) => c.text),
  ['吃_早餐', '打車(去程)', 'AB'],
)
assert.equal(mergedNotes[0].link, true, '同一個分類只要有一個來自連結就標成連結')

/* 重置時：沒勾就只留連結來的；有勾就全留 */
const list = normalizeNoteCategories([
  { text: '內建', link: false },
  { text: '連結來的', link: true },
])
assert.deepEqual(
  keepNoteCategories(list, false).map((c) => c.text),
  ['連結來的'],
)
assert.deepEqual(
  keepNoteCategories(list, true).map((c) => c.text),
  ['內建', '連結來的'],
)
assert.equal(noteKey('  吃_早餐  '), '吃_早餐')

/* ---------- PWA：離線可用需要的檔案 ---------- */
const root = new URL('..', import.meta.url)
const readRoot = (f) => readFileSync(new URL(f, root), 'utf8')

for (const file of [
  'public/sw.js',
  'public/manifest.json',
  'public/icons/icon-192.png',
  'public/icons/icon-512.png',
  'public/icons/apple-touch-icon.png',
]) {
  assert.ok(existsSync(new URL(file, root)), `離線可用需要 ${file}`)
}

const shell = readRoot('index.html')
assert.match(shell, /rel="manifest"/, 'index.html 要連到 manifest')
assert.match(shell, /apple-touch-icon/, 'index.html 要有 iOS 加到主畫面的圖示')

const manifest = JSON.parse(readRoot('public/manifest.json'))
assert.equal(manifest.display, 'standalone', '加到主畫面要全螢幕')
assert.ok(manifest.icons?.length >= 2, 'manifest 要提供圖示')
assert.equal(manifest.scope, './', '要能在子路徑（GitHub Pages）下開')
/*
 * 刻意不寫 start_url：iOS 加到主畫面時會用它當開啟網址，
 * 一寫死就把分享連結的 ?persons=…&currency=… 丟掉了。
 * 沒有 start_url 時預設就是「當時那一頁的網址」，參數才會留下來。
 */
assert.equal(manifest.start_url, undefined, 'manifest 不要寫 start_url，否則 iOS 會丟掉網址參數')

const sw = readRoot('public/sw.js')
assert.match(sw, /addEventListener\('fetch'/, 'Service Worker 要有 fetch 處理')
assert.match(sw, /traineddata/, 'Service Worker 不該快取語言模型（tesseract 自己存 IndexedDB）')
assert.match(sw, /new Response\(/, '存進快取前要重新包成乾淨的回應，否則 gzip 標頭會讓 script 載入失敗')

console.log('test/run.js: 全部通過')
