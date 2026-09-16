# ZendIQ Agent API

ZendIQ gives agents a paid, machine-readable Solana swap triage verdict before they sign. The public surface includes the MCP client, x402 client, budget controls, response contract, and a runnable example.

## What's open, and what isn't

This repository contains the complete agent-facing integration surface:

- MCP server for `zendiq_triage_swap`
- x402 payment client
- Autonomous candidate feed and triage loop
- Decision ledger with a hard local spend ceiling
- Public request and response contract
- Devnet-first configuration

The scoring model is intentionally not included. Signal weights and the logic that combines them run behind the hosted `/analyse` endpoint. The contract is open so integrators can inspect exactly what is sent, returned, paid for, and acted on; the model remains ZendIQ's proprietary engine.

This repository contains no extension analytics, user telemetry, production deployment configuration, database schema, facilitator wallet, or production credentials. It has fresh history independent of ZendIQ's private backend.

## Requirements

- Node.js 22.5 or newer
- A Solana keypair holding devnet USDC for paid calls
- A running ZendIQ Agent API endpoint

## Quickstart

```powershell
npm ci
Copy-Item .env.example .env
$env:ZENDIQ_AGENT_KEYPAIR = 'C:\path\to\devnet-keypair.json'
$env:ZENDIQ_AGENT_URL = 'http://127.0.0.1:3000'
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

## Autonomous agent

The complete test agent is public under `examples/`. It watches DexScreener's live Solana boost feed, enriches each candidate, pays ZendIQ for a verdict, and records whether it would refuse, protect, or route the trade normally.

```powershell
npm run budget:init
npm run feed
npm run watch
```

`watch` begins with USDC as a control, so a run proves that the agent discriminates rather than refusing everything. It then prints a run ledger containing triage spend, refused candidates, protected candidates, and candidates cleared for direct routing.

Trade execution is intentionally not wired in this version. The agent reports the recommended path and fees it would use without claiming that money moved. Keys and budget ledgers live under the gitignored `runtime/` directory.

## Demo visualizer

A local spectator view that renders one real swap-triage call as a live, animated sequence across two transports side by side — the MCP agent tool and the direct x402 HTTP rail — then verifies that both returned the same evidence fingerprint. Every value on screen is real: live risk score, real `$0.01` USDC settlement, real response. Nothing is staged.

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
npm run demo:run -- --mint DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263
```

Both lanes fill in — request → `402` → USDC authorization signed → payment settled → analysis returned — and the footer shows **Verified · identical evidence** with the shared fingerprint. The runner exits `0` on a fingerprint match, non-zero on mismatch. The event stream deliberately excludes payment authorizations, secrets, RPC URLs, and complete wallet addresses.

### Troubleshooting

- **`Preflight failed` / `fetch failed`** — the runner needs both the Agent API and the visualizer (`npm run demo`) up at the same time. Start the visualizer first and leave it running.
- **`Payment was rejected`** — the wallet holds no devnet USDC (fund it, Step 2), or, if you run your own endpoint, the endpoint's `payTo` address has no USDC token account. The x402 settlement is an SPL transfer, so the destination must already have an account for that mint; the facilitator does not create it. Point `payTo` at an address that already holds that USDC, or create its token account once.
- **UI stays on "Waiting for an agent call…"** — the page is passive; it only fills once `demo:run` emits events. Confirm the runner printed `Demo complete`.

## Contract

`POST /v1/agent/analyse`

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

## Security

Never commit keypairs, seeds, `.env`, budget ledgers, or RPC URLs containing credentials. This repository configures a mandatory pre-push secret scan through `.githooks/pre-push`; install either [gitleaks](https://github.com/gitleaks/gitleaks) or [trufflehog](https://github.com/trufflesecurity/trufflehog) before pushing.
