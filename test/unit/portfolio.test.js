// src/services/portfolio.js: prices from the registry and manual positions.
const test = require('node:test');
const assert = require('node:assert/strict');
const { priceBook, valueManual } = require('../../src/services/portfolio');

const rows = [
  { symbol: 'BTC/USDT', category: 'CEX', base_asset: 'BTC', quote_asset: 'USDT', last_price: '60000' },
  { symbol: 'ETH/USDT', category: 'CEX', base_asset: 'ETH', quote_asset: 'USDT', last_price: '3000' },
  { symbol: 'WETH/USDT', category: 'DEX', base_asset: 'WETH', quote_asset: 'USDT', last_price: '3001', contract_address: '0xC02a', network: 'eth' },
  { symbol: 'AAPL', category: 'TRADFI', base_asset: 'AAPL', quote_asset: 'USD', last_price: '200' },
  { symbol: 'BTC/TRY', category: 'CEX', base_asset: 'BTC', quote_asset: 'TRY', last_price: '2000000' },
  { symbol: 'PEPE/WETH', category: 'DEX', base_asset: 'PEPE', quote_asset: 'WETH', last_price: '0.000001', contract_address: '0x6982', network: 'eth' },
  { symbol: 'DEAD/USDT', category: 'CEX', base_asset: 'DEAD', quote_asset: 'USDT', last_price: null },
];

test('priceBook: assets, instruments, contracts', () => {
  const pb = priceBook(rows);
  assert.equal(pb.assetUsd('USDC'), 1);
  assert.equal(pb.assetUsd('btc'), 60000);
  assert.equal(pb.assetUsd('ETH'), 3000, 'the spot row wins over the DEX row');
  assert.equal(pb.assetUsd('WETH'), 3001, 'its own price first');
  assert.equal(pb.assetUsd('WBTC'), 60000, 'alias of BTC');
  assert.equal(pb.assetUsd('PEPE'), null, 'priced only against WETH: no USD row');
  assert.equal(pb.assetUsd('DEAD'), null, 'no price');
  assert.equal(pb.instrumentUsd('AAPL'), 200);
  assert.equal(pb.instrumentUsd('btc/usdt'), 60000);
  assert.equal(pb.instrumentUsd('BTC/TRY'), null, 'TRY has no USD price');
  assert.equal(pb.instrumentUsd('PEPE/WETH'), 0.000001 * 3001, 'quote converted through its USD price');
  assert.equal(pb.contractUsd('eth', '0xc02a'), 3001);
  assert.equal(pb.contractUsd('base', '0xc02a'), null);
});

test('valueManual: value, cost basis and P/L; unpriced positions stay visible', () => {
  const pb = priceBook(rows);
  const out = valueManual(
    [
      { symbol: 'AAPL', kind: 'asset', quantity: '10', cost_basis: '1500' },
      { symbol: 'USD', kind: 'cash', quantity: '250.5', cost_basis: null },
      { symbol: 'BTC/TRY', kind: 'asset', quantity: '0.1', cost_basis: null },
    ],
    pb
  );
  assert.deepEqual(out[0], { asset: 'AAPL', kind: 'asset', quantity: 10, price_usd: 200, value_usd: 2000, cost_basis: 1500, pnl_usd: 500 });
  assert.equal(out[1].value_usd, 250.5);
  assert.equal(out[2].value_usd, null);
  assert.equal(out[2].pnl_usd, null);
});
