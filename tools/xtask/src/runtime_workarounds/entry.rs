//! The machine-readable half of a registry entry (`entry.toml`).
//!
//! The schema is strict (`deny_unknown_fields`) so a misspelt field is a loud
//! parse error instead of a silently ignored claim about a runtime.

use serde::{Deserialize, Serialize};
use std::path::Path;

/// Runtimes and tools a reproduction may target: the three Playwright engines,
/// the JavaScript hosts, and the toolchain programs Kandelo builds with.
pub const TARGETS: &[&str] = &[
    "chromium", "firefox", "webkit", "node", "bun", "clang", "wasm-ld", "wasm-opt", "rustc",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Kind {
    Bug,
    Gap,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Status {
    Suspected,
    Confirmed,
    Reported,
    FixedUpstream,
    Retired,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ReportPolicy {
    /// Reports are filed by a person; the default.
    #[default]
    HumanOnly,
    AgentsAllowed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ReproKind {
    BrowserPage,
    Script,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Verdict {
    Reproduced,
    NotReproduced,
    Inconclusive,
}

fn one() -> u32 {
    1
}

fn default_timeout_seconds() -> u32 {
    120
}

fn manual() -> String {
    "manual".to_string()
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Repro {
    pub kind: ReproKind,
    /// File under the entry's `repro/` directory that the runner launches.
    pub entry: String,
    pub targets: Vec<String>,
    /// Only a repro that reports its own verdict may back a non-suspected
    /// entry; one that needs a manual observation is evidence, not a check.
    pub self_judging: bool,
    #[serde(default = "one")]
    pub attempts: u32,
    #[serde(default = "one")]
    pub min_reproduced: u32,
    #[serde(default = "default_timeout_seconds")]
    pub timeout_seconds: u32,
    #[serde(default)]
    pub crash_is_reproduced: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Observation {
    pub runtime: String,
    pub version: String,
    /// Part of the key: a defect can be specific to one host OS.
    pub os: String,
    pub reproduced: bool,
    pub date: toml::value::Datetime,
    /// `"suite"` (written from a suite run) or `"manual"`.
    #[serde(default = "manual")]
    pub source: String,
    /// A released runtime or tool version, as opposed to a development build;
    /// `fixed-upstream` needs a released version that no longer reproduces.
    #[serde(default)]
    pub released: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Upstream {
    pub project: String,
    pub url: String,
    pub filed: toml::value::Datetime,
    pub filed_by: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SiteWithoutTag {
    pub path: String,
    pub note: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Entry {
    pub id: String,
    pub kind: Kind,
    pub status: Status,
    pub runtimes: Vec<String>,
    pub summary: String,
    #[serde(default)]
    pub reports: ReportPolicy,
    #[serde(default)]
    pub reports_channel: Option<String>,
    #[serde(default)]
    pub retired_reason: Option<String>,
    #[serde(default)]
    pub retired_commit: Option<String>,
    #[serde(default)]
    pub repro: Option<Repro>,
    #[serde(default)]
    pub observed: Vec<Observation>,
    #[serde(default)]
    pub upstream: Vec<Upstream>,
    #[serde(default)]
    pub sites_without_tags: Vec<SiteWithoutTag>,
}

/// Load every `<registry>/<dir>/entry.toml`, sorted by directory name.
/// Directories starting with `_` hold fixtures and are skipped. A registry
/// directory that does not exist yet has no entries.
pub fn load_entries(registry: &Path) -> Result<Vec<(String, Entry)>, String> {
    let read = match std::fs::read_dir(registry) {
        Ok(read) => read,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("read {}: {e}", registry.display())),
    };
    let mut out = Vec::new();
    for dirent in read {
        let dirent = dirent.map_err(|e| format!("read {}: {e}", registry.display()))?;
        let name = dirent.file_name().to_string_lossy().into_owned();
        let toml_path = dirent.path().join("entry.toml");
        if name.starts_with('_') || !dirent.path().is_dir() || !toml_path.is_file() {
            continue;
        }
        let text = std::fs::read_to_string(&toml_path)
            .map_err(|e| format!("read {}: {e}", toml_path.display()))?;
        let entry: Entry =
            toml::from_str(&text).map_err(|e| format!("parse {}: {e}", toml_path.display()))?;
        out.push((name, entry));
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(out)
}
