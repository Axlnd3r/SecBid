import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildStatic } from '../scripts/build-static.ts';
import { isStatic, staticPath } from '../web/assets/static-api.js';

test('static API paths map onto the pre-rendered files', () => {
  assert.equal(staticPath('/api/auctions'), 'api/auctions.json');
  assert.equal(staticPath('/api/auction/testnet-01'), 'api/auction/testnet-01.json');
  assert.equal(staticPath('/api/auction/testnet-01?tip=4549600'), 'api/auction/testnet-01.json');
  assert.equal(staticPath('/api/auction/t2-truncate/report?mode=audit'), 'api/auction/t2-truncate/report-audit.json');
  assert.equal(staticPath('/api/auction/t2-truncate/report?mode=fixture'), 'api/auction/t2-truncate/report-fixture.json');
  assert.equal(staticPath('/api/auction/x/report'), 'api/auction/x/report-fixture.json');
  assert.equal(staticPath('/assets/app.css'), '/assets/app.css');
  assert.equal(isStatic({ querySelector: () => null } as unknown as Document), false);
  assert.equal(isStatic({ querySelector: () => ({}) } as unknown as Document), true);
});

test('the static build serves the same public bundles, relative to any base path', async () => {
  const out = mkdtempSync(join(tmpdir(), 'secbid-site-'));
  try {
    const files = await buildStatic(out);
    assert.ok(files.includes('api/auctions.json'));
    assert.ok(files.includes('api/auction/testnet-01.json'));
    assert.ok(files.includes('api/auction/testnet-01/report-audit.json'));

    const { auctions } = JSON.parse(readFileSync(join(out, 'api/auctions.json'), 'utf8')) as { auctions: Array<{ slug: string }> };
    for (const { slug } of auctions) assert.ok(existsSync(join(out, `api/auction/${slug}.json`)), slug);

    // the published files are the whitelisted bundle: no viewing-key material (same list as web.test.ts)
    const bundle = readFileSync(join(out, 'api/auction/testnet-01.json'), 'utf8');
    assert.equal(JSON.parse(bundle).slug, 'testnet-01');
    assert.ok(!('scan' in JSON.parse(bundle)));
    for (const forbidden of ['value_zat', 'memo_raw', 'refund_outputs', 'chain_note_count', 'account_uuid']) {
      assert.ok(!bundle.includes(forbidden), `static bundle must not contain "${forbidden}"`);
    }

    const index = readFileSync(join(out, 'index.html'), 'utf8');
    assert.match(index, /<meta name="secbid-static"/);
    assert.doesNotMatch(index, /"\/assets\//);
    assert.ok(existsSync(join(out, 'assets/static-api.js')));
    assert.ok(existsSync(join(out, '.nojekyll')));
    assert.equal(existsSync(join(out, 'assets/film')), false);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
