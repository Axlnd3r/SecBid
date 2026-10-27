import test from 'node:test';
import assert from 'node:assert/strict';
import type { AuctionParams, ReceivedNote } from '../src/model.ts';
import { openAuction } from '../src/auction.ts';
import { classify } from '../src/eligibility.ts';
import {
  addressNetwork,
  isShieldedAddress,
  isUnifiedAddress,
  isUnifiedViewingKey,
  parseMemo,
  refundPlaceholder,
} from '../src/memo.ts';
import { buildPaymentUri, parsePaymentUri } from '../src/zip321.ts';
import { JsonRpcClient } from '../src/rpc.ts';
import { createAuctionAccount, ZalletAdapter } from '../src/zallet.ts';
import { startFakeZallet } from './helpers/fake-zallet.ts';

// Testnet is where G2 runs. Every prefix check used to accept mainnet only, so a
// testnet auction could not open and every testnet refund address was stranded.

const ZEC = 100_000_000n;
const TEST_ADDRESS = 'utest1secbidtestnetauctionaddress0000000000000000000000';
const TEST_UFVK = 'uviewtest1secbidtestnetviewingkey000000000000000000000000';

function testnetParams(): AuctionParams {
  return openAuction({
    spec: 2,
    auction_id: 'ffeeddccbbaa99887766554433221100',
    network: 'test',
    address: TEST_ADDRESS,
    reserve_zat: 1n * ZEC,
    deadline_height: 1000,
    confirmations: 3,
    min_bid_zat: ZEC / 10n,
    rule: 'uniform',
    units: 3,
    pool: 'orchard',
    mode: 'public-tender',
    opened_at_height: 900,
    ovk: 'ab'.repeat(32),
  });
}

function note(refund: string): ReceivedNote {
  return {
    txid: '01'.repeat(32),
    height: 950,
    action_index: 0,
    value_zat: 2n * ZEC,
    cm: '02'.repeat(32),
    memo_raw: JSON.stringify({ v: 2, refund, qty: '1' }),
    transparent_funded: false,
    pool: 'orchard',
  };
}

test('address prefixes map to their network; transparent addresses are not shielded', () => {
  assert.equal(addressNetwork('u1abc'), 'main');
  assert.equal(addressNetwork('zs1abc'), 'main');
  assert.equal(addressNetwork('utest1abc'), 'test');
  assert.equal(addressNetwork('ztestsapling1abc'), 'test');
  assert.equal(addressNetwork('uregtest1abc'), 'regtest');
  assert.equal(addressNetwork('zregtestsapling1abc'), 'regtest');
  assert.equal(addressNetwork('tmBsTi2xWTjUdEXnuTceL7fecEQKeWaPDJd'), null);
  assert.equal(addressNetwork('t1abc'), null);
  assert.equal(isShieldedAddress('utest1abc'), true);
  assert.equal(isUnifiedAddress('utest1abc'), true);
  assert.equal(isUnifiedAddress('ztestsapling1abc'), false);
  assert.equal(isUnifiedViewingKey(TEST_UFVK), true);
  assert.equal(isUnifiedViewingKey('zxviewtestsapling1abc'), false);
  assert.equal(refundPlaceholder(TEST_ADDRESS), 'utest1<your fresh shielded address>');
  assert.equal(refundPlaceholder('u1abc'), 'u1<your fresh shielded address>');
});

test('a testnet auction opens and admits testnet refund addresses', () => {
  const params = testnetParams();
  assert.equal(parseMemo('{"v":2,"refund":"utest1refund","qty":"1"}').ok, true);
  assert.equal(classify(note('utest1refund-a'), params).pre, 'bid');
  assert.equal(classify(note('ztestsapling1refund-b'), params).pre, 'bid');
});

test('a refund address on another network is stranded, not sent', () => {
  const params = testnetParams();
  const wrong = classify(note('u1mainnetrefund'), params);
  assert.equal(wrong.pre, 'stranded');
  assert.equal(wrong.reason, 'refund_wrong_network');
});

test('zip321 memo is base64url without padding, and old base64 URIs still decode', () => {
  // 0xfb 0xff encodes to "+/8=" in base64: exactly the characters ZIP-321 forbids.
  const memo = new Uint8Array([0xfb, 0xff, 0x7b, 0x22]);
  const uri = buildPaymentUri({ address: TEST_ADDRESS, amount_zat: 150_000_000n, memo });
  assert.ok(uri.startsWith(`zcash:${TEST_ADDRESS}?`));
  const encoded = new URLSearchParams(uri.slice(uri.indexOf('?') + 1)).get('memo')!;
  assert.match(encoded, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(Array.from(parsePaymentUri(uri).memo!), Array.from(memo));

  const legacy = `zcash:${TEST_ADDRESS}?memo=${encodeURIComponent(Buffer.from(memo).toString('base64'))}`;
  assert.deepEqual(Array.from(parsePaymentUri(legacy).memo!), Array.from(memo));
});

test('zallet: a testnet account with a uviewtest1 key is accepted, refunds stay FullPrivacy', async () => {
  const fake = await startFakeZallet({ notes: [], address: TEST_ADDRESS, ufvk: TEST_UFVK, tip: 3_900_000 });
  try {
    const rpc = new JsonRpcClient({ url: fake.url });
    const account = await createAuctionAccount(rpc, 'auction-testnet');
    assert.equal(account.address, TEST_ADDRESS);
    assert.equal(account.ufvk, TEST_UFVK);

    const chain = new ZalletAdapter({
      rpc,
      accountUuid: account.account_uuid,
      address: account.address,
      ufvk: account.ufvk,
      pollIntervalMs: 0,
      sleep: async () => {},
    });
    await chain.sendRefunds([{ address: 'utest1refund-one', value_zat: 50_000_000n }]);
    const send = fake.state.calls.find((c) => c.method === 'z_sendmany');
    assert.equal(send?.params[4], 'FullPrivacy');
  } finally {
    await fake.close();
  }
});
