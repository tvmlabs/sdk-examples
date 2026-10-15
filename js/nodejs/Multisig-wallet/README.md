# Multisig deploy and NACKL transfer (tvm-sdk-js)

`deploy-multisig.js` and `send-nackl.js` use
[tvm-sdk-js](https://github.com/tvmlabs/tvm-sdk-js) to deploy a single-custodian
`ExchangeMultisigWallet` and transfer NACKL. They share the wallet directory
layout with the [shell scripts](../../../shell/Multisig-wallet/README.md). Use
`-d DIR` with both implementations to point them at the same wallet. The Node.js
scripts check transaction finality before retrying a message (see
[How messages are sent](#how-messages-are-sent)).

## Requirements

- Node.js 18 or newer.
- `npm ci` in this directory (`@tvmsdk/core`, `@tvmsdk/lib-node`).
- A `tvmsdk.node` addon built from **tvm-sdk 3.0 or newer**.
- System CA certificates: tvm-sdk checks TLS certificates against the system
  store and cannot connect without it. On Linux, install the `ca-certificates`
  package (minimal container images lack it) or set `SSL_CERT_FILE` to a CA
  bundle.

The published `@tvmsdk/lib-node` 2.0.2 ships no addon binary, and its sources
are pinned to tvm-sdk `v2.24.9.an`, which speaks the pre-dapp_id protocol that
current nodes reject. The scripts check the addon version and stop if it is
older than 3.0.

## Building the addon

The tvm-sdk-js branch `feature/update-to-tvm-sdk-3.0.6` builds `lib-node`
against tvm-sdk 3.0.6 on stable Rust and Node.js 22.

### Linux, for distribution

`build-addon.sh` builds the addon from a tvm-sdk-js checkout in a Debian 11
Docker container, so it runs on any Linux with glibc 2.31 or newer, and writes
it to `addon/linux-<arch>/tvmsdk.node`:

```sh
bash build-addon.sh /path/to/tvm-sdk-js        # branch feature/update-to-tvm-sdk-3.0.6
bash build-addon.sh /path/to/tvm-sdk-js REF    # another git ref
```

It needs Docker and builds for the architecture Docker runs on. The first
build takes 10–15 minutes; caches in `~/.cache/acki-nacki-scripts/addon-build`
make later ones faster.

### Any platform, by hand

From the tvm-sdk-js branch, with Rust and a C++ compiler installed:

```sh
cd packages/lib-node/lib
cargo build --release && cp target/release/libtvmsdk.a .
npx node-gyp rebuild        # produces build/Release/tvmsdk.node
```

Then put `build/Release/tvmsdk.node` in one of the places listed below. An
addon built this way needs at least the glibc version of the build machine.

## Where the scripts look for the addon

1. `TVMSDK_ADDON=/path/to/tvmsdk.node`, if set.
2. `addon/<platform>-<arch>/tvmsdk.node` next to the scripts, where
   `<platform>-<arch>` is Node.js's `process.platform` and `process.arch`, such
   as `linux-x64` or `darwin-arm64`. Put prebuilt addons here to ship them with
   the scripts.
3. `node_modules/@tvmsdk/lib-node/tvmsdk.node`.

The first file found is used; if it fails to load (for example, it needs a
newer glibc than the system has), the scripts stop instead of trying the next
one.

## Usage

From the repository root, enter `js/nodejs/Multisig-wallet` and run `npm ci`.
The included `addon/linux-x64/tvmsdk.node` is used automatically on Linux
x64; other platforms need a compatible addon from the build instructions above.
By default, the scripts use Acki Nacki Mainnet (`mainnet.ackinacki.org`).
Set `ACKI_ENDPOINT` or pass `-u`/`--url` to select another endpoint.

**Mainnet**

Run the scripts without specifying a network:

```sh
# Deploy a multisig wallet (files saved to ./msig-wallet)
node deploy-multisig.js

# Send 1.5 NACKL to the specified address
node send-nackl.js '<DAPP_ID::ACCOUNT_ID>' 1.5
```

**Shellnet (Test Network)**

Use `-u shellnet.ackinacki.org` to run the scripts on Shellnet:

```sh
# Deploy a multisig wallet (files saved to ./msig-wallet)
node deploy-multisig.js -u shellnet.ackinacki.org

# Send 1.5 NACKL to the specified address
node send-nackl.js -u shellnet.ackinacki.org '<DAPP_ID::ACCOUNT_ID>' 1.5
```

The deployment script creates keys, a seed phrase, an address, an ABI, and a TVC
in `./msig-wallet`. It shows the address to fund; send at least 0.5 SHELL
converted to VMSHELL (flag 16), then confirm the funding prompt. VMSHELL pays
deployment and transfer fees. Back up the seed phrase offline and keep the
wallet directory private. A later run with the same directory resumes the
deployment.

Replace the quoted `<DAPP_ID::ACCOUNT_ID>` placeholder with the recipient's
address (two 64-character hexadecimal IDs). The amount is in NACKL and supports
up to nine decimal places. `send-nackl.js` checks the wallet, its custodian key,
and balances, then asks for confirmation. A nonexistent recipient is accepted
only if its two address IDs are equal.

Both scripts support `-d DIR` for another wallet directory. Deployment supports
`-m N` for a different minimum VMSHELL balance. Sending supports `-w ADDRESS`,
`-k FILE`, and `-y` to choose a wallet, key file, or skip confirmation. Run
either script with `--help` for all options.

## How messages are sent

A reply from the node is not enough to know what happened to a message: the
reply can be lost after the message was accepted, and an accepted message can
end up in a block that is never finalized. Sending again blindly could run a
transfer twice. `sendReliably` in `common.js` therefore sends the deployment and
the transfer like this:

1. Encode the message with an explicit expiration time (the `expire` ABI
   header), 60 seconds ahead. The contract rejects the message after that time.
2. Send it with `processing.send_message`.
3. Look for the message's transaction in the database by message hash and,
   when provided, by the transaction hash returned by the node. A transaction
   with the `Finalized` status is the result.
4. While there is none, poll the newest finalized block of the account's
   thread. Once its `gen_utime` is past the expiration time, look for the
   transaction one last time. If it is still missing, the message can no longer
   be executed, so encode a new one and go back to step 2 (three messages at
   most).

The wallet contract, `ExchangeMultisigWallet`, adds its own protection for
transfers: `submitTransaction` takes a nonce and executes only with the one that
follows `getNonce()`. `send-nackl.js` reads the nonce once and puts the same
value into every message of a transfer, so at most one of them can execute.

Two refusals settle a message at once, without waiting for it to expire:

- Exit code 52, replay protection: the message is not newer than one the
  wallet has already accepted, so it can never be executed. A new message is
  sent right away.
- Exit code 127 from `submitTransaction`: the nonce is not the next one, and it
  never will be. `send-nackl.js` stops and reads the wallet's nonce to tell
  whether another transfer has already used it or the nonce skips ahead. The
  nonce read right after the refusal can lag behind, so a value below ours is
  read again for up to 10 seconds.

The thread comes from the node's reply, or from the block of the account's
latest transaction when the reply has none. If the outcome cannot be established
(the thread produces no newer block, or GraphQL is unreachable for two minutes
past the expiration time), the script stops and says so instead of sending
again. The expiration time is taken from the local clock, so the clock has to
be roughly right.

The GraphQL queries involved (`blockchain { ... }`), sent with `net.query`:

| Purpose | Query |
| --- | --- |
| Transaction by hash | `transaction(hash) { id status_name aborted compute { exit_code } }` |
| Transaction by message | `message(hash) { dst_transaction { ... } }` |
| Newest blocks of a thread | `blocks(thread_id, last: 3) { nodes { hash } }` |
| Block time and status | `block(hash) { gen_utime status_name }` |
| Thread of the account's latest transaction | `block(hash) { thread_id }` |
| Account's latest transaction | `account(account_id, dapp_id) { transactions(last: 1) { nodes { id } } }` |

Lists return only hashes; `block(hash)` and `transaction(hash)` return the
details.
