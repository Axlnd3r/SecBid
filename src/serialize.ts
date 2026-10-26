import type {
  AccountFile,
  AuctionParams,
  Bond,
  BondView,
  Entry,
  NotePool,
  Pool,
  ReceivedNote,
  RefundArtifact,
  Reveal,
  ScanView,
  Settlement,
} from './model.ts';
import { canonicalHash } from './canonical.ts';

/**
 * Artifact codecs.
 *
 * Spec 1 artifacts use JSON numbers for zatoshi (the historical format); spec 2
 * uses decimal strings. Both decode into the same in-memory model, which uses
 * `bigint` everywhere. Nothing outside this file should care which one is on
 * disk; anything that hashes an artifact must hash the *encoded* form, because
 * `1200000000` and `"1200000000"` are different canonical JSON.
 */

export type JsonObject = Record<string, unknown>;

const HEX16 = /^[0-9a-f]{16}$/i;
const HEX32 = /^[0-9a-f]{32}$/i;
const HEX64 = /^[0-9a-f]{64}$/i;
const DECIMAL = /^(0|[1-9][0-9]*)$/;

export function parseZat(value: unknown, field: string): bigint {
  if (typeof value === 'bigint') {
    if (value < 0n) throw new Error(`${field}: zatoshi amount cannot be negative`);
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`${field}: not a safe non-negative integer: ${value}`);
    }
    return BigInt(value);
  }
  if (typeof value === 'string' && DECIMAL.test(value)) {
    return BigInt(value);
  }
  throw new Error(`${field}: expected a decimal zatoshi amount`);
}

export function encodeZat(value: bigint, spec: 1 | 2): number | string {
  if (typeof value !== 'bigint' || value < 0n) throw new Error('amount is not a non-negative bigint');
  if (spec === 2) return value.toString(10);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('spec 1 artifacts cannot represent an amount above 2^53-1');
  }
  return Number(value);
}

function int(value: unknown, field: string, min = 0): number {
  const n = typeof value === 'string' && DECIMAL.test(value) ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < min) {
    throw new Error(`${field}: expected an integer >= ${min}`);
  }
  return n;
}

function str(value: unknown, field: string): string {
  if (typeof value !== 'string' || value === '') throw new Error(`${field}: expected a non-empty string`);
  return value;
}

function optionalStr(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new Error(`${field}: expected a string or null`);
  return value;
}

function record(value: unknown, field: string): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${field}: expected an object`);
  }
  return value as JsonObject;
}

function array(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${field}: expected an array`);
  return value;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new Error(`${field}: expected one of ${allowed.join(', ')}`);
  }
  return value as T;
}

/* ── params ─────────────────────────────────────────────────────────────── */

function decodeBond(value: unknown): Bond | null {
  if (value === null || value === undefined) return null;
  const raw = record(value, 'bond');
  const address = str(raw.address, 'bond.address');
  if (!address.startsWith('u1') && !address.startsWith('zs1')) {
    throw new Error('bond.address: must be a shielded address');
  }
  return {
    address,
    amount_zat: parseZat(raw.amount_zat, 'bond.amount_zat'),
    commitment: str(raw.commitment, 'bond.commitment'),
  };
}

export function decodeParams(value: unknown): AuctionParams {
  const raw = record(value, 'auction.json');
  const spec: 1 | 2 | null =
    raw.spec === 2 || raw.spec === '2' ? 2 : raw.v === 1 || raw.v === '1' ? 1 : null;
  if (spec === null) throw new Error('auction.json: missing spec (2) or v (1)');

  const base = {
    spec,
    auction_id: str(raw.auction_id, 'auction_id'),
    network: (raw.network ?? 'test') as AuctionParams['network'],
    address: str(raw.address, 'address'),
    reserve_zat: parseZat(raw.reserve_zat, 'reserve_zat'),
    min_bid_zat: parseZat(raw.min_bid_zat, 'min_bid_zat'),
    deadline_height: int(raw.deadline_height, 'deadline_height'),
    ovk_commitment: str(raw.ovk_commitment, 'ovk_commitment'),
    params_hash: str(raw.params_hash, 'params_hash'),
  };
  if (base.network !== 'main' && base.network !== 'test' && base.network !== 'regtest') {
    throw new Error(`network: expected main, test, or regtest`);
  }
  if (base.auction_id.length !== (spec === 1 ? 16 : 32) || !/^[0-9a-f]+$/i.test(base.auction_id)) {
    throw new Error(`auction_id: expected ${spec === 1 ? 16 : 32} hex chars for spec ${spec}`);
  }
  if (!base.address.startsWith('u1') && !base.address.startsWith('zs1')) {
    throw new Error('address: auction address must be shielded');
  }

  if (spec === 1) {
    return {
      ...base,
      confirmations: int(raw.settle_depth ?? 0, 'settle_depth'),
      rule: 'first-price',
      units: 1,
      pool: 'orchard',
      mode: 'public-tender',
      bond: null,
      opened_at_height: int(raw.created_at_height, 'created_at_height'),
    };
  }

  const bond = decodeBond(raw.bond);
  return {
    ...base,
    confirmations: int(raw.confirmations, 'confirmations'),
    rule: oneOf(raw.rule, ['first-price', 'uniform'] as const, 'rule'),
    units: int(raw.units, 'units', 1),
    pool: oneOf(raw.pool, ['orchard', 'ironwood'] as const, 'pool'),
    mode: oneOf(raw.mode, ['public-tender', 'private'] as const, 'mode'),
    bond,
    opened_at_height: int(raw.opened_at_height, 'opened_at_height'),
    ...(typeof raw.pool_warning === 'string' && raw.pool_warning !== ''
      ? { pool_warning: raw.pool_warning }
      : {}),
  };
}

export function encodeParams(params: AuctionParams): JsonObject {
  if (params.spec === 1) {
    return {
      v: 1,
      auction_id: params.auction_id,
      network: params.network,
      address: params.address,
      reserve_zat: encodeZat(params.reserve_zat, 1),
      deadline_height: params.deadline_height,
      settle_depth: params.confirmations,
      min_bid_zat: encodeZat(params.min_bid_zat, 1),
      clearing_rule: 'first_price',
      created_at_height: params.opened_at_height,
      ovk_commitment: params.ovk_commitment,
      params_hash: params.params_hash,
    };
  }
  const out: JsonObject = {
    spec: 2,
    auction_id: params.auction_id,
    network: params.network,
    address: params.address,
    pool: params.pool,
    rule: params.rule,
    units: String(params.units),
    reserve_zat: encodeZat(params.reserve_zat, 2),
    min_bid_zat: encodeZat(params.min_bid_zat, 2),
    deadline_height: params.deadline_height,
    confirmations: params.confirmations,
    mode: params.mode,
    ovk_commitment: params.ovk_commitment,
    bond: params.bond
      ? {
          address: params.bond.address,
          amount_zat: encodeZat(params.bond.amount_zat, 2),
          commitment: params.bond.commitment,
        }
      : null,
    opened_at_height: params.opened_at_height,
    params_hash: params.params_hash,
  };
  if (params.pool_warning) out.pool_warning = params.pool_warning;
  return out;
}

export function paramsHash(params: Omit<AuctionParams, 'params_hash'> & { params_hash?: string }): string {
  const raw = encodeParams({ ...params, params_hash: '' } as AuctionParams);
  delete raw.params_hash;
  return canonicalHash(raw);
}

/* ── settlement ─────────────────────────────────────────────────────────── */

function decodeEntry(value: unknown): Entry {
  const raw = record(value, 'settlement entry');
  const txid = str(raw.txid, 'entry.txid');
  const action_index = int(raw.action_index, 'entry.action_index');
  const outcome = oneOf(
    raw.outcome,
    ['bid', 'winner', 'refunded', 'unsold', 'late', 'dust', 'stranded', 'transparent_funded'] as const,
    'entry.outcome',
  );
  return {
    key: `${txid}:${action_index}`,
    leaf: str(raw.leaf, 'entry.leaf'),
    txid,
    cm: str(raw.cm, 'entry.cm'),
    height: int(raw.height, 'entry.height'),
    action_index,
    outcome,
    refund_txid: optionalStr(raw.refund_txid, 'entry.refund_txid'),
    qty: raw.qty === undefined ? 1 : int(raw.qty, 'entry.qty', 1),
    filled_qty: raw.filled_qty === undefined ? (outcome === 'winner' ? 1 : 0) : int(raw.filled_qty, 'entry.filled_qty'),
    payment_zat: parseZat(raw.payment_zat ?? 0, 'entry.payment_zat'),
  };
}

export function decodeSettlement(value: unknown): Settlement {
  const raw = record(value, 'settlement.json');
  const spec = raw.spec === 2 || raw.spec === '2' ? 2 : 1;
  const entries = array(raw.entries, 'settlement.entries').map(decodeEntry);
  const accounting = record(raw.accounting, 'settlement.accounting');
  const winningLeaf = optionalStr(raw.winning_leaf, 'winning_leaf');
  const rawWinning = raw.winning_leaves === undefined ? null : array(raw.winning_leaves, 'winning_leaves');
  const refundsCommitment =
    typeof raw.refunds_commitment === 'string' ? raw.refunds_commitment : undefined;
  return {
    spec,
    auction_id: str(raw.auction_id, 'settlement.auction_id'),
    params_hash: str(raw.params_hash, 'settlement.params_hash'),
    ovk_commitment: str(raw.ovk_commitment, 'settlement.ovk_commitment'),
    ufvk: optionalStr(raw.ufvk, 'settlement.ufvk'),
    deadline_height: int(raw.deadline_height, 'settlement.deadline_height'),
    settle_height: int(raw.settle_height, 'settlement.settle_height'),
    entries,
    merkle_root: str(raw.merkle_root, 'settlement.merkle_root'),
    result: oneOf(raw.result, ['sold', 'unsold'] as const, 'settlement.result'),
    clearing_price_zat: parseZat(raw.clearing_price_zat, 'settlement.clearing_price_zat'),
    winning_leaf: winningLeaf,
    winning_leaves:
      rawWinning !== null
        ? rawWinning.map((leaf, i) => str(leaf, `winning_leaves[${i}]`))
        : winningLeaf
          ? [winningLeaf]
          : [],
    rule: oneOf(raw.rule ?? 'first-price', ['first-price', 'uniform'] as const, 'settlement.rule'),
    units: raw.units === undefined ? 1 : int(raw.units, 'settlement.units', 1),
    refund_txs: array(raw.refund_txs, 'settlement.refund_txs').map((tx) => {
      const t = record(tx, 'refund_tx');
      return { txid: str(t.txid, 'refund_tx.txid'), height: int(t.height, 'refund_tx.height') };
    }),
    ...(refundsCommitment ? { refunds_commitment: refundsCommitment } : {}),
    accounting: {
      refunded_zat: parseZat(accounting.refunded_zat, 'accounting.refunded_zat'),
      retained_zat: parseZat(accounting.retained_zat, 'accounting.retained_zat'),
      fees_zat: parseZat(accounting.fees_zat, 'accounting.fees_zat'),
    },
  };
}

export function encodeSettlement(settlement: Settlement): JsonObject {
  const spec = settlement.spec;
  const entries = settlement.entries.map((entry) =>
    spec === 1
      ? {
          leaf: entry.leaf,
          txid: entry.txid,
          cm: entry.cm,
          height: entry.height,
          action_index: entry.action_index,
          outcome: entry.outcome,
          refund_txid: entry.refund_txid,
        }
      : {
          leaf: entry.leaf,
          txid: entry.txid,
          cm: entry.cm,
          height: entry.height,
          action_index: entry.action_index,
          qty: String(entry.qty),
          filled_qty: String(entry.filled_qty),
          payment_zat: encodeZat(entry.payment_zat, 2),
          outcome: entry.outcome,
          refund_txid: entry.refund_txid,
        },
  );

  if (spec === 1) {
    return {
      v: 1,
      auction_id: settlement.auction_id,
      params_hash: settlement.params_hash,
      ovk_commitment: settlement.ovk_commitment,
      ufvk: settlement.ufvk,
      deadline_height: settlement.deadline_height,
      settle_height: settlement.settle_height,
      entries,
      merkle_root: settlement.merkle_root,
      result: settlement.result,
      clearing_price_zat: encodeZat(settlement.clearing_price_zat, 1),
      winning_leaf: settlement.winning_leaf,
      refund_txs: settlement.refund_txs,
      accounting: {
        refunded_zat: encodeZat(settlement.accounting.refunded_zat, 1),
        retained_zat: encodeZat(settlement.accounting.retained_zat, 1),
        fees_zat: encodeZat(settlement.accounting.fees_zat, 1),
      },
    };
  }

  const out: JsonObject = {
    spec: 2,
    auction_id: settlement.auction_id,
    params_hash: settlement.params_hash,
    ovk_commitment: settlement.ovk_commitment,
    ufvk: settlement.ufvk,
    deadline_height: settlement.deadline_height,
    settle_height: settlement.settle_height,
    rule: settlement.rule,
    units: String(settlement.units),
    entries,
    merkle_root: settlement.merkle_root,
    result: settlement.result,
    clearing_price_zat: encodeZat(settlement.clearing_price_zat, 2),
    winning_leaf: settlement.winning_leaf,
    winning_leaves: settlement.winning_leaves,
    refund_txs: settlement.refund_txs,
    accounting: {
      refunded_zat: encodeZat(settlement.accounting.refunded_zat, 2),
      retained_zat: encodeZat(settlement.accounting.retained_zat, 2),
      fees_zat: encodeZat(settlement.accounting.fees_zat, 2),
    },
  };
  if (settlement.refunds_commitment) out.refunds_commitment = settlement.refunds_commitment;
  return out;
}

/**
 * leaves.json: the leaf table with outcomes and units, never amounts. This is
 * what makes a private-mode artifact publishable at all.
 */
export function encodeLeaves(settlement: Settlement): JsonObject {
  return {
    spec: 2,
    auction_id: settlement.auction_id,
    merkle_root: settlement.merkle_root,
    entries: settlement.entries.map((entry) => ({
      leaf: entry.leaf,
      txid: entry.txid,
      height: entry.height,
      action_index: entry.action_index,
      qty: String(entry.qty),
      filled_qty: String(entry.filled_qty),
      outcome: entry.outcome,
      refund_txid: entry.refund_txid,
    })),
  };
}

export function settlementHash(settlement: Settlement): string {
  return canonicalHash(encodeSettlement(settlement));
}

/* ── scan / account / reveal / bond / refunds ───────────────────────────── */

function decodePool(value: unknown, fallback: NotePool = 'orchard'): NotePool {
  return oneOf(value ?? fallback, ['orchard', 'ironwood', 'sapling'] as const, 'pool');
}

function decodeNote(value: unknown): ReceivedNote {
  const raw = record(value, 'scan note');
  return {
    txid: str(raw.txid, 'note.txid'),
    height: int(raw.height, 'note.height'),
    action_index: int(raw.action_index, 'note.action_index'),
    value_zat: parseZat(raw.value_zat, 'note.value_zat'),
    cm: str(raw.cm, 'note.cm'),
    memo_raw: optionalStr(raw.memo_raw, 'note.memo_raw'),
    transparent_funded: raw.transparent_funded === true,
    pool: decodePool(raw.pool),
  };
}

export function decodeScan(value: unknown): ScanView {
  const raw = record(value, 'scan.json');
  return {
    chain_tx_count: int(raw.chain_tx_count, 'scan.chain_tx_count'),
    chain_note_count: int(raw.chain_note_count, 'scan.chain_note_count'),
    notes: array(raw.notes, 'scan.notes').map(decodeNote),
    refund_outputs: array(raw.refund_outputs, 'scan.refund_outputs').map((output) => {
      const o = record(output, 'refund output');
      return {
        txid: str(o.txid, 'refund_output.txid'),
        height: int(o.height, 'refund_output.height'),
        address: str(o.address, 'refund_output.address'),
        value_zat: parseZat(o.value_zat, 'refund_output.value_zat'),
        ...(o.pool === undefined ? {} : { pool: decodePool(o.pool) }),
      };
    }),
    ovk: typeof raw.ovk === 'string' ? raw.ovk : '',
  };
}

export function encodeScan(view: ScanView, spec: 1 | 2): JsonObject {
  const notes = view.notes.map((note) => ({
    txid: note.txid,
    height: note.height,
    action_index: note.action_index,
    value_zat: encodeZat(note.value_zat, spec),
    cm: note.cm,
    memo_raw: note.memo_raw,
    transparent_funded: note.transparent_funded,
    ...(spec === 2 ? { pool: note.pool } : {}),
  }));
  const refunds = view.refund_outputs.map((output) => ({
    txid: output.txid,
    height: output.height,
    address: output.address,
    value_zat: encodeZat(output.value_zat, spec),
    ...(spec === 2 && output.pool ? { pool: output.pool } : {}),
  }));
  return {
    ...(spec === 1 ? {} : { spec: 2 }),
    chain_tx_count: view.chain_tx_count,
    chain_note_count: view.chain_note_count,
    notes,
    refund_outputs: refunds,
    ovk: view.ovk,
  };
}

export function decodeAccount(value: unknown): AccountFile {
  const raw = record(value, 'account.json');
  return {
    account_uuid: str(raw.account_uuid, 'account.account_uuid'),
    address: str(raw.address, 'account.address'),
    ufvk: str(raw.ufvk, 'account.ufvk'),
    pool: oneOf(raw.pool ?? 'orchard', ['orchard', 'ironwood'] as const, 'account.pool') as Pool,
    height: int(raw.height ?? 0, 'account.height'),
  };
}

export function encodeAccount(account: AccountFile): JsonObject {
  return {
    account_uuid: account.account_uuid,
    address: account.address,
    ufvk: account.ufvk,
    pool: account.pool,
    height: account.height,
  };
}

export function decodeReveal(value: unknown): Reveal {
  const raw = record(value, 'reveal.json');
  return {
    ufvk: str(raw.ufvk, 'reveal.ufvk'),
    reveal_height: int(raw.reveal_height, 'reveal.reveal_height'),
  };
}

export function encodeReveal(reveal: Reveal): JsonObject {
  return { ufvk: reveal.ufvk, reveal_height: reveal.reveal_height };
}

export function decodeBondView(value: unknown): BondView {
  const raw = record(value, 'bond.json');
  return {
    txid: str(raw.txid, 'bond.txid'),
    address: str(raw.address, 'bond.address'),
    amount_zat: parseZat(raw.amount_zat, 'bond.amount_zat'),
    commitment: str(raw.commitment, 'bond.commitment'),
    funded_at_height: int(raw.funded_at_height, 'bond.funded_at_height'),
    spent_at_height: raw.spent_at_height === null || raw.spent_at_height === undefined
      ? null
      : int(raw.spent_at_height, 'bond.spent_at_height'),
    spend_txid: optionalStr(raw.spend_txid, 'bond.spend_txid'),
  };
}

export function encodeBondView(view: BondView): JsonObject {
  return {
    txid: view.txid,
    address: view.address,
    amount_zat: encodeZat(view.amount_zat, 2),
    commitment: view.commitment,
    funded_at_height: view.funded_at_height,
    spent_at_height: view.spent_at_height,
    spend_txid: view.spend_txid,
  };
}

export function decodeRefundArtifact(value: unknown): RefundArtifact {
  const raw = record(value, 'refunds.json');
  return {
    spec: 2,
    auction_id: str(raw.auction_id, 'refunds.auction_id'),
    txs: array(raw.txs, 'refunds.txs').map((tx) => {
      const t = record(tx, 'refunds.tx');
      return {
        txid: str(t.txid, 'refunds.tx.txid'),
        height: int(t.height, 'refunds.tx.height'),
        output_count: int(t.output_count, 'refunds.tx.output_count'),
      };
    }),
    output_count: int(raw.output_count, 'refunds.output_count'),
    outputs_hash: str(raw.outputs_hash, 'refunds.outputs_hash'),
  };
}

export function encodeRefundArtifact(artifact: RefundArtifact): JsonObject {
  return {
    spec: 2,
    auction_id: artifact.auction_id,
    txs: artifact.txs,
    output_count: artifact.output_count,
    outputs_hash: artifact.outputs_hash,
  };
}

export function isHex32(value: unknown): value is string {
  return typeof value === 'string' && HEX32.test(value);
}

export function isHex64(value: unknown): value is string {
  return typeof value === 'string' && HEX64.test(value);
}

export function isHex16(value: unknown): value is string {
  return typeof value === 'string' && HEX16.test(value);
}
