// News from RSS / Atom feeds (trade_db.news_feeds, news_items; migration 009).
//
// The news job reads every enabled feed (a 'per_symbol' feed once per active TradFi
// instrument), keeps new articles, tags them with the assets they mention (tickers and
// names of the registered instruments, plus common coin names) and gives each a keyword
// tone. Articles older than 30 days are removed. Nothing here trades.
const crypto = require('crypto');
const { XMLParser } = require('fast-xml-parser');
const { badRequest, notFound, onDuplicate } = require('../http/errors');
const { UNDEFINED_TABLE } = require('../db');

const MAX_BYTES = 3 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 12000;
const KEEP_DAYS = 30;
const PER_SYMBOL_LIMIT = 25;
const USER_AGENT = 'Mozilla/5.0 (compatible; trading-suite news reader)';

// Names of common assets, so "Bitcoin" tags BTC even without the ticker.
const ALIASES = {
  BTC: ['Bitcoin'], ETH: ['Ethereum', 'Ether'], SOL: ['Solana'], XRP: ['Ripple'], BNB: ['BNB Chain', 'Binance Coin'], DOGE: ['Dogecoin'],
  ADA: ['Cardano'], AVAX: ['Avalanche'], DOT: ['Polkadot'], LINK: ['Chainlink'], POL: ['Polygon'], MATIC: ['Polygon'], LTC: ['Litecoin'],
  TRX: ['Tron'], TON: ['Toncoin'], SHIB: ['Shiba Inu'], PEPE: ['Pepe'], SUI: ['Sui'], NEAR: ['NEAR Protocol'], APT: ['Aptos'],
  ARB: ['Arbitrum'], OP: ['Optimism'], UNI: ['Uniswap'], AAVE: ['Aave'], ATOM: ['Cosmos'], XLM: ['Stellar'], FIL: ['Filecoin'],
  WLD: ['Worldcoin', 'World Network'], ENA: ['Ethena'], ZEC: ['Zcash'], USDT: ['Tether'], USDC: ['Circle'], HYPE: ['Hyperliquid'],
  TAO: ['Bittensor'], XMR: ['Monero'], BCH: ['Bitcoin Cash'], ETC: ['Ethereum Classic'], ICP: ['Internet Computer'], STG: ['Stargate'],
};
// Tickers that are ordinary words; they count only through their names.
const WORD_TICKERS = new Set(['ONE', 'SUN', 'GAS', 'KEY', 'CAT', 'DOG', 'MAN', 'NOT', 'ACE', 'API', 'CEO', 'ETF', 'SEC', 'USD', 'EUR', 'THE', 'NEW', 'ALL', 'ANY', 'NOW', 'ART', 'FUN', 'HOT', 'TOP', 'WIN', 'BIG', 'LAB']);
// First words of company names that say nothing on their own.
const GENERIC_FIRST = new Set(['american', 'general', 'united', 'first', 'bank', 'global', 'international', 'national', 'the', 'new', 'royal', 'invesco', 'ishares', 'vanguard', 'spdr', 'select', 'energy', 'digital', 'capital', 'financial', 'health', 'south', 'north', 'west', 'east', 'china', 'western', 'southern', 'eastern', 'northern', 'advanced', 'applied', 'intercontinental', 'direxion', 'proshares', 'grayscale']);
const COMPANY_SUFFIX = /\b(inc|incorporated|corp|corporation|co|company|ltd|limited|plc|holdings?|group|n\.?v|s\.?a|ag|class [a-c]|etf|trust|fund|index|shares?)\b\.?/gi;

const POSITIVE = ['surge', 'surges', 'soar', 'soars', 'rally', 'rallies', 'jump', 'jumps', 'gain', 'gains', 'climb', 'climbs', 'record high', 'all-time high', 'bullish', 'approval', 'approved', 'upgrade', 'beats', 'inflows', 'rebound', 'rebounds', 'breakout', 'adoption', 'partnership', 'rises', 'rise', 'higher', 'outperform', 'recovers', 'boost'];
const NEGATIVE = ['plunge', 'plunges', 'fall', 'falls', 'drop', 'drops', 'slump', 'slumps', 'crash', 'crashes', 'bearish', 'hack', 'hacked', 'exploit', 'lawsuit', 'sues', 'ban', 'bans', 'outflows', 'liquidation', 'liquidations', 'downgrade', 'misses', 'fraud', 'investigation', 'delist', 'delisting', 'sell-off', 'selloff', 'decline', 'declines', 'warns', 'lower', 'tumbles', 'tumble', 'sinks', 'losses'];
const wordRe = (words) => new RegExp(`\\b(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'gi');
const POS_RE = wordRe(POSITIVE);
const NEG_RE = wordRe(NEGATIVE);

function tone(text) {
  const pos = (String(text).match(POS_RE) || []).length;
  const neg = (String(text).match(NEG_RE) || []).length;
  return Math.sign(pos - neg);
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', euro: '€', pound: '£' };
function cleanText(s, max = 400) {
  let t = String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, ' ');
  for (let k = 0; k < 2; k++) {
    t = t.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
      if (e[0] === '#') {
        const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ' ';
      }
      return ENTITIES[e.toLowerCase()] !== undefined ? ENTITIES[e.toLowerCase()] : m;
    });
  }
  t = t.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

const text = (v) => (v === undefined || v === null ? '' : typeof v === 'object' ? String(v['#text'] ?? '') : String(v));

// RSS 2.0, RSS 1.0 (RDF) and Atom into [{ guid, title, url, summary, published }].
function parseFeed(xml) {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', processEntities: false, textNodeName: '#text', trimValues: true, isArray: (name) => ['item', 'entry', 'link'].includes(name) });
  // No DOCTYPE: no entity definitions to expand.
  const doc = parser.parse(String(xml).replace(/<!DOCTYPE[\s\S]*?>/i, ''));
  const rssItems = (doc.rss && doc.rss.channel && doc.rss.channel.item) || (doc['rdf:RDF'] && doc['rdf:RDF'].item) || [];
  const atomItems = (doc.feed && doc.feed.entry) || [];
  if (!rssItems.length && !atomItems.length && !doc.rss && !doc.feed && !doc['rdf:RDF']) throw new Error('not an RSS or Atom feed');
  const out = [];
  for (const it of rssItems) {
    const url = (it.link || []).map(text).find((l) => /^https?:\/\//.test(l)) || '';
    const title = cleanText(text(it.title), 300);
    if (!title) continue;
    const date = new Date(text(it.pubDate || it['dc:date'] || it.published || ''));
    out.push({ guid: text(it.guid) || url || title, title, url, summary: cleanText(text(it.description || it['content:encoded'] || '')), published: Number.isNaN(date.getTime()) ? null : date });
  }
  for (const it of atomItems) {
    const links = it.link || [];
    const alt = links.find((l) => typeof l === 'object' && (!l['@_rel'] || l['@_rel'] === 'alternate')) || links[0];
    const url = alt ? (typeof alt === 'object' ? alt['@_href'] || '' : String(alt)) : '';
    const title = cleanText(text(it.title), 300);
    if (!title) continue;
    const date = new Date(text(it.published || it.updated || ''));
    out.push({ guid: text(it.id) || url || title, title, url, summary: cleanText(text(it.summary || it.content || '')), published: Number.isNaN(date.getTime()) ? null : date });
  }
  return out;
}

// A tagger for the registered instruments: text -> assets it mentions.
function buildTagger(instruments) {
  const terms = new Map(); // asset -> { ticker: RegExp|null, names: RegExp|null }
  const add = (asset, { ticker = true, names = [] }) => {
    if (!asset || !/^[A-Z0-9.^-]{1,15}$/.test(asset)) return;
    const cur = terms.get(asset) || { ticker: false, names: new Set() };
    if (ticker && asset.length >= 2 && !WORD_TICKERS.has(asset)) cur.ticker = true;
    for (const n of names) if (n && n.length >= 3) cur.names.add(n);
    terms.set(asset, cur);
  };
  for (const inst of instruments) {
    const tradfi = inst.category === 'TRADFI';
    const asset = tradfi ? String(inst.symbol).toUpperCase() : String(inst.base_asset || String(inst.symbol).split('/')[0]).toUpperCase();
    const names = [...(ALIASES[asset] || [])];
    if (inst.name && tradfi) {
      const n = String(inst.name).replace(COMPANY_SUFFIX, '').replace(/[,.()]+/g, ' ').replace(/\s+/g, ' ').trim();
      if (n.length >= 3 && n.toUpperCase() !== asset) names.push(n);
      // "Ford" for Ford Motor, "Apple" for Apple Inc.
      const first = n.split(' ')[0];
      if (first && first !== n && first.length >= 4 && !GENERIC_FIRST.has(first.toLowerCase())) names.push(first);
    } else if (inst.name && !/\//.test(inst.name) && inst.name.toUpperCase() !== asset) names.push(String(inst.name).trim());
    // One- and two-letter stock tickers (F, GE, T) only count in the $TICKER form.
    add(asset, { ticker: !tradfi || asset.length >= 3, names });
    if (tradfi && asset.length < 3) terms.get(asset).dollarOnly = true;
  }
  const compiled = [...terms.entries()].map(([asset, t]) => {
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return {
      asset,
      ticker: t.ticker ? new RegExp(`(?:^|[^A-Za-z0-9$])\\$?${esc(asset)}(?![A-Za-z0-9])`) : null,
      dollar: new RegExp(`\\$${esc(asset)}(?![A-Za-z0-9])`),
      names: t.names.size ? new RegExp(`\\b(?:${[...t.names].map(esc).join('|')})\\b`, 'i') : null,
    };
  });
  return (title, summary = '') => {
    const all = `${title} ${summary}`;
    const found = [];
    for (const c of compiled) {
      // Tickers are case-sensitive (upper case) to avoid ordinary words.
      if ((c.ticker && c.ticker.test(all)) || c.dollar.test(all) || (c.names && c.names.test(all))) found.push(c.asset);
    }
    return found.slice(0, 12);
  };
}

const titleHash = (title) => crypto.createHash('sha1').update(title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()).digest('hex');

// The asset a symbol's news is tagged with: BTC for BTC/USDT or BTC/USDT:USDT, AAPL for AAPL.
function assetOf(symbol, category) {
  const s = String(symbol || '').toUpperCase();
  if (category === 'TRADFI' || !s.includes('/')) return s;
  return s.split('/')[0];
}

function createNews({ db, log, httpFetch = (...a) => fetch(...a) }) {
  const state = { running: false, lastRunAt: null, lastResult: null };

  async function fetchText(url) {
    const res = await httpFetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.5' }, redirect: 'follow', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (!/^https:/.test(res.url || url)) throw new Error('redirected away from https');
    const body = await res.text();
    if (body.length > MAX_BYTES) throw new Error('feed larger than 3 MB');
    return body;
  }

  async function instruments() {
    const r = await db.query('SELECT symbol, name, category, base_asset FROM instrument_registry WHERE is_active IS NOT FALSE');
    return r.rows;
  }

  async function store(feed, items, tagger) {
    let added = 0;
    for (const it of items.slice(0, 200)) {
      const published = it.published && it.published.getTime() <= Date.now() + 3600000 ? it.published : new Date();
      if (Date.now() - published.getTime() > KEEP_DAYS * 86400000) continue;
      const assets = tagger(it.title, it.summary);
      const r = await db.query(
        `INSERT INTO news_items (feed_id, guid, title, title_hash, url, summary, published_at, assets, tone)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT DO NOTHING`,
        [feed.id, String(it.guid).slice(0, 500), it.title, titleHash(it.title), /^https?:\/\//.test(it.url) ? it.url.slice(0, 1000) : null, it.summary || null, published, assets, tone(`${it.title} ${it.summary}`)]
      );
      added += r.rowCount || 0;
    }
    return added;
  }

  async function refreshFeed(feed, tagger, tradfi) {
    const started = Date.now();
    try {
      let added = 0;
      let count = 0;
      if (feed.kind === 'per_symbol') {
        const tickers = tradfi.slice(0, PER_SYMBOL_LIMIT);
        for (const t of tickers) {
          try {
            const items = parseFeed(await fetchText(feed.url.replace('{ticker}', encodeURIComponent(t))));
            count += items.length;
            // Per-ticker feeds also carry general market stories, so articles are tagged by
            // what they name, like any other feed.
            added += await store(feed, items, tagger);
          } catch (e) {
            log.debug({ feed: feed.name, ticker: t, error: e.message }, 'news: per-symbol feed failed');
          }
        }
      } else {
        const items = parseFeed(await fetchText(feed.url));
        count = items.length;
        added = await store(feed, items, tagger);
      }
      await db.query('UPDATE news_feeds SET last_fetch_at = NOW(), last_ok_at = NOW(), last_error = NULL, last_items = $2 WHERE id = $1', [feed.id, count]);
      return { feed: feed.name, items: count, added, ms: Date.now() - started };
    } catch (e) {
      await db.query('UPDATE news_feeds SET last_fetch_at = NOW(), last_error = $2 WHERE id = $1', [feed.id, String(e.message).slice(0, 300)]);
      return { feed: feed.name, error: e.message };
    }
  }

  async function refresh({ feedId } = {}) {
    if (state.running) return { running: true };
    state.running = true;
    try {
      const feeds = (await db.query(`SELECT * FROM news_feeds WHERE enabled ${feedId ? 'AND id = $1' : ''} ORDER BY id`, feedId ? [feedId] : [])).rows;
      const insts = await instruments();
      const tagger = buildTagger(insts);
      const tradfi = insts.filter((i) => i.category === 'TRADFI').map((i) => String(i.symbol).toUpperCase()).filter((s) => /^[A-Z0-9.^-]{1,12}$/.test(s));
      const results = [];
      for (const f of feeds) results.push(await refreshFeed(f, tagger, tradfi));
      const pruned = await db.query(`DELETE FROM news_items WHERE published_at < NOW() - INTERVAL '${KEEP_DAYS} days'`);
      state.lastRunAt = new Date().toISOString();
      state.lastResult = { results, pruned: pruned.rowCount };
      const failed = results.filter((r) => r.error);
      log[failed.length ? 'warn' : 'info']({ added: results.reduce((s, r) => s + (r.added || 0), 0), failed: failed.map((r) => `${r.feed}: ${r.error}`) }, 'news refresh');
      return state.lastResult;
    } catch (e) {
      if (e.code === UNDEFINED_TABLE) return { installed: false };
      throw e;
    } finally {
      state.running = false;
    }
  }

  async function symbolCategory(symbol) {
    const r = await db.query('SELECT category FROM instrument_registry WHERE symbol = $1', [symbol]);
    return r.rows[0] ? r.rows[0].category : null;
  }

  // Articles about a symbol's asset; without any, the latest general ones of its kind.
  async function list({ symbol, limit = 20, feedId } = {}) {
    const query = async ({ asset, category }) => {
      const params = [limit];
      const where = [];
      if (feedId) where.push(`i.feed_id = $${params.push(feedId)}`);
      if (asset) where.push(`$${params.push(asset)} = ANY(i.assets)`);
      if (category) where.push(`f.category = $${params.push(category)}`);
      const r = await db.query(
        `SELECT i.id, i.title, i.url, i.summary, i.published_at, i.assets, i.tone, f.name AS source
         FROM news_items i JOIN news_feeds f ON f.id = i.feed_id
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY i.published_at DESC LIMIT $1`,
        params
      );
      return r.rows;
    };
    if (!symbol) return { asset: null, general: false, items: await query({}) };
    const cat = await symbolCategory(symbol);
    const asset = assetOf(symbol, cat);
    const items = await query({ asset });
    if (items.length) return { asset, general: false, items };
    return { asset, general: true, items: await query({ category: cat === 'TRADFI' ? 'markets' : 'crypto' }) };
  }

  // Mentions and keyword tone of the last 24 hours, for the insights card.
  async function summary(symbol) {
    const cat = await symbolCategory(symbol);
    const asset = assetOf(symbol, cat);
    const r = await db.query(
      `SELECT count(*)::int AS n, count(*) FILTER (WHERE tone > 0)::int AS pos, count(*) FILTER (WHERE tone < 0)::int AS neg,
              count(*) FILTER (WHERE published_at > NOW() - INTERVAL '24 hours')::int AS n24
       FROM news_items WHERE $1 = ANY(assets) AND published_at > NOW() - INTERVAL '7 days'`,
      [asset]
    );
    return { asset, ...r.rows[0] };
  }

  async function feeds() {
    const r = await db.query(
      `SELECT f.*, (SELECT count(*)::int FROM news_items i WHERE i.feed_id = f.id) AS stored,
              (SELECT max(published_at) FROM news_items i WHERE i.feed_id = f.id) AS latest
       FROM news_feeds f ORDER BY f.id`
    );
    return r.rows;
  }

  function checkFeed(b, partial) {
    const out = {};
    if (!partial || b.name !== undefined) {
      if (typeof b.name !== 'string' || !b.name.trim() || b.name.length > 60) throw badRequest('name: 1 to 60 characters');
      out.name = b.name.trim();
    }
    if (!partial || b.url !== undefined) {
      let u;
      try {
        u = new URL(String(b.url));
      } catch (e) {
        throw badRequest('url: not a valid URL');
      }
      if (u.protocol !== 'https:') throw badRequest('url: feeds must use https');
      if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(u.hostname) || u.hostname.endsWith('.ts.net')) throw badRequest('url: private addresses are not allowed');
      out.url = String(b.url);
    }
    if (b.kind !== undefined) {
      if (!['feed', 'per_symbol'].includes(b.kind)) throw badRequest('kind: feed or per_symbol');
      out.kind = b.kind;
    }
    if ((out.kind || b.kindBefore) === 'per_symbol' && out.url && !out.url.includes('{ticker}')) throw badRequest('url: a per-symbol feed needs {ticker} in its URL');
    if (b.category !== undefined) {
      if (!['crypto', 'markets', 'other'].includes(b.category)) throw badRequest('category: crypto, markets or other');
      out.category = b.category;
    }
    if (b.enabled !== undefined) out.enabled = !!b.enabled;
    return out;
  }

  async function createFeed(body) {
    const v = checkFeed(body, false);
    const r = await db
      .query('INSERT INTO news_feeds (name, url, kind, category, enabled) VALUES ($1, $2, $3, $4, $5) RETURNING *', [v.name, v.url, v.kind || 'feed', v.category || 'crypto', v.enabled !== false])
      .catch(onDuplicate('A feed with this name or URL exists'));
    return r.rows[0];
  }

  async function updateFeed(id, body) {
    const before = (await db.query('SELECT * FROM news_feeds WHERE id = $1', [id])).rows[0];
    if (!before) throw notFound('Feed not found');
    const v = checkFeed({ ...body, kindBefore: before.kind }, true);
    const merged = { ...before, ...v };
    if (merged.kind === 'per_symbol' && !merged.url.includes('{ticker}')) throw badRequest('url: a per-symbol feed needs {ticker} in its URL');
    const r = await db
      .query('UPDATE news_feeds SET name = $2, url = $3, kind = $4, category = $5, enabled = $6 WHERE id = $1 RETURNING *', [id, merged.name, merged.url, merged.kind, merged.category, merged.enabled])
      .catch(onDuplicate('A feed with this name or URL exists'));
    return { before, after: r.rows[0] };
  }

  async function removeFeed(id) {
    const r = await db.query('DELETE FROM news_feeds WHERE id = $1 RETURNING *', [id]);
    if (!r.rows[0]) throw notFound('Feed not found');
    return r.rows[0];
  }

  return { refresh, list, summary, feeds, createFeed, updateFeed, removeFeed, status: () => ({ ...state }) };
}

module.exports = { createNews, parseFeed, buildTagger, tone, cleanText, assetOf, titleHash };
