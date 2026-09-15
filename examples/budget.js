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
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/** Guards against float drift accumulating across many small USDC charges. */
const CENTS = 1e6;

const toAtomic = (usd) => Math.round(usd * CENTS);
const toUsd = (atomic) => atomic / CENTS;

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
    return new BudgetLedger(file, state);
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
    const atomic = this.state.entries
      .filter((e) => e.state === 'pending' || e.state === 'settled')
      .reduce((sum, e) => sum + e.atomic, 0);
    return toUsd(atomic);
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
    return toUsd(this.state.ceilingAtomic) - this.committedUsd;
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
    if (toUsd(atomic) > this.remainingUsd) {
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
    this._write();
    return id;
  }

  /**
   * Confirm a reservation, optionally at a different amount than quoted.
   *
   * @param {string} id - Reservation id.
   * @param {object} [opts] - `usd` to correct the amount, `note` for the trail.
   */
  settle(id, opts = {}) {
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
    this._write();
  }

  /**
   * Return a reservation to the budget. Only safe when the payment provably did not
   * settle — a 402, a rate limit, or a local failure before the payload was sent.
   *
   * @param {string} id - Reservation id.
   * @param {string} [reason] - Why it was released.
   */
  release(id, reason = null) {
    const entry = this._pending(id);
    entry.state = 'released';
    entry.releasedAt = new Date().toISOString();
    if (reason) entry.note = reason;
    this._write();
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
  const network = process.env.AGENT_NETWORK ?? 'devnet';
  const file = process.env.AGENT_BUDGET_FILE ?? path.join(__dirname, `budget-${network}.json`);
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === 'init') {
    const ledger = BudgetLedger.init(file, Number(arg ?? '1'), network);
    console.log(`created ${file}`);
    console.log(ledger.banner());
  } else {
    console.log(BudgetLedger.load(file).banner());
  }
}
