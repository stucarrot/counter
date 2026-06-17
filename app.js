/* =========================================================
   STORAGE SCHEMA
   pc_problems   : [{id,name,total,solved}]
   pc_days       : { "2026-06-17": { blocks:[...] }, ... }
     block (routine): { ..., isRoutine:true, routineId: <string>, routineStopped?:true }
   pc_weights    : { schedule, todo, once, leisure, routine }
   pc_routine_meta : { <routineId>: { stopped: bool } }   // 루틴 중단 여부 추적

   "오늘"의 기준은 자정이 아니라 오전 4시. 즉 새벽 0~3시59분은
   전날의 연속으로 취급한다 (appToday 참고).
   ========================================================= */

const DAY_CUTOFF_HOUR = 4;

let problems = JSON.parse(localStorage.getItem('pc_problems') || '[]');
let days = JSON.parse(localStorage.getItem('pc_days') || '{}');
let weights = JSON.parse(localStorage.getItem('pc_weights') || 'null') || { schedule: 35, todo: 30, once: 20, leisure: 15, routine: 30 };
let routineMeta = JSON.parse(localStorage.getItem('pc_routine_meta') || '{}');

let editProblemId = null;
let deleteProblemId = null;
let editBlockId = null;
let deleteBlockId = null;
let deferredPrompt = null;
let reordering = false;

function appNow() {
  // 오전 4시를 하루의 시작으로 보는 "가상 현재 시각"
  const d = new Date();
  const shifted = new Date(d.getTime() - DAY_CUTOFF_HOUR * 60 * 60 * 1000);
  return shifted;
}
const TODAY_KEY = () => formatKey(appNow());
let viewingDateKey = TODAY_KEY();

const TYPE_LABEL = { schedule: '일정', once: '일회성', todo: '할일', leisure: '여가', routine: '루틴' };
const TIME_LABEL = { morning: '오전', afternoon: '오후', night: '밤' };

/* ---------- persistence helpers ---------- */
function saveProblems() { localStorage.setItem('pc_problems', JSON.stringify(problems)); }
function saveDays() { localStorage.setItem('pc_days', JSON.stringify(days)); }
function saveWeightsToStorage() { localStorage.setItem('pc_weights', JSON.stringify(weights)); }
function saveRoutineMeta() { localStorage.setItem('pc_routine_meta', JSON.stringify(routineMeta)); }

function formatKey(d) {
  const y = d.getFullYear(), m = String(d.getMonth()+1).padStart(2,'0'), day = String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
}
function keyToDate(k) { const [y,m,d] = k.split('-').map(Number); return new Date(y, m-1, d); }

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
  document.getElementById('tabBtn-problems').classList.toggle('active', tab === 'problems');
  document.getElementById('tabBtn-todo').classList.toggle('active', tab === 'todo');
  document.getElementById('page-problems').classList.toggle('hidden', tab !== 'problems');
  document.getElementById('page-todo').classList.toggle('hidden', tab !== 'todo');
  if (reordering) toggleReorder(); // exit reorder mode when switching tabs
}

function toggleReorder() {
  reordering = !reordering;
  document.body.classList.toggle('reordering', reordering);
  document.getElementById('reorderToggle').setAttribute('aria-pressed', reordering ? 'true' : 'false');
  renderProblems();
  renderBlocks();
}

/* =========================================================
   GENERIC OVERLAY HELPERS
   ========================================================= */
function closeOverlay(id) { document.getElementById(id).classList.remove('open'); }
function overlayClose(e, id) { if (e.target === document.getElementById(id)) closeOverlay(id); }

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    ['problemFormOverlay','blockFormOverlay','confirmOverlay','menuOverlay'].forEach(closeOverlay);
  }
});

/* =========================================================
   PROBLEM COUNTER TAB
   ========================================================= */
function renderProblems() {
  const el = document.getElementById('problemList');
  if (!problems.length) {
    el.innerHTML = `<div class="empty">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><rect x="3" y="3" width="18" height="18" rx="3"/><line x1="8" y1="12" x2="16" y2="12"/><line x1="12" y1="8" x2="12" y2="16"/></svg>
      <p>추가 버튼을 눌러<br>첫 카운터를 만들어보세요</p>
    </div>`;
    return;
  }
  el.innerHTML = problems.map((c, idx) => {
    const pct = c.total > 0 ? Math.round(c.solved / c.total * 100) : 0;
    const w = Math.min(100, pct);
    const atMin = c.solved <= 0;
    const atMax = c.solved >= c.total;
    return `<div class="card" data-id="${c.id}">
      <div class="reorder-handle">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
      </div>
      <div class="card-main">
        <div class="card-header">
          <div class="card-title-wrap"><div class="card-title">${esc(c.name)}</div></div>
          <div class="card-btns">
            <button class="icon-btn" onclick="openProblemEdit(${c.id})" aria-label="수정">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            </button>
            <button class="icon-btn" onclick="askDeleteProblem(${c.id})" aria-label="삭제">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
            </button>
          </div>
          <div class="move-btns">
            <button class="move-btn" onclick="moveProblem(${idx},-1)" ${idx===0?'disabled':''} aria-label="위로"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg></button>
            <button class="move-btn" onclick="moveProblem(${idx},1)" ${idx===problems.length-1?'disabled':''} aria-label="아래로"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg></button>
          </div>
        </div>
        <div class="card-body">
          <div class="ctrl-row">
            <button class="ctrl-btn" onclick="changeProblem(${c.id},-1)" ${atMin?'disabled':''} aria-label="감소">−</button>
            <div class="fraction" onclick="openProblemEdit(${c.id})">${c.solved}<span>/${c.total}</span></div>
            <button class="ctrl-btn" onclick="changeProblem(${c.id},1)" ${atMax?'disabled':''} aria-label="증가">+</button>
          </div>
          <div class="prog-wrap">
            <div class="prog-bar"><div class="prog-fill" style="width:${w}%"></div></div>
            <div class="prog-label">${pct}%</div>
          </div>
        </div>
      </div>
    </div>`;
  }).join('');
}

function changeProblem(id, d) {
  const c = problems.find(x => x.id === id);
  if (!c) return;
  c.solved = Math.max(0, Math.min(c.total, c.solved + d));
  saveProblems(); renderProblems();
}

function moveProblem(idx, dir) {
  const target = idx + dir;
  if (target < 0 || target >= problems.length) return;
  [problems[idx], problems[target]] = [problems[target], problems[idx]];
  saveProblems(); renderProblems();
}

function openProblemAdd() {
  editProblemId = null;
  document.getElementById('problemSheetTitle').textContent = '카운터 추가';
  document.getElementById('pfName').value = '';
  document.getElementById('pfTotal').value = '';
  document.getElementById('pfSolved').value = '0';
  document.getElementById('problemFormOverlay').classList.add('open');
  setTimeout(() => document.getElementById('pfName').focus(), 80);
}

function openProblemEdit(id) {
  const c = problems.find(x => x.id === id);
  if (!c) return;
  editProblemId = id;
  document.getElementById('problemSheetTitle').textContent = '카운터 수정';
  document.getElementById('pfName').value = c.name;
  document.getElementById('pfTotal').value = c.total;
  document.getElementById('pfSolved').value = c.solved;
  document.getElementById('problemFormOverlay').classList.add('open');
  setTimeout(() => document.getElementById('pfName').focus(), 80);
}

function submitProblemForm() {
  const name = document.getElementById('pfName').value.trim();
  const total = parseInt(document.getElementById('pfTotal').value);
  let solved = parseInt(document.getElementById('pfSolved').value) || 0;
  if (!name) { document.getElementById('pfName').focus(); return; }
  if (!total || total < 1) { document.getElementById('pfTotal').focus(); return; }
  solved = Math.max(0, Math.min(total, solved));
  if (editProblemId !== null) {
    const c = problems.find(x => x.id === editProblemId);
    if (c) { c.name = name; c.total = total; c.solved = solved; }
  } else {
    problems.push({ id: Date.now(), name, total, solved });
  }
  saveProblems(); renderProblems(); closeOverlay('problemFormOverlay');
}

function askDeleteProblem(id) {
  const c = problems.find(x => x.id === id);
  if (!c) return;
  deleteProblemId = id;
  document.getElementById('confirmMsg').innerHTML = `<strong>${esc(c.name)}</strong> 카운터를 삭제할까요?<br>이 작업은 되돌릴 수 없어요.`;
  document.getElementById('confirmOkBtn').onclick = () => {
    problems = problems.filter(x => x.id !== deleteProblemId);
    saveProblems(); renderProblems(); closeOverlay('confirmOverlay');
  };
  document.getElementById('confirmOverlay').classList.add('open');
}

/* =========================================================
   TODO TAB — date navigation
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
   BLOCKS (todo tab content)
   ========================================================= */
let selectedType = null, selectedTime = null, selectedProgress = null;

function selectSeg(groupId, btn) {
  const group = document.getElementById(groupId);
  group.querySelectorAll('.seg-btn').forEach(b => b.classList.remove('selected'));
  btn.classList.add('selected');
  if (groupId === 'bfTypeGroup') selectedType = btn.dataset.val;
  if (groupId === 'bfTimeGroup') selectedTime = btn.dataset.val;
  if (groupId === 'bfProgressGroup') selectedProgress = btn.dataset.val;
}

function toggleCustomTime() {
  document.getElementById('bfCustomTime').classList.toggle('hidden', selectedTime !== 'custom');
}

function toggleCounterFields() {
  document.getElementById('bfCounterFields').classList.toggle('hidden', selectedProgress !== 'counter');
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
  selectedType = null; selectedTime = null; selectedProgress = null;
  document.querySelectorAll('#bfTypeGroup .seg-btn, #bfTimeGroup .seg-btn, #bfProgressGroup .seg-btn').forEach(b => { b.classList.remove('selected'); b.disabled = false; });
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
  selectedType = b.type; selectedTime = b.time; selectedProgress = b.progressType;

  document.querySelectorAll('#bfTypeGroup .seg-btn').forEach(btn => {
    btn.classList.toggle('selected', btn.dataset.val === b.type);
    // 루틴 블록은 유형 전환 불가 (루틴 추적이 깨지는 걸 방지)
    btn.disabled = !!b.isRoutine && btn.dataset.val !== 'routine';
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

  document.getElementById('blockFormOverlay').classList.add('open');
  setTimeout(() => document.getElementById('bfName').focus(), 80);
}

function submitBlockForm() {
  const name = document.getElementById('bfName').value.trim();
  const desc = document.getElementById('bfDesc').value.trim();
  if (!name) { document.getElementById('bfName').focus(); return; }
  if (!selectedType) { showToast('유형을 선택해주세요'); return; }
  if (!selectedTime) { showToast('시간대를 선택해주세요'); return; }
  if (!selectedProgress) { showToast('진행 체크 방식을 선택해주세요'); return; }

  const customTime = document.getElementById('bfCustomTime').value;
  let total = null, current = null;
  if (selectedProgress === 'counter') {
    total = parseInt(document.getElementById('bfTotal').value);
    current = parseInt(document.getElementById('bfCurrent').value) || 0;
    if (!total || total < 1) { document.getElementById('bfTotal').focus(); return; }
    current = Math.max(0, Math.min(total, current));
  }

  const day = ensureDay(viewingDateKey);

  if (editBlockId !== null) {
    const b = day.blocks.find(x => x.id === editBlockId);
    if (b) {
      b.name = name; b.desc = desc; b.time = selectedTime;
      b.customTime = customTime; b.progressType = selectedProgress;
      // 루틴 ↔ 비루틴 전환은 막는다: 기존 타입이 루틴이면 유지, 아니면 선택값 사용
      if (b.isRoutine) {
        b.type = 'routine';
      } else {
        b.type = selectedType;
        if (selectedType === 'routine') {
          b.isRoutine = true;
          b.routineId = 'r' + Date.now() + Math.floor(Math.random()*1000);
          routineMeta[b.routineId] = { stopped: false };
          saveRoutineMeta();
        }
      }
      if (selectedProgress === 'counter') { b.total = total; b.current = current; }
      else if (selectedProgress === 'toggle') { if (b.done === undefined) b.done = false; }
    }
  } else {
    const block = {
      id: Date.now() + Math.floor(Math.random()*1000),
      name, desc, type: selectedType, time: selectedTime, customTime,
      progressType: selectedProgress
    };
    if (selectedProgress === 'counter') { block.total = total; block.current = current; }
    if (selectedProgress === 'toggle') { block.done = false; }
    if (selectedType === 'routine') {
      block.isRoutine = true;
      block.routineId = 'r' + Date.now() + Math.floor(Math.random()*1000);
      routineMeta[block.routineId] = { stopped: false };
      saveRoutineMeta();
    }
    day.blocks.push(block);
  }

  saveDays(); renderBlocks(); renderScore(); closeOverlay('blockFormOverlay');
}

function askDeleteBlock(id) {
  const day = ensureDay(viewingDateKey);
  const b = day.blocks.find(x => x.id === id);
  if (!b) return;
  deleteBlockId = id;
  const isRoutine = !!b.isRoutine;
  document.getElementById('confirmMsg').innerHTML = isRoutine
    ? `<strong>${esc(b.name)}</strong> 루틴을 삭제할까요?<br>오늘 이후로 더 이상 자동 추가되지 않아요.`
    : `<strong>${esc(b.name)}</strong> 블록을 삭제할까요?<br>이 작업은 되돌릴 수 없어요.`;
  document.getElementById('confirmOkBtn').onclick = () => {
    day.blocks = day.blocks.filter(x => x.id !== deleteBlockId);
    if (isRoutine && b.routineId) {
      routineMeta[b.routineId] = { stopped: true };
      saveRoutineMeta();
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

/* =========================================================
   ROUTINE: 자동 매일 복사 + 히트맵
   ========================================================= */
const HEATMAP_DAYS = 5;

function addDaysToKey(key, delta) {
  const d = keyToDate(key);
  d.setDate(d.getDate() + delta);
  return formatKey(d);
}

// 오늘 날짜에 살아있는(중단되지 않은) 루틴이 없으면, 가장 최근에 그 루틴이
// 존재했던 날짜의 블록을 찾아 오늘로 복사한다. 앱이 열릴 때마다 호출.
function syncRoutinesForToday() {
  const todayKey = TODAY_KEY();
  const today = ensureDay(todayKey);
  const existingRoutineIds = new Set(today.blocks.filter(b => b.isRoutine).map(b => b.routineId));

  // 활성 루틴 ID 전체 수집 (중단되지 않은 것만)
  const activeRoutineIds = Object.keys(routineMeta).filter(rid => !routineMeta[rid].stopped);
  let addedCount = 0;

  activeRoutineIds.forEach(rid => {
    if (existingRoutineIds.has(rid)) return; // 오늘 이미 있음

    // 과거 날짜들 중 이 루틴이 마지막으로 존재했던 블록을 찾는다 (최대 60일 역탐색)
    let template = null;
    for (let i = 1; i <= 60; i++) {
      const k = addDaysToKey(todayKey, -i);
      const dayObj = days[k];
      if (!dayObj) continue;
      const found = dayObj.blocks.find(b => b.routineId === rid);
      if (found) { template = found; break; }
    }
    if (!template) return; // 템플릿을 못 찾으면 (예: 데이터 정리됨) 스킵

    const nb = { ...template, id: Date.now() + Math.floor(Math.random()*100000) };
    if (nb.progressType === 'counter') nb.current = 0;
    if (nb.progressType === 'toggle') nb.done = false;
    today.blocks.push(nb);
    addedCount++;
  });

  if (addedCount > 0) saveDays();
  return addedCount;
}

// 특정 routineId의 최근 N일 달성률 배열을 반환 (오늘 포함, 과거→오늘 순서)
function getRoutineHeatmap(routineId, days_count) {
  const todayKey = TODAY_KEY();
  const result = [];
  for (let i = days_count - 1; i >= 0; i--) {
    const k = addDaysToKey(todayKey, -i);
    const dayObj = days[k];
    let frac = null; // null = 그 날 데이터 없음(루틴 시작 전 등)
    if (dayObj) {
      const b = dayObj.blocks.find(x => x.routineId === routineId);
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

function renderHeatmap(routineId) {
  const cells = getRoutineHeatmap(routineId, HEATMAP_DAYS);
  return `<div class="heatmap" role="img" aria-label="최근 ${HEATMAP_DAYS}일 달성도">
    ${cells.map(c => `<span class="hm-cell ${heatmapCellClass(c.frac)}" title="${c.key}${c.frac!=null ? ' · ' + Math.round(c.frac*100)+'%' : ''}"></span>`).join('')}
  </div>`;
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
    return `<div class="card block-card type-${b.type} ${complete && b.progressType!=='none' ? 'completed':''}" data-id="${b.id}">
      <div class="reorder-handle">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
      </div>
      <div class="card-main">
        <div class="card-header">
          <div class="card-title-wrap">
            <div class="card-title">${esc(b.name)}</div>
            <div class="card-sub"><span class="type-chip">${TYPE_LABEL[b.type]}</span><span class="time-chip">${timeLabelFor(b)}</span></div>
            ${b.isRoutine ? renderHeatmap(b.routineId) : ''}
          </div>
          <div class="card-btns">
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
      </div>
    </div>`;
  }).join('');
}

/* =========================================================
   YESTERDAY COPY
   ========================================================= */
function copyYesterday() {
  const d = keyToDate(viewingDateKey);
  d.setDate(d.getDate() - 1);
  const yKey = formatKey(d);
  const yDay = days[yKey];
  if (!yDay || !yDay.blocks.length) { showToast('어제 기록이 없어요'); return; }

  const today = ensureDay(viewingDateKey);
  // 루틴은 자동으로 매일 복사되므로 수동 복사 대상에서 제외 (중복 방지)
  const nonRoutine = yDay.blocks.filter(b => !b.isRoutine);
  if (!nonRoutine.length) { showToast('복사할 일반 블록이 없어요 (루틴은 자동으로 추가돼요)'); return; }

  const copied = nonRoutine.map(b => {
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
   SCORE CALCULATION
   ========================================================= */
function renderScore() {
  const day = ensureDay(viewingDateKey);
  const el = document.getElementById('scoreCard');
  const scorable = day.blocks.filter(b => b.progressType !== 'none');

  if (!scorable.length) {
    el.innerHTML = `<div class="score-top"><div class="score-num">—</div></div>
      <div class="score-feedback">진행 체크가 있는 블록을 추가하면 달성률이 표시돼요.</div>`;
    return;
  }

  let weightedSum = 0, weightTotal = 0;
  scorable.forEach(b => {
    const w = weights[b.type] ?? 25;
    const frac = blockProgressFraction(b);
    weightedSum += w * frac;
    weightTotal += w;
  });
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
  `;
}

/* =========================================================
   AUTO-ROLLOVER (오전 4시 기준)
   ========================================================= */
let lastKnownTodayKey = TODAY_KEY();

function checkMidnightRollover() {
  const today = TODAY_KEY();
  if (today !== lastKnownTodayKey) {
    // 가상의 날짜가 바뀌었다 (오전 4시를 넘김) — 새 날의 루틴을 동기화
    lastKnownTodayKey = today;
    const added = syncRoutinesForToday();
    if (viewingDateKey !== today) {
      // 과거 날짜를 보고 있었다면 그대로 유지, 점수/헤더만 갱신 불필요
    } else {
      renderBlocks();
    }
    if (added > 0 && viewingDateKey === today) showToast(`루틴 ${added}개가 오늘 목록에 추가됐어요`);
  }
  if (viewingDateKey === today) { renderDayHeader(); renderScore(); }
}
setInterval(checkMidnightRollover, 60 * 1000);

/* =========================================================
   MENU: backup / import / weights
   ========================================================= */
function openMenu() {
  document.getElementById('wSchedule').value = weights.schedule;
  document.getElementById('wTodo').value = weights.todo;
  document.getElementById('wOnce').value = weights.once;
  document.getElementById('wLeisure').value = weights.leisure;
  document.getElementById('wRoutine').value = weights.routine ?? 30;
  document.getElementById('menuOverlay').classList.add('open');
}

function saveWeights() {
  weights = {
    schedule: parseInt(document.getElementById('wSchedule').value) || 0,
    todo: parseInt(document.getElementById('wTodo').value) || 0,
    once: parseInt(document.getElementById('wOnce').value) || 0,
    leisure: parseInt(document.getElementById('wLeisure').value) || 0,
    routine: parseInt(document.getElementById('wRoutine').value) || 0,
  };
  saveWeightsToStorage();
  renderScore();
  closeOverlay('menuOverlay');
  showToast('가중치를 저장했어요');
}

function exportBackup() {
  const data = { problems, days, weights, routineMeta, exportedAt: new Date().toISOString() };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = formatKey(new Date());
  a.href = url; a.download = `counter-backup-${stamp}.json`;
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
      problems = Array.isArray(data.problems) ? data.problems : problems;
      days = (data.days && typeof data.days === 'object') ? data.days : days;
      weights = (data.weights && typeof data.weights === 'object') ? data.weights : weights;
      routineMeta = (data.routineMeta && typeof data.routineMeta === 'object') ? data.routineMeta : routineMeta;
      saveProblems(); saveDays(); saveWeightsToStorage(); saveRoutineMeta();
      syncRoutinesForToday();
      renderProblems(); renderDayHeader(); renderBlocks(); renderScore();
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
syncRoutinesForToday();
renderProblems();
renderDayHeader();
renderBlocks();
renderScore();
