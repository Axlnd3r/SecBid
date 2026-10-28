import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BIDS, RUN } from '../web/assets/explainer-data.js';

/** The landing-page explainer quotes the real testnet run; every figure must match the fixture. */
const dir = join(import.meta.dirname, '..', 'fixtures', 'testnet-01');
const read = (f: string) => JSON.parse(readFileSync(join(dir, f), 'utf8'));
const zat = (zec: string) => BigInt(Math.round(Number(zec) * 1e8));

test('explainer figures match fixtures/testnet-01', () => {
  const settlement = read('settlement.json');
  const auction = read('auction.json');
  const notes = new Map(read('scan.json').notes.map((n: { txid: string; value_zat: string }) => [n.txid, BigInt(n.value_zat)]));
  assert.equal(BigInt(settlement.clearing_price_zat), zat(RUN.price));
  assert.equal(settlement.rule, RUN.rule);
  assert.equal(Number(auction.units), RUN.units);
  assert.equal(BigInt(auction.reserve_zat), zat(RUN.reserve));
  assert.equal(BigInt(auction.min_bid_zat), zat(RUN.minBid));
  assert.deepEqual(settlement.refund_txs.map((t: { txid: string }) => t.txid), [RUN.refundTx]);
  assert.equal(settlement.entries.length, BIDS.length);
  for (const bid of BIDS) {
    const entry = settlement.entries.find((e: { txid: string }) => e.txid === bid.txid);
    assert.ok(entry, bid.tag);
    assert.equal(entry.outcome, bid.outcome, bid.tag);
    assert.equal(notes.get(bid.txid), zat(bid.zec), bid.tag);
  }
  // 0.14 and 0.12 get change back; 0.11 pays exactly the price; three losers are refunded in full
  const refunds = BIDS.filter((b) => b.outcome !== 'winner' || zat(b.zec) > zat(RUN.price)).length;
  assert.equal(refunds, RUN.refundOutputs);
});

test('the explainer section ships without inline script or style (CSP)', () => {
  const html = readFileSync(join(import.meta.dirname, '..', 'web', 'index.html'), 'utf8');
  const section = html.slice(html.indexOf('id="explain"'), html.indexOf('<!-- ── how'));
  assert.ok(section.length > 100);
  assert.doesNotMatch(section, /style=|<script(?![^>]*src=)/);
  assert.match(html, /<script type="module" src="\/assets\/explainer\.js"><\/script>/);
  assert.match(section, /sandbox\.html/);
});

test('the cinematic intro comes first, before the nav, and ships without inline script or style', () => {
  const html = readFileSync(join(import.meta.dirname, '..', 'web', 'index.html'), 'utf8');
  const start = html.indexOf('data-intro');
  assert.ok(start > 0 && start < html.indexOf('<header class="nav"'));
  const section = html.slice(start, html.indexOf('<header class="nav"'));
  assert.doesNotMatch(section, /style=|<script/);
  assert.match(section, /href="#explain" data-enter="skip"/); // always skippable
  assert.match(html, /<script type="module" src="\/assets\/intro\.js"><\/script>/);
});
