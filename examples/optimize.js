'use strict';

/**
 * One paid /optimize call, end to end, under a hard budget ceiling.
 *
 * The agent pays $0.02 in USDC, receives an UNSIGNED swap transaction plus the plan,
 * simulation, and net-benefit that produced it, and verifies the bytes. By default it
 * stops at simulation and spends nothing on-chain. Pass --execute to sign the returned
 * transaction with the taker key and submit it via Jupiter for a real landing.
 *
 * ZendIQ never sees a key and never signs: the venue/fee decision is computed server
 * side and only its result is returned here.
 *
 * Run: npm run optimize          (stop at simulation)
 *      npm run optimize -- --execute --taker <PUBKEY>
 *
 * The swap is a mainnet Jupiter route, so --taker must be a wallet that holds the
 * input token, and --execute needs its keypair in ZENDIQ_TAKER_KEYPAIR.
 */

const path = require('node:path');
const { BudgetLedger } = require('./budget');
const { loadAgentSigner } = require('./keys');
const { ZendIQClient, signAndExecute } = require('./zendiq-client');

const NETWORK = process.env.AGENT_NETWORK ?? 'devnet';
const BASE_URL = process.env.ZENDIQ_API_URL ?? 'https://zendiq-backend.onrender.com';
const RPC_URL = process.env.AGENT_RPC_URL
  ?? (NETWORK === 'mainnet' ? 'https://api.mainnet-beta.solana.com' : 'https://api.devnet.solana.com');
const STATE_DIR = process.env.AGENT_STATE_DIR ?? path.join(__dirname, '..', 'runtime');
const BUDGET_FILE = process.env.AGENT_BUDGET_FILE ?? path.join(STATE_DIR, `budget-${NETWORK}.json`);

const args = process.argv.slice(2);
const valueFor = (flag, fallback) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : fallback;
};
const doExecute = args.includes('--execute');

const SWAP = {
  inputMint: valueFor('--input', 'So11111111111111111111111111111111111111112'),
  outputMint: valueFor('--mint', 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'),
  amount: valueFor('--amount', '3000000'),
  slippageBps: Number(valueFor('--slippage', '100')),
};

(async () => {
  let budget;
  try {
    budget = BudgetLedger.load(BUDGET_FILE, NETWORK);
  } catch (err) {
    console.error(`\n${err.message}\n`);
    console.error(`  AGENT_NETWORK=${NETWORK} npm run budget:init\n`);
    process.exit(1);
  }

  const { signer, address } = await loadAgentSigner({ network: NETWORK });
  const taker = valueFor('--taker', address);

  console.log(`\nZendIQ agent  ${NETWORK}`);
  console.log(`  api     ${BASE_URL}`);
  console.log(`  payer   ${address}`);
  console.log(`  taker   ${taker}`);
  console.log(`  ${budget.banner()}\n`);

  const method = valueFor('--method', null);
  const client = new ZendIQClient({
    signer, budget, baseUrl: BASE_URL, network: NETWORK, rpcUrl: RPC_URL,
  });

  console.log(`optimize  ${SWAP.amount} ${SWAP.inputMint.slice(0, 4)}… -> ${SWAP.outputMint.slice(0, 4)}…${method ? `  [method: ${method}]` : ''}`);
  const result = await client.optimise({ ...SWAP, taker, ...(method ? { method } : {}) });

  if (!result.ok) {
    console.log(`  ${result.status}  ${result.error}`);
    console.log(`\n  ${budget.banner()}\n`);
    process.exit(1);
  }

  const o = result.order;
  console.log(`  ${result.status}  paid $${result.paidUsd.toFixed(4)}${result.replayed ? ' (replayed)' : ''}`);
  console.log(`\n  venue        ${o.plan?.venueLabel ?? o.plan?.venue}`);
  if (o.plan?.override) {
    const forced = o.plan.override.forcedVenue ?? `method ${o.plan.override.method} -> ${o.plan.venue}`;
    console.log(`  OVERRIDE     forced ${forced} — risk would have used ${o.plan.override.riskVenue}`);
  }
  // plan.priorityFee.control says what requestedLamports means, so the figure is never
  // printed without the qualifier that makes it true.
  const pf = o.plan?.priorityFee;
  const applied = pf?.appliedLamports;
  const pfLine = pf == null ? '—'
    : pf.control === 'venue_managed'
      ? (applied != null ? `${applied} lamports applied · sized by the venue` : 'sized by the venue — inside the transaction')
    : pf.control === 'ceiling' ? `${applied ?? '—'} lamports applied · ceiling ${pf.requestedLamports}`
    // Not 'spent in full': integer micro-lamport pricing rounds the budget up by 1–2 lamports.
    : pf.control === 'exact_budget' ? `${applied ?? '—'} lamports applied · budget ${pf.requestedLamports} spent, rounded up to the compute-unit price`
    : `${applied ?? pf.requestedLamports ?? '—'} lamports`;
  console.log(`  priority fee ${pfLine}`);
  if (o.plan?.jito) {
    console.log(`  jito tip     ${o.plan.jito.tipLamports} lamports → ${o.plan.jito.tipAccount} (${o.plan.jito.tipSource})`);
  }
  console.log(`  slippage     ${o.plan?.slippageBps ?? '—'} bps`);
  // Printed in every state. An omitted risk line reads as "nothing to report", which is
  // indistinguishable from "screening never ran" — the case most worth seeing.
  const tr = o.tokenRisk ?? {};
  console.log(`  token risk   ${tr.available === false
    ? `UNAVAILABLE — sized as ${tr.assumedLevel ?? 'HIGH'} (${tr.error ?? 'unknown'})`
    : `${tr.score ?? '—'} ${tr.level ?? ''}${tr.symbol ? ` (${tr.symbol})` : ''}`}`);
  const sim = o.simulation ?? {};
  const simDetail = sim.unitsConsumed ? ` (${sim.unitsConsumed} CU)` : (sim.reason ? ` (${sim.reason})` : '');
  console.log(`  simulation   ${sim.status}${simDetail}`);
  const netBasis = {
    not_claimed_on_this_route: 'not claimed on this route',
    unavailable_no_mev_estimate: 'no MEV estimate available',
    unavailable_no_sol_price: 'Jito tip could not be priced',
  }[o.netBenefit?.netUsdBasis] ?? 'unavailable';
  console.log(`  net benefit  ${o.netBenefit?.netUsd != null ? `$${o.netBenefit.netUsd.toFixed(4)}` : `— ${netBasis}`}`);
  console.log(`  transaction  ${typeof o.transaction === 'string' ? `${Buffer.from(o.transaction, 'base64').length} bytes (unsigned)` : 'none'}`);
  console.log(`  custody      ${o.custody}`);

  if (!doExecute) {
    console.log('\n  Stopped at simulation — nothing was signed or sent.');
    console.log('  Re-run with --execute (and ZENDIQ_TAKER_KEYPAIR set) to land it.\n');
    console.log(`  ${budget.banner()}\n`);
    return;
  }

  // A degraded simulation is not a pass. Signing here broadcasts a transaction nothing
  // verified, and the public RPC 429s often enough that this is routine, not an edge case.
  if (sim.status !== 'ok' && !args.includes('--force-unsimulated')) {
    console.error(`\n  Refusing to sign — simulation did not pass (${sim.status}${sim.reason ? `: ${sim.reason}` : ''}).`);
    if (sim.err) console.error(`  error        ${JSON.stringify(sim.err)}`);
    if (sim.logs?.length) for (const l of sim.logs) console.error(`  log          ${l}`);
    console.error('  Re-run to simulate again, or pass --force-unsimulated to sign without verification.');
    console.error(`\n  ${budget.banner()}\n`);
    process.exit(1);
  }

  const takerKeyFile = process.env.ZENDIQ_TAKER_KEYPAIR;
  if (!takerKeyFile) {
    console.error('\n  --execute requires ZENDIQ_TAKER_KEYPAIR (the taker wallet keypair file).\n');
    process.exit(1);
  }
  const takerSigner = await loadAgentSigner({ network: 'mainnet', file: takerKeyFile });
  if (takerSigner.address !== taker) {
    console.error(`\n  ZENDIQ_TAKER_KEYPAIR (${takerSigner.address}) does not match --taker (${taker}).\n`);
    process.exit(1);
  }

  const via = { rpc_send_transaction: 'RPC', jito_bundle: 'Jito bundle', jupiter_ultra_execute: 'Jupiter' }[o.submit?.method] ?? o.submit?.method;
  if (tr.available === false) {
    console.warn(`\n  Note: this token was never screened (${tr.error ?? 'unknown'}).`);
    console.warn(`  Fees were sized as ${tr.assumedLevel ?? 'HIGH'}, but nothing is known about the asset itself.`);
  }
  console.log(`\n  Signing and submitting via ${via}…`);
  const exec = await signAndExecute({ order: o, signer: takerSigner.signer, apiBaseUrl: BASE_URL });
  if (exec.ok) {
    console.log(`  landed     https://solscan.io/tx/${exec.signature}`);
  } else {
    console.log(`  failed     ${exec.status}${exec.error ? ` — ${exec.error}` : ''}`);
    // An unconfirmed send still has a signature worth checking; losing it would strand the trade.
    if (exec.signature) console.log(`  signature  https://solscan.io/tx/${exec.signature}`);
  }
  if (exec.bundleId) console.log(`  bundle     ${exec.bundleId}${exec.slot != null ? `  slot ${exec.slot}` : ''}`);
  console.log(`\n  ${budget.banner()}\n`);
})();
