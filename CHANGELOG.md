# Changelog

All notable changes to Secbid. The current spec is v2; spec-1 fixtures remain valid and verify
unchanged.

## v2 — implementation

- **Spec 2 artifacts.** `spec`, `rule`, `units`, `pool`, `mode`, `bond` and `pool_warning` in
  `auction.json`, with spec-1 defaults. Amounts are `bigint` zatoshi internally and decimal strings
  in spec-2 JSON; `src/serialize.ts` is the only codec.
- **Memo/leaf v2.** Strict memo schema with `qty`, v1 compatibility, refund commitment with a
  deterministic domain-separated salt, and outcome-bound leaves. Golden vectors in `tests/golden/`.
- **Uniform-price clearing.** Multi-unit allocation, marginal partial fill, one clearing price for
  every winner, and excess refunds. First-price remains the default for spec 1.
- **Batched refunds.** Deterministic chunking, one target height, duplicate-address isolation,
  per-leaf transaction assignment, and a refusal when an adapter reuses a txid for two chunks.
- **Auditable custody.** Bond terms committed before the first bid (`bond record|show`, check C13)
  and private mode with an auditor transcript (`refunds.json`, check C14).
- **Quantum posture.** Pool capability with a recorded Orchard fallback, refund-address reuse
  detection, and `quantum-report` with a fixed "recoverable ≠ post-quantum" disclaimer. The
  published report fingerprints refund addresses rather than naming them.
- **Verifier.** Fourteen checks (C1–C14), `PASS` / `PARTIAL` / `FAIL`, audit mode that skips
  chain-dependent checks instead of passing them, and seven tamper fixtures each failing its own
  check. C7 now also binds the settlement's auction id, rule, units and deadline, and recomputes a
  spec-2 first-price winner's payment.
- **Bidder agent.** `agent bid` builds a ZIP-321 request from a strict mandate; `agent check`
  verifies an inclusion-proof memo. No network and no model in the auctioneer or clearing path.
- **Web page.** Uniform results, bond/pool facts, a Quantum tab, a 14-check verifier runner, and a
  browser proof checker. The public API remains a whitelist: no scan, account, memo or bid amount.
- **Documentation.** `BLUEPRINT.md` v2 task list, `docs/TESTNET.md` (honest gap: not run yet),
  refreshed `docs/ADAPTER.md` and `docs/WEB.md`, and the open wallet questions with fail-closed
  behavior.

- **Testnet readiness.** Address checks recognise testnet/regtest prefixes (`utest1`,
  `ztestsapling1`, `uviewtest1`); a refund address on another network than the auction is
  `stranded: refund_wrong_network`; ZIP-321 memos are base64url without padding, as the ZIP
  requires. Setup runbook in `docs/TESTNET-SETUP.md`. Tested against fake Zallet.

- **Web fixes from a browser pass.** Re-running the verifier on another artifact set now repaints
  the terminal panel too: picking a tampered set used to leave the honest set's `RESULT: PASS`
  above a FAIL verdict. Transcript builder moved to `web/assets/transcript.js` (tested from Node).
  The hero auction-id badge no longer overflows the gutter at phone width.

- **Hero and motion, closer to the references.** The hero art is now a dithered scene generated in
  the browser (`web/assets/hero-art.js`): the X is an auction gavel crossed with a bolt of light,
  developed once on load, then still. Hovering it reads the mark through scan lines with a lens that
  bends the rows around the cursor (after xmcp.dev's footer mark); the frame loop runs only while
  the pointer moves. Fixed the hammer head being clipped at the top of the canvas. Headings get a word-by-word focus reveal with a travelling
  camera frame (`web/assets/focus.js`, after scrolltide's description). xmcp-style label + squared
  chip badge (`auction … [TESTNET · SETTLED]`) and square buttons. Nothing loops any more (the badge
  pulse is gone); reduced motion shows everything at once.
- **Ironwood on testnet.** `--pool ironwood|auto` with `--network test` now opens an Ironwood
  auction: under NU6.3 an Orchard receiver's payments land in the Ironwood pool, so the account
  uses the same Orchard-only address. Found during the testnet run, where the old Orchard default
  would have failed C12. Main/regtest still fall back to Orchard (OPEN-QUESTIONS Q1).
- **First testnet run (G1, G3; G2 partial).** `fixtures/testnet-01/`: uniform 3-unit Ironwood
  auction, 6 bids, clearing price 0.11 TAZ, one refund tx, PASS 14/14. Log in `docs/TESTNET.md`.
- **Demo script.** `docs/DEMO-SCRIPT.md`: 2:50 narration with honest testnet/demo labelling.
- **Demo film.** `web/film.html` (+ `assets/film.{css,js}`): the storyboard as a seekable 1080p
  browser animation — halftone crowds, dissolving faces, CCTV tracking boxes, typed terminal scenes
  with real testnet output. No libraries; served under the existing CSP. Opens on a title card,
  explains open → bid → settle → verify in one scene, then keeps a chapter rail on screen. Three
  generated archival-style stills and clips (`web/assets/film/`, Higgsfield) with a drawn fallback;
  plaza tracking boxes follow the people in each video frame; the close folds three trust spheres
  (contract, TEE, FHE) into one. 3:00. The web server now answers
  single byte-range requests (206/416) and serves `.mp4`, so the film can seek in video.
- **2-minute cut.** `film.html?cut=2` (1:57): every scene keeps parts of its own timeline, some sped
  up, with one shorter narration line per scene; the full 3:00 film is unchanged.
- **Sandbox (`web/sandbox.html`).** Anyone can open an auction, place bids (incl. late, transparent and
  memo-less ones), settle, run the 14 checks, cheat three ways and watch a named check fail, and check a
  bidder proof. `src/sandbox.ts` drives the real open → settle → refund → verify path on a simulated
  chain; the browser runs it type-stripped from `src/` (`scripts/strip-lib.ts`) with Buffer and sha256
  shims. `tests/browser-lib.test.ts` holds the browser build byte-identical to the TypeScript source.
- **Static deploy.** `npm run build:static` renders every public API answer from the real server into
  `site/` (relative paths, `.nojekyll`) for GitHub Pages; `web/assets/static-api.js` maps API paths
  onto those files only when the page is marked static. Tested in `tests/static.test.ts`.

## Verification

`npm test` regenerates fixtures and runs the full suite (111 tests at the time of writing). Typecheck
is optional because the runtime uses Node type stripping. A real testnet run is still pending; see
`docs/TESTNET.md`.
