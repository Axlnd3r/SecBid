/*
 * Secbid sandbox: the page drives src/sandbox.ts (served as browser JS under /lib/), which runs the
 * same open → settle → refund → verify path as the CLI on a simulated chain.
 */
import { checkProofMemo, openSandbox, runSandbox } from '../lib/sandbox.js';
import { renderQR } from './qr.js';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const short = (hex) => `${hex.slice(0, 10)}…${hex.slice(-6)}`;
const zec = (zat) => {
  const z = BigInt(zat);
  const frac = String(z % 100000000n).padStart(8, '0').replace(/0+$/, '');
  return `${z / 100000000n}${frac ? `.${frac}` : ''}`;
};

const EXAMPLE = [
  { name: 'Alice', amount: '0.14' },
  { name: 'Bob', amount: '0.12' },
  { name: 'Carol', amount: '0.11' },
  { name: 'Dave', amount: '0.10' },
  { name: 'Erin', amount: '0.04' },
  { name: 'Frank', amount: '0.13', late: true },
];

const state = { auction: null, bids: [], run: null, seed: '' };

function show(step) {
  const el = $(`[data-step="${step}"]`);
  el.hidden = false;
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* ---------- 1. open ---------- */
$('[data-open]').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  state.seed = crypto.randomUUID();
  state.auction = {
    rule: f.get('rule'),
    units: Math.max(1, Math.min(20, Number(f.get('units')) || 1)),
    reserve: String(f.get('reserve')).trim(),
    minBid: String(f.get('minBid')).trim(),
  };
  let opened;
  try {
    opened = openSandbox({ ...state.auction, seed: state.seed });
  } catch (err) {
    alertIn($('[data-facts]'), err);
    $('[data-opened]').hidden = false;
    return;
  }
  const p = opened.params;
  $('[data-facts]').innerHTML = [
    ['auction', p.auction_id],
    ['address', p.address],
    ['rule', p.rule === 'uniform' ? `uniform price, ${p.units} units` : 'first price, 1 lot'],
    ['reserve', `${zec(p.reserve_zat)} ZEC · min bid ${zec(p.min_bid_zat)} ZEC`],
    ['deadline', `block ${p.deadline_height.toLocaleString('en-US')} · settles after ${p.confirmations} confirmations`],
    ['committed', `params_hash ${short(p.params_hash)} · OVK commitment ${short(p.ovk_commitment)}`],
    ['bid URI', opened.uri],
  ].map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('');
  $('[data-qr]').innerHTML = '';
  renderQR($('[data-qr]'), opened.uri);
  $('[data-opened]').hidden = false;
  if (state.bids.length === 0) state.bids = EXAMPLE.slice(0, 4).map((b) => ({ ...b }));
  for (const n of [3, 4, 5]) $(`[data-step="${n}"]`).hidden = true;
  renderBids();
  show(2);
});

/* ---------- 2. bids ---------- */
function seen(bid) {
  if (bid.transparent) return 'shielded tx · transparent input visible';
  return 'shielded tx · sender — · amount — · memo encrypted';
}

function renderBids() {
  $('[data-bids]').innerHTML = state.bids.map((b, i) => `
    <tr data-i="${i}">
      <td><input data-k="name" value="${esc(b.name)}" aria-label="bidder name"></td>
      <td><input data-k="amount" value="${esc(b.amount)}" inputmode="decimal" aria-label="bid in ZEC"></td>
      <td><input data-k="qty" type="number" min="1" value="${b.qty ?? 1}" aria-label="quantity" ${state.auction.rule === 'first-price' ? 'disabled' : ''}></td>
      <td><input data-k="late" type="checkbox" ${b.late ? 'checked' : ''} aria-label="after deadline"></td>
      <td><input data-k="transparent" type="checkbox" ${b.transparent ? 'checked' : ''} aria-label="transparent funds"></td>
      <td><input data-k="noMemo" type="checkbox" ${b.noMemo ? 'checked' : ''} aria-label="no memo"></td>
      <td class="seen">${seen(b)}</td>
      <td><button type="button" class="x" data-del title="remove">✕</button></td>
    </tr>`).join('');
}

$('[data-bids]').addEventListener('input', (e) => {
  const tr = e.target.closest('tr');
  if (!tr) return;
  const bid = state.bids[Number(tr.dataset.i)];
  const k = e.target.dataset.k;
  bid[k] = e.target.type === 'checkbox' ? e.target.checked : k === 'qty' ? Math.max(1, Number(e.target.value) || 1) : e.target.value;
  $('.seen', tr).textContent = seen(bid);
});
$('[data-bids]').addEventListener('click', (e) => {
  if (!e.target.matches('[data-del]')) return;
  state.bids.splice(Number(e.target.closest('tr').dataset.i), 1);
  renderBids();
});
$('[data-add]').addEventListener('click', () => {
  state.bids.push({ name: `Bidder ${state.bids.length + 1}`, amount: '0.1' });
  renderBids();
});
$('[data-example]').addEventListener('click', () => {
  state.bids = EXAMPLE.map((b) => ({ ...b }));
  renderBids();
});

/* ---------- 3. settle ---------- */
function input() {
  return { ...state.auction, seed: state.seed, bids: state.bids.map((b) => ({ ...b, qty: state.auction.rule === 'first-price' ? 1 : b.qty })) };
}

function alertIn(el, err) {
  el.innerHTML = `<p class="verdict fail">${esc(err.message ?? err)}</p>`;
}

$('[data-settle]').addEventListener('click', async () => {
  const bad = state.bids.find((b) => !/^\d+(\.\d{1,8})?$/.test(String(b.amount).trim()) || Number(b.amount) <= 0);
  if (state.bids.length === 0 || bad) {
    alertIn($('[data-result]'), new Error(bad ? `“${bad.name}”: the bid must be a positive amount in ZEC (up to 8 decimals)` : 'add at least one bid'));
    $('[data-outcomes]').innerHTML = '';
    show(3);
    return;
  }
  try {
    state.run = await runSandbox(input());
  } catch (err) {
    alertIn($('[data-result]'), err);
    show(3);
    return;
  }
  renderResult(state.run);
  renderVerify(state.run, 'none');
  renderProofs(state.run);
  for (const n of [3, 4, 5]) $(`[data-step="${n}"]`).hidden = false;
  show(3);
});

function entryOf(run, i) {
  const key = [...run.bidOf].find(([, v]) => v === i)?.[0];
  return run.settlement.entries.find((e) => `${e.txid}:${e.action_index}` === key);
}

const LABEL = {
  winner: 'winner', refunded: 'lost · refunded', unsold: 'below reserve · refunded', late: 'late · refunded',
  dust: 'below min bid · refunded', stranded: 'no refund address', transparent_funded: 'transparent · rejected',
};

function renderResult(run) {
  const s = run.settlement;
  $('[data-result]').innerHTML = `
    <div><b>${s.result === 'sold' ? zec(s.clearing_price_zat) : '—'}</b><span>${s.rule === 'uniform' ? 'clearing price / unit' : 'winning price'}</span></div>
    <div><b>${s.winning_leaves.length}</b><span>winning bids</span></div>
    <div><b>${run.refundTxs.length}</b><span>refund transaction${run.refundTxs.length === 1 ? '' : 's'}</span></div>
    <div><b>${s.entries.length}</b><span>notes at the address</span></div>`;
  $('[data-outcomes]').innerHTML = state.bids.map((b, i) => {
    const e = entryOf(run, i);
    if (!e) return '';
    const paid = e.outcome === 'winner' ? s.clearing_price_zat * BigInt(e.filled_qty || 1) : 0n;
    const value = run.notes[i].value_zat;
    const refunded = e.refund_txid ? `${zec(value - paid)} ZEC` : '—';
    return `<tr><td>${esc(b.name)}</td><td class="mono">${zec(value)}</td>
      <td><span class="tag ${e.outcome}">${LABEL[e.outcome] ?? e.outcome}</span></td>
      <td class="mono">${paid ? `${zec(paid)} ZEC` : '—'}</td><td class="mono">${refunded}</td></tr>`;
  }).join('');
}

/* ---------- 4. verify / tamper ---------- */
function renderVerify(run, kind) {
  const r = run.report;
  const failed = r.checks.filter((c) => c.status === 'fail');
  const v = $('[data-verdict]');
  v.className = `verdict ${r.ok ? 'pass' : 'fail'}`;
  v.textContent = r.ok
    ? `PASS — ${r.checks.length}/${r.checks.length} checks`
    : `FAIL — ${failed.map((c) => c.code).join(', ')}${kind !== 'none' ? ': the cheat is caught' : ''}`;
  $('[data-checks]').innerHTML = r.checks.map((c) =>
    `<li><span>${c.code}</span><span class="${c.status}">${c.status}</span><span>${esc(c.detail ?? '')}</span></li>`).join('');
}

$('[data-tamper]').addEventListener('click', async (e) => {
  const kind = e.target.dataset.t;
  if (!kind || !state.run) return;
  $$('[data-tamper] button').forEach((b) => b.classList.toggle('on', b === e.target));
  renderVerify(kind === 'none' ? state.run : await runSandbox(input(), kind), kind);
});

/* ---------- 5. proofs ---------- */
function renderProofs(run) {
  const options = [];
  state.bids.forEach((b, i) => {
    const e = entryOf(run, i);
    if (e && run.memos.has(e.leaf)) options.push(`<option value="${e.leaf}">${esc(b.name)}</option>`);
  });
  $('[data-proof-who]').innerHTML = options.join('');
  $('[data-proof-memo]').textContent = '';
  $('[data-proof-verdict]').textContent = '';
}

function b64(bytes) {
  let s = '';
  for (const x of bytes) s += String.fromCharCode(x);
  return btoa(s);
}

function proofCheck(flip) {
  const memo = state.run?.memos.get($('[data-proof-who]').value);
  if (!memo) return;
  const bytes = new Uint8Array(memo);
  const at = Math.min(40, bytes.length - 1);
  if (flip) bytes[at] ^= 0x01;
  const text = b64(bytes);
  const mark = Math.floor((at / 3) * 4); // the base64 character that carries the flipped byte
  $('[data-proof-memo]').innerHTML = flip
    ? `${esc(text.slice(0, mark))}<span class="flip">${esc(text.slice(mark, mark + 2))}</span>${esc(text.slice(mark + 2))}`
    : esc(text);
  const res = checkProofMemo(bytes, state.run.settlement);
  const v = $('[data-proof-verdict]');
  v.className = `verdict ${res.ok ? 'pass' : 'fail'}`;
  v.textContent = res.ok
    ? 'MEMO: OK — inclusion proof, outcome and price match the settlement'
    : `MEMO: MISMATCH — ${res.problems.join('; ')}`;
}
$('[data-proof-check]').addEventListener('click', () => proofCheck(false));
$('[data-proof-flip]').addEventListener('click', () => proofCheck(true));
