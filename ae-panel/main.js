// After Effect Supreme MCP panel v0.3.9 — tabs: Bridge, HTML → AE, Preview.
// ES6 for CEF (no optional chaining): connects to the daemon over WebSocket and relays commands into AE.
(function () {
  var VERSION = '0.3.9';
  var cep = window.__adobe_cep__;
  var $ = function (id) { return document.getElementById(id); };
  var verEl = $('ver'); if (verEl) verEl.textContent = 'After Effect Supreme MCP panel v' + VERSION;

  // ---------- tabs ----------
  var tabs = document.querySelectorAll('.tab');
  for (var ti = 0; ti < tabs.length; ti++) {
    tabs[ti].onclick = function () {
      for (var j = 0; j < tabs.length; j++) { tabs[j].classList.remove('active'); document.getElementById('tab-' + tabs[j].getAttribute('data-tab')).classList.remove('active'); }
      this.classList.add('active');
      document.getElementById('tab-' + this.getAttribute('data-tab')).classList.add('active');
      if (this.getAttribute('data-tab') === 'preview') refreshViewport(true);
    };
  }

  // ---------- state ----------
  var url = (function () { try { return localStorage.getItem('aemcp.url'); } catch (e) { return null; } })() || 'ws://127.0.0.1:7654/ae';
  $('url').value = url;
  var ws = null, retry = 0, retryTimer = null, handled = 0, connected = false;
  var apiPending = {}; var apiSeq = 1;
  var vpTimer = null;

  function log(m, cls) {
    var d = $('log'); var line = document.createElement('div');
    if (cls) line.className = cls;
    line.textContent = '[' + new Date().toLocaleTimeString() + '] ' + String(m);
    d.insertBefore(line, d.firstChild);
  }
  function htmlLog(m, cls) {
    var d = $('htmlLog'); var line = document.createElement('div');
    if (cls) line.className = cls;
    line.textContent = String(m);
    d.insertBefore(line, d.firstChild);
  }
  function state(s, sub) {
    $('dot').className = 'dot ' + (s === 'on' ? 'on' : s === 'wait' ? 'wait' : '');
    $('state').textContent = s === 'on' ? 'Connected to daemon' : s === 'wait' ? 'Connecting…' : 'Disconnected';
    $('sub').textContent = sub || '';
    connected = (s === 'on');
    $('planBtn').disabled = !connected;
    $('applyBtn').disabled = !connected;
  }
  function quote(s) { return JSON.stringify(s).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029'); }
  function send(o) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); }
  function host(script, cb) { cep.evalScript(script, cb); }

  // ---------- hello: token + AE info ----------
  function hello() {
    host('AEX.run(' + quote(JSON.stringify({ op: 'call', fn: 'daemonToken' })) + ')', function (tokRes) {
      var token = null;
      try { var tr = JSON.parse(tokRes); if (tr.ok && tr.result) token = tr.result; } catch (e0) {}
      if (!token) log('no daemon token found — start the daemon once, then reconnect', 'err');
      host('AEX.run(' + quote(JSON.stringify({ op: 'call', fn: 'ping' })) + ')', function (res) {
        var info = {}; try { info = JSON.parse(res).result || {}; } catch (e1) { info = { error: String(res).slice(0, 200) }; }
        send({ type: 'hello', panelVersion: VERSION, token: token, info: info });
        state('on', (info.app || 'After Effects') + ' ' + (info.version || ''));
        log('AE ready: ' + (info.app || 'AE') + ' ' + (info.version || ''));
        refreshViewport(true);
      });
    });
  }

  // ---------- panel-api ----------
  function panelApi(api, payload, cb) {
    var id = 'p' + (apiSeq++);
    apiPending[id] = cb;
    send({ type: 'panel-api', id: id, api: api, payload: payload });
    setTimeout(function () { if (apiPending[id]) { delete apiPending[id]; cb(false, 'timeout waiting for daemon'); } }, 130000);
  }

  function htmlOptions() {
    return {
      compName: $('compName').value.trim() || 'HTML Motion',
      width: Number($('cw').value) || 1920,
      height: Number($('ch').value) || 1080,
      frameRate: Number($('fps').value) || 30,
      duration: Number($('dur').value) || 10,
      createComp: !$('intoCur').checked,
    };
  }

  // ---------- HTML file import (CEP native dialog, with browser file input fallback) ----------
  function importText(txt, name) {
    $('html').value = txt;
    $('htmlStatus').textContent = name || 'imported';
    htmlLog('imported ' + (name || 'HTML file') + ' (' + txt.length + ' chars)', 'ok');
  }
  $('importBtn').onclick = function () {
    var fsApi = window.cep && window.cep.fs;
    if (fsApi && fsApi.showOpenDialogEx) {
      var res = fsApi.showOpenDialogEx(false, false, 'Import HTML file', null, ['html', 'htm']);
      if (res && res.data && res.data.length) {
        var rd = fsApi.readFile(res.data[0]);
        if (rd && rd.err === 0) importText(rd.data, res.data[0].replace(/\\/g, '/').split('/').pop());
        else htmlLog('read failed (code ' + (rd ? rd.err : '?') + ')', 'err');
      }
      return;
    }
    $('fileIn').click();
  };
  $('fileIn').onchange = function () {
    var f = this.files && this.files[0]; if (!f) return;
    var input = this;
    var r = new FileReader();
    r.onload = function () { importText(String(r.result), f.name); };
    r.readAsText(f);
    input.value = '';
  };

  $('planBtn').onclick = function () {
    var html = $('html').value;
    if (!html.trim()) return htmlLog('paste or import some HTML first', 'err');
    $('htmlStatus').textContent = 'planning…';
    panelApi('html2ae-preview', { html: html, options: htmlOptions() }, function (ok, data) {
      if (!ok) { $('htmlStatus').textContent = ''; return htmlLog('plan failed: ' + data, 'err'); }
      $('htmlStatus').textContent = data.layers + ' layers · ' + data.keyframes + ' keyframes';
      htmlLog('plan: ' + data.layers + ' layers, ' + data.keyframes + ' keyframes, ' + data.width + 'x' + data.height + ' @ ' + data.frameRate + 'fps ' + data.duration + 's', 'ok');
      for (var i = 0; i < data.layerNames.length && i < 40; i++) htmlLog('  ' + (i + 1) + '. ' + data.layerNames[i]);
      for (var w = 0; w < data.warnings.length; w++) htmlLog('  ⚠ ' + data.warnings[w], 'err');
    });
  };

  $('applyBtn').onclick = function () {
    var html = $('html').value;
    if (!html.trim()) return htmlLog('paste or import some HTML first', 'err');
    $('applyBtn').disabled = true;
    $('htmlStatus').textContent = 'converting…';
    panelApi('html2ae-apply', { html: html, options: htmlOptions() }, function (ok, data) {
      $('applyBtn').disabled = false;
      if (!ok) { $('htmlStatus').textContent = ''; return htmlLog('convert failed: ' + data, 'err'); }
      $('htmlStatus').textContent = data.layers.length + ' layers created';
      htmlLog('✓ ' + data.layers.length + ' layers, ' + data.keyframes + ' keyframes in "' + data.comp + '" (one undo step)', 'ok');
      if (data.effects && data.effects.length) for (var i = 0; i < data.effects.length; i++) htmlLog('  fx: ' + data.effects[i]);
      if (data.warnings && data.warnings.length) for (var w2 = 0; w2 < data.warnings.length; w2++) htmlLog('  ⚠ ' + data.warnings[w2], 'err');
      refreshViewport(true);
    });
  };

  // ---------- preview viewport ----------
  // Dynamic polling: never overlap an in-flight call (AE may be busy playing), and
  // while no comp is open show the state ONCE instead of logging an error every tick.
  // While AE is PLAYING the host replies with a cheap header-only snapshot (playing:true,
  // no layers): keep the last drawn frame, back off, and never steal AE's main thread.
  var vpBusy = false, vpEmpty = false, vpPlaying = false, vpTicks = 0;
  function refreshViewport(force) {
    var pageVisible = document.getElementById('tab-preview').classList.contains('active');
    if (!pageVisible && !force) return;
    if (vpBusy) return;
    vpBusy = true;
    host('AEX.run(' + quote(JSON.stringify({ op: 'call', fn: 'viewport', args: {} })) + ')', function (res) {
      vpBusy = false;
      var out; try { out = JSON.parse(res); } catch (e) { return; }
      if (!out || !out.ok) { vpEmpty = false; vpPlaying = false; $('vpInfo').textContent = out && out.error ? String(out.error).slice(0, 60) : 'viewport unavailable'; return; }
      if (out.result && out.result.empty) {
        if (!vpEmpty) { vpEmpty = true; vpPlaying = false; $('vpInfo').textContent = 'No comp open — Convert creates one'; }
        return;
      }
      vpEmpty = false;
      if (out.result.playing) {
        // playing: keep the last full frame on canvas, just move the time readout
        vpPlaying = true;
        $('vpInfo').textContent = out.result.name + ' · playing · t=' + (Math.round(out.result.time * 100) / 100) + 's';
        return;
      }
      vpPlaying = false;
      drawViewport($('vp'), out.result);
      $('vpInfo').textContent = out.result.name + ' · ' + out.result.numLayers + ' layers · t=' + (Math.round(out.result.time * 100) / 100) + 's';
    });
  }
  function setVpTimer() {
    clearInterval(vpTimer);
    if ($('autoVp').checked) vpTimer = setInterval(function () {
      if (!document.getElementById('tab-preview').classList.contains('active')) return;
      vpTicks++;
      if (vpEmpty && vpTicks % 4 !== 0) return; // no comp: back off to ~every 4s until one opens
      if (vpPlaying && vpTicks % 3 !== 0) return; // playing: back off to ~every 3s, full frame when paused
      refreshViewport(false);
    }, 1000);
  }
  $('autoVp').onchange = setVpTimer;
  $('refreshVp').onclick = function () { refreshViewport(true); };
  setVpTimer();

  function rgba(c, a) {
    if (!c || c.length < 3) return 'rgba(90,96,110,' + (a === undefined ? 1 : a) + ')';
    var r = Math.round(Math.max(0, Math.min(1, c[0])) * 255), g = Math.round(Math.max(0, Math.min(1, c[1])) * 255), b = Math.round(Math.max(0, Math.min(1, c[2])) * 255);
    return 'rgba(' + r + ',' + g + ',' + b + ',' + (a === undefined ? 1 : a) + ')';
  }
  function drawViewport(canvas, vp) {
    var ctx = canvas.getContext('2d'), cw = canvas.width, chh = canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#0b0c0f'; ctx.fillRect(0, 0, cw, chh);
    if (!vp || !vp.width) return;
    var k = Math.min((cw - 16) / vp.width, (chh - 16) / vp.height);
    var ox = (cw - vp.width * k) / 2, oy = (chh + vp.height * k) / 2; // y-up origin (screen y flipped)
    var cx0 = ox + (vp.width / 2) * k, cy0 = oy - (vp.height / 2) * k; // comp center = layer origin
    ctx.fillStyle = rgba(vp.bgColor, 1) === 'rgba(0,0,0,1)' ? '#000' : rgba(vp.bgColor, 1);
    ctx.fillRect(ox, oy - vp.height * k, vp.width * k, vp.height * k);
    var layers = vp.layers || [];
    for (var i = layers.length - 1; i >= 0; i--) {
      var l = layers[i];
      var a = (l.opacity === undefined ? 100 : l.opacity) / 100;
      if (!l.enabled) a *= 0.25;
      var pos = l.pos || [0, 0], anchor = l.anchor || [0, 0], sc = l.scale || [100, 100];
      ctx.save();
      ctx.globalAlpha = a;
      ctx.translate(cx0 + pos[0] * k, cy0 - pos[1] * k);
      // AE rotation is CCW-positive and the canvas here is y-up, so +deg maps directly
      ctx.rotate((l.rotation || 0) * Math.PI / 180);
      ctx.scale(k * sc[0] / 100, -k * sc[1] / 100);
      var col = rgba(l.color);
      if (l.type === 'text' && l.text !== undefined) {
        var fs = l.fontSize || 24;
        ctx.fillStyle = col;
        ctx.font = Math.max(fs, 1) + 'px ' + (l.font || 'Arial');
        var just = String(l.justification || '');
        ctx.textAlign = just.indexOf('CENTER') >= 0 ? 'center' : just.indexOf('RIGHT') >= 0 ? 'right' : 'left';
        ctx.textBaseline = 'middle';
        ctx.save(); ctx.scale(1, -1);
        var lines = String(l.text).split('\r');
        var lh = fs * 1.2, y0 = -(l.top === undefined ? 0 : l.top) + (l.h === undefined ? 0 : l.h) / 2 - (lines.length - 1) * lh / 2;
        for (var li = 0; li < lines.length; li++) ctx.fillText(lines[li], 0, y0 + li * lh);
        ctx.restore();
      } else if (l.w && l.h) {
        var an = l.anchor || [0, 0], isSolid = l.type === 'solid';
        // layer source space is y-down for BOTH kinds (solid: top-left origin 0..w/0..h;
        // shape: centered around the layer origin, exactly like AE) — convert to the
        // y-up canvas relative to the anchor point
        var lx0 = isSolid ? 0 : ((l.left === undefined ? -l.w / 2 : l.left));
        var ly0 = isSolid ? 0 : ((l.top === undefined ? -l.h / 2 : l.top));
        var x0 = lx0 - an[0];
        var y0 = an[1] - ly0 - l.h; // top edge of the rect in y-up space
        var fillStyle = col;
        if (l.gradient) {
          // Ramp points live in layer source space (y-down, anchor-independent)
          var gp = function (p) { return [p[0] - an[0], -(p[1] - an[1])]; };
          var sg0 = gp(l.gradient.start || [0, 0]), eg0 = gp(l.gradient.end || [0, 0]);
          var gr;
          if (l.gradient.radial) { var rr = Math.sqrt(Math.pow(eg0[0] - sg0[0], 2) + Math.pow(eg0[1] - sg0[1], 2)); gr = ctx.createRadialGradient(sg0[0], sg0[1], 0, sg0[0], sg0[1], Math.max(rr, 0.01)); }
          else gr = ctx.createLinearGradient(sg0[0], sg0[1], eg0[0], eg0[1]);
          gr.addColorStop(0, rgba(l.gradient.c1, l.gradient.a1));
          gr.addColorStop(1, rgba(l.gradient.c2, l.gradient.a2 === undefined ? 1 : l.gradient.a2));
          fillStyle = gr;
        }
        ctx.fillStyle = fillStyle;
        if (l.type === 'shape' && l.ellipse) { ctx.beginPath(); ctx.ellipse(x0 + l.w / 2, y0 + l.h / 2, l.w / 2, l.h / 2, 0, 0, Math.PI * 2); ctx.fill(); }
        else {
          ctx.fillRect(x0, y0, l.w, l.h);
          if (!l.color && !l.gradient) { ctx.strokeStyle = 'rgba(120,130,150,.8)'; ctx.lineWidth = 1 / k; ctx.strokeRect(x0, y0, l.w, l.h); }
        }
      }
      ctx.restore();
    }
  }

  // ---------- bridge connect ----------
  function runCommand(m) {
    var payload = JSON.stringify({ op: m.op, fn: m.fn, args: m.args, code: m.code, undoName: m.undoName });
    host('AEX.run(' + quote(payload) + ')', function (res) {
      var out;
      try { out = JSON.parse(res); } catch (e) { out = { ok: false, error: 'Host returned: ' + String(res).slice(0, 300) }; }
      out.type = 'result'; out.id = m.id; send(out);
      handled++; $('count').textContent = handled;
      log((m.fn || 'script') + (out.ok ? ' ✓' : ' ✗ ' + out.error), out.ok ? 'ok' : 'err');
    });
  }

  function connect() {
    clearTimeout(retryTimer); state('wait', url);
    try { ws = new WebSocket(url); } catch (e) { return schedule(); }
    ws.onopen = function () { retry = 0; log('connected to ' + url); hello(); };
    ws.onclose = function (ev) {
      if (ev && ev.code === 4001) { state('off', 'auth rejected'); log('daemon rejected the panel token — restart After Effects, or reinstall the panel', 'err'); }
      else state('off', 'Retrying… (is the daemon running?)');
      schedule();
    };
    ws.onerror = function () {};
    ws.onmessage = function (ev) {
      var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.op === 'ping') return send({ type: 'pong', t: m.t });
      if (m.type === 'panel-api-result' && apiPending[m.id]) { var cb = apiPending[m.id]; delete apiPending[m.id]; cb(!!m.ok, m.ok ? m.data : m.error); return; }
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
