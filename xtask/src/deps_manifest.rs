//! Parser for `deps.toml` — per-library build/cache manifest.
//!
//! Each wasm-posix-kernel library declares one of these next to its
//! build script (`examples/libs/<name>/deps.toml`). The resolver
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

use std::path::{Path, PathBuf};

use serde::Deserialize;

/// Discriminator for the kind of artifact a manifest produces.
///
/// Required at the top level of every `deps.toml` (`kind = "library"`,
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
/// never in source `deps.toml`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TargetArch {
    Wasm32,
    Wasm64,
}

/// Build-time provenance + ABI compatibility data injected into an
/// archived `manifest.toml` at archive creation. Source `deps.toml`
/// files MUST NOT contain this block; archived manifests MUST.
///
/// Used by the resolver's remote-fetch path (Task A.9) to reject
/// archives whose `target_arch` or `abi_versions` no longer match
/// the consumer's environment.
// Fields are read by tests + future A.5 (cache-key inputs) / A.9
// (remote-fetch verification). Mark allow(dead_code) at the struct
// level so the binary crate's dead-code analysis doesn't grumble
// about unread schema fields between landing the schema and wiring
// it up in subsequent commits.
#[derive(Debug, Clone, Deserialize)]
#[allow(dead_code)]
pub struct Compatibility {
    pub target_arch: TargetArch,
    pub abi_versions: Vec<u32>,
    pub cache_key_sha: String,
    #[serde(default)]
    pub build_timestamp: Option<String>,
    #[serde(default)]
    pub build_host: Option<String>,
}

/// One fully-parsed `deps.toml` file.
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

    /// Build-time provenance + ABI compatibility. Always `None` for
    /// manifests parsed via [`DepsManifest::parse`] (source `deps.toml`)
    /// and always `Some` for those parsed via
    /// [`DepsManifest::parse_archived`] (archived `manifest.toml`).
    /// Read by tests now; wired into the resolver in Tasks A.5 / A.9.
    #[allow(dead_code)]
    pub compatibility: Option<Compatibility>,

    /// Directory containing this `deps.toml`. The build script path and
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
    #[serde(default)]
    outputs: Outputs,
    #[serde(default)]
    compatibility: Option<Compatibility>,
}

impl DepsManifest {
    /// Read + parse + validate a `deps.toml` file. `dir` is the
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

    /// Parse a source `deps.toml`. Rejects manifests that contain a
    /// `[compatibility]` block — that block is reserved for archived
    /// `manifest.toml` files (see [`parse_archived`]).
    pub fn parse(text: &str, dir: PathBuf) -> Result<Self, String> {
        let raw: Raw =
            toml::from_str(text).map_err(|e| format!("parse deps.toml: {e}"))?;
        Self::validate_source(raw, dir)
    }

    /// Parse an archived `manifest.toml` (the one written into the
    /// cached artifact). Requires a `[compatibility]` block; rejects
    /// manifests without one. Used by Task A.9 remote-fetch path.
    #[allow(dead_code)]
    pub fn parse_archived(text: &str, dir: PathBuf) -> Result<Self, String> {
        let raw: Raw = toml::from_str(text)
            .map_err(|e| format!("parse manifest.toml: {e}"))?;
        Self::validate_archived(raw, dir)
    }

    fn validate_source(raw: Raw, dir: PathBuf) -> Result<Self, String> {
        if raw.compatibility.is_some() {
            return Err(
                "source deps.toml must not contain a [compatibility] block \
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

        Ok(DepsManifest {
            kind: raw.kind,
            name: raw.name,
            version: raw.version,
            revision: raw.revision,
            source: raw.source,
            license: raw.license,
            depends_on,
            build: raw.build,
            outputs: raw.outputs,
            compatibility: raw.compatibility,
            dir,
        })
    }

    /// Absolute path to the build script. Default is `build-<name>.sh`
    /// in the same directory as this `deps.toml`.
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
        assert!(err.contains("compatibility"), "got: {err}");
    }

    #[test]
    fn parse_archived_requires_compatibility_block() {
        // No [compatibility] block — archived manifests must have one.
        let err = DepsManifest::parse_archived(EXAMPLE, PathBuf::from("/x")).unwrap_err();
        assert!(err.contains("compatibility"), "got: {err}");
    }

    #[test]
    fn parse_archived_accepts_full_compatibility_block() {
        let text = format!(
            "{}\n[compatibility]\ntarget_arch = \"wasm32\"\nabi_versions = [4]\ncache_key_sha = \"{:0>64}\"\n",
            EXAMPLE, ""
        );
        let m = DepsManifest::parse_archived(&text, PathBuf::from("/x")).unwrap();
        let c = m.compatibility.as_ref().unwrap();
        assert_eq!(c.target_arch, TargetArch::Wasm32);
        assert_eq!(c.abi_versions, vec![4]);
    }
}
