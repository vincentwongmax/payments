/* 離線 OCR：引擎檔在 public/tesseract，執行時不連外網。
   上半部是純函式（可被 node 測試），下半部才是瀏覽器 worker。 */

const CURRENCY_RULES = [
  ['MOP', /MOP|澳門幣|澳門元|葡幣|PATACA/i],
  ['CNY', /CNY|RMB|人民幣|￥|¥/i],
  ['HKD', /HKD|港幣|港元/i],
  ['TWD', /TWD|NT\$|新台幣|台幣/i],
  ['USD', /USD|US\$|美元/i],
  ['JPY', /JPY|日圓|日元/i],
  ['EUR', /EUR|€|歐元/i],
  ['GBP', /GBP|£|英鎊/i],
  ['SGD', /SGD|新加坡幣/i],
  ['AUD', /AUD|澳元/i],
  ['KRW', /KRW|韓元/i],
]

/* OCR 會在中文之間插空格（「订 单 金 额」），所以關鍵字要比對時容許空白 */
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const looseSrc = (word) => [...word].map(escapeRe).join('\\s*')
const looseAny = (words) => words.map(looseSrc).join('|')

/* 真正的金額標籤（越強越可信） */
const STRONG_WORDS = [
  '实付', '實付', '实付款', '订单金额', '订单金額', '付款金额', '付款金額',
  '支付金额', '支付金額', '合计', '合計', '总计', '總計', '总额', '總額',
  '小计', '小計', '应付', '應付', '金额', '金額', 'amount', 'total',
]
const STRONG_TAIL = new RegExp(
  `(?:${looseAny(STRONG_WORDS)})\\s*[:：]?\\s*(?:[¥￥$]|[A-Z]{3})?\\s*$`,
  'i',
)

/* 緊接在數字前面的字不可能是金額（號碼、卡片、積分…） */
const BAD_TAIL_WORDS = [
  '号', '號', '单', '單', '码', '碼', '凭证', '憑證', '流水', '奖励', '獎勵',
  '积分', '積分', '卡', '方式', '账户', '帳戶', '帐户', '时间', '時間',
]
const BAD_TAIL = new RegExp(
  `(?:${looseAny(BAD_TAIL_WORDS)})\\s*[:：]?\\s*[\\[\\(（【]?\\s*$`,
)

/* 緊接在數字後面的字代表它不是金額（積分、% 、折…） */
const BAD_HEAD_WORDS = [
  '积分', '積分', '分', '点', '點', '个', '個', '次', '号', '號', '单', '單',
  '笔', '筆', '张', '張', '折', '倍', '%', '位', '条', '條', '=', '＝',
]
const BAD_HEAD = new RegExp(`^\\s*[\\]\\)）】]?\\s*(?:${looseAny(BAD_HEAD_WORDS)})`)

const CURRENCY_CODES = /^(CNY|RMB|MOP|HKD|USD|TWD|JPY|EUR|GBP|SGD|AUD|KRW|MYR|THB|NZD|CAD|CHF)$/i
const MAX_AMOUNT = 1e7
const NUMBER_RE = /\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+\.\d{1,2}|\d+/g

/**
 * 從 tesseract 的文字框算出「每個數字有多大」。
 * 用數字字元本身高度的中位數，不用整框高度——整框會被標點灌水
 * （實測折扣那行 `-#0.07` 整框 59，但數字其實只有 32）。
 */
export function extractHeights(data) {
  const heights = new Map()
  const words = (data?.blocks ?? [])
    .flatMap((block) => block.paragraphs ?? [])
    .flatMap((p) => p.lines ?? [])
    .flatMap((line) => line.words ?? [])

  for (const word of words) {
    const digitHeights = (word.symbols ?? [])
      .filter((s) => /\d/.test(s.text))
      .map((s) => s.bbox.y1 - s.bbox.y0)
      .sort((a, b) => a - b)
    if (!digitHeights.length) continue
    const height = digitHeights[Math.floor(digitHeights.length / 2)]

    NUMBER_RE.lastIndex = 0
    let m
    while ((m = NUMBER_RE.exec(word.text ?? ''))) {
      const value = Number(m[0].replace(/,/g, ''))
      if (!Number.isFinite(value)) continue
      if ((heights.get(value) ?? 0) < height) heights.set(value, height)
    }
  }
  return heights
}

/* 日期：需人工檢查前後不是數字，避免把交易號切出日期 */
const DATE_PATTERNS = [
  {
    re: /(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/g,
    hasTime: (m) => m[4] !== undefined,
  },
  { re: /(20\d{2})(\d{2})(\d{2})/g, hasTime: () => false },
  { re: /(\d{1,2})[-/](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/g, hasTime: () => true },
]

const isDigit = (c) => c >= '0' && c <= '9'

/* 取幣別：緊貼在數字前的優先（MOP 192.74 (CNY 158.00) 要用 MOP），
   其次是緊接在後的，最後才用同一行最近的。 */
function atEnd(text, anchor) {
  const t = text.trimEnd()
  for (const [code, re] of CURRENCY_RULES) {
    if (new RegExp(`(?:${re.source})${anchor}`, 'i').test(t)) return code
  }
  return ''
}

function atStart(text) {
  const t = text.trimStart()
  for (const [code, re] of CURRENCY_RULES) {
    if (new RegExp(`^(?:${re.source})`, 'i').test(t)) return code
  }
  return ''
}

function nearestCurrency(before, after) {
  let best = null
  for (const [code, re] of CURRENCY_RULES) {
    const b = [...before.matchAll(new RegExp(re.source, 'gi'))].pop()
    if (b) {
      const dist = before.length - b.index
      if (!best || dist < best.dist) best = { code, dist }
    }
    const a = new RegExp(re.source, 'gi').exec(after)
    if (a && (!best || a.index < best.dist)) best = { code, dist: a.index }
  }
  return best?.code ?? ''
}

function detectCurrency(before, after) {
  const symbolEnd = /\$$/.test(before.trimEnd()) ? '$' : ''
  const symbolStart = /^\$/.test(after.trimStart()) ? '$' : ''
  return atEnd(before, '$') || symbolEnd || atStart(after) || symbolStart || nearestCurrency(before, after)
}

function toMs(y, mo, d, h = 0, mi = 0, s = 0) {
  if (!y) return 0
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return 0
  const date = new Date(y, mo - 1, d, h, mi, s)
  return Number.isNaN(date.getTime()) ? 0 : date.getTime()
}

/** 從 OCR 文字抓出日期與金額（含幣別）。heights 來自 extractHeights，代表字級。 */
export function parsePaymentText(text, heights) {
  const src = String(text ?? '')
  const chars = [...src]
  const dates = []

  for (const { re, hasTime } of DATE_PATTERNS) {
    re.lastIndex = 0
    let m
    while ((m = re.exec(src))) {
      const start = m.index
      const end = start + m[0].length
      const before = src[start - 1]
      const after = src[end]
      if ((before && isDigit(before)) || (after && isDigit(after))) continue

      const withTime = hasTime(m)
      let ms = 0
      if (m.length >= 4 && m[1]?.length === 4) {
        ms = toMs(+m[1], +m[2], +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0))
      } else if (m.length >= 3 && hasTime) {
        ms = toMs(new Date().getFullYear(), +m[1], +m[2], +m[3], +m[4], +(m[5] ?? 0))
      }
      if (!ms) continue

      dates.push({ ms, hasTime: withTime, text: m[0].trim() })
      for (let i = start; i < end; i++) chars[i] = ' '
    }
  }

  const masked = chars.join('')
  const amounts = []
  const numRe = /\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+\.\d{1,2}|\d+/g
  let n
  while ((n = numRe.exec(masked))) {
    const start = n.index
    const end = start + n[0].length
    if (isDigit(masked[start - 1] ?? '') || isDigit(masked[end] ?? '')) continue

    const raw = n[0]
    const value = Number(raw.replace(/,/g, ''))
    if (!Number.isFinite(value)) continue

    const lineStart = src.lastIndexOf('\n', start - 1) + 1
    let lineEnd = src.indexOf('\n', end)
    if (lineEnd < 0) lineEnd = src.length
    const before = src.slice(lineStart, start)
    const after = src.slice(end, lineEnd)

    /* 緊貼的英文字母：只有幣別代碼可以，其他都是流水號的一部分 */
    const prevLetters = (before.match(/[A-Za-z]+$/) ?? [''])[0]
    if (prevLetters && !CURRENCY_CODES.test(prevLetters)) continue
    if (/^[A-Za-z]/.test(after)) continue

    /* 前後文一看就知道不是金額：號碼、卡片、積分、百分比… */
    if (BAD_TAIL.test(before) || BAD_HEAD.test(after)) continue
    if (value >= MAX_AMOUNT) continue

    const currency = detectCurrency(before, after)
    const labeled = STRONG_TAIL.test(before)
    const decimal = /\.\d{1,2}$/.test(raw)
    if (!currency && !labeled && !decimal) continue

    const score = (labeled ? 3 : 0) + (currency ? 2 : 0) + (decimal ? 1 : 0)
    amounts.push({
      currency,
      value,
      labeled,
      score,
      height: heights?.get(value) ?? 0,
      text: raw,
    })
  }

  const seen = new Set()
  const unique = amounts
    .filter((a) => {
      const key = `${a.currency}:${a.value}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    /* 字級大的優先：付款畫面會把實際付款金額放最大，小字的是訂單金額或折扣 */
    .sort((a, b) => b.height - a.height || b.score - a.score || b.value - a.value)
    .slice(0, 6)

  return { dates, amounts: unique }
}

/** 挑出最可信的付款時間：有時間的優先。 */
export function pickDate(dates) {
  if (!dates?.length) return 0
  return (dates.find((d) => d.hasTime) ?? dates[0]).ms
}

/**
 * 依「預設幣別」挑出預設金額；沒有指定幣別時，用字級最大的那個
 * （金額欄位已經依字級排序，所以就是第一筆）。
 * 不同幣別（例如 CNY 與 MOP）會並存讓使用者挑，不會只留一個。
 */
export function pickDefaultAmount(amounts, preferredCurrency) {
  if (!amounts?.length) return null
  if (preferredCurrency) {
    const hit = amounts.find((a) => a.currency === preferredCurrency)
    if (hit) return hit
  }
  return amounts[0]
}

/**
 * 合併同一張圖多次辨識的結果（區塊模式 + 稀疏模式）。
 * 同一個金額取字級較大、其次分數較高的那份描述。
 */
export function mergeParsed(results) {
  const dates = []
  const amountByKey = new Map()

  for (const r of results ?? []) {
    dates.push(...(r?.dates ?? []))
    for (const a of r?.amounts ?? []) {
      const key = `${a.currency}:${a.value}`
      const prev = amountByKey.get(key)
      const better =
        !prev ||
        (a.height ?? 0) > (prev.height ?? 0) ||
        ((a.height ?? 0) === (prev.height ?? 0) && a.score > prev.score)
      if (better) amountByKey.set(key, a)
    }
  }

  const seenDate = new Set()
  const uniqueDates = dates.filter((d) => {
    if (seenDate.has(d.ms)) return false
    seenDate.add(d.ms)
    return true
  })

  return {
    dates: uniqueDates,
    amounts: [...amountByKey.values()]
      .sort((a, b) => b.height - a.height || b.score - a.score || b.value - a.value)
      .slice(0, 6),
  }
}

/* ---------------- 瀏覽器端：Tesseract worker ---------------- */

const OCR_BASE = () => new URL('tesseract/', document.baseURI).href

/* 每個 PSM 一個 worker，兩次辨識才能並行跑（序列跑要等一倍時間） */
const OCR_PASSES = ['3', '11']
let workersPromise = null
let tick = () => {}

/* 並行比較快，但兩份語言模型的記憶體約翻倍；手機記憶體小的時候只用一個 */
const desiredWorkerCount = () => ((navigator.deviceMemory ?? 4) >= 4 ? 2 : 1)

async function createWorkerFor(pass) {
  const { createWorker } = await import('tesseract.js')
  const base = OCR_BASE()
  const worker = await createWorker(['eng', 'chi_sim'], 1, {
    workerPath: `${base}worker.min.js`,
    corePath: `${base}core`,
    langPath: `${base}lang`,
    // tesseract 只用檔名當快取 key，換語言模型時一定要改這裡，
    // 否則舊模型會一直從 IndexedDB 被讀回來。
    cachePath: 'traineddata-4.0.0',
    logger: (m) => tick(pass, m),
  })
  await worker.setParameters({ tessedit_pageseg_mode: OCR_PASSES[pass] })
  return worker
}

async function getWorkers() {
  if (!workersPromise) {
    workersPromise = (async () => {
      const first = await createWorkerFor(0)
      if (desiredWorkerCount() === 1) return [first]
      try {
        return [first, await createWorkerFor(1)]
      } catch {
        /* 建不出第二個（多半是記憶體不夠）就退回單一 worker，慢一點但不會失敗 */
        return [first]
      }
    })().catch((e) => {
      workersPromise = null
      throw e
    })
  }
  return workersPromise
}

/** 單張圖片的辨識上限。卡住時寧可報錯，也不要讓使用者對著 0% 發呆。 */
export const OCR_TIMEOUT_MS = 90000

function withTimeout(promise, ms, label) {
  let timer
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}：超過 ${ms / 1000} 秒沒有回應`)), ms)
    }),
  ])
}

/* 逾時通常代表 worker 已經壞了，丟掉它讓下次重建 */
async function resetWorkers() {
  const broken = workersPromise
  workersPromise = null
  try {
    const workers = await broken
    await Promise.all(workers.map((w) => w?.terminate()))
  } catch {
    /* 本來就已經壞了 */
  }
}

/**
 * 一張圖同時跑兩種辨識模式：
 *   3  = 區塊模式，密集文字與日期最準
 *   11 = 稀疏模式，付款 App 那種浮動的大字金額只有它讀得到
 * 兩個 worker 並行，所以時間約等於跑一次；結果由呼叫端用 mergeParsed 合併。
 */
/* 需要 blocks 才有文字框，才能算出每個金額的字級 */
const OCR_OUTPUT = { text: true, blocks: true }

const toPass = (result) => ({
  text: result?.data?.text ?? '',
  heights: extractHeights(result?.data),
})

export async function recognizePasses(image, onProgress) {
  tick = (pass, m) => onProgress?.(m, pass, OCR_PASSES.length)

  try {
    const workers = await withTimeout(getWorkers(), OCR_TIMEOUT_MS * 2, '載入 OCR 引擎')

    /* 只有一個 worker 時就依序跑兩種模式 */
    if (workers.length === 1) {
      const passes = []
      for (let pass = 0; pass < OCR_PASSES.length; pass++) {
        await workers[0].setParameters({ tessedit_pageseg_mode: OCR_PASSES[pass] })
        const result = await withTimeout(
          workers[0].recognize(image, {}, OCR_OUTPUT),
          OCR_TIMEOUT_MS,
          `辨識圖片（模式 ${OCR_PASSES[pass]}）`,
        )
        passes.push(toPass(result))
      }
      return passes
    }

    const results = await Promise.all(
      workers.map((worker, pass) =>
        withTimeout(
          worker.recognize(image, {}, OCR_OUTPUT),
          OCR_TIMEOUT_MS,
          `辨識圖片（模式 ${OCR_PASSES[pass]}）`,
        ),
      ),
    )
    return results.map(toPass)
  } catch (e) {
    await resetWorkers()
    throw e
  }
}

/** 先在背景把引擎與語言包載好，第一次上傳就不用等。 */
export const preloadOcr = () => getWorkers().catch(() => null)
