'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { normalise, describe } = require('./feed');
const { RunLedger, act } = require('./watch');

test('feed accepts Solana boosts and discards unrelated chains', () => {
  assert.equal(normalise({ chainId: 'ethereum', tokenAddress: 'token' }), null);
  assert.deepEqual(normalise({
    chainId: 'solana', tokenAddress: 'mint', description: 'candidate', totalAmount: 25,
  }), {
    address: 'mint', description: 'candidate', url: null, boost: 25, symbol: null,
    liquidityUsd: null, fdvUsd: null, priceChangeH1: null, ageMs: null,
  });
});

test('feed description uses fixed machine-readable number formatting', () => {
  assert.equal(describe({
    address: '1234567890', symbol: 'TEST', liquidityUsd: 1234567,
    priceChangeH1: 4.2, ageMs: 3_600_000,
  }), 'TEST  liq $1,234,567  1h +4.2%  age 1h');
});

test('agent refuses unsafe trades and reports advisory actions honestly', async () => {
  assert.equal(await act({}, { verdict: 'Refuse' }, null), 'skipped, no transaction built');
  assert.match(await act({}, {
    verdict: 'Protect',
    recommendedExecution: { path: 'jito_bundle', priorityFeeLamports: 50_000, jitoTipLamports: 20_000 },
  }, null), /would execute via jito_bundle.*executor not wired/);
});

test('run ledger excludes its control from candidate totals', () => {
  const ledger = new RunLedger(2);
  ledger.add({ label: 'USDC', control: true, verdict: 'Safe', paidUsd: 0.01, action: 'control' });
  ledger.add({ label: 'RISK', control: false, verdict: 'Refuse', paidUsd: 0.01, action: 'skipped' });

  assert.equal(ledger.count('Safe'), 0);
  assert.equal(ledger.count('Refuse'), 1);
  assert.match(ledger.report(), /declined\s+1/);
});

// OPS-304: a mainnet payment the ledger cannot see is a spend the ceiling cannot stop.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadAgentSigner, parseKeyFile } = require('./keys');
const { BudgetLedger } = require('./budget');
const { ZendIQClient } = require('./zendiq-client');

function mainnetDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zendiq-keys-'));
  const seed = (b) => JSON.stringify({ seed: Array(32).fill(b) });
  fs.writeFileSync(path.join(dir, 'payer-mainnet.key.json'), seed(7));
  fs.writeFileSync(path.join(dir, 'taker.key.json'), seed(9));
  return dir;
}

test('a mainnet payer is refused without a mainnet ledger', async () => {
  const stateDir = mainnetDir();
  await assert.rejects(loadAgentSigner({ network: 'mainnet', stateDir }), /without a mainnet budget ledger/);
  const devnetLedger = BudgetLedger.init(path.join(stateDir, 'dev.json'), 1, 'devnet');
  await assert.rejects(loadAgentSigner({ network: 'mainnet', stateDir, ledger: devnetLedger }), /without a mainnet budget ledger/);
});

test('with a ledger the mainnet payer loads from its own file and binds to that ledger', async () => {
  const stateDir = mainnetDir();
  const ledger = BudgetLedger.init(path.join(stateDir, 'budget-mainnet.json'), 1, 'mainnet');
  const payer = await loadAgentSigner({ network: 'mainnet', stateDir, ledger });
  assert.equal(payer.source, path.join(stateDir, 'payer-mainnet.key.json'));
  assert.equal(BudgetLedger.load(ledger.file).state.payer, payer.address);

  const second = BudgetLedger.init(path.join(stateDir, 'second.json'), 1, 'mainnet');
  await assert.rejects(loadAgentSigner({ network: 'mainnet', stateDir, ledger: second }), /already bound to the ledger/);
});

test('a mainnet taker must be named, and may not be the payer', async () => {
  const stateDir = mainnetDir();
  await assert.rejects(loadAgentSigner({ network: 'mainnet', role: 'taker', stateDir }), /named explicitly/);
  await assert.rejects(
    loadAgentSigner({ network: 'mainnet', role: 'taker', stateDir, file: path.join(stateDir, 'payer-mainnet.key.json') }),
    /paying key/,
  );
  const copy = path.join(stateDir, 'copy.key.json');
  fs.copyFileSync(path.join(stateDir, 'payer-mainnet.key.json'), copy);
  await assert.rejects(loadAgentSigner({ network: 'mainnet', role: 'taker', stateDir, file: copy }), /holds the paying key/);
  const taker = await loadAgentSigner({ network: 'mainnet', role: 'taker', stateDir, file: path.join(stateDir, 'taker.key.json') });
  assert.ok(taker.address);
});

test('a mainnet client is refused without a ledger, or with one for another network', () => {
  const signer = { address: 'x' };
  assert.throws(() => new ZendIQClient({ signer, network: 'mainnet' }), /needs a budget ledger/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zendiq-client-'));
  const devnet = BudgetLedger.init(path.join(dir, 'b.json'), 1, 'devnet');
  assert.throws(() => new ZendIQClient({ signer, network: 'mainnet', budget: devnet }), /ledger is for devnet/);
});

test('key files: this agent\'s seed format and the Solana CLI 64-byte format', () => {
  assert.equal(parseKeyFile(JSON.stringify(Array(64).fill(1))).length, 32);
  assert.equal(parseKeyFile(JSON.stringify({ seed: Array(32).fill(2) })).length, 32);
  assert.throws(() => parseKeyFile('{}'), /seed byte array/);
});

test('payment network comes from the manifest; a disagreeing pin or an unreadable manifest refuses', async () => {
  const { resolveNetwork } = require('./zendiq-client');
  const serve = (body, status = 200) => async (url) => {
    assert.equal(url, 'https://api.example/v1/agent');
    return { ok: status === 200, status, json: async () => body };
  };
  assert.equal(await resolveNetwork('https://api.example/', { expected: undefined, fetchImpl: serve({ network: 'mainnet' }) }), 'mainnet');
  assert.equal(await resolveNetwork('https://api.example', { expected: 'DEVNET', fetchImpl: serve({ network: 'devnet' }) }), 'devnet');
  await assert.rejects(resolveNetwork('https://api.example', { expected: 'devnet', fetchImpl: serve({ network: 'mainnet' }) }), /settles on mainnet/);
  await assert.rejects(resolveNetwork('https://api.example', { expected: 'testnet', fetchImpl: serve({ network: 'mainnet' }) }), /"devnet" or "mainnet"/);
  await assert.rejects(resolveNetwork('https://api.example', { expected: null, fetchImpl: serve({ network: 'solana' }) }), /expected devnet or mainnet/);
  await assert.rejects(resolveNetwork('https://api.example', { expected: null, fetchImpl: serve({}, 503) }), /refusing to guess/);
  await assert.rejects(resolveNetwork('https://api.example', { expected: null, fetchImpl: async () => { throw new Error('fetch failed'); } }), /refusing to guess/);
});