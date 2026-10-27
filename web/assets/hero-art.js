/**
 * Hero artwork: the Secbid X, drawn as a gavel crossed with a bolt of light,
 * printed as grain. A sledgehammer runs from the upper left to the lower right,
 * the bolt cuts across it, and together they make the X. An auction's two
 * facts sit in one mark: the hammer that closes the sale, and the flash that is
 * the only thing the chain shows about a bid.
 *
 * The shapes are rasterised once into soft masks, lit from above (a rim light
 * found by sampling toward the light), and each cell becomes a dot with
 * probability equal to its brightness. The picture develops once on load and
 * then holds still: nothing on this page animates on a loop.
 *
 * `stipple` is pure and tested from Node; everything that needs a canvas lives
 * in `mountHeroArt`. No raster asset, no request: the image is generated here.
 */

export const ART_W = 360;
export const ART_H = 300;

const INK = 0xfff2f2f2; // ImageData is little-endian RGBA: alpha 0xff, grey 0xf2

/**
 * One frame of grain. Cell i lights with probability prob[i] * gain / 65536
 * (prob 0..255, gain 0..256). Same seed, same frame. Returns the next seed.
 */
export function stipple(prob, out, seed, gain = 256, ink = INK) {
  let s = seed >>> 0 || 1;
  for (let i = 0; i < prob.length; i++) {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    out[i] = s >>> 16 < prob[i] * gain ? ink : 0;
  }
  return s;
}

/**
 * The hover look: the picture is read through scan lines, and a lens around the
 * cursor bends the rows. `level` (0..1) is how far the effect has eased in;
 * at 0 the output is the input, untouched. Pure, so it is tested from Node.
 *
 * Every `rows`-th row is dimmed in screen space while the content under it
 * moves, so the lines appear to ripple over the mark instead of the mark
 * being redrawn. The grain itself never reshuffles (callers keep one seed).
 */
export function warp(prob, out, w, h, { cx, cy, level, radius = 46, pull = 0.55, rows = 3 }) {
  const s2 = 2 * radius * radius;
  for (let y = 0; y < h; y++) {
    const dim = level > 0 && y % rows === rows - 1 ? 1 - 0.9 * level : 1;
    for (let x = 0; x < w; x++) {
      let sx = x;
      let sy = y;
      if (level > 0) {
        const dx = x - cx;
        const dy = y - cy;
        const g = level * pull * Math.exp(-(dx * dx + dy * dy) / s2);
        sx = Math.min(w - 1, Math.max(0, Math.round(x - dx * g)));
        sy = Math.min(h - 1, Math.max(0, Math.round(y - dy * g + g * 4 * Math.sin(x * 0.35))));
      }
      out[y * w + x] = Math.round(prob[sy * w + sx] * dim);
    }
  }
}

/* ── the scene ──────────────────────────────────────────────────────────── */

// Shapes are drawn in local units around the middle of the X, y pointing down,
// then scaled by K onto the canvas.
const K = 1.08;
const CX = ART_W / 2;
const CY = ART_H / 2 + 10; // the head is the tallest part and sits high: keep its corner on the canvas
const QUARTER = Math.PI / 4;

function hash2(x, y) {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function vnoise(x, y) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi);
  const b = hash2(xi + 1, yi);
  const c = hash2(xi, yi + 1);
  const d = hash2(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

function smooth(e0, e1, x) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

function block(g, x, y, w, h, r) {
  if (r > 0 && g.roundRect) {
    g.beginPath();
    g.roundRect(x, y, w, h, r);
    g.fill();
  } else {
    g.fillRect(x, y, w, h);
  }
}

/** The sledgehammer: head at the upper left, handle running to the lower right. */
function drawHammer(g) {
  g.save();
  g.rotate(QUARTER); // +x now points down and to the right, along the handle
  block(g, -134, -48, 50, 96, 6); // head, long axis across the handle
  block(g, -84, -13, 10, 26, 2); // collar where the head meets the handle
  block(g, -76, -7.5, 208, 15, 3); // handle
  block(g, 114, -11, 20, 22, 4); // flared butt
  g.restore();
}

/** The bolt, upper right to lower left, as a two-bladed zigzag. */
function boltPath(g) {
  g.save();
  g.rotate(QUARTER);
  g.scale(1.1, 1.1);
  g.beginPath();
  g.moveTo(10, -140);
  g.lineTo(-24, 8);
  g.lineTo(-4, 8);
  g.lineTo(-14, 140);
  g.lineTo(26, -18);
  g.lineTo(4, -18);
  g.closePath();
  g.restore();
}

function drawBolt(g) {
  boltPath(g);
  g.fill();
}

/** The bolt plus a gap around it, cut out of the hammer where the two cross. */
function drawBoltHalo(g) {
  boltPath(g);
  g.fill();
  g.lineWidth = 11;
  g.stroke();
}

/** A soft 0..1 mask of one drawing, blurred by `blur` canvas pixels. */
function maskOf(draw, blur = 0) {
  const canvas = document.createElement('canvas');
  canvas.width = ART_W;
  canvas.height = ART_H;
  const g = canvas.getContext('2d', { willReadFrequently: true });
  g.fillStyle = '#fff';
  g.strokeStyle = '#fff';
  g.lineCap = 'round';
  g.lineJoin = 'round';
  if (blur > 0) g.filter = `blur(${blur}px)`;
  g.setTransform(K, 0, 0, K, CX, CY);
  draw(g);
  const data = g.getImageData(0, 0, ART_W, ART_H).data;
  const mask = new Float32Array(ART_W * ART_H);
  for (let i = 0; i < mask.length; i++) mask[i] = data[i * 4] / 255;
  return mask;
}

/** How much a shape's edge faces the light: 0 inside, up to 1 on the lit rim. */
function rim(mask, x, y, lx, ly) {
  const sx = Math.round(x + lx * 5);
  const sy = Math.round(y + ly * 5);
  const toward = sx < 0 || sy < 0 || sx >= ART_W || sy >= ART_H ? 0 : mask[sy * ART_W + sx];
  return Math.max(0, mask[y * ART_W + x] - toward);
}

/** Brightness per cell (0..255), the input `stipple` turns into grain. */
function sceneProbabilities() {
  const hammer = maskOf(drawHammer, 1.3);
  const bolt = maskOf(drawBolt, 1.1);
  const halo = maskOf(drawBoltHalo, 1.1);
  const aura = maskOf((g) => {
    drawHammer(g);
    drawBolt(g);
  }, 11);
  const prob = new Uint8Array(ART_W * ART_H);
  const lx = -0.38;
  const ly = -0.92; // light comes from above, a little from the left

  for (let y = 0; y < ART_H; y++) {
    for (let x = 0; x < ART_W; x++) {
      const i = y * ART_W + x;
      const px = x + 0.5;
      const py = y + 0.5;

      // light raking through the shapes: long horizontal streaks and a coarse blotch
      const streak = vnoise(px / 34, py / 1.6) ** 3;
      const blot = vnoise(px / 12 + 17, py / 12) ** 2;
      const tex = 0.45 + 0.4 * streak + 0.3 * blot;

      // ragged edges: shed dust instead of ending on a line
      const dust = (vnoise(px / 2.2, py / 2.2) - 0.5) * 0.55;
      const hm = smooth(0.18, 0.82, hammer[i] + dust) * (1 - smooth(0.2, 0.7, halo[i]) * 0.97);
      const bm = smooth(0.18, 0.82, bolt[i] + dust);

      const hamLum = (0.42 + 0.5 * tex) + 1.1 * rim(hammer, x, y, lx, ly);
      const boltLum = 0.5 + 0.4 * tex + 0.7 * rim(bolt, x, y, lx, ly);
      const smoke = aura[i] * (0.04 + 0.26 * streak) * (1 - Math.max(hm, bm));

      const lum = Math.max(hm * hamLum, bm * boltLum) + smoke;
      prob[i] = Math.round(Math.pow(Math.min(1, Math.max(0, lum)), 1.1) * 255);
    }
  }
  return prob;
}

/**
 * Replace the SVG fallback inside `figure` with the generated grain. Returns
 * false (and leaves the SVG) when there is no 2D canvas.
 */
export function mountHeroArt(figure, { reduced = false } = {}) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext?.('2d');
  if (!ctx) return false;
  canvas.width = ART_W;
  canvas.height = ART_H;
  canvas.className = 'hero-canvas';
  canvas.setAttribute('role', 'img');
  canvas.setAttribute(
    'aria-label',
    'The Secbid mark: an auction gavel crossed with a bolt of light, forming an X, drawn in grain.',
  );

  const prob = sceneProbabilities();
  const image = ctx.createImageData(ART_W, ART_H);
  const out = new Uint32Array(image.data.buffer);
  let seed = 0x5ecb1d;
  const paint = (gain) => {
    seed = stipple(prob, out, seed, gain);
    ctx.putImageData(image, 0, 0);
  };

  figure.append(canvas);
  figure.dataset.art = 'canvas';
  if (reduced) {
    paint(256);
    return true;
  }

  // Hover: scan lines and a lens that follows the cursor. It runs only while the
  // pointer is over the mark or easing back out, then the frame loop stops.
  const FIXED_SEED = 0x5ecb1d;
  const work = new Uint8Array(prob.length);
  const cursor = { x: ART_W / 2, y: ART_H / 2 };
  let ready = false;
  let level = 0;
  let target = 0;
  let dirty = false;
  let frame = 0;
  let last = 0;
  const draw = (now) => {
    frame = 0;
    const dt = Math.min(64, last ? now - last : 16);
    last = now;
    level += (target - level) * Math.min(1, dt / 140);
    if (Math.abs(target - level) < 0.01) level = target;
    warp(prob, work, ART_W, ART_H, { cx: cursor.x, cy: cursor.y, level });
    stipple(work, out, FIXED_SEED, 256); // one seed: the grain stays put, only the picture moves
    ctx.putImageData(image, 0, 0);
    const again = level !== target || dirty;
    dirty = false;
    if (again) frame = requestAnimationFrame(draw);
    else last = 0;
  };
  const kick = () => {
    if (!frame) frame = requestAnimationFrame(draw);
  };
  canvas.addEventListener('pointermove', (event) => {
    if (!ready) return;
    const box = canvas.getBoundingClientRect();
    cursor.x = ((event.clientX - box.left) / box.width) * ART_W;
    cursor.y = ((event.clientY - box.top) / box.height) * ART_H;
    target = 1;
    dirty = true;
    kick();
  });
  canvas.addEventListener('pointerleave', () => {
    if (!ready) return;
    target = 0;
    kick();
  });

  // Develop once, like a print in the tray: density rises, then the grain is left alone.
  const start = performance.now();
  const develop = (now) => {
    const t = Math.min(1, (now - start) / 1600);
    paint(Math.max(1, Math.round((1 - (1 - t) ** 3) * 256)));
    if (t < 1) {
      requestAnimationFrame(develop);
      return;
    }
    ready = true;
    kick(); // settle on the fixed seed so hovering never reshuffles the grain
  };
  requestAnimationFrame(develop);
  return true;
}
