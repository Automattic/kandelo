//! `xtask build-deps` — dep-graph resolver for Wasm libraries.
//!
//! Resolution order per library:
//!   1. `<repo>/local-libs/<name>/build/` — hand-patched source, in-progress.
//!   2. `<cache_root>/libs/<name>-<ver>-rev<N>-<arch>-<cache-key-sha>/` — canonical cache.
//!   3. Build from source: run the declared `build.script_path`, validate
//!      declared outputs, atomically install into the canonical cache.
//!
//! The build script runs with:
//!   * `WASM_POSIX_DEP_OUT_DIR` — temp dir the script must install into.
//!   * `WASM_POSIX_DEP_NAME`, `WASM_POSIX_DEP_VERSION`,
//!     `WASM_POSIX_DEP_REVISION` — identity of the lib being built.
//!   * `WASM_POSIX_DEP_SOURCE_URL`, `WASM_POSIX_DEP_SOURCE_SHA256` —
//!     upstream tarball URL + expected sha (the script downloads and
//!     verifies; the resolver doesn't fetch anything itself).
//!   * `WASM_POSIX_DEP_TARGET_ARCH` — `wasm32` or `wasm64`; the arch
//!     the build script must produce objects for.
//!   * `WASM_POSIX_DEP_<UPPER>_DIR` — for each *direct* declared dep
//!     (where `UPPER` is the dep name upper-cased with `-` → `_`),
//!     the resolved cache path of that dep's `{lib,include,…}`.
//!   * `WASM_POSIX_DEP_PKG_CONFIG_PATH` — colon-joined list of every
//!     *transitively*-resolved lib's `lib/pkgconfig/` directory (only
//!     paths that actually contain such a directory are included; libs
//!     without pkgconfig — e.g. ncurses — are skipped). Consumers
//!     prepend it to `PKG_CONFIG_PATH` so pkg-config can chase
//!     `Requires.private` chains across the whole dep graph.
//!
//! Atomic install: build in `<canonical>.tmp-<pid>/`, then `rename(2)`
//! into the canonical path. Readers either see the full previous
//! version of the cache entry or the full new one, never a partial
//! write. Races are handled: if two builds finish simultaneously, the
//! first wins and the second's temp dir is discarded.
//!
//! Subcommands:
//!   parse    <name|path>   Load + validate a package.toml, print it back
//!                          normalised.
//!   sha      <name>        Print the cache-key sha (transitive).
//!   path     <name>        Print the canonical cache path.
//!   resolve  <name>        Ensure the lib is built, print its path.

use std::collections::{BTreeMap, BTreeSet};
use std::os::fd::AsFd;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

use sha2::{Digest, Sha256};

use crate::host_tool_probe::{self, ProbeFailure};
use crate::index_toml::{self, EntryStatus};
use crate::pkg_manifest::{
    BinarySource, BuildToml, DepRef, DepsManifest, ForkInstrumentationPolicy, GitBuildInput,
    HostTool, ManifestKind, TargetArch, remove_cache_provenance, validate_cache_provenance,
    write_cache_provenance,
};
use crate::remote_fetch;
use crate::repo_root;
use crate::source_extract;

/// Root directory of the per-user lib cache. Honors `XDG_CACHE_HOME`,
/// else `$HOME/.cache`. Matches the pattern other tools in the repo use.
pub fn default_cache_root() -> PathBuf {
    if let Some(xdg) = std::env::var_os("XDG_CACHE_HOME") {
        PathBuf::from(xdg).join("kandelo")
    } else if let Some(home) = std::env::var_os("HOME") {
        PathBuf::from(home).join(".cache").join("kandelo")
    } else {
        // Fall back to a tempdir-adjacent location. Not ideal but
        // avoids panicking on exotic environments.
        PathBuf::from("/tmp/kandelo")
    }
}

/// Registry search path. Later entries have lower priority.
pub struct Registry {
    pub roots: Vec<PathBuf>,
}

impl Registry {
    /// From `WASM_POSIX_DEPS_REGISTRY` (colon-separated), else the
    /// repo's `packages/registry/`.
    pub fn from_env(repo: &Path) -> Self {
        if let Ok(env) = std::env::var("WASM_POSIX_DEPS_REGISTRY") {
            let roots = env
                .split(':')
                .filter(|s| !s.is_empty())
                .map(|s| expand_tilde(s))
                .collect();
            return Self { roots };
        }
        Self {
            roots: vec![repo.join("packages/registry")],
        }
    }

    /// Locate `<name>/package.toml` by walking registry roots. First hit
    /// wins.
    pub fn find(&self, name: &str) -> Option<PathBuf> {
        for root in &self.roots {
            let p = root.join(name).join("package.toml");
            if p.is_file() {
                return Some(p);
            }
        }
        None
    }

    pub fn load(&self, name: &str) -> Result<DepsManifest, String> {
        let path = self.find(name).ok_or_else(|| {
            let paths: Vec<_> = self.roots.iter().map(|p| p.display().to_string()).collect();
            format!(
                "dep {:?}: no package.toml found in registry roots [{}]",
                name,
                paths.join(", ")
            )
        })?;
        // Phase C: registry loads honor any `package.pr.toml` overlay
        // sitting alongside `package.toml` so the resolver picks up
        // PR-staging archive URLs without an edit to the committed
        // base manifest. The overlay is `[binary]`-only — `compute_sha`
        // doesn't hash `[binary]` fields, so cache keys are unchanged
        // when an overlay is present (the swap is purely about WHICH
        // archive gets fetched, not which canonical cache slot it lands
        // in). Direct path loads (`load_target` for `<dir>/package.toml`)
        // also go through this path because their dir derivation matches.
        let dir = path
            .parent()
            .ok_or_else(|| format!("{} has no parent directory", path.display()))?;
        DepsManifest::load_with_overlay(dir)
    }

    /// Walk every registry root non-recursively (one level deep —
    /// `<root>/<name>/package.toml`); load each manifest. Returns
    /// `(name, manifest)` pairs in deterministic name order. Errors
    /// from individual manifests propagate (don't silently skip).
    pub fn walk_all(&self) -> Result<Vec<(String, DepsManifest)>, String> {
        let mut out: BTreeMap<String, DepsManifest> = BTreeMap::new();
        for root in &self.roots {
            let rd = match std::fs::read_dir(root) {
                Ok(r) => r,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(e) => return Err(format!("read_dir {}: {e}", root.display())),
            };
            for entry in rd {
                let entry = entry.map_err(|e| format!("read_dir entry: {e}"))?;
                let path = entry.path();
                let toml = path.join("package.toml");
                if !toml.is_file() {
                    continue;
                }
                let m =
                    DepsManifest::load(&toml).map_err(|e| format!("{}: {e}", toml.display()))?;
                // First-root-wins, mirrors `find()`.
                out.entry(m.name.clone()).or_insert(m);
            }
        }
        Ok(out.into_iter().collect())
    }
}

/// Subset of [`Registry::walk_all`] containing only `kind = "program"`
/// manifests. Used by `bundle-program` and `archive-stage` to look
/// up source + license decoration for release artifacts.
pub fn programs_by_name(registry: &Registry) -> Result<BTreeMap<String, DepsManifest>, String> {
    Ok(registry
        .walk_all()?
        .into_iter()
        .filter(|(_, m)| matches!(m.kind, ManifestKind::Program))
        .collect())
}

fn expand_tilde(s: &str) -> PathBuf {
    if let Some(rest) = s.strip_prefix("~/") {
        if let Some(home) = std::env::var_os("HOME") {
            return PathBuf::from(home).join(rest);
        }
    }
    PathBuf::from(s)
}

/// Cache-key sha for a manifest. Recursively hashes transitive deps
/// so any change in the tree invalidates every downstream consumer.
/// The hash domain and inputs differ by manifest kind:
///
/// Library / program kind (arch- and ABI-specific artifacts):
///   domain `"wasm-posix-pkg\n"`, then
///   `name`, `version`, `revision`, `target_arch`, `abi_version`,
///   `source.url`, `source.sha256`, declared build input content
///   digests, global package build/toolchain content digests, optional
///   fork-instrument tool content digests for program outputs that use
///   that post-processor, then for each dep (sorted by name):
///   `dep.name`, `dep.version`, hex(dep_sha).
///
/// Source kind (raw upstream archive, arch- and ABI-agnostic):
///   domain `"wasm-posix-pkg-source\n"`, then
///   `name`, `version`, `revision`, `source.url`, `source.sha256`,
///   declared build input content digests, then the same per-dep
///   tail. `target_arch` and `abi_version` are intentionally omitted
///   — a source tarball does not change when the kernel ABI bumps or
///   when we cross-compile for a new arch.
///
/// ABI-bump propagation: a kernel ABI bump shifts every library and
/// program leaf sha (because `abi_version` is in their input set),
/// and those shifts ripple up to their consumers via the per-dep
/// `hex(dep_sha)` tail. Source-kind leaf shas stay stable, but a
/// library or program that consumes a source-kind dep still
/// invalidates correctly because its own `abi_version` input changes.
///
/// Note: the `abi_version` parameter here is the **consumer's** target
/// ABI. Archives separately advertise a `Vec<u32>` of compatible ABIs
/// via `[compatibility].abi_versions`; Task A.9 verifies the
/// consumer's value is in that set during remote-fetch.
///
/// Cycle detection via `chain`: a manifest may not transitively
/// depend on itself.
pub fn compute_sha(
    target: &DepsManifest,
    registry: &Registry,
    arch: TargetArch,
    abi_version: u32,
    memo: &mut BTreeMap<String, [u8; 32]>,
    chain: &mut Vec<String>,
) -> Result<[u8; 32], String> {
    if chain.iter().any(|s| s == &target.name) {
        return Err(format!(
            "cycle in dep graph: {} -> {}",
            chain.join(" -> "),
            target.name
        ));
    }
    // Memo key MUST include arch + abi: a single resolve chain can
    // legitimately need the same package at multiple arches (e.g. a
    // wasm64 program that transitively pulls a wasm32-only sibling
    // via the wasm32-fallback path) and at multiple ABIs (rare today
    // but the field is part of the sha input). Without these, a
    // memo'd wasm64 sha bleeds into a later wasm32 lookup, producing
    // a canonical cache path with wasm32 in the dir but the wasm64
    // sha in the suffix — which then can't possibly be satisfied by
    // either archive.
    let memo_key = format!("{}|{}|{}", target.spec(), arch.as_str(), abi_version);
    if let Some(cached) = memo.get(&memo_key) {
        return Ok(*cached);
    }

    chain.push(target.name.clone());

    // Resolve deps first; sort by name so iteration order is stable.
    let mut dep_shas: Vec<(DepRef, [u8; 32])> = Vec::with_capacity(target.depends_on.len());
    for dref in &target.depends_on {
        let child = registry.load(&dref.name)?;
        if child.version != dref.version {
            return Err(format!(
                "{} depends on {}@{}, but registry has {}",
                target.spec(),
                dref.name,
                dref.version,
                child.spec()
            ));
        }
        let child_sha = compute_sha(&child, registry, arch, abi_version, memo, chain)?;
        dep_shas.push((dref.clone(), child_sha));
    }
    dep_shas.sort_by(|a, b| a.0.name.cmp(&b.0.name));

    chain.pop();

    let build_inputs = build_input_digests(target, registry)?;
    let global_toolchain_inputs = match target.kind {
        ManifestKind::Library | ManifestKind::Program => global_package_toolchain_digests()?,
        ManifestKind::Source => Vec::new(),
    };
    let fork_instrument_tool_inputs = if package_uses_fork_instrument_tool(target) {
        fork_instrument_tool_digests()?
    } else {
        Vec::new()
    };

    let mut h = Sha256::new();
    match target.kind {
        ManifestKind::Source => {
            h.update(b"wasm-posix-pkg-source\n");
            h.update(target.name.as_bytes());
            h.update(b"\n");
            h.update(target.version.as_bytes());
            h.update(b"\n");
            h.update(target.revision.to_le_bytes());
            h.update(b"\n");
            // No target_arch, no abi_version — sources are arch/ABI-agnostic.
            h.update(target.source.url.as_bytes());
            h.update(b"\n");
            h.update(target.source.sha256.as_bytes());
            h.update(b"\n");
        }
        ManifestKind::Library | ManifestKind::Program => {
            h.update(b"wasm-posix-pkg\n");
            h.update(target.name.as_bytes());
            h.update(b"\n");
            h.update(target.version.as_bytes());
            h.update(b"\n");
            h.update(target.revision.to_le_bytes());
            h.update(b"\n");
            h.update(arch.as_str().as_bytes());
            h.update(b"\n");
            h.update(abi_version.to_le_bytes());
            h.update(b"\n");
            h.update(target.source.url.as_bytes());
            h.update(b"\n");
            h.update(target.source.sha256.as_bytes());
            h.update(b"\n");
            // Fold in declared outputs so changing what a build is
            // expected to produce invalidates the cache. Without this,
            // renaming a program's `wasm = "..."` (or any library
            // libs/headers/pkgconfig/files path) leaves cache_key_sha
            // unchanged — the resolver then serves a canonical
            // directory that doesn't match the new declaration and
            // archive-stage packs broken archives. Bug discovered in
            // PR #384 (lamp.vfs → lamp.vfs.zst).
            //
            // Ordering: hashed in authored Vec order (no sort). That
            // matches how consumers like `mirror_program_outputs`
            // iterate, and re-ordering is a real semantic change
            // worth invalidating on. `b"|"` separators keep
            // adjacent strings unambiguous (e.g. lib `"a"` + `"bc"` ≠
            // lib `"ab"` + `"c"`). A section tag (`"libs:"`, etc.)
            // before each list prevents cross-section collisions.
            h.update(b"outputs.libs:\n");
            for s in &target.outputs.libs {
                h.update(s.as_bytes());
                h.update(b"|");
            }
            h.update(b"\n");
            h.update(b"outputs.headers:\n");
            for s in &target.outputs.headers {
                h.update(s.as_bytes());
                h.update(b"|");
            }
            h.update(b"\n");
            h.update(b"outputs.pkgconfig:\n");
            for s in &target.outputs.pkgconfig {
                h.update(s.as_bytes());
                h.update(b"|");
            }
            h.update(b"\n");
            // Preserve every existing package's cache key: the additive files
            // field participates only when authored. A universally empty
            // section would invalidate the entire package registry merely for
            // learning a new output kind.
            if !target.outputs.files.is_empty() {
                h.update(b"outputs.files:v1\n");
                for s in &target.outputs.files {
                    h.update((s.len() as u64).to_le_bytes());
                    h.update(s.as_bytes());
                }
            }
            h.update(b"program_outputs:\n");
            for out in &target.program_outputs {
                h.update(out.name.as_bytes());
                h.update(b"|");
                h.update(out.wasm.as_bytes());
                if out.fork_instrumentation != ForkInstrumentationPolicy::Auto {
                    h.update(b"|fork_instrumentation=");
                    h.update(out.fork_instrumentation.as_str().as_bytes());
                }
                h.update(b"\n");
            }
            // Additive program runtime closure. Keep the section absent for
            // existing manifests so learning this schema does not invalidate
            // every historical package cache key.
            if !target.runtime_files.is_empty() {
                h.update(b"runtime_files:v1\n");
                for runtime_file in &target.runtime_files {
                    for field in [
                        runtime_file.artifact.as_bytes(),
                        runtime_file.guest_path.as_bytes(),
                    ] {
                        h.update((field.len() as u64).to_le_bytes());
                        h.update(field);
                    }
                    h.update(runtime_file.mode.to_le_bytes());
                }
            }
        }
    }
    if !build_inputs.is_empty() {
        h.update(b"build-inputs:\n");
        for input in &build_inputs {
            h.update(input.label.as_bytes());
            h.update(b"\n");
            h.update(input.digest);
            h.update(b"\n");
        }
    }
    if !global_toolchain_inputs.is_empty() {
        h.update(b"global-toolchain-inputs:\n");
        for input in &global_toolchain_inputs {
            h.update(input.label.as_bytes());
            h.update(b"\n");
            h.update(input.digest);
            h.update(b"\n");
        }
    }
    if !fork_instrument_tool_inputs.is_empty() {
        h.update(b"fork-instrument-tool-inputs:\n");
        for input in &fork_instrument_tool_inputs {
            h.update(input.label.as_bytes());
            h.update(b"\n");
            h.update(input.digest);
            h.update(b"\n");
        }
    }
    for (dref, dsha) in &dep_shas {
        h.update(dref.name.as_bytes());
        h.update(b"@");
        h.update(dref.version.as_bytes());
        h.update(b":");
        h.update(hex(dsha).as_bytes());
        h.update(b"\n");
    }

    let out: [u8; 32] = h.finalize().into();
    memo.insert(memo_key, out);
    Ok(out)
}

#[derive(Clone, Debug)]
struct BuildInputDigest {
    label: String,
    digest: [u8; 32],
}

const GLOBAL_PACKAGE_TOOLCHAIN_INPUTS: &[&str] = &[
    "flake.nix",
    "flake.lock",
    "rust-toolchain.toml",
    "scripts/dev-shell.sh",
    "scripts/build-musl.sh",
    "scripts/install-overlay-headers.sh",
    ".github/actions/package-archive-build",
    ".github/actions/package-toolchain",
    ".github/actions/fetch-submodules",
    ".github/actions/download-run-artifacts",
    "libc/glue",
    "libc/musl-overlay",
    "libc/musl",
    "sdk/activate.sh",
    "sdk/bin",
    "sdk/config.site",
    "sdk/package.json",
    "sdk/package-lock.json",
    "sdk/src",
];

const FORK_INSTRUMENT_TOOL_INPUTS: &[&str] = &[
    "Cargo.toml",
    "crates/fork-instrument/Cargo.toml",
    "crates/fork-instrument/src",
    "scripts/build-fork-instrument-tool.sh",
    "scripts/run-wasm-fork-instrument.sh",
];

static GLOBAL_PACKAGE_TOOLCHAIN_DIGESTS: OnceLock<Result<Vec<BuildInputDigest>, String>> =
    OnceLock::new();
static FORK_INSTRUMENT_TOOL_DIGESTS: OnceLock<Result<Vec<BuildInputDigest>, String>> =
    OnceLock::new();

fn global_package_toolchain_digests() -> Result<Vec<BuildInputDigest>, String> {
    GLOBAL_PACKAGE_TOOLCHAIN_DIGESTS
        .get_or_init(|| {
            global_package_build_input_digests_for(&repo_root(), GLOBAL_PACKAGE_TOOLCHAIN_INPUTS)
        })
        .clone()
}

fn fork_instrument_tool_digests() -> Result<Vec<BuildInputDigest>, String> {
    FORK_INSTRUMENT_TOOL_DIGESTS
        .get_or_init(|| {
            let root = repo_root();
            let mut digests =
                global_package_build_input_digests_for(&root, FORK_INSTRUMENT_TOOL_INPUTS)?;
            digests.push(BuildInputDigest {
                label: "cargo-metadata:fork-instrument-build-deps".to_string(),
                digest: fork_instrument_cargo_dependency_digest(&root)?,
            });
            Ok(digests)
        })
        .clone()
}

fn package_uses_fork_instrument_tool(target: &DepsManifest) -> bool {
    matches!(target.kind, ManifestKind::Program)
        && target
            .program_outputs
            .iter()
            .any(|out| out.fork_instrumentation != ForkInstrumentationPolicy::Disabled)
}

#[derive(Debug, serde::Deserialize)]
struct CargoLock {
    #[serde(default)]
    package: Vec<CargoLockPackage>,
}

#[derive(Debug, serde::Deserialize)]
struct CargoLockPackage {
    name: String,
    version: String,
    source: Option<String>,
    checksum: Option<String>,
}

fn fork_instrument_cargo_dependency_digest(root: &Path) -> Result<[u8; 32], String> {
    let host_target = host_target_triple()?;
    let output = Command::new("cargo")
        .arg("metadata")
        .arg("--format-version=1")
        .arg("--locked")
        .arg("--filter-platform")
        .arg(&host_target)
        .current_dir(root)
        .output()
        .map_err(|e| format!("run cargo metadata for fork-instrument cache key: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "cargo metadata for fork-instrument cache key failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }

    let metadata: serde_json::Value = serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("parse cargo metadata for fork-instrument cache key: {e}"))?;
    let lock_text = std::fs::read_to_string(root.join("Cargo.lock"))
        .map_err(|e| format!("read Cargo.lock for fork-instrument cache key: {e}"))?;
    let lock: CargoLock = toml::from_str(&lock_text)
        .map_err(|e| format!("parse Cargo.lock for fork-instrument cache key: {e}"))?;
    fork_instrument_cargo_dependency_digest_from_metadata(root, &metadata, &lock)
}

fn host_target_triple() -> Result<String, String> {
    let output = Command::new("rustc")
        .arg("-vV")
        .output()
        .map_err(|e| format!("run rustc -vV: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "rustc -vV failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    stdout
        .lines()
        .find_map(|line| line.strip_prefix("host: ").map(str::to_owned))
        .filter(|host| !host.is_empty())
        .ok_or_else(|| "rustc -vV did not report host target".to_string())
}

fn fork_instrument_cargo_dependency_digest_from_metadata(
    root: &Path,
    metadata: &serde_json::Value,
    lock: &CargoLock,
) -> Result<[u8; 32], String> {
    let packages = metadata_array(metadata, "packages")?;
    let nodes = metadata
        .get("resolve")
        .and_then(|resolve| resolve.get("nodes"))
        .and_then(|nodes| nodes.as_array())
        .ok_or_else(|| "cargo metadata missing resolve.nodes".to_string())?;

    let mut packages_by_id: BTreeMap<String, &serde_json::Value> = BTreeMap::new();
    let mut root_package_id: Option<String> = None;
    for package in packages {
        let id = metadata_str(package, "id")?.to_string();
        let name = metadata_str(package, "name")?;
        let manifest_path = metadata_str(package, "manifest_path")?;
        if name == "fork-instrument"
            && manifest_path.ends_with("/crates/fork-instrument/Cargo.toml")
        {
            root_package_id = Some(id.clone());
        }
        packages_by_id.insert(id, package);
    }

    let root_package_id = root_package_id
        .ok_or_else(|| "cargo metadata missing fork-instrument package".to_string())?;
    let mut nodes_by_id: BTreeMap<String, &serde_json::Value> = BTreeMap::new();
    for node in nodes {
        nodes_by_id.insert(metadata_str(node, "id")?.to_string(), node);
    }

    let mut closure = BTreeSet::new();
    let mut stack = vec![root_package_id.clone()];
    while let Some(package_id) = stack.pop() {
        if !closure.insert(package_id.clone()) {
            continue;
        }
        let node = nodes_by_id
            .get(&package_id)
            .ok_or_else(|| format!("cargo metadata missing resolve node for {package_id}"))?;
        for dep in selected_cargo_metadata_deps(node)? {
            stack.push(dep);
        }
    }

    let lock_checksums = cargo_lock_checksums(lock);
    let mut entries = Vec::with_capacity(closure.len());
    for package_id in closure {
        let package = packages_by_id
            .get(&package_id)
            .ok_or_else(|| format!("cargo metadata missing package for {package_id}"))?;
        let node = nodes_by_id
            .get(&package_id)
            .ok_or_else(|| format!("cargo metadata missing resolve node for {package_id}"))?;
        let stable_id = stable_cargo_package_id(root, package)?;
        let features = sorted_string_array(node, "features")?;
        let deps = selected_cargo_metadata_deps(node)?
            .into_iter()
            .map(|dep_id| {
                let dep_package = packages_by_id
                    .get(&dep_id)
                    .ok_or_else(|| format!("cargo metadata missing package for {dep_id}"))?;
                stable_cargo_package_id(root, dep_package)
            })
            .collect::<Result<BTreeSet<_>, _>>()?;
        let lock_key = cargo_lock_key(package)?;
        let checksum = lock_checksums.get(&lock_key).cloned().unwrap_or_default();
        entries.push((stable_id, features, deps, checksum));
    }
    entries.sort_by(|a, b| a.0.cmp(&b.0));

    let mut h = Sha256::new();
    h.update(b"fork-instrument-cargo-build-deps-v1\n");
    for (stable_id, features, deps, checksum) in entries {
        h.update(b"package\0");
        h.update(stable_id.as_bytes());
        h.update(b"\0checksum\0");
        h.update(checksum.as_bytes());
        h.update(b"\0features\0");
        for feature in features {
            h.update(feature.as_bytes());
            h.update(b"\0");
        }
        h.update(b"deps\0");
        for dep in deps {
            h.update(dep.as_bytes());
            h.update(b"\0");
        }
        h.update(b"\n");
    }
    Ok(h.finalize().into())
}

fn selected_cargo_metadata_deps(node: &serde_json::Value) -> Result<Vec<String>, String> {
    let deps = match node.get("deps").and_then(|deps| deps.as_array()) {
        Some(deps) => deps,
        None => return Ok(Vec::new()),
    };
    let mut out = Vec::new();
    for dep in deps {
        if !cargo_metadata_dep_is_build_input(dep)? {
            continue;
        }
        out.push(metadata_str(dep, "pkg")?.to_string());
    }
    out.sort();
    out.dedup();
    Ok(out)
}

fn cargo_metadata_dep_is_build_input(dep: &serde_json::Value) -> Result<bool, String> {
    let dep_kinds = dep
        .get("dep_kinds")
        .and_then(|dep_kinds| dep_kinds.as_array())
        .ok_or_else(|| "cargo metadata dependency missing dep_kinds".to_string())?;
    Ok(dep_kinds.iter().any(|kind| {
        kind.get("kind")
            .and_then(|kind| kind.as_str())
            .map(|kind| kind == "build")
            .unwrap_or(true)
    }))
}

fn stable_cargo_package_id(root: &Path, package: &serde_json::Value) -> Result<String, String> {
    let name = metadata_str(package, "name")?;
    let version = metadata_str(package, "version")?;
    let source = package.get("source").and_then(|source| source.as_str());
    if let Some(source) = source {
        return Ok(format!("{source}#{name}@{version}"));
    }

    let manifest_path = PathBuf::from(metadata_str(package, "manifest_path")?);
    let rel_manifest = manifest_path.strip_prefix(root).unwrap_or(&manifest_path);
    Ok(format!(
        "path:{}#{name}@{version}",
        rel_manifest.to_string_lossy()
    ))
}

fn cargo_lock_key(package: &serde_json::Value) -> Result<(String, String, String), String> {
    Ok((
        metadata_str(package, "name")?.to_string(),
        metadata_str(package, "version")?.to_string(),
        package
            .get("source")
            .and_then(|source| source.as_str())
            .unwrap_or("")
            .to_string(),
    ))
}

fn cargo_lock_checksums(lock: &CargoLock) -> BTreeMap<(String, String, String), String> {
    lock.package
        .iter()
        .filter_map(|package| {
            package.checksum.as_ref().map(|checksum| {
                (
                    (
                        package.name.clone(),
                        package.version.clone(),
                        package.source.clone().unwrap_or_default(),
                    ),
                    checksum.clone(),
                )
            })
        })
        .collect()
}

fn metadata_array<'a>(
    value: &'a serde_json::Value,
    field: &str,
) -> Result<&'a Vec<serde_json::Value>, String> {
    value
        .get(field)
        .and_then(|value| value.as_array())
        .ok_or_else(|| format!("cargo metadata missing {field} array"))
}

fn metadata_str<'a>(value: &'a serde_json::Value, field: &str) -> Result<&'a str, String> {
    value
        .get(field)
        .and_then(|value| value.as_str())
        .ok_or_else(|| format!("cargo metadata missing {field} string"))
}

fn sorted_string_array(value: &serde_json::Value, field: &str) -> Result<Vec<String>, String> {
    let mut out = value
        .get(field)
        .and_then(|value| value.as_array())
        .ok_or_else(|| format!("cargo metadata missing {field} array"))?
        .iter()
        .map(|value| {
            value
                .as_str()
                .map(str::to_string)
                .ok_or_else(|| format!("cargo metadata {field} array contains a non-string"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    out.sort();
    Ok(out)
}

fn global_package_build_input_digests_for(
    root: &Path,
    inputs: &[&str],
) -> Result<Vec<BuildInputDigest>, String> {
    let mut out = Vec::with_capacity(inputs.len());
    for input in inputs {
        let path = root.join(input);
        if !path.exists() {
            return Err(format!(
                "global package build input {:?} not found at {}",
                input,
                path.display()
            ));
        }
        out.push(BuildInputDigest {
            label: (*input).to_string(),
            digest: hash_global_package_build_input(root, input, &path)?,
        });
    }
    Ok(out)
}

fn hash_global_package_build_input(
    root: &Path,
    input: &str,
    path: &Path,
) -> Result<[u8; 32], String> {
    if input == "libc/musl" {
        if let Some(digest) = hash_gitlink_input(root, input)? {
            return Ok(digest);
        }
    }
    hash_build_input(path)
}

fn hash_gitlink_input(root: &Path, input: &str) -> Result<Option<[u8; 32]>, String> {
    let output = match Command::new("git")
        .arg("-C")
        .arg(root)
        .arg("ls-tree")
        .arg("HEAD")
        .arg("--")
        .arg(input)
        .output()
    {
        Ok(output) => output,
        Err(_) => return Ok(None),
    };
    if !output.status.success() {
        return Ok(None);
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let Some(line) = stdout.lines().next() else {
        return Ok(None);
    };
    let Some(rest) = line.strip_prefix("160000 commit ") else {
        return Ok(None);
    };
    let Some((object_id, _path)) = rest.split_once('\t') else {
        return Err(format!("unexpected gitlink entry for {input:?}: {line:?}"));
    };

    let mut h = Sha256::new();
    h.update(b"gitlink\0");
    h.update(input.as_bytes());
    h.update(b"\0");
    h.update(object_id.as_bytes());
    h.update(b"\0");
    Ok(Some(h.finalize().into()))
}

fn build_input_digests(
    target: &DepsManifest,
    registry: &Registry,
) -> Result<Vec<BuildInputDigest>, String> {
    if !target.dir.join("build.toml").exists() {
        return Ok(Vec::new());
    }
    let build = BuildToml::load(&target.dir)?;
    let mut out = Vec::with_capacity(build.inputs.len() + build.git_inputs.len());
    for input in &build.inputs {
        let path = resolve_build_input_path(target, registry, input)?;
        out.push(BuildInputDigest {
            label: input.clone(),
            digest: hash_build_input(&path)?,
        });
    }
    // External Git inputs are content-addressed before any network access.
    // Preserve authored order and length-prefix every field so distinct
    // tuples cannot collide through concatenation. Adding this section is
    // intentionally additive: packages without git_inputs retain their
    // existing cache keys.
    for (index, input) in build.git_inputs.iter().enumerate() {
        let mut h = Sha256::new();
        h.update(b"wasm-posix-build-git-input-v1\0");
        for field in [
            input.name.as_bytes(),
            input.repository.as_bytes(),
            input.commit.as_bytes(),
        ] {
            h.update((field.len() as u64).to_le_bytes());
            h.update(field);
        }
        out.push(BuildInputDigest {
            label: format!("git-input:{index}:{}", input.name),
            digest: h.finalize().into(),
        });
    }
    Ok(out)
}

fn resolve_build_input_path(
    target: &DepsManifest,
    registry: &Registry,
    input: &str,
) -> Result<PathBuf, String> {
    let mut candidates = Vec::new();
    candidates.push(repo_root().join(input));
    candidates.extend(registry.roots.iter().map(|root| root.join(input)));
    candidates.push(target.dir.join(input));

    for candidate in &candidates {
        if candidate.exists() {
            return Ok(candidate.clone());
        }
    }

    let tried = candidates
        .iter()
        .map(|p| p.display().to_string())
        .collect::<Vec<_>>()
        .join(", ");
    Err(format!(
        "{} build input {:?} not found (tried: {})",
        target.spec(),
        input,
        tried
    ))
}

fn hash_build_input(path: &Path) -> Result<[u8; 32], String> {
    let mut h = Sha256::new();
    hash_build_input_entry(&mut h, path, path)?;
    Ok(h.finalize().into())
}

fn hash_build_input_entry(h: &mut Sha256, root: &Path, path: &Path) -> Result<(), String> {
    let meta =
        std::fs::symlink_metadata(path).map_err(|e| format!("stat {}: {e}", path.display()))?;
    let rel = path.strip_prefix(root).unwrap_or(path);
    let rel = rel.to_string_lossy();

    if meta.file_type().is_symlink() {
        let target =
            std::fs::read_link(path).map_err(|e| format!("readlink {}: {e}", path.display()))?;
        h.update(b"symlink\0");
        h.update(rel.as_bytes());
        h.update(b"\0");
        h.update(target.to_string_lossy().as_bytes());
        h.update(b"\0");
        return Ok(());
    }

    if meta.is_file() {
        let bytes = std::fs::read(path).map_err(|e| format!("read {}: {e}", path.display()))?;
        h.update(b"file\0");
        h.update(rel.as_bytes());
        h.update(b"\0");
        h.update((bytes.len() as u64).to_le_bytes());
        h.update(b"\0");
        h.update(bytes);
        h.update(b"\0");
        return Ok(());
    }

    if meta.is_dir() {
        h.update(b"dir\0");
        h.update(rel.as_bytes());
        h.update(b"\0");
        let mut entries = std::fs::read_dir(path)
            .map_err(|e| format!("read_dir {}: {e}", path.display()))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("read_dir {}: {e}", path.display()))?;
        entries.sort_by_key(|entry| entry.path());
        for entry in entries {
            hash_build_input_entry(h, root, &entry.path())?;
        }
        return Ok(());
    }

    Err(format!(
        "build input {} is not a file, directory, or symlink",
        path.display()
    ))
}

/// Canonical cache directory for a resolved manifest.
///
/// Layout:
///   libs/programs: `<cache_root>/libs/<name>-<version>-rev<revision>-<arch>-<cache-key-sha>/`
///   sources:       `<cache_root>/sources/<name>-<version>-rev<revision>-<cache-key-sha>/`
///
/// The directory suffix is the complete 64-character cache-key SHA-256. Archive
/// filenames may use an eight-character transport label, but canonical local
/// cache identity must not collapse distinct keys that share that prefix. Cache
/// entries created by older resolvers with a short suffix become unused and are
/// rebuilt under the full-key path; they are not migrated or trusted in place.
///
/// For libs and programs, `arch` is part of the path so a single user
/// can host wasm32 and wasm64 builds of the same artifact side-by-side.
/// The cache-key sha already incorporates `arch` as of Task A.5, so the
/// full cache identity disambiguates — but a visible arch segment makes the
/// cache layout self-explanatory at a glance.
///
/// For source-kind manifests, the layout omits the arch segment per
/// design decision 6: source artifacts are arch-agnostic, so a single
/// cache entry serves both wasm32 and wasm64 consumers.
pub fn canonical_path(
    cache_root: &Path,
    m: &DepsManifest,
    arch: TargetArch,
    sha: &[u8; 32],
) -> PathBuf {
    let kind_subdir = match m.kind {
        ManifestKind::Library => "libs",
        ManifestKind::Program => "programs",
        ManifestKind::Source => "sources",
    };
    let basename = match m.kind {
        ManifestKind::Source => format!("{}-{}-rev{}-{}", m.name, m.version, m.revision, hex(sha)),
        ManifestKind::Library | ManifestKind::Program => format!(
            "{}-{}-rev{}-{}-{}",
            m.name,
            m.version,
            m.revision,
            arch.as_str(),
            hex(sha)
        ),
    };
    cache_root.join(kind_subdir).join(basename)
}

use crate::util::hex;

// ---------------------------------------------------------------------
// Build + cache-install
// ---------------------------------------------------------------------

/// Options controlling where the resolver reads from and writes to.
/// Kept as a struct so tests can pass tempdirs without reaching into
/// `$HOME` / `$XDG_CACHE_HOME`.
pub struct ResolveOpts<'a> {
    pub cache_root: &'a Path,
    /// Optional `local-libs/` directory. When a `<name>/build/`
    /// subdirectory exists under this root, it wins over the cache
    /// and the build script is not run.
    pub local_libs: Option<&'a Path>,
    /// Manifest names that must be source-built unconditionally, even
    /// on a cache hit and even when a `[binary]` archive_url would
    /// otherwise satisfy the request. Used by the manual `force-rebuild`
    /// workflow to refresh archives whose cache key is suspected stale.
    /// `None` means "no force rebuild" (the default for every consumer
    /// other than the manual workflow). `local_libs` still wins over
    /// force_source_build (a hand-patched override is always honored).
    /// A force rebuild assumes no concurrent resolver invocation for
    /// the same package -- see `build_into_cache`'s atomic-install comment.
    pub force_source_build: Option<&'a BTreeSet<String>>,
    /// Refuse any source build or source fetch fallback. Used by CI
    /// binary-materialization gates, where package bytes must come from
    /// staging overlays, the durable index, or an existing valid cache entry.
    pub fetch_only: bool,
    /// Repo root used to resolve `[build].script_path` (which is
    /// repo-relative as of Phase A-bis Task 2). `None` means "use
    /// `crate::repo_root()`", which is the production default.
    /// Tests use this to point the resolver at a tempdir.
    pub repo_root: Option<&'a Path>,
    /// When `Some`, the resolver places `binaries/programs/<arch>/...`
    /// symlinks for every program manifest in the dep graph (target +
    /// transitive program deps). Required so a consumer's build
    /// script can find sibling-package binaries via `tryResolveBinary`
    /// after a `xtask build-deps resolve <name>` invocation. `None`
    /// disables symlink placement (test fixtures, library-only
    /// resolves, etc.).
    pub binaries_dir: Option<&'a Path>,
}

/// Resolve a library to a concrete on-disk path with the artifacts
/// declared in its `package.toml`. Ensures dependencies are resolved
/// first (depth-first), then runs the build script if neither a
/// `local-libs/` override nor a cache hit is available.
///
/// Returns the path the consumer should point `CPPFLAGS=-I<p>/include
/// LDFLAGS=-L<p>/lib` at.
pub fn ensure_built(
    target: &DepsManifest,
    registry: &Registry,
    arch: TargetArch,
    abi_version: u32,
    opts: &ResolveOpts<'_>,
) -> Result<PathBuf, String> {
    let mut memo: BTreeMap<String, [u8; 32]> = BTreeMap::new();
    let mut building: Vec<String> = Vec::new();
    let (path, _transitive) = ensure_built_inner(
        target,
        registry,
        arch,
        abi_version,
        opts,
        &mut memo,
        &mut building,
    )?;
    Ok(path)
}

/// One direct dependency's resolved cache path plus its manifest kind.
///
/// Carried alongside `dep_dirs` so the build-script env-var emission
/// can switch the suffix per design 12: library/program deps export
/// under `WASM_POSIX_DEP_<NAME>_DIR` (a built-artifact root), source
/// deps under `WASM_POSIX_DEP_<NAME>_SRC_DIR` (an unbuilt source tree).
struct DirectDep {
    path: PathBuf,
    kind: ManifestKind,
}

/// Render a multi-tool probe-failure message for `ensure_built_inner`.
///
/// Aggregates every `ProbeFailure` for `target` into one `Err(String)`
/// payload so a user fixes their toolchain in a single round-trip
/// rather than `cargo run`-ing once per missing tool. For each failure
/// we look up the matching `[[host_tools]]` declaration and append the
/// platform-keyed install hint chosen by `cfg!(target_os)`. If the
/// declaration ships hints but none for the current OS, we list which
/// platforms ARE covered so the user knows whether to translate one
/// or to file an issue.
/// Map Rust's `std::env::consts::OS` to the conventional platform key
/// used in `[[host_tools]].install_hints`. The deps-management package-system
/// schema uses unix-y names (`darwin` for macOS, matching bash and
/// `uname`); Rust's runtime constant is `"macos"`. Other names match
/// what users would expect (`linux`, `windows`, `freebsd`, etc.).
fn install_hints_key_for_current_os() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        other => other,
    }
}

fn render_probe_failures(target: &DepsManifest, failures: &[ProbeFailure]) -> String {
    let mut out = String::new();
    out.push_str(&format!(
        "{}: {} host-tool requirement{} unsatisfied:\n",
        target.spec(),
        failures.len(),
        if failures.len() == 1 { "" } else { "s" }
    ));
    for f in failures {
        out.push_str(&format!("  - {f}\n"));
        let tool_name = match f {
            ProbeFailure::Missing { tool, .. }
            | ProbeFailure::BadOutput { tool, .. }
            | ProbeFailure::BadVersion { tool, .. }
            | ProbeFailure::TooOld { tool, .. } => tool,
        };
        if let Some(decl) = target
            .host_tools
            .iter()
            .find(|d: &&HostTool| &d.name == tool_name)
        {
            let os = install_hints_key_for_current_os();
            if let Some(hint) = decl.install_hints.get(os) {
                out.push_str(&format!("      install hint ({os}): {hint}\n"));
            } else if !decl.install_hints.is_empty() {
                let keys: Vec<&str> = decl.install_hints.keys().map(String::as_str).collect();
                out.push_str(&format!(
                    "      no {os} install hint; available platforms: [{}]\n",
                    keys.join(", ")
                ));
            }
        }
    }
    out
}

/// Process-lifetime memo of `(name, arch, exact cache identity) →
/// ensure_built_uncached`'s result. Within a single `xtask` invocation (e.g. one
/// `archive-stage` run, or a `build-deps resolve` walk that pulls a
/// shared dep transitively), a manifest reached via multiple dependents
/// (mariadb is reached 6× during a force-rebuild-all: directly + via
/// lamp + via mariadb-test + via mariadb-vfs ×2) otherwise re-runs its
/// full source build N times — ~80 minutes of pointless work for
/// mariadb alone. The memo collapses that to one build per
/// `(name, arch)`.
///
/// Caches BOTH `Ok` (so subsequent dependents reuse the resolved
/// path) and `Err` (so a failed manifest doesn't waste 10 more
/// minutes per dependent re-discovering the same failure). Cycle
/// errors are intentionally NOT cached — those depend on the call
/// stack at the moment of detection, and caching them could leak a
/// stale cycle result into a later acyclic traversal.
///
/// Lifetime: process-only. A fresh xtask invocation starts with an
/// empty memo, which keeps CI semantics intact (every run from
/// scratch retries any failures).
///
/// Key dimensions:
/// * `cache_root` — same process can host independent test cases
///   (cargo runs tests in parallel within one process; each test
///   uses a fresh tempdir). In production there's only ever one
///   cache_root per run, so this dimension is invisible to the
///   force-rebuild path.
/// * `name` — the manifest's identifier within its registry.
/// * `arch` — wasm32 vs wasm64. The same name builds independently
///   per-arch.
/// * `cache_identity` — the full recipe/dependency/toolchain digest computed
///   from the current registry. This prevents a result from surviving a
///   build.toml edit or being reused for a same-named package from another
///   registry inside one long-lived process.
/// * `was_force_rebuild` — `force_source_build` bypasses the
///   on-disk cache. Memoizing across the force-rebuild boundary
///   would mean a no-force result satisfies a later force request,
///   defeating the bypass intent. Keep them as separate slots so
///   a force-call after a no-force-call still rebuilds. In
///   a force-rebuild-all loop every call has the same flag, so the
///   memo collapses N calls per (name, arch) into 1 build — the
///   actual optimization we wanted.
/// * `fetch_only` — fetch-only failures must not poison later normal
///   resolves, which are allowed to build from source.
type BuildMemoKey = (PathBuf, String, TargetArch, [u8; 32], bool, bool);
type BuildMemoValue = Result<(PathBuf, BTreeSet<PathBuf>), String>;

fn build_memo() -> &'static Mutex<BTreeMap<BuildMemoKey, BuildMemoValue>> {
    static MEMO: OnceLock<Mutex<BTreeMap<BuildMemoKey, BuildMemoValue>>> = OnceLock::new();
    MEMO.get_or_init(|| Mutex::new(BTreeMap::new()))
}

/// Cycle-error sentinel — these errors must NOT be memoized because
/// they describe the call stack at detection time, not a property of
/// the manifest. A later acyclic call for the same node should be
/// allowed to proceed.
fn is_cycle_error(e: &str) -> bool {
    e.starts_with("cycle while building:")
}

/// Fast path for archive-only resolver callers.
///
/// Browser/dev-server preparation needs to materialize self-contained program
/// archives into `binaries/`. If one of those programs has a stale or corrupt
/// dependency archive, resolving dependencies first can incorrectly force a
/// source build even though the target archive itself is valid. Keep normal
/// source-build resolution unchanged, but allow program archive fetches in
/// binary-materialization mode to satisfy the request before walking deps.
///
/// Fetch-only CI materialization is stricter: it accepts only a valid cache
/// entry or prebuilt archive for the target package and never falls through to
/// dependency resolution/source builds.
fn try_fetch_without_deps(
    target: &DepsManifest,
    registry: &Registry,
    arch: TargetArch,
    abi_version: u32,
    opts: &ResolveOpts<'_>,
    memo: &mut BTreeMap<String, [u8; 32]>,
) -> Result<Option<PathBuf>, String> {
    let binary_materialization_fast_path = opts.binaries_dir.is_some()
        && matches!(target.kind, ManifestKind::Program)
        && !target.program_outputs.is_empty();
    if (!opts.fetch_only && !binary_materialization_fast_path)
        || !matches!(target.kind, ManifestKind::Library | ManifestKind::Program)
    {
        return Ok(None);
    }

    let force_rebuild = opts
        .force_source_build
        .map(|s| s.contains(&target.name))
        .unwrap_or(false);
    if force_rebuild {
        if opts.fetch_only {
            return Err(format!(
                "{}: fetch-only resolve cannot honor force source-build for arch {}",
                target.spec(),
                arch.as_str(),
            ));
        }
        return Ok(None);
    }

    if !opts.fetch_only {
        if let Some(lr) = opts.local_libs {
            let override_dir = lr.join(&target.name).join("build");
            if override_dir.is_dir() {
                return Ok(Some(override_dir));
            }
        }
    }

    let mut chain: Vec<String> = Vec::new();
    let sha = compute_sha(target, registry, arch, abi_version, memo, &mut chain)?;
    let canonical = canonical_path(opts.cache_root, target, arch, &sha);
    let cache_key_sha_hex = hex(&sha);

    if canonical.is_dir() {
        match validate_cache_entry(target, &canonical, arch, abi_version, &cache_key_sha_hex) {
            Ok(()) => return Ok(Some(canonical)),
            Err(e) => {
                eprintln!(
                    "warning: ignoring stale cached artifact for {} at {} ({})",
                    target.spec(),
                    canonical.display(),
                    e,
                );
                remove_cache_entry(&canonical, &cache_key_sha_hex).map_err(|remove_err| {
                    format!(
                        "clear stale cache entry {} after validation failure: {remove_err}",
                        canonical.display()
                    )
                })?;
            }
        }
    }

    if let Some(binary) = target.binary.get(&arch) {
        match remote_fetch::fetch_and_install(
            binary,
            &canonical,
            target,
            arch,
            abi_version,
            &cache_key_sha_hex,
        ) {
            Ok(()) => match validate_cache_entry(
                target,
                &canonical,
                arch,
                abi_version,
                &cache_key_sha_hex,
            ) {
                Ok(()) => return Ok(Some(canonical)),
                Err(e) => {
                    eprintln!(
                        "warning: direct binary fetch for {} from {} produced \
                         a stale artifact ({}); {}",
                        target.spec(),
                        binary.archive_url,
                        e,
                        fetch_fallback_phrase(opts.fetch_only),
                    );
                    let _ = remove_cache_entry(&canonical, &cache_key_sha_hex);
                }
            },
            Err(e) => {
                eprintln!(
                    "warning: direct binary fetch for {} from {} failed ({}); \
                     {}",
                    target.spec(),
                    binary.archive_url,
                    e,
                    fetch_fallback_phrase(opts.fetch_only),
                );
            }
        }
    }

    if let Some(()) = try_index_install(
        target,
        arch,
        abi_version,
        &canonical,
        &cache_key_sha_hex,
        opts.fetch_only,
    ) {
        return Ok(Some(canonical));
    }

    if opts.fetch_only {
        return Err(format!(
            "{}: fetch-only resolve could not install a valid archive for arch {}; \
             run package staging/prepare to publish this package instead of \
             source-building during binary materialization",
            target.spec(),
            arch.as_str(),
        ));
    }

    Ok(None)
}

/// Resolve `target`, returning its on-disk path *and* the set of
/// transitively-resolved lib paths underneath it (its direct deps, their
/// deps, and so on — but NOT `target`'s own path; the caller adds that).
///
/// The transitive set lets the caller compose
/// `WASM_POSIX_DEP_PKG_CONFIG_PATH` for the build script: every node
/// gets every descendant's `lib/pkgconfig/` dir, which mirrors how
/// pkg-config follows `Requires.private` chains.
///
/// Deduped via `BTreeSet` so a diamond dep (`libZ -> {libA, libB} ->
/// libCommon`) only contributes `libCommon`'s path once.
fn ensure_built_inner(
    target: &DepsManifest,
    registry: &Registry,
    arch: TargetArch,
    abi_version: u32,
    opts: &ResolveOpts<'_>,
    memo: &mut BTreeMap<String, [u8; 32]>,
    building: &mut Vec<String>,
) -> Result<(PathBuf, BTreeSet<PathBuf>), String> {
    // Process-lifetime memo: the same (name, arch) often gets
    // requested multiple times within one resolver run via different
    // dep chains. Without this, mariadb wasm32 source-builds 4 times
    // in a single force-rebuild-all (lamp, mariadb, mariadb-test,
    // mariadb-vfs each independently demand it). See `build_memo`'s
    // doc comment for full rationale.
    // Compute the exact current identity before consulting the process memo.
    // `ensure_built()` supplies a fresh hash memo for every top-level call, so
    // an in-process build.toml edit cannot inherit the prior call's digest;
    // recursive lookups in one unchanged graph remain cheap memo hits.
    let mut identity_chain = Vec::new();
    let cache_identity = compute_sha(
        target,
        registry,
        arch,
        abi_version,
        memo,
        &mut identity_chain,
    )?;
    let was_force_rebuild = opts
        .force_source_build
        .map(|s| s.contains(&target.name))
        .unwrap_or(false);
    let memo_key: BuildMemoKey = (
        opts.cache_root.to_path_buf(),
        target.name.clone(),
        arch,
        cache_identity,
        was_force_rebuild,
        opts.fetch_only,
    );
    {
        let cache = build_memo().lock().unwrap();
        if let Some(cached) = cache.get(&memo_key) {
            return cached.clone();
        }
    }

    let result = ensure_built_uncached(target, registry, arch, abi_version, opts, memo, building);

    // Don't poison the cache with cycle errors — those reflect the
    // call stack at the moment of detection, not a stable property
    // of the manifest. Everything else (Ok path + non-cycle Err)
    // gets memoized.
    let should_memo = match &result {
        Ok(_) => true,
        Err(e) => !is_cycle_error(e),
    };
    if should_memo {
        build_memo()
            .lock()
            .unwrap()
            .insert(memo_key, result.clone());
    }
    result
}

fn ensure_built_uncached(
    target: &DepsManifest,
    registry: &Registry,
    arch: TargetArch,
    abi_version: u32,
    opts: &ResolveOpts<'_>,
    memo: &mut BTreeMap<String, [u8; 32]>,
    building: &mut Vec<String>,
) -> Result<(PathBuf, BTreeSet<PathBuf>), String> {
    if building.iter().any(|s| s == &target.name) {
        return Err(format!(
            "cycle while building: {} -> {}",
            building.join(" -> "),
            target.name
        ));
    }
    building.push(target.name.clone());

    if let Some(path) = try_fetch_without_deps(target, registry, arch, abi_version, opts, memo)? {
        building.pop();
        return Ok((path, BTreeSet::new()));
    }

    // Recursively resolve direct deps first; remember their paths so
    // we can surface them to the build script via env vars. The
    // transitive set accumulates every dep path in the subgraph,
    // deduped — diamond deps must only contribute once.
    //
    // We track each direct dep's `kind` alongside its path so that
    // `build_into_cache` can choose the env-var suffix per design 12:
    // library/program → `WASM_POSIX_DEP_<NAME>_DIR` (built artifact
    // root); source → `WASM_POSIX_DEP_<NAME>_SRC_DIR` (unbuilt source
    // tree). Build scripts then self-document what shape they're
    // consuming via the suffix.
    let mut dep_dirs: BTreeMap<String, DirectDep> = BTreeMap::new();
    let mut transitive: BTreeSet<PathBuf> = BTreeSet::new();
    for dref in &target.depends_on {
        let dep_m = registry.load(&dref.name)?;
        if dep_m.version != dref.version {
            return Err(format!(
                "{} depends on {}@{}, but registry has {}",
                target.spec(),
                dref.name,
                dref.version,
                dep_m.spec()
            ));
        }
        // Per the wasm64 build policy (memory/wasm64-build-policy.md):
        // only MariaDB and PHP need wasm64 binaries; everything else
        // is wasm32-only. So a wasm64 program (e.g. mariadb-vfs)
        // depending on a wasm32-only dep (e.g. dinit) is the common
        // case, not a misconfiguration. When the parent arch isn't in
        // the dep's target_arches, fall back to wasm32 (the universal
        // arch) for that dep. The resolver places the dep's binaries
        // under binaries/programs/wasm32/, where build scripts'
        // arch-agnostic tryResolveBinary("programs/<x>.wasm") finds
        // them. The kernel runs mixed-arch programs.
        let dep_arch = if dep_m.target_arches.contains(&arch) {
            arch
        } else if dep_m.target_arches.contains(&TargetArch::Wasm32) {
            TargetArch::Wasm32
        } else {
            return Err(format!(
                "{} depends on {}@{} (arch {}), but {} declares neither {} nor wasm32 in target_arches (declared: {:?})",
                target.spec(),
                dref.name,
                dref.version,
                arch.as_str(),
                dep_m.spec(),
                arch.as_str(),
                dep_m
                    .target_arches
                    .iter()
                    .map(|a| a.as_str())
                    .collect::<Vec<_>>(),
            ));
        };
        let (dep_path, dep_transitive) = ensure_built_inner(
            &dep_m,
            registry,
            dep_arch,
            abi_version,
            opts,
            memo,
            building,
        )?;
        // Place binaries/programs/<arch>/<output> symlinks for each
        // program dep so consumer build scripts can find them via
        // `tryResolveBinary("programs/<x>.wasm")`. Only kicks in when
        // the caller opts in with binaries_dir; other ensure_built
        // consumers leave binaries_dir = None and no symlinks land.
        // Library deps and source deps are linked at compile time via
        // WASM_POSIX_DEP_* env vars and don't need a binaries/ entry.
        if let Some(bdir) = opts.binaries_dir {
            if matches!(dep_m.kind, ManifestKind::Program) && !dep_m.program_outputs.is_empty() {
                place_binaries_symlinks(&dep_m, &dep_path, bdir, dep_arch)?;
            }
        }
        dep_dirs.insert(
            dep_m.name.clone(),
            DirectDep {
                path: dep_path.clone(),
                kind: dep_m.kind,
            },
        );
        transitive.insert(dep_path);
        transitive.extend(dep_transitive);
    }

    building.pop();

    // Local-libs override: hand-patched source wins. The override dir
    // still contributes to `transitive` for any consumer above us.
    if let Some(lr) = opts.local_libs {
        let override_dir = lr.join(&target.name).join("build");
        if override_dir.is_dir() {
            return Ok((override_dir, transitive));
        }
    }

    // Compute canonical cache path.
    let mut chain: Vec<String> = Vec::new();
    let sha = compute_sha(target, registry, arch, abi_version, memo, &mut chain)?;
    let canonical = canonical_path(opts.cache_root, target, arch, &sha);
    let cache_key_sha_hex = hex(&sha);

    let force_rebuild = opts
        .force_source_build
        .map(|s| s.contains(&target.name))
        .unwrap_or(false);

    // Cache hit: validate before using it. The cache key includes the
    // numeric kernel ABI, but fork-continuation mechanism changes have
    // previously produced stale artifacts with a matching ABI number
    // (legacy Asyncify exports instead of wpk_fork_*). Reject those so
    // the resolver can fetch a current remote artifact or source-build.
    if !force_rebuild && canonical.is_dir() {
        match validate_cache_entry(target, &canonical, arch, abi_version, &cache_key_sha_hex) {
            Ok(()) => return Ok((canonical, transitive)),
            Err(e) => {
                eprintln!(
                    "warning: ignoring stale cached artifact for {} at {} ({})",
                    target.spec(),
                    canonical.display(),
                    e,
                );
                remove_cache_entry(&canonical, &cache_key_sha_hex).map_err(|remove_err| {
                    format!(
                        "clear stale cache entry {} after validation failure: {remove_err}",
                        canonical.display()
                    )
                })?;
            }
        }
    }
    if force_rebuild && canonical.is_dir() {
        remove_cache_entry(&canonical, &cache_key_sha_hex)
            .map_err(|e| format!("force-rebuild: clear {}: {e}", canonical.display()))?;
    }

    // Run host-tool probes before any work that might invoke a build
    // script (or fetch+extract a source-kind tarball). Cache hits skip
    // this — probes are only needed when we might actually invoke
    // `bash build-<x>.sh` or similar work. Aggregate ALL probe
    // failures so users fix everything in one round-trip.
    if !target.host_tools.is_empty() {
        let mut failures: Vec<ProbeFailure> = Vec::new();
        for tool in &target.host_tools {
            if let Err(e) = host_tool_probe::probe(tool) {
                failures.push(e);
            }
        }
        if !failures.is_empty() {
            return Err(render_probe_failures(target, &failures));
        }
    }

    // Cache-miss dispatch. Three flavors of recipe:
    //
    //   (Source, None)     — default fetch+extract from `[source]`.
    //                        Source-kind manifests never carry
    //                        `[binary]` (Task C.1 enforces), so this
    //                        branch short-circuits before the binary
    //                        block.
    //   (Source, Some(_))  — override path (Task C.5): the manifest
    //                        ships its own build script (e.g. patch
    //                        overlay, git clone, multi-tarball
    //                        assembly). Run it through
    //                        `build_into_cache` with the standard
    //                        env-var contract; validation is
    //                        non-emptiness of OUT_DIR rather than a
    //                        declared outputs list.
    //   (Library | Program,_) — try `package.pr.toml` / source
    //                        `[binary]` direct archives first, then
    //                        the `build.toml` index path, then fall
    //                        back to the build script.
    match (target.kind, target.build.script_path.is_some()) {
        (ManifestKind::Source, false) => {
            if opts.fetch_only {
                return Err(format!(
                    "{}: fetch-only resolve cannot fetch source package fallback for arch {}",
                    target.spec(),
                    arch.as_str(),
                ));
            }
            let parent = canonical
                .parent()
                .ok_or_else(|| format!("canonical path has no parent: {}", canonical.display()))?;
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("create cache parent {}: {e}", parent.display()))?;
            let tmp = parent.join(format!(
                "{}.tmp-{}",
                canonical
                    .file_name()
                    .expect("canonical path has a filename")
                    .to_string_lossy(),
                std::process::id()
            ));
            if tmp.exists() {
                std::fs::remove_dir_all(&tmp)
                    .map_err(|e| format!("clean stale {}: {e}", tmp.display()))?;
            }
            if let Err(e) =
                source_extract::fetch_and_extract(&target.source.url, &target.source.sha256, &tmp)
            {
                let _ = std::fs::remove_dir_all(&tmp);
                return Err(format!(
                    "{}: source fetch+extract failed: {e}",
                    target.spec()
                ));
            }
            if let Err(e) =
                write_cache_provenance(target, &canonical, arch, abi_version, &cache_key_sha_hex)
            {
                let _ = std::fs::remove_dir_all(&tmp);
                return Err(e);
            }
            // Race against a peer process that finished its own extract
            // first: keep theirs, drop ours. Identical inputs produce
            // identical outputs.
            if canonical.exists() {
                let _ = std::fs::remove_dir_all(&tmp);
                validate_cache_entry(target, &canonical, arch, abi_version, &cache_key_sha_hex)?;
                return Ok((canonical, transitive));
            }
            std::fs::rename(&tmp, &canonical)
                .map_err(|e| format!("rename {} -> {}: {e}", tmp.display(), canonical.display()))?;
            Ok((canonical, transitive))
        }
        (ManifestKind::Source, true) => {
            if opts.fetch_only {
                return Err(format!(
                    "{}: fetch-only resolve cannot run source package build script for arch {}",
                    target.spec(),
                    arch.as_str(),
                ));
            }
            // Override path: run the script. No remote-binary fetch for
            // sources (`[binary]` is rejected at parse time for source
            // kind), so we go straight to `build_into_cache`.
            let pkgconfig_path = compose_pkgconfig_path(&transitive);
            let repo_root = opts
                .repo_root
                .map(Path::to_path_buf)
                .unwrap_or_else(crate::repo_root);
            build_into_cache(
                target,
                arch,
                abi_version,
                &cache_key_sha_hex,
                &canonical,
                &dep_dirs,
                &pkgconfig_path,
                &repo_root,
            )?;
            Ok((canonical, transitive))
        }
        (ManifestKind::Library | ManifestKind::Program, _) => {
            // Resolution priority 3a: direct archive fetch from the
            // source manifest's `[binary]` map. In normal source
            // package.toml files this map is empty post index-ledger
            // migration, but CI writes sibling `package.pr.toml`
            // overlays with direct file:// archives for same-run
            // matrix outputs. Those must win over the durable
            // `build.toml` index below.
            //
            // Resolution priority 3b: index-based remote fetch. The
            // resolver loads the sibling `build.toml`, resolves its
            // `[binary]` block to an index URL (or a direct archive
            // URL), then looks up this package's entry. Status
            // `success` fetches the current archive; status
            // `failed`/`pending`/`building` falls back to the
            // last-green `fallback_*` archive when one is preserved.
            //
            // Any failure along the way logs and falls through to the
            // source build — a remote-fetch error should never cause
            // the resolver to refuse to produce an artifact.
            //
            // `force_rebuild` short-circuits remote fetch entirely.
            if !force_rebuild {
                if let Some(binary) = target.binary.get(&arch) {
                    match remote_fetch::fetch_and_install(
                        binary,
                        &canonical,
                        target,
                        arch,
                        abi_version,
                        &cache_key_sha_hex,
                    ) {
                        Ok(()) => match validate_cache_entry(
                            target,
                            &canonical,
                            arch,
                            abi_version,
                            &cache_key_sha_hex,
                        ) {
                            Ok(()) => return Ok((canonical, transitive)),
                            Err(e) => {
                                eprintln!(
                                    "warning: direct binary fetch for {} from {} produced \
                                     a stale artifact ({}); {}",
                                    target.spec(),
                                    binary.archive_url,
                                    e,
                                    fetch_fallback_phrase(opts.fetch_only),
                                );
                                let _ = remove_cache_entry(&canonical, &cache_key_sha_hex);
                            }
                        },
                        Err(e) => {
                            eprintln!(
                                "warning: direct binary fetch for {} from {} failed ({}); \
                                 {}",
                                target.spec(),
                                binary.archive_url,
                                e,
                                fetch_fallback_phrase(opts.fetch_only),
                            );
                        }
                    }
                }
                if let Some(()) = try_index_install(
                    target,
                    arch,
                    abi_version,
                    &canonical,
                    &cache_key_sha_hex,
                    opts.fetch_only,
                ) {
                    return Ok((canonical, transitive));
                }
            }

            if opts.fetch_only {
                return Err(format!(
                    "{}: fetch-only resolve could not install a valid archive for arch {}; \
                     package staging or the durable release must provide one",
                    target.spec(),
                    arch.as_str(),
                ));
            }

            let pkgconfig_path = compose_pkgconfig_path(&transitive);
            let repo_root = opts
                .repo_root
                .map(Path::to_path_buf)
                .unwrap_or_else(crate::repo_root);
            build_into_cache(
                target,
                arch,
                abi_version,
                &cache_key_sha_hex,
                &canonical,
                &dep_dirs,
                &pkgconfig_path,
                &repo_root,
            )?;
            Ok((canonical, transitive))
        }
    }
}

/// Attempt to install a prebuilt archive from this package's
/// `build.toml`-declared binary source. Returns `Some(())` on success
/// (caller returns the canonical path); returns `None` for any
/// "fall through to source build" condition (no build.toml, no
/// archive in the index, network failure, sha mismatch, etc.).
///
/// Logging is on stderr (matching the prior remote-fetch
/// implementation's UX): users see warnings about why the index
/// path was skipped. Normal resolves then build from source; fetch-only
/// resolves turn the miss into an error at the caller.
fn fetch_fallback_phrase(fetch_only: bool) -> &'static str {
    if fetch_only {
        "source builds disabled by fetch-only mode"
    } else {
        "falling back to source build"
    }
}

fn try_index_install(
    target: &DepsManifest,
    arch: TargetArch,
    abi_version: u32,
    canonical: &Path,
    cache_key_sha_hex: &str,
    fetch_only: bool,
) -> Option<()> {
    // 1. Load build.toml. Source manifests without one (e.g. an
    //    upstream package that hasn't been ported to the new schema
    //    yet) fall through silently — Phase 9's migration should
    //    leave every first-party package with a build.toml; the
    //    silent fall-through is for clean integration with
    //    third-party manifests that might not.
    let build = BuildToml::load(&target.dir).ok()?;

    // 2. Resolve the binary source to a concrete URL pair. Direct
    //    form: use the URL + sha verbatim. Indexed form: fetch
    //    index.toml + look up this package. CI can override indexed
    //    URLs with WASM_POSIX_BINARY_INDEX_URL so staging/prepare
    //    jobs consume the release they are publishing instead of the
    //    committed durable-release default.
    let (archive_url, archive_sha256) = match &build.binary {
        BinarySource::Direct { url, sha256 } => (url.clone(), sha256.clone()),
        BinarySource::Indexed { .. } => {
            let index_url = std::env::var("WASM_POSIX_BINARY_INDEX_URL")
                .ok()
                .filter(|s| !s.is_empty())
                .or_else(|| build.binary.resolve_index_url(abi_version))?;
            let cache_dir = default_cache_root().join("indexes");
            let index = match index_toml::fetch_index(&index_url, &cache_dir) {
                Ok(idx) => idx,
                Err(e) => {
                    eprintln!(
                        "warning: index fetch for {} from {} failed ({}); \
                         {}",
                        target.spec(),
                        index_url,
                        e,
                        fetch_fallback_phrase(fetch_only),
                    );
                    return None;
                }
            };
            if index.abi_version != abi_version {
                eprintln!(
                    "warning: index for {} from {} declares ABI {}, but resolver ABI is {}; \
                     {}",
                    target.spec(),
                    index_url,
                    index.abi_version,
                    abi_version,
                    fetch_fallback_phrase(fetch_only),
                );
                return None;
            }
            let entry = match index.lookup(&target.name, &target.version, arch) {
                Some(e) => e,
                None => {
                    eprintln!(
                        "warning: no index entry for {} in {}; \
                         {}",
                        target.spec(),
                        index_url,
                        fetch_fallback_phrase(fetch_only),
                    );
                    return None;
                }
            };
            // Pick the authoritative archive fields for the entry's
            // current status. Success → current archive_*; other
            // statuses → fallback_* if preserved; otherwise nothing
            // usable and we fall through.
            let (rel_url, sha) = match entry.status {
                EntryStatus::Success
                    if entry.archive_url.is_some() && entry.archive_sha256.is_some() =>
                {
                    (
                        entry.archive_url.as_ref().unwrap().clone(),
                        entry.archive_sha256.as_ref().unwrap().clone(),
                    )
                }
                EntryStatus::Failed | EntryStatus::Pending | EntryStatus::Building
                    if entry.fallback_archive_url.is_some()
                        && entry.fallback_archive_sha256.is_some() =>
                {
                    eprintln!(
                        "note: {} index entry is status={:?}; \
                         using last-green fallback archive",
                        target.spec(),
                        entry.status,
                    );
                    (
                        entry.fallback_archive_url.as_ref().unwrap().clone(),
                        entry.fallback_archive_sha256.as_ref().unwrap().clone(),
                    )
                }
                _ => {
                    eprintln!(
                        "warning: {} index entry status={:?} has no usable archive; \
                         {}",
                        target.spec(),
                        entry.status,
                        fetch_fallback_phrase(fetch_only),
                    );
                    return None;
                }
            };
            (resolve_relative_url(&index_url, &rel_url), sha)
        }
    };

    // 3. Fetch + verify + install. Any failure (sha mismatch, arch
    //    mismatch, abi mismatch, cache_key mismatch, transport
    //    error) falls through.
    match remote_fetch::fetch_and_install_direct(
        &archive_url,
        &archive_sha256,
        canonical,
        target,
        arch,
        abi_version,
        cache_key_sha_hex,
    ) {
        Ok(()) => {
            match validate_cache_entry(target, canonical, arch, abi_version, cache_key_sha_hex) {
                Ok(()) => Some(()),
                Err(e) => {
                    eprintln!(
                        "warning: index-based fetch for {} from {} produced \
                     a stale artifact ({}); {}",
                        target.spec(),
                        archive_url,
                        e,
                        fetch_fallback_phrase(fetch_only),
                    );
                    let _ = remove_cache_entry(canonical, cache_key_sha_hex);
                    None
                }
            }
        }
        Err(e) => {
            eprintln!(
                "warning: index-based fetch for {} from {} failed ({}); \
                 {}",
                target.spec(),
                archive_url,
                e,
                fetch_fallback_phrase(fetch_only),
            );
            None
        }
    }
}

/// Resolve `rel` against `base` for archive-URL lookup. If `rel`
/// already carries a scheme (`file://` / `http://` / `https://`) it
/// passes through unchanged; otherwise it's appended to `base`'s
/// parent directory (i.e. `https://host/dir/index.toml` + `foo.tar.zst`
/// → `https://host/dir/foo.tar.zst`).
fn resolve_relative_url(base: &str, rel: &str) -> String {
    if rel.starts_with("file://") || rel.starts_with("http://") || rel.starts_with("https://") {
        return rel.to_string();
    }
    // Strip the last path segment of `base` and join with `rel`.
    let last_slash = base.rfind('/').map(|i| i + 1).unwrap_or(0);
    let mut out = String::with_capacity(last_slash + rel.len());
    out.push_str(&base[..last_slash]);
    out.push_str(rel);
    out
}

/// Build the `WASM_POSIX_DEP_PKG_CONFIG_PATH` value for a build script.
///
/// Joins every transitive lib path's `lib/pkgconfig/` subdirectory with
/// `:` — POSIX's standard search-path separator, and what pkg-config
/// itself uses for `PKG_CONFIG_PATH`. Paths whose `lib/pkgconfig/`
/// directory doesn't exist (e.g. ncurses, libs that ship no .pc file)
/// are skipped: handing pkg-config a list of nonexistent search paths
/// clutters diagnostics with no benefit.
///
/// Returns an empty string when no transitive lib ships pkgconfig. The
/// caller still sets the env var to that empty string, keeping the
/// contract uniform: the var is *always* defined for build scripts.
fn compose_pkgconfig_path(paths: &BTreeSet<PathBuf>) -> String {
    paths
        .iter()
        .filter_map(|p| {
            let pc = p.join("lib").join("pkgconfig");
            if pc.is_dir() {
                Some(pc.to_string_lossy().into_owned())
            } else {
                None
            }
        })
        .collect::<Vec<_>>()
        .join(":")
}

#[derive(Debug)]
struct ProvisionedGitInput {
    declaration: GitBuildInput,
    checkout: PathBuf,
    worktree_digest: [u8; 32],
}

#[derive(Debug)]
struct GitCommandIsolation {
    home: PathBuf,
    xdg_config_home: PathBuf,
    empty_templates: PathBuf,
    empty_hooks: PathBuf,
    askpass: PathBuf,
}

/// Temporary, detached checkouts for a package's declared `git_inputs`.
/// Dropping the guard removes every checkout, including error paths.
#[derive(Debug, Default)]
struct ProvisionedGitInputs {
    root: Option<PathBuf>,
    isolation: Option<GitCommandIsolation>,
    inputs: Vec<ProvisionedGitInput>,
}

impl ProvisionedGitInputs {
    fn provision(target: &DepsManifest, canonical: &Path) -> Result<Self, String> {
        let build_path = target.dir.join("build.toml");
        if !build_path.exists() {
            return Ok(Self::default());
        }
        let declarations = BuildToml::load(&target.dir)?.git_inputs;
        if declarations.is_empty() {
            return Ok(Self::default());
        }

        Self::provision_declarations(&target.spec(), canonical, declarations)
    }

    fn provision_declarations(
        package_spec: &str,
        canonical: &Path,
        declarations: Vec<GitBuildInput>,
    ) -> Result<Self, String> {
        Self::provision_declarations_inner(package_spec, canonical, declarations, &[])
    }

    #[cfg(test)]
    fn provision_declarations_with_ambient_env(
        package_spec: &str,
        canonical: &Path,
        declarations: Vec<GitBuildInput>,
        ambient_env: &[(std::ffi::OsString, std::ffi::OsString)],
    ) -> Result<Self, String> {
        Self::provision_declarations_inner(package_spec, canonical, declarations, ambient_env)
    }

    fn provision_declarations_inner(
        package_spec: &str,
        canonical: &Path,
        declarations: Vec<GitBuildInput>,
        ambient_env: &[(std::ffi::OsString, std::ffi::OsString)],
    ) -> Result<Self, String> {
        let parent = canonical.parent().ok_or_else(|| {
            format!(
                "{}: canonical cache path has no parent for git inputs: {}",
                package_spec,
                canonical.display()
            )
        })?;
        let basename = canonical
            .file_name()
            .ok_or_else(|| {
                format!(
                    "canonical cache path has no filename: {}",
                    canonical.display()
                )
            })?
            .to_string_lossy();
        let root = create_git_input_root(parent, &basename)?;

        let mut provisioned = Self {
            root: Some(root.clone()),
            isolation: None,
            inputs: Vec::with_capacity(declarations.len()),
        };
        let isolation = create_git_command_isolation(&root)?;
        let checkouts = root.join("checkouts");
        std::fs::create_dir(&checkouts).map_err(|e| {
            format!(
                "create immutable git-input checkout root {}: {e}",
                checkouts.display()
            )
        })?;
        provisioned.isolation = Some(isolation);
        for declaration in declarations {
            let isolation = provisioned
                .isolation
                .as_ref()
                .expect("git command isolation was initialized");
            let checkout = checkouts.join(&declaration.name);
            std::fs::create_dir(&checkout)
                .map_err(|e| format!("create git-input checkout {}: {e}", checkout.display()))?;
            run_git(
                &checkout,
                &["init", "--quiet", "--object-format=sha1"],
                &declaration.repository,
                isolation,
                ambient_env,
            )?;
            run_git(
                &checkout,
                &[
                    "fetch",
                    "--quiet",
                    "--depth=1",
                    "--no-tags",
                    "--no-recurse-submodules",
                    &declaration.repository,
                    &declaration.commit,
                ],
                &declaration.repository,
                isolation,
                ambient_env,
            )?;
            run_git(
                &checkout,
                &["checkout", "--quiet", "--detach", "FETCH_HEAD"],
                &declaration.repository,
                isolation,
                ambient_env,
            )?;
            verify_git_input(&declaration, &checkout, isolation, ambient_env)?;
            validate_git_input_tree(&declaration, &checkout, isolation, ambient_env)?;
            let worktree_digest = digest_git_input_worktree(&checkout)?;
            set_git_input_tree_read_only(&checkout, true)?;
            provisioned.inputs.push(ProvisionedGitInput {
                declaration,
                checkout,
                worktree_digest,
            });
        }
        // Seal the containing directory as well as each checkout. Otherwise a
        // build that cannot edit files could still rename or replace the path
        // exported in WASM_POSIX_BUILD_GIT_*_DIR.
        set_git_input_tree_read_only(&root, true)?;
        Ok(provisioned)
    }

    fn export_to(&self, command: &mut Command) {
        for input in &self.inputs {
            let key = input.declaration.name.to_ascii_uppercase();
            command.env(format!("WASM_POSIX_BUILD_GIT_{key}_DIR"), &input.checkout);
            command.env(
                format!("WASM_POSIX_BUILD_GIT_{key}_COMMIT"),
                &input.declaration.commit,
            );
        }
    }

    fn verify_unchanged(&self) -> Result<(), String> {
        if self.inputs.is_empty() {
            return Ok(());
        }
        let isolation = self
            .isolation
            .as_ref()
            .ok_or_else(|| "immutable Git inputs lack command isolation".to_string())?;
        for input in &self.inputs {
            verify_git_input(&input.declaration, &input.checkout, isolation, &[])?;
            validate_git_input_tree(&input.declaration, &input.checkout, isolation, &[])?;
            let actual_digest = digest_git_input_worktree(&input.checkout)?;
            if actual_digest != input.worktree_digest {
                return Err(format!(
                    "git input {:?}: immutable working-tree digest changed during build",
                    input.declaration.name
                ));
            }
        }
        Ok(())
    }
}

impl Drop for ProvisionedGitInputs {
    fn drop(&mut self) {
        if let Some(root) = self.root.take() {
            let _ = set_git_input_tree_read_only(&root, false);
            let _ = std::fs::remove_dir_all(root);
        }
    }
}

static GIT_INPUT_TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

fn create_git_input_root(parent: &Path, basename: &str) -> Result<PathBuf, String> {
    for _ in 0..10_000 {
        let counter = GIT_INPUT_TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let root = parent.join(format!(
            ".{basename}.git-inputs-{}-{counter}",
            std::process::id()
        ));
        match std::fs::create_dir(&root) {
            Ok(()) => {
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700))
                        .map_err(|e| {
                            format!(
                                "set exclusive git-input root permissions {}: {e}",
                                root.display()
                            )
                        })?;
                }
                return Ok(root);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => {
                return Err(format!(
                    "create exclusive git-input root {}: {e}",
                    root.display()
                ));
            }
        }
    }
    Err(format!(
        "could not allocate an exclusive git-input root below {}",
        parent.display()
    ))
}

fn create_git_command_isolation(root: &Path) -> Result<GitCommandIsolation, String> {
    let home = root.join("home");
    let xdg_config_home = root.join("xdg-config");
    let empty_templates = root.join("empty-templates");
    let empty_hooks = root.join("empty-hooks");
    for path in [&home, &xdg_config_home, &empty_templates, &empty_hooks] {
        std::fs::create_dir(path)
            .map_err(|e| format!("create isolated Git directory {}: {e}", path.display()))?;
    }

    let askpass = root.join("askpass-deny.sh");
    std::fs::write(&askpass, "#!/bin/sh\nexit 1\n")
        .map_err(|e| format!("write isolated Git askpass {}: {e}", askpass.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&askpass, std::fs::Permissions::from_mode(0o500))
            .map_err(|e| format!("seal isolated Git askpass {}: {e}", askpass.display()))?;
    }

    Ok(GitCommandIsolation {
        home,
        xdg_config_home,
        empty_templates,
        empty_hooks,
        askpass,
    })
}

/// Construct a Git subprocess that cannot inherit source credentials, token
/// headers, hooks, or repository selection from the caller's environment.
/// Build-time Git inputs are public source inputs; a private checkout would be
/// both unreproducible and an accidental credential dependency.
fn hardened_git_command(
    repository: &str,
    isolation: &GitCommandIsolation,
    ambient_env: &[(std::ffi::OsString, std::ffi::OsString)],
) -> Command {
    let mut command = Command::new("git");
    // Test callers can inject a hostile ambient environment without mutating
    // process-global state. Production passes an empty slice; Command still
    // begins with the real inherited environment in both cases.
    command.envs(ambient_env.iter().cloned());
    command
        .arg("-c")
        .arg(format!(
            "core.hooksPath={}",
            isolation.empty_hooks.to_string_lossy()
        ))
        .arg("-c")
        .arg(format!(
            "init.templateDir={}",
            isolation.empty_templates.to_string_lossy()
        ))
        .arg("-c")
        .arg("credential.helper=")
        .arg("-c")
        .arg("credential.interactive=false")
        .arg("-c")
        .arg("http.extraHeader=")
        .arg("-c")
        .arg("http.cookieFile=")
        .arg("-c")
        .arg("http.saveCookies=false")
        .arg("-c")
        .arg("http.followRedirects=false")
        .arg("-c")
        .arg("submodule.recurse=false")
        .arg("-c")
        .arg("core.autocrlf=false")
        .arg("-c")
        .arg("core.eol=lf")
        .env("HOME", &isolation.home)
        .env("XDG_CONFIG_HOME", &isolation.xdg_config_home)
        .env("GIT_ATTR_NOSYSTEM", "1")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_SYSTEM", "/dev/null")
        .env("GIT_CONFIG_COUNT", "0")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_ASKPASS", &isolation.askpass)
        .env("GIT_ASKPASS_REQUIRE", "force")
        .env("SSH_ASKPASS", &isolation.askpass)
        .env("SSH_ASKPASS_REQUIRE", "force")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_DEFAULT_HASH", "sha1")
        .env("GIT_NO_REPLACE_OBJECTS", "1")
        .env("GIT_PROTOCOL_FROM_USER", "0")
        .env(
            "GIT_ALLOW_PROTOCOL",
            if repository.starts_with("file://") {
                // Private test helpers construct local repositories directly;
                // BuildToml validation makes this unreachable for real inputs.
                "https:file"
            } else {
                "https"
            },
        );

    for key in [
        "GH_TOKEN",
        "GITHUB_TOKEN",
        "HOMEBREW_GITHUB_PACKAGES_TOKEN",
        "HOMEBREW_GITHUB_API_TOKEN",
        "HOMEBREW_DOCKER_REGISTRY_TOKEN",
        "GIT_DIR",
        "GIT_COMMON_DIR",
        "GIT_WORK_TREE",
        "GIT_INDEX_FILE",
        "GIT_OBJECT_DIRECTORY",
        "GIT_ALTERNATE_OBJECT_DIRECTORIES",
        "GIT_CONFIG_PARAMETERS",
        "GIT_CONFIG",
        "GIT_SSH",
        "GIT_SSH_COMMAND",
        "GIT_TEMPLATE_DIR",
        "GIT_EXEC_PATH",
        "GIT_PROXY_COMMAND",
        "GIT_NAMESPACE",
        "GIT_REPLACE_REF_BASE",
        "GIT_SHALLOW_FILE",
        "GIT_GRAFT_FILE",
        "GIT_CEILING_DIRECTORIES",
        "GIT_DISCOVERY_ACROSS_FILESYSTEM",
        "GIT_EXTERNAL_DIFF",
        "GIT_DIFF_OPTS",
        "GIT_EDITOR",
        "GIT_PAGER",
        "GIT_TRACE",
        "GIT_TRACE2",
        "GIT_TRACE_CURL",
        "GIT_CURL_VERBOSE",
        "NETRC",
        "SSH_AUTH_SOCK",
    ] {
        command.env_remove(key);
    }
    for (key, _) in std::env::vars_os().chain(ambient_env.iter().cloned()) {
        let key_text = key.to_string_lossy();
        if key_text.starts_with("GIT_CONFIG_KEY_")
            || key_text.starts_with("GIT_CONFIG_VALUE_")
            || key_text.starts_with("GIT_TRACE_")
        {
            command.env_remove(key);
        }
    }
    command
}

fn git_output(
    checkout: &Path,
    args: &[&str],
    repository: &str,
    isolation: &GitCommandIsolation,
    ambient_env: &[(std::ffi::OsString, std::ffi::OsString)],
) -> Result<std::process::Output, String> {
    let mut command = hardened_git_command(repository, isolation, ambient_env);
    let output = command
        .arg("-C")
        .arg(checkout)
        .args(args)
        .output()
        .map_err(|e| format!("spawn isolated git in {}: {e}", checkout.display()))?;
    Ok(output)
}

fn run_git(
    checkout: &Path,
    args: &[&str],
    repository: &str,
    isolation: &GitCommandIsolation,
    ambient_env: &[(std::ffi::OsString, std::ffi::OsString)],
) -> Result<(), String> {
    let output = git_output(checkout, args, repository, isolation, ambient_env)?;
    if output.status.success() {
        return Ok(());
    }
    Err(format!(
        "isolated git {:?} failed in {} with {}: {}",
        args,
        checkout.display(),
        output.status,
        String::from_utf8_lossy(&output.stderr).trim()
    ))
}

fn verify_git_input(
    input: &GitBuildInput,
    checkout: &Path,
    isolation: &GitCommandIsolation,
    ambient_env: &[(std::ffi::OsString, std::ffi::OsString)],
) -> Result<(), String> {
    let head = git_output(
        checkout,
        &["rev-parse", "HEAD^{commit}"],
        &input.repository,
        isolation,
        ambient_env,
    )?;
    if !head.status.success() {
        return Err(format!(
            "git input {:?}: cannot resolve detached HEAD in {}: {}",
            input.name,
            checkout.display(),
            String::from_utf8_lossy(&head.stderr).trim()
        ));
    }
    let actual = String::from_utf8_lossy(&head.stdout).trim().to_string();
    if actual != input.commit {
        return Err(format!(
            "git input {:?}: expected commit {}, checkout has {}",
            input.name, input.commit, actual
        ));
    }

    let branch = git_output(
        checkout,
        &["rev-parse", "--abbrev-ref", "HEAD"],
        &input.repository,
        isolation,
        ambient_env,
    )?;
    if !branch.status.success() || String::from_utf8_lossy(&branch.stdout).trim() != "HEAD" {
        return Err(format!(
            "git input {:?}: checkout must remain at a detached HEAD",
            input.name
        ));
    }

    let status = git_output(
        checkout,
        &[
            "status",
            "--porcelain=v1",
            "--untracked-files=all",
            "--ignored=matching",
        ],
        &input.repository,
        isolation,
        ambient_env,
    )?;
    if !status.status.success() {
        return Err(format!(
            "git input {:?}: cannot verify clean checkout: {}",
            input.name,
            String::from_utf8_lossy(&status.stderr).trim()
        ));
    }
    if !status.stdout.is_empty() {
        return Err(format!(
            "git input {:?}: build mutated immutable checkout {}:\n{}",
            input.name,
            checkout.display(),
            String::from_utf8_lossy(&status.stdout).trim()
        ));
    }
    Ok(())
}

fn validate_git_input_tree(
    input: &GitBuildInput,
    checkout: &Path,
    isolation: &GitCommandIsolation,
    ambient_env: &[(std::ffi::OsString, std::ffi::OsString)],
) -> Result<(), String> {
    let index = git_output(
        checkout,
        &["ls-files", "--stage", "-z"],
        &input.repository,
        isolation,
        ambient_env,
    )?;
    if !index.status.success() {
        return Err(format!(
            "git input {:?}: cannot inspect index: {}",
            input.name,
            String::from_utf8_lossy(&index.stderr).trim()
        ));
    }
    for record in index
        .stdout
        .split(|byte| *byte == 0)
        .filter(|record| !record.is_empty())
    {
        let metadata = record.split(|byte| *byte == b'\t').next().unwrap_or(record);
        let mode = metadata
            .split(|byte| *byte == b' ')
            .next()
            .unwrap_or(metadata);
        if mode == b"160000" {
            return Err(format!(
                "git input {:?}: submodule gitlinks are not allowed in immutable build inputs",
                input.name
            ));
        }
    }

    let canonical = std::fs::canonicalize(checkout)
        .map_err(|e| format!("resolve git input root {}: {e}", checkout.display()))?;
    let git_metadata_path = checkout.join(".git");
    let git_metadata_lstat = std::fs::symlink_metadata(&git_metadata_path).map_err(|e| {
        format!(
            "inspect git input metadata directory {}: {e}",
            git_metadata_path.display()
        )
    })?;
    if !git_metadata_lstat.is_dir() || git_metadata_lstat.file_type().is_symlink() {
        return Err(format!(
            "git input {:?}: .git must be a real non-symlink directory inside its checkout",
            input.name
        ));
    }
    let git_metadata = std::fs::canonicalize(&git_metadata_path).map_err(|e| {
        format!(
            "resolve git input metadata directory {}: {e}",
            checkout.join(".git").display()
        )
    })?;
    if !git_metadata.starts_with(&canonical) {
        return Err(format!(
            "git input {:?}: .git resolves outside immutable checkout {}",
            input.name,
            checkout.display()
        ));
    }
    validate_git_input_tree_entries(input, checkout, checkout, &canonical, &git_metadata)
}

fn validate_git_input_tree_entries(
    input: &GitBuildInput,
    checkout: &Path,
    directory: &Path,
    canonical: &Path,
    git_metadata: &Path,
) -> Result<(), String> {
    let mut entries = std::fs::read_dir(directory)
        .map_err(|e| format!("read git input directory {}: {e}", directory.display()))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("read git input entry below {}: {e}", directory.display()))?;
    entries.sort_by_key(|entry| entry.path());
    for entry in entries {
        let path = entry.path();
        if directory == checkout && entry.file_name() == ".git" {
            continue;
        }
        let metadata = std::fs::symlink_metadata(&path)
            .map_err(|e| format!("stat git input entry {}: {e}", path.display()))?;
        if metadata.file_type().is_symlink() {
            let resolved = std::fs::canonicalize(&path).map_err(|e| {
                format!(
                    "git input {:?}: symlink {} cannot be resolved inside its checkout: {e}",
                    input.name,
                    path.display()
                )
            })?;
            if !resolved.starts_with(canonical) {
                return Err(format!(
                    "git input {:?}: symlink {} escapes immutable checkout {}",
                    input.name,
                    path.display(),
                    checkout.display()
                ));
            }
            if resolved == git_metadata || resolved.starts_with(git_metadata) {
                return Err(format!(
                    "git input {:?}: symlink {} resolves into private Git metadata {}",
                    input.name,
                    path.display(),
                    git_metadata.display()
                ));
            }
        } else if metadata.is_dir() {
            validate_git_input_tree_entries(input, checkout, &path, canonical, git_metadata)?;
        } else if !metadata.is_file() {
            return Err(format!(
                "git input {:?}: {} is not a regular file, directory, or contained symlink",
                input.name,
                path.display()
            ));
        }
    }
    Ok(())
}

/// Hash the exported working tree independently of Git's index/status view.
/// A build can toggle index flags such as `assume-unchanged`; it cannot make a
/// byte, symlink target, path, or executable-bit mutation disappear from this
/// resolver-owned digest.
fn digest_git_input_worktree(checkout: &Path) -> Result<[u8; 32], String> {
    let mut hasher = Sha256::new();
    hasher.update(b"kandelo-immutable-git-working-tree-v1\0");
    digest_git_input_directory(checkout, checkout, &mut hasher)?;
    Ok(hasher.finalize().into())
}

fn digest_git_input_directory(
    checkout: &Path,
    directory: &Path,
    hasher: &mut Sha256,
) -> Result<(), String> {
    let mut entries = std::fs::read_dir(directory)
        .map_err(|e| format!("read immutable Git tree {}: {e}", directory.display()))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("read immutable Git tree entry {}: {e}", directory.display()))?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        if directory == checkout && entry.file_name() == ".git" {
            continue;
        }
        let path = entry.path();
        let relative = path
            .strip_prefix(checkout)
            .map_err(|_| format!("immutable Git path escaped checkout: {}", path.display()))?;
        let path_bytes = relative.as_os_str().as_encoded_bytes();
        let metadata = std::fs::symlink_metadata(&path)
            .map_err(|e| format!("stat immutable Git path {}: {e}", path.display()))?;
        if metadata.file_type().is_symlink() {
            let target = std::fs::read_link(&path)
                .map_err(|e| format!("read immutable Git symlink {}: {e}", path.display()))?;
            hasher.update(b"symlink\0");
            hasher.update((path_bytes.len() as u64).to_le_bytes());
            hasher.update(path_bytes);
            let target_bytes = target.as_os_str().as_encoded_bytes();
            hasher.update((target_bytes.len() as u64).to_le_bytes());
            hasher.update(target_bytes);
        } else if metadata.is_dir() {
            hasher.update(b"directory\0");
            hasher.update((path_bytes.len() as u64).to_le_bytes());
            hasher.update(path_bytes);
            digest_git_input_directory(checkout, &path, hasher)?;
        } else if metadata.is_file() {
            hasher.update(b"file\0");
            hasher.update((path_bytes.len() as u64).to_le_bytes());
            hasher.update(path_bytes);
            hasher.update([git_input_file_is_executable(&metadata) as u8]);
            hasher.update(metadata.len().to_le_bytes());
            let mut file = std::fs::File::open(&path)
                .map_err(|e| format!("open immutable Git file {}: {e}", path.display()))?;
            std::io::copy(&mut file, hasher)
                .map_err(|e| format!("hash immutable Git file {}: {e}", path.display()))?;
        } else {
            return Err(format!(
                "immutable Git path is not a file, directory, or symlink: {}",
                path.display()
            ));
        }
    }
    Ok(())
}

#[cfg(unix)]
fn git_input_file_is_executable(metadata: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    metadata.permissions().mode() & 0o111 != 0
}

#[cfg(not(unix))]
fn git_input_file_is_executable(_metadata: &std::fs::Metadata) -> bool {
    false
}

#[cfg(unix)]
fn set_git_input_tree_read_only(path: &Path, read_only: bool) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;

    let metadata = std::fs::symlink_metadata(path)
        .map_err(|e| format!("stat immutable git input {}: {e}", path.display()))?;
    if metadata.file_type().is_symlink() {
        return Ok(());
    }
    if metadata.is_dir() && !read_only {
        let mut permissions = metadata.permissions();
        permissions.set_mode(permissions.mode() | 0o700);
        std::fs::set_permissions(path, permissions)
            .map_err(|e| format!("unseal git input directory {}: {e}", path.display()))?;
    }
    if metadata.is_dir() {
        let entries = std::fs::read_dir(path)
            .map_err(|e| format!("read immutable git input {}: {e}", path.display()))?;
        for entry in entries {
            let entry = entry.map_err(|e| format!("read immutable git input entry: {e}"))?;
            set_git_input_tree_read_only(&entry.path(), read_only)?;
        }
    }
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|e| format!("restat immutable git input {}: {e}", path.display()))?;
    let mut permissions = metadata.permissions();
    if read_only {
        permissions.set_mode(permissions.mode() & !0o222);
    } else {
        permissions.set_mode(permissions.mode() | 0o600);
    }
    std::fs::set_permissions(path, permissions).map_err(|e| {
        format!(
            "{} immutable git input {}: {e}",
            if read_only { "seal" } else { "unseal" },
            path.display()
        )
    })
}

#[cfg(not(unix))]
fn set_git_input_tree_read_only(path: &Path, read_only: bool) -> Result<(), String> {
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|e| format!("stat immutable git input {}: {e}", path.display()))?;
    if metadata.file_type().is_symlink() {
        return Ok(());
    }
    if metadata.is_dir() && !read_only {
        let mut permissions = metadata.permissions();
        permissions.set_readonly(false);
        std::fs::set_permissions(path, permissions)
            .map_err(|e| format!("unseal git input directory {}: {e}", path.display()))?;
    }
    if metadata.is_dir() {
        for entry in std::fs::read_dir(path)
            .map_err(|e| format!("read immutable git input {}: {e}", path.display()))?
        {
            let entry = entry.map_err(|e| format!("read immutable git input entry: {e}"))?;
            set_git_input_tree_read_only(&entry.path(), read_only)?;
        }
    }
    let mut permissions = std::fs::symlink_metadata(path)
        .map_err(|e| format!("restat immutable git input {}: {e}", path.display()))?
        .permissions();
    permissions.set_readonly(read_only);
    std::fs::set_permissions(path, permissions).map_err(|e| {
        format!(
            "{} immutable git input {}: {e}",
            if read_only { "seal" } else { "unseal" },
            path.display()
        )
    })
}

/// Run the build script with `WASM_POSIX_DEP_*` env vars set, validate
/// outputs under the temp directory, then `rename(2)` into place.
///
/// `pkgconfig_path` is the pre-composed value for
/// `WASM_POSIX_DEP_PKG_CONFIG_PATH` — a colon-joined list of every
/// transitive lib's `lib/pkgconfig/` dir. Always set, even when empty,
/// so the contract for build scripts stays uniform.
fn build_into_cache(
    target: &DepsManifest,
    arch: TargetArch,
    abi_version: u32,
    cache_key_sha: &str,
    canonical: &Path,
    dep_dirs: &BTreeMap<String, DirectDep>,
    pkgconfig_path: &str,
    repo_root: &Path,
) -> Result<(), String> {
    let parent = canonical
        .parent()
        .ok_or_else(|| format!("canonical path has no parent: {}", canonical.display()))?;
    std::fs::create_dir_all(parent)
        .map_err(|e| format!("create cache parent {}: {e}", parent.display()))?;

    let tmp = parent.join(format!(
        "{}.tmp-{}",
        canonical
            .file_name()
            .expect("canonical path has a filename")
            .to_string_lossy(),
        std::process::id()
    ));
    // Fresh temp dir. If a leftover from a crashed build exists, wipe it.
    if tmp.exists() {
        std::fs::remove_dir_all(&tmp).map_err(|e| format!("clean stale {}: {e}", tmp.display()))?;
    }
    std::fs::create_dir_all(&tmp).map_err(|e| format!("create temp {}: {e}", tmp.display()))?;

    let script = target.build_script_path(repo_root);
    if !script.is_file() {
        let _ = std::fs::remove_dir_all(&tmp);
        return Err(format!(
            "{}: build script {} not found",
            target.spec(),
            script.display()
        ));
    }

    let git_inputs = match ProvisionedGitInputs::provision(target, canonical) {
        Ok(inputs) => inputs,
        Err(e) => {
            let _ = std::fs::remove_dir_all(&tmp);
            return Err(format!(
                "{}: provision immutable git inputs: {e}",
                target.spec()
            ));
        }
    };

    let status = {
        let mut cmd = Command::new("bash");
        cmd.arg(&script);
        // Worktree-local SDK invocation. Prepend `<repo>/sdk/bin` to PATH
        // so build scripts that call `wasm32posix-cc` (and friends)
        // resolve to THIS worktree's SDK source — not whatever a global
        // `npm link` last pointed at. Without this, a sibling worktree's
        // SDK + sysroot can leak into the build, producing binaries with
        // a foreign ABI. The shape of `<repo>/sdk/bin/` is committed
        // symlinks pointing at `_wasm-posix-dispatch`; see
        // `docs/package-management.md` "SDK toolchain invocation".
        let sdk_bin = crate::repo_root().join("sdk").join("bin");
        let path_var = match std::env::var_os("PATH") {
            Some(existing) => {
                let mut p = std::ffi::OsString::from(&sdk_bin);
                p.push(":");
                p.push(existing);
                p
            }
            None => std::ffi::OsString::from(&sdk_bin),
        };
        cmd.env("PATH", path_var);
        cmd.env("WASM_POSIX_DEP_OUT_DIR", &tmp);
        cmd.env("WASM_POSIX_DEP_NAME", &target.name);
        cmd.env("WASM_POSIX_DEP_VERSION", &target.version);
        cmd.env("WASM_POSIX_DEP_REVISION", target.revision.to_string());
        cmd.env("WASM_POSIX_DEP_SOURCE_URL", &target.source.url);
        cmd.env("WASM_POSIX_DEP_SOURCE_SHA256", &target.source.sha256);
        cmd.env("WASM_POSIX_DEP_TARGET_ARCH", arch.as_str());
        cmd.env("WASM_POSIX_DEP_PKG_CONFIG_PATH", pkgconfig_path);
        git_inputs.export_to(&mut cmd);
        for (name, dep) in dep_dirs {
            // Per design 12: library/program deps export under
            // `*_DIR` (built-artifact root), source deps under
            // `*_SRC_DIR` (unbuilt source tree). The suffix tells a
            // build script unambiguously what shape it's consuming.
            let suffix = match dep.kind {
                ManifestKind::Library | ManifestKind::Program => "DIR",
                ManifestKind::Source => "SRC_DIR",
            };
            cmd.env(
                format!("WASM_POSIX_DEP_{}_{}", env_key(name), suffix),
                &dep.path,
            );
        }
        // INVARIANT: build-script stdout MUST NOT leak to xtask's stdout.
        //
        // `cmd_resolve` ends with a single `println!("{}", path.display())`
        // and consumers shell-capture it with
        // `PREFIX="$(cargo run -- build-deps resolve <name>)"`.
        // If the bash subprocess's stdout were inherited (the default),
        // hundreds of lines of build output would land on xtask's stdout
        // ahead of that final println, and `$(...)` would capture the
        // entire build log as the "path" — breaking every consumer that
        // uses the resolve_dep pattern on a cache miss.
        //
        // Fix: dup xtask's stderr FD and route the bash subprocess's
        // stdout to it. The build progress remains visible to the user
        // (it appears on the terminal's stderr stream just like before
        // when stdout was a TTY); only the *captured* stdout pipe stays
        // clean for the path output. stderr inheritance is unchanged.
        let stderr_dup = std::io::stderr()
            .as_fd()
            .try_clone_to_owned()
            .map_err(|e| format!("dup stderr fd for build-script stdout redirect: {e}"))?;
        cmd.stdout(Stdio::from(stderr_dup));
        cmd.status()
            .map_err(|e| format!("spawn bash {}: {e}", script.display()))?
    };

    if let Err(e) = git_inputs.verify_unchanged() {
        let _ = std::fs::remove_dir_all(&tmp);
        return Err(format!(
            "{}: immutable git input verification failed after build: {e}",
            target.spec()
        ));
    }

    if !status.success() {
        let _ = std::fs::remove_dir_all(&tmp);
        return Err(format!(
            "{}: build script {} exited with {}",
            target.spec(),
            script.display(),
            status
        ));
    }

    // Kind-aware validation. Library and program manifests carry a
    // declared outputs list (libs/headers/pkgconfig/files or program wasms)
    // that `validate_outputs` checks one-by-one. Source manifests have
    // no declared outputs — design 11 calls for emptiness as the only
    // signal — so we just verify the script populated OUT_DIR with at
    // least one entry; an empty dir indicates a no-op script.
    let validate_result = match target.kind {
        ManifestKind::Library | ManifestKind::Program => validate_outputs(target, &tmp),
        ManifestKind::Source => validate_source_dir_nonempty(&tmp),
    };
    if let Err(e) = validate_result {
        let _ = std::fs::remove_dir_all(&tmp);
        return Err(e);
    }

    // autoconf / libtool bake `--prefix` (= $WASM_POSIX_DEP_OUT_DIR,
    // i.e. the temp dir) into generated `.pc` and `.la` files at
    // configure time. Rewrite those paths to the canonical location
    // *before* the rename so parallel readers never observe a
    // canonical cache entry with dead `prefix=<temp>` strings.
    //
    // Skip for source kind: source builds produce a tree (e.g. a
    // patched upstream source dir) that won't have `lib/*.{pc,la}`
    // and shouldn't — sources aren't installed anywhere. Calling
    // `rewrite_install_prefix_paths` would be a harmless no-op
    // (`rewrite_dir` returns Ok on missing `lib/`), but skipping
    // documents intent and avoids one read_dir.
    if !matches!(target.kind, ManifestKind::Source) {
        if let Err(e) = rewrite_install_prefix_paths(&tmp, canonical) {
            let _ = std::fs::remove_dir_all(&tmp);
            return Err(e);
        }
    }

    // Publish resolver metadata beside, never inside, the package tree. The
    // marker lands first: a crash leaves harmless metadata without an artifact,
    // while no reader can observe an artifact lacking its required provenance.
    if let Err(e) = write_cache_provenance(target, canonical, arch, abi_version, cache_key_sha) {
        let _ = std::fs::remove_dir_all(&tmp);
        return Err(e);
    }

    // Atomic install. If someone else finished first, keep theirs,
    // discard ours — identical inputs produce identical outputs, and
    // trying to overwrite a non-empty directory isn't portable.
    if canonical.exists() {
        let _ = std::fs::remove_dir_all(&tmp);
        return validate_cache_entry(target, canonical, arch, abi_version, cache_key_sha).map_err(
            |e| {
                format!(
                    "concurrent cache winner {} failed exact validation: {e}",
                    canonical.display()
                )
            },
        );
    }
    std::fs::rename(&tmp, canonical)
        .map_err(|e| format!("rename {} -> {}: {e}", tmp.display(), canonical.display()))?;
    Ok(())
}

/// Replace every occurrence of `tmp` with `canonical` inside
/// installed `.pc` and `.la` files under `tmp/lib/…`. Runs while
/// the tree still lives at `tmp` so the observable canonical cache
/// entry never contains a stale temp path.
///
/// Only regular files are rewritten: symlinks (e.g. libpng's
/// `libpng.pc → libpng16.pc`) point at the real file and resolve
/// correctly without needing their own rewrite; following them
/// would double-rewrite the target.
fn rewrite_install_prefix_paths(tmp: &Path, canonical: &Path) -> Result<(), String> {
    let tmp_s = tmp.to_string_lossy();
    let canonical_s = canonical.to_string_lossy();
    if tmp_s == canonical_s {
        return Ok(());
    }
    let lib_dir = tmp.join("lib");
    rewrite_dir(&lib_dir, &tmp_s, &canonical_s)?;
    let pc_dir = lib_dir.join("pkgconfig");
    rewrite_dir(&pc_dir, &tmp_s, &canonical_s)?;
    Ok(())
}

fn rewrite_dir(dir: &Path, needle: &str, replacement: &str) -> Result<(), String> {
    let rd = match std::fs::read_dir(dir) {
        Ok(r) => r,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(format!("read_dir {}: {e}", dir.display())),
    };
    for entry in rd {
        let entry = entry.map_err(|e| format!("read_dir {}: {e}", dir.display()))?;
        let path = entry.path();
        let ext = match path.extension().and_then(|e| e.to_str()) {
            Some(e) => e,
            None => continue,
        };
        if ext != "pc" && ext != "la" {
            continue;
        }
        // `symlink_metadata` so we see the symlink itself, not its
        // target. Skip symlinks — they resolve to the rewritten real
        // file, and rewriting through them would double-rewrite the
        // target (causing the replacement to match itself) or, worse,
        // replace the symlink with a regular file via `write`.
        let meta = std::fs::symlink_metadata(&path)
            .map_err(|e| format!("symlink_metadata {}: {e}", path.display()))?;
        if !meta.file_type().is_file() {
            continue;
        }
        let content =
            std::fs::read_to_string(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
        if !content.contains(needle) {
            continue;
        }
        let rewritten = content.replace(needle, replacement);
        std::fs::write(&path, rewritten).map_err(|e| format!("write {}: {e}", path.display()))?;
    }
    Ok(())
}

const WASM_MAGIC: &[u8; 4] = b"\0asm";
const WPK_FORK_EXPORTS: [&str; 5] = [
    "wpk_fork_unwind_begin",
    "wpk_fork_unwind_end",
    "wpk_fork_rewind_begin",
    "wpk_fork_rewind_end",
    "wpk_fork_state",
];
const EXECUTABLE_PROGRAM_REQUIRED_EXPORTS: [&str; 2] = ["__abi_version", "_start"];

fn bytes_contain(haystack: &[u8], needle: &[u8]) -> bool {
    !needle.is_empty() && haystack.windows(needle.len()).any(|w| w == needle)
}

fn is_wasm_bytes(bytes: &[u8]) -> bool {
    bytes.len() >= WASM_MAGIC.len() && &bytes[..WASM_MAGIC.len()] == WASM_MAGIC
}

#[derive(Default)]
struct WasmArtifactFacts {
    imports_kernel_fork: bool,
    exports: BTreeSet<String>,
    is_relocatable_object: bool,
}

fn wasm_artifact_facts(bytes: &[u8]) -> Result<WasmArtifactFacts, String> {
    use wasmparser::{Imports, Parser, Payload};

    let mut facts = WasmArtifactFacts::default();
    for payload in Parser::new(0).parse_all(bytes) {
        match payload.map_err(|e| format!("parse wasm: {e}"))? {
            Payload::ImportSection(r) => {
                for group in r {
                    let group = group.map_err(|e| format!("import section: {e}"))?;
                    match group {
                        Imports::Single(_, imp) => {
                            if imp.module == "kernel" && imp.name == "kernel_fork" {
                                facts.imports_kernel_fork = true;
                            }
                        }
                        Imports::Compact1 { module, items } => {
                            for item in items {
                                let item = item.map_err(|e| format!("import section: {e}"))?;
                                if module == "kernel" && item.name == "kernel_fork" {
                                    facts.imports_kernel_fork = true;
                                }
                            }
                        }
                        Imports::Compact2 { module, names, .. } => {
                            for name in names {
                                let name = name.map_err(|e| format!("import section: {e}"))?;
                                if module == "kernel" && name == "kernel_fork" {
                                    facts.imports_kernel_fork = true;
                                }
                            }
                        }
                    }
                }
            }
            Payload::ExportSection(r) => {
                for export in r {
                    let export = export.map_err(|e| format!("export section: {e}"))?;
                    facts.exports.insert(export.name.to_string());
                }
            }
            Payload::CustomSection(c) => {
                let name = c.name();
                if name == "linking" || name.starts_with("reloc.") {
                    facts.is_relocatable_object = true;
                }
            }
            _ => {}
        }
    }
    Ok(facts)
}

#[cfg(test)]
fn wasm_artifact_policy_failures(
    bytes: &[u8],
    fork_instrumentation: ForkInstrumentationPolicy,
) -> Vec<String> {
    wasm_artifact_policy_failures_for(bytes, fork_instrumentation, &[])
}

fn wasm_artifact_policy_failures_for(
    bytes: &[u8],
    fork_instrumentation: ForkInstrumentationPolicy,
    required_exports: &[&str],
) -> Vec<String> {
    if !is_wasm_bytes(bytes) {
        if required_exports.is_empty() {
            return Vec::new();
        }
        return vec!["is not a wasm binary".to_string()];
    }

    let mut failures = Vec::new();
    if bytes_contain(bytes, b"asyncify_") {
        failures.push("contains legacy asyncify_ instrumentation".to_string());
    }

    let facts = match wasm_artifact_facts(bytes) {
        Ok(facts) => facts,
        Err(e) => {
            failures.push(e);
            return failures;
        }
    };

    if facts.is_relocatable_object {
        return failures;
    }

    let missing_required_exports = required_exports
        .iter()
        .copied()
        .filter(|name| !facts.exports.contains(*name))
        .collect::<Vec<_>>();
    if !missing_required_exports.is_empty() {
        failures.push(format!(
            "missing required exports: {}",
            missing_required_exports.join(", ")
        ));
    }

    let wpk_present: Vec<&str> = WPK_FORK_EXPORTS
        .iter()
        .copied()
        .filter(|name| facts.exports.contains(*name))
        .collect();
    if fork_instrumentation == ForkInstrumentationPolicy::Disabled {
        if !wpk_present.is_empty() {
            failures.push(
                "has wasm-fork-instrument exports but this output disables fork instrumentation"
                    .to_string(),
            );
        }
        return failures;
    }
    if !wpk_present.is_empty() && wpk_present.len() != WPK_FORK_EXPORTS.len() {
        let missing = WPK_FORK_EXPORTS
            .iter()
            .copied()
            .filter(|name| !wpk_present.contains(name))
            .collect::<Vec<_>>()
            .join(", ");
        failures.push(format!(
            "has incomplete wasm-fork-instrument exports; missing {missing}"
        ));
    }
    if facts.imports_kernel_fork && wpk_present.len() != WPK_FORK_EXPORTS.len() {
        failures.push(
            "imports kernel.kernel_fork without complete wasm-fork-instrument exports".to_string(),
        );
    }
    failures
}

fn validate_wasm_artifact_policy(
    path: &Path,
    fork_instrumentation: ForkInstrumentationPolicy,
    required_exports: &[&str],
) -> Result<(), String> {
    let bytes = std::fs::read(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    let failures =
        wasm_artifact_policy_failures_for(&bytes, fork_instrumentation, required_exports);
    if failures.is_empty() {
        Ok(())
    } else {
        Err(format!("{}: {}", path.display(), failures.join("; ")))
    }
}

fn required_exports_for_program_output(
    target: &DepsManifest,
    out: &crate::pkg_manifest::ProgramOutput,
) -> &'static [&'static str] {
    if target.name == "kernel" && out.name == "kernel" {
        wasm_posix_shared::abi::HOST_ADAPTER_REQUIRED_KERNEL_EXPORTS
    } else if out.wasm.ends_with(".wasm") && target.name != "userspace" {
        &EXECUTABLE_PROGRAM_REQUIRED_EXPORTS
    } else {
        &[]
    }
}

fn validate_declared_artifact(
    target: &DepsManifest,
    root: &Path,
    rel: &str,
    label: &str,
    missing_suffix: &str,
    require_regular_file: bool,
) -> Result<PathBuf, String> {
    let path = root.join(rel);
    let metadata = std::fs::symlink_metadata(&path).map_err(|_| {
        format!(
            "{}: declared {} output {:?} {}",
            target.spec(),
            label,
            rel,
            missing_suffix
        )
    })?;
    if metadata.file_type().is_symlink() {
        return Err(format!(
            "{}: declared {} output {:?} must not be a symlink",
            target.spec(),
            label,
            rel
        ));
    }
    let canonical_root = std::fs::canonicalize(root)
        .map_err(|e| format!("{}: resolve package artifact root: {e}", target.spec()))?;
    let resolved = std::fs::canonicalize(&path).map_err(|e| {
        format!(
            "{}: resolve declared {} output {:?}: {e}",
            target.spec(),
            label,
            rel
        )
    })?;
    if !resolved.starts_with(&canonical_root) {
        return Err(format!(
            "{}: declared {} output {:?} resolves outside the package artifact root",
            target.spec(),
            label,
            rel
        ));
    }
    if require_regular_file && !metadata.is_file() {
        return Err(format!(
            "{}: declared {} output {:?} must be a regular file",
            target.spec(),
            label,
            rel
        ));
    }
    if !require_regular_file {
        if metadata.is_file() {
            return Ok(path);
        }
        if !metadata.is_dir() {
            return Err(format!(
                "{}: declared {} output {:?} must be a regular file or directory",
                target.spec(),
                label,
                rel
            ));
        }
        let mut active_dirs = BTreeSet::new();
        let leaf_count = validate_artifact_tree(&canonical_root, &path, &mut active_dirs)?;
        if leaf_count == 0 {
            return Err(format!(
                "{}: declared {} output {:?} is an empty directory and cannot round-trip through an artifact archive",
                target.spec(),
                label,
                rel
            ));
        }
    }
    Ok(path)
}

/// Validate every reachable leaf below a declared artifact directory.
/// Internal symlinks are allowed because several library packages publish
/// compatibility aliases; external/cyclic links and special files are not.
fn validate_artifact_tree(
    canonical_root: &Path,
    path: &Path,
    active_dirs: &mut BTreeSet<PathBuf>,
) -> Result<usize, String> {
    let link_metadata = std::fs::symlink_metadata(path)
        .map_err(|e| format!("stat package artifact {}: {e}", path.display()))?;
    let resolved = std::fs::canonicalize(path)
        .map_err(|e| format!("resolve package artifact {}: {e}", path.display()))?;
    if !resolved.starts_with(canonical_root) {
        return Err(format!(
            "package artifact {} resolves outside {}",
            path.display(),
            canonical_root.display()
        ));
    }
    let metadata = if link_metadata.file_type().is_symlink() {
        std::fs::metadata(path)
            .map_err(|e| format!("follow package artifact symlink {}: {e}", path.display()))?
    } else {
        link_metadata
    };
    if metadata.is_file() {
        return Ok(1);
    }
    if !metadata.is_dir() {
        return Err(format!(
            "package artifact {} is not a regular file, directory, or contained symlink",
            path.display()
        ));
    }
    if !active_dirs.insert(resolved.clone()) {
        return Err(format!(
            "package artifact directory symlink cycle reaches {}",
            path.display()
        ));
    }
    let mut entries = std::fs::read_dir(path)
        .map_err(|e| format!("read package artifact directory {}: {e}", path.display()))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("read package artifact directory {}: {e}", path.display()))?;
    entries.sort_by_key(|entry| entry.path());
    let mut leaves = 0usize;
    for entry in entries {
        leaves += validate_artifact_tree(canonical_root, &entry.path(), active_dirs)?;
    }
    active_dirs.remove(&resolved);
    Ok(leaves)
}

fn validate_cache_entry(
    target: &DepsManifest,
    dir: &Path,
    arch: TargetArch,
    abi_version: u32,
    cache_key_sha: &str,
) -> Result<(), String> {
    validate_cache_artifacts(target, dir)?;
    validate_cache_provenance(target, dir, arch, abi_version, cache_key_sha)
}

fn remove_cache_entry(canonical: &Path, cache_key_sha: &str) -> Result<(), String> {
    match std::fs::symlink_metadata(canonical) {
        Ok(metadata) if metadata.file_type().is_symlink() || metadata.is_file() => {
            std::fs::remove_file(canonical)
                .map_err(|e| format!("remove stale cache path {}: {e}", canonical.display()))?;
        }
        Ok(metadata) if metadata.is_dir() => {
            std::fs::remove_dir_all(canonical)
                .map_err(|e| format!("remove stale cache entry {}: {e}", canonical.display()))?;
        }
        Ok(_) => {
            return Err(format!(
                "refusing to remove special cache path {}",
                canonical.display()
            ));
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("inspect cache path {}: {e}", canonical.display())),
    }
    remove_cache_provenance(canonical, cache_key_sha)
}

pub(crate) fn validate_cache_artifacts(target: &DepsManifest, dir: &Path) -> Result<(), String> {
    match target.kind {
        ManifestKind::Library => {
            for rel in &target.outputs.libs {
                validate_declared_artifact(
                    target,
                    dir,
                    rel,
                    "libs",
                    "missing from cache entry",
                    true,
                )?;
            }
            for rel in &target.outputs.headers {
                validate_declared_artifact(
                    target,
                    dir,
                    rel,
                    "headers",
                    "missing from cache entry",
                    false,
                )?;
            }
            for rel in &target.outputs.pkgconfig {
                validate_declared_artifact(
                    target,
                    dir,
                    rel,
                    "pkgconfig",
                    "missing from cache entry",
                    true,
                )?;
            }
            for rel in &target.outputs.files {
                validate_declared_artifact(
                    target,
                    dir,
                    rel,
                    "files",
                    "missing from cache entry",
                    true,
                )?;
            }
        }
        ManifestKind::Program => {
            for out in &target.program_outputs {
                let path = validate_declared_artifact(
                    target,
                    dir,
                    &out.wasm,
                    "wasm",
                    "missing from cache entry",
                    true,
                )?;
                validate_wasm_artifact_policy(
                    &path,
                    out.fork_instrumentation,
                    required_exports_for_program_output(target, out),
                )?;
            }
            for runtime_file in &target.runtime_files {
                validate_declared_artifact(
                    target,
                    dir,
                    &runtime_file.artifact,
                    "runtime file",
                    "missing from cache entry",
                    true,
                )?;
            }
        }
        ManifestKind::Source => {}
    }
    Ok(())
}

fn validate_outputs(target: &DepsManifest, out_dir: &Path) -> Result<(), String> {
    match target.kind {
        ManifestKind::Library => {
            for rel in &target.outputs.libs {
                validate_declared_artifact(
                    target,
                    out_dir,
                    rel,
                    "libs",
                    "not produced by build script",
                    true,
                )?;
            }
            for rel in &target.outputs.headers {
                validate_declared_artifact(
                    target,
                    out_dir,
                    rel,
                    "headers",
                    "not produced by build script",
                    false,
                )?;
            }
            for rel in &target.outputs.pkgconfig {
                validate_declared_artifact(
                    target,
                    out_dir,
                    rel,
                    "pkgconfig",
                    "not produced by build script",
                    true,
                )?;
            }
            for rel in &target.outputs.files {
                validate_declared_artifact(
                    target,
                    out_dir,
                    rel,
                    "files",
                    "not produced by build script",
                    true,
                )?;
            }
        }
        ManifestKind::Program => {
            for out in &target.program_outputs {
                let p = validate_declared_artifact(
                    target,
                    out_dir,
                    &out.wasm,
                    "wasm",
                    "not produced by build script",
                    true,
                )?;
                validate_wasm_artifact_policy(
                    &p,
                    out.fork_instrumentation,
                    required_exports_for_program_output(target, out),
                )?;
            }
            for runtime_file in &target.runtime_files {
                validate_declared_artifact(
                    target,
                    out_dir,
                    &runtime_file.artifact,
                    "runtime file",
                    "not produced by build script",
                    true,
                )?;
            }
        }
        // No outputs to validate for source-kind (Chunk C).
        ManifestKind::Source => return Ok(()),
    }
    Ok(())
}

/// Source-kind validation: the override script must have populated
/// `OUT_DIR` with *something*. Source manifests have no declared
/// outputs list (Task C.1 rejects `[outputs]` for source kind), so
/// non-emptiness is the only signal we have that the script did
/// useful work — an empty dir after a successful `bash` exit almost
/// always means the script forgot to write to `$WASM_POSIX_DEP_OUT_DIR`
/// (e.g. wrote to its own working dir, or hard-coded a path).
fn validate_source_dir_nonempty(out_dir: &Path) -> Result<(), String> {
    let mut iter =
        std::fs::read_dir(out_dir).map_err(|e| format!("read_dir {}: {e}", out_dir.display()))?;
    if iter.next().is_none() {
        return Err(format!(
            "source build script left OUT_DIR empty at {}; \
             scripts MUST populate $WASM_POSIX_DEP_OUT_DIR with at \
             least one file before exiting",
            out_dir.display()
        ));
    }
    Ok(())
}

/// `libcurl` → `LIBCURL`, `zlib-ng` → `ZLIB_NG`.
fn env_key(name: &str) -> String {
    name.chars()
        .map(|c| match c {
            '-' => '_',
            c => c.to_ascii_uppercase(),
        })
        .collect()
}

// ---------------------------------------------------------------------
// Subcommand dispatch
// ---------------------------------------------------------------------

/// Fallback default target architecture when neither `--arch` nor
/// `WASM_POSIX_DEFAULT_ARCH` is set. Wasm32 is the dominant target
/// today; wasm64 is opt-in via flag/env.
///
/// Kept as a constant (rather than inlined) so tests and callers have
/// a single source of truth, and so future changes — e.g. flipping the
/// default once wasm64 is the dominant target — only have to touch
/// one site.
const DEFAULT_ARCH: TargetArch = TargetArch::Wasm32;

/// Read the current kernel ABI version from `crates/shared`. Resolver
/// uses this as a hash input; ABI bumps therefore auto-invalidate every
/// dependent cache entry without any explicit cache-busting work.
fn current_abi_version() -> u32 {
    wasm_posix_shared::ABI_VERSION
}

/// Parse a CLI/env value into `TargetArch`. Accepts `wasm32` and
/// `wasm64`; everything else is rejected with an error message that
/// names the unknown value and lists the valid options.
pub(crate) fn parse_target_arch(s: &str) -> Result<TargetArch, String> {
    match s {
        "wasm32" => Ok(TargetArch::Wasm32),
        "wasm64" => Ok(TargetArch::Wasm64),
        other => Err(format!(
            "unknown --arch value {other:?}; expected wasm32 or wasm64"
        )),
    }
}

/// Default target arch for the CLI when no `--arch` is given:
///   1. `WASM_POSIX_DEFAULT_ARCH` env var, if set and parseable.
///   2. Fallback to [`DEFAULT_ARCH`].
///
/// Unparseable env-var values are rejected loudly so a typo doesn't
/// silently fall through to wasm32 (which would be a confusing way to
/// debug "why did my wasm64 build land in the wrong cache slot?").
fn default_target_arch() -> Result<TargetArch, String> {
    match std::env::var("WASM_POSIX_DEFAULT_ARCH") {
        Ok(s) => parse_target_arch(&s).map_err(|e| format!("WASM_POSIX_DEFAULT_ARCH: {e}")),
        Err(_) => Ok(DEFAULT_ARCH),
    }
}

/// Extract `--arch <value>` / `--arch=<value>` from `args`, leaving
/// non-flag arguments in place. Returns the parsed arch (if any) and
/// the remaining arguments.
///
/// Hand-rolled rather than pulling in clap; the CLI surface is small
/// and stable. Both forms are accepted and may appear anywhere after
/// the subcommand, so `build-deps path zlib --arch=wasm64`,
/// `build-deps path --arch wasm64 zlib`, and
/// `build-deps --arch=wasm64 path zlib` all work identically.
fn extract_arch_flag(args: Vec<String>) -> Result<(Option<TargetArch>, Vec<String>), String> {
    let mut arch: Option<TargetArch> = None;
    let mut rest: Vec<String> = Vec::with_capacity(args.len());
    let mut it = args.into_iter();
    while let Some(a) = it.next() {
        if let Some(value) = a.strip_prefix("--arch=") {
            if arch.is_some() {
                return Err("--arch given more than once".to_string());
            }
            arch = Some(parse_target_arch(value)?);
        } else if a == "--arch" {
            if arch.is_some() {
                return Err("--arch given more than once".to_string());
            }
            let value = it
                .next()
                .ok_or_else(|| "--arch requires a value (wasm32 or wasm64)".to_string())?;
            arch = Some(parse_target_arch(&value)?);
        } else {
            rest.push(a);
        }
    }
    Ok((arch, rest))
}

/// Extract `--binaries-dir <path>` / `--binaries-dir=<path>` from
/// `args`, leaving non-flag arguments in place. Mirrors
/// [`extract_arch_flag`]'s shape so `resolve --binaries-dir <p>` and
/// `--binaries-dir=<p> resolve` are equivalent. Only meaningful for the
/// `resolve` subcommand: when supplied, the resolver places
/// `<binaries_dir>/programs/<arch>/<name>/<output>.wasm` symlinks at
/// each declared `[[outputs]]` (see `place_binaries_symlinks`). Other
/// subcommands ignore the value.
fn extract_binaries_dir_flag(args: Vec<String>) -> Result<(Option<PathBuf>, Vec<String>), String> {
    let mut binaries_dir: Option<PathBuf> = None;
    let mut rest: Vec<String> = Vec::with_capacity(args.len());
    let mut it = args.into_iter();
    while let Some(a) = it.next() {
        if let Some(value) = a.strip_prefix("--binaries-dir=") {
            if binaries_dir.is_some() {
                return Err("--binaries-dir given more than once".to_string());
            }
            binaries_dir = Some(PathBuf::from(value));
        } else if a == "--binaries-dir" {
            if binaries_dir.is_some() {
                return Err("--binaries-dir given more than once".to_string());
            }
            let value = it
                .next()
                .ok_or_else(|| "--binaries-dir requires a directory path".to_string())?;
            binaries_dir = Some(PathBuf::from(value));
        } else {
            rest.push(a);
        }
    }
    Ok((binaries_dir, rest))
}

/// Extract `--fetch-only` from `args`, leaving non-flag arguments in place.
/// Only meaningful for `resolve`: it turns archive/source mismatches into
/// errors instead of running package build scripts.
fn extract_fetch_only_flag(args: Vec<String>) -> (bool, Vec<String>) {
    let mut fetch_only = false;
    let mut rest: Vec<String> = Vec::with_capacity(args.len());
    for a in args {
        if a == "--fetch-only" {
            fetch_only = true;
        } else {
            rest.push(a);
        }
    }
    (fetch_only, rest)
}

pub fn run(args: Vec<String>) -> Result<(), String> {
    let (arch_flag, rest) = extract_arch_flag(args)?;
    let arch = match arch_flag {
        Some(a) => a,
        None => default_target_arch()?,
    };
    // `--binaries-dir` is `resolve`-only today, but pulling it out at
    // this layer (rather than inside the `resolve` arm) keeps the flag
    // location-independent: `resolve --binaries-dir x foo` and
    // `--binaries-dir x resolve foo` both work, matching `--arch`'s
    // shape.
    let (binaries_dir, rest) = extract_binaries_dir_flag(rest)?;
    let (fetch_only, rest) = extract_fetch_only_flag(rest);

    let mut it = rest.into_iter();
    let sub = it.next().ok_or(
        "usage: xtask build-deps [--arch=wasm32|wasm64] [--binaries-dir <path>] [--fetch-only] \
         <parse|sha|path|resolve|check|output-path|runtime-file-path|runtime-file-metadata|output-fork-instrumentation|output-fork-instrumentation-for-rel> \
         [<name|path> [<wasm-basename>]]",
    )?;
    let target = it.next();
    // Output metadata subcommands take a second positional arg (the wasm
    // basename to resolve); every other subcommand stops at one arg. Pull the
    // extra slot up-front so the unexpected-arg check below still catches stray
    // inputs for the simple subcommands.
    let extra = it.next();
    if it.next().is_some() {
        return Err(format!("build-deps {sub}: unexpected extra args"));
    }

    let repo = repo_root();
    let registry = Registry::from_env(&repo);

    // `--binaries-dir` is only meaningful for `resolve` — surface a
    // clear error rather than silently ignoring it on other
    // subcommands so a typo'd `resolve` never gets papered over.
    if binaries_dir.is_some() && sub != "resolve" {
        return Err(format!(
            "build-deps {sub}: --binaries-dir is only valid for `resolve`"
        ));
    }
    if fetch_only && sub != "resolve" {
        return Err(format!(
            "build-deps {sub}: --fetch-only is only valid for `resolve`"
        ));
    }

    match sub.as_str() {
        "check" => {
            if target.is_some() {
                return Err("build-deps check: takes no arguments".into());
            }
            cmd_check(&registry)
        }
        "output-fork-instrumentation-for-rel" => {
            let rel = target.ok_or_else(|| {
                "build-deps output-fork-instrumentation-for-rel: missing <resolver-rel-path>"
                    .to_string()
            })?;
            if extra.is_some() {
                return Err(
                    "build-deps output-fork-instrumentation-for-rel: unexpected extra arg".into(),
                );
            }
            cmd_output_fork_instrumentation_for_rel(&registry, &rel)
        }
        _ => {
            let target = target.ok_or_else(|| format!("build-deps {sub}: missing <name|path>"))?;
            // `target` is either a path to a package.toml (contains '/'
            // or ends with .toml) or a bare name to look up in the
            // registry.
            let manifest = load_target(&target, &registry)?;
            match sub.as_str() {
                "parse" => {
                    if extra.is_some() {
                        return Err("build-deps parse: unexpected extra arg".into());
                    }
                    cmd_parse(&manifest)
                }
                "sha" => {
                    if extra.is_some() {
                        return Err("build-deps sha: unexpected extra arg".into());
                    }
                    cmd_sha(&manifest, &registry, arch)
                }
                "path" => {
                    if extra.is_some() {
                        return Err("build-deps path: unexpected extra arg".into());
                    }
                    cmd_path(&manifest, &registry, arch)
                }
                "resolve" => {
                    if extra.is_some() {
                        return Err("build-deps resolve: unexpected extra arg".into());
                    }
                    cmd_resolve(
                        &manifest,
                        &registry,
                        &repo,
                        arch,
                        binaries_dir.as_deref(),
                        fetch_only,
                    )
                }
                "output-path" => {
                    let basename = extra.ok_or_else(|| {
                        "build-deps output-path: missing <wasm-basename> \
                         (usage: build-deps output-path <name|path> <wasm-basename>)"
                            .to_string()
                    })?;
                    cmd_output_path(&manifest, &basename)
                }
                "runtime-file-path" => {
                    let artifact = extra.ok_or_else(|| {
                        "build-deps runtime-file-path: missing <artifact> \
                         (usage: build-deps runtime-file-path <name|path> <artifact>)"
                            .to_string()
                    })?;
                    cmd_runtime_file_path(&manifest, &artifact)
                }
                "runtime-file-metadata" => {
                    let artifact = extra.ok_or_else(|| {
                        "build-deps runtime-file-metadata: missing <artifact> \
                         (usage: build-deps runtime-file-metadata <name|path> <artifact>)"
                            .to_string()
                    })?;
                    cmd_runtime_file_metadata(&manifest, &artifact)
                }
                "output-fork-instrumentation" => {
                    let basename = extra.ok_or_else(|| {
                        "build-deps output-fork-instrumentation: missing <wasm-basename> \
                         (usage: build-deps output-fork-instrumentation <name|path> <wasm-basename>)"
                            .to_string()
                    })?;
                    cmd_output_fork_instrumentation(&manifest, &basename)
                }
                other => Err(format!("build-deps: unknown subcommand {other:?}")),
            }
        }
    }
}

fn load_target(target: &str, registry: &Registry) -> Result<DepsManifest, String> {
    let looks_like_path =
        target.ends_with(".toml") || target.contains('/') || target.starts_with('.');
    if looks_like_path {
        // Path form: derive the package dir from the .toml path so the
        // overlay (sibling `package.pr.toml`) gets honored just like
        // for registry-name lookups. Falls through to the plain `load`
        // when the path doesn't sit inside a parent dir (rare; a
        // top-level filename has no parent). Matches `Registry::load`.
        let path = Path::new(target);
        match path.parent() {
            Some(dir) if !dir.as_os_str().is_empty() => DepsManifest::load_with_overlay(dir),
            _ => DepsManifest::load(path),
        }
    } else {
        registry.load(target)
    }
}

fn cmd_parse(m: &DepsManifest) -> Result<(), String> {
    println!("name      = {}", m.name);
    println!("version   = {}", m.version);
    println!("revision  = {}", m.revision);
    println!("source    = {}", m.source.url);
    println!("sha256    = {}", m.source.sha256);
    println!(
        "license   = {}{}",
        m.license.spdx,
        m.license
            .url
            .as_deref()
            .map(|u| format!(" ({u})"))
            .unwrap_or_default()
    );
    println!(
        "depends_on= [{}]",
        m.depends_on
            .iter()
            .map(|d| d.to_string())
            .collect::<Vec<_>>()
            .join(", ")
    );
    println!(
        "build     = {}",
        m.build_script_path(&crate::repo_root()).display()
    );
    println!("outputs.libs     = {:?}", m.outputs.libs);
    println!("outputs.headers  = {:?}", m.outputs.headers);
    if !m.outputs.pkgconfig.is_empty() {
        println!("outputs.pkgconfig= {:?}", m.outputs.pkgconfig);
    }
    if !m.outputs.files.is_empty() {
        println!("outputs.files    = {:?}", m.outputs.files);
    }
    if !m.runtime_files.is_empty() {
        println!("runtime_files    = {:?}", m.runtime_files);
    }
    Ok(())
}

fn cmd_sha(m: &DepsManifest, registry: &Registry, arch: TargetArch) -> Result<(), String> {
    let mut memo = BTreeMap::new();
    let mut chain = Vec::new();
    let sha = compute_sha(
        m,
        registry,
        arch,
        current_abi_version(),
        &mut memo,
        &mut chain,
    )?;
    println!("{}", hex(&sha));
    Ok(())
}

fn cmd_path(m: &DepsManifest, registry: &Registry, arch: TargetArch) -> Result<(), String> {
    let mut memo = BTreeMap::new();
    let mut chain = Vec::new();
    let sha = compute_sha(
        m,
        registry,
        arch,
        current_abi_version(),
        &mut memo,
        &mut chain,
    )?;
    let path = canonical_path(&default_cache_root(), m, arch, &sha);
    println!("{}", path.display());
    Ok(())
}

/// `output-path <name|path> <wasm-basename>`: print the relative path
/// (under `programs/<arch>/`) where the resolver places this program's
/// `wasm_basename` output via `place_binaries_symlinks`.
///
/// Consumed by `scripts/install-local-binary.sh` so build scripts drop
/// their freshly-built bytes at the same path the resolver writes to.
/// Without this, the build-script-side install-local-binary path could
/// diverge from the resolver path (the case that surfaced for texlive:
/// program "texlive" with output "pdftex" — the resolver writes
/// pdftex.wasm, but install_local_binary historically wrote
/// texlive.wasm or texlive/pdftex.wasm).
fn cmd_output_path(m: &DepsManifest, wasm_basename: &str) -> Result<(), String> {
    let rel = m.output_dest_rel(wasm_basename)?;
    println!("{}", rel.display());
    Ok(())
}

/// `runtime-file-path <name|path> <artifact>`: print the mirror path
/// below `programs/<arch>/` used by local and resolver materialization.
fn cmd_runtime_file_path(m: &DepsManifest, artifact: &str) -> Result<(), String> {
    let rel = m.runtime_file_dest_rel(artifact)?;
    println!("{}", rel.display());
    Ok(())
}

/// Structured installation contract for VFS/image builders. JSON avoids
/// consumers scraping Debug output and keeps guest path/mode authoritative.
fn cmd_runtime_file_metadata(m: &DepsManifest, artifact: &str) -> Result<(), String> {
    let value = runtime_file_metadata_value(m, artifact)?;
    println!(
        "{}",
        serde_json::to_string(&value).map_err(|e| format!("serialize runtime metadata: {e}"))?
    );
    Ok(())
}

fn runtime_file_metadata_value(
    m: &DepsManifest,
    artifact: &str,
) -> Result<serde_json::Value, String> {
    let runtime_file = m
        .runtime_files
        .iter()
        .find(|runtime_file| runtime_file.artifact == artifact)
        .ok_or_else(|| {
            format!(
                "program {:?} has no [[runtime_files]] artifact {:?}",
                m.name, artifact
            )
        })?;
    // A runtime file is meaningful only alongside the exact executable and
    // side-module outputs produced by the same program package archive. Give
    // repo-side consumers the complete resolver mirror closure so they can
    // select one materialization tier atomically instead of resolving each
    // member independently and accidentally mixing builds.
    let closure_mirror_paths: Vec<PathBuf> = m
        .program_outputs
        .iter()
        .map(|output| m.output_dest_rel_for(output))
        .chain(
            m.runtime_files
                .iter()
                .map(|runtime_file| m.runtime_file_dest_rel_for(runtime_file)),
        )
        .collect();
    Ok(serde_json::json!({
        "artifact": runtime_file.artifact,
        "guest_path": runtime_file.guest_path,
        "mode": runtime_file.mode,
        "mirror_path": m.runtime_file_dest_rel_for(runtime_file),
        "closure_mirror_paths": closure_mirror_paths,
    }))
}

fn cmd_output_fork_instrumentation(m: &DepsManifest, wasm_basename: &str) -> Result<(), String> {
    let policy = m.output_fork_instrumentation(wasm_basename)?;
    println!("{}", policy.as_str());
    Ok(())
}

fn cmd_output_fork_instrumentation_for_rel(
    registry: &Registry,
    resolver_rel: &str,
) -> Result<(), String> {
    let policy = output_fork_instrumentation_for_rel(registry, resolver_rel)?;
    println!("{}", policy.as_str());
    Ok(())
}

fn output_fork_instrumentation_for_rel(
    registry: &Registry,
    resolver_rel: &str,
) -> Result<ForkInstrumentationPolicy, String> {
    let rel = resolver_rel
        .strip_prefix("programs/wasm32/")
        .or_else(|| resolver_rel.strip_prefix("programs/wasm64/"))
        .or_else(|| resolver_rel.strip_prefix("programs/"))
        .unwrap_or(resolver_rel);
    for (_, manifest) in programs_by_name(registry)? {
        for out in &manifest.program_outputs {
            if manifest.output_dest_rel_for(out).to_string_lossy().as_ref() == rel {
                return Ok(out.fork_instrumentation);
            }
        }
    }
    Ok(ForkInstrumentationPolicy::Auto)
}

fn cmd_resolve(
    m: &DepsManifest,
    registry: &Registry,
    repo: &Path,
    arch: TargetArch,
    binaries_dir: Option<&Path>,
    fetch_only: bool,
) -> Result<(), String> {
    let cache_root = default_cache_root();
    let local_libs = repo.join("local-libs");
    let opts = ResolveOpts {
        cache_root: &cache_root,
        local_libs: Some(&local_libs),
        force_source_build: None,
        fetch_only,
        repo_root: Some(repo),
        // Plumb binaries_dir into ensure_built so place_binaries_symlinks
        // runs for every transitive program dep, not just the target.
        // The previous direct call here (post-ensure_built) only placed
        // symlinks for `m`; consumer build scripts that read sibling
        // package binaries via `tryResolveBinary` need the dep
        // symlinks too.
        binaries_dir,
    };
    let path = ensure_built(m, registry, arch, current_abi_version(), &opts)?;

    // Top-level target: ensure_built places symlinks for transitive
    // deps via opts.binaries_dir, but the *target's* own symlinks land
    // here so we don't recurse into "place self" inside ensure_built
    // (which would also fire from archive-stage's ensure_built call,
    // where placing target symlinks isn't desired).
    if let Some(bdir) = binaries_dir {
        if matches!(m.kind, ManifestKind::Program) && !m.program_outputs.is_empty() {
            place_binaries_symlinks(m, &path, bdir, arch)?;
        }
    }

    println!("{}", path.display());
    Ok(())
}

/// Place symlinks under `binaries_dir/programs/<arch>/` pointing at
/// each declared `[[outputs]]` artifact and `[[runtime_files]]` file in the
/// cache canonical directory.
///
/// Layout (per arch — wasm32 and wasm64 mirror in parallel):
///   * 1 output: `<binaries_dir>/programs/<arch>/<output.name>.wasm`.
///   * ≥2 outputs: `<binaries_dir>/programs/<arch>/<program.name>/<output.name>.wasm`.
///   * first-party kernel/userspace: `<binaries_dir>/<output.name>.wasm`.
///
/// This is the single source of truth for the symlink layout. Browser
/// demos hardcode these paths (see `apps/browser-demos/vite.config.ts`
/// and `host/src/binary-resolver.ts`), so the layout MUST NOT change
/// here without coordinating with the consumer-side import paths.
///
/// Targets are absolute paths into the resolver cache. Replace-in-place
/// is safe (remove + symlink): symlinks are tiny and atomic, and a
/// stale link that survives an arch flip would silently route consumers
/// at the wrong arch — correctness trumps a microsecond saved on a
/// no-op.
fn place_binaries_symlinks(
    m: &DepsManifest,
    canonical: &Path,
    binaries_dir: &Path,
    arch: TargetArch,
) -> Result<(), String> {
    let outputs = &m.program_outputs;
    if outputs.is_empty() {
        return Err(format!("program {:?} has no [[outputs]]", m.name));
    }
    let arch_root = binaries_dir.join("programs").join(arch.as_str());
    for out in outputs {
        let src = canonical.join(&out.wasm);
        if !src.is_file() {
            return Err(format!(
                "declared output {} not found in cache at {}",
                out.wasm,
                src.display()
            ));
        }
        let dest = if (m.name == "kernel" || m.name == "userspace") && outputs.len() == 1 {
            binaries_dir.join(format!("{}.wasm", out.name))
        } else {
            arch_root.join(m.output_dest_rel_for(out))
        };
        let dest_dir = dest
            .parent()
            .ok_or_else(|| format!("dest path {} has no parent", dest.display()))?;
        std::fs::create_dir_all(dest_dir)
            .map_err(|e| format!("mkdir {}: {e}", dest_dir.display()))?;
        // Replace-in-place: remove any existing entry (file or
        // symlink), then create a fresh symlink. Skipping the remove
        // step would cause `symlink` to fail with EEXIST.
        if dest.exists() || dest.symlink_metadata().is_ok() {
            let _ = std::fs::remove_file(&dest);
        }
        std::os::unix::fs::symlink(&src, &dest)
            .map_err(|e| format!("symlink {} -> {}: {e}", dest.display(), src.display()))?;
    }
    for runtime_file in &m.runtime_files {
        let src = canonical.join(&runtime_file.artifact);
        let metadata = std::fs::symlink_metadata(&src).map_err(|e| {
            format!(
                "declared runtime file {} not found in cache at {}: {e}",
                runtime_file.artifact,
                src.display()
            )
        })?;
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err(format!(
                "declared runtime file {} is not a regular non-symlink file at {}",
                runtime_file.artifact,
                src.display()
            ));
        }
        let dest = arch_root.join(m.runtime_file_dest_rel_for(runtime_file));
        let dest_dir = dest
            .parent()
            .ok_or_else(|| format!("dest path {} has no parent", dest.display()))?;
        std::fs::create_dir_all(dest_dir)
            .map_err(|e| format!("mkdir {}: {e}", dest_dir.display()))?;
        if dest.exists() || dest.symlink_metadata().is_ok() {
            let _ = std::fs::remove_file(&dest);
        }
        std::os::unix::fs::symlink(&src, &dest)
            .map_err(|e| format!("symlink {} -> {}: {e}", dest.display(), src.display()))?;
    }
    Ok(())
}

/// Parse the argument vector for `xtask compute-cache-key-sha`.
///
/// Required flags (order-independent, both `--flag value` and
/// `--flag=value` forms accepted):
///   --package <dir>           Path to the package directory (containing
///                             `package.toml`).
///   --arch    <wasm32|wasm64> Target architecture for the cache key.
///
/// Hand-rolled because the CLI surface is small and the existing
/// `extract_arch_flag` helper is shared with `build-deps`, where
/// `--arch` is optional and the positional arguments differ. Keeping
/// this parser focused makes the contract for the pre-flight workflow
/// (Phase B-1, Task 2) easy to read at the call site.
fn parse_compute_cache_key_sha_args(args: Vec<String>) -> Result<(PathBuf, TargetArch), String> {
    let mut package: Option<PathBuf> = None;
    let mut arch: Option<TargetArch> = None;
    let mut it = args.into_iter();
    while let Some(a) = it.next() {
        if let Some(value) = a.strip_prefix("--package=") {
            if package.is_some() {
                return Err("--package given more than once".into());
            }
            package = Some(PathBuf::from(value));
        } else if a == "--package" {
            if package.is_some() {
                return Err("--package given more than once".into());
            }
            let value = it
                .next()
                .ok_or_else(|| "--package requires a directory path".to_string())?;
            package = Some(PathBuf::from(value));
        } else if let Some(value) = a.strip_prefix("--arch=") {
            if arch.is_some() {
                return Err("--arch given more than once".into());
            }
            arch = Some(parse_target_arch(value)?);
        } else if a == "--arch" {
            if arch.is_some() {
                return Err("--arch given more than once".into());
            }
            let value = it
                .next()
                .ok_or_else(|| "--arch requires a value (wasm32 or wasm64)".to_string())?;
            arch = Some(parse_target_arch(&value)?);
        } else {
            return Err(format!("unexpected argument {a:?}"));
        }
    }
    let package =
        package.ok_or_else(|| "compute-cache-key-sha: --package <dir> is required".to_string())?;
    let arch = arch
        .ok_or_else(|| "compute-cache-key-sha: --arch <wasm32|wasm64> is required".to_string())?;
    Ok((package, arch))
}

/// Compute the cache-key sha for the manifest at
/// `<package_dir>/package.toml`, resolving deps against `registry`.
/// Returns the lowercase 64-char hex string (no trailing newline) so
/// callers can either print it directly or use it programmatically.
///
/// This is a thin wrapper around [`compute_sha`] that loads the
/// manifest, threads through the canonical `memo` / `chain` state, and
/// hex-encodes the digest. Factored out from [`run_compute_cache_key_sha`]
/// so unit tests can exercise the logic without capturing stdout.
pub(crate) fn compute_cache_key_sha_for_package(
    package_dir: &Path,
    registry: &Registry,
    arch: TargetArch,
    abi_version: u32,
) -> Result<String, String> {
    let manifest = DepsManifest::load_with_overlay(package_dir)?;
    let mut memo = BTreeMap::new();
    let mut chain = Vec::new();
    let sha = compute_sha(
        &manifest,
        registry,
        arch,
        abi_version,
        &mut memo,
        &mut chain,
    )?;
    Ok(hex(&sha))
}

/// CLI entry point for `xtask compute-cache-key-sha`.
///
/// Wraps the existing internal [`compute_sha`] function as a stable
/// CLI surface for Phase B-1's pre-flight workflow, which calls this
/// for every (package, arch) pair to decide which matrix entries are
/// already published and can be skipped.
///
/// Args:
///   --package <path-to-package-dir>  Directory containing `package.toml`.
///   --arch    <wasm32|wasm64>        Target architecture.
///
/// On success: prints exactly 64 lowercase hex chars + newline to
/// stdout. On error: returns an `Err`; the top-level `xtask` dispatch
/// in `main.rs` writes it to stderr and exits non-zero.
pub fn run_compute_cache_key_sha(args: Vec<String>) -> Result<(), String> {
    let (package_dir, arch) = parse_compute_cache_key_sha_args(args)?;
    let repo = repo_root();
    let registry = Registry::from_env(&repo);
    let sha =
        compute_cache_key_sha_for_package(&package_dir, &registry, arch, current_abi_version())?;
    println!("{sha}");
    Ok(())
}

/// Cross-consumer host-tool consistency lint. Walks the registry,
/// groups `[[host_tools]]` declarations by `name` across consumers,
/// and reports an error when consumers disagree on
/// `version_constraint` or `probe` for the same tool name.
///
/// Probe defaults are normalized at parse time
/// (`HostToolProbe::default()`), so a consumer that omits `[probe]`
/// compares equal to one that writes the same defaults explicitly.
///
/// On success: exit 0 with a one-line summary.
/// On failure: every offending group is reported in the error.
fn cmd_check(registry: &Registry) -> Result<(), String> {
    let manifests = registry.walk_all()?;

    // Group: tool_name -> Vec<(consumer_name, &HostTool)>.
    let mut by_tool: BTreeMap<String, Vec<(String, &HostTool)>> = BTreeMap::new();
    for (cname, m) in &manifests {
        for tool in &m.host_tools {
            by_tool
                .entry(tool.name.clone())
                .or_default()
                .push((cname.clone(), tool));
        }
    }

    let tool_count = by_tool.len();
    let consumer_count = manifests
        .iter()
        .filter(|(_, m)| !m.host_tools.is_empty())
        .count();

    let mut problems: Vec<String> = Vec::new();
    for (tool, group) in &by_tool {
        if group.len() < 2 {
            continue;
        }
        // Compare each entry against the first.
        let (first_consumer, first_tool) = &group[0];
        for (other_consumer, other_tool) in &group[1..] {
            if first_tool.version_constraint != other_tool.version_constraint {
                problems.push(format!(
                    "host-tool {tool:?}: inconsistent version_constraint\n  - {first_consumer}: >={}\n  - {other_consumer}: >={}",
                    first_tool.version_constraint.min,
                    other_tool.version_constraint.min,
                ));
            }
            if first_tool.probe.args != other_tool.probe.args
                || first_tool.probe.version_regex != other_tool.probe.version_regex
            {
                problems.push(format!(
                    "host-tool {tool:?}: inconsistent probe between {first_consumer} and {other_consumer}\n  - args:  {:?} vs {:?}\n  - regex: {:?} vs {:?}",
                    first_tool.probe.args, other_tool.probe.args,
                    first_tool.probe.version_regex, other_tool.probe.version_regex,
                ));
            }
        }
    }

    if !problems.is_empty() {
        let msg = problems.join("\n\n");
        return Err(format!("host-tool consistency check failed:\n\n{msg}"));
    }
    println!(
        "host-tool consistency: {tool_count} tool(s) across {consumer_count} consumer(s) — OK"
    );
    Ok(())
}

// ---------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;

    fn write(dir: &Path, name: &str, version: &str, depends_on: &[&str]) {
        let lib_dir = dir.join(name);
        fs::create_dir_all(&lib_dir).unwrap();
        let depends = depends_on
            .iter()
            .map(|s| format!("{:?}", s))
            .collect::<Vec<_>>()
            .join(", ");
        let text = format!(
            r#"
kind = "library"
name = "{name}"
version = "{version}"
depends_on = [{depends}]

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
        fs::write(lib_dir.join("package.toml"), text).unwrap();
    }

    fn tempdir(label: &str) -> PathBuf {
        let p = std::env::temp_dir()
            .join("wpk-xtask-test")
            .join(format!("{label}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    fn fixture_git(repo: &Path, args: &[&str]) -> String {
        let output = Command::new("git")
            .arg("-C")
            .arg(repo)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "fixture git {args:?} failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }

    fn immutable_git_fixture(label: &str) -> (PathBuf, String) {
        let repo = tempdir(label).join("source");
        fs::create_dir_all(&repo).unwrap();
        fixture_git(&repo, &["init", "--quiet"]);
        fixture_git(&repo, &["config", "user.name", "Kandelo Test"]);
        fixture_git(&repo, &["config", "user.email", "test@kandelo.invalid"]);
        fixture_git(&repo, &["config", "commit.gpgsign", "false"]);
        fs::write(repo.join("payload.txt"), "immutable payload\n").unwrap();
        fs::write(repo.join(".gitignore"), "generated.tmp\n").unwrap();
        fixture_git(&repo, &["add", "payload.txt", ".gitignore"]);
        fixture_git(&repo, &["commit", "--quiet", "-m", "fixture"]);
        let commit = fixture_git(&repo, &["rev-parse", "HEAD"]);
        (repo, commit)
    }

    fn uleb(mut n: u32) -> Vec<u8> {
        let mut out = Vec::new();
        loop {
            let mut byte = (n & 0x7f) as u8;
            n >>= 7;
            if n != 0 {
                byte |= 0x80;
            }
            out.push(byte);
            if n == 0 {
                return out;
            }
        }
    }

    fn wasm_name(name: &str) -> Vec<u8> {
        let mut out = uleb(name.len() as u32);
        out.extend_from_slice(name.as_bytes());
        out
    }

    fn wasm_section(id: u8, payload: Vec<u8>) -> Vec<u8> {
        let mut out = vec![id];
        out.extend(uleb(payload.len() as u32));
        out.extend(payload);
        out
    }

    fn wasm_importing_kernel_fork(custom_sections: &[&str]) -> Vec<u8> {
        let mut bytes = b"\0asm\x01\0\0\0".to_vec();
        for name in custom_sections {
            bytes.extend(wasm_section(0, wasm_name(name)));
        }
        bytes.extend(wasm_section(1, vec![0x01, 0x60, 0x00, 0x01, 0x7f]));

        let mut imports = vec![0x01];
        imports.extend(wasm_name("kernel"));
        imports.extend(wasm_name("kernel_fork"));
        imports.push(0x00); // func import
        imports.push(0x00); // type index
        bytes.extend(wasm_section(2, imports));
        bytes
    }

    fn wasm_importing_kernel_fork_exporting_names(names: &[&str]) -> Vec<u8> {
        let mut bytes = wasm_importing_kernel_fork(&[]);
        let mut exports = uleb(names.len() as u32);
        for name in names {
            exports.extend(wasm_name(name));
            exports.push(0x00); // func export
            exports.push(0x00); // imported function index
        }
        bytes.extend(wasm_section(7, exports));
        bytes
    }

    fn wasm_exporting_names(names: &[&str]) -> Vec<u8> {
        let mut bytes = b"\0asm\x01\0\0\0".to_vec();
        bytes.extend(wasm_section(1, vec![0x01, 0x60, 0x00, 0x01, 0x7f]));
        bytes.extend(wasm_section(3, vec![0x01, 0x00]));

        let mut exports = uleb(names.len() as u32);
        for name in names {
            exports.extend(wasm_name(name));
            exports.push(0x00); // func export
            exports.push(0x00); // func index
        }
        bytes.extend(wasm_section(7, exports));
        bytes.extend(wasm_section(10, vec![0x01, 0x04, 0x00, 0x41, 0x00, 0x0b]));
        bytes
    }

    fn wasm_exporting_kernel_fork() -> Vec<u8> {
        wasm_exporting_names(&["kernel_fork"])
    }

    fn wasm_importing_kernel_fork_with_wpk_exports() -> Vec<u8> {
        let mut names = Vec::new();
        names.extend(EXECUTABLE_PROGRAM_REQUIRED_EXPORTS);
        names.extend(WPK_FORK_EXPORTS);
        wasm_importing_kernel_fork_exporting_names(&names)
    }

    fn minimal_executable_wasm() -> Vec<u8> {
        wasm_exporting_names(&EXECUTABLE_PROGRAM_REQUIRED_EXPORTS)
    }

    fn emit_wasm_build_script(rel: &str, bytes: &[u8]) -> String {
        let escaped = bytes
            .iter()
            .map(|byte| format!("\\x{byte:02x}"))
            .collect::<String>();
        format!(
            r#"mkdir -p "$WASM_POSIX_DEP_OUT_DIR" && printf '{escaped}' > "$WASM_POSIX_DEP_OUT_DIR/{rel}""#
        )
    }

    #[test]
    fn registry_find_returns_first_hit() {
        let root1 = tempdir("find-root1");
        let root2 = tempdir("find-root2");
        write(&root1, "libA", "1.0.0", &[]);
        write(&root2, "libA", "2.0.0", &[]); // lower priority

        let reg = Registry {
            roots: vec![root1.clone(), root2.clone()],
        };

        let path = reg.find("libA").expect("libA should resolve");
        assert_eq!(path, root1.join("libA/package.toml"));
    }

    #[test]
    fn registry_find_falls_through_to_second_root() {
        let root1 = tempdir("fallthru-root1");
        let root2 = tempdir("fallthru-root2");
        write(&root2, "libB", "1.0.0", &[]);

        let reg = Registry {
            roots: vec![root1, root2.clone()],
        };

        let path = reg.find("libB").expect("libB should fall through to root2");
        assert_eq!(path, root2.join("libB/package.toml"));
    }

    /// Test-default arch — matches the CLI's `DEFAULT_ARCH` so existing
    /// cache-key tests keep their semantic meaning when arch becomes a
    /// hash input.
    const TEST_ARCH: TargetArch = TargetArch::Wasm32;
    /// Test-default ABI version — an arbitrary fixed value used for
    /// cache-key tests. Decoupled from `wasm_posix_shared::ABI_VERSION`
    /// on purpose: tests pin the *behaviour* of the hash function, not
    /// today's ABI number.
    const TEST_ABI: u32 = 4;

    #[test]
    fn compute_sha_is_deterministic() {
        let root = tempdir("sha-stable");
        write(&root, "libZ", "1.0.0", &[]);
        let reg = Registry { roots: vec![root] };
        let m = reg.load("libZ").unwrap();

        let s1 = compute_sha(
            &m,
            &reg,
            TEST_ARCH,
            TEST_ABI,
            &mut BTreeMap::new(),
            &mut Vec::new(),
        )
        .unwrap();
        let s2 = compute_sha(
            &m,
            &reg,
            TEST_ARCH,
            TEST_ABI,
            &mut BTreeMap::new(),
            &mut Vec::new(),
        )
        .unwrap();
        assert_eq!(s1, s2, "sha must be deterministic");
    }

    // Tests asserting "bumping `revision = N` in package.toml changes
    // the cache key" were removed when revision moved out of source
    // package.toml (binary-resolution-via-index-ledger design §3.1):
    // source manifests no longer carry a revision counter and
    // validate_source rejects the field. compute_sha still hashes
    // m.revision (defaulted to 1 from validate_common) so the cache
    // key for a source build remains deterministic; the bumping
    // behavior is just no longer expressible via a source edit.

    #[test]
    fn compute_sha_rejects_version_mismatch() {
        let root = tempdir("sha-mismatch");
        // Registry has libDep@2.0.0; consumer asks for libDep@1.0.0.
        write(&root, "libDep", "2.0.0", &[]);
        write(&root, "libCons", "1.0.0", &["libDep@1.0.0"]);
        let reg = Registry { roots: vec![root] };
        let cons = reg.load("libCons").unwrap();
        let err = compute_sha(
            &cons,
            &reg,
            TEST_ARCH,
            TEST_ABI,
            &mut BTreeMap::new(),
            &mut Vec::new(),
        )
        .unwrap_err();
        assert!(err.contains("depends on libDep@1.0.0"), "got: {err}");
    }

    #[test]
    fn compute_sha_detects_cycle() {
        let root = tempdir("sha-cycle");
        write(&root, "libA", "1.0.0", &["libB@1.0.0"]);
        write(&root, "libB", "1.0.0", &["libA@1.0.0"]);
        let reg = Registry { roots: vec![root] };
        let a = reg.load("libA").unwrap();
        let err = compute_sha(
            &a,
            &reg,
            TEST_ARCH,
            TEST_ABI,
            &mut BTreeMap::new(),
            &mut Vec::new(),
        )
        .unwrap_err();
        assert!(err.contains("cycle"), "got: {err}");
    }

    #[test]
    fn cache_key_sha_changes_with_target_arch() {
        let root = tempdir("sha-arch");
        write(&root, "libZ", "1.0.0", &[]);
        let reg = Registry { roots: vec![root] };
        let m = reg.load("libZ").unwrap();

        let sha32 = compute_sha(
            &m,
            &reg,
            TargetArch::Wasm32,
            TEST_ABI,
            &mut BTreeMap::new(),
            &mut Vec::new(),
        )
        .unwrap();
        let sha64 = compute_sha(
            &m,
            &reg,
            TargetArch::Wasm64,
            TEST_ABI,
            &mut BTreeMap::new(),
            &mut Vec::new(),
        )
        .unwrap();
        assert_ne!(
            sha32, sha64,
            "different arches must produce different cache keys"
        );
    }

    #[test]
    fn cache_key_sha_changes_with_abi_version() {
        let root = tempdir("sha-abi");
        write(&root, "libZ", "1.0.0", &[]);
        let reg = Registry { roots: vec![root] };
        let m = reg.load("libZ").unwrap();

        // Use clearly-arbitrary ABI values (99, 100) so the test's
        // intent — "two distinct ABIs hash differently" — isn't
        // accidentally tied to whatever `ABI_VERSION` happens to be
        // today.
        let sha_a = compute_sha(
            &m,
            &reg,
            TEST_ARCH,
            99,
            &mut BTreeMap::new(),
            &mut Vec::new(),
        )
        .unwrap();
        let sha_b = compute_sha(
            &m,
            &reg,
            TEST_ARCH,
            100,
            &mut BTreeMap::new(),
            &mut Vec::new(),
        )
        .unwrap();
        assert_ne!(
            sha_a, sha_b,
            "different abi_versions must produce different cache keys"
        );
    }

    #[test]
    fn current_abi_version_matches_shared_crate() {
        // Sanity: the helper actually reads from crates/shared, so a bump
        // there propagates here without manual sync.
        assert_eq!(current_abi_version(), wasm_posix_shared::ABI_VERSION);
    }

    // --- compute-cache-key-sha CLI subcommand tests ---
    //
    // The subcommand is a thin shell over `compute_sha`: parse
    // `--package <dir> --arch <wasm32|wasm64>`, load the manifest from
    // `<dir>/package.toml` plus sibling project metadata, hash it
    // against the supplied registry and current ABI version, print
    // 64 hex chars to stdout. These tests pin the helper layer
    // (`compute_cache_key_sha_for_package`) so the CI pre-flight
    // workflow's contract is locked down even though the CLI binary
    // itself is exercised by the end-to-end smoke step.

    #[test]
    fn compute_cache_key_sha_subcommand_prints_64_hex_for_real_package() {
        // Smoke against a real first-party package — `bash` has a
        // non-trivial dep graph (depends on ncurses), exercising
        // transitive cache-key resolution end-to-end.
        let repo = repo_root();
        let registry = Registry::from_env(&repo);
        let pkg = repo.join("packages/registry/bash");
        let sha = compute_cache_key_sha_for_package(
            &pkg,
            &registry,
            TargetArch::Wasm32,
            current_abi_version(),
        )
        .expect("bash@wasm32 cache-key sha should compute cleanly");
        assert_eq!(sha.len(), 64, "expected 64 hex chars, got {sha:?}");
        assert!(
            sha.chars()
                .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()),
            "expected lowercase hex chars, got {sha:?}"
        );
    }

    #[test]
    fn compute_cache_key_sha_changes_on_input_change() {
        let root = tempdir("ckcs-input-change");
        write(&root, "libW", "1.0.0", &[]);
        let reg = Registry {
            roots: vec![root.clone()],
        };

        let pkg = root.join("libW");
        let sha_before =
            compute_cache_key_sha_for_package(&pkg, &reg, TargetArch::Wasm32, TEST_ABI).unwrap();

        // Bump version in-place (revision lives in index.toml post
        // binary-resolution-via-index-ledger; the source-tree mutable
        // field that affects the cache key is now version). Helper
        // should re-hash and produce a different sha.
        let toml_path = pkg.join("package.toml");
        let text = std::fs::read_to_string(&toml_path).unwrap();
        std::fs::write(
            &toml_path,
            text.replace("version = \"1.0.0\"", "version = \"1.0.1\""),
        )
        .unwrap();

        let sha_after =
            compute_cache_key_sha_for_package(&pkg, &reg, TargetArch::Wasm32, TEST_ABI).unwrap();
        assert_ne!(
            sha_before, sha_after,
            "version bump must change cache_key_sha"
        );
    }

    #[test]
    fn compute_cache_key_sha_uses_build_toml_revision() {
        let root = tempdir("ckcs-build-revision");
        write(&root, "libRev", "1.0.0", &[]);
        let reg = Registry {
            roots: vec![root.clone()],
        };

        let pkg = root.join("libRev");
        let sha_before =
            compute_cache_key_sha_for_package(&pkg, &reg, TargetArch::Wasm32, TEST_ABI).unwrap();

        std::fs::write(
            pkg.join("build.toml"),
            r#"
script_path = "packages/registry/libRev/build-libRev.sh"
repo_url    = "https://example.test/repo.git"
commit      = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
revision    = 2

[binary]
index_url = "https://example.test/releases/download/binaries-abi-v{abi}/index.toml"
"#,
        )
        .unwrap();

        let sha_after =
            compute_cache_key_sha_for_package(&pkg, &reg, TargetArch::Wasm32, TEST_ABI).unwrap();
        assert_ne!(
            sha_before, sha_after,
            "build.toml revision bump must change cache_key_sha"
        );
    }

    #[test]
    fn compute_cache_key_sha_uses_build_toml_inputs() {
        let root = tempdir("ckcs-build-inputs");
        write(&root, "libInput", "1.0.0", &[]);
        let reg = Registry {
            roots: vec![root.clone()],
        };

        let pkg = root.join("libInput");
        std::fs::write(pkg.join("recipe.txt"), "one\n").unwrap();
        std::fs::create_dir(pkg.join("recipe-dir")).unwrap();
        std::fs::write(pkg.join("recipe-dir/nested.txt"), "alpha\n").unwrap();
        std::fs::write(
            pkg.join("build.toml"),
            r#"
script_path = "libInput/build-libInput.sh"
inputs = ["libInput/recipe.txt", "libInput/recipe-dir"]
repo_url    = "https://example.test/repo.git"
commit      = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
revision    = 1

[binary]
index_url = "https://example.test/releases/download/binaries-abi-v{abi}/index.toml"
"#,
        )
        .unwrap();

        let sha_before =
            compute_cache_key_sha_for_package(&pkg, &reg, TargetArch::Wasm32, TEST_ABI).unwrap();

        std::fs::write(pkg.join("recipe.txt"), "two\n").unwrap();

        let sha_after =
            compute_cache_key_sha_for_package(&pkg, &reg, TargetArch::Wasm32, TEST_ABI).unwrap();
        assert_ne!(
            sha_before, sha_after,
            "build.toml input content changes must change cache_key_sha"
        );

        std::fs::write(pkg.join("recipe-dir/nested.txt"), "beta\n").unwrap();

        let sha_after_dir_change =
            compute_cache_key_sha_for_package(&pkg, &reg, TargetArch::Wasm32, TEST_ABI).unwrap();
        assert_ne!(
            sha_after, sha_after_dir_change,
            "build.toml directory input content changes must change cache_key_sha"
        );
    }

    #[test]
    fn compute_cache_key_sha_without_git_inputs_matches_pre_git_schema_key() {
        let root = tempdir("ckcs-no-git-inputs-golden");
        let package = root.join("legacy-source");
        std::fs::create_dir(&package).unwrap();
        std::fs::write(
            package.join("package.toml"),
            r#"
kind = "source"
name = "legacy-source"
version = "1.2.3"

[source]
url = "https://example.test/legacy-source-1.2.3.tar.gz"
sha256 = "0000000000000000000000000000000000000000000000000000000000000000"

[license]
spdx = "TestLicense"
"#,
        )
        .unwrap();
        std::fs::write(package.join("recipe.txt"), "recipe-v1\n").unwrap();
        std::fs::write(
            package.join("build.toml"),
            r#"
script_path = "build.sh"
inputs = ["recipe.txt"]
repo_url = "https://example.test/kandelo.git"
commit = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
revision = 7

[binary]
index_url = "https://example.test/releases/binaries-abi-v{abi}/index.toml"
"#,
        )
        .unwrap();
        let registry = Registry {
            roots: vec![root],
        };

        let actual = compute_cache_key_sha_for_package(
            &package,
            &registry,
            TargetArch::Wasm32,
            TEST_ABI,
        )
        .unwrap();

        // Golden produced by the resolver before build.toml learned the
        // optional [[git_inputs]] section. Merely adding that schema must not
        // invalidate every package whose immutable-Git vector remains empty.
        assert_eq!(
            actual,
            "db1f2fac54f8b14e0caf4f8a2e2fe15767f07260a4b0437cdb276ce6d40b5fb5"
        );
    }

    #[test]
    fn compute_cache_key_sha_uses_ordered_git_input_identities() {
        let root = tempdir("ckcs-git-inputs");
        write(&root, "libGit", "1.0.0", &[]);
        let reg = Registry {
            roots: vec![root.clone()],
        };
        let package = root.join("libGit");
        let build_path = package.join("build.toml");
        std::fs::write(
            &build_path,
            r#"
script_path = "packages/registry/libGit/build-libGit.sh"
repo_url = "https://example.test/kandelo.git"
commit = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
revision = 1

[[git_inputs]]
name = "first"
repository = "https://example.test/first.git"
commit = "1111111111111111111111111111111111111111"

[[git_inputs]]
name = "second"
repository = "https://example.test/second.git"
commit = "2222222222222222222222222222222222222222"

[binary]
index_url = "https://example.test/releases/binaries-abi-v{abi}/index.toml"
"#,
        )
        .unwrap();
        let manifest = reg.load("libGit").unwrap();
        let sha_before = compute_sha(
            &manifest,
            &reg,
            TEST_ARCH,
            TEST_ABI,
            &mut BTreeMap::new(),
            &mut Vec::new(),
        )
        .unwrap();
        let cache_root = root.join("cache");
        let old_canonical = canonical_path(&cache_root, &manifest, TEST_ARCH, &sha_before);
        std::fs::create_dir_all(&old_canonical).unwrap();
        std::fs::write(old_canonical.join("stale"), "old git identity\n").unwrap();

        let original = std::fs::read_to_string(&build_path).unwrap();
        std::fs::write(
            &build_path,
            original.replace(
                "1111111111111111111111111111111111111111",
                "3333333333333333333333333333333333333333",
            ),
        )
        .unwrap();
        let sha_changed_commit = compute_sha(
            &manifest,
            &reg,
            TEST_ARCH,
            TEST_ABI,
            &mut BTreeMap::new(),
            &mut Vec::new(),
        )
        .unwrap();
        assert_ne!(sha_before, sha_changed_commit);
        let changed_canonical =
            canonical_path(&cache_root, &manifest, TEST_ARCH, &sha_changed_commit);
        assert_ne!(old_canonical, changed_canonical);
        assert!(
            !changed_canonical.exists(),
            "a cache hit built for a prior Git identity must not satisfy the current identity"
        );

        std::fs::write(
            &build_path,
            original
                .replace("name = \"first\"", "name = \"temporary\"")
                .replace("name = \"second\"", "name = \"first\"")
                .replace("name = \"temporary\"", "name = \"second\""),
        )
        .unwrap();
        let sha_reordered = compute_sha(
            &manifest,
            &reg,
            TEST_ARCH,
            TEST_ABI,
            &mut BTreeMap::new(),
            &mut Vec::new(),
        )
        .unwrap();
        assert_ne!(
            sha_before, sha_reordered,
            "authored git-input order is part of the cache identity"
        );
    }

    #[test]
    fn global_package_build_input_digests_change_with_content() {
        let root = tempdir("global-build-inputs");
        std::fs::write(root.join("toolchain.txt"), "one\n").unwrap();

        let before = global_package_build_input_digests_for(&root, &["toolchain.txt"]).unwrap();
        std::fs::write(root.join("toolchain.txt"), "two\n").unwrap();
        let after = global_package_build_input_digests_for(&root, &["toolchain.txt"]).unwrap();

        assert_ne!(
            before[0].digest, after[0].digest,
            "global build input content changes must change its digest"
        );
    }

    #[test]
    fn global_package_toolchain_inputs_include_package_build_actions() {
        for input in [
            ".github/actions/package-archive-build",
            ".github/actions/package-toolchain",
            ".github/actions/fetch-submodules",
            ".github/actions/download-run-artifacts",
        ] {
            assert!(
                GLOBAL_PACKAGE_TOOLCHAIN_INPUTS.contains(&input),
                "{input} must stay in package cache-key inputs"
            );
        }
    }

    #[test]
    fn fork_instrument_tool_inputs_hash_dependency_closure_instead_of_whole_lockfile() {
        assert!(
            !FORK_INSTRUMENT_TOOL_INPUTS.contains(&"Cargo.lock"),
            "raw Cargo.lock changes are too broad for program package cache keys"
        );
    }

    #[test]
    fn fork_instrument_cargo_dependency_digest_ignores_unrelated_lockfile_entries() {
        let root = tempdir("fork-cargo-closure");
        let fork_manifest = root.join("crates/fork-instrument/Cargo.toml");
        fs::create_dir_all(fork_manifest.parent().unwrap()).unwrap();
        fs::write(&fork_manifest, "").unwrap();
        let fork_manifest = fork_manifest.to_string_lossy().to_string();

        let metadata = json!({
            "packages": [
                {
                    "id": "path+file:///repo/crates/fork-instrument#0.1.0",
                    "name": "fork-instrument",
                    "version": "0.1.0",
                    "source": null,
                    "manifest_path": fork_manifest,
                },
                {
                    "id": "registry+https://github.com/rust-lang/crates.io-index#anyhow@1.0.0",
                    "name": "anyhow",
                    "version": "1.0.0",
                    "source": "registry+https://github.com/rust-lang/crates.io-index",
                    "manifest_path": "/cargo/registry/anyhow-1.0.0/Cargo.toml",
                },
                {
                    "id": "registry+https://github.com/rust-lang/crates.io-index#dev-only@1.0.0",
                    "name": "dev-only",
                    "version": "1.0.0",
                    "source": "registry+https://github.com/rust-lang/crates.io-index",
                    "manifest_path": "/cargo/registry/dev-only-1.0.0/Cargo.toml",
                },
                {
                    "id": "registry+https://github.com/rust-lang/crates.io-index#kernel-only@1.0.0",
                    "name": "kernel-only",
                    "version": "1.0.0",
                    "source": "registry+https://github.com/rust-lang/crates.io-index",
                    "manifest_path": "/cargo/registry/kernel-only-1.0.0/Cargo.toml",
                }
            ],
            "resolve": {
                "nodes": [
                    {
                        "id": "path+file:///repo/crates/fork-instrument#0.1.0",
                        "features": [],
                        "deps": [
                            {
                                "name": "anyhow",
                                "pkg": "registry+https://github.com/rust-lang/crates.io-index#anyhow@1.0.0",
                                "dep_kinds": [{ "kind": null, "target": null }]
                            },
                            {
                                "name": "dev-only",
                                "pkg": "registry+https://github.com/rust-lang/crates.io-index#dev-only@1.0.0",
                                "dep_kinds": [{ "kind": "dev", "target": null }]
                            }
                        ]
                    },
                    {
                        "id": "registry+https://github.com/rust-lang/crates.io-index#anyhow@1.0.0",
                        "features": ["std"],
                        "deps": []
                    },
                    {
                        "id": "registry+https://github.com/rust-lang/crates.io-index#dev-only@1.0.0",
                        "features": [],
                        "deps": []
                    },
                    {
                        "id": "registry+https://github.com/rust-lang/crates.io-index#kernel-only@1.0.0",
                        "features": [],
                        "deps": []
                    }
                ]
            }
        });
        let lock =
            |anyhow_checksum: &str, dev_checksum: &str, unrelated_checksum: &str| CargoLock {
                package: vec![
                    CargoLockPackage {
                        name: "anyhow".into(),
                        version: "1.0.0".into(),
                        source: Some(
                            "registry+https://github.com/rust-lang/crates.io-index".into(),
                        ),
                        checksum: Some(anyhow_checksum.into()),
                    },
                    CargoLockPackage {
                        name: "dev-only".into(),
                        version: "1.0.0".into(),
                        source: Some(
                            "registry+https://github.com/rust-lang/crates.io-index".into(),
                        ),
                        checksum: Some(dev_checksum.into()),
                    },
                    CargoLockPackage {
                        name: "kernel-only".into(),
                        version: "1.0.0".into(),
                        source: Some(
                            "registry+https://github.com/rust-lang/crates.io-index".into(),
                        ),
                        checksum: Some(unrelated_checksum.into()),
                    },
                ],
            };

        let before = fork_instrument_cargo_dependency_digest_from_metadata(
            &root,
            &metadata,
            &lock("normal-a", "dev-a", "unrelated-a"),
        )
        .unwrap();
        let unrelated_after = fork_instrument_cargo_dependency_digest_from_metadata(
            &root,
            &metadata,
            &lock("normal-a", "dev-b", "unrelated-b"),
        )
        .unwrap();
        assert_eq!(
            before, unrelated_after,
            "dev-only and unrelated Cargo.lock entries must not affect the fork-instrument build digest"
        );

        let dependency_after = fork_instrument_cargo_dependency_digest_from_metadata(
            &root,
            &metadata,
            &lock("normal-b", "dev-b", "unrelated-b"),
        )
        .unwrap();
        assert_ne!(
            before, dependency_after,
            "normal fork-instrument dependency lockfile changes must affect the build digest"
        );
    }

    #[test]
    fn global_package_build_input_digests_reject_missing_input() {
        let root = tempdir("global-build-input-missing");

        let err =
            global_package_build_input_digests_for(&root, &["missing-toolchain.txt"]).unwrap_err();

        assert!(err.contains("global package build input"), "got: {err}");
    }

    #[test]
    fn fork_instrument_tool_inputs_apply_only_to_programs_that_use_them() {
        let dir = tempdir("fork-tool-input-applicability");
        let auto_program = DepsManifest::parse(
            r#"
kind = "program"
name = "auto-prog"
version = "1.0.0"
depends_on = []

[source]
url = "https://example.test/auto-prog.tar.gz"
sha256 = "0000000000000000000000000000000000000000000000000000000000000000"

[license]
spdx = "TestLicense"

[[outputs]]
name = "auto-prog"
wasm = "auto-prog.wasm"
"#,
            dir.clone(),
        )
        .unwrap();
        let disabled_program = DepsManifest::parse(
            r#"
kind = "program"
name = "disabled-prog"
version = "1.0.0"
depends_on = []

[source]
url = "https://example.test/disabled-prog.tar.gz"
sha256 = "0000000000000000000000000000000000000000000000000000000000000000"

[license]
spdx = "TestLicense"

[[outputs]]
name = "disabled-prog"
wasm = "disabled-prog.wasm"
fork_instrumentation = "disabled"
"#,
            dir,
        )
        .unwrap();

        assert!(package_uses_fork_instrument_tool(&auto_program));
        assert!(!package_uses_fork_instrument_tool(&disabled_program));
    }

    #[test]
    fn compute_cache_key_sha_rejects_missing_build_toml_input() {
        let root = tempdir("ckcs-missing-build-input");
        write(&root, "libMissingInput", "1.0.0", &[]);
        let reg = Registry {
            roots: vec![root.clone()],
        };

        let pkg = root.join("libMissingInput");
        std::fs::write(
            pkg.join("build.toml"),
            r#"
script_path = "libMissingInput/build-libMissingInput.sh"
inputs = ["libMissingInput/nope.txt"]
repo_url    = "https://example.test/repo.git"
commit      = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
revision    = 1

[binary]
index_url = "https://example.test/releases/download/binaries-abi-v{abi}/index.toml"
"#,
        )
        .unwrap();

        let err = compute_cache_key_sha_for_package(&pkg, &reg, TargetArch::Wasm32, TEST_ABI)
            .unwrap_err();
        assert!(err.contains("build input"), "got: {err}");
        assert!(err.contains("nope.txt"), "got: {err}");
    }

    #[test]
    fn compute_cache_key_sha_is_deterministic_across_invocations() {
        let root = tempdir("ckcs-deterministic");
        write(&root, "libDet", "1.0.0", &[]);
        let reg = Registry {
            roots: vec![root.clone()],
        };
        let pkg = root.join("libDet");

        let sha1 =
            compute_cache_key_sha_for_package(&pkg, &reg, TargetArch::Wasm32, TEST_ABI).unwrap();
        let sha2 =
            compute_cache_key_sha_for_package(&pkg, &reg, TargetArch::Wasm32, TEST_ABI).unwrap();
        assert_eq!(sha1, sha2, "two invocations on identical inputs must agree");
        assert_eq!(sha1.len(), 64);
    }

    #[test]
    fn compute_cache_key_sha_args_parse_long_form() {
        let (pkg, arch) = parse_compute_cache_key_sha_args(vec![
            "--package".into(),
            "packages/registry/bash".into(),
            "--arch".into(),
            "wasm32".into(),
        ])
        .unwrap();
        assert_eq!(pkg, PathBuf::from("packages/registry/bash"));
        assert!(matches!(arch, TargetArch::Wasm32));
    }

    #[test]
    fn compute_cache_key_sha_args_parse_equals_form() {
        let (pkg, arch) = parse_compute_cache_key_sha_args(vec![
            "--package=some/dir".into(),
            "--arch=wasm64".into(),
        ])
        .unwrap();
        assert_eq!(pkg, PathBuf::from("some/dir"));
        assert!(matches!(arch, TargetArch::Wasm64));
    }

    #[test]
    fn compute_cache_key_sha_args_reject_missing_package() {
        let err =
            parse_compute_cache_key_sha_args(vec!["--arch".into(), "wasm32".into()]).unwrap_err();
        assert!(err.contains("--package"), "got: {err}");
    }

    #[test]
    fn compute_cache_key_sha_args_reject_missing_arch() {
        let err = parse_compute_cache_key_sha_args(vec!["--package".into(), "some/dir".into()])
            .unwrap_err();
        assert!(err.contains("--arch"), "got: {err}");
    }

    #[test]
    fn compute_cache_key_sha_args_reject_unknown_flag() {
        let err = parse_compute_cache_key_sha_args(vec![
            "--package".into(),
            "x".into(),
            "--arch".into(),
            "wasm32".into(),
            "--bogus".into(),
        ])
        .unwrap_err();
        assert!(
            err.contains("--bogus") || err.contains("unexpected"),
            "got: {err}"
        );
    }

    // --- outputs-folding cache-key tests ---
    //
    // These pin the cache_key_sha contract that changing any declared
    // output (library lib/header/pkgconfig path or program output's
    // name/wasm) must invalidate the cache key. Without this, a build
    // can be served from a canonical cache directory whose contents
    // don't match the current `[outputs]` / `[[outputs]]` declaration —
    // which is exactly how PR #384 shipped broken archives for
    // lamp/mariadb-vfs (see the bug report on this branch).

    /// Write a `kind = "program"` package.toml with a custom `[[outputs]]`
    /// block. `outputs_block` is the literal TOML body (e.g.
    /// `r#"[[outputs]]\nname = "p"\nwasm = "p.wasm"\n"#`).
    fn write_program_manifest(dir: &Path, name: &str, version: &str, outputs_block: &str) {
        let prog_dir = dir.join(name);
        fs::create_dir_all(&prog_dir).unwrap();
        let text = format!(
            r#"
kind = "program"
name = "{name}"
version = "{version}"
depends_on = []

[source]
url = "https://example.test/{name}-{version}.tar.gz"
sha256 = "{:0>64}"

[license]
spdx = "TestLicense"

{outputs_block}
"#,
            ""
        );
        fs::write(prog_dir.join("package.toml"), text).unwrap();
    }

    fn sha_of(reg: &Registry, name: &str) -> [u8; 32] {
        let m = reg.load(name).unwrap();
        compute_sha(
            &m,
            reg,
            TEST_ARCH,
            TEST_ABI,
            &mut BTreeMap::new(),
            &mut Vec::new(),
        )
        .unwrap()
    }

    /// The exact failure mode from PR #384: a program changes its
    /// declared output filename (e.g. `lamp.vfs` → `lamp.vfs.zst`) but
    /// nothing else. Before the fix, cache_key_sha was unchanged so
    /// the resolver served the old canonical directory containing the
    /// old filename, and `archive-stage` silently packed broken
    /// archives.
    #[test]
    fn cache_key_sha_changes_when_program_output_wasm_filename_changes() {
        let root = tempdir("sha-prog-wasm-rename");
        write_program_manifest(
            &root,
            "lamp",
            "1.0.0",
            "[[outputs]]\nname = \"lamp\"\nwasm = \"lamp.vfs\"\n",
        );
        let reg = Registry {
            roots: vec![root.clone()],
        };
        let sha_before = sha_of(&reg, "lamp");

        // Same manifest, different output filename — exactly the
        // PR #384 transition.
        let toml_path = root.join("lamp/package.toml");
        let text = std::fs::read_to_string(&toml_path).unwrap();
        std::fs::write(&toml_path, text.replace("lamp.vfs", "lamp.vfs.zst")).unwrap();
        let sha_after = sha_of(&reg, "lamp");

        assert_ne!(
            sha_before, sha_after,
            "renaming a program output's wasm filename must invalidate the cache key"
        );
    }

    #[test]
    fn cache_key_sha_changes_when_program_output_name_changes() {
        let root = tempdir("sha-prog-name-rename");
        write_program_manifest(
            &root,
            "tool",
            "1.0.0",
            "[[outputs]]\nname = \"tool\"\nwasm = \"tool.wasm\"\n",
        );
        let reg = Registry {
            roots: vec![root.clone()],
        };
        let sha_before = sha_of(&reg, "tool");

        let toml_path = root.join("tool/package.toml");
        let text = std::fs::read_to_string(&toml_path).unwrap();
        std::fs::write(
            &toml_path,
            text.replace("name = \"tool\"\nwasm", "name = \"tool-renamed\"\nwasm"),
        )
        .unwrap();
        let sha_after = sha_of(&reg, "tool");

        assert_ne!(
            sha_before, sha_after,
            "renaming a program output's logical name must invalidate the cache key"
        );
    }

    #[test]
    fn cache_key_sha_changes_when_program_output_fork_policy_changes() {
        let root = tempdir("sha-prog-fork-policy");
        write_program_manifest(
            &root,
            "spidermonkey",
            "1.0.0",
            "[[outputs]]\nname = \"js\"\nwasm = \"js.wasm\"\n",
        );
        let reg = Registry {
            roots: vec![root.clone()],
        };
        let sha_before = sha_of(&reg, "spidermonkey");

        let toml_path = root.join("spidermonkey/package.toml");
        let text = std::fs::read_to_string(&toml_path).unwrap();
        std::fs::write(
            &toml_path,
            text.replace(
                "wasm = \"js.wasm\"",
                "wasm = \"js.wasm\"\nfork_instrumentation = \"disabled\"",
            ),
        )
        .unwrap();
        let sha_after = sha_of(&reg, "spidermonkey");

        assert_ne!(
            sha_before, sha_after,
            "changing a program output's fork instrumentation policy must invalidate the cache key"
        );
    }

    #[test]
    fn output_fork_instrumentation_for_rel_is_arch_neutral() {
        let root = tempdir("fork-policy-for-rel");
        write_program_manifest(
            &root,
            "twobin",
            "1.0.0",
            r#"[[outputs]]
name = "alpha"
wasm = "alpha.wasm"

[[outputs]]
name = "beta"
wasm = "beta.wasm"
fork_instrumentation = "disabled"
"#,
        );
        let reg = Registry { roots: vec![root] };

        assert_eq!(
            output_fork_instrumentation_for_rel(&reg, "programs/wasm32/twobin/beta.wasm").unwrap(),
            ForkInstrumentationPolicy::Disabled
        );
        assert_eq!(
            output_fork_instrumentation_for_rel(&reg, "programs/wasm64/twobin/beta.wasm").unwrap(),
            ForkInstrumentationPolicy::Disabled
        );
        assert_eq!(
            output_fork_instrumentation_for_rel(&reg, "programs/twobin/beta.wasm").unwrap(),
            ForkInstrumentationPolicy::Disabled
        );
        assert_eq!(
            output_fork_instrumentation_for_rel(&reg, "programs/wasm32/twobin/alpha.wasm").unwrap(),
            ForkInstrumentationPolicy::Auto
        );
    }

    #[test]
    fn cache_key_sha_changes_when_program_output_added() {
        let root = tempdir("sha-prog-output-added");
        write_program_manifest(
            &root,
            "git",
            "1.0.0",
            "[[outputs]]\nname = \"git\"\nwasm = \"git.wasm\"\n",
        );
        let reg = Registry {
            roots: vec![root.clone()],
        };
        let sha_before = sha_of(&reg, "git");

        // Add a second output (e.g. git-remote-http alongside git).
        let toml_path = root.join("git/package.toml");
        let text = std::fs::read_to_string(&toml_path).unwrap();
        let added = format!(
            "{text}\n[[outputs]]\nname = \"git-remote-http\"\nwasm = \"git-remote-http.wasm\"\n"
        );
        std::fs::write(&toml_path, added).unwrap();
        let sha_after = sha_of(&reg, "git");

        assert_ne!(
            sha_before, sha_after,
            "adding a program output must invalidate the cache key"
        );
    }

    #[test]
    fn cache_key_sha_tracks_program_runtime_file_contract() {
        let root = tempdir("sha-prog-runtime-file");
        write_program_manifest(
            &root,
            "php",
            "1.0.0",
            "[[outputs]]\nname = \"php\"\nwasm = \"php.wasm\"\n",
        );
        let reg = Registry {
            roots: vec![root.clone()],
        };
        let baseline = sha_of(&reg, "php");
        let toml_path = root.join("php/package.toml");
        let original = std::fs::read_to_string(&toml_path).unwrap();

        let with_runtime = format!(
            "{original}\n[[runtime_files]]\nartifact = \"icu.dat\"\nguest_path = \"/usr/lib/php/icu.dat\"\n"
        );
        std::fs::write(&toml_path, &with_runtime).unwrap();
        let added = sha_of(&reg, "php");
        assert_ne!(
            baseline, added,
            "adding runtime closure must invalidate the key"
        );

        std::fs::write(
            &toml_path,
            with_runtime.replace("/usr/lib/php/icu.dat", "/opt/php/icu.dat"),
        )
        .unwrap();
        let moved = sha_of(&reg, "php");
        assert_ne!(
            added, moved,
            "changing the guest path must invalidate the key"
        );

        std::fs::write(&toml_path, format!("{with_runtime}mode = 384\n")).unwrap();
        let remoded = sha_of(&reg, "php");
        assert_ne!(
            added, remoded,
            "changing runtime mode must invalidate the key"
        );

        // Length prefixes keep delimiter-bearing fields unambiguous. These
        // two records collide under naive `artifact|guest` concatenation.
        std::fs::write(
            &toml_path,
            format!("{original}\n[[runtime_files]]\nartifact = \"a|/b\"\nguest_path = \"/c\"\n"),
        )
        .unwrap();
        let delimiter_a = sha_of(&reg, "php");
        std::fs::write(
            &toml_path,
            format!("{original}\n[[runtime_files]]\nartifact = \"a\"\nguest_path = \"/b|/c\"\n"),
        )
        .unwrap();
        let delimiter_b = sha_of(&reg, "php");
        assert_ne!(
            delimiter_a, delimiter_b,
            "runtime hash fields must be framed"
        );
    }

    /// Pins behavior: program outputs are hashed in declaration order.
    /// Re-ordering DOES change cache_key_sha. We deliberately don't
    /// normalize because (a) the manifest preserves authored order
    /// (`Vec<ProgramOutput>`) and (b) consumers of `program_outputs`
    /// (e.g. `place_binaries_symlinks`) iterate in the same order, so
    /// the cache key tracks what consumers see.
    #[test]
    fn cache_key_sha_changes_when_program_outputs_reordered() {
        let root = tempdir("sha-prog-reorder");
        write_program_manifest(
            &root,
            "git",
            "1.0.0",
            "[[outputs]]\nname = \"git\"\nwasm = \"git.wasm\"\n\n\
             [[outputs]]\nname = \"git-remote-http\"\nwasm = \"git-remote-http.wasm\"\n",
        );
        let reg = Registry {
            roots: vec![root.clone()],
        };
        let sha_before = sha_of(&reg, "git");

        // Swap the two output entries.
        let toml_path = root.join("git/package.toml");
        std::fs::write(
            &toml_path,
            std::fs::read_to_string(&toml_path).unwrap().replace(
                "[[outputs]]\nname = \"git\"\nwasm = \"git.wasm\"\n\n\
                     [[outputs]]\nname = \"git-remote-http\"\nwasm = \"git-remote-http.wasm\"\n",
                "[[outputs]]\nname = \"git-remote-http\"\nwasm = \"git-remote-http.wasm\"\n\n\
                     [[outputs]]\nname = \"git\"\nwasm = \"git.wasm\"\n",
            ),
        )
        .unwrap();
        let sha_after = sha_of(&reg, "git");

        assert_ne!(
            sha_before, sha_after,
            "re-ordering program outputs is a meaningful change (not normalized) and must \
             invalidate the cache key"
        );
    }

    #[test]
    fn cache_key_sha_changes_when_library_output_lib_filename_changes() {
        let root = tempdir("sha-lib-rename");
        write(&root, "libZ", "1.0.0", &[]);
        let reg = Registry {
            roots: vec![root.clone()],
        };
        let sha_before = sha_of(&reg, "libZ");

        let toml_path = root.join("libZ/package.toml");
        let text = std::fs::read_to_string(&toml_path).unwrap();
        std::fs::write(
            &toml_path,
            text.replace("lib/liblibZ.a", "lib/liblibZ-renamed.a"),
        )
        .unwrap();
        let sha_after = sha_of(&reg, "libZ");

        assert_ne!(
            sha_before, sha_after,
            "renaming a library's output lib must invalidate the cache key"
        );
    }

    #[test]
    fn cache_key_sha_changes_when_library_output_header_added() {
        let root = tempdir("sha-lib-header-added");
        write(&root, "libZ", "1.0.0", &[]);
        let reg = Registry {
            roots: vec![root.clone()],
        };
        let sha_before = sha_of(&reg, "libZ");

        let toml_path = root.join("libZ/package.toml");
        let text = std::fs::read_to_string(&toml_path).unwrap();
        std::fs::write(
            &toml_path,
            text.replace(
                "libs = [\"lib/liblibZ.a\"]",
                "libs = [\"lib/liblibZ.a\"]\nheaders = [\"include/libZ.h\"]",
            ),
        )
        .unwrap();
        let sha_after = sha_of(&reg, "libZ");

        assert_ne!(
            sha_before, sha_after,
            "adding a library header output must invalidate the cache key"
        );
    }

    #[test]
    fn cache_key_sha_changes_when_library_output_pkgconfig_added() {
        let root = tempdir("sha-lib-pkgconfig-added");
        write(&root, "libZ", "1.0.0", &[]);
        let reg = Registry {
            roots: vec![root.clone()],
        };
        let sha_before = sha_of(&reg, "libZ");

        let toml_path = root.join("libZ/package.toml");
        let text = std::fs::read_to_string(&toml_path).unwrap();
        std::fs::write(
            &toml_path,
            text.replace(
                "libs = [\"lib/liblibZ.a\"]",
                "libs = [\"lib/liblibZ.a\"]\npkgconfig = [\"lib/pkgconfig/libZ.pc\"]",
            ),
        )
        .unwrap();
        let sha_after = sha_of(&reg, "libZ");

        assert_ne!(
            sha_before, sha_after,
            "adding a library pkgconfig output must invalidate the cache key"
        );
    }

    #[test]
    fn cache_key_sha_changes_when_library_runtime_file_added() {
        let root = tempdir("sha-lib-runtime-file-added");
        write(&root, "libZ", "1.0.0", &[]);
        let reg = Registry {
            roots: vec![root.clone()],
        };
        let sha_before = sha_of(&reg, "libZ");

        let toml_path = root.join("libZ/package.toml");
        let text = std::fs::read_to_string(&toml_path).unwrap();
        std::fs::write(
            &toml_path,
            text.replace(
                "libs = [\"lib/liblibZ.a\"]",
                "libs = [\"lib/liblibZ.a\"]\nfiles = [\"share/libZ.dat\"]",
            ),
        )
        .unwrap();
        let sha_after = sha_of(&reg, "libZ");

        assert_ne!(
            sha_before, sha_after,
            "adding a library runtime file output must invalidate the cache key"
        );
    }

    #[test]
    fn library_runtime_file_cache_keys_frame_delimiter_bearing_paths() {
        let root = tempdir("sha-lib-runtime-file-framing");
        write(&root, "libZ", "1.0.0", &[]);
        let reg = Registry {
            roots: vec![root.clone()],
        };
        let toml_path = root.join("libZ/package.toml");
        let original = std::fs::read_to_string(&toml_path).unwrap();

        std::fs::write(
            &toml_path,
            original.replace(
                "libs = [\"lib/liblibZ.a\"]",
                "libs = [\"lib/liblibZ.a\"]\nfiles = [\"a|b\", \"c\"]",
            ),
        )
        .unwrap();
        let delimiter_a = sha_of(&reg, "libZ");

        std::fs::write(
            &toml_path,
            original.replace(
                "libs = [\"lib/liblibZ.a\"]",
                "libs = [\"lib/liblibZ.a\"]\nfiles = [\"a\", \"b|c\"]",
            ),
        )
        .unwrap();
        let delimiter_b = sha_of(&reg, "libZ");

        assert_ne!(
            delimiter_a, delimiter_b,
            "library runtime-file cache-key fields must be length framed"
        );
    }

    // --- ensure_built / build_into_cache tests ---

    /// Create a package.toml + build-<name>.sh pair. The build script uses
    /// `WASM_POSIX_DEP_OUT_DIR` to lay out declared outputs.
    fn write_lib(
        root: &Path,
        name: &str,
        version: &str,
        depends_on: &[&str],
        build_body: &str,
        outputs_section: &str,
    ) {
        let lib_dir = root.join(name);
        std::fs::create_dir_all(&lib_dir).unwrap();

        let depends = depends_on
            .iter()
            .map(|s| format!("{:?}", s))
            .collect::<Vec<_>>()
            .join(", ");
        let deps_toml = format!(
            r#"
kind = "library"
name = "{name}"
version = "{version}"
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
        std::fs::write(lib_dir.join("package.toml"), deps_toml).unwrap();

        let script = format!("#!/bin/bash\nset -euo pipefail\n{build_body}\n");
        let script_path = lib_dir.join(format!("build-{name}.sh"));
        std::fs::write(&script_path, script).unwrap();

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut p = std::fs::metadata(&script_path).unwrap().permissions();
            p.set_mode(0o755);
            std::fs::set_permissions(&script_path, p).unwrap();
        }
    }

    fn resolve_opts<'a>(cache: &'a Path, local: Option<&'a Path>) -> ResolveOpts<'a> {
        ResolveOpts {
            cache_root: cache,
            local_libs: local,
            force_source_build: None,
            fetch_only: false,
            repo_root: None,
            binaries_dir: None,
        }
    }

    /// Like `resolve_opts`, but lets a test pin a specific
    /// `repo_root` so an explicit `[build].script_path` resolves
    /// against a tempdir rather than the live workspace. Phase A-bis
    /// Task 2.
    fn resolve_opts_with_repo<'a>(
        cache: &'a Path,
        local: Option<&'a Path>,
        repo_root: &'a Path,
    ) -> ResolveOpts<'a> {
        ResolveOpts {
            cache_root: cache,
            local_libs: local,
            force_source_build: None,
            fetch_only: false,
            repo_root: Some(repo_root),
            binaries_dir: None,
        }
    }

    #[test]
    fn ensure_built_runs_script_on_cache_miss() {
        let root = tempdir("built-miss-reg");
        let cache = tempdir("built-miss-cache");
        write_lib(
            &root,
            "libA",
            "1.0.0",
            &[],
            // The body uses the contract env vars — verifies they are set.
            r#"
test -n "$WASM_POSIX_DEP_SOURCE_URL"    || { echo "SOURCE_URL unset"    >&2; exit 1; }
test -n "$WASM_POSIX_DEP_SOURCE_SHA256" || { echo "SOURCE_SHA256 unset" >&2; exit 1; }
mkdir -p "$WASM_POSIX_DEP_OUT_DIR/lib"
touch "$WASM_POSIX_DEP_OUT_DIR/lib/libA.a"
echo "$WASM_POSIX_DEP_NAME $WASM_POSIX_DEP_VERSION rev$WASM_POSIX_DEP_REVISION" > "$WASM_POSIX_DEP_OUT_DIR/stamp"
"#,
            r#"[outputs]
libs = ["lib/libA.a"]
"#,
        );
        let reg = Registry { roots: vec![root] };
        let m = reg.load("libA").unwrap();

        let path =
            ensure_built(&m, &reg, TEST_ARCH, TEST_ABI, &resolve_opts(&cache, None)).unwrap();
        assert!(path.starts_with(cache.join("libs")));
        assert!(path.join("lib/libA.a").exists());
        let stamp = std::fs::read_to_string(path.join("stamp")).unwrap();
        assert_eq!(stamp.trim(), "libA 1.0.0 rev1");
    }

    #[test]
    fn ensure_built_is_idempotent_on_cache_hit() {
        let root = tempdir("built-hit-reg");
        let cache = tempdir("built-hit-cache");
        write_lib(
            &root,
            "libB",
            "1.0.0",
            &[],
            // Counter file in the registry dir records each invocation.
            &format!(
                r#"
echo ran >> "{}/counter"
mkdir -p "$WASM_POSIX_DEP_OUT_DIR/lib"
touch "$WASM_POSIX_DEP_OUT_DIR/lib/libB.a"
"#,
                root.display()
            ),
            r#"[outputs]
libs = ["lib/libB.a"]
"#,
        );
        let reg = Registry {
            roots: vec![root.clone()],
        };
        let m = reg.load("libB").unwrap();

        let p1 = ensure_built(&m, &reg, TEST_ARCH, TEST_ABI, &resolve_opts(&cache, None)).unwrap();
        let p2 = ensure_built(&m, &reg, TEST_ARCH, TEST_ABI, &resolve_opts(&cache, None)).unwrap();
        assert_eq!(p1, p2);
        let runs = std::fs::read_to_string(root.join("counter")).unwrap();
        assert_eq!(
            runs.lines().count(),
            1,
            "cache hit must skip the build script"
        );
    }

    #[test]
    fn process_memo_recomputes_identity_after_git_inputs_change() {
        let root = tempdir("memo-git-input-reg");
        let cache = tempdir("memo-git-input-cache");
        write_lib(
            &root,
            "libMemoGit",
            "1.0.0",
            &[],
            "mkdir -p \"$WASM_POSIX_DEP_OUT_DIR/lib\"; touch \"$WASM_POSIX_DEP_OUT_DIR/lib/libMemoGit.a\"",
            "[outputs]\nlibs = [\"lib/libMemoGit.a\"]\n",
        );
        let package_dir = root.join("libMemoGit");
        let build_path = package_dir.join("build.toml");
        let build_base = r#"script_path = "libMemoGit/build-libMemoGit.sh"
inputs = ["libMemoGit/build-libMemoGit.sh"]
repo_url = "https://example.test/kandelo.git"
commit = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
revision = 1
[binary]
index_url = "https://example.test/binaries-abi-v{abi}/index.toml"
"#;
        fs::write(&build_path, build_base).unwrap();
        let registry = Registry {
            roots: vec![root.clone()],
        };

        let first_manifest = registry.load("libMemoGit").unwrap();
        let first_sha = compute_sha(
            &first_manifest,
            &registry,
            TEST_ARCH,
            TEST_ABI,
            &mut BTreeMap::new(),
            &mut Vec::new(),
        )
        .unwrap();
        let first_path = canonical_path(&cache, &first_manifest, TEST_ARCH, &first_sha);
        fs::create_dir_all(first_path.join("lib")).unwrap();
        fs::write(first_path.join("lib/libMemoGit.a"), b"first").unwrap();
        let resolved_first = ensure_built(
            &first_manifest,
            &registry,
            TEST_ARCH,
            TEST_ABI,
            &resolve_opts(&cache, None),
        )
        .unwrap();
        assert_eq!(resolved_first, first_path);

        fs::write(
            &build_path,
            format!(
                r#"{build_base}
[[git_inputs]]
name = "tap"
repository = "https://example.test/tap.git"
commit = "1111111111111111111111111111111111111111"
"#,
            ),
        )
        .unwrap();
        let second_manifest = registry.load("libMemoGit").unwrap();
        let second_sha = compute_sha(
            &second_manifest,
            &registry,
            TEST_ARCH,
            TEST_ABI,
            &mut BTreeMap::new(),
            &mut Vec::new(),
        )
        .unwrap();
        assert_ne!(first_sha, second_sha);
        let second_path = canonical_path(&cache, &second_manifest, TEST_ARCH, &second_sha);
        fs::create_dir_all(second_path.join("lib")).unwrap();
        fs::write(second_path.join("lib/libMemoGit.a"), b"second").unwrap();
        write_cache_provenance(
            &second_manifest,
            &second_path,
            TEST_ARCH,
            TEST_ABI,
            &hex(&second_sha),
        )
        .unwrap();

        let resolved_second = ensure_built(
            &second_manifest,
            &registry,
            TEST_ARCH,
            TEST_ABI,
            &resolve_opts(&cache, None),
        )
        .unwrap();
        assert_eq!(resolved_second, second_path);
        assert_ne!(resolved_second, resolved_first);
        assert_eq!(
            fs::read(resolved_second.join("lib/libMemoGit.a")).unwrap(),
            b"second"
        );
    }

    #[test]
    fn build_script_sees_target_arch_env() {
        let root = tempdir("ta-env");
        let cache = tempdir("ta-env-cache");
        write_lib(
            &root,
            "libT",
            "1.0.0",
            &[],
            r#"test "$WASM_POSIX_DEP_TARGET_ARCH" = "wasm32" || { echo "TARGET_ARCH=$WASM_POSIX_DEP_TARGET_ARCH" >&2; exit 1; }
mkdir -p $WASM_POSIX_DEP_OUT_DIR/lib && touch $WASM_POSIX_DEP_OUT_DIR/lib/libT.a"#,
            "[outputs]\nlibs = [\"lib/libT.a\"]\n",
        );
        let reg = Registry { roots: vec![root] };
        let m = reg.load("libT").unwrap();
        ensure_built(
            &m,
            &reg,
            TargetArch::Wasm32,
            TEST_ABI,
            &resolve_opts(&cache, None),
        )
        .unwrap();
    }

    #[test]
    fn immutable_git_inputs_are_exact_detached_exported_and_reverified() {
        let root = tempdir("git-input-provision");
        let (source, commit) = immutable_git_fixture("git-input-source");
        let canonical = root.join("cache/programs/shell");
        fs::create_dir_all(canonical.parent().unwrap()).unwrap();
        let declaration = GitBuildInput {
            name: "homebrew_tap_core".to_string(),
            repository: format!("file://{}", source.display()),
            commit: commit.clone(),
        };

        let provisioned = ProvisionedGitInputs::provision_declarations(
            "shell@0.1.0",
            &canonical,
            vec![declaration.clone()],
        )
        .unwrap();
        let concurrent = ProvisionedGitInputs::provision_declarations(
            "shell@0.1.0",
            &canonical,
            vec![declaration],
        )
        .unwrap();
        assert_ne!(
            provisioned.root, concurrent.root,
            "exclusive temporary roots must not collide for concurrent builds"
        );
        drop(concurrent);
        let checkout = provisioned.inputs[0].checkout.clone();
        assert_eq!(
            fs::read_to_string(checkout.join("payload.txt")).unwrap(),
            "immutable payload\n"
        );
        assert_eq!(
            fixture_git(&checkout, &["rev-parse", "--abbrev-ref", "HEAD"]),
            "HEAD"
        );

        let mut command = Command::new("bash");
        command.arg("-c").arg(
            "printf '%s\\n%s\\n' \"$WASM_POSIX_BUILD_GIT_HOMEBREW_TAP_CORE_DIR\" \
             \"$WASM_POSIX_BUILD_GIT_HOMEBREW_TAP_CORE_COMMIT\"",
        );
        provisioned.export_to(&mut command);
        let output = command.output().unwrap();
        assert!(output.status.success());
        assert_eq!(
            String::from_utf8_lossy(&output.stdout),
            format!("{}\n{}\n", checkout.display(), commit)
        );

        let write_error = fs::write(checkout.join("generated.tmp"), "mutation\n").unwrap_err();
        assert_eq!(write_error.kind(), std::io::ErrorKind::PermissionDenied);

        // Defense in depth: even if a build deliberately changes permissions,
        // ignored outputs are still mutations of the declared input. Re-seal
        // the simulated mutation before exercising the post-build verifier.
        set_git_input_tree_read_only(&checkout, false).unwrap();
        fs::write(checkout.join("generated.tmp"), "mutation\n").unwrap();
        set_git_input_tree_read_only(&checkout, true).unwrap();
        let err = provisioned.verify_unchanged().unwrap_err();
        assert!(err.contains("mutated immutable checkout"), "got: {err}");

        let temporary_root = provisioned.root.clone().unwrap();
        drop(provisioned);
        assert!(
            !temporary_root.exists(),
            "temporary Git inputs must be removed when the build guard drops"
        );
    }

    #[cfg(unix)]
    #[test]
    fn immutable_git_inputs_ignore_hostile_home_xdg_templates_hooks_and_git_env() {
        use std::ffi::OsString;
        use std::os::unix::fs::PermissionsExt;

        let root = tempdir("git-input-hostile-env");
        let (source, commit) = immutable_git_fixture("git-input-hostile-env-source");
        let hostile_home = root.join("hostile-home");
        let hostile_xdg = root.join("hostile-xdg");
        let hostile_templates = root.join("hostile-templates");
        let hostile_hooks = root.join("hostile-hooks");
        for dir in [
            &hostile_home,
            &hostile_xdg.join("git"),
            &hostile_templates.join("hooks"),
            &hostile_hooks,
        ] {
            fs::create_dir_all(dir).unwrap();
        }
        let sentinel = root.join("ambient-git-state-was-used");
        let malicious_config = format!(
            "[url \"file:///definitely-unreachable/\"]\n\tinsteadOf = file://\n\
             [core]\n\thooksPath = {}\n",
            hostile_hooks.display(),
        );
        fs::write(hostile_home.join(".gitconfig"), &malicious_config).unwrap();
        fs::write(hostile_xdg.join("git/config"), &malicious_config).unwrap();
        fs::write(
            hostile_home.join(".netrc"),
            "machine example.test login private\n",
        )
        .unwrap();
        let hook = format!("#!/bin/sh\nprintf invoked > '{}'\n", sentinel.display());
        for path in [
            hostile_templates.join("hooks/post-checkout"),
            hostile_hooks.join("post-checkout"),
            root.join("hostile-askpass"),
        ] {
            fs::write(&path, &hook).unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        }

        let ambient = vec![
            (OsString::from("HOME"), hostile_home.as_os_str().to_owned()),
            (
                OsString::from("XDG_CONFIG_HOME"),
                hostile_xdg.as_os_str().to_owned(),
            ),
            (
                OsString::from("GIT_TEMPLATE_DIR"),
                hostile_templates.as_os_str().to_owned(),
            ),
            (
                OsString::from("GIT_CONFIG_GLOBAL"),
                hostile_home.join(".gitconfig").into_os_string(),
            ),
            (OsString::from("GIT_CONFIG_COUNT"), OsString::from("1")),
            (
                OsString::from("GIT_CONFIG_KEY_0"),
                OsString::from("url.file:///definitely-unreachable/.insteadOf"),
            ),
            (
                OsString::from("GIT_CONFIG_VALUE_0"),
                OsString::from("file://"),
            ),
            (
                OsString::from("GIT_ASKPASS"),
                root.join("hostile-askpass").into_os_string(),
            ),
            (OsString::from("GH_TOKEN"), OsString::from("must-not-leak")),
            (
                OsString::from("GIT_DIR"),
                root.join("wrong-git-dir").into_os_string(),
            ),
        ];
        let canonical = root.join("cache/programs/shell");
        fs::create_dir_all(canonical.parent().unwrap()).unwrap();
        let declaration = GitBuildInput {
            name: "tap".into(),
            repository: format!("file://{}", source.display()),
            commit,
        };
        let provisioned = ProvisionedGitInputs::provision_declarations_with_ambient_env(
            "shell@0.1.0",
            &canonical,
            vec![declaration.clone()],
            &ambient,
        )
        .unwrap();
        assert_eq!(
            fs::read_to_string(provisioned.inputs[0].checkout.join("payload.txt")).unwrap(),
            "immutable payload\n"
        );
        assert!(!sentinel.exists(), "ambient hook/template/askpass executed");

        let isolation = provisioned.isolation.as_ref().unwrap();
        assert!(
            isolation
                .home
                .starts_with(provisioned.root.as_ref().unwrap())
        );
        assert!(
            isolation
                .xdg_config_home
                .starts_with(provisioned.root.as_ref().unwrap())
        );
        assert!(isolation.askpass.is_absolute());
        let command = hardened_git_command(&declaration.repository, isolation, &ambient);
        let explicit_env: BTreeMap<_, _> = command
            .get_envs()
            .map(|(key, value)| (key.to_owned(), value.map(OsString::from)))
            .collect();
        assert_eq!(
            explicit_env
                .get(std::ffi::OsStr::new("HOME"))
                .unwrap()
                .as_deref(),
            Some(isolation.home.as_os_str())
        );
        assert_eq!(
            explicit_env
                .get(std::ffi::OsStr::new("GIT_ASKPASS"))
                .unwrap()
                .as_deref(),
            Some(isolation.askpass.as_os_str())
        );
        assert_eq!(
            explicit_env.get(std::ffi::OsStr::new("GH_TOKEN")),
            Some(&None)
        );
        assert_eq!(
            explicit_env.get(std::ffi::OsStr::new("GIT_CONFIG_KEY_0")),
            Some(&None)
        );
    }

    #[cfg(unix)]
    #[test]
    fn immutable_git_input_rejects_symlink_into_dot_git_config() {
        use std::os::unix::fs::symlink;

        let root = tempdir("git-input-dot-git-link");
        let (source, _commit) = immutable_git_fixture("git-input-dot-git-link-source");
        symlink(".git/config", source.join("git-config-link")).unwrap();
        fixture_git(&source, &["add", "git-config-link"]);
        fixture_git(&source, &["commit", "--quiet", "-m", "metadata link"]);
        let commit = fixture_git(&source, &["rev-parse", "HEAD"]);
        let canonical = root.join("cache/programs/shell");
        fs::create_dir_all(canonical.parent().unwrap()).unwrap();
        let error = ProvisionedGitInputs::provision_declarations(
            "shell@0.1.0",
            &canonical,
            vec![GitBuildInput {
                name: "tap".into(),
                repository: format!("file://{}", source.display()),
                commit,
            }],
        )
        .unwrap_err();
        assert!(
            error.contains("symlink") && error.contains("private Git metadata"),
            "got: {error}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn immutable_git_input_parent_seal_blocks_checkout_path_replacement() {
        let root = tempdir("git-input-parent-seal");
        let (source, commit) = immutable_git_fixture("git-input-parent-seal-source");
        let canonical = root.join("cache/programs/shell");
        fs::create_dir_all(canonical.parent().unwrap()).unwrap();
        let provisioned = ProvisionedGitInputs::provision_declarations(
            "shell@0.1.0",
            &canonical,
            vec![GitBuildInput {
                name: "tap".into(),
                repository: format!("file://{}", source.display()),
                commit,
            }],
        )
        .unwrap();
        let checkout = provisioned.inputs[0].checkout.clone();
        let checkout_parent = checkout.parent().unwrap();
        let error = fs::rename(&checkout, checkout_parent.join("replacement")).unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::PermissionDenied);
        let git_root = provisioned.root.as_ref().unwrap();
        let error = fs::rename(
            git_root.join("checkouts"),
            git_root.join("replacement-checkouts"),
        )
        .unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::PermissionDenied);
        provisioned.verify_unchanged().unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn immutable_git_worktree_digest_catches_assume_unchanged_evasion() {
        let root = tempdir("git-input-assume-unchanged");
        let (source, commit) = immutable_git_fixture("git-input-assume-unchanged-source");
        let canonical = root.join("cache/programs/shell");
        fs::create_dir_all(canonical.parent().unwrap()).unwrap();
        let provisioned = ProvisionedGitInputs::provision_declarations(
            "shell@0.1.0",
            &canonical,
            vec![GitBuildInput {
                name: "tap".into(),
                repository: format!("file://{}", source.display()),
                commit,
            }],
        )
        .unwrap();
        let checkout = provisioned.inputs[0].checkout.clone();
        set_git_input_tree_read_only(provisioned.root.as_ref().unwrap(), false).unwrap();
        fixture_git(
            &checkout,
            &["update-index", "--assume-unchanged", "payload.txt"],
        );
        fs::write(checkout.join("payload.txt"), "hidden mutation\n").unwrap();
        assert!(fixture_git(&checkout, &["status", "--porcelain=v1"]).is_empty());
        set_git_input_tree_read_only(provisioned.root.as_ref().unwrap(), true).unwrap();

        let error = provisioned.verify_unchanged().unwrap_err();
        assert!(
            error.contains("working-tree digest changed"),
            "got: {error}"
        );
    }

    #[test]
    fn immutable_git_input_rejects_a_different_exact_commit() {
        let root = tempdir("git-input-wrong-commit");
        let (source, _commit) = immutable_git_fixture("git-input-wrong-source");
        let canonical = root.join("cache/programs/shell");
        fs::create_dir_all(canonical.parent().unwrap()).unwrap();
        let err = ProvisionedGitInputs::provision_declarations(
            "shell@0.1.0",
            &canonical,
            vec![GitBuildInput {
                name: "homebrew_tap_core".to_string(),
                repository: format!("file://{}", source.display()),
                commit: "1111111111111111111111111111111111111111".to_string(),
            }],
        )
        .unwrap_err();
        assert!(
            err.contains("fetch") && err.contains("failed"),
            "got: {err}"
        );
        assert!(
            fs::read_dir(canonical.parent().unwrap())
                .unwrap()
                .next()
                .is_none(),
            "failed provisioning must clean its temporary checkout"
        );
    }

    #[cfg(unix)]
    #[test]
    fn immutable_git_input_rejects_symlinks_that_escape_checkout() {
        use std::os::unix::fs::symlink;

        let root = tempdir("git-input-symlink");
        let (source, _commit) = immutable_git_fixture("git-input-symlink-source");
        let outside = source.parent().unwrap().join("outside.txt");
        fs::write(&outside, "outside\n").unwrap();
        symlink(&outside, source.join("escape")).unwrap();
        fixture_git(&source, &["add", "escape"]);
        fixture_git(&source, &["commit", "--quiet", "-m", "escape"]);
        let commit = fixture_git(&source, &["rev-parse", "HEAD"]);
        let canonical = root.join("cache/programs/shell");
        fs::create_dir_all(canonical.parent().unwrap()).unwrap();
        let err = ProvisionedGitInputs::provision_declarations(
            "shell@0.1.0",
            &canonical,
            vec![GitBuildInput {
                name: "tap".to_string(),
                repository: format!("file://{}", source.display()),
                commit,
            }],
        )
        .unwrap_err();
        assert!(
            err.contains("symlink") && err.contains("escapes"),
            "got: {err}"
        );
    }

    #[test]
    fn immutable_git_input_rejects_submodule_gitlinks() {
        let root = tempdir("git-input-gitlink");
        let (source, first_commit) = immutable_git_fixture("git-input-gitlink-source");
        fixture_git(
            &source,
            &[
                "update-index",
                "--add",
                "--cacheinfo",
                &format!("160000,{first_commit},vendor/submodule"),
            ],
        );
        fixture_git(&source, &["commit", "--quiet", "-m", "gitlink"]);
        let commit = fixture_git(&source, &["rev-parse", "HEAD"]);
        let canonical = root.join("cache/programs/shell");
        fs::create_dir_all(canonical.parent().unwrap()).unwrap();
        let err = ProvisionedGitInputs::provision_declarations(
            "shell@0.1.0",
            &canonical,
            vec![GitBuildInput {
                name: "tap".to_string(),
                repository: format!("file://{}", source.display()),
                commit,
            }],
        )
        .unwrap_err();
        assert!(err.contains("submodule gitlinks"), "got: {err}");
    }

    #[test]
    fn ensure_built_fails_when_declared_output_missing() {
        let root = tempdir("built-missing-out");
        let cache = tempdir("built-missing-cache");
        write_lib(
            &root,
            "libC",
            "1.0.0",
            &[],
            // Script succeeds but does NOT create the declared lib.
            r#"mkdir -p "$WASM_POSIX_DEP_OUT_DIR""#,
            r#"[outputs]
libs = ["lib/libC.a"]
"#,
        );
        let reg = Registry {
            roots: vec![root.clone()],
        };
        let m = reg.load("libC").unwrap();

        let err =
            ensure_built(&m, &reg, TEST_ARCH, TEST_ABI, &resolve_opts(&cache, None)).unwrap_err();
        assert!(err.contains("not produced"), "got: {err}");
        // Temp dir was cleaned up; canonical path does not exist.
        let sha = compute_sha(
            &m,
            &reg,
            TEST_ARCH,
            TEST_ABI,
            &mut BTreeMap::new(),
            &mut Vec::new(),
        )
        .unwrap();
        let canonical = canonical_path(&cache, &m, TEST_ARCH, &sha);
        assert!(
            !canonical.exists(),
            "canonical cache dir must not exist on failure"
        );

        // No leftover temp dirs in the libs/ directory.
        if let Ok(rd) = std::fs::read_dir(cache.join("libs")) {
            let leftovers: Vec<_> = rd.collect();
            for l in &leftovers {
                let e = l.as_ref().unwrap();
                assert!(
                    !e.file_name().to_string_lossy().contains(".tmp-"),
                    "found leftover: {:?}",
                    e.file_name()
                );
            }
        }
    }

    #[test]
    fn ensure_built_fails_when_declared_runtime_file_missing() {
        let root = tempdir("built-missing-runtime-file");
        let cache = tempdir("built-missing-runtime-file-cache");
        write_lib(
            &root,
            "libRuntimeMissing",
            "1.0.0",
            &[],
            r#"mkdir -p "$WASM_POSIX_DEP_OUT_DIR/lib"
touch "$WASM_POSIX_DEP_OUT_DIR/lib/libRuntimeMissing.a""#,
            r#"[outputs]
libs = ["lib/libRuntimeMissing.a"]
files = ["share/runtime.dat"]
"#,
        );
        let reg = Registry { roots: vec![root] };
        let m = reg.load("libRuntimeMissing").unwrap();

        let err =
            ensure_built(&m, &reg, TEST_ARCH, TEST_ABI, &resolve_opts(&cache, None)).unwrap_err();
        assert!(err.contains("declared files output"), "got: {err}");
        assert!(err.contains("share/runtime.dat"), "got: {err}");
    }

    #[test]
    fn ensure_built_accepts_declared_runtime_file() {
        let root = tempdir("built-runtime-file");
        let cache = tempdir("built-runtime-file-cache");
        write_lib(
            &root,
            "libRuntime",
            "1.0.0",
            &[],
            r#"mkdir -p "$WASM_POSIX_DEP_OUT_DIR/lib" "$WASM_POSIX_DEP_OUT_DIR/share"
touch "$WASM_POSIX_DEP_OUT_DIR/lib/libRuntime.a"
printf runtime > "$WASM_POSIX_DEP_OUT_DIR/share/runtime.dat""#,
            r#"[outputs]
libs = ["lib/libRuntime.a"]
files = ["share/runtime.dat"]
"#,
        );
        let reg = Registry { roots: vec![root] };
        let m = reg.load("libRuntime").unwrap();

        let path =
            ensure_built(&m, &reg, TEST_ARCH, TEST_ABI, &resolve_opts(&cache, None)).unwrap();
        assert_eq!(
            std::fs::read_to_string(path.join("share/runtime.dat")).unwrap(),
            "runtime"
        );
    }

    #[test]
    fn ensure_built_rejects_declared_runtime_file_directory() {
        let root = tempdir("built-runtime-file-directory");
        let cache = tempdir("built-runtime-file-directory-cache");
        write_lib(
            &root,
            "libRuntimeDirectory",
            "1.0.0",
            &[],
            r#"mkdir -p "$WASM_POSIX_DEP_OUT_DIR/lib" "$WASM_POSIX_DEP_OUT_DIR/share/runtime.dat"
touch "$WASM_POSIX_DEP_OUT_DIR/lib/libRuntimeDirectory.a""#,
            r#"[outputs]
libs = ["lib/libRuntimeDirectory.a"]
files = ["share/runtime.dat"]
"#,
        );
        let reg = Registry { roots: vec![root] };
        let m = reg.load("libRuntimeDirectory").unwrap();

        let err =
            ensure_built(&m, &reg, TEST_ARCH, TEST_ABI, &resolve_opts(&cache, None)).unwrap_err();
        assert!(err.contains("must be a regular file"), "got: {err}");
    }

    #[cfg(unix)]
    #[test]
    fn ensure_built_rejects_declared_runtime_file_symlink_escape() {
        let root = tempdir("built-runtime-file-symlink-escape");
        let cache = tempdir("built-runtime-file-symlink-escape-cache");
        let outside = root.join("outside.dat");
        std::fs::write(&outside, b"outside").unwrap();
        write_lib(
            &root,
            "libRuntimeSymlinkEscape",
            "1.0.0",
            &[],
            &format!(
                r#"mkdir -p "$WASM_POSIX_DEP_OUT_DIR/lib" "$WASM_POSIX_DEP_OUT_DIR/share"
touch "$WASM_POSIX_DEP_OUT_DIR/lib/libRuntimeSymlinkEscape.a"
ln -s {:?} "$WASM_POSIX_DEP_OUT_DIR/share/runtime.dat""#,
                outside
            ),
            r#"[outputs]
libs = ["lib/libRuntimeSymlinkEscape.a"]
files = ["share/runtime.dat"]
"#,
        );
        let reg = Registry { roots: vec![root] };
        let m = reg.load("libRuntimeSymlinkEscape").unwrap();

        let err =
            ensure_built(&m, &reg, TEST_ARCH, TEST_ABI, &resolve_opts(&cache, None)).unwrap_err();
        assert!(err.contains("must not be a symlink"), "got: {err}");
    }

    #[test]
    fn ensure_built_fails_when_script_exits_nonzero() {
        let root = tempdir("built-badexit");
        let cache = tempdir("built-badexit-cache");
        write_lib(
            &root,
            "libD",
            "1.0.0",
            &[],
            "echo boom >&2\nexit 37",
            r#"[outputs]
libs = ["lib/libD.a"]
"#,
        );
        let reg = Registry { roots: vec![root] };
        let m = reg.load("libD").unwrap();

        let err =
            ensure_built(&m, &reg, TEST_ARCH, TEST_ABI, &resolve_opts(&cache, None)).unwrap_err();
        assert!(err.contains("exited"), "got: {err}");
        let sha = compute_sha(
            &m,
            &reg,
            TEST_ARCH,
            TEST_ABI,
            &mut BTreeMap::new(),
            &mut Vec::new(),
        )
        .unwrap();
        assert!(!canonical_path(&cache, &m, TEST_ARCH, &sha).exists());
    }

    /// Regression: build-script stdout must NOT leak to xtask's stdout.
    ///
    /// `cmd_resolve` consumers shell-capture xtask's stdout to read the
    /// canonical cache path:
    /// `PREFIX="$(cargo run -- build-deps resolve <name>)"`. If the bash
    /// subprocess's stdout were inherited (the default), every chatty
    /// `echo` in the build script would land on xtask's stdout ahead of
    /// the final `println!(path)`, and consumers would capture the
    /// build log instead of the path.
    ///
    /// The `build_into_cache` fix dups xtask's stderr fd into the bash
    /// subprocess's stdout. We can't easily intercept `println!` from
    /// inside a unit test, but we *can* verify the underlying mechanism
    /// works: spawn a child whose stdout is redirected to an OwnedFd
    /// (the same `Stdio::from(OwnedFd)` shape `build_into_cache` uses),
    /// and confirm the output arrives there — proving libstd routes the
    /// child's fd 1 to that fd and not to the test's own stdout.
    #[test]
    fn build_script_stdout_redirect_to_owned_fd_works() {
        use std::io::Read;
        use std::os::unix::net::UnixStream;

        // UnixStream::pair gives us two endpoints with full read+write,
        // both as `OwnedFd` via Into. We hand the bash subprocess one
        // end as its stdout and read from the other. This mirrors the
        // production shape: build_into_cache hands bash an OwnedFd
        // cloned from xtask's stderr; here we hand bash an OwnedFd
        // cloned from a socketpair endpoint. Both flow through the
        // same `Stdio::from(OwnedFd)` impl in libstd.
        let (parent, child) = UnixStream::pair().expect("socketpair");
        let child_fd: std::os::fd::OwnedFd = child.into();
        let stdio = Stdio::from(child_fd);

        let mut cmd = Command::new("bash");
        cmd.arg("-c");
        cmd.arg("echo BUILD_SCRIPT_STDOUT_LINE_THAT_MUST_NOT_LEAK; echo line2; echo line3");
        cmd.stdout(stdio);
        let status = cmd.status().expect("spawn bash");
        assert!(status.success(), "bash exit: {status}");

        // Read the redirected output. We must drop our local handle on
        // the child's write side first so the read end sees EOF — which
        // is automatic here: child_fd was moved into Stdio, so once
        // the child process exits, the only remaining write reference
        // is gone.
        drop(cmd);
        let mut reader = parent;
        let mut buf = String::new();
        reader.read_to_string(&mut buf).expect("read socketpair");
        assert!(
            buf.contains("BUILD_SCRIPT_STDOUT_LINE_THAT_MUST_NOT_LEAK"),
            "redirected stdout missing marker; got: {buf:?}"
        );
        assert!(buf.contains("line2"), "got: {buf:?}");
        assert!(buf.contains("line3"), "got: {buf:?}");
    }

    /// Regression companion: confirm the exact pattern used inside
    /// `build_into_cache` — `std::io::stderr().as_fd().try_clone_to_owned()`
    /// followed by `Stdio::from(OwnedFd)` — does not panic and does
    /// produce a usable Stdio. We can't observe the redirected output
    /// here (it would land on the test runner's stderr, which the
    /// runner captures and drops on success), but we *can* verify the
    /// dup-fd mechanism succeeds and the bash child runs successfully
    /// with that Stdio. A regression that broke try_clone_to_owned or
    /// the From<OwnedFd> for Stdio impl would surface here.
    #[test]
    fn build_into_cache_stderr_dup_pattern_does_not_panic() {
        let stderr_dup = std::io::stderr()
            .as_fd()
            .try_clone_to_owned()
            .expect("dup stderr fd");
        let mut cmd = Command::new("bash");
        cmd.arg("-c").arg("echo running >&2; exit 0");
        cmd.stdout(Stdio::from(stderr_dup));
        let status = cmd.status().expect("spawn bash");
        assert!(status.success(), "bash exit: {status}");
    }

    #[test]
    fn local_libs_override_wins() {
        let root = tempdir("override-reg");
        let cache = tempdir("override-cache");
        let local = tempdir("override-local");
        write_lib(
            &root,
            "libE",
            "1.0.0",
            &[],
            // If this ran we'd fail the test: override must prevent it.
            "exit 99",
            r#"[outputs]
libs = ["lib/libE.a"]
"#,
        );
        let override_build = local.join("libE").join("build");
        std::fs::create_dir_all(override_build.join("lib")).unwrap();
        std::fs::write(override_build.join("lib/libE.a"), b"").unwrap();

        let reg = Registry { roots: vec![root] };
        let m = reg.load("libE").unwrap();

        let path = ensure_built(
            &m,
            &reg,
            TEST_ARCH,
            TEST_ABI,
            &resolve_opts(&cache, Some(&local)),
        )
        .unwrap();
        assert_eq!(path, override_build);
    }

    #[test]
    fn transitive_deps_are_built_and_exposed_via_env() {
        let root = tempdir("transitive-reg");
        let cache = tempdir("transitive-cache");

        // libFoo produces a stamp header; libBar consumes it via env var.
        write_lib(
            &root,
            "libFoo",
            "1.0.0",
            &[],
            r#"
mkdir -p "$WASM_POSIX_DEP_OUT_DIR/include"
echo "foo header body" > "$WASM_POSIX_DEP_OUT_DIR/include/foo.h"
"#,
            r#"[outputs]
headers = ["include/foo.h"]
"#,
        );
        write_lib(
            &root,
            "libBar",
            "1.0.0",
            &["libFoo@1.0.0"],
            r#"
test -n "${WASM_POSIX_DEP_LIBFOO_DIR:-}" || { echo "LIBFOO_DIR not set" >&2; exit 1; }
test -f "$WASM_POSIX_DEP_LIBFOO_DIR/include/foo.h" || { echo "foo.h missing" >&2; exit 1; }
mkdir -p "$WASM_POSIX_DEP_OUT_DIR/lib"
cp "$WASM_POSIX_DEP_LIBFOO_DIR/include/foo.h" "$WASM_POSIX_DEP_OUT_DIR/lib/libBar.a"
"#,
            r#"[outputs]
libs = ["lib/libBar.a"]
"#,
        );
        let reg = Registry { roots: vec![root] };
        let bar = reg.load("libBar").unwrap();
        let bar_path =
            ensure_built(&bar, &reg, TEST_ARCH, TEST_ABI, &resolve_opts(&cache, None)).unwrap();

        let pseudo = std::fs::read_to_string(bar_path.join("lib/libBar.a")).unwrap();
        assert_eq!(pseudo.trim(), "foo header body");
    }

    #[test]
    fn env_key_canonicalises_hyphens_and_case() {
        assert_eq!(env_key("libcurl"), "LIBCURL");
        assert_eq!(env_key("zlib-ng"), "ZLIB_NG");
        assert_eq!(env_key("Foo-Bar-Baz"), "FOO_BAR_BAZ");
    }

    // --- pkgconfig / libtool archive path rewriting ---
    //
    // autoconf bakes `--prefix` into generated `.pc` / `.la` files at
    // configure time. Our build scripts configure with
    // `--prefix=$WASM_POSIX_DEP_OUT_DIR` — the temp dir. After the
    // atomic rename into the canonical cache path, those baked-in
    // strings point at a temp directory that no longer exists. The
    // resolver must rewrite them before (or as part of) the install
    // so downstream `pkg-config` / `libtool` consumers see a valid
    // path. These tests pin that behaviour.

    #[test]
    fn pkgconfig_prefix_is_rewritten_to_canonical_path() {
        let root = tempdir("pc-rewrite-reg");
        let cache = tempdir("pc-rewrite-cache");
        write_lib(
            &root,
            "libPc",
            "1.0.0",
            &[],
            // Bakes `prefix=$WASM_POSIX_DEP_OUT_DIR` into the .pc
            // file — the same mistake autoconf makes.
            r#"
mkdir -p "$WASM_POSIX_DEP_OUT_DIR/lib/pkgconfig"
touch "$WASM_POSIX_DEP_OUT_DIR/lib/libPc.a"
cat > "$WASM_POSIX_DEP_OUT_DIR/lib/pkgconfig/libPc.pc" <<PCEOF
prefix=$WASM_POSIX_DEP_OUT_DIR
libdir=\${prefix}/lib
Name: libPc
Version: 1.0.0
Libs: -L\${libdir} -lPc
PCEOF
"#,
            r#"[outputs]
libs = ["lib/libPc.a"]
pkgconfig = ["lib/pkgconfig/libPc.pc"]
"#,
        );
        let reg = Registry { roots: vec![root] };
        let m = reg.load("libPc").unwrap();

        let canonical =
            ensure_built(&m, &reg, TEST_ARCH, TEST_ABI, &resolve_opts(&cache, None)).unwrap();

        let pc = std::fs::read_to_string(canonical.join("lib/pkgconfig/libPc.pc")).unwrap();
        assert!(
            pc.contains(&format!("prefix={}", canonical.display())),
            "pkgconfig prefix must point at the canonical cache path; got:\n{pc}"
        );
        assert!(
            !pc.contains(".tmp-"),
            "pkgconfig must not contain any `.tmp-<pid>` substring; got:\n{pc}"
        );
    }

    #[test]
    fn libtool_archive_libdir_is_rewritten_to_canonical_path() {
        let root = tempdir("la-rewrite-reg");
        let cache = tempdir("la-rewrite-cache");
        write_lib(
            &root,
            "libLa",
            "1.0.0",
            &[],
            // libtool writes `libdir='<prefix>/lib'` — same problem.
            r#"
mkdir -p "$WASM_POSIX_DEP_OUT_DIR/lib"
touch "$WASM_POSIX_DEP_OUT_DIR/lib/libLa.a"
cat > "$WASM_POSIX_DEP_OUT_DIR/lib/libLa.la" <<LAEOF
# Generated by libtool
libdir='$WASM_POSIX_DEP_OUT_DIR/lib'
old_library='libLa.a'
LAEOF
"#,
            r#"[outputs]
libs = ["lib/libLa.a"]
"#,
        );
        let reg = Registry { roots: vec![root] };
        let m = reg.load("libLa").unwrap();

        let canonical =
            ensure_built(&m, &reg, TEST_ARCH, TEST_ABI, &resolve_opts(&cache, None)).unwrap();

        let la = std::fs::read_to_string(canonical.join("lib/libLa.la")).unwrap();
        assert!(
            la.contains(&format!("libdir='{}/lib'", canonical.display())),
            "libtool archive libdir must point at the canonical cache path; got:\n{la}"
        );
        assert!(
            !la.contains(".tmp-"),
            "libtool archive must not contain any `.tmp-<pid>` substring; got:\n{la}"
        );
    }

    #[test]
    fn pkgconfig_symlinks_survive_the_rewrite() {
        // libpng and ncurses install `lib{png,png16}.pc` plus a
        // `libpng.pc → libpng16.pc` symlink. The rewrite must not
        // follow the symlink (that would rewrite the real file
        // twice) and must not turn the symlink into a regular file.
        let root = tempdir("pc-symlink-reg");
        let cache = tempdir("pc-symlink-cache");
        write_lib(
            &root,
            "libSym",
            "1.0.0",
            &[],
            r#"
mkdir -p "$WASM_POSIX_DEP_OUT_DIR/lib/pkgconfig"
touch "$WASM_POSIX_DEP_OUT_DIR/lib/libSym.a"
cat > "$WASM_POSIX_DEP_OUT_DIR/lib/pkgconfig/libSym1.pc" <<PCEOF
prefix=$WASM_POSIX_DEP_OUT_DIR
libdir=\${prefix}/lib
Name: libSym
Version: 1.0.0
Libs: -L\${libdir} -lSym
PCEOF
ln -s libSym1.pc "$WASM_POSIX_DEP_OUT_DIR/lib/pkgconfig/libSym.pc"
"#,
            r#"[outputs]
libs = ["lib/libSym.a"]
pkgconfig = ["lib/pkgconfig/libSym1.pc"]
"#,
        );
        let reg = Registry { roots: vec![root] };
        let m = reg.load("libSym").unwrap();

        let canonical =
            ensure_built(&m, &reg, TEST_ARCH, TEST_ABI, &resolve_opts(&cache, None)).unwrap();

        let real = std::fs::read_to_string(canonical.join("lib/pkgconfig/libSym1.pc")).unwrap();
        assert!(
            real.contains(&format!("prefix={}", canonical.display())),
            "real .pc file must have canonical prefix; got:\n{real}"
        );
        assert!(!real.contains(".tmp-"));

        // Reading via the symlink produces the same (rewritten) text.
        let via_link = std::fs::read_to_string(canonical.join("lib/pkgconfig/libSym.pc")).unwrap();
        assert_eq!(real, via_link);

        // The symlink is still a symlink — we didn't overwrite it
        // with a regular file during the rewrite.
        let meta = std::fs::symlink_metadata(canonical.join("lib/pkgconfig/libSym.pc")).unwrap();
        assert!(
            meta.file_type().is_symlink(),
            "pkgconfig symlink must survive as a symlink after rewrite"
        );
    }

    #[test]
    fn canonical_path_layout() {
        let root = tempdir("cache-path");
        write(&root, "zlib", "1.3.1", &[]);
        let reg = Registry { roots: vec![root] };
        let m = reg.load("zlib").unwrap();
        let sha = compute_sha(
            &m,
            &reg,
            TEST_ARCH,
            TEST_ABI,
            &mut BTreeMap::new(),
            &mut Vec::new(),
        )
        .unwrap();
        let cache = PathBuf::from("/tmp/testcache");
        let path = canonical_path(&cache, &m, TEST_ARCH, &sha);

        let parent = path.parent().unwrap();
        assert_eq!(parent, cache.join("libs"));
        let name = path.file_name().unwrap().to_string_lossy().into_owned();
        // The path includes the arch segment between revN and the full cache key.
        assert!(name.starts_with("zlib-1.3.1-rev1-wasm32-"), "got {name}");
        let key = name.rsplit('-').next().unwrap();
        assert_eq!(key.len(), 64);
        assert!(key.chars().all(|c| c.is_ascii_hexdigit()));
        assert_eq!(key, hex(&sha));
    }

    #[test]
    fn source_kind_canonical_path_omits_arch() {
        let dir = tempdir("source-canonical");
        let m = parse_source_manifest(&dir);
        let sha = [0u8; 32];
        let cache = PathBuf::from("/cache");
        let path = canonical_path(&cache, &m, TargetArch::Wasm32, &sha);
        assert_eq!(
            path,
            PathBuf::from(format!(
                "/cache/sources/pcre2-source-10.42-rev1-{}",
                hex(&sha)
            ))
        );
    }

    #[test]
    fn canonical_path_does_not_alias_keys_with_the_same_archive_prefix() {
        let dir = tempdir("canonical-full-key");
        let m = parse_source_manifest(&dir);
        let mut first = [0u8; 32];
        let mut second = [0u8; 32];
        first[..4].copy_from_slice(&[0xde, 0xad, 0xbe, 0xef]);
        second[..4].copy_from_slice(&[0xde, 0xad, 0xbe, 0xef]);
        first[31] = 1;
        second[31] = 2;

        let first_path = canonical_path(Path::new("/cache"), &m, TEST_ARCH, &first);
        let second_path = canonical_path(Path::new("/cache"), &m, TEST_ARCH, &second);

        assert_ne!(first_path, second_path);
        assert!(first_path.to_string_lossy().ends_with(&hex(&first)));
        assert!(second_path.to_string_lossy().ends_with(&hex(&second)));
    }

    fn parse_source_manifest(dir: &Path) -> DepsManifest {
        let text = r#"
kind = "source"
name = "pcre2-source"
version = "10.42"

[source]
url = "https://example.test/pcre2.tar.bz2"
sha256 = "0000000000000000000000000000000000000000000000000000000000000000"

[license]
spdx = "BSD-3-Clause"
"#;
        DepsManifest::parse(text, dir.to_path_buf()).unwrap()
    }

    #[test]
    fn resolve_with_arch_wasm64_uses_different_cache_path() {
        let root = tempdir("arch-flag");
        let cache = tempdir("arch-cache");
        write_lib(
            &root,
            "libA",
            "1.0.0",
            &[],
            r#"
mkdir -p "$WASM_POSIX_DEP_OUT_DIR/lib"
touch "$WASM_POSIX_DEP_OUT_DIR/lib/libA.a"
"#,
            r#"[outputs]
libs = ["lib/libA.a"]
"#,
        );
        let reg = Registry { roots: vec![root] };
        let m = reg.load("libA").unwrap();

        let p32 = ensure_built(
            &m,
            &reg,
            TargetArch::Wasm32,
            TEST_ABI,
            &resolve_opts(&cache, None),
        )
        .unwrap();
        let p64 = ensure_built(
            &m,
            &reg,
            TargetArch::Wasm64,
            TEST_ABI,
            &resolve_opts(&cache, None),
        )
        .unwrap();
        assert_ne!(p32, p64);
        assert!(
            p32.to_string_lossy().contains("wasm32"),
            "wasm32 path missing arch segment: {}",
            p32.display()
        );
        assert!(
            p64.to_string_lossy().contains("wasm64"),
            "wasm64 path missing arch segment: {}",
            p64.display()
        );
    }

    #[test]
    fn parse_target_arch_accepts_known_values() {
        assert_eq!(parse_target_arch("wasm32").unwrap(), TargetArch::Wasm32);
        assert_eq!(parse_target_arch("wasm64").unwrap(), TargetArch::Wasm64);
    }

    #[test]
    fn parse_target_arch_rejects_unknown_values() {
        let err = parse_target_arch("x86_64").unwrap_err();
        assert!(err.contains("x86_64"), "got: {err}");
        assert!(
            err.contains("wasm32") && err.contains("wasm64"),
            "error should list valid options; got: {err}"
        );
    }

    /// `WASM_POSIX_DEP_PKG_CONFIG_PATH` is a colon-joined list of every
    /// transitively-resolved lib's `lib/pkgconfig/` directory. Consumers
    /// (e.g., wget, git) prepend it to `PKG_CONFIG_PATH` so pkg-config
    /// can chase `Requires.private` chains across the whole dep graph
    /// without each consumer hand-rolling per-dep search paths.
    ///
    /// The test sets up a 3-level chain:
    ///     libFoo (no deps, ships pkgconfig)
    ///       <- libBar (deps libFoo, ships pkgconfig)
    ///         <- libBaz (deps libBar — libFoo is transitive only)
    ///
    /// libBaz's build script asserts that `WASM_POSIX_DEP_PKG_CONFIG_PATH`
    /// contains BOTH libFoo's and libBar's pkgconfig dirs. Order is not
    /// fixed — we match either ordering via case patterns.
    #[test]
    fn pkg_config_path_includes_transitive_lib_pkgconfig() {
        let root = tempdir("pcpath-reg");
        let cache = tempdir("pcpath-cache");

        // libFoo: produces a .pc file. No deps.
        write_lib(
            &root,
            "libFoo",
            "1.0.0",
            &[],
            r#"
mkdir -p "$WASM_POSIX_DEP_OUT_DIR/lib/pkgconfig"
mkdir -p "$WASM_POSIX_DEP_OUT_DIR/include"
touch "$WASM_POSIX_DEP_OUT_DIR/include/foo.h"
cat > "$WASM_POSIX_DEP_OUT_DIR/lib/pkgconfig/libFoo.pc" <<'PCEOF'
Name: libFoo
Version: 1.0.0
PCEOF
"#,
            r#"[outputs]
headers = ["include/foo.h"]
pkgconfig = ["lib/pkgconfig/libFoo.pc"]
"#,
        );

        // libBar: depends on libFoo, also produces a .pc file.
        write_lib(
            &root,
            "libBar",
            "1.0.0",
            &["libFoo@1.0.0"],
            r#"
mkdir -p "$WASM_POSIX_DEP_OUT_DIR/lib/pkgconfig"
mkdir -p "$WASM_POSIX_DEP_OUT_DIR/include"
touch "$WASM_POSIX_DEP_OUT_DIR/include/bar.h"
cat > "$WASM_POSIX_DEP_OUT_DIR/lib/pkgconfig/libBar.pc" <<'PCEOF'
Name: libBar
Version: 1.0.0
Requires: libFoo
PCEOF
"#,
            r#"[outputs]
headers = ["include/bar.h"]
pkgconfig = ["lib/pkgconfig/libBar.pc"]
"#,
        );

        // libBaz: depends on libBar (libFoo is transitive). Build script
        // asserts WASM_POSIX_DEP_PKG_CONFIG_PATH contains both libFoo
        // and libBar pkgconfig dirs (order-insensitive).
        write_lib(
            &root,
            "libBaz",
            "1.0.0",
            &["libBar@1.0.0"],
            r#"
test -n "${WASM_POSIX_DEP_PKG_CONFIG_PATH:-}" || {
    echo "WASM_POSIX_DEP_PKG_CONFIG_PATH unset" >&2
    exit 1
}
case "$WASM_POSIX_DEP_PKG_CONFIG_PATH" in
    *libFoo*lib/pkgconfig*libBar*lib/pkgconfig*) : ;;
    *libBar*lib/pkgconfig*libFoo*lib/pkgconfig*) : ;;
    *)
        echo "WASM_POSIX_DEP_PKG_CONFIG_PATH does not contain both libFoo and libBar pkgconfig dirs:" >&2
        echo "  $WASM_POSIX_DEP_PKG_CONFIG_PATH" >&2
        exit 1
        ;;
esac
mkdir -p "$WASM_POSIX_DEP_OUT_DIR/lib"
touch "$WASM_POSIX_DEP_OUT_DIR/lib/libBaz.a"
"#,
            r#"[outputs]
libs = ["lib/libBaz.a"]
"#,
        );

        let reg = Registry { roots: vec![root] };
        let m = reg.load("libBaz").unwrap();
        ensure_built(&m, &reg, TEST_ARCH, TEST_ABI, &resolve_opts(&cache, None)).unwrap();
    }

    /// Libs without a `lib/pkgconfig/` directory (e.g., ncurses ships a
    /// `.pc` file optionally; some libs ship none at all) must be SKIPPED
    /// when composing `WASM_POSIX_DEP_PKG_CONFIG_PATH`. Otherwise we'd
    /// hand pkg-config a list of nonexistent search paths, which clutters
    /// diagnostics and (for some pkg-config versions) errors out.
    #[test]
    fn pkg_config_path_skips_libs_without_pkgconfig_dir() {
        let root = tempdir("pcpath-skip-reg");
        let cache = tempdir("pcpath-skip-cache");

        // libNoPc: ships only a header — no pkgconfig.
        write_lib(
            &root,
            "libNoPc",
            "1.0.0",
            &[],
            r#"
mkdir -p "$WASM_POSIX_DEP_OUT_DIR/include"
touch "$WASM_POSIX_DEP_OUT_DIR/include/nopc.h"
"#,
            r#"[outputs]
headers = ["include/nopc.h"]
"#,
        );

        // libConsumer: depends on libNoPc. Asserts that
        // WASM_POSIX_DEP_PKG_CONFIG_PATH does NOT contain libNoPc's path,
        // even as an empty entry. Empty string is acceptable.
        write_lib(
            &root,
            "libConsumer",
            "1.0.0",
            &["libNoPc@1.0.0"],
            r#"
# Set defaults so set -u doesn't trip.
: "${WASM_POSIX_DEP_PKG_CONFIG_PATH:=}"
case "$WASM_POSIX_DEP_PKG_CONFIG_PATH" in
    *libNoPc*)
        echo "WASM_POSIX_DEP_PKG_CONFIG_PATH must skip libs without pkgconfig dirs:" >&2
        echo "  $WASM_POSIX_DEP_PKG_CONFIG_PATH" >&2
        exit 1
        ;;
esac
mkdir -p "$WASM_POSIX_DEP_OUT_DIR/lib"
touch "$WASM_POSIX_DEP_OUT_DIR/lib/libConsumer.a"
"#,
            r#"[outputs]
libs = ["lib/libConsumer.a"]
"#,
        );

        let reg = Registry { roots: vec![root] };
        let m = reg.load("libConsumer").unwrap();
        ensure_built(&m, &reg, TEST_ARCH, TEST_ABI, &resolve_opts(&cache, None)).unwrap();
    }

    // --- Remote-fetch integration tests (Task A.9) -------------------
    //
    // These exercise the full `[binary]` resolution path with a
    // hand-crafted .tar.zst archive served over a `file://` URL —
    // the same code path as production HTTP fetches, but without a
    // real network or HTTP server. Each test verifies one outcome:
    //
    //   * happy path — archive is sha-, arch-, abi-, cache_key-valid →
    //     resolver installs without invoking the build script;
    //   * sha mismatch / arch mismatch / abi mismatch / cache_key
    //     mismatch — resolver logs and falls through to source build.
    //
    // The build script writes a sentinel `via-build` file. Its presence
    // in the canonical cache means the source build ran; its absence
    // (with the artifacts otherwise installed) means the remote fetch
    // succeeded.

    fn sha256_hex(bytes: &[u8]) -> String {
        let mut h = Sha256::new();
        h.update(bytes);
        let out: [u8; 32] = h.finalize().into();
        hex(&out)
    }

    /// Build the archived `manifest.toml` text for a library named
    /// `name`. `arch` and `abi_versions` and `cache_key_sha` populate
    /// the `[compatibility]` block. Output declaration is `lib/out.a`
    /// to match `write_lib_with_build_toml`.
    fn archived_manifest_text(
        name: &str,
        arch: &str,
        abi_versions: &[u32],
        cache_key_sha: &str,
    ) -> String {
        let abi_csv = abi_versions
            .iter()
            .map(|v| v.to_string())
            .collect::<Vec<_>>()
            .join(", ");
        format!(
            r#"
kind = "library"
name = "{name}"
version = "1.0.0"
revision = 1
depends_on = []

[source]
url = "https://example.test/{name}-1.0.0.tar.gz"
sha256 = "{:0>64}"

[license]
spdx = "TestLicense"

[outputs]
libs = ["lib/out.a"]

[compatibility]
target_arch = "{arch}"
abi_versions = [{abi_csv}]
cache_key_sha = "{cache_key_sha}"
"#,
            ""
        )
    }

    fn archived_program_manifest_text(
        name: &str,
        output_name: &str,
        output_wasm: &str,
        arch: &str,
        abi_versions: &[u32],
        cache_key_sha: &str,
    ) -> String {
        let abi_csv = abi_versions
            .iter()
            .map(|v| v.to_string())
            .collect::<Vec<_>>()
            .join(", ");
        format!(
            r#"
kind = "program"
name = "{name}"
version = "1.0.0"
revision = 1
depends_on = []

[source]
url = "https://example.test/{name}-1.0.0.tar.gz"
sha256 = "{:0>64}"

[license]
spdx = "TestLicense"

[[outputs]]
name = "{output_name}"
wasm = "{output_wasm}"

[compatibility]
target_arch = "{arch}"
abi_versions = [{abi_csv}]
cache_key_sha = "{cache_key_sha}"
"#,
            ""
        )
    }

    fn archived_program_runtime_manifest_text(
        name: &str,
        arch: &str,
        abi_versions: &[u32],
        cache_key_sha: &str,
    ) -> String {
        let abi_csv = abi_versions
            .iter()
            .map(|value| value.to_string())
            .collect::<Vec<_>>()
            .join(", ");
        format!(
            r#"
kind = "program"
name = "{name}"
version = "1.0.0"
revision = 1
depends_on = []

[source]
url = "https://example.test/{name}.tar.gz"
sha256 = "{:0>64}"

[license]
spdx = "MIT"

[[outputs]]
name = "{name}"
wasm = "{name}.wasm"

[[runtime_files]]
artifact = "icu.dat"
guest_path = "/usr/lib/php/icu.dat"

[compatibility]
target_arch = "{arch}"
abi_versions = [{abi_csv}]
cache_key_sha = "{cache_key_sha}"
"#,
            ""
        )
    }

    /// Write a source `package.toml` + sibling `build.toml` for
    /// index-lookup-based resolution tests. The `build.toml`'s
    /// `[binary]` block points at `index_url` (typically a `file://`
    /// URL to a staged `index.toml`). The build script drops a
    /// `via-build` sentinel so fall-through tests can detect that the
    /// source build ran instead of the index fetch.
    fn write_lib_with_build_toml(root: &Path, name: &str, index_url: &str) {
        let lib_dir = root.join(name);
        std::fs::create_dir_all(&lib_dir).unwrap();

        let deps_toml = format!(
            r#"
kind = "library"
name = "{name}"
version = "1.0.0"
depends_on = []

[source]
url = "https://example.test/{name}-1.0.0.tar.gz"
sha256 = "{:0>64}"

[license]
spdx = "TestLicense"

[outputs]
libs = ["lib/out.a"]
"#,
            ""
        );
        std::fs::write(lib_dir.join("package.toml"), deps_toml).unwrap();

        let build_toml = format!(
            r#"
script_path = "packages/registry/{name}/build-{name}.sh"
repo_url    = "https://example.test/repo.git"
commit      = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"

[binary]
index_url = "{index_url}"
"#
        );
        std::fs::write(lib_dir.join("build.toml"), build_toml).unwrap();

        let script = "#!/bin/bash\nset -euo pipefail\n\
mkdir -p \"$WASM_POSIX_DEP_OUT_DIR/lib\"\n\
echo BUILD > \"$WASM_POSIX_DEP_OUT_DIR/lib/out.a\"\n\
touch \"$WASM_POSIX_DEP_OUT_DIR/via-build\"\n";
        let script_path = lib_dir.join(format!("build-{name}.sh"));
        std::fs::write(&script_path, script).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut p = std::fs::metadata(&script_path).unwrap().permissions();
            p.set_mode(0o755);
            std::fs::set_permissions(&script_path, p).unwrap();
        }
    }

    fn write_program_build_toml(root: &Path, name: &str, index_url: &str) {
        let dir = root.join(name);
        let build_toml = format!(
            r#"
script_path = "packages/registry/{name}/build-{name}.sh"
repo_url    = "https://example.test/repo.git"
commit      = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"

[binary]
index_url = "{index_url}"
"#
        );
        std::fs::write(dir.join("build.toml"), build_toml).unwrap();
    }

    fn write_runtime_program_with_index(root: &Path, name: &str, index_url: &str) {
        write_program(
            root,
            name,
            "1.0.0",
            &[],
            &format!(
                r#"mkdir -p "$WASM_POSIX_DEP_OUT_DIR"
printf '\x00asm\x01\x00\x00\x00\x01\x05\x01\x60\x00\x01\x7f\x03\x02\x01\x00\x07\x1a\x02\x0d__abi_version\x00\x00\x06_start\x00\x00\x0a\x06\x01\x04\x00\x41\x00\x0b' > "$WASM_POSIX_DEP_OUT_DIR/{name}.wasm"
printf RUNTIME-BYTES > "$WASM_POSIX_DEP_OUT_DIR/icu.dat"
touch "$WASM_POSIX_DEP_OUT_DIR/via-build""#,
            ),
            &[(name, &format!("{name}.wasm"))],
        );
        append_program_runtime_file(root, name, "icu.dat", "/usr/lib/php/icu.dat");
        let build_toml = format!(
            r#"script_path = "{name}/build-{name}.sh"
repo_url = "https://example.test/repo.git"
commit = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"

[binary]
index_url = "{index_url}"
"#,
        );
        fs::write(root.join(name).join("build.toml"), build_toml).unwrap();
    }

    /// Stage an `index.toml` at `path` declaring `name@1.0.0` with a
    /// single Success entry for `arch` pointing at `archive_url` with
    /// the given `archive_sha256` and `cache_key_sha`. Mirrors what
    /// `xtask index-update` will produce in CI; tests use this to
    /// short-circuit a real publish pipeline.
    fn stage_index_toml(
        path: &Path,
        name: &str,
        arch: TargetArch,
        archive_url: &str,
        archive_sha256: &str,
        cache_key_sha: &str,
    ) {
        let arch_str = arch.as_str();
        let content = format!(
            r#"abi_version = {abi}
generated_at = "2026-05-13T00:00:00Z"
generator = "test"

[[packages]]
name = "{name}"
version = "1.0.0"
revision = 1

[packages.binary.{arch_str}]
status = "success"
archive_url = "{archive_url}"
archive_sha256 = "{archive_sha256}"
cache_key_sha = "{cache_key_sha}"
built_at = "2026-05-13T00:00:00Z"
built_by = "test"
"#,
            abi = TEST_ABI,
        );
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(path, content).unwrap();
    }

    // Resolver tests for the index-lookup binary fetch path. Each
    // test stages a real archive + index.toml on disk (file:// URLs
    // throughout — no network required), writes a source
    // package.toml + sibling build.toml that points at the staged
    // index, and exercises the resolver's path under one specific
    // verification condition.
    //
    // Fall-through tests assert that the source build's `via-build`
    // sentinel appears in the cache (proving the resolver gave up on
    // the index path and ran the build script); the happy-path test
    // asserts the archive's bytes landed AND `via-build` is absent.

    #[test]
    fn direct_pr_overlay_fetch_installs_archive_before_build_toml_index() {
        let root = tempdir("direct-overlay-reg");
        let cache = tempdir("direct-overlay-cache");
        let archive_dir = tempdir("direct-overlay-archive");

        write_lib(
            &root,
            "libOverlay",
            "1.0.0",
            &[],
            r#"
mkdir -p "$WASM_POSIX_DEP_OUT_DIR/lib"
echo BUILD > "$WASM_POSIX_DEP_OUT_DIR/lib/out.a"
touch "$WASM_POSIX_DEP_OUT_DIR/via-build"
"#,
            r#"[outputs]
libs = ["lib/out.a"]
"#,
        );

        let reg_without_overlay = Registry {
            roots: vec![root.clone()],
        };
        let m_without_overlay = reg_without_overlay.load("libOverlay").unwrap();
        let cache_key_hex = hex(&compute_sha(
            &m_without_overlay,
            &reg_without_overlay,
            TEST_ARCH,
            TEST_ABI,
            &mut BTreeMap::new(),
            &mut Vec::new(),
        )
        .unwrap());

        let manifest_text =
            archived_manifest_text("libOverlay", "wasm32", &[TEST_ABI], &cache_key_hex);
        let archive_bytes = crate::remote_fetch::build_test_archive(
            &manifest_text,
            &[("lib/out.a", b"FROM-OVERLAY")],
        );
        let archive_sha_hex = sha256_hex(&archive_bytes);
        let archive_path = archive_dir.join("libOverlay-1.0.0.tar.zst");
        std::fs::write(&archive_path, &archive_bytes).unwrap();
        let archive_url = format!("file://{}", archive_path.display());

        std::fs::write(
            root.join("libOverlay/package.pr.toml"),
            format!(
                r#"
[binary.wasm32]
archive_url = "{archive_url}"
archive_sha256 = "{archive_sha_hex}"
"#
            ),
        )
        .unwrap();

        let reg = Registry { roots: vec![root] };
        let m = reg.load("libOverlay").unwrap();
        let path =
            ensure_built(&m, &reg, TEST_ARCH, TEST_ABI, &resolve_opts(&cache, None)).unwrap();

        assert_eq!(
            std::fs::read(path.join("lib/out.a")).unwrap(),
            b"FROM-OVERLAY"
        );
        assert!(
            !path.join("via-build").exists(),
            "direct package.pr.toml overlay should bypass the source build"
        );
    }

    #[test]
    fn index_fetch_installs_archive_when_sha_arch_abi_cachekey_all_match() {
        let root = tempdir("idx-happy-reg");
        let cache = tempdir("idx-happy-cache");
        let archive_dir = tempdir("idx-happy-archive");
        let index_dir = tempdir("idx-happy-index");

        // Compute the cache_key_sha the resolver will produce for the
        // (fixed-shape) source manifest. cache_key_sha hashes
        // name/version/revision/source/arch/abi/dep-shas. This
        // fixture's build.toml declares no extra cache inputs, so it
        // does not affect compute_sha beyond the revision already
        // loaded onto the manifest.
        let throwaway_root = tempdir("idx-happy-pre");
        write_lib(
            &throwaway_root,
            "libIdx",
            "1.0.0",
            &[],
            "true",
            "[outputs]\nlibs = [\"lib/out.a\"]\n",
        );
        let pre_reg = Registry {
            roots: vec![throwaway_root.clone()],
        };
        let pre_m = pre_reg.load("libIdx").unwrap();
        let pre_sha = compute_sha(
            &pre_m,
            &pre_reg,
            TEST_ARCH,
            TEST_ABI,
            &mut BTreeMap::new(),
            &mut Vec::new(),
        )
        .unwrap();
        let cache_key_hex = hex(&pre_sha);
        let _ = std::fs::remove_dir_all(&throwaway_root);

        // Build a real archive whose internal manifest matches arch
        // + abi + cache_key.
        let manifest_text = archived_manifest_text("libIdx", "wasm32", &[TEST_ABI], &cache_key_hex);
        let archive_bytes = crate::remote_fetch::build_test_archive(
            &manifest_text,
            &[("lib/out.a", b"\x00\x01\x02FAKE")],
        );
        let archive_sha_hex = sha256_hex(&archive_bytes);
        let archive_path = archive_dir.join("libIdx-1.0.0.tar.zst");
        std::fs::write(&archive_path, &archive_bytes).unwrap();
        let archive_url = format!("file://{}", archive_path.display());

        let index_path = index_dir.join("index.toml");
        stage_index_toml(
            &index_path,
            "libIdx",
            TargetArch::Wasm32,
            &archive_url,
            &archive_sha_hex,
            &cache_key_hex,
        );
        let index_url = format!("file://{}", index_path.display());
        write_lib_with_build_toml(&root, "libIdx", &index_url);

        let reg = Registry { roots: vec![root] };
        let m = reg.load("libIdx").unwrap();
        let path =
            ensure_built(&m, &reg, TEST_ARCH, TEST_ABI, &resolve_opts(&cache, None)).unwrap();

        // Artifact installed at the canonical cache path with the
        // archive's bytes.
        assert!(path.starts_with(cache.join("libs")));
        let lib_bytes = std::fs::read(path.join("lib/out.a")).unwrap();
        assert_eq!(lib_bytes, b"\x00\x01\x02FAKE");
        // Build script did NOT run.
        assert!(
            !path.join("via-build").exists(),
            "index fetch should bypass the source build"
        );
        // Manifest + artifacts dir stripped during reshape.
        assert!(!path.join("manifest.toml").exists());
        assert!(!path.join("artifacts").exists());
    }

    #[test]
    fn index_fetch_falls_through_on_index_toml_abi_mismatch() {
        let root = tempdir("idx-index-abi-fail-reg");
        let cache = tempdir("idx-index-abi-fail-cache");
        let archive_dir = tempdir("idx-index-abi-fail-archive");
        let index_dir = tempdir("idx-index-abi-fail-index");

        let index_path = index_dir.join("index.toml");
        let index_url = format!("file://{}", index_path.display());
        write_lib_with_build_toml(&root, "libIdxTopAbi", &index_url);

        let reg = Registry {
            roots: vec![root.clone()],
        };
        let m = reg.load("libIdxTopAbi").unwrap();
        let cache_key_hex = hex(&compute_sha(
            &m,
            &reg,
            TEST_ARCH,
            TEST_ABI,
            &mut BTreeMap::new(),
            &mut Vec::new(),
        )
        .unwrap());

        let manifest_text =
            archived_manifest_text("libIdxTopAbi", "wasm32", &[TEST_ABI], &cache_key_hex);
        let archive_bytes =
            crate::remote_fetch::build_test_archive(&manifest_text, &[("lib/out.a", b"REMOTE")]);
        let archive_sha_hex = sha256_hex(&archive_bytes);
        let archive_path = archive_dir.join("libIdxTopAbi-1.0.0.tar.zst");
        std::fs::write(&archive_path, &archive_bytes).unwrap();
        let archive_url = format!("file://{}", archive_path.display());

        let arch_str = TEST_ARCH.as_str();
        std::fs::write(
            &index_path,
            format!(
                r#"abi_version = {}
generated_at = "2026-05-13T00:00:00Z"
generator = "test"

[[packages]]
name = "libIdxTopAbi"
version = "1.0.0"
revision = 1

[packages.binary.{arch_str}]
status = "success"
archive_url = "{archive_url}"
archive_sha256 = "{archive_sha_hex}"
cache_key_sha = "{cache_key_hex}"
"#,
                TEST_ABI + 1
            ),
        )
        .unwrap();

        let path =
            ensure_built(&m, &reg, TEST_ARCH, TEST_ABI, &resolve_opts(&cache, None)).unwrap();

        assert!(
            path.join("via-build").exists(),
            "top-level index ABI mismatch must fall through to source build"
        );
        let lib = std::fs::read(path.join("lib/out.a")).unwrap();
        assert_ne!(lib, b"REMOTE", "remote bytes must not have been installed");
    }

    #[test]
    fn binaries_dir_program_fetch_does_not_require_built_deps() {
        let root = tempdir("prog-bdir-remote-first-reg");
        let cache = tempdir("prog-bdir-remote-first-cache");
        let bin_dir = tempdir("prog-bdir-remote-first-bin");
        let archive_dir = tempdir("prog-bdir-remote-first-archive");
        let index_dir = tempdir("prog-bdir-remote-first-index");

        write_program(
            &root,
            "baddep",
            "1.0.0",
            &[],
            "echo baddep source build should not run >&2; exit 42",
            &[("baddep", "baddep.wasm")],
        );
        write_program(
            &root,
            "progIdx",
            "1.0.0",
            &["baddep@1.0.0"],
            "echo progIdx source build should not run >&2; exit 43",
            &[("progIdx", "progIdx.wasm")],
        );

        let index_path = index_dir.join("index.toml");
        let index_url = format!("file://{}", index_path.display());
        write_program_build_toml(&root, "progIdx", &index_url);

        let reg = Registry {
            roots: vec![root.clone()],
        };
        let m = reg.load("progIdx").unwrap();
        let cache_key_hex = hex(&compute_sha(
            &m,
            &reg,
            TEST_ARCH,
            TEST_ABI,
            &mut BTreeMap::new(),
            &mut Vec::new(),
        )
        .unwrap());

        let manifest_text = archived_program_manifest_text(
            "progIdx",
            "progIdx",
            "progIdx.wasm",
            "wasm32",
            &[TEST_ABI],
            &cache_key_hex,
        );
        let prog_wasm = minimal_executable_wasm();
        let archive_bytes = crate::remote_fetch::build_test_archive(
            &manifest_text,
            &[("progIdx.wasm", prog_wasm.as_slice())],
        );
        let archive_sha_hex = sha256_hex(&archive_bytes);
        let archive_path = archive_dir.join("progIdx-1.0.0.tar.zst");
        std::fs::write(&archive_path, &archive_bytes).unwrap();
        let archive_url = format!("file://{}", archive_path.display());
        stage_index_toml(
            &index_path,
            "progIdx",
            TargetArch::Wasm32,
            &archive_url,
            &archive_sha_hex,
            &cache_key_hex,
        );

        let opts = ResolveOpts {
            cache_root: &cache,
            local_libs: None,
            force_source_build: None,
            fetch_only: false,
            repo_root: Some(&root),
            binaries_dir: Some(&bin_dir),
        };
        let path = ensure_built(&m, &reg, TEST_ARCH, TEST_ABI, &opts).unwrap();

        assert_eq!(std::fs::read(path.join("progIdx.wasm")).unwrap(), prog_wasm);
        let baddep_cached = std::fs::read_dir(cache.join("programs"))
            .unwrap()
            .filter_map(Result::ok)
            .any(|entry| entry.file_name().to_string_lossy().starts_with("baddep-"));
        assert!(
            !baddep_cached,
            "binary materialization should not have source-built baddep first"
        );
    }

    #[test]
    fn fetched_program_runtime_file_matches_source_mirror_layout() {
        let root = tempdir("runtime-fetch-parity-reg");
        let remote_cache = tempdir("runtime-fetch-parity-remote-cache");
        let source_cache = tempdir("runtime-fetch-parity-source-cache");
        let remote_bin = tempdir("runtime-fetch-parity-remote-bin");
        let source_bin = tempdir("runtime-fetch-parity-source-bin");
        let archive_dir = tempdir("runtime-fetch-parity-archive");
        let index_dir = tempdir("runtime-fetch-parity-index");
        let index_path = index_dir.join("index.toml");
        let index_url = format!("file://{}", index_path.display());
        let name = "runtimeFetched";
        write_runtime_program_with_index(&root, name, &index_url);

        let reg = Registry {
            roots: vec![root.clone()],
        };
        let manifest = reg.load(name).unwrap();
        let cache_key_hex = hex(&compute_sha(
            &manifest,
            &reg,
            TEST_ARCH,
            TEST_ABI,
            &mut BTreeMap::new(),
            &mut Vec::new(),
        )
        .unwrap());
        let archived_manifest = archived_program_runtime_manifest_text(
            name,
            TEST_ARCH.as_str(),
            &[TEST_ABI],
            &cache_key_hex,
        );
        let wasm_name = format!("{name}.wasm");
        let wasm_bytes = b"\x00asm\x01\x00\x00\x00\x01\x05\x01\x60\x00\x01\x7f\x03\x02\x01\x00\x07\x1a\x02\x0d__abi_version\x00\x00\x06_start\x00\x00\x0a\x06\x01\x04\x00\x41\x00\x0b";
        let archive_bytes = crate::remote_fetch::build_test_archive(
            &archived_manifest,
            &[
                (wasm_name.as_str(), wasm_bytes.as_slice()),
                ("icu.dat", b"RUNTIME-BYTES"),
            ],
        );
        let archive_path = archive_dir.join(format!("{name}-1.0.0.tar.zst"));
        fs::write(&archive_path, &archive_bytes).unwrap();
        stage_index_toml(
            &index_path,
            name,
            TEST_ARCH,
            &format!("file://{}", archive_path.display()),
            &sha256_hex(&archive_bytes),
            &cache_key_hex,
        );

        let remote_opts = ResolveOpts {
            cache_root: &remote_cache,
            local_libs: None,
            force_source_build: None,
            fetch_only: false,
            repo_root: Some(&root),
            binaries_dir: Some(&remote_bin),
        };
        let remote_path = ensure_built(&manifest, &reg, TEST_ARCH, TEST_ABI, &remote_opts).unwrap();
        assert!(!remote_path.join("via-build").exists());
        place_binaries_symlinks(&manifest, &remote_path, &remote_bin, TEST_ARCH).unwrap();

        let force = BTreeSet::from([name.to_string()]);
        let source_opts = ResolveOpts {
            cache_root: &source_cache,
            local_libs: None,
            force_source_build: Some(&force),
            fetch_only: false,
            repo_root: Some(&root),
            binaries_dir: Some(&source_bin),
        };
        let source_path = ensure_built(&manifest, &reg, TEST_ARCH, TEST_ABI, &source_opts).unwrap();
        assert!(source_path.join("via-build").exists());
        place_binaries_symlinks(&manifest, &source_path, &source_bin, TEST_ARCH).unwrap();

        let mirror_rel = Path::new("programs/wasm32").join(name).join("icu.dat");
        assert_eq!(
            fs::read(remote_bin.join(&mirror_rel)).unwrap(),
            b"RUNTIME-BYTES"
        );
        assert_eq!(
            fs::read(source_bin.join(&mirror_rel)).unwrap(),
            b"RUNTIME-BYTES"
        );
    }

    #[test]
    fn incomplete_fetched_runtime_file_falls_back_or_fails_fetch_only() {
        let root = tempdir("runtime-fetch-incomplete-reg");
        let fallback_cache = tempdir("runtime-fetch-incomplete-fallback-cache");
        let fetch_only_cache = tempdir("runtime-fetch-incomplete-only-cache");
        let archive_dir = tempdir("runtime-fetch-incomplete-archive");
        let index_dir = tempdir("runtime-fetch-incomplete-index");
        let index_path = index_dir.join("index.toml");
        let index_url = format!("file://{}", index_path.display());
        let name = "runtimeIncomplete";
        write_runtime_program_with_index(&root, name, &index_url);

        let reg = Registry {
            roots: vec![root.clone()],
        };
        let manifest = reg.load(name).unwrap();
        let cache_key_hex = hex(&compute_sha(
            &manifest,
            &reg,
            TEST_ARCH,
            TEST_ABI,
            &mut BTreeMap::new(),
            &mut Vec::new(),
        )
        .unwrap());
        let archived_manifest = archived_program_runtime_manifest_text(
            name,
            TEST_ARCH.as_str(),
            &[TEST_ABI],
            &cache_key_hex,
        );
        let wasm_name = format!("{name}.wasm");
        let wasm_bytes = b"\x00asm\x01\x00\x00\x00\x01\x05\x01\x60\x00\x01\x7f\x03\x02\x01\x00\x07\x1a\x02\x0d__abi_version\x00\x00\x06_start\x00\x00\x0a\x06\x01\x04\x00\x41\x00\x0b";
        let archive_bytes = crate::remote_fetch::build_test_archive(
            &archived_manifest,
            &[(wasm_name.as_str(), wasm_bytes.as_slice())],
        );
        let archive_path = archive_dir.join(format!("{name}-1.0.0.tar.zst"));
        fs::write(&archive_path, &archive_bytes).unwrap();
        stage_index_toml(
            &index_path,
            name,
            TEST_ARCH,
            &format!("file://{}", archive_path.display()),
            &sha256_hex(&archive_bytes),
            &cache_key_hex,
        );

        let fallback = ensure_built(
            &manifest,
            &reg,
            TEST_ARCH,
            TEST_ABI,
            &resolve_opts(&fallback_cache, None),
        )
        .unwrap();
        assert!(fallback.join("via-build").exists());
        assert_eq!(
            fs::read(fallback.join("icu.dat")).unwrap(),
            b"RUNTIME-BYTES"
        );

        let fetch_only_opts = ResolveOpts {
            cache_root: &fetch_only_cache,
            local_libs: None,
            force_source_build: None,
            fetch_only: true,
            repo_root: Some(&root),
            binaries_dir: None,
        };
        let err = ensure_built(&manifest, &reg, TEST_ARCH, TEST_ABI, &fetch_only_opts).unwrap_err();
        assert!(err.contains("fetch-only"), "got: {err}");
        assert!(
            !canonical_path(
                &fetch_only_cache,
                &manifest,
                TEST_ARCH,
                &compute_sha(
                    &manifest,
                    &reg,
                    TEST_ARCH,
                    TEST_ABI,
                    &mut BTreeMap::new(),
                    &mut Vec::new(),
                )
                .unwrap(),
            )
            .join("via-build")
            .exists()
        );
    }

    #[test]
    fn index_fetch_falls_through_on_archive_sha_mismatch() {
        let root = tempdir("idx-shafail-reg");
        let cache = tempdir("idx-shafail-cache");
        let archive_dir = tempdir("idx-shafail-archive");
        let index_dir = tempdir("idx-shafail-index");

        // Build a real archive but advertise the WRONG sha in the index.
        let manifest_text = archived_manifest_text(
            "libIdxSha",
            "wasm32",
            &[TEST_ABI],
            // cache_key_sha is irrelevant: we never get past the sha
            // check. Fill with a valid-shaped dummy so parse_archived
            // wouldn't complain (defence in depth).
            &"a".repeat(64),
        );
        let archive_bytes =
            crate::remote_fetch::build_test_archive(&manifest_text, &[("lib/out.a", b"REMOTE")]);
        let archive_path = archive_dir.join("libIdxSha-1.0.0.tar.zst");
        std::fs::write(&archive_path, &archive_bytes).unwrap();
        let archive_url = format!("file://{}", archive_path.display());

        let bogus_sha = "0".repeat(64);
        let index_path = index_dir.join("index.toml");
        stage_index_toml(
            &index_path,
            "libIdxSha",
            TargetArch::Wasm32,
            &archive_url,
            &bogus_sha,
            &"a".repeat(64),
        );
        let index_url = format!("file://{}", index_path.display());
        write_lib_with_build_toml(&root, "libIdxSha", &index_url);

        let reg = Registry { roots: vec![root] };
        let m = reg.load("libIdxSha").unwrap();
        let path =
            ensure_built(&m, &reg, TEST_ARCH, TEST_ABI, &resolve_opts(&cache, None)).unwrap();

        // Source build ran.
        assert!(
            path.join("via-build").exists(),
            "sha mismatch must fall through to source build"
        );
        let lib = std::fs::read(path.join("lib/out.a")).unwrap();
        assert_ne!(lib, b"REMOTE", "remote bytes must not have been installed");
    }

    #[test]
    fn index_fetch_falls_through_on_target_arch_mismatch() {
        let root = tempdir("idx-archfail-reg");
        let cache = tempdir("idx-archfail-cache");
        let archive_dir = tempdir("idx-archfail-archive");
        let index_dir = tempdir("idx-archfail-index");

        // Archive's internal compatibility block declares wasm64 —
        // resolver requests wasm32 (TEST_ARCH). The index entry
        // points the wasm32 slot at this archive (an
        // archive-staging bug a real CI would never produce, but
        // the resolver must defend against it).
        let manifest_text =
            archived_manifest_text("libIdxArch", "wasm64", &[TEST_ABI], &"a".repeat(64));
        let archive_bytes =
            crate::remote_fetch::build_test_archive(&manifest_text, &[("lib/out.a", b"REMOTE")]);
        let archive_sha = sha256_hex(&archive_bytes);
        let archive_path = archive_dir.join("libIdxArch-1.0.0.tar.zst");
        std::fs::write(&archive_path, &archive_bytes).unwrap();
        let archive_url = format!("file://{}", archive_path.display());

        let index_path = index_dir.join("index.toml");
        stage_index_toml(
            &index_path,
            "libIdxArch",
            TargetArch::Wasm32,
            &archive_url,
            &archive_sha,
            &"a".repeat(64),
        );
        let index_url = format!("file://{}", index_path.display());
        write_lib_with_build_toml(&root, "libIdxArch", &index_url);

        let reg = Registry { roots: vec![root] };
        let m = reg.load("libIdxArch").unwrap();
        let path = ensure_built(
            &m,
            &reg,
            TEST_ARCH, // wasm32
            TEST_ABI,
            &resolve_opts(&cache, None),
        )
        .unwrap();

        assert!(
            path.join("via-build").exists(),
            "arch mismatch must fall through to source build"
        );
    }

    #[test]
    fn index_fetch_falls_through_on_abi_mismatch() {
        let root = tempdir("idx-abifail-reg");
        let cache = tempdir("idx-abifail-cache");
        let archive_dir = tempdir("idx-abifail-archive");
        let index_dir = tempdir("idx-abifail-index");

        // Archive supports only ABI 999 — resolver passes TEST_ABI.
        let manifest_text = archived_manifest_text("libIdxAbi", "wasm32", &[999], &"a".repeat(64));
        let archive_bytes =
            crate::remote_fetch::build_test_archive(&manifest_text, &[("lib/out.a", b"REMOTE")]);
        let archive_sha = sha256_hex(&archive_bytes);
        let archive_path = archive_dir.join("libIdxAbi-1.0.0.tar.zst");
        std::fs::write(&archive_path, &archive_bytes).unwrap();
        let archive_url = format!("file://{}", archive_path.display());

        let index_path = index_dir.join("index.toml");
        stage_index_toml(
            &index_path,
            "libIdxAbi",
            TargetArch::Wasm32,
            &archive_url,
            &archive_sha,
            &"a".repeat(64),
        );
        let index_url = format!("file://{}", index_path.display());
        write_lib_with_build_toml(&root, "libIdxAbi", &index_url);

        let reg = Registry { roots: vec![root] };
        let m = reg.load("libIdxAbi").unwrap();
        let path = ensure_built(
            &m,
            &reg,
            TEST_ARCH,
            TEST_ABI, // not in [999]
            &resolve_opts(&cache, None),
        )
        .unwrap();

        assert!(
            path.join("via-build").exists(),
            "abi mismatch must fall through to source build"
        );
    }

    #[test]
    fn index_fetch_falls_through_on_cache_key_mismatch() {
        let root = tempdir("idx-ckfail-reg");
        let cache = tempdir("idx-ckfail-cache");
        let archive_dir = tempdir("idx-ckfail-archive");
        let index_dir = tempdir("idx-ckfail-index");

        // Archive's internal compat.cache_key_sha is well-formed but
        // doesn't match what compute_sha would produce for this lib.
        let wrong_ck = "f".repeat(64);
        let manifest_text = archived_manifest_text("libIdxCk", "wasm32", &[TEST_ABI], &wrong_ck);
        let archive_bytes =
            crate::remote_fetch::build_test_archive(&manifest_text, &[("lib/out.a", b"REMOTE")]);
        let archive_sha = sha256_hex(&archive_bytes);
        let archive_path = archive_dir.join("libIdxCk-1.0.0.tar.zst");
        std::fs::write(&archive_path, &archive_bytes).unwrap();
        let archive_url = format!("file://{}", archive_path.display());

        let index_path = index_dir.join("index.toml");
        stage_index_toml(
            &index_path,
            "libIdxCk",
            TargetArch::Wasm32,
            &archive_url,
            &archive_sha,
            &wrong_ck,
        );
        let index_url = format!("file://{}", index_path.display());
        write_lib_with_build_toml(&root, "libIdxCk", &index_url);

        let reg = Registry { roots: vec![root] };
        let m = reg.load("libIdxCk").unwrap();
        let path =
            ensure_built(&m, &reg, TEST_ARCH, TEST_ABI, &resolve_opts(&cache, None)).unwrap();

        assert!(
            path.join("via-build").exists(),
            "cache_key_sha mismatch must fall through to source build"
        );
    }

    #[test]
    fn fetch_only_rejects_missing_index_entry_without_source_build() {
        let root = tempdir("fetch-only-missing-reg");
        let cache = tempdir("fetch-only-missing-cache");
        let index_dir = tempdir("fetch-only-missing-index");

        let index_path = index_dir.join("index.toml");
        std::fs::write(
            &index_path,
            format!(
                r#"abi_version = {TEST_ABI}
generated_at = "2026-06-09T00:00:00Z"
generator = "test"
"#
            ),
        )
        .unwrap();
        let index_url = format!("file://{}", index_path.display());
        write_lib_with_build_toml(&root, "libFetchOnly", &index_url);

        let reg = Registry {
            roots: vec![root.clone()],
        };
        let m = reg.load("libFetchOnly").unwrap();
        let sha = compute_sha(
            &m,
            &reg,
            TEST_ARCH,
            TEST_ABI,
            &mut BTreeMap::new(),
            &mut Vec::new(),
        )
        .unwrap();
        let canonical = canonical_path(&cache, &m, TEST_ARCH, &sha);
        let opts = ResolveOpts {
            cache_root: &cache,
            local_libs: None,
            force_source_build: None,
            fetch_only: true,
            repo_root: Some(&root),
            binaries_dir: None,
        };

        let err = ensure_built(&m, &reg, TEST_ARCH, TEST_ABI, &opts).unwrap_err();
        assert!(err.contains("fetch-only resolve"), "got: {err}");
        assert!(
            !canonical.join("via-build").exists(),
            "fetch-only must not run the source build script"
        );
    }

    // --- kind = "program" resolver tests (Task B.2) ---

    /// Create a `kind = "program"` package.toml + build-<name>.sh pair.
    /// Mirrors `write_lib` but emits `[[outputs]]` array-of-tables.
    fn write_program(
        root: &Path,
        name: &str,
        version: &str,
        deps: &[&str],
        build_script_body: &str,
        outputs: &[(&str, &str)],
    ) {
        let dir = root.join(name);
        fs::create_dir_all(&dir).unwrap();
        let depends_on = deps
            .iter()
            .map(|d| format!("\"{}\"", d))
            .collect::<Vec<_>>()
            .join(", ");
        let mut outputs_toml = String::new();
        for (n, w) in outputs {
            outputs_toml.push_str(&format!("[[outputs]]\nname = \"{n}\"\nwasm = \"{w}\"\n\n"));
        }
        fs::write(
            dir.join("package.toml"),
            format!(
                r#"kind = "program"
name = "{name}"
version = "{version}"
depends_on = [{depends_on}]
[source]
url = "https://example.test/{name}.tar.gz"
sha256 = "0000000000000000000000000000000000000000000000000000000000000000"
[license]
spdx = "MIT"
{outputs_toml}"#,
            ),
        )
        .unwrap();
        let script_path = dir.join(format!("build-{name}.sh"));
        fs::write(
            &script_path,
            format!("#!/bin/bash\nset -e\n{build_script_body}\n"),
        )
        .unwrap();

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut p = std::fs::metadata(&script_path).unwrap().permissions();
            p.set_mode(0o755);
            std::fs::set_permissions(&script_path, p).unwrap();
        }
    }

    fn append_program_runtime_file(root: &Path, name: &str, artifact: &str, guest_path: &str) {
        let manifest_path = root.join(name).join("package.toml");
        let mut text = fs::read_to_string(&manifest_path).unwrap();
        text.push_str(&format!(
            "\n[[runtime_files]]\nartifact = {artifact:?}\nguest_path = {guest_path:?}\n"
        ));
        fs::write(manifest_path, text).unwrap();
    }

    #[test]
    fn canonical_path_uses_programs_subdir_for_program_kind() {
        let m = DepsManifest::parse(
            r#"kind = "program"
name = "vim"
version = "9.1.0900"
[source]
url = "https://x.test/vim.tar.gz"
sha256 = "0000000000000000000000000000000000000000000000000000000000000000"
[license]
spdx = "Vim"
[[outputs]]
name = "vim"
wasm = "vim.wasm"
"#,
            PathBuf::from("/x"),
        )
        .unwrap();
        let sha = [0u8; 32];
        let p = canonical_path(Path::new("/cache"), &m, TargetArch::Wasm32, &sha);
        let s = p.to_string_lossy();
        assert!(s.contains("/programs/"), "got: {s}");
        assert!(s.contains("vim-9.1.0900-rev1-wasm32-"), "got: {s}");
    }

    #[test]
    fn build_validates_program_wasm_outputs_present() {
        let root = tempdir("prog-out-pass");
        let cache = tempdir("prog-out-pass-cache");
        write_program(
            &root,
            "tinyprog",
            "0.1.0",
            &[],
            // Build script writes the declared wasm.
            r#"mkdir -p "$WASM_POSIX_DEP_OUT_DIR" && printf '\x00asm\x01\x00\x00\x00\x01\x05\x01\x60\x00\x01\x7f\x03\x02\x01\x00\x07\x1a\x02\x0d__abi_version\x00\x00\x06_start\x00\x00\x0a\x06\x01\x04\x00\x41\x00\x0b' > "$WASM_POSIX_DEP_OUT_DIR/tinyprog.wasm""#,
            &[("tinyprog", "tinyprog.wasm")],
        );
        let reg = Registry { roots: vec![root] };
        let m = reg.load("tinyprog").unwrap();
        ensure_built(&m, &reg, TargetArch::Wasm32, 4, &resolve_opts(&cache, None)).unwrap();
    }

    #[test]
    fn build_fails_when_program_wasm_output_missing() {
        let root = tempdir("prog-out-miss");
        let cache = tempdir("prog-out-miss-cache");
        write_program(
            &root,
            "miss",
            "0.1.0",
            &[],
            // Build script does NOT produce miss.wasm.
            r#"mkdir -p "$WASM_POSIX_DEP_OUT_DIR""#,
            &[("miss", "miss.wasm")],
        );
        let reg = Registry { roots: vec![root] };
        let m = reg.load("miss").unwrap();
        let err =
            ensure_built(&m, &reg, TargetArch::Wasm32, 4, &resolve_opts(&cache, None)).unwrap_err();
        assert!(err.contains("miss.wasm"), "got: {err}");
    }

    #[test]
    fn program_runtime_file_is_required_and_cached_as_a_regular_file() {
        let root = tempdir("prog-runtime-file");
        let cache = tempdir("prog-runtime-file-cache");
        write_program(
            &root,
            "runtimeprog",
            "0.1.0",
            &[],
            r#"mkdir -p "$WASM_POSIX_DEP_OUT_DIR"
printf '\x00asm\x01\x00\x00\x00\x01\x05\x01\x60\x00\x01\x7f\x03\x02\x01\x00\x07\x1a\x02\x0d__abi_version\x00\x00\x06_start\x00\x00\x0a\x06\x01\x04\x00\x41\x00\x0b' > "$WASM_POSIX_DEP_OUT_DIR/runtimeprog.wasm"
printf runtime-data > "$WASM_POSIX_DEP_OUT_DIR/icu.dat""#,
            &[("runtimeprog", "runtimeprog.wasm")],
        );
        append_program_runtime_file(&root, "runtimeprog", "icu.dat", "/usr/lib/php/icu.dat");
        let reg = Registry { roots: vec![root] };
        let m = reg.load("runtimeprog").unwrap();
        assert_eq!(
            runtime_file_metadata_value(&m, "icu.dat").unwrap(),
            serde_json::json!({
                "artifact": "icu.dat",
                "guest_path": "/usr/lib/php/icu.dat",
                "mode": 420,
                "mirror_path": "runtimeprog/icu.dat",
                "closure_mirror_paths": [
                    "runtimeprog.wasm",
                    "runtimeprog/icu.dat",
                ],
            })
        );
        let path =
            ensure_built(&m, &reg, TargetArch::Wasm32, 4, &resolve_opts(&cache, None)).unwrap();
        assert_eq!(fs::read(path.join("icu.dat")).unwrap(), b"runtime-data");

        fs::remove_file(path.join("icu.dat")).unwrap();
        let err = validate_cache_artifacts(&m, &path).unwrap_err();
        assert!(
            err.contains("runtime file") && err.contains("missing"),
            "got: {err}"
        );
    }

    #[test]
    fn runtime_file_metadata_lists_the_complete_multi_output_closure() {
        let manifest = DepsManifest::parse(
            r#"kind = "program"
name = "runtimeprog"
version = "1.0"
depends_on = []
[source]
url = "https://example.test/runtimeprog.tar.gz"
sha256 = "0000000000000000000000000000000000000000000000000000000000000000"
[license]
spdx = "MIT"
[[outputs]]
name = "runtimeprog"
wasm = "bin/runtimeprog.wasm"
[[outputs]]
name = "module"
wasm = "extensions/module.so"
[[runtime_files]]
artifact = "share/icu.dat"
guest_path = "/usr/lib/runtimeprog/icu.dat"
[[runtime_files]]
artifact = "share/timezone.dat"
guest_path = "/usr/lib/runtimeprog/timezone.dat"
"#,
            PathBuf::from("/x"),
        )
        .unwrap();

        let metadata = runtime_file_metadata_value(&manifest, "share/icu.dat").unwrap();
        assert_eq!(
            metadata["closure_mirror_paths"],
            serde_json::json!([
                "runtimeprog/runtimeprog.wasm",
                "runtimeprog/module.so",
                "runtimeprog/share/icu.dat",
                "runtimeprog/share/timezone.dat",
            ])
        );
    }

    #[test]
    fn build_fails_when_program_runtime_file_is_missing() {
        let root = tempdir("prog-runtime-file-missing");
        let cache = tempdir("prog-runtime-file-missing-cache");
        write_program(
            &root,
            "runtimemissing",
            "0.1.0",
            &[],
            r#"mkdir -p "$WASM_POSIX_DEP_OUT_DIR"
printf '\x00asm\x01\x00\x00\x00\x01\x05\x01\x60\x00\x01\x7f\x03\x02\x01\x00\x07\x1a\x02\x0d__abi_version\x00\x00\x06_start\x00\x00\x0a\x06\x01\x04\x00\x41\x00\x0b' > "$WASM_POSIX_DEP_OUT_DIR/runtimemissing.wasm""#,
            &[("runtimemissing", "runtimemissing.wasm")],
        );
        append_program_runtime_file(&root, "runtimemissing", "icu.dat", "/usr/lib/php/icu.dat");
        let reg = Registry { roots: vec![root] };
        let m = reg.load("runtimemissing").unwrap();
        let err =
            ensure_built(&m, &reg, TargetArch::Wasm32, 4, &resolve_opts(&cache, None)).unwrap_err();
        assert!(
            err.contains("runtime file") && err.contains("icu.dat"),
            "got: {err}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn build_rejects_program_runtime_file_symlink() {
        let root = tempdir("prog-runtime-file-symlink");
        let cache = tempdir("prog-runtime-file-symlink-cache");
        let outside = root.join("outside.dat");
        fs::write(&outside, b"outside").unwrap();
        write_program(
            &root,
            "runtimesymlink",
            "0.1.0",
            &[],
            &format!(
                r#"mkdir -p "$WASM_POSIX_DEP_OUT_DIR"
printf '\x00asm\x01\x00\x00\x00\x01\x05\x01\x60\x00\x01\x7f\x03\x02\x01\x00\x07\x1a\x02\x0d__abi_version\x00\x00\x06_start\x00\x00\x0a\x06\x01\x04\x00\x41\x00\x0b' > "$WASM_POSIX_DEP_OUT_DIR/runtimesymlink.wasm"
ln -s {:?} "$WASM_POSIX_DEP_OUT_DIR/icu.dat""#,
                outside
            ),
            &[("runtimesymlink", "runtimesymlink.wasm")],
        );
        append_program_runtime_file(&root, "runtimesymlink", "icu.dat", "/usr/lib/php/icu.dat");
        let reg = Registry { roots: vec![root] };
        let m = reg.load("runtimesymlink").unwrap();
        let err =
            ensure_built(&m, &reg, TargetArch::Wasm32, 4, &resolve_opts(&cache, None)).unwrap_err();
        assert!(err.contains("must not be a symlink"), "got: {err}");
    }

    #[test]
    fn program_output_validation_rejects_legacy_asyncify_wasm() {
        let out = tempdir("prog-out-asyncify");
        fs::write(
            out.join("bad.wasm"),
            b"\0asm\x01\0\0\0 exported asyncify_start_unwind",
        )
        .unwrap();
        let m = DepsManifest::parse(
            r#"kind = "program"
name = "bad"
version = "0.1.0"
[source]
url = "https://x.test/bad.tar.gz"
sha256 = "0000000000000000000000000000000000000000000000000000000000000000"
[license]
spdx = "Test"
[[outputs]]
name = "bad"
wasm = "bad.wasm"
"#,
            PathBuf::from("/x"),
        )
        .unwrap();
        let err = validate_outputs(&m, &out).unwrap_err();
        assert!(err.contains("asyncify_"), "got: {err}");
    }

    #[test]
    fn program_output_validation_rejects_executable_without_entrypoint_exports() {
        let out = tempdir("prog-out-entrypoint-policy");
        fs::write(out.join("bad.wasm"), b"\0asm\x01\0\0\0").unwrap();
        let m = DepsManifest::parse(
            r#"kind = "program"
name = "badentry"
version = "0.1.0"
[source]
url = "https://x.test/badentry.tar.gz"
sha256 = "0000000000000000000000000000000000000000000000000000000000000000"
[license]
spdx = "Test"
[[outputs]]
name = "badentry"
wasm = "bad.wasm"
"#,
            PathBuf::from("/x"),
        )
        .unwrap();
        let err = validate_outputs(&m, &out).unwrap_err();
        assert!(err.contains("missing required exports"), "got: {err}");
        assert!(err.contains("__abi_version"), "got: {err}");
        assert!(err.contains("_start"), "got: {err}");
    }

    #[test]
    fn wasm_artifact_policy_rejects_empty_and_exportless_executables() {
        let required = &EXECUTABLE_PROGRAM_REQUIRED_EXPORTS;

        assert_eq!(
            wasm_artifact_policy_failures_for(&[], ForkInstrumentationPolicy::Auto, required),
            ["is not a wasm binary"]
        );

        let failures = wasm_artifact_policy_failures_for(
            b"\0asm\x01\0\0\0",
            ForkInstrumentationPolicy::Auto,
            required,
        );
        assert_eq!(failures.len(), 1, "got: {failures:?}");
        assert!(
            failures[0].contains("missing required exports")
                && failures[0].contains("__abi_version")
                && failures[0].contains("_start"),
            "got: {failures:?}"
        );

        assert!(
            wasm_artifact_policy_failures_for(
                &minimal_executable_wasm(),
                ForkInstrumentationPolicy::Auto,
                required,
            )
            .is_empty()
        );
    }

    #[test]
    fn program_output_validation_rejects_fork_without_wpk_exports() {
        let out = tempdir("prog-out-fork-policy");
        fs::write(out.join("bad.wasm"), wasm_importing_kernel_fork(&[])).unwrap();
        let m = DepsManifest::parse(
            r#"kind = "program"
name = "badfork"
version = "0.1.0"
[source]
url = "https://x.test/badfork.tar.gz"
sha256 = "0000000000000000000000000000000000000000000000000000000000000000"
[license]
spdx = "Test"
[[outputs]]
name = "badfork"
wasm = "bad.wasm"
"#,
            PathBuf::from("/x"),
        )
        .unwrap();
        let err = validate_outputs(&m, &out).unwrap_err();
        assert!(err.contains("kernel_fork"), "got: {err}");
        assert!(err.contains("wasm-fork-instrument"), "got: {err}");
    }

    #[test]
    fn program_output_validation_rejects_kernel_missing_host_adapter_exports() {
        let out = tempdir("prog-out-kernel-export-policy");
        fs::write(out.join("kernel.wasm"), wasm_exporting_kernel_fork()).unwrap();
        let m = DepsManifest::parse(
            r#"kind = "program"
name = "kernel"
version = "0.1.0"
[source]
url = "https://x.test/kernel.tar.gz"
sha256 = "0000000000000000000000000000000000000000000000000000000000000000"
[license]
spdx = "Test"
[[outputs]]
name = "kernel"
wasm = "kernel.wasm"
"#,
            PathBuf::from("/x"),
        )
        .unwrap();
        let err = validate_outputs(&m, &out).unwrap_err();
        assert!(err.contains("missing required exports"), "got: {err}");
        assert!(
            err.contains("kernel_host_adapter_manifest_ptr"),
            "got: {err}"
        );
    }

    #[test]
    fn program_output_validation_accepts_kernel_host_adapter_exports() {
        let out = tempdir("prog-out-kernel-host-adapter-export-policy");
        fs::write(
            out.join("kernel.wasm"),
            wasm_exporting_names(wasm_posix_shared::abi::HOST_ADAPTER_REQUIRED_KERNEL_EXPORTS),
        )
        .unwrap();
        let m = DepsManifest::parse(
            r#"kind = "program"
name = "kernel"
version = "0.1.0"
[source]
url = "https://x.test/kernel.tar.gz"
sha256 = "0000000000000000000000000000000000000000000000000000000000000000"
[license]
spdx = "Test"
[[outputs]]
name = "kernel"
wasm = "kernel.wasm"
"#,
            PathBuf::from("/x"),
        )
        .unwrap();
        validate_outputs(&m, &out).unwrap();
    }

    #[test]
    fn program_output_validation_accepts_disabled_fork_instrumentation_policy() {
        let out = tempdir("prog-out-fork-disabled");
        fs::write(
            out.join("js.wasm"),
            wasm_importing_kernel_fork_exporting_names(&EXECUTABLE_PROGRAM_REQUIRED_EXPORTS),
        )
        .unwrap();
        let m = DepsManifest::parse(
            r#"kind = "program"
name = "spidermonkey"
version = "0.1.0"
[source]
url = "https://x.test/spidermonkey.tar.gz"
sha256 = "0000000000000000000000000000000000000000000000000000000000000000"
[license]
spdx = "Test"
[[outputs]]
name = "js"
wasm = "js.wasm"
fork_instrumentation = "disabled"
"#,
            PathBuf::from("/x"),
        )
        .unwrap();
        validate_outputs(&m, &out).unwrap();
    }

    #[test]
    fn program_output_validation_rejects_wpk_exports_when_policy_disabled() {
        let out = tempdir("prog-out-fork-disabled-wpk");
        fs::write(
            out.join("js.wasm"),
            wasm_importing_kernel_fork_with_wpk_exports(),
        )
        .unwrap();
        let m = DepsManifest::parse(
            r#"kind = "program"
name = "spidermonkey"
version = "0.1.0"
[source]
url = "https://x.test/spidermonkey.tar.gz"
sha256 = "0000000000000000000000000000000000000000000000000000000000000000"
[license]
spdx = "Test"
[[outputs]]
name = "js"
wasm = "js.wasm"
fork_instrumentation = "disabled"
"#,
            PathBuf::from("/x"),
        )
        .unwrap();
        let err = validate_outputs(&m, &out).unwrap_err();
        assert!(err.contains("disables fork instrumentation"), "got: {err}");
    }

    #[test]
    fn program_output_validation_accepts_relocatable_fork_objects() {
        let bytes = wasm_importing_kernel_fork(&["linking", "reloc.CODE"]);
        let failures = wasm_artifact_policy_failures(&bytes, ForkInstrumentationPolicy::Auto);
        assert!(failures.is_empty(), "got: {failures:?}");
    }

    #[test]
    fn walk_all_finds_libraries_and_programs() {
        let root = tempdir("walk-all");
        write_lib(
            &root,
            "libL",
            "1.0.0",
            &[],
            "true",
            "[outputs]\nlibs = [\"lib/libL.a\"]\n",
        );
        write_program(
            &root,
            "progP",
            "0.1.0",
            &[],
            "true",
            &[("progP", "progP.wasm")],
        );
        let reg = Registry { roots: vec![root] };
        let all = reg.walk_all().unwrap();
        let names: Vec<_> = all.iter().map(|(n, _)| n.clone()).collect();
        assert_eq!(names, vec!["libL".to_string(), "progP".to_string()]);
    }

    #[test]
    fn programs_by_name_filters_to_program_kind() {
        let root = tempdir("progs-by-name");
        write_lib(
            &root,
            "libL",
            "1.0.0",
            &[],
            "true",
            "[outputs]\nlibs = [\"lib/libL.a\"]\n",
        );
        write_program(
            &root,
            "progP",
            "0.1.0",
            &[],
            "true",
            &[("progP", "progP.wasm")],
        );
        let reg = Registry { roots: vec![root] };
        let progs = programs_by_name(&reg).unwrap();
        assert_eq!(progs.len(), 1);
        assert!(progs.contains_key("progP"));
    }

    #[test]
    fn walk_all_handles_missing_registry_root() {
        // A registry root that doesn't exist must not error; just contribute nothing.
        let reg = Registry {
            roots: vec![PathBuf::from("/this/path/does/not/exist/xtask-walk-all")],
        };
        let all = reg.walk_all().unwrap();
        assert!(all.is_empty());
    }

    #[test]
    fn walk_all_first_root_wins_for_duplicate_names() {
        // Two roots both define "libZ"; first one wins.
        let root_a = tempdir("walk-first");
        let root_b = tempdir("walk-second");
        write_lib(
            &root_a,
            "libZ",
            "1.0.0",
            &[],
            "true",
            "[outputs]\nlibs = [\"lib/libZ.a\"]\n",
        );
        write_lib(
            &root_b,
            "libZ",
            "9.9.9",
            &[],
            "true",
            "[outputs]\nlibs = [\"lib/libZ.a\"]\n",
        );
        let reg = Registry {
            roots: vec![root_a, root_b],
        };
        let all = reg.walk_all().unwrap();
        let (_, m) = all.iter().find(|(n, _)| n == "libZ").unwrap();
        assert_eq!(
            m.version, "1.0.0",
            "first root should win, got version {}",
            m.version
        );
    }

    #[test]
    fn source_kind_sha_omits_arch_and_abi_inputs() {
        let dir = tempdir("c3a");
        let m = parse_source_manifest(&dir);

        let registry = Registry { roots: vec![] };
        let sha32_v1 = compute_sha(
            &m,
            &registry,
            TargetArch::Wasm32,
            4,
            &mut Default::default(),
            &mut Default::default(),
        )
        .unwrap();
        let sha64_v1 = compute_sha(
            &m,
            &registry,
            TargetArch::Wasm64,
            4,
            &mut Default::default(),
            &mut Default::default(),
        )
        .unwrap();
        let sha32_v9 = compute_sha(
            &m,
            &registry,
            TargetArch::Wasm32,
            9,
            &mut Default::default(),
            &mut Default::default(),
        )
        .unwrap();
        assert_eq!(sha32_v1, sha64_v1, "arch must not affect source sha");
        assert_eq!(sha32_v1, sha32_v9, "abi must not affect source sha");
    }

    #[test]
    fn source_kind_sha_uses_distinct_domain() {
        let dir = tempdir("c3b");
        let m_src = parse_source_manifest(&dir);

        // Library manifest with same name/version + same source URL+sha:
        // confirms the domain separator is the only differentiator.
        let lib_text = r#"
kind = "library"
name = "pcre2-source"
version = "10.42"

[source]
url = "https://example.test/pcre2.tar.bz2"
sha256 = "0000000000000000000000000000000000000000000000000000000000000000"

[license]
spdx = "BSD-3-Clause"

[outputs]
libs = []
"#;
        let m_lib = DepsManifest::parse(lib_text, dir.clone()).unwrap();

        let registry = Registry { roots: vec![] };
        let s_src = compute_sha(
            &m_src,
            &registry,
            TargetArch::Wasm32,
            4,
            &mut Default::default(),
            &mut Default::default(),
        )
        .unwrap();
        let s_lib = compute_sha(
            &m_lib,
            &registry,
            TargetArch::Wasm32,
            4,
            &mut Default::default(),
            &mut Default::default(),
        )
        .unwrap();
        assert_ne!(s_src, s_lib, "source vs library shas must differ on domain");
    }

    /// End-to-end integration: a `kind = "source"` manifest that
    /// declares no `[build].script_path` resolves by fetching its archive
    /// (file:// URL here), verifying the sha256, extracting +
    /// flattening, and atomically renaming into the canonical cache
    /// path. A second resolve hits the cache.
    #[test]
    fn ensure_built_source_kind_fetches_and_extracts_via_file_url() {
        use std::io::Write;
        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path().join("cache");
        std::fs::create_dir_all(&cache).unwrap();

        // Build a fixture tarball containing pcre2-10.42/README.
        let mut tar_bytes: Vec<u8> = Vec::new();
        {
            let enc = flate2::write::GzEncoder::new(&mut tar_bytes, flate2::Compression::default());
            let mut builder = tar::Builder::new(enc);
            let mut header = tar::Header::new_gnu();
            header.set_path("pcre2-10.42/README").unwrap();
            header.set_size(6);
            header.set_mode(0o644);
            header.set_cksum();
            builder.append(&header, &b"hello\n"[..]).unwrap();
            builder.into_inner().unwrap().finish().unwrap();
        }
        let archive = dir.path().join("p.tar.gz");
        std::fs::File::create(&archive)
            .unwrap()
            .write_all(&tar_bytes)
            .unwrap();
        let mut h = Sha256::new();
        h.update(&tar_bytes);
        let sha_hex: [u8; 32] = h.finalize().into();
        let sha_hex = hex(&sha_hex);

        // Manifest with file:// URL pointing at our fixture.
        let manifest_text = format!(
            r#"
kind = "source"
name = "pcre2-source"
version = "10.42"

[source]
url = "file://{}"
sha256 = "{sha_hex}"

[license]
spdx = "BSD-3-Clause"
"#,
            archive.display()
        );
        let m = DepsManifest::parse(&manifest_text, dir.path().to_path_buf()).unwrap();

        let registry = Registry { roots: vec![] };
        let opts = ResolveOpts {
            cache_root: &cache,
            local_libs: None,
            force_source_build: None,
            fetch_only: false,
            repo_root: None,
            binaries_dir: None,
        };
        let path = ensure_built(&m, &registry, TEST_ARCH, TEST_ABI, &opts).unwrap();
        assert!(
            path.join("README").is_file(),
            "expected README at {}",
            path.display()
        );
        assert!(path.starts_with(cache.join("sources")));

        // Idempotent: second resolve hits the cache and returns the
        // same canonical path.
        let path2 = ensure_built(&m, &registry, TEST_ARCH, TEST_ABI, &opts).unwrap();
        assert_eq!(path, path2);
    }

    /// C.5: source-kind manifest with `[build].script_path` runs the script
    /// through `build_into_cache` and atomically installs the populated
    /// OUT_DIR under `<cache>/sources/...`. The script gets the same
    /// env-var contract as lib/program builds (OUT_DIR + NAME +
    /// VERSION + ...), so a marker file written via
    /// `$WASM_POSIX_DEP_OUT_DIR/marker` lands in the canonical path.
    ///
    /// Phase A-bis Task 2: `[build].script_path` is repo-root-relative,
    /// so the test pins `repo_root = manifest_dir` via
    /// `resolve_opts_with_repo`; the script_path basename `"custom.sh"`
    /// then resolves to `<manifest_dir>/custom.sh`, where the test
    /// fixture wrote it.
    #[test]
    fn ensure_built_source_kind_with_build_script_runs_it() {
        let manifest_dir = tempdir("c5-script-manifest");
        let cache = tempdir("c5-script-cache");

        // Build script: writes a marker file into OUT_DIR.
        let script = manifest_dir.join("custom.sh");
        std::fs::write(
            &script,
            "#!/bin/bash\nset -e\necho hi > \"$WASM_POSIX_DEP_OUT_DIR/marker\"\n",
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        }

        let manifest_text = r#"
kind = "source"
name = "pcre2-source"
version = "10.42"
kernel_abi = 7

[source]
url = "https://example.test/unused"
sha256 = "0000000000000000000000000000000000000000000000000000000000000000"

[license]
spdx = "BSD-3-Clause"

[build]
script_path = "custom.sh"
"#;
        let m = DepsManifest::parse(manifest_text, manifest_dir.clone()).unwrap();

        let registry = Registry { roots: vec![] };
        let path = ensure_built(
            &m,
            &registry,
            TEST_ARCH,
            TEST_ABI,
            &resolve_opts_with_repo(&cache, None, &manifest_dir),
        )
        .unwrap();
        assert!(
            path.join("marker").is_file(),
            "expected marker at {}",
            path.display()
        );
        assert!(path.starts_with(cache.join("sources")));
    }

    /// C.5: a no-op source-kind script that exits 0 without writing
    /// anything to OUT_DIR is rejected. Source manifests have no
    /// declared outputs list, so non-emptiness of OUT_DIR is the only
    /// signal that the script actually did work.
    #[test]
    fn ensure_built_source_kind_script_must_populate_out_dir() {
        let manifest_dir = tempdir("c5-noop-manifest");
        let cache = tempdir("c5-noop-cache");

        // No-op script — leaves OUT_DIR empty.
        let script = manifest_dir.join("noop.sh");
        std::fs::write(&script, "#!/bin/bash\nexit 0\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        }

        let manifest_text = r#"
kind = "source"
name = "pcre2-source"
version = "10.42"
kernel_abi = 7

[source]
url = "https://example.test/unused"
sha256 = "0000000000000000000000000000000000000000000000000000000000000000"

[license]
spdx = "BSD-3-Clause"

[build]
script_path = "noop.sh"
"#;
        // Phase A-bis Task 2: pin repo_root = manifest_dir so the
        // repo-relative basename `"noop.sh"` resolves to where the
        // fixture wrote it.
        let m = DepsManifest::parse(manifest_text, manifest_dir.clone()).unwrap();

        let registry = Registry { roots: vec![] };
        let err = ensure_built(
            &m,
            &registry,
            TEST_ARCH,
            TEST_ABI,
            &resolve_opts_with_repo(&cache, None, &manifest_dir),
        )
        .unwrap_err();
        assert!(
            err.to_lowercase().contains("empty") || err.contains("OUT_DIR"),
            "got: {err}"
        );
    }

    /// C.6: a direct `depends_on` of a `kind = "source"` manifest
    /// surfaces to the consumer's build script under
    /// `WASM_POSIX_DEP_<NAME>_SRC_DIR` — *not* the `*_DIR` suffix used
    /// for library/program deps. Per design 12, the suffix is
    /// self-documenting: `_SRC_DIR` means an unbuilt source tree,
    /// `_DIR` means a built-artifact root with `lib/`, `include/`, etc.
    #[test]
    fn source_kind_direct_dep_exports_src_dir_env_var() {
        let root = tempdir("c6-srcdir-reg");
        let cache = tempdir("c6-srcdir-cache");

        // foo-source: a kind = "source" manifest with a build-script
        // override (Task C.5) so we can populate the cache without
        // hitting the network. The script writes a marker file so the
        // consumer below has something concrete to assert against.
        let foo_dir = root.join("foo-source");
        std::fs::create_dir_all(&foo_dir).unwrap();
        let foo_script = foo_dir.join("custom.sh");
        std::fs::write(
            &foo_script,
            "#!/bin/bash\nset -e\necho hi > \"$WASM_POSIX_DEP_OUT_DIR/marker\"\n",
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&foo_script, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        // Phase A-bis Task 2: `script_path` is repo-root-relative.
        // The test pins `repo_root = root` below, so the script's
        // path must be expressed relative to `root` —
        // `foo-source/custom.sh`, NOT a bare `custom.sh`.
        std::fs::write(
            foo_dir.join("package.toml"),
            r#"
kind = "source"
name = "foo-source"
version = "1.0"
kernel_abi = 7

[source]
url = "https://example.test/unused"
sha256 = "0000000000000000000000000000000000000000000000000000000000000000"

[license]
spdx = "TestLicense"

[build]
script_path = "foo-source/custom.sh"
"#,
        )
        .unwrap();

        // consumer: a library that depends on foo-source. Its build
        // script asserts the source-kind suffix contract: _SRC_DIR
        // must be set and point at a directory; the legacy _DIR suffix
        // must NOT be set (otherwise consumers couldn't disambiguate
        // built artifacts from raw source trees just by looking at the
        // env var name).
        write_lib(
            &root,
            "consumer",
            "1.0.0",
            &["foo-source@1.0"],
            r#"
set -eu
test -n "${WASM_POSIX_DEP_FOO_SOURCE_SRC_DIR:-}" || { echo "FOO_SOURCE_SRC_DIR not set" >&2; exit 1; }
test -d "$WASM_POSIX_DEP_FOO_SOURCE_SRC_DIR" || { echo "FOO_SOURCE_SRC_DIR not a directory" >&2; exit 1; }
test -z "${WASM_POSIX_DEP_FOO_SOURCE_DIR:-}" || { echo "FOO_SOURCE_DIR should NOT be set for source-kind dep" >&2; exit 1; }
mkdir -p "$WASM_POSIX_DEP_OUT_DIR/lib"
echo ok > "$WASM_POSIX_DEP_OUT_DIR/lib/libconsumer.a"
"#,
            r#"[outputs]
libs = ["lib/libconsumer.a"]
"#,
        );

        let reg = Registry {
            roots: vec![root.clone()],
        };
        let consumer = reg.load("consumer").unwrap();
        let consumer_path = ensure_built(
            &consumer,
            &reg,
            TEST_ARCH,
            TEST_ABI,
            &resolve_opts_with_repo(&cache, None, &root),
        )
        .unwrap();
        assert!(
            consumer_path.join("lib/libconsumer.a").is_file(),
            "expected libconsumer.a at {}",
            consumer_path.display()
        );
    }

    /// C.10: a cache hit must short-circuit BEFORE host-tool probes
    /// run. We declare a tool that definitely doesn't exist on PATH;
    /// if `ensure_built` returned the cached path without erroring,
    /// the probe was correctly skipped. (If probes ran on cache hits,
    /// every consumer that builds once would refuse to resolve until
    /// every host-tool listed in its manifest stayed installed
    /// forever — clearly wrong.)
    #[test]
    fn ensure_built_cache_hit_skips_host_tool_probes() {
        let manifest_dir = tempdir("c10-cachehit-manifest");
        let cache = tempdir("c10-cachehit-cache");

        let manifest_text = r#"
kind = "library"
name = "fake"
version = "0.1"

[source]
url = "https://example.test/fake.tar.gz"
sha256 = "0000000000000000000000000000000000000000000000000000000000000000"

[license]
spdx = "MIT"

[outputs]
libs = ["lib/libfake.a"]

[[host_tools]]
name = "this-host-tool-does-not-exist"
version_constraint = ">=99.99"
"#;
        let m = DepsManifest::parse(manifest_text, manifest_dir.clone()).unwrap();

        let registry = Registry { roots: vec![] };
        // Pre-populate the canonical cache dir so ensure_built sees a hit.
        let sha = compute_sha(
            &m,
            &registry,
            TEST_ARCH,
            TEST_ABI,
            &mut BTreeMap::new(),
            &mut Vec::new(),
        )
        .unwrap();
        let canonical = canonical_path(&cache, &m, TEST_ARCH, &sha);
        std::fs::create_dir_all(canonical.join("lib")).unwrap();
        std::fs::write(canonical.join("lib/libfake.a"), b"").unwrap();

        let path = ensure_built(
            &m,
            &registry,
            TEST_ARCH,
            TEST_ABI,
            &resolve_opts(&cache, None),
        )
        .expect("cache hit should skip host-tool probes");
        assert_eq!(path, canonical);
    }

    /// C.10: on a cache miss, a missing host-tool must abort BEFORE
    /// any source-extract or build-script work, with an error that
    /// names the tool and (on platforms with hints) cites the matching
    /// install_hint.
    #[test]
    fn ensure_built_cache_miss_aborts_when_host_tool_missing() {
        let manifest_dir = tempdir("c10-cachemiss-manifest");
        let cache = tempdir("c10-cachemiss-cache");

        // No build script needed: the probe must abort before we'd
        // ever invoke one. We still pass a sane manifest shape.
        let manifest_text = r#"
kind = "library"
name = "fake"
version = "0.1"

[source]
url = "https://example.test/fake.tar.gz"
sha256 = "0000000000000000000000000000000000000000000000000000000000000000"

[license]
spdx = "MIT"

[outputs]
libs = []

[[host_tools]]
name = "this-host-tool-does-not-exist"
version_constraint = ">=99.99"
install_hints = { darwin = "brew install nope", linux = "apt install nope" }
"#;
        let m = DepsManifest::parse(manifest_text, manifest_dir).unwrap();

        let registry = Registry { roots: vec![] };
        let err = ensure_built(
            &m,
            &registry,
            TEST_ARCH,
            TEST_ABI,
            &resolve_opts(&cache, None),
        )
        .unwrap_err();
        assert!(err.contains("host-tool"), "got: {err}");
        assert!(err.contains("this-host-tool-does-not-exist"), "got: {err}");
        // The fixture provides hints under the keys "darwin" and
        // "linux"; the renderer maps Rust's `std::env::consts::OS`
        // ("macos") to the conventional key "darwin", so on both
        // macOS and Linux we should hit the matched-hint branch.
        // On other OSes (windows, freebsd, ...) the fixture has no
        // matching key, so we leave the assertion off there.
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        assert!(err.contains("install hint"), "got: {err}");
    }

    /// C.10: confirm `render_probe_failures` looks up `install_hints`
    /// under the conventional key `"darwin"` on macOS, not Rust's
    /// `std::env::consts::OS` value `"macos"`. Without the alias, a
    /// manifest declaring `darwin = "..."` would fall through to the
    /// "no install hint" branch on Apple.
    #[cfg(target_os = "macos")]
    #[test]
    fn render_probe_failures_uses_darwin_alias_for_macos() {
        let manifest_dir = tempdir("c10-darwin-alias-manifest");
        let manifest_text = r#"
kind = "library"
name = "fake"
version = "0.1"

[source]
url = "https://example.test/fake.tar.gz"
sha256 = "0000000000000000000000000000000000000000000000000000000000000000"

[license]
spdx = "MIT"

[outputs]
libs = []

[[host_tools]]
name = "needs-darwin-hint"
version_constraint = ">=1.0"
install_hints = { darwin = "brew install needs-darwin-hint" }
"#;
        let m = DepsManifest::parse(manifest_text, manifest_dir).unwrap();

        let failures = vec![ProbeFailure::Missing {
            tool: "needs-darwin-hint".to_string(),
            reason: "not found on PATH".to_string(),
        }];
        let rendered = render_probe_failures(&m, &failures);
        assert!(
            rendered.contains("install hint (darwin):"),
            "expected darwin-keyed install hint, got: {rendered}"
        );
        assert!(
            rendered.contains("brew install needs-darwin-hint"),
            "expected darwin hint string in output, got: {rendered}"
        );
        assert!(
            !rendered.contains("available platforms"),
            "should not fall through to available-platforms branch, got: {rendered}"
        );
    }

    // -----------------------------------------------------------------
    // C.11: build-deps check (cross-consumer host-tool consistency lint)
    // -----------------------------------------------------------------

    /// Helper for C.11 tests: write a minimal library package.toml that
    /// declares a single `[[host_tools]]` entry for the named tool.
    /// `extra` is appended verbatim inside the host_tools table — used
    /// to override the probe.
    fn write_with_host_tool(
        root: &Path,
        consumer: &str,
        tool: &str,
        constraint: &str,
        extra: &str,
    ) {
        let dir = root.join(consumer);
        fs::create_dir_all(&dir).unwrap();
        let text = format!(
            r#"
kind = "library"
name = "{consumer}"
version = "1.0"

[source]
url = "https://example.test/{consumer}-1.0.tar.gz"
sha256 = "{:0>64}"

[license]
spdx = "TestLicense"

[outputs]
libs = ["lib/lib{consumer}.a"]

[[host_tools]]
name = "{tool}"
version_constraint = "{constraint}"
{extra}
"#,
            ""
        );
        fs::write(dir.join("package.toml"), text).unwrap();
    }

    /// Two consumers each declaring `make >=4.0` with default probes
    /// must pass the consistency check.
    #[test]
    fn build_deps_check_passes_on_consistent_registry() {
        let root = tempdir("c11-check-pass");
        write_with_host_tool(&root, "consumerA", "make", ">=4.0", "");
        write_with_host_tool(&root, "consumerB", "make", ">=4.0", "");

        let registry = Registry { roots: vec![root] };
        cmd_check(&registry).expect("consistent host_tools should pass");
    }

    /// Two consumers declaring `cmake` with different
    /// version_constraints (>=3.20 vs >=3.10) must error, naming the
    /// tool and "inconsistent".
    #[test]
    fn build_deps_check_flags_inconsistent_constraint() {
        let root = tempdir("c11-check-constraint");
        write_with_host_tool(&root, "consumerA", "cmake", ">=3.20", "");
        write_with_host_tool(&root, "consumerB", "cmake", ">=3.10", "");

        let registry = Registry { roots: vec![root] };
        let err = cmd_check(&registry).expect_err("mismatched version_constraints should fail");
        assert!(err.contains("cmake"), "got: {err}");
        assert!(err.contains("inconsistent"), "got: {err}");
    }

    /// Two consumers declaring `make >=4.0` with the same constraint
    /// but different `probe.args` (`--version` vs `-v`) must error,
    /// naming "probe".
    #[test]
    fn build_deps_check_flags_inconsistent_probe() {
        let root = tempdir("c11-check-probe");
        write_with_host_tool(
            &root,
            "consumerA",
            "make",
            ">=4.0",
            r#"probe = { args = ["--version"], version_regex = "(\\d+\\.\\d+(?:\\.\\d+)?)" }"#,
        );
        write_with_host_tool(
            &root,
            "consumerB",
            "make",
            ">=4.0",
            r#"probe = { args = ["-v"], version_regex = "(\\d+\\.\\d+(?:\\.\\d+)?)" }"#,
        );

        let registry = Registry { roots: vec![root] };
        let err = cmd_check(&registry).expect_err("mismatched probes should fail");
        assert!(err.contains("probe"), "got: {err}");
    }

    // --- force-rebuild tests (Task force_source_build) ---

    #[test]
    fn force_rebuild_runs_build_script_on_cache_hit() {
        // Pre-populate the cache with one ensure_built call, then call
        // again with force_source_build set — the build script must run
        // a SECOND time, producing fresh contents at the canonical path.
        let root = tempdir("force-cache-reg");
        let cache = tempdir("force-cache-cache");
        write_lib(
            &root,
            "libF1",
            "1.0.0",
            &[],
            &format!(
                r#"
echo ran >> "{}/counter"
mkdir -p "$WASM_POSIX_DEP_OUT_DIR/lib"
touch "$WASM_POSIX_DEP_OUT_DIR/lib/libF1.a"
"#,
                root.display()
            ),
            r#"[outputs]
libs = ["lib/libF1.a"]
"#,
        );
        let reg = Registry {
            roots: vec![root.clone()],
        };
        let m = reg.load("libF1").unwrap();

        // First call — cache miss, script runs.
        let p1 = ensure_built(&m, &reg, TEST_ARCH, TEST_ABI, &resolve_opts(&cache, None)).unwrap();

        // Second call WITHOUT force — cache hit, script does not run.
        let p2 = ensure_built(&m, &reg, TEST_ARCH, TEST_ABI, &resolve_opts(&cache, None)).unwrap();
        assert_eq!(p1, p2);
        let runs = std::fs::read_to_string(root.join("counter")).unwrap();
        assert_eq!(
            runs.lines().count(),
            1,
            "without force, cache hit must skip script"
        );

        // Third call WITH force — script runs again despite cache hit.
        let mut force = BTreeSet::new();
        force.insert("libF1".to_string());
        let opts = ResolveOpts {
            cache_root: &cache,
            local_libs: None,
            force_source_build: Some(&force),
            fetch_only: false,
            repo_root: None,
            binaries_dir: None,
        };
        let p3 = ensure_built(&m, &reg, TEST_ARCH, TEST_ABI, &opts).unwrap();
        assert_eq!(p1, p3, "force-rebuild must land at the same canonical path");
        let runs = std::fs::read_to_string(root.join("counter")).unwrap();
        assert_eq!(
            runs.lines().count(),
            2,
            "force-rebuild must re-run the build script (counter: {runs:?})"
        );
    }

    #[test]
    fn force_rebuild_bypasses_index_fetch() {
        // Stage a real archive + index entry that WOULD resolve cleanly
        // (matching sha/arch/abi/cache_key) and confirm `force_rebuild`
        // skips the index path entirely — the source build's
        // `via-build` sentinel appears and the canonical cache holds
        // the script-built artifact, not the archive's.
        let root = tempdir("force-idx-reg");
        let cache = tempdir("force-idx-cache");
        let archive_dir = tempdir("force-idx-archive");
        let index_dir = tempdir("force-idx-index");

        let throwaway_root = tempdir("force-idx-pre");
        write_lib(
            &throwaway_root,
            "libF2",
            "1.0.0",
            &[],
            "true",
            "[outputs]\nlibs = [\"lib/out.a\"]\n",
        );
        let pre_reg = Registry {
            roots: vec![throwaway_root.clone()],
        };
        let pre_m = pre_reg.load("libF2").unwrap();
        let pre_sha = compute_sha(
            &pre_m,
            &pre_reg,
            TEST_ARCH,
            TEST_ABI,
            &mut BTreeMap::new(),
            &mut Vec::new(),
        )
        .unwrap();
        let cache_key_hex = hex(&pre_sha);
        let _ = std::fs::remove_dir_all(&throwaway_root);

        // Build an archive whose contents differ from the source build
        // so we can tell which path produced the artifact.
        let manifest_text = archived_manifest_text("libF2", "wasm32", &[TEST_ABI], &cache_key_hex);
        let archive_bytes = crate::remote_fetch::build_test_archive(
            &manifest_text,
            &[("lib/out.a", b"REMOTE-ARCHIVE")],
        );
        let archive_sha_hex = sha256_hex(&archive_bytes);
        let archive_path = archive_dir.join("libF2-1.0.0.tar.zst");
        std::fs::write(&archive_path, &archive_bytes).unwrap();
        let archive_url = format!("file://{}", archive_path.display());

        let index_path = index_dir.join("index.toml");
        stage_index_toml(
            &index_path,
            "libF2",
            TargetArch::Wasm32,
            &archive_url,
            &archive_sha_hex,
            &cache_key_hex,
        );
        let index_url = format!("file://{}", index_path.display());
        write_lib_with_build_toml(&root, "libF2", &index_url);

        let reg = Registry { roots: vec![root] };
        let m = reg.load("libF2").unwrap();

        // Force-build into a fresh cache. Remote fetch must be skipped:
        // the source build's `via-build` sentinel must exist, and
        // `lib/out.a` must hold BUILD content (not REMOTE-ARCHIVE).
        let mut force = BTreeSet::new();
        force.insert("libF2".to_string());
        let opts = ResolveOpts {
            cache_root: &cache,
            local_libs: None,
            force_source_build: Some(&force),
            fetch_only: false,
            repo_root: None,
            binaries_dir: None,
        };
        let path = ensure_built(&m, &reg, TEST_ARCH, TEST_ABI, &opts).unwrap();
        assert!(
            path.join("via-build").exists(),
            "force-rebuild must source-build (sentinel missing at {})",
            path.display()
        );
        let lib_bytes = std::fs::read(path.join("lib/out.a")).unwrap();
        assert_eq!(
            lib_bytes, b"BUILD\n",
            "force-rebuild must use the source-built artifact, not the remote archive"
        );
    }

    #[test]
    fn force_rebuild_only_affects_named_packages() {
        // Two libs in the registry, only one in the force set: the
        // listed one re-runs its build script, the other stays cached.
        let root = tempdir("force-named-reg");
        let cache = tempdir("force-named-cache");
        write_lib(
            &root,
            "libF3a",
            "1.0.0",
            &[],
            &format!(
                r#"
echo ran >> "{}/counter-a"
mkdir -p "$WASM_POSIX_DEP_OUT_DIR/lib"
touch "$WASM_POSIX_DEP_OUT_DIR/lib/libF3a.a"
"#,
                root.display()
            ),
            r#"[outputs]
libs = ["lib/libF3a.a"]
"#,
        );
        write_lib(
            &root,
            "libF3b",
            "1.0.0",
            &[],
            &format!(
                r#"
echo ran >> "{}/counter-b"
mkdir -p "$WASM_POSIX_DEP_OUT_DIR/lib"
touch "$WASM_POSIX_DEP_OUT_DIR/lib/libF3b.a"
"#,
                root.display()
            ),
            r#"[outputs]
libs = ["lib/libF3b.a"]
"#,
        );
        let reg = Registry {
            roots: vec![root.clone()],
        };
        let ma = reg.load("libF3a").unwrap();
        let mb = reg.load("libF3b").unwrap();

        // Prime both caches.
        ensure_built(&ma, &reg, TEST_ARCH, TEST_ABI, &resolve_opts(&cache, None)).unwrap();
        ensure_built(&mb, &reg, TEST_ARCH, TEST_ABI, &resolve_opts(&cache, None)).unwrap();
        assert_eq!(
            std::fs::read_to_string(root.join("counter-a"))
                .unwrap()
                .lines()
                .count(),
            1
        );
        assert_eq!(
            std::fs::read_to_string(root.join("counter-b"))
                .unwrap()
                .lines()
                .count(),
            1
        );

        // Force only libF3a.
        let mut force = BTreeSet::new();
        force.insert("libF3a".to_string());
        let opts = ResolveOpts {
            cache_root: &cache,
            local_libs: None,
            force_source_build: Some(&force),
            fetch_only: false,
            repo_root: None,
            binaries_dir: None,
        };
        ensure_built(&ma, &reg, TEST_ARCH, TEST_ABI, &opts).unwrap();
        ensure_built(&mb, &reg, TEST_ARCH, TEST_ABI, &opts).unwrap();

        // libF3a re-ran (counter-a now has 2), libF3b stayed cached.
        assert_eq!(
            std::fs::read_to_string(root.join("counter-a"))
                .unwrap()
                .lines()
                .count(),
            2,
            "named lib must re-run under force"
        );
        assert_eq!(
            std::fs::read_to_string(root.join("counter-b"))
                .unwrap()
                .lines()
                .count(),
            1,
            "non-named lib must stay cached"
        );
    }

    // ---------------------------------------------------------------
    // Phase C Task 2: --binaries-dir flag (resolver places symlinks)
    // ---------------------------------------------------------------

    #[test]
    fn extract_binaries_dir_flag_separated_form() {
        let (got, rest) = extract_binaries_dir_flag(vec![
            "resolve".into(),
            "--binaries-dir".into(),
            "/tmp/bins".into(),
            "bash".into(),
        ])
        .unwrap();
        assert_eq!(got, Some(PathBuf::from("/tmp/bins")));
        assert_eq!(rest, vec!["resolve".to_string(), "bash".into()]);
    }

    #[test]
    fn extract_binaries_dir_flag_equals_form() {
        let (got, rest) = extract_binaries_dir_flag(vec![
            "--binaries-dir=/x/y".into(),
            "resolve".into(),
            "z".into(),
        ])
        .unwrap();
        assert_eq!(got, Some(PathBuf::from("/x/y")));
        assert_eq!(rest, vec!["resolve".to_string(), "z".into()]);
    }

    #[test]
    fn extract_binaries_dir_flag_absent() {
        let (got, rest) = extract_binaries_dir_flag(vec!["resolve".into(), "bash".into()]).unwrap();
        assert_eq!(got, None);
        assert_eq!(rest, vec!["resolve".to_string(), "bash".into()]);
    }

    #[test]
    fn extract_binaries_dir_flag_rejects_duplicate() {
        let err = extract_binaries_dir_flag(vec![
            "--binaries-dir".into(),
            "/a".into(),
            "--binaries-dir=/b".into(),
        ])
        .unwrap_err();
        assert!(err.contains("more than once"), "got: {err}");
    }

    #[test]
    fn extract_fetch_only_flag_removes_flag() {
        let (got, rest) =
            extract_fetch_only_flag(vec!["resolve".into(), "--fetch-only".into(), "bash".into()]);
        assert!(got);
        assert_eq!(rest, vec!["resolve".to_string(), "bash".into()]);
    }

    #[test]
    fn cmd_resolve_with_binaries_dir_places_single_output_symlink() {
        // Single-output program: symlink lands at
        //   <binaries_dir>/programs/<arch>/<output.name>.<ext>
        // i.e. flat under the per-arch subdir, no per-program nest.
        let root = tempdir("resolve-bdir-single-reg");
        let cache = tempdir("resolve-bdir-single-cache");
        let bin_dir = tempdir("resolve-bdir-single-bin");
        write_program(
            &root,
            "tinybin",
            "0.1.0",
            &[],
            &emit_wasm_build_script("tinybin.wasm", &minimal_executable_wasm()),
            &[("tinybin", "tinybin.wasm")],
        );
        let reg = Registry {
            roots: vec![root.clone()],
        };
        let m = reg.load("tinybin").unwrap();

        // Repo root for cmd_resolve = registry root (script_path
        // resolves repo-relative; for these tests the per-package
        // dir contains its own build script and the package.toml's
        // script_path is unset, so the resolver's
        // "<repo>/<dir-rel>/build-<name>.sh" fallback finds it).
        cmd_resolve_with_test_cache(&m, &reg, &root, TargetArch::Wasm32, &cache, Some(&bin_dir))
            .unwrap();

        let link = bin_dir.join("programs/wasm32/tinybin.wasm");
        assert!(
            link.symlink_metadata().is_ok(),
            "symlink missing: {}",
            link.display()
        );
        let target = std::fs::read_link(&link).unwrap();
        assert!(target.is_absolute(), "symlink must be absolute: {target:?}");
        assert!(target.ends_with("tinybin.wasm"), "got: {target:?}");
        // The symlink resolves to a real file in the cache.
        assert!(
            link.exists(),
            "symlink target unreadable: {}",
            link.display()
        );
    }

    #[test]
    fn cmd_resolve_materializes_program_runtime_file_under_package_directory() {
        let root = tempdir("resolve-bdir-runtime-reg");
        let cache = tempdir("resolve-bdir-runtime-cache");
        let bin_dir = tempdir("resolve-bdir-runtime-bin");
        write_program(
            &root,
            "runtimebin",
            "0.1.0",
            &[],
            r#"mkdir -p "$WASM_POSIX_DEP_OUT_DIR"
printf '\x00asm\x01\x00\x00\x00\x01\x05\x01\x60\x00\x01\x7f\x03\x02\x01\x00\x07\x1a\x02\x0d__abi_version\x00\x00\x06_start\x00\x00\x0a\x06\x01\x04\x00\x41\x00\x0b' > "$WASM_POSIX_DEP_OUT_DIR/runtimebin.wasm"
printf canonical-runtime > "$WASM_POSIX_DEP_OUT_DIR/icu.dat""#,
            &[("runtimebin", "runtimebin.wasm")],
        );
        append_program_runtime_file(&root, "runtimebin", "icu.dat", "/usr/lib/php/icu.dat");
        let reg = Registry {
            roots: vec![root.clone()],
        };
        let m = reg.load("runtimebin").unwrap();

        cmd_resolve_with_test_cache(&m, &reg, &root, TargetArch::Wasm32, &cache, Some(&bin_dir))
            .unwrap();

        let runtime = bin_dir.join("programs/wasm32/runtimebin/icu.dat");
        assert!(runtime.symlink_metadata().unwrap().file_type().is_symlink());
        assert_eq!(fs::read(runtime).unwrap(), b"canonical-runtime");
        assert!(bin_dir.join("programs/wasm32/runtimebin.wasm").exists());
    }

    #[test]
    fn cmd_resolve_with_binaries_dir_places_kernel_at_root() {
        // First-party kernel/userspace artifacts are consumed as
        // binaries/kernel.wasm and binaries/userspace.wasm, not as
        // regular programs under binaries/programs/<arch>/.
        let root = tempdir("resolve-bdir-kernel-reg");
        let cache = tempdir("resolve-bdir-kernel-cache");
        let bin_dir = tempdir("resolve-bdir-kernel-bin");
        write_program(
            &root,
            "kernel",
            "0.1.0",
            &[],
            &emit_wasm_build_script(
                "kandelo-kernel.wasm",
                &wasm_exporting_names(wasm_posix_shared::abi::HOST_ADAPTER_REQUIRED_KERNEL_EXPORTS),
            ),
            &[("kernel", "kandelo-kernel.wasm")],
        );
        let reg = Registry {
            roots: vec![root.clone()],
        };
        let m = reg.load("kernel").unwrap();

        cmd_resolve_with_test_cache(&m, &reg, &root, TargetArch::Wasm64, &cache, Some(&bin_dir))
            .unwrap();

        let link = bin_dir.join("kernel.wasm");
        assert!(
            link.symlink_metadata().is_ok(),
            "symlink missing: {}",
            link.display()
        );
        assert!(
            !bin_dir.join("programs/wasm64/kernel.wasm").exists(),
            "kernel should not be placed under programs/"
        );
    }

    #[test]
    fn cmd_resolve_with_binaries_dir_places_multi_output_symlinks() {
        // Multi-output program: symlinks land at
        //   <binaries_dir>/programs/<arch>/<program.name>/<output.name>.<ext>
        let root = tempdir("resolve-bdir-multi-reg");
        let cache = tempdir("resolve-bdir-multi-cache");
        let bin_dir = tempdir("resolve-bdir-multi-bin");
        write_program(
            &root,
            "twobin",
            "0.1.0",
            &[],
            &format!(
                "{}\n{}",
                emit_wasm_build_script("alpha.wasm", &minimal_executable_wasm()),
                emit_wasm_build_script("beta.wasm", &minimal_executable_wasm()),
            ),
            &[("alpha", "alpha.wasm"), ("beta", "beta.wasm")],
        );
        let reg = Registry {
            roots: vec![root.clone()],
        };
        let m = reg.load("twobin").unwrap();

        cmd_resolve_with_test_cache(&m, &reg, &root, TargetArch::Wasm32, &cache, Some(&bin_dir))
            .unwrap();

        let alpha = bin_dir.join("programs/wasm32/twobin/alpha.wasm");
        let beta = bin_dir.join("programs/wasm32/twobin/beta.wasm");
        assert!(alpha.exists(), "alpha symlink missing");
        assert!(beta.exists(), "beta symlink missing");
    }

    #[test]
    fn cmd_resolve_without_binaries_dir_places_no_symlinks() {
        // Sanity: the flag is opt-in. No flag → no symlinks under the
        // (initially-absent) bin_dir.
        let root = tempdir("resolve-bdir-none-reg");
        let cache = tempdir("resolve-bdir-none-cache");
        let bin_dir = tempdir("resolve-bdir-none-bin");
        write_program(
            &root,
            "noflag",
            "0.1.0",
            &[],
            &emit_wasm_build_script("noflag.wasm", &minimal_executable_wasm()),
            &[("noflag", "noflag.wasm")],
        );
        let reg = Registry {
            roots: vec![root.clone()],
        };
        let m = reg.load("noflag").unwrap();

        cmd_resolve_with_test_cache(&m, &reg, &root, TargetArch::Wasm32, &cache, None).unwrap();

        let link = bin_dir.join("programs/wasm32/noflag.wasm");
        assert!(
            !link.exists() && link.symlink_metadata().is_err(),
            "no symlink should exist without --binaries-dir"
        );
    }

    #[test]
    fn cmd_resolve_with_binaries_dir_replaces_existing_link() {
        // A previous resolve may have left a stale symlink (e.g.
        // pointing at a now-evicted cache entry). The resolver must
        // overwrite rather than fail with EEXIST.
        let root = tempdir("resolve-bdir-replace-reg");
        let cache = tempdir("resolve-bdir-replace-cache");
        let bin_dir = tempdir("resolve-bdir-replace-bin");
        write_program(
            &root,
            "rep",
            "0.1.0",
            &[],
            &emit_wasm_build_script("rep.wasm", &minimal_executable_wasm()),
            &[("rep", "rep.wasm")],
        );
        let reg = Registry {
            roots: vec![root.clone()],
        };
        let m = reg.load("rep").unwrap();

        // Pre-create a stale symlink at the destination.
        let arch_root = bin_dir.join("programs/wasm32");
        std::fs::create_dir_all(&arch_root).unwrap();
        let dest = arch_root.join("rep.wasm");
        std::os::unix::fs::symlink("/nonexistent/stale.wasm", &dest).unwrap();

        cmd_resolve_with_test_cache(&m, &reg, &root, TargetArch::Wasm32, &cache, Some(&bin_dir))
            .unwrap();

        // New symlink replaces the stale one and resolves to a real file.
        assert!(dest.exists(), "replaced symlink must point at a real file");
    }

    /// Test-only variant of `cmd_resolve` that takes an explicit
    /// `cache_root` (instead of reading `default_cache_root()`) and
    /// a repo path, so unit tests can drive the resolver from a
    /// tempdir without touching `~/.cache/kandelo`. Mirrors
    /// the production `cmd_resolve` body so the symlink path stays
    /// honestly exercised.
    fn cmd_resolve_with_test_cache(
        m: &DepsManifest,
        registry: &Registry,
        repo: &Path,
        arch: TargetArch,
        cache_root: &Path,
        binaries_dir: Option<&Path>,
    ) -> Result<(), String> {
        let opts = ResolveOpts {
            cache_root,
            local_libs: None,
            force_source_build: None,
            fetch_only: false,
            repo_root: Some(repo),
            binaries_dir: None,
        };
        let path = ensure_built(m, registry, arch, TEST_ABI, &opts)?;
        if let Some(bdir) = binaries_dir {
            if matches!(m.kind, ManifestKind::Program) && !m.program_outputs.is_empty() {
                place_binaries_symlinks(m, &path, bdir, arch)?;
            }
        }
        Ok(())
    }
}
