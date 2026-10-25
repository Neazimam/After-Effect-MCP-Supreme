// After Effect Supreme MCP panel: connects to the daemon over WebSocket and executes commands via the host library.
(function () {
  var VERSION = '0.1.0', cep = window.__adobe_cep__;
  var $ = function (id) { return document.getElementById(id); };
  var url = (function () { try { return localStorage.getItem('aemcp.url'); } catch (e) { return null; } })() || 'ws://127.0.0.1:7654/ae';
  var ws = null, retry = 0, retryTimer = null, handled = 0;
  $('url').value = url;

  function log(m) { var d = $('log'); d.innerHTML = '[' + new Date().toLocaleTimeString() + '] ' + String(m).replace(/</g, '&lt;') + '<br>' + d.innerHTML; }
  function state(s, sub) {
    $('dot').className = 'dot ' + (s === 'on' ? 'on' : s === 'wait' ? 'wait' : '');
    $('state').textContent = s === 'on' ? 'Connected to daemon' : s === 'wait' ? 'Connecting…' : 'Disconnected';
    $('sub').textContent = sub || '';
  }
  function quote(s) { return JSON.stringify(s).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029'); }
  function send(o) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); }
  function host(script, cb) { cep.evalScript(script, cb); }

  function hello() {
    host('AEX.run(' + quote(JSON.stringify({ op: 'call', fn: 'ping' })) + ')', function (res) {
      var info = {}; try { info = JSON.parse(res).result || {}; } catch (e) { info = { error: String(res).slice(0, 200) }; }
      send({ type: 'hello', panelVersion: VERSION, info: info });
      state('on', (info.app || 'After Effects') + ' ' + (info.version || '') + ' · ' + url);
    });
  }

  function runCommand(m) {
    var payload = JSON.stringify({ op: m.op, fn: m.fn, args: m.args, code: m.code, undoName: m.undoName });
    host('AEX.run(' + quote(payload) + ')', function (res) {
      var out;
      try { out = JSON.parse(res); } catch (e) { out = { ok: false, error: 'Host returned: ' + String(res).slice(0, 300) }; }
      out.type = 'result'; out.id = m.id; send(out);
      handled++; $('count').textContent = handled; log((m.fn || 'script') + (out.ok ? ' ✓' : ' ✗ ' + out.error));
    });
  }

  function connect() {
    clearTimeout(retryTimer); state('wait', url);
    try { ws = new WebSocket(url); } catch (e) { return schedule(); }
    ws.onopen = function () { retry = 0; log('connected'); hello(); };
    ws.onclose = function () { state('off', 'Retrying… (is the daemon running?)'); schedule(); };
    ws.onerror = function () {};
    ws.onmessage = function (ev) {
      var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.op === 'ping') return send({ type: 'pong', t: m.t });
      if (m.op === 'call' || m.op === 'exec') runCommand(m);
    };
  }
  function schedule() { retry = Math.min(retry + 1, 8); retryTimer = setTimeout(connect, 500 * retry); }

  $('save').onclick = function () {
    url = $('url').value.trim() || url;
    try { localStorage.setItem('aemcp.url', url); } catch (e) {}
    if (ws) { ws.onclose = null; try { ws.close(); } catch (e) {} }
    connect();
  };
  $('open').onclick = function () {
    var http = url.replace(/^ws/, 'http').replace(/\/ae$/, '/');
    try { window.cep.util.openURLInDefaultBrowser(http); } catch (e) { log('open: ' + http); }
  };
  connect();
})();
