import { createServer, type IncomingMessage, type Server } from 'node:http';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { AccountFile, AuctionParams, BondView, Commitments, ProofMap, Reveal, RefundArtifact, ScanView, Settlement } from '../src/model.ts';
import { verify, type Mode, type VerifyReport } from '../src/verify.ts';
import { libClosure, libModule } from './strip-lib.ts';
import {
  decodeAccount,
  decodeBondView,
  decodeParams,
  decodeRefundArtifact,
  decodeReveal,
  decodeScan,
  decodeSettlement,
  encodeBondView,
  encodeLeaves,
  encodeParams,
  encodeReveal,
  encodeSettlement,
  type JsonObject,
} from '../src/serialize.ts';

/**
 * Static site + read-only JSON API for the public auction page.
 *
 * The privacy boundary is the point of this file. `scan.json` holds bid
 * amounts, refund addresses and memo plaintext — everything the auction exists
 * to hide. It is read here so the verifier can run, and never leaves this
 * process: `buildPublicBundle()` whitelists encoded artifacts and the report,
 * nothing else. `account.json` (which carries the UFVK) is never served either.
 *
 *   GET /                            the page
 *   GET /assets/*, /vendor/*         static files under web/
 *   GET /api/auctions                index of fixture auctions
 *   GET /api/auction/:slug           published artifacts + verification report
 *   GET /api/auction/:slug/report    verification report only (?mode=fixture|audit)
 *
 * No dependencies: node:http and node:fs, same as `src/`.
 */

const ZAT_PER_ZEC = 100_000_000;
const BLOCK_SECONDS = 75;
const TIP_OVERRIDE = 'tip';

export interface WebServerOptions {
  cwd?: string;
  fixturesDir?: string;
  webDir?: string;
}

export interface AuctionSummary {
  slug: string;
  kind: 'honest' | 'tamper';
  auction_id: string;
  network: string;
  result: Settlement['result'];
  rule: string;
  units: number;
  pool: string;
  mode: string;
  has_bond: boolean;
  deadline_height: number;
  clearing_price_zac: number;
  entries: number;
}

/**
 * The only bytes a browser is allowed to see. `auction` and `settlement` are
 * the encoded published artifacts; the report is verifier output. No scan, no
 * account, no memo plaintext.
 */
export interface PublicBundle extends AuctionSummary {
  auction: JsonObject;
  settlement: JsonObject;
  leaves: JsonObject | null;
  reveal: JsonObject | null;
  bond: JsonObject | null;
  quantum: JsonObject | null;
  commitments: Commitments | null;
  proofs: ProofMap | null;
  report: VerifyReport;
  chain: { tip_height: number; block_seconds: number; zat_per_zec: number };
}

function readJson<T>(dir: string, name: string): T | null {
  const p = join(dir, name);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8')) as T;
}

export function listAuctionDirs(fixturesDir: string): Array<{ slug: string; kind: 'honest' | 'tamper'; dir: string }> {
  const out: Array<{ slug: string; kind: 'honest' | 'tamper'; dir: string }> = [];
  if (!existsSync(fixturesDir)) return out;

  for (const name of readdirSync(fixturesDir).sort()) {
    const dir = join(fixturesDir, name);
    if (!statSync(dir).isDirectory() || name === 'tamper') continue;
    out.push({ slug: name, kind: 'honest', dir });
  }

  const tamperRoot = join(fixturesDir, 'tamper');
  if (existsSync(tamperRoot)) {
    for (const name of readdirSync(tamperRoot).sort()) {
      const dir = join(tamperRoot, name);
      if (!statSync(dir).isDirectory()) continue;
      out.push({ slug: name, kind: 'tamper', dir });
    }
  }
  return out;
}

interface BundleInputs {
  params: AuctionParams;
  settlement: Settlement;
  scan?: ScanView;
  proofs?: ProofMap;
  commitments?: Commitments;
  account?: AccountFile;
  reveal?: Reveal;
  bond?: BondView | null;
  refunds?: RefundArtifact;
  auction: JsonObject;
  leaves: JsonObject | null;
  revealJson: JsonObject | null;
  bondJson: JsonObject | null;
  quantum: JsonObject | null;
  settlementJson: JsonObject;
}

function readBundleInputs(dir: string): BundleInputs | null {
  const paramsRaw = readJson<unknown>(dir, 'auction.json');
  const settlementRaw = readJson<unknown>(dir, 'settlement.json');
  if (!paramsRaw || !settlementRaw) return null;
  const params = decodeParams(paramsRaw);
  const settlement = decodeSettlement(settlementRaw);
  const scanRaw = readJson<unknown>(dir, 'scan.json');
  const accountRaw = readJson<unknown>(dir, 'account.json');
  const revealRaw = readJson<unknown>(dir, 'reveal.json');
  const bondRaw = readJson<unknown>(dir, 'bond.json');
  const refundsRaw = readJson<unknown>(dir, 'refunds.json');

  const reveal = revealRaw ? decodeReveal(revealRaw) : undefined;
  const bond = bondRaw ? decodeBondView(bondRaw) : null;
  const account = accountRaw ? decodeAccount(accountRaw) : undefined;
  const leavesRaw = readJson<unknown>(dir, 'leaves.json');
  const quantumRaw = readJson<JsonObject>(dir, 'quantum.json');

  return {
    params,
    settlement,
    ...(scanRaw ? { scan: decodeScan(scanRaw) } : {}),
    proofs: readJson<ProofMap>(dir, 'proofs.json') ?? undefined,
    commitments: readJson<Commitments>(dir, 'commitments.json') ?? undefined,
    ...(account ? { account } : {}),
    ...(reveal ? { reveal } : {}),
    bond,
    ...(refundsRaw ? { refunds: decodeRefundArtifact(refundsRaw) } : {}),
    auction: encodeParams(params),
    leaves: leavesRaw ? (leavesRaw as JsonObject) : settlement.spec === 2 ? encodeLeaves(settlement) : null,
    revealJson: reveal ? encodeReveal(reveal) : null,
    bondJson: bond ? encodeBondView(bond) : null,
    quantum: quantumRaw ?? null,
    settlementJson: encodeSettlement(settlement),
  };
}

function reportFor(dir: string, mode?: Mode): VerifyReport | null {
  const inputs = readBundleInputs(dir);
  if (!inputs) return null;
  // Audit mode models a stranger with only the published bundle: no viewing
  // key, no rescan. The chain-dependent checks then skip instead of passing on
  // data the auditor does not have.
  return verify({
    params: inputs.params,
    settlement: inputs.settlement,
    scan: mode === 'audit' ? undefined : inputs.scan,
    proofs: inputs.proofs,
    commitments: inputs.commitments,
    account: inputs.account,
    reveal: inputs.reveal,
    bond: inputs.bond,
    refunds: inputs.refunds,
    mode,
  });
}

export function buildPublicBundle(
  entry: { slug: string; kind: 'honest' | 'tamper'; dir: string },
  tip?: number,
): PublicBundle | null {
  const inputs = readBundleInputs(entry.dir);
  if (!inputs) return null;
  const { params, settlement } = inputs;

  const report = verify({
    params,
    settlement,
    scan: inputs.scan,
    proofs: inputs.proofs,
    commitments: inputs.commitments,
    account: inputs.account,
    reveal: inputs.reveal,
    bond: inputs.bond,
    refunds: inputs.refunds,
    mode: 'fixture',
  });

  const heights = [
    params.opened_at_height,
    params.deadline_height,
    settlement.settle_height,
    ...settlement.refund_txs.map((t) => t.height),
  ];
  const derived = Math.max(...heights) + 1;
  const tipHeight = tip !== undefined && Number.isSafeInteger(tip) && tip > 0 ? tip : derived;

  return {
    slug: entry.slug,
    kind: entry.kind,
    auction_id: params.auction_id,
    network: params.network,
    result: settlement.result,
    rule: settlement.rule,
    units: settlement.units,
    pool: params.pool,
    mode: params.mode,
    has_bond: !!params.bond,
    deadline_height: params.deadline_height,
    clearing_price_zac: Number(settlement.clearing_price_zat) / ZAT_PER_ZEC,
    entries: settlement.entries.length,
    auction: inputs.auction,
    settlement: inputs.settlementJson,
    leaves: inputs.leaves,
    reveal: inputs.revealJson,
    bond: inputs.bondJson,
    quantum: inputs.quantum,
    commitments: inputs.commitments ?? null,
    proofs: inputs.proofs ?? null,
    report,
    chain: { tip_height: tipHeight, block_seconds: BLOCK_SECONDS, zat_per_zec: ZAT_PER_ZEC },
  };
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.mp4': 'video/mp4',
  '.txt': 'text/plain; charset=utf-8',
};

const SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy':
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; " +
    "base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
  'cache-control': 'no-store',
};

function send(res: import('node:http').ServerResponse, status: number, body: string | Buffer, type: string) {
  res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': type, 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function sendJson(res: import('node:http').ServerResponse, status: number, value: unknown) {
  send(res, status, JSON.stringify(value), 'application/json; charset=utf-8');
}

function notFound(res: import('node:http').ServerResponse, api: boolean) {
  if (api) return sendJson(res, 404, { error: 'not_found' });
  send(res, 404, '<!doctype html><title>404 — Secbid</title><h1>404</h1><p>No such page.</p>', MIME['.html']);
}

let sandboxModules: Set<string> | undefined;

export function createWebServer(options: WebServerOptions = {}): Server {
  const cwd = resolve(options.cwd ?? fileURLToPath(new URL('..', import.meta.url)));
  const fixturesDir = resolve(options.fixturesDir ?? join(cwd, 'fixtures'));
  const webDir = resolve(options.webDir ?? join(cwd, 'web'));

  return createServer((req: IncomingMessage, res) => {
    const rawUrl = req.url ?? '/';
    const url = new URL(rawUrl, 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);
    const isApi = pathname.startsWith('/api/');

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendJson(res, 405, { error: 'method_not_allowed' });
    }

    if (pathname === '/api/auctions') {
      const tip = parseTip(url.searchParams.get(TIP_OVERRIDE));
      const auctions: AuctionSummary[] = [];
      for (const entry of listAuctionDirs(fixturesDir)) {
        const bundle = buildPublicBundle(entry, tip);
        if (!bundle) continue;
        auctions.push({
          slug: bundle.slug,
          kind: bundle.kind,
          auction_id: bundle.auction_id,
          network: bundle.network,
          result: bundle.result,
          rule: bundle.rule,
          units: bundle.units,
          pool: bundle.pool,
          mode: bundle.mode,
          has_bond: bundle.bond !== null,
          deadline_height: bundle.deadline_height,
          clearing_price_zac: bundle.clearing_price_zac,
          entries: bundle.entries,
        });
      }
      return sendJson(res, 200, { auctions });
    }

    const auctionMatch = /^\/api\/auction\/([a-z0-9-]+)(\/report)?$/.exec(pathname);
    if (auctionMatch) {
      const slug = auctionMatch[1];
      const entry = listAuctionDirs(fixturesDir).find((e) => e.slug === slug);
      if (!entry) return notFound(res, true);

      const requested = url.searchParams.get('mode');
      const mode: Mode | undefined = requested === 'fixture' || requested === 'audit' ? requested : undefined;

      if (auctionMatch[2]) {
        const report = reportFor(entry.dir, mode);
        if (!report) return sendJson(res, 404, { error: 'not_found' });
        return sendJson(res, 200, { slug, report });
      }

      const bundle = buildPublicBundle(entry, parseTip(url.searchParams.get(TIP_OVERRIDE)));
      if (!bundle) return sendJson(res, 404, { error: 'not_found' });
      if (mode) bundle.report = reportFor(entry.dir, mode) ?? bundle.report;
      return sendJson(res, 200, bundle);
    }

    if (isApi) return notFound(res, true);

    // the sandbox page imports the core as browser JS, stripped from src/ on request
    const lib = /^\/lib\/([a-z0-9-]+)\.js$/.exec(pathname);
    if (lib) {
      sandboxModules ??= new Set(libClosure());
      if (!sandboxModules.has(lib[1])) return notFound(res, false);
      const body = libModule(lib[1]);
      res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': MIME['.js'], 'cache-control': 'no-store' });
      return res.end(req.method === 'HEAD' ? undefined : body);
    }

    const relative = normalize(pathname === '/' ? '/index.html' : pathname).replace(/^([/\\])+/, '');
    const filePath = resolve(join(webDir, relative));
    if (filePath !== webDir && !filePath.startsWith(webDir + sep)) return notFound(res, false);
    if (!existsSync(filePath) || !statSync(filePath).isFile()) return notFound(res, false);

    const type = MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
    const body = readFileSync(filePath);
    const cache = type.startsWith('text/html') ? 'no-store' : 'public, max-age=60';
    // Single byte ranges, so a <video> can seek (the demo film). Multi-range is not needed.
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
    if (range && (range[1] || range[2])) {
      const size = body.length;
      const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
      const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      if (start >= size || start > end) {
        res.writeHead(416, { ...SECURITY_HEADERS, 'content-range': `bytes */${size}` });
        return res.end();
      }
      res.writeHead(206, {
        ...SECURITY_HEADERS,
        'content-type': type,
        'content-length': end - start + 1,
        'content-range': `bytes ${start}-${end}/${size}`,
        'accept-ranges': 'bytes',
        'cache-control': cache,
      });
      return res.end(req.method === 'HEAD' ? undefined : body.subarray(start, end + 1));
    }
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'content-type': type,
      'content-length': body.length,
      'accept-ranges': 'bytes',
      'cache-control': cache,
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  });
}

function parseTip(value: string | null): number | undefined {
  if (!value) return undefined;
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 && n < 1e9 ? n : undefined;
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const port = Number(process.env.PORT ?? 4190);
  const host = process.env.HOST ?? '127.0.0.1';
  const allInterfaces = host === '0.0.0.0' || host === '::';
  const server = createWebServer();
  server.listen(port, host, () => {
    console.log(`secbid web  http://${allInterfaces ? 'localhost' : host}:${port}`);
    console.log('  no install step, no dependencies; fixtures are read-only');
    console.log('  try /?a=t2-truncate for a tampered settlement');
    console.log('  the API never serves scan.json or account.json (amounts, memos, UFVK)');
    if (!allInterfaces) return;
    for (const ifaces of Object.values(networkInterfaces())) {
      for (const iface of ifaces ?? []) {
        if (iface.family === 'IPv4' && !iface.internal) console.log(`  on your network  http://${iface.address}:${port}`);
      }
    }
    console.log('  note: the memo check needs WebCrypto, so it runs on localhost or https only');
  });
}
