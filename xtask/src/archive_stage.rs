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

use crate::pkg_manifest::{DepsManifest, ManifestKind, TargetArch};

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
            let bytes = fs::read(src)
                .map_err(|e| format!("read {}: {e}", src.display()))?;
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
    fs::write(&tmp, &zst_bytes)
        .map_err(|e| format!("write {}: {e}", tmp.display()))?;
    fs::rename(&tmp, archive_path).map_err(|e| {
        format!(
            "rename {} -> {}: {e}",
            tmp.display(),
            archive_path.display()
        )
    })?;
    Ok(())
}

/// Recursively collect every regular file under `dir`. Symlinks and
/// other special files are not packed — the wasm cache layout is all
/// regular files (`lib/*.a`, `include/*.h`, `lib/pkgconfig/*.pc`).
fn collect_files(dir: &Path, out: &mut Vec<PathBuf>) -> Result<(), String> {
    for entry in fs::read_dir(dir).map_err(|e| format!("read_dir {}: {e}", dir.display()))? {
        let entry = entry.map_err(|e| format!("read_dir entry: {e}"))?;
        let p = entry.path();
        if p.is_dir() {
            collect_files(&p, out)?;
        } else if p.is_file() {
            out.push(p);
        }
    }
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
    let mut text = fs::read_to_string(&src_path)
        .map_err(|e| format!("read {}: {e}", src_path.display()))?;
    if !text.ends_with('\n') {
        text.push('\n');
    }
    // Source package.toml is verified by parse() to have no [compatibility]
    // block; appending the new block at the end is safe as long as the
    // source ends without an open trailing table. The parse_archived
    // round-trip below catches any structural breakage (malformed source
    // TOML, pre-existing [compatibility], invalid sha) before we ship.
    text.push_str(&format!(
        "\n[compatibility]\ntarget_arch = \"{}\"\nabi_versions = [{}]\n\
         cache_key_sha = \"{}\"\nbuild_timestamp = \"{}\"\nbuild_host = \"{}\"\n",
        arch.as_str(),
        abi_version,
        opts.cache_key_sha,
        opts.build_timestamp,
        opts.build_host,
    ));
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
revision = 1
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
revision = 1
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

        let cache_dir = dir.join("cache_entry");
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
            cache_key_sha: "a".repeat(64),
            build_timestamp: "2026-04-26T10:00:00Z".to_string(),
            build_host: "darwin-arm64".to_string(),
        };
        (cache_dir, archive_path, m, opts)
    }

    #[test]
    fn produces_archive_consumable_by_remote_fetch() {
        use crate::pkg_manifest::Binary;
        use crate::remote_fetch::fetch_and_install;
        use sha2::{Digest, Sha256};

        let (cache_dir, archive_path, manifest, opts) =
            fixture_for_round_trip("round-trip");

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
    fn embedded_manifest_round_trips_through_parse_archived() {
        use std::io::Read;

        let (cache_dir, archive_path, manifest, opts) =
            fixture_for_round_trip("embed-manifest");

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

        let cache_dir = dir.join("cache_entry");
        fs::create_dir_all(cache_dir.join("lib")).unwrap();
        fs::create_dir_all(cache_dir.join("include")).unwrap();
        fs::write(cache_dir.join("lib/libZ.a"), b"\x00\x01\x02").unwrap();
        fs::write(cache_dir.join("include/zlib.h"), b"#ifndef ZLIB_H\n").unwrap();

        let opts = StageOptions {
            cache_key_sha: "1".repeat(64),
            build_timestamp: "2026-04-26T00:00:00Z".to_string(),
            build_host: "test-host".to_string(),
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

        let empty_cache = dir.join("empty_cache");
        fs::create_dir_all(&empty_cache).unwrap();
        // No files inside.

        let archive = dir.join("a.tar.zst");
        let opts = StageOptions {
            cache_key_sha: "0".repeat(64),
            build_timestamp: "2026-04-26T00:00:00Z".to_string(),
            build_host: "test-host".to_string(),
        };
        let err = stage_archive_with_options(
            &m,
            TargetArch::Wasm32,
            4,
            &empty_cache,
            &archive,
            &opts,
        )
        .unwrap_err();
        assert!(
            err.contains("contains no files") || err.contains("[outputs]"),
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
