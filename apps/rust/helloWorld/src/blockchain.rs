use base64::engine::{Engine as _, general_purpose::STANDARD as BASE64};
use serde_json::Value;
use std::{sync::Arc, time::Duration};
use serde::Deserialize;
use tvm_client::{
    abi::{
        encode_message,
        Abi, CallSet, DeploySet, FunctionHeader, ParamsOfEncodeMessage, ResultOfEncodeMessage, Signer
    },
    crypto::{generate_random_sign_keys, KeyPair},
    net::{query_collection, ParamsOfQuery, ParamsOfQueryCollection},
    processing::{process_message, ParamsOfProcessMessage},
    tvm::{run_tvm, ParamsOfRunTvm},
    ClientContext,
};

use crate::{blockchain, contract::GoshContract};

#[derive(Deserialize, Debug)]
pub struct AccountData {
    acc_type: u8,
    #[serde(with = "tvm_sdk::json_helper::uint")]
    balance: u64,
}

#[derive(Deserialize, Debug)]
pub struct CallResult {
    #[serde(rename = "id")]
    pub trx_id: String,
    // // Some useful fields
    // status: u8,
    // #[serde(with = "tvm_sdk::json_helper::uint")]
    // total_fees: u64,
    // in_msg: String,
    // out_msgs: Vec<String>,
}

pub async fn get_account_data(
    context: &Arc<ClientContext>,
    contract: &GoshContract,
) -> anyhow::Result<AccountData> {
    let query = r#"query($address: String!){
        blockchain {
          account(address: $address) {
            info {
              acc_type balance
            }
          }
        }
    }"#
    .to_owned();

    let result = tvm_client::net::query(
        Arc::clone(context),
        ParamsOfQuery {
            query: query.clone(),
            variables: Some(serde_json::json!({
                "address": contract.address,
            })),
            ..Default::default()
        },
    )
    .await
    .map(|r| r.result)
    .map_err(|e| anyhow::format_err!("query error: {e}"))?;

    let extracted_data = &result["data"]["blockchain"]["account"]["info"];

    Ok(serde_json::from_value::<AccountData>(extracted_data.clone())?)
}

pub async fn run_local(
    ctx: &Arc<ClientContext>,
    contract: &GoshContract,
    fn_name: &str,
    args: Option<serde_json::Value>,
) -> anyhow::Result<Value> {
    let filter = Some(serde_json::json!({
        "id": { "eq": contract.address }
    }));

    let query = query_collection(
        Arc::clone(ctx),
        ParamsOfQueryCollection {
            collection: "accounts".to_owned(),
            filter,
            result: "boc".to_owned(),
            limit: Some(1),
            order: None,
        },
    )
    .await
    .map(|r| r.result)?;

    if query.is_empty() {
        anyhow::bail!(
            "account with address {} not found. Was trying to call {}",
            contract.address,
            fn_name,
        );
    }

    let account_boc = &query[0]["boc"].as_str();
    if account_boc.is_none() {
        anyhow::bail!(
            "account with address {} does not contain boc",
            contract.address,
        );
    }

    let call_set = match args {
        Some(value) => CallSet::some_with_function_and_input(fn_name, value),
        None => CallSet::some_with_function(fn_name),
    };

    let encoded = encode_message(
        Arc::clone(ctx),
        ParamsOfEncodeMessage {
            abi: contract.abi.clone(),
            address: Some(contract.address.clone()),
            call_set,
            signer: Signer::None,
            deploy_set: None,
            processing_try_index: None,
            signature_id: None,
        },
    )
    .await
    .map_err(|e| anyhow::format_err!("failed to encode message: {e}"))?;

    let result = run_tvm(
        Arc::clone(ctx),
        ParamsOfRunTvm {
            message: encoded.message,
            account: account_boc.unwrap().to_string(),
            abi: Some(contract.abi.clone()),
            boc_cache: None,
            execution_options: None,
            return_updated_account: None,
        },
    )
    .await
    .map(|r| r.decoded.unwrap())
    .map(|r| r.output.unwrap())
    .map_err(|e| anyhow::format_err!("run_local failed: {e}"))?;

    Ok(result)
}

pub async fn call(
    ctx: &Arc<ClientContext>,
    contract: &GoshContract,
    fn_name: &str,
    args: Option<serde_json::Value>,
) -> anyhow::Result<CallResult> {
    let call_set = match args {
        Some(value) => CallSet::some_with_function_and_input(fn_name, value),
        None => CallSet::some_with_function(fn_name),
    };

    let signer = match contract.get_keys() {
        Some(key_pair) => Signer::Keys {
            keys: key_pair.to_owned(),
        },
        None => Signer::None,
    };

    let message_encode_params = ParamsOfEncodeMessage {
        abi: contract.abi.clone(),
        address: Some(contract.address.clone()),
        call_set,
        signer,
        deploy_set: None,
        processing_try_index: None,
        signature_id: None,
    };

    let call_result = process_message(
        ctx.clone(),
        ParamsOfProcessMessage { message_encode_params, send_events: false },
        |_| async {}
    )
    .await
    .map(|r| r.transaction)
    .map_err(|e| anyhow::format_err!("process_message error: {e}"))?;

    Ok(serde_json::from_value::<CallResult>(call_result)?)
}

pub async fn deploy(
    ctx: &Arc<ClientContext>,
    (pretty_name, abi): (&str, &str),
    tvc_path: &str,
    keys: Option<KeyPair>,
    giver: &GoshContract,
) -> anyhow::Result<GoshContract> {
    let keys = match keys {
        None => generate_random_sign_keys(ctx.clone())?,
        Some(key_pair) => key_pair
    };

    let tvc = std::fs::read(tvc_path)
        .map_err(|e| anyhow::format_err!("failed to read smart contract code: {}", e))?;

    let deploy_set = DeploySet {
        workchain_id: Some(0),
        tvc: Some(BASE64.encode(tvc.clone())),
        initial_pubkey: Some(keys.public.clone()),
        ..Default::default()
    };

    // calculating the future address of the contract
    let ResultOfEncodeMessage { address, .. } = tvm_client::abi::encode_message(
        ctx.clone(),
        ParamsOfEncodeMessage {
            abi: Abi::Json(abi.to_string()),
            deploy_set: Some(deploy_set),
            signer: Signer::External { public_key: keys.public.clone()
        },
        ..Default::default()
    })
    .await
    .map_err(|e| anyhow::format_err!("failed to generate address: {}", e))?;

    println!("Future address: {}", address);
    let contract = GoshContract::new(&address, (pretty_name, abi), Some(keys.clone()));

    println!("Requesting tokens from giver-contract...");
    // replenishment of the balance the contract
    blockchain::send_tokens(ctx, giver, &address, 1_000_000_000).await?;

    let mut tries = 0;
    // checking the status of the contract
    loop {
        let data = get_account_data(ctx, &contract).await?;
        println!();
        if data.acc_type == 0 && data.balance > 0 {
            println!("Contract status: Uninit (ready to deploy)");
            println!("Contract balance: {} nanotokens", data.balance);
            break;
        } else {
            tries += 1;
            if tries >= 30 {
                anyhow::bail!("deploy failed (didn't receive the requested tokens)");
            }
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
    }

    let deploy_set = DeploySet {
        workchain_id: Some(0),
        tvc: Some(BASE64.encode(tvc)),
        ..Default::default()
    };
    let call_set = CallSet {
        function_name: "constructor".to_owned(),
        header: Some(FunctionHeader { time: Some(crate::now()), ..Default::default() }),
        ..Default::default()
    };
    let message_encode_params = ParamsOfEncodeMessage {
        abi: Abi::Json(abi.to_string()),
        address: Some(address.clone()),
        deploy_set: Some(deploy_set),
        call_set: Some(call_set),
        signer: Signer::Keys { keys },
        ..Default::default()
    };

    // deploy of the contract
    process_message(
        ctx.clone(),
        ParamsOfProcessMessage { message_encode_params, send_events: false },
        |_| async {}
    ).await?;
    println!("Contract has been deployed");
    Ok(contract)
}

// the function of replenishing the balance of the contract
async fn send_tokens(
    ctx: &Arc<ClientContext>,
    giver: &GoshContract,
    to: &str,
    value: u64
) -> anyhow::Result<()> {
    let args = serde_json::json!({
        "dest": to,
        "value": value,
        "bounce": false
    });
    let trx_id = giver.call(ctx, "sendTransaction", Some(args)).await?;
    println!("Transaction id: {}", trx_id);

    Ok(())
}
