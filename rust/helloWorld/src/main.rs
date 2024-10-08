use dotenv::dotenv;
use serde::Deserialize;
use std::{sync::Arc, time::SystemTime};
use tvm_client::{net::NetworkConfig, ClientConfig, ClientContext};

use crate::contract::GoshContract;
use crate::keys::load_keys;

mod abi;
mod blockchain;
mod contract;
mod keys;

#[derive(Deserialize, Debug)]
pub struct TimestampResult {
    #[serde(deserialize_with="abi::u32_from_str")]
    pub timestamp: u32
}

pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_else(|e| panic!("failed to obtain system time: {}", e))
        .as_millis() as u64
}

pub fn init_sdk() -> anyhow::Result<Arc<ClientContext>> {
    let config = ClientConfig {
        network: NetworkConfig {
            endpoints: Some(vec!["https://ackinacki-testnet.tvmlabs.dev/".to_owned()]),
            ..Default::default()
        },
        ..Default::default()
    };

    Ok(Arc::new(
        ClientContext::new(config)
        .map_err(|e| anyhow::anyhow!("failed to create SDK client: {}", e))?
    ))
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    dotenv().ok();

    // Initializing the Wallet
    let client = init_sdk()?;
    let wallet_keys_path = std::env::var("WALLET_KEYS")?;
    let wallet_keys = load_keys(&wallet_keys_path)?;
    let wallet_address = std::env::var("WALLET_ADDRESS")?;
    let wallet = GoshContract::new(&wallet_address, abi::WALLET, Some(wallet_keys));

    // deploy contract
    let tvc_path = std::env::var("CONTRACT_CODE")?;
    let hello_world = blockchain::deploy(&client, abi::HELLO_WORLD, &tvc_path, None, &wallet).await?;

    // run getter-method `timestamp()`
    let result: TimestampResult = hello_world
        .run_local(&client, "timestamp", None)
        .await?;
    println!("Timestamp result[1]: {}", result.timestamp);

    println!("Updating timestamp...");
    // run setter-method `timestamp()`
    hello_world.call(&client, "touch", None).await?;

    // run getter-method `timestamp()`
    let result: TimestampResult = hello_world
        .run_local(&client, "timestamp", None)
        .await?;
    println!("Timestamp result[2]: {}", result.timestamp);

    Ok(())
}
