/**
 * Domain types. Deliberately free of dependencies so the whole deterministic
 * core can run anywhere, including in a judge's browser-less sandbox.
 *
 * Amounts are integer zatoshis in a `bigint`. Zcash's total supply is
 * 21e14 zat, so a JS number would technically be exact, but "technically exact
 * until someone multiplies by a quantity" is not a property an auction should
 * rely on. Artifacts serialize them as decimal strings in spec 2 and as numbers
 * in spec 1 (see `serialize.ts`), never as floats.
 */

export type Zat = bigint;

export type Rule = 'first-price' | 'uniform';
export type Pool = 'orchard' | 'ironwood';
export type NotePool = Pool | 'sapling';
export type Mode = 'public-tender' | 'private';

export type Outcome =
  | 'bid' // pre-clearing: eligible, not yet resolved
  | 'winner'
  | 'refunded' // lost the auction
  | 'unsold' // no bid met the reserve
  | 'late' // arrived after deadline_height
  | 'dust' // below min_bid_zat x qty
  | 'stranded' // no usable refund address: cannot be refunded
  | 'transparent_funded'; // funded from a transparent input: rejected

export type PreOutcome = 'bid' | 'late' | 'dust' | 'stranded' | 'transparent_funded';

export interface Bond {
  address: string;
  amount_zat: Zat;
  /** sha256 of the canonical bond terms; published at open. */
  commitment: string;
}

export interface AuctionParams {
  /** 1 = legacy artifacts (numbers, first-price only); 2 = spec v2. */
  spec: 1 | 2;
  auction_id: string;
  network: 'main' | 'test' | 'regtest';
  address: string; // unified address of the ephemeral auction account
  reserve_zat: Zat;
  deadline_height: number;
  /** Blocks after the deadline before settlement is allowed. */
  confirmations: number;
  min_bid_zat: Zat;
  rule: Rule;
  /** Units for sale. First-price is always 1. */
  units: number;
  pool: Pool;
  mode: Mode;
  bond: Bond | null;
  opened_at_height: number;
  ovk_commitment: string; // sha256 hex, committed at open
  params_hash: string; // sha256 hex of the canonical params without this field
  /** Set when `--pool auto` had to fall back; never silent. */
  pool_warning?: string;
}

export interface Memo {
  v: 1 | 2;
  refund: string; // shielded unified address (u1…) or zs1…
  /** Units requested. Always 1 for memo v1 / first-price. */
  qty: number;
  label?: string;
}

/**
 * One note received at the auction address. In a real deployment this comes
 * from trial-decrypting with the auction UFVK; in fixtures it is the recorded
 * result of that scan. `value_zat`, `memo_raw` and `transparent_funded` are only
 * visible to a holder of the viewing key.
 */
export interface ReceivedNote {
  txid: string; // 64 hex
  height: number; // inclusion height
  action_index: number;
  value_zat: Zat;
  cm: string; // 64 hex note commitment
  memo_raw: string | null; // raw UTF-8 memo text, null when absent
  transparent_funded: boolean; // tx has at least one transparent input
  pool: NotePool;
}

export interface Entry {
  /** Internal identity: `${txid}:${action_index}`. Never serialized. */
  key: string;
  leaf: string; // 64 hex
  txid: string;
  cm: string;
  height: number;
  action_index: number;
  outcome: Outcome;
  refund_txid: string | null;
  /** Units requested by the memo. 1 in spec 1. */
  qty: number;
  /** Units actually allocated. 0 unless the entry won. */
  filled_qty: number;
  /** What the entry pays the seller. Public: price x filled units. */
  payment_zat: Zat;
}

export interface RefundTx {
  txid: string;
  height: number;
}

/**
 * Refunds as broadcast. One transaction per batch when it fits, several
 * broadcast together at one target height when it does not. `by_leaf` records
 * which transaction paid which entry, so the artifact never claims a refund
 * that a different tx actually carried.
 */
export interface RefundBatch {
  txs: RefundTx[];
  by_leaf: Record<string, string>;
}

export interface Settlement {
  spec: 1 | 2;
  auction_id: string;
  params_hash: string;
  ovk_commitment: string;
  /** `null` in private mode: the UFVK is never published. */
  ufvk: string | null;
  deadline_height: number;
  settle_height: number;
  entries: Entry[];
  merkle_root: string;
  result: 'sold' | 'unsold';
  /** Per-unit clearing price. For spec 1 this is also the winner's total bid. */
  clearing_price_zat: Zat;
  winning_leaf: string | null;
  /** Every accepted leaf, highest unit price first. Spec 1 has at most one. */
  winning_leaves: string[];
  rule: Rule;
  units: number;
  refund_txs: RefundTx[];
  /** sha256 over the auditor transcript in `refunds.json` (spec 2, private mode). */
  refunds_commitment?: string;
  /**
   * Aggregates that are already public or already visible to an OVK holder.
   * `in_zat` and the stranded total are deliberately NOT published — total bid
   * volume is commercially sensitive in a private auction, and with one
   * stranded note the aggregate would equal that note.
   */
  accounting: {
    refunded_zat: Zat;
    retained_zat: Zat;
    fees_zat: Zat;
  };
}

/** Simulated chain view that a verifier obtains independently (public rescan). */
export interface ScanView {
  chain_tx_count: number; // transactions to the auction address (public)
  chain_note_count: number; // notes at the auction address (viewing key only)
  notes: ReceivedNote[];
  refund_outputs: Array<{ txid: string; height: number; address: string; value_zat: Zat; pool?: NotePool }>;
  ovk: string; // revealed outgoing viewing key, hex
}

/** `account.json` is written by `open --rpc`; never public in private mode. */
export interface AccountFile {
  account_uuid: string;
  address: string;
  ufvk: string;
  pool: Pool;
  height: number;
}

/** `reveal.json` exists only in public-tender mode. */
export interface Reveal {
  ufvk: string;
  reveal_height: number;
}

/**
 * Public record of the auctioneer's bond. `bond.json` is the chain/bond view
 * C13 consumes; it is deliberately not part of the hashed params.
 */
export interface BondView {
  txid: string;
  address: string;
  amount_zat: Zat;
  commitment: string;
  funded_at_height: number;
  spent_at_height: number | null;
  spend_txid: string | null;
}

/** Auditor transcript shape published alongside a settlement. */
export interface RefundArtifact {
  spec: 2;
  auction_id: string;
  txs: Array<{ txid: string; height: number; output_count: number }>;
  output_count: number;
  /** sha256 of canonical(refund flows) — no addresses, no amounts in cleartext. */
  outputs_hash: string;
}

export interface MerkleProofElement {
  /** 0 = sibling on the left, 1 = sibling on the right */
  direction: 0 | 1;
  hash: string;
}

export type ProofMap = Record<string, MerkleProofElement[]>;

export interface Commitments {
  params_hash: string;
  settlement_hash: string;
}

export const ZAT_PER_ZEC = 100_000_000n;

export function zat(n: bigint): bigint {
  if (typeof n !== 'bigint' || n < 0n) {
    throw new Error(`not a valid zat amount: ${String(n)}`);
  }
  return n;
}

export function noteKey(note: { txid: string; action_index: number }): string {
  return `${note.txid}:${note.action_index}`;
}

export function entryKey(entry: { txid: string; action_index: number }): string {
  return `${entry.txid}:${entry.action_index}`;
}
