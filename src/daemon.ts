// After Effect Supreme MCP daemon: one process serving MCP (HTTP), the After Effects bridge (WS /ae) and the dashboard (/ + WS /ui).
import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import os from 'node:os';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { Hub } from './hub';
import { buildServer } from './tools';
import { convertHtmlToLayers } from './html2ae';

const PORT = Number(process.env.AE_MCP_PORT || 7654);
const HOST = '127.0.0.1';
const hub = new Hub(PORT);
const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
// dashboard + panel show this version text
hub.version = (() => { try { return JSON.parse(fs.readFileSync(path.resolve(publicDir, '..', 'package.json'), 'utf8')).version ?? '0.0.0'; } catch { return '0.0.0'; } })();
const transports = new Map<string, StreamableHTTPServerTransport>();
const uiSockets = new Set<WebSocket>();

// ---- bridge auth: a token file only local processes (the CEP panel, mock-ae) can read ----
const TOKEN_FILE = path.join(os.homedir(), '.ae-supreme-mcp', 'daemon-token');
function ensureToken(): string {
  try {
    fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
    if (fs.existsSync(TOKEN_FILE)) {
      const t = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
      if (t) return t;
    }
    const t = randomUUID().replace(/-/g, '');
    fs.writeFileSync(TOKEN_FILE, t + '\n', { encoding: 'utf8', mode: 0o600 });
    return t;
  } catch {
    return ''; // if the file cannot be managed we fall back to open mode (old behavior)
  }
}
const DAEMON_TOKEN = ensureToken();
hub.bridge.expectedToken = DAEMON_TOKEN || null;

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
    if (req.method === 'POST' && url.pathname === '/api/html2ae') {
      // plan only: convert HTML to a layer plan and report what WOULD be built
      const b = (await readBody(req)) || {};
      try {
        const plan = convertHtmlToLayers(String(b.html || ''), b.options || {});
        const kf = plan.layers.reduce((n, l) => n + Object.values(l.keys || {}).reduce((a, k: any) => a + (k?.length || 0), 0), 0);
        hub.log({ kind: 'tool', tool: 'html2ae', client: 'dashboard', status: 'ok', message: `HTML plan: ${plan.layers.length} layers, ${kf} keyframes`, durationMs: 0 });
        return json(res, 200, { ok: true, layers: plan.layers.length, keyframes: kf, compName: plan.compName, width: plan.width, height: plan.height, duration: plan.duration, frameRate: plan.frameRate, bgColor: plan.bgColor, warnings: plan.warnings, layerNames: plan.layers.map((l) => `${l.kind}:${l.name}`) });
      } catch (e: any) { return json(res, 200, { ok: false, error: e?.message ?? String(e) }); }
    }
    if (req.method === 'POST' && url.pathname === '/api/html2ae-apply') {
      // build it for real: convert + send to After Effects through the bridge
      const b = (await readBody(req)) || {};
      try {
        if (hub.settings.readOnly) throw new Error('Read-only mode is ON in the dashboard settings.');
        if (!hub.bridge.connected) throw new Error('After Effects is not connected. Open Window > Extensions > "After Effect Supreme MCP" in AE.');
        const plan = convertHtmlToLayers(String(b.html || ''), b.options || {});
        const r = await hub.bridge.call({ op: 'call', fn: 'buildLayers', args: plan, undoName: 'MCP: html2ae' }, 120_000);
        hub.log({ kind: 'tool', tool: 'html2ae', client: 'dashboard', status: 'ok', message: `HTML \u2192 AE: ${plan.layers.length} layers into "${r?.comp ?? plan.compName}"`, durationMs: 0 });
        hub.requestViewport(true);
        return json(res, 200, { ok: true, ...(r || {}), plannedLayers: plan.layers.length, warnings: plan.warnings, comp: r?.comp ?? plan.compName });
      } catch (e: any) { return json(res, 200, { ok: false, error: e?.message ?? String(e) }); }
    }
    if (req.method === 'POST' && url.pathname === '/api/ae-time') {
      const b = (await readBody(req)) || {};
      try {
        const r = await hub.bridge.call({ op: 'call', fn: 'setTime', args: { comp: b.comp, time: b.time } }, 5000);
        hub.requestViewport(true);
        return json(res, 200, { ok: true, result: r });
      } catch (e: any) { return json(res, 200, { ok: false, error: e.message }); }
    }
    if (req.method === 'POST' && url.pathname === '/api/viewport') {
      try { await hub.requestViewport(true); } catch {}
      return json(res, 200, { ok: true, viewport: hub.lastViewport });
    }
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
      if (hub.lastViewport) ws.send(JSON.stringify({ type: 'viewport', viewport: hub.lastViewport }));
    });
  } else deny(socket, 404);
});

hub.on('msg', (m) => {
  const s = JSON.stringify(m);
  for (const ws of uiSockets) if (ws.readyState === 1) ws.send(s);
});
setInterval(() => {
  hub.sweep();
  // sweep MCP transports whose client vanished without DELETE (prevents map growth)
  for (const [id, t] of transports) {
    const c = hub.clients.get(id);
    if (c && c.connected) continue;
    if (c && Date.now() - c.lastSeen < 10 * 60_000) continue; // might reconnect / still active
    if (!c && Date.now() - hub.startedAt < 10 * 60_000) continue;
    try { t.close(); } catch {}
    transports.delete(id);
  }
}, 60_000);

// keep the viewport warm: refresh whenever a bridge reconnects
hub.on('msg', (m: any) => { if (m && m.type === 'ae' && hub.bridge.authenticated) hub.requestViewport(); });

server.listen(PORT, HOST, () => {
  hub.log({ kind: 'system', message: `Daemon listening on http://${HOST}:${PORT}` });
  console.error(`\n  After Effect Supreme MCP daemon\n  Dashboard : http://${HOST}:${PORT}\n  MCP (HTTP): http://${HOST}:${PORT}/mcp\n  AE bridge : ws://${HOST}:${PORT}/ae\n`);
});
server.on('error', (e: any) => {
  console.error(e.code === 'EADDRINUSE' ? `Port ${PORT} is in use. Is the daemon already running? (set AE_MCP_PORT to change)` : e);
  process.exit(1);
});
