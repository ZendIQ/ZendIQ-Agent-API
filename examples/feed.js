'use strict';

/**
 * Token feed for the demo agent.
 *
 * The source is DexScreener's boosted-token list: tokens someone is paying to
 * promote. That is not an arbitrary choice of feed — it is the population ZendIQ
 * exists to triage, because paid promotion is what puts a naive agent in front of a
 * token it has no business buying.
 *
 * Three modes, because the demo and the proof have different needs (doc 19.3):
 *   live    — hit the real API.
 *   record  — live, but append every batch to JSONL as it arrives.
 *   replay  — read a recording back. The run was real; the playback is controlled,
 *             so a submission window does not depend on what the feed happens to be
 *             doing at the time.
 *
 * Recordings hold *enriched* candidates, not raw API rows. If replay re-fetched
 * market context it would still be making live calls, so the playback would neither
 * be reproducible nor survive a room with bad wifi — which is the entire reason for
 * recording it.
 *
 * Dedupe is by token address and is load-bearing for *spend*, not tidiness: a
 * boosted token stays boosted for hours, so an un-deduped feed would re-triage the
 * same token every poll and pay for each one. It is in-memory, so a restart will
 * pay once more per token; the budget ceiling is what bounds that, not this map.
 */

const fs = require('node:fs');
const path = require('node:path');

const BOOSTS_URL = 'https://api.dexscreener.com/token-boosts/latest/v1';
const PAIRS_URL = 'https://api.dexscreener.com/token-pairs/v1/solana';

/**
 * @param {number} ms
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Shape a raw boost record into the only fields the agent depends on.
 *
 * @param {object} raw - DexScreener boost entry.
 * @returns {object|null} Candidate, or null if unusable.
 */
function normalise(raw) {
  if (!raw || raw.chainId !== 'solana' || typeof raw.tokenAddress !== 'string') return null;
  return {
    address: raw.tokenAddress,
    description: typeof raw.description === 'string' ? raw.description.slice(0, 280) : '',
    url: raw.url ?? null,
    boost: Number(raw.totalAmount ?? raw.amount ?? 0) || 0,
    symbol: null,
    liquidityUsd: null,
    fdvUsd: null,
    priceChangeH1: null,
    ageMs: null,
  };
}

class FeedError extends Error {}

class TokenFeed {
  /**
   * @param {object} opts - `mode`, `pollMs`, `recordTo`, `file`, `speed`, `enrich`, `limit`.
   */
  constructor(opts = {}) {
    this.mode = opts.mode ?? 'live';
    this.pollMs = opts.pollMs ?? 30_000;
    this.recordTo = opts.recordTo ?? null;
    this.file = opts.file ?? null;
    this.speed = opts.speed ?? 4;
    this.enrich = opts.enrich !== false;
    this.limit = opts.limit ?? Infinity;
    this.seen = new Set();
    this.emitted = 0;

    if (this.mode === 'replay' && !this.file) throw new FeedError('replay mode needs a file');
    if (this.recordTo) fs.mkdirSync(path.dirname(this.recordTo), { recursive: true });
  }

  static live(opts = {}) {
    return new TokenFeed({ ...opts, mode: 'live' });
  }

  static record(recordTo, opts = {}) {
    return new TokenFeed({ ...opts, mode: 'live', recordTo });
  }

  static replay(file, opts = {}) {
    return new TokenFeed({ ...opts, mode: 'replay', file });
  }

  /**
   * One batch from the live API.
   *
   * @returns {Promise<object[]>} Raw solana boost entries.
   */
  async fetchBatch() {
    let response;
    try {
      response = await fetch(BOOSTS_URL, { headers: { accept: 'application/json' } });
    } catch (err) {
      throw new FeedError(`feed unreachable: ${err.message}`);
    }
    if (!response.ok) throw new FeedError(`feed returned http ${response.status}`);

    const body = await response.json().catch(() => null);
    if (!Array.isArray(body)) throw new FeedError('feed returned a non-array body');
    return body.filter((x) => x?.chainId === 'solana');
  }

  /**
   * Best-effort market context. A failure here downgrades the label, never the
   * verdict: triage is the backend's job and does not depend on these fields.
   *
   * @param {object} candidate - Mutated in place.
   */
  async enrichCandidate(candidate) {
    try {
      const response = await fetch(`${PAIRS_URL}/${candidate.address}`, {
        headers: { accept: 'application/json' },
      });
      if (!response.ok) {
        console.warn(`  [feed] enrich ${candidate.address.slice(0, 6)} http ${response.status}`);
        return;
      }
      const body = await response.json().catch(() => null);
      const pair = Array.isArray(body) ? body[0] : body;
      if (!pair) return;

      candidate.symbol = pair.baseToken?.symbol ?? null;
      candidate.liquidityUsd = Number(pair.liquidity?.usd ?? 0) || null;
      candidate.fdvUsd = Number(pair.fdv ?? 0) || null;
      candidate.priceChangeH1 = Number(pair.priceChange?.h1 ?? 0) || null;
      candidate.ageMs = pair.pairCreatedAt ? Date.now() - Number(pair.pairCreatedAt) : null;
    } catch (err) {
      console.warn(`  [feed] enrich ${candidate.address.slice(0, 6)} failed: ${err.message}`);
    }
  }

  /**
   * @param {object[]} candidates - Enriched, so replay needs no network.
   */
  _append(candidates) {
    if (!this.recordTo || candidates.length === 0) return;
    try {
      fs.appendFileSync(this.recordTo, `${JSON.stringify({ at: Date.now(), candidates })}\n`);
    } catch (err) {
      console.warn(`  [feed] could not record batch: ${err.message}`);
    }
  }

  /**
   * @returns {object[]} Recorded batches.
   */
  _readRecording() {
    let text;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch (err) {
      throw new FeedError(`no recording at ${this.file} (${err.code ?? err.message})`);
    }
    const batches = text
      .split('\n')
      .map((line) => line.trim()) // a CRLF checkout leaves \r, which survives filter(Boolean)
      .filter(Boolean)
      .map((line, i) => {
        try {
          return JSON.parse(line);
        } catch (_) {
          throw new FeedError(`recording line ${i + 1} is not valid JSON`);
        }
      });
    if (batches.length === 0) throw new FeedError(`recording ${this.file} is empty`);
    return batches;
  }

  /**
   * Yields candidates, newest first within a batch, never the same token twice.
   */
  async *[Symbol.asyncIterator]() {
    const batches = this.mode === 'replay' ? this._readRecording() : null;
    let index = 0;

    while (this.emitted < this.limit) {
      let entries;
      let gapMs = this.pollMs;

      if (batches) {
        if (index >= batches.length) return;
        entries = batches[index].candidates ?? [];
        const next = batches[index + 1];
        gapMs = next ? Math.max(0, (next.at - batches[index].at) / this.speed) : 0;
        index += 1;
      } else {
        entries = await this.fetchBatch();
      }

      const recorded = [];
      for (const entry of entries) {
        if (this.emitted >= this.limit) break;
        // Replay entries are already normalised and enriched.
        const candidate = batches ? entry : normalise(entry);
        if (!candidate || this.seen.has(candidate.address)) continue;
        this.seen.add(candidate.address);
        if (!batches && this.enrich) await this.enrichCandidate(candidate);
        recorded.push(candidate);
        this.emitted += 1;
        yield candidate;
      }
      this._append(recorded);

      if (batches && index >= batches.length) return;
      if (this.emitted >= this.limit) return;
      await sleep(gapMs);
    }
  }
}

/**
 * @param {number} ms
 * @returns {string} Age in the largest unit that stays readable — hours for a fresh
 *   launch, years for an established token.
 */
function formatAge(ms) {
  const hours = Math.max(0, ms / 3_600_000);
  if (hours < 48) return `${Math.round(hours)}h`;
  const days = hours / 24;
  if (days < 365) return `${Math.round(days)}d`;
  return `${(days / 365).toFixed(1)}y`;
}

/**
 * @param {object} c - Candidate.
 * @returns {string} One-line description for the console.
 */
function describe(c) {
  const bits = [];
  if (c.liquidityUsd) bits.push(`liq $${Math.round(c.liquidityUsd).toLocaleString('en-US')}`);
  if (c.priceChangeH1) bits.push(`1h ${c.priceChangeH1 > 0 ? '+' : ''}${c.priceChangeH1}%`);
  if (c.ageMs != null) bits.push(`age ${formatAge(c.ageMs)}`);
  const label = c.symbol ?? `${c.address.slice(0, 4)}..${c.address.slice(-4)}`;
  return bits.length ? `${label}  ${bits.join('  ')}` : label;
}

module.exports = { TokenFeed, FeedError, normalise, describe };

if (require.main === module) {
  const [cmd, arg] = process.argv.slice(2);
  const limit = Number(process.env.FEED_LIMIT ?? '5');

  (async () => {
    const feed =
      cmd === 'record'
        ? TokenFeed.record(arg ?? path.join(__dirname, 'recordings', `feed-${Date.now()}.jsonl`), { limit })
        : cmd === 'replay'
          ? TokenFeed.replay(arg, { limit })
          : TokenFeed.live({ limit });

    console.log(`feed ${cmd ?? 'live'}  limit ${limit}\n`);
    for await (const c of feed) console.log(`  ${describe(c)}`);
    console.log(`\n${feed.emitted} candidates`);
  })().catch((err) => {
    console.error(`feed failed: ${err.message}`);
    process.exit(1);
  });
}
