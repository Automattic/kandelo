//! Finds workaround tags in tracked source files.
//!
//! The literal tag prefix is assembled with `concat!` so that this crate's own
//! source never contains it: the scan covers every tracked file, including
//! this one, and a bare mention would count as a malformed tag.

use regex::Regex;
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::process::Command;

pub const TAG_WORD: &str = concat!("RUNTIME", "-WORKAROUND");

/// Paths whose text describes tags rather than using them.
const EXCLUDED_PREFIXES: &[&str] = &["tests/runtime-workarounds/", "docs/superpowers/"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TagSite {
    pub path: PathBuf,
    pub line: usize,
    pub id: String,
}

#[derive(Debug, Default)]
pub struct Scan {
    /// Well-formed tags, one per tag (two on a line count twice).
    pub tags: Vec<TagSite>,
    /// Bare `[ID]` forms of registered IDs; `id` is that ID.
    pub legacy: Vec<TagSite>,
    /// Lines with a bracketed tag opening that is not a well-formed tag; `id` is empty.
    pub malformed: Vec<TagSite>,
}

/// Repo-relative paths of tracked files, from the index.
pub fn tracked_files(repo: &Path) -> Result<Vec<String>, String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(["ls-files", "-z"])
        .output()
        .map_err(|e| format!("run git ls-files: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "git ls-files failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(out
        .stdout
        .split(|b| *b == 0)
        .filter(|p| !p.is_empty())
        .filter_map(|p| std::str::from_utf8(p).ok())
        .map(str::to_string)
        .collect())
}

pub fn scan(repo: &Path, known_ids: &BTreeSet<String>) -> Result<Scan, String> {
    let strict = Regex::new(&format!(
        r"\[{TAG_WORD}: ([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+)\]"
    ))
    .expect("tag regex is valid");
    // Only a bracketed opening is a tag attempt; prose may name the tag.
    let opening = Regex::new(&format!(r"\[{TAG_WORD}")).expect("opening regex is valid");
    // The documentation form shown in guides is a pattern, not a tag.
    let placeholder =
        Regex::new(&format!(r"\[{TAG_WORD}: <ID>\]")).expect("placeholder regex is valid");
    let legacy = if known_ids.is_empty() {
        None
    } else {
        let alternation = known_ids
            .iter()
            .map(|id| regex::escape(id))
            .collect::<Vec<_>>()
            .join("|");
        Some(Regex::new(&format!(r"\[({alternation})\]")).expect("legacy regex is valid"))
    };

    let mut result = Scan::default();
    for rel in tracked_files(repo)? {
        if EXCLUDED_PREFIXES.iter().any(|p| rel.starts_with(p)) {
            continue;
        }
        let path = repo.join(&rel);
        // Deleted-but-tracked files and submodule directories are not source.
        if !path.is_file() {
            continue;
        }
        let bytes = std::fs::read(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
        // Binary fixtures cannot carry a comment tag.
        let Ok(text) = std::str::from_utf8(&bytes) else {
            continue;
        };
        for (index, line) in text.lines().enumerate() {
            let site = |id: &str| TagSite {
                path: PathBuf::from(&rel),
                line: index + 1,
                id: id.to_string(),
            };
            let mut accounted: BTreeSet<usize> = BTreeSet::new();
            for caps in strict.captures_iter(line) {
                accounted.insert(caps.get(0).expect("whole match").start());
                result.tags.push(site(&caps[1]));
            }
            accounted.extend(placeholder.find_iter(line).map(|m| m.start()));
            if opening.find_iter(line).any(|m| !accounted.contains(&m.start())) {
                result.malformed.push(site(""));
            }
            if let Some(legacy) = &legacy {
                for caps in legacy.captures_iter(line) {
                    result.legacy.push(site(&caps[1]));
                }
            }
        }
    }
    Ok(result)
}
