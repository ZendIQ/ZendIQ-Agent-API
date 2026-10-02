'use strict';

/**
 * The agent's own signing key.
 *
 * ZendIQ never sees this. The agent signs its own payments and its own swaps, which
 * is §6.1's advisory boundary made concrete rather than merely asserted.
 *
 * A mainnet key is never generated here and never written to disk. Auto-generating
 * one would put real key material in plaintext as a side effect of a typo in
 * AGENT_NETWORK, so mainnet requires an explicitly supplied secret and fails loudly
 * without one.
 *
 * Paying is the only spend the budget ceiling can see, so on mainnet a paying key is only
 * handed out with a ledger attached, and it lives in its own file (payer-mainnet.key.json)
 * that nothing else loads. The wallet a swap is built for is a separate `role: 'taker'`
 * key, which is refused if it is the payer (OPS-304).
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createKeyPairSignerFromPrivateKeyBytes } = require('@solana/kit');

const PAYER_MAINNET_FILE = 'payer-mainnet.key.json';
const BINDINGS_FILE = 'payer-bindings.json';

/**
 * Seed bytes from a key file: this agent's `{ seed: [...] }` or a Solana CLI 64-byte array.
 *
 * @param {string} contents - File contents.
 * @returns {Uint8Array} The 32-byte seed.
 */
function parseKeyFile(contents) {
  const parsed = JSON.parse(contents);
  const values = Array.isArray(parsed) ? parsed : parsed?.seed;
  if (!Array.isArray(values)) throw new Error('expected a byte array or an object with a seed byte array');
  if (values.length !== 64 && values.length !== 32) {
    throw new Error(`keypair is ${values.length} bytes; expected a 64-byte Solana keypair or 32-byte seed`);
  }
  // The trailing 32 bytes of the CLI format are the public key, which is derived rather than trusted.
  return Uint8Array.from(values.slice(0, 32));
}

/**
 * One ledger per mainnet payer. A second ledger for the same key would give it a second
 * ceiling, so the first ledger a key is used with is recorded and any other is refused.
 *
 * @param {string} stateDir - Where the bindings file lives.
 * @param {string} address - Payer address.
 * @param {string} ledgerFile - Ledger path.
 */
function bindLedgerToKey(stateDir, address, ledgerFile) {
  const file = path.join(stateDir, BINDINGS_FILE);
  const bindings = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const ledger = path.resolve(ledgerFile);
  if (bindings[address] && bindings[address] !== ledger) {
    throw new Error(`payer ${address} is already bound to the ledger ${bindings[address]}. `
      + 'One key spends against one ceiling; use that ledger.');
  }
  if (!bindings[address]) {
    bindings[address] = ledger;
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(bindings, null, 2));
  }
}

/**
 * @param {object} opts - Options.
 * @param {string} [opts.network] - 'devnet' (default) or 'mainnet'.
 * @param {string} [opts.role] - 'payer' (default) signs x402 payments; 'taker' signs swaps only.
 * @param {object} [opts.ledger] - The BudgetLedger this payer spends against. Required for a mainnet payer.
 * @param {string} [opts.file] - Key file. A mainnet taker must name one.
 * @param {string} [opts.stateDir] - Runtime directory.
 * @param {string} [opts.seedEnv] - Env var holding a payer seed.
 * @param {boolean} [opts.create] - Generate a devnet key when the file is missing (default true).
 * @returns {Promise<{signer: object, address: string, source: string}>} Agent signer.
 */
async function loadAgentSigner(opts = {}) {
  const network = opts.network ?? 'devnet';
  const role = opts.role ?? 'payer';
  if (role !== 'payer' && role !== 'taker') throw new Error(`unknown key role "${role}"`);
  const stateDir = opts.stateDir ?? process.env.AGENT_STATE_DIR ?? path.join(__dirname, '..', 'runtime');

  if (network === 'mainnet' && role === 'taker') return loadMainnetTaker(opts.file, stateDir);
  if (network === 'mainnet' && opts.ledger?.state?.network !== 'mainnet') {
    throw new Error('refusing to load a mainnet paying key without a mainnet budget ledger. '
      + 'Pass { ledger } from BudgetLedger.load(file, "mainnet"): a payment the ledger cannot see '
      + 'is a spend the ceiling cannot stop.');
  }

  const loaded = await loadPayer({ ...opts, network, stateDir });
  if (opts.ledger) {
    opts.ledger.bindPayer(loaded.address);
    if (network === 'mainnet') bindLedgerToKey(stateDir, loaded.address, opts.ledger.file);
  }
  return loaded;
}

async function loadPayer({ network, stateDir, file: fileOpt, seedEnv: seedEnvOpt, create = true }) {
  const file = fileOpt ?? path.join(stateDir, network === 'mainnet' ? PAYER_MAINNET_FILE : `agent-${network}.key.json`);
  const seedEnv = seedEnvOpt ?? 'AGENT_SECRET_SEED';

  const fromEnv = (process.env[seedEnv] ?? '').trim();
  if (fromEnv) {
    const seed = Uint8Array.from(JSON.parse(fromEnv));
    if (seed.length !== 32) throw new Error(`${seedEnv} must be a 32-byte seed array`);
    const signer = await createKeyPairSignerFromPrivateKeyBytes(seed);
    return { signer, address: signer.address, source: `env:${seedEnv}` };
  }

  if (fs.existsSync(file)) {
    const signer = await createKeyPairSignerFromPrivateKeyBytes(parseKeyFile(fs.readFileSync(file, 'utf8')));
    return { signer, address: signer.address, source: file };
  }

  if (network === 'mainnet') {
    throw new Error(
      `no mainnet paying key at ${file}, and ${seedEnv} is not set. `
      + 'Mainnet keys are never generated or written to disk by this agent.',
    );
  }
  if (!create) throw new Error(`no key file at ${file}`);

  const seed = new Uint8Array(crypto.randomBytes(32));
  const signer = await createKeyPairSignerFromPrivateKeyBytes(seed);
  // runtime/ is gitignored, so a fresh clone does not have it.
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    _warning: 'THROWAWAY TEST KEY. Not for mainnet. Gitignored.',
    network,
    address: signer.address,
    seed: Array.from(seed),
  }, null, 2));
  return { signer, address: signer.address, source: `${file} (generated)` };
}

/**
 * The mainnet wallet a swap is built for. It signs trades, never payments, so it must
 * not be the payer: money moved by a trade is invisible to the ledger.
 *
 * @param {string} file - Key file; required, since a taker has no default.
 * @param {string} stateDir - Runtime directory, where the payer key lives.
 * @returns {Promise<{signer: object, address: string, source: string}>} Taker signer.
 */
async function loadMainnetTaker(file, stateDir) {
  if (!file) throw new Error('a mainnet taker key must be named explicitly with { file }');
  if (path.basename(file) === PAYER_MAINNET_FILE) {
    throw new Error(`${PAYER_MAINNET_FILE} is the paying key and cannot be loaded as a taker`);
  }
  const signer = await createKeyPairSignerFromPrivateKeyBytes(parseKeyFile(fs.readFileSync(file, 'utf8')));
  const bindingsFile = path.join(stateDir, BINDINGS_FILE);
  const bound = fs.existsSync(bindingsFile) ? JSON.parse(fs.readFileSync(bindingsFile, 'utf8')) : {};
  if (bound[signer.address]) {
    throw new Error(`${file} holds ${signer.address}, a paying key bound to ${bound[signer.address]}; a taker must be a different wallet`);
  }
  const payerFile = path.join(stateDir, PAYER_MAINNET_FILE);
  if (fs.existsSync(payerFile)) {
    const payer = await createKeyPairSignerFromPrivateKeyBytes(parseKeyFile(fs.readFileSync(payerFile, 'utf8')));
    if (payer.address === signer.address) {
      throw new Error(`${file} holds the paying key ${signer.address}; a taker must be a different wallet`);
    }
  }
  // A payer supplied as a seed may not be bound yet, so it is checked directly.
  const seed = (process.env.AGENT_SECRET_SEED ?? '').trim();
  if (seed) {
    const payer = await createKeyPairSignerFromPrivateKeyBytes(Uint8Array.from(JSON.parse(seed)));
    if (payer.address === signer.address) {
      throw new Error(`${file} holds the AGENT_SECRET_SEED paying key ${signer.address}; a taker must be a different wallet`);
    }
  }
  return { signer, address: signer.address, source: file };
}

module.exports = { loadAgentSigner, parseKeyFile, PAYER_MAINNET_FILE };
