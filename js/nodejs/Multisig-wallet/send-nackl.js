#!/usr/bin/env node
//
// Transfers NACKL from a multisig wallet (a single-custodian
// UpdateCustodianMultisigWallet_v2, e.g. one deployed by deploy-multisig.js
// or deploy-multisig.sh) to the given address, with tvm-sdk-js.

"use strict";

const fs = require("fs");
const path = require("path");
const c = require("./common");

// VMSHELL reserve for gas: a transfer costs about 0.015.
const MIN_GAS = 50_000_000n;

const usage = () => `Usage: ${path.basename(__filename)} [options] <RECIPIENT> <AMOUNT>

Transfers NACKL from a multisig wallet to the recipient address.

  RECIPIENT               address in the DAPP_ID::ACCOUNT_ID form
  AMOUNT                  amount of NACKL, up to 9 decimal places (e.g. 1.5)

  -u, --url ENDPOINT      network (default: $ACKI_ENDPOINT or mainnet.ackinacki.org)
  -d, --dir DIR           wallet directory created by deploy-multisig.js or .sh
                          (default: ./msig-wallet)
  -w, --wallet ADDRESS    wallet address DAPP_ID::ACCOUNT_ID (instead of DIR/msig.addr)
  -k, --keys FILE         custodian key file (instead of DIR/msig.keys.json)
  -y, --yes               do not ask for confirmation before sending
  -h, --help              show this help

Environment:
  TVMSDK_ADDON      path to a tvmsdk.node built from tvm-sdk 3.0+
                    (default: addon/<platform>-<arch>/tvmsdk.node next to this
                    script, then the one inside @tvmsdk/lib-node)
  ACKI_CACHE_DIR    where to download the ABI if the wallet directory has none
                    (default: ~/.cache/acki-nacki-scripts)`;

function parseArgs(argv) {
    const opts = { endpoint: c.DEFAULT_ENDPOINT, dir: "./msig-wallet", args: [] };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const value = () => (i + 1 < argv.length ? argv[++i] : c.die(`${arg}: missing value`));
        switch (arg) {
            case "-u":
            case "--url":
                opts.endpoint = value();
                break;
            case "-d":
            case "--dir":
                opts.dir = value();
                break;
            case "-w":
            case "--wallet":
                opts.wallet = value();
                break;
            case "-k":
            case "--keys":
                opts.keys = value();
                break;
            case "-y":
            case "--yes":
                opts.yes = true;
                break;
            case "-h":
            case "--help":
                opts.help = true;
                break;
            case "--":
                opts.args.push(...argv.slice(i + 1));
                i = argv.length;
                break;
            default:
                if (arg.startsWith("-")) {
                    console.error(`Unknown option: ${arg}\n\n${usage()}`);
                    process.exit(2);
                }
                opts.args.push(arg);
        }
    }
    return opts;
}

// Strict DAPP_ID::ACCOUNT_ID form; legacy forms are rejected explicitly.
function checkAddress(what, address) {
    if (/^[0-9a-f]{64}::[0-9a-f]{64}$/.test(address)) return;
    if (/^-?\d+:[0-9a-f]{64}$/.test(address) || /^[0-9a-f]{64}$/.test(address)) {
        c.die(`${what} ${address} uses a legacy format: specify the address as DAPP_ID::ACCOUNT_ID`);
    }
    c.die(`${what} ${address}: expected an address in the DAPP_ID::ACCOUNT_ID form (64 hex characters each)`);
}

async function main() {
    process.umask(0o077);
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
        console.log(usage());
        return 0;
    }
    if (opts.args.length !== 2) {
        console.error(usage());
        return 2;
    }

    const dest = opts.args[0].toLowerCase();
    checkAddress("recipient", dest);
    const amountText = opts.args[1];
    const amount =
        c.toNano(amountText) ??
        c.die(`invalid amount '${amountText}': a positive number with at most 9 decimal places is required`);

    let wallet = opts.wallet;
    if (!wallet) {
        const addrFile = path.join(opts.dir, "msig.addr");
        if (!c.nonEmpty(addrFile)) {
            c.die(`there is no wallet in ${opts.dir}: deploy one with deploy-multisig.js or pass --wallet and --keys`);
        }
        wallet = fs.readFileSync(addrFile, "utf8").split("\n")[0].trim();
    }
    wallet = wallet.toLowerCase();
    checkAddress("wallet", wallet);
    const keysFile = opts.keys ?? path.join(opts.dir, "msig.keys.json");
    if (!c.nonEmpty(keysFile)) c.die(`key file ${keysFile} not found`);
    const keys = c.readKeys(keysFile);
    if (dest === wallet) c.die("the recipient is the sending wallet itself");

    const { client, version } = await c.createClient(opts.endpoint);
    let abiFile = path.join(opts.dir, `${c.MSIG}.abi.json`);
    if (!c.nonEmpty(abiFile)) {
        fs.mkdirSync(c.CACHE_DIR, { recursive: true });
        abiFile = path.join(c.CACHE_DIR, `${c.MSIG}.abi.json`);
        await c.ensureContract(abiFile);
    }
    const abi = c.loadAbi(abiFile);
    c.info(`Network: ${opts.endpoint}, tvm-sdk: ${version}`);

    const fetchAccount = (address, what) =>
        c.fetchAccount(client, address).catch((err) => c.die(`failed to get the ${what} state: ${err.message}`));

    // The wallet must be deployed, run the expected contract, and have our key
    // as its only custodian (otherwise sendTransaction is rejected).
    const walletId = wallet.split("::")[1];
    const from = await fetchAccount(wallet, "wallet");
    if (from.type !== "Active") c.die(`wallet ${wallet} is not deployed (state: ${from.type})`);
    if (from.codeHash !== c.MSIG_CODE_HASH) c.die(`${wallet} is not a ${c.MSIG} (code hash ${from.codeHash})`);

    let custodians;
    try {
        const { message } = await client.abi.encode_message({
            abi,
            address: `0:${walletId}`,
            call_set: { function_name: "getCustodians", input: {} },
            signer: { type: "None" },
        });
        const { decoded } = await client.tvm.run_tvm({ message, account: from.boc, abi });
        custodians = decoded.output.custodians;
    } catch (err) {
        c.die(`failed to get the wallet custodians: ${err.message}`);
    }
    if (custodians.length !== 1) {
        c.die("the wallet has several custodians: this script supports single-custodian wallets only");
    }
    if (BigInt(custodians[0].owner_pubkey) !== BigInt(`0x${keys.public}`)) {
        c.die(`key ${keysFile} is not a custodian of wallet ${wallet}`);
    }

    if (from.nackl < amount) {
        c.die(`the wallet holds ${c.fmtNano(from.nackl)} NACKL, cannot send ${c.fmtNano(amount)}`);
    }
    if (from.balance < MIN_GAS) {
        c.die(
            `the wallet holds ${c.fmtNano(from.balance)} VMSHELL, not enough for gas (at least ${c.fmtNano(MIN_GAS)} is required). ` +
                "Top it up with SHELL converted to VMSHELL (flag 16)",
        );
    }

    // The recipient. The transfer is addressed by account_id (dest = 0:ACCOUNT_ID),
    // and a missing account is created in its own dapp (DAPP_ID == ACCOUNT_ID).
    const [destDapp, destAcc] = dest.split("::");
    const to = await fetchAccount(dest, "recipient");
    let bounce;
    switch (to.type) {
        case "Active":
            bounce = true;
            break;
        case "Uninit":
            bounce = false;
            console.log("Warning: the recipient is not deployed yet (Uninit); the NACKL will stay on its address.");
            break;
        case "NonExist":
            if (destDapp !== destAcc) {
                c.die(
                    `account ${dest} does not exist. Check the address: you can send to an existing account or to a new address of the form ID::ID`,
                );
            }
            bounce = false;
            console.log(`Warning: account ${dest} does not exist yet; the transfer will create it (Uninit).`);
            break;
        default:
            c.die(`the recipient is ${to.type}, the transfer is not possible`);
    }

    console.log(`
From:    ${wallet}
         NACKL: ${c.fmtNano(from.nackl)}, VMSHELL: ${c.fmtNano(from.balance)}
To:      ${dest} (${to.type})
Amount:  ${c.fmtNano(amount)} NACKL
`);
    if (!opts.yes) {
        const reply = await c.ask("Send? Type yes: ");
        if (reply.toLowerCase() !== "yes") {
            console.log(`Transfer cancelled: expected 'yes', got '${reply}'.`);
            return 1;
        }
    }

    c.info("Sending the transfer");
    // The transfer must run exactly once: a new message is sent only after the
    // previous one has expired without a transaction.
    const tx = await c.sendReliably(client, {
        abi,
        accountId: walletId,
        dappId: wallet.split("::")[0],
        encode: (expire) =>
            client.abi.encode_message({
                abi,
                address: `0:${walletId}`,
                call_set: {
                    function_name: "sendTransaction",
                    header: { expire },
                    input: {
                        dest: `0:${destAcc}`,
                        value: 0,
                        cc: { [c.ECC_NACKL]: amount.toString() },
                        bounce,
                        flags: 1,
                        payload: "",
                        dapp_id: `0x${destDapp}`,
                    },
                },
                signer: { type: "Keys", keys },
            }),
    });
    c.info(`Wallet transaction: ${tx.id}`);

    // Crediting the recipient is a separate transaction: wait for it up to a minute.
    const expected = to.nackl + amount;
    let received = to.nackl;
    for (let i = 0; i < 20; i++) {
        received = await c.fetchAccount(client, dest).then((a) => a.nackl, () => received);
        if (received >= expected) break;
        await c.sleep(3000);
    }
    if (received >= expected) {
        console.log(`Done: the recipient received ${c.fmtNano(amount)} NACKL, its balance is ${c.fmtNano(received)} NACKL.`);
        return 0;
    }
    console.log(`The transfer was sent, but the recipient has not received the NACKL within a minute (balance: ${c.fmtNano(received)}).`);
    console.log("Check the balance later and do not resend the transfer until you know the outcome.");
    return 1;
}

c.run(main);
