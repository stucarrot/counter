/* =========================================================
   STORAGE SCHEMA
   pc_days        : { "2026-06-17": { blocks:[...] }, ... }
     block: {
       id, name, desc, type, time, customTime, progressType,
       total?, current?, done?,
       carryover: bool, carryoverId?: string,
       sessions?: [{start:ISOString, end:ISOString}]   // 집중시간 사이클 기록
     }
   pc_weights     : { schedule, todo, once, leisure, routine, focus }
   pc_carryover_meta : { <carryoverId>: { stopped: bool } }
   pc_memos       : { "2026-06-17": [{id, text, time}], ... }
   pc_app_titles  : { todo: string }
   pc_active_timer: { dateKey, blockId, startedAt(ISOString), accumulatedMs, paused: bool } | null

   유형 "루틴"은 carryover가 항상 true로 강제된다 (매일 자동 반복, 진행도 리셋).
   다른 유형은 "이행" 체크박스로 carryover를 켤 수 있다 — 완료 전까지 진행도를
   그대로 들고 다음 날로 이어지고, 완료되면 체인이 멈춘다.

   "오늘"의 기준은 자정이 아니라 오전 4시.
   ========================================================= */

const DAY_CUTOFF_HOUR = 4;
const HEATMAP_DAYS = 5;

let days = JSON.parse(localStorage.getItem('pc_days') || '{}');
let weights = JSON.parse(localStorage.getItem('pc_weights') || 'null') || { schedule: 35, todo: 30, once: 20, leisure: 15, routine: 30, focus: 20 };
let carryoverMeta = JSON.parse(localStorage.getItem('pc_carryover_meta') || '{}');
let memos = JSON.parse(localStorage.getItem('pc_memos') || '{}');
let appTitles = JSON.parse(localStorage.getItem('pc_app_titles') || 'null') || { todo: '오늘 할 일' };
let activeTimer = JSON.parse(localStorage.getItem('pc_active_timer') || 'null');

let editBlockId = null;
let deleteBlockId = null;
let deferredPrompt = null;
let reordering = false;
let currentTab = 'todo';
let timerBlockId = null; // 타이머 시트가 현재 가리키는 블록
let timerTickHandle = null;
let viewingMemoDateKey;

function appNow() {
  // 오전 4시를 하루의 시작으로 보는 "가상 현재 시각"
  const d = new Date();
  return new Date(d.getTime() - DAY_CUTOFF_HOUR * 60 * 60 * 1000);
}
const TODAY_KEY = () => formatKey(appNow());
let viewingDateKey = TODAY_KEY();
viewingMemoDateKey = TODAY_KEY();

const TYPE_LABEL = { schedule: '일정', once: '일회성', todo: '할일', leisure: '여가', routine: '루틴' };
const TIME_LABEL = { morning: '오전', afternoon: '오후', night: '밤' };

/* ---------- persistence helpers ---------- */
function saveDays() { localStorage.setItem('pc_days', JSON.stringify(days)); }
function saveWeightsToStorage() { localStorage.setItem('pc_weights', JSON.stringify(weights)); }
function saveCarryoverMeta() { localStorage.setItem('pc_carryover_meta', JSON.stringify(carryoverMeta)); }
function saveMemos() { localStorage.setItem('pc_memos', JSON.stringify(memos)); }
function saveAppTitles() { localStorage.setItem('pc_app_titles', JSON.stringify(appTitles)); }
function saveActiveTimer() {
  if (activeTimer) localStorage.setItem('pc_active_timer', JSON.stringify(activeTimer));
  else localStorage.removeItem('pc_active_timer');
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
  if (!days[key]) days[key] = { blocks: [] };
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
  document.getElementById('tabBtn-todo').classList.toggle('active', tab === 'todo');
  document.getElementById('tabBtn-memo').classList.toggle('active', tab === 'memo');
  document.getElementById('page-todo').classList.toggle('hidden', tab !== 'todo');
  document.getElementById('page-memo').classList.toggle('hidden', tab !== 'memo');
  document.getElementById('reorderToggle').style.display = tab === 'todo' ? '' : 'none';
  if (tab === 'memo') {
    if (reordering) toggleReorder();
    renderMemoHeader();
    renderMemos();
  }
}

/* =========================================================
   REORDER MODE
   ========================================================= */
function toggleReorder() {
  reordering = !reordering;
  document.body.classList.toggle('reordering', reordering);
  document.getElementById('reorderToggle').setAttribute('aria-pressed', reordering ? 'true' : 'false');
  renderBlocks();
}

/* =========================================================
   GENERIC OVERLAY HELPERS
   ========================================================= */
function closeOverlay(id) { document.getElementById(id).classList.remove('open'); }
function overlayClose(e, id) { if (e.target === document.getElementById(id)) closeOverlay(id); }

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    ['blockFormOverlay','confirmOverlay','menuOverlay','timerOverlay','feedbackOverlay'].forEach(closeOverlay);
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
  selectedType = null; selectedTime = null; selectedProgress = null;
  document.querySelectorAll('#bfTypeGroup .seg-btn, #bfTimeGroup .seg-btn, #bfProgressGroup .seg-btn').forEach(b => b.classList.remove('selected'));
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
  selectedType = b.type; selectedTime = b.time || null; selectedProgress = b.progressType;

  document.querySelectorAll('#bfTypeGroup .seg-btn').forEach(btn => {
    btn.classList.toggle('selected', btn.dataset.val === b.type);
    // 루틴 블록은 다른 유형으로 전환 불가 (이행 체인 추적이 깨지는 걸 방지)
    btn.disabled = b.type === 'routine' && btn.dataset.val !== 'routine';
  });
  document.querySelectorAll('#bfTimeGroup .seg-btn').forEach(btn => btn.classList.toggle('selected', btn.dataset.val === b.time));
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
  el.innerHTML = day.blocks.map((b, idx) => {
    const complete = isBlockComplete(b);
    let progressHtml = '';
    if (b.progressType === 'counter') {
      const pct = b.total > 0 ? Math.round(b.current / b.total * 100) : 0;
      const atMin = b.current <= 0, atMax = b.current >= b.total;
      progressHtml = `<div class="block-progress-row">
        <button class="ctrl-btn" style="width:32px;height:32px;font-size:18px;" onclick="changeBlockCounter(${b.id},-1)" ${atMin?'disabled':''} aria-label="감소">−</button>
        <div class="fraction" style="font-size:18px;min-width:54px;">${b.current}<span style="font-size:13px;">/${b.total}</span></div>
        <button class="ctrl-btn" style="width:32px;height:32px;font-size:18px;" onclick="changeBlockCounter(${b.id},1)" ${atMax?'disabled':''} aria-label="증가">+</button>
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

  if (!scorable.length && !hasFocusComponent) {
    el.innerHTML = `<div class="score-top"><div class="score-num">—</div></div>
      <div class="score-feedback">진행 체크가 있는 블록을 추가하면 달성률이 표시돼요.</div>
      ${renderFeedbackButton()}`;
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
    ${hasFocusComponent ? `<div class="focus-total-row">오늘 집중시간 <strong>${formatDurationShort(totalFocusMs)}</strong></div>` : ''}
    ${renderFeedbackButton()}
  `;
}

function renderFeedbackButton() {
  const isToday = viewingDateKey === TODAY_KEY();
  if (!isToday) return '';
  return `<button class="score-feedback-btn" onclick="openYesterdayFeedback()">어제 피드백 보기</button>`;
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
   AUTO-ROLLOVER (오전 4시 기준)
   ========================================================= */
let lastKnownTodayKey = TODAY_KEY();

function checkMidnightRollover() {
  const today = TODAY_KEY();
  if (today !== lastKnownTodayKey) {
    lastKnownTodayKey = today;
    const added = syncCarryoversForToday();
    if (viewingDateKey === today) {
      renderBlocks();
      if (added > 0) showToast(`이어지는 블록 ${added}개가 오늘 목록에 추가됐어요`);
    }
  }
  if (viewingDateKey === today) { renderDayHeader(); renderScore(); }
}
setInterval(checkMidnightRollover, 60 * 1000);

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
  const score = weightTotal > 0 ? Math.round((weightedSum / weightTotal) * 100) : null;
  return { score, blocks: day.blocks, totalFocusMs };
}

function openYesterdayFeedback() {
  document.getElementById('feedbackOverlay').classList.add('open');
  const body = document.getElementById('feedbackBody');
  const yKey = addDaysToKey(TODAY_KEY(), -1);
  const data = computeDayScore(yKey);

  if (!data || !data.blocks.length) {
    body.innerHTML = `<span class="fb-loading">어제 기록이 없어요.</span>`;
    return;
  }

  const lines = [];
  lines.push(`어제(${yKey}) 달성 점수: ${data.score !== null ? data.score + '/100' : '집계할 수 없음'}`);
  if (data.totalFocusMs > 0) lines.push(`집중시간: ${formatDurationShort(data.totalFocusMs)}`);
  lines.push('');
  lines.push('블록 요약:');
  data.blocks.forEach(b => {
    let line = `- ${b.name} (${TYPE_LABEL[b.type]})`;
    if (b.progressType === 'counter') line += `: ${b.current}/${b.total}`;
    else if (b.progressType === 'toggle') line += `: ${b.done ? '완료' : '미완료'}`;
    lines.push(line);
  });

  const score = data.score;
  let summary;
  if (score === null) summary = '어제는 진행 체크가 있는 블록이 없어서 점수를 매기긴 어렵지만, 기록을 남긴 것 자체로 의미가 있어요.';
  else if (score >= 90) summary = `어제는 ${score}점으로 정말 알찬 하루였어요. 계획한 것들을 거의 다 해냈네요. 오늘도 이 흐름을 이어가 보세요.`;
  else if (score >= 70) summary = `어제는 ${score}점으로 꽤 잘 보낸 하루였어요. 몇 가지가 남았지만 전반적으로 좋은 흐름이었어요.`;
  else if (score >= 40) summary = `어제는 ${score}점으로 절반 정도 진행됐어요. 무리한 계획이었는지, 컨디션 문제였는지 한번 돌아보면 오늘 도움이 될 거예요.`;
  else if (score > 0) summary = `어제는 ${score}점으로 시작 단계에 머물렀어요. 괜찮아요, 오늘은 부담을 좀 줄여서 작은 것 하나부터 해보는 것도 방법이에요.`;
  else summary = '어제는 거의 진행되지 못한 하루였어요. 너무 자책하지 말고, 오늘 할 일을 좀 더 작은 단위로 쪼개보는 게 도움이 될 수 있어요.';

  body.innerHTML = `<div style="margin-bottom:14px;">${esc(summary)}</div><div style="font-size:12.5px;color:#888;white-space:pre-wrap;">${esc(lines.join('\n'))}</div>`;
}

/* =========================================================
   BACKUP / IMPORT / WEIGHTS
   ========================================================= */
function openMenu() {
  document.getElementById('todoTitleInput').value = appTitles.todo;
  document.getElementById('wSchedule').value = weights.schedule;
  document.getElementById('wTodo').value = weights.todo;
  document.getElementById('wOnce').value = weights.once;
  document.getElementById('wLeisure').value = weights.leisure;
  document.getElementById('wRoutine').value = weights.routine ?? 30;
  document.getElementById('wFocus').value = weights.focus ?? 20;
  document.getElementById('menuOverlay').classList.add('open');
}

function saveMenuSettings() {
  const titleVal = document.getElementById('todoTitleInput').value.trim();
  appTitles.todo = titleVal || '오늘 할 일';
  saveAppTitles();
  document.getElementById('todoTabTitle').textContent = appTitles.todo;

  weights = {
    schedule: parseInt(document.getElementById('wSchedule').value) || 0,
    todo: parseInt(document.getElementById('wTodo').value) || 0,
    once: parseInt(document.getElementById('wOnce').value) || 0,
    leisure: parseInt(document.getElementById('wLeisure').value) || 0,
    routine: parseInt(document.getElementById('wRoutine').value) || 0,
    focus: parseInt(document.getElementById('wFocus').value) || 0,
    focusGoalMinutes: weights.focusGoalMinutes ?? FOCUS_GOAL_MINUTES_DEFAULT,
  };
  saveWeightsToStorage();
  renderScore();
  closeOverlay('menuOverlay');
  showToast('설정을 저장했어요');
}

function exportBackup() {
  const data = { days, weights, carryoverMeta, memos, appTitles, exportedAt: new Date().toISOString() };
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
      memos = (data.memos && typeof data.memos === 'object') ? data.memos : memos;
      appTitles = (data.appTitles && typeof data.appTitles === 'object') ? data.appTitles : appTitles;
      saveDays(); saveWeightsToStorage(); saveCarryoverMeta(); saveMemos(); saveAppTitles();
      syncCarryoversForToday();
      document.getElementById('todoTabTitle').textContent = appTitles.todo;
      renderDayHeader(); renderBlocks(); renderScore();
      if (currentTab === 'memo') { renderMemoHeader(); renderMemos(); }
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
document.getElementById('todoTabTitle').textContent = appTitles.todo;
syncCarryoversForToday();
renderDayHeader();
renderBlocks();
renderScore();

// 진행 중인 타이머가 있으면 (예: 앱을 닫았다 다시 열었을 때) 화면 갱신을 위해
// 항상 tick 인터벌을 켜둔다. 타이머 시트가 열려있지 않으면 timerTick 내부에서
// 별다른 동작을 하지 않으므로 가볍다.
if (!timerTickHandle) timerTickHandle = setInterval(timerTick, 1000);
