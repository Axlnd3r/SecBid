# CLAUDE.md — instructions for coding agents working on Secbid

Read this file completely before touching code. Then read, in order:
`BLUEPRINT.md` (current v2 spec and task list), `docs/BLUEPRINT.md` (v1 design record),
`docs/THREAT-MODEL.md`, `docs/ADAPTER.md`.

## What this project is

Secbid: sealed-bid auctions on Zcash where **the bid is a shielded payment**. The auctioneer
settles off-chain with a deterministic clearing rule, refunds losers in batched shielded
transactions, and makes the result **publicly recomputable** from chain data. Target: Zecathon
2026, **Private Markets** track. Deadline is close — prefer finishing a phase over starting a new one.

## Hard rules (never break these)

1. **No runtime dependencies.** Node 24, TypeScript run via type stripping (`node src/cli.ts`).
   `package.json` has no `dependencies`. Dev-only `typescript` for `npm run typecheck` is allowed.
   Crypto = `node:crypto` (server/CLI) and WebCrypto (browser). No npm packages for hashing,
   Merkle trees, QR, or HTTP.
2. **Clearing is deterministic.** Same bid set + same params ⇒ byte-identical `settlement.json`.
   No `Date.now()`, no `Math.random()`, no locale-dependent sorting, no float money.
   Amounts are **zatoshi as `bigint`**, serialized as decimal strings.
3. **Canonical JSON only** for anything hashed (`src/canonical.ts`). Never `JSON.stringify` a
   hashed object directly.
4. **No AI/LLM in the auctioneer path.** Memos are attacker-controlled 512 bytes: parse them
   with a strict schema, never eval, never interpolate into prompts, shell, or HTML without escaping.
5. **Secrets never in argv or logs.** RPC password from `SECBID_RPC_PASSWORD` or cookie file.
   Spending keys never leave Zallet. The web server serves a **whitelist** of artifact fields;
   bid amounts are never in what the page receives.
6. **Do not overclaim.** Wording rules for docs and UI:
   - say "quantum-**recoverable**", never "quantum-proof" / "quantum-resistant";
   - say "auditable custody", never "trustless";
   - anything not run on testnet is labelled "tested against fake Zallet".
7. **Every new behavior ships with a test** in `tests/`. `npm test` must stay green after every
   task. Golden vectors in `tests/golden/` change only when the spec version is bumped.
8. **Feature flags over forks.** New behavior (Ironwood pool, uniform-price, bond, private mode)
   is selected by `auction.json` params with backward-compatible defaults, so `fixtures/auction-01`
   still verifies PASS unchanged.

## Commands

```bash
npm test                       # regenerate fixtures + all tests (must pass before you stop)
npm run typecheck              # optional, after: npm install --no-save typescript@5.9 @types/node
npm run web                    # http://127.0.0.1:4190
node src/cli.ts demo --out demo-out
node src/cli.ts verify <dir>   # prints PASS/PARTIAL/FAIL, exit 0/1
node src/cli.ts quantum-report <dir>
```

## How to work a task

1. Pick the next unchecked task in `BLUEPRINT.md` §9 (in order; phases are dependencies).
2. Read the files listed under the task. Do not refactor unrelated code.
3. Write the test first when the task lists acceptance criteria as commands or outputs.
4. Implement. Run `npm test`. Fix until green.
5. Tick the checkbox in `BLUEPRINT.md` §9 and add one line to `CHANGELOG.md`.
6. If a task needs a Zallet RPC method you have not seen in `docs/ADAPTER.md` or the fake wallet
   in `tests/`, **stop and write the question into `OPEN-QUESTIONS.md`** instead of guessing
   method names or response shapes.

## Code map

```
src/canonical.ts     canonical JSON + sha256 helpers (bigint-aware)
src/model.ts         internal types; all zatoshi amounts are bigint
src/serialize.ts     spec-1 (number) / spec-2 (decimal string) artifact codecs
src/leaf.ts          v1 leaf + v2 leaf with refund commitment and deterministic salt
src/merkle.ts        Merkle tree + inclusion proofs
src/memo.ts          strict memo v1/v2 parser + builder
src/eligibility.ts   which received notes are valid bids; qty + reuse flags
src/clearing.ts      first-price and uniform-price clearing (bigint)
src/settlement.ts    settlement artifacts + per-entry payments/refunds
src/refunds.ts       auditor transcript (refunds.json) + flow commitment
src/proof.ts         inclusion-proof memo (binary, 512-byte budget)
src/zip321.ts        payment request URIs
src/auction.ts       orchestration: open → scan → settle; refund plan + split
src/adapter.ts       ChainAdapter interface, pool capability, simulated chain
src/rpc.ts           JSON-RPC client
src/zallet.ts        Zallet adapter (Orchard; Ironwood unconfirmed)
src/verify.ts        checks C1..C14, PASS/PARTIAL/FAIL
src/bond.ts          auctioneer bond commitment + C13 recheck
src/quantum.ts       quantum exposure report
src/agent.ts         bidder-side mandate → ZIP-321 bid + memo check
src/cli.ts           CLI entrypoint
scripts/             fixture generator, web server
web/                 static auction page (no build step)
```
