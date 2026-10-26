# The auction page

The public face of an auction: parameters, payment request, countdown by block height, uniform-price
result, leaf table, bond and pool facts, a quantum-exposure tab, a verifier runner, and a proof checker
that runs in the bidder's tab.

```bash
npm run web                     # http://127.0.0.1:4190
PORT=8080 npm run web
HOST=0.0.0.0 npm run web        # also reachable from a phone on the same network
```

No build step, no dependencies, no install. `scripts/serve-web.ts` is `node:http` plus `node:fs`,
exactly like the rest of `src/`. Fixtures are read-only.

`HOST=0.0.0.0` prints every LAN address it bound. The page itself works over plain HTTP on the LAN,
but the memo checker needs `crypto.subtle`, which browsers only expose on `localhost` or HTTPS — so
on a phone the QR, the artifacts, the verifier runner and the table all work, and the memo check
reports why it cannot run instead of failing silently.

| URL | What it returns |
|---|---|
| `/` | the page (one page per auction, `?a=<slug>`) |
| `/api/auctions` | index: honest auctions first, then the seven tampered ones |
| `/api/auction/:slug` | published artifacts + verification report |
| `/api/auction/:slug/report?mode=fixture\|audit` | report only |
| `?tip=<height>` | move the chain tip used by the countdown bar; artifacts stay post-settlement |

### Testing it by hand

1. `/` — hero, terminal card with `PASS`, entry rows, 14 check cards.
2. `/?a=t1-price` … `t7-pool` — the verdict flips to `FAIL`, and a different check is the first
   failure each time: C7 price, C5 truncation, C8 refund, C6 transparency (+C7), C11 two uniform
   prices, C13 bond spent early, C12 wrong pool.
3. `/?a=auction-02` — uniform 3-unit result, bond panel, published `leaves.json`, and the Quantum tab.
4. `?tip=<deadline_height - 5>` — the countdown reads open; `?tip=` past the deadline reads closed.
5. Verify panel → mode `audit` → C5–C10, C12 and C13 show `skip`, not a green tick; the verdict is
   `PARTIAL`.
6. Proof panel → `Load sample memo` → `OK`, then `Flip a byte` → `MISMATCH`.
7. Wallet tabs change the how-to; filter chips change the table; copy buttons show a live-region
   confirmation. Reloading with the network tab open shows no request carrying a bid amount.

The three routes the blueprint sketched (`/auction/:id`, `/result/:id`, `/proof/:leaf`) are one
document with anchors. Three routes would mean three copies of the same artifact fetch and three
loading states; the page is small enough that scroll position is the navigation.

## The privacy boundary is the API

`scan.json` holds bid amounts, refund addresses and memo plaintext — the exact things the auction
exists to hide. The server reads it to run the verifier and never serialises it. `buildPublicBundle()`
is a whitelist: parameters, settlement, commitments, inclusion paths, and the report. `tests/web.test.ts`
asserts the response contains no `scan`, `value_zat`, `memo_raw`, `refund_outputs` or note list.

The entry table therefore has no amount column, and no amount is recoverable from anything the page
receives. The Verifier section is the exception in presentation only: the report's `detail` strings
are the same ones the CLI prints, which is why a tampered fixture can show "computed refunded
3,000,000,000" — that number comes from the fixture's own fake chain, not from a real bid set.

`audit` mode is modelled honestly: the server drops the chain view, so C5–C10, C12 and C13 skip. A
stranger with only the published bundle cannot confirm the price, and the page says so instead of
showing a green tick it did not earn. `fixture` mode runs the full rescan server-side and reports
14/14 on both honest auctions.

## Design references, and what was taken from each

| Reference | Taken |
|---|---|
| **[xmcp.dev](https://xmcp.dev/)** | The shell: a pure-black canvas, centred logo in the nav with links to its left and a bordered field to its right, a badge pill above a centred display headline, one piece of artwork between the headline and the buttons, a filled white primary button next to an outlined one, and a "verifiable with" wordmark row where the reference puts its trusted-by logos. Mono is reserved for numbers and hashes. The hero artwork follows the reference's move — a large grain-rendered mark floating on black — rather than its actual asset: ours is drawn from the Secbid X and generated in the browser. |
| **[dark.design](https://www.dark.design/site/xmcp-1778330101992)** | The restraint. One accent, and it is white; no gradients on text, no glassmorphism, no grain, generous section padding, type doing the work instead of ornament. Dark-only, like both references. |
| **[scrolltide — focus reveal](https://www.scrolltide.co/#c-focus-reveal)** | The motion: content arrives out of focus (`blur(7px)`, 16px below, 0 opacity) and sharpens once as it enters the viewport, staggered 70ms per sibling, capped at 280ms. It runs once and never loops, so it cannot compete with data the reader is checking. |

What was deliberately not imported: perpetual parallax, marquees, cursor effects, scroll-jacking,
and animated counters. On a page whose job is to let someone check a Merkle root, motion that keeps
moving is a bug.

### The mark in the hero

The hero artwork is one inline SVG: four tapered arms and a core, blurred, then thresholded against
`feTurbulence` so the silhouette breaks into grain and sheds dust at its edges (`feComposite`
`arithmetic` + a discrete alpha step). It is deterministic — same seed, same speckles — costs a few
hundred bytes instead of a raster asset, scales with the viewport, and needs no extra request. The
filter is static; nothing in it animates.

### Motion contract

- `.reveal` is armed by JS only (`html.reveal-armed`), so a failed script leaves the page readable
  rather than blank.
- `IntersectionObserver` adds `.is-in`, then unobserves. Delay comes from `--d`, set per sibling.
- Terminal lines fade in at 55ms intervals, once.
- `prefers-reduced-motion: reduce` disables all of it: reveals are visible, terminal lines appear at once.
- Exactly one thing animates on a loop: the live pulse in the hero badge. Everything else settles
  and stops.

### Tokens

`web/assets/tokens.css` binds roles, not hex, so a future light theme re-binds aliases:

```
surface  --void, --surface-0/1/2, --surface-raised
ink      --ink, --ink-1/2/3
line     --line, --line-strong, --line-soft
signal   --accent (white), --accent-ink, --pass, --fail, --skip, --warn
type     --font-sans, --font-mono, --t-2xs … --t-display
space    --s-1 … --s-13 on a 4/8 scale
motion   --ease, --dur-1/2/3
```

Dark-only. The two references are dark-only and the product is a settlement terminal; a light theme
would need contrast re-measurement for every pill and pass/fail state, and that is not worth shipping
half-tested.

## Accessibility

- Status is never colour-only: every check card carries `pass` / `fail` / `skip` as text, every
  outcome pill carries its name, the verdict reads `PASS` or `FAIL`.
- Contrast on `#000`: `--ink` ≈ 18.8:1, `--ink-1` ≈ 10.1:1, `--ink-2` ≈ 6.1:1 — and `--ink-2` is the
  faintest token allowed to carry text, so every label clears AA 4.5:1 even at 9.5px. `--ink-3` is
  decoration only (dots, rules, bar fills) and the stylesheet never uses it for text. The white accent
  is 19:1 on black.
- `:focus-visible` gets a 2px white outline with offset; the copy buttons in the table row appear on
  focus, not only on hover.
- The copy confirmation is a live region (`aria-live="polite"`), not a tooltip.
- Tables keep `<caption>`, `<th scope="col">`; the QR and the hero artwork are `role="img"` with a
  `<title>`; the payment URI is always available as selectable text and a copy button, never QR-only.
- 390px wide: no horizontal overflow (checked in a real browser, not asserted by eye). The table
  scrolls inside its own container.

## The proof checker

`web/assets/proofcheck.js` is a port of `src/proof.ts` + `src/merkle.ts` onto WebCrypto, so a bidder
can verify their memo without sending it anywhere. It is deliberately isomorphic: `tests/web.test.ts`
imports it in Node, feeds it memos from the Node encoder, asserts the browser encoder produces
byte-identical output, and asserts both reject a flipped price and a truncated memo.

"Load sample memo" builds a real memo from the published settlement and inclusion path — the page
does not ship a canned string. "Flip a byte" mutates the encoded price by one zat, which is exactly
the class of lie an auctioneer would try.

## QR

`web/vendor/uqr.mjs` is [uqr](https://github.com/unjs/uqr) (MIT, vendored, ~27KB). A QR encoder is
not something to hand-roll in a weekend, and a runtime dependency would break the "no install step"
property the repo is built on. Rendering is one `<path>` of horizontal runs, so it is a single DOM
node and stays crisp at any zoom. During development the rendered path was rasterised and decoded
with jsQR; it returns the same string as `node src/cli.ts uri fixtures/auction-01`, byte for byte,
including the percent-encoded memo.

## What this page does not do

- No wallet connection, no deeplink execution, no signing. The page hands you a ZIP-321 request and
  a per-wallet how-to; the wallet does the rest.
- No live chain. `tip_height` is derived from the artifacts (`max(height) + 1`) unless overridden
  with `?tip=`; there is no scanner behind it yet.
- No writes. It serves fixtures. Creating and settling an auction happens in `src/cli.ts`
  (`secbid open`, `secbid settle`); copy the resulting directory under `fixtures/` and the page
  picks it up. Settlement is deliberately not a browser action: it needs the viewing key.
- No anonymised analytics, no fonts requested from a CDN, no third-party script. CSP is
  `default-src 'self'` and that is the whole list.
