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

console.log('\n9. a ledger belongs to one payer (OPS-304)');
const bound = BudgetLedger.init(path.join(dir, 'bound.json'), 1, 'mainnet');
bound.bindPayer('PayerAAA');
check('binding is persisted', BudgetLedger.load(bound.file, 'mainnet').state.payer === 'PayerAAA');
check('rebinding the same payer is a no-op', !throws(() => bound.bindPayer('PayerAAA')));
check('a second payer is refused', throws(() => BudgetLedger.load(bound.file).bindPayer('PayerBBB')));

console.log('\n10. two handles on one file see each other\'s spend');
const shared = path.join(dir, 'shared.json');
BudgetLedger.init(shared, 0.03, 'devnet');
const h1 = BudgetLedger.load(shared, 'devnet');
const h2 = BudgetLedger.load(shared, 'devnet');
h1.reserve(0.01);
h2.reserve(0.01);
h1.reserve(0.01);
check('a stale handle cannot reserve past the ceiling', throws(() => h2.reserve(0.01), BudgetExceededError));
check('no reservation was lost', BudgetLedger.load(shared).state.entries.length === 3);

console.log('\n11. a live holder\'s lock refuses with the fix; a stale one is cleared');
fs.writeFileSync(`${shared}.lock`, String(process.ppid));
let lockErr = null;
try { h1.release(h1.state.entries[0].id); } catch (e) { lockErr = e; }
check('a lock held by a live process blocks the spend', lockErr !== null);
check('the error names the lockfile and how to clear it',
  /locked by process \d+/.test(lockErr?.message) && lockErr.message.includes(`delete ${shared}.lock`), lockErr?.message);
const old = new Date(Date.now() - 60_000);
fs.utimesSync(`${shared}.lock`, old, old);
check('a stale lock is taken over', !throws(() => h1.release(h1.state.entries[0].id)));
check('and the lock is released afterwards', !fs.existsSync(`${shared}.lock`));

console.log('\n12. ledger contents are read exactly, or refused');
const legacy = path.join(dir, 'legacy.json');
// Written by the pre-OPS-304 code: integer atomic units, no payer field.
fs.writeFileSync(legacy, JSON.stringify({ version: 1, network: 'devnet', ceilingAtomic: 30000, createdAt: 'x', entries: [
  { id: 'a', atomic: 10000, state: 'settled' }, { id: 'b', atomic: 10000, state: 'pending' }, { id: 'c', atomic: 10000, state: 'released' }] }));
const lg = BudgetLedger.load(legacy, 'devnet');
check('a pre-OPS-304 ledger loads unchanged', lg.settledUsd === 0.01 && lg.committedUsd === 0.02 && lg.remainingUsd === 0.01, `${lg.settledUsd}/${lg.committedUsd}/${lg.remainingUsd}`);
check('its last cent can be reserved (float comparison could not)', !throws(() => lg.reserve(0.01)));
const floaty = path.join(dir, 'floaty.json');
fs.writeFileSync(floaty, JSON.stringify({ version: 1, network: 'devnet', ceilingAtomic: 1000000, entries: [{ id: 'f', atomic: 0.01, state: 'settled' }] }));
check('a non-integer amount is refused, not misread', throws(() => BudgetLedger.load(floaty)));
fs.writeFileSync(floaty, JSON.stringify({ version: 1, network: 'devnet', ceilingAtomic: 1000000, entries: [{ id: 'f', atomic: 10000, state: 'spent' }] }));
check('an unknown entry state is refused', throws(() => BudgetLedger.load(floaty)));

console.log('\n13. concurrent processes cannot overspend');
const { spawn } = require('node:child_process');
const race = path.join(dir, 'race.json');
BudgetLedger.init(race, 0.25, 'devnet');
const worker = `const {BudgetLedger}=require(${JSON.stringify(path.join(__dirname, 'budget.js'))});
  const l=BudgetLedger.load(${JSON.stringify(race)},'devnet');let n=0;
  for(let i=0;i<20;i++){try{l.reserve(0.01);n++}catch(e){if(e.name!=='BudgetExceededError')throw e}}
  console.log(n);`;
const workers = Array.from({ length: 4 }, () => spawn(process.execPath, ['-e', worker]));

// 14. A holder killed with SIGKILL mid-operation leaves its lock behind; the next spender must not hang.
function killedHolder() {
  console.log('\n14. a holder killed with kill -9 while holding the lock');
  const victim = path.join(dir, 'victim.json');
  BudgetLedger.init(victim, 1, 'devnet');
  const hold = `const {BudgetLedger}=require(${JSON.stringify(path.join(__dirname, 'budget.js'))});
    const l=BudgetLedger.load(${JSON.stringify(victim)},'devnet');
    l._withLock(()=>{console.log('locked');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,600000);});`;
  const holder = spawn(process.execPath, ['-e', hold]);
  return new Promise((resolve) => {
    holder.stdout.once('data', () => {
      holder.kill('SIGKILL');
      holder.on('exit', () => {
        check('the dead holder left its lockfile behind', fs.existsSync(`${victim}.lock`));
        const t0 = Date.now();
        const next = spawn(process.execPath, ['-e', `const {BudgetLedger}=require(${JSON.stringify(path.join(__dirname, 'budget.js'))});
          BudgetLedger.load(${JSON.stringify(victim)},'devnet').reserve(0.01);console.log('ok');`]);
        let out = '';
        next.stdout.on('data', (d) => { out += d; });
        next.on('exit', (code) => {
          const ms = Date.now() - t0;
          check('another process spends straight away (dead PID detected)', code === 0 && out.trim() === 'ok' && ms < 3000, `exit ${code}, ${ms} ms`);
          check('the reservation is on disk and the lock is gone',
            BudgetLedger.load(victim).state.entries.length === 1 && !fs.existsSync(`${victim}.lock`));
          resolve();
        });
      });
    });
  });
}
const counts = workers.map((w) => new Promise((resolve) => { let out = ''; w.stdout.on('data', (d) => { out += d; }); w.on('close', () => resolve(Number(out))); }));
Promise.all(counts).then((n) => {
  const granted = n.reduce((a, b) => a + b, 0);
  const onDisk = BudgetLedger.load(race).state.entries.length;
  check('4 processes x 20 tries granted exactly the 25 the ceiling allows', granted === 25, `granted ${granted}`);
  check('every grant is on disk', onDisk === granted, `on disk ${onDisk}`);
  return killedHolder();
}).then(() => {
  console.log(`\n${ledger.banner()}`);
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
});
