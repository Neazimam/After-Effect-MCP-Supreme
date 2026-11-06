// Simulates the real CEP panel behavior on ONE bridge socket:
//  - sends hello with the daemon token
//  - answers daemon->host commands ({op:'call'}) like AE would (this is what the panel does via evalScript)
//  - exercises the panel-api endpoints used by the "HTML -> AE" tab (plan + apply + viewport + setTime)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

const port = process.env.AE_MCP_PORT || 7654;
const tokenFile = path.join(os.homedir(), '.ae-supreme-mcp', 'daemon-token');
const token = fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf8').trim() : null;

let hostTime = 0;
let builtLayers = 0;

// mini fake AE host — mirrors scripts/mock-ae.mjs behavior for the functions the panel path uses
function hostFake(m) {
  if (m.op === 'exec') return { ranCodeChars: String(m.code).length };
  const a = m.args || {};
  switch (m.fn) {
    case 'ping': return { app: 'AfterFX', version: '26.0 (panel-test)', build: 'pt-1', os: 'Test OS', project: 'C:\\test.aep' };
    case 'daemonToken': return token;
    case 'buildLayers': {
      builtLayers = (a.layers || []).length;
      return { comp: a.compName || 'Main', layers: (a.layers || []).map((l, i) => ({ name: l.name, index: i + 1, kind: l.kind })),
        keyframes: (a.layers || []).reduce((n, l) => n + Object.values(l.keys || {}).reduce((a2, k) => a2 + (k ? k.length : 0), 0), 0),
        effects: (a.layers || []).filter((l) => l.gradient || l.shadow).map((l) => l.name + ': Ramp'), warnings: [] };
    }
    case 'viewport': return { name: builtLayers ? 'Panel Test' : 'Main', id: 10, width: 1920, height: 1080, duration: 8, frameRate: 30, time: hostTime, bgColor: [0.05, 0.07, 0.13], numLayers: builtLayers || 1,
      layers: [{ index: 1, name: 'GOD LEVEL', type: 'text', enabled: true, text: 'GOD LEVEL', fontSize: 140, color: [1, 0.83, 0.36], pos: [0, 180], anchor: [0, 0], scale: [100, 100], rotation: 0, opacity: 100, w: 800, h: 170, left: -400, top: 85 }] };
    case 'setTime': hostTime = Math.max(0, Math.min(8, a.time || 0)); return { time: hostTime, comp: 'Panel Test' };
    default: return { mock: true, fn: m.fn };
  }
}

const ws = new WebSocket(`ws://127.0.0.1:${port}/ae`);
let seq = 0;
const pending = new Map();
const hostPending = new Map();
let hostSeq = 1;

function api(apiName, payload) {
  return new Promise((resolve, reject) => {
    const id = 't' + (++seq);
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ type: 'panel-api', id, api: apiName, payload }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('timeout ' + apiName)); } }, 25000);
  });
}

ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', panelVersion: '0.3.0-test', token, info: { app: 'AfterFX', version: '26.0 (panel-test)' } })));
ws.on('close', (code) => { for (const [, p] of pending) p.reject(new Error('socket closed ' + code)); pending.clear(); });
ws.on('error', () => {});
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.type === 'ping') return ws.send(JSON.stringify({ type: 'pong', t: m.t }));
  if ((m.op === 'call' || m.op === 'exec')) {  // daemon -> host command: answer like AE via evalScript
    let result, ok = true;
    try { result = hostFake(m); } catch (e) { ok = false; result = String(e); }
    return ws.send(JSON.stringify({ type: 'result', id: m.id, ok, result }));
  }
  if (m.type === 'panel-api-result' && pending.has(m.id)) {
    const p = pending.get(m.id); pending.delete(m.id);
    m.ok ? p.resolve(m.data) : p.reject(new Error(String(m.error)));
  }
});

const html = `<style>
  body { margin:0; background:#0e1220 }
  .t { position:absolute; left:400px; top:300px; font:800 140px Arial; color:#ffd35c; letter-spacing:6px; animation:in 2.4s ease-out both }
  .bar { position:absolute; left:400px; top:640px; width:1120px; height:26px; background:#ff5ca8; transform-origin:left center; animation:grow 1.6s cubic-bezier(.2,.8,.2,1) both }
  @keyframes in { 0% { transform:translateY(60px) scale(.7); opacity:0 } 100% { transform:translateY(0) scale(1); opacity:1 } }
  @keyframes grow { 0% { transform:scaleX(0) } 100% { transform:scaleX(1) } }
</style>
<div class="t">GOD LEVEL</div><div class="bar"></div>`;

const OPTS = { compName: 'Panel Test', width: 1920, height: 1080, frameRate: 30, duration: 8 };
try {
  await new Promise((r, j) => { if (ws.readyState === 1) r(); else { ws.on('open', r); setTimeout(() => j(new Error('connect timeout')), 8000); } });
  await new Promise((r) => setTimeout(r, 500));
  const plan = await api('html2ae-preview', { html, options: OPTS });
  console.log('PLAN  ✓', JSON.stringify({ layers: plan.layers, keyframes: plan.keyframes, names: plan.layerNames, warnings: plan.warnings }));
  const apply = await api('html2ae-apply', { html, options: OPTS });
  console.log('APPLY ✓', JSON.stringify({ comp: apply.comp, layers: apply.layers.length, keyframes: apply.keyframes, effects: apply.effects, warnings: apply.warnings }));
  const vp = await api('viewport', {});
  console.log('VIEW  ✓', JSON.stringify({ name: vp.name, layers: vp.numLayers, time: vp.time }));
  await api('setTime', { time: 1.5 });
  const vp2 = await api('viewport', {});
  console.log('SCRUB ✓ t=' + vp2.time + 's');
  console.log('\nALL PANEL-API TESTS PASSED');
} catch (e) {
  console.error('FAIL:', e.message);
  process.exitCode = 1;
} finally {
  setTimeout(() => process.exit(process.exitCode || 0), 200);
}
