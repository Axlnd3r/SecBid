/**
 * Focus reveal for headings, after scrolltide's "focus reveal": words sit
 * blurred until a camera-style focus frame travels to each one and pulls it
 * sharp. The frame stretches between word boxes — the edges on the side it is
 * heading leave first, the trailing edges follow — instead of jumping. Every
 * word box is measured, so any font, size or line wrap works.
 *
 * It runs once per heading. Words are only blurred after a script has split
 * them, so a page without JS (or with reduced motion) shows plain sharp text.
 *
 * `frameAt` is pure and tested from Node; the rest needs a DOM.
 */

const clamp01 = (t) => Math.min(1, Math.max(0, t));
const lerp = (a, b, t) => a + (b - a) * t;
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/**
 * The frame between two word boxes at progress t (0..1). Leading edges finish
 * by t = 0.62, trailing edges start at t = 0.38, so mid-flight the frame spans
 * both words. Width and height never go negative.
 */
export function frameAt(from, to, t) {
  const lead = ease(clamp01(t / 0.62));
  const trail = ease(clamp01((t - 0.38) / 0.62));
  const right = to.x >= from.x;
  const down = to.y >= from.y;
  const x1 = lerp(from.x, to.x, right ? trail : lead);
  const x2 = lerp(from.x + from.w, to.x + to.w, right ? lead : trail);
  const y1 = lerp(from.y, to.y, down ? trail : lead);
  const y2 = lerp(from.y + from.h, to.y + to.h, down ? lead : trail);
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

/** Wrap every word of `root` in a span, keeping nested elements and line breaks. */
export function splitWords(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const texts = [];
  while (walker.nextNode()) texts.push(walker.currentNode);
  const words = [];
  for (const node of texts) {
    if (!node.data.trim()) continue;
    const frag = document.createDocumentFragment();
    for (const part of node.data.split(/(\s+)/)) {
      if (!part) continue;
      if (!part.trim()) {
        frag.append(part);
        continue;
      }
      const span = document.createElement('span');
      span.className = 'fr-word';
      span.textContent = part;
      frag.append(span);
      words.push(span);
    }
    node.replaceWith(frag);
  }
  return words;
}

function boxOf(word, host, pad) {
  const r = word.getBoundingClientRect();
  const h = host.getBoundingClientRect();
  return { x: r.left - h.left - pad, y: r.top - h.top - pad * 0.5, w: r.width + pad * 2, h: r.height + pad };
}

/** Run the reveal on a host whose words were split. Resolves when the frame has left. */
export function focusReveal(host) {
  const words = Array.from(host.querySelectorAll('.fr-word'));
  const sharpenAll = () => {
    for (const w of words) w.classList.add('is-sharp');
  };
  if (words.length === 0) return Promise.resolve();

  return new Promise((resolve) => {
    let frame;
    try {
      const pad = parseFloat(getComputedStyle(host).fontSize) * 0.14;
      const boxes = words.map((w) => boxOf(w, host, pad));
      frame = document.createElement('span');
      frame.className = 'fr-frame';
      frame.setAttribute('aria-hidden', 'true');
      host.append(frame);
      const place = (b) => {
        frame.style.transform = `translate(${b.x}px, ${b.y}px)`;
        frame.style.width = `${b.w}px`;
        frame.style.height = `${b.h}px`;
      };

      const step = Math.min(300, Math.max(150, 1800 / words.length));
      place(boxes[0]);
      requestAnimationFrame(() => frame.classList.add('is-on'));
      setTimeout(() => words[0].classList.add('is-sharp'), 120);

      let i = 1;
      let t0 = performance.now() + 260; // dwell on the first word before moving
      const tick = (now) => {
        if (i >= words.length) {
          setTimeout(() => {
            frame.classList.remove('is-on');
            setTimeout(() => {
              frame.remove();
              resolve();
            }, 320);
          }, 360);
          return;
        }
        const t = clamp01((now - t0) / step);
        place(frameAt(boxes[i - 1], boxes[i], t));
        if (t > 0.55) words[i].classList.add('is-sharp');
        if (t >= 1) {
          i++;
          t0 = now;
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    } catch {
      // never leave a heading blurred because the animation failed
      sharpenAll();
      frame?.remove();
      resolve();
    }
  });
}

/**
 * Split each matching heading and reveal it the first time it is well inside
 * the viewport. With reduced motion or no IntersectionObserver, do nothing.
 */
export function armFocusReveal(hosts, { reduced = false } = {}) {
  if (reduced || !('IntersectionObserver' in window)) return;
  const armed = [];
  for (const host of hosts) {
    if (host.classList.contains('fr-host')) continue;
    if (splitWords(host).length === 0) continue;
    host.classList.add('fr-host', 'fr-armed');
    armed.push(host);
  }
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        observer.unobserve(entry.target);
        focusReveal(entry.target);
      }
    },
    { threshold: 0.6, rootMargin: '0px 0px -8% 0px' },
  );
  for (const host of armed) observer.observe(host);
}
