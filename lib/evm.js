// EVM wallets and balances.
//
// Keys: secp256k1 and keccak-256 from @noble (audited, no dependencies), BIP-39 recovery
// phrases and BIP-32 derivation from @scure. Nothing here stores or logs a secret; callers
// decide where a key goes (src/services/wallets.js writes it to a 0600 file).
//
// Balances: plain JSON-RPC (eth_getBalance, balanceOf, decimals) against public endpoints,
// one batch per network, the next endpoint on failure.
const { secp256k1 } = require('@noble/curves/secp256k1.js');
const { keccak_256 } = require('@noble/hashes/sha3.js');
const { bytesToHex, hexToBytes } = require('@noble/hashes/utils.js');
const bip39 = require('@scure/bip39');
const { wordlist } = require('@scure/bip39/wordlists/english.js');
const { HDKey } = require('@scure/bip32');

const DEFAULT_PATH = "m/44'/60'/0'/0/0";
const PATH = /^m(\/\d{1,10}'?){1,6}$/;
const HEX_KEY = /^(0x)?[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

// EIP-55 mixed-case checksum.
function toChecksumAddress(address) {
  if (!ADDRESS.test(String(address))) throw new Error('not an EVM address (0x and 40 hex digits)');
  const lower = address.slice(2).toLowerCase();
  const hash = bytesToHex(keccak_256(new TextEncoder().encode(lower)));
  let out = '0x';
  for (let i = 0; i < 40; i += 1) out += parseInt(hash[i], 16) >= 8 ? lower[i].toUpperCase() : lower[i];
  return out;
}

// An address as typed: all lower or all upper case is accepted as is; mixed case must carry a
// valid checksum (a typo in a checksummed address is caught).
function parseAddress(input) {
  const a = String(input || '').trim();
  if (!ADDRESS.test(a)) throw new Error('address must be 0x followed by 40 hex digits');
  const body = a.slice(2);
  const mixed = body !== body.toLowerCase() && body !== body.toUpperCase();
  const checksummed = toChecksumAddress(a.toLowerCase());
  if (mixed && checksummed !== a) throw new Error('address checksum does not match (a typo?)');
  return checksummed;
}

function addressOfPrivateKey(keyBytes) {
  const pub = secp256k1.getPublicKey(keyBytes, false).slice(1);
  return toChecksumAddress(`0x${bytesToHex(keccak_256(pub).slice(-20))}`);
}

function parsePrivateKey(input) {
  const s = String(input || '').trim();
  if (!HEX_KEY.test(s)) throw new Error('private key must be 64 hex digits (0x optional)');
  const bytes = hexToBytes(s.replace(/^0x/, ''));
  if (!secp256k1.utils.isValidSecretKey(bytes)) throw new Error('private key is outside the secp256k1 range');
  return bytes;
}

function fromPrivateKey(input) {
  const bytes = parsePrivateKey(input);
  return { address: addressOfPrivateKey(bytes), privateKey: `0x${bytesToHex(bytes)}` };
}

const normalizePhrase = (m) => String(m || '').trim().toLowerCase().split(/\s+/).join(' ');

function fromMnemonic(input, path = DEFAULT_PATH) {
  const mnemonic = normalizePhrase(input);
  if (![12, 15, 18, 21, 24].includes(mnemonic.split(' ').length)) throw new Error('recovery phrase must have 12, 15, 18, 21 or 24 words');
  if (!bip39.validateMnemonic(mnemonic, wordlist)) throw new Error('recovery phrase is not valid (unknown word or wrong checksum)');
  if (!PATH.test(path)) throw new Error("derivation path must look like m/44'/60'/0'/0/0");
  const key = HDKey.fromMasterSeed(bip39.mnemonicToSeedSync(mnemonic)).derive(path);
  if (!key.privateKey) throw new Error('no private key at that path');
  return { address: addressOfPrivateKey(key.privateKey), privateKey: `0x${bytesToHex(key.privateKey)}`, mnemonic, path };
}

// A new wallet: a 12-word recovery phrase (128 bits from the system's CSPRNG) and its first
// account on the standard Ethereum path.
function generate() {
  return fromMnemonic(bip39.generateMnemonic(wordlist, 128), DEFAULT_PATH);
}

// ---- networks and balances ----------------------------------------------------------------
// Network ids as GeckoTerminal (and the instrument registry) name them.
const NETWORKS = {
  eth: { name: 'Ethereum', native: 'ETH', rpcs: ['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org'] },
  arbitrum: { name: 'Arbitrum One', native: 'ETH', rpcs: ['https://arbitrum-one-rpc.publicnode.com', 'https://arb1.arbitrum.io/rpc'] },
  base: { name: 'Base', native: 'ETH', rpcs: ['https://base-rpc.publicnode.com', 'https://mainnet.base.org'] },
  optimism: { name: 'Optimism', native: 'ETH', rpcs: ['https://optimism-rpc.publicnode.com', 'https://mainnet.optimism.io'] },
  polygon_pos: { name: 'Polygon', native: 'POL', rpcs: ['https://polygon-bor-rpc.publicnode.com', 'https://polygon-rpc.com'] },
  bsc: { name: 'BNB Chain', native: 'BNB', rpcs: ['https://bsc-rpc.publicnode.com', 'https://bsc-dataseed.binance.org'] },
};
// Tokens every wallet is checked for (the same contracts the Web3 engine uses); DEX
// instruments with a contract on the network are added by the portfolio service.
const CORE_TOKENS = {
  eth: [
    ['USDC', '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'], ['USDT', '0xdAC17F958D2ee523a2206206994597C13D831ec7'], ['DAI', '0x6B175474E89094C44Da98b954EedeAC495271d0F'],
    ['WETH', '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'], ['WBTC', '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599'],
  ],
  arbitrum: [['USDC', '0xaf88d065e77c8cC2239327C5EDb3A432268e5831'], ['USDT', '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9'], ['WETH', '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1']],
  base: [['USDC', '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'], ['WETH', '0x4200000000000000000000000000000000000006']],
};

// RPC endpoints of a network: EVM_RPC_<NETWORK> (comma-separated, https only) first.
function rpcsFor(network, env = process.env) {
  const own = String(env[`EVM_RPC_${network.toUpperCase()}`] || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^https:\/\/[^\s]+$/.test(s));
  return [...own, ...((NETWORKS[network] && NETWORKS[network].rpcs) || [])];
}

// One JSON-RPC batch, tried on each endpoint in turn. Returns a map id -> result.
async function rpcBatch(rpcs, calls, { fetchImpl = fetch, timeoutMs = 10000 } = {}) {
  let lastError = new Error('no RPC endpoint');
  for (const url of rpcs) {
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(calls.map((c, i) => ({ jsonrpc: '2.0', id: i + 1, method: c.method, params: c.params }))),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      if (!Array.isArray(body)) throw new Error(body && body.error ? String(body.error.message || 'RPC error') : 'not a batch answer');
      return new Map(body.map((r) => [r.id, r.error ? null : r.result]));
    } catch (e) {
      lastError = new Error(`${new URL(url).host}: ${e.message}`);
    }
  }
  throw lastError;
}

const hexToBigInt = (h) => (typeof h === 'string' && /^0x[0-9a-fA-F]*$/.test(h) && h.length > 2 ? BigInt(h) : null);
// A token amount as a Number (display and valuation; exact amounts are not needed there).
function units(raw, decimals) {
  if (raw === null) return null;
  const d = BigInt(10) ** BigInt(decimals);
  return Number(raw / d) + Number(raw % d) / Number(d);
}

// Native and token balances of one address on one network. tokens: [{ symbol, address }].
// Zero balances are left out; a token whose call failed is reported in `errors`.
async function balances(network, address, tokens, opts = {}) {
  const net = NETWORKS[network];
  if (!net) throw new Error(`unknown network ${network}`);
  const owner = address.toLowerCase().replace(/^0x/, '').padStart(64, '0');
  const calls = [{ method: 'eth_getBalance', params: [address, 'latest'] }];
  for (const t of tokens) {
    calls.push({ method: 'eth_call', params: [{ to: t.address, data: `0x70a08231${owner}` }, 'latest'] });
    calls.push({ method: 'eth_call', params: [{ to: t.address, data: '0x313ce567' }, 'latest'] });
  }
  const res = await rpcBatch(rpcsFor(network, opts.env), calls, opts);
  const out = [];
  const errors = [];
  const native = hexToBigInt(res.get(1));
  if (native === null) throw new Error(`${net.name}: no balance answer`);
  if (native > 0n) out.push({ asset: net.native, native: true, quantity: units(native, 18), network });
  tokens.forEach((t, i) => {
    const raw = hexToBigInt(res.get(2 + i * 2));
    const dec = hexToBigInt(res.get(3 + i * 2));
    if (raw === null || dec === null || dec > 36n) {
      errors.push(t.symbol);
      return;
    }
    if (raw > 0n) out.push({ asset: t.symbol, contract: t.address, quantity: units(raw, Number(dec)), network });
  });
  return { balances: out, errors };
}

module.exports = {
  DEFAULT_PATH, NETWORKS, CORE_TOKENS,
  toChecksumAddress, parseAddress, fromPrivateKey, fromMnemonic, generate, normalizePhrase,
  rpcsFor, rpcBatch, balances, units,
};
