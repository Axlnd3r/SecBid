import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Commitments, ProofMap, ReceivedNote, ScanView } from '../src/model.ts';
import { canonicalHash } from '../src/canonical.ts';
import { openAuction, planRefunds, settleAuction, singleRefundBatch } from '../src/auction.ts';
import { verify } from '../src/verify.ts';
import {
  decodeAccount,
  decodeBondView,
  decodeParams,
  decodeRefundArtifact,
  decodeReveal,
  decodeScan,
  decodeSettlement,
  paramsHash,
  settlementHash,
} from '../src/serialize.ts';

const ROOT = join(import.meta.dirname, '..');

function load(dir: string) {
  const read = (name: string): unknown =>
    JSON.parse(readFileSync(join(ROOT, dir, name), 'utf8')) as unknown;
  const optional = (name: string): unknown | null =>
    existsSync(join(ROOT, dir, name)) ? read(name) : null;
  const params = decodeParams(read('auction.json'));
  const settlement = decodeSettlement(read('settlement.json'));
  const accountRaw = optional('account.json');
  const revealRaw = optional('reveal.json');
  const bondRaw = optional('bond.json');
  const refundsRaw = optional('refunds.json');
  return {
    params,
    settlement,
    scan: decodeScan(read('scan.json')),
    proofs: read('proofs.json') as ProofMap,
    commitments: read('commitments.json') as Commitments,
    ...(accountRaw ? { account: decodeAccount(accountRaw) } : {}),
    ...(revealRaw ? { reveal: decodeReveal(revealRaw) } : {}),
    bond: bondRaw ? decodeBondView(bondRaw) : null,
    ...(refundsRaw ? { refunds: decodeRefundArtifact(refundsRaw) } : {}),
  };
}

test('honest spec-1 fixture passes every check', () => {
  const report = verify(load('fixtures/auction-01'));
  assert.deepEqual(report.failures, []);
  assert.equal(report.ok, true);
  assert.equal(report.status, 'PASS');
  assert.equal(report.checks.length, 14);
  assert.ok(report.checks.every((c) => c.status === 'pass'), JSON.stringify(report.checks, null, 2));
});

test('honest spec-2 uniform fixture passes every check, including C11-C13', () => {
  const bundle = load('fixtures/auction-02');
  const report = verify(bundle);
  assert.deepEqual(report.failures, []);
  assert.equal(report.status, 'PASS');
  assert.equal(report.checks.length, 14);
  assert.equal(bundle.params.rule, 'uniform');
  assert.equal(bundle.settlement.entries.filter((e) => e.outcome === 'winner').length, 3);
  assert.equal(bundle.settlement.entries.find((e) => e.outcome === 'winner' && e.filled_qty < e.qty)?.qty, 2);
  for (const code of ['C11', 'C12', 'C13']) {
    assert.equal(report.checks.find((c) => c.code === code)?.status, 'pass', code);
  }
});

const cases: Array<[string, string, string]> = [
  ['fixtures/tamper/t1-price', 'C7', 'clearing price'],
  ['fixtures/tamper/t2-truncate', 'C5', 'truncation'],
  ['fixtures/tamper/t3-refund', 'C8', 'refund'],
  ['fixtures/tamper/t4-transparent', 'C6', 'transparent'],
  ['fixtures/tamper/t5-two-prices', 'C11', 'pays'],
  ['fixtures/tamper/t6-bond-spent', 'C13', 'bond spent'],
  ['fixtures/tamper/t7-pool', 'C12', 'pool'],
];

for (const [dir, code, needle] of cases) {
  test(`${dir} fails with ${code}`, () => {
    const report = verify(load(dir));
    assert.equal(report.ok, false);
    assert.equal(report.status, 'FAIL');
    assert.equal(report.failures[0]?.code, code, JSON.stringify(report.failures, null, 2));
    assert.match(report.failures[0].message, new RegExp(needle, 'i'));
  });
}

test('tampered fixtures still satisfy the hash commitment, by design', () => {
  // A hash commitment proves the file was not edited after publication. It says
  // nothing about whether the file is true.
  for (const [dir] of cases) {
    const report = verify(load(dir));
    const c1 = report.checks.find((c) => c.code === 'C1');
    assert.equal(c1?.status, 'pass', `${dir} should have a matching commitment`);
  }
});

test('audit mode without a chain view skips and returns PARTIAL, never PASS', () => {
  const { params, settlement, proofs, commitments } = load('fixtures/auction-02');
  const report = verify({ params, settlement, proofs, commitments, mode: 'audit' });
  assert.equal(report.ok, true);
  assert.equal(report.status, 'PARTIAL');
  const skipped = report.checks.filter((c) => c.status === 'skip').map((c) => c.code);
  assert.deepEqual(skipped, ['C5', 'C6', 'C7', 'C8', 'C9', 'C10', 'C12', 'C13']);
  // C14 is n/a in public-tender mode, and C11 runs on the published artifact.
  assert.equal(report.checks.find((c) => c.code === 'C11')?.status, 'pass');
  assert.equal(report.checks.find((c) => c.code === 'C14')?.status, 'pass');
  assert.ok(report.warnings.length >= 8);
});

test('a late note counted as a bid is rejected by C4', () => {
  const bundle = load('fixtures/auction-01');
  const late = bundle.settlement.entries.find((e) => e.outcome === 'late');
  assert.ok(late, 'fixture must contain a late note');
  late.outcome = 'refunded';
  late.refund_txid = bundle.settlement.refund_txs[0].txid;
  bundle.commitments.settlement_hash = settlementHash(bundle.settlement);
  const report = verify(bundle);
  assert.equal(report.failures[0]?.code, 'C4');
});

test('a swapped OVK is rejected by C10', () => {
  const bundle = load('fixtures/auction-01');
  bundle.scan.ovk = 'ff'.repeat(32);
  const report = verify(bundle);
  assert.equal(report.failures[0]?.code, 'C10');
});

test('empty leaf set is refused rather than silently passing C2', () => {
  const bundle = load('fixtures/auction-01');
  bundle.settlement.entries = [];
  const report = verify(bundle);
  assert.equal(report.ok, false);
  assert.ok(report.failures.some((f) => f.code === 'C2'));
});

function spec2FirstPriceBundle() {
  const ZEC = 100_000_000n;
  const params = openAuction({
    spec: 2,
    auction_id: 'ab'.repeat(16),
    network: 'test',
    address: 'u1firstpricetestauctionaddress000000000000000000',
    reserve_zat: 5n * ZEC,
    deadline_height: 1000,
    confirmations: 3,
    min_bid_zat: 1n * ZEC,
    rule: 'first-price',
    units: 1,
    pool: 'orchard',
    mode: 'public-tender',
    opened_at_height: 900,
    ovk: 'ab'.repeat(32),
  });
  const notes: ReceivedNote[] = [
    {
      txid: '11'.repeat(32),
      height: 950,
      action_index: 0,
      value_zat: 10n * ZEC,
      cm: '21'.repeat(32),
      memo_raw: JSON.stringify({ v: 2, refund: 'u1firstpricerefundwinner0000000000000000000000', qty: '1' }),
      transparent_funded: false,
      pool: 'orchard',
    },
    {
      txid: '12'.repeat(32),
      height: 951,
      action_index: 0,
      value_zat: 4n * ZEC,
      cm: '22'.repeat(32),
      memo_raw: JSON.stringify({ v: 2, refund: 'u1firstpricerefundloser00000000000000000000000', qty: '1' }),
      transparent_funded: false,
      pool: 'orchard',
    },
  ];
  const plan = planRefunds(params, notes);
  const batch = singleRefundBatch(plan, { txid: 'cc'.repeat(32), height: 1004 });
  const { settlement, proofs } = settleAuction({
    params,
    notes,
    ufvk: 'uview1firstprice',
    settle_height: 1004,
    refunds: batch,
  });
  const scan: ScanView = {
    chain_tx_count: notes.length,
    chain_note_count: notes.length,
    notes,
    refund_outputs: plan.map((entry) => ({
      txid: 'cc'.repeat(32),
      height: 1004,
      address: entry.address,
      value_zat: entry.value_zat,
    })),
    ovk: 'ab'.repeat(32),
  };
  const commitments: Commitments = {
    params_hash: params.params_hash,
    settlement_hash: settlementHash(settlement),
  };
  return { params, settlement, scan, proofs, commitments };
}

test('C7 recomputes a spec-2 first-price winner payment, not just the aggregate', () => {
  const bundle = spec2FirstPriceBundle();
  assert.equal(verify(bundle).status, 'PASS');
  const winner = bundle.settlement.entries.find((e) => e.outcome === 'winner');
  assert.ok(winner);
  winner.payment_zat = 1n;
  bundle.commitments.settlement_hash = settlementHash(bundle.settlement);
  const report = verify(bundle);
  assert.equal(report.failures[0]?.code, 'C7');
  assert.match(report.failures[0].message, /payment/);
});

test('C7 rejects a settlement whose rule or units differ from auction.json', () => {
  const bundle = load('fixtures/auction-02');
  bundle.settlement.rule = 'first-price';
  bundle.settlement.units = 1;
  bundle.commitments.settlement_hash = settlementHash(bundle.settlement);
  const report = verify(bundle);
  assert.equal(report.failures[0]?.code, 'C7');
  assert.match(report.failures[0].message, /rule|units/);
});

test('a wrong settlement commitment is rejected by C1', () => {
  const bundle = load('fixtures/auction-02');
  bundle.commitments.settlement_hash = canonicalHash({ not: 'the settlement' });
  const report = verify(bundle);
  assert.equal(report.failures[0]?.code, 'C1');
});

test('private mode without the auditor OVK is PARTIAL, and C14 catches a truncated transcript', () => {
  const bundle = load('fixtures/auction-02');
  bundle.params.mode = 'private';
  bundle.params.params_hash = paramsHash(bundle.params);
  bundle.commitments.params_hash = bundle.params.params_hash;
  bundle.settlement.params_hash = bundle.params.params_hash;
  bundle.settlement.ufvk = null;
  bundle.commitments.settlement_hash = settlementHash(bundle.settlement);
  delete (bundle as { reveal?: unknown }).reveal;

  const publicReport = verify(bundle);
  assert.equal(publicReport.status, 'PARTIAL');
  assert.equal(publicReport.checks.find((c) => c.code === 'C14')?.status, 'skip');

  const auditor = { ovk: bundle.scan.ovk };
  const good = verify({ ...bundle, auditor });
  // An OVK opens refund flows, not incoming notes: C14 passes, C5–C10 and C12
  // still need the UFVK the auctioneer did not publish. PARTIAL is the honest
  // verdict for that reader.
  assert.equal(good.status, 'PARTIAL');
  assert.equal(good.checks.find((c) => c.code === 'C14')?.status, 'pass');
  assert.equal(good.checks.find((c) => c.code === 'C5')?.status, 'skip');

  // The auctioneer's local view can run the whole set.
  const local = verify({ ...bundle, auditor, fullView: true });
  assert.equal(local.status, 'PASS');

  // The chain is untouched; only the published transcript loses a refund. C8
  // cannot see that difference (it recomputes from the OVK view), so C14 is the
  // check that catches the auctioneer's own ledger disagreeing with the chain.
  const hidden = structuredClone(bundle);
  hidden.refunds!.output_count -= 1;
  const bad = verify({ ...hidden, auditor });
  assert.equal(bad.failures[0]?.code, 'C14');
  assert.match(bad.failures[0].message, /claims|commitment/);
});
