import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AuctionParams, ProofMap, ScanView, Settlement } from '../src/model.ts';
import { buildPaymentUri, parsePaymentUri, zatToZec, zecToZat } from '../src/zip321.ts';
import { decodeProofMemo, encodeProofMemo, maxPathLength, MAX_MEMO } from '../src/proof.ts';
import {
  broadcastRefunds,
  checkProofMemo,
  chunkRefundPlan,
  openAuction,
  planRefunds,
  settleAuction,
  singleRefundBatch,
} from '../src/auction.ts';
import { buildSettlement } from '../src/settlement.ts';
import { SimulatedChain } from '../src/adapter.ts';
import { verify } from '../src/verify.ts';
import { proofFor, rootOf } from '../src/merkle.ts';
import { decodeParams, decodeScan, decodeSettlement, settlementHash } from '../src/serialize.ts';

const ROOT = join(import.meta.dirname, '..');
const readRaw = (dir: string, name: string): unknown =>
  JSON.parse(readFileSync(join(ROOT, 'fixtures', dir, name), 'utf8')) as unknown;

const params: AuctionParams = decodeParams(readRaw('auction-01', 'auction.json'));
const view: ScanView = decodeScan(readRaw('auction-01', 'scan.json'));
const fixtureSettlement: Settlement = decodeSettlement(readRaw('auction-01', 'settlement.json'));
const fixtureProofs = readRaw('auction-01', 'proofs.json') as ProofMap;

test('zip321 amount conversion is exact at both ends', () => {
  assert.equal(zatToZec(1_500_000_000n), '15');
  assert.equal(zatToZec(120_000_000n), '1.2');
  assert.equal(zatToZec(1n), '0.00000001');
  assert.equal(zecToZat('0.00000001'), 1n);
  assert.equal(zecToZat('15'), 1_500_000_000n);
  assert.throws(() => zecToZat('1.123456789'), /invalid ZEC/);
});

test('zip321 round-trips address, amount, and memo bytes', () => {
  const memo = new Uint8Array(Buffer.from('{"v":2,"refund":"u1abc","qty":"1"}', 'utf8'));
  const uri = buildPaymentUri({ address: params.address, amount_zat: 700_000_000n, memo });
  assert.ok(uri.startsWith('zcash:u1'));
  assert.ok(uri.includes('amount=7'));

  const parsed = parsePaymentUri(uri);
  assert.equal(parsed.address, params.address);
  assert.equal(parsed.amount_zat, 700_000_000n);
  assert.deepEqual(Array.from(parsed.memo!), Array.from(memo));

  assert.throws(() => buildPaymentUri({ address: 't1transparent' }), /not a shielded address/);
  assert.throws(
    () => buildPaymentUri({ address: params.address, memo: new Uint8Array(513) }),
    /max 512/,
  );
});

test('proof memo round-trips and fits the deepest supported path', () => {
  const leaves = Array.from({ length: 7 }, (_, i) => (i % 16).toString(16).padStart(2, '0').repeat(32));
  const root = rootOf(leaves);
  const path = proofFor(leaves, 3);
  const memo = encodeProofMemo({
    leaf: leaves[3],
    root,
    outcome: 'refunded',
    clearing_price_zat: 1_200_000_000,
    path,
  });
  assert.ok(memo.length <= MAX_MEMO, `memo is ${memo.length} bytes`);

  const decoded = decodeProofMemo(memo);
  assert.equal(decoded.leaf, leaves[3]);
  assert.equal(decoded.root, root);
  assert.equal(decoded.outcome, 'refunded');
  assert.equal(decoded.clearing_price_zat, 1_200_000_000);
  assert.deepEqual(decoded.path, path);

  const deep = Array.from({ length: maxPathLength() }, () => ({ direction: 1 as const, hash: root }));
  const maxMemo = encodeProofMemo({ leaf: leaves[3], root, outcome: 'winner', clearing_price_zat: 1, path: deep });
  assert.ok(maxMemo.length <= MAX_MEMO);
  assert.equal(decodeProofMemo(maxMemo).path.length, maxPathLength());

  assert.throws(
    () =>
      encodeProofMemo({
        leaf: leaves[3],
        root,
        outcome: 'winner',
        clearing_price_zat: 1,
        path: [...deep, { direction: 1, hash: root }],
      }),
    /exceeds/,
  );
});

test('corrupted memos are rejected rather than silently accepted', () => {
  const leaves = [1, 2, 3].map((i) => i.toString(16).padStart(2, '0').repeat(32));
  const memo = encodeProofMemo({
    leaf: leaves[1],
    root: rootOf(leaves),
    outcome: 'refunded',
    clearing_price_zat: 5,
    path: proofFor(leaves, 1),
  });

  const badMagic = new Uint8Array(memo);
  badMagic[0] = 0x00;
  assert.throws(() => decodeProofMemo(badMagic), /magic/);

  const truncated = memo.slice(0, memo.length - 1);
  assert.throws(() => decodeProofMemo(truncated), /does not match/);
});

test('refund plan pays exactly the notes that can be refunded', async () => {
  const plan = planRefunds(params, view.notes);
  // 7 notes: winner stays, 6 are refunded (3 losers, 1 late, 1 dust, 1 transparent).
  assert.equal(plan.length, 6);
  assert.equal(plan.reduce((s, p) => s + p.value_zat, 0n), 2_930_005_000n);
  for (const p of plan) assert.ok(p.address.startsWith('u1'), 'refund address must be shielded');

  const stranded = {
    ...view.notes[0],
    txid: 'ee'.repeat(32),
    cm: 'dd'.repeat(32),
    memo_raw: null,
    height: 3_119_100,
  };
  const withStranded = planRefunds(params, [...view.notes, stranded]);
  assert.equal(withStranded.length, plan.length);
});

test('chain simulation settles, refunds, and verifies 14/14', async () => {
  const chain = new SimulatedChain({ ...view, refund_outputs: [] });
  const notes = await chain.scan();
  const plan = planRefunds(params, notes);
  const refundTx = await chain.sendRefunds(plan.map((p) => ({ address: p.address, value_zat: p.value_zat })));
  const { settlement, proofs, memos } = settleAuction({
    params,
    notes,
    ufvk: 'uview1x',
    settle_height: params.deadline_height + params.confirmations,
    refunds: singleRefundBatch(plan, refundTx),
  });

  const report = verify({
    params,
    settlement,
    scan: chain.snapshot(),
    proofs,
    commitments: { params_hash: params.params_hash, settlement_hash: settlementHash(settlement) },
  });
  assert.deepEqual(report.failures, []);
  assert.equal(report.status, 'PASS');
  assert.equal(report.checks.length, 14);
  assert.equal(settlement.result, 'sold');
  assert.equal(settlement.clearing_price_zat, 1_200_000_000n);
  assert.equal(memos.size, settlement.entries.length);

  for (const memo of memos.values()) {
    assert.ok(memo.length <= MAX_MEMO);
    assert.deepEqual(checkProofMemo(memo, settlement), { ok: true, problems: [] });
  }
});

test('a memo from a different auction does not check out', () => {
  const leaves = [1, 2, 3].map((i) => i.toString(16).padStart(2, '0').repeat(32));
  const memo = encodeProofMemo({
    leaf: leaves[0],
    root: rootOf(leaves),
    outcome: 'refunded',
    clearing_price_zat: 5,
    path: proofFor(leaves, 0),
  });
  const check = checkProofMemo(memo, fixtureSettlement);
  assert.equal(check.ok, false);
  assert.ok(check.problems.some((p) => p.includes('root')));
});

test('the honest fixture memos check out against its settlement', () => {
  const memos = readFileSync(join(ROOT, 'fixtures', 'auction-01', 'settlement.json'), 'utf8');
  void memos;
  for (const entry of fixtureSettlement.entries) {
    const path = fixtureProofs[entry.leaf];
    const memo = encodeProofMemo({
      leaf: entry.leaf,
      root: fixtureSettlement.merkle_root,
      outcome: entry.outcome,
      clearing_price_zat: Number(fixtureSettlement.clearing_price_zat),
      path,
    });
    assert.equal(checkProofMemo(memo, fixtureSettlement).ok, true, entry.leaf);
  }
});

test('duplicate note commitments are refused, not silently collapsed', () => {
  const note = view.notes[0];
  const clone = { ...note };
  assert.throws(
    () =>
      buildSettlement(params, [note, clone], {
        ufvk: 'uview1x',
        settle_height: 3_120_003,
        refunds: { txs: [{ txid: 'aa'.repeat(32), height: 3_120_005 }], by_leaf: {} },
      }),
    /duplicate note commitment/,
  );
});

test('a refund plan is split into same-height transactions, one per chunk', async () => {
  const chain = new SimulatedChain({ ...view, refund_outputs: [] });
  const notes = await chain.scan();
  const plan = planRefunds(params, notes);
  assert.equal(plan.length, 6);

  const batch = await broadcastRefunds(chain, plan, { maxOutputsPerTx: 2 });
  assert.equal(chunkRefundPlan(plan, 2).length, 3);
  assert.equal(batch.txs.length, 3);
  assert.equal(new Set(batch.txs.map((t) => t.height)).size, 1, 'every chunk lands at one height');
  assert.equal(Object.keys(batch.by_leaf).length, plan.length);

  const { settlement, proofs } = settleAuction({
    params,
    notes,
    ufvk: 'uview1x',
    settle_height: params.deadline_height + params.confirmations,
    refunds: batch,
  });

  const snapshot = chain.snapshot();
  for (const entry of settlement.entries) {
    if (entry.refund_txid === null) continue;
    const note = notes.find((n) => n.txid === entry.txid && n.action_index === entry.action_index)!;
    assert.equal(batch.by_leaf[entry.leaf], entry.refund_txid);
    assert.ok(
      snapshot.refund_outputs.some((o) => o.txid === entry.refund_txid && o.value_zat === note.value_zat),
      `no refund output for ${entry.leaf}`,
    );
  }

  const report = verify({
    params,
    settlement,
    scan: snapshot,
    proofs,
    commitments: { params_hash: params.params_hash, settlement_hash: settlementHash(settlement) },
  });
  assert.deepEqual(report.failures, []);
});

test('a refund batch that lands at different heights is caught by C8', () => {
  const notes = structuredClone(view.notes);
  const plan = planRefunds(params, notes);
  const chunks = chunkRefundPlan(plan, 3);
  const txs = [
    { txid: 'aa'.repeat(32), height: 3_120_005 },
    { txid: 'bb'.repeat(32), height: 3_120_006 },
  ];

  const by_leaf: Record<string, string> = {};
  const scan: ScanView = { ...structuredClone(view), refund_outputs: [] };
  for (const [i, chunk] of chunks.entries()) {
    for (const entry of chunk) {
      by_leaf[entry.leaf] = txs[i].txid;
      scan.refund_outputs.push({
        txid: txs[i].txid,
        height: txs[i].height,
        address: entry.address,
        value_zat: entry.value_zat,
      });
    }
  }

  const { settlement, proofs } = settleAuction({
    params,
    notes,
    ufvk: 'uview1x',
    settle_height: params.deadline_height + params.confirmations,
    refunds: { txs, by_leaf },
  });
  const report = verify({
    params,
    settlement,
    scan,
    proofs,
    commitments: { params_hash: params.params_hash, settlement_hash: settlementHash(settlement) },
  });
  assert.equal(report.failures[0]?.code, 'C8');
  assert.match(report.failures[0].message, /heights/);
});

test('a refund to a transparent address is rejected by C8', async () => {
  const chain = new SimulatedChain({ ...view, refund_outputs: [] });
  const notes = await chain.scan();
  const plan = planRefunds(params, notes);
  const batch = await broadcastRefunds(chain, plan);
  const { settlement, proofs } = settleAuction({
    params,
    notes,
    ufvk: 'uview1x',
    settle_height: params.deadline_height + params.confirmations,
    refunds: batch,
  });

  const scan = chain.snapshot();
  scan.refund_outputs[0].address = 't1transparentrefund';
  const report = verify({
    params,
    settlement,
    scan,
    proofs,
    commitments: { params_hash: params.params_hash, settlement_hash: settlementHash(settlement) },
  });
  assert.equal(report.failures[0]?.code, 'C8');
  assert.match(report.failures[0].message, /non-shielded/);
});

test('a refund to the wrong address is rejected by C8', async () => {
  const chain = new SimulatedChain({ ...view, refund_outputs: [] });
  const notes = await chain.scan();
  const plan = planRefunds(params, notes);
  const batch = await broadcastRefunds(chain, plan);
  const { settlement, proofs } = settleAuction({
    params,
    notes,
    ufvk: 'uview1x',
    settle_height: params.deadline_height + params.confirmations,
    refunds: batch,
  });
  const scan = chain.snapshot();
  scan.refund_outputs[0].address = 'u1someotherrefundaddress0000000000000000000000';
  const report = verify({
    params,
    settlement,
    scan,
    proofs,
    commitments: { params_hash: params.params_hash, settlement_hash: settlementHash(settlement) },
  });
  assert.equal(report.failures[0]?.code, 'C8');
});

test('two refunds to one address never share a transaction', () => {
  const chunks = chunkRefundPlan(
    [
      { key: 'k1', leaf: 'aa', address: 'u1reused', value_zat: 1n },
      { key: 'k2', leaf: 'bb', address: 'u1other', value_zat: 2n },
      { key: 'k3', leaf: 'cc', address: 'u1reused', value_zat: 3n },
    ],
    10,
  );
  assert.deepEqual(chunks.map((c) => c.map((e) => e.leaf)), [['aa', 'bb'], ['cc']]);
});

test('an empty refund plan needs no transaction and no chunk', async () => {
  assert.deepEqual(chunkRefundPlan([]), []);
  const chain = new SimulatedChain({ ...view, refund_outputs: [] });
  assert.deepEqual(await broadcastRefunds(chain, []), { txs: [], by_leaf: {} });
  assert.throws(() => chunkRefundPlan([{ key: 'k', leaf: 'aa', address: 'u1x', value_zat: 1n }], 0), /positive integer/);
});

test('openAuction commits the params and the OVK before any bid', () => {
  const opened = openAuction({
    spec: 2,
    auction_id: 'a1b2c3d4e5f60718a1b2c3d4e5f60718',
    network: 'test',
    address: params.address,
    reserve_zat: 100_000_000n,
    deadline_height: 3_120_000,
    confirmations: 3,
    min_bid_zat: 10_000n,
    rule: 'uniform',
    units: 3,
    pool: 'orchard',
    mode: 'public-tender',
    bond: { address: 'u1bond', amount_zat: 100_000_000n },
    opened_at_height: 3_110_000,
    ovk: 'cd'.repeat(32),
  });
  assert.match(opened.params_hash, /^[0-9a-f]{64}$/);
  assert.match(opened.ovk_commitment, /^[0-9a-f]{64}$/);
  assert.equal(opened.rule, 'uniform');
  assert.equal(opened.units, 3);
  assert.ok(opened.bond);
  assert.notEqual(opened.ovk_commitment, params.ovk_commitment);
  assert.equal(openAuction({
    spec: 1,
    auction_id: '0011223344556677',
    network: 'test',
    address: params.address,
    reserve_zat: 1n,
    deadline_height: 100,
    settle_depth: 1,
    min_bid_zat: 1n,
    created_at_height: 90,
    ovk: 'ab'.repeat(32),
  }).rule, 'first-price');
});
