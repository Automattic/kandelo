//! Materialize one declared program output from an exact binary-index snapshot.
//!
//! This is the package-system boundary for consumers that need more than a
//! resolver cache path. It records the complete verification chain from the
//! fetched index bytes, through the immutable archive selected by that index,
//! to the exact declared output bytes. The archive is installed with the same
//! `remote_fetch` validation used by `build-deps resolve`; there is no parallel
//! archive parser or source-build fallback.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::build_deps::{Registry, compute_cache_key_sha_for_package, resolve_relative_url};
use crate::index_toml::{EntryStatus, IndexToml};
use crate::pkg_manifest::{BuildToml, DepsManifest, ManifestKind, TargetArch};
#[cfg(test)]
use crate::pkg_manifest::write_cache_provenance;
use crate::remote_fetch;
use crate::util::hex;

#[derive(Debug)]
struct Args {
    package_dir: PathBuf,
    arch: TargetArch,
    index_url: Option<String>,
    output_name: String,
    out: PathBuf,
    receipt: PathBuf,
}

#[derive(Debug, Serialize)]
struct PackageOutputReceipt {
    schema: u32,
    kind: &'static str,
    index: IndexReceipt,
    package: PackageReceipt,
    archive: ArchiveReceipt,
    output: OutputReceipt,
}

#[derive(Debug, Serialize)]
struct IndexReceipt {
    url: String,
    sha256: String,
    bytes: u64,
    abi: u32,
}

#[derive(Debug, Serialize)]
struct PackageReceipt {
    name: String,
    version: String,
    revision: u32,
    arch: String,
    cache_key_sha: String,
}

#[derive(Debug, Serialize)]
struct ArchiveReceipt {
    format: &'static str,
    url: String,
    sha256: String,
    bytes: u64,
}

#[derive(Debug, Serialize)]
struct OutputReceipt {
    name: String,
    path: String,
    sha256: String,
    bytes: u64,
}

pub fn run(args: Vec<String>) -> Result<(), String> {
    materialize(parse_args(args)?)
}

fn materialize(args: Args) -> Result<(), String> {
    if args.out == args.receipt {
        return Err("--out and --receipt must identify different files".to_string());
    }
    validate_destination(&args.out, "--out")?;
    validate_destination(&args.receipt, "--receipt")?;

    let target = DepsManifest::load_with_overlay(&args.package_dir)?;
    if target.kind != ManifestKind::Program {
        return Err(format!(
            "{} is kind={:?}; package-output receipts require kind=program",
            target.spec(),
            target.kind
        ));
    }
    let matches = target
        .program_outputs
        .iter()
        .filter(|output| output.name == args.output_name)
        .collect::<Vec<_>>();
    let output = match matches.as_slice() {
        [output] => *output,
        [] => {
            return Err(format!(
                "{} has no declared output named {:?}",
                target.spec(),
                args.output_name
            ));
        }
        _ => {
            return Err(format!(
                "{} declares output name {:?} more than once",
                target.spec(),
                args.output_name
            ));
        }
    };

    let abi = wasm_posix_shared::ABI_VERSION;
    let repo = crate::repo_root();
    let registry = Registry::from_env(&repo);
    let cache_key_sha =
        compute_cache_key_sha_for_package(&args.package_dir, &registry, args.arch, abi)?;
    let index_url = match args.index_url {
        Some(url) => url,
        None => BuildToml::load(&args.package_dir)?
            .binary
            .resolve_index_url(abi)
            .ok_or_else(|| {
                format!(
                    "{} uses a direct binary source; an exact index snapshot requires --index-url",
                    target.spec()
                )
            })?,
    };

    let index_bytes = remote_fetch::fetch_url(&index_url)
        .map_err(|error| format!("fetch exact package index {index_url}: {error}"))?;
    let index_text = std::str::from_utf8(&index_bytes)
        .map_err(|error| format!("package index is not UTF-8: {error}"))?;
    let index = IndexToml::parse(index_text)?;
    if index.abi_version != abi {
        return Err(format!(
            "package index ABI {} does not match Kandelo ABI {abi}",
            index.abi_version
        ));
    }

    let matching_packages = index
        .packages
        .iter()
        .filter(|package| package.name == target.name && package.version == target.version)
        .collect::<Vec<_>>();
    let package_entry = match matching_packages.as_slice() {
        [entry] => *entry,
        [] => {
            return Err(format!(
                "package index has no entry for {}@{}",
                target.name, target.version
            ));
        }
        _ => {
            return Err(format!(
                "package index has duplicate entries for {}@{}",
                target.name, target.version
            ));
        }
    };
    if package_entry.revision != target.revision {
        return Err(format!(
            "package index revision {} for {}@{} does not match recipe revision {}",
            package_entry.revision, target.name, target.version, target.revision
        ));
    }
    let binary = package_entry.binary.get(&args.arch).ok_or_else(|| {
        format!(
            "package index has no {} entry for {}@{}",
            args.arch.as_str(),
            target.name,
            target.version
        )
    })?;
    if binary.status != EntryStatus::Success {
        return Err(format!(
            "package index entry for {}@{} {} is status={:?}; an exact receipt requires success",
            target.name,
            target.version,
            args.arch.as_str(),
            binary.status
        ));
    }
    let archive_url = binary
        .archive_url
        .as_deref()
        .ok_or_else(|| "successful package index entry has no archive_url".to_string())?;
    let archive_sha256 = binary
        .archive_sha256
        .as_deref()
        .ok_or_else(|| "successful package index entry has no archive_sha256".to_string())?;
    let indexed_cache_key = binary
        .cache_key_sha
        .as_deref()
        .ok_or_else(|| "successful package index entry has no cache_key_sha".to_string())?;
    require_sha256(archive_sha256, "package archive sha256")?;
    require_sha256(indexed_cache_key, "package cache key")?;
    if indexed_cache_key != cache_key_sha {
        return Err(format!(
            "package index cache key {indexed_cache_key} does not match exact recipe {cache_key_sha}"
        ));
    }
    let archive_url = resolve_relative_url(&index_url, archive_url);

    let scratch = ScratchDir::create(&args.out)?;
    // The strict archive installer uses the same adjacent immutable-Git
    // provenance marker as the resolver cache. Preserve that contract even in
    // this exclusive ephemeral workspace by giving the install directory its
    // canonical full-cache-key suffix.
    let install = scratch.path.join(format!("installed-{cache_key_sha}"));
    let fetched = remote_fetch::fetch_and_install_direct_with_metadata(
        &archive_url,
        archive_sha256,
        &install,
        &target,
        args.arch,
        abi,
        &cache_key_sha,
    )
    .map_err(|error| format!("materialize exact package archive: {error}"))?;
    let materialized = install.join(&output.wasm);
    let metadata = fs::symlink_metadata(&materialized).map_err(|error| {
        format!(
            "inspect declared package output {}: {error}",
            materialized.display()
        )
    })?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(format!(
            "declared package output {} is not a regular non-symlink file",
            materialized.display()
        ));
    }
    let output_bytes = fs::read(&materialized)
        .map_err(|error| format!("read declared package output {}: {error}", output.wasm))?;
    let output_sha256 = sha256(&output_bytes);

    let receipt = PackageOutputReceipt {
        schema: 1,
        kind: "kandelo-package-output",
        index: IndexReceipt {
            url: index_url,
            sha256: sha256(&index_bytes),
            bytes: index_bytes.len() as u64,
            abi,
        },
        package: PackageReceipt {
            name: target.name,
            version: target.version,
            revision: target.revision,
            arch: args.arch.as_str().to_string(),
            cache_key_sha,
        },
        archive: ArchiveReceipt {
            format: "kandelo-package-tar-zstd-v2",
            url: archive_url,
            sha256: archive_sha256.to_string(),
            bytes: fetched.archive_bytes,
        },
        output: OutputReceipt {
            name: output.name.clone(),
            path: output.wasm.clone(),
            sha256: output_sha256,
            bytes: output_bytes.len() as u64,
        },
    };
    let mut receipt_bytes = serde_json::to_vec_pretty(&receipt)
        .map_err(|error| format!("encode package output receipt: {error}"))?;
    receipt_bytes.push(b'\n');

    write_atomic(&args.out, &output_bytes)?;
    write_atomic(&args.receipt, &receipt_bytes)?;
    println!("{}", args.out.display());
    Ok(())
}

fn parse_args(values: Vec<String>) -> Result<Args, String> {
    let mut package_dir = None;
    let mut arch = None;
    let mut index_url = None;
    let mut output_name = None;
    let mut out = None;
    let mut receipt = None;
    let mut args = values.into_iter();
    while let Some(flag) = args.next() {
        let value = args
            .next()
            .ok_or_else(|| format!("{flag} requires a value"))?;
        match flag.as_str() {
            "--package" if package_dir.is_none() => package_dir = Some(PathBuf::from(value)),
            "--arch" if arch.is_none() => {
                arch = Some(match value.as_str() {
                    "wasm32" => TargetArch::Wasm32,
                    "wasm64" => TargetArch::Wasm64,
                    _ => return Err(format!("--arch must be wasm32 or wasm64, got {value:?}")),
                });
            }
            "--index-url" if index_url.is_none() => index_url = Some(value),
            "--output-name" if output_name.is_none() => output_name = Some(value),
            "--out" if out.is_none() => out = Some(PathBuf::from(value)),
            "--receipt" if receipt.is_none() => receipt = Some(PathBuf::from(value)),
            _ => return Err(format!("unexpected or repeated argument {flag:?}")),
        }
    }
    Ok(Args {
        package_dir: package_dir.ok_or("--package <dir> is required")?,
        arch: arch.ok_or("--arch <wasm32|wasm64> is required")?,
        index_url,
        output_name: output_name.ok_or("--output-name <name> is required")?,
        out: out.ok_or("--out <path> is required")?,
        receipt: receipt.ok_or("--receipt <path> is required")?,
    })
}

fn require_sha256(value: &str, label: &str) -> Result<(), String> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(format!(
            "{label} must be 64 lowercase hexadecimal characters"
        ));
    }
    Ok(())
}

fn validate_destination(path: &Path, flag: &str) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("{flag} has no parent directory: {}", path.display()))?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("create {flag} parent {}: {error}", parent.display()))?;
    if let Ok(metadata) = fs::symlink_metadata(path)
        && (!metadata.is_file() || metadata.file_type().is_symlink())
    {
        return Err(format!(
            "{flag} destination must be absent or a regular non-symlink file: {}",
            path.display()
        ));
    }
    Ok(())
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().expect("destination was validated");
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| format!("destination has no UTF-8 filename: {}", path.display()))?;
    let temp = parent.join(format!(".{name}.tmp-{}", std::process::id()));
    if temp.exists() || temp.symlink_metadata().is_ok() {
        return Err(format!(
            "atomic destination temp already exists: {}",
            temp.display()
        ));
    }
    fs::write(&temp, bytes)
        .map_err(|error| format!("write temporary output {}: {error}", temp.display()))?;
    if let Err(error) = fs::rename(&temp, path) {
        let _ = fs::remove_file(&temp);
        return Err(format!(
            "install materialized output {} -> {}: {error}",
            temp.display(),
            path.display()
        ));
    }
    Ok(())
}

fn sha256(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let digest: [u8; 32] = hasher.finalize().into();
    hex(&digest)
}

struct ScratchDir {
    path: PathBuf,
}

impl ScratchDir {
    fn create(out: &Path) -> Result<Self, String> {
        let parent = out.parent().expect("destination was validated");
        for counter in 0..1000 {
            let path = parent.join(format!(
                ".package-output-materialize-{}-{counter}",
                std::process::id()
            ));
            match fs::create_dir(&path) {
                Ok(()) => return Ok(Self { path }),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => {
                    return Err(format!(
                        "create package-output scratch {}: {error}",
                        path.display()
                    ));
                }
            }
        }
        Err(format!(
            "could not allocate package-output scratch under {}",
            parent.display()
        ))
    }
}

impl Drop for ScratchDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::archive_stage::{StageOptions, stage_archive_with_options};
    use crate::index_toml::BinaryEntry;
    use std::collections::BTreeMap;
    use tempfile::tempdir;

    fn fixture() -> (tempfile::TempDir, Args, Vec<u8>, String) {
        let dir = tempdir().unwrap();
        let registry = dir.path().join("registry");
        let package_dir = registry.join("shell");
        fs::create_dir_all(&package_dir).unwrap();
        fs::write(
            package_dir.join("package.toml"),
            r#"kind = "program"
name = "shell"
version = "0.1.0"
kernel_abi = 7
[source]
url = "https://example.invalid/source"
sha256 = "0000000000000000000000000000000000000000000000000000000000000000"
[license]
spdx = "MIT"
[[outputs]]
name = "shell"
wasm = "shell.vfs.zst"
"#,
        )
        .unwrap();
        fs::write(
            package_dir.join("build.toml"),
            r#"script_path = "scripts/dev-shell.sh"
repo_url = "https://github.com/example/kandelo.git"
commit = "0000000000000000000000000000000000000000"
revision = 14

[[git_inputs]]
name = "homebrew_tap_core"
repository = "https://github.com/example/homebrew-tap-core.git"
commit = "1111111111111111111111111111111111111111"

[binary]
index_url = "https://example.invalid/index.toml"
"#,
        )
        .unwrap();

        let registry_value = Registry {
            roots: vec![registry],
        };
        let abi = wasm_posix_shared::ABI_VERSION;
        let cache_key = compute_cache_key_sha_for_package(
            &package_dir,
            &registry_value,
            TargetArch::Wasm32,
            abi,
        )
        .unwrap();
        let target = DepsManifest::load_with_overlay(&package_dir).unwrap();
        let cache = dir.path().join(format!("cache-shell-{cache_key}"));
        fs::create_dir_all(&cache).unwrap();
        let output_bytes = b"exact bottle-built shell bytes\n".to_vec();
        fs::write(cache.join("shell.vfs.zst"), &output_bytes).unwrap();
        write_cache_provenance(&target, &cache, TargetArch::Wasm32, abi, &cache_key).unwrap();
        let git_inputs = BuildToml::load(&package_dir).unwrap().git_inputs;
        let archive_name = format!(
            "shell-0.1.0-rev14-abi{abi}-wasm32-{}.tar.zst",
            &cache_key[..8]
        );
        let archive = dir.path().join(&archive_name);
        stage_archive_with_options(
            &target,
            TargetArch::Wasm32,
            abi,
            &cache,
            &archive,
            &StageOptions {
                cache_key_sha: cache_key.clone(),
                build_timestamp: "2026-07-21T00:00:00Z".to_string(),
                build_host: "test".to_string(),
                git_inputs,
            },
        )
        .unwrap();
        let archive_bytes = fs::read(&archive).unwrap();
        let archive_sha = sha256(&archive_bytes);
        let index = IndexToml {
            abi_version: abi,
            generated_at: "2026-07-21T00:00:00Z".to_string(),
            generator: "test".to_string(),
            packages: vec![crate::index_toml::PackageEntry {
                name: "shell".to_string(),
                version: "0.1.0".to_string(),
                revision: 14,
                binary: BTreeMap::from([(
                    TargetArch::Wasm32,
                    BinaryEntry {
                        status: EntryStatus::Success,
                        archive_url: Some(archive_name),
                        archive_sha256: Some(archive_sha),
                        cache_key_sha: Some(cache_key.clone()),
                        ..BinaryEntry::default()
                    },
                )]),
            }],
        };
        let index_path = dir.path().join("index.toml");
        fs::write(&index_path, index.write()).unwrap();
        let args = Args {
            package_dir,
            arch: TargetArch::Wasm32,
            index_url: Some(format!("file://{}", index_path.display())),
            output_name: "shell".to_string(),
            out: dir.path().join("materialized/shell.vfs.zst"),
            receipt: dir.path().join("materialized/shell.receipt.json"),
        };
        (dir, args, output_bytes, cache_key)
    }

    #[test]
    fn materializes_exact_declared_output_and_complete_receipt() {
        let (_dir, args, expected, cache_key) = fixture();
        let output = args.out.clone();
        let receipt = args.receipt.clone();
        let index_url = args.index_url.clone().unwrap();
        let index_path = PathBuf::from(index_url.strip_prefix("file://").unwrap());
        let index_bytes = fs::read(&index_path).unwrap();
        let index = IndexToml::parse(std::str::from_utf8(&index_bytes).unwrap()).unwrap();
        let binary = index.packages[0].binary.get(&TargetArch::Wasm32).unwrap();
        let archive_url = resolve_relative_url(&index_url, binary.archive_url.as_deref().unwrap());
        let archive_path = PathBuf::from(archive_url.strip_prefix("file://").unwrap());
        let archive_bytes = fs::read(&archive_path).unwrap();
        materialize(args).unwrap();
        assert_eq!(fs::read(output).unwrap(), expected);
        let value: serde_json::Value = serde_json::from_slice(&fs::read(receipt).unwrap()).unwrap();
        assert_eq!(
            value,
            serde_json::json!({
                "schema": 1,
                "kind": "kandelo-package-output",
                "index": {
                    "url": index_url,
                    "sha256": sha256(&index_bytes),
                    "bytes": index_bytes.len(),
                    "abi": wasm_posix_shared::ABI_VERSION,
                },
                "package": {
                    "name": "shell",
                    "version": "0.1.0",
                    "revision": 14,
                    "arch": "wasm32",
                    "cache_key_sha": cache_key,
                },
                "archive": {
                    "format": "kandelo-package-tar-zstd-v2",
                    "url": archive_url,
                    "sha256": sha256(&archive_bytes),
                    "bytes": archive_bytes.len(),
                },
                "output": {
                    "name": "shell",
                    "path": "shell.vfs.zst",
                    "sha256": sha256(&expected),
                    "bytes": expected.len(),
                },
            })
        );
    }

    #[test]
    fn uses_the_recipe_index_when_no_override_is_given() {
        let (_dir, mut args, expected, _cache_key) = fixture();
        let index_url = args.index_url.take().unwrap();
        let build_path = args.package_dir.join("build.toml");
        let build = fs::read_to_string(&build_path).unwrap();
        fs::write(
            &build_path,
            build.replace("https://example.invalid/index.toml", &index_url),
        )
        .unwrap();
        let output = args.out.clone();
        materialize(args).unwrap();
        assert_eq!(fs::read(output).unwrap(), expected);
    }

    #[test]
    fn rejects_index_revision_drift_before_materializing() {
        let (_dir, args, _expected, _cache_key) = fixture();
        let index_path = PathBuf::from(
            args.index_url
                .as_deref()
                .unwrap()
                .strip_prefix("file://")
                .unwrap(),
        );
        let text = fs::read_to_string(&index_path).unwrap();
        fs::write(&index_path, text.replace("revision = 14", "revision = 13")).unwrap();
        let error = materialize(args).unwrap_err();
        assert!(
            error.contains("does not match recipe revision 14"),
            "{error}"
        );
    }

    #[test]
    fn rejects_unknown_declared_output() {
        let (_dir, mut args, _expected, _cache_key) = fixture();
        args.output_name = "missing".to_string();
        let error = materialize(args).unwrap_err();
        assert!(
            error.contains("no declared output named \"missing\""),
            "{error}"
        );
    }

    #[test]
    fn rejects_index_cache_key_drift_before_fetching_the_archive() {
        let (_dir, args, _expected, cache_key) = fixture();
        let index_path = PathBuf::from(
            args.index_url
                .as_deref()
                .unwrap()
                .strip_prefix("file://")
                .unwrap(),
        );
        let text = fs::read_to_string(&index_path).unwrap();
        fs::write(&index_path, text.replace(&cache_key, &"f".repeat(64))).unwrap();
        let error = materialize(args).unwrap_err();
        assert!(error.contains("does not match exact recipe"), "{error}");
    }
}
