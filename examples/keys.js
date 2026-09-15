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
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createKeyPairSignerFromPrivateKeyBytes } = require('@solana/kit');

/**
 * @param {object} opts - `network`, optional `file`, optional `seedEnv`.
 * @returns {Promise<{signer: object, address: string, source: string}>} Agent signer.
 */
async function loadAgentSigner(opts = {}) {
  const network = opts.network ?? 'devnet';
  const file = opts.file ?? path.join(__dirname, `agent-${network}.key.json`);
  const seedEnv = opts.seedEnv ?? 'AGENT_SECRET_SEED';

  const fromEnv = (process.env[seedEnv] ?? '').trim();
  if (fromEnv) {
    const seed = Uint8Array.from(JSON.parse(fromEnv));
    if (seed.length !== 32) throw new Error(`${seedEnv} must be a 32-byte seed array`);
    const signer = await createKeyPairSignerFromPrivateKeyBytes(seed);
    return { signer, address: signer.address, source: `env:${seedEnv}` };
  }

  if (fs.existsSync(file)) {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const signer = await createKeyPairSignerFromPrivateKeyBytes(Uint8Array.from(raw.seed));
    return { signer, address: signer.address, source: file };
  }

  if (network === 'mainnet') {
    throw new Error(
      `no mainnet key available. Set ${seedEnv} to a 32-byte seed array. `
      + 'Mainnet keys are never generated or written to disk by this agent.',
    );
  }

  const seed = new Uint8Array(crypto.randomBytes(32));
  const signer = await createKeyPairSignerFromPrivateKeyBytes(seed);
  fs.writeFileSync(file, JSON.stringify({
    _warning: 'THROWAWAY TEST KEY. Not for mainnet. Gitignored.',
    network,
    address: signer.address,
    seed: Array.from(seed),
  }, null, 2));
  return { signer, address: signer.address, source: `${file} (generated)` };
}

module.exports = { loadAgentSigner };
