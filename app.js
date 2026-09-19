/**
 * Farfalle al Salmone — интерактивный кулинарный гид.
 * Сквозная синхронизация телефон <-> ПК в реальном времени через ntfy.sh.
 */

const STORE_KEY = 'farfalle.v4';
const BASE_PORTIONS = 2;
const MAX_PORTIONS = 8;
const SYNC_SERVER = 'https://ntfy.sh';
const DEVICE_ID = 'dev_' + Math.random().toString(36).substring(2, 9) + Date.now();

const state = {
  portions: BASE_PORTIONS,
  timers: {},
  chefSteps: [],
  chefIndex: 0,
  wakeLock: null
};

let currentRoom = null;
let eventSource = null;
let syncBroadcastTimer = null;
let lastRemoteTimestamp = 0;

// -------------------------------------------------------------
// 1. Хранилище
// -------------------------------------------------------------
function readStore() {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
  } catch (e) {
    return {};
  }
}

function persist(skipBroadcast = false) {
  const timers = {};
  Object.entries(state.timers).forEach(([id, t]) => {
    timers[id] = { remaining: t.remaining, endAt: t.endAt, running: t.running, done: t.done };
  });

  const payload = {
    portions: state.portions,
    timers,
    ing: collect('.ing-check'),
    prep: collect('.prep-check'),
    table: collect('.table-check')
  };

  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(payload));
  } catch (e) {}

  if (!skipBroadcast) {
    queueBroadcast();
  }
}

function collect(selector) {
  return Array.from(document.querySelectorAll(selector)).map(i => i.checked);
}

// -------------------------------------------------------------
// 2. Сквозная синхронизация (Телефон <-> ПК)
// -------------------------------------------------------------
function getRoomId() {
  const urlParams = new URLSearchParams(window.location.search);
  const fromUrl = urlParams.get('room');
  if (fromUrl) {
    const clean = fromUrl.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
    if (clean) {
      localStorage.setItem('farfalle_room', clean);
      return clean;
    }
  }
  const fromStorage = localStorage.getItem('farfalle_room');
  if (fromStorage) return fromStorage;

  const rnd = Math.floor(100 + Math.random() * 900);
  const generated = `cook-${rnd}`;
  localStorage.setItem('farfalle_room', generated);
  return generated;
}

function queueBroadcast() {
  if (!currentRoom) return;
  clearTimeout(syncBroadcastTimer);

  const dot = document.getElementById('sync-indicator');
  if (dot) dot.classList.add('syncing');

  syncBroadcastTimer = setTimeout(async () => {
    const payload = {
      sender: DEVICE_ID,
      timestamp: Date.now(),
      portions: state.portions,
      ing: collect('.ing-check'),
      prep: collect('.prep-check'),
      table: collect('.table-check')
    };

    try {
      await fetch(`${SYNC_SERVER}/farfalle-kitchen-${currentRoom}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (dot) {
        dot.classList.remove('syncing');
        dot.classList.remove('offline');
      }
    } catch (e) {
      if (dot) dot.classList.add('offline');
    }
  }, 250);
}

function applyRemoteState(data) {
  if (!data || data.sender === DEVICE_ID) return;
  if (data.timestamp && data.timestamp <= lastRemoteTimestamp) return;
  if (data.timestamp) lastRemoteTimestamp = data.timestamp;

  let changedAny = false;

  if (typeof data.portions === 'number' && data.portions !== state.portions) {
    updatePortions(data.portions, { silent: true, skipBroadcast: true });
    changedAny = true;
  }

  if (Array.isArray(data.ing)) {
    const inputs = Array.from(document.querySelectorAll('.ing-check'));
    inputs.forEach((input, idx) => {
      if (typeof data.ing[idx] === 'boolean' && input.checked !== data.ing[idx]) {
        input.checked = data.ing[idx];
        input.closest('.ingredient-card')?.classList.toggle('checked', input.checked);
        changedAny = true;
      }
    });
    updateIngredientsProgress();
  }

  if (Array.isArray(data.prep)) {
    const inputs = Array.from(document.querySelectorAll('.prep-check'));
    inputs.forEach((input, idx) => {
      if (typeof data.prep[idx] === 'boolean' && input.checked !== data.prep[idx]) {
        input.checked = data.prep[idx];
        input.closest('.prep-item')?.classList.toggle('completed', input.checked);
        changedAny = true;
      }
    });
  }

  if (Array.isArray(data.table)) {
    const inputs = Array.from(document.querySelectorAll('.table-check'));
    inputs.forEach((input, idx) => {
      if (typeof data.table[idx] === 'boolean' && input.checked !== data.table[idx]) {
        input.checked = data.table[idx];
        input.closest('.mood-item')?.classList.toggle('completed', input.checked);
        changedAny = true;
      }
    });
    updateTableProgress();
  }

  if (changedAny) {
    persist(true);
    showToast('🔄 Синхронизировано с телефона', { duration: 2500 });
  }
}

async function initSync() {
  currentRoom = getRoomId();
  updateSyncUI();

  // 1. Поллинг последнего состояния из буфера ntfy (catch-up)
  try {
    const resp = await fetch(`${SYNC_SERVER}/farfalle-kitchen-${currentRoom}/json?poll=1`);
    if (resp.ok) {
      const text = await resp.text();
      const lines = text.trim().split('\n');
      for (const line of lines) {
        if (!line) continue;
        try {
          const msgObj = JSON.parse(line);
          if (msgObj.event === 'message' && msgObj.message) {
            const data = JSON.parse(msgObj.message);
            applyRemoteState(data);
          }
        } catch (e) {}
      }
    }
  } catch (e) {}

  // 2. Живая подписка на входящие события через SSE
  if ('EventSource' in window) {
    try {
      if (eventSource) eventSource.close();
      eventSource = new EventSource(`${SYNC_SERVER}/farfalle-kitchen-${currentRoom}/sse`);
      eventSource.onmessage = (e) => {
        try {
          const msgObj = JSON.parse(e.data);
          if (msgObj.event === 'message' && msgObj.message) {
            const data = JSON.parse(msgObj.message);
            applyRemoteState(data);
          }
        } catch (err) {}
      };
      eventSource.onerror = () => {
        const dot = document.getElementById('sync-indicator');
        if (dot) dot.classList.add('offline');
      };
      eventSource.onopen = () => {
        const dot = document.getElementById('sync-indicator');
        if (dot) dot.classList.remove('offline');
      };
    } catch (e) {}
  }
}

function updateSyncUI() {
  const codeEl = document.getElementById('sync-room-code');
  const labelEl = document.getElementById('sync-label');
  const qrImg = document.getElementById('sync-qr-img');

  if (codeEl) codeEl.textContent = currentRoom;
  if (labelEl) labelEl.textContent = currentRoom;

  // Формируем чистую ссылку для телефона
  const currentUrl = new URL(window.location.href);
  currentUrl.searchParams.set('room', currentRoom);
  const shareUrl = currentUrl.toString();

  if (qrImg) {
    qrImg.src = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(shareUrl)}`;
  }
}

function joinCustomRoom(newRoom) {
  const clean = newRoom.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
  if (!clean) return;

  localStorage.setItem('farfalle_room', clean);
  currentRoom = clean;

  const url = new URL(window.location.href);
  url.searchParams.set('room', clean);
  window.history.replaceState({}, '', url.toString());

  initSync();
  closeSyncModal();
  showToast(`🔗 Подключена комната: ${clean}`);
}

function openSyncModal() {
  updateSyncUI();
  const dialog = document.getElementById('sync-dialog');
  if (dialog) dialog.showModal();
}

function closeSyncModal() {
  const dialog = document.getElementById('sync-dialog');
  if (dialog) dialog.close();
}

// -------------------------------------------------------------
// 3. Звуковой сигнал таймера (Web Audio API)
// -------------------------------------------------------------
let audioCtx = null;

function getAudioContext() {
  if (!audioCtx) {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    audioCtx = new Ctor();
  }
  if (audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
  return audioCtx;
}

function playTimerDoneChime() {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    const now = ctx.currentTime;
    const freqs = [659.25, 987.77, 1318.51];

    freqs.forEach((freq, idx) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const at = now + idx * 0.12;

      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, at);

      gain.gain.setValueAtTime(0, at);
      gain.gain.linearRampToValueAtTime(0.22 / (idx + 1), at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 1.8);

      osc.connect(gain).connect(ctx.destination);
      osc.start(at);
      osc.stop(at + 1.8);
    });

    if (navigator.vibrate) navigator.vibrate([200, 100, 200, 100, 300]);
  } catch (e) {}
}

function playClickSound() {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'triangle';
    osc.frequency.setValueAtTime(440, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(180, ctx.currentTime + 0.04);

    gain.gain.setValueAtTime(0.05, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.04);

    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.04);
  } catch (e) {}
}

// -------------------------------------------------------------
// 4. Тосты
// -------------------------------------------------------------
function showToast(message, opts = {}) {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.innerHTML = message;
  container.appendChild(toast);

  while (container.children.length > 4) container.firstElementChild.remove();

  setTimeout(() => {
    toast.classList.add('leaving');
    setTimeout(() => toast.remove(), 280);
  }, opts.duration || 4000);
}

// -------------------------------------------------------------
// 5. Порции
// -------------------------------------------------------------
function pluralize(n, one, few, many) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

function formatAmount(base, unit, factor) {
  const raw = base * factor;

  switch (unit) {
    case 'г':
    case 'мл': {
      let v;
      if (raw >= 100) v = Math.round(raw / 10) * 10;
      else if (raw >= 20) v = Math.round(raw / 5) * 5;
      else v = Math.round(raw);
      return `${v} ${unit}`;
    }
    case 'л': {
      const v = Math.round(raw * 10) / 10;
      return `${String(v).replace('.', ',')} л`;
    }
    case 'ст. л.':
    case 'ч. л.': {
      const v = Math.round(raw * 2) / 2;
      return `${String(v).replace('.', ',')} ${unit}`;
    }
    case 'зубчика': {
      const v = Math.max(1, Math.round(raw));
      return `${v} ${pluralize(v, 'зубчик', 'зубчика', 'зубчиков')}`;
    }
    case 'шт': {
      const v = Math.max(1, Math.round(raw));
      return `${v} шт.`;
    }
    default: {
      const v = Math.round(raw * 10) / 10;
      return `${v} ${unit}`;
    }
  }
}

function updatePortions(newCount, opts = {}) {
  const clamped = Math.min(MAX_PORTIONS, Math.max(1, newCount));
  state.portions = clamped;

  const factor = clamped / BASE_PORTIONS;
  const countEl = document.getElementById('portion-count');
  if (countEl) countEl.textContent = clamped;

  document.querySelectorAll('[data-base-amount], .amt[data-base]').forEach(el => {
    const base = parseFloat(el.dataset.baseAmount ?? el.dataset.base);
    const unit = el.dataset.unit;
    if (Number.isNaN(base) || !unit) return;
    el.textContent = formatAmount(base, unit, factor);
  });

  const decBtn = document.getElementById('portion-decrease');
  const incBtn = document.getElementById('portion-increase');
  if (decBtn) decBtn.disabled = clamped <= 1;
  if (incBtn) incBtn.disabled = clamped >= MAX_PORTIONS;

  if (!opts.silent) {
    playClickSound();
    if (clamped > 4) {
      showToast('⚠️ Больше 4 порций — жарьте лосось в два захода.');
    }
  }

  if (state.chefSteps.length) renderChefStep();
  persist(Boolean(opts.skipBroadcast));
}

// -------------------------------------------------------------
// 6. Чек-листы
// -------------------------------------------------------------
function initChecklists(saved) {
  wireChecklist('.ing-check', saved.ing, input => {
    const card = input.closest('.ingredient-card');
    if (card) card.classList.toggle('checked', input.checked);
  }, updateIngredientsProgress);

  wireChecklist('.prep-check', saved.prep, input => {
    const item = input.closest('.prep-item');
    if (item) item.classList.toggle('completed', input.checked);
  });

  wireChecklist('.table-check', saved.table, input => {
    const item = input.closest('.mood-item');
    if (item) item.classList.toggle('completed', input.checked);
  }, updateTableProgress);
}

function wireChecklist(selector, savedArr, applyVisual, onChange) {
  const inputs = Array.from(document.querySelectorAll(selector));

  inputs.forEach((input, index) => {
    if (Array.isArray(savedArr) && typeof savedArr[index] === 'boolean') {
      input.checked = savedArr[index];
    }
    applyVisual(input);

    input.addEventListener('change', () => {
      playClickSound();
      applyVisual(input);
      if (onChange) onChange();
      persist();
    });
  });

  if (onChange) onChange();
}

function updateIngredientsProgress() {
  const inputs = document.querySelectorAll('.ing-check');
  const checked = document.querySelectorAll('.ing-check:checked').length;
  const percent = inputs.length ? Math.round((checked / inputs.length) * 100) : 0;

  const bar = document.getElementById('ingredients-progress-bar');
  const text = document.getElementById('ingredients-progress-text');
  if (bar) {
    bar.style.width = `${percent}%`;
    bar.classList.toggle('complete', checked === inputs.length && inputs.length > 0);
  }
  if (text) {
    text.textContent = `Собрано: ${checked} / ${inputs.length}`;
  }
}

function updateTableProgress() {
  const el = document.getElementById('table-progress');
  if (!el) return;
  const total = document.querySelectorAll('.table-check').length;
  const checked = document.querySelectorAll('.table-check:checked').length;
  el.textContent = `${checked} / ${total}`;
  el.classList.toggle('done', checked === total && total > 0);
}

function copyShoppingList() {
  const cards = document.querySelectorAll('.ingredient-card');
  const p = state.portions;
  let text = `🛒 Farfalle al Salmone — на ${p} ${pluralize(p, 'порцию', 'порции', 'порций')}\n\n`;

  cards.forEach(card => {
    const name = card.querySelector('.ing-name')?.textContent.trim() || '';
    const amount = card.querySelector('.ing-calc .amount')?.textContent.trim() || '';
    const mark = card.querySelector('.ing-check')?.checked ? '✅' : '⬜';
    text += `${mark} ${name} — ${amount}\n`;
  });

  text += '\nДома уже есть: соль, чёрный перец, растительное масло.';
  text += '\n\n🍝 Farfalle al Salmone. Buon Appetito!';

  const done = () => showToast('📋 Список скопирован в буфер обмена');
  const fail = () => showToast('Выделите список вручную');

  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(done).catch(() => legacyCopy(text, done, fail));
  } else {
    legacyCopy(text, done, fail);
  }
}

function legacyCopy(text, done, fail) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.top = '-1000px';
  ta.setAttribute('readonly', '');
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
  ta.remove();
  ok ? done() : fail();
}

// -------------------------------------------------------------
// 7. Таймеры по Date.now()
// -------------------------------------------------------------
function formatTime(seconds) {
  const s = Math.max(0, Math.round(seconds));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function startTimer(id) {
  const t = state.timers[id];
  if (!t || t.running) return;

  getAudioContext();

  if (t.remaining <= 0) t.remaining = t.total;
  t.endAt = Date.now() + t.remaining * 1000;
  t.running = true;
  t.done = false;

  highlightActiveStep(t.step);
  renderTimer(id);
  refreshWakeLock();
  persist(true);
}

function pauseTimer(id) {
  const t = state.timers[id];
  if (!t || !t.running) return;

  t.remaining = Math.max(0, Math.ceil((t.endAt - Date.now()) / 1000));
  t.running = false;
  t.endAt = 0;

  renderTimer(id);
  refreshWakeLock();
  persist(true);
}

function toggleTimer(id) {
  const t = state.timers[id];
  if (!t) return;
  t.running ? pauseTimer(id) : startTimer(id);
}

function resetTimer(id) {
  const t = state.timers[id];
  if (!t) return;

  t.running = false;
  t.done = false;
  t.endAt = 0;
  t.remaining = t.total;

  renderTimer(id);
  refreshWakeLock();
  playClickSound();
  persist(true);
}

function addTime(id, seconds) {
  const t = state.timers[id];
  if (!t) return;

  if (t.running) {
    t.endAt += seconds * 1000;
    t.remaining = Math.max(0, Math.ceil((t.endAt - Date.now()) / 1000));
  } else {
    t.remaining = Math.max(0, t.remaining + seconds);
    if (t.remaining > 0) t.done = false;
  }

  renderTimer(id);
  playClickSound();
  persist(true);
}

function finishTimer(id, opts = {}) {
  const t = state.timers[id];
  if (!t) return;

  t.running = false;
  t.remaining = 0;
  t.endAt = 0;
  t.done = true;

  renderTimer(id);
  refreshWakeLock();

  if (opts.silent) {
    showToast(`⏰ Таймер шага ${t.step} («${t.label}») истёк.`);
  } else {
    playTimerDoneChime();
    showToast(`🔔 <strong>Время вышло!</strong> Шаг ${t.step}: ${t.label}`, { duration: 8000 });
  }
  persist(true);
}

function tick() {
  let anyRunning = false;

  Object.keys(state.timers).forEach(id => {
    const t = state.timers[id];
    if (!t.running) return;
    anyRunning = true;

    const remaining = Math.max(0, Math.ceil((t.endAt - Date.now()) / 1000));
    if (remaining !== t.remaining) {
      t.remaining = remaining;
      renderTimer(id);
    }
    if (remaining <= 0) finishTimer(id);
  });

  if (anyRunning) renderTimerDock();
}

function renderTimer(id) {
  const t = state.timers[id];
  const display = document.getElementById(`timer-display-${id}`);
  const btn = document.querySelector(`.start-timer-btn[data-timer-id="${id}"]`);
  const wrapper = display ? display.closest('.step-timer-wrapper') : null;

  if (display) display.textContent = formatTime(t.remaining);

  if (btn) {
    btn.classList.toggle('running', t.running);
    if (t.running) btn.textContent = '⏸ Пауза';
    else if (t.done) btn.textContent = '↺ Ещё раз';
    else if (t.remaining < t.total) btn.textContent = '▶ Продолжить';
    else btn.textContent = `▶ Старт (${formatMinutes(t.total)})`;
  }

  if (wrapper) {
    wrapper.classList.toggle('timer-running', t.running);
    wrapper.classList.toggle('timer-done', t.done);
  }

  const chefStep = state.chefSteps[state.chefIndex];
  if (chefStep && String(chefStep.timerId) === String(id)) {
    const chefTime = document.getElementById('chef-time-display');
    const chefBtn = document.getElementById('chef-timer-toggle-btn');
    const chefBox = document.getElementById('chef-timer-box');
    if (chefTime) chefTime.textContent = formatTime(t.remaining);
    if (chefBox) {
      chefBox.classList.toggle('is-running', t.running);
      chefBox.classList.toggle('is-done', t.done);
    }
    if (chefBtn) {
      chefBtn.textContent = t.running ? '⏸ Пауза' : (t.done ? '↺ Ещё раз' : '▶ Запустить таймер');
    }
  }

  renderTimerDock();
}

function formatMinutes(seconds) {
  const m = seconds / 60;
  return `${String(Math.round(m * 10) / 10).replace('.', ',')} мин`;
}

function renderTimerDock() {
  const dock = document.getElementById('active-timers-bar');
  const list = document.getElementById('active-timers-list');
  if (!dock || !list) return;

  const running = Object.entries(state.timers).filter(([, t]) => t.running);

  if (running.length === 0) {
    dock.classList.add('hidden');
    list.replaceChildren();
    list.dataset.signature = '';
    syncDockHeight(0);
    return;
  }

  dock.classList.remove('hidden');

  const signature = running.map(([id]) => id).join(',');
  if (list.dataset.signature !== signature) {
    list.replaceChildren();
    running.forEach(([id, t]) => {
      const chip = document.createElement('div');
      chip.className = 'timer-chip';
      chip.dataset.timerId = id;

      const name = document.createElement('span');
      name.className = 'timer-chip-name';
      name.textContent = `Шаг ${t.step}: ${t.label}`;

      const time = document.createElement('span');
      time.className = 'timer-chip-time';
      time.textContent = formatTime(t.remaining);

      const stop = document.createElement('button');
      stop.className = 'timer-chip-stop';
      stop.title = 'Пауза';
      stop.textContent = '⏸';
      stop.addEventListener('click', () => pauseTimer(id));

      chip.append(name, time, stop);
      list.appendChild(chip);
    });
    list.dataset.signature = signature;
    syncDockHeight(dock.offsetHeight);
  } else {
    running.forEach(([id, t]) => {
      const chip = list.querySelector(`.timer-chip[data-timer-id="${id}"] .timer-chip-time`);
      if (chip) chip.textContent = formatTime(t.remaining);
    });
  }
}

function syncDockHeight(height) {
  document.documentElement.style.setProperty('--dock-height', `${height}px`);
}

// -------------------------------------------------------------
// 8. Конфорки
// -------------------------------------------------------------
const BURNER_MAP = {
  1: { pan: 'Мощность: 7' },
  2: { pot: 'Мощность: 9 (Boost)' },
  3: { pan: 'Мощность: 7' },
  4: { pan: 'Мощность: 7' },
  5: { pan: 'Мощность: 7' },
  6: { pan: 'Мощность: 4 (томление)' },
  7: { pot: 'Воду не выливать!', pan: 'Мощность: 6 (мантекатура)' },
  8: { }
};

function highlightActiveStep(stepNum) {
  document.querySelectorAll('.step-card').forEach(card => {
    card.classList.toggle('active-step', card.dataset.step === String(stepNum));
  });

  const potCard = document.getElementById('burner-pot-card');
  const panCard = document.getElementById('burner-pan-card');
  const potHeat = document.getElementById('pot-heat-indicator');
  const panHeat = document.getElementById('pan-heat-indicator');

  const map = BURNER_MAP[stepNum] || {};

  if (potCard) potCard.classList.toggle('active-burner', Boolean(map.pot));
  if (panCard) panCard.classList.toggle('active-burner', Boolean(map.pan));
  if (map.pot && potHeat) potHeat.textContent = map.pot;
  if (map.pan && panHeat) panHeat.textContent = map.pan;
}

// -------------------------------------------------------------
// 9. Wake Lock
// -------------------------------------------------------------
function needsWakeLock() {
  const chefDialog = document.getElementById('chef-mode-dialog');
  const chefOpen = chefDialog && chefDialog.open;
  const anyTimer = Object.values(state.timers).some(t => t.running);
  return Boolean(chefOpen || anyTimer);
}

async function refreshWakeLock() {
  const pill = document.getElementById('chef-wake-pill');

  if (!('wakeLock' in navigator)) {
    if (pill) pill.hidden = true;
    return;
  }

  if (needsWakeLock()) {
    if (state.wakeLock) return;
    try {
      state.wakeLock = await navigator.wakeLock.request('screen');
      state.wakeLock.addEventListener('release', () => { state.wakeLock = null; });
      if (pill) pill.hidden = false;
    } catch (e) {
      if (pill) pill.hidden = true;
    }
  } else if (state.wakeLock) {
    try { await state.wakeLock.release(); } catch (e) {}
    state.wakeLock = null;
    if (pill) pill.hidden = true;
  }
}

// -------------------------------------------------------------
// 10. Режим «Шеф на кухне»
// -------------------------------------------------------------
function buildChefSteps() {
  state.chefSteps = Array.from(document.querySelectorAll('.step-card')).map(card => ({
    el: card,
    step: Number(card.dataset.step),
    titleEl: card.querySelector('.step-title'),
    applianceEl: card.querySelector('.step-appliance'),
    descEl: card.querySelector('.step-instructions'),
    timerId: card.querySelector('.timer-display')?.id.replace('timer-display-', '') || null
  }));
}

function openChefMode(index = 0) {
  const chefDialog = document.getElementById('chef-mode-dialog');
  if (!chefDialog) return;
  state.chefIndex = index;
  renderChefStep();
  chefDialog.showModal();
  refreshWakeLock();
}

function closeChefMode() {
  const chefDialog = document.getElementById('chef-mode-dialog');
  if (chefDialog) chefDialog.close();
}

function renderChefStep() {
  const step = state.chefSteps[state.chefIndex];
  if (!step) return;

  const total = state.chefSteps.length;
  const ind = document.getElementById('chef-step-indicator');
  const bar = document.getElementById('chef-bar-fill');
  const app = document.getElementById('chef-appliance');
  const tit = document.getElementById('chef-title');
  const desc = document.getElementById('chef-desc');

  if (ind) ind.textContent = `Шаг ${step.step} из ${total}`;
  if (bar) bar.style.width = `${((state.chefIndex + 1) / total) * 100}%`;
  if (app && step.applianceEl) app.textContent = step.applianceEl.textContent.trim();
  if (tit && step.titleEl) tit.textContent = step.titleEl.textContent.trim();
  if (desc && step.descEl) desc.textContent = step.descEl.textContent.replace(/\s+/g, ' ').trim();

  const box = document.getElementById('chef-timer-box');
  if (box && step.timerId && state.timers[step.timerId]) {
    const t = state.timers[step.timerId];
    box.hidden = false;
    const timeEl = document.getElementById('chef-time-display');
    const btnEl = document.getElementById('chef-timer-toggle-btn');
    if (timeEl) timeEl.textContent = formatTime(t.remaining);
    if (btnEl) btnEl.textContent = t.running ? '⏸ Пауза' : (t.done ? '↺ Ещё раз' : '▶ Запустить таймер');
    box.classList.toggle('is-running', t.running);
    box.classList.toggle('is-done', t.done);
  } else if (box) {
    box.hidden = true;
  }

  const preview = document.getElementById('chef-next-preview');
  const next = state.chefSteps[state.chefIndex + 1];
  if (preview) {
    preview.textContent = next ? `Следом: ${next.titleEl?.textContent.trim()}` : 'Это последний шаг — подача на стол.';
  }

  const prevBtn = document.getElementById('chef-prev-btn');
  const nextBtn = document.getElementById('chef-next-btn');
  if (prevBtn) prevBtn.disabled = state.chefIndex === 0;
  if (nextBtn) nextBtn.textContent = state.chefIndex === total - 1 ? 'Завершить 🍝' : 'Вперед →';

  highlightActiveStep(step.step);
}

function chefNext() {
  if (state.chefIndex < state.chefSteps.length - 1) {
    state.chefIndex++;
    renderChefStep();
    playClickSound();
  } else {
    closeChefMode();
    showToast('🍝 Готово! Приятного аппетита!', { duration: 6000 });
  }
}

function chefPrev() {
  if (state.chefIndex > 0) {
    state.chefIndex--;
    renderChefStep();
    playClickSound();
  }
}

// -------------------------------------------------------------
// 11. Скроллспай
// -------------------------------------------------------------
function initScrollSpy() {
  const sections = Array.from(document.querySelectorAll('.nav-link'))
    .map(link => ({ link, el: document.querySelector(link.getAttribute('href')) }))
    .filter(s => s.el);

  if (sections.length === 0) return;

  const LINE = 120;
  let queued = false;

  function sync() {
    queued = false;
    const doc = document.documentElement;
    const atBottom = window.scrollY + window.innerHeight >= doc.scrollHeight - 4;

    let current = atBottom ? sections[sections.length - 1] : sections[0];
    if (!atBottom) {
      sections.forEach(s => {
        if (s.el.getBoundingClientRect().top <= LINE) current = s;
      });
    }

    sections.forEach(s => s.link.classList.toggle('active', s === current));
  }

  window.addEventListener('scroll', () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(sync);
  }, { passive: true });
  window.addEventListener('resize', sync);
  sync();
}

// -------------------------------------------------------------
// 12. Сброс всего
// -------------------------------------------------------------
function resetAll() {
  if (!confirm('Сбросить все галочки, таймеры и порции?')) return;

  Object.keys(state.timers).forEach(id => {
    const t = state.timers[id];
    t.running = false;
    t.done = false;
    t.endAt = 0;
    t.remaining = t.total;
    renderTimer(id);
  });

  document.querySelectorAll('.ing-check, .prep-check, .table-check').forEach(input => {
    input.checked = false;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });

  updatePortions(BASE_PORTIONS, { silent: true });

  try { localStorage.removeItem(STORE_KEY); } catch (e) {}
  showToast('↺ Все таймеры и чеклисты сброшены.');
}

// -------------------------------------------------------------
// 13. Инициализация приложения
// -------------------------------------------------------------
function initApp() {
  const saved = readStore();

  document.querySelectorAll('.timer-display').forEach(display => {
    const id = display.id.replace('timer-display-', '');
    const card = display.closest('.step-card');
    const total = parseInt(display.dataset.duration, 10);

    state.timers[id] = {
      total,
      remaining: total,
      endAt: 0,
      running: false,
      done: false,
      label: card?.querySelector('.step-title')?.textContent.trim() || '',
      step: Number(card?.dataset.step || id)
    };
  });

  const expired = [];
  if (saved.timers) {
    Object.entries(saved.timers).forEach(([id, s]) => {
      const t = state.timers[id];
      if (!t) return;

      if (s.running && s.endAt) {
        const remaining = Math.ceil((s.endAt - Date.now()) / 1000);
        if (remaining > 0) {
          t.running = true;
          t.endAt = s.endAt;
          t.remaining = remaining;
        } else {
          expired.push(id);
        }
      } else {
        t.remaining = typeof s.remaining === 'number' ? s.remaining : t.total;
        t.done = Boolean(s.done);
      }
    });
  }

  buildChefSteps();

  updatePortions(typeof saved.portions === 'number' ? saved.portions : BASE_PORTIONS, { silent: true });

  initChecklists(saved);
  Object.keys(state.timers).forEach(renderTimer);

  expired.forEach(id => finishTimer(id, { silent: true }));

  // Слушатели кнопок таймеров
  document.querySelectorAll('.start-timer-btn').forEach(btn => {
    btn.addEventListener('click', () => toggleTimer(btn.dataset.timerId));
  });
  document.querySelectorAll('.reset-timer-btn').forEach(btn => {
    btn.addEventListener('click', () => resetTimer(btn.dataset.timerId));
  });

  // Слушатели порций
  document.getElementById('portion-increase')?.addEventListener('click', () => updatePortions(state.portions + 1));
  document.getElementById('portion-decrease')?.addEventListener('click', () => updatePortions(state.portions - 1));

  // Список покупок & сброс
  document.getElementById('copy-shopping-list-btn')?.addEventListener('click', copyShoppingList);
  document.getElementById('reset-all-btn')?.addEventListener('click', resetAll);

  // Синхронизация
  document.getElementById('sync-btn')?.addEventListener('click', openSyncModal);
  document.getElementById('close-sync-btn')?.addEventListener('click', closeSyncModal);
  document.getElementById('sync-dialog')?.addEventListener('close', () => {});

  document.getElementById('copy-sync-link-btn')?.addEventListener('click', () => {
    const currentUrl = new URL(window.location.href);
    currentUrl.searchParams.set('room', currentRoom);
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(currentUrl.toString()).then(() => showToast('📋 Ссылка на синхронизацию скопирована'));
    } else {
      legacyCopy(currentUrl.toString(), () => showToast('📋 Ссылка скопирована'), () => showToast('Скопируйте вручную'));
    }
  });

  document.getElementById('sync-join-btn')?.addEventListener('click', () => {
    const input = document.getElementById('sync-custom-input');
    if (input && input.value) {
      joinCustomRoom(input.value);
    }
  });

  // Шеф режим
  document.getElementById('fullscreen-cook-btn')?.addEventListener('click', () => openChefMode(state.chefIndex));
  document.getElementById('close-chef-mode-btn')?.addEventListener('click', closeChefMode);
  document.getElementById('chef-next-btn')?.addEventListener('click', chefNext);
  document.getElementById('chef-prev-btn')?.addEventListener('click', chefPrev);

  document.getElementById('chef-timer-toggle-btn')?.addEventListener('click', () => {
    const s = state.chefSteps[state.chefIndex];
    if (s?.timerId) toggleTimer(s.timerId);
  });
  document.getElementById('chef-timer-reset-btn')?.addEventListener('click', () => {
    const s = state.chefSteps[state.chefIndex];
    if (s?.timerId) resetTimer(s.timerId);
  });
  document.getElementById('chef-timer-plus-btn')?.addEventListener('click', () => {
    const s = state.chefSteps[state.chefIndex];
    if (s?.timerId) addTime(s.timerId, 30);
  });

  const chefDialog = document.getElementById('chef-mode-dialog');
  if (chefDialog) chefDialog.addEventListener('close', refreshWakeLock);

  window.addEventListener('keydown', e => {
    if (!chefDialog || !chefDialog.open) return;
    const onButton = e.target instanceof HTMLElement && e.target.closest('button');

    if (e.code === 'Space' && !onButton) {
      e.preventDefault();
      const s = state.chefSteps[state.chefIndex];
      if (s?.timerId) toggleTimer(s.timerId);
    } else if (e.code === 'ArrowRight' && !onButton) {
      e.preventDefault();
      chefNext();
    } else if (e.code === 'ArrowLeft' && !onButton) {
      e.preventDefault();
      chefPrev();
    }
  });

  initScrollSpy();

  // Запуск облачной синхронизации
  initSync();

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      tick();
      refreshWakeLock();
    }
  });

  window.addEventListener('resize', () => {
    const dock = document.getElementById('active-timers-bar');
    if (dock) syncDockHeight(dock.classList.contains('hidden') ? 0 : dock.offsetHeight);
  });

  window.addEventListener('beforeunload', () => persist(false));

  setInterval(tick, 250);
  tick();
}

// Гарантированный старт даже если DOMContentLoaded уже произошел
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}
