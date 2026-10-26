import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { decodeParams, decodeScan, decodeSettlement } from '../src/serialize.ts';

/**
 * The CLI is the interface a judge actually runs, so these tests drive it as a
 * subprocess instead of importing its internals. `open` -> `settle` -> `verify`
 * is the whole lifecycle in four commands.
 */

const ROOT = join(import.meta.dirname, '..');
const CLI = join(ROOT, 'src', 'cli.ts');
const FIXTURE = join(ROOT, 'fixtures', 'auction-01');
const AUCTION_ADDRESS = 'u1newauctionaddress0000000000000000000000';

function cli(args: string[]) {
  const res = spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: 'utf8' });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

function tempDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `secbid-${label}-`));
}

test('open writes spec-2 committed params and a payable ZIP-321 request', () => {
  const dir = tempDir('open');
  try {
    const id = 'a1b2c3d4e5f60718a1b2c3d4e5f60718';
    const res = cli([
      'open',
      '--out', dir,
      '--address', AUCTION_ADDRESS,
      '--ovk', 'ab'.repeat(32),
      '--reserve', '5',
      '--deadline', '3120000',
      '--at', '3110000',
      '--id', id,
      '--rule', 'uniform',
      '--units', '3',
      '--pool', 'orchard',
      '--bond-address', 'u1bondaddress0000000000000000000000000000',
      '--bond', '1',
    ]);
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, new RegExp(`opened auction ${id}`));
    assert.match(res.stdout, /uniform, 3 units/);
    assert.match(res.stdout, new RegExp(`zcash:${AUCTION_ADDRESS}\\?memo=`));

    const params = decodeParams(JSON.parse(readFileSync(join(dir, 'auction.json'), 'utf8')));
    assert.equal(params.spec, 2);
    assert.equal(params.auction_id, id);
    assert.equal(params.reserve_zat, 500_000_000n);
    assert.equal(params.min_bid_zat, 10_000n);
    assert.equal(params.deadline_height, 3_120_000);
    assert.equal(params.opened_at_height, 3_110_000);
    assert.equal(params.rule, 'uniform');
    assert.equal(params.units, 3);
    assert.ok(params.bond);
    assert.match(params.params_hash, /^[0-9a-f]{64}$/);
    assert.match(params.ovk_commitment, /^[0-9a-f]{64}$/);
    assert.match(readFileSync(join(dir, 'auction.json'), 'utf8'), /"reserve_zat": "500000000"/);

    // Before settlement there is nothing to verify; that is exit 2, not a pass.
    assert.equal(cli(['verify', dir]).code, 2);
    assert.equal(existsSync(join(dir, 'settlement.json')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('open --spec 1 still writes the legacy format', () => {
  const dir = tempDir('open-v1');
  try {
    const res = cli([
      'open', '--spec', '1', '--out', dir, '--address', AUCTION_ADDRESS,
      '--ovk', 'ab'.repeat(32), '--reserve', '5', '--deadline', '3120000',
      '--at', '3110000', '--id', 'a1b2c3d4e5f60718',
    ]);
    assert.equal(res.code, 0, res.stderr);
    const raw = JSON.parse(readFileSync(join(dir, 'auction.json'), 'utf8')) as Record<string, unknown>;
    assert.equal(raw.v, 1);
    assert.equal(raw.clearing_rule, 'first_price');
    assert.equal(raw.reserve_zat, 500_000_000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('open refuses params a verifier could not stand behind', () => {
  const dir = tempDir('open-bad');
  try {
    const transparent = cli([
      'open', '--out', dir, '--address', 't1transparent', '--ovk', 'ab'.repeat(32),
      '--reserve', '5', '--deadline', '3120000', '--at', '3110000',
    ]);
    assert.equal(transparent.code, 2);
    assert.match(transparent.stderr, /shielded/);

    const badDeadline = cli([
      'open', '--out', dir, '--address', AUCTION_ADDRESS, '--ovk', 'ab'.repeat(32),
      '--reserve', '5', '--deadline', '3110000', '--at', '3110000',
    ]);
    assert.equal(badDeadline.code, 2);
    assert.match(badDeadline.stderr, /deadline/);

    const reserveBelowMin = cli([
      'open', '--out', dir, '--address', AUCTION_ADDRESS, '--ovk', 'ab'.repeat(32),
      '--reserve', '0.00001', '--deadline', '3120000', '--at', '3110000',
    ]);
    assert.equal(reserveBelowMin.code, 2);
    assert.match(reserveBelowMin.stderr, /min_bid/);

    const halfBond = cli([
      'open', '--out', dir, '--address', AUCTION_ADDRESS, '--ovk', 'ab'.repeat(32),
      '--reserve', '5', '--deadline', '3120000', '--at', '3110000',
      '--bond-address', 'u1bondaddress0000000000000000000000000000',
    ]);
    assert.equal(halfBond.code, 2);
    assert.match(halfBond.stderr, /together/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('settle splits a refund batch and the artifacts verify end to end', () => {
  const dir = tempDir('settle');
  try {
    copyFileSync(join(FIXTURE, 'auction.json'), join(dir, 'auction.json'));
    copyFileSync(join(FIXTURE, 'scan.json'), join(dir, 'scan.json'));

    const settled = cli(['settle', dir, '--ufvk', 'uview1testkey', '--max-outputs', '2']);
    assert.equal(settled.code, 0, settled.stdout + settled.stderr);
    assert.match(settled.stdout, /6 outputs in 3 tx/);
    assert.match(settled.stdout, /RESULT: PASS \(14\/14 checks\)/);

    const settlement = decodeSettlement(JSON.parse(readFileSync(join(dir, 'settlement.json'), 'utf8')));
    assert.equal(settlement.refund_txs.length, 3);
    assert.equal(new Set(settlement.refund_txs.map((t) => t.height)).size, 1, 'one height for the batch');
    assert.equal(settlement.entries.filter((e) => e.refund_txid !== null).length, 6);
    for (const entry of settlement.entries) {
      assert.ok(existsSync(join(dir, 'memos', `${entry.leaf}.base64`)), `missing memo for ${entry.leaf}`);
    }

    const verified = cli(['verify', dir, '--quiet']);
    assert.equal(verified.code, 0, verified.stdout + verified.stderr);
    assert.match(verified.stdout, /RESULT: PASS/);

    const first = settlement.entries[0];
    const memo = readFileSync(join(dir, 'memos', `${first.leaf}.base64`), 'utf8').trim();
    const checked = cli(['proof', 'check', dir, memo]);
    assert.equal(checked.code, 0, checked.stdout + checked.stderr);
    assert.match(checked.stdout, /MEMO: OK/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('settle without the disclosed UFVK is refused in public-tender mode', () => {
  const dir = tempDir('settle-no-ufvk');
  try {
    copyFileSync(join(FIXTURE, 'auction.json'), join(dir, 'auction.json'));
    copyFileSync(join(FIXTURE, 'scan.json'), join(dir, 'scan.json'));
    const res = cli(['settle', dir]);
    assert.equal(res.code, 2);
    assert.match(res.stderr, /--ufvk is required/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bond record/show and quantum-report work from the CLI', () => {
  const dir = tempDir('bond');
  try {
    const opened = cli([
      'open', '--out', dir, '--address', AUCTION_ADDRESS, '--ovk', 'ab'.repeat(32),
      '--reserve', '5', '--deadline', '3120000', '--at', '3110000',
      '--bond-address', 'u1bondaddress0000000000000000000000000000', '--bond', '1',
    ]);
    assert.equal(opened.code, 0, opened.stderr);
    const recorded = cli(['bond', 'record', dir, '--txid', 'aa'.repeat(32), '--height', '3110500']);
    assert.equal(recorded.code, 0, recorded.stdout + recorded.stderr);
    assert.ok(existsSync(join(dir, 'bond.json')));
    const shown = cli(['bond', 'show', dir]);
    assert.equal(shown.code, 0, shown.stdout + shown.stderr);
    assert.match(shown.stdout, /check\s+PASS/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const qroot = tempDir('quantum');
  const qdir = join(qroot, 'auction');
  try {
    cpSync(join(ROOT, 'fixtures', 'auction-02'), qdir, { recursive: true });
    const res = cli(['quantum-report', qdir]);
    assert.equal(res.code, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /Quantum-recoverable ≠ post-quantum/);
    const report = JSON.parse(readFileSync(join(qdir, 'quantum.json'), 'utf8')) as { disclaimer: string };
    assert.match(report.disclaimer, /Quantum-recoverable/);
  } finally {
    rmSync(qroot, { recursive: true, force: true });
  }
});

test('agent bid and agent check run without a network', () => {
  const dir = tempDir('agent');
  try {
    const mandate = join(dir, 'mandate.json');
    writeFileSync(mandate, JSON.stringify({
      v: 1,
      max_price_zat: '200000000',
      quantity: '2',
      refund_address: 'u1agentrefundaddress000000000000000000000000',
      bid_price_zat: '150000000',
    }));
    const bid = cli(['agent', 'bid', join(ROOT, 'fixtures', 'auction-02'), '--mandate', mandate]);
    assert.equal(bid.code, 0, bid.stdout + bid.stderr);
    assert.match(bid.stdout, /zcash:u1secbiduniformauctionaddress/);
    assert.match(bid.stdout, /amount=3/);

    const entry = decodeSettlement(
      JSON.parse(readFileSync(join(ROOT, 'fixtures', 'auction-02', 'settlement.json'), 'utf8')),
    ).entries[0];
    const memo = readFileSync(join(ROOT, 'fixtures', 'auction-02', 'memos', `${entry.leaf}.base64`), 'utf8').trim();
    const checked = cli(['agent', 'check', join(ROOT, 'fixtures', 'auction-02'), memo]);
    assert.equal(checked.code, 0, checked.stdout + checked.stderr);
    assert.match(checked.stdout, /AGENT: OK/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('private mode: auctioneer PASS, public PARTIAL, auditor catches a truncated transcript', () => {
  const dir = tempDir('private');
  try {
    const demo = cli(['demo', '--out', dir, '--mode', 'private']);
    assert.equal(demo.code, 0, demo.stdout + demo.stderr);
    assert.match(demo.stdout, /RESULT: PASS/);
    assert.equal(existsSync(join(dir, 'reveal.json')), false, 'private mode publishes no reveal');
    const settlement = decodeSettlement(JSON.parse(readFileSync(join(dir, 'settlement.json'), 'utf8')));
    assert.equal(settlement.ufvk, null);

    const publicVerify = cli(['verify', dir, '--quiet']);
    assert.equal(publicVerify.code, 0, publicVerify.stdout + publicVerify.stderr);
    assert.match(publicVerify.stdout, /RESULT: PARTIAL/);

    const scan = decodeScan(JSON.parse(readFileSync(join(dir, 'scan.json'), 'utf8')));
    const audited = cli(['verify', dir, '--auditor', '--ovk', scan.ovk, '--quiet']);
    assert.equal(audited.code, 0, audited.stdout + audited.stderr);
    assert.match(audited.stdout, /RESULT: PARTIAL/);

    const refundsPath = join(dir, 'refunds.json');
    const refunds = JSON.parse(readFileSync(refundsPath, 'utf8')) as { output_count: number };
    refunds.output_count -= 1;
    writeFileSync(refundsPath, JSON.stringify(refunds, null, 2));
    const caught = cli(['verify', dir, '--auditor', '--ovk', scan.ovk, '--quiet']);
    assert.equal(caught.code, 1, caught.stdout + caught.stderr);
    assert.match(caught.stdout, /FAIL C14/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('demo --rule uniform --units 3 prints PASS', () => {
  const dir = tempDir('demo-uniform');
  try {
    const res = cli(['demo', '--out', dir, '--rule', 'uniform', '--units', '3']);
    assert.equal(res.code, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /uniform \/ 3 units/);
    assert.match(res.stdout, /RESULT: PASS \(14\/14 checks\)/);
    const settlement = decodeSettlement(JSON.parse(readFileSync(join(dir, 'settlement.json'), 'utf8')));
    assert.equal(settlement.entries.filter((e) => e.outcome === 'winner').length, 3);
    assert.ok(settlement.entries.some((e) => e.outcome === 'winner' && e.filled_qty < e.qty));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
