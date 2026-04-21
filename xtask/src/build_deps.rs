//! `xtask build-deps` — dep-graph resolver for Wasm libraries.
//!
//! V1 scope (this revision):
//!   * Walk the registry search path (`WASM_POSIX_DEPS_REGISTRY`
//!     colon-separated list; default: `<repo>/examples/libs`) and
//!     locate `<name>/deps.toml`.
//!   * Compute a deterministic cache-key sha over
//!     `(name, version, revision, source.url, source.sha256,
//!     sorted transitive dep shas)`.
//!   * Print the canonical cache path that identical inputs map to.
//!
//! Not yet: running build scripts, atomic cache install,
//! `local-libs/` override, release `libs/*.tar.zst` fetch. Those land
//! in follow-up tasks on top of this skeleton.
//!
//! Subcommands:
//!   parse   <name|path>   Load + validate a deps.toml, print it back
//!                         normalised.
//!   sha     <name>        Print the cache-key sha of <name> (pulls
//!                         transitive deps from the registry).
//!   path    <name>        Print the canonical cache path for <name>.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

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
// Subcommand dispatch
// ---------------------------------------------------------------------

pub fn run(args: Vec<String>) -> Result<(), String> {
    let mut it = args.into_iter();
    let sub = it.next().ok_or(
        "usage: xtask build-deps <parse|sha|path> <name|path>",
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
