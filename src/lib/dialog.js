/* 對話框統一走 SweetAlert2，樣式與網站一致（純本地套件，離線也能用）。 */
import Swal from 'sweetalert2'

/* 網站主色（style.css 的 --accent 與 --muted） */
const ACCENT = '#2f6f4e'
const MUTED = '#8b9088'

const base = {
  confirmButtonColor: ACCENT,
  cancelButtonColor: MUTED,
  /* 不要讓 SweetAlert2 去改 body 高度：這個 App 是正常捲動的頁面，改了會跳動 */
  heightAuto: false,
  /* 手機上按鈕改成一上一下比較好按 */
  reverseButtons: true,
}

/** 只是一段訊息（沒有選擇） */
export const notify = (title, text = '', icon = 'info') =>
  Swal.fire({ ...base, icon, title, text, confirmButtonText: '知道了' })

/** 警告：例如「這個人物不能刪除」 */
export const warn = (title, text = '') => notify(title, text, 'warning')

/** 問確定／取消，回傳 true 代表使用者按了確定 */
export const askConfirm = ({ title, text = '', confirmText = '確定', icon = 'question' }) =>
  Swal.fire({
    ...base,
    icon,
    title,
    text,
    showCancelButton: true,
    confirmButtonText: confirmText,
    cancelButtonText: '取消',
  }).then((result) => result.isConfirmed === true)

/** 要使用者輸入一段文字，取消回傳 null */
export const askText = ({ title, text = '', value = '', placeholder = '', confirmText = '確定' }) =>
  Swal.fire({
    ...base,
    title,
    text,
    input: 'text',
    inputValue: value,
    inputPlaceholder: placeholder,
    showCancelButton: true,
    confirmButtonText: confirmText,
    cancelButtonText: '取消',
  }).then((result) => (result.isConfirmed ? String(result.value ?? '') : null))

/**
 * 勾選清單（例如重置時選擇要保留什麼）。
 * 回傳 { 選項key: true/false }；使用者按取消回傳 null。
 */
export const askChecklist = async ({ title, options, confirmText = '確定', note = '' }) => {
  const items = (options ?? []).map((option, index) => ({ ...option, id: `swal-check-${index}` }))
  const html =
    `<div class="keep-list">${items
      .map(
        (item) =>
          `<label class="keep-item"><input type="checkbox" id="${item.id}"${
            item.checked ? ' checked' : ''
          } /> ${escapeHtml(item.label)}</label>`,
      )
      .join('')}</div>` + (note ? `<p class="keep-note">${escapeHtml(note)}</p>` : '')

  const result = await Swal.fire({
    ...base,
    title,
    html,
    icon: 'warning',
    showCancelButton: true,
    confirmButtonText: confirmText,
    cancelButtonText: '取消',
    focusConfirm: false,
    preConfirm: () =>
      Object.fromEntries(items.map((item) => [item.key, document.getElementById(item.id)?.checked === true])),
  })
  return result.isConfirmed ? result.value : null
}

const escapeHtml = (text) =>
  String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/**
 * 從一串選項裡挑一個（一行一顆按鈕，按一下就選好）。
 * 直接用 SweetAlert2 的 html 畫按鈕，所以不用自己寫對話框。
 */
export const pickFromList = async ({ title, options, confirmText = '' }) => {
  if (!options?.length) return null

  const html = `<div class="pick-list">${options
    .map((option) => `<button type="button" class="pick-item" data-pick="${escapeHtml(option)}">${escapeHtml(option)}</button>`)
    .join('')}</div>`

  let chosen = null
  await Swal.fire({
    ...base,
    title,
    html,
    showConfirmButton: !!confirmText,
    confirmButtonText: confirmText || undefined,
    showCancelButton: true,
    cancelButtonText: '取消',
    customClass: { popup: 'pick-popup' },
    didOpen: (popup) => {
      popup.querySelectorAll('.pick-item').forEach((el) => {
        el.addEventListener('click', () => {
          chosen = el.dataset.pick
          Swal.close()
        })
      })
    },
  })
  return chosen
}
