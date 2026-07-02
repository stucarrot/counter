/* =========================================================
   STORAGE SCHEMA
   pc_days        : { "2026-06-17": { blocks:[...], watchBlocks:[...], miniAlarms:[...] }, ... }
     miniAlarm (미니 시간 알림): { id, title, time("HH:MM"), fired: bool }
       // 제목+시간만 있는 아주 작은 1줄 블록. 실제 시계가 그 시각이 되면 알림을 띄우고 fired를 true로
       // 바꿔 하루에 한 번만 울리게 한다. 날짜별로 독립적이라 자동 이월되지 않는다.
     block (할일): { id, name, desc, type, time, customTimeEntries?, progressType,
       total?, current?, done?, carryover, carryoverId?, sessions? }
       (customTimeEntries: [{ time:"HH:MM", modifier: 'before'|'after'|'exact' }] —
        time이 'custom'일 때만 쓰임. before/after가 정확히 1개씩이면 자동으로 시간대
        범위로 표시되고, 그 외에는 각 항목이 따로 나열된다. 구버전 데이터는 customTime
        문자열 하나만 있을 수 있으며 이 경우 단일 'exact' 항목으로 취급한다.)
     watchBlock (감상): { id, name, author, year?, type(book/movie/series/etc), progress(0~100),
       seriesTotal?, seriesCurrent? (type이 series일 때만 — 진행도는 할일 블록과 같은 카운터 방식이고
       progress는 round(seriesCurrent/seriesTotal*100)으로 항상 동기화된다),
       focusRatio(0~100, 5단위)?, ratingPresetId?(어떤 평가 프리셋을 쓰는지),
       ratings?: { [criterionId]: 0~5(0.5단위) },
       archived: bool, watchChainId: string, memos: [{id,text,time}] }
   pc_watch_rating_presets: [ {id, name, criteria:[{id,name}]}, ... ]
     // 감상 블록 "평가" 프리셋 — 유형과 무관하게 사용자가 이름을 정해 자유롭게 만들고,
     // 감상 블록마다(유형 선택과는 별개로) 그중 하나를 지정해서 쓴다.
   pc_carryover_meta  : { <carryoverId>: { stopped: bool } }   // 할일 이행/루틴 체인
   pc_watch_chain_meta: { <watchChainId>: { stopped: bool } }  // 감상 이월 체인
   pc_memos       : { "2026-06-17": [{id, text, time}], ... }  // 메모 탭
   pc_active_timer: { dateKey, blockId, startedAt(ISOString), accumulatedMs, paused: bool } | null
   pc_plan_blocks : [ planBlock, ... ]   // 계획 탭 — 날짜에 속하지 않는 전역 목록
     planBlock: { id, name, desc, type, progressType, total?, current?, done?,
       timeUnspecified: bool, customDateEntries?: [{date, modifier(before/after/exact)}], timeStart?, timeEnd?, order }
       // customDateEntries는 할일 블록의 "시간 지정"과 같은 방식 — before/after가 1개씩이면 자동으로
       // 하나의 기간(이후~이전)으로 인식되고, 그 외엔 각각 개별 날짜로 표시된다.
   pc_period_plans: [ periodPlan, ... ]  // 기간계획 블록
     periodPlan: { id, mode(month/week/range), dateStart, dateEnd, desc,
       refs: [{ kind: 'plan'|'todo', id, dateKey? }], order }
     (todo 참조는 특정 날짜의 할일 블록이라 dateKey가 필요하고, plan 참조는 전역
      목록이라 dateKey가 필요 없다.)

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
let carryoverMeta = JSON.parse(localStorage.getItem('pc_carryover_meta') || '{}');
let watchChainMeta = JSON.parse(localStorage.getItem('pc_watch_chain_meta') || '{}');
let memos = JSON.parse(localStorage.getItem('pc_memos') || '{}');
// 고정 메모 — 날짜와 무관하게 메모 탭 상단에 공지처럼 항상 떠 있는 메모. 최대 3개.
// 각 항목은 원본 메모를 정확히 찾기 위해 { memoId, dateKey }로 저장한다.
let pinnedMemos = JSON.parse(localStorage.getItem('pc_pinned_memos') || '[]');
let activeTimer = JSON.parse(localStorage.getItem('pc_active_timer') || 'null');
// 절제(abstain) 블록 전용 시간재기 — 보조 집중타이머(activeTimer)와는 완전히 별개라
// 동시에 둘 다 돌릴 수 있다. 일시정지 없이 단순 시작/정지만 지원 (카드에서 원클릭 조작).
let activeAbstainTimers = JSON.parse(localStorage.getItem('pc_active_abstain_timers') || '{}'); // { [blockId]: { dateKey, startedAt } }
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
// 감상 블록 유형별 "평가" 기준 프리셋 — 사용자가 유형별로 자유롭게 평가 항목 이름을 추가한다.
// { book: [{id,name}], movie: [...], series: [...], etc: [...] }
// 감상 블록 "평가" 기준 프리셋 — 유형과 무관하게 사용자가 이름을 정해 만들어두고,
// 감상 블록 생성/수정 시 그중 하나를 골라 지정한다. [{id, name, criteria:[{id,name}]}]
let watchRatingPresets = JSON.parse(localStorage.getItem('pc_watch_rating_presets') || '[]');

let editBlockId = null;
let deleteBlockId = null;
let postponeBlockId = null;
let deferredPrompt = null;
let reordering = false;
let simpleView = localStorage.getItem('pc_simple_view') === '1'; // 간단 보기(2열 압축) 모드
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
let pendingWatchRatings = {}; // 감상 폼 작성 중 임시로 들고 있는 평가 값들 { [criterionId]: 0~5(0.5단위) }
let pendingWatchRatingPresetId = null; // 감상 폼에서 선택 중인 평가 프리셋 id (null이면 미지정)
let editPlanId = null;
let deletePlanId = null;
let selectedPlanType = null, selectedPlanTimeMode = null, selectedPlanProgress = null;
let currentPlanSubtab = 'time';
let currentWatchSubtab = 'ongoing'; // 'ongoing' | 'planned' | 'archive' | 'list'
let editWatchListId = null;
let deleteWatchListId = null;
let pendingWatchListRefs = []; // 감상 목록 폼 작성 중 임시로 들고 있는 참조 목록
let creatingWatchForList = false; // 감상 목록 폼 안에서 "새 감상 만들고 참조하기"로 감상 폼을 띄운 상태인지
let searchScope = 'all'; // 'all' | 'plan' | 'todo' | 'watch' — 블록 검색 시트의 현재 범위
let editPeriodId = null;
let selectedPeriodMode = null;
let pendingPlanDateEntries = []; // 계획 폼 작성 중 임시로 들고 있는 날짜 항목들 [{date, modifier}] (할일 블록의 시간 지정과 동일한 방식)
let pendingPeriodRefs = []; // 기간계획 폼 작성 중 임시로 들고 있는 참조 목록
let creatingPlanForPeriod = false; // 기간계획 폼 안에서 "새 계획 만들고 참조하기"로 계획 폼을 띄운 상태인지
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
const WATCH_TYPE_LABEL = { book: '독서', movie: '영화', series: '시리즈', etc: '기타' };

// 구버전 호환: 예전엔 유형(book/movie/...)에 프리셋이 자동으로 귀속되는 방식이었다.
// { book:[...], movie:[...] } 형태(객체)로 저장돼 있으면 유형 이름을 딴 독립 프리셋들로 변환한다.
if (watchRatingPresets && !Array.isArray(watchRatingPresets)) {
  const converted = [];
  Object.keys(watchRatingPresets).forEach(typeKey => {
    const criteria = watchRatingPresets[typeKey];
    if (Array.isArray(criteria) && criteria.length) {
      converted.push({ id: 'rp_' + typeKey + '_' + Date.now() + Math.floor(Math.random()*1000), name: WATCH_TYPE_LABEL[typeKey] || typeKey, criteria });
    }
  });
  watchRatingPresets = converted;
  localStorage.setItem('pc_watch_rating_presets', JSON.stringify(watchRatingPresets));
}

/* ---------- persistence helpers ---------- */
function saveDays() {
  localStorage.setItem('pc_days', JSON.stringify(days));
}
function saveCarryoverMeta() { localStorage.setItem('pc_carryover_meta', JSON.stringify(carryoverMeta)); }
function saveWatchChainMeta() { localStorage.setItem('pc_watch_chain_meta', JSON.stringify(watchChainMeta)); }
function saveMemos() { localStorage.setItem('pc_memos', JSON.stringify(memos)); }
function savePinnedMemos() { localStorage.setItem('pc_pinned_memos', JSON.stringify(pinnedMemos)); }
function savePlanBlocks() { localStorage.setItem('pc_plan_blocks', JSON.stringify(planBlocks)); }
function savePeriodPlans() { localStorage.setItem('pc_period_plans', JSON.stringify(periodPlans)); }
function saveWatchArchiveItems() { localStorage.setItem('pc_watch_archive_items', JSON.stringify(watchArchiveItems)); }
function saveWatchPlannedItems() { localStorage.setItem('pc_watch_planned_items', JSON.stringify(watchPlannedItems)); }
function saveWatchLists() { localStorage.setItem('pc_watch_lists', JSON.stringify(watchLists)); }
function saveWatchRatingPresets() { localStorage.setItem('pc_watch_rating_presets', JSON.stringify(watchRatingPresets)); }
function saveActiveTimer() {
  if (activeTimer) localStorage.setItem('pc_active_timer', JSON.stringify(activeTimer));
  else localStorage.removeItem('pc_active_timer');
}
function saveActiveAbstainTimers() {
  localStorage.setItem('pc_active_abstain_timers', JSON.stringify(activeAbstainTimers));
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
  if (!days[key].miniAlarms) days[key].miniAlarms = [];
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

  // 간단 보기는 블록 카드를 쓰는 계획/할일/감상 탭에서만 의미가 있고, 메모 탭에는 적용 대상이 없다.
  const showSimpleView = currentTab !== 'memo';
  document.getElementById('simpleViewToggle').classList.toggle('reorder-toggle-hidden', !showSimpleView);
}

function switchTab(tab) {
  checkMidnightRollover(); // 탭을 바꿔서 볼 때마다 날짜가 넘어가 있었는지 한 번 더 확인 (이월 누락 방지)
  currentTab = tab;
  ['plan','todo','watch','memo'].forEach(t => {
    document.getElementById(`tabBtn-${t}`).classList.toggle('active', tab === t);
    document.getElementById(`page-${t}`).classList.toggle('hidden', tab !== t);
  });
  updateReorderButtonVisibility();
  updateSimpleViewGrid();
  if (tab === 'memo') {
    renderMemoHeader();
    renderPinnedMemos();
    renderMemos();
  } else if (tab === 'watch') {
    renderWatchHeader();
    renderWatchBlocks();
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
   SIMPLE VIEW (간단 보기)
   기간계획을 제외한, 블록 카드를 쓰는 모든 목록(할일/계획-시간순·미지정/감상 전체 서브탭)에
   적용 가능한 2열 압축 보기. 목록 컨테이너에 'grid-2col' 클래스를 붙이면 CSS가 2열 그리드로
   바꾸고 부가 버튼/상태를 숨긴다 — 숨겨지는 요소는 실제로 삭제되는 게 아니라 CSS로만 가려지므로,
   카드를 탭하면 그 카드의 DOM을 그대로 복제해 상세 오버레이에 넣어 전체 모습을 보여줄 수 있다.
   ========================================================= */
function toggleSimpleView() {
  simpleView = !simpleView;
  localStorage.setItem('pc_simple_view', simpleView ? '1' : '0');
  document.getElementById('simpleViewToggle').setAttribute('aria-pressed', simpleView ? 'true' : 'false');
  document.getElementById('simpleViewToggle').classList.toggle('active', simpleView);
  if (simpleView && reordering) toggleReorder(); // 압축 보기에서는 순서변경 손잡이가 가려지므로 같이 꺼준다
  updateSimpleViewGrid();
}

function updateSimpleViewGrid() {
  const blockListEl = document.getElementById('blockList');
  if (blockListEl) blockListEl.classList.toggle('grid-2col', simpleView);

  // 계획 탭은 '기간계획' 서브탭일 때만 예외 — 그 카드는 압축 대상에서 제외한다.
  const planListEl = document.getElementById('planList');
  if (planListEl) planListEl.classList.toggle('grid-2col', simpleView && currentPlanSubtab !== 'period');

  const watchListEl = document.getElementById('watchList');
  if (watchListEl) watchListEl.classList.toggle('grid-2col', simpleView);
}

// 압축 모드에서 카드의 "빈 영역"(버튼/입력 요소가 아닌 곳)을 탭하면 상세 오버레이를 띄운다.
// 카드 자체에 실제 기능이 있는 요소(버튼/체크박스/입력창 등)를 눌렀을 때는 그 요소의 동작만
// 실행되고 오버레이는 뜨지 않는다.
function handleCardTap(e, cardEl) {
  if (!cardEl.closest('.grid-2col')) return; // 압축 보기가 아니면(기간계획 등) 평소처럼 아무 동작 없음
  if (e.target.closest('button, input, label, a')) return;
  openCardDetail(cardEl);
}

function openCardDetail(cardEl) {
  const body = document.getElementById('cardDetailBody');
  body.innerHTML = '';
  const clone = cardEl.cloneNode(true);
  clone.removeAttribute('onclick'); // 오버레이 안에서는 다시 압축 판정을 하지 않아도 되므로 제거
  body.appendChild(clone);
  document.getElementById('cardDetailOverlay').classList.add('open');
}

/* =========================================================
   GENERIC OVERLAY HELPERS
   ========================================================= */
function closeOverlay(id) { document.getElementById(id).classList.remove('open'); }
function overlayClose(e, id) { if (e.target === document.getElementById(id)) closeOverlay(id); }

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    ['blockFormOverlay','confirmOverlay','menuOverlay','timerOverlay','feedbackOverlay','watchFormOverlay','watchProgressOverlay','watchMemoOverlay','planFormOverlay','periodFormOverlay','refPickerOverlay','importPopupOverlay','spendOverlay','searchOverlay','cardDetailOverlay','miniAlarmFormOverlay','watchRatingPresetPickerOverlay'].forEach(closeOverlay);
    closeMemoArchive();
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
}

function jumpToday() {
  viewingDateKey = TODAY_KEY();
  renderDayHeader();
  renderBlocks();
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
let selectedBlockColor = null; // 블록 폼에서 고른 커스텀 색(hex) — null이면 유형 기본색 사용
const BLOCK_COLOR_PRESETS = ['#e0575c','#f0973f','#f0c93f','#5cb85c','#3fb6a8','#4a90e2','#8a6de0','#e05fc0','#8d8d93'];
let pendingCustomTimeEntries = []; // 블록 폼 작성 중 임시로 들고 있는 시간 지정 항목들 [{time, modifier}]

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

  // 절제는 항상 최상단에 고정 표시되는 유형이라 시간대 지정 자체가 의미 없어 선택지를 숨기고
  // '미지정'으로 강제한다 (시간 지정/쪼개기 부가 필드도 함께 정리).
  const timeField = document.getElementById('bfTimeField');
  if (selectedType === 'abstain') {
    timeField.classList.add('hidden');
    selectedTime = 'none';
    document.querySelectorAll('#bfTimeGroup .seg-btn').forEach(b => b.classList.toggle('selected', b.dataset.val === 'none'));
    pendingCustomTimeEntries = [];
    toggleCustomTime();
    toggleSplitFields();
  } else {
    timeField.classList.remove('hidden');
  }

  // 절제는 항상 반전(검정 배경) 배색이 고정이라 색상 지정 필드는 의미가 없어 숨긴다.
  document.getElementById('bfColorField').classList.toggle('hidden', selectedType === 'abstain');

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
  document.getElementById('bfCustomTimeField').classList.toggle('hidden', selectedTime !== 'custom');
}

/* =========================================================
   CUSTOM TIME ENTRIES (블록의 "시간 지정" 다중 시각 추가)
   시간 하나를 고르고 '이전'/'이후'/'그냥추가' 중 하나로 등록한다. 여러 번 추가할 수 있고,
   '이전'과 '이후'는 자동 시간대 인식이 항상 명확하도록 각각 최대 1개까지만 허용한다.
   ========================================================= */
function addCustomTimeEntry(modifier) {
  const input = document.getElementById('bfCustomTimeInput');
  const time = input.value;
  if (!time) { showToast('시간을 먼저 선택해주세요'); return; }
  if (modifier !== 'exact') {
    const label = modifier === 'before' ? '이전' : '이후';
    if (pendingCustomTimeEntries.some(e => e.modifier === modifier)) {
      showToast(`'${label}'은 한 개만 추가할 수 있어요. 기존 항목을 먼저 지워주세요`);
      return;
    }
  }
  pendingCustomTimeEntries.push({ time, modifier });
  renderCustomTimeList();
}

function removeCustomTimeEntry(idx) {
  pendingCustomTimeEntries.splice(idx, 1);
  renderCustomTimeList();
}

function renderCustomTimeList() {
  const el = document.getElementById('bfCustomTimeList');
  if (!pendingCustomTimeEntries.length) { el.innerHTML = ''; return; }
  const modLabel = { before: '이전', after: '이후', exact: '단일' };
  el.innerHTML = pendingCustomTimeEntries.map((e, idx) => `
    <div class="custom-time-chip">
      <span>${e.time} ${modLabel[e.modifier]}</span>
      <button onclick="removeCustomTimeEntry(${idx})" aria-label="제거">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>
  `).join('');
}

/* =========================================================
   PLAN BLOCK DATE ENTRIES (계획 블록의 "날짜" 다중 항목 추가)
   할일 블록의 "시간 지정"과 완전히 같은 방식 — 날짜 하나를 고르고 '이전'/'이후'/'그냥추가' 중
   하나로 등록한다. '이전'과 '이후'가 각각 정확히 1개씩이면 자동으로 하나의 기간(이후~이전)으로
   인식되고, 그 외의 경우(단독 이전/이후, 여러 개의 그냥추가)는 각각 따로 표시된다.
   ========================================================= */
function addPlanDateEntry(modifier) {
  const input = document.getElementById('pfDateInput');
  const date = input.value;
  if (!date) { showToast('날짜를 먼저 선택해주세요'); return; }
  if (modifier !== 'exact') {
    const label = modifier === 'before' ? '이전' : '이후';
    if (pendingPlanDateEntries.some(e => e.modifier === modifier)) {
      showToast(`'${label}'은 한 개만 추가할 수 있어요. 기존 항목을 먼저 지워주세요`);
      return;
    }
  }
  pendingPlanDateEntries.push({ date, modifier });
  renderPlanDateList();
}

function removePlanDateEntry(idx) {
  pendingPlanDateEntries.splice(idx, 1);
  renderPlanDateList();
}

function renderPlanDateList() {
  const el = document.getElementById('pfDateList');
  if (!pendingPlanDateEntries.length) { el.innerHTML = ''; return; }
  const modLabel = { before: '이전', after: '이후', exact: '단일' };
  el.innerHTML = pendingPlanDateEntries.map((e, idx) => `
    <div class="custom-time-chip">
      <span>${e.date} ${modLabel[e.modifier]}</span>
      <button onclick="removePlanDateEntry(${idx})" aria-label="제거">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>
  `).join('');
}

// 날짜 항목들을 화면에 표시할 문자열로 변환 (formatCustomTimeEntries와 동일한 규칙).
// before/after가 정확히 1개씩이면 그 둘을 묶어 "07.01~07.10" 기간으로 표시하고,
// 나머지(단독 before/after, 모든 exact)는 각각 따로 나열한다.
function formatPlanDateEntries(entries) {
  if (!entries || !entries.length) return '';
  const befores = entries.filter(e => e.modifier === 'before');
  const afters = entries.filter(e => e.modifier === 'after');
  const exacts = entries.filter(e => e.modifier === 'exact' || !e.modifier);

  const parts = [];
  if (befores.length === 1 && afters.length === 1) {
    parts.push(`${afters[0].date} ~ ${befores[0].date}`);
  } else {
    befores.forEach(e => parts.push(`${e.date} 이전`));
    afters.forEach(e => parts.push(`${e.date} 이후`));
  }
  exacts.forEach(e => parts.push(e.date));
  return parts.join(', ');
}

// 정렬/그룹핑에 쓸 대표 날짜 — 등록된 날짜 중 가장 빠른 날짜(이전/이후/단일 구분 없이).
function earliestPlanDate(entries) {
  if (!entries || !entries.length) return '';
  return entries.map(e => e.date).sort()[0];
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
  document.getElementById('bfCustomTimeInput').value = '';
  document.getElementById('bfCustomTimeField').classList.add('hidden');
  pendingCustomTimeEntries = [];
  renderCustomTimeList();
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
  selectBlockColor('');
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
  // 절제는 시간대 지정이 불가능한 유형이라, 과거에 시간이 지정되어 있던 데이터라도
  // 수정 화면에서는 항상 '미지정'으로 강제해서 보여준다 (저장하면 그대로 정리됨).
  selectedType = b.type; selectedTime = (b.type === 'abstain') ? 'none' : (b.time || 'none'); selectedProgress = b.progressType;
  selectBlockColor(b.color || '');

  document.querySelectorAll('#bfTypeGroup .seg-btn').forEach(btn => {
    btn.classList.toggle('selected', btn.dataset.val === b.type);
    // 루틴 블록은 다른 유형으로 전환 불가 (이행 체인 추적이 깨지는 걸 방지)
    btn.disabled = b.type === 'routine' && btn.dataset.val !== 'routine';
  });
  document.querySelectorAll('#bfTimeGroup .seg-btn').forEach(btn => btn.classList.toggle('selected', btn.dataset.val === selectedTime));
  document.querySelectorAll('#bfProgressGroup .seg-btn').forEach(btn => btn.classList.toggle('selected', btn.dataset.val === b.progressType));

  const timerBtn = document.getElementById('bfProgressTimerBtn');
  const toggleBtn = document.querySelector('#bfProgressGroup .seg-btn[data-val="toggle"]');
  const noneBtn = document.querySelector('#bfProgressGroup .seg-btn[data-val="none"]');
  const totalLabel = document.getElementById('bfTotalLabel');
  const timeField = document.getElementById('bfTimeField');
  if (b.type === 'abstain') {
    timerBtn.classList.remove('hidden');
    toggleBtn.classList.add('hidden');
    noneBtn.classList.add('hidden');
    totalLabel.textContent = '상한 수';
    timeField.classList.add('hidden');
  } else {
    timerBtn.classList.add('hidden');
    toggleBtn.classList.remove('hidden');
    noneBtn.classList.remove('hidden');
    totalLabel.textContent = '목표 수';
    timeField.classList.remove('hidden');
  }

  document.getElementById('bfCustomTimeField').classList.toggle('hidden', selectedTime !== 'custom');
  document.getElementById('bfCustomTimeInput').value = '';
  if (b.type === 'abstain') {
    pendingCustomTimeEntries = [];
  } else if (b.customTimeEntries && b.customTimeEntries.length) {
    pendingCustomTimeEntries = b.customTimeEntries.map(e => ({ ...e }));
  } else if (b.customTime) {
    // 구버전 데이터(단일 문자열 시각) — 수정 화면에서는 '단일' 항목 하나로 보여준다
    pendingCustomTimeEntries = [{ time: b.customTime, modifier: 'exact' }];
  } else {
    pendingCustomTimeEntries = [];
  }
  renderCustomTimeList();

  // 쪼개기 필드 초기화
  splitDates = (b.splitDates || []).map(sd => ({ ...sd }));
  const isSplit = selectedTime === 'split';
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
  // 절제는 시간대 지정이 불가능한 유형 — UI에서 이미 강제하고 있지만 방어적으로 한 번 더 고정한다.
  if (selectedType === 'abstain') { selectedTime = 'none'; pendingCustomTimeEntries = []; }

  const customTimeEntries = selectedTime === 'custom' ? pendingCustomTimeEntries.slice() : [];
  if (selectedTime === 'custom' && !customTimeEntries.length) {
    showToast('추가한 시간이 없어요. 시간을 고르고 이전/이후/그냥추가를 눌러주세요');
    return;
  }
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
      b.name = name; b.desc = desc; b.time = selectedTime; b.customTimeEntries = customTimeEntries;
      delete b.customTime; // 구버전 단일 문자열 필드는 더 이상 사용하지 않음
      b.progressType = selectedProgress;
      if (selectedBlockColor) b.color = selectedBlockColor; else delete b.color;
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
      name, desc, type: selectedType, time: selectedTime, customTimeEntries,
      progressType: selectedProgress, sessions: []
    };
    if (selectedBlockColor) block.color = selectedBlockColor;
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

  saveDays(); renderBlocks(); closeOverlay('blockFormOverlay');
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
    saveDays(); renderBlocks(); closeOverlay('confirmOverlay');
  };
  document.getElementById('confirmOverlay').classList.add('open');
}

function changeBlockCounter(id, delta) {
  const day = ensureDay(viewingDateKey);
  const b = day.blocks.find(x => x.id === id);
  if (!b) return;
  b.current = Math.max(0, b.current + delta); // 초과달성 허용: 상한 없음
  saveDays(); renderBlocks();
}

function toggleBlockDone(id) {
  const day = ensureDay(viewingDateKey);
  const b = day.blocks.find(x => x.id === id);
  if (!b) return;
  b.done = !b.done;
  // 완료로 체크하는 순간, 그 블록의 시간재기가 꺼지지 않은 채로 남아있었다면(진행 중이든 일시정지든)
  // 자동으로 멈추고 그때까지 잰 시간을 기록한다.
  if (b.done && activeTimer && activeTimer.blockId === id) {
    const elapsedMs = stopActiveTimerForBlock(b, id);
    if (elapsedMs >= 1000) showToast(`완료 처리되어 시간재기도 함께 멈췄어요 (${formatDurationShort(elapsedMs)})`);
  }
  saveDays(); renderBlocks();
}

// 시트가 열려있지 않아도(카드에서 직접 완료 토글하는 경우) 안전하게 타이머를 멈추고 세션을 기록한다.
// timerStop()은 타이머 시트가 열려있다는 전제(timerBlockId, 화면 갱신)로 동작해서 여기선 따로 둔다.
// 반환값: 이번에 기록된 경과시간(ms) — 호출 측에서 안내 메시지 등에 재사용할 수 있게.
function stopActiveTimerForBlock(block, blockId) {
  const elapsedMs = currentElapsedMs();
  if (elapsedMs >= 1000) {
    const endTime = new Date();
    const startTime = new Date(endTime.getTime() - elapsedMs);
    if (!block.sessions) block.sessions = [];
    block.sessions.push({ start: startTime.toISOString(), end: endTime.toISOString() });
  }
  activeTimer = null;
  saveActiveTimer();
  // 타이머 시트가 이 블록을 보고 있는 채로 열려 있었다면 그 화면도 같이 갱신
  if (timerBlockId === blockId) renderTimerSheet();
  return elapsedMs;
}

// 블록의 정렬 그룹 키를 문자열로 반환. 절제(abstain) 타입은 시간대와 무관하게
// 항상 최상단 고정 그룹("abstain")이고, 그 외에는 완료여부+시간대그룹으로 묶인다.
// 같은 키를 가진 블록들끼리만 수동으로 순서를 바꿀 수 있다 — 그룹이 다르면 자동 정렬 규칙이 항상 우선한다.
function blockSortGroupKey(b) {
  if (b.type === 'abstain') return 'abstain';
  const done = (b.progressType !== 'none' && isBlockComplete(b)) ? 1 : 0;
  return `${done}-${timeSlotGroup(b)}`;
}

// 그룹 키를 정렬 순서가 있는 숫자 배열로 변환해 비교 가능하게 만든다.
// abstain은 [-1]로 항상 가장 앞, 그 외는 [완료여부, 시간대그룹] 순서.
function blockSortGroupRank(b) {
  if (b.type === 'abstain') return [-1, 0];
  const done = (b.progressType !== 'none' && isBlockComplete(b)) ? 1 : 0;
  return [done, timeSlotGroup(b)];
}

function compareBlockGroups(a, b) {
  const ra = blockSortGroupRank(a), rb = blockSortGroupRank(b);
  if (ra[0] !== rb[0]) return ra[0] - rb[0];
  return ra[1] - rb[1];
}

// 화면에 보이는 순서(렌더링과 동일한 정렬)대로 늘어놓은 블록 배열을 반환.
function getSortedVisibleBlocks(day) {
  const withIdx = day.blocks.map((b, realIdx) => ({ b, realIdx }));
  withIdx.sort((x, y) => {
    const groupCmp = compareBlockGroups(x.b, y.b);
    if (groupCmp !== 0) return groupCmp;
    return x.realIdx - y.realIdx;
  });
  return withIdx.map(x => x.b);
}

function moveBlock(id, dir) {
  const day = ensureDay(viewingDateKey);
  // 화면에 보이는 순서(자동 정렬 결과) 기준으로 바로 위/아래 칸의 블록을 찾는다.
  const visible = getSortedVisibleBlocks(day);
  const visibleIdx = visible.findIndex(b => b.id === id);
  if (visibleIdx === -1) return;
  const targetVisibleIdx = visibleIdx + dir;
  if (targetVisibleIdx < 0 || targetVisibleIdx >= visible.length) return;

  const current = visible[visibleIdx];
  const target = visible[targetVisibleIdx];
  // 완료여부/시간대 그룹이 다르면 자동 정렬 규칙을 어기는 이동이므로 조용히 무시한다
  // (예: 오전 블록을 오후 블록 자리로, 미완료를 완료 영역으로 옮기려는 시도).
  if (blockSortGroupKey(current) !== blockSortGroupKey(target)) {
    showToast('다른 시간대/완료 영역으로는 순서를 바꿀 수 없어요');
    return;
  }

  // 실제 데이터 배열(day.blocks)에서 두 블록의 위치를 찾아 swap한다.
  const realA = day.blocks.findIndex(b => b.id === current.id);
  const realB = day.blocks.findIndex(b => b.id === target.id);
  [day.blocks[realA], day.blocks[realB]] = [day.blocks[realB], day.blocks[realA]];
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

  saveDays(); renderBlocks(); closeOverlay('postponeOverlay');
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

// 시간 지정 항목들을 화면에 표시할 문자열로 변환.
// before/after가 정확히 1개씩이면 그 둘을 묶어 "09:00~10:00" 범위로 표시하고,
// 나머지(단독 before/after, 모든 exact)는 각각 따로 나열한다.
function formatCustomTimeEntries(entries) {
  if (!entries || !entries.length) return '';
  const befores = entries.filter(e => e.modifier === 'before');
  const afters = entries.filter(e => e.modifier === 'after');
  const exacts = entries.filter(e => e.modifier === 'exact' || !e.modifier);

  const parts = [];
  if (befores.length === 1 && afters.length === 1) {
    // 자동으로 시간대 인식: 이후 시각 ~ 이전 시각
    parts.push(`${afters[0].time}~${befores[0].time}`);
  } else {
    befores.forEach(e => parts.push(`${formatHourLabel(e.time)} 이전`));
    afters.forEach(e => parts.push(`${formatHourLabel(e.time)} 이후`));
  }
  exacts.forEach(e => parts.push(e.time));
  return parts.join(', ');
}

// "10:00" → "10시", "10:30" → "10:30" (정시가 아니면 그대로 표시)
function formatHourLabel(time) {
  const [h, m] = time.split(':');
  return m === '00' ? `${parseInt(h)}시` : time;
}

function timeLabelFor(b) {
  if (b.time === 'custom') {
    if (b.customTimeEntries && b.customTimeEntries.length) return formatCustomTimeEntries(b.customTimeEntries);
    if (b.customTime) return b.customTime; // 구버전 데이터(단일 문자열) 호환
  }
  return TIME_LABEL[b.time] || '';
}

/* =========================================================
   TIME-SLOT GROUPING (할일 카드 정렬용)
   각 블록을 오전(0) / 오후(1) / 밤(2) / 시간미지정(3) 네 그룹 중 하나로 분류한다.
   - morning/afternoon/night 타입은 그 자체로 그룹이 정해진다.
   - custom(시간 지정) 타입은 등록된 모든 시각(이전/이후/단독 구분 없이) 중
     가장 빠른 시각을 기준으로, 그 시각이 속한 시간대를 그룹으로 삼는다.
     경계: 오전 04:00~11:59, 오후 12:00~17:59, 밤 18:00~익일 03:59(자정 걸침).
   - split/none 등 구체 시각이 없는 나머지는 시간미지정(3)으로 분류한다.
   ========================================================= */
const TIME_SLOT_ORDER = { morning: 0, afternoon: 1, night: 2 };

function hourMinuteToSlot(h) {
  if (h >= 4 && h < 12) return 0;  // 오전
  if (h >= 12 && h < 18) return 1; // 오후
  return 2;                         // 밤 (18~23시 또는 0~3시)
}

function earliestCustomTimeMinutes(b) {
  let entries = null;
  if (b.customTimeEntries && b.customTimeEntries.length) entries = b.customTimeEntries;
  else if (b.customTime) entries = [{ time: b.customTime }];
  if (!entries || !entries.length) return null;
  let earliest = null;
  entries.forEach(e => {
    const [h, m] = e.time.split(':').map(Number);
    const mins = h * 60 + m;
    if (earliest === null || mins < earliest) earliest = mins;
  });
  return earliest;
}

function timeSlotGroup(b) {
  if (b.time === 'morning' || b.time === 'afternoon' || b.time === 'night') {
    return TIME_SLOT_ORDER[b.time];
  }
  if (b.time === 'custom') {
    const mins = earliestCustomTimeMinutes(b);
    if (mins !== null) return hourMinuteToSlot(Math.floor(mins / 60));
  }
  return 3; // 시간미지정 (split, none, 또는 custom인데 등록된 시각이 없는 경우)
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
/* =========================================================
   ACTIVE TIMER BANNER
   할일/절제 시간재기가 실행 중이면 블록 목록 위 알림 영역에 별도로 떠서, 어느 블록을
   보고 있든 한눈에 진행 상황을 볼 수 있게 한다. 일시정지(보조 타이머만 가능)는 옅은 색으로
   계속 떠 있고, 완전히 멈추면(정지) 그 즉시 영역에서 사라진다. 보조 타이머 알림은 탭하면
   해당 타이머 시트를 다시 열어주고, 절제 알림은 탭해도 동작이 없다(팝업 자체가 없음).
   ========================================================= */
function renderActiveTimerBanner() {
  const el = document.getElementById('activeTimerBanner');
  if (!el) return;
  const rows = [];

  if (activeTimer) {
    const found = findBlockById(activeTimer.blockId);
    const name = found ? found.block.name : '집중 타이머';
    rows.push(`<div class="timer-banner-row timer-banner-focus ${activeTimer.paused ? 'paused' : ''}" data-banner="focus" onclick="openTimerSheet(${activeTimer.blockId})">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 16 14"/></svg>
      <span class="timer-banner-name">${esc(name)}</span>
      <span class="timer-banner-time" data-banner-time="focus">${formatHMS(currentElapsedMs())}</span>
      ${activeTimer.paused ? '<span class="timer-banner-tag">일시정지</span>' : ''}
    </div>`);
  }

  Object.keys(activeAbstainTimers).forEach(blockIdStr => {
    const blockId = parseInt(blockIdStr);
    const found = findBlockById(blockId);
    const name = found ? found.block.name : '절제';
    rows.push(`<div class="timer-banner-row timer-banner-abstain" data-banner="abstain-${blockId}">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 16 14"/></svg>
      <span class="timer-banner-name">${esc(name)}</span>
      <span class="timer-banner-time" data-banner-time="abstain-${blockId}">${formatHMS(found ? abstainTimerTotalMs(found.block) : 0)}</span>
    </div>`);
  });

  el.innerHTML = rows.join('');
  el.classList.toggle('hidden', rows.length === 0);
}

/* =========================================================
   MINI ALARM (미니 시간 알림 블록)
   제목 + 시간만 가진 아주 작은 1줄짜리 블록. 그날(day.miniAlarms)에 속하고,
   실제 시계가 그 시각이 되면 알림(Notification API, 권한 없으면 토스트)을 띄운다.
   ========================================================= */
let editMiniAlarmId = null;

function renderMiniAlarms() {
  const day = ensureDay(viewingDateKey);
  const el = document.getElementById('miniAlarmList');
  if (!el) return;
  const alarms = (day.miniAlarms || []).slice().sort((a, b) => a.time.localeCompare(b.time));
  if (!alarms.length) { el.innerHTML = ''; el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  el.innerHTML = alarms.map(a => `
    <div class="mini-alarm-row ${a.fired ? 'fired' : ''}" onclick="openMiniAlarmEdit(${a.id})">
      <svg class="mini-alarm-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l3 2"/><path d="M5 3 2 6M22 6l-3-3"/></svg>
      <span class="mini-alarm-time">${a.time}</span>
      <span class="mini-alarm-title">${esc(a.title)}</span>
      <button class="mini-alarm-delete" onclick="event.stopPropagation();askDeleteMiniAlarm(${a.id})" aria-label="알림 삭제">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>
  `).join('');
}

function openMiniAlarmAdd() {
  editMiniAlarmId = null;
  document.getElementById('miniAlarmSheetTitle').textContent = '알림 추가';
  document.getElementById('maTitle').value = '';
  document.getElementById('maTime').value = '';
  document.getElementById('miniAlarmFormOverlay').classList.add('open');
  setTimeout(() => document.getElementById('maTitle').focus(), 80);
}

function openMiniAlarmEdit(id) {
  const day = ensureDay(viewingDateKey);
  const a = (day.miniAlarms || []).find(x => x.id === id);
  if (!a) return;
  editMiniAlarmId = id;
  document.getElementById('miniAlarmSheetTitle').textContent = '알림 수정';
  document.getElementById('maTitle').value = a.title;
  document.getElementById('maTime').value = a.time;
  document.getElementById('miniAlarmFormOverlay').classList.add('open');
}

function submitMiniAlarmForm() {
  const title = document.getElementById('maTitle').value.trim();
  const time = document.getElementById('maTime').value;
  if (!title) { document.getElementById('maTitle').focus(); return; }
  if (!time) { document.getElementById('maTime').focus(); return; }
  const day = ensureDay(viewingDateKey);
  if (!day.miniAlarms) day.miniAlarms = [];
  if (editMiniAlarmId !== null) {
    const a = day.miniAlarms.find(x => x.id === editMiniAlarmId);
    if (a) { a.title = title; a.time = time; a.fired = false; } // 시간을 바꿨으면 다시 울릴 수 있게 리셋
  } else {
    day.miniAlarms.push({ id: Date.now() + Math.floor(Math.random()*1000), title, time, fired: false });
    ensureNotificationPermission();
  }
  saveDays(); renderMiniAlarms(); closeOverlay('miniAlarmFormOverlay');
}

function askDeleteMiniAlarm(id) {
  document.getElementById('confirmMsg').innerHTML = '이 알림을 삭제할까요?';
  document.getElementById('confirmOkBtn').onclick = () => {
    const day = ensureDay(viewingDateKey);
    day.miniAlarms = (day.miniAlarms || []).filter(x => x.id !== id);
    saveDays(); renderMiniAlarms();
    closeOverlay('confirmOverlay');
  };
  document.getElementById('confirmOverlay').classList.add('open');
}

function ensureNotificationPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
}

// 실제 벽시계 시각이 오늘(TODAY_KEY) 알림의 시각과 같아지면 한 번만 울린다.
// 앱이 열려 있는 동안만 동작하는 클라이언트 타이머 방식 — 20초 간격으로 확인한다.
function checkMiniAlarms() {
  const todayKey = TODAY_KEY();
  const day = days[todayKey];
  if (!day || !day.miniAlarms || !day.miniAlarms.length) return;
  const now = new Date();
  const nowStr = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
  let changed = false;
  day.miniAlarms.forEach(a => {
    if (!a.fired && a.time === nowStr) {
      fireMiniAlarmNotification(a);
      a.fired = true;
      changed = true;
    }
  });
  if (changed) {
    saveDays();
    if (currentTab === 'todo' && viewingDateKey === todayKey) renderMiniAlarms();
  }
}

function fireMiniAlarmNotification(a) {
  if ('Notification' in window && Notification.permission === 'granted') {
    try { new Notification('⏰ ' + a.title, { body: a.time, tag: 'mini-alarm-' + a.id }); } catch (e) { /* 알림 생성 실패 시 토스트로 대체 */ }
  }
  showToast(`⏰ ${a.title} (${a.time})`);
}

// 연속 완료일수를 단계별로 점점 화려하게 보여주는 배지.
// 0일이면 아예 표시하지 않고, 1일부터는 기본 칩, 3/7/14/30일 구간마다 더 화려해진다.
function renderStreakBadge(streak) {
  if (!streak || streak <= 0) return '';
  let tier = 'streak-1';
  if (streak >= 30) tier = 'streak-5';
  else if (streak >= 14) tier = 'streak-4';
  else if (streak >= 7) tier = 'streak-3';
  else if (streak >= 3) tier = 'streak-2';
  return `<span class="streak-badge ${tier}">🔥 ${streak}일 연속</span>`;
}

// 루틴의 연속 완료일수(streak)를 계산. 항상 "어제"부터 거슬러 올라가며 세므로
// 오늘이 아직 미완료여도 어제까지 쌓아온 연속 기록은 그대로 보여준다.
// "매 n일마다" 루틴이면 쉬는 날은 건너뛰고(연속이 끊기지 않음), 활성 날인데 완료가
// 아니면 그 자리에서 streak가 끊긴다. 최대 365일까지만 거슬러 올라간다(무한루프 방지).
// 그날 데이터 자체가 없으면(쉬는 날이거나 그 루틴이 아직 시작되기 전) 일단 건너뛰고 계속
// 거슬러 올라가되, 연속으로 60일 넘게 데이터가 없으면 그 이전엔 루틴이 없었다고 보고 멈춘다.
function getRoutineStreak(carryoverId) {
  const todayKey = TODAY_KEY();
  let streak = 0;
  let consecutiveMissing = 0;
  for (let i = 1; i <= 365; i++) {
    const k = addDaysToKey(todayKey, -i);
    const dayObj = days[k];
    const b = dayObj && dayObj.blocks.find(x => x.carryoverId === carryoverId);
    if (!b) {
      consecutiveMissing++;
      if (consecutiveMissing > 60) break;
      continue;
    }
    consecutiveMissing = 0;
    if (isBlockComplete(b)) { streak++; continue; }
    break; // 활성 날에 완료가 안 되어 있으면 연속이 끊김
  }
  return streak;
}

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
  renderActiveTimerBanner();
  renderMiniAlarms();
  const day = ensureDay(viewingDateKey);
  const el = document.getElementById('blockList');
  if (!day.blocks.length) {
    el.innerHTML = `<div class="empty">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><rect x="3" y="4" width="18" height="16" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="16" y1="2" x2="16" y2="6"/></svg>
      <p>오늘 할 일을 추가해보세요</p>
    </div>`;
    return;
  }
  // 정렬 우선순위: ① 완료 여부(미완료 먼저) ② 시간대 그룹(오전→오후→밤→시간미지정)
  // ③ 같은 그룹 안에서는 실제 데이터 배열(day.blocks)의 순서를 그대로 따른다 — 새 블록이
  // 추가될 때 이행→루틴→일반 순으로 적절한 위치에 끼워 넣고, 사용자가 드래그/화살표로
  // 같은 그룹 안에서 옮기면 그 결과가 배열 순서에 그대로 반영되어 유지된다.
  // 위/아래 버튼과 드래그는 실제 데이터 배열(day.blocks)의 인덱스를 그대로 사용해야 하므로,
  // 정렬은 표시용으로만 하고 원래 인덱스(realIdx)를 함께 들고 다닌다.
  const withIdx = day.blocks.map((b, realIdx) => ({ b, realIdx }));
  const sorted = withIdx.slice().sort((x, y) => {
    const groupCmp = compareBlockGroups(x.b, y.b);
    if (groupCmp !== 0) return groupCmp;
    return x.realIdx - y.realIdx; // 같은 그룹 내에서는 원래 순서 유지
  });

  el.innerHTML = sorted.map(({ b, realIdx }, displayIdx) => {
    const complete = isBlockComplete(b);
    // 화살표 버튼은 같은 정렬 그룹(완료여부+시간대) 안에서만 위/아래로 옮길 수 있다.
    // 바로 위/아래 카드가 다른 그룹이면 더 이상 옮길 수 없다는 뜻이므로 비활성화한다.
    const prevB = displayIdx > 0 ? sorted[displayIdx - 1].b : null;
    const nextB = displayIdx < sorted.length - 1 ? sorted[displayIdx + 1].b : null;
    const myGroupKey = blockSortGroupKey(b);
    const canMoveUp = prevB && blockSortGroupKey(prevB) === myGroupKey;
    const canMoveDown = nextB && blockSortGroupKey(nextB) === myGroupKey;
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
    const streakHtml = (b.type === 'routine') ? renderStreakBadge(getRoutineStreak(b.carryoverId)) : '';
    const hasTime = blockTotalFocusMs(b) > 0 || (activeTimer && activeTimer.blockId === b.id);
    const isTimerActive = activeTimer && activeTimer.blockId === b.id && activeTimer.dateKey === viewingDateKey;
    const isAbstainTimerActive = !!activeAbstainTimers[b.id];
    return `<div class="card block-card type-${b.type} ${complete && b.progressType!=='none' ? 'completed':''}" data-id="${b.id}" style="${blockColorStyle(b.color, b.type)}" onclick="handleCardTap(event,this)">
      <div class="reorder-handle">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
      </div>
      <div class="card-main">
        <div class="card-header">
          <div class="card-title-wrap">
            <div class="card-title">${esc(b.name)}${isTimerActive || isAbstainTimerActive ? ' ⏱' : ''}</div>
            <div class="card-sub"><span class="type-chip">${TYPE_LABEL[b.type]}</span>${timeStr ? `<span class="time-chip">${timeStr}</span>` : ''}${carryoverBadge}${intervalBadge}${streakHtml}</div>
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
            <button class="move-btn" onclick="moveBlock(${b.id},-1)" ${!canMoveUp?'disabled':''} aria-label="위로"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg></button>
            <button class="move-btn" onclick="moveBlock(${b.id},1)" ${!canMoveDown?'disabled':''} aria-label="아래로"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg></button>
          </div>
        </div>
        ${b.desc ? `<div class="block-desc">${escLinkify(b.desc, 32)}</div>` : ''}
        ${progressHtml}
        ${renderSessionLog(b)}
      </div>
    </div>`;
  }).join('');

  // 드래그는 "화면에 보이는 순서(완료 항목이 맨 아래로 정렬된 순서)" 기준으로 동작.
  // 화살표 버튼과 마찬가지로 같은 정렬 그룹(완료여부+시간대) 안에서만 허용하고,
  // 그룹을 넘어가는 이동은 자동 정렬 규칙을 깨므로 조용히 취소(원래 자리로 복귀)한다.
  registerDragReorder('blockList',
    () => sorted.map(x => x.b),
    (fromIdx, toIdx) => {
      const order = sorted.map(x => x.b);
      const movedBlock = order[fromIdx];
      const targetBlock = order[toIdx];
      if (blockSortGroupKey(movedBlock) !== blockSortGroupKey(targetBlock)) {
        showToast('다른 시간대/완료 영역으로는 순서를 바꿀 수 없어요');
        renderBlocks(); // 드래그 중 흐트러진 화면을 원래 순서로 되돌림
        return;
      }
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
    const bannerEl = document.querySelector('[data-banner-time="focus"]');
    if (bannerEl) bannerEl.textContent = formatHMS(currentElapsedMs());
  }
  // 실행 중인 절제 시간재기들의 카드 표시를 1초마다 가볍게 갱신 (전체 리렌더 없이 텍스트만)
  let crossedLimitJustNow = false;
  Object.keys(activeAbstainTimers).forEach(blockIdStr => {
    const blockId = parseInt(blockIdStr);
    const el = document.querySelector(`.card[data-id="${blockIdStr}"] .abstain-timer-display`);
    const bannerTimeEl = document.querySelector(`[data-banner-time="abstain-${blockId}"]`);
    const found = findBlockById(blockId);
    if (found) {
      const totalMs = abstainTimerTotalMs(found.block);
      if (el) {
        const wasOver = el.dataset.over === '1';
        const isOver = isAbstainOverLimit(found.block);
        el.textContent = formatDurationShort(totalMs);
        if (isOver !== wasOver) { el.dataset.over = isOver ? '1' : '0'; crossedLimitJustNow = true; }
      }
      if (bannerTimeEl) bannerTimeEl.textContent = formatHMS(totalMs);
    }
  });
  // 상한을 막 넘긴 시점이면 점수 표시와 카드의 초과 배지를 갱신 (가벼운 부분 갱신 대신 안전하게 전체 리렌더)
  if (crossedLimitJustNow) { renderBlocks(); }
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
  renderBlocks();
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
  renderActiveTimerBanner();
}

function timerResume() {
  if (!isTimerRunningForCurrentBlock() || !activeTimer.paused) return;
  activeTimer.startedAt = new Date().toISOString();
  activeTimer.paused = false;
  saveActiveTimer();
  renderTimerSheet();
  renderActiveTimerBanner();
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
  updateSimpleViewGrid();
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

function openPlanAddForPeriod() {
  creatingPlanForPeriod = true;
  closeOverlay('periodFormOverlay'); // 입력 내용은 DOM에 그대로 남아있고, 화면에서만 잠시 가린다
  openPlanAdd();
}

// 계획 폼을 취소(닫기)할 때 — "기간계획에서 새 계획 만들기"로 들어온 경우라면
// 그냥 닫지 않고 잠시 가려뒀던 기간계획 폼으로 되돌아간다 (작성 중이던 내용은 그대로 보존됨).
function cancelPlanForm() {
  closeOverlay('planFormOverlay');
  if (creatingPlanForPeriod) {
    creatingPlanForPeriod = false;
    document.getElementById('periodFormOverlay').classList.add('open');
  }
}

function openPlanAdd() {
  editPlanId = null;
  document.getElementById('planSheetTitle').textContent = '계획 추가';
  document.getElementById('pfName').value = '';
  document.getElementById('pfDesc').value = '';
  document.getElementById('pfTotal').value = '';
  document.getElementById('pfCurrent').value = '0';
  document.getElementById('pfDateInput').value = '';
  pendingPlanDateEntries = [];
  renderPlanDateList();
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
  document.getElementById('pfDateInput').value = '';
  // 구버전 데이터(dateStart/dateEnd 단일 범위)는 자동으로 이후~이전 항목 한 쌍으로 변환해 보여준다.
  if (p.customDateEntries) {
    pendingPlanDateEntries = p.customDateEntries.slice();
  } else if (p.dateStart) {
    pendingPlanDateEntries = (p.dateEnd && p.dateEnd !== p.dateStart)
      ? [{ date: p.dateStart, modifier: 'after' }, { date: p.dateEnd, modifier: 'before' }]
      : [{ date: p.dateStart, modifier: 'exact' }];
  } else {
    pendingPlanDateEntries = [];
  }
  renderPlanDateList();
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
  const customDateEntries = timeUnspecified ? [] : pendingPlanDateEntries.slice();
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
      p.timeUnspecified = timeUnspecified; p.customDateEntries = customDateEntries;
      delete p.dateStart; delete p.dateEnd; // 구버전 단일 범위 필드는 더 이상 사용하지 않음
      p.timeStart = timeStart; p.timeEnd = timeEnd;
      if (selectedPlanProgress === 'counter') { p.total = total; p.current = current; }
      else if (selectedPlanProgress === 'toggle') { if (p.done === undefined) p.done = false; }
    }
    savePlanBlocks(); renderPlanList(); closeOverlay('planFormOverlay');
  } else {
    const plan = {
      id: Date.now() + Math.floor(Math.random()*1000),
      name, desc, type: selectedPlanType, progressType: selectedPlanProgress,
      timeUnspecified, customDateEntries, timeStart, timeEnd,
      order: planBlocks.length
    };
    if (selectedPlanProgress === 'counter') { plan.total = total; plan.current = current; }
    if (selectedPlanProgress === 'toggle') { plan.done = false; }
    planBlocks.push(plan);
    savePlanBlocks(); renderPlanList(); closeOverlay('planFormOverlay');

    if (creatingPlanForPeriod) {
      // 기간계획 폼 안에서 "새 계획 만들고 참조하기"로 들어온 경우 — 방금 만든 계획을 자동으로
      // 참조 목록에 추가하고, 잠시 가려뒀던 기간계획 폼을 그대로(입력했던 내용 유지) 다시 연다.
      creatingPlanForPeriod = false;
      pendingPeriodRefs.push({ kind: 'plan', id: plan.id, dateKey: null, watchSource: null, refDate: '', refDateEnd: '' });
      renderPendingRefList();
      document.getElementById('periodFormOverlay').classList.add('open');
    }
  }
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
  const dateStr = p.customDateEntries && p.customDateEntries.length
    ? formatPlanDateEntries(p.customDateEntries)
    : (p.dateStart ? (p.dateEnd && p.dateEnd !== p.dateStart ? `${p.dateStart} ~ ${p.dateEnd}` : p.dateStart) : ''); // 구버전 데이터 호환
  if (dateStr) parts.push(dateStr);
  if (p.timeStart) {
    let timeStr = p.timeStart;
    if (p.timeEnd && p.timeEnd !== p.timeStart) timeStr += `~${p.timeEnd}`;
    parts.push(timeStr);
  }
  return parts.join(' · ');
}

// "시간순" 서브탭 정렬 기준 키 (날짜 없으면 맨 뒤로)
function planSortKey(p) {
  const datePart = (p.customDateEntries && p.customDateEntries.length)
    ? earliestPlanDate(p.customDateEntries)
    : (p.dateStart || '9999-99-99'); // 구버전 데이터 호환
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
    return `<div class="card block-card type-${p.type} ${complete && p.progressType!=='none' ? 'completed':''}" data-id="${p.id}" onclick="handleCardTap(event,this)">
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
    customTimeEntries: p.timeStart ? [{ time: p.timeStart, modifier: 'exact' }] : [],
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
  creatingPlanForPeriod = false;
  document.getElementById('periodSheetTitle').textContent = '프로젝트 추가';
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
  creatingPlanForPeriod = false;
  document.getElementById('periodSheetTitle').textContent = '프로젝트 수정';
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
  document.getElementById('confirmMsg').innerHTML = `이 프로젝트를 삭제할까요?<br>참조된 블록들은 삭제되지 않아요.`;
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
  document.getElementById('refPickerSearch').value = '';
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
  } else if (ref.kind === 'watch') {
    // 감상 참조는 '오늘 진행 중' 또는 '예정' 둘 중 한 곳에 있을 수 있다 (참조 추가 시점 기준).
    if (ref.watchSource === 'planned') {
      const item = watchPlannedItems.find(x => x.id === ref.id);
      return item ? { name: item.name, meta: `감상(예정) · ${WATCH_TYPE_LABEL[item.type]}` } : null;
    }
    const dayObj = days[ref.dateKey];
    const w = dayObj && (dayObj.watchBlocks || []).find(x => x.id === ref.id);
    return w ? { name: w.name, meta: `감상 · ${WATCH_TYPE_LABEL[w.type]} · ${ref.dateKey}` } : null;
  }
  return null;
}

function renderRefPickerList() {
  const el = document.getElementById('refPickerList');
  const items = [];

  planBlocks.forEach(p => {
    items.push({ kind: 'plan', id: p.id, dateKey: null, watchSource: null, name: p.name, meta: `계획 · ${TYPE_LABEL[p.type]}` });
  });

  // 할일 블록 — 오늘 이후(오늘 포함) 날짜에 있는 미완료 블록만. days에 실제로 데이터가 있는 날짜만 훑는다.
  const today = TODAY_KEY();
  Object.keys(days).filter(k => k >= today).sort().forEach(dateKey => {
    const dayObj = days[dateKey];
    (dayObj.blocks || []).forEach(b => {
      if (b.progressType === 'none') return; // 진행 체크가 없는 블록은 "완료" 개념이 없어 제외
      if (isBlockComplete(b)) return;
      items.push({ kind: 'todo', id: b.id, dateKey, watchSource: null, name: b.name, meta: `${TYPE_LABEL[b.type]} · ${dateKey}` });
    });
  });

  // 감상 블록 — 오늘 진행 중(보관 아님)인 것 + 예정 아카이브. 종료(완료/보관)는 제외.
  const todayWatch = days[today];
  (todayWatch ? todayWatch.watchBlocks || [] : []).forEach(w => {
    if (w.archived) return;
    items.push({ kind: 'watch', id: w.id, dateKey: today, watchSource: 'ongoing', name: w.name, meta: `감상 · ${WATCH_TYPE_LABEL[w.type]} · ${w.progress}%` });
  });
  watchPlannedItems.forEach(item => {
    items.push({ kind: 'watch', id: item.id, dateKey: null, watchSource: 'planned', name: item.name, meta: `감상(예정) · ${WATCH_TYPE_LABEL[item.type]}` });
  });

  if (!items.length) {
    el.innerHTML = `<div class="empty" style="height:auto;padding:30px 0;"><p>참조할 블록이 없어요</p></div>`;
    return;
  }

  const query = (document.getElementById('refPickerSearch')?.value || '').trim().toLowerCase();
  const filtered = query ? items.filter(item => item.name.toLowerCase().includes(query)) : items;

  if (!filtered.length) {
    el.innerHTML = `<div class="empty" style="height:auto;padding:30px 0;"><p>검색 결과가 없어요</p></div>`;
    return;
  }

  el.innerHTML = filtered.map(item => {
    const isSelected = pendingPeriodRefs.some(r => r.kind === item.kind && r.id === item.id && r.dateKey === item.dateKey && r.watchSource === item.watchSource);
    return `<div class="ref-picker-item ${isSelected?'selected':''}" onclick="toggleRefSelection('${item.kind}',${item.id},${item.dateKey?`'${item.dateKey}'`:'null'},${item.watchSource?`'${item.watchSource}'`:'null'})">
      <span>${esc(item.name)}</span>
      <span class="ref-picker-item-meta">${esc(item.meta)}</span>
    </div>`;
  }).join('');
}

function toggleRefSelection(kind, id, dateKey, watchSource) {
  const idx = pendingPeriodRefs.findIndex(r => r.kind === kind && r.id === id && r.dateKey === dateKey && r.watchSource === watchSource);
  if (idx >= 0) pendingPeriodRefs.splice(idx, 1);
  else pendingPeriodRefs.push({ kind, id, dateKey, watchSource, refDate: '', refDateEnd: '' });
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
  document.getElementById('watchRefPickerSearch').value = '';
  renderWatchRefPickerList();
  document.getElementById('watchRefPickerOverlay').classList.add('open');
}

function renderWatchRefPickerList() {
  const el = document.getElementById('watchRefPickerList');
  const items = [];
  const todayDay = days[TODAY_KEY()];
  (todayDay ? todayDay.watchBlocks || [] : []).forEach(w => {
    if (w.archived) return; // 종료된 건 아래 watchArchiveItems 쪽에서 'archive'로 한 번만 다룬다 (중복 방지)
    items.push({ kind: 'ongoing', id: w.id, name: w.name, meta: `감상 · ${WATCH_TYPE_LABEL[w.type]} · ${w.progress}%` });
  });
  watchPlannedItems.forEach(item => {
    items.push({ kind: 'planned', id: item.id, name: item.name, meta: `예정 · ${WATCH_TYPE_LABEL[item.type]}` });
  });
  watchArchiveItems.forEach(item => {
    items.push({ kind: 'archive', id: item.id, name: item.name, meta: `종료 · ${WATCH_TYPE_LABEL[item.type]}` });
  });

  // 종료(archive) 상태의 블록은 항상 목록 맨 나중에 오도록 — 그 외 순서는 그대로 유지(안정 정렬)
  items.sort((a, b) => (a.kind === 'archive' ? 1 : 0) - (b.kind === 'archive' ? 1 : 0));

  if (!items.length) {
    el.innerHTML = `<div class="empty" style="height:auto;padding:30px 0;"><p>참조할 감상 블록이 없어요</p></div>`;
    return;
  }

  const query = (document.getElementById('watchRefPickerSearch')?.value || '').trim().toLowerCase();
  const filtered = query ? items.filter(item => item.name.toLowerCase().includes(query)) : items;

  if (!filtered.length) {
    el.innerHTML = `<div class="empty" style="height:auto;padding:30px 0;"><p>검색 결과가 없어요</p></div>`;
    return;
  }

  el.innerHTML = filtered.map(item => {
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
  // 종료(archive) 상태의 블록은 항상 목록 맨 나중에 — 실제 삭제 인덱스는 원본 배열 기준을 유지한다.
  const withIdx = pendingWatchListRefs.map((ref, idx) => ({ ref, idx }));
  withIdx.sort((a, b) => (a.ref.kind === 'archive' ? 1 : 0) - (b.ref.kind === 'archive' ? 1 : 0));
  el.innerHTML = withIdx.map(({ ref, idx }) => {
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

/* =========================================================
   BLOCK SEARCH (전체 / 탭별 블록 검색)
   계획(planBlocks) · 할일(모든 날짜의 day.blocks) · 감상(모든 날짜의 watchBlocks +
   예정/종료 아카이브)을 이름 기준으로 검색한다. 결과를 누르면 해당 탭/서브탭/날짜로
   바로 이동해서 보여준다. 참조 추가 시트(refPicker/watchRefPicker)의 검색창과는 별개로,
   여기는 "블록을 찾아서 그 화면으로 이동"하는 용도.
   ========================================================= */
function openSearch(scope) {
  searchScope = scope || 'all';
  document.querySelectorAll('#searchScopeGroup .seg-btn').forEach(b => b.classList.toggle('selected', b.dataset.val === searchScope));
  document.getElementById('searchInput').value = '';
  renderSearchResults();
  document.getElementById('searchOverlay').classList.add('open');
  setTimeout(() => document.getElementById('searchInput').focus(), 50);
}

function selectSearchScope(scope) {
  searchScope = scope;
  document.querySelectorAll('#searchScopeGroup .seg-btn').forEach(b => b.classList.toggle('selected', b.dataset.val === scope));
  renderSearchResults();
}

function collectSearchableBlocks() {
  const results = [];

  if (searchScope === 'all' || searchScope === 'plan') {
    planBlocks.forEach(p => {
      results.push({ scope: 'plan', name: p.name, meta: TYPE_LABEL[p.type], target: { kind: 'plan', id: p.id, timeUnspecified: !!p.timeUnspecified } });
    });
  }

  if (searchScope === 'all' || searchScope === 'todo') {
    Object.keys(days).sort().forEach(dateKey => {
      (days[dateKey].blocks || []).forEach(b => {
        results.push({ scope: 'todo', name: b.name, meta: `${TYPE_LABEL[b.type]} · ${dateKey}`, target: { kind: 'todo', id: b.id, dateKey } });
      });
    });
  }

  if (searchScope === 'all' || searchScope === 'watch') {
    Object.keys(days).sort().forEach(dateKey => {
      (days[dateKey].watchBlocks || []).forEach(w => {
        if (w.archived) return; // 보관된 건 watchArchiveItems 쪽에서 중복 없이 다룬다
        results.push({ scope: 'watch', name: w.name, meta: `감상 · ${WATCH_TYPE_LABEL[w.type]} · ${dateKey}`, target: { kind: 'watch-ongoing', id: w.id, dateKey } });
      });
    });
    watchPlannedItems.forEach(item => {
      results.push({ scope: 'watch', name: item.name, meta: `감상(예정) · ${WATCH_TYPE_LABEL[item.type]}`, target: { kind: 'watch-planned', id: item.id } });
    });
    watchArchiveItems.forEach(item => {
      results.push({ scope: 'watch', name: item.name, meta: `감상(종료) · ${WATCH_TYPE_LABEL[item.type]}`, target: { kind: 'watch-archive', id: item.id } });
    });
  }

  return results;
}

function renderSearchResults() {
  const el = document.getElementById('searchResultsList');
  const query = document.getElementById('searchInput').value.trim().toLowerCase();
  let results = collectSearchableBlocks();
  if (query) results = results.filter(r => r.name.toLowerCase().includes(query));

  if (!results.length) {
    el.innerHTML = `<div class="empty" style="height:auto;padding:30px 0;"><p>${query ? '검색 결과가 없어요' : '검색어를 입력해보세요'}</p></div>`;
    return;
  }

  el.innerHTML = results.map((r, idx) => `<div class="ref-picker-item" onclick="goToSearchResult(${idx})">
      <span>${esc(r.name)}</span>
      <span class="search-result-date">${esc(r.meta)}</span>
    </div>`).join('');

  window._searchResultsCache = results; // goToSearchResult에서 인덱스로 다시 찾기 위한 임시 캐시
}

function goToSearchResult(idx) {
  const r = (window._searchResultsCache || [])[idx];
  if (!r) return;
  closeOverlay('searchOverlay');
  const t = r.target;

  if (t.kind === 'plan') {
    switchTab('plan');
    switchPlanSubtab(t.timeUnspecified ? 'unspecified' : 'time');
  } else if (t.kind === 'todo') {
    switchTab('todo');
    viewingDateKey = t.dateKey;
    renderDayHeader(); renderBlocks();
  } else if (t.kind === 'watch-ongoing') {
    switchTab('watch');
    switchWatchSubtab('ongoing');
    viewingWatchDateKey = t.dateKey;
    renderWatchHeader(); renderWatchBlocks();
  } else if (t.kind === 'watch-planned') {
    switchTab('watch');
    switchWatchSubtab('planned');
  } else if (t.kind === 'watch-archive') {
    switchTab('watch');
    switchWatchSubtab('archive');
  }

  flashBlockRow(t.id);
}

// 이동한 화면에서 해당 블록 카드를 잠깐 강조해서 눈에 띄게 한다.
function flashBlockRow(id) {
  setTimeout(() => {
    const card = document.querySelector(`.list [data-id="${id}"]`);
    if (!card) return;
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    card.classList.add('search-flash');
    setTimeout(() => card.classList.remove('search-flash'), 1600);
  }, 80);
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
    const sortedRefs = (wl.refs || []).slice().sort((a, b) => (a.kind === 'archive' ? 1 : 0) - (b.kind === 'archive' ? 1 : 0));
    const refs = sortedRefs.map(resolveWatchRef).filter(Boolean);
    const refsHtml = refs.length
      ? `<div class="ref-list" style="margin-top:8px;">${refs.map(r => `<div class="ref-item"><span class="ref-item-name">${esc(r.name)}</span><span class="ref-picker-item-meta">${esc(r.meta)}</span></div>`).join('')}</div>`
      : `<div class="ref-item-missing" style="margin-top:8px;">참조한 블록이 없어요</div>`;
    return `<div class="card block-card type-unspecified" data-id="${wl.id}" onclick="handleCardTap(event,this)">
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
      <p>프로젝트를 추가해보세요</p>
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
  updateSimpleViewGrid();
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

function openWatchAddForList() {
  creatingWatchForList = true;
  closeOverlay('watchListFormOverlay'); // 입력 내용은 DOM에 그대로 남아있고, 화면에서만 잠시 가린다
  openWatchAdd();
}

// 감상 폼을 취소(닫기)할 때 — "목록에서 새 감상 만들기"로 들어온 경우라면
// 그냥 닫지 않고 잠시 가려뒀던 목록 폼으로 되돌아간다 (작성 중이던 내용은 그대로 보존됨).
function cancelWatchForm() {
  closeOverlay('watchFormOverlay');
  if (creatingWatchForList) {
    creatingWatchForList = false;
    document.getElementById('watchListFormOverlay').classList.add('open');
  }
}

function openWatchAdd() {
  editWatchId = null;
  editWatchArchiveKind = null;
  document.getElementById('watchSheetTitle').textContent = '감상 추가';
  document.getElementById('wfName').value = '';
  document.getElementById('wfAuthor').value = '';
  document.getElementById('wfYear').value = '';
  document.getElementById('wfDesc').value = '';
  document.getElementById('wfProgress').value = '0';
  document.getElementById('wfSeriesTotal').value = '';
  document.getElementById('wfSeriesCurrent').value = '0';
  document.getElementById('wfFocusRatio').value = '0';
  onFocusRatioInputChange();
  pendingWatchRatings = {};
  pendingWatchRatingPresetId = null;
  refreshWatchRatingSection();
  // '예정'/'종료' 서브탭에서 추가하면 그 상태로 바로 시작되게 한다 ('종료'는 보관 체크로 처리)
  document.getElementById('wfArchive').checked = (currentWatchSubtab === 'archive');
  document.getElementById('wfPlanned').checked = (currentWatchSubtab === 'planned');
  document.getElementById('wfPlannedField').classList.remove('hidden');
  document.getElementById('wfArchiveField').classList.remove('hidden');
  selectedWatchType = null;
  document.querySelectorAll('#wfTypeGroup .seg-btn').forEach(b => b.classList.remove('selected'));
  onWatchTypeChanged();
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
  document.getElementById('wfYear').value = w.year || '';
  document.getElementById('wfDesc').value = w.desc || '';
  document.getElementById('wfProgress').value = w.progress;
  document.getElementById('wfSeriesTotal').value = w.seriesTotal || '';
  document.getElementById('wfSeriesCurrent').value = w.seriesCurrent || 0;
  document.getElementById('wfFocusRatio').value = w.focusRatio || 0;
  onFocusRatioInputChange();
  pendingWatchRatings = Object.assign({}, w.ratings || {});
  pendingWatchRatingPresetId = w.ratingPresetId || null;
  refreshWatchRatingSection();
  document.getElementById('wfArchive').checked = !!w.archived;
  document.getElementById('wfPlanned').checked = !!w.planned;
  document.getElementById('wfPlannedField').classList.remove('hidden');
  document.getElementById('wfArchiveField').classList.remove('hidden');
  selectedWatchType = w.type;
  document.querySelectorAll('#wfTypeGroup .seg-btn').forEach(btn => btn.classList.toggle('selected', btn.dataset.val === w.type));
  onWatchTypeChanged();
  document.getElementById('watchFormOverlay').classList.add('open');
  setTimeout(() => document.getElementById('wfName').focus(), 80);
}

// 폼의 진행도 입력을 유형에 맞게 읽어서 { progress(0~100), seriesTotal?, seriesCurrent? }로 정규화.
function readWatchProgressFromForm() {
  if (selectedWatchType === 'series') {
    let total = parseInt(document.getElementById('wfSeriesTotal').value) || 0;
    let current = parseInt(document.getElementById('wfSeriesCurrent').value) || 0;
    total = Math.max(0, total);
    current = Math.max(0, Math.min(total || current, current));
    const progress = total > 0 ? Math.round(current / total * 100) : 0;
    return { progress, seriesTotal: total, seriesCurrent: current };
  }
  let progress = parseInt(document.getElementById('wfProgress').value);
  if (isNaN(progress)) progress = 0;
  progress = Math.max(0, Math.min(100, progress));
  return { progress, seriesTotal: undefined, seriesCurrent: undefined };
}

function submitWatchForm() {
  const name = document.getElementById('wfName').value.trim();
  const author = document.getElementById('wfAuthor').value.trim();
  const yearRaw = document.getElementById('wfYear').value.trim();
  const year = yearRaw ? parseInt(yearRaw) : null;
  const desc = document.getElementById('wfDesc').value.trim();
  const archived = document.getElementById('wfArchive').checked;
  const planned = document.getElementById('wfPlanned').checked;
  if (!name) { document.getElementById('wfName').focus(); return; }
  if (!selectedWatchType) { showToast('유형을 선택해주세요'); return; }
  const { progress, seriesTotal, seriesCurrent } = readWatchProgressFromForm();
  if (selectedWatchType === 'series' && !seriesTotal) { document.getElementById('wfSeriesTotal').focus(); showToast('총 화수/권수를 입력해주세요'); return; }
  const focusRatio = parseInt(document.getElementById('wfFocusRatio').value) || 0;
  const ratings = Object.assign({}, pendingWatchRatings);
  const ratingPresetId = pendingWatchRatingPresetId;

  // '종료'/'예정' 탭에서 직접 연 수정 폼이면 오늘 원본이 아니라 해당 아카이브 항목을 고친다.
  if (editWatchArchiveKind !== null) {
    submitWatchArchiveItemEdit(name, author, year, desc, progress, archived, planned, seriesTotal, seriesCurrent, focusRatio, ratings, ratingPresetId);
    return;
  }

  const day = ensureDay(viewingWatchDateKey);

  let w;
  if (editWatchId !== null) {
    w = day.watchBlocks.find(x => x.id === editWatchId);
    if (w) {
      w.name = name; w.author = author; w.year = year; w.desc = desc; w.type = selectedWatchType;
      w.progress = progress; w.seriesTotal = seriesTotal; w.seriesCurrent = seriesCurrent;
      w.focusRatio = focusRatio; w.ratings = ratings; w.ratingPresetId = ratingPresetId;
      w.archived = archived; w.planned = planned;
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
      name, author, year, desc, type: selectedWatchType, progress, seriesTotal, seriesCurrent,
      focusRatio, ratings, ratingPresetId, archived, planned,
      watchChainId: chainId, memos: []
    };
    watchChainMeta[chainId] = { stopped: progress >= 100 || archived };
    saveWatchChainMeta();
    day.watchBlocks.push(w);
  }

  saveDays(); renderWatchBlocks(); closeOverlay('watchFormOverlay');
  if (w) syncWatchArchiveLink(w, viewingWatchDateKey);

  if (editWatchId === null && creatingWatchForList) {
    // 목록 폼 안에서 "새 감상 만들고 참조하기"로 들어온 경우 — 방금 만든 감상 블록을 자동으로
    // 참조 목록에 추가하고, 잠시 가려뒀던 목록 폼을 그대로(입력했던 내용 유지) 다시 연다.
    // 종료/예정으로 바로 체크해서 만들었다면 참조도 그에 맞는 종류(kind)로 넣어줘야
    // 종료 블록을 목록 맨 뒤로 보내는 정렬이 올바르게 동작한다.
    creatingWatchForList = false;
    let refKind = 'ongoing', refId = w.id;
    if (w.archived) {
      const archiveItem = watchArchiveItems.find(x => x.linkedWatchId === w.id);
      if (archiveItem) { refKind = 'archive'; refId = archiveItem.id; }
    } else if (w.planned) {
      const plannedItem = watchPlannedItems.find(x => x.linkedWatchId === w.id);
      if (plannedItem) { refKind = 'planned'; refId = plannedItem.id; }
    }
    pendingWatchListRefs.push({ kind: refKind, id: refId });
    renderPendingWatchListRefs();
    document.getElementById('watchListFormOverlay').classList.add('open');
  }
}

// '종료'/'예정' 탭에서 직접 연 수정 폼 제출 처리.
// 아직 오늘 원본과 연결돼 있다면 원본도 같은 내용으로 같이 갱신해서 자연스럽게 동기화되게 한다.
function submitWatchArchiveItemEdit(name, author, year, desc, progress, archived, planned, seriesTotal, seriesCurrent, focusRatio, ratings, ratingPresetId) {
  const kind = editWatchArchiveKind;
  const store = getWatchArchiveStore(kind);
  const item = store.find(x => x.id === editWatchId);
  if (!item) { closeOverlay('watchFormOverlay'); return; }

  item.name = name; item.author = author; item.year = year; item.desc = desc; item.type = selectedWatchType; item.progress = progress;
  item.seriesTotal = seriesTotal; item.seriesCurrent = seriesCurrent; item.focusRatio = focusRatio; item.ratings = ratings; item.ratingPresetId = ratingPresetId;
  if (kind === 'archive') item.archived = archived;

  const isLinked = item.linkedWatchId !== null && item.linkedWatchId !== undefined;
  if (isLinked) {
    const todayDay = ensureDay(TODAY_KEY());
    const w = todayDay.watchBlocks.find(x => x.id === item.linkedWatchId);
    if (w) {
      w.name = name; w.author = author; w.year = year; w.desc = desc; w.type = selectedWatchType; w.progress = progress;
      w.seriesTotal = seriesTotal; w.seriesCurrent = seriesCurrent; w.focusRatio = focusRatio; w.ratings = ratings; w.ratingPresetId = ratingPresetId;
      if (kind === 'archive') w.archived = archived;
      if (kind === 'planned') w.planned = planned;
      if (w.watchChainId) {
        watchChainMeta[w.watchChainId] = { stopped: w.progress >= 100 || w.archived };
        saveWatchChainMeta();
      }
      saveDays();
      syncWatchArchiveLink(w, TODAY_KEY()); // 조건이 깨졌으면 이 함수가 store에서 알맞게 제거/갱신해줌
      renderWatchBlocks(); closeOverlay('watchFormOverlay');
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
  renderWatchBlocks(); closeOverlay('watchFormOverlay');
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
    saveDays(); renderWatchBlocks(); closeOverlay('confirmOverlay');
  };
  document.getElementById('confirmOverlay').classList.add('open');
}

function moveWatchBlock(id, dir) {
  const day = ensureDay(viewingWatchDateKey);
  // 보이는(예정/보관이 아닌) 항목들만의 순서 기준으로 옮긴 뒤 전체 배열을 다시 구성한다.
  // 그래야 화면상 바로 위/아래 카드와 정확히 자리가 바뀐다 (그 사이에 숨겨진 항목이 끼어 있어도 영향 없음).
  const visible = day.watchBlocks.filter(w => !w.planned && !w.archived);
  const hidden = day.watchBlocks.filter(w => w.planned || w.archived);
  const visibleIdx = visible.findIndex(w => w.id === id);
  if (visibleIdx === -1) return;
  const target = visibleIdx + dir;
  if (target < 0 || target >= visible.length) return;
  [visible[visibleIdx], visible[target]] = [visible[target], visible[visibleIdx]];
  day.watchBlocks = visible.concat(hidden);
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
  saveDays(); renderWatchBlocks(); closeOverlay('watchProgressOverlay');
  syncWatchArchiveLink(w, viewingWatchDateKey);
}

// 진행도를 다시 계산해서 반영하고, 100%(완료) 경계를 넘나들 때 이월 체인 상태를 함께 맞춰준다.
// 감상 유형이 무엇이든(퍼센트든 시리즈 카운터든) w.progress는 항상 "완료 여부 판정용 0~100 값"으로 유지된다.
function applyWatchProgressValue(w, val) {
  val = Math.max(0, Math.min(100, val));
  w.progress = val;
  if (val >= 100 && w.watchChainId) {
    watchChainMeta[w.watchChainId] = { stopped: true };
    saveWatchChainMeta();
  } else if (val < 100 && w.watchChainId && !w.archived) {
    watchChainMeta[w.watchChainId] = { stopped: false };
    saveWatchChainMeta();
  }
}

/* =========================================================
   시리즈 카운터 (감상 블록 유형 "시리즈" 전용 진행도)
   할일 블록의 카운터(+/-)와 같은 방식이지만, 감상은 진행도가 100%를 넘을 수 없으므로
   현재 화수/권수가 총 화수/권수를 넘지 못하도록 상한을 둔다.
   ========================================================= */
function changeWatchSeriesCounter(id, delta) {
  const day = ensureDay(viewingWatchDateKey);
  const w = day.watchBlocks.find(x => x.id === id);
  if (!w || w.type !== 'series') return;
  const total = w.seriesTotal || 1;
  const cur = Math.max(0, Math.min(total, (w.seriesCurrent || 0) + delta));
  w.seriesCurrent = cur;
  applyWatchProgressValue(w, total > 0 ? Math.round(cur / total * 100) : 0);
  saveDays(); renderWatchBlocks();
  syncWatchArchiveLink(w, viewingWatchDateKey);
}

/* =========================================================
   집중비율 (5%씩 움직이는 수평 바) — 오늘 진행 중인 카드에서 슬라이더를 드래그하거나
   양쪽 화살표를 눌러 직접 조작한다. 드래그(oninput) 중에는 값 라벨만 갱신하고, 손을 뗀
   순간(onchange)에만 저장 + 전체 리렌더를 해서 드래그 도중 카드가 다시 그려져 끊기는 걸 막는다.
   ========================================================= */
function onWatchFocusRatioCardInput(id, val) {
  const card = document.querySelector(`#watchList .card[data-id="${id}"]`);
  if (!card) return;
  const label = card.querySelector('.focus-ratio-value');
  if (label) label.textContent = `${val}%`;
}
function commitWatchFocusRatio(id, val) {
  const day = ensureDay(viewingWatchDateKey);
  const w = day.watchBlocks.find(x => x.id === id);
  if (!w) return;
  w.focusRatio = Math.max(0, Math.min(100, parseInt(val) || 0));
  saveDays(); renderWatchBlocks();
}
function changeWatchFocusRatio(id, delta) {
  const day = ensureDay(viewingWatchDateKey);
  const w = day.watchBlocks.find(x => x.id === id);
  if (!w) return;
  w.focusRatio = Math.max(0, Math.min(100, (w.focusRatio || 0) + delta));
  saveDays(); renderWatchBlocks();
}

/* =========================================================
   평가 (독립적으로 이름 붙여 만드는 평가 프리셋 + 0.5 단위 5점 별점)
   watchRatingPresets = [{id, name, criteria:[{id,name}]}, ...] — 유형과 무관하게 사용자가
   원하는 이름으로 프리셋을 만들어두고, 감상 블록마다 그중 하나를 "평가 프리셋"으로 지정한다
   (w.ratingPresetId). 각 감상 블록의 w.ratings = { [criterionId]: 0~5(0.5 단위) }.
   별점 위젯은 "빈 별" 위에 "채워진 별"을 폭(%)만큼 겹쳐 그리는 방식이라 0.5 단위 표현이 자연스럽다.
   ========================================================= */
function getRatingPreset(id) {
  return watchRatingPresets.find(p => p.id === id) || null;
}

function starWidgetHTML(critId, value, onclickFn) {
  const pct = Math.max(0, Math.min(100, (value / 5) * 100));
  return `<div class="star-widget" onclick="${onclickFn}(event,'${critId}')">
    <div class="star-empty">★★★★★</div>
    <div class="star-filled" style="width:${pct}%">★★★★★</div>
  </div>`;
}
function starClickToValue(e) {
  const widget = e.currentTarget;
  const rect = widget.getBoundingClientRect();
  const clientX = (e.touches && e.touches[0]) ? e.touches[0].clientX : e.clientX;
  const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  return Math.max(0, Math.min(5, Math.round(ratio * 10) / 2));
}

// 폼 안의 "평가 프리셋 선택" 버튼 라벨 + 그 아래 평가 항목 섹션을 함께 갱신한다.
function refreshWatchRatingSection() {
  const preset = pendingWatchRatingPresetId ? getRatingPreset(pendingWatchRatingPresetId) : null;
  document.getElementById('wfRatingPresetBtn').textContent = preset ? preset.name : '프리셋 선택';
  document.getElementById('wfRatingPresetBtn').classList.toggle('unselected', !preset);
  document.getElementById('wfRatingSectionField').classList.toggle('hidden', !preset);
  renderRatingFormList();
}

// 폼(추가/수정) 안에서의 평가 — 아직 실제 블록에 저장되지 않은 pendingWatchRatings에 임시로 담아둔다.
function renderRatingFormList() {
  const el = document.getElementById('wfRatingList');
  const preset = pendingWatchRatingPresetId ? getRatingPreset(pendingWatchRatingPresetId) : null;
  if (!preset) { el.innerHTML = ''; return; }
  if (!preset.criteria.length) { el.innerHTML = `<div class="rating-empty">아직 평가 항목이 없어요. 아래에서 추가해보세요</div>`; return; }
  el.innerHTML = preset.criteria.map(crit => {
    const val = pendingWatchRatings[crit.id] || 0;
    return `<div class="rating-row">
      <span class="rating-name">${esc(crit.name)}</span>
      ${starWidgetHTML(crit.id, val, 'handleFormStarClick')}
      <span class="rating-value">${val.toFixed(1)}</span>
      <button type="button" class="rating-remove" onclick="removeRatingCriterionInForm('${crit.id}')" aria-label="항목 삭제">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>`;
  }).join('');
}
function handleFormStarClick(e, critId) {
  pendingWatchRatings[critId] = starClickToValue(e);
  renderRatingFormList();
}
function addRatingCriterionInForm() {
  const preset = pendingWatchRatingPresetId ? getRatingPreset(pendingWatchRatingPresetId) : null;
  if (!preset) { showToast('평가 프리셋을 먼저 선택해주세요'); return; }
  const input = document.getElementById('wfRatingNewName');
  const name = input.value.trim();
  if (!name) return;
  if (preset.criteria.some(c => c.name === name)) { showToast('이미 있는 항목이에요'); return; }
  preset.criteria.push({ id: 'rc' + Date.now() + Math.floor(Math.random()*10000), name });
  saveWatchRatingPresets();
  input.value = '';
  renderRatingFormList();
}
function removeRatingCriterionInForm(critId) {
  const preset = pendingWatchRatingPresetId ? getRatingPreset(pendingWatchRatingPresetId) : null;
  if (!preset) return;
  preset.criteria = preset.criteria.filter(c => c.id !== critId);
  saveWatchRatingPresets();
  delete pendingWatchRatings[critId];
  renderRatingFormList();
}

/* ---- 평가 프리셋 선택/생성/삭제 시트 ---- */
function openWatchRatingPresetPicker() {
  renderWatchRatingPresetPickerList();
  document.getElementById('watchRatingPresetPickerOverlay').classList.add('open');
}
function renderWatchRatingPresetPickerList() {
  const el = document.getElementById('watchRatingPresetPickerList');
  const noneRow = `<div class="ref-picker-item ${!pendingWatchRatingPresetId?'selected':''}" onclick="selectWatchRatingPreset(null)">
      <span>선택 안 함</span>
    </div>`;
  if (!watchRatingPresets.length) {
    el.innerHTML = noneRow + `<div class="empty" style="height:auto;padding:20px 0;"><p>아직 만든 프리셋이 없어요. 아래에서 새로 만들어보세요</p></div>`;
    return;
  }
  el.innerHTML = noneRow + watchRatingPresets.map(p => `
    <div class="ref-picker-item ${p.id===pendingWatchRatingPresetId?'selected':''}" onclick="selectWatchRatingPreset('${p.id}')">
      <span>${esc(p.name)} <span class="ref-picker-item-meta">${p.criteria.length}개 항목</span></span>
      <button type="button" class="rating-remove" onclick="event.stopPropagation();askDeleteWatchRatingPreset('${p.id}')" aria-label="프리셋 삭제">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>`).join('');
}
function selectWatchRatingPreset(id) {
  pendingWatchRatingPresetId = id;
  closeOverlay('watchRatingPresetPickerOverlay');
  refreshWatchRatingSection();
}
function createWatchRatingPreset() {
  const input = document.getElementById('newRatingPresetName');
  const name = input.value.trim();
  if (!name) return;
  if (watchRatingPresets.some(p => p.name === name)) { showToast('이미 있는 이름이에요'); return; }
  const preset = { id: 'rp' + Date.now() + Math.floor(Math.random()*10000), name, criteria: [] };
  watchRatingPresets.push(preset);
  saveWatchRatingPresets();
  input.value = '';
  pendingWatchRatingPresetId = preset.id;
  closeOverlay('watchRatingPresetPickerOverlay');
  refreshWatchRatingSection();
}
function askDeleteWatchRatingPreset(id) {
  const preset = getRatingPreset(id);
  if (!preset) return;
  document.getElementById('confirmMsg').innerHTML = `'${esc(preset.name)}' 프리셋을 삭제할까요?<br>이 프리셋을 쓰고 있는 감상 블록들의 평가는 더 이상 표시되지 않아요.`;
  document.getElementById('confirmOkBtn').onclick = () => {
    watchRatingPresets = watchRatingPresets.filter(p => p.id !== id);
    saveWatchRatingPresets();
    if (pendingWatchRatingPresetId === id) pendingWatchRatingPresetId = null;
    renderWatchRatingPresetPickerList();
    refreshWatchRatingSection();
    closeOverlay('confirmOverlay');
  };
  document.getElementById('confirmOverlay').classList.add('open');
}

// 유형이 바뀔 때 — 진행도 입력 방식만 퍼센트 ↔ 시리즈 카운터로 바뀐다 (평가는 유형과 무관).
function onWatchTypeChanged() {
  document.getElementById('wfProgressField').classList.toggle('hidden', selectedWatchType === 'series');
  document.getElementById('wfSeriesField').classList.toggle('hidden', selectedWatchType !== 'series');
}

function onFocusRatioInputChange() {
  document.getElementById('wfFocusRatioValue').textContent = `${document.getElementById('wfFocusRatio').value}%`;
}
function adjustFocusRatioInput(delta) {
  const input = document.getElementById('wfFocusRatio');
  input.value = Math.max(0, Math.min(100, parseInt(input.value) + delta));
  onFocusRatioInputChange();
}

// 카드에 보여줄 평균 평점(있는 항목만 평균) — 프리셋 미지정이거나 하나도 평가 안 했으면 null.
function watchRatingAverage(w) {
  if (!w.ratingPresetId) return null;
  const preset = getRatingPreset(w.ratingPresetId);
  if (!preset || !preset.criteria.length || !w.ratings) return null;
  const vals = preset.criteria.map(c => w.ratings[c.id]).filter(v => typeof v === 'number' && v > 0);
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
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
  saveDays(); renderWatchBlocks();
  syncWatchArchiveLink(w, viewingWatchDateKey);
}

function toggleWatchPlanned(id) {
  const day = ensureDay(viewingWatchDateKey);
  const w = day.watchBlocks.find(x => x.id === id);
  if (!w) return;
  w.planned = !w.planned;
  saveDays(); renderWatchBlocks();
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
        linkedWatchId: w.id, name: w.name, author: w.author, year: w.year, desc: w.desc, type: w.type,
        progress: w.progress, seriesTotal: w.seriesTotal, seriesCurrent: w.seriesCurrent,
        focusRatio: w.focusRatio, ratings: w.ratings, ratingPresetId: w.ratingPresetId, archived: w.archived,
        finishedDate: dateKey, memos: (w.memos || []).slice(),
        order: watchArchiveItems.length,
      };
      watchArchiveItems.push(archiveItem);
    } else {
      archiveItem.name = w.name; archiveItem.author = w.author; archiveItem.year = w.year; archiveItem.desc = w.desc; archiveItem.type = w.type;
      archiveItem.progress = w.progress; archiveItem.seriesTotal = w.seriesTotal; archiveItem.seriesCurrent = w.seriesCurrent;
      archiveItem.focusRatio = w.focusRatio; archiveItem.ratings = w.ratings; archiveItem.ratingPresetId = w.ratingPresetId; archiveItem.archived = w.archived;
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
        linkedWatchId: w.id, name: w.name, author: w.author, year: w.year, desc: w.desc, type: w.type,
        progress: w.progress, seriesTotal: w.seriesTotal, seriesCurrent: w.seriesCurrent,
        focusRatio: w.focusRatio, ratings: w.ratings, ratingPresetId: w.ratingPresetId, memos: (w.memos || []).slice(),
        order: watchPlannedItems.length,
      };
      watchPlannedItems.push(plannedItem);
    } else {
      plannedItem.name = w.name; plannedItem.author = w.author; plannedItem.year = w.year; plannedItem.desc = w.desc; plannedItem.type = w.type;
      plannedItem.progress = w.progress; plannedItem.seriesTotal = w.seriesTotal; plannedItem.seriesCurrent = w.seriesCurrent;
      plannedItem.focusRatio = w.focusRatio; plannedItem.ratings = w.ratings; plannedItem.ratingPresetId = w.ratingPresetId; plannedItem.memos = (w.memos || []).slice();
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

// 카드 sub 줄에 붙는 발표년도/평점 칩 (있을 때만).
function watchYearRatingChipsHTML(w) {
  const avg = watchRatingAverage(w);
  return `${w.year ? `<span class="time-chip">${w.year}</span>` : ''}${avg !== null ? `<span class="rating-chip">★ ${avg.toFixed(1)}</span>` : ''}`;
}

// 진행도 표시 — 시리즈는 할일 블록과 같은 카운터(+/-), 그 외는 기존처럼 퍼센트.
// editable=true면 오늘 진행 중인 카드(직접 조작 가능), false면 예정/종료 탭의 읽기 전용 표시.
function watchProgressRowHTML(w, editable) {
  if (w.type === 'series') {
    const total = w.seriesTotal || 0;
    const current = w.seriesCurrent || 0;
    if (editable) {
      const atMin = current <= 0, atMax = total > 0 && current >= total;
      return `<button class="ctrl-btn" style="width:28px;height:28px;font-size:16px;" onclick="changeWatchSeriesCounter(${w.id},-1)" ${atMin?'disabled':''} aria-label="감소">−</button>
        <div class="fraction" style="font-size:16px;min-width:50px;">${current}<span style="font-size:12px;">/${total}</span></div>
        <button class="ctrl-btn" style="width:28px;height:28px;font-size:16px;" onclick="changeWatchSeriesCounter(${w.id},1)" ${atMax?'disabled':''} aria-label="증가">+</button>`;
    }
    return `<span class="watch-progress-btn" style="cursor:default;">${current}/${total}</span>`;
  }
  if (editable) {
    return `<button class="watch-progress-btn" onclick="openWatchProgressEdit(${w.id})">${w.progress}%</button>
      <div class="prog-wrap"><div class="prog-bar"><div class="prog-fill" style="width:${w.progress}%"></div></div></div>`;
  }
  return `<span class="watch-progress-btn" style="cursor:default;">${w.progress}%</span>
    <div class="prog-wrap"><div class="prog-bar"><div class="prog-fill" style="width:${w.progress}%"></div></div></div>`;
}

// 집중비율 바 — editable=true(오늘 카드)면 드래그/화살표로 직접 조작 가능, false면 정적 표시.
function watchFocusRatioRowHTML(w, editable) {
  const val = w.focusRatio || 0;
  if (editable) {
    return `<div class="focus-ratio-row card-focus-ratio">
      <span class="focus-ratio-label">집중비율</span>
      <button type="button" class="focus-ratio-arrow" onclick="changeWatchFocusRatio(${w.id},-5)" aria-label="5% 감소">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
      </button>
      <input type="range" min="0" max="100" step="5" value="${val}" oninput="onWatchFocusRatioCardInput(${w.id},this.value)" onchange="commitWatchFocusRatio(${w.id},this.value)">
      <button type="button" class="focus-ratio-arrow" onclick="changeWatchFocusRatio(${w.id},5)" aria-label="5% 증가">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
      </button>
      <span class="focus-ratio-value">${val}%</span>
    </div>`;
  }
  return `<div class="focus-ratio-row card-focus-ratio readonly">
    <span class="focus-ratio-label">집중비율</span>
    <div class="focus-ratio-static-bar"><div class="focus-ratio-static-fill" style="width:${val}%"></div></div>
    <span class="focus-ratio-value">${val}%</span>
  </div>`;
}

function renderWatchOngoing() {
  const day = ensureDay(viewingWatchDateKey);
  const el = document.getElementById('watchList');

  // '예정' 또는 '보관' 체크된 블록은 감상 탭에서 완전히 숨긴다 (각각 예정/종료 탭에서 확인 가능).
  // 데이터 자체는 day.watchBlocks에 그대로 남아있고, 체크를 해제하면 다시 보인다.
  const withIdx = day.watchBlocks.map((w, realIdx) => ({ w, realIdx }));
  const visible = withIdx.filter(x => !x.w.planned && !x.w.archived);

  if (!visible.length) {
    el.innerHTML = `<div class="empty">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><rect x="4" y="3" width="16" height="18" rx="2"/><line x1="8" y1="8" x2="16" y2="8"/><line x1="8" y1="13" x2="16" y2="13"/></svg>
      <p>오늘 접한 콘텐츠를 추가해보세요</p>
    </div>`;
    return;
  }

  const sorted = visible.slice().sort((x, y) => {
    // 정렬 그룹: 0 = 진행 중(일반), 1 = 완료(100%, 그날 동안 종료 탭과 함께 떠 있음)
    const groupOf = (w) => (w.progress >= 100 ? 1 : 0);
    const xGroup = groupOf(x.w), yGroup = groupOf(y.w);
    if (xGroup !== yGroup) return xGroup - yGroup;
    return x.realIdx - y.realIdx;
  });

  el.innerHTML = sorted.map(({ w, realIdx }, displayIdx) => {
    const complete = w.progress >= 100;
    const delta = watchDeltaForToday(w, viewingWatchDateKey);
    const deltaStr = (delta !== null && delta !== 0) ? `${delta > 0 ? '+' : ''}${delta}%p` : null;
    const memoCount = (w.memos || []).length;
    return `<div class="card watch-card type-watch-${w.type} ${complete ? 'completed' : ''}" data-id="${w.id}" onclick="handleCardTap(event,this)">
      <div class="reorder-handle">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
      </div>
      <div class="card-main">
        <div class="card-header">
          <div class="card-title-wrap">
            <div class="card-title">${esc(w.name)}</div>
            <div class="card-sub"><span class="type-chip">${WATCH_TYPE_LABEL[w.type]}</span>${w.author ? `<span class="time-chip">${esc(w.author)}</span>` : ''}${watchYearRatingChipsHTML(w)}</div>
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
            <button class="move-btn" onclick="moveWatchBlock(${w.id},-1)" ${displayIdx===0?'disabled':''} aria-label="위로"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg></button>
            <button class="move-btn" onclick="moveWatchBlock(${w.id},1)" ${displayIdx===sorted.length-1?'disabled':''} aria-label="아래로"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg></button>
          </div>
        </div>
        ${w.desc ? `<div class="block-desc">${escLinkify(w.desc, 32)}</div>` : ''}
        <div class="block-progress-row">
          ${watchProgressRowHTML(w, true)}
          ${deltaStr ? `<span class="watch-delta-chip">${deltaStr}</span>` : ''}
        </div>
        ${watchFocusRatioRowHTML(w, true)}
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
      // 보이는 항목들만 화면 순서대로 재배치하고, 숨겨진(예정/보관) 항목들은 원래 상대 위치를 그대로 유지한 채
      // 새로 배치된 항목들 사이사이에 끼워 넣는다. 이렇게 하면 보이지 않는 데이터가 사라지거나
      // 엉뚱한 자리로 튀지 않는다.
      const visibleOrder = sorted.map(x => x.w);
      const [moved] = visibleOrder.splice(fromIdx, 1);
      visibleOrder.splice(toIdx, 0, moved);

      const hidden = day.watchBlocks.filter(w => w.planned || w.archived);
      // 숨겨진 항목들이 원래 차지했던 위치 비율을 대략적으로 보존하기보다,
      // 단순하고 예측 가능하게: 보이는 항목들 재배열 후 맨 뒤에 숨겨진 항목들을 그대로 이어붙인다.
      day.watchBlocks = visibleOrder.concat(hidden);
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
    return `<div class="card watch-card type-watch-${item.type}" data-id="${item.id}" onclick="handleCardTap(event,this)">
      <div class="card-main">
        <div class="card-header">
          <div class="card-title-wrap">
            <div class="card-title">${esc(item.name)}</div>
            <div class="card-sub"><span class="type-chip">${WATCH_TYPE_LABEL[item.type]}</span>${item.author ? `<span class="time-chip">${esc(item.author)}</span>` : ''}${watchYearRatingChipsHTML(item)}<span class="time-chip watch-finished-date">${formatArchiveDateLabel(item.finishedDate)}</span>${item.archived ? '<span class="carryover-chip">보관</span>' : ''}</div>
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
        ${item.desc ? `<div class="block-desc">${escLinkify(item.desc, 32)}</div>` : ''}
        <div class="block-progress-row">
          ${watchProgressRowHTML(item, false)}
        </div>
        ${watchFocusRatioRowHTML(item, false)}
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
    return `<div class="card watch-card type-watch-${item.type}" data-id="${item.id}" onclick="handleCardTap(event,this)">
      <div class="reorder-handle">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
      </div>
      <div class="card-main">
        <div class="card-header">
          <div class="card-title-wrap">
            <div class="card-title">${esc(item.name)}</div>
            <div class="card-sub"><span class="type-chip">${WATCH_TYPE_LABEL[item.type]}</span>${item.author ? `<span class="time-chip">${esc(item.author)}</span>` : ''}${watchYearRatingChipsHTML(item)}</div>
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
        ${item.desc ? `<div class="block-desc">${escLinkify(item.desc, 32)}</div>` : ''}
        <div class="block-progress-row">
          ${watchProgressRowHTML(item, false)}
        </div>
        ${watchFocusRatioRowHTML(item, false)}
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
  document.getElementById('wfYear').value = item.year || '';
  document.getElementById('wfDesc').value = item.desc || '';
  document.getElementById('wfProgress').value = item.progress;
  document.getElementById('wfSeriesTotal').value = item.seriesTotal || '';
  document.getElementById('wfSeriesCurrent').value = item.seriesCurrent || 0;
  document.getElementById('wfFocusRatio').value = item.focusRatio || 0;
  onFocusRatioInputChange();
  pendingWatchRatings = Object.assign({}, item.ratings || {});
  pendingWatchRatingPresetId = item.ratingPresetId || null;
  refreshWatchRatingSection();
  document.getElementById('wfArchive').checked = kind === 'archive' ? !!item.archived : false;
  document.getElementById('wfPlanned').checked = kind === 'planned';
  // 종료 탭에서 열었으면 '예정' 체크는 의미가 없고, 예정 탭에서 열었으면 '보관' 체크는 의미가 없다.
  document.getElementById('wfPlannedField').classList.toggle('hidden', kind === 'archive');
  document.getElementById('wfArchiveField').classList.toggle('hidden', kind === 'planned');
  selectedWatchType = item.type;
  document.querySelectorAll('#wfTypeGroup .seg-btn').forEach(btn => btn.classList.toggle('selected', btn.dataset.val === item.type));
  onWatchTypeChanged();
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
    const added = syncCarryoversForToday();
    const watchAdded = syncWatchForToday();
    detachWatchArchiveLinks(); // 어제까지 연결되어 있던 종료/예정 복사본들을 독립시킴
    if (viewingDateKey === today) {
      renderBlocks();
      if (added > 0) showToast(`이어지는 블록 ${added}개가 오늘 목록에 추가됐어요`);
    }
    if (viewingWatchDateKey === today) renderWatchBlocks();
  }
  if (viewingDateKey === today) { renderDayHeader(); }
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

function copyMemo(id, dateKey) {
  const list = memos[dateKey || viewingMemoDateKey] || [];
  const m = list.find(x => x.id === id);
  if (!m) return;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(m.text).then(() => showToast('복사했어요')).catch(() => showToast('복사에 실패했어요'));
  } else {
    showToast('복사를 지원하지 않는 환경이에요');
  }
}

function deleteMemo(id, dateKey) {
  const dk = dateKey || viewingMemoDateKey;
  if (!memos[dk]) return;
  memos[dk] = memos[dk].filter(x => x.id !== id);
  saveMemos();
  // 삭제되는 메모가 고정되어 있었다면 고정에서도 자동으로 해제
  const beforeLen = pinnedMemos.length;
  pinnedMemos = pinnedMemos.filter(p => !(p.memoId === id && p.dateKey === dk));
  if (pinnedMemos.length !== beforeLen) { savePinnedMemos(); renderPinnedMemos(); }
  if (dk === viewingMemoDateKey) renderMemos();
  if (!document.getElementById('page-memo-archive').classList.contains('hidden')) renderMemoArchiveList();
}

function askDeleteMemo(id, dateKey) {
  const dk = dateKey || viewingMemoDateKey;
  document.getElementById('confirmMsg').innerHTML = '이 메모를 삭제할까요?<br>이 작업은 되돌릴 수 없어요.';
  document.getElementById('confirmOkBtn').onclick = () => {
    deleteMemo(id, dk);
    closeOverlay('confirmOverlay');
  };
  document.getElementById('confirmOverlay').classList.add('open');
}

/* =========================================================
   PINNED MEMOS
   날짜와 무관하게 메모 탭 상단에 공지처럼 항상 떠 있는 메모. 최대 3개까지 고정 가능하며,
   더 고정하려면 기존 고정 중 하나를 먼저 해제해야 한다(자동으로 밀어내지 않음).
   원본 메모가 삭제되면 고정 목록에서도 자동으로 빠진다.
   ========================================================= */
const MAX_PINNED_MEMOS = 3;

// 메모 보관/해제. pinnedMemos처럼 별도 목록을 두지 않고 메모 객체 자체에 플래그만 남겨서,
// 원본 위치(그 날짜의 메모 목록)에는 그대로 있고 작은 보관 아이콘만 붙는다.
function toggleMemoArchive(memoId, dateKey) {
  const list = memos[dateKey];
  if (!list) return;
  const m = list.find(x => x.id === memoId);
  if (!m) return;
  m.archived = !m.archived;
  saveMemos();
  renderMemos();
  if (!document.getElementById('page-memo-archive').classList.contains('hidden')) renderMemoArchiveList();
}

/* =========================================================
   MEMO ARCHIVE (메모 보관함)
   날짜와 무관하게 archived:true인 메모를 모두 모아 보여주는 별도 화면.
   원본은 그 날짜의 메모 목록에 그대로 남아있고(이동이 아니라 표시만), 여기서도
   바로 보관 해제할 수 있다. 최신/오래된순 정렬과 텍스트 검색을 지원한다.
   ========================================================= */
let memoArchiveSortDesc = true; // true: 최신순, false: 오래된순

function openMemoArchive() {
  document.getElementById('memoArchiveSearch').value = '';
  memoArchiveSortDesc = true;
  document.getElementById('memoArchiveSortBtn').textContent = '최신순';
  renderMemoArchiveList();
  document.getElementById('page-memo-archive').classList.remove('hidden');
}

function closeMemoArchive() {
  document.getElementById('page-memo-archive').classList.add('hidden');
}

function toggleMemoArchiveSort() {
  memoArchiveSortDesc = !memoArchiveSortDesc;
  document.getElementById('memoArchiveSortBtn').textContent = memoArchiveSortDesc ? '최신순' : '오래된순';
  renderMemoArchiveList();
}

function getAllArchivedMemos() {
  const result = [];
  Object.keys(memos).forEach(dateKey => {
    (memos[dateKey] || []).forEach(m => {
      if (m.archived) result.push({ memo: m, dateKey });
    });
  });
  return result;
}

const MEMO_ICON = {
  pin: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M16 3a1 1 0 0 1 1 1v6.5l2.4 4.8a1 1 0 0 1-.9 1.45H13v5a1 1 0 1 1-2 0v-5H5.5a1 1 0 0 1-.9-1.45L7 10.5V4a1 1 0 0 1 1-1z"/></svg>`,
  archive: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8"/><line x1="10" y1="12" x2="14" y2="12"/></svg>`,
  unarchive: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8"/><polyline points="9 12 12 9 15 12"/><line x1="12" y1="9" x2="12" y2="16"/></svg>`,
  copy: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`,
  delete: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>`
};

function renderMemoArchiveList() {
  const el = document.getElementById('memoArchiveList');
  const query = document.getElementById('memoArchiveSearch').value.trim().toLowerCase();

  let items = getAllArchivedMemos();
  if (query) items = items.filter(x => x.memo.text.toLowerCase().includes(query));
  items.sort((a, b) => {
    const ta = new Date(a.memo.time).getTime(), tb = new Date(b.memo.time).getTime();
    return memoArchiveSortDesc ? tb - ta : ta - tb;
  });

  if (!items.length) {
    el.innerHTML = `<div class="memo-empty">${query ? '검색 결과가 없어요' : '보관한 메모가 없어요'}</div>`;
    return;
  }

  el.innerHTML = items.map(({ memo: m, dateKey }) => {
    const t = new Date(m.time);
    const dateStr = `${t.getFullYear()}.${String(t.getMonth()+1).padStart(2,'0')}.${String(t.getDate()).padStart(2,'0')}`;
    const timeStr = `${String(t.getHours()).padStart(2,'0')}:${String(t.getMinutes()).padStart(2,'0')}`;
    return `<div class="memo-bubble">
      <div class="memo-text">${escLinkify(m.text, 40)}</div>
      <div class="memo-meta-row">
        <span class="memo-time">${dateStr} ${timeStr}</span>
        <div class="memo-btns">
          <button class="memo-icon-btn archived" onclick="toggleMemoArchive(${m.id},'${dateKey}')" aria-label="보관 해제">${MEMO_ICON.unarchive}</button>
          <button class="memo-icon-btn" onclick="copyMemo(${m.id},'${dateKey}')" aria-label="복사">${MEMO_ICON.copy}</button>
          <button class="memo-icon-btn danger" onclick="askDeleteMemo(${m.id},'${dateKey}')" aria-label="삭제">${MEMO_ICON.delete}</button>
        </div>
      </div>
    </div>`;
  }).join('');
}

function toggleMemoPin(memoId, dateKey) {
  const idx = pinnedMemos.findIndex(p => p.memoId === memoId && p.dateKey === dateKey);
  if (idx >= 0) {
    pinnedMemos.splice(idx, 1);
  } else {
    if (pinnedMemos.length >= MAX_PINNED_MEMOS) {
      showToast(`고정은 최대 ${MAX_PINNED_MEMOS}개까지예요. 기존 고정을 먼저 해제해주세요`);
      return;
    }
    pinnedMemos.push({ memoId, dateKey });
  }
  savePinnedMemos();
  renderPinnedMemos();
  renderMemos(); // 메모 목록의 "고정/고정됨" 버튼 상태도 같이 갱신
}

function renderPinnedMemos() {
  const el = document.getElementById('pinnedMemoList');
  if (!el) return; // 메모 탭이 아직 렌더링 전일 수 있음

  // 원본이 이미 삭제된 고정 항목이 있으면 정리 (예: 다른 경로로 데이터가 바뀐 경우의 안전장치)
  const valid = [];
  let changed = false;
  pinnedMemos.forEach(p => {
    const list = memos[p.dateKey] || [];
    if (list.some(m => m.id === p.memoId)) valid.push(p);
    else changed = true;
  });
  if (changed) { pinnedMemos = valid; savePinnedMemos(); }

  if (!pinnedMemos.length) { el.innerHTML = ''; el.classList.add('hidden'); return; }
  el.classList.remove('hidden');

  el.innerHTML = pinnedMemos.map(p => {
    const list = memos[p.dateKey] || [];
    const m = list.find(x => x.id === p.memoId);
    if (!m) return '';
    return `<div class="pinned-memo-row">
      <svg class="pinned-memo-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M16 3a1 1 0 0 1 1 1v6.5l2.4 4.8a1 1 0 0 1-.9 1.45H13v5a1 1 0 1 1-2 0v-5H5.5a1 1 0 0 1-.9-1.45L7 10.5V4a1 1 0 0 1 1-1z"/></svg>
      <span class="pinned-memo-text">${escLinkify(m.text, 60)}</span>
      <button class="pinned-memo-unpin" onclick="toggleMemoPin(${m.id},'${p.dateKey}')" aria-label="고정 해제">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>`;
  }).join('');
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
    const isPinned = pinnedMemos.some(p => p.memoId === m.id && p.dateKey === viewingMemoDateKey);
    const archiveIcon = m.archived
      ? `<svg class="memo-archived-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8"/><line x1="10" y1="12" x2="14" y2="12"/></svg>`
      : '';
    return `<div class="memo-bubble">
      <div class="memo-text">${archiveIcon}${escLinkify(m.text, 40)}</div>
      <div class="memo-meta-row">
        <span class="memo-time">${timeStr}</span>
        <div class="memo-btns">
          <button class="memo-icon-btn ${isPinned ? 'pinned' : ''}" onclick="toggleMemoPin(${m.id},'${viewingMemoDateKey}')" aria-label="${isPinned ? '고정 해제' : '고정'}">${MEMO_ICON.pin}</button>
          <button class="memo-icon-btn ${m.archived ? 'archived' : ''}" onclick="toggleMemoArchive(${m.id},'${viewingMemoDateKey}')" aria-label="${m.archived ? '보관 해제' : '보관'}">${MEMO_ICON.archive}</button>
          <button class="memo-icon-btn" onclick="copyMemo(${m.id})" aria-label="복사">${MEMO_ICON.copy}</button>
          <button class="memo-icon-btn danger" onclick="askDeleteMemo(${m.id})" aria-label="삭제">${MEMO_ICON.delete}</button>
        </div>
      </div>
    </div>`;
  }).join('');
  el.scrollTop = el.scrollHeight;
}

/* =========================================================
   YESTERDAY FEEDBACK
   ========================================================= */
/* =========================================================
   BLOCK COLOR (블록 커스텀 색상)
   블록의 기본 색은 유형(type)에 따라 CSS 변수로 정해지지만, 사용자가 색을 직접
   지정하면 block.color(hex)에 저장되고 카드에 인라인 스타일로 덧씌워진다.
   이월(carryover) 시에는 새 블록이 { ...template } 스프레드로 만들어지므로
   color 값도 자동으로 함께 이어진다.
   ========================================================= */
function isDarkModeActive() {
  return themePref === 'dark' || (themePref === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
}
function hexToRgb(hex) {
  let h = (hex || '').replace('#', '');
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  const n = parseInt(h, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
function mixColor(hex, target, ratio) {
  const { r, g, b } = hexToRgb(hex);
  const t = target === 'white' ? 255 : 0;
  const mr = Math.round(r + (t - r) * ratio), mg = Math.round(g + (t - g) * ratio), mb = Math.round(b + (t - b) * ratio);
  return `rgb(${mr},${mg},${mb})`;
}
// 카드에 적용할 인라인 style 문자열. color가 없거나, 절제(abstain) 유형처럼 경고성 반전 배색이
// 고정된 유형이면 빈 문자열(유형 기본색 그대로 사용) — 절제 카드는 흰 글씨 대비가 깨지는 걸 방지.
function blockColorStyle(color, type) {
  if (!color || type === 'abstain') return '';
  const dark = isDarkModeActive();
  const bg = mixColor(color, dark ? 'black' : 'white', dark ? 0.72 : 0.78);
  const border = dark ? mixColor(color, 'white', 0.15) : color;
  return `background:${bg};border-color:${border};`;
}

// 블록 폼의 색상 스와치 선택 처리 — hex가 빈 문자열/null이면 "기본색" 선택.
function selectBlockColor(hex) {
  selectedBlockColor = hex || null;
  document.querySelectorAll('#bfColorSwatches .color-swatch[data-color]').forEach(btn => {
    btn.classList.toggle('selected', (btn.dataset.color || '') === (selectedBlockColor || ''));
  });
  const customBtn = document.getElementById('bfColorCustomSwatch');
  const isCustom = selectedBlockColor && !BLOCK_COLOR_PRESETS.includes(selectedBlockColor);
  customBtn.classList.toggle('selected', !!isCustom);
  customBtn.style.background = isCustom ? selectedBlockColor : '';
  if (isCustom) document.getElementById('bfColorPicker').value = selectedBlockColor;
}
function renderBlockColorSwatches() {
  const el = document.getElementById('bfColorSwatches');
  if (!el || el.dataset.built) return; // 한 번만 생성
  el.dataset.built = '1';
  const presetsHtml = BLOCK_COLOR_PRESETS.map(hex =>
    `<button type="button" class="color-swatch" data-color="${hex}" style="background:${hex}" onclick="selectBlockColor('${hex}')" aria-label="색상 선택"></button>`
  ).join('');
  document.getElementById('bfColorDefaultSwatch').insertAdjacentHTML('afterend', presetsHtml);
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
  const isDark = isDarkModeActive();
  const themeColorMeta = document.querySelector('meta[name="theme-color"]');
  if (themeColorMeta) themeColorMeta.setAttribute('content', isDark ? '#1c1c1e' : '#ffffff');

  document.querySelectorAll('#themeSegGroup .seg-btn').forEach(b => b.classList.toggle('selected', b.dataset.val === themePref));
}

function selectTheme(pref) {
  themePref = pref;
  localStorage.setItem('pc_theme_pref', pref);
  applyTheme();
  renderBlocks(); // 커스텀 색이 지정된 블록의 명암 배합을 새 테마에 맞게 다시 계산
}

// 시스템 다크모드 설정이 바뀌는 경우(예: 야간에 자동 전환되는 OS 설정) 'system' 모드일 때 상태바 색을 같이 갱신
if (window.matchMedia) {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (themePref === 'system') { applyTheme(); renderBlocks(); }
  });
}

/* =========================================================
   BACKUP / IMPORT / WEIGHTS
   ========================================================= */
function openMenu() {
  applyTheme();
  document.getElementById('menuOverlay').classList.add('open');
}

function exportBackup() {
  const data = { days, carryoverMeta, watchChainMeta, memos, pinnedMemos, planBlocks, periodPlans, watchArchiveItems, watchPlannedItems, watchLists, watchRatingPresets, exportedAt: new Date().toISOString() };
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
      carryoverMeta = (data.carryoverMeta && typeof data.carryoverMeta === 'object') ? data.carryoverMeta : carryoverMeta;
      watchChainMeta = (data.watchChainMeta && typeof data.watchChainMeta === 'object') ? data.watchChainMeta : watchChainMeta;
      memos = (data.memos && typeof data.memos === 'object') ? data.memos : memos;
      if (Array.isArray(data.pinnedMemos)) pinnedMemos = data.pinnedMemos;
      if (Array.isArray(data.planBlocks)) planBlocks = data.planBlocks;
      if (Array.isArray(data.periodPlans)) periodPlans = data.periodPlans;
      if (Array.isArray(data.watchArchiveItems)) watchArchiveItems = data.watchArchiveItems;
      if (Array.isArray(data.watchPlannedItems)) watchPlannedItems = data.watchPlannedItems;
      if (Array.isArray(data.watchLists)) watchLists = data.watchLists;
      if (data.watchRatingPresets && typeof data.watchRatingPresets === 'object') watchRatingPresets = data.watchRatingPresets;
      saveDays(); saveCarryoverMeta(); saveWatchChainMeta(); saveMemos(); savePinnedMemos();
      savePlanBlocks(); savePeriodPlans(); saveWatchArchiveItems(); saveWatchPlannedItems(); saveWatchLists(); saveWatchRatingPresets();
      syncCarryoversForToday();
      syncWatchForToday();
      renderDayHeader(); renderBlocks();
      if (currentTab === 'memo') { renderMemoHeader(); renderPinnedMemos(); renderMemos(); }
      if (currentTab === 'watch') { renderWatchHeader(); renderWatchBlocks(); }
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
renderBlockColorSwatches();
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
renderPinnedMemos();
updateReorderButtonVisibility();
document.getElementById('simpleViewToggle').setAttribute('aria-pressed', simpleView ? 'true' : 'false');
document.getElementById('simpleViewToggle').classList.toggle('active', simpleView);
updateSimpleViewGrid();
initPlanSubtabSwipe();
initWatchSubtabSwipe();

// 진행 중인 타이머가 있으면 (예: 앱을 닫았다 다시 열었을 때) 화면 갱신을 위해
// 항상 tick 인터벌을 켜둔다. 타이머 시트가 열려있지 않으면 timerTick 내부에서
// 별다른 동작을 하지 않으므로 가볍다.
if (!timerTickHandle) timerTickHandle = setInterval(timerTick, 1000);

// 미니 알림도 앱이 열려있는 동안 주기적으로 시각을 확인한다 (20초 간격이면 분 단위 알림엔 충분).
checkMiniAlarms();
setInterval(checkMiniAlarms, 20000);
