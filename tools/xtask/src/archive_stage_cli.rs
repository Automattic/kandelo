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
    binaries_dir: Option<PathBuf>,
    expected_cache_key_sha: Option<String>,
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
///                           to `XDG_CACHE_HOME/kandelo` or
///                           `~/.cache/kandelo`). Useful for
///                           tests + ephemeral CI runners.
///   --registry     <dir>    Override the manifest registry search root
///                           (defaults to `WASM_POSIX_DEPS_REGISTRY` or
///                           `<repo>/packages/registry`).
///   --binaries-dir <dir>    Materialize resolver program symlinks under
///                           this consumer-facing binaries directory while
///                           resolving dependencies.
///   --expected-cache-key-sha
///                 <hex>    Require the computed cache_key_sha to match
///                           this preflight-selected 64-char lowercase
///                           hex value before and after building.
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
    let manifest = DepsManifest::load_with_overlay(&parsed.package_dir)?;

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
    let sha_hex = compute_sha_hex(&manifest, &registry, parsed.arch, abi)?;
    if let Some(expected) = &parsed.expected_cache_key_sha {
        if &sha_hex != expected {
            return Err(format!(
                "archive-stage: computed cache_key_sha {sha_hex} for {} ({}) before build, \
                 but workflow expected {expected}; refusing to stage an archive from a \
                 different dependency/input view",
                manifest.spec(),
                parsed.arch.as_str(),
            ));
        }
    }
    let archive_path = archive_path_for_sha(&parsed.out_dir, &manifest, parsed.arch, abi, &sha_hex);

    // Resolve / build the cache entry. local_libs is intentionally
    // None — staged archives must reproduce from source / cache, never
    // from a developer's hand-patched checkout.
    let resolve_opts = ResolveOpts {
        cache_root: &cache_root,
        local_libs: None,
        force_source_build: None,
        fetch_only: false,
        repo_root: None,
        binaries_dir: parsed.binaries_dir.as_deref(),
    };
    let cache_path =
        build_deps::ensure_built(&manifest, &registry, parsed.arch, abi, &resolve_opts)
            .map_err(|e| format!("ensure_built: {e}"))?;

    // Source builds must not mutate any declared cache-key input. If
    // the key changes between filename selection and manifest writing,
    // publishing either value would create a split-brain archive.
    let post_build_sha_hex = compute_sha_hex(&manifest, &registry, parsed.arch, abi)?;
    if post_build_sha_hex != sha_hex {
        return Err(format!(
            "archive-stage: cache_key_sha changed while building {} ({}): before {sha_hex}, \
             after {post_build_sha_hex}. Build scripts must not mutate package manifests, \
             build.toml inputs, or global package-toolchain inputs.",
            manifest.spec(),
            parsed.arch.as_str(),
        ));
    }

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
fn archive_path_for_sha(
    out_dir: &Path,
    manifest: &DepsManifest,
    arch: TargetArch,
    abi: u32,
    sha_hex: &str,
) -> PathBuf {
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
    out_dir.join(archive_name)
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
    let mut binaries_dir: Option<PathBuf> = None;
    let mut expected_cache_key_sha: Option<String> = None;

    let mut it = args.into_iter();
    while let Some(a) = it.next() {
        // Helper closures for both `--flag value` and `--flag=value`.
        let take_value =
            |it: &mut std::vec::IntoIter<String>, name: &str| -> Result<String, String> {
                it.next().ok_or_else(|| format!("{name} requires a value"))
            };

        if let Some(v) = a.strip_prefix("--package=") {
            assign_once(&mut package, PathBuf::from(v), "--package")?;
        } else if a == "--package" {
            assign_once(
                &mut package,
                PathBuf::from(take_value(&mut it, "--package")?),
                "--package",
            )?;
        } else if let Some(v) = a.strip_prefix("--arch=") {
            assign_once(&mut arch, parse_target_arch(v)?, "--arch")?;
        } else if a == "--arch" {
            let v = take_value(&mut it, "--arch")?;
            assign_once(&mut arch, parse_target_arch(&v)?, "--arch")?;
        } else if let Some(v) = a.strip_prefix("--out=") {
            assign_once(&mut out_dir, PathBuf::from(v), "--out")?;
        } else if a == "--out" {
            assign_once(
                &mut out_dir,
                PathBuf::from(take_value(&mut it, "--out")?),
                "--out",
            )?;
        } else if let Some(v) = a.strip_prefix("--build-timestamp=") {
            assign_once(&mut build_timestamp, v.to_string(), "--build-timestamp")?;
        } else if a == "--build-timestamp" {
            assign_once(
                &mut build_timestamp,
                take_value(&mut it, "--build-timestamp")?,
                "--build-timestamp",
            )?;
        } else if let Some(v) = a.strip_prefix("--build-host=") {
            assign_once(&mut build_host, v.to_string(), "--build-host")?;
        } else if a == "--build-host" {
            assign_once(
                &mut build_host,
                take_value(&mut it, "--build-host")?,
                "--build-host",
            )?;
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
            assign_once(
                &mut cache_root,
                PathBuf::from(take_value(&mut it, "--cache-root")?),
                "--cache-root",
            )?;
        } else if let Some(v) = a.strip_prefix("--registry=") {
            assign_once(&mut registry_root, PathBuf::from(v), "--registry")?;
        } else if a == "--registry" {
            assign_once(
                &mut registry_root,
                PathBuf::from(take_value(&mut it, "--registry")?),
                "--registry",
            )?;
        } else if let Some(v) = a.strip_prefix("--binaries-dir=") {
            assign_once(&mut binaries_dir, PathBuf::from(v), "--binaries-dir")?;
        } else if a == "--binaries-dir" {
            assign_once(
                &mut binaries_dir,
                PathBuf::from(take_value(&mut it, "--binaries-dir")?),
                "--binaries-dir",
            )?;
        } else if let Some(v) = a.strip_prefix("--expected-cache-key-sha=") {
            let value = validate_cache_key_sha(v, "--expected-cache-key-sha")?;
            assign_once(
                &mut expected_cache_key_sha,
                value,
                "--expected-cache-key-sha",
            )?;
        } else if a == "--expected-cache-key-sha" {
            let v = take_value(&mut it, "--expected-cache-key-sha")?;
            let value = validate_cache_key_sha(&v, "--expected-cache-key-sha")?;
            assign_once(
                &mut expected_cache_key_sha,
                value,
                "--expected-cache-key-sha",
            )?;
        } else {
            return Err(format!("unexpected argument {a:?}"));
        }
    }

    let package_dir =
        package.ok_or_else(|| "archive-stage: --package <dir> is required".to_string())?;
    let arch =
        arch.ok_or_else(|| "archive-stage: --arch <wasm32|wasm64> is required".to_string())?;
    let out_dir = out_dir.ok_or_else(|| "archive-stage: --out <dir> is required".to_string())?;
    let build_timestamp = build_timestamp
        .ok_or_else(|| "archive-stage: --build-timestamp <ISO-8601-UTC> is required".to_string())?;
    let build_host =
        build_host.ok_or_else(|| "archive-stage: --build-host <string> is required".to_string())?;

    Ok(Args {
        package_dir,
        arch,
        out_dir,
        build_timestamp,
        build_host,
        abi,
        cache_root,
        registry_root,
        binaries_dir,
        expected_cache_key_sha,
    })
}

fn validate_cache_key_sha(value: &str, flag: &str) -> Result<String, String> {
    if value.len() != 64
        || !value
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_uppercase())
    {
        return Err(format!(
            "{flag} must be a 64-char lowercase hex cache_key_sha, got {value:?}"
        ));
    }
    Ok(value.to_string())
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
        fs::write(
            &script_path,
            "#!/bin/bash\necho > $WASM_POSIX_DEP_OUT_DIR/marker\n",
        )
        .unwrap();
        let mut perm = fs::metadata(&script_path).unwrap().permissions();
        perm.set_mode(0o755);
        fs::set_permissions(&script_path, perm).unwrap();
    }

    fn write_program_fixture(
        registry: &Path,
        name: &str,
        depends_on: &[&str],
        output_name: &str,
        output_file: &str,
    ) {
        let program_dir = registry.join(name);
        fs::create_dir_all(&program_dir).unwrap();
        let deps_toml = depends_on
            .iter()
            .map(|dep| format!("  \"{dep}\","))
            .collect::<Vec<_>>()
            .join("\n");
        let toml = format!(
            r#"
kind = "program"
name = "{name}"
version = "1.0.0"
kernel_abi = {kernel_abi}
depends_on = [
{deps_toml}
]

[source]
url = "https://example.test/{name}-1.0.0.tar.gz"
sha256 = "{:0>64}"

[license]
spdx = "TestLicense"

[[outputs]]
name = "{output_name}"
wasm = "{output_file}"
"#,
            "",
            kernel_abi = shared::ABI_VERSION,
        );
        fs::write(program_dir.join("package.toml"), toml).unwrap();
        let script_path = program_dir.join(format!("build-{name}.sh"));
        let script = format!(
            "#!/bin/bash\nset -euo pipefail\nprintf '%s\\n' {name} > \"$WASM_POSIX_DEP_OUT_DIR/{output_file}\"\n"
        );
        fs::write(&script_path, script).unwrap();
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

    fn write_build_toml_revision(registry: &Path, name: &str, revision: u32) {
        let build_toml = format!(
            r#"
script_path = "{name}/build-{name}.sh"
repo_url    = "https://example.test/repo.git"
commit      = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
revision    = {revision}

[binary]
index_url = "file:///tmp/wpk-nonexistent-binaries-abi-v{{abi}}/index.toml"
"#
        );
        fs::write(registry.join(name).join("build.toml"), build_toml).unwrap();
    }

    fn write_build_toml_inputs(registry: &Path, name: &str, inputs: &[&str]) {
        let inputs_toml = inputs
            .iter()
            .map(|input| format!("  \"{input}\","))
            .collect::<Vec<_>>()
            .join("\n");
        let build_toml = format!(
            r#"
script_path = "{name}/build-{name}.sh"
inputs = [
{inputs_toml}
]
repo_url    = "https://example.test/repo.git"
commit      = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
revision    = 1

[binary]
index_url = "file:///tmp/wpk-nonexistent-binaries-abi-v{{abi}}/index.toml"
"#
        );
        fs::write(registry.join(name).join("build.toml"), build_toml).unwrap();
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
            shared::ABI_VERSION.to_string(),
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
        assert_eq!(
            entries.len(),
            1,
            "exactly one archive expected, got: {entries:?}"
        );
        let name = &entries[0];
        // <name>-<version>-rev<N>-abi<N>-<arch>-<short8>.tar.zst
        let prefix = format!("z-1.0.0-rev1-abi{}-wasm32-", shared::ABI_VERSION);
        assert!(name.starts_with(&prefix), "got: {name}");
        assert!(name.ends_with(".tar.zst"), "got: {name}");
        // short_sha slot is exactly 8 lowercase hex chars.
        let suffix = ".tar.zst";
        let short = &name[prefix.len()..name.len() - suffix.len()];
        assert_eq!(short.len(), 8, "short_sha slot must be 8 chars: {short:?}");
        assert!(short
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_uppercase()));
    }

    #[test]
    fn cli_archive_filename_uses_build_toml_revision() {
        let dir = tempdir("e2-build-revision");
        let registry = dir.join("registry");
        let cache_root = dir.join("cache");
        let out_dir = dir.join("out");
        fs::create_dir_all(&registry).unwrap();
        fs::create_dir_all(&cache_root).unwrap();
        write_wasm32_only_fixture(&registry, "z");
        write_build_toml_revision(&registry, "z", 2);

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
        assert_eq!(
            entries.len(),
            1,
            "exactly one archive expected, got: {entries:?}"
        );
        let name = &entries[0];
        assert!(name.starts_with("z-1.0.0-rev2-abi4-wasm32-"), "got: {name}");
    }

    #[test]
    fn cli_rejects_expected_cache_key_mismatch_before_build() {
        let dir = tempdir("e2-expected-key-mismatch");
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
            "--expected-cache-key-sha".into(),
            "0".repeat(64),
        ])
        .expect_err("wrong expected cache key must fail before staging");
        assert!(err.contains("workflow expected"), "got: {err}");
        assert!(err.contains("computed cache_key_sha"), "got: {err}");
        assert!(
            !out_dir.exists() || fs::read_dir(&out_dir).unwrap().next().is_none(),
            "mismatch must not produce an archive"
        );
    }

    #[test]
    fn cli_rejects_cache_key_input_mutation_during_build() {
        let dir = tempdir("e2-key-drift");
        let registry = dir.join("registry");
        let cache_root = dir.join("cache");
        let out_dir = dir.join("out");
        fs::create_dir_all(&registry).unwrap();
        fs::create_dir_all(&cache_root).unwrap();
        write_lib_fixture(
            &registry,
            "z",
            r#"
script_dir="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$WASM_POSIX_DEP_OUT_DIR/lib"
echo data > "$WASM_POSIX_DEP_OUT_DIR/lib/libZ.a"
echo changed > "$script_dir/input.txt"
"#,
            "[outputs]\nlibs = [\"lib/libZ.a\"]\n",
        );
        fs::write(registry.join("z/input.txt"), "initial\n").unwrap();
        write_build_toml_inputs(&registry, "z", &["z/input.txt"]);

        let manifest = DepsManifest::load_with_overlay(&registry.join("z")).unwrap();
        let reg = Registry {
            roots: vec![registry.clone()],
        };
        let expected = super::compute_sha_hex(&manifest, &reg, TargetArch::Wasm32, 4).unwrap();

        let err = super::run(vec![
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
            "--expected-cache-key-sha".into(),
            expected,
        ])
        .expect_err("mutating a declared cache-key input must fail");
        assert!(err.contains("cache_key_sha changed"), "got: {err}");
        assert!(err.contains("Build scripts must not mutate"), "got: {err}");
        assert!(
            !out_dir.exists() || fs::read_dir(&out_dir).unwrap().next().is_none(),
            "key drift must not produce an archive"
        );
    }

    #[test]
    fn cli_binaries_dir_materializes_program_dependency_symlink() {
        let dir = tempdir("e2-binaries-dir");
        let registry = dir.join("registry");
        let cache_root = dir.join("cache");
        let out_dir = dir.join("out");
        let binaries_dir = dir.join("binaries");
        fs::create_dir_all(&registry).unwrap();
        fs::create_dir_all(&cache_root).unwrap();
        write_program_fixture(&registry, "dep", &[], "dep", "dep.data");
        write_program_fixture(&registry, "app", &["dep@1.0.0"], "app", "app.data");

        super::run(vec![
            "--package".into(),
            registry.join("app").display().to_string(),
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
            "--binaries-dir".into(),
            binaries_dir.display().to_string(),
        ])
        .expect("archive-stage must succeed with --binaries-dir");

        let dep_link = binaries_dir.join("programs/wasm32/dep.data");
        let link_target = fs::read_link(&dep_link).expect("dep symlink must exist");
        assert!(
            link_target.ends_with("dep.data"),
            "dep symlink must point at the dependency output, got {}",
            link_target.display()
        );
        assert!(
            fs::read_to_string(link_target).unwrap().contains("dep"),
            "dep symlink target should contain dependency output bytes"
        );
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
            assert!(
                entries.is_empty(),
                "no archive should be produced: {entries:?}"
            );
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
