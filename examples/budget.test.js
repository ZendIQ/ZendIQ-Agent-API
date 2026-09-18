'use strict';

/**
 * Probe: does the ceiling hold across a crash, and does it fail in the safe
 * direction when we cannot know whether a payment settled?
 *
 * Run: npm test
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { BudgetLedger, BudgetExceededError } = require('./budget');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zendiq-budget-'));
const file = path.join(dir, 'budget.json');

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name} ${detail}`); }
};
const throws = (fn, type) => {
  try { fn(); return false; } catch (e) { return type ? e instanceof type || e.name === type : true; }
};

console.log('\n1. a missing ledger is an error, not an empty budget');
check('load refuses a missing file', throws(() => BudgetLedger.load(file)));

console.log('\n2. init');
const ledger = BudgetLedger.init(file, 1.0, 'devnet');
check('ceiling recorded', ledger.ceilingUsd === 1.0);
check('nothing spent', ledger.settledUsd === 0 && ledger.remainingUsd === 1.0);
check('init refuses to overwrite', throws(() => BudgetLedger.init(file, 5, 'devnet')));

console.log('\n3. reserve then settle');
const a = ledger.reserve(0.01, { route: 'POST /v1/agent/analyse' });
check('pending counts against remaining', ledger.remainingUsd === 0.99, `${ledger.remainingUsd}`);
check('but not against settled', ledger.settledUsd === 0);
ledger.settle(a);
check('settled after settle', ledger.settledUsd === 0.01);
check('double settle refused', throws(() => ledger.settle(a)));

console.log('\n4. release returns budget');
const b = ledger.reserve(0.01, { route: 'POST /v1/agent/analyse' });
check('reserved', ledger.remainingUsd === 0.98, `${ledger.remainingUsd}`);
ledger.release(b, 'rate_limited');
check('released', ledger.remainingUsd === 0.99, `${ledger.remainingUsd}`);
check('settled unchanged', ledger.settledUsd === 0.01);

console.log('\n5. the ceiling actually stops spending');
const big = BudgetLedger.init(path.join(dir, 'small.json'), 0.02, 'devnet');
big.reserve(0.01);
big.reserve(0.01);
check('third reservation refused', throws(() => big.reserve(0.01), BudgetExceededError));
check('remaining is zero', big.remainingUsd === 0);

console.log('\n6. a crash mid-payment over-counts, never under-counts');
const c = ledger.reserve(0.05, { route: 'POST /v1/agent/analyse' });
const reloaded = BudgetLedger.load(file, 'devnet');   // fresh process, nothing in memory
check('reservation survived the restart', reloaded.remainingUsd === 0.94, `${reloaded.remainingUsd}`);
check('it is still resolvable', (() => { reloaded.settle(c); return reloaded.settledUsd === 0.06; })(),
  `${reloaded.settledUsd}`);

console.log('\n7. float drift does not accumulate');
const drift = BudgetLedger.init(path.join(dir, 'drift.json'), 1, 'devnet');
for (let i = 0; i < 100; i += 1) drift.settle(drift.reserve(0.001));
check('100 x $0.001 is exactly $0.10', drift.settledUsd === 0.1, `${drift.settledUsd}`);
check('remaining is exactly $0.90', drift.remainingUsd === 0.9, `${drift.remainingUsd}`);

console.log('\n8. network confusion is refused');
check('devnet ledger rejected on a mainnet run', throws(() => BudgetLedger.load(file, 'mainnet')));

console.log(`\n${ledger.banner()}`);
fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
