import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonRpcClient } from '../src/rpc.ts';
import { createAuctionAccount, tipHeight, ZalletAdapter, zalletPoolSupport } from '../src/zallet.ts';
import { verify } from '../src/verify.ts';
import { decodeParams, decodeScan, decodeSettlement } from '../src/serialize.ts';
import { startFakeZallet, fakeCm, fakeTxid, type FakeNote } from './helpers/fake-zallet.ts';

const ROOT = join(import.meta.dirname, '..');
const CLI = join(ROOT, 'src', 'cli.ts');
const ZEC = 100_000_000; // fake-wallet RPC values are JSON numbers
const ZECN = 100_000_000n;
const OVK = 'cd'.repeat(32);

const memo = (refund: string) => JSON.stringify({ v: 1, refund });

function notes(): FakeNote[] {
  return [
    { txid: fakeTxid('tx-a'), height: 3_119_000, actionIndex: 0, valueZat: 5 * 100_000_000, memo: memo('u1refund-a') },
    { txid: fakeTxid('tx-a'), height: 3_119_000, actionIndex: 1, valueZat: 2 * 100_000_000, memo: null },
    {
      txid: fakeTxid('tx-b'),
      height: 3_119_100,
      actionIndex: 2,
      valueZat: 3 * 100_000_000,
      memo: memo('u1refund-b'),
      transparentFunded: true,
    },
    { txid: fakeTxid('tx-c'), height: 3_119_200, actionIndex: 0, valueZat: 4 * 100_000_000, memo: memo('u1refund-c'), pool: 'sapling' },
  ];
}

function adapterFor(url: string, extra: { ufvk?: string; pageSize?: number } = {}) {
  return new ZalletAdapter({
    rpc: new JsonRpcClient({ url }),
    accountUuid: '11111111-1111-4111-8111-111111111111',
    address: 'u1fakeauctionaddress000000000000000000000000000000000000000000',
    ufvk: extra.ufvk ?? 'uview1fakeauctionviewingkey00000000000000000000000000000000000000',
    pageSize: extra.pageSize ?? 100,
    sleep: async () => {},
    pollIntervalMs: 0,
    miningTimeoutMs: 5_000,
  });
}

test('scan maps Zallet rows to notes: height, action index, cm, memo, funding flag', async () => {
  const fake = await startFakeZallet({ notes: notes(), includeChange: true });
  try {
    const chain = adapterFor(fake.url);
    const scanned = await chain.scan(undefined, 3_119_000);

    // The Sapling note and the change output are not bids and must not appear.
    assert.equal(scanned.length, 3);
    assert.deepEqual(
      scanned.map((n) => [n.txid, n.action_index, n.height, n.value_zat, n.transparent_funded]),
      [
        [fakeTxid('tx-a'), 0, 3_119_000, 5n * ZECN, false],
        [fakeTxid('tx-a'), 1, 3_119_000, 2n * ZECN, false],
        [fakeTxid('tx-b'), 2, 3_119_100, 3n * ZECN, true],
      ],
    );
    assert.equal(scanned[0].cm, fakeCm(fakeTxid('tx-a'), 0));
    assert.equal(scanned[1].memo_raw, null);
    assert.equal(scanned[2].cm, fakeCm(fakeTxid('tx-b'), 2));

    // One key check per adapter, not per page.
    const keyCalls = fake.state.calls.filter((c) => c.method === 'z_exportviewingkey');
    assert.equal(keyCalls.length, 1);
  } finally {
    await fake.close();
  }
});

test('scan pages through the account history', async () => {
  const fake = await startFakeZallet({ notes: notes() });
  try {
    const scanned = await adapterFor(fake.url, { pageSize: 1 }).scan(undefined, 3_119_000);
    assert.equal(scanned.length, 3);
    const pages = fake.state.calls.filter((c) => c.method === 'z_listtransactions');
    assert.ok(pages.length >= 2, `expected more than one page, got ${pages.length}`);
    assert.deepEqual(pages.map((p) => p.params[3]), [0, 1, 2, 3]);
  } finally {
    await fake.close();
  }
});

test('scan refuses a wallet whose viewing key is not the published UFVK', async () => {
  const fake = await startFakeZallet({ notes: notes(), reportedUfvk: 'uview1someotherkey' });
  try {
    await assert.rejects(() => adapterFor(fake.url).scan(undefined, 0), /does not match the published UFVK/);
  } finally {
    await fake.close();
  }
});

test('scan refuses a transaction with no Orchard commitment instead of inventing a leaf', async () => {
  const fake = await startFakeZallet({ notes: notes(), missingCmFor: [fakeTxid('tx-a')] });
  try {
    await assert.rejects(() => adapterFor(fake.url).scan(undefined, 0), /no Orchard note commitment/);
  } finally {
    await fake.close();
  }
});

test('on testnet an Orchard-receiver account is an Ironwood account (NU6.3 active)', async () => {
  const ironwood = zalletPoolSupport('ironwood', 'test');
  assert.equal(ironwood.supported, true);
  assert.equal(zalletPoolSupport('ironwood', 'main').supported, false);
  assert.equal(zalletPoolSupport('ironwood', 'regtest').supported, false);

  const fake = await startFakeZallet({ notes: [] });
  try {
    const rpc = new JsonRpcClient({ url: fake.url });
    const created = await createAuctionAccount(rpc, 'auction-ironwood', 'ironwood', 'test');
    assert.equal(created.pool, 'ironwood');
    assert.match(created.address, /^u/);
    await assert.rejects(() => createAuctionAccount(rpc, 'auction-iw-main', 'ironwood', 'main'), /Ironwood/);
  } finally {
    await fake.close();
  }
});

test('the wallet reports Orchard support and refuses to guess Ironwood', async () => {
  assert.equal(zalletPoolSupport('orchard').supported, true);
  const ironwood = zalletPoolSupport('ironwood');
  assert.equal(ironwood.supported, false);
  assert.match(ironwood.reason ?? '', /OPEN-QUESTIONS/);

  const fake = await startFakeZallet({ notes: [] });
  try {
    const rpc = new JsonRpcClient({ url: fake.url });
    await assert.rejects(() => createAuctionAccount(rpc, 'auction-ironwood', 'ironwood'), /Ironwood/);
    assert.equal(adapterFor(fake.url).supportsPool('orchard').supported, true);
    assert.equal(adapterFor(fake.url).supportsPool('ironwood').supported, false);
  } finally {
    await fake.close();
  }
});

test('createAuctionAccount rejects a UA that carries a transparent receiver', async () => {
  const fake = await startFakeZallet({ notes: [], receiverTypes: ['orchard', 'p2pkh'] });
  try {
    const rpc = new JsonRpcClient({ url: fake.url });
    await assert.rejects(() => createAuctionAccount(rpc, 'auction-1'), /Orchard-only/);
  } finally {
    await fake.close();
  }
});

test('createAuctionAccount returns the address, UFVK, and node tip', async () => {
  const fake = await startFakeZallet({ notes: [], tip: 3_118_888 });
  try {
    const rpc = new JsonRpcClient({ url: fake.url });
    assert.equal(await tipHeight(rpc), 3_118_888);
    const account = await createAuctionAccount(rpc, 'auction-1');
    assert.equal(account.account_uuid, '11111111-1111-4111-8111-111111111111');
    assert.equal(account.address, 'u1fakeauctionaddress000000000000000000000000000000000000000000');
    assert.match(account.ufvk, /^uview1/);
    assert.equal(account.height, 3_118_888);
    assert.equal(account.pool, 'orchard');
    assert.deepEqual(fake.state.createdAccounts, ['auction-1']);
    assert.deepEqual(fake.state.calls.find((c) => c.method === 'z_getaddressforaccount')?.params[1], ['orchard']);
  } finally {
    await fake.close();
  }
});

test('sendRefunds sends one shielded batch, waits for it to mine, and returns the real height', async () => {
  const fake = await startFakeZallet({ notes: notes(), tip: 3_120_000, refundMempoolPolls: 2 });
  try {
    const chain = adapterFor(fake.url);
    const tx = await chain.sendRefunds([
      { address: 'u1refund-one', value_zat: 3n * ZECN, memo: new Uint8Array([1, 2, 3]) },
      { address: 'u1refund-two', value_zat: 50_000_000n },
    ]);

    assert.equal(tx.height, 3_120_001);
    assert.equal(fake.state.refunds.length, 1);
    assert.deepEqual(
      fake.state.refunds[0].amounts.map((a) => [a.address, a.amount, a.memo]),
      [
        ['u1refund-one', '3', '010203'],
        ['u1refund-two', '0.5', undefined],
      ],
    );
    const send = fake.state.calls.find((c) => c.method === 'z_sendmany')!;
    assert.equal(send.params[0], 'u1fakeauctionaddress000000000000000000000000000000000000000000');
    assert.equal(send.params[4], 'FullPrivacy');
    // Two mempool polls mean the height came from the chain, not from the send response.
    assert.equal(fake.state.calls.filter((c) => c.method === 'getrawtransaction').length, 3);
  } finally {
    await fake.close();
  }
});

test('a Sapling refund address asks for the privacy policy it actually needs', async () => {
  const fake = await startFakeZallet({ notes: [], tip: 3_120_000 });
  try {
    await adapterFor(fake.url).sendRefunds([{ address: 'zs1saplingrefund', value_zat: 1n }]);
    const send = fake.state.calls.find((c) => c.method === 'z_sendmany')!;
    assert.equal(send.params[4], 'AllowRevealedAmounts');
  } finally {
    await fake.close();
  }
});

test('refunds that were built but not broadcast are an error, not a success', async () => {
  const fake = await startFakeZallet({ notes: [], broadcastRefunds: false });
  try {
    await assert.rejects(
      () => adapterFor(fake.url).sendRefunds([{ address: 'u1refund', value_zat: 1n }]),
      /did not broadcast/,
    );
  } finally {
    await fake.close();
  }
});

test('a refund chunk that Zallet splits into two transactions is refused', async () => {
  const fake = await startFakeZallet({ notes: [], splitRefundResult: true });
  try {
    await assert.rejects(
      () => adapterFor(fake.url).sendRefunds([{ address: 'u1refund', value_zat: 1n }]),
      /produced 2 transactions/,
    );
  } finally {
    await fake.close();
  }
});

test('a failed refund operation reports the wallet error', async () => {
  const fake = await startFakeZallet({ notes: [], failRefunds: 'insufficient funds' });
  try {
    await assert.rejects(
      () => adapterFor(fake.url).sendRefunds([{ address: 'u1refund', value_zat: 1n }]),
      /failed: insufficient funds/,
    );
  } finally {
    await fake.close();
  }
});

test('rpc client authenticates from a cookie file and never echoes the password', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'secbid-cookie-'));
  const cookie = join(dir, 'cookie');
  writeFileSync(cookie, 'alice:correct horse battery staple\n');
  const fake = await startFakeZallet({ notes: [], auth: { user: 'alice', password: 'correct horse battery staple' } });
  try {
    const rpc = new JsonRpcClient({ url: fake.url, auth: { cookieFile: cookie } });
    assert.equal(await tipHeight(rpc), 3_119_000);
    assert.match(fake.state.calls[0].authorization ?? '', /^Basic /);
    assert.ok(!(fake.state.calls[0].authorization ?? '').includes('correct horse'));

    const wrong = new JsonRpcClient({ url: fake.url, auth: { user: 'alice', password: 'wrong' } });
    await assert.rejects(() => tipHeight(wrong), /401/);

    const anonymous = new JsonRpcClient({ url: fake.url });
    await assert.rejects(() => tipHeight(anonymous), /401/);
  } finally {
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rpc errors keep the method and server code, and refuse non-http endpoints', async () => {
  const fake = await startFakeZallet({ notes: [] });
  try {
    const rpc = new JsonRpcClient({ url: fake.url });
    await assert.rejects(() => rpc.call('not_a_method'), /not_a_method failed \(-32601\)/);
    assert.throws(() => new JsonRpcClient({ url: 'file:///etc/passwd' }), /http\(s\)/);
    assert.throws(() => new JsonRpcClient({ url: 'http://user:pass@127.0.0.1:1' }), /--rpc-user/);
  } finally {
    await fake.close();
  }
});

/* ── the live CLI path, end to end ──────────────────────────────────────── */

function runCli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: ROOT });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('open --rpc -> scan -> settle --rpc -> verify, against the fake wallet', async () => {
  const auctionNotes: FakeNote[] = [
    { txid: fakeTxid('winner'), height: 3_119_500, actionIndex: 0, valueZat: 2 * ZEC, memo: memo('u1refundwinner') },
    { txid: fakeTxid('loser'), height: 3_119_600, actionIndex: 0, valueZat: 1 * ZEC, memo: memo('u1refundloser') },
    { txid: fakeTxid('late'), height: 3_120_001, actionIndex: 0, valueZat: 50_000_000, memo: memo('u1refundlate') },
    {
      txid: fakeTxid('transparent'),
      height: 3_119_700,
      actionIndex: 0,
      valueZat: 3 * ZEC,
      memo: memo('u1refundtransparent'),
      transparentFunded: true,
    },
  ];
  const fake = await startFakeZallet({ notes: auctionNotes, tip: 3_119_000 });
  const dir = mkdtempSync(join(tmpdir(), 'secbid-live-'));
  try {
    const opened = await runCli([
      'open',
      '--rpc', fake.url,
      '--name', 'auction-live',
      '--out', dir,
      '--id', 'a1b2c3d4e5f60718a1b2c3d4e5f60718',
      '--ovk', OVK,
      '--reserve', '1.5',
      '--deadline', '3120000',
    ]);
    assert.equal(opened.code, 0, opened.stdout + opened.stderr);
    assert.match(opened.stdout, /opened auction a1b2c3d4e5f60718a1b2c3d4e5f60718/);
    assert.match(opened.stdout, /account\s+11111111-1111-4111-8111-111111111111/);

    const params = decodeParams(JSON.parse(readFileSync(join(dir, 'auction.json'), 'utf8')));
    assert.equal(params.opened_at_height, 3_119_000);
    assert.equal(params.address, 'u1fakeauctionaddress000000000000000000000000000000000000000000');
    const account = JSON.parse(readFileSync(join(dir, 'account.json'), 'utf8')) as { ufvk: string };
    assert.match(account.ufvk, /^uview1/);

    const scanned = await runCli(['scan', dir, '--rpc', fake.url]);
    assert.equal(scanned.code, 0, scanned.stdout + scanned.stderr);
    assert.match(scanned.stdout, /scanned 4 note\(s\)/);
    assert.match(scanned.stdout, /2 bid/);
    assert.match(scanned.stdout, /1 late/);
    assert.match(scanned.stdout, /1 transparent_funded/);

    const badScan = await runCli(['scan', dir, '--rpc', fake.url, '--ovk', 'ef'.repeat(32)]);
    assert.equal(badScan.code, 2);
    assert.match(badScan.stderr, /--ovk does not match the commitment/);

    // The panic button before the deadline: refuse, and do not touch funds.
    const tooEarly = await runCli(['settle', dir, '--rpc', fake.url, '--ovk', OVK]);
    assert.equal(tooEarly.code, 2);
    assert.match(tooEarly.stderr, /before settle height/);
    assert.equal(fake.state.refunds.length, 0);

    fake.setTip(3_120_100);

    // A wrong OVK must fail before any refund is broadcast.
    const wrongOvk = await runCli(['settle', dir, '--rpc', fake.url, '--ovk', 'ef'.repeat(32)]);
    assert.equal(wrongOvk.code, 2);
    assert.match(wrongOvk.stderr, /--ovk does not match the commitment/);
    assert.equal(fake.state.refunds.length, 0);

    const settled = await runCli([
      'settle', dir,
      '--rpc', fake.url,
      '--ovk', OVK,
      '--max-outputs', '1',
    ]);
    assert.equal(settled.code, 0, settled.stdout + settled.stderr);
    assert.match(settled.stdout, /refunds\s+3 outputs in 3 tx/);
    assert.match(settled.stdout, /RESULT: PASS \(14\/14 checks\)/);

    const settlement = decodeSettlement(JSON.parse(readFileSync(join(dir, 'settlement.json'), 'utf8')));
    assert.equal(settlement.result, 'sold');
    assert.equal(settlement.clearing_price_zat, 2n * ZECN);
    assert.equal(settlement.accounting.refunded_zat, 450_000_000n);
    assert.equal(new Set(settlement.refund_txs.map((t) => t.height)).size, 1);

    // The artifact replays without the wallet, exactly like a fixture.
    const report = verify({
      params,
      settlement,
      scan: decodeScan(JSON.parse(readFileSync(join(dir, 'scan.json'), 'utf8'))),
      proofs: JSON.parse(readFileSync(join(dir, 'proofs.json'), 'utf8')),
      commitments: JSON.parse(readFileSync(join(dir, 'commitments.json'), 'utf8')),
      account: JSON.parse(readFileSync(join(dir, 'account.json'), 'utf8')),
    });
    assert.deepEqual(report.failures, []);

    const offline = await runCli(['verify', dir, '--quiet']);
    assert.equal(offline.code, 0, offline.stdout + offline.stderr);
  } finally {
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
