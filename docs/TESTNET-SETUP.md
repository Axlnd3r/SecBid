# Testnet setup (Zebra + Zallet on WSL2)

How to get from a Windows machine to a node and wallet that `secbid open --rpc` can talk to. This is
the setup for `BLUEPRINT.md` G1; the run itself (G2–G3) follows the checklist in
[`TESTNET.md`](TESTNET.md). Nothing here has been run yet: record each step's real output in
`TESTNET.md` as you go, including the failures.

Versions checked on 2026-10-27: **Zebra v7.0.0** (2026-10-22), **Zallet v0.1.0-beta.3**
(2026-08-26). Zallet is beta and changes often; if a key or flag below differs, the generated
`example-config` and `--help` output win over this file.

## Compatibility found on 2026-10-27 (read first)

Observed while installing on WSL2 Ubuntu 24.04, not taken from docs:

- NU7 activated on public Testnet at height 4,465,026 (Zebra 7.0.0-rc.0 release notes). Zebra 6.x
  cannot follow Testnet past it, so **Zebra ≥ 7.0.0 is required** on Testnet.
- Zebra 7 writes state format **v29**. The released Zallet `v0.1.0-beta.3` reads only v28 and
  refuses to start: `no zebra-state v28 database found under '~/.cache/zebra'`.
- NU7 / v29 support in Zallet is in an unmerged PR, [zcash/zallet#898](https://github.com/zcash/zallet/pull/898)
  (CI on head `8c5a93ba9d`: 26 passed, 3 failed). Until it is released, a Testnet run needs Zallet
  built from that commit. Record that in `TESTNET.md`: it is an unreleased wallet build.
  Build used on 2026-10-27 (~10 min on 6 cores; the binaries still report `0.1.0-beta.3`):

  ```bash
  sudo apt-get install -y build-essential clang libclang-dev protobuf-compiler pkg-config libssl-dev cmake
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
  git clone https://github.com/zcash/zallet ~/zcash/zallet-src && cd ~/zcash/zallet-src
  git fetch origin pull/898/head && git checkout 8c5a93ba9d68ad78d199c3624413c0139781b837
  (cd backends/zebra && cargo build --release --locked --features rpc-cli,zcashd-import)
  cargo build --release --locked -p zallet
  install -m 755 target/release/zallet backends/zebra/target/release/zallet-zebra ~/.local/bin/
  ```
- `zallet add-rpc-user` reads the password from the TTY, not stdin; run it in an interactive
  terminal.
- Testnet defaults to `[keystore] require_backup = true`: account derivation waits for the
  interactive `zallet confirm-backup`. For a disposable Testnet wallet, set `require_backup = false`
  explicitly; never on mainnet.
- `[builder.limits] orchard_actions` defaults to 50 per transaction, so Secbid's
  `--max-outputs 40` stays under it with room for change and padding.

## 0. Why WSL2, and the layout

- Zallet's platform table lists Windows as tier 3: *"No chain backend currently runs on Windows."*
  Zebra ships Linux binaries only. Both run inside WSL2 (Ubuntu 24.04, glibc 2.39, is fine).
- Zallet's `zebra` backend reads Zebra's state directory directly, so both must run in the **same
  WSL distro**, with state on the Linux filesystem (`~/…`), never under `/mnt/c` (slow, and file
  locking differs).
- Secbid stays on Windows (Node 24). WSL2 forwards `127.0.0.1` ports to Windows, so
  `--rpc http://127.0.0.1:28232` reaches Zallet. Use a password RPC user rather than the cookie,
  because the cookie file lives inside WSL.

| process | where | port (loopback only) |
|---|---|---|
| `zebrad` JSON-RPC (testnet) | WSL | `127.0.0.1:18232` |
| `zebrad` indexer gRPC | WSL | `127.0.0.1:8230` |
| `zallet` JSON-RPC | WSL | `127.0.0.1:28232` |
| `node src/cli.ts …` | Windows | — |

Testnet state is about 10 GB.

## 1. Zebra (WSL terminal 1)

```bash
mkdir -p ~/zcash && cd ~/zcash
V=7.0.0
curl -LO https://github.com/ZcashFoundation/zebra/releases/download/v$V/zebrad-$V-x86_64-unknown-linux-gnu.tar.gz
curl -LO https://github.com/ZcashFoundation/zebra/releases/download/v$V/zebrad-$V-x86_64-unknown-linux-gnu.tar.gz.sha256
sha256sum -c zebrad-$V-x86_64-unknown-linux-gnu.tar.gz.sha256
tar xzf zebrad-$V-x86_64-unknown-linux-gnu.tar.gz      # check where zebrad lands, then:
sudo install -m 755 <path/to>/zebrad /usr/local/bin/zebrad
zebrad --version

zebrad generate -o ~/.config/zebrad.toml
```

Edit `~/.config/zebrad.toml` (keep everything else at its default):

```toml
[network]
network = "Testnet"

[rpc]
listen_addr = "127.0.0.1:18232"
indexer_listen_addr = "127.0.0.1:8230"   # the indexer has no auth: loopback only
```

Start and wait for the tip:

```bash
zebrad start
```

Leave it running. Note `state.cache_dir` from the config (default `~/.cache/zebra`); Zallet needs
the absolute path.

## 2. Zallet (WSL terminal 2)

```bash
cd ~/zcash
Z=v0.1.0-beta.3
curl -LO https://github.com/zcash/zallet/releases/download/$Z/zallet-$Z-linux-amd64.tar.gz
tar xzf zallet-$Z-linux-amd64.tar.gz    # list the contents: you need `zallet` and its `zallet-zebra` backend
sudo install -m 755 <path/to>/zallet <path/to>/zallet-zebra /usr/local/bin/
zallet --version

D=~/.zallet-testnet
mkdir -p $D
zallet -d $D example-config -o $D/zallet.toml --this-is-beta-code-and-you-will-need-to-recreate-the-example-later
```

Edit `$D/zallet.toml`. The generated file documents every key in comments; the ones that matter:

```toml
[consensus]
network = "test"

[indexer]
validator_address = "127.0.0.1:18232"
validator_cookie_path = "/home/<you>/.cache/zebra/.cookie"   # Zebra's RPC cookie (on by default)

[indexer.read_state_service]
grpc_address = "127.0.0.1:8230"
zebra_state_path = "/home/<you>/.cache/zebra"   # absolute path, Zebra's state.cache_dir

[rpc]
bind = ["127.0.0.1:28232"]
```

Keys and the RPC user (the password is prompted, never in argv):

```bash
zallet -d $D generate-encryption-identity      # add -p for a passphrase-protected identity
zallet -d $D init-wallet-encryption
zallet -d $D generate-mnemonic                 # back up the output offline
zallet -d $D add-rpc-user secbid               # paste the printed [[rpc.auth]] block into zallet.toml
zallet -d $D start
```

Check sync from a third WSL terminal:

```bash
zallet -d ~/.zallet-testnet rpc getwalletstatus   # wait until wallet_tip reaches node_tip
```

Record `zebrad --version`, `zallet --version` and the `getwalletstatus` output in `TESTNET.md` (G1).

## 3. Secbid from Windows (PowerShell)

```powershell
# Windows PowerShell 5.1: prompt without echo, keep it out of history and argv
$s = Read-Host -AsSecureString 'zallet rpc password'
$env:SECBID_RPC_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))
$RPC = 'http://127.0.0.1:28232'
node src/cli.ts open --rpc $RPC --rpc-user secbid --name secbid-testnet-01 --network test `
  --pool auto --rule uniform --units 3 --reserve 0.1 --min-bid 0.05 `
  --deadline <tip + N> --ovk <64 hex> --out fixtures/testnet-01
```

`open --rpc` creates a fresh Orchard-only account, refuses a transparent receiver, and writes
`account.json`. The address it prints starts with `utest1`, and the bid memo template uses a
`utest1…` placeholder. A refund address from another network is classified
`stranded: refund_wrong_network` rather than breaking the refund batch.

Pick `--deadline` with time for bidders: testnet targets 75-second blocks, so 2 hours ≈ 96 blocks.

### The OVK input

Zallet exposes no OVK RPC (`OPEN-QUESTIONS.md` Q2), and Secbid never derives one. Whatever you
pass to `--ovk` is committed in `auction.json`, and C10 checks the settlement against that
commitment. Unless the hex is the account's real Orchard OVK, derived from the UFVK with a tool
you name in `TESTNET.md`, C10 proves only that the auctioneer did not swap keys, not that the
auditor can see the outgoing flows. Write down which one you did; do not imply the stronger claim.

## 4. Funding and bidders

- **Testnet coins (TAZ):** the Zcash docs say to ask in the Discord support channel or use a faucet.
  Faucet URLs change; check that one is up before relying on it.
- **Bidder wallets (G2 needs ≥ 2 different apps):** check each wallet's current testnet support
  and its handling of the ZIP-321 `memo` parameter on the day. Testnet may have had a network upgrade
  that consumer wallets do not follow yet. Candidates: Zashi, YWallet, Zingo! / `zingo-cli
  --chain testnet`. Record which app and version sent each bid. A wallet that drops the memo produces
  a `stranded` note, which belongs in the log too.
- Bid set for the run (`TESTNET.md` step 4): ≥ 5 bids, including one at the reserve, one below
  `--min-bid`, one after the deadline, and one from a transparent address if a wallet allows it.

Then: `scan` → `settle --rpc` → `verify` → independent `verify` from a copy → `npm run web`. All
of those are in `TESTNET.md`.

## Troubleshooting

| symptom | likely cause |
|---|---|
| `401` from Zallet | `[[rpc.auth]]` block not in `zallet.toml`, or `SECBID_RPC_PASSWORD` unset in this PowerShell |
| Windows cannot reach `127.0.0.1:28232` | Zallet bound inside WSL on another address; keep `bind = ["127.0.0.1:28232"]`; check `wsl --status` networking mode |
| Zallet backend will not start | `[indexer.read_state_service]` missing, wrong `zebra_state_path`, or Zebra's indexer not enabled |
| `getwalletstatus` says `"locked": true` | the wallet is still syncing (PR #898 build: `locked = !Synced`); balance and spend RPCs refuse until `wallet_tip` reaches `node_tip`. Not a passphrase lock unless the identity was made with `-p` |
| `scan` refuses an unmined note | wait for confirmations; this is deliberate (`ADAPTER.md` §6) |
| a chunk splits into two txids | lower `--max-outputs` and re-run (`ADAPTER.md` §5) |
