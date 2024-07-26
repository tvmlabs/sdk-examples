use serde::{de, Deserialize, Deserializer};

macro_rules! abi {
    ($file: expr) => {
        ($file, include_str!(concat!("../resources/", $file)))
    };
}

type Abi = (&'static str, &'static str);

pub static GIVER: Abi = abi!("giver.abi.json");
pub static HELLO_WORLD: Abi = abi!("helloWorld.abi.json");

pub fn u32_from_str<'de, D>(des: D) -> Result<u32, D::Error>
where
    D: Deserializer<'de>,
{
    let s: String = Deserialize::deserialize(des)?;
    s.parse::<u32>().map_err(de::Error::custom)
}
