# Multisig deploy and NACKL transfer (tvm-sdk-js)

JavaScript versions of `deploy-multisig.sh` and `send-nackl.sh`, built on
[tvm-sdk-js](https://github.com/tvmlabs/tvm-sdk-js). They behave like the bash
scripts and use the same wallet directory layout, so either version can
continue the other's work. Unlike the bash scripts, they make sure a message is
executed exactly once (see [How messages are sent](#how-messages-are-sent)).

## Requirements

- Node.js 18 or newer.
- `npm install` in this directory (`@tvmsdk/core`, `@tvmsdk/lib-node`).
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
./build-addon.sh ../tvm-sdk-js                # branch feature/update-to-tvm-sdk-3.0.6
./build-addon.sh ../tvm-sdk-js <REF>          # any other git ref
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

```sh
node deploy-multisig.js -u shellnet.ackinacki.org            # wallet in ./msig-wallet
node send-nackl.js -u shellnet.ackinacki.org <DAPP_ID::ACCOUNT_ID> 1.5
```

Run either script with `--help` for all options.

## How messages are sent

A reply from the node is not enough to know what happened to a message: the
reply can be lost after the message was accepted, and an accepted message can
end up in a block that is never finalized. Sending again blindly could run a
transfer twice. `sendReliably` in `common.js` therefore sends the deployment and
the transfer like this:

1. Encode the message with an explicit expiration time (the `expire` ABI
   header), 60 seconds ahead. The contract rejects the message after that time.
2. Send it with `processing.send_message`.
3. Look for the message's transaction in the database, by the transaction hash
   the node returned and by the message hash (the only way after a failed
   send). A transaction with the `Finalized` status is the result.
4. While there is none, poll the newest finalized block of the account's
   thread. Once its `gen_utime` is past the expiration time, look for the
   transaction one last time. If it is still missing, the message can no longer
   be executed, so encode a new one and go back to step 2 (three messages at
   most).

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
| Block time and status | `block(hash) { gen_utime status_name thread_id }` |
| Account's latest transaction | `account(account_id, dapp_id) { transactions(last: 1) { nodes { id } } }` |

Lists return only hashes; `block(hash)` and `transaction(hash)` return the
details.
