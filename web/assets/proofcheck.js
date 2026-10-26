/**
 * Inclusion-proof memo check, browser-side.
 *
 * This is a deliberate port of `src/proof.ts` (memo layout) and the leaf/node
 * hashing in `src/merkle.ts` + `src/leaf.ts`, using WebCrypto instead of
 * node:crypto. It has to run in the tab: the whole claim is that a bidder can
 * check their own proof without sending it to the auctioneer, so this module
 * makes zero network calls. `tests/web.test.ts` feeds it memos produced by the
 * Node encoder and asserts both implementations agree, including on rejection.
 *
 *   memo = "SB1" | version(1) | outcome(1) | price u64 LE (8)
 *        | leaf(32) | root(32) | n(1) | n * [ direction(1) | hash(32) ]
 *   node(l, r) = SHA256(0x01 || l || r)
 *
 * Odd nodes are promoted, never duplicated. Getting that wrong changes the root,
 * which is why the verifier is the one that publishes the order, not the UI.
 */

export const MEMO_VERSION = 1;
const MAGIC = new Uint8Array([0x53, 0x42, 0x31]); // "SB1"
const HEADER = 3 + 1 + 1 + 8 + 32 + 32 + 1;
const NODE_TAG = new Uint8Array([0x01]);

export const OUTCOME_BYTE = Object.freeze({
  bid: 0,
  winner: 1,
  refunded: 2,
  late: 3,
  dust: 4,
  transparent_funded: 5,
  stranded: 6,
  unsold: 7,
});

export const BYTE_OUTCOME = Object.freeze(
  Object.fromEntries(Object.entries(OUTCOME_BYTE).map(([name, byte]) => [byte, name])),
);

function subtle() {
  const c = globalThis.crypto;
  if (!c?.subtle) {
    throw new Error('WebCrypto is unavailable: open this page over http://localhost or https');
  }
  return c.subtle;
}

export function toHex(bytes) {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

export function fromHex(hex) {
  if (typeof hex !== 'string' || hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) {
    throw new Error(`not valid hex: ${String(hex).slice(0, 12)}`);
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function b64ToBytes(b64) {
  const clean = String(b64).replace(/\s+/g, '');
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToB64(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** SHA-256 over the concatenation of the given byte arrays. */
export async function sha256(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const buf = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    buf.set(p, o);
    o += p.length;
  }
  return new Uint8Array(await subtle().digest('SHA-256', buf));
}

export async function verifyProof(leafHex, path, rootHex) {
  let cur = fromHex(leafHex);
  for (const step of path) {
    if (step.direction !== 0 && step.direction !== 1) return false;
    const sibling = fromHex(step.hash);
    cur = step.direction === 0 ? await sha256(NODE_TAG, sibling, cur) : await sha256(NODE_TAG, cur, sibling);
  }
  return toHex(cur) === String(rootHex).toLowerCase();
}

export function decodeMemo(bytes) {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (buf.length < HEADER) throw new Error(`memo too short: ${buf.length} bytes`);
  for (let i = 0; i < 3; i++) if (buf[i] !== MAGIC[i]) throw new Error('bad memo magic (expected "SB1")');

  let o = 3;
  const version = buf[o++];
  if (version !== MEMO_VERSION) throw new Error(`unsupported memo version ${version}`);
  const outcomeByte = buf[o++];
  const outcome = BYTE_OUTCOME[outcomeByte];
  if (!outcome) throw new Error(`unknown outcome byte ${outcomeByte}`);

  const view = new DataView(buf.buffer, buf.byteOffset + o, 8);
  const price = view.getBigUint64(0, true);
  o += 8;
  if (price > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('clearing price out of range');

  const leaf = toHex(buf.subarray(o, o + 32));
  o += 32;
  const root = toHex(buf.subarray(o, o + 32));
  o += 32;
  const n = buf[o++];
  if (buf.length !== HEADER + n * 33) {
    throw new Error(`memo length ${buf.length} does not match path length ${n}`);
  }

  const path = [];
  for (let i = 0; i < n; i++) {
    const direction = buf[o++];
    if (direction !== 0 && direction !== 1) throw new Error(`bad direction ${direction}`);
    path.push({ direction, hash: toHex(buf.subarray(o, o + 32)) });
    o += 32;
  }
  return { leaf, root, outcome, clearing_price_zat: Number(price), path };
}

/** Encoder, so the page can demonstrate the check without a wallet. */
export function buildMemo({ leaf, root, outcome, clearing_price_zat, path }) {
  const outcomeByte = OUTCOME_BYTE[outcome];
  if (outcomeByte === undefined) throw new Error(`unknown outcome ${outcome}`);
  const buf = new Uint8Array(HEADER + path.length * 33);
  let o = 0;
  buf.set(MAGIC, o);
  o += 3;
  buf[o++] = MEMO_VERSION;
  buf[o++] = outcomeByte;
  new DataView(buf.buffer).setBigUint64(o, BigInt(clearing_price_zat), true);
  o += 8;
  buf.set(fromHex(leaf), o);
  o += 32;
  buf.set(fromHex(root), o);
  o += 32;
  buf[o++] = path.length;
  for (const step of path) {
    buf[o++] = step.direction;
    buf.set(fromHex(step.hash), o);
    o += 32;
  }
  return buf;
}

/** Flip one bit of the encoded price — a demo of what "MISMATCH" looks like. */
export function flipMemoPrice(memoBytes) {
  const copy = new Uint8Array(memoBytes);
  copy[5] ^= 0x01;
  return copy;
}

/**
 * Check a memo against the published settlement, exactly as
 * `checkProofMemo()` does on the CLI: root, inclusion path, outcome, price.
 */
export async function verifyMemo(memo, settlement) {
  let decoded;
  try {
    decoded = decodeMemo(typeof memo === 'string' ? b64ToBytes(memo) : memo);
  } catch (err) {
    return { ok: false, decoded: null, entry: null, problems: [err instanceof Error ? err.message : String(err)] };
  }

  const problems = [];
  if (decoded.root !== settlement.merkle_root) {
    problems.push(`memo root ${decoded.root} != published root ${settlement.merkle_root}`);
  }
  if (!(await verifyProof(decoded.leaf, decoded.path, decoded.root))) {
    problems.push('inclusion proof does not reconstruct the memo root');
  }
  const entry = settlement.entries.find((e) => e.leaf === decoded.leaf) ?? null;
  if (!entry) {
    problems.push('leaf is not in the published entry table');
  } else if (entry.outcome !== decoded.outcome) {
    problems.push(`memo says ${decoded.outcome}, settlement says ${entry.outcome}`);
  }
  // Spec 2 serializes zatoshi as decimal strings; spec 1 used numbers. Compare
  // the decimal value, never the JS type.
  if (String(decoded.clearing_price_zat) !== String(settlement.clearing_price_zat)) {
    problems.push(`memo price ${decoded.clearing_price_zat} != settlement price ${settlement.clearing_price_zat}`);
  }

  return { ok: problems.length === 0, decoded, entry, problems };
}
