//! Garbage collection for the shared SourceOnly build cache.
//!
//! The compiled cache under `<source-cache-root>/source-only-v1/compiled` is
//! content-addressed and shared by every checkout on the machine, so nothing
//! a single checkout does can prove that an old generation is unused:
//! another clone may still build against it. This module collects only what
//! the cache itself can show is dead, and keeps a build that is running now
//! from losing an entry underneath it:
//!
//! * **Last use.** Every SourceOnly cache hit or store refreshes a
//!   per-generation stamp (`.<generation>.kandelo-last-used`, a sibling of
//!   the receipt sidecar), rate-limited to one write per
//!   [`LAST_USED_REFRESH_INTERVAL`]. Generations without a stamp (written by
//!   older code) fall back to the newest of the generation directory and
//!   receipt mtimes.
//! * **Live roots.** Each successful local-build run records which cache keys
//!   its checkout's published projection uses in `<root>/roots/<sha>.json`.
//!   A key named by any live root is never collected, however old.
//! * **Exclusion.** Builds hold a shared `flock(2)` on
//!   `<root>/.kandelo-cache-gc.lock` for the whole run; collection takes it
//!   exclusive and non-blocking, and skips when a build holds it. Entries are
//!   renamed into a trash directory under the cache root while the lock is
//!   held, then deleted after it is released.
//!
//! See `docs/package-management.md` ("Cache garbage collection") for the
//! policy and its limits.

use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::fs;
use std::io;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::build_deps::{
    plan_canonical_source_only_cache_roots, source_only_cache_last_used_path,
    source_only_cache_receipt_path,
};
use crate::pkg_manifest::cache_provenance_path;

const DAY: Duration = Duration::from_secs(24 * 60 * 60);

/// A cache hit rewrites the last-used stamp only when the stamp is older than
/// this, so an aggregate build that touches hundreds of generations does not
/// turn every run into hundreds of metadata writes.
pub(crate) const LAST_USED_REFRESH_INTERVAL: Duration = Duration::from_secs(60 * 60);
/// `xtask cache-gc` default: collect unprotected generations unused this long.
pub(crate) const DEFAULT_MAX_AGE: Duration = Duration::from_secs(14 * 24 * 60 * 60);
/// The automatic post-build collection is deliberately more conservative
/// than the manual command: checkouts running code older than this module
/// neither refresh last-used stamps nor register roots, so age is their only
/// protection.
pub(crate) const AUTO_MAX_AGE: Duration = Duration::from_secs(30 * 24 * 60 * 60);
/// Crash debris and orphaned sidecars younger than this are left alone: a
/// build on older code (which takes no GC lock) may be creating them now.
pub(crate) const DEBRIS_MIN_AGE: Duration = DAY;
/// `--max-size` never evicts a generation used more recently than this.
pub(crate) const BUDGET_MIN_AGE: Duration = DAY;
/// The automatic collection runs at most once per this interval per cache.
pub(crate) const AUTO_GC_INTERVAL: Duration = DAY;
/// Set to `0`/`false`/`no`/`off` to disable the automatic post-build GC.
pub(crate) const AUTO_GC_ENV: &str = "KANDELO_CACHE_GC_AUTO";

const LOCK_FILE_NAME: &str = ".kandelo-cache-gc.lock";
const AUTO_STAMP_NAME: &str = ".kandelo-cache-gc-auto-stamp";
const ROOTS_DIR_NAME: &str = "roots";
const TRASH_DIR_NAME: &str = ".kandelo-cache-gc-trash";
const KIND_DIRS: [&str; 3] = ["libs", "programs", "sources"];
const LIVE_ROOT_SCHEMA: u32 = 1;
const PROJECTION_RELATIVE: &str = ".kandelo/source-only-program-projection-v1.json";
/// Legacy receipt sidecar spelling written by earlier engine versions. No
/// current code writes or reads it, so it has no path helper; it is still a
/// sidecar of its generation and goes when the generation goes.
const LEGACY_RECEIPT_SUFFIX: &str = ".kandelo-receipt.toml";

// ---------------------------------------------------------------------
// Last-use stamps
// ---------------------------------------------------------------------

/// Record that the SourceOnly generation at `canonical` was just used (a
/// cache hit or a store). Best-effort: a failure only means collection falls
/// back to the generation's own mtimes, so it never fails the build.
pub(crate) fn touch_generation_last_used(canonical: &Path, cache_key_sha: &str) {
    if let Ok(stamp) = source_only_cache_last_used_path(canonical, cache_key_sha) {
        let _ = refresh_last_used_stamp(&stamp, SystemTime::now());
    }
}

/// Returns whether the stamp was (re)written.
fn refresh_last_used_stamp(stamp: &Path, now: SystemTime) -> io::Result<bool> {
    match fs::symlink_metadata(stamp) {
        Ok(metadata) if !metadata.file_type().is_file() => return Ok(false),
        Ok(metadata) => {
            let modified = metadata.modified()?;
            match now.duration_since(modified) {
                Ok(age) if age < LAST_USED_REFRESH_INTERVAL => return Ok(false),
                // A stamp in the future (clock step) already protects the
                // generation; leave it.
                Err(_) => return Ok(false),
                Ok(_) => {}
            }
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    let fd = rustix::fs::open(
        stamp,
        rustix::fs::OFlags::WRONLY
            | rustix::fs::OFlags::CREATE
            | rustix::fs::OFlags::NOFOLLOW
            | rustix::fs::OFlags::CLOEXEC,
        rustix::fs::Mode::from_raw_mode(0o644),
    )?;
    fs::File::from(fd).set_modified(now)?;
    Ok(true)
}

// ---------------------------------------------------------------------
// Build/GC exclusion lock
// ---------------------------------------------------------------------

/// A shared hold on the cache: while any exists, `cache-gc` cannot run.
/// Released when dropped (closing the descriptor drops the `flock`).
pub(crate) struct CacheUseLock {
    _file: fs::File,
}

impl CacheUseLock {
    /// Block until no collection is running, then hold the cache shared.
    /// `who` names the caller in the one-line waiting notice.
    pub(crate) fn acquire_shared(base: &Path, who: &str) -> Result<Self, String> {
        let path = base.join(LOCK_FILE_NAME);
        let file = open_lock_file(&path)?;
        match rustix::fs::flock(&file, rustix::fs::FlockOperation::NonBlockingLockShared) {
            Ok(()) => {}
            Err(rustix::io::Errno::WOULDBLOCK) => {
                eprintln!(
                    "{who}: waiting for a running `xtask cache-gc` to release {}",
                    path.display()
                );
                rustix::fs::flock(&file, rustix::fs::FlockOperation::LockShared).map_err(
                    |error| format!("lock source-only cache {} shared: {error}", path.display()),
                )?;
            }
            Err(error) => {
                return Err(format!(
                    "lock source-only cache {} shared: {error}",
                    path.display()
                ));
            }
        }
        Ok(Self { _file: file })
    }

    /// `acquire_shared` when the cache base already exists; `None` otherwise
    /// (there is nothing a collection could remove from a missing cache).
    pub(crate) fn acquire_shared_if_present(
        base: &Path,
        who: &str,
    ) -> Result<Option<Self>, String> {
        if !base.is_dir() {
            return Ok(None);
        }
        Self::acquire_shared(base, who).map(Some)
    }
}

struct ExclusiveGcLock {
    _file: fs::File,
}

/// `Ok(None)` when a build (or another collection) holds the lock.
fn try_acquire_exclusive(base: &Path) -> Result<Option<ExclusiveGcLock>, String> {
    let path = base.join(LOCK_FILE_NAME);
    let file = open_lock_file(&path)?;
    match rustix::fs::flock(&file, rustix::fs::FlockOperation::NonBlockingLockExclusive) {
        Ok(()) => Ok(Some(ExclusiveGcLock { _file: file })),
        Err(rustix::io::Errno::WOULDBLOCK) => Ok(None),
        Err(error) => Err(format!(
            "lock source-only cache {} exclusive: {error}",
            path.display()
        )),
    }
}

fn open_lock_file(path: &Path) -> Result<fs::File, String> {
    // CLOEXEC: a lock inherited by a long-lived build child would outlive
    // the build that took it and keep collection off indefinitely.
    let fd = rustix::fs::open(
        path,
        rustix::fs::OFlags::RDWR
            | rustix::fs::OFlags::CREATE
            | rustix::fs::OFlags::NOFOLLOW
            | rustix::fs::OFlags::CLOEXEC,
        rustix::fs::Mode::from_raw_mode(0o644),
    )
    .map_err(|error| format!("open source-only cache lock {}: {error}", path.display()))?;
    let file = fs::File::from(fd);
    let metadata = file
        .metadata()
        .map_err(|error| format!("inspect source-only cache lock {}: {error}", path.display()))?;
    if !metadata.is_file() {
        return Err(format!(
            "source-only cache lock must be a regular file: {}",
            path.display()
        ));
    }
    Ok(file)
}

// ---------------------------------------------------------------------
// Live-root registry
// ---------------------------------------------------------------------

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LiveRootV1 {
    schema: u32,
    checkout: PathBuf,
    output_root: PathBuf,
    updated_unix_seconds: u64,
    generations: Vec<LiveRootGenerationV1>,
}

/// One compiled generation a checkout's published projection depends on.
#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct LiveRootGenerationV1 {
    pub(crate) name: String,
    pub(crate) target_arch: String,
    pub(crate) cache_key_sha256: String,
}

fn live_root_path(base: &Path, output_root: &Path) -> PathBuf {
    let digest = Sha256::digest(output_root.as_os_str().as_bytes());
    base.join(ROOTS_DIR_NAME)
        .join(format!("{}.json", crate::util::hex(&digest)))
}

/// Record (atomically replacing any earlier record) that the checkout at
/// `checkout`, publishing into `output_root`, uses exactly `generations`.
///
/// The record is keyed by the canonical output root rather than the checkout
/// alone because the output root is what owns a projection; one checkout
/// normally has exactly one (`local-binaries/source-only-v1`).
pub(crate) fn record_live_root(
    base: &Path,
    checkout: &Path,
    output_root: &Path,
    generations: BTreeSet<LiveRootGenerationV1>,
) -> Result<PathBuf, String> {
    let path = live_root_path(base, output_root);
    let dir = path.parent().expect("live root path has a parent");
    fs::create_dir_all(dir)
        .map_err(|error| format!("create cache root registry {}: {error}", dir.display()))?;
    let root = LiveRootV1 {
        schema: LIVE_ROOT_SCHEMA,
        checkout: checkout.to_path_buf(),
        output_root: output_root.to_path_buf(),
        updated_unix_seconds: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|elapsed| elapsed.as_secs())
            .unwrap_or(0),
        generations: generations.into_iter().collect(),
    };
    let mut bytes = serde_json::to_vec_pretty(&root)
        .map_err(|error| format!("serialize cache root record: {error}"))?;
    bytes.push(b'\n');
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .expect("live root file name is UTF-8");
    let temp = dir.join(format!(
        ".{file_name}.tmp-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|elapsed| elapsed.as_nanos())
            .unwrap_or(0)
    ));
    fs::write(&temp, &bytes)
        .map_err(|error| format!("write cache root record {}: {error}", temp.display()))?;
    fs::rename(&temp, &path).map_err(|error| {
        let _ = fs::remove_file(&temp);
        format!("publish cache root record {}: {error}", path.display())
    })?;
    Ok(path)
}

/// Cache keys a live root protects: every key its record names, plus every
/// key its output root's current projection names (so a projection that a
/// later run republished without updating the record is still covered).
/// `None` when the root is dead: its checkout or projection is gone.
fn live_root_keys(root: &LiveRootV1) -> Option<BTreeSet<String>> {
    if !root.checkout.is_dir() {
        return None;
    }
    let projection = root.output_root.join(PROJECTION_RELATIVE);
    let bytes = fs::read(&projection).ok()?;
    let mut keys: BTreeSet<String> = root
        .generations
        .iter()
        .map(|generation| generation.cache_key_sha256.clone())
        .collect();
    if let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) {
        for node in value
            .get("nodes")
            .and_then(|nodes| nodes.as_array())
            .into_iter()
            .flatten()
        {
            if let Some(key) = node.get("cacheKeySha256").and_then(|key| key.as_str()) {
                keys.insert(key.to_string());
            }
        }
    }
    Some(keys)
}

// ---------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------

#[derive(Clone, Debug)]
pub(crate) struct GcPolicy {
    pub(crate) max_age: Duration,
    pub(crate) max_size: Option<u64>,
    pub(crate) debris_min_age: Duration,
    pub(crate) budget_min_age: Duration,
}

impl GcPolicy {
    pub(crate) fn manual(max_age: Duration, max_size: Option<u64>) -> Self {
        Self {
            max_age,
            max_size,
            debris_min_age: DEBRIS_MIN_AGE,
            budget_min_age: BUDGET_MIN_AGE,
        }
    }

    fn automatic() -> Self {
        Self::manual(AUTO_MAX_AGE, None)
    }
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub(crate) enum Category {
    Generation,
    Sidecar,
    Debris,
    Diagnostic,
    DeadRoot,
    StaleTrash,
}

impl Category {
    fn label(self) -> &'static str {
        match self {
            Category::Generation => "generation",
            Category::Sidecar => "sidecar",
            Category::Debris => "crash debris",
            Category::Diagnostic => "rebuild-mismatch diagnostic",
            Category::DeadRoot => "dead checkout root",
            Category::StaleTrash => "stale gc trash",
        }
    }
}

#[derive(Clone, Debug)]
pub(crate) struct Candidate {
    pub(crate) path: PathBuf,
    pub(crate) category: Category,
    pub(crate) reason: String,
    pub(crate) bytes: u64,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct GcPlan {
    pub(crate) candidates: Vec<Candidate>,
    pub(crate) generations_total: usize,
    /// Referenced by a live root (kept at any age).
    pub(crate) generations_protected: usize,
    /// Of those, how many are past `max_age` (kept only by their root).
    pub(crate) generations_protected_past_age: usize,
    /// Unreferenced but used within `max_age`.
    pub(crate) generations_recent: usize,
    pub(crate) live_roots: usize,
    pub(crate) unrecognized_entries: usize,
    /// Bytes still over `--max-size` after every eligible eviction.
    pub(crate) budget_shortfall: Option<u64>,
}

struct ScannedGeneration {
    path: PathBuf,
    basename: String,
    key: String,
    last_use: SystemTime,
}

struct ScannedSidecar {
    path: PathBuf,
    basename: String,
}

fn is_lower_hex_64(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

/// The cache key of a generation directory name (`<...>-<64 hex>`).
fn generation_key(name: &str) -> Option<&str> {
    if name.starts_with('.') || name.len() < 66 {
        return None;
    }
    let (head, key) = name.split_at(name.len() - 64);
    (head.ends_with('-') && is_lower_hex_64(key)).then_some(key)
}

/// For a hidden `.<generation>.<rest>` entry, the generation basename, its
/// key, and `<rest>`.
fn split_generation_dotfile(name: &str) -> Option<(&str, &str, &str)> {
    let inner = name.strip_prefix('.')?;
    let bytes = inner.as_bytes();
    // The first `-<64 hex>.` marks the end of the generation basename.
    let mut index = 0;
    while let Some(offset) = inner[index..].find('-') {
        let dash = index + offset;
        let key_end = dash + 1 + 64;
        if key_end < inner.len()
            && bytes[key_end] == b'.'
            && is_lower_hex_64(&inner[dash + 1..key_end])
        {
            return Some((
                &inner[..key_end],
                &inner[dash + 1..key_end],
                &inner[key_end + 1..],
            ));
        }
        index = dash + 1;
    }
    None
}

/// `<prefix><pid>-<n>` or `<prefix><pid>` → pid.
fn debris_pid(rest: &str, prefix: &str) -> Option<i32> {
    let tail = rest.strip_prefix(prefix)?;
    let pid = tail.split('-').next()?;
    pid.parse::<i32>().ok().filter(|pid| *pid > 0)
}

fn pid_is_alive(pid: i32) -> bool {
    match rustix::process::Pid::from_raw(pid) {
        // EPERM means the process exists but belongs to someone else.
        Some(pid) => !matches!(
            rustix::process::test_kill_process(pid),
            Err(rustix::io::Errno::SRCH)
        ),
        None => false,
    }
}

fn mtime(metadata: &fs::Metadata) -> SystemTime {
    metadata.modified().unwrap_or(UNIX_EPOCH)
}

fn age(now: SystemTime, then: SystemTime) -> Duration {
    now.duration_since(then).unwrap_or(Duration::ZERO)
}

fn days(duration: Duration) -> u64 {
    duration.as_secs() / DAY.as_secs()
}

/// Sidecar file names that belong to the generation at `canonical`, derived
/// from the engine's own path helpers so the collector cannot drift from the
/// names the engine writes.
fn generation_sidecar_names(canonical: &Path, key: &str) -> Vec<String> {
    let mut names = Vec::new();
    for path in [
        source_only_cache_receipt_path(canonical, key),
        cache_provenance_path(canonical, key),
        source_only_cache_last_used_path(canonical, key),
    ]
    .into_iter()
    .flatten()
    {
        if let Some(name) = path.file_name().and_then(|name| name.to_str()) {
            names.push(name.to_string());
        }
    }
    if let Some(basename) = canonical.file_name().and_then(|name| name.to_str()) {
        names.push(format!(".{basename}{LEGACY_RECEIPT_SUFFIX}"));
    }
    names
}

fn newest_mtime(paths: impl IntoIterator<Item = PathBuf>, floor: SystemTime) -> SystemTime {
    paths
        .into_iter()
        .filter_map(|path| fs::symlink_metadata(path).ok())
        .map(|metadata| mtime(&metadata))
        .fold(floor, SystemTime::max)
}

/// Decide what one collection would remove. `sizes` memoizes measured
/// directory sizes so an apply can measure before taking the lock.
pub(crate) fn plan(
    base: &Path,
    policy: &GcPolicy,
    now: SystemTime,
    sizes: &mut BTreeMap<PathBuf, u64>,
) -> Result<GcPlan, String> {
    let mut plan = GcPlan::default();
    if !base.is_dir() {
        return Ok(plan);
    }
    let compiled = plan_canonical_source_only_cache_roots(base, None)?.compiled;

    // Roots.
    let mut protected = BTreeSet::<String>::new();
    let roots_dir = base.join(ROOTS_DIR_NAME);
    if let Ok(entries) = fs::read_dir(&roots_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(metadata) = fs::symlink_metadata(&path) else {
                continue;
            };
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.starts_with('.') {
                // An abandoned temp record from a crashed writer.
                if metadata.is_file() && age(now, mtime(&metadata)) >= policy.debris_min_age {
                    plan.candidates.push(Candidate {
                        path,
                        category: Category::Debris,
                        reason: "abandoned root-record temp file".to_string(),
                        bytes: metadata.blocks() * 512,
                    });
                }
                continue;
            }
            if !metadata.is_file() || !name.ends_with(".json") {
                plan.unrecognized_entries += 1;
                continue;
            }
            let root = fs::read(&path)
                .ok()
                .and_then(|bytes| serde_json::from_slice::<LiveRootV1>(&bytes).ok())
                .filter(|root| root.schema == LIVE_ROOT_SCHEMA);
            match root.as_ref().and_then(live_root_keys) {
                Some(keys) => {
                    plan.live_roots += 1;
                    protected.extend(keys);
                }
                None => {
                    let reason = match &root {
                        Some(root) => format!(
                            "checkout {} or its projection no longer exists",
                            root.checkout.display()
                        ),
                        None => "unreadable root record".to_string(),
                    };
                    // An unreadable record protects nothing; give a
                    // concurrent writer's rename the debris grace period.
                    if root.is_some() || age(now, mtime(&metadata)) >= policy.debris_min_age {
                        plan.candidates.push(Candidate {
                            path,
                            category: Category::DeadRoot,
                            reason,
                            bytes: metadata.blocks() * 512,
                        });
                    }
                }
            }
        }
    }

    // Compiled entries.
    let mut generations = Vec::<ScannedGeneration>::new();
    let mut sidecars = Vec::<ScannedSidecar>::new();
    let mut diagnostics = Vec::<(PathBuf, String, SystemTime)>::new();
    for kind in KIND_DIRS {
        let dir = compiled.join(kind);
        let entries = match fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(format!("read {}: {error}", dir.display())),
        };
        let mut known_sidecar_names = BTreeMap::<String, String>::new();
        let mut dotfiles = Vec::new();
        for entry in entries {
            let entry = entry.map_err(|error| format!("read {}: {error}", dir.display()))?;
            let path = entry.path();
            let Some(name) = entry.file_name().to_str().map(str::to_string) else {
                plan.unrecognized_entries += 1;
                continue;
            };
            let Ok(metadata) = fs::symlink_metadata(&path) else {
                continue;
            };
            if name.starts_with('.') {
                dotfiles.push((path, name, metadata));
                continue;
            }
            match generation_key(&name) {
                Some(key) if metadata.is_dir() => {
                    let key = key.to_string();
                    for sidecar in generation_sidecar_names(&path, &key) {
                        known_sidecar_names.insert(sidecar, name.clone());
                    }
                    let last_use = newest_mtime(
                        [
                            source_only_cache_receipt_path(&path, &key).ok(),
                            source_only_cache_last_used_path(&path, &key).ok(),
                        ]
                        .into_iter()
                        .flatten(),
                        mtime(&metadata),
                    );
                    generations.push(ScannedGeneration {
                        path,
                        basename: name,
                        key,
                        last_use,
                    });
                }
                _ => plan.unrecognized_entries += 1,
            }
        }
        for (path, name, metadata) in dotfiles {
            let modified = mtime(&metadata);
            if let Some(basename) = known_sidecar_names.get(&name) {
                sidecars.push(ScannedSidecar {
                    path,
                    basename: basename.clone(),
                });
                continue;
            }
            if let Some(pid) = debris_pid(&name, ".kandelo-receipt-tmp-")
                .or_else(|| debris_pid(&name, ".source-only-dispose-"))
            {
                push_debris(&mut plan, policy, now, path, pid, modified);
                continue;
            }
            if let Some(rest) = name.strip_prefix('.') {
                if let Some((key, tail)) = rest.split_at_checked(64) {
                    if is_lower_hex_64(key) && tail.starts_with(".kandelo-rebuild-mismatch.") {
                        diagnostics.push((path, key.to_string(), modified));
                        continue;
                    }
                }
            }
            match split_generation_dotfile(&name) {
                Some((basename, key, rest)) => {
                    let pid = debris_pid(rest, "work-")
                        .or_else(|| debris_pid(rest, "build-stage-"))
                        .or_else(|| debris_pid(rest, "git-inputs-"));
                    if let Some(pid) = pid {
                        push_debris(&mut plan, policy, now, path, pid, modified);
                        continue;
                    }
                    // A sidecar whose generation directory is gone. Confirm
                    // the name against the engine's helpers for that
                    // generation before calling it one.
                    let canonical = dir.join(basename);
                    if generation_sidecar_names(&canonical, key).contains(&name) {
                        if age(now, modified) >= policy.debris_min_age {
                            plan.candidates.push(Candidate {
                                path,
                                category: Category::Sidecar,
                                reason: "sidecar of a generation that no longer exists".to_string(),
                                bytes: metadata.blocks() * 512,
                            });
                        }
                    } else {
                        plan.unrecognized_entries += 1;
                    }
                }
                None => plan.unrecognized_entries += 1,
            }
        }
    }

    // Generations.
    plan.generations_total = generations.len();
    let mut evicted = BTreeSet::<usize>::new();
    let mut reasons = BTreeMap::<usize, String>::new();
    for (index, generation) in generations.iter().enumerate() {
        let unused_for = age(now, generation.last_use);
        if protected.contains(&generation.key) {
            plan.generations_protected += 1;
            if unused_for >= policy.max_age {
                plan.generations_protected_past_age += 1;
            }
        } else if unused_for >= policy.max_age {
            evicted.insert(index);
            reasons.insert(
                index,
                format!(
                    "unused for {} days; no live checkout references it",
                    days(unused_for)
                ),
            );
        } else {
            plan.generations_recent += 1;
        }
    }
    if let Some(budget) = policy.max_size {
        let mut total = 0u64;
        for generation in &generations {
            total += measured(sizes, &generation.path);
        }
        let mut remaining = total
            - evicted
                .iter()
                .map(|index| measured(sizes, &generations[*index].path))
                .sum::<u64>();
        let mut lru: Vec<usize> = (0..generations.len())
            .filter(|index| {
                !evicted.contains(index) && !protected.contains(&generations[*index].key)
            })
            .collect();
        lru.sort_by_key(|index| generations[*index].last_use);
        for index in lru {
            if remaining <= budget {
                break;
            }
            let unused_for = age(now, generations[index].last_use);
            if unused_for < policy.budget_min_age {
                break;
            }
            remaining -= measured(sizes, &generations[index].path);
            plan.generations_recent -= 1;
            evicted.insert(index);
            reasons.insert(
                index,
                format!(
                    "least recently used ({} days ago); cache is over the --max-size budget",
                    days(unused_for)
                ),
            );
        }
        if remaining > budget {
            plan.budget_shortfall = Some(remaining - budget);
        }
    }
    let mut surviving_keys = HashSet::<&str>::new();
    let mut evicted_basenames = BTreeSet::<&str>::new();
    for (index, generation) in generations.iter().enumerate() {
        if evicted.contains(&index) {
            evicted_basenames.insert(&generation.basename);
            plan.candidates.push(Candidate {
                path: generation.path.clone(),
                category: Category::Generation,
                reason: reasons.remove(&index).unwrap_or_default(),
                bytes: sizes.get(&generation.path).copied().unwrap_or(0),
            });
        } else {
            surviving_keys.insert(&generation.key);
        }
    }
    for sidecar in sidecars {
        if evicted_basenames.contains(sidecar.basename.as_str()) {
            let bytes = fs::symlink_metadata(&sidecar.path)
                .map(|metadata| metadata.blocks() * 512)
                .unwrap_or(0);
            plan.candidates.push(Candidate {
                path: sidecar.path,
                category: Category::Sidecar,
                reason: "sidecar of a collected generation".to_string(),
                bytes,
            });
        }
    }
    for (path, key, modified) in diagnostics {
        if !surviving_keys.contains(key.as_str()) && age(now, modified) >= policy.max_age {
            let bytes = fs::symlink_metadata(&path)
                .map(|metadata| metadata.blocks() * 512)
                .unwrap_or(0);
            plan.candidates.push(Candidate {
                path,
                category: Category::Diagnostic,
                reason: "diagnostic for a cache key that is no longer cached".to_string(),
                bytes,
            });
        }
    }

    // Trash left by a collection that died before deleting it.
    if let Ok(entries) = fs::read_dir(base.join(TRASH_DIR_NAME)) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            let alive = name
                .split('-')
                .next()
                .and_then(|pid| pid.parse::<i32>().ok())
                .is_some_and(pid_is_alive);
            if !alive {
                plan.candidates.push(Candidate {
                    path: entry.path(),
                    category: Category::StaleTrash,
                    reason: "left by an interrupted collection".to_string(),
                    bytes: 0,
                });
            }
        }
    }
    Ok(plan)
}

fn push_debris(
    plan: &mut GcPlan,
    policy: &GcPolicy,
    now: SystemTime,
    path: PathBuf,
    pid: i32,
    modified: SystemTime,
) {
    let unused_for = age(now, modified);
    if unused_for < policy.debris_min_age || pid_is_alive(pid) {
        return;
    }
    plan.candidates.push(Candidate {
        path,
        category: Category::Debris,
        reason: format!(
            "owner pid {pid} is gone; untouched for {} days",
            days(unused_for)
        ),
        bytes: 0,
    });
}

fn measured(sizes: &mut BTreeMap<PathBuf, u64>, path: &Path) -> u64 {
    if let Some(bytes) = sizes.get(path) {
        return *bytes;
    }
    let bytes = disk_usage(path);
    sizes.insert(path.to_path_buf(), bytes);
    bytes
}

/// Allocated bytes under `path`, without following symlinks. Every cache
/// entry is private to its generation (the cache hard-links nothing across
/// generations), so this is what deleting `path` returns to the disk.
pub(crate) fn disk_usage(path: &Path) -> u64 {
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return 0;
    };
    let mut total = metadata.blocks() * 512;
    if metadata.is_dir() {
        if let Ok(entries) = fs::read_dir(path) {
            for entry in entries.flatten() {
                total += disk_usage(&entry.path());
            }
        }
    }
    total
}

/// Remove `path` recursively without following symlinks, first making
/// read-only directories writable (work debris extracts upstream sources
/// with their read-only modes). Returns the first error, after trying
/// everything.
fn remove_tree(path: &Path) -> io::Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_dir() {
        return fs::remove_file(path);
    }
    let mode = metadata.permissions().mode();
    if mode & 0o700 != 0o700 {
        fs::set_permissions(path, fs::Permissions::from_mode(mode | 0o700))?;
    }
    let mut first_error = None;
    for entry in fs::read_dir(path)? {
        let result = entry.and_then(|entry| remove_tree(&entry.path()));
        if let Err(error) = result {
            first_error.get_or_insert(error);
        }
    }
    if let Err(error) = fs::remove_dir(path) {
        first_error.get_or_insert(error);
    }
    match first_error {
        Some(error) => Err(error),
        None => Ok(()),
    }
}

// ---------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------

pub(crate) enum GcOutcome {
    /// A build (or another collection) holds the cache; nothing was touched.
    Skipped,
    Completed(GcReport),
}

pub(crate) struct GcReport {
    pub(crate) plan: GcPlan,
    pub(crate) applied: bool,
    pub(crate) reclaimed_bytes: u64,
    pub(crate) warnings: Vec<String>,
}

/// Plan a collection and, with `apply`, carry it out.
///
/// Dry runs take no lock and change nothing. An apply measures sizes first
/// (unlocked, so a slow walk never blocks builds), then takes the exclusive
/// lock without waiting, re-plans under it, and renames every candidate into
/// a per-run trash directory before releasing it. Deletion happens after the
/// lock is released: once renamed, nothing any build could name remains.
pub(crate) fn collect(
    base: &Path,
    policy: &GcPolicy,
    apply: bool,
    now: SystemTime,
) -> Result<GcOutcome, String> {
    let mut sizes = BTreeMap::new();
    if !apply {
        let mut plan = plan(base, policy, now, &mut sizes)?;
        for candidate in &mut plan.candidates {
            if candidate.bytes == 0 {
                candidate.bytes = measured(&mut sizes, &candidate.path);
            }
        }
        let reclaimed_bytes = plan
            .candidates
            .iter()
            .map(|candidate| candidate.bytes)
            .sum();
        return Ok(GcOutcome::Completed(GcReport {
            plan,
            applied: false,
            reclaimed_bytes,
            warnings: Vec::new(),
        }));
    }
    if !base.is_dir() {
        return Ok(GcOutcome::Completed(GcReport {
            plan: GcPlan::default(),
            applied: true,
            reclaimed_bytes: 0,
            warnings: Vec::new(),
        }));
    }
    if policy.max_size.is_some() {
        // Warm the size memo before locking; see the doc comment.
        let _ = plan(base, policy, now, &mut sizes)?;
    }
    let Some(lock) = try_acquire_exclusive(base)? else {
        return Ok(GcOutcome::Skipped);
    };
    let mut plan = plan(base, policy, now, &mut sizes)?;
    let trash_run = base.join(TRASH_DIR_NAME).join(format!(
        "{}-{}",
        std::process::id(),
        now.duration_since(UNIX_EPOCH)
            .map(|elapsed| elapsed.as_nanos())
            .unwrap_or(0)
    ));
    fs::create_dir_all(&trash_run)
        .map_err(|error| format!("create gc trash {}: {error}", trash_run.display()))?;
    let mut warnings = Vec::new();
    let mut trashed = Vec::<(usize, PathBuf)>::new();
    for (index, candidate) in plan.candidates.iter().enumerate() {
        if candidate.category == Category::StaleTrash {
            trashed.push((index, candidate.path.clone()));
            continue;
        }
        let name = candidate
            .path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        let target = trash_run.join(format!("{index}-{name}"));
        match fs::rename(&candidate.path, &target) {
            Ok(()) => trashed.push((index, target)),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => warnings.push(format!(
                "kept {}: could not move it to the gc trash: {error}",
                candidate.path.display()
            )),
        }
    }
    drop(lock);

    let mut reclaimed_bytes = 0;
    let mut removed = BTreeSet::new();
    for (index, path) in trashed {
        let bytes = disk_usage(&path);
        match remove_tree(&path) {
            Ok(()) => {
                reclaimed_bytes += bytes;
                plan.candidates[index].bytes = bytes;
                removed.insert(index);
            }
            Err(error) => warnings.push(format!(
                "could not finish deleting {} (moved out of the cache already): {error}",
                path.display()
            )),
        }
    }
    let _ = fs::remove_dir(&trash_run);
    let mut index = 0;
    plan.candidates.retain(|_| {
        let keep = removed.contains(&index);
        index += 1;
        keep
    });
    Ok(GcOutcome::Completed(GcReport {
        plan,
        applied: true,
        reclaimed_bytes,
        warnings,
    }))
}

// ---------------------------------------------------------------------
// Automatic collection after a local build
// ---------------------------------------------------------------------

fn auto_gc_disabled(value: Option<&std::ffi::OsStr>) -> bool {
    value
        .and_then(|value| value.to_str())
        .map(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "0" | "false" | "no" | "off"
            )
        })
        .unwrap_or(false)
}

/// Opportunistic collection at the end of a successful local build. Runs at
/// most once per [`AUTO_GC_INTERVAL`] per cache, with the conservative
/// [`AUTO_MAX_AGE`] and no size budget, and never fails the build: every
/// problem is logged and the build's own result stands.
pub(crate) fn auto_collect_after_build(base: &Path) {
    if auto_gc_disabled(std::env::var_os(AUTO_GC_ENV).as_deref()) {
        return;
    }
    if let Err(error) = auto_collect(base, SystemTime::now()) {
        eprintln!("local-build: automatic cache-gc did not run: {error}");
    }
}

/// Returns `Ok(None)` when rate-limited.
fn auto_collect(base: &Path, now: SystemTime) -> Result<Option<GcOutcome>, String> {
    let stamp = base.join(AUTO_STAMP_NAME);
    if let Ok(metadata) = fs::symlink_metadata(&stamp) {
        match now.duration_since(mtime(&metadata)) {
            Ok(elapsed) if elapsed < AUTO_GC_INTERVAL => return Ok(None),
            Err(_) => return Ok(None),
            Ok(_) => {}
        }
    }
    let outcome = collect(base, &GcPolicy::automatic(), true, now)?;
    match &outcome {
        GcOutcome::Skipped => eprintln!(
            "local-build: automatic cache-gc skipped: another build is using {}",
            base.display()
        ),
        GcOutcome::Completed(report) => {
            refresh_auto_stamp(&stamp, now)?;
            if !report.plan.candidates.is_empty() || !report.warnings.is_empty() {
                eprintln!(
                    "local-build: automatic cache-gc removed {} entries ({}) from {} \
                     (policy: unreferenced and unused for {} days; disable with {AUTO_GC_ENV}=0)",
                    report.plan.candidates.len(),
                    human_bytes(report.reclaimed_bytes),
                    base.display(),
                    days(AUTO_MAX_AGE),
                );
                for warning in &report.warnings {
                    eprintln!("local-build: cache-gc warning: {warning}");
                }
            }
        }
    }
    Ok(Some(outcome))
}

fn refresh_auto_stamp(stamp: &Path, now: SystemTime) -> Result<(), String> {
    let fd = rustix::fs::open(
        stamp,
        rustix::fs::OFlags::WRONLY
            | rustix::fs::OFlags::CREATE
            | rustix::fs::OFlags::NOFOLLOW
            | rustix::fs::OFlags::CLOEXEC,
        rustix::fs::Mode::from_raw_mode(0o644),
    )
    .map_err(|error| format!("open cache-gc stamp {}: {error}", stamp.display()))?;
    fs::File::from(fd)
        .set_modified(now)
        .map_err(|error| format!("update cache-gc stamp {}: {error}", stamp.display()))
}

// ---------------------------------------------------------------------
// `xtask cache-gc`
// ---------------------------------------------------------------------

pub(crate) fn human_bytes(bytes: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KiB", "MiB", "GiB", "TiB"];
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= 1024.0 && unit + 1 < UNITS.len() {
        value /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{bytes} B")
    } else {
        format!("{value:.1} {}", UNITS[unit])
    }
}

/// `123`, `500M`, `200G`, `1.5T`, `200GiB`, `200GB` (binary multiples).
pub(crate) fn parse_size(value: &str) -> Result<u64, String> {
    let trimmed = value.trim();
    let split = trimmed
        .find(|c: char| !(c.is_ascii_digit() || c == '.'))
        .unwrap_or(trimmed.len());
    let (number, unit) = trimmed.split_at(split);
    let number: f64 = number
        .parse()
        .map_err(|_| format!("--max-size: {value:?} is not a size like 200G or 500M"))?;
    let multiplier: u64 = match unit.trim().to_ascii_uppercase().as_str() {
        "" | "B" => 1,
        "K" | "KB" | "KIB" => 1 << 10,
        "M" | "MB" | "MIB" => 1 << 20,
        "G" | "GB" | "GIB" => 1 << 30,
        "T" | "TB" | "TIB" => 1 << 40,
        _ => return Err(format!("--max-size: unknown unit in {value:?}")),
    };
    if !number.is_finite() || number < 0.0 {
        return Err(format!("--max-size: {value:?} is not a size"));
    }
    Ok((number * multiplier as f64) as u64)
}

const USAGE: &str = "usage: xtask cache-gc [--apply] [--max-age-days N] [--max-size SIZE] [--source-cache-root PATH]";

pub(crate) fn run(args: Vec<String>) -> Result<(), String> {
    let mut apply = false;
    let mut max_age_days = days(DEFAULT_MAX_AGE);
    let mut max_size = None;
    let mut root = None;
    let mut iter = args.into_iter();
    while let Some(arg) = iter.next() {
        let (flag, inline) = match arg.split_once('=') {
            Some((flag, value)) if flag.starts_with("--") => {
                (flag.to_string(), Some(value.to_string()))
            }
            _ => (arg.clone(), None),
        };
        let mut value = |flag: &str| {
            inline
                .clone()
                .or_else(|| iter.next())
                .ok_or_else(|| format!("{flag} needs a value\n{USAGE}"))
        };
        match flag.as_str() {
            "--apply" if inline.is_none() => apply = true,
            "--max-age-days" => {
                max_age_days = value("--max-age-days")?
                    .parse::<u64>()
                    .ok()
                    .filter(|days| *days >= 1)
                    .ok_or_else(|| {
                        "--max-age-days must be a whole number of days >= 1".to_string()
                    })?;
            }
            "--max-size" => max_size = Some(parse_size(&value("--max-size")?)?),
            "--source-cache-root" => {
                let path = PathBuf::from(value("--source-cache-root")?);
                if !path.is_absolute() {
                    return Err("--source-cache-root must be an absolute path".to_string());
                }
                root = Some(path);
            }
            "-h" | "--help" => {
                println!("{USAGE}");
                return Ok(());
            }
            _ => return Err(format!("unexpected argument {arg:?}\n{USAGE}")),
        }
    }
    let base = match root {
        Some(root) => root,
        None => crate::local_build::default_source_cache_root()?,
    };
    let base = if base.exists() {
        fs::canonicalize(&base)
            .map_err(|error| format!("canonicalize {}: {error}", base.display()))?
    } else {
        base
    };
    let policy = GcPolicy::manual(Duration::from_secs(max_age_days * DAY.as_secs()), max_size);
    let outcome = collect(&base, &policy, apply, SystemTime::now())?;
    let report = match outcome {
        GcOutcome::Skipped => {
            println!(
                "cache-gc: skipped; a build is using {} (it holds the cache lock). Nothing was removed; try again when it finishes.",
                base.display()
            );
            return Ok(());
        }
        GcOutcome::Completed(report) => report,
    };
    print_report(&base, &policy, &report);
    Ok(())
}

fn print_report(base: &Path, policy: &GcPolicy, report: &GcReport) {
    let plan = &report.plan;
    let verb = if report.applied {
        "removed"
    } else {
        "would remove"
    };
    let mut candidates: Vec<&Candidate> = plan.candidates.iter().collect();
    candidates
        .sort_by(|left, right| (left.category, &left.path).cmp(&(right.category, &right.path)));
    for candidate in &candidates {
        println!(
            "{verb} {:>10}  {}  [{}: {}]",
            human_bytes(candidate.bytes),
            candidate.path.display(),
            candidate.category.label(),
            candidate.reason
        );
    }
    println!();
    println!(
        "cache-gc {} {}",
        if report.applied {
            "applied to"
        } else {
            "dry run of"
        },
        base.display()
    );
    println!(
        "  policy: collect generations no live checkout references and unused for >= {} days{}",
        days(policy.max_age),
        match policy.max_size {
            Some(budget) => format!(", then least-recently-used down to {}", human_bytes(budget)),
            None => String::new(),
        }
    );
    println!("  live checkout roots: {}", plan.live_roots);
    println!(
        "  generations: {} total, {} protected by a live root ({} of them past the age limit), {} kept as recently used",
        plan.generations_total,
        plan.generations_protected,
        plan.generations_protected_past_age,
        plan.generations_recent
    );
    let mut by_category = BTreeMap::<Category, (usize, u64)>::new();
    for candidate in &plan.candidates {
        let slot = by_category.entry(candidate.category).or_default();
        slot.0 += 1;
        slot.1 += candidate.bytes;
    }
    for (category, (count, bytes)) in &by_category {
        println!(
            "  {verb}: {count} {} ({})",
            category.label(),
            human_bytes(*bytes)
        );
    }
    println!("  total {verb}: {}", human_bytes(report.reclaimed_bytes));
    if let Some(shortfall) = plan.budget_shortfall {
        println!(
            "  note: still {} over --max-size; the rest is protected by live roots or used within the last day",
            human_bytes(shortfall)
        );
    }
    if plan.unrecognized_entries > 0 {
        println!(
            "  left alone: {} unrecognized entries",
            plan.unrecognized_entries
        );
    }
    if plan.live_roots == 0 {
        println!(
            "  note: no checkout has registered a root yet, so only last-use age protects generations"
        );
    }
    for warning in &report.warnings {
        println!("  warning: {warning}");
    }
    if !report.applied && !plan.candidates.is_empty() {
        println!("  (dry run: nothing was removed; pass --apply to remove)");
    }
}

#[cfg(test)]
#[path = "cache_gc_tests.rs"]
mod tests;
