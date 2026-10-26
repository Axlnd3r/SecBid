import type { AuctionParams, Memo, Settlement } from './model.ts';
import { checkProofMemo, type ProofMemoCheck } from './auction.ts';
import { buildMemoV2, isShieldedAddress, MAX_MEMO_BYTES, memoBytes, memoJson } from './memo.ts';
import { buildPaymentUri } from './zip321.ts';

/**
 * Bidder-side agent, blueprint §F.
 *
 * The agent never sees anyone else's bid, never touches the auctioneer, and has
 * no model in the loop. It holds one mandate (max unit price, quantity, refund
 * address), builds the ZIP-321 request, and later checks the inclusion proof.
 * That is the whole point: AI belongs on the bidder's side, not in clearing.
 *
 * Mandate (strict schema, all amounts decimal strings):
 *   {"v":1,"max_price_zat":"120000000","quantity":"2",
 *    "refund_address":"u1…","bid_price_zat":"100000000"}
 */

export interface Mandate {
  v: 1;
  max_price_zat: bigint;
  quantity: number;
  refund_address: string;
  bid_price_zat: bigint | null;
}

export type MandateParse = { ok: true; mandate: Mandate } | { ok: false; reason: string };

const KEYS = new Set(['v', 'max_price_zat', 'quantity', 'refund_address', 'bid_price_zat']);

function decimal(value: unknown): bigint | null {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) return null;
  return BigInt(value);
}

export function parseMandate(raw: unknown): MandateParse {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: 'mandate must be a JSON object' };
  }
  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!KEYS.has(key)) return { ok: false, reason: `unknown mandate key: ${key}` };
  }
  if (obj.v !== 1) return { ok: false, reason: 'unsupported mandate version' };

  const maxPrice = decimal(obj.max_price_zat);
  if (maxPrice === null || maxPrice <= 0n) return { ok: false, reason: 'max_price_zat must be a positive decimal string' };

  const qty = decimal(obj.quantity);
  if (qty === null || qty < 1n || qty > 1_000_000n) {
    return { ok: false, reason: 'quantity must be an integer between 1 and 1000000' };
  }

  if (!isShieldedAddress(obj.refund_address)) {
    return { ok: false, reason: 'refund_address must be a shielded address' };
  }

  let bidPrice: bigint | null = null;
  if (obj.bid_price_zat !== undefined) {
    bidPrice = decimal(obj.bid_price_zat);
    if (bidPrice === null || bidPrice <= 0n) {
      return { ok: false, reason: 'bid_price_zat must be a positive decimal string' };
    }
    if (bidPrice > maxPrice) return { ok: false, reason: 'bid_price_zat exceeds the mandate maximum' };
  }

  return {
    ok: true,
    mandate: {
      v: 1,
      max_price_zat: maxPrice,
      quantity: Number(qty),
      refund_address: obj.refund_address,
      bid_price_zat: bidPrice,
    },
  };
}

export interface AgentBid {
  uri: string;
  memo: Memo;
  memo_text: string;
  amount_zat: bigint;
  per_unit_zat: bigint;
  quantity: number;
  warnings: string[];
}

export function buildAgentBid(params: AuctionParams, mandate: Mandate): AgentBid {
  if (params.rule === 'first-price' && mandate.quantity !== 1) {
    throw new Error('a first-price auction sells one unit; set quantity to 1');
  }
  const perUnit = mandate.bid_price_zat ?? mandate.max_price_zat;
  if (perUnit < params.reserve_zat) {
    throw new Error(`bid price ${perUnit} is below the reserve ${params.reserve_zat}; it cannot win`);
  }
  if (perUnit < params.min_bid_zat) {
    throw new Error(`bid price ${perUnit} is below the minimum bid ${params.min_bid_zat}`);
  }
  const amount = perUnit * BigInt(mandate.quantity);
  const memo = buildMemoV2(mandate.refund_address, mandate.quantity);
  const bytes = memoBytes(memo);
  if (bytes.length > MAX_MEMO_BYTES) throw new Error('memo does not fit in 512 bytes');

  const warnings: string[] = [];
  if (perUnit !== mandate.max_price_zat) {
    warnings.push(
      `bidding ${perUnit} per unit, below the mandate maximum ${mandate.max_price_zat}`,
    );
  }
  if (params.rule === 'uniform') {
    warnings.push('uniform clearing: the final unit price may be lower than your bid; the excess is refunded');
  }

  return {
    uri: buildPaymentUri({ address: params.address, amount_zat: amount, memo: bytes }),
    memo,
    memo_text: memoJson(memo),
    amount_zat: amount,
    per_unit_zat: perUnit,
    quantity: mandate.quantity,
    warnings,
  };
}

export function checkAgentMemo(memo: Uint8Array, settlement: Settlement): ProofMemoCheck {
  return checkProofMemo(memo, settlement);
}
