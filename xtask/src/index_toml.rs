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

    /// Hand-format the ledger to TOML. We avoid `toml::to_string`
    /// because it alphabetizes table keys (writing `archive_sha256`
    /// before `archive_url`, `built_at` before `cache_key_sha`,
    /// etc.). The schema in design §3.4 specifies a deliberate field
    /// order — keeping it stable makes diffs of a published
    /// `index.toml` readable as an audit log of CI activity.
    pub fn write(&self) -> String {
        let mut out = String::new();
        out.push_str(&format!("abi_version = {}\n", self.abi_version));
        out.push_str(&format!(
            "generated_at = \"{}\"\n",
            escape(&self.generated_at)
        ));
        out.push_str(&format!("generator = \"{}\"\n", escape(&self.generator)));

        // Packages emitted alphabetically by (name, version) so the
        // file is stable under arbitrary insertion order.
        let mut pkgs: Vec<&PackageEntry> = self.packages.iter().collect();
        pkgs.sort_by(|a, b| (&a.name, &a.version).cmp(&(&b.name, &b.version)));

        for p in pkgs {
            out.push_str("\n[[packages]]\n");
            out.push_str(&format!("name = \"{}\"\n", escape(&p.name)));
            out.push_str(&format!("version = \"{}\"\n", escape(&p.version)));
            out.push_str(&format!("revision = {}\n", p.revision));

            // Per-arch entries in canonical arch order: wasm32 first,
            // then wasm64 (matches the BTreeMap's natural ordering
            // since the enum derives Ord with Wasm32 < Wasm64).
            for (arch, entry) in &p.binary {
                out.push_str(&format!(
                    "\n[packages.binary.{}]\n",
                    arch.as_str()
                ));
                out.push_str(&format!(
                    "status = \"{}\"\n",
                    match entry.status {
                        EntryStatus::Pending => "pending",
                        EntryStatus::Building => "building",
                        EntryStatus::Success => "success",
                        EntryStatus::Failed => "failed",
                    }
                ));
                // Order matches design §3.4 (success path then failure
                // metadata then fallback block). Each field skipped
                // when None.
                write_opt(&mut out, "archive_url", &entry.archive_url);
                write_opt(&mut out, "archive_sha256", &entry.archive_sha256);
                write_opt(&mut out, "cache_key_sha", &entry.cache_key_sha);
                write_opt(&mut out, "built_at", &entry.built_at);
                write_opt(&mut out, "built_by", &entry.built_by);
                write_opt(&mut out, "error", &entry.error);
                write_opt(&mut out, "last_attempt", &entry.last_attempt);
                write_opt(&mut out, "last_attempt_by", &entry.last_attempt_by);
                write_opt(
                    &mut out,
                    "fallback_archive_url",
                    &entry.fallback_archive_url,
                );
                write_opt(
                    &mut out,
                    "fallback_archive_sha256",
                    &entry.fallback_archive_sha256,
                );
                write_opt(
                    &mut out,
                    "fallback_cache_key_sha",
                    &entry.fallback_cache_key_sha,
                );
                write_opt(
                    &mut out,
                    "fallback_built_at",
                    &entry.fallback_built_at,
                );
            }
        }
        out
    }
}

fn write_opt(out: &mut String, key: &str, value: &Option<String>) {
    if let Some(v) = value {
        out.push_str(&format!("{key} = \"{}\"\n", escape(v)));
    }
}

/// Minimal TOML basic-string escaping: `\` and `"` need backslash
/// escapes; everything else we pass through. Schema values in
/// practice are ASCII-only filenames, sha hex, ISO-8601 timestamps,
/// and URLs — none of which carry control characters.
fn escape(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
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

    #[test]
    fn index_toml_round_trips_semantic_equality() {
        use super::*;
        use crate::pkg_manifest::TargetArch;

        let original = r#"
abi_version = 8
generated_at = "2026-05-13T00:00:00Z"
generator    = "test"

[[packages]]
name     = "foo"
version  = "1.0"
revision = 1

[packages.binary.wasm32]
status         = "success"
archive_url    = "foo.tar.zst"
archive_sha256 = "abc"
cache_key_sha  = "def"
built_at       = "2026-05-13T00:00:00Z"
built_by       = "https://example.com/run/1"
"#;
        let idx = IndexToml::parse(original).unwrap();
        let written = idx.write();
        let reparsed = IndexToml::parse(&written).unwrap();
        assert_eq!(reparsed, idx, "round-trip must preserve all fields");

        // Field order in the written output: `archive_url` precedes
        // `archive_sha256` precedes `cache_key_sha`. Schema order; not
        // alphabetical (which is what toml::to_string would do).
        let url_pos = written.find("archive_url").unwrap();
        let sha_pos = written.find("archive_sha256").unwrap();
        let ck_pos = written.find("cache_key_sha").unwrap();
        assert!(url_pos < sha_pos, "archive_url must come before archive_sha256");
        assert!(sha_pos < ck_pos, "archive_sha256 must come before cache_key_sha");
    }

    #[test]
    fn index_toml_write_sorts_packages_alphabetically() {
        use super::*;
        let mut idx = IndexToml::parse(r#"
abi_version = 8
generated_at = "t"
generator    = "test"

[[packages]]
name     = "zlib"
version  = "1.0"
revision = 1

[[packages]]
name     = "alpha"
version  = "0.1"
revision = 1
"#).unwrap();
        let _ = &mut idx; // silence unused-mut warning if any
        let s = idx.write();
        let alpha_pos = s.find("name = \"alpha\"").unwrap();
        let zlib_pos = s.find("name = \"zlib\"").unwrap();
        assert!(alpha_pos < zlib_pos, "packages must be alphabetized on write");
    }

    #[test]
    fn index_toml_write_omits_none_fields() {
        use super::*;
        use crate::pkg_manifest::TargetArch;

        let mut idx = IndexToml {
            abi_version: 8,
            generated_at: "now".into(),
            generator: "test".into(),
            packages: vec![PackageEntry {
                name: "foo".into(),
                version: "1.0".into(),
                revision: 1,
                binary: Default::default(),
            }],
        };
        idx.packages[0].binary.insert(
            TargetArch::Wasm32,
            BinaryEntry {
                status: EntryStatus::Pending,
                ..Default::default()
            },
        );
        let s = idx.write();
        assert!(!s.contains("archive_url"), "absent fields must not be emitted");
        assert!(!s.contains("error"), "absent fields must not be emitted");
        assert!(s.contains("status = \"pending\""));
    }
}
