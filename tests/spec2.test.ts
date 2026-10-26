import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AuctionParams, ReceivedNote } from '../src/model.ts';
import { chunkRefundPlan, openAuction, planRefunds, settleAuction } from '../src/auction.ts';
import { classifyAll, clear } from '../src/clearing.ts';
import { buildMemoV2, memoBytes, parseMemo } from '../src/memo.ts';
import { leafForNote, leafV2Hex, refundCommit, refundSalt } from '../src/leaf.ts';
import { SimulatedChain, choosePool } from '../src/adapter.ts';
import { createBond, checkBond } from '../src/bond.ts';
import {
  buildQuantumReport,
  QUANTUM_DISCLAIMER,
  redactQuantumReport,
  renderQuantumReport,
} from '../src/quantum.ts';
import { buildAgentBid, parseMandate } from '../src/agent.ts';
import { decodeParams, decodeScan, decodeSettlement, paramsHash, encodeParams } from '../src/serialize.ts';
import { buildRefundArtifact } from '../src/refunds.ts';
import { broadcastRefunds } from '../src/auction.ts';
import { settleAuction as settle } from '../src/auction.ts';

const ROOT = join(import.meta.dirname, '..');
const ZEC = 100_000_000n;
const raw = (dir: string, name: string): unknown =>
  JSON.parse(readFileSync(join(ROOT, 'fixtures', dir, name), 'utf8')) as unknown;
const fixture02 = decodeParams(raw('auction-02', 'auction.json'));

function uniformParams(units = 3): AuctionParams {
  return openAuction({
    spec: 2,
    auction_id: '00112233445566778899aabbccddeeff',
    network: 'test',
    address: 'u1uniformtestaddress00000000000000000000000',
    reserve_zat: 1n * ZEC,
    deadline_height: 1000,
    confirmations: 3,
    min_bid_zat: ZEC / 10n,
    rule: 'uniform',
    units,
    pool: 'orchard',
    mode: 'public-tender',
    opened_at_height: 900,
    ovk: 'ab'.repeat(32),
  });
}

let counter = 0;
function bid(height: number, amount: bigint, qty: number, opts: { refund?: string; memo?: string | null } = {}): ReceivedNote {
  counter += 1;
  return {
    txid: counter.toString(16).padStart(64, '0'),
    height,
    action_index: 0,
    value_zat: amount,
    cm: (counter + 5000).toString(16).padStart(64, '0'),
    memo_raw: opts.memo === undefined ? JSON.stringify({ v: 2, refund: opts.refund ?? `u1refund-${counter}`, qty: String(qty) }) : opts.memo,
    transparent_funded: false,
    pool: 'orchard',
  };
}

function run(notes: ReceivedNote[], params = uniformParams()) {
  const classified = classifyAll(notes, params);
  return { classified, result: clear(classified, params) };
}

test('memo v2 is strict about keys, sizes, and quantities', () => {
  assert.equal(parseMemo('{"v":2,"refund":"u1x","qty":"2"}').ok, true);
  assert.equal(parseMemo('{"v":2,"refund":"u1x"}').ok, true);
  assert.equal(parseMemo('{"v":2,"refund":"u1x","qty":2}').ok, false);
  assert.equal(parseMemo('{"v":2,"refund":"u1x","qty":"0"}').ok, false);
  assert.equal(parseMemo('{"v":2,"refund":"u1x","qty":"1","label":"x"}').ok, false);
  assert.equal(parseMemo('{"v":1,"refund":"u1x","qty":"1"}').ok, false);
  assert.equal(parseMemo(`{"v":2,"refund":"u1x","qty":"1"}${' '.repeat(500)}`).ok, false);

  const memo = buildMemoV2('u1refund', 2);
  assert.ok(memoBytes(memo).length <= 512);
  assert.throws(() => buildMemoV2('t1transparent', 1), /shielded/);
});

test('leaf v2 commits the auction, amount, qty, refund commitment, and outcome', () => {
  const golden = JSON.parse(readFileSync(join(ROOT, 'tests', 'golden', 'leaf-v2.json'), 'utf8')) as {
    input: {
      auction_id: string;
      txid: string;
      action_index: number;
      amount_zat: string;
      qty: string;
      refund_address: string;
      outcome: string;
    };
    salt: string;
    refund_commit: string;
    leaf: string;
  };
  const input = golden.input;
  const salt = refundSalt(input.auction_id, input.txid, input.action_index);
  assert.equal(salt, golden.salt);
  const commit = refundCommit(input.refund_address, salt);
  assert.equal(commit, golden.refund_commit);
  assert.equal(
    leafV2Hex({
      auction_id: input.auction_id,
      txid: input.txid,
      action_index: input.action_index,
      amount_zat: BigInt(input.amount_zat),
      qty: Number(input.qty),
      refund_commit: commit,
      outcome: input.outcome as 'winner',
    }),
    golden.leaf,
  );

  // The outcome is part of the leaf: a note cannot claim "winner" and "refunded"
  // with the same commitment.
  const other = leafForNote(
    input.auction_id,
    {
      txid: input.txid,
      action_index: input.action_index,
      value_zat: BigInt(input.amount_zat),
      qty: Number(input.qty),
      refund_address: input.refund_address,
    },
    'refunded',
  );
  assert.notEqual(other, golden.leaf);
});

test('uniform: undersubscribed pays the lowest accepted price', () => {
  const notes = [bid(950, 5n * ZEC, 1), bid(951, 4n * ZEC, 1)];
  const { result } = run(notes);
  assert.equal(result.result, 'sold');
  assert.equal(result.clearing_price_zat, 4n * ZEC);
  assert.equal(result.retained_zat, 8n * ZEC);
  assert.deepEqual(result.winning_leaves.length, 2);
  const refunds = result.refunds.reduce((s, r) => s + r.value_zat, 0n);
  assert.equal(refunds, 1n * ZEC);
});

test('uniform: oversubscribed sells exactly N units and refunds the rest', () => {
  const notes = [12n, 8n, 5n, 2n].map((v, i) => bid(950 + i, v * ZEC, 1));
  const { result } = run(notes);
  assert.equal(result.clearing_price_zat, 5n * ZEC);
  assert.equal(result.retained_zat, 15n * ZEC);
  assert.equal(result.winning_leaves.length, 3);
  assert.equal(result.refunds.reduce((s, r) => s + r.value_zat, 0n), 7n * ZEC + 3n * ZEC + 2n * ZEC);
});

test('uniform: exact demand still pays the lowest accepted bid', () => {
  const notes = [6n, 4n, 3n].map((v, i) => bid(950 + i, v * ZEC, 1));
  const { result } = run(notes);
  assert.equal(result.clearing_price_zat, 3n * ZEC);
  assert.equal(result.retained_zat, 9n * ZEC);
  assert.equal(result.winning_leaves.length, 3);
  assert.equal(result.refunds.reduce((s, r) => s + r.value_zat, 0n), 3n * ZEC + 1n * ZEC);
});

test('uniform: a tie is broken by height, then txid, then action index', () => {
  const early = bid(950, 5n * ZEC, 1);
  const late = bid(960, 5n * ZEC, 1);
  const { result } = run([late, early]);
  // Both fit in 2 units, so both win; the tie-break decides who is first.
  assert.equal(result.winning_leaves.length, 2);
  const firstLeaf = result.winning_leaves[0];
  assert.equal(firstLeaf, result.leaves.get(early.txid + ':0'));
});

test('uniform: only the marginal bid is partially filled, and its excess is refunded', () => {
  const notes = [bid(950, 12n * ZEC, 1), bid(951, 8n * ZEC, 1), bid(952, 13n * ZEC, 2)];
  const { classified, result } = run(notes);
  assert.equal(result.clearing_price_zat, 650_000_000n); // 6.5 ZEC
  assert.equal(result.retained_zat, 1_950_000_000n);
  const marginal = classified.find((n) => n.value_zat === 13n * ZEC)!;
  assert.equal(result.filled.get(marginal.key), 1);
  assert.equal(result.payments.get(marginal.key), 650_000_000n);
  const marginalRefund = result.refunds.find((r) => r.key === marginal.key)!;
  assert.equal(marginalRefund.value_zat, 650_000_000n);
  assert.equal(result.refunds.reduce((s, r) => s + r.value_zat, 0n) + result.retained_zat, notes.reduce((s, n) => s + n.value_zat, 0n));
});

test('uniform settlement and refunds satisfy the accounting identity and verify', async () => {
  const params = uniformParams();
  const notes = [bid(950, 12n * ZEC, 1), bid(951, 8n * ZEC, 1), bid(952, 13n * ZEC, 2), bid(953, 2n * ZEC, 1)];
  const view = {
    chain_tx_count: notes.length,
    chain_note_count: notes.length,
    notes,
    refund_outputs: [],
    ovk: 'ab'.repeat(32),
  };
  const chain = new SimulatedChain(view);
  const plan = planRefunds(params, notes);
  const batch = await broadcastRefunds(chain, plan, { maxOutputsPerTx: 2 });
  const refunds = buildRefundArtifact(params.auction_id, plan, batch);
  const { settlement, proofs } = settle({
    params,
    notes,
    ufvk: 'uview1x',
    settle_height: 1003,
    refunds: batch,
    refunds_commitment: refunds.outputs_hash,
  });
  assert.equal(settlement.rule, 'uniform');
  assert.equal(settlement.entries.filter((e) => e.outcome === 'winner').length, 3);
  assert.equal(settlement.accounting.retained_zat, 1_950_000_000n);
  assert.equal(
    settlement.accounting.refunded_zat + settlement.accounting.retained_zat,
    notes.reduce((s, n) => s + n.value_zat, 0n),
  );
  assert.ok(proofs[settlement.merkle_root] === undefined);
});

test('spec-2 params golden hash is stable', () => {
  const golden = JSON.parse(readFileSync(join(ROOT, 'tests', 'golden', 'params-v2.json'), 'utf8')) as {
    params: Record<string, unknown>;
    params_hash: string;
  };
  const params = decodeParams({ ...golden.params, params_hash: golden.params_hash });
  assert.equal(paramsHash(params), golden.params_hash);
  assert.equal(encodeParams(params).params_hash, golden.params_hash);
});

test('bond must be funded before the first bid and unspent through reveal + grace', () => {
  const params = fixture02;
  assert.ok(params.bond);
  const bond = createBond(params.auction_id, params.bond!.address, params.bond!.amount_zat);
  assert.equal(bond.commitment, params.bond!.commitment);

  const view = {
    txid: 'aa'.repeat(32),
    address: params.bond!.address,
    amount_zat: params.bond!.amount_zat,
    commitment: params.bond!.commitment,
    funded_at_height: 900,
    spent_at_height: null,
    spend_txid: null,
  };
  assert.equal(checkBond(params, view, { firstBidHeight: 950, releaseHeight: 1003 }).ok, true);
  assert.equal(
    checkBond(params, { ...view, funded_at_height: 960 }, { firstBidHeight: 950, releaseHeight: 1003 }).ok,
    false,
  );
  assert.equal(
    checkBond(params, { ...view, spent_at_height: 1000, spend_txid: 'bb'.repeat(32) }, { firstBidHeight: 950, releaseHeight: 1003 }).ok,
    false,
  );
  assert.equal(
    checkBond(params, { ...view, spent_at_height: 1200, spend_txid: 'bb'.repeat(32) }, { firstBidHeight: 950, releaseHeight: 1003 }).ok,
    true,
  );
});

test('quantum report counts pools, names published items, and keeps the disclaimer', () => {
  const params = fixture02;
  const scan = decodeScan(raw('auction-02', 'scan.json'));
  const settlement = decodeSettlement(raw('auction-02', 'settlement.json'));
  const report = buildQuantumReport({ params, scan, settlement });
  assert.equal(report.disclaimer, QUANTUM_DISCLAIMER);
  assert.equal(report.notes.total, 9);
  assert.equal(report.notes.by_pool.orchard, 9);
  assert.equal(report.notes.recoverable, 0);
  assert.ok(report.published.some((p) => p.kind === 'auction_address'));
  assert.ok(report.published.some((p) => p.kind === 'bond_address'));
  assert.ok(report.exposed.some((line) => line.includes('not in the quantum-recoverable pool')));
  assert.match(renderQuantumReport(report), /Quantum-recoverable ≠ post-quantum/);
});

test('the published quantum report fingerprints refund addresses instead of naming them', () => {
  const reused = 'u1reusedquantumaddress000000000000000000000000';
  const notes = [
    bid(950, 5n * ZEC, 1, { refund: reused }),
    bid(951, 4n * ZEC, 1, { refund: reused }),
  ];
  const scan = {
    chain_tx_count: notes.length,
    chain_note_count: notes.length,
    notes,
    refund_outputs: [],
    ovk: 'ab'.repeat(32),
  };
  const local = buildQuantumReport({ params: uniformParams(1), scan });
  assert.equal(local.refund_reuse.entries[0]?.address, reused);
  assert.equal(local.refund_reuse.entries[0]?.uses, 2);
  assert.equal(local.refund_reuse.entries[0]?.address_fingerprint.length, 64);

  const withHistory = buildQuantumReport({ params: uniformParams(1), scan, history: [reused] });
  assert.equal(withHistory.refund_reuse.reused_across_auctions, 1);
  assert.equal(withHistory.refund_reuse.entries[0]?.cross_auction, true);
  assert.match(renderQuantumReport(withHistory), /earlier auction/);

  const published = redactQuantumReport(local);
  assert.equal(published.refund_reuse.entries[0]?.address, undefined);
  assert.equal(published.refund_reuse.entries[0]?.address_fingerprint, local.refund_reuse.entries[0]?.address_fingerprint);
  assert.ok(!JSON.stringify(published).includes(reused), 'quantum.json must not publish a refund address');
  assert.ok(!renderQuantumReport(published).includes(reused), 'redacted output must not name the address');
});

test('two refund chunks with identical outputs get distinct simulated txids', async () => {
  const params = uniformParams(1);
  const reused = 'u1reusedrefundaddress000000000000000000000000';
  const notes = [
    bid(950, 10n * ZEC, 1),
    bid(951, 4n * ZEC, 1, { refund: reused }),
    bid(952, 4n * ZEC, 1, { refund: reused }),
  ];
  const chain = new SimulatedChain({
    chain_tx_count: notes.length,
    chain_note_count: notes.length,
    notes,
    refund_outputs: [],
    ovk: 'ab'.repeat(32),
  });
  const plan = planRefunds(params, notes);
  assert.equal(plan.length, 2);
  const batch = await broadcastRefunds(chain, plan, { maxOutputsPerTx: 10 });
  assert.equal(batch.txs.length, 2, 'duplicate recipients cannot share a tx');
  assert.notEqual(batch.txs[0].txid, batch.txs[1].txid);
  assert.equal(new Set(Object.values(batch.by_leaf)).size, 2);
  assert.equal(chain.snapshot().refund_outputs.length, 2);
});

test('a refund adapter that reuses a txid is refused, not published', async () => {
  const params = uniformParams(1);
  const reused = 'u1reusedrefundaddress000000000000000000000000';
  const notes = [
    bid(950, 10n * ZEC, 1),
    bid(951, 4n * ZEC, 1, { refund: reused }),
    bid(952, 4n * ZEC, 1, { refund: reused }),
  ];
  const plan = planRefunds(params, notes);
  const bad = {
    async sendRefunds() {
      return { txid: 'aa'.repeat(32), height: 1004 };
    },
  } as unknown as SimulatedChain;
  await assert.rejects(
    () => broadcastRefunds(bad, plan, { maxOutputsPerTx: 10 }),
    /two chunks/,
  );
});

test('reused refund addresses are flagged and never share a refund transaction', () => {
  const params = uniformParams(1);
  const reused = 'u1reusedrefundaddress000000000000000000000000';
  const notes = [
    bid(950, 10n * ZEC, 1),
    bid(951, 5n * ZEC, 1, { refund: reused }),
    bid(952, 4n * ZEC, 1, { refund: reused }),
  ];
  const classified = classifyAll(notes, params);
  assert.equal(classified[1].refund_reused, true);
  assert.equal(classified[2].refund_reused, true);
  const plan = planRefunds(params, notes);
  assert.equal(plan.length, 2);
  assert.equal(plan[0].address, plan[1].address);
  const chunks = chunkRefundPlan(plan, 10);
  assert.equal(chunks.length, 2, 'a reused address forces one refund transaction per entry');
  assert.notEqual(chunks[0][0].leaf, chunks[1][0].leaf);
});


test('pool auto falls back to orchard with a recorded warning', async () => {
  const chain = new SimulatedChain(
    { chain_tx_count: 0, chain_note_count: 0, notes: [], refund_outputs: [], ovk: '' },
    { supportedPools: ['orchard'] },
  );
  const fallback = await choosePool(chain, 'auto');
  assert.equal(fallback.pool, 'orchard');
  assert.match(fallback.warning ?? '', /fell back to orchard/);
  const explicit = await choosePool(chain, 'orchard');
  assert.equal(explicit.pool, 'orchard');
  await assert.rejects(() => choosePool(chain, 'ironwood'), /Ironwood/);

  const capable = new SimulatedChain(
    { chain_tx_count: 0, chain_note_count: 0, notes: [], refund_outputs: [], ovk: '' },
    { supportedPools: ['orchard', 'ironwood'] },
  );
  assert.equal((await choosePool(capable, 'auto')).pool, 'ironwood');
});

test('agent builds a memo-v2 bid inside its mandate', () => {
  const mandate = parseMandate({
    v: 1,
    max_price_zat: '200000000',
    quantity: '2',
    refund_address: 'u1agentrefundaddress000000000000000000000000',
    bid_price_zat: '150000000',
  });
  assert.equal(mandate.ok, true);
  if (!mandate.ok) return;
  const built = buildAgentBid(fixture02, mandate.mandate);
  assert.equal(built.amount_zat, 300_000_000n);
  assert.equal(built.memo.qty, 2);
  assert.match(built.uri, /amount=3/);
  assert.match(built.memo_text, /"qty":"2"/);

  assert.equal(parseMandate({ v: 1, max_price_zat: '1', quantity: '1', refund_address: 't1x' }).ok, false);
  assert.equal(
    parseMandate({ v: 1, max_price_zat: '1', quantity: '1', refund_address: 'u1x', extra: 1 }).ok,
    false,
  );
  assert.throws(
    () =>
      buildAgentBid(fixture02, {
        v: 1,
        max_price_zat: 10n * ZEC,
        quantity: 2,
        refund_address: 'u1agentrefundaddress000000000000000000000000',
        bid_price_zat: ZEC / 2n,
      }),
    /below the reserve/,
  );
});
