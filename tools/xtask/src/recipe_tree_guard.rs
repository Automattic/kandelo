//! Detect a package recipe that writes into its own reviewed directory.
//!
//! WHY: the resolver gives every build a private `WASM_POSIX_DEP_WORK_DIR`
//! and a private `WASM_POSIX_DEP_OUT_DIR`. A recipe that instead configures,
//! fetches, or compiles under its package directory shares that tree with
//! every other resolve of the same recipe in the same checkout. Two Vitest
//! files that both miss one package's cache, or a wasm32 and a wasm64 build
//! of one recipe, then run at once, and one build's `rm -rf "$BUILD_DIR"`
//! deletes the other's tree mid-build. The checkout is reviewed input, not
//! scratch, so the resolver records the recipe directory before the recipe
//! runs and refuses the build when anything in it changed.
//!
//! The snapshot is a metadata walk that never follows symlinks. A change to
//! any entry's type, size, mode, inode, link target, or modification or
//! status-change time counts, so a recipe that deletes and recreates a stale
//! tree, or creates and removes a scratch file, is still caught through the
//! containing directory's times.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

/// At most this many changed paths are named in the error. The rest are
/// counted; one entry is enough to locate the offending write.
const REPORTED_CHANGES: usize = 8;

#[derive(Clone, Debug, PartialEq, Eq)]
struct EntryState {
    kind: EntryKind,
    len: u64,
    modified: Option<SystemTime>,
    #[cfg(unix)]
    unix: UnixState,
    link_target: Option<PathBuf>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum EntryKind {
    Directory,
    File,
    Symlink,
    Other,
}

#[cfg(unix)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct UnixState {
    dev: u64,
    ino: u64,
    mode: u32,
    ctime: i64,
    ctime_nsec: i64,
}

#[derive(Debug, PartialEq, Eq)]
enum Change {
    Added,
    Removed,
    Modified,
}

impl Change {
    fn label(&self) -> &'static str {
        match self {
            Change::Added => "added",
            Change::Removed => "removed",
            Change::Modified => "modified",
        }
    }
}

/// Metadata of every entry below each guarded root, keyed by root.
pub(crate) struct RecipeTreeSnapshot {
    roots: Vec<(PathBuf, BTreeMap<PathBuf, EntryState>)>,
}

impl RecipeTreeSnapshot {
    /// Record `roots`. A root nested in another root is folded into it.
    pub(crate) fn capture(roots: &[PathBuf]) -> Result<Self, String> {
        let mut unique: Vec<PathBuf> = Vec::new();
        let mut sorted = roots.to_vec();
        sorted.sort();
        for root in sorted {
            if unique.iter().any(|kept| root.starts_with(kept)) {
                continue;
            }
            unique.push(root);
        }
        let mut snapshots = Vec::with_capacity(unique.len());
        for root in unique {
            let entries = walk(&root)?;
            snapshots.push((root, entries));
        }
        Ok(Self { roots: snapshots })
    }

    /// Re-walk every root and describe what changed, or return `None`.
    pub(crate) fn describe_changes(&self) -> Result<Option<String>, String> {
        let mut report = String::new();
        for (root, before) in &self.roots {
            let after = walk(root)?;
            let changes = diff(before, &after);
            if changes.is_empty() {
                continue;
            }
            report.push_str(&format!("\n  in {}:", root.display()));
            for (path, change) in changes.iter().take(REPORTED_CHANGES) {
                let shown = if path.as_os_str().is_empty() {
                    ".".to_string()
                } else {
                    path.display().to_string()
                };
                report.push_str(&format!("\n    {:<8} {shown}", change.label()));
            }
            if changes.len() > REPORTED_CHANGES {
                report.push_str(&format!(
                    "\n    ... and {} more",
                    changes.len() - REPORTED_CHANGES
                ));
            }
        }
        Ok((!report.is_empty()).then_some(report))
    }
}

fn walk(root: &Path) -> Result<BTreeMap<PathBuf, EntryState>, String> {
    let mut entries = BTreeMap::new();
    let mut pending = vec![PathBuf::new()];
    while let Some(relative) = pending.pop() {
        let path = root.join(&relative);
        let metadata = match std::fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            // An entry that vanished mid-walk is recorded as absent; the
            // directory holding it carries the change.
            Err(error) if error.kind() == std::io::ErrorKind::NotFound && !relative.as_os_str().is_empty() => {
                continue
            }
            Err(error) => {
                return Err(format!("inspect recipe tree entry {}: {error}", path.display()))
            }
        };
        let file_type = metadata.file_type();
        let kind = if file_type.is_symlink() {
            EntryKind::Symlink
        } else if file_type.is_dir() {
            EntryKind::Directory
        } else if file_type.is_file() {
            EntryKind::File
        } else {
            EntryKind::Other
        };
        let link_target = if kind == EntryKind::Symlink {
            Some(std::fs::read_link(&path).map_err(|error| {
                format!("read recipe tree symlink {}: {error}", path.display())
            })?)
        } else {
            None
        };
        #[cfg(unix)]
        let unix = {
            use std::os::unix::fs::MetadataExt;
            UnixState {
                dev: metadata.dev(),
                ino: metadata.ino(),
                mode: metadata.mode(),
                ctime: metadata.ctime(),
                ctime_nsec: metadata.ctime_nsec(),
            }
        };
        entries.insert(
            relative.clone(),
            EntryState {
                kind,
                len: metadata.len(),
                modified: metadata.modified().ok(),
                #[cfg(unix)]
                unix,
                link_target,
            },
        );
        if kind == EntryKind::Directory {
            let children = match std::fs::read_dir(&path) {
                Ok(children) => children,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound && !relative.as_os_str().is_empty() => {
                    continue
                }
                Err(error) => {
                    return Err(format!("list recipe tree directory {}: {error}", path.display()))
                }
            };
            for child in children {
                let child = child.map_err(|error| {
                    format!("list recipe tree directory {}: {error}", path.display())
                })?;
                pending.push(relative.join(child.file_name()));
            }
        }
    }
    Ok(entries)
}

/// Changed paths in path order. An added or removed directory is reported
/// once, not once per descendant.
fn diff(
    before: &BTreeMap<PathBuf, EntryState>,
    after: &BTreeMap<PathBuf, EntryState>,
) -> Vec<(PathBuf, Change)> {
    let mut changes: Vec<(PathBuf, Change)> = Vec::new();
    let mut collapsed: Vec<&Path> = Vec::new();
    let mut paths: Vec<&PathBuf> = before.keys().chain(after.keys()).collect();
    paths.sort();
    paths.dedup();
    for path in paths {
        if collapsed.iter().any(|parent| path.starts_with(parent) && path.as_path() != *parent) {
            continue;
        }
        let change = match (before.get(path), after.get(path)) {
            (Some(old), Some(new)) if old == new => continue,
            (Some(old), Some(new)) if old.kind != new.kind => Change::Added,
            (Some(_), Some(_)) => Change::Modified,
            (None, Some(_)) => Change::Added,
            (Some(_), None) => Change::Removed,
            (None, None) => continue,
        };
        let replaced_or_new_directory = match change {
            Change::Added => after.get(path).is_some_and(|state| state.kind == EntryKind::Directory),
            Change::Removed => before.get(path).is_some_and(|state| state.kind == EntryKind::Directory),
            Change::Modified => false,
        };
        if replaced_or_new_directory && !path.as_os_str().is_empty() {
            collapsed.push(path.as_path());
        }
        changes.push((path.clone(), change));
    }
    changes
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch() -> PathBuf {
        let base = std::env::temp_dir().join(format!(
            "recipe-tree-guard-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(base.join("recipe/src")).unwrap();
        std::fs::write(base.join("recipe/package.toml"), "name = \"demo\"\n").unwrap();
        std::fs::write(base.join("recipe/src/fix.patch"), "patch\n").unwrap();
        base
    }

    #[test]
    fn unchanged_tree_reports_nothing() {
        let base = scratch();
        let snapshot = RecipeTreeSnapshot::capture(&[base.join("recipe")]).unwrap();
        assert_eq!(snapshot.describe_changes().unwrap(), None);
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn new_build_tree_is_reported_once() {
        let base = scratch();
        let snapshot = RecipeTreeSnapshot::capture(&[base.join("recipe")]).unwrap();
        std::fs::create_dir_all(base.join("recipe/demo-build/CMakeFiles")).unwrap();
        std::fs::write(base.join("recipe/demo-build/CMakeCache.txt"), "x").unwrap();
        let report = snapshot.describe_changes().unwrap().expect("change detected");
        assert!(report.contains("added    demo-build"), "{report}");
        assert!(!report.contains("CMakeCache.txt"), "{report}");
        assert!(report.contains("modified ."), "{report}");
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn recreated_stale_tree_is_reported() {
        let base = scratch();
        std::fs::create_dir_all(base.join("recipe/demo-build")).unwrap();
        std::fs::write(base.join("recipe/demo-build/lib.a"), "old").unwrap();
        let snapshot = RecipeTreeSnapshot::capture(&[base.join("recipe")]).unwrap();
        std::fs::remove_dir_all(base.join("recipe/demo-build")).unwrap();
        std::fs::create_dir_all(base.join("recipe/demo-build")).unwrap();
        std::fs::write(base.join("recipe/demo-build/lib.a"), "old").unwrap();
        let report = snapshot.describe_changes().unwrap().expect("change detected");
        assert!(report.contains("demo-build"), "{report}");
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn transient_scratch_file_is_reported_through_its_directory() {
        let base = scratch();
        let snapshot = RecipeTreeSnapshot::capture(&[base.join("recipe")]).unwrap();
        std::fs::write(base.join("recipe/src/stamp"), "").unwrap();
        std::fs::remove_file(base.join("recipe/src/stamp")).unwrap();
        let report = snapshot.describe_changes().unwrap().expect("change detected");
        assert!(report.contains("modified src"), "{report}");
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn nested_roots_fold_into_their_parent() {
        let base = scratch();
        let snapshot = RecipeTreeSnapshot::capture(&[
            base.join("recipe/src"),
            base.join("recipe"),
        ])
        .unwrap();
        assert_eq!(snapshot.roots.len(), 1);
        std::fs::remove_dir_all(base).unwrap();
    }
}
