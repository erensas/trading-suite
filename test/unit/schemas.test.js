const test = require('node:test');
const assert = require('node:assert/strict');
const schemas = require('../../src/schemas');
const { toCsv } = require('../../src/services/reports');

test('settings patch: coerces form strings, rounds integers, drops unknown keys', () => {
  const r = schemas.settingsPatch.parse({ candleLimit: '300.4', showVolume: 'false', maxSlippagePct: '2.5', bogus: 1 });
  assert.deepEqual(r, { candleLimit: 300, showVolume: false, maxSlippagePct: 2.5 });
});

test('settings patch: rejects out-of-range numbers and unknown timeframes', () => {
  const tooSmall = schemas.settingsPatch.safeParse({ candleLimit: 10 });
  assert.equal(tooSmall.success, false);
  assert.match(tooSmall.error.issues[0].message, /between 50 and 1000/);
  assert.equal(schemas.settingsPatch.safeParse({ defaultTimeframe: '2h' }).success, false);
  assert.equal(schemas.settingsPatch.safeParse({ showVolume: 'maybe' }).success, false);
});

test('provider: defaults, JSON config from a string, credential_env format', () => {
  const p = schemas.provider.parse({ name: ' Gate ', kind: 'rest_template', base_url: 'https://api.gateio.ws/', config: '{"a":1}' });
  assert.deepEqual(p, { name: 'Gate', kind: 'rest_template', base_url: 'https://api.gateio.ws', enabled: true, config: { a: 1 }, credential_env: null });
  assert.match(schemas.provider.safeParse({ name: 'x', kind: 'okx', config: '{nope' }).error.issues[0].message, /not valid JSON/);
  assert.match(schemas.provider.safeParse({ name: 'x', kind: 'okx', config: [] }).error.issues[0].message, /JSON object/);
  assert.match(schemas.provider.safeParse({ name: 'x', kind: 'okx', credential_env: 'lower' }).error.issues[0].message, /UPPER_SNAKE_CASE/);
  assert.match(schemas.provider.safeParse({ name: 'x', kind: 'ftx' }).error.issues[0].message, /kind must be one of/);
});

test('instrument: normalises case, fills base and quote, empty strings become null', () => {
  const i = schemas.instrument.parse({ symbol: ' eth/usdt ', category: 'cex', provider_id: '', network: 'ETH', name: '' });
  assert.equal(i.symbol, 'ETH/USDT');
  assert.equal(i.category, 'CEX');
  assert.equal(i.base_asset, 'ETH');
  assert.equal(i.quote_asset, 'USDT');
  assert.equal(i.provider_id, null);
  assert.equal(i.network, 'eth');
  assert.equal(i.name, null);
  assert.equal(i.is_active, true);
  assert.equal(schemas.instrument.parse({ symbol: 'SPY', category: 'TRADFI' }).quote_asset, 'USD');
  assert.equal(schemas.instrument.safeParse({ symbol: 'BTC USDT', category: 'CEX' }).success, false);
  assert.equal(schemas.instrument.safeParse({ symbol: 'BTC/USDT', category: 'NFT' }).success, false);
});

test('order: side is case-insensitive, amount must be positive', () => {
  assert.deepEqual(schemas.order.parse({ symbol: 'ETH/USDT', side: 'buy', amount: '100' }), {
    symbol: 'ETH/USDT', side: 'BUY', amount: 100, price: null, order_type: 'MARKET',
  });
  assert.equal(schemas.order.safeParse({ symbol: 'ETH/USDT', side: 'HOLD', amount: 1 }).success, false);
  assert.equal(schemas.order.safeParse({ symbol: 'ETH/USDT', side: 'SELL', amount: -1 }).success, false);
  assert.equal(schemas.order.safeParse({}).success, false);
});

test('toCsv quotes strings, keeps numbers and defuses formulas', () => {
  const csv = toCsv([{ id: 1, action: '=HYPERLINK("x")', amount_in: '-1.5', note: 'say "hi"', at: new Date('2026-01-01T00:00:00Z'), gas: null }]);
  assert.equal(csv, 'id,action,amount_in,note,at,gas\n1,"\'=HYPERLINK(""x"")","-1.5","say ""hi""",2026-01-01T00:00:00.000Z,');
  assert.match(toCsv([]), /^id,tx_hash,/);
});
