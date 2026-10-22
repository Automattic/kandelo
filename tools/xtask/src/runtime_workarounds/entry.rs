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

impl std::fmt::Display for Status {
    /// The spelling used in `entry.toml`, so messages quote what the file says.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Status::Suspected => "suspected",
            Status::Confirmed => "confirmed",
            Status::Reported => "reported",
            Status::FixedUpstream => "fixed-upstream",
            Status::Retired => "retired",
        })
    }
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

/// What reading the registry directory found. `broken` holds one message per
/// entry directory that could not be loaded, so `check` can report them next
/// to every other problem instead of stopping at the first.
pub struct Loaded {
    pub entries: Vec<(String, Entry)>,
    pub broken: Vec<String>,
}

/// Read every `<registry>/<dir>/entry.toml`, sorted by directory name.
/// Directories starting with `_` hold fixtures and are skipped. A registry
/// directory that does not exist yet has no entries.
pub fn load_registry(registry: &Path) -> Result<Loaded, String> {
    let mut loaded = Loaded {
        entries: Vec::new(),
        broken: Vec::new(),
    };
    let read = match std::fs::read_dir(registry) {
        Ok(read) => read,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(loaded),
        Err(e) => return Err(format!("read {}: {e}", registry.display())),
    };
    let mut dirs = Vec::new();
    for dirent in read {
        let dirent = dirent.map_err(|e| format!("read {}: {e}", registry.display()))?;
        let name = dirent.file_name().to_string_lossy().into_owned();
        if !name.starts_with('_') && dirent.path().is_dir() {
            dirs.push(name);
        }
    }
    dirs.sort();
    for name in dirs {
        let toml_path = registry.join(&name).join("entry.toml");
        // The directory name is what `check` and its readers can act on.
        let shown = format!("{name}/entry.toml");
        if !toml_path.is_file() {
            loaded.broken.push(format!("{name}: missing entry.toml"));
            continue;
        }
        let text = match std::fs::read_to_string(&toml_path) {
            Ok(text) => text,
            Err(e) => {
                loaded.broken.push(format!("{shown}: read failed: {e}"));
                continue;
            }
        };
        match toml::from_str::<Entry>(&text) {
            Ok(entry) => loaded.entries.push((name, entry)),
            Err(e) => loaded.broken.push(format!("{shown}: parse error: {e}")),
        }
    }
    Ok(loaded)
}

/// Every loadable entry, or an error naming the first directory that is not.
pub fn load_entries(registry: &Path) -> Result<Vec<(String, Entry)>, String> {
    let loaded = load_registry(registry)?;
    match loaded.broken.first() {
        Some(first) => Err(first.clone()),
        None => Ok(loaded.entries),
    }
}
