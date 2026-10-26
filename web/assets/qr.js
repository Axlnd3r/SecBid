/**
 * QR rendering, on top of the vendored encoder in ../vendor/uqr.mjs.
 *
 * Rendered as a single path of horizontal runs: one DOM node, no canvas, and it
 * stays crisp at any size because the viewBox is in module units. The quiet zone
 * is part of the encoded matrix (border: 4) rather than CSS padding, so it
 * survives a zoom.
 */

import { encode } from '../vendor/uqr.mjs';

const SVG_NS = 'http://www.w3.org/2000/svg';
const MODULE_INK = '#000000';

export function renderQR(target, text, { ecc = 'M', border = 4 } = {}) {
  const { size, data } = encode(text, { ecc, border });

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('role', 'img');

  let d = '';
  for (let y = 0; y < size; y++) {
    let x = 0;
    while (x < size) {
      if (!data[y][x]) {
        x++;
        continue;
      }
      const start = x;
      while (x < size && data[y][x]) x++;
      d += `M${start} ${y}h${x - start}v1H${start}z`;
    }
  }

  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', d);
  path.setAttribute('fill', MODULE_INK);
  svg.appendChild(path);

  target.replaceChildren(svg);
  return { size };
}
