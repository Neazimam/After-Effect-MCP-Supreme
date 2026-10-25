// After Effect Supreme MCP - host library. Runs inside After Effects (ExtendScript, ES3 syntax only).
// Every command arrives through AEX.run(), is wrapped in ONE undo group, and returns a JSON string.
//@target aftereffects

var AEX = (function () {
  var A = {};

  // Safe instanceof: some documented AE classes (Item, Layer, ...) are not real globals in every AE version.
  function G(n) { try { return $.global[n]; } catch (e) { return undefined; } }
  function isA(v, n) { var C = G(n); if (!C) return false; try { return v instanceof C; } catch (e) { return false; } }
  function isLayer(v) { return isA(v, 'AVLayer') || isA(v, 'ShapeLayer') || isA(v, 'TextLayer') || isA(v, 'CameraLayer') || isA(v, 'LightLayer') || isA(v, 'Layer'); }
  function isItem(v) { return isA(v, 'CompItem') || isA(v, 'FolderItem') || isA(v, 'FootageItem') || isA(v, 'Item'); }

  // ---------- JSON serializer (ExtendScript has no reliable JSON) ----------
  function isArr(v) { return Object.prototype.toString.call(v) === '[object Array]'; }
  function esc(s) {
    return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')
      .replace(/[\u0000-\u001f\u2028\u2029]/g, function (c) { return '\\u' + ('0000' + c.charCodeAt(0).toString(16)).slice(-4); }) + '"';
  }
  function ser(v, d) {
    d = d || 0;
    if (v === null || v === undefined) return 'null';
    var t = typeof v, i, a, k;
    if (t === 'number') return isFinite(v) ? String(v) : 'null';
    if (t === 'boolean') return String(v);
    if (t === 'string') return esc(v);
    if (d > 9) return '"[max depth]"';
    if (isArr(v)) { a = []; for (i = 0; i < v.length; i++) a.push(ser(v[i], d + 1)); return '[' + a.join(',') + ']'; }
    if (isA(v, 'Shape')) return ser({ vertices: v.vertices, inTangents: v.inTangents, outTangents: v.outTangents, closed: v.closed }, d + 1);
    if (isA(v, 'TextDocument')) {
      var td = { text: v.text }; try { td.font = v.font; td.fontSize = v.fontSize; td.fillColor = v.fillColor; td.justification = String(v.justification); } catch (e0) {}
      return ser(td, d + 1);
    }
    if (isLayer(v)) return ser({ layer: v.name, index: v.index }, d + 1);
    if (isItem(v)) return ser({ item: v.name, id: v.id }, d + 1);
    if (t === 'object') {
      a = [];
      for (k in v) { if (!v.hasOwnProperty(k)) continue; try { a.push(esc(k) + ':' + ser(v[k], d + 1)); } catch (e1) {} }
      return '{' + a.join(',') + '}';
    }
    return esc(String(v));
  }

  // ---------- resolvers ----------
  function findComp(ref) {
    var p = app.project, c = null, i, it;
    if (ref === undefined || ref === null || ref === '') {
      c = p.activeItem;
      if (!(c instanceof CompItem)) throw new Error('No active composition. Open a comp or pass "comp".');
      return c;
    }
    if (typeof ref === 'number') { c = p.item(ref); }
    else { for (i = 1; i <= p.numItems; i++) { it = p.item(i); if (it instanceof CompItem && it.name === ref) { c = it; break; } } }
    if (!(c instanceof CompItem)) throw new Error('Composition not found: ' + ref);
    return c;
  }
  function findLayer(comp, ref) {
    var i;
    if (typeof ref === 'number') {
      if (ref < 1 || ref > comp.numLayers) throw new Error('Layer index out of range: ' + ref + ' (comp has ' + comp.numLayers + ')');
      return comp.layer(ref);
    }
    for (i = 1; i <= comp.numLayers; i++) if (comp.layer(i).name === ref) return comp.layer(i);
    throw new Error('Layer not found: ' + ref);
  }
  // path: "Transform/Position", "Effects/Gaussian Blur/Blurriness", "ADBE Transform Group/ADBE Opacity", "#2" = 2nd child
  function getProp(layer, path) {
    var segs = String(path).split('/'), p = layer, i, s, nx;
    for (i = 0; i < segs.length; i++) {
      s = segs[i]; if (s === '') continue;
      nx = (s.charAt(0) === '#') ? p.property(parseInt(s.substring(1), 10)) : p.property(s);
      if (!nx) throw new Error('Property not found: "' + s + '" in path "' + path + '"');
      p = nx;
    }
    return p;
  }

  // ---------- value helpers ----------
  function hexToRgb(h) {
    h = h.replace('#', '');
    if (h.length === 3) h = h.charAt(0) + h.charAt(0) + h.charAt(1) + h.charAt(1) + h.charAt(2) + h.charAt(2);
    return [parseInt(h.substr(0, 2), 16) / 255, parseInt(h.substr(2, 2), 16) / 255, parseInt(h.substr(4, 2), 16) / 255];
  }
  function col(v) {
    var i, big = false;
    if (typeof v === 'string') return hexToRgb(v);
    if (isArr(v)) { for (i = 0; i < v.length; i++) if (v[i] > 1) big = true; if (big) { var o = []; for (i = 0; i < v.length; i++) o.push(v[i] / 255); return o; } }
    return v;
  }
  function toValue(prop, v) {
    var pvt = prop.propertyValueType;
    if (pvt == PropertyValueType.COLOR) return col(v);
    if (pvt == PropertyValueType.SHAPE && v && typeof v === 'object' && !isA(v, 'Shape')) {
      var s = new Shape(); s.vertices = v.vertices; s.closed = (v.closed !== false);
      if (v.inTangents) s.inTangents = v.inTangents; if (v.outTangents) s.outTangents = v.outTangents;
      return s;
    }
    if (pvt == PropertyValueType.TEXT_DOCUMENT) {
      var td = prop.value;
      if (typeof v === 'string') td.text = v;
      else {
        if (v.text !== undefined) td.text = v.text;
        if (v.font) td.font = v.font;
        if (v.fontSize) td.fontSize = v.fontSize;
        if (v.fillColor) { td.applyFill = true; td.fillColor = col(v.fillColor); }
        if (v.justification) td.justification = ({ left: ParagraphJustification.LEFT_JUSTIFY, center: ParagraphJustification.CENTER_JUSTIFY, right: ParagraphJustification.RIGHT_JUSTIFY })[v.justification] || td.justification;
      }
      return td;
    }
    return v;
  }
  function setVal(prop, v, time) {
    v = toValue(prop, v);
    if (time !== undefined && time !== null) prop.setValueAtTime(time, v); else prop.setValue(v);
  }
  function dims(prop) {
    if (prop.isSpatial) return 1;
    var t = prop.propertyValueType;
    if (t == PropertyValueType.TwoD) return 2;
    if (t == PropertyValueType.ThreeD) return 3;
    if (t == PropertyValueType.COLOR) return 4;
    return 1;
  }
  function easeArr(n, speed, infl) { var a = [], i; for (i = 0; i < n; i++) a.push(new KeyframeEase(speed, infl)); return a; }
  function applyEase(prop, idx, e) {
    var n = dims(prop), L = KeyframeInterpolationType.LINEAR, H = KeyframeInterpolationType.HOLD, B = KeyframeInterpolationType.BEZIER;
    if (!e) return;
    if (e === 'linear') prop.setInterpolationTypeAtKey(idx, L, L);
    else if (e === 'hold') prop.setInterpolationTypeAtKey(idx, H, H);
    else {
      prop.setInterpolationTypeAtKey(idx, B, B);
      if (e === 'easeInOut') prop.setTemporalEaseAtKey(idx, easeArr(n, 0, 33.33), easeArr(n, 0, 33.33));
      else if (e === 'easeIn') prop.setTemporalEaseAtKey(idx, easeArr(n, 0, 75), easeArr(n, 0, 0.1));
      else if (e === 'easeOut') prop.setTemporalEaseAtKey(idx, easeArr(n, 0, 0.1), easeArr(n, 0, 75));
    }
  }

  // ---------- describe ----------
  function layerType(l) {
    if (l instanceof TextLayer) return 'text';
    if (l instanceof ShapeLayer) return 'shape';
    if (l instanceof CameraLayer) return 'camera';
    if (l instanceof LightLayer) return 'light';
    try {
      if (l.nullLayer) return 'null';
      if (l.adjustmentLayer) return 'adjustment';
      if (l.source instanceof CompItem) return 'precomp';
      if (l.source && l.source.mainSource instanceof SolidSource) return 'solid';
    } catch (e) {}
    return 'footage';
  }
  function layerBrief(l) {
    var o = { index: l.index, name: l.name, type: layerType(l), enabled: l.enabled, solo: l.solo, locked: l.locked, shy: l.shy,
      inPoint: l.inPoint, outPoint: l.outPoint, startTime: l.startTime, parent: l.parent ? l.parent.index : null, label: l.label };
    try { o.threeD = l.threeDLayer; } catch (e1) {}
    try { o.effects = l.property('ADBE Effect Parade').numProperties; } catch (e2) {}
    try { o.masks = l.property('ADBE Mask Parade').numProperties; } catch (e3) {}
    try { if (l.source) o.source = l.source.name; } catch (e4) {}
    return o;
  }
  var PVT = [[PropertyValueType.OneD, 'OneD'], [PropertyValueType.TwoD, 'TwoD'], [PropertyValueType.ThreeD, 'ThreeD'], [PropertyValueType.COLOR, 'COLOR'],
    [PropertyValueType.SHAPE, 'SHAPE'], [PropertyValueType.TEXT_DOCUMENT, 'TEXT_DOCUMENT'], [PropertyValueType.MARKER, 'MARKER'],
    [PropertyValueType.LAYER_INDEX, 'LAYER_INDEX'], [PropertyValueType.MASK_INDEX, 'MASK_INDEX'], [PropertyValueType.NO_VALUE, 'NO_VALUE'],
    [PropertyValueType.CUSTOM_VALUE, 'CUSTOM'], [PropertyValueType.TwoD_SPATIAL, 'TwoD_SPATIAL'], [PropertyValueType.ThreeD_SPATIAL, 'ThreeD_SPATIAL']];
  function pvtName(t) { var i; for (i = 0; i < PVT.length; i++) if (PVT[i][0] == t) return PVT[i][1]; return 'unknown'; }
  function describe(p, depth) {
    var o = { name: p.name, matchName: p.matchName }, i;
    if (!isLayer(p) && p.propertyType === PropertyType.PROPERTY) {
      o.kind = 'property';
      try { o.valueType = pvtName(p.propertyValueType); } catch (e1) {}
      try { if (p.propertyValueType != PropertyValueType.NO_VALUE && p.propertyValueType != PropertyValueType.CUSTOM_VALUE) o.value = p.value; } catch (e2) {}
      try { o.numKeys = p.numKeys; } catch (e3) {}
      try { if (p.expression) o.expression = p.expression; } catch (e4) {}
    } else {
      o.kind = (!isLayer(p) && p.propertyType === PropertyType.INDEXED_GROUP) ? 'indexedGroup' : 'group';
      try { o.numProperties = p.numProperties; } catch (e5) {}
      if (depth > 0) { o.children = []; for (i = 1; i <= p.numProperties; i++) o.children.push(describe(p.property(i), depth - 1)); }
    }
    return o;
  }

  // ---------- commands ----------
  A.ping = function () {
    var pf = null; try { pf = app.project.file ? app.project.file.fsName : null; } catch (e) {}
    return { app: app.appName, version: app.version, build: app.buildName, os: $.os, project: pf, locale: app.isoLanguage };
  };

  A.project = function () {
    var p = app.project, items = [], i, it, o, n = Math.min(p.numItems, 500), ac = p.activeItem;
    for (i = 1; i <= n; i++) {
      it = p.item(i);
      o = { index: i, id: it.id, name: it.name, type: (it instanceof CompItem) ? 'comp' : (it instanceof FolderItem) ? 'folder' : (it instanceof FootageItem) ? ((it.mainSource instanceof SolidSource) ? 'solid' : 'footage') : 'item' };
      if (it instanceof CompItem) { o.width = it.width; o.height = it.height; o.duration = it.duration; o.frameRate = it.frameRate; o.numLayers = it.numLayers; }
      if (it instanceof FootageItem && it.file) o.file = it.file.fsName;
      items.push(o);
    }
    return { name: p.file ? p.file.name : null, path: p.file ? p.file.fsName : null, numItems: p.numItems, truncated: p.numItems > n,
      bitsPerChannel: p.bitsPerChannel, active: (ac instanceof CompItem) ? { id: ac.id, name: ac.name } : null, items: items };
  };

  A.comp = function (a) {
    var c = findComp(a.comp), layers = [], i;
    for (i = 1; i <= c.numLayers; i++) layers.push(layerBrief(c.layer(i)));
    return { name: c.name, id: c.id, width: c.width, height: c.height, duration: c.duration, frameRate: c.frameRate, pixelAspect: c.pixelAspect,
      bgColor: c.bgColor, time: c.time, workAreaStart: c.workAreaStart, workAreaDuration: c.workAreaDuration, numLayers: c.numLayers, layers: layers };
  };

  A.inspect = function (a) {
    var c = findComp(a.comp), l = findLayer(c, a.layer), p = a.path ? getProp(l, a.path) : l;
    var d = describe(p, a.depth === undefined ? 2 : a.depth);
    d.layer = layerBrief(l);
    return d;
  };

  A.createComp = function (a) {
    var c = app.project.items.addComp(a.name || 'Comp', a.width || 1920, a.height || 1080, a.pixelAspect || 1, a.duration || 10, a.frameRate || 30);
    if (a.backgroundColor) c.bgColor = col(a.backgroundColor);
    try { c.openInViewer(); } catch (e) {}
    return { name: c.name, id: c.id, width: c.width, height: c.height, duration: c.duration, frameRate: c.frameRate };
  };

  A.addLayer = function (a) {
    var c = findComp(a.comp), t = a.type, l, nm = a.name, w = a.width || c.width, h = a.height || c.height, dur = a.duration, center = [c.width / 2, c.height / 2];
    if (t === 'text') {
      l = c.layers.addText(a.text || 'Text');
      var sp = l.property('ADBE Text Properties').property('ADBE Text Document'), td = sp.value;
      if (a.fontSize) td.fontSize = a.fontSize;
      if (a.font) td.font = a.font;
      if (a.color) { td.applyFill = true; td.fillColor = col(a.color); }
      td.justification = ParagraphJustification.CENTER_JUSTIFY;
      sp.setValue(td);
    } else if (t === 'solid' || t === 'adjustment') {
      l = c.layers.addSolid(col(a.color || [0.5, 0.5, 0.5]), nm || (t === 'solid' ? 'Solid' : 'Adjustment Layer'), w, h, 1, c.duration);
      if (t === 'adjustment') l.adjustmentLayer = true;
    } else if (t === 'null') {
      l = c.layers.addNull(c.duration);
    } else if (t === 'camera') {
      l = c.layers.addCamera(nm || 'Camera', center);
    } else if (t === 'light') {
      l = c.layers.addLight(nm || 'Light', center);
    } else if (t === 'shape') {
      l = c.layers.addShape();
      var g = l.property('ADBE Root Vectors Group').addProperty('ADBE Vector Group'), gc = g.property('ADBE Vectors Group'), sz = a.size || [200, 200], sh = a.shape || 'rectangle', sp2;
      if (sh === 'ellipse') { sp2 = gc.addProperty('ADBE Vector Shape - Ellipse'); sp2.property('ADBE Vector Ellipse Size').setValue(sz); }
      else if (sh === 'star' || sh === 'polygon') {
        sp2 = gc.addProperty('ADBE Vector Shape - Star');
        sp2.property('ADBE Vector Star Type').setValue(sh === 'star' ? 1 : 2); // 1 = star, 2 = polygon
        sp2.property('ADBE Vector Star Points').setValue(a.points || 5);
        sp2.property('ADBE Vector Star Outer Radius').setValue(sz[0] / 2);
        if (sh === 'star') sp2.property('ADBE Vector Star Inner Radius').setValue(sz[0] / 4);
      } else { sp2 = gc.addProperty('ADBE Vector Shape - Rect'); sp2.property('ADBE Vector Rect Size').setValue(sz); }
      if (a.fill !== false) { var f = gc.addProperty('ADBE Vector Graphic - Fill'); f.property('ADBE Vector Fill Color').setValue(col(a.fill || [1, 0.3, 0.4])); }
      if (a.stroke) { var s = gc.addProperty('ADBE Vector Graphic - Stroke'); s.property('ADBE Vector Stroke Color').setValue(col(a.stroke)); s.property('ADBE Vector Stroke Width').setValue(a.strokeWidth || 4); }
    } else if (t === 'footage') {
      var io = new ImportOptions(new File(a.file)); l = c.layers.add(app.project.importFile(io));
    } else if (t === 'comp') {
      l = c.layers.add(findComp(a.source));
    } else throw new Error('Unknown layer type: ' + t);
    if (nm) l.name = nm;
    if (a.threeD !== undefined && l.canSetThreeD !== false) { try { l.threeDLayer = !!a.threeD; } catch (e) {} }
    if (a.position) l.property('ADBE Transform Group').property('ADBE Position').setValue(a.position);
    if (a.startTime !== undefined) l.startTime = a.startTime;
    if (dur) l.outPoint = l.inPoint + dur;
    return layerBrief(l);
  };

  A.setProperty = function (a) {
    var c = findComp(a.comp), l = findLayer(c, a.layer), p = getProp(l, a.path);
    setVal(p, a.value, a.time);
    var out = null; try { out = p.value; } catch (e) {}
    return { path: a.path, value: out, numKeys: p.numKeys };
  };

  A.setKeyframes = function (a) {
    var c = findComp(a.comp), l = findLayer(c, a.layer), p = getProp(l, a.path), i, k, idx;
    if (!p.canVaryOverTime) throw new Error('Property cannot be keyframed: ' + a.path);
    if (a.clear) { while (p.numKeys > 0) p.removeKey(1); }
    for (i = 0; i < a.keys.length; i++) {
      k = a.keys[i];
      p.setValueAtTime(k.time, toValue(p, k.value));
      idx = p.nearestKeyIndex(k.time);
      applyEase(p, idx, k.easing);
    }
    return { path: a.path, numKeys: p.numKeys };
  };

  A.setExpression = function (a) {
    var c = findComp(a.comp), l = findLayer(c, a.layer), p = getProp(l, a.path);
    if (!p.canSetExpression) throw new Error('Property does not support expressions: ' + a.path);
    p.expression = a.expression || '';
    var err = ''; try { err = p.expressionError; } catch (e) {}
    return { path: a.path, expressionSet: !!a.expression, expressionError: err || null };
  };

  A.addEffect = function (a) {
    var c = findComp(a.comp), l = findLayer(c, a.layer), fx = l.property('ADBE Effect Parade').addProperty(a.effect), k, params = [], i, warnings = [];
    if (a.settings) {
      for (k in a.settings) {
        if (!a.settings.hasOwnProperty(k)) continue;
        try { setVal(fx.property(k), a.settings[k]); } catch (e) { warnings.push(k + ': ' + e.toString()); }
      }
    }
    for (i = 1; i <= fx.numProperties; i++) params.push({ name: fx.property(i).name, matchName: fx.property(i).matchName });
    return { effect: fx.name, matchName: fx.matchName, index: fx.propertyIndex, params: params, warnings: warnings };
  };

  A.layerOp = function (a) {
    var c = findComp(a.comp), l = findLayer(c, a.layer), v = a.value, op = a.op, nl;
    if (op === 'delete') { var nm = l.name; l.remove(); return { deleted: nm }; }
    if (op === 'duplicate') { nl = l.duplicate(); if (v) nl.name = v; return layerBrief(nl); }
    if (op === 'rename') l.name = v;
    else if (op === 'parent') l.parent = (v === null || v === undefined) ? null : findLayer(c, v);
    else if (op === 'moveTo') { if (v <= 1) l.moveToBeginning(); else if (v >= c.numLayers) l.moveToEnd(); else l.moveBefore(c.layer(v)); }
    else if (op === 'solo') l.solo = (v !== false);
    else if (op === 'lock') l.locked = (v !== false);
    else if (op === 'shy') l.shy = (v !== false);
    else if (op === 'enable') l.enabled = (v !== false);
    else throw new Error('Unknown layer op: ' + op);
    return layerBrief(l);
  };

  A.menuCommand = function (a) {
    var id = a.id;
    if (!id && a.name) id = app.findMenuCommandId(a.name);
    if (!id) throw new Error('Menu command not found: ' + (a.name || a.id) + ' (name must match the English menu text exactly)');
    app.executeCommand(id);
    return { executed: id, name: a.name || null };
  };

  A.importFiles = function (a) {
    var out = [], i, io, item, c = a.comp !== undefined && a.comp !== null ? findComp(a.comp) : null;
    for (i = 0; i < a.paths.length; i++) {
      io = new ImportOptions(new File(a.paths[i])); item = app.project.importFile(io);
      out.push({ id: item.id, name: item.name });
      if (c) c.layers.add(item);
    }
    return { imported: out };
  };

  A.render = function (a) {
    var c = findComp(a.comp), rq = app.project.renderQueue, item = rq.items.add(c), om = item.outputModule(1);
    if (a.renderSettings) item.applyTemplate(a.renderSettings);
    if (a.outputTemplate) om.applyTemplate(a.outputTemplate);
    om.file = new File(a.outputPath);
    var info = { queued: c.name, output: om.file.fsName, outputTemplates: om.templates, started: false };
    if (a.start) { rq.render(); info.started = true; }
    return info;
  };

  A.helpers = { findComp: findComp, findLayer: findLayer, getProp: getProp, toValue: toValue, setVal: setVal, col: col, describe: describe, layerBrief: layerBrief };

  // ---------- entry point used by the panel ----------
  A.run = function (payload) {
    var m, out, started = false, r;
    try { m = eval('(' + payload + ')'); } catch (e0) { return '{"ok":false,"error":"Bad payload from panel"}'; }
    try {
      app.beginUndoGroup(m.undoName || ('MCP: ' + (m.fn || 'script'))); started = true;
      if (m.op === 'call') {
        if (m.fn === 'run' || m.fn === 'helpers' || typeof A[m.fn] !== 'function') throw new Error('Unknown host function: ' + m.fn);
        r = A[m.fn](m.args || {});
      } else if (m.op === 'exec') {
        r = eval('(function(){\n' + m.code + '\n})()');
      } else throw new Error('Unknown op: ' + m.op);
      out = '{"ok":true,"result":' + ser(r === undefined ? null : r) + '}';
    } catch (e) {
      out = '{"ok":false,"error":' + esc(e.toString()) + ',"line":' + (e.line || 0) + '}';
    }
    if (started) { try { app.endUndoGroup(); } catch (e2) {} }
    return out;
  };

  A._ser = ser;
  return A;
})();
