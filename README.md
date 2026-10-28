# Secbid

**Auditable sealed-bid auctions on Zcash. The bid is a shielded payment.**

Price is public. Bidders are not. And an auctioneer who cheats gets caught — from chain data alone.

> **Status.** Spec v2 runs end to end against a fake Zallet that reproduces its JSON-RPC response
> structs: open, bid URI, uniform/first-price settle, batched refunds, inclusion-proof memos, bond
> recheck, private-mode auditor transcript, 14 verifier checks, quantum report, bidder agent, public
> auction page. `npm test` is green. **Run on Zcash testnet on 2026-10-28:** a uniform 3-unit
> auction in the Ironwood pool, 6 bids (incl. dust and late), one refund transaction, `verify` PASS
> 14/14 — artifacts in `fixtures/testnet-01/`, txids in [`docs/TESTNET.md`](docs/TESTNET.md). Bond,
> private mode and multi-transaction refunds are still *tested against fake Zallet*.
> Spec: [`BLUEPRINT.md`](BLUEPRINT.md) (v2; v1 design in [`docs/BLUEPRINT.md`](docs/BLUEPRINT.md))
> · Risks: [`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md)
> · Wallet limits: [`docs/ADAPTER.md`](docs/ADAPTER.md) · Agent instructions: [`CLAUDE.md`](CLAUDE.md)

---

## The problem

OTC block sales, procurement tenders, token sales, grant allocation: every sealed-bid process depends
on one promise — **your competitors must not see your number.** Today an intermediary enforces it.
On a transparent chain it cannot be enforced at all. And the private auctions that do exist ask you to
trust the operator's infrastructure: an FHE coprocessor, a TEE, or a server you cannot replay.

## What Secbid does differently

| | Typical private auction | Secbid |
|---|---|---|
| How you bid | Special app, wrapped token, or contract call + reveal | **One shielded payment from any ZIP-321 wallet** (Zashi, YWallet, Zingo!) |
| Contracts / bridges | Yes | **None** — Zcash protocol + a scanner |
| Can the operator lie about the result? | You trust them | **Anyone can recompute it**; a lie fails a named check |
| Did my bid count? | You trust them | **Inclusion proof in your refund memo** |
| Operator runs off with funds? | Contract escrow, or nothing | **Pre-committed bond + OVK audit** (detected, and costly) |
| Future quantum adversary | Rarely considered | **Quantum posture**: recoverable pool when available, one-time refund keys, exposure report |

## How it works

1. **Open.** Seller creates a fresh shielded account, commits to params (reserve, deadline height,
   clearing rule, lot size) and an OVK commitment *before any bid*, and publishes a ZIP-321 QR.
   Optionally posts a **bond** to a committed address.
2. **Bid.** Bidder scans the QR and pays. The memo carries a **one-time refund address**.
   No account, no login. On chain: a shielded transaction happened. Nothing else.
3. **Settle.** After the deadline + confirmations the auctioneer scans with the viewing key and runs
   the deterministic clearing rule — **first-price** (single lot) or **uniform-price** (N units,
   every winner pays the same clearing price).
4. **Refund.** Losers and winners' excess are refunded in batched shielded transactions; each memo
   holds an inclusion proof for that bidder's leaf.
5. **Prove.** Public-tender mode: the auction UFVK is published and anyone can replay the auction
   (`secbid verify` → `PASS`/`FAIL`). Private mode: the UFVK stays sealed; bidders verify their own
   proof and an auditor verifies outgoing flows via the pre-committed OVK.

## What is private, what is public

| | Bidder | Auctioneer | Public (public-tender mode, after reveal) | Public (private mode) |
|---|---|---|---|---|
| Bid amounts | own | all | **yes, unlinked to identity** | no |
| Bidder identity | own | no | no | no |
| Number of bids | — | yes | yes | approximate |
| Clearing price | yes | yes | yes | yes |
| Refund correctness | own | yes | yes | via auditor |
| Bid set completeness | own | yes | yes | via auditor + bond |

Be precise in the pitch: in public-tender mode **amounts become public after settlement**; identities
never do. Choose private mode when losing amounts must stay sealed.

## Trust model

Secbid is **not trustless**; nothing on Zcash L1 today can be. Custody is held by the auctioneer.
What Secbid guarantees is that misbehaviour is **detectable** and, with a bond, **costly**:
omitted bids, wrong prices, missing refunds and truncated bid sets each fail a different verifier
check. Delivery of the lot is out of scope. Full list: [`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md).

## Quantum posture

Zcash is migrating shielded funds to a quantum-**recoverable** pool (ZIP 2005). Secbid:

- opens the auction account in the recoverable pool when the connected wallet supports it
  (`--pool auto|ironwood|orchard`), and records which pool was used in the artifacts. Zallet's
  Ironwood account RPC is not confirmed yet, so the adapter refuses to guess and `auto` falls back
  to Orchard with a warning recorded in `auction.json` (see [`OPEN-QUESTIONS.md`](OPEN-QUESTIONS.md));
- requires a **one-time refund address** per bid, so publishing the UFVK cannot be used later to
  link a bidder's wider history;
- ships `secbid quantum-report`, which lists what in an auction is exposed to a future
  discrete-log-breaking adversary (published addresses, revealed keys, pool of each note, and
  refund-address reuse by fingerprint rather than by address).

This makes no claim that Zcash or Secbid is post-quantum today.

## Why not an AI auctioneer

Clearing must be replayable forever; bids must not transit a third-party API; memos are
attacker-controlled input; keys need an accountable owner. AI belongs on the **bidder's** side —
`secbid agent bid` holds a strict mandate (max price, quantity, fresh refund address), builds the
payment request, and `secbid agent check` verifies the inclusion proof afterwards. It cannot see
anyone else's bid and has no network access.

## Quickstart

Node 24, no dependencies.

```bash
npm test                                   # fixtures + full suite
npm run web                                # http://127.0.0.1:4190
node src/cli.ts demo --out demo-out        # end-to-end, prints RESULT: PASS (14/14 checks)
node src/cli.ts verify fixtures/tamper/t2-truncate      # FAIL C5 (exit 1)
node src/cli.ts verify fixtures/auction-02              # uniform + bond, PASS 14/14

# uniform-price, 3 units, then the exposure report for that run
node src/cli.ts demo --out demo-u --rule uniform --units 3
node src/cli.ts quantum-report demo-u

# private mode: the auctioneer sees PASS; a public verify is PARTIAL; an auditor can C14.
# The demo replays the fixture key, which is not a real secret; on a live auction keep the OVK
# out of argv by setting SECBID_OVK instead of passing --ovk.
node src/cli.ts demo --out demo-p --mode private
node src/cli.ts verify demo-p --auditor --ovk "$(node -p "require('./demo-p/scan.json').ovk")"

# bidder-side agent: no network, no model in the clearing path.
# A mandate is strict; unknown keys are rejected.
cat > mandate.json <<'EOF'
{"v":1,"max_price_zat":"200000000","quantity":"2",
 "refund_address":"u1agentrefundaddress000000000000000000000000",
 "bid_price_zat":"150000000"}
EOF
node src/cli.ts agent bid fixtures/auction-02 --mandate mandate.json

# live path (testnet): open/scan/settle ran on testnet (docs/TESTNET.md); bond is tested against fake Zallet
export SECBID_RPC_PASSWORD='…'
node src/cli.ts open   --rpc http://127.0.0.1:8232 --rpc-user secbid --name a1 \
  --pool auto --rule uniform --units 3 --reserve 0.1 --deadline <height> \
  --ovk <64 hex> --bond-address <u1…> --bond 1 --out a1
node src/cli.ts bond   record a1 --txid <bond txid> --height <funding height>
node src/cli.ts scan   a1 --rpc http://127.0.0.1:8232 --rpc-user secbid --ovk <64 hex>
node src/cli.ts settle a1 --rpc http://127.0.0.1:8232 --rpc-user secbid --ovk <64 hex>
node src/cli.ts verify a1
```

## Use case: OTC block of ZEC

A holder wants to sell 500 ZEC without moving the market or revealing counterparties. They open a
3-unit uniform-price Secbid with a reserve, post a bond, and share the QR with desks. Desks bid from
their own shielded wallets. Everyone pays one clearing price; losers are refunded; the published
artifacts prove nobody was skipped.

## Repository layout

```
BLUEPRINT.md            v2 spec: artifacts, clearing, checks C1–C14, task list
CLAUDE.md               rules for coding agents
docs/BLUEPRINT.md       v1 design record + v2 implementation map
docs/THREAT-MODEL.md    adversaries, leaks, residual risks
docs/ADAPTER.md         Zallet JSON-RPC surface and limits
docs/TESTNET.md         testnet run log: versions, txids, what was not covered
CHANGELOG.md            what changed, phase by phase
src/  scripts/  tests/  fixtures/  web/
```

## License

MIT
