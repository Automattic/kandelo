//! `xtask archive-stage` — produce one package's `.tar.zst` archive.
//!
//! Loads the package manifest at `--package <dir>`, resolves its deps
//! via the build-deps chain (`local-libs` → cache → remote-fetch →
//! source build), and packs the resulting cache entry into a single
//! `.tar.zst` written under `--out`. Operates on exactly one
//! `(package, arch)` pair — no registry walk, no aggregate index emitted
//! — which is what each Phase B-1 matrix-build entry needs to produce
//! its single archive for upload as a workflow artifact.
//!
//! See `docs/plans/2026-05-05-decoupled-package-builds-design.md`
//! and the Task 4 description.

use std::fs;
use std::path::{Path, PathBuf};

use crate::archive_stage::{self, StageOptions};
use crate::build_deps::{self, default_cache_root, parse_target_arch, Registry, ResolveOpts};
use crate::pkg_manifest::{DepsManifest, ManifestKind, TargetArch};
use crate::repo_root;
use crate::util::hex;

use wasm_posix_shared as shared;

/// Parsed CLI args for `xtask archive-stage`.
struct Args {
    package_dir: PathBuf,
    arch: TargetArch,
    out_dir: PathBuf,
    build_timestamp: String,
    build_host: String,
    abi: Option<u32>,
    cache_root: Option<PathBuf>,
    registry_root: Option<PathBuf>,
}

/// CLI entry point for `xtask archive-stage`.
///
/// Required flags (order-independent, both `--flag value` and
/// `--flag=value` accepted):
///   --package          <dir>             Path to package directory
///                                         containing `package.toml`.
///   --arch             <wasm32|wasm64>   Target architecture.
///   --out              <dir>             Directory to write the
///                                         resulting `.tar.zst` into;
///                                         created if missing.
///   --build-timestamp  <ISO-8601 UTC>    Pinned for reproducibility.
///   --build-host       <string>          Pinned for reproducibility.
///
/// Optional:
///   --abi          <u32>    Override the ABI version (defaults to
///                           `wasm_posix_shared::ABI_VERSION`).
///   --cache-root   <dir>    Override the resolver cache root (defaults
///                           to `XDG_CACHE_HOME/wasm-posix-kernel` or
///                           `~/.cache/wasm-posix-kernel`). Useful for
///                           tests + ephemeral CI runners.
///   --registry     <dir>    Override the manifest registry search root
///                           (defaults to `WASM_POSIX_DEPS_REGISTRY` or
///                           `<repo>/examples/libs`).
///
/// On success: prints the absolute path of the produced archive to
/// stdout (one line, no trailing whitespace beyond the newline).
///
/// Exits non-zero on:
///   * malformed / missing args
///   * `kind = "source"` packages (no archive)
///   * arch not in the manifest's `target_arches`
///   * build script failure / empty cache entry
pub fn run(args: Vec<String>) -> Result<(), String> {
    let parsed = parse_args(args)?;

    // Load the manifest. Errors here name the failing path so a typo
    // in --package surfaces clearly.
    let toml = parsed.package_dir.join("package.toml");
    let manifest = DepsManifest::load(&toml)?;

    // kind = "source" produces no archive (decision 6 in the design
    // doc + see archive_stage::stage_archive_with_options). Reject
    // up-front with a clearer message than the internal error.
    if matches!(manifest.kind, ManifestKind::Source) {
        return Err(format!(
            "archive-stage: package {:?} (kind=source) has no archive — \
             only kind=library and kind=program are stageable",
            manifest.name
        ));
    }

    // Manifest may opt out of an arch via `arches = [...]`. Mirror the
    // skip-with-clear-error semantics rather than silently producing
    // nothing — a Phase B-1 matrix entry that lands here is a workflow
    // bug (preflight should have filtered it).
    if !manifest.target_arches.contains(&parsed.arch) {
        return Err(format!(
            "archive-stage: package {:?} does not declare target_arches \
             entry for {} (declared: {:?})",
            manifest.name,
            parsed.arch.as_str(),
            manifest
                .target_arches
                .iter()
                .map(|a| a.as_str())
                .collect::<Vec<_>>(),
        ));
    }

    let abi = parsed.abi.unwrap_or(shared::ABI_VERSION);
    let cache_root = parsed.cache_root.clone().unwrap_or_else(default_cache_root);
    let registry = if let Some(r) = parsed.registry_root.clone() {
        Registry { roots: vec![r] }
    } else {
        Registry::from_env(&repo_root())
    };

    fs::create_dir_all(&parsed.out_dir)
        .map_err(|e| format!("mkdir {}: {e}", parsed.out_dir.display()))?;

    // Filename convention (single source of truth for archive naming):
    //   <name>-<v>-rev<N>-abi<N>-<arch>-<short8>.tar.zst
    // The `<short8>` suffix is the first 8 hex chars of the cache_key
    // sha so a freshly-published archive is content-addressable from
    // its filename alone.
    let archive_path = archive_path_for(
        &parsed.out_dir,
        &manifest,
        &registry,
        parsed.arch,
        abi,
    )?;

    // Resolve / build the cache entry. local_libs is intentionally
    // None — staged archives must reproduce from source / cache, never
    // from a developer's hand-patched checkout.
    let resolve_opts = ResolveOpts {
        cache_root: &cache_root,
        local_libs: None,
        force_source_build: None,
        repo_root: None,
        // archive-stage doesn't materialize binaries/ symlinks: it
        // produces a single-package archive without touching consumer-
        // facing layout.
        binaries_dir: None,
    };
    let cache_path = build_deps::ensure_built(&manifest, &registry, parsed.arch, abi, &resolve_opts)
        .map_err(|e| format!("ensure_built: {e}"))?;

    // Same cache-key sha as the one encoded in archive_path's short
    // suffix; recompute with a fresh memo so the result matches what
    // archive_path_for derived (memos must not cross arch boundaries).
    let sha_hex = compute_sha_hex(&manifest, &registry, parsed.arch, abi)?;

    let opts = StageOptions {
        cache_key_sha: sha_hex,
        build_timestamp: parsed.build_timestamp.clone(),
        build_host: parsed.build_host.clone(),
    };
    archive_stage::stage_archive_with_options(
        &manifest,
        parsed.arch,
        abi,
        &cache_path,
        &archive_path,
        &opts,
    )
    .map_err(|e| format!("archive_stage: {e}"))?;

    println!("{}", archive_path.display());
    Ok(())
}

/// Compute the canonical archive filename + path for a (manifest, arch,
/// abi) triple under `out_dir`. The shape (`<name>-<version>-rev<N>-
/// abi<N>-<arch>-<short8>.tar.zst`) is parsed by `build_index` to
/// recover `(name, version, revision, abi, arch, short_sha)` when
/// regenerating `index.toml`, so the formatter and parser MUST stay
/// aligned.
fn archive_path_for(
    out_dir: &Path,
    manifest: &DepsManifest,
    registry: &Registry,
    arch: TargetArch,
    abi: u32,
) -> Result<PathBuf, String> {
    let sha_hex = compute_sha_hex(manifest, registry, arch, abi)?;
    let short = &sha_hex[..8];
    let archive_name = format!(
        "{}-{}-rev{}-abi{}-{}-{}.tar.zst",
        manifest.name,
        manifest.version,
        manifest.revision,
        abi,
        arch.as_str(),
        short,
    );
    Ok(out_dir.join(archive_name))
}

/// Compute the cache-key sha for a manifest as a 64-char lowercase hex
/// string. Thin wrapper around `build_deps::compute_sha` that allocates
/// a fresh memo per call so the result is independent of any prior
/// arch's traversal — memos must not cross arch boundaries.
fn compute_sha_hex(
    manifest: &DepsManifest,
    registry: &Registry,
    arch: TargetArch,
    abi: u32,
) -> Result<String, String> {
    let mut memo = std::collections::BTreeMap::new();
    let mut chain = Vec::new();
    let sha = build_deps::compute_sha(manifest, registry, arch, abi, &mut memo, &mut chain)
        .map_err(|e| format!("compute_sha: {e}"))?;
    Ok(hex(&sha))
}

/// Hand-rolled parser. Like `compute-cache-key-sha`, this surface is
/// small and the existing helpers in `build_deps` have a different
/// shape — keeping the parsing focused makes the workflow's call site
/// easy to read.
fn parse_args(args: Vec<String>) -> Result<Args, String> {
    let mut package: Option<PathBuf> = None;
    let mut arch: Option<TargetArch> = None;
    let mut out_dir: Option<PathBuf> = None;
    let mut build_timestamp: Option<String> = None;
    let mut build_host: Option<String> = None;
    let mut abi: Option<u32> = None;
    let mut cache_root: Option<PathBuf> = None;
    let mut registry_root: Option<PathBuf> = None;

    let mut it = args.into_iter();
    while let Some(a) = it.next() {
        // Helper closures for both `--flag value` and `--flag=value`.
        let take_value = |it: &mut std::vec::IntoIter<String>, name: &str| -> Result<String, String> {
            it.next()
                .ok_or_else(|| format!("{name} requires a value"))
        };

        if let Some(v) = a.strip_prefix("--package=") {
            assign_once(&mut package, PathBuf::from(v), "--package")?;
        } else if a == "--package" {
            assign_once(&mut package, PathBuf::from(take_value(&mut it, "--package")?), "--package")?;
        } else if let Some(v) = a.strip_prefix("--arch=") {
            assign_once(&mut arch, parse_target_arch(v)?, "--arch")?;
        } else if a == "--arch" {
            let v = take_value(&mut it, "--arch")?;
            assign_once(&mut arch, parse_target_arch(&v)?, "--arch")?;
        } else if let Some(v) = a.strip_prefix("--out=") {
            assign_once(&mut out_dir, PathBuf::from(v), "--out")?;
        } else if a == "--out" {
            assign_once(&mut out_dir, PathBuf::from(take_value(&mut it, "--out")?), "--out")?;
        } else if let Some(v) = a.strip_prefix("--build-timestamp=") {
            assign_once(&mut build_timestamp, v.to_string(), "--build-timestamp")?;
        } else if a == "--build-timestamp" {
            assign_once(&mut build_timestamp, take_value(&mut it, "--build-timestamp")?, "--build-timestamp")?;
        } else if let Some(v) = a.strip_prefix("--build-host=") {
            assign_once(&mut build_host, v.to_string(), "--build-host")?;
        } else if a == "--build-host" {
            assign_once(&mut build_host, take_value(&mut it, "--build-host")?, "--build-host")?;
        } else if let Some(v) = a.strip_prefix("--abi=") {
            let n: u32 = v.parse().map_err(|e| format!("--abi: {e}"))?;
            assign_once(&mut abi, n, "--abi")?;
        } else if a == "--abi" {
            let v = take_value(&mut it, "--abi")?;
            let n: u32 = v.parse().map_err(|e| format!("--abi: {e}"))?;
            assign_once(&mut abi, n, "--abi")?;
        } else if let Some(v) = a.strip_prefix("--cache-root=") {
            assign_once(&mut cache_root, PathBuf::from(v), "--cache-root")?;
        } else if a == "--cache-root" {
            assign_once(&mut cache_root, PathBuf::from(take_value(&mut it, "--cache-root")?), "--cache-root")?;
        } else if let Some(v) = a.strip_prefix("--registry=") {
            assign_once(&mut registry_root, PathBuf::from(v), "--registry")?;
        } else if a == "--registry" {
            assign_once(&mut registry_root, PathBuf::from(take_value(&mut it, "--registry")?), "--registry")?;
        } else {
            return Err(format!("unexpected argument {a:?}"));
        }
    }

    let package_dir = package.ok_or_else(|| {
        "archive-stage: --package <dir> is required".to_string()
    })?;
    let arch = arch.ok_or_else(|| {
        "archive-stage: --arch <wasm32|wasm64> is required".to_string()
    })?;
    let out_dir = out_dir.ok_or_else(|| {
        "archive-stage: --out <dir> is required".to_string()
    })?;
    let build_timestamp = build_timestamp.ok_or_else(|| {
        "archive-stage: --build-timestamp <ISO-8601-UTC> is required".to_string()
    })?;
    let build_host = build_host.ok_or_else(|| {
        "archive-stage: --build-host <string> is required".to_string()
    })?;

    Ok(Args {
        package_dir,
        arch,
        out_dir,
        build_timestamp,
        build_host,
        abi,
        cache_root,
        registry_root,
    })
}

fn assign_once<T>(slot: &mut Option<T>, value: T, name: &str) -> Result<(), String> {
    if slot.is_some() {
        return Err(format!("{name} given more than once"));
    }
    *slot = Some(value);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;

    fn tempdir(label: &str) -> PathBuf {
        let p = std::env::temp_dir()
            .join("wpk-xtask-archive-stage-cli")
            .join(format!("{label}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    /// Drop a self-contained library fixture into `registry/<name>/`.
    /// Build script writes a single `lib/<name>.a` so the resolver +
    /// archive_stage path has something to pack.
    fn write_lib_fixture(registry: &Path, name: &str, body: &str, outputs: &str) {
        let lib_dir = registry.join(name);
        fs::create_dir_all(&lib_dir).unwrap();
        let toml = format!(
            r#"
kind = "library"
name = "{name}"
version = "1.0.0"
revision = 1

[source]
url = "https://example.test/{name}-1.0.0.tar.gz"
sha256 = "{:0>64}"

[license]
spdx = "TestLicense"

{outputs}
"#,
            ""
        );
        fs::write(lib_dir.join("package.toml"), toml).unwrap();
        let script_path = lib_dir.join(format!("build-{name}.sh"));
        let script = format!("#!/bin/bash\nset -euo pipefail\n{body}\n");
        fs::write(&script_path, script).unwrap();
        let mut perm = fs::metadata(&script_path).unwrap().permissions();
        perm.set_mode(0o755);
        fs::set_permissions(&script_path, perm).unwrap();
    }

    /// Source-kind fixture (no archive should be produced).
    fn write_source_fixture(registry: &Path, name: &str) {
        let lib_dir = registry.join(name);
        fs::create_dir_all(&lib_dir).unwrap();
        let toml = format!(
            r#"
kind = "source"
name = "{name}"
version = "1.0.0"
revision = 1
kernel_abi = 7

[source]
url = "https://example.test/{name}-1.0.0.tar.gz"
sha256 = "{:0>64}"

[license]
spdx = "TestLicense"

[build]
script_path = "{name}/build-{name}.sh"
"#,
            ""
        );
        fs::write(lib_dir.join("package.toml"), toml).unwrap();
        let script_path = lib_dir.join(format!("build-{name}.sh"));
        fs::write(&script_path, "#!/bin/bash\necho > $WASM_POSIX_DEP_OUT_DIR/marker\n").unwrap();
        let mut perm = fs::metadata(&script_path).unwrap().permissions();
        perm.set_mode(0o755);
        fs::set_permissions(&script_path, perm).unwrap();
    }

    /// Lib fixture that opts in only to wasm32 (default), so a request
    /// for wasm64 must fail with a clear "not declared" error rather
    /// than silently produce nothing.
    fn write_wasm32_only_fixture(registry: &Path, name: &str) {
        write_lib_fixture(
            registry,
            name,
            r#"
mkdir -p "$WASM_POSIX_DEP_OUT_DIR/lib"
echo data > "$WASM_POSIX_DEP_OUT_DIR/lib/libZ.a"
"#,
            "[outputs]\nlibs = [\"lib/libZ.a\"]\n",
        );
    }

    /// End-to-end smoke: a clean run of the CLI produces a real
    /// `.tar.zst` whose name follows the canonical filename formula.
    #[test]
    fn cli_produces_archive_with_canonical_filename() {
        let dir = tempdir("e2-smoke");
        let registry = dir.join("registry");
        let cache_root = dir.join("cache");
        let out_dir = dir.join("out");
        fs::create_dir_all(&registry).unwrap();
        fs::create_dir_all(&cache_root).unwrap();
        write_wasm32_only_fixture(&registry, "z");

        super::run(vec![
            "--package".into(),
            registry.join("z").display().to_string(),
            "--arch".into(),
            "wasm32".into(),
            "--out".into(),
            out_dir.display().to_string(),
            "--build-timestamp".into(),
            "2026-05-05T00:00:00Z".into(),
            "--build-host".into(),
            "test-host".into(),
            "--abi".into(),
            "4".into(),
            "--cache-root".into(),
            cache_root.display().to_string(),
            "--registry".into(),
            registry.display().to_string(),
        ])
        .expect("clean run must succeed");

        let entries: Vec<String> = fs::read_dir(&out_dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        assert_eq!(entries.len(), 1, "exactly one archive expected, got: {entries:?}");
        let name = &entries[0];
        // <name>-<version>-rev<N>-abi<N>-<arch>-<short8>.tar.zst
        assert!(name.starts_with("z-1.0.0-rev1-abi4-wasm32-"), "got: {name}");
        assert!(name.ends_with(".tar.zst"), "got: {name}");
        // short_sha slot is exactly 8 lowercase hex chars.
        let prefix = "z-1.0.0-rev1-abi4-wasm32-";
        let suffix = ".tar.zst";
        let short = &name[prefix.len()..name.len() - suffix.len()];
        assert_eq!(short.len(), 8, "short_sha slot must be 8 chars: {short:?}");
        assert!(short.chars().all(|c| c.is_ascii_hexdigit() && !c.is_uppercase()));
    }

    /// Two invocations with identical inputs must produce a
    /// byte-identical archive — load-bearing for the matrix workflow,
    /// where each runner produces an archive that consumers will
    /// later content-address and de-dup.
    #[test]
    fn cli_is_byte_deterministic_across_invocations() {
        let dir = tempdir("e2-determinism");
        let registry = dir.join("registry");
        let cache_root = dir.join("cache");
        let out1 = dir.join("out1");
        let out2 = dir.join("out2");
        fs::create_dir_all(&registry).unwrap();
        fs::create_dir_all(&cache_root).unwrap();
        write_wasm32_only_fixture(&registry, "z");

        let common = |out_dir: PathBuf| {
            super::run(vec![
                "--package".into(),
                registry.join("z").display().to_string(),
                "--arch".into(),
                "wasm32".into(),
                "--out".into(),
                out_dir.display().to_string(),
                "--build-timestamp".into(),
                "2026-05-05T00:00:00Z".into(),
                "--build-host".into(),
                "test-host".into(),
                "--abi".into(),
                "4".into(),
                "--cache-root".into(),
                cache_root.display().to_string(),
                "--registry".into(),
                registry.display().to_string(),
            ])
            .expect("clean run must succeed");
        };
        common(out1.clone());
        common(out2.clone());

        let read_only_archive = |dir: &Path| {
            let entries: Vec<_> = fs::read_dir(dir)
                .unwrap()
                .map(|e| e.unwrap().path())
                .collect();
            assert_eq!(entries.len(), 1, "got: {entries:?}");
            fs::read(&entries[0]).unwrap()
        };
        let bytes_a = read_only_archive(&out1);
        let bytes_b = read_only_archive(&out2);
        assert_eq!(
            bytes_a, bytes_b,
            "two invocations with identical inputs must produce byte-identical archives"
        );
    }

    /// A `kind = "source"` package has no archive (decision 6 in the
    /// design doc). The CLI must reject such requests up-front with a
    /// clear error rather than running the resolver and then erroring
    /// inside `stage_archive_with_options`.
    #[test]
    fn cli_rejects_source_kind_with_clear_error() {
        let dir = tempdir("e2-source-reject");
        let registry = dir.join("registry");
        let cache_root = dir.join("cache");
        let out_dir = dir.join("out");
        fs::create_dir_all(&registry).unwrap();
        fs::create_dir_all(&cache_root).unwrap();
        write_source_fixture(&registry, "src-only");

        let err = super::run(vec![
            "--package".into(),
            registry.join("src-only").display().to_string(),
            "--arch".into(),
            "wasm32".into(),
            "--out".into(),
            out_dir.display().to_string(),
            "--build-timestamp".into(),
            "2026-05-05T00:00:00Z".into(),
            "--build-host".into(),
            "test-host".into(),
            "--abi".into(),
            "4".into(),
            "--cache-root".into(),
            cache_root.display().to_string(),
            "--registry".into(),
            registry.display().to_string(),
        ])
        .expect_err("kind=source must be rejected up-front");
        assert!(err.contains("kind=source"), "got: {err}");
        assert!(err.contains("src-only"), "got: {err}");
        // No partial output: out_dir is the only side-effect of the
        // mkdir above, but the archive itself must not appear.
        if out_dir.is_dir() {
            let entries: Vec<_> = fs::read_dir(&out_dir).unwrap().collect();
            assert!(entries.is_empty(), "no archive should be produced: {entries:?}");
        }
    }

    /// A package with `target_arches = ["wasm32"]` (the default) that
    /// receives `--arch wasm64` must error with a clear message — the
    /// preflight should have filtered this out, so reaching this code
    /// path is a workflow bug worth surfacing loudly.
    #[test]
    fn cli_rejects_arch_not_in_target_arches() {
        let dir = tempdir("e2-arch-mismatch");
        let registry = dir.join("registry");
        let cache_root = dir.join("cache");
        let out_dir = dir.join("out");
        fs::create_dir_all(&registry).unwrap();
        fs::create_dir_all(&cache_root).unwrap();
        write_wasm32_only_fixture(&registry, "z");

        let err = super::run(vec![
            "--package".into(),
            registry.join("z").display().to_string(),
            "--arch".into(),
            "wasm64".into(),
            "--out".into(),
            out_dir.display().to_string(),
            "--build-timestamp".into(),
            "2026-05-05T00:00:00Z".into(),
            "--build-host".into(),
            "test-host".into(),
            "--abi".into(),
            "4".into(),
            "--cache-root".into(),
            cache_root.display().to_string(),
            "--registry".into(),
            registry.display().to_string(),
        ])
        .expect_err("wasm64 not in target_arches must error");
        assert!(err.contains("target_arches"), "got: {err}");
        assert!(err.contains("wasm64"), "got: {err}");
    }

    /// Missing required flags must fail parsing cleanly (no resolver
    /// work, no output side-effects).
    #[test]
    fn cli_requires_all_mandatory_flags() {
        // Missing --out.
        let err = super::run(vec![
            "--package".into(),
            "/nonexistent".into(),
            "--arch".into(),
            "wasm32".into(),
            "--build-timestamp".into(),
            "x".into(),
            "--build-host".into(),
            "x".into(),
        ])
        .expect_err("missing --out must error");
        assert!(err.contains("--out"), "got: {err}");

        // --package given twice.
        let err = super::run(vec![
            "--package".into(),
            "/a".into(),
            "--package".into(),
            "/b".into(),
        ])
        .expect_err("duplicate --package must error");
        assert!(err.contains("--package"), "got: {err}");
    }
}
