// html2ae: converts plain HTML + CSS (the kind AI assistants write for motion graphics)
// into After Effects layer specs with real keyframes. Pure TypeScript, zero dependencies.
// Runs in the daemon; the resulting spec is executed by host.jsx (A.buildLayers).

// ---------- public types ----------
export type KeyframeSpec = { t: number; v: any; interp: 'LINEAR' | 'BEZIER' | 'HOLD'; infIn?: number; infOut?: number };

export type PathSpec = {
  verts: [number, number][];
  inT?: [number, number][];
  outT?: [number, number][];
  closed?: boolean;
};

export type LayerSpec = {
  kind: 'text' | 'solid' | 'shape' | 'footage';
  name: string;
  pos: [number, number];          // AE comp coords of layer anchor (y up)
  w: number; h: number;           // source size in px
  rotation: number;               // AE degrees (CCW)
  scale: [number, number];        // percent
  opacity: number;                // 0-100
  color?: [number, number, number];            // solid / text fill
  text?: string; font?: string; fontSize?: number; justification?: 'left' | 'center' | 'right'; tracking?: number; leading?: number;
  anchorX?: 'left' | 'center' | 'right';       // which text edge sits on pos.x (default center)
  shape?: 'rect' | 'ellipse' | 'path'; roundness?: number; fill?: [number, number, number] | null;
  path?: PathSpec | null;
  stroke?: [number, number, number] | null; strokeWidth?: number;
  gradient?: { start: [number, number]; end: [number, number]; c1: [number, number, number]; c2: [number, number, number]; a1?: number; a2?: number; radial?: boolean } | null;
  shadow?: { direction: number; distance: number; opacity: number; softness: number; color: [number, number, number] } | null;
  fillOverride?: [number, number, number] | null;   // animated color -> ADBE Fill effect
  file?: string;
  // transform-origin support: real pivot so scale/rotate keys grow from the CSS-specified origin.
  // anchor        = pivot in layer source coords (solid: top-left origin y-down; shape: centered origin)
  // anchorOffset  = text only: pivot offset ADDED to the measured source-rect anchor (px, screen-down)
  anchor?: [number, number] | null;
  anchorOffset?: [number, number] | null;
  // HyperFrames-compatible trim attributes: <div data-start="1" data-duration="4"> (seconds)
  startTime?: number; duration?: number;
  keys?: Partial<Record<'Position' | 'Scale' | 'Rotation' | 'Opacity' | 'FillColor' | 'RectSize' | 'TrimEnd', KeyframeSpec[]>>;
};

export type ConvertOptions = {
  width?: number; height?: number; duration?: number; frameRate?: number;
  compName?: string; createComp?: boolean; scale?: number;
};

export type ConvertResult = {
  createComp: boolean;
  compName: string;
  width: number; height: number; duration: number; frameRate: number;
  bgColor: [number, number, number] | null;
  clearComp: boolean;
  layers: LayerSpec[];
  warnings: string[];
};

// ---------- tiny HTML tokenizer ----------
type Attrs = Record<string, string>;
type Node = { tag: string; attrs: Attrs; children: Node[]; parent: Node | null; order: number; text?: string };

const VOID = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'hr', 'source', 'wbr', 'col', 'area', 'base', 'embed', 'track']);
const RAW = new Set(['style', 'script']);
const SKIP_TAGS = new Set(['style', 'script', 'head', 'meta', 'link', 'title', 'base']);

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/&copy;/g, '©').replace(/&mdash;/g, '—').replace(/&ndash;/g, '–');
}

export function parseHTML(html: string): Node {
  const root: Node = { tag: '#root', attrs: {}, children: [], parent: null, order: 0 };
  let cur = root, order = 1, i = 0;
  const n = html.length;
  const push = (node: Node) => { node.parent = cur; node.order = order++; cur.children.push(node); };
  while (i < n) {
    if (html.startsWith('<!--', i)) { const e = html.indexOf('-->', i); i = e === -1 ? n : e + 3; continue; }
    if (html[i] === '<') {
      if (html[i + 1] === '!') { const e = html.indexOf('>', i); i = e === -1 ? n : e + 1; continue; } // doctype
      if (html[i + 1] === '/') { // closing tag
        const e = html.indexOf('>', i);
        const tag = html.slice(i + 2, e === -1 ? n : e).trim().toLowerCase();
        let p: Node | null = cur;
        while (p && p.tag !== tag && p.tag !== '#root') p = p.parent;
        if (p && p.parent) cur = p.parent;
        i = e === -1 ? n : e + 1; continue;
      }
      const gt = html.indexOf('>', i);
      if (gt === -1) break;
      let tagBody = html.slice(i + 1, gt);
      const selfClosed = tagBody.endsWith('/');
      if (selfClosed) tagBody = tagBody.slice(0, -1);
      const m = tagBody.match(/^[a-zA-Z][a-zA-Z0-9-]*/);
      const tag = m ? m[0].toLowerCase() : 'span';
      const node: Node = { tag, attrs: {}, children: [], parent: null, order: 0 };
      let rest = tagBody.slice(tag.length);
      const attrRe = /([:@a-zA-Z_][-\w:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+))|([a-zA-Z_][-\w:.]*)/g;
      let am: RegExpExecArray | null;
      while ((am = attrRe.exec(rest))) {
        if (am[1] !== undefined) node.attrs[am[1].toLowerCase()] = decodeEntities(am[3] ?? am[4] ?? am[5] ?? '');
        else node.attrs[am[6].toLowerCase()] = '';
      }
      push(node);
      i = gt + 1;
      if (RAW.has(tag)) { // consume raw text
        const closeIdx = html.toLowerCase().indexOf('</' + tag, i);
        const raw = html.slice(i, closeIdx === -1 ? n : closeIdx);
        if (tag === 'style') node.text = raw;
        if (closeIdx !== -1) { const e2 = html.indexOf('>', closeIdx); i = e2 === -1 ? n : e2 + 1; } else i = n;
        continue;
      }
      if (!selfClosed && !VOID.has(tag)) cur = node;
      continue;
    }
    const next = html.indexOf('<', i);
    const text = html.slice(i, next === -1 ? n : next);
    if (text.trim()) push({ tag: '#text', attrs: {}, children: [], parent: null, order: 0, text: decodeEntities(text) });
    i = next === -1 ? n : next;
  }
  return root;
}

// ---------- CSS parser ----------
type Decl = { prop: string; value: string; important: boolean };
type Rule = { selector: string; decls: Decl[]; order: number };
type KeyframeRule = { name: string; stops: { pct: number; decls: Decl[] }[] };

function evalMediaCondition(cond: string, vw: number, vh: number): boolean {
  // supports "(min-width: X)", "(max-width: X)", "(min-height/max-height: X)" joined by "and";
  // bare media types: screen/all -> true, print/other -> false
  const parts = cond.toLowerCase().split(/\band\b/).map((s) => s.trim()).filter(Boolean);
  for (const p of parts) {
    if (!p.startsWith('(')) { // media type
      if (/screen|all|\*/.test(p)) continue;
      return false;
    }
    const m = p.match(/\(\s*(min|max)-(width|height)\s*:\s*([\d.]+)(px|em|rem)?\s*\)/);
    if (!m) continue; // unknown feature: ignore (permissive)
    const val = parseFloat(m[3]) * (m[4] === 'em' || m[4] === 'rem' ? 16 : 1);
    const ref = m[2] === 'width' ? vw : vh;
    if (m[1] === 'min' && ref < val) return false;
    if (m[1] === 'max' && ref > val) return false;
  }
  return true;
}

// strip /* ... */ comments (quote-aware) — a comment directly above a rule used to
// fuse into the selector ("/* card */ .card") and silently kill the whole rule
function stripCssComments(cssText: string): string {
  let out = '';
  let i = 0;
  const n = cssText.length;
  let inStr: string | null = null;
  while (i < n) {
    const ch = cssText[i];
    if (inStr) {
      out += ch;
      if (ch === '\\' && i + 1 < n) { out += cssText[i + 1]; i += 2; continue; }
      if (ch === inStr) inStr = null;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") { inStr = ch; out += ch; i++; continue; }
    if (ch === '/' && cssText[i + 1] === '*') { const e = cssText.indexOf('*/', i + 2); i = e === -1 ? n : e + 2; out += ' '; continue; }
    out += ch;
    i++;
  }
  return out;
}

export function parseCSS(rawCssText: string, vw = 1920, vh = 1080): { rules: Rule[]; keyframes: KeyframeRule[] } {
  const cssText = stripCssComments(rawCssText);
  const rules: Rule[] = []; const keyframes: KeyframeRule[] = [];
  let order = 0;
  let i = 0; const n = cssText.length;
  const readBlock = (start: number): number => { // returns index after matching closing brace
    let depth = 0;
    for (let j = start; j < n; j++) { if (cssText[j] === '{') depth++; else if (cssText[j] === '}') { depth--; if (!depth) return j + 1; } }
    return n;
  };
  while (i < n) {
    const brace = cssText.indexOf('{', i);
    if (brace === -1) break;
    const head = cssText.slice(i, brace).trim();
    const end = readBlock(brace);
    const body = cssText.slice(brace + 1, end - 1);
    if (head.startsWith('@')) {
      const at = head.slice(1).split(/\s+/)[0].toLowerCase();
      if (at === 'keyframes' || at === '-webkit-keyframes') {
        const name = head.replace(/@[-a-z]+\s+/, '').trim();
        const stops: { pct: number; decls: Decl[] }[] = [];
        let j = 0;
        while (j < body.length) {
          const b2 = body.indexOf('{', j); if (b2 === -1) break;
          const e2 = readBlock2(body, b2);
          const stopHead = body.slice(j, b2).trim().replace(/,/g, ' ');
          const pcts = stopHead.split(/\s+/).map((s) => (s === 'from' ? 0 : s === 'to' ? 100 : parseFloat(s)));
          const decls = parseDecls(body.slice(b2 + 1, e2 - 1));
          for (const p of pcts) if (!isNaN(p)) stops.push({ pct: p, decls });
          j = e2;
        }
        stops.sort((a, b) => a.pct - b.pct);
        keyframes.push({ name, stops });
      } else if (at === 'media' || at === 'supports' || at === 'layer') {
        const cond = head.slice(head.indexOf('(')).trim();
        if (at !== 'media' || evalMediaCondition(cond, vw, vh)) {
          const inner = parseCSS(body, vw, vh);
          for (const r of inner.rules) rules.push({ ...r, order: order++ });
          for (const k of inner.keyframes) keyframes.push(k);
        }
      } // else @font-face, @import, ... ignored
    } else if (head) {
      // a selector list ("html, body") is N independent rules sharing declarations
      for (const sel of splitTop(head, ',')) {
        const s = sel.trim().replace(/\s+/g, ' ');
        if (s) rules.push({ selector: s, decls: parseDecls(body), order: order++ });
      }
    }
    i = end;
  }
  return { rules, keyframes };
}
function readBlock2(s: string, start: number): number {
  let depth = 0;
  for (let j = start; j < s.length; j++) { if (s[j] === '{') depth++; else if (s[j] === '}') { depth--; if (!depth) return j + 1; } }
  return s.length;
}
function parseDecls(rawBody: string): Decl[] {
  const body = stripCssComments(rawBody); // inline style="/* c */ color:red" safety
  const out: Decl[] = [];
  for (const chunk of splitTop(body, ';')) {
    const c = chunk.trim(); if (!c) continue;
    const colon = c.indexOf(':'); if (colon === -1) continue;
    const prop = c.slice(0, colon).trim().toLowerCase();
    let value = c.slice(colon + 1).trim();
    let important = false;
    if (/!\s*important$/i.test(value)) { important = true; value = value.replace(/!\s*important$/i, '').trim(); }
    if (prop && value) out.push({ prop, value, important });
  }
  return out;
}
function splitTop(s: string, sep: string): string[] {
  const parts: string[] = []; let depth = 0, cur = '';
  for (const ch of s) {
    if (ch === '(') depth++; else if (ch === ')') depth--;
    if (ch === sep && depth === 0) { parts.push(cur); cur = ''; } else cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

// ---------- selector matching ----------
type Pseudo = { kind: string; arg: string };

function splitPseudos(compound: string): { base: string; pseudos: Pseudo[] } {
  const pseudos: Pseudo[] = [];
  let base = compound;
  const re = /:(not|nth-child|nth-of-type|first-child|last-child)\s*(\([^)]*\))?|:(first-child|last-child)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(compound))) {
    const kind = (m[1] || m[4] || '').toLowerCase();
    pseudos.push({ kind, arg: (m[2] || '').replace(/^\(|\)$/g, '').trim() });
  }
  base = compound.replace(/:{1,2}(not|nth-child|nth-of-type|first-child|last-child)\s*(\([^)]*\))?|:{1,2}(first-child|last-child)/gi, '');
  return { base: base.trim(), pseudos };
}

function elementSiblings(el: Node): Node[] {
  if (!el.parent) return [el];
  return el.parent.children.filter((c) => c.tag !== '#text' && c.attrs['data-pseudo'] === undefined);
}

function matchAnB(arg: string, idx: number, count: number): boolean {
  const a = arg.trim().toLowerCase();
  if (!a) return true;
  if (a === 'odd') return idx % 2 === 1;
  if (a === 'even') return idx % 2 === 0;
  const m = a.match(/^([+-]?\d*)n\s*([+-]\s*\d+)?$/) || a.match(/^([+-]?\d+)$/);
  if (!m) return false;
  if (!a.includes('n')) { const k = parseInt(a); return k === idx; }
  const A = m[1] === '' || m[1] === '+' ? 1 : m[1] === '-' ? -1 : parseInt(m[1]);
  const B = m[2] ? parseInt(String(m[2]).replace(/\s+/g, '')) : 0;
  for (let i = 0; i <= count + 1; i++) { if (A * i + B === idx) return true; if (A > 0 && A * i + B > idx) break; }
  return false;
}

function matchesCompound(el: Node, compound: string): boolean {
  const { base, pseudos } = splitPseudos(compound);
  if (base && base !== '*') {
    let ok = false;
    const re = /([a-zA-Z][\w-]*)|\.([\w-]+)|#([\w-]+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(base))) {
      ok = true;
      if (m[1] !== undefined) { if (el.tag !== m[1].toLowerCase()) return false; }
      else if (m[2] !== undefined) { const cls = (el.attrs['class'] || '').split(/\s+/); if (!cls.includes(m[2])) return false; }
      else if (m[3] !== undefined) { if (el.attrs['id'] !== m[3]) return false; }
    }
    if (!ok) return false;
  }
  for (const p of pseudos) {
    const sibs = elementSiblings(el);
    const idx = sibs.indexOf(el) + 1;
    const count = sibs.length;
    if (p.kind === 'nth-child') { if (!matchAnB(p.arg || '1', idx, count)) return false; }
    else if (p.kind === 'nth-of-type') {
      const same = sibs.filter((s) => s.tag === el.tag);
      const tidx = same.indexOf(el) + 1;
      if (!matchAnB(p.arg || '1', tidx, same.length)) return false;
    } else if (p.kind === 'first-child') { if (idx !== 1) return false; }
    else if (p.kind === 'last-child') { if (idx !== count) return false; }
    else if (p.kind === 'not') { if (p.arg && matchesCompound(el, p.arg)) return false; }
  }
  return true;
}
function matchesSelector(el: Node, selector: string): boolean {
  const parts = selector.trim().split(/\s+/).filter((s) => s && s !== '>'); // descendant combinator ('>' treated as space)
  if (parts.length === 1) return matchesCompound(el, parts[0]); // simple selector: match the element itself only
  let node: Node | null = el;
  for (let p = parts.length - 1; p >= 0; p--) {
    while (node && node.tag !== '#root' && !matchesCompound(node, parts[p])) node = node.parent;
    if (!node || node.tag === '#root') return false;
    node = node.parent;
  }
  return true;
}

// ---------- style computation ----------
const INHERITED = new Set(['font-size', 'font-family', 'font-weight', 'font-style', 'color', 'text-align', 'letter-spacing', 'line-height', 'text-transform', 'white-space']);
const NAMED_COLORS: Record<string, string> = {
  white: '#ffffff', black: '#000000', red: '#ff0000', green: '#008000', blue: '#0000ff', yellow: '#ffff00',
  orange: '#ffa500', purple: '#800080', pink: '#ffc0cb', gray: '#808080', grey: '#808080', silver: '#c0c0c0',
  maroon: '#800000', navy: '#000080', teal: '#008080', aqua: '#00ffff', cyan: '#00ffff', fuchsia: '#ff00ff',
  magenta: '#ff00ff', lime: '#00ff00', olive: '#808000', gold: '#ffd700', crimson: '#dc143c', tomato: '#ff6347',
  coral: '#ff7f50', salmon: '#fa8072', khaki: '#f0e68c', indigo: '#4b0082', violet: '#ee82ee', turquoise: '#40e0d0',
  skyblue: '#87ceeb', lightgray: '#d3d3d3', lightgrey: '#d3d3d3', darkgray: '#a9a9a9', dimgray: '#696969',
  whitesmoke: '#f5f5f5', ivory: '#fffff0', beige: '#f5f5dc', brown: '#a52a2a', chocolate: '#d2691e', transparent: 'rgba(0,0,0,0)',
};

export function parseColor(v: string): [number, number, number, number] | null {
  if (!v) return null;
  let s = v.trim().toLowerCase();
  if (s === 'transparent') return [0, 0, 0, 0];
  if (NAMED_COLORS[s]) s = NAMED_COLORS[s];
  if (s.startsWith('#')) {
    let h = s.slice(1);
    if (h.length === 3 || h.length === 4) h = h.split('').map((c) => c + c).join('');
    if (h.length === 8) h = h.slice(0, 6);
    if (h.length !== 6 || /[^0-9a-f]/.test(h)) return null;
    return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255, 1];
  }
  const m = s.match(/(rgba?|hsla?)\(([^)]+)\)/);
  if (!m) return null;
  const nums = m[2].split(/[,\s\/]+/).filter(Boolean);
  if (m[1] === 'rgb' || m[1] === 'rgba') {
    const c = nums.slice(0, 3).map((x) => (x.endsWith('%') ? parseFloat(x) / 100 : parseFloat(x) / 255));
    if (c.some(isNaN) || c.length < 3) return null;
    const a = nums[3] !== undefined ? parseFloat(nums[3]) : 1;
    return [c[0], c[1], c[2], isNaN(a) ? 1 : a];
  }
  if (m[1] === 'hsl' || m[1] === 'hsla') { // support common CSS usage
    const h = parseFloat(nums[0]) / 360; const s2 = parseFloat(nums[1]) / 100; const l = parseFloat(nums[2]) / 100;
    if ([h, s2, l].some(isNaN)) return null;
    const q = l < 0.5 ? l * (1 + s2) : l + s2 - l * s2; const p = 2 * l - q;
    const hue = (t: number) => { if (t < 0) t += 1; if (t > 1) t -= 1; if (t < 1 / 6) return p + (q - p) * 6 * t; if (t < 1 / 2) return q; if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6; return p; };
    const a = nums[3] !== undefined ? parseFloat(nums[3]) : 1;
    return [hue(h + 1 / 3), hue(h), hue(h - 1 / 3), isNaN(a) ? 1 : a];
  }
  return null;
}

// ---------- custom properties (CSS variables) + shorthand expansion ----------
function collectCustomProps(rules: Rule[]): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const r of rules) for (const d of r.decls) if (d.prop.startsWith('--')) vars[d.prop] = d.value;
  return vars;
}
function resolveVars(value: string, vars: Record<string, string>): string {
  if (!value.includes('var(')) return value;
  let out = value;
  for (let guard = 0; guard < 5; guard++) {
    const m = out.match(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*(?:\([^()]*\)[^()]*)*))?\)/);
    if (!m) break;
    const replacement = (m[1] && vars[m[1]] !== undefined ? vars[m[1]] : (m[2] !== undefined ? m[2] : '')).trim();
    out = out.replace(m[0], replacement || '0');
  }
  return out;
}

function expandBoxValues(v: string): [string, string, string, string] { // top right bottom left
  const t = splitTop(v, ' ').map((s) => s.trim()).filter(Boolean);
  if (t.length === 0) return ['0', '0', '0', '0'];
  if (t.length === 1) return [t[0], t[0], t[0], t[0]];
  if (t.length === 2) return [t[0], t[1], t[0], t[1]];
  if (t.length === 3) return [t[0], t[1], t[2], t[1]];
  return [t[0], t[1], t[2], t[3]];
}

function expandShorthands(style: Computed, vars: Record<string, string>): void {
  // resolve var() references first
  for (const k of Object.keys(style)) if (style[k].includes('var(')) style[k] = resolveVars(style[k], vars);
  // padding / margin / inset
  for (const base of ['padding', 'margin', 'inset']) {
    if (style[base] !== undefined && style[base] !== 'auto') {
      const [t, r, b, l] = expandBoxValues(style[base]);
      const suf = base === 'inset' ? '' : '-';
      style[`${base}${suf}top`] = style[`${base}${suf}top`] ?? t;
      style[`${base}${suf}right`] = style[`${base}${suf}right`] ?? r;
      style[`${base}${suf}bottom`] = style[`${base}${suf}bottom`] ?? b;
      style[`${base}${suf}left`] = style[`${base}${suf}left`] ?? l;
    }
  }
  // border / border-<side>
  const sides = ['top', 'right', 'bottom', 'left'] as const;
  const parseBorderTokens = (v: string) => {
    const toks = splitTop(v, ' ').map((s) => s.trim()).filter(Boolean);
    let w = '', c = '';
    for (const t of toks) {
      if (!w && /^[\d.]+(px|em|rem|pt|thin|medium|thick)?$/.test(t) && !parseColor(t)) { w = /^(thin|medium|thick)$/.test(t) ? '1px' : t; continue; }
      if (/^(solid|dashed|dotted|double|none|hidden)$/.test(t)) continue;
      if (!c && parseColor(t)) c = t;
    }
    return { w: w || '0px', c };
  };
  for (const side of sides) {
    const sh = style[`border-${side}`];
    if (sh !== undefined) {
      const { w, c } = parseBorderTokens(sh);
      style[`border-${side}-width`] = style[`border-${side}-width`] ?? w;
      if (c) style[`border-${side}-color`] = style[`border-${side}-color`] ?? c;
    }
  }
  if (style['border'] !== undefined) {
    const { w, c } = parseBorderTokens(style['border']);
    for (const side of sides) {
      style[`border-${side}-width`] = style[`border-${side}-width`] ?? w;
      if (c) style[`border-${side}-color`] = style[`border-${side}-color`] ?? c;
    }
    style['border-width'] = style['border-width'] ?? w;
    if (c) style['border-color'] = style['border-color'] ?? c;
  }
  // gap -> row-gap / column-gap
  if (style['gap'] !== undefined) {
    const [r, c] = expandBoxValues(style['gap']);
    style['row-gap'] = style['row-gap'] ?? r;
    style['column-gap'] = style['column-gap'] ?? c;
  }
  // flex: N -> flex-grow
  if (style['flex'] !== undefined && style['flex-grow'] === undefined) {
    const t = style['flex'].trim().split(/\s+/)[0];
    if (/^[\d.]+$/.test(t)) style['flex-grow'] = t;
    else if (t === 'auto') style['flex-grow'] = '1';
  }
  // background shorthand: extract color + image layers
  if (style['background'] !== undefined && style['background-image'] === undefined) {
    const layers = splitTop(style['background'], ',').map((s) => s.trim()).filter(Boolean);
    const imgs: string[] = [];
    for (let i = layers.length - 1; i >= 0; i--) {
      const lay = layers[i];
      if (/(linear|radial|conic)-gradient/i.test(lay)) imgs.unshift(lay);
      else {
        // strip positional keywords, keep a plain color if present
        const toks = splitTop(lay, ' ').map((s) => s.trim());
        const col = toks.map((t) => parseColor(t)).find(Boolean);
        if (col && !imgs.length) style['background-color'] = style['background-color'] ?? toks.filter((t) => parseColor(t))[0];
      }
    }
    if (imgs.length) style['background-image'] = imgs.join(', ');
  }
}

type Computed = Record<string, string>;
export function computeStyles(root: Node, rules: Rule[], vw = 1920, vh = 1080): Map<Node, Computed> {
  const vars = collectCustomProps(rules);
  const map = new Map<Node, Computed>();
  const walk = (el: Node, parentStyle: Computed) => {
    if (el.tag === '#text') return;
    const matched: { decls: Decl[]; order: number }[] = [];
    for (const r of rules) if (matchesSelector(el, r.selector)) matched.push(r);
    matched.sort((a, b) => a.order - b.order);
    const style: Computed = {}; // CSS: only inherited properties flow down, never display/position/etc.
    for (const k of INHERITED) if (parentStyle[k] !== undefined) style[k] = parentStyle[k];
    const important: Decl[] = [], normal: Decl[] = [];
    for (const r of matched) for (const d of r.decls) (d.important ? important : normal).push(d);
    const inline = el.attrs['style'] ? parseDecls(el.attrs['style']) : [];
    for (const d of [...normal, ...inline, ...important]) {
      if (d.prop === 'font') { // expand shorthand: [style] [variant] [weight] size[/line-height] family
        const parts = d.value.replace(/\s*\/\s*/, '/').split(/\s+/);
        let fs = ''; let lh = ''; let fam: string[] = []; let fw = '';
        for (const p of parts) {
          if (!fs && /^[\d.]+(px|pt|em|rem|%)$/.test(p)) { const seg = p.split('/'); fs = seg[0]; if (seg[1]) lh = seg[1]; continue; }
          if (!fs && /^[\d.]+\//.test(p)) { const seg = p.split('/'); fs = seg[0]; lh = seg[1]; continue; }
          if (!fw && /^(bold|bolder|lighter|[1-9]00)$/.test(p)) { fw = p; continue; }
          if (fs) fam.push(p);
        }
        if (fs) style['font-size'] = fs;
        if (lh) style['line-height'] = lh;
        if (fw) style['font-weight'] = fw;
        if (fam.length) style['font-family'] = fam.join(' ');
        continue;
      }
      if (d.prop.startsWith('--')) continue;
      style[d.prop] = d.value;
    }
    expandShorthands(style, vars);
    map.set(el, style);
    for (const c of el.children) walk(c, style);
  };
  const base: Computed = { 'font-size': '16px', 'font-family': 'Arial', 'font-weight': '400', color: '#000000', 'text-align': 'left', 'line-height': '1.2' };
  walk(root, base);
  return map;
}

// ---------- units ----------
function px(v: string | undefined, ref: number, fontSize: number): number | null {
  if (v === undefined) return null;
  const s = v.trim();
  if (s === 'auto' || s === 'inherit' || s === 'initial' || s === '') return null;
  const m = s.match(/^(-?[\d.]+)(px|em|rem|%|pt|vw|vh)?$/);
  if (!m) return null;
  const num = parseFloat(m[1]);
  switch (m[2] || 'px') {
    case 'px': return num;
    case 'em': return num * fontSize;
    case 'rem': return num * 16;
    case '%': return (num / 100) * ref;
    case 'pt': return num * (96 / 72);
    case 'vw': return num; // resolved by caller passing viewport width as ref
    case 'vh': return num;
    default: return num;
  }
}

// ---------- layout ----------
type Box = { x: number; y: number; w: number; h: number };
type LayoutNode = {
  el: Node; style: Computed; box: Box; parent: LayoutNode | null; children: LayoutNode[];
  textLines: string[]; fontSize: number; staticX?: number; staticY?: number;
};

const BLOCK = new Set(['div', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'section', 'header', 'footer', 'main', 'article', 'aside', 'nav', 'ul', 'ol', 'li', 'form', 'figure', 'figcaption', 'blockquote', 'address', 'fieldset', 'details', 'summary']);
const INLINE = new Set(['span', 'a', 'strong', 'em', 'b', 'i', 'u', 'small', 'code', 'label', 'mark', 'abbr', 'time']);

// Helvetica/Arial advance widths (units per 1000 em) for chars 32..126 — close to the browser
// default sans metric, so shrink-to-fit and wrapping match what the user sees in the browser.
const ARIAL_W = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
const ARIAL_B = [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584];
function charWidth(ch: string, bold: boolean, fs: number, ls: number): number {
  const code = ch.charCodeAt(0);
  const table = bold ? ARIAL_B : ARIAL_W;
  const w = (code >= 32 && code <= 126 ? table[code - 32] : 556) / 1000;
  return w * fs + ls;
}

function displayOf(L: LayoutNode): string {
  return ((L.style['display'] || (INLINE.has(L.el.tag) ? 'inline' : 'block')) || 'block').trim();
}

// find the <body> element at root level or one level down (html > body)
function findBody(root: Node): Node {
  for (const c of root.children) {
    if (c.tag === 'body') return c;
    for (const g of c.children) if (g.tag === 'body') return g;
  }
  return root;
}

export function layoutTree(root: Node, styles: Map<Node, Computed>, vw: number, vh: number, warnings: string[]): LayoutNode {
  const make = (el: Node, parent: LayoutNode | null): LayoutNode => ({
    el, style: styles.get(el) || {}, box: { x: 0, y: 0, w: 0, h: 0 }, parent, children: [], textLines: [],
    fontSize: px(parent ? (styles.get(parent.el) || {})['font-size'] : '16px', 1, 16) || 16,
  });

  const measureText = (lines: string[], fs: number, weight: number, ls: number): number => {
    const bold = weight >= 600;
    let max = 0;
    for (const line of lines) {
      let w = 0;
      for (const ch of line) w += charWidth(ch, bold, fs, ls);
      max = Math.max(max, w);
    }
    return max;
  };

  // word-wrap to a max width (browsers wrap text at the content box; AE text would run on one line)
  const wrapLines = (lines: string[], maxW: number, fs: number, weight: number, ls: number): string[] => {
    const bold = weight >= 600;
    const widthOf = (s: string) => { let w = 0; for (const ch of s) w += charWidth(ch, bold, fs, ls); return w; };
    const out: string[] = [];
    for (const line of lines) {
      if (widthOf(line) <= maxW) { out.push(line); continue; }
      let cur = '';
      for (const wd of line.split(' ')) {
        const cand = cur ? cur + ' ' + wd : wd;
        if (cur && widthOf(cand) > maxW) { out.push(cur); cur = wd; } else cur = cand;
      }
      if (cur) out.push(cur);
    }
    return out;
  };

  // collect direct text content of an element (respecting <br>)
  const textOf = (el: Node, white: string): string[] => {
    const segs: string[] = []; let curLine = '';
    const flush = () => { let t = curLine; if (white !== 'pre') t = t.replace(/\s+/g, ' ').trim(); if (t) segs.push(t); curLine = ''; };
    for (const c of el.children) {
      if (c.tag === '#text') curLine += c.text || '';
      else if (c.tag === 'br') flush();
    }
    flush();
    return segs;
  };

  const body = findBody(root);

  // border widths per side (after shorthand expansion)
  const borderSides = (st: Computed, fs: number) => ({
    t: px(st['border-top-width'], 0, fs) || 0,
    r: px(st['border-right-width'], 0, fs) || 0,
    b: px(st['border-bottom-width'], 0, fs) || 0,
    l: px(st['border-left-width'], 0, fs) || 0,
  });

  // estimate how wide an element wants to be with no width set (shrink-to-fit)
  const estimateWidth = (L: LayoutNode, depth = 0): number => {
    const st = L.style;
    const fs = L.fontSize;
    const weight = parseFloat(st['font-weight']) || (st['font-weight'] === 'bold' ? 700 : 400);
    const ls = px(st['letter-spacing'], 0, fs) || 0;
    const padL = px(st['padding-left'], 0, fs) || 0, padR = px(st['padding-right'], 0, fs) || 0;
    const b = borderSides(st, fs);
    let inner = measureText(L.textLines, fs, weight, ls);
    if (depth < 8) {
      for (const c of L.children) {
        const cw = px(c.style['width'], 0, c.fontSize);
        const cw2 = cw !== null ? cw : estimateWidth(c, depth + 1);
        if (cw2 > inner) inner = cw2;
      }
    }
    return inner + padL + padR + b.l + b.r;
  };
  // estimate natural content height (children included)
  const estimateHeight = (L: LayoutNode, depth = 0): number => {
    const st = L.style;
    const fs = L.fontSize;
    const lhRaw = st['line-height'];
    let lh = lhRaw && lhRaw !== 'normal' ? (px(lhRaw, fs, fs) ?? (parseFloat(lhRaw) * fs || fs * 1.2)) : fs * 1.2;
    const padT = px(st['padding-top'], 0, fs) || 0, padB = px(st['padding-bottom'], 0, fs) || 0;
    const b = borderSides(st, fs);
    let inner = L.textLines.length * lh;
    if (L.children.length && depth < 8) {
      let sum = 0, maxH = 0;
      for (const c of L.children) {
        const chH = px(c.style['height'], 0, c.fontSize) ?? estimateHeight(c, depth + 1);
        const disp = displayOf(c);
        if (disp === 'flex' || disp === 'grid' || BLOCK.has(c.el.tag)) sum += chH + (px(c.style['margin-top'], 0, c.fontSize) || 0) + (px(c.style['margin-bottom'], 0, c.fontSize) || 0);
        else maxH = Math.max(maxH, chH);
      }
      inner = Math.max(inner, sum + maxH);
    }
    return inner + padT + padB + b.t + b.b;
  };

  // compute static sizes first (needs child info), then positions
  const build = (el: Node, parentL: LayoutNode | null): LayoutNode => {
    const L = make(el, parentL);
    const st = L.style;
    L.fontSize = px(st['font-size'], parentL ? parentL.fontSize : 16, parentL ? parentL.fontSize : 16) || (parentL ? parentL.fontSize : 16);
    if (/%$/.test((st['font-size'] || '').trim())) L.fontSize = ((parentL ? parentL.fontSize : 16) * parseFloat(st['font-size'])) / 100;
    for (const c of el.children) {
      if (!styles.has(c)) continue;
      if (SKIP_TAGS.has(c.tag)) continue;
      L.children.push(build(c, L));
    }
    const ws = (st['white-space'] || 'normal');
    L.textLines = transformText(textOf(el, ws), st['text-transform']);
    return L;
  };

  const rootNode = make(body, null);
  rootNode.fontSize = 16;
  for (const c of body.children) {
    if (!styles.has(c)) continue;
    if (SKIP_TAGS.has(c.tag)) continue;
    rootNode.children.push(build(c, rootNode));
  }
  rootNode.textLines = transformText(textOf(body, 'normal'), rootNode.style['text-transform']);

  // position pass
  const DEBUG = typeof process !== 'undefined' && process.env && process.env.AE2AE_DEBUG;
  const layoutEl = (L: LayoutNode, px0: number, py0: number, availW: number, availH: number) => {
    const st = L.style;
    const display = displayOf(L);
    const position = (st['position'] || 'static').trim();
    if (DEBUG) console.error(`[layout] <${L.el.tag} class=${L.el.attrs['class']}> display=${display} position=${position} px0=${px0} py0=${py0} avail=${availW}x${availH} w=${st['width']} h=${st['height']} boxSoFar=${JSON.stringify(L.box)}`);
    const fs = L.fontSize;
    const weight = parseFloat(st['font-weight']) || (st['font-weight'] === 'bold' ? 700 : 400);
    const ls = px(st['letter-spacing'], 0, fs) || 0;
    const lhRaw = st['line-height']; let lh = lhRaw && lhRaw !== 'normal' ? (px(lhRaw, fs, fs) ?? (parseFloat(lhRaw) * fs || fs * 1.2)) : fs * 1.2;
    if (lhRaw && !/[pxem%]/.test(lhRaw) && lhRaw !== 'normal') lh = parseFloat(lhRaw) * fs;

    // wrap text to the explicit content width (browsers wrap; without this AE shows one long line)
    const wsRaw = (st['white-space'] || 'normal').trim();
    if (L.textLines.length && wsRaw !== 'nowrap' && wsRaw !== 'pre' && (st['width'] !== undefined || st['max-width'] !== undefined)) {
      const maxW0 = px(st['width'], availW, fs) ?? px(st['max-width'], availW, fs);
      if (maxW0 !== null && maxW0 > 0) {
        const b0 = borderSides(st, fs);
        const inner0 = maxW0 - (px(st['padding-left'], 0, fs) || 0) - (px(st['padding-right'], 0, fs) || 0) - b0.l - b0.r;
        if (inner0 > 0) L.textLines = wrapLines(L.textLines, inner0, fs, weight, ls);
      }
    }

    // ----- size -----
    const parentFs = L.parent ? L.parent.fontSize : fs;
    const b = borderSides(st, fs);
    const boxSizing = (st['box-sizing'] || 'content-box').trim();
    const textW = measureText(L.textLines, fs, weight, ls);
    const textH = Math.max(L.textLines.length, 1) * lh;
    let w = px(st['width'], availW, fs);
    let h = px(st['height'], availH, fs);
    if (st['max-width']) w = Math.min(w ?? Infinity, px(st['max-width'], availW, fs) ?? w ?? 0);
    const shrink = (position === 'absolute' || position === 'fixed') && w === null && !st['left']?.includes('auto');
    if (w === null && shrink) w = estimateWidth(L); // absolute elements shrink to fit
    if (w === null && (display === 'inline' || display === 'inline-block')) w = textW + (px(st['padding-left'], 0, fs) || 0) + (px(st['padding-right'], 0, fs) || 0);
    if (w === null) w = availW; // block default: fill parent
    if (h === null) h = (L.children.length || L.textLines.length) ? Math.max(textH, 0) : lh;
    // an <svg> with a viewBox and no explicit height keeps its aspect ratio (browser behavior)
    if (L.el.tag === 'svg' && h !== null && st['height'] === undefined) {
      const vb2 = (L.el.attrs['viewbox'] || L.el.attrs['viewBox'] || '').trim().split(/[\s,]+/).map(Number);
      if (vb2.length === 4 && vb2.every((n2) => !isNaN(n2)) && vb2[2] > 0 && w) h = w * vb2[3] / vb2[2];
    }
    // box-sizing: an explicit width/height is the BORDER box when border-box, the CONTENT box otherwise
    if (boxSizing === 'border-box') {
      L.box.w = Math.max(w, 0); L.box.h = Math.max(h, 0);
    } else {
      L.box.w = Math.max(w + (st['width'] !== undefined ? (px(st['padding-left'], 0, fs) || 0) + (px(st['padding-right'], 0, fs) || 0) + b.l + b.r : 0), 0);
      L.box.h = Math.max(h + (st['height'] !== undefined ? (px(st['padding-top'], 0, fs) || 0) + (px(st['padding-bottom'], 0, fs) || 0) + b.t + b.b : 0), 0);
    }

    // ----- position (resolve BEFORE children so nested layout uses the final origin) -----
    let bx: number, by: number;
    const offT = px(st['top'], L.parent ? L.parent.box.h : vh, fs), offL = px(st['left'], L.parent ? L.parent.box.w : vw, fs);
    const offB = px(st['bottom'], L.parent ? L.parent.box.h : vh, fs), offR = px(st['right'], L.parent ? L.parent.box.w : vw, fs);
    if (position === 'absolute' || position === 'fixed') {
      const anchor = positionedAncestor(L) || { box: { x: 0, y: 0, w: vw, h: vh } };
      bx = offL !== null ? anchor.box.x + offL : offR !== null ? anchor.box.x + anchor.box.w - offR - L.box.w : px0;
      by = offT !== null ? anchor.box.y + offT : offB !== null ? anchor.box.y + anchor.box.h - offB - L.box.h : py0;
      if (offL !== null && offR !== null) { bx = anchor.box.x + offL; L.box.w = Math.max(anchor.box.w - offL - offR, 0); }
      if (offT !== null && offB !== null) { by = anchor.box.y + offT; L.box.h = Math.max(anchor.box.h - offT - offB, 0); }
      // inset:0 + margin:auto centering
      if (offL !== null && offR !== null && offT !== null && offB !== null && (st['margin-left'] === 'auto' || st['margin-right'] === 'auto')) {
        bx = anchor.box.x + (anchor.box.w - L.box.w) / 2;
        by = anchor.box.y + (anchor.box.h - L.box.h) / 2;
      }
    } else {
      bx = px0 + (offL ?? 0) - (offR ?? 0);
      by = py0 + (offT ?? 0) - (offB ?? 0);
    }
    L.box.x = bx; L.box.y = by; L.staticX = bx; L.staticY = by;

    // ----- children (content area, laid out against the resolved origin) -----
    const padT = px(st['padding-top'], 0, fs) || 0, padB = px(st['padding-bottom'], 0, fs) || 0;
    const padL = px(st['padding-left'], 0, fs) || 0, padR = px(st['padding-right'], 0, fs) || 0;
    const contentW = Math.max(L.box.w - padL - padR - b.l - b.r, 0);
    const contentH = Math.max(L.box.h - padT - padB - b.t - b.b, 0);

    if (display === 'flex' || display === 'inline-flex') {
      const dir = (st['flex-direction'] || 'row').startsWith('column') ? 'col' : 'row';
      const gap = px(st['column-gap'], 0, fs) ?? px(st['gap'], 0, fs) ?? 0;
      const rowGap = px(st['row-gap'], 0, fs) ?? gap;
      const justify = st['justify-content'] || 'flex-start';
      const align = st['align-items'] || 'stretch';
      const kids = L.children;
      // container height: if not set explicitly, size to the tallest child (used for align centering)
      if (st['height'] === undefined) L.box.h = Math.max(estimateHeight(L), 1);
      const cH = Math.max(L.box.h - padT - padB - b.t - b.b, 0);
      // size children along main axis first
      const kidMargin = (k: LayoutNode, prop: string): number | 'auto' => {
        const mv = k.style[prop];
        return mv === 'auto' ? 'auto' : (px(mv, dir === 'row' ? contentW : cH, k.fontSize) || 0);
      };
      const sizes = kids.map((k) => {
        return dir === 'row'
          ? (px(k.style['width'], contentW, k.fontSize) ?? Math.max(estimateWidth(k), 1))
          : (px(k.style['height'], cH, k.fontSize) ?? lh);
      });
      const grow = kids.map((k) => { const f = parseFloat(k.style['flex-grow'] || '0'); return isNaN(f) ? 0 : f; });
      const mLs = kids.map((k) => kidMargin(k, 'margin-left'));
      const mRs = kids.map((k) => kidMargin(k, 'margin-right'));
      const totalFlex = grow.reduce((a, b2) => a + b2, 0);
      const fixed = sizes.reduce((a, b2, i) => a + b2 + (mLs[i] === 'auto' ? 0 : mLs[i]) + (mRs[i] === 'auto' ? 0 : mRs[i]), 0) + gap * Math.max(kids.length - 1, 0);
      let free = Math.max((dir === 'row' ? contentW : cH) - fixed, 0);
      const effSizes = sizes.map((s, idx2) => (totalFlex > 0 && grow[idx2] > 0 ? s + (free * grow[idx2]) / totalFlex : s));
      if (totalFlex > 0) free = 0;
      const main = dir === 'row' ? contentW : cH;
      const used = effSizes.reduce((a, b2, i) => a + b2 + (mLs[i] === 'auto' ? 0 : mLs[i]) + (mRs[i] === 'auto' ? 0 : mRs[i]), 0) + gap * Math.max(kids.length - 1, 0);
      let cursor = justify === 'center' ? (main - used) / 2 : justify === 'flex-end' ? main - used : 0;
      const between = justify === 'space-between' && kids.length > 1 ? (main - used) / (kids.length - 1) : 0;
      let extent = 0;
      kids.forEach((k, idx2) => {
        const size = effSizes[idx2];
        const ml = mLs[idx2], mr = mRs[idx2];
        if (ml === 'auto' && mr === 'auto') cursor = (main - size) / 2;
        else if (ml === 'auto') cursor = main - size - (mr === 'auto' ? 0 : mr);
        else cursor += ml;
        const kPadT = (px(k.style['padding-top'], 0, k.fontSize) || 0) + (px(k.style['border-top-width'], 0, k.fontSize) || 0);
        const kPadB = (px(k.style['padding-bottom'], 0, k.fontSize) || 0) + (px(k.style['border-bottom-width'], 0, k.fontSize) || 0);
        const crossSize = dir === 'row'
          ? (px(k.style['height'], cH, k.fontSize) ?? (k.textLines.length ? Math.max(k.textLines.length, 1) * ((px(k.style['line-height'], k.fontSize, k.fontSize)) ?? k.fontSize * 1.2) + kPadT + kPadB : cH))
          : (px(k.style['width'], contentW, k.fontSize) ?? contentW);
        let cross = align === 'center' ? (dir === 'row' ? cH - crossSize : contentW - crossSize) / 2 : align === 'flex-end' ? (dir === 'row' ? cH - crossSize : contentW - crossSize) : 0;
        if (dir === 'row') layoutEl(k, L.box.x + padL + b.l + cursor, L.box.y + padT + b.t + cross, size, crossSize);
        else layoutEl(k, L.box.x + padL + b.l + cross, L.box.y + padT + b.t + cursor, crossSize, size);
        cursor += size + gap + between + (mr === 'auto' ? 0 : mr);
        extent = Math.max(extent, (dir === 'row' ? k.box.y + k.box.h : k.box.x + k.box.w) - (dir === 'row' ? L.box.y : L.box.x));
      });
      if (st['height'] === undefined) L.box.h = Math.max(extent + padB + b.b, 1);
    } else if (display === 'grid' || display === 'inline-grid') {
      const colGap = px(st['column-gap'], 0, fs) ?? px(st['gap'], 0, fs) ?? 0;
      const rowGap = px(st['row-gap'], 0, fs) ?? colGap;
      const cols = parseGridTracks(st['grid-template-columns'] || '', contentW, colGap);
      const rowsSpec = parseGridTracks(st['grid-template-rows'] || '', contentH, rowGap);
      const items = L.children.filter((k) => displayOf(k) !== 'none');
      const nCols = Math.max(cols.length, 1);
      const nRows = Math.max(Math.ceil(items.length / nCols), rowsSpec.length, 1);
      // row heights: explicit rows first, then the tallest item in each row
      const rowH: number[] = [];
      for (let r = 0; r < nRows; r++) {
        if (rowsSpec[r] && rowsSpec[r].kind === 'len') { rowH.push(rowsSpec[r].px); continue; }
        let mx = rowsSpec[r]?.px || 0;
        for (let c = 0; c < nCols; c++) {
          const k = items[r * nCols + c];
          if (!k) continue;
          mx = Math.max(mx, px(k.style['height'], contentH, k.fontSize) ?? estimateHeight(k));
        }
        rowH.push(mx);
      }
      // column widths: fixed then fr distribution
      const colW: number[] = new Array(cols.length).fill(0);
      const frs = cols.map((t) => (t.kind === 'fr' ? t.px : 0));
      const fixedTotal = cols.reduce((a, t, i) => a + (t.kind === 'len' ? t.px : 0), 0);
      const frTotal = frs.reduce((a, b2) => a + b2, 0);
      const freeW = Math.max(contentW - fixedTotal - colGap * Math.max(cols.length - 1, 0), 0);
      cols.forEach((t, i) => { colW[i] = t.kind === 'len' ? t.px : (frTotal > 0 ? (freeW * t.px) / frTotal : freeW / Math.max(cols.length, 1)); });
      if (!cols.length) colW[0] = contentW;
      const colOff: number[] = []; let acc = 0;
      for (let c = 0; c < Math.max(cols.length, 1); c++) { colOff.push(acc); acc += colW[c] + colGap; }
      const rowOff: number[] = []; acc = 0;
      for (let r = 0; r < nRows; r++) { rowOff.push(acc); acc += rowH[r] + rowGap; }
      items.forEach((k, i) => {
        const c = i % nCols, r = Math.floor(i / nCols);
        const kx = L.box.x + padL + b.l + colOff[c];
        const ky = L.box.y + padT + b.t + rowOff[r];
        // place-items / align-items centering within the cell
        const placeAlign = (st['place-items'] || st['align-items'] || '').split(/\s+/)[0] || 'stretch';
        const placeJust = (st['place-items'] || st['justify-items'] || '').split(/\s+/)[1] || placeAlign;
        const kw = px(k.style['width'], colW[c], k.fontSize);
        const kh = px(k.style['height'], rowH[r], k.fontSize);
        let ox = 0, oy = 0;
        const cellW = kw ?? colW[c], cellH = kh ?? rowH[r];
        if (placeJust === 'center') ox = (colW[c] - cellW) / 2; else if (placeJust === 'end') ox = colW[c] - cellW;
        if (placeAlign === 'center') oy = (rowH[r] - cellH) / 2; else if (placeAlign === 'end') oy = rowH[r] - cellH;
        layoutEl(k, kx + ox, ky + oy, colW[c] - ox, rowH[r] - oy);
      });
      if (st['height'] === undefined) L.box.h = padT + b.t + rowOff[Math.max(nRows - 1, 0)] + rowH[Math.max(nRows - 1, 0)] + padB + b.b;
      if (st['width'] === undefined) L.box.w = padL + b.l + colOff[Math.max(cols.length - 1, 0)] + colW[Math.max(cols.length - 1, 0)] + padR + b.r;
    } else {
      // block / inline flow
      let y = padT + b.t;
      const flowKids = L.children;
      let inlineRow: LayoutNode[] = [];
      let rowX = padL + b.l;
      let rowStartX = rowX; // where THIS row began (flushRow may run after rowX advanced)
      const flushRow = (rowMaxH: number) => {
        for (const k of inlineRow) layoutEl(k, L.box.x + rowStartX, L.box.y + y, contentW - (rowStartX - padL - b.l), rowMaxH);
        inlineRow = []; rowX = padL + b.l; rowStartX = rowX; y += rowMaxH;
      };
      let rowH2 = 0;
      for (const k of flowKids) {
        const kDisp = displayOf(k);
        if (kDisp === 'none') continue;
        if (kDisp === 'inline' || kDisp === 'inline-block') {
          const kPadX = (px(k.style['padding-left'], 0, k.fontSize) || 0) + (px(k.style['padding-right'], 0, k.fontSize) || 0);
          const kw = px(k.style['width'], contentW, k.fontSize) ?? (measureText(k.textLines, k.fontSize, parseFloat(k.style['font-weight']) || 400, px(k.style['letter-spacing'], 0, k.fontSize) || 0) + kPadX);
          const kh = px(k.style['height'], lh * Math.max(k.textLines.length, 1), k.fontSize) ?? lh * Math.max(k.textLines.length, 1) + (px(k.style['padding-top'], 0, k.fontSize) || 0) + (px(k.style['padding-bottom'], 0, k.fontSize) || 0);
          if (rowX + kw > L.box.x - L.box.x + contentW + padL + b.l && inlineRow.length && rowX > padL) { /* wrap check below */ }
          if (rowX - padL - b.l + kw > contentW && inlineRow.length) flushRow(rowH2);
          k.box.w = kw; k.box.h = kh; k.staticX = rowX; k.staticY = y;
          inlineRow.push(k); rowX += kw; rowH2 = Math.max(rowH2, kh);
        } else {
          if (inlineRow.length) flushRow(rowH2);
          const mt = px(k.style['margin-top'], 0, k.fontSize) || 0;
          const mb = px(k.style['margin-bottom'], 0, k.fontSize) || 0;
          const ml = px(k.style['margin-left'], contentW, k.fontSize) || 0;
          const mr = px(k.style['margin-right'], contentW, k.fontSize) || 0;
          let autoML = /margin[^:]*:\s*[^;]*auto/.test(k.style['margin'] || '') || k.style['margin-left'] === 'auto' || k.style['margin-right'] === 'auto';
          y += mt;
          const kw = px(k.style['width'], contentW, k.fontSize);
          const boxSizing2 = (k.style['box-sizing'] || 'content-box').trim();
          const kb = borderSides(k.style, k.fontSize);
          const effW = kw !== null
            ? (boxSizing2 === 'border-box' ? kw : kw + (px(k.style['padding-left'], 0, k.fontSize) || 0) + (px(k.style['padding-right'], 0, k.fontSize) || 0) + kb.l + kb.r)
            : Math.max(contentW - ml - mr, 0);
          const kh = px(k.style['height'], contentH, k.fontSize);
          let kx = padL + b.l + ml;
          if (autoML && kw !== null) kx = padL + b.l + ml + (contentW - ml - mr - effW) / 2;
          layoutEl(k, L.box.x + kx, L.box.y + y, effW, kh ?? Math.max(contentH - (y - padT - b.t), 0));
          y += (k.box.h) + mb;
        }
      }
      if (inlineRow.length) flushRow(rowH2);
      if (st['height'] === undefined) L.box.h = Math.max(L.box.h, y + padB + b.b);
    }
  };

  // root: body fills viewport
  const bodyMargin = rootNode.style['margin'] !== undefined || rootNode.style['margin-top'] !== undefined;
  const bmT = px(rootNode.style['margin-top'], 0, 16) ?? (bodyMargin ? 8 : 0);
  const bmL = px(rootNode.style['margin-left'], 0, 16) ?? (bodyMargin ? 8 : 0);
  rootNode.box = { x: bmL, y: bmT, w: vw - bmL * 2, h: vh - bmT * 2 };
  let flowY = rootNode.box.y;
  for (const k of rootNode.children) {
    const mt = px(k.style['margin-top'], 0, k.fontSize) || 0;
    const mb = px(k.style['margin-bottom'], 0, k.fontSize) || 0;
    flowY += mt;
    layoutEl(k, rootNode.box.x, flowY, rootNode.box.w, rootNode.box.h);
    if ((k.style['position'] || 'static') === 'static' || (k.style['position'] || '') === 'relative') flowY += k.box.h + mb;
  }

  function positionedAncestor(L: LayoutNode): LayoutNode | null {
    let p = L.parent;
    while (p) {
      const pos = (p.style['position'] || 'static').trim();
      if (pos === 'relative' || pos === 'absolute' || pos === 'fixed') return p;
      p = p.parent;
    }
    return null;
  }
  return rootNode;
}

// parse "repeat(3, 1fr)" / "1.75fr 1fr" / "240px 1fr auto"
function parseGridTracks(spec: string, refSize: number, gap: number): { kind: 'len' | 'fr'; px: number }[] {
  if (!spec || spec === 'none') return [];
  const toks: string[] = [];
  let depth = 0, cur = '';
  for (const ch of spec) {
    if (ch === '(') depth++; else if (ch === ')') depth--;
    if (ch === ' ' && depth === 0) { if (cur.trim()) toks.push(cur.trim()); cur = ''; } else cur += ch;
  }
  if (cur.trim()) toks.push(cur.trim());
  const out: { kind: 'len' | 'fr'; px: number }[] = [];
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
function trackSpec(t: string, refSize: number): { kind: 'len' | 'fr'; px: number } {
  const fr = t.match(/^([\d.]+)fr$/);
  if (fr) return { kind: 'fr', px: parseFloat(fr[1]) || 1 };
  const v = px(t, refSize, 16);
  if (v !== null) return { kind: 'len', px: v };
  return { kind: 'fr', px: 1 }; // 'auto' and unknown behave like 1fr
}

function transformText(lines: string[], tt?: string): string[] {
  if (!tt) return lines;
  if (tt === 'uppercase') return lines.map((l) => l.toUpperCase());
  if (tt === 'lowercase') return lines.map((l) => l.toLowerCase());
  if (tt === 'capitalize') return lines.map((l) => l.replace(/\b\w/g, (c) => c.toUpperCase()));
  return lines;
}

// ---------- animation extraction ----------
type Anim = { name: string; duration: number; delay: number; iter: number | 'infinite'; direction: 'normal' | 'alternate'; fill: string; timing: string };

function parseTiming(tf: string): { interp: 'LINEAR' | 'BEZIER' | 'HOLD'; infIn: number; infOut: number } {
  const s = (tf || 'ease').trim();
  if (s === 'linear' || s === 'step-start') return { interp: 'LINEAR', infIn: 0, infOut: 0 };
  if (s.startsWith('steps') || s === 'step-end') return { interp: 'HOLD', infIn: 0, infOut: 0 };
  if (s === 'ease-in') return { interp: 'BEZIER', infIn: 16.7, infOut: 66.7 };
  if (s === 'ease-out') return { interp: 'BEZIER', infIn: 66.7, infOut: 16.7 };
  if (s === 'ease-in-out') return { interp: 'BEZIER', infIn: 60, infOut: 60 };
  return { interp: 'BEZIER', infIn: 55, infOut: 55 }; // 'ease' and cubic-bezier(...)
}

function parseAnim(st: Computed, warnings: string[]): Anim | null {
  const a: Anim = { name: '', duration: 0, delay: 0, iter: 1, direction: 'normal', fill: 'none', timing: 'ease' };
  let have = false;
  const sh = st['animation'];
  if (sh && sh !== 'none') {
    const toks = splitTop(sh, ' ').map((t) => t.trim()).filter(Boolean);
    const times: string[] = [];
    const rest: string[] = [];
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
    const iter = rest.find((t) => t === 'infinite' || /^[\d.]+$/.test(t));
    if (iter) a.iter = iter === 'infinite' ? 'infinite' : (parseFloat(iter) || 1);
    const dirRaw = rest.find((t) => t === 'alternate' || t === 'alternate-reverse' || t === 'reverse');
    a.direction = (dirRaw === 'alternate-reverse' ? 'alternate' : dirRaw === 'reverse' ? 'normal' : dirRaw) as Anim['direction'] || 'normal';
    const fill = rest.find((t) => /^(both|forwards|backwards|none)$/.test(t));
    if (fill) a.fill = fill;
    have = !!a.name;
    if (!have && times.length) warnings.push(`animation "${sh}" has no keyframes name`);
  }
  // longhands override the shorthand when present (CSS cascade order)
  if (st['animation-name'] && st['animation-name'] !== 'none') { a.name = st['animation-name']; have = true; }
  if (st['animation-duration']) a.duration = toSeconds(st['animation-duration']);
  if (st['animation-delay']) a.delay = toSeconds(st['animation-delay']);
  if (st['animation-iteration-count']) a.iter = st['animation-iteration-count'] === 'infinite' ? 'infinite' : (parseFloat(st['animation-iteration-count']) || 1);
  if (st['animation-direction']) a.direction = (st['animation-direction'] === 'alternate-reverse' ? 'alternate' : st['animation-direction'] === 'reverse' ? 'normal' : st['animation-direction']) as Anim['direction'];
  if (st['animation-fill-mode']) a.fill = st['animation-fill-mode'];
  if (st['animation-timing-function']) a.timing = st['animation-timing-function'];
  return have ? a : null;
}
function toSeconds(v: string): number { const m = v.match(/^([\d.]+)(ms|s)?$/); if (!m) return 0; return parseFloat(m[1]) * (m[2] === 'ms' ? 0.001 : 1); }

// ---------- gradients ----------
type GradSpec = {
  start: [number, number]; end: [number, number];
  c1: [number, number, number]; c2: [number, number, number];
  a1: number; a2: number;                 // stop alphas — sent to AE as RGBA ramp colors so glows fade for real
  radial: boolean; center: [number, number]; r: number; // box-space (screen coords, y down)
};

// split a background-image value into its comma-separated layers (top-level commas only)
function backgroundLayers(v: string): string[] {
  return splitTop(v, ',').map((s) => s.trim()).filter(Boolean);
}

// parse ONE gradient layer ("radial-gradient(ellipse at 78% 15%, rgba(...), transparent 34%)")
function parseGradientLayer(layer: string, box: Box, vw: number, vh: number): GradSpec | null {
  const g = layer.match(/(repeating-)?(linear|radial|conic)-gradient\s*\(/i);
  if (!g || g[2].toLowerCase() === 'conic') return null;
  if (g[1]) return null; // repeating gradients (patterns) are not convertible
  // take the balanced argument list
  const open = layer.indexOf('(', g.index! + g[0].length - 1);
  let depth = 0, endIdx = -1;
  for (let i = open; i < layer.length; i++) {
    if (layer[i] === '(') depth++;
    else if (layer[i] === ')') { depth--; if (!depth) { endIdx = i; break; } }
  }
  if (endIdx === -1) return null;
  const args = splitTop(layer.slice(open + 1, endIdx), ',').map((s) => s.trim()).filter(Boolean);
  const isRadial = g[2].toLowerCase() === 'radial';
  let ci = 0;
  let cxPct = 0.5, cyPct = 0.5, radiusFactor = 1;
  let angleDeg = 180;
  const first = args[0] || '';
  if (!isRadial) {
    if (/^to\s/.test(first)) {
      const dirs = first.split(/\s+/).slice(1);
      angleDeg = 180;
      if (dirs.includes('top')) angleDeg = 0;
      if (dirs.includes('right')) angleDeg = 90;
      if (dirs.includes('bottom')) angleDeg = 180;
      if (dirs.includes('left')) angleDeg = 270;
      if (dirs.includes('top') && dirs.includes('right')) angleDeg = 45;
      if (dirs.includes('top') && dirs.includes('left')) angleDeg = 315;
      if (dirs.includes('bottom') && dirs.includes('right')) angleDeg = 135;
      if (dirs.includes('bottom') && dirs.includes('left')) angleDeg = 225;
      ci = 1;
    } else if (/^[-\d.]+(deg|turn|rad)/.test(first)) {
      angleDeg = first.endsWith('turn') ? parseFloat(first) * 360 : first.endsWith('rad') ? (parseFloat(first) * 180) / Math.PI : parseFloat(first) || 0;
      ci = 1;
    }
  } else {
    if (!parseColor(first)) {
      ci = 1;
      const mAt = first.match(/at\s+([-\d.%]+)\s+([-\d.%]+)/);
      if (mAt) {
        cxPct = mAt[1].endsWith('%') ? parseFloat(mAt[1]) / 100 : parseFloat(mAt[1]) / Math.max(box.w, 1);
        cyPct = mAt[2].endsWith('%') ? parseFloat(mAt[2]) / 100 : parseFloat(mAt[2]) / Math.max(box.h, 1);
      }
      const mLen = first.split(/\bat\b/)[0].match(/([\d.]+)(px|em|%|fr)\s*$/);
      if (mLen) {
        const len = parseFloat(mLen[1]) * (mLen[2] === 'em' ? 16 : 1);
        radiusFactor = mLen[2] === '%' ? parseFloat(mLen[1]) / 100 : len / Math.hypot(box.w, box.h);
      }
    }
  }
  // color stops (color + optional position)
  const stops: { c: [number, number, number, number]; pos: number | null }[] = [];
  for (const a of args.slice(ci)) {
    const m = a.match(/^(.*?)(?:\s+([\d.]+%))?$/);
    const col = parseColor(m![1]);
    if (col) stops.push({ c: col, pos: m![2] ? parseFloat(m![2]) / 100 : null });
  }
  if (stops.length < 2) return null;
  const lastPos = stops[stops.length - 1].pos ?? 1;
  const toAE = (x: number, y: number): [number, number] => [x - vw / 2, vh / 2 - y];
  const cx = box.x + cxPct * box.w, cy = box.y + cyPct * box.h;
  if (isRadial) {
    let r: number;
    const farthest = Math.max(Math.hypot(cx - box.x, cy - box.y), Math.hypot(box.x + box.w - cx, cy - box.y), Math.hypot(cx - box.x, box.y + box.h - cy), Math.hypot(box.x + box.w - cx, box.y + box.h - cy));
    r = farthest * (radiusFactor !== 1 ? radiusFactor : Math.max(0.0001, lastPos));
    return {
      radial: true, center: [cx, cy], r,
      start: toAE(cx, cy), end: toAE(cx + r, cy),
      c1: [stops[0].c[0], stops[0].c[1], stops[0].c[2]], c2: [stops[stops.length - 1].c[0], stops[stops.length - 1].c[1], stops[stops.length - 1].c[2]],
      a1: stops[0].c[3], a2: stops[stops.length - 1].c[3],
    };
  }
  const rad = (angleDeg * Math.PI) / 180;
  // CSS angle: 0deg = to top, 90 = to right; screen coords y down
  const dx = Math.sin(rad), dy = -Math.cos(rad);
  const half = (Math.abs(dx) * box.w + Math.abs(dy) * box.h) / 2;
  return {
    radial: false, center: [cx, cy], r: half,
    start: toAE(cx - dx * half, cy - dy * half),
    end: toAE(cx + dx * half, cy + dy * half),
    c1: [stops[0].c[0], stops[0].c[1], stops[0].c[2]], c2: [stops[stops.length - 1].c[0], stops[stops.length - 1].c[1], stops[stops.length - 1].c[2]],
    a1: stops[0].c[3], a2: stops[stops.length - 1].c[3],
  };
}

// resolve a color that may be `currentColor` against the element's own color
function borderColorOf(v: string | undefined, st: Computed): [number, number, number, number] | null {
  if (!v) return null;
  if (/^currentcolor$/i.test(v.trim())) return parseColor(st['color'] || '#000');
  return parseColor(v);
}

// ---------- main conversion ----------
type Xform = { tx: number; ty: number; sx: number; sy: number; rot: number };
function parseTransform(v: string | undefined): Xform {
  const x: Xform = { tx: 0, ty: 0, sx: 1, sy: 1, rot: 0 };
  if (!v || v === 'none') return x;
  const re = /(translate|translateX|translateY|scale|scaleX|scaleY|rotate)\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(v))) {
    const fn = m[1], args = splitTop(m[2], ',').map((s) => s.trim());
    if (args.some((a) => a.includes('var('))) continue; // unresolved variables: skip this function
    const num = (s: string, ref = 0) => { const mm = s.match(/^(-?[\d.]+)(px|em|%|deg|turn|rad)?$/); if (!mm) return 0; const val = parseFloat(mm[1]); const u = mm[2]; if (u === '%') return (val / 100) * ref; if (u === 'em') return val * 16; if (u === 'turn') return val * 360; if (u === 'rad') return (val * 180) / Math.PI; return val; };
    if (fn === 'translate') { x.tx += num(args[0]); x.ty += num(args[1] || '0px'); }
    else if (fn === 'translateX') x.tx += num(args[0]);
    else if (fn === 'translateY') x.ty += num(args[0]);
    else if (fn === 'scale') {
      // careful: scale(0) is legal — never let a falsy 0 fall back to 1; % scales relative to 1
      const a0 = args[0] !== undefined && args[0] !== '' ? num(args[0], 1) : 1;
      const a1 = args[1] !== undefined ? num(args[1], 1) : a0;
      x.sx *= a0; x.sy *= a1;
    }
    else if (fn === 'scaleX') { x.sx *= args[0] !== undefined ? num(args[0], 1) : 1; }
    else if (fn === 'scaleY') { x.sy *= args[0] !== undefined ? num(args[0], 1) : 1; }
    else if (fn === 'rotate') x.rot += num(args[0], 0);
  }
  return x;
}
function cloneX(x: Xform): Xform { return { ...x }; }

// resolve transform-origin ("left center", "50% 50%", "0 0", "25% 10px") to an absolute screen point
function transformOriginPx(st: Computed, box: Box, fs: number): [number, number] | null {
  const raw = (st['transform-origin'] || '').trim().toLowerCase();
  if (!raw || raw === 'center') return null;
  const toks = raw.split(/\s+/).filter(Boolean);
  if (toks.length > 2) return null; // "left 20px top 30px" 4-token syntax: rare, keep default
  const resolve = (tok: string | undefined, ref: number): number => {
    const t = (tok || 'center').trim();
    if (t === 'left' || t === 'top' || t === '0') return 0;
    if (t === 'right' || t === 'bottom') return ref;
    if (t === 'center' || t === '') return ref / 2;
    if (t.endsWith('%')) return (parseFloat(t) / 100) * ref;
    const v = px(t, ref, fs);
    return v === null ? ref / 2 : v;
  };
  let a: string | undefined = toks[0], b2: string | undefined = toks[1];
  if ((a === 'top' || a === 'bottom') && !b2) { b2 = a; a = undefined; } // bare "top" = center-x, top-y
  if ((a === 'top' || a === 'bottom') && (b2 === 'left' || b2 === 'right')) { const tmp = a; a = b2; b2 = tmp; } // "top left" -> x,y
  const x = resolve(a, box.w), y = resolve(b2, box.h);
  return [box.x + x, box.y + y];
}

// inject ::before / ::after pseudo-elements as real child nodes so layout/visit handle them
function injectPseudos(root: Node, rules: Rule[]): void {
  const pseudoRules = rules
    .filter((r) => /:{1,2}(after|before)\s*$/i.test(r.selector))
    .map((r) => ({ base: r.selector.replace(/:{1,2}(after|before)\s*$/i, '').trim(), after: /:{1,2}after\s*$/i.test(r.selector), decls: r.decls }));
  if (!pseudoRules.length) return;
  const walk = (el: Node) => {
    for (const c of el.children) walk(c);
    if (el.tag === '#text' || el.tag === '#root') return;
    for (const pr of pseudoRules) {
      if (!pr.base || !matchesSelector(el, pr.base)) continue;
      const content = pr.decls.find((d) => d.prop === 'content');
      if (!content || /none|normal/i.test(content.value)) continue;
      const styleStr = pr.decls.filter((d) => d.prop !== 'content').map((d) => `${d.prop}:${d.value}`).join(';');
      const node: Node = { tag: 'span', attrs: { 'data-pseudo': '1', class: 'ae-pseudo', style: styleStr }, children: [], parent: null, order: el.order + 0.5 };
      if (el.children.length) (node as any).order = (el.children[el.children.length - 1] as any).order + 0.5;
      node.parent = el;
      if (pr.after) el.children.push(node); else el.children.unshift(node);
    }
  };
  walk(root);
}

// ---------- SVG path data ----------
type Seg = { cmd: string; pts: [number, number][] };
export function parsePathData(d: string): { verts: [number, number][]; inT: [number, number][]; outT: [number, number][]; closed: boolean; length: number } {
  const toks: string[] = [];
  const re = /([MmLlHhVvCcQqAaZz])|(-?\d*\.?\d+(?:e[-+]?\d+)?)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(d))) toks.push(m[0]);
  const segs: Seg[] = [];
  let i = 0, cmd = '';
  const num = () => parseFloat(toks[i++]);
  while (i < toks.length) {
    const t = toks[i];
    if (/^[a-zA-Z]$/.test(t)) { cmd = t; i++; if (cmd === 'Z' || cmd === 'z') { segs.push({ cmd: 'Z', pts: [] }); continue; } }
    const rel = cmd === cmd.toLowerCase() && cmd !== 'z';
    const C = cmd.toUpperCase();
    const pts: [number, number][] = [];
    const need = C === 'M' || C === 'L' ? 2 : C === 'H' || C === 'V' ? 1 : C === 'C' ? 6 : C === 'Q' ? 4 : C === 'A' ? 7 : 0;
    if (!need) { i++; continue; }
    for (let k = 0; k < need; k++) {
      if (i >= toks.length) break;
      const v = num();
      if (C === 'H') pts.push([v, 0]);
      else if (C === 'V') pts.push([0, v]);
      else pts.push([v, v]);
      if ((C === 'M' || C === 'L' || C === 'A') && k === 0 && need === 2 && i < toks.length && !/^[a-zA-Z]$/.test(toks[i])) { /* second coord next */ }
    }
    // rebuild coordinate pairs properly
    const flat: number[] = [];
    let j = i - need;
    while (j < i) flat.push(parseFloat(toks[j++]));
    if (C === 'H') { pts.length = 0; pts.push([flat[0], NaN]); }
    else if (C === 'V') { pts.length = 0; pts.push([NaN, flat[0]]); }
    else { pts.length = 0; for (let k = 0; k + 1 < flat.length + 1 && k < flat.length - 1; k += 2) pts.push([flat[k], flat[k + 1]]); }
    segs.push({ cmd: rel ? C.toLowerCase() : C, pts });
  }
  // walk segments into AE shape data (vertices + tangents relative to each vertex)
  let cx = 0, cy = 0, sx = 0, sy = 0;
  const verts: [number, number][] = [], inT: [number, number][] = [], outT: [number, number][] = [];
  let closed = false, length = 0;
  const pushVert = (p: [number, number], tin: [number, number], tout: [number, number]) => { verts.push(p); inT.push(tin); outT.push(tout); };
  for (const s of segs) {
    const c = s.cmd;
    if (c === 'M') {
      const p: [number, number] = [s.pts[0][0], s.pts[0][1]];
      if (!verts.length) { sx = p[0]; sy = p[1]; pushVert(p, [0, 0], [0, 0]); }
      else pushVert(p, [0, 0], [0, 0]);
      cx = p[0]; cy = p[1];
    } else if (c === 'm') {
      const p: [number, number] = [cx + s.pts[0][0], cy + s.pts[0][1]];
      if (!verts.length) { sx = p[0]; sy = p[1]; }
      pushVert(p, [0, 0], [0, 0]); cx = p[0]; cy = p[1];
    } else if (c === 'L' || c === 'l') {
      const p: [number, number] = c === 'L' ? [s.pts[0][0], s.pts[0][1]] : [cx + s.pts[0][0], cy + s.pts[0][1]];
      length += Math.hypot(p[0] - cx, p[1] - cy);
      outT[outT.length - 1] = [0, 0];
      pushVert(p, [0, 0], [0, 0]);
      cx = p[0]; cy = p[1];
    } else if (c === 'H' || c === 'h') {
      const nx = c === 'H' ? s.pts[0][0] : cx + s.pts[0][0];
      length += Math.abs(nx - cx);
      pushVert([nx, cy], [0, 0], [0, 0]); cx = nx;
    } else if (c === 'V' || c === 'v') {
      const ny = c === 'V' ? s.pts[0][1] : cy + s.pts[0][1];
      length += Math.abs(ny - cy);
      pushVert([cx, ny], [0, 0], [0, 0]); cy = ny;
    } else if (c === 'C' || c === 'c') {
      const [x1, y1] = c === 'C' ? s.pts[0] : [cx + s.pts[0][0], cy + s.pts[0][1]];
      const [x2, y2] = c === 'C' ? s.pts[1] : [cx + s.pts[1][0], cy + s.pts[1][1]];
      const p: [number, number] = c === 'C' ? s.pts[2] : [cx + s.pts[2][0], cy + s.pts[2][1]];
      length += Math.hypot(x1 - cx, y1 - cy) + Math.hypot(x2 - x1, y2 - y1) + Math.hypot(p[0] - x2, p[1] - y2);
      outT[outT.length - 1] = [x1 - cx, y1 - cy];
      pushVert(p, [x2 - p[0], y2 - p[1]], [0, 0]);
      cx = p[0]; cy = p[1];
    } else if (c === 'Q' || c === 'q') {
      const [qx, qy] = c === 'Q' ? s.pts[0] : [cx + s.pts[0][0], cy + s.pts[0][1]];
      const p: [number, number] = c === 'Q' ? s.pts[1] : [cx + s.pts[1][0], cy + s.pts[1][1]];
      const x1 = cx + (2 / 3) * (qx - cx), y1 = cy + (2 / 3) * (qy - cy);
      const x2 = p[0] + (2 / 3) * (qx - p[0]), y2 = p[1] + (2 / 3) * (qy - p[1]);
      length += Math.hypot(qx - cx, qy - cy) + Math.hypot(p[0] - qx, p[1] - qy);
      outT[outT.length - 1] = [x1 - cx, y1 - cy];
      pushVert(p, [x2 - p[0], y2 - p[1]], [0, 0]);
      cx = p[0]; cy = p[1];
    } else if (c === 'A') { // arc: approximate with a straight line to the endpoint
      const p: [number, number] = s.pts[5] ? [s.pts[5][0], s.pts[5][1]] : [cx, cy];
      if (s.pts.length >= 6) { length += Math.hypot(p[0] - cx, p[1] - cy); pushVert(p, [0, 0], [0, 0]); cx = p[0]; cy = p[1]; }
    } else if (c === 'Z') {
      closed = true;
      length += Math.hypot(sx - cx, sy - cy);
      cx = sx; cy = sy;
    }
  }
  return { verts, inT, outT, closed, length };
}

export function convertHtmlToLayers(html: string, opts: ConvertOptions = {}): ConvertResult {
  const warnings: string[] = [];
  const W = opts.width || 1920, H = opts.height || 1080, DUR = opts.duration || 10, FPS = opts.frameRate || 30;
  const SC = opts.scale || 1;
  let root = parseHTML(html);
  // AI snippets often omit <body>: synthesize one so `body {}` rules and layout have a root
  const hasBody = root.children.some((c) => c.tag === 'body') ||
    root.children.some((c) => c.children.some((g) => g.tag === 'body'));
  if (!hasBody) {
    const body: Node = { tag: 'body', attrs: {}, children: root.children, parent: null, order: 0 };
    for (const c of body.children) (c as any).parent = body;
    root = { tag: '#root', attrs: {}, children: [body], parent: null, order: 0 } as Node;
  }
  const stylesNodes = collectStyleText(root);
  const { rules, keyframes } = parseCSS(stylesNodes.css, W, H);
  injectPseudos(root, rules);
  const styles = computeStyles(root, rules, W, H);
  const tree = layoutTree(root, styles, W, H, warnings);

  const layers: LayerSpec[] = [];
  const usedNames = new Set<string>();
  const unique = (base: string) => { let nm = base || 'Layer', k = 2; while (usedNames.has(nm)) nm = `${base} ${k++}`; usedNames.add(nm); return nm; };

  const bodyStyle = styles.get(tree.el) || {};
  const bodyBg = parseColor(bodyStyle['background-color'] || bodyStyle['background'] || '');
  const htmlBg = parseColor(bodyStyle['background-color'] || '');
  const bgColor = htmlBg ?? bodyBg ? ([((htmlBg ?? bodyBg) as any)[0], ((htmlBg ?? bodyBg) as any)[1], ((htmlBg ?? bodyBg) as any)[2]] as [number, number, number]) : null;
  // flatten a CSS color over the comp background (AE fills are opaque)
  const mixOver = (c: [number, number, number, number], bg: [number, number, number] | null): [number, number, number] => {
    if (c[3] >= 0.999 || !bg) return [c[0], c[1], c[2]];
    const a = Math.max(0, Math.min(1, c[3]));
    return [c[0] * a + bg[0] * (1 - a), c[1] * a + bg[1] * (1 - a), c[2] * a + bg[2] * (1 - a)];
  };

  const visit = (L: LayoutNode) => {
    const st = L.style;
    const display = displayOf(L);
    if (display === 'none' || st['visibility'] === 'hidden') return;
    if (L.el.tag === 'body' || L.el.tag === 'html' || SKIP_TAGS.has(L.el.tag)) {
      for (const c of L.children) visit(c); return; // body maps to comp background, not a layer
    }
    const op = st['opacity'] !== undefined ? parseFloat(st['opacity']) : 1;
    const anim = parseAnim(st, warnings);
    if (!isNaN(op) && op <= 0 && !anim) return; // fully transparent AND never animated: safe to drop
    const baseX = parseTransform(st['transform']);
    if (L.el.tag === 'svg') { emitSvg(L, anim); return; }

    // HyperFrames-compatible layer trim: data-start / data-duration in seconds (plain number or "1.5s")
    const trim: { startTime?: number; duration?: number } = {};
    const ds = L.el.attrs['data-start'];
    const dd = L.el.attrs['data-duration'];
    if (ds !== undefined && /^\d/.test(ds.trim())) { const v = parseFloat(ds) * (ds.includes('ms') ? 0.001 : 1); if (!isNaN(v)) trim.startTime = Math.max(v, 0); }
    if (dd !== undefined && /^\d/.test(dd.trim())) { const v = parseFloat(dd) * (dd.includes('ms') ? 0.001 : 1); if (!isNaN(v) && v > 0) trim.duration = v; }

    const hasOwnText = L.textLines.length > 0;
    const bgLayersStr = st['background-image'] || '';
    const bgRaw = st['background-color'] || '';
    const bg = parseColor(bgRaw && bgRaw !== 'transparent' ? bgRaw : '');
    const bLayerList = bgLayersStr ? backgroundLayers(bgLayersStr) : [];
    const baseLayerStr = bLayerList.length ? bLayerList[bLayerList.length - 1] : (/(linear|radial)-gradient/i.test(st['background'] || '') ? st['background'] : '');
    const grad = baseLayerStr ? parseGradientLayer(baseLayerStr, L.box, W, H) : null;
    // extra background-image layers painted ON TOP of the base (CSS first layer = topmost)
    const extraGrads: { g: GradSpec; name: string }[] = [];
    if (bLayerList.length > 1 && !st['background-size']) {
      for (let i = bLayerList.length - 2; i >= 0; i--) {
        const gg = parseGradientLayer(bLayerList[i], L.box, W, H);
        if (gg) extraGrads.push({ g: gg, name: unique(`${nodeName(L)} bg ${i + 1}`) });
      }
    }
    const sides = { top: { w: px(st['border-top-width'], 0, L.fontSize) || 0, c: borderColorOf(st['border-top-color'], st) }, right: { w: px(st['border-right-width'], 0, L.fontSize) || 0, c: borderColorOf(st['border-right-color'], st) }, bottom: { w: px(st['border-bottom-width'], 0, L.fontSize) || 0, c: borderColorOf(st['border-bottom-color'], st) }, left: { w: px(st['border-left-width'], 0, L.fontSize) || 0, c: borderColorOf(st['border-left-color'], st) } };
    const sidesOn = (['top', 'right', 'bottom', 'left'] as const).filter((s) => sides[s].w > 0 && sides[s].c);
    const uniformBorder = sidesOn.length >= 2 ? { w: sides[sidesOn[0]].w, c: sides[sidesOn[0]].c! } : null;
    const brRaw = st['border-radius'];
    const brPct = brRaw && brRaw.trim().endsWith('%') ? parseFloat(brRaw) / 100 : 0;
    const brPx = brRaw && !brRaw.trim().endsWith('%') ? px(brRaw.split(/\s+/)[0], Math.min(L.box.w, L.box.h), L.fontSize) || 0 : 0;
    const isEllipse = brPct >= 0.5 || (brPx > 0 && brPx >= Math.min(L.box.w, L.box.h) / 2 - 0.5);
    const hasBox = !!bg || grad || !!uniformBorder;
    const kf = anim ? keyframes.find((k) => k.name === anim.name) : null;
    if (anim && !kf) warnings.push(`@keyframes "${anim.name}" not found (element "${nodeName(L)}")`);

    // which animated properties does this element use?
    const animProps = new Set<string>();
    if (kf) for (const stop of kf.stops) for (const d of stop.decls) animProps.add(d.prop);

    const zOrd = (st['z-index'] ? parseInt(st['z-index']) || 0 : 0);
    const domOrd = L.el.order;

    // transform-origin: when an element transforms around a non-center origin, AE gets a REAL
    // anchor pivot and Position references the pivot (CSS scales/rotates around that same point)
    const hasXform = !!anim || baseX.tx !== 0 || baseX.ty !== 0 || baseX.sx !== 1 || baseX.sy !== 1 || baseX.rot !== 0;
    let pivot: [number, number] | null = null;
    const po = transformOriginPx(st, L.box, L.fontSize);
    if (po && hasXform) {
      const cx0 = L.box.x + L.box.w / 2, cy0 = L.box.y + L.box.h / 2;
      if (Math.abs(po[0] - cx0) > 0.5 || Math.abs(po[1] - cy0) > 0.5) pivot = po;
    }
    const refX = (pivot ? pivot[0] : L.box.x + L.box.w / 2) * SC;
    const refY = (pivot ? pivot[1] : L.box.y + L.box.h / 2) * SC;
    const commonStatic = () => ({
      pos: [refX + baseX.tx * SC - W / 2, H / 2 - (refY + baseX.ty * SC)] as [number, number],
      rotation: -baseX.rot,
      scale: [baseX.sx * 100, baseX.sy * 100] as [number, number],
      opacity: (isNaN(op) ? 1 : op) * 100,
    });
    // pivot in layer source coords, AE-native y-down for BOTH kinds:
    //   solid = top-left origin (source spans 0..w, 0..h)
    //   shape = centered origin (shape content is centered on the layer origin, y grows down)
    // A pivot below the element center must get anchor.y > center (e.g. scaleY from "center bottom"
    // grows the bar UPWARD in AE — negating dy made it grow downward instead)
    const anchorFor = (kind: 'solid' | 'shape'): [number, number] | undefined => {
      if (!pivot) return undefined;
      const dx = (pivot[0] - (L.box.x + L.box.w / 2 + baseX.tx)) * SC;
      const dy = (pivot[1] - (L.box.y + L.box.h / 2 + baseX.ty)) * SC;
      return kind === 'solid' ? [L.box.w * SC / 2 + dx, L.box.h * SC / 2 + dy] : [dx, dy];
    };
    // gradient start/end -> AE Ramp coordinates (layer space, y-down): the Ramp effect is placed
    // relative to the layer SOURCE, not the comp — comp-space values landed at the wrong offset.
    // Layer space is y-down for BOTH kinds (solid: top-left origin; shape: centered origin), so
    // the y-up delta (g-P) flips sign in both cases. Keeping shapes y-up rendered every off-center
    // / angled gradient mirrored vertically inside real AE (the canvas preview hid this because it
    // used the same wrong convention).
    const gradToLayer = (gs: GradSpec, kind: 'solid' | 'shape', P: [number, number], A: [number, number] | undefined): NonNullable<LayerSpec['gradient']> => {
      const a0 = A ? A[0] : 0, a1y = A ? A[1] : 0;
      const conv = (g: [number, number]): [number, number] => {
        const d0 = g[0] - P[0], d1 = g[1] - P[1];
        return [a0 + d0, a1y - d1];
      };
      return { start: conv(gs.start), end: conv(gs.end), c1: gs.c1, c2: gs.c2, a1: gs.a1, a2: gs.a2, radial: gs.radial };
    };

    // ---- box layer (div with bg / border) ----
    if (hasBox && L.box.w > 0 && L.box.h > 0) {
      const shadow = parseShadow(st['box-shadow'] || st['text-shadow']);
      const animatesColor = animProps.has('background-color') || animProps.has('background');
      const needShape = isEllipse || !!grad || animatesColor || !!uniformBorder;
      const kindL: 'solid' | 'shape' = needShape ? 'shape' : 'solid';
      const stat = commonStatic();
      const A0 = anchorFor(kindL);
      const layer: LayerSpec = {
        kind: kindL,
        name: unique(nodeName(L)),
        w: L.box.w * SC, h: L.box.h * SC,
        ...stat,
        anchor: A0,
        shape: isEllipse ? 'ellipse' : 'rect',
        roundness: isEllipse ? undefined : Math.min(brPx * SC, Math.min(L.box.w, L.box.h) / 2),
        // no background-color and no gradient -> stroke-only shape (null fill), never a black disc
        fill: needShape ? ((bg ? mixOver(bg, bgColor) : grad ? grad.c1 : null) as [number, number, number] | null) : undefined,
        stroke: uniformBorder ? ([uniformBorder.c[0], uniformBorder.c[1], uniformBorder.c[2]] as [number, number, number]) : null,
        strokeWidth: uniformBorder ? uniformBorder.w * SC : undefined,
        color: !needShape && bg ? (mixOver(bg, bgColor) as [number, number, number]) : undefined,
        gradient: grad ? gradToLayer(grad, kindL, stat.pos, A0) : null,
        shadow,
        fillOverride: null,
        keys: {},
      };
      if (anim && kf) applyKeyframes(layer, kf, anim, L, baseX, pivot, W, H, DUR, FPS, SC, animProps, warnings);
      layers.push({ ...layer, ...trim, _z: zOrd, _dom: domOrd } as any);
      // single-side borders become a thin edge layer (AE strokes are uniform)
      if (!uniformBorder && sidesOn.length === 1) {
        const s = sidesOn[0];
        const bw = sides[s].w, bc = sides[s].c!;
        const edge: Box = s === 'bottom' ? { x: L.box.x, y: L.box.y + L.box.h - bw, w: L.box.w, h: bw }
          : s === 'top' ? { x: L.box.x, y: L.box.y, w: L.box.w, h: bw }
            : s === 'left' ? { x: L.box.x, y: L.box.y, w: bw, h: L.box.h }
              : { x: L.box.x + L.box.w - bw, y: L.box.y, w: bw, h: L.box.h };
        layers.push({
          kind: 'solid', name: unique(`${nodeName(L)} border-${s}`),
          w: edge.w * SC, h: edge.h * SC,
          pos: [edge.x + edge.w / 2 - W / 2, H / 2 - (edge.y + edge.h / 2)] as [number, number],
          rotation: 0, scale: [100, 100], opacity: (isNaN(op) ? 1 : op) * 100,
          color: mixOver(bc, bgColor), keys: {},
        } as any);
      }
      // extra background-image layers on top (multi-layer backgrounds)
      for (const ex of extraGrads) {
        const g = ex.g;
        if (g.radial) {
          layers.push({
            kind: 'shape', name: ex.name, w: 2 * g.r * SC, h: 2 * g.r * SC,
            pos: [g.center[0] - W / 2, H / 2 - g.center[1]] as [number, number],
            rotation: 0, scale: [100, 100], opacity: (isNaN(op) ? 1 : op) * 100,
            shape: 'ellipse', fill: g.c1,
            gradient: { start: [0, 0], end: [g.r * SC, 0], c1: g.c1, c2: g.c2, a1: g.a1, a2: g.a2, radial: true },
            shadow: null, fillOverride: null, keys: {},
          } as any);
        } else {
          const posE: [number, number] = [L.box.x + L.box.w / 2 - W / 2, H / 2 - (L.box.y + L.box.h / 2)] as [number, number];
          layers.push({
            kind: 'shape', name: ex.name, w: L.box.w * SC, h: L.box.h * SC,
            pos: posE,
            rotation: 0, scale: [100, 100], opacity: (isNaN(op) ? 1 : op) * 100,
            shape: 'rect', fill: g.c1,
            gradient: gradToLayer(g, 'shape', posE, undefined),
            shadow: null, fillOverride: null, keys: {},
          } as any);
        }
      }
    }

    // ---- image ----
    if (L.el.tag === 'img') {
      const src = L.el.attrs['src'] || '';
      const file = src.replace(/^file:\/\//, '').replace(/^\.\//, '');
      const imgLayer: LayerSpec = {
        kind: 'footage', name: unique(nodeName(L)), w: L.box.w * SC, h: L.box.h * SC, ...commonStatic(),
        file: /^([a-zA-Z]:[\\/]|\/)/.test(file) ? file : undefined, keys: {},
      };
      if (anim && kf) applyKeyframes(imgLayer, kf, anim, L, baseX, pivot, W, H, DUR, FPS, SC, animProps, warnings);
      layers.push({ ...imgLayer, ...trim, _z: zOrd, _dom: domOrd } as any);
      if (!/^([a-zA-Z]:[\\/]|\/)/.test(file)) warnings.push(`img src "${src}" is not an absolute path; a placeholder will be needed`);
    }

    // ---- text ----
    if (hasOwnText) {
      const color = parseColor(st['color'] || '#000000') || [0, 0, 0, 1];
      const weight = parseFloat(st['font-weight']) || (st['font-weight'] === 'bold' ? 700 : 400);
      const famRaw = (st['font-family'] || 'Arial').split(',')[0].trim().replace(/["']/g, '');
      const fam = /sans-serif/i.test(famRaw) ? 'Arial' : /serif/i.test(famRaw) && !/sans/i.test(famRaw) ? 'Times New Roman' : /mono/i.test(famRaw) ? 'Courier New' : famRaw;
      const font = weight >= 600 ? fam + ' Bold' : fam;
      const ls = px(st['letter-spacing'], 0, L.fontSize) || 0;
      // unitless line-height ("1.2") multiplies the font size — never read it as px
      let lh = L.fontSize * 1.2;
      const lhRaw2 = (st['line-height'] || '').trim();
      if (lhRaw2 && lhRaw2 !== 'normal') {
        if (/^[\d.]+$/.test(lhRaw2)) lh = parseFloat(lhRaw2) * L.fontSize;
        else lh = px(lhRaw2, L.fontSize, L.fontSize) ?? (parseFloat(lhRaw2) * L.fontSize || L.fontSize * 1.2);
      }
      const ta = (st['text-align'] || 'left') as string;
      const just: 'left' | 'center' | 'right' = ta === 'center' ? 'center' : (ta === 'right' || ta === 'end') ? 'right' : 'left';
      const padL = px(st['padding-left'], 0, L.fontSize) || 0, padR = px(st['padding-right'], 0, L.fontSize) || 0;
      // pos.x follows the alignment so the text block hugs the correct edge
      const anchorX: 'left' | 'center' | 'right' = just;
      const textPosX = just === 'center' ? L.box.x + L.box.w / 2 : just === 'right' ? L.box.x + L.box.w - padR : L.box.x + padL;
      // browsers lay text out from the TOP of the box (padding + borders included), never
      // vertically centered — centering the AE text on the box center put it too low
      const padT0 = px(st['padding-top'], 0, L.fontSize) || 0;
      const bT0 = px(st['border-top-width'], 0, L.fontSize) || 0;
      const textCenterY = L.box.y + padT0 + bT0 + (L.textLines.length * lh) / 2;
      const tRefX = (pivot ? pivot[0] : textPosX) * SC;
      const tRefY = (pivot ? pivot[1] : textCenterY) * SC;
      const layer: LayerSpec = {
        kind: 'text', name: unique((L.textLines[0] || 'Text').slice(0, 30) || nodeName(L)),
        w: L.box.w * SC, h: L.box.h * SC,
        pos: [tRefX + baseX.tx * SC - W / 2, H / 2 - (tRefY + baseX.ty * SC)] as [number, number],
        rotation: -baseX.rot,
        scale: [baseX.sx * 100, baseX.sy * 100] as [number, number],
        opacity: (isNaN(op) ? 1 : op) * 100,
        anchorX,
        anchorOffset: pivot ? [(pivot[0] - textPosX) * SC, (pivot[1] - textCenterY) * SC] : undefined,
        text: L.textLines.join('\r'),
        font, fontSize: L.fontSize * SC,
        justification: just,
        tracking: ls ? Math.round((ls * 1000) / Math.max(L.fontSize, 1)) : undefined,
        leading: lh * SC,
        color: mixOver(color, bgColor),
        shadow: parseShadow(st['text-shadow']),
        keys: {},
      };
      if (anim && kf) applyKeyframes(layer, kf, anim, L, baseX, pivot, W, H, DUR, FPS, SC, animProps, warnings);
      layers.push({ ...layer, ...trim, _z: zOrd, _dom: domOrd } as any);
    }

    for (const c of L.children) visit(c);
  };
  visit(tree);

  // ---------- SVG: paths, circles, trim-path "draw" animations ----------
  function emitSvg(L: LayoutNode, svgAnim: Anim | null) {
    const box = L.box;
    if (box.w <= 0 || box.h <= 0) return;
    const vb = (L.el.attrs['viewbox'] || L.el.attrs['viewBox'] || '').trim().split(/[\s,]+/).map(Number);
    const hasVB = vb.length === 4 && vb.every((n) => !isNaN(n));
    const sx = hasVB ? box.w / vb[2] : 1, sy = hasVB ? box.h / vb[3] : 1;
    const op = L.style['opacity'] !== undefined ? parseFloat(L.style['opacity']) : 1;
    const mapPt = (x: number, y: number): [number, number] => [box.x + x * sx, box.y + y * sy];
    const toAE = (x: number, y: number): [number, number] => [x - W / 2, H / 2 - y];
    const stOf = (el: Node): Computed => styles.get(el) || {};
    const strokeOf = (el: Node, st: Computed) => borderColorOf(st['stroke'] || el.attrs['stroke'] || '', st);
    const widthOf = (el: Node, st: Computed) => px(st['stroke-width'] || el.attrs['stroke-width'], 0, L.fontSize) || 1;
    const fillOf = (el: Node, st: Computed) => {
      const f = st['fill'] || el.attrs['fill'] || '';
      if (!f || f === 'none') return null;
      if (/url\(/.test(f)) return null; // gradient refs: unsupported (warning once)
      return parseColor(f);
    };
    let warnedUrl = false;
    const svgOpacity = (el: Node, st: Computed) => {
      const a = st['opacity'] !== undefined ? parseFloat(st['opacity']) : (el.attrs['opacity'] !== undefined ? parseFloat(el.attrs['opacity']) : 1);
      return (isNaN(a) ? 1 : a) * (isNaN(op) ? 1 : op) * 100;
    };

    const visitSvg = (el: Node) => {
      for (const c of el.children) {
        const st = stOf(c);
        const o = svgOpacity(c, st);
        if (o <= 0) continue;
        if (c.tag === 'path' || c.tag === 'line' || c.tag === 'polyline' || c.tag === 'polygon') {
          let data: ReturnType<typeof parsePathData> | null = null;
          if (c.tag === 'path' && c.attrs['d']) data = parsePathData(c.attrs['d']);
          else if (c.tag === 'line') data = { verts: [[+c.attrs['x1'], +c.attrs['y1']], [+c.attrs['x2'], +c.attrs['y2']]], inT: [[0, 0], [0, 0]], outT: [[0, 0], [0, 0]], closed: false, length: Math.hypot(+c.attrs['x2'] - +c.attrs['x1'], +c.attrs['y2'] - +c.attrs['y1']) };
          else {
            const pts = (c.attrs['points'] || '').trim().split(/[\s,]+/).map(Number);
            const vv: [number, number][] = [];
            for (let k = 0; k + 1 < pts.length; k += 2) vv.push([pts[k], pts[k + 1]]);
            if (vv.length >= 2) {
              let len = 0;
              for (let k = 1; k < vv.length; k++) len += Math.hypot(vv[k][0] - vv[k - 1][0], vv[k][1] - vv[k - 1][1]);
              data = { verts: vv, inT: vv.map(() => [0, 0] as [number, number]), outT: vv.map(() => [0, 0] as [number, number]), closed: c.tag === 'polygon', length: len };
            }
          }
          if (data && data.verts.length >= 2) {
            const fill = fillOf(c, st);
            if (!fill && /url\(/.test((st['fill'] || c.attrs['fill'] || '')) && !warnedUrl) { warnings.push('svg fill="url(#...)" gradients are approximated (no fill)'); warnedUrl = true; }
            const stroke = strokeOf(c, st);
            const sw = widthOf(c, st) * ((sx + sy) / 2);
            // layer anchor = center of the path bbox (all vertices relative to it)
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            const mapped = data.verts.map(([x, y]) => mapPt(x, y));
            for (const [x, y] of mapped) { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); }
            const cxA = (minX + maxX) / 2, cyA = (minY + maxY) / 2;
            const layer: LayerSpec = {
              kind: 'shape', name: unique(c.attrs['class'] ? `path.${c.attrs['class'].split(/\s+/)[0]}` : c.tag),
              w: Math.max(maxX - minX, 1) * SC, h: Math.max(maxY - minY, 1) * SC,
              pos: [cxA - W / 2, H / 2 - cyA], rotation: 0, scale: [100, 100], opacity: o,
              shape: 'path',
              path: {
                verts: mapped.map(([x, y]) => [(x - cxA) * SC, (y - cyA) * -SC] as [number, number]),
                inT: data.inT.map(([x, y]) => [x * sx * SC, -y * sy * SC] as [number, number]),
                outT: data.outT.map(([x, y]) => [x * sx * SC, -y * sy * SC] as [number, number]),
                closed: data.closed,
              },
              fill: fill ? mixOver(fill, bgColor) : null,
              stroke: stroke ? mixOver(stroke, bgColor) : null,
              strokeWidth: sw * SC,
              shadow: null, fillOverride: null, keys: {},
            };
            // stroke-dashoffset keyframes -> Trim Paths "End" (the classic line-draw)
            const anim = parseAnim(st, warnings);
            const kf2 = anim ? keyframes.find((k) => k.name === anim.name) : null;
            if (anim && kf2) {
              const dashLen = parseFloat(st['stroke-dasharray'] || c.attrs['stroke-dasharray'] || '0') || data.length || 1;
              const timing = parseTiming(anim.timing);
              const trims: KeyframeSpec[] = [];
              const staticOff = Math.abs(parseFloat(st['stroke-dashoffset'] || c.attrs['stroke-dashoffset'] || '0')) || Math.min(dashLen, data.length);
              // CSS infers a missing 0%/100% stop from the element's static style
              const stops2 = [...kf2.stops];
              if (stops2.length && stops2[0].pct > 0) stops2.unshift({ pct: 0, decls: [] });
              if (stops2.length && stops2[stops2.length - 1].pct < 100) stops2.push({ pct: 100, decls: [] });
              for (const s of stops2) {
                const off = s.decls.find((d) => d.prop === 'stroke-dashoffset');
                const v0 = off ? Math.abs(parseFloat(off.value)) : staticOff;
                const pct = Math.max(0, Math.min(100, (1 - Math.min(v0, data.length || dashLen) / (data.length || dashLen)) * 100));
                const t = Math.round((s.pct / 100 * anim.duration + anim.delay) * FPS) / FPS;
                if (t <= DUR + 1e-6) trims.push({ t, v: pct, ...timing });
              }
              trims.sort((a, b) => a.t - b.t);
              if (trims.length) (layer.keys as any).TrimEnd = trims;
            }
            layers.push(layer as any);
          }
        } else if (c.tag === 'circle' || c.tag === 'ellipse') {
          const cxN = parseFloat(c.attrs['cx'] || '0'), cyN = parseFloat(c.attrs['cy'] || '0');
          const rx = parseFloat(c.attrs['rx'] || c.attrs['r'] || '0'), ry = parseFloat(c.attrs['ry'] || c.attrs['r'] || '0');
          if (rx > 0 && ry > 0) {
            const [pxA, pyA] = mapPt(cxN, cyN);
            const fill = fillOf(c, st), stroke = strokeOf(c, st);
            layers.push({
              kind: 'shape', name: unique(c.attrs['class'] ? `${c.tag}.${c.attrs['class'].split(/\s+/)[0]}` : c.tag),
              w: 2 * rx * sx * SC, h: 2 * ry * sy * SC,
              pos: [pxA - W / 2, H / 2 - pyA], rotation: 0, scale: [100, 100], opacity: svgOpacity(c, st),
              shape: 'ellipse',
              fill: fill ? mixOver(fill, bgColor) : null,
              stroke: stroke ? mixOver(stroke, bgColor) : null,
              strokeWidth: stroke ? widthOf(c, st) * ((sx + sy) / 2) * SC : undefined,
              shadow: null, fillOverride: null, keys: {},
            } as any);
          }
        } else {
          visitSvg(c);
        }
      }
    };
    visitSvg(L.el);
  }

  // sort bottom-first: lower z-index first, then DOM order (later DOM paints on top)
  (layers as any).sort((a: any, b: any) => (a._z - b._z) || (a._dom - b._dom));
  for (const l of layers) { delete (l as any)._z; delete (l as any)._dom; }

  if (!layers.length) warnings.push('No convertible elements found (need visible text or background-colored elements)');

  return {
    createComp: opts.createComp !== false,
    compName: opts.compName || 'HTML Motion',
    width: W, height: H, duration: DUR, frameRate: FPS,
    bgColor,
    clearComp: false,
    layers,
    warnings,
  };

  function parseShadow(v?: string): LayerSpec['shadow'] {
    if (!v || v === 'none') return null;
    // use the FIRST shadow of a comma list; inset shadows are not representable
    const first = splitTop(v, ',').map((s) => s.trim()).find((s) => s && !/\binset\b/.test(s));
    if (!first) return null;
    const parts = splitTop(first, ' ').map((s) => s.trim());
    const col = parts.map((p) => parseColor(p)).find(Boolean) as [number, number, number, number] | undefined;
    const nums = parts.filter((p) => /^[-\d.]+(px|em)?$/.test(p)).map((p) => parseFloat(p) || 0);
    if (nums.length < 2) return null;
    const [ox, oy, blur = 0] = nums;
    const alpha = col ? col[3] : 1;
    return {
      direction: (Math.atan2(oy, ox) * 180) / Math.PI,
      distance: Math.hypot(ox, oy) * SC,
      opacity: alpha * 100,
      softness: Math.max(blur * 0.5 * SC, 0),
      color: col ? mixOver(col, bgColor) : [0, 0, 0],
    };
  }

  function nodeName(L: LayoutNode): string {
    if (L.el.attrs['data-pseudo'] !== undefined) {
      const pc = L.parent ? (L.parent.el.attrs['class'] || L.parent.el.tag) : 'el';
      return `${pc}:${L.el.attrs['class'] === 'ae-pseudo' ? 'after' : 'pseudo'}`;
    }
    const id = L.el.attrs['id']; const cls = (L.el.attrs['class'] || '').split(/\s+/)[0];
    return id ? id : cls ? `${L.el.tag}.${cls}` : L.el.tag;
  }

  // expand one @keyframes rule into keyframes on a layer spec
  function applyKeyframes(
    layer: LayerSpec, kf: KeyframeRule, anim: Anim, L: LayoutNode, base: Xform, pivot: [number, number] | null,
    Wc: number, Hc: number, dur: number, fps: number, sc: number,
    animProps: Set<string>, warns: string[],
  ) {
    type StopEx = { pct: number; decls: Decl[]; isSynth: boolean };
    // CSS semantics: a missing 0%/100% stop is inferred from the element's computed style.
    // Synthesize those boundary stops so AE gets a proper first/last key.
    const norm: StopEx[] = [];
    if (kf.stops.length) {
      const mk = (s: { pct: number; decls: Decl[] }): StopEx => ({ pct: s.pct, decls: s.decls, isSynth: false });
      if (kf.stops[0].pct > 0) norm.push({ pct: 0, decls: [], isSynth: true });
      for (const s of kf.stops) norm.push(mk(s));
      if (kf.stops[kf.stops.length - 1].pct < 100) norm.push({ pct: 100, decls: [], isSynth: true });
    }
    const snap = (stop: StopEx): Xform & { opacity?: number; color?: [number, number, number]; top?: number; left?: number; w?: number; h?: number } => {
      const merged: Record<string, string> = {};
      for (const d of stop.decls) merged[d.prop] = d.value;
      const st0 = L.style; // element static style: fallback source for synthesized boundary stops
      const bx = cloneX(base);
      const xf = parseTransform(merged['transform']);
      bx.tx += xf.tx; bx.ty += xf.ty; bx.sx *= xf.sx; bx.sy *= xf.sy; bx.rot += xf.rot;
      const out: any = { ...bx };
      const op0 = merged['opacity'] ?? (stop.isSynth ? st0['opacity'] : undefined);
      if (op0 !== undefined) out.opacity = parseFloat(op0) * 100;
      const c = parseColor(merged['background-color'] || merged['background'] || merged['color'] ||
        (stop.isSynth ? (st0['background-color'] || st0['background'] || st0['color'] || '') : ''));
      if (c) out.color = [c[0], c[1], c[2]];
      const top0 = merged['top'] ?? (stop.isSynth ? st0['top'] : undefined);
      if (top0 !== undefined) out.top = px(top0, L.parent ? L.parent.box.h : Hc, L.fontSize);
      const left0 = merged['left'] ?? (stop.isSynth ? st0['left'] : undefined);
      if (left0 !== undefined) out.left = px(left0, L.parent ? L.parent.box.w : Wc, L.fontSize);
      const w0 = merged['width'] ?? (stop.isSynth ? st0['width'] : undefined);
      if (w0 !== undefined) out.w = px(w0, L.box.w, L.fontSize);
      const h0 = merged['height'] ?? (stop.isSynth ? st0['height'] : undefined);
      if (h0 !== undefined) out.h = px(h0, L.box.h, L.fontSize);
      return out;
    };

    const timing = parseTiming(anim.timing);
    const cycle = anim.duration || 1;
    const repeats = anim.iter === 'infinite' ? Math.min(Math.ceil(dur / Math.max(cycle, 0.01)), 40) : Math.max(Math.round(anim.iter), 1);
    const keys: Record<string, KeyframeSpec[]> = { Position: [], Scale: [], Rotation: [], Opacity: [], FillColor: [], RectSize: [], TrimEnd: [] };
    const toAE = (x: number, y: number): [number, number] => [x - Wc / 2, Hc / 2 - y];
    const maxKeysPerProp = 400;
    // Position references the transform-origin pivot when one is set (AE keeps the anchor at Position)
    const refX = pivot ? pivot[0] : L.box.x + L.box.w / 2;
    const refY = pivot ? pivot[1] : L.box.y + L.box.h / 2;
    // which transform sub-properties appear anywhere in this animation?
    const allTransform = kf.stops.map((s) => s.decls.filter((d) => d.prop === 'transform').map((d) => d.value).join(' ')).join(' ');
    const hasScale = /scale/i.test(allTransform);
    const hasTranslate = /translate/i.test(allTransform) || animProps.has('top') || animProps.has('left');
    const hasRotate = /rotate/i.test(allTransform);
    const hasOpacity = animProps.has('opacity');
    const hasColor = animProps.has('background-color') || animProps.has('background') || animProps.has('color');
    const hasSize = animProps.has('width') || animProps.has('height');

    for (let r = 0; r < repeats; r++) {
      const reversed = anim.direction === 'alternate' && r % 2 === 1;
      const stops = reversed ? [...norm].reverse() : norm;
      for (const stop of stops) {
        const localT = (reversed ? (100 - stop.pct) : stop.pct) / 100 * anim.duration + anim.delay + r * anim.duration;
        const t = Math.round(localT * fps) / fps;
        if (t > dur + 1e-6 || t < 0) continue;
        const s = snap(stop);
        if (hasOpacity && s.opacity !== undefined && keys.Opacity.length < maxKeysPerProp) keys.Opacity!.push({ t, v: s.opacity, ...timing });
        if (hasColor && s.color && keys.FillColor.length < maxKeysPerProp) keys.FillColor!.push({ t, v: s.color, ...timing });
        // animated left/top shift the base box (when the element itself isn't positioned by left/top)
        let ax = refX + s.tx;
        let ay = refY + s.ty;
        if (s.left !== undefined && s.left !== null) {
          const baseLeft = px(L.style['left'], L.parent ? L.parent.box.w : Wc, L.fontSize);
          if (baseLeft === null) ax = s.left + (refX - L.box.x); // left animated but element statically placed: absolute value
          else ax = refX + (s.left - baseLeft);
        }
        if (s.top !== undefined && s.top !== null) {
          const baseTop = px(L.style['top'], L.parent ? L.parent.box.h : Hc, L.fontSize);
          if (baseTop === null) ay = s.top + (refY - L.box.y);
          else ay = refY + (s.top - baseTop);
        }
        if (hasTranslate && keys.Position.length < maxKeysPerProp) keys.Position!.push({ t, v: toAE(ax * sc, ay * sc), ...timing });
        if (hasScale && keys.Scale.length < maxKeysPerProp) keys.Scale!.push({ t, v: [s.sx * 100, s.sy * 100], ...timing });
        if (hasRotate && keys.Rotation.length < maxKeysPerProp) keys.Rotation!.push({ t, v: -s.rot, ...timing });
        if (hasSize && layer.kind === 'shape' && layer.shape === 'rect' && keys.RectSize.length < maxKeysPerProp) {
          keys.RectSize!.push({ t, v: [(s.w ?? L.box.w) * sc, (s.h ?? L.box.h) * sc], ...timing });
        }
      }
    }
    for (const k of Object.keys(keys) as (keyof typeof keys)[]) {
      (keys[k] as KeyframeSpec[] | undefined)?.sort((a, b) => a.t - b.t);
      // dedupe only identical same-time keys; keep value jumps at cycle boundaries (AE supports same-time keys)
      const arr = keys[k] as KeyframeSpec[] | undefined;
      if (arr && arr.length) {
        const dedup: KeyframeSpec[] = [];
        for (const kk of arr) {
          const last = dedup[dedup.length - 1];
          if (last && Math.abs(last.t - kk.t) < 1e-6 && JSON.stringify(last.v) === JSON.stringify(kk.v)) continue; // exact duplicate
          dedup.push(kk);
        }
        (keys as any)[k] = dedup;
      } else delete (keys as any)[k];
    }
    // animated color on solid -> needs Fill effect override
    if (keys.FillColor && layer.kind === 'solid') { layer.fillOverride = layer.color || [0, 0, 0]; }
    if (keys.FillColor && layer.kind === 'text') { layer.fillOverride = layer.color; }
    layer.keys = keys as LayerSpec['keys'];
    void warns;
  }
}

function collectStyleText(root: Node): { css: string } {
  let css = '';
  const walk = (el: Node) => {
    if (el.tag === 'style' && el.text) css += '\n' + el.text;
    for (const c of el.children) walk(c);
  };
  walk(root);
  return { css };
}
