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

/// The repository root, spelled WITHOUT `..` components.
///
/// This used to be `MANIFEST_DIR.join("..").join("..")`, which is the same
/// directory and a different STRING -- and the string is what mattered.
/// `build_all` passes `repo_root().join("sysroot")` to
/// `fixtures/build-fixtures.sh`, whose guard refuses any `SYSROOT` that is not
/// byte-equal to its own `REPO_ROOT="$(cd "$FIXTURES_DIR/../../.." && pwd)"`.
/// `pwd` normalises; `join("..")` does not. So the script saw
/// `/…/crates/host-native/../../sysroot`, compared it against
/// `/…/sysroot`, and exited 1 with "cannot be honoured" -- every time,
/// unconditionally. The script's own comment says "crates/host-native/src/
/// fixtures.rs passes these two exact values", and it did not.
///
/// That made the runtime provisioning this module exists to provide
/// (see the header: loading fixtures at runtime is what "dissolves that
/// cycle") impossible: any tree that genuinely needed a rebuild got 46 tests
/// failing on a panic whose advice is to run inside the dev shell, which the
/// caller already was.
///
/// It stayed invisible because a SECOND defect hid it. `newest_input` omitted
/// `crates/fork-instrument`, so the instrumenter could change without marking
/// the fixtures stale -- and with nothing ever judged stale, the broken
/// rebuild was never invoked. Fixing the freshness check is what made this
/// one reachable, and fixing only that would have converted silent staleness
/// into an unconditional 46-test failure.
fn repo_root() -> PathBuf {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest
        .parent()
        .and_then(|crates| crates.parent())
        .expect("CARGO_MANIFEST_DIR is <repo>/crates/host-native")
        .to_path_buf()
}

/// The newest mtime among everything a fixture is built FROM.
///
/// Sources, the recipe itself, and the sysroot: a libc change is exactly the
/// drift that made the committed artifacts stale, so it has to count as an
/// input or this check would answer a narrower question than it was asked.
///
/// # `crates/fork-instrument`, added 2026-09-20
///
/// It was missing, and the omission was the same defect this doc comment
/// warns about, one layer over. `build-fixtures.sh:213` runs
/// `scripts/run-wasm-fork-instrument.sh` over every fixture in its
/// fork-instrumented arm, so the INSTRUMENTER is as much an input as libc is
/// -- but only the sysroot and the fixture sources were consulted. A change
/// to the instrumenter left every instrumented fixture looking fresh, so
/// `cargo test -p host-native` silently tested guests built by a DIFFERENT
/// instrumenter than the one in the tree, and reported green.
///
/// Found while investigating eight host-native failures during the
/// resume-thunk placement work: the fixtures had to be rebuilt by hand to
/// establish that the failures were pre-existing, which is exactly the manual
/// step a freshness check exists to remove.
///
/// This is the third instance of one shape in this repository -- a
/// hand-maintained list of build inputs that omits one, after the kernel's
/// `build.toml` omitting `crates/runtime-core` and `has_programs()`. The
/// durable fix is deriving inputs from the real build closure, as
/// `build_deps.rs` does for the cargo closure. This is the narrow fix; see
/// `docs/future-improvements.md`.
///
/// Adding an input can only make this check STRICTER: it may cause a rebuild
/// that was not needed, and can never accept an artifact that is stale.
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
    // Several fixtures are a single `#include` of a shared program under
    // `examples/` or `programs/`, so the Node and native hosts run
    // byte-identical source. Their C sources are inputs too (only the
    // sources: `examples/` also holds `.wasm` outputs `build-programs.sh`
    // rewrites, which would make every fixture look stale).
    for tree in ["examples", "programs"] {
        consider_tree(
            &mut |p: PathBuf| {
                if matches!(p.extension().and_then(|x| x.to_str()), Some("c") | Some("h")) {
                    consider(p);
                }
            },
            repo_root().join(tree),
        );
    }
    // The fork instrumenter that `build-fixtures.sh` runs over the
    // instrumented arm. Walked rather than listed, so a NEW source file in
    // that crate counts without anyone remembering to add it here -- a
    // hand-listed subset would reproduce the omission this closes.
    consider_tree(&mut consider, repo_root().join("crates/fork-instrument/src"));
    consider(repo_root().join("crates/fork-instrument/Cargo.toml"));
    consider(repo_root().join("scripts/run-wasm-fork-instrument.sh"));
    newest
}

/// Every regular file under `root`, recursively, fed to `consider`.
///
/// A missing directory is not an error: this check reports "cannot tell"
/// rather than failing, and an absent input simply does not raise the
/// watermark.
fn consider_tree(consider: &mut impl FnMut(PathBuf), root: PathBuf) {
    let Ok(entries) = std::fs::read_dir(&root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        match entry.file_type() {
            Ok(t) if t.is_dir() => consider_tree(consider, path),
            Ok(t) if t.is_file() => consider(path),
            _ => {}
        }
    }
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
