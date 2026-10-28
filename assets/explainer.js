/*
 * "What is Secbid" on the landing page: the real testnet-01 run told in four scenes, seen through
 * three lenses (the public, the auctioneer, one bidder). Pure DOM + SVG; no inline style (CSP).
 */
import { BIDS, RUN } from './explainer-data.js';

const NS = 'http://www.w3.org/2000/svg';
const Y = (i) => 62 + i * 62;
const VAULT = { x: 410, y: 140, w: 170, h: 150 };
const OUT = {
  winner: `won · pays ${RUN.price}`,
  refunded: 'lost · refunded',
  dust: 'too small · refunded',
  late: 'too late · refunded',
};

const SCENES = [
  {
    title: 'Open',
    text: `The seller opens an auction: one shielded Zcash address, a reserve (${RUN.reserve} ZEC), ${RUN.units} units, a uniform-price rule and a deadline block. The rules are hashed when the auction opens, so they cannot change later.`,
  },
  {
    title: 'Bid',
    text: 'Each bid is just a shielded payment to that address. Its encrypted memo holds a fresh refund address. On chain there is no sender, no amount, and nothing linking one bidder to another.',
  },
  {
    title: 'Settle',
    text: `After the deadline the auctioneer reads the bids with its viewing key and clears the price: the top three bids win and all pay ${RUN.price} ZEC. Every loser, the too-small bid and the late bid get their money back in one batched shielded transaction (${RUN.refundOutputs} outputs, winners' change included). The auctioneer sees amounts, never senders.`,
  },
  {
    title: 'Verify',
    text: `The auctioneer publishes its viewing key and a Merkle root. Anyone can rescan the chain and recompute the same result: ${RUN.checks} checks, PASS. Each bidder finds a proof in their refund memo that their bid was counted. Identities are still never revealed.`,
  },
];

const LENSES = {
  public: 'The public sees shielded transactions arrive, but no names, no sender addresses and, until settlement, no amounts.',
  auctioneer: 'The auctioneer can read amounts and refund addresses with its viewing key, but not who sent them. A bid is a note, not a person.',
  you: 'You are Bidder A. You know your own bid, and your refund memo proves it was counted. You never learn who the others are.',
};

function el(name, attrs = {}, text) {
  const node = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text != null) node.textContent = text;
  return node;
}

function envelope(cls) {
  const g = el('g', { class: `xp-env ${cls}` });
  g.append(el('rect', { x: -13, y: -9, width: 26, height: 18, rx: 2 }), el('path', { d: 'M-13 -9 L0 2 L13 -9' }));
  return g;
}

function buildStage(svg) {
  svg.setAttribute('viewBox', '0 0 960 450');
  const paths = el('g', { class: 'xp-paths' });
  const bidders = el('g');
  const envs = el('g');
  svg.append(paths, bidders);

  // the auction address
  const vault = el('g', { class: 'xp-vault' });
  vault.append(
    el('rect', { x: VAULT.x, y: VAULT.y, width: VAULT.w, height: VAULT.h, rx: 6 }),
    el('text', { x: VAULT.x + VAULT.w / 2, y: VAULT.y + 26, class: 'xp-k' }, 'auction address'),
    el('text', { x: VAULT.x + VAULT.w / 2, y: VAULT.y + 46, class: 'xp-dim' }, 'shielded · Orchard'),
    el('text', { x: VAULT.x + VAULT.w / 2, y: VAULT.y + 136, class: 'xp-dim', 'data-vault-count': '' }, ''),
  );
  const price = el('g', { class: 'xp-price', 'data-show': '3' });
  price.append(
    el('rect', { x: VAULT.x - 20, y: VAULT.y - 52, width: VAULT.w + 40, height: 36, rx: 18 }),
    el('text', { x: VAULT.x + VAULT.w / 2, y: VAULT.y - 29 }, `price ${RUN.price} ZEC / unit`),
  );

  // the auctioneer and its committed rules
  const auc = el('g', { class: 'xp-auc' });
  auc.append(
    el('circle', { cx: 830, cy: 210, r: 30 }),
    el('text', { x: 830, y: 218, class: 'xp-glyph' }, '⚖'),
    el('text', { x: 830, y: 266, class: 'xp-k' }, 'auctioneer'),
    el('text', { x: 830, y: 284, class: 'xp-dim', 'data-auc-note': '' }, ''),
  );
  const rules = el('g', { class: 'xp-rules', 'data-show': '1' });
  rules.append(el('rect', { x: 720, y: 30, width: 220, height: 104, rx: 4 }));
  [`reserve ${RUN.reserve} ZEC`, `${RUN.units} units · uniform price`, 'deadline: a block height', 'params_hash committed'].forEach((t, i) =>
    rules.append(el('text', { x: 736, y: 56 + i * 22, class: `xp-left${i === 3 ? ' xp-dim' : ''}` }, t)));

  // anyone, verifying
  const anyone = el('g', { class: 'xp-anyone', 'data-show': '4' });
  anyone.append(
    el('rect', { x: 690, y: 330, width: 250, height: 92, rx: 4 }),
    el('text', { x: 706, y: 356, class: 'xp-k xp-left' }, 'anyone · rescans the chain'),
    el('text', { x: 706, y: 388, class: 'xp-pass xp-left' }, `PASS ${RUN.checks}/${RUN.checks}`),
    el('text', { x: 706, y: 410, class: 'xp-dim xp-left' }, 'same price · same winners'),
  );
  svg.append(
    el('path', { d: `M800 210 L${VAULT.x + VAULT.w} 210`, class: 'xp-link' }),
    el('path', { d: `M${VAULT.x + VAULT.w} 250 C640 300 650 360 690 372`, class: 'xp-link xp-hide', 'data-show': '4' }),
    vault, price, auc, rules, anyone, envs,
  );

  return BIDS.map((bid, i) => {
    const y = Y(i);
    const g = el('g', { class: 'xp-bidder' });
    g.append(
      el('circle', { cx: 70, cy: y, r: 18 }),
      el('text', { x: 70, y: y + 5, class: 'xp-glyph' }, '?'),
      el('text', { x: 100, y: y - 3, class: 'xp-name xp-left' }, ''),
      el('text', { x: 100, y: y + 15, class: 'xp-dim xp-left xp-out' }, ''),
    );
    bidders.append(g);
    const bend = 186 + i * 9;
    paths.append(el('path', { d: `M100 ${y} C260 ${y} 300 ${bend} ${VAULT.x} ${bend}`, class: 'xp-path' }));
    const bidEnv = envelope('xp-bid');
    const refundEnv = envelope('xp-refund');
    envs.append(bidEnv, refundEnv);
    const refunds = bid.outcome !== 'winner' || Number(bid.zec) > Number(RUN.price);
    return { bid, g, y, bidEnv, refundEnv, refunds };
  });
}

function place(node, x, y, delay = 0) {
  node.style.transitionDelay = `${delay}ms`;
  node.style.transform = `translate(${x}px, ${y}px)`;
}

function chainLine(scene) {
  const cells = [];
  if (scene === 1) cells.push('<span>auction opened · params committed</span>');
  if (scene >= 2) for (const b of BIDS) cells.push(`<span title="${b.txid}">shielded tx ${b.txid.slice(0, 6)}… · sender — · amount —</span>`);
  if (scene >= 3) cells.push(`<span class="hl" title="${RUN.refundTx}">refund tx ${RUN.refundTx.slice(0, 6)}… · ${RUN.refundOutputs} outputs</span>`);
  if (scene >= 4) cells.push('<span class="hl">viewing key + Merkle root published</span>');
  return `<em>What the chain shows, to everyone</em>${cells.join('')}`;
}

function init(root) {
  const svg = root.querySelector('[data-stage]');
  const rows = buildStage(svg);
  const steps = [...root.querySelectorAll('[data-scene]')];
  const lenses = [...root.querySelectorAll('[data-lens]')];
  const caption = root.querySelector('[data-caption]');
  const lensNote = root.querySelector('[data-lens-note]');
  const chain = root.querySelector('[data-chain]');
  const play = root.querySelector('[data-play]');
  const state = { scene: 1, lens: 'public', timer: 0 };

  function render() {
    const { scene, lens } = state;
    steps.forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.scene) === scene)));
    lenses.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.lens === lens)));
    const s = SCENES[scene - 1];
    caption.innerHTML = `<b>${scene}. ${s.title}.</b> ${s.text}`;
    lensNote.textContent = LENSES[lens];
    svg.querySelectorAll('[data-show]').forEach((n) => n.classList.toggle('xp-on', scene >= Number(n.dataset.show)));

    // amounts: the auctioneer reads them with the viewing key; the public only once it is published
    const amountsOpen = scene >= 2 && (lens === 'auctioneer' || (lens === 'public' && scene >= 4));
    rows.forEach((r, i) => {
      const mine = lens === 'you' && i === 0;
      let name = mine ? 'Bidder A (you)' : lens === 'auctioneer' || amountsOpen ? `note #${i + 1} · sender unknown` : 'unknown';
      if (scene >= 2) name += mine || amountsOpen ? ` · ${r.bid.zec} ZEC` : ' · amount hidden';
      r.g.querySelector('.xp-name').textContent = name;
      r.g.querySelector('.xp-glyph').textContent = mine ? 'A' : '?';
      r.g.classList.toggle('xp-me', mine);
      const knows = scene >= 3 && (lens !== 'you' || mine || scene >= 4);
      r.g.querySelector('.xp-out').textContent = knows ? OUT[r.bid.outcome] + (scene >= 4 ? ' · proof ✓' : '') : scene >= 2 ? 'bid sent' : '';
      r.g.classList.toggle('xp-win', knows && r.bid.outcome === 'winner');
      r.g.classList.toggle('xp-lost', knows && r.bid.outcome !== 'winner');

      // each bid flies into the address; the late one lands after the others
      const late = r.bid.outcome === 'late';
      if (scene >= 2) place(r.bidEnv, VAULT.x + 34 + (i % 3) * 51, VAULT.y + 70 + (i < 3 ? 0 : 30), late ? 1100 : i * 150);
      else place(r.bidEnv, 100, r.y);
      r.bidEnv.classList.toggle('xp-late', late && scene >= 2);
      // refunds fly back together, in one batch
      r.refundEnv.classList.toggle('xp-in', r.refunds && scene >= 3);
      if (r.refunds && scene >= 3) place(r.refundEnv, 46, r.y - 20, 400);
      else place(r.refundEnv, VAULT.x + VAULT.w / 2, VAULT.y + VAULT.h / 2);
    });
    svg.querySelector('[data-vault-count]').textContent = scene >= 2 ? `${BIDS.length} sealed notes` : 'waiting for bids';
    svg.querySelector('[data-auc-note]').textContent = scene >= 3 ? 'sees amounts, not senders' : 'known, accountable seller';
    chain.innerHTML = chainLine(scene);
  }

  function go(scene) {
    state.scene = ((scene - 1 + SCENES.length) % SCENES.length) + 1;
    render();
  }
  function stop() {
    clearInterval(state.timer);
    state.timer = 0;
    play.textContent = '▶ Play';
  }
  function start() {
    stop();
    state.timer = setInterval(() => go(state.scene + 1), 8000);
    play.textContent = '❚❚ Pause';
  }

  steps.forEach((b) => b.addEventListener('click', () => { stop(); go(Number(b.dataset.scene)); }));
  lenses.forEach((b) => b.addEventListener('click', () => { state.lens = b.dataset.lens; render(); }));
  play.addEventListener('click', () => (state.timer ? stop() : start()));
  root.querySelector('[data-next]').addEventListener('click', () => { stop(); go(state.scene + 1); });
  render();

  // plays itself once it scrolls into view, unless the reader prefers no motion
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches && 'IntersectionObserver' in window) {
    const seen = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { start(); seen.disconnect(); }
    }, { threshold: 0.4 });
    seen.observe(svg);
  }
}

const root = document.querySelector('[data-explain]');
if (root) init(root);
