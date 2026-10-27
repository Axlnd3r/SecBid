import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AccountFile,
  AuctionParams,
  BondView,
  Commitments,
  Mode,
  Pool,
  ProofMap,
  RefundArtifact,
  Reveal,
  Rule,
  ScanView,
  Settlement,
} from './model.ts';
import { SimulatedChain, choosePool } from './adapter.ts';
import {
  broadcastRefunds,
  checkProofMemo,
  DEFAULT_MAX_OUTPUTS_PER_TX,
  openAuction,
  planRefunds,
  settleAuction,
} from './auction.ts';
import { classifyAll } from './clearing.ts';
import { ovkCommitment } from './leaf.ts';
import { parseMemo, refundPlaceholder } from './memo.ts';
import { decodeProofMemo } from './proof.ts';
import { JsonRpcClient } from './rpc.ts';
import { createAuctionAccount, tipHeight, ZalletAdapter, zalletPoolSupport } from './zallet.ts';
import { buildPaymentUri, zecToZat } from './zip321.ts';
import { verify, type Mode as VerifyMode, type VerifyInput } from './verify.ts';
import {
  decodeAccount,
  decodeBondView,
  decodeParams,
  decodeRefundArtifact,
  decodeReveal,
  decodeScan,
  decodeSettlement,
  encodeAccount,
  encodeBondView,
  encodeLeaves,
  encodeParams,
  encodeRefundArtifact,
  encodeReveal,
  encodeScan,
  encodeSettlement,
  paramsHash,
  settlementHash,
} from './serialize.ts';
import { bondFingerprint, bondRecordToView, checkBond } from './bond.ts';
import { buildQuantumReport, redactQuantumReport, renderQuantumReport } from './quantum.ts';
import { buildRefundArtifact } from './refunds.ts';
import { buildAgentBid, checkAgentMemo, parseMandate } from './agent.ts';

/**
 * secbid <command>
 *
 *   open --address <u1…> --ovk <hex32> --reserve <zec> --deadline <height> --at <height>
 *        [--spec 1|2] [--rule first-price|uniform] [--units n] [--pool auto|ironwood|orchard]
 *        [--mode public-tender|private] [--bond-address <u1…> --bond <zec>] [--out <dir>]
 *   open --rpc <url> --name <account> ...            (creates the ephemeral auction account)
 *   scan <dir> --rpc <url> [...]
 *   settle <dir> --ufvk <uview1…>|--rpc <url> [--mode public-tender|private]
 *   verify <dir> [--mode fixture|audit] [--auditor --ovk <hex|$SECBID_OVK>]
 *   demo [--out <dir>] [--rule first-price|uniform] [--units n] [--mode public-tender|private]
 *   uri <dir>
 *   proof decode <base64> | proof check <dir> <base64>
 *   bond record <dir> --txid <hex> --height <n> [--spent-at <n> --spend-txid <hex>]
 *   bond show <dir>
 *   quantum-report <dir> [--history <dir>]...
 *   agent bid <dir> --mandate <file> | agent check <dir> <base64>
 *
 * `open` is the seller's command: it commits the params, the OVK hash, and the
 * bond terms before the first bid. With `--rpc` it also creates the ephemeral
 * account, so the address it prints is one the auctioneer's wallet can scan.
 * `settle --rpc` is the live path: scan, clear, broadcast refunds, publish.
 *
 * Exit codes: 0 ok (PASS or PARTIAL), 1 verification failed, 2 cannot evaluate.
 */

function readJson<T>(dir: string, name: string): T | null {
  const p = join(dir, name);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8')) as T;
}

function readParams(dir: string): AuctionParams | null {
  const raw = readJson<unknown>(dir, 'auction.json');
  return raw ? decodeParams(raw) : null;
}

function readSettlement(dir: string): Settlement | null {
  const raw = readJson<unknown>(dir, 'settlement.json');
  return raw ? decodeSettlement(raw) : null;
}

interface RpcOptions {
  rpc?: string;
  rpcUser?: string;
  cookieFile?: string;
}

function makeRpc(opts: RpcOptions): JsonRpcClient {
  if (!opts.rpc) throw new Error('--rpc <url> is required for the live path');
  if (opts.rpcUser && !process.env.SECBID_RPC_PASSWORD) {
    throw new Error('set SECBID_RPC_PASSWORD when using --rpc-user (never pass a password in argv)');
  }
  const auth = opts.cookieFile
    ? { cookieFile: opts.cookieFile }
    : opts.rpcUser
      ? { user: opts.rpcUser, password: process.env.SECBID_RPC_PASSWORD! }
      : undefined;
  return new JsonRpcClient({ url: opts.rpc, auth });
}

function requireAccount(dir: string, accountUuid?: string): AccountFile {
  const raw = readJson<unknown>(dir, 'account.json');
  if (!raw) {
    throw new Error(`${join(dir, 'account.json')} is missing; run \`secbid open --rpc\` first`);
  }
  const account = decodeAccount(raw);
  if (accountUuid && account.account_uuid !== accountUuid) {
    throw new Error(`--account ${accountUuid} does not match account.json`);
  }
  return account;
}

function writeJson(dir: string, name: string, value: unknown) {
  writeFileSync(join(dir, name), JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function usage(): never {
  console.error(
    [
      'usage:',
      '  secbid open --address <u1…> --ovk <hex32> --reserve <zec> --deadline <height> --at <height>',
      '              [--spec 1|2] [--rule first-price|uniform] [--units n] [--pool auto|ironwood|orchard]',
      '              [--mode public-tender|private] [--bond-address <u1…> --bond <zec>]',
      '              [--out <dir>] [--id <hex>] [--depth <n>] [--min-bid <zec>] [--network test|main|regtest]',
      '  secbid open --rpc <url> --name <account> --ovk <hex32> --reserve <zec> --deadline <height> [flags above]',
      '  secbid scan <dir> --rpc <url> [--account <uuid>] [--ovk <hex32>] [--cookie-file <path> | --rpc-user <user>]',
      '  secbid settle <dir> --ufvk <uview1…> [--out <dir>] [--height <n>] [--max-outputs <n>] [--auditor-ovk <hex>]',
      '  secbid settle <dir> --rpc <url> [--account <uuid>] [--ovk <hex32>] [--max-outputs <n>]',
      '  secbid verify <dir> [--mode fixture|audit] [--auditor --ovk <hex|$SECBID_OVK>] [--quiet] [--all]',
      '  secbid demo [--out <dir>] [--rule first-price|uniform] [--units n] [--mode public-tender|private]',
      '  secbid uri <dir>',
      '  secbid proof decode <base64> | proof check <dir> <base64>',
      '  secbid bond record <dir> --txid <hex> --height <n> [--spent-at <n> --spend-txid <hex>]',
      '  secbid bond show <dir>',
      '  secbid quantum-report <dir> [--history <dir>]...',
      '  secbid agent bid <dir> --mandate <file> | agent check <dir> <base64>',
    ].join('\n'),
  );
  process.exit(2);
}

function reportStatus(report: ReturnType<typeof verify>): string {
  if (report.status === 'FAIL') {
    return `RESULT: FAIL ${report.failures[0].code}: ${report.failures[0].message}`;
  }
  const passed = report.checks.filter((c) => c.status === 'pass').length;
  const skipped = report.checks.filter((c) => c.status === 'skip').length;
  if (report.status === 'PARTIAL') {
    return `RESULT: PARTIAL (${passed}/${report.checks.length} checks; ${skipped} need the viewing key)`;
  }
  return `RESULT: PASS (${passed}/${report.checks.length} checks)`;
}

function runVerify(argv: string[]): number {
  const [dir, ...rest] = argv;
  if (!dir) usage();

  let mode: VerifyMode | undefined;
  let quiet = false;
  let auditor = false;
  let ovk: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--mode') mode = rest[++i] as VerifyMode;
    else if (rest[i] === '--quiet') quiet = true;
    else if (rest[i] === '--all') continue;
    else if (rest[i] === '--auditor') auditor = true;
    else if (rest[i] === '--ovk') ovk = rest[++i];
    else usage();
  }
  if (mode !== undefined && mode !== 'fixture' && mode !== 'audit') usage();
  if (auditor && !ovk) ovk = process.env.SECBID_OVK;
  if (auditor && !ovk) {
    console.error('verify --auditor needs --ovk <hex> or SECBID_OVK (never logged)');
    return 2;
  }

  const params = readParams(dir);
  const settlement = readSettlement(dir);
  if (!params || !settlement) {
    console.error(`cannot evaluate: ${dir} needs auction.json and settlement.json`);
    return 2;
  }

  const input: VerifyInput = {
    params,
    settlement,
    scan: readJson<unknown>(dir, 'scan.json') ? decodeScan(readJson<unknown>(dir, 'scan.json')) : undefined,
    proofs: readJson<ProofMap>(dir, 'proofs.json') ?? undefined,
    commitments: readJson<Commitments>(dir, 'commitments.json') ?? undefined,
    account: readJson<unknown>(dir, 'account.json') ? decodeAccount(readJson<unknown>(dir, 'account.json')) : undefined,
    reveal: readJson<unknown>(dir, 'reveal.json') ? decodeReveal(readJson<unknown>(dir, 'reveal.json')) : undefined,
    bond: readJson<unknown>(dir, 'bond.json') ? decodeBondView(readJson<unknown>(dir, 'bond.json')) : null,
    refunds: readJson<unknown>(dir, 'refunds.json') ? decodeRefundArtifact(readJson<unknown>(dir, 'refunds.json')) : undefined,
    ...(auditor && ovk ? { auditor: { ovk } } : {}),
    mode,
  };

  const report = verify(input);

  if (!quiet) {
    console.log(`auction ${params.auction_id}  mode ${report.mode}  entries ${settlement.entries.length}`);
    for (const c of report.checks) {
      const mark = c.status === 'pass' ? 'pass' : c.status === 'fail' ? 'FAIL' : 'skip';
      console.log(`  ${c.code.padEnd(4)} ${mark.padEnd(4)} ${c.detail ?? ''}`);
    }
    for (const w of report.warnings) console.log(`  note     ${w}`);
  }

  console.log(reportStatus(report));
  return report.ok ? 0 : 1;
}

/* ── settlement pipeline, shared by `settle` and `demo` ──────────────────── */

interface SettlementRun {
  params: AuctionParams;
  settlement: Settlement;
  proofs: ProofMap;
  memos: Map<string, Uint8Array>;
  scan: ScanView;
  batch: ReturnType<typeof broadcastRefunds> extends Promise<infer R> ? R : never;
  account?: AccountFile;
  reveal: Reveal | null;
  bond: BondView | null;
  refundsArtifact: RefundArtifact | null;
}

interface SettlementOptions {
  ufvk: string;
  ovk?: string;
  settleHeight?: number;
  maxOutputsPerTx?: number;
  mode?: Mode;
  account?: AccountFile;
  bond?: BondView | null;
}

function commitmentFor(run: SettlementRun): Commitments {
  return {
    params_hash: run.params.params_hash,
    settlement_hash: settlementHash(run.settlement),
  };
}

async function settleRecorded(
  params: AuctionParams,
  view: ScanView,
  opts: SettlementOptions,
): Promise<SettlementRun> {
  // The scan view is the chain as it stood before refunds were broadcast. A
  // replay of an already-settled view must not double-count its refund outputs.
  const chain = new SimulatedChain(
    { ...view, refund_outputs: [] },
    { supportedPools: ['orchard', 'ironwood'] },
  );
  const notes = await chain.scan();
  const plan = planRefunds(params, notes);
  const batch = await broadcastRefunds(chain, plan, { maxOutputsPerTx: opts.maxOutputsPerTx });
  const scan = chain.snapshot();
  if (opts.ovk) scan.ovk = opts.ovk;

  const refundsArtifact =
    params.spec === 2 ? buildRefundArtifact(params.auction_id, plan, batch) : null;
  const privateMode = (opts.mode ?? params.mode) === 'private';
  const settleHeight = opts.settleHeight ?? params.deadline_height + params.confirmations;
  const { settlement, proofs, memos } = settleAuction({
    params,
    notes,
    ufvk: privateMode ? null : opts.ufvk,
    settle_height: settleHeight,
    refunds: batch,
    ...(refundsArtifact ? { refunds_commitment: refundsArtifact.outputs_hash } : {}),
  });

  return {
    params,
    settlement,
    proofs,
    memos,
    scan,
    batch,
    ...(opts.account ? { account: opts.account } : {}),
    reveal: privateMode ? null : { ufvk: opts.ufvk, reveal_height: settleHeight },
    bond: opts.bond ?? null,
    refundsArtifact,
  };
}

function writeArtifacts(out: string, run: SettlementRun): { largestMemo: number } {
  mkdirSync(out, { recursive: true });
  writeJson(out, 'auction.json', encodeParams(run.params));
  writeJson(out, 'settlement.json', encodeSettlement(run.settlement));
  writeJson(out, 'proofs.json', run.proofs);
  writeJson(out, 'scan.json', encodeScan(run.scan, run.params.spec));
  writeJson(out, 'commitments.json', commitmentFor(run));
  if (run.account) writeJson(out, 'account.json', encodeAccount(run.account));
  if (run.reveal) writeJson(out, 'reveal.json', encodeReveal(run.reveal));
  if (run.bond) writeJson(out, 'bond.json', encodeBondView(run.bond));
  if (run.params.spec === 2) {
    writeJson(out, 'leaves.json', encodeLeaves(run.settlement));
    if (run.refundsArtifact) writeJson(out, 'refunds.json', encodeRefundArtifact(run.refundsArtifact));
  }

  const memoDir = join(out, 'memos');
  mkdirSync(memoDir, { recursive: true });
  let largestMemo = 0;
  for (const [leaf, memo] of run.memos) {
    largestMemo = Math.max(largestMemo, memo.length);
    writeFileSync(join(memoDir, `${leaf}.base64`), Buffer.from(memo).toString('base64') + '\n', 'utf8');
  }
  return { largestMemo };
}

function verifyRun(run: SettlementRun, auditorOvk?: string) {
  return verify({
    params: run.params,
    settlement: run.settlement,
    scan: run.scan,
    proofs: run.proofs,
    commitments: commitmentFor(run),
    ...(run.account ? { account: run.account } : {}),
    ...(run.reveal ? { reveal: run.reveal } : {}),
    bond: run.bond,
    ...(run.refundsArtifact ? { refunds: run.refundsArtifact } : {}),
    ...(auditorOvk ? { auditor: { ovk: auditorOvk } } : {}),
    mode: 'fixture',
    // settle/demo run in the auctioneer's process, which holds the UFVK. The
    // published `verify` command never sets this.
    fullView: true,
  });
}

function reportLine(run: SettlementRun, auditorOvk?: string): number {
  const report = verifyRun(run, auditorOvk);
  console.log(reportStatus(report));
  return report.ok ? 0 : 1;
}

/* ── open ───────────────────────────────────────────────────────────────── */

async function runOpen(argv: string[]): Promise<number> {
  const opts: {
    out?: string;
    address?: string;
    ovk?: string;
    reserve?: string;
    deadline?: number;
    at?: number;
    depth?: number;
    minBid?: string;
    network?: AuctionParams['network'];
    id?: string;
    rpc?: string;
    rpcUser?: string;
    cookieFile?: string;
    name?: string;
    spec?: 1 | 2;
    rule?: Rule;
    units?: number;
    pool?: 'auto' | Pool;
    mode?: Mode;
    bond?: string;
    bondAddress?: string;
  } = {};

  const number = (flag: string, raw: string | undefined): number => {
    if (raw === undefined) usage();
    const n = Number(raw);
    if (!Number.isSafeInteger(n) || n < 0) {
      console.error(`${flag} must be a non-negative integer height: ${raw}`);
      process.exit(2);
    }
    return n;
  };

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    switch (flag) {
      case '--out': opts.out = argv[++i]; break;
      case '--address': opts.address = argv[++i]; break;
      case '--ovk': opts.ovk = argv[++i]; break;
      case '--reserve': opts.reserve = argv[++i]; break;
      case '--deadline': opts.deadline = number(flag, argv[++i]); break;
      case '--at':
      case '--height': opts.at = number(flag, argv[++i]); break;
      case '--depth': opts.depth = number(flag, argv[++i]); break;
      case '--min-bid': opts.minBid = argv[++i]; break;
      case '--id': opts.id = argv[++i]; break;
      case '--rpc': opts.rpc = argv[++i]; break;
      case '--rpc-user': opts.rpcUser = argv[++i]; break;
      case '--cookie-file': opts.cookieFile = argv[++i]; break;
      case '--name': opts.name = argv[++i]; break;
      case '--bond': opts.bond = argv[++i]; break;
      case '--bond-address': opts.bondAddress = argv[++i]; break;
      case '--rule': {
        const value = argv[++i];
        if (value !== 'first-price' && value !== 'uniform') {
          console.error(`--rule must be first-price or uniform: ${value}`);
          return 2;
        }
        opts.rule = value;
        break;
      }
      case '--mode': {
        const value = argv[++i];
        if (value !== 'public-tender' && value !== 'private') {
          console.error(`--mode must be public-tender or private: ${value}`);
          return 2;
        }
        opts.mode = value;
        break;
      }
      case '--pool': {
        const value = argv[++i];
        if (value !== 'auto' && value !== 'ironwood' && value !== 'orchard') {
          console.error(`--pool must be auto, ironwood, or orchard: ${value}`);
          return 2;
        }
        opts.pool = value;
        break;
      }
      case '--spec': {
        if (argv[++i] !== '2' && argv[i] !== '1') {
          console.error('--spec must be 1 or 2');
          return 2;
        }
        opts.spec = argv[i] === '1' ? 1 : 2;
        break;
      }
      case '--units': {
        const n = Number(argv[++i]);
        if (!Number.isSafeInteger(n) || n < 1) {
          console.error('--units must be a positive integer');
          return 2;
        }
        opts.units = n;
        break;
      }
      case '--network': {
        const value = argv[++i];
        if (value !== 'main' && value !== 'test' && value !== 'regtest') {
          console.error(`--network must be main, test, or regtest: ${value}`);
          return 2;
        }
        opts.network = value;
        break;
      }
      default:
        usage();
    }
  }

  if (!opts.out || !opts.ovk || !opts.reserve || opts.deadline === undefined) usage();
  if (opts.rpc) {
    if (!opts.name) {
      console.error('open --rpc needs --name <account name>: a fresh account per auction');
      return 2;
    }
    if (opts.address) {
      console.error('open: --address is for the offline path; --rpc creates the account address');
      return 2;
    }
  } else if (!opts.address || opts.at === undefined) {
    usage();
  }
  if (!!opts.bond !== !!opts.bondAddress) {
    console.error('open: --bond and --bond-address go together');
    return 2;
  }

  let params: AuctionParams;
  let account: AccountFile | null = null;
  try {
    const spec = opts.spec ?? 2;
    const rule = opts.rule ?? 'first-price';
    const units = opts.units ?? 1;
    const mode = opts.mode ?? 'public-tender';
    if (!/^[0-9a-f]{64}$/i.test(opts.ovk)) throw new Error('ovk must be 32 bytes of hex (64 characters)');
    if (opts.id && !new RegExp(`^[0-9a-f]{${spec === 1 ? 16 : 32}}$`).test(opts.id)) {
      throw new Error(`auction_id must be ${spec === 1 ? 16 : 32} hex chars for spec ${spec}`);
    }
    const reserveZat = zecToZat(opts.reserve);
    const minBidZat = zecToZat(opts.minBid ?? '0.0001');
    if (reserveZat < minBidZat) throw new Error('reserve_zat must be at least min_bid_zat');
    if (spec === 1 && (rule !== 'first-price' || units !== 1 || mode !== 'public-tender' || opts.bond)) {
      throw new Error('spec 1 supports only first-price, one unit, public-tender, and no bond');
    }

    let address = opts.address;
    let openedAt = opts.at;
    let pool: Pool = opts.pool === 'ironwood' ? 'ironwood' : 'orchard';
    let poolWarning: string | undefined;

    if (opts.rpc) {
      const rpc = makeRpc(opts);
      const tip = await tipHeight(rpc);
      openedAt ??= tip;
      if (opts.deadline <= openedAt) {
        console.error(`deadline ${opts.deadline} must be after the current height ${openedAt}`);
        return 2;
      }
      const choice = await choosePool({ supportsPool: zalletPoolSupport }, opts.pool ?? 'orchard');
      pool = choice.pool;
      poolWarning = choice.warning;
      const created = await createAuctionAccount(rpc, opts.name!, pool);
      address = created.address;
      account = {
        account_uuid: created.account_uuid,
        address: created.address,
        ufvk: created.ufvk,
        pool: created.pool,
        height: openedAt,
      };
    } else if (opts.pool === 'auto') {
      poolWarning =
        'pool auto had no wallet to ask; recorded orchard. Connect --rpc to probe Ironwood support.';
    }

    params = openAuction({
      spec,
      auction_id: opts.id ?? randomBytes(spec === 1 ? 8 : 16).toString('hex'),
      network: opts.network ?? 'test',
      address: address!,
      reserve_zat: reserveZat,
      deadline_height: opts.deadline,
      confirmations: opts.depth ?? 3,
      min_bid_zat: minBidZat,
      rule,
      units,
      pool,
      mode,
      bond: opts.bond
        ? { address: opts.bondAddress!, amount_zat: zecToZat(opts.bond) }
        : null,
      opened_at_height: openedAt!,
      ovk: opts.ovk,
      ...(poolWarning ? { pool_warning: poolWarning } : {}),
    });
  } catch (err) {
    console.error(`cannot open auction: ${(err as Error).message}`);
    return 2;
  }

  mkdirSync(opts.out, { recursive: true });
  writeJson(opts.out, 'auction.json', encodeParams(params));
  if (account) writeJson(opts.out, 'account.json', encodeAccount(account));

  const refund = refundPlaceholder(params.address);
  const memo =
    params.spec === 2
      ? Buffer.from(JSON.stringify({ v: 2, refund, qty: '1' }), 'utf8')
      : Buffer.from(JSON.stringify({ v: 1, refund }), 'utf8');
  const uri = buildPaymentUri({ address: params.address, memo: new Uint8Array(memo) });

  console.log(`opened auction ${params.auction_id}  (${params.network}, spec ${params.spec})`);
  console.log(`  address        ${params.address}`);
  console.log(`  rule           ${params.rule}${params.rule === 'uniform' ? `, ${params.units} units` : ''}`);
  console.log(`  pool           ${params.pool}${params.pool_warning ? ' (fallback recorded)' : ''}`);
  console.log(`  mode           ${params.mode}`);
  console.log(`  reserve        ${opts.reserve} ZEC`);
  console.log(`  min bid        ${opts.minBid ?? '0.0001'} ZEC`);
  console.log(`  deadline       block ${params.deadline_height}`);
  console.log(`  confirmations  ${params.confirmations} blocks`);
  console.log(`  params_hash    ${params.params_hash}`);
  console.log(`  ovk_commitment ${params.ovk_commitment}`);
  if (params.bond) {
    console.log(`  bond           ${params.bond.amount_zat} zat to ${params.bond.address}`);
    console.log(`  bond_fp        ${bondFingerprint(params.bond)}`);
  }
  console.log(`  artifacts      ${join(opts.out, 'auction.json')}`);
  if (params.pool_warning) console.log(`  warning        ${params.pool_warning}`);
  if (account) {
    console.log(`  account        ${account.account_uuid}`);
    console.log(`  ufvk           ${account.ufvk.slice(0, 24)}…  (published at settlement)`);
  }
  console.log('');
  console.log('payment URI (the bidder replaces the memo placeholder with a fresh shielded address):');
  console.log(`  ${uri}`);
  console.log('');
  console.log('next:');
  if (params.bond) {
    console.log(`  secbid bond record ${opts.out} --txid <bond txid> --height <n>`);
  }
  if (account) {
    console.log(`  secbid scan ${opts.out} --rpc <url>         # list the notes the wallet can see`);
    console.log(`  secbid settle ${opts.out} --rpc <url>       # live: scan, clear, refund, verify`);
  } else {
    console.log(`  secbid settle ${opts.out} --ufvk <uview1…>   # needs scan.json from the adapter`);
  }
  console.log(`  secbid verify ${opts.out} --mode audit       # before settlement: params only`);
  return 0;
}

/* ── scan ───────────────────────────────────────────────────────────────── */

async function runScan(argv: string[]): Promise<number> {
  const [dir, ...rest] = argv;
  if (!dir) usage();

  const opts: RpcOptions & { account?: string; ovk?: string } = {};
  for (let i = 0; i < rest.length; i++) {
    switch (rest[i]) {
      case '--rpc': opts.rpc = rest[++i]; break;
      case '--rpc-user': opts.rpcUser = rest[++i]; break;
      case '--cookie-file': opts.cookieFile = rest[++i]; break;
      case '--account': opts.account = rest[++i]; break;
      case '--ovk': opts.ovk = rest[++i]; break;
      default:
        usage();
    }
  }

  const params = readParams(dir);
  if (!params) {
    console.error(`cannot scan: ${join(dir, 'auction.json')} is missing`);
    return 2;
  }

  try {
    const account = requireAccount(dir, opts.account);
    if (account.address !== params.address) {
      throw new Error('account.json address does not match auction.json: wrong auction account');
    }
    if (opts.ovk && ovkCommitment(params.auction_id, opts.ovk) !== params.ovk_commitment) {
      throw new Error('--ovk does not match the commitment published at open');
    }
    const rpc = makeRpc(opts);
    const adapter = new ZalletAdapter({
      rpc,
      accountUuid: account.account_uuid,
      address: params.address,
      ufvk: account.ufvk,
    });
    const notes = await adapter.scan(account.ufvk, params.opened_at_height);
    const scan: ScanView = {
      chain_tx_count: new Set(notes.map((n) => n.txid)).size,
      chain_note_count: notes.length,
      notes,
      refund_outputs: [],
      ovk: opts.ovk ?? '',
    };
    writeJson(dir, 'scan.json', encodeScan(scan, params.spec));

    const counts = new Map<string, number>();
    for (const note of classifyAll(notes, params)) {
      counts.set(note.pre, (counts.get(note.pre) ?? 0) + 1);
    }
    const summary = [...counts].map(([outcome, n]) => `${n} ${outcome}`).join(', ') || 'none';
    console.log(`scanned ${notes.length} note(s) in ${scan.chain_tx_count} tx at ${rpc.endpoint()}`);
    console.log(`  outcomes  ${summary}`);
    console.log(`  written   ${join(dir, 'scan.json')}`);
    return 0;
  } catch (err) {
    console.error(`cannot scan: ${(err as Error).message}`);
    return 2;
  }
}

/* ── settle ─────────────────────────────────────────────────────────────── */

interface LiveSettleOptions {
  ufvk: string;
  ovk?: string;
  settleHeight?: number;
  maxOutputsPerTx?: number;
  mode?: Mode;
  account?: AccountFile;
  bond?: BondView | null;
}

async function settleLive(
  params: AuctionParams,
  account: AccountFile,
  rpc: JsonRpcClient,
  opts: LiveSettleOptions,
): Promise<SettlementRun> {
  const minimumSettleHeight = params.deadline_height + params.confirmations;
  const settleHeight = opts.settleHeight ?? minimumSettleHeight;
  if (settleHeight < minimumSettleHeight) {
    throw new Error(`--height ${settleHeight} is before deadline + confirmations ${minimumSettleHeight}`);
  }

  const tip = await tipHeight(rpc);
  if (tip < settleHeight) {
    throw new Error(
      `node tip ${tip} is before settle height ${settleHeight}; wait ${settleHeight - tip} more block(s)`,
    );
  }
  if (opts.ovk && ovkCommitment(params.auction_id, opts.ovk) !== params.ovk_commitment) {
    throw new Error('--ovk does not match the commitment published at open');
  }

  const adapter = new ZalletAdapter({
    rpc,
    accountUuid: account.account_uuid,
    address: params.address,
    ufvk: opts.ufvk,
  });
  const notes = await adapter.scan(opts.ufvk, params.opened_at_height);
  const plan = planRefunds(params, notes);
  const batch = await broadcastRefunds(adapter, plan, { maxOutputsPerTx: opts.maxOutputsPerTx });

  const heights = new Map(batch.txs.map((tx) => [tx.txid, tx.height]));
  const refundOutputs = plan.map((entry) => {
    const txid = batch.by_leaf[entry.leaf];
    const height = txid ? heights.get(txid) : undefined;
    if (!txid || height === undefined) {
      throw new Error('internal: a refund entry was not assigned a mined transaction');
    }
    return { txid, height, address: entry.address, value_zat: entry.value_zat, pool: params.pool };
  });

  const scan: ScanView = {
    chain_tx_count: new Set(notes.map((n) => n.txid)).size,
    chain_note_count: notes.length,
    notes,
    refund_outputs: refundOutputs,
    ovk: opts.ovk ?? '',
  };

  const refundsArtifact = params.spec === 2 ? buildRefundArtifact(params.auction_id, plan, batch) : null;
  const privateMode = (opts.mode ?? params.mode) === 'private';
  const { settlement, proofs, memos } = settleAuction({
    params,
    notes,
    ufvk: privateMode ? null : opts.ufvk,
    settle_height: settleHeight,
    refunds: batch,
    ...(refundsArtifact ? { refunds_commitment: refundsArtifact.outputs_hash } : {}),
  });

  return {
    params,
    settlement,
    proofs,
    memos,
    scan,
    batch,
    account,
    reveal: privateMode ? null : { ufvk: opts.ufvk, reveal_height: settleHeight },
    bond: opts.bond ?? null,
    refundsArtifact,
  };
}

function printRun(out: string, run: SettlementRun, largestMemo: number): number {
  const winners = run.settlement.entries.filter((e) => e.outcome === 'winner');
  const refunded = run.settlement.entries.filter((e) => e.refund_txid !== null).length;
  const firstTx = run.batch.txs[0];
  console.log(`settled ${run.settlement.entries.length} notes at height ${run.settlement.settle_height}`);
  console.log(`  rule            ${run.settlement.rule}${run.settlement.rule === 'uniform' ? ` / ${run.settlement.units} units` : ''}`);
  console.log(`  result          ${run.settlement.result}`);
  console.log(`  clearing price  ${run.settlement.clearing_price_zat} zat per unit`);
  console.log(`  winners         ${winners.length}`);
  for (const w of winners) {
    console.log(`    ${w.leaf}  filled ${w.filled_qty}/${w.qty}  pays ${w.payment_zat} zat`);
  }
  console.log(
    `  refunds         ${refunded} outputs in ${run.batch.txs.length} tx` +
      (firstTx ? ` at height ${firstTx.height}` : ''),
  );
  console.log(`  memos           ${run.memos.size}, largest ${largestMemo}/512 bytes`);
  console.log(`  mode            ${run.settlement.ufvk ? 'public-tender' : 'private (no UFVK published)'}`);
  console.log(`  artifacts       ${out}`);
  console.log('');
  return reportLine(run, run.params.mode === 'private' ? run.scan.ovk || undefined : undefined);
}

async function runSettle(argv: string[]): Promise<number> {
  const [dir, ...rest] = argv;
  if (!dir) usage();

  let out = dir;
  let ufvk: string | undefined;
  let settleHeight: number | undefined;
  let maxOutputsPerTx: number | undefined;
  let ovk: string | undefined;
  let modeOverride: Mode | undefined;
  const rpcOpts: RpcOptions & { account?: string } = {};

  for (let i = 0; i < rest.length; i++) {
    switch (rest[i]) {
      case '--out': out = rest[++i]; break;
      case '--ufvk': ufvk = rest[++i]; break;
      case '--rpc': rpcOpts.rpc = rest[++i]; break;
      case '--rpc-user': rpcOpts.rpcUser = rest[++i]; break;
      case '--cookie-file': rpcOpts.cookieFile = rest[++i]; break;
      case '--account': rpcOpts.account = rest[++i]; break;
      case '--ovk':
      case '--auditor-ovk': ovk = rest[++i]; break;
      case '--mode': {
        const value = rest[++i];
        if (value !== 'public-tender' && value !== 'private') {
          console.error(`--mode must be public-tender or private: ${value}`);
          return 2;
        }
        modeOverride = value;
        break;
      }
      case '--height': {
        const n = Number(rest[++i]);
        if (!Number.isSafeInteger(n) || n < 0) {
          console.error(`--height must be a block height: ${rest[i]}`);
          return 2;
        }
        settleHeight = n;
        break;
      }
      case '--max-outputs': {
        const n = Number(rest[++i]);
        if (!Number.isSafeInteger(n) || n < 1) {
          console.error(`--max-outputs must be a positive integer: ${rest[i]}`);
          return 2;
        }
        maxOutputsPerTx = n;
        break;
      }
      default:
        usage();
    }
  }

  const params = readParams(dir);
  if (!params) {
    console.error(`cannot settle: ${join(dir, 'auction.json')} is missing`);
    return 2;
  }
  if (modeOverride && modeOverride !== params.mode) {
    console.error(
      `cannot settle: auction.json declares mode ${params.mode}; open with --mode ${modeOverride} instead of overriding at settlement`,
    );
    return 2;
  }
  const privateMode = params.mode === 'private';
  if (!privateMode && rpcOpts.rpc && !ovk) {
    console.error(
      'settle --rpc in public-tender mode needs --ovk: C10 recomputes the OVK commitment, ' +
        'and an artifact that cannot pass C10 should not be published',
    );
    return 2;
  }
  const bond = readJson<unknown>(dir, 'bond.json') ? decodeBondView(readJson<unknown>(dir, 'bond.json')) : null;
  if (params.bond && !bond) {
    console.error(
      `cannot settle: auction.json commits a bond but ${join(dir, 'bond.json')} is missing; run \`secbid bond record\` first`,
    );
    return 2;
  }

  let run: SettlementRun;
  try {
    if (rpcOpts.rpc) {
      const account = requireAccount(dir, rpcOpts.account);
      if (account.address !== params.address) {
        throw new Error('account.json address does not match auction.json: wrong auction account');
      }
      const publishedUfvk = ufvk ?? account.ufvk;
      run = await settleLive(params, account, makeRpc(rpcOpts), {
        ufvk: publishedUfvk,
        ovk,
        settleHeight,
        maxOutputsPerTx,
        account,
        bond,
      });
    } else {
      if (!ufvk && !privateMode) {
        console.error('settle: --ufvk is required; the settlement publishes it so anyone can rescan');
        return 2;
      }
      const rawScan = readJson<unknown>(dir, 'scan.json');
      if (!rawScan) {
        console.error(`cannot settle: ${dir} needs scan.json for the recorded path`);
        return 2;
      }
      const view = decodeScan(rawScan);
      run = await settleRecorded(params, view, {
        ufvk: ufvk ?? view.ovk ?? '',
        ovk,
        settleHeight,
        maxOutputsPerTx,
        account: readJson<unknown>(dir, 'account.json') ? decodeAccount(readJson<unknown>(dir, 'account.json')) : undefined,
        bond,
      });
    }
  } catch (err) {
    console.error(`cannot settle: ${(err as Error).message}`);
    return 2;
  }
  const { largestMemo } = writeArtifacts(out, run);
  return printRun(out, run, largestMemo);
}

/* ── demo ───────────────────────────────────────────────────────────────── */

function deriveParams(
  base: AuctionParams,
  overrides: { rule?: Rule; units?: number; mode?: Mode },
): AuctionParams {
  const rule = overrides.rule ?? base.rule;
  const units = overrides.units ?? (rule === 'first-price' ? 1 : base.units);
  const mode = overrides.mode ?? base.mode;
  const next: AuctionParams = {
    ...base,
    spec: 2,
    rule,
    units,
    mode,
    params_hash: '',
  };
  return { ...next, params_hash: paramsHash(next) };
}

/**
 * Replays a recorded auction through the live settlement and refund path.
 * The chain is simulated; the logic is the real thing.
 */
async function runDemo(argv: string[]): Promise<number> {
  let out = join(process.cwd(), 'demo-out');
  let rule: Rule | undefined;
  let units: number | undefined;
  let mode: Mode | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') out = argv[++i];
    else if (argv[i] === '--rule') {
      const value = argv[++i];
      if (value !== 'first-price' && value !== 'uniform') {
        console.error(`--rule must be first-price or uniform: ${value}`);
        return 2;
      }
      rule = value;
    } else if (argv[i] === '--units') {
      const n = Number(argv[++i]);
      if (!Number.isSafeInteger(n) || n < 1) {
        console.error('--units must be a positive integer');
        return 2;
      }
      units = n;
    } else if (argv[i] === '--mode') {
      const value = argv[++i];
      if (value !== 'public-tender' && value !== 'private') {
        console.error(`--mode must be public-tender or private: ${value}`);
        return 2;
      }
      mode = value;
    } else usage();
  }

  const wantsV2 = rule === 'uniform' || units !== undefined || mode === 'private';
  const source = join(process.cwd(), 'fixtures', wantsV2 ? 'auction-02' : 'auction-01');
  const rawParams = readParams(source);
  const rawScan = readJson<unknown>(source, 'scan.json');
  if (!rawParams || !rawScan) {
    console.error(`cannot demo: ${source} is missing auction.json or scan.json`);
    return 2;
  }
  const view = decodeScan(rawScan);
  const params = wantsV2 ? deriveParams(rawParams, { rule, units, mode }) : rawParams;
  const bond = readJson<unknown>(source, 'bond.json') ? decodeBondView(readJson<unknown>(source, 'bond.json')) : null;
  const account = readJson<unknown>(source, 'account.json') ? decodeAccount(readJson<unknown>(source, 'account.json')) : undefined;

  const ufvk = view.ovk ? `uview1demo${view.ovk.slice(0, 40)}` : 'uview1secbiddemoauctionviewingkey0000000000000000000000000000000000000000';
  const run = await settleRecorded(params, view, {
    ufvk,
    ovk: view.ovk,
    maxOutputsPerTx: DEFAULT_MAX_OUTPUTS_PER_TX,
    account,
    bond,
    mode: params.mode,
  });
  const { largestMemo } = writeArtifacts(out, run);
  return printRun(out, run, largestMemo);
}

/* ── uri, proof ─────────────────────────────────────────────────────────── */

function runUri(argv: string[]): number {
  const [dir] = argv;
  if (!dir) usage();
  const params = readParams(dir);
  if (!params) {
    console.error(`cannot read ${join(dir, 'auction.json')}`);
    return 2;
  }
  const refund = refundPlaceholder(params.address);
  const memo =
    params.spec === 2
      ? Buffer.from(JSON.stringify({ v: 2, refund, qty: '1' }), 'utf8')
      : Buffer.from(JSON.stringify({ v: 1, refund }), 'utf8');
  const uri = buildPaymentUri({ address: params.address, memo: new Uint8Array(memo) });
  console.log(`address      ${params.address}`);
  console.log(`rule         ${params.rule}${params.rule === 'uniform' ? `, ${params.units} units` : ''}`);
  console.log(`pool         ${params.pool}`);
  console.log(`mode         ${params.mode}`);
  console.log(`reserve      ${params.reserve_zat} zat per unit`);
  console.log(`deadline     block ${params.deadline_height}`);
  console.log(`payment URI  ${uri}`);
  console.log('');
  console.log('memo template (the bidder replaces the refund address with a fresh one):');
  console.log(`  ${memo.toString('utf8')}`);
  return 0;
}

function runProof(argv: string[]): number {
  const [sub, ...rest] = argv;
  if (sub === 'decode') {
    const [encoded] = rest;
    if (!encoded) usage();
    const memo = decodeProofMemo(new Uint8Array(Buffer.from(encoded, 'base64')));
    console.log(JSON.stringify(memo, null, 2));
    return 0;
  }
  if (sub === 'check') {
    const [dir, encoded] = rest;
    if (!dir || !encoded) usage();
    const settlement = readSettlement(dir);
    if (!settlement) {
      console.error(`cannot read ${join(dir, 'settlement.json')}`);
      return 2;
    }
    const result = checkProofMemo(new Uint8Array(Buffer.from(encoded, 'base64')), settlement);
    if (result.ok) {
      console.log('MEMO: OK (inclusion proof, outcome, and price match the settlement)');
      return 0;
    }
    for (const p of result.problems) console.log(`  problem: ${p}`);
    console.log('MEMO: MISMATCH');
    return 1;
  }
  usage();
}

/* ── bond ───────────────────────────────────────────────────────────────── */

function runBond(argv: string[]): number {
  const [sub, dir, ...rest] = argv;
  if (!sub || !dir) usage();
  const params = readParams(dir);
  if (!params) {
    console.error(`cannot read ${join(dir, 'auction.json')}`);
    return 2;
  }

  if (sub === 'show') {
    if (!params.bond) {
      console.log('no bond committed in auction.json');
      return 0;
    }
    const view = readJson<unknown>(dir, 'bond.json') ? decodeBondView(readJson<unknown>(dir, 'bond.json')) : null;
    console.log(`bond commitment  ${params.bond.commitment}`);
    console.log(`  address        ${params.bond.address}`);
    console.log(`  amount         ${params.bond.amount_zat} zat`);
    if (!view) {
      console.log('  transaction    not recorded yet');
      return 0;
    }
    console.log(`  txid           ${view.txid}`);
    console.log(`  funded at      block ${view.funded_at_height}`);
    console.log(`  spent at       ${view.spent_at_height ?? 'not spent'}`);
    const check = checkBond(params, view, {
      firstBidHeight: null,
      releaseHeight: params.deadline_height + params.confirmations,
    });
    console.log(`  check          ${check.ok ? 'PASS' : 'FAIL'} — ${check.detail}`);
    return check.ok ? 0 : 1;
  }

  if (sub === 'record') {
    let txid: string | undefined;
    let height: number | undefined;
    let spentAt: number | null = null;
    let spendTxid: string | null = null;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '--txid') txid = rest[++i];
      else if (rest[i] === '--height') height = Number(rest[++i]);
      else if (rest[i] === '--spent-at') spentAt = Number(rest[++i]);
      else if (rest[i] === '--spend-txid') spendTxid = rest[++i];
      else usage();
    }
    if (!txid || height === undefined || !Number.isSafeInteger(height) || height < 0) {
      console.error('bond record needs --txid <hex> and --height <block>');
      return 2;
    }
    try {
      const view = bondRecordToView(params, {
        txid,
        funded_at_height: height,
        spent_at_height: spentAt,
        spend_txid: spendTxid,
      });
      writeJson(dir, 'bond.json', encodeBondView(view));
      console.log(`bond recorded: ${view.txid} funded at block ${view.funded_at_height}`);
      const check = checkBond(params, view, {
        firstBidHeight: null,
        releaseHeight: params.deadline_height + params.confirmations,
      });
      console.log(`  pre-settlement check  ${check.ok ? 'PASS' : 'FAIL'} — ${check.detail}`);
      return check.ok ? 0 : 1;
    } catch (err) {
      console.error(`cannot record bond: ${(err as Error).message}`);
      return 2;
    }
  }
  usage();
}

/* ── quantum-report ─────────────────────────────────────────────────────── */

function runQuantumReport(argv: string[]): number {
  const [dir, ...rest] = argv;
  if (!dir) usage();
  const historyDirs: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--history') historyDirs.push(rest[++i]);
    else usage();
  }
  const params = readParams(dir);
  if (!params) {
    console.error(`cannot read ${join(dir, 'auction.json')}`);
    return 2;
  }
  const settlement = readSettlement(dir);
  const rawScan = readJson<unknown>(dir, 'scan.json');
  const scan = rawScan ? decodeScan(rawScan) : null;
  const reveal = readJson<unknown>(dir, 'reveal.json') ? decodeReveal(readJson<unknown>(dir, 'reveal.json')) : null;
  const bond = readJson<unknown>(dir, 'bond.json') ? decodeBondView(readJson<unknown>(dir, 'bond.json')) : null;

  const history = new Set<string>();
  for (const historyDir of historyDirs) {
    const raw = readJson<unknown>(historyDir, 'scan.json');
    if (!raw) continue;
    const other = decodeScan(raw);
    for (const note of other.notes) {
      const parsed = parseMemo(note.memo_raw);
      if (parsed.ok) history.add(parsed.memo.refund);
    }
  }

  const report = buildQuantumReport({ params, settlement, scan, reveal, bond, history });
  // The artifact is public. The operator's terminal may name the reused address;
  // the file may not, because that would link a loser to their refund output.
  writeJson(dir, 'quantum.json', redactQuantumReport(report));
  console.log(renderQuantumReport(report));
  return 0;
}

/* ── agent ──────────────────────────────────────────────────────────────── */

function runAgent(argv: string[]): number {
  const [sub, ...rest] = argv;
  if (sub === 'bid') {
    const [dir] = rest;
    let mandatePath: string | undefined;
    for (let i = 1; i < rest.length; i++) {
      if (rest[i] === '--mandate') mandatePath = rest[++i];
      else usage();
    }
    if (!dir || !mandatePath) usage();
    const params = readParams(dir);
    if (!params) {
      console.error(`cannot read ${join(dir, 'auction.json')}`);
      return 2;
    }
    try {
      const raw = JSON.parse(readFileSync(mandatePath, 'utf8')) as unknown;
      const parsed = parseMandate(raw);
      if (!parsed.ok) {
        console.error(`invalid mandate: ${parsed.reason}`);
        return 2;
      }
      const bid = buildAgentBid(params, parsed.mandate);
      console.log(`agent bid for auction ${params.auction_id}`);
      console.log(`  per unit       ${bid.per_unit_zat} zat`);
      console.log(`  quantity       ${bid.quantity}`);
      console.log(`  amount         ${bid.amount_zat} zat`);
      console.log(`  memo           ${bid.memo_text}`);
      console.log(`  payment URI    ${bid.uri}`);
      for (const warning of bid.warnings) console.log(`  warning        ${warning}`);
      console.log('');
      console.log('the agent cannot see another bid; clearing stays off this machine');
      return 0;
    } catch (err) {
      console.error(`cannot build bid: ${(err as Error).message}`);
      return 2;
    }
  }

  if (sub === 'check') {
    const [dir, encoded] = rest;
    if (!dir || !encoded) usage();
    const settlement = readSettlement(dir);
    if (!settlement) {
      console.error(`cannot read ${join(dir, 'settlement.json')}`);
      return 2;
    }
    const result = checkAgentMemo(new Uint8Array(Buffer.from(encoded, 'base64')), settlement);
    if (result.ok) {
      console.log('AGENT: OK (inclusion proof, outcome, and price match)');
      return 0;
    }
    for (const problem of result.problems) console.log(`  problem: ${problem}`);
    console.log('AGENT: MISMATCH');
    return 1;
  }

  usage();
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case 'open':
      return runOpen(rest);
    case 'scan':
      return runScan(rest);
    case 'settle':
      return runSettle(rest);
    case 'verify':
      return runVerify(rest);
    case 'demo':
      return runDemo(rest);
    case 'uri':
      return runUri(rest);
    case 'proof':
      return runProof(rest);
    case 'bond':
      return runBond(rest);
    case 'quantum-report':
      return runQuantumReport(rest);
    case 'agent':
      return runAgent(rest);
    default:
      usage();
  }
}

main(process.argv.slice(2)).then((code) => process.exit(code), (err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(2);
});
