//! Mutation harness: apply a source mutation, run a verifier, revert, report.
//!
//! # Why this is a tool and not a shell loop
//!
//! Hazard H-2 says a guard that cannot fail is not a guard, so every new guard
//! in this campaign is perturbed until it fails. That discipline was being
//! implemented ad hoc, in a fresh bash loop each time, and the loop broke twice
//! in one session -- in mirror-image ways, both rooted in `git checkout --`
//! being asked to revert a file whose state was never checked:
//!
//!   * On an UNTRACKED file the revert FAILS. The error scrolled past, two
//!     mutations stacked, and the second trial's result was attributed to the
//!     wrong change. The "is it clean again?" check was `git diff --stat` on an
//!     untracked file, which can only ever answer "clean" -- hazard H-5, a
//!     check that answers a different question.
//!   * On a TRACKED file with UNCOMMITTED changes the revert SUCCEEDS, and
//!     destroys the work under test. The mutation anchors then no longer exist,
//!     and the verifier reports a healthy green having measured nothing at all.
//!
//! Both are unrepresentable here: the run refuses to start unless the target is
//! tracked AND clean, so there is nothing to lose and the revert is exact.
//!
//! # A surviving mutant is the finding
//!
//! If the verifier stays green with the mutation applied, the mutated behaviour
//! is not covered. That is a result worth failing the run for, so surviving
//! mutants set a non-zero exit rather than printing a line nobody reads.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Deserialize;

#[derive(Deserialize)]
struct Spec {
    /// Repo-relative path of the file to mutate.
    file: String,
    /// Shell command whose exit status decides whether a mutation was caught.
    verify: String,
    /// Optional command that must SUCCEED for the mutation to be considered
    /// valid at all.
    ///
    /// # Why this exists
    ///
    /// Without it, a mutation that does not COMPILE is indistinguishable from
    /// one the tests caught: both make `cargo test` exit non-zero, and the
    /// harness reports "killed". That is a false positive, and it produced one
    /// here — a trial replacing `rootfs::lstat` with `rootfs::stat`, a function
    /// that does not exist, was recorded as proof that a test detected
    /// symlink-following behaviour. It proved only that the compiler rejected
    /// a typo.
    ///
    /// When set, a mutation that fails this command is reported as INVALID and
    /// fails the run, because an invalid trial is a gap in the evidence rather
    /// than a pass.
    #[serde(default)]
    build: Option<String>,
    trials: Vec<Trial>,
}

#[derive(Deserialize)]
struct Trial {
    name: String,
    /// Text that opens the region the mutation must land in, so an anchor that
    /// is common file-wide can still be applied to exactly one function.
    scope: String,
    /// Text that CLOSES that region. Without it the uniqueness check counts
    /// matches from the scope marker to end of file, which is not a scope at
    /// all -- the first version of this tool did exactly that and reported a
    /// common anchor as occurring three times. Defaults to the end of an
    /// indented method body.
    #[serde(default = "default_scope_end")]
    scope_end: String,
    /// Text to replace, which must occur EXACTLY ONCE inside the scope. A
    /// silently-skipped mutation is the failure mode this rules out.
    find: String,
    replace: String,
}

fn default_scope_end() -> String {
    "\n    }\n".to_string()
}

fn git(root: &Path, args: &[&str]) -> Result<std::process::Output, String> {
    Command::new("git")
        .current_dir(root)
        .args(args)
        .output()
        .map_err(|e| format!("git {args:?}: {e}"))
}

/// Refuse to run unless the target is tracked and has no pending changes.
fn require_tracked_and_clean(root: &Path, file: &str) -> Result<(), String> {
    let tracked = git(root, &["ls-files", "--error-unmatch", file])?;
    if !tracked.status.success() {
        return Err(format!(
            "{file} is not tracked by git. Reverting an untracked file silently \
             does nothing, so mutations would stack and every result after the \
             first would be attributed to the wrong change. Commit it first."
        ));
    }
    for args in [
        vec!["diff", "--quiet", "--", file],
        vec!["diff", "--cached", "--quiet", "--", file],
    ] {
        if !git(root, &args)?.status.success() {
            return Err(format!(
                "{file} has uncommitted changes. This harness reverts with \
                 `git checkout --`, which would DESTROY them and then run the \
                 verifier against a file that no longer contains what you are \
                 testing. Commit first, then perturb."
            ));
        }
    }
    Ok(())
}

fn apply(path: &Path, trial: &Trial) -> Result<(), String> {
    let text = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    let start = text
        .find(&trial.scope)
        .ok_or_else(|| format!("{}: scope {:?} not found", trial.name, trial.scope))?;
    let after = &text[start..];
    let span = after
        .find(&trial.scope_end)
        .map(|e| e + trial.scope_end.len())
        .unwrap_or(after.len());
    let rest = &after[..span];
    let tail = &after[span..];
    let hits = rest.matches(&trial.find).count();
    if hits != 1 {
        return Err(format!(
            "{}: anchor {:?} occurs {hits} times after its scope, expected exactly 1. \
             An anchor matching several places reads identically to one that was \
             never applied.",
            trial.name, trial.find
        ));
    }
    let mutated = format!(
        "{}{}{}",
        &text[..start],
        rest.replacen(&trial.find, &trial.replace, 1),
        tail
    );
    if mutated == text {
        return Err(format!("{}: replacement changed nothing", trial.name));
    }
    std::fs::write(path, mutated).map_err(|e| e.to_string())
}

fn revert(root: &Path, file: &str) -> Result<(), String> {
    let out = git(root, &["checkout", "--", file])?;
    if !out.status.success() {
        return Err(format!(
            "revert of {file} FAILED: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    if !git(root, &["diff", "--quiet", "--", file])?.status.success() {
        return Err(format!("{file} still differs from tracked content after revert"));
    }
    Ok(())
}

pub fn run(args: &[String]) -> Result<(), String> {
    let spec_path = args
        .first()
        .ok_or("usage: xtask perturb <spec.json>")?;
    let spec: Spec = serde_json::from_str(
        &std::fs::read_to_string(spec_path).map_err(|e| format!("{spec_path}: {e}"))?,
    )
    .map_err(|e| format!("{spec_path}: {e}"))?;

    let root = PathBuf::from(
        String::from_utf8_lossy(
            &git(Path::new("."), &["rev-parse", "--show-toplevel"])?.stdout,
        )
        .trim(),
    );
    let target = root.join(&spec.file);
    let sentinel = root.join(".perturb-in-progress");

    // A revert that is the THIRD step is not atomic. The loop below applies a
    // mutation, runs a verifier, then reverts -- and anything that stops the
    // process in between leaves the target file mutated, uncommitted, with no
    // error anywhere. That happened three times in one session: a laptop
    // sleep, a killed background shell, and someone restoring the file by
    // hand while a run was in flight.
    //
    // The reverts above cover a panic. This covers the rest, without a signal
    // handler that would catch only some of them: a file written before the
    // first mutation and removed after the last revert. A SIGKILL, a sleep or
    // a killed parent all leave it behind, and the next run trips over it
    // instead of starting on a tree it believes is clean.
    if sentinel.exists() {
        let note = std::fs::read_to_string(&sentinel).unwrap_or_default();
        let mut message = String::from("a previous perturb run did not finish.\n");
        for line in note.lines() {
            message.push_str("  ");
            message.push_str(line);
            message.push('\n');
        }
        message.push_str(
            "That run left its mutation applied. Read `git diff` on the file \
             named above: if the only change is the trial's own line, restore \
             it and remove the marker.\n",
        );
        message.push_str(&format!(
            "  git checkout -- <file> && rm {}",
            sentinel.display(),
        ));
        return Err(message);
    }

    require_tracked_and_clean(&root, &spec.file)?;
    println!("precondition: {} is tracked and clean", spec.file);

    let mut survived = Vec::new();
    let mut invalid = Vec::new();
    for trial in &spec.trials {
        println!("\n=== {} ===", trial.name);
        std::fs::write(
            &sentinel,
            format!("file: {}\ntrial: {}\n", spec.file, trial.name),
        )
        .map_err(|e| format!("{}: {e}", sentinel.display()))?;
        if let Err(e) = apply(&target, trial) {
            revert(&root, &spec.file)?;
            let _ = std::fs::remove_file(&sentinel);
            return Err(e);
        }
        println!("  mutation applied");
        if let Some(build) = &spec.build {
            let built = Command::new("sh")
                .current_dir(&root)
                .args(["-c", build])
                .status()
                .map_err(|e| format!("build: {e}"))?;
            if !built.success() {
                revert(&root, &spec.file)?;
                let _ = std::fs::remove_file(&sentinel);
                println!(
                    "  INVALID — the mutation does not compile, so a non-zero verifier \
                     would prove nothing. Fix the trial."
                );
                invalid.push(trial.name.clone());
                continue;
            }
        }
        let status = Command::new("sh")
            .current_dir(&root)
            .args(["-c", &spec.verify])
            .status()
            .map_err(|e| format!("verify: {e}"))?;
        // Revert BEFORE reporting, so a panic in reporting cannot leave the
        // tree mutated.
        revert(&root, &spec.file)?;
        let _ = std::fs::remove_file(&sentinel);
        if status.success() {
            println!("  SURVIVED — the verifier stayed green. This behaviour is not covered.");
            survived.push(trial.name.clone());
        } else {
            println!("  killed — the verifier caught it");
        }
        println!("  reverted and verified against tracked content");
    }

    println!(
        "\n{} trial(s), {} survived, {} invalid",
        spec.trials.len(),
        survived.len(),
        invalid.len()
    );
    let mut problems = Vec::new();
    if !survived.is_empty() {
        problems.push(format!(
            "surviving mutants (uncovered behaviour): {}",
            survived.join(", ")
        ));
    }
    if !invalid.is_empty() {
        problems.push(format!(
            "invalid mutants (do not compile, so their result means nothing): {}",
            invalid.join(", ")
        ));
    }
    if problems.is_empty() {
        Ok(())
    } else {
        Err(problems.join("; "))
    }
}
