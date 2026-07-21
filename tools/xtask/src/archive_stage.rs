//! Producer side of the V2 binary release pipeline.
//!
//! Packages a resolved cache entry (the lib/program install tree
//! the resolver produced under `<cache>/<kind>/<name>-...`) into a
//! `.tar.zst` archive that the consumer-side
//! [`crate::remote_fetch::fetch_and_install`] can verify and unpack.
//!
//! Decision 14 in
//! `docs/plans/2026-04-22-deps-management-v2-design.md`: the archive
//! carries a single `manifest.toml` (source `package.toml` + injected
//! `[compatibility]` block) plus an `artifacts/` subtree holding the
//! built files. `flatten_archive_layout` on the consumer side hoists
//! `artifacts/*` to the cache-root layout post-extract.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use crate::build_deps::validate_cache_artifacts;
use crate::pkg_manifest::{
    BuildToml, DepsManifest, GitBuildInput, ManifestKind, TargetArch, validate_cache_provenance,
};

/// Caller-supplied build provenance + the locally-computed cache-key
/// sha. We don't recompute the sha here so the caller (`archive-stage`
/// or a hand-driven build) can stay the source of truth on what the
/// consumer is required to match against.
pub struct StageOptions {
    /// 64-char lowercase hex. Validated by the [`DepsManifest::parse_archived`]
    /// round-trip below; bad shape rejects at archive-creation time.
    pub cache_key_sha: String,
    /// RFC3339 UTC, e.g. `"2026-04-26T10:00:00Z"`. Free-form string;
    /// not parsed by the resolver — informational only.
    pub build_timestamp: String,
    /// e.g. `"darwin-arm64"`, `"linux-x86_64"`. Free-form; informational.
    pub build_host: String,
    /// Exact external Git identities declared by the package recipe. These
    /// travel with the archive so cache identity and human-auditable
    /// provenance describe the same immutable inputs.
    pub git_inputs: Vec<GitBuildInput>,
}

/// Pack the resolved cache entry at `cache_dir` into a `.tar.zst`
/// archive at `archive_path`. Errors leave `archive_path` absent;
/// success guarantees the archive is on disk and `unpack`-able.
///
/// Pre-conditions:
///   * `target.kind` must be `Library` or `Program`. Source-kind has
///     no archive (decision 6).
///   * `cache_dir` must exist and be a directory.
///   * `archive_path`'s parent must exist (caller's job).
pub fn stage_archive_with_options(
    target: &DepsManifest,
    arch: TargetArch,
    abi_version: u32,
    cache_dir: &Path,
    archive_path: &Path,
    opts: &StageOptions,
) -> Result<(), String> {
    if matches!(target.kind, ManifestKind::Source) {
        return Err(format!(
            "archive_stage: kind=source is not archived (manifest {:?})",
            target.name
        ));
    }
    if !cache_dir.is_dir() {
        return Err(format!(
            "archive_stage: cache_dir {} is not a directory or does not exist",
            cache_dir.display()
        ));
    }

    // A direct archive-stage invocation must enforce the same declared
    // artifact closure as a resolver build/fetch. In particular, do not ship
    // an archive whose manifest promises a runtime file that the payload
    // omits; the consumer should never be the first place that notices.
    validate_cache_artifacts(target, cache_dir)
        .map_err(|e| format!("archive_stage: invalid cache entry: {e}"))?;
    validate_cache_provenance(target, cache_dir, arch, abi_version, &opts.cache_key_sha)
        .map_err(|e| format!("archive_stage: invalid cache provenance: {e}"))?;

    let expected_git_inputs = if target.dir.join("build.toml").exists() {
        BuildToml::load(&target.dir)?.git_inputs
    } else {
        Vec::new()
    };
    if opts.git_inputs != expected_git_inputs {
        return Err(format!(
            "archive_stage: immutable git input provenance differs from current build.toml: options {:?}, current {:?}",
            opts.git_inputs, expected_git_inputs
        ));
    }

    let manifest_text = build_archive_manifest_text(target, arch, abi_version, opts)?;

    // Pre-flight: enumerate cache_dir BEFORE touching any tmp file so
    // empty-cache rejection unwinds cleanly (no orphan tmp on disk).
    // A zero-output kind=library / kind=program build is always a bug —
    // fail-loud at the producer rather than ship an archive that
    // validates structurally but doesn't deliver any artifacts.
    let mut files: Vec<PathBuf> = Vec::new();
    collect_files(cache_dir, &mut files)?;
    if files.is_empty() {
        return Err(format!(
            "archive_stage: cache_dir {} contains no files — was the build script's [outputs] satisfied?",
            cache_dir.display()
        ));
    }
    // Deterministic ordering so two runs with identical cache_dir
    // contents produce byte-identical tar streams (modulo zstd's
    // internal nondeterminism, which kicks in at the encoder).
    files.sort();

    // Build the tar+zstd in memory; write atomically last.
    let mut tar_bytes: Vec<u8> = Vec::new();
    {
        let mut builder = tar::Builder::new(&mut tar_bytes);
        // 1. manifest.toml at the root.
        let mut header = tar::Header::new_gnu();
        header.set_size(manifest_text.len() as u64);
        header.set_mode(0o644);
        header.set_cksum();
        builder
            .append_data(&mut header, "manifest.toml", manifest_text.as_bytes())
            .map_err(|e| format!("tar append manifest.toml: {e}"))?;

        // 2. artifacts/<every-file-in-cache-dir>.
        for src in &files {
            let rel = src
                .strip_prefix(cache_dir)
                .map_err(|_| format!("strip_prefix {}", src.display()))?
                .to_string_lossy()
                .into_owned();
            let archive_rel = format!("artifacts/{rel}");
            let bytes = fs::read(src).map_err(|e| format!("read {}: {e}", src.display()))?;
            let mut h = tar::Header::new_gnu();
            h.set_size(bytes.len() as u64);
            h.set_mode(0o644);
            h.set_cksum();
            builder
                .append_data(&mut h, &archive_rel, &bytes[..])
                .map_err(|e| format!("tar append {archive_rel}: {e}"))?;
        }
        builder.finish().map_err(|e| format!("tar finish: {e}"))?;
    }

    let mut zst_bytes: Vec<u8> = Vec::new();
    {
        let mut encoder = zstd::stream::write::Encoder::new(&mut zst_bytes, 0)
            .map_err(|e| format!("zstd encoder: {e}"))?;
        encoder
            .write_all(&tar_bytes)
            .map_err(|e| format!("zstd write: {e}"))?;
        encoder.finish().map_err(|e| format!("zstd finish: {e}"))?;
    }

    // Atomic write: tmp + rename. Anyone observing `archive_path`
    // sees either nothing or a fully-written file.
    let tmp = archive_path.with_extension("tar.zst.tmp");
    fs::write(&tmp, &zst_bytes).map_err(|e| format!("write {}: {e}", tmp.display()))?;
    fs::rename(&tmp, archive_path).map_err(|e| {
        format!(
            "rename {} -> {}: {e}",
            tmp.display(),
            archive_path.display()
        )
    })?;
    Ok(())
}

/// Recursively collect every archive leaf under `dir`. Contained symlinks are
/// deliberately dereferenced into regular archive entries so compatibility
/// aliases survive the existing tar format. External/cyclic symlinks and
/// special files fail producer preflight instead of smuggling bytes from
/// outside the cache root or disappearing from the fetched artifact.
fn collect_files(dir: &Path, out: &mut Vec<PathBuf>) -> Result<(), String> {
    let canonical_root = fs::canonicalize(dir)
        .map_err(|e| format!("resolve archive cache root {}: {e}", dir.display()))?;
    let mut active_dirs = std::collections::BTreeSet::new();
    collect_files_inner(dir, &canonical_root, &mut active_dirs, out)
}

fn collect_files_inner(
    dir: &Path,
    canonical_root: &Path,
    active_dirs: &mut std::collections::BTreeSet<PathBuf>,
    out: &mut Vec<PathBuf>,
) -> Result<(), String> {
    let resolved_dir = fs::canonicalize(dir)
        .map_err(|e| format!("resolve archive directory {}: {e}", dir.display()))?;
    if !resolved_dir.starts_with(canonical_root) {
        return Err(format!(
            "archive directory {} resolves outside cache root {}",
            dir.display(),
            canonical_root.display()
        ));
    }
    if !active_dirs.insert(resolved_dir.clone()) {
        return Err(format!(
            "archive directory symlink cycle reaches {}",
            dir.display()
        ));
    }
    let mut entries = fs::read_dir(dir)
        .map_err(|e| format!("read_dir {}: {e}", dir.display()))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("read_dir {}: {e}", dir.display()))?;
    entries.sort_by_key(|entry| entry.path());
    for entry in entries {
        let p = entry.path();
        let link_metadata = fs::symlink_metadata(&p)
            .map_err(|e| format!("stat archive entry {}: {e}", p.display()))?;
        let resolved = fs::canonicalize(&p)
            .map_err(|e| format!("resolve archive entry {}: {e}", p.display()))?;
        if !resolved.starts_with(canonical_root) {
            return Err(format!(
                "archive entry {} resolves outside cache root {}",
                p.display(),
                canonical_root.display()
            ));
        }
        let metadata = if link_metadata.file_type().is_symlink() {
            fs::metadata(&p).map_err(|e| format!("follow archive symlink {}: {e}", p.display()))?
        } else {
            link_metadata
        };
        if metadata.is_dir() {
            collect_files_inner(&p, canonical_root, active_dirs, out)?;
        } else if metadata.is_file() {
            out.push(p);
        } else {
            return Err(format!(
                "archive entry {} is not a regular file, directory, or contained symlink",
                p.display()
            ));
        }
    }
    active_dirs.remove(&resolved_dir);
    Ok(())
}

/// Read the source `package.toml`, append a `[compatibility]` block
/// populated from `arch`/`abi_version`/`opts`, and round-trip the
/// result through [`DepsManifest::parse_archived`] so any injection
/// bug (malformed source TOML, pre-existing `[compatibility]`,
/// invalid sha) rejects at archive-creation time rather than at
/// fetch time on the consumer.
fn build_archive_manifest_text(
    target: &DepsManifest,
    arch: TargetArch,
    abi_version: u32,
    opts: &StageOptions,
) -> Result<String, String> {
    let src_path = target.dir.join("package.toml");
    let raw_src =
        fs::read_to_string(&src_path).map_err(|e| format!("read {}: {e}", src_path.display()))?;
    // Source package.toml is verified by parse() to have no
    // [compatibility] block AND no `revision` field (post
    // binary-resolution-via-index-ledger). The archived manifest
    // schema still requires both. We need `revision` to be at the
    // TOP level of the TOML, not inside a trailing table — splice it
    // in immediately after the last top-level scalar (commonly the
    // header lines before the first `[section]`); `target.revision`
    // defaults to 1 in validate_common when source omits it.
    let first_table_idx = raw_src
        .lines()
        .scan(0usize, |acc, l| {
            let start = *acc;
            *acc = start + l.len() + 1; // approximate newline width
            Some((start, l))
        })
        .find(|(_, l)| l.trim_start().starts_with('['))
        .map(|(i, _)| i)
        .unwrap_or(raw_src.len());

    let mut text = String::with_capacity(raw_src.len() + 64);
    text.push_str(&raw_src[..first_table_idx]);
    text.push_str(&format!("revision = {}\n", target.revision));
    text.push_str(&raw_src[first_table_idx..]);
    if !text.ends_with('\n') {
        text.push('\n');
    }
    text.push_str(&format!(
        "\n[compatibility]\ntarget_arch = \"{}\"\nabi_versions = [{}]\n\
         cache_key_sha = \"{}\"\nbuild_timestamp = \"{}\"\nbuild_host = \"{}\"\n",
        arch.as_str(),
        abi_version,
        opts.cache_key_sha,
        opts.build_timestamp,
        opts.build_host,
    ));
    for input in &opts.git_inputs {
        text.push_str("\n[[compatibility.git_inputs]]\n");
        text.push_str(
            &toml::to_string(input)
                .map_err(|e| format!("serialize compatibility git input: {e}"))?,
        );
    }
    let _ = DepsManifest::parse_archived(&text, target.dir.clone())
        .map_err(|e| format!("archived manifest fails its own validator: {e}"))?;
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pkg_manifest::DepsManifest;
    use std::fs;
    use std::path::PathBuf;

    fn tempdir(label: &str) -> PathBuf {
        let p = std::env::temp_dir()
            .join("wpk-xtask-archive-stage")
            .join(format!("{label}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn rejects_source_kind() {
        let dir = tempdir("rej-source");
        let registry = dir.join("registry/pcre2-source");
        fs::create_dir_all(&registry).unwrap();
        let toml = r#"
kind = "source"
name = "pcre2-source"
version = "10.42"
[source]
url = "file:///dev/null"
sha256 = "0000000000000000000000000000000000000000000000000000000000000000"
[license]
spdx = "BSD-3-Clause"
"#;
        let toml_path = registry.join("package.toml");
        fs::write(&toml_path, toml).unwrap();
        let m = DepsManifest::load(&toml_path).unwrap();

        let cache_dir = dir.join("cache_entry");
        fs::create_dir_all(&cache_dir).unwrap();
        let archive_path = dir.join("out.tar.zst");
        let opts = StageOptions {
            cache_key_sha: "0".repeat(64),
            build_timestamp: "2026-04-26T10:00:00Z".to_string(),
            build_host: "darwin-arm64".to_string(),
            git_inputs: vec![],
        };
        let err =
            stage_archive_with_options(&m, TargetArch::Wasm32, 4, &cache_dir, &archive_path, &opts)
                .unwrap_err();
        assert!(err.contains("source"), "got: {err}");
        assert!(!archive_path.exists());
    }

    fn library_manifest_text() -> &'static str {
        r#"
kind = "library"
name = "zlib"
version = "1.0.0"
[source]
url = "file:///dev/null"
sha256 = "0000000000000000000000000000000000000000000000000000000000000000"
[license]
spdx = "Zlib"
[outputs]
libs = ["lib/libZ.a"]
headers = ["include/zlib.h"]
"#
    }

    /// Build a fake cache entry on disk with libZ.a + zlib.h, plus
    /// a synthetic library manifest matching it. Returns
    /// `(cache_dir, archive_path, manifest, opts)`.
    fn fixture_for_round_trip(label: &str) -> (PathBuf, PathBuf, DepsManifest, StageOptions) {
        let dir = tempdir(label);
        let registry = dir.join("registry/zlib");
        fs::create_dir_all(&registry).unwrap();
        let toml_path = registry.join("package.toml");
        fs::write(&toml_path, library_manifest_text()).unwrap();
        let m = DepsManifest::load(&toml_path).unwrap();

        // The local cache path is part of the provenance invariant and must
        // carry the complete cache key, even in archive-stage unit fixtures.
        let cache_key_sha = "a".repeat(64);
        let cache_dir = dir.join(format!("cache-entry-{cache_key_sha}"));
        fs::create_dir_all(cache_dir.join("lib")).unwrap();
        fs::create_dir_all(cache_dir.join("include")).unwrap();
        fs::write(cache_dir.join("lib/libZ.a"), b"\x7fELF-fake-archive").unwrap();
        fs::write(cache_dir.join("include/zlib.h"), b"#ifndef ZLIB_H\n").unwrap();

        let archive_path = dir.join("zlib-out.tar.zst");

        // The cache_key_sha must be a 64-char lowercase hex string for
        // [compatibility] validation. Any value works for the
        // round-trip test as long as we feed the SAME value into both
        // stage_archive_with_options and remote_fetch::fetch_and_install.
        let opts = StageOptions {
            cache_key_sha,
            build_timestamp: "2026-04-26T10:00:00Z".to_string(),
            build_host: "darwin-arm64".to_string(),
            git_inputs: vec![],
        };
        (cache_dir, archive_path, m, opts)
    }

    #[test]
    fn produces_archive_consumable_by_remote_fetch() {
        use crate::pkg_manifest::Binary;
        use crate::remote_fetch::fetch_and_install;
        use sha2::{Digest, Sha256};

        let (cache_dir, archive_path, manifest, opts) = fixture_for_round_trip("round-trip");

        stage_archive_with_options(
            &manifest,
            TargetArch::Wasm32,
            4,
            &cache_dir,
            &archive_path,
            &opts,
        )
        .unwrap();
        assert!(archive_path.is_file());

        // Compute archive sha256 for the Binary record.
        let archive_bytes = fs::read(&archive_path).unwrap();
        let mut h = Sha256::new();
        h.update(&archive_bytes);
        let archive_sha_hex = crate::util::hex(&Into::<[u8; 32]>::into(h.finalize()));

        let binary = Binary {
            archive_url: format!("file://{}", archive_path.display()),
            archive_sha256: archive_sha_hex,
        };

        // Canonical install dir — must NOT pre-exist (its parent must).
        let install_root = archive_path.parent().unwrap().join("install/canonical");
        fs::create_dir_all(install_root.parent().unwrap()).unwrap();

        fetch_and_install(
            &binary,
            &install_root,
            &manifest,
            TargetArch::Wasm32,
            4,
            &opts.cache_key_sha,
        )
        .expect("fetch_and_install must accept stage_archive output");

        // Canonical layout: lib/libZ.a + include/zlib.h, with no
        // manifest.toml or artifacts/ leftover.
        assert!(install_root.is_dir());
        assert_eq!(
            fs::read(install_root.join("lib/libZ.a")).unwrap(),
            b"\x7fELF-fake-archive"
        );
        assert_eq!(
            fs::read(install_root.join("include/zlib.h")).unwrap(),
            b"#ifndef ZLIB_H\n"
        );
        assert!(!install_root.join("manifest.toml").exists());
        assert!(!install_root.join("artifacts").exists());
    }

    #[test]
    fn program_runtime_file_round_trips_through_archive_and_fetch() {
        use crate::pkg_manifest::Binary;
        use crate::remote_fetch::fetch_and_install;
        use sha2::{Digest, Sha256};
        use std::io::Read;

        let dir = tempdir("program-runtime-round-trip");
        let registry = dir.join("registry/php");
        fs::create_dir_all(&registry).unwrap();
        let manifest_text = r#"
kind = "program"
name = "php"
version = "8.3.15"
depends_on = []

[source]
url = "https://example.test/php.tar.gz"
sha256 = "0000000000000000000000000000000000000000000000000000000000000000"

[license]
spdx = "PHP-3.01"

[[outputs]]
name = "php"
wasm = "php.wasm"

[[runtime_files]]
artifact = "icu.dat"
guest_path = "/usr/lib/php/icu.dat"
mode = 420
"#;
        let manifest_path = registry.join("package.toml");
        fs::write(&manifest_path, manifest_text).unwrap();
        let manifest = DepsManifest::load(&manifest_path).unwrap();

        let cache_key_sha = "c".repeat(64);
        let cache_dir = dir.join(format!("cache-entry-{cache_key_sha}"));
        fs::create_dir_all(&cache_dir).unwrap();
        fs::write(
            cache_dir.join("php.wasm"),
            b"\x00asm\x01\x00\x00\x00\x01\x05\x01\x60\x00\x01\x7f\x03\x02\x01\x00\x07\x1a\x02\x0d__abi_version\x00\x00\x06_start\x00\x00\x0a\x06\x01\x04\x00\x41\x00\x0b",
        )
        .unwrap();
        let runtime_bytes = b"runtime-icu-data\0with-binary-bytes\xff";
        fs::write(cache_dir.join("icu.dat"), runtime_bytes).unwrap();

        let archive_path = dir.join("php-out.tar.zst");
        let opts = StageOptions {
            cache_key_sha,
            build_timestamp: "2026-07-12T00:00:00Z".to_string(),
            build_host: "test-host".to_string(),
            git_inputs: vec![],
        };
        stage_archive_with_options(
            &manifest,
            TargetArch::Wasm32,
            19,
            &cache_dir,
            &archive_path,
            &opts,
        )
        .unwrap();

        let archive_bytes = fs::read(&archive_path).unwrap();
        let mut archive_hash = Sha256::new();
        archive_hash.update(&archive_bytes);
        let binary = Binary {
            archive_url: format!("file://{}", archive_path.display()),
            archive_sha256: crate::util::hex(&Into::<[u8; 32]>::into(archive_hash.finalize())),
        };
        let install_root = dir.join("install/canonical");
        fs::create_dir_all(install_root.parent().unwrap()).unwrap();
        fetch_and_install(
            &binary,
            &install_root,
            &manifest,
            TargetArch::Wasm32,
            19,
            &opts.cache_key_sha,
        )
        .unwrap();
        assert_eq!(
            fs::read(install_root.join("icu.dat")).unwrap(),
            runtime_bytes
        );

        // Pin the authored installation contract in the embedded manifest,
        // not just the payload byte round-trip.
        let decoder = zstd::stream::read::Decoder::new(&archive_bytes[..]).unwrap();
        let mut tar = tar::Archive::new(decoder);
        let mut archived_manifest = None;
        for entry in tar.entries().unwrap() {
            let mut entry = entry.unwrap();
            if entry.path().unwrap().as_ref() == Path::new("manifest.toml") {
                let mut text = String::new();
                entry.read_to_string(&mut text).unwrap();
                archived_manifest = Some(text);
                break;
            }
        }
        let parsed = DepsManifest::parse_archived(
            &archived_manifest.expect("archive must contain manifest.toml"),
            registry,
        )
        .unwrap();
        assert_eq!(parsed.runtime_files, manifest.runtime_files);

        fs::remove_file(cache_dir.join("icu.dat")).unwrap();
        let incomplete_archive = dir.join("php-incomplete.tar.zst");
        let err = stage_archive_with_options(
            &manifest,
            TargetArch::Wasm32,
            19,
            &cache_dir,
            &incomplete_archive,
            &opts,
        )
        .unwrap_err();
        assert!(
            err.contains("runtime file") && err.contains("icu.dat"),
            "got: {err}"
        );
        assert!(!incomplete_archive.exists());
    }

    #[cfg(unix)]
    #[test]
    fn archive_dereferences_contained_symlinks_and_rejects_external_ones() {
        use std::io::Read;
        use std::os::unix::fs::symlink;

        let (cache_dir, archive_path, manifest, opts) = fixture_for_round_trip("symlink-safety");
        symlink("zlib.h", cache_dir.join("include/zconf.h")).unwrap();
        stage_archive_with_options(
            &manifest,
            TargetArch::Wasm32,
            4,
            &cache_dir,
            &archive_path,
            &opts,
        )
        .unwrap();

        let bytes = fs::read(&archive_path).unwrap();
        let decoder = zstd::stream::read::Decoder::new(&bytes[..]).unwrap();
        let mut tar = tar::Archive::new(decoder);
        let mut alias_bytes = None;
        for entry in tar.entries().unwrap() {
            let mut entry = entry.unwrap();
            if entry.path().unwrap().as_ref() == Path::new("artifacts/include/zconf.h") {
                let mut bytes = Vec::new();
                entry.read_to_end(&mut bytes).unwrap();
                alias_bytes = Some(bytes);
                break;
            }
        }
        assert_eq!(alias_bytes.as_deref(), Some(b"#ifndef ZLIB_H\n".as_slice()));

        fs::remove_file(cache_dir.join("include/zconf.h")).unwrap();
        let outside = archive_path.parent().unwrap().join("outside.dat");
        fs::write(&outside, b"outside").unwrap();
        symlink(&outside, cache_dir.join("include/zconf.h")).unwrap();
        let rejected = archive_path.parent().unwrap().join("external-link.tar.zst");
        let err = stage_archive_with_options(
            &manifest,
            TargetArch::Wasm32,
            4,
            &cache_dir,
            &rejected,
            &opts,
        )
        .unwrap_err();
        assert!(err.contains("outside cache root"), "got: {err}");
        assert!(!rejected.exists());
    }

    #[test]
    fn embedded_manifest_round_trips_through_parse_archived() {
        use crate::pkg_manifest::Binary;
        use sha2::{Digest, Sha256};
        use std::io::Read;

        let (cache_dir, archive_path, manifest, mut opts) =
            fixture_for_round_trip("embed-manifest");
        opts.git_inputs.push(GitBuildInput {
            name: "homebrew_tap_core".to_string(),
            repository: "https://github.com/Kandelo-dev/homebrew-tap-core.git".to_string(),
            commit: "b40a764d47f4f4408790de2c211ccb8efb8e4c46".to_string(),
        });
        fs::write(
            manifest.dir.join("build.toml"),
            r#"
script_path = "packages/registry/zlib/build-zlib.sh"
repo_url = "https://example.test/kandelo.git"
commit = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
revision = 1
[[git_inputs]]
name = "homebrew_tap_core"
repository = "https://github.com/Kandelo-dev/homebrew-tap-core.git"
commit = "b40a764d47f4f4408790de2c211ccb8efb8e4c46"
[binary]
index_url = "https://example.test/binaries-abi-v{abi}/index.toml"
"#,
        )
        .unwrap();
        crate::pkg_manifest::write_cache_provenance(
            &manifest,
            &cache_dir,
            TargetArch::Wasm32,
            4,
            &opts.cache_key_sha,
        )
        .unwrap();

        stage_archive_with_options(
            &manifest,
            TargetArch::Wasm32,
            4,
            &cache_dir,
            &archive_path,
            &opts,
        )
        .unwrap();

        // Manually decode .tar.zst to extract manifest.toml.
        let bytes = fs::read(&archive_path).unwrap();
        let decoder = zstd::stream::read::Decoder::new(&bytes[..]).unwrap();
        let mut tar = tar::Archive::new(decoder);
        let mut manifest_text: Option<String> = None;
        for entry in tar.entries().unwrap() {
            let mut entry = entry.unwrap();
            let path = entry.path().unwrap().into_owned();
            if path.to_string_lossy() == "manifest.toml" {
                let mut buf = String::new();
                entry.read_to_string(&mut buf).unwrap();
                manifest_text = Some(buf);
                break;
            }
        }
        let text = manifest_text.expect("manifest.toml must be inside archive");

        let parsed = DepsManifest::parse_archived(&text, manifest.dir.clone()).unwrap();
        let c = parsed
            .compatibility
            .as_ref()
            .expect("compatibility must be present");
        assert_eq!(c.target_arch, TargetArch::Wasm32);
        assert_eq!(c.abi_versions, vec![4]);
        assert_eq!(c.cache_key_sha, opts.cache_key_sha);
        assert_eq!(
            c.build_timestamp.as_deref(),
            Some(opts.build_timestamp.as_str())
        );
        assert_eq!(c.build_host.as_deref(), Some(opts.build_host.as_str()));
        assert_eq!(c.git_inputs, opts.git_inputs);

        // Consume those same bytes through the remote installer. This proves
        // the authored vector becomes an adjacent local-cache marker and is
        // accepted only under the exact current build.toml identity.
        let mut archive_hash = Sha256::new();
        archive_hash.update(&bytes);
        let binary = Binary {
            archive_url: format!("file://{}", archive_path.display()),
            archive_sha256: crate::util::hex(&Into::<[u8; 32]>::into(archive_hash.finalize())),
        };
        let install_root = archive_path
            .parent()
            .unwrap()
            .join("install")
            .join(format!("zlib-{}", opts.cache_key_sha));
        fs::create_dir_all(install_root.parent().unwrap()).unwrap();
        crate::remote_fetch::fetch_and_install(
            &binary,
            &install_root,
            &manifest,
            TargetArch::Wasm32,
            4,
            &opts.cache_key_sha,
        )
        .unwrap();
        crate::pkg_manifest::validate_cache_provenance(
            &manifest,
            &install_root,
            TargetArch::Wasm32,
            4,
            &opts.cache_key_sha,
        )
        .unwrap();
        assert!(install_root.join("lib/libZ.a").is_file());
        assert!(
            crate::pkg_manifest::cache_provenance_path(&install_root, &opts.cache_key_sha)
                .unwrap()
                .is_file()
        );

        let decoder = zstd::stream::read::Decoder::new(&bytes[..]).unwrap();
        let mut tar = tar::Archive::new(decoder);
        let archived_paths = tar
            .entries()
            .unwrap()
            .map(|entry| entry.unwrap().path().unwrap().into_owned())
            .collect::<Vec<_>>();
        assert!(
            archived_paths
                .iter()
                .all(|path| !path.to_string_lossy().contains("kandelo-provenance")),
            "resolver-local adjacent provenance must never enter package archives"
        );
    }

    #[test]
    fn rejects_git_provenance_not_declared_by_current_build() {
        let (cache_dir, archive_path, manifest, mut opts) =
            fixture_for_round_trip("git-provenance-mismatch");
        opts.git_inputs.push(GitBuildInput {
            name: "tap".to_string(),
            repository: "https://example.test/different.git".to_string(),
            commit: "1111111111111111111111111111111111111111".to_string(),
        });
        let err = stage_archive_with_options(
            &manifest,
            TargetArch::Wasm32,
            4,
            &cache_dir,
            &archive_path,
            &opts,
        )
        .unwrap_err();
        assert!(
            err.contains("differs from current build.toml"),
            "got: {err}"
        );
        assert!(!archive_path.exists());
    }

    #[test]
    fn produces_byte_identical_archive_on_repeat_invocation() {
        // Determinism is load-bearing for republish: a re-run that
        // perturbs archive_sha256 would force every consumer to refetch
        // identical bytes under a different name. Tar headers zero
        // mtime/uid/gid, files are sorted, zstd level 0 is deterministic
        // — verify the property end-to-end.
        let dir = tempdir("e2-determinism");
        let registry = dir.join("registry/zlib");
        fs::create_dir_all(&registry).unwrap();
        let toml_path = registry.join("package.toml");
        fs::write(&toml_path, library_manifest_text()).unwrap();
        let m = DepsManifest::load(&toml_path).unwrap();

        let cache_key_sha = "1".repeat(64);
        let cache_dir = dir.join(format!("cache-entry-{cache_key_sha}"));
        fs::create_dir_all(cache_dir.join("lib")).unwrap();
        fs::create_dir_all(cache_dir.join("include")).unwrap();
        fs::write(cache_dir.join("lib/libZ.a"), b"\x00\x01\x02").unwrap();
        fs::write(cache_dir.join("include/zlib.h"), b"#ifndef ZLIB_H\n").unwrap();

        let opts = StageOptions {
            cache_key_sha,
            build_timestamp: "2026-04-26T00:00:00Z".to_string(),
            build_host: "test-host".to_string(),
            git_inputs: vec![],
        };

        let a1 = dir.join("a1.tar.zst");
        let a2 = dir.join("a2.tar.zst");
        stage_archive_with_options(&m, TargetArch::Wasm32, 4, &cache_dir, &a1, &opts).unwrap();
        stage_archive_with_options(&m, TargetArch::Wasm32, 4, &cache_dir, &a2, &opts).unwrap();

        let bytes_a = fs::read(&a1).unwrap();
        let bytes_b = fs::read(&a2).unwrap();
        assert_eq!(
            bytes_a, bytes_b,
            "stage_archive_with_options must be byte-deterministic for the same inputs \
             (load-bearing for republish — a re-run that perturbs archive_sha256 would \
             force every consumer to refetch identical bytes under a different name)"
        );
    }

    #[test]
    fn rejects_empty_cache_dir() {
        // A zero-output kind=library / kind=program build is always a
        // build-script bug. Defense in depth: the producer rejects
        // rather than ship a manifest-only archive that validates but
        // doesn't deliver any artifacts.
        let dir = tempdir("e2-empty-cache");
        let registry = dir.join("registry/zlib");
        fs::create_dir_all(&registry).unwrap();
        let toml_path = registry.join("package.toml");
        fs::write(&toml_path, library_manifest_text()).unwrap();
        let m = DepsManifest::load(&toml_path).unwrap();

        let empty_cache = dir.join(format!("empty-cache-{}", "0".repeat(64)));
        fs::create_dir_all(&empty_cache).unwrap();
        // No files inside.

        let archive = dir.join("a.tar.zst");
        let opts = StageOptions {
            cache_key_sha: "0".repeat(64),
            build_timestamp: "2026-04-26T00:00:00Z".to_string(),
            build_host: "test-host".to_string(),
            git_inputs: vec![],
        };
        let err =
            stage_archive_with_options(&m, TargetArch::Wasm32, 4, &empty_cache, &archive, &opts)
                .unwrap_err();
        assert!(
            err.contains("missing from cache entry")
                || err.contains("contains no files")
                || err.contains("[outputs]"),
            "got: {err}"
        );
        assert!(
            !archive.exists(),
            "no archive should be produced on empty-cache rejection"
        );
    }

    #[test]
    fn rejects_when_cache_entry_is_missing() {
        let dir = tempdir("missing-cache");
        let registry = dir.join("registry/zlib");
        fs::create_dir_all(&registry).unwrap();
        let toml_path = registry.join("package.toml");
        fs::write(&toml_path, library_manifest_text()).unwrap();
        let m = DepsManifest::load(&toml_path).unwrap();

        let cache_dir = dir.join("does/not/exist");
        let archive_path = dir.join("out.tar.zst");
        let opts = StageOptions {
            cache_key_sha: "b".repeat(64),
            build_timestamp: "2026-04-26T10:00:00Z".to_string(),
            build_host: "darwin-arm64".to_string(),
            git_inputs: vec![],
        };
        let err =
            stage_archive_with_options(&m, TargetArch::Wasm32, 4, &cache_dir, &archive_path, &opts)
                .unwrap_err();
        // Error message must name the missing path so failures are
        // diagnosable.
        assert!(
            err.contains(&cache_dir.display().to_string()),
            "expected error to name {}, got: {err}",
            cache_dir.display()
        );
        assert!(!archive_path.exists());
    }
}
