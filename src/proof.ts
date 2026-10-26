import type { MerkleProofElement, Outcome } from './model.ts';

/**
 * Inclusion-proof memo, blueprint §9 step 5.
 *
 * A losing bidder receives this in a 512-byte encrypted memo. It proves "my bid
 * was in the committed set, and this is how it was resolved" without revealing
 * anyone else's amount.
 *
 * Binary, not JSON: a JSON proof of depth 7 is ~250 bytes and stops fitting
 * around 16 bids, which would make the scheme quietly degrade exactly when an
 * auction gets interesting. The fixed overhead here is 78 bytes, leaving room
 * for 13 path elements (~4k bids, depth 12).
 *
 *   magic "SB1" (3) | version (1) | outcome (1) | price u64 LE (8)
 *   leaf (32) | root (32) | n (1) | n * [ direction (1) | hash (32) ]
 */

export const MEMO_MAGIC = Buffer.from('SB1', 'utf8');
export const MEMO_VERSION = 1;
export const MAX_MEMO = 512;
const HEADER = 3 + 1 + 1 + 8 + 32 + 32 + 1;

export const OUTCOME_BYTE: Record<Outcome, number> = {
  bid: 0,
  winner: 1,
  refunded: 2,
  late: 3,
  dust: 4,
  transparent_funded: 5,
  stranded: 6,
  unsold: 7,
};

export const BYTE_OUTCOME: Record<number, Outcome> = Object.fromEntries(
  Object.entries(OUTCOME_BYTE).map(([k, v]) => [v, k as Outcome]),
) as Record<number, Outcome>;

export interface ProofMemo {
  leaf: string;
  root: string;
  outcome: Outcome;
  clearing_price_zat: number;
  path: MerkleProofElement[];
}

export function maxPathLength(): number {
  return Math.floor((MAX_MEMO - HEADER) / 33);
}

export function encodeProofMemo(memo: ProofMemo): Uint8Array {
  if (!Number.isSafeInteger(memo.clearing_price_zat) || memo.clearing_price_zat < 0) {
    throw new Error('invalid clearing price');
  }
  if (memo.path.length > maxPathLength()) {
    throw new Error(`proof path of ${memo.path.length} exceeds the ${maxPathLength()} that fit in 512 bytes`);
  }

  const buf = Buffer.alloc(HEADER + memo.path.length * 33);
  let o = 0;
  MEMO_MAGIC.copy(buf, o); o += 3;
  buf.writeUInt8(MEMO_VERSION, o); o += 1;
  buf.writeUInt8(OUTCOME_BYTE[memo.outcome], o); o += 1;
  buf.writeBigUInt64LE(BigInt(memo.clearing_price_zat), o); o += 8;
  Buffer.from(memo.leaf, 'hex').copy(buf, o); o += 32;
  Buffer.from(memo.root, 'hex').copy(buf, o); o += 32;
  buf.writeUInt8(memo.path.length, o); o += 1;
  for (const step of memo.path) {
    buf.writeUInt8(step.direction, o); o += 1;
    Buffer.from(step.hash, 'hex').copy(buf, o); o += 32;
  }
  return new Uint8Array(buf);
}

export function decodeProofMemo(bytes: Uint8Array): ProofMemo {
  const buf = Buffer.from(bytes);
  if (buf.length < HEADER) throw new Error(`memo too short: ${buf.length} bytes`);
  if (!buf.subarray(0, 3).equals(MEMO_MAGIC)) throw new Error('bad memo magic');
  let o = 3;
  const version = buf.readUInt8(o); o += 1;
  if (version !== MEMO_VERSION) throw new Error(`unsupported memo version ${version}`);
  const outcomeByte = buf.readUInt8(o); o += 1;
  const outcome = BYTE_OUTCOME[outcomeByte];
  if (!outcome) throw new Error(`unknown outcome byte ${outcomeByte}`);
  const price = buf.readBigUInt64LE(o); o += 8;
  const leaf = buf.subarray(o, o + 32).toString('hex'); o += 32;
  const root = buf.subarray(o, o + 32).toString('hex'); o += 32;
  const n = buf.readUInt8(o); o += 1;

  if (buf.length !== HEADER + n * 33) {
    throw new Error(`memo length ${buf.length} does not match path length ${n}`);
  }
  const path: MerkleProofElement[] = [];
  for (let i = 0; i < n; i++) {
    const direction = buf.readUInt8(o); o += 1;
    if (direction !== 0 && direction !== 1) throw new Error(`bad direction ${direction}`);
    path.push({ direction, hash: buf.subarray(o, o + 32).toString('hex') });
    o += 32;
  }
  return { leaf, root, outcome, clearing_price_zat: Number(price), path };
}
