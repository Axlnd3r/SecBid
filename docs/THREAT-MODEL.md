# Secbid — Threat Model

The uncomfortable part of the project, written before the code so it cannot be retrofitted to the
implementation.

**One-line summary:** Secbid hides bid amounts and bidder identities *from observers*, using Zcash's
shielded pool. It does not make the auctioneer trustless, and it does not make every outcome
provable. Both limits are listed below with the exact consequence.

---

## 1. Assets

| asset | owner | at risk from |
|---|---|---|
| bid amounts | bidder | auctioneer, chain analysis, a transparent-funded bid |
| bidder identity | bidder | auctioneer's records, wallet reuse, delivery of the lot |
| bid funds-in-flight | bidder | auctioneer theft, key compromise, stranded notes |
| lot | seller | non-delivery, winner re-identification |
| settlement integrity | everyone | auctioneer mis-tally, truncation, artifact editing |

---

## 2. Adversaries

| # | adversary | capability | assumed honest? |
|---|---|---|---|
| A1 | curious observer | reads the chain, the artifacts, the website | — |
| A2 | chain analyst | global chain view, no viewing keys | — |
| A3 | auctioneer | spending key, full viewing key, controls publication | **no** |
| A4 | seller (= A3 or colluding) | can bid through a second wallet | **no** |
| A5 | losing bidder | wants to break privacy of others | **no** |
| A6 | auditor | pre-committed OVK, no spending key | yes-ish (collusion is A3+A6) |
| A7 | host / infra provider | sees disk, DB, logs, network | **no** |
| A8 | wallet vendor | sees the URIs the bidder scans | **no** |

---

## 3. Who sees what

| | A1 observer | A2 analyst | A3 auctioneer | A6 auditor | bidder |
|---|---|---|---|---|---|
| bid amount | no | no | all | outgoing only | own only |
| bidder identity | no | no | no¹ | no | own |
| bid → refund link | no | no | yes | yes | own |
| number of participants | tx count | tx count | yes | no² | no |
| clearing price | yes | yes | yes | yes | yes |
| inclusion proof | no | no | yes | no | own |
| full bid set | no (public mode: yes, post-settlement, via UFVK) | same | yes | no | no |

¹ unless the bidder puts an identifying label in the memo, reuses a known refund address, or claims
the lot afterwards.
² the OVK reveals outgoing flows; it does not reveal how much came in, so completeness requires IVK
or the published table.

---

## 4. Leak inventory

Severity: H = breaks the track's promise, M = degrades it, L = cosmetic.

| # | leak | sev | why | mitigation | residual |
|---|---|---|---|---|---|
| L1 | **Auctioneer sees every bid** | H | it holds the viewing key; this is the design | pre-committed OVK, public recomputation after settlement, named operator + bond | unavoidable while custody is trusted |
| L2 | **Auctioneer can take the money** | H | it holds the spending key; Zcash has no escrow | pre-committed OVK makes theft *provable*; bond; roadmap: FROST 2-of-3 | **theft is detectable, not preventable** |
| L3 | **Omission of a bid is undetectable in private mode** | H | inclusion proofs prove inclusion, never exclusion | public-tender mode: UFVK reveal exposes truncation to anyone; private mode: `\|leaves\| == tx count` invariant | private mode: only the bidder can prove it, by disclosing their own bid |
| L4 | **Number of bidders is public** | M | every bid is one transaction to the auction address | dummy self-transfers give plausible deniability | **dummies destroy the count check that detects L3 — pick one** |
| L5 | **Transparent-funded bids publish the amount** | H | a `t→z` tx reveals its input value | E4 rejection + check C9 | a rejected bid is still visible as an attempt |
| L6 | **Timing correlation** | M | bids cluster before the deadline; refunds in one block mark the cohort | batched refunds, single height | correlation of *when* you bid remains public |
| L7 | **Refund address links bids to each other** | M | same refund address twice = same bidder | UI: fresh address per bid | cannot be enforced |
| L8 | **UFVK disclosure is permanent for that account** | M | a viewing key reveals past *and future* notes of the account | one ephemeral account per auction, destroyed after | reuse of an auction account leaks the previous auction |
| L9 | **Memo plaintext includes the refund address** | M | the auctioneer learns a linkable address | fresh address, optional `label` warning | auctioneer retains it |
| L10 | **Delivery re-identifies the winner** | M | shipping an asset, signing a contract, transferring a domain | disclose on the auction page: privacy ends at settlement | unfixable in-protocol |
| L11 | **Host compromise (A7)** | H | keys and memos live on a server | minimal retention, no bid logs, encrypt at rest | a compromised host = L1 + L2 at once |
| L12 | **Network-level correlation** | M | IP of the bidder when broadcasting | out of scope: use Tor | not defended |
| L13 | **Fund origin correlation** | M | bid funded from a KYC exchange withdrawal | user hygiene; out of scope | not defended |
| L14 | **Dust / amount probing** | L | unusual bid sizes can fingerprint bidders | none | accepted |
| L15 | **Artifact editing after publication** | M | JSON on a website can be rewritten | hash + OpenTimestamps; UFVK recomputation | OTS proves existence, not that the site serves that file |
| L16 | **Aggregate accounting discloses volume** | M | an `in_zat` total reveals total demand — exactly what a competitor wants | not published: the artifact carries only refund and retained totals, both already public or OVK-visible; the verifier recomputes inflow | with very few notes, a published aggregate can still equal one bid; `refunded_zat` is visible to OVK holders by construction |

---

## 5. What the protocol can and cannot prove

| claim | provable? | mechanism |
|---|---|---|
| "my bid was counted with the right amount" | **yes** | inclusion proof against the published root |
| "the clearing price follows from the bid set" | **yes**, if the root is the published one | recomputation (`BLUEPRINT.md` §7) |
| "the published root covers all bids" | public-tender mode: **yes**; private: **no** | UFVK rescan; else tx count only |
| "every loser was refunded" | **yes** | OVK + exact-amount check C8/C9 |
| "the auctioneer could not have run away with the funds" | **no** | nothing on Zcash L1 prevents it |
| "the winner received the lot" | **no** | out of scope |

---

## 6. Trust assumptions (verbatim for the submission)

1. Custody is trusted: the auctioneer holds the spending key for the whole auction.
2. Refund correctness is auditable after the fact via an OVK committed before the first bid.
3. Clearing is deterministic and replayable; the artifacts commit to it.
4. In public-tender mode the UFVK is revealed at settlement, so anyone can recompute the auction.
   In private mode it is not, and completeness rests on the tx-count invariant plus the auctioneer's
   disclosure.
5. The auctioneer does not bid in its own auction. First-price clearing means a winning shill bid
   must actually pay, which is the only economic deterrent.
6. Delivery of the lot is off-chain and outside the protocol.

---

## 7. Claims we explicitly do **not** make

- "Trustless." Custody is trusted; only detection is cryptographic.
- "The auctioneer cannot withhold funds." It can; the withholding becomes provable.
- "Bidders are anonymous." Bids are confidential against observers. A bidder who reuses a refund
  address, funds from a transparent address, or claims the lot is linkable.
- "The number of participants is hidden." It is obfuscatable, and obfuscation costs the truncation
  check.
- "AI makes this objective." A model is not a clearing function: it is not replayable, it exposes
  every bid to a third-party API, and bid memos are attacker-controlled prompt input. AI belongs on
  the bidder's side (mandate, payment, proof verification), never in the custody or clearing path.

---

## 8. Implementation limits (disclosed, not hidden)

| limit | value | consequence |
|---|---|---|
| proof memo depth | 13 path elements (~4,096 bids) | deeper auctions need the proof published as a file |
| refund batch | one tx, subject to ZIP-225 size limits | larger auctions split into several txs; the verifier rejects more than one landing height |
| artifact format | canonical JSON, integers only | no floats anywhere; amounts are zatoshi |
| proof delivery | sent by the auctioneer in the refund batch | inherits L1/L2: a memo proves inclusion, and its arrival depends on a party you already have to trust for custody |
| duplicate note commitment | rejected outright | a buggy or lying scan cannot silently collapse two notes into one leaf |

---

## 9. Explicit trade-off: dummies vs. truncation detection

These two features are mutually exclusive, and pretending otherwise is the easiest way to be caught:

- **No dummy transfers** → the number of transactions to the auction address is meaningful, so
  `|leaves| == tx count` gives anyone a truncation alarm without any disclosure.
- **Dummy transfers** → participant count becomes meaningless, and with it the alarm. Truncation is
  then provable only by a bidder revealing their own bid.

Default: dummies **off** for public tenders (auditability wins), **on** only where the auction page
states in one sentence that omission becomes complaint-only.
