// tools/populate_instruments.js: symbol helpers and the phases on fake services.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPopulator, poolSymbol, dexFamily, pickTokenPool, geckoNetwork, networkOrder, parseArgs } = require('../../tools/populate_instruments');

test('helpers: pool symbols, dex families, networks, options', () => {
  assert.deepEqual(poolSymbol('USDC', 'WETH'), { base: 'WETH', quote: 'USDC' }, 'the stablecoin is the quote');
  assert.deepEqual(poolSymbol('WETH', 'USDC'), { base: 'WETH', quote: 'USDC' });
  assert.deepEqual(poolSymbol('WETH', 'ARB'), { base: 'WETH', quote: 'ARB' }, 'two volatile tokens keep the pool order');
  assert.equal(dexFamily('uniswap_v3_005'), 'uniswap_v3');
  assert.equal(dexFamily('sushiswap_v2_03'), 'sushiswap_v2');
  assert.equal(dexFamily('uniswap_v3_005_arb'), 'uniswap_v3');
  assert.equal(geckoNetwork('ethereum'), 'eth');
  assert.equal(geckoNetwork('Base'), 'base');
  assert.equal(geckoNetwork('polygon'), 'polygon_pos');
  assert.deepEqual(networkOrder({ base: 1, zk: 1, ethereum: 1 }), ['ethereum', 'base', 'zk']);
  assert.deepEqual(parseArgs(['--dry-run', '--skip-tokens']), { dryRun: true, web3: null, noWeb3: false, skipTokens: true, skipCandidates: false });
  assert.throws(() => parseArgs(['--bogus']), /unknown option/);
});

test('pickTokenPool: same network, WETH or stablecoin quote first, then liquidity', () => {
  const rows = [
    { network: 'base', base: 'AERO', quote: 'VIRTUAL', provider_symbol: 'base:0x1', liquidity_usd: 9e6 },
    { network: 'base', base: 'AERO', quote: 'USDC', provider_symbol: 'base:0x2', liquidity_usd: 2e6 },
    { network: 'base', base: 'WETH', quote: 'AERO', provider_symbol: 'base:0x3', liquidity_usd: 5e6 },
    { network: 'eth', base: 'AERO', quote: 'WETH', provider_symbol: 'eth:0x4', liquidity_usd: 8e6 },
  ];
  const pick = pickTokenPool(rows, 'aero', 'base');
  assert.equal(pick.provider_symbol, 'base:0x2', 'a direct pool against a stablecoin beats the inverted WETH pool and the exotic quote');
  assert.equal(pick.quote, 'USDC');
  const inverted = pickTokenPool(rows.filter((r) => r.provider_symbol !== 'base:0x2'), 'AERO', 'base');
  assert.equal(inverted.provider_symbol, 'base:0x3', 'an inverted pool (token as the pool quote) is still usable');
  assert.equal(inverted.quote, 'WETH');
  assert.equal(pickTokenPool(rows, 'AERO', 'arbitrum'), null);
});

// In-memory stand-ins for the services the tool uses.
function fakeCtx({ registry = [], listings = {}, providers, whitelist, geckoRows = [], candidates = {} } = {}) {
  const calls = { create: [], addListing: [], addItem: [], reorder: [], update: [], sql: [] };
  const rows = new Map(registry.map((r) => [r.symbol, { ...r }]));
  const lst = new Map(Object.entries(listings).map(([s, l]) => [s, l.map((x, i) => ({ id: i + 1, priority: i, enabled: true, ...x }))]));
  let nextId = 100;
  const items = { Main: [], 'Crypto spot': [], 'Crypto futures': [], 'DEX pools': [] };
  const wl = Object.keys(items).map((name, i) => ({ id: i + 1, name }));
  const ctx = {
    providers: { list: async () => providers, call: async (p, method, q) => (method === 'search' ? geckoRows.filter((r) => r.query === q).map(({ query, ...r }) => r) : []) },
    instruments: {
      list: async () => [...rows.values()],
      listings: async (symbol) => lst.get(symbol) || [],
      create: async (body) => {
        calls.create.push(body);
        rows.set(body.symbol, { ...body });
      },
      addListing: async (symbol, body) => {
        calls.addListing.push({ symbol, ...body });
        const row = { id: (nextId += 1), priority: (lst.get(symbol) || []).length, enabled: true, ...body };
        lst.set(symbol, [...(lst.get(symbol) || []), row]);
        return row;
      },
      reorderListings: async (symbol, ids) => {
        calls.reorder.push({ symbol, ids });
        const cur = lst.get(symbol) || [];
        lst.set(symbol, ids.map((id, i) => ({ ...cur.find((l) => l.id === id), priority: i })));
      },
      update: async (symbol, body) => calls.update.push({ symbol, ...body }),
      backfillListings: async () => 0,
    },
    watchlists: {
      list: async () => wl,
      items: async (id) => items[wl.find((w) => w.id === id).name].map((symbol) => ({ symbol })),
      addItem: async (id, symbol) => {
        calls.addItem.push({ id, symbol });
        items[wl.find((w) => w.id === id).name].push(symbol);
      },
    },
    freqtrade: {
      api: async (method, apiPath) => {
        if (!whitelist) throw new Error('bot down');
        if (apiPath === '/show_config') return { exchange: 'binance', trading_mode: 'spot', stake_currency: 'USDT' };
        if (apiPath === '/whitelist') return { whitelist };
        throw new Error(`no ${apiPath}`);
      },
    },
    search: { candidates: async (symbol) => candidates[symbol] || { matches: [], errors: [] } },
    db: {
      query: async (sql, params) => {
        calls.sql.push({ sql, params });
        if (/UPDATE instrument_registry SET symbol/.test(sql)) {
          const row = rows.get(params[0]);
          rows.delete(params[0]);
          rows.set(params[1], { ...row, symbol: params[1], base_asset: params[2] });
          lst.set(params[1], lst.get(params[0]) || []);
          lst.delete(params[0]);
        }
        if (/count\(\*\)/.test(sql)) return { rows: [{ n: 0 }] };
        return { rows: [], rowCount: 0 };
      },
    },
  };
  return { ctx, calls, rows, lst, items };
}

const PROVIDERS = [
  { id: 1, kind: 'binance', name: 'Binance Spot', enabled: true, config: {} },
  { id: 3, kind: 'okx', name: 'OKX', enabled: true, config: { instType: 'SWAP' } },
  { id: 5, kind: 'geckoterminal', name: 'GeckoTerminal (DEX)', enabled: true, config: {} },
  { id: 7, kind: 'freqtrade', name: 'Freqtrade Bot', enabled: true, config: {} },
];
const WEB3 = {
  networks: { ethereum: { name: 'Ethereum L1' }, arbitrum: { name: 'Arbitrum One' } },
  tokens: {
    ethereum: { WETH: { address: '0xweth', is_stable: false }, USDC: { address: '0xusdc', is_stable: true }, PENDLE: { address: '0xpendle', is_stable: false } },
    arbitrum: { WETH: { address: '0xaweth', is_stable: false }, ARB: { address: '0xarb', is_stable: false } },
  },
  core_pools: {
    ethereum: [
      { dex: 'uniswap_v3_005', address: '0xE1', token0: 'USDC', token1: 'WETH' },
      { dex: 'sushiswap_v2_03', address: '0xE2', token0: 'USDC', token1: 'WETH' },
    ],
    arbitrum: [{ dex: 'uniswap_v3_005_arb', address: '0xA1', token0: 'WETH', token1: 'ARB' }],
  },
};

test('phase A: whitelist pairs become CEX instruments with the exchange and bot sources; a DEX row in the way is renamed', async () => {
  const quiet = () => {};
  const f = fakeCtx({
    registry: [
      { symbol: 'ETH/USDT', category: 'DEX', base_asset: 'ETH', quote_asset: 'USDT', exchange: 'Uniswap v3' },
      { symbol: 'SOL/USDT', category: 'CEX', base_asset: 'SOL', quote_asset: 'USDT', exchange: 'binance' },
    ],
    listings: { 'ETH/USDT': [{ provider_id: 5, provider_symbol: 'eth:0xpool', network: 'eth' }], 'SOL/USDT': [{ provider_id: 4, provider_symbol: 'SOLUSDT', network: null }] },
    providers: PROVIDERS,
    whitelist: ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'],
  });
  const pop = createPopulator(f.ctx, { log: quiet });
  await pop.load();
  await pop.phaseA();
  assert.ok(f.rows.has('WETH/USDT') && !f.rows.has('ETH/USDT') || f.rows.get('ETH/USDT').category === 'CEX', 'the DEX row moved to WETH/USDT');
  assert.equal(f.rows.get('WETH/USDT').category, 'DEX');
  assert.deepEqual(f.lst.get('WETH/USDT').map((l) => l.provider_symbol), ['eth:0xpool'], 'its pool source moved with it');
  assert.deepEqual(f.calls.create.map((c) => [c.symbol, c.category, c.exchange]), [['BTC/USDT', 'CEX', 'binance'], ['ETH/USDT', 'CEX', 'binance']]);
  assert.deepEqual(
    f.calls.addListing.map((l) => `${l.symbol}:${l.provider_id}:${l.provider_symbol}`),
    ['BTC/USDT:1:BTCUSDT', 'BTC/USDT:7:BTC/USDT', 'ETH/USDT:1:ETHUSDT', 'ETH/USDT:7:ETH/USDT', 'SOL/USDT:1:SOLUSDT', 'SOL/USDT:7:SOL/USDT'],
    'Binance first, then the bot; the existing Bybit source of SOL/USDT is kept'
  );
  assert.deepEqual(f.items['Crypto spot'], ['BTC/USDT', 'ETH/USDT', 'SOL/USDT']);
  assert.deepEqual(f.items.Main, ['BTC/USDT', 'ETH/USDT', 'SOL/USDT']);
  assert.equal(pop.counts.renames, 1);
  assert.equal(pop.counts.instruments, 2);
});

test('phase B and C: core pools become one DEX instrument per pair with a source per pool; tokens get their best pool', async () => {
  const quiet = () => {};
  const f = fakeCtx({
    registry: [{ symbol: 'WETH/USDC', category: 'DEX', base_asset: 'WETH', quote_asset: 'USDC', network: null }],
    listings: { 'WETH/USDC': [{ provider_id: 5, provider_symbol: 'arc:0xodd', network: 'arc' }] },
    providers: PROVIDERS,
    geckoRows: [
      { query: '0xpendle', network: 'eth', base: 'PENDLE', quote: 'WETH', provider_symbol: 'eth:0xp1', liquidity_usd: 3e6, name: 'PENDLE / WETH 0.3%' },
      { query: '0xpendle', network: 'arbitrum', base: 'PENDLE', quote: 'WETH', provider_symbol: 'arbitrum:0xp2', liquidity_usd: 9e6, name: 'PENDLE / WETH' },
      { query: '0xarb', network: 'arbitrum', base: 'ARB', quote: 'USDC', provider_symbol: 'arbitrum:0xa2', liquidity_usd: 1e6, name: 'ARB / USDC' },
    ],
  });
  const pop = createPopulator(f.ctx, { log: quiet });
  await pop.load();
  await pop.phaseB(WEB3);
  assert.deepEqual(f.calls.create.map((c) => [c.symbol, c.category, c.exchange, c.network, c.contract_address]), [['WETH/ARB', 'DEX', 'uniswap_v3', 'arbitrum', '0xaweth']]);
  assert.deepEqual(
    f.lst.get('WETH/USDC').map((l) => l.provider_symbol),
    ['eth:0xe1', 'arc:0xodd', 'eth:0xe2'],
    'the first core pool leads the existing instrument, the others follow'
  );
  assert.deepEqual(f.calls.reorder, [{ symbol: 'WETH/USDC', ids: [101, 1] }], 'reordered as soon as the first core pool is in');
  assert.deepEqual(f.lst.get('WETH/ARB').map((l) => l.provider_symbol), ['arbitrum:0xa1']);
  assert.deepEqual(f.items['DEX pools'], ['WETH/USDC', 'WETH/ARB']);
  await pop.phaseC(WEB3);
  assert.deepEqual(
    f.calls.create.slice(1).map((c) => [c.symbol, c.network, c.contract_address]),
    [['PENDLE/WETH', 'eth', '0xpendle'], ['ARB/USDC', 'arbitrum', '0xarb']],
    'one instrument per token on its own network; WETH and USDC are skipped'
  );
  assert.deepEqual(f.lst.get('PENDLE/WETH').map((l) => l.provider_symbol), ['eth:0xp1'], 'the pool on the token network, not the bigger one elsewhere');
  assert.equal(pop.counts.sources, 5);
});

test('dry run: the plan is printed and nothing is written', async () => {
  const lines = [];
  const f = fakeCtx({ providers: PROVIDERS, whitelist: ['BTC/USDT'] });
  const pop = createPopulator(f.ctx, { dryRun: true, log: (l) => lines.push(l) });
  await pop.load();
  await pop.phaseA();
  await pop.phaseB(WEB3);
  await pop.phaseD();
  await pop.phaseE();
  const summary = await pop.finish();
  assert.equal(f.calls.create.length + f.calls.addListing.length + f.calls.addItem.length + f.calls.reorder.length, 0);
  assert.ok(!f.calls.sql.some((c) => /^(UPDATE|INSERT)/.test(c.sql)), 'only SELECTs in a dry run');
  assert.equal(summary.instruments, 3);
  assert.ok(lines.some((l) => l.startsWith('A  + instrument BTC/USDT')));
  assert.ok(lines.some((l) => /^D  1 new instruments/.test(l)), 'phase D names the instruments it could not search yet');
});

test('phase A without the bot and phase E fixes', async () => {
  const quiet = () => {};
  const f = fakeCtx({
    registry: [{ symbol: 'PEPE/WETH', category: 'DEX', base_asset: 'PEPE', quote_asset: 'WETH', network: null }],
    listings: { 'PEPE/WETH': [{ provider_id: 5, provider_symbol: 'eth:0xpepe', network: null }] },
    providers: PROVIDERS,
  });
  const pop = createPopulator(f.ctx, { log: quiet });
  await pop.load();
  await pop.phaseA();
  assert.match(pop.notes[0], /Freqtrade API not reachable/);
  await pop.phaseE();
  assert.deepEqual(f.calls.update, [{ symbol: 'PEPE/WETH', network: 'eth' }], 'the network comes from the pool source prefix');
  assert.ok(f.calls.sql.some((c) => /route_type = 'DEX'/.test(c.sql)));
});
