/**
 * Auction page controller.
 *
 * Everything here reads one public bundle from /api/auction/:slug and paints it.
 * There is no bid-amount code path, because the API never sends one — see the
 * whitelist in scripts/serve-web.ts.
 */

import { renderQR } from './qr.js';
import {
  b64ToBytes,
  buildMemo,
  bytesToB64,
  flipMemoPrice,
  verifyMemo,
} from './proofcheck.js';
import { verifyTranscript } from './transcript.js';
import { mountHeroArt } from './hero-art.js';
import { armFocusReveal } from './focus.js';

const ZAT_PER_ZEC = 100000000n;
const GROUP = new Intl.NumberFormat('en-US');

const CHECK_LABEL = {
  C1: 'published commitments',
  C2: 'merkle root',
  C3: 'inclusion proofs',
  C4: 'bidding window',
  C5: 'completeness',
  C6: 'funding privacy',
  C7: 'clearing recompute',
  C8: 'refund batch',
  C9: 'accounting identity',
  C10: 'ufvk commitment',
  C11: 'uniform price',
  C12: 'pool consistency',
  C13: 'auctioneer bond',
  C14: 'auditor transcript',
};

const OUTCOME_LABEL = {
  bid: 'Bid',
  winner: 'Winner',
  refunded: 'Refunded',
  unsold: 'Unsold',
  late: 'Late · refunded',
  dust: 'Below minimum · refunded',
  stranded: 'Stranded',
  transparent_funded: 'Transparent funding · rejected',
};

const TAMPER_LABEL = {
  't1-price': 'price edited after clearing',
  't2-truncate': 'one bid dropped from the table',
  't3-refund': 'a refund quietly omitted',
  't4-transparent': 'transparent-funded bid admitted',
  't5-two-prices': 'uniform winners pay different prices',
  't6-bond-spent': 'bond spent before the reveal window',
  't7-pool': 'account pool disagrees with the notes',
};

const WALLET_STEPS = {
  zashi: [
    'Open Zashi, choose Send, then scan the payment request above. The address and the memo field are filled for you.',
    'Set the amount to your bid. At or above the reserve it can win; below the minimum bid it is dusted and refunded.',
    'Replace the memo placeholder with a fresh shielded address you control, then confirm — the memo is the only refund path.',
  ],
  ywallet: [
    'Open YWallet and paste the payment URI into the address field of Send. YWallet parses zcash: and pre-fills the memo.',
    'Set the amount to your bid and check the fee tier; a slow transaction can land after the deadline.',
    'Verify the memo holds a brand-new refund address, then send. Reusing an address links your bids to each other.',
  ],
  zingo: [
    'In Zingo!, open the send screen and tap the scanner, or paste the address and memo separately.',
    'Enter your bid as the amount. The auction address is single-use per auction — do not reuse it for anything else.',
    'Confirm the memo is present before broadcasting. A payment without it is received but can never be refunded.',
  ],
};

const COPY_ICON =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M10.5 3.5v-1a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h1" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>';

const state = {
  auctions: [],
  bundle: null,
  filter: 'all',
  memoBytes: null,
  paymentUri: '',
  memoText: '',
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

/* ── small helpers ──────────────────────────────────────────────────────── */

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else node.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function toZat(value) {
  return typeof value === 'bigint' ? value : BigInt(value);
}

function zecString(zat, minFrac = 0) {
  const z = toZat(zat);
  const whole = z / ZAT_PER_ZEC;
  let frac = (z % ZAT_PER_ZEC).toString().padStart(8, '0').replace(/0+$/, '');
  while (frac.length < minFrac) frac += '0';
  const grouped = GROUP.format(Number(whole));
  return frac ? `${grouped}.${frac}` : grouped;
}

function zatString(zat) {
  return `${GROUP.format(Number(toZat(zat)))} zat`;
}

function short(hex, head = 8) {
  if (!hex) return '—';
  return `${hex.slice(0, head)}…${hex.slice(-6)}`;
}

function duration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

async function getJSON(path) {
  const res = await fetch(path, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  return res.json();
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = el('textarea', { style: 'position:fixed;opacity:0' });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

/* ── scroll chrome + focus reveal ───────────────────────────────────────── */

function initScrollChrome() {
  const bar = $('[data-progress]');
  const paint = () => {
    const root = document.documentElement;
    const max = root.scrollHeight - root.clientHeight;
    bar.style.width = `${(max > 0 ? clamp(root.scrollTop / max, 0, 1) : 0) * 100}%`;
  };
  addEventListener('scroll', paint, { passive: true });
  addEventListener('resize', paint);
  paint();
}

function armReveals() {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!('IntersectionObserver' in window) || reduced) return;

  document.documentElement.classList.add('reveal-armed');
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add('is-in');
        observer.unobserve(entry.target);
      }
    },
    { rootMargin: '0px 0px -6% 0px', threshold: 0.08 },
  );

  const seen = new Map();
  for (const node of $$('.reveal')) {
    const index = seen.get(node.parentElement) ?? 0;
    seen.set(node.parentElement, index + 1);
    node.style.setProperty('--d', `${Math.min(index * 70, 280)}ms`);
    observer.observe(node);
  }
}

/* ── hero ───────────────────────────────────────────────────────────────── */

function renderHero(bundle) {
  const { auction, settlement, chain, report } = bundle;
  const network = auction.network === 'test' ? 'testnet' : auction.network === 'main' ? 'mainnet' : auction.network;

  const phase =
    chain.tip_height < auction.deadline_height
      ? 'bidding open'
      : chain.tip_height < settlement.settle_height
        ? 'settling'
        : 'settled';
  const eyebrow = $('[data-eyebrow]');
  eyebrow.textContent = `auction ${short(auction.auction_id, 8)}`;
  eyebrow.title = auction.auction_id;
  $('[data-network]').textContent = network;
  $('[data-rule-note]').textContent = `${network} · ${phase}`;
  $('[data-auction-id]').textContent = auction.auction_id;
  $('[data-tip]').textContent = GROUP.format(chain.tip_height);
  $('[data-fact="price"]').textContent =
    settlement.result === 'sold' ? `${zecString(settlement.clearing_price_zat, 2)} ZEC` : 'unsold';
  $('[data-fact="entries"]').textContent = String(settlement.entries.length);

  const refunded = settlement.entries.filter((e) => e.refund_txid).length;
  $('[data-fact="refunds"]').textContent = `${refunded} in ${settlement.refund_txs.length} tx`;
  $('[data-fact="checks"]').textContent = `${report.checks.filter((c) => c.status === 'pass').length}/${report.checks.length}`;

  renderTerminal({
    slug: bundle.slug,
    kind: bundle.kind,
    auction_id: auction.auction_id,
    entries: settlement.entries.length,
    report,
  });
}

function termLine(parts, cls = '') {
  const line = el('span', { class: `term-line ${cls}`.trim() });
  for (const [text, extra] of parts) {
    line.append(text instanceof Node ? text : el('span', { class: extra ?? '', text }));
  }
  return line;
}

// Bumped on every paint so a typing animation from an earlier run stops
// instead of interleaving its lines with the new transcript.
let terminalRun = 0;

function renderTerminal(view) {
  const out = $('[data-terminal]');
  if (!out) return;
  out.replaceChildren();

  const { status, lines: parts } = verifyTranscript(view, CHECK_LABEL);
  const tag = $('[data-terminal-verdict]');
  tag.textContent = status;
  tag.dataset.verdict = status === 'PASS' ? 'pass' : status === 'PARTIAL' ? 'partial' : 'fail';
  $('[data-terminal-time]').textContent = `loaded ${new Date().toISOString().slice(11, 19)}Z`;

  const lines = parts.map((line) => termLine(line));
  const run = ++terminalRun;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let i = 0;
  const step = () => {
    if (run !== terminalRun || i >= lines.length) return;
    out.append(lines[i++]);
    out.scrollTop = out.scrollHeight;
    if (i < lines.length) setTimeout(step, reduced ? 0 : 55);
  };
  step();
}

/* ── bid ────────────────────────────────────────────────────────────────── */

// ZIP-321: the memo is base64url with `=` padding omitted; wallets must reject
// `+`, `/` and `=`. The proof-memo box keeps standard base64 (it is not a URI).
function paymentUri(auction, memoText) {
  const memo = new TextEncoder().encode(memoText);
  const b64url = bytesToB64(memo).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const params = new URLSearchParams();
  params.set('memo', b64url);
  return `zcash:${auction.address}?${params.toString()}`;
}

function refundPlaceholder(address) {
  const prefix = address.startsWith('utest1') ? 'utest1' : address.startsWith('uregtest1') ? 'uregtest1' : 'u1';
  return `${prefix}<your fresh shielded address>`;
}

function renderBid(bundle) {
  const { auction, settlement, chain } = bundle;
  const spec = auction.spec ?? auction.v ?? 1;

  const refund = refundPlaceholder(auction.address);
  state.memoText =
    spec === 2
      ? JSON.stringify({ v: 2, refund, qty: '1' })
      : JSON.stringify({ v: 1, refund });
  state.paymentUri = paymentUri(auction, state.memoText);

  $('[data-address]').textContent = auction.address;
  $('[data-memo]').textContent = state.memoText;
  $('[data-reserve]').textContent = `${zecString(auction.reserve_zat, 2)} ZEC`;
  $('[data-min-bid]').textContent = `${zecString(auction.min_bid_zat)} ZEC`;

  const qr = $('[data-qr]');
  try {
    renderQR(qr, state.paymentUri);
    qr.dataset.ready = 'true';
  } catch (err) {
    qr.replaceChildren(el('p', { class: 'mono small dim', text: `QR unavailable: ${err.message}` }));
  }

  const open = auction.opened_at_height ?? auction.created_at_height;
  const deadline = auction.deadline_height;
  const settle = settlement.settle_height;
  const tip = chain.tip_height;
  const ratio = clamp((tip - open) / Math.max(settle - open, 1), 0, 1);

  $('[data-open-height]').textContent = GROUP.format(open);
  $('[data-deadline]').textContent = GROUP.format(deadline);
  $('[data-settle-height]').textContent = GROUP.format(settle);

  let clock;
  if (tip < deadline) {
    clock = `${GROUP.format(deadline - tip)} blocks left · ≈ ${duration((deadline - tip) * chain.block_seconds)}`;
  } else if (tip < settle) {
    clock = 'closed · settling';
  } else {
    clock = 'settled';
  }
  $('[data-clock]').textContent = clock;
  const confirmations = auction.confirmations ?? auction.settle_depth;
  $('[data-countdown]').textContent =
    tip < deadline
      ? `bidding closes in ${duration((deadline - tip) * chain.block_seconds)} at ${chain.block_seconds}s per block`
      : `closed ${GROUP.format(tip - deadline)} blocks ago · settled at depth ${confirmations}`;

  requestAnimationFrame(() => {
    $('[data-bar]').style.width = `${(ratio * 100).toFixed(2)}%`;
  });

  renderParams(auction);
  renderWallets('zashi');
}

function renderParams(auction) {
  const spec = auction.spec ?? auction.v ?? 1;
  const rule = auction.rule ?? auction.clearing_rule ?? 'first-price';
  const units = auction.units ?? 1;
  const mode = auction.mode ?? 'public-tender';
  const pool = auction.pool ?? 'orchard';
  const bond = auction.bond;
  const rows = [
    ['auction id', auction.auction_id],
    ['spec', `v${spec}`],
    ['network', auction.network],
    ['address', auction.address],
    ['clearing rule', `${rule}${rule === 'uniform' ? ` · ${units} units` : ' · single lot'}`],
    ['pool', pool],
    ['mode', mode],
    ['reserve', `${zecString(auction.reserve_zat, 2)} ZEC${rule === 'uniform' ? ' / unit' : ''}`],
    ['min bid', `${zecString(auction.min_bid_zat)} ZEC`],
    ['bond', bond ? `${zecString(bond.amount_zat)} ZEC to ${short(bond.address, 12)}` : 'none'],
    ['deadline', `block ${GROUP.format(auction.deadline_height)}`],
    ['confirmations', `${auction.confirmations ?? auction.settle_depth} blocks`],
    ['opened at', `block ${GROUP.format(auction.opened_at_height ?? auction.created_at_height)}`],
    ['params hash', short(auction.params_hash, 16)],
  ];
  if (auction.pool_warning) rows.push(['pool warning', auction.pool_warning]);
  const dl = $('[data-params]');
  dl.replaceChildren();
  for (const [name, value] of rows) {
    dl.append(el('dt', { text: name }), el('dd', { text: value, title: String(value) }));
  }
  const note = $('[data-fresh-note]');
  if (note) {
    note.textContent =
      spec === 2
        ? 'Use a fresh shielded address in the memo for every bid, and set qty only if this is a multi-unit auction. A reused address links your bids to each other and is flagged in the quantum report.'
        : 'Use a fresh shielded address in the memo for every bid. A reused address links your bids to each other.';
  }
}

function renderWallets(wallet) {
  const steps = $('[data-wallet-steps]');
  steps.replaceChildren(...WALLET_STEPS[wallet].map((text) => el('li', { text })));
  for (const tab of $$('[data-wallet]')) {
    tab.setAttribute('aria-pressed', String(tab.dataset.wallet === wallet));
  }
}

/* ── result ─────────────────────────────────────────────────────────────── */

function renderResult(bundle) {
  const { settlement } = bundle;
  const sold = settlement.result === 'sold';
  const uniform = settlement.rule === 'uniform';
  const units = Number(settlement.units ?? 1);
  const winners = settlement.entries.filter((e) => e.outcome === 'winner');

  $('[data-result-headline]').textContent = !sold
    ? 'No bid met the reserve. Every eligible note was refunded.'
    : uniform
      ? `${units} unit${units === 1 ? '' : 's'} cleared at ${zecString(settlement.clearing_price_zat, 2)} ZEC each.`
      : `One sealed bid cleared at ${zecString(settlement.clearing_price_zat, 2)} ZEC.`;

  const price = $('[data-price]');
  if (sold) {
    price.replaceChildren(
      document.createTextNode(zecString(settlement.clearing_price_zat, 2)),
      el('span', { class: 'unit', text: ' ZEC' }),
    );
  } else {
    price.textContent = '—';
  }
  $('[data-price-zat]').textContent = sold
    ? `${zatString(settlement.clearing_price_zat)} · ${uniform ? 'uniform price per unit' : 'first price'}`
    : 'nothing retained';
  $('[data-result-tag]').textContent = settlement.result;
  const priceRule = $('[data-price-rule]');
  if (priceRule) {
    priceRule.textContent = uniform
      ? `uniform price · ${settlement.units} units sold`
      : 'first price · highest eligible bid';
  }

  const winnerList = $('[data-winners]');
  if (winnerList) {
    winnerList.replaceChildren();
    for (const winner of winners) {
      winnerList.append(
        el('li', {}, [
          el('span', { class: 'mono small trunc', text: short(winner.leaf, 16), title: winner.leaf }),
          el('b', {
            text: `filled ${winner.filled_qty ?? 1}/${winner.qty ?? 1} · pays ${zatString(
              winner.payment_zat ?? settlement.clearing_price_zat,
            )}`,
          }),
        ]),
      );
    }
    if (winners.length === 0) winnerList.append(el('li', { class: 'dim', text: 'no winners' }));
  }

  const a = settlement.accounting;
  const rows = [
    ['retained', uniform ? 'Retained across winners' : 'Retained as clearing price', a.retained_zat],
    ['refunded', 'Refunded in the batch', a.refunded_zat],
    ['fees', 'Network fees', a.fees_zat],
    ['stranded', 'Stranded · never published', null],
  ];
  const scale = Math.max(Number(a.retained_zat), Number(a.refunded_zat), Number(a.fees_zat), 1);
  const stack = $('[data-accounting]');
  stack.replaceChildren();
  for (const [kind, label, value] of rows) {
    const fill = el('span');
    stack.append(
      el(
        'li',
        { class: 'acct-row', 'data-kind': kind },
        el(
          'header',
          {},
          el('span', { text: label }),
          el('b', { text: value === null ? '—' : `${zecString(value, 2)} ZEC` }),
        ),
        el('div', { class: 'acct-bar' }, fill),
      ),
    );
    requestAnimationFrame(() => {
      const amount = value === null ? 0 : Number(value);
      fill.style.width = value === null ? '0%' : `${Math.max((amount / scale) * 100, amount > 0 ? 2 : 0)}%`;
    });
  }

  $('[data-root]').textContent = settlement.merkle_root;
  const winning = settlement.winning_leaves ?? (settlement.winning_leaf ? [settlement.winning_leaf] : []);
  $('[data-winner]').textContent = winning.length > 1
    ? `${winning[0]}  (+${winning.length - 1} more)`
    : winning[0] ?? 'no winner: unsold';
  $('[data-commit-params]').textContent = short(bundle.commitments?.params_hash ?? bundle.auction.params_hash, 20);
  $('[data-commit-settlement]').textContent = short(bundle.commitments?.settlement_hash ?? '—', 20);
  $('[data-commit-note]').textContent = `params_hash · settlement_hash (published at open / at settlement)`;

  const tx = settlement.refund_txs[0];
  $('[data-refund-tx]').textContent = tx ? `${short(tx.txid, 16)}` : 'no refunds needed';
  const heights = [...new Set(settlement.refund_txs.map((t) => t.height))];
  $('[data-refund-note]').textContent = tx
    ? `height ${heights.join(', ')} · ${settlement.refund_txs.length} transaction${settlement.refund_txs.length === 1 ? '' : 's'}`
    : 'nothing to refund';
}

/* ── entries ────────────────────────────────────────────────────────────── */

function renderEntries(bundle) {
  const { settlement } = bundle;
  const counts = new Map();
  for (const entry of settlement.entries) {
    counts.set(entry.outcome, (counts.get(entry.outcome) ?? 0) + 1);
  }

  const filters = $('[data-filters]');
  filters.replaceChildren();
  const options = [['all', `all ${settlement.entries.length}`], ...Array.from(counts, ([k, v]) => [k, `${k} ${v}`])];
  for (const [key, label] of options) {
    const chip = el('button', {
      class: 'chip',
      type: 'button',
      text: label,
      'aria-pressed': String(state.filter === key),
      'data-filter': key,
    });
    filters.append(chip);
  }

  const tbody = $('[data-entries]');
  tbody.replaceChildren();

  const visible = settlement.entries.filter((e) => state.filter === 'all' || e.outcome === state.filter);
  $('[data-table-count]').textContent = `${visible.length} of ${settlement.entries.length} entries`;

  for (const [index, entry] of settlement.entries.entries()) {
    if (state.filter !== 'all' && entry.outcome !== state.filter) continue;

    const copy = el('button', {
      type: 'button',
      'data-copy': 'leaf',
      'data-leaf': entry.leaf,
      title: 'Copy leaf',
      'aria-label': `Copy leaf ${entry.leaf}`,
    });
    copy.innerHTML = COPY_ICON;

    tbody.append(
      el(
        'tr',
        {},
        el('td', { class: 'row-idx', text: String(index + 1) }),
        el(
          'td',
          {},
          el(
            'div',
            { class: 'leaf-cell' },
            el('span', { class: 'trunc', text: short(entry.leaf, 14), title: entry.leaf }),
            copy,
          ),
        ),
        el('td', { class: 'height-cell', text: GROUP.format(entry.height) }),
        el('td', { class: 'height-cell', text: String(entry.qty ?? 1) }),
        el('td', {
          class: 'height-cell',
          text: entry.outcome === 'winner' ? `${entry.filled_qty ?? 1}/${entry.qty ?? 1}` : '—',
        }),
        el('td', {}, el('span', { class: 'pill', 'data-outcome': entry.outcome, text: entry.outcome })),
        el('td', { class: 'tx-cell', text: short(entry.txid, 8), title: entry.txid }),
        el('td', {
          class: 'tx-cell',
          text: entry.refund_txid ? short(entry.refund_txid, 8) : '—',
          title: entry.refund_txid ?? '',
        }),
      ),
    );
  }

  $('[data-entries-empty]').hidden = visible.length > 0;
}

/* ── verify ─────────────────────────────────────────────────────────────── */

function artifactLabel(auction) {
  return auction.kind === 'honest'
    ? `${auction.slug} — honest settlement`
    : `${auction.slug} — ${TAMPER_LABEL[auction.slug] ?? 'tampered'}`;
}

function buildArtifactSelect() {
  const select = $('[data-artifact-select]');
  select.replaceChildren();
  const current = state.bundle?.slug;
  for (const auction of state.auctions) {
    select.append(
      el('option', {
        value: auction.slug,
        text: artifactLabel(auction),
        selected: auction.slug === current || undefined,
      }),
    );
  }
}

function renderReport(report, meta) {
  const failed = report.checks.filter((c) => c.status === 'fail');
  const passed = report.checks.filter((c) => c.status === 'pass').length;
  const skipped = report.checks.filter((c) => c.status === 'skip').length;

  const status = report.status ?? (report.ok ? 'PASS' : 'FAIL');
  const verdict = $('[data-verdict]');
  verdict.dataset.state = status === 'PASS' ? 'pass' : status === 'PARTIAL' ? 'partial' : 'fail';
  $('[data-verdict-mark]').textContent = status;
  $('[data-verdict-title]').textContent = status === 'FAIL'
    ? `FAIL — ${failed[0].code}: ${failed[0].detail ?? failed[0].message}`
    : status === 'PARTIAL'
      ? `PARTIAL — ${skipped} check(s) need a viewing key the published bundle does not carry`
      : `PASS — no check failed (${passed}/${report.checks.length})`;
  $('[data-verdict-detail]').textContent =
    `${meta.label} · ${report.mode} mode · ${passed} pass / ${failed.length} fail / ${skipped} skip`;

  const list = $('[data-checks]');
  list.replaceChildren();
  for (const check of report.checks) {
    list.append(
      el(
        'li',
        { class: `check is-${check.status}` },
        el(
          'div',
          { class: 'check-head' },
          el('span', { class: 'check-code', text: `${check.code} · ${CHECK_LABEL[check.code] ?? ''}` }),
          el('span', { class: 'check-status', text: check.status }),
        ),
        el('p', { class: 'check-detail', text: check.detail ?? 'no detail' }),
      ),
    );
  }

  $('[data-verify-hint]').textContent =
    report.mode === 'audit'
      ? 'audit mode has no chain view: C5–C10, C12, C13 skip. PARTIAL is the honest verdict; fixture mode runs them all.'
      : 'fixture mode replays the recorded chain view, so C1–C13 run on the server. C14 needs the auditor OVK and skips for a public reader.';

  if (meta.auction) {
    renderTerminal({
      slug: meta.auction.slug,
      kind: meta.auction.kind,
      auction_id: meta.auction.auction_id,
      entries: meta.auction.entries,
      report,
    });
  }
}

async function runVerifier(slug) {
  const mode = $('[data-mode-select]').value;
  const select = $('[data-artifact-select]');
  select.disabled = true;
  try {
    const { report } = await getJSON(
      `/api/auction/${encodeURIComponent(slug)}/report?mode=${encodeURIComponent(mode)}`,
    );
    const meta = state.auctions.find((a) => a.slug === slug);
    renderReport(report, { label: meta ? artifactLabel(meta) : slug, auction: meta });
  } catch (err) {
    $('[data-verdict]').dataset.state = 'fail';
    $('[data-verdict-mark]').textContent = 'ERR';
    $('[data-verdict-title]').textContent = 'Verifier unavailable';
    $('[data-verdict-detail]').textContent = err.message;
  } finally {
    select.disabled = false;
  }
}

/* ── proof ──────────────────────────────────────────────────────────────── */

function renderProofResult(result) {
  const panel = $('[data-proof-result]');
  const facts = $('[data-proof-facts]');
  const problems = $('[data-proof-problems]');
  const verdict = $('[data-proof-verdict]');

  panel.dataset.state = result.ok ? 'pass' : 'fail';
  verdict.textContent = result.ok ? 'OK — proof matches' : 'MISMATCH';

  facts.replaceChildren();
  if (result.decoded) {
    const d = result.decoded;
    const rows = [
      ['leaf', short(d.leaf, 12)],
      ['outcome', OUTCOME_LABEL[d.outcome] ?? d.outcome],
      ['clearing price', `${zecString(d.clearing_price_zat, 2)} ZEC`],
      ['merkle path', `${d.path.length} levels`],
      ['root', short(d.root, 10)],
    ];
    for (const [key, value] of rows) {
      facts.append(el('li', {}, el('span', { text: key }), el('b', { text: value, title: value })));
    }
  }

  problems.hidden = result.problems.length === 0;
  problems.textContent = result.problems.map((p) => `problem: ${p}`).join('\n');
}

async function runMemoCheck() {
  const raw = $('[data-memo-input]').value.trim();
  if (!raw) {
    $('[data-proof-verdict]').textContent = 'paste a memo first';
    $('[data-proof-result]').dataset.state = '';
    return;
  }
  try {
    const bytes = b64ToBytes(raw);
    state.memoBytes = bytes;
    const result = await verifyMemo(bytes, state.bundle.settlement);
    renderProofResult(result);
  } catch (err) {
    renderProofResult({ ok: false, decoded: null, problems: [err.message] });
  }
}

function loadSampleMemo() {
  const leaf = $('[data-leaf-select]').value;
  const settlement = state.bundle.settlement;
  const entry = settlement.entries.find((e) => e.leaf === leaf);
  const path = state.bundle.proofs?.[leaf];
  if (!entry || !path) {
    $('[data-proof-verdict]').textContent = 'no published proof for this leaf';
    return;
  }
  const bytes = buildMemo({
    leaf,
    root: settlement.merkle_root,
    outcome: entry.outcome,
    clearing_price_zat: Number(settlement.clearing_price_zat),
    path,
  });
  state.memoBytes = bytes;
  $('[data-memo-input]').value = bytesToB64(bytes);
  runMemoCheck();
}

function renderProofPanel(bundle) {
  const select = $('[data-leaf-select]');
  select.replaceChildren();
  for (const entry of bundle.settlement.entries) {
    select.append(
      el('option', {
        value: entry.leaf,
        text: `${short(entry.leaf, 10)} · ${OUTCOME_LABEL[entry.outcome] ?? entry.outcome}`,
      }),
    );
  }
  $('[data-memo-input]').value = '';
  $('[data-proof-verdict]').textContent = 'waiting for a memo';
  $('[data-proof-result]').dataset.state = '';
  $('[data-proof-facts]').replaceChildren();
  $('[data-proof-problems]').hidden = true;
}

/* ── quantum ────────────────────────────────────────────────────────────── */

function renderQuantum(quantum) {
  const pooled = $('[data-quantum-pool]');
  if (!pooled) return;
  if (!quantum) {
    pooled.textContent = 'no quantum.json';
    $('[data-quantum-notes]').textContent = '—';
    $('[data-quantum-recoverable]').textContent = '—';
    $('[data-quantum-reuse]').textContent = '—';
    $('[data-quantum-published]').replaceChildren(el('dt', { text: 'not generated' }));
    $('[data-quantum-exposed]').replaceChildren(
      el('li', { text: 'Run `secbid quantum-report <dir>` to publish the exposure report.' }),
    );
    $('[data-quantum-disclaimer]').textContent =
      'Quantum-recoverable ≠ post-quantum. Privacy of revealed data is not protected against a future discrete-log-breaking adversary.';
    return;
  }

  pooled.textContent = quantum.pool?.warning
    ? `${quantum.pool.auction} · fallback`
    : quantum.pool?.auction ?? '—';
  $('[data-quantum-notes]').textContent = quantum.notes?.observed
    ? String(quantum.notes.total)
    : 'no viewing key';
  $('[data-quantum-recoverable]').textContent = quantum.notes?.observed
    ? `${quantum.notes.recoverable}/${quantum.notes.total}`
    : '—';
  $('[data-quantum-reuse]').textContent = `${quantum.refund_reuse?.duplicated_in_auction ?? 0} in-auction · ${quantum.refund_reuse?.reused_across_auctions ?? 0} across`;

  const published = $('[data-quantum-published]');
  published.replaceChildren();
  for (const item of quantum.published ?? []) {
    published.append(
      el('dt', { text: item.kind }),
      el('dd', { text: short(item.value, 22), title: `${item.value} — ${item.note}` }),
    );
  }
  if ((quantum.published ?? []).length === 0) published.append(el('dt', { text: 'nothing published' }));

  const exposed = $('[data-quantum-exposed]');
  exposed.replaceChildren(...(quantum.exposed ?? []).map((text) => el('li', { text })));
  $('[data-quantum-disclaimer]').textContent = quantum.disclaimer ?? 'Quantum-recoverable ≠ post-quantum.';
}

/* ── wiring ─────────────────────────────────────────────────────────────── */

function wireOnce() {
  document.addEventListener('click', async (event) => {
    const copyBtn = event.target.closest('[data-copy]');
    if (copyBtn) {
      const key = copyBtn.dataset.copy;
      let value = copyBtn.dataset.leaf ?? '';
      if (key !== 'leaf') {
        const b = state.bundle;
        value = {
          address: b?.auction.address,
          uri: state.paymentUri,
          memo: state.memoText,
          root: b?.settlement.merkle_root,
          winner: b?.settlement.winning_leaf ?? '',
        }[key];
      }
      if (!value) return;
      const ok = await copyText(value);
      const status = $('[data-copy-status]');
      if (status) status.textContent = ok ? 'copied to clipboard' : 'copy failed — select the text manually';
      if (copyBtn.classList.contains('link-btn')) {
        copyBtn.dataset.label ??= copyBtn.textContent;
        copyBtn.textContent = ok ? 'copied' : 'failed';
        setTimeout(() => {
          copyBtn.textContent = copyBtn.dataset.label;
        }, 1400);
      } else {
        copyBtn.dataset.copied = String(ok);
      }
      return;
    }

    const chip = event.target.closest('[data-filter]');
    if (chip) {
      state.filter = chip.dataset.filter;
      renderEntries(state.bundle);
      return;
    }

    const tab = event.target.closest('[data-wallet]');
    if (tab) {
      renderWallets(tab.dataset.wallet);
      return;
    }

    if (event.target.closest('[data-check-memo]')) return runMemoCheck();
    if (event.target.closest('[data-sample-memo]')) return loadSampleMemo();

    if (event.target.closest('[data-tamper-memo]')) {
      const textarea = $('[data-memo-input]');
      if (!textarea.value.trim()) loadSampleMemo();
      const bytes = state.memoBytes ?? b64ToBytes(textarea.value.trim() || '');
      const flipped = flipMemoPrice(bytes);
      state.memoBytes = flipped;
      textarea.value = bytesToB64(flipped);
      return runMemoCheck();
    }
  });

  $('[data-artifact-select]').addEventListener('change', (event) => {
    runVerifier(event.target.value);
  });
  $('[data-mode-select]').addEventListener('change', () => {
    runVerifier($('[data-artifact-select]').value);
  });
  $('[data-run-verify]').addEventListener('click', () => {
    runVerifier($('[data-artifact-select]').value);
  });
}

/* ── boot ───────────────────────────────────────────────────────────────── */

async function boot() {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  armReveals();
  initScrollChrome();
  wireOnce();
  mountHeroArt($('[data-hero-art]'), { reduced });
  // The h1 is static; section headings wait until render, because one of them is filled in.
  armFocusReveal($$('[data-focus]'), { reduced });

  const params = new URLSearchParams(location.search);
  const requested = params.get('a');
  // `?tip=` moves the chain tip the countdown is measured from. It has to be
  // forwarded to the API, which is the only side that knows a tip at all.
  const tip = Number(params.get('tip'));
  const tipQuery = Number.isSafeInteger(tip) && tip > 0 ? `?tip=${tip}` : '';
  try {
    const { auctions } = await getJSON('/api/auctions');
    state.auctions = auctions;
  } catch (err) {
    $('[data-terminal]').textContent = `cannot reach the API: ${err.message}`;
    return;
  }
  if (state.auctions.length === 0) {
    $('[data-terminal]').textContent = 'no auctions found in fixtures/';
    return;
  }

  const honest = state.auctions.find((a) => a.kind === 'honest');
  const slug = state.auctions.some((a) => a.slug === requested) ? requested : honest?.slug ?? state.auctions[0].slug;

  try {
    state.bundle = await getJSON(`/api/auction/${encodeURIComponent(slug)}${tipQuery}`);
  } catch (err) {
    $('[data-terminal]').textContent = `cannot load ${slug}: ${err.message}`;
    return;
  }

  const bundle = state.bundle;
  document.title = `Secbid — auction ${bundle.auction.auction_id}`;

  renderHero(bundle);
  renderBid(bundle);
  renderResult(bundle);
  renderEntries(bundle);
  buildArtifactSelect();
  renderReport(bundle.report, { label: artifactLabel(state.auctions.find((a) => a.slug === bundle.slug)) });
  renderProofPanel(bundle);
  renderQuantum(bundle.quantum);
  armFocusReveal($$('.section-head h2'), { reduced });
}

boot();
