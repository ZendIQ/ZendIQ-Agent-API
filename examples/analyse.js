'use strict';

/**
 * One paid /analyse call, end to end, under a hard budget ceiling.
 *
 * The smallest thing that is genuinely the demo: the agent holds its own key,
 * discovers the price from a 402, decides whether it can afford it, pays, and reads
 * a verdict back. Execution comes next; this proves the paid path.
 *
 * Run: npm --prefix agent run analyse
 */

const path = require('node:path');
const { BudgetLedger } = require('./budget');
const { loadAgentSigner } = require('./keys');
const { ZendIQClient } = require('./zendiq-client');

const NETWORK = process.env.AGENT_NETWORK ?? 'devnet';
const BASE_URL = process.env.ZENDIQ_API_URL ?? 'http://127.0.0.1:3000';
const RPC_URL = process.env.AGENT_RPC_URL
  ?? (NETWORK === 'mainnet' ? 'https://api.mainnet-beta.solana.com' : 'https://api.devnet.solana.com');
const STATE_DIR = process.env.AGENT_STATE_DIR ?? path.join(__dirname, '..', 'runtime');
const BUDGET_FILE = process.env.AGENT_BUDGET_FILE ?? path.join(STATE_DIR, `budget-${NETWORK}.json`);

// SOL -> BONK: a memecoin output, so the verdict exercises the token-class path
// that §12.2.1 made the primary Protect trigger.
const SWAP = {
  inputMint: 'So11111111111111111111111111111111111111112',
  outputMint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
  amount: '500000000',
  slippageBps: 100,
};

(async () => {
  let budget;
  try {
    budget = BudgetLedger.load(BUDGET_FILE, NETWORK);
  } catch (err) {
    console.error(`\n${err.message}\n`);
    console.error(`  AGENT_NETWORK=${NETWORK} npm --prefix agent run budget:init -- 1.00\n`);
    process.exit(1);
  }

  const { address, source } = await loadAgentSigner({ network: NETWORK });

  console.log(`\nZendIQ agent  ${NETWORK}`);
  console.log(`  api     ${BASE_URL}`);
  console.log(`  wallet  ${address}`);
  console.log(`  key     ${source}`);
  console.log(`  ${budget.banner()}\n`);

  const { signer } = await loadAgentSigner({ network: NETWORK });
  const client = new ZendIQClient({ signer, budget, baseUrl: BASE_URL, network: NETWORK, rpcUrl: RPC_URL });

  const manifest = await client.manifest();
  console.log(`manifest  ${manifest.version ?? '?'}  ${manifest.network ?? ''}`);

  console.log(`\nanalyse   ${SWAP.amount} lamports SOL -> BONK`);
  const started = Date.now();
  const result = await client.analyse(SWAP);
  const ms = Date.now() - started;

  if (!result.ok) {
    console.log(`  ${result.status}  ${result.error}  (${ms} ms)`);
    console.log(`\n  ${budget.banner()}\n`);
    process.exit(1);
  }

  const v = result.verdict;
  console.log(`  ${result.status}  ${ms} ms  paid $${result.paidUsd.toFixed(4)}${result.replayed ? ' (replayed)' : ''}`);
  console.log(`\n  verdict     ${v.verdict}`);
  if (v.reasons?.length) for (const r of v.reasons) console.log(`              - ${r}`);
  if (v.recommendedExecution) {
    const e = v.recommendedExecution;
    console.log(`  execution   venue=${e.venue ?? '?'} jitoTip=${e.jitoTipLamports ?? 0} priorityFee=${e.priorityFeeLamports ?? 0}`);
  }
  if (result.settlementTx) console.log(`  settled     ${result.settlementTx}`);
  console.log(`\n  ${budget.banner()}\n`);
})();
