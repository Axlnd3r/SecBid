import type { NotePool, Pool, ReceivedNote, RefundTx } from './model.ts';
import type { ChainAdapter, PoolSupport, RefundOutput } from './adapter.ts';
import { isShieldedAddress, isUnifiedAddress, isUnifiedViewingKey } from './memo.ts';
import { sortLeavesOrder } from './merkle.ts';
import { zatToZec } from './zip321.ts';
import type { JsonRpcClient } from './rpc.ts';

/**
 * Live chain adapter, blueprint §13 day-1 gate.
 *
 * It talks to a Zallet wallet (the Zcash Foundation's replacement for the
 * zcashd wallet) over JSON-RPC. Every method used here is one Zallet documents
 * as implemented; `z_listreceivedbyaddress` is deliberately not used because
 * Zallet has not implemented it yet.
 *
 *   create account     z_getnewaccount + z_getaddressforaccount(["orchard"])
 *   rescan             z_listtransactions + getrawtransaction (for cm + vin)
 *   publish key        z_exportviewingkey
 *   refund batch       z_sendmany + z_getoperationstatus
 *   chain tip          getwalletstatus
 *
 * Two things the wallet cannot do, and this adapter therefore refuses to fake:
 *
 *  1. `z_sendmany` has no target-height parameter. A split refund batch is
 *     broadcast one chunk at a time, and the adapter reports the height each
 *     chunk actually reached. C8 then fails loudly if they differ, instead of
 *     the artifact pretending they landed together.
 *  2. The outgoing viewing key is not exposed by any RPC call. `open` still
 *     takes `--ovk` from the operator; the UFVK (which the wallet does export)
 *     is not parsed here, because extracting the Orchard OVK from it needs
 *     ZIP-316 F4Jumble decoding plus the Orchard key schedule, and a
 *     hand-rolled implementation that is never checked against a vector is
 *     worse than an explicit input.
 */

interface WalletTxOutput {
  pool: string;
  output_index: number;
  to_account?: string | null;
  to_address?: string | null;
  value: number;
  is_change: boolean;
  memo?: string | null;
}

interface WalletTx {
  account_uuid: string;
  mined_height: number | null;
  txid: string;
  expired_unmined?: boolean;
  outputs: WalletTxOutput[];
}

interface RawAction {
  cmx?: string;
}

interface RawTransaction {
  txid?: string;
  height?: number;
  vin?: Array<{ coinbase?: string; txid?: string }>;
  orchard?: { actions?: RawAction[] };
  ironwood?: { actions?: RawAction[] };
}

interface OperationStatus {
  id?: string;
  status?: string;
  result?: { txid?: string; txids?: string[]; broadcast?: boolean };
  error?: { code?: number; message?: string };
}

export interface ZalletAdapterConfig {
  rpc: JsonRpcClient;
  /** Zallet account UUID that holds the auction funds. */
  accountUuid: string;
  /** Shielded unified address of that account (the auction address). */
  address: string;
  /** Expected viewing key. If set, every scan proves the wallet agrees. */
  ufvk?: string;
  /** Poll interval while waiting for a refund to mine. */
  pollIntervalMs?: number;
  /** How long to wait for a refund transaction to be mined. */
  miningTimeoutMs?: number;
  /** Rows per `z_listtransactions` page. */
  pageSize?: number;
  /** Injected in tests so polling does not depend on wall-clock time. */
  sleep?: (ms: number) => Promise<void>;
}

export interface ZalletAccount {
  account_uuid: string;
  address: string;
  ufvk: string;
  /** Pool the receivers live in. Ironwood is refused until confirmed. */
  pool: Pool;
  /** Node tip at creation time, used as the auction's opening height. */
  height: number;
}

const DEFAULT_POLL_MS = 2_000;
const DEFAULT_MINING_TIMEOUT_MS = 15 * 60_000;
const HEX32 = /^[0-9a-f]{64}$/i;

function assertArray<T>(value: unknown, method: string): T[] {
  if (!Array.isArray(value)) throw new Error(`zallet: ${method} did not return an array`);
  return value as T[];
}

function assertSafeZat(value: unknown, label: string): bigint {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`zallet: ${label} is not a zatoshi amount`);
  }
  return BigInt(value);
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Wallet pool capability. Ironwood support is unconfirmed for the Zallet release
 * this adapter targets (OPEN-QUESTIONS.md). Reporting it as supported would
 * be a guess, and `--pool auto` would then record the wrong pool.
 */
export function zalletPoolSupport(pool: Pool): PoolSupport {
  if (pool === 'orchard') return { supported: true };
  return {
    supported: false,
    reason:
      'Ironwood account creation is not confirmed for this Zallet release ' +
      '(OPEN-QUESTIONS.md); staying in Orchard',
  };
}

/** Current node tip. An auction deadline is a height, so this is the clock. */
export async function tipHeight(rpc: JsonRpcClient): Promise<number> {
  const status = await rpc.call<{ node_tip?: { height?: unknown } }>('getwalletstatus');
  const height = status?.node_tip?.height;
  if (typeof height !== 'number' || !Number.isSafeInteger(height) || height < 0) {
    throw new Error('zallet: getwalletstatus did not report a node tip height');
  }
  return height;
}

/**
 * Create a fresh, Orchard-only account for one auction. Blueprint §14 #7:
 * one ephemeral account per auction, never reused, because publishing its
 * UFVK later reveals every note that account ever received.
 */
export async function createAuctionAccount(
  rpc: JsonRpcClient,
  name: string,
  pool: Pool = 'orchard',
): Promise<ZalletAccount> {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new Error('zallet: account name is required');
  }
  if (pool !== 'orchard') {
    // Do not guess the Ironwood RPC shape. OPEN-QUESTIONS.md asks Zallet for it.
    throw new Error(
      'zallet: creating an Ironwood account is not confirmed on this Zallet release; ' +
        'see OPEN-QUESTIONS.md. Use --pool orchard (or auto, which falls back).',
    );
  }
  const account = await rpc.call<{ account_uuid?: unknown }>('z_getnewaccount', [name]);
  const accountUuid = account?.account_uuid;
  if (typeof accountUuid !== 'string' || accountUuid === '') {
    throw new Error('zallet: z_getnewaccount did not return an account_uuid');
  }

  // Shielded receivers only: a UA with a transparent receiver would accept
  // t-address bids, and a transparent bid publishes its amount (E4 / L5).
  const derived = await rpc.call<{
    address?: unknown;
    receiver_types?: unknown;
  }>('z_getaddressforaccount', [accountUuid, ['orchard']]);
  const address = derived?.address;
  const receivers = derived?.receiver_types;
  if (typeof address !== 'string' || !isShieldedAddress(address)) {
    throw new Error('zallet: z_getaddressforaccount did not return a shielded address');
  }
  if (!Array.isArray(receivers) || !receivers.includes('orchard') || receivers.includes('p2pkh')) {
    throw new Error('zallet: auction address must be Orchard-only; refusing a transparent receiver');
  }

  const ufvk = await rpc.call<unknown>('z_exportviewingkey', [address]);
  if (!isUnifiedViewingKey(ufvk)) {
    throw new Error('zallet: z_exportviewingkey did not return a unified full viewing key');
  }

  return { account_uuid: accountUuid, address, ufvk, pool, height: await tipHeight(rpc) };
}

export class ZalletAdapter implements ChainAdapter {
  private readonly cfg: Required<Pick<ZalletAdapterConfig, 'pollIntervalMs' | 'miningTimeoutMs' | 'pageSize' | 'sleep'>> &
    ZalletAdapterConfig;
  private checkedUfvk: string | null = null;

  constructor(cfg: ZalletAdapterConfig) {
    if (!/^[0-9a-f-]{16,}$/i.test(cfg.accountUuid)) {
      throw new Error('zallet: accountUuid does not look like a UUID');
    }
    if (!isShieldedAddress(cfg.address)) {
      throw new Error('zallet: auction address must be shielded');
    }
    this.cfg = {
      ...cfg,
      pollIntervalMs: cfg.pollIntervalMs ?? DEFAULT_POLL_MS,
      miningTimeoutMs: cfg.miningTimeoutMs ?? DEFAULT_MINING_TIMEOUT_MS,
      pageSize: cfg.pageSize ?? 100,
      sleep: cfg.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    };
    if (!Number.isSafeInteger(this.cfg.pageSize) || this.cfg.pageSize < 1) {
      throw new Error('zallet: pageSize must be a positive integer');
    }
  }

  supportsPool(pool: Pool): PoolSupport {
    return zalletPoolSupport(pool);
  }

  /**
   * Prove once that the wallet's key for this address is the key the auction
   * published. Without this, a settlement could name a UFVK that the wallet
   * never held and no verifier would notice from the scan alone.
   */
  private async expectedUfvk(requested?: string): Promise<string> {
    const candidates = [this.cfg.ufvk, requested].filter((k): k is string => typeof k === 'string' && k !== '');
    if (candidates.length === 0) return '';
    if (new Set(candidates).size > 1) {
      throw new Error('zallet: scan was asked for a UFVK that is not the account viewing key');
    }
    if (this.checkedUfvk === null) {
      const actual = await this.cfg.rpc.call<unknown>('z_exportviewingkey', [this.cfg.address]);
      if (typeof actual !== 'string') {
        throw new Error('zallet: z_exportviewingkey did not return a string');
      }
      if (actual !== candidates[0]) {
        throw new Error('zallet: wallet viewing key does not match the published UFVK');
      }
      this.checkedUfvk = actual;
    }
    return this.checkedUfvk;
  }

  /** Every mined note received by the auction account at or above `fromHeight`. */
  async scan(ufvk?: string, fromHeight = 0): Promise<ReceivedNote[]> {
    if (!Number.isSafeInteger(fromHeight) || fromHeight < 0) {
      throw new Error(`zallet: fromHeight must be a block height: ${fromHeight}`);
    }
    await this.expectedUfvk(ufvk);

    const rows: Array<{ tx: WalletTx; output: WalletTxOutput }> = [];
    let offset = 0;
    for (let page = 0; page < 10_000; page++) {
      const batch = assertArray<WalletTx>(
        await this.cfg.rpc.call<unknown>('z_listtransactions', [
          this.cfg.accountUuid,
          fromHeight,
          null,
          offset,
          this.cfg.pageSize,
        ]),
        'z_listtransactions',
      );

      for (const tx of batch) {
        if (typeof tx?.txid !== 'string' || !HEX32.test(tx.txid)) {
          throw new Error('zallet: z_listtransactions returned a transaction without a valid txid');
        }
        const outputs = assertArray<WalletTxOutput>(tx.outputs, 'z_listtransactions.outputs');
        for (const output of outputs) {
          if (output.to_account !== this.cfg.accountUuid) continue;
          if (output.pool !== 'orchard' && output.pool !== 'ironwood') continue;
          // Change, shielding, and internal transfers are not bids: nobody sent
          // them to the auction address.
          if (output.is_change || typeof output.to_address !== 'string') continue;
          rows.push({ tx, output });
        }
      }

      if (batch.length < this.cfg.pageSize) break;
      offset += batch.length;
      if (page === 9_999) throw new Error('zallet: z_listtransactions did not finish paging');
    }

    const txids = Array.from(new Set(rows.map((r) => r.tx.txid)));
    const rawByTxid = new Map<string, RawTransaction>();
    const raw = await mapLimit(txids, 4, async (txid) => {
      const result = await this.cfg.rpc.call<unknown>('getrawtransaction', [txid, 1]);
      if (typeof result !== 'object' || result === null) {
        throw new Error(`zallet: getrawtransaction returned no verbose transaction for ${txid}`);
      }
      return [txid, result as RawTransaction] as const;
    });
    for (const [txid, tx] of raw) rawByTxid.set(txid, tx);

    const notes: ReceivedNote[] = rows.map(({ tx, output }) => {
      const minedHeight = tx.mined_height;
      if (typeof minedHeight !== 'number' || !Number.isSafeInteger(minedHeight) || minedHeight < 0) {
        throw new Error(`zallet: transaction ${tx.txid} has no mined height`);
      }
      const index = output.output_index;
      if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0) {
        throw new Error(`zallet: transaction ${tx.txid} has no output index`);
      }

      const detail = rawByTxid.get(tx.txid);
      const bundle = output.pool === 'ironwood' ? detail?.ironwood : detail?.orchard;
      const action = bundle?.actions?.[index];
      const cm = action?.cmx;
      if (typeof cm !== 'string' || !HEX32.test(cm)) {
        throw new Error(
          `zallet: no Orchard note commitment at action ${index} of ${tx.txid}; ` +
            'the node must return getrawtransaction with orchard.actions[].cmx',
        );
      }

      // Fail closed on a missing vin: a wrong `transparent_funded` would admit
      // a bid whose amount is public, which is the one leak E4 exists to stop.
      const vin = detail?.vin;
      const transparentFunded = Array.isArray(vin)
        ? vin.some((input) => typeof input.coinbase !== 'string')
        : true;

      const memo = output.memo;
      return {
        txid: tx.txid,
        height: minedHeight,
        action_index: index,
        value_zat: assertSafeZat(output.value, `value of ${tx.txid}`),
        cm: cm.toLowerCase(),
        memo_raw: typeof memo === 'string' ? memo : null,
        transparent_funded: transparentFunded,
        pool: output.pool as NotePool,
      };
    });

    const ordered = sortLeavesOrder(notes);
    const seen = new Set<string>();
    for (const note of ordered) {
      const key = `${note.txid}:${note.action_index}`;
      if (seen.has(key)) throw new Error(`zallet: duplicate note ${key} in the account scan`);
      seen.add(key);
    }
    return ordered;
  }

  /**
   * Broadcast one shielded transaction. The refund plan is split by the caller,
   * so one call must produce exactly one transaction; if Zallet splits it
   * internally the caller cannot assign leaves to txids and settlement would
   * have to guess. Refuse instead.
   */
  async sendRefunds(outputs: RefundOutput[], targetHeight?: number): Promise<RefundTx> {
    if (outputs.length === 0) throw new Error('refund batch is empty');
    for (const [i, output] of outputs.entries()) {
      if (!isShieldedAddress(output.address)) {
        throw new Error(`refund output ${i} goes to a non-shielded address`);
      }
      if (typeof output.value_zat !== 'bigint' || output.value_zat <= 0n) {
        throw new Error(`refund output ${i} has an invalid value`);
      }
      if (output.memo && output.memo.length > 512) {
        throw new Error(`refund output ${i} memo exceeds 512 bytes`);
      }
    }

    // A Sapling refund address makes this a cross-pool transfer, whose net
    // amount is public. Ask for exactly that instead of silently relaxing the
    // policy for every batch.
    const shieldedOnly = outputs.every((o) => isUnifiedAddress(o.address));
    // Zallet accepts the amount as a string and parses it as a fixed-point
    // decimal. A JSON number would serialise 1 zat as `1e-8`, which is not the
    // decimal form the parser expects.
    const amounts = outputs.map((output) => ({
      address: output.address,
      amount: zatToZec(output.value_zat),
      ...(output.memo ? { memo: Buffer.from(output.memo).toString('hex') } : {}),
    }));

    const opid = await this.cfg.rpc.call<unknown>('z_sendmany', [
      this.cfg.address,
      amounts,
      1,
      null,
      shieldedOnly ? 'FullPrivacy' : 'AllowRevealedAmounts',
    ]);
    if (typeof opid !== 'string' || opid === '') {
      throw new Error('zallet: z_sendmany did not return an operation id');
    }

    const result = await this.waitForOperation(opid);
    if (result.broadcast === false) {
      throw new Error(
        'zallet: the wallet built the refund transaction but did not broadcast it ' +
          '(external.broadcast is disabled)',
      );
    }
    const txids = result.txids ?? (result.txid ? [result.txid] : []);
    if (txids.length !== 1) {
      throw new Error(
        `zallet: one refund chunk produced ${txids.length} transactions; ` +
          'lower --max-outputs so each chunk fits in one transaction',
      );
    }
    const txid = txids[0];
    if (!HEX32.test(txid)) throw new Error('zallet: z_sendmany returned an invalid txid');

    // Zallet has no "mine at this height" parameter. Report where it landed.
    void targetHeight;
    const height = await this.waitForMined(txid);
    return { txid, height };
  }

  private async waitForOperation(opid: string): Promise<NonNullable<OperationStatus['result']>> {
    const deadline = Date.now() + this.cfg.miningTimeoutMs;
    for (;;) {
      const raw = await this.cfg.rpc.call<unknown>('z_getoperationstatus', [[opid]]);
      const list = Array.isArray(raw) ? raw : [raw];
      const status = list.find((s): s is OperationStatus => typeof s === 'object' && s !== null);
      if (!status) throw new Error(`zallet: operation ${opid} disappeared from the wallet`);

      if (status.status === 'success') {
        if (!status.result) throw new Error(`zallet: operation ${opid} succeeded without a result`);
        return status.result;
      }
      if (status.status === 'failed' || status.status === 'cancelled') {
        const why = status.error?.message ?? status.status;
        throw new Error(`zallet: refund operation ${opid} ${status.status}: ${why}`);
      }
      if (Date.now() > deadline) {
        throw new Error(`zallet: refund operation ${opid} did not finish in time`);
      }
      await this.cfg.sleep(this.cfg.pollIntervalMs);
    }
  }

  private async waitForMined(txid: string): Promise<number> {
    const deadline = Date.now() + this.cfg.miningTimeoutMs;
    for (;;) {
      const tx = await this.cfg.rpc.call<unknown>('getrawtransaction', [txid, 1]);
      if (typeof tx === 'object' && tx !== null) {
        const height = (tx as RawTransaction).height;
        if (typeof height === 'number' && Number.isSafeInteger(height) && height > 0) return height;
      }
      if (Date.now() > deadline) {
        throw new Error(`zallet: refund transaction ${txid} was not mined in time`);
      }
      await this.cfg.sleep(this.cfg.pollIntervalMs);
    }
  }
}
