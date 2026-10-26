# Secbid — Technical Blueprint

> **Status.** This file is the v1 design record (spec 1 numerals, first-price). The current
> implemented spec is **v2**, whose task list and artifact/check definitions live in
> [`../BLUEPRINT.md`](../BLUEPRINT.md). The v1 material below is kept because it still defines the
> Merkle vector, the threat assumptions, and the v1 compatibility path. Where the two disagree,
> `../BLUEPRINT.md` wins.
>
> Implemented v2 additions: bigint zatoshi + spec-2 decimal strings (`src/serialize.ts`), memo/leaf
> v2, uniform-price multi-unit clearing, bond + C13, private mode + C14, pool capability + C12,
> quantum report, bidder agent, and 14 verifier checks. `npm test` covers all of it.

Specification for a sealed-bid auction on Zcash where a bid is a shielded payment.
Everything here is designed to be **replayable**: given the chain and the published artifacts, an
independent verifier must reach the same verdict.

Status legend: `[SPEC]` decided, implement as written · `[SPIKE]` must be validated on Day 1 ·
`[OPEN]` not decided.

---

## 1. Goals

1. A bidder can bid with **any Zcash wallet** that supports ZIP-321 — no account, no app install.
2. Bid amounts, bidder identities, and the recipient of each bid are **hidden by the protocol**,
   not by an application-level promise.
3. The settlement is **independently recomputable** from chain data after the auctioneer discloses
   the auction account's UFVK.
4. Every failure mode that remains is **documented and demonstrated**, not hidden.

Non-goals: trustless custody, cross-chain lots, Vickrey clearing, hiding bidder count, network-level
anonymity. See `../README.md`.

---

## 2. Actors

| Actor | Holds | Can do | Cannot do |
|---|---|---|---|
| Seller | lot (off-chain) | set reserve, open auction | read bids before deadline |
| Auctioneer | auction spending key, full viewing key | read bids, clear, refund | hide a mismatch between chain and published artifacts |
| Bidder | own wallet | send a shielded bid | see other bids |
| Auditor | OVK committed at open | verify refund flows after settlement | spend, or see bids |
| Verifier | nothing but chain + artifacts | recompute the whole auction | — |

Note: seller and auctioneer may be the same entity. If they are, say so on the auction page —
the seller-shill argument in §7 depends on it.

---

## 3. Lifecycle and time

All deadlines are **block heights**, never wall-clock. Testnet reorgs are shallow but real.

```
OPEN          t0 commitment published (auction params + OVK commitment)
BIDDING       notes accepted while height <= deadline_height
SETTLE        wait settle_depth (mainnet 6, testnet 3) after deadline_height
              then reveal UFVK, clear, publish settlement.json
REFUND        batched shielded tx(s) at a single height
AUDIT         verifier runs in public mode; inclusion proofs delivered by memo
```

A note is eligible iff its **inclusion height** `h <= deadline_height`. Not the wallet's timestamp,
not the server's clock: the height. This is the only deadline definition a verifier can check.

---

## 4. Data model

### 4.1 Memo (512 bytes, UTF-8 JSON)

```json
{"v":1,"refund":"u1<unified address>","label":"optional ≤64 chars"}
```

- `refund` must be a **shielded** address (UA with an Orchard receiver, or a `zs1…` address).
  A transparent refund address is rejected: it would publish the refund link.
- The memo is **not** part of the leaf (see §6) so a wallet that mangles the memo degrades
  recoverability, not the integrity of the tally.
- Bidders are instructed to use a **fresh address per bid**. The protocol cannot enforce it; a reused
  refund address links a bidder's bids to each other.

### 4.2 Received note (internal)

```
ReceivedNote {
  txid: 32 bytes
  height: u32              // inclusion height
  action_index: u16        // position within the tx
  value_zat: u64
  cm: 32 bytes             // note commitment
  memo_raw: [u8; 512]
  memo: Option<Memo>       // parsed, None if absent/invalid
  transparent_funded: bool // tx has >=1 transparent input
}
```

### 4.3 Eligibility rules (evaluated in this order)

| id | rule | on failure |
|---|---|---|
| E1 | `height <= deadline_height` | `late` — refunded, excluded from clearing |
| E2 | memo parses, `refund` is a shielded address | `stranded` — nowhere safe to refund; claim flow (§15) |
| E3 | `value_zat >= min_bid_zat` (default 10_000 = 0.0001 ZEC) | `dust` — refunded |
| E4 | `!transparent_funded` | `transparent_funded` — refunded, excluded |
| E5 | note not already claimed by another auction | `replay` — refunded |

E2 runs **before** E1 in the implementation, against the numbering: a note with no usable refund
address is `stranded` whenever it arrived. Labelling a memo-less late note `late` would put it in
the refund plan with nowhere to send it, and the settlement builder refuses to emit a refundable
row without a refund transaction. A late note with a valid memo is still `late`.

E4 matters more than it looks: a `t→z` funding transaction reveals the input amount on the
transparent side. One such bid publishes a competitor's number and weakens the auction's claim.
Rejection is visible in the leaf table (as an outcome, not an amount) — that is intentional.

**Every received note gets exactly one row in the table.** This invariant
(`|table| == |notes at auction address|`) is what makes truncation detectable (check C5, §11).

---

## 5. Auction parameters

```json
{
  "v": 1,
  "auction_id": "hex16",
  "network": "test",
  "address": "u1...",
  "reserve_zat": 100000000,
  "deadline_height": 3120000,
  "settle_depth": 3,
  "min_bid_zat": 10000,
  "clearing_rule": "first_price",
  "created_at_height": 3110000,
  "ovk_commitment": "sha256(...)",
  "params_hash": "sha256(canonical json without this field)"
}
```

`[OPEN]` Who signs `auction.json`? Plan: an Ed25519 seller key + OpenTimestamps proof, so the params
and the OVK commitment provably existed before the first bid.

---

## 6. Leaf and Merkle tree `[SPEC]`

A leaf must be recomputable by anyone with chain access — no secrets, no memo:

```
leaf_i = SHA256( "secbid:leaf:v1" || txid(32) || note_commitment(32) )
```

Properties this buys us:

- **Unique by construction** (a note commitment appears once on chain), so no nonce is needed and a
  wallet that drops the memo does not corrupt the tree.
- **No amount, no address** — publishing the leaf list leaks nothing beyond "these txs exist".
- **Verifiable both ways**: the auctioneer computes it while scanning; a bidder computes it from
  their own txid and the note commitment.

Leaves are sorted by `(height asc, txid asc, action_index asc)` before building the tree.

```
node(l, r) = SHA256( 0x01 || l || r )
```

Odd node at any level is **promoted unchanged** to the next level (no last-node duplication).
Promotion vs duplication changes the root, so this must not be "whatever the library does".
Domain separation: leaves are not prefixed with `0x01`; only internal nodes are.

Inclusion proof = list of `(direction, sibling_hash)` where `direction = 0` means the sibling is on
the **left**.

### Test vector (verified)

Leaves built from the reference formula for `i = 0..4` with `txid = bytes32(i)` and `cm = bytes32(i)`
(i.e. every byte of both fields set to `i`). Generated and verified with the script in §18.

```
leaf0 a53cffb6b960d2d55c92cb0e8db565c656b9720690cdee9456e8111e2cfd31ab
leaf1 4939ec1621227735748323bec521eaa209b9ebdd8803e43d8a4b92dcdbd2569f
leaf2 25e35c9e49076fa8fb6c171ab8e7a7bcf1c654f90f1a7dec97cfdaeb3478f078
leaf3 246b6def11b429140f21b950ff29f360eafb04ff943f4dab3dca35145299fd3a
leaf4 bb1b08d4fe71da134178f7536de42bea608da60356eef1fce14d83fc44dbb9ef

level sizes: 5, 3, 2, 1
root        16e71800048760251fe118ca97c49cd2c1df7fe856042973a60fccaf9aba5a72

proof(leaf1) = [
  [0, "a53cffb6b960d2d55c92cb0e8db565c656b9720690cdee9456e8111e2cfd31ab"],
  [1, "749ef050acd13a020233b2a30e24a4c6aa8c83d1c46680c1dbaa5f64ca6c6a11"],
  [1, "bb1b08d4fe71da134178f7536de42bea608da60356eef1fce14d83fc44dbb9ef"]
]

proof(leaf4) = [
  [0, "a8d0982202a3cd26ce214095174f142042abe21c9f9cbffeb3e41b0a575a3acf"]
]
```

`leaf4`'s proof has a single element because it is promoted at two levels before pairing at the top.
Any implementation that reproduces this root and both proofs is compatible.

---

## 7. Clearing `[SPEC]`

```
eligible = [note for note in notes if outcome == "bid"]
winner   = max(eligible, key=(value_zat, -height, -txid_bytes))   # highest, then earliest, then lowest txid
if winner is None or winner.value_zat < reserve_zat:
    result = "unsold"; all notes refunded
else:
    result         = "sold"
    clearing_price = winner.value_zat        # first price
    winning_leaf   = leaf(winner)
```

Deterministic tie-break matters: without it, two identical bids produce two valid summaries.

**Why first price, not Vickrey.** In second-price clearing the winner pays the runner-up's bid, so a
seller who bids through a second wallet can raise the price the winner pays. Without a seller bond or
a verified seller identity, Vickrey is shill-biddable in exactly the setting Secbid targets. Second
price is roadmap, not scope.

Auctioneer must not bid in its own auction (same for the seller). Nothing cryptographically enforces
this; it is a disclosed trust assumption, mitigated by the fact that a seller shill bid **wins and
pays** in first-price clearing.

---

## 8. Settlement artifact `[SPEC]`

One file, canonical JSON, published together with `SHA256(file)`:

```json
{
  "v": 1,
  "auction_id": "hex16",
  "params_hash": "sha256(...)",
  "ovk_commitment": "sha256(...)",
  "ufvk": "uview1...",
  "deadline_height": 3120000,
  "settle_height": 3120003,
  "entries": [
    { "leaf": "hex32", "txid": "hex32", "cm": "hex32", "height": 3119000,
      "action_index": 0,
      "outcome": "winner|refunded|late|dust|transparent_funded|stranded",
      "refund_txid": "hex32|null" }
  ],
  "merkle_root": "hex32",
  "result": "sold|unsold",
  "clearing_price_zat": 1200000000,
  "winning_leaf": "hex32",
  "refund_txs": [{ "txid": "hex32", "height": 3120005 }],
  "accounting": { "refunded_zat": 2930005000, "retained_zat": 1200000000, "fees_zat": 0 }
}
```

`entries` is ordered by `(height, txid, action_index)` and **is** the leaf list: `leaf` is carried in
the row, so a separate `leaves` array cannot drift from the table. Ordering is part of the spec, not
an implementation detail.

**Per-bid amounts are never in the artifact.** Anyone with the revealed UFVK recomputes them. The
clearing price is public by design; the refund total is already visible to an OVK holder.

`accounting` deliberately omits total inflow and the stranded total. Publishing them would disclose
**total bid volume**, which is commercially sensitive in a private auction — and in a small auction
an aggregate can equal one note's amount. The verifier recomputes both from the chain view.

`accounting.fees_zat = 0`: the auctioneer pays transaction fees from its own funds, outside the
auction accounting. This makes the refund check an exact equality instead of an inequality, which is
worth more than the dust it costs.

---

## 9. Refunds `[SPEC]`

- One shielded transaction carrying one output per refund, amounts exactly equal to the received
  value. Winner: nothing (first price already paid).
- If the refund set exceeds the size a single transaction may carry under ZIP-225 limits, split into
  several transactions broadcast together and mined at **one target height**; record every txid and
  require a single distinct height in the artifact. If they land at different heights, the verifier
  warns loudly: timing correlation is back.

Implemented as `chunkRefundPlan` / `broadcastRefunds` (`src/auction.ts`), with
`DEFAULT_MAX_OUTPUTS_PER_TX = 40` as the placeholder budget until a real adapter reports a measured
ZIP-225 figure (`--max-outputs` overrides it). The Zallet adapter does not report that figure yet:
`z_sendmany` has no target-height parameter and no output-count report, so it refuses a batch that
the wallet splits internally rather than guessing which transaction paid which leaf. Two entries
that reuse a refund address are placed in separate transactions, because Zallet rejects duplicate
recipients and C8 allows one output per entry. The batch records `leaf → txid`, so an entry never
claims a refund that a different transaction carried; `settlement.ts` refuses to publish a
refundable row with no assigned transaction, or one pointing at an unpublished txid. C8 then checks
that each output is claimed by exactly one entry, that refunds are shielded only, and that the
outputs total the published refund aggregate.
- Refund outputs are shielded only. A refund to a transparent address is a bug, not a feature.
- The winning bid stays in the auction account and is swept to the seller after the refund batch is
  mined — after, not before, so a single confirmation depth applies to both.

### Inclusion-proof memo `[SPEC]`

Each bidder receives one memo proving their own bid was counted and how it was resolved. Binary, not
JSON: a JSON proof of depth 7 already runs ~250 bytes and stops fitting around 16 bids, which is
exactly when an auction gets interesting.

```
magic "SB1" (3) | version (1) | outcome (1) | clearing price u64 LE (8)
leaf (32) | root (32) | n (1) | n * [ direction (1) | sibling hash (32) ]
```

Fixed overhead 78 bytes, 33 bytes per path element, so **13 elements fit in 512 bytes** (a tree of
~4,096 bids). Deeper auctions must ship the path as a published file instead; the protocol does not
pretend otherwise. An unknown version, a bad magic, a bad direction, or a length that disagrees with
`n` is a hard decode error.

What the memo proves: the leaf was in the committed set, the recorded outcome matches, and the price
is the published one. What it does not prove: that the set was complete — that is C5's job, and the
reason the UFVK reveal exists.

---

## 10. Publication timeline and commitments `[OPEN→SPEC]`

| When | Artifact | Commitment |
|---|---|---|
| open | `auction.json` | `params_hash` + OpenTimestamps |
| open | — | `ovk_commitment = SHA256("secbid:ovk:v1" \|\| auction_id \|\| ovk_bytes)` |
| close+`settle_depth` | `settlement.json` | `SHA256(file)` + OpenTimestamps |
| close+`settle_depth` | UFVK + OVK | must match `ovk_commitment` |
| after refunds | `refund_txs` appended | re-hash, re-publish |

The OVK commitment is the cheap trick that makes the audit mean something: it proves the viewing key
the auditor holds was fixed **before** the first bid, so the auctioneer cannot mint a fresh key at
settlement and show you a story that only fits that key.

There is no place on Zcash L1 to anchor arbitrary bytes: transparent outputs carry no data field and
shielded memos are readable only by the recipient. Timestamped, hash-committed files are the honest
limit of public anchoring today; the UFVK reveal is what replaces trust with recomputation.

---

## 11. Verifier `[SPEC]`

```
secbid verify --auction <dir-or-url> [--fixture <file>] [--mode public|audit]
```

Modes:

- `public` — UFVK available; the verifier rescan the chain and reconstructs amounts and bidders'
  refund addresses. Full recomputation.
- `audit` — OVK only; verifies refund flows and internal consistency, cannot see amounts.
- `fixture` — no node required; replays a recorded auction from `fixtures/`. This is the mode judges
  will actually run.

Checks, each with a stable code:

| id | check | failure means |
|---|---|---|
| C1 | `params_hash` / `settlement` hash match the timestamped commitments | artifacts edited after publication |
| C2 | `merkle_root` recomputed from `leaves` matches | leaf list tampered |
| C3 | every `proof` in `proofs/` reconstructs to the root | bogus inclusion proof |
| C4 | every **admitted** note (`bid`/`winner`/`refunded`) has `height <= deadline_height` | late bid counted; a `late` row is fine and must exist for C5 |
| C5 | `\|entries\| == \|notes at address\|` (public) or `== published tx count` (audit) | **truncation** |
| C6 | no note with a transparent input has an admitted outcome | privacy claim broken by an admitted bid |
| C7 | clearing recomputes to the same winner, price, and per-entry outcome | mis-tally or price manipulation |
| C8 | every refundable row has a refund tx with exactly `value_zat`; refunds are shielded; each output answers for one row; all refund txs share one height | missing / partial / split refund, or a transparent refund link |
| C9 | recomputed `in == refunded + retained + stranded + fees`, and published aggregates match | accounting mismatch, or volume hidden/tampered |
| C10 | revealed OVK hashes to `ovk_commitment` | key swapped after the fact |

Exit codes: `0` PASS · `1` FAIL (prints the first failing code and the offending leaf) · `2` cannot
evaluate (missing chain data / fixture).

The verifier must be able to fail: each check ships with a tamper fixture (§12).

---

## 12. Tamper scenarios (the demo) `[SPEC]`

Four fixtures, four failures. These are the artifacts judges click:

| id | tamper | expected (actual output) |
|---|---|---|
| T1 | clearing price changed by 1 zat | `FAIL C7: clearing price 1199999999 != 1200000000` |
| T2 | one bid dropped, root **and** proofs recomputed | `FAIL C5: truncation: 7 observed at the auction address, 6 committed` |
| T3 | refund batch removed | `FAIL C8: leaf … is refundable but has no refund txid` |
| T4 | transparent-funded note admitted | `FAIL C6: transparent-funded bid admitted: …` |

Each tampered fixture recomputes `settlement_hash` too, so C1 passes: a hash commitment proves the
file was not edited after publication, never that the file is true. That distinction is the demo's
punchline, and it is asserted by a test.

Demo script: run `verify` on the honest settlement → PASS; point it at a tamper directory → FAIL with
code; back to honest → PASS. Total 40 seconds.

---

## 13. Components

Implemented today, zero dependencies, runs on stock Node 24:

```
src/model.ts        types; amounts are integer zatoshi in a JS number (21e14 < 2^53)
src/leaf.ts         §6 leaf + domain tags
src/merkle.ts       §6 tree, proofs, canonical order
src/canonical.ts    canonical JSON + hashes (integer-only, sorted keys)
src/eligibility.ts  E1-E4
src/clearing.ts     §7, pure, deterministic tie-break
src/settlement.ts   artifact builder + accounting identity + duplicate-leaf and refund-assignment guards
src/proof.ts        §9 proof memo, binary, 512-byte budget
src/zip321.ts       payment request build/parse
src/auction.ts      open, refund plan + split/broadcast, settle, memo generation, memo check
src/adapter.ts      ChainAdapter port + SimulatedChain (recorded view, target height)
src/rpc.ts          JSON-RPC over node:http: cookie/password auth, per-call timeout, redacted errors
src/zallet.ts       Zallet adapter: create account, rescan with memos + cmx, refund batch
src/verify.ts       C1..C14
src/cli.ts          open | scan | settle | verify | demo | uri | proof   (exit 0|1|2)
scripts/            fixture generator (honest + T1..T4)
tests/              66 tests: vector, rules, clearing, verifier, pipeline, CLI, web api + proof checker,
                    Zallet adapter + fake wallet
fixtures/           recorded auction + 4 tampered variants
web/                auction page; see docs/WEB.md
```

The wallet boundary is built: `src/zallet.ts` implements the trait below over Zallet's JSON-RPC
(`src/rpc.ts`), including account creation, rescan with memos and note commitments, and the refund
batch. `docs/ADAPTER.md` records the exact method surface and the limits it refuses to paper over.

Not built:

```
verifier-rescan/    a UFVK-only scanner. Zallet imports Sapling viewing keys only, so an independent
                    verifier cannot yet rescan on Zallet; lightwalletd/Zaino is the likely path
adapter/            the Rust trait below is still the target shape for a non-JSON-RPC adapter
defi/               fee query; broadcast beyond z_sendmany
```

Built since: `web/` is one page per auction (`/?a=<slug>`) instead of three routes — parameters,
countdown by height, QR and per-wallet how-to, clearing price, entry table, the ten verifier checks
with the seven tampered settlements selectable, and the client-side proof check. It has no build step
and is served by `scripts/serve-web.ts`.

**Stack note (revised during implementation).** The deterministic core and verifier are TypeScript,
not Rust: the machine had no linker (no MSVC Build Tools, no mingw), so `cargo test` could not link a
test binary, while Node 24 runs TypeScript natively with `node:test` and zero dependencies. Nothing
in §6-§11 is language-specific, and the §6 test vector plus the four tamper fixtures are
cross-language golden checks: a Rust port is correct exactly when it reproduces them. Rust comes
back only if the rescan adapter needs `librustzcash` directly instead of Zallet RPC.

Wallet adapter — the boundary that keeps the 9-day plan honest:

```rust
trait AuctionWallet {
    fn create_account(&self) -> AccountId;                 // fresh, per auction, never reused
    fn address(&self, a: AccountId) -> UnifiedAddress;     // + diversifier index
    fn ufvk(&self, a: AccountId) -> Ufvk;                  // publishable at settlement
    fn ovk(&self, a: AccountId) -> Ovk;                    // committed at open
    fn scan_notes(&self, a: AccountId, from: u32) -> Vec<ReceivedNote>;
    fn send_many(&self, a: AccountId, out: Vec<(UnifiedAddress, u64, Option<Memo>)>) -> Vec<TxId>;
    fn tx_has_transparent_inputs(&self, txid: &[u8; 32]) -> bool;
}
```

The port is implemented twice: `SimulatedChain` (recorded view, used by `demo` and tests) and
`ZalletAdapter` (live JSON-RPC). Swapping them changes no line of `clearing`, `settlement`, or
`verify` — that is the reason the port exists. The Zallet adapter is tested against a fake wallet
that reproduces Zallet's response structs, not against testnet yet.

Adapter candidates `[SPIKE]`: Zallet (Z3 stack), `zingo-cli`/`zingolib`, or `zcash_client_backend`
+ lightwalletd/Zaino directly. **zcashd is not an option**: it reached end-of-support at height
3,417,100 on 18 July 2026 and halts by design. Do not build the demo on it.

Day-1 findings, pinned to Zallet's published JSON-RPC (`docs/ADAPTER.md`): `z_listreceivedbyaddress`
is not implemented; `z_listtransactions` (account-scoped, includes spent notes) plus
`getrawtransaction` for `orchard.actions[].cmx` is the working scan; `z_sendmany` has no target
height; the OVK is not exposed by any RPC; and a UFVK cannot be imported for a third-party rescan.
Those four limits are the reason the adapter is explicit about what it cannot prove.

---

## 14. Failure modes `[SPEC]`

| # | failure | effect | mitigation |
|---|---|---|---|
| 1 | bid sent without memo | no refund address → `stranded` | require wallet deeplink flow; claim by revealing note plaintext (§15) |
| 2 | wallet strips the memo from ZIP-321 | same as 1 | `[SPIKE]` test Zashi / YWallet / Zingo! on Day 1; publish per-wallet instructions |
| 3 | refund address reused across bids | bids link to each other | UI instruction; cannot be enforced |
| 4 | reorg after deadline | bid disappears or moves | `settle_depth`; published `settle_height` |
| 5 | auctioneer offline at settlement | no refunds until it returns | bond / named operator; verifier proves the delay |
| 6 | refund batch too large | multi-tx, timing spread | single target height; verifier warns if heights differ |
| 7 | auction address reused for a second auction | UFVK disclosure leaks the first auction's bids | **forbidden**: one ephemeral account per auction, destroyed after |
| 8 | bidder funds from a transparent address | amount public | E4 rejection + C9 |
| 9 | seller bids in own auction | price inflation | disclosed; first price means a shill bid that wins must pay |
| 10 | lot never delivered | winner loses money with no recourse | out of scope; disclosed on the auction page |

---

## 15. Stranded-funds claim flow `[OPEN]`

A note with no parseable memo cannot be refunded automatically — the auctioneer does not know where
to send it, and the chain does not reveal the sender. Claim procedure:

1. The note appears in the table as `stranded`, with its leaf.
2. Anyone can claim it by posting the note plaintext (`rho`, `rcm`, `value`, `cm`) that hashes to the
   commitment, plus a fresh shielded address.
3. The auctioneer verifies the plaintext against chain, and adds the refund to the batch.

Revealing the note plaintext also hands over spend authority — but the auctioneer already has it, so
within this trust model it costs the claimant nothing extra. This flow is disclosed in the UI, and
prevention (the deeplink) is the primary control.

---

## 16. Nine-day plan

| day | deliverable | exit criterion | status |
|---|---|---|---|
| 1 | **spike gate** + repo skeleton + threat model final | adapter can: create account → receive with memo → list notes with height; else switch to regtest and say so | adapter implemented and tested against a fake Zallet; testnet run pending |
| 2 | scanner + memo validation + eligibility | 5 fixture notes classified correctly by unit tests | done (fixtures) |
| 3 | merkle + clearing as pure functions | test vector §6 passes; clearing cases pass | done |
| 4 | refund batch via adapter | testnet refunds land, verifier C8 passes | logic + Zallet adapter done, incl. split batches, duplicate-address split and one-height guard; testnet pending |
| 5 | web: create, QR, results, entry table, client-side proof check | a stranger can bid from the page without instructions | built, minus in-browser create: `secbid open` covers creation in the CLI |
| 6 | **live testnet auction**, 5+ bidders, ≥1 not-you | published artifacts + verifier PASS | blocked on day 1 |
| 7 | verifier + T1..T4 + README/threat model | 4 tamper fixtures each FAIL with the right code | done |
| 8 | 3-minute video + submission text | problem → demo → private/public → trust assumption | not started |
| 9 | buffer | — | — |

Day-1 gate is a hard gate. If the adapter cannot read memos on testnet, the correct move is a
recorded-fixture demo plus an honest note in the README — not three more days of wallet plumbing.

Cut line if something slips: drop the web proof page (the CLI verifier covers it), then drop
multi-wallet instructions (keep one wallet that works). Never cut the tamper fixtures or the
threat model: those are the two things that separate this from a mockup.

---

## 17. Open questions

1. `[SPIKE]` ZIP-321 `memo` param support in Zashi / YWallet / Zingo! — which wallets actually carry
   it, and does the memo survive the scan?
2. `[SPIKE]` Zallet maturity in Oct 2026: does it expose `list received notes with memo` and
   `send many shielded outputs` over RPC?
3. Testnet faucet supply for 5+ realistic bids; reserve low enough to be practical (e.g. 0.1 ZEC).
4. UA vs `zs1…` for refund addresses: UA is friendlier, but must be checked against every wallet.
5. Whether to publish the OVK itself post-settlement (stronger audit) or only its commitment
   (stronger privacy). Current default: commitment at open, OVK to the auditor, OVK published with
   the settlement artifact only in `public tender` mode.

---

## 18. Reference tree generator (produces §6 test vector)

Deliberately small and dependency-free; port it to Rust as the first commit, with these values as
`assert_eq!` golden tests.

```js
const c = require('crypto');
const H = b => c.createHash('sha256').update(b).digest();

const leaf = i => H(Buffer.concat([
  Buffer.from('secbid:leaf:v1'),
  Buffer.alloc(32, i),   // txid
  Buffer.alloc(32, i),   // note commitment
]));

const node = (l, r) => H(Buffer.concat([Buffer.from([1]), l, r]));

function build(leaves) {
  const levels = [leaves];
  let cur = leaves;
  while (cur.length > 1) {
    const next = [];
    for (let i = 0; i + 1 < cur.length; i += 2) next.push(node(cur[i], cur[i + 1]));
    if (cur.length % 2) next.push(cur[cur.length - 1]);   // promote odd node
    cur = next;
    levels.push(cur);
  }
  return levels;
}

function proof(levels, index) {
  const out = [];
  let i = index;
  for (const level of levels.slice(0, -1)) {
    if (i % 2 === 0) { if (i + 1 < level.length) out.push([1, level[i + 1]]); }
    else out.push([0, level[i - 1]]);
    i = Math.floor(i / 2);
  }
  return out;   // direction 0 = sibling on the left
}

function verify(leafHash, path) {
  let cur = leafHash;
  for (const [dir, sib] of path) cur = dir === 0 ? node(sib, cur) : node(cur, sib);
  return cur;
}
```

Run: `build([0,1,2,3,4].map(leaf))` → root `16e71800…aba5a72`; `verify(leaf(1), proof(levels, 1))`
must equal that root.

---

## 19. v2 implementation map

| v2 concern | File | Check |
|---|---|---|
| spec-1/spec-2 codecs, bigint boundary | `src/serialize.ts` | C1 |
| memo v2 (`qty`), strict schema | `src/memo.ts` | eligibility |
| leaf v2 + refund commitment | `src/leaf.ts` | C2/C7 |
| uniform-price clearing, partial fill | `src/clearing.ts` | C7/C11 |
| payments, winners' excess refunds | `src/settlement.ts` | C8/C9 |
| auditor transcript | `src/refunds.ts` | C14 |
| pool capability + fallback | `src/adapter.ts`, `src/zallet.ts` | C12 |
| bond terms + chain view | `src/bond.ts` | C13 |
| exposure report | `src/quantum.ts` | `quantum-report` |
| bidder mandate | `src/agent.ts` | `agent bid/check` |
| web whitelist + tabs | `scripts/serve-web.ts`, `web/` | E1–E4 |

Spec-1 fixtures remain byte-compatible with the v1 leaf and numbers. Spec-2 artifacts are
canonical-JSON with decimal strings; see `../BLUEPRINT.md` §4–§5 for the exact field list.
