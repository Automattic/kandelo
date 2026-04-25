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
//!   * `WASM_POSIX_DEP_TARGET_ARCH` — `wasm32` or `wasm64`; the arch
//!     the build script must produce objects for.
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

use crate::deps_manifest::{DepRef, DepsManifest, TargetArch};
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
///   `name`, `version`, `revision`, `target_arch`, `abi_version`,
///   `source.url`, `source.sha256`, then for each dep (sorted by name):
///     `dep.name`, `dep.version`, hex(dep_sha)
///
/// `arch` and `abi_version` are propagated unchanged into recursive
/// calls — every node in a single resolution shares the same target
/// arch and ABI. An ABI bump therefore auto-invalidates every cache
/// entry transitively, since the v2 domain separator + new inputs
/// shift the leaf shas, which ripple up through their consumers.
///
/// Note: the single `abi_version` parameter here is the **consumer's**
/// target ABI. Archives separately advertise a `Vec<u32>` of ABIs they
/// are compatible with via `[compatibility].abi_versions`; Task A.9
/// verifies the consumer's value is contained in the archive's set
/// during remote-fetch.
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
        let child_sha = compute_sha(&child, registry, arch, abi_version, memo, chain)?;
        dep_shas.push((dref.clone(), child_sha));
    }
    dep_shas.sort_by(|a, b| a.0.name.cmp(&b.0.name));

    chain.pop();

    let mut h = Sha256::new();
    h.update(b"wasm-posix-deps.v2\n");
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
/// Layout:
///   `<cache_root>/libs/<name>-<version>-rev<revision>-<arch>-<shortsha>/`
///
/// where shortsha is the first 8 hex chars of the cache-key sha —
/// matches the binaries-release convention. 32 bits of collision
/// resistance is enough for a per-user lib cache.
///
/// `arch` is part of the path so a single user can host wasm32 and
/// wasm64 builds of the same library side-by-side. The cache-key sha
/// already incorporates `arch` as of Task A.5, so the shortsha alone
/// disambiguates — but a visible arch segment makes the cache layout
/// self-explanatory at a glance.
pub fn canonical_path(
    cache_root: &Path,
    m: &DepsManifest,
    arch: TargetArch,
    sha: &[u8; 32],
) -> PathBuf {
    cache_root.join("libs").join(format!(
        "{}-{}-rev{}-{}-{}",
        m.name,
        m.version,
        m.revision,
        arch.as_str(),
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
    arch: TargetArch,
    abi_version: u32,
    opts: &ResolveOpts<'_>,
) -> Result<PathBuf, String> {
    let mut memo: BTreeMap<String, [u8; 32]> = BTreeMap::new();
    let mut building: Vec<String> = Vec::new();
    ensure_built_inner(
        target,
        registry,
        arch,
        abi_version,
        opts,
        &mut memo,
        &mut building,
    )
}

fn ensure_built_inner(
    target: &DepsManifest,
    registry: &Registry,
    arch: TargetArch,
    abi_version: u32,
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
        let dep_path =
            ensure_built_inner(&dep_m, registry, arch, abi_version, opts, memo, building)?;
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
    let sha = compute_sha(target, registry, arch, abi_version, memo, &mut chain)?;
    let canonical = canonical_path(opts.cache_root, target, arch, &sha);

    // Cache hit: trust it. Users invalidate by deleting the directory.
    if canonical.is_dir() {
        return Ok(canonical);
    }

    build_into_cache(target, arch, &canonical, &dep_dirs)?;
    Ok(canonical)
}

/// Run the build script with `WASM_POSIX_DEP_*` env vars set, validate
/// outputs under the temp directory, then `rename(2)` into place.
fn build_into_cache(
    target: &DepsManifest,
    arch: TargetArch,
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
        cmd.env("WASM_POSIX_DEP_TARGET_ARCH", arch.as_str());
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

    // autoconf / libtool bake `--prefix` (= $WASM_POSIX_DEP_OUT_DIR,
    // i.e. the temp dir) into generated `.pc` and `.la` files at
    // configure time. Rewrite those paths to the canonical location
    // *before* the rename so parallel readers never observe a
    // canonical cache entry with dead `prefix=<temp>` strings.
    if let Err(e) = rewrite_install_prefix_paths(&tmp, canonical) {
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
        let content = std::fs::read_to_string(&path)
            .map_err(|e| format!("read {}: {e}", path.display()))?;
        if !content.contains(needle) {
            continue;
        }
        let rewritten = content.replace(needle, replacement);
        std::fs::write(&path, rewritten)
            .map_err(|e| format!("write {}: {e}", path.display()))?;
    }
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
fn parse_target_arch(s: &str) -> Result<TargetArch, String> {
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
        Ok(s) => parse_target_arch(&s).map_err(|e| {
            format!("WASM_POSIX_DEFAULT_ARCH: {e}")
        }),
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
            let value = it.next().ok_or_else(|| {
                "--arch requires a value (wasm32 or wasm64)".to_string()
            })?;
            arch = Some(parse_target_arch(&value)?);
        } else {
            rest.push(a);
        }
    }
    Ok((arch, rest))
}

pub fn run(args: Vec<String>) -> Result<(), String> {
    let (arch_flag, rest) = extract_arch_flag(args)?;
    let arch = match arch_flag {
        Some(a) => a,
        None => default_target_arch()?,
    };

    let mut it = rest.into_iter();
    let sub = it.next().ok_or(
        "usage: xtask build-deps [--arch=wasm32|wasm64] <parse|sha|path|resolve> <name|path>",
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
        "sha" => cmd_sha(&manifest, &registry, arch),
        "path" => cmd_path(&manifest, &registry, arch),
        "resolve" => cmd_resolve(&manifest, &registry, &repo, arch),
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

fn cmd_resolve(
    m: &DepsManifest,
    registry: &Registry,
    repo: &Path,
    arch: TargetArch,
) -> Result<(), String> {
    let cache_root = default_cache_root();
    let local_libs = repo.join("local-libs");
    let opts = ResolveOpts {
        cache_root: &cache_root,
        local_libs: Some(&local_libs),
    };
    let path = ensure_built(m, registry, arch, current_abi_version(), &opts)?;
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
kind = "library"
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

    #[test]
    fn compute_sha_changes_when_revision_bumps() {
        let root = tempdir("sha-rev-bump");
        write(&root, "libX", "1.0.0", &[]);
        let reg = Registry {
            roots: vec![root.clone()],
        };
        let m1 = reg.load("libX").unwrap();
        let sha1 = compute_sha(
            &m1,
            &reg,
            TEST_ARCH,
            TEST_ABI,
            &mut BTreeMap::new(),
            &mut Vec::new(),
        )
        .unwrap();

        // Bump revision in-place by editing the file.
        let toml_path = root.join("libX/deps.toml");
        let text = std::fs::read_to_string(&toml_path).unwrap();
        let bumped = text.replace("revision = 1", "revision = 2");
        std::fs::write(&toml_path, bumped).unwrap();

        let m2 = reg.load("libX").unwrap();
        let sha2 = compute_sha(
            &m2,
            &reg,
            TEST_ARCH,
            TEST_ABI,
            &mut BTreeMap::new(),
            &mut Vec::new(),
        )
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
        let sha_before = compute_sha(
            &cons,
            &reg,
            TEST_ARCH,
            TEST_ABI,
            &mut BTreeMap::new(),
            &mut Vec::new(),
        )
        .unwrap();

        // Bump the dep's revision: consumer's sha must change.
        let dep_path = root.join("libDep/deps.toml");
        let text = std::fs::read_to_string(&dep_path).unwrap();
        std::fs::write(&dep_path, text.replace("revision = 1", "revision = 9"))
            .unwrap();

        let sha_after = compute_sha(
            &cons,
            &reg,
            TEST_ARCH,
            TEST_ABI,
            &mut BTreeMap::new(),
            &mut Vec::new(),
        )
        .unwrap();
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
kind = "library"
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

        let path = ensure_built(
            &m,
            &reg,
            TEST_ARCH,
            TEST_ABI,
            &resolve_opts(&cache, None),
        )
        .unwrap();
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

        let p1 = ensure_built(
            &m,
            &reg,
            TEST_ARCH,
            TEST_ABI,
            &resolve_opts(&cache, None),
        )
        .unwrap();
        let p2 = ensure_built(
            &m,
            &reg,
            TEST_ARCH,
            TEST_ABI,
            &resolve_opts(&cache, None),
        )
        .unwrap();
        assert_eq!(p1, p2);
        let runs = std::fs::read_to_string(root.join("counter")).unwrap();
        assert_eq!(
            runs.lines().count(),
            1,
            "cache hit must skip the build script"
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

        let err = ensure_built(
            &m,
            &reg,
            TEST_ARCH,
            TEST_ABI,
            &resolve_opts(&cache, None),
        )
        .unwrap_err();
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

        let err = ensure_built(
            &m,
            &reg,
            TEST_ARCH,
            TEST_ABI,
            &resolve_opts(&cache, None),
        )
        .unwrap_err();
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
        let bar_path = ensure_built(
            &bar,
            &reg,
            TEST_ARCH,
            TEST_ABI,
            &resolve_opts(&cache, None),
        )
        .unwrap();

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

        let canonical = ensure_built(
            &m,
            &reg,
            TEST_ARCH,
            TEST_ABI,
            &resolve_opts(&cache, None),
        )
        .unwrap();

        let pc = std::fs::read_to_string(canonical.join("lib/pkgconfig/libPc.pc"))
            .unwrap();
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

        let canonical = ensure_built(
            &m,
            &reg,
            TEST_ARCH,
            TEST_ABI,
            &resolve_opts(&cache, None),
        )
        .unwrap();

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

        let canonical = ensure_built(
            &m,
            &reg,
            TEST_ARCH,
            TEST_ABI,
            &resolve_opts(&cache, None),
        )
        .unwrap();

        let real =
            std::fs::read_to_string(canonical.join("lib/pkgconfig/libSym1.pc"))
                .unwrap();
        assert!(
            real.contains(&format!("prefix={}", canonical.display())),
            "real .pc file must have canonical prefix; got:\n{real}"
        );
        assert!(!real.contains(".tmp-"));

        // Reading via the symlink produces the same (rewritten) text.
        let via_link =
            std::fs::read_to_string(canonical.join("lib/pkgconfig/libSym.pc"))
                .unwrap();
        assert_eq!(real, via_link);

        // The symlink is still a symlink — we didn't overwrite it
        // with a regular file during the rewrite.
        let meta = std::fs::symlink_metadata(
            canonical.join("lib/pkgconfig/libSym.pc"),
        )
        .unwrap();
        assert!(
            meta.file_type().is_symlink(),
            "pkgconfig symlink must survive as a symlink after rewrite"
        );
    }

    #[test]
    fn canonical_path_layout() {
        let root = tempdir("cache-path");
        write(&root, "zlib", "1.3.1", &[]);
        let reg = Registry {
            roots: vec![root],
        };
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
        // After A.6 the path includes the arch segment between revN and shortsha.
        assert!(
            name.starts_with("zlib-1.3.1-rev1-wasm32-"),
            "got {name}"
        );
        // 8-char short sha appended after the last dash.
        let short = name.rsplit('-').next().unwrap();
        assert_eq!(short.len(), 8);
        assert!(short.chars().all(|c| c.is_ascii_hexdigit()));
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
        assert_eq!(
            parse_target_arch("wasm32").unwrap(),
            TargetArch::Wasm32
        );
        assert_eq!(
            parse_target_arch("wasm64").unwrap(),
            TargetArch::Wasm64
        );
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
}
