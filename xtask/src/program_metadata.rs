//! Loader for `abi/program-metadata.toml`.
//!
//! Centralises the `(source, license)` facts for every logical program
//! we ship in a binaries release. Consumed by `build-manifest` and
//! `bundle-program`.

use std::collections::BTreeMap;

use serde::Deserialize;
use serde_json::{json, Value};

use crate::{repo_root, JsonMap};

#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
enum RawEntry {
    /// Program defers to another entry's source + license. Used for
    /// test/example programs that all share the repo's metadata.
    Alias {
        alias: String,
    },
    /// Program defines its own source + license.
    Full {
        source: Source,
        license: License,
    },
}

#[derive(Debug, Clone, Deserialize)]
pub struct ProgramMetadata {
    pub source: Source,
    pub license: License,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Source {
    pub url: String,
    pub r#ref: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct License {
    pub spdx: String,
    pub url: Option<String>,
}

impl ProgramMetadata {
    pub fn source_value(&self) -> Value {
        let mut m: JsonMap = BTreeMap::new();
        m.insert("url".into(), json!(self.source.url));
        if let Some(r) = self.source.r#ref.as_deref() {
            m.insert("ref".into(), json!(r));
        }
        Value::Object(m.into_iter().collect())
    }

    pub fn license_value(&self) -> Value {
        let mut m: JsonMap = BTreeMap::new();
        m.insert("spdx".into(), json!(self.license.spdx));
        if let Some(u) = self.license.url.as_deref() {
            m.insert("url".into(), json!(u));
        }
        Value::Object(m.into_iter().collect())
    }
}

pub fn load_program_metadata() -> Result<BTreeMap<String, ProgramMetadata>, String> {
    let path = repo_root().join("abi/program-metadata.toml");
    let text = std::fs::read_to_string(&path)
        .map_err(|e| format!("read {}: {e}", path.display()))?;
    let raw: BTreeMap<String, RawEntry> =
        toml::from_str(&text).map_err(|e| format!("parse {}: {e}", path.display()))?;

    // Two-pass resolve: first collect Full entries, then resolve aliases.
    let mut resolved: BTreeMap<String, ProgramMetadata> = BTreeMap::new();
    for (k, v) in &raw {
        if let RawEntry::Full { source, license } = v {
            resolved.insert(
                k.clone(),
                ProgramMetadata {
                    source: source.clone(),
                    license: license.clone(),
                },
            );
        }
    }
    for (k, v) in &raw {
        if let RawEntry::Alias { alias } = v {
            let target = resolved.get(alias).ok_or_else(|| {
                format!(
                    "program {:?} aliases {:?}, but {:?} is not defined in \
                     abi/program-metadata.toml",
                    k, alias, alias
                )
            })?;
            resolved.insert(k.clone(), target.clone());
        }
    }
    Ok(resolved)
}
