import type {
  AuctionParams,
  MerkleProofElement,
  Mode,
  Pool,
  ProofMap,
  ReceivedNote,
  RefundBatch,
  RefundTx,
  Rule,
  Settlement,
  Zat,
} from './model.ts';
import type { ChainAdapter } from './adapter.ts';
import { classifyAll, clear } from './clearing.ts';
import { isShieldedAddress } from './memo.ts';
import { ovkCommitment } from './leaf.ts';
import { verifyProof } from './merkle.ts';
import { buildSettlement, paramsHash } from './settlement.ts';
import { decodeProofMemo, encodeProofMemo, type ProofMemo } from './proof.ts';
import { createBond } from './bond.ts';

/**
 * Auction orchestration. Everything here is deterministic; the only impure parts
 * are the two adapter calls (scan the chain, broadcast the refund batch).
 */

export interface OpenAuctionInput {
  /** Defaults to 2. Spec 1 is the legacy format kept for old fixtures. */
  spec?: 1 | 2;
  auction_id: string;
  network: AuctionParams['network'];
  address: string;
  reserve_zat: Zat | number;
  deadline_height: number;
  confirmations?: number;
  /** Spec-1 name for `confirmations`. */
  settle_depth?: number;
  min_bid_zat: Zat | number;
  rule?: Rule;
  units?: number;
  pool?: Pool;
  mode?: Mode;
  bond?: { address: string; amount_zat: Zat | number } | null;
  opened_at_height?: number;
  /** Spec-1 name for `opened_at_height`. */
  created_at_height?: number;
  /** Outgoing viewing key, hex. Only its hash is published. */
  ovk: string;
  pool_warning?: string;
}

function asZat(value: Zat | number, field: string): Zat {
  if (typeof value === 'bigint') {
    if (value < 0n) throw new Error(`${field} must be non-negative`);
    return value;
  }
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${field} must be a non-negative integer`);
  return BigInt(value);
}

export function openAuction(input: OpenAuctionInput): AuctionParams {
  const spec = input.spec ?? 2;
  const rule = input.rule ?? 'first-price';
  const units = input.units ?? 1;
  const pool = input.pool ?? 'orchard';
  const mode = input.mode ?? 'public-tender';
  const confirmations = input.confirmations ?? input.settle_depth ?? 0;
  const openedAt = input.opened_at_height ?? input.created_at_height;

  if (spec !== 1 && spec !== 2) throw new Error(`spec must be 1 or 2: ${spec}`);
  if (!new RegExp(`^[0-9a-f]{${spec === 1 ? 16 : 32}}$`).test(input.auction_id)) {
    throw new Error(`auction_id must be ${spec === 1 ? 16 : 32} hex chars for spec ${spec}`);
  }
  if (!isShieldedAddress(input.address)) throw new Error(`auction address must be shielded: ${input.address}`);
  if (!/^[0-9a-f]{64}$/i.test(input.ovk)) throw new Error('ovk must be 32 bytes of hex (64 characters)');
  if (openedAt === undefined) throw new Error('opened_at_height is required');
  if (!Number.isSafeInteger(openedAt) || openedAt < 0) throw new Error(`opened_at_height is invalid: ${openedAt}`);
  if (!Number.isSafeInteger(confirmations) || confirmations < 0) {
    throw new Error(`confirmations must be a non-negative integer: ${confirmations}`);
  }
  if (!Number.isSafeInteger(input.deadline_height) || input.deadline_height < 0) {
    throw new Error(`deadline_height must be a block height: ${input.deadline_height}`);
  }
  if (input.deadline_height <= openedAt) {
    throw new Error(`deadline ${input.deadline_height} must be after opening height ${openedAt}`);
  }

  const reserve = asZat(input.reserve_zat, 'reserve_zat');
  const minBid = asZat(input.min_bid_zat, 'min_bid_zat');
  if (reserve <= 0n) throw new Error('reserve_zat must be positive');
  if (reserve < minBid) throw new Error('reserve_zat must be at least min_bid_zat');
  if (!Number.isSafeInteger(units) || units < 1) throw new Error(`units must be a positive integer: ${units}`);
  if (rule === 'first-price' && units !== 1) throw new Error('first-price clearing sells exactly one unit');
  if (rule === 'uniform' && units < 1) throw new Error('uniform clearing needs at least one unit');
  if (spec === 1 && (rule !== 'first-price' || units !== 1 || pool !== 'orchard' || mode !== 'public-tender' || input.bond)) {
    throw new Error('spec 1 supports only first-price, one unit, orchard, public-tender, and no bond');
  }

  const bond = input.bond ? createBond(input.auction_id, input.bond.address, asZat(input.bond.amount_zat, 'bond.amount_zat')) : null;
  const base: AuctionParams = {
    spec,
    auction_id: input.auction_id,
    network: input.network,
    address: input.address,
    reserve_zat: reserve,
    deadline_height: input.deadline_height,
    confirmations,
    min_bid_zat: minBid,
    rule,
    units,
    pool,
    mode,
    bond,
    opened_at_height: openedAt,
    ovk_commitment: ovkCommitment(input.auction_id, input.ovk),
    params_hash: '',
    ...(input.pool_warning ? { pool_warning: input.pool_warning } : {}),
  };
  return { ...base, params_hash: paramsHash(base) };
}

export interface RefundPlanEntry {
  key: string;
  leaf: string;
  address: string;
  value_zat: Zat;
}

/**
 * Who must be paid back, and where. `stranded` notes are absent by design:
 * without a shielded refund address there is nowhere safe to send them.
 * Uniform winners appear here when their payment is below their bid.
 */
export function planRefunds(params: AuctionParams, notes: ReceivedNote[]): RefundPlanEntry[] {
  const classified = classifyAll(notes, params);
  const result = clear(classified, params);
  const byKey = new Map(classified.map((n) => [n.key, n]));
  return result.refunds.map((r) => {
    const note = byKey.get(r.key);
    if (!note) throw new Error(`refund plan: unknown note ${r.key}`);
    if (!note.refund_address) throw new Error(`refund plan: leaf ${r.leaf} has no refund address`);
    return { key: r.key, leaf: r.leaf, address: note.refund_address, value_zat: r.value_zat };
  });
}

/**
 * Conservative per-transaction output budget. The real limit comes from the
 * ZIP-225 size budget of whatever broadcasts the batch; this is the policy the
 * simulator and the CLI use until an adapter reports a measured value.
 */
export const DEFAULT_MAX_OUTPUTS_PER_TX = 40;

/**
 * Split a refund plan into the transactions that will carry it, in order.
 *
 * Two entries that share a refund address never share a transaction: Zallet's
 * `z_sendmany` rejects duplicate recipients, and C8 requires one output per
 * entry, so combining them would leave a row unaccounted for. A reused address
 * therefore costs an extra refund transaction, which is the honest price of
 * letting a bidder reuse one.
 */
export function chunkRefundPlan(
  plan: RefundPlanEntry[],
  maxOutputsPerTx: number = DEFAULT_MAX_OUTPUTS_PER_TX,
): RefundPlanEntry[][] {
  if (!Number.isSafeInteger(maxOutputsPerTx) || maxOutputsPerTx < 1) {
    throw new Error(`maxOutputsPerTx must be a positive integer: ${maxOutputsPerTx}`);
  }
  const chunks: RefundPlanEntry[][] = [];
  for (const entry of plan) {
    const current = chunks[chunks.length - 1];
    if (current && current.length < maxOutputsPerTx && !current.some((p) => p.address === entry.address)) {
      current.push(entry);
    } else {
      chunks.push([entry]);
    }
  }
  return chunks;
}

/** The common case: one transaction paid every refundable leaf. */
export function singleRefundBatch(plan: RefundPlanEntry[], tx: RefundTx): RefundBatch {
  return { txs: [tx], by_leaf: Object.fromEntries(plan.map((p) => [p.leaf, tx.txid])) };
}

/**
 * Broadcast the refund plan, splitting it when it exceeds one transaction's
 * budget. Every chunk is sent at one target height: the chain leaks timing at
 * settlement precisely when refunds land in separate blocks.
 */
export async function broadcastRefunds(
  chain: ChainAdapter,
  plan: RefundPlanEntry[],
  opts: { maxOutputsPerTx?: number; targetHeight?: number } = {},
): Promise<RefundBatch> {
  if (plan.length === 0) return { txs: [], by_leaf: {} };

  const txs: RefundTx[] = [];
  const by_leaf: Record<string, string> = {};
  const seen = new Set<string>();
  let targetHeight = opts.targetHeight;

  for (const chunk of chunkRefundPlan(plan, opts.maxOutputsPerTx)) {
    const tx = await chain.sendRefunds(
      chunk.map((p) => ({ address: p.address, value_zat: p.value_zat })),
      targetHeight,
    );
    if (seen.has(tx.txid)) {
      throw new Error(
        `refund adapter returned txid ${tx.txid} for two chunks; a settlement cannot assign one tx to two batches`,
      );
    }
    seen.add(tx.txid);
    targetHeight ??= tx.height;
    txs.push(tx);
    for (const entry of chunk) by_leaf[entry.leaf] = tx.txid;
  }

  return { txs, by_leaf };
}

export interface SettleInput {
  params: AuctionParams;
  notes: ReceivedNote[];
  /** `null` in private mode. */
  ufvk: string | null;
  settle_height: number;
  refunds: RefundBatch;
  refunds_commitment?: string;
}

export interface SettleOutput {
  settlement: Settlement;
  proofs: ProofMap;
  /** One inclusion-proof memo per entry, keyed by leaf. */
  memos: Map<string, Uint8Array>;
}

export function settleAuction(input: SettleInput): SettleOutput {
  const { settlement, proofs } = buildSettlement(input.params, input.notes, {
    ufvk: input.ufvk,
    settle_height: input.settle_height,
    refunds: input.refunds,
    ...(input.refunds_commitment ? { refunds_commitment: input.refunds_commitment } : {}),
  });

  const memos = new Map<string, Uint8Array>();
  if (settlement.clearing_price_zat > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('clearing price does not fit the inclusion-proof memo format');
  }
  for (const entry of settlement.entries) {
    const path: MerkleProofElement[] = proofs[entry.leaf] ?? [];
    memos.set(
      entry.leaf,
      encodeProofMemo({
        leaf: entry.leaf,
        root: settlement.merkle_root,
        outcome: entry.outcome,
        clearing_price_zat: Number(settlement.clearing_price_zat),
        path,
      }),
    );
  }

  return { settlement, proofs, memos };
}

export interface ProofMemoCheck {
  ok: boolean;
  problems: string[];
}

/** Check a bidder's memo against the published settlement and the chain. */
export function checkProofMemo(memo: Uint8Array, settlement: Settlement): ProofMemoCheck {
  const problems: string[] = [];
  let decoded: ProofMemo;
  try {
    decoded = decodeProofMemo(memo);
  } catch (err) {
    return { ok: false, problems: [(err as Error).message] };
  }

  if (decoded.root !== settlement.merkle_root) {
    problems.push(`memo root ${decoded.root} != published root ${settlement.merkle_root}`);
  }
  if (!verifyProof(decoded.leaf, decoded.path, decoded.root)) {
    problems.push('inclusion proof does not reconstruct the root');
  }
  const entry = settlement.entries.find((e) => e.leaf === decoded.leaf);
  if (!entry) {
    problems.push('leaf is not in the published entry table');
  } else {
    if (entry.outcome !== decoded.outcome) {
      problems.push(`memo says ${decoded.outcome}, settlement says ${entry.outcome}`);
    }
  }
  if (BigInt(decoded.clearing_price_zat) !== settlement.clearing_price_zat) {
    problems.push(
      `memo price ${decoded.clearing_price_zat} != ${settlement.clearing_price_zat.toString(10)}`,
    );
  }
  return { ok: problems.length === 0, problems };
}
