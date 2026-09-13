// NOT YET CALLED, and the warning that says so is accurate. This is the first
// half of the `staged-product-inputs.ts` port: the rules and the plan, which
// are pure and can be tested and perturbed on their own. The half that calls
// them — an `xtask` verb that extracts an archive tree into a staging
// directory, with the atomicity and size bounds `archive_extract_member`
// already models for a single member — is the next increment, and until it
// lands these are dead.
//
// Allowed rather than left as build noise because a warning nobody can act on
// this session is a warning everybody learns to scroll past. Named here so it
// is removed by the increment that makes it false, not by someone tidying.
#![allow(dead_code)]

//! The path rules an archive's entries must satisfy before anything is written.
//!
//! Ported from `images/vfs/scripts/staged-product-inputs.ts`, which the lane Y
//! census identified as mechanism rather than product configuration: archive
//! extraction and path-traversal defence over UNTRUSTED input, in the largest
//! file under `images/`. The maintainer's call is that such files become Rust
//! tools rather than being extended in TypeScript.
//!
//! # Why these three rules and not the extraction around them
//!
//! Extraction touches the disk; these rules do not. They are pure functions
//! from a path to a verdict, which makes them the half that can be ported,
//! tested and perturbed on its own — and the half where a mistake is a security
//! bug rather than a failed build. The disk-touching remainder follows once
//! this is proven.
//!
//! # What "unsafe" means here, exactly
//!
//! An archive entry names where its bytes will land. The rules below refuse any
//! name that could land them somewhere the extractor did not choose: absolute
//! paths, `..` traversal, empty or `.` components, backslashes (which a
//! Windows-authored archive may use as separators and a POSIX extractor will
//! not), and NUL (which truncates a path in any C API it is later handed to).

/// Split an archive entry's path into components, refusing any path that could
/// escape the directory it is being extracted into.
///
/// A trailing slash is accepted and dropped, because that is how an archive
/// spells a directory entry; everything else about the path must already be
/// canonical. Normalising `..` away rather than refusing it would silently
/// relocate an entry, which is worse than a build that stops.
pub fn normalized_components(path: &str, label: &str) -> Result<Vec<String>, String> {
    let normalized = path.strip_suffix('/').unwrap_or(path);
    if normalized.is_empty()
        // NOT MUTATION-TESTABLE, and measured rather than assumed: an absolute
        // path always splits to a leading EMPTY component, so the rule below
        // refuses every one of `/etc/passwd`, `/`, `/a/`, `//a` and `/a//b`
        // with this line deleted. A trial for it survives every time.
        //
        // It stays anyway. It states the intent a reader should find here, and
        // it is the line that keeps absolute paths refused if the component
        // rule is ever narrowed. Redundancy in a traversal defence is not the
        // same fault as redundancy elsewhere.
        || normalized.starts_with('/')
        || normalized.contains('\\')
        || normalized.contains('\0')
    {
        return Err(format!("{label} contains unsafe archive path {path:?}"));
    }
    let components: Vec<String> = normalized.split('/').map(str::to_string).collect();
    if components
        .iter()
        .any(|item| item.is_empty() || item == "." || item == "..")
    {
        return Err(format!("{label} contains unsafe archive path {path:?}"));
    }
    Ok(components)
}

/// The single top-level directory every entry shares.
///
/// Refuses an archive whose entries do not agree on one root, and one that has
/// a root but nothing beneath it — because "strip the single root" is only
/// meaningful when there is exactly one and it actually contains the payload.
pub fn common_root(paths: &[String], label: &str) -> Result<String, String> {
    let mut root: Option<String> = None;
    let mut has_child = false;
    for path in paths {
        let components = normalized_components(path, label)?;
        if components.len() > 1 {
            has_child = true;
        }
        match &root {
            None => root = Some(components[0].clone()),
            Some(first) if *first != components[0] => {
                return Err(format!("{label} does not have one exact top-level directory"));
            }
            Some(_) => {}
        }
    }
    match root {
        Some(root) if has_child => Ok(root),
        _ => Err(format!("{label} has no files below its top-level directory")),
    }
}

/// Re-root an entry beneath `root`, or `None` when the entry IS the root.
///
/// The re-check that the entry still begins with `root` is not redundant with
/// [`common_root`]: that function is given the paths an archive claims, and
/// this one is given each path again at the moment it is used. An entry that
/// changed between the two would otherwise be re-rooted somewhere else.
pub fn strip_root(path: &str, root: &str, label: &str) -> Result<Option<String>, String> {
    let components = normalized_components(path, label)?;
    if components[0] != root {
        return Err(format!("{label} entry moved outside its top-level directory"));
    }
    if components.len() == 1 {
        return Ok(None);
    }
    Ok(Some(components[1..].join("/")))
}

/// What an archive entry becomes once its path has been judged.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PlannedEntry {
    /// Where it lands, relative to the extraction directory.
    pub path: String,
    pub is_directory: bool,
    pub mode: u32,
}

/// One archive entry as the planner needs it, whatever parsed it.
#[derive(Clone, Debug)]
pub struct SourceEntry {
    pub path: String,
    pub is_directory: bool,
    /// Refused rather than followed. A link inside an archive names a target
    /// the archive does not control, and resolving one is how an extractor
    /// writes outside itself even when every PATH was safe.
    pub is_link: bool,
    pub mode: u32,
}

/// Decide where every entry lands, before anything is written.
///
/// Planning first is not tidiness: an entry refused halfway through extraction
/// leaves a partial tree that a later step will happily build on. The same
/// reason the lazy-archive registrar plans its whole archive first.
pub fn plan_entries(
    entries: &[SourceEntry],
    label: &str,
    strip_single_root: bool,
    expected_root: Option<&str>,
) -> Result<Vec<PlannedEntry>, String> {
    let root = if strip_single_root {
        let paths: Vec<String> = entries.iter().map(|entry| entry.path.clone()).collect();
        Some(common_root(&paths, label)?)
    } else {
        None
    };
    if let (Some(expected), Some(actual)) = (expected_root, root.as_deref()) {
        if expected != actual {
            return Err(format!(
                "{label} has top-level directory {actual}, expected {expected}"
            ));
        }
    }
    // An expected root with nothing to compare it against is a caller asking a
    // question this plan cannot answer, not a silent pass.
    if expected_root.is_some() && root.is_none() {
        return Err(format!("{label} cannot be checked for a top-level directory"));
    }

    let mut planned = Vec::new();
    for entry in entries {
        if entry.is_link {
            return Err(format!("{label} contains unsupported link {}", entry.path));
        }
        let relative = match &root {
            None => normalized_components(&entry.path, label)?.join("/"),
            Some(root) => match strip_root(&entry.path, root, label)? {
                // The root directory entry itself: there is nothing left of it
                // once the root is stripped, so it names no destination.
                None => continue,
                Some(relative) => relative,
            },
        };
        planned.push(PlannedEntry {
            path: relative,
            is_directory: entry.is_directory,
            mode: entry.mode,
        });
    }
    Ok(planned)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_path_that_could_escape_is_refused_rather_than_normalised() {
        // Each of these would land bytes outside the extraction directory, and
        // each is refused by name rather than repaired: rewriting `..` away
        // would silently relocate an entry, which a build cannot notice.
        for path in [
            "../etc/passwd",
            "a/../../etc/passwd",
            "/etc/passwd",
            "a\\b",
            "a/./b",
            "a//b",
            "",
            "/",
        ] {
            assert!(
                normalized_components(path, "fixture").is_err(),
                "{path:?} must be refused",
            );
        }
        // NUL separately: it survives a Rust string and truncates the path in
        // whatever C API eventually receives it.
        assert!(normalized_components("a\0b", "fixture").is_err());
    }

    #[test]
    fn a_directory_entrys_trailing_slash_is_accepted_and_dropped() {
        // How an archive spells a directory. Refusing it would reject every
        // well-formed tar; keeping it would produce an empty last component,
        // which the rule above refuses.
        assert_eq!(
            normalized_components("pkg/lib/", "fixture").expect("accepted"),
            ["pkg", "lib"],
        );
    }

    #[test]
    fn one_top_level_directory_is_required_and_must_contain_something() {
        let one = ["pkg/".to_string(), "pkg/bin/tool".to_string()];
        assert_eq!(common_root(&one, "fixture").expect("root"), "pkg");

        // Two roots: stripping either would move the other's entries.
        let two = ["pkg/bin/tool".to_string(), "other/bin/tool".to_string()];
        assert!(common_root(&two, "fixture").is_err());

        // A root with nothing beneath it. Stripping it would leave no entries
        // at all, so the archive is not the shape the caller asked for.
        let bare = ["pkg/".to_string()];
        assert!(common_root(&bare, "fixture").is_err());
    }

    #[test]
    fn stripping_a_root_drops_the_root_entry_and_keeps_the_rest() {
        assert_eq!(strip_root("pkg/", "pkg", "fixture").expect("ok"), None);
        assert_eq!(
            strip_root("pkg/bin/tool", "pkg", "fixture").expect("ok"),
            Some("bin/tool".to_string()),
        );
        // An entry under a different root is refused here too, not merely when
        // the root was chosen.
        assert!(strip_root("other/bin/tool", "pkg", "fixture").is_err());
        // And an unsafe path stays unsafe at the point of use.
        assert!(strip_root("../escape", "pkg", "fixture").is_err());
    }
    fn entry(path: &str, is_directory: bool, mode: u32) -> SourceEntry {
        SourceEntry { path: path.to_string(), is_directory, is_link: false, mode }
    }

    #[test]
    fn planning_strips_the_single_root_and_drops_the_root_entry() {
        let entries = [
            entry("pkg/", true, 0o755),
            entry("pkg/bin/", true, 0o755),
            entry("pkg/bin/tool", false, 0o755),
        ];
        let planned = plan_entries(&entries, "fixture", true, Some("pkg")).expect("planned");
        assert_eq!(
            planned,
            [
                PlannedEntry { path: "bin".into(), is_directory: true, mode: 0o755 },
                PlannedEntry { path: "bin/tool".into(), is_directory: false, mode: 0o755 },
            ],
        );
    }

    #[test]
    fn planning_without_stripping_keeps_every_path_as_given() {
        let entries = [entry("a/b", false, 0o644)];
        let planned = plan_entries(&entries, "fixture", false, None).expect("planned");
        assert_eq!(planned[0].path, "a/b");
    }

    #[test]
    fn a_link_inside_an_archive_is_refused() {
        // Its target is a name the archive does not control, so following one
        // writes outside the extraction directory even when every path was safe.
        let entries = [SourceEntry {
            path: "pkg/link".into(),
            is_directory: false,
            is_link: true,
            mode: 0o777,
        }];
        assert!(plan_entries(&entries, "fixture", false, None).is_err());
    }

    #[test]
    fn a_root_that_is_not_the_expected_one_is_refused() {
        let entries = [entry("other/", true, 0o755), entry("other/f", false, 0o644)];
        assert!(plan_entries(&entries, "fixture", true, Some("pkg")).is_err());
    }

    #[test]
    fn asking_for_an_expected_root_without_stripping_is_refused() {
        // The caller asked a question that cannot be answered without computing
        // the root, and answering "fine" would be answering a different one.
        let entries = [entry("pkg/f", false, 0o644)];
        assert!(plan_entries(&entries, "fixture", false, Some("pkg")).is_err());
    }

    #[test]
    fn one_unsafe_entry_refuses_the_whole_plan() {
        // Nothing is written until every entry is judged, so a refusal cannot
        // leave a half-extracted tree for a later step to build on.
        let entries = [entry("pkg/good", false, 0o644), entry("pkg/../escape", false, 0o644)];
        assert!(plan_entries(&entries, "fixture", false, None).is_err());
    }
}
