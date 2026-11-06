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
    var info = { queued: c.name, output: om.file.fsName, started: false };
    if (a.start) { rq.render(); info.started = true; }
    return info;
  };

  // ---------- html2ae: build real layers + keyframes from a converted spec ----------
  // property() returns NULL (it does not throw) when a matchName is unknown — calling
  // .setValue() on that null is the classic "TypeError: null is not an object".
  // getP/setP try several matchNames + an index fallback and never dereference null.
  function getP(parent, names, idxFallback) {
    if (!parent) return null;
    var i, p = null;
    for (i = 0; i < names.length; i++) { try { p = parent.property(names[i]); } catch (eP) { p = null; } if (p) return p; }
    if (idxFallback) { try { if (parent.numProperties >= idxFallback) p = parent.property(idxFallback); } catch (eI) { p = null; } }
    return p || null;
  }
  function setP(parent, names, v, idxFallback) {
    if (v === undefined || v === null) return false;
    var p = getP(parent, names, idxFallback);
    if (!p) return false;
    try { p.setValue(v); return true; } catch (eS) { return false; }
  }
  function tryParam(fx, names, idxFallback) {
    var i;
    for (i = 0; i < names.length; i++) { var p = fx.property(names[i]); if (p) return p; }
    try { if (idxFallback && fx.numProperties >= idxFallback) return fx.property(idxFallback); } catch (e0) {}
    return null;
  }
  function addEffectByName(layer, names) {
    var ep = layer.property('ADBE Effect Parade'), i, fx;
    for (i = 0; i < names.length; i++) { try { fx = ep.addProperty(names[i]); if (fx) return fx; } catch (e1) {} }
    return null;
  }
  function findShapeProp(group, matchName, depth) {
    var i, p, found;
    if (depth <= 0) return null;
    for (i = 1; i <= group.numProperties; i++) {
      p = group.property(i);
      if (p.matchName === matchName) return p;
      if (p.propertyType === PropertyType.INDEXED_GROUP || p.propertyType === PropertyType.GROUP) {
        found = findShapeProp(p, matchName, depth - 1);
        if (found) return found;
      }
    }
    return null;
  }
  function easeHost(prop, idx, kf) {
    if (!kf || kf.interp === 'LINEAR') return;
    if (kf.interp === 'HOLD') { prop.setInterpolationTypeAtKey(idx, KeyframeInterpolationType.HOLD, KeyframeInterpolationType.HOLD); return; }
    prop.setInterpolationTypeAtKey(idx, KeyframeInterpolationType.BEZIER, KeyframeInterpolationType.BEZIER);
    var n = dims(prop), infIn = (kf.infIn === undefined) ? 33.33 : kf.infIn, infOut = (kf.infOut === undefined) ? 33.33 : kf.infOut;
    try { prop.setTemporalEaseAtKey(idx, easeArr(n, 0, infIn), easeArr(n, 0, infOut)); } catch (eE) {}
  }
  function applyKeys(prop, keys) {
    if (!keys || !keys.length || !prop) return 0;
    var i, made = 0;
    for (i = 0; i < keys.length; i++) { prop.setValueAtTime(keys[i].t, toValue(prop, keys[i].v)); made++; }
    var nInterp = Math.min(prop.numKeys, keys.length);
    for (i = 0; i < nInterp; i++) { try { easeHost(prop, i + 1, keys[i]); } catch (eI) {} }
    return made;
  }
  function colorTargetFor(layer, s) {
    // where do FillColor keyframes live for this layer kind?
    if (s.kind === 'shape') {
      var f = findShapeProp(layer.property('ADBE Root Vectors Group'), 'ADBE Vector Fill Color', 6);
      if (f) return f;
    }
    var fx = addEffectByName(layer, ['Fill', 'ADBE Fill']);
    if (fx) {
      var cp = tryParam(fx, ['Color'], 3);
      if (cp) { try { cp.setValue(s.fillOverride || s.color || [1, 1, 1]); } catch (eC) {} return cp; }
    }
    return null;
  }
  function applyShadow(layer, sh) {
    if (!sh) return null;
    var fx = addEffectByName(layer, ['Drop Shadow', 'ADBE Drop Shadow']);
    if (!fx) return null;
    var pairs = [['Shadow Color', 1, sh.color], ['Opacity', 2, sh.opacity], ['Direction', 3, sh.direction], ['Distance', 4, sh.distance], ['Softness', 5, sh.softness]];
    for (var i = 0; i < pairs.length; i++) { var p = tryParam(fx, [pairs[i][0]], pairs[i][1]); if (p) { try { p.setValue(pairs[i][2]); } catch (eS) {} } }
    return fx.name;
  }
  function applyGradient(layer, s) {
    if (!s.gradient) return null;
    var fx = addEffectByName(layer, ['Ramp', 'ADBE Ramp']);
    if (!fx) return null;
    // AE effect colors are RGBA: pass the CSS stop alphas straight through so radial
    // glows fade to transparent for real. Flattening semi-transparent stops over the
    // comp background turned every glow into a SOLID disc (the alpha was lost) and
    // broke glows that overlap other layers.
    var g = s.gradient;
    var c1 = [g.c1[0], g.c1[1], g.c1[2], (g.a1 === undefined) ? 1 : g.a1];
    var c2 = [g.c2[0], g.c2[1], g.c2[2], (g.a2 === undefined) ? 1 : g.a2];
    var pairs = [['Start of Ramp', 1, g.start], ['End of Ramp', 2, g.end],
      ['Start Color', 3, c1], ['End Color', 4, c2],
      ['Ramp Shape', 5, g.radial ? 2 : 1]]; // 1 = linear, 2 = radial
    for (var i = 0; i < pairs.length; i++) { var p = tryParam(fx, [pairs[i][0]], pairs[i][1]); if (p) { try { p.setValue(pairs[i][2]); } catch (eG) {} } }
    return fx.name;
  }

  A.buildLayers = function (a) {
    var out = { comp: null, layers: [], keyframes: 0, effects: [], warnings: [] }, i, j, comp, specs = a.layers || [];
    var tw = a.width || 1920, th = a.height || 1080;
    if (a.createComp) {
      comp = app.project.items.addComp(a.compName || 'HTML Motion', tw, th, 1, a.duration || 10, a.frameRate || 30);
      if (a.bgColor) comp.bgColor = a.bgColor;
      try { comp.openInViewer(); } catch (e0) {}
    } else {
      // Target resolution order: explicit comp ref -> comp name -> active comp.
      // If the target is missing OR its size differs from the HTML stage, CREATE a
      // matching comp instead: layer positions are comp-center relative, so converting
      // into a differently sized comp silently misaligns the whole design.
      var refs = [a.comp, a.compName], ri;
      for (ri = 0; ri < refs.length && !comp; ri++) {
        if (refs[ri] !== undefined && refs[ri] !== null && refs[ri] !== '') { try { comp = findComp(refs[ri]); } catch (eR) { comp = null; } }
      }
      if (!(comp instanceof CompItem)) { try { comp = app.project.activeItem; } catch (eA) { comp = null; } }
      var oldName = (comp instanceof CompItem) ? comp.name : null;
      if (!(comp instanceof CompItem) || comp.width !== tw || comp.height !== th) {
        var nm = ((a.compName || 'HTML Motion') + ' ' + tw + 'x' + th);
        comp = app.project.items.addComp(nm, tw, th, 1, a.duration || 10, a.frameRate || 30);
        if (a.bgColor) comp.bgColor = a.bgColor;
        try { comp.openInViewer(); } catch (eC2) {}
        out.warnings.push(oldName
          ? 'Comp "' + oldName + '" is not ' + tw + 'x' + th + ' - created "' + nm + '" so the HTML aligns 1:1'
          : 'No target comp open - created "' + nm + '"');
      }
      if (a.clearComp) { while (comp.numLayers > 0) comp.layer(1).remove(); }
    }
    out.comp = comp.name;
    // html2ae layer specs use CONVERTER coordinates: origin at the comp center, y grows UP
    // (pos = [x - W/2, H/2 - y]). AE Position/points use comp TOP-LEFT origin, y grows DOWN.
    // The specs used to be applied raw, which shifted the whole design by (-W/2, +H/2-ish) and
    // mirrored it vertically — the dashboard/panel previews converted, real AE did not.
    var W2 = tw / 2, H2 = th / 2;
    function toAePos(p) { return [W2 + p[0], H2 - p[1]]; }
    for (i = 0; i < specs.length; i++) {
      var s = specs[i], layer = null;
      try {
        if (s.kind === 'text') {
          layer = comp.layers.addText(s.text || ' ');
          var tdP = layer.property('ADBE Text Properties').property('ADBE Text Document'), td = tdP.value;
          if (s.fontSize) td.fontSize = s.fontSize;
          if (s.font) { try { td.font = s.font; } catch (eF) { try { td.font = String(s.font).replace(/ Bold$/, ''); } catch (eF2) {} } }
          if (s.color) { td.applyFill = true; td.fillColor = s.color; }
          if (s.tracking) { try { td.tracking = s.tracking; } catch (eT) {} }
          if (s.leading) { try { td.leading = s.leading; } catch (eL) {} }
          td.justification = s.justification === 'center' ? ParagraphJustification.CENTER_JUSTIFY : (s.justification === 'right' ? ParagraphJustification.RIGHT_JUSTIFY : ParagraphJustification.LEFT_JUSTIFY);
          tdP.setValue(td);
        } else if (s.kind === 'solid') {
          layer = comp.layers.addSolid(s.color || [0.5, 0.5, 0.5], s.name || 'Solid', Math.max(s.w, 1), Math.max(s.h, 1), 1);
        } else if (s.kind === 'shape') {
          layer = comp.layers.addShape();
          var grp = layer.property('ADBE Root Vectors Group').addProperty('ADBE Vector Group'), gc = grp.property('ADBE Vectors Group'), shp;
          if (s.shape === 'ellipse') {
            shp = gc.addProperty('ADBE Vector Shape - Ellipse');
            setP(shp, ['ADBE Vector Ellipse Size'], [Math.max(s.w, 1), Math.max(s.h, 1)]);
          } else if (s.shape === 'path' && s.path && s.path.verts && s.path.verts.length >= 2) {
            shp = gc.addProperty('ADBE Vector Shape - Group');
            var aeShape = new Shape();
            aeShape.vertices = s.path.verts;
            aeShape.inTangents = s.path.inT || s.path.verts.map(function () { return [0, 0]; });
            aeShape.outTangents = s.path.outT || s.path.verts.map(function () { return [0, 0]; });
            aeShape.closed = !!s.path.closed;
            // The Bezier path property is "ADBE Vector Shape" (AE Scripting Guide). Older builds
            // also answer to "ADBE Vector Shape Data"; index 1 as a last resort. Without the
            // fallbacks a wrong name yields null -> "TypeError: null is not an object".
            var pathSet = setP(shp, ['ADBE Vector Shape', 'ADBE Vector Shape Data'], aeShape, 1);
            if (!pathSet) { // last resort: same bounding box as a rect so the layer still shows
              shp = gc.addProperty('ADBE Vector Shape - Rect');
              setP(shp, ['ADBE Vector Rect Size'], [Math.max(s.w, 1), Math.max(s.h, 1)]);
              out.warnings.push(s.name + ': path not supported by this AE version - used rect instead');
            }
          } else {
            shp = gc.addProperty('ADBE Vector Shape - Rect');
            setP(shp, ['ADBE Vector Rect Size'], [Math.max(s.w, 1), Math.max(s.h, 1)]);
            if (s.roundness) setP(shp, ['ADBE Vector Rect Roundness'], s.roundness);
          }
          if (s.fill) { var fp = gc.addProperty('ADBE Vector Graphic - Fill'); setP(fp, ['ADBE Vector Fill Color'], s.fill); }
          if (s.stroke && s.strokeWidth) {
            var sp = gc.addProperty('ADBE Vector Graphic - Stroke');
            setP(sp, ['ADBE Vector Stroke Color'], s.stroke);
            setP(sp, ['ADBE Vector Stroke Width'], s.strokeWidth);
          }
        } else if (s.kind === 'footage') {
          if (!s.file) throw new Error('img has no resolvable src (relative paths need the HTML file location)');
          var io = new ImportOptions(new File(s.file)), item = app.project.importFile(io);
          layer = comp.layers.add(item);
          if (item.width && s.w && s.h) { layer.property('ADBE Transform Group').property('ADBE Scale').setValue([s.w / item.width * 100, s.h / item.height * 100]); }
        } else throw new Error('Unknown layer kind: ' + s.kind);

        if (s.name) layer.name = s.name;
        var tr = layer.property('ADBE Transform Group');
        // anchor: solids center their source; text centers on its measured box; shapes are already centered
        if (s.kind === 'solid') {
          var ap = s.anchor ? s.anchor : [s.w / 2, s.h / 2];
          try { tr.property('ADBE Anchor Point').setValue([ap[0], ap[1], 0]); } catch (eA) {}
        }
        if (s.kind === 'shape' && s.anchor) {
          try { tr.property('ADBE Anchor Point').setValue([s.anchor[0], s.anchor[1], 0]); } catch (eAn) {}
        }
        if (s.kind === 'text') {
          try {
            var sr = layer.sourceRectAtTime(comp.time, false);
            if (sr.width > 0) {
              // anchor the edge that pos.x refers to (html2ae sends left/center/right)
              var ax = sr.left + sr.width / 2;
              if (s.anchorX === 'left') ax = sr.left;
              else if (s.anchorX === 'right') ax = sr.left + sr.width;
              var ay = sr.top + sr.height / 2;
              if (s.anchorOffset) { ax += s.anchorOffset[0]; ay += s.anchorOffset[1]; } // transform-origin pivot
              tr.property('ADBE Anchor Point').setValue([ax, ay, 0]);
            }
          } catch (eR) {}
        }
        tr.property('ADBE Position').setValue(toAePos(s.pos));
        if (s.scale) tr.property('ADBE Scale').setValue([s.scale[0], s.scale[1], 100]);
        if (s.rotation) tr.property('ADBE Rotation').setValue(s.rotation);
        if (s.opacity !== undefined) tr.property('ADBE Opacity').setValue(s.opacity); // layer opacity for every kind (incl. shapes)
        // HyperFrames-compatible trim: data-start / data-duration -> layer in/out points
        if (s.startTime !== undefined && s.startTime !== null) { try { layer.startTime = s.startTime; } catch (eST) {} }
        if (s.duration && s.duration > 0) { try { layer.outPoint = (s.startTime || 0) + s.duration; } catch (eOP) {} }
        // effects
        var fxName;
        if (s.gradient) { fxName = applyGradient(layer, s); if (fxName) out.effects.push(s.name + ': ' + fxName); }
        if (s.shadow) { fxName = applyShadow(layer, s.shadow); if (fxName) out.effects.push(s.name + ': ' + fxName); }
        // keyframes (Position keys arrive in converter coords too — convert each value)
        if (s.keys) {
          if (s.keys.Position && s.keys.Position.length) {
            var convKeys = [], ci2, kv;
            for (ci2 = 0; ci2 < s.keys.Position.length; ci2++) {
              kv = s.keys.Position[ci2];
              var nk = {}, gk;
              for (gk in kv) { if (kv.hasOwnProperty(gk)) nk[gk] = kv[gk]; }
              nk.v = toAePos(kv.v);
              convKeys.push(nk);
            }
            s.keys.Position = convKeys;
          }
          var kmap = { Position: tr.property('ADBE Position'), Scale: tr.property('ADBE Scale'), Rotation: tr.property('ADBE Rotation'), Opacity: tr.property('ADBE Opacity') };
          if (s.keys.FillColor) {
            var ct = colorTargetFor(layer, s);
            if (ct) kmap.FillColor = ct; else out.warnings.push(s.name + ': color keyframes unsupported on this layer');
          }
          if (s.keys.RectSize && s.kind === 'shape') {
            // Rect/Ellipse Size lives nested inside the shape group -> recursive search
            var rs = findShapeProp(layer.property('ADBE Root Vectors Group'), s.shape === 'ellipse' ? 'ADBE Vector Ellipse Size' : 'ADBE Vector Rect Size', 6);
            if (rs) kmap.RectSize = rs;
          }
          if (s.keys.TrimEnd) {
            try {
              var trimFx = grp.property('ADBE Vectors Group').addProperty('ADBE Vector Filter - Trim');
              kmap.TrimEnd = getP(trimFx, ['ADBE Vector Trim End', 'End'], 2);
            } catch (eTR) {}
            if (!kmap.TrimEnd) out.warnings.push(s.name + ': Trim Paths unavailable');
          }
          for (var kn in kmap) { if (!kmap.hasOwnProperty(kn)) continue; try { out.keyframes += applyKeys(kmap[kn], s.keys[kn]); } catch (eK) { out.warnings.push(s.name + ' ' + kn + ': ' + eK.toString()); } }
        }
        out.layers.push({ name: layer.name, index: layer.index, kind: s.kind });
      } catch (e) {
        out.warnings.push((s.name || 'layer ' + i) + ': ' + e.toString());
      }
    }
    return out;
  };

  // ---------- viewport: compact snapshot for the dashboard/panel preview ----------
  function shapeFillColor(layer) {
    try {
      var p = findShapeProp(layer.property('ADBE Root Vectors Group'), 'ADBE Vector Fill Color', 6);
      if (p) return p.value;
    } catch (e0) {}
    return null;
  }
  // playback guard state: survives between evalScript calls (AEX is created once per engine)
  A._vpTime = null;
  A._vpComp = null;
  A.viewport = function (a) {
    var comp;
    if (a && a.comp !== undefined && a.comp !== null) {
      comp = findComp(a.comp); // explicit ref: a wrong name is a real error
    } else {
      try { comp = app.project.activeItem; } catch (eA) { comp = null; }
      if (!(comp instanceof CompItem)) {
        // polled continuously by the panel/dashboard: report the state instead of
        // throwing, so an empty desktop does not flood every log with errors
        return { empty: true, reason: 'no-active-comp' };
      }
    }
    // DYNAMIC polling: while AE is PLAYING, comp.time advances between polls. A full
    // snapshot (sourceRectAtTime on every layer) steals the main thread from playback
    // and made AE unresponsive — during playback return a cheap header-only snapshot;
    // a full layer scan happens on the next poll once the playhead is static again.
    var tNow = comp.time;
    var dT = (A._vpComp === comp.name && A._vpTime !== null) ? Math.abs(tNow - A._vpTime) : -1;
    var playing = dT > 0.0005 && dT < 5; // tiny advance = playing; a big jump = user scrub
    A._vpTime = tNow;
    A._vpComp = comp.name;
    if (playing && comp.numLayers > 0) {
      return { name: comp.name, id: comp.id, width: comp.width, height: comp.height, duration: comp.duration, frameRate: comp.frameRate, time: tNow, bgColor: comp.bgColor, numLayers: comp.numLayers, playing: true, layers: [] };
    }
    var out = { name: comp.name, id: comp.id, width: comp.width, height: comp.height, duration: comp.duration, frameRate: comp.frameRate, time: tNow, bgColor: comp.bgColor, numLayers: comp.numLayers, layers: [] };
    var n = Math.min(comp.numLayers, 80);
    for (var i = 1; i <= n; i++) {
      var l = comp.layer(i), o = { index: l.index, name: l.name, type: layerType(l), enabled: l.enabled };
      try { o.threeD = l.threeDLayer; } catch (eT) {}
      var tr = l.property('ADBE Transform Group');
      // export Position in CONVERTER coordinates (center origin, y-up) so the panel and
      // dashboard previews — which expect that convention — draw the comp correctly
      try { var pv = tr.property('ADBE Position').value; o.pos = [pv[0] - comp.width / 2, comp.height / 2 - pv[1]]; } catch (e1) {}
      try { var av = tr.property('ADBE Anchor Point').value; o.anchor = [av[0], av[1]]; } catch (e2) {}
      try { var sv = tr.property('ADBE Scale').value; o.scale = [sv[0], sv[1]]; } catch (e3) {}
      try { o.rotation = tr.property('ADBE Rotation').value; } catch (e4) {}
      try { o.opacity = tr.property('ADBE Opacity').value; } catch (e5) {}
      try {
        if (o.type === 'solid' || o.type === 'footage' || o.type === 'precomp') { o.w = l.width; o.h = l.height; }
        else { var sr = l.sourceRectAtTime(comp.time, false); o.left = sr.left; o.top = sr.top; o.w = sr.width; o.h = sr.height; }
      } catch (e6) { o.w = 0; o.h = 0; }
      try { if (o.type === 'solid') o.color = l.source.mainSource.color; } catch (e7) {}
      try {
        // export the Ramp effect (gradients) so the dashboard/panel previews can draw it
        var parade = l.property('ADBE Effect Parade');
        for (var fxi = 1; fxi <= parade.numProperties; fxi++) {
          var ef = parade.property(fxi);
          if (ef.matchName === 'ADBE Ramp') {
            o.gradient = { start: ef.property(1).value, end: ef.property(2).value, c1: ef.property(3).value, c2: ef.property(4).value, radial: ef.property(5).value === 2 };
            break;
          }
        }
      } catch (eGr) {}
      try {
        if (o.type === 'text') {
          var td = l.property('ADBE Text Properties').property('ADBE Text Document').value;
          o.text = td.text; o.fontSize = td.fontSize; o.font = td.font; o.color = td.fillColor;
        }
      } catch (e8) {}
      try { if (o.type === 'shape') o.color = shapeFillColor(l); } catch (e9) {}
      try { if (o.type === 'shape') o.ellipse = !!findShapeProp(l.property('ADBE Root Vectors Group'), 'ADBE Vector Shape - Ellipse', 6); } catch (e10) {}
      out.layers.push(o);
    }
    return out;
  };

  A.setTime = function (a) {
    var comp = (a.comp !== undefined && a.comp !== null) ? findComp(a.comp) : app.project.activeItem;
    if (!(comp instanceof CompItem)) throw new Error('No active composition. Open a comp or pass "comp".');
    var t = a.time || 0;
    if (t < 0) t = 0;
    if (t > comp.duration) t = comp.duration;
    comp.time = t;
    return { time: comp.time, comp: comp.name };
  };

  A.daemonToken = function () {
    var paths = [];
    try { if (Folder.home) paths.push(Folder.home.fsName + '/.ae-supreme-mcp/daemon-token'); } catch (eH) {}
    try { var hp = $.getenv('HOME'); if (hp) paths.push(hp + '/.ae-supreme-mcp/daemon-token'); } catch (eH2) {}
    try { var up = $.getenv('USERPROFILE'); if (up) paths.push(up + '\\.ae-supreme-mcp\\daemon-token'); } catch (eH3) {}
    for (var i = 0; i < paths.length; i++) {
      try {
        var f = new File(paths[i]);
        if (f.exists) { f.encoding = 'UTF-8'; f.open('r'); var t = f.read(); f.close(); t = t.replace(/^\s+|\s+$/g, ''); if (t) return t; }
      } catch (eF) {}
    }
    return null;
  };

  A.helpers = { findComp: findComp, findLayer: findLayer, getProp: getProp, toValue: toValue, setVal: setVal, col: col, describe: describe, layerBrief: layerBrief };

  // ---------- entry point used by the panel ----------
  // Read-only functions must NOT open an undo group: the panel/dashboard poll them
  // every second, and undo-group churn on AE's main thread makes playback stutter
  // and the UI unresponsive.
  var READ_ONLY = { viewport: 1, ping: 1, daemonToken: 1, project: 1, comp: 1, inspect: 1, helpers: 1 };
  A.run = function (payload) {
    var m, out, started = false, r;
    try { m = eval('(' + payload + ')'); } catch (e0) { return '{"ok":false,"error":"Bad payload from panel"}'; }
    try {
      if (m.op === 'call') {
        if (m.fn === 'run' || m.fn === 'helpers' || typeof A[m.fn] !== 'function') throw new Error('Unknown host function: ' + m.fn);
        if (!READ_ONLY[m.fn]) { app.beginUndoGroup(m.undoName || ('MCP: ' + (m.fn || 'script'))); started = true; }
        r = A[m.fn](m.args || {});
      } else if (m.op === 'exec') {
        app.beginUndoGroup(m.undoName || 'MCP: script'); started = true;
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
