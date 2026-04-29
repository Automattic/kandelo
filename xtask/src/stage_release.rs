//! Stage all package-system library + program archives for a release.
//!
//! Walks the registry, fans out across requested arches, calls
//! `build_deps::ensure_built` to populate the cache, then
//! `archive_stage::stage_archive_with_options` to produce the
//! `.tar.zst`. Finally delegates to `build_manifest::run` to emit
//! `manifest.json`. Atomic against re-runs: an archive whose
//! computed name already exists in `<staging>/{libs,programs}/` is
//! skipped.
//!
//! Failure semantics:
//!   * Per-arch errors are logged as `WARN` and tracked.
//!   * Without `--continue-on-error`: a manifest that fails for
//!     EVERY requested arch is fatal (returns `Err`); a manifest
//!     that fails for only SOME requested arches is downgraded to
//!     a warning. Rationale: a single missing-for-wasm64-only
//!     dependency shouldn't fail an otherwise-clean release.
//!   * With `--continue-on-error`: even total-failure manifests
//!     are warnings, never fatal.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use wasm_posix_shared as shared;

use crate::archive_stage::{self, StageOptions};
use crate::build_deps::{self, default_cache_root, parse_target_arch, Registry, ResolveOpts};
use crate::build_manifest;
use crate::deps_manifest::{DepsManifest, ManifestKind, TargetArch};
use crate::repo_root;
use crate::util::hex;

pub fn run(args: Vec<String>) -> Result<(), String> {
    let mut staging: Option<PathBuf> = None;
    let mut registry_root: Option<PathBuf> = None;
    let mut cache_root: Option<PathBuf> = None;
    let mut abi: Option<u32> = None;
    let mut arches: Vec<TargetArch> = Vec::new();
    let mut tag: Option<String> = None;
    let mut build_timestamp: Option<String> = None;
    let mut build_host: Option<String> = None;
    let mut continue_on_error = false;
    let mut kinds: Vec<ManifestKind> = Vec::new();

    let mut it = args.into_iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--staging" => {
                staging = Some(it.next().ok_or("--staging requires path")?.into())
            }
            "--registry" => {
                registry_root = Some(it.next().ok_or("--registry requires path")?.into())
            }
            "--cache-root" => {
                cache_root = Some(it.next().ok_or("--cache-root requires path")?.into())
            }
            "--abi" => {
                abi = Some(
                    it.next()
                        .ok_or("--abi requires <u32>")?
                        .parse()
                        .map_err(|e| format!("--abi: {e}"))?,
                )
            }
            "--arch" => {
                arches.push(parse_target_arch(
                    &it.next().ok_or("--arch requires wasm32|wasm64")?,
                )?)
            }
            "--kind" => {
                let v = it.next().ok_or("--kind requires library|program")?;
                kinds.push(match v.as_str() {
                    "library" => ManifestKind::Library,
                    "program" => ManifestKind::Program,
                    other => {
                        return Err(format!(
                            "--kind {other:?}: must be library or program (source-kind has no archive)"
                        ))
                    }
                });
            }
            "--tag" => tag = Some(it.next().ok_or("--tag requires value")?),
            "--build-timestamp" => {
                build_timestamp = Some(it.next().ok_or("--build-timestamp requires value")?)
            }
            "--build-host" => {
                build_host = Some(it.next().ok_or("--build-host requires value")?)
            }
            "--continue-on-error" => continue_on_error = true,
            other => return Err(format!("unknown arg {other:?}")),
        }
    }

    let staging = staging.ok_or("--staging is required")?;
    let registry = if let Some(r) = registry_root {
        Registry { roots: vec![r] }
    } else {
        Registry::from_env(&repo_root())
    };
    let cache_root = cache_root.unwrap_or_else(default_cache_root);
    let abi = abi.unwrap_or(shared::ABI_VERSION);
    let arches = if arches.is_empty() {
        vec![TargetArch::Wasm32, TargetArch::Wasm64]
    } else {
        arches
    };
    let tag = tag.unwrap_or_else(|| format!("binaries-abi-v{abi}"));
    let build_timestamp =
        build_timestamp.unwrap_or_else(build_manifest::current_utc_iso);
    let build_host = build_host.unwrap_or_else(default_build_host);
    // Default kind set: both library and program. Pass --kind library
    // (or --kind program, repeatable) to narrow.
    let kinds = if kinds.is_empty() {
        vec![ManifestKind::Library, ManifestKind::Program]
    } else {
        kinds
    };

    fs::create_dir_all(staging.join("libs"))
        .map_err(|e| format!("mkdir staging/libs: {e}"))?;
    fs::create_dir_all(staging.join("programs"))
        .map_err(|e| format!("mkdir staging/programs: {e}"))?;

    // Track per-manifest failures so we can decide pass/fail based
    // on whether EVERY arch failed (fatal) vs SOME (warn-only).
    let mut errors: BTreeMap<String, Vec<(TargetArch, String)>> = BTreeMap::new();

    for (_, m) in registry.walk_all()? {
        if !kinds.contains(&m.kind) {
            continue;
        }
        // Skip metadata-only manifests: kind=program entries that lack
        // a build script (the script file isn't on disk). These were
        // added in Chunk B as composite-VFS / bundle-program lookup
        // satisfiers (kernel, userspace, examples, shell, lamp, node,
        // wordpress, lsof, nginx, sqlite-cli, curl-the-program, etc.)
        // and aren't real the producer-ready packages — they don't
        // produce a buildable archive. Silently skip rather than
        // emitting a noisy WARN per arch.
        if matches!(m.kind, ManifestKind::Program) {
            let script_name = m
                .build
                .script
                .clone()
                .unwrap_or_else(|| format!("build-{}.sh", m.name));
            let script_path = m.dir.join(&script_name);
            if !script_path.is_file() {
                eprintln!(
                    "skip {} (metadata-only manifest, no build script)",
                    m.name
                );
                continue;
            }
        }
        for &arch in &arches {
            // Honor the manifest's per-arch opt-in: a manifest that
            // doesn't list this arch in `target_arches` is silently
            // skipped. The field defaults to `["wasm32"]`, so most
            // manifests stage only wasm32 and only mariadb / mariadb-vfs /
            // php (which carry an explicit `arches = ["wasm32", "wasm64"]`)
            // produce a wasm64 archive.
            if !m.target_arches.contains(&arch) {
                eprintln!(
                    "skip {} {} (manifest target_arches = {:?})",
                    m.name,
                    arch.as_str(),
                    m.target_arches.iter().map(|a| a.as_str()).collect::<Vec<_>>()
                );
                continue;
            }
            match stage_one(
                &m,
                &registry,
                arch,
                abi,
                &cache_root,
                &staging,
                &build_timestamp,
                &build_host,
            ) {
                Ok(archive_path) => {
                    eprintln!("staged {}", archive_path.display());
                }
                Err(e) => {
                    eprintln!("WARN {} {}: {e}", m.name, arch.as_str());
                    errors.entry(m.name.clone()).or_default().push((arch, e));
                }
            }
        }
    }

    // Generate manifest.json by delegating to build_manifest. This
    // catalogs whichever archives actually landed in staging — an
    // arch that warn-skipped won't appear in the manifest.
    let mut manifest_args = vec![
        "--in".into(),
        staging.display().to_string(),
        "--out".into(),
        staging.join("manifest.json").display().to_string(),
        "--tag".into(),
        tag.clone(),
        "--abi".into(),
        abi.to_string(),
    ];
    if let Some(r) = registry.roots.first() {
        manifest_args.push("--registry".into());
        manifest_args.push(r.display().to_string());
    }
    for &arch in &arches {
        manifest_args.push("--arch".into());
        manifest_args.push(arch.as_str().to_string());
    }
    build_manifest::run(manifest_args)?;

    // Decide pass/fail. Without --continue-on-error, treat a manifest
    // that failed every requested arch as fatal; partial failures are
    // still just warnings (already logged above).
    if !errors.is_empty() && !continue_on_error {
        let total = arches.len();
        let total_failures: Vec<&str> = errors
            .iter()
            .filter(|(_, v)| v.len() == total)
            .map(|(k, _)| k.as_str())
            .collect();
        if !total_failures.is_empty() {
            return Err(format!(
                "stage-release: {} manifest(s) failed every requested arch — \
                 see WARN logs above. Failed: {}",
                total_failures.len(),
                total_failures.join(", "),
            ));
        }
    }

    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn stage_one(
    m: &DepsManifest,
    registry: &Registry,
    arch: TargetArch,
    abi: u32,
    cache_root: &Path,
    staging: &Path,
    build_timestamp: &str,
    build_host: &str,
) -> Result<PathBuf, String> {
    // Compute the cache-key sha so we know what filename to stage
    // under and what to inject into the [compatibility] block.
    // Each call gets a fresh memo; the legacy memo bug surfaced in E.3
    // showed memos must not cross arch boundaries.
    let mut chain: Vec<String> = Vec::new();
    let mut memo: BTreeMap<String, [u8; 32]> = BTreeMap::new();
    let sha = build_deps::compute_sha(m, registry, arch, abi, &mut memo, &mut chain)
        .map_err(|e| format!("compute_sha: {e}"))?;
    let sha_hex = hex(&sha);
    let short = &sha_hex[..8];
    // Filename slots: <name>-<v>-rev<N>-abi<N>-<arch>-<short_sha>.tar.zst.
    // The cache_key_sha already mixes the ABI in as a hash input (so
    // <short_sha> changes when ABI changes), but encoding it in the
    // filename too is human-readable redundancy: a glance at the cache
    // dir or release page tells you which ABI generation each entry
    // belongs to.
    let archive_name = format!(
        "{}-{}-rev{}-abi{}-{}-{}.tar.zst",
        m.name,
        m.version,
        m.revision,
        abi,
        arch.as_str(),
        short,
    );

    let subdir = match m.kind {
        ManifestKind::Library => "libs",
        ManifestKind::Program => "programs",
        ManifestKind::Source => {
            return Err("stage_one called on non-library/program kind".into())
        }
    };
    let archive_path = staging.join(subdir).join(&archive_name);
    if archive_path.exists() {
        // Already staged; idempotent re-run.
        return Ok(archive_path);
    }

    // Resolve / build the cache entry. Local-libs override is
    // deliberately not exposed here — staging must reproduce from
    // sources, never from a developer's in-progress checkout.
    let resolve_opts = ResolveOpts {
        cache_root,
        local_libs: None,
    };
    let cache_path = build_deps::ensure_built(m, registry, arch, abi, &resolve_opts)
        .map_err(|e| format!("ensure_built: {e}"))?;

    let opts = StageOptions {
        cache_key_sha: sha_hex,
        build_timestamp: build_timestamp.into(),
        build_host: build_host.into(),
    };
    archive_stage::stage_archive_with_options(m, arch, abi, &cache_path, &archive_path, &opts)
        .map_err(|e| format!("archive_stage: {e}"))?;
    Ok(archive_path)
}

/// Lowercased `<os>-<arch>` derived from Rust's compile-time
/// constants — e.g. `macos-aarch64` on Apple Silicon, `linux-x86_64`
/// on Linux x86_64. Free-form provenance, not consumed by the
/// resolver. `to_lowercase()` is defensive: both `OS` and `ARCH` are
/// already lowercase today, but the format is documented as
/// "lowercased" so we make that explicit.
fn default_build_host() -> String {
    format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH).to_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tempdir(label: &str) -> PathBuf {
        let p = std::env::temp_dir()
            .join("wpk-xtask-stage-release")
            .join(format!("{label}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    /// Drop a `<name>/deps.toml` + executable build script under
    /// `registry`. The build script writes whatever `body` says
    /// using the standard env-var contract. `outputs_section` is
    /// the `[outputs]` TOML block (caller writes the table).
    fn write_fixture_lib(
        registry: &Path,
        name: &str,
        version: &str,
        body: &str,
        outputs_section: &str,
    ) {
        write_fixture(registry, name, version, "library", &[], body, outputs_section);
    }

    fn write_fixture(
        registry: &Path,
        name: &str,
        version: &str,
        kind: &str,
        depends_on: &[&str],
        body: &str,
        outputs_section: &str,
    ) {
        let lib_dir = registry.join(name);
        fs::create_dir_all(&lib_dir).unwrap();
        let depends = depends_on
            .iter()
            .map(|s| format!("{:?}", s))
            .collect::<Vec<_>>()
            .join(", ");
        let toml = format!(
            r#"
kind = "{kind}"
name = "{name}"
version = "{version}"
revision = 1
depends_on = [{depends}]

[source]
url = "https://example.test/{name}-{version}.tar.gz"
sha256 = "{:0>64}"

[license]
spdx = "TestLicense"

{outputs_section}
"#,
            ""
        );
        fs::write(lib_dir.join("deps.toml"), toml).unwrap();
        let script_path = lib_dir.join(format!("build-{name}.sh"));
        let script = format!("#!/bin/bash\nset -euo pipefail\n{body}\n");
        fs::write(&script_path, script).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut p = fs::metadata(&script_path).unwrap().permissions();
            p.set_mode(0o755);
            fs::set_permissions(&script_path, p).unwrap();
        }
    }

    /// Source-kind fixture with a `[build].script` (so we don't
    /// have to fetch a tarball from a URL). The script just needs
    /// to leave OUT_DIR non-empty.
    fn write_fixture_source(registry: &Path, name: &str, version: &str, body: &str) {
        let lib_dir = registry.join(name);
        fs::create_dir_all(&lib_dir).unwrap();
        let toml = format!(
            r#"
kind = "source"
name = "{name}"
version = "{version}"
revision = 1

[source]
url = "https://example.test/{name}-{version}.tar.gz"
sha256 = "{:0>64}"

[license]
spdx = "TestLicense"

[build]
script = "build-{name}.sh"
"#,
            ""
        );
        fs::write(lib_dir.join("deps.toml"), toml).unwrap();
        let script_path = lib_dir.join(format!("build-{name}.sh"));
        let script = format!("#!/bin/bash\nset -euo pipefail\n{body}\n");
        fs::write(&script_path, script).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut p = fs::metadata(&script_path).unwrap().permissions();
            p.set_mode(0o755);
            fs::set_permissions(&script_path, p).unwrap();
        }
    }

    #[test]
    fn stage_release_produces_archives_and_manifest() {
        let dir = tempdir("e4-produces");
        let registry = dir.join("registry");
        let cache_root = dir.join("cache");
        let staging = dir.join("staging");
        fs::create_dir_all(&registry).unwrap();
        fs::create_dir_all(&cache_root).unwrap();

        write_fixture_lib(
            &registry,
            "z",
            "1.0.0",
            "mkdir -p $WASM_POSIX_DEP_OUT_DIR/lib && echo data > $WASM_POSIX_DEP_OUT_DIR/lib/libZ.a",
            "[outputs]\nlibs = [\"lib/libZ.a\"]\n",
        );

        super::run(vec![
            "--staging".into(),
            staging.display().to_string(),
            "--registry".into(),
            registry.display().to_string(),
            "--cache-root".into(),
            cache_root.display().to_string(),
            "--abi".into(),
            "4".into(),
            "--arch".into(),
            "wasm32".into(),
            "--build-timestamp".into(),
            "2026-04-26T00:00:00Z".into(),
            "--build-host".into(),
            "test-host".into(),
        ])
        .unwrap();

        let archives: Vec<_> = fs::read_dir(staging.join("libs"))
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        assert_eq!(archives.len(), 1, "got: {archives:?}");
        assert!(
            archives[0].starts_with("z-1.0.0-rev1-abi4-wasm32-"),
            "got: {:?}",
            archives[0]
        );
        assert!(archives[0].ends_with(".tar.zst"));

        let manifest_path = staging.join("manifest.json");
        assert!(manifest_path.is_file(), "manifest.json must exist");
        let json: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&manifest_path).unwrap()).unwrap();
        let z = json["entries"]
            .as_array()
            .unwrap()
            .iter()
            .find(|e| e["program"] == "z")
            .expect("z entry must be present");
        assert_eq!(z["compatibility"]["target_arch"], "wasm32");
        assert_eq!(z["compatibility"]["abi_versions"], serde_json::json!([4]));
    }

    #[test]
    fn stage_release_skips_failed_arch() {
        let dir = tempdir("e4-partial-fail");
        let registry = dir.join("registry");
        let cache_root = dir.join("cache");
        let staging = dir.join("staging");
        fs::create_dir_all(&registry).unwrap();
        fs::create_dir_all(&cache_root).unwrap();

        // Build script succeeds for wasm32, fails (exit 1) for wasm64.
        // WASM_POSIX_DEP_TARGET_ARCH is set per ensure_built tests.
        write_fixture_lib(
            &registry,
            "y",
            "1.0.0",
            r#"
if [ "$WASM_POSIX_DEP_TARGET_ARCH" = "wasm64" ]; then
    echo "fail-on-wasm64" >&2
    exit 1
fi
mkdir -p "$WASM_POSIX_DEP_OUT_DIR/lib"
echo data > "$WASM_POSIX_DEP_OUT_DIR/lib/libY.a"
"#,
            "[outputs]\nlibs = [\"lib/libY.a\"]\n",
        );

        // With --continue-on-error and both arches: must Ok().
        super::run(vec![
            "--staging".into(),
            staging.display().to_string(),
            "--registry".into(),
            registry.display().to_string(),
            "--cache-root".into(),
            cache_root.display().to_string(),
            "--abi".into(),
            "4".into(),
            "--arch".into(),
            "wasm32".into(),
            "--arch".into(),
            "wasm64".into(),
            "--continue-on-error".into(),
            "--build-timestamp".into(),
            "2026-04-26T00:00:00Z".into(),
            "--build-host".into(),
            "test-host".into(),
        ])
        .unwrap();

        let archives: Vec<String> = fs::read_dir(staging.join("libs"))
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        assert_eq!(
            archives.len(),
            1,
            "exactly one (wasm32) archive expected, got: {archives:?}"
        );
        assert!(
            archives[0].contains("-wasm32-"),
            "archive must be wasm32, got: {:?}",
            archives[0]
        );
        assert!(
            !archives.iter().any(|n| n.contains("-wasm64-")),
            "wasm64 archive must not be present: {archives:?}"
        );

        let manifest_path = staging.join("manifest.json");
        let json: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&manifest_path).unwrap()).unwrap();
        let y_entries: Vec<_> = json["entries"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|e| e["program"] == "y")
            .collect();
        assert_eq!(y_entries.len(), 1, "exactly one y entry expected");
        assert_eq!(y_entries[0]["compatibility"]["target_arch"], "wasm32");
    }

    #[test]
    fn stage_release_omits_source_kind_manifests() {
        let dir = tempdir("e4-source-omit");
        let registry = dir.join("registry");
        let cache_root = dir.join("cache");
        let staging = dir.join("staging");
        fs::create_dir_all(&registry).unwrap();
        fs::create_dir_all(&cache_root).unwrap();

        write_fixture_source(
            &registry,
            "src-only",
            "1.0.0",
            "echo > $WASM_POSIX_DEP_OUT_DIR/marker",
        );

        super::run(vec![
            "--staging".into(),
            staging.display().to_string(),
            "--registry".into(),
            registry.display().to_string(),
            "--cache-root".into(),
            cache_root.display().to_string(),
            "--abi".into(),
            "4".into(),
            "--arch".into(),
            "wasm32".into(),
            "--build-timestamp".into(),
            "2026-04-26T00:00:00Z".into(),
            "--build-host".into(),
            "test-host".into(),
        ])
        .unwrap();

        // No archive in libs/ or programs/ (source-kind has no archive).
        let libs: Vec<_> = fs::read_dir(staging.join("libs"))
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        let progs: Vec<_> = fs::read_dir(staging.join("programs"))
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        assert!(libs.is_empty(), "no library archives expected: {libs:?}");
        assert!(progs.is_empty(), "no program archives expected: {progs:?}");

        // No source entry in manifest.json.
        let manifest_path = staging.join("manifest.json");
        let json: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&manifest_path).unwrap()).unwrap();
        let src_entries: Vec<_> = json["entries"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|e| e["program"] == "src-only")
            .collect();
        assert!(
            src_entries.is_empty(),
            "source-kind manifest must not appear in manifest.json"
        );
    }

    #[test]
    fn stage_release_total_failure_returns_err_without_continue_on_error() {
        let dir = tempdir("e4-total-fail");
        let registry = dir.join("registry");
        let cache_root = dir.join("cache");
        let staging = dir.join("staging");
        fs::create_dir_all(&registry).unwrap();
        fs::create_dir_all(&cache_root).unwrap();

        write_fixture_lib(
            &registry,
            "broken",
            "1.0.0",
            "echo always-fails >&2; exit 1",
            "[outputs]\nlibs = [\"lib/libBroken.a\"]\n",
        );

        let err = super::run(vec![
            "--staging".into(),
            staging.display().to_string(),
            "--registry".into(),
            registry.display().to_string(),
            "--cache-root".into(),
            cache_root.display().to_string(),
            "--abi".into(),
            "4".into(),
            "--arch".into(),
            "wasm32".into(),
            "--build-timestamp".into(),
            "2026-04-26T00:00:00Z".into(),
            "--build-host".into(),
            "test-host".into(),
        ])
        .expect_err("must return Err when every arch fails for a manifest");
        assert!(
            err.contains("broken"),
            "error must name failed manifest, got: {err}"
        );
        assert!(
            err.contains("every requested arch"),
            "error must mention total-failure semantics, got: {err}"
        );
    }

}
