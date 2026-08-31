//! `xtask check-determinism` — discover non-reproducible package builds.
//!
//! A reproducible build is a pure function of its *declared* inputs (recipe,
//! source, deps, and a pinned `SOURCE_DATE_EPOCH`). This tool builds the
//! project twice while varying only the *incidental* environment that a
//! reproducible build must ignore — the scratch/build path, the wall clock
//! (via `faketime` when available), and the hostname — then diffs the two
//! output trees. Any file that differs is a determinism gap, reported per
//! file with a `diffoscope` drill-down when that tool is on PATH.
//!
//! Planned enhancement: also vary `readdir` order and mtimes via `disorderfs`
//! on Linux, to flush out iteration-order non-determinism the current path +
//! clock + hostname variation does not exercise.
//!
//! This is *detection*, not enforcement: it finds gaps so they can be fixed
//! at the root (deterministic `ar`, `-ffile-prefix-map`, pinned clock/env).
//! It never mutates the repo.
//!
//! Modes:
//!   check-determinism diff <dir-a> <dir-b>
//!       Diff two already-produced trees. Pure, build-free — used by tests
//!       and to re-report a prior run.
//!   check-determinism run --set <set> --product <id> --scratch <dir>
//!                         [--jobs N] [--report <file>]
//!       Build twice into <dir>/a and <dir>/b with the environment varied,
//!       then diff their `programs/` subtrees. Exits non-zero if the build
//!       is not reproducible, so a scheduled run flags the gap.

use std::collections::BTreeMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Command;

use sha2::{Digest, Sha256};

use crate::util::hex;

/// Content fingerprint of one tree entry, addressed by its path relative to
/// the tree root: `sha256:<hex>` for a regular file, `symlink:<target>` for a
/// symlink. Directories are structural and are represented only by their
/// contents, so an empty directory is intentionally invisible to the diff.
type TreeManifest = BTreeMap<String, String>;

/// The outcome of comparing two build output trees.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct DiffReport {
    /// Paths present in both trees whose fingerprints differ.
    pub differing: Vec<String>,
    /// Paths present only in the first (A) tree.
    pub only_in_a: Vec<String>,
    /// Paths present only in the second (B) tree.
    pub only_in_b: Vec<String>,
    pub total_a: usize,
    pub total_b: usize,
}

impl DiffReport {
    /// True when the two trees are byte-identical (the build is reproducible
    /// across the varied environment).
    pub fn is_reproducible(&self) -> bool {
        self.differing.is_empty() && self.only_in_a.is_empty() && self.only_in_b.is_empty()
    }

    /// A human-readable report. Deterministic ordering (the manifests are
    /// `BTreeMap`s) so the output itself is stable across runs.
    pub fn render(&self) -> String {
        let mut out = String::new();
        if self.is_reproducible() {
            out.push_str(&format!(
                "REPRODUCIBLE: {} files identical across the varied environment\n",
                self.total_a
            ));
            return out;
        }
        out.push_str(&format!(
            "NON-REPRODUCIBLE: {} differing, {} only-in-A, {} only-in-B \
             (A={} files, B={} files)\n",
            self.differing.len(),
            self.only_in_a.len(),
            self.only_in_b.len(),
            self.total_a,
            self.total_b,
        ));
        for path in &self.differing {
            out.push_str(&format!("  differs: {path}\n"));
        }
        for path in &self.only_in_a {
            out.push_str(&format!("  only-in-A: {path}\n"));
        }
        for path in &self.only_in_b {
            out.push_str(&format!("  only-in-B: {path}\n"));
        }
        out
    }
}

/// Compare two already-built manifests. Pure — the unit-testable core.
fn diff_manifests(a: &TreeManifest, b: &TreeManifest) -> DiffReport {
    let mut report = DiffReport {
        total_a: a.len(),
        total_b: b.len(),
        ..DiffReport::default()
    };
    for (path, fingerprint_a) in a {
        match b.get(path) {
            Some(fingerprint_b) if fingerprint_b == fingerprint_a => {}
            Some(_) => report.differing.push(path.clone()),
            None => report.only_in_a.push(path.clone()),
        }
    }
    for path in b.keys() {
        if !a.contains_key(path) {
            report.only_in_b.push(path.clone());
        }
    }
    report
}

fn hash_file(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path)
        .map_err(|error| format!("open {}: {error}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("read {}: {error}", path.display()))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex(hasher.finalize().as_slice()))
}

fn build_manifest(root: &Path) -> Result<TreeManifest, String> {
    let mut manifest = TreeManifest::new();
    if !root.exists() {
        return Err(format!("output tree does not exist: {}", root.display()));
    }
    walk(root, root, &mut manifest)?;
    Ok(manifest)
}

fn walk(root: &Path, dir: &Path, manifest: &mut TreeManifest) -> Result<(), String> {
    let entries = fs::read_dir(dir)
        .map_err(|error| format!("read_dir {}: {error}", dir.display()))?;
    for entry in entries {
        let entry = entry.map_err(|error| format!("read_dir entry in {}: {error}", dir.display()))?;
        let path = entry.path();
        let file_type = entry
            .file_type()
            .map_err(|error| format!("file_type {}: {error}", path.display()))?;
        if file_type.is_dir() {
            walk(root, &path, manifest)?;
        } else {
            let rel = path
                .strip_prefix(root)
                .map_err(|error| format!("strip_prefix {}: {error}", path.display()))?
                .to_string_lossy()
                .into_owned();
            let fingerprint = if file_type.is_symlink() {
                let target = fs::read_link(&path)
                    .map_err(|error| format!("read_link {}: {error}", path.display()))?;
                format!("symlink:{}", target.to_string_lossy())
            } else {
                format!("sha256:{}", hash_file(&path)?)
            };
            manifest.insert(rel, fingerprint);
        }
    }
    Ok(())
}

/// Diff two build output trees on disk.
pub fn diff_trees(a: &Path, b: &Path) -> Result<DiffReport, String> {
    let manifest_a = build_manifest(a)?;
    let manifest_b = build_manifest(b)?;
    Ok(diff_manifests(&manifest_a, &manifest_b))
}

fn tool_on_path(tool: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join(tool);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Subcommand entry
// ---------------------------------------------------------------------------

pub fn run(args: Vec<String>) -> Result<(), String> {
    let mut iter = args.iter();
    match iter.next().map(String::as_str) {
        Some("diff") => {
            let a = iter.next().ok_or("check-determinism diff: missing <dir-a>")?;
            let b = iter.next().ok_or("check-determinism diff: missing <dir-b>")?;
            let report = diff_trees(Path::new(a), Path::new(b))?;
            print!("{}", report.render());
            if report.is_reproducible() {
                Ok(())
            } else {
                Err("build outputs differ (see report above)".to_string())
            }
        }
        Some("run") => run_build_twice(args[1..].to_vec()),
        other => Err(format!(
            "check-determinism: expected `diff` or `run`, got {other:?}\n\
             usage:\n  \
             check-determinism diff <dir-a> <dir-b>\n  \
             check-determinism run --set <set> --product <id> --scratch <dir> \
             [--jobs N] [--report <file>]"
        )),
    }
}

struct RunFlags {
    set: String,
    product: String,
    scratch: PathBuf,
    jobs: String,
    report: Option<PathBuf>,
}

fn parse_run_flags(args: &[String]) -> Result<RunFlags, String> {
    let mut set = None;
    let mut product = None;
    let mut scratch = None;
    let mut jobs = "8".to_string();
    let mut report = None;
    let mut i = 0;
    while i < args.len() {
        let flag = &args[i];
        let value = args.get(i + 1);
        let mut take = || {
            value
                .cloned()
                .ok_or_else(|| format!("check-determinism run: {flag} needs a value"))
        };
        match flag.as_str() {
            "--set" => set = Some(take()?),
            "--product" => product = Some(take()?),
            "--scratch" => scratch = Some(PathBuf::from(take()?)),
            "--jobs" => jobs = take()?,
            "--report" => report = Some(PathBuf::from(take()?)),
            other => return Err(format!("check-determinism run: unknown flag {other:?}")),
        }
        i += 2;
    }
    Ok(RunFlags {
        set: set.ok_or("check-determinism run: --set is required")?,
        product: product.ok_or("check-determinism run: --product is required")?,
        scratch: scratch.ok_or("check-determinism run: --scratch is required")?,
        jobs,
        report,
    })
}

/// One build variation: a label, an output/cache/scratch location, and the
/// incidental environment a reproducible build must ignore.
struct Variation {
    label: &'static str,
    fake_time: &'static str,
    hostname: &'static str,
}

fn run_build_twice(args: Vec<String>) -> Result<(), String> {
    let flags = parse_run_flags(&args)?;
    let self_exe = std::env::current_exe()
        .map_err(|error| format!("locate xtask binary: {error}"))?;
    let faketime = tool_on_path("faketime");

    fs::create_dir_all(&flags.scratch)
        .map_err(|error| format!("create scratch {}: {error}", flags.scratch.display()))?;

    // The two builds differ only in incidental environment: distinct
    // output/cache/scratch paths (exposes embedded build paths) and distinct
    // wall clocks (exposes timestamp embedding). Declared inputs — the set,
    // the product, and each recipe's pinned SOURCE_DATE_EPOCH — are held
    // constant, so any output difference is a genuine determinism gap.
    let variations = [
        Variation { label: "a", fake_time: "2001-02-03 04:05:06", hostname: "kandelo-det-a" },
        Variation { label: "b", fake_time: "2029-11-12 21:22:23", hostname: "kandelo-det-b" },
    ];

    if faketime.is_none() {
        eprintln!(
            "check-determinism: `faketime` not on PATH; the two builds still vary \
             by build path and by wall clock (they run a few seconds apart), but \
             clock variation is weaker without libfaketime. Add it to the flake \
             devShell for stronger detection."
        );
    }

    for variation in &variations {
        let out_root = flags.scratch.join(variation.label);
        let cache_root = flags.scratch.join(format!("{}-src", variation.label));
        let tmp_dir = flags.scratch.join(format!("{}-tmp", variation.label));
        fs::create_dir_all(&tmp_dir)
            .map_err(|error| format!("create tmp {}: {error}", tmp_dir.display()))?;

        let mut command = match &faketime {
            Some(faketime_bin) => {
                let mut command = Command::new(faketime_bin);
                command.arg(variation.fake_time).arg(&self_exe);
                command
            }
            None => Command::new(&self_exe),
        };
        command
            .arg("local-build")
            .arg("run")
            .arg("--set")
            .arg(&flags.set)
            .arg("--product")
            .arg(&flags.product)
            .arg("--output-root")
            .arg(&out_root)
            .arg("--source-cache-root")
            .arg(&cache_root)
            .arg("--jobs")
            .arg(&flags.jobs)
            // Mirror the environment a normal source-only build runs under, so
            // the resolver targets this variation's isolated output root.
            .env("WASM_POSIX_SOURCE_ONLY_BINARY_ROOT", &out_root)
            .env("TMPDIR", &tmp_dir)
            .env("HOSTNAME", variation.hostname);

        eprintln!(
            "check-determinism: build [{}] -> {}",
            variation.label,
            out_root.display()
        );
        let status = command
            .status()
            .map_err(|error| format!("spawn build [{}]: {error}", variation.label))?;
        if !status.success() {
            return Err(format!(
                "build [{}] failed ({status}); cannot compare determinism",
                variation.label
            ));
        }
    }

    // Compare the built artifacts (the `programs/` subtree), not the whole
    // output root: the root may carry resolver bookkeeping that is not a
    // shipped artifact.
    let programs_a = flags.scratch.join("a").join("programs");
    let programs_b = flags.scratch.join("b").join("programs");
    let report = diff_trees(&programs_a, &programs_b)?;
    let rendered = report.render();
    print!("{rendered}");

    if let Some(report_path) = &flags.report {
        fs::write(report_path, &rendered)
            .map_err(|error| format!("write report {}: {error}", report_path.display()))?;
        eprintln!("check-determinism: report written to {}", report_path.display());
    }

    if report.is_reproducible() {
        Ok(())
    } else {
        emit_diffoscope_hints(&programs_a, &programs_b, &report);
        Err(format!(
            "{} non-reproducible file(s) found; see report",
            report.differing.len() + report.only_in_a.len() + report.only_in_b.len()
        ))
    }
}

/// For each differing file, point at the exact `diffoscope` invocation (and
/// run it when available) so the root cause — an `ar` member mtime, an
/// embedded build path — is immediately visible.
fn emit_diffoscope_hints(a: &Path, b: &Path, report: &DiffReport) {
    let diffoscope = tool_on_path("diffoscope");
    for rel in report.differing.iter().take(20) {
        let file_a = a.join(rel);
        let file_b = b.join(rel);
        match &diffoscope {
            Some(bin) => {
                eprintln!("--- diffoscope {rel} ---");
                let _ = Command::new(bin)
                    .arg(&file_a)
                    .arg(&file_b)
                    .status();
            }
            None => {
                eprintln!(
                    "diffoscope {} {} (install diffoscope for a structural diff)",
                    file_a.display(),
                    file_b.display()
                );
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(tag: &str) -> PathBuf {
        let base = std::env::temp_dir().join(format!(
            "xtask-det-{}-{}-{}",
            tag,
            std::process::id(),
            // A monotonically-unique-enough suffix without wall-clock: the
            // address of a stack local differs per invocation.
            &format!("{:p}", &tag)[2..]
        ));
        fs::create_dir_all(&base).unwrap();
        base
    }

    fn write(root: &Path, rel: &str, contents: &[u8]) {
        let path = root.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, contents).unwrap();
    }

    #[test]
    fn identical_trees_are_reproducible() {
        let root = temp_root("identical");
        let a = root.join("a");
        let b = root.join("b");
        write(&a, "lib/libz.a", b"same-bytes");
        write(&a, "bin/tool.wasm", b"\0asm\x01");
        write(&b, "lib/libz.a", b"same-bytes");
        write(&b, "bin/tool.wasm", b"\0asm\x01");

        let report = diff_trees(&a, &b).unwrap();
        assert!(report.is_reproducible(), "{}", report.render());
        assert_eq!(report.total_a, 2);
        assert_eq!(report.total_b, 2);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn differing_and_missing_files_are_reported() {
        let root = temp_root("differing");
        let a = root.join("a");
        let b = root.join("b");
        write(&a, "lib/libz.a", b"bytes-from-build-a");
        write(&a, "only-a.txt", b"x");
        write(&b, "lib/libz.a", b"bytes-from-build-b"); // same path, different bytes
        write(&b, "only-b.txt", b"y");

        let report = diff_trees(&a, &b).unwrap();
        assert!(!report.is_reproducible());
        assert_eq!(report.differing, vec!["lib/libz.a".to_string()]);
        assert_eq!(report.only_in_a, vec!["only-a.txt".to_string()]);
        assert_eq!(report.only_in_b, vec!["only-b.txt".to_string()]);
        let rendered = report.render();
        assert!(rendered.contains("NON-REPRODUCIBLE"));
        assert!(rendered.contains("differs: lib/libz.a"));
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn symlink_target_changes_are_detected() {
        // A symlink whose target differs between builds is a determinism gap
        // even though no regular-file bytes changed.
        let root = temp_root("symlink");
        let a = root.join("a");
        let b = root.join("b");
        fs::create_dir_all(&a).unwrap();
        fs::create_dir_all(&b).unwrap();
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink("mandoc", a.join("man")).unwrap();
            std::os::unix::fs::symlink("mandoc-2", b.join("man")).unwrap();
            let report = diff_trees(&a, &b).unwrap();
            assert_eq!(report.differing, vec!["man".to_string()]);
        }
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn missing_tree_is_an_error_not_a_panic() {
        let root = temp_root("missing");
        let a = root.join("a");
        write(&a, "f", b"x");
        let b = root.join("does-not-exist");
        assert!(diff_trees(&a, &b).is_err());
        fs::remove_dir_all(&root).ok();
    }
}
