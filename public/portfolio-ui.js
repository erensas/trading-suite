// Portfolio tab: totals and history, accounts (manual holdings, Alpaca paper, Freqtrade bots,
// wallets), assets across accounts, and EVM wallets (create, import, watch). Values come from
// the last refresh stored on the server; Refresh values asks every source again.
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (v) => escapeHtml(v);
  const { fmtUsd, fmtPrice, ago } = TS.fmt;
  const { markFresh, markError, retry } = TS.fresh;
  const ST = { data: null, chart: null, series: null, loadedOnce: false };
  const KIND_LABEL = { manual: 'Manual', alpaca: 'Alpaca paper', freqtrade: 'Freqtrade bot', wallet: 'Wallet' };
  const ORIGIN_LABEL = { generated: 'created here', private_key: 'imported key', mnemonic: 'imported phrase', watch: 'watch only' };
  const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '-');
  const qty = (v) => fmtPrice(v);

  // ---- rendering --------------------------------------------------------------------------
  function renderTotals(d) {
    const t = d.totals;
    $('pf-totals').innerHTML = `
      <div class="kv"><div class="k">Total</div><div class="v">${fmtUsd(t.total_usd)}</div></div>
      <div class="kv"><div class="k">Real</div><div class="v">${fmtUsd(t.real_usd)}</div></div>
      <div class="kv"><div class="k">Paper</div><div class="v">${fmtUsd(t.paper_usd)}</div></div>
      <div class="kv"><div class="k">Accounts</div><div class="v">${t.accounts}</div></div>`;
    $('pf-refreshed').textContent = d.last_refresh_at ? `values from ${ago(d.last_refresh_at)}` : 'not valued yet';
  }

  function renderChart(history) {
    const el = $('pf-chart');
    el.classList.toggle('hidden', history.length < 2);
    if (history.length < 2 || !window.LightweightCharts) return;
    const LC = window.LightweightCharts;
    if (!ST.chart) {
      ST.chart = LC.createChart(el, {
        width: el.clientWidth, height: el.clientHeight || 180,
        layout: { background: { type: 'solid', color: 'transparent' }, textColor: '#94a3b8', fontSize: 11 },
        grid: { vertLines: { visible: false }, horzLines: { color: '#111c33' } },
        rightPriceScale: { borderColor: '#1e293b' },
        timeScale: { borderColor: '#1e293b', timeVisible: true },
        localization: { priceFormatter: (v) => fmtUsd(v, 0) },
        handleScroll: false, handleScale: false,
      });
      ST.series = ST.chart.addSeries(LC.AreaSeries, { lineColor: '#38bdf8', topColor: 'rgba(56, 189, 248, 0.25)', bottomColor: 'rgba(56, 189, 248, 0.02)', lineWidth: 2 });
      ST.paper = ST.chart.addSeries(LC.LineSeries, { color: '#a78bfa', lineWidth: 1, lineStyle: 2, lastValueVisible: false, priceLineVisible: false });
      new ResizeObserver(() => ST.chart.applyOptions({ width: el.clientWidth })).observe(el);
    }
    const pts = (key) => {
      const seen = new Set();
      return history
        .map((h) => ({ time: Math.floor(new Date(h.at).getTime() / 1000), value: h[key] }))
        .filter((p) => !seen.has(p.time) && seen.add(p.time));
    };
    ST.series.setData(pts('total_usd'));
    ST.paper.setData(pts('paper_usd'));
    ST.chart.timeScale().fitContent();
  }

  function sourceText(a) {
    if (a.kind === 'wallet') {
      const w = (ST.data.wallets || []).find((x) => String(x.id) === String(a.ref));
      return w ? `${esc(w.name)} <code>${esc(short(w.address))}</code>` : '<span class="muted">wallet removed</span>';
    }
    if (a.kind === 'alpaca') return `venue #${esc(a.ref)}`;
    if (a.kind === 'freqtrade') return `bot <code>${esc(a.ref)}</code>`;
    return '<span class="muted">entered by hand</span>';
  }

  function renderAccounts(d) {
    $('pf-accounts-tbody').innerHTML = d.accounts.length
      ? d.accounts
          .map(
            (a) => `<tr data-account="${a.id}" class="${a.enabled ? '' : 'muted'}">
          <td><b>${esc(a.name)}</b>${a.notes ? `<div class="muted small">${esc(a.notes)}</div>` : ''}</td>
          <td class="small">${esc(KIND_LABEL[a.kind] || a.kind)}<div class="muted">${sourceText(a)}</div></td>
          <td>${a.mode === 'paper' ? '<span class="pill pill-purple">paper</span>' : '<span class="pill pill-green">real</span>'}</td>
          <td class="r">${fmtUsd(a.last_value_usd)}</td>
          <td class="r">${a.share_pct === null ? '-' : `${a.share_pct}%`}</td>
          <td class="small">${a.last_refresh_at ? esc(ago(a.last_refresh_at)) : '<span class="muted">never</span>'}${a.last_error ? `<div class="neg" title="${esc(a.last_error)}">⚠ ${esc(a.last_error.slice(0, 80))}</div>` : ''}</td>
          <td><input type="checkbox" data-pf-toggle ${a.enabled ? 'checked' : ''} aria-label="Enabled"></td>
          <td class="nowrap r">
            ${a.kind === 'manual' ? '<button type="button" class="icon-btn" data-pf-holdings title="Holdings"><i class="fa-solid fa-pen-to-square" aria-hidden="true"></i></button>' : ''}
            <button type="button" class="icon-btn" data-pf-positions title="Positions"><i class="fa-solid fa-list" aria-hidden="true"></i></button>
            <button type="button" class="icon-btn" data-pf-refresh title="Refresh this account"><i class="fa-solid fa-rotate" aria-hidden="true"></i></button>
            <button type="button" class="icon-btn danger" data-pf-delete title="Remove from the portfolio"><i class="fa-solid fa-trash" aria-hidden="true"></i></button>
          </td></tr>`
          )
          .join('')
      : '<tr><td colspan="8" class="muted">No accounts yet. Add manual holdings, an Alpaca paper venue, a Freqtrade bot or a wallet below.</td></tr>';
  }

  function renderAssets(d) {
    $('pf-assets-tbody').innerHTML = d.assets.length
      ? d.assets
          .map(
            (x) => `<tr><td><b>${esc(x.asset)}</b></td><td class="r mono">${qty(x.quantity)}</td>
            <td class="r">${x.priced ? fmtUsd(x.value_usd) : `${fmtUsd(x.value_usd)} <span class="muted" title="Part of it has no USD price">*</span>`}</td>
            <td class="r">${x.share_pct === null ? '-' : `${x.share_pct}%`}</td><td class="small muted">${esc(x.accounts.join(', '))}</td></tr>`
          )
          .join('')
      : '<tr><td colspan="5" class="muted">No positions yet.</td></tr>';
  }

  function walletValue(w) {
    const a = ST.data.accounts.find((x) => x.kind === 'wallet' && String(x.ref) === String(w.id));
    return a ? fmtUsd(a.last_value_usd) : '<span class="muted">not tracked</span>';
  }

  function renderWallets(d) {
    $('wl-tbody').innerHTML = d.wallets.length
      ? d.wallets
          .map(
            (w) => `<tr data-wallet="${w.id}">
          <td><b>${esc(w.name)}</b>${w.notes ? `<div class="muted small">${esc(w.notes)}</div>` : ''}</td>
          <td class="mono small"><span title="${esc(w.address)}">${esc(w.address)}</span> <button type="button" class="icon-btn" data-wl-copy title="Copy the address"><i class="fa-regular fa-copy" aria-hidden="true"></i></button></td>
          <td><span class="pill ${w.origin === 'watch' ? 'pill-gray' : 'pill-blue'}">${esc(ORIGIN_LABEL[w.origin] || w.origin)}</span></td>
          <td class="small">${esc(w.networks.join(', '))}</td>
          <td class="small">${w.origin === 'watch' ? '<span class="muted">none (watch only)</span>' : `${w.key_stored ? '<span class="pos">✓ key</span>' : '<span class="neg">✗ key missing</span>'}${w.phrase_stored ? ' <span class="pos">✓ phrase</span>' : ''}`}</td>
          <td class="r">${walletValue(w)}</td>
          <td class="nowrap r"><button type="button" class="icon-btn" data-wl-edit title="Name and networks"><i class="fa-solid fa-pen" aria-hidden="true"></i></button>
            <button type="button" class="icon-btn danger" data-wl-delete title="Delete"><i class="fa-solid fa-trash" aria-hidden="true"></i></button></td></tr>`
          )
          .join('')
      : '<tr><td colspan="7" class="muted">No wallets yet. Create one, import a key or recovery phrase, or watch an address.</td></tr>';
  }

  async function load() {
    try {
      const d = await TS.api('api/portfolio');
      ST.data = d;
      renderTotals(d);
      renderAccounts(d);
      renderAssets(d);
      renderWallets(d);
      renderChart(d.history);
      markFresh('portfolio', d.last_refresh_at ? new Date(d.last_refresh_at).getTime() : Date.now());
      ST.loadedOnce = true;
      fillRefSelect();
    } catch (e) {
      markError('portfolio', e.message);
      $('pf-accounts-tbody').innerHTML = `<tr><td colspan="8" class="form-error">${esc(e.message)} ${TS.fresh.retryButton('portfolio')}</td></tr>`;
    }
  }
  retry.portfolio = load;

  async function refresh(accountId) {
    const b = $('pf-refresh');
    b.disabled = true;
    b.innerHTML = '<i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i> Refreshing…';
    try {
      const r = await TS.apiSend('POST', 'api/portfolio/refresh', accountId ? { account_id: accountId } : {});
      const failed = r.results.filter((x) => !x.ok);
      if (failed.length) showToast('Some accounts not valued', esc(failed.map((x) => `${x.name}: ${x.error}`).join('; ')), 'error');
    } catch (e) {
      showToast('Refresh failed', esc(e.message), 'error');
    } finally {
      b.disabled = false;
      b.innerHTML = '<i class="fa-solid fa-rotate" aria-hidden="true"></i> Refresh values';
    }
    load();
  }

  // ---- add account ------------------------------------------------------------------------
  async function fillRefSelect() {
    const f = $('pf-account-form');
    const kind = f.kind.value;
    f.mode.disabled = kind !== 'manual';
    f.ref.hidden = kind === 'manual';
    if (kind === 'manual') return;
    f.ref.innerHTML = '<option value="">Loading…</option>';
    try {
      let options = [];
      if (kind === 'wallet') options = (ST.data ? ST.data.wallets : []).map((w) => [w.id, `${w.name} (${short(w.address)})`]);
      if (kind === 'alpaca') options = (await TS.api('api/venues')).venues.filter((v) => v.kind === 'broker').map((v) => [v.id, `${v.name}${v.keys.configured ? '' : ' (no keys)'}`]);
      if (kind === 'freqtrade') options = (await TS.api('api/bots')).bots.filter((b) => b.engine === 'freqtrade').map((b) => [b.name, `${b.name}${b.dry_run === false ? ' (live)' : ' (dry-run)'}`]);
      f.ref.innerHTML = options.length ? options.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('') : '<option value="">none available</option>';
    } catch (e) {
      f.ref.innerHTML = `<option value="">${esc(e.message)}</option>`;
    }
  }

  $('pf-account-form').kind.addEventListener('change', fillRefSelect);
  $('pf-account-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const body = { name: f.name.value, kind: f.kind.value, mode: f.mode.value };
    if (body.kind !== 'manual') {
      if (!f.ref.value) return showToast('Nothing to add', 'pick the venue, bot or wallet first', 'error');
      body.ref = f.ref.value;
    }
    try {
      const a = (await TS.apiSend('POST', 'api/portfolio/accounts', body)).account;
      f.name.value = '';
      showToast(esc(a.name), a.kind === 'manual' ? 'added; enter its holdings with the edit button' : 'added and valued', 'success');
      await load();
      if (a.kind === 'manual') holdingsDialog(a);
    } catch (err) {
      showToast('Account not added', esc(err.message), 'error');
    }
  });

  // ---- dialogs ----------------------------------------------------------------------------
  function modal(html, { wide = false } = {}) {
    const box = document.createElement('div');
    box.className = 'modal-backdrop';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.innerHTML = `<div class="modal-card${wide ? ' wide' : ''}">${html}</div>`;
    document.body.appendChild(box);
    const close = () => box.remove();
    box.addEventListener('keydown', (e) => e.key === 'Escape' && !box.dataset.locked && close());
    return { box, card: box.firstElementChild, close };
  }

  function positionsDialog(a) {
    const rows = (a.last_positions || [])
      .map(
        (p) => `<tr><td><b>${esc(p.asset)}</b>${p.network ? ` <span class="muted small">${esc(p.network)}</span>` : ''}</td><td class="r mono">${qty(p.quantity)}</td>
        <td class="r">${p.price_usd === null || p.price_usd === undefined ? '-' : fmtUsd(p.price_usd, p.price_usd < 1 ? 4 : 2)}</td><td class="r">${fmtUsd(p.value_usd)}</td>
        <td class="r ${Number(p.pnl_usd) > 0 ? 'pos' : Number(p.pnl_usd) < 0 ? 'neg' : 'muted'}">${p.pnl_usd === null || p.pnl_usd === undefined ? '-' : fmtUsd(p.pnl_usd)}</td></tr>`
      )
      .join('');
    const m = modal(`<div class="modal-title">${esc(a.name)}: positions</div>
      <div class="muted small">${a.last_refresh_at ? `Valued ${esc(ago(a.last_refresh_at))}` : 'Not valued yet'}${a.last_error ? ` · <span class="neg">${esc(a.last_error)}</span>` : ''}</div>
      <div class="table-container"><table><thead><tr><th>Asset</th><th class="r">Quantity</th><th class="r">Price</th><th class="r">Value</th><th class="r">P/L</th></tr></thead><tbody>${rows || '<tr><td colspan="5" class="muted">None.</td></tr>'}</tbody></table></div>
      <div class="modal-actions"><button type="button" class="btn-secondary" data-close>Close</button></div>`, { wide: true });
    m.card.querySelector('[data-close]').onclick = m.close;
    m.card.querySelector('[data-close]').focus();
  }

  async function holdingsDialog(a) {
    const m = modal(`<div class="modal-title">${esc(a.name)}: holdings</div>
      <div class="muted small">Instruments must be registered (Ctrl+K search adds them); cash is a currency code such as USD. Cost basis is the total paid in USD (optional, for P/L).</div>
      <div class="table-container"><table><thead><tr><th>Symbol</th><th>Kind</th><th class="r">Quantity</th><th class="r">Cost basis</th><th></th></tr></thead><tbody data-rows><tr><td colspan="5" class="muted">Loading…</td></tr></tbody></table></div>
      <form class="toolbar-row" data-add autocomplete="off">
        <input name="symbol" list="pf-symbols" placeholder="AAPL, BTC/USDT, USD" required maxlength="40" aria-label="Symbol" class="small-input">
        <select name="kind" aria-label="Kind"><option value="asset">Instrument</option><option value="cash">Cash</option></select>
        <input name="quantity" type="number" step="any" min="0" placeholder="Quantity" required aria-label="Quantity" class="small-input">
        <input name="cost_basis" type="number" step="any" min="0" placeholder="Cost (USD)" aria-label="Cost basis in USD" class="small-input">
        <button type="submit" class="btn-buy small-btn"><i class="fa-solid fa-check" aria-hidden="true"></i> Save</button>
      </form>
      <datalist id="pf-symbols">${(TS.pairs || []).map((p) => `<option value="${esc(p.symbol)}">`).join('')}</datalist>
      <div class="modal-actions"><button type="button" class="btn-secondary" data-close>Done</button></div>`, { wide: true });
    const tbody = m.card.querySelector('[data-rows]');
    const form = m.card.querySelector('[data-add]');
    async function reload() {
      try {
        const hs = (await TS.api(`api/portfolio/accounts/${a.id}/holdings`)).holdings;
        tbody.innerHTML = hs.length
          ? hs.map((h) => `<tr data-h="${h.id}"><td><b>${esc(h.symbol)}</b></td><td>${esc(h.kind)}</td><td class="r mono">${qty(h.quantity)}</td><td class="r">${h.cost_basis === null ? '-' : fmtUsd(h.cost_basis)}</td>
              <td class="r nowrap"><button type="button" class="icon-btn" data-h-edit title="Edit"><i class="fa-solid fa-pen" aria-hidden="true"></i></button> <button type="button" class="icon-btn danger" data-h-del title="Remove"><i class="fa-solid fa-trash" aria-hidden="true"></i></button></td></tr>`).join('')
          : '<tr><td colspan="5" class="muted">No holdings yet.</td></tr>';
        tbody.onclick = async (e) => {
          const row = e.target.closest('[data-h]');
          if (!row) return;
          const h = hs.find((x) => String(x.id) === row.dataset.h);
          if (e.target.closest('[data-h-edit]')) {
            form.symbol.value = h.symbol;
            form.kind.value = h.kind;
            form.quantity.value = h.quantity;
            form.cost_basis.value = h.cost_basis === null ? '' : h.cost_basis;
            form.quantity.focus();
          }
          if (e.target.closest('[data-h-del]')) {
            await TS.apiSend('DELETE', `api/portfolio/holdings/${h.id}`).catch((err) => showToast('Not removed', esc(err.message), 'error'));
            reload();
          }
        };
      } catch (e) {
        tbody.innerHTML = `<tr><td colspan="5" class="form-error">${esc(e.message)}</td></tr>`;
      }
    }
    form.onsubmit = async (e) => {
      e.preventDefault();
      try {
        await TS.apiSend('PUT', `api/portfolio/accounts/${a.id}/holdings`, { symbol: form.symbol.value, kind: form.kind.value, quantity: form.quantity.value, cost_basis: form.cost_basis.value });
        form.reset();
        form.symbol.focus();
        reload();
      } catch (err) {
        showToast('Not saved', esc(err.message), 'error');
      }
    };
    m.card.querySelector('[data-close]').onclick = () => {
      m.close();
      load();
    };
    setTimeout(() => form.symbol.focus(), 0);
    reload();
  }

  const networkChecks = (selected) =>
    `<fieldset class="wl-nets"><legend class="muted small">Networks to read balances on</legend>${(ST.data ? ST.data.networks : [])
      .map((n) => `<label class="inline"><input type="checkbox" name="networks" value="${esc(n.id)}" ${selected.includes(n.id) ? 'checked' : ''}> ${esc(n.name)}</label>`)
      .join(' ')}</fieldset>`;
  const pickedNetworks = (form) => [...form.querySelectorAll('input[name="networks"]:checked')].map((c) => c.value);

  // origin: generated | import | watch
  function walletDialog(origin) {
    const title = { generated: 'New wallet', import: 'Import a wallet', watch: 'Watch an address' }[origin];
    const m = modal(`<form autocomplete="off" data-form>
      <div class="modal-title">${title}</div>
      ${origin === 'generated' ? '<div class="muted small">A new key is created on the server from a 12-word recovery phrase. The phrase is shown once, right after; write it down.</div>' : ''}
      ${origin === 'watch' ? '<div class="muted small">Only the address is stored; balances are tracked, nothing can be signed.</div>' : ''}
      <label>Name<input name="name" required maxlength="60" placeholder="e.g. Cold storage"></label>
      ${origin === 'import' ? `<div class="tf-btn-group" role="group" aria-label="What to import"><button type="button" class="tf-btn active" data-imp="private_key">Private key</button><button type="button" class="tf-btn" data-imp="mnemonic">Recovery phrase</button></div>
        <label data-for="private_key">Private key (64 hex digits)<input name="private_key" type="password" autocomplete="new-password" spellcheck="false" placeholder="0x…"></label>
        <label data-for="mnemonic" hidden>Recovery phrase (12 to 24 words)<textarea name="mnemonic" rows="3" spellcheck="false" autocomplete="off" placeholder="word1 word2 …"></textarea></label>
        <label data-for="mnemonic" hidden>Derivation path<input name="derivation_path" value="m/44'/60'/0'/0/0" spellcheck="false"></label>` : ''}
      ${origin === 'watch' ? '<label>Address<input name="address" required spellcheck="false" placeholder="0x…"></label>' : ''}
      ${networkChecks(['eth', 'arbitrum', 'base'])}
      <label class="inline"><input type="checkbox" name="track" checked> Track it in the portfolio</label>
      <div class="form-error" data-error hidden></div>
      <div class="modal-actions"><button type="button" class="btn-secondary" data-cancel>Cancel</button><button type="submit" class="btn-buy">${origin === 'generated' ? 'Create' : origin === 'watch' ? 'Add' : 'Import'}</button></div>
    </form>`);
    const form = m.card.querySelector('[data-form]');
    let imp = 'private_key';
    m.card.querySelectorAll('[data-imp]').forEach((b) =>
      b.addEventListener('click', () => {
        imp = b.dataset.imp;
        m.card.querySelectorAll('[data-imp]').forEach((x) => x.classList.toggle('active', x === b));
        m.card.querySelectorAll('[data-for]').forEach((el) => (el.hidden = el.dataset.for !== imp));
      })
    );
    m.card.querySelector('[data-cancel]').onclick = m.close;
    setTimeout(() => form.name.focus(), 0);
    form.onsubmit = async (e) => {
      e.preventDefault();
      const body = { name: form.name.value, networks: pickedNetworks(form), track: form.track.checked };
      if (origin === 'generated') body.origin = 'generated';
      if (origin === 'watch') Object.assign(body, { origin: 'watch', address: form.address.value.trim() });
      if (origin === 'import') {
        body.origin = imp;
        if (imp === 'private_key') body.private_key = form.private_key.value.trim();
        else Object.assign(body, { mnemonic: form.mnemonic.value, derivation_path: form.derivation_path.value.trim() });
      }
      const btn = form.querySelector('[type="submit"]');
      btn.disabled = true;
      try {
        const r = await TS.apiSend('POST', 'api/wallets', body);
        // Clear the secret fields before anything else.
        if (form.private_key) form.private_key.value = '';
        if (form.mnemonic) form.mnemonic.value = '';
        m.close();
        if (r.recovery_phrase) phraseDialog(r.wallet, r.recovery_phrase, r.derivation_path);
        else showToast(esc(r.wallet.name), `${esc(r.wallet.address)} ${origin === 'watch' ? 'is watched' : 'imported; the key is stored on the server'}`, 'success');
        load();
      } catch (err) {
        const box = form.querySelector('[data-error]');
        box.hidden = false;
        box.textContent = err.message;
        btn.disabled = false;
      }
    };
  }

  // Shown once: the new wallet's recovery phrase. Closing needs the "written down" tick.
  function phraseDialog(w, phrase, pathText) {
    const words = phrase.split(' ');
    const m = modal(`<div class="modal-title"><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i> Write down the recovery phrase</div>
      <div class="small">Wallet <b>${esc(w.name)}</b> · <code>${esc(w.address)}</code></div>
      <div class="phrase-grid">${words.map((x, i) => `<div class="phrase-word"><span class="muted">${i + 1}</span> ${esc(x)}</div>`).join('')}</div>
      <div class="muted small">Derivation path <code>${esc(pathText)}</code>. This is the only time the page shows the phrase. Anyone who has it controls the wallet; keep it offline. The server keeps a copy in <code>~/.openclaw/credentials/wallets/${w.id}.env</code> (0600).</div>
      <label class="inline"><input type="checkbox" data-ok> I have written the 12 words down</label>
      <div class="modal-actions"><button type="button" class="btn-buy" data-close disabled>Close</button></div>`, { wide: true });
    m.box.dataset.locked = '1';
    const ok = m.card.querySelector('[data-ok]');
    const close = m.card.querySelector('[data-close]');
    ok.onchange = () => (close.disabled = !ok.checked);
    close.onclick = () => {
      m.card.querySelector('.phrase-grid').innerHTML = '';
      m.close();
    };
    ok.focus();
  }

  function editWalletDialog(w) {
    const m = modal(`<form data-form autocomplete="off"><div class="modal-title">${esc(w.name)}</div>
      <label>Name<input name="name" required maxlength="60" value="${esc(w.name)}"></label>
      <label>Notes<input name="notes" maxlength="300" value="${esc(w.notes || '')}"></label>
      ${networkChecks(w.networks)}
      <div class="modal-actions"><button type="button" class="btn-secondary" data-cancel>Cancel</button><button type="submit" class="btn-buy">Save</button></div></form>`);
    const form = m.card.querySelector('[data-form]');
    m.card.querySelector('[data-cancel]').onclick = m.close;
    form.onsubmit = async (e) => {
      e.preventDefault();
      try {
        await TS.apiSend('PUT', `api/wallets/${w.id}`, { name: form.name.value, notes: form.notes.value, networks: pickedNetworks(form) });
        m.close();
        load();
      } catch (err) {
        showToast('Not saved', esc(err.message), 'error');
      }
    };
  }

  // ---- events -----------------------------------------------------------------------------
  $('pf-refresh').addEventListener('click', () => refresh());
  $('wl-new').addEventListener('click', () => walletDialog('generated'));
  $('wl-import').addEventListener('click', () => walletDialog('import'));
  $('wl-watch').addEventListener('click', () => walletDialog('watch'));

  $('pf-accounts-tbody').addEventListener('click', async (e) => {
    const row = e.target.closest('[data-account]');
    if (!row) return;
    const a = ST.data.accounts.find((x) => String(x.id) === row.dataset.account);
    if (e.target.closest('[data-pf-holdings]')) return holdingsDialog(a);
    if (e.target.closest('[data-pf-positions]')) return positionsDialog(a);
    if (e.target.closest('[data-pf-refresh]')) return refresh(a.id);
    if (e.target.closest('[data-pf-delete]')) {
      const ok = await TS.confirmAction({ title: `Remove ${a.name}?`, text: `The account${a.kind === 'manual' ? ' and its holdings' : ''} leave the portfolio. ${a.kind === 'wallet' ? 'The wallet itself and its key stay (delete it under EVM wallets).' : 'The venue or bot is not touched.'}`, ok: 'Remove', danger: true });
      if (!ok) return;
      await TS.apiSend('DELETE', `api/portfolio/accounts/${a.id}`).catch((err) => showToast('Not removed', esc(err.message), 'error'));
      load();
    }
  });
  $('pf-accounts-tbody').addEventListener('change', async (e) => {
    if (!e.target.matches('[data-pf-toggle]')) return;
    const id = e.target.closest('[data-account]').dataset.account;
    await TS.apiSend('PUT', `api/portfolio/accounts/${id}`, { enabled: e.target.checked }).catch((err) => showToast('Not saved', esc(err.message), 'error'));
    load();
  });

  $('wl-tbody').addEventListener('click', async (e) => {
    const row = e.target.closest('[data-wallet]');
    if (!row) return;
    const w = ST.data.wallets.find((x) => String(x.id) === row.dataset.wallet);
    if (e.target.closest('[data-wl-copy]')) {
      try {
        await navigator.clipboard.writeText(w.address);
        showToast('Copied', esc(w.address), 'success');
      } catch (err) {
        showToast('Not copied', 'the browser refused clipboard access', 'error');
      }
      return;
    }
    if (e.target.closest('[data-wl-edit]')) return editWalletDialog(w);
    if (e.target.closest('[data-wl-delete]')) {
      const secret = w.origin !== 'watch';
      const ok = await TS.confirmAction({
        title: `Delete wallet ${w.name}?`,
        text: secret
          ? `The wallet and its portfolio account are removed. Its key file moves to <code>~/.openclaw/credentials/wallets/trash</code> on the server. <b>Funds stay on the chain</b>: without the recovery phrase or key they cannot be moved.`
          : 'The watched address and its portfolio account are removed.',
        ok: 'Delete',
        danger: true,
        typed: secret ? w.name : null,
      });
      if (!ok) return;
      await TS.apiSend('DELETE', `api/wallets/${w.id}`).catch((err) => showToast('Not deleted', esc(err.message), 'error'));
      load();
    }
  });

  document.addEventListener('ts:tab', (e) => {
    if (e.detail === 'portfolio') load();
  });
  if (TS.activeTab === 'portfolio') load();

  TS.commands = TS.commands || [];
  TS.commands.push(
    { label: 'Portfolio', icon: 'fa-wallet', keywords: 'portfolio holdings balance wallet paper', run: () => TS.showTab('portfolio') },
    { label: 'Portfolio: new wallet', icon: 'fa-key', keywords: 'wallet create evm ethereum key', run: () => (TS.showTab('portfolio'), walletDialog('generated')) }
  );
})();
