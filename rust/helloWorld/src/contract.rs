use serde::de;
use std::sync::Arc;
use tvm_client::{abi::Abi, crypto::KeyPair, ClientContext};

use crate::blockchain::{self, CallResult};

pub struct GoshContract {
    pub address: String,
    pub pretty_name: String,
    pub abi: Abi,
    pub keys: Option<KeyPair>,
}

impl GoshContract {
    pub fn new(
        address: &str,
        (pretty_name, abi): (&str, &str),
        keys: Option<KeyPair>
    ) -> Self {
        Self {
            address: address.into(),
            pretty_name: pretty_name.to_owned(),
            abi: Abi::Json(abi.to_string()),
            keys,
        }
    }

    pub fn get_keys(&self) -> &Option<KeyPair> {
        &self.keys
    }

    pub async fn run_local<T>(
        &self,
        ctx: &Arc<ClientContext>,
        fn_name: &str,
        args: Option<serde_json::Value>,
    ) -> anyhow::Result<T>
    where
        T: de::DeserializeOwned
    {
        let result = blockchain::run_local(ctx, self, fn_name, args).await?;

        Ok(serde_json::from_value::<T>(result)?)
    }

    pub async fn call(
        &self,
        ctx: &Arc<ClientContext>,
        fn_name: &str,
        args: Option<serde_json::Value>,
    ) -> anyhow::Result<String> {
        let CallResult { trx_id, .. } = blockchain::call(ctx, self, fn_name, args).await?;

        Ok(trx_id)
    }
}
