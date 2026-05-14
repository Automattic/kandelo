//! Parser + writer for the `index.toml` ledger.
//!
//! `index.toml` is the single source of truth for binary resolution
//! state — per package, per arch. CI publishes archive URLs into it
//! atomically under a workflow-level state-lock (see
//! `.github/scripts/state-lock.sh`); the resolver consumes it via
//! HTTP (see `build_deps::fetch_index` later in the implementation
//! plan).
//!
//! Schema: `docs/plans/2026-05-13-binary-resolution-via-index-ledger-design.md` §3.4.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::pkg_manifest::TargetArch;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct IndexToml {
    pub abi_version: u32,
    pub generated_at: String,
    pub generator: String,
    #[serde(default)]
    pub packages: Vec<PackageEntry>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct PackageEntry {
    pub name: String,
    pub version: String,
    pub revision: u32,
    #[serde(default)]
    pub binary: BTreeMap<TargetArch, BinaryEntry>,
}

/// Per-arch binary entry. `status` discriminates which field set is
/// authoritative:
///   * `Success` — `archive_url` / `archive_sha256` / `cache_key_sha`
///     / `built_at` / `built_by` are populated; `fallback_*` are
///     cleared.
///   * `Failed` — `error` / `last_attempt` / `last_attempt_by` are
///     populated; `fallback_*` MAY be populated when a prior
///     successful build is being preserved as the last-green
///     fallback.
///   * `Pending` / `Building` — transient states the index can
///     report during a rebuild; resolver falls back to source build
///     unless `fallback_*` is populated.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, Default)]
pub struct BinaryEntry {
    pub status: EntryStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archive_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archive_sha256: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_key_sha: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub built_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub built_by: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_attempt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_attempt_by: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fallback_archive_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fallback_archive_sha256: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fallback_cache_key_sha: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fallback_built_at: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum EntryStatus {
    Pending,
    Building,
    #[default]
    Success,
    Failed,
}

impl IndexToml {
    /// Parse an `index.toml` from a TOML string.
    pub fn parse(s: &str) -> Result<Self, String> {
        toml::from_str(s).map_err(|e| format!("index.toml parse: {e}"))
    }

    /// Look up an entry by `(name, version, arch)`. Returns `None`
    /// when the package isn't in the ledger or the arch hasn't been
    /// recorded.
    pub fn lookup(
        &self,
        name: &str,
        version: &str,
        arch: TargetArch,
    ) -> Option<&BinaryEntry> {
        self.packages
            .iter()
            .find(|p| p.name == name && p.version == version)?
            .binary
            .get(&arch)
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn parses_index_toml_with_success_entry() {
        use super::*;
        use crate::pkg_manifest::TargetArch;

        let toml = r#"
abi_version  = 8
generated_at = "2026-05-13T00:00:00Z"
generator    = "test"

[[packages]]
name     = "foo"
version  = "1.0"
revision = 1

[packages.binary.wasm32]
status         = "success"
archive_url    = "foo-1.0-rev1-abi8-wasm32-abc12345.tar.zst"
archive_sha256 = "deadbeef"
cache_key_sha  = "abc12345"
built_at       = "2026-05-13T00:00:00Z"
built_by       = "https://example.com/run/1"
"#;
        let idx = IndexToml::parse(toml).unwrap();
        assert_eq!(idx.abi_version, 8);
        assert_eq!(idx.packages.len(), 1);
        let pkg = &idx.packages[0];
        assert_eq!(pkg.name, "foo");
        assert_eq!(pkg.version, "1.0");
        assert_eq!(pkg.revision, 1);
        let entry = pkg.binary.get(&TargetArch::Wasm32).unwrap();
        assert_eq!(entry.status, EntryStatus::Success);
        assert_eq!(
            entry.archive_url.as_deref(),
            Some("foo-1.0-rev1-abi8-wasm32-abc12345.tar.zst")
        );
        assert_eq!(entry.archive_sha256.as_deref(), Some("deadbeef"));
        assert_eq!(entry.cache_key_sha.as_deref(), Some("abc12345"));
    }

    #[test]
    fn parses_index_toml_with_failed_entry_and_fallback() {
        use super::*;
        use crate::pkg_manifest::TargetArch;

        let toml = r#"
abi_version  = 8
generated_at = "2026-05-13T00:00:00Z"
generator    = "test"

[[packages]]
name     = "foo"
version  = "1.0"
revision = 1

[packages.binary.wasm64]
status                  = "failed"
error                   = "linker error"
last_attempt            = "2026-05-13T00:00:00Z"
fallback_archive_url    = "foo-1.0-rev1-abi8-wasm64-old.tar.zst"
fallback_archive_sha256 = "olddeadbeef"
fallback_cache_key_sha  = "oldcachekey"
fallback_built_at       = "2026-05-12T00:00:00Z"
"#;
        let idx = IndexToml::parse(toml).unwrap();
        let entry = &idx.packages[0].binary[&TargetArch::Wasm64];
        assert_eq!(entry.status, EntryStatus::Failed);
        assert_eq!(entry.error.as_deref(), Some("linker error"));
        assert_eq!(
            entry.fallback_archive_url.as_deref(),
            Some("foo-1.0-rev1-abi8-wasm64-old.tar.zst")
        );
        assert_eq!(entry.fallback_archive_sha256.as_deref(), Some("olddeadbeef"));
    }
}
