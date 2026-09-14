//! Guest fixtures, built from tracked sources instead of committed as binaries.
//!
//! These are the guest PROGRAMS the native host launches end to end: the host
//! needs a real wasm module to run, and each smoke test supplies one.
//!
//! They used to be 43 committed `.wasm` files, force-added past `.gitignore`'s
//! blanket `*.wasm` ("Wasm binaries are build artifacts... Nothing tracked
//! under git"). Two reasons were given for the exception, and only one held.
//! The weaker one was convenience -- `fixtures/README.md` said they were
//! checked in "so the test needs only a built `kernel.wasm`, not a full
//! guest-program build". The stronger one was a genuine cycle: the generators
//! that rebuild the hand-written WAT fixtures live in the very crate that
//! `include_bytes!` would not compile without them.
//!
//! **Loading them at RUNTIME dissolves that cycle.** The crate compiles
//! whether or not an artifact exists, so the generators can run before
//! anything needs them. What the committed binaries actually bought was a
//! guest-build step, and what they cost was silent staleness: nothing rebuilt
//! them when libc changed, and for months nothing checked them at load either
//! (see L-D4). Twenty-three of them were measurably stale.
//!
//! This mirrors what the JavaScript side already does -- `.gitignore` says so
//! in the same breath: "test fixtures under `host/test/fixtures/` are produced
//! by the vitest global-setup from `.wat` sources."

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fixtures")
}

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
}

/// The newest mtime among everything a fixture is built FROM.
///
/// Sources, the recipe itself, and the sysroot: a libc change is exactly the
/// drift that made the committed artifacts stale, so it has to count as an
/// input or this check would answer a narrower question than it was asked.
fn newest_input() -> Option<std::time::SystemTime> {
    let mut newest = None;
    let mut consider = |p: PathBuf| {
        if let Ok(t) = std::fs::metadata(&p).and_then(|m| m.modified()) {
            if newest.is_none_or(|n| t > n) {
                newest = Some(t);
            }
        }
    };
    let dir = fixtures_dir();
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for e in entries.flatten() {
            let p = e.path();
            match p.extension().and_then(|x| x.to_str()) {
                Some("c") | Some("wat") | Some("sh") => consider(p),
                _ => {}
            }
        }
    }
    consider(repo_root().join("sysroot/lib/libc.a"));
    consider(repo_root().join("sysroot64/lib/libc.a"));
    consider(repo_root().join("libc/glue/channel_syscall.c"));
    newest
}

fn oldest_artifact() -> Option<std::time::SystemTime> {
    let mut oldest = None;
    for e in std::fs::read_dir(fixtures_dir()).ok()?.flatten() {
        let p = e.path();
        if p.extension().and_then(|x| x.to_str()) != Some("wasm") {
            continue;
        }
        let t = std::fs::metadata(&p).ok()?.modified().ok()?;
        if oldest.is_none_or(|o| t < o) {
            oldest = Some(t);
        }
    }
    oldest
}

/// Build every fixture, once per test process, if any is missing or older than
/// what it is built from.
pub(crate) fn provision() {
    static ONCE: OnceLock<()> = OnceLock::new();
    ONCE.get_or_init(|| {
        let fresh = match (oldest_artifact(), newest_input()) {
            (Some(oldest), Some(newest)) => oldest > newest,
            _ => false,
        };
        if fresh {
            return;
        }
        build_all();
    });
}

/// Run the producer.
///
/// Separate from `provision` because a Once-guarded build cannot answer one
/// case: a directory holding SOME artifacts, all newer than the sources,
/// reads as fresh, so the build is skipped and the missing one is never made.
/// `oldest_artifact` compares the oldest file PRESENT, and cannot see a file
/// that is absent. That is an interrupted `build-fixtures.sh` or a
/// hand-deleted artifact, and the symptom was a panic blaming a build step
/// that had not run.
fn build_all() {
    {
        let root = repo_root();
        let status = std::process::Command::new("bash")
            .arg(fixtures_dir().join("build-fixtures.sh"))
            .env("SYSROOT", root.join("sysroot"))
            .env("SYSROOT64", root.join("sysroot64"))
            .current_dir(&root)
            .status();
        match status {
            Ok(s) if s.success() => {}
            Ok(s) => panic!(
                "building the guest fixtures failed ({s}).\n\
                 They are built from tracked sources rather than committed, so \
                 this step is how they exist at all.\n\
                 Run the tests inside the dev shell, which supplies $LLVM_BIN \
                 and the SDK:\n  \
                 scripts/dev-shell.sh cargo test -p host-native \
                 --target \"$(rustc -vV | awk '/^host:/{{print $2}}')\"",
            ),
            Err(e) => panic!("could not run the fixture build script: {e}"),
        }
    }
}

/// One guest fixture's bytes, built on demand.
///
/// Leaked deliberately: these are test inputs handed to `include_bytes!`-shaped
/// call sites, and a `&'static [u8]` keeps every one of them unchanged.
pub(crate) fn fixture(name: &str) -> &'static [u8] {
    static CACHE: OnceLock<Mutex<HashMap<String, &'static [u8]>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some(bytes) = cache.lock().unwrap().get(name) {
        return bytes;
    }
    provision();
    let path = fixtures_dir().join(name);
    if !path.exists() {
        // The corpus looked fresh but this artifact is not in it. Build once
        // more, rather than report "missing after the build step" about a
        // step that never ran.
        build_all();
    }
    let bytes = std::fs::read(&path)
        .unwrap_or_else(|e| panic!("fixture {} is missing after the build step: {e}", path.display()));
    let leaked: &'static [u8] = Box::leak(bytes.into_boxed_slice());
    cache.lock().unwrap().insert(name.to_string(), leaked);
    leaked
}
