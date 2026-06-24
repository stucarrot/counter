/* =========================================================
   STORAGE SCHEMA
   pc_days        : { "2026-06-17": { blocks:[...], watchBlocks:[...] }, ... }
     block (할일): { id, name, desc, type, time, customTime, progressType,
       total?, current?, done?, carryover, carryoverId?, sessions? }
     watchBlock (감상): { id, name, author, type(book/movie/etc), progress(0~100),
       archived: bool, watchChainId: string, memos: [{id,text,time}] }
   pc_weights     : { schedule, todo, once, leisure, routine, focus, watch, unspecified, focusGoalMinutes }
     (이름은 "weights"지만 실제로는 블록 타입별 "절댓값 점수"다. 가중평균이 아니라
      블록별 점수를 그냥 다 더하는 방식 — 하루 총점은 100점 캡이 없는 무제한 누적.
      완료된 블록은 절댓값 전체, 카운터형은 (진행 비율 × 절댓값)의 부분 점수를 준다.
      집중시간/감상도 동일하게 절댓값 적용: 집중시간은 목표 달성 비율 × 절댓값,
      감상은 그날 진행도 변화분 비율 × 절댓값.)
   pc_carryover_meta  : { <carryoverId>: { stopped: bool } }   // 할일 이행/루틴 체인
   pc_watch_chain_meta: { <watchChainId>: { stopped: bool } }  // 감상 이월 체인
   pc_memos       : { "2026-06-17": [{id, text, time}], ... }  // 메모 탭
   pc_active_timer: { dateKey, blockId, startedAt(ISOString), accumulatedMs, paused: bool } | null
   pc_plan_blocks : [ planBlock, ... ]   // 계획 탭 — 날짜에 속하지 않는 전역 목록
     planBlock: { id, name, desc, type, progressType, total?, current?, done?,
       timeUnspecified: bool, dateStart?, dateEnd?, timeStart?, timeEnd?, order }
   pc_period_plans: [ periodPlan, ... ]  // 기간계획 블록
     periodPlan: { id, mode(month/week/range), dateStart, dateEnd, desc,
       refs: [{ kind: 'plan'|'todo', id, dateKey? }], order }
     (todo 참조는 특정 날짜의 할일 블록이라 dateKey가 필요하고, plan 참조는 전역
      목록이라 dateKey가 필요 없다.)
   pc_game_points : number  // 게임 탭 누적 포인트 (매일 종합점수 단순 합산)
   pc_game_added_scores: { "2026-06-16": 59, ... }  // 날짜별로 포인트에 "이미 합산한 점수"
     기록. 과거 날짜의 할일/감상 데이터를 수정해서 그날 점수가 바뀌면, 여기 기록된
     값과 새로 계산한 값의 차이만큼 gamePoints를 보정하고 이 기록도 갱신한다.
     (오늘 날짜는 아직 "마감"되지 않았으므로 여기 기록되지 않고, 오전 4시 컷오프를
     지나야 비로소 합산 대상이 된다.)

   유형 "루틴"은 carryover가 항상 true로 강제된다 (기본은 매일 자동 반복, 진행도 리셋).
   루틴은 intervalDays(기본 1)로 "매 n일마다" 반복 주기를 가질 수 있다 — 체인이
   시작된 날(routineAnchorKey)을 기준으로 n일 간격에 해당하는 날에만 오늘 목록에
   자동으로 나타나고, 그 사이 날에는 나타나지 않는다(히트맵에는 빈 칸으로 표시).
   다른 유형은 "이행" 체크박스로 carryover를 켤 수 있다 — 완료 전까지 진행도를
   그대로 들고 다음 날로 이어지고, 완료되면 체인이 멈춘다.

   감상 블록은 progress가 100이 아니고 "보관"이 체크되지 않으면 매일 다음 날로
   이월된다 (이전 날 블록은 삭제되지 않고 그대로 남되, 새 날의 카드에는 그날
   변화한 진행도 %p가 함께 표시된다). progress가 100이 되면 그 날에 고정되어
   더 이상 이월되지 않는다.
   "예정"(planned: bool)이 체크된 감상 블록은 아직 시작 전이라는 의미로 목록
   맨 아래에 희미하게 표시된다. "보관"이 체크된 블록도 마찬가지로 희미하게
   표시된다 (둘 다 정렬 순서상 완료/보관/예정이 일반 항목보다 뒤로 간다).

   "오늘"의 기준은 자정이 아니라 오전 4시.
   ========================================================= */

const DAY_CUTOFF_HOUR = 4;
const HEATMAP_DAYS = 5;

let days = JSON.parse(localStorage.getItem('pc_days') || '{}');
let weights = JSON.parse(localStorage.getItem('pc_weights') || 'null') || { schedule: 10, todo: 8, once: 6, leisure: 5, routine: 8, focus: 6, watch: 3 };
let carryoverMeta = JSON.parse(localStorage.getItem('pc_carryover_meta') || '{}');
let watchChainMeta = JSON.parse(localStorage.getItem('pc_watch_chain_meta') || '{}');
let memos = JSON.parse(localStorage.getItem('pc_memos') || '{}');
let activeTimer = JSON.parse(localStorage.getItem('pc_active_timer') || 'null');
// 절제(abstain) 블록 전용 시간재기 — 보조 집중타이머(activeTimer)와는 완전히 별개라
// 동시에 둘 다 돌릴 수 있다. 일시정지 없이 단순 시작/정지만 지원 (카드에서 원클릭 조작).
let activeAbstainTimers = JSON.parse(localStorage.getItem('pc_active_abstain_timers') || '{}'); // { [blockId]: { dateKey, startedAt } }
let gamePoints = parseFloat(localStorage.getItem('pc_game_points') || '0');
let gameAddedScores = JSON.parse(localStorage.getItem('pc_game_added_scores') || '{}');
let gameSpendLog = JSON.parse(localStorage.getItem('pc_game_spend_log') || '[]');
let planBlocks = JSON.parse(localStorage.getItem('pc_plan_blocks') || '[]');
let periodPlans = JSON.parse(localStorage.getItem('pc_period_plans') || '[]');
let themePref = localStorage.getItem('pc_theme_pref') || 'system'; // 'system' | 'light' | 'dark'
// 감상 탭의 날짜-무관 아카이브들 — '종료'와 '예정'은 오늘 원본 블록이 그 상태가 되면
// 복사본이 생성되고, 그날 동안은 원본 변경이 실시간으로 같이 반영된다(linkedWatchId로 연결).
// 자정이 지나면(원본이 다음날로 넘어가거나 사라지면) 연결이 끊기고 독립된 데이터로 남는다.
let watchArchiveItems = JSON.parse(localStorage.getItem('pc_watch_archive_items') || '[]'); // 종료
let watchPlannedItems = JSON.parse(localStorage.getItem('pc_watch_planned_items') || '[]'); // 예정
// '목록'은 날짜와 완전히 무관한, 기간계획과 같은 방식으로 다른 감상 블록들을 참조하는 묶음 카드
let watchLists = JSON.parse(localStorage.getItem('pc_watch_lists') || '[]');

let editBlockId = null;
let deleteBlockId = null;
let postponeBlockId = null;
let deferredPrompt = null;
let reordering = false;
let currentTab = 'todo';
let timerBlockId = null; // 타이머 시트가 현재 가리키는 블록
let timerTickHandle = null;
let viewingMemoDateKey;
let viewingWatchDateKey;
let editWatchId = null;
let editWatchArchiveKind = null; // null(오늘 원본) | 'archive' | 'planned' — openWatchArchiveEdit으로 들어왔을 때 어느 저장소를 고칠지
let progressEditWatchId = null;
let watchMemoTargetId = null;
let watchMemoTargetKind = null; // null(오늘 원본) | 'archive' | 'planned'
let selectedWatchType = null;
let editPlanId = null;
let deletePlanId = null;
let selectedPlanType = null, selectedPlanTimeMode = null, selectedPlanProgress = null;
let currentPlanSubtab = 'time';
let currentWatchSubtab = 'ongoing'; // 'ongoing' | 'planned' | 'archive' | 'list'
let editWatchListId = null;
let deleteWatchListId = null;
let pendingWatchListRefs = []; // 감상 목록 폼 작성 중 임시로 들고 있는 참조 목록
let editPeriodId = null;
let selectedPeriodMode = null;
let pendingPeriodRefs = []; // 기간계획 폼 작성 중 임시로 들고 있는 참조 목록
let importPlanId = null;
// 드래그 재정렬 진행 중 상태 (한 번에 하나의 드래그만 가능)
let dragReorderState = null;

function appNow() {
  // 오전 4시를 하루의 시작으로 보는 "가상 현재 시각"
  const d = new Date();
  return new Date(d.getTime() - DAY_CUTOFF_HOUR * 60 * 60 * 1000);
}
const TODAY_KEY = () => formatKey(appNow());
let viewingDateKey = TODAY_KEY();
viewingMemoDateKey = TODAY_KEY();
viewingWatchDateKey = TODAY_KEY();

const TYPE_LABEL = { schedule: '일정', once: '일회성', todo: '할일', leisure: '여가', routine: '루틴', unspecified: '미지정', abstain: '절제' };
const TIME_LABEL = { morning: '오전', afternoon: '오후', night: '밤' };
const WATCH_TYPE_LABEL = { book: '독서', movie: '영화', etc: '기타' };

/* ---------- persistence helpers ---------- */
function saveDays() {
  localStorage.setItem('pc_days', JSON.stringify(days));
  reconcileGamePoints();
  if (currentTab === 'game') renderGamePoints();
}
function saveWeightsToStorage() { localStorage.setItem('pc_weights', JSON.stringify(weights)); }
function saveCarryoverMeta() { localStorage.setItem('pc_carryover_meta', JSON.stringify(carryoverMeta)); }
function saveWatchChainMeta() { localStorage.setItem('pc_watch_chain_meta', JSON.stringify(watchChainMeta)); }
function saveMemos() { localStorage.setItem('pc_memos', JSON.stringify(memos)); }
function savePlanBlocks() { localStorage.setItem('pc_plan_blocks', JSON.stringify(planBlocks)); }
function savePeriodPlans() { localStorage.setItem('pc_period_plans', JSON.stringify(periodPlans)); }
function saveWatchArchiveItems() { localStorage.setItem('pc_watch_archive_items', JSON.stringify(watchArchiveItems)); }
function saveWatchPlannedItems() { localStorage.setItem('pc_watch_planned_items', JSON.stringify(watchPlannedItems)); }
function saveWatchLists() { localStorage.setItem('pc_watch_lists', JSON.stringify(watchLists)); }
function saveActiveTimer() {
  if (activeTimer) localStorage.setItem('pc_active_timer', JSON.stringify(activeTimer));
  else localStorage.removeItem('pc_active_timer');
}
function saveActiveAbstainTimers() {
  localStorage.setItem('pc_active_abstain_timers', JSON.stringify(activeAbstainTimers));
}
function saveGamePoints() {
  localStorage.setItem('pc_game_points', String(gamePoints));
  localStorage.setItem('pc_game_added_scores', JSON.stringify(gameAddedScores));
  localStorage.setItem('pc_game_spend_log', JSON.stringify(gameSpendLog));
}

function formatKey(d) {
  const y = d.getFullYear(), m = String(d.getMonth()+1).padStart(2,'0'), day = String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
}
function keyToDate(k) { const [y,m,d] = k.split('-').map(Number); return new Date(y, m-1, d); }
function addDaysToKey(key, delta) {
  const d = keyToDate(key);
  d.setDate(d.getDate() + delta);
  return formatKey(d);
}

function ensureDay(key) {
  if (!days[key]) days[key] = { blocks: [], watchBlocks: [] };
  if (!days[key].watchBlocks) days[key].watchBlocks = [];
  return days[key];
}

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// URL 패턴 (http(s):// 또는 www.로 시작) — 문장 끝의 마침표/쉼표/괄호는 링크에서 제외
const URL_PATTERN = /(https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"]|www\.[^\s<]+[^\s<.,;:!?)\]'"])/gi;

// 표시용으로 너무 긴 링크를 줄여서 보여준다. href는 항상 원본 그대로 유지.
function shortenUrlForDisplay(url, maxLen) {
  if (url.length <= maxLen) return url;
  const withoutProtocol = url.replace(/^https?:\/\//i, '');
  if (withoutProtocol.length <= maxLen) return withoutProtocol;
  const head = withoutProtocol.slice(0, Math.max(8, Math.floor(maxLen * 0.6)));
  const tail = withoutProtocol.slice(-Math.max(4, Math.floor(maxLen * 0.25)));
  return `${head}…${tail}`;
}

// 블록 설명/메모 등 사용자가 입력한 텍스트를 안전하게 표시하면서, 그 안의 URL은
// 클릭 가능한 링크로 바꿔준다. esc()와 마찬가지로 항상 이 함수를 거쳐야 하며,
// 이스케이프와 링크화를 동시에 처리하므로 escLinkify(text) 결과에 추가로 esc()를 또 적용하면 안 된다.
function escLinkify(s, maxDisplayLen) {
  const text = String(s);
  let result = '';
  let lastIndex = 0;
  let m;
  URL_PATTERN.lastIndex = 0;
  while ((m = URL_PATTERN.exec(text)) !== null) {
    result += esc(text.slice(lastIndex, m.index));
    const rawUrl = m[0];
    const href = /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;
    const display = maxDisplayLen ? shortenUrlForDisplay(rawUrl, maxDisplayLen) : rawUrl;
    result += `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer" class="auto-link" onclick="event.stopPropagation()">${esc(display)}</a>`;
    lastIndex = m.index + rawUrl.length;
  }
  result += esc(text.slice(lastIndex));
  return result;
}

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), 2200);
}

/* =========================================================
   TAB SWITCHING
   ========================================================= */
// 순서변경(드래그/화살표) 버튼은 실제로 정렬할 수 있는 화면에서만 보인다.
// '감상' 탭 안에서도 서브탭에 따라 다르다: 감상/예정/목록은 정렬 가능, 종료는 날짜순 자동 정렬이라 불가능.
function updateReorderButtonVisibility() {
  const showReorder = currentTab === 'todo' || currentTab === 'plan'
    || (currentTab === 'watch' && currentWatchSubtab !== 'archive');
  document.getElementById('reorderToggle').classList.toggle('reorder-toggle-hidden', !showReorder);
  if (reordering && !showReorder) toggleReorder();
}

function switchTab(tab) {
  checkMidnightRollover(); // 탭을 바꿔서 볼 때마다 날짜가 넘어가 있었는지 한 번 더 확인 (이월 누락 방지)
  currentTab = tab;
  ['plan','todo','watch','memo','game'].forEach(t => {
    document.getElementById(`tabBtn-${t}`).classList.toggle('active', tab === t);
    document.getElementById(`page-${t}`).classList.toggle('hidden', tab !== t);
  });
  updateReorderButtonVisibility();
  if (tab === 'memo') {
    renderMemoHeader();
    renderMemos();
  } else if (tab === 'watch') {
    renderWatchHeader();
    renderWatchBlocks();
  } else if (tab === 'game') {
    renderGamePoints();
  } else if (tab === 'plan') {
    renderPlanList();
  }
}

/* =========================================================
   REORDER MODE
   ========================================================= */
function toggleReorder() {
  reordering = !reordering;
  document.body.classList.toggle('reordering', reordering);
  document.getElementById('reorderToggle').setAttribute('aria-pressed', reordering ? 'true' : 'false');
  if (currentTab === 'watch') renderWatchBlocks();
  else if (currentTab === 'plan') renderPlanList();
  else renderBlocks();
}

/* =========================================================
   GENERIC OVERLAY HELPERS
   ========================================================= */
function closeOverlay(id) { document.getElementById(id).classList.remove('open'); }
function overlayClose(e, id) { if (e.target === document.getElementById(id)) closeOverlay(id); }

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    ['blockFormOverlay','confirmOverlay','menuOverlay','timerOverlay','feedbackOverlay','watchFormOverlay','watchProgressOverlay','watchMemoOverlay','planFormOverlay','periodFormOverlay','refPickerOverlay','importPopupOverlay','spendOverlay'].forEach(closeOverlay);
  }
});

/* =========================================================
   DATE NAVIGATION
   ========================================================= */
function changeDay(delta) {
  const d = keyToDate(viewingDateKey);
  d.setDate(d.getDate() + delta);
  viewingDateKey = formatKey(d);
  renderDayHeader();
  renderBlocks();
  renderScore();
}

function jumpToday() {
  viewingDateKey = TODAY_KEY();
  renderDayHeader();
  renderBlocks();
  renderScore();
}

function renderDayHeader() {
  const today = TODAY_KEY();
  const d = keyToDate(viewingDateKey);
  const isToday = viewingDateKey === today;
  const weekday = ['일','월','화','수','목','금','토'][d.getDay()];
  document.getElementById('dayLabel').textContent = isToday ? '오늘' : `${d.getMonth()+1}월 ${d.getDate()}일 (${weekday})`;
  document.getElementById('dayDate').textContent = isToday ? `${d.getMonth()+1}월 ${d.getDate()}일 (${weekday})` : '';
  document.getElementById('todayJumpBtn').classList.toggle('hidden', isToday);
}

/* =========================================================
   BLOCK FORM
   ========================================================= */
let selectedType = null, selectedTime = null, selectedProgress = null;

function selectSeg(groupId, btn) {
  const group = document.getElementById(groupId);
  group.querySelectorAll('.seg-btn').forEach(b => b.classList.remove('selected'));
  btn.classList.add('selected');
  if (groupId === 'bfTypeGroup') { selectedType = btn.dataset.val; onTypeChanged(); }
  if (groupId === 'bfTimeGroup') selectedTime = btn.dataset.val;
  if (groupId === 'bfProgressGroup') selectedProgress = btn.dataset.val;
  if (groupId === 'wfTypeGroup') selectedWatchType = btn.dataset.val;
  if (groupId === 'pfTypeGroup') selectedPlanType = btn.dataset.val;
  if (groupId === 'pfTimeModeGroup') selectedPlanTimeMode = btn.dataset.val;
  if (groupId === 'pfProgressGroup') selectedPlanProgress = btn.dataset.val;
  if (groupId === 'ppModeGroup') selectedPeriodMode = btn.dataset.val;
}

function onTypeChanged() {
  const carryoverField = document.getElementById('bfCarryoverField');
  const checkbox = document.getElementById('bfCarryover');
  const intervalField = document.getElementById('bfIntervalField');
  if (selectedType === 'routine') {
    // 루틴은 항상 이행(carryover) — 체크박스를 숨기고 강제로 켠 상태로 취급
    carryoverField.classList.add('hidden');
    checkbox.checked = true;
    intervalField.classList.remove('hidden');
  } else if (selectedType === 'abstain') {
    // 절제는 "이행"이 아니라 매일 자동으로 새로 시작 — 체크박스 자체가 의미 없어 숨김
    carryoverField.classList.add('hidden');
    checkbox.checked = false;
    intervalField.classList.add('hidden');
  } else {
    carryoverField.classList.remove('hidden');
    intervalField.classList.add('hidden');
  }

  const timerBtn = document.getElementById('bfProgressTimerBtn');
  const toggleBtn = document.querySelector('#bfProgressGroup .seg-btn[data-val="toggle"]');
  const noneBtn = document.querySelector('#bfProgressGroup .seg-btn[data-val="none"]');
  const totalLabel = document.getElementById('bfTotalLabel');
  if (selectedType === 'abstain') {
    // 절제는 "카운터(상한)" 또는 "시간재기(상한)"만 가능 — 완료토글/없음은 의미가 없어 숨김
    timerBtn.classList.remove('hidden');
    toggleBtn.classList.add('hidden');
    noneBtn.classList.add('hidden');
    totalLabel.textContent = '상한 수';
    if (selectedProgress === 'toggle' || selectedProgress === 'none' || !selectedProgress) {
      selectedProgress = 'counter';
      document.querySelectorAll('#bfProgressGroup .seg-btn').forEach(b => b.classList.toggle('selected', b.dataset.val === 'counter'));
    }
  } else {
    timerBtn.classList.add('hidden');
    toggleBtn.classList.remove('hidden');
    noneBtn.classList.remove('hidden');
    totalLabel.textContent = '목표 수';
    if (selectedProgress === 'timer') {
      selectedProgress = null;
      document.querySelectorAll('#bfProgressGroup .seg-btn').forEach(b => b.classList.remove('selected'));
    }
  }
  toggleCounterFields();
}

function toggleCustomTime() {
  document.getElementById('bfCustomTime').classList.toggle('hidden', selectedTime !== 'custom');
}

function toggleSplitFields() {
  const isSplit = selectedTime === 'split';
  document.getElementById('bfSplitFields').classList.toggle('hidden', !isSplit);
  if (isSplit) {
    // 쪼개기는 카운터 강제, bfCounterFields(일반 목표수 입력)는 숨김
    selectedProgress = 'counter';
    document.querySelectorAll('#bfProgressGroup .seg-btn').forEach(btn => {
      btn.classList.toggle('selected', btn.dataset.val === 'counter');
      btn.disabled = btn.dataset.val !== 'counter';
    });
    document.getElementById('bfCounterFields').classList.add('hidden');
  } else {
    document.querySelectorAll('#bfProgressGroup .seg-btn').forEach(btn => { btn.disabled = false; });
    // 카운터가 선택돼 있었다면 일반 카운터 필드 다시 표시
    if (selectedProgress === 'counter') document.getElementById('bfCounterFields').classList.remove('hidden');
  }
}

let splitDates = []; // [{ date: 'YYYY-MM-DD', count: number }]

function addSplitDate() {
  splitDates.push({ date: '', count: 0 });
  renderSplitDateRows();
}

function removeSplitDate(idx) {
  splitDates.splice(idx, 1);
  renderSplitDateRows();
}

function updateSplitDate(idx, field, value) {
  if (splitDates[idx]) splitDates[idx][field] = field === 'count' ? (parseInt(value)||0) : value;
}

function renderSplitDateRows() {
  const el = document.getElementById('bfSplitDates');
  if (!splitDates.length) { el.innerHTML = ''; return; }
  el.innerHTML = splitDates.map((sd, i) => `
    <div class="split-date-row">
      <input type="date" class="split-date-input" value="${sd.date}" onchange="updateSplitDate(${i},'date',this.value)">
      <input type="number" class="split-count-input" placeholder="수" min="0" value="${sd.count||''}" inputmode="numeric" onchange="updateSplitDate(${i},'count',this.value)">
      <button class="ref-item-remove" onclick="removeSplitDate(${i})"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
    </div>`).join('');
}

function toggleCounterFields() {
  document.getElementById('bfCounterFields').classList.toggle('hidden', selectedProgress !== 'counter');
  document.getElementById('bfTimerLimitFields').classList.toggle('hidden', selectedProgress !== 'timer');
}

function resetTypeSegDisabled() {
  document.querySelectorAll('#bfTypeGroup .seg-btn').forEach(b => { b.disabled = false; });
}

function openBlockAdd() {
  editBlockId = null;
  document.getElementById('blockSheetTitle').textContent = '블록 추가';
  document.getElementById('bfName').value = '';
  document.getElementById('bfDesc').value = '';
  document.getElementById('bfTotal').value = '';
  document.getElementById('bfCurrent').value = '0';
  document.getElementById('bfTotalLabel').textContent = '목표 수';
  document.getElementById('bfTimerLimitMinutes').value = '';
  document.getElementById('bfCustomTime').value = '';
  document.getElementById('bfCustomTime').classList.add('hidden');
  document.getElementById('bfCounterFields').classList.add('hidden');
  document.getElementById('bfTimerLimitFields').classList.add('hidden');
  document.getElementById('bfSplitFields').classList.add('hidden');
  document.getElementById('bfCarryover').checked = false;
  document.getElementById('bfCarryoverField').classList.remove('hidden');
  document.getElementById('bfIntervalDays').value = '1';
  document.getElementById('bfIntervalField').classList.add('hidden');
  document.getElementById('bfProgressTimerBtn').classList.add('hidden');
  document.querySelector('#bfProgressGroup .seg-btn[data-val="toggle"]').classList.remove('hidden');
  document.querySelector('#bfProgressGroup .seg-btn[data-val="none"]').classList.remove('hidden');
  selectedType = null; selectedTime = 'none'; selectedProgress = null;
  splitDates = [];
  renderSplitDateRows();
  document.querySelectorAll('#bfTypeGroup .seg-btn, #bfTimeGroup .seg-btn, #bfProgressGroup .seg-btn').forEach(b => b.classList.remove('selected'));
  const noneTimeBtn = document.querySelector('#bfTimeGroup .seg-btn[data-val="none"]');
  if (noneTimeBtn) noneTimeBtn.classList.add('selected');
  resetTypeSegDisabled();
  document.getElementById('blockFormOverlay').classList.add('open');
  setTimeout(() => document.getElementById('bfName').focus(), 80);
}

function openBlockEdit(id) {
  const day = ensureDay(viewingDateKey);
  const b = day.blocks.find(x => x.id === id);
  if (!b) return;
  editBlockId = id;
  document.getElementById('blockSheetTitle').textContent = '블록 수정';
  document.getElementById('bfName').value = b.name;
  document.getElementById('bfDesc').value = b.desc || '';
  selectedType = b.type; selectedTime = b.time || 'none'; selectedProgress = b.progressType;

  document.querySelectorAll('#bfTypeGroup .seg-btn').forEach(btn => {
    btn.classList.toggle('selected', btn.dataset.val === b.type);
    // 루틴 블록은 다른 유형으로 전환 불가 (이행 체인 추적이 깨지는 걸 방지)
    btn.disabled = b.type === 'routine' && btn.dataset.val !== 'routine';
  });
  document.querySelectorAll('#bfTimeGroup .seg-btn').forEach(btn => btn.classList.toggle('selected', btn.dataset.val === (b.time || 'none')));
  document.querySelectorAll('#bfProgressGroup .seg-btn').forEach(btn => btn.classList.toggle('selected', btn.dataset.val === b.progressType));

  const timerBtn = document.getElementById('bfProgressTimerBtn');
  const toggleBtn = document.querySelector('#bfProgressGroup .seg-btn[data-val="toggle"]');
  const noneBtn = document.querySelector('#bfProgressGroup .seg-btn[data-val="none"]');
  const totalLabel = document.getElementById('bfTotalLabel');
  if (b.type === 'abstain') {
    timerBtn.classList.remove('hidden');
    toggleBtn.classList.add('hidden');
    noneBtn.classList.add('hidden');
    totalLabel.textContent = '상한 수';
  } else {
    timerBtn.classList.add('hidden');
    toggleBtn.classList.remove('hidden');
    noneBtn.classList.remove('hidden');
    totalLabel.textContent = '목표 수';
  }

  const customTimeInput = document.getElementById('bfCustomTime');
  if (b.time === 'custom') { customTimeInput.classList.remove('hidden'); customTimeInput.value = b.customTime || ''; }
  else customTimeInput.classList.add('hidden');

  // 쪼개기 필드 초기화
  splitDates = (b.splitDates || []).map(sd => ({ ...sd }));
  const isSplit = b.time === 'split';
  document.getElementById('bfSplitFields').classList.toggle('hidden', !isSplit);
  if (isSplit) {
    document.querySelectorAll('#bfProgressGroup .seg-btn').forEach(btn => { btn.disabled = btn.dataset.val !== 'counter'; });
    document.getElementById('bfSplitTotal').value = b.total || '';
  } else {
    document.querySelectorAll('#bfProgressGroup .seg-btn').forEach(btn => { btn.disabled = false; });
  }
  renderSplitDateRows();

  document.getElementById('bfTimerLimitFields').classList.toggle('hidden', b.progressType !== 'timer');
  if (b.progressType === 'timer') {
    document.getElementById('bfTimerLimitMinutes').value = b.limitMinutes || '';
  }

  if (b.progressType === 'counter') {
    if (isSplit) {
      document.getElementById('bfCounterFields').classList.add('hidden');
      document.getElementById('bfSplitTotal').value = b.total || '';
    } else {
      document.getElementById('bfCounterFields').classList.remove('hidden');
      document.getElementById('bfTotal').value = b.total || '';
      document.getElementById('bfCurrent').value = b.current || 0;
    }
  } else {
    document.getElementById('bfCounterFields').classList.add('hidden');
  }

  document.getElementById('bfCarryover').checked = !!b.carryover;
  if (b.type === 'routine') {
    document.getElementById('bfCarryoverField').classList.add('hidden');
    document.getElementById('bfIntervalField').classList.remove('hidden');
    document.getElementById('bfIntervalDays').value = b.intervalDays || 1;
  } else if (b.type === 'abstain') {
    document.getElementById('bfCarryoverField').classList.add('hidden');
    document.getElementById('bfIntervalField').classList.add('hidden');
  } else {
    document.getElementById('bfCarryoverField').classList.remove('hidden');
    document.getElementById('bfIntervalField').classList.add('hidden');
  }

  document.getElementById('blockFormOverlay').classList.add('open');
  setTimeout(() => document.getElementById('bfName').focus(), 80);
}

function submitBlockForm() {
  const name = document.getElementById('bfName').value.trim();
  const desc = document.getElementById('bfDesc').value.trim();
  if (!name) { document.getElementById('bfName').focus(); return; }
  if (!selectedType) { showToast('유형을 선택해주세요'); return; }
  if (!selectedProgress) { showToast('진행 체크 방식을 선택해주세요'); return; }
  // 시간대는 선택 사항 — selectedTime이 null이어도 통과

  const customTime = selectedTime === 'custom' ? document.getElementById('bfCustomTime').value : '';
  let total = null, current = null, limitMinutes = null;
  if (selectedProgress === 'counter') {
    total = selectedTime === 'split'
      ? (parseInt(document.getElementById('bfSplitTotal').value) || 0)
      : parseInt(document.getElementById('bfTotal').value);
    current = parseInt(document.getElementById('bfCurrent').value) || 0;
    if (!total || total < 1) {
      if (selectedTime === 'split') document.getElementById('bfSplitTotal').focus();
      else document.getElementById('bfTotal').focus();
      return;
    }
    current = Math.max(0, current);
  } else if (selectedProgress === 'timer') {
    limitMinutes = parseInt(document.getElementById('bfTimerLimitMinutes').value);
    if (!limitMinutes || limitMinutes < 1) {
      document.getElementById('bfTimerLimitMinutes').focus();
      return;
    }
  }

  const isSplit = selectedTime === 'split';
  const savedSplitDates = isSplit ? splitDates.filter(sd => sd.date).map(sd => ({ ...sd })) : [];

  const isRoutineType = selectedType === 'routine';
  const isAbstainType = selectedType === 'abstain';
  // 절제는 "이행"이 아니라 매일 새로 시작하는 자동 반복 — 루틴과 같은 carryover 체인 메커니즘을
  // 그대로 쓰지만, 의미상 "이어가기"가 아니라 "매일 0부터 다시 측정"이라는 점이 다르다.
  const wantsCarryover = isRoutineType || isAbstainType || isSplit || document.getElementById('bfCarryover').checked;
  const intervalDays = isRoutineType ? Math.max(1, parseInt(document.getElementById('bfIntervalDays').value) || 1) : null;

  const day = ensureDay(viewingDateKey);

  if (editBlockId !== null) {
    const b = day.blocks.find(x => x.id === editBlockId);
    if (b) {
      b.name = name; b.desc = desc; b.time = selectedTime; b.customTime = customTime;
      b.progressType = selectedProgress;
      // 루틴 ↔ 비루틴 전환은 막는다 (openBlockEdit에서 버튼 disabled 처리됨)
      b.type = b.type === 'routine' ? 'routine' : selectedType;

      if (selectedProgress === 'counter') { b.total = total; b.current = current; delete b.limitMinutes; }
      else if (selectedProgress === 'toggle') { if (b.done === undefined) b.done = false; delete b.limitMinutes; }
      else if (selectedProgress === 'timer') { b.limitMinutes = limitMinutes; if (!b.sessions) b.sessions = []; if (!b.abstainSessions) b.abstainSessions = []; delete b.total; delete b.current; }
      if (isSplit) b.splitDates = savedSplitDates; else delete b.splitDates;

      if (b.type === 'routine') {
        b.intervalDays = intervalDays;
        if (!b.routineAnchorKey) b.routineAnchorKey = viewingDateKey; // 기존 루틴에 처음 주기를 설정하는 경우 오늘을 기준일로
      } else {
        delete b.intervalDays; delete b.routineAnchorKey;
      }

      applyCarryoverFlag(b, wantsCarryover);
    }
  } else {
    const block = {
      id: Date.now() + Math.floor(Math.random()*1000),
      name, desc, type: selectedType, time: selectedTime, customTime,
      progressType: selectedProgress, sessions: []
    };
    if (selectedProgress === 'counter') { block.total = total; block.current = current; }
    if (selectedProgress === 'toggle') { block.done = false; }
    if (selectedProgress === 'timer') { block.limitMinutes = limitMinutes; block.abstainSessions = []; }
    if (isSplit) block.splitDates = savedSplitDates;
    if (isRoutineType) {
      block.intervalDays = intervalDays;
      block.routineAnchorKey = viewingDateKey; // 이 블록이 처음 생성된 날을 주기의 기준일로 삼음
    }
    applyCarryoverFlag(block, wantsCarryover);
    day.blocks.push(block);
  }

  saveDays(); renderBlocks(); renderScore(); closeOverlay('blockFormOverlay');
}

// carryover on/off 전환 처리. 켜질 때 새 체인 ID 발급, 꺼질 때 체인 중단 처리.
function applyCarryoverFlag(block, wantsCarryover) {
  if (wantsCarryover && !block.carryover) {
    block.carryover = true;
    block.carryoverId = 'c' + Date.now() + Math.floor(Math.random()*1000);
    carryoverMeta[block.carryoverId] = { stopped: false };
    saveCarryoverMeta();
  } else if (!wantsCarryover && block.carryover) {
    if (block.carryoverId) {
      carryoverMeta[block.carryoverId] = { stopped: true };
      saveCarryoverMeta();
    }
    block.carryover = false;
    delete block.carryoverId;
  }
  // wantsCarryover === block.carryover (둘 다 true 혹은 둘 다 false)인 경우 변경 없음
}

function askDeleteBlock(id) {
  const day = ensureDay(viewingDateKey);
  const b = day.blocks.find(x => x.id === id);
  if (!b) return;
  deleteBlockId = id;
  const hasCarryover = !!b.carryover;
  let msg;
  if (b.type === 'abstain') msg = `<strong>${esc(b.name)}</strong> 블록을 삭제할까요?<br>오늘 이후로 더 이상 매일 자동으로 생성되지 않아요.`;
  else if (hasCarryover) msg = `<strong>${esc(b.name)}</strong> 블록을 삭제할까요?<br>오늘 이후로 더 이상 자동으로 이어지지 않아요.`;
  else msg = `<strong>${esc(b.name)}</strong> 블록을 삭제할까요?<br>이 작업은 되돌릴 수 없어요.`;
  document.getElementById('confirmMsg').innerHTML = msg;
  document.getElementById('confirmOkBtn').onclick = () => {
    day.blocks = day.blocks.filter(x => x.id !== deleteBlockId);
    if (hasCarryover && b.carryoverId) {
      carryoverMeta[b.carryoverId] = { stopped: true };
      saveCarryoverMeta();
    }
    // 삭제되는 블록의 타이머가 진행 중이면 강제 정리
    if (activeTimer && activeTimer.blockId === deleteBlockId) {
      activeTimer = null;
      saveActiveTimer();
    }
    if (activeAbstainTimers[deleteBlockId]) {
      delete activeAbstainTimers[deleteBlockId];
      saveActiveAbstainTimers();
    }
    saveDays(); renderBlocks(); renderScore(); closeOverlay('confirmOverlay');
  };
  document.getElementById('confirmOverlay').classList.add('open');
}

function changeBlockCounter(id, delta) {
  const day = ensureDay(viewingDateKey);
  const b = day.blocks.find(x => x.id === id);
  if (!b) return;
  b.current = Math.max(0, b.current + delta); // 초과달성 허용: 상한 없음
  saveDays(); renderBlocks(); renderScore();
}

function toggleBlockDone(id) {
  const day = ensureDay(viewingDateKey);
  const b = day.blocks.find(x => x.id === id);
  if (!b) return;
  b.done = !b.done;
  saveDays(); renderBlocks(); renderScore();
}

function moveBlock(idx, dir) {
  const day = ensureDay(viewingDateKey);
  const target = idx + dir;
  if (target < 0 || target >= day.blocks.length) return;
  [day.blocks[idx], day.blocks[target]] = [day.blocks[target], day.blocks[idx]];
  saveDays(); renderBlocks();
}

/* =========================================================
   POSTPONE (미루기)
   미완료 + 비이행(carryover 아님) 블록을 다른 날짜로 옮긴다. "복사"가 아니라 "이동" —
   오늘 화면에서는 사라지고 지정한 날짜에 같은 진행률 그대로 새로 생긴다.
   보조 집중타이머 세션(sessions)은 그 날의 기록이라 의미가 없어지므로 초기화한다.
   ========================================================= */
function openPostponePopup(blockId) {
  postponeBlockId = blockId;
  document.getElementById('postponeDateField').classList.add('hidden');
  const tomorrow = addDaysToKey(viewingDateKey, 1);
  const dateInput = document.getElementById('postponeDateInput');
  dateInput.value = tomorrow;
  dateInput.min = TODAY_KEY(); // 과거 날짜는 선택 불가 (미루기는 항상 미래로만)
  document.getElementById('postponeOverlay').classList.add('open');
}

function togglePostponeDateField() {
  document.getElementById('postponeDateField').classList.toggle('hidden');
}

function postponeBlock(mode) {
  const day = ensureDay(viewingDateKey);
  const idx = day.blocks.findIndex(x => x.id === postponeBlockId);
  if (idx === -1) { closeOverlay('postponeOverlay'); return; }

  let targetKey;
  if (mode === 'tomorrow') {
    targetKey = addDaysToKey(viewingDateKey, 1);
  } else {
    const val = document.getElementById('postponeDateInput').value;
    if (!val) { showToast('날짜를 선택해주세요'); return; }
    if (val < TODAY_KEY()) { showToast('과거 날짜로는 미룰 수 없어요'); return; }
    targetKey = val;
  }

  const [b] = day.blocks.splice(idx, 1); // 오늘 목록에서 제거 (이동이므로 복사가 아니라 삭제)
  const moved = { ...b, id: Date.now() + Math.floor(Math.random()*10000) };
  moved.sessions = []; // 그날의 집중시간 기록이라 날짜를 옮기면 의미가 없어짐
  if (activeTimer && activeTimer.blockId === b.id) { activeTimer = null; saveActiveTimer(); }

  const targetDay = ensureDay(targetKey);
  targetDay.blocks.push(moved);

  saveDays(); renderBlocks(); renderScore(); closeOverlay('postponeOverlay');
  const targetD = keyToDate(targetKey);
  showToast(`${targetD.getMonth()+1}월 ${targetD.getDate()}일로 미뤘어요`);
}

/* =========================================================
   DRAG REORDER (꾹 누르기 → 드래그)
   카드 좌측의 reorder-handle(세 줄 아이콘)을 누른 채로 위아래로 끌면 카드 순서가 바뀐다.
   기존 위/아래 화살표 버튼과 공존 — 둘 중 편한 방법으로 순서를 바꿀 수 있다.
   컨테이너별로 하나의 pointerdown 리스너만 두고(이벤트 위임), 어떤 카드를 눌렀는지는
   매번 e.target에서 가장 가까운 .card를 찾아 판단한다 (렌더링이 다시 될 때마다
   리스너를 재등록할 필요가 없어서 가볍다).

   registerDragReorder(containerId, getList, onReorder)
     - containerId : 카드들을 담고 있는 리스트 div의 id
     - getList()   : (현재는 직접 쓰이지 않지만) 컨테이너의 현재 데이터 배열 — 디버깅/향후 확장용으로 보관
     - onReorder(fromIdx, toIdx) : 실제 데이터 배열의 순서를 바꾸고 저장 + 리렌더까지 책임짐
   ========================================================= */
const dragReorderConfigs = {}; // { [containerId]: { getList, onReorder } }

function registerDragReorder(containerId, getList, onReorder) {
  dragReorderConfigs[containerId] = { getList, onReorder };
  const el = document.getElementById(containerId);
  if (!el || el.dataset.dragInit) return; // 리스너는 한 번만 부착
  el.dataset.dragInit = '1';
  el.addEventListener('pointerdown', e => onDragHandlePointerDown(e, containerId));
}

function onDragHandlePointerDown(e, containerId) {
  const handle = e.target.closest('.reorder-handle');
  if (!handle) return; // 핸들이 아닌 다른 부분을 눌렀으면 무시 (일반 클릭/스크롤 동작 유지)
  if (handle.classList.contains('reorder-handle-disabled')) return; // 시간순 정렬 중에는 순서 변경 불가
  const card = handle.closest('.card');
  const container = document.getElementById(containerId);
  if (!card || !container) return;

  const cards = Array.from(container.querySelectorAll('.card'));
  const startIdx = cards.indexOf(card);
  if (startIdx === -1) return;

  e.preventDefault();
  const cardRect = card.getBoundingClientRect();
  const cardHeight = cardRect.height;
  const gap = cards.length > 1
    ? (cards[1].getBoundingClientRect().top - cardRect.top) - cardRect.height
    : 0;
  const rowHeight = cardHeight + Math.max(0, gap);

  dragReorderState = {
    containerId, cards, startIdx, currentIdx: startIdx,
    startY: e.clientY, cardHeight: rowHeight, card,
    pointerId: e.pointerId,
  };

  card.classList.add('drag-active');
  card.style.position = 'relative';
  card.style.zIndex = '5';
  card.setPointerCapture(e.pointerId);

  card.addEventListener('pointermove', onDragHandlePointerMove);
  card.addEventListener('pointerup', onDragHandlePointerUp);
  card.addEventListener('pointercancel', onDragHandlePointerUp);
}

function onDragHandlePointerMove(e) {
  const st = dragReorderState;
  if (!st || e.pointerId !== st.pointerId) return;
  const dy = e.clientY - st.startY;
  st.card.style.transform = `translateY(${dy}px)`;

  // 드래그 중인 카드가 몇 칸 이동했는지 계산해서, 사이에 있는 카드들을 밀어내는 자리 비움 애니메이션을 준다
  const steps = Math.round(dy / st.cardHeight);
  let newIdx = Math.max(0, Math.min(st.cards.length - 1, st.startIdx + steps));
  if (newIdx !== st.currentIdx) {
    st.currentIdx = newIdx;
    st.cards.forEach((c, i) => {
      if (c === st.card) return;
      let shift = 0;
      if (st.startIdx < newIdx && i > st.startIdx && i <= newIdx) shift = -st.cardHeight;
      else if (st.startIdx > newIdx && i < st.startIdx && i >= newIdx) shift = st.cardHeight;
      c.style.transition = 'transform .15s ease';
      c.style.transform = shift ? `translateY(${shift}px)` : '';
    });
  }
}

function onDragHandlePointerUp(e) {
  const st = dragReorderState;
  if (!st || e.pointerId !== st.pointerId) return;
  st.card.removeEventListener('pointermove', onDragHandlePointerMove);
  st.card.removeEventListener('pointerup', onDragHandlePointerUp);
  st.card.removeEventListener('pointercancel', onDragHandlePointerUp);
  try { st.card.releasePointerCapture(st.pointerId); } catch (err) {}

  st.card.classList.remove('drag-active');
  st.card.style.position = '';
  st.card.style.zIndex = '';
  st.card.style.transform = '';
  st.cards.forEach(c => { c.style.transition = ''; c.style.transform = ''; });

  const { containerId, startIdx, currentIdx } = st;
  dragReorderState = null;
  if (currentIdx !== startIdx) {
    const cfg = dragReorderConfigs[containerId];
    if (cfg) cfg.onReorder(startIdx, currentIdx);
  }
}

function timeLabelFor(b) {
  if (b.time === 'custom' && b.customTime) return b.customTime;
  return TIME_LABEL[b.time] || '';
}

function blockProgressFraction(b) {
  if (b.progressType === 'counter') return b.total > 0 ? Math.min(1, b.current / b.total) : 0;
  if (b.progressType === 'toggle') return b.done ? 1 : 0;
  return null;
}

// 절제(abstain) 블록이 그날 상한을 넘었는지 판정. 카운터형은 current > total,
// 시간재기형은 누적 사용 시간(진행 중인 타이머 경과분 포함)이 limitMinutes를 넘었는지로 판단한다.
function isAbstainOverLimit(b) {
  if (b.progressType === 'counter') return (b.total > 0) && b.current > b.total;
  if (b.progressType === 'timer') return abstainTimerTotalMs(b) > (b.limitMinutes || 0) * 60 * 1000;
  return false;
}

// 초과달성 시 추가 점수 (절댓값 점수에 초과 비율을 곱한 보너스, 기본 점수에 추가로 더해짐)
// 절제(abstain) 블록은 초과가 보너스가 아니라 감점 대상이므로 여기서는 항상 0.
function blockOverAchieveBonus(b) {
  if (b.type === 'abstain') return 0;
  if (b.progressType !== 'counter') return 0;
  if (b.current <= b.total || b.total <= 0) return 0;
  const overFrac = (b.current - b.total) / b.total; // 초과 비율
  const w = weights[b.type] ?? 5;
  return overFrac * w; // 절댓값 점수에 비례한 보너스
}

// 이행 블록에서 특정 날짜의 "그 날만의 진행도"를 계산.
// 전날부터 이어진 블록이라면 (전날 진행도) → (이날 진행도)의 증분만 그날 기여로 본다.
// 루틴은 매일 리셋이므로 해당 없음. toggle은 그날 done 여부로만 판단.
function blockDayFraction(b, dayKey) {
  if (!b.carryover || b.type === 'routine') return blockProgressFraction(b);
  if (b.progressType === 'toggle') return b.done ? 1 : 0;
  if (b.progressType === 'counter') {
    const todayFrac = b.total > 0 ? Math.min(1, b.current / b.total) : 0;
    // 전날 같은 carryoverId 블록을 찾아 전날 진행도 계산
    const prevKey = addDaysToKey(dayKey, -1);
    const prevDay = days[prevKey];
    let prevFrac = 0;
    if (prevDay && b.carryoverId) {
      const prevBlock = prevDay.blocks.find(x => x.carryoverId === b.carryoverId);
      if (prevBlock) prevFrac = prevBlock.total > 0 ? Math.min(1, prevBlock.current / prevBlock.total) : 0;
    }
    // 그날 달성한 증분 (0 이상)
    return Math.max(0, todayFrac - prevFrac);
  }
  return blockProgressFraction(b);
}

function isBlockComplete(b) {
  if (b.type === 'abstain') return false; // 절제는 "완료"가 아니라 "초과(경고)" 상태로 별도 표시
  if (b.progressType === 'counter') return b.current >= b.total;
  if (b.progressType === 'toggle') return !!b.done;
  return false;
}

// 루틴 블록이 주어진 날짜(dayKey)에 "활성화되는 날"인지 판정.
// anchorKey로부터 며칠 지났는지를 intervalDays로 나눈 나머지가 0이면 활성 날.
// intervalDays가 1(기본, 매일) 또는 anchorKey가 없으면 항상 true.
function isRoutineDueOn(template, dayKey) {
  const interval = template.intervalDays || 1;
  if (interval <= 1 || !template.routineAnchorKey) return true;
  const anchorDate = keyToDate(template.routineAnchorKey);
  const targetDate = keyToDate(dayKey);
  const diffDays = Math.round((targetDate - anchorDate) / 86400000);
  if (diffDays < 0) return false; // 기준일보다 이전 날짜는 해당 없음
  return diffDays % interval === 0;
}

/* =========================================================
   CARRYOVER ENGINE (루틴 + 일반 "이행" 블록 공통)
   완료되지 않은 채 하루가 지나면 진행도를 그대로 들고 다음 날 목록에
   다시 나타난다. 완료되면 그 체인은 멈춘다.
   ========================================================= */

// 오늘 날짜에 없는 활성 carryover 체인을 찾아서, 가장 최근 날의 미완료 상태를 오늘로 복사한다.
// 앱이 열릴 때 + 가상의 날짜가 바뀔 때 호출.
function syncCarryoversForToday() {
  const todayKey = TODAY_KEY();
  const today = ensureDay(todayKey);
  const existingIds = new Set(today.blocks.filter(b => b.carryover).map(b => b.carryoverId));

  const activeIds = Object.keys(carryoverMeta).filter(cid => !carryoverMeta[cid].stopped);
  let addedCount = 0;

  activeIds.forEach(cid => {
    if (existingIds.has(cid)) return; // 오늘 이미 있음

    // 과거 날짜들 중 이 체인이 마지막으로 존재했던 블록을 찾는다 (최대 60일 역탐색)
    let template = null, templateKey = null;
    for (let i = 1; i <= 60; i++) {
      const k = addDaysToKey(todayKey, -i);
      const dayObj = days[k];
      if (!dayObj) continue;
      const found = dayObj.blocks.find(b => b.carryoverId === cid);
      if (found) { template = found; templateKey = k; break; }
    }
    if (!template) return;

    // 완료된 상태로 끝났다면 체인을 멈추고 복사하지 않는다 (조용히 사라짐).
    // 단, 루틴/절제는 "완료"가 그날의 결과일 뿐 다음날도 무조건 미완료 상태로 다시 반복돼야 하므로 예외.
    if (template.type !== 'routine' && template.type !== 'abstain' && isBlockComplete(template)) {
      carryoverMeta[cid] = { stopped: true };
      saveCarryoverMeta();
      return;
    }

    // "매 n일마다" 루틴이고 오늘이 주기 날이 아니면 오늘 목록에 추가하지 않고 건너뜀 (쉬는 날)
    if (template.type === 'routine' && !isRoutineDueOn(template, todayKey)) return;

    // 미완료 → 그날까지의 진행도를 그대로 들고 오늘로 복사 (루틴/절제는 진행도 리셋, 이행은 유지)
    const nb = { ...template, id: Date.now() + Math.floor(Math.random()*100000) };
    if (template.type === 'routine' || template.type === 'abstain') {
      // 루틴/절제는 매일(또는 매 n일) 새로 시작하는 반복 — 진행도 리셋
      if (nb.progressType === 'counter') nb.current = 0;
      if (nb.progressType === 'toggle') nb.done = false;
      if (nb.progressType === 'timer') { nb.sessions = []; nb.abstainSessions = []; }
    }
    // 일반 이행 블록은 진행도를 그대로 유지 (그날까지 한 만큼 이어서)
    today.blocks.push(nb);
    addedCount++;
  });

  if (addedCount > 0) saveDays();
  return addedCount;
}

/* =========================================================
   FOCUS TIME HELPERS
   ========================================================= */
function sessionDurationMs(s) {
  return new Date(s.end).getTime() - new Date(s.start).getTime();
}
function blockTotalFocusMs(b) {
  if (!b.sessions || !b.sessions.length) return 0;
  return b.sessions.reduce((sum, s) => sum + Math.max(0, sessionDurationMs(s)), 0);
}
function formatDurationShort(ms) {
  const totalSec = Math.round(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}시간 ${m}분`;
  if (m > 0) return `${m}분 ${s}초`;
  return `${s}초`;
}
function formatHMS(ms) {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const h = String(Math.floor(totalSec / 3600)).padStart(2,'0');
  const m = String(Math.floor((totalSec % 3600) / 60)).padStart(2,'0');
  const s = String(totalSec % 60).padStart(2,'0');
  return `${h}:${m}:${s}`;
}
function formatClock(isoStr) {
  const d = new Date(isoStr);
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}
function renderSessionLog(b) {
  const hasSessions = b.sessions && b.sessions.length > 0;
  const hasGoal = !!b.goalMinutes;
  if (!hasSessions && !hasGoal) return '';

  const rows = hasSessions ? b.sessions.map(s => {
    const dur = formatDurationShort(sessionDurationMs(s));
    return `<div class="session-log-row"><span class="session-log-duration">${dur}</span><span class="session-log-times">${formatClock(s.start)}–${formatClock(s.end)}</span></div>`;
  }).join('') : '';

  const total = blockTotalFocusMs(b);
  const goalMs = hasGoal ? b.goalMinutes * 60 * 1000 : 0;
  const goalReached = hasGoal && total >= goalMs;
  const summaryHtml = hasGoal
    ? `<div class="focus-total-row ${goalReached ? 'goal-reached' : ''}">걸린 시간 <strong>${formatDurationShort(total)}</strong> / 목표 <strong>${b.goalMinutes}분</strong></div>`
    : `<div class="focus-total-row">총 집중시간 <strong>${formatDurationShort(total)}</strong></div>`;

  return `${hasSessions ? `<div class="session-log">${rows}</div>` : ''}${summaryHtml}`;
}

/* =========================================================
   HEATMAP (루틴 전용 — 최근 N일 완료율)
   ========================================================= */
function getCarryoverHeatmap(carryoverId, days_count) {
  const todayKey = TODAY_KEY();
  const result = [];
  for (let i = days_count - 1; i >= 0; i--) {
    const k = addDaysToKey(todayKey, -i);
    const dayObj = days[k];
    let frac = null;
    if (dayObj) {
      const b = dayObj.blocks.find(x => x.carryoverId === carryoverId);
      if (b) frac = blockProgressFraction(b);
    }
    result.push({ key: k, frac });
  }
  return result;
}

function heatmapCellClass(frac) {
  if (frac === null || frac === undefined) return 'hm-empty';
  if (frac <= 0) return 'hm-0';
  if (frac < 0.34) return 'hm-1';
  if (frac < 0.67) return 'hm-2';
  if (frac < 1) return 'hm-3';
  return 'hm-4';
}

function renderHeatmap(carryoverId) {
  const cells = getCarryoverHeatmap(carryoverId, HEATMAP_DAYS);
  return `<div class="heatmap" role="img" aria-label="최근 ${HEATMAP_DAYS}일 달성도">
    ${cells.map(c => `<span class="hm-cell ${heatmapCellClass(c.frac)}" title="${c.key}${c.frac!=null ? ' · ' + Math.round(c.frac*100)+'%' : ''}"></span>`).join('')}
  </div>`;
}

/* =========================================================
   RENDER BLOCKS
   ========================================================= */
function renderBlocks() {
  const day = ensureDay(viewingDateKey);
  const el = document.getElementById('blockList');
  if (!day.blocks.length) {
    el.innerHTML = `<div class="empty">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><rect x="3" y="4" width="18" height="16" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="16" y1="2" x2="16" y2="6"/></svg>
      <p>오늘 할 일을 추가해보세요</p>
    </div>`;
    return;
  }
  // 완료된 블록(진행체크가 있는 것만 해당)은 항상 맨 아래로. 순서 변경 모드의
  // 위/아래 버튼은 실제 데이터 배열(day.blocks)의 인덱스를 그대로 사용해야 하므로,
  // 정렬은 표시용으로만 하고 원래 인덱스(realIdx)를 함께 들고 다닌다.
  const withIdx = day.blocks.map((b, realIdx) => ({ b, realIdx }));
  const sorted = withIdx.slice().sort((x, y) => {
    const xDone = x.b.progressType !== 'none' && isBlockComplete(x.b) ? 1 : 0;
    const yDone = y.b.progressType !== 'none' && isBlockComplete(y.b) ? 1 : 0;
    if (xDone !== yDone) return xDone - yDone;
    return x.realIdx - y.realIdx; // 같은 그룹 내에서는 원래 순서 유지
  });

  el.innerHTML = sorted.map(({ b, realIdx }) => {
    const idx = realIdx; // moveBlock 등에서 쓰는 실제 배열 인덱스
    const complete = isBlockComplete(b);
    let progressHtml = '';
    if (b.progressType === 'counter') {
      const isAbstain = b.type === 'abstain';
      const pct = b.total > 0 ? Math.round(b.current / b.total * 100) : 0;
      const atMin = b.current <= 0;
      const overAchieved = b.current > b.total;
      const fillPct = Math.min(100, pct);
      const overText = overAchieved
        ? (isAbstain ? `<span class="abstain-over-badge">상한 초과 +${b.current - b.total}</span>` : `<span class="over-achieve-badge">+${b.current - b.total}</span>`)
        : '';

      // 쪼개기 수직선 마커 생성
      let splitMarkersHtml = '';
      if (b.time === 'split' && b.splitDates && b.splitDates.length && b.total > 0) {
        let cumCount = 0;
        const markers = [];
        b.splitDates.forEach(sd => {
          cumCount += (sd.count || 0);
          const markerPct = Math.min(100, Math.round(cumCount / b.total * 100));
          if (markerPct > 0 && markerPct < 100) {
            const d = keyToDate(sd.date);
            const label = `${d.getMonth()+1}/${d.getDate()}`;
            markers.push(`<div class="split-marker" style="left:${markerPct}%" title="${label} 목표: ${cumCount}/${b.total}"><div class="split-marker-label">${label}</div></div>`);
          }
        });
        splitMarkersHtml = markers.join('');
      }

      progressHtml = `<div class="block-progress-row">
        <button class="ctrl-btn" style="width:32px;height:32px;font-size:18px;" onclick="changeBlockCounter(${b.id},-1)" ${atMin?'disabled':''} aria-label="감소">−</button>
        <div class="fraction" style="font-size:18px;min-width:54px;">${b.current}<span style="font-size:13px;">/${b.total}</span></div>
        <button class="ctrl-btn" style="width:32px;height:32px;font-size:18px;" onclick="changeBlockCounter(${b.id},1)" aria-label="증가">+</button>
        <span class="counter-pct">${pct}%</span>
        ${overText}
        <div class="prog-wrap"><div class="prog-bar prog-bar-relative"><div class="prog-fill ${overAchieved?(isAbstain?'prog-fill-abstain-over':'prog-fill-over'):''}" style="width:${fillPct}%"></div>${splitMarkersHtml}</div></div>
      </div>`;
    } else if (b.progressType === 'toggle') {
      progressHtml = `<div class="block-progress-row">
        <button class="toggle-check ${b.done?'done':''}" onclick="toggleBlockDone(${b.id})" aria-label="완료 토글">
          <svg viewBox="0 0 24 24" fill="none" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
        </button>
        <span class="toggle-label">${b.done ? '완료' : '미완료'}</span>
      </div>`;
    } else if (b.progressType === 'timer') {
      // 절제 전용 "시간재기형" — 카운터 대신 누적시간과 시작/정지 버튼이 바로 카드 본문에 뜬다.
      // 보조 집중타이머(card-btns의 시계 아이콘)와는 별개의 세션 기록(abstainSessions)이라 동시/중복 실행이 가능하다.
      const usedMs = abstainTimerTotalMs(b);
      const limitMs = (b.limitMinutes || 0) * 60 * 1000;
      const overLimit = limitMs > 0 && usedMs > limitMs;
      const pct = limitMs > 0 ? Math.round(usedMs / limitMs * 100) : 0;
      const fillPct = Math.min(100, pct);
      const isRunning = !!activeAbstainTimers[b.id];
      progressHtml = `<div class="block-progress-row">
        <button class="ctrl-btn abstain-timer-btn ${isRunning ? 'running' : ''}" style="width:32px;height:32px;" onclick="${isRunning ? `stopAbstainTimer(${b.id})` : `startAbstainTimer(${b.id})`}" aria-label="${isRunning ? '정지' : '시작'}">
          ${isRunning
            ? '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="1"/></svg>'
            : '<svg viewBox="0 0 24 24" fill="currentColor"><polygon points="6 4 20 12 6 20"/></svg>'}
        </button>
        <div class="fraction" style="font-size:16px;min-width:80px;"><span class="abstain-timer-display" data-over="${overLimit?'1':'0'}">${formatDurationShort(usedMs)}</span><span style="font-size:12px;"> / ${b.limitMinutes}분</span></div>
        ${overLimit ? `<span class="abstain-over-badge">상한 초과</span>` : ''}
        <div class="prog-wrap"><div class="prog-bar prog-bar-relative"><div class="prog-fill ${overLimit?'prog-fill-abstain-over':''}" style="width:${fillPct}%"></div></div></div>
      </div>`;
    }
    const timeStr = timeLabelFor(b);
    const carryoverBadge = (b.carryover && b.type !== 'routine' && b.type !== 'abstain') ? `<span class="carryover-chip">이행</span>` : '';
    const intervalBadge = (b.type === 'routine' && b.intervalDays > 1) ? `<span class="carryover-chip">매 ${b.intervalDays}일마다</span>` : '';
    const hasTime = blockTotalFocusMs(b) > 0 || (activeTimer && activeTimer.blockId === b.id);
    const isTimerActive = activeTimer && activeTimer.blockId === b.id && activeTimer.dateKey === viewingDateKey;
    const isAbstainTimerActive = !!activeAbstainTimers[b.id];
    return `<div class="card block-card type-${b.type} ${complete && b.progressType!=='none' ? 'completed':''}" data-id="${b.id}">
      <div class="reorder-handle">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
      </div>
      <div class="card-main">
        <div class="card-header">
          <div class="card-title-wrap">
            <div class="card-title">${esc(b.name)}${isTimerActive || isAbstainTimerActive ? ' ⏱' : ''}</div>
            <div class="card-sub"><span class="type-chip">${TYPE_LABEL[b.type]}</span>${timeStr ? `<span class="time-chip">${timeStr}</span>` : ''}${carryoverBadge}${intervalBadge}</div>
            ${b.type === 'routine' ? renderHeatmap(b.carryoverId) : ''}
          </div>
          <div class="card-btns">
            ${(!complete && !b.carryover) ? `<button class="icon-btn" onclick="openPostponePopup(${b.id})" aria-label="미루기">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="12 6 12 12 16 14"/><path d="M3.05 11a9 9 0 1 0 .5-4"/><polyline points="3 4 3 9 8 9"/></svg>
            </button>` : ''}
            <button class="timer-icon-btn ${hasTime ? 'has-time' : ''}" onclick="openTimerSheet(${b.id})" aria-label="집중 시간 재기">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 16 14"/></svg>
            </button>
            <button class="icon-btn" onclick="openBlockEdit(${b.id})" aria-label="수정">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            </button>
            <button class="icon-btn" onclick="askDeleteBlock(${b.id})" aria-label="삭제">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
            </button>
          </div>
          <div class="move-btns">
            <button class="move-btn" onclick="moveBlock(${idx},-1)" ${idx===0?'disabled':''} aria-label="위로"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg></button>
            <button class="move-btn" onclick="moveBlock(${idx},1)" ${idx===day.blocks.length-1?'disabled':''} aria-label="아래로"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg></button>
          </div>
        </div>
        ${b.desc ? `<div class="block-desc">${escLinkify(b.desc, 32)}</div>` : ''}
        ${progressHtml}
        ${renderSessionLog(b)}
      </div>
    </div>`;
  }).join('');

  // 드래그는 "화면에 보이는 순서(완료 항목이 맨 아래로 정렬된 순서)" 기준으로 동작.
  // 화살표 버튼과 마찬가지로, 옮긴 결과를 실제 day.blocks 배열에 그 순서대로 다시 써넣는다
  // (완료 상태가 바뀌지 않았다면 다음 렌더링에서 같은 정렬 결과가 나와 자리가 유지된다).
  registerDragReorder('blockList',
    () => sorted.map(x => x.b),
    (fromIdx, toIdx) => {
      const order = sorted.map(x => x.b);
      const [moved] = order.splice(fromIdx, 1);
      order.splice(toIdx, 0, moved);
      day.blocks = order;
      saveDays(); renderBlocks();
    }
  );
}

/* =========================================================
   YESTERDAY COPY (수동) — carryover 블록은 자동으로 이어지므로 제외
   ========================================================= */
/* =========================================================
   SCORE CALCULATION (절댓값 합산 — 100점 캡 없음)
   각 블록 타입의 weights[type] 값은 "절댓값 점수"다. 완료된 항목은 그 값 전체,
   카운터형처럼 부분 진행이 있는 항목은 (진행 비율 × 절댓값)만큼 점수를 더한다.
   집중시간/감상도 동일한 원리로 (달성 비율 × 절댓값) 점수를 더한다.
   하루 총점은 모든 항목의 점수를 단순히 다 더한 값 — 100점 만점 캡이 없다.
   ========================================================= */
const FOCUS_GOAL_MINUTES_DEFAULT = 120;
function getFocusGoalMs() {
  const mins = weights.focusGoalMinutes ?? FOCUS_GOAL_MINUTES_DEFAULT;
  return mins * 60 * 1000;
}

function dayTotalFocusMs(day) {
  return day.blocks.reduce((sum, b) => sum + blockTotalFocusMs(b), 0);
}

// 하루치 점수를 절댓값 합산 방식으로 계산.
// fracFn(b) : 블록 b의 그날 진행 비율(0~1)을 반환하는 함수 — 오늘 화면용은 blockProgressFraction,
//             특정 과거 날짜의 "그날만의 기여도"용은 blockDayFraction을 넘겨받아 사용한다.
// 절제(abstain) 유형은 일반 블록과 점수 부호가 반대다: 상한을 넘기 전까지는 점수에 영향이 없고,
// 한 번 넘으면 그 즉시 weights.abstain 만큼 감점되며(maxScore에는 포함 안 됨), 그 이후 더 써도 추가 감점은 없다.
function computeDayScoreRaw(day, dayKey, fracFn) {
  const scorable = day.blocks.filter(b => b.progressType !== 'none' && b.type !== 'abstain');
  const abstainBlocks = day.blocks.filter(b => b.type === 'abstain');
  const totalFocusMs = dayTotalFocusMs(day);
  const focusWeight = weights.focus ?? 0;
  const hasFocusComponent = focusWeight > 0;
  const watchWeight = weights.watch ?? 0;
  const watchFrac = dayWatchScoreFraction(day);
  const hasWatchComponent = watchWeight > 0 && watchFrac !== null;

  if (!scorable.length && !hasFocusComponent && !hasWatchComponent && !abstainBlocks.length) {
    return { score: null, maxScore: 0, totalFocusMs, hasAny: false };
  }

  let score = 0, maxScore = 0;
  scorable.forEach(b => {
    const w = weights[b.type] ?? 5;
    const frac = fracFn(b, dayKey);
    score += w * (frac ?? 0);
    maxScore += w;
  });
  if (hasFocusComponent) {
    const focusFrac = Math.min(1, totalFocusMs / getFocusGoalMs());
    score += focusWeight * focusFrac;
    maxScore += focusWeight;
  }
  if (hasWatchComponent) {
    score += watchWeight * watchFrac;
    maxScore += watchWeight;
  }
  // 초과달성 보너스: 절댓값 점수에 비례해 추가로 더해짐 (maxScore에는 포함 안 됨)
  let overBonus = 0;
  scorable.forEach(b => { overBonus += blockOverAchieveBonus(b); });
  // 절제 블록 감점: 상한을 넘은 블록마다 weights.abstain만큼 한 번씩 깎임
  let abstainPenalty = 0;
  const abstainWeight = weights.abstain ?? 5;
  abstainBlocks.forEach(b => { if (isAbstainOverLimit(b)) abstainPenalty += abstainWeight; });
  score = Math.round((score + overBonus - abstainPenalty) * 10) / 10;
  return { score, maxScore: Math.round(maxScore * 10) / 10, totalFocusMs, hasAny: true };
}

function renderScore() {
  const day = ensureDay(viewingDateKey);
  const el = document.getElementById('scoreCard');
  const result = computeDayScoreRaw(day, viewingDateKey, blockProgressFraction);

  if (!result.hasAny) {
    el.innerHTML = `<div class="score-top"><div class="score-num">—</div></div>
      <div class="score-feedback">진행 체크가 있는 블록을 추가하면 점수가 표시돼요.</div>
      <div class="score-bottom-row"><span></span>${renderFeedbackButton()}</div>`;
    return;
  }

  const { score, maxScore, totalFocusMs } = result;
  const focusWeight = weights.focus ?? 0;
  const hasFocusComponent = focusWeight > 0;
  // 진행 막대는 "오늘 다 채웠을 때의 기준 점수(maxScore)" 대비 현재 점수 비율로 표시 (절제 감점으로 음수가 될 수도 있어 0 이상으로 고정)
  const barPct = maxScore > 0 ? Math.max(0, Math.min(100, Math.round((score / maxScore) * 100))) : (score > 0 ? 100 : 0);

  let feedback;
  if (score < 0) feedback = '절제 상한을 넘긴 항목이 있어 오늘 점수가 깎였어요. 내일 다시 챙겨봐요.';
  else if (barPct >= 90) feedback = '오늘 하루를 알차게 채웠어요. 훌륭해요!';
  else if (barPct >= 70) feedback = '꽤 잘 해내고 있어요. 남은 것도 마무리해봐요.';
  else if (barPct >= 40) feedback = '절반 정도 진행됐어요. 천천히 이어가요.';
  else if (barPct > 0) feedback = '이제 시작이에요. 하나씩 차근차근 해봐요.';
  else feedback = '아직 시작 전이에요. 작은 것부터 시작해볼까요?';

  el.innerHTML = `
    <div class="score-top"><div class="score-num">${score}${maxScore > 0 ? `<span>/${maxScore}</span>` : ''}</div></div>
    <div class="score-feedback">${feedback}</div>
    <div class="score-bar"><div class="score-bar-fill" style="width:${barPct}%"></div></div>
    <div class="score-bottom-row">
      ${hasFocusComponent ? `<span class="score-focus-row">집중 <strong>${formatDurationShort(totalFocusMs)}</strong></span>` : '<span></span>'}
      ${renderFeedbackButton()}
    </div>
  `;
}

function renderFeedbackButton() {
  const isToday = viewingDateKey === TODAY_KEY();
  if (!isToday) return '';
  return `<button class="score-feedback-btn" onclick="openYesterdayFeedback()">어제 피드백</button>`;
}

/* =========================================================
   FOCUS TIMER SHEET
   ========================================================= */
function findBlockById(id) {
  // 타이머는 보통 보고 있는 날짜의 블록을 다루지만, 다른 날짜에서 시작된 타이머(보조 타이머나
  // 절제 시간재기)가 진행 중일 수도 있으니 그 날짜들도 함께 탐색한다.
  const abstainDateKey = activeAbstainTimers[id] && activeAbstainTimers[id].dateKey;
  for (const key of [viewingDateKey, activeTimer && activeTimer.dateKey, abstainDateKey].filter(Boolean)) {
    const dayObj = days[key];
    if (!dayObj) continue;
    const found = dayObj.blocks.find(x => x.id === id);
    if (found) return { block: found, dateKey: key };
  }
  return null;
}

function openTimerSheet(blockId) {
  timerBlockId = blockId;
  const found = findBlockById(blockId);
  if (!found) return;
  document.getElementById('timerSheetTitle').textContent = found.block.name;
  document.getElementById('timerGoalMinutes').value = found.block.goalMinutes || '';
  document.getElementById('manualEntryFields').classList.add('hidden');
  document.getElementById('manualToggleLabel').textContent = '+ 직접 시작·종료 시간으로 추가';
  renderTimerSheet();
  document.getElementById('timerOverlay').classList.add('open');
  if (!timerTickHandle) timerTickHandle = setInterval(timerTick, 1000);
}

// 시트에서 목표 시간을 입력/수정하면 즉시 블록에 저장하고 카드의 표시도 갱신한다.
function setTimerGoalMinutes() {
  const found = findBlockById(timerBlockId);
  if (!found) return;
  const val = parseInt(document.getElementById('timerGoalMinutes').value);
  if (!val || val < 1) delete found.block.goalMinutes;
  else found.block.goalMinutes = val;
  saveDays();
  if (viewingDateKey === found.dateKey) renderBlocks();
}

function closeTimerSheet() {
  closeOverlay('timerOverlay');
  timerBlockId = null;
}

function isTimerRunningForCurrentBlock() {
  return activeTimer && activeTimer.blockId === timerBlockId;
}

function renderTimerSheet() {
  const found = findBlockById(timerBlockId);
  if (!found) return;
  const b = found.block;

  const startBtn = document.getElementById('timerStartBtn');
  const pauseBtn = document.getElementById('timerPauseBtn');
  const resumeBtn = document.getElementById('timerResumeBtn');
  const stopBtn = document.getElementById('timerStopBtn');
  const statusEl = document.getElementById('timerStatus');

  if (isTimerRunningForCurrentBlock()) {
    const running = !activeTimer.paused;
    startBtn.classList.add('hidden');
    pauseBtn.classList.toggle('hidden', !running);
    resumeBtn.classList.toggle('hidden', running);
    stopBtn.classList.remove('hidden');
    statusEl.textContent = running ? '기록 중' : '일시정지됨';
  } else {
    startBtn.classList.remove('hidden');
    pauseBtn.classList.add('hidden');
    resumeBtn.classList.add('hidden');
    stopBtn.classList.add('hidden');
    statusEl.textContent = '대기 중';
  }

  updateTimerDisplay();
  renderTimerSessionList(b);
}

function currentElapsedMs() {
  if (!activeTimer) return 0;
  let ms = activeTimer.accumulatedMs || 0;
  if (!activeTimer.paused) {
    ms += Date.now() - new Date(activeTimer.startedAt).getTime();
  }
  return ms;
}

function updateTimerDisplay() {
  const el = document.getElementById('timerDisplay');
  if (!el) return;
  if (isTimerRunningForCurrentBlock()) {
    el.textContent = formatHMS(currentElapsedMs());
  } else {
    el.textContent = '00:00:00';
  }
}

function timerTick() {
  if (activeTimer && !activeTimer.paused) {
    // 타이머가 떠 있을 때만 화면 갱신 (불필요한 렌더 방지)
    if (document.getElementById('timerOverlay').classList.contains('open') && isTimerRunningForCurrentBlock()) {
      updateTimerDisplay();
    }
  }
  // 실행 중인 절제 시간재기들의 카드 표시를 1초마다 가볍게 갱신 (전체 리렌더 없이 텍스트만)
  let crossedLimitJustNow = false;
  Object.keys(activeAbstainTimers).forEach(blockIdStr => {
    const el = document.querySelector(`.card[data-id="${blockIdStr}"] .abstain-timer-display`);
    if (el) {
      const found = findBlockById(parseInt(blockIdStr));
      if (found) {
        const wasOver = el.dataset.over === '1';
        const isOver = isAbstainOverLimit(found.block);
        el.textContent = formatDurationShort(abstainTimerTotalMs(found.block));
        if (isOver !== wasOver) { el.dataset.over = isOver ? '1' : '0'; crossedLimitJustNow = true; }
      }
    }
  });
  // 상한을 막 넘긴 시점이면 점수 표시와 카드의 초과 배지를 갱신 (가벼운 부분 갱신 대신 안전하게 전체 리렌더)
  if (crossedLimitJustNow) { renderBlocks(); renderScore(); }
}

// 절제 블록의 "시간재기형" 진행 시간 합계. 보조 집중타이머(sessions)와는 별도로
// abstainSessions에 기록되며, 현재 실행 중이면 그 경과시간도 더해서 보여준다.
function abstainTimerTotalMs(b) {
  const base = (b.abstainSessions || []).reduce((sum, s) => sum + Math.max(0, sessionDurationMs(s)), 0);
  const live = activeAbstainTimers[b.id];
  if (live) return base + (Date.now() - new Date(live.startedAt).getTime());
  return base;
}

function startAbstainTimer(blockId) {
  if (activeAbstainTimers[blockId]) return; // 이미 실행 중
  activeAbstainTimers[blockId] = { dateKey: viewingDateKey, startedAt: new Date().toISOString() };
  saveActiveAbstainTimers();
  renderBlocks();
  if (!timerTickHandle) timerTickHandle = setInterval(timerTick, 1000);
}

function stopAbstainTimer(blockId) {
  const live = activeAbstainTimers[blockId];
  if (!live) return;
  const elapsedMs = Date.now() - new Date(live.startedAt).getTime();
  delete activeAbstainTimers[blockId];
  saveActiveAbstainTimers();
  if (elapsedMs >= 1000) {
    const day = ensureDay(live.dateKey);
    const b = day.blocks.find(x => x.id === blockId);
    if (b) {
      if (!b.abstainSessions) b.abstainSessions = [];
      const endTime = new Date();
      const startTime = new Date(endTime.getTime() - elapsedMs);
      b.abstainSessions.push({ start: startTime.toISOString(), end: endTime.toISOString() });
      saveDays();
    }
  }
  renderBlocks(); renderScore();
}

function timerStart() {
  if (activeTimer) {
    showToast('다른 블록의 타이머가 이미 진행 중이에요. 먼저 끝내주세요.');
    return;
  }
  activeTimer = { dateKey: viewingDateKey, blockId: timerBlockId, startedAt: new Date().toISOString(), accumulatedMs: 0, paused: false };
  saveActiveTimer();
  renderTimerSheet();
  renderBlocks();
}

function timerPause() {
  if (!isTimerRunningForCurrentBlock() || activeTimer.paused) return;
  activeTimer.accumulatedMs = currentElapsedMs();
  activeTimer.paused = true;
  activeTimer.startedAt = new Date().toISOString(); // 재개 시 기준점 갱신용
  saveActiveTimer();
  renderTimerSheet();
}

function timerResume() {
  if (!isTimerRunningForCurrentBlock() || !activeTimer.paused) return;
  activeTimer.startedAt = new Date().toISOString();
  activeTimer.paused = false;
  saveActiveTimer();
  renderTimerSheet();
}

function timerStop() {
  if (!isTimerRunningForCurrentBlock()) return;
  const elapsedMs = currentElapsedMs();
  if (elapsedMs < 1000) {
    // 1초 미만은 기록하지 않고 그냥 정리
    activeTimer = null;
    saveActiveTimer();
    renderTimerSheet();
    renderBlocks();
    return;
  }
  const endTime = new Date();
  const startTime = new Date(endTime.getTime() - elapsedMs);
  const found = findBlockById(timerBlockId);
  if (found) {
    if (!found.block.sessions) found.block.sessions = [];
    found.block.sessions.push({ start: startTime.toISOString(), end: endTime.toISOString() });
    saveDays();
  }
  activeTimer = null;
  saveActiveTimer();
  renderTimerSheet();
  renderBlocks();
  renderScore();
  showToast(`${formatDurationShort(elapsedMs)} 기록했어요`);
}

function toggleManualEntry() {
  const fields = document.getElementById('manualEntryFields');
  const isHidden = fields.classList.contains('hidden');
  fields.classList.toggle('hidden');
  document.getElementById('manualToggleLabel').textContent = isHidden ? '− 직접 추가 닫기' : '+ 직접 시작·종료 시간으로 추가';
  if (isHidden) {
    const now = new Date();
    document.getElementById('manualStart').value = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
    document.getElementById('manualEnd').value = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
  }
}

function addManualSession() {
  const startStr = document.getElementById('manualStart').value;
  const endStr = document.getElementById('manualEnd').value;
  if (!startStr || !endStr) { showToast('시작과 종료 시간을 모두 입력해주세요'); return; }

  const found = findBlockById(timerBlockId);
  if (!found) return;
  const baseDate = keyToDate(found.dateKey);

  const [sh, sm] = startStr.split(':').map(Number);
  const [eh, em] = endStr.split(':').map(Number);
  const startDt = new Date(baseDate); startDt.setHours(sh, sm, 0, 0);
  let endDt = new Date(baseDate); endDt.setHours(eh, em, 0, 0);
  if (endDt.getTime() <= startDt.getTime()) endDt = new Date(endDt.getTime() + 24*60*60*1000); // 자정 넘김 처리

  if (!found.block.sessions) found.block.sessions = [];
  found.block.sessions.push({ start: startDt.toISOString(), end: endDt.toISOString() });
  saveDays();
  renderTimerSheet();
  renderBlocks();
  renderScore();
  showToast('사이클을 추가했어요');
  toggleManualEntry();
}

function renderTimerSessionList(b) {
  const el = document.getElementById('timerSessionList');
  if (!b.sessions || !b.sessions.length) {
    el.innerHTML = `<div class="timer-session-empty">아직 기록된 사이클이 없어요</div>`;
    return;
  }
  el.innerHTML = b.sessions.map((s, idx) => {
    const dur = formatDurationShort(sessionDurationMs(s));
    return `<div class="timer-session-item">
      <div>
        <div class="ts-dur">${dur}</div>
        <div class="ts-range">${formatClock(s.start)}–${formatClock(s.end)}</div>
      </div>
      <button class="timer-session-del" onclick="deleteSession(${idx})" aria-label="삭제">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>`;
  }).join('');
}

function deleteSession(idx) {
  const found = findBlockById(timerBlockId);
  if (!found || !found.block.sessions) return;
  found.block.sessions.splice(idx, 1);
  saveDays();
  renderTimerSheet();
  renderBlocks();
  renderScore();
}

/* =========================================================
   PLAN PAGE
   ========================================================= */
function switchPlanSubtab(sub) {
  currentPlanSubtab = sub;
  ['time','unspecified','period'].forEach(s => {
    document.getElementById(`planSubtab-${s}`).classList.toggle('active', sub === s);
  });
  document.getElementById('periodAddBtn').classList.toggle('hidden', sub !== 'period');
  document.getElementById('planAddBtn').classList.toggle('hidden', sub === 'period');
  if (reordering) toggleReorder(); // 서브탭을 바꾸면 순서모드는 헷갈리니 끈다
  renderPlanList();
}

function onPlanTimeModeChanged() {
  document.getElementById('pfTimeFields').classList.toggle('hidden', selectedPlanTimeMode !== 'specified');
}

/* =========================================================
   SUBTAB SWIPE GESTURE (범용)
   "큰 탭 속 작은 탭"을 좌우 스와이프로 전환하는 공통 로직.
   가로 이동이 세로 이동보다 뚜렷하게 크고(가로/세로 비율 1.5 이상),
   일정 거리(SWIPE_THRESHOLD) 이상 움직였을 때만 탭 전환으로 인식해서
   세로 스크롤이나 다른 가로 스크롤 요소(날짜 입력 등)와 충돌하지 않게 한다.

   initSubtabSwipe(containerId, order, getCurrent, onSwitch)
     - containerId : 스와이프를 감지할 리스트 컨테이너의 id
     - order       : 서브탭 키들의 순서 배열 (예: ['time','unspecified','period'])
     - getCurrent() : 지금 선택된 서브탭 키를 반환
     - onSwitch(key) : 그 키로 전환하는 함수 (예: switchPlanSubtab)
   ========================================================= */
const SWIPE_THRESHOLD = 55; // px

function initSubtabSwipe(containerId, order, getCurrent, onSwitch) {
  const el = document.getElementById(containerId);
  if (!el) return;
  let startX = null, startY = null;

  el.addEventListener('touchstart', e => {
    if (e.touches.length !== 1) return;
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
  }, { passive: true });

  el.addEventListener('touchend', e => {
    if (startX === null) return;
    const touch = e.changedTouches[0];
    const dx = touch.clientX - startX;
    const dy = touch.clientY - startY;
    startX = null; startY = null;
    if (Math.abs(dx) < SWIPE_THRESHOLD) return; // 너무 짧은 움직임은 무시
    if (Math.abs(dx) < Math.abs(dy) * 1.5) return; // 세로 스크롤 의도일 가능성이 높으면 무시

    const idx = order.indexOf(getCurrent());
    if (idx === -1) return;
    if (dx < 0 && idx < order.length - 1) onSwitch(order[idx + 1]);   // 왼쪽으로 스와이프 → 다음 탭
    else if (dx > 0 && idx > 0) onSwitch(order[idx - 1]);              // 오른쪽으로 스와이프 → 이전 탭
  }, { passive: true });
}

const PLAN_SUBTAB_ORDER = ['time', 'unspecified', 'period'];
function initPlanSubtabSwipe() {
  initSubtabSwipe('planList', PLAN_SUBTAB_ORDER, () => currentPlanSubtab, switchPlanSubtab);
}

const WATCH_SUBTAB_ORDER = ['ongoing', 'planned', 'archive', 'list'];
function initWatchSubtabSwipe() {
  initSubtabSwipe('watchList', WATCH_SUBTAB_ORDER, () => currentWatchSubtab, switchWatchSubtab);
}

function togglePlanCounterFields() {
  document.getElementById('pfCounterFields').classList.toggle('hidden', selectedPlanProgress !== 'counter');
}

function openPlanAdd() {
  editPlanId = null;
  document.getElementById('planSheetTitle').textContent = '계획 추가';
  document.getElementById('pfName').value = '';
  document.getElementById('pfDesc').value = '';
  document.getElementById('pfTotal').value = '';
  document.getElementById('pfCurrent').value = '0';
  document.getElementById('pfDateStart').value = '';
  document.getElementById('pfDateEnd').value = '';
  document.getElementById('pfTimeStart').value = '';
  document.getElementById('pfTimeEnd').value = '';
  document.getElementById('pfCounterFields').classList.add('hidden');
  document.getElementById('pfTimeFields').classList.add('hidden');
  selectedPlanType = null; selectedPlanTimeMode = 'unspecified'; selectedPlanProgress = null;
  document.querySelectorAll('#pfTypeGroup .seg-btn, #pfTimeModeGroup .seg-btn, #pfProgressGroup .seg-btn').forEach(b => b.classList.remove('selected'));
  const defTimeBtn = document.querySelector('#pfTimeModeGroup .seg-btn[data-val="unspecified"]');
  if (defTimeBtn) defTimeBtn.classList.add('selected');
  document.getElementById('planFormOverlay').classList.add('open');
  setTimeout(() => document.getElementById('pfName').focus(), 80);
}

function openPlanEdit(id) {
  const p = planBlocks.find(x => x.id === id);
  if (!p) return;
  editPlanId = id;
  document.getElementById('planSheetTitle').textContent = '계획 수정';
  document.getElementById('pfName').value = p.name;
  document.getElementById('pfDesc').value = p.desc || '';
  selectedPlanType = p.type;
  selectedPlanTimeMode = p.timeUnspecified ? 'unspecified' : 'specified';
  selectedPlanProgress = p.progressType;

  document.querySelectorAll('#pfTypeGroup .seg-btn').forEach(btn => btn.classList.toggle('selected', btn.dataset.val === p.type));
  document.querySelectorAll('#pfTimeModeGroup .seg-btn').forEach(btn => btn.classList.toggle('selected', btn.dataset.val === selectedPlanTimeMode));
  document.querySelectorAll('#pfProgressGroup .seg-btn').forEach(btn => btn.classList.toggle('selected', btn.dataset.val === p.progressType));

  document.getElementById('pfTimeFields').classList.toggle('hidden', selectedPlanTimeMode !== 'specified');
  document.getElementById('pfDateStart').value = p.dateStart || '';
  document.getElementById('pfDateEnd').value = p.dateEnd || '';
  document.getElementById('pfTimeStart').value = p.timeStart || '';
  document.getElementById('pfTimeEnd').value = p.timeEnd || '';

  if (p.progressType === 'counter') {
    document.getElementById('pfCounterFields').classList.remove('hidden');
    document.getElementById('pfTotal').value = p.total || '';
    document.getElementById('pfCurrent').value = p.current || 0;
  } else {
    document.getElementById('pfCounterFields').classList.add('hidden');
  }

  document.getElementById('planFormOverlay').classList.add('open');
  setTimeout(() => document.getElementById('pfName').focus(), 80);
}

function submitPlanForm() {
  const name = document.getElementById('pfName').value.trim();
  const desc = document.getElementById('pfDesc').value.trim();
  if (!name) { document.getElementById('pfName').focus(); return; }
  if (!selectedPlanType) { showToast('유형을 선택해주세요'); return; }
  if (!selectedPlanProgress) { showToast('진행 체크 방식을 선택해주세요'); return; }

  const timeUnspecified = selectedPlanTimeMode !== 'specified';
  const dateStart = timeUnspecified ? '' : document.getElementById('pfDateStart').value;
  const dateEnd = timeUnspecified ? '' : document.getElementById('pfDateEnd').value;
  const timeStart = timeUnspecified ? '' : document.getElementById('pfTimeStart').value;
  const timeEnd = timeUnspecified ? '' : document.getElementById('pfTimeEnd').value;

  let total = null, current = null;
  if (selectedPlanProgress === 'counter') {
    total = parseInt(document.getElementById('pfTotal').value);
    current = parseInt(document.getElementById('pfCurrent').value) || 0;
    if (!total || total < 1) { document.getElementById('pfTotal').focus(); return; }
    current = Math.max(0, Math.min(total, current));
  }

  if (editPlanId !== null) {
    const p = planBlocks.find(x => x.id === editPlanId);
    if (p) {
      p.name = name; p.desc = desc; p.type = selectedPlanType; p.progressType = selectedPlanProgress;
      p.timeUnspecified = timeUnspecified; p.dateStart = dateStart; p.dateEnd = dateEnd;
      p.timeStart = timeStart; p.timeEnd = timeEnd;
      if (selectedPlanProgress === 'counter') { p.total = total; p.current = current; }
      else if (selectedPlanProgress === 'toggle') { if (p.done === undefined) p.done = false; }
    }
  } else {
    const plan = {
      id: Date.now() + Math.floor(Math.random()*1000),
      name, desc, type: selectedPlanType, progressType: selectedPlanProgress,
      timeUnspecified, dateStart, dateEnd, timeStart, timeEnd,
      order: planBlocks.length
    };
    if (selectedPlanProgress === 'counter') { plan.total = total; plan.current = current; }
    if (selectedPlanProgress === 'toggle') { plan.done = false; }
    planBlocks.push(plan);
  }

  savePlanBlocks(); renderPlanList(); closeOverlay('planFormOverlay');
}

function askDeletePlan(id) {
  const p = planBlocks.find(x => x.id === id);
  if (!p) return;
  deletePlanId = id;
  document.getElementById('confirmMsg').innerHTML = `<strong>${esc(p.name)}</strong> 계획을 삭제할까요?<br>이 작업은 되돌릴 수 없어요.`;
  document.getElementById('confirmOkBtn').onclick = () => {
    planBlocks = planBlocks.filter(x => x.id !== deletePlanId);
    savePlanBlocks(); renderPlanList(); closeOverlay('confirmOverlay');
    // 기간계획에서 이 블록을 참조하고 있었다면 화면에는 "참조 삭제됨"으로 자동 반영됨 (renderPeriodList에서 처리)
  };
  document.getElementById('confirmOverlay').classList.add('open');
}

function changePlanCounter(id, delta) {
  const p = planBlocks.find(x => x.id === id);
  if (!p) return;
  p.current = Math.max(0, Math.min(p.total, p.current + delta));
  savePlanBlocks(); renderPlanList();
}

function togglePlanDone(id) {
  const p = planBlocks.find(x => x.id === id);
  if (!p) return;
  p.done = !p.done;
  savePlanBlocks(); renderPlanList();
}

function planProgressFraction(p) {
  if (p.progressType === 'counter') return p.total > 0 ? p.current / p.total : 0;
  if (p.progressType === 'toggle') return p.done ? 1 : 0;
  return null;
}
function isPlanComplete(p) {
  if (p.progressType === 'counter') return p.current >= p.total;
  if (p.progressType === 'toggle') return !!p.done;
  return false;
}

function planTimeRangeLabel(p) {
  if (p.timeUnspecified) return '';
  const parts = [];
  if (p.dateStart) {
    let dateStr = p.dateStart;
    if (p.dateEnd && p.dateEnd !== p.dateStart) dateStr += ` ~ ${p.dateEnd}`;
    parts.push(dateStr);
  }
  if (p.timeStart) {
    let timeStr = p.timeStart;
    if (p.timeEnd && p.timeEnd !== p.timeStart) timeStr += `~${p.timeEnd}`;
    parts.push(timeStr);
  }
  return parts.join(' · ');
}

// "시간순" 서브탭 정렬 기준 키 (날짜 없으면 맨 뒤로)
function planSortKey(p) {
  const datePart = p.dateStart || '9999-99-99';
  const timePart = p.timeStart || '99:99';
  return `${datePart} ${timePart}`;
}

// 현재 서브탭에서 보여지는 리스트(time 또는 unspecified)를 다시 계산해 반환.
// 인라인 onclick에 큰 배열을 직접 박아넣는 대신, 매번 같은 정렬 로직으로 재계산해
// 인덱스만 주고받는 게 더 가볍고 안전하다.
function getCurrentPlanSubtabList() {
  let list = currentPlanSubtab === 'unspecified'
    ? planBlocks.filter(p => p.timeUnspecified)
    : planBlocks.filter(p => !p.timeUnspecified);
  if (currentPlanSubtab === 'time') {
    list = list.slice().sort((a, b) => planSortKey(a).localeCompare(planSortKey(b)));
  } else {
    list = list.slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  }
  return list;
}

function movePlanByIndex(idx, dir) {
  const list = getCurrentPlanSubtabList();
  const target = idx + dir;
  if (target < 0 || target >= list.length) return;
  const a = list[idx], b = list[target];
  const tmp = a.order ?? 0; a.order = b.order ?? 0; b.order = tmp;
  savePlanBlocks();
  renderPlanList();
}

function renderPlanList() {
  const el = document.getElementById('planList');

  if (currentPlanSubtab === 'period') {
    renderPeriodList(el);
    return;
  }

  let list = getCurrentPlanSubtabList();

  if (!list.length) {
    el.innerHTML = `<div class="empty">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><rect x="3" y="3" width="18" height="18" rx="3"/><line x1="9" y1="3" x2="9" y2="21"/></svg>
      <p>${currentPlanSubtab === 'unspecified' ? '시간 미지정 계획이 없어요' : '계획을 추가해보세요'}</p>
    </div>`;
    return;
  }

  el.innerHTML = list.map((p, idx) => {
    const complete = isPlanComplete(p);
    let progressHtml = '';
    if (p.progressType === 'counter') {
      const pct = p.total > 0 ? Math.round(p.current / p.total * 100) : 0;
      const atMin = p.current <= 0, atMax = p.current >= p.total;
      progressHtml = `<div class="block-progress-row">
        <button class="ctrl-btn" style="width:32px;height:32px;font-size:18px;" onclick="changePlanCounter(${p.id},-1)" ${atMin?'disabled':''} aria-label="감소">−</button>
        <div class="fraction" style="font-size:18px;min-width:54px;">${p.current}<span style="font-size:13px;">/${p.total}</span></div>
        <button class="ctrl-btn" style="width:32px;height:32px;font-size:18px;" onclick="changePlanCounter(${p.id},1)" ${atMax?'disabled':''} aria-label="증가">+</button>
        <span class="counter-pct">${pct}%</span>
        <div class="prog-wrap"><div class="prog-bar"><div class="prog-fill" style="width:${pct}%"></div></div></div>
      </div>`;
    } else if (p.progressType === 'toggle') {
      progressHtml = `<div class="block-progress-row">
        <button class="toggle-check ${p.done?'done':''}" onclick="togglePlanDone(${p.id})" aria-label="완료 토글">
          <svg viewBox="0 0 24 24" fill="none" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
        </button>
        <span class="toggle-label">${p.done ? '완료' : '미완료'}</span>
      </div>`;
    }
    const timeStr = planTimeRangeLabel(p);
    return `<div class="card block-card type-${p.type} ${complete && p.progressType!=='none' ? 'completed':''}" data-id="${p.id}">
      <div class="reorder-handle ${currentPlanSubtab === 'time' ? 'reorder-handle-disabled' : ''}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
      </div>
      <div class="card-main">
        <div class="card-header">
          <div class="card-title-wrap">
            <div class="card-title">${esc(p.name)}</div>
            <div class="card-sub"><span class="type-chip">${TYPE_LABEL[p.type]}</span>${timeStr ? `<span class="time-chip">${esc(timeStr)}</span>` : ''}</div>
          </div>
          <div class="card-btns">
            <button class="icon-btn" onclick="openImportPopup(${p.id})" aria-label="할일로 보내기">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>
            </button>
            <button class="icon-btn" onclick="openPlanEdit(${p.id})" aria-label="수정">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            </button>
            <button class="icon-btn" onclick="askDeletePlan(${p.id})" aria-label="삭제">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
            </button>
          </div>
          <div class="move-btns ${currentPlanSubtab === 'time' ? 'move-btns-disabled-for-sort' : ''}">
            <button class="move-btn" onclick="movePlanByIndex(${idx},-1)" ${idx===0 || currentPlanSubtab==='time'?'disabled':''} aria-label="위로"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg></button>
            <button class="move-btn" onclick="movePlanByIndex(${idx},1)" ${idx===list.length-1 || currentPlanSubtab==='time'?'disabled':''} aria-label="아래로"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg></button>
          </div>
        </div>
        ${p.desc ? `<div class="block-desc">${escLinkify(p.desc, 32)}</div>` : ''}
        ${progressHtml}
      </div>
    </div>`;
  }).join('');

  // 시간순(time) 서브탭은 시작 시각으로 자동 정렬되므로 드래그로 순서를 바꿀 수 없다.
  // 시간미지정(unspecified) 서브탭만 order 필드를 화면에 보이는 순서대로 다시 매겨서 저장한다.
  if (currentPlanSubtab !== 'time') {
    registerDragReorder('planList',
      () => list,
      (fromIdx, toIdx) => {
        const order = list.slice();
        const [moved] = order.splice(fromIdx, 1);
        order.splice(toIdx, 0, moved);
        order.forEach((p, i) => { p.order = i; });
        savePlanBlocks();
        renderPlanList();
      }
    );
  } else {
    delete dragReorderConfigs['planList']; // time 서브탭에서는 드래그 비활성 (reorder-handle도 disabled 표시됨)
  }
}

/* ---------- 가져오기 (계획 → 할일) ---------- */
function openImportPopup(planId) {
  importPlanId = planId;
  const today = new Date(appNow());
  document.getElementById('importDateInput').value = formatKey(today);
  document.getElementById('importPopupOverlay').classList.add('open');
}

function sendPlanToDate(mode) {
  const p = planBlocks.find(x => x.id === importPlanId);
  if (!p) return;

  let targetKey;
  if (mode === 'today') targetKey = TODAY_KEY();
  else if (mode === 'tomorrow') targetKey = addDaysToKey(TODAY_KEY(), 1);
  else {
    const v = document.getElementById('importDateInput').value;
    if (!v) { showToast('날짜를 선택해주세요'); return; }
    targetKey = v;
  }

  const day = ensureDay(targetKey);
  const newBlock = {
    id: Date.now() + Math.floor(Math.random()*1000),
    name: p.name, desc: p.desc || '', type: p.type === 'unspecified' ? 'todo' : p.type,
    time: p.timeUnspecified ? 'none' : (p.timeStart ? 'custom' : 'none'),
    customTime: p.timeStart || '',
    progressType: p.progressType, sessions: []
  };
  if (p.progressType === 'counter') { newBlock.total = p.total; newBlock.current = p.current; }
  if (p.progressType === 'toggle') { newBlock.done = p.done || false; }
  if (newBlock.type === 'routine') {
    // 루틴으로 보내지는 경우 매일(기본) 주기의 새 이월 체인을 시작한다
    newBlock.intervalDays = 1;
    newBlock.routineAnchorKey = targetKey;
    newBlock.carryover = true;
    newBlock.carryoverId = 'c' + Date.now() + Math.floor(Math.random()*1000);
    carryoverMeta[newBlock.carryoverId] = { stopped: false };
    saveCarryoverMeta();
  }
  day.blocks.push(newBlock);
  saveDays();

  // 계획 탭에서는 사라진다. 단, 기간계획이 이 블록을 참조하고 있었다면 참조가
  // 끊어지므로(원본이 없어짐) renderPeriodList에서 "삭제됨"으로 표시된다.
  planBlocks = planBlocks.filter(x => x.id !== importPlanId);
  savePlanBlocks();

  if (viewingDateKey === targetKey) renderBlocks();
  renderPlanList();
  closeOverlay('importPopupOverlay');
  showToast(`${targetKey === TODAY_KEY() ? '오늘' : targetKey}의 할일로 보냈어요`);
}

/* =========================================================
   PERIOD PLAN
   ========================================================= */
function onPeriodModeChanged() {
  document.getElementById('ppMonthField').classList.toggle('hidden', selectedPeriodMode !== 'month');
  document.getElementById('ppWeekField').classList.toggle('hidden', selectedPeriodMode !== 'week');
  document.getElementById('ppRangeField').classList.toggle('hidden', selectedPeriodMode !== 'range');
}

function isoWeekToDateRange(weekStr) {
  // weekStr 형식: "2026-W23"
  const [yearStr, weekPart] = weekStr.split('-W');
  const year = parseInt(yearStr), week = parseInt(weekPart);
  const jan4 = new Date(year, 0, 4);
  const jan4Day = jan4.getDay() || 7;
  const monday = new Date(jan4);
  monday.setDate(jan4.getDate() - jan4Day + 1 + (week - 1) * 7);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  return { start: formatKey(monday), end: formatKey(sunday) };
}

function monthToDateRange(monthStr) {
  // monthStr 형식: "2026-06"
  const [year, month] = monthStr.split('-').map(Number);
  const start = new Date(year, month - 1, 1);
  const end = new Date(year, month, 0); // 그 달의 마지막 날
  return { start: formatKey(start), end: formatKey(end) };
}

function openPeriodPlanAdd() {
  editPeriodId = null;
  document.getElementById('periodSheetTitle').textContent = '기간계획 추가';
  document.getElementById('ppDesc').value = '';
  document.getElementById('ppMonthInput').value = '';
  document.getElementById('ppWeekInput').value = '';
  document.getElementById('ppRangeStart').value = '';
  document.getElementById('ppRangeEnd').value = '';
  selectedPeriodMode = null;
  pendingPeriodRefs = [];
  document.querySelectorAll('#ppModeGroup .seg-btn').forEach(b => b.classList.remove('selected'));
  document.getElementById('ppMonthField').classList.add('hidden');
  document.getElementById('ppWeekField').classList.add('hidden');
  document.getElementById('ppRangeField').classList.add('hidden');
  renderPendingRefList();
  document.getElementById('periodFormOverlay').classList.add('open');
}

function openPeriodPlanEdit(id) {
  const pp = periodPlans.find(x => x.id === id);
  if (!pp) return;
  editPeriodId = id;
  document.getElementById('periodSheetTitle').textContent = '기간계획 수정';
  document.getElementById('ppDesc').value = pp.desc || '';
  selectedPeriodMode = pp.mode;
  pendingPeriodRefs = (pp.refs || []).slice();

  document.querySelectorAll('#ppModeGroup .seg-btn').forEach(btn => btn.classList.toggle('selected', btn.dataset.val === pp.mode));
  document.getElementById('ppMonthField').classList.toggle('hidden', pp.mode !== 'month');
  document.getElementById('ppWeekField').classList.toggle('hidden', pp.mode !== 'week');
  document.getElementById('ppRangeField').classList.toggle('hidden', pp.mode !== 'range');

  if (pp.mode === 'month') document.getElementById('ppMonthInput').value = pp.dateStart ? pp.dateStart.slice(0,7) : '';
  if (pp.mode === 'range') { document.getElementById('ppRangeStart').value = pp.dateStart || ''; document.getElementById('ppRangeEnd').value = pp.dateEnd || ''; }
  // week input 값(YYYY-Www)은 역산이 번거로워 비워두고 날짜 범위만 유지 — 모드 유지 시 재선택 없이 저장 가능

  renderPendingRefList();
  document.getElementById('periodFormOverlay').classList.add('open');
}

function submitPeriodForm() {
  const desc = document.getElementById('ppDesc').value.trim();
  if (!selectedPeriodMode) { showToast('기간 종류를 선택해주세요'); return; }

  let dateStart = '', dateEnd = '';
  if (selectedPeriodMode === 'month') {
    const v = document.getElementById('ppMonthInput').value;
    if (!v) { showToast('월을 선택해주세요'); return; }
    const r = monthToDateRange(v);
    dateStart = r.start; dateEnd = r.end;
  } else if (selectedPeriodMode === 'week') {
    const v = document.getElementById('ppWeekInput').value;
    if (v) {
      const r = isoWeekToDateRange(v);
      dateStart = r.start; dateEnd = r.end;
    } else if (editPeriodId !== null) {
      // 수정 시 주를 다시 고르지 않았다면 기존 값 유지
      const existing = periodPlans.find(x => x.id === editPeriodId);
      if (existing) { dateStart = existing.dateStart; dateEnd = existing.dateEnd; }
    } else {
      showToast('주를 선택해주세요'); return;
    }
  } else if (selectedPeriodMode === 'range') {
    dateStart = document.getElementById('ppRangeStart').value;
    dateEnd = document.getElementById('ppRangeEnd').value;
    if (!dateStart || !dateEnd) { showToast('시작일과 종료일을 모두 선택해주세요'); return; }
  }

  if (editPeriodId !== null) {
    const pp = periodPlans.find(x => x.id === editPeriodId);
    if (pp) { pp.mode = selectedPeriodMode; pp.dateStart = dateStart; pp.dateEnd = dateEnd; pp.desc = desc; pp.refs = pendingPeriodRefs.slice(); }
  } else {
    periodPlans.push({
      id: Date.now() + Math.floor(Math.random()*1000),
      mode: selectedPeriodMode, dateStart, dateEnd, desc,
      refs: pendingPeriodRefs.slice(), order: periodPlans.length
    });
  }

  savePeriodPlans(); renderPlanList(); closeOverlay('periodFormOverlay');
}

function askDeletePeriod(id) {
  const pp = periodPlans.find(x => x.id === id);
  if (!pp) return;
  deletePlanId = id;
  document.getElementById('confirmMsg').innerHTML = `이 기간계획을 삭제할까요?<br>참조된 블록들은 삭제되지 않아요.`;
  document.getElementById('confirmOkBtn').onclick = () => {
    periodPlans = periodPlans.filter(x => x.id !== deletePlanId);
    savePeriodPlans(); renderPlanList(); closeOverlay('confirmOverlay');
  };
  document.getElementById('confirmOverlay').classList.add('open');
}

function periodDateRangeLabel(pp) {
  if (pp.mode === 'month' && pp.dateStart) return pp.dateStart.slice(0,7).replace('-', '년 ') + '월';
  if (pp.dateStart && pp.dateEnd) return `${pp.dateStart} ~ ${pp.dateEnd}`;
  return pp.dateStart || '';
}

/* ---------- 참조 선택 (할일 블록 + 계획 블록을 가리키는 약한 참조) ---------- */
function openRefPicker() {
  renderRefPickerList();
  document.getElementById('refPickerOverlay').classList.add('open');
}

function resolveRef(ref) {
  // 참조가 가리키는 실제 블록을 찾아 반환. 없으면 null (삭제된 것으로 간주).
  if (ref.kind === 'plan') {
    const p = planBlocks.find(x => x.id === ref.id);
    return p ? { name: p.name, meta: TYPE_LABEL[p.type] } : null;
  } else if (ref.kind === 'todo') {
    const dayObj = days[ref.dateKey];
    const b = dayObj && dayObj.blocks.find(x => x.id === ref.id);
    return b ? { name: b.name, meta: `${TYPE_LABEL[b.type]} · ${ref.dateKey}` } : null;
  }
  return null;
}

function renderRefPickerList() {
  const el = document.getElementById('refPickerList');
  const items = [];

  planBlocks.forEach(p => {
    items.push({ kind: 'plan', id: p.id, dateKey: null, name: p.name, meta: `계획 · ${TYPE_LABEL[p.type]}` });
  });
  // 기간계획 참조는 계획 탭 블록만 허용

  if (!items.length) {
    el.innerHTML = `<div class="empty" style="height:auto;padding:30px 0;"><p>참조할 계획 블록이 없어요</p></div>`;
    return;
  }

  el.innerHTML = items.map(item => {
    const isSelected = pendingPeriodRefs.some(r => r.kind === item.kind && r.id === item.id && r.dateKey === item.dateKey);
    return `<div class="ref-picker-item ${isSelected?'selected':''}" onclick="toggleRefSelection('${item.kind}',${item.id},null)">
      <span>${esc(item.name)}</span>
      <span class="ref-picker-item-meta">${esc(item.meta)}</span>
    </div>`;
  }).join('');
}

function toggleRefSelection(kind, id, dateKey) {
  const idx = pendingPeriodRefs.findIndex(r => r.kind === kind && r.id === id && r.dateKey === dateKey);
  if (idx >= 0) pendingPeriodRefs.splice(idx, 1);
  else pendingPeriodRefs.push({ kind, id, dateKey, refDate: '', refDateEnd: '' });
  renderRefPickerList();
  renderPendingRefList();
}

function removePendingRef(idx) {
  pendingPeriodRefs.splice(idx, 1);
  renderPendingRefList();
}

function renderPendingRefList() {
  const el = document.getElementById('ppRefList');
  if (!pendingPeriodRefs.length) {
    el.innerHTML = `<div class="ref-item-missing" style="padding:6px 2px;">아직 참조한 블록이 없어요</div>`;
    return;
  }
  el.innerHTML = pendingPeriodRefs.map((ref, idx) => {
    const resolved = resolveRef(ref);
    const label = resolved ? resolved.name : '(삭제된 블록)';
    return `<div class="ref-item ref-item-col">
      <div class="ref-item-top">
        <span class="ref-item-name ${!resolved?'ref-item-missing':''}">${esc(label)}</span>
        <button class="ref-item-remove" onclick="removePendingRef(${idx})" aria-label="제거">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <div class="ref-item-dates">
        <input type="date" class="ref-date-input" placeholder="날짜" value="${ref.refDate||''}" onchange="updateRefDate(${idx},'refDate',this.value)">
        <span class="range-sep">~</span>
        <input type="date" class="ref-date-input" placeholder="종료(선택)" value="${ref.refDateEnd||''}" onchange="updateRefDate(${idx},'refDateEnd',this.value)">
      </div>
    </div>`;
  }).join('');
}

function updateRefDate(idx, field, value) {
  if (pendingPeriodRefs[idx]) pendingPeriodRefs[idx][field] = value;
}

/* =========================================================
   '목록' 탭 — 날짜와 무관하게 다른 감상 블록들을 참조로 묶어두는 카드.
   기간계획의 참조 방식과 같은 원리이지만, 날짜 범위 입력은 없다(그냥 포함 여부만).
   참조 대상은 오늘 날짜의 감상 블록 + 종료/예정 아카이브를 모두 포함한다.
   ========================================================= */
function resolveWatchRef(ref) {
  let item = null;
  if (ref.kind === 'ongoing') {
    const todayDay = days[TODAY_KEY()];
    item = todayDay && (todayDay.watchBlocks || []).find(x => x.id === ref.id);
  } else if (ref.kind === 'archive') {
    item = watchArchiveItems.find(x => x.id === ref.id);
  } else if (ref.kind === 'planned') {
    item = watchPlannedItems.find(x => x.id === ref.id);
  }
  return item ? { name: item.name, meta: `${WATCH_TYPE_LABEL[item.type]} · ${item.progress}%` } : null;
}

function openWatchRefPicker() {
  renderWatchRefPickerList();
  document.getElementById('watchRefPickerOverlay').classList.add('open');
}

function renderWatchRefPickerList() {
  const el = document.getElementById('watchRefPickerList');
  const items = [];
  const todayDay = days[TODAY_KEY()];
  (todayDay ? todayDay.watchBlocks || [] : []).forEach(w => {
    items.push({ kind: 'ongoing', id: w.id, name: w.name, meta: `감상 · ${WATCH_TYPE_LABEL[w.type]} · ${w.progress}%` });
  });
  watchPlannedItems.forEach(item => {
    items.push({ kind: 'planned', id: item.id, name: item.name, meta: `예정 · ${WATCH_TYPE_LABEL[item.type]}` });
  });
  watchArchiveItems.forEach(item => {
    items.push({ kind: 'archive', id: item.id, name: item.name, meta: `종료 · ${WATCH_TYPE_LABEL[item.type]}` });
  });

  if (!items.length) {
    el.innerHTML = `<div class="empty" style="height:auto;padding:30px 0;"><p>참조할 감상 블록이 없어요</p></div>`;
    return;
  }

  el.innerHTML = items.map(item => {
    const isSelected = pendingWatchListRefs.some(r => r.kind === item.kind && r.id === item.id);
    return `<div class="ref-picker-item ${isSelected?'selected':''}" onclick="toggleWatchRefSelection('${item.kind}',${item.id})">
      <span>${esc(item.name)}</span>
      <span class="ref-picker-item-meta">${esc(item.meta)}</span>
    </div>`;
  }).join('');
}

function toggleWatchRefSelection(kind, id) {
  const idx = pendingWatchListRefs.findIndex(r => r.kind === kind && r.id === id);
  if (idx >= 0) pendingWatchListRefs.splice(idx, 1);
  else pendingWatchListRefs.push({ kind, id });
  renderWatchRefPickerList();
  renderPendingWatchListRefs();
}

function removePendingWatchListRef(idx) {
  pendingWatchListRefs.splice(idx, 1);
  renderPendingWatchListRefs();
}

function renderPendingWatchListRefs() {
  const el = document.getElementById('wlRefList');
  if (!pendingWatchListRefs.length) {
    el.innerHTML = `<div class="ref-item-missing" style="padding:6px 2px;">아직 참조한 블록이 없어요</div>`;
    return;
  }
  el.innerHTML = pendingWatchListRefs.map((ref, idx) => {
    const resolved = resolveWatchRef(ref);
    const label = resolved ? resolved.name : '(삭제된 블록)';
    return `<div class="ref-item">
      <span class="ref-item-name ${!resolved?'ref-item-missing':''}">${esc(label)}</span>
      <button class="ref-item-remove" onclick="removePendingWatchListRef(${idx})" aria-label="제거">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>`;
  }).join('');
}

function openWatchListAdd() {
  editWatchListId = null;
  document.getElementById('watchListSheetTitle').textContent = '목록 추가';
  document.getElementById('wlName').value = '';
  document.getElementById('wlDesc').value = '';
  pendingWatchListRefs = [];
  renderPendingWatchListRefs();
  document.getElementById('watchListFormOverlay').classList.add('open');
  setTimeout(() => document.getElementById('wlName').focus(), 80);
}

function openWatchListEdit(id) {
  const wl = watchLists.find(x => x.id === id);
  if (!wl) return;
  editWatchListId = id;
  document.getElementById('watchListSheetTitle').textContent = '목록 수정';
  document.getElementById('wlName').value = wl.name;
  document.getElementById('wlDesc').value = wl.desc || '';
  pendingWatchListRefs = (wl.refs || []).slice();
  renderPendingWatchListRefs();
  document.getElementById('watchListFormOverlay').classList.add('open');
  setTimeout(() => document.getElementById('wlName').focus(), 80);
}

function submitWatchListForm() {
  const name = document.getElementById('wlName').value.trim();
  const desc = document.getElementById('wlDesc').value.trim();
  if (!name) { document.getElementById('wlName').focus(); return; }

  if (editWatchListId !== null) {
    const wl = watchLists.find(x => x.id === editWatchListId);
    if (wl) { wl.name = name; wl.desc = desc; wl.refs = pendingWatchListRefs.slice(); }
  } else {
    watchLists.push({
      id: Date.now() + Math.floor(Math.random()*1000),
      name, desc, refs: pendingWatchListRefs.slice(), order: watchLists.length
    });
  }
  saveWatchLists();
  renderWatchListTab();
  closeOverlay('watchListFormOverlay');
}

function askDeleteWatchList(id) {
  const wl = watchLists.find(x => x.id === id);
  if (!wl) return;
  deleteWatchListId = id;
  document.getElementById('confirmMsg').innerHTML = `<strong>${esc(wl.name)}</strong> 목록을 삭제할까요?<br>참조된 감상 블록들은 그대로 남아요.`;
  document.getElementById('confirmOkBtn').onclick = () => {
    watchLists = watchLists.filter(x => x.id !== deleteWatchListId);
    saveWatchLists();
    renderWatchListTab();
    closeOverlay('confirmOverlay');
  };
  document.getElementById('confirmOverlay').classList.add('open');
}

function moveWatchListItem(idx, dir) {
  const sorted = watchLists.slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const target = idx + dir;
  if (target < 0 || target >= sorted.length) return;
  [sorted[idx], sorted[target]] = [sorted[target], sorted[idx]];
  sorted.forEach((item, i) => { item.order = i; });
  saveWatchLists();
  renderWatchListTab();
}

function renderWatchListTab() {
  const el = document.getElementById('watchList');
  if (!watchLists.length) {
    el.innerHTML = `<div class="empty">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><rect x="3" y="4" width="18" height="16" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/></svg>
      <p>읽는 중인 책 현황처럼, 감상 블록들을 모아볼 목록을 만들어보세요</p>
    </div>`;
    return;
  }
  const sorted = watchLists.slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  el.innerHTML = sorted.map((wl, idx) => {
    const refs = (wl.refs || []).map(resolveWatchRef).filter(Boolean);
    const refsHtml = refs.length
      ? `<div class="ref-list" style="margin-top:8px;">${refs.map(r => `<div class="ref-item"><span class="ref-item-name">${esc(r.name)}</span><span class="ref-picker-item-meta">${esc(r.meta)}</span></div>`).join('')}</div>`
      : `<div class="ref-item-missing" style="margin-top:8px;">참조한 블록이 없어요</div>`;
    return `<div class="card block-card type-unspecified" data-id="${wl.id}">
      <div class="reorder-handle">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
      </div>
      <div class="card-main">
        <div class="card-header">
          <div class="card-title-wrap">
            <div class="card-title">${esc(wl.name)}</div>
          </div>
          <div class="card-btns">
            <button class="icon-btn" onclick="openWatchListEdit(${wl.id})" aria-label="수정">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            </button>
            <button class="icon-btn" onclick="askDeleteWatchList(${wl.id})" aria-label="삭제">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
            </button>
          </div>
          <div class="move-btns">
            <button class="move-btn" onclick="moveWatchListItem(${idx},-1)" ${idx===0?'disabled':''} aria-label="위로"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg></button>
            <button class="move-btn" onclick="moveWatchListItem(${idx},1)" ${idx===sorted.length-1?'disabled':''} aria-label="아래로"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg></button>
          </div>
        </div>
        ${wl.desc ? `<div class="block-desc">${escLinkify(wl.desc, 32)}</div>` : ''}
        ${refsHtml}
      </div>
    </div>`;
  }).join('');

  registerDragReorder('watchList',
    () => sorted,
    (fromIdx, toIdx) => {
      const order = sorted.slice();
      const [moved] = order.splice(fromIdx, 1);
      order.splice(toIdx, 0, moved);
      order.forEach((item, i) => { item.order = i; });
      saveWatchLists();
      renderWatchListTab();
    }
  );
}

function renderPeriodList(el) {
  const list = periodPlans.slice().sort((a, b) => (a.dateStart || '').localeCompare(b.dateStart || ''));
  if (!list.length) {
    el.innerHTML = `<div class="empty">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><rect x="3" y="4" width="18" height="16" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/></svg>
      <p>기간계획을 추가해보세요</p>
    </div>`;
    return;
  }
  el.innerHTML = list.map(pp => {
    // refs를 날짜순으로 정렬: 날짜 미지정 → 맨 앞, 날짜 지정 → 날짜순, 날짜 같으면 날짜(단일) > 날짜범위
    const sortedRefs = (pp.refs || []).slice().sort((a, b) => {
      const aDate = a.refDate || '';
      const bDate = b.refDate || '';
      if (!aDate && !bDate) return 0;
      if (!aDate) return -1;
      if (!bDate) return 1;
      if (aDate !== bDate) return aDate.localeCompare(bDate);
      // 날짜 같으면: refDateEnd 없는 게 우선 (단일 날짜 > 날짜범위)
      const aHasEnd = !!(a.refDateEnd);
      const bHasEnd = !!(b.refDateEnd);
      if (aHasEnd !== bHasEnd) return aHasEnd ? 1 : -1;
      return 0;
    });
    const refsHtml = sortedRefs.map(ref => {
      const resolved = resolveRef(ref);
      if (!resolved) return `<div class="period-ref-chip ref-missing">(삭제된 블록)</div>`;
      const dateLabel = ref.refDate ? (ref.refDateEnd ? `${ref.refDate} ~ ${ref.refDateEnd}` : ref.refDate) : '';
      return `<div class="period-ref-chip">
        <span class="ref-chip-name">${esc(resolved.name)}</span>
        ${dateLabel ? `<span class="ref-chip-date">${esc(dateLabel)}</span>` : ''}
      </div>`;
    }).join('');
    return `<div class="card period-card" data-id="${pp.id}">
      <div class="card-header">
        <div class="card-title-wrap">
          <div class="period-date-range">${esc(periodDateRangeLabel(pp))}</div>
          ${pp.desc ? `<div class="period-desc">${escLinkify(pp.desc, 32)}</div>` : ''}
        </div>
        <div class="card-btns">
          <button class="icon-btn" onclick="openPeriodPlanEdit(${pp.id})" aria-label="수정">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
          <button class="icon-btn" onclick="askDeletePeriod(${pp.id})" aria-label="삭제">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
          </button>
        </div>
      </div>
      ${refsHtml ? `<div class="period-ref-list">${refsHtml}</div>` : ''}
    </div>`;
  }).join('');
}

/* =========================================================
   WATCH (감상) PAGE
   ========================================================= */
function changeWatchDay(delta) {
  const d = keyToDate(viewingWatchDateKey);
  d.setDate(d.getDate() + delta);
  viewingWatchDateKey = formatKey(d);
  renderWatchHeader();
  renderWatchBlocks();
}

function jumpWatchToday() {
  viewingWatchDateKey = TODAY_KEY();
  renderWatchHeader();
  renderWatchBlocks();
}

const WATCH_SUBTAB_TITLE = { ongoing: '감상', planned: '예정', archive: '종료', list: '목록' };

function switchWatchSubtab(sub) {
  currentWatchSubtab = sub;
  WATCH_SUBTAB_ORDER.forEach(s => {
    document.getElementById(`watchSubtab-${s}`).classList.toggle('active', sub === s);
  });
  document.getElementById('watchPageBarTitle').textContent = WATCH_SUBTAB_TITLE[sub];
  // '감상' 서브탭만 날짜 단위로 보는 화면이라 날짜 바가 필요하고, 나머지 셋은 날짜와 무관한 아카이브.
  document.getElementById('watchDayBar').classList.toggle('hidden', sub !== 'ongoing');
  // '감상/예정/종료'는 같은 추가 폼(감상 추가)을 공유하고, '목록'만 별도의 추가 폼을 쓴다.
  document.getElementById('watchAddBtn').classList.toggle('hidden', sub === 'list');
  document.getElementById('watchListAddBtn').classList.toggle('hidden', sub !== 'list');
  updateReorderButtonVisibility();
  renderWatchBlocks();
}

function renderWatchHeader() {
  const today = TODAY_KEY();
  const d = keyToDate(viewingWatchDateKey);
  const isToday = viewingWatchDateKey === today;
  const weekday = ['일','월','화','수','목','금','토'][d.getDay()];
  document.getElementById('watchDayLabel').textContent = isToday ? '오늘' : `${d.getMonth()+1}월 ${d.getDate()}일 (${weekday})`;
  document.getElementById('watchDayDate').textContent = isToday ? `${d.getMonth()+1}월 ${d.getDate()}일 (${weekday})` : '';
  document.getElementById('watchTodayJumpBtn').classList.toggle('hidden', isToday);
}

function openWatchAdd() {
  editWatchId = null;
  editWatchArchiveKind = null;
  document.getElementById('watchSheetTitle').textContent = '감상 추가';
  document.getElementById('wfName').value = '';
  document.getElementById('wfAuthor').value = '';
  document.getElementById('wfProgress').value = '0';
  // '예정'/'종료' 서브탭에서 추가하면 그 상태로 바로 시작되게 한다 ('종료'는 보관 체크로 처리)
  document.getElementById('wfArchive').checked = (currentWatchSubtab === 'archive');
  document.getElementById('wfPlanned').checked = (currentWatchSubtab === 'planned');
  document.getElementById('wfPlannedField').classList.remove('hidden');
  document.getElementById('wfArchiveField').classList.remove('hidden');
  selectedWatchType = null;
  document.querySelectorAll('#wfTypeGroup .seg-btn').forEach(b => b.classList.remove('selected'));
  document.getElementById('watchFormOverlay').classList.add('open');
  setTimeout(() => document.getElementById('wfName').focus(), 80);
}

function openWatchEdit(id) {
  const day = ensureDay(viewingWatchDateKey);
  const w = day.watchBlocks.find(x => x.id === id);
  if (!w) return;
  editWatchId = id;
  editWatchArchiveKind = null;
  document.getElementById('watchSheetTitle').textContent = '감상 수정';
  document.getElementById('wfName').value = w.name;
  document.getElementById('wfAuthor').value = w.author || '';
  document.getElementById('wfProgress').value = w.progress;
  document.getElementById('wfArchive').checked = !!w.archived;
  document.getElementById('wfPlanned').checked = !!w.planned;
  document.getElementById('wfPlannedField').classList.remove('hidden');
  document.getElementById('wfArchiveField').classList.remove('hidden');
  selectedWatchType = w.type;
  document.querySelectorAll('#wfTypeGroup .seg-btn').forEach(btn => btn.classList.toggle('selected', btn.dataset.val === w.type));
  document.getElementById('watchFormOverlay').classList.add('open');
  setTimeout(() => document.getElementById('wfName').focus(), 80);
}

function submitWatchForm() {
  const name = document.getElementById('wfName').value.trim();
  const author = document.getElementById('wfAuthor').value.trim();
  let progress = parseInt(document.getElementById('wfProgress').value);
  const archived = document.getElementById('wfArchive').checked;
  const planned = document.getElementById('wfPlanned').checked;
  if (!name) { document.getElementById('wfName').focus(); return; }
  if (!selectedWatchType) { showToast('유형을 선택해주세요'); return; }
  if (isNaN(progress)) progress = 0;
  progress = Math.max(0, Math.min(100, progress));

  // '종료'/'예정' 탭에서 직접 연 수정 폼이면 오늘 원본이 아니라 해당 아카이브 항목을 고친다.
  if (editWatchArchiveKind !== null) {
    submitWatchArchiveItemEdit(name, author, progress, archived, planned);
    return;
  }

  const day = ensureDay(viewingWatchDateKey);

  let w;
  if (editWatchId !== null) {
    w = day.watchBlocks.find(x => x.id === editWatchId);
    if (w) {
      w.name = name; w.author = author; w.type = selectedWatchType;
      w.progress = progress; w.archived = archived; w.planned = planned;
      // 진행도/보관 상태가 바뀌면 이월 체인의 stopped 여부를 다시 맞춰준다.
      // (100% 또는 보관 중이면 멈춤, 둘 다 해제되면 다시 이월 대상으로 재개)
      if (w.watchChainId) {
        watchChainMeta[w.watchChainId] = { stopped: progress >= 100 || archived };
        saveWatchChainMeta();
      }
    }
  } else {
    const chainId = 'w' + Date.now() + Math.floor(Math.random()*1000);
    w = {
      id: Date.now() + Math.floor(Math.random()*1000),
      name, author, type: selectedWatchType, progress, archived, planned,
      watchChainId: chainId, memos: []
    };
    watchChainMeta[chainId] = { stopped: progress >= 100 || archived };
    saveWatchChainMeta();
    day.watchBlocks.push(w);
  }

  saveDays(); renderWatchBlocks(); renderScore(); closeOverlay('watchFormOverlay');
  if (w) syncWatchArchiveLink(w, viewingWatchDateKey);
}

// '종료'/'예정' 탭에서 직접 연 수정 폼 제출 처리.
// 아직 오늘 원본과 연결돼 있다면 원본도 같은 내용으로 같이 갱신해서 자연스럽게 동기화되게 한다.
function submitWatchArchiveItemEdit(name, author, progress, archived, planned) {
  const kind = editWatchArchiveKind;
  const store = getWatchArchiveStore(kind);
  const item = store.find(x => x.id === editWatchId);
  if (!item) { closeOverlay('watchFormOverlay'); return; }

  item.name = name; item.author = author; item.type = selectedWatchType; item.progress = progress;
  if (kind === 'archive') item.archived = archived;

  const isLinked = item.linkedWatchId !== null && item.linkedWatchId !== undefined;
  if (isLinked) {
    const todayDay = ensureDay(TODAY_KEY());
    const w = todayDay.watchBlocks.find(x => x.id === item.linkedWatchId);
    if (w) {
      w.name = name; w.author = author; w.type = selectedWatchType; w.progress = progress;
      if (kind === 'archive') w.archived = archived;
      if (kind === 'planned') w.planned = planned;
      if (w.watchChainId) {
        watchChainMeta[w.watchChainId] = { stopped: w.progress >= 100 || w.archived };
        saveWatchChainMeta();
      }
      saveDays();
      syncWatchArchiveLink(w, TODAY_KEY()); // 조건이 깨졌으면 이 함수가 store에서 알맞게 제거/갱신해줌
      renderWatchBlocks(); renderScore(); closeOverlay('watchFormOverlay');
      return;
    }
  }

  // 연결이 끊긴(자정을 넘긴) 독립 항목 — 자체적으로 조건을 다시 확인해서 안 맞으면 제거
  const stillQualifies = kind === 'archive' ? (progress >= 100 || archived) : planned;
  if (!stillQualifies) {
    if (kind === 'archive') { watchArchiveItems = watchArchiveItems.filter(x => x.id !== item.id); saveWatchArchiveItems(); }
    else { watchPlannedItems = watchPlannedItems.filter(x => x.id !== item.id); saveWatchPlannedItems(); }
  } else {
    saveWatchArchiveStore(kind);
  }
  renderWatchBlocks(); renderScore(); closeOverlay('watchFormOverlay');
}

function askDeleteWatch(id) {
  const day = ensureDay(viewingWatchDateKey);
  const w = day.watchBlocks.find(x => x.id === id);
  if (!w) return;
  deleteBlockId = id; // 재사용
  document.getElementById('confirmMsg').innerHTML = `<strong>${esc(w.name)}</strong> 감상을 삭제할까요?<br>더 이상 다음 날로 이어지지 않아요.`;
  document.getElementById('confirmOkBtn').onclick = () => {
    day.watchBlocks = day.watchBlocks.filter(x => x.id !== deleteBlockId);
    if (w.watchChainId) {
      watchChainMeta[w.watchChainId] = { stopped: true };
      saveWatchChainMeta();
    }
    // 오늘 원본과 아직 연결된(자정을 안 넘긴) 아카이브 복사본도 같이 삭제
    const beforeArchiveLen = watchArchiveItems.length, beforePlannedLen = watchPlannedItems.length;
    watchArchiveItems = watchArchiveItems.filter(x => x.linkedWatchId !== w.id);
    watchPlannedItems = watchPlannedItems.filter(x => x.linkedWatchId !== w.id);
    if (watchArchiveItems.length !== beforeArchiveLen) saveWatchArchiveItems();
    if (watchPlannedItems.length !== beforePlannedLen) saveWatchPlannedItems();
    saveDays(); renderWatchBlocks(); renderScore(); closeOverlay('confirmOverlay');
  };
  document.getElementById('confirmOverlay').classList.add('open');
}

function moveWatchBlock(idx, dir) {
  const day = ensureDay(viewingWatchDateKey);
  const target = idx + dir;
  if (target < 0 || target >= day.watchBlocks.length) return;
  [day.watchBlocks[idx], day.watchBlocks[target]] = [day.watchBlocks[target], day.watchBlocks[idx]];
  saveDays(); renderWatchBlocks();
}

function openWatchProgressEdit(id) {
  const day = ensureDay(viewingWatchDateKey);
  const w = day.watchBlocks.find(x => x.id === id);
  if (!w) return;
  progressEditWatchId = id;
  document.getElementById('watchProgressTitle').textContent = `${w.name} — 진행도 수정`;
  document.getElementById('wpProgressInput').value = w.progress;
  document.getElementById('watchProgressOverlay').classList.add('open');
  setTimeout(() => document.getElementById('wpProgressInput').focus(), 80);
}

function submitWatchProgress() {
  const day = ensureDay(viewingWatchDateKey);
  const w = day.watchBlocks.find(x => x.id === progressEditWatchId);
  if (!w) return;
  let val = parseInt(document.getElementById('wpProgressInput').value);
  if (isNaN(val)) val = 0;
  val = Math.max(0, Math.min(100, val));
  w.progress = val;
  if (val >= 100 && w.watchChainId) {
    watchChainMeta[w.watchChainId] = { stopped: true };
    saveWatchChainMeta();
  } else if (val < 100 && w.watchChainId && !w.archived) {
    // 100% 미만으로 되돌렸고 보관도 아니면 다시 이월 대상으로
    watchChainMeta[w.watchChainId] = { stopped: false };
    saveWatchChainMeta();
  }
  saveDays(); renderWatchBlocks(); renderScore(); closeOverlay('watchProgressOverlay');
  syncWatchArchiveLink(w, viewingWatchDateKey);
}

function toggleWatchArchive(id) {
  const day = ensureDay(viewingWatchDateKey);
  const w = day.watchBlocks.find(x => x.id === id);
  if (!w) return;
  w.archived = !w.archived;
  if (w.watchChainId) {
    watchChainMeta[w.watchChainId] = { stopped: w.archived || w.progress >= 100 };
    saveWatchChainMeta();
  }
  saveDays(); renderWatchBlocks(); renderScore();
  syncWatchArchiveLink(w, viewingWatchDateKey);
}

function toggleWatchPlanned(id) {
  const day = ensureDay(viewingWatchDateKey);
  const w = day.watchBlocks.find(x => x.id === id);
  if (!w) return;
  w.planned = !w.planned;
  saveDays(); renderWatchBlocks(); renderScore();
  syncWatchArchiveLink(w, viewingWatchDateKey);
}

/* =========================================================
   감상 '종료'/'예정' 아카이브 동기화
   오늘 날짜의 감상 블록 w가 종료 조건(progress>=100 또는 archived) 또는
   예정 조건(planned)을 만족하면 그 아카이브에 복사본을 만들고, 만족하는 동안은
   원본을 고칠 때마다 그 복사본도 같은 내용으로 갱신한다. 조건이 깨지면 복사본은
   삭제된다 (단, 이미 자정을 넘겨 독립된 복사본은 원본과 무관하므로 건드리지 않음).
   linkedWatchId가 있는 항목만 "오늘 원본과 연결된" 상태로 본다.
   ========================================================= */
function syncWatchArchiveLink(w, dateKey) {
  const isFinished = w.progress >= 100 || w.archived;
  const isPlanned = !!w.planned;

  // 종료 아카이브
  let archiveItem = watchArchiveItems.find(x => x.linkedWatchId === w.id);
  if (isFinished) {
    if (!archiveItem) {
      archiveItem = {
        id: Date.now() + Math.floor(Math.random()*100000),
        linkedWatchId: w.id, name: w.name, author: w.author, type: w.type,
        progress: w.progress, archived: w.archived,
        finishedDate: dateKey, memos: (w.memos || []).slice(),
        order: watchArchiveItems.length,
      };
      watchArchiveItems.push(archiveItem);
    } else {
      archiveItem.name = w.name; archiveItem.author = w.author; archiveItem.type = w.type;
      archiveItem.progress = w.progress; archiveItem.archived = w.archived;
      archiveItem.finishedDate = dateKey; archiveItem.memos = (w.memos || []).slice();
    }
    saveWatchArchiveItems();
  } else if (archiveItem) {
    // 조건이 깨졌는데 아직 오늘 원본과 연결된 상태라면(자정을 안 넘김) 복사본을 제거
    watchArchiveItems = watchArchiveItems.filter(x => x !== archiveItem);
    saveWatchArchiveItems();
  }

  // 예정 아카이브
  let plannedItem = watchPlannedItems.find(x => x.linkedWatchId === w.id);
  if (isPlanned) {
    if (!plannedItem) {
      plannedItem = {
        id: Date.now() + Math.floor(Math.random()*100000) + 1,
        linkedWatchId: w.id, name: w.name, author: w.author, type: w.type,
        progress: w.progress, memos: (w.memos || []).slice(),
        order: watchPlannedItems.length,
      };
      watchPlannedItems.push(plannedItem);
    } else {
      plannedItem.name = w.name; plannedItem.author = w.author; plannedItem.type = w.type;
      plannedItem.progress = w.progress; plannedItem.memos = (w.memos || []).slice();
    }
    saveWatchPlannedItems();
  } else if (plannedItem) {
    watchPlannedItems = watchPlannedItems.filter(x => x !== plannedItem);
    saveWatchPlannedItems();
  }
}

// 자정이 지나 날짜가 넘어갈 때 호출 — 그 시점까지 오늘 원본과 연결되어 있던 아카이브
// 항목들의 연결을 끊어서, 원본이 사라지거나 다음날로 이어지는 것과 무관하게 독립시킨다.
function detachWatchArchiveLinks() {
  let changed = false;
  watchArchiveItems.forEach(x => { if (x.linkedWatchId !== null && x.linkedWatchId !== undefined) { x.linkedWatchId = null; changed = true; } });
  watchPlannedItems.forEach(x => { if (x.linkedWatchId !== null && x.linkedWatchId !== undefined) { x.linkedWatchId = null; changed = true; } });
  if (changed) { saveWatchArchiveItems(); saveWatchPlannedItems(); }
}

// 전날 같은 체인의 블록을 찾아 오늘 대비 변화량(%p)을 계산. 없으면 null.
function watchDeltaForToday(w, dateKey) {
  if (!w.watchChainId) return null;
  const yKey = addDaysToKey(dateKey, -1);
  const yDay = days[yKey];
  if (!yDay || !yDay.watchBlocks) return null;
  const prev = yDay.watchBlocks.find(x => x.watchChainId === w.watchChainId);
  if (!prev) return null;
  return w.progress - prev.progress;
}

function renderWatchBlocks() {
  if (currentWatchSubtab === 'ongoing') renderWatchOngoing();
  else if (currentWatchSubtab === 'planned') renderWatchPlannedTab();
  else if (currentWatchSubtab === 'archive') renderWatchArchiveTab();
  else if (currentWatchSubtab === 'list') renderWatchListTab();
}

function renderWatchOngoing() {
  const day = ensureDay(viewingWatchDateKey);
  const el = document.getElementById('watchList');
  if (!day.watchBlocks.length) {
    el.innerHTML = `<div class="empty">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><rect x="4" y="3" width="16" height="18" rx="2"/><line x1="8" y1="8" x2="16" y2="8"/><line x1="8" y1="13" x2="16" y2="13"/></svg>
      <p>오늘 접한 콘텐츠를 추가해보세요</p>
    </div>`;
    return;
  }

  const withIdx = day.watchBlocks.map((w, realIdx) => ({ w, realIdx }));
  const sorted = withIdx.slice().sort((x, y) => {
    // 정렬 그룹: 0 = 진행 중(일반), 1 = 완료(100%), 2 = 예정 또는 보관(희미하게 맨 아래)
    const groupOf = (w) => (w.planned || w.archived) ? 2 : (w.progress >= 100 ? 1 : 0);
    const xGroup = groupOf(x.w), yGroup = groupOf(y.w);
    if (xGroup !== yGroup) return xGroup - yGroup;
    return x.realIdx - y.realIdx;
  });

  el.innerHTML = sorted.map(({ w, realIdx }) => {
    const idx = realIdx;
    const complete = w.progress >= 100;
    const faded = !!(w.planned || w.archived);
    const delta = watchDeltaForToday(w, viewingWatchDateKey);
    const deltaStr = (delta !== null && delta !== 0) ? `${delta > 0 ? '+' : ''}${delta}%p` : null;
    const memoCount = (w.memos || []).length;
    return `<div class="card watch-card type-watch-${w.type} ${complete ? 'completed' : ''} ${faded ? 'faded' : ''}" data-id="${w.id}">
      <div class="reorder-handle">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
      </div>
      <div class="card-main">
        <div class="card-header">
          <div class="card-title-wrap">
            <div class="card-title">${esc(w.name)}</div>
            <div class="card-sub"><span class="type-chip">${WATCH_TYPE_LABEL[w.type]}</span>${w.author ? `<span class="time-chip">${esc(w.author)}</span>` : ''}${w.planned ? '<span class="carryover-chip">예정</span>' : ''}${w.archived ? '<span class="carryover-chip">보관</span>' : ''}</div>
          </div>
          <div class="card-btns">
            <button class="timer-icon-btn ${memoCount > 0 ? 'has-time' : ''}" onclick="openWatchMemo(${w.id})" aria-label="감상 메모">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
            </button>
            <button class="icon-btn" onclick="openWatchEdit(${w.id})" aria-label="수정">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            </button>
            <button class="icon-btn" onclick="askDeleteWatch(${w.id})" aria-label="삭제">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
            </button>
          </div>
          <div class="move-btns">
            <button class="move-btn" onclick="moveWatchBlock(${idx},-1)" ${idx===0?'disabled':''} aria-label="위로"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg></button>
            <button class="move-btn" onclick="moveWatchBlock(${idx},1)" ${idx===day.watchBlocks.length-1?'disabled':''} aria-label="아래로"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg></button>
          </div>
        </div>
        <div class="block-progress-row">
          <button class="watch-progress-btn" onclick="openWatchProgressEdit(${w.id})">${w.progress}%</button>
          <div class="prog-wrap"><div class="prog-bar"><div class="prog-fill" style="width:${w.progress}%"></div></div></div>
          ${deltaStr ? `<span class="watch-delta-chip">${deltaStr}</span>` : ''}
        </div>
        <div class="field watch-flag-row" style="margin:8px 0 0;">
          <label class="carryover-label">
            <input type="checkbox" ${w.planned ? 'checked' : ''} onchange="toggleWatchPlanned(${w.id})">
            <span>예정</span>
          </label>
          <label class="carryover-label">
            <input type="checkbox" ${w.archived ? 'checked' : ''} onchange="toggleWatchArchive(${w.id})">
            <span>보관</span>
          </label>
        </div>
      </div>
    </div>`;
  }).join('');

  registerDragReorder('watchList',
    () => sorted.map(x => x.w),
    (fromIdx, toIdx) => {
      const order = sorted.map(x => x.w);
      const [moved] = order.splice(fromIdx, 1);
      order.splice(toIdx, 0, moved);
      day.watchBlocks = order;
      saveDays(); renderWatchBlocks();
    }
  );
}

/* =========================================================
   '종료' 탭 — 완료(100%) 또는 보관된 감상의 날짜-무관 아카이브.
   종료/보관된 날짜 기준 최근순으로 자동 정렬 (수동 정렬 없음).
   ========================================================= */
function renderWatchArchiveTab() {
  const el = document.getElementById('watchList');
  if (!watchArchiveItems.length) {
    el.innerHTML = `<div class="empty">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><rect x="4" y="3" width="16" height="18" rx="2"/><line x1="8" y1="8" x2="16" y2="8"/><line x1="8" y1="13" x2="16" y2="13"/></svg>
      <p>다 읽었거나 보관한 감상이 여기 모여요</p>
    </div>`;
    return;
  }
  const sorted = watchArchiveItems.slice().sort((a, b) => (b.finishedDate || '').localeCompare(a.finishedDate || ''));

  el.innerHTML = sorted.map(item => {
    const memoCount = (item.memos || []).length;
    return `<div class="card watch-card type-watch-${item.type}" data-id="${item.id}">
      <div class="card-main">
        <div class="card-header">
          <div class="card-title-wrap">
            <div class="card-title">${esc(item.name)}</div>
            <div class="card-sub"><span class="type-chip">${WATCH_TYPE_LABEL[item.type]}</span>${item.author ? `<span class="time-chip">${esc(item.author)}</span>` : ''}<span class="time-chip">${formatArchiveDateLabel(item.finishedDate)}</span>${item.archived ? '<span class="carryover-chip">보관</span>' : ''}</div>
          </div>
          <div class="card-btns">
            <button class="timer-icon-btn ${memoCount > 0 ? 'has-time' : ''}" onclick="openWatchArchiveMemo('archive',${item.id})" aria-label="감상 메모">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
            </button>
            <button class="icon-btn" onclick="openWatchArchiveEdit('archive',${item.id})" aria-label="수정">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            </button>
            <button class="icon-btn" onclick="askDeleteWatchArchiveItem('archive',${item.id})" aria-label="삭제">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
            </button>
          </div>
        </div>
        <div class="block-progress-row">
          <span class="watch-progress-btn" style="cursor:default;">${item.progress}%</span>
          <div class="prog-wrap"><div class="prog-bar"><div class="prog-fill" style="width:${item.progress}%"></div></div></div>
        </div>
      </div>
    </div>`;
  }).join('');
}

function formatArchiveDateLabel(dateKey) {
  if (!dateKey) return '';
  const d = keyToDate(dateKey);
  return `${d.getMonth()+1}/${d.getDate()} 종료`;
}

/* =========================================================
   '예정' 탭 — 예정 체크된 감상의 날짜-무관 아카이브. 할일 탭처럼 수동 정렬(화살표/드래그) 가능.
   ========================================================= */
function renderWatchPlannedTab() {
  const el = document.getElementById('watchList');
  if (!watchPlannedItems.length) {
    el.innerHTML = `<div class="empty">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><rect x="4" y="3" width="16" height="18" rx="2"/><line x1="8" y1="8" x2="16" y2="8"/><line x1="8" y1="13" x2="16" y2="13"/></svg>
      <p>예정으로 체크한 감상이 여기 모여요</p>
    </div>`;
    return;
  }
  const sorted = watchPlannedItems.slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  el.innerHTML = sorted.map((item, idx) => {
    const memoCount = (item.memos || []).length;
    return `<div class="card watch-card type-watch-${item.type}" data-id="${item.id}">
      <div class="reorder-handle">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
      </div>
      <div class="card-main">
        <div class="card-header">
          <div class="card-title-wrap">
            <div class="card-title">${esc(item.name)}</div>
            <div class="card-sub"><span class="type-chip">${WATCH_TYPE_LABEL[item.type]}</span>${item.author ? `<span class="time-chip">${esc(item.author)}</span>` : ''}</div>
          </div>
          <div class="card-btns">
            <button class="timer-icon-btn ${memoCount > 0 ? 'has-time' : ''}" onclick="openWatchArchiveMemo('planned',${item.id})" aria-label="감상 메모">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
            </button>
            <button class="icon-btn" onclick="openWatchArchiveEdit('planned',${item.id})" aria-label="수정">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            </button>
            <button class="icon-btn" onclick="askDeleteWatchArchiveItem('planned',${item.id})" aria-label="삭제">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
            </button>
          </div>
          <div class="move-btns">
            <button class="move-btn" onclick="moveWatchPlannedItem(${idx},-1)" ${idx===0?'disabled':''} aria-label="위로"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg></button>
            <button class="move-btn" onclick="moveWatchPlannedItem(${idx},1)" ${idx===sorted.length-1?'disabled':''} aria-label="아래로"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg></button>
          </div>
        </div>
        <div class="block-progress-row">
          <span class="watch-progress-btn" style="cursor:default;">${item.progress}%</span>
          <div class="prog-wrap"><div class="prog-bar"><div class="prog-fill" style="width:${item.progress}%"></div></div></div>
        </div>
      </div>
    </div>`;
  }).join('');

  registerDragReorder('watchList',
    () => sorted,
    (fromIdx, toIdx) => {
      const order = sorted.slice();
      const [moved] = order.splice(fromIdx, 1);
      order.splice(toIdx, 0, moved);
      order.forEach((item, i) => { item.order = i; });
      saveWatchPlannedItems();
      renderWatchPlannedTab();
    }
  );
}

function moveWatchPlannedItem(idx, dir) {
  const sorted = watchPlannedItems.slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const target = idx + dir;
  if (target < 0 || target >= sorted.length) return;
  [sorted[idx], sorted[target]] = [sorted[target], sorted[idx]];
  sorted.forEach((item, i) => { item.order = i; });
  saveWatchPlannedItems();
  renderWatchPlannedTab();
}

// '종료'/'예정' 아카이브 항목 공용 헬퍼들 (kind: 'archive' | 'planned')
function getWatchArchiveStore(kind) { return kind === 'archive' ? watchArchiveItems : watchPlannedItems; }
function saveWatchArchiveStore(kind) { if (kind === 'archive') saveWatchArchiveItems(); else saveWatchPlannedItems(); }

function openWatchArchiveMemo(kind, id) {
  const store = getWatchArchiveStore(kind);
  const item = store.find(x => x.id === id);
  if (!item) return;
  watchMemoTargetId = id;
  watchMemoTargetKind = kind;
  document.getElementById('watchMemoTitle').textContent = `${item.name} — 감상 메모`;
  renderWatchMemoList();
  document.getElementById('watchMemoOverlay').classList.add('open');
}

function openWatchArchiveEdit(kind, id) {
  const store = getWatchArchiveStore(kind);
  const item = store.find(x => x.id === id);
  if (!item) return;
  editWatchId = id;
  editWatchArchiveKind = kind;
  document.getElementById('watchSheetTitle').textContent = '감상 수정';
  document.getElementById('wfName').value = item.name;
  document.getElementById('wfAuthor').value = item.author || '';
  document.getElementById('wfProgress').value = item.progress;
  document.getElementById('wfArchive').checked = kind === 'archive' ? !!item.archived : false;
  document.getElementById('wfPlanned').checked = kind === 'planned';
  // 종료 탭에서 열었으면 '예정' 체크는 의미가 없고, 예정 탭에서 열었으면 '보관' 체크는 의미가 없다.
  document.getElementById('wfPlannedField').classList.toggle('hidden', kind === 'archive');
  document.getElementById('wfArchiveField').classList.toggle('hidden', kind === 'planned');
  selectedWatchType = item.type;
  document.querySelectorAll('#wfTypeGroup .seg-btn').forEach(btn => btn.classList.toggle('selected', btn.dataset.val === item.type));
  document.getElementById('watchFormOverlay').classList.add('open');
  setTimeout(() => document.getElementById('wfName').focus(), 80);
}

function askDeleteWatchArchiveItem(kind, id) {
  const store = getWatchArchiveStore(kind);
  const item = store.find(x => x.id === id);
  if (!item) return;
  const label = kind === 'archive' ? '종료' : '예정';
  const isLinked = item.linkedWatchId !== null && item.linkedWatchId !== undefined;
  if (isLinked) {
    // 오늘 원본과 아직 연결된 상태라면, 직접 지우는 대신 원본의 체크를 해제하도록 안내한다.
    // (자동으로 원본의 진행도/체크를 건드리면 의도와 다르게 동작할 수 있어 더 명확한 경로로 유도)
    showToast(`오늘 감상 탭에서 ${kind === 'archive' ? '보관 체크나 진행도를' : '예정 체크를'} 직접 해제해주세요`);
    return;
  }
  document.getElementById('confirmMsg').innerHTML = `<strong>${esc(item.name)}</strong>을 ${label} 목록에서 삭제할까요?<br>이 작업은 되돌릴 수 없어요.`;
  document.getElementById('confirmOkBtn').onclick = () => {
    if (kind === 'archive') {
      watchArchiveItems = watchArchiveItems.filter(x => x.id !== id);
      saveWatchArchiveItems();
    } else {
      watchPlannedItems = watchPlannedItems.filter(x => x.id !== id);
      saveWatchPlannedItems();
    }
    renderWatchBlocks();
    closeOverlay('confirmOverlay');
  };
  document.getElementById('confirmOverlay').classList.add('open');
}


function openWatchMemo(id) {
  watchMemoTargetId = id;
  watchMemoTargetKind = null;
  const found = findWatchById(id);
  if (!found) return;
  document.getElementById('watchMemoTitle').textContent = `${found.w.name} — 감상 메모`;
  renderWatchMemoList();
  document.getElementById('watchMemoOverlay').classList.add('open');
}

// watchMemoTargetKind가 설정돼 있으면(종료/예정 아카이브에서 연 메모) 그 저장소에서 찾고,
// 아니면(null) 오늘 날짜의 원본 감상 블록에서 찾는다.
function findWatchById(id) {
  if (watchMemoTargetKind === 'archive' || watchMemoTargetKind === 'planned') {
    const store = getWatchArchiveStore(watchMemoTargetKind);
    const item = store.find(x => x.id === id);
    return item ? { w: item, dateKey: null } : null;
  }
  for (const key of [viewingWatchDateKey]) {
    const dayObj = days[key];
    if (!dayObj) continue;
    const found = (dayObj.watchBlocks || []).find(x => x.id === id);
    if (found) return { w: found, dateKey: key };
  }
  return null;
}

function handleWatchMemoKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendWatchMemo();
  }
}

function sendWatchMemo() {
  const input = document.getElementById('watchMemoInput');
  const text = input.value.trim();
  if (!text) return;
  const found = findWatchById(watchMemoTargetId);
  if (!found) return;
  if (!found.w.memos) found.w.memos = [];
  found.w.memos.push({ id: Date.now() + Math.floor(Math.random()*1000), text, time: new Date().toISOString() });
  saveWatchMemoTarget();
  syncLinkedWatchMemos();
  input.value = '';
  input.style.height = 'auto';
  renderWatchMemoList();
}

// 메모가 어느 저장소(오늘 원본 / 종료 아카이브 / 예정 아카이브)에 속하는지에 맞춰 저장한다.
function saveWatchMemoTarget() {
  if (watchMemoTargetKind === 'archive') saveWatchArchiveItems();
  else if (watchMemoTargetKind === 'planned') saveWatchPlannedItems();
  else saveDays();
}

// 지금 메모를 추가/삭제한 대상이 아카이브 항목이고, 아직 오늘 원본과 연결돼 있다면
// (또는 반대로 오늘 원본에서 메모를 고쳤고 그 원본이 아카이브와 연결돼 있다면)
// 양쪽의 memos를 같은 내용으로 맞춰서 "그날 동안은 공유" 요구사항을 지킨다.
function syncLinkedWatchMemos() {
  if (watchMemoTargetKind === 'archive' || watchMemoTargetKind === 'planned') {
    const store = getWatchArchiveStore(watchMemoTargetKind);
    const item = store.find(x => x.id === watchMemoTargetId);
    if (!item || item.linkedWatchId === null || item.linkedWatchId === undefined) return;
    const todayDay = ensureDay(TODAY_KEY());
    const w = todayDay.watchBlocks.find(x => x.id === item.linkedWatchId);
    if (w) { w.memos = (item.memos || []).slice(); saveDays(); }
  } else {
    // 오늘 원본에서 메모를 고친 경우 — 연결된 아카이브 항목이 있으면 같이 맞춘다
    const day = ensureDay(viewingWatchDateKey);
    const w = day.watchBlocks.find(x => x.id === watchMemoTargetId);
    if (!w) return;
    const archiveItem = watchArchiveItems.find(x => x.linkedWatchId === w.id);
    if (archiveItem) { archiveItem.memos = (w.memos || []).slice(); saveWatchArchiveItems(); }
    const plannedItem = watchPlannedItems.find(x => x.linkedWatchId === w.id);
    if (plannedItem) { plannedItem.memos = (w.memos || []).slice(); saveWatchPlannedItems(); }
  }
}

function copyWatchMemo(memoId) {
  const found = findWatchById(watchMemoTargetId);
  if (!found) return;
  const m = (found.w.memos || []).find(x => x.id === memoId);
  if (!m) return;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(m.text).then(() => showToast('복사했어요')).catch(() => showToast('복사에 실패했어요'));
  } else {
    showToast('복사를 지원하지 않는 환경이에요');
  }
}

function deleteWatchMemo(memoId) {
  const found = findWatchById(watchMemoTargetId);
  if (!found) return;
  found.w.memos = (found.w.memos || []).filter(x => x.id !== memoId);
  saveWatchMemoTarget();
  syncLinkedWatchMemos();
  renderWatchMemoList();
}

function renderWatchMemoList() {
  const found = findWatchById(watchMemoTargetId);
  const el = document.getElementById('watchMemoList');
  const list = (found && found.w.memos) || [];
  if (!list.length) {
    el.innerHTML = `<div class="memo-empty">아직 메모가 없어요</div>`;
    return;
  }
  el.innerHTML = list.map(m => {
    const t = new Date(m.time);
    const timeStr = `${String(t.getHours()).padStart(2,'0')}:${String(t.getMinutes()).padStart(2,'0')}`;
    return `<div class="memo-bubble">
      <div class="memo-text">${escLinkify(m.text, 40)}</div>
      <div class="memo-meta-row">
        <span class="memo-time">${timeStr}</span>
        <button class="memo-copy-btn" onclick="copyWatchMemo(${m.id})">복사</button>
        <button class="memo-delete-btn" onclick="deleteWatchMemo(${m.id})">삭제</button>
      </div>
    </div>`;
  }).join('');
  el.scrollTop = el.scrollHeight;
}

/* ---------- 감상 자동 이월 (할일의 carryover 엔진과 같은 원리) ---------- */
function syncWatchForToday() {
  const todayKey = TODAY_KEY();
  const today = ensureDay(todayKey);
  const existingIds = new Set(today.watchBlocks.map(w => w.watchChainId));

  const activeIds = Object.keys(watchChainMeta).filter(cid => !watchChainMeta[cid].stopped);
  let addedCount = 0;

  activeIds.forEach(cid => {
    if (existingIds.has(cid)) return;

    let template = null;
    for (let i = 1; i <= 60; i++) {
      const k = addDaysToKey(todayKey, -i);
      const dayObj = days[k];
      if (!dayObj || !dayObj.watchBlocks) continue;
      const found = dayObj.watchBlocks.find(w => w.watchChainId === cid);
      if (found) { template = found; break; }
    }
    if (!template) return;

    // 100% 달성 또는 보관 체크된 항목은 이미 stopped 처리되어 여기 도달하지 않지만, 안전망으로 한 번 더 체크
    if (template.progress >= 100 || template.archived) {
      watchChainMeta[cid] = { stopped: true };
      saveWatchChainMeta();
      return;
    }

    const nb = { ...template, id: Date.now() + Math.floor(Math.random()*100000), memos: [] };
    today.watchBlocks.push(nb);
    addedCount++;
  });

  if (addedCount > 0) saveDays();
  return addedCount;
}

function dayWatchScoreFraction(day) {
  // 그날 감상 블록들의 평균 진행도(0~1)를 감상 항목의 점수로 사용.
  // "예정"으로 체크된 항목은 아직 시작 전이므로 평균 계산에서 제외한다.
  if (!day.watchBlocks || !day.watchBlocks.length) return null;
  const scorable = day.watchBlocks.filter(w => !w.planned);
  if (!scorable.length) return null;
  const sum = scorable.reduce((s, w) => s + (w.progress / 100), 0);
  return sum / scorable.length;
}

/* =========================================================
   AUTO-ROLLOVER (오전 4시 기준)
   ========================================================= */
// 마지막으로 "오늘"로 인식했던 날짜를 영구 저장해서, 페이지를 새로고침해도 자정을
// 실제로 넘겼는지(진짜 새 날인지)를 정확히 구분한다. 이게 없으면 같은 날 안에 새로고침할
// 때마다 detachWatchArchiveLinks 같은 "날짜가 바뀔 때만 해야 하는 작업"이 매번 실행되어 버린다.
let lastKnownTodayKey = localStorage.getItem('pc_last_known_today') || TODAY_KEY();
function saveLastKnownTodayKey() { localStorage.setItem('pc_last_known_today', lastKnownTodayKey); }

function checkMidnightRollover() {
  const today = TODAY_KEY();
  if (today !== lastKnownTodayKey) {
    lastKnownTodayKey = today;
    saveLastKnownTodayKey();
    // 어제 날짜가 마무리됐으므로 게임 포인트를 재계산
    reconcileGamePoints();
    if (currentTab === 'game') renderGamePoints();
    const added = syncCarryoversForToday();
    const watchAdded = syncWatchForToday();
    detachWatchArchiveLinks(); // 어제까지 연결되어 있던 종료/예정 복사본들을 독립시킴
    if (viewingDateKey === today) {
      renderBlocks();
      if (added > 0) showToast(`이어지는 블록 ${added}개가 오늘 목록에 추가됐어요`);
    }
    if (viewingWatchDateKey === today) renderWatchBlocks();
  }
  if (viewingDateKey === today) { renderDayHeader(); renderScore(); }
  if (viewingWatchDateKey === today) renderWatchHeader();
}
setInterval(checkMidnightRollover, 60 * 1000);

// 모바일 PWA는 백그라운드로 가면 setInterval이 멈추는 경우가 많다 (특히 iOS Safari).
// 며칠간 앱을 안 열어도, 탭이 다시 보이거나 포커스를 받는 순간 날짜 전환 체크를 즉시 한 번 더 실행해서
// 감상/할일 이월이 누락되지 않게 한다.
document.addEventListener('visibilitychange', () => { if (!document.hidden) checkMidnightRollover(); });
window.addEventListener('focus', checkMidnightRollover);
window.addEventListener('pageshow', checkMidnightRollover);

/* =========================================================
   GAME TAB — 누적 포인트
   ========================================================= */
// "마감된 날"이란 오늘(가상 오늘, 오전4시 기준)보다 이전인 모든 날짜를 말한다.
// 마감된 날은 더 이상 변동이 없을 거라 기대하지만, 사용자가 과거 기록을 수정/삭제하면
// 그 날의 점수가 바뀔 수 있다. 이 함수는 "이미 합산해둔 점수"와 "지금 다시 계산한 점수"를
// 비교해서 차이만큼 gamePoints를 보정하고, 합산 기록(gameAddedScores)을 갱신한다.
//
// 검사 대상 날짜는 (a) days에 실제 기록이 있는 날짜 + (b) 이전에 합산 기록이 있는 날짜의
// 합집합으로 한정한다 — 데이터가 전혀 없던 날짜까지 매번 훑을 필요는 없다.
function reconcileGamePoints() {
  const todayKey = TODAY_KEY();
  const candidateKeys = new Set([...Object.keys(days), ...Object.keys(gameAddedScores)]);
  let changed = false;

  candidateKeys.forEach(key => {
    if (key >= todayKey) return; // 오늘 또는 미래 날짜는 아직 마감되지 않음 — 건너뜀

    const data = computeDayScore(key);
    const newScore = (data && data.score !== null) ? data.score : 0;
    const oldScore = gameAddedScores[key];

    if (oldScore === undefined || oldScore !== newScore) {
      gamePoints += (newScore - (oldScore ?? 0));
      gameAddedScores[key] = newScore;
      changed = true;
    }
  });

  if (changed) {
    gamePoints = Math.max(0, gamePoints); // 음수로 내려가지 않게 안전망
    saveGamePoints();
  }
}

function renderGamePoints() {
  document.getElementById('gamePointsNum').textContent = Math.round(gamePoints).toLocaleString();
  renderGameLedger();
}

function renderGameLedger() {
  const el = document.getElementById('gameLedger');
  if (!el) return;
  if (!gameSpendLog.length) {
    el.innerHTML = `<div class="game-ledger-empty">소모 내역이 없어요</div>`;
    return;
  }
  // 최신 순으로 표시
  const sorted = gameSpendLog.slice().reverse();
  el.innerHTML = sorted.map(item => {
    const d = new Date(item.time);
    const dateStr = `${d.getFullYear()}.${String(d.getMonth()+1).padStart(2,'0')}.${String(d.getDate()).padStart(2,'0')}`;
    const timeStr = `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
    return `<div class="ledger-row">
      <div class="ledger-row-left">
        <div class="ledger-reason">${esc(item.reason)}</div>
        <div class="ledger-date">${dateStr} ${timeStr}</div>
      </div>
      <div class="ledger-amount">−${item.amount.toLocaleString()}</div>
    </div>`;
  }).join('');
}

function openSpendOverlay() {
  document.getElementById('spendAmount').value = '';
  document.getElementById('spendReason').value = '';
  document.getElementById('spendOverlay').classList.add('open');
  setTimeout(() => document.getElementById('spendAmount').focus(), 80);
}

function submitSpend() {
  const amount = parseInt(document.getElementById('spendAmount').value);
  const reason = document.getElementById('spendReason').value.trim();
  if (!amount || amount < 1) { document.getElementById('spendAmount').focus(); return; }
  if (!reason) { document.getElementById('spendReason').focus(); return; }
  if (amount > gamePoints) { showToast('보유 포인트보다 많이 소모할 수 없어요'); return; }
  gamePoints -= amount;
  gameSpendLog.push({ amount, reason, time: new Date().toISOString() });
  saveGamePoints();
  renderGamePoints();
  closeOverlay('spendOverlay');
  showToast(`${amount.toLocaleString()}포인트를 소모했어요`);
}

// 저장된 모든 날짜 기록을 처음부터 다시 훑어 누적 포인트를 재계산한다.
// 블록을 지우거나 수정해서 과거 점수가 달라졌을 때, 이미 더해진 포인트에는
// 자동으로 반영되지 않으므로 이 버튼으로 강제 재동기화한다.
// 수동 "다시 계산" 버튼용: 현재 모든 데이터를 기준으로 누적 포인트를 처음부터 다시 합산한다.
// (오늘은 아직 끝나지 않은 날이므로 제외한다.)
function recalcGamePoints() {
  const today = TODAY_KEY();
  let total = 0;
  const newAddedScores = {};
  const sortedKeys = Object.keys(days).sort(); // YYYY-MM-DD 문자열은 사전순 = 날짜순

  sortedKeys.forEach(key => {
    if (key >= today) return; // 오늘/미래는 아직 진행 중이므로 제외
    const data = computeDayScore(key);
    const score = (data && data.score !== null) ? data.score : 0;
    total += score;
    newAddedScores[key] = score;
  });

  gamePoints = Math.max(0, total);
  gameAddedScores = newAddedScores;
  saveGamePoints();
  renderGamePoints();
  showToast('현재 기록을 기준으로 누적 포인트를 다시 계산했어요');
}

/* =========================================================
   MEMO PAGE
   ========================================================= */
function changeMemoDay(delta) {
  const d = keyToDate(viewingMemoDateKey);
  d.setDate(d.getDate() + delta);
  viewingMemoDateKey = formatKey(d);
  renderMemoHeader();
  renderMemos();
}

function jumpMemoToday() {
  viewingMemoDateKey = TODAY_KEY();
  renderMemoHeader();
  renderMemos();
}

function renderMemoHeader() {
  const today = TODAY_KEY();
  const d = keyToDate(viewingMemoDateKey);
  const isToday = viewingMemoDateKey === today;
  const weekday = ['일','월','화','수','목','금','토'][d.getDay()];
  document.getElementById('memoDayLabel').textContent = isToday ? '오늘' : `${d.getMonth()+1}월 ${d.getDate()}일 (${weekday})`;
  document.getElementById('memoDayDate').textContent = isToday ? `${d.getMonth()+1}월 ${d.getDate()}일 (${weekday})` : '';
  document.getElementById('memoTodayJumpBtn').classList.toggle('hidden', isToday);
}

function autoGrowMemoInput(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(100, el.scrollHeight) + 'px';
}

function handleMemoKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMemo();
  }
}

function sendMemo() {
  const input = document.getElementById('memoInput');
  const text = input.value.trim();
  if (!text) return;
  if (!memos[viewingMemoDateKey]) memos[viewingMemoDateKey] = [];
  memos[viewingMemoDateKey].push({ id: Date.now() + Math.floor(Math.random()*1000), text, time: new Date().toISOString() });
  saveMemos();
  input.value = '';
  input.style.height = 'auto';
  renderMemos();
}

function copyMemo(id) {
  const list = memos[viewingMemoDateKey] || [];
  const m = list.find(x => x.id === id);
  if (!m) return;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(m.text).then(() => showToast('복사했어요')).catch(() => showToast('복사에 실패했어요'));
  } else {
    showToast('복사를 지원하지 않는 환경이에요');
  }
}

function deleteMemo(id) {
  if (!memos[viewingMemoDateKey]) return;
  memos[viewingMemoDateKey] = memos[viewingMemoDateKey].filter(x => x.id !== id);
  saveMemos();
  renderMemos();
}

function renderMemos() {
  const el = document.getElementById('memoList');
  const list = memos[viewingMemoDateKey] || [];
  if (!list.length) {
    el.innerHTML = `<div class="memo-empty">이 날의 메모가 없어요</div>`;
    return;
  }
  el.innerHTML = list.map(m => {
    const t = new Date(m.time);
    const timeStr = `${String(t.getHours()).padStart(2,'0')}:${String(t.getMinutes()).padStart(2,'0')}`;
    return `<div class="memo-bubble">
      <div class="memo-text">${escLinkify(m.text, 40)}</div>
      <div class="memo-meta-row">
        <span class="memo-time">${timeStr}</span>
        <button class="memo-copy-btn" onclick="copyMemo(${m.id})">복사</button>
        <button class="memo-delete-btn" onclick="deleteMemo(${m.id})">삭제</button>
      </div>
    </div>`;
  }).join('');
  el.scrollTop = el.scrollHeight;
}

/* =========================================================
   YESTERDAY FEEDBACK
   ========================================================= */
function computeDayScore(dayKey) {
  const day = days[dayKey];
  if (!day) return null;
  const result = computeDayScoreRaw(day, dayKey, blockDayFraction);
  return { score: result.score, maxScore: result.maxScore, blocks: day.blocks, watchBlocks: day.watchBlocks || [], totalFocusMs: result.totalFocusMs };
}

function openYesterdayFeedback() {
  document.getElementById('feedbackOverlay').classList.add('open');
  const body = document.getElementById('feedbackBody');
  const yKey = addDaysToKey(TODAY_KEY(), -1);
  const data = computeDayScore(yKey);

  const hasBlocks = data && data.blocks && data.blocks.length;
  const hasWatch = data && data.watchBlocks && data.watchBlocks.length;
  if (!data || (!hasBlocks && !hasWatch)) {
    body.innerHTML = `<span class="fb-loading">어제 기록이 없어요.</span>`;
    return;
  }

  const lines = [];
  lines.push(`어제(${yKey}) 달성 점수: ${data.score !== null ? data.score + (data.maxScore > 0 ? '/' + data.maxScore : '점') : '집계할 수 없음'}`);
  if (data.totalFocusMs > 0) lines.push(`집중시간: ${formatDurationShort(data.totalFocusMs)}`);
  if (hasBlocks) {
    lines.push('');
    lines.push('블록 요약:');
    data.blocks.forEach(b => {
      let line = `- ${b.name} (${TYPE_LABEL[b.type]})`;
      if (b.progressType === 'counter') {
        line += `: ${b.current}/${b.total}`;
        if (b.type === 'abstain' && isAbstainOverLimit(b)) line += ' · 상한 초과';
      } else if (b.progressType === 'toggle') line += `: ${b.done ? '완료' : '미완료'}`;
      else if (b.progressType === 'timer') {
        line += `: ${formatDurationShort(abstainTimerTotalMs(b))} / ${b.limitMinutes}분`;
        if (isAbstainOverLimit(b)) line += ' · 상한 초과';
      }
      lines.push(line);
    });
  }
  let watchSummaryLine = '';
  if (hasWatch) {
    lines.push('');
    lines.push('감상 요약:');
    data.watchBlocks.forEach(w => {
      lines.push(`- ${w.name} (${WATCH_TYPE_LABEL[w.type]}): ${w.progress}%${w.planned ? ' · 예정' : ''}${w.archived ? ' · 보관' : ''}`);
    });
    const names = data.watchBlocks.map(w => w.name).join(', ');
    watchSummaryLine = ` 그리고 ${names}${data.watchBlocks.length > 1 ? '를' : '을'} 접하며 감상 시간도 챙겼어요.`;
  }

  const score = data.score;
  // 절댓값 합산 점수는 100점 캡이 없으므로, 그날의 maxScore(다 채웠을 때 점수) 대비 비율로 피드백 톤을 정한다.
  const achievePct = (score !== null && data.maxScore > 0) ? (score / data.maxScore) * 100 : (score !== null ? (score > 0 ? 100 : 0) : null);
  let summary;
  if (score === null) summary = '어제는 진행 체크가 있는 블록이 없어서 점수를 매기긴 어렵지만, 기록을 남긴 것 자체로 의미가 있어요.';
  else if (achievePct >= 90) summary = `어제는 ${score}점으로 정말 알찬 하루였어요. 계획한 것들을 거의 다 해냈네요. 오늘도 이 흐름을 이어가 보세요.`;
  else if (achievePct >= 70) summary = `어제는 ${score}점으로 꽤 잘 보낸 하루였어요. 몇 가지가 남았지만 전반적으로 좋은 흐름이었어요.`;
  else if (achievePct >= 40) summary = `어제는 ${score}점으로 절반 정도 진행됐어요. 무리한 계획이었는지, 컨디션 문제였는지 한번 돌아보면 오늘 도움이 될 거예요.`;
  else if (score > 0) summary = `어제는 ${score}점으로 시작 단계에 머물렀어요. 괜찮아요, 오늘은 부담을 좀 줄여서 작은 것 하나부터 해보는 것도 방법이에요.`;
  else summary = '어제는 거의 진행되지 못한 하루였어요. 너무 자책하지 말고, 오늘 할 일을 좀 더 작은 단위로 쪼개보는 게 도움이 될 수 있어요.';
  summary += watchSummaryLine;

  body.innerHTML = `<div style="margin-bottom:14px;">${esc(summary)}</div><div style="font-size:12.5px;color:var(--gray-400);white-space:pre-wrap;">${esc(lines.join('\n'))}</div>`;
}

/* =========================================================
   THEME (다크모드) — 'system'은 prefers-color-scheme을 따르고,
   'light'/'dark'는 메뉴에서 수동으로 선택한 값을 강제 적용한다.
   ========================================================= */
function applyTheme() {
  document.documentElement.classList.remove('theme-light', 'theme-dark');
  if (themePref === 'light') document.documentElement.classList.add('theme-light');
  else if (themePref === 'dark') document.documentElement.classList.add('theme-dark');
  // 'system'이면 클래스를 안 붙여서 CSS의 prefers-color-scheme 미디어쿼리가 그대로 적용됨

  // PWA 상단 상태바 색도 실제 배경(--white 변수)에 맞춰 갱신
  const isDark = themePref === 'dark' || (themePref === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  const themeColorMeta = document.querySelector('meta[name="theme-color"]');
  if (themeColorMeta) themeColorMeta.setAttribute('content', isDark ? '#1c1c1e' : '#ffffff');

  document.querySelectorAll('#themeSegGroup .seg-btn').forEach(b => b.classList.toggle('selected', b.dataset.val === themePref));
}

function selectTheme(pref) {
  themePref = pref;
  localStorage.setItem('pc_theme_pref', pref);
  applyTheme();
}

// 시스템 다크모드 설정이 바뀌는 경우(예: 야간에 자동 전환되는 OS 설정) 'system' 모드일 때 상태바 색을 같이 갱신
if (window.matchMedia) {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (themePref === 'system') applyTheme();
  });
}

/* =========================================================
   BACKUP / IMPORT / WEIGHTS
   ========================================================= */
function openMenu() {
  applyTheme();
  document.getElementById('wSchedule').value = weights.schedule;
  document.getElementById('wTodo').value = weights.todo;
  document.getElementById('wOnce').value = weights.once;
  document.getElementById('wLeisure').value = weights.leisure;
  document.getElementById('wRoutine').value = weights.routine ?? 8;
  document.getElementById('wFocus').value = weights.focus ?? 6;
  document.getElementById('wWatch').value = weights.watch ?? 3;
  document.getElementById('wUnspecified').value = weights.unspecified ?? 5;
  document.getElementById('wAbstain').value = weights.abstain ?? 5;
  document.getElementById('menuOverlay').classList.add('open');
}

function saveMenuSettings() {
  weights = {
    schedule: parseFloat(document.getElementById('wSchedule').value) || 0,
    todo: parseFloat(document.getElementById('wTodo').value) || 0,
    once: parseFloat(document.getElementById('wOnce').value) || 0,
    leisure: parseFloat(document.getElementById('wLeisure').value) || 0,
    routine: parseFloat(document.getElementById('wRoutine').value) || 0,
    focus: parseFloat(document.getElementById('wFocus').value) || 0,
    watch: parseFloat(document.getElementById('wWatch').value) || 0,
    unspecified: parseFloat(document.getElementById('wUnspecified').value) || 0,
    abstain: parseFloat(document.getElementById('wAbstain').value) || 0,
    focusGoalMinutes: weights.focusGoalMinutes ?? FOCUS_GOAL_MINUTES_DEFAULT,
  };
  saveWeightsToStorage();
  renderScore();
  closeOverlay('menuOverlay');
  showToast('설정을 저장했어요');
}

function exportBackup() {
  const data = { days, weights, carryoverMeta, watchChainMeta, memos, gamePoints, gameAddedScores, gameSpendLog, planBlocks, periodPlans, watchArchiveItems, watchPlannedItems, watchLists, exportedAt: new Date().toISOString() };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = formatKey(new Date());
  a.href = url; a.download = `todo-backup-${stamp}.json`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast('백업 파일을 내보냈어요');
}

function triggerImport() { document.getElementById('importFile').click(); }

function importBackup(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (!data || typeof data !== 'object') throw new Error('invalid');
      days = (data.days && typeof data.days === 'object') ? data.days : days;
      weights = (data.weights && typeof data.weights === 'object') ? data.weights : weights;
      carryoverMeta = (data.carryoverMeta && typeof data.carryoverMeta === 'object') ? data.carryoverMeta : carryoverMeta;
      watchChainMeta = (data.watchChainMeta && typeof data.watchChainMeta === 'object') ? data.watchChainMeta : watchChainMeta;
      memos = (data.memos && typeof data.memos === 'object') ? data.memos : memos;
      if (typeof data.gamePoints === 'number') gamePoints = data.gamePoints;
      if (data.gameAddedScores && typeof data.gameAddedScores === 'object') gameAddedScores = data.gameAddedScores;
      if (Array.isArray(data.gameSpendLog)) gameSpendLog = data.gameSpendLog;
      if (Array.isArray(data.planBlocks)) planBlocks = data.planBlocks;
      if (Array.isArray(data.periodPlans)) periodPlans = data.periodPlans;
      if (Array.isArray(data.watchArchiveItems)) watchArchiveItems = data.watchArchiveItems;
      if (Array.isArray(data.watchPlannedItems)) watchPlannedItems = data.watchPlannedItems;
      if (Array.isArray(data.watchLists)) watchLists = data.watchLists;
      saveDays(); saveWeightsToStorage(); saveCarryoverMeta(); saveWatchChainMeta(); saveMemos(); saveGamePoints();
      savePlanBlocks(); savePeriodPlans(); saveWatchArchiveItems(); saveWatchPlannedItems(); saveWatchLists();
      syncCarryoversForToday();
      syncWatchForToday();
      reconcileGamePoints();
      renderDayHeader(); renderBlocks(); renderScore();
      if (currentTab === 'memo') { renderMemoHeader(); renderMemos(); }
      if (currentTab === 'watch') { renderWatchHeader(); renderWatchBlocks(); }
      if (currentTab === 'game') renderGamePoints();
      if (currentTab === 'plan') renderPlanList();
      closeOverlay('menuOverlay');
      showToast('백업을 불러왔어요');
    } catch (err) {
      showToast('파일을 읽을 수 없어요. 올바른 백업 파일인지 확인해주세요.');
    }
  };
  reader.readAsText(file);
  e.target.value = '';
}

/* =========================================================
   PWA install
   ========================================================= */
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  deferredPrompt = e;
  if (!window.matchMedia('(display-mode: standalone)').matches) {
    document.getElementById('install-banner').classList.add('show');
  }
});

async function installApp() {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  const { outcome } = await deferredPrompt.userChoice;
  if (outcome === 'accepted') document.getElementById('install-banner').style.display = 'none';
  deferredPrompt = null;
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

/* =========================================================
   INIT
   ========================================================= */
applyTheme(); // 화면이 그려지기 전에 가장 먼저 테마를 적용해 깜빡임을 방지
// 앱을 며칠 만에 다시 열었을 수도 있으니, 어제까지의 미합산 점수를 먼저 챙긴다.
reconcileGamePoints();
syncCarryoversForToday();
syncWatchForToday();
// lastKnownTodayKey(영구 저장된 값)와 비교해서, 마지막 세션 이후 실제로 자정을 넘긴
// 경우에만 종료/예정 아카이브의 연결을 끊는다 — 같은 날 새로고침만 했다면 그대로 유지.
if (TODAY_KEY() !== lastKnownTodayKey) {
  lastKnownTodayKey = TODAY_KEY();
  saveLastKnownTodayKey();
  detachWatchArchiveLinks();
}
renderDayHeader();
renderBlocks();
renderScore();
renderGamePoints();
updateReorderButtonVisibility();
initPlanSubtabSwipe();
initWatchSubtabSwipe();

// 진행 중인 타이머가 있으면 (예: 앱을 닫았다 다시 열었을 때) 화면 갱신을 위해
// 항상 tick 인터벌을 켜둔다. 타이머 시트가 열려있지 않으면 timerTick 내부에서
// 별다른 동작을 하지 않으므로 가볍다.
if (!timerTickHandle) timerTickHandle = setInterval(timerTick, 1000);
