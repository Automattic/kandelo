//! Expand a `cargo:<crate>` build-input tag into the repo-relative paths
//! that determine that crate's compiled output. This makes the kernel's
//! cache-key inputs derive from Cargo's real dependency graph instead of
//! a hand-maintained list that can silently omit a compile input
//! (e.g. `.cargo/config.toml`, or a newly-added workspace crate).

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::process::Command;

pub(crate) const CARGO_INPUT_PREFIX: &str = "cargo:";

pub(crate) fn cargo_closure_paths(
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
    use std::path::Path;

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
    fn unknown_crate_is_an_error() {
        let repo = crate::repo_root();
        let err = cargo_closure_paths(&repo, "definitely-not-a-crate").unwrap_err();
        assert!(err.contains("definitely-not-a-crate"), "{err}");
    }
}
