//! `stage-pr-overlay` — produce a partial staging directory containing
//! only the archives whose cache_key_sha differs from a baseline durable
//! manifest, plus a `binaries.lock.pr` overlay file.
//!
//! Usage:
//!   cargo xtask stage-pr-overlay \
//!       --baseline-manifest <path/to/durable/manifest.json> \
//!       --staging-tag pr-<NNN>-staging \
//!       --out <staging-dir> \
//!       [--arch wasm32]...
//!
//! Output: `$STAGING/{libs,programs}/<archive>.tar.zst` (only changed) +
//!         `$STAGING/manifest.json` (entries for changed archives only) +
//!         `$STAGING/binaries.lock.pr` (overlay).
//!
//! No archives produced means no changes — exits 0 with empty staging
//! plus an overlay file whose `overrides` array is empty. The CI
//! workflow detects this and skips the upload step.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::PathBuf;

use serde_json::Value;
use sha2::{Digest, Sha256};
use wasm_posix_shared as shared;

use crate::build_deps::{self, default_cache_root, parse_target_arch, Registry};
use crate::build_manifest;
use crate::pkg_manifest::{ManifestKind, TargetArch};
use crate::repo_root;
use crate::stage_release;
use crate::util::hex;

pub fn run(args: Vec<String>) -> Result<(), String> {
    let mut baseline_manifest: Option<PathBuf> = None;
    let mut staging_tag: Option<String> = None;
    let mut out: Option<PathBuf> = None;
    let mut registry_root: Option<PathBuf> = None;
    let mut cache_root: Option<PathBuf> = None;
    let mut abi: Option<u32> = None;
    let mut arches: Vec<TargetArch> = Vec::new();
    let mut continue_on_error = false;
    // Force-rebuild: treat the named manifests as changed-vs-baseline
    // even when cache_key_sha matches, AND source-build them inside
    // stage_one (bypassing cache hits + `[binary]` remote fetch).
    // `--force-rebuild-all` populates the set from every walked
    // library/program manifest. Useful for local PR-staging dry runs
    // when the maintainer suspects the resolver's cache view is stale.
    let mut force_rebuild_names: BTreeSet<String> = BTreeSet::new();
    let mut force_rebuild_all = false;

    let mut it = args.into_iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--baseline-manifest" => {
                baseline_manifest = Some(
                    it.next()
                        .ok_or("--baseline-manifest requires path")?
                        .into(),
                )
            }
            "--staging-tag" => {
                staging_tag = Some(it.next().ok_or("--staging-tag requires value")?)
            }
            "--out" => out = Some(it.next().ok_or("--out requires path")?.into()),
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
            "--arch" => arches.push(parse_target_arch(
                &it.next().ok_or("--arch requires wasm32|wasm64")?,
            )?),
            "--continue-on-error" => continue_on_error = true,
            "--force-rebuild" => {
                force_rebuild_names
                    .insert(it.next().ok_or("--force-rebuild requires <name>")?);
            }
            "--force-rebuild-all" => force_rebuild_all = true,
            other => return Err(format!("unknown arg {other:?}")),
        }
    }

    let baseline_manifest = baseline_manifest.ok_or("--baseline-manifest is required")?;
    let staging_tag = staging_tag.ok_or("--staging-tag is required")?;
    if !staging_tag.starts_with("pr-") || !staging_tag.ends_with("-staging") {
        return Err(format!(
            "--staging-tag {staging_tag:?} must match pr-<NNN>-staging"
        ));
    }
    let out = out.ok_or("--out is required")?;
    let registry = if let Some(r) = registry_root {
        Registry { roots: vec![r] }
    } else {
        Registry::from_env(&repo_root())
    };
    let cache_root = cache_root.unwrap_or_else(default_cache_root);
    let abi = abi.unwrap_or(shared::ABI_VERSION);
    let arches = if arches.is_empty() {
        vec![TargetArch::Wasm32]
    } else {
        arches
    };

    fs::create_dir_all(out.join("libs")).map_err(|e| format!("mkdir staging/libs: {e}"))?;
    fs::create_dir_all(out.join("programs"))
        .map_err(|e| format!("mkdir staging/programs: {e}"))?;
    // Clear any pre-existing overlay artifacts so build_manifest doesn't
    // try to parse them as archive entries on a re-run.
    let _ = fs::remove_file(out.join("binaries.lock.pr"));
    let _ = fs::remove_file(out.join("manifest.json"));

    // --- Read baseline manifest, build (program, arch) -> cache_key_sha map.
    let baseline_bytes = fs::read(&baseline_manifest)
        .map_err(|e| format!("read {}: {e}", baseline_manifest.display()))?;
    let baseline_json: Value = serde_json::from_slice(&baseline_bytes)
        .map_err(|e| format!("parse {}: {e}", baseline_manifest.display()))?;
    let baseline_map = build_baseline_map(&baseline_json);

    // --- Walk registry, decide which (manifest, arch) pairs changed.
    let timestamp = build_manifest::current_utc_iso();
    let host = stage_release::default_build_host();
    let mut overrides: BTreeSet<String> = BTreeSet::new();

    let walked = registry.walk_all()?;
    if force_rebuild_all {
        for (_, m) in &walked {
            if matches!(m.kind, ManifestKind::Library | ManifestKind::Program) {
                force_rebuild_names.insert(m.name.clone());
            }
        }
    }
    let force_source_build: Option<&BTreeSet<String>> =
        if force_rebuild_names.is_empty() {
            None
        } else {
            eprintln!(
                "force-rebuild: source-building {} manifest(s): {}",
                force_rebuild_names.len(),
                force_rebuild_names.iter().cloned().collect::<Vec<_>>().join(", "),
            );
            Some(&force_rebuild_names)
        };

    for (_, m) in walked {
        if !matches!(m.kind, ManifestKind::Library | ManifestKind::Program) {
            continue;
        }
        // Skip metadata-only manifests (no build script on disk).
        // Mirrors stage_release::run.
        if matches!(m.kind, ManifestKind::Program) {
            // Phase A-bis Task 2: delegate to `build_script_path()` so
            // the repo-root-vs-package-dir resolution rules stay in
            // one place. Mirrors `stage_release::run`.
            let script_path = m.build_script_path(&repo_root());
            if !script_path.is_file() {
                continue;
            }
        }
        for &arch in &arches {
            if !m.target_arches.contains(&arch) {
                continue;
            }
            // Compute fresh memo per arch (same pattern as stage_release).
            let mut chain: Vec<String> = Vec::new();
            let mut memo: BTreeMap<String, [u8; 32]> = BTreeMap::new();
            let sha = build_deps::compute_sha(&m, &registry, arch, abi, &mut memo, &mut chain)
                .map_err(|e| format!("compute_sha for {} {:?}: {e}", m.name, arch.as_str()))?;
            let sha_hex = hex(&sha);

            let baseline_sha = baseline_map.get(&(m.name.clone(), arch.as_str().to_string()));
            let changed = match baseline_sha {
                Some(b) => *b != sha_hex,
                None => true,
            };
            // Force-listed packages are treated as changed even when
            // cache_key_sha matches baseline — the whole point is to
            // surface a fresh archive against the maintainer's
            // suspicion that the cached one is wrong.
            let force_this = force_source_build
                .map(|s| s.contains(&m.name))
                .unwrap_or(false);
            if !changed && !force_this {
                continue;
            }

            // Stage this archive. force_source_build (if any) makes
            // stage_one source-build instead of resolving from cache
            // or remote `[binary]`.
            match stage_release::stage_one(
                &m,
                &registry,
                arch,
                abi,
                &cache_root,
                &out,
                &timestamp,
                &host,
                force_source_build,
            ) {
                Ok(archive_path) => {
                    eprintln!("staged {}", archive_path.display());
                    overrides.insert(m.name.clone());
                }
                Err(e) => {
                    if continue_on_error {
                        eprintln!(
                            "WARN stage_one {} {}: {e} — continuing under --continue-on-error",
                            m.name,
                            arch.as_str()
                        );
                    } else {
                        return Err(format!(
                            "stage_one {} {}: {e}",
                            m.name,
                            arch.as_str()
                        ));
                    }
                }
            }
        }
    }

    // --- Generate manifest.json (only for archives that landed in $out).
    let manifest_path = out.join("manifest.json");
    let mut manifest_args: Vec<String> = vec![
        "--in".into(),
        out.display().to_string(),
        "--out".into(),
        manifest_path.display().to_string(),
        "--tag".into(),
        staging_tag.clone(),
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

    // --- Compute manifest sha256 + write binaries.lock.pr overlay.
    let manifest_bytes = fs::read(&manifest_path)
        .map_err(|e| format!("read {}: {e}", manifest_path.display()))?;
    let mut hasher = Sha256::new();
    hasher.update(&manifest_bytes);
    let digest = hasher.finalize();
    let manifest_sha = hex(digest.as_slice());

    let overrides_vec: Vec<String> = overrides.iter().cloned().collect();
    let overlay = serde_json::json!({
        "staging_tag": staging_tag,
        "staging_manifest_sha256": manifest_sha,
        "overrides": overrides_vec,
    });
    let overlay_path = out.join("binaries.lock.pr");
    let overlay_str = serde_json::to_string_pretty(&overlay)
        .map_err(|e| format!("serialize overlay: {e}"))?;
    fs::write(&overlay_path, format!("{overlay_str}\n"))
        .map_err(|e| format!("write {}: {e}", overlay_path.display()))?;

    println!(
        "stage-pr-overlay: {} override(s) ({})",
        overrides_vec.len(),
        if overrides_vec.is_empty() {
            "no rebuild needed".to_string()
        } else {
            overrides_vec.join(", ")
        }
    );
    Ok(())
}

/// Walk the baseline manifest's `entries` array, build a lookup from
/// (program-name, arch) to `cache_key_sha` (hex string).
fn build_baseline_map(manifest: &Value) -> BTreeMap<(String, String), String> {
    let mut map: BTreeMap<(String, String), String> = BTreeMap::new();
    let entries = match manifest.get("entries").and_then(|v| v.as_array()) {
        Some(e) => e,
        None => return map,
    };
    for e in entries {
        let program = match e.get("program").and_then(|v| v.as_str()) {
            Some(p) => p.to_string(),
            None => continue,
        };
        let arch = match e.get("arch").and_then(|v| v.as_str()) {
            Some(a) => a.to_string(),
            None => continue,
        };
        let sha = match e
            .get("compatibility")
            .and_then(|c| c.get("cache_key_sha"))
            .and_then(|v| v.as_str())
        {
            Some(s) => s.to_string(),
            None => continue,
        };
        map.insert((program, arch), sha);
    }
    map
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn tempdir(label: &str) -> PathBuf {
        let p = std::env::temp_dir()
            .join("wpk-xtask-stage-pr-overlay")
            .join(format!("{label}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    fn write_fixture_lib(registry: &Path, name: &str, version: &str, body: &str) {
        let lib_dir = registry.join(name);
        fs::create_dir_all(&lib_dir).unwrap();
        let toml = format!(
            r#"
kind = "library"
name = "{name}"
version = "{version}"
revision = 1
depends_on = []

[source]
url = "https://example.test/{name}-{version}.tar.gz"
sha256 = "{:0>64}"

[license]
spdx = "TestLicense"

[outputs]
libs = ["lib/lib{name}.a"]
"#,
            ""
        );
        fs::write(lib_dir.join("package.toml"), toml).unwrap();
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

    /// Stage the registry once via stage_release::run to produce a
    /// "baseline" manifest that mimics a durable release.
    fn stage_baseline(
        registry: &Path,
        cache_root: &Path,
        abi: u32,
    ) -> (PathBuf, serde_json::Value) {
        let staging = registry.parent().unwrap().join("baseline-staging");
        crate::stage_release::run(vec![
            "--staging".into(),
            staging.display().to_string(),
            "--registry".into(),
            registry.display().to_string(),
            "--cache-root".into(),
            cache_root.display().to_string(),
            "--abi".into(),
            abi.to_string(),
            "--arch".into(),
            "wasm32".into(),
            "--build-timestamp".into(),
            "2026-04-26T00:00:00Z".into(),
            "--build-host".into(),
            "test-host".into(),
        ])
        .unwrap();
        let manifest_path = staging.join("manifest.json");
        let manifest: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&manifest_path).unwrap()).unwrap();
        (manifest_path, manifest)
    }

    #[test]
    fn stage_pr_overlay_skips_unchanged_packages() {
        let dir = tempdir("unchanged");
        let registry = dir.join("registry");
        let cache_root = dir.join("cache");
        fs::create_dir_all(&registry).unwrap();
        fs::create_dir_all(&cache_root).unwrap();

        write_fixture_lib(
            &registry,
            "z",
            "1.0.0",
            r#"mkdir -p "$WASM_POSIX_DEP_OUT_DIR/lib"
echo data > "$WASM_POSIX_DEP_OUT_DIR/lib/libz.a""#,
        );

        let (baseline_manifest, _) = stage_baseline(&registry, &cache_root, 4);

        let pr_out = dir.join("pr-staging");
        super::run(vec![
            "--baseline-manifest".into(),
            baseline_manifest.display().to_string(),
            "--staging-tag".into(),
            "pr-42-staging".into(),
            "--out".into(),
            pr_out.display().to_string(),
            "--registry".into(),
            registry.display().to_string(),
            "--cache-root".into(),
            cache_root.display().to_string(),
            "--abi".into(),
            "4".into(),
            "--arch".into(),
            "wasm32".into(),
        ])
        .unwrap();

        // No archives in the staging output (cache_key_sha unchanged).
        let libs: Vec<_> = fs::read_dir(pr_out.join("libs"))
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        assert!(libs.is_empty(), "expected no libs, got: {libs:?}");

        // Overlay file exists with empty overrides.
        let overlay: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(pr_out.join("binaries.lock.pr")).unwrap(),
        )
        .unwrap();
        assert_eq!(overlay["staging_tag"], "pr-42-staging");
        assert_eq!(overlay["overrides"], serde_json::json!([]));
    }

    #[test]
    fn stage_pr_overlay_includes_changed_package() {
        let dir = tempdir("changed");
        let registry = dir.join("registry");
        let cache_root = dir.join("cache");
        fs::create_dir_all(&registry).unwrap();
        fs::create_dir_all(&cache_root).unwrap();

        // Initial: z and y libraries.
        write_fixture_lib(
            &registry,
            "z",
            "1.0.0",
            r#"mkdir -p "$WASM_POSIX_DEP_OUT_DIR/lib"; echo data > "$WASM_POSIX_DEP_OUT_DIR/lib/libz.a""#,
        );
        write_fixture_lib(
            &registry,
            "y",
            "1.0.0",
            r#"mkdir -p "$WASM_POSIX_DEP_OUT_DIR/lib"; echo data > "$WASM_POSIX_DEP_OUT_DIR/lib/liby.a""#,
        );

        let (baseline_manifest, _) = stage_baseline(&registry, &cache_root, 4);

        // Bump y's version → cache_key_sha changes.
        write_fixture_lib(
            &registry,
            "y",
            "2.0.0",
            r#"mkdir -p "$WASM_POSIX_DEP_OUT_DIR/lib"; echo data2 > "$WASM_POSIX_DEP_OUT_DIR/lib/liby.a""#,
        );

        let pr_out = dir.join("pr-staging");
        super::run(vec![
            "--baseline-manifest".into(),
            baseline_manifest.display().to_string(),
            "--staging-tag".into(),
            "pr-99-staging".into(),
            "--out".into(),
            pr_out.display().to_string(),
            "--registry".into(),
            registry.display().to_string(),
            "--cache-root".into(),
            cache_root.display().to_string(),
            "--abi".into(),
            "4".into(),
            "--arch".into(),
            "wasm32".into(),
        ])
        .unwrap();

        // Exactly one archive (y) in libs/.
        let libs: Vec<_> = fs::read_dir(pr_out.join("libs"))
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        assert_eq!(libs.len(), 1, "expected only y archive, got: {libs:?}");
        assert!(
            libs[0].starts_with("y-2.0.0-rev1-abi4-wasm32-"),
            "got: {:?}",
            libs[0]
        );

        // Overlay lists y as override.
        let overlay: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(pr_out.join("binaries.lock.pr")).unwrap(),
        )
        .unwrap();
        assert_eq!(overlay["staging_tag"], "pr-99-staging");
        assert_eq!(overlay["overrides"], serde_json::json!(["y"]));

        // Manifest.json contains exactly one entry for y.
        let manifest: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(pr_out.join("manifest.json")).unwrap(),
        )
        .unwrap();
        let entries = manifest["entries"].as_array().unwrap();
        assert_eq!(entries.len(), 1, "got: {entries:?}");
        assert_eq!(entries[0]["program"], "y");
        assert_eq!(manifest["release_tag"], "pr-99-staging");

        // Manifest sha in overlay matches the file we wrote.
        let mut hasher = Sha256::new();
        hasher.update(&fs::read(pr_out.join("manifest.json")).unwrap());
        let digest = hasher.finalize();
        let actual_sha = hex(digest.as_slice());
        assert_eq!(overlay["staging_manifest_sha256"], actual_sha);
    }

    #[test]
    fn stage_pr_overlay_force_rebuild_stages_unchanged_package() {
        // Sanity case (without force) is `stage_pr_overlay_skips_unchanged_packages`:
        // an unchanged-vs-baseline package is skipped. With
        // `--force-rebuild z`, the same unchanged package must still
        // get staged (treated as changed) AND the resolver must
        // source-build it (counter increments past the baseline run).
        let dir = tempdir("force-rebuild");
        let registry = dir.join("registry");
        let cache_root = dir.join("cache");
        fs::create_dir_all(&registry).unwrap();
        fs::create_dir_all(&cache_root).unwrap();

        // Counter file in registry root tracks build-script invocations.
        let counter_path = registry.join("counter");
        write_fixture_lib(
            &registry,
            "z",
            "1.0.0",
            &format!(
                r#"echo ran >> "{}"
mkdir -p "$WASM_POSIX_DEP_OUT_DIR/lib"
echo data > "$WASM_POSIX_DEP_OUT_DIR/lib/libz.a""#,
                counter_path.display(),
            ),
        );

        // Baseline run populates the cache (counter=1).
        let (baseline_manifest, _) = stage_baseline(&registry, &cache_root, 4);
        let runs_after_baseline = fs::read_to_string(&counter_path)
            .unwrap()
            .lines()
            .count();
        assert_eq!(runs_after_baseline, 1);

        // PR overlay run with --force-rebuild z → must re-stage even
        // though cache_key_sha is identical to baseline.
        let pr_out = dir.join("pr-staging");
        super::run(vec![
            "--baseline-manifest".into(),
            baseline_manifest.display().to_string(),
            "--staging-tag".into(),
            "pr-7-staging".into(),
            "--out".into(),
            pr_out.display().to_string(),
            "--registry".into(),
            registry.display().to_string(),
            "--cache-root".into(),
            cache_root.display().to_string(),
            "--abi".into(),
            "4".into(),
            "--arch".into(),
            "wasm32".into(),
            "--force-rebuild".into(),
            "z".into(),
        ])
        .unwrap();

        // Build script ran a second time (force bypassed cache hit).
        let runs_after_force = fs::read_to_string(&counter_path)
            .unwrap()
            .lines()
            .count();
        assert_eq!(
            runs_after_force, 2,
            "force-rebuild must re-run the build script"
        );

        // Archive landed in libs/ and overlay lists z as an override.
        let libs: Vec<_> = fs::read_dir(pr_out.join("libs"))
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        assert_eq!(libs.len(), 1, "expected one z archive, got: {libs:?}");
        let overlay: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(pr_out.join("binaries.lock.pr")).unwrap(),
        )
        .unwrap();
        assert_eq!(overlay["overrides"], serde_json::json!(["z"]));
    }
}
