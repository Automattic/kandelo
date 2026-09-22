//! Destructive-behavior tests for `cache_gc`, all against tempdir caches.

use super::*;

const HOUR: Duration = Duration::from_secs(60 * 60);

fn key(n: u32) -> String {
    format!("{n:064x}")
}

fn set_mtime(path: &Path, when: SystemTime) {
    let since = when.duration_since(UNIX_EPOCH).unwrap();
    let stamp = rustix::fs::Timespec {
        tv_sec: since.as_secs() as _,
        tv_nsec: since.subsec_nanos() as _,
    };
    rustix::fs::utimensat(
        rustix::fs::CWD,
        path,
        &rustix::fs::Timestamps {
            last_access: stamp,
            last_modification: stamp,
        },
        rustix::fs::AtFlags::SYMLINK_NOFOLLOW,
    )
    .unwrap();
}

struct Cache {
    _temp: tempfile::TempDir,
    base: PathBuf,
    compiled: PathBuf,
}

fn cache() -> Cache {
    let temp = tempfile::TempDir::new().unwrap();
    let base = fs::canonicalize(temp.path()).unwrap();
    let compiled = base.join("source-only-v1/compiled");
    for kind in ["libs", "programs"] {
        fs::create_dir_all(compiled.join(kind)).unwrap();
    }
    Cache {
        _temp: temp,
        base,
        compiled,
    }
}

/// A generation shaped like the engine's: the content-addressed directory
/// plus the receipt sidecar at the engine's own receipt path, every mtime set
/// `unused_for` in the past.
fn generation(cache: &Cache, kind: &str, name: &str, key: &str, unused_for: Duration) -> PathBuf {
    let canonical = cache
        .compiled
        .join(kind)
        .join(format!("{name}-1.0-rev1-wasm32-{key}"));
    fs::create_dir_all(canonical.join("lib")).unwrap();
    fs::write(canonical.join("lib/lib.a"), vec![7u8; 10_000]).unwrap();
    let receipt = source_only_cache_receipt_path(&canonical, key).unwrap();
    fs::write(&receipt, b"{}").unwrap();
    let then = SystemTime::now() - unused_for;
    for path in [
        canonical.join("lib/lib.a"),
        canonical.join("lib"),
        receipt,
        canonical.clone(),
    ] {
        set_mtime(&path, then);
    }
    canonical
}

fn receipt(canonical: &Path, key: &str) -> PathBuf {
    source_only_cache_receipt_path(canonical, key).unwrap()
}

/// A checkout whose published projection names nothing itself, so only the
/// root record's generation list protects anything.
fn live_checkout(cache: &Cache, keys: &[&str]) -> tempfile::TempDir {
    let checkout = tempfile::TempDir::new().unwrap();
    let checkout_path = fs::canonicalize(checkout.path()).unwrap();
    let output = checkout_path.join("local-binaries/source-only-v1");
    fs::create_dir_all(output.join(".kandelo")).unwrap();
    fs::write(output.join(PROJECTION_RELATIVE), br#"{"nodes":[]}"#).unwrap();
    record_live_root(
        &cache.base,
        &checkout_path,
        &output,
        keys.iter()
            .map(|key| LiveRootGenerationV1 {
                name: "fixture".to_string(),
                target_arch: "wasm32".to_string(),
                cache_key_sha256: key.to_string(),
            })
            .collect(),
    )
    .unwrap();
    checkout
}

fn policy() -> GcPolicy {
    GcPolicy::manual(DEFAULT_MAX_AGE, None)
}

fn apply(cache: &Cache, policy: &GcPolicy) -> GcReport {
    match collect(&cache.base, policy, true, SystemTime::now()).unwrap() {
        GcOutcome::Completed(report) => report,
        GcOutcome::Skipped => panic!("collection unexpectedly skipped"),
    }
}

fn dead_pid() -> i32 {
    let mut child = std::process::Command::new("true").spawn().unwrap();
    let pid = child.id() as i32;
    child.wait().unwrap();
    assert!(!pid_is_alive(pid));
    pid
}

#[test]
fn live_root_protects_an_old_generation() {
    let cache = cache();
    let protected_key = key(1);
    let protected = generation(&cache, "libs", "sqlite", &protected_key, 90 * DAY);
    let _checkout = live_checkout(&cache, &[&protected_key]);

    let report = apply(&cache, &policy());

    assert!(
        protected.is_dir(),
        "a generation a live checkout uses must survive at any age"
    );
    assert!(receipt(&protected, &protected_key).is_file());
    assert_eq!(report.plan.live_roots, 1);
    assert_eq!(report.plan.generations_protected_past_age, 1);
    assert!(
        report.plan.candidates.is_empty(),
        "{:?}",
        report.plan.candidates
    );
}

#[test]
fn a_dead_root_stops_protecting_and_is_removed() {
    let cache = cache();
    let old_key = key(2);
    let old = generation(&cache, "libs", "sqlite", &old_key, 90 * DAY);
    let checkout = live_checkout(&cache, &[&old_key]);
    drop(checkout); // the checkout directory is deleted

    let report = apply(&cache, &policy());

    assert!(!old.exists(), "a dead root must not protect anything");
    assert!(
        fs::read_dir(cache.base.join(ROOTS_DIR_NAME))
            .unwrap()
            .next()
            .is_none()
    );
    assert_eq!(report.plan.live_roots, 0);
}

#[test]
fn projection_keys_of_a_live_root_are_protected_too() {
    let cache = cache();
    let recorded = key(3);
    let published = key(4);
    let recorded_gen = generation(&cache, "programs", "less", &recorded, 90 * DAY);
    let published_gen = generation(&cache, "programs", "less", &published, 90 * DAY);
    let checkout = live_checkout(&cache, &[&recorded]);
    let projection = fs::canonicalize(checkout.path())
        .unwrap()
        .join("local-binaries/source-only-v1")
        .join(PROJECTION_RELATIVE);
    fs::write(
        &projection,
        format!(r#"{{"nodes":[{{"cacheKeySha256":"{published}"}}]}}"#),
    )
    .unwrap();

    apply(&cache, &policy());

    assert!(recorded_gen.is_dir());
    assert!(published_gen.is_dir());
}

#[test]
fn unprotected_recent_generation_survives() {
    let cache = cache();
    let recent_key = key(5);
    let recent = generation(&cache, "libs", "readline", &recent_key, 3 * DAY);

    let report = apply(&cache, &policy());

    assert!(recent.is_dir());
    assert_eq!(report.plan.generations_recent, 1);
    assert!(report.plan.candidates.is_empty());
}

#[test]
fn a_fresh_last_used_stamp_keeps_an_old_generation() {
    let cache = cache();
    let used_key = key(6);
    let used = generation(&cache, "libs", "openssl", &used_key, 90 * DAY);
    touch_generation_last_used(&used, &used_key);

    apply(&cache, &policy());

    assert!(
        used.is_dir(),
        "a cache hit just now must count as recent use"
    );
}

#[test]
fn unprotected_old_generation_and_its_sidecars_are_removed() {
    let cache = cache();
    let old_key = key(7);
    let keep_key = key(8);
    let old = generation(&cache, "libs", "libcxx", &old_key, 30 * DAY);
    let kept = generation(&cache, "libs", "libcxx", &keep_key, DAY);
    let stamp = source_only_cache_last_used_path(&old, &old_key).unwrap();
    fs::write(&stamp, b"").unwrap();
    set_mtime(&stamp, SystemTime::now() - 30 * DAY);
    let provenance = cache_provenance_path(&old, &old_key).unwrap();
    fs::write(&provenance, b"").unwrap();
    set_mtime(&provenance, SystemTime::now() - 30 * DAY);
    // Read-only directories, as extracted upstream sources leave them.
    fs::set_permissions(old.join("lib"), fs::Permissions::from_mode(0o555)).unwrap();
    set_mtime(&old, SystemTime::now() - 30 * DAY);

    let report = apply(&cache, &policy());

    assert!(!old.exists());
    assert!(!receipt(&old, &old_key).exists());
    assert!(!stamp.exists());
    assert!(!provenance.exists());
    assert!(kept.is_dir() && receipt(&kept, &keep_key).is_file());
    assert!(
        report.reclaimed_bytes >= 10_000,
        "{}",
        report.reclaimed_bytes
    );
    assert!(report.warnings.is_empty(), "{:?}", report.warnings);
    let trash = cache.base.join(TRASH_DIR_NAME);
    assert!(
        fs::read_dir(&trash)
            .map(|mut entries| entries.next().is_none())
            .unwrap_or(true)
    );
}

#[test]
fn dead_pid_old_debris_is_removed_and_live_or_young_debris_kept() {
    let cache = cache();
    let libs = cache.compiled.join("libs");
    let base_name = format!("icu-74.2-rev8-wasm32-{}", key(9));
    let dead = dead_pid();
    let live = std::process::id() as i32;
    let dead_old = libs.join(format!(".{base_name}.work-{dead}-1"));
    let dead_stage = libs.join(format!(".{base_name}.build-stage-{dead}-0"));
    let live_old = libs.join(format!(".{base_name}.work-{live}-1"));
    let dead_young = libs.join(format!(".{base_name}.work-{dead}-2"));
    let dispose = libs.join(format!(".source-only-dispose-{dead}-3"));
    for dir in [&dead_old, &dead_stage, &live_old, &dead_young, &dispose] {
        fs::create_dir_all(dir.join("src")).unwrap();
        fs::write(dir.join("src/file.c"), b"int x;").unwrap();
        fs::set_permissions(dir.join("src"), fs::Permissions::from_mode(0o555)).unwrap();
    }
    for dir in [&dead_old, &dead_stage, &live_old, &dispose] {
        set_mtime(dir, SystemTime::now() - 2 * DAY);
    }

    let report = apply(&cache, &policy());

    assert!(!dead_old.exists() && !dead_stage.exists() && !dispose.exists());
    assert!(
        live_old.is_dir(),
        "debris of a running process must be kept"
    );
    assert!(
        dead_young.is_dir(),
        "debris younger than a day must be kept"
    );
    assert!(report.warnings.is_empty(), "{:?}", report.warnings);
    // The kept fixtures are read-only; make them removable for TempDir.
    for dir in [&live_old, &dead_young] {
        fs::set_permissions(dir.join("src"), fs::Permissions::from_mode(0o755)).unwrap();
    }
}

#[test]
fn orphan_receipt_is_removed_after_the_grace_period() {
    let cache = cache();
    let orphan_key = key(10);
    let young_key = key(11);
    let programs = cache.compiled.join("programs");
    let orphan_canonical = programs.join(format!("m4-1.4.19-rev3-wasm32-{orphan_key}"));
    let young_canonical = programs.join(format!("m4-1.4.19-rev3-wasm32-{young_key}"));
    let orphan = receipt(&orphan_canonical, &orphan_key);
    let young = receipt(&young_canonical, &young_key);
    fs::write(&orphan, b"{}").unwrap();
    fs::write(&young, b"{}").unwrap();
    set_mtime(&orphan, SystemTime::now() - 2 * DAY);

    apply(&cache, &policy());

    assert!(!orphan.exists());
    assert!(
        young.is_file(),
        "a young orphan receipt may be a store in progress"
    );
}

#[test]
fn a_held_build_lock_makes_collection_skip() {
    let cache = cache();
    let old = generation(&cache, "libs", "zlib", &key(12), 90 * DAY);
    let build = CacheUseLock::acquire_shared(&cache.base, "test build").unwrap();

    let outcome = collect(&cache.base, &policy(), true, SystemTime::now()).unwrap();

    assert!(matches!(outcome, GcOutcome::Skipped));
    assert!(
        old.is_dir(),
        "nothing may be removed while a build holds the cache"
    );
    drop(build);
    apply(&cache, &policy());
    assert!(!old.exists());
}

#[test]
fn dry_run_removes_nothing() {
    let cache = cache();
    let old_key = key(13);
    let old = generation(&cache, "libs", "zlib", &old_key, 90 * DAY);
    let debris = cache.compiled.join("libs").join(format!(
        ".zlib-1.0-rev1-wasm32-{old_key}.work-{}-1",
        dead_pid()
    ));
    fs::create_dir_all(&debris).unwrap();
    set_mtime(&debris, SystemTime::now() - 2 * DAY);

    let outcome = collect(&cache.base, &policy(), false, SystemTime::now()).unwrap();

    let GcOutcome::Completed(report) = outcome else {
        panic!("dry run skipped");
    };
    assert!(!report.applied);
    assert!(report.plan.candidates.iter().any(|c| c.path == old));
    assert!(report.plan.candidates.iter().any(|c| c.path == debris));
    assert!(report.reclaimed_bytes >= 10_000);
    assert!(old.is_dir() && receipt(&old, &old_key).is_file() && debris.is_dir());
    assert!(!cache.base.join(TRASH_DIR_NAME).exists());
    assert!(
        !cache.base.join(LOCK_FILE_NAME).exists(),
        "a dry run takes no lock"
    );
}

#[test]
fn max_size_evicts_least_recently_used_unprotected_generations() {
    let cache = cache();
    let oldest = generation(&cache, "libs", "a", &key(14), 5 * DAY);
    let middle = generation(&cache, "libs", "b", &key(15), 4 * DAY);
    let newest = generation(&cache, "libs", "c", &key(16), 3 * DAY);
    let today = generation(&cache, "libs", "d", &key(17), HOUR);
    let protected_key = key(18);
    let protected = generation(&cache, "libs", "e", &protected_key, 9 * DAY);
    let _checkout = live_checkout(&cache, &[&protected_key]);
    let one = disk_usage(&oldest);
    // Room for three generations: the protected one, today's, and one more.
    let budget = 3 * one + one / 2;

    let report = apply(&cache, &GcPolicy::manual(DEFAULT_MAX_AGE, Some(budget)));

    assert!(!oldest.exists() && !middle.exists());
    assert!(newest.is_dir() && today.is_dir() && protected.is_dir());
    assert!(report.plan.budget_shortfall.is_none());

    // Below what today's and the protected generation need, neither may go.
    let report = apply(&cache, &GcPolicy::manual(DEFAULT_MAX_AGE, Some(one)));
    assert!(!newest.exists());
    assert!(today.is_dir() && protected.is_dir());
    assert!(report.plan.budget_shortfall.is_some());
}

#[test]
fn automatic_collection_runs_at_most_once_per_interval() {
    let cache = cache();
    let first = generation(&cache, "libs", "a", &key(19), 60 * DAY);
    let now = SystemTime::now();

    let outcome = auto_collect(&cache.base, now).unwrap();
    assert!(matches!(outcome, Some(GcOutcome::Completed(_))));
    assert!(!first.exists());

    let second = generation(&cache, "libs", "b", &key(20), 60 * DAY);
    assert!(
        auto_collect(&cache.base, now + 23 * HOUR)
            .unwrap()
            .is_none()
    );
    assert!(
        second.is_dir(),
        "a second run inside the interval must not collect"
    );

    let outcome = auto_collect(&cache.base, now + 25 * HOUR).unwrap();
    assert!(matches!(outcome, Some(GcOutcome::Completed(_))));
    assert!(!second.exists());
}

#[test]
fn automatic_collection_uses_the_conservative_age() {
    let cache = cache();
    let twenty_days = generation(&cache, "libs", "a", &key(21), 20 * DAY);
    auto_collect(&cache.base, SystemTime::now()).unwrap();
    assert!(twenty_days.is_dir());
}

#[test]
fn automatic_collection_skips_while_a_build_holds_the_lock_and_retries() {
    let cache = cache();
    let old = generation(&cache, "libs", "a", &key(22), 60 * DAY);
    let build = CacheUseLock::acquire_shared(&cache.base, "test build").unwrap();
    let now = SystemTime::now();
    assert!(matches!(
        auto_collect(&cache.base, now).unwrap(),
        Some(GcOutcome::Skipped)
    ));
    assert!(old.is_dir());
    drop(build);
    // A skipped run leaves no stamp, so the next build retries.
    assert!(matches!(
        auto_collect(&cache.base, now + HOUR).unwrap(),
        Some(GcOutcome::Completed(_))
    ));
    assert!(!old.exists());
}

#[test]
fn auto_gc_env_values() {
    for off in ["0", "false", "NO", "off"] {
        assert!(auto_gc_disabled(Some(std::ffi::OsStr::new(off))), "{off}");
    }
    for on in ["1", "yes", ""] {
        assert!(!auto_gc_disabled(Some(std::ffi::OsStr::new(on))), "{on}");
    }
    assert!(!auto_gc_disabled(None));
}

#[test]
fn last_used_stamp_is_rate_limited() {
    let temp = tempfile::TempDir::new().unwrap();
    let stamp = temp.path().join(".x.kandelo-last-used");
    let now = SystemTime::now();
    assert!(refresh_last_used_stamp(&stamp, now).unwrap());
    assert!(!refresh_last_used_stamp(&stamp, now + HOUR / 2).unwrap());
    assert!(refresh_last_used_stamp(&stamp, now + 2 * HOUR).unwrap());
    let modified = fs::metadata(&stamp).unwrap().modified().unwrap();
    assert_eq!(modified, now + 2 * HOUR);
}

#[test]
fn stale_trash_from_a_dead_collector_is_removed() {
    let cache = cache();
    let run = cache
        .base
        .join(TRASH_DIR_NAME)
        .join(format!("{}-1", dead_pid()));
    fs::create_dir_all(run.join("0-leftover")).unwrap();
    apply(&cache, &policy());
    assert!(!run.exists());
}

#[test]
fn name_parsing() {
    let k = key(23);
    assert_eq!(
        generation_key(&format!("zlib-1.3.1-rev3-wasm32-{k}")),
        Some(k.as_str())
    );
    assert_eq!(generation_key(&format!(".zlib-{k}")), None);
    assert_eq!(generation_key("zlib-1.3.1"), None);
    let dotfile = format!(".zlib-1.3.1-rev3-wasm32-{k}.work-12-3");
    let basename = format!("zlib-1.3.1-rev3-wasm32-{k}");
    assert_eq!(
        split_generation_dotfile(&dotfile),
        Some((basename.as_str(), k.as_str(), "work-12-3"))
    );
    assert_eq!(debris_pid("work-12-3", "work-"), Some(12));
    assert_eq!(debris_pid("build-stage-x-3", "build-stage-"), None);
    assert_eq!(parse_size("200G").unwrap(), 200 << 30);
    assert_eq!(parse_size("1536MiB").unwrap(), 1536 << 20);
    assert_eq!(parse_size("4096").unwrap(), 4096);
    assert!(parse_size("12Q").is_err());
}
