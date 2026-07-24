//! Parser + writer for the `index.toml` ledger.
//!
//! `index.toml` is the single source of truth for binary resolution
//! state — per package, per arch. CI publishes archive URLs into it
//! atomically under a workflow-level state-lock (see
//! `.github/scripts/state-lock.sh`); the resolver consumes it via
//! HTTP (see `build_deps::fetch_index` later in the implementation
//! plan).
//!
//! Schema: `docs/plans/2026-05-13-binary-resolution-via-index-ledger-design.md` §3.4.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::pkg_manifest::TargetArch;
use crate::util::hex;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct IndexToml {
    pub abi_version: u32,
    pub generated_at: String,
    pub generator: String,
    #[serde(default)]
    pub packages: Vec<PackageEntry>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct PackageEntry {
    pub name: String,
    pub version: String,
    pub revision: u32,
    #[serde(default)]
    pub binary: BTreeMap<TargetArch, BinaryEntry>,
}

/// Per-arch binary entry. `status` discriminates which field set is
/// authoritative:
///   * `Success` — `archive_url` / `archive_sha256` / `cache_key_sha`
///     / `built_at` / `built_by` are populated; `fallback_*` are
///     cleared.
///   * `Failed` — `error` / `last_attempt` / `last_attempt_by` are
///     populated; `fallback_*` MAY be populated when a prior
///     successful build is being preserved as the last-green
///     fallback.
///   * `Pending` / `Building` — transient states the index can
///     report during a rebuild; resolver falls back to source build
///     unless `fallback_*` is populated.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, Default)]
pub struct BinaryEntry {
    pub status: EntryStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archive_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archive_sha256: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_key_sha: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub built_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub built_by: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_attempt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_attempt_by: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fallback_archive_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fallback_archive_sha256: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fallback_cache_key_sha: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fallback_built_at: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum EntryStatus {
    Pending,
    Building,
    #[default]
    Success,
    Failed,
}

impl IndexToml {
    /// Parse an `index.toml` from a TOML string.
    pub fn parse(s: &str) -> Result<Self, String> {
        toml::from_str(s).map_err(|e| format!("index.toml parse: {e}"))
    }

    /// Construct an empty ledger (no packages). Used by
    /// `xtask index-bootstrap` and by the per-package matrix-build
    /// when an `index.toml` doesn't yet exist on the release.
    pub fn empty(abi_version: u32, generated_at: String, generator: String) -> Self {
        IndexToml {
            abi_version,
            generated_at,
            generator,
            packages: Vec::new(),
        }
    }

    /// Look up an entry by `(name, version, arch)`. Returns `None`
    /// when the package isn't in the ledger or the arch hasn't been
    /// recorded.
    pub fn lookup(&self, name: &str, version: &str, arch: TargetArch) -> Option<&BinaryEntry> {
        self.packages
            .iter()
            .find(|p| p.name == name && p.version == version)?
            .binary
            .get(&arch)
    }

    /// Validate that every ABI-bearing archive filename in the
    /// ledger matches the top-level `abi_version`.
    pub fn validate_archive_abi_versions(&self) -> Result<(), String> {
        for pkg in &self.packages {
            for (arch, entry) in &pkg.binary {
                for (field, value) in [
                    ("archive_url", &entry.archive_url),
                    ("fallback_archive_url", &entry.fallback_archive_url),
                ] {
                    let Some(value) = value else {
                        continue;
                    };
                    let Some(found) = archive_filename_abi(value) else {
                        continue;
                    };
                    if found != self.abi_version {
                        return Err(format!(
                            "index.toml abi_version {} does not match {field} ABI {found} \
                             for {}@{} {}: {value}",
                            self.abi_version,
                            pkg.name,
                            pkg.version,
                            arch.as_str()
                        ));
                    }
                }
            }
        }
        Ok(())
    }

    /// Remove per-arch entries that reference archive filenames for a
    /// different ABI than `expected_abi`. Used when a mutable staging
    /// release is reused across an ABI bump.
    pub fn prune_archive_abi_mismatches(&mut self, expected_abi: u32) -> usize {
        let mut removed = 0;
        for pkg in &mut self.packages {
            let before = pkg.binary.len();
            pkg.binary
                .retain(|_, entry| !entry_declares_different_abi(entry, expected_abi));
            removed += before - pkg.binary.len();
        }
        self.packages.retain(|pkg| !pkg.binary.is_empty());
        removed
    }

    /// Remove every version block for `name` except `keep_version`.
    ///
    /// A registry owns one active recipe version for a package name. Batched
    /// staging starts from a complete last-green index, so a version bump must
    /// replace that old block before the current result is applied. Keeping
    /// both blocks would make lookup order significant and would make a
    /// supposedly complete staging snapshot fail the managed-package split
    /// check.
    pub fn retain_package_version(&mut self, name: &str, keep_version: &str) -> usize {
        let before = self.packages.len();
        self.packages
            .retain(|package| package.name != name || package.version == keep_version);
        before - self.packages.len()
    }

    /// Record a successful build. Overwrites the current archive
    /// fields and clears any prior fallback — once a fresh success
    /// lands, the fallback (which existed only to cover for a
    /// preceding failure) is no longer needed.
    #[allow(clippy::too_many_arguments)]
    pub fn update_entry_success(
        &mut self,
        name: &str,
        version: &str,
        revision: u32,
        arch: TargetArch,
        archive_url: String,
        archive_sha256: String,
        cache_key_sha: String,
        built_at: String,
        built_by: String,
    ) {
        let entry = self.entry_mut(name, version, revision, arch);
        entry.status = EntryStatus::Success;
        entry.archive_url = Some(archive_url);
        entry.archive_sha256 = Some(archive_sha256);
        entry.cache_key_sha = Some(cache_key_sha);
        entry.built_at = Some(built_at);
        entry.built_by = Some(built_by);
        entry.error = None;
        entry.last_attempt = None;
        entry.last_attempt_by = None;
        entry.fallback_archive_url = None;
        entry.fallback_archive_sha256 = None;
        entry.fallback_cache_key_sha = None;
        entry.fallback_built_at = None;
    }

    /// Record a failed build. If the previous status was Success AND
    /// no fallback already exists, the current archive fields are
    /// moved into the `fallback_*` slots (last-green preservation).
    /// If a fallback already exists, we keep it — fallbacks are the
    /// LAST KNOWN GOOD archive; overwriting with the result of a
    /// later failed-then-rebuilt-and-failed-again sequence would
    /// erase the only working copy. After moving (or skipping),
    /// `archive_*` is cleared and the failure metadata recorded.
    pub fn update_entry_failed(
        &mut self,
        name: &str,
        version: &str,
        revision: u32,
        arch: TargetArch,
        error: String,
        last_attempt: String,
        last_attempt_by: String,
    ) {
        let entry = self.entry_mut(name, version, revision, arch);
        if entry.status == EntryStatus::Success && entry.fallback_archive_url.is_none() {
            entry.fallback_archive_url = entry.archive_url.take();
            entry.fallback_archive_sha256 = entry.archive_sha256.take();
            entry.fallback_cache_key_sha = entry.cache_key_sha.take();
            entry.fallback_built_at = entry.built_at.take();
        } else {
            entry.archive_url = None;
            entry.archive_sha256 = None;
            entry.cache_key_sha = None;
            entry.built_at = None;
        }
        entry.built_by = None;
        entry.status = EntryStatus::Failed;
        entry.error = Some(error);
        entry.last_attempt = Some(last_attempt);
        entry.last_attempt_by = Some(last_attempt_by);
    }

    /// Internal helper: get-or-insert the per-arch entry, creating
    /// the `[[packages]]` block if this is the first arch we've
    /// recorded for that (name, version).
    fn entry_mut(
        &mut self,
        name: &str,
        version: &str,
        revision: u32,
        arch: TargetArch,
    ) -> &mut BinaryEntry {
        let pkg_idx = match self
            .packages
            .iter()
            .position(|p| p.name == name && p.version == version)
        {
            Some(i) => {
                self.packages[i].revision = revision;
                i
            }
            None => {
                self.packages.push(PackageEntry {
                    name: name.into(),
                    version: version.into(),
                    revision,
                    binary: BTreeMap::new(),
                });
                self.packages.len() - 1
            }
        };
        self.packages[pkg_idx].binary.entry(arch).or_default()
    }

    /// Hand-format the ledger to TOML. We avoid `toml::to_string`
    /// because it alphabetizes table keys (writing `archive_sha256`
    /// before `archive_url`, `built_at` before `cache_key_sha`,
    /// etc.). The schema in design §3.4 specifies a deliberate field
    /// order — keeping it stable makes diffs of a published
    /// `index.toml` readable as an audit log of CI activity.
    pub fn write(&self) -> String {
        let mut out = String::new();
        out.push_str(&format!("abi_version = {}\n", self.abi_version));
        out.push_str(&format!(
            "generated_at = \"{}\"\n",
            escape(&self.generated_at)
        ));
        out.push_str(&format!("generator = \"{}\"\n", escape(&self.generator)));

        // Packages emitted alphabetically by (name, version) so the
        // file is stable under arbitrary insertion order.
        let mut pkgs: Vec<&PackageEntry> = self.packages.iter().collect();
        pkgs.sort_by(|a, b| (&a.name, &a.version).cmp(&(&b.name, &b.version)));

        for p in pkgs {
            out.push_str("\n[[packages]]\n");
            out.push_str(&format!("name = \"{}\"\n", escape(&p.name)));
            out.push_str(&format!("version = \"{}\"\n", escape(&p.version)));
            out.push_str(&format!("revision = {}\n", p.revision));

            // Per-arch entries in canonical arch order: wasm32 first,
            // then wasm64 (matches the BTreeMap's natural ordering
            // since the enum derives Ord with Wasm32 < Wasm64).
            for (arch, entry) in &p.binary {
                out.push_str(&format!("\n[packages.binary.{}]\n", arch.as_str()));
                out.push_str(&format!(
                    "status = \"{}\"\n",
                    match entry.status {
                        EntryStatus::Pending => "pending",
                        EntryStatus::Building => "building",
                        EntryStatus::Success => "success",
                        EntryStatus::Failed => "failed",
                    }
                ));
                // Order matches design §3.4 (success path then failure
                // metadata then fallback block). Each field skipped
                // when None.
                write_opt(&mut out, "archive_url", &entry.archive_url);
                write_opt(&mut out, "archive_sha256", &entry.archive_sha256);
                write_opt(&mut out, "cache_key_sha", &entry.cache_key_sha);
                write_opt(&mut out, "built_at", &entry.built_at);
                write_opt(&mut out, "built_by", &entry.built_by);
                write_opt(&mut out, "error", &entry.error);
                write_opt(&mut out, "last_attempt", &entry.last_attempt);
                write_opt(&mut out, "last_attempt_by", &entry.last_attempt_by);
                write_opt(
                    &mut out,
                    "fallback_archive_url",
                    &entry.fallback_archive_url,
                );
                write_opt(
                    &mut out,
                    "fallback_archive_sha256",
                    &entry.fallback_archive_sha256,
                );
                write_opt(
                    &mut out,
                    "fallback_cache_key_sha",
                    &entry.fallback_cache_key_sha,
                );
                write_opt(&mut out, "fallback_built_at", &entry.fallback_built_at);
            }
        }
        out
    }
}

/// Extract the ABI encoded in an archive filename segment like
/// `-abi13-`. Returns `None` for names that do not carry that segment.
pub fn archive_filename_abi(value: &str) -> Option<u32> {
    let mut search_start = 0;
    while let Some(pos) = value[search_start..].find("-abi") {
        let abi_start = search_start + pos + "-abi".len();
        let tail = &value[abi_start..];
        let digit_len = tail.bytes().take_while(|b| b.is_ascii_digit()).count();
        if digit_len > 0 && tail.as_bytes().get(digit_len) == Some(&b'-') {
            if let Ok(abi) = tail[..digit_len].parse() {
                return Some(abi);
            }
        }
        search_start = abi_start;
    }
    None
}

fn entry_declares_different_abi(entry: &BinaryEntry, expected_abi: u32) -> bool {
    [&entry.archive_url, &entry.fallback_archive_url]
        .into_iter()
        .flatten()
        .filter_map(|value| archive_filename_abi(value))
        .any(|found| found != expected_abi)
}

/// Compute the on-disk cache path for the index hosted at
/// `index_url`. We use the first 16 hex chars of sha256(url) so two
/// indexes with different URLs (e.g. first-party vs a fork's mirror)
/// land in distinct cache files. 16 hex chars = 64 bits — collision
/// probability is negligible for the URLs an individual developer
/// would ever cache simultaneously.
pub fn index_cache_path(index_url: &str, cache_dir: &Path) -> PathBuf {
    let mut h = Sha256::new();
    h.update(index_url.as_bytes());
    let digest: [u8; 32] = h.finalize().into();
    let key = hex(&digest);
    cache_dir.join(format!("index-{}.toml", &key[..16]))
}

/// Fetch `index.toml` from `index_url`, parse it, and persist the
/// raw bytes to an on-disk cache.
///
/// Behavior:
///   * Online (the default) — try the network fetch first. On
///     success, write the bytes to `index_cache_path(...)` so a
///     later offline run can use them. If the fetch fails (network
///     error, 4xx/5xx, parse error), fall back to the cached copy.
///   * `WASM_POSIX_OFFLINE=1` — skip the network attempt and load
///     directly from the cache.
///
/// Returns an error only when neither the network nor the cache
/// yields a parseable `IndexToml` (a cold fresh clone with no
/// internet, basically).
pub fn fetch_index(index_url: &str, cache_dir: &Path) -> Result<IndexToml, String> {
    let cache_path = index_cache_path(index_url, cache_dir);
    let offline = std::env::var_os("WASM_POSIX_OFFLINE").is_some_and(|v| !v.is_empty() && v != "0");

    if !offline {
        match crate::remote_fetch::fetch_url(index_url) {
            Ok(bytes) => {
                // Best-effort cache write; failure to write the cache
                // is not fatal — the index is already in memory and
                // the next online run will overwrite anyway.
                if let Some(parent) = cache_path.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                let _ = std::fs::write(&cache_path, &bytes);

                let s = std::str::from_utf8(&bytes)
                    .map_err(|e| format!("index.toml at {index_url} is not UTF-8: {e}"))?;
                return IndexToml::parse(s).map_err(|e| format!("index.toml at {index_url}: {e}"));
            }
            Err(e) => {
                eprintln!(
                    "warning: online fetch of {index_url} failed ({e}); \
                     trying cached copy at {}",
                    cache_path.display()
                );
            }
        }
    }

    // Fall back to cache.
    let content = std::fs::read_to_string(&cache_path).map_err(|e| {
        format!(
            "no cached copy of {index_url} at {}: {e}",
            cache_path.display()
        )
    })?;
    IndexToml::parse(&content).map_err(|e| format!("cached index {}: {e}", cache_path.display()))
}

fn write_opt(out: &mut String, key: &str, value: &Option<String>) {
    if let Some(v) = value {
        out.push_str(&format!("{key} = \"{}\"\n", escape(v)));
    }
}

/// Minimal TOML basic-string escaping: `\` and `"` need backslash
/// escapes; everything else we pass through. Schema values in
/// practice are ASCII-only filenames, sha hex, ISO-8601 timestamps,
/// and URLs — none of which carry control characters.
fn escape(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

#[cfg(test)]
mod tests {
    #[test]
    fn parses_index_toml_with_success_entry() {
        use super::*;
        use crate::pkg_manifest::TargetArch;

        let toml = r#"
abi_version  = 8
generated_at = "2026-05-13T00:00:00Z"
generator    = "test"

[[packages]]
name     = "foo"
version  = "1.0"
revision = 1

[packages.binary.wasm32]
status         = "success"
archive_url    = "foo-1.0-rev1-abi8-wasm32-abc12345.tar.zst"
archive_sha256 = "deadbeef"
cache_key_sha  = "abc12345"
built_at       = "2026-05-13T00:00:00Z"
built_by       = "https://example.com/run/1"
"#;
        let idx = IndexToml::parse(toml).unwrap();
        assert_eq!(idx.abi_version, 8);
        assert_eq!(idx.packages.len(), 1);
        let pkg = &idx.packages[0];
        assert_eq!(pkg.name, "foo");
        assert_eq!(pkg.version, "1.0");
        assert_eq!(pkg.revision, 1);
        let entry = pkg.binary.get(&TargetArch::Wasm32).unwrap();
        assert_eq!(entry.status, EntryStatus::Success);
        assert_eq!(
            entry.archive_url.as_deref(),
            Some("foo-1.0-rev1-abi8-wasm32-abc12345.tar.zst")
        );
        assert_eq!(entry.archive_sha256.as_deref(), Some("deadbeef"));
        assert_eq!(entry.cache_key_sha.as_deref(), Some("abc12345"));
    }

    #[test]
    fn parses_index_toml_with_failed_entry_and_fallback() {
        use super::*;
        use crate::pkg_manifest::TargetArch;

        let toml = r#"
abi_version  = 8
generated_at = "2026-05-13T00:00:00Z"
generator    = "test"

[[packages]]
name     = "foo"
version  = "1.0"
revision = 1

[packages.binary.wasm64]
status                  = "failed"
error                   = "linker error"
last_attempt            = "2026-05-13T00:00:00Z"
fallback_archive_url    = "foo-1.0-rev1-abi8-wasm64-old.tar.zst"
fallback_archive_sha256 = "olddeadbeef"
fallback_cache_key_sha  = "oldcachekey"
fallback_built_at       = "2026-05-12T00:00:00Z"
"#;
        let idx = IndexToml::parse(toml).unwrap();
        let entry = &idx.packages[0].binary[&TargetArch::Wasm64];
        assert_eq!(entry.status, EntryStatus::Failed);
        assert_eq!(entry.error.as_deref(), Some("linker error"));
        assert_eq!(
            entry.fallback_archive_url.as_deref(),
            Some("foo-1.0-rev1-abi8-wasm64-old.tar.zst")
        );
        assert_eq!(
            entry.fallback_archive_sha256.as_deref(),
            Some("olddeadbeef")
        );
    }

    #[test]
    fn archive_filename_abi_extracts_abi_segment() {
        use super::*;

        assert_eq!(
            archive_filename_abi("foo-1.0-rev1-abi13-wasm32-deadbeef.tar.zst"),
            Some(13)
        );
        assert_eq!(
            archive_filename_abi(
                "https://example.test/releases/download/pr-1-staging/foo-abi42-wasm64-a.tar.zst"
            ),
            Some(42)
        );
        assert_eq!(
            archive_filename_abi("https://example.test/binaries-abi-v13/foo.tar.zst"),
            None
        );
        assert_eq!(archive_filename_abi("foo-no-abi-segment.tar.zst"), None);
    }

    #[test]
    fn index_toml_validate_archive_abi_versions_rejects_current_mismatch() {
        use super::*;

        let idx = IndexToml::parse(
            r#"
abi_version = 13
generated_at = "t"
generator = "test"

[[packages]]
name = "foo"
version = "1.0"
revision = 1

[packages.binary.wasm32]
status = "success"
archive_url = "foo-1.0-rev1-abi12-wasm32-deadbeef.tar.zst"
archive_sha256 = "sha"
cache_key_sha = "key"
"#,
        )
        .unwrap();

        let err = idx.validate_archive_abi_versions().unwrap_err();
        assert!(err.contains("abi_version 13"), "got: {err}");
        assert!(err.contains("ABI 12"), "got: {err}");
        assert!(err.contains("archive_url"), "got: {err}");
    }

    #[test]
    fn index_toml_validate_archive_abi_versions_rejects_fallback_mismatch() {
        use super::*;

        let idx = IndexToml::parse(
            r#"
abi_version = 13
generated_at = "t"
generator = "test"

[[packages]]
name = "foo"
version = "1.0"
revision = 1

[packages.binary.wasm32]
status = "failed"
error = "build failed"
last_attempt = "t"
fallback_archive_url = "foo-1.0-rev1-abi12-wasm32-deadbeef.tar.zst"
fallback_archive_sha256 = "sha"
fallback_cache_key_sha = "key"
"#,
        )
        .unwrap();

        let err = idx.validate_archive_abi_versions().unwrap_err();
        assert!(err.contains("fallback_archive_url"), "got: {err}");
        assert!(err.contains("ABI 12"), "got: {err}");
    }

    #[test]
    fn index_toml_prunes_archive_entries_for_other_abis() {
        use super::*;
        use crate::pkg_manifest::TargetArch;

        let mut idx = IndexToml::parse(
            r#"
abi_version = 12
generated_at = "t"
generator = "test"

[[packages]]
name = "old"
version = "1.0"
revision = 1

[packages.binary.wasm32]
status = "success"
archive_url = "old-1.0-rev1-abi12-wasm32-deadbeef.tar.zst"
archive_sha256 = "oldsha"
cache_key_sha = "oldkey"

[[packages]]
name = "new"
version = "1.0"
revision = 1

[packages.binary.wasm32]
status = "success"
archive_url = "new-1.0-rev1-abi13-wasm32-deadbeef.tar.zst"
archive_sha256 = "newsha"
cache_key_sha = "newkey"
"#,
        )
        .unwrap();

        idx.abi_version = 13;
        let removed = idx.prune_archive_abi_mismatches(13);
        assert_eq!(removed, 1);
        assert!(idx.lookup("old", "1.0", TargetArch::Wasm32).is_none());
        assert!(idx.lookup("new", "1.0", TargetArch::Wasm32).is_some());
        idx.validate_archive_abi_versions().unwrap();
    }

    #[test]
    fn index_toml_round_trips_semantic_equality() {
        use super::*;

        let original = r#"
abi_version = 8
generated_at = "2026-05-13T00:00:00Z"
generator    = "test"

[[packages]]
name     = "foo"
version  = "1.0"
revision = 1

[packages.binary.wasm32]
status         = "success"
archive_url    = "foo.tar.zst"
archive_sha256 = "abc"
cache_key_sha  = "def"
built_at       = "2026-05-13T00:00:00Z"
built_by       = "https://example.com/run/1"
"#;
        let idx = IndexToml::parse(original).unwrap();
        let written = idx.write();
        let reparsed = IndexToml::parse(&written).unwrap();
        assert_eq!(reparsed, idx, "round-trip must preserve all fields");

        // Field order in the written output: `archive_url` precedes
        // `archive_sha256` precedes `cache_key_sha`. Schema order; not
        // alphabetical (which is what toml::to_string would do).
        let url_pos = written.find("archive_url").unwrap();
        let sha_pos = written.find("archive_sha256").unwrap();
        let ck_pos = written.find("cache_key_sha").unwrap();
        assert!(
            url_pos < sha_pos,
            "archive_url must come before archive_sha256"
        );
        assert!(
            sha_pos < ck_pos,
            "archive_sha256 must come before cache_key_sha"
        );
    }

    #[test]
    fn index_toml_write_sorts_packages_alphabetically() {
        use super::*;
        let mut idx = IndexToml::parse(
            r#"
abi_version = 8
generated_at = "t"
generator    = "test"

[[packages]]
name     = "zlib"
version  = "1.0"
revision = 1

[[packages]]
name     = "alpha"
version  = "0.1"
revision = 1
"#,
        )
        .unwrap();
        let _ = &mut idx; // silence unused-mut warning if any
        let s = idx.write();
        let alpha_pos = s.find("name = \"alpha\"").unwrap();
        let zlib_pos = s.find("name = \"zlib\"").unwrap();
        assert!(
            alpha_pos < zlib_pos,
            "packages must be alphabetized on write"
        );
    }

    #[test]
    fn update_entry_success_overwrites_current_and_clears_fallback() {
        use super::*;
        use crate::pkg_manifest::TargetArch;

        let mut idx = IndexToml::empty(8, "now".into(), "test".into());
        idx.update_entry_success(
            "foo",
            "1.0",
            1,
            TargetArch::Wasm32,
            "foo-new.tar.zst".into(),
            "newsha".into(),
            "newkey".into(),
            "now".into(),
            "run-url".into(),
        );
        let entry = idx.lookup("foo", "1.0", TargetArch::Wasm32).unwrap();
        assert_eq!(entry.status, EntryStatus::Success);
        assert_eq!(entry.archive_url.as_deref(), Some("foo-new.tar.zst"));
        assert!(entry.fallback_archive_url.is_none());
    }

    #[test]
    fn update_entry_success_refreshes_existing_package_revision() {
        use super::*;
        use crate::pkg_manifest::TargetArch;

        let mut idx = IndexToml::empty(8, "now".into(), "test".into());
        idx.update_entry_success(
            "foo",
            "1.0",
            1,
            TargetArch::Wasm32,
            "foo-rev1.tar.zst".into(),
            "sha-v1".into(),
            "key-v1".into(),
            "t1".into(),
            "run1".into(),
        );
        idx.update_entry_success(
            "foo",
            "1.0",
            2,
            TargetArch::Wasm32,
            "foo-rev2.tar.zst".into(),
            "sha-v2".into(),
            "key-v2".into(),
            "t2".into(),
            "run2".into(),
        );

        let pkg = idx
            .packages
            .iter()
            .find(|p| p.name == "foo" && p.version == "1.0")
            .unwrap();
        assert_eq!(pkg.revision, 2);
        assert_eq!(idx.packages.len(), 1);
    }

    #[test]
    fn update_entry_failed_moves_current_to_fallback() {
        use super::*;
        use crate::pkg_manifest::TargetArch;

        let mut idx = IndexToml::empty(8, "now".into(), "test".into());
        // First publish a success.
        idx.update_entry_success(
            "foo",
            "1.0",
            1,
            TargetArch::Wasm32,
            "foo-good.tar.zst".into(),
            "goodsha".into(),
            "goodkey".into(),
            "t1".into(),
            "run1".into(),
        );
        // Then fail a rebuild.
        idx.update_entry_failed(
            "foo",
            "1.0",
            1,
            TargetArch::Wasm32,
            "linker error".into(),
            "t2".into(),
            "run2".into(),
        );
        let entry = idx.lookup("foo", "1.0", TargetArch::Wasm32).unwrap();
        assert_eq!(entry.status, EntryStatus::Failed);
        assert_eq!(entry.error.as_deref(), Some("linker error"));
        assert!(
            entry.archive_url.is_none(),
            "archive_url cleared on failure"
        );
        assert_eq!(
            entry.fallback_archive_url.as_deref(),
            Some("foo-good.tar.zst"),
            "previous good archive moved to fallback"
        );
        assert_eq!(entry.fallback_archive_sha256.as_deref(), Some("goodsha"));
    }

    #[test]
    fn update_entry_failed_with_no_prior_success_has_no_fallback() {
        use super::*;
        use crate::pkg_manifest::TargetArch;

        let mut idx = IndexToml::empty(8, "now".into(), "test".into());
        // First-ever attempt fails — no prior success to fall back to.
        idx.update_entry_failed(
            "foo",
            "1.0",
            1,
            TargetArch::Wasm32,
            "first error".into(),
            "t1".into(),
            "run1".into(),
        );
        let entry = idx.lookup("foo", "1.0", TargetArch::Wasm32).unwrap();
        assert_eq!(entry.status, EntryStatus::Failed);
        assert!(entry.fallback_archive_url.is_none());
    }

    #[test]
    fn update_entry_failed_preserves_existing_fallback() {
        use super::*;
        use crate::pkg_manifest::TargetArch;

        let mut idx = IndexToml::empty(8, "now".into(), "test".into());
        // success → failed (fallback set from the first success)
        idx.update_entry_success(
            "foo",
            "1.0",
            1,
            TargetArch::Wasm32,
            "foo-v1.tar.zst".into(),
            "sha-v1".into(),
            "key-v1".into(),
            "t1".into(),
            "run1".into(),
        );
        idx.update_entry_failed(
            "foo",
            "1.0",
            1,
            TargetArch::Wasm32,
            "err1".into(),
            "t2".into(),
            "run2".into(),
        );
        // Another rebuild fails — the original last-green must
        // survive (we never overwrite a fallback because that's the
        // last working copy consumers can still fetch).
        idx.update_entry_failed(
            "foo",
            "1.0",
            1,
            TargetArch::Wasm32,
            "err2".into(),
            "t3".into(),
            "run3".into(),
        );
        let entry = idx.lookup("foo", "1.0", TargetArch::Wasm32).unwrap();
        assert_eq!(entry.status, EntryStatus::Failed);
        assert_eq!(entry.error.as_deref(), Some("err2"));
        assert_eq!(
            entry.fallback_archive_url.as_deref(),
            Some("foo-v1.tar.zst"),
            "the original good archive must remain the fallback"
        );
    }

    #[test]
    fn update_entry_success_after_failed_clears_fallback() {
        use super::*;
        use crate::pkg_manifest::TargetArch;

        let mut idx = IndexToml::empty(8, "now".into(), "test".into());
        idx.update_entry_success(
            "foo",
            "1.0",
            1,
            TargetArch::Wasm32,
            "foo-v1.tar.zst".into(),
            "sha-v1".into(),
            "key-v1".into(),
            "t1".into(),
            "run1".into(),
        );
        idx.update_entry_failed(
            "foo",
            "1.0",
            1,
            TargetArch::Wasm32,
            "err".into(),
            "t2".into(),
            "run2".into(),
        );
        idx.update_entry_success(
            "foo",
            "1.0",
            1,
            TargetArch::Wasm32,
            "foo-v2.tar.zst".into(),
            "sha-v2".into(),
            "key-v2".into(),
            "t3".into(),
            "run3".into(),
        );
        let entry = idx.lookup("foo", "1.0", TargetArch::Wasm32).unwrap();
        assert_eq!(entry.archive_url.as_deref(), Some("foo-v2.tar.zst"));
        assert!(
            entry.fallback_archive_url.is_none(),
            "a fresh success makes the fallback obsolete"
        );
        assert!(entry.error.is_none());
    }

    #[test]
    fn fetch_index_reads_file_url_and_writes_cache() {
        use super::*;

        let tmp = std::env::temp_dir().join(format!(
            "wpk-xtask-idx-fetch-{}-{}",
            std::process::id(),
            line!()
        ));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let cache_dir = tmp.join("cache");
        let idx_path = tmp.join("source-index.toml");

        let content = r#"abi_version = 8
generated_at = "test-fresh"
generator = "test"
"#;
        std::fs::write(&idx_path, content).unwrap();
        let url = format!("file://{}", idx_path.display());

        let idx = fetch_index(&url, &cache_dir).unwrap();
        assert_eq!(idx.abi_version, 8);
        assert_eq!(idx.generated_at, "test-fresh");

        // Cache file should have appeared after the successful fetch.
        let cache_path = index_cache_path(&url, &cache_dir);
        assert!(
            cache_path.is_file(),
            "expected cache file at {}",
            cache_path.display()
        );
    }

    #[test]
    fn fetch_index_falls_back_to_cache_when_offline() {
        use super::*;

        let tmp = std::env::temp_dir().join(format!(
            "wpk-xtask-idx-fetch-offline-{}-{}",
            std::process::id(),
            line!()
        ));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let cache_dir = tmp.join("cache");
        std::fs::create_dir_all(&cache_dir).unwrap();

        // Seed the cache manually as if a prior online fetch ran.
        let url = "https://example.test/abi-v8/index.toml";
        let cache_path = index_cache_path(url, &cache_dir);
        std::fs::write(
            &cache_path,
            r#"abi_version = 8
generated_at = "cached-ts"
generator = "cached"
"#,
        )
        .unwrap();

        // Force offline so the fetcher refuses HTTP and falls back.
        // SAFETY: env-var mutation is `unsafe` on the 2024 edition;
        // the test serializes itself via the env-var name (no other
        // test toggles WASM_POSIX_OFFLINE concurrently) and restores
        // on the way out.
        unsafe { std::env::set_var("WASM_POSIX_OFFLINE", "1") };
        let idx_res = fetch_index(url, &cache_dir);
        unsafe { std::env::remove_var("WASM_POSIX_OFFLINE") };

        let idx = idx_res.unwrap();
        assert_eq!(idx.generator, "cached", "offline fallback must use cache");
    }

    #[test]
    fn fetch_index_errors_when_no_cache_and_offline() {
        use super::*;

        let tmp = std::env::temp_dir().join(format!(
            "wpk-xtask-idx-fetch-cold-{}-{}",
            std::process::id(),
            line!()
        ));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let cache_dir = tmp.join("cache");

        unsafe { std::env::set_var("WASM_POSIX_OFFLINE", "1") };
        let res = fetch_index("https://example.test/never-cached/index.toml", &cache_dir);
        unsafe { std::env::remove_var("WASM_POSIX_OFFLINE") };

        let err = res.unwrap_err();
        assert!(err.contains("no cached copy"), "got: {err}");
    }

    #[test]
    fn index_cache_path_distinguishes_urls() {
        use super::*;
        let cache = PathBuf::from("/tmp/cache");
        let a = index_cache_path("https://a.example/index.toml", &cache);
        let b = index_cache_path("https://b.example/index.toml", &cache);
        assert_ne!(a, b, "different URLs must land in different cache files");
    }

    #[test]
    fn index_toml_write_omits_none_fields() {
        use super::*;
        use crate::pkg_manifest::TargetArch;

        let mut idx = IndexToml {
            abi_version: 8,
            generated_at: "now".into(),
            generator: "test".into(),
            packages: vec![PackageEntry {
                name: "foo".into(),
                version: "1.0".into(),
                revision: 1,
                binary: Default::default(),
            }],
        };
        idx.packages[0].binary.insert(
            TargetArch::Wasm32,
            BinaryEntry {
                status: EntryStatus::Pending,
                ..Default::default()
            },
        );
        let s = idx.write();
        assert!(
            !s.contains("archive_url"),
            "absent fields must not be emitted"
        );
        assert!(!s.contains("error"), "absent fields must not be emitted");
        assert!(s.contains("status = \"pending\""));
    }
}
