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

use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

use serde::Deserialize;

#[derive(Deserialize)]
struct Spec {
    /// Repo-relative path of the file to mutate.
    file: String,
    /// Seconds a `build` or `verify` command may run before the mutant is
    /// declared non-terminating. Default [`DEFAULT_TIMEOUT_SECS`].
    ///
    /// # Why this exists
    ///
    /// A mutation can break behaviour by making the verifier HANG rather than
    /// fail, and one did: "export ignores the offset and always restarts" made
    /// a test's drain loop never see its end condition, so it span forever
    /// growing a buffer. The harness waited on it for eighteen minutes and
    /// would have waited indefinitely, because nothing bounded the wait.
    ///
    /// Worse, the reason was invisible. Spec commands end in `>/dev/null 2>&1`
    /// so a green run stays quiet, which also swallows whatever the hung
    /// command was saying about itself.
    ///
    /// A verifier that never answers has not stayed green, so a timeout counts
    /// as a KILL — but it is reported separately, because it means the TEST
    /// should be made to fail fast rather than hang, and that is a real defect
    /// in the test rather than a curiosity about the mutant.
    #[serde(default)]
    timeout_secs: Option<u64>,
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

/// Long enough for a cold workspace rebuild, short enough that a hang is
/// noticed within one coffee rather than one afternoon.
const DEFAULT_TIMEOUT_SECS: u64 = 900;

/// What a bounded command did.
enum Ran {
    Exited(bool),
    TimedOut,
}

/// Run `command` under `root`, giving up after `timeout`.
///
/// The child is put in its OWN PROCESS GROUP and the whole group is killed on
/// timeout. Killing just the `sh` would leave the interesting part alive:
/// when this was diagnosed by hand, the shell's cargo and the test binary
/// under it were still running and still allocating.
fn run_bounded(root: &Path, command: &str, timeout: Duration) -> Result<Ran, String> {
    let mut child = Command::new("sh")
        .current_dir(root)
        .args(["-c", command])
        .process_group(0)
        .spawn()
        .map_err(|e| format!("spawn: {e}"))?;
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait().map_err(|e| format!("wait: {e}"))? {
            Some(status) => return Ok(Ran::Exited(status.success())),
            None => {
                if Instant::now() >= deadline {
                    // Negative pid: the group, not just the shell.
                    let pgid = child.id() as i32;
                    unsafe {
                        libc_kill(-pgid, 9);
                    }
                    let _ = child.wait();
                    return Ok(Ran::TimedOut);
                }
                std::thread::sleep(Duration::from_millis(200));
            }
        }
    }
}

unsafe extern "C" {
    #[link_name = "kill"]
    fn libc_kill(pid: i32, sig: i32) -> i32;
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
    let timeout = Duration::from_secs(spec.timeout_secs.unwrap_or(DEFAULT_TIMEOUT_SECS));
    let mut timed_out: Vec<String> = Vec::new();
    let target = root.join(&spec.file);
    require_tracked_and_clean(&root, &spec.file)?;
    println!("precondition: {} is tracked and clean", spec.file);

    let mut survived = Vec::new();
    let mut invalid = Vec::new();
    for trial in &spec.trials {
        println!("\n=== {} ===", trial.name);
        if let Err(e) = apply(&target, trial) {
            revert(&root, &spec.file)?;
            return Err(e);
        }
        println!("  mutation applied");
        if let Some(build) = &spec.build {
            let built = match run_bounded(&root, build, timeout)? {
                Ran::Exited(ok) => ok,
                Ran::TimedOut => {
                    revert(&root, &spec.file)?;
                    println!(
                        "  TIMEOUT — the BUILD did not finish in {}s. Not a verdict about \
                         the mutation.",
                        timeout.as_secs()
                    );
                    timed_out.push(trial.name.clone());
                    continue;
                }
            };
            if !built {
                revert(&root, &spec.file)?;
                println!(
                    "  INVALID — the mutation does not compile, so a non-zero verifier \
                     would prove nothing. Fix the trial."
                );
                invalid.push(trial.name.clone());
                continue;
            }
        }
        let ran = run_bounded(&root, &spec.verify, timeout)?;
        // Revert BEFORE reporting, so a panic in reporting cannot leave the
        // tree mutated.
        revert(&root, &spec.file)?;
        let status = match ran {
            Ran::Exited(ok) => ok,
            Ran::TimedOut => {
                println!(
                    "  killed by TIMEOUT — the verifier did not answer in {}s. The mutation \
                     was detected, but by hanging rather than failing: fix the TEST to \
                     terminate.",
                    timeout.as_secs()
                );
                timed_out.push(trial.name.clone());
                println!("  reverted and verified against tracked content");
                continue;
            }
        };
        if status {
            println!("  SURVIVED — the verifier stayed green. This behaviour is not covered.");
            survived.push(trial.name.clone());
        } else {
            println!("  killed — the verifier caught it");
        }
        println!("  reverted and verified against tracked content");
    }

    println!(
        "\n{} trial(s), {} survived, {} invalid, {} timed out",
        spec.trials.len(),
        survived.len(),
        invalid.len(),
        timed_out.len()
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
    if !timed_out.is_empty() {
        // A failure, not a pass with a note. The mutation WAS detected, but a
        // test that hangs instead of failing is a defect in the test: it costs
        // the whole run's wall clock and tells you nothing about what broke.
        problems.push(format!(
            "mutants detected by HANGING rather than failing — fix the tests so they \
             terminate: {}",
            timed_out.join(", ")
        ));
    }
    if problems.is_empty() {
        Ok(())
    } else {
        Err(problems.join("; "))
    }
}
