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
