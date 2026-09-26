// Unified shell: dashboard switching, engine mode badges and the trading kill switch.
// The system dashboard and FreqUI stay independent apps on their own paths; they are
// only framed here, so each keeps working on its own.

const CONTROL_HEADERS = { 'Content-Type': 'application/json', 'X-Trading-Control': '1' };
const ENGINE_LABELS = { freqtrade: 'Freqtrade', 'web3-dex-bot': 'Web3 DEX' };
const MODE_LABELS = { DRY_RUN: 'DRY-RUN', LIVE: 'LIVE', UNKNOWN: '?' };
const SHELL_VIEWS = ['trading', 'system', 'frequi'];

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
    box.innerHTML = '<span class="engine-badge mode-unknown">Mod bilinmiyor</span>';
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
    const when = control.changed_at ? new Date(control.changed_at).toLocaleString('tr-TR') : '-';
    status.textContent = `TRADING DURDURULDU · ${control.reason || '-'} · ${control.changed_by || '-'} · ${when}`;
  }

  btn.disabled = !installed;
  btn.classList.toggle('resume-btn', halted);
  btn.innerHTML = halted
    ? '<i class="fa-solid fa-play"></i> DEVAM ETTİR'
    : '<i class="fa-solid fa-power-off"></i> KILL SWITCH';
  btn.title = installed ? '' : 'Kontrol tablosu kurulmadı (db/migrations/001_trading_control.sql)';

  if (kpi) {
    kpi.textContent = !installed ? 'KONTROL KURULMADI' : halted ? 'DURDURULDU' : 'AKTİF';
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
    ? 'Tüm trading durdurulsun mu?'
    : 'Trading devam ettirilsin mi?';
  document.getElementById('control-modal-text').textContent = halting
    ? 'Freqtrade yeni pozisyon açmayı bırakır (açık pozisyonlar kurallarına göre yönetilmeye devam eder), Web3 scanner sinyal göndermeyi keser, bridge forcebuy reddedilir.'
    : 'Freqtrade yeniden başlatılır ve motorlar yeni işleme açılır. Onay için RESUME yazın.';
  document.getElementById('control-modal-label').textContent = halting ? 'Sebep (isteğe bağlı)' : 'Onay';
  input.value = '';
  input.placeholder = halting ? 'Manual kill switch' : 'RESUME';
  const confirmBtn = document.getElementById('control-modal-confirm');
  confirmBtn.textContent = halting ? 'DURDUR' : 'DEVAM ETTİR';
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
    showToast('Onay gerekli', 'Devam ettirmek için RESUME yazın.', 'error');
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
    showToast(halting ? 'Trading durduruldu' : 'Trading devam ediyor', summary, halting ? 'error' : 'success');
    closeControlModal();
  } catch (e) {
    showToast('Kontrol hatası', escapeHtml(e.message), 'error');
  } finally {
    if (confirmBtn) confirmBtn.disabled = false;
    loadControlStatus();
  }
}

function switchView(view) {
  if (!SHELL_VIEWS.includes(view)) return;
  document.querySelectorAll('.app-view').forEach((el) => el.classList.toggle('hidden', el.id !== `view-${view}`));
  document.querySelectorAll('.view-btn[data-view]').forEach((btn) => btn.classList.toggle('active', btn.dataset.view === view));

  // Embedded dashboards load on first visit only.
  const frame = document.querySelector(`#view-${view} iframe[data-src]`);
  if (frame && !frame.getAttribute('src')) frame.setAttribute('src', frame.dataset.src);

  history.replaceState(null, '', view === 'trading' ? location.pathname : `#${view}`);

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
  if (SHELL_VIEWS.includes(initialView)) switchView(initialView);
  loadControlStatus();
  setInterval(loadControlStatus, 10000);
});
