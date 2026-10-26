# The chain adapter

`src/zallet.ts` is the only code in Secbid that talks to a real wallet. It
implements the `ChainAdapter` port from `src/adapter.ts` over Zallet's JSON-RPC,
so `clearing`, `settlement`, and `verify` do not know whether the notes came
from a fixture or from testnet.

Status: **implemented and tested against a fake Zallet; not yet run against a
real node.** The fake replays the response shapes from Zallet's Rust structs
(`z_listtransactions`, `getrawtransaction`, `z_sendmany`), not zcashd's docs.
The remaining Day-1 work is a testnet run, listed at the end.

## Why Zallet

`zcashd` reached end-of-support at height 3,417,100 on 18 July 2026 and halts by
design. Zallet is the wallet replacement in the Zebra stack. It exposes a subset
of zcashd's JSON-RPC, with documented semantic changes, and it has not
implemented the method this design would otherwise use:

| Need | Zallet method | Note |
|---|---|---|
| create an ephemeral account | `z_getnewaccount` | requires `account_name`; returns `account_uuid` |
| derive the auction address | `z_getaddressforaccount` | called with `["orchard"]`, so no transparent receiver exists |
| publish the viewing key | `z_exportviewingkey` | returns the `uview1…` UFVK |
| chain tip / opening height | `getwalletstatus` | `node_tip.height` |
| list received notes and memos | `z_listtransactions` | account-scoped, includes spent notes and `mined_height` |
| leaf commitment and funding check | `getrawtransaction` | `orchard.actions[].cmx`, `vin[]`, `height` |
| refund batch | `z_sendmany` | async opid; result carries `txids` and `broadcast` |
| operation result | `z_getoperationstatus` | poll until `success` / `failed` |

`z_listreceivedbyaddress` — the obvious method for a scanner — is **not yet
implemented** in Zallet. `z_listunspent` is implemented but only returns unspent
notes, so it cannot reconstruct an auction after the winner's note has been
swept. `z_listtransactions` is the only account-scoped listing that survives
spending, which is why it is the scan source.

## Why `getrawtransaction` is required

The leaf is `SHA256("secbid:leaf:v1" || txid || cm)`. Zallet's transaction
listing gives the txid, value, memo, WALLET height, and output index, but not the
note commitment. The commitment is the Orchard action's `cmx` (the extracted
note commitment, 32 bytes) in the verbose raw transaction. The adapter therefore
fetches each unique transaction once and reads `orchard.actions[index].cmx` (or
`ironwood.actions` for that pool).

If a node ever stops returning `cmx`, the adapter fails with a message naming
the txid. It does not substitute a hash of the txid, a position, or a memo: a
leaf that is not the on-chain commitment would let a settlement commit to a
different tree than the chain.

The `transparent_funded` flag comes from `vin`: any input without `coinbase` is
a transparent input (blueprint E4). A missing `vin` is treated as funded, which
fails closed — it rejects a bid rather than admitting one whose amount is
public.

## Limits the adapter refuses to hide

### 1. No target height

`z_sendmany` has no "mine at this height" parameter. `broadcastRefunds` pins
each chunk to the first chunk's height, but the wallet cannot honour it. The
adapter reports the height each refund transaction actually reached, and C8
fails if a split batch spans more than one height. That is the correct outcome:
scattered refund blocks restore timing correlation.

### 2. No OVK RPC

The blueprint commits to the auction's outgoing viewing key at open. Zallet
exports the UFVK, not the OVK. Extracting the Orchard OVK from a UFVK requires
ZIP-316 F4Jumble decoding, bech32m, and the Orchard key schedule; a hand-rolled
implementation that is never checked against a published vector is worse than an
explicit input. `open` therefore still requires `--ovk <64 hex>`.

### 3. No UFVK import, so no third-party rescan on Zallet yet

`z_importviewingkey` accepts Sapling extended viewing keys only. There is no
`z_importunifiedviewingkey`. A verifier who holds nothing but the published
UFVK cannot create a watch-only Zallet account to rescan. Today, public-mode
verification uses the auctioneer's own wallet; the trust boundary is documented
rather than papered over. A lightwalletd/Zaino scanner that accepts a UFVK is the
honest path to independent rescanning.

### 4. C5 is tautological in the live settle path

`settle --rpc` scans and settles from the same note list, so
`chain_note_count == entries.length` by construction. C5 still catches a
settlement edited after the scan, but not a scan that dropped a note before
settling. To make completeness independent, run `scan` first, publish
`scan.json`, and settle against that published count. The command exists for
exactly this reason.

### 5. One transaction per chunk

If Zallet returns more than one txid for a single `z_sendmany`, the adapter
refuses the batch: the caller cannot assign leaves to transactions, and a
settlement must never guess which transaction paid whom. Lower `--max-outputs`
and re-run. Zallet also rejects duplicate recipients, so two bids that reuse a
refund address are split across transactions by `chunkRefundPlan`; C8 requires
one output per entry anyway.

### 6. Unmined notes fail the scan

`z_listtransactions` includes mempool transactions with `mined_height: null`.
A note has no inclusion height until it is mined, and the deadline is defined by
height, so the adapter refuses the scan instead of inventing a height. Wait for
`settle_depth` and scan again.

## Running it

Zallet's RPC uses cookie authentication by default. Either point at the cookie
file or add a password user and pass the password through the environment —
never through argv, where it is visible to every process on the machine.

```bash
# terminal 1: a synced Zallet
zallet start

# terminal 2: a password user (prompts for the password)
zallet add-rpc-user --user secbid
export SECBID_RPC_PASSWORD='…'

# create the auction account and the committed params in one step
node src/cli.ts open --rpc http://127.0.0.1:8232 --rpc-user secbid \
  --name auction-2026-10 --ovk <64 hex> \
  --reserve 5 --deadline 3120000 --out my-auction

# list what the wallet can see (writes scan.json)
node src/cli.ts scan my-auction --rpc http://127.0.0.1:8232 --rpc-user secbid --ovk <64 hex>

# live settlement: scan, clear, broadcast refunds, verify the artifacts
node src/cli.ts settle my-auction --rpc http://127.0.0.1:8232 --rpc-user secbid \
  --ovk <64 hex> --max-outputs 40

# the verifier still replays the written artifacts with no wallet at all
node src/cli.ts verify my-auction
```

Cookie auth instead of a password user:

```bash
node src/cli.ts scan my-auction --rpc http://127.0.0.1:8232 \
  --cookie-file /path/to/zallet/datadir/.cookie
```

`open --rpc` writes `account.json` (`account_uuid`, `address`, `ufvk`, opening
height) beside `auction.json`. `scan` and `settle` refuse to run if that address
does not match the auction params, which is the guard against settling the wrong
auction account.

## Operational safety

- The RPC endpoint should be loopback or a private network. There is no TLS
  assumption in the client; `https:` is supported but not required.
- The password comes from `SECBID_RPC_PASSWORD`; `--rpc-user` fails without it.
  The cookie file is re-read on every call because Zallet rotates it on restart.
- Error messages name the method, HTTP status, or JSON-RPC code. They never
  include params, memos, addresses, or the password.
- One account per auction, created by `open --rpc`, never reused. Publishing its
  UFVK later reveals every note that account ever received (threat model L8).
- The adapter never logs a note, memo, or amount. The only output `scan` prints
  is counts by outcome.

## Test coverage

`tests/zallet.test.ts` drives a fake Zallet and asserts:

- `z_listtransactions` → `ReceivedNote` mapping: height, action index, `cmx`,
  memo, transparent flag; Sapling notes and change outputs are ignored.
- Pagination (`pageSize: 1`), and one UFVK check per adapter rather than per page.
- A wallet key that does not match the published UFVK is refused.
- A missing `cmx` is an error, not an invented leaf.
- A UA with a transparent receiver is refused at account creation.
- `sendRefunds` sends decimal-string amounts and hex memos, waits for the
  transaction to mine, and returns the height the chain reported.
- A Sapling refund switches the privacy policy to `AllowRevealedAmounts`
  instead of silently weakening every batch.
- `broadcast: false` and a wallet-internal split into two transactions are
  errors.
- Cookie auth, 401 handling, JSON-RPC error codes, and non-http URLs.
- The whole live path through the CLI: `open --rpc` → `scan` → `settle --rpc`
  → `verify` PASS 14/14, with three refunds split across three transactions at
  one height.

## What the testnet run still has to prove

1. Zallet returns `orchard.actions[].cmx` for a real received note, and
   `z_listtransactions` reports the same `output_index` / `action` pairing.
2. A ZIP-321 bid memo survives Zashi, YWallet, and Zingo!, and comes back from
   `z_listtransactions` as text rather than as raw hex.
3. `z_sendmany` accepts the output count and the measured ZIP-225 limit; replace
   `DEFAULT_MAX_OUTPUTS_PER_TX` with the measured number once it is known.
4. Zallet's `settle_depth` confirmation policy (`minconf: 1` here) is sufficient
   for a single refund batch, and the batch lands at one height in practice.
5. `z_exportviewingkey` can be called while the wallet is locked; if not, `scan`
   needs an explicit unlock step rather than a silent retry.
