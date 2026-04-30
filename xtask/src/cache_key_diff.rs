//! `cache-key-diff` — emit the names of packages whose locally-computed
//! `cache_key_sha` differs from a release manifest's stamped value.
//!
//! Usage:
//!   cargo xtask cache-key-diff --manifest <path/to/manifest.json> [--arch <a>]…
//!
//! Output: a single-line CSV of program names, deterministically sorted,
//! to stdout. Empty when nothing's stale.
//!
//! Designed for the staging-build CI flow: this list is fed to
//! `scripts/fetch-binaries.sh --allow-stale <csv>`, which threads it
//! through to `xtask install-release --allow-stale <csv>`. Mismatches
//! for these names skip with a warning; mismatches for any OTHER name
//! still hard-fail. The same logic that produces this list also drives
//! `stage-pr-overlay`'s build set, so fetch-binaries' skip set and
//! stage-pr-overlay's build set cannot drift apart — see
//! [`crate::stage_pr_overlay::changed_packages`].
//!
//! Filtered set: only names that EXIST in the baseline manifest are
//! emitted. New packages (in the registry but not the manifest) are
//! "changed" by `changed_packages`'s definition, but install-release
//! never iterates them (it walks the manifest's entries[]), so they
//! don't need allowlisting.

use std::collections::BTreeSet;
use std::fs;
use std::path::PathBuf;

use serde_json::Value;
use wasm_posix_shared as shared;

use crate::build_deps::{default_cache_root, parse_target_arch, Registry};
use crate::deps_manifest::TargetArch;
use crate::repo_root;
use crate::stage_pr_overlay;

pub fn run(args: Vec<String>) -> Result<(), String> {
    let csv = compute_csv(args)?;
    println!("{csv}");
    Ok(())
}

/// Inner: parse args + compute the CSV. Split out so tests can assert
/// on the output string without capturing stdout.
pub(crate) fn compute_csv(args: Vec<String>) -> Result<String, String> {
    let mut manifest_path: Option<PathBuf> = None;
    let mut registry_root: Option<PathBuf> = None;
    let mut abi: Option<u32> = None;
    let mut arches: Vec<TargetArch> = Vec::new();

    let mut it = args.into_iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--manifest" => {
                manifest_path = Some(it.next().ok_or("--manifest requires path")?.into())
            }
            "--registry" => {
                registry_root = Some(it.next().ok_or("--registry requires path")?.into())
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
            // Accept (and ignore) --cache-root for symmetry with the
            // sibling subcommands. cache_key_diff doesn't touch the
            // cache — it's a pure compute_sha vs. baseline comparison.
            "--cache-root" => {
                let _ = it.next().ok_or("--cache-root requires path")?;
            }
            other => return Err(format!("unknown arg {other:?}")),
        }
    }

    let manifest_path = manifest_path.ok_or("--manifest is required")?;
    let registry = if let Some(r) = registry_root {
        Registry { roots: vec![r] }
    } else {
        Registry::from_env(&repo_root())
    };
    let abi = abi.unwrap_or(shared::ABI_VERSION);
    let arches = if arches.is_empty() {
        vec![TargetArch::Wasm32]
    } else {
        arches
    };
    // Suppress unused-import warning when default_cache_root isn't
    // exercised — kept in scope so a future refactor that does need a
    // cache root has the same import surface as install_release.
    let _ = default_cache_root;

    let manifest_bytes = fs::read(&manifest_path)
        .map_err(|e| format!("read {}: {e}", manifest_path.display()))?;
    let manifest_json: Value = serde_json::from_slice(&manifest_bytes)
        .map_err(|e| format!("parse {}: {e}", manifest_path.display()))?;
    let baseline_map = stage_pr_overlay::build_baseline_map(&manifest_json);

    let changed = stage_pr_overlay::changed_packages(&registry, &baseline_map, &arches, abi)?;

    // Filter to names that exist in the baseline (drop new packages —
    // see module docstring).
    let mut names: BTreeSet<String> = BTreeSet::new();
    for (name, arch) in changed {
        if baseline_map.contains_key(&(name.clone(), arch.as_str().to_string())) {
            names.insert(name);
        }
    }

    Ok(names.into_iter().collect::<Vec<_>>().join(","))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn tempdir(label: &str) -> PathBuf {
        let p = std::env::temp_dir()
            .join("wpk-xtask-cache-key-diff")
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
        fs::write(lib_dir.join("deps.toml"), toml).unwrap();
        let script_path = lib_dir.join(format!("build-{name}.sh"));
        let script = format!(
            "#!/bin/bash\nset -euo pipefail\nmkdir -p \"$WASM_POSIX_DEP_OUT_DIR/lib\"\n{body}\n"
        );
        fs::write(&script_path, script).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut p = fs::metadata(&script_path).unwrap().permissions();
            p.set_mode(0o755);
            fs::set_permissions(&script_path, p).unwrap();
        }
    }

    /// Stage `registry` once via stage_release to produce a baseline
    /// manifest matching the current state (so subsequent edits show as
    /// "stale"). Returns the baseline manifest path.
    fn stage_baseline(registry: &Path, cache_root: &Path, abi: u32) -> PathBuf {
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
        staging.join("manifest.json")
    }

    fn diff_args(manifest: &Path, registry: &Path, abi: u32) -> Vec<String> {
        vec![
            "--manifest".into(),
            manifest.display().to_string(),
            "--registry".into(),
            registry.display().to_string(),
            "--abi".into(),
            abi.to_string(),
            "--arch".into(),
            "wasm32".into(),
        ]
    }

    #[test]
    fn cache_key_diff_emits_empty_csv_when_nothing_changed() {
        let dir = tempdir("nothing-changed");
        let registry = dir.join("registry");
        let cache_root = dir.join("cache");
        fs::create_dir_all(&registry).unwrap();
        fs::create_dir_all(&cache_root).unwrap();
        write_fixture_lib(
            &registry,
            "z",
            "1.0.0",
            r#"echo data > "$WASM_POSIX_DEP_OUT_DIR/lib/libz.a""#,
        );

        let manifest = stage_baseline(&registry, &cache_root, 4);
        let csv = compute_csv(diff_args(&manifest, &registry, 4)).unwrap();
        assert_eq!(csv, "", "no edits = empty CSV; got {csv:?}");
    }

    #[test]
    fn cache_key_diff_emits_single_changed_name() {
        let dir = tempdir("one-changed");
        let registry = dir.join("registry");
        let cache_root = dir.join("cache");
        fs::create_dir_all(&registry).unwrap();
        fs::create_dir_all(&cache_root).unwrap();
        write_fixture_lib(
            &registry,
            "y",
            "1.0.0",
            r#"echo data > "$WASM_POSIX_DEP_OUT_DIR/lib/liby.a""#,
        );
        write_fixture_lib(
            &registry,
            "z",
            "1.0.0",
            r#"echo data > "$WASM_POSIX_DEP_OUT_DIR/lib/libz.a""#,
        );

        let manifest = stage_baseline(&registry, &cache_root, 4);
        // Bump y's version → its cache_key_sha shifts. z stays.
        write_fixture_lib(
            &registry,
            "y",
            "2.0.0",
            r#"echo data2 > "$WASM_POSIX_DEP_OUT_DIR/lib/liby.a""#,
        );

        let csv = compute_csv(diff_args(&manifest, &registry, 4)).unwrap();
        assert_eq!(csv, "y", "only y changed; got {csv:?}");
    }

    #[test]
    fn cache_key_diff_emits_alphabetical_csv_for_multiple_changes() {
        let dir = tempdir("multi-changed");
        let registry = dir.join("registry");
        let cache_root = dir.join("cache");
        fs::create_dir_all(&registry).unwrap();
        fs::create_dir_all(&cache_root).unwrap();
        for name in ["a", "b", "c"] {
            write_fixture_lib(
                &registry,
                name,
                "1.0.0",
                &format!(
                    r#"echo data > "$WASM_POSIX_DEP_OUT_DIR/lib/lib{name}.a""#
                ),
            );
        }

        let manifest = stage_baseline(&registry, &cache_root, 4);
        // Bump a and c. b stays the same.
        write_fixture_lib(
            &registry,
            "a",
            "2.0.0",
            r#"echo data2 > "$WASM_POSIX_DEP_OUT_DIR/lib/liba.a""#,
        );
        write_fixture_lib(
            &registry,
            "c",
            "2.0.0",
            r#"echo data2 > "$WASM_POSIX_DEP_OUT_DIR/lib/libc.a""#,
        );

        let csv = compute_csv(diff_args(&manifest, &registry, 4)).unwrap();
        assert_eq!(
            csv, "a,c",
            "expected alphabetical CSV of changed names; got {csv:?}"
        );
    }

    #[test]
    fn cache_key_diff_drops_new_packages_not_in_baseline() {
        // A package that's in the registry but NOT in the baseline
        // manifest is "changed" by changed_packages's definition (no
        // baseline entry), but install-release won't iterate it —
        // it's not in the manifest. So it must NOT appear in the CSV
        // (otherwise we'd be telling install-release to allow staleness
        // for an entry it never sees, which is harmless but misleading).
        let dir = tempdir("new-package");
        let registry = dir.join("registry");
        let cache_root = dir.join("cache");
        fs::create_dir_all(&registry).unwrap();
        fs::create_dir_all(&cache_root).unwrap();
        write_fixture_lib(
            &registry,
            "z",
            "1.0.0",
            r#"echo data > "$WASM_POSIX_DEP_OUT_DIR/lib/libz.a""#,
        );

        let manifest = stage_baseline(&registry, &cache_root, 4);
        // Add a brand-new library that the baseline never knew about.
        write_fixture_lib(
            &registry,
            "newcomer",
            "0.1.0",
            r#"echo data > "$WASM_POSIX_DEP_OUT_DIR/lib/libnewcomer.a""#,
        );

        let csv = compute_csv(diff_args(&manifest, &registry, 4)).unwrap();
        assert_eq!(
            csv, "",
            "new-but-unbaselined package must NOT appear in CSV; got {csv:?}"
        );
    }

    #[test]
    fn cache_key_diff_requires_manifest() {
        let err = compute_csv(vec!["--registry".into(), "/tmp".into()]).unwrap_err();
        assert!(err.contains("manifest"), "got: {err}");
    }
}
