'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');
const { BudgetLedger } = require('../examples/budget');
const { loadAgentSigner } = require('../examples/keys');
const { ZendIQClient, signAndExecute } = require('../examples/zendiq-client');

const NETWORK = process.env.AGENT_NETWORK ?? 'devnet';
const BASE_URL = process.env.ZENDIQ_API_URL ?? 'https://zendiq-backend.onrender.com';
const RPC_URL = process.env.AGENT_RPC_URL
  ?? (NETWORK === 'mainnet' ? 'https://api.mainnet-beta.solana.com' : 'https://api.devnet.solana.com');
const EVENT_URL = process.env.ZENDIQ_DEMO_EVENTS_URL ?? 'http://127.0.0.1:4173/api/events';
const RESET_URL = EVENT_URL.replace(/\/api\/events$/, '/api/reset');
const args = process.argv.slice(2);
const valueFor = (flag, fallback) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : fallback;
};
const SWAP = {
  inputMint: 'So11111111111111111111111111111111111111112',
  outputMint: valueFor('--mint', 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'),
  amount: valueFor('--amount', '500000000'),
  slippageBps: Number(valueFor('--slippage', '100')),
};
const STATE_DIR = process.env.AGENT_STATE_DIR ?? path.join(__dirname, '..', 'runtime');
const BUDGET_FILE = process.env.AGENT_BUDGET_FILE ?? path.join(STATE_DIR, `budget-${NETWORK}.json`);
const KEY_FILE = process.env.ZENDIQ_AGENT_KEYPAIR ?? path.join(STATE_DIR, `agent-${NETWORK}.key.json`);

async function emit(type, transport, data) {
  const response = await fetch(EVENT_URL, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type, transport, data }),
  });
  if (!response.ok) throw new Error(`visualizer rejected ${type}: HTTP ${response.status}`);
}

async function preflight() {
  const [manifest, visualizer] = await Promise.all([
    fetch(`${BASE_URL}/v1/agent`),
    fetch(EVENT_URL.replace(/\/api\/events$/, '/')),
  ]);
  if (!manifest.ok) throw new Error(`Agent API preflight failed: HTTP ${manifest.status}`);
  if (!visualizer.ok) throw new Error(`Visualizer preflight failed: HTTP ${visualizer.status}`);
  if (!require('node:fs').existsSync(BUDGET_FILE)) {
    BudgetLedger.init(BUDGET_FILE, 1.00, NETWORK);
  }
  BudgetLedger.load(BUDGET_FILE, NETWORK);
  await loadAgentSigner({ network: NETWORK, file: KEY_FILE });
  console.log(`Preflight passed: ${BASE_URL} · ${NETWORK} · visualizer connected`);
}

function callMcp() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'mcp-server.js')], {
      env: {
        ...process.env,
        ZENDIQ_AGENT_URL: BASE_URL,
        ZENDIQ_AGENT_NETWORK: NETWORK,
        ZENDIQ_AGENT_KEYPAIR: KEY_FILE,
        ZENDIQ_DEMO_EVENTS_URL: EVENT_URL,
      },
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    let buffer = '';
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        if (message.id === 2) {
          child.kill();
          if (message.error || message.result?.isError) reject(new Error(message.error?.message ?? message.result.content?.[0]?.text));
          else resolve(message.result.structuredContent);
        }
      }
    });
    child.on('error', reject);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'zendiq_triage_swap', arguments: SWAP } })}\n`);
  });
}

async function main() {
  await preflight();
  if (args.includes('--check')) return;
  await fetch(RESET_URL, { method: 'POST' });

  const mcpResult = await callMcp();
  const budget = BudgetLedger.load(BUDGET_FILE, NETWORK);
  const { signer } = await loadAgentSigner({ network: NETWORK, file: KEY_FILE });
  let eventQueue = Promise.resolve();
  const client = new ZendIQClient({
    signer, budget, baseUrl: BASE_URL, network: NETWORK, rpcUrl: RPC_URL,
    onEvent: (type, data) => {
      eventQueue = eventQueue.then(() => emit(type, 'http', data));
    },
  });
  const httpResult = await client.analyse(SWAP);
  await eventQueue;
  if (!httpResult.ok) throw new Error(httpResult.error ?? `HTTP ${httpResult.status}`);

  const sameEvidence = mcpResult.evidence_fingerprint
    && mcpResult.evidence_fingerprint === httpResult.verdict.evidence_fingerprint;
  await emit('comparison_completed', 'system', {
    sameEvidence,
    evidenceFingerprint: sameEvidence ? mcpResult.evidence_fingerprint : null,
    mcpVerdict: mcpResult.verdict,
    httpVerdict: httpResult.verdict.verdict,
  });
  if (!sameEvidence) throw new Error('MCP and HTTP evidence fingerprints differ');
  console.log(`Analyse complete: ${mcpResult.verdict} · evidence ${mcpResult.evidence_fingerprint}`);

  // ---- Execution phase: optimize -> (sign -> execute) | stop at simulation ----
  // The swap is a mainnet Jupiter route, so the taker must hold the input token.
  // Default: stop at simulation (spends nothing). --execute signs + lands a real swap.
  const TAKER = process.env.ZENDIQ_TAKER ?? valueFor('--taker', signer.address);
  const doExecute = args.includes('--execute');
  const emitExec = (type, data) => { eventQueue = eventQueue.then(() => emit(type, 'exec', data)); return eventQueue; };

  const optimizeResult = await client.optimise(
    { ...SWAP, taker: TAKER },
    { onEvent: (type, data) => { emitExec(type, data); } },
  );
  await eventQueue;

  if (!optimizeResult.ok) {
    await emitExec('call_failed', { status: optimizeResult.status, message: optimizeResult.error });
    console.log(`Optimize failed: ${optimizeResult.error ?? optimizeResult.status}`);
  } else if (!doExecute) {
    await emitExec('execution_skipped', {
      reason: 'simulation_only',
      simulation: optimizeResult.order.simulation?.status ?? null,
    });
    console.log(`Optimize complete (stopped at simulation): ${optimizeResult.order.plan?.venueLabel ?? optimizeResult.order.plan?.venue}`);
  } else {
    const takerKeyFile = process.env.ZENDIQ_TAKER_KEYPAIR;
    if (!takerKeyFile) throw new Error('--execute requires ZENDIQ_TAKER_KEYPAIR (mainnet keypair for the taker wallet)');
    const taker = await loadAgentSigner({ network: 'mainnet', file: takerKeyFile });
    await emitExec('signing', { wallet: taker.address });
    await emitExec('executing', {});
    const exec = await signAndExecute({ order: optimizeResult.order, signer: taker.signer });
    if (exec.ok) await emitExec('executed', { signature: exec.signature });
    else await emitExec('call_failed', { status: exec.status, message: exec.error ?? exec.status });
    await eventQueue;
    console.log(`Execution ${exec.ok ? 'landed' : 'failed'}: ${exec.signature ?? exec.status}`);
  }
}

main().catch(async (err) => {
  try { await emit('call_failed', 'system', { message: err.message }); } catch (_) {}
  console.error(err.message);
  process.exit(1);
});