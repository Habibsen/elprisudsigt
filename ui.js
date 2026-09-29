// Elprisudsigt presentation layer. Data, pricing and caching live in data.js.
import { loadPrices, getSettings, saveSettings, formatPrice, slots } from './data.js';

const $ = (id) => document.getElementById(id);
const el = {
  app: $('app'),
  dayList: $('day-list'),
  heading: $('day-heading'),
  badge: $('type-badge'),
  stats: document.querySelector('.stats'),
  min: $('stat-min'),
  avg: $('stat-avg'),
  max: $('stat-max'),
  chart: $('chart'),
  grid: $('chart-grid'),
  bars: $('bars'),
  xAxis: $('x-axis'),
  caption: $('chart-caption'),
  readout: $('tooltip'),
  rTime: $('tooltip-time'),
  rPrice: $('tooltip-price'),
  rType: $('tooltip-type'),
  state: $('chart-state'),
  stateText: $('chart-state-text'),
  retry: $('retry-btn'),
  notice: $('notice'),
  updated: $('updated'),
  markupNote: $('markup-note'),
  refresh: $('refresh-btn'),
  settingsBtn: $('settings-btn'),
  dialog: $('settings-dialog'),
  form: $('settings-form'),
  markupInput: $('markup-input'),
  markupError: $('markup-error'),
  markupReset: $('markup-reset'),
  assumptions: $('assumptions'),
};

const SESSION_KEY = 'elprisudsigt:selectedDate';
const REFRESH_MS = 5 * 60 * 1000;
const FLAT_EPS = 0.005; // prices that round to the same øre are "equal"
const TYPE_TEXT = { official: 'Officiel', forecast: 'Prognose', mixed: 'Blandet', missing: 'Ingen data' };

const state = {
  data: null,
  selectedDate: readSession(),
  slots: [],        // [{slot, hour|null, el|null}] for the selected day, in time order
  active: -1,       // index into state.slots
  dragging: false,
  loading: false,
  lastLoad: 0,
  loadedDay: '',
};

window.appState = { data: null, selectedDate: state.selectedDate };

/* ---------------- helpers ---------------- */

function readSession() {
  try { return sessionStorage.getItem(SESSION_KEY) || null; } catch { return null; }
}
function writeSession(date) {
  try { sessionStorage.setItem(SESSION_KEY, date); } catch { /* private mode */ }
}
function syncAppState() {
  window.appState.data = state.data;
  window.appState.selectedDate = state.selectedDate;
}
function fmt(n) {
  return Number.isFinite(n) ? formatPrice(n) : '…';
}
function localDateKey() {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Copenhagen', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}
function currentDay() {
  return state.data?.days?.find((d) => d.date === state.selectedDate) || null;
}
function setAppState(name) {
  el.app.dataset.state = name;
  el.app.setAttribute('aria-busy', name === 'loading' ? 'true' : 'false');
}

function niceStep(raw) {
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / pow;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * pow;
}

function axisLabel(v, step) {
  if (Math.abs(v) < 1e-9) return '0';
  const decimals = step >= 1 ? 0 : step >= 0.1 && Math.abs(step * 10 - Math.round(step * 10)) < 1e-9 ? 1 : 2;
  return v.toLocaleString('da-DK', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function levelFor(price, min, max) {
  if (!Number.isFinite(min) || !Number.isFinite(max) || max - min < FLAT_EPS) return 'mid';
  const t = (price - min) / (max - min);
  return t <= 1 / 3 ? 'low' : t >= 2 / 3 ? 'high' : 'mid';
}

/* ---------------- day selector ---------------- */

function renderDays() {
  const days = state.data?.days || [];
  const frag = document.createDocumentFragment();
  for (const d of days) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'day';
    b.setAttribute('role', 'tab');
    b.dataset.date = d.date;
    b.setAttribute('aria-controls', 'chart');
    const selected = d.date === state.selectedDate;
    b.setAttribute('aria-selected', String(selected));
    b.tabIndex = selected ? 0 : -1;
    b.setAttribute('aria-label', `${d.longLabel}, ${TYPE_TEXT[d.type] || ''}`.replace(/, $/, ''));
    b.title = d.longLabel;

    const label = document.createElement('span');
    label.className = 'day-label';
    label.textContent = d.label;
    const dot = document.createElement('span');
    dot.className = 'day-dot';
    dot.dataset.type = d.type;
    dot.setAttribute('aria-hidden', 'true');
    b.append(label, dot);
    frag.append(b);
  }
  el.dayList.replaceChildren(frag);
}

function selectDate(date, { focus = false } = {}) {
  if (!state.data?.days?.some((d) => d.date === date)) return;
  const changed = date !== state.selectedDate;
  state.selectedDate = date;
  writeSession(date);
  for (const b of el.dayList.querySelectorAll('.day')) {
    const on = b.dataset.date === date;
    b.setAttribute('aria-selected', String(on));
    b.tabIndex = on ? 0 : -1;
    if (on && focus) b.focus();
  }
  renderDay({ animate: changed });
  syncAppState();
}

el.dayList.addEventListener('click', (e) => {
  const b = e.target.closest('.day');
  if (b) selectDate(b.dataset.date);
});

el.dayList.addEventListener('keydown', (e) => {
  const buttons = [...el.dayList.querySelectorAll('.day')];
  const i = buttons.findIndex((b) => b.dataset.date === state.selectedDate);
  if (i < 0) return;
  let next = -1;
  if (e.key === 'ArrowRight') next = Math.min(buttons.length - 1, i + 1);
  else if (e.key === 'ArrowLeft') next = Math.max(0, i - 1);
  else if (e.key === 'Home') next = 0;
  else if (e.key === 'End') next = buttons.length - 1;
  if (next < 0) return;
  e.preventDefault();
  selectDate(buttons[next].dataset.date, { focus: true });
});

/* ---------------- summary ---------------- */

function renderSummary(day) {
  el.heading.textContent = day ? day.longLabel : ' ';
  if (day) {
    el.badge.hidden = false;
    el.badge.dataset.type = day.type;
    el.badge.textContent = TYPE_TEXT[day.type] || '';
  } else {
    el.badge.hidden = true;
  }
  const has = day && day.hours.length > 0;
  el.min.textContent = has ? fmt(day.min) : '…';
  el.avg.textContent = has ? fmt(day.average) : '…';
  el.max.textContent = has ? fmt(day.max) : '…';
  el.stats.dataset.flat = String(!!has && day.max - day.min < FLAT_EPS);
}

/* ---------------- chart ---------------- */

function renderChart(day, { animate = false } = {}) {
  clearActive(true);
  const expected = slots(day.date);
  const byStart = new Map(day.hours.map((h) => [new Date(h.start).toISOString(), h]));
  // The real DST-aware timeline from data.js; day.expectedHours is the same count.
  el.chart.style.setProperty('--n', String(expected.length || day.expectedHours || 24));

  const prices = day.hours.map((h) => h.price).filter(Number.isFinite);
  const dMin = prices.length ? Math.min(...prices) : 0;
  const dMax = prices.length ? Math.max(...prices) : 1;

  // Honest signed scale: always include zero.
  let lo = Math.min(0, dMin);
  let hi = Math.max(0, dMax);
  if (hi - lo < 1e-9) hi = lo + 1;
  const step = niceStep((hi - lo) / 4);
  lo = Math.floor(lo / step) * step;
  hi = Math.ceil(hi / step) * step;
  const span = hi - lo;
  const y = (v) => ((hi - v) / span) * 100;
  const zeroY = y(0);

  // grid
  const gridFrag = document.createDocumentFragment();
  for (let v = lo, k = 0; v <= hi + step / 2 && k < 20; v += step, k++) {
    const val = Math.round(v / step) * step;
    const line = document.createElement('div');
    const isZero = Math.abs(val) < step / 1000;
    line.className = 'grid-line' + (isZero ? ' grid-line--zero' : '');
    line.style.setProperty('--y', `${y(val).toFixed(3)}%`);
    const label = document.createElement('span');
    label.textContent = axisLabel(isZero ? 0 : val, step);
    line.append(label);
    gridFrag.append(line);
  }
  el.grid.replaceChildren(gridFrag);

  // bars, one column per expected slot; gaps where data is absent
  const barFrag = document.createDocumentFragment();
  state.slots = [];
  let tabAssigned = false;
  for (const slot of expected) {
    const hour = byStart.get(slot.start) || null;
    if (!hour || !Number.isFinite(hour.price)) {
      const gap = document.createElement('span');
      gap.className = 'bar-gap';
      gap.dataset.start = slot.start;
      gap.setAttribute('aria-hidden', 'true');
      gap.style.cssText = 'flex:1 1 0;min-width:0;height:100%;';
      barFrag.append(gap);
      state.slots.push({ slot, hour: null, el: gap });
      continue;
    }
    const level = levelFor(hour.price, dMin, dMax);
    const col = document.createElement('button');
    col.type = 'button';
    col.className = 'bar-col';
    col.dataset.start = hour.start;
    col.dataset.price = String(hour.price);
    col.dataset.level = level;
    col.dataset.type = hour.type;
    col.dataset.index = String(state.slots.length);
    col.tabIndex = tabAssigned ? -1 : 0;
    tabAssigned = true;
    col.setAttribute(
      'aria-label',
      `${hour.label || slot.label}, ${formatPrice(hour.price)} kr./kWh, ${hour.type === 'forecast' ? 'prognose' : 'officiel'}`
    );

    const bar = document.createElement('span');
    bar.className = 'bar';
    bar.setAttribute('aria-hidden', 'true');
    const vy = y(hour.price);
    const top = Math.min(vy, zeroY);
    const height = Math.abs(vy - zeroY);
    bar.style.setProperty('--top', `${top.toFixed(3)}%`);
    bar.style.setProperty('--height', `${height.toFixed(3)}%`);
    bar.style.setProperty('--origin', hour.price < 0 ? '0%' : '100%');
    // Keep a 2px sliver visible for ~0 prices, centred on the zero line.
    if (height < 0.6) bar.style.setProperty('--top', `calc(${zeroY.toFixed(3)}% - 1px)`);
    col.append(bar);
    barFrag.append(col);
    state.slots.push({ slot, hour, el: col, level });
  }
  el.bars.replaceChildren(barFrag);

  // x-axis: labels at the real position of 00,03,…,21 (handles 23/25-hour days)
  const axisFrag = document.createDocumentFragment();
  const seen = new Set();
  expected.forEach((s, i) => {
    if (s.hour % 3 !== 0 || seen.has(s.hour)) return;
    seen.add(s.hour);
    const t = document.createElement('span');
    t.style.setProperty('--x', String(i));
    t.textContent = String(s.hour).padStart(2, '0');
    axisFrag.append(t);
  });
  el.xAxis.replaceChildren(axisFrag);

  el.caption.textContent =
    `Søjlediagram over elprisen time for time, ${day.longLabel}. ` +
    `Laveste ${fmt(day.min)}, gennemsnit ${fmt(day.average)}, højeste ${fmt(day.max)} kr./kWh.`;

  if (animate && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    el.bars.classList.remove('is-entering');
    void el.bars.offsetWidth;
    el.bars.classList.add('is-entering');
    clearTimeout(renderChart.t);
    renderChart.t = setTimeout(() => el.bars.classList.remove('is-entering'), 650);
  }

  showDefaultReadout();
}

/* ---------------- readout / exploration ---------------- */

function fillReadout(entry, level) {
  const { slot, hour } = entry;
  el.rTime.textContent = hour?.label || slot.label;
  if (hour) {
    el.rPrice.textContent = formatPrice(hour.price);
    el.rType.textContent = hour.type === 'forecast' ? 'Prognose' : 'Officiel';
    el.rType.dataset.type = hour.type;
  } else {
    el.rPrice.textContent = '…';
    el.rType.textContent = 'Ingen data';
    el.rType.dataset.type = 'missing';
  }
  el.readout.dataset.level = level || 'mid';
  el.readout.dataset.visible = 'true';
}

function nowIndex() {
  const now = Date.now();
  return state.slots.findIndex(
    ({ slot }) => Date.parse(slot.start) <= now && now < Date.parse(slot.end)
  );
}

function showDefaultReadout() {
  const i = state.selectedDate === localDateKey() ? nowIndex() : -1;
  if (i >= 0 && state.slots[i].hour) {
    fillReadout(state.slots[i], state.slots[i].level);
  } else {
    el.readout.dataset.visible = 'false';
  }
}

function setActive(i) {
  if (i < 0 || i >= state.slots.length) return;
  if (i === state.active) return;
  const prev = state.slots[state.active];
  if (prev?.el) prev.el.classList.remove('is-active');
  state.active = i;
  const cur = state.slots[i];
  if (cur.el && cur.hour) cur.el.classList.add('is-active');
  el.bars.dataset.exploring = 'true';
  fillReadout(cur, cur.level);
}

function clearActive(silent = false) {
  const prev = state.slots[state.active];
  if (prev?.el) prev.el.classList.remove('is-active');
  state.active = -1;
  state.dragging = false;
  delete el.bars.dataset.exploring;
  if (!silent) showDefaultReadout();
}

function indexFromX(clientX) {
  const r = el.bars.getBoundingClientRect();
  if (!r.width || !state.slots.length) return -1;
  const i = Math.floor(((clientX - r.left) / r.width) * state.slots.length);
  return Math.max(0, Math.min(state.slots.length - 1, i));
}

el.bars.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  if (!state.slots.length) return;
  state.dragging = true;
  try { el.bars.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  setActive(indexFromX(e.clientX));
});

el.bars.addEventListener('pointermove', (e) => {
  if (!state.slots.length) return;
  if (state.dragging || e.pointerType === 'mouse') setActive(indexFromX(e.clientX));
});

const endDrag = (e) => {
  state.dragging = false;
  try { el.bars.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
};
el.bars.addEventListener('pointerup', endDrag);
el.bars.addEventListener('pointercancel', (e) => {
  endDrag(e);
  clearActive(); // browser took over (vertical scroll)
});
el.bars.addEventListener('pointerleave', (e) => {
  if (e.pointerType === 'mouse' && !state.dragging && !el.bars.contains(document.activeElement)) clearActive();
});

// Tap outside the chart dismisses a touch selection.
document.addEventListener('pointerdown', (e) => {
  if (state.active >= 0 && !el.bars.contains(e.target)) clearActive();
});

// Keyboard: roving tabindex over hour columns.
el.bars.addEventListener('focusin', (e) => {
  const col = e.target.closest('.bar-col');
  if (!col) return;
  for (const c of el.bars.querySelectorAll('.bar-col')) c.tabIndex = c === col ? 0 : -1;
  setActive(Number(col.dataset.index));
});
el.bars.addEventListener('focusout', (e) => {
  if (!el.bars.contains(e.relatedTarget) && !state.dragging) clearActive();
});
el.bars.addEventListener('click', (e) => {
  const col = e.target.closest('.bar-col');
  if (col && e.detail === 0) setActive(Number(col.dataset.index)); // keyboard activation
});
el.bars.addEventListener('keydown', (e) => {
  const col = e.target.closest('.bar-col');
  if (!col) return;
  const cols = [...el.bars.querySelectorAll('.bar-col')];
  const i = cols.indexOf(col);
  let next = -1;
  if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = Math.min(cols.length - 1, i + 1);
  else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = Math.max(0, i - 1);
  else if (e.key === 'Home') next = 0;
  else if (e.key === 'End') next = cols.length - 1;
  else if (e.key === 'Escape') { col.blur(); clearActive(); return; }
  if (next < 0) return;
  e.preventDefault();
  cols[next].focus();
});

/* ---------------- day render ---------------- */

function renderDay({ animate = false } = {}) {
  const day = currentDay();
  renderSummary(day);
  if (!day) return;
  if (!day.hours.length) {
    clearActive(true);
    state.slots = [];
    el.bars.replaceChildren();
    el.grid.replaceChildren();
    el.readout.dataset.visible = 'false';
    setAppState('empty');
    showChartState('Der er endnu ingen priser for denne dag.', false);
    return;
  }
  setAppState('ready');
  hideChartState();
  renderChart(day, { animate });
}

function showChartState(text, retry) {
  el.stateText.textContent = text;
  el.retry.hidden = !retry;
  el.state.hidden = false;
}
function hideChartState() {
  el.state.hidden = true;
  el.retry.hidden = true;
}

function renderMeta() {
  const d = state.data;
  el.updated.textContent = d?.updated ? `Opdateret ${d.updated}` : 'Opdateret …';
  el.markupNote.textContent = `Inkl. moms og tillæg ${formatPrice(getSettings().markup)} kr./kWh`;
  if (d?.message) {
    el.notice.textContent = d.message;
    el.notice.hidden = false;
    if (d.stale) el.notice.dataset.kind = 'stale';
    else delete el.notice.dataset.kind;
  } else {
    el.notice.hidden = true;
    el.notice.textContent = '';
  }
  if (d?.assumptions) el.assumptions.textContent = d.assumptions;
}

function render({ animate = false } = {}) {
  const days = state.data?.days || [];
  if (!days.some((d) => d.date === state.selectedDate)) {
    state.selectedDate = days[0]?.date || null;
    if (state.selectedDate) writeSession(state.selectedDate);
  }
  renderDays();
  renderMeta();
  renderDay({ animate });
  syncAppState();
}

/* ---------------- loading ---------------- */

async function reload({ force = false, animate = false } = {}) {
  if (state.loading) return;
  state.loading = true;
  const first = !state.data;
  el.refresh.classList.add('is-spinning');
  el.refresh.disabled = true;
  if (first) {
    setAppState('loading');
    showChartState('Henter priser…', false);
  }
  try {
    const data = await loadPrices({ force });
    const prevActive = state.active >= 0 ? state.slots[state.active]?.slot.start : null;
    state.data = data;
    state.lastLoad = Date.now();
    state.loadedDay = localDateKey();
    render({ animate: first || animate });
    // Keep an in-progress exploration steady across silent refreshes.
    if (prevActive) {
      const i = state.slots.findIndex((s) => s.slot.start === prevActive);
      if (i >= 0) setActive(i);
    }
  } catch (err) {
    if (first) {
      setAppState('error');
      renderSummary(null);
      el.readout.dataset.visible = 'false';
      showChartState(
        (err && err.message && /[æøåÆØÅ]|Prøv/.test(err.message))
          ? err.message
          : 'Priserne kunne ikke hentes. Tjek forbindelsen og prøv igen.',
        true
      );
    } else {
      el.notice.textContent = 'Kunne ikke opdatere · Senest hentede data';
      el.notice.dataset.kind = 'stale';
      el.notice.hidden = false;
    }
    syncAppState();
  } finally {
    state.loading = false;
    el.refresh.classList.remove('is-spinning');
    el.refresh.disabled = false;
  }
}

el.refresh.addEventListener('click', () => reload({ force: true }));
el.retry.addEventListener('click', () => reload({ force: true }));

setInterval(() => {
  if (document.visibilityState === 'visible') reload();
}, REFRESH_MS);

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  const dayChanged = state.loadedDay && state.loadedDay !== localDateKey();
  if (!state.data || dayChanged || Date.now() - state.lastLoad > 60 * 1000) reload();
});

// Keep the "now" readout honest as hours tick over.
setInterval(() => {
  if (state.active < 0 && state.data && document.visibilityState === 'visible') showDefaultReadout();
}, 60 * 1000);

/* ---------------- settings ---------------- */

function setMarkupError(msg) {
  const field = el.markupInput.closest('.field');
  if (msg) {
    el.markupError.textContent = msg;
    el.markupError.hidden = false;
    field.dataset.invalid = 'true';
    el.markupInput.setAttribute('aria-invalid', 'true');
  } else {
    el.markupError.textContent = '';
    el.markupError.hidden = true;
    delete field.dataset.invalid;
    el.markupInput.removeAttribute('aria-invalid');
  }
}

function openSettings() {
  el.markupInput.value = formatPrice(getSettings().markup);
  setMarkupError('');
  if (state.data?.assumptions) el.assumptions.textContent = state.data.assumptions;
  if (typeof el.dialog.showModal === 'function') {
    if (!el.dialog.open) el.dialog.showModal();
  } else {
    el.dialog.setAttribute('open', '');
  }
}
function closeSettings() {
  if (typeof el.dialog.close === 'function') el.dialog.close();
  else el.dialog.removeAttribute('open');
  el.settingsBtn.focus();
}

el.settingsBtn.addEventListener('click', openSettings);
el.markupReset.addEventListener('click', () => {
  el.markupInput.value = formatPrice(0.09);
  setMarkupError('');
  el.markupInput.focus();
});
el.markupInput.addEventListener('input', () => setMarkupError(''));

el.form.addEventListener('submit', (e) => {
  e.preventDefault();
  const action = e.submitter?.value || 'save';
  if (action === 'cancel') { closeSettings(); return; }
  const raw = el.markupInput.value.trim().replace(/\s/g, '');
  if (!raw) { setMarkupError('Angiv et tillæg, fx 0,09.'); return; }
  const before = getSettings().markup;
  try {
    saveSettings({ markup: raw });
  } catch (err) {
    setMarkupError(err?.message || 'Ugyldigt tillæg.');
    el.markupInput.focus();
    return;
  }
  closeSettings();
  if (getSettings().markup !== before) {
    renderMeta();
    reload();
  }
});

// Tap on backdrop closes the sheet.
el.dialog.addEventListener('click', (e) => {
  if (e.target === el.dialog) closeSettings();
});

/* ---------------- start ---------------- */

reload();
