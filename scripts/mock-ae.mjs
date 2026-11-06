// Pretends to be the After Effects panel so you can try the daemon + dashboard without AE.
// Reads the daemon token like the real CEP panel does.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

const url = process.env.AE_MCP_WS || 'ws://127.0.0.1:7654/ae';
const tokenFile = path.join(os.homedir(), '.ae-supreme-mcp', 'daemon-token');
let token = null;
try { token = fs.readFileSync(tokenFile, 'utf8').trim() || null; } catch {}
if (!token) console.log(`[mock-ae] no token at ${tokenFile} — start the daemon first (it creates the token on boot)`);

const comps = [{ index: 1, id: 10, name: 'Main', type: 'comp', width: 1920, height: 1080, duration: 10, frameRate: 30, numLayers: 2 }];
let time = 0;
let builtBg = [0.063, 0.063, 0.094];

// fake layers for the viewport — AE order: index 1 = TOP layer first
let built = null; // after buildLayers, the mock renders the real converted spec
const fakeLayers = [
  { index: 1, name: 'Title', type: 'text', enabled: true, text: 'HELLO', fontSize: 90, font: 'Arial Bold', color: [1, 1, 1], pos: [0, 100], anchor: [0, 0], scale: [100, 100], rotation: 0, opacity: 100, w: 300, h: 120, left: -150, top: 60 },
  { index: 2, name: 'BG', type: 'solid', enabled: true, w: 1920, h: 1080, pos: [0, 0], anchor: [960, 540], scale: [100, 100], rotation: 0, opacity: 100, color: [0.063, 0.063, 0.094] },
];

function specToViewportLayers(spec) {
  // spec is bottom-first; viewport wants top-first
  return [...spec].reverse().map((l, i) => {
    const o = { index: i + 1, name: l.name, type: l.kind === 'footage' ? 'footage' : l.kind, enabled: true, pos: l.pos, scale: l.scale || [100, 100], rotation: l.rotation || 0, opacity: l.opacity === undefined ? 100 : l.opacity };
    if (l.kind === 'text') { o.text = l.text; o.fontSize = l.fontSize; o.font = l.font; o.color = l.color; o.w = l.w; o.h = l.h; o.left = -l.w / 2; o.top = l.h / 2; o.anchor = [0, 0]; }
    else if (l.kind === 'shape') { o.w = l.w; o.h = l.h; o.anchor = [0, 0]; o.ellipse = l.shape === 'ellipse'; o.color = l.fill || l.color || [0.5, 0.5, 0.5]; }
    else { o.w = l.w; o.h = l.h; o.anchor = [l.w / 2, l.h / 2]; o.color = l.color || l.fill || [0.4, 0.4, 0.45]; }
    return o;
  });
}

function fake(m) {
  if (m.op === 'exec') return { ok: true, result: { mock: true, ranCodeChars: String(m.code).length } };
  const a = m.args || {};
  switch (m.fn) {
    case 'ping': return { ok: true, result: { app: 'AfterFX', version: '26.0 (mock)', build: 'mock-1', os: 'Mock OS', project: 'C:\\mock\\demo.aep' } };
    case 'daemonToken': return { ok: true, result: token };
    case 'project': return { ok: true, result: { name: 'demo.aep', numItems: 1, items: comps, active: { id: 10, name: 'Main' } } };
    case 'comp': return { ok: true, result: { name: 'Main', width: 1920, height: 1080, numLayers: 2, layers: [{ index: 1, name: 'Title', type: 'text' }, { index: 2, name: 'BG', type: 'solid' }] } };
    case 'inspect': return { ok: true, result: { name: 'Title', kind: 'group', children: [{ name: 'Transform', matchName: 'ADBE Transform Group', kind: 'group' }] } };
    case 'viewport': {
      const layers = built ? built : fakeLayers;
      return { ok: true, result: { name: built ? 'HTML Motion (mock)' : 'Main', id: 10, width: 1920, height: 1080, duration: 10, frameRate: 30, time, bgColor: built ? builtBg : [0.063, 0.063, 0.094], numLayers: layers.length, layers } };
    }
    case 'setTime': time = Math.max(0, Math.min(10, a.time || 0)); return { ok: true, result: { time, comp: 'Main' } };
    case 'buildLayers': {
      const plan = a.layers || [];
      if (a.createComp !== false) { built = specToViewportLayers(plan); builtBg = a.bgColor || [0.063, 0.063, 0.094]; }
      return { ok: true, result: { comp: a.compName || 'Main', layers: plan.map((l, i) => ({ name: l.name, index: i + 1, kind: l.kind })),
        keyframes: plan.reduce((n, l) => n + Object.values(l.keys || {}).reduce((a2, k) => a2 + (k ? k.length : 0), 0), 0),
        effects: plan.filter((l) => l.gradient || l.shadow).map((l) => l.name + ': fx'),
        warnings: [] } };
    }
    case 'setProperty': return String(a.path).includes('Nope') ? { ok: false, error: 'Error: Property not found: "Nope" in path "' + a.path + '"', line: 212 } : { ok: true, result: { path: a.path, value: a.value, numKeys: 0 } };
    default: return { ok: true, result: { mock: true, fn: m.fn, args: a } };
  }
}

function start() {
  const ws = new WebSocket(url);
  ws.on('open', () => { console.log('mock AE connected'); ws.send(JSON.stringify({ type: 'hello', panelVersion: 'mock', token, info: fake({ op: 'call', fn: 'ping' }).result })); });
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type === 'ping' || m.op === 'ping') return ws.send(JSON.stringify({ type: 'pong', t: m.t }));
    if (m.type === 'panel-api') {
      const reply = (ok, data) => ws.send(JSON.stringify({ type: 'panel-api-result', id: m.id, ok, ...(ok ? { data } : { error: String(data) }) }));
      if (m.api === 'viewport') return reply(true, fake({ op: 'call', fn: 'viewport', args: m.payload }).result);
      if (m.api === 'setTime') return reply(true, fake({ op: 'call', fn: 'setTime', args: m.payload }).result);
      if (m.api === 'html2ae-preview') return reply(true, { layers: 2, keyframes: 5, compName: 'HTML Motion', width: 1920, height: 1080, duration: 10, frameRate: 30, warnings: [], layerNames: ['text:Title', 'shape:Ball'] });
      if (m.api === 'html2ae-apply') return reply(true, { comp: 'HTML Motion', layers: [{ name: 'Title', index: 1, kind: 'text' }], keyframes: 4, effects: [], warnings: [] });
      return reply(false, 'mock-ae does not implement ' + m.api);
    }
    if (m.op === 'call' || m.op === 'exec') setTimeout(() => ws.send(JSON.stringify({ type: 'result', id: m.id, ...fake(m) })), 40 + Math.random() * 160);
  });
  ws.on('close', () => setTimeout(start, 1000));
  ws.on('error', () => {});
}
start();
