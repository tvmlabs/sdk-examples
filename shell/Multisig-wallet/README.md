# Multisig deployment and NACKL transfer (shell)

`deploy-multisig.sh` deploys a single-custodian `ExchangeMultisigWallet` with `tvm-cli`. `send-nackl.sh` transfers NACKL from that wallet. The wallet directory format is shared with the [Node.js scripts](../../js/nodejs/Multisig-wallet/README.md).

## Requirements

- Bash, `curl`, `tar`, `sed`, and `tr`.
- `tvm-cli` 3.0.6 or newer. The scripts use `TVM_CLI` if set, then a compatible `tvm-cli` on `PATH`, or download version `3.0.6.an` into `~/.cache/acki-nacki-scripts`. Automatic downloads support Linux x86_64/arm64 and macOS arm64; on other platforms, install a compatible CLI and set `TVM_CLI`.
- Network access to the selected Acki Nacki endpoint and, if needed, to download `tvm-cli` and the wallet contract.

The scripts default to `mainnet.ackinacki.org`. Set `ACKI_ENDPOINT` or pass `-u`/`--url` to select a different endpoint. `ACKI_CACHE_DIR` changes the download cache; `TVM_CLI_VERSION` changes the CLI version downloaded.

## Deploy a wallet

From the repository root:

```sh
cd shell/Multisig-wallet
./deploy-multisig.sh
```

For Shellnet, use `./deploy-multisig.sh -u shellnet.ackinacki.org`. The script generates a key pair, seed phrase, and wallet address in `./msig-wallet`, then asks you to fund the address. Send at least **0.5 SHELL converted to VMSHELL (flag 16)** to the displayed address; VMSHELL pays deployment and transaction fees. You can send NACKL to the address before or after deployment. Press Enter after funding so the script can check the balance and deploy. It can resume with the same directory if you quit or the deployment is interrupted.

The directory contains `msig.keys.json`, `msig.seed`, `msig.addr`, and the `ExchangeMultisigWallet` ABI and TVC. Back up the seed phrase offline; anyone with it can control the wallet. The script checks the wallet contract code hash before deployment.

Use `-d DIR` to choose another wallet directory and `-m N` to change the minimum VMSHELL balance required before deployment. Run `./deploy-multisig.sh --help` for all options.

## Send NACKL

Run from the same directory and select the same network used for deployment:

```sh
# Mainnet
./send-nackl.sh '<DAPP_ID::ACCOUNT_ID>' 1.5

# Shellnet
./send-nackl.sh -u shellnet.ackinacki.org '<DAPP_ID::ACCOUNT_ID>' 1.5
```

Replace the quoted placeholder with the recipient's address; both IDs must contain 64 hexadecimal characters. The amount is in NACKL and supports up to nine decimal places. The script checks the wallet code, custodian key, NACKL balance, and VMSHELL gas balance before asking for confirmation. An uninitialized recipient can receive NACKL; a nonexistent recipient is accepted only when its two address IDs are equal.

`send-nackl.sh` reads the wallet nonce and calls `submitTransaction`. It waits up to a minute for the recipient's balance to increase. If the CLI reports an uncertain send or the recipient balance does not update, check the wallet nonce and recipient balance before retrying: the transfer may already have been delivered. A nonce refusal (exit code 127) is reported separately.

Use `-d DIR` for another wallet directory, `-w ADDRESS` and `-k FILE` to provide a wallet and custodian keys explicitly, or `-y` to skip the confirmation prompt. Run `./send-nackl.sh --help` for all options.
