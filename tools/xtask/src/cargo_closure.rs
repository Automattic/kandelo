//! Expand a `cargo:<crate>` build-input tag into the repo-relative paths
//! that determine that crate's compiled output. This makes the kernel's
//! cache-key inputs derive from Cargo's real dependency graph instead of
//! a hand-maintained list that can silently omit a compile input
//! (e.g. `.cargo/config.toml`, or a newly-added workspace crate).

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex, OnceLock};

pub(crate) const CARGO_INPUT_PREFIX: &str = "cargo:";

type ClosureMemo = Mutex<HashMap<(PathBuf, String), Result<Arc<Vec<String>>, String>>>;

/// Closure of a workspace crate, computed once per `(repo_root, crate)` for
/// the life of this xtask process.
///
/// WHY: every cache-key computation that reaches a `cargo:` input calls this,
/// and building the program index computes keys for each package, both
/// arches, and every dependency closure, with no sharing between them. With
/// the kernel a `cargo:` input of eight packages that meant 23-140 `cargo
/// metadata` spawns per `program-index-context-ensure`, about 10-12 s per
/// resolver call. The workspace manifest cannot change under one xtask run,
/// so the first answer is the answer for the whole process.
pub(crate) fn cargo_closure_paths(
    repo_root: &Path,
    crate_name: &str,
) -> Result<Vec<String>, String> {
    cargo_closure_paths_shared(repo_root, crate_name).map(|paths| paths.as_ref().clone())
}

fn cargo_closure_paths_shared(
    repo_root: &Path,
    crate_name: &str,
) -> Result<Arc<Vec<String>>, String> {
    static MEMO: OnceLock<ClosureMemo> = OnceLock::new();
    let key = (repo_root.to_path_buf(), crate_name.to_string());
    let memo = MEMO.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some(cached) = memo.lock().map_err(|e| e.to_string())?.get(&key) {
        return cached.clone();
    }
    let computed = compute_cargo_closure_paths(repo_root, crate_name).map(Arc::new);
    memo.lock()
        .map_err(|e| e.to_string())?
        .entry(key)
        .or_insert(computed)
        .clone()
}

fn compute_cargo_closure_paths(
    repo_root: &Path,
    crate_name: &str,
) -> Result<Vec<String>, String> {
    let output = Command::new("cargo")
        .args(["metadata", "--format-version=1", "--locked"])
        .current_dir(repo_root)
        .output()
        .map_err(|e| format!("run cargo metadata for `{crate_name}` closure: {e}"))?;
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
    fn closure_is_computed_once_per_process() {
        let repo = crate::repo_root();
        let first = cargo_closure_paths_shared(&repo, "kandelo").expect("closure");
        let second = cargo_closure_paths_shared(&repo, "kandelo").expect("closure");
        assert!(Arc::ptr_eq(&first, &second), "second call must reuse the first result");
    }

    #[test]
    fn unknown_crate_is_an_error() {
        let repo = crate::repo_root();
        let err = cargo_closure_paths(&repo, "definitely-not-a-crate").unwrap_err();
        assert!(err.contains("definitely-not-a-crate"), "{err}");
    }
}
