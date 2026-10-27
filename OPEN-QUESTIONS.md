# Open questions

Agents: add a question here instead of guessing a wallet RPC method or response shape.

Current behavior for each item is fail-closed: the adapter refuses to guess, records the fallback in
`auction.json` when `--pool auto` is used, and the verifier treats an unconfirmed claim as a failure,
never a pass.

- [ ] Does the current Zallet release support creating an account in the Ironwood (quantum-recoverable)
      pool on testnet? Which RPC method/param? Until answered, `--pool auto` falls back to `orchard`
      and writes `pool_warning`; `--pool ironwood` fails with the adapter's reason.
- [ ] Does Zallet expose OVK for an account directly, or must it be derived from the UFVK?
      Until answered, `open` requires `--ovk <64 hex>` and `scan`/`settle` check it against the
      committed hash. The CLI never derives or invents an OVK.
- [ ] How does Zallet report the pool of a received note in `z_listreceivedbyaddress` / equivalent?
      The adapter currently reads `pool` from the transaction action when present; C12 fails closed
      if the account and admitted note pools disagree.
- [ ] Max outputs per transaction under NU7 per-block action limits — confirm a safe `--max-outputs`
      default. The default is 40 (`DEFAULT_MAX_OUTPUTS_PER_TX`), chosen conservatively; a live run
      should measure the wallet's ZIP-225 limit and replace it.
      Partial answer (2026-10-27): Zallet's `[builder.limits] orchard_actions` defaults to 50 per
      transaction (`zallet example-config`, v0.1.0-beta.3), so 40 outputs fit. Still unmeasured on a
      live send.
- [ ] Does `z_sendmany` preserve output order, or return one txid that cannot be mapped to a chunk?
      The adapter requires one txid per call and refuses a wallet-internal split; lower
      `--max-outputs` and retry instead of guessing which output landed where.
