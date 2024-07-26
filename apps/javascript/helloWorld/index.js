const fs = require('fs');
const path = require('path');

require('dotenv').config();

const { TonClient, abiContract, signerKeys, signerNone } = require('@eversdk/core');
const { libNode } = require('@eversdk/lib-node');

const { helloWorld } = require('./contracts/helloWorld.js');
const GIVER_ABI = require('../../../contracts/simpleWallet/giver.abi.json');
const GIVER_KEYS = readKeysFromFile(process.env.GIVER_KEYS);

const ENDPOINTS = ['https://ackinacki-testnet.tvmlabs.dev'];
const GIVER_ADDRESS = process.env.GIVER_ADDRESS;

TonClient.useBinaryLibrary(libNode);
const client = new TonClient({
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

        // Send some tokens to `helloWorldAddress` before deploy
        await getTokensFromGiver(helloWorldAddress, 1_000_000_000);

        // Deploy helloWorld
        await deploy(helloWorldKeys);

        // Get account info and print balance of the helloWorld contract
        const accountState = await getAccount(helloWorldAddress);
        console.log("helloWorld balance is", accountState.balance);

        // Run account's get method `getTimestamp`
        let helloWorldTimestamp = await runGetMethod('getTimestamp', helloWorldAddress, accountState.boc);
        console.log("`timestamp` value is", helloWorldTimestamp)

        // Perform 2 seconds sleep, so that we receive an updated timestamp
        await new Promise(r => setTimeout(r, 2000));
        // Execute `touch` method for newly deployed helloWorld contract
        // Remember the logical time of the generated transaction
        let transLt = await runOnChain(helloWorldAddress, "touch");

        // Run contract's get method locally after account is updated
        helloWorldTimestamp = await runGetMethodAfterLt('getTimestamp', helloWorldAddress, transLt);
        console.log("Updated `timestamp` value is", helloWorldTimestamp)

        // Send some tokens from helloWorld to a random account
        // Remember the logical time of the generated transaction
        const destAddress = await genRandomAddress();
        transLt = await sendValue(helloWorldAddress, destAddress, 100_000_000, helloWorldKeys);

        console.log('Normal exit');
        process.exit(0);
    } catch (error) {
        if (error.code === 504) {
            console.error(
                [
                    'Network is inaccessible. You have to start Evernode SE using `everdev se start`',
                    'If you run SE on another port or ip, replace http://localhost endpoint with',
                    'http://localhost:port or http://ip:port in index.js file.',
                ].join('\n'),
            );
        } else {
            console.error(error);
            process.exit(1);
        }
    }
})();

async function calcHelloWorldAddress(keys) {
    // Get future `helloWorld` contract address from `encode_message` result
    const { address } = await client.abi.encode_message(buildDeployOptions(keys));
    console.log(`Future address of helloWorld contract is: ${address}`);
    return address;
}

function buildDeployOptions(keys) {
    return {
        abi: {
            type: 'Contract',
            value: helloWorld.abi,
        },
        deploy_set: {
            tvc: helloWorld.tvc,
            initial_data: {},
        },
        call_set: {
            function_name: 'constructor',
            input: {},
        },
        signer: {
            type: 'Keys',
            keys,
        },
    };
}

// Request funds from Giver contract
async function getTokensFromGiver(dest, value) {
    console.log(`Transfering ${value} tokens from giver to ${dest}`);

    const params = {
        send_events: false,
        message_encode_params: {
            address: GIVER_ADDRESS,
            abi: abiContract(GIVER_ABI),
            call_set: {
                function_name: 'sendTransaction',
                input: {
                    dest,
                    value,
                    bounce: false,
                },
            },
            signer: {
                type: 'Keys',
                keys: GIVER_KEYS,
            },
        },
    };
    await client.processing.process_message(params);
    console.log('Success. Tokens were transfered\n');
}

async function deploy(keys) {
    console.log('Deploying helloWorld contract');
    await client.processing.process_message({
        send_events: false,
        message_encode_params: buildDeployOptions(keys),
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
    console.log(`Calling ${methodName} function`);
    const response = await client.processing.process_message(params);
    const { id, lt } = response.transaction;
    console.log('Success. TransactionId is: %s\n', id);
    return lt;
}

async function waitForAccountUpdate(address, transLt) {
    console.log('Waiting for account update');
    const startTime = Date.now();
    const account = await client.net.wait_for_collection({
        collection: 'accounts',
        filter: {
            id: { eq: address },
            last_trans_lt: { gt: transLt },
        },
        result: 'boc',
    });
    const duration = Math.floor((Date.now() - startTime) / 1000);
    console.log(`Success. Account was updated, it took ${duration} sec.\n`);
    return account;
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
    // Execute the get method `getTimestamp` on the latest account's state
    // This can be managed in 3 steps:
    // 1. Download the latest Account State (BOC) 
    // 2. Encode message
    // 3. Execute the message locally on the downloaded state

    // Encode the message with `getTimestamp` call
    const { message } = await client.abi.encode_message({
        // Define contract ABI in the Application
        // See more info about ABI type here:
        // https://github.com/tonlabs/ever-sdk/blob/master/docs/reference/types-and-methods/mod_abi.md#abi
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

    // Execute `getTimestamp` get method  (execute the message locally on TVM)
    // See more info about run_tvm method here:
    // https://github.com/tonlabs/ever-sdk/blob/master/docs/reference/types-and-methods/mod_tvm.md#run_tvm
    console.log('Run `getTimestamp` get method');
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


async function runGetMethodAfterLt(methodName, address, transLt) {
    // Wait for the account state to be more or equal the spesified logical time
    const accountState = await waitForAccountUpdate(address, transLt).then(({ result }) => result.boc);
    const result = await runGetMethod(methodName, address, accountState);
    return result;
}

async function sendValue(address, dest, amount, keys) {
    // Encode the message with `sendValue` function call
    const sendValueParams = {
        send_events: false,
        message_encode_params: {
            address,
            // Define contract ABI in the Application
            // See more info about ABI type here:
            // https://github.com/tonlabs/ever-sdk/blob/master/docs/reference/types-and-methods/mod_abi.md#abi
            abi: {
                type: 'Contract',
                value: helloWorld.abi,
            },
            call_set: {
                function_name: 'sendValue',
                input: {
                    dest,
                    amount,
                    bounce: false,
                },
            },
            signer: signerKeys(keys),
        },
    };
    console.log(`Sending ${amount} tokens to ${dest}`);
    // Call `sendValue` function
    const response = await client.processing.process_message(sendValueParams);
    console.log('Success. Target account will recieve: %d tokens\n', response.fees.total_output);
    return response.transaction.lt;
}

// Helpers
function readKeysFromFile(fname) {
    const fullName = path.join(__dirname, fname);
    console.log("giver keys fname:", fname);
    // Read the Giver keys. We need them to sponsor a new contract
    if (!fs.existsSync(fullName)) {
        console.log(`Please place ${fname} file with Giver keys in project root folder`);
        process.exit(1);
    }
    return JSON.parse(fs.readFileSync(fullName, 'utf8'));
}

async function genRandomAddress() {
    const { bytes } = await client.crypto.generate_random_bytes({ length: 32 });
    return `0:${Buffer.from(bytes, 'base64').toString('hex')}`;
}
