'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const PORT = Number(process.env.ZENDIQ_DEMO_PORT ?? 4173);
const EVENT_TYPES = new Set([
  'call_started', 'payment_required', 'payment_signed', 'payment_settled',
  'analysis_completed', 'call_failed', 'comparison_completed', 'reset',
  'optimize_started', 'order_ready', 'signing', 'executing', 'executed', 'execution_skipped',
]);
const clients = new Set();
let events = [];

function send(res, status, body, contentType = 'application/json') {
  res.writeHead(status, { 'content-type': contentType, 'cache-control': 'no-store' });
  res.end(contentType === 'application/json' ? JSON.stringify(body) : body);
}

function publish(event) {
  const safe = {
    type: event.type,
    transport: event.transport === 'mcp' ? 'mcp' : event.transport === 'http' ? 'http' : 'system',
    at: new Date().toISOString(),
    data: event.data && typeof event.data === 'object' ? event.data : {},
  };
  events.push(safe);
  if (events.length > 100) events = events.slice(-100);
  const encoded = `data: ${JSON.stringify(safe)}\n\n`;
  for (const client of clients) client.write(encoded);
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/events') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    clients.add(res);
    for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`);
    req.on('close', () => clients.delete(res));
    return;
  }

  if (req.method === 'POST' && (req.url === '/api/events' || req.url === '/api/reset')) {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; if (raw.length > 16_384) req.destroy(); });
    req.on('end', () => {
      if (req.url === '/api/reset') {
        events = [];
        publish({ type: 'reset', transport: 'system', data: {} });
        return send(res, 204, '');
      }
      let event;
      try { event = JSON.parse(raw); } catch (_) { return send(res, 400, { error: 'invalid_json' }); }
      if (!EVENT_TYPES.has(event?.type)) return send(res, 400, { error: 'invalid_event_type' });
      publish(event);
      return send(res, 202, { accepted: true });
    });
    return;
  }

  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    return send(res, 200, fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8'), 'text/html; charset=utf-8');
  }

  send(res, 404, { error: 'not_found' });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`ZendIQ demo visualizer: http://127.0.0.1:${PORT}`);
});