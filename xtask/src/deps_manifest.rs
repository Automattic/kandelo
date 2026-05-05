//! Parser for `package.toml` — per-library build/cache manifest.
//!
//! Each wasm-posix-kernel library declares one of these next to its
//! build script (`examples/libs/<name>/package.toml`). The resolver
//! (`xtask build-deps`) walks these across a registry search path to
//! build an acyclic dependency graph, compute a deterministic cache
//! key per library, and produce or fetch the static `.a` artifacts.
//!
//! Schema (V1, minimal):
//!
//! ```toml
//! name = "zlib"
//! version = "1.3.1"
//! revision = 1
//! # TOML top-level arrays must come before any [section] header,
//! # otherwise they bind inside that section.
//! depends_on = []                 # ["zlib@1.3.1", "openssl@3.0.15"]
//!
//! [source]
//! url = "https://github.com/madler/zlib/releases/download/v1.3.1/zlib-1.3.1.tar.gz"
//! sha256 = "9a93b2b7dfdac77ceba5a558a580e74667dd6fede4585b91eefb60f03b72df23"
//!
//! [license]
//! spdx = "Zlib"
//! url = "https://github.com/madler/zlib/blob/v1.3.1/LICENSE"
//!
//! [build]
//! script = "build-zlib.sh"        # optional; default = "build-<name>.sh"
//!
//! [outputs]
//! libs = ["lib/libz.a"]
//! headers = ["include/zlib.h", "include/zconf.h"]
//! pkgconfig = ["lib/pkgconfig/zlib.pc"]   # optional
//! ```
//!
//! The cache-key sha for a library is computed over
//! `(name, version, revision, source.url, source.sha256, sorted transitive
//! dep cache-key shas)`. Identical inputs → identical cache path →
//! shared artifact. Changing any input invalidates downstream consumers
//! automatically.
//!
//! `revision` is the knob for "same upstream source, different build
//! flags" — bump when the build script or cross-compile config changes
//! in a way that affects the output.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use serde::Deserialize;

/// Discriminator for the kind of artifact a manifest produces.
///
/// Required at the top level of every `package.toml` (`kind = "library"`,
/// `kind = "program"`, or `kind = "source"`). Tagged-enum dispatch on
/// this value lands in subsequent commits; for now it's parsed and
/// stored unchanged.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ManifestKind {
    Library,
    Program,
    Source,
}

/// Target wasm architecture a built artifact is compatible with.
///
/// Closed enum — unknown values are rejected at parse time. Only
/// present in archived `manifest.toml` (under `[compatibility]`),
/// never in source `package.toml`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TargetArch {
    Wasm32,
    Wasm64,
}

impl TargetArch {
    /// Stable, kebab-case string form. Matches the serde `rename_all`
    /// representation: `Wasm32 → "wasm32"`, `Wasm64 → "wasm64"`.
    ///
    /// Used both as a hash input for cache-key derivation (A.5) and
    /// for CLI-flag parsing (A.6).
    pub fn as_str(self) -> &'static str {
        match self {
            TargetArch::Wasm32 => "wasm32",
            TargetArch::Wasm64 => "wasm64",
        }
    }
}

/// Build-time provenance + ABI compatibility data injected into an
/// archived `manifest.toml` at archive creation. Source `package.toml`
/// files MUST NOT contain this block; archived manifests MUST.
///
/// Used by the resolver's remote-fetch path (Task A.9) to reject
/// archives whose `target_arch` or `abi_versions` no longer match
/// the consumer's environment.
//
// `build_timestamp` and `build_host` are informational provenance
// fields surfaced into archived manifests but never directly consumed
// by the resolver — they're meant for human inspection of a cached
// artifact. Field-level allow(dead_code) here so the rest of the
// struct's fields (which ARE read by remote_fetch.rs) trigger normal
// dead-code analysis.
#[derive(Debug, Clone, Deserialize)]
pub struct Compatibility {
    pub target_arch: TargetArch,
    pub abi_versions: Vec<u32>,
    pub cache_key_sha: String,
    #[serde(default)]
    #[allow(dead_code)]
    pub build_timestamp: Option<String>,
    #[serde(default)]
    #[allow(dead_code)]
    pub build_host: Option<String>,
}

/// Optional remote-fetch pointer for a prebuilt archive of this
/// library. When present, the resolver consults it as the 4th
/// priority — after `local-libs/` override and the local cache,
/// before falling back to a source build (Task A.9).
///
/// Allowed in BOTH source `package.toml` (the canonical place — the URL
/// describes where the archive lives) and archived `manifest.toml`
/// (carried through unchanged; redundant but harmless).
///
/// `archive_url` is stored verbatim — not URL-validated at parse
/// time. `archive_sha256` is enforced as 64-char lowercase hex so
/// any download can be content-addressed without re-checking format
/// at fetch time.
#[derive(Debug, Clone, Deserialize)]
pub struct Binary {
    pub archive_url: String,
    pub archive_sha256: String,
}

/// One entry in a `kind = "program"` manifest's `[[outputs]]` array.
///
/// Each program declares one or more wasm artifacts. `name` is the
/// logical program name (the bundle key used by consumers like
/// `bundle-program` and the resolver); `wasm` is the path (relative
/// to the build's output prefix) of the wasm file that backs it.
#[derive(Debug, Clone, Deserialize)]
pub struct ProgramOutput {
    pub name: String,
    pub wasm: String,
}

/// One entry in a manifest's `[[host_tools]]` array. Inline
/// declaration on the consumer site — no separate registry entry,
/// per design 10.
///
/// Probe and install_hints are optional in TOML; the parser fills
/// in defaults so the rest of the resolver always sees a complete
/// `HostTool`.
///
/// `version_constraint` is parsed at package.toml load time into a
/// [`VersionConstraint`] newtype (C.8). Only `>=X.Y` and `>=X.Y.Z`
/// are accepted; other operators reject with a future-work error
/// linking design decision 11. The runner that actually invokes
/// `probe.args` and matches `version_regex` against the output
/// lives in [`crate::host_tool_probe::probe`] (C.9).
#[derive(Debug, Clone)]
pub struct HostTool {
    pub name: String,
    pub version_constraint: VersionConstraint,
    pub probe: HostToolProbe,
    pub install_hints: BTreeMap<String, String>,
}

/// A 2- or 3-component dotted-integer version. Stored separately
/// from a raw string so comparisons are numeric rather than
/// lexicographic (`3.20 > 3.9`, never `"3.20" < "3.9"`). `patch` is
/// `None` for `"X.Y"` inputs and `Some(n)` for `"X.Y.Z"`. When
/// comparing across forms a missing patch is treated as `0`.
///
/// V2 host-tool versions are pure dotted-integer; prerelease and
/// build suffixes (`-rc1`, `+build`) are rejected at parse time.
#[derive(Debug, Clone)]
pub struct Version {
    pub major: u32,
    pub minor: u32,
    pub patch: Option<u32>,
}

// `PartialEq`/`Eq` are hand-written (not derived) so they agree with
// the hand-written `Ord` below. Rust's contract requires
// `a.cmp(&b) == Equal` ⟺ `a == b`; the `Ord` impl normalizes
// `patch = None` to `0` (so `3.20` compares equal to `3.20.0`), so
// `PartialEq` must apply the same `unwrap_or(0)` normalization. A
// derived `PartialEq` would compare `Option<u32>` field-wise and
// disagree with `Ord`, which can silently corrupt `BTreeSet`/`BTreeMap`
// keys, `slice::sort_unstable`, and `Vec::dedup`.
impl PartialEq for Version {
    fn eq(&self, other: &Self) -> bool {
        self.major == other.major
            && self.minor == other.minor
            && self.patch.unwrap_or(0) == other.patch.unwrap_or(0)
    }
}
impl Eq for Version {}

impl Version {
    /// Parse a 2- or 3-component dotted-integer version. Rejects
    /// anything with prerelease or build suffixes.
    pub fn parse(s: &str) -> Result<Self, String> {
        if s.contains('-') || s.contains('+') {
            return Err(format!(
                "version {:?}: prerelease/build suffixes are not supported \
                 (V2 host-tools only accepts dotted-integer versions)",
                s
            ));
        }
        let parts: Vec<&str> = s.split('.').collect();
        if parts.len() < 2 || parts.len() > 3 {
            return Err(format!(
                "version {:?} must be X.Y or X.Y.Z (got {} components)",
                s,
                parts.len()
            ));
        }
        let major: u32 = parts[0]
            .parse()
            .map_err(|_| format!("version {:?}: major must be unsigned int", s))?;
        let minor: u32 = parts[1]
            .parse()
            .map_err(|_| format!("version {:?}: minor must be unsigned int", s))?;
        let patch = match parts.get(2) {
            Some(p) => Some(
                p.parse::<u32>()
                    .map_err(|_| format!("version {:?}: patch must be unsigned int", s))?,
            ),
            None => None,
        };
        Ok(Self {
            major,
            minor,
            patch,
        })
    }
}

impl std::fmt::Display for Version {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self.patch {
            Some(p) => write!(f, "{}.{}.{}", self.major, self.minor, p),
            None => write!(f, "{}.{}", self.major, self.minor),
        }
    }
}

// Hand-written ordering so a 2-component `"X.Y"` (patch = None)
// compares equal to `"X.Y.0"` rather than less-than (which is what
// `Option<u32>::None < Some(0)` would yield with a derived impl).
impl Ord for Version {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        let a = (self.major, self.minor, self.patch.unwrap_or(0));
        let b = (other.major, other.minor, other.patch.unwrap_or(0));
        a.cmp(&b)
    }
}

impl PartialOrd for Version {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

/// A parsed version constraint. V2 supports exactly one operator
/// (`>=`); other operators (`>`, `<`, `==`, `^`, `~`, `=`, bare
/// versions, compound `">=X.Y,<P.Q"`) reject at parse time with a
/// future-work error linking design decision 11.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VersionConstraint {
    pub min: Version,
}

impl VersionConstraint {
    /// Parse a `version_constraint` string. Only `>=X.Y` and
    /// `>=X.Y.Z` are accepted; everything else rejects with a
    /// future-work error message naming `tool_name` and the bad
    /// input.
    pub fn parse(s: &str, tool_name: &str) -> Result<Self, String> {
        let s = s.trim();
        if s.contains(',') {
            return Err(future_work_err(tool_name, s, "compound constraints"));
        }
        let rest = s
            .strip_prefix(">=")
            .ok_or_else(|| future_work_err(tool_name, s, "operator other than '>='"))?;
        // Reject any further operator/whitespace inside the version
        // portion. Note this rejection has to come BEFORE we try to
        // parse `rest` as a Version, because `Version::parse` would
        // accept e.g. `3.20<4.0` if the operator string ever leaked
        // through.
        if rest.starts_with(' ')
            || rest.contains(['<', '>', '=', '^', '~', ',', ' '])
        {
            return Err(future_work_err(tool_name, s, "operator after '>='"));
        }
        let min = Version::parse(rest)
            .map_err(|e| format!("[[host_tools]] {}: {}", tool_name, e))?;
        Ok(Self { min })
    }

    /// `actual` satisfies `self` iff `actual >= self.min`. The
    /// comparison treats a missing patch component as 0:
    /// `>=3.20` accepts `3.20.0`, `3.21`, `3.20.5` but rejects `3.19`.
    pub fn satisfies(&self, actual: &Version) -> bool {
        actual >= &self.min
    }
}

impl std::fmt::Display for VersionConstraint {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, ">={}", self.min)
    }
}

fn future_work_err(tool_name: &str, value: &str, kind: &str) -> String {
    format!(
        "unsupported version_constraint in [[host_tools]] {tool_name:?}: {value:?} \
         ({kind}; supported: >=X.Y or >=X.Y.Z — semver ranges and other \
         operators are deferred to future work; see \
         docs/plans/2026-04-22-deps-management-v2-design.md decision 11)"
    )
}

/// Probe definition for a host tool: how to invoke it and how to
/// extract a version string from its output.
///
/// Defaults (when omitted in TOML): `args = ["--version"]`,
/// `version_regex = r"(\d+\.\d+(?:\.\d+)?)"`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostToolProbe {
    pub args: Vec<String>,
    pub version_regex: String,
}

impl Default for HostToolProbe {
    fn default() -> Self {
        Self {
            args: vec!["--version".to_string()],
            version_regex: r"(\d+\.\d+(?:\.\d+)?)".to_string(),
        }
    }
}

#[derive(Debug, Deserialize)]
struct RawHostTool {
    name: String,
    version_constraint: String,
    #[serde(default)]
    probe: Option<RawHostToolProbe>,
    #[serde(default)]
    install_hints: Option<BTreeMap<String, String>>,
}

#[derive(Debug, Deserialize)]
struct RawHostToolProbe {
    args: Option<Vec<String>>,
    version_regex: Option<String>,
}

/// One fully-parsed `package.toml` file.
#[derive(Debug, Clone)]
pub struct DepsManifest {
    pub kind: ManifestKind,
    pub name: String,
    pub version: String,
    pub revision: u32,
    pub source: Source,
    pub license: License,
    pub depends_on: Vec<DepRef>,
    pub build: Build,
    pub outputs: Outputs,

    /// Outputs declared by `kind = "program"` manifests via
    /// `[[outputs]]` array-of-tables. Empty for `kind = "library"`
    /// (which uses [`outputs`](Self::outputs) instead) and for
    /// `kind = "source"`. Read by `canonical_path` and
    /// `validate_outputs` in the resolver (wired in Chunk B Task B.2).
    pub program_outputs: Vec<ProgramOutput>,

    /// Build-time provenance + ABI compatibility. Always `None` for
    /// manifests parsed via [`DepsManifest::parse`] (source `package.toml`)
    /// and always `Some` for those parsed via
    /// [`DepsManifest::parse_archived`] (archived `manifest.toml`).
    /// Consumed by `remote_fetch` to verify a downloaded archive's
    /// `target_arch`, `abi_versions`, and `cache_key_sha`.
    pub compatibility: Option<Compatibility>,

    /// Per-arch remote-fetch pointers (see [`Binary`]). Keyed by the
    /// arch the archive was built for. Empty when no `[binary]` block
    /// is present. Consumed by `build_deps`'s `ensure_built`, which
    /// looks up the requested arch and falls through to a source
    /// build if no entry exists for it.
    ///
    /// TOML accepts two equivalent shapes:
    ///   * Bare `[binary]` (single-arch — interpreted as wasm32):
    ///       [binary]
    ///       archive_url = "..."
    ///       archive_sha256 = "..."
    ///   * Per-arch tables (multi-arch):
    ///       [binary.wasm32]
    ///       archive_url = "..."
    ///       archive_sha256 = "..."
    ///       [binary.wasm64]
    ///       archive_url = "..."
    ///       archive_sha256 = "..."
    /// A manifest cannot mix both; the parser rejects mixed shapes.
    pub binary: BTreeMap<TargetArch, Binary>,

    /// Inline host-tool requirements (`[[host_tools]]` in TOML).
    /// Empty when none are declared. Allowed on every manifest kind
    /// (library / program / source). Consumed by `ensure_built`
    /// (probe runner) and `cmd_check` (host-tool consistency lint).
    pub host_tools: Vec<HostTool>,

    /// Target arches this manifest opts into. Read from the optional
    /// top-level `arches = ["wasm32", "wasm64"]` TOML field. Defaults
    /// to `["wasm32"]` when absent — wasm32 is the canonical target;
    /// only manifests that explicitly need wasm64 (right now: mariadb,
    /// mariadb-vfs, php) opt in. Consumed by `stage-release` to skip
    /// manifest×arch pairs the manifest didn't ask for, which keeps
    /// the release archive set tight.
    pub target_arches: Vec<TargetArch>,

    /// Directory containing this `package.toml`. The build script path and
    /// any per-dep build state live underneath it.
    pub dir: PathBuf,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Source {
    pub url: String,
    pub sha256: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct License {
    pub spdx: String,
    pub url: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Build {
    pub script: Option<String>,
}

impl Default for Build {
    fn default() -> Self {
        Self { script: None }
    }
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct Outputs {
    #[serde(default)]
    pub libs: Vec<String>,
    #[serde(default)]
    pub headers: Vec<String>,
    #[serde(default)]
    pub pkgconfig: Vec<String>,
}

/// `name@version` reference, parsed from `depends_on` strings.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct DepRef {
    pub name: String,
    pub version: String,
}

impl DepRef {
    pub fn parse(s: &str) -> Result<Self, String> {
        // Exact split on '@'. No version ranges in V1.
        let (name, version) = s.split_once('@').ok_or_else(|| {
            format!(
                "dep reference {:?} must be `<name>@<version>` \
                 (V1 supports exact versions only; no semver ranges)",
                s
            )
        })?;
        if name.is_empty() {
            return Err(format!("dep reference {:?} has empty name", s));
        }
        if version.is_empty() {
            return Err(format!("dep reference {:?} has empty version", s));
        }
        if name.contains('@') {
            return Err(format!("dep name {:?} must not contain '@'", name));
        }
        Ok(Self {
            name: name.into(),
            version: version.into(),
        })
    }
}

impl std::fmt::Display for DepRef {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}@{}", self.name, self.version)
    }
}

/// On-disk shape — what `toml::from_str` sees. Separate from the
/// validated [`DepsManifest`] so normalization (default build script,
/// parsed DepRefs, etc.) lives in one place.
#[derive(Debug, Deserialize)]
struct Raw {
    kind: ManifestKind,
    name: String,
    version: String,
    revision: u32,
    source: Source,
    license: License,
    #[serde(default)]
    depends_on: Vec<String>,
    #[serde(default)]
    build: Build,
    // `outputs` may be either a table (`[outputs]`, library shape) or
    // an array of tables (`[[outputs]]`, program shape). Serde cannot
    // disambiguate via `#[serde(untagged)]` because both library and
    // empty-table parses succeed — so we hand-decode in
    // `validate_common` based on `kind`.
    #[serde(default = "default_outputs_value")]
    outputs: toml::Value,
    #[serde(default)]
    compatibility: Option<Compatibility>,
    // `binary` accepts two shapes:
    //   * bare `[binary]` (archive_url + archive_sha256 directly),
    //     interpreted as wasm32-keyed for back-compat;
    //   * per-arch `[binary.wasm32]` / `[binary.wasm64]` tables.
    // We deserialize as a generic `toml::Value` and disambiguate in
    // `validate_common`, so a mixed shape gets a precise error
    // instead of a confusing serde mismatch.
    #[serde(default)]
    binary: Option<toml::Value>,
    #[serde(default)]
    host_tools: Vec<RawHostTool>,
    /// Optional `arches = ["wasm32", "wasm64"]`. Empty/absent =
    /// `["wasm32"]` (the default — see DepsManifest::target_arches).
    #[serde(default)]
    arches: Vec<TargetArch>,
}

/// Default `outputs` value when the key is absent: an empty table.
/// Equivalent to writing `[outputs]` with no fields — both library
/// (no declared outputs) and source (no outputs allowed) accept it.
/// Programs require ≥1 entry and reject this.
fn default_outputs_value() -> toml::Value {
    toml::Value::Table(toml::value::Table::new())
}

impl DepsManifest {
    /// Read + parse + validate a `package.toml` file. `dir` is the
    /// directory containing the file (used later to resolve
    /// `build.script` relative paths).
    pub fn load(path: &Path) -> Result<Self, String> {
        let text = std::fs::read_to_string(path)
            .map_err(|e| format!("read {}: {e}", path.display()))?;
        let dir = path
            .parent()
            .ok_or_else(|| format!("{} has no parent directory", path.display()))?
            .to_path_buf();
        Self::parse(&text, dir)
            .map_err(|e| format!("{}: {e}", path.display()))
    }

    /// Parse a source `package.toml`. Rejects manifests that contain a
    /// `[compatibility]` block — that block is reserved for archived
    /// `manifest.toml` files (see [`parse_archived`]).
    pub fn parse(text: &str, dir: PathBuf) -> Result<Self, String> {
        let raw: Raw =
            toml::from_str(text).map_err(|e| format!("parse package.toml: {e}"))?;
        Self::validate_source(raw, dir)
    }

    /// Parse an archived `manifest.toml` (the one written into the
    /// cached artifact). Requires a `[compatibility]` block; rejects
    /// manifests without one. Used by Task A.9 remote-fetch path.
    pub fn parse_archived(text: &str, dir: PathBuf) -> Result<Self, String> {
        let raw: Raw = toml::from_str(text)
            .map_err(|e| format!("parse manifest.toml: {e}"))?;
        Self::validate_archived(raw, dir)
    }

    fn validate_source(raw: Raw, dir: PathBuf) -> Result<Self, String> {
        if raw.compatibility.is_some() {
            return Err(
                "source package.toml must not contain a [compatibility] block \
                 (it is injected into archived manifest.toml at build time)"
                    .into(),
            );
        }
        Self::validate_common(raw, dir)
    }

    fn validate_archived(raw: Raw, dir: PathBuf) -> Result<Self, String> {
        if raw.compatibility.is_none() {
            return Err(
                "archived manifest.toml must contain a [compatibility] block \
                 (target_arch + abi_versions + cache_key_sha)"
                    .into(),
            );
        }
        if let Some(c) = raw.compatibility.as_ref() {
            Self::validate_compatibility(c)?;
        }
        Self::validate_common(raw, dir)
    }

    fn validate_compatibility(c: &Compatibility) -> Result<(), String> {
        if c.abi_versions.is_empty() {
            return Err(
                "compatibility.abi_versions must list at least one ABI version"
                    .into(),
            );
        }
        if c.cache_key_sha.len() != 64
            || !c
                .cache_key_sha
                .chars()
                .all(|ch| ch.is_ascii_hexdigit() && !ch.is_ascii_uppercase())
        {
            return Err(format!(
                "compatibility.cache_key_sha must be 64-char lowercase hex, got {:?}",
                c.cache_key_sha
            ));
        }
        Ok(())
    }

    fn validate_binary(b: &Binary) -> Result<(), String> {
        if b.archive_sha256.len() != 64
            || !b
                .archive_sha256
                .chars()
                .all(|ch| ch.is_ascii_hexdigit() && !ch.is_ascii_uppercase())
        {
            return Err(format!(
                "binary.archive_sha256 must be 64-char lowercase hex, got {:?}",
                b.archive_sha256
            ));
        }
        Ok(())
    }

    /// Decode `[binary]` into a per-arch map. Accepts:
    ///   * Bare `archive_url` + `archive_sha256` keys → wasm32-only.
    ///   * Per-arch sub-tables (`wasm32`, `wasm64`).
    /// Mixed shapes (a bare `archive_url` next to a `[binary.wasm64]`
    /// table) are rejected — they're almost certainly a typo, and the
    /// resulting precedence would be confusing either way.
    fn parse_binary_block(
        value: toml::Value,
    ) -> Result<BTreeMap<TargetArch, Binary>, String> {
        let table = value
            .as_table()
            .ok_or_else(|| "[binary] must be a table".to_string())?
            .clone();

        // Detect shape: presence of `archive_url` at the top is the
        // bare form. Presence of an arch-named subtable is the
        // per-arch form. Either, but not both, is allowed.
        let has_bare = table.contains_key("archive_url")
            || table.contains_key("archive_sha256");
        let arch_keys: Vec<&str> = table
            .keys()
            .filter(|k| matches!(k.as_str(), "wasm32" | "wasm64"))
            .map(String::as_str)
            .collect();
        let has_per_arch = !arch_keys.is_empty();

        if has_bare && has_per_arch {
            return Err(
                "[binary] mixes the bare form (archive_url at the top) \
                 with per-arch sub-tables ([binary.wasm32] / [binary.wasm64]). \
                 Pick one shape."
                    .into(),
            );
        }

        // Reject any unknown keys to surface typos early.
        let allowed_per_arch: BTreeSet<&str> =
            ["wasm32", "wasm64"].into_iter().collect();
        let allowed_bare: BTreeSet<&str> =
            ["archive_url", "archive_sha256"].into_iter().collect();
        for key in table.keys() {
            let allowed = if has_per_arch {
                allowed_per_arch.contains(key.as_str())
            } else {
                allowed_bare.contains(key.as_str())
            };
            if !allowed {
                return Err(format!(
                    "[binary] has unexpected key {:?} (allowed: {})",
                    key,
                    if has_per_arch {
                        "wasm32, wasm64"
                    } else {
                        "archive_url, archive_sha256"
                    }
                ));
            }
        }

        let mut out: BTreeMap<TargetArch, Binary> = BTreeMap::new();
        if has_per_arch {
            for arch_key in arch_keys {
                let arch = match arch_key {
                    "wasm32" => TargetArch::Wasm32,
                    "wasm64" => TargetArch::Wasm64,
                    _ => unreachable!("filtered above"),
                };
                let sub = table[arch_key].clone();
                let b: Binary = sub
                    .try_into()
                    .map_err(|e| format!("[binary.{arch_key}]: {e}"))?;
                Self::validate_binary(&b)
                    .map_err(|e| format!("[binary.{arch_key}]: {e}"))?;
                out.insert(arch, b);
            }
        } else {
            // Bare form. Reconstruct a Binary out of the table.
            let b: Binary = toml::Value::Table(table)
                .try_into()
                .map_err(|e| format!("[binary]: {e}"))?;
            Self::validate_binary(&b)?;
            out.insert(TargetArch::Wasm32, b);
        }
        Ok(out)
    }

    fn validate_common(raw: Raw, dir: PathBuf) -> Result<Self, String> {
        if raw.name.is_empty() {
            return Err("name must not be empty".into());
        }
        if raw.name.contains('@') {
            return Err(format!("name {:?} must not contain '@'", raw.name));
        }
        if raw.version.is_empty() {
            return Err("version must not be empty".into());
        }
        if raw.revision == 0 {
            return Err("revision must be >= 1".into());
        }

        // Source sha must look like lowercase hex sha256.
        if raw.source.sha256.len() != 64
            || !raw
                .source
                .sha256
                .chars()
                .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
        {
            return Err(format!(
                "source.sha256 must be 64-char lowercase hex, got {:?}",
                raw.source.sha256
            ));
        }
        if raw.license.spdx.is_empty() {
            return Err("license.spdx must not be empty".into());
        }

        let binary = match raw.binary.as_ref() {
            None => BTreeMap::new(),
            Some(value) => {
                if matches!(raw.kind, ManifestKind::Source) {
                    return Err(
                        "kind = \"source\" must not declare [binary] \
                         (sources are not published as remote-fetchable archives)"
                            .into(),
                    );
                }
                Self::parse_binary_block(value.clone())?
            }
        };

        let depends_on: Vec<DepRef> = raw
            .depends_on
            .iter()
            .map(|s| DepRef::parse(s))
            .collect::<Result<Vec<_>, _>>()?;

        // Reject duplicate dep references (e.g. two different versions
        // of the same lib listed) — V1 has no resolver to pick between.
        {
            let mut names: Vec<&str> = depends_on.iter().map(|d| d.name.as_str()).collect();
            names.sort();
            let orig_len = names.len();
            names.dedup();
            if names.len() != orig_len {
                return Err(
                    "depends_on lists the same library twice \
                     (V1 requires exactly one version per transitive dep)"
                        .into(),
                );
            }
        }

        // `[[host_tools]]` validation — runs on every manifest kind.
        // Constraint syntax validation lands in C.8; here we only
        // check that strings are non-empty, that probe.args (when
        // given) is non-empty, and that names are unique within this
        // manifest. Defaults are filled in for omitted probe /
        // install_hints fields.
        let mut host_tools: Vec<HostTool> = Vec::with_capacity(raw.host_tools.len());
        let mut seen_names: BTreeSet<String> = BTreeSet::new();
        for (idx, raw_t) in raw.host_tools.into_iter().enumerate() {
            if raw_t.name.is_empty() {
                return Err(format!("[[host_tools]][{idx}].name must not be empty"));
            }
            if !seen_names.insert(raw_t.name.clone()) {
                return Err(format!(
                    "[[host_tools]] declares {:?} twice in this manifest",
                    raw_t.name
                ));
            }
            if raw_t.version_constraint.is_empty() {
                return Err(format!(
                    "[[host_tools]][{idx}] {:?}: version_constraint must not be empty",
                    raw_t.name
                ));
            }
            let version_constraint =
                VersionConstraint::parse(&raw_t.version_constraint, &raw_t.name)?;
            let probe = match raw_t.probe {
                None => HostToolProbe::default(),
                Some(p) => {
                    let args = match p.args {
                        Some(a) if a.is_empty() => {
                            return Err(format!(
                                "[[host_tools]][{idx}] {:?}: probe.args must be non-empty when given",
                                raw_t.name
                            ));
                        }
                        Some(a) => a,
                        None => HostToolProbe::default().args,
                    };
                    let version_regex = p
                        .version_regex
                        .unwrap_or_else(|| HostToolProbe::default().version_regex);
                    HostToolProbe { args, version_regex }
                }
            };
            // Compile-test the regex at parse time so a typo in
            // package.toml surfaces as a manifest error, not as a probe-
            // time `BadOutput { output: "invalid regex: ..." }` that
            // C.10's renderer can't tell apart from a runtime tool-
            // output mismatch. The runtime probe in `host_tool_probe`
            // relies on this invariant and unwraps the compiled regex.
            regex::Regex::new(&probe.version_regex).map_err(|e| {
                format!(
                    "[[host_tools]][{idx}] {:?}: probe.version_regex {:?} is invalid: {e}",
                    raw_t.name, probe.version_regex
                )
            })?;
            let install_hints = raw_t.install_hints.unwrap_or_default();
            for (k, v) in &install_hints {
                if k.is_empty() || v.is_empty() {
                    return Err(format!(
                        "[[host_tools]][{idx}] {:?}: install_hints entries must have non-empty key and value",
                        raw_t.name
                    ));
                }
            }
            host_tools.push(HostTool {
                name: raw_t.name,
                version_constraint,
                probe,
                install_hints,
            });
        }

        // Dispatch on `kind` to decide whether `outputs` is the
        // library shape (`[outputs]` table with libs/headers/pkgconfig)
        // or the program shape (`[[outputs]]` array-of-tables with
        // name/wasm). A mismatch between the two is rejected at parse
        // time: each kind enforces its own grammar.
        let (outputs, program_outputs) = match raw.kind {
            ManifestKind::Library => {
                if raw.outputs.is_array() {
                    return Err(
                        "kind = \"library\" requires [outputs] (table); \
                         got [[outputs]] (array of tables)"
                            .into(),
                    );
                }
                let outputs: Outputs = raw.outputs.try_into().map_err(|e| {
                    format!("parse [outputs] table: {e}")
                })?;
                (outputs, Vec::new())
            }
            ManifestKind::Program => {
                // Distinguish "key absent / empty-default table" from
                // "explicit [outputs] with library-shaped fields":
                // the former is a missing-outputs error ("at least
                // one"); the latter is a wrong-shape error.
                if let Some(table) = raw.outputs.as_table() {
                    if table.is_empty() {
                        return Err(
                            "kind = \"program\" must declare at least one [[outputs]] entry"
                                .into(),
                        );
                    }
                    return Err(
                        "kind = \"program\" requires [[outputs]] (array of tables); \
                         got [outputs] (table)"
                            .into(),
                    );
                }
                let program_outputs: Vec<ProgramOutput> = raw
                    .outputs
                    .try_into()
                    .map_err(|e| format!("parse [[outputs]] array: {e}"))?;
                if program_outputs.is_empty() {
                    return Err(
                        "kind = \"program\" must declare at least one [[outputs]] entry"
                            .into(),
                    );
                }
                for (idx, out) in program_outputs.iter().enumerate() {
                    if out.name.is_empty() {
                        return Err(format!(
                            "[[outputs]][{idx}].name must not be empty"
                        ));
                    }
                    if out.wasm.is_empty() {
                        return Err(format!(
                            "[[outputs]][{idx}].wasm must not be empty"
                        ));
                    }
                }
                (Outputs::default(), program_outputs)
            }
            ManifestKind::Source => {
                if raw.outputs.is_array() {
                    return Err(
                        "kind = \"source\" must not declare outputs \
                         ([outputs] or [[outputs]])"
                            .into(),
                    );
                }
                // For source kind, accept only an empty table (the
                // default when the key is absent). Any non-empty
                // [outputs] is rejected — sources have no artifacts.
                let table = raw.outputs.as_table().ok_or_else(|| {
                    "kind = \"source\" must not declare outputs \
                     ([outputs] or [[outputs]])"
                        .to_string()
                })?;
                if !table.is_empty() {
                    return Err(
                        "kind = \"source\" must not declare outputs \
                         ([outputs] or [[outputs]])"
                            .into(),
                    );
                }
                (Outputs::default(), Vec::new())
            }
        };

        // Default `arches` to `["wasm32"]` when omitted. Reject
        // duplicates so a manifest can't say `["wasm32", "wasm32"]`.
        let target_arches = if raw.arches.is_empty() {
            vec![TargetArch::Wasm32]
        } else {
            let mut seen: Vec<TargetArch> = Vec::new();
            for &a in &raw.arches {
                if seen.contains(&a) {
                    return Err(format!(
                        "arches lists {:?} twice",
                        a.as_str()
                    ));
                }
                seen.push(a);
            }
            raw.arches
        };
        Ok(DepsManifest {
            kind: raw.kind,
            name: raw.name,
            version: raw.version,
            revision: raw.revision,
            source: raw.source,
            license: raw.license,
            depends_on,
            build: raw.build,
            outputs,
            program_outputs,
            compatibility: raw.compatibility,
            binary,
            host_tools,
            target_arches,
            dir,
        })
    }

    /// Absolute path to the build script. Default is `build-<name>.sh`
    /// in the same directory as this `package.toml`.
    pub fn build_script_path(&self) -> PathBuf {
        let script = self
            .build
            .script
            .clone()
            .unwrap_or_else(|| format!("build-{}.sh", self.name));
        self.dir.join(script)
    }

    /// `"<name>@<version>"` — the form used in `depends_on` strings.
    pub fn spec(&self) -> String {
        format!("{}@{}", self.name, self.version)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const EXAMPLE: &str = r#"
kind = "library"
name = "zlib"
version = "1.3.1"
revision = 1
depends_on = []

[source]
url = "https://example.test/zlib-1.3.1.tar.gz"
sha256 = "0000000000000000000000000000000000000000000000000000000000000000"

[license]
spdx = "Zlib"

[outputs]
libs = ["lib/libz.a"]
headers = ["include/zlib.h"]
"#;

    #[test]
    fn parses_minimal_manifest() {
        let m = DepsManifest::parse(EXAMPLE, PathBuf::from("/x")).unwrap();
        assert_eq!(m.name, "zlib");
        assert_eq!(m.version, "1.3.1");
        assert_eq!(m.revision, 1);
        assert!(m.depends_on.is_empty());
        assert_eq!(m.outputs.libs, vec!["lib/libz.a"]);
        assert_eq!(m.spec(), "zlib@1.3.1");
        assert_eq!(
            m.build_script_path(),
            PathBuf::from("/x/build-zlib.sh")
        );
    }

    #[test]
    fn build_script_override_is_respected() {
        // Append a [build] section at the end; the example doesn't have one.
        let text = format!("{EXAMPLE}\n[build]\nscript = \"custom-build.sh\"\n");
        let m = DepsManifest::parse(&text, PathBuf::from("/x")).unwrap();
        assert_eq!(
            m.build_script_path(),
            PathBuf::from("/x/custom-build.sh")
        );
    }

    #[test]
    fn rejects_uppercase_or_short_sha() {
        let bad = EXAMPLE.replace(
            "0000000000000000000000000000000000000000000000000000000000000000",
            "ABCDEF",
        );
        let err = DepsManifest::parse(&bad, PathBuf::from("/x")).unwrap_err();
        assert!(err.contains("source.sha256"), "got: {err}");
    }

    #[test]
    fn rejects_zero_revision() {
        let bad = EXAMPLE.replace("revision = 1", "revision = 0");
        let err = DepsManifest::parse(&bad, PathBuf::from("/x")).unwrap_err();
        assert!(err.contains("revision"), "got: {err}");
    }

    #[test]
    fn rejects_empty_spdx() {
        let bad = EXAMPLE.replace("spdx = \"Zlib\"", "spdx = \"\"");
        let err = DepsManifest::parse(&bad, PathBuf::from("/x")).unwrap_err();
        assert!(err.contains("license.spdx"), "got: {err}");
    }

    #[test]
    fn depref_parse_basic() {
        let d = DepRef::parse("zlib@1.3.1").unwrap();
        assert_eq!(d.name, "zlib");
        assert_eq!(d.version, "1.3.1");
        assert_eq!(d.to_string(), "zlib@1.3.1");
    }

    #[test]
    fn depref_rejects_missing_at() {
        let err = DepRef::parse("zlib-1.3.1").unwrap_err();
        assert!(err.contains("<name>@<version>"), "got: {err}");
    }

    #[test]
    fn depref_rejects_empty_fields() {
        assert!(DepRef::parse("@1.3.1").is_err());
        assert!(DepRef::parse("zlib@").is_err());
    }

    #[test]
    fn depends_on_parsed_into_deprefs() {
        let text = EXAMPLE.replace(
            "depends_on = []",
            r#"depends_on = ["zlib@1.3.1", "openssl@3.0.15"]"#,
        );
        let m = DepsManifest::parse(&text, PathBuf::from("/x")).unwrap();
        assert_eq!(m.depends_on.len(), 2);
        assert_eq!(m.depends_on[0].name, "zlib");
        assert_eq!(m.depends_on[1].name, "openssl");
    }

    #[test]
    fn rejects_duplicate_depends_on() {
        let text = EXAMPLE.replace(
            "depends_on = []",
            r#"depends_on = ["zlib@1.3.1", "zlib@1.2.11"]"#,
        );
        let err = DepsManifest::parse(&text, PathBuf::from("/x")).unwrap_err();
        assert!(err.contains("depends_on"), "got: {err}");
    }

    #[test]
    fn rejects_manifest_without_kind() {
        let text = r#"
name = "x"
version = "1.0"
revision = 1
[source]
url = "https://example.test/x.tar.gz"
sha256 = "0000000000000000000000000000000000000000000000000000000000000000"
[license]
spdx = "MIT"
"#;
        let err = DepsManifest::parse(text, PathBuf::from("/x")).unwrap_err();
        assert!(err.contains("kind"), "got: {err}");
    }

    #[test]
    fn parses_manifest_with_kind_library() {
        let m = DepsManifest::parse(EXAMPLE, PathBuf::from("/x")).unwrap();
        assert!(matches!(m.kind, ManifestKind::Library));
    }

    #[test]
    fn rejects_compatibility_in_source_mode() {
        let text = format!(
            "{}\n[compatibility]\ntarget_arch = \"wasm32\"\nabi_versions = [4]\ncache_key_sha = \"{:0>64}\"\n",
            EXAMPLE, ""
        );
        let err = DepsManifest::parse(&text, PathBuf::from("/x")).unwrap_err();
        assert!(err.contains("[compatibility]"), "got: {err}");
    }

    #[test]
    fn parse_archived_requires_compatibility_block() {
        // No [compatibility] block — archived manifests must have one.
        let err = DepsManifest::parse_archived(EXAMPLE, PathBuf::from("/x")).unwrap_err();
        assert!(err.contains("[compatibility]"), "got: {err}");
    }

    #[test]
    fn parse_archived_accepts_full_compatibility_block() {
        let sha = "0".repeat(64);
        let text = format!(
            "{}\n[compatibility]\ntarget_arch = \"wasm32\"\nabi_versions = [4]\ncache_key_sha = \"{}\"\n",
            EXAMPLE, sha
        );
        let m = DepsManifest::parse_archived(&text, PathBuf::from("/x")).unwrap();
        let c = m.compatibility.as_ref().unwrap();
        assert_eq!(c.target_arch, TargetArch::Wasm32);
        assert_eq!(c.abi_versions, vec![4]);
        assert_eq!(c.cache_key_sha, sha);
        assert!(c.build_timestamp.is_none());
        assert!(c.build_host.is_none());
    }

    #[test]
    fn parse_archived_rejects_empty_abi_versions() {
        let text = format!(
            "{}\n[compatibility]\ntarget_arch = \"wasm32\"\nabi_versions = []\ncache_key_sha = \"{:0>64}\"\n",
            EXAMPLE, ""
        );
        let err = DepsManifest::parse_archived(&text, PathBuf::from("/x")).unwrap_err();
        assert!(err.contains("abi_versions"), "got: {err}");
    }

    #[test]
    fn parse_archived_rejects_uppercase_cache_key_sha() {
        let text = format!(
            "{}\n[compatibility]\ntarget_arch = \"wasm32\"\nabi_versions = [4]\ncache_key_sha = \"{}\"\n",
            EXAMPLE,
            "A".repeat(64),
        );
        let err = DepsManifest::parse_archived(&text, PathBuf::from("/x")).unwrap_err();
        assert!(err.contains("cache_key_sha"), "got: {err}");
    }

    #[test]
    fn parse_archived_rejects_short_cache_key_sha() {
        let text = format!(
            "{}\n[compatibility]\ntarget_arch = \"wasm32\"\nabi_versions = [4]\ncache_key_sha = \"abc\"\n",
            EXAMPLE
        );
        let err = DepsManifest::parse_archived(&text, PathBuf::from("/x")).unwrap_err();
        assert!(err.contains("cache_key_sha"), "got: {err}");
    }

    #[test]
    fn parses_bare_binary_block_as_wasm32() {
        let text = format!(
            "{}\n[binary]\narchive_url = \"https://x/foo.tar.zst\"\narchive_sha256 = \"{:0>64}\"\n",
            EXAMPLE, ""
        );
        let m = DepsManifest::parse(&text, PathBuf::from("/x")).unwrap();
        let b = m.binary.get(&TargetArch::Wasm32).expect("wasm32 entry");
        assert_eq!(b.archive_url, "https://x/foo.tar.zst");
        assert_eq!(b.archive_sha256, "0".repeat(64));
        assert!(m.binary.get(&TargetArch::Wasm64).is_none());
    }

    #[test]
    fn parses_per_arch_binary_block() {
        let text = format!(
            "{}\n[binary.wasm32]\narchive_url = \"https://x/32.tar.zst\"\n\
                          archive_sha256 = \"{:0>64}\"\n\
             [binary.wasm64]\narchive_url = \"https://x/64.tar.zst\"\n\
                          archive_sha256 = \"{:1>64}\"\n",
            EXAMPLE, "", ""
        );
        let m = DepsManifest::parse(&text, PathBuf::from("/x")).unwrap();
        let b32 = m.binary.get(&TargetArch::Wasm32).expect("wasm32 entry");
        let b64 = m.binary.get(&TargetArch::Wasm64).expect("wasm64 entry");
        assert_eq!(b32.archive_url, "https://x/32.tar.zst");
        assert_eq!(b64.archive_url, "https://x/64.tar.zst");
        assert!(b32.archive_sha256.starts_with("0"));
        assert!(b64.archive_sha256.starts_with("1"));
    }

    #[test]
    fn rejects_mixed_binary_shape() {
        // Bare archive_url next to [binary.wasm64] is a typo trap —
        // require pick-one-shape.
        let text = format!(
            "{}\n[binary]\narchive_url = \"https://x/foo.tar.zst\"\n\
                         archive_sha256 = \"{:0>64}\"\n\
             [binary.wasm64]\narchive_url = \"https://x/64.tar.zst\"\n\
                          archive_sha256 = \"{:0>64}\"\n",
            EXAMPLE, "", ""
        );
        let err = DepsManifest::parse(&text, PathBuf::from("/x"))
            .expect_err("mixed shape must fail");
        assert!(
            err.contains("mixes the bare form") || err.contains("[binary]"),
            "error must call out the mixed shape, got: {err}"
        );
    }

    #[test]
    fn rejects_unknown_binary_key() {
        let text = format!(
            "{}\n[binary]\narchive_url = \"https://x/foo.tar.zst\"\n\
                         archive_sha256 = \"{:0>64}\"\n\
                         bogus = true\n",
            EXAMPLE, ""
        );
        let err = DepsManifest::parse(&text, PathBuf::from("/x"))
            .expect_err("unknown key must fail");
        assert!(err.contains("bogus"), "got: {err}");
    }

    #[test]
    fn parse_accepts_no_binary_block() {
        // EXAMPLE has no [binary] block. Confirm parse succeeds and
        // binary is empty.
        let m = DepsManifest::parse(EXAMPLE, PathBuf::from("/x")).unwrap();
        assert!(m.binary.is_empty());
    }

    #[test]
    fn rejects_invalid_binary_archive_sha() {
        let text = format!(
            "{}\n[binary]\narchive_url = \"https://x\"\narchive_sha256 = \"BAD\"\n",
            EXAMPLE
        );
        let err = DepsManifest::parse(&text, PathBuf::from("/x")).unwrap_err();
        assert!(err.contains("archive_sha256"), "got: {err}");
    }

    #[test]
    fn rejects_uppercase_binary_archive_sha() {
        let text = format!(
            "{}\n[binary]\narchive_url = \"https://x\"\narchive_sha256 = \"{}\"\n",
            EXAMPLE,
            "A".repeat(64),
        );
        let err = DepsManifest::parse(&text, PathBuf::from("/x")).unwrap_err();
        assert!(err.contains("archive_sha256"), "got: {err}");
    }

    #[test]
    fn rejects_short_binary_archive_sha() {
        let text = format!(
            "{}\n[binary]\narchive_url = \"https://x\"\narchive_sha256 = \"abcdef01\"\n",
            EXAMPLE
        );
        let err = DepsManifest::parse(&text, PathBuf::from("/x")).unwrap_err();
        assert!(err.contains("archive_sha256"), "got: {err}");
    }

    #[test]
    fn rejects_long_binary_archive_sha() {
        let text = format!(
            "{}\n[binary]\narchive_url = \"https://x\"\narchive_sha256 = \"{}\"\n",
            EXAMPLE,
            "a".repeat(65),
        );
        let err = DepsManifest::parse(&text, PathBuf::from("/x")).unwrap_err();
        assert!(err.contains("archive_sha256"), "got: {err}");
    }

    #[test]
    fn target_arch_as_str_is_stable() {
        // The cache-key sha hashes arch.as_str(); changing this format
        // would silently invalidate every cache. Lock the contract here.
        assert_eq!(TargetArch::Wasm32.as_str(), "wasm32");
        assert_eq!(TargetArch::Wasm64.as_str(), "wasm64");
    }

    const PROGRAM_EXAMPLE: &str = r#"
kind = "program"
name = "vim"
version = "9.1.0900"
revision = 1
depends_on = []

[source]
url = "https://github.com/vim/vim/archive/refs/tags/v9.1.0900.tar.gz"
sha256 = "0000000000000000000000000000000000000000000000000000000000000000"

[license]
spdx = "Vim"

[[outputs]]
name = "vim"
wasm = "vim.wasm"
"#;

    #[test]
    fn parses_minimal_program_manifest() {
        let m = DepsManifest::parse(PROGRAM_EXAMPLE, PathBuf::from("/x")).unwrap();
        assert!(matches!(m.kind, ManifestKind::Program));
        assert_eq!(m.program_outputs.len(), 1);
        assert_eq!(m.program_outputs[0].name, "vim");
        assert_eq!(m.program_outputs[0].wasm, "vim.wasm");
        // Library `outputs` should be empty for programs.
        assert!(m.outputs.libs.is_empty());
        assert!(m.outputs.headers.is_empty());
        assert!(m.outputs.pkgconfig.is_empty());
    }

    #[test]
    fn parses_multi_output_program_manifest() {
        let text = r#"
kind = "program"
name = "git"
version = "2.47.1"
revision = 1
depends_on = []

[source]
url = "https://github.com/git/git/archive/refs/tags/v2.47.1.tar.gz"
sha256 = "0000000000000000000000000000000000000000000000000000000000000000"

[license]
spdx = "GPL-2.0-only"

[[outputs]]
name = "git"
wasm = "git.wasm"

[[outputs]]
name = "git-remote-http"
wasm = "git-remote-http.wasm"
"#;
        let m = DepsManifest::parse(text, PathBuf::from("/x")).unwrap();
        assert_eq!(m.program_outputs.len(), 2);
        assert_eq!(m.program_outputs[0].name, "git");
        assert_eq!(m.program_outputs[1].name, "git-remote-http");
    }

    #[test]
    fn rejects_program_with_table_outputs() {
        let text = PROGRAM_EXAMPLE.replace(
            "[[outputs]]\nname = \"vim\"\nwasm = \"vim.wasm\"",
            "[outputs]\nlibs = [\"lib/libvim.a\"]",
        );
        let err = DepsManifest::parse(&text, PathBuf::from("/x")).unwrap_err();
        assert!(
            err.contains("kind = \"program\"") || err.contains("[[outputs]]"),
            "got: {err}"
        );
    }

    #[test]
    fn rejects_library_with_array_outputs() {
        let text = format!(
            "{}\n[[outputs]]\nname = \"libz\"\nwasm = \"libz.wasm\"\n",
            EXAMPLE
        );
        let err = DepsManifest::parse(&text, PathBuf::from("/x")).unwrap_err();
        assert!(
            err.contains("kind = \"library\"") || err.contains("[outputs]"),
            "got: {err}"
        );
    }

    #[test]
    fn rejects_program_with_no_outputs() {
        let text = r#"
kind = "program"
name = "vim"
version = "9.1.0900"
revision = 1
[source]
url = "https://example.test/vim.tar.gz"
sha256 = "0000000000000000000000000000000000000000000000000000000000000000"
[license]
spdx = "Vim"
"#;
        let err = DepsManifest::parse(text, PathBuf::from("/x")).unwrap_err();
        assert!(err.contains("at least one"), "got: {err}");
    }

    #[test]
    fn rejects_program_output_with_empty_wasm() {
        let text = r#"
kind = "program"
name = "vim"
version = "9.1.0900"
revision = 1
[source]
url = "https://example.test/vim.tar.gz"
sha256 = "0000000000000000000000000000000000000000000000000000000000000000"
[license]
spdx = "Vim"
[[outputs]]
name = "vim"
wasm = ""
"#;
        let err = DepsManifest::parse(text, PathBuf::from("/x")).unwrap_err();
        assert!(err.contains("wasm"), "got: {err}");
    }

    #[test]
    fn source_kind_rejects_binary_block() {
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

[binary]
archive_url = "https://example.test/pcre2.tar.zst"
archive_sha256 = "1111111111111111111111111111111111111111111111111111111111111111"
"#;
        let err = DepsManifest::parse(text, PathBuf::from("/x")).unwrap_err();
        assert!(
            err.contains("source") && err.contains("binary"),
            "got: {err}"
        );
    }

    #[test]
    fn source_kind_minimal_manifest_parses() {
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
        let m = DepsManifest::parse(text, PathBuf::from("/x")).unwrap();
        assert!(matches!(m.kind, ManifestKind::Source));
        assert_eq!(m.name, "pcre2-source");
        assert!(m.outputs.libs.is_empty());
        assert!(m.program_outputs.is_empty());
        assert!(m.binary.is_empty());
    }

    const LIB_WITH_HOST_TOOLS: &str = r#"
kind = "library"
name = "zlib"
version = "1.3.1"
revision = 1

[source]
url = "https://example.test/zlib-1.3.1.tar.gz"
sha256 = "0000000000000000000000000000000000000000000000000000000000000000"

[license]
spdx = "Zlib"

[outputs]
libs = ["lib/libz.a"]

[[host_tools]]
name = "make"
version_constraint = ">=4.0"

[[host_tools]]
name = "cmake"
version_constraint = ">=3.20"
probe = { args = ["--version"], version_regex = "cmake version (\\d+\\.\\d+(?:\\.\\d+)?)" }
install_hints = { darwin = "brew install cmake", linux = "apt install cmake" }
"#;

    #[test]
    fn parses_host_tools_with_defaults() {
        let m = DepsManifest::parse(LIB_WITH_HOST_TOOLS, PathBuf::from("/x")).unwrap();
        assert_eq!(m.host_tools.len(), 2);
        assert_eq!(m.host_tools[0].name, "make");
        // make has no explicit probe → uses defaults.
        assert_eq!(m.host_tools[0].probe.args, vec!["--version"]);
        assert!(m.host_tools[0].install_hints.is_empty());

        // cmake has explicit probe + hints.
        assert_eq!(m.host_tools[1].name, "cmake");
        assert!(m.host_tools[1].probe.version_regex.starts_with("cmake version"));
        assert_eq!(
            m.host_tools[1].install_hints.get("darwin").map(String::as_str),
            Some("brew install cmake")
        );
    }

    #[test]
    fn host_tools_reject_duplicate_names_in_same_manifest() {
        let bad = LIB_WITH_HOST_TOOLS.replace("name = \"cmake\"", "name = \"make\"");
        let err = DepsManifest::parse(&bad, PathBuf::from("/x")).unwrap_err();
        assert!(err.contains("twice"), "got: {err}");
    }

    #[test]
    fn host_tools_allowed_on_source_kind() {
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

[[host_tools]]
name = "patch"
version_constraint = ">=2.7"
"#;
        let m = DepsManifest::parse(text, PathBuf::from("/x")).unwrap();
        assert_eq!(m.host_tools.len(), 1);
        assert_eq!(m.host_tools[0].name, "patch");
    }

    #[test]
    fn host_tools_reject_empty_probe_args() {
        let bad = r#"
kind = "library"
name = "x"
version = "1.0"
revision = 1
[source]
url = "https://example.test/x.tar.gz"
sha256 = "0000000000000000000000000000000000000000000000000000000000000000"
[license]
spdx = "MIT"
[outputs]
libs = []
[[host_tools]]
name = "cmake"
version_constraint = ">=3.0"
probe = { args = [], version_regex = "(\\d+\\.\\d+)" }
"#;
        let err = DepsManifest::parse(bad, PathBuf::from("/x")).unwrap_err();
        assert!(err.contains("probe.args"), "got: {err}");
    }

    #[test]
    fn host_tools_reject_invalid_probe_regex() {
        let bad = r#"
kind = "library"
name = "x"
version = "1.0"
revision = 1
[source]
url = "https://example.test/x.tar.gz"
sha256 = "0000000000000000000000000000000000000000000000000000000000000000"
[license]
spdx = "MIT"
[outputs]
libs = []
[[host_tools]]
name = "cmake"
version_constraint = ">=3.0"
probe = { args = ["--version"], version_regex = "(unclosed" }
"#;
        let err = DepsManifest::parse(bad, PathBuf::from("/x")).unwrap_err();
        assert!(
            err.contains("version_regex") && err.contains("invalid"),
            "got: {err}"
        );
    }

    #[test]
    fn version_constraint_accepts_two_and_three_component() {
        let c2 = VersionConstraint::parse(">=3.20", "cmake").unwrap();
        assert_eq!(
            c2.min,
            Version {
                major: 3,
                minor: 20,
                patch: None
            }
        );
        let c3 = VersionConstraint::parse(">=3.20.0", "cmake").unwrap();
        assert_eq!(
            c3.min,
            Version {
                major: 3,
                minor: 20,
                patch: Some(0)
            }
        );
    }

    #[test]
    fn version_eq_and_ord_agree_on_patch_none_zero() {
        let v_no_patch = Version::parse("3.20").unwrap();
        let v_zero_patch = Version::parse("3.20.0").unwrap();
        // Ord: equal.
        assert_eq!(v_no_patch.cmp(&v_zero_patch), std::cmp::Ordering::Equal);
        // PartialEq: equal (this is what was broken before the fix).
        assert_eq!(v_no_patch, v_zero_patch);
        // Round-trip via Display preserves the input form (regression
        // guard: don't accidentally normalize on parse).
        assert_eq!(v_no_patch.to_string(), "3.20");
        assert_eq!(v_zero_patch.to_string(), "3.20.0");
    }

    #[test]
    fn version_constraint_compares_numerically_not_lexicographically() {
        let c = VersionConstraint::parse(">=3.9", "cmake").unwrap();
        assert!(
            c.satisfies(&Version::parse("3.20").unwrap()),
            "3.20 > 3.9 numerically"
        );
        assert!(c.satisfies(&Version::parse("3.9.0").unwrap()));
        assert!(!c.satisfies(&Version::parse("3.8").unwrap()));
        let c310 = VersionConstraint::parse(">=3.10.5", "cmake").unwrap();
        assert!(c310.satisfies(&Version::parse("3.10.5").unwrap()));
        assert!(c310.satisfies(&Version::parse("3.11").unwrap()));
        assert!(!c310.satisfies(&Version::parse("3.10.4").unwrap()));
    }

    #[test]
    fn version_constraint_rejects_other_operators() {
        for bad in [">3.20", "<3.20", "==3.20", "^3.20", "~3.20", "=3.20", "3.20"] {
            let err = VersionConstraint::parse(bad, "cmake").unwrap_err();
            assert!(
                err.contains("unsupported") && err.contains("future work"),
                "expected future-work error for {bad:?}, got: {err}"
            );
        }
    }

    #[test]
    fn version_constraint_rejects_compound() {
        let err = VersionConstraint::parse(">=3.20,<4.0", "cmake").unwrap_err();
        assert!(err.contains("compound"), "got: {err}");
    }

    #[test]
    fn version_constraint_rejects_prerelease_suffix() {
        let err = VersionConstraint::parse(">=3.20-rc1", "cmake").unwrap_err();
        assert!(
            err.contains("prerelease") || err.contains("suffix"),
            "got: {err}"
        );
    }
}
