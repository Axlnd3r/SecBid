import test from 'node:test';
import assert from 'node:assert/strict';
import { leafHex, ovkCommitment } from '../src/leaf.ts';
import { proofFor, rootOf, verifyProof } from '../src/merkle.ts';
import { canonicalJson, canonicalHash, hashWithout } from '../src/canonical.ts';
import { classify } from '../src/eligibility.ts';
import { classifyAll, clear } from '../src/clearing.ts';
import { accountingHolds, buildSettlement } from '../src/settlement.ts';
import { planRefunds, openAuction, singleRefundBatch } from '../src/auction.ts';
import { encodeSettlement, paramsHash } from '../src/serialize.ts';
import { parseMemo } from '../src/memo.ts';
import type { AuctionParams, ReceivedNote } from '../src/model.ts';

const ZEC = 100_000_000n;

// The §6 test vector, reproduced exactly: txid and cm are 32 bytes each, every
// byte set to the leaf index.
const fill = (i: number) => i.toString(16).padStart(2, '0').repeat(32);

test('leaf and merkle match the legacy §6 test vector', () => {
  const leaves = [0, 1, 2, 3, 4].map((i) => leafHex(fill(i), fill(i)));
  assert.deepEqual(leaves, [
    'a53cffb6b960d2d55c92cb0e8db565c656b9720690cdee9456e8111e2cfd31ab',
    '4939ec1621227735748323bec521eaa209b9ebdd8803e43d8a4b92dcdbd2569f',
    '25e35c9e49076fa8fb6c171ab8e7a7bcf1c654f90f1a7dec97cfdaeb3478f078',
    '246b6def11b429140f21b950ff29f360eafb04ff943f4dab3dca35145299fd3a',
    'bb1b08d4fe71da134178f7536de42bea608da60356eef1fce14d83fc44dbb9ef',
  ]);

  const root = rootOf(leaves);
  assert.equal(root, '16e71800048760251fe118ca97c49cd2c1df7fe856042973a60fccaf9aba5a72');
  leaves.forEach((leaf, i) => {
    assert.ok(verifyProof(leaf, proofFor(leaves, i), root), `proof ${i}`);
  });

  // Promotion, not duplication: a 5-leaf tree must not equal a padded one.
  const padded = rootOf([...leaves, ...leaves, ...leaves, leaves[0]]);
  assert.notEqual(padded, root);
});

test('a proof does not verify against a different root', () => {
  const leaves = [0, 1, 2].map((i) => leafHex(fill(i), fill(i)));
  const other = [3, 4, 5].map((i) => leafHex(fill(i), fill(i)));
  assert.equal(verifyProof(leaves[0], proofFor(leaves, 0), rootOf(other)), false);
});

test('canonical json sorts keys, accepts bigint integers, and rejects floats', () => {
  assert.equal(canonicalJson({ b: 1, a: [2, 3] }), '{"a":[2,3],"b":1}');
  assert.equal(canonicalJson({ a: 1200000000n }), '{"a":1200000000}');
  assert.equal(canonicalHash({ a: 1, b: 2 }), canonicalHash({ b: 2, a: 1 }));
  assert.throws(() => canonicalJson({ a: 1.5 }), /non-integer/);
  assert.throws(() => canonicalJson({ a: -1n }), /negative/);
  assert.equal(hashWithout({ a: 1, self: 'x' }, 'self'), canonicalHash({ a: 1 }));
});

const params: AuctionParams = (() => {
  return openAuction({
    spec: 1,
    auction_id: '0011223344556677',
    network: 'test',
    address: 'u1auction',
    reserve_zat: 1n * ZEC,
    deadline_height: 1000,
    settle_depth: 3,
    min_bid_zat: 10_000n,
    created_at_height: 900,
    ovk: 'ab'.repeat(32),
  });
})();

let n = 0;
function note(height: number, value: bigint, opts: Partial<ReceivedNote> = {}): ReceivedNote {
  n += 1;
  return {
    txid: n.toString(16).padStart(64, '0'),
    height,
    action_index: 0,
    value_zat: value,
    cm: (n + 1000).toString(16).padStart(64, '0'),
    memo_raw: JSON.stringify({ v: 1, refund: 'u1refund' }),
    transparent_funded: false,
    pool: 'orchard',
    ...opts,
  };
}

test('eligibility rules E1-E4 classify in order', () => {
  assert.equal(classify(note(1001, 5n * ZEC), params).pre, 'late');
  // No refund address means stranded, however late the note arrived.
  assert.equal(classify(note(1001, 5n * ZEC, { memo_raw: null }), params).pre, 'stranded');
  assert.equal(classify(note(900, 5n * ZEC), params).pre, 'bid');
  assert.equal(classify(note(900, 5_000n), params).pre, 'dust');
  assert.equal(classify(note(900, 5n * ZEC, { transparent_funded: true }), params).pre, 'transparent_funded');
  assert.equal(classify(note(900, 5n * ZEC, { memo_raw: null }), params).pre, 'stranded');
  assert.equal(classify(note(900, 5n * ZEC, { memo_raw: 'not json' }), params).pre, 'stranded');
  assert.equal(
    classify(note(900, 5n * ZEC, { memo_raw: JSON.stringify({ v: 1, refund: 't1transparent' }) }), params).pre,
    'stranded',
  );
});

test('memo parsing rejects the shapes that cannot be refunded', () => {
  assert.equal(parseMemo(null).ok, false);
  assert.equal(parseMemo('{"v":3,"refund":"u1x"}').ok, false);
  assert.equal(parseMemo('{"v":1}').ok, false);
  assert.equal(parseMemo('{"v":1,"refund":"zs1abc"}').ok, true);
  assert.equal(parseMemo('{"v":2,"refund":"u1x","qty":"2"}').ok, true);
  assert.equal(parseMemo('{"v":2,"refund":"u1x","unknown":1}').ok, false);
  assert.equal(parseMemo('{"v":1,"refund":"u1x"} ' + 'x'.repeat(520)).ok, false);
});

test('a spec-1 auction refuses a spec-2 memo instead of guessing', () => {
  const v2memo = JSON.stringify({ v: 2, refund: 'u1refund', qty: '1' });
  assert.equal(classify(note(900, 5n * ZEC, { memo_raw: v2memo }), params).pre, 'stranded');
});

test('clearing picks the highest bid and refunds the rest', () => {
  const notes = [note(900, 5n * ZEC), note(910, 12n * ZEC), note(920, 7n * ZEC)];
  const classified = classifyAll(notes, params);
  const result = clear(classified, params);
  assert.equal(result.result, 'sold');
  assert.equal(result.clearing_price_zat, 12n * ZEC);
  assert.equal(result.retained_zat, 12n * ZEC);
  assert.equal(result.winning_leaf, classified[1].leaf);
  assert.equal(result.refunds.length, 2);
  assert.equal(result.refunds.reduce((s, r) => s + r.value_zat, 0n), 12n * ZEC);
});

test('tie-break is deterministic: earlier height, then lower txid', () => {
  const a = note(910, 5n * ZEC);
  const b = note(900, 5n * ZEC);
  const c = { ...note(900, 5n * ZEC), txid: 'ff'.repeat(32), cm: 'aa'.repeat(32) };
  const d = { ...note(900, 5n * ZEC), txid: '00'.repeat(32), cm: 'bb'.repeat(32) };

  const early = clear(classifyAll([a, b], params), params);
  assert.equal(early.winning_leaf, classifyAll([a, b], params)[1].leaf);

  const sameHeight = clear(classifyAll([c, d], params), params);
  const winner = classifyAll([c, d], params).find((x) => x.leaf === sameHeight.winning_leaf)!;
  assert.equal(winner.txid, '00'.repeat(32));
});

test('below reserve means unsold and everything is refunded', () => {
  const notes = [note(900, 5_000_000n), note(901, 6_000_000n)];
  const result = clear(classifyAll(notes, params), params);
  assert.equal(result.result, 'unsold');
  assert.equal(result.clearing_price_zat, 0n);
  assert.equal(result.winning_leaf, null);
  assert.equal(result.refunds.reduce((s, r) => s + r.value_zat, 0n), 11_000_000n);
});

test('stranded funds are never counted as refunded', () => {
  const notes = [note(900, 5n * ZEC), note(901, 3n * ZEC), note(902, 2n * ZEC, { memo_raw: null })];
  const result = clear(classifyAll(notes, params), params);
  assert.equal(result.refunds.length, 1);
  assert.equal(result.refunds[0].value_zat, 3n * ZEC);
});

test('settlement accounting balances and stays amount-free in the artifact', () => {
  const notes = [
    note(900, 5n * ZEC),
    note(910, 12n * ZEC),
    note(920, 30_000_000n),
    note(930, 8n * ZEC, { transparent_funded: true }),
    note(940, 1n * ZEC, { memo_raw: null }),
  ];
  const refundTx = { txid: 'aa'.repeat(32), height: 1005 };
  const { settlement } = buildSettlement(params, notes, {
    ufvk: 'uview1x',
    settle_height: 1003,
    refunds: singleRefundBatch(planRefunds(params, notes), refundTx),
  });

  const a = settlement.accounting;
  assert.equal(a.retained_zat, 12n * ZEC);
  assert.equal(a.refunded_zat, 5n * ZEC + 30_000_000n + 8n * ZEC);

  assert.equal('in_zat' in a, false);
  assert.equal('stranded_zat' in a, false);
  assert.ok(
    accountingHolds({
      in_zat: 5n * ZEC + 12n * ZEC + 30_000_000n + 8n * ZEC + 1n * ZEC,
      refunded_zat: a.refunded_zat,
      retained_zat: a.retained_zat,
      stranded_zat: 1n * ZEC,
      fees_zat: a.fees_zat,
    }),
  );

  // The encoded v1 artifact must not carry any individual bid amount. The
  // clearing price is the exception and is public by design.
  const encoded = encodeSettlement(settlement);
  const numbers = new Set<number>();
  (function walk(v: unknown) {
    if (typeof v === 'number') numbers.add(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  })(encoded);

  assert.equal(numbers.has(5 * 100_000_000), false, 'leaks the 5 ZEC bid');
  assert.equal(numbers.has(30_000_000), false, 'leaks the late 0.3 ZEC bid');
  assert.equal(numbers.has(8 * 100_000_000), false, 'leaks the 8 ZEC transparent bid');
  assert.equal(numbers.has(5 * 100_000_000 + 12 * 100_000_000 + 30_000_000 + 8 * 100_000_000 + 100_000_000), false);
  assert.ok(numbers.has(1_200_000_000), 'clearing price must be published');
});

test('settlement entries are in canonical leaf order and the tree covers all of them', () => {
  const notes = [note(930, 5n * ZEC), note(910, 6n * ZEC), note(920, 7n * ZEC)];
  const refundTx = { txid: 'aa'.repeat(32), height: 1005 };
  const { settlement, proofs } = buildSettlement(params, notes, {
    ufvk: 'uview1x',
    settle_height: 1003,
    refunds: singleRefundBatch(planRefunds(params, notes), refundTx),
  });
  assert.deepEqual(settlement.entries.map((e) => e.height), [910, 920, 930]);
  for (const entry of settlement.entries) {
    assert.ok(verifyProof(entry.leaf, proofs[entry.leaf], settlement.merkle_root));
  }
});

test('params_hash matches the encoded params and the OVK commitment', () => {
  assert.equal(paramsHash(params), params.params_hash);
  assert.equal(params.ovk_commitment, ovkCommitment(params.auction_id, 'ab'.repeat(32)));
});
