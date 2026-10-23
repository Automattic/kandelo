//! `xtask runtime-workarounds list`: the weekly report.

use super::entry::{load_registry, Entry, Verdict};
use super::registry;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// One target's result from the last `run`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LastRunRecord {
    pub id: String,
    pub target: String,
    pub os: String,
    pub version: String,
    pub verdict: Verdict,
    pub details: String,
}

/// What the last `run` found. `run` writes it; `list` only reads it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LastRun {
    pub finished: String,
    pub records: Vec<LastRunRecord>,
}

pub fn last_run_path(repo: &Path) -> PathBuf {
    repo.join("target")
        .join("runtime-workarounds")
        .join("last-run.json")
}

/// Where entries are shown relative to the repository root.
const REGISTRY_REL: &str = "tests/runtime-workarounds";

const READY: &str = "Ready to file";
const FILED: &str = "Filed";
const RETIRABLE: &str = "Possibly retirable";
const REDUCTION: &str = "Needs reduction";
const GAPS: &str = "Gaps";

/// The newest observation for one runtime on one OS.
#[derive(Debug, Serialize)]
struct ObservationView {
    runtime: String,
    version: String,
    os: String,
    reproduced: bool,
    date: String,
    source: String,
    released: bool,
}

#[derive(Debug, Serialize)]
struct UpstreamView {
    project: String,
    url: String,
    filed: String,
    filed_by: String,
}

#[derive(Debug, Serialize)]
struct Item {
    id: String,
    status: String,
    summary: String,
    runtimes: Vec<String>,
    latest_observations: Vec<ObservationView>,
    upstream: Vec<UpstreamView>,
    /// One path per `[[repro]]`; an evidence repro that needs a person is
    /// marked so the reader does not mistake it for a check.
    repros: Vec<String>,
    entry_md: String,
    last_run: Vec<LastRunRecord>,
    /// Why an entry is in `Possibly retirable`.
    why: Option<String>,
    /// Targets whose last run did not reproduce while others still did; the
    /// entry stays in its status group.
    note: Option<String>,
    /// For `Gaps`, the runtime the item is grouped under.
    section: Option<String>,
}

#[derive(Debug, Serialize)]
struct Group {
    heading: &'static str,
    items: Vec<Item>,
}

#[derive(Debug, Serialize)]
struct Report {
    last_run_finished: Option<String>,
    /// Set by `list` when the last-run file exists but cannot be used.
    last_run_error: Option<String>,
    broken_entries: Vec<String>,
    groups: Vec<Group>,
}

/// Newest record (by date) for each runtime+OS pair, sorted by runtime then OS.
/// On equal dates the later record in the file wins.
fn latest_observations(entry: &Entry) -> Vec<ObservationView> {
    let mut newest: Vec<&super::entry::Observation> = Vec::new();
    for obs in &entry.observed {
        match newest
            .iter_mut()
            .find(|n| n.runtime == obs.runtime && n.os == obs.os)
        {
            Some(slot) => {
                if obs.date.to_string() >= slot.date.to_string() {
                    *slot = obs;
                }
            }
            None => newest.push(obs),
        }
    }
    newest.sort_by(|a, b| (&a.runtime, &a.os).cmp(&(&b.runtime, &b.os)));
    newest
        .into_iter()
        .map(|o| ObservationView {
            runtime: o.runtime.clone(),
            version: o.version.clone(),
            os: o.os.clone(),
            reproduced: o.reproduced,
            date: o.date.to_string(),
            source: o.source.clone(),
            released: o.released,
        })
        .collect()
}

fn item(dir: &str, entry: &Entry, last: Option<&LastRun>) -> Item {
    let base = format!("{REGISTRY_REL}/{dir}");
    Item {
        id: entry.id.clone(),
        status: entry.status.to_string(),
        summary: entry.summary.clone(),
        runtimes: entry.runtimes.clone(),
        latest_observations: latest_observations(entry),
        upstream: entry
            .upstream
            .iter()
            .map(|u| UpstreamView {
                project: u.project.clone(),
                url: u.url.clone(),
                filed: u.filed.to_string(),
                filed_by: u.filed_by.clone(),
            })
            .collect(),
        repros: entry
            .repro
            .iter()
            .map(|r| {
                let path = format!("{base}/repro/{}", r.entry);
                if r.self_judging {
                    path
                } else {
                    format!("{path} (evidence; not self-judging)")
                }
            })
            .collect(),
        entry_md: format!("{base}/entry.md"),
        last_run: last
            .map(|l| {
                l.records
                    .iter()
                    .filter(|r| r.id == entry.id)
                    .cloned()
                    .collect()
            })
            .unwrap_or_default(),
        why: None,
        note: None,
        section: None,
    }
}

/// Place every non-retired entry in exactly one group.
fn build(entries: &[(String, Entry)], last: Option<&LastRun>) -> Report {
    use super::entry::{Kind, Status};
    let mut ready = Vec::new();
    let mut filed = Vec::new();
    let mut retirable = Vec::new();
    let mut reduction = Vec::new();
    let mut gaps = Vec::new();
    for (dir, entry) in entries {
        if entry.status == Status::Retired {
            continue;
        }
        let mut it = item(dir, entry, last);
        // A gap is a missing capability, not a defect to file; it is only
        // ever listed under `Gaps`, with its status shown there.
        if entry.kind == Kind::Gap {
            it.section = Some(entry.runtimes.first().cloned().unwrap_or_default());
            gaps.push(it);
            continue;
        }
        match entry.status {
            Status::FixedUpstream => {
                it.why = Some("fixed upstream".to_string());
                retirable.push(it);
            }
            Status::Confirmed | Status::Reported => {
                let gone: Vec<String> = it
                    .last_run
                    .iter()
                    .filter(|r| r.verdict == Verdict::NotReproduced)
                    .map(|r| format!("{} {} ({})", r.target, r.version, r.os))
                    .collect();
                let still = it
                    .last_run
                    .iter()
                    .any(|r| r.verdict == Verdict::Reproduced);
                // An inconclusive run says nothing either way: it neither
                // counts as "did not reproduce" nor lets the others stand for
                // the whole entry.
                let unknown = it
                    .last_run
                    .iter()
                    .any(|r| r.verdict == Verdict::Inconclusive);
                // Retirable only when every target's last run gave a verdict
                // and none reproduced. Otherwise the entry keeps its place and
                // names the targets that did not reproduce.
                if !gone.is_empty() && !still && !unknown {
                    it.why = Some(format!("last run did not reproduce on {}", gone.join(", ")));
                    retirable.push(it);
                    continue;
                }
                if !gone.is_empty() {
                    let rest = if still {
                        "it still reproduced elsewhere"
                    } else {
                        "the other targets' last runs were inconclusive"
                    };
                    it.note = Some(format!(
                        "last run did not reproduce on {}; {rest}",
                        gone.join(", ")
                    ));
                }
                if entry.status == Status::Confirmed && entry.upstream.is_empty() {
                    ready.push(it);
                } else {
                    // `reported`, or confirmed with a report already recorded.
                    filed.push(it);
                }
            }
            Status::Suspected => reduction.push(it),
            Status::Retired => {}
        }
    }
    gaps.sort_by(|a, b| a.section.cmp(&b.section));
    Report {
        last_run_finished: last.map(|l| l.finished.clone()),
        last_run_error: None,
        broken_entries: Vec::new(),
        groups: vec![
            Group {
                heading: READY,
                items: ready,
            },
            Group {
                heading: FILED,
                items: filed,
            },
            Group {
                heading: RETIRABLE,
                items: retirable,
            },
            Group {
                heading: REDUCTION,
                items: reduction,
            },
            Group {
                heading: GAPS,
                items: gaps,
            },
        ],
    }
}

fn render_report(report: &Report) -> String {
    let mut out = String::new();
    if !report.broken_entries.is_empty() {
        out.push_str("Broken entries\n");
        for message in &report.broken_entries {
            out.push_str(&format!("  {message}\n"));
        }
        out.push('\n');
    }
    match (&report.last_run_finished, &report.last_run_error) {
        (_, Some(error)) => out.push_str(&format!("Last run: {error}\n\n")),
        (Some(finished), None) => out.push_str(&format!("Last run: {finished}\n\n")),
        (None, None) => {}
    }
    for group in &report.groups {
        out.push_str(group.heading);
        out.push('\n');
        if group.items.is_empty() {
            out.push_str("  (none)\n\n");
            continue;
        }
        let mut section: Option<&str> = None;
        for item in &group.items {
            if group.heading == GAPS && section != item.section.as_deref() {
                section = item.section.as_deref();
                out.push_str(&format!("  [{}]\n", section.unwrap_or("")));
            }
            out.push_str(&format!("  {}  {}\n", item.id, item.summary));
            if group.heading == GAPS || group.heading == RETIRABLE {
                out.push_str(&format!("      status: {}\n", item.status));
            }
            if let Some(why) = &item.why {
                out.push_str(&format!("      why: {why}\n"));
            }
            if let Some(note) = &item.note {
                out.push_str(&format!("      note: {note}\n"));
            }
            out.push_str(&format!("      runtimes: {}\n", item.runtimes.join(", ")));
            for o in &item.latest_observations {
                out.push_str(&format!(
                    "      observed: {} {} on {}: {} ({}{})\n",
                    o.runtime,
                    o.version,
                    o.os,
                    if o.reproduced {
                        "reproduced"
                    } else {
                        "not reproduced"
                    },
                    o.date,
                    if o.released { ", released" } else { "" },
                ));
            }
            for r in &item.last_run {
                out.push_str(&format!(
                    "      last run: {} {} on {}: {}\n",
                    r.target,
                    r.version,
                    r.os,
                    verdict_word(r.verdict),
                ));
            }
            for u in &item.upstream {
                out.push_str(&format!(
                    "      upstream: {} {} (filed {} by {})\n",
                    u.project, u.url, u.filed, u.filed_by
                ));
            }
            for repro in &item.repros {
                out.push_str(&format!("      repro: {repro}\n"));
            }
            out.push_str(&format!("      entry: {}\n", item.entry_md));
        }
        out.push('\n');
    }
    out
}

fn verdict_word(v: Verdict) -> &'static str {
    match v {
        Verdict::Reproduced => "reproduced",
        Verdict::NotReproduced => "not reproduced",
        Verdict::Inconclusive => "inconclusive",
    }
}

/// The report text without `list`'s file reading; the interface `list` and
/// the tests share.
#[allow(dead_code)]
pub fn render(entries: &[(String, Entry)], last: Option<&LastRun>) -> String {
    render_report(&build(entries, last))
}

/// A last-run file that is absent is normal; one that cannot be read or
/// parsed is reported once and otherwise ignored.
fn read_last_run(repo: &Path) -> (Option<LastRun>, Option<String>) {
    let path = last_run_path(repo);
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return (None, None),
        Err(e) => {
            return (
                None,
                Some(format!("ignored {}: read failed: {e}", path.display())),
            )
        }
    };
    match serde_json::from_str::<LastRun>(&text) {
        Ok(last) => (Some(last), None),
        Err(e) => (
            None,
            Some(format!("ignored {}: malformed: {e}", path.display())),
        ),
    }
}

/// The text (or JSON) the `list` subcommand prints. Broken entries and an
/// unusable last-run file are reported in the output, not as failures.
pub fn list(repo: &Path, json: bool) -> Result<String, String> {
    let loaded = load_registry(&registry(repo))?;
    let (last, last_error) = read_last_run(repo);
    let mut report = build(&loaded.entries, last.as_ref());
    report.broken_entries = loaded.broken;
    report.last_run_error = last_error;
    if json {
        let mut text =
            serde_json::to_string_pretty(&report).map_err(|e| format!("serialize report: {e}"))?;
        text.push('\n');
        Ok(text)
    } else {
        Ok(render_report(&report))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const HEADINGS: [&str; 5] = [
        "Ready to file",
        "Filed",
        "Possibly retirable",
        "Needs reduction",
        "Gaps",
    ];

    fn entry(id: &str, kind: &str, status: &str, extra: &str) -> (String, Entry) {
        let text = format!(
            r#"
id = "{id}"
kind = "{kind}"
status = "{status}"
runtimes = ["webkit"]
summary = "summary of {id}"
{extra}
"#
        );
        (id.to_string(), toml::from_str(&text).unwrap())
    }

    const REPRO: &str = r#"
[[repro]]
kind = "script"
entry = "repro.mjs"
targets = ["node"]
self_judging = true

[[observed]]
runtime = "webkit"
version = "18.2"
os = "macos"
reproduced = true
date = 2026-10-01

[[observed]]
runtime = "webkit"
version = "18.4"
os = "macos"
reproduced = false
date = 2026-10-20

[[observed]]
runtime = "webkit"
version = "18.0"
os = "ios"
reproduced = true
date = 2026-09-01
"#;

    const UPSTREAM: &str = r#"
[[upstream]]
project = "WebKit"
url = "https://bugs.webkit.org/show_bug.cgi?id=1"
filed = 2026-10-05
filed_by = "brandon"
"#;

    /// The lines under `heading`, up to the next group heading.
    fn section(out: &str, heading: &str) -> String {
        let mut lines = out.lines();
        for line in lines.by_ref() {
            if line == heading {
                break;
            }
        }
        lines
            .take_while(|l| !HEADINGS.contains(l))
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn last_run(id: &str, verdict: Verdict) -> LastRun {
        LastRun {
            finished: "2026-10-22T10:00:00Z".to_string(),
            records: vec![LastRunRecord {
                id: id.to_string(),
                target: "firefox".to_string(),
                os: "macos".to_string(),
                version: "130".to_string(),
                verdict,
                details: String::new(),
            }],
        }
    }

    #[test]
    fn headings_appear_in_order() {
        let out = render(&[], None);
        let positions: Vec<usize> = HEADINGS
            .iter()
            .map(|h| out.lines().position(|l| l == *h).unwrap_or(usize::MAX))
            .collect();
        assert!(positions.windows(2).all(|w| w[0] < w[1]), "{out}");
    }

    #[test]
    fn ready_to_file_lists_confirmed_unreported() {
        let entries = [
            entry("A-READY", "bug", "confirmed", REPRO),
            entry("B-FILED", "bug", "reported", &format!("{REPRO}{UPSTREAM}")),
        ];
        let out = render(&entries, None);
        let ready = section(&out, "Ready to file");
        assert!(ready.contains("A-READY"), "{out}");
        assert!(ready.contains("summary of A-READY"), "{out}");
        assert!(!ready.contains("B-FILED"), "{out}");
        // Latest observation per runtime+OS: the 18.4 record replaces 18.2.
        assert!(ready.contains("18.4"), "{ready}");
        assert!(!ready.contains("18.2"), "{ready}");
        assert!(ready.contains("18.0"), "{ready}");
        assert!(
            ready.contains("tests/runtime-workarounds/A-READY/entry.md"),
            "{ready}"
        );
        assert!(
            ready.contains("tests/runtime-workarounds/A-READY/repro/repro.mjs"),
            "{ready}"
        );
    }

    #[test]
    fn filed_shows_upstream_urls() {
        let entries = [entry(
            "B-FILED",
            "bug",
            "reported",
            &format!("{REPRO}{UPSTREAM}"),
        )];
        let out = render(&entries, None);
        let filed = section(&out, "Filed");
        assert!(filed.contains("B-FILED"), "{out}");
        assert!(
            filed.contains("https://bugs.webkit.org/show_bug.cgi?id=1"),
            "{out}"
        );
        assert!(!section(&out, "Ready to file").contains("B-FILED"), "{out}");
    }

    #[test]
    fn not_reproduced_last_run_marks_possibly_retirable() {
        let entries = [
            entry("C-CONFIRMED", "bug", "confirmed", REPRO),
            entry(
                "D-REPORTED",
                "bug",
                "reported",
                &format!("{REPRO}{UPSTREAM}"),
            ),
            entry("E-FIXED", "bug", "fixed-upstream", REPRO),
        ];
        let mut last = last_run("C-CONFIRMED", Verdict::NotReproduced);
        last.records
            .extend(last_run("D-REPORTED", Verdict::NotReproduced).records);
        let out = render(&entries, Some(&last));
        let retirable = section(&out, "Possibly retirable");
        for id in ["C-CONFIRMED", "D-REPORTED", "E-FIXED"] {
            assert!(retirable.contains(id), "{out}");
        }
        assert!(
            !section(&out, "Ready to file").contains("C-CONFIRMED"),
            "{out}"
        );
        assert!(!section(&out, "Filed").contains("D-REPORTED"), "{out}");

        // A reproduced or inconclusive last run does not move an entry.
        let kept = last_run("C-CONFIRMED", Verdict::Reproduced);
        let out = render(&entries[..1], Some(&kept));
        assert!(
            section(&out, "Ready to file").contains("C-CONFIRMED"),
            "{out}"
        );
        assert!(
            !section(&out, "Possibly retirable").contains("C-CONFIRMED"),
            "{out}"
        );
    }

    fn record(id: &str, target: &str, version: &str, verdict: Verdict) -> LastRunRecord {
        LastRunRecord {
            id: id.to_string(),
            target: target.to_string(),
            os: "macos".to_string(),
            version: version.to_string(),
            verdict,
            details: String::new(),
        }
    }

    #[test]
    fn partly_reproducing_entry_keeps_its_group_with_a_note() {
        let entries = [
            entry("C-CONFIRMED", "bug", "confirmed", REPRO),
            entry(
                "D-REPORTED",
                "bug",
                "reported",
                &format!("{REPRO}{UPSTREAM}"),
            ),
        ];
        let mut records = Vec::new();
        for id in ["C-CONFIRMED", "D-REPORTED"] {
            records.push(record(id, "bun", "1.3.3", Verdict::Reproduced));
            records.push(record(id, "webkit", "26.6", Verdict::NotReproduced));
        }
        let last = LastRun {
            finished: "2026-10-22T10:00:00Z".to_string(),
            records,
        };
        let out = render(&entries, Some(&last));
        let ready = section(&out, "Ready to file");
        assert!(ready.contains("C-CONFIRMED"), "{out}");
        assert!(
            ready.contains("note: last run did not reproduce on webkit 26.6 (macos)"),
            "{out}"
        );
        assert!(!ready.contains("bun 1.3.3 (macos)"), "{out}");
        assert!(section(&out, "Filed").contains("D-REPORTED"), "{out}");
        assert!(
            section(&out, "Filed").contains("note: last run did not reproduce on webkit 26.6"),
            "{out}"
        );
        assert!(
            section(&out, "Possibly retirable").contains("(none)"),
            "{out}"
        );
    }

    #[test]
    fn inconclusive_target_keeps_entry_in_its_group() {
        let entries = [entry("C-CONFIRMED", "bug", "confirmed", REPRO)];
        let last = LastRun {
            finished: "2026-10-22T10:00:00Z".to_string(),
            records: vec![
                record("C-CONFIRMED", "bun", "1.3.3", Verdict::Inconclusive),
                record("C-CONFIRMED", "webkit", "26.6", Verdict::NotReproduced),
            ],
        };
        let out = render(&entries, Some(&last));
        let ready = section(&out, "Ready to file");
        assert!(ready.contains("C-CONFIRMED"), "{out}");
        assert!(
            ready.contains(
                "note: last run did not reproduce on webkit 26.6 (macos); \
                 the other targets' last runs were inconclusive"
            ),
            "{out}"
        );
        assert!(!ready.contains("note: last run did not reproduce on bun"), "{out}");
        assert!(
            !section(&out, "Possibly retirable").contains("C-CONFIRMED"),
            "{out}"
        );
    }

    #[test]
    fn entry_is_retirable_only_when_no_target_reproduced() {
        let entries = [entry("C-CONFIRMED", "bug", "confirmed", REPRO)];
        let last = LastRun {
            finished: "2026-10-22T10:00:00Z".to_string(),
            records: vec![
                record("C-CONFIRMED", "bun", "1.4.0", Verdict::NotReproduced),
                record("C-CONFIRMED", "webkit", "26.6", Verdict::NotReproduced),
            ],
        };
        let out = render(&entries, Some(&last));
        let retirable = section(&out, "Possibly retirable");
        assert!(retirable.contains("C-CONFIRMED"), "{out}");
        assert!(
            retirable.contains("why: last run did not reproduce on bun 1.4.0 (macos), webkit 26.6 (macos)"),
            "{out}"
        );
        assert!(!retirable.contains("note:"), "{out}");
        assert!(!section(&out, "Ready to file").contains("C-CONFIRMED"), "{out}");
    }

    #[test]
    fn every_repro_path_is_listed_and_evidence_is_marked() {
        let two = REPRO.replace(
            "self_judging = true\n",
            "self_judging = true\n\n[[repro]]\nkind = \"browser-page\"\nentry = \"page.html\"\n\
             targets = [\"webkit\"]\nself_judging = false\n",
        );
        let out = render(&[entry("A-READY", "bug", "confirmed", &two)], None);
        let ready = section(&out, "Ready to file");
        assert!(
            ready.contains("repro: tests/runtime-workarounds/A-READY/repro/repro.mjs\n"),
            "{out}"
        );
        assert!(
            ready.contains(
                "repro: tests/runtime-workarounds/A-READY/repro/page.html (evidence; not self-judging)"
            ),
            "{out}"
        );
    }

    #[test]
    fn suspected_goes_to_needs_reduction_never_ready() {
        let entries = [entry("F-SUSPECT", "bug", "suspected", "")];
        let out = render(&entries, None);
        assert!(
            section(&out, "Needs reduction").contains("F-SUSPECT"),
            "{out}"
        );
        assert!(
            !section(&out, "Ready to file").contains("F-SUSPECT"),
            "{out}"
        );
    }

    #[test]
    fn retired_is_omitted() {
        let entries = [entry(
            "G-RETIRED",
            "bug",
            "retired",
            "retired_reason = \"gone\"\nretired_commit = \"abc\"",
        )];
        let out = render(&entries, None);
        assert!(!out.contains("G-RETIRED"), "{out}");
    }

    #[test]
    fn gap_listed_under_gaps() {
        let entries = [
            entry("H-GAP", "gap", "confirmed", REPRO),
            entry("I-GAP-SUSPECT", "gap", "suspected", ""),
        ];
        let out = render(&entries, None);
        let gaps = section(&out, "Gaps");
        assert!(gaps.contains("H-GAP"), "{out}");
        assert!(gaps.contains("I-GAP-SUSPECT"), "{out}");
        assert!(gaps.contains("confirmed"), "{out}");
        for heading in [
            "Ready to file",
            "Filed",
            "Possibly retirable",
            "Needs reduction",
        ] {
            let other = section(&out, heading);
            assert!(
                !other.contains("H-GAP") && !other.contains("I-GAP"),
                "{out}"
            );
        }
    }

    fn repo_with(entries: &[(&str, &str)]) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        for (name, body) in entries {
            let d = dir.path().join("tests/runtime-workarounds").join(name);
            std::fs::create_dir_all(&d).unwrap();
            std::fs::write(d.join("entry.toml"), body).unwrap();
        }
        dir
    }

    const GOOD: &str = "id = \"J-GOOD\"\nkind = \"bug\"\nstatus = \"suspected\"\n\
                        runtimes = [\"node\"]\nsummary = \"s\"\n";

    #[test]
    fn list_survives_broken_entries_and_reports_them_first() {
        let repo = repo_with(&[("J-GOOD", GOOD), ("K-BROKEN", "not = [valid")]);
        let out = list(repo.path(), false).unwrap();
        assert!(out.starts_with("Broken entries\n"), "{out}");
        assert!(out.contains("K-BROKEN"), "{out}");
        assert!(section(&out, "Needs reduction").contains("J-GOOD"), "{out}");
        let clean = repo_with(&[("J-GOOD", GOOD)]);
        assert!(!list(clean.path(), false)
            .unwrap()
            .contains("Broken entries"));
    }

    #[test]
    fn list_reads_last_run_and_tolerates_missing_or_malformed() {
        let repo = repo_with(&[("J-GOOD", GOOD)]);
        let out = list(repo.path(), false).unwrap();
        assert!(!out.contains("Last run"), "{out}");

        let path = last_run_path(repo.path());
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "{ nope").unwrap();
        let out = list(repo.path(), false).unwrap();
        assert_eq!(out.matches("Last run: ignored").count(), 1, "{out}");
        assert!(section(&out, "Needs reduction").contains("J-GOOD"), "{out}");

        let last = last_run("J-GOOD", Verdict::Reproduced);
        std::fs::write(&path, serde_json::to_string(&last).unwrap()).unwrap();
        let out = list(repo.path(), false).unwrap();
        assert!(out.contains("Last run: 2026-10-22T10:00:00Z"), "{out}");
        assert!(
            out.contains("last run: firefox 130 on macos: reproduced"),
            "{out}"
        );
        // The file round-trips with the kebab-case verdict `run` will write.
        let raw = serde_json::to_string(&last_run("J-GOOD", Verdict::NotReproduced)).unwrap();
        assert!(raw.contains("\"not-reproduced\""), "{raw}");
    }

    #[test]
    fn json_prints_the_same_grouping() {
        let repo = repo_with(&[("J-GOOD", GOOD)]);
        let out = list(repo.path(), true).unwrap();
        let value: serde_json::Value = serde_json::from_str(&out).unwrap();
        let groups = value["groups"].as_array().unwrap();
        let headings: Vec<&str> = groups
            .iter()
            .map(|g| g["heading"].as_str().unwrap())
            .collect();
        assert_eq!(headings, HEADINGS);
        assert_eq!(groups[3]["items"][0]["id"], "J-GOOD");
    }
}
