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