use tvm_client::crypto::KeyPair;

pub fn load_keys(key_file: &str) -> anyhow::Result<KeyPair> {
    let keys_str = std::fs::read_to_string(key_file)?;
    Ok(serde_json::from_str(&keys_str)?)
}
