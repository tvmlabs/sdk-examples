#!/usr/bin/env node
//
// Deploys a single-custodian Acki Nacki multisig wallet
// (UpdateCustodianMultisigWallet_v2) with tvm-sdk-js.
//
// Flow: download the contract if needed -> generate keys and compute the
// address -> ask the user to top the address up and wait for confirmation ->
// check the balance -> deploy -> verify the result.
//
// Keys and the seed phrase are saved to the wallet directory (mode 600).
// Re-running with the same directory resumes where it stopped: keys are reused
// (if they are missing but the seed phrase is there, they are restored from
// it), and an already deployed wallet is just reported. The directory layout
// is the same as for deploy-multisig.sh, so either script can continue the
// other's work.

"use strict";

const fs = require("fs");
const path = require("path");
const c = require("./common");

const MIN_BALANCE_DEFAULT = "0.5";

const usage = () => `Usage: ${path.basename(__filename)} [-u ENDPOINT] [-d DIR] [-m VMSHELL]

Deploys a single-custodian multisig wallet. During the deployment the script
shows the address to top up and waits for your confirmation.

  -u, --url ENDPOINT      network (default: $ACKI_ENDPOINT or mainnet.ackinacki.org)
  -d, --dir DIR           wallet directory: keys, seed phrase, address, ABI and TVC
                          (default: ./msig-wallet)
  -m, --min-balance N     VMSHELL that must arrive at the address before deploying
                          (default: ${MIN_BALANCE_DEFAULT})
  -h, --help              show this help

Environment:
  TVMSDK_ADDON      path to a tvmsdk.node built from tvm-sdk 3.0+
                    (default: addon/<platform>-<arch>/tvmsdk.node next to this
                    script, then the one inside @tvmsdk/lib-node)`;

function parseArgs(argv) {
    const opts = { endpoint: c.DEFAULT_ENDPOINT, dir: "./msig-wallet", minBalance: MIN_BALANCE_DEFAULT };
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
            case "-m":
            case "--min-balance":
                opts.minBalance = value();
                break;
            case "-h":
            case "--help":
                opts.help = true;
                break;
            default:
                console.error(`Unknown option: ${arg}\n\n${usage()}`);
                process.exit(2);
        }
    }
    return opts;
}

async function main() {
    process.umask(0o077);
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
        console.log(usage());
        return 0;
    }
    const minBalance = c.toNano(opts.minBalance) ?? c.die(`invalid --min-balance value: ${opts.minBalance}`);

    const dir = path.resolve(opts.dir);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const abiFile = path.join(dir, `${c.MSIG}.abi.json`);
    const tvcFile = path.join(dir, `${c.MSIG}.tvc`);
    const keysFile = path.join(dir, "msig.keys.json");
    const seedFile = path.join(dir, "msig.seed");
    const addrFile = path.join(dir, "msig.addr");

    const { client, version } = await c.createClient(opts.endpoint);
    await c.ensureContract(abiFile, tvcFile);
    await c.checkTvc(client, tvcFile);
    const abi = c.loadAbi(abiFile);
    const tvc = fs.readFileSync(tvcFile).toString("base64");
    c.info(`Network: ${opts.endpoint}, tvm-sdk: ${version}`);

    // A seed phrase without keys: restore the keys from the phrase instead of
    // generating new ones, otherwise the phrase would no longer match the wallet.
    if (!c.nonEmpty(keysFile) && fs.existsSync(seedFile)) {
        c.info(`No keys found, deriving them from the seed phrase in ${seedFile}`);
        let keys;
        try {
            keys = await c.deriveKeys(client, fs.readFileSync(seedFile, "utf8").trim());
        } catch {
            // The SDK error is not printed: it may quote the phrase.
            c.die(`failed to derive keys from the seed phrase in ${seedFile}: the phrase is empty or corrupted`);
        }
        c.writeFileAtomic(keysFile, c.keysJson(keys));
    }

    let keys;
    if (c.nonEmpty(keysFile)) {
        c.info(`Using keys from ${keysFile}`);
        if (!c.nonEmpty(seedFile)) {
            console.log(`Warning: there is no seed phrase file ${seedFile}; make sure you have a backup of the phrase.`);
        }
        keys = c.readKeys(keysFile);
    } else {
        c.info("Generating custodian keys");
        const { phrase } = await client.crypto.mnemonic_from_random({
            dictionary: c.DICTIONARY_ENGLISH,
            word_count: c.WORD_COUNT,
        });
        keys = await c.deriveKeys(client, phrase);
        // The phrase is saved before the keys: if saving the keys fails, the
        // next run restores them from the phrase.
        try {
            c.writeFileAtomic(seedFile, `${phrase}\n`);
        } catch (err) {
            c.die(`failed to save the seed phrase to ${seedFile}: ${err.message}`);
        }
        c.writeFileAtomic(keysFile, c.keysJson(keys));
        console.log(`
=============================== SEED PHRASE ===============================
${phrase}
===========================================================================
The seed phrase is saved to ${seedFile}, the keys to ${keysFile}
(readable by the owner only). Make an offline backup of the phrase and never
send or show it to anyone: it gives full access to the wallet.
`);
    }

    // ABI 2.4 contracts take the initial public key from the initial data.
    const deploySet = { tvc, workchain_id: 0, initial_data: { _pubkey: `0x${keys.public}` } };
    const { address } = await client.abi.encode_message({
        abi,
        deploy_set: deploySet,
        signer: { type: "External", public_key: keys.public },
    });
    const id = address.replace(/^0:/, "");
    if (!/^[0-9a-f]{64}$/.test(id)) c.die("failed to compute the wallet address");
    const addr = `${id}::${id}`;
    fs.writeFileSync(addrFile, `${addr}\n`);

    // Is the account ready to deploy (or already deployed)?
    const funded = (acc) => acc.type === "Active" || (acc.type === "Uninit" && acc.balance >= minBalance);
    const checkDeployable = (acc) => {
        if (!["NonExist", "Uninit", "Active", "Unknown"].includes(acc.type)) {
            c.die(`account ${addr} is ${acc.type}, the wallet cannot be deployed`);
        }
    };
    const fetchState = () => c.fetchAccount(client, addr).catch((error) => ({ type: "Unknown", error }));

    let acc = await fetchState();
    if (acc.type === "Unknown") c.die(`failed to get the state of account ${addr}: ${acc.error.message}`);
    checkDeployable(acc);
    if (!funded(acc)) {
        console.log(`
Wallet address:          ${addr}
Transfer destination:    0:${id}  (dapp_id: ${id})

Top up this address: send at least ${opts.minBalance} SHELL converted to VMSHELL
(flag 16). VMSHELL pays for gas: the deployment costs about 0.16, the rest is
kept for the fees of future transfers. Unconverted SHELL cannot pay for gas.
NACKL can be sent to this address either now or after the deployment.
`);
        for (;;) {
            const reply = await c.ask("Press Enter once the transfer is sent (q to quit): ");
            if (reply.toLowerCase() === "q") {
                console.log(`The keys, seed phrase and address are saved in ${dir}.`);
                console.log("To continue, run the script again with the same directory (-d).");
                return 0;
            }
            // A transfer takes a few seconds to arrive: wait for it up to 30 seconds.
            c.info("Checking the balance");
            for (let i = 0; i < 10; i++) {
                acc = await fetchState();
                checkDeployable(acc);
                if (funded(acc)) break;
                await c.sleep(3000);
            }
            if (funded(acc)) break;
            if (acc.type === "Unknown") {
                console.error(acc.error.message);
                console.log("Failed to get the account state, please try again.");
            } else if (acc.type === "NonExist") {
                console.log("The transfer has not arrived yet.");
            } else {
                console.log(`The address holds ${c.fmtNano(acc.balance)} VMSHELL, at least ${opts.minBalance} is required.`);
                if (acc.shell > 0n) {
                    console.log(`${c.fmtNano(acc.shell)} SHELL arrived unconverted and cannot pay for gas.`);
                    console.log("Send SHELL again, converted to VMSHELL (flag 16).");
                }
            }
        }
    }

    if (acc.type === "Uninit") {
        c.info(`Balance is ${c.fmtNano(acc.balance)} VMSHELL, deploying the wallet`);
        // A deployment message that expires without a transaction is sent again.
        const tx = await c.sendReliably(client, {
            abi,
            accountId: id,
            dappId: id,
            encode: (expire) =>
                client.abi.encode_message({
                    abi,
                    deploy_set: deploySet,
                    call_set: {
                        function_name: "constructor",
                        header: { expire },
                        input: {
                            owners_pubkey: [`0x${keys.public}`],
                            owners_address: [],
                            reqConfirms: 1,
                            reqConfirmsData: 1,
                            value: 0,
                            minBalance: 0,
                            targetBalance: 0,
                        },
                    },
                    signer: { type: "Keys", keys },
                }),
        });
        c.info(`Deployment transaction: ${tx.id}`);
        for (let i = 0; i < 10; i++) {
            acc = await fetchState();
            if (acc.type === "Active") break;
            await c.sleep(3000);
        }
    } else {
        c.info("The wallet is already deployed");
    }

    if (acc.type !== "Active") {
        c.die(`the wallet did not become active (state: ${acc.type}). Run the script again with the same directory`);
    }
    if (acc.codeHash !== c.MSIG_CODE_HASH) c.die(`a different code is deployed at ${addr} (${acc.codeHash})`);

    const seedNote = c.nonEmpty(seedFile) ? `${seedFile} (keep it secret)` : "no file; keep your own backup of the phrase";
    const sendScript = path.relative(process.cwd(), path.join(__dirname, "send-nackl.js")) || "send-nackl.js";
    console.log(`
The wallet is deployed.
  Address:  ${addr}
  VMSHELL:  ${c.fmtNano(acc.balance)}
  NACKL:    ${c.fmtNano(acc.nackl)}
  Keys:     ${keysFile} (keep them secret)
  Phrase:   ${seedNote}

To transfer NACKL:
  node ${sendScript} -u ${opts.endpoint} -d "${dir}" <DAPP_ID::ACCOUNT_ID> <AMOUNT>`);
    return 0;
}

c.run(main);
