// Shared helpers for deploy-multisig.js and send-nackl.js: tvm-sdk-js setup,
// contract download, account state, amounts and prompts.

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");

const MSIG = "UpdateCustodianMultisigWallet_v2";
const MSIG_URL =
    "https://raw.githubusercontent.com/ackinacki/ackinacki/df524923ef1d2892bf93d239914e94276826d196/contracts/0.81.0_compiled/updatecustodianmultisigwallet_v2";
const MSIG_CODE_HASH = "cfcaac10d43c8dc062298cb48df097be67cddec52b9cfd558309a7549f01c1f1";
const CACHE_DIR =
    process.env.ACKI_CACHE_DIR ||
    path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "acki-nacki-scripts");
const DEFAULT_ENDPOINT = process.env.ACKI_ENDPOINT || "mainnet.ackinacki.org";

// The same derivation as tvm-cli, so a seed phrase restores the same keys in
// both tools and wallet directories are interchangeable with the bash scripts.
const HD_PATH = "m/44'/1331'/0'/0/0";
const WORD_COUNT = 12;
const DICTIONARY_ENGLISH = 1;

// The v3 wire format (account_id + dapp_id) first shipped in tvm-sdk 3.0.0.
const SDK_MIN = "3.0.0";
const ECC_NACKL = 1;
const ECC_SHELL = 2;
const NANO = 1_000_000_000n;
// tvm_client net error code for a missing account.
const ERR_NOT_FOUND = 622;

class UserError extends Error {}

function die(message) {
    throw new UserError(message);
}

function info(message) {
    console.log(`==> ${message}`);
}

// Runs the async main of a script and turns its outcome into an exit code.
function run(main) {
    main().then(
        (code) => process.exit(code ?? 0),
        (err) => {
            console.error(err instanceof UserError ? `Error: ${err.message}` : err);
            process.exit(1);
        },
    );
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- prompts ---

let lines;

// Prints the prompt and reads one line from stdin with surrounding whitespace
// trimmed. A single reader serves all prompts, so piped answers are not lost.
async function ask(prompt) {
    lines ??= readline.createInterface({ input: process.stdin, terminal: false })[Symbol.asyncIterator]();
    process.stdout.write(prompt);
    const { value, done } = await lines.next();
    if (done) die("input closed, no confirmation received");
    return value.trim();
}

// --- amounts: nano units as BigInt ---

function toNano(text) {
    const m = /^(\d*)(?:\.(\d{0,9}))?$/.exec(String(text).replace(",", "."));
    if (!m || (m[1] === "" && !m[2])) return null;
    const value = BigInt(m[1] || "0") * NANO + BigInt((m[2] ?? "").padEnd(9, "0"));
    return value > 0n ? value : null;
}

function fmtNano(value) {
    const frac = (value % NANO).toString().padStart(9, "0").replace(/0+$/, "");
    return `${value / NANO}${frac ? `.${frac}` : ""}`;
}

function versionGe(version, min) {
    const a = version.split(".").map((x) => parseInt(x, 10) || 0);
    const b = min.split(".").map((x) => parseInt(x, 10) || 0);
    for (let i = 0; i < b.length; i++) {
        if ((a[i] ?? 0) !== b[i]) return (a[i] ?? 0) > b[i];
    }
    return true;
}

// --- files ---

function nonEmpty(file) {
    try {
        return fs.statSync(file).size > 0;
    } catch {
        return false;
    }
}

// Writes through a temporary file so that a crash never leaves a truncated one.
function writeFileAtomic(file, data) {
    const tmp = `${file}.part`;
    fs.rmSync(tmp, { force: true });
    fs.writeFileSync(tmp, data, { mode: 0o600 });
    fs.renameSync(tmp, file);
}

async function download(url, file) {
    let response;
    try {
        response = await fetch(url);
    } catch (err) {
        die(`failed to download ${url}: ${err.cause?.message ?? err.message}`);
    }
    if (!response.ok) die(`failed to download ${url}: HTTP ${response.status}`);
    writeFileAtomic(file, Buffer.from(await response.arrayBuffer()));
}

// Downloads the multisig ABI (and the TVC, if a path is given) when missing.
async function ensureContract(abiFile, tvcFile) {
    for (const [file, name] of [
        [abiFile, `${MSIG}.abi.json`],
        [tvcFile, `${MSIG}.tvc`],
    ]) {
        if (file && !nonEmpty(file)) {
            info(`Downloading ${name}`);
            await download(`${MSIG_URL}/${name}`, file);
        }
    }
}

function loadAbi(file) {
    try {
        return { type: "Contract", value: JSON.parse(fs.readFileSync(file, "utf8")) };
    } catch (err) {
        die(`${file}: not a valid ABI (${err.message}). Delete the file and it will be downloaded again`);
    }
}

function readKeys(file) {
    let keys;
    try {
        keys = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (err) {
        die(`${file}: not a valid key file (${err.message})`);
    }
    if (!/^[0-9a-fA-F]{64}$/.test(keys.public ?? "") || !/^[0-9a-fA-F]{64}$/.test(keys.secret ?? "")) {
        die(`${file}: no public/secret key pair found`);
    }
    return { public: keys.public.toLowerCase(), secret: keys.secret.toLowerCase() };
}

// The tvm-cli key file format.
function keysJson(keys) {
    return `${JSON.stringify({ public: keys.public, secret: keys.secret }, null, 2)}\n`;
}

// --- tvm-sdk ---

// A Node.js addon shipped next to the scripts for the current platform.
const BUNDLED_ADDON = path.join(__dirname, "addon", `${process.platform}-${process.arch}`, "tvmsdk.node");

// tvm-sdk ClientErrorCode.HttpClientCreateError. tvm-sdk 3.0.6 checks TLS
// certificates against the system store, and on Linux it cannot create its
// HTTP client at all when the system has no CA certificates.
const HTTP_CLIENT_CREATE_ERROR = 9;

// Picks the Node.js addon: TVMSDK_ADDON, then the bundled one, then the one
// inside @tvmsdk/lib-node. A file that is found but fails to load is an error,
// not a reason to try the next one.
function addonPath() {
    if (process.env.TVMSDK_ADDON) {
        return path.resolve(process.env.TVMSDK_ADDON);
    }
    if (fs.existsSync(BUNDLED_ADDON)) {
        return BUNDLED_ADDON;
    }
    try {
        return require.resolve("@tvmsdk/lib-node/tvmsdk.node");
    } catch {
        // @tvmsdk/lib-node is not installed or has no addon
    }
    die(`no tvm-sdk Node.js addon for ${process.platform}-${process.arch}: put a tvmsdk.node built from tvm-sdk ${SDK_MIN}+ at ${BUNDLED_ADDON} or set TVMSDK_ADDON to its path`);
}

// Loads tvm-sdk-js and connects to the endpoint. The Node.js addon must be
// built from tvm-sdk 3.0 or newer: older ones speak the pre-dapp_id protocol
// that current nodes reject.
async function createClient(endpoint) {
    let TvmClient;
    try {
        ({ TvmClient } = require("@tvmsdk/core"));
    } catch {
        die(`@tvmsdk/core is not installed: run npm install in ${__dirname}`);
    }
    const file = addonPath();
    let addon;
    try {
        addon = require(file);
    } catch (err) {
        die(`failed to load the tvm-sdk Node.js addon ${file}: ${err.message}`);
    }
    TvmClient.useBinaryLibrary(() => addon);
    const client = new TvmClient({ network: { endpoints: [endpoint] } });
    let version;
    try {
        ({ version } = await client.client.version());
    } catch (err) {
        if (err.code === HTTP_CLIENT_CREATE_ERROR) {
            die(`${err.message}. tvm-sdk needs the system CA certificates: install the ca-certificates package or set SSL_CERT_FILE to a CA bundle`);
        }
        throw err;
    }
    if (!versionGe(version, SDK_MIN)) {
        die(`the tvm-sdk Node.js addon ${file} is version ${version}, ${SDK_MIN} or newer is required`);
    }
    return { client, version };
}

async function codeHashOfTvc(client, tvc) {
    try {
        const { code } = await client.boc.get_code_from_tvc({ tvc });
        return (await client.boc.get_boc_hash({ boc: code })).hash;
    } catch {
        return undefined;
    }
}

// Checks that the TVC holds the expected multisig code.
async function checkTvc(client, file) {
    const hash = await codeHashOfTvc(client, fs.readFileSync(file).toString("base64"));
    if (hash !== MSIG_CODE_HASH) {
        die(`${file}: code hash ${hash ?? "unreadable"}, expected ${MSIG_CODE_HASH}. Delete the file and it will be downloaded again`);
    }
}

async function deriveKeys(client, phrase) {
    return client.crypto.mnemonic_derive_sign_keys({
        phrase,
        path: HD_PATH,
        dictionary: DICTIONARY_ENGLISH,
        word_count: WORD_COUNT,
    });
}

function eccBalance(parsed, id) {
    const entry = (parsed.balance_other ?? []).find((x) => Number(x.currency) === id);
    return entry ? BigInt(entry.value) : 0n;
}

// Reads the state of a DAPP_ID::ACCOUNT_ID account. A missing account comes
// back as type NonExist; network errors are thrown.
async function fetchAccount(client, address) {
    const [dapp_id, account_id] = address.split("::");
    let boc;
    try {
        ({ boc } = await client.account.get_account({ account_id, dapp_id }));
    } catch (err) {
        if (err.code === ERR_NOT_FOUND) {
            return { type: "NonExist", balance: 0n, nackl: 0n, shell: 0n, codeHash: undefined, boc: undefined };
        }
        throw err;
    }
    const { parsed } = await client.boc.parse_account({ boc });
    return {
        type: parsed.acc_type_name,
        balance: BigInt(parsed.balance ?? 0),
        nackl: eccBalance(parsed, ECC_NACKL),
        shell: eccBalance(parsed, ECC_SHELL),
        codeHash: parsed.code_hash,
        boc,
    };
}

// --- sending a message exactly once ---
//
// A message carries an expiration time and cannot be executed after it. Once
// the account's thread has a finalized block newer than that time and the
// database still has no transaction for the message, the message is dead:
// only then is it safe to send a new one without running the call twice.

// Seconds a message stays valid.
const MESSAGE_LIFETIME = 60;
// Messages to send before giving up.
const SEND_ATTEMPTS = 3;
const POLL_INTERVAL_MS = 2000;
// Seconds to keep waiting after the expiration time for the thread to produce
// a newer block, before reporting that the outcome is unknown.
const EXPIRY_GRACE = 120;

const TX_FIELDS = "id status_name aborted compute { exit_code }";

async function blockchainQuery(client, query, variables) {
    const { result } = await client.net.query({ query, variables });
    return result.data.blockchain;
}

// The transaction that consumed the message, if the database has it. It is
// looked up by the hash the node reported and also through the message: a node
// that failed to answer reports no transaction, and a reported one may belong
// to a block that was never finalized.
async function findTransaction(client, sent) {
    let reported;
    if (sent.txHash) {
        ({ transaction: reported } = await blockchainQuery(
            client,
            `query($h: String!) { blockchain { transaction(hash: $h) { ${TX_FIELDS} } } }`,
            { h: sent.txHash },
        ));
        if (reported?.status_name === "Finalized") return reported;
    }
    const { message } = await blockchainQuery(
        client,
        `query($h: String!) { blockchain { message(hash: $h) { dst_transaction { ${TX_FIELDS} } } } }`,
        { h: sent.messageId },
    );
    return message?.dst_transaction ?? reported ?? undefined;
}

// The thread that produced the latest transaction of the account.
async function accountThread(client, accountId, dappId) {
    const { account } = await blockchainQuery(
        client,
        "query($a: String!, $d: String!) { blockchain { account(account_id: $a, dapp_id: $d) { transactions(last: 1) { nodes { id } } } } }",
        { a: accountId, d: dappId },
    );
    const txHash = account?.transactions.nodes[0]?.id;
    if (!txHash) return undefined;
    const { transaction } = await blockchainQuery(
        client,
        "query($h: String!) { blockchain { transaction(hash: $h) { block_id } } }",
        { h: txHash },
    );
    if (!transaction?.block_id) return undefined;
    const { block } = await blockchainQuery(
        client,
        "query($h: String!) { blockchain { block(hash: $h) { thread_id } } }",
        { h: transaction.block_id },
    );
    return block?.thread_id ?? undefined;
}

// The generation time of the newest finalized block of the thread. The block
// list holds only hashes, so each block is fetched separately.
async function threadTime(client, threadId) {
    const { blocks } = await blockchainQuery(
        client,
        "query($t: String!) { blockchain { blocks(thread_id: $t, last: 3) { nodes { hash } } } }",
        { t: threadId },
    );
    for (const { hash } of blocks.nodes.reverse()) {
        const { block } = await blockchainQuery(
            client,
            "query($h: String!) { blockchain { block(hash: $h) { gen_utime status_name } } }",
            { h: hash },
        );
        if (block?.status_name === "FINALIZED") return block.gen_utime;
    }
    return undefined;
}

const utcTime = (seconds) => `${new Date(seconds * 1000).toISOString().slice(11, 19)} UTC`;

// Waits until the transaction of a sent message is finalized, or until the
// message has expired without one. Returns the transaction, or undefined when
// the message is dead and a new one can be sent.
async function awaitOutcome(client, sent, { pollMs, grace }) {
    let { threadId } = sent;
    let expired = false;
    let noticed = false;
    let lastError;
    const started = Date.now();
    for (;;) {
        try {
            const tx = await findTransaction(client, sent);
            if (tx?.status_name === "Finalized") return tx;
            // A transaction that is not final yet may still become final, so
            // only the absence of any transaction proves the message dead.
            const pending = tx && tx.status_name !== "Refused";
            if (expired && !pending) return undefined;
            threadId ??= await accountThread(client, sent.accountId, sent.dappId);
            const time = threadId ? await threadTime(client, threadId) : undefined;
            // The transaction is looked up once more after this block: it may
            // have been stored just before the block was.
            if (time > sent.expireAt) expired = true;
            lastError = undefined;
        } catch (err) {
            lastError = err;
        }
        if (Date.now() > (sent.expireAt + grace) * 1000) {
            const reason = lastError?.message ?? (threadId ? "the thread produced no newer block" : "the thread of the account is unknown");
            die(`the outcome of message ${sent.messageId} is unknown (${reason}). It may have been executed: check the account before sending again`);
        }
        if (!noticed && Date.now() - started > 10_000) {
            noticed = true;
            info(`No finalized transaction yet, waiting until the message expires at ${utcTime(sent.expireAt)} to know for sure`);
        }
        await sleep(pollMs);
    }
}

// Sends an external message to ACCOUNT_ID of DAPP_ID and returns its finalized
// transaction, sending a new message if one expires without being executed.
// `encode(expireAt)` builds the message for the given expiration time (the
// `expire` ABI header) with abi.encode_message.
async function sendReliably(
    client,
    { abi, accountId, dappId, encode, lifetime = MESSAGE_LIFETIME, attempts = SEND_ATTEMPTS, pollMs = POLL_INTERVAL_MS, grace = EXPIRY_GRACE },
) {
    for (let attempt = 1; ; attempt++) {
        const expireAt = Math.floor(Date.now() / 1000) + lifetime;
        const { message, message_id: messageId } = await encode(expireAt);
        const sent = { messageId, expireAt, accountId, dappId };
        try {
            const result = await client.processing.send_message({ message, abi, dapp_id: dappId, send_events: false });
            if ((result.aborted || result.exit_code) && !result.tx_hash) {
                die(`the contract rejected the message: exit code ${result.exit_code}`);
            }
            sent.txHash = result.tx_hash ?? undefined;
            sent.threadId = result.thread_id ?? undefined;
            info(`Message ${messageId} sent, waiting for its transaction to be finalized`);
        } catch (err) {
            if (err instanceof UserError) throw err;
            // The node may have accepted the message even though sending
            // failed, so the outcome is checked the same way.
            sent.threadId = err.data?.node_error?.extensions?.details?.thread_id;
            info(`Sending message ${messageId} failed: ${err.message.split("\n")[0]}`);
            info(`Checking whether it was executed anyway; it expires at ${utcTime(expireAt)}`);
        }
        const tx = await awaitOutcome(client, sent, { pollMs, grace });
        if (tx) {
            if (tx.aborted) die(`transaction ${tx.id} was aborted, exit code ${tx.compute?.exit_code}`);
            return tx;
        }
        if (attempt >= attempts) {
            die(`${attempts} messages expired without a transaction. Nothing was executed, it is safe to run the script again`);
        }
        info(`The message expired without a transaction, sending a new one (attempt ${attempt + 1} of ${attempts})`);
    }
}

module.exports = {
    MSIG,
    MSIG_CODE_HASH,
    ECC_NACKL,
    CACHE_DIR,
    DEFAULT_ENDPOINT,
    WORD_COUNT,
    DICTIONARY_ENGLISH,
    UserError,
    die,
    info,
    run,
    sleep,
    ask,
    toNano,
    fmtNano,
    versionGe,
    nonEmpty,
    writeFileAtomic,
    ensureContract,
    loadAbi,
    readKeys,
    keysJson,
    createClient,
    checkTvc,
    deriveKeys,
    fetchAccount,
    sendReliably,
};
