//! Strict validation for reusing a mutable PR-staging package release.
//!
//! A release is a safe baseline only when its index covers every package/arch
//! that staging CI manages and every indexed archive is backed by one exact,
//! uploaded release asset whose size and GitHub-computed digest are usable.
//! Current package metadata is checked separately so a structurally complete
//! prior run can be combined only with an exact-current canonical complement.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::build_deps::{compute_cache_key_sha_for_package, Registry};
use crate::index_toml::{EntryStatus, IndexToml};
use crate::pkg_manifest::{DepsManifest, ManifestKind, TargetArch};

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
    current: bool,
    asset: String,
    archive_sha256: String,
    size: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ValidationMode {
    Structural,
    Current,
}

pub(crate) fn run(args: Vec<String>) -> Result<(), String> {
    let Some((action, rest)) = args.split_first() else {
        return Err("usage: xtask staging-reuse <expected|validate|compose> [args]".into());
    };
    match action.as_str() {
        "expected" => run_expected(rest),
        "validate" => run_validate(rest),
        "compose" => run_compose(rest),
        other => Err(format!(
            "staging-reuse action must be expected, validate, or compose, got {other:?}"
        )),
    }
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
    let expected: ExpectedLedger =
        read_json(flags.required_path("--overlay-expected-ledger")?)?;
    validate_expected_ledger(&expected)?;
    let base = read_index(base_path)?;
    let overlay = read_index(overlay_path)?;
    let composed = compose_indexes(&base, &overlay, &expected)?;
    std::fs::write(flags.required_path("--output")?, composed.write())
        .map_err(|e| format!("write composed index: {e}"))
}

fn read_index(path: &Path) -> Result<IndexToml, String> {
    let text = std::fs::read_to_string(path)
        .map_err(|e| format!("read {}: {e}", path.display()))?;
    IndexToml::parse(&text).map_err(|e| format!("{}: {e}", path.display()))
}

fn run_expected(args: &[String]) -> Result<(), String> {
    let flags = Flags::parse(args)?;
    flags.reject_unknown(&[
        "--registry",
        "--expected-abi",
        "--exclude",
        "--output",
    ])?;
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
    let index = IndexToml::parse(&index_text)
        .map_err(|e| format!("{}: {e}", index_path.display()))?;
    let assets: Vec<ReleaseAsset> = read_json(flags.required_path("--assets")?)?;
    let release_tag = flags.required("--release-tag")?;
    validate_release_tag(release_tag)?;
    let release_base_url = flags.required("--release-base-url")?;
    validate_release_base_url(release_base_url, release_tag)?;
    let mode = match flags.required("--mode")? {
        "structural" => ValidationMode::Structural,
        "current" => ValidationMode::Current,
        other => return Err(format!("--mode must be structural or current, got {other:?}")),
    };
    let snapshot = validate_release(
        &expected,
        &index,
        &assets,
        release_tag,
        release_base_url,
        mode,
    )?;
    let localized = localize_index(&index, &snapshot)?;
    std::fs::write(
        flags.required_path("--localized-index")?,
        localized.write(),
    )
    .map_err(|e| format!("write localized index: {e}"))?;
    write_json(flags.required_path("--output")?, &snapshot)
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
        for &arch in &manifest.target_arches {
            let key = (manifest.name.clone(), arch);
            if !keys.insert(key.clone()) {
                return Err(format!(
                    "expected ledger contains duplicate package/arch {} {}",
                    key.0,
                    key.1.as_str()
                ));
            }
            let cache_key_sha = compute_cache_key_sha_for_package(
                &package_dir,
                &registry,
                arch,
                abi_version,
            )?;
            validate_sha256(&cache_key_sha, "computed cache_key_sha")?;
            entries.push(ExpectedEntry {
                package: manifest.name.clone(),
                kind,
                arch,
                version: manifest.version.clone(),
                revision: manifest.revision,
                cache_key_sha,
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
            return Err(format!("release contains duplicate asset name {:?}", asset.name));
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
    for wanted in &expected.entries {
        let (package, binary) = index_entries
            .get(&(wanted.package.as_str(), wanted.arch))
            .ok_or_else(|| {
                format!(
                    "release index is incomplete: missing {} {}",
                    wanted.package,
                    wanted.arch.as_str()
                )
            })?;
        if binary.status != EntryStatus::Success {
            return Err(format!(
                "release index {} {} has status {:?}; a reusable baseline requires success",
                wanted.package,
                wanted.arch.as_str(),
                binary.status
            ));
        }
        let archive_url = required_entry_field(
            binary.archive_url.as_deref(),
            &wanted.package,
            wanted.arch,
            "archive_url",
        )?;
        let archive_sha256 = required_entry_field(
            binary.archive_sha256.as_deref(),
            &wanted.package,
            wanted.arch,
            "archive_sha256",
        )?;
        let cache_key_sha = required_entry_field(
            binary.cache_key_sha.as_deref(),
            &wanted.package,
            wanted.arch,
            "cache_key_sha",
        )?;
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

        let current = package.version == wanted.version
            && package.revision == wanted.revision
            && cache_key_sha == wanted.cache_key_sha;
        if !current {
            stale.push(format!("{} {}", wanted.package, wanted.arch.as_str()));
        }
        snapshot_entries.push(ValidatedEntry {
            package: wanted.package.clone(),
            kind: wanted.kind,
            arch: wanted.arch,
            current,
            asset: asset.name.clone(),
            archive_sha256: archive_sha256.to_owned(),
            size: asset.size,
        });
    }

    if mode == ValidationMode::Current && !stale.is_empty() {
        return Err(format!(
            "release is structurally complete but not current for: {}",
            stale.join(", ")
        ));
    }
    Ok(ValidatedSnapshot {
        abi_version: expected.abi_version,
        release_tag: release_tag.to_owned(),
        complete_current: stale.is_empty(),
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
) -> Result<IndexToml, String> {
    let mut localized = index.clone();
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
        entry.archive_url = Some(validated.asset.clone());
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
                ("fallback_archive_url", entry.fallback_archive_url.as_deref()),
            ] {
                let Some(value) = value else {
                    continue;
                };
                if value.contains('/')
                    || value.contains(['?', '#', '\\'])
                    || value.contains("..")
                {
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
            "release index {package} {} success entry lacks {field}",
            arch.as_str()
        )
    })
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
        return Err(format!("archive_url has invalid asset basename {archive_url:?}"));
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
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("create {}: {e}", parent.display()))?;
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
        self.0
            .get(flag)
            .into_iter()
            .flatten()
            .map(String::as_str)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index_toml::{BinaryEntry, PackageEntry};
    use std::fs;

    const ABI: u32 = 39;
    const SHA: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const ARCHIVE_SHA: &str =
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

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
            }],
        }
    }

    fn binary() -> crate::index_toml::BinaryEntry {
        BinaryEntry {
            status: EntryStatus::Success,
            archive_url: Some(
                "zlib-1.3.1-rev2-abi39-wasm32-aaaaaaaa.tar.zst".into(),
            ),
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
        assert_ne!(first.entries[0].cache_key_sha, second.entries[0].cache_key_sha);

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
        assert!(validate_release(
            &second,
            &stale_index,
            &stale_assets,
            "pr-946-staging",
            "https://github.com/Automattic/kandelo/releases/download/pr-946-staging/",
            ValidationMode::Current,
        )
        .is_err());
    }

    #[test]
    fn accepts_complete_current_release() {
        let snapshot = validate(
            &expected(),
            &index(),
            &assets(),
            ValidationMode::Current,
        )
        .unwrap();
        assert!(snapshot.complete_current);
        assert!(snapshot.entries[0].current);
    }

    #[test]
    fn structural_mode_marks_stale_version_revision_and_key_for_rebuild() {
        for mutation in ["version", "revision", "key"] {
            let mut index = index();
            match mutation {
                "version" => {
                    index.packages[0].version = "1.3.0".into();
                    index.packages[0].binary.get_mut(&TargetArch::Wasm32).unwrap().archive_url =
                        Some("zlib-1.3.0-rev2-abi39-wasm32-aaaaaaaa.tar.zst".into());
                }
                "revision" => {
                    index.packages[0].revision = 1;
                    index.packages[0].binary.get_mut(&TargetArch::Wasm32).unwrap().archive_url =
                        Some("zlib-1.3.1-rev1-abi39-wasm32-aaaaaaaa.tar.zst".into());
                }
                "key" => {
                    let old = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
                    let entry = index.packages[0].binary.get_mut(&TargetArch::Wasm32).unwrap();
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
            let structural = validate(
                &expected(),
                &index,
                &assets,
                ValidationMode::Structural,
            )
            .unwrap();
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
        assert!(validate(&expected(), &wrong_abi, &assets(), ValidationMode::Structural).is_err());

        let mut wrong_status = index();
        wrong_status
            .packages[0]
            .binary
            .get_mut(&TargetArch::Wasm32)
            .unwrap()
            .status = EntryStatus::Failed;
        assert!(validate(&expected(), &wrong_status, &assets(), ValidationMode::Structural).is_err());

        let mut wrong_arch = index();
        let entry = wrong_arch.packages[0]
            .binary
            .remove(&TargetArch::Wasm32)
            .unwrap();
        wrong_arch.packages[0]
            .binary
            .insert(TargetArch::Wasm64, entry);
        assert!(validate(&expected(), &wrong_arch, &assets(), ValidationMode::Structural).is_err());

        let mut missing = index();
        missing.packages.clear();
        assert!(validate(&expected(), &missing, &assets(), ValidationMode::Structural).is_err());
    }

    #[test]
    fn rejects_duplicate_package_arch_and_assets() {
        let mut duplicate_index = index();
        duplicate_index.packages.push(duplicate_index.packages[0].clone());
        assert!(
            validate(&expected(), &duplicate_index, &assets(), ValidationMode::Structural).is_err()
        );

        let mut duplicate_assets = assets();
        duplicate_assets.push(duplicate_assets[0].clone());
        assert!(
            validate(&expected(), &index(), &duplicate_assets, ValidationMode::Structural).is_err()
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
        assert!(validate(&expected(), &wrong_name, &assets(), ValidationMode::Structural).is_err());
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
        let localized = localize_index(&valid, &snapshot).unwrap();
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
}
