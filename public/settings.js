// Settings tab: general/risk settings, data providers, instruments and integrations.

(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (v) => escapeHtml(v);
  const CATEGORIES = ['CEX', 'CEX_FUTURES', 'DEX', 'TRADFI'];
  let kinds = {};
  let providers = [];
  let allInstruments = [];
  let pane = 'general';

  // ---- generic editor modal ---------------------------------------------------------
  // fields: [{ name, label, type: text|number|select|checkbox|textarea, options, value, hint, full, placeholder }]
  let editorSubmit = null;
  let editorDelete = null;

  function openEditor({ title, fields, onSubmit, onDelete, onChange }) {
    $('edit-modal-title').textContent = title;
    $('edit-error').classList.add('hidden');
    $('edit-fields').innerHTML = fields.map(fieldHtml).join('');
    editorSubmit = onSubmit;
    editorDelete = onDelete || null;
    $('edit-delete').hidden = !onDelete;
    $('edit-modal').classList.remove('hidden');
    if (onChange) {
      $('edit-fields').querySelectorAll('[name]').forEach((el) => el.addEventListener('change', () => onChange(readEditor())));
    }
    const first = $('edit-fields').querySelector('input:not([type=checkbox]), select, textarea');
    if (first) first.focus();
  }

  function fieldHtml(f) {
    const id = `edit-${f.name}`;
    const hint = f.hint ? `<span class="hint">${f.hint}</span>` : '';
    const cls = f.full ? ' class="full"' : '';
    if (f.type === 'checkbox') {
      return `<label class="check${f.full ? ' full' : ''}"><input type="checkbox" id="${id}" name="${f.name}" ${f.value ? 'checked' : ''}> ${esc(f.label)}</label>`;
    }
    if (f.type === 'select') {
      const opts = f.options.map((o) => {
        const [value, label] = Array.isArray(o) ? o : [o, o];
        return `<option value="${esc(value)}" ${String(value) === String(f.value ?? '') ? 'selected' : ''}>${esc(label)}</option>`;
      });
      return `<label${cls}>${esc(f.label)}<select id="${id}" name="${f.name}" ${f.disabled ? 'disabled' : ''}>${opts.join('')}</select>${hint}</label>`;
    }
    if (f.type === 'textarea') {
      return `<label${cls}>${esc(f.label)}<textarea id="${id}" name="${f.name}" rows="${f.rows || 8}" spellcheck="false">${esc(f.value ?? '')}</textarea>${hint}</label>`;
    }
    return `<label${cls}>${esc(f.label)}<input id="${id}" name="${f.name}" type="${f.type || 'text'}" value="${esc(f.value ?? '')}" placeholder="${esc(f.placeholder || '')}" ${f.disabled ? 'disabled' : ''} ${f.step ? `step="${f.step}"` : ''} autocomplete="off">${hint}</label>`;
  }

  function readEditor() {
    const out = {};
    $('edit-fields').querySelectorAll('[name]').forEach((el) => {
      out[el.name] = el.type === 'checkbox' ? el.checked : el.value;
    });
    return out;
  }

  function closeEditor() {
    $('edit-modal').classList.add('hidden');
    editorSubmit = null;
    editorDelete = null;
  }

  function editorError(msg) {
    const box = $('edit-error');
    box.textContent = msg;
    box.classList.remove('hidden');
  }

  $('edit-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!editorSubmit) return;
    try {
      await editorSubmit(readEditor());
      closeEditor();
    } catch (err) {
      editorError(err.message);
    }
  });
  $('edit-cancel').addEventListener('click', closeEditor);
  $('edit-delete').addEventListener('click', async () => {
    if (!editorDelete) return;
    try {
      await editorDelete();
      closeEditor();
    } catch (err) {
      editorError(err.message);
    }
  });
  $('edit-modal').addEventListener('click', (e) => {
    if (e.target.id === 'edit-modal') closeEditor();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('edit-modal').classList.contains('hidden')) closeEditor();
  });

  // ---- panes ---------------------------------------------------------------------------
  const PANES = ['general', 'providers', 'instruments', 'integrations'];
  function showPane(name) {
    if (!PANES.includes(name)) name = 'general';
    pane = name;
    TS.settingsPane = name;
    if (TS.syncUrl) TS.syncUrl(false);
    document.querySelectorAll('#settings-nav [data-settings]').forEach((b) => {
      b.classList.toggle('active', b.dataset.settings === name);
      b.setAttribute('aria-pressed', String(b.dataset.settings === name));
    });
    document.querySelectorAll('.settings-pane').forEach((el) => el.classList.toggle('hidden', el.id !== `settings-${name}`));
    if (name === 'general') loadGeneral();
    if (name === 'providers') loadProviders();
    if (name === 'instruments') loadInstruments();
    if (name === 'integrations') loadIntegrations();
  }
  $('settings-nav').addEventListener('click', (e) => {
    const b = e.target.closest('[data-settings]');
    if (b) showPane(b.dataset.settings);
  });
  document.addEventListener('ts:tab', (e) => {
    if (e.detail === 'settings') showPane(pane);
  });
  // Deep links (#settings/<pane>) set the pane before the tab opens.
  TS.setSettingsPane = (name) => {
    if (PANES.includes(name)) pane = name;
  };

  // ---- general & risk -------------------------------------------------------------------
  async function loadGeneral() {
    const form = $('settings-form');
    try {
      const d = await TS.api('api/trading/settings');
      TS.settings = d.settings;
      $('settings-persisted').textContent = d.persisted ? 'Saved in trade_db' : 'Not persisted (apply migration 003)';
      $('settings-default-symbol').innerHTML = TS.pairs.map((p) => `<option>${esc(p.symbol)}</option>`).join('');
      $('settings-default-tf').innerHTML = ['1m', '5m', '15m', '1h', '4h', '1d'].map((t) => `<option>${t}</option>`).join('');
      for (const [k, v] of Object.entries(d.settings)) {
        const el = form.elements[k];
        if (!el) continue;
        if (el.type === 'checkbox') el.checked = !!v;
        else el.value = v;
      }
    } catch (e) {
      showToast('Settings', esc(e.message), 'error');
    }
  }

  $('settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const body = {};
    for (const el of form.elements) {
      if (!el.name) continue;
      body[el.name] = el.type === 'checkbox' ? el.checked : el.value;
    }
    try {
      const d = await TS.apiSend('POST', 'api/trading/settings', body);
      TS.settings = d.settings;
      showToast('Settings saved', 'Stored in trade_db.', 'success');
      if (TS.showMarkers !== d.settings.showTradeMarkers) {
        TS.showMarkers = d.settings.showTradeMarkers;
        $('btn-markers').classList.toggle('active', TS.showMarkers);
      }
    } catch (err) {
      showToast('Settings not saved', esc(err.message), 'error');
    }
  });

  // ---- providers ------------------------------------------------------------------------
  async function ensureKinds() {
    if (Object.keys(kinds).length) return;
    kinds = (await TS.api('api/providers/kinds')).kinds;
  }

  async function loadProviders() {
    const tbody = $('providers-tbody');
    try {
      await ensureKinds();
      const d = await TS.api('api/providers');
      providers = d.providers;
      if (d.notInstalled) {
        tbody.innerHTML = '<tr><td colspan="7" class="empty">market_providers table missing: apply db/migrations/003_market_providers.sql</td></tr>';
        return;
      }
      tbody.innerHTML = providers.length
        ? providers
            .map((p) => `
              <tr>
                <td><strong>${esc(p.name)}</strong></td>
                <td>${esc((kinds[p.kind] && kinds[p.kind].label) || p.kind)}</td>
                <td class="mono small">${esc(p.base_url || '-')}</td>
                <td class="r">${p.instrument_count}</td>
                <td title="${esc(p.last_test_msg || '')}">${p.last_test_at ? `<span class="pill ${p.last_test_ok ? 'pill-green' : 'pill-red'}">${p.last_test_ok ? 'OK' : 'FAIL'}</span> <span class="muted small">${TS.fmt.ago(p.last_test_at)}</span>` : '<span class="muted">never</span>'}</td>
                <td>${p.enabled ? '<span class="pill pill-green">on</span>' : '<span class="pill pill-gray">off</span>'}</td>
                <td class="r">
                  <button class="icon-btn" data-test="${p.id}"><i class="fa-solid fa-vial"></i> Test</button>
                  <button class="icon-btn" data-edit-provider="${p.id}"><i class="fa-solid fa-pen"></i> Edit</button>
                </td>
              </tr>`)
            .join('')
        : '<tr><td colspan="7" class="empty">No providers.</td></tr>';
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="7" class="empty">${esc(e.message)}</td></tr>`;
    }
  }

  function providerFields(p, kindKey) {
    const kind = kinds[kindKey];
    const cfg = p.config || (kind.defaults && kind.defaults.config) || {};
    const fields = [
      { name: 'name', label: 'Name', value: p.name || '' },
      { name: 'kind', label: 'Kind', type: 'select', value: kindKey, options: Object.entries(kinds).map(([k, v]) => [k, v.label]), disabled: !!p.id },
      {
        name: 'base_url', label: 'Base URL', full: true, value: p.base_url || (kind.defaults && kind.defaults.base_url) || '',
        disabled: kindKey === 'freqtrade', hint: kindKey === 'freqtrade' ? 'Fixed: the local Freqtrade API with the credentials in freqtrade.env.' : 'https only, public hosts only.',
      },
    ];
    for (const c of kind.config || []) {
      if (c.json) {
        fields.push({
          name: 'config_json', label: c.label, type: 'textarea', full: true, rows: 12, value: JSON.stringify(cfg, null, 2),
          hint: 'Placeholders: {symbol} {base} {quote} {contract} {network} {interval} {limit}. rows_path is a dot path to the candle array; fields map time/open/high/low/close/volume to an index or key. Optional: intervals, symbol_format, ticker_url, ticker_path, ticker_fields, headers ({credential}), test_symbol.',
        });
      } else {
        fields.push({ name: `config.${c.key}`, label: c.label, type: 'select', options: c.options, value: cfg[c.key] ?? c.options[0] });
      }
    }
    if (kind.credentials) {
      fields.push({ name: 'credential_env', label: 'Credential variable (optional)', value: p.credential_env || '', placeholder: 'MYPROVIDER_API_KEY', hint: 'Name only; the value goes in ~/.openclaw/credentials/market-providers.env.' });
    }
    fields.push({ name: 'enabled', label: 'Enabled', type: 'checkbox', value: p.enabled !== false, full: true });
    fields.push({ name: '_hint', label: 'Instrument symbol format', value: kind.symbolHint || '', disabled: true, full: true, hint: 'Set per instrument as "provider symbol" when it differs from BASE/QUOTE.' });
    return fields;
  }

  function providerBody(v) {
    const body = { name: v.name, base_url: v.base_url, enabled: v.enabled, credential_env: v.credential_env };
    if (v.kind) body.kind = v.kind;
    const cfg = {};
    for (const [k, val] of Object.entries(v)) if (k.startsWith('config.')) cfg[k.slice(7)] = val;
    if (v.config_json !== undefined) {
      try {
        Object.assign(cfg, JSON.parse(v.config_json || '{}'));
      } catch (e) {
        throw new Error('Config is not valid JSON');
      }
    }
    body.config = cfg;
    return body;
  }

  function editProvider(p) {
    const isNew = !p.id;
    let kindKey = p.kind || 'binance';
    const open = () =>
      openEditor({
        title: isNew ? 'Add data provider' : `Edit ${p.name}`,
        fields: providerFields(p, kindKey),
        onChange: (v) => {
          if (isNew && v.kind && v.kind !== kindKey) {
            kindKey = v.kind;
            p = { ...p, name: v.name, base_url: kinds[kindKey].defaults.base_url, config: kinds[kindKey].defaults.config };
            open();
          }
        },
        onSubmit: async (v) => {
          const body = providerBody({ ...v, kind: isNew ? kindKey : undefined });
          const d = isNew ? await TS.apiSend('POST', 'api/providers', body) : await TS.apiSend('PUT', `api/providers/${p.id}`, body);
          showToast(isNew ? 'Provider added' : 'Provider saved', `${esc(d.provider.name)}. Testing…`, 'success');
          await testProvider(d.provider.id);
          loadProviders();
          TS.reloadPairs();
        },
        onDelete: isNew
          ? null
          : async () => {
              if (!confirm(`Delete ${p.name}? Its ${p.instrument_count} instrument(s) will have no provider.`)) throw new Error('Cancelled');
              const d = await TS.apiSend('DELETE', `api/providers/${p.id}`);
              showToast('Provider deleted', esc(d.message), 'success');
              loadProviders();
              TS.reloadPairs();
            },
      });
    open();
  }

  async function testProvider(id) {
    try {
      const d = await TS.apiSend('POST', `api/providers/${id}/test`);
      showToast(d.ok ? 'Provider test passed' : 'Provider test failed', esc(d.message), d.ok ? 'success' : 'error');
    } catch (e) {
      showToast('Provider test', esc(e.message), 'error');
    }
    if (pane === 'providers') loadProviders();
  }

  $('btn-add-provider').addEventListener('click', async () => {
    await ensureKinds();
    editProvider({ kind: 'binance' });
  });
  $('providers-tbody').addEventListener('click', (e) => {
    const t = e.target.closest('[data-test]');
    if (t) return testProvider(t.dataset.test);
    const ed = e.target.closest('[data-edit-provider]');
    if (ed) editProvider(providers.find((p) => String(p.id) === ed.dataset.editProvider));
  });

  // ---- instruments -------------------------------------------------------------------
  async function loadInstruments() {
    const tbody = $('instruments-tbody');
    try {
      await ensureKinds();
      const [pairs, provs] = await Promise.all([TS.api('api/trading/pairs?all=1'), TS.api('api/providers')]);
      allInstruments = pairs.pairs;
      providers = provs.providers;
      renderInstruments();
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="7" class="empty">${esc(e.message)}</td></tr>`;
    }
  }

  function renderInstruments() {
    const q = $('instruments-search').value.trim().toLowerCase();
    const showInactive = $('instruments-show-inactive').checked;
    const rows = allInstruments.filter(
      (i) => (showInactive || i.is_active !== false) && (!q || [i.symbol, i.category, i.exchange, i.provider_name].some((v) => String(v || '').toLowerCase().includes(q)))
    );
    $('instruments-tbody').innerHTML = rows.length
      ? rows
          .map((i) => `
            <tr>
              <td><strong>${esc(i.symbol)}</strong></td>
              <td>${esc(i.category)}</td>
              <td>${i.provider_name ? esc(i.provider_name) : '<span class="neg">none</span>'}</td>
              <td class="mono small">${esc(i.provider_symbol || '-')}</td>
              <td class="mono small" title="${esc(i.contract_address || '')}">${i.contract_address ? esc(i.contract_address.slice(0, 10)) + '…' : '-'}${i.network ? ` · ${esc(i.network)}` : ''}</td>
              <td>${i.is_active === false ? '<span class="pill pill-gray">inactive</span>' : '<span class="pill pill-green">active</span>'}</td>
              <td class="r"><button class="icon-btn" data-edit-instrument="${esc(i.symbol)}"><i class="fa-solid fa-pen"></i> Edit</button></td>
            </tr>`)
          .join('')
      : '<tr><td colspan="7" class="empty">No instruments match.</td></tr>';
  }

  function providerOptions() {
    return [['', '— none —'], ...providers.map((p) => [p.id, `${p.name}${p.enabled ? '' : ' (disabled)'}`])];
  }

  function editInstrument(i) {
    const isNew = !i.symbol;
    const hintFor = (pid) => {
      const p = providers.find((x) => String(x.id) === String(pid));
      return p && kinds[p.kind] ? `Format for ${esc(p.name)}: ${esc(kinds[p.kind].symbolHint)}. Leave empty to use BASE+QUOTE.` : 'Leave empty to use BASE+QUOTE.';
    };
    openEditor({
      title: isNew ? 'Add instrument' : `Edit ${i.symbol}`,
      fields: [
        { name: 'symbol', label: 'Symbol', value: i.symbol || '', placeholder: 'ETH/USDT or SPY', disabled: !isNew },
        { name: 'category', label: 'Category', type: 'select', options: CATEGORIES, value: i.category || 'CEX' },
        { name: 'provider_id', label: 'Data provider', type: 'select', options: providerOptions(), value: i.provider_id || '' },
        { name: 'provider_symbol', label: 'Provider symbol (optional)', value: i.provider_symbol || '', hint: hintFor(i.provider_id) },
        { name: 'exchange', label: 'Exchange / venue', value: i.exchange || '' },
        { name: 'name', label: 'Display name', value: i.name || '' },
        { name: 'contract_address', label: 'Contract address (DEX)', value: i.contract_address || '', full: true, hint: 'GeckoTerminal finds the most liquid pool for this token; pin one with provider symbol "network:pool_address".' },
        { name: 'network', label: 'Network (DEX, optional)', value: i.network || '', placeholder: 'eth, base, arbitrum, solana…' },
        { name: 'is_active', label: 'Active (shown in lists and refreshed)', type: 'checkbox', value: i.is_active !== false },
      ],
      onChange: (v) => {
        const hint = $('edit-provider_symbol') && $('edit-provider_symbol').parentElement.querySelector('.hint');
        if (hint) hint.innerHTML = hintFor(v.provider_id);
      },
      onSubmit: async (v) => {
        const body = { ...v, provider_id: v.provider_id || null };
        if (isNew) {
          await TS.apiSend('POST', 'api/trading/pairs', body);
          showToast('Instrument added', esc(body.symbol.toUpperCase()), 'success');
        } else {
          delete body.symbol;
          await TS.apiSend('PUT', `api/trading/pairs/${encodeURIComponent(i.symbol)}`, body);
          showToast('Instrument saved', esc(i.symbol), 'success');
        }
        await loadInstruments();
        await TS.reloadPairs();
        const sym = isNew ? v.symbol.toUpperCase() : i.symbol;
        if (TS.activeSymbol === sym) {
          TS.candles = [];
          TS.selectPair(sym);
        }
      },
    });
  }

  $('btn-add-instrument').addEventListener('click', async () => {
    await ensureKinds();
    if (!providers.length) providers = (await TS.api('api/providers')).providers;
    editInstrument({});
  });
  $('instruments-tbody').addEventListener('click', (e) => {
    const b = e.target.closest('[data-edit-instrument]');
    if (b) editInstrument(allInstruments.find((i) => i.symbol === b.dataset.editInstrument));
  });
  $('instruments-search').addEventListener('input', renderInstruments);
  $('instruments-show-inactive').addEventListener('change', renderInstruments);

  // ---- integrations ------------------------------------------------------------------
  async function loadIntegrations() {
    const box = $('integrations-box');
    box.innerHTML = '<div class="muted">Checking…</div>';
    try {
      const d = await TS.api('api/integrations');
      const row = (ok, name, detail, extra) =>
        `<div class="int-row"><span class="dot ${ok === true ? 'ok' : ok === false ? 'bad' : ''}"></span><strong>${esc(name)}</strong><span class="detail" title="${esc(detail || '')}">${esc(detail || '-')}</span><span class="muted small">${extra || ''}</span></div>`;
      const t = d.tickerRefresh || {};
      const errs = Object.entries(t.errors || {});
      box.innerHTML = [
        '<div class="card-title small">Services</div>',
        ...d.services.map((s) => row(s.ok, s.name, s.detail, `${s.ms} ms`)),
        '<div class="card-title small">Data providers</div>',
        ...d.providers.map((p) => {
          const c = p.circuit || {};
          const paused = p.enabled && c.state && c.state !== 'closed';
          const detail = !p.enabled ? 'disabled' : paused ? `paused after ${c.failures} failures (${c.lastError || 'errors'})${c.retryInS ? `, retry in ${c.retryInS} s` : ''}` : p.detail || 'not tested yet';
          const limit = c.ratePerMin ? ` · ${c.ratePerMin}/min` : '';
          return row(!p.enabled ? null : paused ? false : p.ok, p.name, detail, `${p.instruments} instr.${limit}${p.tested_at ? ' · ' + TS.fmt.ago(p.tested_at) : ''}`);
        }),
        '<div class="card-title small">Price refresh</div>',
        row(t.lastRunAt ? t.failed === 0 : null, 'Ticker refresh', t.lastRunAt ? `${t.updated} updated, ${t.failed} failed` : 'not run yet', t.lastRunAt ? TS.fmt.ago(t.lastRunAt) : ''),
        ...errs.slice(0, 10).map(([sym, msg]) => row(false, sym, msg, '')),
        '<div class="toolbar-row"><button class="pill pill-blue" id="btn-test-all"><i class="fa-solid fa-vial"></i> Test all providers</button></div>',
      ].join('');
      $('btn-test-all').addEventListener('click', async () => {
        for (const p of d.providers.filter((x) => x.enabled)) {
          await TS.apiSend('POST', `api/providers/${p.id}/test`).catch(() => {});
        }
        loadIntegrations();
      });
    } catch (e) {
      box.innerHTML = `<div class="neg">${esc(e.message)}</div>`;
    }
  }
  $('btn-refresh-integrations').addEventListener('click', loadIntegrations);
})();
