'use strict';

/**
 * Hard spend ceiling for the demo agent.
 *
 * The agent pays real USDC on mainnet, so this ceiling is the only thing between a
 * loop bug and an unbounded spend. It therefore lives on disk rather than in
 * memory: a crash that reset an in-memory counter would hand the restarted agent a
 * fresh budget, which is precisely the failure a ceiling exists to prevent.
 *
 * Spending is two-phase. `reserve()` writes a pending entry *before* the payment is
 * attempted and `settle()` or `release()` resolves it afterwards. A process that
 * dies mid-payment leaves the reservation on disk, so the budget is over-counted
 * rather than under-counted — the safe direction, and the only one that stays safe
 * when we cannot know whether the authorization settled.
 *
 * The ledger must be created explicitly. A missing file is an error, never an empty
 * budget: "has not spent anything yet" and "spent it all, then lost the ledger" are
 * indistinguishable from the file's absence, and only one of them is safe to assume.
 *
 * More than one process may spend against a ledger (the demo runner spawns the MCP server),
 * so every change takes a lockfile and re-reads the file first. Without that, two processes
 * would each reserve against the same remaining budget (OPS-304).
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/** Guards against float drift accumulating across many small USDC charges. */
const CENTS = 1e6;
// A lock held this long belongs to a process that died mid-write; every operation is milliseconds.
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 5_000;

const toAtomic = (usd) => Math.round(usd * CENTS);
const toUsd = (atomic) => atomic / CENTS;
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** @returns {boolean} False only when the PID provably does not exist; EPERM means it does. */
function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

class BudgetExceededError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BudgetExceededError';
  }
}

class BudgetLedger {
  /**
   * @param {string} file - Ledger path.
   * @param {object} state - Parsed ledger contents.
   */
  constructor(file, state) {
    this.file = file;
    this.state = state;
  }

  /**
   * Create a ledger. Refuses to overwrite an existing one, since that would reset a
   * spend history the ceiling depends on.
   *
   * @param {string} file - Ledger path.
   * @param {number} ceilingUsd - Hard lifetime ceiling in USD.
   * @param {string} [network] - Network the ceiling applies to.
   * @returns {BudgetLedger} The new ledger.
   */
  static init(file, ceilingUsd, network = 'devnet') {
    if (!Number.isFinite(ceilingUsd) || ceilingUsd <= 0) {
      throw new Error('ceilingUsd must be a positive number');
    }
    if (fs.existsSync(file)) {
      throw new Error(`refusing to overwrite an existing ledger at ${file}`);
    }
    const state = {
      version: 1,
      network,
      ceilingAtomic: toAtomic(ceilingUsd),
      createdAt: new Date().toISOString(),
      entries: [],
    };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const ledger = new BudgetLedger(file, state);
    ledger._write();
    return ledger;
  }

  /**
   * @param {string} file - Ledger path.
   * @param {string} [expectNetwork] - Refuse to load a ledger for another network.
   * @returns {BudgetLedger} The loaded ledger.
   */
  static load(file, expectNetwork = null) {
    return new BudgetLedger(file, BudgetLedger._read(file, expectNetwork));
  }

  /**
   * @param {string} file - Ledger path.
   * @param {string|null} expectNetwork - Refuse a ledger for another network.
   * @returns {object} Validated ledger state.
   */
  static _read(file, expectNetwork) {
    if (!fs.existsSync(file)) {
      throw new Error(
        `no budget ledger at ${file}. Create one explicitly with BudgetLedger.init() — `
        + 'a missing ledger is not treated as an unspent budget.',
      );
    }
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (state.version !== 1) throw new Error(`unsupported ledger version ${state.version}`);
    if (!Number.isInteger(state.ceilingAtomic) || state.ceilingAtomic <= 0) {
      throw new Error('ledger has no usable ceiling');
    }
    // A mainnet ledger loaded under a devnet run would apply real-money accounting to
    // free spend, and the reverse would spend real money against a throwaway ceiling.
    if (expectNetwork && state.network !== expectNetwork) {
      throw new Error(`ledger is for network "${state.network}", but this run is "${expectNetwork}"`);
    }
    // Amounts are integer atomic units on disk; anything else would be summed as a float and misread.
    const bad = (state.entries ?? []).find((e) => !Number.isSafeInteger(e?.atomic) || e.atomic <= 0
      || !['pending', 'settled', 'released'].includes(e?.state));
    if (!Array.isArray(state.entries) || bad) {
      throw new Error(`ledger ${file} has an entry that is not a positive integer amount in a known state `
        + `(${JSON.stringify(bad ?? state.entries).slice(0, 160)}). Refusing to read it rather than guess.`);
    }
    return state;
  }

  /**
   * Run a change against the ledger as it is on disk now, under an exclusive lock.
   *
   * @param {Function} fn - Mutates `this.state`; its return value is passed through.
   * @returns {*} What `fn` returned.
   */
  _withLock(fn) {
    const lock = `${this.file}.lock`;
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
        break;
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
        let age = 0;
        let holder = null;
        try {
          age = Date.now() - fs.statSync(lock).mtimeMs;
          holder = Number.parseInt(fs.readFileSync(lock, 'utf8'), 10);
        } catch (_) { continue; }
        // A holder killed mid-operation never removes its lock; its PID being gone proves it.
        if (age > LOCK_STALE_MS || (Number.isInteger(holder) && !processAlive(holder))) {
          fs.rmSync(lock, { force: true });
          continue;
        }
        if (Date.now() > deadline) {
          throw new Error(`budget ledger ${this.file} is locked by process ${holder ?? '(unknown)'} (${lock}). `
            + 'Refusing to spend against a budget that may be changing. If no agent is running, '
            + `delete ${lock}; it is also taken over automatically once ${LOCK_STALE_MS / 1000} s old.`);
        }
        sleepSync(20);
      }
    }
    try {
      this.state = BudgetLedger._read(this.file, this.state.network);
      const out = fn();
      this._write();
      return out;
    } finally {
      fs.rmSync(lock, { force: true });
    }
  }

  /**
   * Tie this ledger to the one key that pays against it. A ledger shared by two keys could
   * not be reconciled against either key's transfers.
   *
   * @param {string} address - Paying address.
   */
  bindPayer(address) {
    if (this.state.payer === address) return;
    this._withLock(() => {
      if (this.state.payer && this.state.payer !== address) {
        throw new Error(`ledger ${this.file} belongs to payer ${this.state.payer}, not ${address}`);
      }
      this.state.payer = address;
    });
  }

  /** Rename is atomic, so a crash mid-write cannot leave a truncated ledger. */
  _write() {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    fs.renameSync(tmp, this.file);
  }

  /** @returns {number} Ceiling in USD. */
  get ceilingUsd() {
    return toUsd(this.state.ceilingAtomic);
  }

  /** @returns {number} Settled plus still-pending spend, in USD. */
  get committedUsd() {
    return toUsd(this._committedAtomic());
  }

  /** @returns {number} Settled plus still-pending spend, atomic. */
  _committedAtomic() {
    return this.state.entries
      .filter((e) => e.state === 'pending' || e.state === 'settled')
      .reduce((sum, e) => sum + e.atomic, 0);
  }

  /** @returns {number} Confirmed spend only, in USD. */
  get settledUsd() {
    const atomic = this.state.entries
      .filter((e) => e.state === 'settled')
      .reduce((sum, e) => sum + e.atomic, 0);
    return toUsd(atomic);
  }

  /** @returns {number} What is still available to reserve, in USD. */
  get remainingUsd() {
    return toUsd(this.state.ceilingAtomic - this._committedAtomic());
  }

  /**
   * Claim budget ahead of a payment.
   *
   * @param {number} usd - Amount to reserve.
   * @param {object} [meta] - Route and free-form note, recorded for the audit trail.
   * @returns {string} Reservation id, passed to settle() or release().
   * @throws {BudgetExceededError} When the reservation would breach the ceiling.
   */
  reserve(usd, meta = {}) {
    if (!Number.isFinite(usd) || usd <= 0) throw new Error('usd must be a positive number');
    const atomic = toAtomic(usd);
    return this._withLock(() => {
      if (atomic > this.state.ceilingAtomic - this._committedAtomic()) {
        throw new BudgetExceededError(
          `budget ceiling reached: $${this.remainingUsd.toFixed(4)} remains of `
          + `$${this.ceilingUsd.toFixed(2)}, cannot reserve $${usd.toFixed(4)}`,
        );
      }
      const id = crypto.randomUUID();
      this.state.entries.push({
        id,
        at: new Date().toISOString(),
        atomic,
        state: 'pending',
        route: meta.route ?? null,
        note: meta.note ?? null,
      });
      return id;
    });
  }

  /**
   * Confirm a reservation, optionally at a different amount than quoted.
   *
   * @param {string} id - Reservation id.
   * @param {object} [opts] - `usd` to correct the amount, `note` for the trail.
   */
  settle(id, opts = {}) {
    this._withLock(() => {
      const entry = this._pending(id);
      if (opts.usd !== undefined) {
        const atomic = toAtomic(opts.usd);
        // Settling above the reservation can breach the ceiling, so it is recorded and
        // reported rather than rejected — the money has already moved by this point.
        if (atomic > entry.atomic && toUsd(atomic - entry.atomic) > this.remainingUsd) {
          console.warn(`[budget] settled $${opts.usd} over a $${toUsd(entry.atomic)} reservation — ceiling breached`);
        }
        entry.atomic = atomic;
      }
      entry.state = 'settled';
      entry.settledAt = new Date().toISOString();
      if (opts.note) entry.note = opts.note;
    });
  }

  /**
   * Return a reservation to the budget. Only safe when the payment provably did not
   * settle — a 402, a rate limit, or a local failure before the payload was sent.
   *
   * @param {string} id - Reservation id.
   * @param {string} [reason] - Why it was released.
   */
  release(id, reason = null) {
    this._withLock(() => {
      const entry = this._pending(id);
      entry.state = 'released';
      entry.releasedAt = new Date().toISOString();
      if (reason) entry.note = reason;
    });
  }

  /**
   * @param {string} id - Reservation id.
   * @returns {object} The pending entry.
   */
  _pending(id) {
    const entry = this.state.entries.find((e) => e.id === id);
    if (!entry) throw new Error(`no such reservation: ${id}`);
    if (entry.state !== 'pending') throw new Error(`reservation ${id} is already ${entry.state}`);
    return entry;
  }

  /** @returns {{network: string, ceilingUsd: number, settledUsd: number, pendingUsd: number, remainingUsd: number, calls: number}} Display summary. */
  summary() {
    return {
      network: this.state.network,
      ceilingUsd: this.ceilingUsd,
      settledUsd: this.settledUsd,
      pendingUsd: this.committedUsd - this.settledUsd,
      remainingUsd: this.remainingUsd,
      calls: this.state.entries.filter((e) => e.state === 'settled').length,
    };
  }

  /** @returns {string} One-line form for the demo overlay. */
  banner() {
    const s = this.summary();
    return `budget ${s.network}  $${s.settledUsd.toFixed(4)} spent / $${s.ceilingUsd.toFixed(2)} cap`
      + `  ($${s.remainingUsd.toFixed(4)} left, ${s.calls} paid call${s.calls === 1 ? '' : 's'})`;
  }
}

module.exports = { BudgetLedger, BudgetExceededError };

if (require.main === module) {
  (async () => {
    // Creating a ledger spends nothing, and a mainnet ceiling must exist before the API
    // switches, so an explicit AGENT_NETWORK is taken as given; unset, the API decides.
    const pinned = (process.env.AGENT_NETWORK ?? '').trim().toLowerCase();
    let network = pinned;
    if (!pinned) {
      const { resolveNetwork } = require('./zendiq-client');
      network = await resolveNetwork(process.env.ZENDIQ_API_URL ?? 'https://api.zendiq.ai', { expected: null });
    } else if (pinned !== 'devnet' && pinned !== 'mainnet') {
      throw new Error(`AGENT_NETWORK must be "devnet" or "mainnet", not "${process.env.AGENT_NETWORK}"`);
    }
    const stateDir = require('./keys').resolveStateDir();
    const file = process.env.AGENT_BUDGET_FILE ?? path.join(stateDir, `budget-${network}.json`);
    const [cmd, arg] = process.argv.slice(2);
    if (cmd === 'init') {
      const ledger = BudgetLedger.init(file, Number(arg ?? '1'), network);
      console.log(`created ${file}`);
      console.log(ledger.banner());
    } else {
      console.log(BudgetLedger.load(file, network).banner());
    }
  })().catch((err) => {
    console.error(`\n${err.message}\n`);
    process.exitCode = 1;
  });
}
