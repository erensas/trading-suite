#!/usr/bin/env node
// Populates the instrument registry and its data sources from what the trading engines are
// mapped to (instrument_registry, instrument_listings, watchlist_items):
//
//   A. the main Freqtrade bot's pair whitelist -> CEX (or CEX_FUTURES) instruments with the
//      exchange's own provider and the Freqtrade Bot provider as sources;
//   B. the Web3 engine's core pools per network (STATIC_CORE_POOLS in web3-dex-bot) -> DEX
//      instruments with one GeckoTerminal source per pool, the first core pool leading;
//   C. the Web3 engine's token registry per network (TOKEN_REGISTRY) -> one DEX instrument per
//      token on the most liquid WETH or stablecoin pool GeckoTerminal finds on that network;
//   D. every CEX, CEX_FUTURES and TRADFI instrument gets the sources of the other providers
//      that carry it (Binance, OKX, Bybit, Yahoo); registry rows without a source get their
//      primary one;
//   E. DEX rows get their network from their first source, and route_type DEX.
//
// New instruments go on the starter watchlists (Crypto spot / Crypto futures and Main, DEX
// pools). Nothing is removed or renamed, with one exception: a DEX row that occupies the
// symbol of a whitelisted exchange pair (ETH/USDT as a Uniswap pool) is renamed to its wrapped
// form (WETH/USDT) so the exchange pair can be registered.
//
//   node tools/populate_instruments.js --dry-run      print the plan, change nothing
//   node tools/populate_instruments.js                apply it
//   --web3 <arbitrage_scanner.py>   the Web3 map (default: next to SUPERVISOR_LOG_PATH)
//   --no-web3                       skip phases B and C
//   --skip-tokens                   skip phase C (one GeckoTerminal search per token, ~6.5 s each)
//   --skip-candidates               skip phase D
//
// Runs as the service user with the suite's own configuration (the same database and
// providers); every change is recorded in suite_audit_log.
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

// GeckoTerminal network ids for the Web3 engine's network names.
const GECKO_NETWORK = {
  ethereum: 'eth', arbitrum: 'arbitrum', base: 'base', optimism: 'optimism', polygon: 'polygon_pos', bsc: 'bsc',
  avalanche: 'avax', fantom: 'fantom', linea: 'linea', scroll: 'scroll',
};
const geckoNetwork = (name) => GECKO_NETWORK[String(name || '').toLowerCase()] || String(name || '').toLowerCase();
const NETWORK_ORDER = ['ethereum', 'arbitrum', 'base'];
const STABLES = new Set(['USDC', 'USDC.E', 'USDT', 'USDT0', 'USD₮', 'USD₮0', 'DAI', 'USDE', 'FRAX', 'FDUSD', 'TUSD', 'USDS', 'LUSD', 'GHO']);
const WRAPPED_NATIVE = new Set(['WETH', 'WBNB', 'WMATIC', 'WPOL', 'WAVAX', 'WFTM']);
const PREFERRED_QUOTES = new Set(['WETH', 'ETH', ...STABLES]);
const RENAMABLE_BASES = new Set(['ETH', 'BTC', 'SOL', 'BNB']);

const upper = (s) => String(s || '').toUpperCase();

// A pool's two tokens as an instrument symbol: the non-stable token is the base.
function poolSymbol(token0, token1) {
  const a = upper(token0);
  const b = upper(token1);
  if (STABLES.has(a) && !STABLES.has(b)) return { base: b, quote: a };
  return { base: a, quote: b };
}

// uniswap_v3_005 -> uniswap_v3, sushiswap_v2_03 -> sushiswap_v2.
const dexFamily = (dex) => String(dex || '').split('_').slice(0, 2).join('_') || null;

// The most liquid pool of a token on a network among GeckoTerminal search rows, pools against
// WETH or a stablecoin first, then pools that list the token as their base.
function pickTokenPool(rows, tokenSymbol, network) {
  const SYM = upper(tokenSymbol);
  const candidates = (rows || [])
    .filter((r) => r.network === network)
    .map((r) => {
      if (upper(r.base) === SYM) return { ...r, quote: upper(r.quote), inverted: false };
      if (upper(r.quote) === SYM) return { ...r, quote: upper(r.base), inverted: true };
      return null;
    })
    .filter(Boolean);
  const rank = (r) => (PREFERRED_QUOTES.has(r.quote) ? 2 : 0) + (r.inverted ? 0 : 1);
  candidates.sort((a, b) => rank(b) - rank(a) || (b.liquidity_usd || 0) - (a.liquidity_usd || 0));
  return candidates[0] || null;
}

const networkOrder = (map) => [...NETWORK_ORDER.filter((n) => map && map[n]), ...Object.keys(map || {}).filter((n) => !NETWORK_ORDER.includes(n))];

// The Web3 engine's map through tools/web3_markets.py; null when the file is missing.
function readWeb3Map(scannerPath) {
  if (!scannerPath || !fs.existsSync(scannerPath)) return null;
  const out = execFileSync('python3', [path.join(__dirname, 'web3_markets.py'), scannerPath], { encoding: 'utf8', timeout: 20000 });
  return JSON.parse(out);
}

function createPopulator(ctx, { dryRun = false, log = console.log } = {}) {
  const counts = { instruments: 0, sources: 0, watchlist: 0, renames: 0, primaries: 0, backfilled: 0, fixes: 0 };
  const notes = [];
  const state = { providers: [], registry: new Map(), watchlists: new Map(), items: new Map() };
  const say = (phase, line) => log(`${phase}  ${line}`);

  async function load() {
    state.providers = await ctx.providers.list();
    state.registry = new Map();
    for (const inst of await ctx.instruments.list()) {
      state.registry.set(upper(inst.symbol), { inst, listings: await ctx.instruments.listings(inst.symbol), planned: false });
    }
    state.watchlists = new Map((await ctx.watchlists.list()).map((w) => [w.name, w]));
    state.items = new Map();
    for (const w of state.watchlists.values()) state.items.set(w.name, new Set((await ctx.watchlists.items(w.id)).map((i) => upper(i.symbol))));
  }
  const provider = (kind) => state.providers.find((p) => p.kind === kind && p.enabled) || null;
  const entry = (symbol) => state.registry.get(upper(symbol)) || null;
  const listingNetwork = (l) => l.network || (String(l.provider_symbol || '').includes(':') ? String(l.provider_symbol).split(':')[0] : null);

  async function ensureInstrument(phase, body) {
    const found = entry(body.symbol);
    if (found) return found.inst.symbol;
    const symbol = upper(body.symbol);
    say(phase, `+ instrument ${symbol} (${body.category}${body.exchange ? `, ${body.exchange}` : ''}${body.network ? `, ${body.network}` : ''})`);
    counts.instruments += 1;
    if (!dryRun) await ctx.instruments.create({ ...body, symbol, is_active: true });
    state.registry.set(symbol, { inst: { ...body, symbol }, listings: [], planned: true });
    return symbol;
  }

  async function ensureSource(phase, symbol, p, providerSymbol, network) {
    const e = entry(symbol);
    if (!e || !p) return false;
    if (e.listings.some((l) => l.provider_id === p.id && (l.provider_symbol || '') === (providerSymbol || ''))) return false;
    say(phase, `+ source ${e.inst.symbol} <- ${p.name}${providerSymbol ? ` ${providerSymbol}` : ''}${network ? ` (${network})` : ''}`);
    counts.sources += 1;
    let row = { id: null, provider_id: p.id, provider_symbol: providerSymbol || null, network: network || null, priority: e.listings.length, enabled: true };
    if (!dryRun) row = await ctx.instruments.addListing(e.inst.symbol, { provider_id: p.id, provider_symbol: providerSymbol || null, network: network || null });
    e.listings.push(row);
    return true;
  }

  async function ensureWatch(phase, name, symbol) {
    const w = state.watchlists.get(name);
    if (!w) return;
    const set = state.items.get(name);
    if (set.has(upper(symbol))) return;
    say(phase, `+ watchlist ${name}: ${upper(symbol)}`);
    counts.watchlist += 1;
    if (!dryRun) await ctx.watchlists.addItem(w.id, upper(symbol));
    set.add(upper(symbol));
  }

  // Moves the source with this provider symbol to the top (the chart's default).
  async function makePrimary(phase, symbol, providerSymbol) {
    const e = entry(symbol);
    if (!e) return;
    const idx = e.listings.findIndex((l) => (l.provider_symbol || '') === providerSymbol);
    if (idx <= 0) return;
    say(phase, `~ primary source of ${e.inst.symbol}: ${providerSymbol}`);
    counts.primaries += 1;
    const order = [e.listings[idx], ...e.listings.filter((_, i) => i !== idx)];
    if (!dryRun) {
      const fresh = await ctx.instruments.listings(e.inst.symbol);
      const idOf = (l) => (fresh.find((f) => f.provider_id === l.provider_id && (f.provider_symbol || '') === (l.provider_symbol || '')) || {}).id;
      const ids = order.map(idOf).filter((id) => id != null);
      if (ids.length === fresh.length) await ctx.instruments.reorderListings(e.inst.symbol, ids);
    }
    e.listings = order;
  }

  function exchangeProvider(exchange, futures) {
    if (exchange === 'binance') {
      const p = provider(futures ? 'binance_futures' : 'binance');
      return p ? { provider: p, symbol: (b, q) => `${b}${q}` } : null;
    }
    if (exchange === 'bybit') {
      const p = provider('bybit');
      const category = p && p.config ? p.config.category : null;
      return p && category === (futures ? 'linear' : 'spot') ? { provider: p, symbol: (b, q) => `${b}${q}` } : null;
    }
    if (exchange === 'okx') {
      const p = provider('okx');
      const instType = p && p.config ? p.config.instType : null;
      return p && instType === (futures ? 'SWAP' : 'SPOT') ? { provider: p, symbol: (b, q) => (futures ? `${b}-${q}-SWAP` : `${b}-${q}`) } : null;
    }
    return null;
  }

  // ---- A: the main bot's whitelist ---------------------------------------------------------
  async function phaseA() {
    let cfg;
    let wl;
    try {
      [cfg, wl] = await Promise.all([ctx.freqtrade.api('GET', '/show_config'), ctx.freqtrade.api('GET', '/whitelist')]);
    } catch (e) {
      notes.push(`A: Freqtrade API not reachable, whitelist pairs skipped (${e.message})`);
      return;
    }
    const exchange = String(cfg.exchange || '').toLowerCase();
    const futuresMode = String(cfg.trading_mode || 'spot').toLowerCase() === 'futures';
    const pairs = Array.isArray(wl.whitelist) ? wl.whitelist : [];
    say('A', `Freqtrade ${exchange || '?'} ${futuresMode ? 'futures' : 'spot'} whitelist: ${pairs.join(', ') || '(empty)'}`);
    const bot = provider('freqtrade');
    for (const pair of pairs) {
      const symbol = upper(pair);
      const [base, rest = ''] = symbol.split('/');
      const quote = rest.split(':')[0] || upper(cfg.stake_currency) || 'USDT';
      const futures = futuresMode || symbol.includes(':');
      const clash = entry(symbol);
      if (clash && clash.inst.category === 'DEX') {
        const wrapped = `W${base}/${rest}`;
        if (!RENAMABLE_BASES.has(base) || entry(wrapped)) {
          notes.push(`A: ${symbol} is registered as a DEX instrument and ${wrapped} is taken; the bot's pair was not added`);
          continue;
        }
        say('A', `~ rename DEX instrument ${clash.inst.symbol} -> ${wrapped} (${symbol} is the bot's exchange pair)`);
        counts.renames += 1;
        if (!dryRun) await ctx.db.query('UPDATE instrument_registry SET symbol = $2, base_asset = $3, updated_at = NOW() WHERE symbol = $1', [clash.inst.symbol, wrapped, `W${base}`]);
        state.registry.delete(symbol);
        clash.inst = { ...clash.inst, symbol: wrapped, base_asset: `W${base}` };
        state.registry.set(wrapped, clash);
        for (const set of state.items.values()) if (set.delete(symbol)) set.add(wrapped);
      }
      await ensureInstrument('A', { symbol, category: futures ? 'CEX_FUTURES' : 'CEX', name: `${symbol} on ${exchange}`, base_asset: base, quote_asset: quote, exchange });
      const ex = exchangeProvider(exchange, futures);
      if (ex) await ensureSource('A', symbol, ex.provider, ex.symbol(base, quote));
      if (bot) await ensureSource('A', symbol, bot, pair);
      await ensureWatch('A', futures ? 'Crypto futures' : 'Crypto spot', symbol);
      await ensureWatch('A', 'Main', symbol);
    }
  }

  // ---- B: the Web3 engine's core pools -----------------------------------------------------
  async function phaseB(web3) {
    const gecko = provider('geckoterminal');
    if (!web3 || !gecko) {
      notes.push('B: no Web3 map or no GeckoTerminal provider; core pools skipped');
      return;
    }
    const led = new Set();
    for (const network of networkOrder(web3.core_pools)) {
      const G = geckoNetwork(network);
      const pools = web3.core_pools[network] || [];
      const tokens = web3.tokens[network] || {};
      say('B', `${network} (${G}): ${pools.length} core pools`);
      for (const pool of pools) {
        const { base, quote } = poolSymbol(pool.token0, pool.token1);
        const symbol = `${base}/${quote}`;
        const token = Object.entries(tokens).find(([sym]) => upper(sym) === base);
        await ensureInstrument('B', {
          symbol, category: 'DEX', name: `${symbol} · Web3 engine core pools`, base_asset: base, quote_asset: quote,
          exchange: dexFamily(pool.dex), contract_address: token ? token[1].address : null, network: G,
        });
        const providerSymbol = `${G}:${String(pool.address).toLowerCase()}`;
        await ensureSource('B', symbol, gecko, providerSymbol, G);
        if (!led.has(symbol)) {
          led.add(symbol);
          await makePrimary('B', symbol, providerSymbol);
        }
        await ensureWatch('B', 'DEX pools', symbol);
      }
    }
  }

  // ---- C: the Web3 engine's token registry ---------------------------------------------------
  function hasDexSource(tokenSymbol, network) {
    for (const e of state.registry.values()) {
      if (e.inst.category !== 'DEX') continue;
      const base = upper(e.inst.base_asset || String(e.inst.symbol).split('/')[0]);
      if (base === tokenSymbol && e.listings.some((l) => listingNetwork(l) === network)) return true;
    }
    return false;
  }

  async function phaseC(web3) {
    const gecko = provider('geckoterminal');
    if (!web3 || !gecko) return;
    for (const network of networkOrder(web3.tokens)) {
      const G = geckoNetwork(network);
      for (const [sym, token] of Object.entries(web3.tokens[network] || {})) {
        const SYM = upper(sym);
        if (STABLES.has(SYM) || WRAPPED_NATIVE.has(SYM)) continue;
        if (hasDexSource(SYM, G)) {
          say('C', `= ${SYM} on ${G} already has a source`);
          continue;
        }
        let rows;
        try {
          rows = await ctx.providers.call(gecko, 'search', token.address);
        } catch (e) {
          notes.push(`C: ${SYM} on ${G}: ${e.message}`);
          continue;
        }
        const pick = pickTokenPool(rows, SYM, G);
        if (!pick) {
          notes.push(`C: ${SYM} on ${G}: GeckoTerminal lists no pool for ${token.address}`);
          continue;
        }
        const symbol = `${SYM}/${pick.quote}`;
        await ensureInstrument('C', {
          symbol, category: 'DEX', name: String(pick.name || symbol).slice(0, 100), base_asset: SYM, quote_asset: pick.quote,
          contract_address: token.address, network: G,
        });
        await ensureSource('C', symbol, gecko, pick.provider_symbol, G);
        await ensureWatch('C', 'DEX pools', symbol);
      }
    }
  }

  // ---- D: the other providers that carry each instrument --------------------------------------
  async function phaseD() {
    if (dryRun) {
      const r = await ctx.db.query(
        'SELECT count(*)::int AS n FROM instrument_registry ir WHERE ir.provider_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM instrument_listings l WHERE l.symbol = ir.symbol)'
      );
      counts.backfilled = r.rows[0].n;
      if (counts.backfilled) say('D', `${counts.backfilled} registry rows would get their primary source (backfill)`);
    } else {
      counts.backfilled = await ctx.instruments.backfillListings();
      if (counts.backfilled) say('D', `${counts.backfilled} registry rows got their primary source (backfill)`);
      await load();
    }
    const errors = new Map();
    let planned = 0;
    for (const e of [...state.registry.values()]) {
      if (!['CEX', 'CEX_FUTURES', 'TRADFI'].includes(e.inst.category)) continue;
      if (e.planned) {
        planned += 1;
        continue;
      }
      let res;
      try {
        res = await ctx.search.candidates(e.inst.symbol);
      } catch (err) {
        errors.set(e.inst.symbol, err.message);
        continue;
      }
      if (!res) continue;
      for (const m of res.matches) await ensureSource('D', e.inst.symbol, state.providers.find((p) => p.id === m.provider_id), m.provider_symbol, m.network);
      for (const err of res.errors || []) errors.set(err.provider, err.error);
    }
    if (planned) say('D', `${planned} new instruments get their other sources on the real run`);
    for (const [k, v] of errors) notes.push(`D: ${k}: ${v}`);
  }

  // ---- E: registry rows of DEX instruments -----------------------------------------------------
  async function phaseE() {
    if (!dryRun) await load();
    for (const e of state.registry.values()) {
      if (e.inst.category !== 'DEX' || e.inst.network || !e.listings.length) continue;
      const network = listingNetwork(e.listings[0]);
      if (!network) continue;
      say('E', `~ ${e.inst.symbol}: network ${network}`);
      counts.fixes += 1;
      if (!dryRun) await ctx.instruments.update(e.inst.symbol, { network });
    }
    const sql = dryRun
      ? "SELECT count(*)::int AS n FROM instrument_registry WHERE category = 'DEX' AND route_type IS DISTINCT FROM 'DEX'"
      : "UPDATE instrument_registry SET route_type = 'DEX' WHERE category = 'DEX' AND route_type IS DISTINCT FROM 'DEX'";
    const r = await ctx.db.query(sql);
    const n = dryRun ? r.rows[0].n : r.rowCount || 0;
    if (n) {
      say('E', `~ route_type DEX on ${n} DEX rows`);
      counts.fixes += n;
    }
  }

  async function finish() {
    const summary = { ...counts, notes };
    if (!dryRun) {
      await ctx.db
        .query('INSERT INTO suite_audit_log (actor, action, entity, entity_id, before, after) VALUES ($1, $2, $3, $4, $5, $6)', [
          'tools/populate_instruments.js', 'populate', 'instruments', null, null, summary,
        ])
        .catch((e) => notes.push(`audit entry not stored: ${e.message}`));
    }
    return summary;
  }

  return { load, phaseA, phaseB, phaseC, phaseD, phaseE, finish, state, counts, notes };
}

function parseArgs(argv) {
  const opts = { dryRun: false, web3: null, noWeb3: false, skipTokens: false, skipCandidates: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--web3') opts.web3 = argv[(i += 1)];
    else if (a === '--no-web3') opts.noWeb3 = true;
    else if (a === '--skip-tokens') opts.skipTokens = true;
    else if (a === '--skip-candidates') opts.skipCandidates = true;
    else throw new Error(`unknown option ${a}`);
  }
  return opts;
}

async function main(argv) {
  const opts = parseArgs(argv);
  const { createContext } = require('../src/context');
  const ctx = createContext();
  try {
    const pop = createPopulator(ctx, { dryRun: opts.dryRun });
    console.log(opts.dryRun ? 'DRY RUN: nothing is written' : 'populating instruments and sources');
    await pop.load();
    await pop.phaseA();
    let web3 = null;
    if (!opts.noWeb3) {
      const scanner = opts.web3 || path.join(path.dirname(ctx.config.supervisorLogPath), 'arbitrage_scanner.py');
      web3 = readWeb3Map(scanner);
      if (!web3) pop.notes.push(`B/C: Web3 map not found at ${scanner} (use --web3 <path> or --no-web3)`);
    }
    await pop.phaseB(web3);
    if (!opts.skipTokens) await pop.phaseC(web3);
    if (!opts.skipCandidates) await pop.phaseD();
    await pop.phaseE();
    const summary = await pop.finish();
    const { notes, ...c } = summary;
    console.log(`\n${opts.dryRun ? 'planned' : 'done'}: ${Object.entries(c).map(([k, v]) => `${k} ${v}`).join(', ')}`);
    for (const n of notes) console.log(`note: ${n}`);
    return 0;
  } finally {
    await ctx.db.end().catch(() => {});
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(`populate: ${e.message}`);
      process.exit(1);
    }
  );
}

module.exports = { createPopulator, poolSymbol, dexFamily, pickTokenPool, geckoNetwork, networkOrder, readWeb3Map, parseArgs };
