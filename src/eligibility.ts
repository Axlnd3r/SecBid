import type { AuctionParams, PreOutcome, ReceivedNote } from './model.ts';
import { noteKey } from './model.ts';
import { leafHex } from './leaf.ts';
import { isShieldedAddress, parseMemo } from './memo.ts';

/**
 * Eligibility rules, blueprint §5. Evaluated in order; the first failure wins.
 *
 *   E2 stranded             memo missing / unparseable / refund address not shielded
 *   E1 late                 height > deadline_height
 *   E3 dust                 value < min_bid_zat × qty
 *   E4 transparent_funded   any transparent input in the funding tx
 *
 * E2 is evaluated before E1 on purpose: a note with no usable refund address is
 * stranded whenever it arrived. Labelling a late memo-less note `late` would put
 * it in the refund plan with nowhere to send it, which is the one thing the
 * settlement builder must never do.
 *
 * `stranded` rather than `refunded` on purpose: without a usable shielded refund
 * address there is nowhere to send the money, and estimating otherwise would be
 * a lie. Those funds stay in the auction account and are claimable only through
 * the disclosed claim flow.
 */

export interface Classification {
  key: string;
  /** Spec 1 commits the leaf before clearing; spec 2 needs the outcome first. */
  leaf: string | null;
  pre: PreOutcome;
  qty: number;
  reason?: string;
  refund_address: string | null;
  /** True when this refund address appears on more than one note. */
  refund_reused: boolean;
  memo_v: 1 | 2 | null;
}

export { isShieldedAddress, parseMemo };

export function classify(
  note: ReceivedNote,
  params: AuctionParams,
  reusedAddresses: ReadonlySet<string> = new Set(),
): Classification {
  const key = noteKey(note);
  const leaf = params.spec === 1 ? leafHex(note.txid, note.cm) : null;
  const parsed = parseMemo(note.memo_raw);
  if (!parsed.ok) {
    return { key, leaf, pre: 'stranded', qty: 1, reason: parsed.reason, refund_address: null, refund_reused: false, memo_v: null };
  }
  const memo = parsed.memo;
  const reused = reusedAddresses.has(memo.refund);
  const base = { key, leaf, qty: memo.qty, refund_address: memo.refund, refund_reused: reused, memo_v: memo.v };

  if (params.spec === 1 && memo.v !== 1) {
    return { ...base, pre: 'stranded', reason: 'memo_v2_not_allowed' };
  }
  if (params.rule === 'first-price' && memo.qty !== 1) {
    // A single-lot auction has one unit. A bid asking for several is not a
    // valid single-lot bid; refund it rather than silently truncating it.
    return { ...base, pre: 'dust', reason: 'qty_not_allowed_in_first_price' };
  }
  if (note.height > params.deadline_height) {
    return { ...base, pre: 'late', reason: `height ${note.height} > deadline ${params.deadline_height}` };
  }
  if (note.value_zat < params.min_bid_zat * BigInt(memo.qty)) {
    return {
      ...base,
      pre: 'dust',
      reason: `value ${note.value_zat} < min ${params.min_bid_zat} x ${memo.qty}`,
    };
  }
  if (note.transparent_funded) {
    return { ...base, pre: 'transparent_funded', reason: 'funding tx has transparent inputs' };
  }
  return { ...base, pre: 'bid' };
}

export function classifyAll(notes: ReceivedNote[], params: AuctionParams): Classification[] {
  const counts = new Map<string, number>();
  for (const note of notes) {
    const parsed = parseMemo(note.memo_raw);
    if (!parsed.ok) continue;
    counts.set(parsed.memo.refund, (counts.get(parsed.memo.refund) ?? 0) + 1);
  }
  const reused = new Set(
    Array.from(counts)
      .filter(([, count]) => count > 1)
      .map(([address]) => address),
  );
  return notes.map((note) => classify(note, params, reused));
}

/** Notes that must be returned to their sender. `stranded` is deliberately absent. */
export const REFUNDABLE: ReadonlySet<PreOutcome> = new Set(['late', 'dust', 'transparent_funded']);
