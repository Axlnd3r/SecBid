import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkProofMemo, runSandbox, type SandboxInput } from '../src/sandbox.ts';

const input: SandboxInput = {
  rule: 'uniform',
  units: 3,
  reserve: '0.1',
  minBid: '0.05',
  seed: 'test',
  bids: [
    { name: 'Alice', amount: '0.14' },
    { name: 'Bob', amount: '0.12' },
    { name: 'Carol', amount: '0.11' },
    { name: 'Dave', amount: '0.10' },
    { name: 'Erin', amount: '0.04' },
    { name: 'Frank', amount: '0.13', late: true },
  ],
};

const failed = (run: Awaited<ReturnType<typeof runSandbox>>) =>
  run.report.checks.filter((c) => c.status === 'fail').map((c) => c.code);

test('an honest sandbox auction clears like the testnet run and verifies 14/14', async () => {
  const run = await runSandbox(input);
  assert.equal(run.report.ok, true, JSON.stringify(failed(run)));
  assert.equal(run.report.checks.length, 14);
  assert.equal(run.settlement.clearing_price_zat, 11_000_000n);
  assert.equal(run.settlement.winning_leaves.length, 3);
  assert.match(run.uri, /^zcash:utest1[0-9a-f]+\?amount=0\.05&memo=/);

  const outcome = (name: string) => {
    const i = input.bids.findIndex((b) => b.name === name);
    const key = [...run.bidOf].find(([, v]) => v === i)![0];
    return run.settlement.entries.find((e) => `${e.txid}:${e.action_index}` === key)?.outcome;
  };
  assert.equal(outcome('Alice'), 'winner');
  assert.equal(outcome('Dave'), 'refunded');
  assert.equal(outcome('Erin'), 'dust');
  assert.equal(outcome('Frank'), 'late');

  // every bidder's refund memo checks out against the published settlement
  for (const [, memo] of run.memos) assert.equal(checkProofMemo(memo, run.settlement).ok, true);
});

test('the sandbox is deterministic for the same input', async () => {
  const a = await runSandbox(input);
  const b = await runSandbox(input);
  assert.equal(a.settlement.merkle_root, b.settlement.merkle_root);
  assert.equal(a.params.params_hash, b.params.params_hash);
});

test('a dishonest auctioneer fails a named check', async () => {
  assert.ok(failed(await runSandbox(input, 'price')).includes('C7'));
  assert.ok(failed(await runSandbox(input, 'drop')).includes('C5'));
  assert.ok(failed(await runSandbox(input, 'refund')).includes('C8'));
});

test('first-price with transparent and memo-less bids', async () => {
  const run = await runSandbox({
    rule: 'first-price',
    units: 5,
    reserve: '1',
    minBid: '0.5',
    seed: 'fp',
    bids: [
      { name: 'A', amount: '2' },
      { name: 'B', amount: '3', transparent: true },
      { name: 'C', amount: '1.5', noMemo: true },
    ],
  });
  assert.equal(run.report.ok, true, JSON.stringify(failed(run)));
  assert.equal(run.params.units, 1);
  assert.equal(run.settlement.clearing_price_zat, 200_000_000n);
});
