// OPS-382: the MCP server as `npx @zendiq/mcp`. The free screen works over stdio with no
// configuration, stdout carries only JSON-RPC, and keys never live in the npm cache.
//   node --test public/mcp.test.js   (examples/mcp.test.js in the published repo)
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { resolveStateDir, loadAgentSigner } = require('./keys');

// src/ beside examples/ in the published repo; backend/ in the monorepo.
const SERVER = [
  path.join(__dirname, '..', 'src', 'mcp-server.js'),
  path.join(__dirname, '..', '..', 'backend', 'src', 'agent', 'mcp-server.js'),
].find((p) => fs.existsSync(p));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'zq-mcp-'));

// A clean environment: only what Node needs to run, nothing ZendIQ-specific.
function cleanEnv(extra = {}) {
  const home = tmp();
  const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, ...extra };
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  return env;
}

/** Run the server with `lines` on stdin; resolves once stdin closes and it exits. */
function run(args, env, lines = []) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SERVER, ...args], { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    for (const line of lines) child.stdin.write(`${JSON.stringify(line)}\n`);
    child.stdin.end();
  });
}

test('a state folder inside node_modules or the npx cache is refused, explicit or from the environment', () => {
  for (const bad of [
    path.join(os.tmpdir(), 'proj', 'node_modules', '@zendiq', 'mcp', 'runtime'),
    path.join(os.homedir(), '.npm', '_npx', 'abc123', 'node_modules', '.zendiq'),
  ]) {
    assert.throws(() => resolveStateDir(bad), /inside an npm package or the npx cache/);
    const saved = process.env.AGENT_STATE_DIR;
    process.env.AGENT_STATE_DIR = bad;
    try {
      assert.throws(() => resolveStateDir(), /npx cache/);
    } finally {
      if (saved === undefined) delete process.env.AGENT_STATE_DIR; else process.env.AGENT_STATE_DIR = saved;
    }
  }
  const ok = tmp();
  assert.equal(resolveStateDir(ok), path.resolve(ok));
});

test('a generated key file is readable by its owner only', { skip: process.platform === 'win32' && 'POSIX modes' }, async () => {
  const stateDir = tmp();
  const { source } = await loadAgentSigner({ network: 'devnet', stateDir });
  assert.equal(fs.statSync(source.replace(/ \(generated\)$/, '')).mode & 0o777, 0o600);
});

test('with no configuration and no wallet, the free screen answers over stdio and stdout is only JSON-RPC', async () => {
  const screened = [];
  const stub = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      screened.push({ url: req.url, body: JSON.parse(body) });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ stage: 'screen', signals_resolved: '13/16', tokenRisk: { score: 0, level: 'LOW' } }));
    });
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${stub.address().port}`;
  try {
    const out = await run([], cleanEnv({ ZENDIQ_AGENT_URL: url }), [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'zendiq_screen_token', arguments: { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' } } },
    ]);
    const lines = out.stdout.trim().split('\n');
    const msgs = lines.map((l) => JSON.parse(l));
    assert.deepEqual(msgs.map((m) => m.id), [1, 2, 3], 'one reply per request, none for the notification');
    assert.ok(msgs.every((m) => m.jsonrpc === '2.0'));
    assert.equal(msgs[1].result.tools.length, 3);
    assert.equal(msgs[2].result.isError, undefined, msgs[2].result.content?.[0]?.text);
    assert.equal(msgs[2].result.structuredContent.signals_resolved, '13/16');
    assert.deepEqual(screened, [{ url: '/v1/agent/analyse-token', body: { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' } }]);
    assert.match(out.stderr, /ready .* state /, 'the resolved state folder is logged to stderr');
  } finally {
    stub.close();
  }
});

test('budget init writes the ledger into the state folder, prints only to stderr, and never overwrites', async () => {
  const stateDir = tmp();
  const env = cleanEnv({ AGENT_STATE_DIR: stateDir });
  const first = await run(['budget', 'init', '1.00'], env);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(first.stdout, '');
  const ledger = JSON.parse(fs.readFileSync(path.join(stateDir, 'budget-mainnet.json'), 'utf8'));
  assert.equal(ledger.network, 'mainnet');
  assert.equal(ledger.ceilingAtomic, 1_000_000);

  const again = await run(['budget', 'init', '5'], env);
  assert.equal(again.code, 1);
  assert.match(again.stderr, /refusing to overwrite/);
  assert.equal(again.stdout, '');

  const show = await run(['budget'], env);
  assert.equal(show.code, 0);
  assert.match(show.stderr, /\$0\.0000 spent \/ \$1\.00 cap/);
});

test('the server refuses to start when AGENT_STATE_DIR is inside an npm package', async () => {
  const bad = path.join(tmp(), 'node_modules', '@zendiq', 'mcp', 'runtime');
  const out = await run([], cleanEnv({ AGENT_STATE_DIR: bad }), [{ jsonrpc: '2.0', id: 1, method: 'tools/list' }]);
  assert.equal(out.code, 1);
  assert.equal(out.stdout, '', 'nothing is served');
  assert.match(out.stderr, /refusing to keep keys/);
});
