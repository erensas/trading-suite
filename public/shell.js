// Unified shell: dashboard switching, engine mode badges and the trading kill switch.
// The system dashboard and FreqUI stay independent apps on their own paths; they are
// only framed here, so each keeps working on its own.

const CONTROL_HEADERS = { 'Content-Type': 'application/json', 'X-Trading-Control': '1' };
const ENGINE_LABELS = { freqtrade: 'Freqtrade', 'web3-dex-bot': 'Web3 DEX' };
const MODE_LABELS = { DRY_RUN: 'DRY-RUN', LIVE: 'LIVE', UNKNOWN: '?' };
const SHELL_VIEWS = ['trading', 'system', 'frequi'];

// FreqUI loads /assets/ from its root, so Caddy serves it on its own port
// (8443 over https, 8181 over http) instead of under a path prefix.
function resolveFrameSrc(src) {
  if (src !== '@frequi') return src;
  const port = window.location.protocol === 'https:' ? 8443 : 8181;
  return `${window.location.protocol}//${window.location.hostname}:${port}/`;
}

let controlState = null;
let modalMode = null;

function escapeHtml(value) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(value ?? '').replace(/[&<>"']/g, (c) => map[c]);
}

function renderEngines(engines) {
  const box = document.getElementById('engine-badges');
  if (!box) return;
  if (!Array.isArray(engines) || !engines.length) {
    box.innerHTML = '<span class="engine-badge mode-unknown">Mode unknown</span>';
    return;
  }
  box.innerHTML = engines
    .map((engine) => {
      const mode = (engine && engine.mode) || 'UNKNOWN';
      const cls = mode === 'LIVE' ? 'mode-live' : mode === 'DRY_RUN' ? 'mode-dry' : 'mode-unknown';
      const label = ENGINE_LABELS[engine.engine] || engine.engine || '?';
      const error = engine.detail && engine.detail.error ? ` title="${escapeHtml(engine.detail.error)}"` : '';
      return `<span class="engine-badge ${cls}"${error}>${escapeHtml(label)} · ${escapeHtml(MODE_LABELS[mode] || mode)} · ${escapeHtml(engine.state || '-')}</span>`;
    })
    .join('');
}

function renderControl(control) {
  const bar = document.getElementById('control-bar');
  const status = document.getElementById('halt-status');
  const btn = document.getElementById('kill-switch-btn');
  const kpi = document.getElementById('kpi-control');
  if (!bar || !status || !btn) return;

  const installed = !!(control && control.installed);
  const halted = installed && !!control.halted;

  bar.classList.toggle('is-halted', halted);
  status.classList.toggle('hidden', !halted);
  if (halted) {
    const when = control.changed_at ? new Date(control.changed_at).toLocaleString('en-GB') : '-';
    status.textContent = `TRADING HALTED · ${control.reason || '-'} · ${control.changed_by || '-'} · ${when}`;
  }

  btn.disabled = !installed;
  btn.classList.toggle('resume-btn', halted);
  btn.innerHTML = halted
    ? '<i class="fa-solid fa-play" aria-hidden="true"></i><span class="lbl">RESUME</span>'
    : '<i class="fa-solid fa-power-off" aria-hidden="true"></i><span class="lbl">KILL SWITCH</span>';
  btn.setAttribute('aria-label', halted ? 'Resume trading' : 'Kill switch: halt trading');
  btn.title = installed ? '' : 'Control table not installed (db/migrations/001_trading_control.sql)';

  if (kpi) {
    kpi.textContent = !installed ? 'NOT INSTALLED' : halted ? 'HALTED' : 'ACTIVE';
    kpi.style.color = !installed ? '#94a3b8' : halted ? '#fb7185' : '#34d399';
  }
}

async function loadControlStatus() {
  try {
    const res = await fetch('api/control/status');
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'status failed');
    controlState = data.control;
    renderControl(data.control);
    renderEngines(data.engines);
  } catch (e) {
    renderEngines([]);
  }
}

function openControlModal(mode) {
  const modal = document.getElementById('control-modal');
  const input = document.getElementById('control-modal-input');
  if (!modal || !input) return;
  modalMode = mode;
  const halting = mode === 'halt';
  document.getElementById('control-modal-title').textContent = halting
    ? 'Halt all trading?'
    : 'Resume trading?';
  document.getElementById('control-modal-text').textContent = halting
    ? 'Freqtrade stops opening positions (open positions are still managed by their rules), the Web3 scanner stops transmitting, and bridge forcebuy is rejected.'
    : 'Freqtrade is started again and the engines accept new trades. Type RESUME to confirm.';
  document.getElementById('control-modal-label').textContent = halting ? 'Reason (optional)' : 'Confirmation';
  input.value = '';
  input.placeholder = halting ? 'Manual kill switch' : 'RESUME';
  const confirmBtn = document.getElementById('control-modal-confirm');
  confirmBtn.textContent = halting ? 'HALT' : 'RESUME';
  confirmBtn.classList.toggle('resume-btn', !halting);
  modal.classList.remove('hidden');
  input.focus();
}

function closeControlModal() {
  const modal = document.getElementById('control-modal');
  if (modal) modal.classList.add('hidden');
  modalMode = null;
}

async function submitControlModal() {
  if (!modalMode) return;
  const halting = modalMode === 'halt';
  const input = document.getElementById('control-modal-input');
  const value = input ? input.value.trim() : '';
  if (!halting && value !== 'RESUME') {
    showToast('Confirmation required', 'Type RESUME to resume trading.', 'error');
    return;
  }

  const confirmBtn = document.getElementById('control-modal-confirm');
  if (confirmBtn) confirmBtn.disabled = true;
  try {
    const res = await fetch(halting ? 'api/control/halt' : 'api/control/resume', {
      method: 'POST',
      headers: CONTROL_HEADERS,
      body: JSON.stringify(halting ? { reason: value || 'Manual kill switch' } : { confirm: value }),
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error || `HTTP ${res.status}`);
    const summary = Object.entries(data.results || {})
      .map(([engine, result]) => `${escapeHtml(engine)}: ${escapeHtml(result)}`)
      .join('<br>');
    showToast(halting ? 'Trading halted' : 'Trading resumed', summary, halting ? 'error' : 'success');
    closeControlModal();
  } catch (e) {
    showToast('Control error', escapeHtml(e.message), 'error');
  } finally {
    if (confirmBtn) confirmBtn.disabled = false;
    loadControlStatus();
  }
}

function switchView(view, { history: addHistory = true } = {}) {
  if (!SHELL_VIEWS.includes(view)) return;
  document.querySelectorAll('.app-view').forEach((el) => el.classList.toggle('hidden', el.id !== `view-${view}`));
  document.querySelectorAll('.view-btn[data-view]').forEach((btn) => btn.classList.toggle('active', btn.dataset.view === view));

  // Embedded dashboards load on first visit only.
  const frame = document.querySelector(`#view-${view} iframe[data-src]`);
  if (frame && !frame.getAttribute('src')) frame.setAttribute('src', resolveFrameSrc(frame.dataset.src));

  // The trading view keeps its own route (#markets/..., see app.js); the other views are #system and #frequi.
  if (addHistory) {
    if (view !== 'trading') history.pushState(null, '', `#${view}`);
    else if (window.TS && TS.syncUrl) TS.syncUrl(true);
    else history.replaceState(null, '', location.pathname);
  }

  if (view === 'trading' && typeof chart !== 'undefined' && chart) {
    const container = document.getElementById('chart-wrapper');
    if (container) setTimeout(() => chart.applyOptions({ width: container.clientWidth }), 50);
  }
}

document.addEventListener('click', (event) => {
  const viewBtn = event.target.closest('.view-btn[data-view]');
  if (viewBtn) {
    switchView(viewBtn.dataset.view);
    return;
  }
  const killBtn = event.target.closest('#kill-switch-btn');
  if (killBtn) {
    if (!killBtn.disabled) openControlModal(controlState && controlState.halted ? 'resume' : 'halt');
    return;
  }
  const modalAction = event.target.closest('[data-modal-action]');
  if (modalAction) {
    if (modalAction.dataset.modalAction === 'confirm') submitControlModal();
    else closeControlModal();
    return;
  }
  if (event.target.id === 'control-modal') closeControlModal();
});

document.addEventListener('keydown', (event) => {
  if (!modalMode) return;
  if (event.key === 'Escape') closeControlModal();
  if (event.key === 'Enter' && event.target.id === 'control-modal-input') submitControlModal();
});

document.addEventListener('DOMContentLoaded', () => {
  const initialView = location.hash.replace('#', '');
  if (SHELL_VIEWS.includes(initialView)) switchView(initialView, { history: false });
  loadControlStatus();
  setInterval(loadControlStatus, 10000);
});

// ---- modal focus management -------------------------------------------------------
// Focus moves into a modal when it opens, Tab and Shift+Tab stay inside it, and focus goes
// back to the element that opened it when it closes.
const FOCUSABLE = 'a[href], button:not([disabled]):not([hidden]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
let modalOpener = null;
let lastFocusOutsideModal = null;
document.addEventListener('focusin', (event) => {
  if (!event.target.closest('.modal-backdrop')) lastFocusOutsideModal = event.target;
});

document.addEventListener('DOMContentLoaded', () => {
  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      const modal = m.target;
      if (!modal.classList.contains('hidden')) {
        modalOpener = lastFocusOutsideModal;
        if (!modal.contains(document.activeElement)) {
          setTimeout(() => {
            if (modal.contains(document.activeElement)) return;
            const first = modal.querySelector('input:not([type=checkbox]):not([disabled]), select, textarea') || modal.querySelector(FOCUSABLE);
            if (first) first.focus();
          }, 0);
        }
      } else if (modalOpener && document.body.contains(modalOpener)) {
        modalOpener.focus();
        modalOpener = null;
      }
    }
  });
  document.querySelectorAll('.modal-backdrop').forEach((el) => observer.observe(el, { attributes: true, attributeFilter: ['class'] }));
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Tab') return;
  const modal = document.querySelector('.modal-backdrop:not(.hidden)');
  if (!modal) return;
  const items = [...modal.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null);
  if (!items.length) return;
  const first = items[0];
  const last = items[items.length - 1];
  if (!modal.contains(document.activeElement)) {
    event.preventDefault();
    first.focus();
  } else if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
});
