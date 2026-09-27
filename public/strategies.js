// Strategy center (Strategies tab): every bot with its mode, state and strategy; managed
// bots (create, settings, delete); the strategy library with checks and an editor; backtests
// with results and an equity curve; the steps to live trading.
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (v) => escapeHtml(v);
  const { fmtPct, fmtTime, ago } = TS.fmt;
  const { changeClass } = TS.util;
  const PANES = ['bots', 'library', 'editor', 'backtests'];
  const TIMEFRAMES = ['1m', '5m', '15m', '1h', '4h', '1d'];

  const ST = {
    pane: 'bots',
    bots: [],
    exchanges: ['binance'],
    lib: { library: [], templates: [], mainFiles: [] },
    backtests: [],
    editor: null,
    editing: null, // { name, isNew, sha }
    dirty: false,
    detailId: null,
    equity: null,
    botName: null,
    loaded: {},
  };

  const num = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v));
  const fmtNum = (v, d = 2) => (Number.isFinite(num(v)) ? num(v).toLocaleString('en-US', { maximumFractionDigits: d }) : '-');
  const ratioPct = (v) => (Number.isFinite(num(v)) ? fmtPct(num(v) * 100) : '-');
  const plainPct = (v) => (Number.isFinite(num(v)) ? `${(num(v) * 100).toFixed(1)}%` : '-');
  const toast = (title, msg, type) => showToast(title, esc(msg || ''), type);
  const fail = (title) => (e) => toast(title, e.message, 'error');

  // ---- generic confirmation dialog (optionally typed) -------------------------------------
  const confirmBox = document.createElement('div');
  confirmBox.id = 'confirm-modal';
  confirmBox.className = 'modal-backdrop hidden';
  confirmBox.setAttribute('role', 'dialog');
  confirmBox.setAttribute('aria-modal', 'true');
  confirmBox.innerHTML = `<form class="modal-card" id="confirm-form">
      <div class="modal-title" id="confirm-title"></div>
      <div class="modal-text" id="confirm-text"></div>
      <label id="confirm-typed-label" class="hidden"><span id="confirm-typed-hint"></span><input id="confirm-typed" autocomplete="off"></label>
      <div class="modal-actions"><button type="button" class="btn-secondary" id="confirm-cancel">Cancel</button><button type="submit" id="confirm-ok"></button></div>
    </form>`;
  document.body.appendChild(confirmBox);
  confirmBox.setAttribute('aria-labelledby', 'confirm-title');

  function confirmAction({ title, text, ok = 'Confirm', danger = false, typed = null }) {
    return new Promise((resolve) => {
      $('confirm-title').textContent = title;
      $('confirm-text').innerHTML = text;
      $('confirm-ok').textContent = ok;
      $('confirm-ok').className = danger ? 'kill-btn' : 'btn-buy';
      $('confirm-typed-label').classList.toggle('hidden', !typed);
      $('confirm-typed').value = '';
      if (typed) $('confirm-typed-hint').textContent = `Type ${typed} to confirm`;
      confirmBox.classList.remove('hidden');
      setTimeout(() => (typed ? $('confirm-typed') : $('confirm-ok')).focus(), 0);
      const done = (value) => {
        confirmBox.classList.add('hidden');
        $('confirm-form').onsubmit = null;
        $('confirm-cancel').onclick = null;
        resolve(value);
      };
      $('confirm-form').onsubmit = (e) => {
        e.preventDefault();
        if (typed && $('confirm-typed').value.trim() !== typed) {
          $('confirm-typed').focus();
          return;
        }
        done(typed ? $('confirm-typed').value.trim() : true);
      };
      $('confirm-cancel').onclick = () => done(false);
      confirmBox.onkeydown = (e) => e.key === 'Escape' && done(false);
    });
  }
  TS.confirmAction = confirmAction;

  // ---- panes --------------------------------------------------------------------------------
  function setPane(pane) {
    if (!PANES.includes(pane)) pane = 'bots';
    const changed = pane !== ST.pane;
    ST.pane = pane;
    TS.strategiesPane = pane;
    for (const p of PANES) $(`strat-${p}`).classList.toggle('hidden', p !== pane);
    document.querySelectorAll('#strat-nav [data-pane]').forEach((b) => {
      b.classList.toggle('active', b.dataset.pane === pane);
      b.setAttribute('aria-pressed', String(b.dataset.pane === pane));
    });
    if (TS.activeTab === 'strategies') {
      TS.syncUrl(changed);
      loadPane();
    }
  }
  TS.setStrategiesPane = setPane;

  function loadPane() {
    if (ST.pane === 'bots') loadBots();
    if (ST.pane === 'library') loadLibrary();
    if (ST.pane === 'editor') openEditorPane();
    if (ST.pane === 'backtests') {
      loadLibrary().then(fillBacktestForm);
      loadBacktests();
    }
  }

  $('strat-nav').addEventListener('click', (e) => {
    const b = e.target.closest('[data-pane]');
    if (b) setPane(b.dataset.pane);
  });
  document.addEventListener('ts:tab', (e) => e.detail === 'strategies' && loadPane());

  // ---- bots -----------------------------------------------------------------------------------
  async function loadBots() {
    try {
      const d = await TS.api('api/bots');
      ST.bots = d.bots;
      ST.exchanges = d.exchanges || ST.exchanges;
      ST.loaded.bots = Date.now();
      renderBots();
      if (ST.botName && !$('bot-modal').classList.contains('hidden')) {
        const b = ST.bots.find((x) => x.name === ST.botName);
        if (b) renderBotHeader(b);
      }
    } catch (e) {
      $('bots-grid').innerHTML = `<div class="form-error">Bots could not be loaded: ${esc(e.message)}</div>`;
    }
  }

  const loopState = (b) => String((b.api && b.api.state) || 'unknown').toLowerCase();

  function statePill(b) {
    const s = loopState(b);
    const cls = { running: 'pill-green', paused: 'pill-warn', stopped: 'pill-gray', 'process stopped': 'pill-gray', unreachable: 'pill-red', offline: 'pill-red', 'not reporting': 'pill-gray' }[s] || 'pill-gray';
    const label = s === 'paused' ? 'paused (no entries)' : s;
    return `<span class="pill ${cls}" title="Trading loop state">${esc(label)}</span>`;
  }
  const modePill = (b) => (b.dry_run === false ? '<span class="pill pill-red" title="Real orders on the exchange">LIVE</span>' : '<span class="pill pill-blue" title="Simulated orders">DRY-RUN</span>');
  const kindLabel = (b) => (b.engine === 'web3' ? 'Web3 DEX engine' : b.managed ? 'Managed Freqtrade bot' : 'Main Freqtrade bot');

  function botActions(b) {
    if (b.engine !== 'freqtrade') return `<button type="button" class="btn-secondary small-btn" data-bot-act="details">Details</button>`;
    const s = loopState(b);
    const procDown = b.managed && b.unit_state && !b.unit_state.active;
    const btn = (act, icon, label, on = true, cls = 'btn-secondary') => `<button type="button" class="${cls} small-btn" data-bot-act="${act}" ${on ? '' : 'disabled'}><i class="fa-solid ${icon}" aria-hidden="true"></i> ${label}</button>`;
    if (procDown) return btn('start_process', 'fa-power-off', 'Start process', true, 'btn-buy') + btn('details', 'fa-sliders', 'Details');
    return [
      btn('start', 'fa-play', 'Start', s !== 'running'),
      btn('pause', 'fa-pause', 'Pause', s === 'running'),
      btn('stop', 'fa-stop', 'Stop', s === 'running' || s === 'paused'),
      btn('details', 'fa-sliders', 'Details'),
    ].join('');
  }

  function renderBots() {
    if (!ST.bots.length) {
      $('bots-grid').innerHTML = '<div class="muted pad">No bots yet.</div>';
      return;
    }
    $('bots-grid').innerHTML = ST.bots
      .map((b) => {
        const api = b.api || {};
        const cfg = b.config || {};
        const p = b.profit || {};
        const stake = api.stake_currency || cfg.stake_currency || '';
        const tf = api.timeframe || cfg.timeframe || '';
        const sub = b.engine === 'web3' ? 'Arbitrage scanner · reports through engine_status' : [b.exchange, b.trading_mode, tf, cfg.pairs ? `${cfg.pairs.length} pairs` : null].filter(Boolean).join(' · ');
        const proc = b.managed && b.unit_state ? `<span class="muted small" title="${esc(b.unit)}">process ${esc(b.unit_state.state)}${b.unit_state.memoryMb ? ` · ${b.unit_state.memoryMb} MB` : ''}</span>` : '';
        return `<article class="bot-card ${b.dry_run === false ? 'is-live' : ''}" data-bot="${esc(b.name)}">
          <div class="bot-head">
            <div class="bot-name"><i class="fa-solid ${b.engine === 'web3' ? 'fa-bolt' : 'fa-robot'}" aria-hidden="true"></i> ${esc(b.name)}</div>
            <div class="bot-badges">${modePill(b)} ${statePill(b)}</div>
          </div>
          <div class="muted small">${esc(kindLabel(b))}${sub ? ` · ${esc(sub)}` : ''}</div>
          <div class="bot-strategy"><span class="k">Strategy</span><b>${esc(b.strategy || '-')}</b>${b.engine === 'freqtrade' ? `<button type="button" class="pill pill-blue" data-bot-act="strategy" ${b.dry_run === false ? 'disabled title="Switch the bot to dry-run first"' : ''}>Change</button>` : ''}</div>
          ${b.engine === 'freqtrade' ? `<div class="bot-stats">
            <div><span class="k">Open trades</span><span class="v">${b.open_trades.length}${b.count && b.count.max ? `/${b.count.max}` : ''}</span></div>
            <div><span class="k">Closed P/L</span><span class="v ${changeClass(p.closed)}">${fmtNum(p.closed, 2)} ${esc(stake)}</span></div>
            <div><span class="k">Trades</span><span class="v">${p.trades ?? '-'}</span></div>
            <div><span class="k">Win rate</span><span class="v">${Number.isFinite(num(p.winrate)) ? plainPct(p.winrate) : '-'}</span></div>
          </div>` : `<div class="bot-stats"><div><span class="k">Last heartbeat</span><span class="v">${api.last_seen ? esc(ago(api.last_seen)) : '-'}</span></div></div>`}
          ${b.mode_mismatch ? '<div class="form-error small">The bot reports a different mode than recorded; check its config.</div>' : ''}
          ${b.error ? `<div class="muted small">${esc(b.error)}</div>` : ''}
          <div class="bot-foot">${proc}<span class="spacer"></span>${botActions(b)}</div>
        </article>`;
      })
      .join('');
  }

  async function botAction(name, action) {
    const b = ST.bots.find((x) => x.name === name) || { name };
    if (action === 'stop') {
      const ok = await confirmAction({
        title: `Stop ${name}?`,
        text: 'The trading loop stops: open trades stay open and are <b>not managed</b> (no exits) until the bot starts again. <b>Pause</b> keeps managing open trades and only blocks new entries.',
        ok: 'Stop',
        danger: true,
      });
      if (!ok) return;
    }
    if (action === 'stop_process') {
      const ok = await confirmAction({ title: `Stop the ${name} process?`, text: `The Freqtrade process (<code>${esc(b.unit || '')}</code>) stops; nothing is managed until it starts again.`, ok: 'Stop process', danger: true });
      if (!ok) return;
    }
    try {
      await TS.apiSend('POST', `api/bots/${encodeURIComponent(name)}/action`, { action });
      toast(name, `${action.replace('_', ' ')}: done`, 'success');
    } catch (e) {
      toast(`${name}: ${action.replace('_', ' ')} failed`, e.message, 'error');
    }
    setTimeout(loadBots, action.endsWith('process') ? 4000 : 800);
    if (ST.botName === name && !$('bot-modal').classList.contains('hidden')) setTimeout(() => openBot(name), action.endsWith('process') ? 4000 : 800);
  }

  $('bots-grid').addEventListener('click', (e) => {
    const b = e.target.closest('[data-bot-act]');
    if (!b) return;
    const name = b.closest('[data-bot]').dataset.bot;
    const act = b.dataset.botAct;
    if (act === 'details') return openBot(name);
    if (act === 'strategy') return openBot(name, 'strategy');
    botAction(name, act);
  });
  $('btn-refresh-bots').addEventListener('click', loadBots);

  // ---- one bot ------------------------------------------------------------------------------
  function openModal(id) {
    $(id).classList.remove('hidden');
  }
  function closeModal(id) {
    $(id).classList.add('hidden');
    if (id === 'bot-modal') ST.botName = null;
  }
  document.addEventListener('click', (e) => {
    const close = e.target.closest('#bot-modal [data-close-modal], #newbot-modal [data-close-modal], #newstrat-modal [data-close-modal]');
    if (close) return closeModal(close.closest('.modal-backdrop').id);
    if (['bot-modal', 'newbot-modal', 'newstrat-modal'].includes(e.target.id)) closeModal(e.target.id);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !confirmBox.classList.contains('hidden')) return;
    for (const id of ['newbot-modal', 'newstrat-modal', 'bot-modal']) {
      if (!$(id).classList.contains('hidden')) {
        e.preventDefault();
        return closeModal(id);
      }
    }
  });

  function renderBotHeader(b) {
    $('bot-title').innerHTML = `<i class="fa-solid ${b.engine === 'web3' ? 'fa-bolt' : 'fa-robot'}" aria-hidden="true"></i> ${esc(b.name)} ${modePill(b)} ${statePill(b)}`;
  }

  const kv = (k, v) => `<div class="kv"><div class="k">${esc(k)}</div><div class="v">${v}</div></div>`;

  function strategyChoices(b) {
    const lib = ST.lib.library.map((s) => ({ name: s.name, ok: s.check_status === 'ok', note: s.check_status === 'ok' ? '' : ` (check ${s.check_status})` }));
    const main = b.managed ? [] : ST.lib.mainFiles.map((s) => ({ name: s.name, ok: true, note: ' (main bot file)' }));
    return [...lib, ...main];
  }

  async function openBot(name, focus) {
    ST.botName = name;
    openModal('bot-modal');
    $('bot-body').innerHTML = '<div class="skeleton sk-line"></div><div class="skeleton sk-line"></div>';
    let b;
    try {
      [b] = await Promise.all([TS.api(`api/bots/${encodeURIComponent(name)}`).then((d) => d.bot), loadLibrary({ quiet: true })]);
    } catch (e) {
      $('bot-body').innerHTML = `<div class="form-error">${esc(e.message)}</div>`;
      return;
    }
    if (ST.botName !== name) return;
    renderBotHeader(b);
    const api = b.api || {};
    const cfg = b.config || {};
    const us = b.unit_state || {};
    const sections = [];
    sections.push(`<div class="kv-grid">
      ${kv('Kind', esc(kindLabel(b)))}
      ${kv('Unit', `<code>${esc(b.unit)}</code>`)}
      ${b.managed ? kv('Process', `${esc(us.state || '-')}${us.since ? ` · since ${esc(fmtTime(us.since))}` : ''}${us.memoryMb ? ` · ${us.memoryMb} MB` : ''}`) : ''}
      ${b.engine === 'freqtrade' ? kv('Exchange', `${esc(b.exchange || api.exchange || '-')} · ${esc(b.trading_mode)}`) : ''}
      ${b.engine === 'freqtrade' ? kv('Timeframe', esc(api.timeframe || cfg.timeframe || 'strategy default')) : ''}
      ${cfg.stake_amount !== undefined ? kv('Stake × max open', `${esc(cfg.stake_amount)} ${esc(cfg.stake_currency || '')} × ${esc(cfg.max_open_trades)}`) : ''}
      ${b.api_port ? kv('API', `<code>127.0.0.1:${b.api_port}</code>`) : ''}
      ${b.dry_run_since ? kv(b.dry_run ? 'Dry-run since' : 'Live since', esc(fmtTime(b.dry_run ? b.dry_run_since : b.live_since))) : ''}
      ${b.capital_limit ? kv('Capital limit', esc(fmtNum(b.capital_limit))) : ''}
      ${b.created_by ? kv('Created by', esc(b.created_by)) : ''}
    </div>`);
    if (cfg.pairs && cfg.pairs.length) sections.push(`<div class="chip-list">${cfg.pairs.map((p) => `<span class="chip">${esc(p)}</span>`).join('')}</div>`);

    if (b.engine === 'freqtrade') {
      const choices = strategyChoices(b);
      sections.push(`<section class="bot-section" id="bot-sec-strategy"><h3>Strategy</h3>
        <div class="toolbar-row">
          <span>Now: <b>${esc(b.strategy || '-')}</b></span>
          <select id="bot-strategy-select" aria-label="New strategy">${choices.map((c) => `<option value="${esc(c.name)}" ${c.ok ? '' : 'disabled'} ${c.name === b.strategy ? 'selected' : ''}>${esc(c.name + c.note)}</option>`).join('')}</select>
          <button type="button" class="btn-buy" id="bot-strategy-apply" ${b.dry_run ? '' : 'disabled'}>Switch</button>
        </div>
        <div class="hint">${b.dry_run ? 'The bot writes the new strategy into its config and reloads it; open trades stay open and follow the new strategy\'s exit rules. The dry-run clock for going live starts again.' : 'A live bot keeps its strategy; switch it back to dry-run first.'}${b.managed ? '' : ' The main bot can load library strategies and its own files.'}</div>
      </section>`);
      sections.push(`<section class="bot-section"><h3>Controls</h3><div class="toolbar-row">
        <button type="button" class="btn-secondary" data-bot-do="start"><i class="fa-solid fa-play" aria-hidden="true"></i> Start</button>
        <button type="button" class="btn-secondary" data-bot-do="pause"><i class="fa-solid fa-pause" aria-hidden="true"></i> Pause</button>
        <button type="button" class="btn-secondary" data-bot-do="stop"><i class="fa-solid fa-stop" aria-hidden="true"></i> Stop</button>
        <button type="button" class="btn-secondary" data-bot-do="reload"><i class="fa-solid fa-rotate" aria-hidden="true"></i> Reload config</button>
        ${b.managed ? `<span class="spacer"></span>
        <button type="button" class="btn-secondary" data-bot-do="start_process" ${us.active ? 'disabled' : ''}><i class="fa-solid fa-power-off" aria-hidden="true"></i> Start process</button>
        <button type="button" class="btn-secondary" data-bot-do="restart_process" ${us.active ? '' : 'disabled'}><i class="fa-solid fa-arrows-rotate" aria-hidden="true"></i> Restart process</button>
        <button type="button" class="btn-secondary" data-bot-do="stop_process" ${us.active ? '' : 'disabled'}><i class="fa-solid fa-plug-circle-xmark" aria-hidden="true"></i> Stop process</button>` : ''}
      </div></section>`);
    }
    if (b.managed) {
      sections.push(`<section class="bot-section"><h3>Settings</h3>
        <form id="bot-edit-form" class="form-grid single">
          <label class="full">Pairs<input name="pairs" value="${esc((cfg.pairs || []).join(', '))}"></label>
          <label>Stake per trade<input name="stake_amount" type="number" step="any" min="1" value="${esc(cfg.stake_amount ?? '')}"></label>
          <label>Max open trades<input name="max_open_trades" type="number" min="1" max="20" value="${esc(cfg.max_open_trades ?? '')}"></label>
          <label>Timeframe<select name="timeframe"><option value="">Strategy default</option>${TIMEFRAMES.map((t) => `<option ${t === cfg.timeframe ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
          <label>Dry-run wallet<input name="dry_run_wallet" type="number" step="any" min="1" value="${esc(cfg.dry_run_wallet ?? '')}"></label>
          <label class="full">Description<input name="description" maxlength="200" value="${esc(b.description || '')}"></label>
          <div class="form-actions full"><button type="submit" class="btn-buy">Save and reload</button></div>
        </form></section>`);
      sections.push(`<section class="bot-section" id="bot-sec-live"><h3>Live trading</h3><div id="bot-live"><div class="skeleton sk-line"></div></div></section>`);
    } else if (b.engine === 'freqtrade') {
      sections.push(`<section class="bot-section"><h3>Live trading</h3><div class="hint">The main bot stays in dry-run. Live trading is for managed bots: create one with the strategy, let it run in dry-run, and follow the checks under its Details.</div></section>`);
    }
    sections.push(`<section class="bot-section"><h3>Recent events</h3>${
      (b.events || []).length
        ? `<div class="table-container"><table><thead><tr><th>When</th><th>Action</th><th>By</th><th>Detail</th></tr></thead><tbody>${b.events
            .map((ev) => `<tr><td class="nowrap">${esc(fmtTime(ev.at))}</td><td>${esc(ev.action)}</td><td class="muted small">${esc(String(ev.actor || '').replace('trading-suite UI: ', ''))}</td><td class="muted small">${esc(ev.detail ? JSON.stringify(ev.detail).slice(0, 160) : '')}</td></tr>`)
            .join('')}</tbody></table></div>`
        : '<div class="muted small">None yet.</div>'
    }</section>`);
    sections.push(`<section class="bot-section"><h3>Journal <button type="button" class="pill pill-blue" id="bot-journal-load"><i class="fa-solid fa-rotate" aria-hidden="true"></i> Load</button></h3><pre id="bot-journal" class="log-box short">Press Load for the last 200 lines.</pre></section>`);
    if (b.managed) {
      sections.push(`<section class="bot-section danger"><h3>Delete</h3><div class="toolbar-row"><span class="muted small">Stops the process; the instance folder (config, trade database) goes to <code>~/.openclaw/bots/trash</code>.</span><span class="spacer"></span><button type="button" class="kill-btn" id="bot-delete" ${b.dry_run ? '' : 'disabled title="Switch to dry-run first"'}>Delete bot</button></div></section>`);
    }
    $('bot-body').innerHTML = sections.join('');
    if (b.managed) loadLive(b);
    if (b.engine === 'freqtrade' || b.engine === 'web3') loadJournal(name, 100);
    if (focus === 'strategy' && $('bot-strategy-select')) $('bot-strategy-select').focus();
  }

  async function loadJournal(name, lines = 200) {
    const box = $('bot-journal');
    if (!box) return;
    box.textContent = 'Loading…';
    try {
      const d = await TS.api(`api/bots/${encodeURIComponent(name)}/journal?lines=${lines}`);
      box.textContent = d.lines.length ? d.lines.join('\n') : 'No journal lines.';
      box.scrollTop = box.scrollHeight;
    } catch (e) {
      box.textContent = `Journal not available: ${e.message}`;
    }
  }

  async function loadLive(b) {
    const box = $('bot-live');
    if (!box) return;
    try {
      const [checks, keys] = await Promise.all([TS.api(`api/bots/${encodeURIComponent(b.name)}/live-checks`), TS.api(`api/bots/${encodeURIComponent(b.name)}/exchange-keys`)]);
      const k = keys.keys;
      box.innerHTML = `
        ${b.dry_run ? '' : `<div class="live-banner"><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i> ${esc(b.name)} trades with real money since ${esc(fmtTime(b.live_since))} (approved by ${esc(String(b.live_approved_by || '').replace('trading-suite UI: ', ''))}).</div>`}
        <ul class="check-list">${checks.checks.map((c) => `<li class="${c.ok ? 'ok' : 'no'}"><i class="fa-solid ${c.ok ? 'fa-circle-check' : 'fa-circle-xmark'}" aria-hidden="true"></i> ${esc(c.text)}</li>`).join('')}</ul>
        <div class="live-forms">
          <form id="bot-capital-form" class="toolbar-row">
            <label class="inline-label">Capital limit<input name="amount" type="number" min="1" step="any" value="${esc(b.capital_limit ?? '')}" class="small-input" required></label>
            <button type="submit" class="btn-secondary">Save</button>
          </form>
          <form id="bot-keys-form" class="keys-form" autocomplete="off">
            <div class="muted small">Exchange API keys: ${k.configured ? `<b>set</b> (${esc(k.hint)})` : 'not set'}. Use trade-only keys without withdrawal rights, limited to this server's IP if the exchange allows it. The values are written to <code>~/.openclaw/credentials/bots/${esc(b.name)}.env</code> (0600) and never shown again.</div>
            <div class="toolbar-row">
              <input name="key" placeholder="API key" autocomplete="off" spellcheck="false" required>
              <input name="secret" type="password" placeholder="API secret" autocomplete="new-password" required>
              <input name="password" type="password" placeholder="Passphrase (OKX, KuCoin…)" autocomplete="new-password">
              <button type="submit" class="btn-secondary">${k.configured ? 'Replace keys' : 'Save keys'}</button>
              ${k.configured ? '<button type="button" class="btn-secondary" id="bot-keys-remove">Remove</button>' : ''}
            </div>
          </form>
        </div>
        <div class="toolbar-row">
          ${b.dry_run
            ? `<button type="button" class="kill-btn" id="bot-go-live" ${checks.ready ? '' : 'disabled'}><i class="fa-solid fa-sack-dollar" aria-hidden="true"></i> Go live</button><span class="muted small">${checks.ready ? 'Every check passes.' : 'Every check has to pass first.'}</span>`
            : '<button type="button" class="btn-buy" id="bot-go-dry"><i class="fa-solid fa-shield" aria-hidden="true"></i> Back to dry-run</button><span class="muted small">Restarts the bot in dry-run with its dry-run trade database; close open live positions on the exchange yourself if needed.</span>'}
        </div>`;
    } catch (e) {
      box.innerHTML = `<div class="form-error">${esc(e.message)}</div>`;
    }
  }

  $('bot-body').addEventListener('click', async (e) => {
    const name = ST.botName;
    if (!name) return;
    const doBtn = e.target.closest('[data-bot-do]');
    if (doBtn) return botAction(name, doBtn.dataset.botDo);
    if (e.target.closest('#bot-journal-load')) return loadJournal(name, 200);
    if (e.target.closest('#bot-strategy-apply')) {
      const strategy = $('bot-strategy-select').value;
      const bot = ST.bots.find((x) => x.name === name) || {};
      if (!strategy || strategy === bot.strategy) return toast(name, 'Choose another strategy first', 'info');
      const ok = await confirmAction({ title: `Switch ${name} to ${strategy}?`, text: 'The config file is changed (the previous one is kept in <code>~/.openclaw/bots/config-backups</code>) and the bot reloads it. If the bot does not come back with the new strategy, the previous config is put back.', ok: 'Switch' });
      if (!ok) return;
      const btn = $('bot-strategy-apply');
      btn.disabled = true;
      btn.textContent = 'Switching…';
      try {
        const r = await TS.apiSend('POST', `api/bots/${encodeURIComponent(name)}/strategy`, { strategy });
        toast(name, `${r.from || '-'} → ${r.to}${r.running ? '' : ' (applies when the bot starts)'}`, 'success');
      } catch (err) {
        toast(`${name}: strategy not switched`, err.message, 'error');
      }
      loadBots();
      return openBot(name);
    }
    if (e.target.closest('#bot-delete')) {
      const typed = await confirmAction({ title: `Delete ${name}?`, text: 'The process stops and the bot is removed from the suite. Its folder and credentials are moved to trash folders, not deleted.', ok: 'Delete', danger: true, typed: name });
      if (!typed) return;
      try {
        await TS.apiSend('DELETE', `api/bots/${encodeURIComponent(name)}`, { confirm: typed });
        toast(name, 'deleted (kept in the trash folder)', 'success');
        closeModal('bot-modal');
      } catch (err) {
        toast(`${name}: not deleted`, err.message, 'error');
      }
      return loadBots();
    }
    if (e.target.closest('#bot-keys-remove')) {
      const ok = await confirmAction({ title: 'Remove the exchange keys?', text: `The keys are removed from ${esc(name)}'s credentials file.`, ok: 'Remove', danger: true });
      if (!ok) return;
      await TS.apiSend('DELETE', `api/bots/${encodeURIComponent(name)}/exchange-keys`).catch(fail('Keys not removed'));
      return openBot(name);
    }
    if (e.target.closest('#bot-go-live')) {
      const bot = ST.bots.find((x) => x.name === name) || {};
      const typed = await confirmAction({
        title: `${name}: trade with real money?`,
        text: `The bot restarts <b>live</b> on ${esc(bot.exchange || 'the exchange')} with its strategy <b>${esc(bot.strategy || '')}</b>, using at most the capital limit. It keeps a separate live trade database. The kill switch pauses it like every other bot.`,
        ok: 'Go live',
        danger: true,
        typed: `LIVE ${name}`,
      });
      if (!typed) return;
      try {
        await TS.apiSend('POST', `api/bots/${encodeURIComponent(name)}/live`, { confirm: typed });
        toast(name, 'now trading live', 'error');
      } catch (err) {
        toast(`${name}: not switched to live`, err.message, 'error');
      }
      loadBots();
      return openBot(name);
    }
    if (e.target.closest('#bot-go-dry')) {
      const ok = await confirmAction({ title: `${name} back to dry-run?`, text: 'The bot restarts in dry-run. Positions it opened live stay on the exchange; close them there if needed.', ok: 'Back to dry-run' });
      if (!ok) return;
      await TS.apiSend('POST', `api/bots/${encodeURIComponent(name)}/dry-run`).then(() => toast(name, 'back in dry-run', 'success'), fail('Not switched'));
      loadBots();
      return openBot(name);
    }
  });

  $('bot-body').addEventListener('submit', async (e) => {
    const name = ST.botName;
    e.preventDefault();
    const f = e.target;
    if (f.id === 'bot-edit-form') {
      const v = Object.fromEntries(new FormData(f));
      const body = { pairs: splitPairs(v.pairs), timeframe: v.timeframe || null, description: v.description || null };
      for (const k of ['stake_amount', 'max_open_trades', 'dry_run_wallet']) if (v[k] !== '') body[k] = Number(v[k]);
      try {
        const r = await TS.apiSend('PATCH', `api/bots/${encodeURIComponent(name)}`, body);
        toast(name, r.reloaded ? 'saved and reloaded' : 'saved; applies when the process starts', 'success');
        loadBots();
        openBot(name);
      } catch (err) {
        toast(`${name}: not saved`, err.message, 'error');
      }
    }
    if (f.id === 'bot-capital-form') {
      await TS.apiSend('PUT', `api/bots/${encodeURIComponent(name)}/capital-limit`, { amount: Number(f.amount.value) }).then(() => toast(name, 'capital limit saved', 'success'), fail('Not saved'));
      openBot(name);
    }
    if (f.id === 'bot-keys-form') {
      const body = { key: f.key.value.trim(), secret: f.secret.value.trim(), password: f.password.value.trim() || null };
      f.secret.value = '';
      f.password.value = '';
      try {
        const r = await TS.apiSend('PUT', `api/bots/${encodeURIComponent(name)}/exchange-keys`, body);
        f.key.value = '';
        toast(name, `exchange keys saved (${r.keys.hint})`, 'success');
        openBot(name);
      } catch (err) {
        toast(`${name}: keys not saved`, err.message, 'error');
      }
    }
  });

  const splitPairs = (text) =>
    String(text || '')
      .split(/[\s,;]+/)
      .map((p) => p.trim().toUpperCase())
      .filter(Boolean);

  // ---- new bot --------------------------------------------------------------------------------
  async function openNewBot(strategy) {
    await Promise.all([loadLibrary({ quiet: true }), ST.bots.length ? null : loadBots()]);
    const f = $('newbot-form');
    const ok = ST.lib.library.filter((s) => s.check_status === 'ok');
    f.strategy.innerHTML = ok.length ? ok.map((s) => `<option value="${esc(s.name)}">${esc(s.name)}${s.timeframe ? ` (${esc(s.timeframe)})` : ''}</option>`).join('') : '<option value="">No checked strategy yet</option>';
    if (strategy) f.strategy.value = strategy;
    f.exchange.innerHTML = ST.exchanges.map((x) => `<option>${esc(x)}</option>`).join('');
    f.timeframe.innerHTML = `<option value="">Strategy default</option>${TIMEFRAMES.map((t) => `<option>${t}</option>`).join('')}`;
    try {
      const lists = (await TS.api('api/watchlists')).watchlists;
      f.fromList.innerHTML = `<option value="">-</option>${lists.map((w) => `<option value="${w.id}">${esc(w.name)}</option>`).join('')}`;
    } catch (e) {}
    const managed = ST.bots.filter((b) => b.managed).length;
    $('newbot-hint').innerHTML = `${ok.length ? '' : 'Copy a template in <b>Strategy library</b> and run its check first. '}Managed bots: ${managed} of 3 (each needs about 300-450 MB of memory). The bot gets its own config, API port, generated API credentials and SQLite trade database, and starts in <b>dry-run</b>.`;
    $('newbot-error').classList.add('hidden');
    fillPairsList();
    openModal('newbot-modal');
    setTimeout(() => f.name.focus(), 0);
  }

  $('newbot-form').fromList.addEventListener('change', async (e) => {
    const id = e.target.value;
    if (!id) return;
    try {
      const items = (await TS.api(`api/watchlists/${id}/items`)).items || [];
      const pairs = items.map((i) => i.symbol).filter((s) => /^[A-Z0-9]+\/[A-Z0-9]+$/.test(s));
      $('newbot-form').pairs.value = pairs.slice(0, 30).join(', ');
      if (!pairs.length) toast('No exchange pairs', 'That list has no BASE/QUOTE pairs (DEX pools and stocks are skipped).', 'info');
    } catch (err) {
      toast('List not loaded', err.message, 'error');
    }
  });

  $('newbot-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const v = Object.fromEntries(new FormData(f));
    const body = {
      name: v.name.trim().toLowerCase(),
      strategy: v.strategy,
      exchange: v.exchange,
      trading_mode: v.trading_mode,
      pairs: splitPairs(v.pairs),
      timeframe: v.timeframe || null,
      stake_amount: Number(v.stake_amount),
      max_open_trades: Number(v.max_open_trades),
      dry_run_wallet: Number(v.dry_run_wallet),
      description: v.description || null,
      start: f.start.checked,
    };
    const btn = f.querySelector('[type=submit]');
    btn.disabled = true;
    try {
      await TS.apiSend('POST', 'api/bots', body);
      closeModal('newbot-modal');
      toast(body.name, body.start ? 'created and starting in dry-run' : 'created (not started)', 'success');
      setPane('bots');
      setTimeout(loadBots, body.start ? 6000 : 500);
    } catch (err) {
      $('newbot-error').textContent = err.message;
      $('newbot-error').classList.remove('hidden');
    } finally {
      btn.disabled = false;
    }
  });
  $('btn-new-bot').addEventListener('click', () => openNewBot());

  // ---- library ---------------------------------------------------------------------------------
  async function loadLibrary({ quiet = false } = {}) {
    try {
      ST.lib = await TS.api('api/strategies');
      if (!quiet || ST.pane === 'library') renderLibrary();
    } catch (e) {
      if (!quiet) $('library-tbody').innerHTML = `<tr><td colspan="7" class="form-error">${esc(e.message)}</td></tr>`;
    }
    return ST.lib;
  }

  function checkPill(s) {
    const cls = { ok: 'pill-green', failed: 'pill-red', unchecked: 'pill-gray' }[s.check_status] || 'pill-gray';
    return `<span class="pill ${cls}" title="${esc(s.check_message || '')}">${esc(s.check_status)}</span>`;
  }

  function renderLibrary() {
    const lib = ST.lib.library;
    $('library-tbody').innerHTML = lib.length
      ? lib
          .map((s) => {
            const bt = s.last_backtest;
            const btCell = bt
              ? bt.status === 'done'
                ? `<button type="button" class="link-btn" data-bt-open="${bt.id}"><span class="${changeClass(bt.profit_total)}">${ratioPct(bt.profit_total)}</span> · ${esc(bt.trades)} trades</button>`
                : `<span class="muted">#${bt.id} ${esc(bt.status)}</span>`
              : '<span class="muted">-</span>';
            return `<tr data-strategy="${esc(s.name)}">
              <td><b>${esc(s.name)}</b>${s.description ? `<div class="muted small">${esc(s.description)}</div>` : ''}</td>
              <td><span class="pill pill-gray">${esc(s.origin)}</span></td>
              <td>${esc(s.timeframe || '-')}</td>
              <td>${checkPill(s)}</td>
              <td>${btCell}</td>
              <td>${(s.used_by || []).map((b) => `<span class="chip">${esc(b)}</span>`).join(' ') || '<span class="muted">-</span>'}</td>
              <td class="nowrap r">
                <button type="button" class="icon-btn" data-lib="edit" title="Edit" aria-label="Edit ${esc(s.name)}"><i class="fa-solid fa-code" aria-hidden="true"></i></button>
                <button type="button" class="icon-btn" data-lib="check" title="Run the check" aria-label="Check ${esc(s.name)}"><i class="fa-solid fa-shield-halved" aria-hidden="true"></i></button>
                <button type="button" class="icon-btn" data-lib="backtest" title="Backtest" aria-label="Backtest ${esc(s.name)}"><i class="fa-solid fa-flask" aria-hidden="true"></i></button>
                <button type="button" class="icon-btn" data-lib="bot" title="New bot with this strategy" aria-label="New bot with ${esc(s.name)}" ${s.check_status === 'ok' ? '' : 'disabled'}><i class="fa-solid fa-robot" aria-hidden="true"></i></button>
                <button type="button" class="icon-btn" data-lib="delete" title="Delete" aria-label="Delete ${esc(s.name)}"><i class="fa-solid fa-trash" aria-hidden="true"></i></button>
              </td></tr>`;
          })
          .join('')
      : '<tr><td colspan="7" class="muted">The library is empty: copy a template below, upload a .py file or start a new strategy.</td></tr>';
    const others = [...ST.lib.templates.map((t) => ({ ...t, kind: 'template' })), ...ST.lib.mainFiles.map((t) => ({ ...t, kind: 'main' }))];
    $('templates-tbody').innerHTML = others.length
      ? others
          .map(
            (t) => `<tr><td><b>${esc(t.name)}</b></td><td><span class="pill ${t.kind === 'template' ? 'pill-purple' : 'pill-blue'}">${t.kind === 'template' ? 'template' : 'main bot file'}</span></td><td class="muted small">${esc(t.description || '')}</td>
              <td class="r"><button type="button" class="pill pill-green" data-import="${esc(t.name)}" data-kind="${t.kind}"><i class="fa-solid fa-copy" aria-hidden="true"></i> Copy to library</button></td></tr>`
          )
          .join('')
      : '<tr><td colspan="4" class="muted">Everything is in the library.</td></tr>';
  }

  async function runCheck(name, { out } = {}) {
    toast(name, 'check started (takes up to a minute)', 'info');
    try {
      const r = await TS.apiSend('POST', `api/strategies/${encodeURIComponent(name)}/check`);
      toast(name, r.result.message, r.result.ok ? 'success' : 'error');
      if (out) renderCheck(r.result);
      return r.result;
    } catch (e) {
      toast(`${name}: check failed to run`, e.message, 'error');
      return null;
    } finally {
      loadLibrary({ quiet: ST.pane !== 'library' });
    }
  }

  $('library-tbody').addEventListener('click', async (e) => {
    const bt = e.target.closest('[data-bt-open]');
    if (bt) {
      setPane('backtests');
      return openBacktest(Number(bt.dataset.btOpen));
    }
    const b = e.target.closest('[data-lib]');
    if (!b) return;
    const name = b.closest('[data-strategy]').dataset.strategy;
    const act = b.dataset.lib;
    if (act === 'edit') return editStrategy(name);
    if (act === 'check') {
      b.disabled = true;
      await runCheck(name);
      b.disabled = false;
    }
    if (act === 'backtest') {
      setPane('backtests');
      return prefillBacktest(name);
    }
    if (act === 'bot') return openNewBot(name);
    if (act === 'delete') {
      const ok = await confirmAction({ title: `Delete ${name}?`, text: 'The strategy leaves the library; its file goes to <code>~/.openclaw/bots/trash</code>. Bots that use it have to be switched first.', ok: 'Delete', danger: true });
      if (!ok) return;
      await TS.apiSend('DELETE', `api/strategies/${encodeURIComponent(name)}`).then(() => toast(name, 'deleted', 'success'), fail('Not deleted'));
      loadLibrary();
    }
  });

  $('templates-tbody').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-import]');
    if (!b) return;
    b.disabled = true;
    try {
      await TS.apiSend('POST', 'api/strategies/import', { kind: b.dataset.kind, name: b.dataset.import });
      toast(b.dataset.import, 'copied to the library; running its check', 'success');
      await loadLibrary();
      runCheck(b.dataset.import);
    } catch (err) {
      toast('Not copied', err.message, 'error');
      b.disabled = false;
    }
  });

  // Upload: the class in the file names the strategy.
  $('strategy-upload').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > 200 * 1024) return toast('File too large', 'Strategies are limited to 200 KB', 'error');
    const source = await file.text();
    const classes = [...source.matchAll(/^class\s+([A-Za-z_]\w*)\s*\(\s*IStrategy\s*\)/gm)].map((m) => m[1]);
    if (classes.length !== 1) return toast('Not uploaded', classes.length ? `The file defines several strategies (${classes.join(', ')}); upload one per file` : 'No "class Name(IStrategy):" in the file', 'error');
    const name = classes[0];
    if (ST.lib.library.some((s) => s.name === name)) {
      const ok = await confirmAction({ title: `Replace ${name}?`, text: 'The upload becomes a new version of the strategy in the library (earlier versions stay available in the editor).', ok: 'Replace' });
      if (!ok) return;
    }
    try {
      await TS.apiSend('PUT', `api/strategies/${encodeURIComponent(name)}`, { source });
      toast(name, 'uploaded; running its check', 'success');
      await loadLibrary();
      runCheck(name);
    } catch (err) {
      toast('Not uploaded', err.message, 'error');
    }
  });

  // ---- new strategy and editor ------------------------------------------------------------------
  const BLANK = (name) => `"""${name}: describe the idea here."""
from datetime import datetime
from typing import Optional

import talib.abstract as ta
from freqtrade.strategy import IStrategy
from pandas import DataFrame

from ts_guard import entries_allowed


class ${name}(IStrategy):
    INTERFACE_VERSION = 3
    timeframe = "15m"
    can_short = False
    stoploss = -0.05
    minimal_roi = {"0": 0.05}
    process_only_new_candles = True
    startup_candle_count = 50

    def populate_indicators(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        dataframe["rsi"] = ta.RSI(dataframe, timeperiod=14)
        return dataframe

    def populate_entry_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        dataframe.loc[(dataframe["rsi"] < 30) & (dataframe["volume"] > 0), "enter_long"] = 1
        return dataframe

    def populate_exit_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        dataframe.loc[dataframe["rsi"] > 70, "exit_long"] = 1
        return dataframe

    def confirm_trade_entry(self, pair: str, order_type: str, amount: float, rate: float, time_in_force: str,
                            current_time: datetime, entry_tag: Optional[str], side: str, **kwargs) -> bool:
        # Kill switch: no new entries while trading is halted in the trading suite.
        return entries_allowed(pair)
`;

  async function openNewStrategy() {
    await loadLibrary({ quiet: true });
    const f = $('newstrat-form');
    f.from.innerHTML = [
      '<option value="blank">Blank (RSI example)</option>',
      ...[...ST.lib.templates, ...ST.lib.library.filter((s) => s.origin === 'template')].map((t) => `<option value="tpl:${esc(t.name)}">Template: ${esc(t.name)}</option>`),
      ...ST.lib.library.map((s) => `<option value="lib:${esc(s.name)}">Copy of ${esc(s.name)}</option>`),
    ].join('');
    f.name.value = '';
    $('newstrat-error').classList.add('hidden');
    openModal('newstrat-modal');
    setTimeout(() => f.name.focus(), 0);
  }

  $('newstrat-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const name = f.name.value.trim();
    const err = (m) => {
      $('newstrat-error').textContent = m;
      $('newstrat-error').classList.remove('hidden');
    };
    if (!/^[A-Za-z_][A-Za-z0-9_]{2,60}$/.test(name)) return err('The name must be a Python class name (letters, digits, _).');
    if (ST.lib.library.some((s) => s.name === name)) return err(`${name} is already in the library; open it from there.`);
    let source;
    try {
      const from = f.from.value;
      if (from === 'blank') source = BLANK(name);
      else {
        const [kind, src] = from.split(':');
        const d = kind === 'tpl' ? await TS.api(`api/strategy-templates/${encodeURIComponent(src)}`).catch(() => TS.api(`api/strategies/${encodeURIComponent(src)}`).then((x) => x.strategy)) : (await TS.api(`api/strategies/${encodeURIComponent(src)}`)).strategy;
        source = d.source.replace(new RegExp(`^class\\s+${src}\\s*\\(\\s*IStrategy\\s*\\)`, 'm'), `class ${name}(IStrategy)`);
      }
    } catch (x) {
      return err(x.message);
    }
    closeModal('newstrat-modal');
    if (!(await leaveEditor())) return;
    ST.editing = { name, isNew: true, sha: null };
    setPane('editor');
    setEditorValue(source, true);
    fillEditorSelect();
    $('editor-versions').innerHTML = '<option>Not saved yet</option>';
  });
  $('btn-new-strategy').addEventListener('click', openNewStrategy);

  function ensureEditor() {
    if (ST.editor) return ST.editor;
    ST.editor = CodeMirror($('editor-box'), {
      value: '',
      mode: 'python',
      lineNumbers: true,
      indentUnit: 4,
      tabSize: 4,
      indentWithTabs: false,
      lineWrapping: false,
      theme: 'ts',
      extraKeys: {
        Tab: (cm) => (cm.somethingSelected() ? cm.indentSelection('add') : cm.replaceSelection('    ', 'end')),
        'Shift-Tab': (cm) => cm.indentSelection('subtract'),
        'Ctrl-S': () => saveEditor(false),
        'Cmd-S': () => saveEditor(false),
      },
    });
    ST.editor.on('change', () => {
      if (ST.settingValue) return;
      ST.dirty = true;
      editorState();
    });
    return ST.editor;
  }

  function setEditorValue(source, dirty = false) {
    ensureEditor();
    ST.settingValue = true;
    ST.editor.setValue(source);
    ST.settingValue = false;
    ST.editor.clearHistory();
    ST.dirty = dirty;
    $('editor-check').classList.add('hidden');
    editorState();
    setTimeout(() => ST.editor.refresh(), 0);
  }

  function editorState() {
    const e = ST.editing;
    const s = e && ST.lib.library.find((x) => x.name === e.name);
    $('editor-state').innerHTML = !e
      ? 'Choose a strategy, or start a new one in the library.'
      : `${ST.dirty ? '<span class="warn">unsaved changes</span>' : e.isNew ? '<span class="warn">not saved yet</span>' : 'saved'}${s ? ` · check ${checkPill(s)}` : ''}`;
    for (const id of ['editor-save', 'editor-save-check', 'editor-backtest']) $(id).disabled = !e;
  }

  function fillEditorSelect() {
    const names = ST.lib.library.map((s) => s.name);
    if (ST.editing && ST.editing.isNew && !names.includes(ST.editing.name)) names.unshift(ST.editing.name);
    $('editor-select').innerHTML = `<option value="">Choose a strategy…</option>${names.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join('')}`;
    $('editor-select').value = ST.editing ? ST.editing.name : '';
  }

  async function leaveEditor() {
    if (!ST.dirty) return true;
    return confirmAction({ title: 'Discard the unsaved changes?', text: `${esc(ST.editing ? ST.editing.name : 'The strategy')} has changes that are not saved.`, ok: 'Discard', danger: true });
  }

  async function openEditorPane() {
    ensureEditor();
    await loadLibrary({ quiet: true });
    fillEditorSelect();
    editorState();
    if (!ST.editing && ST.lib.library.length) return editStrategy(ST.lib.library[0].name, { skipConfirm: true });
    setTimeout(() => ST.editor.refresh(), 0);
  }

  async function editStrategy(name, { skipConfirm = false, keepPane = false } = {}) {
    if (!skipConfirm && !(await leaveEditor())) {
      fillEditorSelect();
      return;
    }
    if (!keepPane && ST.pane !== 'editor') {
      ST.editing = { name, isNew: false };
      ST.dirty = false;
      setPane('editor');
    }
    try {
      const [s, v] = await Promise.all([TS.api(`api/strategies/${encodeURIComponent(name)}`), TS.api(`api/strategies/${encodeURIComponent(name)}/versions`)]);
      ST.editing = { name, isNew: false, sha: s.strategy.sha };
      setEditorValue(s.strategy.source);
      fillEditorSelect();
      $('editor-versions').innerHTML = v.versions.map((x, i) => `<option value="${x.id}">${i === 0 ? 'Current' : `Version ${x.id}`} · ${esc(fmtTime(x.created_at))} · ${esc(x.sha.slice(0, 7))}</option>`).join('');
      if (s.strategy.check_detail) renderCheck(s.strategy.check_detail);
    } catch (e) {
      toast(`${name} not loaded`, e.message, 'error');
    }
  }

  $('editor-select').addEventListener('change', (e) => e.target.value && editStrategy(e.target.value, { keepPane: true }));
  $('editor-versions').addEventListener('change', async (e) => {
    if (!ST.editing || ST.editing.isNew) return;
    try {
      const v = (await TS.api(`api/strategies/${encodeURIComponent(ST.editing.name)}/versions/${e.target.value}`)).version;
      setEditorValue(v.source, v.sha !== ST.editing.sha);
      if (v.sha !== ST.editing.sha) toast(ST.editing.name, `version ${v.id} is in the editor; Save makes it the current one`, 'info');
    } catch (err) {
      toast('Version not loaded', err.message, 'error');
    }
  });

  async function saveEditor(check) {
    const e = ST.editing;
    if (!e) return;
    const source = ST.editor.getValue();
    try {
      const r = await TS.apiSend('PUT', `api/strategies/${encodeURIComponent(e.name)}`, { source });
      ST.dirty = false;
      ST.editing = { name: e.name, isNew: false, sha: r.sha };
      if (!check) toast(e.name, r.changed ? (r.created ? 'saved to the library' : 'saved as a new version; run the check before bots use it') : 'no changes', 'success');
      await loadLibrary({ quiet: true });
      fillEditorSelect();
      editorState();
      if (r.changed) {
        const v = await TS.api(`api/strategies/${encodeURIComponent(e.name)}/versions`);
        $('editor-versions').innerHTML = v.versions.map((x, i) => `<option value="${x.id}">${i === 0 ? 'Current' : `Version ${x.id}`} · ${esc(fmtTime(x.created_at))} · ${esc(x.sha.slice(0, 7))}</option>`).join('');
      }
      if (check) {
        $('editor-check').classList.remove('hidden');
        $('editor-check').innerHTML = '<div class="muted"><i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i> Checking: static rules, loading through Freqtrade, a run on sample candles…</div>';
        await runCheck(e.name, { out: true });
        await loadLibrary({ quiet: true });
        editorState();
      }
    } catch (err) {
      toast(`${e.name}: not saved`, err.message, 'error');
    }
  }
  $('editor-save').addEventListener('click', () => saveEditor(false));
  $('editor-save-check').addEventListener('click', () => saveEditor(true));
  $('editor-backtest').addEventListener('click', () => {
    if (!ST.editing) return;
    const name = ST.editing.name;
    setPane('backtests');
    prefillBacktest(name);
  });

  function renderCheck(r) {
    const box = $('editor-check');
    box.classList.remove('hidden');
    const sig = r.signals ? Object.entries(r.signals).map(([k, n]) => `${k} ${n}`).join(' · ') : null;
    box.innerHTML = `<div class="check-head ${r.ok ? 'ok' : 'no'}"><i class="fa-solid ${r.ok ? 'fa-circle-check' : 'fa-circle-xmark'}" aria-hidden="true"></i> ${esc(r.message || '')}</div>
      ${(r.errors || []).length ? `<ul class="check-list">${r.errors.map((x) => `<li class="no">${esc(x)}</li>`).join('')}</ul>` : ''}
      ${(r.warnings || []).length ? `<ul class="check-list">${r.warnings.map((x) => `<li class="warn">${esc(x)}</li>`).join('')}</ul>` : ''}
      <div class="muted small">${[r.timeframe && `timeframe ${r.timeframe}`, r.stoploss !== undefined && `stoploss ${r.stoploss}`, r.can_short !== undefined && (r.can_short ? 'can short' : 'long only'), r.startup_candle_count && `startup candles ${r.startup_candle_count}`, sig && `signals on sample data: ${sig}`].filter(Boolean).map(esc).join(' · ')}</div>`;
  }

  window.addEventListener('beforeunload', (e) => {
    if (ST.dirty) e.preventDefault();
  });

  // ---- backtests --------------------------------------------------------------------------------
  function fillPairsList() {
    const pairs = (TS.pairs || []).filter((p) => /^[A-Z0-9]+\/[A-Z0-9]+$/.test(p.symbol)).map((p) => p.symbol);
    $('bt-pairs').innerHTML = pairs.map((p) => `<option value="${esc(p)}">`).join('');
  }

  function fillBacktestForm() {
    const f = $('bt-form');
    const keep = f.strategy.value;
    const lib = ST.lib.library.filter((s) => s.check_status !== 'failed');
    f.strategy.innerHTML = [
      ...lib.map((s) => `<option value="${esc(s.name)}">${esc(s.name)}${s.check_status === 'ok' ? '' : ' (unchecked)'}</option>`),
      ...ST.lib.mainFiles.map((s) => `<option value="${esc(s.name)}">${esc(s.name)} (main bot file)</option>`),
    ].join('');
    if (keep) f.strategy.value = keep;
    if (!f.timeframe.options.length) f.timeframe.innerHTML = `<option value="">Strategy default</option>${TIMEFRAMES.map((t) => `<option>${t}</option>`).join('')}`;
    const ex = f.exchange.value;
    f.exchange.innerHTML = ST.exchanges.map((x) => `<option>${esc(x)}</option>`).join('');
    if (ex) f.exchange.value = ex;
    if (!f.pairs.value) f.pairs.value = TS.activeSymbol && /^[A-Z0-9]+\/[A-Z0-9]+$/.test(TS.activeSymbol) ? TS.activeSymbol : 'BTC/USDT, ETH/USDT';
    const filter = $('bt-filter').value;
    $('bt-filter').innerHTML = `<option value="">All</option>${[...new Set([...ST.lib.library.map((s) => s.name), ...ST.backtests.map((b) => b.strategy)])].map((n) => `<option>${esc(n)}</option>`).join('')}`;
    $('bt-filter').value = filter;
    fillPairsList();
  }

  async function prefillBacktest(name, { pairs, timeframe } = {}) {
    await loadLibrary({ quiet: true });
    fillBacktestForm();
    $('bt-form').strategy.value = name;
    if (pairs && pairs.length) $('bt-form').pairs.value = pairs.join(', ');
    if (timeframe !== undefined) $('bt-form').timeframe.value = timeframe || '';
    $('bt-form').pairs.focus();
  }

  const statusPill = (b) => {
    const cls = { queued: 'pill-gray', running: 'pill-blue', done: 'pill-green', failed: 'pill-red', cancelled: 'pill-gray' }[b.status];
    return `<span class="pill ${cls}" title="${esc(b.error || '')}">${b.status === 'running' ? '<i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i> ' : ''}${esc(b.status)}</span>`;
  };

  async function loadBacktests() {
    try {
      const filter = $('bt-filter').value;
      const d = await TS.api(`api/backtests${filter ? `?strategy=${encodeURIComponent(filter)}` : ''}`);
      ST.backtests = d.backtests;
      if (d.exchanges) ST.exchanges = d.exchanges;
      renderBacktests();
    } catch (e) {
      $('bt-tbody').innerHTML = `<tr><td colspan="10" class="form-error">${esc(e.message)}</td></tr>`;
    }
  }

  function renderBacktests() {
    $('bt-tbody').innerHTML = ST.backtests.length
      ? ST.backtests
          .map((b) => {
            const s = b.summary || {};
            const p = b.params || {};
            return `<tr data-bt="${b.id}" class="${b.id === ST.detailId ? 'selected' : ''}">
              <td>${b.id}</td><td>${esc(b.strategy)}</td>
              <td class="small">${esc((p.pairs || []).slice(0, 3).join(', '))}${(p.pairs || []).length > 3 ? ` +${p.pairs.length - 3}` : ''}</td>
              <td class="small nowrap">${esc(p.days)}d · ${esc(s.timeframe || p.timeframe || '')} · ${esc(p.exchange)}</td>
              <td>${statusPill(b)}</td>
              <td class="r">${s.total_trades ?? '-'}</td>
              <td class="r ${changeClass(s.profit_total)}">${ratioPct(s.profit_total)}</td>
              <td class="r">${plainPct(s.max_drawdown_account)}</td>
              <td class="r">${plainPct(s.winrate)}</td>
              <td class="r nowrap">${['queued', 'running'].includes(b.status) ? `<button type="button" class="icon-btn" data-bt-cancel="${b.id}" title="Cancel" aria-label="Cancel backtest ${b.id}"><i class="fa-solid fa-ban" aria-hidden="true"></i></button>` : ''}${b.status === 'done' || b.status === 'failed' ? `<button type="button" class="icon-btn" data-bt-view="${b.id}" title="Results" aria-label="Results of backtest ${b.id}"><i class="fa-solid fa-chart-area" aria-hidden="true"></i></button>` : ''}</td>
            </tr>`;
          })
          .join('')
      : '<tr><td colspan="10" class="muted">No backtests yet.</td></tr>';
  }

  $('bt-tbody').addEventListener('click', async (e) => {
    const c = e.target.closest('[data-bt-cancel]');
    if (c) {
      await TS.apiSend('POST', `api/backtests/${c.dataset.btCancel}/cancel`).then(() => toast('Backtest', 'cancelled', 'success'), fail('Not cancelled'));
      return loadBacktests();
    }
    const row = e.target.closest('[data-bt]');
    if (row) openBacktest(Number(row.dataset.bt));
  });
  $('bt-filter').addEventListener('change', loadBacktests);

  $('bt-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const v = Object.fromEntries(new FormData(f));
    const body = {
      strategy: v.strategy,
      pairs: splitPairs(v.pairs),
      timeframe: v.timeframe || null,
      days: Number(v.days),
      exchange: v.exchange,
      trading_mode: v.trading_mode,
      stake_amount: Number(v.stake_amount),
      max_open_trades: Number(v.max_open_trades),
      wallet: Number(v.wallet),
    };
    try {
      const r = await TS.apiSend('POST', 'api/backtests', body);
      toast(`Backtest #${r.backtest.id}`, 'queued', 'success');
      loadBacktests();
    } catch (err) {
      toast('Backtest not queued', err.message, 'error');
    }
  });

  async function openBacktest(id) {
    ST.detailId = id;
    renderBacktests();
    const box = $('bt-detail');
    box.classList.remove('hidden');
    $('bt-detail-title').textContent = `Backtest #${id}`;
    $('bt-kpis').innerHTML = '<div class="skeleton sk-line"></div>';
    let b;
    try {
      b = (await TS.api(`api/backtests/${id}`)).backtest;
    } catch (e) {
      $('bt-kpis').innerHTML = `<div class="form-error">${esc(e.message)}</div>`;
      return;
    }
    const s = b.summary || {};
    const p = b.params || {};
    $('bt-detail-title').innerHTML = `<i class="fa-solid fa-flask" aria-hidden="true"></i> #${b.id} ${esc(b.strategy)} ${statusPill(b)} <span class="muted small">${esc((p.pairs || []).join(', '))} · ${esc(s.backtest_start ? `${String(s.backtest_start).slice(0, 10)} → ${String(s.backtest_end || '').slice(0, 10)}` : `${p.days} days`)} · ${esc(p.exchange)} ${esc(p.trading_mode)}</span>`;
    if (b.status !== 'done') {
      $('bt-kpis').innerHTML = b.error ? `<div class="form-error">${esc(b.error)}</div>` : `<div class="muted">${esc(b.status)}</div>`;
      $('bt-equity').innerHTML = '';
      ['bt-pairs-tbody', 'bt-exits-tbody', 'bt-trades-tbody'].forEach((x) => ($(x).innerHTML = ''));
      $('bt-log').textContent = b.log_tail || '';
      box.querySelector('.bt-log').open = !!b.error;
      box.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    const cur = s.stake_currency || '';
    $('bt-kpis').innerHTML = [
      kv('Profit', `<span class="${changeClass(s.profit_total)}">${ratioPct(s.profit_total)}</span> · ${fmtNum(s.profit_total_abs)} ${esc(cur)}`),
      kv('Trades', `${s.total_trades} (${s.wins}/${s.draws}/${s.losses})`),
      kv('Win rate', plainPct(s.winrate)),
      kv('Max drawdown', `${plainPct(s.max_drawdown_account)} · ${fmtNum(s.max_drawdown_abs)} ${esc(cur)}`),
      kv('Profit factor', fmtNum(s.profit_factor)),
      kv('Sharpe / Sortino', `${fmtNum(s.sharpe)} / ${fmtNum(s.sortino)}`),
      kv('CAGR', plainPct(s.cagr)),
      kv('Market change', ratioPct(s.market_change)),
      kv('Avg holding', esc(s.holding_avg || '-')),
      kv('Balance', `${fmtNum(s.starting_balance)} → ${fmtNum(s.final_balance)} ${esc(cur)}`),
      kv('Best / worst pair', `${esc((s.best_pair && s.best_pair.key) || '-')} / ${esc((s.worst_pair && s.worst_pair.key) || '-')}`),
      kv('Strategy version', `<code>${esc((b.strategy_sha || 'main bot file').slice(0, 10))}</code>`),
    ].join('');
    $('bt-pairs-tbody').innerHTML = (b.per_pair || [])
      .map((r) => `<tr><td>${esc(r.key)}</td><td class="r">${r.trades}</td><td class="r ${changeClass(r.profit_total_pct)}">${fmtPct(r.profit_total_pct)}</td><td class="r">${plainPct(r.winrate)}</td><td class="r">${fmtPct(r.profit_mean_pct)}</td></tr>`)
      .join('');
    $('bt-exits-tbody').innerHTML = (s.exit_reasons || [])
      .map((r) => `<tr><td>${esc(r.key)}</td><td class="r">${r.trades}</td><td class="r ${changeClass(r.profit_total_abs)}">${fmtNum(r.profit_total_abs)}</td><td class="r">${plainPct(r.winrate)}</td></tr>`)
      .join('');
    const trades = (b.trades || []).slice().sort((x, y) => String(x.close_date).localeCompare(String(y.close_date)));
    $('bt-trades-tbody').innerHTML = trades
      .slice(-300)
      .reverse()
      .map((t) => `<tr><td>${esc(t.pair)}${t.is_short ? ' <span class="pill pill-warn">short</span>' : ''}</td><td class="nowrap small">${esc(fmtTime(isoDate(t.open_date)))}</td><td class="nowrap small">${esc(fmtTime(isoDate(t.close_date)))}</td><td class="r ${changeClass(t.profit_ratio)}">${ratioPct(t.profit_ratio)}</td><td class="r">${fmtNum(t.profit_abs, 4)}</td><td class="small">${esc(t.exit_reason)}</td></tr>`)
      .join('');
    $('bt-log').textContent = b.log_tail || '';
    box.querySelector('.bt-log').open = false;
    drawEquity(s, trades);
    box.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  $('bt-detail-close').addEventListener('click', () => {
    $('bt-detail').classList.add('hidden');
    ST.detailId = null;
    renderBacktests();
  });

  const isoDate = (v) => String(v || '').replace(' ', 'T');

  function drawEquity(s, trades) {
    const el = $('bt-equity');
    if (ST.equity) {
      ST.equity.remove();
      ST.equity = null;
    }
    el.innerHTML = '';
    if (!trades.length || typeof LightweightCharts === 'undefined') return;
    const LC = LightweightCharts;
    const chart = LC.createChart(el, {
      autoSize: true,
      layout: { background: { type: 'solid', color: 'transparent' }, textColor: '#94a3b8', fontFamily: 'Inter Variable, sans-serif', attributionLogo: false },
      grid: { vertLines: { color: 'rgba(30,41,59,0.6)' }, horzLines: { color: 'rgba(30,41,59,0.6)' } },
      rightPriceScale: { borderColor: '#1e293b' },
      timeScale: { borderColor: '#1e293b', timeVisible: true },
      handleScroll: false,
      handleScale: false,
    });
    const start = Number(s.starting_balance) || 0;
    const series = chart.addSeries(LC.AreaSeries, { lineColor: '#38bdf8', topColor: 'rgba(56,189,248,0.25)', bottomColor: 'rgba(56,189,248,0.02)', lineWidth: 2, priceLineVisible: false });
    let balance = start;
    let last = 0;
    const points = [];
    const t0 = Math.floor(new Date(isoDate(s.backtest_start || trades[0].open_date)).getTime() / 1000);
    if (Number.isFinite(t0)) {
      points.push({ time: t0, value: start });
      last = t0;
    }
    for (const t of trades) {
      balance += Number(t.profit_abs) || 0;
      let time = Math.floor(new Date(isoDate(t.close_date)).getTime() / 1000);
      if (!Number.isFinite(time)) continue;
      if (time <= last) time = last + 1;
      last = time;
      points.push({ time, value: Number(balance.toFixed(4)) });
    }
    series.setData(points);
    series.createPriceLine({ price: start, color: '#64748b', lineWidth: 1, lineStyle: 2, axisLabelVisible: false, title: 'start' });
    chart.timeScale().fitContent();
    ST.equity = chart;
  }

  // ---- polling and commands ----------------------------------------------------------------------
  const visible = () => TS.activeTab === 'strategies' && !document.hidden && !$('view-trading').classList.contains('hidden');
  setInterval(() => visible() && ST.pane === 'bots' && loadBots(), 15000);
  setInterval(() => {
    if (!visible() || ST.pane !== 'backtests') return;
    if (ST.backtests.some((b) => ['queued', 'running'].includes(b.status))) {
      const before = new Map(ST.backtests.map((b) => [b.id, b.status]));
      loadBacktests().then(() => {
        const finished = ST.backtests.find((b) => before.get(b.id) && before.get(b.id) !== b.status && ['done', 'failed'].includes(b.status));
        if (finished) {
          toast(`Backtest #${finished.id}`, finished.status === 'done' ? `${finished.summary.total_trades} trades, ${(Number(finished.summary.profit_total) * 100).toFixed(2)}%` : finished.error, finished.status === 'done' ? 'success' : 'error');
          if (finished.status === 'done' && (!ST.detailId || ST.detailId === finished.id)) openBacktest(finished.id);
          loadLibrary({ quiet: true });
        }
      });
    }
  }, 5000);

  TS.commands = TS.commands || [];
  TS.commands.push(
    { label: 'Strategies: bots', icon: 'fa-robot', keywords: 'bots dry-run live', run: () => (TS.showTab('strategies'), setPane('bots')) },
    { label: 'Strategies: new bot', icon: 'fa-plus', keywords: 'create deploy bot', run: () => (TS.showTab('strategies'), setPane('bots'), openNewBot()) },
    { label: 'Strategies: library', icon: 'fa-book', keywords: 'strategy templates', run: () => (TS.showTab('strategies'), setPane('library')) },
    { label: 'Strategies: editor', icon: 'fa-code', keywords: 'python code edit', run: () => (TS.showTab('strategies'), setPane('editor')) },
    { label: 'Strategies: new strategy', icon: 'fa-plus', keywords: 'python create', run: () => (TS.showTab('strategies'), setPane('library'), openNewStrategy()) },
    { label: 'Backtests', icon: 'fa-flask', keywords: 'backtest results', run: () => (TS.showTab('strategies'), setPane('backtests')) }
  );
  TS.strategies = { loadBots, openBot, openNewBot, loadLibrary, prefillBacktest, openBacktest, setPane, editStrategy: (name) => editStrategy(name) };
})();
