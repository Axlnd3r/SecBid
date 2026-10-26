# Testnet run log

**Status: not run.** There is no live testnet auction yet and no txid is published in this
repository. Everything described as "live" in `CLAUDE.md`, `README.md` and the tests is
**tested against fake Zallet** (`tests/helpers/fake-zallet.ts`), which reproduces the JSON-RPC
shapes in `docs/ADAPTER.md`.

This file exists so the gap is visible instead of being implied by the demo output. When a run
happens, append a section with the exact chain-visible facts and keep the failure log, not just
the happy path.

## Checklist for the first run

Do these in order and record the command, height and txid for each:

1. **Wallet setup.** Zallet on `testnet`, account `secbid-a1`, spend authority held by that node.
   Record `Zallet` version, `getwalletinfo` output (redact paths), and the account UUID.
2. **Pool.** Try `open --pool auto` and record which pool the adapter reported. If Ironwood is
   unavailable, record the warning text and the Orchard fallback — do not edit the artifact by
   hand. See `docs/OPEN-QUESTIONS.md` Q1.
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

## Wording for the submission

Until the checklist is complete, say:

> Settlement, refunds and proof memos are implemented and tested against fake Zallet. The
> testnet run is pending; no txids are claimed.

After it is complete, link the txids and say "run on Zcash testnet on <date>". Never describe a
fake-Zallet run as a testnet run.
