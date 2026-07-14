//! Seed and activate an isolated merge-candidate package index.
//!
//! Prepare-merge tests a synthetic merge against a candidate release. The
//! candidate starts as an absolute-URL view of the canonical index, then the
//! normal per-entry publisher overlays candidate assets. After the exact tree
//! merges, activation compares the immutable base snapshot, candidate ledger,
//! and current canonical ledger. It rejects conflicting package drift and
//! writes one complete next canonical ledger plus the assets that must exist
//! before that ledger becomes visible.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use serde::Serialize;

use crate::index_toml::{IndexToml, PackageEntry};

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
struct AssetPlanEntry {
    name: String,
    sha256: String,
    source: AssetSource,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
enum AssetSource {
    Candidate,
    Canonical,
}

pub fn run(args: Vec<String>) -> Result<(), String> {
    let (action, rest) = args
        .split_first()
        .ok_or("usage: xtask index-candidate <seed|activate> [args]")?;
    let flags = parse_flags(rest)?;

    match action.as_str() {
        "seed" => run_seed(&flags),
        "activate" => run_activate(&flags),
        other => Err(format!(
            "index-candidate action must be seed or activate, got {other:?}"
        )),
    }
}

fn run_seed(flags: &BTreeMap<String, String>) -> Result<(), String> {
    reject_unknown(
        flags,
        &[
            "--canonical-index",
            "--candidate-index",
            "--canonical-index-url",
            "--expected-abi",
            "--generated-at",
            "--generator",
        ],
    )?;
    let canonical_path = path_flag(flags, "--canonical-index")?;
    let candidate_path = path_flag(flags, "--candidate-index")?;
    let canonical_url = required(flags, "--canonical-index-url")?;
    let expected_abi = abi_flag(flags)?;
    let generated_at = required(flags, "--generated-at")?;
    let generator = required(flags, "--generator")?;

    let canonical = read_index(canonical_path)?;
    let candidate = seed_index(
        &canonical,
        canonical_url,
        expected_abi,
        generated_at,
        generator,
    )?;
    write_index(candidate_path, &candidate)
}

fn run_activate(flags: &BTreeMap<String, String>) -> Result<(), String> {
    reject_unknown(
        flags,
        &[
            "--base-index",
            "--candidate-index",
            "--current-index",
            "--candidate-index-url",
            "--canonical-index-url",
            "--expected-abi",
            "--output-index",
            "--asset-plan",
            "--rejection-reason-file",
            "--activated-at",
            "--generator",
        ],
    )?;
    let rejection_reason_path = flags
        .get("--rejection-reason-file")
        .map(|value| Path::new(value.as_str()));
    if let Some(path) = rejection_reason_path {
        match std::fs::remove_file(path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!(
                    "remove stale --rejection-reason-file {}: {error}",
                    path.display()
                ));
            }
        }
    }
    let base = record_rejection(
        read_index(path_flag(flags, "--base-index")?),
        rejection_reason_path,
        "candidate-base-invalid",
    )?;
    let candidate = record_rejection(
        read_index(path_flag(flags, "--candidate-index")?),
        rejection_reason_path,
        "candidate-index-invalid",
    )?;
    let current = read_index(path_flag(flags, "--current-index")?)?;
    let candidate_url = required(flags, "--candidate-index-url")?;
    let canonical_url = required(flags, "--canonical-index-url")?;
    let expected_abi = abi_flag(flags)?;
    let activated_at = required(flags, "--activated-at")?;
    let generator = required(flags, "--generator")?;

    let (next, assets) = activate_index_with_rejection(
        &base,
        &candidate,
        &current,
        candidate_url,
        canonical_url,
        expected_abi,
        activated_at,
        generator,
        rejection_reason_path,
    )?;

    // Compute and validate the entire transaction before either output is
    // written. The caller uploads all listed assets before replacing the
    // canonical index with output-index exactly once.
    let asset_json = serde_json::to_string_pretty(&assets)
        .map_err(|e| format!("serialize candidate asset plan: {e}"))?;
    write_index(path_flag(flags, "--output-index")?, &next)?;
    std::fs::write(path_flag(flags, "--asset-plan")?, format!("{asset_json}\n"))
        .map_err(|e| format!("write --asset-plan: {e}"))
}

fn seed_index(
    canonical: &IndexToml,
    canonical_index_url: &str,
    expected_abi: u32,
    generated_at: &str,
    generator: &str,
) -> Result<IndexToml, String> {
    validate_index(canonical, "canonical", expected_abi)?;
    let mut seeded = canonical.clone();
    absolutize_index_urls(&mut seeded, canonical_index_url)?;
    seeded.generated_at = generated_at.to_string();
    seeded.generator = generator.to_string();
    validate_index(&seeded, "seeded candidate", expected_abi)?;
    Ok(seeded)
}

#[allow(clippy::too_many_arguments)]
fn activate_index(
    base: &IndexToml,
    candidate: &IndexToml,
    current: &IndexToml,
    candidate_index_url: &str,
    canonical_index_url: &str,
    expected_abi: u32,
    activated_at: &str,
    generator: &str,
) -> Result<(IndexToml, Vec<AssetPlanEntry>), String> {
    activate_index_with_rejection(
        base,
        candidate,
        current,
        candidate_index_url,
        canonical_index_url,
        expected_abi,
        activated_at,
        generator,
        None,
    )
}

#[allow(clippy::too_many_arguments)]
fn activate_index_with_rejection(
    base: &IndexToml,
    candidate: &IndexToml,
    current: &IndexToml,
    candidate_index_url: &str,
    canonical_index_url: &str,
    expected_abi: u32,
    activated_at: &str,
    generator: &str,
    rejection_reason_path: Option<&Path>,
) -> Result<(IndexToml, Vec<AssetPlanEntry>), String> {
    record_rejection(
        validate_index(base, "candidate base", expected_abi),
        rejection_reason_path,
        "candidate-base-invalid",
    )?;
    record_rejection(
        validate_index(candidate, "candidate", expected_abi),
        rejection_reason_path,
        "candidate-index-invalid",
    )?;
    validate_index(current, "current canonical", expected_abi)?;

    let base_by_key = record_rejection(
        package_map(base, "candidate base"),
        rejection_reason_path,
        "candidate-base-invalid",
    )?;
    let candidate_by_key = record_rejection(
        package_map(candidate, "candidate"),
        rejection_reason_path,
        "candidate-index-invalid",
    )?;
    package_map(current, "current canonical")?;

    // A candidate is an overlay, never a deletion transaction. This catches a
    // truncated or replaced candidate ledger before canonical state changes.
    for (key, base_pkg) in &base_by_key {
        let candidate_pkg = candidate_by_key.get(key).ok_or_else(|| {
            reject_message(
                rejection_reason_path,
                "candidate-index-invalid",
                format!(
                    "candidate removed package {}@{} from its immutable base",
                    key.0, key.1
                ),
            )
        })?;
        for arch in base_pkg.binary.keys() {
            if !candidate_pkg.binary.contains_key(arch) {
                return Err(reject_message(
                    rejection_reason_path,
                    "candidate-index-invalid",
                    format!(
                        "candidate removed {}@{} {} from its immutable base",
                        key.0,
                        key.1,
                        arch.as_str()
                    ),
                ));
            }
        }
    }

    let mut base_normalized = base.clone();
    record_rejection(
        absolutize_index_urls(&mut base_normalized, canonical_index_url),
        rejection_reason_path,
        "candidate-base-invalid",
    )?;
    let base_normalized = record_rejection(
        package_map(&base_normalized, "normalized candidate base"),
        rejection_reason_path,
        "candidate-base-invalid",
    )?;

    let mut candidate_provenance = candidate.clone();
    record_rejection(
        absolutize_index_urls(&mut candidate_provenance, candidate_index_url),
        rejection_reason_path,
        "candidate-index-invalid",
    )?;
    let candidate_provenance = record_rejection(
        package_map(&candidate_provenance, "normalized candidate"),
        rejection_reason_path,
        "candidate-index-invalid",
    )?;

    let mut current_normalized = current.clone();
    absolutize_index_urls(&mut current_normalized, canonical_index_url)?;
    let current_normalized = package_map(&current_normalized, "normalized current canonical")?;

    let all_keys: BTreeSet<_> = base_normalized
        .keys()
        .chain(candidate_provenance.keys())
        .cloned()
        .collect();
    let changed_keys: Vec<_> = all_keys
        .into_iter()
        .filter(|key| base_normalized.get(key) != candidate_provenance.get(key))
        .collect();

    let candidate_for_canonical = record_rejection(
        rewrite_candidate_for_canonical(
            candidate,
            candidate_index_url,
            canonical_index_url,
            &changed_keys,
        ),
        rejection_reason_path,
        "candidate-index-invalid",
    )?;
    let candidate_output = record_rejection(
        package_map(&candidate_for_canonical, "activation candidate"),
        rejection_reason_path,
        "candidate-index-invalid",
    )?;
    let mut candidate_desired_normalized = candidate_for_canonical.clone();
    record_rejection(
        absolutize_index_urls(&mut candidate_desired_normalized, canonical_index_url),
        rejection_reason_path,
        "candidate-index-invalid",
    )?;
    let candidate_desired_normalized = record_rejection(
        package_map(
            &candidate_desired_normalized,
            "normalized activation candidate",
        ),
        rejection_reason_path,
        "candidate-index-invalid",
    )?;

    for key in &changed_keys {
        let base_pkg = base_normalized.get(key);
        let current_pkg = current_normalized.get(key);
        let desired_pkg = candidate_desired_normalized.get(key);
        if current_pkg != base_pkg && current_pkg != desired_pkg {
            return Err(reject_message(
                rejection_reason_path,
                "same-package-drift",
                format!(
                    "canonical package {}@{} changed after candidate seeding; refusing to overwrite it",
                    key.0, key.1
                ),
            ));
        }
    }

    let pending_keys: Vec<_> = changed_keys
        .iter()
        .filter(|key| current_normalized.get(*key) != candidate_desired_normalized.get(*key))
        .cloned()
        .collect();

    let mut next = current.clone();
    for key in &pending_keys {
        let desired = candidate_output.get(key).ok_or_else(|| {
            reject_message(
                rejection_reason_path,
                "candidate-index-invalid",
                format!(
                    "candidate activation unexpectedly removed changed package {}@{}",
                    key.0, key.1
                ),
            )
        })?;
        replace_package(&mut next, key, (*desired).clone());
    }
    if !pending_keys.is_empty() {
        next.generated_at = activated_at.to_string();
        next.generator = generator.to_string();
    }
    record_rejection(
        validate_index(&next, "next canonical", expected_abi),
        rejection_reason_path,
        "candidate-index-invalid",
    )?;

    let assets = record_rejection(
        activation_assets(
            &pending_keys,
            &candidate_provenance,
            candidate_index_url,
            canonical_index_url,
        ),
        rejection_reason_path,
        "candidate-index-invalid",
    )?;
    Ok((next, assets))
}

fn record_rejection<T>(
    result: Result<T, String>,
    rejection_reason_path: Option<&Path>,
    reason: &str,
) -> Result<T, String> {
    result.map_err(|message| reject_message(rejection_reason_path, reason, message))
}

fn reject_message(rejection_reason_path: Option<&Path>, reason: &str, message: String) -> String {
    let Some(path) = rejection_reason_path else {
        return message;
    };
    match std::fs::write(path, format!("{reason}\n")) {
        Ok(()) => message,
        Err(error) => format!(
            "{message}; additionally failed to write deterministic rejection reason {}: {error}",
            path.display()
        ),
    }
}

fn parse_flags(args: &[String]) -> Result<BTreeMap<String, String>, String> {
    if args.len() % 2 != 0 {
        return Err(format!(
            "index-candidate flags require --key value pairs; trailing argument {:?}",
            args.last()
        ));
    }
    let mut out = BTreeMap::new();
    for pair in args.chunks_exact(2) {
        let key = pair[0].clone();
        if !key.starts_with("--") {
            return Err(format!("expected --flag, got {key:?}"));
        }
        if out.insert(key.clone(), pair[1].clone()).is_some() {
            return Err(format!("duplicate flag {key}"));
        }
    }
    Ok(out)
}

fn reject_unknown(flags: &BTreeMap<String, String>, allowed: &[&str]) -> Result<(), String> {
    for key in flags.keys() {
        if !allowed.contains(&key.as_str()) {
            return Err(format!("unknown flag: {key}"));
        }
    }
    Ok(())
}

fn required<'a>(flags: &'a BTreeMap<String, String>, key: &str) -> Result<&'a str, String> {
    flags
        .get(key)
        .map(String::as_str)
        .filter(|v| !v.is_empty())
        .ok_or_else(|| format!("missing {key}"))
}

fn path_flag<'a>(flags: &'a BTreeMap<String, String>, key: &str) -> Result<&'a Path, String> {
    Ok(Path::new(required(flags, key)?))
}

fn abi_flag(flags: &BTreeMap<String, String>) -> Result<u32, String> {
    required(flags, "--expected-abi")?
        .parse()
        .map_err(|e| format!("--expected-abi must be an integer: {e}"))
}

fn read_index(path: &Path) -> Result<IndexToml, String> {
    let text =
        std::fs::read_to_string(path).map_err(|e| format!("read index {}: {e}", path.display()))?;
    IndexToml::parse(&text).map_err(|e| format!("{}: {e}", path.display()))
}

fn write_index(path: &Path, index: &IndexToml) -> Result<(), String> {
    std::fs::write(path, index.write()).map_err(|e| format!("write index {}: {e}", path.display()))
}

fn validate_index(index: &IndexToml, label: &str, expected_abi: u32) -> Result<(), String> {
    if index.abi_version != expected_abi {
        return Err(format!(
            "{label} index ABI {} does not match expected ABI {expected_abi}",
            index.abi_version
        ));
    }
    index
        .validate_archive_abi_versions()
        .map_err(|e| format!("{label}: {e}"))?;
    package_map(index, label)?;
    Ok(())
}

type PackageKey = (String, String);

fn package_map<'a>(
    index: &'a IndexToml,
    label: &str,
) -> Result<BTreeMap<PackageKey, &'a PackageEntry>, String> {
    let mut out = BTreeMap::new();
    for package in &index.packages {
        let key = (package.name.clone(), package.version.clone());
        if out.insert(key.clone(), package).is_some() {
            return Err(format!(
                "{label} index contains duplicate package {}@{}",
                key.0, key.1
            ));
        }
    }
    Ok(out)
}

fn absolutize_index_urls(index: &mut IndexToml, index_url: &str) -> Result<(), String> {
    let base = url_parent(index_url)?;
    for package in &mut index.packages {
        for entry in package.binary.values_mut() {
            absolutize_field(&mut entry.archive_url, &base);
            absolutize_field(&mut entry.fallback_archive_url, &base);
        }
    }
    Ok(())
}

fn absolutize_field(value: &mut Option<String>, base: &str) {
    let Some(current) = value else {
        return;
    };
    if is_absolute_url(current) {
        return;
    }
    *current = format!("{base}{current}");
}

fn rewrite_candidate_for_canonical(
    candidate: &IndexToml,
    candidate_index_url: &str,
    canonical_index_url: &str,
    changed_keys: &[PackageKey],
) -> Result<IndexToml, String> {
    let candidate_base = url_parent(candidate_index_url)?;
    let canonical_base = url_parent(canonical_index_url)?;
    let mut out = candidate.clone();
    for package in &mut out.packages {
        let key = (package.name.clone(), package.version.clone());
        if !changed_keys.contains(&key) {
            continue;
        }
        for (arch, entry) in &mut package.binary {
            rewrite_field_for_canonical(
                &mut entry.archive_url,
                &candidate_base,
                &canonical_base,
                &package.name,
                arch.as_str(),
                "archive_url",
            )?;
            rewrite_field_for_canonical(
                &mut entry.fallback_archive_url,
                &candidate_base,
                &canonical_base,
                &package.name,
                arch.as_str(),
                "fallback_archive_url",
            )?;
        }
    }
    Ok(out)
}

fn rewrite_field_for_canonical(
    value: &mut Option<String>,
    candidate_base: &str,
    canonical_base: &str,
    package: &str,
    arch: &str,
    field: &str,
) -> Result<(), String> {
    let Some(current) = value else {
        return Ok(());
    };
    let absolute = if is_absolute_url(current) {
        current.clone()
    } else {
        format!("{candidate_base}{current}")
    };
    let name = asset_name_under(&absolute, candidate_base)
        .or_else(|| asset_name_under(&absolute, canonical_base))
        .ok_or_else(|| {
            format!(
                "candidate {package} {arch} {field} points outside the candidate and canonical releases: {absolute}"
            )
        })?;
    *current = name;
    Ok(())
}

fn activation_assets(
    changed_keys: &[PackageKey],
    candidate: &BTreeMap<PackageKey, &PackageEntry>,
    candidate_index_url: &str,
    canonical_index_url: &str,
) -> Result<Vec<AssetPlanEntry>, String> {
    let candidate_base = url_parent(candidate_index_url)?;
    let canonical_base = url_parent(canonical_index_url)?;
    let mut assets: BTreeMap<String, (String, AssetSource)> = BTreeMap::new();
    for key in changed_keys {
        let package = candidate
            .get(key)
            .ok_or_else(|| format!("changed candidate package {}@{} is missing", key.0, key.1))?;
        for (arch, entry) in &package.binary {
            collect_activation_asset(
                &mut assets,
                &entry.archive_url,
                &entry.archive_sha256,
                &candidate_base,
                &canonical_base,
                &package.name,
                arch.as_str(),
                "archive_url",
            )?;
            collect_activation_asset(
                &mut assets,
                &entry.fallback_archive_url,
                &entry.fallback_archive_sha256,
                &candidate_base,
                &canonical_base,
                &package.name,
                arch.as_str(),
                "fallback_archive_url",
            )?;
        }
    }
    Ok(assets
        .into_iter()
        .map(|(name, (sha256, source))| AssetPlanEntry {
            name,
            sha256,
            source,
        })
        .collect())
}

#[allow(clippy::too_many_arguments)]
fn collect_activation_asset(
    assets: &mut BTreeMap<String, (String, AssetSource)>,
    url: &Option<String>,
    sha: &Option<String>,
    candidate_base: &str,
    canonical_base: &str,
    package: &str,
    arch: &str,
    field: &str,
) -> Result<(), String> {
    let Some(url) = url else {
        return Ok(());
    };
    let (name, source) = if let Some(name) = asset_name_under(url, candidate_base) {
        (name, AssetSource::Candidate)
    } else if let Some(name) = asset_name_under(url, canonical_base) {
        (name, AssetSource::Canonical)
    } else {
        return Err(format!(
            "candidate {package} {arch} {field} points outside the candidate and canonical releases: {url}"
        ));
    };
    let sha = sha
        .as_deref()
        .ok_or_else(|| format!("candidate {package} {arch} {field} has no matching sha256"))?;
    validate_sha256(sha, package, arch, field)?;
    if let Some((existing_sha, existing_source)) = assets.get_mut(&name) {
        if existing_sha != sha {
            return Err(format!(
                "candidate asset {name} is referenced with conflicting sha256 values"
            ));
        }
        if source == AssetSource::Candidate {
            *existing_source = AssetSource::Candidate;
        }
    } else {
        assets.insert(name, (sha.to_string(), source));
    }
    Ok(())
}

fn validate_sha256(value: &str, package: &str, arch: &str, field: &str) -> Result<(), String> {
    if value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        return Ok(());
    }
    Err(format!(
        "candidate {package} {arch} {field} has invalid sha256 {value:?}"
    ))
}

fn url_parent(index_url: &str) -> Result<String, String> {
    if !is_absolute_url(index_url) {
        return Err(format!("index URL must be absolute: {index_url:?}"));
    }
    let slash = index_url
        .rfind('/')
        .ok_or_else(|| format!("index URL has no parent path: {index_url:?}"))?;
    Ok(index_url[..=slash].to_string())
}

fn is_absolute_url(value: &str) -> bool {
    value.starts_with("https://") || value.starts_with("http://") || value.starts_with("file://")
}

fn asset_name_under(url: &str, base: &str) -> Option<String> {
    let name = url.strip_prefix(base)?;
    let mut bytes = name.bytes();
    if !bytes
        .next()
        .is_some_and(|byte| byte.is_ascii_alphanumeric())
        || !bytes.all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'+' | b',' | b'-')
        })
    {
        return None;
    }
    Some(name.to_string())
}

fn replace_package(index: &mut IndexToml, key: &PackageKey, package: PackageEntry) {
    if let Some(position) = index
        .packages
        .iter()
        .position(|p| p.name == key.0 && p.version == key.1)
    {
        index.packages[position] = package;
    } else {
        index.packages.push(package);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index_toml::{BinaryEntry, EntryStatus};
    use crate::pkg_manifest::TargetArch;
    use tempfile::tempdir;

    const ABI: u32 = 39;
    const CANONICAL_URL: &str =
        "https://github.com/Automattic/kandelo/releases/download/binaries-abi-v39/index.toml";
    const CANDIDATE_URL: &str = concat!(
        "https://github.com/Automattic/kandelo/releases/download/",
        "merge-candidate-abi-v39-pr-1-run-2-attempt-1/index.toml"
    );
    fn sha(ch: char) -> String {
        std::iter::repeat_n(ch, 64).collect()
    }

    fn success(url: &str, sha256: &str, key: &str) -> BinaryEntry {
        BinaryEntry {
            status: EntryStatus::Success,
            archive_url: Some(url.into()),
            archive_sha256: Some(sha256.into()),
            cache_key_sha: Some(key.into()),
            built_at: Some("2026-07-14T00:00:00Z".into()),
            built_by: Some("test".into()),
            ..BinaryEntry::default()
        }
    }

    fn package(name: &str, url: &str, digest: char) -> PackageEntry {
        PackageEntry {
            name: name.into(),
            version: "1.0".into(),
            revision: 1,
            binary: BTreeMap::from([(
                TargetArch::Wasm32,
                success(url, &sha(digest), &sha(digest)),
            )]),
        }
    }

    fn index(packages: Vec<PackageEntry>) -> IndexToml {
        IndexToml {
            abi_version: ABI,
            generated_at: "seed".into(),
            generator: "test".into(),
            packages,
        }
    }

    #[test]
    fn seed_rewrites_canonical_relative_urls_to_absolute_urls() {
        let canonical = index(vec![package(
            "foo",
            "foo-1.0-rev1-abi39-wasm32-aaaaaaaa.tar.zst",
            'a',
        )]);
        let seeded = seed_index(
            &canonical,
            CANONICAL_URL,
            ABI,
            "candidate-time",
            "candidate-generator",
        )
        .unwrap();
        let entry = seeded.lookup("foo", "1.0", TargetArch::Wasm32).unwrap();
        assert_eq!(
            entry.archive_url.as_deref(),
            Some(
                "https://github.com/Automattic/kandelo/releases/download/binaries-abi-v39/foo-1.0-rev1-abi39-wasm32-aaaaaaaa.tar.zst"
            )
        );
        assert_eq!(seeded.generated_at, "candidate-time");
    }

    #[test]
    fn activation_is_one_overlay_and_preserves_unrelated_canonical_updates() {
        let base = index(vec![
            package(
                "bar",
                "https://mirror.invalid/bar-1.0-rev1-abi39-wasm32-bbbbbbbb.tar.zst",
                'b',
            ),
            package("foo", "foo-1.0-rev1-abi39-wasm32-aaaaaaaa.tar.zst", 'a'),
        ]);
        let mut candidate =
            seed_index(&base, CANONICAL_URL, ABI, "candidate", "candidate").unwrap();
        candidate.update_entry_success(
            "foo",
            "1.0",
            1,
            TargetArch::Wasm32,
            "foo-1.0-rev1-abi39-wasm32-cccccccc.tar.zst".into(),
            sha('c'),
            sha('c'),
            "candidate".into(),
            "candidate".into(),
        );
        candidate.update_entry_success(
            "baz",
            "1.0",
            1,
            TargetArch::Wasm32,
            "baz-1.0-rev1-abi39-wasm32-dddddddd.tar.zst".into(),
            sha('d'),
            sha('d'),
            "candidate".into(),
            "candidate".into(),
        );

        let mut current = base.clone();
        current.packages.push(package(
            "qux",
            "qux-1.0-rev1-abi39-wasm32-eeeeeeee.tar.zst",
            'e',
        ));

        let (next, assets) = activate_index(
            &base,
            &candidate,
            &current,
            CANDIDATE_URL,
            CANONICAL_URL,
            ABI,
            "activated",
            "activation",
        )
        .unwrap();

        assert_eq!(
            next.lookup("foo", "1.0", TargetArch::Wasm32)
                .unwrap()
                .archive_url
                .as_deref(),
            Some("foo-1.0-rev1-abi39-wasm32-cccccccc.tar.zst")
        );
        assert_eq!(
            next.lookup("bar", "1.0", TargetArch::Wasm32)
                .unwrap()
                .archive_url
                .as_deref(),
            Some("https://mirror.invalid/bar-1.0-rev1-abi39-wasm32-bbbbbbbb.tar.zst")
        );
        assert!(next.lookup("qux", "1.0", TargetArch::Wasm32).is_some());
        assert_eq!(
            assets,
            vec![
                AssetPlanEntry {
                    name: "baz-1.0-rev1-abi39-wasm32-dddddddd.tar.zst".into(),
                    sha256: sha('d'),
                    source: AssetSource::Candidate,
                },
                AssetPlanEntry {
                    name: "foo-1.0-rev1-abi39-wasm32-cccccccc.tar.zst".into(),
                    sha256: sha('c'),
                    source: AssetSource::Candidate,
                },
            ]
        );
    }

    #[test]
    fn activation_verifies_candidate_and_retained_canonical_archives() {
        let mut foo = package("foo", "foo-1.0-rev1-abi39-wasm32-aaaaaaaa.tar.zst", 'a');
        foo.binary.insert(
            TargetArch::Wasm64,
            success(
                "foo-1.0-rev1-abi39-wasm64-bbbbbbbb.tar.zst",
                &sha('b'),
                &sha('b'),
            ),
        );
        let base = index(vec![foo]);
        let mut candidate =
            seed_index(&base, CANONICAL_URL, ABI, "candidate", "candidate").unwrap();
        candidate.update_entry_success(
            "foo",
            "1.0",
            1,
            TargetArch::Wasm32,
            "foo-1.0-rev1-abi39-wasm32-cccccccc.tar.zst".into(),
            sha('c'),
            sha('c'),
            "candidate".into(),
            "candidate".into(),
        );

        let (_, assets) = activate_index(
            &base,
            &candidate,
            &base,
            CANDIDATE_URL,
            CANONICAL_URL,
            ABI,
            "activated",
            "activation",
        )
        .unwrap();

        assert_eq!(
            assets,
            vec![
                AssetPlanEntry {
                    name: "foo-1.0-rev1-abi39-wasm32-cccccccc.tar.zst".into(),
                    sha256: sha('c'),
                    source: AssetSource::Candidate,
                },
                AssetPlanEntry {
                    name: "foo-1.0-rev1-abi39-wasm64-bbbbbbbb.tar.zst".into(),
                    sha256: sha('b'),
                    source: AssetSource::Canonical,
                },
            ]
        );
    }

    #[test]
    fn activation_verifies_canonical_archive_moved_to_failure_fallback() {
        let base = index(vec![package(
            "foo",
            "foo-1.0-rev1-abi39-wasm32-aaaaaaaa.tar.zst",
            'a',
        )]);
        let mut candidate =
            seed_index(&base, CANONICAL_URL, ABI, "candidate", "candidate").unwrap();
        candidate.update_entry_failed(
            "foo",
            "1.0",
            1,
            TargetArch::Wasm32,
            "link failed".into(),
            "candidate".into(),
            "candidate".into(),
        );

        let (next, assets) = activate_index(
            &base,
            &candidate,
            &base,
            CANDIDATE_URL,
            CANONICAL_URL,
            ABI,
            "activated",
            "activation",
        )
        .unwrap();
        let entry = next.lookup("foo", "1.0", TargetArch::Wasm32).unwrap();
        assert_eq!(
            entry.fallback_archive_url.as_deref(),
            Some("foo-1.0-rev1-abi39-wasm32-aaaaaaaa.tar.zst")
        );
        assert_eq!(
            assets,
            vec![AssetPlanEntry {
                name: "foo-1.0-rev1-abi39-wasm32-aaaaaaaa.tar.zst".into(),
                sha256: sha('a'),
                source: AssetSource::Canonical,
            }]
        );
    }

    #[test]
    fn activation_rejects_conflicting_or_unverifiable_canonical_references() {
        let mut foo = package("foo", "shared.tar.zst", 'a');
        foo.binary.insert(
            TargetArch::Wasm64,
            success("other.tar.zst", &sha('b'), &sha('b')),
        );
        let base = index(vec![foo]);
        let mut candidate =
            seed_index(&base, CANONICAL_URL, ABI, "candidate", "candidate").unwrap();
        candidate.update_entry_success(
            "foo",
            "1.0",
            1,
            TargetArch::Wasm64,
            "shared.tar.zst".into(),
            sha('c'),
            sha('c'),
            "candidate".into(),
            "candidate".into(),
        );
        let error = activate_index(
            &base,
            &candidate,
            &base,
            CANDIDATE_URL,
            CANONICAL_URL,
            ABI,
            "activated",
            "activation",
        )
        .unwrap_err();
        assert!(error.contains("conflicting sha256"), "{error}");

        let mut missing_digest =
            seed_index(&base, CANONICAL_URL, ABI, "candidate", "candidate").unwrap();
        let entry = missing_digest.packages[0]
            .binary
            .get_mut(&TargetArch::Wasm32)
            .unwrap();
        entry.archive_sha256 = None;
        entry.built_by = Some("changed".into());
        let rejection_dir = tempdir().unwrap();
        let rejection_reason = rejection_dir.path().join("reason");
        let error = activate_index_with_rejection(
            &base,
            &missing_digest,
            &base,
            CANDIDATE_URL,
            CANONICAL_URL,
            ABI,
            "activated",
            "activation",
            Some(&rejection_reason),
        )
        .unwrap_err();
        assert!(error.contains("has no matching sha256"), "{error}");
        assert_eq!(
            std::fs::read_to_string(rejection_reason).unwrap(),
            "candidate-index-invalid\n"
        );
    }

    #[test]
    fn activation_rejects_same_package_canonical_drift() {
        let base = index(vec![package(
            "foo",
            "foo-1.0-rev1-abi39-wasm32-aaaaaaaa.tar.zst",
            'a',
        )]);
        let mut candidate =
            seed_index(&base, CANONICAL_URL, ABI, "candidate", "candidate").unwrap();
        candidate.update_entry_success(
            "foo",
            "1.0",
            1,
            TargetArch::Wasm32,
            "foo-1.0-rev1-abi39-wasm32-bbbbbbbb.tar.zst".into(),
            sha('b'),
            sha('b'),
            "candidate".into(),
            "candidate".into(),
        );
        let current = index(vec![package(
            "foo",
            "foo-1.0-rev1-abi39-wasm32-cccccccc.tar.zst",
            'c',
        )]);

        let rejection_dir = tempdir().unwrap();
        let rejection_reason = rejection_dir.path().join("reason");
        let error = activate_index_with_rejection(
            &base,
            &candidate,
            &current,
            CANDIDATE_URL,
            CANONICAL_URL,
            ABI,
            "activated",
            "activation",
            Some(&rejection_reason),
        )
        .unwrap_err();
        assert!(error.contains("changed after candidate seeding"), "{error}");
        assert_eq!(
            std::fs::read_to_string(rejection_reason).unwrap(),
            "same-package-drift\n"
        );
    }

    #[test]
    fn activation_is_idempotent_after_the_same_candidate_lands() {
        let base = index(vec![package(
            "foo",
            "foo-1.0-rev1-abi39-wasm32-aaaaaaaa.tar.zst",
            'a',
        )]);
        let mut candidate =
            seed_index(&base, CANONICAL_URL, ABI, "candidate", "candidate").unwrap();
        candidate.update_entry_success(
            "foo",
            "1.0",
            1,
            TargetArch::Wasm32,
            "foo-1.0-rev1-abi39-wasm32-bbbbbbbb.tar.zst".into(),
            sha('b'),
            sha('b'),
            "candidate".into(),
            "candidate".into(),
        );
        let (first, _) = activate_index(
            &base,
            &candidate,
            &base,
            CANDIDATE_URL,
            CANONICAL_URL,
            ABI,
            "activated",
            "activation",
        )
        .unwrap();
        let mut advanced = first.clone();
        advanced.packages.push(package(
            "qux",
            "qux-1.0-rev1-abi39-wasm32-cccccccc.tar.zst",
            'c',
        ));
        let (second, second_assets) = activate_index(
            &base,
            &candidate,
            &advanced,
            CANDIDATE_URL,
            CANONICAL_URL,
            ABI,
            "activated-again",
            "activation-again",
        )
        .unwrap();
        assert_eq!(second, advanced);
        assert!(second_assets.is_empty());
    }

    #[test]
    fn activation_rejects_candidate_urls_outside_owned_releases() {
        let base = index(vec![package(
            "foo",
            "foo-1.0-rev1-abi39-wasm32-aaaaaaaa.tar.zst",
            'a',
        )]);
        let mut candidate =
            seed_index(&base, CANONICAL_URL, ABI, "candidate", "candidate").unwrap();
        candidate.packages[0]
            .binary
            .get_mut(&TargetArch::Wasm32)
            .unwrap()
            .archive_url =
            Some("https://example.invalid/foo-1.0-rev1-abi39-wasm32-bbbbbbbb.tar.zst".into());

        let error = activate_index(
            &base,
            &candidate,
            &base,
            CANDIDATE_URL,
            CANONICAL_URL,
            ABI,
            "activated",
            "activation",
        )
        .unwrap_err();
        assert!(error.contains("outside the candidate and canonical releases"));
    }

    #[test]
    fn candidate_asset_names_use_generated_archive_grammar() {
        let base = url_parent(CANDIDATE_URL).unwrap();
        assert_eq!(
            asset_name_under(&format!("{base}foo+bar,baz-1.0_rev1.tar.zst"), &base).as_deref(),
            Some("foo+bar,baz-1.0_rev1.tar.zst")
        );
        for invalid in [
            "",
            ".",
            "..",
            "-foo.tar.zst",
            "_foo.tar.zst",
            "foo/bar.tar.zst",
            "foo\\bar.tar.zst",
            "foo?bar.tar.zst",
            "foo%2Fbar.tar.zst",
            "foo#bar.tar.zst",
            "foo bar.tar.zst",
            "foo\nbar.tar.zst",
            "foo:bar.tar.zst",
            "foo@bar.tar.zst",
            "foo[bar].tar.zst",
            "foo;bar.tar.zst",
            "foo=bar.tar.zst",
            "foo~bar.tar.zst",
        ] {
            assert!(
                asset_name_under(&format!("{base}{invalid}"), &base).is_none(),
                "accepted invalid asset name {invalid:?}"
            );
        }
    }

    #[test]
    fn activation_cli_rejects_uri_syntax_in_archive_names() {
        let base = index(vec![package(
            "foo",
            "foo-1.0-rev1-abi39-wasm32-aaaaaaaa.tar.zst",
            'a',
        )]);
        for exploit in [
            "foo?.tar.zst",
            "foo%2Fbar.tar.zst",
            "foo#fragment.tar.zst",
            "foo bar.tar.zst",
            "foo:bar.tar.zst",
            "foo/bar.tar.zst",
            "foo\\bar.tar.zst",
            "foo@bar.tar.zst",
            "foo[bar].tar.zst",
            "foo!bar.tar.zst",
            "foo$bar.tar.zst",
            "foo&bar.tar.zst",
            "foo'bar.tar.zst",
            "foo(bar).tar.zst",
            "foo*bar.tar.zst",
            "foo;bar.tar.zst",
            "foo=bar.tar.zst",
        ] {
            let mut candidate =
                seed_index(&base, CANONICAL_URL, ABI, "candidate", "candidate").unwrap();
            candidate.update_entry_success(
                "foo",
                "1.0",
                1,
                TargetArch::Wasm32,
                exploit.into(),
                sha('b'),
                sha('b'),
                "candidate".into(),
                "candidate".into(),
            );

            let dir = tempdir().unwrap();
            let base_path = dir.path().join("base-index.toml");
            let candidate_path = dir.path().join("candidate-index.toml");
            let current_path = dir.path().join("current-index.toml");
            let output_path = dir.path().join("next-index.toml");
            let plan_path = dir.path().join("assets.json");
            let rejection_path = dir.path().join("rejection");
            std::fs::write(&base_path, base.write()).unwrap();
            std::fs::write(&candidate_path, candidate.write()).unwrap();
            std::fs::write(&current_path, base.write()).unwrap();

            let error = run(vec![
                "activate".into(),
                "--base-index".into(),
                base_path.display().to_string(),
                "--candidate-index".into(),
                candidate_path.display().to_string(),
                "--current-index".into(),
                current_path.display().to_string(),
                "--candidate-index-url".into(),
                CANDIDATE_URL.into(),
                "--canonical-index-url".into(),
                CANONICAL_URL.into(),
                "--expected-abi".into(),
                ABI.to_string(),
                "--output-index".into(),
                output_path.display().to_string(),
                "--asset-plan".into(),
                plan_path.display().to_string(),
                "--rejection-reason-file".into(),
                rejection_path.display().to_string(),
                "--activated-at".into(),
                "activated".into(),
                "--generator".into(),
                "test".into(),
            ])
            .unwrap_err();

            assert!(
                error.contains("outside the candidate and canonical releases"),
                "exploit {exploit:?}: {error}"
            );
            assert_eq!(
                std::fs::read_to_string(&rejection_path).unwrap(),
                "candidate-index-invalid\n",
                "exploit {exploit:?}"
            );
            assert!(!output_path.exists(), "exploit {exploit:?} wrote output");
            assert!(!plan_path.exists(), "exploit {exploit:?} wrote a plan");
        }
    }
}
