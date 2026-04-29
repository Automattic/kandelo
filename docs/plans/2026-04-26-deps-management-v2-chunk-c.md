# Wasm Dependency Management V2 — Chunk C (source kind + inline host_tools)

> **For Claude:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development`
> to execute this plan task-by-task.

**Goal:** Land the `kind = "source"` schema variant + the inline
`[[host_tools]]` array-of-tables on consumer manifests, plus the
resolver plumbing they imply: a fetch+extract path for unbuilt
source trees, a probe runner that validates host-tool presence and
version before invoking a build script, and a `xtask build-deps
check` lint that flags cross-consumer host-tool inconsistency.

**Architecture:** Reuse Chunk A+B's `DepsManifest`/`Registry`
machinery. Add (a) source-kind validation that rejects
`[outputs]`/`[binary]`/`[compatibility]`, (b) a separate
cache-key-sha domain (`wasm-posix-deps-source.v2`) that drops the
`target_arch` and `abi_version` inputs (sources are arch-agnostic
and ABI-agnostic per design 6/9), (c) a default-fetch+extract
resolver path keyed by URL extension (`.tar.gz` / `.tar.xz` /
`.tar.bz2` / `.tar.zst` / `.zip` / `.tar`), with a `[build].script`
override path that uses the same env-var contract as
library/program builds, (d) a new `WASM_POSIX_DEP_<NAME>_SRC_DIR`
env var per direct source-kind dep, (e) `[[host_tools]]` parsing
with `>=X.Y[.Z]` constraints, optional `probe`, and per-platform
`install_hints`, (f) a probe runner integrated into `ensure_built`
that runs presence-checks before any build script, (g) a `check`
subcommand that walks the registry and lints host-tool consistency.
Host-tool refs do NOT enter cache-key shas (decision 10).

**Tech Stack:** Rust (xtask), TOML (manifest schema), `tar` /
`zstd` / `flate2` / `bzip2` / `xz2` (or `liblzma`) / `zip` for
extract; `regex` for probe version parsing.

**Design reference:**
`docs/plans/2026-04-22-deps-management-v2-design.md` (locked
decisions 9, 10, 11, 12, 13, 14 for source/host-tool semantics;
decision 5 for the env-var surface).
**Implementation predecessor:**
`docs/plans/2026-04-22-deps-management-v2-implementation.md`
Chunk C section (tasks C.1–C.12).

**Stack base:** `deps-cache-v2-program-migration` @ `de11c0866` (PR #347).

**Branch:** `deps-cache-v2-source-and-host-tools`.

**Final PR base:** `deps-cache-v2-program-migration`. Do NOT merge —
the user is holding all V2 PRs until V2 is fully done.

---

## Acceptance criteria

- `kind = "source"` parses and validates: rejects `[outputs]`,
  `[[outputs]]`, `[binary]`, `[compatibility]` at parse time;
  accepts `[source]`, `[license]`, optional `depends_on`, optional
  `[build].script`.
- Cache-key sha for source-kind uses domain
  `wasm-posix-deps-source.v2\n` and **omits** `target_arch` +
  `abi_version` from the input. Library/program domain remains
  `wasm-posix-deps.v2\n`.
- Source-kind cache layout is
  `<cache>/sources/<name>-<v>-rev<N>-<short_sha>/` — no `<arch>`
  segment. `canonical_path` produces this for `ManifestKind::Source`.
- Resolver default path (no `[build].script` declared): fetch
  `[source].url` (file:// + http/https), verify `[source].sha256`,
  detect format from URL extension, decompress + extract under
  `<cache>/sources/<name>-<v>-rev<N>-<sha>.tmp-<pid>/`, atomic
  rename. Strips a single shared top-level directory if present
  (e.g. `pcre2-10.42/...` → flatten to `<cache_dir>/...`); otherwise
  preserves the layout as-is.
- Resolver override path (`[build].script` declared): bash-execute
  the script with the standard env-var contract (`OUT_DIR`, `NAME`,
  `VERSION`, `REVISION`, `SOURCE_URL`, `SOURCE_SHA256`,
  `TARGET_ARCH`, transitive `_DIR` + `_SRC_DIR` + `PKG_CONFIG_PATH`
  for declared deps), validate that `OUT_DIR` is non-empty after
  the script returns, atomic rename.
- A direct source-kind dep on a consumer's `depends_on` exports
  `WASM_POSIX_DEP_<UPPER_NAME>_SRC_DIR` with the resolved path.
  Library/program direct deps continue to export `_DIR`.
- `[[host_tools]]` parses an array-of-tables on every
  library/program/source manifest. Each entry: required `name` +
  `version_constraint` (`">=X.Y"` or `">=X.Y.Z"`); optional
  `probe = { args = [...], version_regex = "..." }`; optional
  `install_hints = { darwin = "...", linux = "...", windows = "..." }`.
- `version_constraint` parser accepts `">=X.Y"` and `">=X.Y.Z"`
  only. Other operators (`>X`, `<X`, `==X`, `^X`, `~X`,
  `>=X,<Y`) reject with a "future-work" error message naming the
  bad operator.
- Probe runner: spawns `<name>` (executable from `name`)
  with `probe.args` (default `["--version"]`); reads stdout; finds
  the first regex match (default `'(\d+\.\d+(?:\.\d+)?)'`); parses
  the captured version as 2- or 3-component dotted integers;
  compares numerically against `version_constraint`. On failure
  prints the platform-keyed `install_hints` (matched on
  `cfg!(target_os)`); falls back to a generic "install the
  required tool" message when no per-platform hint matches.
- `ensure_built` runs the host-tool probe BEFORE invoking the
  consumer's build script (whether the script is a source-kind
  override or a library/program build). Probe failure aborts the
  resolve and prints all failed tools' install hints in one block.
  Host-tool refs do NOT contribute to the consumer's cache-key
  sha.
- `xtask build-deps check` walks the registry, groups host-tool
  declarations by `name` across all consumers, and reports an error
  (exit code 1) when consumers declare different
  `version_constraint` or different `probe` for the same tool.
- Full 6-gate gauntlet green vs Chunk B baseline `de11c0866`:
  cargo kernel, xtask, vitest, libc-test (no new FAILs), POSIX, sortix
  (`--all`, no new FAILs / XPASSes), ABI snapshot.
- PR opened against `deps-cache-v2-program-migration`; not merged.

---

## How to execute

Use `superpowers:subagent-driven-development` to dispatch one fresh
subagent per task. Per the user's instructions:

- **Always Opus 4.6** (`model: "opus"` on every Agent invocation —
  never Sonnet/Haiku).
- **Trivial tasks** (a single env-var addition, a single test that
  the schema rejects something, a doc-only change): impl-only, no
  reviewer round-trip. Subagent-as-implementer; check the diff
  yourself.
- **Non-trivial tasks** (parser changes, fetch/extract, probe
  runner, the `check` subcommand): full impl → spec reviewer →
  code-quality reviewer cycle.

Working dir for all subagents:
`/Users/brandon/.superset/worktrees/wasm-posix-kernel/deps-cache-v1`.

Each task ends with: run `cargo test -p xtask --target
aarch64-apple-darwin` (xtask requires explicit host triple per
Chunk A — `ureq`'s TLS deps don't compile for wasm), commit, move
on. Do NOT run the full 5-gate gauntlet between tasks; gauntlet is
once at the end (C.13).

**Pre-existing dirty state to ignore in commits:**
- `examples/libs/{curl,libcurl,wget,git,file,bc,nano}-src/*` —
  rebuild byproducts on the worktree.
- `package-lock.json` worktree-name diff (`"name": "deps-cache-v1"`).
- The kernel `.deps/*.Po`/Makefile churn under
  `examples/libs/{bc,curl,file,...}-src/`.
- Various `host` / browser dist artifacts that appeared since the
  last clean checkout.

Each task's commit MUST stage only its own files. Use `git add
<exact paths>`; never `git add -A` / `git add .`.

**Stack convention:** child PR's base is parent's branch. Final
PR target = `deps-cache-v2-program-migration`. Do NOT rebase the
branch onto `main` — that desyncs the V2 stack.

---

## Tasks

Twelve tasks (C.1–C.12) plus a final gauntlet/PR step (C.13).
Each task lists exact files, TDD-style steps, and a commit
template. Tasks are roughly ordered so each commit compiles on
its own; the only forward-reference is C.10 (which integrates the
probe into `ensure_built`) needing the probe runner from C.9.

### Task C.1: Add `kind = "source"` parser + validator

**Files:**
- Modify: `xtask/src/deps_manifest.rs` (extend `validate_common`
  + add new tests in the `tests` module).

**Goal:** Source-kind manifests already parse via the tagged-enum
discriminator added in Chunk A. What's missing is field-level
validation that rejects `[binary]` and `[[host_tools]]`-only-on-
non-source rules. Concretely after this task:

| Block             | library | program | source |
|-------------------|---------|---------|--------|
| `[outputs]`       | OK      | reject  | reject |
| `[[outputs]]`     | reject  | OK      | reject |
| `[binary]`        | OK      | OK      | reject |
| `[compatibility]` | reject (source-mode parse rejects always) ||
| `[[host_tools]]`  | OK      | OK      | OK (added in C.7)        |

Source-mode parse already rejects `[compatibility]` (Chunk A).
Source rejects `[outputs]`/`[[outputs]]` already (Chunk B).
**This task only adds the `[binary]`-rejection-for-sources rule.**
The `[[host_tools]]`-on-source acceptance lands in C.7.

**Step 1: Write the failing test**

Add to `xtask/src/deps_manifest.rs` test module:

```rust
#[test]
fn source_kind_rejects_binary_block() {
    let text = r#"
kind = "source"
name = "pcre2-source"
version = "10.42"
revision = 1

[source]
url = "https://example.test/pcre2.tar.bz2"
sha256 = "0000000000000000000000000000000000000000000000000000000000000000"

[license]
spdx = "BSD-3-Clause"

[binary]
archive_url = "https://example.test/pcre2.tar.zst"
archive_sha256 = "1111111111111111111111111111111111111111111111111111111111111111"
"#;
    let err = DepsManifest::parse(text, PathBuf::from("/x")).unwrap_err();
    assert!(
        err.contains("source") && err.contains("binary"),
        "got: {err}"
    );
}
```

**Step 2: Run test to verify it fails**

```bash
cargo test -p xtask --target aarch64-apple-darwin -- \
  source_kind_rejects_binary_block
```
Expected: FAIL (test currently parses successfully — `[binary]` is
allowed on every kind).

**Step 3: Add the rejection in `validate_common`**

In `validate_common`, after `Self::validate_binary(b)?;` is called,
add a kind check:

```rust
if let Some(b) = raw.binary.as_ref() {
    Self::validate_binary(b)?;
    if matches!(raw.kind, ManifestKind::Source) {
        return Err(
            "kind = \"source\" must not declare [binary] \
             (sources are not published as remote-fetchable archives)"
                .into(),
        );
    }
}
```

**Step 4: Run test to verify it passes**

```bash
cargo test -p xtask --target aarch64-apple-darwin -- \
  source_kind_rejects_binary_block
```
Expected: PASS.

**Step 5: Add a positive test**

```rust
#[test]
fn source_kind_minimal_manifest_parses() {
    let text = r#"
kind = "source"
name = "pcre2-source"
version = "10.42"
revision = 1

[source]
url = "https://example.test/pcre2.tar.bz2"
sha256 = "0000000000000000000000000000000000000000000000000000000000000000"

[license]
spdx = "BSD-3-Clause"
"#;
    let m = DepsManifest::parse(text, PathBuf::from("/x")).unwrap();
    assert!(matches!(m.kind, ManifestKind::Source));
    assert_eq!(m.name, "pcre2-source");
    assert!(m.outputs.libs.is_empty());
    assert!(m.program_outputs.is_empty());
    assert!(m.binary.is_none());
}
```

Run; expect PASS.

**Step 6: Commit**

```bash
git add xtask/src/deps_manifest.rs
git commit -m "feat(xtask): reject [binary] on kind=\"source\" manifests

Sources are arch-agnostic and ABI-agnostic per design decision 9; they
are not published as remote-fetchable archives, so [binary] is meaningless
on them. Add the parse-time rejection alongside the existing
[outputs]/[[outputs]] rejection from Chunk B."
```

---

### Task C.2: Source-kind cache layout (no arch segment)

**Files:**
- Modify: `xtask/src/build_deps.rs` (`canonical_path`).
- Tests in the same file's `mod tests`.

**Goal:** For `ManifestKind::Source`, drop the `<arch>` segment
from the cache directory name. Layout becomes
`<cache_root>/sources/<name>-<v>-rev<N>-<short_sha>/` (no
arch). Other kinds unchanged: `libs/<name>-<v>-rev<N>-<arch>-<sha>/`,
`programs/<name>-<v>-rev<N>-<arch>-<sha>/`.

**Step 1: Write the failing test**

Add to the `mod tests` block in `xtask/src/build_deps.rs`:

```rust
#[test]
fn source_kind_canonical_path_omits_arch() {
    let dir = tempfile::tempdir().unwrap();
    let m = parse_source_manifest(dir.path());
    let sha = [0u8; 32];
    let cache = PathBuf::from("/cache");
    let path = canonical_path(&cache, &m, TargetArch::Wasm32, &sha);
    assert_eq!(
        path,
        PathBuf::from("/cache/sources/pcre2-source-10.42-rev1-00000000")
    );
}

fn parse_source_manifest(dir: &Path) -> DepsManifest {
    let text = r#"
kind = "source"
name = "pcre2-source"
version = "10.42"
revision = 1

[source]
url = "https://example.test/pcre2.tar.bz2"
sha256 = "0000000000000000000000000000000000000000000000000000000000000000"

[license]
spdx = "BSD-3-Clause"
"#;
    DepsManifest::parse(text, dir.to_path_buf()).unwrap()
}
```

**Step 2: Run; verify FAIL** (current code produces
`/cache/sources/pcre2-source-10.42-rev1-wasm32-00000000`).

**Step 3: Update `canonical_path`**

```rust
pub fn canonical_path(
    cache_root: &Path,
    m: &DepsManifest,
    arch: TargetArch,
    sha: &[u8; 32],
) -> PathBuf {
    let kind_subdir = match m.kind {
        ManifestKind::Library => "libs",
        ManifestKind::Program => "programs",
        ManifestKind::Source => "sources",
    };
    let basename = match m.kind {
        ManifestKind::Source => format!(
            "{}-{}-rev{}-{}",
            m.name,
            m.version,
            m.revision,
            &hex(sha)[..8]
        ),
        ManifestKind::Library | ManifestKind::Program => format!(
            "{}-{}-rev{}-{}-{}",
            m.name,
            m.version,
            m.revision,
            arch.as_str(),
            &hex(sha)[..8]
        ),
    };
    cache_root.join(kind_subdir).join(basename)
}
```

**Step 4: Run; verify PASS** of the new test, and verify the
existing `canonical_path_layout` test (library kind) still PASSES.

**Step 5: Commit**

```bash
git add xtask/src/build_deps.rs
git commit -m "feat(xtask): source-kind canonical path omits arch segment

Sources are arch-agnostic per design 6 — a single cache entry serves
both wasm32 and wasm64 consumers. canonical_path now produces
<cache>/sources/<name>-<v>-rev<N>-<sha>/ for ManifestKind::Source,
keeping libs/programs at <name>-<v>-rev<N>-<arch>-<sha>/."
```

---

### Task C.3: Source-kind cache-key sha (separate domain, no arch/abi inputs)

**Files:**
- Modify: `xtask/src/build_deps.rs` (`compute_sha`).
- Tests.

**Goal:** Source-kind manifests get a separate sha domain so a
consumer that depends on a library AND a same-named source can
never have their cache-key shas collide. The source-kind sha
also drops the `target_arch` and `abi_version` inputs (sources are
arch/ABI-agnostic).

**Step 1: Write the failing test**

```rust
#[test]
fn source_kind_sha_omits_arch_and_abi_inputs() {
    let dir = tempfile::tempdir().unwrap();
    let m = parse_source_manifest(dir.path());

    let registry = Registry { roots: vec![] };
    let sha32_v1 = compute_sha(
        &m, &registry, TargetArch::Wasm32, 4,
        &mut Default::default(), &mut Default::default(),
    ).unwrap();
    let sha64_v1 = compute_sha(
        &m, &registry, TargetArch::Wasm64, 4,
        &mut Default::default(), &mut Default::default(),
    ).unwrap();
    let sha32_v9 = compute_sha(
        &m, &registry, TargetArch::Wasm32, 9,
        &mut Default::default(), &mut Default::default(),
    ).unwrap();
    assert_eq!(sha32_v1, sha64_v1, "arch must not affect source sha");
    assert_eq!(sha32_v1, sha32_v9, "abi must not affect source sha");
}

#[test]
fn source_kind_sha_uses_distinct_domain() {
    let dir = tempfile::tempdir().unwrap();
    let m_src = parse_source_manifest(dir.path());

    // Compose a synthetic library manifest with the same name/version
    // and same source URL+sha to confirm the domain separator is the
    // only differentiator.
    let lib_text = r#"
kind = "library"
name = "pcre2-source"
version = "10.42"
revision = 1

[source]
url = "https://example.test/pcre2.tar.bz2"
sha256 = "0000000000000000000000000000000000000000000000000000000000000000"

[license]
spdx = "BSD-3-Clause"

[outputs]
libs = []
"#;
    let m_lib = DepsManifest::parse(lib_text, dir.path().to_path_buf()).unwrap();

    let registry = Registry { roots: vec![] };
    let s_src = compute_sha(
        &m_src, &registry, TargetArch::Wasm32, 4,
        &mut Default::default(), &mut Default::default(),
    ).unwrap();
    let s_lib = compute_sha(
        &m_lib, &registry, TargetArch::Wasm32, 4,
        &mut Default::default(), &mut Default::default(),
    ).unwrap();
    assert_ne!(s_src, s_lib, "source vs library shas must differ on domain");
}
```

**Step 2: Run; verify FAIL.**

**Step 3: Branch the sha computation on kind**

In `compute_sha`, after the `chain.push` block:

```rust
let mut h = Sha256::new();
match target.kind {
    ManifestKind::Source => {
        h.update(b"wasm-posix-deps-source.v2\n");
        h.update(target.name.as_bytes());
        h.update(b"\n");
        h.update(target.version.as_bytes());
        h.update(b"\n");
        h.update(target.revision.to_le_bytes());
        h.update(b"\n");
        // No target_arch, no abi_version — sources are arch/ABI-agnostic.
        h.update(target.source.url.as_bytes());
        h.update(b"\n");
        h.update(target.source.sha256.as_bytes());
        h.update(b"\n");
    }
    ManifestKind::Library | ManifestKind::Program => {
        h.update(b"wasm-posix-deps.v2\n");
        h.update(target.name.as_bytes());
        h.update(b"\n");
        h.update(target.version.as_bytes());
        h.update(b"\n");
        h.update(target.revision.to_le_bytes());
        h.update(b"\n");
        h.update(arch.as_str().as_bytes());
        h.update(b"\n");
        h.update(abi_version.to_le_bytes());
        h.update(b"\n");
        h.update(target.source.url.as_bytes());
        h.update(b"\n");
        h.update(target.source.sha256.as_bytes());
        h.update(b"\n");
    }
}
for (dref, dsha) in &dep_shas {
    h.update(dref.name.as_bytes());
    h.update(b"@");
    h.update(dref.version.as_bytes());
    h.update(b":");
    h.update(hex(dsha).as_bytes());
    h.update(b"\n");
}
```

**Step 4: Run; verify both new tests PASS** and the existing
`cache_key_sha_changes_with_target_arch` /
`cache_key_sha_changes_with_abi_version` tests still PASS (those
manifests are kind=library).

**Step 5: Commit**

```bash
git add xtask/src/build_deps.rs
git commit -m "feat(xtask): source-kind cache-key sha domain + arch/abi-free inputs

compute_sha branches on ManifestKind. Source manifests use domain
\"wasm-posix-deps-source.v2\\n\" and omit target_arch / abi_version
from the hash; libraries and programs keep \"wasm-posix-deps.v2\\n\"
with arch + abi inputs unchanged. This is the correctness gate for
source-kind cache hits across wasm32/wasm64 consumers and across
ABI bumps (sources have neither attribute)."
```

---

### Task C.4: Resolver default fetch+extract path for source-kind (no [build].script)

**Files:**
- Create: `xtask/src/source_extract.rs` (new module — extract
  routines per archive format).
- Modify: `xtask/src/main.rs` (declare module).
- Modify: `xtask/Cargo.toml` (add `flate2`, `bzip2`, `xz2`).
- Modify: `xtask/src/build_deps.rs` (route source-kind through
  default extract when `[build].script` is absent).
- Modify: `xtask/src/remote_fetch.rs` — extract `fetch_url` +
  `verify_sha` into `pub(crate)` so source-extract can reuse them
  (or re-implement; trivial helpers).

**Goal:** Source-kind manifests without `[build].script` resolve
by:
1. Computing the cache-key sha + canonical path.
2. If the canonical dir exists, return it (cache hit).
3. Otherwise: download `[source].url` (file:// or http(s)://),
   verify `[source].sha256`, detect format from URL extension,
   decompress + extract into `<canonical>.tmp-<pid>/`, atomic
   rename.
4. After extract, if the archive contains exactly one top-level
   directory entry (the typical `pcre2-10.42/` shape), strip
   that segment so consumers see source files at the cache
   directory's root.

**Step 1: Promote `fetch_url` and `verify_sha` to crate-public**

In `xtask/src/remote_fetch.rs`, change `fn fetch_url` and `fn
verify_sha` from private to `pub(crate) fn`. Use the existing
`FetchError` enum unchanged. (No test for this trivial visibility
change; downstream tests in C.4 cover it.)

**Step 2: Add archive-format crates**

In `xtask/Cargo.toml`, add:

```toml
flate2 = { version = "1", default-features = false, features = ["rust_backend"] }
bzip2 = "0.4"
xz2 = "0.1"
```

`flate2` `rust_backend` avoids zlib-sys C dep; `bzip2` and `xz2`
each link a small bundled C lib by default — this is fine on
host targets (xtask is host-only). Run `cargo build -p xtask
--target aarch64-apple-darwin` to verify they compile.

**Step 3: Write `source_extract.rs` skeleton**

```rust
//! Source-kind archive fetch + extract. Reused by the resolver
//! when a `kind = "source"` manifest has no [build].script.
//!
//! Format detection is purely on URL extension. The resolver
//! never inspects archive bytes for magic numbers — the URL is
//! authoritative because the manifest's source.sha256 anchors
//! both the bytes and the format.

use std::fs;
use std::io::Read;
use std::path::Path;

use crate::remote_fetch::{fetch_url, verify_sha, FetchError};

/// Decompressed-output cap. Protects against zip-bomb-style
/// archives. 4 GiB is generous — typical source tarballs we
/// extract are 10–100 MiB; PHP, MariaDB, Erlang vendored sources
/// are the largest at <1 GiB. Tightening below 4 GiB risks
/// false-positive on Erlang OTP source.
const MAX_DECOMPRESSED_BYTES: u64 = 4 * 1024 * 1024 * 1024;

#[derive(Debug)]
pub enum ArchiveFormat {
    TarGz,
    TarXz,
    TarBz2,
    TarZst,
    Zip,
    Tar,
}

impl ArchiveFormat {
    /// Detect from URL extension. Falls through to an error when
    /// no known suffix matches — the resolver surfaces that to
    /// the user verbatim.
    pub fn from_url(url: &str) -> Result<Self, String> {
        let lc = url.to_ascii_lowercase();
        // Order matters: .tar.gz must be checked before .gz, etc.
        if lc.ends_with(".tar.gz") || lc.ends_with(".tgz") {
            Ok(Self::TarGz)
        } else if lc.ends_with(".tar.xz") || lc.ends_with(".txz") {
            Ok(Self::TarXz)
        } else if lc.ends_with(".tar.bz2") || lc.ends_with(".tbz2") || lc.ends_with(".tbz") {
            Ok(Self::TarBz2)
        } else if lc.ends_with(".tar.zst") || lc.ends_with(".tzst") {
            Ok(Self::TarZst)
        } else if lc.ends_with(".zip") {
            Ok(Self::Zip)
        } else if lc.ends_with(".tar") {
            Ok(Self::Tar)
        } else {
            Err(format!(
                "could not detect archive format from URL extension: {url:?} \
                 (supported: .tar.gz, .tgz, .tar.xz, .txz, .tar.bz2, .tbz2, .tbz, \
                  .tar.zst, .tzst, .zip, .tar)"
            ))
        }
    }
}

/// Fetch + verify + extract a source archive into `dest`. The
/// caller is responsible for using a tmp dir + atomic rename.
///
/// On success the directory contains the archive's contents. If
/// the archive contained exactly one top-level entry (a directory),
/// that segment is *stripped* — consumers see source files at the
/// cache directory's root, not nested inside `<name>-<version>/`.
pub fn fetch_and_extract(
    url: &str,
    sha256_hex: &str,
    dest: &Path,
) -> Result<(), String> {
    let bytes = fetch_url(url).map_err(|e| format!("{e}"))?;
    verify_sha(&bytes, sha256_hex).map_err(|e| format!("{e}"))?;
    let format = ArchiveFormat::from_url(url)?;
    extract(&bytes, format, dest)?;
    flatten_single_top_level(dest)?;
    Ok(())
}

fn extract(bytes: &[u8], format: ArchiveFormat, dest: &Path) -> Result<(), String> {
    fs::create_dir_all(dest).map_err(|e| format!("create {}: {e}", dest.display()))?;
    match format {
        ArchiveFormat::TarGz => {
            let r = flate2::read::GzDecoder::new(bytes);
            let bounded = r.take(MAX_DECOMPRESSED_BYTES);
            tar::Archive::new(bounded)
                .unpack(dest)
                .map_err(|e| format!("tar.gz unpack {}: {e}", dest.display()))?;
        }
        ArchiveFormat::TarXz => {
            let r = xz2::read::XzDecoder::new(bytes);
            let bounded = r.take(MAX_DECOMPRESSED_BYTES);
            tar::Archive::new(bounded)
                .unpack(dest)
                .map_err(|e| format!("tar.xz unpack {}: {e}", dest.display()))?;
        }
        ArchiveFormat::TarBz2 => {
            let r = bzip2::read::BzDecoder::new(bytes);
            let bounded = r.take(MAX_DECOMPRESSED_BYTES);
            tar::Archive::new(bounded)
                .unpack(dest)
                .map_err(|e| format!("tar.bz2 unpack {}: {e}", dest.display()))?;
        }
        ArchiveFormat::TarZst => {
            let r = zstd::stream::read::Decoder::new(bytes)
                .map_err(|e| format!("zstd decoder: {e}"))?;
            let bounded = r.take(MAX_DECOMPRESSED_BYTES);
            tar::Archive::new(bounded)
                .unpack(dest)
                .map_err(|e| format!("tar.zst unpack {}: {e}", dest.display()))?;
        }
        ArchiveFormat::Tar => {
            let bounded = std::io::Read::take(bytes, MAX_DECOMPRESSED_BYTES);
            tar::Archive::new(bounded)
                .unpack(dest)
                .map_err(|e| format!("tar unpack {}: {e}", dest.display()))?;
        }
        ArchiveFormat::Zip => {
            // zip crate works on Read+Seek, not streams, so write the
            // bytes to a temp file first. The file lives only as long
            // as this scope.
            let mut tmp = tempfile::NamedTempFile::new()
                .map_err(|e| format!("zip tempfile: {e}"))?;
            std::io::Write::write_all(&mut tmp, bytes)
                .map_err(|e| format!("zip tempfile write: {e}"))?;
            let f = tmp.reopen().map_err(|e| format!("zip reopen: {e}"))?;
            let mut zip = zip::ZipArchive::new(f)
                .map_err(|e| format!("zip parse: {e}"))?;
            zip.extract(dest).map_err(|e| format!("zip extract: {e}"))?;
        }
    }
    Ok(())
}

/// If `dest` contains exactly one entry and that entry is a
/// directory, move its contents up into `dest` and remove the
/// wrapper. Mirrors the pattern of every upstream tarball
/// (`pcre2-10.42/...`, `php-8.3.0/...`, etc.).
fn flatten_single_top_level(dest: &Path) -> Result<(), String> {
    let mut entries: Vec<_> = fs::read_dir(dest)
        .map_err(|e| format!("read_dir {}: {e}", dest.display()))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("read_dir {}: {e}", dest.display()))?;
    if entries.len() != 1 {
        return Ok(());
    }
    let only = entries.pop().unwrap();
    let only_path = only.path();
    let metadata = fs::metadata(&only_path)
        .map_err(|e| format!("stat {}: {e}", only_path.display()))?;
    if !metadata.is_dir() {
        return Ok(());
    }
    // Move children one level up.
    for child in fs::read_dir(&only_path)
        .map_err(|e| format!("read_dir {}: {e}", only_path.display()))?
    {
        let child = child.map_err(|e| format!("read_dir entry: {e}"))?;
        let from = child.path();
        let to = dest.join(child.file_name());
        fs::rename(&from, &to)
            .map_err(|e| format!("rename {} -> {}: {e}", from.display(), to.display()))?;
    }
    fs::remove_dir(&only_path)
        .map_err(|e| format!("rmdir {}: {e}", only_path.display()))?;
    Ok(())
}
```

Add module declaration in `xtask/src/main.rs`:

```rust
mod source_extract;
```

Also add `tempfile = "3"` to `[dev-dependencies]` if not already
present (existing tests already use `tempfile`, so it should be —
verify via `grep tempfile xtask/Cargo.toml`). For the zip path
we need it as a *runtime* dep, not just dev — move/promote
accordingly.

**Step 4: Test extract on a hand-built fixture**

Add a new test module section in `source_extract.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;
    use std::io::Write;

    fn make_tar_gz_with_top_dir() -> (Vec<u8>, &'static str) {
        // Construct a tarball containing a single top-level dir
        // `pcre2-10.42/` with one file `pcre2-10.42/README` whose
        // contents are `hello\n`.
        let mut tar_bytes: Vec<u8> = Vec::new();
        {
            let enc = flate2::write::GzEncoder::new(
                &mut tar_bytes,
                flate2::Compression::default(),
            );
            let mut builder = tar::Builder::new(enc);
            let mut header = tar::Header::new_gnu();
            header.set_path("pcre2-10.42/README").unwrap();
            header.set_size(6);
            header.set_mode(0o644);
            header.set_cksum();
            builder.append(&header, &b"hello\n"[..]).unwrap();
            builder.into_inner().unwrap().finish().unwrap();
        }
        (tar_bytes, "hello\n")
    }

    #[test]
    fn extract_tar_gz_strips_single_top_level_dir() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("out");
        let (bytes, expected) = make_tar_gz_with_top_dir();
        extract(&bytes, ArchiveFormat::TarGz, &dest).unwrap();
        flatten_single_top_level(&dest).unwrap();
        let readme = dest.join("README");
        assert!(readme.is_file(), "expected README at {}", readme.display());
        let actual = std::fs::read_to_string(readme).unwrap();
        assert_eq!(actual, expected);
        // `pcre2-10.42` must NOT exist anymore.
        assert!(!dest.join("pcre2-10.42").exists());
    }

    #[test]
    fn extract_preserves_multiple_top_level_entries() {
        // Build a tarball with TWO top-level entries and confirm
        // we DON'T flatten (the wrapper-stripping rule is "exactly
        // one entry").
        let mut tar_bytes: Vec<u8> = Vec::new();
        {
            let enc = flate2::write::GzEncoder::new(
                &mut tar_bytes,
                flate2::Compression::default(),
            );
            let mut builder = tar::Builder::new(enc);
            let mut header = tar::Header::new_gnu();
            header.set_path("a.txt").unwrap();
            header.set_size(2);
            header.set_mode(0o644);
            header.set_cksum();
            builder.append(&header, &b"a\n"[..]).unwrap();
            let mut header2 = tar::Header::new_gnu();
            header2.set_path("b.txt").unwrap();
            header2.set_size(2);
            header2.set_mode(0o644);
            header2.set_cksum();
            builder.append(&header2, &b"b\n"[..]).unwrap();
            builder.into_inner().unwrap().finish().unwrap();
        }

        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("out");
        extract(&tar_bytes, ArchiveFormat::TarGz, &dest).unwrap();
        flatten_single_top_level(&dest).unwrap();
        assert!(dest.join("a.txt").is_file());
        assert!(dest.join("b.txt").is_file());
    }

    #[test]
    fn from_url_detects_known_extensions() {
        assert!(matches!(ArchiveFormat::from_url("https://x/p.tar.gz").unwrap(), ArchiveFormat::TarGz));
        assert!(matches!(ArchiveFormat::from_url("https://x/p.tgz").unwrap(), ArchiveFormat::TarGz));
        assert!(matches!(ArchiveFormat::from_url("https://x/p.tar.xz").unwrap(), ArchiveFormat::TarXz));
        assert!(matches!(ArchiveFormat::from_url("https://x/p.tar.bz2").unwrap(), ArchiveFormat::TarBz2));
        assert!(matches!(ArchiveFormat::from_url("https://x/p.tar.zst").unwrap(), ArchiveFormat::TarZst));
        assert!(matches!(ArchiveFormat::from_url("https://x/p.zip").unwrap(), ArchiveFormat::Zip));
        assert!(matches!(ArchiveFormat::from_url("https://x/p.tar").unwrap(), ArchiveFormat::Tar));
    }

    #[test]
    fn from_url_rejects_unknown_extension() {
        let err = ArchiveFormat::from_url("https://x/p.rar").unwrap_err();
        assert!(err.contains("could not detect"), "got: {err}");
    }

    #[test]
    fn fetch_and_extract_via_file_url_succeeds() {
        // Materialize the fixture tarball, point a file:// URL at
        // it, and run the full fetch_and_extract pipeline.
        let dir = tempfile::tempdir().unwrap();
        let (bytes, _) = make_tar_gz_with_top_dir();
        let archive = dir.path().join("p.tar.gz");
        File::create(&archive).unwrap().write_all(&bytes).unwrap();

        let mut h = sha2::Sha256::new();
        sha2::Digest::update(&mut h, &bytes);
        let sha_hex: [u8; 32] = h.finalize().into();
        let sha_hex = crate::util::hex(&sha_hex);

        let dest = dir.path().join("out");
        let url = format!("file://{}", archive.display());
        fetch_and_extract(&url, &sha_hex, &dest).unwrap();
        assert!(dest.join("README").is_file());
    }
}
```

Run all tests; verify PASS.

**Step 5: Wire into `ensure_built_inner` for source-kind**

In `xtask/src/build_deps.rs`, where the cache-miss path computes
`canonical` and decides between remote-fetch / build-from-source,
add a source-kind branch BEFORE the `[binary]` block (since
sources never have `[binary]`):

```rust
// After: if canonical.is_dir() { return Ok((canonical, transitive)); }

// Source-kind: default fetch+extract path. If `[build].script` is
// declared, fall through to the standard build_into_cache path
// (which runs the script with the env-var contract).
if matches!(target.kind, ManifestKind::Source) && target.build.script.is_none() {
    let parent = canonical
        .parent()
        .ok_or_else(|| format!("canonical path has no parent: {}", canonical.display()))?;
    std::fs::create_dir_all(parent)
        .map_err(|e| format!("create cache parent {}: {e}", parent.display()))?;
    let tmp = parent.join(format!(
        "{}.tmp-{}",
        canonical.file_name().expect("filename").to_string_lossy(),
        std::process::id()
    ));
    if tmp.exists() {
        std::fs::remove_dir_all(&tmp)
            .map_err(|e| format!("clean stale {}: {e}", tmp.display()))?;
    }
    if let Err(e) = source_extract::fetch_and_extract(
        &target.source.url,
        &target.source.sha256,
        &tmp,
    ) {
        let _ = std::fs::remove_dir_all(&tmp);
        return Err(format!(
            "{}: source fetch+extract failed: {e}",
            target.spec()
        ));
    }
    if canonical.exists() {
        let _ = std::fs::remove_dir_all(&tmp);
        return Ok((canonical, transitive));
    }
    std::fs::rename(&tmp, &canonical)
        .map_err(|e| format!("rename {} -> {}: {e}", tmp.display(), canonical.display()))?;
    return Ok((canonical, transitive));
}
```

**Step 6: Integration test**

Add to `xtask/src/build_deps.rs` `mod tests`:

```rust
#[test]
fn ensure_built_source_kind_fetches_and_extracts_via_file_url() {
    use std::io::Write;
    let dir = tempfile::tempdir().unwrap();
    let cache = dir.path().join("cache");
    std::fs::create_dir_all(&cache).unwrap();

    // Build a fixture tarball and write to disk.
    let mut tar_bytes: Vec<u8> = Vec::new();
    {
        let enc = flate2::write::GzEncoder::new(
            &mut tar_bytes,
            flate2::Compression::default(),
        );
        let mut builder = tar::Builder::new(enc);
        let mut header = tar::Header::new_gnu();
        header.set_path("pcre2-10.42/README").unwrap();
        header.set_size(6);
        header.set_mode(0o644);
        header.set_cksum();
        builder.append(&header, &b"hello\n"[..]).unwrap();
        builder.into_inner().unwrap().finish().unwrap();
    }
    let archive = dir.path().join("p.tar.gz");
    std::fs::File::create(&archive)
        .unwrap()
        .write_all(&tar_bytes)
        .unwrap();
    let mut h = Sha256::new();
    h.update(&tar_bytes);
    let sha_hex: [u8; 32] = h.finalize().into();
    let sha_hex = hex(&sha_hex);

    // Build a source-kind manifest pointing at our file:// URL.
    let manifest_text = format!(r#"
kind = "source"
name = "pcre2-source"
version = "10.42"
revision = 1

[source]
url = "file://{}"
sha256 = "{sha_hex}"

[license]
spdx = "BSD-3-Clause"
"#, archive.display());
    let m = DepsManifest::parse(&manifest_text, dir.path().to_path_buf()).unwrap();

    let registry = Registry { roots: vec![] };
    let opts = ResolveOpts {
        cache_root: &cache,
        local_libs: None,
    };
    let path = ensure_built(&m, &registry, TargetArch::Wasm32, 4, &opts).unwrap();
    assert!(path.join("README").is_file(), "expected README at {}", path.display());
    assert!(path.starts_with(cache.join("sources")));

    // Idempotent: second resolve hits the cache.
    let path2 = ensure_built(&m, &registry, TargetArch::Wasm32, 4, &opts).unwrap();
    assert_eq!(path, path2);
}
```

Run; verify PASS.

**Step 7: Commit**

```bash
git add xtask/Cargo.toml xtask/Cargo.lock xtask/src/source_extract.rs \
        xtask/src/main.rs xtask/src/build_deps.rs xtask/src/remote_fetch.rs
git commit -m "feat(xtask): source-kind default fetch+extract path

When a kind=\"source\" manifest declares no [build].script, the
resolver fetches [source].url, verifies [source].sha256, detects
the archive format from the URL extension (.tar.gz/.tgz/.tar.xz/
.tar.bz2/.tar.zst/.zip/.tar), decompresses+extracts under a
.tmp-<pid> dir, optionally strips a single top-level wrapper
directory (the typical \"pcre2-10.42/...\" shape), and atomically
renames into <cache>/sources/<name>-<v>-rev<N>-<sha>/.

flate2 (rust_backend), bzip2, xz2 added to xtask deps. Reuses
fetch_url + verify_sha from remote_fetch (now pub(crate))."
```

Reviewer cycle: yes — fetch+extract is non-trivial, has zip-bomb /
path-traversal potential. Spec reviewer should confirm:
- archive-format detection only on URL extension (not bytes);
- single-top-level flattening rule matches the spec;
- 4 GiB decompressed cap consistent across formats;
- no path traversal because tar+zip crates' default unpack rejects
  it (verify by reading their docs).

---

### Task C.5: Source-kind override [build].script path

**Files:**
- Modify: `xtask/src/build_deps.rs`.
- Tests.

**Goal:** When a source-kind manifest declares `[build].script`,
the resolver does NOT fetch/extract for it. Instead, it runs the
script through the standard build path (`build_into_cache`) with
the same env-var contract (OUT_DIR, NAME, VERSION, REVISION,
SOURCE_URL, SOURCE_SHA256, TARGET_ARCH, transitive `_DIR` /
`_SRC_DIR` / `PKG_CONFIG_PATH`). Used for: patch overlays,
git-clone fetches, multi-tarball assembly.

**Validation:** the script must populate `OUT_DIR` with non-empty
content (mirrors `validate_outputs` for libs/programs but lighter:
sources have no declared outputs; presence of any file or
subdirectory in OUT_DIR after the script returns is the success
indicator).

**Step 1: Failing test**

```rust
#[test]
fn ensure_built_source_kind_with_build_script_runs_it() {
    let dir = tempfile::tempdir().unwrap();
    let cache = dir.path().join("cache");
    std::fs::create_dir_all(&cache).unwrap();
    let manifest_dir = dir.path().join("manifest");
    std::fs::create_dir_all(&manifest_dir).unwrap();

    // build script: writes a marker file into OUT_DIR.
    let script = manifest_dir.join("custom.sh");
    std::fs::write(&script, "#!/bin/bash\nset -e\necho hi > \"$WASM_POSIX_DEP_OUT_DIR/marker\"\n").unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();

    let manifest_text = r#"
kind = "source"
name = "pcre2-source"
version = "10.42"
revision = 1

[source]
url = "https://example.test/unused"
sha256 = "0000000000000000000000000000000000000000000000000000000000000000"

[license]
spdx = "BSD-3-Clause"

[build]
script = "custom.sh"
"#;
    let m = DepsManifest::parse(manifest_text, manifest_dir.clone()).unwrap();

    let registry = Registry { roots: vec![] };
    let opts = ResolveOpts {
        cache_root: &cache,
        local_libs: None,
    };
    let path = ensure_built(&m, &registry, TargetArch::Wasm32, 4, &opts).unwrap();
    assert!(path.join("marker").is_file());
    assert!(path.starts_with(cache.join("sources")));
}

#[test]
fn ensure_built_source_kind_script_must_populate_out_dir() {
    let dir = tempfile::tempdir().unwrap();
    let cache = dir.path().join("cache");
    std::fs::create_dir_all(&cache).unwrap();
    let manifest_dir = dir.path().join("manifest");
    std::fs::create_dir_all(&manifest_dir).unwrap();

    // No-op script — leaves OUT_DIR empty.
    let script = manifest_dir.join("noop.sh");
    std::fs::write(&script, "#!/bin/bash\nexit 0\n").unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();

    let manifest_text = r#"
kind = "source"
name = "pcre2-source"
version = "10.42"
revision = 1

[source]
url = "https://example.test/unused"
sha256 = "0000000000000000000000000000000000000000000000000000000000000000"

[license]
spdx = "BSD-3-Clause"

[build]
script = "noop.sh"
"#;
    let m = DepsManifest::parse(manifest_text, manifest_dir).unwrap();

    let registry = Registry { roots: vec![] };
    let opts = ResolveOpts {
        cache_root: &cache,
        local_libs: None,
    };
    let err = ensure_built(&m, &registry, TargetArch::Wasm32, 4, &opts).unwrap_err();
    assert!(
        err.to_lowercase().contains("empty") || err.contains("OUT_DIR"),
        "got: {err}"
    );
}
```

**Step 2: Run; verify FAIL** (currently `validate_outputs`
runs even for source kind and accepts an empty dir, so
`ensure_built_source_kind_with_build_script_runs_it` may
*succeed* but for the wrong reason; check that it produces
`<cache>/sources/...`. The second test will fail because we don't
yet enforce non-empty OUT_DIR for sources).

**Step 3: Branch the cache-miss path**

In `ensure_built_inner`, the structure becomes:

```rust
match (target.kind, target.build.script.as_ref()) {
    (ManifestKind::Source, None) => {
        // C.4 path: default fetch+extract.
        ...
    }
    _ => {
        // C.5: source with override script OR library/program.
        // Both go through build_into_cache. The script gets
        // OUT_DIR + the env-var contract.
        ...
    }
}
```

Update `build_into_cache` to accept a `validate_kind: ManifestKind`
parameter (or pass `target` and dispatch internally) and replace
the call to `validate_outputs` with kind-aware validation:

```rust
let validate_result = match target.kind {
    ManifestKind::Library | ManifestKind::Program => validate_outputs(target, &tmp),
    ManifestKind::Source => validate_source_dir_nonempty(&tmp),
};
```

with:

```rust
fn validate_source_dir_nonempty(out_dir: &Path) -> Result<(), String> {
    let mut iter = std::fs::read_dir(out_dir)
        .map_err(|e| format!("read_dir {}: {e}", out_dir.display()))?;
    if iter.next().is_none() {
        return Err(format!(
            "source build script left OUT_DIR empty at {}; \
             scripts MUST populate $WASM_POSIX_DEP_OUT_DIR with at \
             least one file before exiting",
            out_dir.display()
        ));
    }
    Ok(())
}
```

**Step 4: Run; both tests PASS.**

**Step 5: Commit**

```bash
git add xtask/src/build_deps.rs
git commit -m "feat(xtask): source-kind override [build].script path

When a kind=\"source\" manifest declares [build].script, the resolver
runs the script through build_into_cache with the same env-var
contract used by lib/program builds — OUT_DIR, NAME, VERSION,
REVISION, SOURCE_URL, SOURCE_SHA256, TARGET_ARCH, transitive _DIR/
_SRC_DIR/PKG_CONFIG_PATH. Validation requires OUT_DIR to be
non-empty after the script returns (sources have no declared
outputs; non-emptiness is the only success indicator)."
```

---

### Task C.6: WASM_POSIX_DEP_<NAME>_SRC_DIR env var for source-kind direct deps

**Files:**
- Modify: `xtask/src/build_deps.rs` (`ensure_built_inner` —
  classify dep paths by kind; `build_into_cache` — emit
  `_SRC_DIR` for source-kind deps, `_DIR` for lib/program deps).
- Tests.

**Goal:** When a consumer (lib/program/source) declares
`depends_on = ["pcre2-source@10.42"]`, the resolver exports
`WASM_POSIX_DEP_PCRE2_SOURCE_SRC_DIR` (not `_DIR`) for that direct
dep. Library and program direct deps continue to export `_DIR`.
Justification: design 12 — `_SRC_DIR` is unambiguous about
"unbuilt source tree", `_DIR` would conflate with built artifact.

**Step 1: Failing test**

```rust
#[test]
fn source_kind_direct_dep_exports_src_dir_env_var() {
    let dir = tempfile::tempdir().unwrap();
    let cache = dir.path().join("cache");
    std::fs::create_dir_all(&cache).unwrap();
    let registry_root = dir.path().join("registry");

    // Set up a source-kind dep manifest at registry/foo-source/.
    let foo_dir = registry_root.join("foo-source");
    std::fs::create_dir_all(&foo_dir).unwrap();
    // Make it use a build script (so we don't need a real network).
    let foo_script = foo_dir.join("build-foo-source.sh");
    std::fs::write(&foo_script, "#!/bin/bash\nset -e\necho src > \"$WASM_POSIX_DEP_OUT_DIR/marker\"\n").unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&foo_script, std::fs::Permissions::from_mode(0o755)).unwrap();
    std::fs::write(foo_dir.join("deps.toml"), r#"
kind = "source"
name = "foo-source"
version = "1.0"
revision = 1

[source]
url = "https://example.test/foo.tar.gz"
sha256 = "0000000000000000000000000000000000000000000000000000000000000000"

[license]
spdx = "MIT"

[build]
script = "build-foo-source.sh"
"#).unwrap();

    // Consumer manifest: a library that depends on foo-source. Its
    // build script asserts WASM_POSIX_DEP_FOO_SOURCE_SRC_DIR is set
    // (not _DIR) and points at a real directory.
    let consumer_dir = registry_root.join("consumer");
    std::fs::create_dir_all(&consumer_dir).unwrap();
    let consumer_script = consumer_dir.join("build-consumer.sh");
    std::fs::write(&consumer_script, r#"#!/bin/bash
set -eu
test -n "${WASM_POSIX_DEP_FOO_SOURCE_SRC_DIR:-}" || { echo "missing FOO_SOURCE_SRC_DIR"; exit 1; }
test -d "$WASM_POSIX_DEP_FOO_SOURCE_SRC_DIR" || { echo "not a dir"; exit 1; }
test -z "${WASM_POSIX_DEP_FOO_SOURCE_DIR:-}" || { echo "FOO_SOURCE_DIR should NOT be set"; exit 1; }
mkdir -p "$WASM_POSIX_DEP_OUT_DIR/lib"
echo > "$WASM_POSIX_DEP_OUT_DIR/lib/libconsumer.a"
"#).unwrap();
    std::fs::set_permissions(&consumer_script, std::fs::Permissions::from_mode(0o755)).unwrap();
    std::fs::write(consumer_dir.join("deps.toml"), r#"
kind = "library"
name = "consumer"
version = "0.1"
revision = 1
depends_on = ["foo-source@1.0"]

[source]
url = "https://example.test/consumer.tar.gz"
sha256 = "0000000000000000000000000000000000000000000000000000000000000000"

[license]
spdx = "MIT"

[outputs]
libs = ["lib/libconsumer.a"]
"#).unwrap();

    let registry = Registry { roots: vec![registry_root] };
    let m = registry.load("consumer").unwrap();
    let opts = ResolveOpts { cache_root: &cache, local_libs: None };
    let path = ensure_built(&m, &registry, TargetArch::Wasm32, 4, &opts).unwrap();
    assert!(path.join("lib/libconsumer.a").is_file());
}
```

Run; expect FAIL because `_SRC_DIR` is currently never emitted —
only `_DIR` is.

**Step 2: Track dep kind alongside path**

In `ensure_built_inner` change:

```rust
let mut dep_dirs: BTreeMap<String, PathBuf> = BTreeMap::new();
```

to:

```rust
struct DirectDep { path: PathBuf, kind: ManifestKind }
let mut dep_dirs: BTreeMap<String, DirectDep> = BTreeMap::new();
```

(Type can stay private to the module.)

When recursing into dep_m, store `DirectDep { path: dep_path.clone(), kind: dep_m.kind }`.

In `build_into_cache`, when iterating `dep_dirs`:

```rust
for (name, dep) in dep_dirs {
    let suffix = match dep.kind {
        ManifestKind::Source => "SRC_DIR",
        ManifestKind::Library | ManifestKind::Program => "DIR",
    };
    cmd.env(format!("WASM_POSIX_DEP_{}_{}", env_key(name), suffix), &dep.path);
}
```

(Adjust the function signature to accept `&BTreeMap<String, DirectDep>`.)

**Step 3: Run test; verify PASS.**

**Step 4: Commit**

```bash
git add xtask/src/build_deps.rs
git commit -m "feat(xtask): export WASM_POSIX_DEP_<NAME>_SRC_DIR for source-kind deps

A direct depends_on of a kind=\"source\" manifest now exports the
resolved cache path under the *_SRC_DIR* suffix, distinct from the
*_DIR* suffix used for library/program deps. Per design 12: _SRC_DIR
is unambiguous about unbuilt source trees, while _DIR is reserved
for built-artifact roots. Build scripts can rely on the suffix as a
self-documenting indicator of what shape they're consuming."
```

---

### Task C.7: `[[host_tools]]` array-of-tables parser + validation

**Files:**
- Modify: `xtask/src/deps_manifest.rs`.
- Tests.

**Goal:** Parse an optional `host_tools = [...]` /
`[[host_tools]]` array-of-tables on every manifest kind. Each
entry has:
- Required: `name` (string), `version_constraint` (string).
- Optional: `probe` (table with `args: Vec<String>` and
  `version_regex: String`).
- Optional: `install_hints` (string→string table; keys are
  os-name strings — `darwin`, `linux`, `windows`, `freebsd`, etc.).

Validate at parse time:
- `name` non-empty.
- `version_constraint` non-empty (full constraint validation in C.8).
- If `probe` is present: `args` is a list of strings (may be
  empty? — reject empty; require ≥1 arg, defaulting omitted ⇒
  default args, not empty args).
- If `install_hints` is present: each value non-empty.
- No duplicate `name`s within a single manifest's `host_tools`.

Defaults the parser fills in:
- Missing `probe`: `args = ["--version"]`,
  `version_regex = r"(\d+\.\d+(?:\.\d+)?)"`.
- Missing `install_hints`: empty map.

**Step 1: Add types**

In `xtask/src/deps_manifest.rs`:

```rust
/// One entry in a manifest's `[[host_tools]]` array. Inline
/// declaration on the consumer site — no separate registry entry,
/// per design 10.
///
/// Probe and install_hints are optional in TOML; the parser fills
/// in defaults so the rest of the resolver always sees a complete
/// `HostToolDecl`.
#[derive(Debug, Clone)]
pub struct HostToolDecl {
    pub name: String,
    pub version_constraint: String,
    pub probe: HostToolProbe,
    pub install_hints: BTreeMap<String, String>,
}

#[derive(Debug, Clone)]
pub struct HostToolProbe {
    pub args: Vec<String>,
    pub version_regex: String,
}

impl Default for HostToolProbe {
    fn default() -> Self {
        Self {
            args: vec!["--version".to_string()],
            version_regex: r"(\d+\.\d+(?:\.\d+)?)".to_string(),
        }
    }
}

#[derive(Debug, Deserialize)]
struct RawHostTool {
    name: String,
    version_constraint: String,
    #[serde(default)]
    probe: Option<RawHostToolProbe>,
    #[serde(default)]
    install_hints: Option<BTreeMap<String, String>>,
}

#[derive(Debug, Deserialize)]
struct RawHostToolProbe {
    args: Option<Vec<String>>,
    version_regex: Option<String>,
}
```

Add `pub host_tools: Vec<HostToolDecl>` field to `DepsManifest`
(default empty).

Add to `Raw`:

```rust
#[serde(default)]
host_tools: Vec<RawHostTool>,
```

**Step 2: Validate in `validate_common`**

```rust
let mut host_tools: Vec<HostToolDecl> = Vec::with_capacity(raw.host_tools.len());
let mut seen_names: BTreeSet<String> = BTreeSet::new();
for (idx, raw_t) in raw.host_tools.into_iter().enumerate() {
    if raw_t.name.is_empty() {
        return Err(format!("[[host_tools]][{idx}].name must not be empty"));
    }
    if !seen_names.insert(raw_t.name.clone()) {
        return Err(format!(
            "[[host_tools]] declares {:?} twice in this manifest",
            raw_t.name
        ));
    }
    if raw_t.version_constraint.is_empty() {
        return Err(format!(
            "[[host_tools]][{idx}] {:?}: version_constraint must not be empty",
            raw_t.name
        ));
    }
    let probe = match raw_t.probe {
        None => HostToolProbe::default(),
        Some(p) => {
            let args = match p.args {
                Some(a) if a.is_empty() => return Err(format!(
                    "[[host_tools]][{idx}] {:?}: probe.args must be non-empty when given",
                    raw_t.name
                )),
                Some(a) => a,
                None => HostToolProbe::default().args,
            };
            let version_regex = p.version_regex
                .unwrap_or_else(|| HostToolProbe::default().version_regex);
            HostToolProbe { args, version_regex }
        }
    };
    let install_hints = raw_t.install_hints.unwrap_or_default();
    for (k, v) in &install_hints {
        if k.is_empty() || v.is_empty() {
            return Err(format!(
                "[[host_tools]][{idx}] {:?}: install_hints entries must have non-empty key and value",
                raw_t.name
            ));
        }
    }
    host_tools.push(HostToolDecl {
        name: raw_t.name,
        version_constraint: raw_t.version_constraint,
        probe,
        install_hints,
    });
}
```

Pass `host_tools` into the constructed `DepsManifest`.

**Step 3: Tests**

Add to `mod tests` in `deps_manifest.rs`:

```rust
const LIB_WITH_HOST_TOOLS: &str = r#"
kind = "library"
name = "zlib"
version = "1.3.1"
revision = 1

[source]
url = "https://example.test/zlib-1.3.1.tar.gz"
sha256 = "0000000000000000000000000000000000000000000000000000000000000000"

[license]
spdx = "Zlib"

[outputs]
libs = ["lib/libz.a"]

[[host_tools]]
name = "make"
version_constraint = ">=4.0"

[[host_tools]]
name = "cmake"
version_constraint = ">=3.20"
probe = { args = ["--version"], version_regex = "cmake version (\\d+\\.\\d+(?:\\.\\d+)?)" }
install_hints = { darwin = "brew install cmake", linux = "apt install cmake" }
"#;

#[test]
fn parses_host_tools_with_defaults() {
    let m = DepsManifest::parse(LIB_WITH_HOST_TOOLS, PathBuf::from("/x")).unwrap();
    assert_eq!(m.host_tools.len(), 2);
    assert_eq!(m.host_tools[0].name, "make");
    // make has no explicit probe → uses defaults.
    assert_eq!(m.host_tools[0].probe.args, vec!["--version"]);
    assert!(m.host_tools[0].install_hints.is_empty());

    // cmake has explicit probe + hints.
    assert_eq!(m.host_tools[1].name, "cmake");
    assert!(m.host_tools[1].probe.version_regex.starts_with("cmake version"));
    assert_eq!(
        m.host_tools[1].install_hints.get("darwin").map(String::as_str),
        Some("brew install cmake")
    );
}

#[test]
fn host_tools_reject_duplicate_names_in_same_manifest() {
    let bad = LIB_WITH_HOST_TOOLS.replace("name = \"cmake\"", "name = \"make\"");
    let err = DepsManifest::parse(&bad, PathBuf::from("/x")).unwrap_err();
    assert!(err.contains("twice"), "got: {err}");
}

#[test]
fn host_tools_allowed_on_source_kind() {
    let text = r#"
kind = "source"
name = "pcre2-source"
version = "10.42"
revision = 1

[source]
url = "https://example.test/pcre2.tar.bz2"
sha256 = "0000000000000000000000000000000000000000000000000000000000000000"

[license]
spdx = "BSD-3-Clause"

[[host_tools]]
name = "patch"
version_constraint = ">=2.7"
"#;
    let m = DepsManifest::parse(text, PathBuf::from("/x")).unwrap();
    assert_eq!(m.host_tools.len(), 1);
    assert_eq!(m.host_tools[0].name, "patch");
}

#[test]
fn host_tools_reject_empty_probe_args() {
    let bad = r#"
kind = "library"
name = "x"
version = "1.0"
revision = 1
[source]
url = "https://example.test/x.tar.gz"
sha256 = "0000000000000000000000000000000000000000000000000000000000000000"
[license]
spdx = "MIT"
[outputs]
libs = []
[[host_tools]]
name = "cmake"
version_constraint = ">=3.0"
probe = { args = [], version_regex = "(\\d+\\.\\d+)" }
"#;
    let err = DepsManifest::parse(bad, PathBuf::from("/x")).unwrap_err();
    assert!(err.contains("probe.args"), "got: {err}");
}
```

Run; verify PASS.

**Step 4: Commit**

```bash
git add xtask/src/deps_manifest.rs
git commit -m "feat(xtask): parse [[host_tools]] array-of-tables on every manifest kind

Per design 10, host-tool requirements declare inline on the
consumer site. Each entry: required name + version_constraint;
optional probe (args + version_regex) with sensible defaults
('--version' + r'(\\d+\\.\\d+(?:\\.\\d+)?)'); optional install_hints
keyed by os name. Duplicate tool names within a single manifest
reject. Probe constraint validation lands in C.8; runner in C.9."
```

Reviewer cycle: yes — schema change.

---

### Task C.8: `version_constraint` parser (`>=X.Y[.Z]` only)

**Files:**
- Modify: `xtask/src/deps_manifest.rs` (or new submodule
  `host_tools.rs` if convenient — pick what reviewer prefers; the
  plan assumes inline for brevity).
- Tests.

**Goal:** Parse `version_constraint` strings into a structured
form. Supported syntax:
- `">=X.Y"` — at least major.minor, any patch.
- `">=X.Y.Z"` — at least major.minor.patch.

Reject:
- `">X..."`, `"<X..."`, `"==X..."`, `"^X..."`, `"~X..."`,
  `"=X.Y"`, `"X.Y"` (bare version), compound like `">=1.0,<2.0"`,
  prerelease/build suffixes (`>=1.0-rc1`, `>=1.0+build`).

Each rejection surface a "future-work" error message:

```
unsupported version_constraint operator in {tool_name}: "{value}"
(supported: >=X.Y or >=X.Y.Z; semver ranges and other operators
are deferred to future work — see docs/plans/2026-04-22-deps-management-v2-design.md
decision 11)
```

Comparison is numeric (`3.20 > 3.9`).

**Step 1: Add types + parser**

```rust
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VersionConstraint {
    pub min: Version,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct Version {
    pub major: u32,
    pub minor: u32,
    pub patch: Option<u32>,
}

impl Version {
    /// Parse a 2- or 3-component dotted-integer version. Rejects
    /// anything with prerelease or build suffixes.
    pub fn parse(s: &str) -> Result<Self, String> {
        if s.contains('-') || s.contains('+') {
            return Err(format!(
                "version {:?}: prerelease/build suffixes are not supported \
                 (V2 host-tools only accepts dotted-integer versions)",
                s
            ));
        }
        let parts: Vec<&str> = s.split('.').collect();
        if parts.len() < 2 || parts.len() > 3 {
            return Err(format!(
                "version {:?} must be X.Y or X.Y.Z (got {} components)",
                s, parts.len()
            ));
        }
        let major: u32 = parts[0].parse()
            .map_err(|_| format!("version {:?}: major must be unsigned int", s))?;
        let minor: u32 = parts[1].parse()
            .map_err(|_| format!("version {:?}: minor must be unsigned int", s))?;
        let patch = match parts.get(2) {
            Some(p) => Some(p.parse::<u32>().map_err(|_| {
                format!("version {:?}: patch must be unsigned int", s)
            })?),
            None => None,
        };
        Ok(Self { major, minor, patch })
    }
}

impl std::fmt::Display for Version {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self.patch {
            Some(p) => write!(f, "{}.{}.{}", self.major, self.minor, p),
            None => write!(f, "{}.{}", self.major, self.minor),
        }
    }
}

impl VersionConstraint {
    pub fn parse(s: &str, tool_name: &str) -> Result<Self, String> {
        let s = s.trim();
        if s.contains(',') {
            return Err(future_work_err(tool_name, s, "compound constraints"));
        }
        let rest = s.strip_prefix(">=").ok_or_else(|| {
            future_work_err(tool_name, s, "operator other than '>='")
        })?;
        // Reject leading whitespace AND trailing operators.
        if rest.starts_with(' ') || rest.contains(['<', '>', '=', '^', '~', ','][..]) {
            return Err(future_work_err(tool_name, s, "operator after '>='"));
        }
        let min = Version::parse(rest)
            .map_err(|e| format!("[[host_tools]] {}: {}", tool_name, e))?;
        Ok(Self { min })
    }

    /// `actual` satisfies `self` iff `actual >= self.min`. The
    /// comparison treats a missing patch component as 0:
    /// `>=3.20` accepts `3.20.0`, `3.21`, `3.20.5` but rejects `3.19`.
    pub fn satisfies(&self, actual: &Version) -> bool {
        let actual_norm = (actual.major, actual.minor, actual.patch.unwrap_or(0));
        let min_norm = (self.min.major, self.min.minor, self.min.patch.unwrap_or(0));
        actual_norm >= min_norm
    }
}

fn future_work_err(tool_name: &str, value: &str, kind: &str) -> String {
    format!(
        "unsupported version_constraint in [[host_tools]] {tool_name:?}: {value:?} \
         ({kind}; supported: >=X.Y or >=X.Y.Z — see \
         docs/plans/2026-04-22-deps-management-v2-design.md decision 11)"
    )
}
```

In `validate_common`, after parsing each `version_constraint`, run
`VersionConstraint::parse` on it; the `HostToolDecl.version_constraint`
field can keep the string form, but cache a parsed form via a
`pub fn parsed_constraint(&self) -> Result<VersionConstraint, String>`
helper — OR change the field to `pub version_constraint: VersionConstraint`
and store the parsed form. **Pick the second:** reject at parse
time so the runner in C.9 sees only valid constraints.

Update `HostToolDecl`:

```rust
pub struct HostToolDecl {
    pub name: String,
    pub version_constraint: VersionConstraint,
    pub probe: HostToolProbe,
    pub install_hints: BTreeMap<String, String>,
}
```

And in `validate_common`:

```rust
let version_constraint = VersionConstraint::parse(&raw_t.version_constraint, &raw_t.name)?;
```

(Update tests in C.7 to compare `version_constraint.min` rather
than the raw string.)

**Step 2: Tests**

```rust
#[test]
fn version_constraint_accepts_two_and_three_component() {
    let c2 = VersionConstraint::parse(">=3.20", "cmake").unwrap();
    assert_eq!(c2.min, Version { major: 3, minor: 20, patch: None });
    let c3 = VersionConstraint::parse(">=3.20.0", "cmake").unwrap();
    assert_eq!(c3.min, Version { major: 3, minor: 20, patch: Some(0) });
}

#[test]
fn version_constraint_compares_numerically_not_lexicographically() {
    let c = VersionConstraint::parse(">=3.9", "cmake").unwrap();
    assert!(c.satisfies(&Version::parse("3.20").unwrap()), "3.20 > 3.9 numerically");
    assert!(c.satisfies(&Version::parse("3.9.0").unwrap()));
    assert!(!c.satisfies(&Version::parse("3.8").unwrap()));
    let c310 = VersionConstraint::parse(">=3.10.5", "cmake").unwrap();
    assert!(c310.satisfies(&Version::parse("3.10.5").unwrap()));
    assert!(c310.satisfies(&Version::parse("3.11").unwrap()));
    assert!(!c310.satisfies(&Version::parse("3.10.4").unwrap()));
}

#[test]
fn version_constraint_rejects_other_operators() {
    for bad in [">3.20", "<3.20", "==3.20", "^3.20", "~3.20", "=3.20", "3.20"] {
        let err = VersionConstraint::parse(bad, "cmake").unwrap_err();
        assert!(
            err.contains("unsupported") && err.contains("future work"),
            "expected future-work error for {bad:?}, got: {err}"
        );
    }
}

#[test]
fn version_constraint_rejects_compound() {
    let err = VersionConstraint::parse(">=3.20,<4.0", "cmake").unwrap_err();
    assert!(err.contains("compound"), "got: {err}");
}

#[test]
fn version_constraint_rejects_prerelease_suffix() {
    let err = VersionConstraint::parse(">=3.20-rc1", "cmake").unwrap_err();
    assert!(err.contains("prerelease") || err.contains("suffix"), "got: {err}");
}
```

Run; verify PASS.

**Step 3: Commit**

```bash
git add xtask/src/deps_manifest.rs
git commit -m "feat(xtask): version_constraint parser — >=X.Y[.Z] only

Per design 11, version constraints accept exactly two operators:
'>=X.Y' (any X.Y patch) and '>=X.Y.Z' (specific lower bound).
Other operators (>, <, ==, ^, ~, =, bare versions, compound
'>=X.Y,<P.Q', prerelease '-rcN'/'+build' suffixes) reject at parse
time with a future-work error message naming the bad operator and
linking design decision 11.

Comparison is numeric — 3.20 > 3.9, never lexicographic — so a
'>=3.9' constraint accepts cmake 3.20."
```

Reviewer cycle: yes — schema parser, easy to introduce subtle bugs.

---

### Task C.9: Probe runner

**Files:**
- Create: `xtask/src/host_tool_probe.rs`.
- Modify: `xtask/src/main.rs` (declare module).
- Modify: `xtask/Cargo.toml` (add `regex = "1"`).
- Tests in `host_tool_probe.rs`.

**Goal:** Given a `HostToolDecl`, run its probe and return one of:
- `Ok(())` — the tool is present and version satisfies the constraint.
- `Err(ProbeFailure)` — the tool is missing, the probe failed
  to run, the version couldn't be extracted, or the version is
  too old.

The runner must:
1. Spawn `<name>` with `probe.args` (use the `name` field as the
   command — i.e. assume tools are in `PATH` under their declared
   name). On `Err`, return `Missing` failure.
2. Capture stdout (and stderr — some tools print version on
   stderr; merge them for matching). Parse with `regex` against
   `probe.version_regex`. On no match, return `BadOutput`.
3. Extract capture group 1, parse as `Version`. On parse fail,
   return `BadVersion`.
4. Compare against `version_constraint`. If unsatisfied, return
   `TooOld { actual, required }`.

Each failure case includes the tool name + relevant context.
The caller (`ensure_built` in C.10) is responsible for picking
the matching `install_hints` entry on failure.

**Step 1: Add regex dep**

`xtask/Cargo.toml`:
```toml
regex = "1"
```

**Step 2: Implement runner**

```rust
//! Host-tool presence + version probe runner.
//!
//! Invoked by the resolver before a consumer's build script runs.
//! Failure aborts the resolve and prints platform-keyed
//! `install_hints` to the user.

use std::process::Command;

use regex::Regex;

use crate::deps_manifest::{HostToolDecl, Version, VersionConstraint};

#[derive(Debug)]
pub enum ProbeFailure {
    /// Tool not found in PATH (Command::spawn failed).
    Missing { tool: String, reason: String },
    /// Tool ran but stdout/stderr did not match the version regex.
    BadOutput { tool: String, regex: String, output: String },
    /// Regex matched but the captured version did not parse.
    BadVersion { tool: String, captured: String, reason: String },
    /// Version parsed but is older than the constraint.
    TooOld { tool: String, actual: Version, required: VersionConstraint },
}

impl std::fmt::Display for ProbeFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Missing { tool, reason } => write!(
                f, "host-tool {:?} not found in PATH ({})", tool, reason),
            Self::BadOutput { tool, regex, output } => write!(
                f, "host-tool {:?}: probe output did not match regex {:?}\n--- stdout/stderr ---\n{}",
                tool, regex,
                if output.len() > 4096 { &output[..4096] } else { output }
            ),
            Self::BadVersion { tool, captured, reason } => write!(
                f, "host-tool {:?}: extracted version {:?} did not parse: {}",
                tool, captured, reason),
            Self::TooOld { tool, actual, required } => write!(
                f, "host-tool {:?}: version {} too old; require >={}",
                tool, actual, required.min),
        }
    }
}

/// Probe a single host-tool. Returns Ok on success; structured
/// error otherwise.
pub fn probe(decl: &HostToolDecl) -> Result<(), ProbeFailure> {
    let output = Command::new(&decl.name)
        .args(&decl.probe.args)
        .output()
        .map_err(|e| ProbeFailure::Missing {
            tool: decl.name.clone(),
            reason: format!("{e}"),
        })?;
    let mut combined = String::new();
    combined.push_str(&String::from_utf8_lossy(&output.stdout));
    combined.push('\n');
    combined.push_str(&String::from_utf8_lossy(&output.stderr));

    let re = Regex::new(&decl.probe.version_regex).map_err(|e| ProbeFailure::BadOutput {
        tool: decl.name.clone(),
        regex: decl.probe.version_regex.clone(),
        output: format!("invalid regex: {e}"),
    })?;
    let caps = re.captures(&combined).ok_or_else(|| ProbeFailure::BadOutput {
        tool: decl.name.clone(),
        regex: decl.probe.version_regex.clone(),
        output: combined.clone(),
    })?;
    let captured = caps
        .get(1)
        .ok_or_else(|| ProbeFailure::BadOutput {
            tool: decl.name.clone(),
            regex: decl.probe.version_regex.clone(),
            output: combined.clone(),
        })?
        .as_str();
    let actual = Version::parse(captured).map_err(|e| ProbeFailure::BadVersion {
        tool: decl.name.clone(),
        captured: captured.to_string(),
        reason: e,
    })?;
    if !decl.version_constraint.satisfies(&actual) {
        return Err(ProbeFailure::TooOld {
            tool: decl.name.clone(),
            actual,
            required: decl.version_constraint.clone(),
        });
    }
    Ok(())
}
```

Add `pub mod host_tool_probe;` in `xtask/src/main.rs`.

**Step 3: Tests using a synthetic tool**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::deps_manifest::HostToolProbe;
    use std::os::unix::fs::PermissionsExt;

    fn write_synthetic_tool(dir: &std::path::Path, name: &str, body: &str) -> std::path::PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, body).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    fn decl(name: &str, version_regex: &str, constraint: &str) -> HostToolDecl {
        HostToolDecl {
            name: name.to_string(),
            version_constraint: VersionConstraint::parse(constraint, name).unwrap(),
            probe: HostToolProbe {
                args: vec!["--version".to_string()],
                version_regex: version_regex.to_string(),
            },
            install_hints: Default::default(),
        }
    }

    #[test]
    fn probe_passes_when_version_meets_constraint() {
        let dir = tempfile::tempdir().unwrap();
        write_synthetic_tool(dir.path(), "fakecmake",
            "#!/bin/bash\necho 'cmake version 3.21.4'\n");
        // Prepend tempdir to PATH so the synthetic tool wins.
        let old_path = std::env::var("PATH").unwrap_or_default();
        std::env::set_var("PATH", format!("{}:{}", dir.path().display(), old_path));
        let result = probe(&decl(
            "fakecmake",
            r"cmake version (\d+\.\d+(?:\.\d+)?)",
            ">=3.20",
        ));
        std::env::set_var("PATH", old_path);
        assert!(result.is_ok(), "got: {:?}", result.err());
    }

    #[test]
    fn probe_rejects_old_version() {
        let dir = tempfile::tempdir().unwrap();
        write_synthetic_tool(dir.path(), "fakecmake2",
            "#!/bin/bash\necho 'cmake version 3.10.0'\n");
        let old_path = std::env::var("PATH").unwrap_or_default();
        std::env::set_var("PATH", format!("{}:{}", dir.path().display(), old_path));
        let err = probe(&decl(
            "fakecmake2",
            r"cmake version (\d+\.\d+(?:\.\d+)?)",
            ">=3.20",
        )).unwrap_err();
        std::env::set_var("PATH", old_path);
        assert!(matches!(err, ProbeFailure::TooOld { .. }), "got: {err}");
    }

    #[test]
    fn probe_reports_missing_when_not_in_path() {
        let err = probe(&decl(
            "this-tool-definitely-does-not-exist-anywhere",
            r"(\d+\.\d+)",
            ">=1.0",
        )).unwrap_err();
        assert!(matches!(err, ProbeFailure::Missing { .. }), "got: {err}");
    }

    #[test]
    fn probe_reports_bad_output_when_regex_does_not_match() {
        let dir = tempfile::tempdir().unwrap();
        write_synthetic_tool(dir.path(), "fakebadout",
            "#!/bin/bash\necho 'no version here'\n");
        let old_path = std::env::var("PATH").unwrap_or_default();
        std::env::set_var("PATH", format!("{}:{}", dir.path().display(), old_path));
        let err = probe(&decl(
            "fakebadout",
            r"cmake version (\d+\.\d+(?:\.\d+)?)",
            ">=3.20",
        )).unwrap_err();
        std::env::set_var("PATH", old_path);
        assert!(matches!(err, ProbeFailure::BadOutput { .. }), "got: {err}");
    }

    #[test]
    fn probe_compares_numerically_3_20_satisfies_3_9() {
        let dir = tempfile::tempdir().unwrap();
        write_synthetic_tool(dir.path(), "fakelexbeats",
            "#!/bin/bash\necho 'cmake version 3.20.0'\n");
        let old_path = std::env::var("PATH").unwrap_or_default();
        std::env::set_var("PATH", format!("{}:{}", dir.path().display(), old_path));
        let result = probe(&decl(
            "fakelexbeats",
            r"cmake version (\d+\.\d+(?:\.\d+)?)",
            ">=3.9",
        ));
        std::env::set_var("PATH", old_path);
        assert!(result.is_ok(), "3.20 must satisfy >=3.9 (numeric, not lexicographic)");
    }
}
```

**Step 4: Reviewer note** — `std::env::set_var` is process-global
(unsafe across threads). Tests in this module that mutate PATH
must be in the same module so cargo runs them serially within the
host_tool_probe binary, OR each test must use `serial_test` /
hold a global mutex. Simpler: tests run with `--test-threads=1`
on host, BUT cargo tests parallelize by default. To keep things
robust, use a `static MUTEX: Mutex<()> = Mutex::new(())` inside
the tests module and lock on each PATH-mutating test. Update the
test bodies accordingly:

```rust
static PATH_MUTEX: std::sync::Mutex<()> = std::sync::Mutex::new(());
// ... at the top of each PATH-mutating test:
let _g = PATH_MUTEX.lock().unwrap();
```

Run; verify PASS.

**Step 5: Commit**

```bash
git add xtask/Cargo.toml xtask/Cargo.lock xtask/src/host_tool_probe.rs xtask/src/main.rs
git commit -m "feat(xtask): host-tool probe runner

Probes a single HostToolDecl by spawning <name> with probe.args,
matching combined stdout+stderr against probe.version_regex,
parsing capture group 1 as a Version, and comparing against the
constraint. Returns structured ProbeFailure variants (Missing /
BadOutput / BadVersion / TooOld) for downstream error rendering.
Tests cover happy path, missing binary, regex non-match, and the
numeric-vs-lexicographic comparison gotcha (3.20 satisfies >=3.9)."
```

Reviewer cycle: yes — runs subprocesses, parses untrusted output.

---

### Task C.10: Integrate probe into `ensure_built`

**Files:**
- Modify: `xtask/src/build_deps.rs` (`ensure_built_inner`).
- Tests.

**Goal:** Before running ANY build script (whether
library/program build_into_cache or source-kind override), iterate
the consumer's `host_tools` and run each probe. If any fail,
collect ALL failures (don't short-circuit on the first) and
return a single error message that lists every failed tool with
its install hint for the current platform.

Run probes only when needed: if the cache hits, neither the build
script nor the probes run. The probe is a build-time check, not a
fetch-time check.

Host-tool refs do NOT contribute to `compute_sha` (already true —
the function never reads `target.host_tools`).

**Step 1: Add helper that renders failures**

```rust
fn render_probe_failures(target: &DepsManifest, failures: &[ProbeFailure]) -> String {
    use crate::deps_manifest::HostToolDecl;
    let mut out = String::new();
    out.push_str(&format!(
        "{}: {} host-tool requirement{} unsatisfied:\n",
        target.spec(),
        failures.len(),
        if failures.len() == 1 { "" } else { "s" }
    ));
    for f in failures {
        out.push_str(&format!("  - {f}\n"));
        // Look up the matching decl to render install hints.
        let tool_name = match f {
            ProbeFailure::Missing { tool, .. }
            | ProbeFailure::BadOutput { tool, .. }
            | ProbeFailure::BadVersion { tool, .. }
            | ProbeFailure::TooOld { tool, .. } => tool,
        };
        if let Some(decl) = target.host_tools.iter().find(|d: &&HostToolDecl| &d.name == tool_name) {
            let os = std::env::consts::OS;
            if let Some(hint) = decl.install_hints.get(os) {
                out.push_str(&format!("      install hint ({os}): {hint}\n"));
            } else if !decl.install_hints.is_empty() {
                let keys: Vec<&str> = decl.install_hints.keys().map(String::as_str).collect();
                out.push_str(&format!(
                    "      no {os} install hint; available platforms: [{}]\n",
                    keys.join(", ")
                ));
            }
        }
    }
    out
}
```

**Step 2: Call probes in `ensure_built_inner`**

Just before the cache-hit check OR just before any build/extract
work runs, but AFTER the cache-hit check (so a cached entry skips
probes entirely):

Move the existing `let canonical = ... ; if canonical.is_dir() {
return ... }` block up, and BELOW it add:

```rust
// Run host-tool probes before any work that might invoke a build
// script. Cache hits skip this — probes are only needed when we
// might actually invoke `bash build-<x>.sh`.
if !target.host_tools.is_empty() {
    let mut failures: Vec<ProbeFailure> = Vec::new();
    for decl in &target.host_tools {
        if let Err(e) = host_tool_probe::probe(decl) {
            failures.push(e);
        }
    }
    if !failures.is_empty() {
        return Err(render_probe_failures(target, &failures));
    }
}
```

Add `use crate::host_tool_probe::{self, ProbeFailure};` at the top
of `build_deps.rs`.

**Step 3: Test that a cache hit skips the probe**

Synthesize a manifest declaring a host-tool that does not exist;
pre-populate the cache directory; assert `ensure_built` returns the
cached path without running the probe.

```rust
#[test]
fn ensure_built_cache_hit_skips_host_tool_probes() {
    let dir = tempfile::tempdir().unwrap();
    let cache = dir.path().join("cache");

    // Manifest with a deliberately-missing host-tool.
    let manifest_text = r#"
kind = "library"
name = "fake"
version = "0.1"
revision = 1

[source]
url = "https://example.test/fake.tar.gz"
sha256 = "0000000000000000000000000000000000000000000000000000000000000000"

[license]
spdx = "MIT"

[outputs]
libs = ["lib/libfake.a"]

[[host_tools]]
name = "this-host-tool-does-not-exist"
version_constraint = ">=99.99"
"#;
    let m = DepsManifest::parse(manifest_text, dir.path().to_path_buf()).unwrap();

    let registry = Registry { roots: vec![] };
    // Pre-populate the canonical cache dir.
    let mut memo = BTreeMap::new();
    let mut chain = Vec::new();
    let sha = compute_sha(&m, &registry, TargetArch::Wasm32, 4, &mut memo, &mut chain).unwrap();
    let canonical = canonical_path(&cache, &m, TargetArch::Wasm32, &sha);
    std::fs::create_dir_all(canonical.join("lib")).unwrap();
    std::fs::write(canonical.join("lib/libfake.a"), b"").unwrap();

    let opts = ResolveOpts { cache_root: &cache, local_libs: None };
    let path = ensure_built(&m, &registry, TargetArch::Wasm32, 4, &opts).unwrap();
    assert_eq!(path, canonical);
}

#[test]
fn ensure_built_cache_miss_aborts_when_host_tool_missing() {
    let dir = tempfile::tempdir().unwrap();
    let cache = dir.path().join("cache");

    let manifest_dir = dir.path().join("manifest");
    std::fs::create_dir_all(&manifest_dir).unwrap();
    let script = manifest_dir.join("build-fake.sh");
    std::fs::write(&script, "#!/bin/bash\nexit 0\n").unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();

    let manifest_text = r#"
kind = "library"
name = "fake"
version = "0.1"
revision = 1

[source]
url = "https://example.test/fake.tar.gz"
sha256 = "0000000000000000000000000000000000000000000000000000000000000000"

[license]
spdx = "MIT"

[outputs]
libs = []

[[host_tools]]
name = "this-host-tool-does-not-exist"
version_constraint = ">=99.99"
install_hints = { darwin = "brew install nope", linux = "apt install nope" }
"#;
    let m = DepsManifest::parse(manifest_text, manifest_dir).unwrap();

    let registry = Registry { roots: vec![] };
    let opts = ResolveOpts { cache_root: &cache, local_libs: None };
    let err = ensure_built(&m, &registry, TargetArch::Wasm32, 4, &opts).unwrap_err();
    assert!(err.contains("host-tool"), "got: {err}");
    assert!(err.contains("this-host-tool-does-not-exist"), "got: {err}");
    // Should mention the matching install hint OR list available platforms.
    let os = std::env::consts::OS;
    if matches!(os, "darwin" | "linux") {
        assert!(err.contains("install hint"), "got: {err}");
    }
}
```

Run; verify PASS.

**Step 4: Commit**

```bash
git add xtask/src/build_deps.rs
git commit -m "feat(xtask): integrate host-tool probe into ensure_built

Probes run AFTER the cache-hit check (cached entries skip the
probe) and BEFORE any source-extract or build-script invocation.
All probes for a manifest run before reporting; failures aggregate
into a single multi-tool error so users fix everything in one
round-trip. Each failure renders the platform-keyed install_hint
(matched on cfg!(target_os)) or lists which platforms have hints
when no match is found.

Host-tool refs continue to be excluded from cache-key shas per
design 10."
```

Reviewer cycle: yes — failure-rendering UX matters.

---

### Task C.11: `xtask build-deps check` subcommand

**Files:**
- Modify: `xtask/src/build_deps.rs` (`run`, new `cmd_check`).
- Tests.

**Goal:** Walk the registry. For every host-tool name appearing
in any manifest, group all `(consumer_name, decl)` pairs and
report when consumers declare:
- Different `version_constraint` for the same tool.
- Different `probe.args` or `probe.version_regex` for the same tool.

Acceptance: when no inconsistencies are found, exit 0 with no
output (or a one-line summary like `host-tool consistency: 12
tool(s) across N consumers — OK`). On any inconsistency, exit
non-zero, print every offending group.

Future cycle/unused-manifest checks are out of scope for this PR.

**Step 1: Add the subcommand wiring**

In `run`:
```rust
match sub.as_str() {
    "parse" => cmd_parse(&manifest),
    "sha" => cmd_sha(&manifest, &registry, arch),
    "path" => cmd_path(&manifest, &registry, arch),
    "resolve" => cmd_resolve(&manifest, &registry, &repo, arch),
    "check" => cmd_check(&registry),  // NEW
    other => Err(format!("build-deps: unknown subcommand {other:?}")),
}
```

`check` doesn't take a `<name|path>` target; rework `run` to make
the `target` argument optional and skip `load_target` for the
check subcommand. Concretely: replace the bareword:

```rust
let target = it.next();
let extra = it.next();
if extra.is_some() {
    return Err(format!("build-deps {sub}: unexpected extra args"));
}
match sub.as_str() {
    "check" => {
        if target.is_some() {
            return Err("build-deps check: takes no arguments".into());
        }
        cmd_check(&registry)
    }
    _ => {
        let target = target.ok_or_else(|| {
            format!("build-deps {sub}: missing <name|path>")
        })?;
        let manifest = load_target(&target, &registry)?;
        match sub.as_str() {
            "parse" => cmd_parse(&manifest),
            "sha" => cmd_sha(&manifest, &registry, arch),
            "path" => cmd_path(&manifest, &registry, arch),
            "resolve" => cmd_resolve(&manifest, &registry, &repo, arch),
            other => Err(format!("build-deps: unknown subcommand {other:?}")),
        }
    }
}
```

**Step 2: Implement cmd_check**

```rust
fn cmd_check(registry: &Registry) -> Result<(), String> {
    let manifests = registry.walk_all()?;

    // Group: tool_name → Vec<(consumer_name, &HostToolDecl)>.
    let mut by_tool: BTreeMap<String, Vec<(String, &HostToolDecl)>> = BTreeMap::new();
    for (cname, m) in &manifests {
        for decl in &m.host_tools {
            by_tool
                .entry(decl.name.clone())
                .or_default()
                .push((cname.clone(), decl));
        }
    }

    let mut problems: Vec<String> = Vec::new();
    let mut tool_count = 0usize;
    let consumer_count = manifests
        .iter()
        .filter(|(_, m)| !m.host_tools.is_empty())
        .count();
    for (tool, group) in &by_tool {
        tool_count += 1;
        if group.len() < 2 {
            continue;
        }
        // Compare each entry against the first.
        let (first_consumer, first_decl) = &group[0];
        for (other_consumer, other_decl) in &group[1..] {
            if first_decl.version_constraint != other_decl.version_constraint {
                problems.push(format!(
                    "host-tool {tool:?}: inconsistent version_constraint\n  - {first_consumer}: >={}\n  - {other_consumer}: >={}",
                    first_decl.version_constraint.min,
                    other_decl.version_constraint.min,
                ));
            }
            // Probe: defaults are equal; explicit overrides differ
            // ⇒ inconsistency.
            if first_decl.probe.args != other_decl.probe.args
                || first_decl.probe.version_regex != other_decl.probe.version_regex
            {
                problems.push(format!(
                    "host-tool {tool:?}: inconsistent probe between {first_consumer} and {other_consumer}\n  - args:  {:?} vs {:?}\n  - regex: {:?} vs {:?}",
                    first_decl.probe.args, other_decl.probe.args,
                    first_decl.probe.version_regex, other_decl.probe.version_regex,
                ));
            }
        }
    }

    if !problems.is_empty() {
        let msg = problems.join("\n\n");
        return Err(format!("host-tool consistency check failed:\n\n{msg}"));
    }
    println!(
        "host-tool consistency: {tool_count} tool(s) across {consumer_count} consumer(s) — OK"
    );
    Ok(())
}
```

**Step 3: Add `PartialEq` to `VersionConstraint` + `Version`**

If not already (already added in C.8). Verify.

**Step 4: Tests**

```rust
#[test]
fn build_deps_check_passes_on_consistent_registry() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_path_buf();
    fs::create_dir_all(root.join("a")).unwrap();
    fs::create_dir_all(root.join("b")).unwrap();
    fs::write(root.join("a/deps.toml"), r#"
kind = "library"
name = "a"
version = "1.0"
revision = 1
[source]
url = "https://example.test/a.tar.gz"
sha256 = "0000000000000000000000000000000000000000000000000000000000000000"
[license]
spdx = "MIT"
[outputs]
libs = []
[[host_tools]]
name = "make"
version_constraint = ">=4.0"
"#).unwrap();
    fs::write(root.join("b/deps.toml"), r#"
kind = "library"
name = "b"
version = "1.0"
revision = 1
[source]
url = "https://example.test/b.tar.gz"
sha256 = "0000000000000000000000000000000000000000000000000000000000000000"
[license]
spdx = "MIT"
[outputs]
libs = []
[[host_tools]]
name = "make"
version_constraint = ">=4.0"
"#).unwrap();
    let registry = Registry { roots: vec![root] };
    cmd_check(&registry).unwrap();
}

#[test]
fn build_deps_check_flags_inconsistent_constraint() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_path_buf();
    fs::create_dir_all(root.join("a")).unwrap();
    fs::create_dir_all(root.join("b")).unwrap();
    fs::write(root.join("a/deps.toml"), r#"
kind = "library"
name = "a"
version = "1.0"
revision = 1
[source]
url = "https://example.test/a.tar.gz"
sha256 = "0000000000000000000000000000000000000000000000000000000000000000"
[license]
spdx = "MIT"
[outputs]
libs = []
[[host_tools]]
name = "cmake"
version_constraint = ">=3.20"
"#).unwrap();
    fs::write(root.join("b/deps.toml"), r#"
kind = "library"
name = "b"
version = "1.0"
revision = 1
[source]
url = "https://example.test/b.tar.gz"
sha256 = "0000000000000000000000000000000000000000000000000000000000000000"
[license]
spdx = "MIT"
[outputs]
libs = []
[[host_tools]]
name = "cmake"
version_constraint = ">=3.10"
"#).unwrap();
    let registry = Registry { roots: vec![root] };
    let err = cmd_check(&registry).unwrap_err();
    assert!(err.contains("cmake"), "got: {err}");
    assert!(err.contains("inconsistent"), "got: {err}");
}

#[test]
fn build_deps_check_flags_inconsistent_probe() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_path_buf();
    fs::create_dir_all(root.join("a")).unwrap();
    fs::create_dir_all(root.join("b")).unwrap();
    fs::write(root.join("a/deps.toml"), r#"
kind = "library"
name = "a"
version = "1.0"
revision = 1
[source]
url = "https://example.test/a.tar.gz"
sha256 = "0000000000000000000000000000000000000000000000000000000000000000"
[license]
spdx = "MIT"
[outputs]
libs = []
[[host_tools]]
name = "make"
version_constraint = ">=4.0"
probe = { args = ["--version"], version_regex = "GNU Make (\\d+\\.\\d+)" }
"#).unwrap();
    fs::write(root.join("b/deps.toml"), r#"
kind = "library"
name = "b"
version = "1.0"
revision = 1
[source]
url = "https://example.test/b.tar.gz"
sha256 = "0000000000000000000000000000000000000000000000000000000000000000"
[license]
spdx = "MIT"
[outputs]
libs = []
[[host_tools]]
name = "make"
version_constraint = ">=4.0"
probe = { args = ["-v"], version_regex = "(\\d+\\.\\d+)" }
"#).unwrap();
    let registry = Registry { roots: vec![root] };
    let err = cmd_check(&registry).unwrap_err();
    assert!(err.contains("probe"), "got: {err}");
}
```

Run; verify PASS.

**Step 5: Commit**

```bash
git add xtask/src/build_deps.rs
git commit -m "feat(xtask): build-deps check — host-tool consistency lint

Walks the registry, groups [[host_tools]] declarations by name
across all consumers, and reports an error when consumers declare
different version_constraints or different probe args/regex for
the same tool name. Exits 0 on success with a one-line summary;
non-zero with every offending group on failure.

Probe-default consumers (no explicit [probe] block) compare equal
because defaults are normalized at parse time, so a mix of
explicit-default and implicit-default declarations passes the
check."
```

Reviewer cycle: yes — new subcommand UX, edge cases around
defaults vs explicit overrides matter.

---

### Task C.12: Documentation updates

**Files:**
- Modify: `docs/dependency-management.md` — add a "kind = source"
  section + "host_tools" section. Keep V1 prose as-is for now;
  Chunk F's capstone will rewrite the doc to V2 throughout.
- Modify: `xtask/README.md` if it exists; otherwise create with a
  one-paragraph note about the host-target requirement.

**Goal:** New schema features documented at the level Chunk A and
B did. Don't rewrite the whole V1 doc — that's Chunk F. Just add
sections that explain `kind = "source"` (when to use, what the
default fetch+extract does, when to declare `[build].script`) and
`[[host_tools]]` (probe defaults, install_hints platform keys,
cache-key impact = none).

**Step 1: Read existing doc**

```bash
ls docs/dependency-management.md
wc -l docs/dependency-management.md
```

Read what's there now.

**Step 2: Append two sections**

Add a `## Source-kind manifests` section after the
existing kind-discriminator material. Cover:
- When to use (consumer-specific sub-builds: PCRE2 inside MariaDB,
  PHP extensions, Erlang vendored code).
- Schema fields (link to design doc).
- Default fetch+extract behavior + URL-extension format detection
  + single-top-level-flatten rule.
- Override `[build].script` + the env-var contract.
- Cache layout (no arch segment; arch- and ABI-agnostic).
- Direct deps export `_SRC_DIR` (not `_DIR`).

Add a `## Host-tool requirements` section. Cover:
- Inline declaration shape (`[[host_tools]]`).
- Probe defaults (`--version` + `r"(\d+\.\d+(?:\.\d+)?)"`).
- Version-constraint syntax (`>=X.Y[.Z]` only; numeric comparison).
- `install_hints` platform keys (cfg!(target_os) values: `darwin`,
  `linux`, `windows`, etc.).
- Cache-key impact: zero (decision 10).
- `xtask build-deps check` lints cross-consumer consistency.

Reference `docs/plans/2026-04-22-deps-management-v2-design.md`
decisions 9 / 10 / 11 / 12 in both sections.

**Step 3: Commit**

```bash
git add docs/dependency-management.md
git commit -m "docs: deps-management — kind=source + [[host_tools]] sections

Add reader-level docs for the two new schema features Chunk C
introduces. Full V1→V2 doc rewrite is deferred to Chunk F."
```

(Trivial task — no reviewer cycle.)

---

### Task C.13: Gauntlet + open PR

**Step 1: Verify worktree state**

```bash
cd /Users/brandon/.superset/worktrees/wasm-posix-kernel/deps-cache-v1
git status -uno --short
git log --oneline de11c0866..HEAD
```

Pre-existing dirty files (the *-src directories under examples/libs)
are NOT staged; only the C.1–C.12 commits should appear in the
log range.

**Step 2: Run all 6 gates**

```bash
# Gate 1: cargo kernel
cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib

# Gate 2: xtask
cargo test -p xtask --target aarch64-apple-darwin

# Gate 3: vitest
cd host && npx vitest run; cd ..

# Gate 4: libc-test
scripts/run-libc-tests.sh

# Gate 5: POSIX
scripts/run-posix-tests.sh

# Gate 6 (a): sortix --all
scripts/run-sortix-tests.sh --all

# Gate 6 (b): ABI snapshot
bash scripts/check-abi-version.sh
```

Expected:
- Gate 1: 722+ pass / 0 fail.
- Gate 2: all xtask tests pass (count = Chunk B's 80 + new tests
  added in C.1–C.11).
- Gate 3: 250 pass / 108 skipped (Chunk B baseline).
- Gate 4: same as Chunk B baseline (1 pre-existing FAIL on
  `regression/daemon-failure`).
- Gate 5: 0 FAIL.
- Gate 6 (a): 4809 PASS / 0 FAIL / 18 XFAIL / 0 XPASS / 10
  pre-existing TIMEs.
- Gate 6 (b): exit 0.

If any gate fails: investigate. Do NOT mask regressions with
XFAILs / skips — chuck C is host-side tooling only and should
have zero kernel-suite delta.

**Step 3: Push branch + open PR**

```bash
git push -u origin deps-cache-v2-source-and-host-tools
```

PR template:

```bash
gh pr create \
  --base deps-cache-v2-program-migration \
  --title "deps-cache V2 chunk C: kind=source + inline [[host_tools]]" \
  --body "$(cat <<'EOF'
Stacked on PR #347 (Chunk B). DO NOT MERGE — held with the rest of
the V2 stack until Chunks D/E/F complete.

## Summary

Adds the third manifest kind (`source`) and the inline
`[[host_tools]]` array-of-tables on consumer manifests. Resolver
gains a default fetch+extract path for source-kind, an override
`[build].script` path with full env-var contract,
`WASM_POSIX_DEP_<NAME>_SRC_DIR` for source-kind direct deps, a
host-tool probe runner with platform-keyed install hints, and a
`xtask build-deps check` subcommand that lints cross-consumer
host-tool consistency.

Per design decisions 9 / 10 / 11 / 12 — see
`docs/plans/2026-04-22-deps-management-v2-design.md`.

## What's in this PR

| Task | Subject |
|------|---------|
| C.1  | Reject `[binary]` on `kind = "source"` |
| C.2  | Source-kind canonical path drops the arch segment |
| C.3  | Source-kind cache-key sha (separate domain, no arch/abi inputs) |
| C.4  | Default fetch+extract for source-kind without `[build].script` |
| C.5  | Override `[build].script` path uses standard env-var contract |
| C.6  | `WASM_POSIX_DEP_<NAME>_SRC_DIR` env var for direct source-kind deps |
| C.7  | `[[host_tools]]` array-of-tables parser |
| C.8  | `version_constraint` parser — `>=X.Y[.Z]` only |
| C.9  | Host-tool probe runner |
| C.10 | Probe integration into `ensure_built` (cache hits skip) |
| C.11 | `xtask build-deps check` host-tool consistency lint |
| C.12 | Docs: `kind = source` + `[[host_tools]]` sections |

## Out of scope (deferred)

- **Migrating any existing build script to use `kind = source`.**
  No consumer migrations land in this PR. Chunk D will migrate
  PHP / MariaDB / Erlang sub-builds once their consumer manifests
  are also touched.
- **Rewriting `docs/dependency-management.md` end-to-end** —
  Chunk F.
- **Auto-installing host tools** — non-goal per design 10.

## Gauntlet (6 gates) green

cargo kernel: 722 pass / 0 fail. xtask: <N> pass / 0 fail.
vitest: 250 pass / 108 skipped. libc-test: 298 PASS / 1
pre-existing FAIL (regression/daemon-failure) / 22 XFAIL /
0 XPASS. POSIX: 0 FAIL. sortix --all: 4809 PASS / 0 FAIL /
18 XFAIL / 0 XPASS / 10 pre-existing TIMEs. ABI snapshot in sync.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Print the PR URL when done. Do NOT request a merge; the user
holds all V2 PRs.

---

## Summary

Twelve tasks of incremental schema + resolver work followed by a
gauntlet step. Each task lands as one commit; commits 1–12 each
keep cargo green so the branch is bisectable. No consumer
migrations in this chunk — those land in Chunk D once the
schema and resolver plumbing is established.

## Plan complete
