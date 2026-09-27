// lib/evm.js: key derivation against published vectors, address checksums, input checks, and
// the balance reader on a fake JSON-RPC endpoint.
const test = require('node:test');
const assert = require('node:assert/strict');
const evm = require('../../lib/evm');

test('private key -> address (web3.js documentation vector)', () => {
  const w = evm.fromPrivateKey('0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318');
  assert.equal(w.address, '0x2c7536E3605D9C16a7a3D7b1898e529396a65c23');
  assert.equal(evm.fromPrivateKey('4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318').address, w.address, '0x is optional');
});

test('recovery phrase -> first account (Hardhat default mnemonic)', () => {
  const w = evm.fromMnemonic('  Test test test test test test test test test test test JUNK ');
  assert.equal(w.address, '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266');
  assert.equal(w.path, "m/44'/60'/0'/0/0");
  assert.equal(w.mnemonic, 'test test test test test test test test test test test junk', 'normalised');
  assert.equal(evm.fromMnemonic('test test test test test test test test test test test junk', "m/44'/60'/0'/0/1").address, '0x70997970C51812dc3A010C7d01b50e0d17dc79C8');
});

test('generate: a valid 12-word phrase whose first account matches its key', () => {
  const g = evm.generate();
  assert.equal(g.mnemonic.split(' ').length, 12);
  assert.equal(evm.fromMnemonic(g.mnemonic).address, g.address);
  assert.equal(evm.fromPrivateKey(g.privateKey).address, g.address);
  assert.notEqual(evm.generate().address, g.address);
});

test('address checksum (EIP-55) and input checks', () => {
  assert.equal(evm.toChecksumAddress('0xfb6916095ca1df60bb79ce92ce3ea74c37c5d359'), '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359');
  assert.equal(evm.parseAddress('0xFB6916095CA1DF60BB79CE92CE3EA74C37C5D359'), '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359', 'all upper case is accepted');
  assert.throws(() => evm.parseAddress('0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d35A'.slice(0, 41) + 'A'), /checksum/);
  assert.throws(() => evm.parseAddress('0x123'), /40 hex digits/);
  assert.throws(() => evm.fromPrivateKey('0x' + '0'.repeat(64)), /secp256k1 range/);
  assert.throws(() => evm.fromPrivateKey('not a key'), /64 hex digits/);
  assert.throws(() => evm.fromMnemonic('test test test'), /12, 15, 18, 21 or 24 words/);
  assert.throws(() => evm.fromMnemonic('test test test test test test test test test test test test'), /not valid/);
  assert.throws(() => evm.fromMnemonic('test test test test test test test test test test test junk', 'm/x'), /derivation path/);
  // Error messages never carry the secret.
  try {
    evm.fromPrivateKey('0x' + 'f'.repeat(64));
  } catch (e) {
    assert.ok(!e.message.includes('ffff'));
  }
});

test('balances: native and tokens in one batch, zero balances left out, the next endpoint on failure', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(url);
    if (url.includes('bad')) return { ok: false, status: 503, json: async () => ({}) };
    const batch = JSON.parse(init.body);
    const answer = batch.map((c) => {
      if (c.method === 'eth_getBalance') return { id: c.id, result: '0xde0b6b3a7640000' }; // 1 ETH
      const [{ to, data }] = c.params;
      if (data === '0x313ce567') return { id: c.id, result: to === '0xusdc' ? '0x6' : '0x12' };
      if (to === '0xusdc') return { id: c.id, result: '0x' + (2500000n).toString(16) }; // 2.5 USDC
      if (to === '0xbroken') return { id: c.id, error: { message: 'reverted' } };
      return { id: c.id, result: '0x0' };
    });
    return { ok: true, status: 200, json: async () => answer };
  };
  const env = { EVM_RPC_ETH: 'https://bad.example, http://insecure.example' };
  const r = await evm.balances('eth', '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266', [{ symbol: 'USDC', address: '0xusdc' }, { symbol: 'DAI', address: '0xdai' }, { symbol: 'BRK', address: '0xbroken' }], { fetchImpl, env });
  assert.deepEqual(r.balances, [{ asset: 'ETH', native: true, quantity: 1, network: 'eth' }, { asset: 'USDC', contract: '0xusdc', quantity: 2.5, network: 'eth' }]);
  assert.deepEqual(r.errors, ['BRK']);
  assert.equal(calls[0], 'https://bad.example', 'the configured endpoint first');
  assert.ok(!calls.includes('http://insecure.example'), 'only https endpoints are taken from the environment');
  assert.equal(calls[1], evm.NETWORKS.eth.rpcs[0]);
  await assert.rejects(evm.balances('nope', '0x0', [], { fetchImpl }), /unknown network/);
});
