// Indicators on the chart (library in indicators.js), their layout per chart, and alerts.
//
// A layout is { indicators: [{ uid, id, params, colors, visible }], showVolume }. The
// 'default' layout applies to every chart; a symbol can have its own. Overlays share the
// price pane; every oscillator gets its own pane below it.

(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (v) => escapeHtml(v);
  const LC = LightweightCharts;
  const DEFS = Indicators.DEFS;
  const GROUP_ORDER = ['Moving averages', 'Trend', 'Volatility', 'Oscillators', 'Volume'];
  const PANE_HEIGHT = 120;

  const ST = {
    scope: 'default', // where the current layout is saved
    hasOwn: false,
    live: [], // [{ ind, series: { key: api }, lines: [] }]
    alertLines: [],
    saveTimer: null,
    loadRequest: 0,
  };
  TS.layout = { indicators: [], showVolume: true };

  const uid = () => Math.random().toString(36).slice(2, 10);
  const colorOf = (ind, out) => (ind.colors && ind.colors[out.key]) || out.color;

  // ---- drawing ---------------------------------------------------------------------------
  function clear() {
    for (const l of ST.live) for (const s of Object.values(l.series)) TS.chart.removeSeries(s);
    ST.live = [];
  }

  // Rebuilds every indicator series (after a layout change).
  function rebuild() {
    if (!TS.chart) return;
    clear();
    let pane = 0;
    for (const ind of TS.layout.indicators) {
      const def = DEFS[ind.id];
      if (!def || ind.visible === false) continue;
      const paneIndex = def.overlay ? 0 : ++pane;
      const series = {};
      for (const out of def.outputs) {
        const color = colorOf(ind, out);
        const common = { priceLineVisible: false, lastValueVisible: !def.overlay, crosshairMarkerVisible: false, title: '' };
        if (out.histogram) series[out.key] = TS.chart.addSeries(LC.HistogramSeries, { ...common, color }, paneIndex);
        else if (out.dots) series[out.key] = TS.chart.addSeries(LC.LineSeries, { ...common, color, lineVisible: false, pointMarkersVisible: true, pointMarkersRadius: 1.5 }, paneIndex);
        else series[out.key] = TS.chart.addSeries(LC.LineSeries, { ...common, color, lineWidth: def.overlay ? 2 : 1.5 }, paneIndex);
      }
      const first = series[def.outputs[0].key];
      const lines = (def.levels || []).map((level) => first.createPriceLine({ price: level, color: '#475569', lineWidth: 1, lineStyle: LC.LineStyle.Dashed, axisLabelVisible: false, title: '' }));
      ST.live.push({ ind, def, series, lines, paneIndex });
    }
    // Room for the oscillator panes: the chart grows instead of squeezing the candles.
    const wrapper = $('chart-wrapper');
    const base = window.matchMedia('(max-width: 640px)').matches ? 340 : window.matchMedia('(max-width: 900px)').matches ? 420 : 560;
    wrapper.style.height = `${base + pane * PANE_HEIGHT}px`;
    TS.chart.applyOptions({ height: wrapper.clientHeight });
    const panes = TS.chart.panes();
    for (let i = 1; i < panes.length; i++) panes[i].setHeight(PANE_HEIGHT);
    update();
    $('studies-count').textContent = TS.layout.indicators.length ? String(TS.layout.indicators.length) : '';
  }

  // New candles: recompute every indicator's data.
  function update() {
    const candles = TS.candles || [];
    for (const l of ST.live) {
      if (!candles.length) {
        for (const s of Object.values(l.series)) s.setData([]);
        continue;
      }
      const out = Indicators.compute(l.ind.id, candles, l.ind.params);
      for (const [key, s] of Object.entries(l.series)) s.setData(out[key] || []);
    }
    TS.refreshVolume();
    drawAlertLines();
    TS.renderLegend();
  }

  // Values under the crosshair (or the latest), for the chart legend.
  function legend(param) {
    return ST.live
      .map((l) => {
        const vals = l.def.outputs
          .map((o) => {
            const s = l.series[o.key];
            let v = param && param.time ? param.seriesData.get(s) : null;
            if (!v) {
              const data = s.data();
              v = data[data.length - 1];
            }
            return v && Number.isFinite(v.value) ? `<b style="color:${colorOf(l.ind, o)}">${TS.fmt.fmtPrice(v.value)}</b>` : '';
          })
          .join(' ');
        return `<span class="lg-study">${esc(Indicators.label(l.ind.id, l.ind.params))} ${vals}</span>`;
      })
      .join('');
  }

  TS.studies = { rebuild, update, legend };

  // ---- layout load / save -------------------------------------------------------------------
  async function loadLayout(symbol) {
    const request = ++ST.loadRequest;
    try {
      const d = await TS.api(`api/chart-layout?symbol=${encodeURIComponent(symbol || '')}`);
      if (request !== ST.loadRequest) return;
      ST.scope = d.scope;
      ST.hasOwn = d.hasOwn;
      TS.layout = { indicators: d.layout.indicators || [], showVolume: d.layout.showVolume !== false };
    } catch (e) {
      TS.layout = { indicators: [], showVolume: true };
    }
    rebuild();
    if (!$('studies-modal').classList.contains('hidden')) renderDialog();
  }

  function saveSoon() {
    clearTimeout(ST.saveTimer);
    $('studies-saved').textContent = 'saving…';
    ST.saveTimer = setTimeout(async () => {
      const scope = $('studies-own').checked && TS.activeSymbol ? TS.activeSymbol : 'default';
      try {
        await TS.apiSend('PUT', 'api/chart-layout', { scope, layout: TS.layout });
        ST.scope = scope;
        ST.hasOwn = scope !== 'default';
        $('studies-saved').textContent = `saved (${scope === 'default' ? 'every chart' : scope})`;
      } catch (e) {
        $('studies-saved').textContent = `not saved: ${e.message}`;
      }
    }, 600);
  }

  function changed({ redraw = true } = {}) {
    if (redraw) rebuild();
    renderActive();
    saveSoon();
  }

  // ---- indicator dialog ------------------------------------------------------------------------
  function renderLibrary() {
    const q = $('studies-search').value.trim().toLowerCase();
    const groups = {};
    for (const [id, d] of Object.entries(DEFS)) {
      if (q && !`${d.name} ${d.long} ${d.group}`.toLowerCase().includes(q)) continue;
      (groups[d.group] = groups[d.group] || []).push([id, d]);
    }
    $('studies-library').innerHTML =
      GROUP_ORDER.filter((g) => groups[g])
        .map(
          (g) =>
            `<div class="studies-group">${esc(g)}</div>` +
            groups[g].map(([id, d]) => `<button type="button" class="study-add" data-add-study="${id}"><span><b>${esc(d.name)}</b> <span class="muted">${esc(d.long)}</span></span><i class="fa-solid fa-plus" aria-hidden="true"></i></button>`).join('')
        )
        .join('') || '<div class="muted small pad">No indicator matches.</div>';
  }

  function paramInput(ind, p) {
    const v = (ind.params || {})[p.key] ?? p.default;
    if (p.options) return `<label class="inline-label">${esc(p.label)} <select data-param="${p.key}">${p.options.map((o) => `<option ${o === v ? 'selected' : ''}>${o}</option>`).join('')}</select></label>`;
    return `<label class="inline-label">${esc(p.label)} <input type="number" data-param="${p.key}" value="${v}" min="${p.min}" max="${p.max}" step="${p.step}"></label>`;
  }

  function renderActive() {
    const list = TS.layout.indicators;
    $('studies-active').innerHTML = list.length
      ? list
          .map((ind) => {
            const d = DEFS[ind.id];
            if (!d) return '';
            return `
        <div class="study-card${ind.visible === false ? ' off' : ''}" data-study="${ind.uid}">
          <div class="study-top">
            <b>${esc(Indicators.label(ind.id, ind.params))}</b> <span class="muted small">${d.overlay ? 'on price' : 'own pane'}</span>
            <span class="spacer"></span>
            <button type="button" class="icon-btn" data-study-toggle aria-label="${ind.visible === false ? 'Show' : 'Hide'}"><i class="fa-solid ${ind.visible === false ? 'fa-eye-slash' : 'fa-eye'}" aria-hidden="true"></i></button>
            <button type="button" class="icon-btn danger" data-study-remove aria-label="Remove"><i class="fa-solid fa-trash" aria-hidden="true"></i></button>
          </div>
          <div class="study-params">
            ${d.params.map((p) => paramInput(ind, p)).join('')}
            ${d.outputs.map((o) => `<label class="inline-label" title="${esc(o.key)}"><input type="color" data-color="${o.key}" value="${colorOf(ind, o)}" aria-label="${esc(o.key)} colour"> ${esc(o.key)}</label>`).join('')}
          </div>
        </div>`;
          })
          .join('')
      : '<div class="muted small pad">No indicators yet. Add one from the list.</div>';
  }

  function renderDialog() {
    $('studies-symbol').textContent = TS.activeSymbol || 'this symbol';
    $('studies-own').checked = ST.hasOwn;
    $('studies-volume').checked = TS.layout.showVolume !== false;
    renderLibrary();
    renderActive();
  }

  const findInd = (el) => TS.layout.indicators.find((i) => i.uid === el.closest('[data-study]').dataset.study);

  $('studies-library').addEventListener('click', (e) => {
    const b = e.target.closest('[data-add-study]');
    if (!b) return;
    const id = b.dataset.addStudy;
    TS.layout.indicators.push({ uid: uid(), id, params: Indicators.normalizeParams(id, {}), colors: {}, visible: true });
    changed();
  });
  $('studies-active').addEventListener('click', (e) => {
    if (!e.target.closest('[data-study]')) return;
    const ind = findInd(e.target);
    if (e.target.closest('[data-study-toggle]')) {
      ind.visible = ind.visible === false;
      return changed();
    }
    if (e.target.closest('[data-study-remove]')) {
      TS.layout.indicators = TS.layout.indicators.filter((i) => i !== ind);
      return changed();
    }
  });
  $('studies-active').addEventListener('change', (e) => {
    if (!e.target.closest('[data-study]')) return;
    const ind = findInd(e.target);
    if (e.target.dataset.param) {
      ind.params = Indicators.normalizeParams(ind.id, { ...ind.params, [e.target.dataset.param]: e.target.value });
      return changed();
    }
    if (e.target.dataset.color) {
      ind.colors = { ...(ind.colors || {}), [e.target.dataset.color]: e.target.value };
      return changed();
    }
  });
  $('studies-search').addEventListener('input', renderLibrary);
  $('studies-volume').addEventListener('change', (e) => {
    TS.layout.showVolume = e.target.checked;
    TS.refreshVolume();
    saveSoon();
  });
  $('studies-own').addEventListener('change', async (e) => {
    if (e.target.checked) return saveSoon();
    // Back to the shared layout: drop this symbol's own layout.
    try {
      await TS.apiSend('DELETE', `api/chart-layout/${encodeURIComponent(TS.activeSymbol)}`);
    } catch (err) {}
    await loadLayout(TS.activeSymbol);
  });

  function openStudies() {
    renderDialog();
    $('studies-modal').classList.remove('hidden');
    setTimeout(() => $('studies-search').focus(), 0);
  }
  $('btn-studies').addEventListener('click', openStudies);

  // ---- alerts ---------------------------------------------------------------------------------
  const AL = { lastEventId: 0, alerts: [] };
  const IND_FOR_ALERTS = Object.entries(DEFS).filter(([, d]) => !d.overlay || ['sma', 'ema'].includes(d.name.toLowerCase()));

  function drawAlertLines() {
    if (!TS.candleSeries) return;
    for (const l of ST.alertLines) TS.candleSeries.removePriceLine(l);
    ST.alertLines = AL.alerts
      .filter((a) => a.enabled && a.symbol === TS.activeSymbol && a.kind.startsWith('price'))
      .map((a) => TS.candleSeries.createPriceLine({ price: Number(a.value), color: '#fbbf24', lineWidth: 1, lineStyle: LC.LineStyle.Dotted, axisLabelVisible: true, title: `alert ${a.kind === 'price_above' ? '▲' : '▼'}` }));
  }

  async function loadAlerts() {
    try {
      const all = $('alerts-all').checked;
      const d = await TS.api(`api/alerts${all ? '' : `?symbol=${encodeURIComponent(TS.activeSymbol || '')}`}`);
      AL.alerts = d.alerts;
    } catch (e) {
      AL.alerts = [];
    }
    drawAlertLines();
    if (!$('alerts-modal').classList.contains('hidden')) renderAlerts();
  }

  function renderAlerts() {
    $('alerts-title').textContent = $('alerts-all').checked ? 'Alerts · all symbols' : `Alerts · ${TS.activeSymbol || ''}`;
    $('alerts-tbody').innerHTML = AL.alerts.length
      ? AL.alerts
          .map(
            (a) => `
        <tr data-alert="${a.id}">
          <td>${esc(a.text)}${a.repeat ? ' <span class="pill pill-gray">repeat</span>' : ''}${a.note ? `<div class="muted small">${esc(a.note)}</div>` : ''}</td>
          <td>${a.enabled ? (a.armed ? '<span class="pill pill-green">watching</span>' : '<span class="pill pill-warn">fired, waiting to re-arm</span>') : '<span class="pill pill-gray">off</span>'}</td>
          <td class="r mono">${a.last_value === null ? '-' : TS.fmt.fmtPrice(a.last_value)}</td>
          <td class="muted">${a.triggered_at ? TS.fmt.ago(a.triggered_at) : '-'}</td>
          <td class="r nowrap">
            <button type="button" class="icon-btn" data-alert-toggle aria-label="${a.enabled ? 'Switch off' : 'Switch on'}"><i class="fa-solid ${a.enabled ? 'fa-pause' : 'fa-play'}" aria-hidden="true"></i></button>
            <button type="button" class="icon-btn danger" data-alert-delete aria-label="Delete"><i class="fa-solid fa-trash" aria-hidden="true"></i></button>
          </td>
        </tr>`
          )
          .join('')
      : '<tr><td colspan="5" class="empty">No alerts.</td></tr>';
  }

  async function loadEvents() {
    try {
      const d = await TS.api('api/alert-events?limit=30');
      $('alert-events').innerHTML = d.events.length
        ? d.events.map((ev) => `<div class="alert-event${ev.seen ? '' : ' unseen'}"><span class="muted small">${TS.fmt.fmtTime(ev.at)}</span> ${esc(ev.message)}</div>`).join('')
        : '<div class="muted small">Nothing has fired yet.</div>';
    } catch (e) {}
  }

  // Poll for new alert events: toast each one and show the unseen count on the bell.
  async function pollEvents() {
    try {
      const d = await TS.api(`api/alert-events?after=${AL.lastEventId}&limit=20`);
      const fresh = d.events.filter((ev) => ev.id > AL.lastEventId);
      if (AL.lastEventId) for (const ev of fresh.reverse()) showToast('Alert', esc(ev.message), 'info');
      if (d.events.length) AL.lastEventId = Math.max(AL.lastEventId, ...d.events.map((ev) => Number(ev.id)));
      const badge = $('alerts-badge');
      badge.textContent = d.unseen ? String(d.unseen) : '';
      badge.classList.toggle('hidden', !d.unseen);
      if (fresh.length) loadAlerts();
    } catch (e) {}
  }

  function syncAlertForm() {
    const f = $('alert-form').elements;
    const ind = f.kind.value.startsWith('indicator');
    $('alert-form').querySelector('.alert-ind').classList.toggle('hidden', !ind);
    if (ind) {
      const def = DEFS[f.indicator.value];
      const len = def.params.find((p) => p.key === 'length');
      f.len.disabled = !len;
      if (len && !f.len.value) f.len.value = len.default;
      const current = f.output.value;
      f.output.innerHTML = def.outputs.filter((o) => !o.histogram || def.outputs.length === 1).map((o) => `<option ${o.key === current ? 'selected' : ''}>${o.key}</option>`).join('');
    }
  }

  function openAlerts() {
    const f = $('alert-form').elements;
    if (!f.indicator.options.length) {
      f.indicator.innerHTML = IND_FOR_ALERTS.map(([id, d]) => `<option value="${id}">${esc(d.name)} · ${esc(d.long)}</option>`).join('');
      f.indicator.value = 'rsi';
      f.timeframe.innerHTML = ['1m', '5m', '15m', '1h', '4h', '1d'].map((t) => `<option ${t === TS.activeTf ? 'selected' : ''}>${t}</option>`).join('');
    }
    const last = TS.candles && TS.candles.length ? TS.candles[TS.candles.length - 1].close : null;
    if (last && f.kind.value.startsWith('price')) f.value.value = Number(last.toPrecision(6));
    syncAlertForm();
    $('alerts-modal').classList.remove('hidden');
    loadAlerts().then(renderAlerts);
    loadEvents();
    TS.apiSend('POST', 'api/alert-events/seen', { all: true }).then(pollEvents).catch(() => {});
  }
  $('btn-alerts').addEventListener('click', openAlerts);
  $('alert-form').addEventListener('change', (e) => {
    if (['kind', 'indicator'].includes(e.target.name)) {
      if (e.target.name === 'indicator') $('alert-form').elements.len.value = '';
      syncAlertForm();
    }
  });
  $('alert-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target.elements;
    const body = { symbol: TS.activeSymbol, kind: f.kind.value, value: f.value.value, note: f.note.value, repeat: f.repeat.checked };
    if (body.kind.startsWith('indicator')) {
      const params = f.len.disabled ? {} : { length: Number(f.len.value) };
      body.indicator = { id: f.indicator.value, params, output: f.output.value };
      body.timeframe = f.timeframe.value;
    }
    try {
      const d = await TS.apiSend('POST', 'api/alerts', body);
      showToast('Alert added', esc(d.alert.text), 'success');
      f.note.value = '';
      await loadAlerts();
    } catch (err) {
      showToast('Alert not added', esc(err.message), 'error');
    }
  });
  $('alerts-tbody').addEventListener('click', async (e) => {
    const row = e.target.closest('[data-alert]');
    if (!row) return;
    const a = AL.alerts.find((x) => String(x.id) === row.dataset.alert);
    try {
      if (e.target.closest('[data-alert-toggle]')) await TS.apiSend('PUT', `api/alerts/${a.id}`, { enabled: !a.enabled });
      else if (e.target.closest('[data-alert-delete]')) await TS.apiSend('DELETE', `api/alerts/${a.id}`);
      else return;
      await loadAlerts();
    } catch (err) {
      showToast('Alert', esc(err.message), 'error');
    }
  });
  $('alerts-all').addEventListener('change', loadAlerts);

  // ---- wiring ----------------------------------------------------------------------------------
  for (const id of ['studies-modal', 'alerts-modal']) {
    $(id).addEventListener('click', (e) => {
      if (e.target.id === id) $(id).classList.add('hidden');
    });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      for (const id of ['studies-modal', 'alerts-modal']) if (!$(id).classList.contains('hidden')) return $(id).classList.add('hidden');
    }
    const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName);
    if (!typing && e.key.toLowerCase() === 'i' && !e.ctrlKey && !e.metaKey && !e.altKey && TS.activeTab === 'chart' && !document.querySelector('.modal-backdrop:not(.hidden)')) {
      e.preventDefault();
      openStudies();
    }
  });
  document.addEventListener('ts:symbol', (e) => {
    loadLayout(e.detail);
    loadAlerts();
  });
  TS.commands = TS.commands || [];
  TS.commands.push(
    { label: 'Indicators', icon: 'fa-wave-square', keywords: 'studies rsi macd ema bollinger', run: () => (TS.showTab('chart'), openStudies()) },
    { label: 'Alerts', icon: 'fa-bell', keywords: 'notify price', run: () => (TS.showTab('chart'), openAlerts()) }
  );

  pollEvents();
  setInterval(() => !document.hidden && pollEvents(), 20000);
})();
