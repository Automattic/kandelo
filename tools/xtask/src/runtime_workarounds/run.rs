//! `xtask runtime-workarounds run`: execute every reproduction and compare
//! its verdict with what the registry recorded.
//!
//! The reproductions themselves are launched by `tests/runtime-workarounds/
//! driver.mjs`; this module chooses what to run on this host, parses the
//! driver's verdict line, compares it with `entry.toml`, and records the run
//! for `list`.

use super::entry::{
    load_entries, Entry, Observation, Repro, ReproKind, Status, Verdict, TARGETS,
};
use super::report::{last_run_path, LastRun, LastRunRecord};
use super::registry;
use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::process::Command;

/// How one run record relates to the entry's recorded observations.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    Match,
    /// The runtime's behaviour differs from the record; the string says how.
    Changed(String),
    /// The entry has no observation for this target on this OS.
    Unrecorded,
    Inconclusive,
}

/// The newest observation for `runtime` on `os`; on equal dates the later
/// record in the file wins (the same rule `list` uses).
fn latest<'a>(entry: &'a Entry, runtime: &str, os: &str) -> Option<&'a Observation> {
    let mut newest: Option<&Observation> = None;
    for obs in entry
        .observed
        .iter()
        .filter(|o| o.runtime == runtime && o.os == os)
    {
        if newest.map_or(true, |n| obs.date.to_string() >= n.date.to_string()) {
            newest = Some(obs);
        }
    }
    newest
}

pub fn compare(entry: &Entry, record: &LastRunRecord) -> Outcome {
    let Some(recorded) = latest(entry, &record.target, &record.os) else {
        return Outcome::Unrecorded;
    };
    let now = match record.verdict {
        Verdict::Inconclusive => return Outcome::Inconclusive,
        Verdict::Reproduced => true,
        Verdict::NotReproduced => false,
    };
    if now == recorded.reproduced {
        return Outcome::Match;
    }
    let (id, target, version, os) = (&record.id, &record.target, &record.version, &record.os);
    Outcome::Changed(if now {
        format!(
            "{id}: reproduces on {target} {version} ({os}) where the last record says it does \
             not; update entry.toml"
        )
    } else {
        format!(
            "{id}: no longer reproduces on {target} {version} ({os}); update entry.toml \
             \u{2014} candidate for fixed-upstream or retirement"
        )
    })
}

/// One reproduction to run on one target.
#[derive(Debug, PartialEq)]
struct Job<'a> {
    dir: &'a str,
    entry: &'a Entry,
    repro: &'a Repro,
    target: &'a str,
}

#[derive(Debug, Default, PartialEq)]
struct Plan<'a> {
    jobs: Vec<Job<'a>>,
    /// One message per target left out because its binary is not installed.
    skipped: Vec<String>,
}

/// Targets whose reproduction needs a binary beyond node and the browsers
/// the driver launches through Playwright.
fn needs_binary(target: &str) -> bool {
    !matches!(target, "chromium" | "firefox" | "webkit" | "node")
}

fn runnable(status: Status) -> bool {
    matches!(
        status,
        Status::Confirmed | Status::Reported | Status::FixedUpstream
    )
}

/// What to run: every self-judging reproduction of every runnable entry,
/// narrowed by `ids` and `targets` (empty means no narrowing), on each
/// target it declares whose binary `on_path` finds. A repro that needs a
/// person to read its result is evidence, not a check, so it never runs.
fn plan<'a>(
    entries: &'a [(String, Entry)],
    ids: &[String],
    targets: &[String],
    on_path: &dyn Fn(&str) -> bool,
) -> Plan<'a> {
    let mut plan = Plan::default();
    for (dir, entry) in entries {
        if !runnable(entry.status) || (!ids.is_empty() && !ids.contains(&entry.id)) {
            continue;
        }
        for repro in entry.repro.iter().filter(|r| r.self_judging) {
            for target in &repro.targets {
                if !targets.is_empty() && !targets.contains(target) {
                    continue;
                }
                if needs_binary(target) && !on_path(target) {
                    plan.skipped.push(format!(
                        "runtime-workarounds: skipping {} on {target}: {target} is not on PATH",
                        entry.id
                    ));
                    continue;
                }
                plan.jobs.push(Job {
                    dir,
                    entry,
                    repro,
                    target,
                });
            }
        }
    }
    plan
}

fn binary_on_path(name: &str) -> bool {
    let Some(path) = std::env::var_os("PATH") else {
        return false;
    };
    std::env::split_paths(&path).any(|dir| {
        let candidate = dir.join(name);
        candidate.is_file() && is_executable(&candidate)
    })
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path).is_ok_and(|m| m.permissions().mode() & 0o111 != 0)
}

#[cfg(not(unix))]
fn is_executable(_path: &Path) -> bool {
    true
}

/// The driver's final stdout line.
#[derive(Debug, Deserialize)]
struct DriverVerdict {
    verdict: Verdict,
    version: String,
    os: String,
    details: String,
}

fn driver_path(repo: &Path) -> PathBuf {
    registry(repo).join("driver.mjs")
}

/// Run the driver for one job and interpret what it printed.
fn drive(repo: &Path, job: &Job) -> Result<LastRunRecord, String> {
    let repro = job.repro;
    let kind = match repro.kind {
        ReproKind::BrowserPage => "browser-page",
        ReproKind::Script => "script",
    };
    let output = Command::new("node")
        .arg(driver_path(repo))
        .arg("--dir")
        .arg(registry(repo).join(job.dir).join("repro"))
        .args(["--kind", kind, "--entry", &repro.entry])
        .args(["--target", job.target])
        .args(["--attempts", &repro.attempts.to_string()])
        .args(["--min-reproduced", &repro.min_reproduced.to_string()])
        .args(["--timeout-seconds", &repro.timeout_seconds.to_string()])
        .args([
            "--crash-is-reproduced",
            if repro.crash_is_reproduced { "1" } else { "0" },
        ])
        .current_dir(repo)
        .output()
        .map_err(|e| format!("could not start node: {e}"))?;
    interpret(
        &job.entry.id,
        job.target,
        &DriverExit {
            success: output.status.success(),
            status: output.status.to_string(),
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        },
    )
}

/// What the driver process left behind.
struct DriverExit {
    success: bool,
    /// How the process ended, for messages (`exit status: 3`).
    status: String,
    stdout: String,
    stderr: String,
}

/// How many trailing stderr lines a harness-failure message quotes.
const STDERR_TAIL_LINES: usize = 10;

/// The driver exits 0 whenever it produced a verdict. Any other exit (3 is
/// its harness failure: Playwright missing, a browser or runtime that would
/// not launch), or output without a parseable verdict line, is an error:
/// the repro never ran, so there is no evidence to record, and a suite that
/// quietly called it inconclusive would hide a broken harness. A verdict of
/// `inconclusive` is the repro's own answer and is recorded like any other.
fn interpret(id: &str, target: &str, exit: &DriverExit) -> Result<LastRunRecord, String> {
    let parsed = exit
        .stdout
        .lines()
        .last()
        .and_then(|line| serde_json::from_str::<DriverVerdict>(line).ok());
    match (exit.success, parsed) {
        (true, Some(v)) => Ok(LastRunRecord {
            id: id.to_string(),
            target: target.to_string(),
            os: v.os,
            version: v.version,
            verdict: v.verdict,
            details: v.details,
        }),
        (success, parsed) => {
            let why = if success && parsed.is_none() {
                "no verdict line on stdout".to_string()
            } else {
                exit.status.clone()
            };
            let lines: Vec<&str> = exit.stderr.trim_end().lines().collect();
            let tail = lines[lines.len().saturating_sub(STDERR_TAIL_LINES)..].join("\n");
            Err(format!(
                "driver failed for {id} on {target} ({why}); the repro did not run, so \
                 nothing was recorded{}",
                if tail.is_empty() {
                    String::new()
                } else {
                    format!(":\n{tail}")
                }
            ))
        }
    }
}

/// `YYYY-MM-DDTHH:MM:SSZ` for the current time.
fn utc_now() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs());
    format_utc(secs)
}

fn format_utc(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let rest = secs % 86_400;
    // Days since 1970-01-01 to a civil date (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rest / 3_600,
        rest % 3_600 / 60,
        rest % 60
    )
}

/// What one `run` found, for the closing summary line.
#[derive(Debug, Default, PartialEq)]
struct Tally {
    matched: usize,
    changed: usize,
    unrecorded: usize,
    inconclusive: usize,
    skipped: usize,
    /// Jobs whose driver failed before the repro could give a verdict.
    failed: usize,
}

impl Tally {
    fn line(&self) -> String {
        let run = self.matched + self.changed + self.unrecorded + self.inconclusive;
        format!(
            "runtime-workarounds: {run} run: {} match, {} changed, {} unrecorded, \
             {} inconclusive; {} skipped; {} harness failure(s)",
            self.matched,
            self.changed,
            self.unrecorded,
            self.inconclusive,
            self.skipped,
            self.failed
        )
    }
}

/// This run's records laid over the previous file: a record for the same
/// (id, target, os) replaces the old one and the rest are kept.
fn merge(previous: Option<LastRun>, records: Vec<LastRunRecord>, finished: String) -> LastRun {
    let mut kept = previous.map_or_else(Vec::new, |p| p.records);
    kept.retain(|old| {
        !records
            .iter()
            .any(|new| (&new.id, &new.target, &new.os) == (&old.id, &old.target, &old.os))
    });
    kept.extend(records);
    LastRun {
        finished,
        records: kept,
    }
}

struct Options {
    ids: Vec<String>,
    targets: Vec<String>,
}

fn parse_options(args: &[String]) -> Result<Options, String> {
    const USAGE: &str = "usage: xtask runtime-workarounds run [--id ID]... [--target T]...";
    let mut options = Options {
        ids: Vec::new(),
        targets: Vec::new(),
    };
    let mut it = args.iter();
    while let Some(flag) = it.next() {
        let value = it.next().ok_or_else(|| USAGE.to_string())?;
        match flag.as_str() {
            "--id" => options.ids.push(value.clone()),
            "--target" => {
                if !TARGETS.contains(&value.as_str()) {
                    return Err(format!(
                        "unknown target {value:?} (expected one of {})",
                        TARGETS.join(", ")
                    ));
                }
                options.targets.push(value.clone());
            }
            _ => return Err(USAGE.to_string()),
        }
    }
    Ok(options)
}

fn describe(outcome: &Outcome) -> String {
    match outcome {
        Outcome::Match => "matches the recorded observation".to_string(),
        Outcome::Unrecorded => "no recorded observation for this target and OS".to_string(),
        Outcome::Inconclusive => "inconclusive".to_string(),
        Outcome::Changed(message) => format!("CHANGED: {message}"),
    }
}

pub fn run(repo: &Path, args: &[String]) -> Result<(), String> {
    let options = parse_options(args)?;
    let entries = load_entries(&registry(repo))?;
    for id in &options.ids {
        if !entries.iter().any(|(_, e)| &e.id == id) {
            return Err(format!("no registry entry with id {id:?}"));
        }
    }
    let plan = plan(&entries, &options.ids, &options.targets, &binary_on_path);
    for message in &plan.skipped {
        println!("{message}");
    }
    if plan.jobs.is_empty() {
        println!("runtime-workarounds: 0 entries to run");
        return Ok(());
    }

    let mut records = Vec::new();
    let mut tally = Tally {
        skipped: plan.skipped.len(),
        ..Tally::default()
    };
    let mut failures = Vec::new();
    for job in &plan.jobs {
        // Keep going so one broken launch does not hide the other results;
        // the run still fails below.
        let record = match drive(repo, job) {
            Ok(record) => record,
            Err(message) => {
                eprintln!("runtime-workarounds: {message}");
                tally.failed += 1;
                failures.push(format!("{} on {}", job.entry.id, job.target));
                continue;
            }
        };
        let outcome = compare(job.entry, &record);
        match outcome {
            Outcome::Match => tally.matched += 1,
            Outcome::Changed(_) => tally.changed += 1,
            Outcome::Unrecorded => tally.unrecorded += 1,
            Outcome::Inconclusive => tally.inconclusive += 1,
        }
        println!(
            "{} {} {} ({}): {} -- {}",
            record.id,
            record.target,
            record.version,
            record.os,
            match record.verdict {
                Verdict::Reproduced => "reproduced",
                Verdict::NotReproduced => "not-reproduced",
                Verdict::Inconclusive => "inconclusive",
            },
            describe(&outcome),
        );
        records.push(record);
    }

    let path = last_run_path(repo);
    // A run narrowed by --id/--target must not discard other records. An
    // unreadable previous file is replaced, as `list` already ignores it.
    let previous = std::fs::read_to_string(&path)
        .ok()
        .and_then(|text| serde_json::from_str::<LastRun>(&text).ok());
    let last = merge(previous, records, utc_now());
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
    }
    let text = serde_json::to_string_pretty(&last).map_err(|e| format!("serialize run: {e}"))?;
    std::fs::write(&path, text + "\n").map_err(|e| format!("write {}: {e}", path.display()))?;

    println!("{}", tally.line());
    let mut errors = Vec::new();
    if !failures.is_empty() {
        errors.push(format!(
            "the reproduction harness failed for {} (see the messages above); a harness \
             failure is not evidence about the runtime",
            failures.join(", ")
        ));
    }
    if tally.changed > 0 {
        errors.push(format!(
            "{} runtime workaround(s) no longer match the registry; update their entry.toml",
            tally.changed
        ));
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("\n"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime_workarounds::entry::Verdict;

    fn entry(observed: &str) -> Entry {
        let text = format!(
            r#"
id = "WK-1"
kind = "bug"
status = "confirmed"
runtimes = ["webkit"]
summary = "s"
{observed}
"#
        );
        toml::from_str(&text).unwrap()
    }

    fn observation(runtime: &str, version: &str, os: &str, reproduced: bool, date: &str) -> String {
        format!(
            "[[observed]]\nruntime = \"{runtime}\"\nversion = \"{version}\"\nos = \"{os}\"\n\
             reproduced = {reproduced}\ndate = {date}\n"
        )
    }

    fn record(target: &str, os: &str, version: &str, verdict: Verdict) -> LastRunRecord {
        LastRunRecord {
            id: "WK-1".to_string(),
            target: target.to_string(),
            os: os.to_string(),
            version: version.to_string(),
            verdict,
            details: String::new(),
        }
    }

    fn exit(success: bool, status: &str, stdout: &str, stderr: &str) -> DriverExit {
        DriverExit {
            success,
            status: status.to_string(),
            stdout: stdout.to_string(),
            stderr: stderr.to_string(),
        }
    }

    #[test]
    fn harness_failure_is_an_error_naming_entry_target_and_stderr() {
        let failed = exit(
            false,
            "exit status: 3",
            "",
            "noise\ndriver: harness failure: could not launch webkit: no executable\n",
        );
        let err = interpret("WK-1", "webkit", &failed).unwrap_err();
        assert!(err.contains("WK-1"), "{err}");
        assert!(err.contains("webkit"), "{err}");
        assert!(err.contains("exit status: 3"), "{err}");
        assert!(err.contains("could not launch webkit: no executable"), "{err}");
    }

    #[test]
    fn unparseable_driver_output_is_an_error() {
        let garbled = exit(true, "exit status: 0", "not json\n", "");
        let err = interpret("WK-1", "bun", &garbled).unwrap_err();
        assert!(err.contains("WK-1") && err.contains("bun"), "{err}");
        assert!(err.contains("no verdict line"), "{err}");
    }

    #[test]
    fn repro_inconclusive_is_a_record_not_an_error() {
        let line = r#"{"verdict":"inconclusive","version":"1.3.3","os":"macos","details":"no verdict within 2s"}"#;
        let record = interpret("WK-1", "bun", &exit(true, "exit status: 0", line, "")).unwrap();
        assert_eq!(record.verdict, Verdict::Inconclusive);
        assert_eq!(record.version, "1.3.3");
        assert_eq!(record.details, "no verdict within 2s");
    }

    #[test]
    fn unrecorded_os_is_not_a_failure() {
        let e = entry(&observation("webkit", "18.2", "macos", true, "2026-10-01"));
        let r = record("webkit", "linux", "2.44", Verdict::NotReproduced);
        assert_eq!(compare(&e, &r), Outcome::Unrecorded);
        // A different target on the same OS is just as unrecorded.
        let r = record("firefox", "macos", "130", Verdict::Reproduced);
        assert_eq!(compare(&e, &r), Outcome::Unrecorded);
        assert_eq!(
            compare(&entry(""), &record("webkit", "macos", "18.2", Verdict::Reproduced)),
            Outcome::Unrecorded
        );
    }

    #[test]
    fn matching_record_is_match() {
        let e = entry(&observation("webkit", "18.2", "macos", true, "2026-10-01"));
        let r = record("webkit", "macos", "18.4", Verdict::Reproduced);
        assert_eq!(compare(&e, &r), Outcome::Match);
        let e = entry(&observation("webkit", "18.2", "macos", false, "2026-10-01"));
        let r = record("webkit", "macos", "18.4", Verdict::NotReproduced);
        assert_eq!(compare(&e, &r), Outcome::Match);
    }

    #[test]
    fn stopped_reproducing_is_changed_with_message() {
        let e = entry(&observation("webkit", "18.2", "macos", true, "2026-10-01"));
        let r = record("webkit", "macos", "18.4", Verdict::NotReproduced);
        assert_eq!(
            compare(&e, &r),
            Outcome::Changed(
                "WK-1: no longer reproduces on webkit 18.4 (macos); update entry.toml \
                 \u{2014} candidate for fixed-upstream or retirement"
                    .to_string()
            )
        );
    }

    #[test]
    fn started_reproducing_is_changed_with_message() {
        let e = entry(&observation("webkit", "18.2", "macos", false, "2026-10-01"));
        let r = record("webkit", "macos", "18.4", Verdict::Reproduced);
        assert_eq!(
            compare(&e, &r),
            Outcome::Changed(
                "WK-1: reproduces on webkit 18.4 (macos) where the last record says it does \
                 not; update entry.toml"
                    .to_string()
            )
        );
    }

    #[test]
    fn latest_observation_for_the_pair_is_the_one_compared() {
        let observed = [
            observation("webkit", "18.2", "macos", true, "2026-10-01"),
            observation("webkit", "18.4", "macos", false, "2026-10-20"),
            observation("webkit", "18.0", "linux", true, "2026-11-01"),
        ]
        .join("\n");
        let e = entry(&observed);
        let r = record("webkit", "macos", "18.5", Verdict::NotReproduced);
        assert_eq!(compare(&e, &r), Outcome::Match);
    }

    #[test]
    fn inconclusive_is_not_a_failure() {
        let e = entry(&observation("webkit", "18.2", "macos", true, "2026-10-01"));
        let r = record("webkit", "macos", "18.4", Verdict::Inconclusive);
        assert_eq!(compare(&e, &r), Outcome::Inconclusive);
    }

    #[test]
    fn merge_replaces_matching_records_and_keeps_others() {
        let rec = |id: &str, target: &str, os: &str, verdict: Verdict| LastRunRecord {
            id: id.to_string(),
            target: target.to_string(),
            os: os.to_string(),
            version: "v".to_string(),
            verdict,
            details: String::new(),
        };
        let previous = LastRun {
            finished: "2026-10-01T00:00:00Z".to_string(),
            records: vec![
                rec("A", "webkit", "macos", Verdict::Reproduced),
                rec("A", "firefox", "macos", Verdict::Reproduced),
                rec("B", "webkit", "macos", Verdict::Reproduced),
            ],
        };
        let merged = merge(
            Some(previous),
            vec![
                rec("A", "webkit", "macos", Verdict::NotReproduced),
                rec("A", "webkit", "linux", Verdict::Reproduced),
            ],
            "2026-10-22T00:00:00Z".to_string(),
        );
        assert_eq!(merged.finished, "2026-10-22T00:00:00Z");
        let shown: Vec<_> = merged
            .records
            .iter()
            .map(|r| (r.id.as_str(), r.target.as_str(), r.os.as_str(), r.verdict))
            .collect();
        assert_eq!(
            shown,
            [
                ("A", "firefox", "macos", Verdict::Reproduced),
                ("B", "webkit", "macos", Verdict::Reproduced),
                ("A", "webkit", "macos", Verdict::NotReproduced),
                ("A", "webkit", "linux", Verdict::Reproduced),
            ]
        );
        assert_eq!(merge(None, Vec::new(), "t".to_string()).records, []);
    }

    #[test]
    fn summary_line_counts_every_outcome() {
        let tally = Tally {
            matched: 3,
            changed: 1,
            unrecorded: 2,
            inconclusive: 4,
            skipped: 5,
            failed: 6,
        };
        assert_eq!(
            tally.line(),
            "runtime-workarounds: 10 run: 3 match, 1 changed, 2 unrecorded, 4 inconclusive; \
             5 skipped; 6 harness failure(s)"
        );
    }

    #[test]
    fn utc_timestamp_formats() {
        assert_eq!(format_utc(0), "1970-01-01T00:00:00Z");
        assert_eq!(format_utc(1_782_122_096), "2026-06-22T09:54:56Z");
        // 2024-02-29 is a leap day.
        assert_eq!(format_utc(1_709_210_096), "2024-02-29T12:34:56Z");
    }

    #[test]
    fn plan_skips_missing_binaries_and_narrows() {
        let text = |id: &str, status: &str| {
            format!(
                "id = \"{id}\"\nkind = \"bug\"\nstatus = \"{status}\"\nruntimes = [\"clang\"]\n\
                 summary = \"s\"\n[[repro]]\nkind = \"script\"\nentry = \"r.sh\"\n\
                 targets = [\"clang\", \"node\"]\nself_judging = true\n"
            )
        };
        let entries = vec![
            ("A".to_string(), toml::from_str::<Entry>(&text("A", "confirmed")).unwrap()),
            ("B".to_string(), toml::from_str::<Entry>(&text("B", "suspected")).unwrap()),
            ("C".to_string(), toml::from_str::<Entry>(&text("C", "fixed-upstream")).unwrap()),
        ];
        let none_installed = |_: &str| false;
        let p = plan(&entries, &[], &[], &none_installed);
        let jobs: Vec<_> = p.jobs.iter().map(|j| (j.dir, j.target)).collect();
        assert_eq!(jobs, [("A", "node"), ("C", "node")]);
        assert_eq!(p.skipped.len(), 2);
        assert!(p.skipped[0].contains("A on clang: clang is not on PATH"), "{:?}", p.skipped);

        let all_installed = |_: &str| true;
        let p = plan(&entries, &["C".to_string()], &["clang".to_string()], &all_installed);
        let jobs: Vec<_> = p.jobs.iter().map(|j| (j.dir, j.target)).collect();
        assert_eq!(jobs, [("C", "clang")]);
    }

    #[test]
    fn plan_runs_every_self_judging_repro_and_skips_evidence_pages() {
        let text = "id = \"M\"\nkind = \"bug\"\nstatus = \"confirmed\"\n\
                    runtimes = [\"bun\", \"webkit\"]\nsummary = \"s\"\n\
                    [[repro]]\nkind = \"script\"\nentry = \"r.mjs\"\ntargets = [\"node\"]\n\
                    self_judging = true\n\
                    [[repro]]\nkind = \"browser-page\"\nentry = \"r.html\"\n\
                    targets = [\"webkit\"]\nself_judging = true\n\
                    [[repro]]\nkind = \"browser-page\"\nentry = \"sample.html\"\n\
                    targets = [\"chromium\"]\nself_judging = false\n";
        let entries = vec![("M".to_string(), toml::from_str::<Entry>(text).unwrap())];
        let p = plan(&entries, &[], &[], &|_: &str| true);
        let jobs: Vec<_> = p
            .jobs
            .iter()
            .map(|j| (j.repro.entry.as_str(), j.target))
            .collect();
        assert_eq!(jobs, [("r.mjs", "node"), ("r.html", "webkit")]);
    }
}
