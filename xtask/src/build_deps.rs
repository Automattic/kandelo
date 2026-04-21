//! `xtask build-deps` — dep-graph resolver for Wasm libraries.
//!
//! Resolution order per library:
//!   1. `<repo>/local-libs/<name>/build/` — hand-patched source, in-progress.
//!   2. `<cache_root>/libs/<name>-<ver>-rev<N>-<shortsha>/` — canonical cache.
//!   3. Build from source: run the declared `build.script`, validate
//!      declared outputs, atomically install into the canonical cache.
//!
//! The build script runs with:
//!   * `WASM_POSIX_DEP_OUT_DIR` — temp dir the script must install into.
//!   * `WASM_POSIX_DEP_NAME`, `WASM_POSIX_DEP_VERSION`,
//!     `WASM_POSIX_DEP_REVISION` — identity of the lib being built.
//!   * `WASM_POSIX_DEP_SOURCE_URL`, `WASM_POSIX_DEP_SOURCE_SHA256` —
//!     upstream tarball URL + expected sha (the script downloads and
//!     verifies; the resolver doesn't fetch anything itself).
//!   * `WASM_POSIX_DEP_<UPPER>_DIR` — for each *direct* declared dep
//!     (where `UPPER` is the dep name upper-cased with `-` → `_`),
//!     the resolved cache path of that dep's `{lib,include,…}`.
//!
//! Atomic install: build in `<canonical>.tmp-<pid>/`, then `rename(2)`
//! into the canonical path. Readers either see the full previous
//! version of the cache entry or the full new one, never a partial
//! write. Races are handled: if two builds finish simultaneously, the
//! first wins and the second's temp dir is discarded.
//!
//! Subcommands:
//!   parse    <name|path>   Load + validate a deps.toml, print it back
//!                          normalised.
//!   sha      <name>        Print the cache-key sha (transitive).
//!   path     <name>        Print the canonical cache path.
//!   resolve  <name>        Ensure the lib is built, print its path.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;

use sha2::{Digest, Sha256};

use crate::deps_manifest::{DepRef, DepsManifest};
use crate::repo_root;

/// Root directory of the per-user lib cache. Honors `XDG_CACHE_HOME`,
/// else `$HOME/.cache`. Matches the pattern other tools in the repo use.
pub fn default_cache_root() -> PathBuf {
    if let Some(xdg) = std::env::var_os("XDG_CACHE_HOME") {
        PathBuf::from(xdg).join("wasm-posix-kernel")
    } else if let Some(home) = std::env::var_os("HOME") {
        PathBuf::from(home)
            .join(".cache")
            .join("wasm-posix-kernel")
    } else {
        // Fall back to a tempdir-adjacent location. Not ideal but
        // avoids panicking on exotic environments.
        PathBuf::from("/tmp/wasm-posix-kernel")
    }
}

/// Registry search path. Later entries have lower priority.
pub struct Registry {
    pub roots: Vec<PathBuf>,
}

impl Registry {
    /// From `WASM_POSIX_DEPS_REGISTRY` (colon-separated), else the
    /// repo's `examples/libs/`.
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
            roots: vec![repo.join("examples/libs")],
        }
    }

    /// Locate `<name>/deps.toml` by walking registry roots. First hit
    /// wins.
    pub fn find(&self, name: &str) -> Option<PathBuf> {
        for root in &self.roots {
            let p = root.join(name).join("deps.toml");
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
                "dep {:?}: no deps.toml found in registry roots [{}]",
                name,
                paths.join(", ")
            )
        })?;
        DepsManifest::load(&path)
    }
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
///
/// Inputs hashed (order-sensitive, newline-delimited domain-separated):
///   `name`, `version`, `revision`, `source.url`, `source.sha256`,
///   then for each dep (sorted by name):
///     `dep.name`, `dep.version`, hex(dep_sha)
///
/// Cycle detection via `chain`: a manifest may not transitively
/// depend on itself.
pub fn compute_sha(
    target: &DepsManifest,
    registry: &Registry,
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
    if let Some(cached) = memo.get(&target.spec()) {
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
        let child_sha = compute_sha(&child, registry, memo, chain)?;
        dep_shas.push((dref.clone(), child_sha));
    }
    dep_shas.sort_by(|a, b| a.0.name.cmp(&b.0.name));

    chain.pop();

    let mut h = Sha256::new();
    h.update(b"wasm-posix-deps.v1\n");
    h.update(target.name.as_bytes());
    h.update(b"\n");
    h.update(target.version.as_bytes());
    h.update(b"\n");
    h.update(target.revision.to_le_bytes());
    h.update(b"\n");
    h.update(target.source.url.as_bytes());
    h.update(b"\n");
    h.update(target.source.sha256.as_bytes());
    h.update(b"\n");
    for (dref, dsha) in &dep_shas {
        h.update(dref.name.as_bytes());
        h.update(b"@");
        h.update(dref.version.as_bytes());
        h.update(b":");
        h.update(hex(dsha).as_bytes());
        h.update(b"\n");
    }

    let out: [u8; 32] = h.finalize().into();
    memo.insert(target.spec(), out);
    Ok(out)
}

/// Canonical cache directory for a resolved manifest.
///
/// Layout: `<cache_root>/libs/<name>-<version>-rev<revision>-<shortsha>/`
/// where shortsha is the first 8 hex chars of the cache-key sha —
/// matches the binaries-release convention. 32 bits of collision
/// resistance is enough for a per-user lib cache.
pub fn canonical_path(cache_root: &Path, m: &DepsManifest, sha: &[u8; 32]) -> PathBuf {
    cache_root.join("libs").join(format!(
        "{}-{}-rev{}-{}",
        m.name,
        m.version,
        m.revision,
        &hex(sha)[..8]
    ))
}

fn hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{:02x}", b));
    }
    s
}

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
}

/// Resolve a library to a concrete on-disk path with the artifacts
/// declared in its `deps.toml`. Ensures dependencies are resolved
/// first (depth-first), then runs the build script if neither a
/// `local-libs/` override nor a cache hit is available.
///
/// Returns the path the consumer should point `CPPFLAGS=-I<p>/include
/// LDFLAGS=-L<p>/lib` at.
pub fn ensure_built(
    target: &DepsManifest,
    registry: &Registry,
    opts: &ResolveOpts<'_>,
) -> Result<PathBuf, String> {
    let mut memo: BTreeMap<String, [u8; 32]> = BTreeMap::new();
    let mut building: Vec<String> = Vec::new();
    ensure_built_inner(target, registry, opts, &mut memo, &mut building)
}

fn ensure_built_inner(
    target: &DepsManifest,
    registry: &Registry,
    opts: &ResolveOpts<'_>,
    memo: &mut BTreeMap<String, [u8; 32]>,
    building: &mut Vec<String>,
) -> Result<PathBuf, String> {
    if building.iter().any(|s| s == &target.name) {
        return Err(format!(
            "cycle while building: {} -> {}",
            building.join(" -> "),
            target.name
        ));
    }
    building.push(target.name.clone());

    // Recursively resolve direct deps first; remember their paths so
    // we can surface them to the build script via env vars.
    let mut dep_dirs: BTreeMap<String, PathBuf> = BTreeMap::new();
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
        let dep_path = ensure_built_inner(&dep_m, registry, opts, memo, building)?;
        dep_dirs.insert(dep_m.name.clone(), dep_path);
    }

    building.pop();

    // Local-libs override: hand-patched source wins.
    if let Some(lr) = opts.local_libs {
        let override_dir = lr.join(&target.name).join("build");
        if override_dir.is_dir() {
            return Ok(override_dir);
        }
    }

    // Compute canonical cache path.
    let mut chain: Vec<String> = Vec::new();
    let sha = compute_sha(target, registry, memo, &mut chain)?;
    let canonical = canonical_path(opts.cache_root, target, &sha);

    // Cache hit: trust it. Users invalidate by deleting the directory.
    if canonical.is_dir() {
        return Ok(canonical);
    }

    build_into_cache(target, &canonical, &dep_dirs)?;
    Ok(canonical)
}

/// Run the build script with `WASM_POSIX_DEP_*` env vars set, validate
/// outputs under the temp directory, then `rename(2)` into place.
fn build_into_cache(
    target: &DepsManifest,
    canonical: &Path,
    dep_dirs: &BTreeMap<String, PathBuf>,
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
        std::fs::remove_dir_all(&tmp)
            .map_err(|e| format!("clean stale {}: {e}", tmp.display()))?;
    }
    std::fs::create_dir_all(&tmp)
        .map_err(|e| format!("create temp {}: {e}", tmp.display()))?;

    let script = target.build_script_path();
    if !script.is_file() {
        let _ = std::fs::remove_dir_all(&tmp);
        return Err(format!(
            "{}: build script {} not found",
            target.spec(),
            script.display()
        ));
    }

    let status = {
        let mut cmd = Command::new("bash");
        cmd.arg(&script);
        cmd.env("WASM_POSIX_DEP_OUT_DIR", &tmp);
        cmd.env("WASM_POSIX_DEP_NAME", &target.name);
        cmd.env("WASM_POSIX_DEP_VERSION", &target.version);
        cmd.env("WASM_POSIX_DEP_REVISION", target.revision.to_string());
        cmd.env("WASM_POSIX_DEP_SOURCE_URL", &target.source.url);
        cmd.env("WASM_POSIX_DEP_SOURCE_SHA256", &target.source.sha256);
        for (name, path) in dep_dirs {
            cmd.env(format!("WASM_POSIX_DEP_{}_DIR", env_key(name)), path);
        }
        cmd.status()
            .map_err(|e| format!("spawn bash {}: {e}", script.display()))?
    };

    if !status.success() {
        let _ = std::fs::remove_dir_all(&tmp);
        return Err(format!(
            "{}: build script {} exited with {}",
            target.spec(),
            script.display(),
            status
        ));
    }

    if let Err(e) = validate_outputs(target, &tmp) {
        let _ = std::fs::remove_dir_all(&tmp);
        return Err(e);
    }

    // Atomic install. If someone else finished first, keep theirs,
    // discard ours — identical inputs produce identical outputs, and
    // trying to overwrite a non-empty directory isn't portable.
    if canonical.exists() {
        let _ = std::fs::remove_dir_all(&tmp);
        return Ok(());
    }
    std::fs::rename(&tmp, canonical).map_err(|e| {
        format!(
            "rename {} -> {}: {e}",
            tmp.display(),
            canonical.display()
        )
    })?;
    Ok(())
}

fn validate_outputs(target: &DepsManifest, out_dir: &Path) -> Result<(), String> {
    let check = |rel: &str, label: &str| -> Result<(), String> {
        let p = out_dir.join(rel);
        if !p.exists() {
            return Err(format!(
                "{}: declared {} output {:?} not produced by build script",
                target.spec(),
                label,
                rel
            ));
        }
        Ok(())
    };
    for rel in &target.outputs.libs {
        check(rel, "libs")?;
    }
    for rel in &target.outputs.headers {
        check(rel, "headers")?;
    }
    for rel in &target.outputs.pkgconfig {
        check(rel, "pkgconfig")?;
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

pub fn run(args: Vec<String>) -> Result<(), String> {
    let mut it = args.into_iter();
    let sub = it.next().ok_or(
        "usage: xtask build-deps <parse|sha|path|resolve> <name|path>",
    )?;
    let target = it.next().ok_or_else(|| {
        format!("build-deps {sub}: missing <name|path>")
    })?;
    if it.next().is_some() {
        return Err(format!("build-deps {sub}: unexpected extra args"));
    }

    let repo = repo_root();
    let registry = Registry::from_env(&repo);

    // `target` is either a path to a deps.toml (contains '/' or ends
    // with .toml) or a bare name to look up in the registry.
    let manifest = load_target(&target, &registry)?;

    match sub.as_str() {
        "parse" => cmd_parse(&manifest),
        "sha" => cmd_sha(&manifest, &registry),
        "path" => cmd_path(&manifest, &registry),
        "resolve" => cmd_resolve(&manifest, &registry, &repo),
        other => Err(format!("build-deps: unknown subcommand {other:?}")),
    }
}

fn load_target(target: &str, registry: &Registry) -> Result<DepsManifest, String> {
    let looks_like_path = target.ends_with(".toml")
        || target.contains('/')
        || target.starts_with('.');
    if looks_like_path {
        DepsManifest::load(Path::new(target))
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
    println!("build     = {}", m.build_script_path().display());
    println!("outputs.libs     = {:?}", m.outputs.libs);
    println!("outputs.headers  = {:?}", m.outputs.headers);
    if !m.outputs.pkgconfig.is_empty() {
        println!("outputs.pkgconfig= {:?}", m.outputs.pkgconfig);
    }
    Ok(())
}

fn cmd_sha(m: &DepsManifest, registry: &Registry) -> Result<(), String> {
    let mut memo = BTreeMap::new();
    let mut chain = Vec::new();
    let sha = compute_sha(m, registry, &mut memo, &mut chain)?;
    println!("{}", hex(&sha));
    Ok(())
}

fn cmd_path(m: &DepsManifest, registry: &Registry) -> Result<(), String> {
    let mut memo = BTreeMap::new();
    let mut chain = Vec::new();
    let sha = compute_sha(m, registry, &mut memo, &mut chain)?;
    let path = canonical_path(&default_cache_root(), m, &sha);
    println!("{}", path.display());
    Ok(())
}

fn cmd_resolve(m: &DepsManifest, registry: &Registry, repo: &Path) -> Result<(), String> {
    let cache_root = default_cache_root();
    let local_libs = repo.join("local-libs");
    let opts = ResolveOpts {
        cache_root: &cache_root,
        local_libs: Some(&local_libs),
    };
    let path = ensure_built(m, registry, &opts)?;
    println!("{}", path.display());
    Ok(())
}

// ---------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
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
name = "{name}"
version = "{version}"
revision = 1
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
        fs::write(lib_dir.join("deps.toml"), text).unwrap();
    }

    fn tempdir(label: &str) -> PathBuf {
        let p = std::env::temp_dir()
            .join("wpk-xtask-test")
            .join(format!("{label}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
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
        assert_eq!(path, root1.join("libA/deps.toml"));
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
        assert_eq!(path, root2.join("libB/deps.toml"));
    }

    #[test]
    fn compute_sha_is_deterministic() {
        let root = tempdir("sha-stable");
        write(&root, "libZ", "1.0.0", &[]);
        let reg = Registry { roots: vec![root] };
        let m = reg.load("libZ").unwrap();

        let s1 = compute_sha(
            &m,
            &reg,
            &mut BTreeMap::new(),
            &mut Vec::new(),
        )
        .unwrap();
        let s2 = compute_sha(
            &m,
            &reg,
            &mut BTreeMap::new(),
            &mut Vec::new(),
        )
        .unwrap();
        assert_eq!(s1, s2, "sha must be deterministic");
    }

    #[test]
    fn compute_sha_changes_when_revision_bumps() {
        let root = tempdir("sha-rev-bump");
        write(&root, "libX", "1.0.0", &[]);
        let reg = Registry {
            roots: vec![root.clone()],
        };
        let m1 = reg.load("libX").unwrap();
        let sha1 = compute_sha(&m1, &reg, &mut BTreeMap::new(), &mut Vec::new())
            .unwrap();

        // Bump revision in-place by editing the file.
        let toml_path = root.join("libX/deps.toml");
        let text = std::fs::read_to_string(&toml_path).unwrap();
        let bumped = text.replace("revision = 1", "revision = 2");
        std::fs::write(&toml_path, bumped).unwrap();

        let m2 = reg.load("libX").unwrap();
        let sha2 = compute_sha(&m2, &reg, &mut BTreeMap::new(), &mut Vec::new())
            .unwrap();
        assert_ne!(sha1, sha2, "revision bump must invalidate cache key");
    }

    #[test]
    fn compute_sha_transitively_invalidates_consumers() {
        let root = tempdir("sha-transitive");
        write(&root, "libDep", "1.0.0", &[]);
        write(&root, "libCons", "1.0.0", &["libDep@1.0.0"]);
        let reg = Registry {
            roots: vec![root.clone()],
        };
        let cons = reg.load("libCons").unwrap();
        let sha_before =
            compute_sha(&cons, &reg, &mut BTreeMap::new(), &mut Vec::new()).unwrap();

        // Bump the dep's revision: consumer's sha must change.
        let dep_path = root.join("libDep/deps.toml");
        let text = std::fs::read_to_string(&dep_path).unwrap();
        std::fs::write(&dep_path, text.replace("revision = 1", "revision = 9"))
            .unwrap();

        let sha_after =
            compute_sha(&cons, &reg, &mut BTreeMap::new(), &mut Vec::new()).unwrap();
        assert_ne!(
            sha_before, sha_after,
            "bumping a dep's revision must invalidate its consumers"
        );
    }

    #[test]
    fn compute_sha_rejects_version_mismatch() {
        let root = tempdir("sha-mismatch");
        // Registry has libDep@2.0.0; consumer asks for libDep@1.0.0.
        write(&root, "libDep", "2.0.0", &[]);
        write(&root, "libCons", "1.0.0", &["libDep@1.0.0"]);
        let reg = Registry {
            roots: vec![root],
        };
        let cons = reg.load("libCons").unwrap();
        let err = compute_sha(&cons, &reg, &mut BTreeMap::new(), &mut Vec::new())
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
        let err = compute_sha(&a, &reg, &mut BTreeMap::new(), &mut Vec::new())
            .unwrap_err();
        assert!(err.contains("cycle"), "got: {err}");
    }

    // --- ensure_built / build_into_cache tests ---

    /// Create a deps.toml + build-<name>.sh pair. The build script uses
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
        std::fs::write(lib_dir.join("deps.toml"), deps_toml).unwrap();

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

        let path = ensure_built(&m, &reg, &resolve_opts(&cache, None)).unwrap();
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

        let p1 = ensure_built(&m, &reg, &resolve_opts(&cache, None)).unwrap();
        let p2 = ensure_built(&m, &reg, &resolve_opts(&cache, None)).unwrap();
        assert_eq!(p1, p2);
        let runs = std::fs::read_to_string(root.join("counter")).unwrap();
        assert_eq!(
            runs.lines().count(),
            1,
            "cache hit must skip the build script"
        );
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

        let err = ensure_built(&m, &reg, &resolve_opts(&cache, None)).unwrap_err();
        assert!(err.contains("not produced"), "got: {err}");
        // Temp dir was cleaned up; canonical path does not exist.
        let sha = compute_sha(&m, &reg, &mut BTreeMap::new(), &mut Vec::new()).unwrap();
        let canonical = canonical_path(&cache, &m, &sha);
        assert!(!canonical.exists(), "canonical cache dir must not exist on failure");

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

        let err = ensure_built(&m, &reg, &resolve_opts(&cache, None)).unwrap_err();
        assert!(err.contains("exited"), "got: {err}");
        let sha = compute_sha(&m, &reg, &mut BTreeMap::new(), &mut Vec::new()).unwrap();
        assert!(!canonical_path(&cache, &m, &sha).exists());
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

        let path =
            ensure_built(&m, &reg, &resolve_opts(&cache, Some(&local))).unwrap();
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
            ensure_built(&bar, &reg, &resolve_opts(&cache, None)).unwrap();

        let pseudo = std::fs::read_to_string(bar_path.join("lib/libBar.a")).unwrap();
        assert_eq!(pseudo.trim(), "foo header body");
    }

    #[test]
    fn env_key_canonicalises_hyphens_and_case() {
        assert_eq!(env_key("libcurl"), "LIBCURL");
        assert_eq!(env_key("zlib-ng"), "ZLIB_NG");
        assert_eq!(env_key("Foo-Bar-Baz"), "FOO_BAR_BAZ");
    }

    #[test]
    fn canonical_path_layout() {
        let root = tempdir("cache-path");
        write(&root, "zlib", "1.3.1", &[]);
        let reg = Registry {
            roots: vec![root],
        };
        let m = reg.load("zlib").unwrap();
        let sha = compute_sha(&m, &reg, &mut BTreeMap::new(), &mut Vec::new())
            .unwrap();
        let cache = PathBuf::from("/tmp/testcache");
        let path = canonical_path(&cache, &m, &sha);

        let parent = path.parent().unwrap();
        assert_eq!(parent, cache.join("libs"));
        let name = path.file_name().unwrap().to_string_lossy().into_owned();
        assert!(name.starts_with("zlib-1.3.1-rev1-"), "got {name}");
        // 8-char short sha appended after the last dash.
        let short = name.rsplit('-').next().unwrap();
        assert_eq!(short.len(), 8);
        assert!(short.chars().all(|c| c.is_ascii_hexdigit()));
    }
}
