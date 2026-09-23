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
