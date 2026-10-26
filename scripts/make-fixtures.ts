import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { AuctionParams, BondView, ReceivedNote, ScanView } from '../src/model.ts';
import { canonicalHash } from '../src/canonical.ts';
import { planRefunds, settleAuction, openAuction } from '../src/auction.ts';
import { broadcastRefunds, DEFAULT_MAX_OUTPUTS_PER_TX } from '../src/auction.ts';
import { SimulatedChain } from '../src/adapter.ts';
import { ovkCommitment, sha256Hex } from '../src/leaf.ts';
import { buildRefundArtifact } from '../src/refunds.ts';
import {
  encodeAccount,
  encodeBondView,
  encodeLeaves,
  encodeParams,
  encodeRefundArtifact,
  encodeReveal,
  encodeScan,
  encodeSettlement,
  settlementHash,
} from '../src/serialize.ts';
import { buildQuantumReport, redactQuantumReport } from '../src/quantum.ts';

/**
 * Fixture generator.
 *
 *   fixtures/auction-01/          spec 1, first price, 7 notes -> PASS
 *   fixtures/auction-02/          spec 2, uniform 3 units, bond, 9 notes -> PASS
 *   fixtures/tamper/t1-price/     clearing price edited          -> FAIL C7
 *   fixtures/tamper/t2-truncate/  one bid dropped                -> FAIL C5
 *   fixtures/tamper/t3-refund/    refund batch removed           -> FAIL C8
 *   fixtures/tamper/t4-transparent/ transparent bid admitted     -> FAIL C6
 *   fixtures/tamper/t5-two-prices/ two winners pay differently   -> FAIL C11
 *   fixtures/tamper/t6-bond-spent/ bond spent before reveal      -> FAIL C13
 *   fixtures/tamper/t7-pool/       account pool disagrees        -> FAIL C12
 *
 * The tampered variants recompute BOTH the merkle root (where relevant) and the
 * settlement hash, because that is the attacker we actually care about: one who
 * adopts every public commitment and still lies. Hash commitments (C1) protect
 * the archive; they cannot protect the truth.
 */

const ROOT = join(import.meta.dirname, '..');
const OUT = join(ROOT, 'fixtures');

const ZEC = 100_000_000n;
const OVK = sha256Hex(Buffer.from('demo-outgoing-viewing-key'));
const UFVK = 'uview1secbiddemoauctionviewingkey0000000000000000000000000000000000000000';
const AUCTION_ID_V1 = '0011223344556677';
const AUCTION_ID_V2 = sha256Hex(Buffer.from('secbid-fixture-auction-02')).slice(0, 32);
const ADDRESS_V1 = 'u1secbiddemoauctionaddress0000000000000000000000000000000000000000000';
const ADDRESS_V2 = 'u1secbiduniformauctionaddress00000000000000000000000000000000000000000';
const BOND_ADDRESS = 'u1secbidbondaddress0000000000000000000000000000000000000000000000';

function hexId(label: string): string {
  return sha256Hex(Buffer.from(label, 'utf8'));
}

function memoV1(refund: string): string {
  return JSON.stringify({ v: 1, refund });
}

function memoV2(refund: string, qty: number): string {
  return JSON.stringify({ v: 2, refund, qty: String(qty) });
}

function note(
  i: number,
  height: number,
  value: bigint,
  opts: { memo?: string | null; transparent?: boolean } = {},
): ReceivedNote {
  return {
    txid: hexId(`tx:${i}`),
    height,
    action_index: 0,
    value_zat: value,
    cm: hexId(`cm:${i}`),
    memo_raw: opts.memo === undefined ? memoV1(`u1refund${i}secbid000000000000000000000000`) : opts.memo,
    transparent_funded: opts.transparent ?? false,
    pool: 'orchard',
  };
}

function makeV1Params(): AuctionParams {
  return openAuction({
    spec: 1,
    auction_id: AUCTION_ID_V1,
    network: 'test',
    address: ADDRESS_V1,
    reserve_zat: 1n * ZEC,
    deadline_height: 3_120_000,
    settle_depth: 3,
    min_bid_zat: 10_000n,
    created_at_height: 3_110_000,
    ovk: OVK,
  });
}

function makeV1Notes(): ReceivedNote[] {
  return [
    note(0, 3_119_000, 5n * ZEC),
    note(1, 3_119_200, 9n * ZEC),
    note(2, 3_119_400, 7n * ZEC),
    note(3, 3_119_600, 12n * ZEC),
    note(4, 3_120_100, 30_000_000n),
    note(5, 3_119_300, 5_000n),
    note(6, 3_119_500, 8n * ZEC, { transparent: true }),
  ];
}

function makeV2Params(): AuctionParams {
  return openAuction({
    spec: 2,
    auction_id: AUCTION_ID_V2,
    network: 'test',
    address: ADDRESS_V2,
    reserve_zat: 1n * ZEC,
    deadline_height: 3_120_000,
    confirmations: 3,
    min_bid_zat: ZEC / 10n,
    rule: 'uniform',
    units: 3,
    pool: 'orchard',
    mode: 'public-tender',
    bond: { address: BOND_ADDRESS, amount_zat: 1n * ZEC },
    opened_at_height: 3_110_000,
    ovk: OVK,
  });
}

function makeV2Notes(): ReceivedNote[] {
  const n = (
    i: number,
    height: number,
    value: bigint,
    qty: number,
    opts: { memo?: string | null; transparent?: boolean } = {},
  ): ReceivedNote => ({
    txid: hexId(`tx2:${i}`),
    height,
    action_index: 0,
    value_zat: value,
    cm: hexId(`cm2:${i}`),
    memo_raw:
      opts.memo === undefined
        ? memoV2(`u1refund2-${i}secbid00000000000000000000000`, qty)
        : opts.memo,
    transparent_funded: opts.transparent ?? false,
    pool: 'orchard',
  });

  return [
    n(0, 3_119_000, 12n * ZEC, 1),
    n(1, 3_119_100, 9n * ZEC, 2),
    n(2, 3_119_200, 8n * ZEC, 1),
    n(3, 3_119_300, 13n * ZEC, 2),
    n(4, 3_119_400, 5n * ZEC, 1),
    n(5, 3_119_500, 2n * ZEC, 1),
    n(6, 3_120_100, 30_000_000n, 1),
    n(7, 3_119_600, 5_000n, 1),
    n(8, 3_119_700, 8n * ZEC, 1, { transparent: true }),
  ];
}

interface Built {
  files: Record<string, unknown>;
  memos: Map<string, Uint8Array>;
}

async function buildV1(): Promise<Built> {
  const params = makeV1Params();
  const notes = makeV1Notes();
  const view: ScanView = {
    chain_tx_count: new Set(notes.map((n) => n.txid)).size,
    chain_note_count: notes.length,
    notes,
    refund_outputs: [],
    ovk: OVK,
  };
  const chain = new SimulatedChain(view, { supportedPools: ['orchard', 'ironwood'] });
  const plan = planRefunds(params, notes);
  const batch = await broadcastRefunds(chain, plan, { maxOutputsPerTx: DEFAULT_MAX_OUTPUTS_PER_TX });
  const scan = chain.snapshot();
  const { settlement, proofs, memos } = settleAuction({
    params,
    notes,
    ufvk: UFVK,
    settle_height: params.deadline_height + params.confirmations,
    refunds: batch,
  });
  return {
    files: {
      'auction.json': encodeParams(params),
      'settlement.json': encodeSettlement(settlement),
      'scan.json': encodeScan(scan, 1),
      'proofs.json': proofs,
      'commitments.json': {
        params_hash: params.params_hash,
        settlement_hash: settlementHash(settlement),
      },
    },
    memos,
  };
}

async function buildV2(): Promise<Built> {
  const params = makeV2Params();
  const notes = makeV2Notes();
  const view: ScanView = {
    chain_tx_count: new Set(notes.map((n) => n.txid)).size,
    chain_note_count: notes.length,
    notes,
    refund_outputs: [],
    ovk: OVK,
  };
  const chain = new SimulatedChain(view, { supportedPools: ['orchard', 'ironwood'] });
  const plan = planRefunds(params, notes);
  // Three chunks at one height: the demo needs a real batched refund.
  const batch = await broadcastRefunds(chain, plan, { maxOutputsPerTx: 4 });
  const scan = chain.snapshot();
  const refundsArtifact = buildRefundArtifact(params.auction_id, plan, batch);
  const settleHeight = params.deadline_height + params.confirmations;
  const { settlement, proofs, memos } = settleAuction({
    params,
    notes,
    ufvk: UFVK,
    settle_height: settleHeight,
    refunds: batch,
    refunds_commitment: refundsArtifact.outputs_hash,
  });
  const bond: BondView = {
    txid: hexId('bond-funding'),
    address: BOND_ADDRESS,
    amount_zat: 1n * ZEC,
    commitment: params.bond!.commitment,
    funded_at_height: 3_111_000,
    spent_at_height: null,
    spend_txid: null,
  };
  const reveal = { ufvk: UFVK, reveal_height: settleHeight };
  const account = {
    account_uuid: '22222222-2222-4222-8222-222222222222',
    address: params.address,
    ufvk: UFVK,
    pool: 'orchard' as const,
    height: params.opened_at_height,
  };
  const quantum = redactQuantumReport(buildQuantumReport({ params, settlement, scan, reveal, bond }));
  return {
    files: {
      'auction.json': encodeParams(params),
      'account.json': encodeAccount(account),
      'settlement.json': encodeSettlement(settlement),
      'leaves.json': encodeLeaves(settlement),
      'scan.json': encodeScan(scan, 2),
      'proofs.json': proofs,
      'commitments.json': {
        params_hash: params.params_hash,
        settlement_hash: settlementHash(settlement),
      },
      'refunds.json': encodeRefundArtifact(refundsArtifact),
      'reveal.json': encodeReveal(reveal),
      'bond.json': encodeBondView(bond),
      'quantum.json': quantum,
    },
    memos,
  };
}

function writeBuilt(dir: string, built: Built) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const [name, value] of Object.entries(built.files)) {
    writeFileSync(join(dir, name), JSON.stringify(value, null, 2) + '\n', 'utf8');
  }
  if (built.memos.size > 0) {
    const memoDir = join(dir, 'memos');
    mkdirSync(memoDir, { recursive: true });
    for (const [leaf, memo] of built.memos) {
      writeFileSync(join(memoDir, `${leaf}.base64`), Buffer.from(memo).toString('base64') + '\n', 'utf8');
    }
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function withSettlementHash(files: Record<string, unknown>): Record<string, unknown> {
  const commitments = files['commitments.json'] as Record<string, unknown>;
  commitments.settlement_hash = canonicalHash(files['settlement.json']);
  return files;
}

async function main() {
  const v1 = await buildV1();
  const v2 = await buildV2();
  writeBuilt(join(OUT, 'auction-01'), v1);
  writeBuilt(join(OUT, 'auction-02'), v2);

  const tamperRoot = join(OUT, 'tamper');

  /* T1 — price edited, root untouched. */
  {
    const files = clone(v1.files);
    const settlement = files['settlement.json'] as Record<string, unknown>;
    settlement.clearing_price_zat = Number(settlement.clearing_price_zat) - 1;
    writeBuilt(join(tamperRoot, 't1-price'), { files: withSettlementHash(files), memos: new Map() });
  }

  /* T2 — one bid dropped, root and proofs recomputed consistently. */
  {
    const files = clone(v1.files);
    const settlement = files['settlement.json'] as { entries: Array<Record<string, unknown>> };
    settlement.entries = settlement.entries.filter(
      (entry) => !(entry.outcome === 'refunded' && entry.height === 3_119_000),
    );
    // Rebuild the tree over the truncated set so C2 and C3 still pass.
    const { rootOf, proofFor } = await import('../src/merkle.ts');
    const leaves = settlement.entries.map((e) => String(e.leaf));
    (settlement as unknown as Record<string, unknown>).merkle_root = rootOf(leaves);
    const proofs: Record<string, unknown> = {};
    leaves.forEach((leaf, i) => {
      proofs[leaf] = proofFor(leaves, i);
    });
    files['proofs.json'] = proofs;
    writeBuilt(join(tamperRoot, 't2-truncate'), { files: withSettlementHash(files), memos: new Map() });
  }

  /* T3 — refund batch removed, outcomes still claim refunds. */
  {
    const files = clone(v1.files);
    const settlement = files['settlement.json'] as Record<string, unknown>;
    settlement.refund_txs = [];
    for (const entry of settlement.entries as Array<Record<string, unknown>>) entry.refund_txid = null;
    writeBuilt(join(tamperRoot, 't3-refund'), { files: withSettlementHash(files), memos: new Map() });
  }

  /* T4 — transparent-funded note admitted into the bid set. */
  {
    const files = clone(v1.files);
    const settlement = files['settlement.json'] as { entries: Array<Record<string, unknown>> };
    const entry = settlement.entries.find((e) => e.outcome === 'transparent_funded')!;
    entry.outcome = 'refunded';
    writeBuilt(join(tamperRoot, 't4-transparent'), { files: withSettlementHash(files), memos: new Map() });
  }

  /* T5 — one uniform winner pays a different price than the rest. */
  {
    const files = clone(v2.files);
    const settlement = files['settlement.json'] as { entries: Array<Record<string, unknown>> };
    const winner = settlement.entries.find((e) => e.outcome === 'winner')!;
    winner.payment_zat = (BigInt(String(winner.payment_zat)) + 1n).toString(10);
    writeBuilt(join(tamperRoot, 't5-two-prices'), { files: withSettlementHash(files), memos: new Map() });
  }

  /* T6 — bond spent before reveal + grace. */
  {
    const files = clone(v2.files);
    const bond = files['bond.json'] as Record<string, unknown>;
    const settlement = files['settlement.json'] as Record<string, unknown>;
    bond.spent_at_height = Number(settlement.settle_height) - 1;
    bond.spend_txid = hexId('bond-spend-early');
    writeBuilt(join(tamperRoot, 't6-bond-spent'), { files, memos: new Map() });
  }

  /* T7 — account pool disagrees with the committed/received pool. */
  {
    const files = clone(v2.files);
    const account = files['account.json'] as Record<string, unknown>;
    account.pool = 'ironwood';
    writeBuilt(join(tamperRoot, 't7-pool'), { files, memos: new Map() });
  }

  console.log('fixtures written to', OUT);
  console.log('v1 root ', (v1.files['settlement.json'] as Record<string, unknown>).merkle_root);
  console.log('v1 price', (v1.files['settlement.json'] as Record<string, unknown>).clearing_price_zat);
  console.log('v2 root ', (v2.files['settlement.json'] as Record<string, unknown>).merkle_root);
  console.log('v2 price', (v2.files['settlement.json'] as Record<string, unknown>).clearing_price_zat);
  console.log('v2 accounting', (v2.files['settlement.json'] as Record<string, unknown>).accounting);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
