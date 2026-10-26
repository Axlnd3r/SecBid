import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createWebServer, type PublicBundle } from '../scripts/serve-web.ts';
import { encodeProofMemo } from '../src/proof.ts';
import { checkProofMemo } from '../src/auction.ts';
import { decodeSettlement } from '../src/serialize.ts';
import type { ProofMap } from '../src/model.ts';
import { buildMemo, bytesToB64, flipMemoPrice, verifyMemo } from '../web/assets/proofcheck.js';

/**
 * Two things are tested here that nothing else can test:
 *
 *  1. the public bundle has no private field in it. `scan.json` holds bid
 *     amounts, refund addresses and memos; if it ever reaches a browser, the
 *     product has no reason to exist.
 *  2. the browser proof checker and the Node encoder agree byte for byte.
 */

const root = join(import.meta.dirname, '..');
const fixtures = join(root, 'fixtures');
const settlementRaw = JSON.parse(
  readFileSync(join(fixtures, 'auction-01', 'settlement.json'), 'utf8'),
) as Record<string, unknown>;
const settlement = decodeSettlement(settlementRaw);
const proofs = JSON.parse(readFileSync(join(fixtures, 'auction-01', 'proofs.json'), 'utf8')) as ProofMap;

describe('web api', () => {
  let server: Server;
  let base: string;

  before(async () => {
    server = createWebServer({ cwd: root });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const { port } = server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    await new Promise<void>((done) => server.close(() => done()));
  });

  it('serves the auction page with a restrictive CSP', async () => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/html/);
    assert.match(res.headers.get('content-security-policy') ?? '', /default-src 'self'/);
    assert.match(res.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
    const html = await res.text();
    assert.match(html, /Price is public\./);
    assert.match(html, /\/assets\/app\.js/);
    assert.match(html, /Fourteen checks/);
    assert.match(html, /id="quantum"/);
  });

  it('serves static assets from web/ only', async () => {
    const js = await fetch(`${base}/assets/app.js`);
    assert.equal(js.status, 200);
    assert.match(js.headers.get('content-type') ?? '', /javascript/);

    const vendor = await fetch(`${base}/vendor/uqr.mjs`);
    assert.equal(vendor.status, 200);

    const traversal = await fetch(`${base}/%2e%2e/package.json`);
    assert.equal(traversal.status, 404);
  });

  it('indexes every fixture auction, honest first', async () => {
    const { auctions } = (await (await fetch(`${base}/api/auctions`)).json()) as {
      auctions: Array<{ slug: string; kind: string; has_bond: boolean; rule: string }>;
    };
    assert.deepEqual(
      auctions.map((a) => a.slug),
      [
        'auction-01',
        'auction-02',
        't1-price',
        't2-truncate',
        't3-refund',
        't4-transparent',
        't5-two-prices',
        't6-bond-spent',
        't7-pool',
      ],
    );
    assert.equal(auctions[0].kind, 'honest');
    assert.equal(auctions[1].rule, 'uniform');
    assert.equal(auctions[1].has_bond, true);
  });

  it('publishes encoded artifacts without the chain view', async () => {
    const bundle = (await (await fetch(`${base}/api/auction/auction-01`)).json()) as PublicBundle;
    const s = bundle.settlement as {
      entries: Array<Record<string, unknown>>;
      winning_leaf: string | null;
    };
    assert.equal(bundle.auction.auction_id, '0011223344556677');
    assert.equal(s.entries.length, 7);
    assert.equal(bundle.report.ok, true);
    assert.equal(bundle.report.checks.length, 14);
    assert.equal(bundle.report.status, 'PASS');
    assert.equal(s.winning_leaf?.length, 64);
    assert.equal(bundle.leaves, null, 'spec 1 does not publish leaves.json');
    assert.equal(bundle.quantum, null, 'spec 1 has no quantum report');

    const serialized = JSON.stringify(bundle);
    for (const forbidden of ['value_zat', 'memo_raw', 'refund_outputs', 'chain_note_count', 'account_uuid']) {
      assert.ok(
        !serialized.includes(forbidden),
        `public bundle must not contain "${forbidden}" — that is viewing-key material`,
      );
    }
    assert.ok(!('notes' in bundle), 'public bundle must not carry received notes');
    assert.ok(!('scan' in bundle), 'public bundle must not carry the scan');
    assert.ok(!('account' in bundle), 'public bundle must not carry account.json');
  });

  it('publishes the spec-2 uniform auction with leaves and a quantum report', async () => {
    const bundle = (await (await fetch(`${base}/api/auction/auction-02`)).json()) as PublicBundle;
    const s = bundle.settlement as {
      rule: string;
      units: string;
      entries: Array<Record<string, unknown>>;
    };
    assert.equal(bundle.auction.rule, 'uniform');
    assert.equal(s.rule, 'uniform');
    assert.equal(s.units, '3');
    assert.equal(bundle.report.status, 'PASS');
    assert.ok(bundle.leaves, 'spec 2 publishes leaves.json');
    assert.ok(bundle.quantum, 'spec 2 publishes quantum.json');
    assert.match(String((bundle.quantum as Record<string, unknown>).disclaimer), /Quantum-recoverable/);
    assert.ok(bundle.bond, 'the auction posted a bond');

    const winners = s.entries.filter((e) => e.outcome === 'winner');
    assert.equal(winners.length, 3);
    assert.ok(winners.some((e) => String(e.filled_qty) < String(e.qty)), 'one marginal partial fill');
  });

  it('reports each tampered settlement on its own check', async () => {
    for (const [slug, code] of [
      ['t2-truncate', 'C5'],
      ['t5-two-prices', 'C11'],
      ['t6-bond-spent', 'C13'],
      ['t7-pool', 'C12'],
    ]) {
      const { report } = (await (await fetch(`${base}/api/auction/${slug}/report`)).json()) as {
        report: { ok: boolean; failures: Array<{ code: string }> };
      };
      assert.equal(report.ok, false, slug);
      assert.equal(report.failures[0].code, code, slug);
    }
  });

  it('skips the chain-dependent checks in audit mode and says PARTIAL', async () => {
    const { report } = (await (
      await fetch(`${base}/api/auction/auction-01/report?mode=audit`)
    ).json()) as { report: { mode: string; status: string; checks: Array<{ code: string; status: string }> } };
    assert.equal(report.mode, 'audit');
    assert.equal(report.status, 'PARTIAL');
    const c5 = report.checks.find((c) => c.code === 'C5');
    assert.equal(c5?.status, 'skip');
  });

  it('honours ?tip= and ignores a nonsense value', async () => {
    const bundle = (await (await fetch(`${base}/api/auction/auction-01`)).json()) as PublicBundle;
    const deadline = Number(bundle.auction.deadline_height);
    assert.ok(bundle.chain.tip_height > deadline, 'a settled auction must read as closed by default');

    const open = (await (
      await fetch(`${base}/api/auction/auction-01?tip=${deadline - 5}`)
    ).json()) as PublicBundle;
    assert.equal(open.chain.tip_height, deadline - 5);

    const junk = (await (await fetch(`${base}/api/auction/auction-01?tip=nope`)).json()) as PublicBundle;
    assert.equal(junk.chain.tip_height, bundle.chain.tip_height);
  });

  it('404s unknown artifacts and unknown routes', async () => {
    assert.equal((await fetch(`${base}/api/auction/nope`)).status, 404);
    assert.equal((await fetch(`${base}/nope.html`)).status, 404);
    assert.equal((await fetch(`${base}/api/nope`)).status, 404);
  });
});

describe('browser proof checker', () => {
  const winning = settlement.entries.find((e) => e.outcome === 'winner');
  assert.ok(winning, 'fixture must have a winner');
  const leaf = winning!.leaf;
  const memoInput = {
    leaf,
    root: settlement.merkle_root,
    outcome: winning!.outcome,
    clearing_price_zat: Number(settlement.clearing_price_zat),
    path: proofs[leaf],
  };

  it('encodes the same bytes as src/proof.ts', () => {
    const fromNode = encodeProofMemo(memoInput);
    const fromBrowser = buildMemo(memoInput);
    assert.equal(fromBrowser.length, fromNode.length);
    assert.deepEqual(Array.from(fromBrowser), Array.from(fromNode));
    assert.equal(checkProofMemo(fromBrowser, settlement).ok, true);
  });

  it('accepts a memo produced by the Node encoder', async () => {
    const memo = encodeProofMemo(memoInput);
    const result = await verifyMemo(memo, settlement);
    assert.equal(result.ok, true, result.problems.join('; '));
    assert.equal(result.decoded?.leaf, leaf);
    assert.equal(typeof bytesToB64(memo), 'string');
  });

  it('rejects a memo whose price was flipped', async () => {
    const memo = encodeProofMemo(memoInput);
    const tampered = await verifyMemo(flipMemoPrice(memo), settlement);
    assert.equal(tampered.ok, false);
    assert.match(tampered.problems.join(' | '), /price/);
  });

  it('rejects a memo for a leaf that is not in the table', async () => {
    const other = settlement.entries.find((e) => e.leaf !== leaf)!;
    const memo = encodeProofMemo({ ...memoInput, leaf: other.leaf, path: proofs[other.leaf] });
    const result = await verifyMemo(memo, settlement);
    assert.equal(result.ok, false);
    assert.match(result.problems.join(' | '), /settlement says|not in the published entry table/);
  });

  it('rejects a truncated memo instead of guessing', async () => {
    const memo = encodeProofMemo(memoInput);
    const result = await verifyMemo(memo.subarray(0, 40), settlement);
    assert.equal(result.ok, false);
    assert.match(result.problems[0], /too short|does not match/);
  });
});
