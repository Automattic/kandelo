//! Expand a `cargo:<crate>` build-input tag into the repo-relative paths
//! that determine that crate's compiled output. This makes the kernel's
//! cache-key inputs derive from Cargo's real dependency graph instead of
//! a hand-maintained list that can silently omit a compile input
//! (e.g. `.cargo/config.toml`, or a newly-added workspace crate).

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::{Arc, Mutex, OnceLock};

pub(crate) const CARGO_INPUT_PREFIX: &str = "cargo:";

/// The one `cargo metadata` invocation every cache-key consumer reads. It is
/// deliberately not `--filter-platform`ed: see
/// `build_deps::fork_instrument_cargo_dependency_digest`.
pub(crate) const CARGO_METADATA_ARGS: &[&str] = &["metadata", "--format-version=1", "--locked"];

/// Run `cargo metadata` for `repo_root` at most once per process.
///
/// WHY: every fork-instrumented program's cache key needs both the
/// fork-instrument crate closure and its dependency digest, and each used to
/// spawn its own `cargo metadata`. With two dozen such packages that was 48
/// spawns — about five seconds of CPU — per program-index freshness proof,
/// and the host resolver runs that proof on every `resolveBinary` of a
/// program, so every conformance test and every Vitest guest paid it again.
///
/// Cargo's graph cannot change inside one xtask process: `--locked` forbids
/// lockfile rewrites and nothing here edits a manifest. The first successful
/// answer is therefore the answer for the rest of the process. The lock is
/// held across the spawn so concurrent callers share one run. A failed run is
/// not cached, so its error surfaces on every call.
pub(crate) fn cargo_metadata_output(repo_root: &Path) -> Result<Arc<Output>, String> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, Arc<Output>>>> = OnceLock::new();
    let mut cache = CACHE
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(hit) = cache.get(repo_root) {
        return Ok(Arc::clone(hit));
    }
    let output = Arc::new(
        Command::new("cargo")
            .args(CARGO_METADATA_ARGS)
            .current_dir(repo_root)
            .output()
            .map_err(|e| format!("run cargo metadata in {}: {e}", repo_root.display()))?,
    );
    if output.status.success() {
        cache.insert(repo_root.to_path_buf(), Arc::clone(&output));
    }
    Ok(output)
}

pub(crate) fn cargo_closure_paths(
    repo_root: &Path,
    crate_name: &str,
) -> Result<Vec<String>, String> {
    let output = cargo_metadata_output(repo_root)
        .map_err(|e| format!("`{crate_name}` closure: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "cargo metadata for `{crate_name}` closure failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    let meta: serde_json::Value = serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("parse cargo metadata json: {e}"))?;

    let packages = meta
        .get("packages")
        .and_then(|v| v.as_array())
        .ok_or("cargo metadata: missing packages array")?;
    let workspace_members: BTreeSet<&str> = meta
        .get("workspace_members")
        .and_then(|v| v.as_array())
        .ok_or("cargo metadata: missing workspace_members")?
        .iter()
        .filter_map(|v| v.as_str())
        .collect();

    // id -> (name, manifest_path, [dependency names]) for workspace members only.
    let mut by_name: BTreeMap<&str, (&str, &str, Vec<&str>)> = BTreeMap::new();
    for pkg in packages {
        let id = pkg.get("id").and_then(|v| v.as_str()).unwrap_or_default();
        if !workspace_members.contains(id) {
            continue;
        }
        let name = pkg.get("name").and_then(|v| v.as_str()).unwrap_or_default();
        let manifest = pkg
            .get("manifest_path")
            .and_then(|v| v.as_str())
            .unwrap_or_default();
        let deps = pkg
            .get("dependencies")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|d| d.get("name").and_then(|v| v.as_str()))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        by_name.insert(name, (name, manifest, deps));
    }

    if !by_name.contains_key(crate_name) {
        return Err(format!(
            "`{crate_name}` is not a workspace member (cargo:<crate> requires a workspace crate)"
        ));
    }

    // BFS the transitive workspace-local dependency closure.
    let mut seen: BTreeSet<&str> = BTreeSet::new();
    let mut queue = vec![crate_name];
    let mut dirs: BTreeSet<String> = BTreeSet::new();
    while let Some(name) = queue.pop() {
        if !seen.insert(name) {
            continue;
        }
        let Some((_, manifest, deps)) = by_name.get(name) else {
            continue; // registry crate: covered by Cargo.lock elsewhere
        };
        let dir = crate_dir_relative(repo_root, manifest)?;
        dirs.insert(dir);
        for dep in deps {
            if by_name.contains_key(dep) {
                queue.push(dep);
            }
        }
    }

    // `.cargo/config.toml` governs codegen/link flags but is not a graph
    // node — the exact input omitted today. Include it when present.
    if repo_root.join(".cargo/config.toml").exists() {
        dirs.insert(".cargo/config.toml".to_string());
    }

    Ok(dirs.into_iter().collect())
}

fn crate_dir_relative(repo_root: &Path, manifest_path: &str) -> Result<String, String> {
    let manifest = Path::new(manifest_path);
    let dir = manifest
        .parent()
        .ok_or_else(|| format!("manifest has no parent dir: {manifest_path}"))?;
    let rel = dir
        .strip_prefix(repo_root)
        .map_err(|_| format!("crate dir {} is outside repo root {}", dir.display(), repo_root.display()))?;
    Ok(rel.to_string_lossy().replace('\\', "/"))
}

#[cfg(test)]
mod tests {
    use super::*;

    // Uses the real checked-in workspace so `cargo metadata` resolves the
    // kernel crate ("kandelo") and its workspace path-deps.
    #[test]
    fn kandelo_closure_includes_runtime_core_shared_and_cargo_config() {
        let repo = crate::repo_root();
        let paths = cargo_closure_paths(&repo, "kandelo").expect("closure");
        assert!(paths.iter().any(|p| p == "crates/kernel"), "kernel dir: {paths:?}");
        assert!(paths.iter().any(|p| p == "crates/runtime-core"), "runtime-core dir: {paths:?}");
        assert!(paths.iter().any(|p| p == "crates/shared"), "shared dir: {paths:?}");
        assert!(paths.iter().any(|p| p == ".cargo/config.toml"), "cargo config: {paths:?}");
        // sorted + deduped
        let mut sorted = paths.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(paths, sorted, "must be sorted and deduped");
    }

    #[test]
    fn cargo_metadata_runs_once_per_repo_root() {
        let repo = crate::repo_root();
        let first = cargo_metadata_output(&repo).expect("metadata");
        let second = cargo_metadata_output(&repo).expect("metadata");
        assert!(first.status.success());
        assert!(
            Arc::ptr_eq(&first, &second),
            "a second request for the same workspace must reuse the first run"
        );
    }

    #[test]
    fn unknown_crate_is_an_error() {
        let repo = crate::repo_root();
        let err = cargo_closure_paths(&repo, "definitely-not-a-crate").unwrap_err();
        assert!(err.contains("definitely-not-a-crate"), "{err}");
    }
}
