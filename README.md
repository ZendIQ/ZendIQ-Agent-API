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
$env:ZENDIQ_AGENT_URL = 'http://127.0.0.1:3111'
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

Start the local spectator view:

```powershell
npm run demo
```

Open `http://127.0.0.1:4173`, then use a second terminal:

```powershell
npm run demo:check
npm run demo:run -- --mint DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263
```

The runner sends the same live request through MCP and direct x402 HTTP. The page renders the real payment and analysis events, then verifies that both transports returned the same evidence fingerprint. The event stream deliberately excludes payment authorizations, secrets, RPC URLs, and complete wallet addresses.

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
