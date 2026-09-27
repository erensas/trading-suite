// Pine editor under the chart: scripts saved on the server, run in the browser (pine.js) on
// the chart's candles, plots / shapes / strategy trades drawn on the chart, a strategy
// tester, and conversion of strategies into the Freqtrade strategy library.
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (v) => escapeHtml(v);
  const LC = LightweightCharts;
  const { fmtPrice, fmtPct, fmtTime } = TS.fmt;
  const PANE_HEIGHT = 140;
  const LS_KEY = 'pine';

  const ST = {
    scripts: [],
    current: null, // { id, name, example } or null for an unsaved script
    dirty: false,
    editor: null,
    result: null,
    source: null, // source of the last successful run
    inputs: {}, // overrides per script id (or 'new')
    series: [], // [{ plot, api }]
    priceLines: [],
    markers: null,
    ownPane: false,
    addedHeight: 0,
    errorLine: null,
    tab: 'output',
    visible: false,
  };

  // ---- CodeMirror mode for Pine ------------------------------------------------------------------
  CodeMirror.defineSimpleMode('pine', {
    start: [
      { regex: /\/\/.*/, token: 'comment' },
      { regex: /"(?:[^\\"]|\\.)*"|'(?:[^\\']|\\.)*'/, token: 'string' },
      { regex: /#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?\b/, token: 'number' },
      { regex: /\b(?:if|else|for|to|by|var|varip|and|or|not|true|false|na|while|switch)\b/, token: 'keyword' },
      { regex: /\b(?:float|int|bool|string|color|series|simple|const)\b(?=\s+[A-Za-z_])/, token: 'variable-3' },
      { regex: /\b(?:ta|math|strategy|input|color|plot|shape|location|size|str|syminfo|timeframe|barstate|display|hline)\.[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?/, token: 'variable-2' },
      { regex: /\b(?:indicator|strategy|plot|plotshape|plotchar|plotarrow|hline|bgcolor|fill|input|nz|na|fixnan|alertcondition)\b(?=\s*\()/, token: 'builtin' },
      { regex: /\b(?:open|high|low|close|volume|time|bar_index|hl2|hlc3|ohlc4|last_bar_index)\b/, token: 'atom' },
      { regex: /(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/i, token: 'number' },
      { regex: /:=|=>|==|!=|<=|>=|[-+*/%<>=?:]/, token: 'operator' },
      { regex: /[A-Za-z_]\w*(?=\s*\()/, token: 'def' },
    ],
    meta: { lineComment: '//' },
  });

  const NEW_SCRIPT = `//@version=5
indicator("My script", overlay=true)
len = input.int(20, "Length")
ma = ta.sma(close, len)
plot(ma, "SMA", color=color.orange)
`;

  function ensureEditor() {
    if (ST.editor) return ST.editor;
    ST.editor = CodeMirror($('pine-editor'), {
      value: '',
      mode: 'pine',
      theme: 'ts',
      lineNumbers: true,
      indentUnit: 4,
      tabSize: 4,
      indentWithTabs: false,
      extraKeys: {
        Tab: (cm) => (cm.somethingSelected() ? cm.indentSelection('add') : cm.replaceSelection('    ', 'end')),
        'Shift-Tab': (cm) => cm.indentSelection('subtract'),
        'Ctrl-Enter': () => runScript(),
        'Cmd-Enter': () => runScript(),
        'Ctrl-S': () => save(),
        'Cmd-S': () => save(),
      },
    });
    ST.editor.on('change', () => {
      if (ST.settingValue) return;
      ST.dirty = true;
      clearErrorLine();
      stateLabel();
    });
    return ST.editor;
  }

  function setSource(source) {
    ensureEditor();
    ST.settingValue = true;
    ST.editor.setValue(source);
    ST.settingValue = false;
    ST.editor.clearHistory();
    ST.dirty = false;
    clearErrorLine();
    stateLabel();
    setTimeout(() => ST.editor.refresh(), 0);
  }

  function stateLabel() {
    const c = ST.current;
    $('pine-state').innerHTML = `${c ? (c.example ? 'example' : 'saved') : '<span class="warn">not saved</span>'}${ST.dirty ? ' · <span class="warn">changed</span>' : ''}`;
    $('pine-delete').disabled = !c;
  }

  const inputKey = () => (ST.current ? String(ST.current.id) : 'new');

  // ---- scripts on the server ---------------------------------------------------------------------
  async function loadScripts(selectId) {
    try {
      ST.scripts = (await TS.api('api/pine/scripts')).scripts;
    } catch (e) {
      ST.scripts = [];
      out(`<div class="form-error">Scripts not loaded: ${esc(e.message)}</div>`);
    }
    renderSelect(selectId);
  }

  function renderSelect(selectId) {
    const opts = ST.scripts.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`);
    if (!ST.current) opts.unshift('<option value="">(new script)</option>');
    $('pine-select').innerHTML = opts.join('');
    $('pine-select').value = selectId !== undefined ? String(selectId) : ST.current ? String(ST.current.id) : '';
  }

  async function openScript(id) {
    try {
      const s = (await TS.api(`api/pine/scripts/${id}`)).script;
      ST.current = { id: s.id, name: s.name, example: s.example };
      setSource(s.source);
      renderSelect();
      TS.util.storage.set(LS_KEY, { id: s.id });
      runScript();
    } catch (e) {
      showToast('Pine', esc(e.message), 'error');
    }
  }

  async function confirmLeave() {
    if (!ST.dirty) return true;
    return TS.confirmAction({ title: 'Discard the changes?', text: 'The script in the editor has changes that are not saved.', ok: 'Discard', danger: true });
  }

  function titleOf(source) {
    const m = source.match(/^\s*(?:indicator|strategy|study)\s*\(\s*(["'])(.*?)\1/m);
    return m ? m[2] : 'My script';
  }

  async function save({ asNew = false } = {}) {
    const source = ensureEditor().getValue();
    try {
      if (ST.current && !asNew && !ST.current.example) {
        await TS.apiSend('PUT', `api/pine/scripts/${ST.current.id}`, { source });
        ST.dirty = false;
        showToast('Pine', `${esc(ST.current.name)} saved`, 'success');
      } else {
        const suggestion = ST.current && ST.current.example ? titleOf(source) : ST.current ? `${ST.current.name} (copy)` : titleOf(source);
        const name = await askName(ST.current && ST.current.example && !asNew ? 'Examples stay as they are: save a copy as' : 'Save the script as', suggestion);
        if (!name) return;
        const s = (await TS.apiSend('POST', 'api/pine/scripts', { name, source })).script;
        ST.inputs[String(s.id)] = ST.inputs[inputKey()] || {};
        ST.current = { id: s.id, name: s.name, example: false };
        ST.dirty = false;
        TS.util.storage.set(LS_KEY, { id: s.id });
        showToast('Pine', `${esc(s.name)} saved`, 'success');
      }
      await loadScripts();
      stateLabel();
    } catch (e) {
      showToast('Pine: not saved', esc(e.message), 'error');
    }
  }

  function askName(title, value) {
    return new Promise((resolve) => {
      const box = document.createElement('div');
      box.className = 'modal-backdrop';
      box.innerHTML = `<form class="modal-card"><div class="modal-title">${esc(title)}</div><input name="n" maxlength="80" required><div class="modal-actions"><button type="button" class="btn-secondary" data-x>Cancel</button><button type="submit" class="btn-buy">Save</button></div></form>`;
      document.body.appendChild(box);
      const input = box.querySelector('input');
      input.value = value;
      setTimeout(() => input.select(), 0);
      const done = (v) => {
        box.remove();
        resolve(v);
      };
      box.querySelector('form').onsubmit = (e) => {
        e.preventDefault();
        done(input.value.trim());
      };
      box.querySelector('[data-x]').onclick = () => done(null);
      box.onkeydown = (e) => e.key === 'Escape' && done(null);
    });
  }

  // ---- run and draw -------------------------------------------------------------------------------
  function out(html) {
    $('pine-output').innerHTML = html;
  }

  function clearErrorLine() {
    if (ST.errorLine !== null && ST.editor) ST.editor.removeLineClass(ST.errorLine, 'background', 'cm-pine-error');
    ST.errorLine = null;
  }

  function runScript({ quiet = false } = {}) {
    const source = ensureEditor().getValue();
    const candles = TS.candles || [];
    clearErrorLine();
    if (!candles.length) {
      out('<div class="muted">No candles on the chart yet.</div>');
      return;
    }
    const t0 = performance.now();
    try {
      const result = Pine.run(source, candles, { inputs: ST.inputs[inputKey()] || {}, symbol: TS.activeSymbol || '', timeframe: TS.activeTf || '' });
      ST.result = result;
      ST.source = source;
      const ms = Math.round(performance.now() - t0);
      const s = result.strategy;
      out(`<div class="pine-ok"><i class="fa-solid fa-circle-check" aria-hidden="true"></i> ${esc(result.meta.kind || 'script')} “${esc(result.meta.title)}” ran on ${result.bars} bars of ${esc(TS.activeSymbol || '')} ${esc(TS.activeTf || '')} in ${ms} ms: ${result.plots.length} plot${result.plots.length === 1 ? '' : 's'}${result.shapes.length ? `, ${result.shapes.length} shapes` : ''}${s ? `, ${s.totalTrades} closed trades` : ''}.</div>
        ${result.warnings.map((w) => `<div class="warn small">⚠ ${esc(w)}</div>`).join('')}`);
      renderInputs();
      renderStrategy();
      if ($('pine-on-chart').checked) redraw();
      if (!quiet && s && ST.tab === 'output') setTab('strategy');
    } catch (e) {
      const line = e.line || null;
      out(`<div class="form-error">${esc(e.message)}</div>`);
      if (line && ST.editor && line <= ST.editor.lineCount()) {
        ST.errorLine = line - 1;
        ST.editor.addLineClass(ST.errorLine, 'background', 'cm-pine-error');
        if (!quiet) ST.editor.scrollIntoView({ line: ST.errorLine, ch: 0 }, 60);
      }
      if (!quiet) setTab('output');
    }
  }

  function renderInputs() {
    const inputs = (ST.result && ST.result.inputs) || [];
    $('pine-inputs-count').textContent = inputs.length ? String(inputs.length) : '';
    if (!inputs.length) {
      $('pine-inputs').innerHTML = '<div class="muted small">The script has no inputs (input.int, input.float, input.bool, input.source…).</div>';
      return;
    }
    const field = (x) => {
      const name = `in-${x.key}`;
      if (x.type === 'bool') return `<label class="check small"><input type="checkbox" name="${esc(name)}" ${x.value ? 'checked' : ''}> ${esc(x.title)}</label>`;
      if (x.type === 'source') return `<label>${esc(x.title)}<select name="${esc(name)}">${['open', 'high', 'low', 'close', 'hl2', 'hlc3', 'ohlc4', 'volume'].map((o) => `<option ${o === x.value ? 'selected' : ''}>${o}</option>`).join('')}</select></label>`;
      if (x.options) return `<label>${esc(x.title)}<select name="${esc(name)}">${x.options.map((o) => `<option ${o === x.value ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select></label>`;
      if (x.type === 'string') return `<label>${esc(x.title)}<input name="${esc(name)}" value="${esc(x.value)}"></label>`;
      return `<label>${esc(x.title)}<input type="number" name="${esc(name)}" value="${esc(x.value)}" ${x.min !== null ? `min="${esc(x.min)}"` : ''} ${x.max !== null ? `max="${esc(x.max)}"` : ''} step="${esc(x.step || (x.type === 'int' ? 1 : 'any'))}"></label>`;
    };
    $('pine-inputs').innerHTML = `<div class="pine-inputs-grid">${inputs.map(field).join('')}</div><div class="toolbar-row"><button type="button" class="btn-secondary small-btn" id="pine-inputs-reset">Defaults</button><span class="muted small">Changes run the script again; they are kept in this browser, not in the script.</span></div>`;
  }

  $('pine-inputs').addEventListener('change', (e) => {
    const el = e.target;
    if (!el.name || !el.name.startsWith('in-')) return;
    const key = el.name.slice(3);
    const inp = (ST.result.inputs || []).find((x) => x.key === key);
    const map = (ST.inputs[inputKey()] = ST.inputs[inputKey()] || {});
    map[key] = el.type === 'checkbox' ? el.checked : inp && (inp.type === 'int' || inp.type === 'float') ? Number(el.value) : el.value;
    saveInputs();
    runScript({ quiet: true });
  });
  $('pine-inputs').addEventListener('click', (e) => {
    if (e.target.id !== 'pine-inputs-reset') return;
    delete ST.inputs[inputKey()];
    saveInputs();
    runScript({ quiet: true });
  });
  function saveInputs() {
    TS.util.storage.set('pineInputs', ST.inputs);
  }

  function renderStrategy() {
    const s = ST.result && ST.result.strategy;
    if (!s) {
      $('pine-strategy').innerHTML = '<div class="muted small">Only strategy(...) scripts are tested: they place orders with strategy.entry, strategy.close and strategy.exit. Orders fill at the next bar\'s open.</div>';
      return;
    }
    const kv = (k, v) => `<div class="kv"><div class="k">${esc(k)}</div><div class="v">${v}</div></div>`;
    const pct = (v) => (v === null || v === undefined ? '-' : `<span class="${v > 0 ? 'pos' : v < 0 ? 'neg' : ''}">${fmtPct(v)}</span>`);
    const trades = s.trades.slice(-100).reverse();
    $('pine-strategy').innerHTML = `<div class="kv-grid pine-kv">
        ${kv('Net profit', `${pct(s.netProfitPct)} · ${fmtPrice(s.netProfit)}`)}
        ${kv('Closed trades', `${s.totalTrades} (${s.wins} won)`)}
        ${kv('Win rate', s.winRate === null ? '-' : `${s.winRate.toFixed(1)}%`)}
        ${kv('Profit factor', s.profitFactor === null ? '-' : s.profitFactor.toFixed(2))}
        ${kv('Max drawdown', `${s.maxDrawdownPct.toFixed(2)}%`)}
        ${kv('Avg trade', pct(s.avgTradePct))}
        ${kv('Buy & hold', pct(s.buyHoldPct))}
        ${kv('Open trade', s.openTrade ? `${esc(s.openTrade.dir)} ${esc(s.openTrade.id)} ${pct(s.openTrade.profitPct)}` : '-')}
      </div>
      <div class="muted small">Initial capital ${fmtPrice(s.initialCapital)}; ${esc(TS.activeSymbol || '')} ${esc(TS.activeTf || '')}, ${ST.result.bars} bars on the chart. For a longer test with fees and several pairs, convert it to Freqtrade and backtest it.</div>
      <div class="table-container pine-trades"><table><thead><tr><th>Entry</th><th>Exit</th><th>Side</th><th class="r">Entry price</th><th class="r">Exit price</th><th class="r">Profit</th><th>Exit</th></tr></thead><tbody>
      ${trades.map((t) => `<tr><td class="small nowrap">${esc(fmtTime(t.entryTime * 1000))}</td><td class="small nowrap">${esc(fmtTime(t.exitTime * 1000))}</td><td>${esc(t.dir)}</td><td class="r">${fmtPrice(t.entryPrice)}</td><td class="r">${fmtPrice(t.exitPrice)}</td><td class="r">${pct(t.profitPct)}</td><td class="small">${esc(t.reason)}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">No closed trades.</td></tr>'}
      </tbody></table></div>`;
  }

  // Chart layer: removed and added around the indicator panes (studies.js calls detach/attach).
  function detach() {
    if (!TS.chart) return;
    for (const l of ST.priceLines) {
      try {
        l.series.removePriceLine(l.line);
      } catch (e) {}
    }
    ST.priceLines = [];
    for (const s of ST.series) TS.chart.removeSeries(s.api);
    ST.series = [];
    if (ST.markers) ST.markers.setMarkers([]);
    if (ST.addedHeight) {
      const wrapper = $('chart-wrapper');
      wrapper.style.height = `${Math.max(200, wrapper.clientHeight - ST.addedHeight)}px`;
      TS.chart.applyOptions({ height: wrapper.clientHeight });
      ST.addedHeight = 0;
    }
  }

  const lineData = (plot) =>
    (TS.candles || []).map((c, k) => {
      const v = plot.values[k];
      if (!Number.isFinite(v)) return { time: c.time };
      const pt = { time: c.time, value: v };
      if (plot.colors[k]) pt.color = plot.colors[k];
      return pt;
    });

  function attach() {
    const r = ST.result;
    if (!TS.chart || !r || !$('pine-on-chart').checked || !ST.visible) return;
    if ((r.bars || 0) !== (TS.candles || []).length) return;
    const overlay = !!r.meta.overlay;
    const paneIndex = overlay ? 0 : TS.chart.panes().length;
    for (const plot of r.plots) {
      const common = { priceLineVisible: false, lastValueVisible: !overlay, crosshairMarkerVisible: false, title: '' };
      let api;
      if (plot.style === 'histogram') api = TS.chart.addSeries(LC.HistogramSeries, { ...common, color: plot.color }, paneIndex);
      else if (plot.style === 'circles') api = TS.chart.addSeries(LC.LineSeries, { ...common, color: plot.color, lineVisible: false, pointMarkersVisible: true, pointMarkersRadius: 1.5 }, paneIndex);
      else api = TS.chart.addSeries(LC.LineSeries, { ...common, color: plot.color, lineWidth: Math.min(4, Math.max(1, plot.linewidth)) }, paneIndex);
      api.setData(lineData(plot));
      ST.series.push({ plot, api });
    }
    const host = ST.series[0] ? ST.series[0].api : overlay ? TS.candleSeries : null;
    if (host) {
      for (const h of r.hlines) {
        const line = host.createPriceLine({ price: h.price, color: h.color, lineWidth: 1, lineStyle: h.style === 'solid' ? LC.LineStyle.Solid : h.style === 'dotted' ? LC.LineStyle.Dotted : LC.LineStyle.Dashed, axisLabelVisible: false, title: h.title || '' });
        ST.priceLines.push({ series: host, line });
      }
    }
    if (!overlay && ST.series.length) {
      const panes = TS.chart.panes();
      if (panes[paneIndex]) {
        const wrapper = $('chart-wrapper');
        wrapper.style.height = `${wrapper.clientHeight + PANE_HEIGHT}px`;
        TS.chart.applyOptions({ height: wrapper.clientHeight });
        ST.addedHeight = PANE_HEIGHT;
        panes[paneIndex].setHeight(PANE_HEIGHT);
      }
    }
    const marks = [...r.shapes, ...(r.strategy ? r.strategy.markers : [])]
      .map((m) => ({ time: m.time, position: m.position, color: m.color, shape: m.shape, text: m.text ? String(m.text).slice(0, 12) : '' }))
      .sort((a, b) => a.time - b.time);
    if (!ST.markers) ST.markers = LC.createSeriesMarkers(TS.candleSeries, []);
    ST.markers.setMarkers(marks);
  }

  function redraw() {
    detach();
    attach();
    TS.renderLegend();
  }

  // New candles (incremental refresh, another symbol or timeframe): run again.
  function onCandles() {
    if (!ST.visible || !ST.source || !$('pine-on-chart').checked) return;
    const r = ST.result;
    try {
      const next = Pine.run(ST.source, TS.candles || [], { inputs: ST.inputs[inputKey()] || {}, symbol: TS.activeSymbol || '', timeframe: TS.activeTf || '' });
      ST.result = next;
      const samePlots = r && next.plots.length === ST.series.length && next.plots.every((p, k) => p.style === ST.series[k].plot.style) && next.meta.overlay === r.meta.overlay && ST.series.length;
      if (samePlots) {
        next.plots.forEach((p, k) => {
          ST.series[k].plot = p;
          ST.series[k].api.setData(lineData(p));
        });
        const marks = [...next.shapes, ...(next.strategy ? next.strategy.markers : [])].map((m) => ({ ...m, text: m.text ? String(m.text).slice(0, 12) : '' })).sort((a, b) => a.time - b.time);
        if (ST.markers) ST.markers.setMarkers(marks);
      } else redraw();
      renderStrategy();
    } catch (e) {
      detach();
      out(`<div class="form-error">${esc(e.message)}</div>`);
    }
  }

  function legend(param) {
    if (!ST.series.length) return '';
    const vals = ST.series
      .map(({ plot, api }) => {
        let v = param && param.time ? param.seriesData.get(api) : null;
        if (!v) {
          const d = api.data();
          v = d[d.length - 1];
        }
        return v && Number.isFinite(v.value) ? `<b style="color:${esc(plot.color)}" title="${esc(plot.title)}">${fmtPrice(v.value)}</b>` : '';
      })
      .join(' ');
    return `<span class="lg-study">${esc((ST.result && (ST.result.meta.shorttitle || ST.result.meta.title)) || 'Pine')} ${vals}</span>`;
  }

  TS.pine = { detach, attach, onCandles, legend, open: () => show(true) };

  // ---- panel -----------------------------------------------------------------------------------------
  function setTab(tab) {
    ST.tab = tab;
    for (const t of ['output', 'inputs', 'strategy']) $(`pine-${t}`).classList.toggle('hidden', t !== tab);
    document.querySelectorAll('#pine-tabs [data-pine-tab]').forEach((b) => {
      b.classList.toggle('active', b.dataset.pineTab === tab);
      b.setAttribute('aria-pressed', String(b.dataset.pineTab === tab));
    });
  }
  $('pine-tabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-pine-tab]');
    if (b) setTab(b.dataset.pineTab);
  });

  async function show(on) {
    ST.visible = on;
    $('pine-panel').classList.toggle('hidden', !on);
    $('btn-pine').classList.toggle('active', on);
    $('btn-pine').setAttribute('aria-expanded', String(on));
    TS.util.storage.set('pineOpen', on);
    if (!on) {
      detach();
      TS.renderLegend();
      return;
    }
    ensureEditor();
    if (!ST.scripts.length) {
      await loadScripts();
      const saved = TS.util.storage.get(LS_KEY, null);
      const pick = (saved && ST.scripts.find((s) => s.id === saved.id)) || ST.scripts[0];
      if (pick) await openScript(pick.id);
      else setSource(NEW_SCRIPT);
    } else {
      setTimeout(() => ST.editor.refresh(), 0);
      if (ST.source) redraw();
    }
  }

  $('btn-pine').addEventListener('click', () => show(!ST.visible));
  $('pine-close').addEventListener('click', () => show(false));
  $('pine-run').addEventListener('click', () => runScript());
  $('pine-save').addEventListener('click', () => save());
  $('pine-save-as').addEventListener('click', () => save({ asNew: true }));
  $('pine-on-chart').addEventListener('change', (e) => (e.target.checked ? runScript({ quiet: true }) : (detach(), TS.renderLegend())));
  $('pine-select').addEventListener('change', async (e) => {
    if (!(await confirmLeave())) return renderSelect();
    if (e.target.value) openScript(Number(e.target.value));
  });
  $('pine-new').addEventListener('click', async () => {
    if (!(await confirmLeave())) return;
    ST.current = null;
    setSource(NEW_SCRIPT);
    ST.dirty = true;
    stateLabel();
    renderSelect('');
    runScript({ quiet: true });
  });
  $('pine-delete').addEventListener('click', async () => {
    if (!ST.current) return;
    const ok = await TS.confirmAction({ title: `Delete “${esc(ST.current.name)}”?`, text: 'The script is removed from the server.', ok: 'Delete', danger: true });
    if (!ok) return;
    try {
      await TS.apiSend('DELETE', `api/pine/scripts/${ST.current.id}`);
      ST.current = null;
      ST.dirty = true;
      await loadScripts('');
      stateLabel();
    } catch (e) {
      showToast('Pine: not deleted', esc(e.message), 'error');
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'p' && e.key !== 'P') return;
    if (e.ctrlKey || e.metaKey || e.altKey || TS.activeTab !== 'chart') return;
    if (e.target.closest('input, textarea, select, [contenteditable], .CodeMirror') || document.querySelector('.modal-backdrop:not(.hidden)')) return;
    e.preventDefault();
    show(!ST.visible);
  });

  // ---- conversion to Freqtrade --------------------------------------------------------------------
  const className = (title) => {
    const words = String(title).replace(/[^A-Za-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
    let name = words.map((w) => w[0].toUpperCase() + w.slice(1)).join('') || 'My';
    if (/^\d/.test(name)) name = `P${name}`;
    return `${name.slice(0, 50)}Pine`;
  };

  function convert() {
    const f = $('pine-export-form');
    $('pine-export-error').classList.add('hidden');
    try {
      const r = Pine.toFreqtrade(ensureEditor().getValue(), { className: f.pyclass.value.trim(), timeframe: f.timeframe.value });
      ST.converted = r;
      $('pine-export-code').textContent = r.source;
      $('pine-export-warnings').innerHTML = r.warnings.map((w) => `<div class="warn small">⚠ ${esc(w)}</div>`).join('');
      f.querySelector('[type=submit]').disabled = false;
    } catch (e) {
      ST.converted = null;
      $('pine-export-code').textContent = '';
      $('pine-export-warnings').innerHTML = '';
      $('pine-export-error').textContent = e.message;
      $('pine-export-error').classList.remove('hidden');
      f.querySelector('[type=submit]').disabled = true;
    }
  }

  $('pine-export').addEventListener('click', () => {
    const f = $('pine-export-form');
    f.pyclass.value = className(titleOf(ensureEditor().getValue()));
    f.timeframe.innerHTML = ['1m', '5m', '15m', '1h', '4h', '1d'].map((t) => `<option ${t === TS.activeTf ? 'selected' : ''}>${t}</option>`).join('');
    $('pine-export-actions').innerHTML = '<button type="button" class="btn-secondary" data-close-modal>Cancel</button><button type="submit" class="btn-buy"><i class="fa-solid fa-floppy-disk" aria-hidden="true"></i> Save to the library and check</button>';
    $('pine-export-modal').classList.remove('hidden');
    convert();
  });
  $('pine-export-refresh').addEventListener('click', convert);
  $('pine-export-form').pyclass.addEventListener('change', convert);
  $('pine-export-form').timeframe.addEventListener('change', convert);
  $('pine-export-modal').addEventListener('click', (e) => {
    if (e.target.id === 'pine-export-modal' || e.target.closest('[data-close-modal]')) $('pine-export-modal').classList.add('hidden');
    const go = e.target.closest('[data-go]');
    if (!go) return;
    const name = ST.converted.className;
    $('pine-export-modal').classList.add('hidden');
    TS.showTab('strategies');
    if (go.dataset.go === 'editor') TS.strategies.editStrategy(name);
    if (go.dataset.go === 'backtest') {
      TS.strategies.setPane('backtests');
      TS.strategies.prefillBacktest(name);
    }
  });
  $('pine-export-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const r = ST.converted;
    if (!r) return;
    const btn = e.target.querySelector('[type=submit]');
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i> Saving and checking…';
    try {
      const lib = await TS.api('api/strategies');
      if (lib.library.some((s) => s.name === r.className)) {
        const ok = await TS.confirmAction({ title: `Replace ${esc(r.className)}?`, text: 'The library already has a strategy with this name; the conversion becomes its new version.', ok: 'Replace' });
        if (!ok) {
          btn.disabled = false;
          btn.textContent = 'Save to the library and check';
          return;
        }
      }
      await TS.apiSend('PUT', `api/strategies/${encodeURIComponent(r.className)}`, { source: r.source, origin: 'pine' });
      const check = (await TS.apiSend('POST', `api/strategies/${encodeURIComponent(r.className)}/check`)).result;
      $('pine-export-warnings').innerHTML = `<div class="${check.ok ? 'pine-ok' : 'form-error'}">${check.ok ? '<i class="fa-solid fa-circle-check" aria-hidden="true"></i> ' : ''}${esc(r.className)} is in the library. Check: ${esc(check.message)}</div>${(check.warnings || []).map((w) => `<div class="warn small">⚠ ${esc(w)}</div>`).join('')}`;
      $('pine-export-actions').innerHTML = `<button type="button" class="btn-secondary" data-close-modal>Close</button><button type="button" class="btn-secondary" data-go="editor"><i class="fa-solid fa-code" aria-hidden="true"></i> Open in the strategy editor</button><button type="button" class="btn-buy" data-go="backtest"><i class="fa-solid fa-flask" aria-hidden="true"></i> Backtest it</button>`;
    } catch (err) {
      $('pine-export-error').textContent = err.message;
      $('pine-export-error').classList.remove('hidden');
      btn.disabled = false;
      btn.textContent = 'Save to the library and check';
    }
  });

  // ---- start ------------------------------------------------------------------------------------------
  ST.inputs = TS.util.storage.get('pineInputs', {}) || {};
  TS.commands = TS.commands || [];
  TS.commands.push({ label: 'Pine editor', icon: 'fa-code', keywords: 'pine script tradingview indicator strategy', run: () => (TS.showTab('chart'), show(true)) });
  window.addEventListener('beforeunload', (e) => {
    if (ST.visible && ST.dirty) e.preventDefault();
  });
  if (TS.util.storage.get('pineOpen', false)) {
    // After the first candles are on the chart.
    const wait = setInterval(() => {
      if ((TS.candles || []).length) {
        clearInterval(wait);
        show(true);
      }
    }, 500);
    setTimeout(() => clearInterval(wait), 20000);
  }
})();
