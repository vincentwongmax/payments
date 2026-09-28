/*
 * decimen 的樣式是寫給「一整個網頁」的（html／body／*／button…），直接載進來會把
 * 本來的 App 全部改掉。這裡把它整份縮進 QR 面板的根節點底下再載入：
 *
 *   *                      → #decimen-app *
 *   html / body / :root    → #decimen-app            （面板本身就是那一頁）
 *   .tool-page .foo        → #decimen-app .foo       （原版寫在 body 上的頁面類別）
 *   body.qr-full .send-shell → body.qr-full #decimen-app .send-shell
 *
 * 最後一條特別重要：全螢幕播 QR 時 decimen 是把 qr-full 掛在真正的 <body> 上
 * （它的程式用 document.body.classList 判斷），所以那一段選擇器必須留著 body，
 * 不能一起換成面板節點，否則全螢幕模式會完全失效。
 *
 * 只有建置時（vite.config.js）與測試會用到，不會進到 App 的 bundle。
 */
import postcss from 'postcss'

export const SCOPE = '#decimen-app'
/* 原版寫在 <body class="…"> 上的頁面類別，等於「面板本身就是那一頁」 */
const PAGE_CLASS = /^\.(?:home-page|tool-page|receiver-page)(?![\w-])/
/* body.qr-full：狀態掛在真正的 body 上，面板只是它的後代 */
const PAGE_STATE = /^body((?:\.[\w-]+)+)/

export function scopeSelector(selector) {
  const s = selector.trim()
  if (!s) return s
  if (s === ':root' || s === 'html' || s === 'body') return SCOPE
  const state = s.match(PAGE_STATE)
  if (state) return `body${state[1]} ${SCOPE}${s.slice(state[0].length)}`
  if (PAGE_CLASS.test(s)) return s.replace(PAGE_CLASS, SCOPE)
  return `${SCOPE} ${s}`
}

/** @media／@supports 要往下遞迴；@keyframes 裡的 0%／100% 不是選擇器，不能動 */
export function scopeCss(css) {
  const root = postcss.parse(css)
  const walk = (container) => {
    container.each((node) => {
      if (node.type === 'atrule') {
        if (node.nodes && !/keyframes$/i.test(node.name)) walk(node)
        return
      }
      if (node.type === 'rule') node.selector = node.selectors.map(scopeSelector).join(', ')
    })
  }
  walk(root)
  return root.toString()
}
