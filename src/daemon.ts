// After Effect Supreme MCP daemon: one process serving MCP (HTTP), the After Effects bridge (WS /ae) and the dashboard (/ + WS /ui).
import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { Hub } from './hub';
import { buildServer } from './tools';

const PORT = Number(process.env.AE_MCP_PORT || 7654);
const HOST = '127.0.0.1';
const hub = new Hub(PORT);
const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const transports = new Map<string, StreamableHTTPServerTransport>();
const uiSockets = new Set<WebSocket>();

// ---- security: loopback only, reject foreign browser origins (DNS-rebinding / drive-by protection) ----
const hostOk = (req: IncomingMessage) => /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(req.headers.host || '');
function originOk(origin: string | undefined, allowFile: boolean) {
  if (!origin) return true; // non-browser clients (MCP clients, scripts)
  if (allowFile && (origin === 'null' || origin.startsWith('file://'))) return true;
  return origin === `http://127.0.0.1:${PORT}` || origin === `http://localhost:${PORT}`;
}

const json = (res: ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};
const readBody = (req: IncomingMessage) => new Promise<any>((resolve, reject) => {
  let data = ''; req.on('data', (c) => { data += c; if (data.length > 20_000_000) req.destroy(); });
  req.on('end', () => { if (!data) return resolve(undefined); try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
  req.on('error', reject);
});

async function handleMcp(req: IncomingMessage, res: ServerResponse) {
  const sid = req.headers['mcp-session-id'] as string | undefined;
  if (req.method === 'POST') {
    const body = await readBody(req);
    let transport = sid ? transports.get(sid) : undefined;
    if (!transport && !sid && isInitializeRequest(body)) {
      const info = body?.params?.clientInfo ?? {};
      const t: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => { transports.set(id, t); hub.clientConnected(id, info, req.socket.remoteAddress); },
      });
      t.onclose = () => { if (t.sessionId) { transports.delete(t.sessionId); hub.clientDisconnected(t.sessionId); } };
      await buildServer(hub).connect(t);
      return t.handleRequest(req, res, body);
    }
    if (!transport) return json(res, 400, { jsonrpc: '2.0', error: { code: -32000, message: 'Bad Request: missing or unknown Mcp-Session-Id' }, id: null });
    hub.touch(sid);
    return transport.handleRequest(req, res, body);
  }
  const transport = sid ? transports.get(sid) : undefined; // GET (SSE stream) / DELETE (end session)
  if (!transport) return json(res, 400, { error: 'Invalid or missing Mcp-Session-Id' });
  hub.touch(sid);
  return transport.handleRequest(req, res);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', 'http://x');
    if (!hostOk(req)) return json(res, 403, { error: 'Forbidden host' });
    if (!originOk(req.headers.origin, false)) return json(res, 403, { error: 'Forbidden origin' });

    if (url.pathname === '/mcp') return await handleMcp(req, res);
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(fs.readFileSync(path.join(publicDir, 'index.html')));
    }
    if (url.pathname === '/api/state') return json(res, 200, hub.snapshot());
    if (url.pathname === '/api/export') {
      res.writeHead(200, { 'content-type': 'application/json', 'content-disposition': 'attachment; filename="ae-mcp-log.json"' });
      return res.end(JSON.stringify(hub.entries, null, 2));
    }
    if (req.method === 'POST' && url.pathname === '/api/settings') { hub.setSettings((await readBody(req)) || {}); return json(res, 200, hub.settings); }
    if (req.method === 'POST' && url.pathname === '/api/shutdown') {  // used by the installer to stop the hidden daemon cleanly
      hub.log({ kind: 'system', level: 'warn', message: 'Shutdown requested' });
      json(res, 200, { ok: true });
      return void setTimeout(() => process.exit(0), 150);
    }
    if (req.method === 'POST' && url.pathname === '/api/clear') { hub.clearLogs(); return json(res, 200, { ok: true }); }
    if (req.method === 'POST' && url.pathname === '/api/ping-ae') {
      const t0 = Date.now();
      try {
        const r = await hub.bridge.call({ op: 'call', fn: 'ping' }, 10_000);
        hub.log({ kind: 'bridge', message: `Ping OK in ${Date.now() - t0}ms: ${r?.app ?? 'AE'} ${r?.version ?? ''}` });
        return json(res, 200, { ok: true, ms: Date.now() - t0, result: r });
      } catch (e: any) {
        hub.log({ kind: 'bridge', level: 'error', message: `Ping failed: ${e.message}` });
        return json(res, 200, { ok: false, error: e.message });
      }
    }
    json(res, 404, { error: 'Not found' });
  } catch (e: any) {
    if (!res.headersSent) json(res, 500, { error: e?.message ?? String(e) });
    else res.end();
  }
});

// ---- WebSockets ----
const wssAe = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
const wssUi = new WebSocketServer({ noServer: true });
const deny = (socket: Duplex, code: number) => { socket.write(`HTTP/1.1 ${code} Forbidden\r\nConnection: close\r\n\r\n`); socket.destroy(); };

server.on('upgrade', (req, socket, head) => {
  const pathname = new URL(req.url || '/', 'http://x').pathname;
  if (!hostOk(req)) return deny(socket, 403);
  if (pathname === '/ae') {
    if (!originOk(req.headers.origin, true)) return deny(socket, 403);
    wssAe.handleUpgrade(req, socket, head, (ws) => hub.bridge.attach(ws));
  } else if (pathname === '/ui') {
    if (!originOk(req.headers.origin, false)) return deny(socket, 403);
    wssUi.handleUpgrade(req, socket, head, (ws) => {
      uiSockets.add(ws);
      ws.on('close', () => uiSockets.delete(ws)); ws.on('error', () => {});
      ws.send(JSON.stringify({ type: 'snapshot', ...hub.snapshot() }));
    });
  } else deny(socket, 404);
});

hub.on('msg', (m) => {
  const s = JSON.stringify(m);
  for (const ws of uiSockets) if (ws.readyState === 1) ws.send(s);
});
setInterval(() => hub.sweep(), 60_000);

server.listen(PORT, HOST, () => {
  hub.log({ kind: 'system', message: `Daemon listening on http://${HOST}:${PORT}` });
  console.error(`\n  After Effect Supreme MCP daemon\n  Dashboard : http://${HOST}:${PORT}\n  MCP (HTTP): http://${HOST}:${PORT}/mcp\n  AE bridge : ws://${HOST}:${PORT}/ae\n`);
});
server.on('error', (e: any) => {
  console.error(e.code === 'EADDRINUSE' ? `Port ${PORT} is in use. Is the daemon already running? (set AE_MCP_PORT to change)` : e);
  process.exit(1);
});
