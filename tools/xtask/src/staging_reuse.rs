//! Strict validation for reusing a mutable PR-staging package release.
//!
//! Direct release reuse requires complete exact-current package/arch coverage.
//! Baseline freeze is narrower: it emits only exact-current usable canonical
//! entries and leaves missing, stale, transient, or fallback-less failed keys
//! for the matrix to recreate before final exact validation.

use std::collections::{BTreeMap, BTreeSet};
use std::io::Read;
use std::path::Path;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::build_deps::{Registry, compute_cache_key_sha_for_package};
use crate::index_toml::{BinaryEntry, EntryStatus, IndexToml};
use crate::pkg_manifest::{
    BuildToml, DepsManifest, GitBuildInput, ManifestKind, TargetArch, validate_git_build_inputs,
};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
struct ExpectedLedger {
    abi_version: u32,
    entries: Vec<ExpectedEntry>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
struct ExpectedEntry {
    package: String,
    kind: ExpectedKind,
    arch: TargetArch,
    version: String,
    revision: u32,
    cache_key_sha: String,
    git_inputs: Vec<GitBuildInput>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum ExpectedKind {
    Library,
    Program,
}

#[derive(Clone, Debug, Deserialize)]
struct ReleaseAsset {
    name: String,
    state: String,
    size: u64,
    digest: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
struct ValidatedSnapshot {
    abi_version: u32,
    release_tag: String,
    complete_current: bool,
    entries: Vec<ValidatedEntry>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
struct ValidatedEntry {
    package: String,
    kind: ExpectedKind,
    arch: TargetArch,
    version: String,
    revision: u32,
    cache_key_sha: String,
    current: bool,
    from_fallback: bool,
    asset: String,
    archive_sha256: String,
    size: u64,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
struct FinalAsset {
    name: String,
    sha256: String,
    size: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ValidationMode {
    /// Freeze exact-current usable entries from a canonical baseline. Missing,
    /// stale, transient, and failed-without-fallback keys become matrix-owned
    /// gaps. The final staging validator still requires complete composition.
    Available,
    Structural,
    Current,
    Testable,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ArchiveValidationScope {
    /// Validate every downloaded archive in a materialized snapshot.
    All,
    /// Validate every downloaded archive while allowing the baseline snapshot
    /// to omit expected keys that canonical cannot currently supply.
    Available,
    /// Metadata-only preflight downloads only entries that are current and
    /// declare external Git provenance. Other entries cannot be selected under
    /// a forged-equal Git identity because they have no such identity.
    CurrentDeclaredGitInputs,
}

pub(crate) fn run(args: Vec<String>) -> Result<(), String> {
    let Some((action, rest)) = args.split_first() else {
        return Err(
            "usage: xtask staging-reuse <expected|validate|validate-archives|compose|trim-index|finalize-validate> [args]"
                .into(),
        );
    };
    match action.as_str() {
        "expected" => run_expected(rest),
        "validate" => run_validate(rest),
        "validate-archives" => run_validate_archives(rest),
        "compose" => run_compose(rest),
        "trim-index" => run_trim_index(rest),
        "finalize-validate" => run_finalize_validate(rest),
        other => Err(format!(
            "staging-reuse action must be expected, validate, validate-archives, compose, trim-index, or finalize-validate, got {other:?}"
        )),
    }
}

fn run_trim_index(args: &[String]) -> Result<(), String> {
    let flags = Flags::parse(args)?;
    flags.reject_unknown(&["--expected-ledger", "--index", "--output"])?;
    let expected: ExpectedLedger = read_json(flags.required_path("--expected-ledger")?)?;
    validate_expected_ledger(&expected)?;
    let mut index = read_index(flags.required_path("--index")?)?;
    if index.abi_version != expected.abi_version {
        return Err(format!(
            "staging base index ABI {} does not match expected ABI {}",
            index.abi_version, expected.abi_version
        ));
    }

    let expected_arches: BTreeMap<&str, BTreeSet<TargetArch>> =
        expected
            .entries
            .iter()
            .fold(BTreeMap::new(), |mut arches, entry| {
                arches
                    .entry(entry.package.as_str())
                    .or_default()
                    .insert(entry.arch);
                arches
            });
    // WHY: the canonical release may contain intentionally disabled or
    // historical packages. A PR-staging snapshot must not reference those
    // unrelated assets, otherwise "self-contained" silently means copying
    // the entire canonical release on every PR.
    index.packages.retain_mut(|package| {
        let Some(arches) = expected_arches.get(package.name.as_str()) else {
            return false;
        };
        package.binary.retain(|arch, _| arches.contains(arch));
        !package.binary.is_empty()
    });
    index.generator = "xtask staging-reuse trim-index".into();
    index.validate_archive_abi_versions()?;
    std::fs::write(flags.required_path("--output")?, index.write())
        .map_err(|e| format!("write trimmed index: {e}"))
}

fn run_finalize_validate(args: &[String]) -> Result<(), String> {
    let flags = Flags::parse(args)?;
    flags.reject_unknown(&[
        "--expected-ledger",
        "--index",
        "--archives-dir",
        "--allow-failed",
        "--output-assets",
    ])?;
    let expected: ExpectedLedger = read_json(flags.required_path("--expected-ledger")?)?;
    validate_expected_ledger(&expected)?;
    let index = read_index(flags.required_path("--index")?)?;
    let archives_dir = flags.required_path("--archives-dir")?;
    let allow_failed = match flags.required("--allow-failed")? {
        "true" => true,
        "false" => false,
        other => {
            return Err(format!(
                "--allow-failed must be true or false, got {other:?}"
            ));
        }
    };
    let assets = validate_finalized_index(&expected, &index, archives_dir, allow_failed)?;
    write_json(flags.required_path("--output-assets")?, &assets)
}

fn run_compose(args: &[String]) -> Result<(), String> {
    let flags = Flags::parse(args)?;
    flags.reject_unknown(&[
        "--base-index",
        "--overlay-index",
        "--overlay-expected-ledger",
        "--output",
    ])?;
    let base_path = flags.required_path("--base-index")?;
    let overlay_path = flags.required_path("--overlay-index")?;
    let expected: ExpectedLedger = read_json(flags.required_path("--overlay-expected-ledger")?)?;
    validate_expected_ledger(&expected)?;
    let base = read_index(base_path)?;
    let overlay = read_index(overlay_path)?;
    let composed = compose_indexes(&base, &overlay, &expected)?;
    std::fs::write(flags.required_path("--output")?, composed.write())
        .map_err(|e| format!("write composed index: {e}"))
}

fn read_index(path: &Path) -> Result<IndexToml, String> {
    let text =
        std::fs::read_to_string(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    IndexToml::parse(&text).map_err(|e| format!("{}: {e}", path.display()))
}

fn run_expected(args: &[String]) -> Result<(), String> {
    let flags = Flags::parse(args)?;
    flags.reject_unknown(&["--registry", "--expected-abi", "--exclude", "--output"])?;
    let registry = flags.required_path("--registry")?;
    let abi = flags.required_u32("--expected-abi")?;
    let output = flags.required_path("--output")?;
    let excluded: BTreeSet<String> = flags
        .values("--exclude")
        .flat_map(|value| value.split(','))
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .collect();
    let ledger = build_expected_ledger(registry, abi, &excluded)?;
    write_json(output, &ledger)
}

fn run_validate(args: &[String]) -> Result<(), String> {
    let flags = Flags::parse(args)?;
    flags.reject_unknown(&[
        "--expected-ledger",
        "--index",
        "--assets",
        "--release-tag",
        "--release-base-url",
        "--mode",
        "--output",
        "--localized-index",
    ])?;
    let expected: ExpectedLedger = read_json(flags.required_path("--expected-ledger")?)?;
    let index_path = flags.required_path("--index")?;
    let index_text = std::fs::read_to_string(index_path)
        .map_err(|e| format!("read {}: {e}", index_path.display()))?;
    let index =
        IndexToml::parse(&index_text).map_err(|e| format!("{}: {e}", index_path.display()))?;
    let assets: Vec<ReleaseAsset> = read_json(flags.required_path("--assets")?)?;
    let release_tag = flags.required("--release-tag")?;
    validate_release_tag(release_tag)?;
    let release_base_url = flags.required("--release-base-url")?;
    validate_release_base_url(release_base_url, release_tag)?;
    let mode = match flags.required("--mode")? {
        "available" => ValidationMode::Available,
        "structural" => ValidationMode::Structural,
        "current" => ValidationMode::Current,
        "testable" => ValidationMode::Testable,
        other => {
            return Err(format!(
                "--mode must be available, structural, current, or testable, got {other:?}"
            ));
        }
    };
    let snapshot = validate_release(
        &expected,
        &index,
        &assets,
        release_tag,
        release_base_url,
        mode,
    )?;
    let localized = localize_index(
        &index,
        &snapshot,
        (mode == ValidationMode::Available).then_some(&expected),
    )?;
    std::fs::write(flags.required_path("--localized-index")?, localized.write())
        .map_err(|e| format!("write localized index: {e}"))?;
    write_json(flags.required_path("--output")?, &snapshot)
}

fn run_validate_archives(args: &[String]) -> Result<(), String> {
    let flags = Flags::parse(args)?;
    flags.reject_unknown(&[
        "--expected-ledger",
        "--snapshot",
        "--archives-dir",
        "--scope",
    ])?;
    let expected: ExpectedLedger = read_json(flags.required_path("--expected-ledger")?)?;
    let snapshot: ValidatedSnapshot = read_json(flags.required_path("--snapshot")?)?;
    let scope = match flags.required("--scope")? {
        "all" => ArchiveValidationScope::All,
        "available" => ArchiveValidationScope::Available,
        "current-declared-git-inputs" => ArchiveValidationScope::CurrentDeclaredGitInputs,
        other => {
            return Err(format!(
                "--scope must be all, available, or current-declared-git-inputs, got {other:?}"
            ));
        }
    };
    validate_archive_snapshot(
        &expected,
        &snapshot,
        flags.required_path("--archives-dir")?,
        scope,
    )
}

fn build_expected_ledger(
    registry_path: &Path,
    abi_version: u32,
    excluded: &BTreeSet<String>,
) -> Result<ExpectedLedger, String> {
    let registry = Registry {
        roots: vec![registry_path.to_path_buf()],
    };
    let mut dirs = Vec::new();
    for entry in std::fs::read_dir(registry_path)
        .map_err(|e| format!("read registry {}: {e}", registry_path.display()))?
    {
        let entry = entry.map_err(|e| format!("read registry entry: {e}"))?;
        if entry.path().join("package.toml").is_file() {
            dirs.push(entry.path());
        }
    }
    dirs.sort();

    let mut entries = Vec::new();
    let mut keys = BTreeSet::new();
    for package_dir in dirs {
        let manifest = DepsManifest::load_with_overlay(&package_dir)?;
        if excluded.contains(&manifest.name) || manifest.build.script_path.is_none() {
            continue;
        }
        let kind = match manifest.kind {
            ManifestKind::Library => ExpectedKind::Library,
            ManifestKind::Program => ExpectedKind::Program,
            ManifestKind::Source => continue,
        };
        let git_inputs = if package_dir.join("build.toml").exists() {
            BuildToml::load(&package_dir)?.git_inputs
        } else {
            Vec::new()
        };
        for &arch in &manifest.target_arches {
            let key = (manifest.name.clone(), arch);
            if !keys.insert(key.clone()) {
                return Err(format!(
                    "expected ledger contains duplicate package/arch {} {}",
                    key.0,
                    key.1.as_str()
                ));
            }
            let cache_key_sha =
                compute_cache_key_sha_for_package(&package_dir, &registry, arch, abi_version)?;
            validate_sha256(&cache_key_sha, "computed cache_key_sha")?;
            entries.push(ExpectedEntry {
                package: manifest.name.clone(),
                kind,
                arch,
                version: manifest.version.clone(),
                revision: manifest.revision,
                cache_key_sha,
                git_inputs: git_inputs.clone(),
            });
        }
    }
    entries.sort_by(|a, b| (&a.package, a.arch).cmp(&(&b.package, b.arch)));
    Ok(ExpectedLedger {
        abi_version,
        entries,
    })
}

fn validate_release(
    expected: &ExpectedLedger,
    index: &IndexToml,
    assets: &[ReleaseAsset],
    release_tag: &str,
    release_base_url: &str,
    mode: ValidationMode,
) -> Result<ValidatedSnapshot, String> {
    validate_expected_ledger(expected)?;
    if index.abi_version != expected.abi_version {
        return Err(format!(
            "release index ABI {} does not match expected ABI {}",
            index.abi_version, expected.abi_version
        ));
    }
    index.validate_archive_abi_versions()?;

    reject_managed_package_splits(index, expected)?;

    let mut assets_by_name = BTreeMap::new();
    for asset in assets {
        if assets_by_name.insert(asset.name.as_str(), asset).is_some() {
            return Err(format!(
                "release contains duplicate asset name {:?}",
                asset.name
            ));
        }
    }

    let mut index_entries = BTreeMap::new();
    for package in &index.packages {
        for (&arch, binary) in &package.binary {
            let key = (package.name.as_str(), arch);
            if index_entries.insert(key, (package, binary)).is_some() {
                return Err(format!(
                    "release index contains duplicate package/arch {} {}",
                    package.name,
                    arch.as_str()
                ));
            }
        }
    }

    let mut snapshot_entries = Vec::with_capacity(expected.entries.len());
    let mut stale = Vec::new();
    let mut gaps = Vec::new();
    for wanted in &expected.entries {
        let Some((package, binary)) =
            index_entries.get(&(wanted.package.as_str(), wanted.arch))
        else {
            if mode == ValidationMode::Available {
                // WHY: canonical may lack an expected key because it is new or
                // canonical itself is incomplete. This mode is used only to
                // freeze baseline bytes before matrix artifacts fill the gap;
                // final validation remains fully complete.
                gaps.push(format!("{} {}", wanted.package, wanted.arch.as_str()));
                continue;
            }
            return Err(format!(
                "release index is incomplete: missing {} {}",
                wanted.package,
                wanted.arch.as_str()
            ));
        };
        if mode == ValidationMode::Available {
            let available_cache_key = match binary.status {
                EntryStatus::Success => required_entry_field(
                    binary.cache_key_sha.as_deref(),
                    &wanted.package,
                    wanted.arch,
                    "cache_key_sha",
                )?,
                EntryStatus::Failed => {
                    let Some((_, _, cache_key)) =
                        validate_failed_entry_shape(binary, &wanted.package, wanted.arch)?
                    else {
                        // WHY: a truthful failure without last-green bytes is
                        // repairable. Exclude it from the frozen baseline so
                        // the matrix result must recreate this exact key.
                        gaps.push(format!("{} {}", wanted.package, wanted.arch.as_str()));
                        continue;
                    };
                    cache_key
                }
                EntryStatus::Pending | EntryStatus::Building => {
                    // WHY: transient canonical state is not a reusable
                    // artifact. The package matrix owns filling the omitted
                    // baseline key.
                    gaps.push(format!("{} {}", wanted.package, wanted.arch.as_str()));
                    continue;
                }
            };
            validate_sha256(available_cache_key, "cache_key_sha")?;
            if package.version != wanted.version
                || package.revision != wanted.revision
                || available_cache_key != wanted.cache_key_sha
            {
                // WHY: stale canonical bytes must not occupy the current key.
                // Treating them as a gap also lets a recipe change package
                // kind, because that change produces a new cache identity.
                gaps.push(format!("{} {}", wanted.package, wanted.arch.as_str()));
                continue;
            }
        }
        let (archive_url, archive_sha256, cache_key_sha, from_fallback) = match binary.status {
            EntryStatus::Success => (
                required_entry_field(
                    binary.archive_url.as_deref(),
                    &wanted.package,
                    wanted.arch,
                    "archive_url",
                )?,
                required_entry_field(
                    binary.archive_sha256.as_deref(),
                    &wanted.package,
                    wanted.arch,
                    "archive_sha256",
                )?,
                required_entry_field(
                    binary.cache_key_sha.as_deref(),
                    &wanted.package,
                    wanted.arch,
                    "cache_key_sha",
                )?,
                false,
            ),
            EntryStatus::Failed
                if matches!(mode, ValidationMode::Available | ValidationMode::Testable) =>
            {
                let Some((url, sha256, cache_key)) =
                    validate_failed_entry_shape(binary, &wanted.package, wanted.arch)?
                else {
                    return Err(format!(
                        "release index {} {} failure has no fallback",
                        wanted.package,
                        wanted.arch.as_str()
                    ));
                };
                (url, sha256, cache_key, true)
            }
            status => {
                return Err(format!(
                    "release index {} {} has status {:?}; mode {:?} requires a success{}",
                    wanted.package,
                    wanted.arch.as_str(),
                    status,
                    mode,
                    if mode == ValidationMode::Testable {
                        " or an exact current failure fallback"
                    } else {
                        ""
                    }
                ));
            }
        };
        validate_sha256(archive_sha256, "archive_sha256")?;
        validate_sha256(cache_key_sha, "cache_key_sha")?;
        let asset_name = archive_asset_name(archive_url, release_base_url)?;
        let expected_name = format!(
            "{}-{}-rev{}-abi{}-{}-{}.tar.zst",
            package.name,
            package.version,
            package.revision,
            expected.abi_version,
            wanted.arch.as_str(),
            &cache_key_sha[..8]
        );
        if asset_name != expected_name {
            return Err(format!(
                "release index {} {} archive {:?} does not match indexed identity {:?}",
                wanted.package,
                wanted.arch.as_str(),
                asset_name,
                expected_name
            ));
        }
        let current = package.version == wanted.version
            && package.revision == wanted.revision
            && cache_key_sha == wanted.cache_key_sha;
        if !current {
            if mode == ValidationMode::Available {
                // WHY: stale canonical bytes must not occupy the current key.
                // Treating them as a gap also lets a recipe change package
                // kind, because that change produces a new cache identity.
                gaps.push(format!("{} {}", wanted.package, wanted.arch.as_str()));
                continue;
            }
            stale.push(format!("{} {}", wanted.package, wanted.arch.as_str()));
        }
        let asset = assets_by_name.get(asset_name).ok_or_else(|| {
            format!(
                "release index {} {} names absent asset {:?}",
                wanted.package,
                wanted.arch.as_str(),
                asset_name
            )
        })?;
        if asset.state != "uploaded" {
            return Err(format!(
                "release asset {:?} has state {:?}, expected uploaded",
                asset.name, asset.state
            ));
        }
        if asset.size == 0 {
            return Err(format!("release asset {:?} has zero size", asset.name));
        }
        let expected_digest = format!("sha256:{archive_sha256}");
        if asset.digest.as_deref() != Some(expected_digest.as_str()) {
            return Err(format!(
                "release asset {:?} digest {:?} does not match index {:?}",
                asset.name, asset.digest, expected_digest
            ));
        }

        snapshot_entries.push(ValidatedEntry {
            package: wanted.package.clone(),
            kind: wanted.kind,
            arch: wanted.arch,
            version: package.version.clone(),
            revision: package.revision,
            cache_key_sha: cache_key_sha.to_owned(),
            current,
            from_fallback,
            asset: asset.name.clone(),
            archive_sha256: archive_sha256.to_owned(),
            size: asset.size,
        });
    }

    if matches!(mode, ValidationMode::Current | ValidationMode::Testable) && !stale.is_empty() {
        return Err(format!(
            "release is structurally complete but not current for: {}",
            stale.join(", ")
        ));
    }
    Ok(ValidatedSnapshot {
        abi_version: expected.abi_version,
        release_tag: release_tag.to_owned(),
        complete_current: stale.is_empty() && gaps.is_empty(),
        entries: snapshot_entries,
    })
}

fn validate_expected_ledger(expected: &ExpectedLedger) -> Result<(), String> {
    if expected.entries.is_empty() {
        return Err("expected ledger must contain at least one package/arch entry".into());
    }
    let mut keys = BTreeSet::new();
    for entry in &expected.entries {
        validate_sha256(&entry.cache_key_sha, "expected cache_key_sha")?;
        validate_git_build_inputs(&entry.git_inputs, "expected ledger git_inputs")?;
        if !keys.insert((entry.package.as_str(), entry.arch)) {
            return Err(format!(
                "expected ledger contains duplicate package/arch {} {}",
                entry.package,
                entry.arch.as_str()
            ));
        }
    }
    Ok(())
}

const MAX_ARCHIVE_MANIFEST_BYTES: u64 = 4 * 1024 * 1024;

/// Validate the immutable manifest inside every archive selected by a frozen
/// staging snapshot. Release metadata and index cache keys are useful routing
/// evidence, but neither can substitute for comparing the archive's authored
/// provenance directly with the current expected ledger.
fn validate_archive_snapshot(
    expected: &ExpectedLedger,
    snapshot: &ValidatedSnapshot,
    archives_dir: &Path,
    scope: ArchiveValidationScope,
) -> Result<(), String> {
    validate_expected_ledger(expected)?;
    if snapshot.abi_version != expected.abi_version {
        return Err(format!(
            "archive snapshot ABI {} does not match expected ABI {}",
            snapshot.abi_version, expected.abi_version
        ));
    }
    let metadata = std::fs::symlink_metadata(archives_dir)
        .map_err(|e| format!("inspect archive directory {}: {e}", archives_dir.display()))?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(format!(
            "archive directory must be a non-symlink directory: {}",
            archives_dir.display()
        ));
    }

    let expected_keys: BTreeSet<_> = expected
        .entries
        .iter()
        .map(|entry| (entry.package.as_str(), entry.arch))
        .collect();
    let mut snapshot_by_key = BTreeMap::new();
    for entry in &snapshot.entries {
        let key = (entry.package.as_str(), entry.arch);
        if !expected_keys.contains(&key) {
            return Err(format!(
                "archive snapshot contains unexpected package/arch {} {}",
                entry.package,
                entry.arch.as_str()
            ));
        }
        if snapshot_by_key.insert(key, entry).is_some() {
            return Err(format!(
                "archive snapshot contains duplicate package/arch {} {}",
                entry.package,
                entry.arch.as_str()
            ));
        }
    }
    if scope != ArchiveValidationScope::Available
        && snapshot_by_key.len() != expected.entries.len()
    {
        return Err(format!(
            "archive snapshot contains {} entries, expected {}",
            snapshot_by_key.len(),
            expected.entries.len()
        ));
    }
    if scope == ArchiveValidationScope::Available
        && snapshot_by_key.len() != expected.entries.len()
        && snapshot.complete_current
    {
        return Err(
            "available archive snapshot claims complete_current while expected keys are absent"
                .into(),
        );
    }

    for wanted in &expected.entries {
        let Some(entry) = snapshot_by_key.get(&(wanted.package.as_str(), wanted.arch)) else {
            if scope == ArchiveValidationScope::Available {
                continue;
            }
            return Err(format!(
                "archive snapshot lacks {} {}",
                wanted.package,
                wanted.arch.as_str()
            ));
        };
        let should_validate = match scope {
            ArchiveValidationScope::All | ArchiveValidationScope::Available => true,
            ArchiveValidationScope::CurrentDeclaredGitInputs => {
                entry.current && !wanted.git_inputs.is_empty()
            }
        };
        if !should_validate {
            continue;
        }
        if entry.kind != wanted.kind {
            return Err(format!(
                "archive snapshot kind for {} {} differs from expected",
                wanted.package,
                wanted.arch.as_str()
            ));
        }
        validate_sha256(&entry.cache_key_sha, "snapshot cache_key_sha")?;
        if entry.asset.contains(['/', '\\']) || entry.asset.contains("..") {
            return Err(format!("unsafe archive snapshot asset {:?}", entry.asset));
        }
        let archive_path = archives_dir.join(&entry.asset);
        let archive_metadata = std::fs::symlink_metadata(&archive_path)
            .map_err(|e| format!("inspect staging archive {}: {e}", archive_path.display()))?;
        if !archive_metadata.is_file() || archive_metadata.file_type().is_symlink() {
            return Err(format!(
                "staging archive must be a regular non-symlink file: {}",
                archive_path.display()
            ));
        }
        if archive_metadata.len() != entry.size {
            return Err(format!(
                "staging archive {} has {} bytes, validated snapshot requires {}",
                archive_path.display(),
                archive_metadata.len(),
                entry.size
            ));
        }
        let archive_sha256 = sha256_file(&archive_path)?;
        if archive_sha256 != entry.archive_sha256 {
            return Err(format!(
                "staging archive {} sha256 {} differs from validated snapshot {}",
                archive_path.display(),
                archive_sha256,
                entry.archive_sha256
            ));
        }
        let archived = read_archive_manifest(&archive_path)?;
        let compatibility = archived
            .compatibility
            .as_ref()
            .expect("parse_archived guarantees compatibility");
        let archived_kind = match archived.kind {
            ManifestKind::Library => ExpectedKind::Library,
            ManifestKind::Program => ExpectedKind::Program,
            ManifestKind::Source => {
                return Err(format!(
                    "staging archive {} unexpectedly contains kind=source",
                    archive_path.display()
                ));
            }
        };
        if archived.name != entry.package
            || archived.version != entry.version
            || archived.revision != entry.revision
            || archived_kind != entry.kind
            || compatibility.target_arch != entry.arch
            || !compatibility.abi_versions.contains(&expected.abi_version)
            || compatibility.cache_key_sha != entry.cache_key_sha
        {
            return Err(format!(
                "staging archive {} manifest identity differs from its validated snapshot entry",
                archive_path.display()
            ));
        }
        if entry.current {
            if entry.version != wanted.version
                || entry.revision != wanted.revision
                || entry.cache_key_sha != wanted.cache_key_sha
            {
                return Err(format!(
                    "current staging snapshot identity for {} {} differs from expected ledger",
                    wanted.package,
                    wanted.arch.as_str()
                ));
            }
            if compatibility.git_inputs != wanted.git_inputs {
                return Err(format!(
                    "current staging archive {} immutable Git inputs {:?} differ from expected ledger {:?}",
                    archive_path.display(),
                    compatibility.git_inputs,
                    wanted.git_inputs
                ));
            }
        }
    }
    Ok(())
}

fn validate_finalized_index(
    expected: &ExpectedLedger,
    index: &IndexToml,
    archives_dir: &Path,
    allow_failed: bool,
) -> Result<Vec<FinalAsset>, String> {
    if index.abi_version != expected.abi_version {
        return Err(format!(
            "final staging index ABI {} does not match expected ABI {}",
            index.abi_version, expected.abi_version
        ));
    }
    index.validate_archive_abi_versions()?;
    ensure_localized_index(index, "final staging")?;

    let directory = std::fs::symlink_metadata(archives_dir).map_err(|e| {
        format!(
            "inspect final archive directory {}: {e}",
            archives_dir.display()
        )
    })?;
    if !directory.is_dir() || directory.file_type().is_symlink() {
        return Err(format!(
            "final archive directory must be a non-symlink directory: {}",
            archives_dir.display()
        ));
    }

    let mut expected_packages: BTreeMap<&str, (&str, u32, BTreeSet<TargetArch>)> = BTreeMap::new();
    for wanted in &expected.entries {
        let package = expected_packages
            .entry(wanted.package.as_str())
            .or_insert_with(|| (wanted.version.as_str(), wanted.revision, BTreeSet::new()));
        if package.0 != wanted.version || package.1 != wanted.revision {
            return Err(format!(
                "expected ledger gives package {} more than one version or revision",
                wanted.package
            ));
        }
        package.2.insert(wanted.arch);
    }

    let mut actual_packages = BTreeMap::new();
    for package in &index.packages {
        if actual_packages
            .insert(package.name.as_str(), package)
            .is_some()
        {
            return Err(format!(
                "final staging index splits managed package {:?} across version blocks",
                package.name
            ));
        }
    }
    if actual_packages.len() != expected_packages.len() {
        return Err(format!(
            "final staging index contains {} package blocks, expected {}",
            actual_packages.len(),
            expected_packages.len()
        ));
    }

    let mut assets: BTreeMap<String, FinalAsset> = BTreeMap::new();
    for wanted in &expected.entries {
        let package = actual_packages
            .get(wanted.package.as_str())
            .ok_or_else(|| format!("final staging index lacks package {}", wanted.package))?;
        if package.version != wanted.version || package.revision != wanted.revision {
            return Err(format!(
                "final staging index {} identity {} rev{} differs from expected {} rev{}",
                wanted.package, package.version, package.revision, wanted.version, wanted.revision
            ));
        }
        let expected_arches = &expected_packages
            .get(wanted.package.as_str())
            .expect("expected package was built above")
            .2;
        let actual_arches: BTreeSet<_> = package.binary.keys().copied().collect();
        if &actual_arches != expected_arches {
            return Err(format!(
                "final staging index {} arches {:?} differ from expected {:?}",
                wanted.package, actual_arches, expected_arches
            ));
        }
        let entry = package.binary.get(&wanted.arch).ok_or_else(|| {
            format!(
                "final staging index lacks {} {}",
                wanted.package,
                wanted.arch.as_str()
            )
        })?;

        match entry.status {
            EntryStatus::Success => {
                let archive_url = required_entry_field(
                    entry.archive_url.as_deref(),
                    &wanted.package,
                    wanted.arch,
                    "archive_url",
                )?;
                let archive_sha = required_entry_field(
                    entry.archive_sha256.as_deref(),
                    &wanted.package,
                    wanted.arch,
                    "archive_sha256",
                )?;
                let cache_key = required_entry_field(
                    entry.cache_key_sha.as_deref(),
                    &wanted.package,
                    wanted.arch,
                    "cache_key_sha",
                )?;
                if cache_key != wanted.cache_key_sha {
                    return Err(format!(
                        "final staging index {} {} cache key is stale",
                        wanted.package,
                        wanted.arch.as_str()
                    ));
                }
                if entry.built_at.as_deref().unwrap_or_default().is_empty()
                    || entry.built_by.as_deref().unwrap_or_default().is_empty()
                    || entry.error.is_some()
                    || entry.last_attempt.is_some()
                    || entry.last_attempt_by.is_some()
                    || entry.fallback_archive_url.is_some()
                    || entry.fallback_archive_sha256.is_some()
                    || entry.fallback_cache_key_sha.is_some()
                    || entry.fallback_built_at.is_some()
                {
                    return Err(format!(
                        "final staging index {} {} success metadata is inconsistent",
                        wanted.package,
                        wanted.arch.as_str()
                    ));
                }
                validate_final_archive(
                    archives_dir,
                    archive_url,
                    archive_sha,
                    cache_key,
                    wanted,
                    expected.abi_version,
                    true,
                    &mut assets,
                )?;
            }
            EntryStatus::Failed if allow_failed => {
                if entry.error.as_deref().unwrap_or_default().is_empty()
                    || entry.last_attempt.as_deref().unwrap_or_default().is_empty()
                    || entry
                        .last_attempt_by
                        .as_deref()
                        .unwrap_or_default()
                        .is_empty()
                    || entry.archive_url.is_some()
                    || entry.archive_sha256.is_some()
                    || entry.cache_key_sha.is_some()
                    || entry.built_at.is_some()
                    || entry.built_by.is_some()
                {
                    return Err(format!(
                        "final staging index {} {} failure metadata is inconsistent",
                        wanted.package,
                        wanted.arch.as_str()
                    ));
                }
                let fallback_fields = [
                    entry.fallback_archive_url.is_some(),
                    entry.fallback_archive_sha256.is_some(),
                    entry.fallback_cache_key_sha.is_some(),
                ];
                if fallback_fields.iter().any(|present| *present)
                    && !fallback_fields.iter().all(|present| *present)
                {
                    return Err(format!(
                        "final staging index {} {} has a partial fallback identity",
                        wanted.package,
                        wanted.arch.as_str()
                    ));
                }
                if let (Some(url), Some(sha), Some(cache_key)) = (
                    entry.fallback_archive_url.as_deref(),
                    entry.fallback_archive_sha256.as_deref(),
                    entry.fallback_cache_key_sha.as_deref(),
                ) {
                    validate_final_archive(
                        archives_dir,
                        url,
                        sha,
                        cache_key,
                        wanted,
                        expected.abi_version,
                        false,
                        &mut assets,
                    )?;
                }
            }
            EntryStatus::Failed => {
                return Err(format!(
                    "final staging index {} {} records a failed build",
                    wanted.package,
                    wanted.arch.as_str()
                ));
            }
            EntryStatus::Pending | EntryStatus::Building => {
                return Err(format!(
                    "final staging index {} {} retains transient status {:?}",
                    wanted.package,
                    wanted.arch.as_str(),
                    entry.status
                ));
            }
        }
    }

    Ok(assets.into_values().collect())
}

#[allow(clippy::too_many_arguments)]
fn validate_final_archive(
    archives_dir: &Path,
    archive_url: &str,
    archive_sha: &str,
    cache_key: &str,
    wanted: &ExpectedEntry,
    expected_abi: u32,
    current: bool,
    assets: &mut BTreeMap<String, FinalAsset>,
) -> Result<(), String> {
    validate_sha256(archive_sha, "final archive sha256")?;
    validate_sha256(cache_key, "final archive cache_key_sha")?;
    let asset = archive_asset_name(
        archive_url,
        "https://invalid.example/releases/download/final/",
    )?;
    let path = archives_dir.join(asset);
    let metadata = std::fs::symlink_metadata(&path)
        .map_err(|e| format!("inspect final staging archive {}: {e}", path.display()))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() == 0 {
        return Err(format!(
            "final staging archive must be a nonempty regular file: {}",
            path.display()
        ));
    }
    let actual_sha = sha256_file(&path)?;
    if actual_sha != archive_sha {
        return Err(format!(
            "final staging archive {} sha256 {} differs from index {}",
            path.display(),
            actual_sha,
            archive_sha
        ));
    }
    let archived = read_archive_manifest(&path)?;
    let compatibility = archived
        .compatibility
        .as_ref()
        .expect("parse_archived guarantees compatibility");
    let archived_kind = match archived.kind {
        ManifestKind::Library => ExpectedKind::Library,
        ManifestKind::Program => ExpectedKind::Program,
        ManifestKind::Source => {
            return Err(format!(
                "final staging archive {} unexpectedly contains kind=source",
                path.display()
            ));
        }
    };
    if archived.name != wanted.package
        || archived.version != wanted.version
        || archived_kind != wanted.kind
        || compatibility.target_arch != wanted.arch
        || !compatibility.abi_versions.contains(&expected_abi)
        || compatibility.cache_key_sha != cache_key
    {
        return Err(format!(
            "final staging archive {} manifest identity differs from its index entry",
            path.display()
        ));
    }
    if current
        && (archived.revision != wanted.revision
            || cache_key != wanted.cache_key_sha
            || compatibility.git_inputs != wanted.git_inputs)
    {
        return Err(format!(
            "current final staging archive {} differs from expected recipe provenance",
            path.display()
        ));
    }

    let planned = FinalAsset {
        name: asset.to_string(),
        sha256: archive_sha.to_string(),
        size: metadata.len(),
    };
    if let Some(existing) = assets.insert(asset.to_string(), planned.clone()) {
        if existing != planned {
            return Err(format!(
                "final staging index assigns conflicting identities to asset {asset:?}"
            ));
        }
    }
    Ok(())
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = std::fs::File::open(path)
        .map_err(|e| format!("open staging archive {} for sha256: {e}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|e| format!("hash staging archive {}: {e}", path.display()))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn read_archive_manifest(path: &Path) -> Result<DepsManifest, String> {
    let file = std::fs::File::open(path)
        .map_err(|e| format!("open staging archive {}: {e}", path.display()))?;
    let decoder = zstd::stream::read::Decoder::new(file)
        .map_err(|e| format!("decompress staging archive {}: {e}", path.display()))?;
    let mut archive = tar::Archive::new(decoder);
    let mut entries = archive
        .entries()
        .map_err(|e| format!("read staging archive {}: {e}", path.display()))?;
    let mut entry = entries
        .next()
        .ok_or_else(|| format!("staging archive {} is empty", path.display()))?
        .map_err(|e| format!("read first entry from {}: {e}", path.display()))?;
    let entry_path = entry
        .path()
        .map_err(|e| format!("read first path from {}: {e}", path.display()))?;
    if entry_path.as_ref() != Path::new("manifest.toml") || !entry.header().entry_type().is_file() {
        return Err(format!(
            "staging archive {} must begin with regular manifest.toml",
            path.display()
        ));
    }
    if entry.size() > MAX_ARCHIVE_MANIFEST_BYTES {
        return Err(format!(
            "staging archive {} manifest exceeds {} bytes",
            path.display(),
            MAX_ARCHIVE_MANIFEST_BYTES
        ));
    }
    let mut text = String::new();
    entry
        .read_to_string(&mut text)
        .map_err(|e| format!("read manifest from {}: {e}", path.display()))?;
    drop(entry);
    for later in entries {
        let later = later.map_err(|e| format!("read entry from {}: {e}", path.display()))?;
        let later_path = later
            .path()
            .map_err(|e| format!("read entry path from {}: {e}", path.display()))?;
        if later_path.as_ref() == Path::new("manifest.toml") {
            return Err(format!(
                "staging archive {} contains duplicate manifest.toml",
                path.display()
            ));
        }
    }
    DepsManifest::parse_archived(&text, path.to_path_buf())
        .map_err(|e| format!("parse manifest from {}: {e}", path.display()))
}

fn reject_managed_package_splits(
    index: &IndexToml,
    expected: &ExpectedLedger,
) -> Result<(), String> {
    let managed: BTreeSet<&str> = expected
        .entries
        .iter()
        .map(|entry| entry.package.as_str())
        .collect();
    let mut seen = BTreeSet::new();
    for package in &index.packages {
        if managed.contains(package.name.as_str()) && !seen.insert(package.name.as_str()) {
            return Err(format!(
                "release index splits managed package {:?} across multiple version blocks",
                package.name
            ));
        }
    }
    Ok(())
}

fn localize_index(
    index: &IndexToml,
    snapshot: &ValidatedSnapshot,
    available_expected: Option<&ExpectedLedger>,
) -> Result<IndexToml, String> {
    let mut localized = index.clone();
    if let Some(expected) = available_expected {
        let expected_keys: BTreeSet<_> = expected
            .entries
            .iter()
            .map(|entry| (entry.package.clone(), entry.arch))
            .collect();
        let selected_keys: BTreeSet<_> = snapshot
            .entries
            .iter()
            .map(|entry| (entry.package.clone(), entry.arch))
            .collect();
        for package in &mut localized.packages {
            let package_name = package.name.clone();
            package.binary.retain(|arch, _| {
                let key = (package_name.clone(), *arch);
                !expected_keys.contains(&key) || selected_keys.contains(&key)
            });
        }
        localized
            .packages
            .retain(|package| !package.binary.is_empty());
    }
    for validated in &snapshot.entries {
        let package = localized
            .packages
            .iter_mut()
            .find(|package| package.name == validated.package)
            .ok_or_else(|| format!("localized index lost package {}", validated.package))?;
        let entry = package.binary.get_mut(&validated.arch).ok_or_else(|| {
            format!(
                "localized index lost {} {}",
                validated.package,
                validated.arch.as_str()
            )
        })?;
        if validated.from_fallback {
            // WHY: a failed entry is resolved through fallback_archive_url.
            // Writing the selected bytes into archive_url would make the
            // localized test index point at a field the resolver ignores.
            entry.fallback_archive_url = Some(validated.asset.clone());
        } else {
            entry.archive_url = Some(validated.asset.clone());
        }
    }
    Ok(localized)
}

fn compose_indexes(
    base: &IndexToml,
    overlay: &IndexToml,
    expected: &ExpectedLedger,
) -> Result<IndexToml, String> {
    validate_expected_ledger(expected)?;
    if base.abi_version != expected.abi_version || overlay.abi_version != expected.abi_version {
        return Err(format!(
            "compose index ABI mismatch: base={}, overlay={}, expected={}",
            base.abi_version, overlay.abi_version, expected.abi_version
        ));
    }
    base.validate_archive_abi_versions()?;
    overlay.validate_archive_abi_versions()?;
    ensure_localized_index(base, "base")?;
    ensure_localized_index(overlay, "overlay")?;
    reject_managed_package_splits(base, expected)?;
    reject_managed_package_splits(overlay, expected)?;
    let mut composed = base.clone();
    for wanted in &expected.entries {
        let source_package = overlay
            .packages
            .iter()
            .find(|package| package.name == wanted.package && package.version == wanted.version)
            .ok_or_else(|| format!("overlay index lacks package {}", wanted.package))?;
        if source_package.revision != wanted.revision {
            return Err(format!(
                "overlay index {} revision {} does not match expected {}",
                wanted.package, source_package.revision, wanted.revision
            ));
        }
        let source_entry = source_package.binary.get(&wanted.arch).ok_or_else(|| {
            format!(
                "overlay index lacks {} {}",
                wanted.package,
                wanted.arch.as_str()
            )
        })?;
        if source_entry.status != EntryStatus::Success
            || source_entry.cache_key_sha.as_deref() != Some(wanted.cache_key_sha.as_str())
        {
            return Err(format!(
                "overlay index {} {} is not the expected current success",
                wanted.package,
                wanted.arch.as_str()
            ));
        }
        let target_package = composed
            .packages
            .iter_mut()
            .find(|package| package.name == wanted.package)
            .ok_or_else(|| format!("base index lacks package {}", wanted.package))?;
        target_package.version = source_package.version.clone();
        target_package.revision = source_package.revision;
        target_package
            .binary
            .insert(wanted.arch, source_entry.clone());
    }
    composed.generated_at = std::cmp::max(&base.generated_at, &overlay.generated_at).clone();
    composed.generator = "xtask staging-reuse compose".into();
    composed.validate_archive_abi_versions()?;
    Ok(composed)
}

fn ensure_localized_index(index: &IndexToml, context: &str) -> Result<(), String> {
    for package in &index.packages {
        for (arch, entry) in &package.binary {
            for (field, value) in [
                ("archive_url", entry.archive_url.as_deref()),
                (
                    "fallback_archive_url",
                    entry.fallback_archive_url.as_deref(),
                ),
            ] {
                let Some(value) = value else {
                    continue;
                };
                if value.contains('/') || value.contains(['?', '#', '\\']) || value.contains("..") {
                    return Err(format!(
                        "{context} index {} {} {field} is not a localized asset basename: {value:?}",
                        package.name,
                        arch.as_str()
                    ));
                }
            }
        }
    }
    Ok(())
}

fn required_entry_field<'a>(
    value: Option<&'a str>,
    package: &str,
    arch: TargetArch,
    field: &str,
) -> Result<&'a str, String> {
    value.ok_or_else(|| {
        format!(
            "release index {package} {} entry lacks {field}",
            arch.as_str()
        )
    })
}

fn validate_failed_entry_shape<'a>(
    entry: &'a BinaryEntry,
    package: &str,
    arch: TargetArch,
) -> Result<Option<(&'a str, &'a str, &'a str)>, String> {
    if entry.error.as_deref().unwrap_or_default().is_empty()
        || entry.last_attempt.as_deref().unwrap_or_default().is_empty()
        || entry
            .last_attempt_by
            .as_deref()
            .unwrap_or_default()
            .is_empty()
        || entry.archive_url.is_some()
        || entry.archive_sha256.is_some()
        || entry.cache_key_sha.is_some()
        || entry.built_at.is_some()
        || entry.built_by.is_some()
    {
        return Err(format!(
            "release index {package} {} failure metadata is inconsistent",
            arch.as_str()
        ));
    }

    let fallback_fields = [
        entry.fallback_archive_url.as_deref(),
        entry.fallback_archive_sha256.as_deref(),
        entry.fallback_cache_key_sha.as_deref(),
    ];
    let fallback_count = fallback_fields.iter().filter(|field| field.is_some()).count();
    if fallback_count == 0 {
        if entry.fallback_built_at.is_some() {
            return Err(format!(
                "release index {package} {} has a partial fallback identity",
                arch.as_str()
            ));
        }
        return Ok(None);
    }
    if fallback_count != fallback_fields.len() {
        return Err(format!(
            "release index {package} {} has a partial fallback identity",
            arch.as_str()
        ));
    }

    Ok(Some((
        fallback_fields[0].expect("all fallback fields were checked above"),
        fallback_fields[1].expect("all fallback fields were checked above"),
        fallback_fields[2].expect("all fallback fields were checked above"),
    )))
}

fn validate_sha256(value: &str, field: &str) -> Result<(), String> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(format!(
            "{field} must be 64 lowercase hexadecimal characters, got {value:?}"
        ));
    }
    Ok(())
}

fn validate_release_tag(value: &str) -> Result<(), String> {
    if value.is_empty()
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
    {
        return Err(format!("invalid release tag {value:?}"));
    }
    Ok(())
}

fn validate_release_base_url(value: &str, release_tag: &str) -> Result<(), String> {
    let expected_suffix = format!("/releases/download/{release_tag}/");
    if !value.starts_with("https://")
        || !value.ends_with(&expected_suffix)
        || value.contains(['?', '#', '\\'])
        || value.contains("..")
    {
        return Err(format!(
            "release base URL must be an exact HTTPS repository release prefix ending in {expected_suffix:?}, got {value:?}"
        ));
    }
    Ok(())
}

fn archive_asset_name<'a>(archive_url: &'a str, release_base_url: &str) -> Result<&'a str, String> {
    if archive_url.contains(['?', '#', '\\']) || archive_url.contains("..") {
        return Err(format!("unsafe archive_url {archive_url:?}"));
    }
    let name = archive_url.rsplit('/').next().unwrap_or(archive_url);
    if name.is_empty()
        || !name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._+,-".contains(&byte))
    {
        return Err(format!(
            "archive_url has invalid asset basename {archive_url:?}"
        ));
    }
    if archive_url != name {
        if archive_url.strip_prefix(release_base_url) != Some(name) {
            return Err(format!(
                "absolute archive_url must use exact release prefix {release_base_url:?}, got {archive_url:?}"
            ));
        }
    }
    Ok(name)
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<T, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    serde_json::from_slice(&bytes).map_err(|e| format!("parse {}: {e}", path.display()))
}

fn write_json(path: &Path, value: &impl Serialize) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
    }
    let mut bytes = serde_json::to_vec_pretty(value).map_err(|e| format!("encode JSON: {e}"))?;
    bytes.push(b'\n');
    std::fs::write(path, bytes).map_err(|e| format!("write {}: {e}", path.display()))
}

#[derive(Debug)]
struct Flags(BTreeMap<String, Vec<String>>);

impl Flags {
    fn parse(args: &[String]) -> Result<Self, String> {
        let mut values: BTreeMap<String, Vec<String>> = BTreeMap::new();
        let mut index = 0;
        while index < args.len() {
            let flag = &args[index];
            if !flag.starts_with("--") {
                return Err(format!("unexpected positional argument {flag:?}"));
            }
            let value = args
                .get(index + 1)
                .ok_or_else(|| format!("{flag} requires a value"))?;
            values.entry(flag.clone()).or_default().push(value.clone());
            index += 2;
        }
        Ok(Self(values))
    }

    fn reject_unknown(&self, allowed: &[&str]) -> Result<(), String> {
        for flag in self.0.keys() {
            if !allowed.contains(&flag.as_str()) {
                return Err(format!("unknown flag {flag}"));
            }
        }
        Ok(())
    }

    fn required(&self, flag: &str) -> Result<&str, String> {
        let values = self
            .0
            .get(flag)
            .ok_or_else(|| format!("{flag} is required"))?;
        if values.len() != 1 {
            return Err(format!("{flag} must be provided exactly once"));
        }
        Ok(&values[0])
    }

    fn required_path(&self, flag: &str) -> Result<&Path, String> {
        Ok(Path::new(self.required(flag)?))
    }

    fn required_u32(&self, flag: &str) -> Result<u32, String> {
        self.required(flag)?
            .parse()
            .map_err(|_| format!("{flag} must be an unsigned integer"))
    }

    fn values<'a>(&'a self, flag: &'a str) -> impl Iterator<Item = &'a str> {
        self.0.get(flag).into_iter().flatten().map(String::as_str)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index_toml::{BinaryEntry, PackageEntry};
    use std::fs;
    use std::io::Cursor;
    use std::sync::atomic::{AtomicU64, Ordering};

    const ABI: u32 = 39;
    const SHA: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const ARCHIVE_SHA: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    fn archive_tempdir(label: &str) -> std::path::PathBuf {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "kandelo-staging-archive-{label}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed),
        ));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn git_input(name: &str, commit_byte: char) -> GitBuildInput {
        GitBuildInput {
            name: name.into(),
            repository: format!("https://example.test/{name}.git"),
            commit: commit_byte.to_string().repeat(40),
        }
    }

    fn archived_manifest(git_inputs: &[GitBuildInput]) -> String {
        let git_blocks = git_inputs
            .iter()
            .map(|input| {
                format!(
                    "[[compatibility.git_inputs]]\nname = {:?}\nrepository = {:?}\ncommit = {:?}\n",
                    input.name, input.repository, input.commit,
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        format!(
            r#"kind = "library"
name = "zlib"
version = "1.3.1"
revision = 2
depends_on = []
[source]
url = "https://example.test/zlib.tar.gz"
sha256 = "{source_sha}"
[license]
spdx = "Zlib"
[outputs]
libs = ["lib/libz.a"]
[compatibility]
target_arch = "wasm32"
abi_versions = [{ABI}]
cache_key_sha = "{SHA}"
{git_blocks}"#,
            source_sha = "0".repeat(64),
        )
    }

    fn archived_program_manifest(cache_key_sha: &str) -> String {
        format!(
            r#"kind = "program"
name = "zlib"
version = "1.3.1"
revision = 2
depends_on = []
[source]
url = "https://example.test/zlib.tar.gz"
sha256 = "{source_sha}"
[license]
spdx = "Zlib"
[[outputs]]
name = "zlib"
wasm = "zlib.wasm"
[compatibility]
target_arch = "wasm32"
abi_versions = [{ABI}]
cache_key_sha = "{cache_key_sha}"
"#,
            source_sha = "0".repeat(64),
        )
    }

    fn write_test_archive(
        path: &Path,
        first_path: &str,
        manifest: &[u8],
        duplicate_manifest: bool,
    ) {
        let file = fs::File::create(path).unwrap();
        let encoder = zstd::stream::write::Encoder::new(file, 1).unwrap();
        let mut tar = tar::Builder::new(encoder);
        append_tar_file(&mut tar, first_path, manifest);
        if duplicate_manifest {
            append_tar_file(&mut tar, "manifest.toml", manifest);
        }
        append_tar_file(&mut tar, "artifacts/lib/libz.a", b"archive bytes");
        let encoder = tar.into_inner().unwrap();
        encoder.finish().unwrap();
    }

    fn append_tar_file<W: std::io::Write>(tar: &mut tar::Builder<W>, path: &str, bytes: &[u8]) {
        let mut header = tar::Header::new_gnu();
        header.set_mode(0o644);
        header.set_uid(0);
        header.set_gid(0);
        header.set_mtime(0);
        header.set_size(bytes.len() as u64);
        header.set_cksum();
        tar.append_data(&mut header, path, Cursor::new(bytes))
            .unwrap();
    }

    fn expected_with_git_inputs(git_inputs: Vec<GitBuildInput>) -> ExpectedLedger {
        let mut value = expected();
        value.entries[0].git_inputs = git_inputs;
        value
    }

    fn snapshot_for_archive(path: &Path, current: bool) -> ValidatedSnapshot {
        ValidatedSnapshot {
            abi_version: ABI,
            release_tag: "pr-946-staging".into(),
            complete_current: current,
            entries: vec![ValidatedEntry {
                package: "zlib".into(),
                kind: ExpectedKind::Library,
                arch: TargetArch::Wasm32,
                version: "1.3.1".into(),
                revision: 2,
                cache_key_sha: SHA.into(),
                current,
                from_fallback: false,
                asset: path.file_name().unwrap().to_string_lossy().into_owned(),
                archive_sha256: sha256_file(path).unwrap(),
                size: fs::metadata(path).unwrap().len(),
            }],
        }
    }

    fn expected() -> ExpectedLedger {
        ExpectedLedger {
            abi_version: ABI,
            entries: vec![ExpectedEntry {
                package: "zlib".into(),
                kind: ExpectedKind::Library,
                arch: TargetArch::Wasm32,
                version: "1.3.1".into(),
                revision: 2,
                cache_key_sha: SHA.into(),
                git_inputs: Vec::new(),
            }],
        }
    }

    #[test]
    fn expected_ledger_requires_explicit_git_provenance() {
        let missing = format!(
            r#"{{"abi_version":{ABI},"entries":[{{"package":"zlib","kind":"library","arch":"wasm32","version":"1.3.1","revision":2,"cache_key_sha":"{SHA}"}}]}}"#,
        );
        let error = serde_json::from_str::<ExpectedLedger>(&missing).unwrap_err();
        assert!(error.to_string().contains("git_inputs"), "{error}");
    }

    fn binary() -> crate::index_toml::BinaryEntry {
        BinaryEntry {
            status: EntryStatus::Success,
            archive_url: Some("zlib-1.3.1-rev2-abi39-wasm32-aaaaaaaa.tar.zst".into()),
            archive_sha256: Some(ARCHIVE_SHA.into()),
            cache_key_sha: Some(SHA.into()),
            built_at: Some("2026-07-14T00:00:00Z".into()),
            built_by: Some("test".into()),
            ..BinaryEntry::default()
        }
    }

    fn index() -> IndexToml {
        IndexToml {
            abi_version: ABI,
            generated_at: "2026-07-14T00:00:00Z".into(),
            generator: "test".into(),
            packages: vec![PackageEntry {
                name: "zlib".into(),
                version: "1.3.1".into(),
                revision: 2,
                binary: BTreeMap::from([(TargetArch::Wasm32, binary())]),
            }],
        }
    }

    fn assets() -> Vec<ReleaseAsset> {
        vec![ReleaseAsset {
            name: "zlib-1.3.1-rev2-abi39-wasm32-aaaaaaaa.tar.zst".into(),
            state: "uploaded".into(),
            size: 123,
            digest: Some(format!("sha256:{ARCHIVE_SHA}")),
        }]
    }

    fn release_asset_for_archive(path: &Path) -> ReleaseAsset {
        ReleaseAsset {
            name: path.file_name().unwrap().to_string_lossy().into_owned(),
            state: "uploaded".into(),
            size: fs::metadata(path).unwrap().len(),
            digest: Some(format!("sha256:{}", sha256_file(path).unwrap())),
        }
    }

    fn validate(
        expected: &ExpectedLedger,
        index: &IndexToml,
        assets: &[ReleaseAsset],
        mode: ValidationMode,
    ) -> Result<ValidatedSnapshot, String> {
        validate_release(
            expected,
            index,
            assets,
            "pr-946-staging",
            "https://github.com/Automattic/kandelo/releases/download/pr-946-staging/",
            mode,
        )
    }

    #[test]
    fn staging_reuse_treats_git_input_identity_changes_as_stale() {
        let registry_path = std::env::temp_dir()
            .join("kandelo-staging-reuse-git-input")
            .join(std::process::id().to_string());
        let _ = fs::remove_dir_all(&registry_path);
        let package_dir = registry_path.join("demo");
        fs::create_dir_all(&package_dir).unwrap();
        fs::write(
            package_dir.join("package.toml"),
            r#"
kind = "library"
name = "demo"
version = "1.0.0"
kernel_abi = 39
depends_on = []
[source]
url = "https://example.test/demo.tar.gz"
sha256 = "0000000000000000000000000000000000000000000000000000000000000000"
[license]
spdx = "MIT"
[build]
script_path = "packages/registry/demo/build-demo.sh"
[outputs]
libs = ["lib/libdemo.a"]
"#,
        )
        .unwrap();
        let build_path = package_dir.join("build.toml");
        let first_build = r#"
script_path = "packages/registry/demo/build-demo.sh"
repo_url = "https://example.test/kandelo.git"
commit = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
revision = 1
[[git_inputs]]
name = "tap"
repository = "https://example.test/tap.git"
commit = "1111111111111111111111111111111111111111"
[binary]
index_url = "https://example.test/binaries-abi-v{abi}/index.toml"
"#;
        fs::write(&build_path, first_build).unwrap();
        let first = build_expected_ledger(&registry_path, ABI, &BTreeSet::new()).unwrap();
        fs::write(
            &build_path,
            first_build.replace(
                "1111111111111111111111111111111111111111",
                "2222222222222222222222222222222222222222",
            ),
        )
        .unwrap();
        let second = build_expected_ledger(&registry_path, ABI, &BTreeSet::new()).unwrap();
        assert_ne!(
            first.entries[0].cache_key_sha,
            second.entries[0].cache_key_sha
        );

        let mut stale_index = IndexToml {
            abi_version: ABI,
            generated_at: "2026-07-14T00:00:00Z".into(),
            generator: "test".into(),
            packages: vec![PackageEntry {
                name: "demo".into(),
                version: "1.0.0".into(),
                revision: 1,
                binary: BTreeMap::new(),
            }],
        };
        let old_sha = first.entries[0].cache_key_sha.clone();
        stale_index.packages[0].binary.insert(
            TargetArch::Wasm32,
            BinaryEntry {
                status: EntryStatus::Success,
                archive_url: Some(format!(
                    "demo-1.0.0-rev1-abi39-wasm32-{}.tar.zst",
                    &old_sha[..8]
                )),
                archive_sha256: Some(ARCHIVE_SHA.into()),
                cache_key_sha: Some(old_sha),
                built_at: Some("2026-07-14T00:00:00Z".into()),
                built_by: Some("test".into()),
                ..BinaryEntry::default()
            },
        );
        let asset_name = stale_index.packages[0].binary[&TargetArch::Wasm32]
            .archive_url
            .clone()
            .unwrap();
        let stale_assets = vec![ReleaseAsset {
            name: asset_name,
            state: "uploaded".into(),
            size: 123,
            digest: Some(format!("sha256:{ARCHIVE_SHA}")),
        }];
        assert!(
            validate_release(
                &second,
                &stale_index,
                &stale_assets,
                "pr-946-staging",
                "https://github.com/Automattic/kandelo/releases/download/pr-946-staging/",
                ValidationMode::Current,
            )
            .is_err()
        );
    }

    #[test]
    fn accepts_complete_current_release() {
        let snapshot = validate(&expected(), &index(), &assets(), ValidationMode::Current).unwrap();
        assert!(snapshot.complete_current);
        assert!(snapshot.entries[0].current);
    }

    #[test]
    fn available_baseline_allows_absent_package_and_arch_keys() {
        let additions = [
            ExpectedEntry {
                package: "bzip2".into(),
                kind: ExpectedKind::Library,
                arch: TargetArch::Wasm32,
                version: "1.0".into(),
                revision: 1,
                cache_key_sha: "c".repeat(64),
                git_inputs: Vec::new(),
            },
            ExpectedEntry {
                package: "zlib".into(),
                kind: ExpectedKind::Library,
                arch: TargetArch::Wasm64,
                version: "1.3.1".into(),
                revision: 2,
                cache_key_sha: "d".repeat(64),
                git_inputs: Vec::new(),
            },
        ];
        for addition in additions {
            let mut expanded = expected();
            expanded.entries.push(addition);
            let snapshot =
                validate(&expanded, &index(), &assets(), ValidationMode::Available).unwrap();
            assert_eq!(snapshot.entries.len(), 1);
            assert!(!snapshot.complete_current);
            assert_eq!(snapshot.entries[0].package, "zlib");
            assert_eq!(snapshot.entries[0].arch, TargetArch::Wasm32);

            assert!(
                validate(
                    &expanded,
                    &index(),
                    &assets(),
                    ValidationMode::Structural
                )
                .is_err(),
                "the baseline-only available mode may omit an expected key"
            );
        }
    }

    #[test]
    fn available_baseline_freezes_and_materializes_an_exact_failure_fallback() {
        let dir = archive_tempdir("available-fallback");
        let archive =
            dir.join("zlib-1.3.1-rev2-abi39-wasm32-aaaaaaaa.tar.zst");
        write_test_archive(
            &archive,
            "manifest.toml",
            archived_manifest(&[]).as_bytes(),
            false,
        );
        let archive_sha = sha256_file(&archive).unwrap();
        let mut failed = index();
        failed.packages[0]
            .binary
            .get_mut(&TargetArch::Wasm32)
            .unwrap()
            .archive_sha256 = Some(archive_sha.clone());
        failed.update_entry_failed(
            "zlib",
            "1.3.1",
            2,
            TargetArch::Wasm32,
            "matrix build failed".into(),
            "2026-07-24T00:00:00Z".into(),
            "https://example.test/run/1".into(),
        );

        let snapshot = validate(
            &expected(),
            &failed,
            &[release_asset_for_archive(&archive)],
            ValidationMode::Available,
        )
        .unwrap();
        assert!(snapshot.complete_current);
        assert!(snapshot.entries[0].current);
        assert!(snapshot.entries[0].from_fallback);
        validate_archive_snapshot(
            &expected(),
            &snapshot,
            &dir,
            ArchiveValidationScope::Available,
        )
        .unwrap();

        let mut localized = localize_index(&failed, &snapshot, Some(&expected())).unwrap();
        let fallback = &localized.packages[0].binary[&TargetArch::Wasm32];
        assert_eq!(fallback.status, EntryStatus::Failed);
        assert_eq!(
            fallback.fallback_archive_url.as_deref(),
            Some("zlib-1.3.1-rev2-abi39-wasm32-aaaaaaaa.tar.zst")
        );

        localized.update_entry_success(
            "zlib",
            "1.3.1",
            2,
            TargetArch::Wasm32,
            "zlib-1.3.1-rev2-abi39-wasm32-aaaaaaaa.tar.zst".into(),
            archive_sha,
            SHA.into(),
            "2026-07-24T01:00:00Z".into(),
            "https://example.test/run/2".into(),
        );
        let repaired = &localized.packages[0].binary[&TargetArch::Wasm32];
        assert_eq!(repaired.status, EntryStatus::Success);
        assert!(repaired.error.is_none());
        assert!(repaired.last_attempt.is_none());
        assert!(repaired.last_attempt_by.is_none());
        assert!(repaired.fallback_archive_url.is_none());
        assert!(repaired.fallback_archive_sha256.is_none());
        assert!(repaired.fallback_cache_key_sha.is_none());
        assert!(repaired.fallback_built_at.is_none());
        validate_finalized_index(&expected(), &localized, &dir, false).unwrap();
    }

    #[test]
    fn available_baseline_omits_a_failure_without_fallback() {
        let mut failed = IndexToml::empty(ABI, "2026-07-24T00:00:00Z".into(), "test".into());
        failed.update_entry_failed(
            "zlib",
            "1.3.1",
            2,
            TargetArch::Wasm32,
            "first build failed".into(),
            "2026-07-24T00:00:00Z".into(),
            "https://example.test/run/1".into(),
        );

        let snapshot =
            validate(&expected(), &failed, &[], ValidationMode::Available).unwrap();
        assert!(!snapshot.complete_current);
        assert!(snapshot.entries.is_empty());
        let localized = localize_index(&failed, &snapshot, Some(&expected())).unwrap();
        assert!(localized.packages.is_empty());
        assert!(validate(&expected(), &failed, &[], ValidationMode::Testable).is_err());
    }

    #[test]
    fn available_baseline_rejects_partial_or_malformed_failure_fallbacks() {
        let mut no_fallback =
            IndexToml::empty(ABI, "2026-07-24T00:00:00Z".into(), "test".into());
        no_fallback.update_entry_failed(
            "zlib",
            "1.3.1",
            2,
            TargetArch::Wasm32,
            "first build failed".into(),
            "2026-07-24T00:00:00Z".into(),
            "https://example.test/run/1".into(),
        );

        let mut partial = no_fallback.clone();
        partial.packages[0]
            .binary
            .get_mut(&TargetArch::Wasm32)
            .unwrap()
            .fallback_archive_url =
            Some("zlib-1.3.1-rev2-abi39-wasm32-aaaaaaaa.tar.zst".into());
        let error =
            validate(&expected(), &partial, &[], ValidationMode::Available).unwrap_err();
        assert!(error.contains("partial fallback identity"), "{error}");

        let mut built_at_only = no_fallback.clone();
        built_at_only.packages[0]
            .binary
            .get_mut(&TargetArch::Wasm32)
            .unwrap()
            .fallback_built_at = Some("2026-07-24T00:00:00Z".into());
        let error = validate(
            &expected(),
            &built_at_only,
            &[],
            ValidationMode::Available,
        )
        .unwrap_err();
        assert!(error.contains("partial fallback identity"), "{error}");

        let mut malformed = index();
        malformed.update_entry_failed(
            "zlib",
            "1.3.1",
            2,
            TargetArch::Wasm32,
            "matrix build failed".into(),
            "2026-07-24T00:00:00Z".into(),
            "https://example.test/run/1".into(),
        );
        malformed.packages[0]
            .binary
            .get_mut(&TargetArch::Wasm32)
            .unwrap()
            .fallback_archive_sha256 = Some("not-a-sha256".into());
        let error =
            validate(&expected(), &malformed, &assets(), ValidationMode::Available).unwrap_err();
        assert!(error.contains("archive_sha256"), "{error}");

        let mut inconsistent = no_fallback;
        inconsistent.packages[0]
            .binary
            .get_mut(&TargetArch::Wasm32)
            .unwrap()
            .archive_url = Some("must-not-remain-on-a-failure.tar.zst".into());
        let error = validate(
            &expected(),
            &inconsistent,
            &[],
            ValidationMode::Available,
        )
        .unwrap_err();
        assert!(error.contains("failure metadata is inconsistent"), "{error}");
    }

    #[test]
    fn available_baseline_prunes_stale_managed_entries() {
        for mutation in ["version", "revision", "cache"] {
            let mut changed = expected();
            match mutation {
                "version" => changed.entries[0].version = "1.3.2".into(),
                "revision" => changed.entries[0].revision = 3,
                "cache" => changed.entries[0].cache_key_sha = "c".repeat(64),
                _ => unreachable!(),
            }
            let snapshot =
                validate(&changed, &index(), &[], ValidationMode::Available).unwrap();
            assert!(!snapshot.complete_current, "{mutation}");
            assert!(snapshot.entries.is_empty(), "{mutation}");
            let localized = localize_index(&index(), &snapshot, Some(&changed)).unwrap();
            assert!(localized.packages.is_empty(), "{mutation}");

            let mut failed = index();
            failed.update_entry_failed(
                "zlib",
                "1.3.1",
                2,
                TargetArch::Wasm32,
                "matrix build failed".into(),
                "2026-07-24T00:00:00Z".into(),
                "https://example.test/run/1".into(),
            );
            let snapshot =
                validate(&changed, &failed, &[], ValidationMode::Available).unwrap();
            assert!(snapshot.entries.is_empty(), "{mutation} fallback");
            let localized = localize_index(&failed, &snapshot, Some(&changed)).unwrap();
            assert!(localized.packages.is_empty(), "{mutation} fallback");
        }

        let mut stale_without_archive_metadata = index();
        let entry = stale_without_archive_metadata.packages[0]
            .binary
            .get_mut(&TargetArch::Wasm32)
            .unwrap();
        entry.archive_url = None;
        entry.archive_sha256 = None;
        let mut changed = expected();
        changed.entries[0].cache_key_sha = "c".repeat(64);
        let snapshot = validate(
            &changed,
            &stale_without_archive_metadata,
            &[],
            ValidationMode::Available,
        )
        .unwrap();
        assert!(snapshot.entries.is_empty());
    }

    #[test]
    fn available_baseline_allows_a_kind_change_to_be_replaced_by_matrix_success() {
        let mut changed = expected();
        changed.entries[0].kind = ExpectedKind::Program;
        changed.entries[0].cache_key_sha = "c".repeat(64);

        let snapshot =
            validate(&changed, &index(), &[], ValidationMode::Available).unwrap();
        let mut localized = localize_index(&index(), &snapshot, Some(&changed)).unwrap();
        assert!(localized.packages.is_empty());

        let dir = archive_tempdir("available-kind-change");
        let archive_name = "zlib-1.3.1-rev2-abi39-wasm32-cccccccc.tar.zst";
        let archive = dir.join(archive_name);
        write_test_archive(
            &archive,
            "manifest.toml",
            archived_program_manifest(&"c".repeat(64)).as_bytes(),
            false,
        );
        localized.update_entry_success(
            "zlib",
            "1.3.1",
            2,
            TargetArch::Wasm32,
            archive_name.into(),
            sha256_file(&archive).unwrap(),
            "c".repeat(64),
            "2026-07-24T01:00:00Z".into(),
            "https://example.test/run/2".into(),
        );

        let assets = validate_finalized_index(&changed, &localized, &dir, false).unwrap();
        assert_eq!(assets.len(), 1);
        assert_eq!(assets[0].name, archive_name);
    }

    #[test]
    fn testable_mode_selects_and_localizes_an_exact_current_failure_fallback() {
        let mut failed = index();
        failed.update_entry_failed(
            "zlib",
            "1.3.1",
            2,
            TargetArch::Wasm32,
            "matrix build failed".into(),
            "2026-07-24T00:00:00Z".into(),
            "https://example.test/run/1".into(),
        );

        assert!(validate(&expected(), &failed, &assets(), ValidationMode::Current).is_err());
        let snapshot = validate(&expected(), &failed, &assets(), ValidationMode::Testable).unwrap();
        assert!(snapshot.complete_current);
        assert!(snapshot.entries[0].current);
        assert!(snapshot.entries[0].from_fallback);

        let localized = localize_index(&failed, &snapshot, None).unwrap();
        let entry = &localized.packages[0].binary[&TargetArch::Wasm32];
        assert!(entry.archive_url.is_none());
        assert_eq!(
            entry.fallback_archive_url.as_deref(),
            Some("zlib-1.3.1-rev2-abi39-wasm32-aaaaaaaa.tar.zst")
        );

        let mut stale = failed;
        stale.packages[0].revision = 3;
        assert!(validate(&expected(), &stale, &assets(), ValidationMode::Testable).is_err());
    }

    #[test]
    fn available_archive_scope_validates_present_subset_and_rejects_extras() {
        let dir = archive_tempdir("available-subset");
        let archive = dir.join("zlib-1.3.1-rev2-abi39-wasm32-aaaaaaaa.tar.zst");
        write_test_archive(
            &archive,
            "manifest.toml",
            archived_manifest(&[]).as_bytes(),
            false,
        );
        let mut snapshot = snapshot_for_archive(&archive, true);
        snapshot.complete_current = false;
        let mut expanded = expected();
        expanded.entries.push(ExpectedEntry {
            package: "bzip2".into(),
            kind: ExpectedKind::Library,
            arch: TargetArch::Wasm32,
            version: "1.0".into(),
            revision: 1,
            cache_key_sha: "c".repeat(64),
            git_inputs: Vec::new(),
        });

        validate_archive_snapshot(
            &expanded,
            &snapshot,
            &dir,
            ArchiveValidationScope::Available,
        )
        .unwrap();
        let mut falsely_complete = snapshot.clone();
        falsely_complete.complete_current = true;
        let error = validate_archive_snapshot(
            &expanded,
            &falsely_complete,
            &dir,
            ArchiveValidationScope::Available,
        )
        .unwrap_err();
        assert!(error.contains("claims complete_current"), "{error}");
        assert!(
            validate_archive_snapshot(
                &expanded,
                &snapshot,
                &dir,
                ArchiveValidationScope::All
            )
            .is_err()
        );

        let mut with_extra = snapshot;
        let mut extra = with_extra.entries[0].clone();
        extra.package = "not-expected".into();
        with_extra.entries.push(extra);
        let error = validate_archive_snapshot(
            &expanded,
            &with_extra,
            &dir,
            ArchiveValidationScope::Available,
        )
        .unwrap_err();
        assert!(error.contains("unexpected package/arch"), "{error}");
    }

    #[test]
    fn structural_mode_marks_stale_version_revision_and_key_for_rebuild() {
        for mutation in ["version", "revision", "key"] {
            let mut index = index();
            match mutation {
                "version" => {
                    index.packages[0].version = "1.3.0".into();
                    index.packages[0]
                        .binary
                        .get_mut(&TargetArch::Wasm32)
                        .unwrap()
                        .archive_url = Some("zlib-1.3.0-rev2-abi39-wasm32-aaaaaaaa.tar.zst".into());
                }
                "revision" => {
                    index.packages[0].revision = 1;
                    index.packages[0]
                        .binary
                        .get_mut(&TargetArch::Wasm32)
                        .unwrap()
                        .archive_url = Some("zlib-1.3.1-rev1-abi39-wasm32-aaaaaaaa.tar.zst".into());
                }
                "key" => {
                    let old = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
                    let entry = index.packages[0]
                        .binary
                        .get_mut(&TargetArch::Wasm32)
                        .unwrap();
                    entry.cache_key_sha = Some(old.into());
                    entry.archive_url =
                        Some("zlib-1.3.1-rev2-abi39-wasm32-cccccccc.tar.zst".into());
                }
                _ => unreachable!(),
            }
            let asset_name = index.packages[0]
                .binary
                .get(&TargetArch::Wasm32)
                .unwrap()
                .archive_url
                .clone()
                .unwrap();
            let mut assets = assets();
            assets[0].name = asset_name;
            let structural =
                validate(&expected(), &index, &assets, ValidationMode::Structural).unwrap();
            assert!(!structural.complete_current, "mutation {mutation}");
            assert!(
                validate(&expected(), &index, &assets, ValidationMode::Current).is_err(),
                "mutation {mutation}"
            );
        }
    }

    #[test]
    fn rejects_wrong_abi_status_arch_and_missing_coverage() {
        let mut wrong_abi = index();
        wrong_abi.abi_version = ABI - 1;
        assert!(
            validate(
                &expected(),
                &wrong_abi,
                &assets(),
                ValidationMode::Structural
            )
            .is_err()
        );

        let mut wrong_status = index();
        wrong_status.packages[0]
            .binary
            .get_mut(&TargetArch::Wasm32)
            .unwrap()
            .status = EntryStatus::Failed;
        assert!(
            validate(
                &expected(),
                &wrong_status,
                &assets(),
                ValidationMode::Structural
            )
            .is_err()
        );

        let mut wrong_arch = index();
        let entry = wrong_arch.packages[0]
            .binary
            .remove(&TargetArch::Wasm32)
            .unwrap();
        wrong_arch.packages[0]
            .binary
            .insert(TargetArch::Wasm64, entry);
        assert!(
            validate(
                &expected(),
                &wrong_arch,
                &assets(),
                ValidationMode::Structural
            )
            .is_err()
        );

        let mut missing = index();
        missing.packages.clear();
        assert!(validate(&expected(), &missing, &assets(), ValidationMode::Structural).is_err());
    }

    #[test]
    fn rejects_duplicate_package_arch_and_assets() {
        let mut duplicate_index = index();
        duplicate_index
            .packages
            .push(duplicate_index.packages[0].clone());
        assert!(
            validate(
                &expected(),
                &duplicate_index,
                &assets(),
                ValidationMode::Structural
            )
            .is_err()
        );

        let mut duplicate_assets = assets();
        duplicate_assets.push(duplicate_assets[0].clone());
        assert!(
            validate(
                &expected(),
                &index(),
                &duplicate_assets,
                ValidationMode::Structural
            )
            .is_err()
        );
    }

    #[test]
    fn rejects_managed_package_split_across_version_blocks_and_arches() {
        let mut expected = expected();
        let mut wasm64 = expected.entries[0].clone();
        wasm64.arch = TargetArch::Wasm64;
        expected.entries.push(wasm64);

        let mut split = index();
        let mut second = split.packages[0].clone();
        second.version = "1.2.99".into();
        let entry = second.binary.remove(&TargetArch::Wasm32).unwrap();
        second.binary.insert(TargetArch::Wasm64, entry);
        split.packages.push(second);

        assert!(validate(&expected, &split, &assets(), ValidationMode::Structural).is_err());
        assert!(compose_indexes(&split, &split, &expected).is_err());
    }

    #[test]
    fn rejects_empty_expected_ledger() {
        let empty = ExpectedLedger {
            abi_version: ABI,
            entries: Vec::new(),
        };
        assert!(validate(&empty, &index(), &assets(), ValidationMode::Structural).is_err());
    }

    #[test]
    fn rejects_wrong_url_name_absent_asset_and_bad_asset_metadata() {
        let mut wrong_name = index();
        wrong_name.packages[0]
            .binary
            .get_mut(&TargetArch::Wasm32)
            .unwrap()
            .archive_url = Some("other.tar.zst".into());
        assert!(
            validate(
                &expected(),
                &wrong_name,
                &assets(),
                ValidationMode::Structural
            )
            .is_err()
        );
        assert!(validate(&expected(), &index(), &[], ValidationMode::Structural).is_err());

        for mutation in ["state", "size", "digest-null", "digest-wrong"] {
            let mut assets = assets();
            match mutation {
                "state" => assets[0].state = "new".into(),
                "size" => assets[0].size = 0,
                "digest-null" => assets[0].digest = None,
                "digest-wrong" => assets[0].digest = Some(format!("sha256:{SHA}")),
                _ => unreachable!(),
            }
            assert!(
                validate(&expected(), &index(), &assets, ValidationMode::Structural).is_err(),
                "mutation {mutation}"
            );
        }
    }

    #[test]
    fn absolute_url_must_name_the_validated_release() {
        let mut valid = index();
        valid.packages[0]
            .binary
            .get_mut(&TargetArch::Wasm32)
            .unwrap()
            .archive_url = Some(format!(
            "https://github.com/Automattic/kandelo/releases/download/pr-946-staging/{}",
            assets()[0].name
        ));
        let snapshot =
            validate(&expected(), &valid, &assets(), ValidationMode::Structural).unwrap();
        let localized = localize_index(&valid, &snapshot, None).unwrap();
        assert_eq!(
            localized.packages[0].binary[&TargetArch::Wasm32]
                .archive_url
                .as_deref(),
            Some("zlib-1.3.1-rev2-abi39-wasm32-aaaaaaaa.tar.zst")
        );

        valid.packages[0]
            .binary
            .get_mut(&TargetArch::Wasm32)
            .unwrap()
            .archive_url = Some(format!(
            "https://github.com/Automattic/other/releases/download/pr-946-staging/{}",
            assets()[0].name
        ));
        assert!(validate(&expected(), &valid, &assets(), ValidationMode::Structural).is_err());
    }

    #[test]
    fn composes_validated_overlay_entries_into_local_base() {
        let mut base = index();
        let stale_sha = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
        let stale = base.packages[0]
            .binary
            .get_mut(&TargetArch::Wasm32)
            .unwrap();
        stale.cache_key_sha = Some(stale_sha.into());
        stale.archive_url = Some("zlib-1.3.1-rev2-abi39-wasm32-cccccccc.tar.zst".into());

        let composed = compose_indexes(&base, &index(), &expected()).unwrap();
        let entry = &composed.packages[0].binary[&TargetArch::Wasm32];
        assert_eq!(entry.cache_key_sha.as_deref(), Some(SHA));
        assert_eq!(
            entry.archive_url.as_deref(),
            Some("zlib-1.3.1-rev2-abi39-wasm32-aaaaaaaa.tar.zst")
        );
    }

    #[test]
    fn compose_rejects_incomplete_or_noncurrent_overlay() {
        let base = index();

        let mut wrong_abi = index();
        wrong_abi.abi_version = ABI - 1;
        assert!(compose_indexes(&base, &wrong_abi, &expected()).is_err());

        let mut missing = index();
        missing.packages[0].binary.clear();
        assert!(compose_indexes(&base, &missing, &expected()).is_err());

        let mut wrong_key = index();
        wrong_key.packages[0]
            .binary
            .get_mut(&TargetArch::Wasm32)
            .unwrap()
            .cache_key_sha = Some(ARCHIVE_SHA.into());
        assert!(compose_indexes(&base, &wrong_key, &expected()).is_err());

        let mut failed = index();
        failed.packages[0]
            .binary
            .get_mut(&TargetArch::Wasm32)
            .unwrap()
            .status = EntryStatus::Failed;
        assert!(compose_indexes(&base, &failed, &expected()).is_err());
    }

    #[test]
    fn archive_snapshot_accepts_exact_ordered_git_provenance() {
        let dir = archive_tempdir("exact-git");
        let path = dir.join("zlib.tar.zst");
        let git_inputs = vec![git_input("tap", '1'), git_input("support", '2')];
        write_test_archive(
            &path,
            "manifest.toml",
            archived_manifest(&git_inputs).as_bytes(),
            false,
        );
        validate_archive_snapshot(
            &expected_with_git_inputs(git_inputs),
            &snapshot_for_archive(&path, true),
            &dir,
            ArchiveValidationScope::All,
        )
        .unwrap();
    }

    #[test]
    fn archive_snapshot_rejects_missing_extra_wrong_or_reordered_git_provenance() {
        let expected_inputs = vec![git_input("tap", '1'), git_input("support", '2')];
        let cases = [
            ("missing", vec![expected_inputs[0].clone()]),
            (
                "extra",
                vec![
                    expected_inputs[0].clone(),
                    expected_inputs[1].clone(),
                    git_input("third", '3'),
                ],
            ),
            (
                "wrong",
                vec![git_input("tap", '4'), expected_inputs[1].clone()],
            ),
            (
                "reordered",
                vec![expected_inputs[1].clone(), expected_inputs[0].clone()],
            ),
        ];
        for (label, archived_inputs) in cases {
            let dir = archive_tempdir(label);
            let path = dir.join("zlib.tar.zst");
            write_test_archive(
                &path,
                "manifest.toml",
                archived_manifest(&archived_inputs).as_bytes(),
                false,
            );
            let error = validate_archive_snapshot(
                &expected_with_git_inputs(expected_inputs.clone()),
                &snapshot_for_archive(&path, true),
                &dir,
                ArchiveValidationScope::All,
            )
            .unwrap_err();
            assert!(error.contains("immutable Git inputs"), "{label}: {error}");
        }
    }

    #[test]
    fn archive_snapshot_rejects_wrong_size_and_digest_before_manifest_trust() {
        let dir = archive_tempdir("bytes");
        let path = dir.join("zlib.tar.zst");
        write_test_archive(
            &path,
            "manifest.toml",
            archived_manifest(&[]).as_bytes(),
            false,
        );

        let mut wrong_size = snapshot_for_archive(&path, true);
        wrong_size.entries[0].size += 1;
        let error =
            validate_archive_snapshot(&expected(), &wrong_size, &dir, ArchiveValidationScope::All)
                .unwrap_err();
        assert!(error.contains("validated snapshot requires"), "{error}");

        let mut wrong_digest = snapshot_for_archive(&path, true);
        wrong_digest.entries[0].archive_sha256 = "c".repeat(64);
        let error = validate_archive_snapshot(
            &expected(),
            &wrong_digest,
            &dir,
            ArchiveValidationScope::All,
        )
        .unwrap_err();
        assert!(error.contains("sha256"), "{error}");
    }

    #[test]
    fn archive_snapshot_rejects_unsafe_asset_name() {
        let dir = archive_tempdir("unsafe-asset");
        let mut snapshot = ValidatedSnapshot {
            abi_version: ABI,
            release_tag: "pr-946-staging".into(),
            complete_current: true,
            entries: vec![ValidatedEntry {
                package: "zlib".into(),
                kind: ExpectedKind::Library,
                arch: TargetArch::Wasm32,
                version: "1.3.1".into(),
                revision: 2,
                cache_key_sha: SHA.into(),
                current: true,
                from_fallback: false,
                asset: "../zlib.tar.zst".into(),
                archive_sha256: ARCHIVE_SHA.into(),
                size: 123,
            }],
        };
        let error =
            validate_archive_snapshot(&expected(), &snapshot, &dir, ArchiveValidationScope::All)
                .unwrap_err();
        assert!(error.contains("unsafe archive snapshot asset"), "{error}");

        snapshot.entries[0].asset = "nested/zlib.tar.zst".into();
        assert!(
            validate_archive_snapshot(&expected(), &snapshot, &dir, ArchiveValidationScope::All,)
                .unwrap_err()
                .contains("unsafe archive snapshot asset")
        );
    }

    #[cfg(unix)]
    #[test]
    fn archive_snapshot_rejects_symlinked_archive_asset() {
        use std::os::unix::fs::symlink;

        let dir = archive_tempdir("symlink-asset");
        let target = dir.join("real.tar.zst");
        write_test_archive(
            &target,
            "manifest.toml",
            archived_manifest(&[]).as_bytes(),
            false,
        );
        let link = dir.join("zlib.tar.zst");
        symlink(&target, &link).unwrap();
        let mut snapshot = snapshot_for_archive(&target, true);
        snapshot.entries[0].asset = "zlib.tar.zst".into();
        let error =
            validate_archive_snapshot(&expected(), &snapshot, &dir, ArchiveValidationScope::All)
                .unwrap_err();
        assert!(error.contains("regular non-symlink file"), "{error}");
    }

    #[test]
    fn archive_manifest_rejects_malformed_oversized_noncanonical_and_duplicate_entries() {
        let malformed_dir = archive_tempdir("malformed");
        let malformed = malformed_dir.join("malformed.tar.zst");
        write_test_archive(&malformed, "manifest.toml", b"not = [valid", false);
        assert!(
            read_archive_manifest(&malformed)
                .unwrap_err()
                .contains("parse manifest")
        );

        let oversized_dir = archive_tempdir("oversized");
        let oversized = oversized_dir.join("oversized.tar.zst");
        write_test_archive(
            &oversized,
            "manifest.toml",
            &vec![b' '; MAX_ARCHIVE_MANIFEST_BYTES as usize + 1],
            false,
        );
        assert!(
            read_archive_manifest(&oversized)
                .unwrap_err()
                .contains("manifest exceeds")
        );

        let noncanonical_dir = archive_tempdir("noncanonical");
        let noncanonical = noncanonical_dir.join("noncanonical.tar.zst");
        write_test_archive(
            &noncanonical,
            "metadata/manifest.toml",
            archived_manifest(&[]).as_bytes(),
            false,
        );
        assert!(
            read_archive_manifest(&noncanonical)
                .unwrap_err()
                .contains("must begin with regular manifest.toml")
        );

        let duplicate_dir = archive_tempdir("duplicate");
        let duplicate = duplicate_dir.join("duplicate.tar.zst");
        write_test_archive(
            &duplicate,
            "manifest.toml",
            archived_manifest(&[]).as_bytes(),
            true,
        );
        assert!(
            read_archive_manifest(&duplicate)
                .unwrap_err()
                .contains("duplicate manifest.toml")
        );
    }

    #[test]
    fn sparse_archive_preflight_skips_entries_without_current_git_provenance() {
        let dir = archive_tempdir("sparse-skip");
        let missing = dir.join("not-downloaded.tar.zst");
        let snapshot = ValidatedSnapshot {
            abi_version: ABI,
            release_tag: "pr-946-staging".into(),
            complete_current: true,
            entries: vec![ValidatedEntry {
                package: "zlib".into(),
                kind: ExpectedKind::Library,
                arch: TargetArch::Wasm32,
                version: "1.3.1".into(),
                revision: 2,
                cache_key_sha: SHA.into(),
                current: true,
                from_fallback: false,
                asset: missing.file_name().unwrap().to_string_lossy().into_owned(),
                archive_sha256: ARCHIVE_SHA.into(),
                size: 123,
            }],
        };
        validate_archive_snapshot(
            &expected(),
            &snapshot,
            &dir,
            ArchiveValidationScope::CurrentDeclaredGitInputs,
        )
        .unwrap();
        assert!(
            validate_archive_snapshot(&expected(), &snapshot, &dir, ArchiveValidationScope::All,)
                .is_err()
        );

        let mut stale_snapshot = snapshot;
        stale_snapshot.entries[0].current = false;
        validate_archive_snapshot(
            &expected_with_git_inputs(vec![git_input("tap", '1')]),
            &stale_snapshot,
            &dir,
            ArchiveValidationScope::CurrentDeclaredGitInputs,
        )
        .unwrap();
    }

    #[test]
    fn finalized_index_emits_only_referenced_verified_assets() {
        let dir = archive_tempdir("finalized-current");
        let archive_name = "zlib-1.3.1-rev2-abi39-wasm32-aaaaaaaa.tar.zst";
        let archive = dir.join(archive_name);
        write_test_archive(
            &archive,
            "manifest.toml",
            archived_manifest(&[]).as_bytes(),
            false,
        );
        fs::write(dir.join("unrelated.tar.zst"), b"not referenced").unwrap();

        let mut final_index = index();
        final_index.packages[0]
            .binary
            .get_mut(&TargetArch::Wasm32)
            .unwrap()
            .archive_sha256 = Some(sha256_file(&archive).unwrap());
        let assets = validate_finalized_index(&expected(), &final_index, &dir, false).unwrap();
        assert_eq!(assets.len(), 1);
        assert_eq!(assets[0].name, archive_name);
        assert_eq!(assets[0].size, fs::metadata(&archive).unwrap().len());
    }

    #[test]
    fn finalized_index_rejects_missing_changed_or_stale_current_archives() {
        let dir = archive_tempdir("finalized-rejections");
        let archive_name = "zlib-1.3.1-rev2-abi39-wasm32-aaaaaaaa.tar.zst";
        let archive = dir.join(archive_name);
        write_test_archive(
            &archive,
            "manifest.toml",
            archived_manifest(&[]).as_bytes(),
            false,
        );
        let mut final_index = index();
        final_index.packages[0]
            .binary
            .get_mut(&TargetArch::Wasm32)
            .unwrap()
            .archive_sha256 = Some(sha256_file(&archive).unwrap());

        let mut stale = final_index.clone();
        stale.packages[0]
            .binary
            .get_mut(&TargetArch::Wasm32)
            .unwrap()
            .cache_key_sha = Some("c".repeat(64));
        let error = validate_finalized_index(&expected(), &stale, &dir, false).unwrap_err();
        assert!(error.contains("cache key is stale"), "{error}");

        fs::write(&archive, b"changed after index composition").unwrap();
        let error = validate_finalized_index(&expected(), &final_index, &dir, false).unwrap_err();
        assert!(error.contains("sha256"), "{error}");

        fs::remove_file(&archive).unwrap();
        let error = validate_finalized_index(&expected(), &final_index, &dir, false).unwrap_err();
        assert!(error.contains("inspect final staging archive"), "{error}");
    }

    #[test]
    fn finalized_index_preserves_a_verified_failure_fallback() {
        let dir = archive_tempdir("finalized-fallback");
        let archive_name = "zlib-1.3.1-rev2-abi39-wasm32-aaaaaaaa.tar.zst";
        let archive = dir.join(archive_name);
        write_test_archive(
            &archive,
            "manifest.toml",
            archived_manifest(&[]).as_bytes(),
            false,
        );

        let mut final_index = index();
        let entry = final_index.packages[0]
            .binary
            .get_mut(&TargetArch::Wasm32)
            .unwrap();
        entry.archive_sha256 = Some(sha256_file(&archive).unwrap());
        final_index.update_entry_failed(
            "zlib",
            "1.3.1",
            2,
            TargetArch::Wasm32,
            "matrix build failed".into(),
            "2026-07-24T00:00:00Z".into(),
            "https://example.test/run/1".into(),
        );

        let assets = validate_finalized_index(&expected(), &final_index, &dir, true).unwrap();
        assert_eq!(assets.len(), 1);
        assert_eq!(assets[0].name, archive_name);
        let error = validate_finalized_index(&expected(), &final_index, &dir, false).unwrap_err();
        assert!(error.contains("records a failed build"), "{error}");

        final_index.packages[0]
            .binary
            .get_mut(&TargetArch::Wasm32)
            .unwrap()
            .fallback_archive_sha256 = None;
        let error = validate_finalized_index(&expected(), &final_index, &dir, true).unwrap_err();
        assert!(error.contains("partial fallback identity"), "{error}");
    }

    #[test]
    fn trim_index_removes_unmanaged_canonical_packages() {
        let dir = archive_tempdir("trim-index");
        let expected_path = dir.join("expected.json");
        let index_path = dir.join("index.toml");
        let output_path = dir.join("trimmed.toml");
        write_json(&expected_path, &expected()).unwrap();
        let mut source = index();
        source.packages.push(PackageEntry {
            name: "retired".into(),
            version: "1.0".into(),
            revision: 1,
            binary: BTreeMap::from([(TargetArch::Wasm32, binary())]),
        });
        fs::write(&index_path, source.write()).unwrap();

        run_trim_index(&[
            "--expected-ledger".into(),
            expected_path.to_string_lossy().into_owned(),
            "--index".into(),
            index_path.to_string_lossy().into_owned(),
            "--output".into(),
            output_path.to_string_lossy().into_owned(),
        ])
        .unwrap();

        let trimmed = read_index(&output_path).unwrap();
        assert_eq!(trimmed.packages.len(), 1);
        assert_eq!(trimmed.packages[0].name, "zlib");
    }
}
