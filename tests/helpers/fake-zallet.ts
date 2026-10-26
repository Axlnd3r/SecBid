import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';

/**
 * A fake Zallet, shaped from the Rust response structs rather than from
 * zcashd's docs:
 *
 *   z_listtransactions   WalletTx { mined_height, txid, outputs[...] }
 *   getrawtransaction    { height, vin, orchard: { actions: [{ cmx }] } }
 *   z_sendmany           opid, then z_getoperationstatus -> { txids, broadcast }
 *
 * It exists so the adapter's mapping can be tested without a node. It is not a
 * Zcash implementation and makes no attempt to be one.
 */

export interface FakeNote {
  txid: string;
  height: number;
  actionIndex: number;
  valueZat: number;
  memo: string | null;
  transparentFunded?: boolean;
  pool?: 'orchard' | 'sapling';
}

export interface FakeZalletOptions {
  notes: FakeNote[];
  accountUuid?: string;
  address?: string;
  ufvk?: string;
  tip?: number;
  auth?: { user: string; password: string };
  /** Reported instead of `ufvk`, to test the key-mismatch guard. */
  reportedUfvk?: string;
  /** Receiver types reported for the new address. Default `["orchard"]`. */
  receiverTypes?: string[];
  /** Transactions whose Orchard actions omit `cmx`. */
  missingCmFor?: string[];
  /** Add a change output to every transaction, which a scan must ignore. */
  includeChange?: boolean;
  /** Refund operation succeeds but never reaches the network. */
  broadcastRefunds?: boolean;
  /** One call returns two txids, which the adapter must refuse. */
  splitRefundResult?: boolean;
  /** Refund operation fails with this message. */
  failRefunds?: string;
  /** `getrawtransaction` calls that see the refund as unmined before it appears. */
  refundMempoolPolls?: number;
  /** Height at which the fake mines refunds. Default `tip + 1`. */
  refundHeight?: number;
}

export interface FakeZallet {
  url: string;
  /** Move the fake node tip (the clock the auction uses). */
  setTip: (height: number) => void;
  state: {
    calls: Array<{ method: string; params: unknown[]; authorization?: string }>;
    refunds: Array<{
      txid: string;
      height: number;
      amounts: Array<{ address: string; amount: string | number; memo?: string }>;
    }>;
    createdAccounts: string[];
  };
  close: () => Promise<void>;
}

export function fakeCm(txid: string, index: number): string {
  return createHash('sha256').update(`cm:${txid}:${index}`).digest('hex');
}

export function fakeTxid(label: string): string {
  return createHash('sha256').update(label).digest('hex');
}

function send(res: ServerResponse, status: number, body: unknown) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

export async function startFakeZallet(opts: FakeZalletOptions): Promise<FakeZallet> {
  const accountUuid = opts.accountUuid ?? '11111111-1111-4111-8111-111111111111';
  const address = opts.address ?? 'u1fakeauctionaddress000000000000000000000000000000000000000000';
  const ufvk = opts.ufvk ?? 'uview1fakeauctionviewingkey00000000000000000000000000000000000000';
  let tip = opts.tip ?? 3_119_000;
  const state: FakeZallet['state'] = { calls: [], refunds: [], createdAccounts: [] };

  const refunds = new Map<string, { txid: string; height: number; amounts: unknown[]; minedPolls: number }>();
  let nextOp = 1;

  function txRows() {
    const byTx = new Map<string, FakeNote[]>();
    for (const note of opts.notes) {
      const list = byTx.get(note.txid) ?? [];
      list.push(note);
      byTx.set(note.txid, list);
    }
    type RowOutput = {
      pool: string;
      output_index: number;
      to_account: string;
      to_address: string | null;
      value: number;
      is_change: boolean;
      memo: string | null;
    };
    return Array.from(byTx.entries()).map(([txid, list]) => {
      const maxIndex = Math.max(...list.map((n) => n.actionIndex));
      const outputs: RowOutput[] = list.map((n) => ({
        pool: n.pool ?? 'orchard',
        output_index: n.actionIndex,
        to_account: accountUuid,          to_address: address,
          value: n.valueZat,
          is_change: false,
          memo: n.memo,
        }));
      if (opts.includeChange) {
        outputs.push({
          pool: 'orchard',
          output_index: maxIndex + 1,
          to_account: accountUuid,
          to_address: null,
          value: 1,
          is_change: true,
          memo: null,
        });
      }
      return {
        account_uuid: accountUuid,
        mined_height: list[0].height,
        txid,
        outputs,
      };
    });
  }

  const server: Server = createServer(async (req, res) => {
    if (req.method !== 'POST') {
      send(res, 405, { error: 'POST only' });
      return;
    }
    const authorization = req.headers.authorization;
    if (opts.auth) {
      const expected = `Basic ${Buffer.from(`${opts.auth.user}:${opts.auth.password}`).toString('base64')}`;
      if (authorization !== expected) {
        send(res, 401, '');
        return;
      }
    }
    let body: { id?: unknown; method?: string; params?: unknown[] };
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
      return;
    }
    const method = body.method ?? '';
    const params = Array.isArray(body.params) ? body.params : [];
    const id = body.id ?? null;
    state.calls.push({ method, params, authorization });

    const reply = (result: unknown) => send(res, 200, { jsonrpc: '2.0', id, result });
    const fail = (code: number, message: string) =>
      send(res, 200, { jsonrpc: '2.0', id, error: { code, message } });

    switch (method) {
      case 'getwalletstatus':
        return reply({ node_tip: { blockhash: 'aa'.repeat(32), height: tip }, locked: false });

      case 'z_getnewaccount': {
        state.createdAccounts.push(String(params[0] ?? ''));
        return reply({ account_uuid: accountUuid });
      }

      case 'z_getaddressforaccount':
        return reply({
          account_uuid: accountUuid,
          diversifier_index: 0,
          receiver_types: opts.receiverTypes ?? ['orchard'],
          address,
        });

      case 'z_exportviewingkey':
        return reply(opts.reportedUfvk ?? ufvk);

      case 'z_listtransactions': {
        const start = typeof params[1] === 'number' ? params[1] : 0;
        const offset = typeof params[3] === 'number' ? params[3] : 0;
        const limit = typeof params[4] === 'number' ? params[4] : 100;
        const all = txRows().filter((tx) => (tx.mined_height ?? 0) >= start);
        return reply(all.slice(offset, offset + limit));
      }

      case 'getrawtransaction': {
        const txid = String(params[0] ?? '');
        const refund = refunds.get(txid);
        if (refund) {
          refund.minedPolls += 1;
          if (refund.minedPolls > (opts.refundMempoolPolls ?? 0)) {
            return reply({ txid, height: refund.height, vin: [], orchard: { actions: [] } });
          }
          return reply({ txid, vin: [], orchard: { actions: [] } });
        }

        const notes = opts.notes.filter((n) => n.txid === txid);
        if (notes.length === 0) return fail(-5, 'No such mempool or blockchain transaction');
        const maxIndex = Math.max(...notes.map((n) => n.actionIndex));
        const actions = Array.from({ length: maxIndex + 1 }, (_, index) => {
          if (opts.missingCmFor?.includes(txid)) return {};
          return { cmx: fakeCm(txid, index) };
        });
        const transparentFunded = notes.some((n) => n.transparentFunded);
        return reply({
          txid,
          height: notes[0].height,
          vin: transparentFunded ? [{ txid: 'ab'.repeat(32), vout: 0 }] : [],
          orchard: { actions },
        });
      }

      case 'z_sendmany': {
        const amounts = (params[1] ?? []) as Array<{ address: string; amount: string | number; memo?: string }>;
        const txid = fakeTxid(`refund:${nextOp}:${JSON.stringify(amounts)}`);
        const opid = `op-${nextOp++}`;
        const height = opts.refundHeight ?? tip + 1;
        refunds.set(txid, { txid, height, amounts, minedPolls: 0 });
        state.refunds.push({ txid, height, amounts });
        (state as unknown as { lastOp: string }).lastOp = opid;
        return reply(opid);
      }

      case 'z_getoperationstatus': {
        const ids = params[0];
        const opid = Array.isArray(ids) ? String(ids[0]) : 'op-1';
        if (opts.failRefunds) {
          return reply([{ id: opid, status: 'failed', error: { code: -1, message: opts.failRefunds } }]);
        }
        const refund = state.refunds[state.refunds.length - 1];
        if (!refund) return reply([{ id: opid, status: 'failed', error: { code: -1, message: 'no refund' } }]);
        const txids = opts.splitRefundResult
          ? [refund.txid, fakeTxid(`${refund.txid}:second`)]
          : [refund.txid];
        return reply([
          {
            id: opid,
            status: 'success',
            result: { txid: txids.length === 1 ? txids[0] : undefined, txids, broadcast: opts.broadcastRefunds ?? true },
          },
        ]);
      }

      default:
        return fail(-32601, `Method not found: ${method}`);
    }
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    setTip: (height: number) => {
      tip = height;
    },
    state,
    close: () =>
      new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}
