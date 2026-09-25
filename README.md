# ZendIQ Agent API

ZendIQ gives agents a paid, machine-readable Solana swap triage verdict before they sign. The public surface includes the MCP client, x402 client, budget controls, response contract, and a runnable example.

## What's open, and what isn't

This repository contains the complete agent-facing integration surface:

- MCP server exposing `zendiq_screen_token`, `zendiq_triage_swap` and `zendiq_optimize_swap`
- x402 payment client
- Execution client — build, verify, and submit an optimized unsigned swap (`/optimize`)
- Autonomous candidate feed and triage loop
- Decision ledger with a hard local spend ceiling
- Public request and response contract
- Devnet-first configuration

The scoring model is intentionally not included. Each response surfaces the individual signals, their observed values, their status, and each factor's point contribution to the score — so an agent can act on any single signal (for example, refuse on a serial-deployer flag) rather than only the headline verdict. But **how** those signals are derived and combined — the data sources, thresholds, and weighting model — runs behind the hosted `/analyse` endpoint and remains ZendIQ's proprietary engine. The contract is open so integrators can inspect exactly what is sent, returned, paid for, and acted on.

This repository contains no extension analytics, user telemetry, production deployment configuration, database schema, facilitator wallet, or production credentials. It has fresh history independent of ZendIQ's private backend.

## Requirements

- Node.js 22.5 or newer
- A Solana keypair holding devnet USDC for paid calls
- Network access to ZendIQ's hosted API at `https://zendiq-backend.onrender.com`, where scoring runs — see [Where your calls go](#where-your-calls-go) before running anything.

## Quickstart

Everything below runs on your machine. The only calls to ZendIQ are the scoring and `/optimize` requests to the hosted API; no URL needs setting for those.

**1. Install, set a local spend ceiling, and create the agent's devnet key.** `budget:init` writes a `$1.00` ledger and creates `runtime/`; the second command writes a throwaway key there and prints its address. Neither makes a network call or spends anything.

```powershell
npm ci
npm run budget:init
node -e "require('./examples/keys').loadAgentSigner({network:'devnet'}).then(k=>console.log('Fund this address:',k.address))"
```

**2. Fund that address with devnet USDC** at <https://faucet.circle.com> (network **Solana Devnet**). No SOL is needed — the x402 facilitator pays the network fee. 10 USDC covers ~1,000 calls at `$0.01`.

**3. Make one paid call:**

```powershell
npm run analyse
```

**4. Run the MCP server with the same key:**

```powershell
$env:ZENDIQ_AGENT_KEYPAIR = "$PWD\runtime\agent-devnet.key.json"
npm run mcp
```

The MCP server uses newline-delimited JSON-RPC over stdio. Diagnostics go to stderr so stdout remains a valid MCP transport.

Set variables in your shell. Nothing in this repository loads a `.env` file; `.env.example` only lists the variables for reference.

The first call after the hosted API has been idle can take 30 seconds or more while it wakes; later calls are fast. A slow first call is not a failure.

## Where your calls go

**Runs on your machine:** the MCP server (a local stdio adapter), x402 payment signing, the budget ledger, the candidate feed, the triage loop, transaction verification and signing, and the demo visualizer.

**Calls ZendIQ's hosted API:** token screening, `/analyse` and `/optimize`. The scoring engine is not in this repository and has no local mode — every score comes from the hosted API.

**Calls third parties directly:** DexScreener (candidate feed), Jupiter `/execute` and a Solana RPC (only when you pass `--execute`), and the x402 facilitator (payment settlement).

**The default endpoint is ZendIQ's live hosted API.** If you clone this repo and run it without setting a URL, your calls hit our production service and are billed as real x402 payments:

```js
const BASE_URL = process.env.ZENDIQ_API_URL ?? 'https://zendiq-backend.onrender.com';
```

That default is deliberate — it makes the quickstart work without infrastructure. It is not a sandbox. Two consequences worth understanding before you run a loop:

- **Payments are real settlements**, on whichever rail the network variable names — `ZENDIQ_AGENT_NETWORK` for the MCP server, `AGENT_NETWORK` for the examples and the demo runner. They are cheap and currently settle in devnet USDC, but they are on-chain transactions, not mocks.
- **`npm run watch` is an autonomous loop.** It pays per candidate until the local budget ceiling stops it. Set `budget:init` deliberately; it is the only thing bounding spend.

The endpoint can be overridden — `ZENDIQ_AGENT_URL` for the MCP server, `ZENDIQ_API_URL` for the examples and the demo runner — but it must point at a ZendIQ Agent API. These are two separate variables reading two separate code paths; setting one does not affect the other. The demo runner is the exception: it passes its `ZENDIQ_API_URL` to the MCP server it spawns, so there `ZENDIQ_AGENT_URL` is ignored.

**Payment rail:** `ZENDIQ_AGENT_NETWORK` (MCP) and `AGENT_NETWORK` (examples) both default to `devnet`, and the hosted API settles in **devnet USDC** today. A wallet funded only on mainnet cannot pay for a call, even though the market data being analysed is mainnet. Fund a devnet wallet first.

No ZendIQ credentials ship in this repository. `ZENDIQ_AGENT_KEYPAIR` is your key, signs your payments, and never leaves your machine.

## Connect it to an agent (MCP)

The server speaks the Model Context Protocol over stdio (newline-delimited JSON-RPC), so any MCP-capable client — Claude Desktop, Cursor, Cline, or your own harness — can call it directly. It exposes three tools, one per workflow stage. They are independent entry points, not a required sequence: call whichever matches the question you actually have.

**`zendiq_screen_token`** — **screen** stage. Screen a token by mint alone, *before* you have a trade size (an agent scanning many fresh mints has none). **Free and rate-limited**, cacheable across callers. Returns the token risk score, its signal breakdown, `signals_resolved` coverage, and a `cache` block (`hit`, `ageSeconds`, `observedAt`) so you can decide whether to force fresh.

| Input | Type | Required | Description |
|---|---|---|---|
| `mint` | string | yes | Base58 mint of the token to screen |

**`zendiq_triage_swap`** — **decide** stage. Decide how to execute a specific swap before signing. Paid. Returns the **full token score inline** (so screening first is optional, never required), plus sandwich exposure and the recommended execution.

| Input | Type | Required | Description |
|---|---|---|---|
| `inputMint` | string | yes | Base58 mint being sold |
| `outputMint` | string | yes | Base58 mint being bought |
| `amount` | string | yes | Amount to sell, in the input mint's atomic units (e.g. `"1000000000"` for 1 SOL) |
| `slippageBps` | integer | no | Slippage tolerance in basis points; omit for the route default |

Output (`structuredContent`):

- `verdict` — `Safe` (route normally), `Protect` (route through a Jito bundle), or `Refuse` (do not execute)
- `recommendedExecution` — `{ path, priorityFeeLamports, jitoTipLamports }`
- `reasons` — plain-language justification

The full risk breakdown (token-risk factors, sandwich exposure, provenance fingerprint) is returned unchanged alongside these committed fields, so the MCP result is byte-identical to the HTTP `/analyse` response. Each call costs `$0.01` in USDC, paid automatically via x402 using the configured keypair.

**`zendiq_optimize_swap`** — **execute** stage. Build an executable swap once the decision to trade is already made. Paid. Returns an unsigned Jupiter transaction plus the `plan` and itemised `netBenefit` arithmetic behind it, so the bytes can be checked against the stated intent before signing. Zero custody — nothing is signed here.

| Input | Type | Required | Description |
|---|---|---|---|
| `inputMint` | string | yes | Base58 mint being sold |
| `outputMint` | string | yes | Base58 mint being bought |
| `amount` | string | yes | Amount to sell, in the input mint's atomic units |
| `taker` | string | yes | Base58 wallet the swap is built for; must hold the input token |
| `slippageBps` | integer | no | Slippage tolerance in basis points; omit for the route default |

This tool returns token risk and sandwich exposure, but **not** the `verdict` — it assumes the decision has been taken. Call `zendiq_triage_swap` if you still need the verdict. Each call costs `$0.02` in USDC; a build that fails charges nothing.

Note the network split: payment settles in **devnet** USDC, while the swap is routed against **mainnet** liquidity, so `taker` must be a mainnet wallet. Those are two different wallets today.

Register it in your MCP client's config (paths must be absolute):

```json
{
  "mcpServers": {
    "zendiq": {
      "command": "node",
      "args": ["/absolute/path/to/ZendIQ-Agent-API/src/mcp-server.js"],
      "env": {
        "ZENDIQ_AGENT_URL": "https://zendiq-backend.onrender.com",
        "ZENDIQ_AGENT_KEYPAIR": "/absolute/path/to/devnet-keypair.json",
        "ZENDIQ_AGENT_NETWORK": "devnet"
      }
    }
  }
}
```

| Env | Default | Purpose |
|---|---|---|
| `ZENDIQ_AGENT_URL` | `https://zendiq-backend.onrender.com` | API base URL. **The default is ZendIQ's live service** — see [Where your calls go](#where-your-calls-go) |
| `ZENDIQ_AGENT_KEYPAIR` | — | Solana keypair JSON that holds USDC; signs x402 payments only |
| `ZENDIQ_AGENT_NETWORK` | `devnet` | Payment rail: `devnet` or `mainnet`. The hosted API settles in devnet USDC today |

Diagnostics go to stderr so stdout stays a clean JSON-RPC transport. Transport is stdio only — the standard local MCP transport every client supports; a remote/HTTP transport is not currently provided.

To sanity-check the wiring without a client, drive it by hand — `initialize` then `tools/list` need no keypair or payment:

```powershell
'{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}',
'{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | npm run --silent mcp
```

## Autonomous agent

The complete test agent is public under `examples/`. It watches DexScreener's live Solana boost feed, enriches each candidate, pays ZendIQ for a verdict, and records whether it would refuse, protect, or route the trade normally.

```powershell
npm run budget:init
npm run feed
npm run watch
```

`watch` begins with USDC as a control, so a run proves that the agent discriminates rather than refusing everything. It then prints a run ledger containing triage spend, refused candidates, protected candidates, and candidates cleared for direct routing.

The autonomous agent is advisory — it reports the recommended path and fees without claiming that money moved. To build and submit a real optimized swap, see **Execution** below. Keys and budget ledgers live under the gitignored `runtime/` directory.

## Execution — build a signable swap (`/optimize`)

`/analyse` is advisory. `/optimize` goes one step further: it returns an **unsigned** swap transaction built through Jupiter, with the venue, priority fee and MEV posture chosen from the same risk model — plus the plan, an on-chain simulation, and the net-benefit arithmetic. You verify the bytes against the stated plan, then sign and submit with your own wallet. ZendIQ never holds a key.

```powershell
npm run budget:init
# Stop at simulation — pays $0.02 USDC, prints the plan + simulation, signs nothing:
npm run optimize -- --taker <YOUR_MAINNET_PUBKEY>

# Real landing — signs the returned tx and submits it as the response's submit block directs:
$env:ZENDIQ_TAKER_KEYPAIR = 'C:\path\to\mainnet-keypair.json'
npm run optimize -- --taker <YOUR_MAINNET_PUBKEY> --execute
```

The swap routes on **mainnet** (Jupiter has no devnet), so `--taker` must be a wallet that holds the input token; the x402 payment stays on devnet USDC. By default the example **stops at simulation and spends nothing on-chain** — pass `--execute` (with `ZENDIQ_TAKER_KEYPAIR`) to sign and land a real swap. On `jupiter_ultra` the example submits through Jupiter's `/execute`; on `jupiter_swap` it sends through `SOLANA_RPC_URL`, which defaults to the public mainnet RPC. The response carries the unsigned `transaction`, the `plan`, the `submit` instructions for the chosen venue, the `simulation` result, and the `netBenefit` breakdown — everything needed to confirm the transaction matches the stated intent before signing.

## Demo visualizer

A local spectator view that renders one real swap-triage call as a live, animated sequence across two transports side by side — the MCP agent tool and the direct x402 HTTP rail — then verifies that both returned the same token-risk evidence fingerprint. It then runs `/optimize` for the same swap and shows the execution sequence — **Optimize → Sign → Land** — ending at an on-chain simulation (or a real mainnet landing with `--execute`). Every value on screen is real: live risk score, real USDC settlement, real transaction. Nothing is staged.

### Prerequisites

- Node.js 22.5+ and `npm ci` already run.
- The funded devnet key from the [Quickstart](#quickstart), steps 1–2. The runner uses the same `runtime/agent-devnet.key.json`; it signs USDC payment authorizations only and never leaves `runtime/` (gitignored). **No SOL is required.**
- The visualizer and runner run locally; the calls they display go to the hosted API. The runner reads `ZENDIQ_API_URL` and hands the same URL to its MCP lane, so `ZENDIQ_AGENT_URL` has no effect here.

### Run it

Start the visualizer in one terminal:

```powershell
npm run demo
```

Open `http://127.0.0.1:4173`, then in a second terminal:

```powershell
npm run demo:run -- --mint DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263 --taker <YOUR_MAINNET_PUBKEY>
```

To finish with a real on-chain landing, add `--execute` and set `ZENDIQ_TAKER_KEYPAIR` to the mainnet keypair for `--taker`. Without `--execute`, the execution lane stops at simulation and spends nothing on-chain.

Both lanes fill in — request → `402` → USDC authorization signed → payment settled → analysis returned — and the footer shows **Verified · identical token-risk evidence** with the shared fingerprint. The fingerprint covers the deterministic token screening (mint, score, level, signals, inputs); the live route economics shown per lane (sandwich exposure, price impact) are re-fetched on each call and can drift a fraction of a percent with price movement between the two sequential requests. The runner exits `0` on a fingerprint match, non-zero on mismatch. The event stream deliberately excludes payment authorizations, secrets, RPC URLs, and complete wallet addresses.

### Troubleshooting

- **`Preflight failed` / `fetch failed`** — the runner needs both the Agent API and the visualizer (`npm run demo`) up at the same time. Start the visualizer first and leave it running.
- **`Payment was rejected`** — the wallet holds no devnet USDC. Fund it ([Quickstart](#quickstart), step 2) and re-run; a rejected payment is never charged.
- **UI stays on "Waiting for an agent call…"** — the page is passive; it only fills once `demo:run` emits events. Confirm the runner printed `Demo complete`.

## Contract

The complete machine-readable contract is [`openapi.json`](openapi.json) (OpenAPI 3.1): every endpoint, request body, response shape, error code, and worked examples. It is the same file served at <https://zendiq.ai/openapi.json>. For the live prices, rate limits and field-stability tiers, `GET /v1/agent` on the API is authoritative. The summary below covers what most integrations need.

`POST /v1/agent/analyse-token` — **free**, rate-limited (screen stage)

```json
{ "mint": "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263" }
```

Screen a token by mint, with no trade size. Returns the token risk score, its signal breakdown, `signals_resolved` coverage, and a `cache` block (`hit`, `ageSeconds`, `observedAt`) — a cached score reports the slot and time it was computed at, never the current one. No payment; rate-limited per IP.

`POST /v1/agent/analyse` — paid (decide stage)

```json
{
  "inputMint": "So11111111111111111111111111111111111111112",
  "outputMint": "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
  "amount": "500000000",
  "slippageBps": 100
}
```

Stable response fields:

- `verdict`: `Safe`, `Protect`, or `Refuse`
- `recommendedExecution.path`
- `recommendedExecution.priorityFeeLamports`
- `recommendedExecution.jitoTipLamports`
- `reasons`
- `disclaimer`

Additional fields are experimental and may change within `v1`. Stable fields are additive-only within `v1`; breaking changes ship under a new API version.

`POST /v1/agent/optimize`

Same request body as `/analyse` plus a `taker` public key. Returns an **unsigned** Jupiter swap `transaction`, the `plan` (venue, slippage, priority fee), a `simulation` result, and the `netBenefit` breakdown. Zero custody — you verify, sign, and submit. Priced per call in USDC.

The venue is chosen by risk, so read `plan.venue` rather than assuming one. **Jupiter Ultra** is used for low-risk trades and for sandwich-driven risk, where its upstream MEV protection is the instrument that addresses the exposure; it sizes the priority fee itself. The **Jupiter Swap API** (Quote + Build) is used when risk scoring calls for a specific priority fee, which Ultra cannot honour — there `plan.priorityFee` reports the fee actually applied, read back out of the build, and the route carries no upstream MEV protection.

**Submission differs by venue** — follow the returned `submit` object rather than hardcoding a path. On `jupiter_ultra`, sign `transaction` and POST `{ signedTransaction, requestId }` to `https://lite-api.jup.ag/ultra/v1/execute`; submitting through your own RPC instead forfeits Ultra's MEV protection and invalidates the `netBenefit` figures. On `jupiter_swap` there is no `requestId` (it is `null`) and no `/execute` step — sign and send to your own RPC, with the priority fee already inside the transaction.

`/optimize` does not return a verdict and does not refuse a trade: it builds a transaction even for a token that scores `CRITICAL`. Check `tokenRisk.level` before signing, or call `/analyse` first.

### When token screening does not complete

Screening can time out or fail upstream. Neither endpoint blocks on it — both still return `200` — but the gap is always explicit, never a clean-looking score:

- `tokenRisk` is `{ mint, available: false, error, assumedScore: 50, assumedLevel: "HIGH", note }`, with no `score` or `level`.
- Fees and overall risk are sized as if the token scored `HIGH`, not as if it scored 0.
- `/analyse` fails closed: `verdict` is `Protect` with `confidence: "low"`, `degraded` contains `token_screening:<reason>`, and `reasons` states that screening did not complete. A `Protect` reached this way means the token was **not checked**, not that it was found risky.
- `/optimize` still returns a transaction. The example prints `token risk UNAVAILABLE` and warns before signing, but does not refuse — check `tokenRisk.available` yourself if your agent should.

## Security

Never commit keypairs, seeds, `.env`, budget ledgers, or RPC URLs containing credentials. This repository configures a mandatory pre-push secret scan through `.githooks/pre-push`; install either [gitleaks](https://github.com/gitleaks/gitleaks) or [trufflehog](https://github.com/trufflesecurity/trufflehog) before pushing.
