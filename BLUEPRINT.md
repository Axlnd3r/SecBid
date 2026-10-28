# Secbid Blueprint v2

Executable architecture spec. A coding agent should be able to implement every phase from this file
plus `CLAUDE.md`. Section 9 is the ordered task list; work it top to bottom.

---

## 1. Goals and non-goals

**Goals (v2)**
- G1. A bid is one shielded payment from any ZIP-321 wallet. No bidder software required.
- G2. Deterministic, replayable clearing: first-price single lot (v1) and **uniform-price multi-unit** (v2).
- G3. Public verifiability: anyone with the published artifacts (+ UFVK in public-tender mode) can
  recompute the result and get `PASS`, and every class of lie fails a *named* check.
- G4. **Auditable custody**: OVK pre-commitment + optional **auctioneer bond**.
- G5. **Quantum posture**: recoverable pool when available, one-time refund addresses, exposure report.
- G6. **Private mode**: result verifiable by bidders and an auditor without publishing the UFVK.
- G7. A live **testnet** auction with published txids.

**Non-goals**: trustless custody (needs FROST), Vickrey/second-price (shill-biddable without seller
bond), cross-chain assets, hiding the number of bids, network-level anonymity, lot delivery,
claiming post-quantum security.

## 2. Actors

| Actor | Holds | Does |
|---|---|---|
| Seller / auctioneer | spending key (in Zallet), UFVK, OVK | open, scan, settle, refund, reveal |
| Bidder | own wallet | pay the ZIP-321 request, check own memo proof |
| Public verifier | artifacts (+ UFVK if revealed) | `secbid verify` |
| Auditor | committed OVK | verify outgoing flows in private mode |
| Bidder agent (optional) | bidder mandate only | build bid URI, check proof |

## 3. Component architecture

```
            ┌───────────── CLI (src/cli.ts) ─────────────┐
            │ open | uri | scan | settle | verify | proof│
            │ demo | quantum-report | bond | agent       │
            └───────┬───────────────────────────┬────────┘
                    │                           │
          src/auction.ts (orchestration)   src/verify.ts (C1..C14)
                    │                           │
 ┌──────────┬───────┼─────────┬──────────┐      │ reads artifacts only
 eligibility clearing settlement memo  zip321   │
 └──────────┴───────┬─────────┴──────────┘      │
          leaf.ts · merkle.ts · canonical.ts ◄──┘
                    │
          ChainAdapter interface (src/adapter.ts)
           ├── RecordedAdapter (scan.json fixtures)
           └── ZalletAdapter (src/zallet.ts, JSON-RPC)
                    │
                 Zallet ──► Zebra / testnet

 scripts/web.ts ── whitelist ──► web/ (static page, WebCrypto proof check)
 src/quantum.ts ── reads artifacts ──► exposure report
 src/bond.ts    ── bond commitment + check C13
```

Rule: **the verifier never imports the adapter.** It consumes files only.

## 4. Artifacts (directory per auction)

| File | Written by | Public? | Contents |
|---|---|---|---|
| `auction.json` | open | yes | params (§4.1), `params_hash`, `ovk_commitment`, `bond` |
| `account.json` | open --rpc | no | wallet account id, address, pool |
| `scan.json` | scan | no (yes after reveal) | received notes: txid, height, amount, memo, pool |
| `settlement.json` | settle | yes | clearing price, units, winners, Merkle root, refund plan |
| `leaves.json` | settle | yes | leaf table **without amounts** (§5) |
| `refunds.json` | settle | yes | refund txids, output count per tx, target height |
| `memos/<leaf>.base64` | settle | to bidder | inclusion-proof memo |
| `reveal.json` | reveal | yes (public-tender) | UFVK, reveal height |
| `quantum.json` | quantum-report | yes | exposure report (§8) |

### 4.1 `auction.json` params (spec v2)

```json
{
  "spec": 2,
  "auction_id": "hex32",
  "address": "u1…",
  "pool": "ironwood | orchard",
  "rule": "first-price | uniform",
  "units": "1",
  "reserve_zat": "10000000",
  "min_bid_zat": "10000000",
  "deadline_height": 3120000,
  "confirmations": 10,
  "mode": "public-tender | private",
  "ovk_commitment": "sha256 hex",
  "bond": { "address": "u1…", "amount_zat": "100000000", "commitment": "sha256 hex" } | null,
  "opened_at_height": 3110000
}
```
Defaults that keep spec-1 fixtures valid: `spec:1` ⇒ `rule:first-price, units:1, pool:orchard,
mode:public-tender, bond:null`. `params_hash = sha256(canonical(params))`.

## 5. Bid, leaf, Merkle

**Memo v2** (UTF-8 JSON, ≤ 512 bytes, strict schema, unknown keys ⇒ invalid):
```json
{"v":2,"refund":"u1…","qty":"1"}
```
`qty` optional (uniform rule; default 1). Memo v1 `{"v":1,"refund":"u1…"}` still accepted.

**Eligibility** (`src/eligibility.ts`) — a note is a valid bid iff:
height in `(opened_at_height, deadline_height]`, mined with ≥ `confirmations` at scan,
shielded input only (transparent-input ⇒ invalid, refunded), memo parses, refund address is a valid
shielded UA for the network, `amount ≥ min_bid_zat × qty`. Invalid notes are **still leaves**
with outcome `invalid:<reason>` and are refunded (minus fee) — never silently dropped.

**One-time refund rule (quantum posture):** if a refund address was used in any earlier auction
known to this auctioneer, or appears twice in this auction, the bid is valid but flagged
`refund_reused:true`, reported by `quantum-report`, and duplicates force separate refund tx.

**Leaf** = `sha256("secbid-leaf-v2" || canonical({auction_id, txid, action_index, amount_zat,
qty, refund_commit, outcome}))` where `refund_commit = sha256(refund_address || salt)`.
`salt = sha256("secbid-salt-v2" || auction_id || txid || action_index)`, delivered in the memo.
**Implementation note (spec 2.1):** the original draft said the salt is random per settlement.
That contradicts hard rule 2 (same bids + params ⇒ byte-identical `settlement.json`), so the
salt is domain-separated and deterministic. It is still unguessable without the memo, and the
artifact stays replayable. `leaves.json` publishes the leaf hash, qty/filled units, outcome, and
refund txid — **never `amount_zat` or `payment_zat`**.

**Merkle**: binary SHA-256, leaves sorted by `(height, txid, action_index)`, odd node duplicated,
domain-separated internal nodes `sha256(0x01||l||r)`, leaves `sha256(0x00||leaf)`.

## 6. Clearing rules (`src/clearing.ts`)

All arithmetic in `bigint` zatoshi. Price per unit `p_i = amount_i / qty_i` (integer division;
remainder refunded).

**first-price (units = 1):** highest `p_i ≥ reserve` wins and pays its bid. Tie ⇒ earliest
`(height, txid, action_index)`. Everyone else refunded in full.

**uniform (units = N):** sort valid bids by `p_i` desc, tie by earliest. Allocate units greedily
until N are allocated; the last bid may be **partially filled**. Clearing price `P` = price of the
**lowest accepted bid** (if fewer than N units demanded, `P = max(reserve, lowest accepted)`).
Each winner pays `P × filled_qty`; refund = `amount − P × filled_qty`. Losers refunded in full.

**Accounting identity (check C4):** `Σ deposits = Σ payments_to_seller + Σ refunds + Σ fees`.

## 7. Verifier checks (`src/verify.ts`)

C1–C10 keep their implemented v1 meanings; the table below is authoritative. Exit code 1 and
message `FAIL Cn: <reason>` on first failure; `--all` reports every check. A check that does not
apply is a pass with an `n/a` detail; a check that could not run because the viewer lacks a key is
`skip`, and skips make the verdict `PARTIAL`, never `PASS`.

| Id | Check | Needs |
|---|---|---|
| C1 | `params_hash` and `settlement_hash` match commitments; settlement is bound to the auction | artifacts |
| C2 | Merkle root recomputes from leaves | artifacts |
| C3 | inclusion proofs reconstruct to the root | artifacts |
| C4 | every admitted note is inside the bidding window | artifacts |
| C5 | every note at the address is a leaf (truncation) | UFVK |
| C6 | no transparent-funded note admitted as a bid | UFVK |
| C7 | clearing, outcomes, filled units, and leaves recompute | UFVK |
| C8 | each refund output exists on chain, right amount, right address | UFVK |
| C9 | accounting identity: in = refunded + retained + stranded + fees | UFVK |
| C10 | OVK matches `ovk_commitment` | UFVK |
| **C11** | uniform: all winners pay the same `P`; partial fill only on the marginal bid | artifacts |
| **C12** | pool recorded in `account.json` matches pool of received notes | UFVK |
| **C13** | bond: committed before first bid height and unspent until reveal + grace | bond.json |
| **C14** | private mode: auditor transcript (outgoing flows via OVK) matches `refunds.json` | OVK |

In private mode the published settlement carries no UFVK, so C5–C10 and C12 skip for a public
reader or an OVK-only auditor; C14 is the auditor's check. The auctioneer's local `settle`/`demo`
process holds the UFVK and reports the full set.

Modes: `fixture` (all checks the artifacts support), `audit` (no chain view: skip C5–C10, C12, C13
and **say so**, never print PASS for skipped checks — print `PARTIAL`).

**Tamper fixtures** (each adopts all hash commitments and still lies; one check catches each):
t1 wrong price → C7 · t2 truncate → C5 · t3 short refund → C8 · t4 transparent bid admitted → C6 ·
**t5 uniform two prices → C11 · t6 bond spent early → C13 · t7 wrong pool → C12**.
The forged-memo case is covered by `proof check` and the browser checker rather than a settlement
tamper; a memo is never trusted as an input to clearing.

## 8. Quantum posture

- **Pool selection** (`--pool auto|ironwood|orchard`): `auto` asks the adapter whether the wallet
  can create an account in the recoverable pool; falls back to Orchard **with a warning recorded in
  `auction.json`**. Never fail silently. If Zallet support is unknown, add to `OPEN-QUESTIONS.md`
  and keep `orchard` as default.
- **One-time refund addresses**: see §5. The bid page instructs wallets to use a fresh address;
  the memo builder in `secbid agent` always derives a fresh one.
- **`secbid quantum-report <dir>`** writes `quantum.json` and prints a table:
  - notes by pool (recoverable vs not),
  - published long-lived items: auction address, revealed UFVK, bond address,
  - reused refund addresses (the published `quantum.json` carries a stable fingerprint, not the
    address; the local CLI terminal can name it),
  - a fixed disclaimer line: *"Quantum-recoverable ≠ post-quantum. Privacy of revealed data is
    not protected against a future discrete-log-breaking adversary."*

## 9. Task list (ordered)

Each task: files · acceptance. Tick when `npm test` is green.

### Phase A — spec v2 foundation
- [x] **A1** Add `spec`, `rule`, `units`, `pool`, `mode`, `bond` to params with spec-1 defaults.
  `src/auction.ts`, `src/serialize.ts`. ✔ `fixtures/auction-01` still PASS 14/14 (C11–C14 n/a); golden params hash test `tests/golden/params-v2.json`.
- [x] **A2** Memo v2 parser (`qty`), strict schema, v1 compatible. `src/memo.ts`. ✔ tests: unknown key rejected, 513-byte memo rejected, v1 accepted, bad qty rejected.
- [x] **A3** Leaf v2 with `qty`, `refund_commit`, deterministic salt; v1 path kept for spec 1. `src/leaf.ts`. ✔ golden vector `tests/golden/leaf-v2.json`.

### Phase B — uniform-price clearing
- [x] **B1** Implement uniform rule incl. partial fill and remainder refund. `src/clearing.ts`. ✔ table tests: undersubscribed, oversubscribed, exact, tie, partial marginal bid.
- [x] **B2** Settlement + refund plan for uniform. `src/settlement.ts`, `src/refunds.ts`. ✔ accounting identity holds in all B1 cases.
- [x] **B3** Verifier C11 + tamper t5. ✔ `verify fixtures/tamper/t5-two-prices` → `FAIL C11`.
- [x] **B4** CLI flags `--rule --units`; `demo --rule uniform --units 3`. ✔ prints `RESULT: PASS (14/14 checks)`.

### Phase C — auditable custody
- [x] **C1** `src/bond.ts`: bond commitment in `open`, `bond record|show` CLI. ✔ unit tests + CLI test.
- [x] **C2** Verifier C13 + tamper t6. ✔ `FAIL C13`.
- [x] **C3** Private mode: the mode is committed at `open --mode private`, so `settle` never reveals the UFVK; `verify --auditor --ovk <hex>` runs C14. ✔ auctioneer demo PASS (local UFVK view), public/auditor verdict PARTIAL, FAIL C14 when a transcript is truncated.

### Phase D — quantum posture
- [x] **D1** Adapter capability `supportsPool(pool)`; `--pool auto` logic + warning. `src/adapter.ts`, `src/zallet.ts`, fake wallet. ✔ fallback test; Zallet refuses to guess Ironwood (OPEN-QUESTIONS).
- [x] **D2** Reused/duplicate refund detection + forced separate tx. `src/eligibility.ts`, `src/auction.ts`, `src/quantum.ts`. ✔ tests; cross-auction history via `quantum-report --history`.
- [x] **D3** Verifier C12 + tamper t7. ✔ `FAIL C12`.
- [x] **D4** `src/quantum.ts` + `quantum-report` CLI. ✔ snapshot test of output incl. the fixed disclaimer.

### Phase E — web page
- [x] **E1** Show rule, units, pool, mode, bond on the Bid tab; "use a fresh address" notice.
- [x] **E2** Result tab: uniform price + filled units per winning leaf (no amounts); leaf table has qty/filled columns.
- [x] **E3** Verify tab runs C1–C14 where artifacts allow and renders `PARTIAL` when a key is missing.
- [x] **E4** New "Quantum" tab rendering `quantum.json`. ✔ web tests: whitelist still excludes amounts, memos, scan, and account.

### Phase F — bidder agent (optional, skip if behind)
- [x] **F1** `secbid agent bid <dir> --mandate mandate.json` → prints ZIP-321 URI, amount, and memo v2 from a strict mandate.
- [x] **F2** `secbid agent check <dir> <memo>` → wraps `proof check`. No network, no LLM in core path.

### Phase G — testnet (highest priority for judging; do as soon as A–B pass)
- [x] **G1** Run Zebra + Zallet on testnet; record versions in `docs/TESTNET.md`.
- [ ] **G2** Open a uniform 3-unit auction, ≥ 5 bids from at least 2 different wallet apps, settle, reveal.
      *Partial (2026-10-28): 6 bids, settled, revealed — but all from Zallet accounts, one app.*
- [x] **G3** Commit artifacts to `fixtures/testnet-01/`; `verify` → PASS; paste transcript + txids into `docs/TESTNET.md`.
- [ ] **G4** Record the 3-minute demo video (§10).

> **G is not done.** No testnet node or funded wallet was available in this workspace. Every live-path
> result (including JSON-RPC shapes) is tested against the fake Zallet in `tests/helpers/fake-zallet.ts`;
> `docs/TESTNET.md` records that honestly. Do not mark G complete without real txids.

### Implementation notes (spec 2.1)

- **Amounts** are `bigint` zatoshi in memory. Spec 1 artifacts serialize them as JSON numbers (the
  historical format); spec 2 serializes decimal strings. `src/serialize.ts` is the only codec.
- **C1–C10 keep their v1 meanings**; C11–C14 are additive. Tamper t4 is caught by C6, not a
  renumbered check. This keeps the v1 fixtures and their transcripts valid.
- **`settlement.json` still carries the entry table** for spec 1 and spec 2; spec 2 additionally writes
  `leaves.json` (no amounts) and `refunds.json` (auditor transcript commitment).
- **Private mode** is chosen at `open`, because `mode` is committed in `params_hash`. `settle` refuses
  to override it; hiding the UFVK at settlement would otherwise contradict the auction the bidders paid.
- **Bond** terms are committed in `auction.json`; the funding/spend view lives in `bond.json` and is
  checked by C13. A spent bond is detectable, not preventable: auditable custody, never trustless.

## 10. Demo script (3 minutes)

1. 0:00 Problem: one sentence + "price public, bidders not".
2. 0:20 Scan QR on the auction page with Zashi, pay. Show explorer: no amount, no sender.
3. 0:50 Settle: uniform price, refunds split across tx, memos.
4. 1:30 Bidder pastes memo → OK. Flip a byte → caught.
5. 1:50 `verify` testnet-01 → PASS 14/14. Then t2 and t5 → different FAIL checks.
6. 2:30 `quantum-report` + trust model slide: auditable custody, bond, not trustless.
7. 2:50 Use case: OTC block sale. Close.

## 11. Definition of done

`npm test` green · `demo` PASS for both rules · all 7 tampers FAIL on their own check ·
`docs/TESTNET.md` has real txids · README status line matches reality · no overclaim words
(`grep -riE "quantum-proof|trustless" README.md web/` returns only negations).
