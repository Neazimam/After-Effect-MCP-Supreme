// Central state: log store, connected AI clients, settings, and the After Effects bridge.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { WebSocket } from 'ws';

export type LogEntry = {
  id: number; ts: number; level: 'info' | 'warn' | 'error';
  kind: 'tool' | 'bridge' | 'client' | 'system';
  message: string; client?: string; sessionId?: string; tool?: string;
  status?: 'running' | 'ok' | 'error'; durationMs?: number;
  args?: unknown; result?: unknown; error?: string;
};

export type ClientRec = {
  sessionId: string; name: string; version: string; title?: string;
  connectedAt: number; lastSeen: number; calls: number; errors: number;
  connected: boolean; remote?: string;
};

const LOG_DIR = path.join(os.homedir(), '.ae-supreme-mcp', 'logs');

export function clip(v: unknown, max = 20000): unknown {
  if (v === undefined) return undefined;
  let s: string | undefined;
  try { s = JSON.stringify(v); } catch { s = String(v); }
  if (s === undefined || s.length <= max) return v;
  return { _truncated: true, bytes: s.length, preview: s.slice(0, max) };
}

export class Bridge {
  sock: WebSocket | null = null;
  info: any = null;
  latencyMs: number | null = null;
  connectedAt = 0;
  expectedToken: string | null = null; // set by the daemon at startup; hello must present it
  private authed = false;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private chain: Promise<unknown> = Promise.resolve();
  private seq = 1;
  private hb?: NodeJS.Timeout;
  private lastPong = 0;

  constructor(private hub: Hub) {}

  get connected() { return !!this.sock && this.sock.readyState === 1; }
  get authenticated() { return this.connected && this.authed; }

  status() {
    return { connected: this.connected, info: this.info, latencyMs: this.latencyMs, since: this.connected ? this.connectedAt : null, queued: this.pending.size };
  }

  attach(ws: WebSocket) {
    if (this.sock) { try { this.sock.close(4000, 'replaced'); } catch {} this.failAll('Bridge replaced by a new connection'); }
    this.sock = ws; this.connectedAt = Date.now(); this.lastPong = Date.now(); this.info = null; this.authed = false;
    ws.on('message', (raw) => this.onMessage(raw.toString()));
    ws.on('error', () => {});
    ws.on('close', () => {
      if (this.sock !== ws) return;
      this.sock = null; this.info = null; this.latencyMs = null; this.authed = false;
      clearInterval(this.hb);
      this.failAll('After Effects disconnected');
      this.hub.log({ kind: 'bridge', level: 'warn', message: 'After Effects bridge disconnected' });
      this.hub.pushAe();
    });
    clearInterval(this.hb);
    this.hb = setInterval(() => {
      if (!this.connected) return;
      if (Date.now() - this.lastPong > 60000) { ws.terminate(); return; }
      if (!this.authed) { // hello must arrive within 5s of connecting
        if (Date.now() - this.connectedAt > 5000) { try { ws.close(4001, 'auth timeout'); } catch {} }
        return;
      }
      ws.send(JSON.stringify({ op: 'ping', t: Date.now() }));
    }, 5000);
    this.hub.log({ kind: 'bridge', message: 'After Effects bridge connected (waiting for hello)' });
    this.hub.pushAe();
  }

  private failAll(why: string) {
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error(why)); }
    this.pending.clear();
  }

  private onMessage(raw: string) {
    let m: any; try { m = JSON.parse(raw); } catch { return; }
    if (m.type === 'pong') { this.lastPong = Date.now(); this.latencyMs = Date.now() - m.t; this.hub.pushAe(); return; }
    if (m.type === 'hello') {
      if (this.expectedToken && m.token !== this.expectedToken) {
        this.hub.log({ kind: 'bridge', level: 'error', message: 'Panel auth failed: bad or missing daemon token. Reinstall the panel or restart the daemon.' });
        try { this.sock!.close(4001, 'bad token'); } catch {}
        return;
      }
      this.authed = true;
      this.info = m.info || {};
      this.hub.log({ kind: 'bridge', message: `After Effects ready: ${this.info.app ?? 'AE'} ${this.info.version ?? ''} (panel ${m.panelVersion ?? '?'})` });
      this.hub.pushAe(); return;
    }
    if (m.type === 'panel-api') { this.hub.handlePanelApi(this, m); return; }
    if (!this.authed) return; // ignore commands from unauthenticated sockets
    if (m.type === 'result') {
      const p = this.pending.get(m.id); if (!p) return;
      clearTimeout(p.timer); this.pending.delete(m.id);
      if (m.ok) p.resolve(m.result);
      else p.reject(new Error(String(m.error || 'Unknown After Effects error') + (m.line ? ` (line ${m.line})` : '')));
    }
  }

  /** Commands run strictly one at a time: AE is single-threaded. */
  call(msg: Record<string, unknown>, timeoutMs = 30000): Promise<any> {
    const run = () => new Promise<any>((resolve, reject) => {
      if (!this.connected) return reject(new Error('After Effects is not connected. In AE open Window > Extensions > "After Effect Supreme MCP" and check the daemon URL.'));
      if (!this.authed) return reject(new Error('Panel connected but not authenticated (missing daemon token). Restart After Effects so the panel reloads, then check the panel log.'));
      const id = this.seq++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out after ${timeoutMs}ms waiting for After Effects (busy, rendering, or a modal dialog is open).`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.sock!.send(JSON.stringify({ id, ...msg }));
    });
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => {});
    return p;
  }

  sendDirect(msg: Record<string, unknown>) { if (this.connected) try { this.sock!.send(JSON.stringify(msg)); } catch {} }
}

export class Hub extends EventEmitter {
  entries: LogEntry[] = [];
  clients = new Map<string, ClientRec>();
  settings = { allowRawScripts: true, readOnly: false };
  stats = { calls: 0, errors: 0, totalMs: 0 };
  startedAt = Date.now();
  version = '0.0.0'; // daemon/package version, shown in the dashboard and panel
  bridge: Bridge;
  lastViewport: any = null;
  private viewportTimer: NodeJS.Timeout | null = null;
  private lastViewportReq = 0;
  private seq = 1;

  constructor(public port: number) { super(); this.bridge = new Bridge(this); }

  private send(msg: unknown) { this.emit('msg', msg); }

  /** Pull a compact comp snapshot from AE and push it to dashboard/panel listeners (debounced). */
  requestViewport(immediate = false) {
    if (!this.bridge.authenticated) return;
    if (!immediate && Date.now() - this.lastViewportReq < 3000) return; // cooldown: heartbeats shouldn't spam AE
    if (this.viewportTimer) clearTimeout(this.viewportTimer);
    const run = async () => {
      this.viewportTimer = null;
      this.lastViewportReq = Date.now();
      try {
        const v = await this.bridge.call({ op: 'call', fn: 'viewport', args: {} }, 10_000);
        if (v && v.name) {
          if (v.playing && this.lastViewport?.data?.layers?.length) {
            // AE is playing: the host sent a cheap header-only snapshot. Keep the last
            // full frame (so previews never blank out) and just move the playhead.
            this.lastViewport.data.time = v.time;
          } else {
            this.lastViewport = { data: v, ts: Date.now() };
          }
          this.send({ type: 'viewport', viewport: this.lastViewport });
        }
      } catch {}
    };
    if (immediate) { if (this.viewportTimer) clearTimeout(this.viewportTimer); this.viewportTimer = null; void run(); }
    else this.viewportTimer = setTimeout(run, 350);
  }

  /** Small request/response API used by the CEP panel over its existing bridge socket. */
  async handlePanelApi(bridge: Bridge, m: any) {
    const reply = (ok: boolean, data: unknown) => bridge.sendDirect({ type: 'panel-api-result', id: m.id, ok, ...(ok ? { data } : { error: String(data) }) });
    try {
      if (!bridge.authenticated) throw new Error('Panel not authenticated');
      const p = m.payload || {};
      if (m.api === 'html2ae-preview') {
        const { convertHtmlToLayers } = await import('./html2ae');
        const plan = convertHtmlToLayers(String(p.html || ''), p.options || {});
        reply(true, { layers: plan.layers.length, keyframes: plan.layers.reduce((n, l) => n + Object.values(l.keys || {}).reduce((a, k: any) => a + (k?.length || 0), 0), 0), compName: plan.compName, width: plan.width, height: plan.height, duration: plan.duration, frameRate: plan.frameRate, warnings: plan.warnings, layerNames: plan.layers.map((l) => `${l.kind}:${l.name}`) });
      } else if (m.api === 'html2ae-apply') {
        if (this.settings.readOnly) throw new Error('Read-only mode is ON in the dashboard; HTML → AE would modify the project.');
        const { convertHtmlToLayers } = await import('./html2ae');
        const plan = convertHtmlToLayers(String(p.html || ''), p.options || {});
        const res = await this.bridge.call({ op: 'call', fn: 'buildLayers', args: plan, undoName: 'MCP: html2ae' }, 120_000);
        this.log({ kind: 'tool', tool: 'ae_html_to_layers', client: 'panel', status: 'ok', message: `HTML → AE: ${plan.layers.length} layers into "${res?.comp ?? plan.compName}"`, durationMs: 0 });
        this.requestViewport(true);
        // surface BOTH warning sources: converter-side (missing @keyframes, dropped elements)
        // and AE-side (per-layer build errors) so nothing fails silently
        const allWarnings = [...(plan.warnings || []), ...((res && res.warnings) || [])];
        reply(true, { ...res, warnings: allWarnings });
      } else if (m.api === 'viewport') {
        const v = await this.bridge.call({ op: 'call', fn: 'viewport', args: p || {} }, 10_000);
        reply(true, v);
      } else if (m.api === 'setTime') {
        const v = await this.bridge.call({ op: 'call', fn: 'setTime', args: p || {} }, 5_000);
        this.requestViewport(true);
        reply(true, v);
      } else throw new Error('Unknown panel api: ' + m.api);
    } catch (e: any) {
      reply(false, e?.message ?? String(e));
    }
  }

  private persist(e: LogEntry) {
    try {
      fs.mkdirSync(LOG_DIR, { recursive: true });
      fs.appendFileSync(path.join(LOG_DIR, new Date().toISOString().slice(0, 10) + '.jsonl'), JSON.stringify(e) + '\n');
    } catch {}
  }

  log(e: Partial<LogEntry> & { kind: LogEntry['kind']; message: string }): LogEntry {
    const entry: LogEntry = { id: this.seq++, ts: Date.now(), level: 'info', ...e };
    this.entries.push(entry);
    if (this.entries.length > 2000) this.entries.splice(0, this.entries.length - 2000);
    this.send({ type: 'entry', entry });
    if (entry.kind !== 'tool') this.persist(entry);
    return entry;
  }

  update(id: number, patch: Partial<LogEntry>) {
    let e: LogEntry | undefined;
    for (let i = this.entries.length - 1; i >= 0; i--) if (this.entries[i].id === id) { e = this.entries[i]; break; }
    if (!e) return;
    Object.assign(e, patch);
    this.send({ type: 'update', id, patch });
    if (patch.status && patch.status !== 'running') this.persist(e);
  }

  finishTool(id: number, sessionId: string | undefined, ms: number, ok: boolean, payload: unknown) {
    this.stats.calls++; this.stats.totalMs += ms; if (!ok) this.stats.errors++;
    const c = sessionId ? this.clients.get(sessionId) : undefined;
    if (c) { c.calls++; if (!ok) c.errors++; c.lastSeen = Date.now(); }
    this.update(id, ok
      ? { status: 'ok', durationMs: ms, result: clip(payload) }
      : { status: 'error', level: 'error', durationMs: ms, error: String(payload) });
    this.send({ type: 'stats', stats: this.stats });
    this.pushClients();
  }

  clientConnected(sessionId: string, info: any, remote?: string) {
    const name = String(info?.name || 'unknown-client'), version = String(info?.version || '');
    this.clients.set(sessionId, { sessionId, name, version, title: info?.title, connectedAt: Date.now(), lastSeen: Date.now(), calls: 0, errors: 0, connected: true, remote });
    this.log({ kind: 'client', client: name, sessionId, message: `${name} ${version} connected` });
    this.pushClients();
  }

  clientDisconnected(sessionId: string) {
    const c = this.clients.get(sessionId); if (!c) return;
    c.connected = false;
    this.log({ kind: 'client', level: 'warn', client: c.name, sessionId, message: `${c.name} disconnected` });
    this.pushClients();
  }

  touch(sessionId?: string) {
    const c = sessionId ? this.clients.get(sessionId) : undefined;
    if (c) c.lastSeen = Date.now();
  }

  sweep() {
    for (const [id, c] of this.clients) if (!c.connected && Date.now() - c.lastSeen > 10 * 60_000) this.clients.delete(id);
  }

  clientList() { return [...this.clients.values()].sort((a, b) => b.lastSeen - a.lastSeen); }
  pushClients() { this.send({ type: 'clients', clients: this.clientList() }); }
  pushAe() { this.send({ type: 'ae', ae: this.bridge.status() }); }

  setSettings(p: Partial<{ allowRawScripts: boolean; readOnly: boolean }>) {
    if (typeof p.allowRawScripts === 'boolean') this.settings.allowRawScripts = p.allowRawScripts;
    if (typeof p.readOnly === 'boolean') this.settings.readOnly = p.readOnly;
    this.log({ kind: 'system', level: 'warn', message: `Settings changed: rawScripts=${this.settings.allowRawScripts}, readOnly=${this.settings.readOnly}` });
    this.send({ type: 'settings', settings: this.settings });
  }

  clearLogs() { this.entries = []; this.send({ type: 'snapshot', ...this.snapshot() }); }

  snapshot() {
    return {
      now: Date.now(), startedAt: this.startedAt, port: this.port, version: this.version,
      clients: this.clientList(), ae: this.bridge.status(),
      settings: this.settings, stats: this.stats, entries: this.entries.slice(-500),
      viewport: this.lastViewport,
    };
  }
}
