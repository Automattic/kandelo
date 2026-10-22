//! `xtask runtime-workarounds`: the registry of workarounds for defects in
//! outside runtimes and toolchains. See `tests/runtime-workarounds/README.md`.

// Entry fields and helpers here are consumed by the `list` and `run`
// subcommands, which arrive after `check`.
#[allow(dead_code)]
pub mod check;
#[allow(dead_code)]
pub mod entry;
pub mod scan;

use std::path::{Path, PathBuf};

/// Where entries live: reproductions are tests, so the registry is under `tests/`.
pub fn registry(repo: &Path) -> PathBuf {
    repo.join("tests").join("runtime-workarounds")
}

pub(crate) fn run(args: Vec<String>) -> Result<(), String> {
    let Some(sub) = args.first() else {
        return Err("usage: xtask runtime-workarounds <check|list|run>".to_string());
    };
    match sub.as_str() {
        "check" => run_check(),
        "list" | "run" => Err("not implemented yet".to_string()),
        other => Err(format!(
            "unknown runtime-workarounds subcommand {other:?} (expected check, list or run)"
        )),
    }
}

fn run_check() -> Result<(), String> {
    let report = check::analyze(&crate::repo_root())?;
    if !report.problems.is_empty() {
        for problem in &report.problems {
            eprintln!("{problem}");
        }
        return Err(format!(
            "{} runtime workaround problem(s)",
            report.problems.len()
        ));
    }
    println!(
        "runtime-workarounds: {} entries, {} tag sites, consistent",
        report.entries, report.tag_sites
    );
    Ok(())
}
