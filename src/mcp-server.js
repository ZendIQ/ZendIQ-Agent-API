#!/usr/bin/env node
/**
 * ZendIQ Agent API — MCP server (stdio).
 *
 * Wrapper over POST /v1/agent/analyse. It exposes one tool and preserves the HTTP
 * response so provenance is identical across both transports.
 *
 * Agent frameworks cache MCP tool schemas, so only the stable fields are declared in
 * outputSchema. Additional provenance fields remain experimental, but are returned
 * unchanged so callers can verify that MCP and HTTP used the same evidence.
 *
 * PROTOCOL HAZARD. stdout is the transport. Anything written to it that is not a
 * JSON-RPC message corrupts the stream, and the failure looks like an unrelated
 * client-side parse error. All diagnostics go to stderr. Never console.log in here.
 *
 * Configuration:
 *   ZENDIQ_AGENT_URL          Base URL of the API. Default https://zendiq-backend.onrender.com
 *   ZENDIQ_AGENT_NETWORK      'devnet' (default) or 'mainnet'.
 *   ZENDIQ_AGENT_BUDGET_FILE  Budget ledger every payment is reserved against. Required on mainnet.
 *   ZENDIQ_AGENT_KEYPAIR      Devnet only: Solana keypair JSON file used to pay. On mainnet the
 *                             paying key comes from loadAgentSigner (AGENT_STATE_DIR or
 *                             AGENT_SECRET_SEED), which refuses to hand it out without the ledger.
 *
 * The keypair is read from disk and never leaves this process. It signs USDC payment
 * authorizations only; ZendIQ never sees it. Payments go through the same client and
 * ledger as the examples, so there is one payment path and the ceiling sees all of it (OPS-304).
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { DEVNET_RPC_URL, MAINNET_RPC_URL } = require('@x402/svm');

const PROTOCOL_FALLBACK = '2025-06-18';
const SERVER_INFO = { name: 'zendiq-agent', version: '1.0.0' };

const BASE_URL = (process.env.ZENDIQ_AGENT_URL ?? 'https://zendiq-backend.onrender.com').replace(/\/+$/, '');
const ANALYSE_URL = `${BASE_URL}/v1/agent/analyse`;
const SCREEN_URL = `${BASE_URL}/v1/agent/analyse-token`;
const KEYPAIR_PATH = process.env.ZENDIQ_AGENT_KEYPAIR ?? null;
const BUDGET_FILE = process.env.ZENDIQ_AGENT_BUDGET_FILE ?? null;
const NETWORK = process.env.ZENDIQ_AGENT_NETWORK === 'mainnet' ? 'mainnet' : 'devnet';
const DEMO_EVENTS_URL = process.env.ZENDIQ_DEMO_EVENTS_URL ?? null;

async function emitDemoEvent(type, data = {}) {
  if (!DEMO_EVENTS_URL) return;
  try {
    await fetch(DEMO_EVENTS_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type, transport: 'mcp', data }),
    });
  } catch (_) {}
}

const TOOL = {
  name: 'zendiq_triage_swap',
  title: 'Triage a Solana swap',
  description:
    'Decide how to execute a proposed Solana swap before signing it. Returns Safe '
    + '(route normally), Protect (route through a Jito bundle, with the tip to use), or '
    + 'Refuse (do not execute). Screens the output token for rug and honeypot patterns and '
    + 'estimates sandwich-attack exposure. Advisory only: no transaction is built, no keys '
    + 'are handled, and nothing is executed on your behalf. Each call costs $0.01 in USDC, '
    + 'paid automatically via x402. '
    + 'NETWORK: the API is in its testing phase, so payment settles in DEVNET USDC (free test '
    + 'money); an agent funded only on mainnet cannot pay for this call yet. At launch payment '
    + 'moves to mainnet USDC. The market data analysed is always mainnet, so the verdict is '
    + 'about real liquidity. '
    + 'The full risk breakdown behind the verdict — token risk '
    + 'factors, sandwich exposure detail, and route economics — is available on the HTTP '
    + 'endpoint POST /v1/agent/analyse. The HTTP endpoint POST /v1/agent/optimize ($0.02) '
    + 'additionally returns an unsigned mainnet transaction, so its taker must be a mainnet '
    + 'wallet holding the input amount and SOL for fees and rent, even though that call is '
    + 'also paid for in devnet USDC.',
  inputSchema: {
    type: 'object',
    properties: {
      inputMint: { type: 'string', description: 'Base58 mint address of the token being sold.' },
      outputMint: { type: 'string', description: 'Base58 mint address of the token being bought.' },
      amount: {
        type: 'string',
        description:
          "Amount to sell, in the input mint's atomic units, as a decimal string. "
          + 'For 1 SOL (9 decimals) send "1000000000".',
      },
      slippageBps: {
        type: 'integer',
        minimum: 0,
        maximum: 10_000,
        description: 'Optional slippage tolerance in basis points. Omit to use the route default.',
      },
    },
    required: ['inputMint', 'outputMint', 'amount'],
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: {
      verdict: { type: 'string', enum: ['Safe', 'Protect', 'Refuse'] },
      recommendedExecution: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Execution path to use, e.g. jupiter_direct or jito_bundle.' },
          priorityFeeLamports: { type: ['integer', 'null'] },
          jitoTipLamports: { type: ['integer', 'null'] },
        },
        required: ['path'],
      },
      reasons: {
        type: 'array',
        items: { type: 'string' },
        description: 'Plain-language justification for the verdict.',
      },
    },
    required: ['verdict', 'recommendedExecution', 'reasons'],
  },
};

const TOOL_SCREEN = {
  name: 'zendiq_screen_token',
  title: 'Screen a Solana token',
  description:
    'Screen a single Solana token by mint address, before you have a trade size. Returns '
    + 'the token risk score (rug / honeypot / mint & freeze authority / holder concentration '
    + 'signals) with a signals-resolved coverage figure and cache age. Free and rate-limited '
    + '— the cheap "should I even look at this?" call for scanning many mints. Because it is '
    + 'free, the devnet-USDC payment constraint that applies to zendiq_triage_swap does not '
    + 'apply here; the token data itself is mainnet. To score a '
    + 'specific trade (sandwich exposure, route, fees) use zendiq_triage_swap, which returns '
    + 'this same token score inline, so screening first is optional, never required.',
  inputSchema: {
    type: 'object',
    properties: {
      mint: { type: 'string', description: 'Base58 mint address of the token to screen.' },
    },
    required: ['mint'],
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: {
      tokenRisk: {
        type: 'object',
        properties: {
          score: { type: ['integer', 'null'] },
          level: { type: ['string', 'null'] },
        },
      },
      signals_resolved: { type: 'string', description: 'Signal coverage, e.g. "12/16".' },
      cache: {
        type: 'object',
        properties: {
          hit: { type: 'boolean' },
          ageSeconds: { type: 'integer', description: 'Age of the served score in seconds; 0 when freshly computed.' },
        },
      },
    },
    required: ['tokenRisk'],
  },
};

const TOOL_OPTIMIZE = {
  name: 'zendiq_optimize_swap',
  title: 'Build an optimized Solana swap',
  description:
    'Build an executable Solana swap once you have already decided to trade. Returns an '
    + 'unsigned swap transaction — a Jupiter route, or a direct venue when it beats Jupiter '
    + 'after costs — plus the structured plan and itemised net-benefit '
    + 'arithmetic behind it, so you can verify the bytes against the stated intent before '
    + 'signing. Zero custody: the transaction is never signed here — you sign and submit it '
    + 'with your own wallet. A build that fails charges nothing. Each successful call costs '
    + '$0.02 in USDC, paid automatically via x402. '
    + 'Use this when the decision to trade is already made and the open question is how to '
    + 'execute it well. It also returns the Safe / Protect / Refuse verdict with its reasons, and '
    + 'still builds the transaction on a Refuse: read `verdict` before signing, and do not sign a '
    + 'Refuse unless you mean to trade against ZendIQ\'s verdict. If the open question is still '
    + 'whether to trade at all, zendiq_triage_swap answers it for $0.01 without building anything. '
    + 'NETWORK: the API is in its testing phase, so payment settles in DEVNET USDC (free test '
    + 'money) from the paying wallet; an agent funded only on mainnet cannot pay for this call '
    + 'yet. At launch payment moves to mainnet USDC. The swap itself is always built against '
    + 'MAINNET liquidity for `taker`, a mainnet wallet that must hold the input amount and SOL '
    + 'for the network fee and token account rent (a gasless Jupiter Ultra fill is exempt from '
    + 'the SOL). A taker that cannot fund the trade gets 422 taker_insufficient_balance, '
    + 'uncharged, naming the token and the shortfall. During testing the paying wallet and the '
    + 'taker are two different wallets, and the returned transaction is only submittable by '
    + 'the taker.',
  inputSchema: {
    type: 'object',
    properties: {
      inputMint: { type: 'string', description: 'Base58 mint address of the token being sold.' },
      outputMint: { type: 'string', description: 'Base58 mint address of the token being bought.' },
      amount: {
        type: 'string',
        description:
          "Amount to sell, in the input mint's atomic units, as a decimal string. "
          + 'For 1 SOL (9 decimals) send "1000000000".',
      },
      taker: {
        type: 'string',
        description:
          'Base58 public key the swap is built for. Must be a mainnet wallet holding the '
          + 'input amount and SOL for fees and rent (a gasless Ultra fill is exempt from the '
          + 'SOL). Not the paying wallet. The returned transaction is only submittable by this '
          + 'account.',
      },
      slippageBps: {
        type: 'integer',
        minimum: 0,
        maximum: 10_000,
        description: 'Optional slippage tolerance in basis points. Omit to use the route default.',
      },
      method: {
        type: 'string',
        enum: ['jito'],
        description:
          'Optional. "jito" forces a Jito bundle venue (raydium_jito or jupiter_swap_jito) even where '
          + 'risk scoring would not bundle. Only bundle venues are considered, ranked by net value after '
          + 'the tip, and no unbundled route is substituted if none builds. The returned plan.choice is '
          + 'then "forced": your choice, not a risk decision. Submit the signed bundle to '
          + 'POST /v1/agent/bundle. Omit to let risk scoring choose.',
      },
    },
    required: ['inputMint', 'outputMint', 'amount', 'taker'],
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: {
      transaction: {
        type: 'string',
        description: 'Unsigned base64 VersionedTransaction. Verify it against `plan` before signing.',
      },
      verdict: {
        type: ['string', 'null'],
        enum: ['Safe', 'Protect', 'Refuse', null],
        description: 'The same verdict zendiq_triage_swap gives. The transaction is built even on Refuse; do not sign it unless you mean to trade against the verdict.',
      },
      reasons: { type: 'array', items: { type: 'string' } },
      plan: {
        type: 'object',
        description: 'The structured intent the transaction bytes should match.',
        properties: {
          venue: { type: 'string' },
          bundle: { type: 'boolean' },
          choice: { type: 'string', enum: ['selected', 'forced'] },
          jitoTipLamports: { type: ['integer', 'null'] },
          slippageBps: { type: ['integer', 'null'] },
        },
      },
      netBenefit: {
        type: 'object',
        description: 'Itemised cost arithmetic so the stated net can be checked, not trusted.',
        properties: {
          expectedMevLossUsd: { type: ['number', 'null'] },
          zendiqFeeUsd: { type: ['number', 'null'] },
          netUsd: { type: ['number', 'null'] },
        },
      },
      simulation: {
        type: 'object',
        description: "Pre-flight simulation. `status` is 'ok', 'failed', or 'unknown' when simulation itself was unavailable.",
        properties: { status: { type: 'string' } },
      },
      custody: { type: 'string' },
    },
    required: ['transaction', 'plan', 'netBenefit'],
  },
};

/** @type {object|null} Lazily built so a missing key or ledger fails per-call, not at boot. */
let paymentClient = null;

/**
 * The agent's payment modules: examples/ beside src/ in the published repo, agent/public/ in
 * the monorepo. Required lazily, so the free tools and tests never need them.
 *
 * @param {string} name - Module file name without extension.
 * @returns {object} Module exports.
 */
function agentModule(name) {
  const dirs = [path.join(__dirname, '..', 'examples'), path.join(__dirname, '..', '..', '..', 'agent', 'public')];
  const dir = dirs.find((d) => fs.existsSync(path.join(d, `${name}.js`)));
  if (!dir) throw new Error(`cannot find ${name}.js; expected it in ${dirs.join(' or ')}`);
  return require(path.join(dir, name));
}

/**
 * Write one JSON-RPC message to stdout.
 *
 * @param {object} msg - Message to send.
 */
function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

/**
 * Log to stderr. stdout is the protocol transport and must not be used.
 *
 * @param {...any} args - Values to log.
 */
function log(...args) {
  console.error('[zendiq-mcp]', ...args);
}

/**
 * Build the payment client: the examples' ZendIQClient, paying through loadAgentSigner and
 * reserving every payment in the budget ledger before it is signed.
 *
 * @returns {Promise<object>} ZendIQClient.
 */
async function getPaymentClient() {
  if (paymentClient) return paymentClient;
  const { loadAgentSigner } = agentModule('keys');
  const { BudgetLedger } = agentModule('budget');
  const { ZendIQClient } = agentModule('zendiq-client');

  let budget = null;
  let loaded;
  if (NETWORK === 'mainnet') {
    // A key read from an arbitrary path would skip the ledger check in loadAgentSigner.
    if (KEYPAIR_PATH) {
      throw new Error('ZENDIQ_AGENT_KEYPAIR is not accepted on mainnet. The paying key is loaded from '
        + 'AGENT_STATE_DIR/payer-mainnet.key.json or AGENT_SECRET_SEED, and only with a budget ledger.');
    }
    if (!BUDGET_FILE) {
      throw new Error('ZENDIQ_AGENT_BUDGET_FILE is required on mainnet: every payment is reserved against its ceiling.');
    }
    budget = BudgetLedger.load(BUDGET_FILE, 'mainnet');
    loaded = await loadAgentSigner({ network: 'mainnet', ledger: budget });
  } else {
    if (!KEYPAIR_PATH) {
      throw new Error('ZENDIQ_AGENT_KEYPAIR is not set. Point it at a Solana keypair JSON file holding devnet USDC.');
    }
    if (BUDGET_FILE) budget = BudgetLedger.load(BUDGET_FILE, 'devnet');
    loaded = await loadAgentSigner({ network: 'devnet', file: KEYPAIR_PATH, ledger: budget, create: false });
  }

  log(`paying as ${loaded.address} on ${NETWORK}${budget ? ` \u00b7 ${budget.banner()}` : ' \u00b7 no budget ledger'}`);
  paymentClient = new ZendIQClient({
    signer: loaded.signer,
    budget,
    baseUrl: BASE_URL,
    network: NETWORK,
    rpcUrl: NETWORK === 'mainnet' ? MAINNET_RPC_URL : DEVNET_RPC_URL,
    headers: { 'X-ZendIQ-Surface': 'mcp' },
    onEvent: emitDemoEvent,
  });
  return paymentClient;
}

/**
 * Call a paid endpoint through the payment client, which pays the 402 if one is issued.
 *
 * @param {'analyse'|'optimize'} route - Which paid endpoint.
 * @param {object} body - Validated request body.
 * @returns {Promise<object>} Parsed response body.
 */
async function callPaid(route, body) {
  const client = await getPaymentClient();
  const result = route === 'optimize' ? await client.optimise(body, { onEvent: emitDemoEvent }) : await client.analyse(body);
  if (result.ok) return route === 'optimize' ? result.order : result.verdict;
  if (result.status === 402) {
    throw new Error(failureMessage({ reason: result.error, transaction: result.settlementTx }, null));
  }
  throw new Error(result.error ?? `Request failed with status ${result.status}.`);
}

/**
 * Explain a 402 that answered a paid request, from its PAYMENT-RESPONSE header.
 *
 * @param {string|null} header - PAYMENT-RESPONSE header, base64 JSON.
 * @param {object|null} parsed - Response body.
 * @returns {string} Message for the agent.
 */
function paidFailureMessage(header, parsed) {
  let settle = null;
  try {
    if (header) settle = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
  } catch (_) { /* header shape is the facilitator's, not ours */ }
  return failureMessage({ reason: settle?.errorReason ?? null, transaction: settle?.transaction ?? null }, parsed);
}

/**
 * Explain a payment that was not served. Only the settlement reason says whether money moved.
 *
 * @param {{reason: string|null, transaction: string|null}} settle - Settlement outcome.
 * @param {object|null} parsed - Response body.
 * @returns {string} Message for the agent.
 */
function failureMessage({ reason, transaction }, parsed) {
  if (reason === 'settlement_pending') {
    return 'Settlement could not be confirmed, and a retry with the same payment was not served either, so this payment MAY have been charged. '
      + `Check transaction ${transaction || '(not reported)'} on chain before calling again.`;
  }
  if (reason === 'settlement_failed_on_chain' || reason === 'settlement_not_landed') {
    return `Payment did not settle (${reason}) and nothing was charged. Calling again signs a fresh authorization.`;
  }
  return parsed?.message
    ?? `Payment was rejected${reason ? ` (${reason})` : ''}. Check the paying wallet holds USDC on this network.`;
}

/**
 * Reduce the full analysis to the three fields this surface commits to.
 *
 * @param {object} full - Full /analyse response.
 * @returns {object} Narrow projection.
 */
function project(full) {
  return full;
}

/**
 * Normalise and check tool arguments before spending money on them.
 *
 * @param {object} args - Raw tool arguments.
 * @returns {object} Request body.
 */
function buildRequest(args) {
  const a = args ?? {};

  let amount = a.amount;
  if (typeof amount === 'number') {
    if (!Number.isSafeInteger(amount)) {
      throw new Error('amount exceeds safe integer precision as a number. Send it as a decimal string.');
    }
    amount = String(amount);
  }
  if (typeof amount !== 'string' || !/^\d{1,20}$/.test(amount) || BigInt(amount) <= 0n) {
    throw new Error("amount must be a positive integer string in the input mint's atomic units.");
  }
  if (typeof a.inputMint !== 'string' || typeof a.outputMint !== 'string') {
    throw new Error('inputMint and outputMint are required base58 mint addresses.');
  }

  const body = { inputMint: a.inputMint, outputMint: a.outputMint, amount };
  if (a.slippageBps !== undefined && a.slippageBps !== null) body.slippageBps = Number(a.slippageBps);
  return body;
}

/**
 * Validate the single mint argument for the free screen tool.
 *
 * @param {object} args - Raw tool arguments.
 * @returns {string} Base58 mint.
 */
function buildScreenRequest(args) {
  const mint = String(args?.mint ?? '');
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) {
    throw new Error('mint must be a base58 Solana mint address.');
  }
  return mint;
}

/**
 * Validate optimize arguments — the analyse fields plus the taker the swap is built for.
 *
 * @param {object} args - Raw tool arguments.
 * @returns {object} Request body.
 */
function buildOptimizeRequest(args) {
  const body = buildRequest(args);
  const taker = String(args?.taker ?? '');
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(taker)) {
    throw new Error('taker must be a base58 Solana public key — the mainnet wallet the swap is built for.');
  }
  body.taker = taker;
  if (args?.method !== undefined && args?.method !== null) {
    if (args.method !== 'jito') throw new Error('method must be "jito" to force a Jito bundle, or omitted to let risk scoring choose.');
    body.method = 'jito';
  }
  return body;
}

/**
 * Call the free screen endpoint. No payment: the route is not behind the x402 gate,
 * so this is a plain POST with no 402 handling.
 *
 * @param {string} mint - Base58 mint.
 * @returns {Promise<object>} Parsed response body.
 */
async function callScreen(mint) {
  const res = await fetch(SCREEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-ZendIQ-Surface': 'mcp' },
    body: JSON.stringify({ mint }),
  });
  const parsed = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(parsed?.message ?? `Screen failed with status ${res.status}.`);
  }
  return parsed;
}

/**
 * Handle one JSON-RPC request.
 *
 * @param {object} msg - Decoded request.
 * @returns {Promise<object|null>} Result, or null for notifications.
 */
async function handle(msg) {
  switch (msg.method) {
    case 'initialize':
      return {
        // Echo the client's version when it states one, so we stay compatible as the
        // spec moves rather than pinning to whatever was current when this was written.
        protocolVersion: msg.params?.protocolVersion ?? PROTOCOL_FALLBACK,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
      };

    case 'ping':
      return {};

    case 'tools/list':
      return { tools: [TOOL, TOOL_SCREEN, TOOL_OPTIMIZE] };

    case 'tools/call': {
      const name = msg.params?.name;
      if (name !== TOOL.name && name !== TOOL_SCREEN.name && name !== TOOL_OPTIMIZE.name) {
        throw Object.assign(new Error(`Unknown tool: ${name}`), { code: -32602 });
      }
      try {
        let result;
        if (name === TOOL_SCREEN.name) {
          result = await callScreen(buildScreenRequest(msg.params?.arguments));
        } else if (name === TOOL_OPTIMIZE.name) {
          result = await callPaid('optimize', buildOptimizeRequest(msg.params?.arguments));
        } else {
          result = project(await callPaid('analyse', buildRequest(msg.params?.arguments)));
        }
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        };
      } catch (err) {
        // Tool failures are reported in-band so the model can react, rather than as a
        // protocol error the framework swallows.
        log('tool call failed —', err.message);
        return { content: [{ type: 'text', text: `${name} failed: ${err.message}` }], isError: true };
      }
    }

    default:
      throw Object.assign(new Error(`Method not found: ${msg.method}`), { code: -32601 });
  }
}

function start() {
  const rl = readline.createInterface({ input: process.stdin });

  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    }

    // Notifications carry no id and must never be answered.
    if (msg.id === undefined || msg.id === null) return;

    try {
      send({ jsonrpc: '2.0', id: msg.id, result: await handle(msg) });
    } catch (err) {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: err.code ?? -32603, message: err.message } });
    }
  });

  rl.on('close', () => process.exit(0));
  log(`ready — ${ANALYSE_URL} (${NETWORK})`);
}

if (require.main === module) start();

module.exports = { project, buildRequest, buildOptimizeRequest, paidFailureMessage, handle, start, emitDemoEvent };
