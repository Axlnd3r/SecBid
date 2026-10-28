import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash as nodeHash, randomBytes } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { libClosure, libModule } from '../scripts/strip-lib.ts';
import { Buffer as ShimBuffer } from '../web/assets/shim/buffer.js';
import { createHash as shimHash } from '../web/assets/shim/crypto.js';
import { runSandbox, type SandboxInput } from '../src/sandbox.ts';

/**
 * The sandbox page runs the core in the browser through two shims. These tests hold the shims
 * to Node's behaviour and the stripped modules to the TypeScript originals, byte for byte.
 */

test('the sha256 shim matches node:crypto at every padding boundary', () => {
  for (const n of [0, 1, 3, 55, 56, 57, 63, 64, 65, 119, 120, 128, 300, 1000]) {
    const data = randomBytes(n);
    assert.equal(shimHash('sha256').update(data).digest('hex'), nodeHash('sha256').update(data).digest('hex'), `n=${n}`);
  }
  assert.equal(
    shimHash('sha256').update('héllo {"a":1}', 'utf8').digest('hex'),
    nodeHash('sha256').update('héllo {"a":1}', 'utf8').digest('hex'),
  );
});

test('the Buffer shim matches Node for the operations the core uses', () => {
  const bytes = randomBytes(40);
  const hex = bytes.toString('hex');
  assert.equal(ShimBuffer.from(hex, 'hex').toString('hex'), hex);
  assert.equal(ShimBuffer.from(bytes).toString('base64url'), bytes.toString('base64url'));
  assert.equal(ShimBuffer.from(bytes.toString('base64url'), 'base64url').toString('hex'), hex);
  assert.equal(ShimBuffer.from('zcash ✓', 'utf8').toString('hex'), Buffer.from('zcash ✓', 'utf8').toString('hex'));
  assert.equal(ShimBuffer.byteLength('zcash ✓'), Buffer.byteLength('zcash ✓'));
  const a = ShimBuffer.alloc(16), b = Buffer.alloc(16);
  a.writeUInt8(7, 0); b.writeUInt8(7, 0);
  a.writeBigUInt64LE(11_000_000n, 1); b.writeBigUInt64LE(11_000_000n, 1);
  ShimBuffer.from('abcdef', 'hex').copy(a, 9); Buffer.from('abcdef', 'hex').copy(b, 9);
  assert.equal(a.toString('hex'), b.toString('hex'));
  assert.equal(a.readBigUInt64LE(1), 11_000_000n);
  const sub = a.subarray(9, 12) as unknown as InstanceType<typeof ShimBuffer>; // species keeps it a shim Buffer
  assert.ok(sub instanceof ShimBuffer);
  assert.equal(sub.toString('hex'), 'abcdef');
  assert.ok(sub.equals(ShimBuffer.from('abcdef', 'hex')));
});

test('the browser build of the sandbox settles exactly like the TypeScript source', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'secbid-lib-'));
  try {
    mkdirSync(join(dir, 'lib'));
    for (const name of libClosure()) writeFileSync(join(dir, 'lib', `${name}.js`), libModule(name));
    cpSync(join(import.meta.dirname, '..', 'web', 'assets', 'shim'), join(dir, 'assets', 'shim'), { recursive: true });
    const lib = await import(pathToFileURL(join(dir, 'lib', 'sandbox.js')).href);

    const input: SandboxInput = {
      rule: 'uniform', units: 3, reserve: '0.1', minBid: '0.05', seed: 'browser',
      bids: [
        { name: 'A', amount: '0.14' }, { name: 'B', amount: '0.12', qty: 2 }, { name: 'C', amount: '0.11' },
        { name: 'D', amount: '0.04' }, { name: 'E', amount: '0.2', late: true }, { name: 'F', amount: '0.3', transparent: true },
      ],
    };
    const node = await runSandbox(input);
    const browser = await lib.runSandbox(input);
    assert.equal(browser.params.params_hash, node.params.params_hash);
    assert.equal(browser.settlement.merkle_root, node.settlement.merkle_root);
    assert.equal(browser.settlement.clearing_price_zat, node.settlement.clearing_price_zat);
    assert.equal(browser.uri, node.uri);
    assert.equal(browser.report.status, 'PASS');
    assert.deepEqual(browser.report.checks.map((c: { status: string }) => c.status), node.report.checks.map((c) => c.status));
    const tamper = await lib.runSandbox(input, 'drop');
    assert.ok(tamper.report.checks.some((c: { code: string; status: string }) => c.code === 'C5' && c.status === 'fail'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
