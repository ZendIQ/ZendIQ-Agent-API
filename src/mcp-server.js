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
 *   ZENDIQ_AGENT_URL       Base URL of the API. Default http://localhost:3000
 *   ZENDIQ_AGENT_KEYPAIR   Path to a Solana CLI keypair JSON file used to pay.
 *   ZENDIQ_AGENT_NETWORK   'devnet' (default) or 'mainnet'.
 *
 * The keypair is read from disk at startup and never leaves this process. It signs
 * USDC payment authorizations only; ZendIQ never sees it, and the API never returns
 * a transaction to sign.
 */

'use strict';

const fs = require('node:fs');
const readline = require('node:readline');
const { createKeyPairSignerFromPrivateKeyBytes } = require('@solana/kit');
const { x402Client, x402HTTPClient } = require('@x402/core/client');
const { ExactSvmScheme: ExactSvmClientScheme } = require('@x402/svm/exact/client');
const {
  SOLANA_DEVNET_CAIP2,
  SOLANA_MAINNET_CAIP2,
  DEVNET_RPC_URL,
  MAINNET_RPC_URL,
} = require('@x402/svm');

const PROTOCOL_FALLBACK = '2025-06-18';
const SERVER_INFO = { name: 'zendiq-agent', version: '1.0.0' };

const BASE_URL = (process.env.ZENDIQ_AGENT_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
const ANALYSE_URL = `${BASE_URL}/v1/agent/analyse`;
const KEYPAIR_PATH = process.env.ZENDIQ_AGENT_KEYPAIR ?? null;
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
    + 'paid automatically via x402. The full risk breakdown behind the verdict — token risk '
    + 'factors, sandwich exposure detail, and route economics — is available on the HTTP '
    + 'endpoint POST /v1/agent/analyse.',
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

/** @type {{httpClient: object}|null} Lazily built so a missing key fails per-call, not at boot. */
let paymentClient = null;

function parseKeypairBytes(contents) {
  const parsed = JSON.parse(contents);
  const values = Array.isArray(parsed) ? parsed : parsed?.seed;
  if (!Array.isArray(values)) throw new Error('expected a byte array or an object with a seed byte array');
  const bytes = Uint8Array.from(values);
  if (bytes.length !== 64 && bytes.length !== 32) {
    throw new Error(`keypair is ${bytes.length} bytes; expected a 64-byte Solana keypair or 32-byte seed`);
  }
  return bytes;
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
 * Build the x402 payment client from the configured keypair.
 *
 * Accepts the 64-byte Solana CLI keypair format and a bare 32-byte seed. Only the
 * first 32 bytes are used — the trailing 32 in the CLI format are the public key,
 * which is derived rather than trusted.
 *
 * @returns {Promise<{httpClient: object}>} Payment client.
 */
async function getPaymentClient() {
  if (paymentClient) return paymentClient;
  if (!KEYPAIR_PATH) {
    throw new Error('ZENDIQ_AGENT_KEYPAIR is not set. Point it at a Solana keypair JSON file holding USDC.');
  }

  let bytes;
  try {
    bytes = parseKeypairBytes(fs.readFileSync(KEYPAIR_PATH, 'utf8'));
  } catch (err) {
    throw new Error(`Could not read the keypair at ${KEYPAIR_PATH}: ${err.message}`);
  }

  const signer = await createKeyPairSignerFromPrivateKeyBytes(bytes.slice(0, 32));
  const caip2 = NETWORK === 'mainnet' ? SOLANA_MAINNET_CAIP2 : SOLANA_DEVNET_CAIP2;
  const rpcUrl = NETWORK === 'mainnet' ? MAINNET_RPC_URL : DEVNET_RPC_URL;

  const client = new x402Client();
  client.register(caip2, new ExactSvmClientScheme(signer.signer ?? signer, { rpcUrl }));

  log(`paying as ${signer.address} on ${NETWORK}`);
  paymentClient = { httpClient: new x402HTTPClient(client) };
  return paymentClient;
}

/**
 * Call the analyse endpoint, paying the 402 challenge if one is issued.
 *
 * @param {object} body - Validated request body.
 * @returns {Promise<object>} Parsed response body.
 */
async function callAnalyse(body) {
  const startedAt = Date.now();
  await emitDemoEvent('call_started', { inputMint: body.inputMint, outputMint: body.outputMint });
  const post = (headers = {}) => fetch(ANALYSE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-ZendIQ-Surface': 'mcp', ...headers },
    body: JSON.stringify(body),
  });

  const first = await post();
  if (first.status !== 402) {
    const parsed = await first.json().catch(() => null);
    if (!first.ok) {
      throw new Error(parsed?.message ?? `Request failed with status ${first.status}.`);
    }
    return parsed;
  }

  const { httpClient } = await getPaymentClient();
  const challenge = httpClient.getPaymentRequiredResponse((n) => first.headers.get(n));
  const accepted = challenge?.accepts?.[0];
  const atomic = Number(accepted?.amount ?? accepted?.maxAmountRequired);
  await emitDemoEvent('payment_required', {
    priceUsd: Number.isFinite(atomic) ? atomic / 1_000_000 : null,
    network: NETWORK,
  });
  const payload = await httpClient.createPaymentPayload(challenge);
  await emitDemoEvent('payment_signed', { network: NETWORK });
  const paid = await post(httpClient.encodePaymentSignatureHeader(payload));

  const parsed = await paid.json().catch(() => null);
  if (paid.status === 402) {
    throw new Error(parsed?.message ?? 'Payment was rejected. Check the paying wallet holds USDC on this network.');
  }
  if (!paid.ok) {
    await emitDemoEvent('call_failed', { status: paid.status });
    throw new Error(parsed?.message ?? `Request failed with status ${paid.status}.`);
  }
  let settleTx = null;
  try {
    const raw = paid.headers.get('PAYMENT-RESPONSE');
    if (raw) settleTx = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'))?.transaction ?? null;
  } catch (_) { /* header shape is the facilitator's, not ours */ }
  await emitDemoEvent('payment_settled', { priceUsd: Number.isFinite(atomic) ? atomic / 1_000_000 : null, tx: settleTx });
  await emitDemoEvent('analysis_completed', {
    verdict: parsed.verdict,
    score: parsed.tokenRisk?.score ?? null,
    level: parsed.tokenRisk?.level ?? null,
    evidenceFingerprint: parsed.evidence_fingerprint ?? null,
    signalsResolved: parsed.signals_resolved ?? null,
    snapshot: parsed.snapshot ?? null,
    latencyMs: Date.now() - startedAt,
  });
  return parsed;
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
      return { tools: [TOOL] };

    case 'tools/call': {
      if (msg.params?.name !== TOOL.name) {
        throw Object.assign(new Error(`Unknown tool: ${msg.params?.name}`), { code: -32602 });
      }
      try {
        const result = project(await callAnalyse(buildRequest(msg.params?.arguments)));
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        };
      } catch (err) {
        // Tool failures are reported in-band so the model can react, rather than as a
        // protocol error the framework swallows.
        log('tool call failed —', err.message);
        return { content: [{ type: 'text', text: `ZendIQ triage failed: ${err.message}` }], isError: true };
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

module.exports = { project, buildRequest, handle, start, emitDemoEvent, parseKeypairBytes };
