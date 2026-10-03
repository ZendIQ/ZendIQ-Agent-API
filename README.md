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
- Payment network read from the live API (`GET /v1/agent`), with a required spend ceiling on mainnet

The scoring model is intentionally not included. Each response surfaces the individual signals, their observed values, their status, and each factor's point contribution to the score — so an agent can act on any single signal (for example, refuse on a serial-deployer flag) rather than only the headline verdict. But **how** those signals are derived and combined — the data sources, thresholds, and weighting model — runs behind the hosted `/analyse` endpoint and remains ZendIQ's proprietary engine. The contract is open so integrators can inspect exactly what is sent, returned, paid for, and acted on.

This repository contains no extension analytics, user telemetry, production deployment configuration, database schema, facilitator wallet, or production credentials. It has fresh history independent of ZendIQ's private backend.

## Requirements

- Node.js 22.5 or newer
- A Solana keypair holding mainnet USDC for paid calls (it needs no SOL)
- Network access to ZendIQ's hosted API at `https://api.zendiq.ai`, where scoring runs — see [Where your calls go](#where-your-calls-go) before running anything.

## Quickstart

Everything below runs on your machine. The only calls to ZendIQ are the scoring and `/optimize` requests to the hosted API; no URL needs setting for those.

**1. Install and set a local spend ceiling.** `budget:init` reads the payment network from the API (`GET /v1/agent`, free) and writes a `$1.00` ledger for it under `runtime/`. It spends nothing. On mainnet every payment is reserved against this ceiling, and nothing here pays without one.

```powershell
npm ci
npm run budget:init
```

**2. Provide and fund the paying key.** This code never generates or writes a mainnet key. Put a Solana keypair you control at `runtime/payer-mainnet.key.json` (Solana CLI format, for example `solana-keygen new -o runtime/payer-mainnet.key.json`), or pass its 32-byte seed in `AGENT_SECRET_SEED`. Fund its address with a little USDC on Solana mainnet. No SOL is needed: the x402 facilitator pays the payment's network fee. $1 covers 100 calls at `$0.01`. Use a dedicated wallet, because the ledger only bounds what is paid through this code.

**3. Make one paid call** (`$0.01`):

```powershell
npm run analyse
```

**4. Run the MCP server with the same key and ledger:**

```powershell
npm run mcp
```

Or skip the clone entirely: `npx -y @zendiq/mcp` runs the same server from npm. See [Connect it to an agent](#connect-it-to-an-agent-mcp).

The MCP server uses newline-delimited JSON-RPC over stdio. Diagnostics go to stderr so stdout remains a valid MCP transport.

**5. Optional: try `/optimize` build-only.** `/optimize` builds a mainnet swap for a `taker`. The `taker` is only a public key and nothing is signed, so any funded mainnet address shows the full plan, simulation and venue decision. For the default 0.003 SOL swap, pick one holding a little more than 0.003 SOL:

```powershell
npm run optimize -- --taker <ANY_FUNDED_MAINNET_ADDRESS>
```

This is **build-only**: it pays $0.02 in USDC and signs nothing, and you cannot sign a transaction built for a wallet you do not control. A `taker` that cannot fund the trade gets `422 taker_insufficient_balance`, uncharged. To land a trade, see [Execution](#execution--build-a-signable-swap-optimize).

Set variables in your shell. Nothing in this repository loads a `.env` file; `.env.example` only lists the variables for reference.

The first scan of a token typically takes 1–5 s and at most about 12 s; a token scanned by anyone in the last 60 s comes back in under a second. Details: [How long a call takes](https://zendiq.ai/agents/#latency).

A paid call can also hold its response for up to 90 seconds while payment settlement is confirmed on chain, which happens when the facilitator cannot confirm the transfer itself. Allow at least 120 seconds on `/analyse` and `/optimize`. MCP hosts often time out a tool call sooner; raise that limit if your host allows it. Details: [Settlement can hold the response](https://zendiq.ai/agents/#settlement).

If that ends in `402` with `settlement_pending`, keep the payment header and retry once with the same header: a payment that landed late is redeemed for one fresh response on the same route, within 24 h. `zendiq-client.js` and the MCP server do this for you. Details: [Retry once after settlement_pending](https://zendiq.ai/agents/#redeem).

## Where your calls go

**Runs on your machine:** the MCP server (a local stdio adapter), x402 payment signing, the budget ledger, the candidate feed, the triage loop, transaction verification and signing, and the demo visualizer.

**Calls ZendIQ's hosted API:** token screening, `/analyse` and `/optimize`. The scoring engine is not in this repository and has no local mode — every score comes from the hosted API.

**Calls third parties directly:** DexScreener (candidate feed), Jupiter `/execute` and a Solana RPC (only when you pass `--execute`), and the x402 facilitator (payment settlement).

**The default endpoint is ZendIQ's live hosted API.** If you clone this repo and run it without setting a URL, your calls hit our production service and are billed as real x402 payments:

```js
const BASE_URL = process.env.ZENDIQ_API_URL ?? 'https://api.zendiq.ai';
```

That default is deliberate — it makes the quickstart work without infrastructure. It is not a sandbox. Two consequences worth understanding before you run a loop:

- **Payments are real settlements** in mainnet USDC: `$0.01` per `/analyse`, `$0.02` per `/optimize`. They are on-chain transactions, not mocks.
- **`npm run watch` is an autonomous loop.** It pays per candidate until the local budget ceiling stops it. Set `budget:init` deliberately; it is the only thing bounding spend.

The endpoint can be overridden — `ZENDIQ_AGENT_URL` for the MCP server, `ZENDIQ_API_URL` for the examples and the demo runner — but it must point at a ZendIQ Agent API. These are two separate variables reading two separate code paths; setting one does not affect the other. The demo runner is the exception: it passes its `ZENDIQ_API_URL` to the MCP server it spawns, so there `ZENDIQ_AGENT_URL` is ignored.

**Payment rail:** the examples, `budget:init` and the demo runner read the payment network from the API (`GET /v1/agent`, field `network`). `AGENT_NETWORK` is optional; if set, it must agree with the API or they refuse to run. `budget:init` is the exception: an explicit `AGENT_NETWORK` is taken as given there, so a ledger can be created before a server switches. The MCP server reads `ZENDIQ_AGENT_NETWORK`, which defaults to `mainnet`; any value other than `mainnet` or `devnet` makes its paid tools refuse. The hosted API settles in **mainnet USDC**, analyses mainnet, and `/optimize` returns a real mainnet transaction.

No ZendIQ credentials ship in this repository. The paying key is yours, signs your payments, and never leaves your machine.

## Connect it to an agent (MCP)

The server speaks the Model Context Protocol over stdio (newline-delimited JSON-RPC), so any MCP-capable client — Claude Desktop, Cursor, Cline, or your own harness — can call it directly. It exposes three tools, one per workflow stage. They are independent entry points, not a required sequence: call whichever matches the question you actually have.

**`zendiq_screen_token`** — **screen** stage. Call it first, whenever you are considering a token and have no trade yet (an agent scanning many fresh mints has none). **Free and rate-limited**, cacheable across callers. Returns the token risk score, its signal breakdown, `signals_resolved` coverage, and a `cache` block (`hit`, `ageSeconds`, `observedAt`) so you can decide whether to force fresh.

| Input | Type | Required | Description |
|---|---|---|---|
| `mint` | string | yes | Base58 mint of the token to screen |

**`zendiq_triage_swap`** — **decide** stage. Call it before signing a swap, to decide whether and how to trade it. Paid. Returns the **full token score inline** (so screening first is optional, never required), plus sandwich exposure, the route and the recommended execution. Builds no transaction.

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

**`zendiq_optimize_swap`** — **execute** stage. Call it once you have decided to trade and need the transaction. Paid. Returns an unsigned swap transaction (the Jupiter route, or a direct venue or Jito bundle that beats it after every cost by more than 0.1% of the trade, capped at $1), the `plan` to verify it against, `submit` instructions, a simulation, an itemised `netBenefit`, and the same verdict as `zendiq_triage_swap`. Zero custody — nothing is signed here.

| Input | Type | Required | Description |
|---|---|---|---|
| `inputMint` | string | yes | Base58 mint being sold |
| `outputMint` | string | yes | Base58 mint being bought |
| `amount` | string | yes | Amount to sell, in the input mint's atomic units |
| `taker` | string | yes | Base58 mainnet wallet the swap is built for; must hold the input amount and SOL for fees and rent (a gasless Jupiter Ultra fill is exempt from the SOL) |
| `slippageBps` | integer | no | Slippage tolerance in basis points; omit for the route default |
| `method` | `"jito"` | no | Force a Jito bundle venue even where risk scoring would not bundle. `plan.choice` is then `forced`; no unbundled route is substituted if none builds. Submit the signed bundle to `POST /v1/agent/bundle` |

This tool also returns the Safe / Protect / Refuse `verdict` and its `reasons`, the same as `zendiq_triage_swap`, but it builds the transaction even on a Refuse, because it assumes the decision to trade has been taken. Read `verdict` before signing. Each call costs `$0.02` in USDC; a build that fails charges nothing.

Payment settles in mainnet USDC from the paying wallet, and the swap is routed against mainnet liquidity for `taker`. The API accepts the paying wallet as `taker`; the examples here keep the two keys apart and refuse a taker key that is the payer.

Register it in your MCP client's config. The package runs straight from npm, with no clone:

```json
{
  "mcpServers": {
    "zendiq": {
      "command": "npx",
      "args": ["-y", "@zendiq/mcp"]
    }
  }
}
```

That is enough for `zendiq_screen_token`, which is free and needs no wallet. The paid tools need two more things, both kept in `~/.zendiq` (or `AGENT_STATE_DIR`):

1. A spend ceiling: `npx -y @zendiq/mcp budget init 1.00` writes `budget-mainnet.json`. It spends nothing. `npx -y @zendiq/mcp budget` shows what has been spent.
2. A paying key holding mainnet USDC: put a Solana keypair you control at `~/.zendiq/payer-mainnet.key.json`, or pass its 32-byte seed in `AGENT_SECRET_SEED`. It is never generated for you.

The server refuses to keep keys or the ledger inside `node_modules` or the npx cache, because npm deletes those folders without warning and a funded key there would be lost.

From a clone, point the client at the file instead (paths must be absolute):

```json
{
  "mcpServers": {
    "zendiq": {
      "command": "node",
      "args": ["/absolute/path/to/ZendIQ-Agent-API/src/mcp-server.js"]
    }
  }
}
```

There the key and ledger default to `runtime/` beside the clone, as for the examples.

| Env | Default | Purpose |
|---|---|---|
| `ZENDIQ_AGENT_URL` | `https://api.zendiq.ai` | API base URL. **The default is ZendIQ's live service** — see [Where your calls go](#where-your-calls-go) |
| `ZENDIQ_AGENT_NETWORK` | `mainnet` | Payment rail: `mainnet` or `devnet`; must match the network the API settles on. Any other value makes the paid tools refuse |
| `AGENT_STATE_DIR` | `~/.zendiq` (npm), `runtime/` (clone) | Where the paying key and the budget ledger live |
| `ZENDIQ_AGENT_BUDGET_FILE` | `<state dir>/budget-<network>.json` | Budget ledger every payment is reserved against. On mainnet a paid call refuses without it. See [What the budget ceiling guarantees](#what-the-budget-ceiling-guarantees) |
| `AGENT_SECRET_SEED` | — | Mainnet paying key as a 32-byte seed array, instead of `payer-mainnet.key.json` |
| `ZENDIQ_AGENT_KEYPAIR` | — | **Devnet only.** Solana keypair JSON that holds USDC; signs x402 payments only. Refused on mainnet |

On mainnet the paying key is only loaded together with a mainnet ledger.

Diagnostics go to stderr so stdout stays a clean JSON-RPC transport. Transport is stdio only — the standard local MCP transport every client supports; a remote/HTTP transport is not currently provided.

To sanity-check the wiring without a client, drive it by hand — `initialize` then `tools/list` need no keypair or payment:

```powershell
'{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}',
'{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | npx -y @zendiq/mcp
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

## What the budget ceiling guarantees

The ledger (`examples/budget.js`) is a hard ceiling on what the paying wallet spends on ZendIQ calls. It holds under these conditions, and only these:

- **What it counts.** Every x402 payment made through `ZendIQClient`: the examples, the demo runner, and the MCP server, which all share that one payment path. Each payment is reserved before it is signed and resolved afterwards. An outcome that might have been charged is counted as spent, so the ceiling over-counts rather than under-counts.
- **On mainnet the paying key is fenced.**
  - It is loaded only by `loadAgentSigner`, from its own file, `runtime/payer-mainnet.key.json`, and only with a mainnet ledger attached; without one it throws.
  - A ledger records the one key that pays against it, and a key is bound to one ledger.
  - The wallet a swap is built for (`--taker`, `ZENDIQ_TAKER_KEYPAIR`) is a separate key, and it is refused if it is the payer.
- **More than one process may share a ledger.** Every change takes a lockfile (`<ledger>.lock`, holding the owner's PID) and re-reads the file, so two processes cannot both reserve the same remaining budget.
- **A crashed process does not wedge the ledger.** If the lock holder is killed mid-operation, the next spender sees that its PID is gone and takes the lock over at once. If the holder is still alive, the spender waits up to 5 s and then **refuses to pay**. The error names the PID and the lockfile; it never hangs. A lock older than 30 s is taken over regardless. **Manual recovery:** stop every agent using that ledger, then delete `<ledger>.lock`.
- **What it cannot see:**
  - Anything signed with the paying key outside this code, for example a script that reads the key file itself.
  - The funding transfer into the paying wallet, and any later top-ups.
  - Network fees and token-account rent. The facilitator pays the payment's network fee, so in normal use the paying wallet spends USDC only.
  - Swaps, which the taker signs and pays for, from a different wallet.

**What "exact reconciliation" means.** Compare two lists for one paying address: every **USDC transfer out of that address** on chain, and every ledger entry in state `settled`, **matched by transaction signature** (the entry's `note`, which holds the settlement signature from the server's `PAYMENT-RESPONSE`). For a key used only through this code they match one to one. The single expected exception is a `settled` entry noted `unconfirmed_settlement_may_have_landed`, which may have no transfer, because the ledger counts a payment it cannot rule out. Inflows (funding, top-ups) are not ledger entries and are not part of the comparison. Any outflow with no matching entry means the key was used outside the ledger.

**Reconciling a fresh key**

1. Generate the key and fund it with USDC. Record the funding transaction's signature; it is the only expected inflow.
2. Create a **new** ledger for it (`AGENT_NETWORK=mainnet node examples/budget.js init <ceilingUsd>`). Never point a new key at a ledger that already has entries: its history belongs to another key and can never reconcile. `init` refuses to overwrite an existing file, so move an old one aside first.
3. Make paid calls only through this code. The first load binds the key to the ledger (`payer` in the ledger, `runtime/payer-bindings.json`).
4. List the paying address's USDC token-account history on chain. Drop the funding transfer and any top-ups. The remaining outflows' signatures must equal the `note` signatures of the ledger's `settled` entries, and their amounts must equal each entry's `atomic` (USDC, 6 decimals).

## Execution — build a signable swap (`/optimize`)

`/analyse` is advisory. `/optimize` goes one step further: it returns an **unsigned** swap transaction, with the venue, priority fee and MEV posture chosen from the same risk model and a net-benefit comparison across venues — plus the plan, an on-chain simulation, and the net-benefit arithmetic. You verify the bytes against the stated plan, then sign and submit with your own wallet. ZendIQ never holds a key.

```powershell
npm run budget:init
# Stop at simulation — pays $0.02 USDC, prints the plan + simulation, signs nothing:
npm run optimize -- --taker <YOUR_MAINNET_PUBKEY>

# Real landing — signs the returned tx and submits it as the response's submit block directs:
$env:ZENDIQ_TAKER_KEYPAIR = 'C:\path\to\mainnet-keypair.json'
npm run optimize -- --taker <YOUR_MAINNET_PUBKEY> --execute
```

The swap routes on **mainnet**, so `--taker` must be a wallet that holds the input amount and SOL for fees and rent; the x402 payment is a separate USDC transfer from the paying wallet. By default the example **stops at simulation and spends nothing on-chain** — pass `--execute` (with `ZENDIQ_TAKER_KEYPAIR`) to sign and land a real swap. On `jupiter_ultra` the example submits through Jupiter's `/execute`; on `jupiter_swap` it sends through `SOLANA_RPC_URL`, which defaults to the public mainnet RPC; on a Jito bundle venue it posts the signed transaction to ZendIQ's `/v1/agent/bundle` and polls until it lands. The response carries the unsigned `transaction`, the `plan`, the `submit` instructions for the chosen venue, the `simulation` result, and the `netBenefit` breakdown — everything needed to confirm the transaction matches the stated intent before signing.

The example also prints the verdict and the venue decision. The venue decision lists every candidate with its net value, priority fee, Jito tip, modelled sandwich cost and bundle landing risk, the margin it had to beat, and why the winner won. It is `plan.venueDecision` from the response, so an agent can check the choice rather than trust it. With `--execute` the example will not sign a trade whose `verdict` is `Refuse`, just as it will not sign one whose simulation failed; pass `--sign-refused` to override it.

## Demo visualizer

A local spectator view that renders one real swap-triage call as a live, animated sequence across two transports side by side — the MCP agent tool and the direct x402 HTTP rail — then verifies that both returned the same token-risk evidence fingerprint. It then runs `/optimize` for the same swap and shows the execution sequence — **Optimize → Sign → Land** — ending at an on-chain simulation (or a real mainnet landing with `--execute`). Every value on screen is real: live risk score, real USDC settlement, real transaction. Nothing is staged.

### Prerequisites

- Node.js 22.5+ and `npm ci` already run.
- The funded paying key and budget ledger from the [Quickstart](#quickstart), steps 1–2. The runner uses the same `runtime/payer-mainnet.key.json` and `runtime/budget-mainnet.json`; the key signs USDC payment authorizations only and never leaves your machine (`runtime/` is gitignored). **No SOL is required.** The runner never creates a mainnet ledger itself.
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
- **`Payment was rejected`** — the paying wallet holds too little mainnet USDC. Fund it ([Quickstart](#quickstart), step 2) and re-run; a rejected payment is never charged.
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

Same request body as `/analyse` plus a `taker` public key. Returns an **unsigned** swap `transaction`, the `plan` (venue, slippage, priority fee, and the `venueDecision` comparison behind the venue), a `simulation` result, the `netBenefit` breakdown, and the same `verdict`, `confidence` and `reasons` as `/analyse`. Zero custody — you verify, sign, and submit. Priced per call in USDC.

The venue is chosen by risk, so read `plan.venue` rather than assuming one. **Jupiter Ultra** is used for low-risk trades and for sandwich-driven risk, where its upstream MEV protection is the instrument that addresses the exposure; it sizes the priority fee itself. The **Jupiter Swap API** (Quote + Build) is used when risk scoring calls for a specific priority fee, which Ultra cannot honour — there `plan.priorityFee` reports the fee actually applied, read back out of the build, and the route carries no upstream MEV protection.

A direct venue is quoted alongside and replaces the Jupiter route only when it beats it after every cost: priority fee, Jito tip, expected sandwich loss, and for a bundle its landing risk (an assumed 5% chance of paying for a rebuild). It must win by a margin of 0.1% of the trade, capped at $1: enough that quote noise cannot flip the venue, small enough that a real saving still wins. Unprotected **Raydium** competes only on a Safe verdict. The Jito bundle venues (**Raydium + Jito**, **Jupiter Swap + Jito**) compete on every verdict; on Safe they step aside while ZendIQ's shared Jito submission budget is busy, so protected trades keep it. `plan.venueDecision` shows every candidate's arithmetic; often the answer is Jupiter.

**Submission differs by venue** — follow the returned `submit` object rather than hardcoding a path. On `jupiter_ultra`, sign `transaction` and POST `{ signedTransaction, requestId }` to `https://lite-api.jup.ag/ultra/v1/execute`; submitting through your own RPC instead forfeits Ultra's MEV protection and invalidates the `netBenefit` figures. On `jupiter_swap` and `raydium` there is no `requestId` (it is `null`) and no `/execute` step — sign and send to your own RPC, with the priority fee already inside the transaction. Send a `raydium` transaction promptly: Raydium embeds its own blockhash and `submit.lastValidBlockHeight` is `null`. On a Jito bundle venue (`submit.method: "jito_bundle"`), sign and POST `{ "signedTransaction": "<base64>" }` to `/v1/agent/bundle` on this API (free): ZendIQ forwards those exact bytes to Jito and reports landing. Never send a bundle transaction to an RPC yourself; it would sit in the public mempool and still pay the tip.

`netBenefit.netUsd = expectedMevLossUsd − zendiqFeeUsd − jitoTipUsd − jupiterPlatformFeeUsd − priorityFeeUsd`: the sandwich loss the route avoids, less every fee you pay to execute it. It is stated only on routes that claim MEV protection (Jupiter Ultra and the bundle venues). `jupiterPlatformFeeUsd` is Jupiter's own fee on an Ultra trade (0–50 bps by pair, 2 bps on SOL–USDC; already inside the quoted amounts) and `0` elsewhere. `priorityFeeUsd` is decoded from the transaction: what your taker pays, `0` on a bundle or a gasless fill. The 5,000-lamport base signature fee is the same on every route and is not included. When a cost cannot be priced, `netUsd` is `null` and `netUsdBasis` says why.

`/optimize` returns the same `verdict` (Safe / Protect / Refuse) as `/analyse` but does not refuse to build: a `Refuse` still comes back with a transaction, even for a token that scores `CRITICAL`. Read `verdict` and `tokenRisk` before signing, and do not sign a `Refuse` unless you mean to trade against it.

### When token screening does not complete

Screening can time out or fail upstream. Neither endpoint blocks on it — both still return `200` — but the gap is always explicit, never a clean-looking score:

- `tokenRisk` is `{ mint, available: false, error, assumedScore: 50, assumedLevel: "HIGH", note }`, with no `score` or `level`.
- Fees and overall risk are sized as if the token scored `HIGH`, not as if it scored 0.
- `/analyse` fails closed: `verdict` is `Protect` with `confidence: "low"`, `degraded` contains `token_screening:<reason>`, and `reasons` states that screening did not complete. A `Protect` reached this way means the token was **not checked**, not that it was found risky.
- `/optimize` still returns a transaction. The example prints `token risk UNAVAILABLE` and warns before signing, but does not refuse — check `tokenRisk.available` yourself if your agent should.

## Security

Never commit keypairs, seeds, `.env`, budget ledgers, or RPC URLs containing credentials. This repository configures a mandatory pre-push secret scan through `.githooks/pre-push`; install either [gitleaks](https://github.com/gitleaks/gitleaks) or [trufflehog](https://github.com/trufflesecurity/trufflehog) before pushing.
