/* Secbid demo film — see web/film.html for controls. */
'use strict';
/* ---------- utilities ---------- */
const W = 1920, H = 1080;
const $stage = document.getElementById('stage');
const $layer = document.getElementById('layer');
const cv = document.getElementById('cv');
const ctx = cv.getContext('2d');
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const prog = (t, a, b) => clamp((t - a) / (b - a));
const eo = (x) => 1 - Math.pow(1 - x, 3);
const eio = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const lerp = (a, b, x) => a + (b - a) * x;
const win = (t, a, b, fi = 0.5, fo = 0.5) => Math.min(prog(t, a, a + fi), 1 - prog(t, b - fo, b));
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let r = Math.imul(s ^ (s >>> 15), 1 | s);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}
function el(tag, cls, html, style) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  if (style) Object.assign(e.style, style);
  return e;
}
function put(parent, tag, cls, html, style) {
  const e = el(tag, cls, html, style);
  parent.appendChild(e);
  return e;
}
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/* word-by-word reveal: grey + blur -> ink, staggered (ref 3) */
function words(parent, text, style, cls = '') {
  const box = put(parent, 'div', 'abs ' + cls, null, style);
  const spans = text.split(/(\s+)/).map((w) => {
    if (/^\s+$/.test(w)) { box.appendChild(document.createTextNode(w)); return null; }
    return put(box, 'span', 'rw', esc(w));
  }).filter(Boolean);
  box.reveal = (x, from = '#b9b6ae', to = null) => {
    const n = spans.length;
    spans.forEach((s, i) => {
      const k = eo(clamp(x * (n + 2) - i));
      s.style.opacity = String(0.15 + 0.85 * k);
      s.style.filter = `blur(${(1 - k) * 7}px)`;
      s.style.transform = `translateY(${(1 - k) * 14}px)`;
      s.style.color = k >= 1 ? (to || '') : from;
    });
  };
  return box;
}
/* letter-scramble reveal (ref 3) */
const GLYPHS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz0123456789+/';
function scramble(text, x, seed) {
  const r = rng(seed);
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const at = (i / text.length) * 0.7;
    const roll = r();
    if (text[i] === ' ') out += ' ';
    else if (x >= at + 0.3) out += text[i];
    else if (x >= at) out += GLYPHS[Math.floor((roll * 997 + x * 61) % GLYPHS.length)];
    else out += ' ';
  }
  return out;
}
/* highlighter sweep */
const sweep = (e, x) => {
  e.style.backgroundSize = `${eio(clamp(x)) * 100}% 72%`;
  e.classList.toggle('on', x > 0.92); // on dark scenes the text flips to ink once the marker covers it
};

/* odometer (ref 3 slot-roll numbers) */
function odometer(parent, fmt, style) {
  const box = put(parent, 'div', 'abs odo', null, style);
  let cols = [];
  const build = (str) => {
    box.innerHTML = '';
    cols = [];
    for (const ch of str) {
      if (/\d/.test(ch)) {
        const c = put(box, 'span', 'col');
        const strip = put(c, 'div');
        for (let d = 0; d <= 10; d++) put(strip, 'span', null, String(d % 10));
        cols.push(strip);
      } else put(box, 'span', 'sep', ch);
    }
  };
  build(fmt(0));
  box.set = (v) => {
    const s = fmt(Math.floor(v));
    if (s.replace(/\d/g, '0') !== box.dataset.shape) { box.dataset.shape = s.replace(/\d/g, '0'); build(s); }
    const digits = cols.length;
    const frac = v - Math.floor(v);
    let carry = frac;
    for (let k = 0; k < digits; k++) {
      const strip = cols[digits - 1 - k];
      const d = Math.floor(v / Math.pow(10, k)) % 10;
      const off = k === 0 ? d + frac : d + carry;
      strip.style.transform = `translateY(${-off}em)`;
      carry = d === 9 ? carry : 0;
    }
  };
  return box;
}

/* terminal with typed command + timed output lines */
function terminal(parent, title, style) {
  const t = put(parent, 'div', 'term', null, style);
  put(t, 'div', 'bar', `<i></i><i></i><i></i><span>${esc(title)}</span>`);
  const pre = put(t, 'pre');
  t.lines = [];
  // line: {at, html, type?: 'cmd', speed?}
  t.render = (time) => {
    let html = '';
    let caretShown = false;
    for (const ln of t.lines) {
      if (time < ln.at) break;
      if (ln.cmd) {
        const n = Math.floor((time - ln.at) * (ln.speed || 38));
        const shown = ln.cmd.slice(0, n);
        const done = n >= ln.cmd.length;
        html += `<span class="dim">$ </span><span class="cmd">${esc(shown)}</span>`;
        if (!done) { html += '<span class="caret"></span>\n'; caretShown = true; break; }
        html += '\n';
      } else html += ln.html + '\n';
    }
    if (!caretShown && Math.floor(time * 2) % 2 === 0) html += '<span class="caret"></span>';
    if (pre.innerHTML !== html) pre.innerHTML = html;
  };
  return t;
}

/* ---------- generated imagery ---------- */
/* faceless head-and-shoulders silhouette into a small luminance grid */
function portrait(seed, gw, gh, opts = {}) {
  const r = rng(seed);
  const c = document.createElement('canvas');
  c.width = gw; c.height = gh;
  const g = c.getContext('2d');
  const bg = g.createLinearGradient(0, 0, gw, gh);
  bg.addColorStop(0, `hsl(0 0% ${70 + r() * 15}%)`);
  bg.addColorStop(1, `hsl(0 0% ${45 + r() * 15}%)`);
  g.fillStyle = opts.clear ? "#fff" : bg; g.fillRect(0, 0, gw, gh);
  const cx = gw * (0.46 + r() * 0.08);
  const headW = gw * (0.2 + r() * 0.05), headH = headW * (1.22 + r() * 0.12);
  const headY = gh * (0.36 + r() * 0.05);
  // shoulders / coat
  const coat = 12 + r() * 22;
  g.fillStyle = `hsl(0 0% ${coat}%)`;
  g.beginPath();
  g.moveTo(cx - gw * 0.62, gh);
  g.bezierCurveTo(cx - gw * 0.5, gh * 0.66, cx - headW * 1.5, gh * 0.64, cx, gh * 0.63);
  g.bezierCurveTo(cx + headW * 1.5, gh * 0.64, cx + gw * 0.5, gh * 0.66, cx + gw * 0.62, gh);
  g.fill();
  // collar
  g.fillStyle = `hsl(0 0% ${coat + 40}%)`;
  g.beginPath();
  g.moveTo(cx - headW * 0.55, gh * 0.64); g.lineTo(cx, gh * 0.8); g.lineTo(cx + headW * 0.55, gh * 0.64); g.closePath(); g.fill();
  // neck + head with side light
  const skin = g.createLinearGradient(cx - headW, 0, cx + headW, 0);
  skin.addColorStop(0, `hsl(0 0% ${58 + r() * 12}%)`);
  skin.addColorStop(1, `hsl(0 0% ${22 + r() * 10}%)`);
  g.fillStyle = skin;
  g.fillRect(cx - headW * 0.45, headY, headW * 0.9, gh * 0.3);
  g.beginPath(); g.ellipse(cx, headY, headW, headH, 0, 0, Math.PI * 2); g.fill();
  // hair or hat
  g.fillStyle = `hsl(0 0% ${6 + r() * 14}%)`;
  if (opts.hat || r() < 0.35) {
    g.fillRect(cx - headW * 1.05, headY - headH * 1.55, headW * 2.1, headH * 0.75);
    g.fillRect(cx - headW * 1.6, headY - headH * 0.85, headW * 3.2, headH * 0.16);
  } else {
    g.beginPath(); g.ellipse(cx, headY - headH * 0.3, headW * 1.02, headH * 0.78, 0, Math.PI, Math.PI * 2); g.fill();
  }
  if (opts.paddle) {
    const px = cx + gw * (r() < 0.5 ? -0.3 : 0.3);
    g.fillStyle = '#1a1a1a'; g.fillRect(px - 1, gh * 0.18, 2, gh * 0.5);
    g.fillStyle = '#f2f2f2'; g.fillRect(px - gw * 0.12, gh * 0.04, gw * 0.24, gh * 0.17);
    g.fillStyle = '#111'; g.font = `bold ${Math.round(gh * 0.12)}px Georgia`; g.textAlign = 'center';
    g.fillText(String(opts.paddle), px, gh * 0.175);
  }
  const d = g.getImageData(0, 0, gw, gh).data;
  const lum = new Float32Array(gw * gh);
  for (let i = 0; i < gw * gh; i++) lum[i] = d[i * 4] / 255;
  return { lum, gw, gh, seed };
}
/* halftone render with dissolve: dots drift away and fade as diss -> 1 (ref 2) */
function halftone(g, p, x, y, w, h, diss = 0, ink = '#111', seed = 1, occlude = null) {
  const cw = w / p.gw, ch = h / p.gh;
  if (occlude) {
    g.fillStyle = occlude;
    for (let j = 0; j < p.gh; j++) for (let i = 0; i < p.gw; i++) {
      if (p.lum[j * p.gw + i] < 0.97) g.fillRect(x + i * cw - 0.5, y + j * ch - 0.5, cw + 1, ch + 1);
    }
  }
  const r = rng(seed * 7 + 3);
  g.fillStyle = ink;
  for (let j = 0; j < p.gh; j++) {
    for (let i = 0; i < p.gw; i++) {
      const th = r(), dx = r() - 0.5, dy = r() - 0.5;
      const dark = 1 - p.lum[j * p.gw + i];
      let rad = Math.sqrt(dark) * Math.min(cw, ch) * 0.62;
      let ox = 0, oy = 0, a = 1;
      // the face region dissolves first: weight by distance to the head
      const fx = i / p.gw - 0.5, fy = j / p.gh - 0.36;
      const nearFace = Math.exp(-(fx * fx * 9 + fy * fy * 7));
      const k = clamp((diss * 1.6 - th * 0.8) * (0.5 + nearFace));
      if (k > 0) { ox = dx * k * w * 0.35; oy = dy * k * h * 0.35 - k * 6; a = 1 - k * 0.85; rad *= 1 - k * 0.5; }
      if (rad < 0.35 || a <= 0.02) continue;
      g.globalAlpha = a;
      g.beginPath();
      g.arc(x + (i + 0.5) * cw + ox, y + (j + 0.5) * ch + oy, rad, 0, 6.2832);
      g.fill();
    }
  }
  g.globalAlpha = 1;
}
/* crowd with paddles (Act 1 opening), pre-rendered once */
let crowdImg = null;
function crowd() {
  if (crowdImg) return crowdImg;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  g.fillStyle = '#e8e6df'; g.fillRect(0, 0, W, H);
  const rows = [{ y: 250, s: 320, n: 8 }, { y: 420, s: 400, n: 7 }, { y: 620, s: 500, n: 5 }];
  let seed = 11;
  for (const row of rows) {
    for (let i = 0; i < row.n; i++) {
      const p = portrait(seed++, 40, 50, { clear: true, paddle: (i * 7 + row.n * 3) % 2 ? 10 + ((seed * 13) % 89) : 0 });
      const x = (i + 0.5) * (W / row.n) - row.s / 2 + ((seed * 37) % 60) - 30;
      halftone(g, p, x, row.y, row.s * 0.82, row.s, 0, '#141414', seed, '#e8e6df');
    }
  }
  crowdImg = c;
  return c;
}
/* far crowd of dissolved faces (Act 2 zoom-out), pre-rendered once */
let fieldImg = null;
function faceField() {
  if (fieldImg) return fieldImg;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  g.fillStyle = '#ecebe6'; g.fillRect(0, 0, W, H);
  const cols = 14, rowsN = 7, tw = W / cols, th = H / rowsN;
  const variants = Array.from({ length: 12 }, (_, v) => facePortrait(v, 24, 32, v >= 6));
  let s = 500;
  for (let j = 0; j < rowsN; j++) for (let i = 0; i < cols; i++) {
    const p = variants[(i * 5 + j * 7) % variants.length];
    const fw = Math.min(tw - 16, (th - 12) * 0.75);
    halftone(g, p, i * tw + (tw - fw) / 2, j * th + 6, fw, th - 12, 0.3, '#1b1b1b', s++);
  }
  g.strokeStyle = 'rgba(20,20,20,0.18)'; g.lineWidth = 1;
  const r = rng(9);
  for (let k = 0; k < 90; k++) {
    g.beginPath(); g.moveTo(r() * W, r() * H);
    g.quadraticCurveTo(r() * W, r() * H, r() * W, r() * H); g.stroke();
  }
  fieldImg = c;
  return c;
}
/* tracking box with corner ticks and a small label (refs 2 + 4) */
function trackBox(g, x, y, w, h, label, alpha = 1, color = '#e5322d') {
  g.save();
  g.globalAlpha = alpha;
  g.strokeStyle = color; g.lineWidth = 2;
  g.strokeRect(x, y, w, h);
  const k = Math.min(16, w / 4);
  g.lineWidth = 4;
  g.beginPath();
  g.moveTo(x, y + k); g.lineTo(x, y); g.lineTo(x + k, y);
  g.moveTo(x + w - k, y + h); g.lineTo(x + w, y + h); g.lineTo(x + w, y + h - k);
  g.stroke();
  if (label) {
    g.font = '600 15px Consolas, monospace';
    const tw = g.measureText(label).width + 12;
    g.fillStyle = color; g.fillRect(x, y + h + 4, tw, 22);
    g.fillStyle = '#fff'; g.fillText(label, x + 6, y + h + 20);
  }
  g.restore();
}

/* ---------- data (real output; see docs/TESTNET.md) ---------- */
const TX_BID = '767f4167bb2405736b080ac4f715af44b04562617336e852e0af71ce41aed2d9';
const MEMO = 'U0IxAQHA2KcAAAAAAEN/oLoM6OKqsNDyWv3BIE4f2Ujul1wEMaoV+Tng5Kht';
const VERIFY_TESTNET = [
  ['C1', 'params_hash and settlement_hash match published commitments'],
  ['C2', 'merkle_root recomputes from entries'],
  ['C3', '6 inclusion proof(s) verified'],
  ['C4', 'every admitted bid is inside the bidding window'],
  ['C5', '6 entries match the 6 observed at the auction address'],
  ['C6', 'no transparent-funded note admitted as a bid'],
  ['C7', 'clearing recomputes to the published result'],
  ['C8', 'every refundable note refunded exactly once'],
  ['C9', 'accounting balances: in == refunded + retained + stranded + fees'],
  ['C10', 'revealed OVK matches the commitment'],
  ['C11', 'all winners pay one clearing price; only the marginal bid is partial'],
  ['C12', 'account and admitted notes agree on the ironwood pool'],
  ['C13', 'n/a: no bond posted'],
  ['C14', 'n/a: public-tender mode publishes the UFVK; the audit runs as C5–C10'],
];
const pad = (s, n) => (s + ' '.repeat(n)).slice(0, n);

/* ---------- generated stills (Higgsfield Soul Cinema; the film falls back to drawn art without them) ---------- */
const STILLS = {};
const STILL_NAMES = ['hall', 'plaza', 'plaza-empty', 'envelope', 'tender-box', 'auctioneer',
  'face-1', 'face-2', 'face-3', 'face-4', 'face-5', 'face-6', 'use-otc', 'use-tender', 'use-token', 'use-grant'];
const stillsReady = Promise.all(STILL_NAMES.map((k) => new Promise((done) => {
  const im = new Image();
  im.onload = im.onerror = done;
  im.src = `/assets/film/${k}.png`;
  STILLS[k] = im;
})));
const still = (k) => (STILLS[k] && STILLS[k].complete && STILLS[k].naturalWidth ? STILLS[k] : null);

/* a photo as a luminance grid for halftone(): cover-cropped, contrast-stretched, optionally mirrored */
function lumFrom(img, gw, gh, flip = false) {
  const c = document.createElement('canvas'); c.width = gw; c.height = gh;
  const g = c.getContext('2d');
  const k = Math.max(gw / img.naturalWidth, gh / img.naturalHeight);
  const w = img.naturalWidth * k, h = img.naturalHeight * k;
  if (flip) { g.translate(gw, 0); g.scale(-1, 1); }
  g.drawImage(img, (gw - w) / 2, (gh - h) / 2, w, h);
  const d = g.getImageData(0, 0, gw, gh).data;
  const lum = new Float32Array(gw * gh);
  let lo = 1, hi = 0;
  for (let i = 0; i < gw * gh; i++) {
    lum[i] = (d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114) / 255;
    lo = Math.min(lo, lum[i]); hi = Math.max(hi, lum[i]);
  }
  for (let i = 0; i < lum.length; i++) lum[i] = clamp((lum[i] - lo) / Math.max(0.05, hi - lo));
  return { lum, gw, gh };
}
/* bidder portrait i: a generated identity photo when present, the drawn silhouette otherwise */
function facePortrait(i, gw, gh, flip = false) {
  const im = still(`face-${(i % 6) + 1}`);
  return im ? lumFrom(im, gw, gh, flip) : portrait(200 + i * 3, gw, gh, { hat: i === 1 || i === 4 });
}

/* Walking plaza: find the dark figures in plaza.png, cut each into a sprite, so they can walk over
   plaza-empty.png (the same photo with the people removed). Built once, on first use. */
let plazaCast = null;
function plazaPeople() {
  if (plazaCast) return plazaCast;
  const img = still('plaza');
  if (!img) return null;
  const sw = 512, sh = Math.round(512 * img.naturalHeight / img.naturalWidth), f = img.naturalWidth / sw;
  const c = document.createElement('canvas'); c.width = sw; c.height = sh;
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0, sw, sh);
  const d = g.getImageData(0, 0, sw, sh).data;
  const N = sw * sh;
  const lumAt = (i) => (d[i * 4] + d[i * 4 + 1] + d[i * 4 + 2]) / 765;
  // the long dark line across the plaza is ground, not a person: drop thin, very wide dark runs
  const dark = new Uint8Array(N);
  for (let i = 0; i < N; i++) dark[i] = lumAt(i) < 0.42 ? 1 : 0;
  const vlen = new Uint16Array(N); // length of the vertical dark run through each pixel
  for (let x = 0; x < sw; x++) {
    let y = 0;
    while (y < sh) {
      if (!dark[y * sw + x]) { y++; continue; }
      let e = y;
      while (e < sh && dark[e * sw + x]) e++;
      for (let k = y; k < e; k++) vlen[k * sw + x] = e - y;
      y = e;
    }
  }
  const thin = (i) => dark[i] && vlen[i] <= 4;
  const cut = [];
  for (let y = 10; y < sh - 10; y++) { // skip the frame border rows
    let run = 0;
    for (let x = 0; x <= sw; x++) {
      if (x < sw && thin(y * sw + x)) run++;
      else { if (run > 40) for (let k = x - run; k < x; k++) cut.push(y * sw + k); run = 0; }
    }
  }
  for (const i of cut) dark[i] = 0;
  // fit the line (mask coords) so pixels along it are never cut out with a figure, and can be redrawn
  let ln = 0, lsx = 0, lsy = 0, lsxx = 0, lsxy = 0, tone = 0;
  for (const i of cut) { const x = i % sw, y = (i / sw) | 0; ln++; lsx += x; lsy += y; lsxx += x * x; lsxy += x * y; tone += lumAt(i); }
  const slope = ln > 1 ? (ln * lsxy - lsx * lsy) / (ln * lsxx - lsx * lsx || 1) : 0;
  const icpt = ln ? (lsy - slope * lsx) / ln : -99;
  tone = ln ? tone / ln : 0.3;
  const lineM = new Uint8Array(N);
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
    const i = y * sw + x;
    if (vlen[i] > 0 && vlen[i] <= 4 && Math.abs(y - (slope * x + icpt)) < 1.8) { lineM[i] = 1; dark[i] = 0; }
  }
  // connected components
  const label = new Int32Array(N).fill(-1);
  let comps = [];
  for (let i = 0; i < N; i++) {
    if (!dark[i] || label[i] >= 0) continue;
    const id = comps.length, stack = [i];
    label[i] = id;
    const cp = { id, x0: sw, y0: sh, x1: 0, y1: 0, n: 0 };
    while (stack.length) {
      const p = stack.pop(), x = p % sw, y = (p / sw) | 0;
      cp.n++; cp.x0 = Math.min(cp.x0, x); cp.x1 = Math.max(cp.x1, x); cp.y0 = Math.min(cp.y0, y); cp.y1 = Math.max(cp.y1, y);
      for (const [qx, qy] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
        if (qx < 0 || qy < 0 || qx >= sw || qy >= sh) continue;
        const q = qy * sw + qx;
        if (dark[q] && label[q] < 0) { label[q] = id; stack.push(q); }
      }
    }
    comps.push(cp);
  }
  // re-join a figure the line removal cut in two (vertically stacked, overlapping in x)
  const root = comps.map((cp) => cp.id);
  const find = (a) => (root[a] === a ? a : (root[a] = find(root[a])));
  for (const a of comps) for (const b of comps) {
    if (a.id >= b.id || a.n < 6 || b.n < 6) continue;
    const ox = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
    const gap = Math.max(a.y0, b.y0) - Math.min(a.y1, b.y1);
    if (ox > 2 && gap < 6) root[find(b.id)] = find(a.id);
  }
  const groups = new Map();
  for (const cp of comps) {
    const r = find(cp.id);
    const gp = groups.get(r) || { id: r, x0: sw, y0: sh, x1: 0, y1: 0, n: 0, ids: new Set() };
    gp.x0 = Math.min(gp.x0, cp.x0); gp.x1 = Math.max(gp.x1, cp.x1); gp.y0 = Math.min(gp.y0, cp.y0); gp.y1 = Math.max(gp.y1, cp.y1);
    gp.n += cp.n; gp.ids.add(cp.id);
    groups.set(r, gp);
  }
  const people = [...groups.values()].filter((gp) => gp.n >= 30 && gp.x1 - gp.x0 < 110 && gp.y1 - gp.y0 > 10 && gp.y1 - gp.y0 < 150);
  // owner map, grown by 2 px so each sprite carries its soft edge and its shadow
  const owner = new Int32Array(N).fill(-1);
  people.forEach((gp, k) => { for (let i = 0; i < N; i++) if (label[i] >= 0 && gp.ids.has(label[i])) owner[i] = k; });
  for (let pass = 0; pass < 2; pass++) {
    const next = owner.slice();
    for (let y = 1; y < sh - 1; y++) for (let x = 1; x < sw - 1; x++) {
      const i = y * sw + x;
      if (owner[i] >= 0) continue;
      const n = [owner[i - 1], owner[i + 1], owner[i - sw], owner[i + sw]].find((v) => v >= 0);
      if (n !== undefined) next[i] = n;
    }
    owner.set(next);
  }
  // empty plate: the generated one if present, else erase each figure: fill a grown mask with a
  // smooth estimate of the floor (blur over floor pixels only) plus grain, and redraw the line through it
  let plate = still('plaza-empty');
  if (!plate) {
    let m = new Uint8Array(N);
    for (let i = 0; i < N; i++) m[i] = owner[i] >= 0 ? 1 : 0;
    for (let pass = 0; pass < 4; pass++) {
      const nx = m.slice();
      for (let y = 1; y < sh - 1; y++) for (let x = 1; x < sw - 1; x++) {
        const i = y * sw + x;
        if (!m[i] && (m[i - 1] || m[i + 1] || m[i - sw] || m[i + sw])) nx[i] = 1;
      }
      m = nx;
    }
    const S1 = sw + 1, S = new Float64Array(S1 * (sh + 1)), C = new Float64Array(S1 * (sh + 1));
    for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
      const i = y * sw + x, ok = !m[i] && !lineM[i] && !dark[i] ? 1 : 0;
      const at = (y + 1) * S1 + x + 1;
      S[at] = ok * lumAt(i) + S[at - S1] + S[at - 1] - S[at - S1 - 1];
      C[at] = ok + C[at - S1] + C[at - 1] - C[at - S1 - 1];
    }
    const R = 14;
    const est = (x, y) => {
      const x0 = Math.max(0, x - R), x1 = Math.min(sw, x + R + 1), y0 = Math.max(0, y - R), y1 = Math.min(sh, y + R + 1);
      const c = C[y1 * S1 + x1] - C[y0 * S1 + x1] - C[y1 * S1 + x0] + C[y0 * S1 + x0];
      const s = S[y1 * S1 + x1] - S[y0 * S1 + x1] - S[y1 * S1 + x0] + S[y0 * S1 + x0];
      return c > 0 ? s / c : 0.72;
    };
    plate = document.createElement('canvas'); plate.width = img.naturalWidth; plate.height = img.naturalHeight;
    const pg = plate.getContext('2d');
    pg.drawImage(img, 0, 0);
    const pd = pg.getImageData(0, 0, plate.width, plate.height);
    const nr = rng(77);
    for (let Y = 0; Y < plate.height; Y++) {
      const my = Math.min(sh - 1, Math.floor(Y / f));
      for (let X = 0; X < plate.width; X++) {
        const mx = Math.min(sw - 1, Math.floor(X / f));
        if (!m[my * sw + mx]) continue;
        const onLine = Math.abs((Y + 0.5) / f - 0.5 - (slope * ((X + 0.5) / f - 0.5) + icpt)) < 0.9;
        const v = Math.max(0, Math.min(255, (onLine ? tone : est(mx, my)) * 255 + (nr() - 0.5) * 22));
        const p = (Y * plate.width + X) * 4;
        pd.data[p] = pd.data[p + 1] = pd.data[p + 2] = v;
      }
    }
    pg.putImageData(pd, 0, 0);
  }
  const r = rng(31);
  const cast = people.map((gp, k) => {
    const pad = 3;
    const X0 = Math.max(0, (gp.x0 - pad)) * f, Y0 = Math.max(0, (gp.y0 - pad)) * f;
    const X1 = Math.min(sw, gp.x1 + pad + 1) * f, Y1 = Math.min(sh, gp.y1 + pad + 1) * f;
    const w = Math.round(X1 - X0), h = Math.round(Y1 - Y0);
    const sc = document.createElement('canvas'); sc.width = w; sc.height = h;
    const sg = sc.getContext('2d');
    sg.drawImage(img, X0, Y0, w, h, 0, 0, w, h);
    const sd = sg.getImageData(0, 0, w, h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const mi = Math.min(sh - 1, Math.floor((Y0 + y) / f)) * sw + Math.min(sw - 1, Math.floor((X0 + x) / f));
      const p = (y * w + x) * 4;
      const l = (sd.data[p] + sd.data[p + 1] + sd.data[p + 2]) / 765;
      sd.data[p + 3] = owner[mi] === k && !lineM[mi] ? Math.round(255 * clamp((0.6 - l) / 0.2)) : 0;
    }
    sg.putImageData(sd, 0, 0);
    const down = r() < 0.7 ? 1 : -1;
    return { sprite: sc, x: X0, y: Y0, w, h, vx: (r() - 0.5) * 14, vy: down * (34 + r() * 26), ph: r() * 6.28, area: gp.n };
  });
  plazaCast = { plate, cast, fit: { slope, icpt, tone, ln } };
  return plazaCast;
}
/* cover the stage with a still, pushed in by z around its centre; returns the image→stage mapping */
function kenBurns(g, img, z) {
  const iw = img.naturalWidth || img.videoWidth || img.width, ih = img.naturalHeight || img.videoHeight || img.height;
  const k = Math.max(W / iw, H / ih) * z;
  const ox = (W - iw * k) / 2, oy = (H - ih * k) / 2;
  g.drawImage(img, ox, oy, iw * k, ih * k);
  return { k, ox, oy };
}
/* generated video clips (web/assets/film/<name>.mp4), kept in step with the film clock; absent clips are skipped */
const CLIPS = {};
function clip(name) {
  if (!(name in CLIPS)) {
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.preload = 'auto'; v.loop = false;
    v.ok = false;
    v.addEventListener('loadeddata', () => { v.ok = true; });
    v.src = `/assets/film/${name}.mp4`;
    CLIPS[name] = v;
  }
  return CLIPS[name].ok ? CLIPS[name] : null;
}
function syncClip(v, t, rate = 1) {
  const want = Math.max(0, Math.min(t * rate, v.duration - 0.05));
  const r = Math.min(4, rate * curSpeed); // a sped-up segment of the 2-minute cut plays its clip faster too
  if (v.playbackRate !== r) v.playbackRate = r;
  if (playing && t * rate < v.duration - 0.05) {
    if (v.paused) v.play().catch(() => {});
    if (Math.abs(v.currentTime - want) > 0.3) v.currentTime = want;
  } else {
    if (!v.paused) v.pause();
    if (Math.abs(v.currentTime - want) > 0.04) v.currentTime = want;
  }
}
/* the moving version of a still when its clip exists, else the still; synced to local time t */
function media(clipName, stillName, t, rate = 1) {
  const v = clip(clipName);
  if (v) { syncClip(v, t, rate); return v; }
  return still(stillName);
}
const dims = (m) => [m.naturalWidth || m.videoWidth || m.width, m.naturalHeight || m.videoHeight || m.height];
/* dark figures on a pale floor, found in the current video frame: real per-frame tracking boxes */
const trackCv = document.createElement('canvas'); trackCv.width = 320; trackCv.height = 180;
function figuresIn(v) {
  const g = trackCv.getContext('2d', { willReadFrequently: true });
  g.drawImage(v, 0, 0, 320, 180);
  const d = g.getImageData(0, 0, 320, 180).data, N = 320 * 180;
  const dark = new Uint8Array(N);
  for (let i = 0; i < N; i++) dark[i] = (d[i * 4] + d[i * 4 + 1] + d[i * 4 + 2]) / 765 < 0.38 ? 1 : 0;
  const seen = new Uint8Array(N), out = [];
  for (let i = 0; i < N; i++) {
    if (!dark[i] || seen[i]) continue;
    const st = [i]; seen[i] = 1;
    let x0 = 320, y0 = 180, x1 = 0, y1 = 0, n = 0;
    while (st.length) {
      const p = st.pop(), x = p % 320, y = (p / 320) | 0;
      n++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (x > 0 && dark[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; st.push(p - 1); }
      if (x < 319 && dark[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; st.push(p + 1); }
      if (y > 0 && dark[p - 320] && !seen[p - 320]) { seen[p - 320] = 1; st.push(p - 320); }
      if (y < 179 && dark[p + 320] && !seen[p + 320]) { seen[p + 320] = 1; st.push(p + 320); }
    }
    const w = x1 - x0 + 1, h = y1 - y0 + 1;
    if (n >= 12 && w < 60 && h > 5 && h < 80 && w < h * 3) out.push({ x: x0 / 320, y: y0 / 180, w: w / 320, h: h / 180, n });
  }
  return out.sort((a, b) => b.n - a.n).slice(0, 9);
}
/* people in plaza.png (image pixels), for the tracking boxes */
const PLAZA_PEOPLE = [[927, 220], [317, 707], [701, 870], [1188, 625], [1556, 819], [1377, 205], [1075, 860], [1966, 676]];
const STEPS = ['open', 'bid', 'settle', 'verify'];
const USE_PHOTOS = ['use-otc', 'use-tender', 'use-token', 'use-grant'];

/* ---------- scenes ---------- */
/* Narration matches docs/DEMO-SCRIPT.md; captions split it by sentence, timed by word count. */
const SCENES = [
  {
    name: 'title', start: 0, dur: 6, dark: true,
    say: 'This is Secbid: sealed-bid auctions on Zcash, where the bid is a shielded payment.',
    build(L) {
      const s = {};
      s.k = put(L, 'div', 'abs kicker', 'zecathon 2026 · private markets', { left: '120px', top: '330px', color: '#cfcfcf' });
      s.t = words(L, 'Secbid', { left: '110px', top: '370px', fontFamily: 'var(--serif)', fontSize: '200px', letterSpacing: '-0.03em', color: '#fff', lineHeight: '1' });
      s.sub = words(L, 'Sealed-bid auctions where the bid is a shielded Zcash payment.', { left: '120px', top: '610px', width: '1100px', fontFamily: 'var(--serif)', fontSize: '50px', fontStyle: 'italic', color: '#f2f2f2', lineHeight: '1.2' });
      s.foot = put(L, 'div', 'abs mono', 'run on zcash testnet · verify PASS 14/14', { left: '120px', top: '780px', fontSize: '22px', letterSpacing: '0.08em', color: 'var(--pass)' });
      return s;
    },
    update(s, t) {
      const g = ctx;
      g.fillStyle = '#050505'; g.fillRect(0, 0, W, H);
      const img = media('hall', 'hall', t);
      if (img) {
        g.save(); g.globalAlpha = prog(t, 0, 0.8);
        kenBurns(g, img, 1.04 + t * 0.012);
        g.restore();
      }
      const shade = g.createLinearGradient(0, 0, W, 0);
      shade.addColorStop(0, 'rgba(5,5,5,0.88)'); shade.addColorStop(0.62, 'rgba(5,5,5,0.55)'); shade.addColorStop(1, 'rgba(5,5,5,0.15)');
      g.fillStyle = shade; g.fillRect(0, 0, W, H);
      s.k.style.opacity = prog(t, 0.3, 0.9);
      s.t.reveal(prog(t, 0.5, 1.4), '#777', '#fff');
      s.sub.reveal(prog(t, 1.4, 3.2), '#777', '#f2f2f2');
      s.foot.style.opacity = prog(t, 3.4, 4);
    },
  },
  {
    name: 'sealed bids', start: 6, dur: 20, dark: false,
    say: 'Every sealed-bid market runs on one promise: your competitors must not see your number. For a century, a middleman kept that promise. On a transparent blockchain, nobody can — every bid is visible the moment it’s placed.',
    build(L) {
      const s = {};
      s.lined = put(L, 'div', 'lined');
      s.k1 = put(L, 'div', 'abs kicker', 'a sealed-bid market', { left: '90px', top: '80px', color: '#3a3a3a' });
      s.env = put(L, 'div', 'abs', `
        <svg width="760" height="470" viewBox="0 0 760 470">
          <defs><filter id="sh" x="-20%" y="-20%" width="140%" height="160%"><feDropShadow dx="0" dy="26" stdDeviation="22" flood-opacity="0.28"/></filter></defs>
          <g filter="url(#sh)">
            <rect x="20" y="20" width="720" height="430" fill="#f3efe4" stroke="#1d1d1d" stroke-width="2"/>
            <path d="M20 20 L380 270 L740 20" fill="none" stroke="#1d1d1d" stroke-width="2"/>
            <path d="M20 450 L300 215 M740 450 L460 215" fill="none" stroke="#1d1d1d" stroke-width="1.2" opacity="0.5"/>
          </g>
          <circle cx="380" cy="262" r="48" fill="#a51d1a"/>
          <circle cx="380" cy="262" r="36" fill="none" stroke="#7a1210" stroke-width="3"/>
          <text x="380" y="278" text-anchor="middle" font-family="Palatino Linotype, Georgia" font-size="44" fill="#f0d9c8" font-style="italic">S</text>
          <text x="80" y="410" font-family="Palatino Linotype, Georgia" font-size="26" fill="#333" font-style="italic">bid — strictly confidential</text>
        </svg>`, { left: '580px', top: '300px' });
      s.k2 = put(L, 'div', 'abs serif', 'your number, sealed.', { left: '0', right: '0', top: '820px', textAlign: 'center', fontSize: '34px', fontStyle: 'italic', color: '#444' });
      s.w1 = put(L, 'div', 'word', 'sealed.');
      s.w2 = put(L, 'div', 'word', 'trusted.');
      s.w3 = put(L, 'div', 'word', 'visible.');
      s.ul = put(L, 'div', 'abs', null, { left: '860px', top: '585px', height: '5px', background: 'var(--red)' });
      s.k3 = put(L, 'div', 'abs mono', 'transparent chain · every bid in plain sight', { left: '90px', top: '80px', fontSize: '20px', color: '#5dff8a', letterSpacing: '0.08em' });
      const r = rng(4);
      s.rainCols = Array.from({ length: 64 }, (_, i) => ({ x: i * 30 + 12, sp: 180 + r() * 420, off: r() * 1000 }));
      s.ledger = Array.from({ length: 7 }, (_, i) => ({
        y: 200 + i * 105, txt: `t1${Math.floor(r() * 1e9).toString(36)}…${Math.floor(r() * 1e4).toString(36)}  →  auction   bid ${(r() * 900 + 100).toFixed(2)} ZEC`,
      }));
      return s;
    },
    update(s, t) {
      const g = ctx;
      g.clearRect(0, 0, W, H);
      // 0–5: halftone crowd, slow push-in
      const a1 = win(t, 0, 5.2, 0.6, 0.6);
      const room = t < 5.4 ? media('gavel', 'auctioneer', t, CLIPS.gavel && CLIPS.gavel.ok ? Math.min(1, CLIPS.gavel.duration / 5.2) : 1) : still('auctioneer');
      if (a1 > 0) {
        g.save(); g.globalAlpha = a1;
        if (room) {
          kenBurns(g, room, 1.02 + t * 0.018);
        } else {
          const z = 1 + t * 0.012;
          g.translate(W / 2, H / 2); g.scale(z, z); g.translate(-W / 2, -H / 2);
          g.drawImage(crowd(), 0, 0);
        }
        g.restore();
      }
      s.k1.style.opacity = a1;
      if (room) {
        s.k1.textContent = 'a sealed-bid auction';
        Object.assign(s.k1.style, { color: '#f2f2f2', background: 'rgba(5,5,5,0.62)', padding: '8px 14px', fontSize: '22px' });
      }
      // 5–9.5: envelope slides in (the generated photo when present, the drawn one otherwise)
      const e = prog(t, 5, 6.8);
      const ea = win(t, 5, 9.6, 0.3, 0.5);
      const envImg = still('envelope');
      if (envImg && ea > 0) {
        // the sealed envelope, then the same hand dropping it into the tender box
        const drop = t >= 7.0 ? media('tender', 'tender-box', t - 7.1) : still('tender-box');
        const xf = drop ? prog(t, 7.1, 7.7) : 0;
        g.save(); g.globalAlpha = ea * (1 - xf);
        kenBurns(g, envImg, 1.03 + prog(t, 5, 9.6) * 0.06);
        g.restore();
        if (xf > 0) {
          g.save(); g.globalAlpha = ea * xf;
          kenBurns(g, drop, 1.02 + prog(t, 7.1, 9.6) * 0.08);
          g.restore();
        }
        s.env.style.opacity = 0;
        s.k2.style.color = '#f2f2f2';
        s.k2.style.textShadow = '0 2px 10px rgba(0,0,0,0.8)';
        s.k2.style.top = '120px';
      } else {
        s.env.style.opacity = ea;
        s.env.style.transform = `translateX(${(1 - eo(e)) * -900}px) rotate(${(1 - eo(e)) * -9 + 1.5}deg)`;
      }
      s.k2.style.opacity = win(t, 6.8, 9.6, 0.6, 0.5);
      s.lined.style.opacity = t > (envImg ? 9.6 : 5) && !(t > 14.4 && t < 17.6) ? 1 : 0;
      // words on blank page
      const wordIn = (e2, a, b) => {
        const v = win(t, a, b, 0.5, 0.35);
        e2.style.opacity = v;
        e2.style.filter = `blur(${(1 - v) * 6}px)`;
        e2.style.letterSpacing = `${(1 - v) * 0.12 - 0.01}em`;
      };
      wordIn(s.w1, 9.6, 12.1); wordIn(s.w2, 12.1, 14.5); wordIn(s.w3, 17.6, 20);
      s.ul.style.width = `${eo(prog(t, 18.2, 18.9)) * 200}px`;
      s.ul.style.opacity = win(t, 18.2, 20, 0.1, 0.35);
      // 14.5–17.6: green digit rain + plain-sight ledger
      const dark = t >= 14.5 && t < 17.6;
      $stage.classList.toggle('dark', dark);
      s.k3.style.opacity = dark ? win(t, 14.6, 17.6, 0.3, 0.2) : 0;
      if (dark) {
        const tt = t - 14.5;
        g.fillStyle = '#030503'; g.fillRect(0, 0, W, H);
        g.font = '24px Consolas, monospace';
        for (const c of s.rainCols) {
          for (let k = 0; k < 38; k++) {
            const y = ((tt * c.sp + c.off + k * 30) % (H + 60)) - 30;
            const ch = '0123456789abcdef'[(k * 7 + Math.floor(tt * 9 + c.off)) % 16];
            g.fillStyle = `rgba(80,255,130,${0.08 + (k / 38) * 0.32})`;
            g.fillText(ch, c.x, y);
          }
        }
        g.font = '600 34px Consolas, monospace';
        s.ledger.forEach((l, i) => {
          const v = prog(tt, 0.25 + i * 0.25, 0.55 + i * 0.25);
          g.fillStyle = `rgba(150,255,180,${v})`;
          g.fillText(l.txt, 160, l.y);
        });
      }
    },
  },
  {
    name: 'who uses it', start: 26, dur: 20, dark: false,
    say: 'OTC desks selling a block of ZEC without moving the market. Procurement offices, where suppliers must not see each other’s price. Token sales, with one clearing price for every winner. Grant committees choosing the best offer, privately. Secbid gives them a sealed-bid auction where the bid is a shielded Zcash payment. No special app, no smart contract, no reveal step.',
    // one line per card, so the caption always names the card on screen
    capsAt: [[0.15, 3.6], [3.6, 7.05], [7.05, 10.5], [10.5, 14], [14, 17.2], [17.2, 20]],
    build(L) {
      const s = { cards: [] };
      put(L, 'div', 'lined');
      const items = [
        ['OTC block sale', 'sell a block of ZEC without moving the market',
          '<path d="M60 250 L60 60 M60 250 L420 250" stroke="#111" stroke-width="3" fill="none"/><path d="M100 200 L100 150 M140 180 L140 120 M180 210 L180 140 M220 150 L220 90 M260 170 L260 110 M300 120 L300 70 M340 140 L340 80 M380 100 L380 60" stroke="#111" stroke-width="16"/><path d="M80 210 C160 140 230 190 300 110 S380 70 410 70" stroke="#e5322d" stroke-width="4" fill="none"/>'],
        ['Procurement tender', 'suppliers bid; nobody sees the others',
          '<rect x="120" y="30" width="230" height="260" fill="#f6f4ee" stroke="#111" stroke-width="3"/><path d="M155 85 H315 M155 125 H315 M155 165 H275 M155 205 H300" stroke="#111" stroke-width="3"/><circle cx="300" cy="245" r="38" fill="none" stroke="#e5322d" stroke-width="5"/><text x="300" y="253" text-anchor="middle" font-family="Consolas" font-size="20" font-weight="700" fill="#e5322d">SEALED</text>'],
        ['Token sale', 'one clearing price for every winner',
          '<ellipse cx="240" cy="230" rx="130" ry="34" fill="#f6f4ee" stroke="#111" stroke-width="3"/><path d="M110 230 V200 M370 230 V200" stroke="#111" stroke-width="3"/><ellipse cx="240" cy="200" rx="130" ry="34" fill="#f6f4ee" stroke="#111" stroke-width="3"/><path d="M110 200 V170 M370 200 V170" stroke="#111" stroke-width="3"/><ellipse cx="240" cy="170" rx="130" ry="34" fill="#f6f4ee" stroke="#111" stroke-width="3"/><path d="M110 170 V140 M370 170 V140" stroke="#111" stroke-width="3"/><ellipse cx="240" cy="140" rx="130" ry="34" fill="#f6f4ee" stroke="#111" stroke-width="3"/><text x="240" y="152" text-anchor="middle" font-family="Palatino Linotype" font-size="34" font-style="italic">Z</text>'],
        ['Grant allocation', 'committees fund the best offer, privately',
          '<rect x="90" y="150" width="300" height="24" fill="#111"/><path d="M120 174 V280 M360 174 V280" stroke="#111" stroke-width="6"/><circle cx="150" cy="95" r="34" fill="#111"/><circle cx="240" cy="80" r="34" fill="#111"/><circle cx="330" cy="95" r="34" fill="#111"/><rect x="200" y="110" width="80" height="50" fill="#f6f4ee" stroke="#e5322d" stroke-width="4"/>'],
      ];
      items.forEach(([title, sub, art], i) => {
        const c = put(L, 'div', 'abs', null, { left: '0', right: '0', top: '0', bottom: '0' });
        put(c, 'div', 'abs kicker', `0${i + 1} / 04 · who uses it`, { left: '90px', top: '80px' });
        if (!still(USE_PHOTOS[i])) put(c, 'div', 'abs', `<svg width="480" height="300" viewBox="0 0 480 300">${art}</svg>`, { left: '260px', top: '360px' });
        put(c, 'div', 'abs serif', title, { left: '860px', top: '420px', fontSize: '92px', letterSpacing: '-0.02em', lineHeight: '1' });
        put(c, 'div', 'abs', sub, { left: '864px', top: '545px', fontSize: '32px', color: '#4a4a4a' });
        s.cards.push(c);
      });
      s.title = words(L, 'The bid is a shielded payment.', { left: '0', right: '0', top: '420px', textAlign: 'center', fontFamily: 'var(--serif)', fontSize: '104px', letterSpacing: '-0.02em' });
      s.title.querySelectorAll('.rw').forEach((w, i) => { if (i >= 4) w.classList.add('hl'); });
      s.sub = put(L, 'div', 'abs', 'no special app &nbsp;·&nbsp; no smart contract &nbsp;·&nbsp; no reveal step', { left: '0', right: '0', top: '600px', textAlign: 'center', fontSize: '30px', letterSpacing: '0.04em', color: '#3d3d3d' });
      return s;
    },
    update(s, t) {
      ctx.clearRect(0, 0, W, H);
      s.cards.forEach((c, i) => {
        const a = 0.15 + i * 3.45, b = a + 3.45;
        const inn = eo(prog(t, a, a + 0.7)), out = eio(prog(t, b - 0.45, b));
        const op = t >= a && t < b + 0.01 ? Math.min(inn, 1 - out) : 0;
        c.style.opacity = String(op);
        c.style.transform = `translateY(${(1 - inn) * 120 - out * 120}px)`;
        const photo = op > 0 ? media(USE_PHOTOS[i], USE_PHOTOS[i], t - a) : still(USE_PHOTOS[i]);
        if (photo && op > 0) {
          // archival photo in a frame on the left, slow push-in, moving with the card
          const fx = 110, fy = 250 + (1 - inn) * 120 - out * 120, fw = 700, fh = 394;
          const z = 1.04 + prog(t, a, b) * 0.08;
          const [pw, ph] = dims(photo), sw = pw / z, sh = ph / z;
          ctx.save(); ctx.globalAlpha = op;
          ctx.drawImage(photo, (pw - sw) / 2, (ph - sh) / 2, sw, sh, fx, fy, fw, fh);
          ctx.strokeStyle = '#111'; ctx.lineWidth = 2; ctx.strokeRect(fx, fy, fw, fh);
          ctx.restore();
        }
        c.querySelectorAll('svg path, svg rect, svg ellipse, svg circle').forEach((p) => {
          p.style.strokeDasharray = '1200'; p.style.strokeDashoffset = String(1200 * (1 - eo(prog(t, a + 0.2, a + 1.6))));
        });
      });
      const tv = prog(t, 14.2, 16.2);
      s.title.style.opacity = t > 14 ? 1 : 0;
      s.title.reveal(tv, '#bdbab2', '#111');
      s.title.querySelectorAll('.hl').forEach((h) => sweep(h, prog(t, 16.2, 17.1)));
      s.sub.style.opacity = win(t, 17.2, 20.5, 0.6, 0.1);
    },
  },
  {
    name: 'how it works', start: 46, dur: 8, dark: false,
    say: 'It works in four steps: open, bid, settle — and anyone can verify.',
    build(L) {
      const s = { cols: [] };
      put(L, 'div', 'lined');
      put(L, 'div', 'abs kicker', 'how it works', { left: '120px', top: '150px' });
      const steps = [
        ['Open', 'The auctioneer publishes the rules and a QR code, and commits to them before any bid.'],
        ['Bid', 'One shielded payment. The memo carries a one-time refund address.'],
        ['Settle', 'A deterministic rule picks the winners. Refunds go out in one shielded transaction.'],
        ['Verify', 'Anyone recomputes the result from chain data: 14 public checks.'],
      ];
      s.rule = put(L, 'div', 'abs', null, { left: '160px', top: '350px', height: '3px', background: '#111' });
      steps.forEach(([title, body], i) => {
        const x = 120 + i * 430;
        const c = put(L, 'div', 'abs', null, { left: `${x}px`, top: '300px', width: '380px' });
        put(c, 'div', 'mono', `0${i + 1}`, {
          width: '100px', height: '100px', borderRadius: '50%', background: i === 3 ? 'var(--red)' : '#111', color: '#fff',
          display: 'grid', placeItems: 'center', fontSize: '36px',
        });
        put(c, 'div', 'serif', title, { marginTop: '34px', fontSize: '72px', letterSpacing: '-0.02em', lineHeight: '1' });
        put(c, 'div', null, body, { marginTop: '18px', fontSize: '27px', lineHeight: '1.42', color: '#3b3b3b' });
        s.cols.push(c);
      });
      return s;
    },
    update(s, t) {
      ctx.clearRect(0, 0, W, H);
      s.rule.style.width = `${eio(prog(t, 0.3, 5.2)) * 1290}px`;
      s.cols.forEach((c, i) => {
        const v = eo(prog(t, 0.4 + i * 1.3, 1.1 + i * 1.3));
        c.style.opacity = String(v);
        c.style.transform = `translateY(${(1 - v) * 40}px)`;
      });
    },
  },
  {
    name: 'observer sees nothing', start: 54, dur: 18, dark: false, step: 1,
    say: 'Here’s a real bid on Zcash testnet. The chain records that a shielded transaction happened. No sender. No amount. No memo. A watcher learns nothing.',
    build(L) {
      const s = {};
      const r = rng(77);
      s.walkers = Array.from({ length: 30 }, () => ({
        x: r() * W, y: r() * H, vx: (r() - 0.5) * 70, vy: 30 + r() * 60, rot: r() * 6.28,
        coat: 38 + r() * 30, size: 0.8 + r() * 0.5, ph: r() * 6.28,
      }));
      s.tracked = [2, 7, 11, 18, 23];
      s.labels = ['sender: —', 'amount: shielded', 'memo: encrypted'];
      s.k = put(L, 'div', 'abs kicker', 'what a chain observer sees', { left: '90px', top: '80px', color: '#222', background: 'rgba(236,235,230,0.85)', padding: '6px 10px' });
      s.card = put(L, 'div', 'abs', null, { left: '0', right: '0', top: '0', bottom: '0' });
      put(s.card, 'div', 'abs kicker', 'zcash testnet · bid transaction · auction c91d6118…', { left: '200px', top: '300px' });
      s.tx = put(s.card, 'div', 'abs mono', '', { left: '200px', top: '360px', fontSize: '50px', lineHeight: '1.3', whiteSpace: 'pre', color: '#111' });
      s.box = put(s.card, 'div', 'abs', null, { left: '178px', top: '342px', width: '960px', height: '160px', border: '3px solid var(--red)' });
      s.lab = s.labels.map((txt, i) => put(s.card, 'div', 'abs mono', txt, {
        left: '1180px', top: `${360 + i * 52}px`, fontSize: '30px', color: '#fff', background: 'var(--red)', padding: '4px 12px',
      }));
      s.foot = put(s.card, 'div', 'abs serif', 'A shielded transaction happened. That is all.', { left: '200px', top: '600px', fontSize: '52px', fontStyle: 'italic' });
      return s;
    },
    update(s, t) {
      const g = ctx;
      const plaza = win(t, 0, 9.4, 0.4, 0.6);
      g.fillStyle = '#ecebe6'; g.fillRect(0, 0, W, H);
      const plazaImg = still('plaza');
      const vid = clip('plaza');
      const walk = plaza > 0 && !vid ? plazaPeople() : null;
      if (vid && plaza > 0) {
        // generated video of the plaza; boxes are found on the people in each frame
        syncClip(vid, t, Math.min(1, vid.duration / 9.4));
        g.save(); g.globalAlpha = plaza;
        const m = kenBurns(g, vid, 1.02);
        g.fillStyle = 'rgba(0,0,0,0.07)';
        for (let yy = 0; yy < H; yy += 4) g.fillRect(0, yy, W, 1);
        const vw = vid.videoWidth * m.k, vh = vid.videoHeight * m.k;
        figuresIn(vid).forEach((b, k) => {
          if (t < 0.5 + k * 0.3) return;
          const x = m.ox + b.x * vw, y = m.oy + b.y * vh, w = b.w * vw, h = b.h * vh;
          trackBox(g, x - 8, y - 8, w + 16, h + 16, s.labels[Math.floor((x / W) * 3) % 3], plaza);
        });
        g.restore();
      } else if (walk) {
        // walking plaza: the empty plate plus cut-out people; each box follows its person
        g.save(); g.globalAlpha = plaza;
        const m = kenBurns(g, walk.plate, 1.03 + t * 0.003);
        const boxes = walk.cast.map((p) => {
          const x = m.ox + p.x * m.k + p.vx * t;
          const y = m.oy + p.y * m.k + p.vy * t + Math.sin(t * 8 + p.ph) * 1.4;
          const w = p.w * m.k, h = p.h * m.k;
          g.drawImage(p.sprite, x, y, w, h);
          return { x, y, w, h, area: p.area };
        });
        g.fillStyle = 'rgba(0,0,0,0.07)';
        for (let yy = 0; yy < H; yy += 4) g.fillRect(0, yy, W, 1);
        boxes.sort((a, b) => b.area - a.area).slice(0, 9).forEach((b, k) => {
          if (t < 0.5 + k * 0.35 || (Math.floor(t * 1.3) + k * 3) % 9 === 0) return;
          trackBox(g, b.x - 6, b.y - 6, b.w + 12, b.h + 12, s.labels[(k + Math.floor(t * 0.8)) % 3], plaza);
        });
        g.restore();
      } else if (plaza > 0 && plazaImg) {
        // the generated overhead still: boxes sit on the people in it, labels say what the chain shows
        g.save(); g.globalAlpha = plaza;
        const m = kenBurns(g, plazaImg, 1.02 + t * 0.005);
        g.fillStyle = 'rgba(0,0,0,0.07)';
        for (let y = 0; y < H; y += 4) g.fillRect(0, y, W, 1);
        PLAZA_PEOPLE.forEach(([px, py], i) => {
          if (t < 0.6 + i * 0.45 || (Math.floor(t * 1.3) + i * 3) % 9 === 0) return;
          const bw = 130 * m.k, bh = 240 * m.k;
          trackBox(g, m.ox + px * m.k - bw / 2, m.oy + py * m.k - bh / 2, bw, bh, s.labels[(i + Math.floor(t * 0.8)) % 3], plaza);
        });
        g.restore();
      } else if (plaza > 0) {
        g.save(); g.globalAlpha = plaza;
        g.fillStyle = '#f4f4f2'; g.fillRect(0, 0, W, H);
        g.strokeStyle = 'rgba(0,0,0,0.05)'; g.lineWidth = 2;
        for (let x = 0; x < W; x += 160) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x + 300, H); g.stroke(); }
        s.walkers.forEach((w, i) => {
          const x = ((w.x + w.vx * t) % (W + 200) + W + 200) % (W + 200) - 100;
          const y = ((w.y + w.vy * t) % (H + 200) + H + 200) % (H + 200) - 100;
          const ang = Math.atan2(w.vy, w.vx) + Math.PI / 2;
          const step = Math.sin(t * 6 + w.ph) * 0.12;
          const drawFig = (dx, dy, col) => {
            g.save(); g.translate(x + dx, y + dy); g.rotate(ang + step); g.scale(w.size, w.size);
            g.fillStyle = col;
            g.beginPath(); g.ellipse(0, 0, 30, 15, 0, 0, 6.28); g.fill();
            g.fillStyle = col.startsWith('hsl') ? '#161616' : col;
            g.beginPath(); g.arc(0, -3, 12, 0, 6.28); g.fill();
            g.restore();
          };
          g.fillStyle = 'rgba(0,0,0,0.12)';
          g.save(); g.translate(x + 26, y + 18); g.rotate(0.5); g.beginPath(); g.ellipse(0, 0, 44, 13, 0, 0, 6.28); g.fill(); g.restore();
          g.globalCompositeOperation = 'multiply';
          drawFig(-4, 0, 'rgba(0,140,255,0.55)');
          drawFig(4, 0, 'rgba(255,90,40,0.55)');
          g.globalCompositeOperation = 'source-over';
          drawFig(0, 0, `hsl(210 8% ${w.coat}%)`);
          if (s.tracked.includes(i)) {
            const on = Math.floor(t * 3 + i) % 7 !== 0;
            trackBox(g, x - 46, y - 46, 92, 92, s.labels[(Math.floor(t * 0.9) + i) % 3], on ? plaza : plaza * 0.3);
          }
        });
        // pixel break along the top edge (ref 4)
        const r = rng(Math.floor(t * 8));
        for (let k = 0; k < 140; k++) {
          const bx = r() * W, by = r() * 46, bs = 6 + r() * 16;
          g.fillStyle = r() < 0.6 ? '#050505' : '#ffffff';
          g.fillRect(bx, by, bs, bs);
        }
        g.fillStyle = '#050505'; g.fillRect(0, 0, W, 18);
        g.restore();
      }
      s.k.style.opacity = win(t, 0.5, 9.2, 0.5, 0.4);
      // 9.4–18: the real testnet bid txid under the same tracking box
      const c = prog(t, 9.4, 10.2);
      s.card.style.opacity = c;
      { const sc = scramble(TX_BID, prog(t, 9.6, 11.6), 5); s.tx.textContent = sc.slice(0, 32) + '\n' + sc.slice(32); }
      const bx = eo(prog(t, 11.4, 12.2));
      s.box.style.clipPath = `inset(0 ${(1 - bx) * 100}% 0 0)`;
      s.lab.forEach((l, i) => { const v = prog(t, 12.3 + i * 0.9, 12.6 + i * 0.9); l.style.opacity = v; l.style.transform = `translateX(${(1 - eo(v)) * 30}px)`; });
      s.foot.style.opacity = prog(t, 15.2, 16);
    },
  },
  {
    name: 'even the auctioneer', start: 72, dur: 22, dark: false, step: 1,
    say: 'And here’s the part that matters: not the public, not the other bidders — not even the auctioneer — learns who you are. They see a payment and a one-time refund address. Nothing more. The only one who can’t hide is the auctioneer. That’s exactly why you can hold them to account.',
    build(L) {
      const s = {};
      s.faces = Array.from({ length: 6 }, (_, i) => facePortrait(i, 48, 64));
      s.boss = portrait(321, 56, 70);
      s.head = [
        words(L, 'not the public.', { left: '80px', top: '70px', fontFamily: 'var(--serif)', fontSize: '54px', background: 'rgba(236,235,230,0.9)', padding: '2px 12px' }),
        words(L, 'not the other bidders.', { left: '510px', top: '70px', fontFamily: 'var(--serif)', fontSize: '54px', background: 'rgba(236,235,230,0.9)', padding: '2px 12px' }),
        words(L, 'not even the auctioneer.', { left: '1090px', top: '70px', fontFamily: 'var(--serif)', fontSize: '54px', color: '#111', background: 'rgba(236,235,230,0.9)', padding: '2px 12px' }),
      ];
      s.end = words(L, 'The only one who can’t hide.', { left: '1060px', top: '380px', width: '760px', fontFamily: 'var(--serif)', fontSize: '84px', lineHeight: '1.05', letterSpacing: '-0.02em' });
      s.end2 = put(L, 'div', 'abs', 'the auctioneer — and that is why you can hold them to account', { left: '1064px', top: '600px', width: '720px', fontSize: '30px', color: '#3b3b3b' });
      s.tags = ['bond posted', 'custody', 'accountable'].map((x, i) => put(L, 'div', 'abs tag', x, { left: `${1064 + [0, 230, 400][i]}px`, top: '700px', color: '#111' }));
      return s;
    },
    update(s, t) {
      const g = ctx;
      g.fillStyle = '#ecebe6'; g.fillRect(0, 0, W, H);
      const zoom = eio(prog(t, 12.2, 15.2));
      const gridA = 1 - prog(t, 14.2, 15.4);
      const cellW = 400, cellH = 360, ox = (W - cellW * 3) / 2, oy = 190;
      const pos = (i) => [ox + (i % 3) * cellW, oy + Math.floor(i / 3) * cellH];
      const hopAt = (i) => 1.2 + i * 1.7;
      if (gridA > 0) {
        g.save();
        g.globalAlpha = gridA;
        const z = lerp(1, 0.12, zoom);
        g.translate(W / 2, H / 2 + 60); g.scale(z, z); g.translate(-W / 2, -H / 2 - 60);
        // network lines between faces (ref 2)
        g.strokeStyle = 'rgba(20,20,20,0.25)'; g.lineWidth = 1.2;
        for (let i = 0; i < 6; i++) for (let j = i + 1; j < 6; j++) {
          if ((i + j) % 2) continue;
          const [ax, ay] = pos(i), [bx, by] = pos(j);
          g.beginPath(); g.moveTo(ax + cellW / 2, ay + cellH / 2);
          g.quadraticCurveTo(W / 2, oy + cellH, bx + cellW / 2, by + cellH / 2); g.stroke();
        }
        s.faces.forEach((p, i) => {
          const [x, y] = pos(i);
          const d = eo(prog(t, hopAt(i) + 0.75, hopAt(i) + 1.9));
          g.fillStyle = '#e2e0d9'; g.fillRect(x + 65, y + 10, 270, 340);
          halftone(g, p, x + 65, y + 10, 270, 340, d, '#151515', i + 1);
        });
        // the red box hops face to face; each face dissolves as it lands
        const hop = Math.floor(clamp((t - 1.2) / 1.7, 0, 5.999));
        if (t > 1 && t < 12.3) {
          const [x, y] = pos(hop);
          const [px, py] = pos(Math.max(0, hop - 1));
          const m = eo(prog(t, hopAt(hop), hopAt(hop) + 0.35));
          const bx = hop === 0 ? x : lerp(px, x, m), by = hop === 0 ? y : lerp(py, y, m);
          trackBox(g, bx + 125, by + 40, 150, 190, prog(t, hopAt(hop) + 0.45, hopAt(hop) + 0.5) > 0 ? 'UNKNOWN' : 'scanning…');
        }
        g.restore();
      }
      if (zoom > 0) {
        const fa = Math.min(prog(t, 13.6, 15), 1 - prog(t, 16.2, 17.4) * 0.85);
        g.save(); g.globalAlpha = fa;
        const z = lerp(2.4, 1, eo(prog(t, 13.6, 16.5)));
        g.translate(W / 2, H / 2); g.scale(z, z); g.translate(-W / 2, -H / 2);
        g.drawImage(faceField(), 0, 0);
        g.restore();
      }
      // 16–22: the auctioneer, lit and sharp
      const la = eo(prog(t, 16.2, 17.4));
      if (la > 0) {
        g.save(); g.globalAlpha = la;
        const grd = g.createRadialGradient(600, 560, 40, 600, 560, 520);
        grd.addColorStop(0, 'rgba(255,250,235,0.95)'); grd.addColorStop(1, 'rgba(236,235,230,0)');
        g.fillStyle = grd; g.fillRect(0, 0, W, H);
        const boss = still('auctioneer');
        if (boss) {
          // the auctioneer is a sharp photograph, not dots: the one party in the frame you can see
          const z = 1 + prog(t, 16.2, 22) * 0.06;
          const sw = boss.naturalWidth / z, sh = boss.naturalHeight / z;
          g.drawImage(boss, (boss.naturalWidth - sw) / 2, (boss.naturalHeight - sh) / 2, sw, sh, 110, 320, 820, 461);
          trackBox(g, 110, 320, 820, 461, 'AUCTIONEER · KNOWN', la, '#111');
        } else {
          halftone(g, s.boss, 350, 250, 500, 625, 0, '#0d0d0d', 99);
          trackBox(g, 470, 300, 260, 320, 'AUCTIONEER · KNOWN', la, '#111');
        }
        g.restore();
      }
      [[2.2, 4.2], [4.8, 7.2], [7.8, 10.2]].forEach(([a, b], i) => {
        s.head[i].style.opacity = t < 15.4 ? '1' : String(1 - prog(t, 15.4, 16));
        s.head[i].reveal(prog(t, a, b));
      });
      s.end.style.opacity = t > 17 ? 1 : 0;
      s.end.reveal(prog(t, 17.4, 19.2), '#b9b6ae', '#111');
      s.end2.style.opacity = prog(t, 19.2, 20);
      s.tags.forEach((e, i) => { e.style.opacity = prog(t, 19.8 + i * 0.4, 20.2 + i * 0.4); });
    },
  },
  {
    name: 'settlement', start: 94, dur: 22, dark: true, step: 2,
    say: 'At the deadline, the auctioneer runs a deterministic clearing rule. Three units, uniform price: every winner pays the same 0.11. Losers — and winners’ overpayment — are refunded in one shielded transaction.',
    build(L) {
      const s = {};
      s.k1 = put(L, 'div', 'abs kicker', 'zcash testnet · block height', { left: '120px', top: '150px', color: '#9a9a9a' });
      s.h = odometer(L, (v) => v.toLocaleString('en-US'), { left: '110px', top: '205px', fontSize: '150px', color: '#fff' });
      s.dl = put(L, 'div', 'abs tag', 'deadline', { left: '125px', top: '390px', color: 'var(--fail)' });
      s.term = terminal(L, 'secbid — settle', { left: '120px', top: '470px', width: '1080px', height: '560px' });
      const L2 = (h) => ({ html: h });
      s.term.lines = [
        { at: 6.2, cmd: 'secbid settle fixtures/testnet-01 --rpc http://127.0.0.1:28232', speed: 46 },
        { at: 8.0, html: 'settled 6 notes at height 4549561' },
        { at: 8.25, html: '  rule            uniform / 3 units' },
        { at: 8.5, html: '  result          sold' },
        { at: 8.75, html: '  clearing price  <span class="hl" id="hlp">11000000 zat per unit</span>' },
        { at: 9.0, html: '  winners         3' },
        { at: 9.25, html: '  refunds         <span class="hl" id="hlr">5 outputs in 1 tx at height 4549569</span>' },
        { at: 9.5, html: '  memos           6, largest 177/512 bytes' },
        { at: 9.75, html: '  mode            public-tender' },
        { at: 10.2, html: '<span class="ok">RESULT: PASS (14/14 checks)</span>' },
      ];
      s.k2 = put(L, 'div', 'abs kicker', 'clearing price · TAZ', { left: '1320px', top: '520px', color: '#9a9a9a' });
      s.p = odometer(L, (v) => '0.' + String(v).padStart(2, '0'), { left: '1310px', top: '575px', fontSize: '170px', color: '#fff' });
      s.p2 = put(L, 'div', 'abs serif', 'every winner pays the same', { left: '1320px', top: '780px', fontSize: '38px', fontStyle: 'italic', color: '#d8d8d8' });
      return s;
    },
    update(s, t) {
      ctx.clearRect(0, 0, W, H);
      s.h.set(lerp(4549544, 4549558, eio(prog(t, 0.6, 4.6))));
      s.k1.style.opacity = prog(t, 0.2, 0.8);
      s.dl.style.opacity = prog(t, 4.6, 5.0);
      s.term.style.opacity = prog(t, 5.6, 6.1);
      s.term.render(t);
      const hp = document.getElementById('hlp'), hr = document.getElementById('hlr');
      if (hp) sweep(hp, prog(t, 13.4, 14.2));
      if (hr) sweep(hr, prog(t, 16.6, 17.6));
      s.k2.style.opacity = prog(t, 10.6, 11.2);
      s.p.style.opacity = prog(t, 10.6, 11.2);
      const pv = t < 12.4 ? lerp(14, 12, eio(prog(t, 11.2, 12.4))) : lerp(12, 11, eio(prog(t, 12.6, 13.4)));
      s.p.set(pv);
      s.p2.style.opacity = prog(t, 13.4, 14.2);
    },
  },
  {
    name: 'did my bid count', start: 116, dur: 16, dark: true, step: 3,
    say: 'Each refund carries a Merkle inclusion proof. The bidder checks it and knows their bid was counted. Change one byte, and it fails.',
    build(L) {
      const s = {};
      s.term = terminal(L, 'bidder — proof check', { left: '120px', top: '150px', width: '1680px', height: '430px' });
      s.big = put(L, 'div', 'abs serif', 'counted.', { left: '120px', top: '680px', fontSize: '140px', color: 'var(--pass)', letterSpacing: '-0.02em' });
      s.memo = put(L, 'div', 'abs mono', '', { left: '120px', top: '640px', fontSize: '44px', color: '#ddd', whiteSpace: 'pre' });
      s.flipLab = put(L, 'div', 'abs tag', 'flip one byte', { left: '120px', top: '760px', color: 'var(--fail)' });
      s.bad = put(L, 'div', 'abs serif', 'caught.', { left: '1100px', top: '680px', fontSize: '140px', color: 'var(--fail)', letterSpacing: '-0.02em' });
      return s;
    },
    update(s, t) {
      ctx.clearRect(0, 0, W, H);
      const memoShort = MEMO.slice(0, 30) + '…';
      const flipped = MEMO.slice(0, 22) + 'Q' + MEMO.slice(23, 30) + '…';
      s.term.lines = [
        { at: 0.4, cmd: `secbid proof check fixtures/testnet-01 ${memoShort}`, speed: 50 },
        { at: 2.3, html: '<span class="ok">MEMO: OK (inclusion proof, outcome, and price match the settlement)</span>' },
        { at: 8.6, cmd: `secbid proof check fixtures/testnet-01 ${flipped}`, speed: 60 },
        { at: 10.2, html: '  problem: inclusion proof does not reconstruct the root' },
        { at: 10.45, html: '  problem: leaf is not in the published entry table' },
        { at: 10.8, html: '<span class="bad">MEMO: MISMATCH</span>' },
      ];
      s.term.render(t);
      s.big.style.opacity = win(t, 2.6, 5.4, 0.4, 0.4);
      const mv = win(t, 5.6, 8.6, 0.3, 0.3);
      s.memo.style.opacity = mv;
      s.flipLab.style.opacity = mv;
      if (mv > 0) {
        const at = 22;
        const ch = t < 6.6 ? MEMO[at] : t < 7.4 ? GLYPHS[Math.floor(t * 30) % GLYPHS.length] : 'Q';
        s.memo.innerHTML = esc(MEMO.slice(0, at)) + `<span class="flip">${esc(ch)}</span>` + esc(MEMO.slice(at + 1, 40)) + '…';
      }
      s.bad.style.opacity = prog(t, 11, 11.5);
      s.bad.style.left = '120px';
    },
  },
  {
    name: 'anyone can recompute', start: 132, dur: 26, dark: true, step: 3,
    say: 'This is the core difference. Anyone can replay the auction from chain data: same bids, same rules, byte-identical result. Fourteen public checks, all passing on testnet. Drop one bid, and the verifier names exactly which check fails. A dishonest auctioneer doesn’t just look bad — they get caught.',
    build(L) {
      const s = {};
      s.term = terminal(L, 'anyone — verify', { left: '90px', top: '90px', width: '1300px', height: '900px' });
      const lines = [{ at: 0.4, cmd: 'secbid verify fixtures/testnet-01', speed: 30 },
        { at: 1.8, html: '<span class="dim">auction c91d611828ac595f556528459b0e5869  mode fixture  entries 6</span>' }];
      VERIFY_TESTNET.forEach(([id, txt], i) => lines.push({ at: 2.2 + i * 0.55, html: `  ${pad(id, 4)} <span class="ok">pass</span> ${esc(txt.length > 58 ? txt.slice(0, 57) + '…' : txt)}` }));
      lines.push({ at: 10.2, html: '<span class="hl ok" id="hlv">RESULT: PASS (14/14 checks)</span>' });
      s.passLines = lines;
      s.tamperLines = [
        { at: 16.4, cmd: 'secbid verify fixtures/tamper/t2-truncate', speed: 30 },
        { at: 18.0, html: '<span class="dim">auction 0011223344556677  mode fixture  entries 6</span>' },
        { at: 18.4, html: `  C1   <span class="ok">pass</span> params_hash and settlement_hash match published commitments` },
        { at: 18.6, html: `  C2   <span class="ok">pass</span> merkle_root recomputes from entries` },
        { at: 18.8, html: `  C3   <span class="ok">pass</span> 6 inclusion proof(s) verified` },
        { at: 19.0, html: `  C4   <span class="ok">pass</span> every admitted bid is inside the bidding window` },
        { at: 19.4, html: `  C5   <span class="bad">FAIL truncation: 7 observed at the auction address, 6 committed</span>` },
        { at: 19.8, html: `  C6   <span class="ok">pass</span> no transparent-funded note admitted as a bid` },
        { at: 20.0, html: `  C7   <span class="ok">pass</span> clearing recomputes to the published result` },
        { at: 20.3, html: `  C8   <span class="bad">FAIL 1 refund output(s) are not claimed by any entry</span>` },
        { at: 20.6, html: `<span class="dim">  C9–C14 pass (lines folded)</span>` },
        { at: 21.2, html: '<span class="bad">RESULT: FAIL C5: truncation: 7 observed at the auction address, 6 committed</span>' },
      ];
      s.k = put(L, 'div', 'abs kicker', 'public checks · zcash testnet', { left: '1430px', top: '260px', color: '#9a9a9a' });
      s.count = odometer(L, (v) => String(v).padStart(2, '0'), { left: '1420px', top: '310px', fontSize: '150px', color: 'var(--pass)' });
      s.of = put(L, 'div', 'abs mono', '/14', { left: '1606px', top: '310px', fontSize: '150px', lineHeight: '1', color: 'var(--pass)' });
      s.note = put(L, 'div', 'abs', 'a copy of the demo auction<br>with <b>one bid dropped</b>', { left: '1470px', top: '560px', fontSize: '30px', lineHeight: '1.4', color: '#cfcfcf' });
      s.c5 = put(L, 'div', 'abs mono', 'C5', { left: '1460px', top: '640px', fontSize: '200px', color: 'var(--fail)', lineHeight: '1' });
      s.c5b = put(L, 'div', 'abs serif', 'names the lie.', { left: '1470px', top: '850px', fontSize: '56px', fontStyle: 'italic', color: '#eee' });
      return s;
    },
    update(s, t) {
      ctx.clearRect(0, 0, W, H);
      if (t < 15.6) { s.term.lines = s.passLines; s.term.render(t); s.term.style.opacity = 1 - prog(t, 15.0, 15.6); }
      else { s.term.lines = s.tamperLines; s.term.render(t); s.term.style.opacity = prog(t, 15.6, 16.1); }
      const hv = document.getElementById('hlv');
      if (hv) sweep(hv, prog(t, 10.6, 11.6));
      const n = clamp(Math.floor((t - 2.2) / 0.55) + 1, 0, 14);
      s.count.set(t < 2.2 ? 0 : n);
      const ca = win(t, 2, 15.4, 0.4, 0.5);
      s.count.style.opacity = ca; s.k.style.opacity = ca; s.of.style.opacity = ca;
      s.note.style.opacity = prog(t, 16.2, 16.9);
      s.c5.style.opacity = prog(t, 19.4, 19.8);
      s.c5.style.transform = `scale(${1.25 - 0.25 * eo(prog(t, 19.4, 19.9))})`;
      s.c5b.style.opacity = prog(t, 21.4, 22.2);
    },
  },
  {
    name: 'trust + quantum', start: 158, dur: 12, dark: true,
    say: 'We’re precise about trust: custody is auditable, not trustless, and a bond makes cheating costly. All six testnet bids sat in Zcash’s new Ironwood pool — quantum-recoverable, and we say exactly that, not “quantum-proof”.',
    build(L) {
      const s = {};
      s.term = terminal(L, 'secbid — quantum-report', { left: '90px', top: '120px', width: '1240px', height: '760px' });
      s.term.lines = [
        { at: 0.3, cmd: 'secbid quantum-report fixtures/testnet-01', speed: 40 },
        { at: 1.6, html: 'quantum exposure  auction c91d611828ac595f556528459b0e5869' },
        { at: 1.9, html: '' },
        { at: 2.0, html: '  pool                ironwood' },
        { at: 2.2, html: '  notes observed      6' },
        { at: 2.4, html: '  by pool             ironwood 6, orchard 0, sapling 0' },
        { at: 2.6, html: '  recoverable notes   <span class="hl" id="hlq">6/6</span>' },
        { at: 2.8, html: '' },
        { at: 3.0, html: '  - The auction account holds spending keys in one place:' },
        { at: 3.1, html: '    custody is auditable, not trustless.' },
        { at: 3.3, html: '  - 6 note(s) are in the quantum-recoverable pool: recovery is' },
        { at: 3.4, html: '    possible, confidentiality is not post-quantum.' },
        { at: 3.7, html: '' },
        { at: 3.8, html: '  <span id="disc">Quantum-recoverable ≠ post-quantum. Privacy of revealed data is not</span>' },
        { at: 3.8, html: '  <span id="disc2">protected against a future discrete-log-breaking adversary.</span>' },
      ];
      s.stack = ['auditable custody', 'bond: cheating is costly', 'not trustless'].map((x, i) =>
        put(L, 'div', 'abs serif', x, { left: '1400px', top: `${300 + i * 110}px`, fontSize: '46px', whiteSpace: 'nowrap', color: i === 2 ? 'var(--fail)' : '#f0f0f0' }));
      return s;
    },
    update(s, t) {
      ctx.clearRect(0, 0, W, H);
      s.term.render(t);
      const q = document.getElementById('hlq');
      if (q) sweep(q, prog(t, 7.2, 8));
      const d = document.getElementById('disc'), d2 = document.getElementById('disc2');
      if (d) { const u = `inset 0 -3px 0 rgba(255,122,107,${prog(t, 9, 9.6)})`; d.style.boxShadow = u; d2.style.boxShadow = u; }
      s.stack.forEach((e, i) => { const v = prog(t, 2.2 + i * 1.6, 2.9 + i * 1.6); e.style.opacity = v; e.style.transform = `translateY(${(1 - eo(v)) * 24}px)`; });
    },
  },
  {
    name: 'close', start: 170, dur: 10, dark: true,
    say: 'Today a private auction asks you to trust something: a contract that reveals every bid, a chip vendor, or the holders of a key. Secbid folds that into one shielded payment that anyone can recompute. Check it yourself.',
    capsAt: [[0.2, 4.4], [4.4, 7.0], [7.0, 10]],
    build(L) {
      const s = {};
      const ORBS = [
        ['Smart contract', 'bids go public at reveal'],
        ['TEE', 'trust the chip vendor'],
        ['FHE', 'trust the key holders'],
      ];
      s.labels = ORBS.map(([name, sub]) => {
        const e = put(L, 'div', 'abs', null, { width: '420px', textAlign: 'center', top: '770px' });
        put(e, 'div', 'serif', name, { fontSize: '46px', color: '#f2f2f2', letterSpacing: '-0.01em' });
        put(e, 'div', 'mono', sub, { fontSize: '21px', color: '#9a9a9a', marginTop: '8px', letterSpacing: '0.04em' });
        return e;
      });
      s.one = put(L, 'div', 'abs', null, { left: '0', right: '0', top: '770px', textAlign: 'center' });
      put(s.one, 'div', 'serif', 'Secbid', { fontSize: '58px', color: '#fff', letterSpacing: '-0.02em' });
      put(s.one, 'div', 'mono', 'one shielded payment · anyone recomputes', { fontSize: '22px', color: 'var(--pass)', marginTop: '8px', letterSpacing: '0.06em' });
      s.check = words(L, 'Check it yourself.', { left: '0', right: '0', top: '80px', textAlign: 'center', fontFamily: 'var(--serif)', fontSize: '96px', color: '#fff', letterSpacing: '-0.02em' });
      s.check.querySelectorAll('.rw').forEach((w) => w.classList.add('hl'));
      s.t2 = put(L, 'div', 'abs', 'private markets, on zcash &nbsp;·&nbsp; github.com/Axlnd3r/SecBid', { left: '0', right: '0', top: '880px', textAlign: 'center', fontSize: '24px', letterSpacing: '0.14em', textTransform: 'uppercase', color: '#8a8a8a' });
      return s;
    },
    update(s, t) {
      const g = ctx;
      g.fillStyle = '#030303'; g.fillRect(0, 0, W, H);
      // three soft orbs (ref 5) drift, overlap, and fold into one; ghost copies trail the motion
      const merge = eio(prog(t, 3.0, 4.6));
      const spread = (tt) => lerp(470, 0, eio(prog(tt, 3.0, 4.6))) + Math.sin(tt * 1.3) * 18 * (1 - eio(prog(tt, 3.0, 4.6)));
      const cy = 470;
      const orb = (x, y, r, a) => {
        const glow = g.createRadialGradient(x, y, r * 0.7, x, y, r * 1.9);
        glow.addColorStop(0, `rgba(255,255,255,${0.10 * a})`); glow.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = glow; g.fillRect(x - r * 2, y - r * 2, r * 4, r * 4);
        const body = g.createRadialGradient(x - r * 0.35, y - r * 0.42, r * 0.05, x, y, r);
        body.addColorStop(0, `rgba(252,252,252,${a})`);
        body.addColorStop(0.45, `rgba(176,176,176,${a * 0.92})`);
        body.addColorStop(0.86, `rgba(48,48,48,${a * 0.92})`);
        body.addColorStop(0.97, `rgba(22,22,22,${a * 0.9})`);
        body.addColorStop(1, `rgba(8,8,8,${a * 0.2})`);
        g.fillStyle = body; g.beginPath(); g.arc(x, y, r, 0, 6.2832); g.fill();
      };
      const appear = (i) => eo(prog(t, 0.2 + i * 0.35, 1.0 + i * 0.35));
      g.save();
      g.globalCompositeOperation = 'lighten'; // overlaps keep each orb visible instead of blowing out
      for (const lag of [0.16, 0.08, 0]) {
        const tt = Math.max(0, t - lag);
        const ghost = lag === 0 ? 1 : (merge > 0 && merge < 1 ? 0.28 : 0);
        if (!ghost) continue;
        const r = lerp(185, 250, eio(prog(tt, 3.0, 4.6)));
        [-1, 0, 1].forEach((k, i) => {
          const a = appear(i) * ghost * (merge >= 1 ? (i === 1 ? 1 : 0) : 0.9);
          if (a > 0) orb(W / 2 + k * spread(tt), cy + Math.sin(tt * 1.7 + i) * 10 * (1 - merge), r, a);
        });
      }
      g.restore();
      const vig = g.createRadialGradient(W / 2, cy, 200, W / 2, cy, 1100);
      vig.addColorStop(0, 'rgba(0,0,0,0)'); vig.addColorStop(1, 'rgba(0,0,0,0.85)');
      g.fillStyle = vig; g.fillRect(0, 0, W, H);
      s.labels.forEach((e, i) => {
        e.style.left = `${W / 2 + (i - 1) * spread(t) - 210}px`;
        e.style.opacity = String(Math.min(appear(i), 1 - prog(t, 2.8, 3.4)));
      });
      s.one.style.opacity = String(prog(t, 4.6, 5.2));
      s.check.style.opacity = t > 6.6 ? '1' : '0';
      s.check.reveal(prog(t, 6.8, 7.5), '#555', null); // inherit white; the marker turns it ink
      s.check.querySelectorAll('.hl').forEach((h) => sweep(h, prog(t, 7.5, 8.1)));
      s.t2.style.opacity = prog(t, 8.2, 8.8);
    },
  },
];
/* ---------- the 2-minute cut (film.html?cut=2) ----------
   Each scene keeps parts of its own timeline, [from, to, speed] in scene seconds, and gets a
   shorter line so the captions are never rushed. Without ?cut=2 the full 3:00 film plays. */
const CUT2 = {
  'title': { keep: [[0, 5]], say: 'Secbid: sealed-bid auctions on Zcash, where the bid is a shielded payment.' },
  'sealed bids': { keep: [[0.3, 9.4], [14.5, 19.6]], say: 'A sealed bid only works if your competitors can’t see your number. On a transparent chain, every bid is visible.' },
  'who uses it': {
    keep: [[0, 13.95, 1.4], [14, 18.6]],
    say: 'OTC block sales. Procurement tenders. Token sales. Grant allocation. In Secbid the bid is one shielded Zcash payment — no app, no contract, no reveal.',
    capsAt: [[0, 2.5], [2.5, 4.95], [4.95, 7.4], [7.4, 9.96], [9.96, 14.6]],
  },
  'how it works': { keep: [[0, 8, 1.3]], say: 'Open, bid, settle — and anyone can verify.' },
  'observer sees nothing': { keep: [[0.3, 5.8], [9.3, 16]], say: 'This is a real testnet bid. The chain shows no sender, no amount, no memo.' },
  'even the auctioneer': {
    keep: [[1, 11.6, 1.6], [12.2, 21, 1.2]],
    say: 'Not the public, not other bidders — not even the auctioneer learns who you are. The auctioneer is the one who can’t hide, so they can be held to account.',
  },
  'settlement': { keep: [[0.4, 17.8, 1.45]], say: 'At the deadline a deterministic rule clears the auction: one price for every winner, and refunds in one shielded transaction.' },
  'did my bid count': { keep: [[0.3, 12, 1.5]], say: 'Every refund carries an inclusion proof. Flip one byte and it fails.' },
  'anyone can recompute': {
    keep: [[0.3, 12, 1.45], [15.5, 22.6, 1.3]],
    say: 'Anyone can replay the auction from chain data: fourteen checks pass on testnet. Drop one bid, and the verifier names the check that fails.',
  },
  'trust + quantum': { keep: [[0.3, 10.5, 1.35]], say: 'Custody is auditable, not trustless, and all six bids sit in the quantum-recoverable Ironwood pool.' },
  'close': { keep: [[0.2, 10]], say: 'No contract, chip or key holder to trust. Check it yourself.' },
};
const CUT = new URLSearchParams(location.search).get('cut') === '2';

/* the timeline actually played: one entry per scene, with its kept segments */
const PLAN = [];
{
  let at = 0;
  for (const sc of SCENES) {
    const c = CUT ? CUT2[sc.name] : null;
    const segs = c ? c.keep.map(([a, b, sp = 1]) => ({ a, b, sp, len: (b - a) / sp })) : [{ a: 0, b: sc.dur, sp: 1, len: sc.dur }];
    const dur = segs.reduce((n, s) => n + s.len, 0);
    PLAN.push({ sc, start: at, dur, segs, say: c ? c.say : sc.say, capsAt: c ? c.capsAt : sc.capsAt });
    at += dur;
  }
}
const TOTAL = PLAN[PLAN.length - 1].start + PLAN[PLAN.length - 1].dur;
/* plan time u (seconds into this scene's slot) → [the scene's own time, the speed it runs at] */
function sceneTime(p, u) {
  for (const s of p.segs) {
    if (u < s.len || s === p.segs[p.segs.length - 1]) return [s.a + Math.min(u, s.len) * s.sp, s.sp];
    u -= s.len;
  }
  return [0, 1];
}

/* captions: split each scene's narration into sentences, timed by word count (or pinned by capsAt) */
PLAN.forEach((p) => {
  const parts = p.say.split(/(?<=[.!?][”’"]?)\s+/); // sentence ends only before whitespace, so 0.11 stays whole
  if (p.capsAt) { p.caps = parts.map((text, i) => ({ a: p.capsAt[i][0], b: p.capsAt[i][1], text })); return; }
  const total = parts.reduce((n, s) => n + s.trim().split(/\s+/).length, 0);
  let acc = 0;
  p.caps = parts.map((s) => {
    const n = s.trim().split(/\s+/).length;
    const c = { a: (acc / total) * p.dur, b: ((acc + n) / total) * p.dur, text: s.trim() };
    acc += n;
    return c;
  });
});

/* ---------- grain ---------- */
const gcv = document.getElementById('grain');
const gctx = gcv.getContext('2d');
const gimg = gctx.createImageData(480, 270);
function grain(frame) {
  const r = rng(frame);
  const d = gimg.data;
  for (let i = 0; i < d.length; i += 4) {
    const v = 120 + r() * 135;
    d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255;
  }
  gctx.putImageData(gimg, 0, 0);
}

/* ---------- player ---------- */
let now = 0, playing = false, last = 0, active = -1, state = null, gframe = -1, curSpeed = 1;
const $cap = document.getElementById('cap'), $hud = document.getElementById('hud'), $start = document.getElementById('start');
const $rail = document.getElementById('rail');
$rail.innerHTML = STEPS.map((x, i) => `<span>0${i + 1} ${x}</span>`).join('');
function sceneAt(t) {
  for (let i = PLAN.length - 1; i >= 0; i--) if (t >= PLAN[i].start) return i;
  return 0;
}
function draw() {
  const i = sceneAt(now);
  const p = PLAN[i], sc = p.sc;
  if (i !== active) {
    active = i;
    for (const v of Object.values(CLIPS)) if (!v.paused) v.pause();
    $layer.innerHTML = '';
    ctx.clearRect(0, 0, W, H);
    $stage.classList.toggle('dark', sc.dark);
    state = sc.build($layer);
  }
  const u = clamp(now - p.start, 0, p.dur);
  const [lt, sp] = sceneTime(p, u);
  curSpeed = sp;
  sc.update(state, lt);
  const chapter = sc.step != null;
  $rail.classList.toggle('show', chapter);
  [...$rail.children].forEach((c, k) => c.classList.toggle('on', chapter && k === sc.step));
  const cap = p.caps.find((c) => u >= c.a && u < c.b);
  const html = cap ? `<span>${esc(cap.text)}</span>` : '';
  if ($cap.innerHTML !== html) $cap.innerHTML = html;
  const gf = Math.floor(now * 12);
  if (gf !== gframe) { gframe = gf; grain(gf); }
  const mm = Math.floor(now / 60), ss = (now % 60).toFixed(1).padStart(4, '0');
  const tm = Math.floor(TOTAL / 60), ts = String(Math.round(TOTAL % 60)).padStart(2, '0');
  $hud.textContent = `${mm}:${ss} / ${tm}:${ts}${CUT ? ' (2-min cut)' : ''}  ·  ${i + 1} ${sc.name}${playing ? '' : '  ·  paused'}`;
}
function tick(ts) {
  if (playing) {
    now += (ts - last) / 1000;
    if (now >= TOTAL) { now = TOTAL - 0.001; playing = false; }
  }
  last = ts;
  draw();
  requestAnimationFrame(tick);
}
function seek(t) { now = clamp(t, 0, TOTAL - 0.001); active = -1; }
function fit() {
  const k = Math.min(innerWidth / W, innerHeight / H);
  $stage.style.transform = `translate(-50%, -50%) scale(${k})`;
  document.body.style.height = innerHeight + 'px';
}
addEventListener('resize', fit);
addEventListener('keydown', (e) => {
  if (e.code === 'Space') { e.preventDefault(); playing = !playing; $start.classList.add('off'); }
  else if (e.key === 'ArrowRight') seek(now + 5);
  else if (e.key === 'ArrowLeft') seek(now - 5);
  else if (/^[1-9]$/.test(e.key) && PLAN[+e.key - 1]) seek(PLAN[+e.key - 1].start);
  else if (e.key === 'r' || e.key === 'R') { seek(0); playing = false; $start.classList.remove('off'); }
  else if (e.key === 'c' || e.key === 'C') $cap.classList.toggle('off');
  else if (e.key === 'h' || e.key === 'H') $hud.classList.toggle('off');
});
const qs = new URLSearchParams(location.search);
if (qs.has('t')) { seek(+qs.get('t')); $start.classList.add('off'); }
if (qs.has('nocap')) $cap.classList.add('off');
fit();
crowd(); // pre-render generated imagery so playback never stalls
for (const k of ['plaza', 'hall', 'gavel', 'tender', ...USE_PHOTOS]) clip(k);
stillsReady.then(() => { fieldImg = null; faceField(); plazaPeople(); });
requestAnimationFrame((ts) => { last = ts; tick(ts); });
