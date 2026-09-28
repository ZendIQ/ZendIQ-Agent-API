'use strict';

/**
 * x402 client for ZendIQ's agent API.
 *
 * Wraps the 402 -> sign -> re-present loop and ties every paid call to the budget
 * ledger. The mapping from HTTP outcome to ledger outcome is the whole point of this
 * file, and it is deliberately asymmetric:
 *
 *   settled  — a 200 we paid for, and any failure we cannot prove did not settle.
 *              Once the authorization is in flight and the server reports having
 *              attempted settlement, a ceiling that under-counts is not a ceiling.
 *   released — outcomes that demonstrably did not settle: a 402 rejection, a
 *              429 (rate limits are checked ahead of the payment gate, so the
 *              authorization is not burned), a 409 replay refusal, any local
 *              failure before the payload was sent, and any failure carrying no
 *              settlement header — the server cancels settlement whenever the
 *              handler errors, so no transfer was ever attempted.
 *
 * A replayed 200 is released, not settled: the server served it from cache and took
 * no second payment, so charging our own budget twice would be our error, not the
 * protocol's.
 */

const { x402Client, x402HTTPClient } = require('@x402/core/client');
const { ExactSvmScheme: ExactSvmClientScheme } = require('@x402/svm/exact/client');
const { SOLANA_DEVNET_CAIP2, SOLANA_MAINNET_CAIP2 } = require('@x402/svm');
const { getTransactionDecoder, getBase64EncodedWireTransaction, partiallySignTransaction } = require('@solana/kit');

const USDC_DECIMALS = 6;

/** ZendIQ's bundle submit endpoint (OPS-322); signed bundle transactions go nowhere else. */
const BUNDLE_SUBMIT_PATH = '/v1/agent/bundle';

/**
 * @param {string|null} value - Base64 header value.
 * @returns {object|null} Decoded JSON, or null.
 */
function decodeHeader(value) {
  if (!value) return null;
  try {
    return JSON.parse(Buffer.from(value, 'base64').toString('utf8'));
  } catch (_) {
    return null;
  }
}

/**
 * Retry a call that failed for a reason the caller cannot fix by trying differently.
 *
 * Only transport-level faults qualify: a 429 or 5xx says the endpoint is busy, whereas a
 * rejection says the request was wrong and will be wrong again.
 *
 * @param {Function} fn - Operation to attempt.
 * @param {number} attempts - Maximum attempts.
 * @returns {Promise<any>} Result of the first successful attempt.
 */
async function retryTransient(fn, attempts = 3) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      const status = err?.context?.statusCode;
      const transient = status === 429 || (status >= 500 && status < 600)
        || /fetch failed|ECONNRESET|ETIMEDOUT|socket hang up/i.test(err?.message ?? '');
      if (!transient || i >= attempts) throw err;
      console.error(`  rpc ${status ?? 'network'} — retry ${i}/${attempts - 1}`);
      await new Promise((r) => setTimeout(r, 500 * i));
    }
  }
}

class ZendIQClient {
  /**
   * @param {object} opts - `signer`, `budget`, `baseUrl`, `network`, `rpcUrl`, optional `headers`,
   *   `pendingRetryMs` (wait before the one retry after settlement_pending, default 5000).
   */
  constructor(opts) {
    this.baseUrl = (opts.baseUrl ?? 'https://zendiq-backend.onrender.com').replace(/\/$/, '');
    this.budget = opts.budget;
    this.network = opts.network ?? 'devnet';
    this.headers = { ...(opts.headers ?? {}) };
    this.pendingRetryMs = opts.pendingRetryMs ?? 5000;
    this.onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : () => {};
    this.caip2 = this.network === 'mainnet' ? SOLANA_MAINNET_CAIP2 : SOLANA_DEVNET_CAIP2;

    const client = new x402Client();
    // rpcUrl is correct on the *client* scheme; it is the server scheme where it
    // embeds a blockhash and kills the challenge after one slot (doc 16.8).
    client.register(this.caip2, new ExactSvmClientScheme(opts.signer, { rpcUrl: opts.rpcUrl }));
    this.http = new x402HTTPClient(client);
  }

  /**
   * Unpaid. The compatibility contract an agent reads before deciding to pay.
   *
   * @returns {Promise<object>} Manifest.
   */
  async manifest() {
    const r = await fetch(`${this.baseUrl}/v1/agent`);
    if (!r.ok) throw new Error(`manifest failed: ${r.status}`);
    return r.json();
  }

  /**
   * Pay for and fetch a swap triage verdict.
   *
   * @param {object} swap - inputMint, outputMint, amount, and optional fields.
   * @returns {Promise<{ok: boolean, status: number, verdict?: object, error?: string, paidUsd: number, replayed: boolean}>} Result.
   */
  async analyse(swap) {
    const startedAt = Date.now();
    await this.onEvent('call_started', { inputMint: swap.inputMint, outputMint: swap.outputMint });
    const url = `${this.baseUrl}/v1/agent/analyse`;
    const send = (headers = {}) => fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(swap),
    });

    const challenge = await send();
    if (challenge.status !== 402) {
      const body = await challenge.json().catch(() => ({}));
      return {
        ok: challenge.ok,
        status: challenge.status,
        verdict: challenge.ok ? body : undefined,
        error: challenge.ok ? undefined : (body.error ?? `unexpected ${challenge.status}`),
        paidUsd: 0,
        replayed: false,
      };
    }

    const required = this.http.getPaymentRequiredResponse((n) => challenge.headers.get(n));
    const accepts = required?.accepts?.[0];
    if (!accepts) throw new Error('402 carried no accepts entry');

    // x402Version 2 names this `amount`; v1 called it `maxAmountRequired`.
    const atomic = Number(accepts.amount ?? accepts.maxAmountRequired);
    if (!Number.isFinite(atomic) || atomic <= 0) {
      throw new Error(`402 carried no usable price. accepts keys: ${Object.keys(accepts).join(', ')}`);
    }
    const priceUsd = atomic / 10 ** USDC_DECIMALS;
    await this.onEvent('payment_required', { priceUsd, network: this.network });

    // Reserved before signing, so a payload that is signed but never sent is still
    // covered if the process dies between the two.
    const reservation = this.budget.reserve(priceUsd, { route: 'POST /v1/agent/analyse' });

    let payload;
    try {
      // Building the payload reads mint metadata over RPC, so it inherits the public
      // endpoint's rate limiting. Measured 7 Sep 2026: a 429 here killed the process
      // before a payment was even attempted. Nothing is signed until this succeeds.
      payload = await retryTransient(() => this.http.createPaymentPayload(required));
      await this.onEvent('payment_signed', { network: this.network });
    } catch (err) {
      this.budget.release(reservation, `sign_failed: ${err.message.slice(0, 80)}`);
      throw err;
    }

    let response;
    let pending = null;
    try {
      const header = this.http.encodePaymentSignatureHeader(payload);
      ({ response, pending } = await retryPendingOnce(await send(header), () => send(header), this.pendingRetryMs));
    } catch (err) {
      // In flight, outcome unknown. Charge ourselves rather than under-count.
      this.budget.settle(reservation, { note: `network_error: ${err.message.slice(0, 80)}` });
      throw err;
    }

    const body = await response.json().catch(() => ({}));
    const settlement = decodeHeader(response.headers.get('PAYMENT-RESPONSE'));
    const replayed = body?.replayed === true;
    if (response.ok) {
      await this.onEvent('payment_settled', { priceUsd: replayed ? 0 : priceUsd, replayed, tx: settlement?.transaction || null });
      await this.onEvent('analysis_completed', {
        verdict: body.verdict,
        score: body.overallRisk?.score ?? body.tokenRisk?.score ?? null,
        level: body.overallRisk?.level ?? body.tokenRisk?.level ?? null,
        overall: body.overallRisk ? { score: body.overallRisk.score ?? null, level: body.overallRisk.level ?? null, floored: !!body.overallRisk.floored } : null,
        execution: body.executionRisk ? { score: body.executionRisk.score ?? null, level: body.executionRisk.level ?? null, factors: (body.executionRisk.factors ?? []).map((f) => ({ name: f.name, sev: f.severity, points: f.points })) } : null,
        tokenRisk: (body.tokenRisk && body.tokenRisk.available !== false)
          ? { score: body.tokenRisk.score ?? null, level: body.tokenRisk.level ?? null, factors: (body.tokenRisk.factors ?? []).map((f) => ({ name: f.name, sev: f.severity, points: f.points, detail: f.detail })) }
          : null,
        sandwich: (body.sandwichExposure && body.sandwichExposure.available !== false)
          ? { score: body.sandwichExposure.score ?? null, level: body.sandwichExposure.level ?? null, factors: (body.sandwichExposure.factors ?? []).map((f) => ({ name: f.factor, points: f.score, detail: f.impact })) }
          : null,
        evidenceFingerprint: body.evidence_fingerprint ?? null,
        signalsResolved: body.signals_resolved ?? null,
        snapshot: body.snapshot ?? null,
        latencyMs: Date.now() - startedAt,
      });
    } else {
      await this.onEvent('call_failed', { status: response.status });
    }

    // A rejection reports itself in one of two headers depending on how far it got.
    // Verification failures come back as a fresh challenge; settlement failures come
    // back in PAYMENT-RESPONSE, which is already decoded above. Reading only the first
    // reduces every settlement failure to a bare `http 402` with the reason discarded.
    const rejection = response.ok ? null : decodeHeader(response.headers.get('PAYMENT-REQUIRED'));
    const settleError = !response.ok && settlement?.success === false
      ? settlement.errorReason ?? settlement.error
      : null;

    if (response.ok && replayed) {
      this.budget.release(reservation, 'served_from_cache_no_second_payment');
    } else if (response.ok) {
      this.budget.settle(reservation, { note: settlement?.transaction || 'settled' });
    } else if (pending) {
      // The retry's 409 says whether the first presentation was charged; only a definite no releases it.
      if (body?.charged === false) this.budget.release(reservation, 'pending_retry_not_charged');
      else this.budget.settle(reservation, { note: `unconfirmed_settlement_may_have_landed: ${pending.transaction || 'no signature'}` });
    } else if (settleError === 'transaction_failed' || settleError === 'settlement_pending') {
      // Ambiguous, not a refusal: this reason also covers a settlement that was submitted
      // and could not be confirmed. Measured on mainnet 7 Sep 2026 against a transfer that
      // landed, and on devnet 28 Sep as settlement_pending (OPS-350). Charging ourselves matches
      // the network_error case above — under-counting a real payment is the worse error,
      // because the ceiling stops protecting anything.
      this.budget.settle(reservation, { note: `unconfirmed_settlement_may_have_landed${settlement?.transaction ? `: ${settlement.transaction}` : ''}` });
    } else if (!settlement || settleError) {
      // No settlement header means settlement was cancelled before it was attempted —
      // the server does that whenever the handler errors. A settleError surviving the
      // branch above is an explicit "did not settle". Charging either burns a ceiling
      // that guards real spend: verified devnet 21 Sep 2026, seven 502s moved nothing.
      this.budget.release(reservation, `not_settled_${response.status}`);
    } else {
      this.budget.settle(reservation, { note: `unresolved_${response.status}` });
    }

    return {
      ok: response.ok,
      status: response.status,
      verdict: response.ok ? body : undefined,
      error: response.ok
        ? undefined
        : (rejection?.errorReason ?? rejection?.error ?? settleError
          ?? body.error ?? body.message ?? `http ${response.status}`),
      paidUsd: response.ok && !replayed ? priceUsd : 0,
      replayed,
      redeemed: settlement?.redeemed === true,
      settlementTx: settlement?.transaction || pending?.transaction || null,
    };
  }

  /**
   * Pay for and fetch an optimized UNSIGNED swap transaction plus its plan.
   *
   * Response-consuming only: the server does the risk-driven venue/fee decision and
   * returns the transaction, plan, simulation, and net-benefit. This client never
   * sees the scoring logic — it verifies and (optionally) signs the bytes.
   *
   * @param {object} swap - inputMint, outputMint, amount, slippageBps, taker.
   * @param {object} [opts] - { onEvent } per-call event sink (execution lane).
   * @returns {Promise<{ok: boolean, status: number, order?: object, error?: string, paidUsd: number, replayed: boolean}>} Result.
   */
  async optimise(swap, { onEvent = () => {} } = {}) {
    await onEvent('optimize_started', { inputMint: swap.inputMint, outputMint: swap.outputMint });
    const url = `${this.baseUrl}/v1/agent/optimize`;
    const send = (headers = {}) => fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.headers,
        ...headers,
      },
      body: JSON.stringify(swap),
    });

    const challenge = await send();
    if (challenge.status !== 402) {
      const body = await challenge.json().catch(() => ({}));
      return {
        ok: challenge.ok,
        status: challenge.status,
        order: challenge.ok ? body : undefined,
        error: challenge.ok ? undefined : (body.error ?? `unexpected ${challenge.status}`),
        paidUsd: 0,
        replayed: false,
      };
    }

    const required = this.http.getPaymentRequiredResponse((n) => challenge.headers.get(n));
    const accepts = required?.accepts?.[0];
    if (!accepts) throw new Error('402 carried no accepts entry');
    const atomic = Number(accepts.amount ?? accepts.maxAmountRequired);
    if (!Number.isFinite(atomic) || atomic <= 0) throw new Error('402 carried no usable price');
    const priceUsd = atomic / 10 ** USDC_DECIMALS;
    await onEvent('payment_required', { priceUsd, network: this.network });

    const reservation = this.budget.reserve(priceUsd, { route: 'POST /v1/agent/optimize' });

    let payload;
    try {
      payload = await retryTransient(() => this.http.createPaymentPayload(required));
      await onEvent('payment_signed', { network: this.network });
    } catch (err) {
      this.budget.release(reservation, `sign_failed: ${err.message.slice(0, 80)}`);
      throw err;
    }

    let response;
    let pending = null;
    try {
      const header = this.http.encodePaymentSignatureHeader(payload);
      ({ response, pending } = await retryPendingOnce(await send(header), () => send(header), this.pendingRetryMs));
    } catch (err) {
      this.budget.settle(reservation, { note: `network_error: ${err.message.slice(0, 80)}` });
      throw err;
    }

    const body = await response.json().catch(() => ({}));
    const settlement = decodeHeader(response.headers.get('PAYMENT-RESPONSE'));
    const replayed = body?.replayed === true;

    // A verification failure comes back as a fresh challenge in PAYMENT-REQUIRED; a
    // settlement failure reports in PAYMENT-RESPONSE. The body is empty on both, so
    // reading neither reduces every rejection to a bare `http 402`.
    const rejection = response.ok ? null : decodeHeader(response.headers.get('PAYMENT-REQUIRED'));
    const settleError = !response.ok && settlement?.success === false
      ? settlement.errorReason ?? settlement.error
      : null;

    if (response.ok && replayed) this.budget.release(reservation, 'served_from_cache_no_second_payment');
    else if (response.ok) this.budget.settle(reservation, { note: settlement?.transaction || 'settled' });
    // The retry's 409 says whether the first presentation was charged; only a definite no releases it.
    else if (pending) {
      if (body?.charged === false) this.budget.release(reservation, 'pending_retry_not_charged');
      else this.budget.settle(reservation, { note: `unconfirmed_settlement_may_have_landed: ${pending.transaction || 'no signature'}` });
    }
    // Ambiguous, not a refusal — also covers a settlement that landed but was not confirmed.
    // settlement_pending is the hosted facilitator's name for it; releasing it booked a landed charge as unspent (OPS-350).
    else if (settleError === 'transaction_failed' || settleError === 'settlement_pending') {
      this.budget.settle(reservation, { note: `unconfirmed_settlement_may_have_landed${settlement?.transaction ? `: ${settlement.transaction}` : ''}` });
    }
    // No settlement header means the server cancelled settlement before attempting it.
    else if (!settlement || settleError) this.budget.release(reservation, `not_settled_${response.status}`);
    else this.budget.settle(reservation, { note: `unresolved_${response.status}` });

    if (response.ok) {
      await onEvent('payment_settled', { priceUsd: replayed ? 0 : priceUsd, replayed, tx: settlement?.transaction || null });
      if (body.plan?.jito) {
        await onEvent('bundle_built', {
          venue: body.plan?.venueLabel ?? body.plan?.venue ?? null,
          choice: body.plan?.choice ?? null,
          tipLamports: body.plan.jito.tipLamports ?? null,
          tipSource: body.plan.jito.tipSource ?? null,
          priorityFeeLamports: body.plan?.priorityFee?.appliedLamports ?? null,
          bytes: body.plan.jito.bytes ?? null,
          headroomBytes: body.plan.jito.headroomBytes ?? null,
          lookupTableUsed: body.plan.jito.lookupTable?.used ?? null,
        });
      }
      await onEvent('order_ready', {
        venue: body.plan?.venueLabel ?? body.plan?.venue ?? null,
        choice: body.plan?.choice ?? null,
        forcedMethod: body.plan?.override?.method ?? null,
        slippageBps: body.plan?.slippageBps ?? null,
        simulation: body.simulation?.status ?? null,
        outAmount: body.plan?.route?.outAmount ?? null,
        priorityFee: body.plan?.priorityFee ?? null,
        submitMethod: body.submit?.method ?? null,
        hasTransaction: typeof body.transaction === 'string' && body.transaction.length > 100,
        bytes: typeof body.transaction === 'string' ? Buffer.from(body.transaction, 'base64').length : null,
        requestId: body.requestId ?? null,
      });
    }

    // `error` is the code and `message` the detail; reporting only the code turns an
    // actionable upstream failure into an opaque one-word string.
    const bodyError = body.error && body.message ? `${body.error}: ${body.message}` : (body.error ?? body.message);

    return {
      ok: response.ok,
      status: response.status,
      order: response.ok ? body : undefined,
      error: response.ok
        ? undefined
        : (rejection?.errorReason ?? rejection?.error ?? settleError
          ?? bodyError ?? `http ${response.status}`),
      paidUsd: response.ok && !replayed ? priceUsd : 0,
      replayed,
      redeemed: settlement?.redeemed === true,
      settlementTx: settlement?.transaction || pending?.transaction || null,
    };
  }
}

/**
 * Present the same payment once more after `settlement_pending` (OPS-350).
 *
 * The server may answer before it knows whether the payment landed. If it did, re-presenting the
 * same authorization redeems it once for a fresh response on the same route; the header is the
 * agent's only proof of payment, so it is kept for this retry and never re-signed.
 *
 * @param {Response} response - First paid response.
 * @param {() => Promise<Response>} resend - Sends the same payment header again.
 * @param {number} delayMs - Wait before the retry, giving the server time to see the transfer.
 * @returns {Promise<{response: Response, pending: object|null}>} Final response, and the pending settlement if retried.
 */
async function retryPendingOnce(response, resend, delayMs) {
  const s = response.status === 402 ? decodeHeader(response.headers.get('PAYMENT-RESPONSE')) : null;
  if (s?.success !== false || s.errorReason !== 'settlement_pending') return { response, pending: null };
  await new Promise((resolve) => setTimeout(resolve, delayMs));
  return { response: await resend(), pending: s };
}

/**
 * Sign an unsigned Jupiter order and submit it by the venue's own route.
 *
 * /optimize picks between two Jupiter venues, and they do not submit the same way:
 * Ultra is broadcast by Jupiter via /execute and needs the requestId, while a Swap API
 * transaction has no requestId and is sent to an RPC. The response says which, so this
 * follows `submit.method` rather than assuming one.
 *
 * Uses partiallySignTransaction because JupiterZ (RFQ) routes require a market-maker
 * co-signature that /execute adds — a fully-signed tx would be rejected on those routes.
 *
 * @param {object} params - { order, signer, executeUrl, rpcUrl }.
 * @returns {Promise<{ok: boolean, status: string, code?: number, signature: string|null, error: string|null}>} Result.
 */
/**
 * Poll until the signature is confirmed, failed, or the window closes.
 *
 * An unconfirmed result is reported as not-ok with the signature attached, so a dropped
 * transaction reads as unresolved rather than as a success.
 */
async function confirmSignature(rpcUrl, signature, { timeoutMs = 45_000, intervalMs = 1500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    let body;
    try {
      const res = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getSignatureStatuses',
          params: [[signature], { searchTransactionHistory: true }],
        }),
      });
      body = await res.json();
    } catch (err) {
      lastError = err.message;
      continue;
    }
    const status = body.result?.value?.[0];
    if (!status) continue;
    if (status.err) return { ok: false, status: 'Failed', error: JSON.stringify(status.err).slice(0, 200) };
    if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') {
      return { ok: true, status: 'Success', error: null };
    }
  }
  return { ok: false, status: 'Unconfirmed', error: lastError ?? `not confirmed within ${Math.round(timeoutMs / 1000)}s — check the signature on Solscan` };
}

async function signAndExecute({
  order,
  signer,
  executeUrl = 'https://lite-api.jup.ag/ultra/v1/execute',
  rpcUrl = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
  apiBaseUrl = 'https://zendiq-backend.onrender.com',
  onEvent = () => {},
  bundlePollMs = 60_000,
}) {
  const txBytes = Uint8Array.from(Buffer.from(order.transaction, 'base64'));
  const decoded = getTransactionDecoder().decode(txBytes);
  const signed = await partiallySignTransaction([signer.keyPair], decoded);
  const signedTransaction = getBase64EncodedWireTransaction(signed);
  await onEvent('signing', { wallet: signer.address ?? null });

  const method = order.submit?.method ?? (order.requestId ? 'jupiter_ultra_execute' : null);

  if (method === 'jito_bundle') {
    // Only this path on the API we called: a response must not be able to send signed bytes elsewhere.
    const path = String(order.submit?.path ?? '');
    if (path !== BUNDLE_SUBMIT_PATH) {
      return { ok: false, status: 'Refused', signature: null, error: `jito_bundle submit.path "${path}" is not the ZendIQ bundle endpoint` };
    }
    await onEvent('executing', { submitMethod: method });
    const res = await fetch(new URL(path, apiBaseUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ signedTransaction }),
    });
    let body = await res.json().catch(() => ({}));
    // pending/unknown is not a verdict: keep asking the endpoint until the chain answers.
    const deadline = Date.now() + bundlePollMs;
    let reported = null;
    while (res.ok && (body.state === 'pending' || body.state === 'unknown') && body.signature && Date.now() < deadline) {
      if (body.state !== reported) { reported = body.state; await onEvent('bundle_status', { state: body.state, bundleId: body.bundleId ?? null }); }
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const poll = await fetch(new URL(`${path}/${body.signature}`, apiBaseUrl)).catch(() => null);
      const next = poll?.ok ? await poll.json().catch(() => null) : null;
      if (next?.state) body = { ...body, ...next };
    }
    return {
      ok: res.ok && body.state === 'landed',
      status: body.state ?? body.error ?? `http_${res.status}`,
      signature: body.signature ?? null,
      bundleId: body.bundleId ?? null,
      slot: body.slot ?? null,
      error: res.ok ? (body.state === 'landed' ? null : body.note ?? null) : body.message ?? null,
    };
  }

  if (method === 'rpc_send_transaction') {
    await onEvent('executing', { submitMethod: method });
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'sendTransaction',
        params: [signedTransaction, { encoding: 'base64', skipPreflight: false, maxRetries: 3 }],
      }),
    });
    const body = await res.json().catch(() => ({}));
    const signature = body.result ?? null;
    if (signature == null) {
      // A JSON-RPC rejection rides inside a 200, so the HTTP status alone would label it 'rpc_200'.
      const status = body.error ? 'Rejected' : `rpc_${res.status}`;
      return { ok: false, status, code: body.error?.code, signature: null, error: body.error?.message ?? null };
    }
    // sendTransaction returns once the node accepts the bytes, which is not inclusion.
    const confirmed = await confirmSignature(rpcUrl, signature);
    return { ok: confirmed.ok, status: confirmed.status, signature, error: confirmed.error };
  }

  // Guessing a route for an unrecognised method could broadcast a transaction somewhere
  // its protections do not hold, so an unknown one is refused before anything is sent.
  if (method !== 'jupiter_ultra_execute') {
    return { ok: false, status: 'Refused', signature: null, error: `unsupported submit.method "${method}" — update the client` };
  }

  await onEvent('executing', { submitMethod: method });
  const res = await fetch(executeUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ signedTransaction, requestId: order.requestId }),
  });
  const body = await res.json().catch(() => ({}));
  return {
    ok: res.ok && body.status === 'Success',
    status: body.status ?? `http_${res.status}`,
    code: body.code,
    signature: body.signature ?? null,
    error: body.error ?? null,
  };
}

module.exports = { ZendIQClient, decodeHeader, signAndExecute };
