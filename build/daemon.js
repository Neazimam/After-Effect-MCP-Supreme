var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/html2ae.ts
var html2ae_exports = {};
__export(html2ae_exports, {
  computeStyles: () => computeStyles,
  convertHtmlToLayers: () => convertHtmlToLayers,
  layoutTree: () => layoutTree,
  parseCSS: () => parseCSS,
  parseColor: () => parseColor,
  parseHTML: () => parseHTML,
  parsePathData: () => parsePathData
});
function decodeEntities(s) {
  return s.replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10))).replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/&copy;/g, "\xA9").replace(/&mdash;/g, "\u2014").replace(/&ndash;/g, "\u2013");
}
function parseHTML(html) {
  const root = { tag: "#root", attrs: {}, children: [], parent: null, order: 0 };
  let cur = root, order = 1, i = 0;
  const n = html.length;
  const push = (node) => {
    node.parent = cur;
    node.order = order++;
    cur.children.push(node);
  };
  while (i < n) {
    if (html.startsWith("<!--", i)) {
      const e = html.indexOf("-->", i);
      i = e === -1 ? n : e + 3;
      continue;
    }
    if (html[i] === "<") {
      if (html[i + 1] === "!") {
        const e = html.indexOf(">", i);
        i = e === -1 ? n : e + 1;
        continue;
      }
      if (html[i + 1] === "/") {
        const e = html.indexOf(">", i);
        const tag2 = html.slice(i + 2, e === -1 ? n : e).trim().toLowerCase();
        let p = cur;
        while (p && p.tag !== tag2 && p.tag !== "#root") p = p.parent;
        if (p && p.parent) cur = p.parent;
        i = e === -1 ? n : e + 1;
        continue;
      }
      const gt = html.indexOf(">", i);
      if (gt === -1) break;
      let tagBody = html.slice(i + 1, gt);
      const selfClosed = tagBody.endsWith("/");
      if (selfClosed) tagBody = tagBody.slice(0, -1);
      const m = tagBody.match(/^[a-zA-Z][a-zA-Z0-9-]*/);
      const tag = m ? m[0].toLowerCase() : "span";
      const node = { tag, attrs: {}, children: [], parent: null, order: 0 };
      let rest = tagBody.slice(tag.length);
      const attrRe = /([:@a-zA-Z_][-\w:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+))|([a-zA-Z_][-\w:.]*)/g;
      let am;
      while (am = attrRe.exec(rest)) {
        if (am[1] !== void 0) node.attrs[am[1].toLowerCase()] = decodeEntities(am[3] ?? am[4] ?? am[5] ?? "");
        else node.attrs[am[6].toLowerCase()] = "";
      }
      push(node);
      i = gt + 1;
      if (RAW.has(tag)) {
        const closeIdx = html.toLowerCase().indexOf("</" + tag, i);
        const raw = html.slice(i, closeIdx === -1 ? n : closeIdx);
        if (tag === "style") node.text = raw;
        if (closeIdx !== -1) {
          const e2 = html.indexOf(">", closeIdx);
          i = e2 === -1 ? n : e2 + 1;
        } else i = n;
        continue;
      }
      if (!selfClosed && !VOID.has(tag)) cur = node;
      continue;
    }
    const next = html.indexOf("<", i);
    const text = html.slice(i, next === -1 ? n : next);
    if (text.trim()) push({ tag: "#text", attrs: {}, children: [], parent: null, order: 0, text: decodeEntities(text) });
    i = next === -1 ? n : next;
  }
  return root;
}
function evalMediaCondition(cond, vw, vh) {
  const parts = cond.toLowerCase().split(/\band\b/).map((s) => s.trim()).filter(Boolean);
  for (const p of parts) {
    if (!p.startsWith("(")) {
      if (/screen|all|\*/.test(p)) continue;
      return false;
    }
    const m = p.match(/\(\s*(min|max)-(width|height)\s*:\s*([\d.]+)(px|em|rem)?\s*\)/);
    if (!m) continue;
    const val = parseFloat(m[3]) * (m[4] === "em" || m[4] === "rem" ? 16 : 1);
    const ref = m[2] === "width" ? vw : vh;
    if (m[1] === "min" && ref < val) return false;
    if (m[1] === "max" && ref > val) return false;
  }
  return true;
}
function stripCssComments(cssText) {
  let out = "";
  let i = 0;
  const n = cssText.length;
  let inStr = null;
  while (i < n) {
    const ch = cssText[i];
    if (inStr) {
      out += ch;
      if (ch === "\\" && i + 1 < n) {
        out += cssText[i + 1];
        i += 2;
        continue;
      }
      if (ch === inStr) inStr = null;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inStr = ch;
      out += ch;
      i++;
      continue;
    }
    if (ch === "/" && cssText[i + 1] === "*") {
      const e = cssText.indexOf("*/", i + 2);
      i = e === -1 ? n : e + 2;
      out += " ";
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}
function parseCSS(rawCssText, vw = 1920, vh = 1080) {
  const cssText = stripCssComments(rawCssText);
  const rules = [];
  const keyframes = [];
  let order = 0;
  let i = 0;
  const n = cssText.length;
  const readBlock = (start) => {
    let depth = 0;
    for (let j = start; j < n; j++) {
      if (cssText[j] === "{") depth++;
      else if (cssText[j] === "}") {
        depth--;
        if (!depth) return j + 1;
      }
    }
    return n;
  };
  while (i < n) {
    const brace = cssText.indexOf("{", i);
    if (brace === -1) break;
    const head = cssText.slice(i, brace).trim();
    const end = readBlock(brace);
    const body = cssText.slice(brace + 1, end - 1);
    if (head.startsWith("@")) {
      const at = head.slice(1).split(/\s+/)[0].toLowerCase();
      if (at === "keyframes" || at === "-webkit-keyframes") {
        const name = head.replace(/@[-a-z]+\s+/, "").trim();
        const stops = [];
        let j = 0;
        while (j < body.length) {
          const b2 = body.indexOf("{", j);
          if (b2 === -1) break;
          const e2 = readBlock2(body, b2);
          const stopHead = body.slice(j, b2).trim().replace(/,/g, " ");
          const pcts = stopHead.split(/\s+/).map((s) => s === "from" ? 0 : s === "to" ? 100 : parseFloat(s));
          const decls = parseDecls(body.slice(b2 + 1, e2 - 1));
          for (const p of pcts) if (!isNaN(p)) stops.push({ pct: p, decls });
          j = e2;
        }
        stops.sort((a, b) => a.pct - b.pct);
        keyframes.push({ name, stops });
      } else if (at === "media" || at === "supports" || at === "layer") {
        const cond = head.slice(head.indexOf("(")).trim();
        if (at !== "media" || evalMediaCondition(cond, vw, vh)) {
          const inner = parseCSS(body, vw, vh);
          for (const r of inner.rules) rules.push({ ...r, order: order++ });
          for (const k of inner.keyframes) keyframes.push(k);
        }
      }
    } else if (head) {
      for (const sel of splitTop(head, ",")) {
        const s = sel.trim().replace(/\s+/g, " ");
        if (s) rules.push({ selector: s, decls: parseDecls(body), order: order++ });
      }
    }
    i = end;
  }
  return { rules, keyframes };
}
function readBlock2(s, start) {
  let depth = 0;
  for (let j = start; j < s.length; j++) {
    if (s[j] === "{") depth++;
    else if (s[j] === "}") {
      depth--;
      if (!depth) return j + 1;
    }
  }
  return s.length;
}
function parseDecls(rawBody) {
  const body = stripCssComments(rawBody);
  const out = [];
  for (const chunk of splitTop(body, ";")) {
    const c = chunk.trim();
    if (!c) continue;
    const colon = c.indexOf(":");
    if (colon === -1) continue;
    const prop = c.slice(0, colon).trim().toLowerCase();
    let value = c.slice(colon + 1).trim();
    let important = false;
    if (/!\s*important$/i.test(value)) {
      important = true;
      value = value.replace(/!\s*important$/i, "").trim();
    }
    if (prop && value) out.push({ prop, value, important });
  }
  return out;
}
function splitTop(s, sep) {
  const parts = [];
  let depth = 0, cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === sep && depth === 0) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}
function splitPseudos(compound) {
  const pseudos = [];
  let base = compound;
  const re = /:(not|nth-child|nth-of-type|first-child|last-child)\s*(\([^)]*\))?|:(first-child|last-child)/gi;
  let m;
  while (m = re.exec(compound)) {
    const kind = (m[1] || m[4] || "").toLowerCase();
    pseudos.push({ kind, arg: (m[2] || "").replace(/^\(|\)$/g, "").trim() });
  }
  base = compound.replace(/:{1,2}(not|nth-child|nth-of-type|first-child|last-child)\s*(\([^)]*\))?|:{1,2}(first-child|last-child)/gi, "");
  return { base: base.trim(), pseudos };
}
function elementSiblings(el) {
  if (!el.parent) return [el];
  return el.parent.children.filter((c) => c.tag !== "#text" && c.attrs["data-pseudo"] === void 0);
}
function matchAnB(arg, idx, count) {
  const a = arg.trim().toLowerCase();
  if (!a) return true;
  if (a === "odd") return idx % 2 === 1;
  if (a === "even") return idx % 2 === 0;
  const m = a.match(/^([+-]?\d*)n\s*([+-]\s*\d+)?$/) || a.match(/^([+-]?\d+)$/);
  if (!m) return false;
  if (!a.includes("n")) {
    const k = parseInt(a);
    return k === idx;
  }
  const A = m[1] === "" || m[1] === "+" ? 1 : m[1] === "-" ? -1 : parseInt(m[1]);
  const B = m[2] ? parseInt(String(m[2]).replace(/\s+/g, "")) : 0;
  for (let i = 0; i <= count + 1; i++) {
    if (A * i + B === idx) return true;
    if (A > 0 && A * i + B > idx) break;
  }
  return false;
}
function matchesCompound(el, compound) {
  const { base, pseudos } = splitPseudos(compound);
  if (base && base !== "*") {
    let ok = false;
    const re = /([a-zA-Z][\w-]*)|\.([\w-]+)|#([\w-]+)/g;
    let m;
    while (m = re.exec(base)) {
      ok = true;
      if (m[1] !== void 0) {
        if (el.tag !== m[1].toLowerCase()) return false;
      } else if (m[2] !== void 0) {
        const cls = (el.attrs["class"] || "").split(/\s+/);
        if (!cls.includes(m[2])) return false;
      } else if (m[3] !== void 0) {
        if (el.attrs["id"] !== m[3]) return false;
      }
    }
    if (!ok) return false;
  }
  for (const p of pseudos) {
    const sibs = elementSiblings(el);
    const idx = sibs.indexOf(el) + 1;
    const count = sibs.length;
    if (p.kind === "nth-child") {
      if (!matchAnB(p.arg || "1", idx, count)) return false;
    } else if (p.kind === "nth-of-type") {
      const same = sibs.filter((s) => s.tag === el.tag);
      const tidx = same.indexOf(el) + 1;
      if (!matchAnB(p.arg || "1", tidx, same.length)) return false;
    } else if (p.kind === "first-child") {
      if (idx !== 1) return false;
    } else if (p.kind === "last-child") {
      if (idx !== count) return false;
    } else if (p.kind === "not") {
      if (p.arg && matchesCompound(el, p.arg)) return false;
    }
  }
  return true;
}
function matchesSelector(el, selector) {
  const parts = selector.trim().split(/\s+/).filter((s) => s && s !== ">");
  if (parts.length === 1) return matchesCompound(el, parts[0]);
  let node = el;
  for (let p = parts.length - 1; p >= 0; p--) {
    while (node && node.tag !== "#root" && !matchesCompound(node, parts[p])) node = node.parent;
    if (!node || node.tag === "#root") return false;
    node = node.parent;
  }
  return true;
}
function parseColor(v) {
  if (!v) return null;
  let s = v.trim().toLowerCase();
  if (s === "transparent") return [0, 0, 0, 0];
  if (NAMED_COLORS[s]) s = NAMED_COLORS[s];
  if (s.startsWith("#")) {
    let h = s.slice(1);
    if (h.length === 3 || h.length === 4) h = h.split("").map((c) => c + c).join("");
    if (h.length === 8) h = h.slice(0, 6);
    if (h.length !== 6 || /[^0-9a-f]/.test(h)) return null;
    return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255, 1];
  }
  const m = s.match(/(rgba?|hsla?)\(([^)]+)\)/);
  if (!m) return null;
  const nums = m[2].split(/[,\s\/]+/).filter(Boolean);
  if (m[1] === "rgb" || m[1] === "rgba") {
    const c = nums.slice(0, 3).map((x) => x.endsWith("%") ? parseFloat(x) / 100 : parseFloat(x) / 255);
    if (c.some(isNaN) || c.length < 3) return null;
    const a = nums[3] !== void 0 ? parseFloat(nums[3]) : 1;
    return [c[0], c[1], c[2], isNaN(a) ? 1 : a];
  }
  if (m[1] === "hsl" || m[1] === "hsla") {
    const h = parseFloat(nums[0]) / 360;
    const s2 = parseFloat(nums[1]) / 100;
    const l = parseFloat(nums[2]) / 100;
    if ([h, s2, l].some(isNaN)) return null;
    const q = l < 0.5 ? l * (1 + s2) : l + s2 - l * s2;
    const p = 2 * l - q;
    const hue = (t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    const a = nums[3] !== void 0 ? parseFloat(nums[3]) : 1;
    return [hue(h + 1 / 3), hue(h), hue(h - 1 / 3), isNaN(a) ? 1 : a];
  }
  return null;
}
function collectCustomProps(rules) {
  const vars = {};
  for (const r of rules) for (const d of r.decls) if (d.prop.startsWith("--")) vars[d.prop] = d.value;
  return vars;
}
function resolveVars(value, vars) {
  if (!value.includes("var(")) return value;
  let out = value;
  for (let guard = 0; guard < 5; guard++) {
    const m = out.match(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*(?:\([^()]*\)[^()]*)*))?\)/);
    if (!m) break;
    const replacement = (m[1] && vars[m[1]] !== void 0 ? vars[m[1]] : m[2] !== void 0 ? m[2] : "").trim();
    out = out.replace(m[0], replacement || "0");
  }
  return out;
}
function expandBoxValues(v) {
  const t = splitTop(v, " ").map((s) => s.trim()).filter(Boolean);
  if (t.length === 0) return ["0", "0", "0", "0"];
  if (t.length === 1) return [t[0], t[0], t[0], t[0]];
  if (t.length === 2) return [t[0], t[1], t[0], t[1]];
  if (t.length === 3) return [t[0], t[1], t[2], t[1]];
  return [t[0], t[1], t[2], t[3]];
}
function expandShorthands(style, vars) {
  for (const k of Object.keys(style)) if (style[k].includes("var(")) style[k] = resolveVars(style[k], vars);
  for (const base of ["padding", "margin", "inset"]) {
    if (style[base] !== void 0 && style[base] !== "auto") {
      const [t, r, b, l] = expandBoxValues(style[base]);
      const suf = base === "inset" ? "" : "-";
      style[`${base}${suf}top`] = style[`${base}${suf}top`] ?? t;
      style[`${base}${suf}right`] = style[`${base}${suf}right`] ?? r;
      style[`${base}${suf}bottom`] = style[`${base}${suf}bottom`] ?? b;
      style[`${base}${suf}left`] = style[`${base}${suf}left`] ?? l;
    }
  }
  const sides = ["top", "right", "bottom", "left"];
  const parseBorderTokens = (v) => {
    const toks = splitTop(v, " ").map((s) => s.trim()).filter(Boolean);
    let w = "", c = "";
    for (const t of toks) {
      if (!w && /^[\d.]+(px|em|rem|pt|thin|medium|thick)?$/.test(t) && !parseColor(t)) {
        w = /^(thin|medium|thick)$/.test(t) ? "1px" : t;
        continue;
      }
      if (/^(solid|dashed|dotted|double|none|hidden)$/.test(t)) continue;
      if (!c && parseColor(t)) c = t;
    }
    return { w: w || "0px", c };
  };
  for (const side of sides) {
    const sh = style[`border-${side}`];
    if (sh !== void 0) {
      const { w, c } = parseBorderTokens(sh);
      style[`border-${side}-width`] = style[`border-${side}-width`] ?? w;
      if (c) style[`border-${side}-color`] = style[`border-${side}-color`] ?? c;
    }
  }
  if (style["border"] !== void 0) {
    const { w, c } = parseBorderTokens(style["border"]);
    for (const side of sides) {
      style[`border-${side}-width`] = style[`border-${side}-width`] ?? w;
      if (c) style[`border-${side}-color`] = style[`border-${side}-color`] ?? c;
    }
    style["border-width"] = style["border-width"] ?? w;
    if (c) style["border-color"] = style["border-color"] ?? c;
  }
  if (style["gap"] !== void 0) {
    const [r, c] = expandBoxValues(style["gap"]);
    style["row-gap"] = style["row-gap"] ?? r;
    style["column-gap"] = style["column-gap"] ?? c;
  }
  if (style["flex"] !== void 0 && style["flex-grow"] === void 0) {
    const t = style["flex"].trim().split(/\s+/)[0];
    if (/^[\d.]+$/.test(t)) style["flex-grow"] = t;
    else if (t === "auto") style["flex-grow"] = "1";
  }
  if (style["background"] !== void 0 && style["background-image"] === void 0) {
    const layers = splitTop(style["background"], ",").map((s) => s.trim()).filter(Boolean);
    const imgs = [];
    for (let i = layers.length - 1; i >= 0; i--) {
      const lay = layers[i];
      if (/(linear|radial|conic)-gradient/i.test(lay)) imgs.unshift(lay);
      else {
        const toks = splitTop(lay, " ").map((s) => s.trim());
        const col = toks.map((t) => parseColor(t)).find(Boolean);
        if (col && !imgs.length) style["background-color"] = style["background-color"] ?? toks.filter((t) => parseColor(t))[0];
      }
    }
    if (imgs.length) style["background-image"] = imgs.join(", ");
  }
}
function computeStyles(root, rules, vw = 1920, vh = 1080) {
  const vars = collectCustomProps(rules);
  const map = /* @__PURE__ */ new Map();
  const walk = (el, parentStyle) => {
    if (el.tag === "#text") return;
    const matched = [];
    for (const r of rules) if (matchesSelector(el, r.selector)) matched.push(r);
    matched.sort((a, b) => a.order - b.order);
    const style = {};
    for (const k of INHERITED) if (parentStyle[k] !== void 0) style[k] = parentStyle[k];
    const important = [], normal = [];
    for (const r of matched) for (const d of r.decls) (d.important ? important : normal).push(d);
    const inline = el.attrs["style"] ? parseDecls(el.attrs["style"]) : [];
    for (const d of [...normal, ...inline, ...important]) {
      if (d.prop === "font") {
        const parts = d.value.replace(/\s*\/\s*/, "/").split(/\s+/);
        let fs3 = "";
        let lh = "";
        let fam = [];
        let fw = "";
        for (const p of parts) {
          if (!fs3 && /^[\d.]+(px|pt|em|rem|%)$/.test(p)) {
            const seg = p.split("/");
            fs3 = seg[0];
            if (seg[1]) lh = seg[1];
            continue;
          }
          if (!fs3 && /^[\d.]+\//.test(p)) {
            const seg = p.split("/");
            fs3 = seg[0];
            lh = seg[1];
            continue;
          }
          if (!fw && /^(bold|bolder|lighter|[1-9]00)$/.test(p)) {
            fw = p;
            continue;
          }
          if (fs3) fam.push(p);
        }
        if (fs3) style["font-size"] = fs3;
        if (lh) style["line-height"] = lh;
        if (fw) style["font-weight"] = fw;
        if (fam.length) style["font-family"] = fam.join(" ");
        continue;
      }
      if (d.prop.startsWith("--")) continue;
      style[d.prop] = d.value;
    }
    expandShorthands(style, vars);
    map.set(el, style);
    for (const c of el.children) walk(c, style);
  };
  const base = { "font-size": "16px", "font-family": "Arial", "font-weight": "400", color: "#000000", "text-align": "left", "line-height": "1.2" };
  walk(root, base);
  return map;
}
function px(v, ref, fontSize) {
  if (v === void 0) return null;
  const s = v.trim();
  if (s === "auto" || s === "inherit" || s === "initial" || s === "") return null;
  const m = s.match(/^(-?[\d.]+)(px|em|rem|%|pt|vw|vh)?$/);
  if (!m) return null;
  const num = parseFloat(m[1]);
  switch (m[2] || "px") {
    case "px":
      return num;
    case "em":
      return num * fontSize;
    case "rem":
      return num * 16;
    case "%":
      return num / 100 * ref;
    case "pt":
      return num * (96 / 72);
    case "vw":
      return num;
    // resolved by caller passing viewport width as ref
    case "vh":
      return num;
    default:
      return num;
  }
}
function charWidth(ch, bold, fs3, ls) {
  const code = ch.charCodeAt(0);
  const table = bold ? ARIAL_B : ARIAL_W;
  const w = (code >= 32 && code <= 126 ? table[code - 32] : 556) / 1e3;
  return w * fs3 + ls;
}
function displayOf(L) {
  return (L.style["display"] || (INLINE.has(L.el.tag) ? "inline" : "block") || "block").trim();
}
function findBody(root) {
  for (const c of root.children) {
    if (c.tag === "body") return c;
    for (const g of c.children) if (g.tag === "body") return g;
  }
  return root;
}
function layoutTree(root, styles, vw, vh, warnings) {
  const make = (el, parent) => ({
    el,
    style: styles.get(el) || {},
    box: { x: 0, y: 0, w: 0, h: 0 },
    parent,
    children: [],
    textLines: [],
    fontSize: px(parent ? (styles.get(parent.el) || {})["font-size"] : "16px", 1, 16) || 16
  });
  const measureText = (lines, fs3, weight, ls) => {
    const bold = weight >= 600;
    let max = 0;
    for (const line of lines) {
      let w = 0;
      for (const ch of line) w += charWidth(ch, bold, fs3, ls);
      max = Math.max(max, w);
    }
    return max;
  };
  const wrapLines = (lines, maxW, fs3, weight, ls) => {
    const bold = weight >= 600;
    const widthOf = (s) => {
      let w = 0;
      for (const ch of s) w += charWidth(ch, bold, fs3, ls);
      return w;
    };
    const out = [];
    for (const line of lines) {
      if (widthOf(line) <= maxW) {
        out.push(line);
        continue;
      }
      let cur = "";
      for (const wd of line.split(" ")) {
        const cand = cur ? cur + " " + wd : wd;
        if (cur && widthOf(cand) > maxW) {
          out.push(cur);
          cur = wd;
        } else cur = cand;
      }
      if (cur) out.push(cur);
    }
    return out;
  };
  const textOf = (el, white) => {
    const segs = [];
    let curLine = "";
    const flush = () => {
      let t = curLine;
      if (white !== "pre") t = t.replace(/\s+/g, " ").trim();
      if (t) segs.push(t);
      curLine = "";
    };
    for (const c of el.children) {
      if (c.tag === "#text") curLine += c.text || "";
      else if (c.tag === "br") flush();
    }
    flush();
    return segs;
  };
  const body = findBody(root);
  const borderSides = (st, fs3) => ({
    t: px(st["border-top-width"], 0, fs3) || 0,
    r: px(st["border-right-width"], 0, fs3) || 0,
    b: px(st["border-bottom-width"], 0, fs3) || 0,
    l: px(st["border-left-width"], 0, fs3) || 0
  });
  const estimateWidth = (L, depth = 0) => {
    const st = L.style;
    const fs3 = L.fontSize;
    const weight = parseFloat(st["font-weight"]) || (st["font-weight"] === "bold" ? 700 : 400);
    const ls = px(st["letter-spacing"], 0, fs3) || 0;
    const padL = px(st["padding-left"], 0, fs3) || 0, padR = px(st["padding-right"], 0, fs3) || 0;
    const b = borderSides(st, fs3);
    let inner = measureText(L.textLines, fs3, weight, ls);
    if (depth < 8) {
      for (const c of L.children) {
        const cw = px(c.style["width"], 0, c.fontSize);
        const cw2 = cw !== null ? cw : estimateWidth(c, depth + 1);
        if (cw2 > inner) inner = cw2;
      }
    }
    return inner + padL + padR + b.l + b.r;
  };
  const estimateHeight = (L, depth = 0) => {
    const st = L.style;
    const fs3 = L.fontSize;
    const lhRaw = st["line-height"];
    let lh = lhRaw && lhRaw !== "normal" ? px(lhRaw, fs3, fs3) ?? (parseFloat(lhRaw) * fs3 || fs3 * 1.2) : fs3 * 1.2;
    const padT = px(st["padding-top"], 0, fs3) || 0, padB = px(st["padding-bottom"], 0, fs3) || 0;
    const b = borderSides(st, fs3);
    let inner = L.textLines.length * lh;
    if (L.children.length && depth < 8) {
      let sum = 0, maxH = 0;
      for (const c of L.children) {
        const chH = px(c.style["height"], 0, c.fontSize) ?? estimateHeight(c, depth + 1);
        const disp = displayOf(c);
        if (disp === "flex" || disp === "grid" || BLOCK.has(c.el.tag)) sum += chH + (px(c.style["margin-top"], 0, c.fontSize) || 0) + (px(c.style["margin-bottom"], 0, c.fontSize) || 0);
        else maxH = Math.max(maxH, chH);
      }
      inner = Math.max(inner, sum + maxH);
    }
    return inner + padT + padB + b.t + b.b;
  };
  const build = (el, parentL) => {
    const L = make(el, parentL);
    const st = L.style;
    L.fontSize = px(st["font-size"], parentL ? parentL.fontSize : 16, parentL ? parentL.fontSize : 16) || (parentL ? parentL.fontSize : 16);
    if (/%$/.test((st["font-size"] || "").trim())) L.fontSize = (parentL ? parentL.fontSize : 16) * parseFloat(st["font-size"]) / 100;
    for (const c of el.children) {
      if (!styles.has(c)) continue;
      if (SKIP_TAGS.has(c.tag)) continue;
      L.children.push(build(c, L));
    }
    const ws = st["white-space"] || "normal";
    L.textLines = transformText(textOf(el, ws), st["text-transform"]);
    return L;
  };
  const rootNode = make(body, null);
  rootNode.fontSize = 16;
  for (const c of body.children) {
    if (!styles.has(c)) continue;
    if (SKIP_TAGS.has(c.tag)) continue;
    rootNode.children.push(build(c, rootNode));
  }
  rootNode.textLines = transformText(textOf(body, "normal"), rootNode.style["text-transform"]);
  const DEBUG = typeof process !== "undefined" && process.env && process.env.AE2AE_DEBUG;
  const layoutEl = (L, px0, py0, availW, availH) => {
    const st = L.style;
    const display = displayOf(L);
    const position = (st["position"] || "static").trim();
    if (DEBUG) console.error(`[layout] <${L.el.tag} class=${L.el.attrs["class"]}> display=${display} position=${position} px0=${px0} py0=${py0} avail=${availW}x${availH} w=${st["width"]} h=${st["height"]} boxSoFar=${JSON.stringify(L.box)}`);
    const fs3 = L.fontSize;
    const weight = parseFloat(st["font-weight"]) || (st["font-weight"] === "bold" ? 700 : 400);
    const ls = px(st["letter-spacing"], 0, fs3) || 0;
    const lhRaw = st["line-height"];
    let lh = lhRaw && lhRaw !== "normal" ? px(lhRaw, fs3, fs3) ?? (parseFloat(lhRaw) * fs3 || fs3 * 1.2) : fs3 * 1.2;
    if (lhRaw && !/[pxem%]/.test(lhRaw) && lhRaw !== "normal") lh = parseFloat(lhRaw) * fs3;
    const wsRaw = (st["white-space"] || "normal").trim();
    if (L.textLines.length && wsRaw !== "nowrap" && wsRaw !== "pre" && (st["width"] !== void 0 || st["max-width"] !== void 0)) {
      const maxW0 = px(st["width"], availW, fs3) ?? px(st["max-width"], availW, fs3);
      if (maxW0 !== null && maxW0 > 0) {
        const b0 = borderSides(st, fs3);
        const inner0 = maxW0 - (px(st["padding-left"], 0, fs3) || 0) - (px(st["padding-right"], 0, fs3) || 0) - b0.l - b0.r;
        if (inner0 > 0) L.textLines = wrapLines(L.textLines, inner0, fs3, weight, ls);
      }
    }
    const parentFs = L.parent ? L.parent.fontSize : fs3;
    const b = borderSides(st, fs3);
    const boxSizing = (st["box-sizing"] || "content-box").trim();
    const textW = measureText(L.textLines, fs3, weight, ls);
    const textH = Math.max(L.textLines.length, 1) * lh;
    let w = px(st["width"], availW, fs3);
    let h = px(st["height"], availH, fs3);
    if (st["max-width"]) w = Math.min(w ?? Infinity, px(st["max-width"], availW, fs3) ?? w ?? 0);
    const shrink = (position === "absolute" || position === "fixed") && w === null && !st["left"]?.includes("auto");
    if (w === null && shrink) w = estimateWidth(L);
    if (w === null && (display === "inline" || display === "inline-block")) w = textW + (px(st["padding-left"], 0, fs3) || 0) + (px(st["padding-right"], 0, fs3) || 0);
    if (w === null) w = availW;
    if (h === null) h = L.children.length || L.textLines.length ? Math.max(textH, 0) : lh;
    if (L.el.tag === "svg" && h !== null && st["height"] === void 0) {
      const vb2 = (L.el.attrs["viewbox"] || L.el.attrs["viewBox"] || "").trim().split(/[\s,]+/).map(Number);
      if (vb2.length === 4 && vb2.every((n2) => !isNaN(n2)) && vb2[2] > 0 && w) h = w * vb2[3] / vb2[2];
    }
    if (boxSizing === "border-box") {
      L.box.w = Math.max(w, 0);
      L.box.h = Math.max(h, 0);
    } else {
      L.box.w = Math.max(w + (st["width"] !== void 0 ? (px(st["padding-left"], 0, fs3) || 0) + (px(st["padding-right"], 0, fs3) || 0) + b.l + b.r : 0), 0);
      L.box.h = Math.max(h + (st["height"] !== void 0 ? (px(st["padding-top"], 0, fs3) || 0) + (px(st["padding-bottom"], 0, fs3) || 0) + b.t + b.b : 0), 0);
    }
    let bx, by;
    const offT = px(st["top"], L.parent ? L.parent.box.h : vh, fs3), offL = px(st["left"], L.parent ? L.parent.box.w : vw, fs3);
    const offB = px(st["bottom"], L.parent ? L.parent.box.h : vh, fs3), offR = px(st["right"], L.parent ? L.parent.box.w : vw, fs3);
    if (position === "absolute" || position === "fixed") {
      const anchor = positionedAncestor(L) || { box: { x: 0, y: 0, w: vw, h: vh } };
      bx = offL !== null ? anchor.box.x + offL : offR !== null ? anchor.box.x + anchor.box.w - offR - L.box.w : px0;
      by = offT !== null ? anchor.box.y + offT : offB !== null ? anchor.box.y + anchor.box.h - offB - L.box.h : py0;
      if (offL !== null && offR !== null) {
        bx = anchor.box.x + offL;
        L.box.w = Math.max(anchor.box.w - offL - offR, 0);
      }
      if (offT !== null && offB !== null) {
        by = anchor.box.y + offT;
        L.box.h = Math.max(anchor.box.h - offT - offB, 0);
      }
      if (offL !== null && offR !== null && offT !== null && offB !== null && (st["margin-left"] === "auto" || st["margin-right"] === "auto")) {
        bx = anchor.box.x + (anchor.box.w - L.box.w) / 2;
        by = anchor.box.y + (anchor.box.h - L.box.h) / 2;
      }
    } else {
      bx = px0 + (offL ?? 0) - (offR ?? 0);
      by = py0 + (offT ?? 0) - (offB ?? 0);
    }
    L.box.x = bx;
    L.box.y = by;
    L.staticX = bx;
    L.staticY = by;
    const padT = px(st["padding-top"], 0, fs3) || 0, padB = px(st["padding-bottom"], 0, fs3) || 0;
    const padL = px(st["padding-left"], 0, fs3) || 0, padR = px(st["padding-right"], 0, fs3) || 0;
    const contentW = Math.max(L.box.w - padL - padR - b.l - b.r, 0);
    const contentH = Math.max(L.box.h - padT - padB - b.t - b.b, 0);
    if (display === "flex" || display === "inline-flex") {
      const dir = (st["flex-direction"] || "row").startsWith("column") ? "col" : "row";
      const gap = px(st["column-gap"], 0, fs3) ?? px(st["gap"], 0, fs3) ?? 0;
      const rowGap = px(st["row-gap"], 0, fs3) ?? gap;
      const justify = st["justify-content"] || "flex-start";
      const align = st["align-items"] || "stretch";
      const kids = L.children;
      if (st["height"] === void 0) L.box.h = Math.max(estimateHeight(L), 1);
      const cH = Math.max(L.box.h - padT - padB - b.t - b.b, 0);
      const kidMargin = (k, prop) => {
        const mv = k.style[prop];
        return mv === "auto" ? "auto" : px(mv, dir === "row" ? contentW : cH, k.fontSize) || 0;
      };
      const sizes = kids.map((k) => {
        return dir === "row" ? px(k.style["width"], contentW, k.fontSize) ?? Math.max(estimateWidth(k), 1) : px(k.style["height"], cH, k.fontSize) ?? lh;
      });
      const grow = kids.map((k) => {
        const f = parseFloat(k.style["flex-grow"] || "0");
        return isNaN(f) ? 0 : f;
      });
      const mLs = kids.map((k) => kidMargin(k, "margin-left"));
      const mRs = kids.map((k) => kidMargin(k, "margin-right"));
      const totalFlex = grow.reduce((a, b2) => a + b2, 0);
      const fixed = sizes.reduce((a, b2, i) => a + b2 + (mLs[i] === "auto" ? 0 : mLs[i]) + (mRs[i] === "auto" ? 0 : mRs[i]), 0) + gap * Math.max(kids.length - 1, 0);
      let free = Math.max((dir === "row" ? contentW : cH) - fixed, 0);
      const effSizes = sizes.map((s, idx2) => totalFlex > 0 && grow[idx2] > 0 ? s + free * grow[idx2] / totalFlex : s);
      if (totalFlex > 0) free = 0;
      const main = dir === "row" ? contentW : cH;
      const used = effSizes.reduce((a, b2, i) => a + b2 + (mLs[i] === "auto" ? 0 : mLs[i]) + (mRs[i] === "auto" ? 0 : mRs[i]), 0) + gap * Math.max(kids.length - 1, 0);
      let cursor = justify === "center" ? (main - used) / 2 : justify === "flex-end" ? main - used : 0;
      const between = justify === "space-between" && kids.length > 1 ? (main - used) / (kids.length - 1) : 0;
      let extent = 0;
      kids.forEach((k, idx2) => {
        const size = effSizes[idx2];
        const ml = mLs[idx2], mr = mRs[idx2];
        if (ml === "auto" && mr === "auto") cursor = (main - size) / 2;
        else if (ml === "auto") cursor = main - size - (mr === "auto" ? 0 : mr);
        else cursor += ml;
        const kPadT = (px(k.style["padding-top"], 0, k.fontSize) || 0) + (px(k.style["border-top-width"], 0, k.fontSize) || 0);
        const kPadB = (px(k.style["padding-bottom"], 0, k.fontSize) || 0) + (px(k.style["border-bottom-width"], 0, k.fontSize) || 0);
        const crossSize = dir === "row" ? px(k.style["height"], cH, k.fontSize) ?? (k.textLines.length ? Math.max(k.textLines.length, 1) * (px(k.style["line-height"], k.fontSize, k.fontSize) ?? k.fontSize * 1.2) + kPadT + kPadB : cH) : px(k.style["width"], contentW, k.fontSize) ?? contentW;
        let cross = align === "center" ? (dir === "row" ? cH - crossSize : contentW - crossSize) / 2 : align === "flex-end" ? dir === "row" ? cH - crossSize : contentW - crossSize : 0;
        if (dir === "row") layoutEl(k, L.box.x + padL + b.l + cursor, L.box.y + padT + b.t + cross, size, crossSize);
        else layoutEl(k, L.box.x + padL + b.l + cross, L.box.y + padT + b.t + cursor, crossSize, size);
        cursor += size + gap + between + (mr === "auto" ? 0 : mr);
        extent = Math.max(extent, (dir === "row" ? k.box.y + k.box.h : k.box.x + k.box.w) - (dir === "row" ? L.box.y : L.box.x));
      });
      if (st["height"] === void 0) L.box.h = Math.max(extent + padB + b.b, 1);
    } else if (display === "grid" || display === "inline-grid") {
      const colGap = px(st["column-gap"], 0, fs3) ?? px(st["gap"], 0, fs3) ?? 0;
      const rowGap = px(st["row-gap"], 0, fs3) ?? colGap;
      const cols = parseGridTracks(st["grid-template-columns"] || "", contentW, colGap);
      const rowsSpec = parseGridTracks(st["grid-template-rows"] || "", contentH, rowGap);
      const items = L.children.filter((k) => displayOf(k) !== "none");
      const nCols = Math.max(cols.length, 1);
      const nRows = Math.max(Math.ceil(items.length / nCols), rowsSpec.length, 1);
      const rowH = [];
      for (let r = 0; r < nRows; r++) {
        if (rowsSpec[r] && rowsSpec[r].kind === "len") {
          rowH.push(rowsSpec[r].px);
          continue;
        }
        let mx = rowsSpec[r]?.px || 0;
        for (let c = 0; c < nCols; c++) {
          const k = items[r * nCols + c];
          if (!k) continue;
          mx = Math.max(mx, px(k.style["height"], contentH, k.fontSize) ?? estimateHeight(k));
        }
        rowH.push(mx);
      }
      const colW = new Array(cols.length).fill(0);
      const frs = cols.map((t) => t.kind === "fr" ? t.px : 0);
      const fixedTotal = cols.reduce((a, t, i) => a + (t.kind === "len" ? t.px : 0), 0);
      const frTotal = frs.reduce((a, b2) => a + b2, 0);
      const freeW = Math.max(contentW - fixedTotal - colGap * Math.max(cols.length - 1, 0), 0);
      cols.forEach((t, i) => {
        colW[i] = t.kind === "len" ? t.px : frTotal > 0 ? freeW * t.px / frTotal : freeW / Math.max(cols.length, 1);
      });
      if (!cols.length) colW[0] = contentW;
      const colOff = [];
      let acc = 0;
      for (let c = 0; c < Math.max(cols.length, 1); c++) {
        colOff.push(acc);
        acc += colW[c] + colGap;
      }
      const rowOff = [];
      acc = 0;
      for (let r = 0; r < nRows; r++) {
        rowOff.push(acc);
        acc += rowH[r] + rowGap;
      }
      items.forEach((k, i) => {
        const c = i % nCols, r = Math.floor(i / nCols);
        const kx = L.box.x + padL + b.l + colOff[c];
        const ky = L.box.y + padT + b.t + rowOff[r];
        const placeAlign = (st["place-items"] || st["align-items"] || "").split(/\s+/)[0] || "stretch";
        const placeJust = (st["place-items"] || st["justify-items"] || "").split(/\s+/)[1] || placeAlign;
        const kw = px(k.style["width"], colW[c], k.fontSize);
        const kh = px(k.style["height"], rowH[r], k.fontSize);
        let ox = 0, oy = 0;
        const cellW = kw ?? colW[c], cellH = kh ?? rowH[r];
        if (placeJust === "center") ox = (colW[c] - cellW) / 2;
        else if (placeJust === "end") ox = colW[c] - cellW;
        if (placeAlign === "center") oy = (rowH[r] - cellH) / 2;
        else if (placeAlign === "end") oy = rowH[r] - cellH;
        layoutEl(k, kx + ox, ky + oy, colW[c] - ox, rowH[r] - oy);
      });
      if (st["height"] === void 0) L.box.h = padT + b.t + rowOff[Math.max(nRows - 1, 0)] + rowH[Math.max(nRows - 1, 0)] + padB + b.b;
      if (st["width"] === void 0) L.box.w = padL + b.l + colOff[Math.max(cols.length - 1, 0)] + colW[Math.max(cols.length - 1, 0)] + padR + b.r;
    } else {
      let y = padT + b.t;
      const flowKids = L.children;
      let inlineRow = [];
      let rowX = padL + b.l;
      let rowStartX = rowX;
      const flushRow = (rowMaxH) => {
        for (const k of inlineRow) layoutEl(k, L.box.x + rowStartX, L.box.y + y, contentW - (rowStartX - padL - b.l), rowMaxH);
        inlineRow = [];
        rowX = padL + b.l;
        rowStartX = rowX;
        y += rowMaxH;
      };
      let rowH2 = 0;
      for (const k of flowKids) {
        const kDisp = displayOf(k);
        if (kDisp === "none") continue;
        if (kDisp === "inline" || kDisp === "inline-block") {
          const kPadX = (px(k.style["padding-left"], 0, k.fontSize) || 0) + (px(k.style["padding-right"], 0, k.fontSize) || 0);
          const kw = px(k.style["width"], contentW, k.fontSize) ?? measureText(k.textLines, k.fontSize, parseFloat(k.style["font-weight"]) || 400, px(k.style["letter-spacing"], 0, k.fontSize) || 0) + kPadX;
          const kh = px(k.style["height"], lh * Math.max(k.textLines.length, 1), k.fontSize) ?? lh * Math.max(k.textLines.length, 1) + (px(k.style["padding-top"], 0, k.fontSize) || 0) + (px(k.style["padding-bottom"], 0, k.fontSize) || 0);
          if (rowX + kw > L.box.x - L.box.x + contentW + padL + b.l && inlineRow.length && rowX > padL) {
          }
          if (rowX - padL - b.l + kw > contentW && inlineRow.length) flushRow(rowH2);
          k.box.w = kw;
          k.box.h = kh;
          k.staticX = rowX;
          k.staticY = y;
          inlineRow.push(k);
          rowX += kw;
          rowH2 = Math.max(rowH2, kh);
        } else {
          if (inlineRow.length) flushRow(rowH2);
          const mt = px(k.style["margin-top"], 0, k.fontSize) || 0;
          const mb = px(k.style["margin-bottom"], 0, k.fontSize) || 0;
          const ml = px(k.style["margin-left"], contentW, k.fontSize) || 0;
          const mr = px(k.style["margin-right"], contentW, k.fontSize) || 0;
          let autoML = /margin[^:]*:\s*[^;]*auto/.test(k.style["margin"] || "") || k.style["margin-left"] === "auto" || k.style["margin-right"] === "auto";
          y += mt;
          const kw = px(k.style["width"], contentW, k.fontSize);
          const boxSizing2 = (k.style["box-sizing"] || "content-box").trim();
          const kb = borderSides(k.style, k.fontSize);
          const effW = kw !== null ? boxSizing2 === "border-box" ? kw : kw + (px(k.style["padding-left"], 0, k.fontSize) || 0) + (px(k.style["padding-right"], 0, k.fontSize) || 0) + kb.l + kb.r : Math.max(contentW - ml - mr, 0);
          const kh = px(k.style["height"], contentH, k.fontSize);
          let kx = padL + b.l + ml;
          if (autoML && kw !== null) kx = padL + b.l + ml + (contentW - ml - mr - effW) / 2;
          layoutEl(k, L.box.x + kx, L.box.y + y, effW, kh ?? Math.max(contentH - (y - padT - b.t), 0));
          y += k.box.h + mb;
        }
      }
      if (inlineRow.length) flushRow(rowH2);
      if (st["height"] === void 0) L.box.h = Math.max(L.box.h, y + padB + b.b);
    }
  };
  const bodyMargin = rootNode.style["margin"] !== void 0 || rootNode.style["margin-top"] !== void 0;
  const bmT = px(rootNode.style["margin-top"], 0, 16) ?? (bodyMargin ? 8 : 0);
  const bmL = px(rootNode.style["margin-left"], 0, 16) ?? (bodyMargin ? 8 : 0);
  rootNode.box = { x: bmL, y: bmT, w: vw - bmL * 2, h: vh - bmT * 2 };
  let flowY = rootNode.box.y;
  for (const k of rootNode.children) {
    const mt = px(k.style["margin-top"], 0, k.fontSize) || 0;
    const mb = px(k.style["margin-bottom"], 0, k.fontSize) || 0;
    flowY += mt;
    layoutEl(k, rootNode.box.x, flowY, rootNode.box.w, rootNode.box.h);
    if ((k.style["position"] || "static") === "static" || (k.style["position"] || "") === "relative") flowY += k.box.h + mb;
  }
  function positionedAncestor(L) {
    let p = L.parent;
    while (p) {
      const pos = (p.style["position"] || "static").trim();
      if (pos === "relative" || pos === "absolute" || pos === "fixed") return p;
      p = p.parent;
    }
    return null;
  }
  return rootNode;
}
function parseGridTracks(spec, refSize, gap) {
  if (!spec || spec === "none") return [];
  const toks = [];
  let depth = 0, cur = "";
  for (const ch of spec) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === " " && depth === 0) {
      if (cur.trim()) toks.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) toks.push(cur.trim());
  const out = [];
  for (const t of toks) {
    const rep = t.match(/^repeat\(\s*(\d+)\s*,\s*([^)]+)\)$/);
    if (rep) {
      const inner = rep[2].trim();
      for (let i = 0; i < parseInt(rep[1]); i++) out.push(trackSpec(inner, refSize));
      continue;
    }
    out.push(trackSpec(t, refSize));
  }
  return out;
}
function trackSpec(t, refSize) {
  const fr = t.match(/^([\d.]+)fr$/);
  if (fr) return { kind: "fr", px: parseFloat(fr[1]) || 1 };
  const v = px(t, refSize, 16);
  if (v !== null) return { kind: "len", px: v };
  return { kind: "fr", px: 1 };
}
function transformText(lines, tt) {
  if (!tt) return lines;
  if (tt === "uppercase") return lines.map((l) => l.toUpperCase());
  if (tt === "lowercase") return lines.map((l) => l.toLowerCase());
  if (tt === "capitalize") return lines.map((l) => l.replace(/\b\w/g, (c) => c.toUpperCase()));
  return lines;
}
function parseTiming(tf) {
  const s = (tf || "ease").trim();
  if (s === "linear" || s === "step-start") return { interp: "LINEAR", infIn: 0, infOut: 0 };
  if (s.startsWith("steps") || s === "step-end") return { interp: "HOLD", infIn: 0, infOut: 0 };
  if (s === "ease-in") return { interp: "BEZIER", infIn: 16.7, infOut: 66.7 };
  if (s === "ease-out") return { interp: "BEZIER", infIn: 66.7, infOut: 16.7 };
  if (s === "ease-in-out") return { interp: "BEZIER", infIn: 60, infOut: 60 };
  return { interp: "BEZIER", infIn: 55, infOut: 55 };
}
function parseAnim(st, warnings) {
  const a = { name: "", duration: 0, delay: 0, iter: 1, direction: "normal", fill: "none", timing: "ease" };
  let have = false;
  const sh = st["animation"];
  if (sh && sh !== "none") {
    const toks = splitTop(sh, " ").map((t) => t.trim()).filter(Boolean);
    const times = [];
    const rest = [];
    for (const t of toks) {
      if (/^[\d.]+(ms|s)$/i.test(t)) times.push(t);
      else rest.push(t);
    }
    a.duration = times.length ? toSeconds(times[0]) : 0;
    a.delay = times.length > 1 ? toSeconds(times[1]) : 0;
    const nm = rest.find((t) => /^[a-zA-Z-][\w-]*$/.test(t) && !/^(infinite|alternate|alternate-reverse|reverse|both|forwards|backwards|none|linear|ease(-in|-out|-in-out)?|steps?|cubic-bezier)$/i.test(t));
    if (nm) a.name = nm;
    const timing = rest.find((t) => /^(linear|ease(-in|-out|-in-out)?|steps?\(|cubic-bezier\()/i.test(t));
    if (timing) a.timing = timing;
    const iter = rest.find((t) => t === "infinite" || /^[\d.]+$/.test(t));
    if (iter) a.iter = iter === "infinite" ? "infinite" : parseFloat(iter) || 1;
    const dirRaw = rest.find((t) => t === "alternate" || t === "alternate-reverse" || t === "reverse");
    a.direction = (dirRaw === "alternate-reverse" ? "alternate" : dirRaw === "reverse" ? "normal" : dirRaw) || "normal";
    const fill = rest.find((t) => /^(both|forwards|backwards|none)$/.test(t));
    if (fill) a.fill = fill;
    have = !!a.name;
    if (!have && times.length) warnings.push(`animation "${sh}" has no keyframes name`);
  }
  if (st["animation-name"] && st["animation-name"] !== "none") {
    a.name = st["animation-name"];
    have = true;
  }
  if (st["animation-duration"]) a.duration = toSeconds(st["animation-duration"]);
  if (st["animation-delay"]) a.delay = toSeconds(st["animation-delay"]);
  if (st["animation-iteration-count"]) a.iter = st["animation-iteration-count"] === "infinite" ? "infinite" : parseFloat(st["animation-iteration-count"]) || 1;
  if (st["animation-direction"]) a.direction = st["animation-direction"] === "alternate-reverse" ? "alternate" : st["animation-direction"] === "reverse" ? "normal" : st["animation-direction"];
  if (st["animation-fill-mode"]) a.fill = st["animation-fill-mode"];
  if (st["animation-timing-function"]) a.timing = st["animation-timing-function"];
  return have ? a : null;
}
function toSeconds(v) {
  const m = v.match(/^([\d.]+)(ms|s)?$/);
  if (!m) return 0;
  return parseFloat(m[1]) * (m[2] === "ms" ? 1e-3 : 1);
}
function backgroundLayers(v) {
  return splitTop(v, ",").map((s) => s.trim()).filter(Boolean);
}
function parseGradientLayer(layer, box, vw, vh) {
  const g = layer.match(/(repeating-)?(linear|radial|conic)-gradient\s*\(/i);
  if (!g || g[2].toLowerCase() === "conic") return null;
  if (g[1]) return null;
  const open = layer.indexOf("(", g.index + g[0].length - 1);
  let depth = 0, endIdx = -1;
  for (let i = open; i < layer.length; i++) {
    if (layer[i] === "(") depth++;
    else if (layer[i] === ")") {
      depth--;
      if (!depth) {
        endIdx = i;
        break;
      }
    }
  }
  if (endIdx === -1) return null;
  const args = splitTop(layer.slice(open + 1, endIdx), ",").map((s) => s.trim()).filter(Boolean);
  const isRadial = g[2].toLowerCase() === "radial";
  let ci = 0;
  let cxPct = 0.5, cyPct = 0.5, radiusFactor = 1;
  let angleDeg = 180;
  const first = args[0] || "";
  if (!isRadial) {
    if (/^to\s/.test(first)) {
      const dirs = first.split(/\s+/).slice(1);
      angleDeg = 180;
      if (dirs.includes("top")) angleDeg = 0;
      if (dirs.includes("right")) angleDeg = 90;
      if (dirs.includes("bottom")) angleDeg = 180;
      if (dirs.includes("left")) angleDeg = 270;
      if (dirs.includes("top") && dirs.includes("right")) angleDeg = 45;
      if (dirs.includes("top") && dirs.includes("left")) angleDeg = 315;
      if (dirs.includes("bottom") && dirs.includes("right")) angleDeg = 135;
      if (dirs.includes("bottom") && dirs.includes("left")) angleDeg = 225;
      ci = 1;
    } else if (/^[-\d.]+(deg|turn|rad)/.test(first)) {
      angleDeg = first.endsWith("turn") ? parseFloat(first) * 360 : first.endsWith("rad") ? parseFloat(first) * 180 / Math.PI : parseFloat(first) || 0;
      ci = 1;
    }
  } else {
    if (!parseColor(first)) {
      ci = 1;
      const mAt = first.match(/at\s+([-\d.%]+)\s+([-\d.%]+)/);
      if (mAt) {
        cxPct = mAt[1].endsWith("%") ? parseFloat(mAt[1]) / 100 : parseFloat(mAt[1]) / Math.max(box.w, 1);
        cyPct = mAt[2].endsWith("%") ? parseFloat(mAt[2]) / 100 : parseFloat(mAt[2]) / Math.max(box.h, 1);
      }
      const mLen = first.split(/\bat\b/)[0].match(/([\d.]+)(px|em|%|fr)\s*$/);
      if (mLen) {
        const len = parseFloat(mLen[1]) * (mLen[2] === "em" ? 16 : 1);
        radiusFactor = mLen[2] === "%" ? parseFloat(mLen[1]) / 100 : len / Math.hypot(box.w, box.h);
      }
    }
  }
  const stops = [];
  for (const a of args.slice(ci)) {
    const m = a.match(/^(.*?)(?:\s+([\d.]+%))?$/);
    const col = parseColor(m[1]);
    if (col) stops.push({ c: col, pos: m[2] ? parseFloat(m[2]) / 100 : null });
  }
  if (stops.length < 2) return null;
  const lastPos = stops[stops.length - 1].pos ?? 1;
  const toAE = (x, y) => [x - vw / 2, vh / 2 - y];
  const cx = box.x + cxPct * box.w, cy = box.y + cyPct * box.h;
  if (isRadial) {
    let r;
    const farthest = Math.max(Math.hypot(cx - box.x, cy - box.y), Math.hypot(box.x + box.w - cx, cy - box.y), Math.hypot(cx - box.x, box.y + box.h - cy), Math.hypot(box.x + box.w - cx, box.y + box.h - cy));
    r = farthest * (radiusFactor !== 1 ? radiusFactor : Math.max(1e-4, lastPos));
    return {
      radial: true,
      center: [cx, cy],
      r,
      start: toAE(cx, cy),
      end: toAE(cx + r, cy),
      c1: [stops[0].c[0], stops[0].c[1], stops[0].c[2]],
      c2: [stops[stops.length - 1].c[0], stops[stops.length - 1].c[1], stops[stops.length - 1].c[2]],
      a1: stops[0].c[3],
      a2: stops[stops.length - 1].c[3]
    };
  }
  const rad = angleDeg * Math.PI / 180;
  const dx = Math.sin(rad), dy = -Math.cos(rad);
  const half = (Math.abs(dx) * box.w + Math.abs(dy) * box.h) / 2;
  return {
    radial: false,
    center: [cx, cy],
    r: half,
    start: toAE(cx - dx * half, cy - dy * half),
    end: toAE(cx + dx * half, cy + dy * half),
    c1: [stops[0].c[0], stops[0].c[1], stops[0].c[2]],
    c2: [stops[stops.length - 1].c[0], stops[stops.length - 1].c[1], stops[stops.length - 1].c[2]],
    a1: stops[0].c[3],
    a2: stops[stops.length - 1].c[3]
  };
}
function borderColorOf(v, st) {
  if (!v) return null;
  if (/^currentcolor$/i.test(v.trim())) return parseColor(st["color"] || "#000");
  return parseColor(v);
}
function parseTransform(v) {
  const x = { tx: 0, ty: 0, sx: 1, sy: 1, rot: 0 };
  if (!v || v === "none") return x;
  const re = /(translate|translateX|translateY|scale|scaleX|scaleY|rotate)\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g;
  let m;
  while (m = re.exec(v)) {
    const fn = m[1], args = splitTop(m[2], ",").map((s) => s.trim());
    if (args.some((a) => a.includes("var("))) continue;
    const num = (s, ref = 0) => {
      const mm = s.match(/^(-?[\d.]+)(px|em|%|deg|turn|rad)?$/);
      if (!mm) return 0;
      const val = parseFloat(mm[1]);
      const u = mm[2];
      if (u === "%") return val / 100 * ref;
      if (u === "em") return val * 16;
      if (u === "turn") return val * 360;
      if (u === "rad") return val * 180 / Math.PI;
      return val;
    };
    if (fn === "translate") {
      x.tx += num(args[0]);
      x.ty += num(args[1] || "0px");
    } else if (fn === "translateX") x.tx += num(args[0]);
    else if (fn === "translateY") x.ty += num(args[0]);
    else if (fn === "scale") {
      const a0 = args[0] !== void 0 && args[0] !== "" ? num(args[0], 1) : 1;
      const a1 = args[1] !== void 0 ? num(args[1], 1) : a0;
      x.sx *= a0;
      x.sy *= a1;
    } else if (fn === "scaleX") {
      x.sx *= args[0] !== void 0 ? num(args[0], 1) : 1;
    } else if (fn === "scaleY") {
      x.sy *= args[0] !== void 0 ? num(args[0], 1) : 1;
    } else if (fn === "rotate") x.rot += num(args[0], 0);
  }
  return x;
}
function cloneX(x) {
  return { ...x };
}
function transformOriginPx(st, box, fs3) {
  const raw = (st["transform-origin"] || "").trim().toLowerCase();
  if (!raw || raw === "center") return null;
  const toks = raw.split(/\s+/).filter(Boolean);
  if (toks.length > 2) return null;
  const resolve = (tok, ref) => {
    const t = (tok || "center").trim();
    if (t === "left" || t === "top" || t === "0") return 0;
    if (t === "right" || t === "bottom") return ref;
    if (t === "center" || t === "") return ref / 2;
    if (t.endsWith("%")) return parseFloat(t) / 100 * ref;
    const v = px(t, ref, fs3);
    return v === null ? ref / 2 : v;
  };
  let a = toks[0], b2 = toks[1];
  if ((a === "top" || a === "bottom") && !b2) {
    b2 = a;
    a = void 0;
  }
  if ((a === "top" || a === "bottom") && (b2 === "left" || b2 === "right")) {
    const tmp = a;
    a = b2;
    b2 = tmp;
  }
  const x = resolve(a, box.w), y = resolve(b2, box.h);
  return [box.x + x, box.y + y];
}
function injectPseudos(root, rules) {
  const pseudoRules = rules.filter((r) => /:{1,2}(after|before)\s*$/i.test(r.selector)).map((r) => ({ base: r.selector.replace(/:{1,2}(after|before)\s*$/i, "").trim(), after: /:{1,2}after\s*$/i.test(r.selector), decls: r.decls }));
  if (!pseudoRules.length) return;
  const walk = (el) => {
    for (const c of el.children) walk(c);
    if (el.tag === "#text" || el.tag === "#root") return;
    for (const pr of pseudoRules) {
      if (!pr.base || !matchesSelector(el, pr.base)) continue;
      const content = pr.decls.find((d) => d.prop === "content");
      if (!content || /none|normal/i.test(content.value)) continue;
      const styleStr = pr.decls.filter((d) => d.prop !== "content").map((d) => `${d.prop}:${d.value}`).join(";");
      const node = { tag: "span", attrs: { "data-pseudo": "1", class: "ae-pseudo", style: styleStr }, children: [], parent: null, order: el.order + 0.5 };
      if (el.children.length) node.order = el.children[el.children.length - 1].order + 0.5;
      node.parent = el;
      if (pr.after) el.children.push(node);
      else el.children.unshift(node);
    }
  };
  walk(root);
}
function parsePathData(d) {
  const toks = [];
  const re = /([MmLlHhVvCcQqAaZz])|(-?\d*\.?\d+(?:e[-+]?\d+)?)/g;
  let m;
  while (m = re.exec(d)) toks.push(m[0]);
  const segs = [];
  let i = 0, cmd = "";
  const num = () => parseFloat(toks[i++]);
  while (i < toks.length) {
    const t = toks[i];
    if (/^[a-zA-Z]$/.test(t)) {
      cmd = t;
      i++;
      if (cmd === "Z" || cmd === "z") {
        segs.push({ cmd: "Z", pts: [] });
        continue;
      }
    }
    const rel = cmd === cmd.toLowerCase() && cmd !== "z";
    const C = cmd.toUpperCase();
    const pts = [];
    const need = C === "M" || C === "L" ? 2 : C === "H" || C === "V" ? 1 : C === "C" ? 6 : C === "Q" ? 4 : C === "A" ? 7 : 0;
    if (!need) {
      i++;
      continue;
    }
    for (let k = 0; k < need; k++) {
      if (i >= toks.length) break;
      const v = num();
      if (C === "H") pts.push([v, 0]);
      else if (C === "V") pts.push([0, v]);
      else pts.push([v, v]);
      if ((C === "M" || C === "L" || C === "A") && k === 0 && need === 2 && i < toks.length && !/^[a-zA-Z]$/.test(toks[i])) {
      }
    }
    const flat = [];
    let j = i - need;
    while (j < i) flat.push(parseFloat(toks[j++]));
    if (C === "H") {
      pts.length = 0;
      pts.push([flat[0], NaN]);
    } else if (C === "V") {
      pts.length = 0;
      pts.push([NaN, flat[0]]);
    } else {
      pts.length = 0;
      for (let k = 0; k + 1 < flat.length + 1 && k < flat.length - 1; k += 2) pts.push([flat[k], flat[k + 1]]);
    }
    segs.push({ cmd: rel ? C.toLowerCase() : C, pts });
  }
  let cx = 0, cy = 0, sx = 0, sy = 0;
  const verts = [], inT = [], outT = [];
  let closed = false, length = 0;
  const pushVert = (p, tin, tout) => {
    verts.push(p);
    inT.push(tin);
    outT.push(tout);
  };
  for (const s of segs) {
    const c = s.cmd;
    if (c === "M") {
      const p = [s.pts[0][0], s.pts[0][1]];
      if (!verts.length) {
        sx = p[0];
        sy = p[1];
        pushVert(p, [0, 0], [0, 0]);
      } else pushVert(p, [0, 0], [0, 0]);
      cx = p[0];
      cy = p[1];
    } else if (c === "m") {
      const p = [cx + s.pts[0][0], cy + s.pts[0][1]];
      if (!verts.length) {
        sx = p[0];
        sy = p[1];
      }
      pushVert(p, [0, 0], [0, 0]);
      cx = p[0];
      cy = p[1];
    } else if (c === "L" || c === "l") {
      const p = c === "L" ? [s.pts[0][0], s.pts[0][1]] : [cx + s.pts[0][0], cy + s.pts[0][1]];
      length += Math.hypot(p[0] - cx, p[1] - cy);
      outT[outT.length - 1] = [0, 0];
      pushVert(p, [0, 0], [0, 0]);
      cx = p[0];
      cy = p[1];
    } else if (c === "H" || c === "h") {
      const nx = c === "H" ? s.pts[0][0] : cx + s.pts[0][0];
      length += Math.abs(nx - cx);
      pushVert([nx, cy], [0, 0], [0, 0]);
      cx = nx;
    } else if (c === "V" || c === "v") {
      const ny = c === "V" ? s.pts[0][1] : cy + s.pts[0][1];
      length += Math.abs(ny - cy);
      pushVert([cx, ny], [0, 0], [0, 0]);
      cy = ny;
    } else if (c === "C" || c === "c") {
      const [x1, y1] = c === "C" ? s.pts[0] : [cx + s.pts[0][0], cy + s.pts[0][1]];
      const [x2, y2] = c === "C" ? s.pts[1] : [cx + s.pts[1][0], cy + s.pts[1][1]];
      const p = c === "C" ? s.pts[2] : [cx + s.pts[2][0], cy + s.pts[2][1]];
      length += Math.hypot(x1 - cx, y1 - cy) + Math.hypot(x2 - x1, y2 - y1) + Math.hypot(p[0] - x2, p[1] - y2);
      outT[outT.length - 1] = [x1 - cx, y1 - cy];
      pushVert(p, [x2 - p[0], y2 - p[1]], [0, 0]);
      cx = p[0];
      cy = p[1];
    } else if (c === "Q" || c === "q") {
      const [qx, qy] = c === "Q" ? s.pts[0] : [cx + s.pts[0][0], cy + s.pts[0][1]];
      const p = c === "Q" ? s.pts[1] : [cx + s.pts[1][0], cy + s.pts[1][1]];
      const x1 = cx + 2 / 3 * (qx - cx), y1 = cy + 2 / 3 * (qy - cy);
      const x2 = p[0] + 2 / 3 * (qx - p[0]), y2 = p[1] + 2 / 3 * (qy - p[1]);
      length += Math.hypot(qx - cx, qy - cy) + Math.hypot(p[0] - qx, p[1] - qy);
      outT[outT.length - 1] = [x1 - cx, y1 - cy];
      pushVert(p, [x2 - p[0], y2 - p[1]], [0, 0]);
      cx = p[0];
      cy = p[1];
    } else if (c === "A") {
      const p = s.pts[5] ? [s.pts[5][0], s.pts[5][1]] : [cx, cy];
      if (s.pts.length >= 6) {
        length += Math.hypot(p[0] - cx, p[1] - cy);
        pushVert(p, [0, 0], [0, 0]);
        cx = p[0];
        cy = p[1];
      }
    } else if (c === "Z") {
      closed = true;
      length += Math.hypot(sx - cx, sy - cy);
      cx = sx;
      cy = sy;
    }
  }
  return { verts, inT, outT, closed, length };
}
function convertHtmlToLayers(html, opts = {}) {
  const warnings = [];
  const W = opts.width || 1920, H = opts.height || 1080, DUR = opts.duration || 10, FPS = opts.frameRate || 30;
  const SC = opts.scale || 1;
  let root = parseHTML(html);
  const hasBody = root.children.some((c) => c.tag === "body") || root.children.some((c) => c.children.some((g) => g.tag === "body"));
  if (!hasBody) {
    const body = { tag: "body", attrs: {}, children: root.children, parent: null, order: 0 };
    for (const c of body.children) c.parent = body;
    root = { tag: "#root", attrs: {}, children: [body], parent: null, order: 0 };
  }
  const stylesNodes = collectStyleText(root);
  const { rules, keyframes } = parseCSS(stylesNodes.css, W, H);
  injectPseudos(root, rules);
  const styles = computeStyles(root, rules, W, H);
  const tree = layoutTree(root, styles, W, H, warnings);
  const layers = [];
  const usedNames = /* @__PURE__ */ new Set();
  const unique = (base) => {
    let nm = base || "Layer", k = 2;
    while (usedNames.has(nm)) nm = `${base} ${k++}`;
    usedNames.add(nm);
    return nm;
  };
  const bodyStyle = styles.get(tree.el) || {};
  const bodyBg = parseColor(bodyStyle["background-color"] || bodyStyle["background"] || "");
  const htmlBg = parseColor(bodyStyle["background-color"] || "");
  const bgColor = htmlBg ?? bodyBg ? [(htmlBg ?? bodyBg)[0], (htmlBg ?? bodyBg)[1], (htmlBg ?? bodyBg)[2]] : null;
  const mixOver = (c, bg) => {
    if (c[3] >= 0.999 || !bg) return [c[0], c[1], c[2]];
    const a = Math.max(0, Math.min(1, c[3]));
    return [c[0] * a + bg[0] * (1 - a), c[1] * a + bg[1] * (1 - a), c[2] * a + bg[2] * (1 - a)];
  };
  const visit = (L) => {
    const st = L.style;
    const display = displayOf(L);
    if (display === "none" || st["visibility"] === "hidden") return;
    if (L.el.tag === "body" || L.el.tag === "html" || SKIP_TAGS.has(L.el.tag)) {
      for (const c of L.children) visit(c);
      return;
    }
    const op = st["opacity"] !== void 0 ? parseFloat(st["opacity"]) : 1;
    const anim = parseAnim(st, warnings);
    if (!isNaN(op) && op <= 0 && !anim) return;
    const baseX = parseTransform(st["transform"]);
    if (L.el.tag === "svg") {
      emitSvg(L, anim);
      return;
    }
    const trim = {};
    const ds = L.el.attrs["data-start"];
    const dd = L.el.attrs["data-duration"];
    if (ds !== void 0 && /^\d/.test(ds.trim())) {
      const v = parseFloat(ds) * (ds.includes("ms") ? 1e-3 : 1);
      if (!isNaN(v)) trim.startTime = Math.max(v, 0);
    }
    if (dd !== void 0 && /^\d/.test(dd.trim())) {
      const v = parseFloat(dd) * (dd.includes("ms") ? 1e-3 : 1);
      if (!isNaN(v) && v > 0) trim.duration = v;
    }
    const hasOwnText = L.textLines.length > 0;
    const bgLayersStr = st["background-image"] || "";
    const bgRaw = st["background-color"] || "";
    const bg = parseColor(bgRaw && bgRaw !== "transparent" ? bgRaw : "");
    const bLayerList = bgLayersStr ? backgroundLayers(bgLayersStr) : [];
    const baseLayerStr = bLayerList.length ? bLayerList[bLayerList.length - 1] : /(linear|radial)-gradient/i.test(st["background"] || "") ? st["background"] : "";
    const grad = baseLayerStr ? parseGradientLayer(baseLayerStr, L.box, W, H) : null;
    const extraGrads = [];
    if (bLayerList.length > 1 && !st["background-size"]) {
      for (let i = bLayerList.length - 2; i >= 0; i--) {
        const gg = parseGradientLayer(bLayerList[i], L.box, W, H);
        if (gg) extraGrads.push({ g: gg, name: unique(`${nodeName(L)} bg ${i + 1}`) });
      }
    }
    const sides = { top: { w: px(st["border-top-width"], 0, L.fontSize) || 0, c: borderColorOf(st["border-top-color"], st) }, right: { w: px(st["border-right-width"], 0, L.fontSize) || 0, c: borderColorOf(st["border-right-color"], st) }, bottom: { w: px(st["border-bottom-width"], 0, L.fontSize) || 0, c: borderColorOf(st["border-bottom-color"], st) }, left: { w: px(st["border-left-width"], 0, L.fontSize) || 0, c: borderColorOf(st["border-left-color"], st) } };
    const sidesOn = ["top", "right", "bottom", "left"].filter((s) => sides[s].w > 0 && sides[s].c);
    const uniformBorder = sidesOn.length >= 2 ? { w: sides[sidesOn[0]].w, c: sides[sidesOn[0]].c } : null;
    const brRaw = st["border-radius"];
    const brPct = brRaw && brRaw.trim().endsWith("%") ? parseFloat(brRaw) / 100 : 0;
    const brPx = brRaw && !brRaw.trim().endsWith("%") ? px(brRaw.split(/\s+/)[0], Math.min(L.box.w, L.box.h), L.fontSize) || 0 : 0;
    const isEllipse = brPct >= 0.5 || brPx > 0 && brPx >= Math.min(L.box.w, L.box.h) / 2 - 0.5;
    const hasBox = !!bg || grad || !!uniformBorder;
    const kf = anim ? keyframes.find((k) => k.name === anim.name) : null;
    if (anim && !kf) warnings.push(`@keyframes "${anim.name}" not found (element "${nodeName(L)}")`);
    const animProps = /* @__PURE__ */ new Set();
    if (kf) for (const stop of kf.stops) for (const d of stop.decls) animProps.add(d.prop);
    const zOrd = st["z-index"] ? parseInt(st["z-index"]) || 0 : 0;
    const domOrd = L.el.order;
    const hasXform = !!anim || baseX.tx !== 0 || baseX.ty !== 0 || baseX.sx !== 1 || baseX.sy !== 1 || baseX.rot !== 0;
    let pivot = null;
    const po = transformOriginPx(st, L.box, L.fontSize);
    if (po && hasXform) {
      const cx0 = L.box.x + L.box.w / 2, cy0 = L.box.y + L.box.h / 2;
      if (Math.abs(po[0] - cx0) > 0.5 || Math.abs(po[1] - cy0) > 0.5) pivot = po;
    }
    const refX = (pivot ? pivot[0] : L.box.x + L.box.w / 2) * SC;
    const refY = (pivot ? pivot[1] : L.box.y + L.box.h / 2) * SC;
    const commonStatic = () => ({
      pos: [refX + baseX.tx * SC - W / 2, H / 2 - (refY + baseX.ty * SC)],
      rotation: -baseX.rot,
      scale: [baseX.sx * 100, baseX.sy * 100],
      opacity: (isNaN(op) ? 1 : op) * 100
    });
    const anchorFor = (kind) => {
      if (!pivot) return void 0;
      const dx = (pivot[0] - (L.box.x + L.box.w / 2 + baseX.tx)) * SC;
      const dy = (pivot[1] - (L.box.y + L.box.h / 2 + baseX.ty)) * SC;
      return kind === "solid" ? [L.box.w * SC / 2 + dx, L.box.h * SC / 2 + dy] : [dx, dy];
    };
    const gradToLayer = (gs, kind, P, A) => {
      const a0 = A ? A[0] : 0, a1y = A ? A[1] : 0;
      const conv = (g) => {
        const d0 = g[0] - P[0], d1 = g[1] - P[1];
        return [a0 + d0, a1y - d1];
      };
      return { start: conv(gs.start), end: conv(gs.end), c1: gs.c1, c2: gs.c2, a1: gs.a1, a2: gs.a2, radial: gs.radial };
    };
    if (hasBox && L.box.w > 0 && L.box.h > 0) {
      const shadow = parseShadow(st["box-shadow"] || st["text-shadow"]);
      const animatesColor = animProps.has("background-color") || animProps.has("background");
      const needShape = isEllipse || !!grad || animatesColor || !!uniformBorder;
      const kindL = needShape ? "shape" : "solid";
      const stat = commonStatic();
      const A0 = anchorFor(kindL);
      const layer = {
        kind: kindL,
        name: unique(nodeName(L)),
        w: L.box.w * SC,
        h: L.box.h * SC,
        ...stat,
        anchor: A0,
        shape: isEllipse ? "ellipse" : "rect",
        roundness: isEllipse ? void 0 : Math.min(brPx * SC, Math.min(L.box.w, L.box.h) / 2),
        // no background-color and no gradient -> stroke-only shape (null fill), never a black disc
        fill: needShape ? bg ? mixOver(bg, bgColor) : grad ? grad.c1 : null : void 0,
        stroke: uniformBorder ? [uniformBorder.c[0], uniformBorder.c[1], uniformBorder.c[2]] : null,
        strokeWidth: uniformBorder ? uniformBorder.w * SC : void 0,
        color: !needShape && bg ? mixOver(bg, bgColor) : void 0,
        gradient: grad ? gradToLayer(grad, kindL, stat.pos, A0) : null,
        shadow,
        fillOverride: null,
        keys: {}
      };
      if (anim && kf) applyKeyframes(layer, kf, anim, L, baseX, pivot, W, H, DUR, FPS, SC, animProps, warnings);
      layers.push({ ...layer, ...trim, _z: zOrd, _dom: domOrd });
      if (!uniformBorder && sidesOn.length === 1) {
        const s = sidesOn[0];
        const bw = sides[s].w, bc = sides[s].c;
        const edge = s === "bottom" ? { x: L.box.x, y: L.box.y + L.box.h - bw, w: L.box.w, h: bw } : s === "top" ? { x: L.box.x, y: L.box.y, w: L.box.w, h: bw } : s === "left" ? { x: L.box.x, y: L.box.y, w: bw, h: L.box.h } : { x: L.box.x + L.box.w - bw, y: L.box.y, w: bw, h: L.box.h };
        layers.push({
          kind: "solid",
          name: unique(`${nodeName(L)} border-${s}`),
          w: edge.w * SC,
          h: edge.h * SC,
          pos: [edge.x + edge.w / 2 - W / 2, H / 2 - (edge.y + edge.h / 2)],
          rotation: 0,
          scale: [100, 100],
          opacity: (isNaN(op) ? 1 : op) * 100,
          color: mixOver(bc, bgColor),
          keys: {}
        });
      }
      for (const ex of extraGrads) {
        const g = ex.g;
        if (g.radial) {
          layers.push({
            kind: "shape",
            name: ex.name,
            w: 2 * g.r * SC,
            h: 2 * g.r * SC,
            pos: [g.center[0] - W / 2, H / 2 - g.center[1]],
            rotation: 0,
            scale: [100, 100],
            opacity: (isNaN(op) ? 1 : op) * 100,
            shape: "ellipse",
            fill: g.c1,
            gradient: { start: [0, 0], end: [g.r * SC, 0], c1: g.c1, c2: g.c2, a1: g.a1, a2: g.a2, radial: true },
            shadow: null,
            fillOverride: null,
            keys: {}
          });
        } else {
          const posE = [L.box.x + L.box.w / 2 - W / 2, H / 2 - (L.box.y + L.box.h / 2)];
          layers.push({
            kind: "shape",
            name: ex.name,
            w: L.box.w * SC,
            h: L.box.h * SC,
            pos: posE,
            rotation: 0,
            scale: [100, 100],
            opacity: (isNaN(op) ? 1 : op) * 100,
            shape: "rect",
            fill: g.c1,
            gradient: gradToLayer(g, "shape", posE, void 0),
            shadow: null,
            fillOverride: null,
            keys: {}
          });
        }
      }
    }
    if (L.el.tag === "img") {
      const src = L.el.attrs["src"] || "";
      const file = src.replace(/^file:\/\//, "").replace(/^\.\//, "");
      const imgLayer = {
        kind: "footage",
        name: unique(nodeName(L)),
        w: L.box.w * SC,
        h: L.box.h * SC,
        ...commonStatic(),
        file: /^([a-zA-Z]:[\\/]|\/)/.test(file) ? file : void 0,
        keys: {}
      };
      if (anim && kf) applyKeyframes(imgLayer, kf, anim, L, baseX, pivot, W, H, DUR, FPS, SC, animProps, warnings);
      layers.push({ ...imgLayer, ...trim, _z: zOrd, _dom: domOrd });
      if (!/^([a-zA-Z]:[\\/]|\/)/.test(file)) warnings.push(`img src "${src}" is not an absolute path; a placeholder will be needed`);
    }
    if (hasOwnText) {
      const color2 = parseColor(st["color"] || "#000000") || [0, 0, 0, 1];
      const weight = parseFloat(st["font-weight"]) || (st["font-weight"] === "bold" ? 700 : 400);
      const famRaw = (st["font-family"] || "Arial").split(",")[0].trim().replace(/["']/g, "");
      const fam = /sans-serif/i.test(famRaw) ? "Arial" : /serif/i.test(famRaw) && !/sans/i.test(famRaw) ? "Times New Roman" : /mono/i.test(famRaw) ? "Courier New" : famRaw;
      const font = weight >= 600 ? fam + " Bold" : fam;
      const ls = px(st["letter-spacing"], 0, L.fontSize) || 0;
      let lh = L.fontSize * 1.2;
      const lhRaw2 = (st["line-height"] || "").trim();
      if (lhRaw2 && lhRaw2 !== "normal") {
        if (/^[\d.]+$/.test(lhRaw2)) lh = parseFloat(lhRaw2) * L.fontSize;
        else lh = px(lhRaw2, L.fontSize, L.fontSize) ?? (parseFloat(lhRaw2) * L.fontSize || L.fontSize * 1.2);
      }
      const ta = st["text-align"] || "left";
      const just = ta === "center" ? "center" : ta === "right" || ta === "end" ? "right" : "left";
      const padL = px(st["padding-left"], 0, L.fontSize) || 0, padR = px(st["padding-right"], 0, L.fontSize) || 0;
      const anchorX = just;
      const textPosX = just === "center" ? L.box.x + L.box.w / 2 : just === "right" ? L.box.x + L.box.w - padR : L.box.x + padL;
      const padT0 = px(st["padding-top"], 0, L.fontSize) || 0;
      const bT0 = px(st["border-top-width"], 0, L.fontSize) || 0;
      const textCenterY = L.box.y + padT0 + bT0 + L.textLines.length * lh / 2;
      const tRefX = (pivot ? pivot[0] : textPosX) * SC;
      const tRefY = (pivot ? pivot[1] : textCenterY) * SC;
      const layer = {
        kind: "text",
        name: unique((L.textLines[0] || "Text").slice(0, 30) || nodeName(L)),
        w: L.box.w * SC,
        h: L.box.h * SC,
        pos: [tRefX + baseX.tx * SC - W / 2, H / 2 - (tRefY + baseX.ty * SC)],
        rotation: -baseX.rot,
        scale: [baseX.sx * 100, baseX.sy * 100],
        opacity: (isNaN(op) ? 1 : op) * 100,
        anchorX,
        anchorOffset: pivot ? [(pivot[0] - textPosX) * SC, (pivot[1] - textCenterY) * SC] : void 0,
        text: L.textLines.join("\r"),
        font,
        fontSize: L.fontSize * SC,
        justification: just,
        tracking: ls ? Math.round(ls * 1e3 / Math.max(L.fontSize, 1)) : void 0,
        leading: lh * SC,
        color: mixOver(color2, bgColor),
        shadow: parseShadow(st["text-shadow"]),
        keys: {}
      };
      if (anim && kf) applyKeyframes(layer, kf, anim, L, baseX, pivot, W, H, DUR, FPS, SC, animProps, warnings);
      layers.push({ ...layer, ...trim, _z: zOrd, _dom: domOrd });
    }
    for (const c of L.children) visit(c);
  };
  visit(tree);
  function emitSvg(L, svgAnim) {
    const box = L.box;
    if (box.w <= 0 || box.h <= 0) return;
    const vb = (L.el.attrs["viewbox"] || L.el.attrs["viewBox"] || "").trim().split(/[\s,]+/).map(Number);
    const hasVB = vb.length === 4 && vb.every((n) => !isNaN(n));
    const sx = hasVB ? box.w / vb[2] : 1, sy = hasVB ? box.h / vb[3] : 1;
    const op = L.style["opacity"] !== void 0 ? parseFloat(L.style["opacity"]) : 1;
    const mapPt = (x, y) => [box.x + x * sx, box.y + y * sy];
    const toAE = (x, y) => [x - W / 2, H / 2 - y];
    const stOf = (el) => styles.get(el) || {};
    const strokeOf = (el, st) => borderColorOf(st["stroke"] || el.attrs["stroke"] || "", st);
    const widthOf = (el, st) => px(st["stroke-width"] || el.attrs["stroke-width"], 0, L.fontSize) || 1;
    const fillOf = (el, st) => {
      const f = st["fill"] || el.attrs["fill"] || "";
      if (!f || f === "none") return null;
      if (/url\(/.test(f)) return null;
      return parseColor(f);
    };
    let warnedUrl = false;
    const svgOpacity = (el, st) => {
      const a = st["opacity"] !== void 0 ? parseFloat(st["opacity"]) : el.attrs["opacity"] !== void 0 ? parseFloat(el.attrs["opacity"]) : 1;
      return (isNaN(a) ? 1 : a) * (isNaN(op) ? 1 : op) * 100;
    };
    const visitSvg = (el) => {
      for (const c of el.children) {
        const st = stOf(c);
        const o = svgOpacity(c, st);
        if (o <= 0) continue;
        if (c.tag === "path" || c.tag === "line" || c.tag === "polyline" || c.tag === "polygon") {
          let data = null;
          if (c.tag === "path" && c.attrs["d"]) data = parsePathData(c.attrs["d"]);
          else if (c.tag === "line") data = { verts: [[+c.attrs["x1"], +c.attrs["y1"]], [+c.attrs["x2"], +c.attrs["y2"]]], inT: [[0, 0], [0, 0]], outT: [[0, 0], [0, 0]], closed: false, length: Math.hypot(+c.attrs["x2"] - +c.attrs["x1"], +c.attrs["y2"] - +c.attrs["y1"]) };
          else {
            const pts = (c.attrs["points"] || "").trim().split(/[\s,]+/).map(Number);
            const vv = [];
            for (let k = 0; k + 1 < pts.length; k += 2) vv.push([pts[k], pts[k + 1]]);
            if (vv.length >= 2) {
              let len = 0;
              for (let k = 1; k < vv.length; k++) len += Math.hypot(vv[k][0] - vv[k - 1][0], vv[k][1] - vv[k - 1][1]);
              data = { verts: vv, inT: vv.map(() => [0, 0]), outT: vv.map(() => [0, 0]), closed: c.tag === "polygon", length: len };
            }
          }
          if (data && data.verts.length >= 2) {
            const fill = fillOf(c, st);
            if (!fill && /url\(/.test(st["fill"] || c.attrs["fill"] || "") && !warnedUrl) {
              warnings.push('svg fill="url(#...)" gradients are approximated (no fill)');
              warnedUrl = true;
            }
            const stroke = strokeOf(c, st);
            const sw = widthOf(c, st) * ((sx + sy) / 2);
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            const mapped = data.verts.map(([x, y]) => mapPt(x, y));
            for (const [x, y] of mapped) {
              minX = Math.min(minX, x);
              minY = Math.min(minY, y);
              maxX = Math.max(maxX, x);
              maxY = Math.max(maxY, y);
            }
            const cxA = (minX + maxX) / 2, cyA = (minY + maxY) / 2;
            const layer = {
              kind: "shape",
              name: unique(c.attrs["class"] ? `path.${c.attrs["class"].split(/\s+/)[0]}` : c.tag),
              w: Math.max(maxX - minX, 1) * SC,
              h: Math.max(maxY - minY, 1) * SC,
              pos: [cxA - W / 2, H / 2 - cyA],
              rotation: 0,
              scale: [100, 100],
              opacity: o,
              shape: "path",
              path: {
                verts: mapped.map(([x, y]) => [(x - cxA) * SC, (y - cyA) * -SC]),
                inT: data.inT.map(([x, y]) => [x * sx * SC, -y * sy * SC]),
                outT: data.outT.map(([x, y]) => [x * sx * SC, -y * sy * SC]),
                closed: data.closed
              },
              fill: fill ? mixOver(fill, bgColor) : null,
              stroke: stroke ? mixOver(stroke, bgColor) : null,
              strokeWidth: sw * SC,
              shadow: null,
              fillOverride: null,
              keys: {}
            };
            const anim = parseAnim(st, warnings);
            const kf2 = anim ? keyframes.find((k) => k.name === anim.name) : null;
            if (anim && kf2) {
              const dashLen = parseFloat(st["stroke-dasharray"] || c.attrs["stroke-dasharray"] || "0") || data.length || 1;
              const timing = parseTiming(anim.timing);
              const trims = [];
              const staticOff = Math.abs(parseFloat(st["stroke-dashoffset"] || c.attrs["stroke-dashoffset"] || "0")) || Math.min(dashLen, data.length);
              const stops2 = [...kf2.stops];
              if (stops2.length && stops2[0].pct > 0) stops2.unshift({ pct: 0, decls: [] });
              if (stops2.length && stops2[stops2.length - 1].pct < 100) stops2.push({ pct: 100, decls: [] });
              for (const s of stops2) {
                const off = s.decls.find((d) => d.prop === "stroke-dashoffset");
                const v0 = off ? Math.abs(parseFloat(off.value)) : staticOff;
                const pct = Math.max(0, Math.min(100, (1 - Math.min(v0, data.length || dashLen) / (data.length || dashLen)) * 100));
                const t = Math.round((s.pct / 100 * anim.duration + anim.delay) * FPS) / FPS;
                if (t <= DUR + 1e-6) trims.push({ t, v: pct, ...timing });
              }
              trims.sort((a, b) => a.t - b.t);
              if (trims.length) layer.keys.TrimEnd = trims;
            }
            layers.push(layer);
          }
        } else if (c.tag === "circle" || c.tag === "ellipse") {
          const cxN = parseFloat(c.attrs["cx"] || "0"), cyN = parseFloat(c.attrs["cy"] || "0");
          const rx = parseFloat(c.attrs["rx"] || c.attrs["r"] || "0"), ry = parseFloat(c.attrs["ry"] || c.attrs["r"] || "0");
          if (rx > 0 && ry > 0) {
            const [pxA, pyA] = mapPt(cxN, cyN);
            const fill = fillOf(c, st), stroke = strokeOf(c, st);
            layers.push({
              kind: "shape",
              name: unique(c.attrs["class"] ? `${c.tag}.${c.attrs["class"].split(/\s+/)[0]}` : c.tag),
              w: 2 * rx * sx * SC,
              h: 2 * ry * sy * SC,
              pos: [pxA - W / 2, H / 2 - pyA],
              rotation: 0,
              scale: [100, 100],
              opacity: svgOpacity(c, st),
              shape: "ellipse",
              fill: fill ? mixOver(fill, bgColor) : null,
              stroke: stroke ? mixOver(stroke, bgColor) : null,
              strokeWidth: stroke ? widthOf(c, st) * ((sx + sy) / 2) * SC : void 0,
              shadow: null,
              fillOverride: null,
              keys: {}
            });
          }
        } else {
          visitSvg(c);
        }
      }
    };
    visitSvg(L.el);
  }
  layers.sort((a, b) => a._z - b._z || a._dom - b._dom);
  for (const l of layers) {
    delete l._z;
    delete l._dom;
  }
  if (!layers.length) warnings.push("No convertible elements found (need visible text or background-colored elements)");
  return {
    createComp: opts.createComp !== false,
    compName: opts.compName || "HTML Motion",
    width: W,
    height: H,
    duration: DUR,
    frameRate: FPS,
    bgColor,
    clearComp: false,
    layers,
    warnings
  };
  function parseShadow(v) {
    if (!v || v === "none") return null;
    const first = splitTop(v, ",").map((s) => s.trim()).find((s) => s && !/\binset\b/.test(s));
    if (!first) return null;
    const parts = splitTop(first, " ").map((s) => s.trim());
    const col = parts.map((p) => parseColor(p)).find(Boolean);
    const nums = parts.filter((p) => /^[-\d.]+(px|em)?$/.test(p)).map((p) => parseFloat(p) || 0);
    if (nums.length < 2) return null;
    const [ox, oy, blur = 0] = nums;
    const alpha = col ? col[3] : 1;
    return {
      direction: Math.atan2(oy, ox) * 180 / Math.PI,
      distance: Math.hypot(ox, oy) * SC,
      opacity: alpha * 100,
      softness: Math.max(blur * 0.5 * SC, 0),
      color: col ? mixOver(col, bgColor) : [0, 0, 0]
    };
  }
  function nodeName(L) {
    if (L.el.attrs["data-pseudo"] !== void 0) {
      const pc = L.parent ? L.parent.el.attrs["class"] || L.parent.el.tag : "el";
      return `${pc}:${L.el.attrs["class"] === "ae-pseudo" ? "after" : "pseudo"}`;
    }
    const id = L.el.attrs["id"];
    const cls = (L.el.attrs["class"] || "").split(/\s+/)[0];
    return id ? id : cls ? `${L.el.tag}.${cls}` : L.el.tag;
  }
  function applyKeyframes(layer, kf, anim, L, base, pivot, Wc, Hc, dur, fps, sc, animProps, warns) {
    const norm = [];
    if (kf.stops.length) {
      const mk = (s) => ({ pct: s.pct, decls: s.decls, isSynth: false });
      if (kf.stops[0].pct > 0) norm.push({ pct: 0, decls: [], isSynth: true });
      for (const s of kf.stops) norm.push(mk(s));
      if (kf.stops[kf.stops.length - 1].pct < 100) norm.push({ pct: 100, decls: [], isSynth: true });
    }
    const snap = (stop) => {
      const merged = {};
      for (const d of stop.decls) merged[d.prop] = d.value;
      const st0 = L.style;
      const bx = cloneX(base);
      const xf = parseTransform(merged["transform"]);
      bx.tx += xf.tx;
      bx.ty += xf.ty;
      bx.sx *= xf.sx;
      bx.sy *= xf.sy;
      bx.rot += xf.rot;
      const out = { ...bx };
      const op0 = merged["opacity"] ?? (stop.isSynth ? st0["opacity"] : void 0);
      if (op0 !== void 0) out.opacity = parseFloat(op0) * 100;
      const c = parseColor(merged["background-color"] || merged["background"] || merged["color"] || (stop.isSynth ? st0["background-color"] || st0["background"] || st0["color"] || "" : ""));
      if (c) out.color = [c[0], c[1], c[2]];
      const top0 = merged["top"] ?? (stop.isSynth ? st0["top"] : void 0);
      if (top0 !== void 0) out.top = px(top0, L.parent ? L.parent.box.h : Hc, L.fontSize);
      const left0 = merged["left"] ?? (stop.isSynth ? st0["left"] : void 0);
      if (left0 !== void 0) out.left = px(left0, L.parent ? L.parent.box.w : Wc, L.fontSize);
      const w0 = merged["width"] ?? (stop.isSynth ? st0["width"] : void 0);
      if (w0 !== void 0) out.w = px(w0, L.box.w, L.fontSize);
      const h0 = merged["height"] ?? (stop.isSynth ? st0["height"] : void 0);
      if (h0 !== void 0) out.h = px(h0, L.box.h, L.fontSize);
      return out;
    };
    const timing = parseTiming(anim.timing);
    const cycle = anim.duration || 1;
    const repeats = anim.iter === "infinite" ? Math.min(Math.ceil(dur / Math.max(cycle, 0.01)), 40) : Math.max(Math.round(anim.iter), 1);
    const keys = { Position: [], Scale: [], Rotation: [], Opacity: [], FillColor: [], RectSize: [], TrimEnd: [] };
    const toAE = (x, y) => [x - Wc / 2, Hc / 2 - y];
    const maxKeysPerProp = 400;
    const refX = pivot ? pivot[0] : L.box.x + L.box.w / 2;
    const refY = pivot ? pivot[1] : L.box.y + L.box.h / 2;
    const allTransform = kf.stops.map((s) => s.decls.filter((d) => d.prop === "transform").map((d) => d.value).join(" ")).join(" ");
    const hasScale = /scale/i.test(allTransform);
    const hasTranslate = /translate/i.test(allTransform) || animProps.has("top") || animProps.has("left");
    const hasRotate = /rotate/i.test(allTransform);
    const hasOpacity = animProps.has("opacity");
    const hasColor = animProps.has("background-color") || animProps.has("background") || animProps.has("color");
    const hasSize = animProps.has("width") || animProps.has("height");
    for (let r = 0; r < repeats; r++) {
      const reversed = anim.direction === "alternate" && r % 2 === 1;
      const stops = reversed ? [...norm].reverse() : norm;
      for (const stop of stops) {
        const localT = (reversed ? 100 - stop.pct : stop.pct) / 100 * anim.duration + anim.delay + r * anim.duration;
        const t = Math.round(localT * fps) / fps;
        if (t > dur + 1e-6 || t < 0) continue;
        const s = snap(stop);
        if (hasOpacity && s.opacity !== void 0 && keys.Opacity.length < maxKeysPerProp) keys.Opacity.push({ t, v: s.opacity, ...timing });
        if (hasColor && s.color && keys.FillColor.length < maxKeysPerProp) keys.FillColor.push({ t, v: s.color, ...timing });
        let ax = refX + s.tx;
        let ay = refY + s.ty;
        if (s.left !== void 0 && s.left !== null) {
          const baseLeft = px(L.style["left"], L.parent ? L.parent.box.w : Wc, L.fontSize);
          if (baseLeft === null) ax = s.left + (refX - L.box.x);
          else ax = refX + (s.left - baseLeft);
        }
        if (s.top !== void 0 && s.top !== null) {
          const baseTop = px(L.style["top"], L.parent ? L.parent.box.h : Hc, L.fontSize);
          if (baseTop === null) ay = s.top + (refY - L.box.y);
          else ay = refY + (s.top - baseTop);
        }
        if (hasTranslate && keys.Position.length < maxKeysPerProp) keys.Position.push({ t, v: toAE(ax * sc, ay * sc), ...timing });
        if (hasScale && keys.Scale.length < maxKeysPerProp) keys.Scale.push({ t, v: [s.sx * 100, s.sy * 100], ...timing });
        if (hasRotate && keys.Rotation.length < maxKeysPerProp) keys.Rotation.push({ t, v: -s.rot, ...timing });
        if (hasSize && layer.kind === "shape" && layer.shape === "rect" && keys.RectSize.length < maxKeysPerProp) {
          keys.RectSize.push({ t, v: [(s.w ?? L.box.w) * sc, (s.h ?? L.box.h) * sc], ...timing });
        }
      }
    }
    for (const k of Object.keys(keys)) {
      keys[k]?.sort((a, b) => a.t - b.t);
      const arr = keys[k];
      if (arr && arr.length) {
        const dedup = [];
        for (const kk of arr) {
          const last = dedup[dedup.length - 1];
          if (last && Math.abs(last.t - kk.t) < 1e-6 && JSON.stringify(last.v) === JSON.stringify(kk.v)) continue;
          dedup.push(kk);
        }
        keys[k] = dedup;
      } else delete keys[k];
    }
    if (keys.FillColor && layer.kind === "solid") {
      layer.fillOverride = layer.color || [0, 0, 0];
    }
    if (keys.FillColor && layer.kind === "text") {
      layer.fillOverride = layer.color;
    }
    layer.keys = keys;
    void warns;
  }
}
function collectStyleText(root) {
  let css = "";
  const walk = (el) => {
    if (el.tag === "style" && el.text) css += "\n" + el.text;
    for (const c of el.children) walk(c);
  };
  walk(root);
  return { css };
}
var VOID, RAW, SKIP_TAGS, INHERITED, NAMED_COLORS, BLOCK, INLINE, ARIAL_W, ARIAL_B;
var init_html2ae = __esm({
  "src/html2ae.ts"() {
    "use strict";
    VOID = /* @__PURE__ */ new Set(["br", "hr", "img", "input", "meta", "link", "hr", "source", "wbr", "col", "area", "base", "embed", "track"]);
    RAW = /* @__PURE__ */ new Set(["style", "script"]);
    SKIP_TAGS = /* @__PURE__ */ new Set(["style", "script", "head", "meta", "link", "title", "base"]);
    INHERITED = /* @__PURE__ */ new Set(["font-size", "font-family", "font-weight", "font-style", "color", "text-align", "letter-spacing", "line-height", "text-transform", "white-space"]);
    NAMED_COLORS = {
      white: "#ffffff",
      black: "#000000",
      red: "#ff0000",
      green: "#008000",
      blue: "#0000ff",
      yellow: "#ffff00",
      orange: "#ffa500",
      purple: "#800080",
      pink: "#ffc0cb",
      gray: "#808080",
      grey: "#808080",
      silver: "#c0c0c0",
      maroon: "#800000",
      navy: "#000080",
      teal: "#008080",
      aqua: "#00ffff",
      cyan: "#00ffff",
      fuchsia: "#ff00ff",
      magenta: "#ff00ff",
      lime: "#00ff00",
      olive: "#808000",
      gold: "#ffd700",
      crimson: "#dc143c",
      tomato: "#ff6347",
      coral: "#ff7f50",
      salmon: "#fa8072",
      khaki: "#f0e68c",
      indigo: "#4b0082",
      violet: "#ee82ee",
      turquoise: "#40e0d0",
      skyblue: "#87ceeb",
      lightgray: "#d3d3d3",
      lightgrey: "#d3d3d3",
      darkgray: "#a9a9a9",
      dimgray: "#696969",
      whitesmoke: "#f5f5f5",
      ivory: "#fffff0",
      beige: "#f5f5dc",
      brown: "#a52a2a",
      chocolate: "#d2691e",
      transparent: "rgba(0,0,0,0)"
    };
    BLOCK = /* @__PURE__ */ new Set(["div", "p", "h1", "h2", "h3", "h4", "h5", "h6", "section", "header", "footer", "main", "article", "aside", "nav", "ul", "ol", "li", "form", "figure", "figcaption", "blockquote", "address", "fieldset", "details", "summary"]);
    INLINE = /* @__PURE__ */ new Set(["span", "a", "strong", "em", "b", "i", "u", "small", "code", "label", "mark", "abbr", "time"]);
    ARIAL_W = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
    ARIAL_B = [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584];
  }
});

// src/daemon.ts
import http from "node:http";
import { randomUUID } from "node:crypto";
import fs2 from "node:fs";
import path2 from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import os2 from "node:os";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

// src/hub.ts
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
var LOG_DIR = path.join(os.homedir(), ".ae-supreme-mcp", "logs");
function clip(v, max = 2e4) {
  if (v === void 0) return void 0;
  let s;
  try {
    s = JSON.stringify(v);
  } catch {
    s = String(v);
  }
  if (s === void 0 || s.length <= max) return v;
  return { _truncated: true, bytes: s.length, preview: s.slice(0, max) };
}
var Bridge = class {
  constructor(hub2) {
    this.hub = hub2;
  }
  sock = null;
  info = null;
  latencyMs = null;
  connectedAt = 0;
  expectedToken = null;
  // set by the daemon at startup; hello must present it
  authed = false;
  pending = /* @__PURE__ */ new Map();
  chain = Promise.resolve();
  seq = 1;
  hb;
  lastPong = 0;
  get connected() {
    return !!this.sock && this.sock.readyState === 1;
  }
  get authenticated() {
    return this.connected && this.authed;
  }
  status() {
    return { connected: this.connected, info: this.info, latencyMs: this.latencyMs, since: this.connected ? this.connectedAt : null, queued: this.pending.size };
  }
  attach(ws) {
    if (this.sock) {
      try {
        this.sock.close(4e3, "replaced");
      } catch {
      }
      this.failAll("Bridge replaced by a new connection");
    }
    this.sock = ws;
    this.connectedAt = Date.now();
    this.lastPong = Date.now();
    this.info = null;
    this.authed = false;
    ws.on("message", (raw) => this.onMessage(raw.toString()));
    ws.on("error", () => {
    });
    ws.on("close", () => {
      if (this.sock !== ws) return;
      this.sock = null;
      this.info = null;
      this.latencyMs = null;
      this.authed = false;
      clearInterval(this.hb);
      this.failAll("After Effects disconnected");
      this.hub.log({ kind: "bridge", level: "warn", message: "After Effects bridge disconnected" });
      this.hub.pushAe();
    });
    clearInterval(this.hb);
    this.hb = setInterval(() => {
      if (!this.connected) return;
      if (Date.now() - this.lastPong > 6e4) {
        ws.terminate();
        return;
      }
      if (!this.authed) {
        if (Date.now() - this.connectedAt > 5e3) {
          try {
            ws.close(4001, "auth timeout");
          } catch {
          }
        }
        return;
      }
      ws.send(JSON.stringify({ op: "ping", t: Date.now() }));
    }, 5e3);
    this.hub.log({ kind: "bridge", message: "After Effects bridge connected (waiting for hello)" });
    this.hub.pushAe();
  }
  failAll(why) {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(why));
    }
    this.pending.clear();
  }
  onMessage(raw) {
    let m;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    if (m.type === "pong") {
      this.lastPong = Date.now();
      this.latencyMs = Date.now() - m.t;
      this.hub.pushAe();
      return;
    }
    if (m.type === "hello") {
      if (this.expectedToken && m.token !== this.expectedToken) {
        this.hub.log({ kind: "bridge", level: "error", message: "Panel auth failed: bad or missing daemon token. Reinstall the panel or restart the daemon." });
        try {
          this.sock.close(4001, "bad token");
        } catch {
        }
        return;
      }
      this.authed = true;
      this.info = m.info || {};
      this.hub.log({ kind: "bridge", message: `After Effects ready: ${this.info.app ?? "AE"} ${this.info.version ?? ""} (panel ${m.panelVersion ?? "?"})` });
      this.hub.pushAe();
      return;
    }
    if (m.type === "panel-api") {
      this.hub.handlePanelApi(this, m);
      return;
    }
    if (!this.authed) return;
    if (m.type === "result") {
      const p = this.pending.get(m.id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(m.id);
      if (m.ok) p.resolve(m.result);
      else p.reject(new Error(String(m.error || "Unknown After Effects error") + (m.line ? ` (line ${m.line})` : "")));
    }
  }
  /** Commands run strictly one at a time: AE is single-threaded. */
  call(msg, timeoutMs = 3e4) {
    const run = () => new Promise((resolve, reject) => {
      if (!this.connected) return reject(new Error('After Effects is not connected. In AE open Window > Extensions > "After Effect Supreme MCP" and check the daemon URL.'));
      if (!this.authed) return reject(new Error("Panel connected but not authenticated (missing daemon token). Restart After Effects so the panel reloads, then check the panel log."));
      const id = this.seq++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out after ${timeoutMs}ms waiting for After Effects (busy, rendering, or a modal dialog is open).`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.sock.send(JSON.stringify({ id, ...msg }));
    });
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => {
    });
    return p;
  }
  sendDirect(msg) {
    if (this.connected) try {
      this.sock.send(JSON.stringify(msg));
    } catch {
    }
  }
};
var Hub = class extends EventEmitter {
  constructor(port) {
    super();
    this.port = port;
    this.bridge = new Bridge(this);
  }
  entries = [];
  clients = /* @__PURE__ */ new Map();
  settings = { allowRawScripts: true, readOnly: false };
  stats = { calls: 0, errors: 0, totalMs: 0 };
  startedAt = Date.now();
  version = "0.0.0";
  // daemon/package version, shown in the dashboard and panel
  bridge;
  lastViewport = null;
  viewportTimer = null;
  lastViewportReq = 0;
  seq = 1;
  send(msg) {
    this.emit("msg", msg);
  }
  /** Pull a compact comp snapshot from AE and push it to dashboard/panel listeners (debounced). */
  requestViewport(immediate = false) {
    if (!this.bridge.authenticated) return;
    if (!immediate && Date.now() - this.lastViewportReq < 3e3) return;
    if (this.viewportTimer) clearTimeout(this.viewportTimer);
    const run = async () => {
      this.viewportTimer = null;
      this.lastViewportReq = Date.now();
      try {
        const v = await this.bridge.call({ op: "call", fn: "viewport", args: {} }, 1e4);
        if (v && v.name) {
          if (v.playing && this.lastViewport?.data?.layers?.length) {
            this.lastViewport.data.time = v.time;
          } else {
            this.lastViewport = { data: v, ts: Date.now() };
          }
          this.send({ type: "viewport", viewport: this.lastViewport });
        }
      } catch {
      }
    };
    if (immediate) {
      if (this.viewportTimer) clearTimeout(this.viewportTimer);
      this.viewportTimer = null;
      void run();
    } else this.viewportTimer = setTimeout(run, 350);
  }
  /** Small request/response API used by the CEP panel over its existing bridge socket. */
  async handlePanelApi(bridge, m) {
    const reply = (ok, data) => bridge.sendDirect({ type: "panel-api-result", id: m.id, ok, ...ok ? { data } : { error: String(data) } });
    try {
      if (!bridge.authenticated) throw new Error("Panel not authenticated");
      const p = m.payload || {};
      if (m.api === "html2ae-preview") {
        const { convertHtmlToLayers: convertHtmlToLayers2 } = await Promise.resolve().then(() => (init_html2ae(), html2ae_exports));
        const plan = convertHtmlToLayers2(String(p.html || ""), p.options || {});
        reply(true, { layers: plan.layers.length, keyframes: plan.layers.reduce((n, l) => n + Object.values(l.keys || {}).reduce((a, k) => a + (k?.length || 0), 0), 0), compName: plan.compName, width: plan.width, height: plan.height, duration: plan.duration, frameRate: plan.frameRate, warnings: plan.warnings, layerNames: plan.layers.map((l) => `${l.kind}:${l.name}`) });
      } else if (m.api === "html2ae-apply") {
        if (this.settings.readOnly) throw new Error("Read-only mode is ON in the dashboard; HTML \u2192 AE would modify the project.");
        const { convertHtmlToLayers: convertHtmlToLayers2 } = await Promise.resolve().then(() => (init_html2ae(), html2ae_exports));
        const plan = convertHtmlToLayers2(String(p.html || ""), p.options || {});
        const res = await this.bridge.call({ op: "call", fn: "buildLayers", args: plan, undoName: "MCP: html2ae" }, 12e4);
        this.log({ kind: "tool", tool: "ae_html_to_layers", client: "panel", status: "ok", message: `HTML \u2192 AE: ${plan.layers.length} layers into "${res?.comp ?? plan.compName}"`, durationMs: 0 });
        this.requestViewport(true);
        const allWarnings = [...plan.warnings || [], ...res && res.warnings || []];
        reply(true, { ...res, warnings: allWarnings });
      } else if (m.api === "viewport") {
        const v = await this.bridge.call({ op: "call", fn: "viewport", args: p || {} }, 1e4);
        reply(true, v);
      } else if (m.api === "setTime") {
        const v = await this.bridge.call({ op: "call", fn: "setTime", args: p || {} }, 5e3);
        this.requestViewport(true);
        reply(true, v);
      } else throw new Error("Unknown panel api: " + m.api);
    } catch (e) {
      reply(false, e?.message ?? String(e));
    }
  }
  persist(e) {
    try {
      fs.mkdirSync(LOG_DIR, { recursive: true });
      fs.appendFileSync(path.join(LOG_DIR, (/* @__PURE__ */ new Date()).toISOString().slice(0, 10) + ".jsonl"), JSON.stringify(e) + "\n");
    } catch {
    }
  }
  log(e) {
    const entry = { id: this.seq++, ts: Date.now(), level: "info", ...e };
    this.entries.push(entry);
    if (this.entries.length > 2e3) this.entries.splice(0, this.entries.length - 2e3);
    this.send({ type: "entry", entry });
    if (entry.kind !== "tool") this.persist(entry);
    return entry;
  }
  update(id, patch) {
    let e;
    for (let i = this.entries.length - 1; i >= 0; i--) if (this.entries[i].id === id) {
      e = this.entries[i];
      break;
    }
    if (!e) return;
    Object.assign(e, patch);
    this.send({ type: "update", id, patch });
    if (patch.status && patch.status !== "running") this.persist(e);
  }
  finishTool(id, sessionId, ms, ok, payload) {
    this.stats.calls++;
    this.stats.totalMs += ms;
    if (!ok) this.stats.errors++;
    const c = sessionId ? this.clients.get(sessionId) : void 0;
    if (c) {
      c.calls++;
      if (!ok) c.errors++;
      c.lastSeen = Date.now();
    }
    this.update(id, ok ? { status: "ok", durationMs: ms, result: clip(payload) } : { status: "error", level: "error", durationMs: ms, error: String(payload) });
    this.send({ type: "stats", stats: this.stats });
    this.pushClients();
  }
  clientConnected(sessionId, info, remote) {
    const name = String(info?.name || "unknown-client"), version = String(info?.version || "");
    this.clients.set(sessionId, { sessionId, name, version, title: info?.title, connectedAt: Date.now(), lastSeen: Date.now(), calls: 0, errors: 0, connected: true, remote });
    this.log({ kind: "client", client: name, sessionId, message: `${name} ${version} connected` });
    this.pushClients();
  }
  clientDisconnected(sessionId) {
    const c = this.clients.get(sessionId);
    if (!c) return;
    c.connected = false;
    this.log({ kind: "client", level: "warn", client: c.name, sessionId, message: `${c.name} disconnected` });
    this.pushClients();
  }
  touch(sessionId) {
    const c = sessionId ? this.clients.get(sessionId) : void 0;
    if (c) c.lastSeen = Date.now();
  }
  sweep() {
    for (const [id, c] of this.clients) if (!c.connected && Date.now() - c.lastSeen > 10 * 6e4) this.clients.delete(id);
  }
  clientList() {
    return [...this.clients.values()].sort((a, b) => b.lastSeen - a.lastSeen);
  }
  pushClients() {
    this.send({ type: "clients", clients: this.clientList() });
  }
  pushAe() {
    this.send({ type: "ae", ae: this.bridge.status() });
  }
  setSettings(p) {
    if (typeof p.allowRawScripts === "boolean") this.settings.allowRawScripts = p.allowRawScripts;
    if (typeof p.readOnly === "boolean") this.settings.readOnly = p.readOnly;
    this.log({ kind: "system", level: "warn", message: `Settings changed: rawScripts=${this.settings.allowRawScripts}, readOnly=${this.settings.readOnly}` });
    this.send({ type: "settings", settings: this.settings });
  }
  clearLogs() {
    this.entries = [];
    this.send({ type: "snapshot", ...this.snapshot() });
  }
  snapshot() {
    return {
      now: Date.now(),
      startedAt: this.startedAt,
      port: this.port,
      version: this.version,
      clients: this.clientList(),
      ae: this.bridge.status(),
      settings: this.settings,
      stats: this.stats,
      entries: this.entries.slice(-500),
      viewport: this.lastViewport
    };
  }
};

// src/tools.ts
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
init_html2ae();
var INSTRUCTIONS = `Controls Adobe After Effects through a live bridge.
Workflow: ae_get_project -> ae_get_comp -> ae_inspect (discover property paths/matchNames) -> mutate.
For motion graphics built from HTML/CSS (the fast path): write a self-contained HTML snippet with <style>,
absolute positioning and @keyframes animations, then call ae_html_to_layers ONCE - it creates real AE layers
(text/solid/shape) with real keyframes, gradients (Ramp), box-shadows (Drop Shadow) and color animation.
Call ae_viewport afterwards to see the result as structured data.
Conventions: layer indexes are 1-based; times are seconds; colors are hex ("#ff3366") or [r,g,b] 0-1 (values >1 are read as 0-255);
property paths use "/" with display names or matchNames, e.g. "Transform/Position" or "Effects/Gaussian Blur/Blurriness".
Each tool call is a single undo step in After Effects. ae_execute_script runs arbitrary ExtendScript when no structured tool fits.`;
var compRef = z.union([z.string(), z.number().int()]).optional().describe("Composition name or project item index. Defaults to the active composition.");
var layerRef = z.union([z.string(), z.number().int()]).describe("Layer name or 1-based index.");
var propPath = z.string().describe('Property path separated by "/", display names or matchNames. e.g. "Transform/Opacity", "ADBE Transform Group/ADBE Position", "Contents/Group 1/Contents/Fill 1/Color". Use ae_inspect to discover.');
var color = z.union([z.string(), z.array(z.number()).min(3).max(4)]).describe('Hex "#rrggbb" or [r,g,b] in 0-1 (values >1 treated as 0-255).');
var easing = z.enum(["linear", "hold", "easeIn", "easeOut", "easeInOut"]);
function buildServer(hub2) {
  const server2 = new McpServer({ name: "ae-supreme-mcp", version: "0.3.6" }, { instructions: INSTRUCTIONS });
  const def = (name, description, shape, opts, run) => {
    server2.tool(name, description, shape, async (args, extra) => {
      const sid = extra?.sessionId;
      const client = sid ? hub2.clients.get(sid) : void 0;
      hub2.touch(sid);
      const entry = hub2.log({ kind: "tool", tool: name, client: client?.name ?? "unknown", sessionId: sid, status: "running", message: name, args: clip(args) });
      const t0 = Date.now();
      try {
        if (opts.raw && !hub2.settings.allowRawScripts) throw new Error("Raw script execution is disabled in the dashboard settings.");
        if (opts.mutating && hub2.settings.readOnly) throw new Error("Read-only mode is ON in the dashboard; this tool would modify the project.");
        const result = await run(args);
        hub2.finishTool(entry.id, sid, Date.now() - t0, true, result);
        if (opts.mutating) hub2.requestViewport();
        let text = JSON.stringify(result ?? null, null, 2);
        if (text.length > 1e5) text = text.slice(0, 1e5) + "\n... [truncated]";
        return { content: [{ type: "text", text }] };
      } catch (e) {
        const msg = e?.message ?? String(e);
        hub2.finishTool(entry.id, sid, Date.now() - t0, false, msg);
        return { isError: true, content: [{ type: "text", text: `Error: ${msg}` }] };
      }
    });
  };
  const call = (fn, args, o = {}) => hub2.bridge.call({ op: "call", fn, args, undoName: `MCP: ${fn}` }, o.timeoutMs);
  def("ae_status", "Daemon + After Effects connection status, connected AI clients, and active safety settings.", {}, {}, async () => ({
    afterEffects: hub2.bridge.status(),
    settings: hub2.settings,
    clients: hub2.clientList().map((c) => ({ name: c.name, version: c.version, connected: c.connected, calls: c.calls }))
  }));
  def(
    "ae_execute_script",
    "Run arbitrary ExtendScript inside After Effects. `code` is the BODY of a function: use `return` to send data back (must be JSON-able). Helpers: AEX.helpers.findComp(ref), findLayer(comp, ref), getProp(layer, path), setVal(prop, v, time), col(hexOrArray). Runs as one undo step. ES3 syntax (var, no arrow functions).",
    { code: z.string().describe("ExtendScript function body."), undoName: z.string().optional() },
    { mutating: true, raw: true, timeoutMs: 12e4 },
    (a) => hub2.bridge.call({ op: "exec", code: a.code, undoName: a.undoName || "MCP: script" }, 12e4)
  );
  def("ae_get_project", "List project items (comps, footage, folders, solids) and the active comp.", {}, {}, () => call("project", {}));
  def("ae_get_comp", "Composition settings plus a summary of every layer (type, in/out, parent, effects count).", { comp: compRef }, {}, (a) => call("comp", a));
  def(
    "ae_inspect",
    "Walk a layer's property tree (or a sub-path) returning names, matchNames, values, keyframe counts and expressions. Use this to discover property paths.",
    { comp: compRef, layer: layerRef, path: z.string().optional().describe("Sub-path to inspect; omit for the whole layer."), depth: z.number().int().min(0).max(6).optional().describe("Tree depth, default 2.") },
    {},
    (a) => call("inspect", a)
  );
  def(
    "ae_create_comp",
    "Create a composition and open it.",
    {
      name: z.string(),
      width: z.number().int().positive().optional(),
      height: z.number().int().positive().optional(),
      duration: z.number().positive().optional(),
      frameRate: z.number().positive().optional(),
      pixelAspect: z.number().positive().optional(),
      backgroundColor: color.optional()
    },
    { mutating: true },
    (a) => call("createComp", a)
  );
  def(
    "ae_add_layer",
    "Add a layer: text, solid, shape, null, camera, light, adjustment, footage (file path) or comp (precomp via `source`).",
    {
      comp: compRef,
      type: z.enum(["text", "solid", "shape", "null", "camera", "light", "adjustment", "footage", "comp"]),
      name: z.string().optional(),
      text: z.string().optional(),
      font: z.string().optional(),
      fontSize: z.number().optional(),
      color: color.optional(),
      width: z.number().optional(),
      height: z.number().optional(),
      position: z.array(z.number()).min(2).max(3).optional(),
      shape: z.enum(["rectangle", "ellipse", "star", "polygon"]).optional(),
      size: z.array(z.number()).length(2).optional(),
      points: z.number().int().optional(),
      fill: color.optional(),
      stroke: color.optional(),
      strokeWidth: z.number().optional(),
      startTime: z.number().optional(),
      duration: z.number().optional(),
      threeD: z.boolean().optional(),
      file: z.string().optional().describe('Absolute path for type "footage".'),
      source: z.union([z.string(), z.number().int()]).optional().describe('Comp to nest for type "comp".')
    },
    { mutating: true },
    (a) => call("addLayer", a)
  );
  def(
    "ae_set_property",
    "Set a property value (or a keyframe if `time` is given). Colors accept hex. Text: pass a string or {text,font,fontSize,fillColor,justification}.",
    { comp: compRef, layer: layerRef, path: propPath, value: z.any(), time: z.number().optional() },
    { mutating: true },
    (a) => call("setProperty", a)
  );
  def(
    "ae_set_keyframes",
    "Set multiple keyframes on a property with optional easing (linear, hold, easeIn, easeOut, easeInOut).",
    { comp: compRef, layer: layerRef, path: propPath, keys: z.array(z.object({ time: z.number(), value: z.any(), easing: easing.optional() })).min(1), clear: z.boolean().optional().describe("Remove existing keyframes first.") },
    { mutating: true },
    (a) => call("setKeyframes", a)
  );
  def(
    "ae_set_expression",
    "Set (or remove with empty string) an expression on a property. Returns expressionError if AE rejects it.",
    { comp: compRef, layer: layerRef, path: propPath, expression: z.string() },
    { mutating: true },
    (a) => call("setExpression", a)
  );
  def(
    "ae_add_effect",
    `Add an effect by display name or matchName (e.g. "ADBE Gaussian Blur 2") and optionally set parameters. Returns the effect's parameter list.`,
    { comp: compRef, layer: layerRef, effect: z.string(), settings: z.record(z.string(), z.any()).optional().describe('{ "Blurriness": 25 }') },
    { mutating: true },
    (a) => call("addEffect", a)
  );
  def(
    "ae_layer_op",
    "Layer operations: delete, duplicate (value=new name), rename (value), parent (value=layer or null), moveTo (value=index), solo/lock/shy/enable (value=bool).",
    { comp: compRef, layer: layerRef, op: z.enum(["delete", "duplicate", "rename", "parent", "moveTo", "solo", "lock", "shy", "enable"]), value: z.any().optional() },
    { mutating: true },
    (a) => call("layerOp", a)
  );
  def(
    "ae_menu_command",
    'Run any After Effects menu command by its exact English name (e.g. "Save", "Reduce Project") or numeric command id.',
    { name: z.string().optional(), id: z.number().int().optional() },
    { mutating: true },
    (a) => call("menuCommand", a)
  );
  def(
    "ae_import",
    "Import files into the project; optionally add them as layers to a comp.",
    { paths: z.array(z.string()).min(1), comp: compRef },
    { mutating: true },
    (a) => call("importFiles", a)
  );
  def(
    "ae_render",
    "Add a comp to the render queue with an output path. Set start=true to render now (blocks After Effects until done).",
    { comp: compRef, outputPath: z.string(), outputTemplate: z.string().optional(), renderSettings: z.string().optional(), start: z.boolean().optional() },
    { mutating: true, timeoutMs: 36e5 },
    (a) => call("render", a, { timeoutMs: a.start ? 36e5 : 3e4 })
  );
  def(
    "ae_html_to_layers",
    "Convert a self-contained HTML+CSS motion graphics snippet into REAL After Effects layers with keyframes. Each element becomes a layer (text/heading -> text layer; colored div -> solid or shape; border-radius:50% -> ellipse; borders/strokes and gradients -> shape layers with Ramp). CSS @keyframes animations become AE keyframes: transform:translate -> Position, scale -> Scale, rotate -> Rotation, opacity -> Opacity, background-color/color -> animated Fill; infinite/iteration counts fill the comp duration; timing functions map to linear/hold/bezier easing; animation-delay shifts keys. box-shadow / text-shadow -> Drop Shadow effect. Use absolute positioning (left/top in px on a 1920x1080 stage) for precise layout; flexbox centering is also supported. Returns the created comp and per-layer summary.",
    {
      html: z.string().describe("Full HTML snippet including a <style> block with @keyframes animations."),
      compName: z.string().optional().describe('Name for the new composition (default "HTML Motion").'),
      width: z.number().int().positive().optional(),
      height: z.number().int().positive().optional(),
      duration: z.number().positive().optional(),
      frameRate: z.number().positive().optional(),
      scale: z.number().positive().optional().describe("Multiply all px values (use to fit a larger HTML stage into the comp)."),
      intoCurrentComp: z.boolean().optional().describe("Add layers into the current comp instead of creating a new one."),
      clearComp: z.boolean().optional().describe("With intoCurrentComp: delete existing layers first.")
    },
    { mutating: true, timeoutMs: 12e4 },
    (a) => {
      const plan = convertHtmlToLayers(a.html, {
        width: a.width,
        height: a.height,
        duration: a.duration,
        frameRate: a.frameRate,
        scale: a.scale,
        compName: a.compName,
        createComp: !a.intoCurrentComp
      });
      if (a.intoCurrentComp) plan.createComp = false;
      return hub2.bridge.call({ op: "call", fn: "buildLayers", args: plan, undoName: "MCP: html2ae" }, 12e4).then((res) => ({ ...res, plannedLayers: plan.layers.length, warnings: plan.warnings, comp: res?.comp ?? plan.compName }));
    }
  );
  def(
    "ae_viewport",
    "Live snapshot of the active composition for visual verification: per-layer position/size/color/opacity/rotation/text plus comp settings. Use after building layers to check the result, and to read what the user currently sees.",
    { comp: compRef },
    {},
    (a) => hub2.bridge.call({ op: "call", fn: "viewport", args: { comp: a.comp } }, 15e3)
  );
  return server2;
}

// src/daemon.ts
init_html2ae();
var PORT = Number(process.env.AE_MCP_PORT || 7654);
var HOST = "127.0.0.1";
var hub = new Hub(PORT);
var publicDir = path2.resolve(path2.dirname(fileURLToPath(import.meta.url)), "..", "public");
hub.version = (() => {
  try {
    return JSON.parse(fs2.readFileSync(path2.resolve(publicDir, "..", "package.json"), "utf8")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();
var transports = /* @__PURE__ */ new Map();
var uiSockets = /* @__PURE__ */ new Set();
var TOKEN_FILE = path2.join(os2.homedir(), ".ae-supreme-mcp", "daemon-token");
function ensureToken() {
  try {
    fs2.mkdirSync(path2.dirname(TOKEN_FILE), { recursive: true });
    if (fs2.existsSync(TOKEN_FILE)) {
      const t2 = fs2.readFileSync(TOKEN_FILE, "utf8").trim();
      if (t2) return t2;
    }
    const t = randomUUID().replace(/-/g, "");
    fs2.writeFileSync(TOKEN_FILE, t + "\n", { encoding: "utf8", mode: 384 });
    return t;
  } catch {
    return "";
  }
}
var DAEMON_TOKEN = ensureToken();
hub.bridge.expectedToken = DAEMON_TOKEN || null;
var hostOk = (req) => /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(req.headers.host || "");
function originOk(origin, allowFile) {
  if (!origin) return true;
  if (allowFile && (origin === "null" || origin.startsWith("file://"))) return true;
  return origin === `http://127.0.0.1:${PORT}` || origin === `http://localhost:${PORT}`;
}
var json = (res, code, body) => {
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
};
var readBody = (req) => new Promise((resolve, reject) => {
  let data = "";
  req.on("data", (c) => {
    data += c;
    if (data.length > 2e7) req.destroy();
  });
  req.on("end", () => {
    if (!data) return resolve(void 0);
    try {
      resolve(JSON.parse(data));
    } catch (e) {
      reject(e);
    }
  });
  req.on("error", reject);
});
async function handleMcp(req, res) {
  const sid = req.headers["mcp-session-id"];
  if (req.method === "POST") {
    const body = await readBody(req);
    let transport2 = sid ? transports.get(sid) : void 0;
    if (!transport2 && !sid && isInitializeRequest(body)) {
      const info = body?.params?.clientInfo ?? {};
      const t = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          transports.set(id, t);
          hub.clientConnected(id, info, req.socket.remoteAddress);
        }
      });
      t.onclose = () => {
        if (t.sessionId) {
          transports.delete(t.sessionId);
          hub.clientDisconnected(t.sessionId);
        }
      };
      await buildServer(hub).connect(t);
      return t.handleRequest(req, res, body);
    }
    if (!transport2) return json(res, 400, { jsonrpc: "2.0", error: { code: -32e3, message: "Bad Request: missing or unknown Mcp-Session-Id" }, id: null });
    hub.touch(sid);
    return transport2.handleRequest(req, res, body);
  }
  const transport = sid ? transports.get(sid) : void 0;
  if (!transport) return json(res, 400, { error: "Invalid or missing Mcp-Session-Id" });
  hub.touch(sid);
  return transport.handleRequest(req, res);
}
var server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", "http://x");
    if (!hostOk(req)) return json(res, 403, { error: "Forbidden host" });
    if (!originOk(req.headers.origin, false)) return json(res, 403, { error: "Forbidden origin" });
    if (url.pathname === "/mcp") return await handleMcp(req, res);
    if (url.pathname === "/" || url.pathname === "/index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      return res.end(fs2.readFileSync(path2.join(publicDir, "index.html")));
    }
    if (url.pathname === "/api/state") return json(res, 200, hub.snapshot());
    if (url.pathname === "/api/export") {
      res.writeHead(200, { "content-type": "application/json", "content-disposition": 'attachment; filename="ae-mcp-log.json"' });
      return res.end(JSON.stringify(hub.entries, null, 2));
    }
    if (req.method === "POST" && url.pathname === "/api/settings") {
      hub.setSettings(await readBody(req) || {});
      return json(res, 200, hub.settings);
    }
    if (req.method === "POST" && url.pathname === "/api/html2ae") {
      const b = await readBody(req) || {};
      try {
        const plan = convertHtmlToLayers(String(b.html || ""), b.options || {});
        const kf = plan.layers.reduce((n, l) => n + Object.values(l.keys || {}).reduce((a, k) => a + (k?.length || 0), 0), 0);
        hub.log({ kind: "tool", tool: "html2ae", client: "dashboard", status: "ok", message: `HTML plan: ${plan.layers.length} layers, ${kf} keyframes`, durationMs: 0 });
        return json(res, 200, { ok: true, layers: plan.layers.length, keyframes: kf, compName: plan.compName, width: plan.width, height: plan.height, duration: plan.duration, frameRate: plan.frameRate, bgColor: plan.bgColor, warnings: plan.warnings, layerNames: plan.layers.map((l) => `${l.kind}:${l.name}`) });
      } catch (e) {
        return json(res, 200, { ok: false, error: e?.message ?? String(e) });
      }
    }
    if (req.method === "POST" && url.pathname === "/api/html2ae-apply") {
      const b = await readBody(req) || {};
      try {
        if (hub.settings.readOnly) throw new Error("Read-only mode is ON in the dashboard settings.");
        if (!hub.bridge.connected) throw new Error('After Effects is not connected. Open Window > Extensions > "After Effect Supreme MCP" in AE.');
        const plan = convertHtmlToLayers(String(b.html || ""), b.options || {});
        const r = await hub.bridge.call({ op: "call", fn: "buildLayers", args: plan, undoName: "MCP: html2ae" }, 12e4);
        hub.log({ kind: "tool", tool: "html2ae", client: "dashboard", status: "ok", message: `HTML \u2192 AE: ${plan.layers.length} layers into "${r?.comp ?? plan.compName}"`, durationMs: 0 });
        hub.requestViewport(true);
        return json(res, 200, { ok: true, ...r || {}, plannedLayers: plan.layers.length, warnings: plan.warnings, comp: r?.comp ?? plan.compName });
      } catch (e) {
        return json(res, 200, { ok: false, error: e?.message ?? String(e) });
      }
    }
    if (req.method === "POST" && url.pathname === "/api/ae-time") {
      const b = await readBody(req) || {};
      try {
        const r = await hub.bridge.call({ op: "call", fn: "setTime", args: { comp: b.comp, time: b.time } }, 5e3);
        hub.requestViewport(true);
        return json(res, 200, { ok: true, result: r });
      } catch (e) {
        return json(res, 200, { ok: false, error: e.message });
      }
    }
    if (req.method === "POST" && url.pathname === "/api/viewport") {
      try {
        await hub.requestViewport(true);
      } catch {
      }
      return json(res, 200, { ok: true, viewport: hub.lastViewport });
    }
    if (req.method === "POST" && url.pathname === "/api/shutdown") {
      hub.log({ kind: "system", level: "warn", message: "Shutdown requested" });
      json(res, 200, { ok: true });
      return void setTimeout(() => process.exit(0), 150);
    }
    if (req.method === "POST" && url.pathname === "/api/clear") {
      hub.clearLogs();
      return json(res, 200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/api/ping-ae") {
      const t0 = Date.now();
      try {
        const r = await hub.bridge.call({ op: "call", fn: "ping" }, 1e4);
        hub.log({ kind: "bridge", message: `Ping OK in ${Date.now() - t0}ms: ${r?.app ?? "AE"} ${r?.version ?? ""}` });
        return json(res, 200, { ok: true, ms: Date.now() - t0, result: r });
      } catch (e) {
        hub.log({ kind: "bridge", level: "error", message: `Ping failed: ${e.message}` });
        return json(res, 200, { ok: false, error: e.message });
      }
    }
    json(res, 404, { error: "Not found" });
  } catch (e) {
    if (!res.headersSent) json(res, 500, { error: e?.message ?? String(e) });
    else res.end();
  }
});
var wssAe = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
var wssUi = new WebSocketServer({ noServer: true });
var deny = (socket, code) => {
  socket.write(`HTTP/1.1 ${code} Forbidden\r
Connection: close\r
\r
`);
  socket.destroy();
};
server.on("upgrade", (req, socket, head) => {
  const pathname = new URL(req.url || "/", "http://x").pathname;
  if (!hostOk(req)) return deny(socket, 403);
  if (pathname === "/ae") {
    if (!originOk(req.headers.origin, true)) return deny(socket, 403);
    wssAe.handleUpgrade(req, socket, head, (ws) => hub.bridge.attach(ws));
  } else if (pathname === "/ui") {
    if (!originOk(req.headers.origin, false)) return deny(socket, 403);
    wssUi.handleUpgrade(req, socket, head, (ws) => {
      uiSockets.add(ws);
      ws.on("close", () => uiSockets.delete(ws));
      ws.on("error", () => {
      });
      ws.send(JSON.stringify({ type: "snapshot", ...hub.snapshot() }));
      if (hub.lastViewport) ws.send(JSON.stringify({ type: "viewport", viewport: hub.lastViewport }));
    });
  } else deny(socket, 404);
});
hub.on("msg", (m) => {
  const s = JSON.stringify(m);
  for (const ws of uiSockets) if (ws.readyState === 1) ws.send(s);
});
setInterval(() => {
  hub.sweep();
  for (const [id, t] of transports) {
    const c = hub.clients.get(id);
    if (c && c.connected) continue;
    if (c && Date.now() - c.lastSeen < 10 * 6e4) continue;
    if (!c && Date.now() - hub.startedAt < 10 * 6e4) continue;
    try {
      t.close();
    } catch {
    }
    transports.delete(id);
  }
}, 6e4);
hub.on("msg", (m) => {
  if (m && m.type === "ae" && hub.bridge.authenticated) hub.requestViewport();
});
server.listen(PORT, HOST, () => {
  hub.log({ kind: "system", message: `Daemon listening on http://${HOST}:${PORT}` });
  console.error(`
  After Effect Supreme MCP daemon
  Dashboard : http://${HOST}:${PORT}
  MCP (HTTP): http://${HOST}:${PORT}/mcp
  AE bridge : ws://${HOST}:${PORT}/ae
`);
});
server.on("error", (e) => {
  console.error(e.code === "EADDRINUSE" ? `Port ${PORT} is in use. Is the daemon already running? (set AE_MCP_PORT to change)` : e);
  process.exit(1);
});
