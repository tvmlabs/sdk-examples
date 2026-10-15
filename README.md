# TVM SDK examples

Examples for deploying contracts and sending tokens on Acki Nacki networks.

| Example | What it does | Guide |
| --- | --- | --- |
| Shell multisig | Deploys a single-custodian `ExchangeMultisigWallet` and transfers NACKL with `tvm-cli` | [Shell multisig](shell/Multisig-wallet/README.md) |
| Node.js multisig | Performs the same wallet operations with `tvm-sdk-js`, with transaction finality checks and retry handling | [Node.js multisig](js/nodejs/Multisig-wallet/README.md) |
| Node.js HelloWorld | Legacy contract deployment and method-call example | [Node.js HelloWorld](js/nodejs/helloWorld/README.md) |
| Rust HelloWorld | Legacy contract deployment and method-call example | [Rust HelloWorld](rust/helloWorld/README.md) |

The multisig examples default to Acki Nacki Mainnet. Pass `-u shellnet.ackinacki.org` to use Shellnet. Both use `./msig-wallet` relative to the directory where you run them. Pass `-d DIR` to point both implementations at the same wallet files. Keep the generated keys and seed phrase private. See the individual guides for dependencies, funding, and transfer commands.
