// Settings → Trading venues: exchange and broker accounts, write-only API keys, connection
// tests, the Web3 engine as a read-only DEX venue, and Freqtrade's exchange list.
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (v) => escapeHtml(v);
  const { ago } = TS.fmt;
  const ST = { venues: [], exchanges: [], brokers: [] };

  function fillExchangeSelect() {
    const f = $('venue-form');
    const broker = f.kind.value === 'broker';
    const keep = f.exchange.value;
    f.exchange.innerHTML = broker
      ? ST.brokers.map((b) => `<option value="${esc(b.id)}">${esc(b.name)}</option>`).join('')
      : ST.exchanges
          .filter((x) => x.supported)
          .map((x) => `<option value="${esc(x.id)}">${esc(x.name)}</option>`)
          .join('') + `<optgroup label="Not supported by the Freqtrade team">${ST.exchanges.filter((x) => !x.supported).map((x) => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('')}</optgroup>`;
    if (keep) f.exchange.value = keep;
    f.trading_mode.disabled = broker;
    f.mode.innerHTML = broker ? '<option value="paper">Paper trading</option>' : '<option value="read_only">Keys: read only</option><option value="live">Keys: live trading</option>';
  }

  const testCell = (v) =>
    v.last_test_at
      ? `<span class="${v.last_test_ok ? 'pos' : 'neg'}" title="${esc(v.last_test_message || '')}">${v.last_test_ok ? '✓' : '✗'} ${esc(ago(v.last_test_at))}</span><div class="muted small venue-msg">${esc(v.last_test_message || '')}</div>`
      : '<span class="muted">not tested</span>';

  function render() {
    const name = (id) => (ST.exchanges.find((x) => x.id === id) || ST.brokers.find((b) => b.id === id) || { name: id }).name;
    $('venues-tbody').innerHTML = ST.venues.length
      ? ST.venues
          .map(
            (v) => `<tr data-venue="${v.id}">
            <td><b>${esc(v.name)}</b>${v.notes ? `<div class="muted small">${esc(v.notes)}</div>` : ''}</td>
            <td>${v.kind === 'cex' ? 'exchange' : 'broker'}</td>
            <td>${esc(name(v.exchange))}</td>
            <td>${esc(v.trading_mode)}</td>
            <td>${v.mode === 'live' ? '<span class="pill pill-red">live trading</span>' : v.mode === 'paper' ? '<span class="pill pill-blue">paper</span>' : '<span class="pill pill-gray">read only</span>'}</td>
            <td>${v.keys.configured ? `set <code>${esc(v.keys.hint)}</code>` : '<span class="muted">none</span>'}</td>
            <td class="small">${testCell(v)}</td>
            <td><input type="checkbox" data-venue-toggle ${v.enabled ? 'checked' : ''} aria-label="Enabled"></td>
            <td class="nowrap r">
              <button type="button" class="icon-btn" data-venue-keys title="API keys"><i class="fa-solid fa-key" aria-hidden="true"></i></button>
              <button type="button" class="icon-btn" data-venue-test title="Test the connection"><i class="fa-solid fa-plug-circle-check" aria-hidden="true"></i></button>
              <button type="button" class="icon-btn danger" data-venue-delete title="Delete"><i class="fa-solid fa-trash" aria-hidden="true"></i></button>
            </td></tr>`
          )
          .join('')
      : '<tr><td colspan="9" class="muted">No venues yet. Add an exchange account or Alpaca paper below.</td></tr>';
    $('venues-ex-count').textContent = `(${ST.exchanges.filter((x) => x.supported).length} supported, ${ST.exchanges.length} in total)`;
    $('venues-ex-tbody').innerHTML = ST.exchanges
      .map((x) => `<tr><td>${esc(x.name)}</td><td><code>${esc(x.id)}</code></td><td>${x.supported ? '<span class="pos">supported</span>' : '<span class="muted">community</span>'}${x.dex ? ' <span class="pill pill-purple">DEX</span>' : ''}</td><td>${esc((x.modes || []).join(', '))}</td><td class="muted small">${esc(x.comment || '')}</td></tr>`)
      .join('');
  }

  async function loadDex() {
    try {
      const d = await TS.api('api/venues/dex');
      const e = d.engine;
      $('venues-dex').innerHTML = `
        <div class="kv-grid">
          <div class="kv"><div class="k">Engine</div><div class="v">web3-dex-bot</div></div>
          <div class="kv"><div class="k">Mode</div><div class="v">${e ? esc(e.mode) : 'not reporting'}</div></div>
          <div class="kv"><div class="k">State</div><div class="v">${e ? esc(e.state) : '-'}</div></div>
          <div class="kv"><div class="k">Heartbeat</div><div class="v">${e && e.last_seen ? esc(ago(e.last_seen)) : '-'}</div></div>
        </div>
        <div class="table-container"><table><thead><tr><th>Network (tracked pools)</th><th class="r">Pools</th><th class="r">Active</th></tr></thead><tbody>${
          d.networks.map((n) => `<tr><td>${esc(n.network)}</td><td class="r">${n.pools}</td><td class="r">${n.active}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">No DEX pools in the registry.</td></tr>'
        }</tbody></table></div>
        <div class="hint">The engine's chains, RPC endpoints, DEX routers and wallet are set in its own repository (web3-dex-bot) and <code>.env</code>, not here. The suite shows its heartbeat, charts its pools through GeckoTerminal, and the kill switch reaches it through <code>trading_control</code>. Live transactions need <code>LIVE_TRADING=true</code> there.</div>`;
    } catch (err) {
      $('venues-dex').textContent = err.message;
    }
  }

  async function load() {
    try {
      const d = await TS.api('api/venues');
      Object.assign(ST, { venues: d.venues, exchanges: d.exchanges, brokers: d.brokers });
      fillExchangeSelect();
      render();
    } catch (e) {
      $('venues-tbody').innerHTML = `<tr><td colspan="9" class="form-error">${esc(e.message)}</td></tr>`;
    }
    loadDex();
  }
  TS.settingsLoaders = TS.settingsLoaders || {};
  TS.settingsLoaders.venues = load;
  TS.venues = { list: () => ST.venues, load };

  $('venue-form').kind.addEventListener('change', fillExchangeSelect);
  $('venue-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const body = { name: f.name.value, kind: f.kind.value, exchange: f.exchange.value, trading_mode: f.trading_mode.value, mode: f.mode.value, notes: f.notes.value || null };
    try {
      const v = (await TS.apiSend('POST', 'api/venues', body)).venue;
      f.name.value = '';
      f.notes.value = '';
      showToast(esc(v.name), 'added; set its API keys with the key button', 'success');
      load();
    } catch (err) {
      showToast('Venue not added', esc(err.message), 'error');
    }
  });

  function keysDialog(v) {
    return new Promise((resolve) => {
      const box = document.createElement('div');
      box.className = 'modal-backdrop';
      box.setAttribute('role', 'dialog');
      box.setAttribute('aria-modal', 'true');
      box.innerHTML = `<form class="modal-card" autocomplete="off">
        <div class="modal-title">API keys: ${esc(v.name)}</div>
        <div class="muted small">${v.keys.configured ? `Set now: <code>${esc(v.keys.hint)}</code>. New values replace them.` : 'No keys set.'} ${v.kind === 'cex' ? 'Create keys without withdrawal rights, limited to this server\'s IP if the exchange allows it.' : 'Use the keys of the Alpaca paper account.'}</div>
        <label>API key<input name="key" required spellcheck="false" autocomplete="off"></label>
        <label>Secret<input name="secret" type="password" required autocomplete="new-password"></label>
        ${v.kind === 'cex' ? '<label>Passphrase (OKX, KuCoin, Bitget…)<input name="password" type="password" autocomplete="new-password"></label>' : ''}
        <div class="modal-actions">${v.keys.configured ? '<button type="button" class="btn-secondary danger" data-remove>Remove keys</button><span class="spacer"></span>' : ''}<button type="button" class="btn-secondary" data-cancel>Cancel</button><button type="submit" class="btn-buy">Save keys</button></div>
      </form>`;
      document.body.appendChild(box);
      const form = box.querySelector('form');
      setTimeout(() => form.key.focus(), 0);
      const done = (v2) => {
        box.remove();
        resolve(v2);
      };
      form.onsubmit = (e) => {
        e.preventDefault();
        done({ key: form.key.value.trim(), secret: form.secret.value.trim(), password: form.password ? form.password.value.trim() || null : null });
      };
      box.querySelector('[data-cancel]').onclick = () => done(null);
      const rm = box.querySelector('[data-remove]');
      if (rm) rm.onclick = () => done({ remove: true });
      box.onkeydown = (e) => e.key === 'Escape' && done(null);
    });
  }

  $('venues-tbody').addEventListener('click', async (e) => {
    const row = e.target.closest('[data-venue]');
    if (!row) return;
    const v = ST.venues.find((x) => String(x.id) === row.dataset.venue);
    if (e.target.closest('[data-venue-keys]')) {
      const input = await keysDialog(v);
      if (!input) return;
      try {
        if (input.remove) {
          await TS.apiSend('DELETE', `api/venues/${v.id}/keys`);
          showToast(esc(v.name), 'keys removed', 'success');
        } else {
          const r = await TS.apiSend('PUT', `api/venues/${v.id}/keys`, input);
          showToast(esc(v.name), `keys saved (${esc(r.keys.hint)}); testing`, 'success');
          await TS.apiSend('POST', `api/venues/${v.id}/test`).catch(() => {});
        }
      } catch (err) {
        showToast('Keys not saved', esc(err.message), 'error');
      }
      return load();
    }
    if (e.target.closest('[data-venue-test]')) {
      const b = e.target.closest('[data-venue-test]');
      b.disabled = true;
      b.innerHTML = '<i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i>';
      try {
        const r = (await TS.apiSend('POST', `api/venues/${v.id}/test`)).result;
        showToast(esc(v.name), esc(r.message || (r.ok ? 'ok' : 'failed')), r.ok ? 'success' : 'error');
      } catch (err) {
        showToast('Test failed', esc(err.message), 'error');
      }
      return load();
    }
    if (e.target.closest('[data-venue-delete]')) {
      const ok = await TS.confirmAction({ title: `Delete ${esc(v.name)}?`, text: 'The venue is removed; its keys file moves to <code>~/.openclaw/credentials/venues/trash</code>. Bots that copied its keys keep their own copy.', ok: 'Delete', danger: true });
      if (!ok) return;
      await TS.apiSend('DELETE', `api/venues/${v.id}`).catch((err) => showToast('Not deleted', esc(err.message), 'error'));
      return load();
    }
  });
  $('venues-tbody').addEventListener('change', async (e) => {
    if (!e.target.matches('[data-venue-toggle]')) return;
    const id = e.target.closest('[data-venue]').dataset.venue;
    await TS.apiSend('PUT', `api/venues/${id}`, { enabled: e.target.checked }).catch((err) => showToast('Not saved', esc(err.message), 'error'));
    load();
  });

  TS.commands = TS.commands || [];
  TS.commands.push({ label: 'Settings: trading venues', icon: 'fa-building-columns', keywords: 'exchange broker alpaca api keys', run: () => TS.openSettings('venues') });
})();
