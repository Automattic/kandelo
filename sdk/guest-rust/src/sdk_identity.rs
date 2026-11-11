//! A genuine SDK identity, independent of upstream rustc's release/commit.
//! The installed manifest is generated from actual build-component bytes.

use serde::{Deserialize, Deserializer, de};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, fmt, io::Read, path::Path};

pub(super) const INSTALLED_MANIFEST: &str = "/usr/share/kandelo/rust-sdk/manifest.json";
const MAX_MANIFEST_BYTES: u64 = 16 * 1024;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    schema: u32,
    identity: String,
    components: Components,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Schema {
    schema: u32,
    domain: String,
    required: Vec<String>,
    optional: Vec<String>,
}

struct Components(BTreeMap<String, String>);

impl<'de> Deserialize<'de> for Components {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Visitor;
        impl<'de> de::Visitor<'de> for Visitor {
            type Value = Components;
            fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
                formatter.write_str("a unique map of SDK component digests")
            }
            fn visit_map<M: de::MapAccess<'de>>(self, mut map: M) -> Result<Self::Value, M::Error> {
                let mut components = BTreeMap::new();
                while let Some((name, digest)) = map.next_entry::<String, String>()? {
                    if components.insert(name.clone(), digest).is_some() {
                        return Err(de::Error::custom(format!(
                            "duplicate SDK component: {name}"
                        )));
                    }
                }
                Ok(Components(components))
            }
        }
        deserializer.deserialize_map(Visitor)
    }
}

pub(super) fn read(path: &Path) -> crate::Result<String> {
    let file = std::fs::File::open(path).map_err(|error| {
        format!(
            "reading SDK manifest {}: {error}; install the complete Rust SDK",
            path.display()
        )
    })?;
    let mut bytes = Vec::new();
    file.take(MAX_MANIFEST_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("reading SDK manifest {}: {error}", path.display()))?;
    parse(&bytes)
}

fn parse(bytes: &[u8]) -> crate::Result<String> {
    if bytes.len() as u64 > MAX_MANIFEST_BYTES {
        return Err("SDK manifest exceeds its size limit".into());
    }
    let schema: Schema = serde_json::from_str(include_str!("sdk-components.json"))
        .map_err(|error| format!("SDK component schema: {error}"))?;
    let manifest: Manifest =
        serde_json::from_slice(bytes).map_err(|error| format!("SDK manifest: {error}"))?;
    if schema.schema != 1 || manifest.schema != schema.schema {
        return Err("unsupported SDK manifest schema".into());
    }
    let components = &manifest.components.0;
    for name in &schema.required {
        if !components.contains_key(name) {
            return Err(format!("SDK manifest lacks {name}"));
        }
    }
    let mut hash = Sha256::new();
    hash.update(schema.domain.as_bytes());
    hash.update([0]);
    for (name, digest) in components {
        if !schema.required.contains(name) && !schema.optional.contains(name) {
            return Err(format!("unknown SDK component: {name}"));
        }
        if !hex_digest(digest) {
            return Err(format!("invalid SDK component digest: {name}"));
        }
        hash.update(name.as_bytes());
        hash.update([0]);
        hash.update(digest.as_bytes());
        hash.update([0]);
    }
    let actual = hash
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    if !hex_digest(&manifest.identity) || manifest.identity != actual {
        return Err("SDK manifest identity does not match its components".into());
    }
    Ok(actual)
}

fn hex_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[cfg(test)]
mod tests {
    use super::*;
    const BUILT: &str = include_str!("../tests/fixtures/sdk-manifest.json");

    #[test]
    fn accepts_a_real_sdk_manifest_generated_by_the_package_recipe() {
        let expected: serde_json::Value = serde_json::from_str(BUILT).unwrap();
        assert_eq!(parse(BUILT.as_bytes()).unwrap(), expected["identity"]);
    }

    #[test]
    fn refuses_tampering_missing_fields_and_unknown_schemas() {
        let original: serde_json::Value = serde_json::from_str(BUILT).unwrap();
        for change in ["component", "missing", "schema", "extra", "identity"] {
            let mut value = original.clone();
            match change {
                "component" => value["components"]["rust-std"] = "00".repeat(32).into(),
                "missing" => {
                    value["components"].as_object_mut().unwrap().remove("cargo");
                }
                "schema" => value["schema"] = 2.into(),
                "extra" => value["unexpected"] = true.into(),
                "identity" => value["identity"] = "not an identity".into(),
                _ => unreachable!(),
            }
            assert!(
                parse(&serde_json::to_vec(&value).unwrap()).is_err(),
                "{change}"
            );
        }
        assert!(parse(&vec![b' '; MAX_MANIFEST_BYTES as usize + 1]).is_err());
        assert!(parse(br#"{"schema":1,"schema":1,"components":{},"identity":""}"#).is_err());
        assert!(
            parse(br#"{"schema":1,"components":{"cargo":"x","cargo":"y"},"identity":""}"#)
                .unwrap_err()
                .contains("duplicate")
        );
    }
}
