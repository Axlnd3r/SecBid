# Testnet run log

**Status: run on Zcash testnet on 2026-10-28.** Auction `c91d611828ac595f556528459b0e5869`
(`fixtures/testnet-01/`) verifies PASS 14/14 from chain data; txids are in
[Run 1](#run-1-2026-10-28) below. What that run did not exercise — bond, private mode, refunds
split across transactions, consumer wallet apps — is still **tested against fake Zallet**
(`tests/helpers/fake-zallet.ts`), which reproduces the JSON-RPC shapes in `docs/ADAPTER.md`.

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

## Run 1 (2026-10-28)

Versions: `zebrad 7.0.0+git.e8db87e`, Zallet PR #898 build `8c5a93b` (reports `0.1.0-beta.3`;
**unreleased wallet build**). Zebra synced to the tip (≈ 4,549,500) at 09:48 +07.

**Wallet.** The first wallet's account had an early birthday and would have needed ~10 h to scan.
A fresh wallet was created once Zebra reached the tip, so new accounts got a birthday at
≈ 4,549,498 and the wallet synced in ~5 min. All accounts below live in that one Zallet wallet.

**Funding.** 1 TAZ from the fauzec faucet to account `funder`, txid
`cb173e75c6b369af83f3fa79ebd4f9abf0b0ea25097f6acfabc102ddbba76936`, height 4,549,504. Split 0.15 TAZ
to each of five bidder accounts: `6bb1e965b871be85e883bef5b2e27bff0060a69926bbf92afac59a41d670313a`.

**Pool finding.** NU6.3 is active on testnet: the faucet payment to an Orchard receiver was
accounted to the **Ironwood** pool. With the old adapter (`--pool auto` → Orchard) C12 would have
failed. The adapter now opens Ironwood on `--network test` (CHANGELOG, OPEN-QUESTIONS Q1).

**Open.** `open --rpc … --network test --pool auto --rule uniform --units 3 --reserve 0.1
--min-bid 0.05 --deadline 4549558` at tip 4,549,544 → pool `ironwood`, account
`8041a974-1f82-4a19-a7c6-7b951e77d80f`, `params_hash bc52b52b…db8ae3`.

**OVK.** Zallet has no OVK RPC (ADAPTER.md §2) and no tested UFVK→OVK tool was used, so `--ovk`
is a random 32-byte placeholder kept outside the repo. C10 passing therefore proves only that the
committed value was not swapped, **not** that an auditor can see outgoing flows.

**Bids.** Each from a separate Zallet account, each memo naming a fresh Orchard-only refund address
(new diversifier). Bidders were Zallet accounts, not two different wallet apps (G2 asked for two).

| bidder | amount | case | txid |
|---|---|---|---|
| bidder-1 | 0.14 | winner | `767f4167bb2405736b080ac4f715af44b04562617336e852e0af71ce41aed2d9` |
| bidder-2 | 0.12 | winner | `d17db195c92ff7e161d03bf8bcf60d1d16b6529b9ed3769e93fa8d4616d4a14f` |
| bidder-4 | 0.11 | winner (marginal) | `0a008bf0c921fa13b68299983bec48d1a998a3354f3ec1f20eca0cd2e4a1e2af` |
| bidder-3 | 0.10 | exactly at reserve, loses | `41095e4d9a680f20aa73c4ba034550057ccbb1cd7132470fa7610efaed9d6021` |
| bidder-5 | 0.04 | below min-bid → dust | `81e9a64227e3269ec326483ca411ca53e19dfe80a477c98d9fc76cf27cc73765` |
| funder | 0.13 | sent at tip 4,549,558, mined after the deadline → late | `395127833d38d27956fdd316c9d27633ffb4a72ff032e00daf7821f17bf648da` |

No bid from a transparent address: every account here is shielded-only for sending.

**Scan.** First `scan` refused while the late bid was unmined (`has no mined height`, ADAPTER §6),
then: 6 notes in 6 tx — 4 bid, 1 dust, 1 late.

**Settle.** `settle --rpc` at height 4,549,561: uniform, 3 units, clearing price **0.11 TAZ**,
3 winners, refunds **5 outputs in 1 tx** `7803d3fcd33325102279420f6382d364f10c485409b4d5a5d41c88188cf1a677`
at height 4,549,569. Memos 6, largest 177/512 bytes. `RESULT: PASS (14/14 checks)`.

**Verify.** `verify fixtures/testnet-01` → PASS 14/14; C12 `account and admitted notes agree on the
ironwood pool`. `quantum-report`: 6/6 notes in Ironwood (quantum-recoverable, not post-quantum).

Not done in this run: independent `verify` from a second machine (step 6), web API field check
(step 7), bond.

## Wording for the submission

> Run on Zcash testnet on 2026-10-28 (auction `c91d6118…`, PASS 14/14, txids in `docs/TESTNET.md`)
> with an unreleased Zallet build (PR #898). Bidders were separate Zallet accounts. Bond, private
> mode and multi-transaction refunds are tested against fake Zallet.

Never describe a fake-Zallet run as a testnet run.
