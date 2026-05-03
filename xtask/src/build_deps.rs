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
//!   parse    <name|path>   Load + validate a deps.toml, print it back
//!                          normalised.
//!   sha      <name>        Print the cache-key sha (transitive).
//!   path     <name>        Print the canonical cache path.
//!   resolve  <name>        Ensure the lib is built, print its path.

use std::collections::{BTreeMap, BTreeSet};
use std::os::fd::AsFd;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};

use sha2::{Digest, Sha256};

use crate::deps_manifest::{DepRef, DepsManifest, HostTool, ManifestKind, TargetArch};
use crate::host_tool_probe::{self, ProbeFailure};
use crate::remote_fetch;
use crate::repo_root;
use crate::source_extract;

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

    /// Walk every registry root non-recursively (one level deep —
    /// `<root>/<name>/deps.toml`); load each manifest. Returns
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
                let toml = path.join("deps.toml");
                if !toml.is_file() {
                    continue;
                }
                let m = DepsManifest::load(&toml)
                    .map_err(|e| format!("{}: {e}", toml.display()))?;
                // First-root-wins, mirrors `find()`.
                out.entry(m.name.clone()).or_insert(m);
            }
        }
        Ok(out.into_iter().collect())
    }
}

/// Subset of [`Registry::walk_all`] containing only `kind = "program"`
/// manifests. Used by `bundle-program` and `build-manifest` to look
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
///   `source.url`, `source.sha256`, then for each dep (sorted by
///   name): `dep.name`, `dep.version`, hex(dep_sha).
///
/// Source kind (raw upstream archive, arch- and ABI-agnostic):
///   domain `"wasm-posix-pkg-source\n"`, then
///   `name`, `version`, `revision`, `source.url`, `source.sha256`,
///   then the same per-dep tail. `target_arch` and `abi_version` are
///   intentionally omitted — a source tarball does not change when
///   the kernel ABI bumps or when we cross-compile for a new arch.
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
            // libs/headers/pkgconfig path) leaves cache_key_sha
            // unchanged — the resolver then serves a canonical
            // directory that doesn't match the new declaration and
            // stage_release packs broken archives. Bug discovered in
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
            h.update(b"program_outputs:\n");
            for out in &target.program_outputs {
                h.update(out.name.as_bytes());
                h.update(b"|");
                h.update(out.wasm.as_bytes());
                h.update(b"\n");
            }
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
    memo.insert(target.spec(), out);
    Ok(out)
}

/// Canonical cache directory for a resolved manifest.
///
/// Layout:
///   libs/programs: `<cache_root>/libs/<name>-<version>-rev<revision>-<arch>-<shortsha>/`
///   sources:       `<cache_root>/sources/<name>-<version>-rev<revision>-<shortsha>/`
///
/// where shortsha is the first 8 hex chars of the cache-key sha —
/// matches the binaries-release convention. 32 bits of collision
/// resistance is enough for a per-user lib cache.
///
/// For libs and programs, `arch` is part of the path so a single user
/// can host wasm32 and wasm64 builds of the same artifact side-by-side.
/// The cache-key sha already incorporates `arch` as of Task A.5, so the
/// shortsha alone disambiguates — but a visible arch segment makes the
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
        ManifestKind::Source => format!(
            "{}-{}-rev{}-{}",
            m.name,
            m.version,
            m.revision,
            &hex(sha)[..8]
        ),
        ManifestKind::Library | ManifestKind::Program => format!(
            "{}-{}-rev{}-{}-{}",
            m.name,
            m.version,
            m.revision,
            arch.as_str(),
            &hex(sha)[..8]
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
    /// The single-process resolver assumes no concurrent peers during
    /// a force rebuild — see `build_into_cache`'s atomic-install comment.
    pub force_source_build: Option<&'a BTreeSet<String>>,
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

/// Process-lifetime memo of `(name, arch) → ensure_built_uncached`'s
/// result. Within a single `xtask` invocation (e.g. one
/// `stage-release` run), a manifest reached transitively via multiple
/// dependents (mariadb is reached 6× during a force-rebuild-all:
/// directly + via lamp + via mariadb-test + via mariadb-vfs ×2)
/// otherwise re-runs its full source build N times — ~80 minutes of
/// pointless work for mariadb alone. The memo collapses that to one
/// build per `(name, arch)`.
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
/// * `was_force_rebuild` — `force_source_build` bypasses the
///   on-disk cache. Memoizing across the force-rebuild boundary
///   would mean a no-force result satisfies a later force request,
///   defeating the bypass intent. Keep them as separate slots so
///   a force-call after a no-force-call still rebuilds. In
///   stage-release's force-rebuild-all loop every call has the
///   same flag, so the memo collapses N calls per (name, arch)
///   into 1 build — the actual optimization we wanted.
type BuildMemoKey = (PathBuf, String, TargetArch, bool);
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
    // requested multiple times within one stage-release run via
    // different dep chains. Without this, mariadb wasm32 source-builds
    // 4 times in a single force-rebuild-all (lamp, mariadb,
    // mariadb-test, mariadb-vfs each independently demand it). See
    // `build_memo`'s doc comment for full rationale.
    let was_force_rebuild = opts
        .force_source_build
        .map(|s| s.contains(&target.name))
        .unwrap_or(false);
    let memo_key: BuildMemoKey = (
        opts.cache_root.to_path_buf(),
        target.name.clone(),
        arch,
        was_force_rebuild,
    );
    {
        let cache = build_memo().lock().unwrap();
        if let Some(cached) = cache.get(&memo_key) {
            return cached.clone();
        }
    }

    let result = ensure_built_uncached(
        target, registry, arch, abi_version, opts, memo, building,
    );

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
        let (dep_path, dep_transitive) = ensure_built_inner(
            &dep_m,
            registry,
            arch,
            abi_version,
            opts,
            memo,
            building,
        )?;
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

    let force_rebuild = opts
        .force_source_build
        .map(|s| s.contains(&target.name))
        .unwrap_or(false);

    // Cache hit: trust it. Users invalidate by deleting the directory.
    // `force_source_build` skips this so the build script always runs;
    // we additionally wipe `canonical` below so `build_into_cache`'s
    // atomic-install doesn't discard the fresh tmp dir as a same-input
    // duplicate.
    if !force_rebuild && canonical.is_dir() {
        return Ok((canonical, transitive));
    }
    if force_rebuild && canonical.is_dir() {
        std::fs::remove_dir_all(&canonical)
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
    //   (Library | Program,_) — try `[binary]` remote fetch first,
    //                        then fall back to the build script.
    match (target.kind, target.build.script.is_some()) {
        (ManifestKind::Source, false) => {
            let parent = canonical
                .parent()
                .ok_or_else(|| {
                    format!("canonical path has no parent: {}", canonical.display())
                })?;
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
            if let Err(e) = source_extract::fetch_and_extract(
                &target.source.url,
                &target.source.sha256,
                &tmp,
            ) {
                let _ = std::fs::remove_dir_all(&tmp);
                return Err(format!(
                    "{}: source fetch+extract failed: {e}",
                    target.spec()
                ));
            }
            // Race against a peer process that finished its own extract
            // first: keep theirs, drop ours. Identical inputs produce
            // identical outputs.
            if canonical.exists() {
                let _ = std::fs::remove_dir_all(&tmp);
                return Ok((canonical, transitive));
            }
            std::fs::rename(&tmp, &canonical).map_err(|e| {
                format!(
                    "rename {} -> {}: {e}",
                    tmp.display(),
                    canonical.display()
                )
            })?;
            Ok((canonical, transitive))
        }
        (ManifestKind::Source, true) => {
            // Override path: run the script. No remote-binary fetch for
            // sources (`[binary]` is rejected at parse time for source
            // kind), so we go straight to `build_into_cache`.
            let pkgconfig_path = compose_pkgconfig_path(&transitive);
            build_into_cache(target, arch, &canonical, &dep_dirs, &pkgconfig_path)?;
            Ok((canonical, transitive))
        }
        (ManifestKind::Library | ManifestKind::Program, _) => {
            // Resolution priority 3: remote fetch from
            // `[binary].archive_url`. The 4-step verification (archive
            // sha, target_arch, abi_versions, cache_key_sha) lives in
            // `remote_fetch::fetch_and_install`. Any failure logs and
            // falls through to the source build below; a remote-fetch
            // error should never cause the resolver to refuse to
            // produce an artifact.
            //
            // `force_rebuild` short-circuits remote fetch — re-installing
            // the same archive_url would defeat the whole point of the
            // force flag (the workflow opted in because it suspects the
            // existing archive is stale). Falls through to source build.
            if !force_rebuild && let Some(binary) = target.binary.get(&arch) {
                let cache_key_sha_hex = hex(&sha);
                match remote_fetch::fetch_and_install(
                    binary,
                    &canonical,
                    target,
                    arch,
                    abi_version,
                    &cache_key_sha_hex,
                ) {
                    Ok(()) => return Ok((canonical, transitive)),
                    Err(e) => {
                        eprintln!(
                            "warning: remote fetch for {} from {} failed ({}); falling back to source build",
                            target.spec(),
                            binary.archive_url,
                            e,
                        );
                    }
                }
            }

            let pkgconfig_path = compose_pkgconfig_path(&transitive);
            build_into_cache(target, arch, &canonical, &dep_dirs, &pkgconfig_path)?;
            Ok((canonical, transitive))
        }
    }
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
    canonical: &Path,
    dep_dirs: &BTreeMap<String, DirectDep>,
    pkgconfig_path: &str,
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
    // declared outputs list (libs/headers/pkgconfig or program wasms)
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
    match target.kind {
        ManifestKind::Library => {
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
        }
        ManifestKind::Program => {
            for out in &target.program_outputs {
                let p = out_dir.join(&out.wasm);
                if !p.exists() {
                    return Err(format!(
                        "{}: declared wasm output {:?} not produced by build script",
                        target.spec(),
                        out.wasm
                    ));
                }
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
    let mut iter = std::fs::read_dir(out_dir)
        .map_err(|e| format!("read_dir {}: {e}", out_dir.display()))?;
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
        "usage: xtask build-deps [--arch=wasm32|wasm64] <parse|sha|path|resolve|check> [<name|path>]",
    )?;
    let target = it.next();
    if it.next().is_some() {
        return Err(format!("build-deps {sub}: unexpected extra args"));
    }

    let repo = repo_root();
    let registry = Registry::from_env(&repo);

    match sub.as_str() {
        "check" => {
            if target.is_some() {
                return Err("build-deps check: takes no arguments".into());
            }
            cmd_check(&registry)
        }
        _ => {
            let target = target.ok_or_else(|| {
                format!("build-deps {sub}: missing <name|path>")
            })?;
            // `target` is either a path to a deps.toml (contains '/'
            // or ends with .toml) or a bare name to look up in the
            // registry.
            let manifest = load_target(&target, &registry)?;
            match sub.as_str() {
                "parse" => cmd_parse(&manifest),
                "sha" => cmd_sha(&manifest, &registry, arch),
                "path" => cmd_path(&manifest, &registry, arch),
                "resolve" => cmd_resolve(&manifest, &registry, &repo, arch),
                other => Err(format!("build-deps: unknown subcommand {other:?}")),
            }
        }
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
        force_source_build: None,
    };
    let path = ensure_built(m, registry, arch, current_abi_version(), &opts)?;
    println!("{}", path.display());
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

    // --- outputs-folding cache-key tests ---
    //
    // These pin the cache_key_sha contract that changing any declared
    // output (library lib/header/pkgconfig path or program output's
    // name/wasm) must invalidate the cache key. Without this, a build
    // can be served from a canonical cache directory whose contents
    // don't match the current `[outputs]` / `[[outputs]]` declaration —
    // which is exactly how PR #384 shipped broken archives for
    // lamp/mariadb-vfs (see the bug report on this branch).

    /// Write a `kind = "program"` deps.toml with a custom `[[outputs]]`
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
revision = 1
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
        fs::write(prog_dir.join("deps.toml"), text).unwrap();
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
    /// old filename, and stage_release silently packed broken archives.
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
        let toml_path = root.join("lamp/deps.toml");
        let text = std::fs::read_to_string(&toml_path).unwrap();
        std::fs::write(&toml_path, text.replace("lamp.vfs", "lamp.vfs.zst"))
            .unwrap();
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

        let toml_path = root.join("tool/deps.toml");
        let text = std::fs::read_to_string(&toml_path).unwrap();
        std::fs::write(&toml_path, text.replace("name = \"tool\"\nwasm", "name = \"tool-renamed\"\nwasm"))
            .unwrap();
        let sha_after = sha_of(&reg, "tool");

        assert_ne!(
            sha_before, sha_after,
            "renaming a program output's logical name must invalidate the cache key"
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
        let toml_path = root.join("git/deps.toml");
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

    /// Pins behavior: program outputs are hashed in declaration order.
    /// Re-ordering DOES change cache_key_sha. We deliberately don't
    /// normalize because (a) the manifest preserves authored order
    /// (`Vec<ProgramOutput>`) and (b) consumers of `program_outputs`
    /// (e.g. `mirror_program_outputs` in install_release) iterate in
    /// the same order, so the cache key tracks what consumers see.
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
        let toml_path = root.join("git/deps.toml");
        std::fs::write(
            &toml_path,
            std::fs::read_to_string(&toml_path)
                .unwrap()
                .replace(
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

        let toml_path = root.join("libZ/deps.toml");
        let text = std::fs::read_to_string(&toml_path).unwrap();
        std::fs::write(&toml_path, text.replace("lib/liblibZ.a", "lib/liblibZ-renamed.a"))
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

        let toml_path = root.join("libZ/deps.toml");
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

        let toml_path = root.join("libZ/deps.toml");
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
            force_source_build: None,
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
    fn source_kind_canonical_path_omits_arch() {
        let dir = tempdir("source-canonical");
        let m = parse_source_manifest(&dir);
        let sha = [0u8; 32];
        let cache = PathBuf::from("/cache");
        let path = canonical_path(&cache, &m, TargetArch::Wasm32, &sha);
        assert_eq!(
            path,
            PathBuf::from("/cache/sources/pcre2-source-10.42-rev1-00000000")
        );
    }

    fn parse_source_manifest(dir: &Path) -> DepsManifest {
        let text = r#"
kind = "source"
name = "pcre2-source"
version = "10.42"
revision = 1

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
        ensure_built(
            &m,
            &reg,
            TEST_ARCH,
            TEST_ABI,
            &resolve_opts(&cache, None),
        )
        .unwrap();
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
        ensure_built(
            &m,
            &reg,
            TEST_ARCH,
            TEST_ABI,
            &resolve_opts(&cache, None),
        )
        .unwrap();
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

    /// Build a deps.toml / build script pair for remote-fetch tests.
    /// Declared output is `lib/out.a` (kept simple — the prefix-less
    /// name avoids the double-`lib` confusion, and is the same string
    /// the test archive uses). The build script also drops a sentinel
    /// `via-build` file, used by fall-through tests to detect that the
    /// source build ran rather than the remote fetch.
    fn write_lib_with_binary(
        root: &Path,
        name: &str,
        archive_path: &Path,
        archive_sha: &str,
    ) {
        let lib_dir = root.join(name);
        std::fs::create_dir_all(&lib_dir).unwrap();

        let archive_url = format!("file://{}", archive_path.display());
        let deps_toml = format!(
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

[binary]
archive_url = "{archive_url}"
archive_sha256 = "{archive_sha}"
"#,
            ""
        );
        std::fs::write(lib_dir.join("deps.toml"), deps_toml).unwrap();

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

    /// Build the archived `manifest.toml` text for a library named
    /// `name`. `arch` and `abi_versions` and `cache_key_sha` populate
    /// the `[compatibility]` block. Output declaration is `lib/out.a`
    /// to match `write_lib_with_binary`.
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

    #[test]
    fn remote_fetch_installs_archive_when_sha_arch_abi_cachekey_all_match() {
        let root = tempdir("rf-happy-reg");
        let cache = tempdir("rf-happy-cache");
        let archive_dir = tempdir("rf-happy-archive");

        // Compute the cache_key_sha the resolver would produce for our
        // (fixed-shape) deps.toml. We don't have the deps.toml on disk
        // yet; build a throwaway and parse it through the registry.
        // Note: adding a [binary] block does NOT change cache_key_sha
        // (only name/version/revision/source/arch/abi/dep-shas are
        // hashed) — so the value computed here matches the value
        // computed for the real lib below.
        let throwaway_root = tempdir("rf-happy-pre");
        write_lib(
            &throwaway_root,
            "libRf",
            "1.0.0",
            &[],
            "true",
            "[outputs]\nlibs = [\"lib/out.a\"]\n",
        );
        let pre_reg = Registry { roots: vec![throwaway_root.clone()] };
        let pre_m = pre_reg.load("libRf").unwrap();
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

        // Build the archive with matching arch / abi / cache_key.
        let manifest_text = archived_manifest_text(
            "libRf",
            "wasm32",
            &[TEST_ABI],
            &cache_key_hex,
        );
        let archive_bytes = crate::remote_fetch::build_test_archive(
            &manifest_text,
            &[("lib/out.a", b"\x00\x01\x02FAKE")],
        );
        let archive_sha_hex = sha256_hex(&archive_bytes);
        let archive_path = archive_dir.join("libRf-1.0.0.tar.zst");
        std::fs::write(&archive_path, &archive_bytes).unwrap();

        // Real consumer manifest with [binary] pointing at file://.
        write_lib_with_binary(&root, "libRf", &archive_path, &archive_sha_hex);

        let reg = Registry { roots: vec![root] };
        let m = reg.load("libRf").unwrap();

        let path = ensure_built(
            &m,
            &reg,
            TEST_ARCH,
            TEST_ABI,
            &resolve_opts(&cache, None),
        )
        .unwrap();

        // Artifact installed at the canonical cache path with the
        // archive's contents.
        assert!(path.starts_with(cache.join("libs")));
        let lib_bytes = std::fs::read(path.join("lib/out.a")).unwrap();
        assert_eq!(lib_bytes, b"\x00\x01\x02FAKE");
        // Build script did NOT run (no `via-build` sentinel).
        assert!(
            !path.join("via-build").exists(),
            "remote fetch should bypass the source build"
        );
        // Manifest + artifacts dir were stripped during reshape.
        assert!(!path.join("manifest.toml").exists());
        assert!(!path.join("artifacts").exists());
    }

    #[test]
    fn remote_fetch_falls_through_on_archive_sha_mismatch() {
        let root = tempdir("rf-shafail-reg");
        let cache = tempdir("rf-shafail-cache");
        let archive_dir = tempdir("rf-shafail-archive");

        // Build a real archive but advertise the WRONG sha in deps.toml.
        let manifest_text = archived_manifest_text(
            "libRfSha",
            "wasm32",
            &[TEST_ABI],
            // cache_key_sha is irrelevant: we never get past the sha
            // check. Fill with a valid-shaped dummy so parse_archived
            // wouldn't complain (defence in depth).
            &"a".repeat(64),
        );
        let archive_bytes = crate::remote_fetch::build_test_archive(
            &manifest_text,
            &[("lib/out.a", b"REMOTE")],
        );
        let archive_path = archive_dir.join("libRfSha-1.0.0.tar.zst");
        std::fs::write(&archive_path, &archive_bytes).unwrap();
        let bogus_sha = "0".repeat(64);

        write_lib_with_binary(&root, "libRfSha", &archive_path, &bogus_sha);

        let reg = Registry { roots: vec![root] };
        let m = reg.load("libRfSha").unwrap();
        let path = ensure_built(
            &m,
            &reg,
            TEST_ARCH,
            TEST_ABI,
            &resolve_opts(&cache, None),
        )
        .unwrap();

        // Source build ran (sentinel exists; lib content matches the
        // build script's output, not the archive's).
        assert!(
            path.join("via-build").exists(),
            "sha mismatch must fall through to source build"
        );
        let lib = std::fs::read(path.join("lib/out.a")).unwrap();
        assert_ne!(lib, b"REMOTE", "remote bytes must not have been installed");
    }

    #[test]
    fn remote_fetch_falls_through_on_target_arch_mismatch() {
        let root = tempdir("rf-archfail-reg");
        let cache = tempdir("rf-archfail-cache");
        let archive_dir = tempdir("rf-archfail-archive");

        // Archive declares wasm64 — resolver passes wasm32 (TEST_ARCH).
        let manifest_text = archived_manifest_text(
            "libRfArch",
            "wasm64",
            &[TEST_ABI],
            &"a".repeat(64),
        );
        let archive_bytes = crate::remote_fetch::build_test_archive(
            &manifest_text,
            &[("lib/out.a", b"REMOTE")],
        );
        let archive_sha = sha256_hex(&archive_bytes);
        let archive_path = archive_dir.join("libRfArch-1.0.0.tar.zst");
        std::fs::write(&archive_path, &archive_bytes).unwrap();

        write_lib_with_binary(&root, "libRfArch", &archive_path, &archive_sha);

        let reg = Registry { roots: vec![root] };
        let m = reg.load("libRfArch").unwrap();
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
    fn remote_fetch_falls_through_on_abi_mismatch() {
        let root = tempdir("rf-abifail-reg");
        let cache = tempdir("rf-abifail-cache");
        let archive_dir = tempdir("rf-abifail-archive");

        // Archive supports only ABI 999 — resolver passes TEST_ABI (=4).
        let manifest_text = archived_manifest_text(
            "libRfAbi",
            "wasm32",
            &[999],
            &"a".repeat(64),
        );
        let archive_bytes = crate::remote_fetch::build_test_archive(
            &manifest_text,
            &[("lib/out.a", b"REMOTE")],
        );
        let archive_sha = sha256_hex(&archive_bytes);
        let archive_path = archive_dir.join("libRfAbi-1.0.0.tar.zst");
        std::fs::write(&archive_path, &archive_bytes).unwrap();

        write_lib_with_binary(&root, "libRfAbi", &archive_path, &archive_sha);

        let reg = Registry { roots: vec![root] };
        let m = reg.load("libRfAbi").unwrap();
        let path = ensure_built(
            &m,
            &reg,
            TEST_ARCH,
            TEST_ABI, // 4, not in [999]
            &resolve_opts(&cache, None),
        )
        .unwrap();

        assert!(
            path.join("via-build").exists(),
            "abi mismatch must fall through to source build"
        );
    }

    #[test]
    fn remote_fetch_falls_through_on_cache_key_mismatch() {
        let root = tempdir("rf-ckfail-reg");
        let cache = tempdir("rf-ckfail-cache");
        let archive_dir = tempdir("rf-ckfail-archive");

        // Archive declares a wrong cache_key_sha (well-formed but
        // never produced by compute_sha for this manifest).
        let wrong_ck = "f".repeat(64);
        let manifest_text = archived_manifest_text(
            "libRfCk",
            "wasm32",
            &[TEST_ABI],
            &wrong_ck,
        );
        let archive_bytes = crate::remote_fetch::build_test_archive(
            &manifest_text,
            &[("lib/out.a", b"REMOTE")],
        );
        let archive_sha = sha256_hex(&archive_bytes);
        let archive_path = archive_dir.join("libRfCk-1.0.0.tar.zst");
        std::fs::write(&archive_path, &archive_bytes).unwrap();

        write_lib_with_binary(&root, "libRfCk", &archive_path, &archive_sha);

        let reg = Registry { roots: vec![root] };
        let m = reg.load("libRfCk").unwrap();
        let path = ensure_built(
            &m,
            &reg,
            TEST_ARCH,
            TEST_ABI,
            &resolve_opts(&cache, None),
        )
        .unwrap();

        assert!(
            path.join("via-build").exists(),
            "cache_key_sha mismatch must fall through to source build"
        );
    }

    // --- kind = "program" resolver tests (Task B.2) ---

    /// Create a `kind = "program"` deps.toml + build-<name>.sh pair.
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
            outputs_toml.push_str(&format!(
                "[[outputs]]\nname = \"{n}\"\nwasm = \"{w}\"\n\n"
            ));
        }
        fs::write(
            dir.join("deps.toml"),
            format!(
                r#"kind = "program"
name = "{name}"
version = "{version}"
revision = 1
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

    #[test]
    fn canonical_path_uses_programs_subdir_for_program_kind() {
        let m = DepsManifest::parse(
            r#"kind = "program"
name = "vim"
version = "9.1.0900"
revision = 1
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
            r#"mkdir -p "$WASM_POSIX_DEP_OUT_DIR" && touch "$WASM_POSIX_DEP_OUT_DIR/tinyprog.wasm""#,
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
        let err = ensure_built(&m, &reg, TargetArch::Wasm32, 4, &resolve_opts(&cache, None))
            .unwrap_err();
        assert!(err.contains("miss.wasm"), "got: {err}");
    }

    #[test]
    fn walk_all_finds_libraries_and_programs() {
        let root = tempdir("walk-all");
        write_lib(&root, "libL", "1.0.0", &[], "true", "[outputs]\nlibs = [\"lib/libL.a\"]\n");
        write_program(&root, "progP", "0.1.0", &[], "true", &[("progP", "progP.wasm")]);
        let reg = Registry { roots: vec![root] };
        let all = reg.walk_all().unwrap();
        let names: Vec<_> = all.iter().map(|(n, _)| n.clone()).collect();
        assert_eq!(names, vec!["libL".to_string(), "progP".to_string()]);
    }

    #[test]
    fn programs_by_name_filters_to_program_kind() {
        let root = tempdir("progs-by-name");
        write_lib(&root, "libL", "1.0.0", &[], "true", "[outputs]\nlibs = [\"lib/libL.a\"]\n");
        write_program(&root, "progP", "0.1.0", &[], "true", &[("progP", "progP.wasm")]);
        let reg = Registry { roots: vec![root] };
        let progs = programs_by_name(&reg).unwrap();
        assert_eq!(progs.len(), 1);
        assert!(progs.contains_key("progP"));
    }

    #[test]
    fn walk_all_handles_missing_registry_root() {
        // A registry root that doesn't exist must not error; just contribute nothing.
        let reg = Registry { roots: vec![PathBuf::from("/this/path/does/not/exist/xtask-walk-all")] };
        let all = reg.walk_all().unwrap();
        assert!(all.is_empty());
    }

    #[test]
    fn walk_all_first_root_wins_for_duplicate_names() {
        // Two roots both define "libZ"; first one wins.
        let root_a = tempdir("walk-first");
        let root_b = tempdir("walk-second");
        write_lib(&root_a, "libZ", "1.0.0", &[], "true", "[outputs]\nlibs = [\"lib/libZ.a\"]\n");
        write_lib(&root_b, "libZ", "9.9.9", &[], "true", "[outputs]\nlibs = [\"lib/libZ.a\"]\n");
        let reg = Registry { roots: vec![root_a, root_b] };
        let all = reg.walk_all().unwrap();
        let (_, m) = all.iter().find(|(n, _)| n == "libZ").unwrap();
        assert_eq!(m.version, "1.0.0", "first root should win, got version {}", m.version);
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
revision = 1

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
    /// declares no `[build].script` resolves by fetching its archive
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
            let enc = flate2::write::GzEncoder::new(
                &mut tar_bytes,
                flate2::Compression::default(),
            );
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
revision = 1

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

    /// C.5: source-kind manifest with `[build].script` runs the script
    /// through `build_into_cache` and atomically installs the populated
    /// OUT_DIR under `<cache>/sources/...`. The script gets the same
    /// env-var contract as lib/program builds (OUT_DIR + NAME +
    /// VERSION + ...), so a marker file written via
    /// `$WASM_POSIX_DEP_OUT_DIR/marker` lands in the canonical path.
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
revision = 1

[source]
url = "https://example.test/unused"
sha256 = "0000000000000000000000000000000000000000000000000000000000000000"

[license]
spdx = "BSD-3-Clause"

[build]
script = "custom.sh"
"#;
        let m = DepsManifest::parse(manifest_text, manifest_dir).unwrap();

        let registry = Registry { roots: vec![] };
        let path = ensure_built(
            &m,
            &registry,
            TEST_ARCH,
            TEST_ABI,
            &resolve_opts(&cache, None),
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
revision = 1

[source]
url = "https://example.test/unused"
sha256 = "0000000000000000000000000000000000000000000000000000000000000000"

[license]
spdx = "BSD-3-Clause"

[build]
script = "noop.sh"
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
            std::fs::set_permissions(&foo_script, std::fs::Permissions::from_mode(0o755))
                .unwrap();
        }
        std::fs::write(
            foo_dir.join("deps.toml"),
            r#"
kind = "source"
name = "foo-source"
version = "1.0"
revision = 1

[source]
url = "https://example.test/unused"
sha256 = "0000000000000000000000000000000000000000000000000000000000000000"

[license]
spdx = "TestLicense"

[build]
script = "custom.sh"
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

        let reg = Registry { roots: vec![root] };
        let consumer = reg.load("consumer").unwrap();
        let consumer_path = ensure_built(
            &consumer,
            &reg,
            TEST_ARCH,
            TEST_ABI,
            &resolve_opts(&cache, None),
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
revision = 1

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

        let path = ensure_built(&m, &registry, TEST_ARCH, TEST_ABI, &resolve_opts(&cache, None))
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
revision = 1

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
        let err = ensure_built(&m, &registry, TEST_ARCH, TEST_ABI, &resolve_opts(&cache, None))
            .unwrap_err();
        assert!(err.contains("host-tool"), "got: {err}");
        assert!(
            err.contains("this-host-tool-does-not-exist"),
            "got: {err}"
        );
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
revision = 1

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

    /// Helper for C.11 tests: write a minimal library deps.toml that
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
revision = 1

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
        fs::write(dir.join("deps.toml"), text).unwrap();
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
        let err = cmd_check(&registry)
            .expect_err("mismatched version_constraints should fail");
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
        let reg = Registry { roots: vec![root.clone()] };
        let m = reg.load("libF1").unwrap();

        // First call — cache miss, script runs.
        let p1 = ensure_built(
            &m,
            &reg,
            TEST_ARCH,
            TEST_ABI,
            &resolve_opts(&cache, None),
        )
        .unwrap();

        // Second call WITHOUT force — cache hit, script does not run.
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
        assert_eq!(runs.lines().count(), 1, "without force, cache hit must skip script");

        // Third call WITH force — script runs again despite cache hit.
        let mut force = BTreeSet::new();
        force.insert("libF1".to_string());
        let opts = ResolveOpts {
            cache_root: &cache,
            local_libs: None,
            force_source_build: Some(&force),
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
    fn force_rebuild_bypasses_remote_fetch() {
        // Stage a real archive on disk and point [binary].archive_url at
        // it. Without force, the resolver installs from the archive and
        // the source build's `via-build` sentinel does NOT appear. With
        // force, the resolver skips remote fetch and source-builds — the
        // sentinel DOES appear.
        let root = tempdir("force-rf-reg");
        let cache = tempdir("force-rf-cache");
        let archive_dir = tempdir("force-rf-archive");

        // Compute cache_key_sha for the lib (matches write_lib_with_binary's shape).
        let throwaway_root = tempdir("force-rf-pre");
        write_lib(
            &throwaway_root,
            "libF2",
            "1.0.0",
            &[],
            "true",
            "[outputs]\nlibs = [\"lib/out.a\"]\n",
        );
        let pre_reg = Registry { roots: vec![throwaway_root.clone()] };
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

        // Build a remote archive whose contents differ from the source build,
        // so we can tell which path produced the artifact.
        let manifest_text =
            archived_manifest_text("libF2", "wasm32", &[TEST_ABI], &cache_key_hex);
        let archive_bytes = crate::remote_fetch::build_test_archive(
            &manifest_text,
            &[("lib/out.a", b"REMOTE-ARCHIVE")],
        );
        let archive_sha_hex = sha256_hex(&archive_bytes);
        let archive_path = archive_dir.join("libF2-1.0.0.tar.zst");
        std::fs::write(&archive_path, &archive_bytes).unwrap();

        // The real consumer lib advertises that archive.
        write_lib_with_binary(&root, "libF2", &archive_path, &archive_sha_hex);
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
        };
        let path = ensure_built(&m, &reg, TEST_ARCH, TEST_ABI, &opts).unwrap();
        assert!(
            path.join("via-build").exists(),
            "force-rebuild must source-build (sentinel missing at {})",
            path.display()
        );
        let lib_bytes = std::fs::read(path.join("lib/out.a")).unwrap();
        assert_eq!(
            lib_bytes,
            b"BUILD\n",
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
        let reg = Registry { roots: vec![root.clone()] };
        let ma = reg.load("libF3a").unwrap();
        let mb = reg.load("libF3b").unwrap();

        // Prime both caches.
        ensure_built(&ma, &reg, TEST_ARCH, TEST_ABI, &resolve_opts(&cache, None)).unwrap();
        ensure_built(&mb, &reg, TEST_ARCH, TEST_ABI, &resolve_opts(&cache, None)).unwrap();
        assert_eq!(
            std::fs::read_to_string(root.join("counter-a")).unwrap().lines().count(),
            1
        );
        assert_eq!(
            std::fs::read_to_string(root.join("counter-b")).unwrap().lines().count(),
            1
        );

        // Force only libF3a.
        let mut force = BTreeSet::new();
        force.insert("libF3a".to_string());
        let opts = ResolveOpts {
            cache_root: &cache,
            local_libs: None,
            force_source_build: Some(&force),
        };
        ensure_built(&ma, &reg, TEST_ARCH, TEST_ABI, &opts).unwrap();
        ensure_built(&mb, &reg, TEST_ARCH, TEST_ABI, &opts).unwrap();

        // libF3a re-ran (counter-a now has 2), libF3b stayed cached.
        assert_eq!(
            std::fs::read_to_string(root.join("counter-a")).unwrap().lines().count(),
            2,
            "named lib must re-run under force"
        );
        assert_eq!(
            std::fs::read_to_string(root.join("counter-b")).unwrap().lines().count(),
            1,
            "non-named lib must stay cached"
        );
    }
}
