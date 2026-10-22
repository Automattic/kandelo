//! `xtask runtime-workarounds run`: execute every reproduction and compare
//! its verdict with what the registry recorded.
//!
//! The reproductions themselves are launched by `tests/runtime-workarounds/
//! driver.mjs`; this module chooses what to run on this host, parses the
//! driver's verdict line, compares it with `entry.toml`, and records the run
//! for `list`.

use super::entry::{
    load_entries, Entry, Observation, ReproKind, Status, Verdict, TARGETS,
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

/// What to run: every runnable entry with a reproduction, narrowed by `ids`
/// and `targets` (empty means no narrowing), on each declared target whose
/// binary `on_path` finds.
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
        let Some(repro) = &entry.repro else { continue };
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
                target,
            });
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

/// Run the driver for one job. The driver exits 0 whenever it produced a
/// verdict; any other result is reported on stderr and recorded as
/// inconclusive, because a broken driver says nothing about the runtime.
fn drive(repo: &Path, job: &Job) -> Result<LastRunRecord, String> {
    let repro = job
        .entry
        .repro
        .as_ref()
        .expect("planned jobs have a reproduction");
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
    let stdout = String::from_utf8_lossy(&output.stdout);
    let parsed = stdout
        .lines()
        .last()
        .and_then(|line| serde_json::from_str::<DriverVerdict>(line).ok());
    match (output.status.success(), parsed) {
        (true, Some(v)) => Ok(LastRunRecord {
            id: job.entry.id.clone(),
            target: job.target.to_string(),
            os: v.os,
            version: v.version,
            verdict: v.verdict,
            details: v.details,
        }),
        (_, _) => {
            let stderr = String::from_utf8_lossy(&output.stderr);
            eprintln!(
                "runtime-workarounds: driver failed for {} on {} ({}):\n{}",
                job.entry.id,
                job.target,
                output.status,
                stderr.trim_end()
            );
            Ok(LastRunRecord {
                id: job.entry.id.clone(),
                target: job.target.to_string(),
                os: host_os().to_string(),
                version: "unknown".to_string(),
                verdict: Verdict::Inconclusive,
                details: format!("driver failed ({})", output.status),
            })
        }
    }
}

/// The OS name the driver uses for this host.
fn host_os() -> &'static str {
    match std::env::consts::OS {
        "macos" => "macos",
        "windows" => "windows",
        other => other,
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
    let mut changed = 0;
    for job in &plan.jobs {
        let record = drive(repo, job)?;
        let outcome = compare(job.entry, &record);
        if matches!(outcome, Outcome::Changed(_)) {
            changed += 1;
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
    let last = LastRun {
        finished: utc_now(),
        records,
    };
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
    }
    let text = serde_json::to_string_pretty(&last).map_err(|e| format!("serialize run: {e}"))?;
    std::fs::write(&path, text + "\n").map_err(|e| format!("write {}: {e}", path.display()))?;

    if changed > 0 {
        return Err(format!(
            "{changed} runtime workaround(s) no longer match the registry; update their entry.toml"
        ));
    }
    Ok(())
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
                 summary = \"s\"\n[repro]\nkind = \"script\"\nentry = \"r.sh\"\n\
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
}
