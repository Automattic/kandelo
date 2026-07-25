//! Strict validation for reusing a mutable PR-staging package release.
//!
//! A release is a safe baseline only when its index covers every package/arch
//! that staging CI manages and every indexed archive is backed by one exact,
//! uploaded release asset whose size and GitHub-computed digest are usable.
//! Current package metadata is checked separately so a structurally complete
//! prior run can be combined only with an exact-current canonical complement.

use std::collections::{BTreeMap, BTreeSet};
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::build_deps::{
    Registry, compute_cache_key_sha_for_package, source_cache_identities,
};
use crate::index_toml::{EntryStatus, IndexToml, PackageEntry};
use crate::pkg_manifest::{
    BuildToml, DepsManifest, GitBuildInput, ManifestKind, TargetArch, validate_git_build_inputs,
};

const SOURCE_IDENTITY_ALGORITHM: &str =
    "kandelo-program-packages-v2-manifest-closure-v1";
const CANONICAL_PACKAGE_SOURCE_REPOSITORY: &str =
    "https://github.com/Automattic/kandelo";

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct ExpectedLedger {
    abi_version: u32,
    entries: Vec<ExpectedEntry>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
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
#[serde(deny_unknown_fields)]
struct ReleaseAsset {
    name: String,
    state: String,
    size: u64,
    digest: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct ValidatedSnapshot {
    abi_version: u32,
    release_tag: String,
    complete_current: bool,
    entries: Vec<ValidatedEntry>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct ValidatedEntry {
    package: String,
    kind: ExpectedKind,
    arch: TargetArch,
    version: String,
    revision: u32,
    cache_key_sha: String,
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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ArchiveValidationScope {
    /// Validate every downloaded archive in a materialized snapshot.
    All,
    /// Metadata-only preflight downloads only entries that are current and
    /// declare external Git provenance. Other entries cannot be selected under
    /// a forged-equal Git identity because they have no such identity.
    CurrentDeclaredGitInputs,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct SourceProgramIndex {
    format: String,
    identities: BTreeMap<String, SourcePackageIdentity>,
    packages: BTreeMap<String, SourceProgramProjection>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct SourcePackageIdentity {
    manifest_sha256: String,
    cache_keys: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct SourceProgramProjection {
    manifest_sha256: String,
    arches: Vec<String>,
    cache_keys: BTreeMap<String, String>,
    dependency_closures: BTreeMap<String, Vec<SourceDependencyIdentity>>,
    members: Vec<SourceProjectionMember>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct SourceDependencyIdentity {
    package_name: String,
    manifest_sha256: String,
    cache_key: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
enum SourceProjectionMember {
    #[serde(rename_all = "camelCase")]
    Output {
        source_artifact: String,
        mirror_path: String,
        output_name: String,
        fork_instrumentation: String,
    },
    #[serde(rename_all = "camelCase")]
    RuntimeFile {
        source_artifact: String,
        mirror_path: String,
        guest_path: String,
        mode: u32,
    },
}

#[derive(Debug)]
struct SourcePackage {
    manifest_path: PathBuf,
    manifest_sha256: String,
    manifest: DepsManifest,
    git_inputs: Vec<GitBuildInput>,
}

pub(crate) fn run(args: Vec<String>) -> Result<(), String> {
    let Some((action, rest)) = args.split_first() else {
        return Err(
            "usage: xtask staging-reuse <expected|scan-source|validate|validate-archives|validate-generation|compose> [args]"
                .into(),
        );
    };
    match action.as_str() {
        "expected" => run_expected(rest),
        "scan-source" => run_scan_source(rest),
        "validate" => run_validate(rest),
        "validate-archives" => run_validate_archives(rest),
        "validate-generation" => run_validate_generation(rest),
        "compose" => run_compose(rest),
        other => Err(format!(
            "staging-reuse action must be expected, scan-source, validate, validate-archives, validate-generation, or compose, got {other:?}"
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

fn run_scan_source(args: &[String]) -> Result<(), String> {
    let flags = Flags::parse(args)?;
    flags.reject_unknown(&[
        "--source-root",
        "--expected-abi",
        "--arch",
        "--root-package",
        "--root-set",
        "--roots-file",
        "--projection-output",
        "--expected-output",
    ])?;
    let source_root = flags.required_path("--source-root")?;
    require_nonsymlink_dir(source_root, "package source root")?;
    let registry_path = source_root.join("packages/registry");
    require_nonsymlink_dir(&registry_path, "package source registry")?;
    let expected_abi = flags.required_u32("--expected-abi")?;
    let arch = parse_arch(flags.required("--arch")?)?;
    let root_packages = flags.values("--root-package").collect::<Vec<_>>();
    let root_sets = flags.values("--root-set").collect::<Vec<_>>();
    let roots_files = flags.values("--roots-file").collect::<Vec<_>>();
    let (schema, roots) = match (root_packages.as_slice(), root_sets.as_slice()) {
        ([root], []) => {
            if !roots_files.is_empty() {
                return Err("--roots-file is not valid with --root-package".into());
            }
            (1_u32, vec![validate_package_name(root)?.to_owned()])
        }
        ([], ["browser-inputs"]) => {
            let [path] = roots_files.as_slice() else {
                return Err(
                    "--root-set browser-inputs requires exactly one --roots-file".into(),
                );
            };
            (2_u32, read_source_roots(Path::new(path))?)
        }
        ([], [other]) => {
            return Err(format!("unsupported source root set {other:?}"));
        }
        _ => {
            return Err(
                "exactly one --root-package or --root-set must be provided".into(),
            );
        }
    };

    let packages = load_source_packages(&registry_path)?;
    let program_index_path = registry_path.join("program-packages.json");
    require_regular_file(&program_index_path, "program package identity index")?;
    let program_index: SourceProgramIndex = read_json(&program_index_path)?;
    let registry = Registry {
        roots: vec![registry_path.clone()],
    };
    let fresh_cache_identities =
        source_cache_identities(source_root, &registry, expected_abi)?;
    validate_source_program_index(
        &program_index,
        &packages,
        &fresh_cache_identities,
    )?;

    let (projection, expected) = build_source_selection(
        &packages,
        &program_index,
        &roots,
        arch,
        expected_abi,
        schema,
    )?;
    write_json(flags.required_path("--projection-output")?, &projection)?;
    write_json(flags.required_path("--expected-output")?, &expected)
}

fn build_source_selection(
    packages: &BTreeMap<String, SourcePackage>,
    program_index: &SourceProgramIndex,
    roots: &[String],
    arch: TargetArch,
    expected_abi: u32,
    schema: u32,
) -> Result<(serde_json::Value, ExpectedLedger), String> {
    let mut selected = BTreeSet::new();
    for root in roots {
        let root_manifest = packages
            .get(root)
            .ok_or_else(|| format!("source root package {root:?} is absent"))?;
        if root_manifest.manifest.kind != ManifestKind::Program {
            return Err(format!("source root package {root:?} is not a program"));
        }
        let root_projection = program_index
            .packages
            .get(root)
            .ok_or_else(|| format!("source root package {root:?} is not projected"))?;
        if !root_projection
            .arches
            .iter()
            .any(|candidate| candidate == arch.as_str())
        {
            return Err(format!(
                "source root package {root:?} does not support {}",
                arch.as_str()
            ));
        }
        selected.insert(root.clone());
        collect_source_dependency_names(root, packages, &mut selected, &mut Vec::new())?;
    }

    let mut expected_entries = Vec::new();
    let mut projection_entries = Vec::new();
    for package_name in selected {
        let package = packages
            .get(&package_name)
            .expect("selected source package was loaded");
        let identity = program_index
            .identities
            .get(&package_name)
            .expect("validated program index has every package identity");
        let cache_key_sha = identity
            .cache_keys
            .get(arch.as_str())
            .ok_or_else(|| {
                format!(
                    "source identity for {package_name:?} lacks {} cache key",
                    arch.as_str()
                )
            })?
            .clone();
        let (kind, disposition) = match package.manifest.kind {
            ManifestKind::Program => ("program", "program-archive"),
            ManifestKind::Library => ("library", "library-archive"),
            ManifestKind::Source => ("source", "source-only"),
        };
        projection_entries.push(serde_json::json!({
            "package": package_name,
            "arch": arch.as_str(),
            "kind": kind,
            "disposition": disposition,
            "manifest_sha256": package.manifest_sha256,
            "cache_key_sha": cache_key_sha,
        }));
        if package.manifest.kind == ManifestKind::Source {
            continue;
        }
        if !package
            .manifest
            .target_arches
            .iter()
            .any(|candidate| *candidate == arch)
        {
            return Err(format!(
                "selected source package {:?} does not publish {}",
                package.manifest.name,
                arch.as_str()
            ));
        }
        if package.manifest.build.script_path.is_none() {
            return Err(format!(
                "selected source package {:?} has no materializable build script",
                package.manifest.name
            ));
        }
        expected_entries.push(ExpectedEntry {
            package: package.manifest.name.clone(),
            kind: match package.manifest.kind {
                ManifestKind::Program => ExpectedKind::Program,
                ManifestKind::Library => ExpectedKind::Library,
                ManifestKind::Source => unreachable!(),
            },
            arch,
            version: package.manifest.version.clone(),
            revision: package.manifest.revision,
            cache_key_sha,
            git_inputs: package.git_inputs.clone(),
        });
    }
    expected_entries.sort_by(|a, b| (&a.package, a.arch).cmp(&(&b.package, b.arch)));
    let expected = ExpectedLedger {
        abi_version: expected_abi,
        entries: expected_entries,
    };
    validate_expected_ledger(&expected)?;

    let projection = if schema == 1 {
        if projection_entries
            .iter()
            .any(|entry| entry["disposition"] == "source-only")
        {
            return Err(
                "legacy single-root projection cannot represent a source-only dependency".into(),
            );
        }
        let entries = projection_entries
            .into_iter()
            .map(|entry| {
                serde_json::json!({
                    "package": entry["package"],
                    "arch": entry["arch"],
                    "manifest_sha256": entry["manifest_sha256"],
                    "cache_key_sha": entry["cache_key_sha"],
                })
            })
            .collect::<Vec<_>>();
        serde_json::json!({
            "schema": 1,
            "root_package": roots[0],
            "arch": arch.as_str(),
            "entries": entries,
        })
    } else if schema == 2 {
        serde_json::json!({
            "schema": 2,
            "identity_algorithm": SOURCE_IDENTITY_ALGORITHM,
            "root_set": "browser-inputs",
            "roots": roots,
            "arch": arch.as_str(),
            "closure": projection_entries,
        })
    } else {
        return Err(format!("unsupported source projection schema {schema}"));
    };
    Ok((projection, expected))
}

fn require_nonsymlink_dir(path: &Path, context: &str) -> Result<(), String> {
    let metadata =
        std::fs::symlink_metadata(path).map_err(|e| format!("inspect {}: {e}", path.display()))?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(format!(
            "{context} must be a non-symlink directory: {}",
            path.display()
        ));
    }
    Ok(())
}

fn require_regular_file(path: &Path, context: &str) -> Result<(), String> {
    let metadata =
        std::fs::symlink_metadata(path).map_err(|e| format!("inspect {}: {e}", path.display()))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(format!(
            "{context} must be a regular non-symlink file: {}",
            path.display()
        ));
    }
    Ok(())
}

fn validate_package_name(value: &str) -> Result<&str, String> {
    if value.is_empty()
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"._-".contains(&byte))
        || !value.as_bytes()[0].is_ascii_lowercase()
            && !value.as_bytes()[0].is_ascii_digit()
    {
        return Err(format!("invalid package name {value:?}"));
    }
    Ok(value)
}

fn parse_arch(value: &str) -> Result<TargetArch, String> {
    match value {
        "wasm32" => Ok(TargetArch::Wasm32),
        "wasm64" => Ok(TargetArch::Wasm64),
        other => Err(format!("unsupported target architecture {other:?}")),
    }
}

fn read_source_roots(path: &Path) -> Result<Vec<String>, String> {
    require_regular_file(path, "source root list")?;
    let bytes = std::fs::read(path)
        .map_err(|e| format!("read source root list {}: {e}", path.display()))?;
    if bytes.is_empty() || bytes.len() > 64 * 1024 {
        return Err("source root list must contain 1..65536 bytes".into());
    }
    let text = std::str::from_utf8(&bytes)
        .map_err(|e| format!("source root list is not UTF-8: {e}"))?;
    let roots = text
        .lines()
        .map(|root| validate_package_name(root).map(ToOwned::to_owned))
        .collect::<Result<Vec<_>, _>>()?;
    if roots.is_empty() || roots.len() > 256 {
        return Err("source root list must contain 1..256 roots".into());
    }
    let canonical = roots
        .iter()
        .map(|root| format!("{root}\n"))
        .collect::<String>();
    if canonical.as_bytes() != bytes {
        return Err("source root list must be sorted canonical newline-delimited UTF-8".into());
    }
    let mut sorted = roots.clone();
    sorted.sort();
    sorted.dedup();
    if sorted != roots {
        return Err("source root list must be sorted and unique".into());
    }
    Ok(roots)
}

fn load_source_packages(registry_path: &Path) -> Result<BTreeMap<String, SourcePackage>, String> {
    let mut package_dirs = Vec::new();
    for entry in std::fs::read_dir(registry_path)
        .map_err(|e| format!("read source registry {}: {e}", registry_path.display()))?
    {
        let entry = entry.map_err(|e| format!("read source registry entry: {e}"))?;
        let package_dir = entry.path();
        let manifest_path = package_dir.join("package.toml");
        if !manifest_path.exists() {
            continue;
        }
        require_nonsymlink_dir(&package_dir, "source package directory")?;
        require_regular_file(&manifest_path, "source package manifest")?;
        package_dirs.push(package_dir);
    }
    package_dirs.sort();

    let mut packages = BTreeMap::new();
    for package_dir in package_dirs {
        let manifest_path = package_dir.join("package.toml");
        let overlay_path = package_dir.join("package.pr.toml");
        if overlay_path.exists() || overlay_path.is_symlink() {
            return Err(format!(
                "activated main source must not contain a PR package overlay: {}",
                overlay_path.display()
            ));
        }
        let mut manifest = DepsManifest::load(&manifest_path)?;
        let directory_name = package_dir
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| {
                format!(
                    "source package directory is not valid UTF-8: {}",
                    package_dir.display()
                )
            })?;
        if manifest.name != directory_name {
            return Err(format!(
                "{} names package {:?}, expected directory {:?}",
                manifest_path.display(),
                manifest.name,
                directory_name
            ));
        }
        let build_path = package_dir.join("build.toml");
        let git_inputs = if build_path.exists() {
            require_regular_file(&build_path, "source package build metadata")?;
            let build = BuildToml::load(&package_dir)
                .map_err(|e| format!("{}: {e}", build_path.display()))?;
            if let Some(revision) = build.revision {
                manifest.revision = revision;
            }
            build.git_inputs
        } else {
            Vec::new()
        };
        let manifest_sha256 = sha256_file(&manifest_path)?;
        if packages
            .insert(
                manifest.name.clone(),
                SourcePackage {
                    manifest_path,
                    manifest_sha256,
                    manifest,
                    git_inputs,
                },
            )
            .is_some()
        {
            return Err(format!("duplicate source package {directory_name:?}"));
        }
    }
    if packages.is_empty() {
        return Err("package source registry is empty".into());
    }
    Ok(packages)
}

fn collect_source_dependency_names(
    package_name: &str,
    packages: &BTreeMap<String, SourcePackage>,
    selected: &mut BTreeSet<String>,
    visiting: &mut Vec<String>,
) -> Result<(), String> {
    if visiting.iter().any(|name| name == package_name) {
        return Err(format!(
            "cycle in source package graph: {} -> {package_name}",
            visiting.join(" -> ")
        ));
    }
    let package = packages
        .get(package_name)
        .ok_or_else(|| format!("source package {package_name:?} is absent"))?;
    visiting.push(package_name.to_owned());
    for dependency in &package.manifest.depends_on {
        let child = packages.get(&dependency.name).ok_or_else(|| {
            format!(
                "{} depends on absent source package {}@{}",
                package.manifest.spec(),
                dependency.name,
                dependency.version
            )
        })?;
        if child.manifest.version != dependency.version {
            return Err(format!(
                "{} depends on {}@{}, source registry has {}",
                package.manifest.spec(),
                dependency.name,
                dependency.version,
                child.manifest.spec()
            ));
        }
        let inserted = selected.insert(dependency.name.clone());
        if inserted {
            collect_source_dependency_names(&dependency.name, packages, selected, visiting)?;
        } else if visiting.iter().any(|name| name == &dependency.name) {
            return Err(format!(
                "cycle in source package graph: {} -> {}",
                visiting.join(" -> "),
                dependency.name
            ));
        }
    }
    visiting.pop();
    Ok(())
}

fn source_dependency_closure(
    package_name: &str,
    arch: TargetArch,
    packages: &BTreeMap<String, SourcePackage>,
    identities: &BTreeMap<String, SourcePackageIdentity>,
) -> Result<Vec<SourceDependencyIdentity>, String> {
    let mut names = BTreeSet::new();
    collect_source_dependency_names(package_name, packages, &mut names, &mut Vec::new())?;
    names.remove(package_name);
    names
        .into_iter()
        .map(|name| {
            let package = packages
                .get(&name)
                .expect("fresh dependency traversal only selects loaded packages");
            let identity = identities
                .get(&name)
                .ok_or_else(|| format!("program index lacks source identity for {name:?}"))?;
            let cache_key = identity
                .cache_keys
                .get(arch.as_str())
                .ok_or_else(|| {
                    format!(
                        "program index identity for {name:?} lacks {} cache key",
                        arch.as_str()
                    )
                })?
                .clone();
            Ok(SourceDependencyIdentity {
                package_name: name,
                manifest_sha256: package.manifest_sha256.clone(),
                cache_key,
            })
        })
        .collect()
}

fn source_projection_members(manifest: &DepsManifest) -> Result<Vec<SourceProjectionMember>, String> {
    let mut members = Vec::new();
    for output in &manifest.program_outputs {
        let mirror_path = manifest
            .output_dest_rel_for(output)
            .to_str()
            .ok_or_else(|| format!("{} output mirror path is not UTF-8", manifest.spec()))?
            .to_owned();
        members.push(SourceProjectionMember::Output {
            source_artifact: output.wasm.clone(),
            mirror_path,
            output_name: output.name.clone(),
            fork_instrumentation: output.fork_instrumentation.as_str().to_owned(),
        });
    }
    for runtime_file in &manifest.runtime_files {
        let mirror_path = manifest
            .runtime_file_dest_rel_for(runtime_file)
            .to_str()
            .ok_or_else(|| format!("{} runtime mirror path is not UTF-8", manifest.spec()))?
            .to_owned();
        members.push(SourceProjectionMember::RuntimeFile {
            source_artifact: runtime_file.artifact.clone(),
            mirror_path,
            guest_path: runtime_file.guest_path.clone(),
            mode: runtime_file.mode,
        });
    }
    Ok(members)
}

fn validate_source_program_index(
    index: &SourceProgramIndex,
    packages: &BTreeMap<String, SourcePackage>,
    fresh_cache_identities: &BTreeMap<String, BTreeMap<String, String>>,
) -> Result<(), String> {
    if index.format != "kandelo-program-packages-v2" {
        return Err(format!(
            "unsupported source program identity format {:?}",
            index.format
        ));
    }
    if index.identities.keys().ne(packages.keys()) {
        return Err(
            "source program index identities do not exactly cover package.toml manifests".into(),
        );
    }
    if fresh_cache_identities.keys().ne(packages.keys()) {
        return Err(
            "fresh source cache identities do not exactly cover package.toml manifests".into(),
        );
    }
    let expected_identity_arches = BTreeSet::from(["wasm32", "wasm64"]);
    for (name, package) in packages {
        let identity = index
            .identities
            .get(name)
            .expect("source identity key set was compared");
        validate_sha256(&identity.manifest_sha256, "source manifest_sha256")?;
        if identity.manifest_sha256 != package.manifest_sha256 {
            return Err(format!(
                "source program identity for {name:?} has stale manifest digest (manifest {})",
                package.manifest_path.display()
            ));
        }
        if identity
            .cache_keys
            .keys()
            .map(String::as_str)
            .collect::<BTreeSet<_>>()
            != expected_identity_arches
        {
            return Err(format!(
                "source program identity for {name:?} must bind wasm32 and wasm64 cache keys"
            ));
        }
        for cache_key in identity.cache_keys.values() {
            validate_sha256(cache_key, "source cache key")?;
        }
        if fresh_cache_identities.get(name) != Some(&identity.cache_keys) {
            return Err(format!(
                "source program identity for {name:?} has a stale contextual cache key"
            ));
        }
    }

    let expected_programs = packages
        .iter()
        .filter_map(|(name, package)| {
            (package.manifest.kind == ManifestKind::Program
                && !package.manifest.uses_root_binary_mirror())
            .then_some(name.as_str())
        })
        .collect::<BTreeSet<_>>();
    let actual_programs = index
        .packages
        .keys()
        .map(String::as_str)
        .collect::<BTreeSet<_>>();
    if actual_programs != expected_programs {
        return Err(
            "source program projections do not exactly cover eligible program manifests".into(),
        );
    }

    for (name, projection) in &index.packages {
        let package = packages
            .get(name)
            .expect("source program projection set was compared");
        let identity = index
            .identities
            .get(name)
            .expect("source identity set was compared");
        if projection.manifest_sha256 != package.manifest_sha256
            || projection.manifest_sha256 != identity.manifest_sha256
        {
            return Err(format!(
                "source program projection for {name:?} has a stale manifest identity"
            ));
        }
        let expected_arches = package
            .manifest
            .target_arches
            .iter()
            .map(|arch| arch.as_str().to_owned())
            .collect::<Vec<_>>();
        if projection.arches != expected_arches {
            return Err(format!(
                "source program projection for {name:?} has stale target arches"
            ));
        }
        let expected_arch_keys = expected_arches.iter().cloned().collect::<BTreeSet<_>>();
        if projection.cache_keys.keys().cloned().collect::<BTreeSet<_>>()
            != expected_arch_keys
            || projection
                .dependency_closures
                .keys()
                .cloned()
                .collect::<BTreeSet<_>>()
                != expected_arch_keys
        {
            return Err(format!(
                "source program projection for {name:?} does not exactly cover its arches"
            ));
        }
        for arch_name in &expected_arches {
            let arch = parse_arch(arch_name)?;
            if projection.cache_keys.get(arch_name) != identity.cache_keys.get(arch_name) {
                return Err(format!(
                    "source program projection for {name:?} has a non-contextual {arch_name} cache key"
                ));
            }
            let expected_closure =
                source_dependency_closure(name, arch, packages, &index.identities)?;
            if projection.dependency_closures.get(arch_name) != Some(&expected_closure) {
                return Err(format!(
                    "source program projection for {name:?} has a stale or substituted {arch_name} dependency closure"
                ));
            }
        }
        let expected_members = source_projection_members(&package.manifest)?;
        if projection.members != expected_members {
            return Err(format!(
                "source program projection for {name:?} has stale output members"
            ));
        }
    }
    Ok(())
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
        "structural" => ValidationMode::Structural,
        "current" => ValidationMode::Current,
        other => {
            return Err(format!(
                "--mode must be structural or current, got {other:?}"
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
    let localized = localize_index(&index, &snapshot)?;
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
        "--expected-source-repository",
        "--expected-source-commit",
    ])?;
    let expected: ExpectedLedger = read_json(flags.required_path("--expected-ledger")?)?;
    let snapshot: ValidatedSnapshot = read_json(flags.required_path("--snapshot")?)?;
    let scope = match flags.required("--scope")? {
        "all" => ArchiveValidationScope::All,
        "current-declared-git-inputs" => ArchiveValidationScope::CurrentDeclaredGitInputs,
        other => {
            return Err(format!(
                "--scope must be all or current-declared-git-inputs, got {other:?}"
            ));
        }
    };
    let source_repositories: Vec<_> = flags.values("--expected-source-repository").collect();
    let source_commits: Vec<_> = flags.values("--expected-source-commit").collect();
    let expected_source = match (source_repositories.as_slice(), source_commits.as_slice()) {
        ([], []) => None,
        ([repository], [commit]) => {
            let valid_repository_component = |component: &str| {
                !component.is_empty()
                    && component.bytes().all(|byte| {
                        byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-')
                    })
            };
            let repository_parts = repository
                .strip_prefix("https://github.com/")
                .map(|path| path.split('/').collect::<Vec<_>>())
                .unwrap_or_default();
            if repository_parts.len() != 2
                || !repository_parts
                    .iter()
                    .all(|component| valid_repository_component(component))
            {
                return Err(
                    "--expected-source-repository must be a canonical HTTPS GitHub repository URL"
                        .into(),
                );
            }
            if commit.len() != 40
                || !commit
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            {
                return Err(
                    "--expected-source-commit must be 40 lowercase hexadecimal characters".into(),
                );
            }
            Some((*repository, *commit))
        }
        _ => {
            return Err(
                "--expected-source-repository and --expected-source-commit must be provided exactly once together"
                    .into(),
            );
        }
    };
    validate_archive_snapshot(
        &expected,
        &snapshot,
        flags.required_path("--archives-dir")?,
        scope,
        expected_source,
    )
}

fn run_validate_generation(args: &[String]) -> Result<(), String> {
    let flags = Flags::parse(args)?;
    flags.reject_unknown(&[
        "--expected-ledger",
        "--snapshot",
        "--index",
        "--assets",
        "--bundle-dir",
        "--release-tag",
        "--release-base-url",
        "--package-source-sha",
    ])?;
    let expected: ExpectedLedger = read_json(flags.required_path("--expected-ledger")?)?;
    let declared_snapshot: ValidatedSnapshot =
        read_json(flags.required_path("--snapshot")?)?;
    let index_path = flags.required_path("--index")?;
    require_regular_file(index_path, "durable generation index")?;
    let index_text = std::fs::read_to_string(index_path)
        .map_err(|e| format!("read {}: {e}", index_path.display()))?;
    let index =
        IndexToml::parse(&index_text).map_err(|e| format!("{}: {e}", index_path.display()))?;
    let assets: Vec<ReleaseAsset> = read_json(flags.required_path("--assets")?)?;
    let release_tag = flags.required("--release-tag")?;
    validate_release_tag(release_tag)?;
    let release_base_url = flags.required("--release-base-url")?;
    validate_release_base_url(release_base_url, release_tag)?;
    let package_source_sha = flags.required("--package-source-sha")?;
    validate_git_sha(package_source_sha, "package source SHA")?;
    let bundle_dir = flags.required_path("--bundle-dir")?;
    require_nonsymlink_dir(bundle_dir, "durable generation bundle")?;

    validate_exact_generation_index(&index, &expected)?;
    let computed_snapshot = validate_release(
        &expected,
        &index,
        &assets,
        release_tag,
        release_base_url,
        ValidationMode::Current,
    )?;
    if !declared_snapshot.complete_current || computed_snapshot != declared_snapshot {
        return Err(
            "durable generation snapshot differs from its exact current index and assets".into(),
        );
    }
    validate_exact_generation_assets(&assets, &declared_snapshot, bundle_dir)?;
    validate_archive_snapshot(
        &expected,
        &declared_snapshot,
        bundle_dir,
        ArchiveValidationScope::All,
        Some((
            CANONICAL_PACKAGE_SOURCE_REPOSITORY,
            package_source_sha,
        )),
    )?;
    validate_generation_archive_source(
        &declared_snapshot,
        bundle_dir,
        package_source_sha,
    )
}

fn validate_generation_archive_source(
    snapshot: &ValidatedSnapshot,
    bundle_dir: &Path,
    package_source_sha: &str,
) -> Result<(), String> {
    for entry in &snapshot.entries {
        let archive = read_archive_manifest(&bundle_dir.join(&entry.asset))?;
        if archive.build.repo_url.as_deref()
            != Some(CANONICAL_PACKAGE_SOURCE_REPOSITORY)
            || archive.build.commit.as_deref() != Some(package_source_sha)
        {
            return Err(format!(
                "durable generation archive {:?} was not built by {} at exact main source {}",
                entry.asset, CANONICAL_PACKAGE_SOURCE_REPOSITORY, package_source_sha
            ));
        }
    }
    Ok(())
}

fn validate_exact_generation_index(
    index: &IndexToml,
    expected: &ExpectedLedger,
) -> Result<(), String> {
    validate_expected_ledger(expected)?;
    if index.generated_at.is_empty() || index.generator.is_empty() {
        return Err("durable generation index provenance fields must be non-empty".into());
    }
    if index.abi_version != expected.abi_version {
        return Err(format!(
            "durable generation index ABI {} differs from expected {}",
            index.abi_version, expected.abi_version
        ));
    }
    let expected_by_key = expected
        .entries
        .iter()
        .map(|entry| ((entry.package.as_str(), entry.arch), entry))
        .collect::<BTreeMap<_, _>>();
    let mut actual_keys = BTreeSet::new();
    let mut package_names = BTreeSet::new();
    for package in &index.packages {
        if !package_names.insert(package.name.as_str()) {
            return Err(format!(
                "durable generation index splits or duplicates package {:?}",
                package.name
            ));
        }
        if package.binary.is_empty() {
            return Err(format!(
                "durable generation index package {:?} has no binary entry",
                package.name
            ));
        }
        for (&arch, binary) in &package.binary {
            let key = (package.name.as_str(), arch);
            let wanted = expected_by_key.get(&key).ok_or_else(|| {
                format!(
                    "durable generation index contains unexpected package/arch {} {}",
                    package.name,
                    arch.as_str()
                )
            })?;
            if !actual_keys.insert(key) {
                return Err(format!(
                    "durable generation index duplicates package/arch {} {}",
                    package.name,
                    arch.as_str()
                ));
            }
            if package.version != wanted.version || package.revision != wanted.revision {
                return Err(format!(
                    "durable generation index identity for {} {} differs from the fresh source ledger",
                    package.name,
                    arch.as_str()
                ));
            }
            if binary.status != EntryStatus::Success
                || binary.archive_url.is_none()
                || binary.archive_sha256.is_none()
                || binary.cache_key_sha.as_deref() != Some(wanted.cache_key_sha.as_str())
                || binary.built_at.as_deref().is_none_or(str::is_empty)
                || binary.built_by.as_deref().is_none_or(str::is_empty)
                || binary.error.is_some()
                || binary.last_attempt.is_some()
                || binary.last_attempt_by.is_some()
                || binary.fallback_archive_url.is_some()
                || binary.fallback_archive_sha256.is_some()
                || binary.fallback_cache_key_sha.is_some()
                || binary.fallback_built_at.is_some()
            {
                return Err(format!(
                    "durable generation index {} {} is not one exact success entry",
                    package.name,
                    arch.as_str()
                ));
            }
        }
    }
    if actual_keys != expected_by_key.keys().copied().collect() {
        return Err("durable generation index omits a fresh source-ledger identity".into());
    }
    Ok(())
}

fn validate_exact_generation_assets(
    assets: &[ReleaseAsset],
    snapshot: &ValidatedSnapshot,
    bundle_dir: &Path,
) -> Result<(), String> {
    if assets.is_empty() {
        return Err("durable generation asset inventory is empty".into());
    }
    let mut expected_names = snapshot
        .entries
        .iter()
        .map(|entry| entry.asset.clone())
        .collect::<BTreeSet<_>>();
    expected_names.insert("index.toml".into());
    expected_names.insert("generation.json".into());
    if expected_names.len() != snapshot.entries.len() + 2 {
        return Err("durable generation maps multiple identities to one asset name".into());
    }

    let names = assets
        .iter()
        .map(|asset| asset.name.as_str())
        .collect::<Vec<_>>();
    let mut sorted_names = names.clone();
    sorted_names.sort_unstable();
    sorted_names.dedup();
    if names != sorted_names {
        return Err("durable generation asset inventory must be sorted and unique".into());
    }
    if names.iter().copied().collect::<BTreeSet<_>>()
        != expected_names.iter().map(String::as_str).collect()
    {
        return Err(
            "durable generation asset inventory has a missing or unexpected asset".into(),
        );
    }

    let actual_names = std::fs::read_dir(bundle_dir)
        .map_err(|e| format!("read durable generation bundle {}: {e}", bundle_dir.display()))?
        .map(|entry| {
            entry
                .map_err(|e| format!("read durable generation bundle entry: {e}"))
                .and_then(|entry| {
                    let name = entry.file_name().into_string().map_err(|_| {
                        "durable generation bundle contains a non-UTF-8 asset".to_string()
                    })?;
                    require_regular_file(&entry.path(), "durable generation asset")?;
                    Ok(name)
                })
        })
        .collect::<Result<BTreeSet<_>, _>>()?;
    if actual_names != expected_names {
        return Err("durable generation bundle has a missing or unexpected asset".into());
    }

    for asset in assets {
        if asset.state != "uploaded" || asset.size == 0 {
            return Err(format!(
                "durable generation asset {:?} is not a non-empty uploaded asset",
                asset.name
            ));
        }
        let digest = asset
            .digest
            .as_deref()
            .and_then(|value| value.strip_prefix("sha256:"))
            .ok_or_else(|| {
                format!(
                    "durable generation asset {:?} lacks a sha256 digest",
                    asset.name
                )
            })?;
        validate_sha256(digest, "durable generation asset digest")?;
        let path = bundle_dir.join(&asset.name);
        let metadata = std::fs::metadata(&path)
            .map_err(|e| format!("inspect durable generation asset {}: {e}", path.display()))?;
        if metadata.len() != asset.size || sha256_file(&path)? != digest {
            return Err(format!(
                "durable generation asset {:?} bytes differ from the canonical inventory",
                asset.name
            ));
        }
    }
    Ok(())
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
            version: package.version.clone(),
            revision: package.revision,
            cache_key_sha: cache_key_sha.to_owned(),
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
    expected_source: Option<(&str, &str)>,
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

    let mut snapshot_by_key = BTreeMap::new();
    for entry in &snapshot.entries {
        let key = (entry.package.as_str(), entry.arch);
        if snapshot_by_key.insert(key, entry).is_some() {
            return Err(format!(
                "archive snapshot contains duplicate package/arch {} {}",
                entry.package,
                entry.arch.as_str()
            ));
        }
    }
    if snapshot_by_key.len() != expected.entries.len() {
        return Err(format!(
            "archive snapshot contains {} entries, expected {}",
            snapshot_by_key.len(),
            expected.entries.len()
        ));
    }

    for wanted in &expected.entries {
        let entry = snapshot_by_key
            .get(&(wanted.package.as_str(), wanted.arch))
            .ok_or_else(|| {
                format!(
                    "archive snapshot lacks {} {}",
                    wanted.package,
                    wanted.arch.as_str()
                )
            })?;
        let should_validate = match scope {
            ArchiveValidationScope::All => true,
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
        if let Some((repository, commit)) = expected_source
            && (archived.build.repo_url.as_deref() != Some(repository)
                || archived.build.commit.as_deref() != Some(commit))
        {
            return Err(format!(
                "staging archive {} producer provenance differs from {}@{}",
                archive_path.display(),
                repository,
                commit
            ));
        }
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

fn localize_index(index: &IndexToml, snapshot: &ValidatedSnapshot) -> Result<IndexToml, String> {
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
        if let Some(target_package) = composed
            .packages
            .iter_mut()
            .find(|package| package.name == wanted.package)
        {
            if target_package.version != source_package.version
                || target_package.revision != source_package.revision
            {
                return Err(format!(
                    "base and overlay indexes disagree on {} package identity",
                    wanted.package
                ));
            }
            target_package
                .binary
                .insert(wanted.arch, source_entry.clone());
        } else {
            // WHY: architecture-specific durable generations can contain a
            // package that has no output for the other architecture. Adding
            // exactly the expected overlay entry lets consumers combine those
            // sealed generations without consulting a mutable base index.
            composed.packages.push(PackageEntry {
                name: source_package.name.clone(),
                version: source_package.version.clone(),
                revision: source_package.revision,
                binary: BTreeMap::from([(wanted.arch, source_entry.clone())]),
            });
        }
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

fn validate_git_sha(value: &str, field: &str) -> Result<(), String> {
    if value.len() != 40
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(format!(
            "{field} must be 40 lowercase hexadecimal characters, got {value:?}"
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
    const SOURCE_REPOSITORY: &str = "https://github.com/Automattic/kandelo";
    const SOURCE_COMMIT: &str = "1111111111111111111111111111111111111111";

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
[build]
repo_url = "{SOURCE_REPOSITORY}"
commit = "{SOURCE_COMMIT}"
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

    fn archived_manifest_at_main(git_inputs: &[GitBuildInput], commit: &str) -> String {
        archived_manifest(git_inputs).replace(
            &format!("commit = {SOURCE_COMMIT:?}"),
            &format!("commit = {commit:?}"),
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

    fn fresh_source_fixture() -> (
        BTreeMap<String, SourcePackage>,
        SourceProgramIndex,
    ) {
        let source_root =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let registry_path = source_root.join("packages/registry");
        let packages = load_source_packages(&registry_path).unwrap();
        let registry = Registry {
            roots: vec![registry_path],
        };
        let fresh =
            source_cache_identities(&source_root, &registry, 42).unwrap();
        let identities = packages
            .iter()
            .map(|(name, package)| {
                (
                    name.clone(),
                    SourcePackageIdentity {
                        manifest_sha256: package.manifest_sha256.clone(),
                        cache_keys: fresh[name].clone(),
                    },
                )
            })
            .collect::<BTreeMap<_, _>>();
        let mut programs = BTreeMap::new();
        for (name, package) in &packages {
            if package.manifest.kind != ManifestKind::Program
                || package.manifest.uses_root_binary_mirror()
            {
                continue;
            }
            let arches = package
                .manifest
                .target_arches
                .iter()
                .map(|arch| arch.as_str().to_owned())
                .collect::<Vec<_>>();
            let cache_keys = arches
                .iter()
                .map(|arch| (arch.clone(), identities[name].cache_keys[arch].clone()))
                .collect::<BTreeMap<_, _>>();
            let dependency_closures = arches
                .iter()
                .map(|arch| {
                    let parsed = parse_arch(arch).unwrap();
                    (
                        arch.clone(),
                        source_dependency_closure(
                            name,
                            parsed,
                            &packages,
                            &identities,
                        )
                        .unwrap(),
                    )
                })
                .collect::<BTreeMap<_, _>>();
            programs.insert(
                name.clone(),
                SourceProgramProjection {
                    manifest_sha256: package.manifest_sha256.clone(),
                    arches,
                    cache_keys,
                    dependency_closures,
                    members: source_projection_members(&package.manifest).unwrap(),
                },
            );
        }
        (
            packages,
            SourceProgramIndex {
                format: "kandelo-program-packages-v2".into(),
                identities,
                packages: programs,
            },
        )
    }

    #[test]
    fn current_reader_rejects_source_identity_omission_substitution_and_stale_cache() {
        let (packages, index) = fresh_source_fixture();
        let fresh = index
            .identities
            .iter()
            .map(|(name, identity)| (name.clone(), identity.cache_keys.clone()))
            .collect::<BTreeMap<_, _>>();
        validate_source_program_index(&index, &packages, &fresh).unwrap();

        let mut omitted = index.clone();
        let omitted_name = omitted.identities.keys().next().unwrap().clone();
        omitted.identities.remove(&omitted_name);
        assert!(
            validate_source_program_index(&omitted, &packages, &fresh)
                .unwrap_err()
                .contains("exactly cover")
        );

        let mut stale = index.clone();
        let stale_name = stale.identities.keys().next().unwrap().clone();
        stale
            .identities
            .get_mut(&stale_name)
            .unwrap()
            .cache_keys
            .insert("wasm32".into(), "f".repeat(64));
        assert!(
            validate_source_program_index(&stale, &packages, &fresh)
                .unwrap_err()
                .contains("stale contextual cache key")
        );

        let mut substituted = index.clone();
        let projection = substituted
            .packages
            .values_mut()
            .find(|projection| {
                projection
                    .dependency_closures
                    .values()
                    .any(|closure| !closure.is_empty())
            })
            .expect("repository fixture has a program dependency");
        let closure = projection
            .dependency_closures
            .values_mut()
            .find(|closure| !closure.is_empty())
            .unwrap();
        closure[0].cache_key = "e".repeat(64);
        assert!(
            validate_source_program_index(&substituted, &packages, &fresh)
                .unwrap_err()
                .contains("stale or substituted")
        );
    }

    #[test]
    fn source_selection_keeps_source_only_identity_but_omits_archive_expectation() {
        let (packages, index) = fresh_source_fixture();
        let roots = vec!["mariadb".to_string()];
        let (projection, expected) = build_source_selection(
            &packages,
            &index,
            &roots,
            TargetArch::Wasm32,
            42,
            2,
        )
        .unwrap();
        assert!(projection["closure"].as_array().unwrap().iter().any(|entry| {
            entry["package"] == "pcre2-source"
                && entry["kind"] == "source"
                && entry["disposition"] == "source-only"
        }));
        assert!(
            expected
                .entries
                .iter()
                .all(|entry| entry.package != "pcre2-source")
        );
        assert!(
            build_source_selection(
                &packages,
                &index,
                &roots,
                TargetArch::Wasm32,
                42,
                1,
            )
            .unwrap_err()
            .contains("source-only")
        );
    }

    #[test]
    fn source_scanner_selects_exact_rootfs_archive_closure() {
        let (packages, index) = fresh_source_fixture();
        let roots = vec!["rootfs".to_string()];
        let (projection, expected) = build_source_selection(
            &packages,
            &index,
            &roots,
            TargetArch::Wasm32,
            42,
            1,
        )
        .unwrap();
        assert_eq!(projection["schema"], 1);
        assert_eq!(projection["root_package"], "rootfs");
        assert_eq!(projection["arch"], "wasm32");
        assert_eq!(projection["entries"].as_array().unwrap().len(), 15);
        assert_eq!(expected.entries.len(), 15);
        assert_eq!(
            projection["entries"]
                .as_array()
                .unwrap()
                .iter()
                .map(|entry| entry["package"].as_str().unwrap())
                .collect::<Vec<_>>(),
            expected
                .entries
                .iter()
                .map(|entry| entry.package.as_str())
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn expected_ledger_requires_explicit_git_provenance() {
        let missing = format!(
            r#"{{"abi_version":{ABI},"entries":[{{"package":"zlib","kind":"library","arch":"wasm32","version":"1.3.1","revision":2,"cache_key_sha":"{SHA}"}}]}}"#,
        );
        let error = serde_json::from_str::<ExpectedLedger>(&missing).unwrap_err();
        assert!(error.to_string().contains("git_inputs"), "{error}");
    }

    #[test]
    fn generation_validator_json_inputs_reject_unknown_fields() {
        let ledger = format!(
            r#"{{"abi_version":{ABI},"entries":[{{"package":"zlib","kind":"library","arch":"wasm32","version":"1.3.1","revision":2,"cache_key_sha":"{SHA}","git_inputs":[]}}],"ignored":true}}"#,
        );
        assert!(
            serde_json::from_str::<ExpectedLedger>(&ledger)
                .unwrap_err()
                .to_string()
                .contains("unknown field")
        );
        let asset = format!(
            r#"{{"name":"zlib.tar.zst","state":"uploaded","size":1,"digest":"sha256:{SHA}","ignored":true}}"#
        );
        assert!(
            serde_json::from_str::<ReleaseAsset>(&asset)
                .unwrap_err()
                .to_string()
                .contains("unknown field")
        );
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
    fn exact_generation_index_rejects_extra_missing_duplicate_and_fallback_entries() {
        validate_exact_generation_index(&index(), &expected()).unwrap();

        let mut extra = index();
        let mut extra_package = extra.packages[0].clone();
        extra_package.name = "unexpected".into();
        extra.packages.push(extra_package);
        assert!(validate_exact_generation_index(&extra, &expected()).is_err());

        let mut missing = index();
        missing.packages.clear();
        assert!(
            validate_exact_generation_index(&missing, &expected())
                .unwrap_err()
                .contains("omits")
        );

        let mut duplicate = index();
        duplicate.packages.push(duplicate.packages[0].clone());
        assert!(
            validate_exact_generation_index(&duplicate, &expected())
                .unwrap_err()
                .contains("duplicates")
        );

        let mut fallback = index();
        fallback.packages[0]
            .binary
            .get_mut(&TargetArch::Wasm32)
            .unwrap()
            .fallback_archive_url = Some("old.tar.zst".into());
        assert!(
            validate_exact_generation_index(&fallback, &expected())
                .unwrap_err()
                .contains("exact success")
        );
    }

    #[test]
    fn exact_generation_assets_reject_missing_extra_duplicate_and_swapped_bytes() {
        let dir = archive_tempdir("generation-assets");
        let archive_name = "zlib.tar.zst";
        fs::write(dir.join(archive_name), b"archive").unwrap();
        fs::write(dir.join("generation.json"), b"generation").unwrap();
        fs::write(dir.join("index.toml"), b"index").unwrap();
        let snapshot = ValidatedSnapshot {
            abi_version: ABI,
            release_tag: "package-generation-zlib-wasm32-abi-v39-sha256-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into(),
            complete_current: true,
            entries: vec![ValidatedEntry {
                package: "zlib".into(),
                kind: ExpectedKind::Library,
                arch: TargetArch::Wasm32,
                version: "1.3.1".into(),
                revision: 2,
                cache_key_sha: SHA.into(),
                current: true,
                asset: archive_name.into(),
                archive_sha256: sha256_file(&dir.join(archive_name)).unwrap(),
                size: fs::metadata(dir.join(archive_name)).unwrap().len(),
            }],
        };
        let asset = |name: &str| {
            let path = dir.join(name);
            ReleaseAsset {
                name: name.into(),
                state: "uploaded".into(),
                size: fs::metadata(&path).unwrap().len(),
                digest: Some(format!("sha256:{}", sha256_file(&path).unwrap())),
            }
        };
        let valid = vec![
            asset("generation.json"),
            asset("index.toml"),
            asset(archive_name),
        ];
        validate_exact_generation_assets(&valid, &snapshot, &dir).unwrap();

        let mut missing = valid.clone();
        missing.pop();
        assert!(validate_exact_generation_assets(&missing, &snapshot, &dir).is_err());

        let mut duplicate = valid.clone();
        duplicate.insert(1, duplicate[0].clone());
        assert!(
            validate_exact_generation_assets(&duplicate, &snapshot, &dir)
                .unwrap_err()
                .contains("sorted and unique")
        );

        fs::write(dir.join("extra.tar.zst"), b"extra").unwrap();
        let mut extra = valid.clone();
        extra.push(asset("extra.tar.zst"));
        extra.sort_by(|left, right| left.name.cmp(&right.name));
        assert!(validate_exact_generation_assets(&extra, &snapshot, &dir).is_err());
        fs::remove_file(dir.join("extra.tar.zst")).unwrap();

        let mut swapped = valid.clone();
        let first_digest = swapped[0].digest.clone();
        swapped[0].digest = swapped[1].digest.clone();
        swapped[1].digest = first_digest;
        assert!(
            validate_exact_generation_assets(&swapped, &snapshot, &dir)
                .unwrap_err()
                .contains("bytes differ")
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
    fn compose_adds_an_architecture_only_overlay_package() {
        let base = IndexToml::empty(ABI, "base".into(), "base".into());
        let composed = compose_indexes(&base, &index(), &expected()).unwrap();

        assert_eq!(composed.packages.len(), 1);
        assert_eq!(composed.packages[0].name, "zlib");
        assert_eq!(
            composed.packages[0].binary[&TargetArch::Wasm32]
                .cache_key_sha
                .as_deref(),
            Some(SHA)
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

        for incompatible_base in [
            {
                let mut value = index();
                value.packages[0].version = "older".into();
                value
            },
            {
                let mut value = index();
                value.packages[0].revision -= 1;
                value
            },
        ] {
            assert!(
                compose_indexes(&incompatible_base, &index(), &expected()).is_err(),
                "combining architecture generations must not relabel an existing package"
            );
        }
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
            None,
        )
        .unwrap();
    }

    #[test]
    fn generation_archive_requires_exact_main_commit_not_another_commit() {
        let dir = archive_tempdir("exact-main");
        let path = dir.join("zlib.tar.zst");
        let main_sha = "1".repeat(40);
        write_test_archive(
            &path,
            "manifest.toml",
            archived_manifest_at_main(&[], &main_sha).as_bytes(),
            false,
        );
        let snapshot = snapshot_for_archive(&path, true);
        validate_generation_archive_source(&snapshot, &dir, &main_sha).unwrap();
        let error = validate_generation_archive_source(
            &snapshot,
            &dir,
            &"2".repeat(40),
        )
        .unwrap_err();
        assert!(error.contains("exact main source"), "{error}");

        let wrong_repo_path = dir.join("wrong-repository.tar.zst");
        let wrong_repo_manifest = archived_manifest_at_main(&[], &main_sha).replace(
            CANONICAL_PACKAGE_SOURCE_REPOSITORY,
            "https://github.com/example/fork",
        );
        write_test_archive(
            &wrong_repo_path,
            "manifest.toml",
            wrong_repo_manifest.as_bytes(),
            false,
        );
        let error = validate_generation_archive_source(
            &snapshot_for_archive(&wrong_repo_path, true),
            &dir,
            &main_sha,
        )
        .unwrap_err();
        assert!(
            error.contains(CANONICAL_PACKAGE_SOURCE_REPOSITORY),
            "{error}"
        );
    }

    #[test]
    fn archive_snapshot_requires_exact_package_source_when_requested() {
        let dir = archive_tempdir("exact-package-source");
        let path = dir.join("zlib.tar.zst");
        write_test_archive(
            &path,
            "manifest.toml",
            archived_manifest(&[]).as_bytes(),
            false,
        );
        let snapshot = snapshot_for_archive(&path, true);

        validate_archive_snapshot(
            &expected(),
            &snapshot,
            &dir,
            ArchiveValidationScope::All,
            Some((SOURCE_REPOSITORY, SOURCE_COMMIT)),
        )
        .unwrap();

        for expected_source in [
            (
                "https://github.com/Automattic/not-kandelo",
                SOURCE_COMMIT,
            ),
            (
                SOURCE_REPOSITORY,
                "2222222222222222222222222222222222222222",
            ),
        ] {
            let error = validate_archive_snapshot(
                &expected(),
                &snapshot,
                &dir,
                ArchiveValidationScope::All,
                Some(expected_source),
            )
            .unwrap_err();
            assert!(error.contains("producer provenance"), "{error}");
        }
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
                None,
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
        let error = validate_archive_snapshot(
            &expected(),
            &wrong_size,
            &dir,
            ArchiveValidationScope::All,
            None,
        )
        .unwrap_err();
        assert!(error.contains("validated snapshot requires"), "{error}");

        let mut wrong_digest = snapshot_for_archive(&path, true);
        wrong_digest.entries[0].archive_sha256 = "c".repeat(64);
        let error = validate_archive_snapshot(
            &expected(),
            &wrong_digest,
            &dir,
            ArchiveValidationScope::All,
            None,
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
                asset: "../zlib.tar.zst".into(),
                archive_sha256: ARCHIVE_SHA.into(),
                size: 123,
            }],
        };
        let error = validate_archive_snapshot(
            &expected(),
            &snapshot,
            &dir,
            ArchiveValidationScope::All,
            None,
        )
        .unwrap_err();
        assert!(error.contains("unsafe archive snapshot asset"), "{error}");

        snapshot.entries[0].asset = "nested/zlib.tar.zst".into();
        assert!(
            validate_archive_snapshot(
                &expected(),
                &snapshot,
                &dir,
                ArchiveValidationScope::All,
                None,
            )
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
        let error = validate_archive_snapshot(
            &expected(),
            &snapshot,
            &dir,
            ArchiveValidationScope::All,
            None,
        )
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
            None,
        )
        .unwrap();
        assert!(
            validate_archive_snapshot(
                &expected(),
                &snapshot,
                &dir,
                ArchiveValidationScope::All,
                None,
            )
                .is_err()
        );

        let mut stale_snapshot = snapshot;
        stale_snapshot.entries[0].current = false;
        validate_archive_snapshot(
            &expected_with_git_inputs(vec![git_input("tap", '1')]),
            &stale_snapshot,
            &dir,
            ArchiveValidationScope::CurrentDeclaredGitInputs,
            None,
        )
        .unwrap();
    }
}
