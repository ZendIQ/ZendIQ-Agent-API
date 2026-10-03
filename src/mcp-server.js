#!/usr/bin/env node
/**
 * ZendIQ Agent API — MCP server (stdio).
 *
 * Wrapper over the Agent API: three tools (screen, triage, optimize). It preserves the HTTP
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
 *   ZENDIQ_AGENT_URL          Base URL of the API. Default https://api.zendiq.ai
 *   ZENDIQ_AGENT_NETWORK      'mainnet' (default) or 'devnet'. Any other value refuses to pay.
 *   AGENT_STATE_DIR           Where the paying key and budget ledger live. Default ~/.zendiq when
 *                             run from the npm package, runtime/ beside a clone. Never the npm cache.
 *   ZENDIQ_AGENT_BUDGET_FILE  Budget ledger every payment is reserved against. Default
 *                             <state dir>/budget-<network>.json, created by `budget init <usd>`.
 *   ZENDIQ_AGENT_KEYPAIR      Devnet only: Solana keypair JSON file used to pay. On mainnet the
 *                             paying key is <state dir>/payer-mainnet.key.json, loaded only with
 *                             the ledger. AGENT_SECRET_SEED is a CI override; a seed that disagrees
 *                             with a key file stops the server rather than winning silently.
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
const SERVER_INFO = { name: 'zendiq-agent', version: packageVersion() };

const BASE_URL = (process.env.ZENDIQ_AGENT_URL ?? 'https://api.zendiq.ai').replace(/\/+$/, '');
const ANALYSE_URL = `${BASE_URL}/v1/agent/analyse`;
const SCREEN_URL = `${BASE_URL}/v1/agent/analyse-token`;
const KEYPAIR_PATH = process.env.ZENDIQ_AGENT_KEYPAIR ?? null;
const BUDGET_FILE = process.env.ZENDIQ_AGENT_BUDGET_FILE ?? null;
// A typo must not fall back to either network: devnet would fail every payment quietly,
// mainnet would spend. null makes the paying tools refuse and say why.
const NETWORK_SETTING = (process.env.ZENDIQ_AGENT_NETWORK ?? '').trim().toLowerCase() || 'mainnet';
const NETWORK = ['mainnet', 'devnet'].includes(NETWORK_SETTING) ? NETWORK_SETTING : null;
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
    'Call before signing a Solana swap, to decide whether and how to trade it. Returns Safe '
    + '(trade normally), Protect (trade through a Jito bundle, with the tip to use) or Refuse '
    + '(do not trade), with plain-language reasons, the output token\'s risk score, the sandwich '
    + 'exposure for this trade size, and the route. Builds no transaction and handles no keys. '
    + '$0.01 in USDC per call, paid via x402 on Solana mainnet; the market data is mainnet. '
    + 'To get the transaction itself, call zendiq_optimize_swap.',
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
    'Call first, whenever you are considering a Solana token and have no trade yet: is this '
    + 'mint safe to touch? Returns a 0-100 risk score and level, the 16 checks behind it '
    + '(authorities, holders, rug flags, LP lock, creator history and more), coverage as '
    + 'signals_resolved, and cache age. Treat an unknown check as unknown, never as safe. Free, '
    + 'no wallet or payment; mainnet data. To judge a specific trade, call zendiq_triage_swap.',
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
    'Call once you have decided to trade and need the transaction. Returns an unsigned swap '
    + 'transaction (the Jupiter route, or a direct venue or Jito bundle that beats it after every '
    + 'cost), the plan to verify it against, submit instructions, a simulation, itemised '
    + 'netBenefit, and the same verdict as zendiq_triage_swap. A Refuse is still built: read '
    + 'verdict before signing. You sign and submit it. $0.02 USDC via '
    + 'x402 on Solana mainnet; a failed build is free. taker must hold the input and SOL for fees.',
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
          + 'SOL). Can be the paying wallet or a different one. The returned transaction is only '
          + 'submittable by this account. A taker that cannot fund the trade gets '
          + '422 taker_insufficient_balance, uncharged, naming the token and the shortfall.',
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
          jitoTipUsd: { type: ['number', 'null'] },
          jupiterPlatformFeeUsd: { type: ['number', 'null'], description: "Jupiter's own fee on this trade; 0 off Jupiter Ultra, null when it could not be priced." },
          priorityFeeUsd: { type: ['number', 'null'], description: 'Priority fee the taker pays, decoded from the transaction; 0 on a bundle or gasless fill.' },
          netUsd: { type: ['number', 'null'], description: 'expectedMevLossUsd − zendiqFeeUsd − jitoTipUsd − jupiterPlatformFeeUsd − priorityFeeUsd, on routes that claim MEV protection; see netUsdBasis when null.' },
          netUsdBasis: { type: 'string' },
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
 * The published package's version; in the monorepo there is no such package beside src/.
 *
 * @returns {string} Version.
 */
function packageVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    if (pkg.name === '@zendiq/mcp' && pkg.version) return pkg.version;
  } catch (_) { /* not running from the package */ }
  return '0.0.0-dev';
}

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
  const { loadAgentSigner, resolveStateDir } = agentModule('keys');
  const { BudgetLedger } = agentModule('budget');
  const { ZendIQClient } = agentModule('zendiq-client');

  let budget = null;
  let loaded;
  if (!NETWORK) {
    throw new Error(`ZENDIQ_AGENT_NETWORK must be "mainnet" or "devnet", not "${process.env.ZENDIQ_AGENT_NETWORK}".`);
  }
  const stateDir = resolveStateDir();
  const budgetFile = budgetFilePath(stateDir);
  if (NETWORK === 'mainnet') {
    // A key read from an arbitrary path would skip the ledger check in loadAgentSigner.
    if (KEYPAIR_PATH) {
      throw new Error('ZENDIQ_AGENT_KEYPAIR is not accepted on mainnet. The paying key is loaded from '
        + 'AGENT_STATE_DIR/payer-mainnet.key.json, and only with a budget ledger.');
    }
    if (!fs.existsSync(budgetFile)) {
      throw new Error(`no budget ledger at ${budgetFile}: every mainnet payment is reserved against its ceiling. `
        + 'Create one with: npx -y @zendiq/mcp budget init 1.00');
    }
    budget = BudgetLedger.load(budgetFile, 'mainnet');
    loaded = await loadAgentSigner({ network: 'mainnet', ledger: budget, stateDir });
  } else {
    if (!KEYPAIR_PATH) {
      throw new Error('ZENDIQ_AGENT_KEYPAIR is not set. Point it at a Solana keypair JSON file holding devnet USDC.');
    }
    if (fs.existsSync(budgetFile)) budget = BudgetLedger.load(budgetFile, 'devnet');
    loaded = await loadAgentSigner({ network: 'devnet', file: KEYPAIR_PATH, ledger: budget, create: false, stateDir });
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

/**
 * The ledger `budget init` creates, unless ZENDIQ_AGENT_BUDGET_FILE names another.
 *
 * @param {string} stateDir - Resolved state directory.
 * @returns {string} Ledger path.
 */
function budgetFilePath(stateDir) {
  return BUDGET_FILE ?? path.join(stateDir, `budget-${NETWORK}.json`);
}

/**
 * `budget init <usd>` creates the spend ceiling; `budget` shows it. Output goes to stderr
 * like everything else here, so the command is safe inside an MCP client's config too.
 *
 * @param {string[]} args - Arguments after `budget`.
 * @returns {number} Exit code.
 */
function budgetCommand(args) {
  if (!NETWORK) {
    log(`ZENDIQ_AGENT_NETWORK must be "mainnet" or "devnet", not "${process.env.ZENDIQ_AGENT_NETWORK}".`);
    return 1;
  }
  try {
    const { BudgetLedger } = agentModule('budget');
    const file = budgetFilePath(agentModule('keys').resolveStateDir());
    if (args[0] === 'init') {
      const ceiling = Number(args[1]);
      if (!(ceiling > 0)) {
        log('usage: npx -y @zendiq/mcp budget init <ceiling in USD>, for example 1.00');
        return 1;
      }
      const ledger = BudgetLedger.init(file, ceiling, NETWORK);
      log(`created ${file}`);
      log(ledger.banner());
    } else if (!fs.existsSync(file)) {
      log(`no budget ledger at ${file}. Create one with: npx -y @zendiq/mcp budget init 1.00`);
      return 1;
    } else {
      log(`${file}: ${BudgetLedger.load(file, NETWORK).banner()}`);
    }
    return 0;
  } catch (err) {
    log(err.message);
    return 1;
  }
}

async function start() {
  // Resolved up front so a state folder inside the npm cache, or two keys that disagree, stop
  // the server before it serves anything.
  let stateDir;
  let payer;
  try {
    const keys = agentModule('keys');
    stateDir = keys.resolveStateDir();
    payer = await describePayer(keys, stateDir);
  } catch (err) {
    log(err.message);
    process.exitCode = 1;
    return;
  }
  log(payer);
  const rl = readline.createInterface({ input: process.stdin });
  const inFlight = new Set();

  rl.on('line', (line) => {
    const reply = respond(line);
    inFlight.add(reply);
    reply.finally(() => inFlight.delete(reply));
  });

  // A client that writes its requests and closes stdin still gets every answer. The process
  // then exits on its own: process.exit() during fetch teardown aborts Node on Windows.
  rl.on('close', async () => {
    await Promise.allSettled([...inFlight]);
    process.exitCode = 0;
  });
  log(`ready — ${ANALYSE_URL} (${NETWORK ?? `invalid ZENDIQ_AGENT_NETWORK "${NETWORK_SETTING}" — paid tools will refuse`}) · state ${stateDir}`);
}

/**
 * Parse one stdin line and write its reply.
 *
 * @param {string} line - Raw line.
 * @returns {Promise<void>} Settles once the reply is written.
 */
async function respond(line) {
  const trimmed = line.trim();
  if (!trimmed) return;

  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }

  // Notifications carry no id and must never be answered.
  if (msg.id === undefined || msg.id === null) return;

  try {
    send({ jsonrpc: '2.0', id: msg.id, result: await handle(msg) });
  } catch (err) {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: err.code ?? -32603, message: err.message } });
  }
}

/**
 * Name the key the paid tools would pay with, from the same sources they read.
 *
 * @param {object} keys - The keys module.
 * @param {string} stateDir - Resolved state directory.
 * @returns {Promise<string>} One stderr line.
 * @throws {Error} When two key sources disagree.
 */
async function describePayer(keys, stateDir) {
  if (!NETWORK) return 'payer: none (ZENDIQ_AGENT_NETWORK is invalid; paid tools will refuse)';
  if (NETWORK === 'devnet' && !KEYPAIR_PATH) return 'payer: none (devnet needs ZENDIQ_AGENT_KEYPAIR; paid tools will refuse)';
  const found = await keys.findPayerKey({
    network: NETWORK, stateDir, file: NETWORK === 'devnet' ? KEYPAIR_PATH : null,
  });
  return found.address
    ? `payer: ${found.address} (source: ${found.source})`
    : `payer: none (no key at ${found.file}; the free tool works, paid tools will refuse)`;
}

if (require.main === module) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'budget') process.exitCode = budgetCommand(rest);
  else start();
}

module.exports = { project, buildRequest, buildOptimizeRequest, paidFailureMessage, handle, start, emitDemoEvent, budgetCommand };
