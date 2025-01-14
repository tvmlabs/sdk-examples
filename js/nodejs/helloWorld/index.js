const fs = require('fs');
const path = require('path');

require('dotenv').config();

const { TvmClient, abiContract, signerKeys, signerNone } = require('@tvmsdk/core');
const { libNode } = require('@tvmsdk/lib-node');

const { helloWorld } = require('./resources/helloWorld.js');
const WALLET_ABI = require('../../../../../wallet/multisig.abi.json');
const WALLET_KEYS = readKeysFromFile(process.env.WALLET_KEYS);

const ENDPOINTS = ['https://shellnet.ackinacki.org'];

const WALLET_ADDRESS = process.env.WALLET_ADDRESS;

TvmClient.useBinaryLibrary(libNode);
const client = new TvmClient({
    network: {
        endpoints: ENDPOINTS
    },
});

(async () => {
    try {
        // Generate an ed25519 key pair
        const helloWorldKeys = await client.crypto.generate_random_sign_keys();

        // Calculate future helloWorld address.
        const helloWorldAddress = await calcHelloWorldAddress(helloWorldKeys);

        // Send some nanoSHELL tokens to `helloWorldAddress` before deploy
        await getTokensFromWallet(helloWorldAddress, 2_000_000_000);

        // Deploy helloWorld
        await deploy(helloWorldKeys);

        // Get account info and print balance of the helloWorld contract
        let accountState = await getAccount(helloWorldAddress);
        console.log("helloWorld balance is", accountState.balance, "nanoVMSHELL");

        // Run account's get method `timestamp`
        let helloWorldTimestamp = await runGetMethod('timestamp', helloWorldAddress, accountState.boc);
        console.log("`timestamp` value is", helloWorldTimestamp)

        // Perform 2 seconds sleep, so that we receive an updated timestamp
        await new Promise(r => setTimeout(r, 2000));

        // Execute `touch` method for newly deployed helloWorld contract
        // Remember the logical time of the generated transaction
        await runOnChain(helloWorldAddress, "touch");

        // Get account updated account BOC of the helloWorld contract
        accountState = await getAccount(helloWorldAddress);

        // Run contract's get method locally after account is updated
        helloWorldTimestamp = await runGetMethod('timestamp', helloWorldAddress, accountState.boc);
        console.log("Updated `timestamp` value is", helloWorldTimestamp)

        // Send some nanoSHELL tokens from helloWorld to a random account
        // Remember the logical time of the generated transaction
        const destAddress = await genRandomAddress();
        await sendShell(helloWorldAddress, destAddress, 100_000_000, helloWorldKeys);

        console.log('Normal exit');
        process.exit(0);
    } catch (error) {
        if (error.code === 504) {
            console.error('Network is inaccessible.');
        } else {
            console.error(error);
            process.exit(1);
        }
    }
})();

async function calcHelloWorldAddress(keys) {
    // Get future `helloWorld` contract address from `encode_message` result
    const { address } = await client.abi.encode_message(buildDeployOptions(keys, 1_000_000_000));
    console.log(`Future address of helloWorld contract is: ${address}`);
    return address;
}

function buildDeployOptions(keys, value) {
    return {
        abi: {
            type: 'Contract',
            value: helloWorld.abi,
        },
        deploy_set: {
            tvc: helloWorld.tvc,
            initial_data: {
                _pubkey: `0x${keys.public}`
            },
        },
        call_set: {
            function_name: 'constructor',
            input: { value },
        },
        signer: {
            type: 'Keys',
            keys,
        },
    };
}

// Request funds from Multisig Wallet contract.
async function getTokensFromWallet(dest, shells) {
    console.log(`Transferring ${shells} nanoSHELL tokens from Multisig wallet to ${dest}`);

    const params = {
        send_events: false,
        message_encode_params: {
            address: WALLET_ADDRESS,
            abi: abiContract(WALLET_ABI),
            call_set: {
                function_name: 'sendTransaction',
                input: {
                    dest,
                    // Specify the amount in nanoVMSHELL that will be deducted from the Multisig balance
                    // and used to cover the transaction fees.
                    value: 1000000000,
                    bounce: false,
                    cc: {
                        "2": shells
                    },
                    flags: 0,
                    payload: ""
                },
            },
            signer: {
                type: 'Keys',
                keys: WALLET_KEYS,
            },
        },
    };
    const { message } = await client.abi.encode_message(params.message_encode_params);
    await client.processing.send_message({
        message,
        abi: abiContract(WALLET_ABI),
        send_events: false
    });
    console.log('Success. Tokens were transferred\n');
}

async function deploy(keys) {
    console.log('Deploying helloWorld contract');
    await client.processing.process_message({
        send_events: false,
        message_encode_params: buildDeployOptions(keys, 1_000_000_000),
    });
    console.log('Success. Contract was deployed\n');
}

async function runOnChain(address, methodName) {
    // Encode the message with external call
    const params = {
        send_events: false,
        message_encode_params: {
            address,
            abi: {
                type: 'Contract',
                value: helloWorld.abi,
            },
            call_set: {
                function_name: methodName,
                input: {},
            },
            signer: signerNone(),
        },
    };
    console.log(`Calling \`${methodName}\` function`);
    const response = await client.processing.process_message(params);
    const { id, lt } = response.transaction;
    console.log('Success. TransactionId is: %s\n', id);
    return lt;
}

async function getAccount(address) {
    // `boc` or bag of cells - native blockchain data layout. Account's boc contains full account state (code and data) that
    // we will  need to execute get methods.
    const query = `
        query {
          blockchain {
            account(
              address: "${address}"
            ) {
               info {
                balance(format: DEC)
                boc
              }
            }
          }
        }`;
    const {result}  = await client.net.query({query});
    const info = result.data.blockchain.account.info;
    return info;
}

async function runGetMethod(methodName, address, accountState) {
    // Execute the get method `timestamp` on the latest account's state
    // This can be managed in 3 steps:
    // 1. Download the latest Account State (BOC) 
    // 2. Encode message
    // 3. Execute the message locally on the downloaded state

    // Encode the message with `timestamp` call
    const { message } = await client.abi.encode_message({
        // Define contract ABI in the Application
        // See more info about ABI type here:
        // https://github.com/tvmlabs/tvm-sdk/blob/main/docs/reference/types-and-methods/mod_abi.md#abi
        abi: {
            type: 'Contract',
            value: helloWorld.abi,
        },
        address,
        call_set: {
            function_name: methodName,
            input: {},
        },
        signer: { type: 'None' },
    });
    // Execute `timestamp` get method  (execute the message locally on TVM)
    // See more info about run_tvm method here:
    // https://github.com/tvmlabs/tvm-sdk/blob/main/docs/reference/types-and-methods/mod_tvm.md#run_tvm
    console.log('Run `timestamp` get method');
    const response = await client.tvm.run_tvm({
        message,
        account: accountState,
        abi: {
            type: 'Contract',
            value: helloWorld.abi,
        },
    });
    return response.decoded.output;
}

async function sendShell(address, dest, value, keys) {
    // Encode the message with `sendShell` function call
    const sendShellParams = {
        send_events: false,
        message_encode_params: {
            address,
            abi: {
                type: 'Contract',
                value: helloWorld.abi,
            },
            call_set: {
                function_name: 'sendShell',
                input: {
                    dest,
                    value,
                },
            },
            signer: signerKeys(keys),
        },
    };
    console.log(`Sending ${value} nanoSHELL tokens to ${dest}`);
    const response = await client.processing.process_message(sendShellParams);
    return response.transaction.lt;
}

// Helpers
function readKeysFromFile(fname) {
    // const fullName = path.join(__dirname, fname);
    console.log("wallet keys fname:", fname);
    // Read the Wallet keys. We need them to sponsor a new contract
    if (!fs.existsSync(fname)) {
        console.log(`File ${fname} is missing.`);
        process.exit(1);
    }
    return JSON.parse(fs.readFileSync(fname, 'utf8'));
}

async function genRandomAddress() {
    const { bytes } = await client.crypto.generate_random_bytes({ length: 32 });
    return `0:${Buffer.from(bytes, 'base64').toString('hex')}`;
}
