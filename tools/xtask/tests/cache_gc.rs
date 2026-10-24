//! Exercise the public command against isolated machine-shaped caches.
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, SystemTime};

fn generation(root: &Path, abi: u32, key: u32) -> PathBuf {
    let path = root.join(format!("libs/zlib-1.0-rev1-wasm32-abi{abi}-{key:064x}"));
    fs::create_dir_all(&path).unwrap();
    fs::write(path.join("lib.a"), vec![7; 10_000]).unwrap();
    fs::File::open(&path)
        .unwrap()
        .set_modified(SystemTime::now() - Duration::from_secs(60 * 86400))
        .unwrap();
    path
}

fn run(home: &Path, args: &[&str], source_override: Option<&Path>) -> String {
    run_with_filter(home, &["--below-abi", "49"], args, source_override)
}

fn run_with_filter(
    home: &Path,
    filter: &[&str],
    args: &[&str],
    source_override: Option<&Path>,
) -> String {
    let mut command = Command::new(env!("CARGO_BIN_EXE_xtask"));
    command
        .env_clear()
        .env("HOME", home)
        .arg("cache-gc")
        .args(filter)
        .args(args);
    if let Some(root) = source_override {
        command.env("KANDELO_SOURCE_CACHE_ROOT", root);
    }
    let output = command.output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap()
}

#[test]
fn abi_gc_defaults_to_both_caches_and_reports_one_combined_total() {
    let home = tempfile::TempDir::new().unwrap();
    let binary = home.path().join(".cache/kandelo");
    let source = binary.join("source-only/source-only-v1/compiled");
    let old_binary = generation(&binary, 48, 1);
    let old_source = generation(&source, 48, 2);
    let current_binary = generation(&binary, 49, 3);

    let dry_run = run(home.path(), &[], None);
    assert!(dry_run.contains(old_binary.to_str().unwrap()));
    assert!(dry_run.contains(old_source.to_str().unwrap()));
    assert!(dry_run.contains("cache-gc total across caches would remove:"));
    assert!(old_binary.exists() && old_source.exists() && current_binary.exists());

    let applied = run(home.path(), &["--apply"], None);
    assert!(!old_binary.exists() && !old_source.exists());
    assert!(
        current_binary.exists(),
        "age does not evict the ordinary cache's current ABI"
    );
    assert!(applied.contains("cache-gc total across caches removed:"));
}

#[test]
fn source_override_stays_isolated_unless_binary_cache_is_explicitly_selected() {
    let home = tempfile::TempDir::new().unwrap();
    let binary = home.path().join(".cache/kandelo");
    let isolated = home.path().join("private-source");
    let old_binary = generation(&binary, 48, 4);
    let old_source = generation(&isolated.join("source-only-v1/compiled"), 48, 5);

    let cli = run(
        home.path(),
        &["--source-cache-root", isolated.to_str().unwrap()],
        None,
    );
    let env = run(home.path(), &[], Some(&isolated));
    for output in [cli, env] {
        assert!(output.contains(old_source.to_str().unwrap()));
        assert!(!output.contains(old_binary.to_str().unwrap()));
        assert!(!output.contains("total across caches"));
    }

    let applied = run(
        home.path(),
        &["--apply", "--binary-cache-root", binary.to_str().unwrap()],
        Some(&isolated),
    );
    assert!(!old_source.exists() && !old_binary.exists());
    assert!(applied.contains("total across caches removed:"));
}

#[test]
fn above_abi_gc_is_dry_by_default_and_applies_to_both_cache_layouts() {
    let home = tempfile::TempDir::new().unwrap();
    let binary = home.path().join(".cache/kandelo");
    let source_base = binary.join("source-only");
    let source = source_base.join("source-only-v1/compiled");
    let future_binary = generation(&binary, 59, 10);
    let future_source = generation(&source, 55, 11);
    let boundary_binary = generation(&binary, 54, 12);
    let boundary_source = generation(&source, 54, 13);
    let main_binary = generation(&binary, 53, 14);
    let filter = ["--above-abi", "54", "--max-age-days", "36500"];
    let dry = run_with_filter(home.path(), &filter, &[], None);
    assert!(
        dry.contains("above --above-abi 54") && dry.contains("total across caches would remove:")
    );
    for path in [
        &future_binary,
        &future_source,
        &boundary_binary,
        &boundary_source,
        &main_binary,
    ] {
        assert!(path.is_dir());
    }
    assert!(!source_base.join(".kandelo-cache-gc.lock").exists());
    assert!(!binary.join(".kandelo-cache-gc.lock").exists());
    let applied = run_with_filter(home.path(), &filter, &["--apply"], None);
    assert!(!future_binary.exists() && !future_source.exists());
    assert!(boundary_binary.is_dir() && boundary_source.is_dir() && main_binary.is_dir());
    assert!(applied.contains("total across caches removed:"));
}

#[test]
fn above_abi_inline_and_explicit_binary_selection_respect_source_isolation() {
    let home = tempfile::TempDir::new().unwrap();
    let binary = home.path().join(".cache/kandelo");
    let isolated = home.path().join("private-source");
    let future_binary = generation(&binary, 59, 15);
    let future_source = generation(&isolated.join("source-only-v1/compiled"), 59, 16);
    let filter = ["--above-abi=54", "--max-age-days=36500"];
    let cli = run_with_filter(
        home.path(),
        &filter,
        &["--source-cache-root", isolated.to_str().unwrap()],
        None,
    );
    let env = run_with_filter(home.path(), &filter, &[], Some(&isolated));
    for output in [cli, env] {
        assert!(output.contains(future_source.to_str().unwrap()));
        assert!(!output.contains(future_binary.to_str().unwrap()));
        assert!(!output.contains("total across caches"));
    }
    assert!(future_binary.is_dir() && future_source.is_dir());
    let applied = run_with_filter(
        home.path(),
        &filter,
        &["--apply", "--binary-cache-root", binary.to_str().unwrap()],
        Some(&isolated),
    );
    assert!(!future_binary.exists() && !future_source.exists());
    assert!(applied.contains("total across caches removed:"));
}
