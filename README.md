# ZendIQ Agent API

ZendIQ gives agents a paid, machine-readable Solana swap triage verdict before they sign. The public surface includes the MCP client, x402 client, budget controls, response contract, and a runnable example.

## What's open, and what isn't

This repository contains the complete agent-facing integration surface:

- MCP server for `zendiq_triage_swap`
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
- A running ZendIQ Agent API endpoint — set `ZENDIQ_AGENT_URL` to the hosted URL (`https://zendiq-backend.onrender.com`) or your own instance

## Quickstart

```powershell
npm ci
Copy-Item .env.example .env
$env:ZENDIQ_AGENT_KEYPAIR = 'C:\path\to\devnet-keypair.json'
$env:ZENDIQ_AGENT_URL = 'https://zendiq-backend.onrender.com'
npm run mcp
```

The MCP server uses newline-delimited JSON-RPC over stdio. Diagnostics go to stderr so stdout remains a valid MCP transport.

Run the example paid call after setting the same keypair and endpoint:

```powershell
$env:ZENDIQ_API_URL = $env:ZENDIQ_AGENT_URL
npm run budget:init
npm run analyse
```

The example defaults to devnet, generates its own throwaway key on first run, and uses a `$1.00` local budget. Fund the printed address with devnet USDC before making the paid call. Nothing defaults to ZendIQ production infrastructure.

## Connect it to an agent (MCP)

The server speaks the Model Context Protocol over stdio (newline-delimited JSON-RPC), so any MCP-capable client — Claude Desktop, Cursor, Cline, or your own harness — can call it directly. It exposes two tools, split by workflow stage:

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
| `ZENDIQ_AGENT_URL` | `https://zendiq-backend.onrender.com` | API base URL |
| `ZENDIQ_AGENT_KEYPAIR` | — | Solana keypair JSON that holds USDC; signs x402 payments only |
| `ZENDIQ_AGENT_NETWORK` | `devnet` | Payment rail: `devnet` or `mainnet` |

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

`/analyse` is advisory. `/optimize` goes one step further: it returns an **unsigned** swap transaction built through Jupiter Ultra, with the priority-fee and MEV posture chosen from the same risk model — plus the plan, an on-chain simulation, and the net-benefit arithmetic. You verify the bytes against the stated plan, then sign and submit with your own wallet. ZendIQ never holds a key.

```powershell
npm run budget:init
# Stop at simulation — pays $0.02 USDC, prints the plan + simulation, signs nothing:
npm run optimize -- --taker <YOUR_MAINNET_PUBKEY>

# Real landing — signs the returned tx and submits via Jupiter:
$env:ZENDIQ_TAKER_KEYPAIR = 'C:\path\to\mainnet-keypair.json'
npm run optimize -- --taker <YOUR_MAINNET_PUBKEY> --execute
```

The swap routes on **mainnet** (Jupiter Ultra has no devnet), so `--taker` must be a wallet that holds the input token; the x402 payment stays on devnet USDC. By default the example **stops at simulation and spends nothing on-chain** — pass `--execute` (with `ZENDIQ_TAKER_KEYPAIR`) to sign and land a real swap. The response carries the unsigned `transaction`, `requestId`, the `plan`, the `simulation` result, and the `netBenefit` breakdown — everything needed to confirm the transaction matches the stated intent before signing.

## Demo visualizer

A local spectator view that renders one real swap-triage call as a live, animated sequence across two transports side by side — the MCP agent tool and the direct x402 HTTP rail — then verifies that both returned the same evidence fingerprint. It then runs `/optimize` for the same swap and shows the execution sequence — **Optimize → Sign → Land** — ending at an on-chain simulation (or a real mainnet landing with `--execute`). Every value on screen is real: live risk score, real USDC settlement, real transaction. Nothing is staged.

### Prerequisites

- Node.js 22.5+ and `npm ci` already run.
- A reachable ZendIQ Agent API endpoint (set `ZENDIQ_AGENT_URL`; defaults to `http://127.0.0.1:3000`).
- A devnet keypair funded with **USDC** — see funding below. **No SOL is required.**

### Step 1 — create the demo wallet

The runner signs with a throwaway devnet key at `runtime/agent-devnet.key.json`. Generate it and print its public address (no servers needed for this step):

```powershell
node -e "const p=require('path');require('./examples/keys').loadAgentSigner({network:'devnet',file:p.join('runtime','agent-devnet.key.json')}).then(k=>console.log('Fund this address:',k.address))"
```

The key never leaves `runtime/` (gitignored). It signs USDC payment authorizations only.

### Step 2 — fund it with devnet USDC (no SOL needed)

The x402 facilitator sponsors the network fee, so the wallet only needs USDC, not SOL. Get devnet USDC from Circle's faucet — it also creates the token account for you:

1. Open <https://faucet.circle.com>
2. Select network **Solana Devnet**
3. Paste the address from Step 1 and request (10 USDC = ~1,000 calls at `$0.01` each)

### Step 3 — run it

Start the visualizer in one terminal:

```powershell
npm run demo
```

Open `http://127.0.0.1:4173`, then in a second terminal:

```powershell
npm run demo:run -- --mint DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263 --taker <YOUR_MAINNET_PUBKEY>
```

To finish with a real on-chain landing, add `--execute` and set `ZENDIQ_TAKER_KEYPAIR` to the mainnet keypair for `--taker`. Without `--execute`, the execution lane stops at simulation and spends nothing on-chain.

Both lanes fill in — request → `402` → USDC authorization signed → payment settled → analysis returned — and the footer shows **Verified · identical evidence** with the shared fingerprint. The runner exits `0` on a fingerprint match, non-zero on mismatch. The event stream deliberately excludes payment authorizations, secrets, RPC URLs, and complete wallet addresses.

### Troubleshooting

- **`Preflight failed` / `fetch failed`** — the runner needs both the Agent API and the visualizer (`npm run demo`) up at the same time. Start the visualizer first and leave it running.
- **`Payment was rejected`** — the wallet holds no devnet USDC (fund it, Step 2), or, if you run your own endpoint, the endpoint's `payTo` address has no USDC token account. The x402 settlement is an SPL transfer, so the destination must already have an account for that mint; the facilitator does not create it. Point `payTo` at an address that already holds that USDC, or create its token account once.
- **UI stays on "Waiting for an agent call…"** — the page is passive; it only fills once `demo:run` emits events. Confirm the runner printed `Demo complete`.

## Contract

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

Same request body as `/analyse` plus a `taker` public key. Returns an **unsigned** Jupiter Ultra swap `transaction` and `requestId`, the `plan` (venue, slippage, priority-fee posture), a `simulation` result, and the `netBenefit` breakdown. Zero custody — you verify, sign, and submit. Priced per call in USDC.

## Security

Never commit keypairs, seeds, `.env`, budget ledgers, or RPC URLs containing credentials. This repository configures a mandatory pre-push secret scan through `.githooks/pre-push`; install either [gitleaks](https://github.com/gitleaks/gitleaks) or [trufflehog](https://github.com/trufflesecurity/trufflehog) before pushing.
