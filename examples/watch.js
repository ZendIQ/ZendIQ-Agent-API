'use strict';

/**
 * The demo spine: watch a real feed, pay ZendIQ to triage each candidate, and act on
 * the verdict.
 *
 * What this produces is a ledger (doc 19.3): what triage cost, what it declined, and
 * what it let through. That is the artefact worth showing — an agent that refuses a
 * trade and can say what it paid to find out is infrastructure; one that only prints
 * a verdict is a curl with extra steps.
 *
 * Execution is deliberately a separate, injected step. Triage is advisory and safe to
 * run anywhere; signing a swap moves real money and is gated behind an explicit
 * executor. Absent one, the run records the decision it *would* have acted on and
 * says so, rather than quietly implying it traded.
 */

const path = require('node:path');
const { BudgetLedger, BudgetExceededError } = require('./budget.js');
const { loadAgentSigner } = require('./keys.js');
const { ZendIQClient } = require('./zendiq-client.js');
const { TokenFeed, describe } = require('./feed.js');

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const NETWORK = process.env.AGENT_NETWORK ?? 'devnet';
const API = process.env.ZENDIQ_API_URL ?? 'http://127.0.0.1:3000';
const STATE_DIR = process.env.AGENT_STATE_DIR ?? path.join(__dirname, '..', 'runtime');
const BUDGET_FILE = process.env.AGENT_BUDGET_FILE ?? path.join(STATE_DIR, `budget-${NETWORK}.json`);
const TRADE_LAMPORTS = process.env.AGENT_TRADE_LAMPORTS ?? '20000000'; // 0.02 SOL
const LIMIT = Number(process.env.AGENT_LIMIT ?? '5');
const REPLAY = process.env.AGENT_FEED_REPLAY ?? null;
const CONTROL = process.env.AGENT_CONTROL !== 'off';

// The feed is paid promotion, so nearly everything in it is genuinely bad. A run that
// only ever refuses cannot be told apart from a stopped clock, so the run opens with a
// trade the engine should clear. It proves the verdicts discriminate rather than deny.
const CONTROL_CANDIDATE = {
  address: USDC_MINT,
  symbol: 'USDC',
  description: 'control',
  url: null,
  boost: 0,
  liquidityUsd: null,
  fdvUsd: null,
  priceChangeH1: null,
  ageMs: null,
  control: true,
};

/**
 * Accumulates the run ledger.
 */
class RunLedger {
  constructor(planned = null) {
    this.rows = [];
    this.planned = planned;
    this.stoppedBy = null;
  }

  add(row) {
    this.rows.push(row);
  }

  /** A run that ended early must say so — a short ledger and a complete one look alike. */
  stop(reason) {
    this.stoppedBy = reason;
  }

  get triageUsd() {
    return this.rows.reduce((n, r) => n + (r.paidUsd ?? 0), 0);
  }

  /** Control rows are excluded — they are a self-test, not a trade the agent chose. */
  count(verdict) {
    return this.rows.filter((r) => !r.control && r.verdict === verdict).length;
  }

  report() {
    const marks = { Refuse: 'REFUSE', Protect: 'PROTECT', Safe: 'SAFE' };
    const lines = ['', '─'.repeat(64), 'RUN LEDGER', ''];
    for (const r of this.rows) {
      const mark = (marks[r.verdict] ?? 'ERROR').padEnd(7);
      const tag = r.control ? ' (control)' : '';
      lines.push(`  ${mark}  ${(r.label + tag).padEnd(22)} $${r.paidUsd.toFixed(4)}  ${r.action}`);
      if (r.reason) lines.push(`           ${r.reason}`);
    }
    const control = this.rows.filter((r) => r.control);
    const candidates = this.rows.length - control.length;
    const split = control.length ? ` (${candidates} candidate${candidates === 1 ? '' : 's'}, ${control.length} control)` : '';
    lines.push('');
    lines.push(`  triage cost   $${this.triageUsd.toFixed(4)} over ${this.rows.length} call${this.rows.length === 1 ? '' : 's'}${split}`);
    lines.push(`  declined      ${this.count('Refuse')}`);
    lines.push(`  protected     ${this.count('Protect')}`);
    lines.push(`  let through   ${this.count('Safe')}`);
    for (const c of control) {
      lines.push(`  control       ${c.label} → ${c.verdict}, not counted above`);
    }
    if (this.stoppedBy) {
      lines.push('');
      lines.push(`  !! RUN TRUNCATED — ${this.stoppedBy}`);
      if (this.planned != null && this.rows.length < this.planned) {
        lines.push(`     ${this.rows.length} of ${this.planned} planned calls ran; the rest were never triaged.`);
      }
    }
    lines.push('─'.repeat(64));
    return lines.join('\n');
  }
}

/**
 * @param {object} candidate
 * @param {object} analysis - The paid verdict body.
 * @param {object|null} executor - Injected; absent means decisions are recorded only.
 * @returns {Promise<string>} What was done.
 */
async function act(candidate, analysis, executor) {
  const exec = analysis.recommendedExecution ?? {};
  if (analysis.verdict === 'Refuse') return 'skipped, no transaction built';
  if (!executor) {
    const fee = exec.priorityFeeLamports ? `${exec.priorityFeeLamports} lamports` : 'no priority fee';
    const tip = exec.jitoTipLamports ? `, ${exec.jitoTipLamports} tip` : '';
    return `would execute via ${exec.path} (${fee}${tip}) — executor not wired`;
  }
  return executor.execute(candidate, analysis);
}

/**
 * Triage one candidate and record the outcome.
 *
 * @returns {Promise<boolean>} False when the run should stop.
 */
async function handle(candidate, client, run, budget) {
  const label = candidate.symbol ?? `${candidate.address.slice(0, 4)}..${candidate.address.slice(-4)}`;
  console.log(`\n▸ ${describe(candidate)}${candidate.control ? '   [control]' : ''}`);

  let result;
  try {
    result = await client.analyse({
      inputMint: SOL_MINT,
      outputMint: candidate.address,
      amount: String(TRADE_LAMPORTS),
      slippageBps: 100,
    });
  } catch (err) {
    // A budget ceiling is the one stop condition that is a success, not a fault.
    // It still has to be stated: an unexplained short ledger reads as a crash.
    if (err instanceof BudgetExceededError) {
      console.log(`  ${err.message}`);
      console.log('  stopping here — raise the ceiling with: npm --prefix agent run budget:init -- <usd>');
      run.stop(err.message);
      return false;
    }
    throw err;
  }

  if (!result.ok) {
    console.log(`  triage failed: ${result.error}`);
    run.add({
      label,
      control: candidate.control,
      verdict: null,
      paidUsd: result.paidUsd,
      action: `triage failed: ${result.error}`,
    });
    return true;
  }

  const a = result.verdict;
  const action = await act(candidate, a, null);
  const left = budget ? `  ·  $${budget.remainingUsd.toFixed(4)} of $${budget.ceilingUsd.toFixed(2)} left` : '';
  console.log(`  ${a.verdict}  (${a.confidence} confidence)  $${result.paidUsd.toFixed(4)}${result.replayed ? ' [replayed]' : ''}${left}`);
  if (a.reasons?.[0]) console.log(`  ${a.reasons[0]}`);
  console.log(`  → ${action}`);

  run.add({
    label,
    control: candidate.control,
    verdict: a.verdict,
    paidUsd: result.paidUsd,
    action,
    reason: a.reasons?.[0] ?? null,
  });
  return true;
}

async function main() {
  const { signer, address } = await loadAgentSigner({ network: NETWORK });

  let budget;
  try {
    budget = BudgetLedger.load(BUDGET_FILE, NETWORK);
  } catch (err) {
    console.error(`\n${err.message}`);
    console.error(`hint: npm --prefix agent run budget:init -- 1.00\n`);
    process.exit(1);
  }

  console.log(`\nZendIQ agent — watch  ${NETWORK}`);
  console.log(`  api     ${API}`);
  console.log(`  wallet  ${address}`);
  console.log(`  feed    ${REPLAY ? `replay ${REPLAY}` : 'live (DexScreener boosts)'}`);
  console.log(`  size    ${Number(TRADE_LAMPORTS) / 1e9} SOL per candidate`);
  console.log(`  ${budget.banner()}\n`);

  const client = new ZendIQClient({
    signer,
    budget,
    baseUrl: API,
    network: NETWORK,
    rpcUrl: process.env.AGENT_RPC_URL,
  });

  const feed = REPLAY ? TokenFeed.replay(REPLAY, { limit: LIMIT }) : TokenFeed.live({ limit: LIMIT });
  const planned = (CONTROL ? 1 : 0) + LIMIT;
  const run = new RunLedger(planned);

  if (budget.remainingUsd <= 0) {
    console.error(`  no budget left — ${planned} planned calls, $0.0000 available`);
    console.error('  raise the ceiling with: npm --prefix agent run budget:init -- <usd>\n');
    process.exit(1);
  }

  if (CONTROL && !(await handle(CONTROL_CANDIDATE, client, run, budget))) {
    console.log(run.report());
    return;
  }

  for await (const candidate of feed) {
    if (!(await handle(candidate, client, run, budget))) break;
  }

  console.log(run.report());
  console.log(`\n  ${budget.banner()}\n`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`\nwatch failed: ${err.message}\n`);
    process.exit(1);
  });
}

module.exports = { RunLedger, act };
