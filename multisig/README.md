# Single-Custodian Multisig Example

This example provides a simplified workflow for:

- deploying an Acki Nacki multisig wallet with a **single custodian**;
- transferring NACKL from the deployed multisig wallet.

It is intended for users who need a ready-to-use example for this specific setup.

The commands below assume you are in the directory containing the scripts.
You can invoke either script by path from another directory. By default, it
creates or reads `./msig-wallet` in your current directory, regardless of the
script's location. 

Pass `-d DIR` to both scripts to use another wallet directory.
The directory contains the wallet address, custodian keys, and seed phrase.
❗️ Keep the keys and seed phrase private and back them up securely.

Requirements: 
* Bash, `curl`, `tar`, `sed`, `tr`, and standard Unix utilities.
* The scripts use `tvm-cli` 3.0.6 or newer from your system, or download a
compatible version on supported platforms when needed. They also download
the contract ABI and TVC files when needed.

## Scripts

### `deploy-multisig.sh`

Deploys a multisig wallet configured with a single custodian.

Run:

```bash
./deploy-multisig.sh
```

Follow the script instructions.

The script saves the wallet address, custodian keys, and seed phrase in the
wallet directory. 
❗️ Use the same directory for subsequent transfers.

---

### `send-nackl.sh`

Transfers NACKL from the deployed multisig wallet to another Acki Nacki account.

Run:

```bash
./send-nackl.sh <DAPP_ID::ACCOUNT_ID> <AMOUNT>
```

Replace `<DAPP_ID::ACCOUNT_ID>` with the recipient address (two 64-character
hexadecimal IDs), and `<AMOUNT>` with the amount of NACKL (up to 9 decimal
places).

## Network

Without `-u`, both scripts use `mainnet.ackinacki.org`.

To use Shellnet, pass its endpoint to both commands:

```bash
./deploy-multisig.sh -u shellnet.ackinacki.org
./send-nackl.sh -u shellnet.ackinacki.org <DAPP_ID::ACCOUNT_ID> <AMOUNT>
```

❗️Use the same network for deployment and transfers. 

The scripts pass their
network endpoint directly to `tvm-cli`, so a network set in the global
`tvm-cli` configuration does not change their default.

## Notes

These scripts cover a **single-custodian use case only** and are provided as a practical example.

For other multisig configurations or a detailed explanation of the deployment process, refer to the full documentation:

[How to deploy a multisig wallet](https://dev.ackinacki.com/how-to-deploy-a-multisig-wallet)
