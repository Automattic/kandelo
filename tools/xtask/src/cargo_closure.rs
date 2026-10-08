//! Expand a `cargo:<crate>` build-input tag into the repo-relative paths
//! that determine that crate's compiled output. This makes the kernel's
//! cache-key inputs derive from Cargo's real dependency graph instead of
//! a hand-maintained list that can silently omit a compile input
//! (e.g. `.cargo/config.toml`, or a newly-added workspace crate).

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::{Arc, Mutex, OnceLock};

use sha2::{Digest, Sha256};

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

/// Content digest over the union of the cargo dependency closures of
/// `crate_names` -- the same directory-level, `cargo metadata`-derived
/// closure `cargo_closure_paths` computes for a single crate (see the
/// module doc above), extended to cover several crates at once.
///
/// This exists for build artifacts that are NOT registered in the package
/// resolver (so they have no `build.toml` `inputs` list to derive a
/// resolver cache key from) but still need a drift-proof, closure-derived
/// freshness fingerprint instead of a hand-maintained file list -- the same
/// anti-pattern `cargo:<crate>` build.toml inputs already close for
/// resolver-registered packages. The side modules in
/// `local_build::CORESIDENT_SIDE_MODULES` (today only the VFS image writer,
/// `crates/kandelo-image-module`) reach it through [`side_module_build_key`].
///
/// Deterministic and order-independent: paths are deduped and sorted before
/// hashing, and each path's digest is folded in as a length-prefixed
/// `(path, content-digest)` pair so no concatenation ambiguity is possible.
pub(crate) fn workspace_crates_closure_sha(
    repo_root: &Path,
    crate_names: &[String],
) -> Result<[u8; 32], String> {
    if crate_names.is_empty() {
        return Err("workspace-closure-sha: at least one crate name is required".to_string());
    }
    let mut paths: BTreeSet<String> = BTreeSet::new();
    for name in crate_names {
        for rel in cargo_closure_paths(repo_root, name)? {
            paths.insert(rel);
        }
    }
    let mut h = Sha256::new();
    h.update(b"kandelo-workspace-crates-closure-v1\0");
    for rel in &paths {
        let digest = crate::build_deps::hash_build_input(&repo_root.join(rel))?;
        h.update((rel.len() as u64).to_le_bytes());
        h.update(rel.as_bytes());
        h.update(digest);
    }
    Ok(h.finalize().into())
}

/// The full build key for a side module: its crate closure, folded together
/// with the recipe that turns that closure into bytes.
///
/// WHY THE RECIPE IS IN THE KEY. `workspace_crates_closure_sha` walks the crate
/// graph, which is the right answer for source changes and the wrong one for
/// RECIPE changes. A build script's `opt-level`, its wasm-opt pass and its
/// target features decide the artifact's bytes just as surely as the Rust does,
/// and none of them appear in the crate closure. Without the fold, editing a
/// build script leaves every staged copy stale while the freshness check reports
/// it current -- a gate that passes because it looked in only one of the two
/// places the output comes from.
///
/// WHY IT LIVES HERE AND NOT IN THE SHELL. The key is stamped by the module's
/// `build-wasm.sh` and compared by three Rust consumers: the projection
/// finalizer, the `verify-fresh` gate, and the local-build no-op fast path. If
/// the shell folded the recipe in by itself while the Rust side computed the
/// key another way, the two could never agree: every finalization would report
/// the module stale, and rebuilding would re-stamp the same disagreeing value.
/// A freshness key with two implementations is not a freshness key.
///
/// So there is one implementation, and both realms reach it: the shell through
/// `xtask workspace-closure-sha --recipe`, and the Rust consumers through the
/// `script` field each `CORESIDENT_SIDE_MODULES` entry declares. `recipe` is
/// repository-relative, so the digest does not depend on where the worktree is.
pub(crate) fn side_module_build_key(
    repo_root: &Path,
    crate_names: &[String],
    recipe: &str,
) -> Result<[u8; 32], String> {
    let crates = workspace_crates_closure_sha(repo_root, crate_names)?;
    let recipe_digest = crate::build_deps::hash_build_input(&repo_root.join(recipe))?;
    let mut h = Sha256::new();
    h.update(b"kandelo-side-module-build-key-v1\0");
    h.update(crates);
    h.update((recipe.len() as u64).to_le_bytes());
    h.update(recipe.as_bytes());
    h.update(recipe_digest);
    Ok(h.finalize().into())
}

/// CLI entry point: `xtask workspace-closure-sha --crates <comma,separated>`.
/// Prints the 64-lowercase-hex digest from [`workspace_crates_closure_sha`]
/// to stdout. A non-resolver build script (one with no `build.toml` to carry
/// `cargo:<crate>` inputs) shells out to this to get the same drift-proof,
/// cargo-metadata-derived closure coverage a resolver package gets for free.
///
/// With `--recipe <repo-relative build script>` it prints the full side-module
/// build key from [`side_module_build_key`] instead -- the same value the Rust
/// consumers compute from each module's declared `script`. A build script that
/// stamps a key MUST pass its own path here; folding the recipe in the shell
/// instead would give the key two disagreeing implementations.
pub(crate) fn run_workspace_closure_sha(args: Vec<String>) -> Result<(), String> {
    let mut crates: Option<String> = None;
    let mut recipe: Option<String> = None;
    let mut it = args.into_iter();
    while let Some(arg) = it.next() {
        if let Some(value) = arg.strip_prefix("--crates=") {
            if crates.is_some() {
                return Err("--crates given more than once".to_string());
            }
            crates = Some(value.to_string());
        } else if arg == "--crates" {
            if crates.is_some() {
                return Err("--crates given more than once".to_string());
            }
            crates = Some(
                it.next()
                    .ok_or_else(|| "--crates requires a comma-separated value".to_string())?,
            );
        } else if let Some(value) = arg.strip_prefix("--recipe=") {
            if recipe.is_some() {
                return Err("--recipe given more than once".to_string());
            }
            recipe = Some(value.to_string());
        } else if arg == "--recipe" {
            if recipe.is_some() {
                return Err("--recipe given more than once".to_string());
            }
            recipe = Some(
                it.next()
                    .ok_or_else(|| "--recipe requires a repository-relative path".to_string())?,
            );
        } else {
            return Err(format!("unexpected argument {arg:?}"));
        }
    }
    let crates = crates.ok_or_else(|| "workspace-closure-sha: --crates <a,b,c> is required".to_string())?;
    let names = crates
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>();
    let repo = crate::repo_root();
    let digest = match &recipe {
        Some(recipe) => {
            if Path::new(recipe).is_absolute() {
                return Err(format!(
                    "--recipe must be repository-relative so the digest does not \
                     depend on where the worktree lives; got {recipe:?}"
                ));
            }
            side_module_build_key(&repo, &names, recipe)?
        }
        None => workspace_crates_closure_sha(&repo, &names)?,
    };
    println!("{}", crate::util::hex(&digest));
    Ok(())
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

    #[test]
    fn workspace_crates_closure_sha_requires_at_least_one_crate() {
        let repo = crate::repo_root();
        let err = workspace_crates_closure_sha(&repo, &[]).unwrap_err();
        assert!(err.contains("at least one crate"), "{err}");
    }

    #[test]
    fn kandelo_image_module_closure_covers_its_full_build_graph() {
        let repo = crate::repo_root();
        let names = vec![
            "kandelo-image-module".to_string(),
            "runtime-core".to_string(),
        ];
        let mut union: BTreeSet<String> = BTreeSet::new();
        for name in &names {
            for rel in cargo_closure_paths(&repo, name).expect("closure") {
                union.insert(rel);
            }
        }
        assert!(union.contains("crates/kandelo-image-module"), "{union:?}");
        // The writer links the kernel's own rootfs and image-format code, so a
        // change there changes the images it writes and must move the digest.
        assert!(union.contains("crates/runtime-core"), "{union:?}");
        assert!(union.contains(".cargo/config.toml"), "{union:?}");

        let first = workspace_crates_closure_sha(&repo, &names).expect("sha");
        let second = workspace_crates_closure_sha(&repo, &names).expect("sha");
        assert_eq!(first, second, "must be deterministic for an unchanged tree");

        // The recipe is folded in on top of the crate closure, so the full key
        // differs from the closure-only digest for the same crates.
        let keyed = side_module_build_key(
            &repo,
            &names,
            "crates/kandelo-image-module/build-wasm.sh",
        )
        .expect("build key");
        assert_ne!(keyed, first, "the recipe must be part of the build key");
    }

    /// Each side-module build script must stamp the key xtask computes, with
    /// its own path as the recipe, rather than hashing any part of it itself.
    /// The Rust consumers compute the key from the entry's declared `script`;
    /// a script that keys itself any other way stamps a value they can never
    /// match, and every finalization then reports the module stale.
    #[test]
    fn every_side_module_script_keys_itself_through_the_shared_implementation() {
        let repo = crate::repo_root();
        for module in crate::local_build::CORESIDENT_SIDE_MODULES {
            let script = module.script;
            let text = std::fs::read_to_string(repo.join(script))
                .unwrap_or_else(|error| panic!("read {script}: {error}"));
            assert!(
                text.contains(&format!("--recipe {script}")),
                "{script} must ask xtask for its key with `--recipe {script}`, \
                 the same recipe CORESIDENT_SIDE_MODULES declares for it",
            );
            assert!(
                !text.contains(r#"shasum -a 256 "${BASH_SOURCE[0]}""#),
                "{script} must not compute any part of its build key itself: \
                 that gives the key two disagreeing implementations",
            );
        }
    }

    /// The TypeScript projection reader's root-level allowlist must name
    /// exactly the modules `CORESIDENT_SIDE_MODULES` projects, with exactly
    /// their artifacts.
    ///
    /// `standaloneModuleArtifacts` in `host/src/binary-resolver.ts` is a
    /// hand-written mirror of the Rust table, and the two must agree in both
    /// directions: the engine projects a node, and the reader decides whether a
    /// node is admissible. A row the engine projects but the reader omits does
    /// not break only that module -- the reader throws on the first node it
    /// cannot classify, so the WHOLE manifest becomes unreadable and every
    /// SourceOnly resolve fails.
    ///
    /// Textual because what disagrees lives in two languages, so no
    /// value-level assertion can see both sides.
    #[test]
    fn the_typescript_allowlist_mirrors_the_coresident_table() {
        let repo = crate::repo_root();
        let reader = "host/src/binary-resolver.ts";
        let text = std::fs::read_to_string(repo.join(reader))
            .unwrap_or_else(|error| panic!("read {reader}: {error}"));
        let marker = "const standaloneModuleArtifacts: Record<string, readonly string[]> = {";
        let start = text
            .find(marker)
            .unwrap_or_else(|| panic!("{reader} does not declare standaloneModuleArtifacts"))
            + marker.len();
        let end = start
            + text[start..]
                .find("};")
                .unwrap_or_else(|| panic!("{reader} standaloneModuleArtifacts is unterminated"));
        let block = &text[start..end];

        // Every module the engine projects must be admissible, with every
        // artifact it stages named on that module's row.
        for module in crate::local_build::CORESIDENT_SIDE_MODULES {
            let row_key = format!("\"{}\":", module.node_name);
            let row_start = block.find(&row_key).unwrap_or_else(|| {
                panic!(
                    "{reader} standaloneModuleArtifacts omits {:?}, which \
                     CORESIDENT_SIDE_MODULES projects: the reader throws on the \
                     first node it cannot classify, so this breaks every \
                     SourceOnly resolve, not just that module's",
                    module.node_name,
                )
            }) + row_key.len();
            let row_end = row_start
                + block[row_start..]
                    .find(']')
                    .unwrap_or_else(|| panic!("{reader} row {:?} is unterminated", module.node_name));
            let row = &block[row_start..row_end];
            for (artifact, _arch, _required) in module.artifacts {
                assert!(
                    row.contains(artifact),
                    "{reader} standaloneModuleArtifacts row {:?} does not name \
                     {artifact}, which its build script stages",
                    module.node_name,
                );
            }
        }

        // And nothing else may claim a root path. The allowlist exists to stop
        // an arbitrary node in an untrusted projection from doing so, which it
        // cannot do if it admits a name the engine never projects.
        let declared: Vec<&str> = crate::local_build::CORESIDENT_SIDE_MODULES
            .iter()
            .map(|module| module.node_name)
            .collect();
        for line in block.lines() {
            let trimmed = line.trim();
            let Some(rest) = trimmed.strip_prefix('"') else { continue };
            let Some(name) = rest.split('"').next() else { continue };
            assert!(
                declared.contains(&name),
                "{reader} standaloneModuleArtifacts admits {name:?} at a root \
                 path, but CORESIDENT_SIDE_MODULES projects no such module",
            );
        }
    }

    /// Every `crates/*/build-wasm.sh` must appear in `CORESIDENT_SIDE_MODULES`.
    ///
    /// An undeclared build script is built by nobody and projected by nobody:
    /// its artifact exists only when somebody runs the script by hand, and
    /// nothing fails at build time because the module is missing from the only
    /// list that would have asked for it. A freshness-level test cannot see
    /// that -- it checks the modules the table names -- so this reads the
    /// directory and treats the filesystem as the authority.
    #[test]
    fn every_side_module_build_script_is_in_the_coresident_table() {
        let repo = crate::repo_root();
        let mut on_disk: Vec<String> = std::fs::read_dir(repo.join("crates"))
            .expect("read crates/")
            .filter_map(|entry| {
                let path = entry.expect("crates/ entry").path();
                if !path.join("build-wasm.sh").is_file() {
                    return None;
                }
                let name = path.file_name()?.to_str()?.to_string();
                Some(format!("crates/{name}/build-wasm.sh"))
            })
            .collect();
        on_disk.sort();

        let mut declared: Vec<String> = crate::local_build::CORESIDENT_SIDE_MODULES
            .iter()
            .map(|module| module.script.to_string())
            .collect();
        declared.sort();

        assert_eq!(
            on_disk, declared,
            "every crates/*/build-wasm.sh must be declared in \
             CORESIDENT_SIDE_MODULES: an undeclared one is built by nobody and \
             projected into local-binaries/source-only-v1/ by nobody",
        );
    }
}
