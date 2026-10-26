# Vendored files

`uqr.mjs` — [uqr](https://github.com/unjs/uqr) v0.1.2, MIT, by Anthony Fu. Fetched from
`https://cdn.jsdelivr.net/npm/uqr@0.1.2/dist/index.mjs` and committed unmodified.

Vendored rather than installed so the repository keeps its "no install step, no dependencies"
property: the page is served by `node:http` with no build, and this is the only third-party code in
`web/`. It is used for one thing — encoding the ZIP-321 payment request into the QR on the auction
page — through `web/assets/qr.js`.

Upgrading: replace the file, then decode the rendered QR with any independent decoder and compare
against `node src/cli.ts uri fixtures/auction-01`.
