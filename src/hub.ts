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
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private chain: Promise<unknown> = Promise.resolve();
  private seq = 1;
  private hb?: NodeJS.Timeout;
  private lastPong = 0;

  constructor(private hub: Hub) {}

  get connected() { return !!this.sock && this.sock.readyState === 1; }

  status() {
    return { connected: this.connected, info: this.info, latencyMs: this.latencyMs, since: this.connected ? this.connectedAt : null, queued: this.pending.size };
  }

  attach(ws: WebSocket) {
    if (this.sock) { try { this.sock.close(4000, 'replaced'); } catch {} this.failAll('Bridge replaced by a new connection'); }
    this.sock = ws; this.connectedAt = Date.now(); this.lastPong = Date.now(); this.info = null;
    ws.on('message', (raw) => this.onMessage(raw.toString()));
    ws.on('error', () => {});
    ws.on('close', () => {
      if (this.sock !== ws) return;
      this.sock = null; this.info = null; this.latencyMs = null;
      clearInterval(this.hb);
      this.failAll('After Effects disconnected');
      this.hub.log({ kind: 'bridge', level: 'warn', message: 'After Effects bridge disconnected' });
      this.hub.pushAe();
    });
    clearInterval(this.hb);
    this.hb = setInterval(() => {
      if (!this.connected) return;
      if (Date.now() - this.lastPong > 60000) { ws.terminate(); return; }
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
      this.info = m.info || {};
      this.hub.log({ kind: 'bridge', message: `After Effects ready: ${this.info.app ?? 'AE'} ${this.info.version ?? ''} (panel ${m.panelVersion ?? '?'})` });
      this.hub.pushAe(); return;
    }
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
}

export class Hub extends EventEmitter {
  entries: LogEntry[] = [];
  clients = new Map<string, ClientRec>();
  settings = { allowRawScripts: true, readOnly: false };
  stats = { calls: 0, errors: 0, totalMs: 0 };
  startedAt = Date.now();
  bridge: Bridge;
  private seq = 1;

  constructor(public port: number) { super(); this.bridge = new Bridge(this); }

  private send(msg: unknown) { this.emit('msg', msg); }

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
      now: Date.now(), startedAt: this.startedAt, port: this.port,
      clients: this.clientList(), ae: this.bridge.status(),
      settings: this.settings, stats: this.stats, entries: this.entries.slice(-500),
    };
  }
}
