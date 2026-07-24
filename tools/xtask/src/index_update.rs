//! `xtask index-update` — mutate a local `index.toml` with one package-build
//! result, or repair release-level index metadata without touching an entry.
//!
//! `scripts/index-update.sh` uses it inside a release state-lock for candidate
//! and canonical per-entry publication. PR staging calls it only while
//! composing all immutable matrix artifacts offline; the single finalizer
//! validates the complete result before any release write.

use std::io::Read;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::index_toml::IndexToml;
use crate::pkg_manifest::{DepsManifest, TargetArch};
use crate::util::hex;

/// Entry point for `xtask index-update <args...>`. Parses
/// `--key value` pairs; required keys vary by `--status`:
///   * `--status success`: archive-path/--archive-name/--cache-key-sha
///     all required; sha256 is computed from `--archive-path`.
///   * `--status failed`: `--error` required; archive-* + cache-key
///     ignored. The current archive (if any) is moved to fallback.
///   * `--status repair`: only the top-level index metadata is repaired.
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

    if parsed.replace_package_version {
        let package = parsed
            .package
            .as_deref()
            .ok_or("--replace-package-version requires --package")?;
        let version = parsed
            .version
            .as_deref()
            .ok_or("--replace-package-version requires --version")?;
        if parsed.status == "repair" {
            return Err("--replace-package-version cannot be used with --status repair".into());
        }
        let removed = idx.retain_package_version(package, version);
        if removed > 0 {
            eprintln!(
                "index-update: replaced {removed} stale version block(s) for {package} with {version}"
            );
        }
    }

    let arch = match parsed.arch.as_deref() {
        Some("wasm32") => Some(TargetArch::Wasm32),
        Some("wasm64") => Some(TargetArch::Wasm64),
        Some(other) => return Err(format!("--arch must be wasm32 or wasm64, got {other:?}")),
        None => None,
    };

    match parsed.status.as_str() {
        "success" => {
            let package = parsed
                .package
                .as_deref()
                .ok_or("--status success requires --package")?;
            let version = parsed
                .version
                .as_deref()
                .ok_or("--status success requires --version")?;
            let revision = parsed
                .revision
                .ok_or("--status success requires --revision")?;
            let arch = arch.ok_or("--status success requires --arch")?;
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
            validate_cache_key_sha(cache_key_sha, "--cache-key-sha")?;
            validate_archive_matches_entry(
                archive_path,
                archive_name,
                &bytes,
                package,
                version,
                revision,
                arch,
                idx.abi_version,
                cache_key_sha,
            )?;

            idx.update_entry_success(
                package,
                version,
                revision,
                arch,
                archive_name.clone(),
                archive_sha256,
                cache_key_sha.clone(),
                parsed.built_at.clone(),
                parsed.built_by.clone(),
            );
        }
        "failed" => {
            let package = parsed
                .package
                .as_deref()
                .ok_or("--status failed requires --package")?;
            let version = parsed
                .version
                .as_deref()
                .ok_or("--status failed requires --version")?;
            let revision = parsed
                .revision
                .ok_or("--status failed requires --revision")?;
            let arch = arch.ok_or("--status failed requires --arch")?;
            let error = parsed
                .error
                .as_ref()
                .ok_or("--status failed requires --error")?;
            idx.update_entry_failed(
                package,
                version,
                revision,
                arch,
                error.clone(),
                parsed.built_at.clone(),
                parsed.built_by.clone(),
            );
        }
        "repair" => {
            parsed
                .expected_abi
                .ok_or("--status repair requires --expected-abi")?;
        }
        other => {
            return Err(format!(
                "--status must be success, failed, or repair, got {other:?}"
            ));
        }
    }

    // Refresh `generated_at` so consumers can tell the ledger moved.
    idx.generated_at = parsed.built_at.clone();
    idx.validate_archive_abi_versions()?;

    std::fs::write(&parsed.index_path, idx.write())
        .map_err(|e| format!("write {}: {e}", parsed.index_path.display()))
}

struct ArchiveManifestInfo {
    name: String,
    version: String,
    revision: u32,
    target_arch: TargetArch,
    abi_versions: Vec<u32>,
    cache_key_sha: String,
}

fn validate_cache_key_sha(value: &str, flag: &str) -> Result<(), String> {
    if value.len() != 64
        || !value
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_uppercase())
    {
        return Err(format!(
            "{flag} must be a 64-char lowercase hex cache_key_sha, got {value:?}"
        ));
    }
    Ok(())
}

fn validate_archive_matches_entry(
    archive_path: &Path,
    archive_name: &str,
    bytes: &[u8],
    package: &str,
    version: &str,
    revision: u32,
    arch: TargetArch,
    abi_version: u32,
    cache_key_sha: &str,
) -> Result<(), String> {
    let path_file_name = archive_path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| {
            format!(
                "archive {}: path has no UTF-8 filename to compare with --archive-name",
                archive_path.display()
            )
        })?;
    if path_file_name != archive_name {
        return Err(format!(
            "archive {}: filename {:?} does not match --archive-name {:?}",
            archive_path.display(),
            path_file_name,
            archive_name
        ));
    }

    let expected_suffix = format!("-{}.tar.zst", &cache_key_sha[..8]);
    if !archive_name.ends_with(&expected_suffix) {
        return Err(format!(
            "archive {archive_name:?}: filename suffix does not match --cache-key-sha \
             {cache_key_sha}; expected suffix {expected_suffix:?}"
        ));
    }

    let info = read_archive_manifest_info(bytes)
        .map_err(|e| format!("archive {}: {e}", archive_path.display()))?;
    if info.name != package {
        return Err(format!(
            "archive {archive_name:?}: manifest name {:?} does not match --package {:?}",
            info.name, package
        ));
    }
    if info.version != version {
        return Err(format!(
            "archive {archive_name:?}: manifest version {:?} does not match --version {:?}",
            info.version, version
        ));
    }
    if info.revision != revision {
        return Err(format!(
            "archive {archive_name:?}: manifest revision {} does not match --revision {}",
            info.revision, revision
        ));
    }
    if info.target_arch != arch {
        return Err(format!(
            "archive {archive_name:?}: manifest target_arch {:?} does not match --arch {}",
            info.target_arch,
            arch.as_str()
        ));
    }
    if !info.abi_versions.contains(&abi_version) {
        return Err(format!(
            "archive {archive_name:?}: manifest abi_versions {:?} does not include index ABI {}",
            info.abi_versions, abi_version
        ));
    }
    if info.cache_key_sha != cache_key_sha {
        return Err(format!(
            "archive {archive_name:?}: manifest cache_key_sha {} does not match \
             --cache-key-sha {}",
            info.cache_key_sha, cache_key_sha
        ));
    }
    Ok(())
}

fn read_archive_manifest_info(bytes: &[u8]) -> Result<ArchiveManifestInfo, String> {
    let decoder =
        zstd::stream::read::Decoder::new(bytes).map_err(|e| format!("zstd decode: {e}"))?;
    let mut tar = tar::Archive::new(decoder);
    let entries = tar.entries().map_err(|e| format!("tar entries: {e}"))?;
    for entry in entries {
        let mut entry = entry.map_err(|e| format!("tar entry: {e}"))?;
        let path = entry
            .path()
            .map_err(|e| format!("tar entry path: {e}"))?
            .into_owned();
        if path.as_path() != Path::new("manifest.toml") {
            continue;
        }
        let mut text = String::new();
        entry
            .read_to_string(&mut text)
            .map_err(|e| format!("read manifest.toml: {e}"))?;
        let archived = DepsManifest::parse_archived(&text, PathBuf::from("/dev/null"))?;
        let compat = archived
            .compatibility
            .as_ref()
            .ok_or_else(|| "archived manifest missing [compatibility]".to_string())?;
        return Ok(ArchiveManifestInfo {
            name: archived.name.clone(),
            version: archived.version.clone(),
            revision: archived.revision,
            target_arch: compat.target_arch,
            abi_versions: compat.abi_versions.clone(),
            cache_key_sha: compat.cache_key_sha.clone(),
        });
    }
    Err("archive missing manifest.toml at the root".to_string())
}

struct ParsedArgs {
    index_path: PathBuf,
    package: Option<String>,
    version: Option<String>,
    revision: Option<u32>,
    arch: Option<String>,
    status: String,
    archive_path: Option<PathBuf>,
    archive_name: Option<String>,
    cache_key_sha: Option<String>,
    error: Option<String>,
    expected_abi: Option<u32>,
    built_at: String,
    built_by: String,
    replace_package_version: bool,
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
        let mut replace_package_version = false;

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
                "--replace-package-version" => {
                    replace_package_version = match value.as_str() {
                        "true" => true,
                        "false" => false,
                        _ => {
                            return Err("--replace-package-version must be true or false".into());
                        }
                    }
                }
                other => return Err(format!("unknown flag: {other}")),
            }
        }

        Ok(ParsedArgs {
            index_path: index_path.ok_or("missing --index-path")?,
            package,
            version,
            revision,
            arch,
            status: status.ok_or("missing --status")?,
            archive_path,
            archive_name,
            cache_key_sha,
            error,
            expected_abi,
            built_at: built_at.ok_or("missing --built-at")?,
            built_by: built_by.ok_or("missing --built-by")?,
            replace_package_version,
        })
    }
}

#[cfg(test)]
mod tests {
    fn write_test_archive(
        path: &std::path::Path,
        name: &str,
        version: &str,
        revision: u32,
        abi: u32,
        target_arch: &str,
        cache_key_sha: &str,
    ) {
        use std::io::Write;

        let manifest = format!(
            r#"
kind = "library"
name = "{name}"
version = "{version}"
revision = {revision}

[source]
url = "file:///dev/null"
sha256 = "{source_sha}"

[license]
spdx = "TestLicense"

[outputs]
libs = ["lib/lib{name}.a"]

[compatibility]
target_arch = "{target_arch}"
abi_versions = [{abi}]
cache_key_sha = "{cache_key_sha}"
build_timestamp = "2026-05-13T00:00:00Z"
build_host = "test-host"
"#,
            source_sha = "0".repeat(64),
        );

        let mut tar_bytes = Vec::new();
        {
            let mut builder = tar::Builder::new(&mut tar_bytes);
            let mut header = tar::Header::new_gnu();
            header.set_size(manifest.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            builder
                .append_data(&mut header, "manifest.toml", manifest.as_bytes())
                .unwrap();
            builder.finish().unwrap();
        }

        let mut zst_bytes = Vec::new();
        {
            let mut encoder = zstd::stream::write::Encoder::new(&mut zst_bytes, 0).unwrap();
            encoder.write_all(&tar_bytes).unwrap();
            encoder.finish().unwrap();
        }
        std::fs::write(path, zst_bytes).unwrap();
    }

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
        let cache_key = "deadbeef".repeat(8);
        write_test_archive(&archive_path, "foo", "1.0", 1, 8, "wasm32", &cache_key);

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
            cache_key.clone(),
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
        assert_eq!(entry.cache_key_sha.as_deref(), Some(cache_key.as_str()));
        assert_eq!(entry.built_at.as_deref(), Some("2026-05-13T00:00:00Z"));
        assert_eq!(entry.built_by.as_deref(), Some("https://example.com/run/1"));

        // archive_sha256 is computed by the subcommand from the
        // archive file's bytes — not passed on the command line.
        // Verify it's the sha256 of the staged bytes.
        use sha2::{Digest, Sha256};
        let mut h = Sha256::new();
        h.update(std::fs::read(&archive_path).unwrap());
        let expected_sha: [u8; 32] = h.finalize().into();
        let expected_hex: String = expected_sha.iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(entry.archive_sha256.as_deref(), Some(expected_hex.as_str()));
    }

    #[test]
    fn index_update_rejects_archive_cache_key_mismatch() {
        use super::*;
        use crate::index_toml::IndexToml;

        let tmp = std::env::temp_dir().join(format!(
            "wpk-xtask-idx-update-key-mismatch-{}-{}",
            std::process::id(),
            line!()
        ));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();

        let idx_path = tmp.join("index.toml");
        let empty = IndexToml::empty(8, "seeded".into(), "test-seed".into());
        std::fs::write(&idx_path, empty.write()).unwrap();

        let archive_path = tmp.join("foo-1.0-rev1-abi8-wasm32-deadbeef.tar.zst");
        let requested_key = "deadbeef".repeat(8);
        let archived_key = "cafebabe".repeat(8);
        write_test_archive(&archive_path, "foo", "1.0", 1, 8, "wasm32", &archived_key);

        let err = run_index_update(&[
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
            requested_key,
            "--built-at".to_string(),
            "2026-05-13T00:00:00Z".to_string(),
            "--built-by".to_string(),
            "https://example.com/run/1".to_string(),
        ])
        .unwrap_err();

        assert!(err.contains("manifest cache_key_sha"), "got: {err}");
        assert!(err.contains("does not match --cache-key-sha"), "got: {err}");
    }

    #[test]
    fn index_update_rejects_archive_path_name_mismatch() {
        use super::*;
        use crate::index_toml::IndexToml;

        let tmp = std::env::temp_dir().join(format!(
            "wpk-xtask-idx-update-name-mismatch-{}-{}",
            std::process::id(),
            line!()
        ));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();

        let idx_path = tmp.join("index.toml");
        let empty = IndexToml::empty(8, "seeded".into(), "test-seed".into());
        std::fs::write(&idx_path, empty.write()).unwrap();

        let archive_path = tmp.join("foo-1.0-rev1-abi8-wasm32-deadbeef.tar.zst");
        let cache_key = "deadbeef".repeat(8);
        write_test_archive(&archive_path, "foo", "1.0", 1, 8, "wasm32", &cache_key);

        let err = run_index_update(&[
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
            "other-1.0-rev1-abi8-wasm32-deadbeef.tar.zst".to_string(),
            "--cache-key-sha".to_string(),
            cache_key,
            "--built-at".to_string(),
            "2026-05-13T00:00:00Z".to_string(),
            "--built-by".to_string(),
            "https://example.com/run/1".to_string(),
        ])
        .unwrap_err();

        assert!(err.contains("filename"), "got: {err}");
        assert!(err.contains("does not match --archive-name"), "got: {err}");
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
    fn index_update_can_replace_the_previous_managed_package_version() {
        use super::*;
        use crate::index_toml::{EntryStatus, IndexToml};
        use crate::pkg_manifest::TargetArch;

        let tmp = std::env::temp_dir().join(format!(
            "wpk-xtask-idx-update-replace-version-{}-{}",
            std::process::id(),
            line!()
        ));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();

        let idx_path = tmp.join("index.toml");
        let mut idx = IndexToml::empty(8, "seeded".into(), "test-seed".into());
        idx.update_entry_success(
            "foo",
            "1.0",
            1,
            TargetArch::Wasm32,
            "foo-1.0-rev1-abi8-wasm32-11111111.tar.zst".into(),
            "1".repeat(64),
            "1".repeat(64),
            "t1".into(),
            "run1".into(),
        );
        std::fs::write(&idx_path, idx.write()).unwrap();

        let archive_path = tmp.join("foo-2.0-rev1-abi8-wasm32-deadbeef.tar.zst");
        let cache_key = "deadbeef".repeat(8);
        write_test_archive(&archive_path, "foo", "2.0", 1, 8, "wasm32", &cache_key);

        run_index_update(&[
            "--index-path".to_string(),
            idx_path.to_string_lossy().into_owned(),
            "--package".to_string(),
            "foo".to_string(),
            "--version".to_string(),
            "2.0".to_string(),
            "--revision".to_string(),
            "1".to_string(),
            "--arch".to_string(),
            "wasm32".to_string(),
            "--status".to_string(),
            "success".to_string(),
            "--archive-path".to_string(),
            archive_path.to_string_lossy().into_owned(),
            "--archive-name".to_string(),
            "foo-2.0-rev1-abi8-wasm32-deadbeef.tar.zst".to_string(),
            "--cache-key-sha".to_string(),
            cache_key,
            "--replace-package-version".to_string(),
            "true".to_string(),
            "--built-at".to_string(),
            "t2".to_string(),
            "--built-by".to_string(),
            "run2".to_string(),
        ])
        .unwrap();

        let updated = IndexToml::parse(&std::fs::read_to_string(&idx_path).unwrap()).unwrap();
        assert!(updated.lookup("foo", "1.0", TargetArch::Wasm32).is_none());
        assert_eq!(
            updated
                .lookup("foo", "2.0", TargetArch::Wasm32)
                .unwrap()
                .status,
            EntryStatus::Success
        );
        assert_eq!(
            updated
                .packages
                .iter()
                .filter(|package| package.name == "foo")
                .count(),
            1
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
        let cache_key = "cafebabe".repeat(8);
        write_test_archive(&archive_path, "new", "1.0", 1, 13, "wasm32", &cache_key);

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
            cache_key,
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
    fn index_update_repair_rewrites_stale_index_toml_abi() {
        use super::*;
        use crate::index_toml::IndexToml;
        use crate::pkg_manifest::TargetArch;

        let tmp = std::env::temp_dir().join(format!(
            "wpk-xtask-idx-update-repair-{}-{}",
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
name = "bc"
version = "1.0"
revision = 1

[packages.binary.wasm32]
status = "success"
archive_url = "bc-1.0-rev1-abi13-wasm32-deadbeef.tar.zst"
archive_sha256 = "oldsha"
cache_key_sha = "oldkey"
"#;
        std::fs::write(&idx_path, stale).unwrap();

        run_index_update(&[
            "--index-path".to_string(),
            idx_path.to_string_lossy().into_owned(),
            "--status".to_string(),
            "repair".to_string(),
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
        assert!(updated.lookup("bc", "1.0", TargetArch::Wasm32).is_some());
        assert_eq!(updated.generated_at, "2026-05-13T00:00:00Z");
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
        let cache_key = "deadbeef".repeat(8);
        write_test_archive(&archive_path, "foo", "1.0", 1, 42, "wasm32", &cache_key);

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
            cache_key,
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
        let cache_key = "cafebabe".repeat(8);
        write_test_archive(&archive_path, "new", "1.0", 1, 13, "wasm32", &cache_key);

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
            cache_key,
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
