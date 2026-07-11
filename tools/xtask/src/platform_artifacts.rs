//! Runtime platform artifact owner.
//!
//! `kernel`, `userspace`, and `kandelo-sdk` are first-party runtime artifacts,
//! not Homebrew package identities. This module validates their explicit owner
//! manifest and materializes the stable runtime paths consumed by Node.js and
//! browser hosts.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::{Cursor, Read};
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Deserialize;
use sha2::{Digest, Sha256};
use wasm_posix_shared::ABI_VERSION;

use crate::util::hex;

const DEFAULT_MANIFEST: &str = "platform/artifacts/manifest.json";
const MAX_ARCHIVE_BYTES: u64 = 256 * 1024 * 1024;
const REQUIRED_ARTIFACTS: [RequiredArtifact; 3] = [
    RequiredArtifact {
        id: "kernel",
        kind: "kernel_wasm",
        binaries_path: "kernel.wasm",
    },
    RequiredArtifact {
        id: "userspace",
        kind: "userspace_wasm",
        binaries_path: "userspace.wasm",
    },
    RequiredArtifact {
        id: "kandelo-sdk",
        kind: "sdk_vfs",
        binaries_path: "programs/wasm32/kandelo-sdk.vfs.zst",
    },
];

#[derive(Clone, Copy)]
struct RequiredArtifact {
    id: &'static str,
    kind: &'static str,
    binaries_path: &'static str,
}

#[derive(Debug, Deserialize)]
struct Manifest {
    schema: u32,
    owner: String,
    kandelo_repository: String,
    kandelo_abi: u32,
    release_tag: String,
    generator: String,
    artifacts: Vec<Artifact>,
}

#[derive(Debug, Deserialize)]
struct Artifact {
    id: String,
    kind: String,
    version: String,
    target_arch: String,
    kandelo_abi: u32,
    status: ArtifactStatus,
    source: ArtifactSource,
    build: ArtifactBuild,
    inputs: Vec<String>,
    outputs: Vec<ArtifactOutput>,
    archive: Option<ArchiveRef>,
    fallback: Fallback,
    provenance: Provenance,
    validation: Validation,
}

#[derive(Debug, Deserialize)]
struct ArtifactStatus {
    state: String,
    reason: Option<String>,
    #[allow(dead_code)]
    last_attempt_at: Option<String>,
    #[allow(dead_code)]
    last_attempt_by: Option<String>,
    next_action: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ArtifactSource {
    repository: String,
    commit: String,
}

#[derive(Debug, Deserialize)]
struct ArtifactBuild {
    script_path: String,
}

#[derive(Debug, Deserialize)]
struct ArtifactOutput {
    source_paths: Vec<String>,
    archive_paths: Vec<String>,
    binaries_path: String,
    repo_paths: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct ArchiveRef {
    url: String,
    sha256: String,
    bytes: u64,
    cache_key_sha: String,
}

#[derive(Debug, Deserialize)]
struct Fallback {
    mode: String,
    available: bool,
    reason: String,
    #[allow(dead_code)]
    archive: Option<ArchiveRef>,
}

#[derive(Debug, Deserialize)]
struct Provenance {
    cache_key_inputs: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct Validation {
    required: Vec<String>,
    smoke_evidence: Vec<SmokeEvidence>,
}

#[derive(Debug, Deserialize)]
struct SmokeEvidence {
    id: String,
    surface: String,
    command: String,
    status: String,
}

pub fn run(args: Vec<String>) -> Result<(), String> {
    let opts = Opts::parse(args)?;
    let repo_root = crate::repo_root();
    let manifest_path = opts
        .manifest
        .unwrap_or_else(|| repo_root.join(DEFAULT_MANIFEST));
    let manifest = load_manifest(&manifest_path)?;

    match opts.subcommand {
        Subcommand::Validate { registry_removal } => {
            validate_manifest(&manifest, &repo_root, registry_removal)?;
            println!(
                "platform-artifacts: manifest valid for ABI {} ({})",
                ABI_VERSION,
                manifest_path.display()
            );
            Ok(())
        }
        Subcommand::Materialize {
            binaries_dir,
            fetch_only,
        } => {
            validate_manifest(&manifest, &repo_root, false)?;
            let binaries_dir = binaries_dir.unwrap_or_else(|| repo_root.join("binaries"));
            materialize_manifest(&manifest, &repo_root, &binaries_dir, fetch_only)?;
            println!(
                "platform-artifacts: materialized {} artifact(s) into {}",
                manifest.artifacts.len(),
                binaries_dir.display()
            );
            Ok(())
        }
        Subcommand::Status => {
            validate_manifest(&manifest, &repo_root, false)?;
            for artifact in &manifest.artifacts {
                println!("{} {}", artifact.id, artifact.status.state);
            }
            Ok(())
        }
    }
}

fn load_manifest(path: &Path) -> Result<Manifest, String> {
    let bytes = fs::read(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    serde_json::from_slice(&bytes).map_err(|e| format!("parse {}: {e}", path.display()))
}

fn validate_manifest(
    manifest: &Manifest,
    repo_root: &Path,
    registry_removal: bool,
) -> Result<(), String> {
    let mut errors = Vec::new();

    if manifest.schema != 1 {
        errors.push(format!("schema must be 1, got {}", manifest.schema));
    }
    require_nonempty(&manifest.owner, "owner", &mut errors);
    require_nonempty(
        &manifest.kandelo_repository,
        "kandelo_repository",
        &mut errors,
    );
    require_nonempty(&manifest.generator, "generator", &mut errors);
    if manifest.kandelo_abi != ABI_VERSION {
        errors.push(format!(
            "top-level kandelo_abi {} does not match ABI_VERSION {}",
            manifest.kandelo_abi, ABI_VERSION
        ));
    }
    let expected_tag = format!("binaries-abi-v{ABI_VERSION}");
    if manifest.release_tag != expected_tag {
        errors.push(format!(
            "release_tag {:?} must be {:?}",
            manifest.release_tag, expected_tag
        ));
    }

    let mut by_id: BTreeMap<&str, &Artifact> = BTreeMap::new();
    for artifact in &manifest.artifacts {
        if by_id.insert(artifact.id.as_str(), artifact).is_some() {
            errors.push(format!("duplicate artifact id {:?}", artifact.id));
        }
        validate_artifact(artifact, repo_root, registry_removal, &mut errors);
    }

    for required in REQUIRED_ARTIFACTS {
        match by_id.get(required.id).copied() {
            Some(artifact) => {
                validate_required_artifact_contract(artifact, required, &mut errors);
            }
            None => errors.push(format!(
                "missing required platform artifact owner {:?}",
                required.id
            )),
        }
    }

    if errors.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "platform artifact manifest validation failed:\n  - {}",
            errors.join("\n  - ")
        ))
    }
}

fn validate_artifact(
    artifact: &Artifact,
    repo_root: &Path,
    registry_removal: bool,
    errors: &mut Vec<String>,
) {
    let prefix = format!("artifact {}:", artifact.id);
    require_nonempty(&artifact.id, &format!("{prefix} id"), errors);
    require_nonempty(&artifact.kind, &format!("{prefix} kind"), errors);
    require_nonempty(&artifact.version, &format!("{prefix} version"), errors);
    require_nonempty(
        &artifact.source.repository,
        &format!("{prefix} source.repository"),
        errors,
    );
    require_nonempty(
        &artifact.source.commit,
        &format!("{prefix} source.commit"),
        errors,
    );

    if !matches!(artifact.target_arch.as_str(), "wasm32" | "wasm64") {
        errors.push(format!(
            "{prefix} target_arch {:?} is not wasm32 or wasm64",
            artifact.target_arch
        ));
    }
    if artifact.kandelo_abi != ABI_VERSION {
        errors.push(format!(
            "{prefix} kandelo_abi {} does not match ABI_VERSION {}",
            artifact.kandelo_abi, ABI_VERSION
        ));
    }

    validate_status(artifact, &prefix, errors);
    validate_build_script(artifact, repo_root, registry_removal, &prefix, errors);

    if artifact.inputs.is_empty() {
        errors.push(format!("{prefix} inputs must not be empty"));
    }
    for input in &artifact.inputs {
        validate_repo_path(input, &format!("{prefix} input"), errors);
        if is_safe_repo_path(input) && !repo_root.join(input).exists() {
            errors.push(format!("{prefix} input does not exist: {input}"));
        }
    }

    if artifact.outputs.is_empty() {
        errors.push(format!("{prefix} outputs must not be empty"));
    }
    for output in &artifact.outputs {
        validate_output(output, &prefix, errors);
    }

    if let Some(archive) = &artifact.archive {
        validate_archive(archive, &format!("{prefix} archive"), errors);
    } else if artifact.status.state == "success" {
        errors.push(format!(
            "{prefix} status success requires archive url/sha/cache_key_sha"
        ));
    }

    require_nonempty(
        &artifact.fallback.mode,
        &format!("{prefix} fallback.mode"),
        errors,
    );
    require_nonempty(
        &artifact.fallback.reason,
        &format!("{prefix} fallback.reason"),
        errors,
    );
    if !artifact.fallback.available && artifact.status.state != "excluded" {
        errors.push(format!(
            "{prefix} fallback.available=false is only valid for excluded artifacts"
        ));
    }

    if artifact.provenance.cache_key_inputs.is_empty() {
        errors.push(format!(
            "{prefix} provenance.cache_key_inputs must not be empty"
        ));
    }

    if artifact.validation.required.is_empty() {
        errors.push(format!("{prefix} validation.required must not be empty"));
    }
    for required in &artifact.validation.required {
        require_nonempty(
            required,
            &format!("{prefix} validation.required entry"),
            errors,
        );
    }
    for smoke in &artifact.validation.smoke_evidence {
        validate_smoke(smoke, &prefix, errors);
    }
}

fn validate_status(artifact: &Artifact, prefix: &str, errors: &mut Vec<String>) {
    match artifact.status.state.as_str() {
        "success" | "failed" | "pending" | "building" | "blocked" | "excluded" => {}
        other => errors.push(format!("{prefix} unsupported status {other:?}")),
    }

    if artifact.status.state != "success" {
        if artifact
            .status
            .reason
            .as_deref()
            .map(str::trim)
            .unwrap_or_default()
            .is_empty()
        {
            errors.push(format!(
                "{prefix} non-success status requires status.reason"
            ));
        }
        if artifact
            .status
            .next_action
            .as_deref()
            .map(str::trim)
            .unwrap_or_default()
            .is_empty()
        {
            errors.push(format!(
                "{prefix} non-success status requires status.next_action"
            ));
        }
    }
}

fn validate_build_script(
    artifact: &Artifact,
    repo_root: &Path,
    registry_removal: bool,
    prefix: &str,
    errors: &mut Vec<String>,
) {
    validate_repo_path(
        &artifact.build.script_path,
        &format!("{prefix} build.script_path"),
        errors,
    );
    if registry_removal && artifact.build.script_path.starts_with("packages/registry/") {
        errors.push(format!(
            "{prefix} --registry-removal requires build.script_path outside packages/registry"
        ));
    }
    if is_safe_repo_path(&artifact.build.script_path) {
        let script = repo_root.join(&artifact.build.script_path);
        if !script.is_file() {
            errors.push(format!(
                "{prefix} build.script_path does not exist: {}",
                artifact.build.script_path
            ));
        }
    }
}

fn validate_output(output: &ArtifactOutput, prefix: &str, errors: &mut Vec<String>) {
    if output.source_paths.is_empty() {
        errors.push(format!("{prefix} output.source_paths must not be empty"));
    }
    for source in &output.source_paths {
        validate_repo_path(source, &format!("{prefix} output.source_paths"), errors);
    }
    if output.archive_paths.is_empty() {
        errors.push(format!("{prefix} output.archive_paths must not be empty"));
    }
    for source in &output.archive_paths {
        validate_repo_path(source, &format!("{prefix} output.archive_paths"), errors);
    }
    validate_repo_path(
        &output.binaries_path,
        &format!("{prefix} output.binaries_path"),
        errors,
    );
    for repo_path in &output.repo_paths {
        validate_repo_path(repo_path, &format!("{prefix} output.repo_paths"), errors);
    }
}

fn validate_archive(archive: &ArchiveRef, prefix: &str, errors: &mut Vec<String>) {
    require_nonempty(&archive.url, &format!("{prefix}.url"), errors);
    if !is_lower_hex_64(&archive.sha256) {
        errors.push(format!("{prefix}.sha256 must be 64 lowercase hex chars"));
    }
    if !is_lower_hex_64(&archive.cache_key_sha) {
        errors.push(format!(
            "{prefix}.cache_key_sha must be 64 lowercase hex chars"
        ));
    }
    if archive.bytes == 0 {
        errors.push(format!("{prefix}.bytes must be nonzero"));
    }
}

fn validate_smoke(smoke: &SmokeEvidence, prefix: &str, errors: &mut Vec<String>) {
    require_nonempty(&smoke.id, &format!("{prefix} smoke.id"), errors);
    require_nonempty(&smoke.command, &format!("{prefix} smoke.command"), errors);
    require_nonempty(&smoke.status, &format!("{prefix} smoke.status"), errors);
    if !matches!(smoke.surface.as_str(), "node" | "browser") {
        errors.push(format!(
            "{prefix} smoke.surface {:?} is not node or browser",
            smoke.surface
        ));
    }
}

fn validate_required_artifact_contract(
    artifact: &Artifact,
    required: RequiredArtifact,
    errors: &mut Vec<String>,
) {
    let prefix = format!("artifact {}:", artifact.id);
    if artifact.kind != required.kind {
        errors.push(format!(
            "{prefix} kind {:?} must be {:?}",
            artifact.kind, required.kind
        ));
    }
    if !artifact
        .outputs
        .iter()
        .any(|out| out.binaries_path == required.binaries_path)
    {
        errors.push(format!(
            "{prefix} must materialize binaries path {:?}",
            required.binaries_path
        ));
    }

    let surfaces: BTreeSet<&str> = artifact
        .validation
        .smoke_evidence
        .iter()
        .map(|smoke| smoke.surface.as_str())
        .collect();
    if !surfaces.contains("node") {
        errors.push(format!("{prefix} must record Node.js smoke evidence"));
    }
    if !surfaces.contains("browser") {
        errors.push(format!("{prefix} must record browser smoke evidence"));
    }
}

fn materialize_manifest(
    manifest: &Manifest,
    repo_root: &Path,
    binaries_dir: &Path,
    fetch_only: bool,
) -> Result<(), String> {
    for artifact in &manifest.artifacts {
        materialize_artifact(artifact, repo_root, binaries_dir, fetch_only)?;
    }
    Ok(())
}

fn materialize_artifact(
    artifact: &Artifact,
    repo_root: &Path,
    binaries_dir: &Path,
    fetch_only: bool,
) -> Result<(), String> {
    let mut archive_extract_dir = None;
    let mut missing = count_missing_outputs(artifact, repo_root, binaries_dir, None);

    if missing > 0 && !offline_requested() {
        if let Some(archive) = &artifact.archive {
            let extracted = fetch_and_extract_archive(&artifact.id, archive)?;
            missing = count_missing_outputs(artifact, repo_root, binaries_dir, Some(&extracted));
            archive_extract_dir = Some(extracted);
        }
    }

    if missing > 0 {
        if fetch_only {
            return Err(format!(
                "{} has {missing} missing output(s); --fetch-only forbids source build fallback",
                artifact.id
            ));
        }
        run_build_script(artifact, repo_root)?;
    }

    for output in &artifact.outputs {
        let source = find_existing_source(
            output,
            repo_root,
            binaries_dir,
            archive_extract_dir.as_deref(),
        )
        .ok_or_else(|| {
            format!(
                "{} did not produce any source path for {}",
                artifact.id, output.binaries_path
            )
        })?;
        let binaries_dest = binaries_dir.join(&output.binaries_path);
        copy_file(&source, &binaries_dest)?;
        for repo_path in &output.repo_paths {
            copy_file(&source, &repo_root.join(repo_path))?;
        }
        println!(
            "platform-artifacts: {} -> {}",
            artifact.id,
            binaries_dest.display()
        );
    }

    if let Some(dir) = archive_extract_dir {
        let _ = fs::remove_dir_all(dir);
    }

    Ok(())
}

fn count_missing_outputs(
    artifact: &Artifact,
    repo_root: &Path,
    binaries_dir: &Path,
    archive_extract_dir: Option<&Path>,
) -> usize {
    artifact
        .outputs
        .iter()
        .filter(|out| {
            find_existing_source(out, repo_root, binaries_dir, archive_extract_dir).is_none()
        })
        .count()
}

fn find_existing_source(
    output: &ArtifactOutput,
    repo_root: &Path,
    binaries_dir: &Path,
    archive_extract_dir: Option<&Path>,
) -> Option<PathBuf> {
    output
        .source_paths
        .iter()
        .map(|path| repo_root.join(path))
        .chain(
            archive_extract_dir
                .into_iter()
                .flat_map(|dir| output.archive_paths.iter().map(move |path| dir.join(path))),
        )
        .chain(std::iter::once(binaries_dir.join(&output.binaries_path)))
        .chain(output.repo_paths.iter().map(|path| repo_root.join(path)))
        .find(|path| path.is_file())
}

fn fetch_and_extract_archive(id: &str, archive: &ArchiveRef) -> Result<PathBuf, String> {
    let bytes = fetch_archive_bytes(&archive.url)?;
    if bytes.len() as u64 != archive.bytes {
        return Err(format!(
            "{id} archive byte length mismatch: expected {}, got {}",
            archive.bytes,
            bytes.len()
        ));
    }
    let actual = hex(&Sha256::digest(&bytes));
    if actual != archive.sha256 {
        return Err(format!(
            "{id} archive sha mismatch: expected {}, got {actual}",
            archive.sha256
        ));
    }
    let tmp = std::env::temp_dir().join(format!(
        "kandelo-platform-artifacts-{}-{}-{}",
        id,
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|e| format!("system clock before UNIX_EPOCH: {e}"))?
            .as_nanos()
    ));
    if tmp.exists() {
        fs::remove_dir_all(&tmp).map_err(|e| format!("remove {}: {e}", tmp.display()))?;
    }
    fs::create_dir_all(&tmp).map_err(|e| format!("mkdir {}: {e}", tmp.display()))?;

    let decoder = zstd::stream::read::Decoder::new(Cursor::new(bytes))
        .map_err(|e| format!("{id} zstd decode: {e}"))?;
    let mut archive = tar::Archive::new(decoder);
    archive
        .unpack(&tmp)
        .map_err(|e| format!("{id} tar unpack into {}: {e}", tmp.display()))?;
    Ok(tmp)
}

fn fetch_archive_bytes(url: &str) -> Result<Vec<u8>, String> {
    if let Some(path) = url.strip_prefix("file://") {
        return fs::read(path).map_err(|e| format!("read {url}: {e}"));
    }
    let response = ureq::get(url)
        .call()
        .map_err(|e| format!("GET {url}: {e}"))?;
    let mut bytes = Vec::new();
    response
        .into_reader()
        .take(MAX_ARCHIVE_BYTES)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("read {url}: {e}"))?;
    Ok(bytes)
}

fn offline_requested() -> bool {
    std::env::var("WASM_POSIX_OFFLINE")
        .ok()
        .map(|value| {
            let trimmed = value.trim();
            !trimmed.is_empty() && trimmed != "0"
        })
        .unwrap_or(false)
}

fn run_build_script(artifact: &Artifact, repo_root: &Path) -> Result<(), String> {
    let script = repo_root.join(&artifact.build.script_path);
    let status = Command::new("bash")
        .arg(&script)
        .current_dir(repo_root)
        .status()
        .map_err(|e| format!("run {}: {e}", script.display()))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!(
            "{} build script failed with status {}",
            artifact.id, status
        ))
    }
}

fn copy_file(source: &Path, dest: &Path) -> Result<(), String> {
    if paths_are_same_file(source, dest) {
        return Ok(());
    }
    let parent = dest
        .parent()
        .ok_or_else(|| format!("destination has no parent: {}", dest.display()))?;
    fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    if fs::symlink_metadata(dest).is_ok() {
        fs::remove_file(dest).map_err(|e| format!("remove {}: {e}", dest.display()))?;
    }
    fs::copy(source, dest)
        .map_err(|e| format!("copy {} -> {}: {e}", source.display(), dest.display()))?;
    Ok(())
}

fn paths_are_same_file(a: &Path, b: &Path) -> bool {
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

fn require_nonempty(value: &str, field: &str, errors: &mut Vec<String>) {
    if value.trim().is_empty() {
        errors.push(format!("{field} must not be empty"));
    }
}

fn validate_repo_path(path: &str, field: &str, errors: &mut Vec<String>) {
    if !is_safe_repo_path(path) {
        errors.push(format!(
            "{field} path must be a safe repository-relative path, got {path:?}"
        ));
    }
}

fn is_safe_repo_path(path: &str) -> bool {
    let p = Path::new(path);
    if path.trim().is_empty() || p.is_absolute() {
        return false;
    }
    p.components().all(|component| {
        !matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    })
}

fn is_lower_hex_64(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

#[derive(Debug)]
struct Opts {
    subcommand: Subcommand,
    manifest: Option<PathBuf>,
}

#[derive(Debug)]
enum Subcommand {
    Validate {
        registry_removal: bool,
    },
    Materialize {
        binaries_dir: Option<PathBuf>,
        fetch_only: bool,
    },
    Status,
}

impl Opts {
    fn parse(args: Vec<String>) -> Result<Self, String> {
        let mut it = args.into_iter();
        let sub = it.next().ok_or_else(usage)?;
        let mut manifest = None;
        let subcommand = match sub.as_str() {
            "validate" => {
                let mut registry_removal = false;
                while let Some(arg) = it.next() {
                    if arg == "--registry-removal" {
                        registry_removal = true;
                    } else if let Some(value) = arg.strip_prefix("--manifest=") {
                        set_once_path(&mut manifest, value, "--manifest")?;
                    } else if arg == "--manifest" {
                        let value = it
                            .next()
                            .ok_or_else(|| "--manifest requires a path".to_string())?;
                        set_once_path(&mut manifest, &value, "--manifest")?;
                    } else {
                        return Err(format!("unknown validate arg {arg:?}\n{}", usage()));
                    }
                }
                Subcommand::Validate { registry_removal }
            }
            "materialize" => {
                let mut binaries_dir = None;
                let mut fetch_only = false;
                while let Some(arg) = it.next() {
                    if arg == "--fetch-only" {
                        fetch_only = true;
                    } else if let Some(value) = arg.strip_prefix("--manifest=") {
                        set_once_path(&mut manifest, value, "--manifest")?;
                    } else if arg == "--manifest" {
                        let value = it
                            .next()
                            .ok_or_else(|| "--manifest requires a path".to_string())?;
                        set_once_path(&mut manifest, &value, "--manifest")?;
                    } else if let Some(value) = arg.strip_prefix("--binaries-dir=") {
                        set_once_path(&mut binaries_dir, value, "--binaries-dir")?;
                    } else if arg == "--binaries-dir" {
                        let value = it
                            .next()
                            .ok_or_else(|| "--binaries-dir requires a path".to_string())?;
                        set_once_path(&mut binaries_dir, &value, "--binaries-dir")?;
                    } else {
                        return Err(format!("unknown materialize arg {arg:?}\n{}", usage()));
                    }
                }
                Subcommand::Materialize {
                    binaries_dir,
                    fetch_only,
                }
            }
            "status" => {
                while let Some(arg) = it.next() {
                    if let Some(value) = arg.strip_prefix("--manifest=") {
                        set_once_path(&mut manifest, value, "--manifest")?;
                    } else if arg == "--manifest" {
                        let value = it
                            .next()
                            .ok_or_else(|| "--manifest requires a path".to_string())?;
                        set_once_path(&mut manifest, &value, "--manifest")?;
                    } else {
                        return Err(format!("unknown status arg {arg:?}\n{}", usage()));
                    }
                }
                Subcommand::Status
            }
            _ => return Err(usage()),
        };

        Ok(Self {
            subcommand,
            manifest,
        })
    }
}

fn set_once_path(slot: &mut Option<PathBuf>, value: &str, name: &str) -> Result<(), String> {
    if slot.is_some() {
        return Err(format!("{name} given more than once"));
    }
    if value.trim().is_empty() {
        return Err(format!("{name} requires a non-empty path"));
    }
    *slot = Some(PathBuf::from(value));
    Ok(())
}

fn usage() -> String {
    "usage: xtask platform-artifacts <validate|materialize|status> \
     [--manifest <path>] [--registry-removal] [--binaries-dir <path>] [--fetch-only]"
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::tempdir;

    #[test]
    fn validates_complete_manifest() {
        let dir = tempdir().unwrap();
        let manifest_path = write_fixture_manifest(dir.path(), ABI_VERSION, None);
        let manifest = load_manifest(&manifest_path).unwrap();

        validate_manifest(&manifest, dir.path(), true).unwrap();
    }

    #[test]
    fn rejects_stale_abi() {
        let dir = tempdir().unwrap();
        let manifest_path = write_fixture_manifest(dir.path(), ABI_VERSION + 1, None);
        let manifest = load_manifest(&manifest_path).unwrap();

        let err = validate_manifest(&manifest, dir.path(), true).unwrap_err();
        assert!(
            err.contains("does not match ABI_VERSION"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn registry_removal_rejects_registry_owned_script() {
        let dir = tempdir().unwrap();
        let manifest_path = write_fixture_manifest(
            dir.path(),
            ABI_VERSION,
            Some("packages/registry/kernel/build-kernel.sh"),
        );
        write_file(
            dir.path().join("packages/registry/kernel/build-kernel.sh"),
            "#!/usr/bin/env bash\n",
        );
        let manifest = load_manifest(&manifest_path).unwrap();

        let err = validate_manifest(&manifest, dir.path(), true).unwrap_err();
        assert!(
            err.contains("build.script_path outside packages/registry"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn materialize_copies_outputs_to_runtime_paths() {
        let dir = tempdir().unwrap();
        let manifest_path = write_fixture_manifest(dir.path(), ABI_VERSION, None);
        write_file(dir.path().join("local-binaries/kernel.wasm"), "kernel");
        write_file(
            dir.path().join("local-binaries/userspace.wasm"),
            "userspace",
        );
        write_file(
            dir.path()
                .join("local-binaries/programs/wasm32/kandelo-sdk.vfs.zst"),
            "sdk",
        );

        let manifest = load_manifest(&manifest_path).unwrap();
        let binaries = dir.path().join("binaries");
        materialize_manifest(&manifest, dir.path(), &binaries, true).unwrap();

        assert_eq!(read_to_string(binaries.join("kernel.wasm")), "kernel");
        assert_eq!(read_to_string(binaries.join("userspace.wasm")), "userspace");
        assert_eq!(
            read_to_string(binaries.join("programs/wasm32/kandelo-sdk.vfs.zst")),
            "sdk"
        );
        assert_eq!(
            read_to_string(dir.path().join("host/wasm/kandelo-kernel.wasm")),
            "kernel"
        );
        assert_eq!(
            read_to_string(
                dir.path()
                    .join("local-binaries/platform/kandelo-sdk.vfs.zst")
            ),
            "sdk"
        );
    }

    fn write_fixture_manifest(
        root: &Path,
        abi: u32,
        kernel_script_override: Option<&str>,
    ) -> PathBuf {
        let kernel_script =
            kernel_script_override.unwrap_or("platform/artifacts/kernel/build-kernel.sh");
        let scripts = [
            kernel_script,
            "platform/artifacts/userspace/build-userspace.sh",
            "platform/artifacts/kandelo-sdk/build-kandelo-sdk.sh",
        ];
        for script in scripts {
            write_file(root.join(script), "#!/usr/bin/env bash\n");
        }
        for input in [
            "kernel-input",
            "userspace-input",
            "sdk-input",
            "platform/artifacts/kernel/build-kernel.sh",
            "platform/artifacts/userspace/build-userspace.sh",
            "platform/artifacts/kandelo-sdk/build-kandelo-sdk.sh",
        ] {
            if !root.join(input).exists() {
                write_file(root.join(input), "");
            }
        }

        let manifest = json!({
            "schema": 1,
            "owner": "test",
            "kandelo_repository": "Automattic/kandelo",
            "kandelo_abi": abi,
            "release_tag": format!("binaries-abi-v{abi}"),
            "generator": "test",
            "artifacts": [
                artifact_json("kernel", "kernel_wasm", abi, kernel_script, "kernel-input", "kernel.wasm", &["local-binaries/kernel.wasm"], &["host/wasm/kandelo-kernel.wasm"]),
                artifact_json("userspace", "userspace_wasm", abi, "platform/artifacts/userspace/build-userspace.sh", "userspace-input", "userspace.wasm", &["local-binaries/userspace.wasm"], &[]),
                artifact_json("kandelo-sdk", "sdk_vfs", abi, "platform/artifacts/kandelo-sdk/build-kandelo-sdk.sh", "sdk-input", "programs/wasm32/kandelo-sdk.vfs.zst", &["local-binaries/programs/wasm32/kandelo-sdk.vfs.zst"], &["local-binaries/platform/kandelo-sdk.vfs.zst"])
            ]
        });
        let path = root.join("platform/artifacts/manifest.json");
        write_file(
            path.clone(),
            &serde_json::to_string_pretty(&manifest).unwrap(),
        );
        path
    }

    fn artifact_json(
        id: &str,
        kind: &str,
        abi: u32,
        script: &str,
        input: &str,
        binaries_path: &str,
        source_paths: &[&str],
        repo_paths: &[&str],
    ) -> serde_json::Value {
        json!({
            "id": id,
            "kind": kind,
            "version": "0.1.0",
            "target_arch": "wasm32",
            "kandelo_abi": abi,
            "status": {
                "state": "pending",
                "reason": "test pending",
                "next_action": "test next"
            },
            "source": {
                "repository": "Automattic/kandelo",
                "commit": "in-tree"
            },
            "build": {
                "script_path": script
            },
            "inputs": [
                input,
                script
            ],
            "outputs": [
                {
                    "source_paths": source_paths,
                    "archive_paths": [format!("artifacts/{binaries_path}")],
                    "binaries_path": binaries_path,
                    "repo_paths": repo_paths
                }
            ],
            "fallback": {
                "mode": "source-build",
                "available": true,
                "reason": "test fallback"
            },
            "provenance": {
                "cache_key_inputs": ["inputs"]
            },
            "validation": {
                "required": ["node", "browser"],
                "smoke_evidence": [
                    {
                        "id": "node",
                        "surface": "node",
                        "command": "node smoke",
                        "status": "required"
                    },
                    {
                        "id": "browser",
                        "surface": "browser",
                        "command": "browser smoke",
                        "status": "required"
                    }
                ]
            }
        })
    }

    fn write_file(path: PathBuf, contents: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, contents).unwrap();
    }

    fn read_to_string(path: PathBuf) -> String {
        fs::read_to_string(path).unwrap()
    }
}
