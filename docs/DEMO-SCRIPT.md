# Demo video script (3:00)

Goal for the judges, in one breath: **in Secbid every bidder is invisible — to the public, to the
other bidders, even to the auctioneer — and anyone can still recompute who won.** Every scene below
serves that sentence.

Narration is ~450 words at ~145 words/minute. Scenes marked **[testnet]** use the real run in
`fixtures/testnet-01/` (PASS 14/14 on 2026-10-28; txids in `docs/TESTNET.md`). The bids in that run
came from Zallet accounts, so show the txid and memo, not a phone wallet scanning the QR.

Wording rules (CLAUDE.md §6): "auditable custody", never "trustless"; "quantum-recoverable", never
"quantum-proof". Privacy claims must match the README privacy table:

| say | do not say |
|---|---|
| bidder identity is never revealed, not even to the auctioneer | "everything is private" |
| amounts are sealed until the deadline; afterwards they are published for audit, never tied to a name | "amounts are never known" (public-tender mode publishes them) |
| the auctioneer is the one party who cannot hide — that is why they can be held to account | "the auctioneer is anonymous" (bond and accountability depend on them being known) |

---

## Visual language (from the four references)

| ref | what it does | where we use it |
|---|---|---|
| **1** documentary collage (evolution of money) | B&W archival photos on paper grain; cut-out hands and objects; a **single serif word alone on a blank page**; green digit rain; objects evolving one into the next | Act 1: what Secbid is for and who uses it |
| **2** portrait grid | wall of archival mugshots; faces **dissolve into dither dots**; thin network lines join faces; small red tracking boxes; zoom out to thousands, back in to four | Act 2: the bidder cannot be identified |
| **4** overhead CCTV plaza | top-down people on a white plaza; **red tracking boxes with tiny labels**; RGB-split edges; frame edge breaks into pixel blocks | Act 2: the chain observer sees nothing useful |
| **3** typographic transitions | **slot-roll numbers** (1960→1970); bold sans words sliding behind a cut-out object; giant serif numeral with depth blur; **word-by-word grey→black reveal**; **yellow highlighter sweep** over newsprint; letter-scramble on dark; **line-drawn Venn circles** | all on-screen text; Act 3 data; the comparison |

Palette: paper off-white `#ECEAE4`, ink `#111`, grain overlay; accent **tracking red** `#E5322D`;
one **highlighter yellow** `#F4E64B` for the single fact per scene; terminal scenes on near-black with
Secbid's existing web palette. Type: a high-contrast serif for single words, a grotesk for labels.

---

## Act 1 — What Secbid is for (0:00–0:54) · ref 1 + ref 3

### 0. Title — 0:00–0:06
**Screen:** generated archival still of an auction hall (paddles raised, no faces), slow push-in; title
*Secbid*, line *Sealed-bid auctions where the bid is a shielded Zcash payment.*, footer
`run on zcash testnet · verify PASS 14/14`.

> This is Secbid: sealed-bid auctions on Zcash, where the bid is a shielded payment.

### 1. Sealed bids, always trusted to someone — 0:06–0:26
**Screen:** B&W auction-house photo, paddles raised → cut-out hand slides a wax-sealed envelope across
a desk → blank paper page, one serif word: *sealed.* → page: *trusted.* → green digit rain
(a transparent chain) → page: *visible.*

> Every sealed-bid market runs on one promise: your competitors must not see your number. For a
> century, a middleman kept that promise. On a transparent blockchain, nobody can — every bid is
> visible the moment it's placed.

### 2. Who needs it — 0:26–0:46
**Screen:** four archival clips, one per card (3.5 s each) with title and one line: a trading desk
*(OTC block sale)* → an official opening sealed tenders *(procurement)* → coins being counted
*(token sale)* → a committee reading a letter *(grant allocation)*. Then the title card, word-by-word
reveal (ref 3): **"The bid is a shielded payment."** Captions are pinned one line per card.

> OTC desks selling a block of ZEC without moving the market. Procurement offices, where suppliers
> must not see each other’s price. Token sales, with one clearing price for every winner. Grant
> committees choosing the best offer, privately. Secbid gives them a sealed-bid auction where the bid
> **is** a shielded Zcash payment. No special app, no smart contract, no reveal step.

### 2b. How it works — 0:46–0:54
**Screen:** four numbered steps on a line — Open, Bid, Settle, Verify — each with one sentence. From
here on a chapter rail (top right) lights the current step.

> It works in four steps: open, bid, settle — and anyone can verify.

## Act 2 — Nobody can see who you are (0:54–1:34) · ref 2 + ref 4

### 3. The observer sees nothing — 0:54–1:12  **[testnet]**
**Screen:** overhead plaza (ref 4); red tracking boxes lock onto walking figures, labels flicker:
`sender: —` `amount: shielded` `memo: encrypted`. Cut to the real testnet bid txid on screen, same
red box around it, same three labels.

> Here's a real bid on Zcash testnet. The chain records that a shielded transaction happened. No
> sender. No amount. No memo. A watcher learns nothing.

### 4. Even the auctioneer can't see who you are — 1:12–1:34
**Screen:** portrait grid (ref 2) of six bidders; network lines connect them; a red box hops face to
face and each face **dissolves into dots** as the box lands; label `UNKNOWN`. Zoom out to thousands of
dissolved faces. Then one figure is **lit and sharp** — the auctioneer — with labels `bond posted`,
`custody`, `accountable`.

> And here's the part that matters: not the public, not the other bidders — **not even the
> auctioneer** learns who you are. They see a payment and a one-time refund address. Nothing more.
> The only one who can't hide is the auctioneer. That's exactly why you can hold them to account.

## Act 3 — And anyone can check the result (1:34–2:38) · ref 3 + terminal

### 5. Settlement — 1:34–1:56  **[testnet]**
**Screen:** slot-roll counter (ref 3) runs the block height up to the deadline `4,549,558`, then the
real `settle` output; the clearing price slot-rolls `0.14 → 0.12 → 0.11`. Yellow highlighter sweeps
`refunds 5 outputs in 1 tx`.

> At the deadline, the auctioneer runs a deterministic clearing rule. Three units, uniform price:
> every winner pays the same 0.11. Losers — and winners' overpayment — are refunded in one shielded
> transaction.

### 6. "Did my bid count?" — 1:56–2:12
**Screen:** a bidder's proof memo → `OK`. One byte flips (letter-scramble, ref 3) → red `FAIL`.

> Each refund carries a Merkle inclusion proof. The bidder checks it and knows their bid was counted.
> Change one byte, and it fails.

### 7. Anyone can recompute it — 2:12–2:38  **[testnet]**
**Screen:** `verify fixtures/testnet-01` — the 14 checks appear one by one, highlighter on
`PASS (14/14)`. Then a tampered fixture: one check turns red with its name.

> This is the core difference. Anyone can replay the auction from chain data: same bids, same rules,
> byte-identical result. Fourteen public checks, all passing on testnet. Drop one bid, and the
> verifier names exactly which check fails. A dishonest auctioneer doesn't just look bad — they get
> caught.

## Act 4 — Honest about limits, then close (2:38–3:00)

### 8. Trust model + quantum — 2:38–2:50
**Screen:** `quantum-report` with highlighter on `6/6` and on the disclaimer line (keep it whole).

> We're precise about trust: custody is auditable, not trustless, and a bond makes cheating costly.
> All six testnet bids sat in Zcash's new Ironwood pool — quantum-recoverable, and we say exactly
> that, not "quantum-proof".

### 9. Close — 2:50–3:00
**Screen (ref 5):** three soft lit spheres on black — *Smart contract* (bids go public at reveal), *TEE*
(trust the chip vendor), *FHE* (trust the key holders) — drift together and fold into one sphere:
*Secbid — one shielded payment · anyone recomputes*. Then **Check it yourself.** under a highlighter,
and the repo URL.

> Today a private auction asks you to trust something: a contract that reveals every bid, a chip
> vendor, or the holders of a key. Secbid folds that into one shielded payment that anyone can
> recompute. Check it yourself.

---

## Comparison card (optional, after scene 7)

| | Typical private auction | Secbid |
|---|---|---|
| How you bid | special app, token, or contract + reveal | **one shielded payment, any wallet** |
| Who sees the bidder | operator / contract | **nobody, not even the auctioneer** |
| Can the operator lie? | you trust them | **anyone recomputes; a lie fails a named check** |
| Did my bid count? | you trust them | **inclusion proof in your refund memo** |
| Operator runs off? | escrow, or nothing | **bond + auditable custody** |

## 2-minute cut (`film.html?cut=2`, 1:57)

The submission form asks for two minutes. The cut keeps parts of every scene (some sped up, never the
terminal output itself) and uses one shorter line per scene; captions follow these lines. Read at an
easy pace, about 100 words a minute:

| # | line |
|---|---|
| 0 | Secbid: sealed-bid auctions on Zcash, where the bid is a shielded payment. |
| 1 | A sealed bid only works if your competitors can’t see your number. On a transparent chain, every bid is visible. |
| 2 | OTC block sales. Procurement tenders. Token sales. Grant allocation. In Secbid the bid is one shielded Zcash payment — no app, no contract, no reveal. |
| 2b | Open, bid, settle — and anyone can verify. |
| 3 | This is a real testnet bid. The chain shows no sender, no amount, no memo. |
| 4 | Not the public, not other bidders — not even the auctioneer learns who you are. The auctioneer is the one who can’t hide, so they can be held to account. |
| 5 | At the deadline a deterministic rule clears the auction: one price for every winner, and refunds in one shielded transaction. |
| 6 | Every refund carries an inclusion proof. Flip one byte and it fails. |
| 7 | Anyone can replay the auction from chain data: fourteen checks pass on testnet. Drop one bid, and the verifier names the check that fails. |
| 8 | Custody is auditable, not trustless, and all six bids sit in the quantum-recoverable Ironwood pool. |
| 9 | No contract, chip or key holder to trust. Check it yourself. |

## Playing the film

The whole storyboard above is built as a browser animation: `npm run web`, then open
<http://127.0.0.1:4190/film.html>. It is 1920×1080, 3:00, and every terminal
line is real output from `fixtures/testnet-01` and `fixtures/tamper/t2-truncate`. Imagery in
`web/assets/film/` was generated for this film with Higgsfield: archival-style stills with Soul Cinema
(auction hall, auctioneer, envelope, tender box, six identity portraits, four use-case photos, the plaza)
and short clips animated from those stills with Seedance 1.5 Pro. The plaza tracking boxes are found
on the people in each video frame. Every still and clip has a drawn fallback, so the film still plays
without them.

| key | action |
|---|---|
| `Space` | play / pause |
| `1`–`9` | jump to scene |
| `←` `→` | ±5 s |
| `R` | restart |
| `C` | captions on/off (burned-in narration) |
| `H` | timer overlay |

Record: open `film.html?cut=2` for the two-minute version (plain `film.html` is the 3:00 cut). F11 fullscreen, `Win+Alt+R` to start/stop (Xbox Game Bar), then add the voice-over in
Clipchamp. `?t=<seconds>` opens at a given time for retakes.

## Recording checklist

- Terminal font ≥ 18 pt, dark theme, 1920×1080; the animation is built 1920×1080 too.
- Run every command once before recording so nothing is slow on camera.
- Keep the disclaimer line of `quantum-report` fully visible.
- Testnet scenes: show real txids from `fixtures/testnet-01/`, nothing typed by hand.
- Use only images we have rights to: our own renders, public-domain archival photos, or generated
  silhouettes — not frames from the reference videos.
