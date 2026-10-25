// Pretends to be the After Effects panel so you can try the daemon + dashboard without AE.
import WebSocket from 'ws';
const url = process.env.AE_MCP_WS || 'ws://127.0.0.1:7654/ae';
const comps = [{ index: 1, id: 10, name: 'Main', type: 'comp', width: 1920, height: 1080, duration: 10, frameRate: 30, numLayers: 2 }];

function fake(m) {
  if (m.op === 'exec') return { ok: true, result: { mock: true, ranCodeChars: String(m.code).length } };
  const a = m.args || {};
  switch (m.fn) {
    case 'ping': return { ok: true, result: { app: 'AfterFX', version: '26.0 (mock)', build: 'mock-1', os: 'Mock OS', project: 'C:\\mock\\demo.aep' } };
    case 'project': return { ok: true, result: { name: 'demo.aep', numItems: 1, items: comps, active: { id: 10, name: 'Main' } } };
    case 'comp': return { ok: true, result: { name: 'Main', width: 1920, height: 1080, numLayers: 2, layers: [{ index: 1, name: 'Title', type: 'text' }, { index: 2, name: 'BG', type: 'solid' }] } };
    case 'inspect': return { ok: true, result: { name: 'Title', kind: 'group', children: [{ name: 'Transform', matchName: 'ADBE Transform Group', kind: 'group' }] } };
    case 'setProperty': return String(a.path).includes('Nope') ? { ok: false, error: 'Error: Property not found: "Nope" in path "' + a.path + '"', line: 212 } : { ok: true, result: { path: a.path, value: a.value, numKeys: 0 } };
    default: return { ok: true, result: { mock: true, fn: m.fn, args: a } };
  }
}

function start() {
  const ws = new WebSocket(url);
  ws.on('open', () => { console.log('mock AE connected'); ws.send(JSON.stringify({ type: 'hello', panelVersion: 'mock', info: fake({ op: 'call', fn: 'ping' }).result })); });
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.op === 'ping') return ws.send(JSON.stringify({ type: 'pong', t: m.t }));
    setTimeout(() => ws.send(JSON.stringify({ type: 'result', id: m.id, ...fake(m) })), 40 + Math.random() * 160);
  });
  ws.on('close', () => setTimeout(start, 1000));
  ws.on('error', () => {});
}
start();
