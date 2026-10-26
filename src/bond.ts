import type { AuctionParams, Bond, BondView } from './model.ts';
import { canonicalHash, canonicalJson } from './canonical.ts';
import { sha256Hex } from './leaf.ts';
import { isShieldedAddress } from './memo.ts';

/**
 * Auctioneer bond, blueprint §4.1 and check C13.
 *
 * The bond is not escrowed on chain — Zcash has no shielded timelock — so a
 * bond that is spent early cannot be prevented. It can be *proved*, which is
 * what C13 does: the terms are committed in `auction.json` before the first
 * bid, and `bond.json` records the funding and (if any) the spend. Wording rule:
 * this is auditable custody with a bond, never "trustless".
 */

export const BOND_TAG = Buffer.from('secbid-bond-v1', 'utf8');
export const BOND_GRACE_BLOCKS = 144;

export function bondCommitment(auctionId: string, address: string, amountZat: bigint): string {
  if (!isShieldedAddress(address)) throw new Error('bond address must be shielded');
  if (typeof amountZat !== 'bigint' || amountZat <= 0n) throw new Error('bond amount must be positive');
  return sha256Hex(
    BOND_TAG,
    Buffer.from(
      canonicalJson({
        auction_id: auctionId,
        address,
        amount_zat: amountZat.toString(10),
      }),
      'utf8',
    ),
  );
}

export function createBond(auctionId: string, address: string, amountZat: bigint): Bond {
  return { address, amount_zat: amountZat, commitment: bondCommitment(auctionId, address, amountZat) };
}

export interface BondCheck {
  ok: boolean;
  detail: string;
}

/** C13. `releaseHeight` is the reveal height (or settlement height in private mode). */
export function checkBond(
  params: AuctionParams,
  view: BondView | null | undefined,
  opts: { firstBidHeight: number | null; releaseHeight: number },
): BondCheck {
  if (!params.bond) return { ok: true, detail: 'no bond posted (optional)' };

  const expected = bondCommitment(params.auction_id, params.bond.address, params.bond.amount_zat);
  if (expected !== params.bond.commitment) {
    return { ok: false, detail: 'bond commitment in auction.json does not match its terms' };
  }
  if (!view) return { ok: false, detail: 'bond committed but no bond.json transaction record' };
  if (view.address !== params.bond.address) {
    return { ok: false, detail: 'bond.json address differs from the committed bond address' };
  }
  if (view.amount_zat !== params.bond.amount_zat) {
    return { ok: false, detail: 'bond.json amount differs from the committed bond amount' };
  }
  if (view.commitment !== params.bond.commitment) {
    return { ok: false, detail: 'bond.json commitment differs from auction.json' };
  }

  const firstBid = opts.firstBidHeight ?? params.deadline_height + 1;
  if (view.funded_at_height >= firstBid) {
    return {
      ok: false,
      detail: `bond funded at ${view.funded_at_height}, not before the first bid at ${firstBid}`,
    };
  }
  if (view.spent_at_height !== null) {
    const release = opts.releaseHeight + BOND_GRACE_BLOCKS;
    if (view.spent_at_height <= release) {
      return {
        ok: false,
        detail: `bond spent at ${view.spent_at_height}, before reveal + grace (${release})`,
      };
    }
    if (!view.spend_txid) return { ok: false, detail: 'bond spend has a height but no txid' };
  }
  return { ok: true, detail: `bond funded at ${view.funded_at_height}, unspent through the reveal window` };
}

export function bondRecordToView(
  params: AuctionParams,
  record: { txid: string; funded_at_height: number; spent_at_height?: number | null; spend_txid?: string | null },
): BondView {
  if (!params.bond) throw new Error('auction.json has no bond to record');
  if (!/^[0-9a-f]{64}$/i.test(record.txid)) throw new Error('bond txid must be 32 bytes of hex');
  return {
    txid: record.txid.toLowerCase(),
    address: params.bond.address,
    amount_zat: params.bond.amount_zat,
    commitment: params.bond.commitment,
    funded_at_height: record.funded_at_height,
    spent_at_height: record.spent_at_height ?? null,
    spend_txid: record.spend_txid ?? null,
  };
}

/** A stable, human-readable fingerprint of a bond (used by the CLI). */
export function bondFingerprint(bond: Bond): string {
  return canonicalHash({
    address: bond.address,
    amount_zat: bond.amount_zat.toString(10),
    commitment: bond.commitment,
  }).slice(0, 16);
}
