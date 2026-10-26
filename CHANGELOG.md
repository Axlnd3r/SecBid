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

## Verification

`npm test` regenerates fixtures and runs the full suite (102 tests at the time of writing). Typecheck
is optional because the runtime uses Node type stripping. A real testnet run is still pending; see
`docs/TESTNET.md`.
