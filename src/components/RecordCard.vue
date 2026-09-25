<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import flatpickr from 'flatpickr'
import 'flatpickr/dist/flatpickr.min.css'
import { Mandarin } from 'flatpickr/dist/l10n/zh.js'
import { fmtDateTime, relativeTime, toAmountText } from '../lib/util.js'

const props = defineProps({
  record: { type: Object, required: true },
  persons: { type: Array, default: () => [] },
  noteCategories: { type: Array, default: () => [] },
  indexLabel: { type: String, default: '' },
  /* 這一筆是不是被點選的那一筆（外框會亮起來） */
  active: { type: Boolean, default: false },
  /* 現在時間（由 App.vue 每半分鐘更新一次，用來算「幾分鐘前」） */
  now: { type: Number, default: 0 },
})
const emit = defineEmits([
  'view',
  'remove',
  'more',
  'retry',
  'skip',
  'rename-source',
  'pick-note',
  'save-note',
  'attach',
  'select',
])

const r = computed(() => props.record)

/* 鎖定：欄位、受益人、重新辨識、補圖全部停用（圖片還是可以放大看） */
const locked = computed(() => !!r.value.locked)

/* 這筆記錄有幾張圖片（主要圖片＋後期補上的），大於 1 時按鈕上會顯示張數 */
const imageTotal = computed(() => (r.value.url ? 1 : 0) + (r.value.extraImages?.length ?? 0))

/*
 * 「這張圖有多個金額，用哪一個？」：鎖定時不顯示；而且只要鎖定過一次，
 * 之後解除也不會再出現（amountChooserOff）。
 */
const showAmountChooser = computed(
  () => (r.value.amounts?.length ?? 0) > 1 && !locked.value && !r.value.amountChooserOff,
)

/* 點卡片任何地方就選取這一筆（點空白處由 App.vue 取消） */
const selectSelf = () => emit('select', props.record)

/*
 * 加入 App 的時間（不是付款時間）：手機版顯示在標題右邊、桌機版顯示在
 * 「圖片」按鈕左邊。點一下會在「多久以前」與完整時間之間切換。
 * 舊資料沒有這個欄位時，退回用圖片的時間。
 */
const stampOpen = ref(false)
const stampMs = computed(() => r.value.createdAt || r.value.fileTime || 0)
const stampFull = computed(() => fmtDateTime(stampMs.value))
const stampText = computed(() =>
  stampOpen.value ? stampFull.value : relativeTime(stampMs.value, props.now || Date.now()),
)

/* 金額只收數字與一個小數點：其他字元一打進來就被去掉 */
function onAmountInput(event) {
  const clean = toAmountText(event.target.value)
  if (event.target.value !== clean) event.target.value = clean
  r.value.amount = clean
}

/* 手動新增的記錄補圖片用 */
const pickEl = ref(null)
function onPickFile(event) {
  const file = event.target.files?.[0]
  event.target.value = ''
  if (file) emit('attach', props.record, file)
}

/*
 * 付款時間：**一個輸入框，兩段式選擇**
 *   1. 點欄位 → 跳 flatpickr 日曆選「日期」
 *   2. 選完日期 → 同一個位置換成瀏覽器原生的「時間」選擇器
 *      （iPhone 上是內建的時／分滾輪，不用按小箭頭，比較好操作）
 * 兩段都選完就合併成 "YYYY-MM-DD HH:mm"，也可以直接打字。
 */
const dateInputEl = ref(null) // 可見的文字欄位（平常顯示完整日期時間）
const timeStepEl = ref(null) // 第二段：原生時間選擇器
const dateAnchorEl = ref(null) // flatpickr 的掛載點（不可見）
const step = ref('idle') // idle | time
let datePicker = null

const pad2 = (n) => String(n).padStart(2, '0')
const todayString = () => {
  const d = new Date()
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

const dateValue = computed(() => String(r.value.paidAtText ?? '').slice(0, 10))
const clockValue = computed(() => {
  const t = String(r.value.paidAtText ?? '').slice(11, 16)
  return /^\d{2}:\d{2}$/.test(t) ? t : ''
})
const paidAtDisplay = computed(() =>
  dateValue.value ? `${dateValue.value}${clockValue.value ? ` ${clockValue.value}` : ''}` : '',
)

function writePaidAt(date, time) {
  r.value.paidAtText = `${date || todayString()} ${time || '00:00'}`
  r.value.paidAtManual = true
}

/* 平常可以直接打字（打 "2026-09-15 18:30" 這種格式） */
function onTypePaidAt(event) {
  r.value.paidAtText = event.target.value
  r.value.paidAtManual = true
}

/* 第一段：按右邊的日曆圖示才會打開（點輸入框只聚焦，方便直接打字） */
function openDateStep() {
  if (locked.value || step.value !== 'idle') return
  datePicker?.open()
}

/* 第二段：日期選好後，換成原生時間選擇器並自動聚焦（使用者剛點過，iOS 會跳滾輪） */
function startTimeStep(date) {
  datePicker?.close()
  writePaidAt(date, clockValue.value || '12:00')
  step.value = 'time'
  nextTick(() => {
    timeStepEl.value?.focus()
    timeStepEl.value?.click?.()
  })
}

/* 調整時間時先記下來就好，要按「完成」（或在手機上收起滾輪）才回到原本的欄位 */
function onTimeChanged(event) {
  writePaidAt(dateValue.value, event.target.value)
}

const finishTimeStep = () => {
  /* 保險：有些瀏覽器 blur 早於 change，這裡再讀一次值寫回去 */
  const value = timeStepEl.value?.value
  if (value) writePaidAt(dateValue.value, value)
  step.value = 'idle'
}

onMounted(() => {
  if (!dateAnchorEl.value) return
  /* 只把合法的日期交給 flatpickr（壞值會讓它丟錯，整張卡片就壞了） */
  const initial = /^\d{4}-\d{2}-\d{2}$/.test(dateValue.value) ? dateValue.value : undefined
  try {
    datePicker = flatpickr(dateAnchorEl.value, {
      dateFormat: 'Y-m-d',
      allowInput: true,
      locale: Mandarin,
      disableMobile: true, // 一律用 flatpickr 的日曆（手機上也一樣）
      showArrow: false, // 置中顯示，箭頭會對不上位置
      /* 置中由 style.css 的全域規則負責（一開始就固定在正中間，
         不會先出現在輸入框下方再跳回中間），這裡也不需要開場動畫 */
      animate: false,
      defaultDate: initial,
      onChange: (_dates, text) => {
        if (text) startTimeStep(text)
      },
    })
  } catch (e) {
    /* 日曆壞掉不該讓整張卡片（甚至整個清單）停止更新 */
    datePicker = null
    console.warn('flatpickr 初始化失敗：', e)
  }
})

onBeforeUnmount(() => {
  datePicker?.destroy()
  datePicker = null
})

/* 辨識完成後程式會自己填時間，這裡要把日曆同步過去 */
watch(dateValue, (next) => {
  if (!datePicker) return
  if (next === datePicker.input.value) return
  datePicker.setDate(next || null, false)
})

const amountText = (a) => `${a.currency || '未標示'} ${a.value}`

function statusText(rec) {
  if (rec.ocrStatus === 'running') return rec.ocrProgress ? `辨識中 ${rec.ocrProgress}%` : '辨識中'
  if (rec.ocrStatus === 'error') return '辨識失敗'
  if (rec.ocrStatus === 'none') return '手動新增'
  if (rec.ocrStatus === 'skipped') return '已跳過辨識'
  if (rec.ocrStatus !== 'done') return '等待辨識'

  const hasAmount = (rec.amounts?.length ?? 0) > 0
  const hasTime = !!rec.paidAtText
  if (hasAmount && hasTime) return '已辨識'
  if (hasAmount) return '只讀到金額'
  if (hasTime) return '只讀到時間'
  return '沒抓到，請手動填'
}

const statusKind = (rec) => {
  if (rec.ocrStatus === 'error') return 'error'
  if (rec.ocrStatus === 'none' || rec.ocrStatus === 'skipped') return 'idle'
  if (rec.ocrStatus !== 'done') return 'idle'
  return (rec.amounts?.length ?? 0) > 0 && rec.paidAtText ? 'done' : 'warn'
}

/* 失敗或已跳過的，可以點標籤重新辨識（鎖定的不行） */
const canRetry = (rec) => !rec.locked && (rec.ocrStatus === 'error' || rec.ocrStatus === 'skipped')

/* 人物清單裡找不到的付錢人／受益人（自動補不回來的那種） */
const payerGone = computed(
  () => !!r.value.payerId && !props.persons.some((p) => p.id === r.value.payerId),
)
const goneBeneficiaries = computed(() =>
  (r.value.beneficiaryIds ?? []).filter((id) => !props.persons.some((p) => p.id === id)).length,
)

const allSelected = computed(
  () =>
    props.persons.length > 0 &&
    props.persons.every((p) => r.value.beneficiaryIds.includes(p.id)),
)

function toggleAllBeneficiaries() {
  r.value.beneficiaryIds = allSelected.value ? [] : props.persons.map((p) => p.id)
}

function chooseAmount(a) {
  r.value.currency = a.currency
  r.value.amount = String(a.value)
  r.value.currencyLocked = true
}

/*
 * 關掉「這張圖有多個金額，用哪一個？」：跟鎖定過一次一樣，這筆之後不會再問
 * （amountChooserOff 會跟著記錄存到本機）。金額就維持目前欄位裡的值。
 */
function dismissAmountChooser() {
  r.value.amountChooserOff = true
}

function toggleBeneficiary(id) {
  const list = r.value.beneficiaryIds
  const at = list.indexOf(id)
  if (at < 0) list.push(id)
  else list.splice(at, 1)
}
</script>

<template>
  <article class="rec" :class="{ on: active, locked }" @click="selectSelf">
    <div class="thumbs">
      <button
        v-if="r.url"
        type="button"
        class="thumb thumb-third thumb-btn"
        title="點圖放大（上方 1/3）"
        :aria-label="`放大檢視 ${r.fileName}（上方 1/3）`"
        :style="{ backgroundImage: `url(${r.url})` }"
        @click="emit('view', r)"
      />
      <button v-if="r.url" type="button" class="thumb-btn" title="點圖放大" @click="emit('view', r)">
        <img class="thumb" :src="r.url" :alt="r.fileName" />
      </button>
      <!-- 沒有圖片時，點這格就能補一張圖上去（鎖定的不行） -->
      <button
        v-else
        type="button"
        class="thumb thumb-empty"
        :disabled="locked"
        :title="locked ? '已鎖定，要補圖片請先解除' : '點一下上傳這筆的圖片'"
        @click="pickEl.click()"
      >
        無圖
      </button>
      <input
        ref="pickEl"
        class="sr-only"
        type="file"
        accept="image/*"
        @change="onPickFile"
      />
    </div>

    <div class="body">
      <div class="top">
        <span class="file" :title="r.fileName">{{ r.fileName }}</span>
        <button
          type="button"
          class="badge"
          :class="[`badge-${statusKind(r)}`, { 'badge-tap': canRetry(r) }]"
          :disabled="!canRetry(r)"
          :title="canRetry(r) ? '點一下重新辨識' : ''"
          @click="canRetry(r) && emit('retry', r)"
        >
          {{ statusText(r) }}
        </button>
        <!-- 鎖定標記：進「更多」才能解除 -->
        <span v-if="locked" class="lock-tag" title="這筆記錄已鎖定，按「更多」可以解除">
          <svg
            viewBox="0 0 24 24"
            width="11"
            height="11"
            fill="none"
            stroke="currentColor"
            stroke-width="2.4"
            stroke-linecap="round"
            aria-hidden="true"
          >
            <rect x="5" y="11" width="14" height="9" rx="2" />
            <path d="M8 11V8a4 4 0 0 1 8 0v3" />
          </svg>
          已鎖定
        </span>
        <!-- 加入 App 的時間：手機版在標題右邊、桌機版在「圖片」左邊 -->
        <span class="spacer" />
        <button
          v-if="stampMs"
          type="button"
          class="stamp"
          :class="{ 'stamp-open': stampOpen }"
          :title="stampOpen ? '點一下收起' : `加入時間：${stampFull}`"
          @click="stampOpen = !stampOpen"
        >
          {{ stampText }}
        </button>
        <!-- 手機版：按鈕一律換到下一行（標題那一行只放標題、標籤與時間） -->
        <span class="top-break" />
        <!-- 辨識中／等待辨識：可以只跳過這一張（要重新辨識就點上面的標籤） -->
        <button
          v-if="r.ocrStatus === 'running' || r.ocrStatus === 'pending'"
          class="btn btn-icon"
          :disabled="locked"
          title="這張不要辨識（圖與其他欄位都留著）"
          @click="emit('skip', r)"
        >
          跳過
        </button>
        <button
          v-if="r.url"
          class="btn btn-icon"
          :title="imageTotal > 1 ? `這筆有 ${imageTotal} 張圖片` : '看圖片'"
          @click="emit('view', r)"
        >
          圖片
          <!-- 多張圖片：加一個「多張」圖示（滑過去看得到有幾張） -->
          <svg
            v-if="imageTotal > 1"
            viewBox="0 0 24 24"
            width="14"
            height="14"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <rect x="9" y="3" width="12" height="12" rx="2" />
            <path d="M15 21H5a2 2 0 0 1-2-2V9" />
          </svg>
        </button>
        <!-- 刪除搬到「更多」裡面（鎖定／解除也在那裡） -->
        <button
          class="btn btn-icon"
          :class="{ 'btn-more-locked': locked }"
          :title="locked ? '已鎖定：可以解除或刪除這筆記錄' : '鎖定、解除或刪除這筆記錄'"
          @click="emit('more', r)"
        >
          更多
        </button>
        <button
          type="button"
          class="seq"
          :title="`來源：${r.source || '本機'}｜點一下可重新命名`"
          @click="emit('rename-source', r)"
        >
          {{ indexLabel }}
        </button>
      </div>

      <div class="grid">
        <label class="field">
          <span class="lbl">付錢人</span>
          <select v-model="r.payerId" class="input" :disabled="locked || !persons.length">
            <option value="">{{ persons.length ? '請選擇' : '請先新增人物' }}</option>
            <!-- 記錄指到的人物已經不在清單裡（補不回來時）：至少要看得出這一筆有問題 -->
            <option v-if="payerGone" :value="r.payerId">⚠ 找不到這位人物，請重新選擇</option>
            <option v-for="p in persons" :key="p.id" :value="p.id">
              {{ p.name }}{{ p.isSelf ? '（自己）' : '' }}
            </option>
          </select>
        </label>

        <label class="field">
          <span class="lbl">付款時間</span>
          <span class="time-slot">
            <input
              v-if="step === 'idle'"
              ref="dateInputEl"
              class="input time-input"
              placeholder="YYYY-MM-DD HH:mm"
              :value="paidAtDisplay"
              :disabled="locked"
              @input="onTypePaidAt"
            />
            <!-- 第二段：同一個位置換成原生時間選擇器（iPhone 是滾輪） -->
            <input
              v-else
              ref="timeStepEl"
              class="input time-input time-input-ok"
              type="time"
              aria-label="選時間"
              :value="clockValue || '12:00'"
              @change="onTimeChanged"
              @input="onTimeChanged"
              @blur="finishTimeStep"
            />
            <!-- 調整完時間要按「完成」才收起（手機上收起滾輪也等於完成） -->
            <button
              v-if="step === 'time'"
              type="button"
              class="time-ok-btn"
              @click="finishTimeStep"
            >
              完成
            </button>
            <!-- 只有按這個日曆按鈕才會打開選擇器（鎖定時不給按） -->
            <button
              v-if="step === 'idle'"
              type="button"
              class="time-pick-btn"
              :disabled="locked"
              title="選日期與時間"
              aria-label="選日期與時間"
              @click="openDateStep"
            >
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                <rect x="3" y="5" width="18" height="16" rx="2" />
                <path d="M3 10h18M8 3v4M16 3v4" />
              </svg>
            </button>
            <!-- flatpickr 的掛載點（看不見，只負責跳日曆） -->
            <input ref="dateAnchorEl" class="sr-only" type="text" tabindex="-1" aria-hidden="true" />
          </span>
        </label>

        <label class="field">
          <span class="lbl">付款多少錢{{ r.currency ? `（${r.currency}）` : '' }}</span>
          <input
            :value="r.amount"
            class="input amount"
            inputmode="decimal"
            placeholder="0.00"
            :disabled="locked"
            @input="onAmountInput"
          />
        </label>

        <div class="field note-field">
          <span class="lbl">備注</span>
          <span class="note-slot">
            <input
              v-model="r.note"
              class="input note-input"
              placeholder="例如：公司聚餐"
              :disabled="locked"
            />
            <!-- 只有按這個圖示才會打開常用分類清單（跟付款時間的日曆按鈕同一個做法） -->
            <button
              type="button"
              class="note-pick-btn"
              :disabled="locked"
              title="從常用分類挑一個"
              aria-label="從常用分類挑一個"
              @click="emit('pick-note', r)"
            >
              <svg
                viewBox="0 0 24 24"
                width="18"
                height="18"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path d="M4 7h16" />
                <path d="M4 12h10" />
                <path d="M4 17h7" />
                <path d="M17.5 15.5l3 3-3 3" />
              </svg>
            </button>
          </span>
        </div>
      </div>

      <div class="field">
        <span class="lbl">受益人（可多選）</span>
        <div v-if="persons.length" class="chips">
          <button
            type="button"
            class="chip chip-all"
            :class="{ on: allSelected }"
            :disabled="locked"
            @click="toggleAllBeneficiaries"
          >
            {{ allSelected ? '取消全選' : '全選' }}
          </button>
          <button
            v-for="p in persons"
            :key="p.id"
            type="button"
            class="chip"
            :class="{ on: r.beneficiaryIds.includes(p.id) }"
            :disabled="locked"
            @click="toggleBeneficiary(p.id)"
          >
            {{ p.name }}
          </button>
        </div>
        <p v-else class="hint">還沒有可選的人物。</p>
        <p v-if="goneBeneficiaries" class="hint">
          有 {{ goneBeneficiaries }} 位受益人已經不在人物清單裡，請重新選擇。
        </p>
      </div>

      <div v-if="showAmountChooser" class="field">
        <span class="lbl">這張圖有多個金額，用哪一個？</span>
        <div class="chips">
          <!-- 關閉：最左邊的小圖示，按了就不再問這筆（金額維持現在的值） -->
          <button
            type="button"
            class="chip-x"
            title="關閉這個選擇（這筆之後不會再問）"
            aria-label="關閉金額選擇"
            @click="dismissAmountChooser"
          >
            <svg
              viewBox="0 0 24 24"
              width="13"
              height="13"
              fill="none"
              stroke="currentColor"
              stroke-width="2.6"
              stroke-linecap="round"
              aria-hidden="true"
            >
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
          <button
            v-for="a in r.amounts"
            :key="`${a.currency}:${a.value}`"
            type="button"
            class="chip"
            :class="{ on: r.currency === a.currency && Number(r.amount) === a.value }"
            @click="chooseAmount(a)"
          >
            {{ amountText(a) }}
          </button>
        </div>
      </div>

      <p v-if="r.ocrError" class="err">{{ r.ocrError }}</p>
    </div>
  </article>
</template>

<style scoped>
.rec {
  display: grid;
  grid-template-columns: 104px 1fr;
  gap: 14px;
  padding: 12px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface);
  box-shadow: var(--shadow-sm);
  transition: border-color 0.16s, box-shadow 0.16s;
}

.seq {
  flex: none;
  padding: 3px 9px;
  border: 1px dashed var(--line-strong);
  border-radius: 999px;
  background: var(--surface-2);
  color: var(--muted);
  font-size: 11px;
  font-weight: 650;
  line-height: 1.4;
  white-space: nowrap;
  cursor: pointer;
}

.seq:hover {
  border-color: var(--accent);
  color: var(--accent);
}

.rec:hover {
  border-color: var(--line-strong);
  box-shadow: var(--shadow);
}

/*
 * 被點到的記錄：外框亮起來（兩層：實線 ＋ 淡淡的光暈），
 * 點畫面空白處或別筆記錄才會換人。放在 :hover 後面才蓋得過 hover。
 * 顏色可以用「設定 → 顏色 → 選取顏色」自己換（--pick，預設＝原本的綠色）。
 */
.rec.on {
  border-color: var(--pick);
  box-shadow: 0 0 0 3px var(--pick-soft), var(--shadow);
}

/*
 * 已鎖定：外框改成玫瑰色（跟「已鎖定」標記同一個顏色），
 * 放在 .rec.on 後面，所以鎖定時玫瑰色優先。
 */
.rec.locked {
  border-color: var(--lock);
}

.rec.locked:hover {
  border-color: var(--lock);
}

.rec.locked.on {
  border-color: var(--lock);
  box-shadow: 0 0 0 3px var(--lock-soft), var(--shadow);
}

/*
 * 鎖定：整張卡片的文字都變灰（檔名、欄位標籤、欄位內容、受益人、加入時間…），
 * 只留「已辨識」那顆狀態標籤與「已鎖定」標記有顏色。
 * 「圖片」「更多」是還按得動的按鈕，所以不變灰。
 */
.rec.locked .file,
.rec.locked .lbl,
.rec.locked .hint,
.rec.locked .input,
.rec.locked .chip,
.rec.locked .thumb-empty,
.rec.locked .stamp {
  color: var(--muted);
}

.rec.locked .lbl,
.rec.locked .stamp {
  opacity: 0.85;
}

/* 選到的受益人原本是綠色，鎖定時一起灰掉 */
.rec.locked .chip.on,
.rec.locked .chip-all {
  border-color: var(--line-strong);
  background: var(--surface-2);
  color: var(--muted);
}

/* 鎖定時欄位是灰的、不能打字，但要看得出內容 */
.rec.locked .input:disabled,
.rec.locked .time-pick-btn:disabled,
.rec.locked .note-pick-btn:disabled {
  color: var(--muted);
  background: var(--surface);
  opacity: 0.75;
}

.rec.locked .time-pick-btn:disabled,
.rec.locked .note-pick-btn:disabled {
  background: transparent;
}

.rec.locked .chip:disabled {
  opacity: 0.6;
  cursor: default;
}

.rec.locked .chip.on:disabled {
  opacity: 1;
}

.lock-tag {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border: 1px solid var(--lock);
  border-radius: 999px;
  background: var(--lock-soft);
  color: var(--lock-dark);
  font-size: 11px;
  font-weight: 650;
  white-space: nowrap;
}

/* 已鎖定的「更多」按鈕給一點提示色，不然看不出這張卡片不能改 */
.btn-more-locked {
  border-color: var(--lock);
  color: var(--lock-dark);
}

.thumb-btn {
  display: block;
  width: 100%;
  padding: 0;
  border: 0;
  background: none;
  cursor: zoom-in;
}

.thumbs {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* 只顯示圖片上方 1/3 的縮圖，手機才有（.thumb.thumb-third 是為了蓋過上面的 .thumb） */
.thumb.thumb-third {
  display: none;
}

.thumb {
  display: block;
  width: 100%;
  aspect-ratio: 3 / 4;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: #eceee9;
  object-fit: cover;
}

.thumb-empty {
  display: grid;
  place-items: center;
  padding: 0;
  border-style: dashed;
  color: var(--muted);
  font-size: 12px;
  cursor: pointer;
}

.thumb-empty:hover {
  border-color: var(--accent);
  color: var(--accent);
}

/* 鎖定時不能補圖：滑過去看得到原因（title），游標也不要騙人 */
.thumb-empty:disabled {
  cursor: default;
  opacity: 0.65;
}

.field-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-height: 32px;
}

.amount {
  font-size: 17px;
  font-weight: 600;
}

.body {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}

.top {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.file {
  min-width: 0;
  overflow: hidden;
  font-weight: 550;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.spacer {
  flex: 1;
}

/* 手機版才會出現的換行點（桌機版不佔位） */
.top-break {
  display: none;
}

/* 加入 App 的時間：小小的、低調的一行字，點一下切換成完整時間 */
.stamp {
  flex: none;
  padding: 2px 0;
  border: 0;
  background: none;
  color: var(--muted);
  font: inherit;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  cursor: pointer;
}

.stamp:hover {
  color: var(--accent);
}

/* 展開成完整時間時給個底線，看得出是按過的狀態 */
.stamp-open {
  color: var(--accent);
  text-decoration: underline dotted;
}

.badge {
  flex: none;
  padding: 2px 8px;
  border: 0;
  border-radius: 999px;
  background: #eef0ec;
  color: var(--muted);
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
  /* 標籤本身是 button（可點的那兩種狀態），這裡把按鈕預設外觀清掉 */
  cursor: default;
  appearance: none;
}

/* 失敗／已跳過：點標籤就重新辨識 */
.badge-tap {
  cursor: pointer;
}

.badge-tap:hover {
  filter: brightness(0.96);
  text-decoration: underline dotted;
}

.badge-done {
  background: var(--accent-soft);
  color: var(--accent);
}

.badge-warn {
  background: var(--warn-soft);
  color: var(--warn);
}

.badge-error {
  background: var(--danger-soft);
  color: var(--danger);
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 10px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.lbl {
  color: var(--muted);
  font-size: 12px;
  font-weight: 550;
}

/* 備注：輸入框（右邊內嵌一個打開常用分類的圖示按鈕），寬度跟其他欄位一樣 */
.note-slot {
  position: relative;
  display: block;
  width: 100%;
}

.note-input {
  width: 100%;
  padding-right: 40px;
}

.note-pick-btn {
  position: absolute;
  top: 50%;
  right: 5px;
  transform: translateY(-50%);
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  padding: 0;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
}

.note-pick-btn:hover {
  background: var(--accent-soft);
  color: var(--accent);
}

/* 付款時間：一個欄位（兩段式選擇，日期→時間）＋右邊的日曆按鈕 */
.time-slot {
  position: relative;
  display: block;
  width: 100%;
}

.time-input {
  width: 100%;
  padding-right: 40px;
  cursor: text;
}

.time-pick-btn {
  position: absolute;
  top: 50%;
  right: 5px;
  transform: translateY(-50%);
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  padding: 0;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
}

/* 第二段的「完成」按鈕：按了才回到原本的欄位 */
.time-input-ok {
  padding-right: 66px;
}

.time-ok-btn {
  position: absolute;
  top: 50%;
  right: 5px;
  transform: translateY(-50%);
  height: 30px;
  padding: 0 10px;
  border: 1px solid var(--line-strong);
  border-radius: 7px;
  background: var(--surface);
  color: var(--accent);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}

.time-ok-btn:hover {
  background: var(--accent-soft);
}

.time-pick-btn:hover {
  background: var(--accent-soft);
  color: var(--accent);
}

/* 日曆置中顯示時，背景加一層薄薄的遮罩讓它更好點 */
.flatpickr-calendar {
  z-index: 60;
  box-shadow: 0 12px 40px -8px rgba(26, 30, 24, 0.3);
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.chip {
  min-height: 32px;
  padding: 0 11px;
  border: 1px solid var(--line-strong);
  border-radius: 999px;
  background: var(--surface);
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  cursor: pointer;
}

/* 「多個金額」那一排最左邊的關閉鈕：不用搶眼的小圓形圖示 */
.chip-x {
  flex: none;
  align-self: center;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: 1px solid var(--line-strong);
  border-radius: 50%;
  background: var(--surface);
  color: var(--muted);
  cursor: pointer;
  transition: border-color 0.14s, color 0.14s;
}

.chip-x:hover {
  border-color: var(--danger);
  color: var(--danger);
}

.chip.on {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent);
  font-weight: 600;
}

/* 「全選」是動作不是人名，用霧玫瑰色跟人物選項區分 */
.chip-all {
  border-style: dashed;
  border-color: var(--rose-line);
  background: var(--surface);
  color: var(--rose);
  font-weight: 650;
}

.chip-all:hover {
  border-color: var(--rose);
  background: var(--rose-soft);
}

.chip-all.on {
  border-style: solid;
  border-color: var(--rose);
  background: var(--rose-soft);
  color: var(--rose);
}

@media (max-width: 560px) {
  .rec {
    grid-template-columns: 68px 1fr;
    gap: 10px;
    /* 縮圖垂直置中 */
    align-items: center;
  }

  /*
   * 手機上卡片內文只有 200 多 px，備注的圖示按鈕內嵌在輸入框裡，
   * 不會再擠壓輸入框的寬度。
   */
  .note-input {
    font-size: 16px;
  }

  /* iOS 對字級小於 16px 的輸入框會在對焦時把整頁放大 */
  .time-input {
    font-size: 16px;
  }

  /* 手機截圖是 9:19 左右的長條，用 contain 才不會被裁掉一大塊 */
  .thumb {
    aspect-ratio: 9 / 19;
    object-fit: contain;
  }

  /* 上方 1/3 的縮圖：跟完整縮圖一樣大，內容只取圖片上方 1/3（等於放大 3 倍） */
  .thumb.thumb-third {
    display: block;
    aspect-ratio: 9 / 19;
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    background-color: #eceee9;
    background-repeat: no-repeat;
    background-position: top center;
    background-size: auto 300%;
  }

  .seq {
    font-size: 10px;
  }

  .top {
    flex-wrap: wrap;
  }

  /*
   * 標題那一行：標題、標籤、加入時間；按鈕一律換到下一行。
   * 標題用 flex-basis 0：長檔名才不會把「標籤」與「加入時間」擠到下一行
   * （換行是用每個項目的內容寬度判斷的，不先給 0 的話長檔名一定換行）。
   * 手機版不需要中間那段彈性空白，標題自己會把後面兩個推到右邊。
   */
  .file {
    flex: 1 1 0;
  }

  .top .spacer {
    display: none;
  }

  /* 手指比較大：時間的文字點擊範圍加大一點 */
  .stamp {
    padding: 6px 2px;
  }

  .top-break {
    display: block;
    flex: 1 0 100%;
    height: 0;
  }

  /* 手機版：標題那一行的按鈕（跳過／圖片／刪除／序號）平均分攤寬度 */
  .top .btn {
    flex: 1 1 auto;
  }
}
</style>
