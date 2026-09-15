'use strict';

/**
 * x402 client for ZendIQ's agent API.
 *
 * Wraps the 402 -> sign -> re-present loop and ties every paid call to the budget
 * ledger. The mapping from HTTP outcome to ledger outcome is the whole point of this
 * file, and it is deliberately asymmetric:
 *
 *   settled  — a 200 we paid for, and *any* failure after the payload left the
 *              process. Once the authorization is in flight we cannot prove it did
 *              not settle, and a ceiling that under-counts is not a ceiling.
 *   released — outcomes the server guarantees did not settle: a 402 rejection, a
 *              429 (rate limits are checked ahead of the payment gate, so the
 *              authorization is not burned), a 409 replay refusal, and any local
 *              failure before the payload was sent.
 *
 * A replayed 200 is released, not settled: the server served it from cache and took
 * no second payment, so charging our own budget twice would be our error, not the
 * protocol's.
 */

const { x402Client, x402HTTPClient } = require('@x402/core/client');
const { ExactSvmScheme: ExactSvmClientScheme } = require('@x402/svm/exact/client');
const { SOLANA_DEVNET_CAIP2, SOLANA_MAINNET_CAIP2 } = require('@x402/svm');

const USDC_DECIMALS = 6;

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
   * @param {object} opts - `signer`, `budget`, `baseUrl`, `network`, `rpcUrl`.
   */
  constructor(opts) {
    this.baseUrl = (opts.baseUrl ?? 'http://127.0.0.1:3111').replace(/\/$/, '');
    this.budget = opts.budget;
    this.network = opts.network ?? 'devnet';
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
    try {
      response = await send(this.http.encodePaymentSignatureHeader(payload));
    } catch (err) {
      // In flight, outcome unknown. Charge ourselves rather than under-count.
      this.budget.settle(reservation, { note: `network_error: ${err.message.slice(0, 80)}` });
      throw err;
    }

    const body = await response.json().catch(() => ({}));
    const settlement = decodeHeader(response.headers.get('PAYMENT-RESPONSE'));
    const replayed = body?.replayed === true;
    if (response.ok) {
      await this.onEvent('payment_settled', { priceUsd: replayed ? 0 : priceUsd, replayed });
      await this.onEvent('analysis_completed', {
        verdict: body.verdict,
        score: body.tokenRisk?.score ?? null,
        level: body.tokenRisk?.level ?? null,
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
    } else if (settleError === 'transaction_failed') {
      // Ambiguous, not a refusal: this reason also covers a settlement that was submitted
      // and could not be confirmed. Measured on mainnet 7 Sep 2026 against a transfer that
      // landed. Charging ourselves matches the network_error case above — under-counting a
      // real payment is the worse error, because the ceiling stops protecting anything.
      this.budget.settle(reservation, { note: 'unconfirmed_settlement_may_have_landed' });
    } else if (response.status === 402 || response.status === 429 || response.status === 409) {
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
      settlementTx: settlement?.transaction || null,
    };
  }
}

module.exports = { ZendIQClient, decodeHeader };
