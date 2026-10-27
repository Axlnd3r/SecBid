# Testnet run log

**Status: not run.** There is no live testnet auction yet and no txid is published in this
repository. Everything described as "live" in `CLAUDE.md`, `README.md` and the tests is
**tested against fake Zallet** (`tests/helpers/fake-zallet.ts`), which reproduces the JSON-RPC
shapes in `docs/ADAPTER.md`.

This file exists so the gap is visible instead of being implied by the demo output. When a run
happens, append a section with the exact chain-visible facts and keep the failure log, not just
the happy path.

Node and wallet setup (Zebra + Zallet on WSL2, Secbid on Windows): [`TESTNET-SETUP.md`](TESTNET-SETUP.md).

## Checklist for the first run

Do these in order and record the command, height and txid for each:

1. **Wallet setup.** Zallet on `testnet`, account `secbid-a1`, spend authority held by that node.
   Record `Zallet` version, `getwalletinfo` output (redact paths), and the account UUID.
2. **Pool.** Try `open --pool auto` and record which pool the adapter reported. If Ironwood is
   unavailable, record the warning text and the Orchard fallback — do not edit the artifact by
   hand. See [`OPEN-QUESTIONS.md`](../OPEN-QUESTIONS.md) Q1.
3. **Open.** Funding txid, funding height, `auction_id`, the published 43-byte UFVK, the bid
   `zcash:` URI, and the verifier output for the freshly opened directory (`verify` will be
   PARTIAL until settlement exists).
4. **Bids.** At least three funded bids, including one exactly at the reserve, one below it, one
   after the deadline, and one sent from a transparent address (to show it is not counted).
   Record each txid and the bidder's local proof check, not the plaintext amount.
5. **Settle.** Run `settle` with `--ovk`, then `verify`. Both must be PASS 14/14. Record
   `settlement_hash`, `merkle_root`, clearing price and the refund batch txids.
6. **Independent check.** From a different machine, `verify` the directory (it only needs the
   artifact files) and run `bond show` against the recorded bond txid. Record both transcripts.
7. **Web page.** Serve `npm run web`, point it at the published directory, and record the
   whitelisted fields the page receives (`curl /api/auction | python -m json.tool`), confirming no
   bid amount, no note commitment and no address appears.

## Setup log (G1, in progress)

2026-10-27, WSL2 Ubuntu 24.04 on Windows 11, Secbid on Windows (Node 24.19.0).

- **Zebra** `zebrad` 7.0.0 (release binary, checksum verified), Testnet, state format v29. Still
  syncing from genesis: height 286,829 at 02:25 UTC.
- **Zallet** built from unmerged PR [zcash/zallet#898](https://github.com/zcash/zallet/pull/898)
  at commit `8c5a93ba9d68ad78d199c3624413c0139781b837` (`cargo build --release --locked`, Rust
  1.95.0). It reports itself as `0.1.0-beta.3` because the PR does not bump the version; the
  released `v0.1.0-beta.3` binary refuses Zebra 7's v29 state. **This is an unreleased wallet
  build** and any result below must say so.
- Zallet starts on the `zebra` backend, reads the v29 state, and scans behind Zebra
  (wallet tip 282,681 / node tip 286,829 at 02:25 UTC).
- From Windows, through `src/rpc.ts` with user `secbid` and `SECBID_RPC_PASSWORD`:
  `getwalletstatus` answers; `z_listaccounts` returns `[]` (no account created yet); a wrong
  password gets `401` and the error does not echo it.
- `getwalletstatus` reports `"locked": true`. In this build that means *not synced*, not
  *passphrase needed*: `get_wallet_status.rs` sets `locked = !Synced`, and balance/spend methods
  error while it holds. The encryption identity is a plain age file, so `walletpassphrase` does
  not apply. `open --rpc` and `settle --rpc` therefore wait for the wallet to reach the tip.
- Measured scan rates (02:25 UTC, both catching up at once): Zebra ≈ 8,000 blocks/min, Zallet
  ≈ 1,500 blocks/min. Re-measure once Zebra reaches the tip; Zallet's rate sets when a run can start.

No account, no auction, no txid yet.

## Wording for the submission

Until the checklist is complete, say:

> Settlement, refunds and proof memos are implemented and tested against fake Zallet. The
> testnet run is pending; no txids are claimed.

After it is complete, link the txids and say "run on Zcash testnet on <date>". Never describe a
fake-Zallet run as a testnet run.
