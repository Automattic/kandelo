//! Which files below a directory build input are source, and which are
//! generated output that must stay out of cache keys.
//!
//! # The rule
//!
//! Inside a directory the repository tracks, a file git ignores is generated
//! output, not source, and does not enter the key. An input that is itself
//! ignored (a sysroot, `local-binaries/`, a package's `bin/`, any generated
//! artifact named as an input) keeps hashing everything below it, because
//! there the artifact IS the input.
//!
//! # Why
//!
//! Package inputs name crate directories (`crates/fork-instrument`, or the
//! directories a `cargo:<crate>` input expands to). A fuzz run leaves
//! gigabytes of gitignored `fuzz/target` and `fuzz/corpus` inside those
//! directories. Walking every file hashed all of it for every program on every
//! keying pass -- `./run.sh setup` spent hours rehashing -- and moved every
//! package identity although no source had changed.
//!
//! # Whose ignore rules
//!
//! "Ignored" is decided by git itself (`git ls-files --others --ignored
//! --directory`), in the repository that owns the path: the nearest ancestor
//! with a `.git` entry, re-evaluated when the walk crosses into a nested
//! repository (a submodule, or a registry root that is its own checkout). Only
//! the rules committed to that tree count -- the `.gitignore` files -- not
//! `.git/info/exclude` or the user's `core.excludesFile`. Those two are
//! per-machine state, and a key must be a function of the tree: with them, two
//! machines holding identical files could compute different keys.
//!
//! Tracked files are never ignored, even when an ignore pattern matches them;
//! untracked files no rule ignores are source (a new file is part of the key
//! before it is committed). Deleted-but-still-indexed files are absent from the
//! walk, as they always were: the key hashes the working tree, not the index.
//!
//! # Without a repository
//!
//! When no ancestor of an input has a `.git` entry (an exported tarball, a
//! test fixture in a temp directory), nothing can say which files are
//! generated, so every file is hashed -- the same answer as an ignored input.
//! When a `.git` entry exists but git cannot answer (git missing, a broken
//! worktree link, an unsafe repository), keying fails loudly instead of
//! guessing: a silent fallback would give the same tree two identities
//! depending on whether git happened to run.

use std::collections::BTreeSet;
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::Command;

/// The file-selection rule for one directory input (or one nested repository
/// below it).
pub(crate) enum InputScope {
    /// Hash every entry: the input is itself ignored, or no repository owns it.
    Everything,
    /// A tracked directory: skip the entries git reports as ignored, and the
    /// owning repository's `.git` metadata.
    /// `ignored` lists the owning repository's ignored entries (absolute).
    Tracked {
        ignored: std::rc::Rc<BTreeSet<PathBuf>>,
    },
}

impl InputScope {
    /// The scope for a build input at `input`. Files and symlinks need no
    /// classification -- a named file is hashed whatever git thinks of it.
    /// A missing or unreadable input also classifies as `Everything`: the
    /// digest walk that follows reports that failure in its own terms.
    pub(crate) fn for_input(input: &Path) -> Result<InputScope, String> {
        match std::fs::symlink_metadata(input) {
            Ok(meta) if meta.is_dir() => {}
            _ => return Ok(InputScope::Everything),
        }
        let Some(owner) = owning_repository(input) else {
            return Ok(InputScope::Everything);
        };
        Self::for_directory_in(&owner, input)
    }

    /// Whether the walk must skip the entry at `path` (named `name`).
    pub(crate) fn skips(&self, path: &Path, name: &OsStr) -> bool {
        match self {
            InputScope::Everything => false,
            InputScope::Tracked { ignored } => name == ".git" || ignored.contains(path),
        }
    }

    /// The scope for descending into the directory `dir`: a new one when
    /// `dir` is the root of a nested repository (its own ignore rules apply),
    /// otherwise `None` (keep the current scope).
    pub(crate) fn nested(&self, dir: &Path) -> Result<Option<InputScope>, String> {
        match self {
            InputScope::Everything => Ok(None),
            InputScope::Tracked { .. } => {
                if std::fs::symlink_metadata(dir.join(".git")).is_ok() {
                    Self::for_directory_in(dir, dir).map(Some)
                } else {
                    Ok(None)
                }
            }
        }
    }

    fn for_directory_in(owner: &Path, input: &Path) -> Result<InputScope, String> {
        if !input.starts_with(owner) {
            return Err(format!(
                "build input {} is not below its repository {}",
                input.display(),
                owner.display()
            ));
        }
        let ignored = crate::cargo_closure::repository_ignored_entries(owner, || {
            ignored_entries(owner, input)
        })?;
        // The input itself, or an ancestor below the repository root, is
        // ignored: the input is a generated artifact, and all of it is the
        // input. (`--directory` lists an ignored directory as one entry, so
        // nothing below it would be skipped anyway; this states the rule
        // rather than leaving it implied by a flag.)
        if input
            .ancestors()
            .take_while(|ancestor| *ancestor != owner)
            .any(|ancestor| ignored.contains(ancestor))
        {
            return Ok(InputScope::Everything);
        }
        Ok(InputScope::Tracked { ignored })
    }
}

/// Every entry git reports as ignored anywhere in repository `owner`, as
/// absolute paths. An ignored directory is one entry (`--directory`), so a
/// fuzz run's `target/` costs one line, not a walk of its contents. One
/// whole-repository listing answers every input the repository owns, which
/// is what lets a keying pass memoize it.
fn ignored_entries(owner: &Path, input: &Path) -> Result<BTreeSet<PathBuf>, String> {
    let mut safe_directory = std::ffi::OsString::from("safe.directory=");
    safe_directory.push(owner.as_os_str());
    let mut command = Command::new("git");
    command.arg("-c").arg(safe_directory).arg("-C").arg(owner).args([
        "ls-files",
        "-z",
        "--others",
        "--ignored",
        "--exclude-per-directory=.gitignore",
        "--directory",
    ]);
    // The owning repository is chosen by path, never by an inherited
    // GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE (a git hook or an outer git
    // command would otherwise redirect the question to another repository).
    for (name, _) in std::env::vars_os() {
        if name.to_string_lossy().starts_with("GIT_") {
            command.env_remove(name);
        }
    }
    let output = command.output().map_err(|e| {
        format!(
            "classify build input {}: cannot run git in its repository {} ({e}); \
             keying needs git to tell source from ignored generated output",
            input.display(),
            owner.display()
        )
    })?;
    if !output.status.success() {
        return Err(format!(
            "classify build input {}: `git ls-files` failed in {}: {}",
            input.display(),
            owner.display(),
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let mut ignored = BTreeSet::new();
    for entry in output.stdout.split(|byte| *byte == 0) {
        if entry.is_empty() {
            continue;
        }
        let entry = entry.strip_suffix(b"/").unwrap_or(entry);
        ignored.insert(owner.join(path_from_bytes(entry)?));
    }
    Ok(ignored)
}


/// The nearest ancestor of `path` (itself included) holding a `.git` entry.
fn owning_repository(path: &Path) -> Option<PathBuf> {
    path.ancestors()
        .find(|dir| std::fs::symlink_metadata(dir.join(".git")).is_ok())
        .map(Path::to_path_buf)
}

#[cfg(unix)]
fn path_from_bytes(bytes: &[u8]) -> Result<PathBuf, String> {
    use std::os::unix::ffi::OsStrExt;
    Ok(PathBuf::from(OsStr::from_bytes(bytes)))
}

#[cfg(not(unix))]
fn path_from_bytes(bytes: &[u8]) -> Result<PathBuf, String> {
    String::from_utf8(bytes.to_vec())
        .map(PathBuf::from)
        .map_err(|_| "git reported a non-UTF-8 path".to_string())
}
