import { Buffer } from '../assets/shim/buffer.js';
                                       

/**
 * Bid memo, spec v2.
 *
 * Memos are attacker-controlled 512-byte strings. The parser accepts only the
 * exact schema for the version it sees: unknown keys are a rejection, not an
 * invitation to guess. A memo we cannot fully understand is `stranded`, which
 * means the note is still in the leaf table and refundable by claim, never
 * silently dropped.
 *
 *   v1  {"v":1,"refund":"u1…","label":"optional"}
 *   v2  {"v":2,"refund":"u1…","qty":"1"}
 */

export const MAX_MEMO_BYTES = 512;
export const MAX_QTY = 1_000_000;

const DECIMAL = /^(0|[1-9][0-9]*)$/;
const V1_KEYS = new Set(['v', 'refund', 'label']);
const V2_KEYS = new Set(['v', 'refund', 'qty']);

                                                         

// Bech32m HRPs from ZIP-316 (unified) and ZIP-32 (Sapling). Longest prefix first
// is not needed: none of these is a prefix of another.
const SHIELDED_PREFIXES                                                   = [
  ['u1', 'main', true],
  ['utest1', 'test', true],
  ['uregtest1', 'regtest', true],
  ['zs1', 'main', false],
  ['ztestsapling1', 'test', false],
  ['zregtestsapling1', 'regtest', false],
];

const UFVK_PREFIXES = ['uview1', 'uviewtest1', 'uviewregtest1'];

/** Network of a shielded address by its HRP, or null if it is not shielded. */
export function addressNetwork(address         )                        {
  if (typeof address !== 'string') return null;
  const hit = SHIELDED_PREFIXES.find(([prefix]) => address.startsWith(prefix));
  return hit ? hit[1] : null;
}

export function isShieldedAddress(address         )                    {
  return addressNetwork(address) !== null;
}

/** Unified (not Sapling-only) address on any network. */
export function isUnifiedAddress(address         )                    {
  if (typeof address !== 'string') return false;
  return SHIELDED_PREFIXES.some(([prefix, , unified]) => unified && address.startsWith(prefix));
}

export function isUnifiedViewingKey(key         )                {
  return typeof key === 'string' && UFVK_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/** Placeholder refund address shown in a bid memo template, on the auction's network. */
export function refundPlaceholder(auctionAddress        )         {
  const net = addressNetwork(auctionAddress);
  const prefix = net === 'test' ? 'utest1' : net === 'regtest' ? 'uregtest1' : 'u1';
  return `${prefix}<your fresh shielded address>`;
}

                       
                            
                                  

export function parseMemo(raw               )            {
  if (raw === null || raw.trim() === '') return { ok: false, reason: 'no_memo' };
  if (Buffer.byteLength(raw, 'utf8') > MAX_MEMO_BYTES) {
    return { ok: false, reason: 'memo_too_long' };
  }

  let parsed         ;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'not_json' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: 'not_object' };
  }

  const memo = parsed                           ;
  if (memo.v !== 1 && memo.v !== 2) return { ok: false, reason: 'unsupported_version' };
  const version = memo.v         ;
  const allowed = version === 1 ? V1_KEYS : V2_KEYS;
  for (const key of Object.keys(memo)) {
    if (!allowed.has(key)) return { ok: false, reason: `unknown_key:${key}` };
  }

  if (typeof memo.refund !== 'string') return { ok: false, reason: 'no_refund_field' };
  if (!isShieldedAddress(memo.refund)) return { ok: false, reason: 'refund_not_shielded' };

  if (version === 1) {
    if (memo.label !== undefined && (typeof memo.label !== 'string' || memo.label.length > 64)) {
      return { ok: false, reason: 'bad_label' };
    }
    return {
      ok: true,
      memo: { v: 1, refund: memo.refund, qty: 1, ...(typeof memo.label === 'string' ? { label: memo.label } : {}) },
    };
  }

  let qty = 1;
  if (memo.qty !== undefined) {
    if (typeof memo.qty !== 'string' || !DECIMAL.test(memo.qty)) {
      return { ok: false, reason: 'bad_qty' };
    }
    qty = Number(memo.qty);
    if (!Number.isSafeInteger(qty) || qty < 1 || qty > MAX_QTY) {
      return { ok: false, reason: 'qty_out_of_range' };
    }
  }
  return { ok: true, memo: { v: 2, refund: memo.refund, qty } };
}

export function memoJson(memo      )         {
  if (memo.v === 1) {
    const body                          = { v: 1, refund: memo.refund };
    if (memo.label) body.label = memo.label;
    return JSON.stringify(body);
  }
  return JSON.stringify({ v: 2, refund: memo.refund, qty: String(memo.qty) });
}

export function memoBytes(memo      )             {
  const text = memoJson(memo);
  if (Buffer.byteLength(text, 'utf8') > MAX_MEMO_BYTES) {
    throw new Error(`memo is ${Buffer.byteLength(text, 'utf8')} bytes, max ${MAX_MEMO_BYTES}`);
  }
  return new Uint8Array(Buffer.from(text, 'utf8'));
}

export function buildMemoV2(refund        , qty = 1)       {
  if (!isShieldedAddress(refund)) throw new Error('refund address must be shielded');
  if (!Number.isSafeInteger(qty) || qty < 1 || qty > MAX_QTY) throw new Error(`qty out of range: ${qty}`);
  return { v: 2, refund, qty };
}
