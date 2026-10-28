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
import { verifyTranscript } from '../web/assets/transcript.js';
import { frameAt } from '../web/assets/focus.js';
import { ART_H, ART_W, stipple, warp } from '../web/assets/hero-art.js';

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

  it('serves byte ranges of static files, so the film can seek in video', async () => {
    const whole = await (await fetch(`${base}/assets/film.css`)).text();
    const part = await fetch(`${base}/assets/film.css`, { headers: { range: 'bytes=10-29' } });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get('accept-ranges'), 'bytes');
    assert.equal(part.headers.get('content-range'), `bytes 10-29/${Buffer.byteLength(whole)}`);
    assert.equal(await part.text(), Buffer.from(whole).subarray(10, 30).toString());
    const tail = await fetch(`${base}/assets/film.css`, { headers: { range: 'bytes=-5' } });
    assert.equal(tail.status, 206);
    assert.equal(await tail.text(), Buffer.from(whole).subarray(-5).toString());
    const bad = await fetch(`${base}/assets/film.css`, { headers: { range: 'bytes=999999-' } });
    assert.equal(bad.status, 416);
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
        'testnet-01',
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

  it('paints the terminal for the artifact set that was verified, not the one loaded first', async () => {
    const { auctions } = (await (await fetch(`${base}/api/auctions`)).json()) as {
      auctions: Array<{ slug: string; kind: 'honest' | 'tamper'; auction_id: string; entries: number }>;
    };
    const text = (lines: Array<Array<[string, string]>>) => lines.map((l) => l.map(([t]) => t).join(''));

    const t1 = auctions.find((a) => a.slug === 't1-price')!;
    const { report } = (await (await fetch(`${base}/api/auction/t1-price/report`)).json()) as {
      report: Parameters<typeof verifyTranscript>[0]['report'];
    };
    const tampered = verifyTranscript({ ...t1, report }, { C7: 'clearing recompute' });
    assert.equal(tampered.status, 'FAIL');
    assert.equal(text(tampered.lines)[0], '$ node src/cli.ts verify fixtures/tamper/t1-price');
    assert.match(text(tampered.lines).at(-1)!, /^RESULT: FAIL C7: /);
    assert.ok(text(tampered.lines).some((l) => /C7\s+FAIL clearing recompute/.test(l)));

    const audit = (await (await fetch(`${base}/api/auction/auction-01/report?mode=audit`)).json()) as {
      report: Parameters<typeof verifyTranscript>[0]['report'];
    };
    const partial = verifyTranscript({ ...auctions[0], report: audit.report });
    assert.equal(partial.status, 'PARTIAL');
    assert.match(text(partial.lines)[1], /audit mode/);
    assert.match(text(partial.lines).at(-1)!, /^RESULT: PARTIAL \(\d+\/14 checks; \d+ skipped\)$/);
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

describe('page motion and artwork', () => {
  const word = (x: number, y: number, w: number, h = 40) => ({ x, y, w, h });

  it('moves the focus frame from one word box to the next, stretching on the way', () => {
    const from = word(0, 0, 80);
    const to = word(120, 0, 40);
    assert.deepEqual(frameAt(from, to, 0), from);
    assert.deepEqual(frameAt(from, to, 1), to);

    const mid = frameAt(from, to, 0.5);
    assert.ok(mid.x < 60, 'the trailing (left) edge is still near the first word');
    assert.ok(mid.x + mid.w > 140, 'the leading (right) edge is already near the second word');
    assert.ok(mid.w > Math.max(from.w, to.w), 'mid-flight the frame spans both words');
  });

  it('never gives the focus frame a negative size, in any direction or wrap', () => {
    const boxes = [word(0, 0, 80), word(300, 0, 20), word(10, 60, 200), word(250, 60, 60), word(5, 120, 30, 50)];
    for (const from of boxes) {
      for (const to of boxes) {
        for (let i = 0; i <= 20; i++) {
          const f = frameAt(from, to, i / 20);
          assert.ok(f.w >= -1e-9 && f.h >= -1e-9, `${JSON.stringify({ from, to, t: i / 20, f })}`);
        }
      }
    }
  });

  it('leaves the picture alone until the hover lens eases in, then bends and scans it', () => {
    const w = 120;
    const h = 90;
    const prob = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) prob[y * w + x] = (x * 7 + y * 13) % 256;
    const out = new Uint8Array(w * h);

    warp(prob, out, w, h, { cx: 60, cy: 45, level: 0 });
    assert.deepEqual(Array.from(out), Array.from(prob), 'level 0 is the identity');

    warp(prob, out, w, h, { cx: 60, cy: 45, level: 1 });
    for (let x = 0; x < w; x++) {
      assert.ok(out[2 * w + x] <= 26, 'every third row is a dark scan line (at most 10% of full)');
      assert.ok(out[5 * w + x] <= 26, 'and so is the next');
    }
    assert.notDeepEqual(Array.from(out.slice(40 * w, 41 * w)), Array.from(prob.slice(40 * w, 41 * w)), 'rows near the cursor bend');
    warp(prob, out, w, h, { cx: 60, cy: 45, level: 1, radius: 8, rows: 1000 });
    assert.deepEqual(Array.from(out.slice(0, w)), Array.from(prob.slice(0, w)), 'rows far outside the lens are untouched');

    const lone = new Uint8Array(w * h);
    lone[45 * w + 40] = 255;
    warp(lone, out, w, h, { cx: 60, cy: 45, level: 1, rows: 1000 });
    assert.ok(out[45 * w + 40] === 0 && out.some((v, i) => v === 255 && i % w < 40), 'the lens magnifies: a speck left of the cursor moves further left');
  });

  it('prints grain deterministically, with density following brightness', () => {
    const n = ART_W * ART_H;
    const out = new Uint32Array(n);
    const lit = () => out.reduce((sum, v) => sum + (v ? 1 : 0), 0);

    stipple(new Uint8Array(n), out, 7);
    assert.equal(lit(), 0, 'a black field prints nothing');

    stipple(new Uint8Array(n).fill(255), out, 7);
    assert.ok(lit() / n > 0.99, 'a white field prints (almost) every cell');

    const half = new Uint8Array(n).fill(128);
    const next = stipple(half, out, 7);
    assert.ok(Math.abs(lit() / n - 0.5) < 0.02, `half grey prints about half: ${lit() / n}`);
    const first = Array.from(out);
    stipple(half, out, 7);
    assert.deepEqual(Array.from(out), first, 'same seed, same grain');
    stipple(half, out, next);
    assert.notDeepEqual(Array.from(out), first, 'the returned seed moves on');

    stipple(new Uint8Array(n).fill(255), out, 7, 0);
    assert.equal(lit(), 0, 'gain 0 (the start of the develop-in) prints nothing');
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
