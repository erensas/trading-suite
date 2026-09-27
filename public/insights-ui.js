// Insights card in the Markets side panel (rule-based reading of the chart's candles from
// insights.js, with indicator and strategy suggestions and the news mentions), the news
// list, and Settings → News feeds.
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (v) => escapeHtml(v);
  const { fmtTime, ago } = TS.fmt;
  const ST = { key: null, at: 0, analysis: null, news: new Map() };
  const PAIR = /^[A-Z0-9]+\/[A-Z0-9]+(:[A-Z0-9]+)?$/;

  // ---- insights ----------------------------------------------------------------------------
  async function newsSummary(symbol) {
    const hit = ST.news.get(symbol);
    if (hit && Date.now() - hit.at < 5 * 60 * 1000) return hit.summary;
    try {
      const summary = (await TS.api(`api/news/summary?symbol=${encodeURIComponent(symbol)}`)).summary;
      ST.news.set(symbol, { at: Date.now(), summary });
      return summary;
    } catch (e) {
      return null;
    }
  }

  const REGIME_PILL = { uptrend: 'pill-green', downtrend: 'pill-red', range: 'pill-blue', squeeze: 'pill-purple', mixed: 'pill-gray' };
  const FIT_PILL = { good: 'pill-green', possible: 'pill-blue', weak: 'pill-warn' };

  async function render() {
    const a = ST.analysis;
    const box = $('insights-box');
    $('insights-tf').textContent = TS.activeTf ? `· ${TS.activeTf}` : '';
    if (!a) return;
    if (!a.ok) {
      box.innerHTML = `<div class="muted small">${esc(a.message)}</div>`;
      return;
    }
    const onChart = new Set((TS.layout.indicators || []).map((i) => `${i.id}:${JSON.stringify(Indicators.normalizeParams(i.id, i.params))}`));
    const has = (i) => onChart.has(`${i.id}:${JSON.stringify(Indicators.normalizeParams(i.id, i.params))}`);
    const symbol = TS.activeSymbol;
    const canBacktest = PAIR.test(symbol || '');
    const summary = await newsSummary(symbol);
    if (TS.activeSymbol !== symbol) return;
    box.classList.remove('muted', 'small');
    box.innerHTML = `
      <div class="ins-regime"><span class="pill ${REGIME_PILL[a.regime.kind]}">${esc(a.regime.label)}</span>${a.regime.volatility ? `<span class="pill pill-gray">${esc(a.regime.volatility)} volatility</span>` : ''}</div>
      <ul class="ins-reasons">${a.regime.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>
      <div class="ins-readings">${a.readings.map((r) => `<div class="ins-reading" title="${esc(r.note)}"><span class="k">${esc(r.name)}</span><span class="v ${r.tone > 0 ? 'pos' : r.tone < 0 ? 'neg' : ''}">${esc(r.value)}</span><span class="n">${esc(r.note)}</span></div>`).join('')}</div>
      <div class="card-title small">Indicators that suit it</div>
      <div class="ins-list">${a.indicators
        .map(
          (i) => `<div class="ins-item"><div><b>${esc(i.label)}</b> <span class="muted small">${esc(i.why)}</span></div>${
            has(i) ? '<span class="pill pill-gray">on chart</span>' : `<button type="button" class="pill pill-blue" data-ins-add="${esc(i.id)}" data-params="${esc(JSON.stringify(i.params))}"><i class="fa-solid fa-plus" aria-hidden="true"></i> Add</button>`
          }</div>`
        )
        .join('')}</div>
      <div class="card-title small">Strategy templates</div>
      <div class="ins-list">${a.strategies
        .map(
          (s) => `<div class="ins-item"><div><b>${esc(s.template)}</b> <span class="pill ${FIT_PILL[s.fit] || 'pill-gray'}">${esc(s.fit)}</span> <span class="muted small">${esc(s.why)}</span></div>${
            canBacktest ? `<button type="button" class="pill pill-green" data-ins-bt="${esc(s.template)}"><i class="fa-solid fa-flask" aria-hidden="true"></i> Backtest</button>` : ''
          }</div>`
        )
        .join('')}</div>
      ${summary ? `<div class="ins-news"><i class="fa-solid fa-newspaper" aria-hidden="true"></i> ${esc(summary.asset)}: ${summary.n} article${summary.n === 1 ? '' : 's'} in 7 days (${summary.n24} in 24 h)${summary.n ? `, keyword tone <span class="pos">+${summary.pos}</span> / <span class="neg">−${summary.neg}</span>` : ''} <button type="button" class="link-btn" data-ins-news>show</button></div>` : ''}
      <div class="hint">${esc(a.note)}</div>`;
  }

  // Candles changed (studies.update runs after every candle load): read them again when the
  // symbol or timeframe changed, or at most once a minute.
  function onCandles() {
    const candles = TS.candles || [];
    if (!candles.length || !window.Insights) return;
    const key = `${TS.activeSymbol}|${TS.activeTf}`;
    if (key === ST.key && Date.now() - ST.at < 60000) return;
    ST.key = key;
    ST.at = Date.now();
    try {
      ST.analysis = Insights.analyze(candles, { timeframe: TS.activeTf });
    } catch (e) {
      ST.analysis = { ok: false, message: e.message };
    }
    render();
  }
  TS.insights = { onCandles, refresh: () => ((ST.at = 0), onCandles()) };

  $('insights-box').addEventListener('click', async (e) => {
    const add = e.target.closest('[data-ins-add]');
    if (add) {
      if (TS.studies && TS.studies.addIndicator(add.dataset.insAdd, JSON.parse(add.dataset.params || '{}'))) {
        showToast('Indicator added', 'Saved in the chart layout.', 'success');
        render();
      }
      return;
    }
    const bt = e.target.closest('[data-ins-bt]');
    if (bt) {
      const name = bt.dataset.insBt;
      bt.disabled = true;
      try {
        // A template has to be in the library before it can be backtested.
        const lib = await TS.api('api/strategies');
        if (!lib.library.some((s) => s.name === name)) {
          await TS.apiSend('POST', 'api/strategies/import', { kind: 'template', name });
          showToast(name, 'copied from the templates into the library', 'success');
        }
        TS.showTab('strategies');
        TS.strategies.setPane('backtests');
        await TS.strategies.prefillBacktest(name, { pairs: [TS.activeSymbol], timeframe: TS.activeTf });
      } catch (err) {
        showToast('Backtest not prepared', esc(err.message), 'error');
      } finally {
        bt.disabled = false;
      }
      return;
    }
    if (e.target.closest('[data-ins-news]')) {
      $('news-card').open = true;
      $('news-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  });

  // ---- news list (side panel) ------------------------------------------------------------------
  const toneDot = (t) => `<span class="tone-dot ${t > 0 ? 'pos' : t < 0 ? 'neg' : ''}" title="Keyword tone: ${t > 0 ? 'positive' : t < 0 ? 'negative' : 'neutral'}"></span>`;
  TS.renderNews = (data) => {
    const items = data.news || [];
    if (!items.length) return '<div class="muted small">No news yet. Feeds are read every 15 minutes (Settings → News feeds).</div>';
    return `${data.general ? `<div class="muted small">Nothing names ${esc(data.asset || 'this symbol')} yet; the latest general news:</div>` : ''}${items
      .map(
        (n) => `<div class="news-item">
          <a href="${esc(/^https?:/.test(n.url || '') ? n.url : '#')}" target="_blank" rel="noopener noreferrer" class="news-title">${toneDot(n.tone)}${esc(n.title)}</a>
          ${n.summary ? `<div class="small muted news-summary">${esc(n.summary)}</div>` : ''}
          <div class="news-meta"><span>${esc(n.source || '')}${(n.assets || []).length ? ` · ${n.assets.slice(0, 5).map(esc).join(' ')}` : ''}</span><span title="${esc(fmtTime(n.published_at))}">${esc(ago(n.published_at))}</span></div>
        </div>`
      )
      .join('')}`;
  };

  // ---- Settings → News feeds -----------------------------------------------------------------------
  async function loadFeeds() {
    try {
      const d = await TS.api('api/news/feeds');
      const job = d.job || {};
      $('news-job').textContent = job.running ? '· reading feeds…' : job.lastRunAt ? `· last run ${ago(job.lastRunAt)}` : '';
      $('news-feeds-tbody').innerHTML = d.feeds
        .map(
          (f) => `<tr data-feed="${f.id}">
            <td><b>${esc(f.name)}</b><div class="muted small feed-url" title="${esc(f.url)}">${esc(f.url)}</div></td>
            <td>${f.kind === 'per_symbol' ? 'per symbol' : 'feed'}</td>
            <td>${esc(f.category)}</td>
            <td class="small">${f.last_fetch_at ? esc(ago(f.last_fetch_at)) : '-'}${f.last_error ? `<div class="neg small" title="${esc(f.last_error)}">${esc(f.last_error.slice(0, 60))}</div>` : ''}</td>
            <td class="r">${f.last_items ?? '-'}</td>
            <td class="r">${f.stored}</td>
            <td class="small">${f.latest ? esc(ago(f.latest)) : '-'}</td>
            <td><input type="checkbox" data-feed-toggle ${f.enabled ? 'checked' : ''} aria-label="Enabled"></td>
            <td class="nowrap r"><button type="button" class="icon-btn" data-feed-refresh title="Read now" aria-label="Read ${esc(f.name)} now"><i class="fa-solid fa-rotate" aria-hidden="true"></i></button><button type="button" class="icon-btn danger" data-feed-delete title="Delete" aria-label="Delete ${esc(f.name)}"><i class="fa-solid fa-trash" aria-hidden="true"></i></button></td>
          </tr>`
        )
        .join('');
      if (job.running) setTimeout(loadFeeds, 4000);
    } catch (e) {
      $('news-feeds-tbody').innerHTML = `<tr><td colspan="9" class="form-error">${esc(e.message)}</td></tr>`;
    }
  }
  TS.settingsLoaders = TS.settingsLoaders || {};
  TS.settingsLoaders.news = loadFeeds;

  $('news-feeds-tbody').addEventListener('change', async (e) => {
    if (!e.target.matches('[data-feed-toggle]')) return;
    const id = e.target.closest('[data-feed]').dataset.feed;
    await TS.apiSend('PUT', `api/news/feeds/${id}`, { enabled: e.target.checked }).catch((err) => showToast('Not saved', esc(err.message), 'error'));
    loadFeeds();
  });
  $('news-feeds-tbody').addEventListener('click', async (e) => {
    const row = e.target.closest('[data-feed]');
    if (!row) return;
    const id = row.dataset.feed;
    if (e.target.closest('[data-feed-refresh]')) {
      const b = e.target.closest('[data-feed-refresh]');
      b.disabled = true;
      try {
        const r = await TS.apiSend('POST', 'api/news/refresh', { feedId: Number(id) });
        const res = (r.results || [])[0] || {};
        showToast(res.feed || 'Feed', res.error ? esc(res.error) : `${res.items} items, ${res.added} new`, res.error ? 'error' : 'success');
      } catch (err) {
        showToast('Not read', esc(err.message), 'error');
      }
      b.disabled = false;
      loadFeeds();
    }
    if (e.target.closest('[data-feed-delete]')) {
      const ok = await TS.confirmAction({ title: 'Delete this feed?', text: 'The feed and its stored articles are removed.', ok: 'Delete', danger: true });
      if (!ok) return;
      await TS.apiSend('DELETE', `api/news/feeds/${id}`).catch((err) => showToast('Not deleted', esc(err.message), 'error'));
      loadFeeds();
    }
  });
  $('news-feed-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      const r = await TS.apiSend('POST', 'api/news/feeds', { name: f.name.value, url: f.url.value, kind: f.kind.value, category: f.category.value });
      f.reset();
      showToast('Feed added', 'reading it now', 'success');
      await TS.apiSend('POST', 'api/news/refresh', { feedId: r.feed.id }).catch(() => {});
    } catch (err) {
      showToast('Feed not added', esc(err.message), 'error');
    }
    loadFeeds();
  });
  $('btn-news-refresh').addEventListener('click', async () => {
    await TS.apiSend('POST', 'api/news/refresh', {}).catch((err) => showToast('Not started', esc(err.message), 'error'));
    showToast('News', 'reading every feed in the background', 'info');
    setTimeout(loadFeeds, 1500);
  });

  TS.commands = TS.commands || [];
  TS.commands.push({ label: 'Settings: news feeds', icon: 'fa-rss', keywords: 'rss news', run: () => TS.openSettings('news') });
})();
