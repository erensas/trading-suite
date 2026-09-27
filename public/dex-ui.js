// Web3 DEX tab: the pairs the engine scans, with arbitrage and flash loans switched on or off
// per pair (or per network). The engine reads the switches every cycle.
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (v) => escapeHtml(v);
  const { ago } = TS.fmt;
  const { markFresh, markError, retry } = TS.fresh;
  const ST = { pairs: [], engine: null, networks: [] };

  const seen = (p) => (p.last_seen_at ? `<span class="${p.seen_ago_s > 900 ? 'neg' : ''}" title="${esc(new Date(p.last_seen_at).toLocaleString('en-GB'))}">${esc(ago(p.last_seen_at))}</span>` : '<span class="muted">never</span>');
  const toggle = (p, flag) => `<label class="switch"><input type="checkbox" data-flag="${flag}" ${p[flag] ? 'checked' : ''} aria-label="${flag === 'arbitrage_enabled' ? 'Arbitrage' : 'Flash loan'} for ${esc(p.token_a)}/${esc(p.token_b)} on ${esc(p.network)}"><span>${p[flag] ? 'on' : 'off'}</span></label>`;

  function render() {
    const net = $('dexp-network').value;
    const rows = ST.pairs.filter((p) => !net || p.network === net);
    const e = ST.engine;
    const on = (f) => rows.filter((p) => p[f]).length;
    $('dexp-engine').innerHTML = `Engine: ${e ? `${esc(e.mode)} · ${esc(e.state)} · heartbeat ${esc(ago(e.last_seen))}` : 'not reporting'} · ${rows.length} pairs, arbitrage on ${on('arbitrage_enabled')}, flash loans on ${on('flashloan_enabled')}`;
    $('dexp-tbody').innerHTML = rows.length
      ? rows
          .map(
            (p) => `<tr data-pair="${p.id}" class="${p.arbitrage_enabled ? '' : 'muted'}">
          <td>${esc(p.network)}</td>
          <td><b>${esc(p.token_a)}/${esc(p.token_b)}</b></td>
          <td class="r">${p.pool_count}</td>
          <td class="small">${esc((p.dexes || []).join(', '))}</td>
          <td class="small">${seen(p)}</td>
          <td>${toggle(p, 'arbitrage_enabled')}</td>
          <td>${toggle(p, 'flashloan_enabled')}</td>
          <td class="small muted" title="${esc(p.updated_by || '')}">${p.updated_by ? esc(ago(p.updated_at)) : '-'}</td></tr>`
          )
          .join('')
      : `<tr><td colspan="8" class="muted">${ST.pairs.length ? 'No pairs on this network.' : 'The engine has not reported any pairs yet (it does after its next pool discovery, every 5 minutes).'}</td></tr>`;
  }

  async function load() {
    try {
      const d = await TS.api('api/dex/pairs');
      ST.pairs = d.pairs;
      ST.engine = d.engine;
      const nets = [...new Set(d.pairs.map((p) => p.network))];
      const sel = $('dexp-network');
      const keep = sel.value;
      sel.innerHTML = '<option value="">All networks</option>' + nets.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
      sel.value = nets.includes(keep) ? keep : '';
      render();
      markFresh('dexpairs');
    } catch (e) {
      markError('dexpairs', e.message);
      $('dexp-tbody').innerHTML = `<tr><td colspan="8" class="form-error">${esc(e.message)} ${TS.fresh.retryButton('dexpairs')}</td></tr>`;
    }
  }
  retry.dexpairs = load;

  $('dexp-network').addEventListener('change', render);
  $('dexp-tbody').addEventListener('change', async (e) => {
    const input = e.target.closest('[data-flag]');
    if (!input) return;
    const id = input.closest('[data-pair]').dataset.pair;
    input.disabled = true;
    try {
      await TS.apiSend('PUT', `api/dex/pairs/${id}`, { [input.dataset.flag]: input.checked });
    } catch (err) {
      showToast('Not saved', esc(err.message), 'error');
    }
    load();
  });
  document.querySelector('#tab-dex').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-dexp-bulk]');
    if (!b) return;
    const net = $('dexp-network').value;
    const flag = b.dataset.dexpBulk;
    const value = b.dataset.on === 'true';
    const what = `${flag === 'arbitrage_enabled' ? 'Arbitrage' : 'Flash loans'} ${value ? 'on' : 'off'}`;
    const ok = await TS.confirmAction({ title: `${what} for ${net ? `every ${net} pair` : 'every pair'}?`, text: `The engine picks this up in its next cycle.`, ok: what, danger: !value });
    if (!ok) return;
    try {
      const r = await TS.apiSend('PUT', 'api/dex/pairs', net ? { network: net, [flag]: value } : { all: true, [flag]: value });
      showToast(what, `${r.updated} pairs`, 'success');
    } catch (err) {
      showToast('Not saved', esc(err.message), 'error');
    }
    load();
  });

  document.addEventListener('ts:tab', (e) => {
    if (e.detail === 'dex') load();
  });
  setInterval(() => TS.activeTab === 'dex' && !document.hidden && load(), 30000);
  if (TS.activeTab === 'dex') load();
})();
