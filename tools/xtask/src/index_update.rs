//! `xtask index-update` — atomically mutate `index.toml` with the
//! result of one per-package matrix-build job.
//!
//! Called from `scripts/index-update.sh` (Phase 8) inside the
//! state-lock acquired for the target tag. Reads the current
//! `index.toml`, applies a success-or-failed update, writes the
//! result back. The lock + GitHub-release sequence around it
//! guarantees readers always see a consistent ledger.

use std::path::PathBuf;

use sha2::{Digest, Sha256};

use crate::index_toml::IndexToml;
use crate::pkg_manifest::TargetArch;
use crate::util::hex;

/// Entry point for `xtask index-update <args...>`. Parses
/// `--key value` pairs; required keys vary by `--status`:
///   * `--status success`: archive-path/--archive-name/--cache-key-sha
///     all required; sha256 is computed from `--archive-path`.
///   * `--status failed`: `--error` required; archive-* + cache-key
///     ignored. The current archive (if any) is moved to fallback.
///   * `--status pending|building`: only the entry's status changes;
///     fallback (if any) is preserved.
pub fn run_index_update(args: &[String]) -> Result<(), String> {
    let parsed = ParsedArgs::from(args)?;

    let index_text = std::fs::read_to_string(&parsed.index_path)
        .map_err(|e| format!("read {}: {e}", parsed.index_path.display()))?;
    let mut idx = IndexToml::parse(&index_text)
        .map_err(|e| format!("{}: {e}", parsed.index_path.display()))?;

    if let Some(expected_abi) = parsed.expected_abi {
        if idx.abi_version != expected_abi {
            eprintln!(
                "index-update: rewriting index abi_version {} -> {}",
                idx.abi_version, expected_abi
            );
            idx.abi_version = expected_abi;
        }
        let pruned = idx.prune_archive_abi_mismatches(expected_abi);
        if pruned > 0 {
            eprintln!(
                "index-update: pruned {pruned} archive entr{} whose filename ABI does not match {}",
                if pruned == 1 { "y" } else { "ies" },
                expected_abi
            );
        }
    }

    let arch = match parsed.arch.as_str() {
        "wasm32" => TargetArch::Wasm32,
        "wasm64" => TargetArch::Wasm64,
        other => return Err(format!("--arch must be wasm32 or wasm64, got {other:?}")),
    };

    match parsed.status.as_str() {
        "success" => {
            let archive_path = parsed
                .archive_path
                .as_ref()
                .ok_or("--status success requires --archive-path")?;
            let archive_name = parsed
                .archive_name
                .as_ref()
                .ok_or("--status success requires --archive-name")?;
            let cache_key_sha = parsed
                .cache_key_sha
                .as_ref()
                .ok_or("--status success requires --cache-key-sha")?;

            let bytes = std::fs::read(archive_path)
                .map_err(|e| format!("read {}: {e}", archive_path.display()))?;
            let mut h = Sha256::new();
            h.update(&bytes);
            let digest: [u8; 32] = h.finalize().into();
            let archive_sha256 = hex(&digest);

            idx.update_entry_success(
                &parsed.package,
                &parsed.version,
                parsed.revision,
                arch,
                archive_name.clone(),
                archive_sha256,
                cache_key_sha.clone(),
                parsed.built_at.clone(),
                parsed.built_by.clone(),
            );
        }
        "failed" => {
            let error = parsed
                .error
                .as_ref()
                .ok_or("--status failed requires --error")?;
            idx.update_entry_failed(
                &parsed.package,
                &parsed.version,
                parsed.revision,
                arch,
                error.clone(),
                parsed.built_at.clone(),
                parsed.built_by.clone(),
            );
        }
        other => {
            return Err(format!("--status must be success or failed, got {other:?}"));
        }
    }

    // Refresh `generated_at` so consumers can tell the ledger moved.
    idx.generated_at = parsed.built_at.clone();
    idx.validate_archive_abi_versions()?;

    std::fs::write(&parsed.index_path, idx.write())
        .map_err(|e| format!("write {}: {e}", parsed.index_path.display()))
}

struct ParsedArgs {
    index_path: PathBuf,
    package: String,
    version: String,
    revision: u32,
    arch: String,
    status: String,
    archive_path: Option<PathBuf>,
    archive_name: Option<String>,
    cache_key_sha: Option<String>,
    error: Option<String>,
    expected_abi: Option<u32>,
    built_at: String,
    built_by: String,
}

impl ParsedArgs {
    fn from(args: &[String]) -> Result<Self, String> {
        let mut index_path: Option<PathBuf> = None;
        let mut package: Option<String> = None;
        let mut version: Option<String> = None;
        let mut revision: Option<u32> = None;
        let mut arch: Option<String> = None;
        let mut status: Option<String> = None;
        let mut archive_path: Option<PathBuf> = None;
        let mut archive_name: Option<String> = None;
        let mut cache_key_sha: Option<String> = None;
        let mut error: Option<String> = None;
        let mut expected_abi: Option<u32> = None;
        let mut built_at: Option<String> = None;
        let mut built_by: Option<String> = None;

        let mut iter = args.iter();
        while let Some(key) = iter.next() {
            let value = iter
                .next()
                .ok_or_else(|| format!("{key} requires a value"))?
                .clone();
            match key.as_str() {
                "--index-path" => index_path = Some(PathBuf::from(value)),
                "--package" => package = Some(value),
                "--version" => version = Some(value),
                "--revision" => {
                    revision = Some(
                        value
                            .parse()
                            .map_err(|e| format!("--revision must be a positive integer ({e})"))?,
                    )
                }
                "--arch" => arch = Some(value),
                "--status" => status = Some(value),
                "--archive-path" => archive_path = Some(PathBuf::from(value)),
                "--archive-name" => archive_name = Some(value),
                "--cache-key-sha" => cache_key_sha = Some(value),
                "--error" => error = Some(value),
                "--expected-abi" => {
                    expected_abi =
                        Some(value.parse().map_err(|e| {
                            format!("--expected-abi must be a positive integer ({e})")
                        })?)
                }
                "--built-at" => built_at = Some(value),
                "--built-by" => built_by = Some(value),
                other => return Err(format!("unknown flag: {other}")),
            }
        }

        Ok(ParsedArgs {
            index_path: index_path.ok_or("missing --index-path")?,
            package: package.ok_or("missing --package")?,
            version: version.ok_or("missing --version")?,
            revision: revision.ok_or("missing --revision")?,
            arch: arch.ok_or("missing --arch")?,
            status: status.ok_or("missing --status")?,
            archive_path,
            archive_name,
            cache_key_sha,
            error,
            expected_abi,
            built_at: built_at.ok_or("missing --built-at")?,
            built_by: built_by.ok_or("missing --built-by")?,
        })
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn index_update_success_writes_entry_to_index() {
        use super::*;
        use crate::index_toml::{EntryStatus, IndexToml};
        use crate::pkg_manifest::TargetArch;

        let tmp = std::env::temp_dir().join(format!(
            "wpk-xtask-idx-update-{}-{}",
            std::process::id(),
            line!()
        ));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();

        let idx_path = tmp.join("index.toml");
        let empty = IndexToml::empty(8, "seeded".into(), "test-seed".into());
        std::fs::write(&idx_path, empty.write()).unwrap();

        let archive_path = tmp.join("foo-1.0-rev1-abi8-wasm32-deadbeef.tar.zst");
        std::fs::write(&archive_path, b"fake archive bytes").unwrap();

        run_index_update(&[
            "--index-path".to_string(),
            idx_path.to_string_lossy().into_owned(),
            "--package".to_string(),
            "foo".to_string(),
            "--version".to_string(),
            "1.0".to_string(),
            "--revision".to_string(),
            "1".to_string(),
            "--arch".to_string(),
            "wasm32".to_string(),
            "--status".to_string(),
            "success".to_string(),
            "--archive-path".to_string(),
            archive_path.to_string_lossy().into_owned(),
            "--archive-name".to_string(),
            "foo-1.0-rev1-abi8-wasm32-deadbeef.tar.zst".to_string(),
            "--cache-key-sha".to_string(),
            "deadbeefcafebabe".to_string(),
            "--built-at".to_string(),
            "2026-05-13T00:00:00Z".to_string(),
            "--built-by".to_string(),
            "https://example.com/run/1".to_string(),
        ])
        .unwrap();

        let updated = IndexToml::parse(&std::fs::read_to_string(&idx_path).unwrap()).unwrap();
        let entry = updated.lookup("foo", "1.0", TargetArch::Wasm32).unwrap();
        assert_eq!(entry.status, EntryStatus::Success);
        assert_eq!(
            entry.archive_url.as_deref(),
            Some("foo-1.0-rev1-abi8-wasm32-deadbeef.tar.zst")
        );
        assert_eq!(entry.cache_key_sha.as_deref(), Some("deadbeefcafebabe"));
        assert_eq!(entry.built_at.as_deref(), Some("2026-05-13T00:00:00Z"));
        assert_eq!(entry.built_by.as_deref(), Some("https://example.com/run/1"));

        // archive_sha256 is computed by the subcommand from the
        // archive file's bytes — not passed on the command line.
        // Verify it's the sha256 of the staged bytes.
        use sha2::{Digest, Sha256};
        let mut h = Sha256::new();
        h.update(b"fake archive bytes");
        let expected_sha: [u8; 32] = h.finalize().into();
        let expected_hex: String = expected_sha.iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(entry.archive_sha256.as_deref(), Some(expected_hex.as_str()));
    }

    #[test]
    fn index_update_failed_moves_existing_success_to_fallback() {
        use super::*;
        use crate::index_toml::{EntryStatus, IndexToml};
        use crate::pkg_manifest::TargetArch;

        let tmp = std::env::temp_dir().join(format!(
            "wpk-xtask-idx-update-failed-{}-{}",
            std::process::id(),
            line!()
        ));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();

        // Seed an index that already has a Success entry — the
        // failed path should preserve it as the fallback.
        let idx_path = tmp.join("index.toml");
        let mut idx = IndexToml::empty(8, "t1".into(), "test".into());
        idx.update_entry_success(
            "foo",
            "1.0",
            1,
            TargetArch::Wasm32,
            "foo-old.tar.zst".into(),
            "oldsha".into(),
            "oldkey".into(),
            "t1".into(),
            "run1".into(),
        );
        std::fs::write(&idx_path, idx.write()).unwrap();

        run_index_update(&[
            "--index-path".to_string(),
            idx_path.to_string_lossy().into_owned(),
            "--package".to_string(),
            "foo".to_string(),
            "--version".to_string(),
            "1.0".to_string(),
            "--revision".to_string(),
            "1".to_string(),
            "--arch".to_string(),
            "wasm32".to_string(),
            "--status".to_string(),
            "failed".to_string(),
            "--error".to_string(),
            "linker error".to_string(),
            "--built-at".to_string(),
            "t2".to_string(),
            "--built-by".to_string(),
            "https://example.com/run/2".to_string(),
        ])
        .unwrap();

        let updated = IndexToml::parse(&std::fs::read_to_string(&idx_path).unwrap()).unwrap();
        let entry = updated.lookup("foo", "1.0", TargetArch::Wasm32).unwrap();
        assert_eq!(entry.status, EntryStatus::Failed);
        assert_eq!(entry.error.as_deref(), Some("linker error"));
        assert!(entry.archive_url.is_none(), "current archive cleared");
        assert_eq!(
            entry.fallback_archive_url.as_deref(),
            Some("foo-old.tar.zst"),
            "prior success moved to fallback"
        );
        assert_eq!(entry.last_attempt.as_deref(), Some("t2"));
        assert_eq!(
            entry.last_attempt_by.as_deref(),
            Some("https://example.com/run/2")
        );
    }

    #[test]
    fn index_update_rewrites_stale_index_toml_abi_and_prunes_old_entries() {
        use super::*;
        use crate::index_toml::IndexToml;
        use crate::pkg_manifest::TargetArch;

        let tmp = std::env::temp_dir().join(format!(
            "wpk-xtask-idx-update-abi-rewrite-{}-{}",
            std::process::id(),
            line!()
        ));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();

        let idx_path = tmp.join("index.toml");
        let stale = r#"
abi_version = 12
generated_at = "old"
generator = "test"

[[packages]]
name = "old"
version = "1.0"
revision = 1

[packages.binary.wasm32]
status = "success"
archive_url = "old-1.0-rev1-abi12-wasm32-deadbeef.tar.zst"
archive_sha256 = "oldsha"
cache_key_sha = "oldkey"
"#;
        std::fs::write(&idx_path, stale).unwrap();

        let archive_path = tmp.join("new-1.0-rev1-abi13-wasm32-cafebabe.tar.zst");
        std::fs::write(&archive_path, b"new archive bytes").unwrap();

        run_index_update(&[
            "--index-path".to_string(),
            idx_path.to_string_lossy().into_owned(),
            "--package".to_string(),
            "new".to_string(),
            "--version".to_string(),
            "1.0".to_string(),
            "--revision".to_string(),
            "1".to_string(),
            "--arch".to_string(),
            "wasm32".to_string(),
            "--status".to_string(),
            "success".to_string(),
            "--archive-path".to_string(),
            archive_path.to_string_lossy().into_owned(),
            "--archive-name".to_string(),
            "new-1.0-rev1-abi13-wasm32-cafebabe.tar.zst".to_string(),
            "--cache-key-sha".to_string(),
            "cafebabecafebabe".to_string(),
            "--expected-abi".to_string(),
            "13".to_string(),
            "--built-at".to_string(),
            "2026-05-13T00:00:00Z".to_string(),
            "--built-by".to_string(),
            "https://example.com/run/1".to_string(),
        ])
        .unwrap();

        let updated = IndexToml::parse(&std::fs::read_to_string(&idx_path).unwrap()).unwrap();
        assert_eq!(updated.abi_version, 13);
        assert!(updated.lookup("old", "1.0", TargetArch::Wasm32).is_none());
        assert!(updated.lookup("new", "1.0", TargetArch::Wasm32).is_some());
        updated.validate_archive_abi_versions().unwrap();
    }

    #[test]
    fn index_update_preserves_durable_index_toml_abi_from_expected_tag() {
        use super::*;
        use crate::index_toml::IndexToml;

        let tmp = std::env::temp_dir().join(format!(
            "wpk-xtask-idx-update-durable-abi-{}-{}",
            std::process::id(),
            line!()
        ));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();

        let idx_path = tmp.join("index.toml");
        let empty = IndexToml::empty(42, "seeded".into(), "test-seed".into());
        std::fs::write(&idx_path, empty.write()).unwrap();

        let archive_path = tmp.join("foo-1.0-rev1-abi42-wasm32-deadbeef.tar.zst");
        std::fs::write(&archive_path, b"archive bytes").unwrap();

        run_index_update(&[
            "--index-path".to_string(),
            idx_path.to_string_lossy().into_owned(),
            "--package".to_string(),
            "foo".to_string(),
            "--version".to_string(),
            "1.0".to_string(),
            "--revision".to_string(),
            "1".to_string(),
            "--arch".to_string(),
            "wasm32".to_string(),
            "--status".to_string(),
            "success".to_string(),
            "--archive-path".to_string(),
            archive_path.to_string_lossy().into_owned(),
            "--archive-name".to_string(),
            "foo-1.0-rev1-abi42-wasm32-deadbeef.tar.zst".to_string(),
            "--cache-key-sha".to_string(),
            "deadbeefcafebabe".to_string(),
            "--expected-abi".to_string(),
            "42".to_string(),
            "--built-at".to_string(),
            "2026-05-13T00:00:00Z".to_string(),
            "--built-by".to_string(),
            "https://example.com/run/1".to_string(),
        ])
        .unwrap();

        let updated = IndexToml::parse(&std::fs::read_to_string(&idx_path).unwrap()).unwrap();
        assert_eq!(updated.abi_version, 42);
        updated.validate_archive_abi_versions().unwrap();
    }

    #[test]
    fn index_update_rejects_mixed_index_toml_archive_abis() {
        use super::*;

        let tmp = std::env::temp_dir().join(format!(
            "wpk-xtask-idx-update-mixed-abi-{}-{}",
            std::process::id(),
            line!()
        ));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();

        let idx_path = tmp.join("index.toml");
        std::fs::write(
            &idx_path,
            r#"
abi_version = 13
generated_at = "old"
generator = "test"

[[packages]]
name = "old"
version = "1.0"
revision = 1

[packages.binary.wasm32]
status = "success"
archive_url = "old-1.0-rev1-abi12-wasm32-deadbeef.tar.zst"
archive_sha256 = "oldsha"
cache_key_sha = "oldkey"
"#,
        )
        .unwrap();

        let archive_path = tmp.join("new-1.0-rev1-abi13-wasm32-cafebabe.tar.zst");
        std::fs::write(&archive_path, b"new archive bytes").unwrap();

        let err = run_index_update(&[
            "--index-path".to_string(),
            idx_path.to_string_lossy().into_owned(),
            "--package".to_string(),
            "new".to_string(),
            "--version".to_string(),
            "1.0".to_string(),
            "--revision".to_string(),
            "1".to_string(),
            "--arch".to_string(),
            "wasm32".to_string(),
            "--status".to_string(),
            "success".to_string(),
            "--archive-path".to_string(),
            archive_path.to_string_lossy().into_owned(),
            "--archive-name".to_string(),
            "new-1.0-rev1-abi13-wasm32-cafebabe.tar.zst".to_string(),
            "--cache-key-sha".to_string(),
            "cafebabecafebabe".to_string(),
            "--built-at".to_string(),
            "2026-05-13T00:00:00Z".to_string(),
            "--built-by".to_string(),
            "https://example.com/run/1".to_string(),
        ])
        .unwrap_err();

        assert!(err.contains("abi_version 13"), "got: {err}");
        assert!(err.contains("ABI 12"), "got: {err}");
    }

    #[test]
    fn index_update_rejects_unknown_flag() {
        use super::*;
        let err = run_index_update(&[
            "--index-path".to_string(),
            "/tmp/nope.toml".to_string(),
            "--bogus".to_string(),
            "value".to_string(),
        ])
        .unwrap_err();
        assert!(err.contains("unknown flag"), "got: {err}");
    }

    #[test]
    fn index_update_rejects_missing_required_flag() {
        use super::*;
        // Missing --status (and the others) should fail with a clear
        // error before we try to do anything.
        let err = run_index_update(&[
            "--index-path".to_string(),
            "/tmp/nope.toml".to_string(),
            "--package".to_string(),
            "foo".to_string(),
        ])
        .unwrap_err();
        assert!(err.contains("missing"), "got: {err}");
    }
}
