// Watchlists (several named lists, each with its own columns and sort order), the search
// and command palette (Ctrl+K), and the data sources dialog of an instrument.

(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (v) => escapeHtml(v);
  const { fmtPrice, fmtPct, fmtCompact, ago } = TS.fmt;
  const { storage, changeClass, CATEGORY_LABELS, CATEGORY_PILL } = TS.util;

  const WL = { lists: [], activeId: null, items: [], dragSymbol: null };
  const COMPACT1 = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
  const COLUMNS = {
    price: { label: 'Price', width: '70px', cell: (i) => `<span class="mono">${fmtPrice(i.last_price)}</span>` },
    change: { label: '24h', width: '58px', cell: (i) => `<span class="mono ${i.change_24h_pct === null ? 'muted' : changeClass(i.change_24h_pct)}">${fmtPct(i.change_24h_pct)}</span>` },
    volume: { label: 'Vol', width: '48px', cell: (i) => `<span class="mono muted">${i.volume_24h_usd === null ? '-' : COMPACT1.format(Number(i.volume_24h_usd))}</span>` },
    provider: { label: 'Source', width: '64px', cell: (i) => `<span class="muted small">${esc(i.provider_name || 'none')}${i.listing_count > 1 ? ` +${i.listing_count - 1}` : ''}</span>` },
    score: { label: 'Score', width: '36px', cell: (i) => `<span class="mono">${i.profit_score ?? '-'}</span>` },
    updated: { label: 'Upd.', width: '34px', cell: (i) => `<span class="muted small">${ago(i.updated_at).replace(' ago', '')}</span>` },
  };
  const SORT_LABELS = { manual: 'Manual order', symbol: 'Symbol', price: 'Price', change: '24h change', volume: 'Volume' };

  const activeList = () => WL.lists.find((w) => w.id === WL.activeId) || null;

  // ---- watchlist panel ------------------------------------------------------------------
  async function loadLists() {
    try {
      const d = await TS.api('api/watchlists');
      WL.lists = d.watchlists;
      const saved = storage.get('watchlistId', null);
      const pick = WL.lists.find((w) => w.id === (WL.activeId || saved)) || WL.lists.find((w) => w.is_default) || WL.lists[0];
      WL.activeId = pick ? pick.id : null;
      renderSelect();
      await loadItems();
    } catch (e) {
      $('watchlist-body').innerHTML = `<div class="muted small pad">${esc(e.message)}</div>`;
    }
  }
  TS.reloadWatchlists = loadLists;

  function renderSelect() {
    $('wl-select').innerHTML = WL.lists.map((w) => `<option value="${w.id}">${esc(w.name)}${w.is_default ? ' ★' : ''} (${w.item_count})</option>`).join('');
    if (WL.activeId) $('wl-select').value = String(WL.activeId);
  }

  async function loadItems() {
    if (!WL.activeId) {
      WL.items = [];
      return render();
    }
    const id = WL.activeId;
    try {
      const d = await TS.api(`api/watchlists/${id}/items`);
      if (id !== WL.activeId) return;
      WL.items = d.items;
    } catch (e) {
      WL.items = [];
    }
    render();
  }
  TS.reloadWatchlistItems = loadItems;

  function sortedItems() {
    const list = activeList();
    const sort = (list && list.sort) || { by: 'manual', dir: 'asc' };
    const q = $('watchlist-search').value.trim().toLowerCase();
    let rows = WL.items.filter((i) => !q || [i.symbol, i.name, i.provider_name, i.category].some((v) => String(v || '').toLowerCase().includes(q)));
    if (sort.by !== 'manual') {
      const key = { symbol: 'symbol', price: 'last_price', change: 'change_24h_pct', volume: 'volume_24h_usd' }[sort.by];
      const dir = sort.dir === 'desc' ? -1 : 1;
      rows = [...rows].sort((a, b) => {
        if (key === 'symbol') return a.symbol.localeCompare(b.symbol) * dir;
        const x = a[key] === null ? -Infinity : Number(a[key]);
        const y = b[key] === null ? -Infinity : Number(b[key]);
        return (x - y) * dir;
      });
    }
    return rows;
  }

  function render() {
    const list = activeList();
    const cols = ((list && list.columns) || ['price', 'change']).filter((c) => COLUMNS[c]);
    // The symbol keeps at least 76px; with many columns the list scrolls sideways.
    const template = `minmax(76px, 1fr) ${cols.map((c) => COLUMNS[c].width).join(' ')} 16px`;
    $('watchlist').style.setProperty('--wl-template', template);
    $('wl-cols').innerHTML = `<span>Symbol</span>${cols.map((c) => `<span>${COLUMNS[c].label}</span>`).join('')}<span></span>`;
    const manual = !list || !list.sort || list.sort.by === 'manual';
    const rows = sortedItems();
    const body = $('watchlist-body');
    if (!WL.items.length) {
      body.innerHTML = `<div class="wl-empty">This list is empty.<br><button type="button" class="pill pill-green" data-open-search><i class="fa-solid fa-magnifying-glass-plus" aria-hidden="true"></i> Find symbols</button></div>`;
      return;
    }
    body.innerHTML = rows.length
      ? rows
          .map(
            (i) => `
        <div class="wl-row${i.symbol === TS.activeSymbol ? ' active' : ''}${i.is_active === false ? ' inactive' : ''}" role="listitem" tabindex="0" data-symbol="${esc(i.symbol)}" ${manual ? 'draggable="true"' : ''}
             title="${esc(i.name || i.symbol)} · ${esc(i.provider_name || 'no source')}${manual ? ' · drag or Alt+↑/↓ to reorder' : ''}">
          <div class="wl-main"><div class="wl-sym">${esc(i.symbol)}</div><div class="wl-sub">${esc(CATEGORY_LABELS[i.category] || i.category || '')}${i.exchange ? ` · ${esc(i.exchange)}` : ''}</div></div>
          ${cols.map((c) => `<div class="wl-cell">${COLUMNS[c].cell(i)}</div>`).join('')}
          <button type="button" class="wl-remove" data-remove-item="${esc(i.symbol)}" aria-label="Remove ${esc(i.symbol)} from the list" title="Remove from this list"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>
        </div>`
          )
          .join('')
      : '<div class="muted small pad">No symbol matches the filter.</div>';
  }

  async function removeItem(symbol) {
    try {
      await TS.apiSend('DELETE', `api/watchlists/${WL.activeId}/items/${encodeURIComponent(symbol)}`);
      WL.items = WL.items.filter((i) => i.symbol !== symbol);
      const l = activeList();
      if (l) l.item_count = WL.items.length;
      renderSelect();
      render();
    } catch (e) {
      showToast('Not removed', esc(e.message), 'error');
    }
  }

  async function saveOrder(symbols) {
    const byS = new Map(WL.items.map((i) => [i.symbol, i]));
    WL.items = symbols.map((s) => byS.get(s)).filter(Boolean);
    render();
    try {
      await TS.apiSend('PUT', `api/watchlists/${WL.activeId}/items`, { symbols });
    } catch (e) {
      showToast('Order not saved', esc(e.message), 'error');
      loadItems();
    }
  }

  async function addToList(symbol, listId = WL.activeId) {
    const list = WL.lists.find((w) => w.id === Number(listId));
    try {
      const d = await TS.apiSend('POST', `api/watchlists/${listId}/items`, { symbol });
      showToast(d.added ? 'Added' : 'Already on the list', `${esc(d.symbol)} · ${esc(list ? list.name : 'watchlist')}`, 'success');
      await loadLists();
    } catch (e) {
      showToast('Not added', esc(e.message), 'error');
    }
  }
  TS.addToList = addToList;

  // Drag and drop in manual order; Alt+Up / Alt+Down with the keyboard.
  const body = $('watchlist-body');
  body.addEventListener('dragstart', (e) => {
    const row = e.target.closest('.wl-row');
    if (!row) return;
    WL.dragSymbol = row.dataset.symbol;
    row.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', WL.dragSymbol);
  });
  body.addEventListener('dragend', (e) => {
    const row = e.target.closest('.wl-row');
    if (row) row.classList.remove('dragging');
    body.querySelectorAll('.drop-before').forEach((r) => r.classList.remove('drop-before'));
  });
  body.addEventListener('dragover', (e) => {
    if (!WL.dragSymbol) return;
    e.preventDefault();
    body.querySelectorAll('.drop-before').forEach((r) => r.classList.remove('drop-before'));
    const row = e.target.closest('.wl-row');
    if (row && row.dataset.symbol !== WL.dragSymbol) row.classList.add('drop-before');
  });
  body.addEventListener('drop', (e) => {
    if (!WL.dragSymbol) return;
    e.preventDefault();
    const target = e.target.closest('.wl-row');
    const order = WL.items.map((i) => i.symbol).filter((s) => s !== WL.dragSymbol);
    const at = target ? order.indexOf(target.dataset.symbol) : order.length;
    order.splice(at < 0 ? order.length : at, 0, WL.dragSymbol);
    WL.dragSymbol = null;
    saveOrder(order);
  });
  body.addEventListener('keydown', (e) => {
    const row = e.target.closest('.wl-row');
    if (!row) return;
    const symbol = row.dataset.symbol;
    if (e.key === 'Enter') {
      e.preventDefault();
      TS.selectPair(symbol);
    } else if (e.key === 'Delete') {
      e.preventDefault();
      removeItem(symbol);
    } else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      const list = activeList();
      if (list && list.sort && list.sort.by !== 'manual') return showToast('Sorted list', 'Switch the list to manual order to move symbols.', 'info');
      e.preventDefault();
      const order = WL.items.map((i) => i.symbol);
      const i = order.indexOf(symbol);
      const j = i + (e.key === 'ArrowUp' ? -1 : 1);
      if (j < 0 || j >= order.length) return;
      [order[i], order[j]] = [order[j], order[i]];
      saveOrder(order).then(() => {
        const moved = body.querySelector(`.wl-row[data-symbol="${CSS.escape(symbol)}"]`);
        if (moved) moved.focus();
      });
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = e.key === 'ArrowDown' ? row.nextElementSibling : row.previousElementSibling;
      if (next && next.classList.contains('wl-row')) next.focus();
    }
  });

  $('wl-select').addEventListener('change', () => {
    WL.activeId = Number($('wl-select').value);
    storage.set('watchlistId', WL.activeId);
    loadItems();
  });
  $('watchlist-search').addEventListener('input', render);
  document.addEventListener('ts:symbol', render);

  // ---- manage lists ------------------------------------------------------------------------
  function openModal(id) {
    $(id).classList.remove('hidden');
  }
  function closeModal(id) {
    $(id).classList.add('hidden');
  }
  document.addEventListener('click', (e) => {
    const close = e.target.closest('[data-close-modal]');
    if (close) return closeModal(close.closest('.modal-backdrop').id);
    if (['search-modal', 'sources-modal', 'lists-modal'].includes(e.target.id)) closeModal(e.target.id);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    for (const id of ['sources-modal', 'lists-modal', 'search-modal']) {
      if (!$(id).classList.contains('hidden')) {
        e.preventDefault();
        return closeModal(id);
      }
    }
  });

  function renderListsModal() {
    $('lists-body').innerHTML = WL.lists
      .map(
        (w, idx) => `
      <div class="list-edit" data-list="${w.id}">
        <div class="list-edit-top">
          <input name="name" value="${esc(w.name)}" aria-label="Name" maxlength="60">
          <label class="check small"><input type="radio" name="default" ${w.is_default ? 'checked' : ''}> Default</label>
          <span class="muted small">${w.item_count} symbols</span>
          <span class="spacer"></span>
          <button type="button" class="icon-btn" data-move="-1" ${idx === 0 ? 'disabled' : ''} aria-label="Move up"><i class="fa-solid fa-arrow-up" aria-hidden="true"></i></button>
          <button type="button" class="icon-btn" data-move="1" ${idx === WL.lists.length - 1 ? 'disabled' : ''} aria-label="Move down"><i class="fa-solid fa-arrow-down" aria-hidden="true"></i></button>
          <button type="button" class="icon-btn danger" data-delete-list ${WL.lists.length <= 1 ? 'disabled' : ''} aria-label="Delete ${esc(w.name)}"><i class="fa-solid fa-trash" aria-hidden="true"></i></button>
        </div>
        <div class="list-edit-opts">
          <span class="muted small">Columns</span>
          ${Object.entries(COLUMNS).map(([k, c]) => `<label class="check small"><input type="checkbox" name="col" value="${k}" ${(w.columns || []).includes(k) ? 'checked' : ''}> ${c.label}</label>`).join('')}
          <label class="inline-label">Sort <select name="sort">${Object.entries(SORT_LABELS).map(([k, l]) => `<option value="${k}" ${w.sort && w.sort.by === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
          <select name="dir" aria-label="Direction"><option value="asc" ${w.sort && w.sort.dir === 'asc' ? 'selected' : ''}>ascending</option><option value="desc" ${w.sort && w.sort.dir === 'desc' ? 'selected' : ''}>descending</option></select>
        </div>
      </div>`
      )
      .join('');
  }

  async function updateList(id, patch) {
    try {
      await TS.apiSend('PUT', `api/watchlists/${id}`, patch);
      await loadLists();
      renderListsModal();
    } catch (e) {
      showToast('Watchlist not saved', esc(e.message), 'error');
      renderListsModal();
    }
  }

  $('lists-body').addEventListener('change', (e) => {
    const box = e.target.closest('[data-list]');
    if (!box) return;
    const id = Number(box.dataset.list);
    const el = e.target;
    if (el.name === 'name') return updateList(id, { name: el.value });
    if (el.name === 'default') return updateList(id, { is_default: true });
    if (el.name === 'col') return updateList(id, { columns: [...box.querySelectorAll('input[name=col]:checked')].map((x) => x.value) });
    if (el.name === 'sort' || el.name === 'dir') return updateList(id, { sort: { by: box.querySelector('[name=sort]').value, dir: box.querySelector('[name=dir]').value } });
  });
  $('lists-body').addEventListener('click', async (e) => {
    const box = e.target.closest('[data-list]');
    if (!box) return;
    const id = Number(box.dataset.list);
    const move = e.target.closest('[data-move]');
    if (move) {
      const order = WL.lists.map((w) => w.id);
      const i = order.indexOf(id);
      const j = i + Number(move.dataset.move);
      [order[i], order[j]] = [order[j], order[i]];
      for (const [pos, lid] of order.entries()) await TS.apiSend('PUT', `api/watchlists/${lid}`, { position: pos }).catch(() => {});
      await loadLists();
      return renderListsModal();
    }
    if (e.target.closest('[data-delete-list]')) {
      const w = WL.lists.find((x) => x.id === id);
      if (!confirm(`Delete the watchlist "${w.name}"? The instruments stay registered.`)) return;
      try {
        await TS.apiSend('DELETE', `api/watchlists/${id}`);
        if (WL.activeId === id) WL.activeId = null;
        await loadLists();
        renderListsModal();
      } catch (err) {
        showToast('Not deleted', esc(err.message), 'error');
      }
    }
  });
  $('lists-new').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = e.target.elements.name.value.trim();
    try {
      const d = await TS.apiSend('POST', 'api/watchlists', { name });
      e.target.reset();
      WL.activeId = d.watchlist.id;
      storage.set('watchlistId', WL.activeId);
      await loadLists();
      renderListsModal();
      showToast('Watchlist created', `${esc(name)}. Add symbols with + or Ctrl+K.`, 'success');
    } catch (err) {
      showToast('Not created', esc(err.message), 'error');
    }
  });
  function openLists() {
    renderListsModal();
    openModal('lists-modal');
  }
  $('wl-manage').addEventListener('click', openLists);

  // ---- search and command palette -------------------------------------------------------------
  const S = { scope: 'default', results: [], local: [], commands: [], focus: 0, timer: null, request: 0, searching: false, errors: [] };
  // Other scripts add commands: TS.commands.push({ label, icon, keywords, run }).
  TS.commands = TS.commands || [];
  const baseCommands = () => [
    { label: 'Markets', icon: 'fa-chart-column', run: () => TS.showTab('chart') },
    { label: 'Screener', icon: 'fa-list-check', run: () => TS.showTab('screener') },
    { label: 'Freqtrade', icon: 'fa-robot', run: () => TS.showTab('freqtrade') },
    { label: 'Web3 DEX', icon: 'fa-bolt', run: () => TS.showTab('dex') },
    { label: 'Logs', icon: 'fa-terminal', run: () => TS.showTab('logs') },
    { label: 'Settings: general & risk', icon: 'fa-sliders', run: () => TS.openSettings('general') },
    { label: 'Settings: data providers', icon: 'fa-plug', run: () => TS.openSettings('providers') },
    { label: 'Settings: instruments', icon: 'fa-coins', run: () => TS.openSettings('instruments') },
    { label: 'Settings: integrations', icon: 'fa-diagram-project', run: () => TS.openSettings('integrations') },
    { label: 'Manage watchlists', icon: 'fa-gear', keywords: 'lists new create', run: openLists },
    { label: 'Data sources of the current symbol', icon: 'fa-plug', keywords: 'provider fallback', run: () => TS.activeSymbol && openSources(TS.activeSymbol) },
    { label: 'System dashboard', icon: 'fa-server', run: () => switchView('system') },
    { label: 'FreqUI', icon: 'fa-robot', run: () => switchView('frequi') },
    ...TS.commands,
  ];

  function openSearch({ query = '', listId } = {}) {
    $('search-target-list').innerHTML = WL.lists.map((w) => `<option value="${w.id}">${esc(w.name)}</option>`).join('');
    $('search-target-list').value = String(listId || WL.activeId || '');
    $('search-input').value = query;
    openModal('search-modal');
    setTimeout(() => $('search-input').focus(), 0);
    onInput();
  }
  TS.openSearch = openSearch;

  function onInput() {
    const q = $('search-input').value.trim();
    const ql = q.toLowerCase();
    S.commands = baseCommands().filter((c) => !q || `${c.label} ${c.keywords || ''}`.toLowerCase().includes(ql)).slice(0, q ? 6 : 4);
    S.local = TS.pairs
      .filter((p) => !q || [p.symbol, p.name, p.base_asset, p.exchange].some((v) => String(v || '').toLowerCase().includes(ql)))
      .slice(0, q ? 8 : 6);
    S.results = [];
    S.errors = [];
    S.focus = 0;
    clearTimeout(S.timer);
    S.searching = q.length >= 2;
    renderResults();
    if (S.searching) S.timer = setTimeout(() => remoteSearch(q), 400);
  }

  async function remoteSearch(q) {
    const request = ++S.request;
    try {
      const d = await TS.api(`api/search?q=${encodeURIComponent(q)}&scope=${S.scope}`);
      if (request !== S.request) return;
      // Registered symbols already appear in the local section, unless a new source is offered.
      S.results = d.results.filter((r) => !r.registered || r.sources.some((s) => !s.listed));
      S.errors = d.errors;
      S.searched = d.searched;
    } catch (e) {
      if (request !== S.request) return;
      S.errors = [{ provider: 'search', error: e.message }];
    }
    S.searching = false;
    renderResults();
  }

  // Flat list of selectable entries, in display order.
  function entries() {
    return [...S.commands.map((c) => ({ type: 'command', c })), ...S.local.map((p) => ({ type: 'local', p })), ...S.results.map((r, idx) => ({ type: 'remote', r, idx }))];
  }

  function renderResults() {
    const list = entries();
    let n = 0;
    const item = (html, cls = '') => `<div class="search-item ${cls}${n === S.focus ? ' focused' : ''}" role="option" id="search-opt-${n}" data-entry="${n++}" aria-selected="${n - 1 === S.focus}">${html}</div>`;
    const parts = [];
    if (S.commands.length) {
      parts.push('<div class="search-group">Go to</div>');
      for (const c of S.commands) parts.push(item(`<i class="fa-solid ${c.icon || 'fa-arrow-right'} muted" aria-hidden="true"></i> <span>${esc(c.label)}</span>`, 'cmd'));
    }
    if (S.local.length) {
      parts.push('<div class="search-group">Registered instruments</div>');
      for (const p of S.local) {
        parts.push(
          item(`<span class="si-sym">${esc(p.symbol)}</span> <span class="pill ${CATEGORY_PILL[p.category] || 'pill-gray'}">${esc(CATEGORY_LABELS[p.category] || p.category)}</span>
            <span class="si-name">${esc(p.name || p.provider_name || '')}</span><span class="mono">${fmtPrice(p.last_price)}</span>
            <button type="button" class="icon-btn" data-si-add="${esc(p.symbol)}" title="Add to the list" aria-label="Add ${esc(p.symbol)} to the list"><i class="fa-solid fa-plus" aria-hidden="true"></i></button>`)
        );
      }
    }
    if (S.searching) parts.push('<div class="search-group">Providers <i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i></div>');
    else if (S.results.length) parts.push(`<div class="search-group">From providers${S.searched ? ` <span class="muted">(${esc(S.searched.join(', '))})</span>` : ''}</div>`);
    S.results.forEach((r, idx) => {
      const badges = r.sources
        .map(
          (s, si) =>
            `<button type="button" class="src-badge${s.listed ? ' listed' : ''}" data-add-source="${idx}:${si}" ${s.listed ? 'disabled' : ''} title="${esc(`${s.provider}: ${s.provider_symbol}${s.liquidity_usd ? ` · liquidity $${fmtCompact(s.liquidity_usd)}` : ''}`)}">${s.listed ? '✓ ' : '+ '}${esc(s.provider)}</button>`
        )
        .join('');
      parts.push(
        item(`<span class="si-sym">${esc(r.symbol)}</span> <span class="pill ${CATEGORY_PILL[r.category] || 'pill-gray'}">${esc(CATEGORY_LABELS[r.category] || r.category)}</span>
          <span class="si-name">${esc(r.name || '')}</span><span class="si-badges">${badges}</span>
          <button type="button" class="pill pill-green" data-add-remote="${idx}">${r.registered ? 'Add sources' : 'Add'}</button>`, 'remote')
      );
    });
    if (!S.searching && S.errors.length) parts.push(`<div class="search-errors">${S.errors.map((e) => `${esc(e.provider)}: ${esc(e.error)}`).join('<br>')}</div>`);
    if (!parts.length) parts.push('<div class="muted small pad">Type a symbol (BTC, AAPL), a name, a contract address or a command.</div>');
    else if (!S.searching && !S.results.length && $('search-input').value.trim().length >= 2 && !S.local.length) parts.push('<div class="muted small pad">No provider has this. Try another scope above.</div>');
    $('search-results').innerHTML = parts.join('');
    $('search-input').setAttribute('aria-activedescendant', list.length ? `search-opt-${S.focus}` : '');
  }

  // Imports a provider result: every source not yet listed (or only one), onto the target list.
  async function importRemote(idx, sourceIdx) {
    const r = S.results[idx];
    const sources = sourceIdx === undefined ? r.sources.filter((s) => !s.listed).slice(0, 10) : [r.sources[sourceIdx]];
    const listId = Number($('search-target-list').value) || null;
    try {
      const d = await TS.apiSend('POST', 'api/instruments/import', {
        symbol: r.registered_symbol || r.symbol, category: r.category, name: r.name, base_asset: r.base, quote_asset: r.quote,
        contract_address: r.contract_address, network: r.network, watchlist_id: listId,
        listings: sources.map((s) => ({ provider_id: s.provider_id, provider_symbol: s.provider_symbol, network: s.network })),
      });
      showToast(d.created ? 'Instrument added' : 'Sources added', `${esc(d.symbol)}: ${d.listings.length} source(s)${listId ? ' · on the list' : ''}`, 'success');
      closeModal('search-modal');
      await TS.reloadPairs();
      await loadLists();
      TS.selectPair(d.symbol, { switchTab: true });
      TS.loadSources();
    } catch (e) {
      showToast('Not added', esc(e.message), 'error');
    }
  }

  function activate(entry, { add = false } = {}) {
    if (!entry) return;
    if (entry.type === 'command') {
      closeModal('search-modal');
      return entry.c.run();
    }
    if (entry.type === 'local') {
      if (add) return addToList(entry.p.symbol, $('search-target-list').value);
      closeModal('search-modal');
      return TS.selectPair(entry.p.symbol, { switchTab: true });
    }
    return importRemote(entry.idx);
  }

  $('search-input').addEventListener('input', onInput);
  $('search-input').addEventListener('keydown', (e) => {
    const list = entries();
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      S.focus = Math.max(0, Math.min(list.length - 1, S.focus + (e.key === 'ArrowDown' ? 1 : -1)));
      renderResults();
      const el = $(`search-opt-${S.focus}`);
      if (el) el.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      activate(list[S.focus], { add: e.ctrlKey || e.metaKey });
    }
  });
  $('search-results').addEventListener('click', (e) => {
    const addLocal = e.target.closest('[data-si-add]');
    if (addLocal) return addToList(addLocal.dataset.siAdd, $('search-target-list').value);
    const src = e.target.closest('[data-add-source]');
    if (src) {
      const [i, si] = src.dataset.addSource.split(':').map(Number);
      return importRemote(i, si);
    }
    const addRemote = e.target.closest('[data-add-remote]');
    if (addRemote) return importRemote(Number(addRemote.dataset.addRemote));
    const row = e.target.closest('[data-entry]');
    if (row) activate(entries()[Number(row.dataset.entry)]);
  });
  $('search-scope').addEventListener('click', (e) => {
    const b = e.target.closest('[data-scope]');
    if (!b) return;
    S.scope = b.dataset.scope;
    $('search-scope').querySelectorAll('[data-scope]').forEach((x) => {
      x.classList.toggle('active', x === b);
      x.setAttribute('aria-pressed', String(x === b));
    });
    onInput();
    $('search-input').focus();
  });

  // ---- data sources of one instrument ---------------------------------------------------------
  const SRC = { symbol: null, listings: [], lists: [], providers: [] };

  async function openSources(symbol) {
    SRC.symbol = symbol;
    $('sources-title').textContent = `Data sources · ${symbol}`;
    $('sources-candidates').innerHTML = '';
    openModal('sources-modal');
    await refreshSources();
  }
  TS.openSources = openSources;

  async function refreshSources() {
    try {
      const [d, p] = await Promise.all([TS.api(`api/instruments/${encodeURIComponent(SRC.symbol)}`), TS.api('api/providers')]);
      SRC.listings = d.listings;
      SRC.lists = d.watchlists;
      SRC.providers = p.providers;
      renderSources();
    } catch (e) {
      $('sources-tbody').innerHTML = `<tr><td colspan="5" class="empty">${esc(e.message)}</td></tr>`;
    }
  }

  function renderSources() {
    $('sources-tbody').innerHTML = SRC.listings.length
      ? SRC.listings
          .map(
            (l, idx) => `
        <tr data-listing="${l.id}">
          <td class="mono">${idx + 1}</td>
          <td><strong>${esc(l.provider.name)}</strong>${l.provider.enabled ? '' : ' <span class="pill pill-gray">provider off</span>'}</td>
          <td><input class="mono small-input" name="provider_symbol" value="${esc(l.provider_symbol || '')}" placeholder="BASE+QUOTE" aria-label="Provider symbol"></td>
          <td><label class="check small"><input type="checkbox" name="enabled" ${l.enabled ? 'checked' : ''}> on</label> <span class="test-out small muted"></span></td>
          <td class="r nowrap">
            <button type="button" class="icon-btn" data-src-move="-1" ${idx === 0 ? 'disabled' : ''} aria-label="Move up"><i class="fa-solid fa-arrow-up" aria-hidden="true"></i></button>
            <button type="button" class="icon-btn" data-src-move="1" ${idx === SRC.listings.length - 1 ? 'disabled' : ''} aria-label="Move down"><i class="fa-solid fa-arrow-down" aria-hidden="true"></i></button>
            <button type="button" class="icon-btn" data-src-test aria-label="Test"><i class="fa-solid fa-vial" aria-hidden="true"></i></button>
            <button type="button" class="icon-btn danger" data-src-delete aria-label="Remove"><i class="fa-solid fa-trash" aria-hidden="true"></i></button>
          </td>
        </tr>`
          )
          .join('')
      : '<tr><td colspan="5" class="empty">No source yet: add one below.</td></tr>';
    const listed = new Set(SRC.listings.map((l) => l.provider_id));
    $('sources-manual').elements.provider_id.innerHTML = SRC.providers.map((p) => `<option value="${p.id}">${esc(p.name)}${listed.has(p.id) ? ' (listed)' : ''}</option>`).join('');
    $('sources-lists').innerHTML = WL.lists
      .map((w) => `<label class="check small chip"><input type="checkbox" data-list-toggle="${w.id}" ${SRC.lists.includes(w.id) ? 'checked' : ''}> ${esc(w.name)}</label>`)
      .join('');
  }

  async function sourcesChanged() {
    await refreshSources();
    TS.reloadPairs();
    if (SRC.symbol === TS.activeSymbol) {
      await TS.loadSources();
      TS.candles = [];
      TS.reloadCandles();
    }
  }

  $('sources-tbody').addEventListener('change', async (e) => {
    const row = e.target.closest('[data-listing]');
    if (!row) return;
    const body = e.target.name === 'enabled' ? { enabled: e.target.checked } : { provider_symbol: e.target.value.trim() };
    try {
      await TS.apiSend('PUT', `api/listings/${row.dataset.listing}`, body);
      await sourcesChanged();
    } catch (err) {
      showToast('Source not saved', esc(err.message), 'error');
      refreshSources();
    }
  });
  $('sources-tbody').addEventListener('click', async (e) => {
    const row = e.target.closest('[data-listing]');
    if (!row) return;
    const id = Number(row.dataset.listing);
    const move = e.target.closest('[data-src-move]');
    try {
      if (move) {
        const ids = SRC.listings.map((l) => l.id);
        const i = ids.indexOf(id);
        const j = i + Number(move.dataset.srcMove);
        [ids[i], ids[j]] = [ids[j], ids[i]];
        await TS.apiSend('PUT', `api/instruments/${encodeURIComponent(SRC.symbol)}/listings/order`, { ids });
        return sourcesChanged();
      }
      if (e.target.closest('[data-src-test]')) {
        const out = row.querySelector('.test-out');
        out.textContent = 'testing…';
        const d = await TS.apiSend('POST', `api/listings/${id}/test`);
        out.className = `test-out small ${d.ok ? 'pos' : 'neg'}`;
        out.textContent = `${d.ok ? 'OK' : 'failed'} · ${d.message} (${d.ms} ms)`;
        return;
      }
      if (e.target.closest('[data-src-delete]')) {
        if (!confirm('Remove this source?')) return;
        await TS.apiSend('DELETE', `api/listings/${id}`);
        return sourcesChanged();
      }
    } catch (err) {
      showToast('Sources', esc(err.message), 'error');
    }
  });
  $('sources-find').addEventListener('click', async () => {
    const box = $('sources-candidates');
    box.innerHTML = '<div class="muted small"><i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i> Asking the providers…</div>';
    try {
      const d = await TS.api(`api/instruments/${encodeURIComponent(SRC.symbol)}/candidates`);
      box.innerHTML = d.matches.length
        ? d.matches
            .map((m, i) => `<div class="candidate"><strong>${esc(m.provider)}</strong> <span class="mono">${esc(m.provider_symbol)}</span> <span class="muted small">${esc(m.name || m.symbol)}</span> <button type="button" class="pill pill-green" data-candidate="${i}">Add</button></div>`)
            .join('')
        : `<div class="muted small">No other provider has ${esc(SRC.symbol)} under the same base and quote.${d.errors.length ? ` (${d.errors.map((x) => esc(x.provider)).join(', ')} did not answer)` : ''}</div>`;
      box.dataset.matches = JSON.stringify(d.matches);
    } catch (e) {
      box.innerHTML = `<div class="neg small">${esc(e.message)}</div>`;
    }
  });
  $('sources-candidates').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-candidate]');
    if (!b) return;
    const m = JSON.parse($('sources-candidates').dataset.matches || '[]')[Number(b.dataset.candidate)];
    try {
      await TS.apiSend('POST', `api/instruments/${encodeURIComponent(SRC.symbol)}/listings`, { provider_id: m.provider_id, provider_symbol: m.provider_symbol, network: m.network });
      b.closest('.candidate').remove();
      await sourcesChanged();
    } catch (err) {
      showToast('Source not added', esc(err.message), 'error');
    }
  });
  $('sources-manual').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target.elements;
    try {
      await TS.apiSend('POST', `api/instruments/${encodeURIComponent(SRC.symbol)}/listings`, { provider_id: f.provider_id.value, provider_symbol: f.provider_symbol.value, network: f.network.value });
      e.target.reset();
      await sourcesChanged();
    } catch (err) {
      showToast('Source not added', esc(err.message), 'error');
    }
  });
  $('sources-lists').addEventListener('change', async (e) => {
    const cb = e.target.closest('[data-list-toggle]');
    if (!cb) return;
    const id = cb.dataset.listToggle;
    try {
      if (cb.checked) await TS.apiSend('POST', `api/watchlists/${id}/items`, { symbol: SRC.symbol });
      else await TS.apiSend('DELETE', `api/watchlists/${id}/items/${encodeURIComponent(SRC.symbol)}`);
      await loadLists();
    } catch (err) {
      showToast('Watchlist', esc(err.message), 'error');
      cb.checked = !cb.checked;
    }
  });

  // ---- global wiring -------------------------------------------------------------------------
  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-open-search]')) return openSearch();
    const add = e.target.closest('[data-add-to-list]');
    if (add) return addToList(add.dataset.addToList);
    const src = e.target.closest('[data-sources]');
    if (src) return openSources(src.dataset.sources);
    const rm = e.target.closest('[data-remove-item]');
    if (rm) return removeItem(rm.dataset.removeItem);
  });
  $('wl-add').addEventListener('click', () => openSearch({ listId: WL.activeId }));
  $('pair-picker-btn').addEventListener('click', () => openSearch());
  $('btn-sources').addEventListener('click', () => TS.activeSymbol && openSources(TS.activeSymbol));

  // Ctrl+K / Cmd+K anywhere, "/" when not typing: search.
  document.addEventListener('keydown', (e) => {
    const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName) || document.activeElement.isContentEditable;
    if (((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') || (e.key === '/' && !typing && !document.querySelector('.modal-backdrop:not(.hidden)'))) {
      if ($('view-trading').classList.contains('hidden')) return;
      e.preventDefault();
      openSearch();
    }
  });

  loadLists();
  setInterval(() => !document.hidden && !$('view-trading').classList.contains('hidden') && loadItems(), 30000);
})();
