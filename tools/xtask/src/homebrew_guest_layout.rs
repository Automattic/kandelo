use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::sync::OnceLock;

const CONTRACT_JSON: &str = include_str!("../../../homebrew/kandelo-guest-layout.json");
const CANONICAL_PREFIX: &str = "/opt/kandelo/homebrew";
const RETIRED_PREFIX: &str = "/home/linuxbrew/.linuxbrew";

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Contract {
    schema: u64,
    kind: String,
    prefix: String,
    cellar: String,
    repository: String,
    stable_entrypoint: String,
    retired_prefixes: Vec<String>,
}

#[derive(Clone, Debug)]
pub(crate) struct GuestLayout {
    pub(crate) prefix: String,
    pub(crate) cellar: String,
}

static LAYOUT: OnceLock<Result<GuestLayout, String>> = OnceLock::new();

pub(crate) fn get(prefix_campaign_sha256: Option<&str>) -> Result<GuestLayout, String> {
    if let Some(expected_sha256) = prefix_campaign_sha256 {
        if expected_sha256.len() != 64
            || !expected_sha256
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err("invalid Kandelo prefix-campaign guest layout SHA-256".to_string());
        }
        let actual_sha256 = format!("{:x}", Sha256::digest(CONTRACT_JSON.as_bytes()));
        if actual_sha256 != expected_sha256 {
            return Err(
                "Kandelo guest layout differs from prefix-campaign authority".to_string(),
            );
        }
    }
    match LAYOUT.get_or_init(parse) {
        Ok(layout) => Ok(layout.clone()),
        Err(error) => Err(error.clone()),
    }
}

fn parse() -> Result<GuestLayout, String> {
    let contract: Contract = serde_json::from_str(CONTRACT_JSON)
        .map_err(|error| format!("invalid Kandelo Homebrew guest layout: {error}"))?;
    if contract.schema != 1 || contract.kind != "kandelo-homebrew-guest-layout" {
        return Err("unsupported Kandelo Homebrew guest layout contract".to_string());
    }
    for (label, path) in [
        ("prefix", contract.prefix.as_str()),
        ("cellar", contract.cellar.as_str()),
        ("repository", contract.repository.as_str()),
        ("stable_entrypoint", contract.stable_entrypoint.as_str()),
    ] {
        require_normalized_absolute(path, label)?;
    }
    if contract.cellar != format!("{}/Cellar", contract.prefix) {
        return Err("Kandelo Homebrew guest cellar is not below its prefix".to_string());
    }
    if contract.repository != contract.prefix {
        return Err("Kandelo Homebrew guest repository differs from its prefix".to_string());
    }
    if contract.stable_entrypoint != "/usr/bin/brew" {
        return Err("Kandelo Homebrew guest entrypoint is not /usr/bin/brew".to_string());
    }
    if contract.prefix != CANONICAL_PREFIX {
        return Err("Kandelo Homebrew guest prefix is not canonical".to_string());
    }
    if contract.retired_prefixes.is_empty() {
        return Err("Kandelo Homebrew guest layout has no retired prefixes".to_string());
    }
    let mut retired = BTreeSet::new();
    for prefix in &contract.retired_prefixes {
        require_normalized_absolute(prefix, "retired_prefix")?;
        if prefix == &contract.prefix {
            return Err("Kandelo Homebrew guest layout retires its current prefix".to_string());
        }
        if !retired.insert(prefix.as_str()) {
            return Err("Kandelo Homebrew guest layout repeats a retired prefix".to_string());
        }
    }
    if !retired.contains(RETIRED_PREFIX) {
        return Err("Kandelo Homebrew guest layout omits the retired prefix".to_string());
    }
    Ok(GuestLayout {
        prefix: contract.prefix,
        cellar: contract.cellar,
    })
}

fn require_normalized_absolute(path: &str, label: &str) -> Result<(), String> {
    if !path.starts_with('/')
        || path.starts_with("//")
        || path.ends_with('/')
        || path.contains('\\')
        || path.contains('\0')
        || path
            .trim_start_matches('/')
            .split('/')
            .any(|component| component.is_empty() || component == "." || component == "..")
    {
        return Err(format!(
            "Kandelo Homebrew guest layout {label} is not a normalized absolute POSIX path"
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_and_campaign_bound_layouts_match() {
        let canonical = get(None).unwrap();
        let digest = format!("{:x}", Sha256::digest(CONTRACT_JSON.as_bytes()));
        let campaign = get(Some(&digest)).unwrap();
        assert_eq!(canonical.cellar, format!("{}/Cellar", canonical.prefix));
        assert_eq!(campaign.cellar, format!("{}/Cellar", campaign.prefix));
        assert_eq!(canonical.prefix, campaign.prefix);
    }

    #[test]
    fn prefix_campaign_rejects_a_different_layout_digest() {
        assert!(get(Some(&"0".repeat(64))).is_err());
    }
}
