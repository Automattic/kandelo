//! Consistency between the registry's entries and the tags in tracked source.

use super::entry::{load_registry, Entry, ReportPolicy, Status, TARGETS};
use super::registry;
use super::scan::{scan, tracked_files, TAG_WORD};
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

pub struct Report {
    pub problems: Vec<String>,
    pub entries: usize,
    pub tag_sites: usize,
}

/// The problems alone, for tests; the `check` subcommand wants the counts too.
#[cfg(test)]
pub fn problems(repo: &Path) -> Result<Vec<String>, String> {
    Ok(analyze(repo)?.problems)
}

pub fn analyze(repo: &Path) -> Result<Report, String> {
    let registry_dir = registry(repo);
    let loaded = load_registry(&registry_dir)?;
    let entries = loaded.entries;
    let known: BTreeSet<String> = entries.iter().map(|(_, e)| e.id.clone()).collect();
    let scanned = scan(repo, &known)?;
    let tracked: BTreeSet<String> = tracked_files(repo)?.into_iter().collect();

    let mut problems = loaded.broken;
    let mut tags_by_id: BTreeMap<&str, usize> = BTreeMap::new();
    for site in &scanned.tags {
        if known.contains(&site.id) {
            *tags_by_id.entry(&site.id).or_default() += 1;
        } else {
            problems.push(format!(
                "{}:{}: tag names unknown workaround ID {}",
                site.path.display(),
                site.line,
                site.id
            ));
        }
    }
    for site in &scanned.malformed {
        problems.push(format!(
            "{}:{}: malformed workaround tag (expected `[{TAG_WORD}: <ID>]` with an \
             upper-case, hyphenated ID)",
            site.path.display(),
            site.line
        ));
    }
    for site in &scanned.legacy {
        problems.push(format!(
            "{}:{}: legacy bare tag [{}]; rewrite it with the registry tag prefix",
            site.path.display(),
            site.line,
            site.id
        ));
    }

    for (dir, entry) in &entries {
        let tags = tags_by_id.get(entry.id.as_str()).copied().unwrap_or(0);
        entry_problems(
            &mut problems,
            &registry_dir.join(dir),
            dir,
            entry,
            tags,
            &tracked,
        );
    }

    Ok(Report {
        problems,
        entries: entries.len(),
        tag_sites: scanned.tags.len(),
    })
}

fn entry_problems(
    out: &mut Vec<String>,
    dir_path: &Path,
    dir: &str,
    entry: &Entry,
    tags: usize,
    tracked: &BTreeSet<String>,
) {
    let id = &entry.id;
    let mut problem = |msg: String| out.push(format!("{id}: {msg}"));

    if dir != entry.id {
        problem(format!("directory name {dir:?} differs from id"));
    }
    if !dir_path.join("entry.md").is_file() {
        problem("missing entry.md".to_string());
    }

    match entry.status {
        Status::Retired => {
            if tags > 0 {
                problem(format!(
                    "retired but {tags} tag site(s) remain in the source"
                ));
            }
            if entry.retired_reason.is_none() {
                problem("retired without retired_reason".to_string());
            }
        }
        _ => {
            if tags == 0 && entry.sites_without_tags.is_empty() {
                problem("no tag site in the source and no sites_without_tags".to_string());
            }
        }
    }

    if matches!(
        entry.status,
        Status::Confirmed | Status::Reported | Status::FixedUpstream
    ) {
        match &entry.repro {
            None => problem(format!("status {} requires a repro", entry.status)),
            Some(repro) if !repro.self_judging => {
                problem("repro is not self-judging, so the entry cannot be beyond suspected".into())
            }
            Some(_) => {}
        }
        if !entry.observed.iter().any(|o| o.reproduced) {
            problem("no observed record with reproduced = true".to_string());
        }
    }
    if matches!(entry.status, Status::Reported | Status::FixedUpstream) && entry.upstream.is_empty()
    {
        problem("no upstream report recorded".to_string());
    }
    if entry.status == Status::FixedUpstream
        && !entry.observed.iter().any(|o| o.released && !o.reproduced)
    {
        problem(
            "fixed-upstream needs an observed record with released = true and reproduced = false"
                .to_string(),
        );
    }
    if entry.reports == ReportPolicy::AgentsAllowed
        && entry
            .reports_channel
            .as_deref()
            .map_or(true, |c| c.trim().is_empty()) {
        problem("reports = agents-allowed requires reports_channel".to_string());
    }

    if let Some(repro) = &entry.repro {
        for target in &repro.targets {
            if !TARGETS.contains(&target.as_str()) {
                problem(format!("repro target {target:?} is not one of {TARGETS:?}"));
            }
        }
        if !dir_path.join("repro").join(&repro.entry).is_file() {
            problem(format!("repro entry repro/{} does not exist", repro.entry));
        }
    }
    for site in &entry.sites_without_tags {
        if !tracked.contains(&site.path) {
            problem(format!(
                "sites_without_tags path {:?} is not a tracked file",
                site.path
            ));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime_workarounds::scan::TAG_WORD;
    use std::path::PathBuf;
    use std::process::Command;

    const ID: &str = "FOO-BAR";

    fn tag(id: &str) -> String {
        format!("[{TAG_WORD}: {id}]")
    }

    struct Repo {
        dir: tempfile::TempDir,
    }

    impl Repo {
        fn new() -> Self {
            let dir = tempfile::tempdir().unwrap();
            let status = Command::new("git")
                .arg("-C")
                .arg(dir.path())
                .args(["init", "-q"])
                .status()
                .unwrap();
            assert!(status.success());
            Repo { dir }
        }

        fn path(&self) -> &Path {
            self.dir.path()
        }

        fn write(&self, rel: &str, contents: impl AsRef<[u8]>) {
            let path: PathBuf = self.path().join(rel);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, contents).unwrap();
        }

        fn track(&self) {
            let status = Command::new("git")
                .arg("-C")
                .arg(self.path())
                .args(["add", "-A"])
                .status()
                .unwrap();
            assert!(status.success());
        }

        fn problems(&self) -> Vec<String> {
            self.track();
            problems(self.path()).unwrap()
        }

        fn entry(&self, id: &str, toml: &str) {
            let base = format!("tests/runtime-workarounds/{id}");
            self.write(&format!("{base}/entry.toml"), toml);
            self.write(&format!("{base}/entry.md"), "# entry\n");
            self.write(&format!("{base}/repro/repro.mjs"), "// repro\n");
        }
    }

    fn confirmed_toml(id: &str, self_judging: bool) -> String {
        format!(
            r#"
id = "{id}"
kind = "bug"
status = "confirmed"
runtimes = ["webkit"]
summary = "a defect"

[repro]
kind = "script"
entry = "repro.mjs"
targets = ["node"]
self_judging = {self_judging}

[[observed]]
runtime = "node"
version = "22.0.0"
os = "linux"
reproduced = true
date = 2026-10-22
source = "manual"
released = true
"#
        )
    }

    fn suspected_toml(id: &str, extra: &str) -> String {
        format!(
            r#"
id = "{id}"
kind = "bug"
status = "suspected"
runtimes = ["webkit"]
summary = "a defect"
{extra}
"#
        )
    }

    fn clean_repo() -> Repo {
        let repo = Repo::new();
        repo.entry(ID, &confirmed_toml(ID, true));
        repo.write("src/a.ts", format!("// {} why\n", tag(ID)));
        repo
    }

    fn has(problems: &[String], needle: &str) -> bool {
        problems.iter().any(|p| p.contains(needle))
    }

    #[test]
    fn clean_registry_has_no_problems() {
        assert_eq!(clean_repo().problems(), Vec::<String>::new());
    }

    #[test]
    fn unknown_tag_id_is_reported() {
        let repo = clean_repo();
        repo.write("src/b.ts", format!("// {}\n", tag("NOPE-THING")));
        let problems = repo.problems();
        assert!(has(&problems, "NOPE-THING"), "{problems:?}");
    }

    #[test]
    fn untagged_entry_is_reported() {
        let repo = Repo::new();
        repo.entry(ID, &suspected_toml(ID, ""));
        let problems = repo.problems();
        assert!(has(&problems, "no tag site"), "{problems:?}");
    }

    #[test]
    fn sites_without_tags_satisfies_untagged_entry() {
        let repo = Repo::new();
        repo.write("flags.json", "{}\n");
        repo.entry(
            ID,
            &suspected_toml(
                ID,
                "[[sites_without_tags]]\npath = \"flags.json\"\nnote = \"sets a flag\"\n",
            ),
        );
        assert_eq!(repo.problems(), Vec::<String>::new());
    }

    #[test]
    fn untracked_sites_without_tags_path_is_reported() {
        let repo = Repo::new();
        repo.entry(
            ID,
            &suspected_toml(
                ID,
                "[[sites_without_tags]]\npath = \"gone.json\"\nnote = \"n\"\n",
            ),
        );
        let problems = repo.problems();
        assert!(has(&problems, "gone.json"), "{problems:?}");
    }

    #[test]
    fn retired_entry_must_not_keep_tags() {
        let repo = Repo::new();
        repo.entry(
            ID,
            &format!(
                "id = \"{ID}\"\nkind = \"bug\"\nstatus = \"retired\"\nruntimes = [\"webkit\"]\n\
                 summary = \"s\"\nretired_reason = \"removed\"\n"
            ),
        );
        assert_eq!(repo.problems(), Vec::<String>::new());
        repo.write("src/a.ts", format!("// {}\n", tag(ID)));
        let problems = repo.problems();
        assert!(has(&problems, "retired but 1 tag"), "{problems:?}");
    }

    #[test]
    fn retired_entry_needs_a_reason() {
        let repo = Repo::new();
        repo.entry(
            ID,
            &format!(
                "id = \"{ID}\"\nkind = \"bug\"\nstatus = \"retired\"\nruntimes = [\"webkit\"]\n\
                 summary = \"s\"\n"
            ),
        );
        let problems = repo.problems();
        assert!(has(&problems, "retired_reason"), "{problems:?}");
    }

    #[test]
    fn confirmed_requires_self_judging_repro() {
        let repo = Repo::new();
        repo.entry(ID, &confirmed_toml(ID, false));
        repo.write("src/a.ts", format!("// {}\n", tag(ID)));
        let problems = repo.problems();
        assert!(has(&problems, "self-judging"), "{problems:?}");
    }

    #[test]
    fn reports_malformed_tags() {
        let repo = clean_repo();
        repo.write(
            "src/b.ts",
            format!("// [{TAG_WORD}:x]\n// [{TAG_WORD}: lower-case]\n"),
        );
        let problems = repo.problems();
        assert_eq!(
            problems.iter().filter(|p| p.contains("malformed")).count(),
            2,
            "{problems:?}"
        );
    }

    fn malformed_count(problems: &[String]) -> usize {
        problems.iter().filter(|p| p.contains("malformed")).count()
    }

    #[test]
    fn prose_mention_of_the_tag_word_is_not_a_tag() {
        let repo = clean_repo();
        repo.write(
            "docs/guide.md",
            format!("Mark each site with the {TAG_WORD} tag, see {TAG_WORD}: below.\n"),
        );
        assert_eq!(repo.problems(), Vec::<String>::new());
    }

    #[test]
    fn documentation_placeholder_is_not_malformed() {
        let repo = clean_repo();
        repo.write(
            "docs/guide.md",
            format!("Write `// [{TAG_WORD}: <ID>] why` at each site.\n"),
        );
        assert_eq!(repo.problems(), Vec::<String>::new());
    }

    #[test]
    fn valid_tag_plus_bad_bracketed_opening_is_malformed() {
        let repo = clean_repo();
        repo.write(
            "src/b.ts",
            format!("// {} and [{TAG_WORD}:x]\n", tag(ID)),
        );
        let problems = repo.problems();
        assert_eq!(malformed_count(&problems), 1, "{problems:?}");
    }

    #[test]
    fn broken_entry_toml_is_a_problem_and_other_checks_continue() {
        let repo = clean_repo();
        repo.write("tests/runtime-workarounds/BROKEN-ONE/entry.toml", "not toml {{");
        repo.write("src/b.ts", format!("// {}\n", tag("NOPE-THING")));
        let problems = repo.problems();
        assert!(
            has(&problems, "BROKEN-ONE/entry.toml") && has(&problems, "parse"),
            "{problems:?}"
        );
        assert!(has(&problems, "NOPE-THING"), "{problems:?}");
    }

    #[test]
    fn unknown_field_in_entry_toml_names_the_file() {
        let repo = clean_repo();
        repo.entry("TYPO-ONE", &suspected_toml("TYPO-ONE", "sumary = \"x\""));
        let problems = repo.problems();
        assert!(has(&problems, "TYPO-ONE/entry.toml"), "{problems:?}");
    }

    #[test]
    fn registry_directory_without_entry_toml_is_reported() {
        let repo = clean_repo();
        repo.write("tests/runtime-workarounds/NO-TOML/entry.md", "# notes\n");
        let problems = repo.problems();
        assert!(has(&problems, "NO-TOML: missing entry.toml"), "{problems:?}");
    }

    #[test]
    fn blank_reports_channel_counts_as_missing() {
        let repo = Repo::new();
        repo.entry(
            ID,
            &confirmed_toml(ID, true).replace(
                "summary",
                "reports = \"agents-allowed\"\nreports_channel = \"  \"\nsummary",
            ),
        );
        repo.write("src/a.ts", format!("// {}\n", tag(ID)));
        let problems = repo.problems();
        assert!(has(&problems, "reports_channel"), "{problems:?}");
    }

    #[test]
    fn status_prints_in_kebab_case() {
        let repo = Repo::new();
        repo.entry(
            ID,
            &suspected_toml(ID, "").replace("suspected", "fixed-upstream"),
        );
        repo.write("src/a.ts", format!("// {}\n", tag(ID)));
        let problems = repo.problems();
        assert!(has(&problems, "status fixed-upstream requires"), "{problems:?}");
    }

    #[test]
    fn counts_two_tags_on_one_line() {
        let repo = clean_repo();
        repo.write(
            "src/b.ts",
            format!("// {} and {}\n", tag(ID), tag("OTHER-THING")),
        );
        repo.track();
        let known = BTreeSet::from([ID.to_string()]);
        let scanned = scan(repo.path(), &known).unwrap();
        let on_b: Vec<_> = scanned
            .tags
            .iter()
            .filter(|t| t.path == Path::new("src/b.ts"))
            .collect();
        assert_eq!(on_b.len(), 2, "{on_b:?}");
        assert!(on_b.iter().all(|t| t.line == 1));
    }

    #[test]
    fn reports_legacy_bare_tags() {
        let repo = clean_repo();
        repo.write("src/b.ts", format!("// [{ID}] old form\n"));
        let problems = repo.problems();
        assert!(has(&problems, "legacy"), "{problems:?}");
    }

    #[test]
    fn ignores_registry_and_design_docs() {
        let repo = clean_repo();
        repo.write(
            &format!("tests/runtime-workarounds/{ID}/notes.md"),
            format!("{} and [{TAG_WORD}:x]\n", tag("NOPE-THING")),
        );
        repo.write(
            "docs/superpowers/specs/a.md",
            format!("{} and [{TAG_WORD}:x]\n", tag("NOPE-THING")),
        );
        assert_eq!(repo.problems(), Vec::<String>::new());
    }

    #[test]
    fn skips_binary_files() {
        let repo = clean_repo();
        repo.write("blob.bin", [0xffu8, 0xfe, 0x00, 0x80]);
        assert_eq!(repo.problems(), Vec::<String>::new());
    }

    #[test]
    fn fixed_upstream_needs_released_not_reproduced_observation() {
        let repo = Repo::new();
        let toml = |extra: &str| {
            format!(
                "{}\n{extra}",
                confirmed_toml(ID, true).replace("confirmed", "fixed-upstream")
            ) + "\n[[upstream]]\nproject = \"WebKit\"\nurl = \"https://example.invalid/1\"\n\
                 filed = 2026-10-22\nfiled_by = \"someone\"\n"
        };
        repo.entry(ID, &toml(""));
        repo.write("src/a.ts", format!("// {}\n", tag(ID)));
        let problems = repo.problems();
        assert!(has(&problems, "released = true"), "{problems:?}");

        repo.entry(
            ID,
            &toml(
                "[[observed]]\nruntime = \"node\"\nversion = \"23.0.0\"\nos = \"linux\"\n\
                 reproduced = false\ndate = 2026-10-23\nreleased = true\n",
            ),
        );
        assert_eq!(repo.problems(), Vec::<String>::new());
    }

    #[test]
    fn reported_needs_upstream_and_agents_allowed_needs_channel() {
        let repo = Repo::new();
        repo.entry(
            ID,
            &confirmed_toml(ID, true)
                .replace("confirmed", "reported")
                .replace("summary", "reports = \"agents-allowed\"\nsummary"),
        );
        repo.write("src/a.ts", format!("// {}\n", tag(ID)));
        let problems = repo.problems();
        assert!(has(&problems, "no upstream report"), "{problems:?}");
        assert!(has(&problems, "reports_channel"), "{problems:?}");
    }

    #[test]
    fn unknown_target_and_missing_repro_file_are_reported() {
        let repo = Repo::new();
        repo.entry(
            ID,
            &confirmed_toml(ID, true)
                .replace("\"node\"]", "\"netscape\"]")
                .replace("repro.mjs", "missing.mjs"),
        );
        repo.write("src/a.ts", format!("// {}\n", tag(ID)));
        let problems = repo.problems();
        assert!(has(&problems, "netscape"), "{problems:?}");
        assert!(has(&problems, "missing.mjs"), "{problems:?}");
    }

    #[test]
    fn directory_name_and_entry_md_are_checked() {
        let repo = Repo::new();
        repo.entry("OTHER-DIR", &suspected_toml(ID, ""));
        std::fs::remove_file(repo.path().join("tests/runtime-workarounds/OTHER-DIR/entry.md"))
            .unwrap();
        repo.write("src/a.ts", format!("// {}\n", tag(ID)));
        let problems = repo.problems();
        assert!(has(&problems, "differs from id"), "{problems:?}");
        assert!(has(&problems, "missing entry.md"), "{problems:?}");
    }

    #[test]
    fn fixture_directories_are_skipped() {
        let repo = clean_repo();
        repo.write("tests/runtime-workarounds/_fixture/entry.toml", "not toml {{");
        assert_eq!(repo.problems(), Vec::<String>::new());
    }

    // Enforces the real registry from `cargo test -p xtask` once the existing
    // workarounds have entries.
    #[test]
    #[ignore = "enabled in Task 4 after migration"]
    fn registry_in_repo_is_consistent() {
        let problems = problems(&crate::repo_root()).unwrap();
        assert!(problems.is_empty(), "{problems:#?}");
    }
}
