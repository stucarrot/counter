/* =========================================================
   STORAGE SCHEMA
   pc_days        : { "2026-06-17": { blocks:[...], watchBlocks:[...] }, ... }
     block (할일): { id, name, desc, type, time, customTime, progressType,
       total?, current?, done?, carryover, carryoverId?, sessions? }
     watchBlock (감상): { id, name, author, type(book/movie/etc), progress(0~100),
       archived: bool, watchChainId: string, memos: [{id,text,time}] }
   pc_weights     : { schedule, todo, once, leisure, routine, focus, watch }
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

   유형 "루틴"은 carryover가 항상 true로 강제된다 (매일 자동 반복, 진행도 리셋).
   다른 유형은 "이행" 체크박스로 carryover를 켤 수 있다 — 완료 전까지 진행도를
   그대로 들고 다음 날로 이어지고, 완료되면 체인이 멈춘다.

   감상 블록은 progress가 100이 아니고 "보관"이 체크되지 않으면 매일 다음 날로
   이월된다 (이전 날 블록은 삭제되지 않고 그대로 남되, 새 날의 카드에는 그날
   변화한 진행도 %p가 함께 표시된다). progress가 100이 되면 그 날에 고정되어
   더 이상 이월되지 않는다.

   "오늘"의 기준은 자정이 아니라 오전 4시.
   ========================================================= */

const DAY_CUTOFF_HOUR = 4;
const HEATMAP_DAYS = 5;

let days = JSON.parse(localStorage.getItem('pc_days') || '{}');
let weights = JSON.parse(localStorage.getItem('pc_weights') || 'null') || { schedule: 22, todo: 19, once: 13, leisure: 10, routine: 19, focus: 13, watch: 5 };
let carryoverMeta = JSON.parse(localStorage.getItem('pc_carryover_meta') || '{}');
let watchChainMeta = JSON.parse(localStorage.getItem('pc_watch_chain_meta') || '{}');
let memos = JSON.parse(localStorage.getItem('pc_memos') || '{}');
let activeTimer = JSON.parse(localStorage.getItem('pc_active_timer') || 'null');
let gamePoints = parseFloat(localStorage.getItem('pc_game_points') || '0');
let gameAddedScores = JSON.parse(localStorage.getItem('pc_game_added_scores') || '{}');
let planBlocks = JSON.parse(localStorage.getItem('pc_plan_blocks') || '[]');
let periodPlans = JSON.parse(localStorage.getItem('pc_period_plans') || '[]');

let editBlockId = null;
let deleteBlockId = null;
let deferredPrompt = null;
let reordering = false;
let currentTab = 'todo';
let timerBlockId = null; // 타이머 시트가 현재 가리키는 블록
let timerTickHandle = null;
let viewingMemoDateKey;
let viewingWatchDateKey;
let editWatchId = null;
let progressEditWatchId = null;
let watchMemoTargetId = null;
let selectedWatchType = null;
let editPlanId = null;
let deletePlanId = null;
let selectedPlanType = null, selectedPlanTimeMode = null, selectedPlanProgress = null;
let currentPlanSubtab = 'time';
let editPeriodId = null;
let selectedPeriodMode = null;
let pendingPeriodRefs = []; // 기간계획 폼 작성 중 임시로 들고 있는 참조 목록
let importPlanId = null;

function appNow() {
  // 오전 4시를 하루의 시작으로 보는 "가상 현재 시각"
  const d = new Date();
  return new Date(d.getTime() - DAY_CUTOFF_HOUR * 60 * 60 * 1000);
}
const TODAY_KEY = () => formatKey(appNow());
let viewingDateKey = TODAY_KEY();
viewingMemoDateKey = TODAY_KEY();
viewingWatchDateKey = TODAY_KEY();

const TYPE_LABEL = { schedule: '일정', once: '일회성', todo: '할일', leisure: '여가', routine: '루틴', unspecified: '미지정' };
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
function saveActiveTimer() {
  if (activeTimer) localStorage.setItem('pc_active_timer', JSON.stringify(activeTimer));
  else localStorage.removeItem('pc_active_timer');
}
function saveGamePoints() {
  localStorage.setItem('pc_game_points', String(gamePoints));
  localStorage.setItem('pc_game_added_scores', JSON.stringify(gameAddedScores));
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
function switchTab(tab) {
  currentTab = tab;
  ['plan','todo','watch','memo','game'].forEach(t => {
    document.getElementById(`tabBtn-${t}`).classList.toggle('active', tab === t);
    document.getElementById(`page-${t}`).classList.toggle('hidden', tab !== t);
  });
  document.getElementById('reorderToggle').style.display = (tab === 'todo' || tab === 'watch' || tab === 'plan') ? '' : 'none';
  if (reordering && tab !== 'todo' && tab !== 'watch' && tab !== 'plan') toggleReorder();
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
    ['blockFormOverlay','confirmOverlay','menuOverlay','timerOverlay','feedbackOverlay','watchFormOverlay','watchProgressOverlay','watchMemoOverlay','planFormOverlay','periodFormOverlay','refPickerOverlay','importPopupOverlay'].forEach(closeOverlay);
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
  document.getElementById('copyYesterdayBtn').style.display = isToday ? '' : 'none';
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
  if (selectedType === 'routine') {
    // 루틴은 항상 이행(carryover) — 체크박스를 숨기고 강제로 켠 상태로 취급
    carryoverField.classList.add('hidden');
    checkbox.checked = true;
  } else {
    carryoverField.classList.remove('hidden');
  }
}

function toggleCustomTime() {
  document.getElementById('bfCustomTime').classList.toggle('hidden', selectedTime !== 'custom');
}

function toggleCounterFields() {
  document.getElementById('bfCounterFields').classList.toggle('hidden', selectedProgress !== 'counter');
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
  document.getElementById('bfCustomTime').value = '';
  document.getElementById('bfCustomTime').classList.add('hidden');
  document.getElementById('bfCounterFields').classList.add('hidden');
  document.getElementById('bfCarryover').checked = false;
  document.getElementById('bfCarryoverField').classList.remove('hidden');
  selectedType = null; selectedTime = 'none'; selectedProgress = null;
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

  const customTimeInput = document.getElementById('bfCustomTime');
  if (b.time === 'custom') { customTimeInput.classList.remove('hidden'); customTimeInput.value = b.customTime || ''; }
  else customTimeInput.classList.add('hidden');

  if (b.progressType === 'counter') {
    document.getElementById('bfCounterFields').classList.remove('hidden');
    document.getElementById('bfTotal').value = b.total || '';
    document.getElementById('bfCurrent').value = b.current || 0;
  } else {
    document.getElementById('bfCounterFields').classList.add('hidden');
  }

  document.getElementById('bfCarryover').checked = !!b.carryover;
  if (b.type === 'routine') document.getElementById('bfCarryoverField').classList.add('hidden');
  else document.getElementById('bfCarryoverField').classList.remove('hidden');

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
  let total = null, current = null;
  if (selectedProgress === 'counter') {
    total = parseInt(document.getElementById('bfTotal').value);
    current = parseInt(document.getElementById('bfCurrent').value) || 0;
    if (!total || total < 1) { document.getElementById('bfTotal').focus(); return; }
    current = Math.max(0, Math.min(total, current));
  }

  const isRoutineType = selectedType === 'routine';
  const wantsCarryover = isRoutineType || document.getElementById('bfCarryover').checked;

  const day = ensureDay(viewingDateKey);

  if (editBlockId !== null) {
    const b = day.blocks.find(x => x.id === editBlockId);
    if (b) {
      b.name = name; b.desc = desc; b.time = selectedTime; b.customTime = customTime;
      b.progressType = selectedProgress;
      // 루틴 ↔ 비루틴 전환은 막는다 (openBlockEdit에서 버튼 disabled 처리됨)
      b.type = b.type === 'routine' ? 'routine' : selectedType;

      if (selectedProgress === 'counter') { b.total = total; b.current = current; }
      else if (selectedProgress === 'toggle') { if (b.done === undefined) b.done = false; }

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
  document.getElementById('confirmMsg').innerHTML = hasCarryover
    ? `<strong>${esc(b.name)}</strong> 블록을 삭제할까요?<br>오늘 이후로 더 이상 자동으로 이어지지 않아요.`
    : `<strong>${esc(b.name)}</strong> 블록을 삭제할까요?<br>이 작업은 되돌릴 수 없어요.`;
  document.getElementById('confirmOkBtn').onclick = () => {
    day.blocks = day.blocks.filter(x => x.id !== deleteBlockId);
    if (hasCarryover && b.carryoverId) {
      carryoverMeta[b.carryoverId] = { stopped: true };
      saveCarryoverMeta();
    }
    saveDays(); renderBlocks(); renderScore(); closeOverlay('confirmOverlay');
  };
  document.getElementById('confirmOverlay').classList.add('open');
}

function changeBlockCounter(id, delta) {
  const day = ensureDay(viewingDateKey);
  const b = day.blocks.find(x => x.id === id);
  if (!b) return;
  b.current = Math.max(0, Math.min(b.total, b.current + delta));
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

function timeLabelFor(b) {
  if (b.time === 'custom' && b.customTime) return b.customTime;
  return TIME_LABEL[b.time] || '';
}

function blockProgressFraction(b) {
  if (b.progressType === 'counter') return b.total > 0 ? b.current / b.total : 0;
  if (b.progressType === 'toggle') return b.done ? 1 : 0;
  return null;
}

function isBlockComplete(b) {
  if (b.progressType === 'counter') return b.current >= b.total;
  if (b.progressType === 'toggle') return !!b.done;
  return false;
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

    // 완료된 상태로 끝났다면 체인을 멈추고 복사하지 않는다 (조용히 사라짐)
    if (isBlockComplete(template)) {
      carryoverMeta[cid] = { stopped: true };
      saveCarryoverMeta();
      return;
    }

    // 미완료 → 그날까지의 진행도를 그대로 들고 오늘로 복사 (루틴은 진행도 리셋, 이행은 유지)
    const nb = { ...template, id: Date.now() + Math.floor(Math.random()*100000) };
    if (template.type === 'routine') {
      // 루틴은 매일 새로 시작하는 반복 — 진행도 리셋
      if (nb.progressType === 'counter') nb.current = 0;
      if (nb.progressType === 'toggle') nb.done = false;
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
  if (!b.sessions || !b.sessions.length) return '';
  const rows = b.sessions.map(s => {
    const dur = formatDurationShort(sessionDurationMs(s));
    return `<div class="session-log-row"><span class="session-log-duration">${dur}</span><span class="session-log-times">${formatClock(s.start)}–${formatClock(s.end)}</span></div>`;
  }).join('');
  const total = blockTotalFocusMs(b);
  return `<div class="session-log">${rows}</div><div class="focus-total-row">총 집중시간 <strong>${formatDurationShort(total)}</strong></div>`;
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
      const pct = b.total > 0 ? Math.round(b.current / b.total * 100) : 0;
      const atMin = b.current <= 0, atMax = b.current >= b.total;
      progressHtml = `<div class="block-progress-row">
        <button class="ctrl-btn" style="width:32px;height:32px;font-size:18px;" onclick="changeBlockCounter(${b.id},-1)" ${atMin?'disabled':''} aria-label="감소">−</button>
        <div class="fraction" style="font-size:18px;min-width:54px;">${b.current}<span style="font-size:13px;">/${b.total}</span></div>
        <button class="ctrl-btn" style="width:32px;height:32px;font-size:18px;" onclick="changeBlockCounter(${b.id},1)" ${atMax?'disabled':''} aria-label="증가">+</button>
        <span class="counter-pct">${pct}%</span>
        <div class="prog-wrap"><div class="prog-bar"><div class="prog-fill" style="width:${pct}%"></div></div></div>
      </div>`;
    } else if (b.progressType === 'toggle') {
      progressHtml = `<div class="block-progress-row">
        <button class="toggle-check ${b.done?'done':''}" onclick="toggleBlockDone(${b.id})" aria-label="완료 토글">
          <svg viewBox="0 0 24 24" fill="none" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
        </button>
        <span class="toggle-label">${b.done ? '완료' : '미완료'}</span>
      </div>`;
    }
    const timeStr = timeLabelFor(b);
    const carryoverBadge = (b.carryover && b.type !== 'routine') ? `<span class="carryover-chip">이행</span>` : '';
    const hasTime = blockTotalFocusMs(b) > 0 || (activeTimer && activeTimer.blockId === b.id);
    const isTimerActive = activeTimer && activeTimer.blockId === b.id && activeTimer.dateKey === viewingDateKey;
    return `<div class="card block-card type-${b.type} ${complete && b.progressType!=='none' ? 'completed':''}" data-id="${b.id}">
      <div class="reorder-handle">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
      </div>
      <div class="card-main">
        <div class="card-header">
          <div class="card-title-wrap">
            <div class="card-title">${esc(b.name)}${isTimerActive ? ' ⏱' : ''}</div>
            <div class="card-sub"><span class="type-chip">${TYPE_LABEL[b.type]}</span>${timeStr ? `<span class="time-chip">${timeStr}</span>` : ''}${carryoverBadge}</div>
            ${b.type === 'routine' ? renderHeatmap(b.carryoverId) : ''}
          </div>
          <div class="card-btns">
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
        ${b.desc ? `<div class="block-desc">${esc(b.desc)}</div>` : ''}
        ${progressHtml}
        ${renderSessionLog(b)}
      </div>
    </div>`;
  }).join('');
}

/* =========================================================
   YESTERDAY COPY (수동) — carryover 블록은 자동으로 이어지므로 제외
   ========================================================= */
function copyYesterday() {
  const d = keyToDate(viewingDateKey);
  d.setDate(d.getDate() - 1);
  const yKey = formatKey(d);
  const yDay = days[yKey];
  if (!yDay || !yDay.blocks.length) { showToast('어제 기록이 없어요'); return; }

  const today = ensureDay(viewingDateKey);
  const nonCarryover = yDay.blocks.filter(b => !b.carryover);
  if (!nonCarryover.length) { showToast('복사할 블록이 없어요 (이행/루틴 블록은 자동으로 이어져요)'); return; }

  const copied = nonCarryover.map(b => {
    const nb = { ...b, id: Date.now() + Math.floor(Math.random()*10000) };
    if (nb.progressType === 'counter') nb.current = 0;
    if (nb.progressType === 'toggle') nb.done = false;
    return nb;
  });
  today.blocks = today.blocks.concat(copied);
  saveDays(); renderBlocks(); renderScore();
  showToast(`어제 블록 ${copied.length}개를 복사했어요`);
}

/* =========================================================
   SCORE CALCULATION (집중시간 가중치 포함)
   ========================================================= */
const FOCUS_GOAL_MINUTES_DEFAULT = 120;
function getFocusGoalMs() {
  const mins = weights.focusGoalMinutes ?? FOCUS_GOAL_MINUTES_DEFAULT;
  return mins * 60 * 1000;
}

function dayTotalFocusMs(day) {
  return day.blocks.reduce((sum, b) => sum + blockTotalFocusMs(b), 0);
}

function renderScore() {
  const day = ensureDay(viewingDateKey);
  const el = document.getElementById('scoreCard');
  const scorable = day.blocks.filter(b => b.progressType !== 'none');
  const totalFocusMs = dayTotalFocusMs(day);
  const focusWeight = weights.focus ?? 0;
  const hasFocusComponent = focusWeight > 0;
  const watchWeight = weights.watch ?? 0;
  const watchFrac = dayWatchScoreFraction(day);
  const hasWatchComponent = watchWeight > 0 && watchFrac !== null;

  if (!scorable.length && !hasFocusComponent && !hasWatchComponent) {
    el.innerHTML = `<div class="score-top"><div class="score-num">—</div></div>
      <div class="score-feedback">진행 체크가 있는 블록을 추가하면 달성률이 표시돼요.</div>
      <div class="score-bottom-row"><span></span>${renderFeedbackButton()}</div>`;
    return;
  }

  let weightedSum = 0, weightTotal = 0;
  scorable.forEach(b => {
    const w = weights[b.type] ?? 25;
    const frac = blockProgressFraction(b);
    weightedSum += w * frac;
    weightTotal += w;
  });
  if (hasFocusComponent) {
    const focusFrac = Math.min(1, totalFocusMs / getFocusGoalMs());
    weightedSum += focusWeight * focusFrac;
    weightTotal += focusWeight;
  }
  if (hasWatchComponent) {
    weightedSum += watchWeight * watchFrac;
    weightTotal += watchWeight;
  }
  const score = weightTotal > 0 ? Math.round((weightedSum / weightTotal) * 100) : 0;

  let feedback;
  if (score >= 90) feedback = '오늘 하루를 알차게 채웠어요. 훌륭해요!';
  else if (score >= 70) feedback = '꽤 잘 해내고 있어요. 남은 것도 마무리해봐요.';
  else if (score >= 40) feedback = '절반 정도 진행됐어요. 천천히 이어가요.';
  else if (score > 0) feedback = '이제 시작이에요. 하나씩 차근차근 해봐요.';
  else feedback = '아직 시작 전이에요. 작은 것부터 시작해볼까요?';

  el.innerHTML = `
    <div class="score-top"><div class="score-num">${score}<span>/100</span></div></div>
    <div class="score-feedback">${feedback}</div>
    <div class="score-bar"><div class="score-bar-fill" style="width:${score}%"></div></div>
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
  // 타이머는 보통 보고 있는 날짜의 블록을 다루지만, 다른 날짜에서 시작된 타이머가
  // 진행 중일 수도 있으니 activeTimer.dateKey 기준으로도 찾는다.
  for (const key of [viewingDateKey, activeTimer && activeTimer.dateKey].filter(Boolean)) {
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
  document.getElementById('manualEntryFields').classList.add('hidden');
  document.getElementById('manualToggleLabel').textContent = '+ 직접 시작·종료 시간으로 추가';
  renderTimerSheet();
  document.getElementById('timerOverlay').classList.add('open');
  if (!timerTickHandle) timerTickHandle = setInterval(timerTick, 1000);
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
      <div class="reorder-handle">
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
        ${p.desc ? `<div class="block-desc">${esc(p.desc)}</div>` : ''}
        ${progressHtml}
      </div>
    </div>`;
  }).join('');
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
  // 최근 14일 + 향후 14일 범위의 할일 블록을 후보로 보여준다 (전체를 다 훑으면 너무 많아짐)
  for (let i = -14; i <= 14; i++) {
    const k = addDaysToKey(TODAY_KEY(), i);
    const dayObj = days[k];
    if (!dayObj) continue;
    dayObj.blocks.forEach(b => {
      items.push({ kind: 'todo', id: b.id, dateKey: k, name: b.name, meta: `할일 · ${TYPE_LABEL[b.type]} · ${k}` });
    });
  }

  if (!items.length) {
    el.innerHTML = `<div class="empty" style="height:auto;padding:30px 0;"><p>참조할 블록이 없어요</p></div>`;
    return;
  }

  el.innerHTML = items.map(item => {
    const isSelected = pendingPeriodRefs.some(r => r.kind === item.kind && r.id === item.id && r.dateKey === item.dateKey);
    return `<div class="ref-picker-item ${isSelected?'selected':''}" onclick="toggleRefSelection('${item.kind}',${item.id},${item.dateKey ? `'${item.dateKey}'` : 'null'})">
      <span>${esc(item.name)}</span>
      <span class="ref-picker-item-meta">${esc(item.meta)}</span>
    </div>`;
  }).join('');
}

function toggleRefSelection(kind, id, dateKey) {
  const idx = pendingPeriodRefs.findIndex(r => r.kind === kind && r.id === id && r.dateKey === dateKey);
  if (idx >= 0) pendingPeriodRefs.splice(idx, 1);
  else pendingPeriodRefs.push({ kind, id, dateKey });
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
    const meta = resolved ? resolved.meta : '';
    return `<div class="ref-item">
      <span class="ref-item-name ${!resolved?'ref-item-missing':''}">${esc(label)}</span>
      ${meta ? `<span class="ref-picker-item-meta">${esc(meta)}</span>` : ''}
      <button class="ref-item-remove" onclick="removePendingRef(${idx})" aria-label="제거">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>`;
  }).join('');
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
    const refsHtml = (pp.refs || []).map(ref => {
      const resolved = resolveRef(ref);
      if (!resolved) {
        return `<div class="period-ref-chip ref-missing">(삭제된 블록)</div>`;
      }
      return `<div class="period-ref-chip"><span class="ref-chip-name">${esc(resolved.name)}</span><span class="ref-chip-meta">${esc(resolved.meta)}</span></div>`;
    }).join('');
    return `<div class="card period-card" data-id="${pp.id}">
      <div class="card-header">
        <div class="card-title-wrap">
          <div class="period-date-range">${esc(periodDateRangeLabel(pp))}</div>
          ${pp.desc ? `<div class="period-desc">${esc(pp.desc)}</div>` : ''}
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
  document.getElementById('watchSheetTitle').textContent = '감상 추가';
  document.getElementById('wfName').value = '';
  document.getElementById('wfAuthor').value = '';
  document.getElementById('wfProgress').value = '0';
  document.getElementById('wfArchive').checked = false;
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
  document.getElementById('watchSheetTitle').textContent = '감상 수정';
  document.getElementById('wfName').value = w.name;
  document.getElementById('wfAuthor').value = w.author || '';
  document.getElementById('wfProgress').value = w.progress;
  document.getElementById('wfArchive').checked = !!w.archived;
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
  if (!name) { document.getElementById('wfName').focus(); return; }
  if (!selectedWatchType) { showToast('유형을 선택해주세요'); return; }
  if (isNaN(progress)) progress = 0;
  progress = Math.max(0, Math.min(100, progress));

  const day = ensureDay(viewingWatchDateKey);

  if (editWatchId !== null) {
    const w = day.watchBlocks.find(x => x.id === editWatchId);
    if (w) {
      w.name = name; w.author = author; w.type = selectedWatchType;
      w.progress = progress; w.archived = archived;
      // 100% 달성 시 더 이상 이월되지 않도록 체인 중단 처리
      if (progress >= 100 && w.watchChainId) {
        watchChainMeta[w.watchChainId] = { stopped: true };
        saveWatchChainMeta();
      }
    }
  } else {
    const chainId = 'w' + Date.now() + Math.floor(Math.random()*1000);
    const watchBlock = {
      id: Date.now() + Math.floor(Math.random()*1000),
      name, author, type: selectedWatchType, progress, archived,
      watchChainId: chainId, memos: []
    };
    watchChainMeta[chainId] = { stopped: progress >= 100 || archived };
    saveWatchChainMeta();
    day.watchBlocks.push(watchBlock);
  }

  saveDays(); renderWatchBlocks(); renderScore(); closeOverlay('watchFormOverlay');
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
    const xDone = x.w.progress >= 100 ? 1 : 0;
    const yDone = y.w.progress >= 100 ? 1 : 0;
    if (xDone !== yDone) return xDone - yDone;
    return x.realIdx - y.realIdx;
  });

  el.innerHTML = sorted.map(({ w, realIdx }) => {
    const idx = realIdx;
    const complete = w.progress >= 100;
    const delta = watchDeltaForToday(w, viewingWatchDateKey);
    const deltaStr = (delta !== null && delta !== 0) ? `${delta > 0 ? '+' : ''}${delta}%p` : null;
    const memoCount = (w.memos || []).length;
    return `<div class="card watch-card type-watch-${w.type} ${complete ? 'completed' : ''}" data-id="${w.id}">
      <div class="reorder-handle">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
      </div>
      <div class="card-main">
        <div class="card-header">
          <div class="card-title-wrap">
            <div class="card-title">${esc(w.name)}</div>
            <div class="card-sub"><span class="type-chip">${WATCH_TYPE_LABEL[w.type]}</span>${w.author ? `<span class="time-chip">${esc(w.author)}</span>` : ''}${w.archived ? '<span class="carryover-chip">보관</span>' : ''}</div>
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
        <div class="field" style="margin:8px 0 0;">
          <label class="carryover-label">
            <input type="checkbox" ${w.archived ? 'checked' : ''} onchange="toggleWatchArchive(${w.id})">
            <span>보관</span>
          </label>
        </div>
      </div>
    </div>`;
  }).join('');
}

/* ---------- 감상 메모 (시간재기 시트와 동일한 틀, 메모탭 인터페이스 재사용) ---------- */
function openWatchMemo(id) {
  watchMemoTargetId = id;
  const found = findWatchById(id);
  if (!found) return;
  document.getElementById('watchMemoTitle').textContent = `${found.w.name} — 감상 메모`;
  renderWatchMemoList();
  document.getElementById('watchMemoOverlay').classList.add('open');
}

function findWatchById(id) {
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
  saveDays();
  input.value = '';
  input.style.height = 'auto';
  renderWatchMemoList();
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
      <div class="memo-text">${esc(m.text)}</div>
      <div class="memo-meta-row">
        <span class="memo-time">${timeStr}</span>
        <button class="memo-copy-btn" onclick="copyWatchMemo(${m.id})">복사</button>
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
  // 그날 감상 블록들의 평균 진행도(0~1)를 감상 항목의 점수로 사용
  if (!day.watchBlocks || !day.watchBlocks.length) return null;
  const sum = day.watchBlocks.reduce((s, w) => s + (w.progress / 100), 0);
  return sum / day.watchBlocks.length;
}

/* =========================================================
   AUTO-ROLLOVER (오전 4시 기준)
   ========================================================= */
let lastKnownTodayKey = TODAY_KEY();

function checkMidnightRollover() {
  const today = TODAY_KEY();
  if (today !== lastKnownTodayKey) {
    lastKnownTodayKey = today;
    // 어제 날짜가 마무리됐으므로 게임 포인트를 재계산
    reconcileGamePoints();
    if (currentTab === 'game') renderGamePoints();
    const added = syncCarryoversForToday();
    const watchAdded = syncWatchForToday();
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

  gamePoints = total;
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
      <div class="memo-text">${esc(m.text)}</div>
      <div class="memo-meta-row">
        <span class="memo-time">${timeStr}</span>
        <button class="memo-copy-btn" onclick="copyMemo(${m.id})">복사</button>
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
  const scorable = day.blocks.filter(b => b.progressType !== 'none');
  const totalFocusMs = dayTotalFocusMs(day);
  const focusWeight = weights.focus ?? 0;
  const watchWeight = weights.watch ?? 0;
  const watchFrac = dayWatchScoreFraction(day);
  let weightedSum = 0, weightTotal = 0;
  scorable.forEach(b => {
    const w = weights[b.type] ?? 25;
    weightedSum += w * blockProgressFraction(b);
    weightTotal += w;
  });
  if (focusWeight > 0) {
    const focusFrac = Math.min(1, totalFocusMs / getFocusGoalMs());
    weightedSum += focusWeight * focusFrac;
    weightTotal += focusWeight;
  }
  if (watchWeight > 0 && watchFrac !== null) {
    weightedSum += watchWeight * watchFrac;
    weightTotal += watchWeight;
  }
  const score = weightTotal > 0 ? Math.round((weightedSum / weightTotal) * 100) : null;
  return { score, blocks: day.blocks, watchBlocks: day.watchBlocks || [], totalFocusMs };
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
  lines.push(`어제(${yKey}) 달성 점수: ${data.score !== null ? data.score + '/100' : '집계할 수 없음'}`);
  if (data.totalFocusMs > 0) lines.push(`집중시간: ${formatDurationShort(data.totalFocusMs)}`);
  if (hasBlocks) {
    lines.push('');
    lines.push('블록 요약:');
    data.blocks.forEach(b => {
      let line = `- ${b.name} (${TYPE_LABEL[b.type]})`;
      if (b.progressType === 'counter') line += `: ${b.current}/${b.total}`;
      else if (b.progressType === 'toggle') line += `: ${b.done ? '완료' : '미완료'}`;
      lines.push(line);
    });
  }
  let watchSummaryLine = '';
  if (hasWatch) {
    lines.push('');
    lines.push('감상 요약:');
    data.watchBlocks.forEach(w => {
      lines.push(`- ${w.name} (${WATCH_TYPE_LABEL[w.type]}): ${w.progress}%${w.archived ? ' · 보관' : ''}`);
    });
    const names = data.watchBlocks.map(w => w.name).join(', ');
    watchSummaryLine = ` 그리고 ${names}${data.watchBlocks.length > 1 ? '를' : '을'} 접하며 감상 시간도 챙겼어요.`;
  }

  const score = data.score;
  let summary;
  if (score === null) summary = '어제는 진행 체크가 있는 블록이 없어서 점수를 매기긴 어렵지만, 기록을 남긴 것 자체로 의미가 있어요.';
  else if (score >= 90) summary = `어제는 ${score}점으로 정말 알찬 하루였어요. 계획한 것들을 거의 다 해냈네요. 오늘도 이 흐름을 이어가 보세요.`;
  else if (score >= 70) summary = `어제는 ${score}점으로 꽤 잘 보낸 하루였어요. 몇 가지가 남았지만 전반적으로 좋은 흐름이었어요.`;
  else if (score >= 40) summary = `어제는 ${score}점으로 절반 정도 진행됐어요. 무리한 계획이었는지, 컨디션 문제였는지 한번 돌아보면 오늘 도움이 될 거예요.`;
  else if (score > 0) summary = `어제는 ${score}점으로 시작 단계에 머물렀어요. 괜찮아요, 오늘은 부담을 좀 줄여서 작은 것 하나부터 해보는 것도 방법이에요.`;
  else summary = '어제는 거의 진행되지 못한 하루였어요. 너무 자책하지 말고, 오늘 할 일을 좀 더 작은 단위로 쪼개보는 게 도움이 될 수 있어요.';
  summary += watchSummaryLine;

  body.innerHTML = `<div style="margin-bottom:14px;">${esc(summary)}</div><div style="font-size:12.5px;color:#888;white-space:pre-wrap;">${esc(lines.join('\n'))}</div>`;
}

/* =========================================================
   BACKUP / IMPORT / WEIGHTS
   ========================================================= */
function openMenu() {
  document.getElementById('wSchedule').value = weights.schedule;
  document.getElementById('wTodo').value = weights.todo;
  document.getElementById('wOnce').value = weights.once;
  document.getElementById('wLeisure').value = weights.leisure;
  document.getElementById('wRoutine').value = weights.routine ?? 30;
  document.getElementById('wFocus').value = weights.focus ?? 20;
  document.getElementById('wWatch').value = weights.watch ?? 5;
  document.getElementById('wUnspecified').value = weights.unspecified ?? 15;
  document.getElementById('menuOverlay').classList.add('open');
}

function saveMenuSettings() {
  weights = {
    schedule: parseInt(document.getElementById('wSchedule').value) || 0,
    todo: parseInt(document.getElementById('wTodo').value) || 0,
    once: parseInt(document.getElementById('wOnce').value) || 0,
    leisure: parseInt(document.getElementById('wLeisure').value) || 0,
    routine: parseInt(document.getElementById('wRoutine').value) || 0,
    focus: parseInt(document.getElementById('wFocus').value) || 0,
    watch: parseInt(document.getElementById('wWatch').value) || 0,
    unspecified: parseInt(document.getElementById('wUnspecified').value) || 0,
    focusGoalMinutes: weights.focusGoalMinutes ?? FOCUS_GOAL_MINUTES_DEFAULT,
  };
  saveWeightsToStorage();
  renderScore();
  closeOverlay('menuOverlay');
  showToast('설정을 저장했어요');
}

function exportBackup() {
  const data = { days, weights, carryoverMeta, watchChainMeta, memos, gamePoints, gameAddedScores, planBlocks, periodPlans, exportedAt: new Date().toISOString() };
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
      if (Array.isArray(data.planBlocks)) planBlocks = data.planBlocks;
      if (Array.isArray(data.periodPlans)) periodPlans = data.periodPlans;
      saveDays(); saveWeightsToStorage(); saveCarryoverMeta(); saveWatchChainMeta(); saveMemos(); saveGamePoints();
      savePlanBlocks(); savePeriodPlans();
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
// 앱을 며칠 만에 다시 열었을 수도 있으니, 어제까지의 미합산 점수를 먼저 챙긴다.
reconcileGamePoints();
syncCarryoversForToday();
syncWatchForToday();
renderDayHeader();
renderBlocks();
renderScore();
renderGamePoints();

// 진행 중인 타이머가 있으면 (예: 앱을 닫았다 다시 열었을 때) 화면 갱신을 위해
// 항상 tick 인터벌을 켜둔다. 타이머 시트가 열려있지 않으면 timerTick 내부에서
// 별다른 동작을 하지 않으므로 가볍다.
if (!timerTickHandle) timerTickHandle = setInterval(timerTick, 1000);
