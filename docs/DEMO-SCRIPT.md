# Demo video script (≈ 2:50)

Goal for the judges, in one breath: **Secbid is a sealed-bid auction where the bid is a single
shielded Zcash payment, and anyone can recompute who won.** Every scene below serves that sentence.

Narration is ~400 words at ~145 words/minute. Scenes marked **[testnet]** use the real run in
`fixtures/testnet-01/` (PASS 14/14 on 2026-10-28; txids in `docs/TESTNET.md`). The bids in that run
came from Zallet accounts, so show the txid and memo, not a phone wallet scanning the QR.

Wording rules (CLAUDE.md §6): "auditable custody", never "trustless"; "quantum-recoverable", never
"quantum-proof".

---

### 1. The problem — 0:00–0:20
**Screen:** auction page hero (`npm run web`), then one line of text: *"Your competitors must not see
your number."*

> Every sealed-bid market runs on one promise: your competitors must not see your number. OTC block
> sales, procurement tenders, token sales. Today a middleman keeps that promise. On a transparent
> chain, nobody can. And private auctions that do exist ask you to trust their server, their TEE, or
> their FHE coprocessor.

### 2. The idea — 0:20–0:40
**Screen:** title card *"The bid is a shielded payment."* Then the auction page with its QR.

> Secbid flips that. In Secbid, the bid **is** a shielded Zcash payment. No special app, no wrapped
> token, no smart contract, no reveal step. You scan a QR code in any Zcash wallet and pay. That
> payment is your bid.

### 3. Bidding — 0:40–1:05  **[testnet]**
**Screen:** a bid being sent (ZIP-321 URI + memo), then the transaction on a testnet explorer.

> Here's a bidder paying on Zcash testnet. The memo carries the quantity and a one-time refund
> address. On chain, the world sees that a shielded transaction happened. No amount. No sender.
> Other bidders learn nothing.

### 4. Settlement — 1:05–1:30
**Screen:** `node src/cli.ts settle …` output: clearing price, winners, refund batch txids.

> After the deadline, the auctioneer scans with the viewing key and runs a deterministic clearing
> rule. This is a three-unit uniform-price auction: every winner pays the same clearing price.
> Losers, and winners' overpayment, are refunded automatically in batched shielded transactions.

### 5. "Did my bid count?" — 1:30–1:50
**Screen:** bidder checks the proof memo → OK. Flip one byte → caught.

> Each refund memo carries a Merkle inclusion proof. The bidder checks it and knows their bid was
> counted. Change a single byte, and it fails.

### 6. Anyone can recompute the result — 1:50–2:20  **[testnet]**
**Screen:** `node src/cli.ts verify fixtures/testnet-01` → PASS 14/14. Then a tampered fixture →
a named FAIL check.

> This is the core difference. Anyone can replay the auction from chain data. Same bids, same rules,
> byte-identical result. Fourteen public checks. Here it passes. Now we drop one bid, and the verifier
> names exactly which check fails. A dishonest auctioneer doesn't just look bad, they get caught.

### 7. Honest trust model — 2:20–2:40
**Screen:** `node src/cli.ts quantum-report …`, then a slide: *auditable custody · bond · not trustless*.

> We're precise about trust. Secbid is not trustless; the auctioneer holds custody. But misbehaviour
> is detectable, and with a pre-committed bond it's costly. And because bid privacy has to last for
> years, Secbid reports exactly what a future quantum adversary could expose. In our testnet run,
> all six bids sat in Zcash's new Ironwood pool: quantum-recoverable, and we say exactly that, not
> "quantum-proof".

### 8. Close — 2:40–2:50
**Screen:** comparison table (below), then logo + repo URL.

> Secbid: one shielded payment to bid, one command to verify. Private markets, on Zcash.

---

## Comparison slide (scene 8)

| | Typical private auction | Secbid |
|---|---|---|
| How you bid | special app, token, or contract + reveal | **one shielded payment, any wallet** |
| Contracts / bridges | yes | **none** |
| Can the operator lie? | you trust them | **anyone recomputes; a lie fails a named check** |
| Did my bid count? | you trust them | **inclusion proof in your refund memo** |
| Operator runs off? | escrow, or nothing | **bond + auditable custody** |

## Recording checklist

- Terminal font ≥ 18 pt, dark theme, window 1920×1080.
- Run every command once before recording so nothing is slow on camera.
- Keep the disclaimer line of `quantum-report` fully visible.
- Testnet scenes: show real txids from `fixtures/testnet-01/`, nothing typed by hand.
