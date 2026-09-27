// EVM wallets (trade_db.wallets, migration 011): created in the suite, imported from a
// private key or a recovery phrase, or only watched (an address).
//
// Secrets never go into the database, a response or a log line. They are written to
// ~/.openclaw/credentials/wallets/<id>.env (0600, WALLET_PRIVATE_KEY, and WALLET_MNEMONIC /
// WALLET_DERIVATION_PATH when there is a phrase). The one exception: a wallet generated here
// answers its new recovery phrase once, in the create response, so it can be written down.
// Deleting a wallet moves its file to credentials/wallets/trash.
const fs = require('fs');
const path = require('path');
const evm = require('../../lib/evm');
const { badRequest, notFound, onDuplicate } = require('../http/errors');
const { withTransaction } = require('../db');
const { readEnvFile, writeEnvFile } = require('./bots');

const ORIGINS = ['generated', 'private_key', 'mnemonic', 'watch'];
const NAME = /^[\p{L}\p{N} ._()#-]{1,60}$/u;

function createWallets({ db, config }) {
  const dir = config.walletCredentialsDir;
  const file = (id) => path.join(dir, `${id}.env`);

  // What the API shows about the stored secret: whether there is one, never its value.
  function secretStatus(id) {
    const env = readEnvFile(file(id));
    return { key_stored: !!env.WALLET_PRIVATE_KEY, phrase_stored: !!env.WALLET_MNEMONIC };
  }
  const shape = (w) => ({ ...w, ...secretStatus(w.id) });

  async function get(id) {
    const r = await db.query('SELECT * FROM wallets WHERE id = $1', [id]);
    if (!r.rows[0]) throw notFound('Wallet not found');
    return r.rows[0];
  }

  async function list() {
    const r = await db.query('SELECT * FROM wallets ORDER BY name');
    return r.rows.map(shape);
  }

  function parseNetworks(input) {
    const list = input === undefined || input === null ? ['eth', 'arbitrum', 'base'] : Array.isArray(input) ? input : String(input).split(',');
    const nets = [...new Set(list.map((n) => String(n).trim().toLowerCase()).filter(Boolean))];
    const unknown = nets.filter((n) => !evm.NETWORKS[n]);
    if (unknown.length) throw badRequest(`networks: unknown ${unknown.join(', ')} (known: ${Object.keys(evm.NETWORKS).join(', ')})`);
    if (!nets.length) throw badRequest('networks: at least one');
    return nets;
  }

  function parseCommon(body) {
    const name = String(body.name || '').trim();
    if (!NAME.test(name)) throw badRequest('name: 1 to 60 letters, digits, spaces or . _ - ( ) #');
    const notes = body.notes === undefined || body.notes === null ? null : String(body.notes).trim().slice(0, 300) || null;
    return { name, notes, networks: parseNetworks(body.networks) };
  }

  // body.origin: generated | private_key | mnemonic | watch. Returns { wallet, secret } where
  // secret is { mnemonic } for a generated wallet and null otherwise.
  async function create(body, actor) {
    const origin = String(body.origin || '');
    if (!ORIGINS.includes(origin)) throw badRequest(`origin: one of ${ORIGINS.join(', ')}`);
    const common = parseCommon(body);
    let keys;
    try {
      if (origin === 'generated') keys = evm.generate();
      else if (origin === 'private_key') keys = evm.fromPrivateKey(body.private_key);
      else if (origin === 'mnemonic') keys = evm.fromMnemonic(body.mnemonic, body.derivation_path ? String(body.derivation_path).trim() : evm.DEFAULT_PATH);
      else keys = { address: evm.parseAddress(body.address) };
    } catch (e) {
      // The message names the problem, never the input.
      throw badRequest(e.message);
    }
    const wallet = await withTransaction(db, async (client) => {
      const r = await client
        .query(
          `INSERT INTO wallets (name, address, origin, derivation_path, networks, notes, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
          [common.name, keys.address, origin, keys.path || null, common.networks, common.notes, actor]
        )
        .catch(onDuplicate(`A wallet with this name or address exists`));
      const w = r.rows[0];
      if (keys.privateKey) {
        const env = { WALLET_ADDRESS: w.address, WALLET_PRIVATE_KEY: keys.privateKey };
        if (keys.mnemonic) Object.assign(env, { WALLET_MNEMONIC: `"${keys.mnemonic}"`, WALLET_DERIVATION_PATH: `"${keys.path}"` });
        try {
          writeEnvFile(file(w.id), env, `EVM wallet ${w.name} (${w.address}), ${origin}, by ${actor} ${new Date().toISOString()}`);
        } catch (e) {
          // Rolls the row back: a wallet whose key could not be stored must not exist.
          throw new Error(`the key could not be stored in ${dir} (${e.code || e.message}); nothing was saved`);
        }
      }
      return w;
    });
    return { wallet: shape(wallet), secret: origin === 'generated' ? { mnemonic: keys.mnemonic, derivation_path: keys.path } : null };
  }

  async function update(id, body) {
    const before = await get(id);
    const merged = parseCommon({ name: body.name ?? before.name, notes: body.notes !== undefined ? body.notes : before.notes, networks: body.networks ?? before.networks });
    const r = await db
      .query('UPDATE wallets SET name = $2, networks = $3, notes = $4, updated_at = NOW() WHERE id = $1 RETURNING *', [id, merged.name, merged.networks, merged.notes])
      .catch(onDuplicate(`A wallet named ${merged.name} exists`));
    return { before, after: shape(r.rows[0]) };
  }

  function trashSecrets(id) {
    if (!fs.existsSync(file(id))) return null;
    const trash = path.join(dir, 'trash');
    fs.mkdirSync(trash, { recursive: true, mode: 0o700 });
    const target = path.join(trash, `${id}-${new Date().toISOString().replace(/[:.]/g, '-')}.env`);
    fs.renameSync(file(id), target);
    return target;
  }

  // The wallet and its portfolio account go; the key file moves to the trash folder.
  async function remove(id) {
    const w = await get(id);
    await db.query("DELETE FROM portfolio_accounts WHERE kind = 'wallet' AND ref = $1", [String(id)]);
    await db.query('DELETE FROM wallets WHERE id = $1', [id]);
    return { wallet: w, trashed: trashSecrets(id) };
  }

  return { list, get, create, update, remove, secretStatus };
}

module.exports = { createWallets, ORIGINS };
