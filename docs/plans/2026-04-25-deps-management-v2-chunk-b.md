# Wasm Dependency Management V2 — Chunk B (γ Migration)

> **For Claude:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development`
> to execute this plan task-by-task.

**Goal:** Retire `abi/program-metadata.toml` + `xtask/src/program_metadata.rs`.
Every shipped program migrates to its own per-dir
`examples/libs/<name>/deps.toml` with `kind = "program"`. Multi-output
programs use `[[outputs]]` array-of-tables. `bundle-program` and
`build-manifest` rewired to read the per-dir registry filtered by
`kind = "program"`.

**Architecture:** Reuse Chunk A's `DepsManifest`/`Registry` machinery —
add a sibling `Outputs` shape for programs (array-of-tables instead of
the library `[outputs]` table), plumb a kind-aware loader through
`bundle-program` + `build-manifest`. The registry walk replaces what
`load_program_metadata()` does today. Aliases in the V1 metadata table
(`sh→dash`, `python→cpython`, `tclsh→tcl`) are dropped: each consumer
demo already installs the real binary at the desired VFS path, so the
alias indirection in the package system is dead code.

**Tech Stack:** Rust (xtask), TOML (manifest schema), bash
(stage-release.sh).

**Design reference:** `docs/plans/2026-04-22-deps-management-v2-design.md`,
locked decisions 1, 3, 7, 8, 15. **Implementation predecessor:**
`docs/plans/2026-04-22-deps-management-v2-implementation.md` Chunk B
section.

**Stack base:** `deps-cache-v2-schema-foundation` @ `35c462e02` (PR #341).

**Branch:** `deps-cache-v2-program-migration`.

**Final PR base:** `deps-cache-v2-schema-foundation`. Do NOT merge — the
user is holding all V2 PRs until V2 is fully done.

---

## Acceptance criteria

- Every entry from `abi/program-metadata.toml` migrated to a per-dir
  `examples/libs/<name>/deps.toml` with `kind = "program"`. Each
  manifest includes `[source].sha256` (programs were git-ref-addressed
  in V1; V2 requires content-addressed sources).
- Multi-output programs use `[[outputs]]` array-of-tables. Single-output
  programs may use a length-1 array OR a single `[[outputs]]` block.
- `xtask/src/program_metadata.rs` and `abi/program-metadata.toml`
  deleted.
- `xtask::bundle_program::run` and `xtask::build_manifest::run` consume
  the per-dir registry filtered by `kind = "program"` instead of the
  central TOML.
- `xtask` unit tests pass: `cargo test -p xtask --target
  aarch64-apple-darwin` (host triple required per Chunk A — ureq TLS
  deps).
- Full 5-gate gauntlet green vs Chunk A baseline:
  1. `cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib`
  2. `cd host && npx vitest run`
  3. `scripts/run-libc-tests.sh` (no new FAILs vs A baseline; one
     pre-existing FAIL on `regression/daemon-failure`).
  4. `scripts/run-posix-tests.sh` (no new FAILs).
  5. `scripts/run-sortix-tests.sh --all` (no new FAILs, no XPASSes).
  6. `bash scripts/check-abi-version.sh` (exit 0).
- PR opened against `deps-cache-v2-schema-foundation`; not merged.

---

## How to execute

Use `superpowers:subagent-driven-development` to dispatch one fresh
subagent per task. Per the user's instructions:
- **Always Opus 4.6 for subagents** (`model: "opus"` on every Agent
  call).
- **Skip review cycles for trivial tasks** (manifest additions where the
  pattern is established). Use full implementer → spec-reviewer →
  code-quality-reviewer cycle for parser changes (B.1, B.2) and the
  bundle-program / build-manifest rewires (B.7, B.8, B.9).
- **One commit per task.** Use the suggested commit messages as a
  baseline; tweak for accuracy.
- **Do not push the branch until B.13 (the final PR-open task).**

---

## Task list

### Task B.0: Pre-flight — branch + sha256 inventory

**Branch already created** off `35c462e02` as
`deps-cache-v2-program-migration`. Confirm with:

```bash
cd /Users/brandon/.superset/worktrees/wasm-posix-kernel/deps-cache-v1
git log --oneline -1
# Expected: 35c462e02 feat: rename V1 curl manifest to libcurl
git rev-parse --abbrev-ref HEAD
# Expected: deps-cache-v2-program-migration
```

**sha256 inventory** — programs in `abi/program-metadata.toml` are
git-ref-addressed; V2 source manifests require `[source].sha256` in
hex. For each program, identify:
- The release tarball URL (or git-archive URL for tag commits).
- The sha256 of that archive.

Most programs already declare a tarball URL (FTP/HTTPS) in
`program-metadata.toml`. For these, `curl -sL <url> | shasum -a 256`
gives the sha. For git-ref entries (`git`, `vim`, `curl`, `lsof`,
`zstd`, `redis`, `erlang`, `quickjs`), use:

- GitHub: `https://github.com/<org>/<repo>/archive/refs/tags/<tag>.tar.gz`
- The script can be:
  ```bash
  url="https://github.com/git/git/archive/refs/tags/v2.47.1.tar.gz"
  curl -sL "$url" | shasum -a 256
  ```

**Step 1: Build a discovery scratch file**

Create `/tmp/program-shas.txt` with one line per program in the form:

```
<name>  <url>  <sha256>
```

This is a working file; not committed. Reference it in subsequent tasks
when writing per-dir deps.toml files.

**Step 2: Confirm baseline gauntlet passes pre-changes**

Run the 5 gates against the branch's current HEAD (= `35c462e02`):

```bash
cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib > /tmp/baseline-cargo.txt 2>&1
cd host && npx vitest run > /tmp/baseline-vitest.txt 2>&1; cd ..
bash scripts/run-libc-tests.sh > /tmp/baseline-libc.txt 2>&1
bash scripts/run-posix-tests.sh > /tmp/baseline-posix.txt 2>&1
bash scripts/run-sortix-tests.sh --all > /tmp/baseline-sortix.txt 2>&1
bash scripts/check-abi-version.sh > /tmp/baseline-abi.txt 2>&1
```

Save tail sections to compare against later. Document any pre-existing
failures (libc-test `regression/daemon-failure` is known per memory).

**No commit for B.0** — purely setup.

---

### Task B.1: Extend `DepsManifest` schema for `kind = "program"`

**Files:**
- Modify: `xtask/src/deps_manifest.rs`
- Test: `xtask/src/deps_manifest.rs` (existing `mod tests`)

**What changes:**

The existing `Outputs` struct uses field tables (`libs`, `headers`,
`pkgconfig`) — that's the library shape and stays as-is for
`kind = "library"`. Programs need a separate shape: an array-of-tables
with `name` + `wasm` per entry. They cannot share one struct without
making both kinds awkward, so we introduce:

```rust
#[derive(Debug, Clone, Deserialize)]
pub struct ProgramOutput {
    pub name: String,
    pub wasm: String,
}
```

The `outputs` field on `DepsManifest` stays as-is for libraries; we add
a new `program_outputs: Vec<ProgramOutput>` populated from
`[[outputs]]` only when `kind = "program"`. Library manifests with
`[[outputs]]` are rejected; program manifests with `[outputs]` (the
table form) are rejected.

Note on serde: in TOML, `[outputs]` as table and `[[outputs]]` as
array-of-tables share the *same* key. Serde can't transparently
disambiguate via `#[serde(untagged)]` because `Outputs` has all-default
fields (the empty table parses cleanly). So `Raw` keeps `outputs` as
`toml::Value` and we hand-decode in `validate_common` based on `kind`.

**Step 1: Write failing tests**

Append to the `mod tests` block in `xtask/src/deps_manifest.rs`:

```rust
const PROGRAM_EXAMPLE: &str = r#"
kind = "program"
name = "vim"
version = "9.1.0900"
revision = 1
depends_on = []

[source]
url = "https://github.com/vim/vim/archive/refs/tags/v9.1.0900.tar.gz"
sha256 = "0000000000000000000000000000000000000000000000000000000000000000"

[license]
spdx = "Vim"

[[outputs]]
name = "vim"
wasm = "vim.wasm"
"#;

#[test]
fn parses_minimal_program_manifest() {
    let m = DepsManifest::parse(PROGRAM_EXAMPLE, PathBuf::from("/x")).unwrap();
    assert!(matches!(m.kind, ManifestKind::Program));
    assert_eq!(m.program_outputs.len(), 1);
    assert_eq!(m.program_outputs[0].name, "vim");
    assert_eq!(m.program_outputs[0].wasm, "vim.wasm");
    // Library `outputs` should be empty for programs.
    assert!(m.outputs.libs.is_empty());
    assert!(m.outputs.headers.is_empty());
    assert!(m.outputs.pkgconfig.is_empty());
}

#[test]
fn parses_multi_output_program_manifest() {
    let text = r#"
kind = "program"
name = "git"
version = "2.47.1"
revision = 1
depends_on = []

[source]
url = "https://github.com/git/git/archive/refs/tags/v2.47.1.tar.gz"
sha256 = "0000000000000000000000000000000000000000000000000000000000000000"

[license]
spdx = "GPL-2.0-only"

[[outputs]]
name = "git"
wasm = "git.wasm"

[[outputs]]
name = "git-remote-http"
wasm = "git-remote-http.wasm"
"#;
    let m = DepsManifest::parse(text, PathBuf::from("/x")).unwrap();
    assert_eq!(m.program_outputs.len(), 2);
    assert_eq!(m.program_outputs[0].name, "git");
    assert_eq!(m.program_outputs[1].name, "git-remote-http");
}

#[test]
fn rejects_program_with_table_outputs() {
    let text = PROGRAM_EXAMPLE.replace(
        "[[outputs]]\nname = \"vim\"\nwasm = \"vim.wasm\"",
        "[outputs]\nlibs = [\"lib/libvim.a\"]",
    );
    let err = DepsManifest::parse(&text, PathBuf::from("/x")).unwrap_err();
    assert!(
        err.contains("kind = \"program\"") || err.contains("[[outputs]]"),
        "got: {err}"
    );
}

#[test]
fn rejects_library_with_array_outputs() {
    let text = format!(
        "{}\n[[outputs]]\nname = \"libz\"\nwasm = \"libz.wasm\"\n",
        EXAMPLE
    );
    let err = DepsManifest::parse(&text, PathBuf::from("/x")).unwrap_err();
    assert!(
        err.contains("kind = \"library\"") || err.contains("[outputs]"),
        "got: {err}"
    );
}

#[test]
fn rejects_program_with_no_outputs() {
    let text = r#"
kind = "program"
name = "vim"
version = "9.1.0900"
revision = 1
[source]
url = "https://example.test/vim.tar.gz"
sha256 = "0000000000000000000000000000000000000000000000000000000000000000"
[license]
spdx = "Vim"
"#;
    let err = DepsManifest::parse(text, PathBuf::from("/x")).unwrap_err();
    assert!(err.contains("at least one"), "got: {err}");
}

#[test]
fn rejects_program_output_with_empty_wasm() {
    let text = r#"
kind = "program"
name = "vim"
version = "9.1.0900"
revision = 1
[source]
url = "https://example.test/vim.tar.gz"
sha256 = "0000000000000000000000000000000000000000000000000000000000000000"
[license]
spdx = "Vim"
[[outputs]]
name = "vim"
wasm = ""
"#;
    let err = DepsManifest::parse(text, PathBuf::from("/x")).unwrap_err();
    assert!(err.contains("wasm"), "got: {err}");
}
```

**Step 2: Run tests; verify they fail**

```bash
cargo test -p xtask --target aarch64-apple-darwin --lib deps_manifest::tests::parses_minimal_program_manifest
```
Expected: compile error or runtime fail (`program_outputs` field missing).

**Step 3: Implement**

In `xtask/src/deps_manifest.rs`:

1. Add the `ProgramOutput` struct (above).
2. Change `Raw.outputs` from `Outputs` to `toml::Value`:
   ```rust
   #[serde(default)]
   outputs: toml::Value,  // table for library; array-of-tables for program
   ```
   (You'll need `toml` Cargo feature `value` if not already present; we
   already pull `toml` in.)
3. Add `pub program_outputs: Vec<ProgramOutput>` to `DepsManifest`.
4. In `validate_common`, after the existing checks, dispatch on
   `raw.kind`:
   - For `ManifestKind::Library`: accept either an empty `outputs`
     (default) or a TOML table; deserialize into the existing
     `Outputs`. Reject array-of-tables with:
     `"kind = \"library\" requires [outputs] (table); got an array of tables"`.
   - For `ManifestKind::Program`: accept only an array-of-tables.
     Deserialize each into `ProgramOutput`. Validate at least one
     entry exists; each entry's `wasm` is non-empty; each `name` is
     non-empty. Reject a table form with
     `"kind = \"program\" requires [[outputs]] (array of tables); got a table"`.
   - For `ManifestKind::Source`: skip outputs handling entirely (sources
     have no [outputs] / [[outputs]]; covered by Chunk C). Reject any
     non-empty outputs value with an explicit error.
5. Wire `program_outputs` through to the returned `DepsManifest`.

Allowed-as-empty: `outputs` may be the implicit-empty toml::Value
(which serde produces for missing keys). Treat `Value::Table(t) where
t.is_empty()` as "no outputs" for libraries (same behaviour as
today).

**Step 4: Run tests; verify they pass**

```bash
cargo test -p xtask --target aarch64-apple-darwin --lib deps_manifest::tests
```
Expected: all green, including the new program tests AND the existing
library tests (no regressions).

**Step 5: Commit**

```bash
git add xtask/src/deps_manifest.rs
git commit -m "feat: extend DepsManifest schema for kind=\"program\" with [[outputs]]

[[outputs]] array-of-tables: each entry has name + wasm. Library
manifests keep [outputs] table (libs/headers/pkgconfig); a mismatch
between kind and outputs shape is rejected at parse time."
```

**Spec review:** YES (parser change, schema-affecting).
**Code-quality review:** YES.

---

### Task B.2: Resolver path for `kind = "program"`

**Files:**
- Modify: `xtask/src/build_deps.rs` — `canonical_path`,
  `validate_outputs`.
- Test: `xtask/src/build_deps.rs` (existing test module).

**What changes:**

Programs cache under `<cache>/programs/...`, not `<cache>/libs/...`
(decision 6 in the design). Output validation walks
`m.program_outputs[*].wasm` instead of `m.outputs.{libs,headers}`.
Otherwise the build-and-install flow is identical: same env-var
contract, same atomic-rename pattern.

**Step 1: Failing tests**

Append to the test module in `build_deps.rs`:

```rust
#[test]
fn canonical_path_uses_programs_subdir_for_program_kind() {
    let m = DepsManifest::parse(
        r#"kind = "program"
name = "vim"
version = "9.1.0900"
revision = 1
[source]
url = "https://x.test/vim.tar.gz"
sha256 = "0000000000000000000000000000000000000000000000000000000000000000"
[license]
spdx = "Vim"
[[outputs]]
name = "vim"
wasm = "vim.wasm"
"#,
        PathBuf::from("/x"),
    ).unwrap();
    let sha = [0u8; 32];
    let p = canonical_path(Path::new("/cache"), &m, TargetArch::Wasm32, &sha);
    let s = p.to_string_lossy();
    assert!(s.contains("/programs/"), "got: {s}");
    assert!(s.contains("vim-9.1.0900-rev1-wasm32-"), "got: {s}");
}

#[test]
fn build_validates_program_wasm_outputs_present() {
    let root = tempdir("prog-out-pass");
    let cache = tempdir("prog-out-pass-cache");
    write_program(
        &root,
        "tinyprog",
        "0.1.0",
        &[],
        // Build script writes the declared wasm.
        r#"mkdir -p "$WASM_POSIX_DEP_OUT_DIR" && touch "$WASM_POSIX_DEP_OUT_DIR/tinyprog.wasm""#,
        &[("tinyprog", "tinyprog.wasm")],
    );
    let reg = Registry { roots: vec![root] };
    let m = reg.load("tinyprog").unwrap();
    ensure_built(&m, &reg, TargetArch::Wasm32, 4, &resolve_opts(&cache, None)).unwrap();
}

#[test]
fn build_fails_when_program_wasm_output_missing() {
    let root = tempdir("prog-out-miss");
    let cache = tempdir("prog-out-miss-cache");
    write_program(
        &root,
        "miss",
        "0.1.0",
        &[],
        // Build script does NOT produce miss.wasm.
        r#"mkdir -p "$WASM_POSIX_DEP_OUT_DIR""#,
        &[("miss", "miss.wasm")],
    );
    let reg = Registry { roots: vec![root] };
    let m = reg.load("miss").unwrap();
    let err = ensure_built(&m, &reg, TargetArch::Wasm32, 4, &resolve_opts(&cache, None)).unwrap_err();
    assert!(err.contains("miss.wasm"), "got: {err}");
}
```

The new `write_program` test helper mirrors `write_lib` but emits
`kind = "program"` + `[[outputs]]` blocks. Add it next to `write_lib`
in the test module:

```rust
#[cfg(test)]
fn write_program(
    root: &Path,
    name: &str,
    version: &str,
    deps: &[&str],
    build_script_body: &str,
    outputs: &[(&str, &str)],
) {
    let dir = root.join(name);
    fs::create_dir_all(&dir).unwrap();
    let depends_on = deps
        .iter()
        .map(|d| format!("\"{}\"", d))
        .collect::<Vec<_>>()
        .join(", ");
    let mut outputs_toml = String::new();
    for (n, w) in outputs {
        outputs_toml.push_str(&format!("[[outputs]]\nname = \"{n}\"\nwasm = \"{w}\"\n\n"));
    }
    fs::write(
        dir.join("deps.toml"),
        format!(
            r#"kind = "program"
name = "{name}"
version = "{version}"
revision = 1
depends_on = [{depends_on}]
[source]
url = "https://example.test/{name}.tar.gz"
sha256 = "0000000000000000000000000000000000000000000000000000000000000000"
[license]
spdx = "MIT"
{outputs_toml}"#,
        ),
    )
    .unwrap();
    fs::write(
        dir.join(format!("build-{name}.sh")),
        format!("#!/bin/bash\nset -e\n{build_script_body}\n"),
    )
    .unwrap();
}
```

**Step 2: Run; verify fail**

Tests fail to compile (no `write_program` helper) or fail at runtime.

**Step 3: Implement**

In `xtask/src/build_deps.rs`:

1. Modify `canonical_path` to dispatch on `m.kind`:
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
           // Source layout (no arch segment) is Chunk C.
       };
       cache_root.join(kind_subdir).join(format!(
           "{}-{}-rev{}-{}-{}",
           m.name, m.version, m.revision, arch.as_str(), &hex(sha)[..8]
       ))
   }
   ```
2. Modify `validate_outputs` to dispatch on kind:
   ```rust
   fn validate_outputs(target: &DepsManifest, out_dir: &Path) -> Result<(), String> {
       match target.kind {
           ManifestKind::Library => {
               // existing logic
               for rel in &target.outputs.libs { check(rel, "libs")?; }
               for rel in &target.outputs.headers { check(rel, "headers")?; }
               for rel in &target.outputs.pkgconfig { check(rel, "pkgconfig")?; }
           }
           ManifestKind::Program => {
               for out in &target.program_outputs {
                   let p = out_dir.join(&out.wasm);
                   if !p.exists() {
                       return Err(format!(
                           "{}: declared wasm output {:?} not produced by build script",
                           target.spec(), out.wasm
                       ));
                   }
               }
           }
           ManifestKind::Source => return Ok(()), // Chunk C
       }
       Ok(())
   }
   ```
3. Bring `ManifestKind` into scope at the top of `build_deps.rs` if not
   already.

The `compute_sha` and `ensure_built_inner` flows do NOT need to
change — the cache key is kind-agnostic for library + program (same
formula per design's cache-key sha section), and the resolution order
is identical.

`rewrite_install_prefix_paths` runs only on `lib/` and
`lib/pkgconfig/` directories — these don't exist for programs, so the
function is a no-op (its `read_dir` returns NotFound and silently
proceeds). No change needed.

**Step 4: Run; verify green**

```bash
cargo test -p xtask --target aarch64-apple-darwin
```

**Step 5: Commit**

```bash
git add xtask/src/build_deps.rs
git commit -m "feat: resolver kind=\"program\" path — programs/ subdir + wasm output validation

canonical_path dispatches on kind; validate_outputs walks
program_outputs[*].wasm. compute_sha and atomic-install flow are
kind-agnostic."
```

**Spec review:** YES (resolver behaviour change).
**Code-quality review:** YES.

---

### Task B.3: Migrate the test-program bundle to one `examples` manifest

**Files:**
- Create: `examples/libs/examples/deps.toml`

**What:**

Per design decision 8 (multi-output) + decision 7 (no aliases): the V1
`[examples]` canonical entry plus its 7 aliases (`exec-caller`,
`exec-child`, `fork-exec`, `ifhwaddr`, `mmap_shared_test`, `hello`,
`hello64`) collapse into a single program manifest with multiple
`[[outputs]]`. The "source" is the repo itself; the build script doesn't
fetch — it just delegates to `scripts/build-programs.sh`, which writes
the .wasm files to `local-binaries/programs/`. The deps.toml here is
purely metadata (release manifest entries) until Chunk E lifts it into
a real archive flow.

**Step 1: Determine source.sha256 strategy**

The "source" for in-repo programs is the repo itself. Chunk B doesn't
build them through the resolver (those builds happen via
`scripts/build-programs.sh`). The deps.toml exists for `bundle-program`
+ `build-manifest` to find `source` + `license` + `[[outputs]]` data.

Use a synthetic placeholder source URL pointing at a release tarball of
the repo — for now, the same kernel/userspace `[source].url`, with a
sha256 of `0` repeated 64 times if no real tarball exists. The
inventoried sha will be filled in by Chunk E when we cut a release.

Acceptable B-level placeholder:
```toml
[source]
url = "https://github.com/brandonpayton/wasm-posix-kernel"
sha256 = "0000000000000000000000000000000000000000000000000000000000000000"
```

This passes parse (64-char lowercase hex). The cache-key sha will
include this 0-string but no caching is invoked for `examples` outputs
(stage-release.sh feeds binaries directly to bundle-program). When
Chunk E switches to resolver-driven staging, the sha gets a real value.

**Step 2: Write the manifest**

```toml
kind = "program"
name = "examples"
version = "0.1.0"
revision = 1

[source]
url = "https://github.com/brandonpayton/wasm-posix-kernel"
sha256 = "0000000000000000000000000000000000000000000000000000000000000000"

[license]
spdx = "GPL-2.0-or-later"
url = "https://github.com/brandonpayton/wasm-posix-kernel/blob/main/COPYING"

[[outputs]]
name = "exec-caller"
wasm = "exec-caller.wasm"

[[outputs]]
name = "exec-child"
wasm = "exec-child.wasm"

[[outputs]]
name = "fork-exec"
wasm = "fork-exec.wasm"

[[outputs]]
name = "ifhwaddr"
wasm = "ifhwaddr.wasm"

[[outputs]]
name = "mmap_shared_test"
wasm = "mmap_shared_test.wasm"

[[outputs]]
name = "hello"
wasm = "hello.wasm"

[[outputs]]
name = "hello64"
wasm = "hello64.wasm"
```

**Step 3: Verify parse**

```bash
cargo run -p xtask --target aarch64-apple-darwin -- build-deps parse examples
```

Expected: prints normalised manifest with 7 outputs.

**Step 4: Commit**

```bash
git add examples/libs/examples/deps.toml
git commit -m "feat: add examples program manifest (7 outputs)

Replaces the V1 [examples] canonical entry plus its alias entries
(exec-caller, exec-child, fork-exec, ifhwaddr, mmap_shared_test,
hello, hello64) with a single multi-output manifest. Per design
decision 8 (multi-output) + 7 (no aliases)."
```

**Spec review:** NO (trivial manifest add following a defined pattern).
**Code-quality review:** NO.

---

### Task B.4: Migrate single-output ported programs (batch 1: GNU/coreutils-style)

**Files:** create one `examples/libs/<name>/deps.toml` per program in
the batch.

**Programs in this batch (from `abi/program-metadata.toml`):**
`bc`, `bzip2`, `coreutils`, `dash`, `file`, `gawk`, `grep`, `gzip`,
`less`, `m4`, `make`, `nano`, `sed`, `tar`, `xz`.

These are all simple FTP-tarball-addressed sources with single .wasm
output. Each manifest follows the template:

```toml
kind = "program"
name = "<name>"
version = "<from program-metadata>"
revision = 1

[source]
url = "<from program-metadata>"
sha256 = "<computed via curl|shasum -a 256>"

[license]
spdx = "<from program-metadata>"
url = "<from program-metadata>"

[[outputs]]
name = "<name>"
wasm = "<binary-name>.wasm"
```

The `wasm = "..."` field matches the basename of what
`scripts/stage-release.sh` passes via `--binary` today (e.g. `bc.wasm`,
`bzip2.wasm`). Most map name-to-name; check each against
`stage-release.sh` lines 100–160 to confirm. Most importantly, `dash`
produces `dash.wasm`.

**Step 1: For each program, compute sha256:**

```bash
url="https://ftp.gnu.org/gnu/grep/grep-3.11.tar.xz"
curl -sL "$url" | shasum -a 256 | awk '{print $1}'
```

Append the result to `/tmp/program-shas.txt`.

**Step 2: Write the manifest** at
`examples/libs/<name>/deps.toml`. Use the template above.

**Step 3: Verify parse** for each manifest:

```bash
cargo run -p xtask --target aarch64-apple-darwin -- build-deps parse <name>
```

**Step 4: Commit** (one commit per ~5 programs, or one big commit —
the manifests are independent and trivial; no harm batching):

```bash
git add examples/libs/{bc,bzip2,coreutils,dash,file,gawk,grep,gzip,less,m4,make,nano,sed,tar,xz}/deps.toml
git commit -m "feat: per-dir deps.toml for batch-1 single-output programs

15 manifests (bc, bzip2, coreutils, dash, file, gawk, grep, gzip,
less, m4, make, nano, sed, tar, xz). Each declares kind = \"program\"
+ [source].sha256 (newly content-addressed) + a single [[outputs]]
entry."
```

**Spec review:** NO (pattern-following manifest adds).
**Code-quality review:** NO.

---

### Task B.5: Migrate single-output ported programs (batch 2: language runtimes + odd-balls)

**Programs:**
`cpython`, `erlang`, `lsof`, `nginx`, `perl`, `quickjs`, `ruby`,
`sqlite-cli`, `tcl`, `vim`, `wget`, `wordpress`, `zip`, `zstd`, `zip`,
`unzip`.

Plus the `curl` PROGRAM (separate from the `libcurl` library
introduced in A.11): per design decision 15, the program lives at
`examples/libs/curl/` (dir is now empty after A.11's rename of the
library's contents to `examples/libs/libcurl/`). The program manifest
needs:

```toml
kind = "program"
name = "curl"
version = "8.10.1"
revision = 1

[source]
url = "https://github.com/curl/curl/archive/refs/tags/curl-8_10_1.tar.gz"
sha256 = "<computed>"

[license]
spdx = "curl"

[[outputs]]
name = "curl"
wasm = "curl.wasm"
```

For sqlite: the V2 program is `sqlite-cli` per design decision 15
("dual-output upstream sources... program suffixes -cli"). New dir:
`examples/libs/sqlite-cli/`. The library `examples/libs/sqlite/`
manifest is unchanged. Note: `stage-release.sh` line 145 today bundles
this as program `sqlite` — Task B.10 will switch it to `sqlite-cli`.

**Per-program notes:**

- `cpython` → wasm name `python.wasm` (per stage-release.sh:113).
  Output entry's `name` = `cpython`, `wasm` = `python.wasm`.
- `erlang` → `beam.wasm`.
- `lsof` is in `program-metadata.toml` but NOT bundled in
  `stage-release.sh`. It's used by the example wrapper. Include it for
  completeness; output is `lsof.wasm`.
- `nginx` → currently bundled with version `1.24.0` in
  stage-release.sh:117 (NOT `1.27.0` as in program-metadata.toml).
  Use `1.27.0` per program-metadata.toml — the stage-release.sh
  number was likely stale. Output is `nginx.wasm`.
- `tcl` → output `tclsh.wasm` per stage-release.sh:151.
- `wordpress` → not a wasm program; it's a VFS bundle. Skip the
  program manifest for wordpress — it's a composite under a separate
  flow (see B.7 below).
- `zstd` → output `zstd.wasm`.

**Step 1: Compute sha256 for each new tarball.**

**Step 2: Write each manifest** following the template from B.4.

**Step 3: Verify parse for each.**

**Step 4: Commit:**

```bash
git add examples/libs/{cpython,erlang,lsof,nginx,perl,quickjs,ruby,sqlite-cli,tcl,vim,wget,zip,unzip,zstd,curl}/deps.toml
git commit -m "feat: per-dir deps.toml for batch-2 single-output programs

curl (program; library is libcurl per A.11), cpython (python.wasm),
erlang (beam.wasm), lsof, nginx, perl, quickjs, ruby, sqlite-cli
(sqlite3.wasm — program; library remains sqlite per design 15), tcl
(tclsh.wasm), vim, wget, zip, unzip, zstd."
```

**Spec review:** NO.
**Code-quality review:** NO.

---

### Task B.6: Migrate multi-output ported programs

**Programs needing `[[outputs]]` arrays (per stage-release.sh):**
- `git` → `git.wasm` + `git-remote-http.wasm`
- `php` → `php.wasm` + `php-fpm.wasm`
- `diffutils` → `diff.wasm` + `cmp.wasm` + `diff3.wasm` + `sdiff.wasm`
- `findutils` → `find.wasm` + `xargs.wasm`
- `redis` → `redis-server.wasm` + `redis-cli.wasm`
- `mariadb` → `mariadbd.wasm` + `mysqltest.wasm`

**Step 1: Compute sha256 for each base tarball.**

**Step 2: Write each manifest** with multiple `[[outputs]]` entries.

Example for `git`:

```toml
kind = "program"
name = "git"
version = "2.47.1"
revision = 1

[source]
url = "https://github.com/git/git/archive/refs/tags/v2.47.1.tar.gz"
sha256 = "<computed>"

[license]
spdx = "GPL-2.0-only"
url = "https://github.com/git/git/blob/v2.47.1/COPYING"

[[outputs]]
name = "git"
wasm = "git.wasm"

[[outputs]]
name = "git-remote-http"
wasm = "git-remote-http.wasm"
```

**Step 3: Verify each parses with N outputs:**

```bash
cargo run -p xtask --target aarch64-apple-darwin -- build-deps parse git
# Expect: outputs lists git + git-remote-http
```

**Step 4: Commit:**

```bash
git add examples/libs/{git,php,diffutils,findutils,redis,mariadb}/deps.toml
git commit -m "feat: per-dir deps.toml for multi-output programs

git (2 outputs), php (php + php-fpm), diffutils (4), findutils (2),
redis (2), mariadb (2). [[outputs]] array-of-tables per design
decision 8."
```

**Spec review:** NO.
**Code-quality review:** NO.

---

### Task B.7: Migrate composite-VFS-image entries (kernel, userspace, shell, lamp, node, wordpress)

**Files:** create per-dir manifests for the V1 `[kernel]`, `[userspace]`,
`[shell]`, `[lamp]`, `[node]`, `[wordpress]` entries.

**Tension to resolve:** these aren't ported programs in the upstream
sense. Kernel + userspace are in-repo Rust crates that compile to
single .wasm files. shell/lamp/node/wordpress are VFS bundles assembled
by demo build scripts. They appear in the V1 `program-metadata.toml`
because `bundle-program` + `build-manifest` need source+license data
for their staged output entries.

**Path:** keep them as `kind = "program"` manifests; the build script
in each manifest is a no-op (or omitted) and the resolver isn't
invoked for them. They exist purely so `bundle-program` can satisfy
its lookup for source+license metadata. Output names match what
stage-release ships.

Example `examples/libs/kernel/deps.toml`:

```toml
kind = "program"
name = "kernel"
version = "0.1.0"
revision = 1

[source]
url = "https://github.com/brandonpayton/wasm-posix-kernel"
sha256 = "0000000000000000000000000000000000000000000000000000000000000000"

[license]
spdx = "GPL-2.0-or-later"
url = "https://github.com/brandonpayton/wasm-posix-kernel/blob/main/COPYING"

[[outputs]]
name = "kernel"
wasm = "wasm_posix_kernel.wasm"
```

The placeholder sha256 is documented in B.3 — same rationale.

**Wordpress:** licensed `GPL-2.0-or-later`, output name "wordpress".
The `wasm` value is moot (it's a VFS image, not a wasm), but the
schema requires it to be non-empty. Use `wordpress.vfs.zst` to match
the convention build-manifest already understands (see
`xtask/src/build_manifest.rs:261` — `.vfs.zst` is a recognised
multi-extension).

Verify each entry against `stage-release.sh` to confirm exact
filename conventions; adjust `wasm` accordingly.

**Step 1: Write 6 manifests:**

- `examples/libs/kernel/deps.toml` (output `wasm_posix_kernel.wasm`)
- `examples/libs/userspace/deps.toml` (output `wasm_posix_userspace.wasm`)
- `examples/libs/shell/deps.toml` (output `shell.vfs.zst`)
- `examples/libs/lamp/deps.toml` (output `lamp.vfs.zst`)
- `examples/libs/node/deps.toml` (output `node.wasm` — see
  program-metadata.toml: it's QuickJS-NG with bootstrap, runtime is
  wasm.)
- `examples/libs/wordpress/deps.toml` (output `wordpress.vfs.zst`)

**Step 2: Verify each parses.**

**Step 3: Commit:**

```bash
git add examples/libs/{kernel,userspace,shell,lamp,node,wordpress}/deps.toml
git commit -m "feat: per-dir deps.toml for kernel/userspace + composite VFS bundles

kernel, userspace, shell, lamp, node, wordpress as kind=\"program\"
manifests. These satisfy bundle-program's source+license lookup but
are not resolver-built — their .wasm/.vfs.zst outputs come from
in-repo Rust crates (kernel, userspace) or demo VFS builders
(shell/lamp/node/wordpress)."
```

**Spec review:** NO.
**Code-quality review:** NO.

---

### Task B.8: Drop sh/python/tclsh aliases — confirm VFS-builders already place real binaries

**Files:**
- Verify (no edits): `examples/browser/scripts/build-shell-vfs-image.ts`,
  `examples/browser/scripts/build-lamp-vfs-image.ts`,
  `examples/browser/scripts/build-mariadb-vfs-image.ts`,
  `examples/browser/scripts/build-wp-vfs-image.ts`.
- Modify: `scripts/stage-release.sh` — drop the `sh` bundle entry
  (lines 86–95: bundles dash.wasm under name `sh`).

**What:**

Per design decision 7 (no aliases in package system):
- `sh → dash`: VFS-builders already symlink `/bin/sh → /bin/dash`. No
  separate `sh.wasm` is needed at runtime; the V1 alias was purely a
  release-manifest convenience.
- `python → cpython`: already works because demos use `cpython.wasm`
  directly (e.g. `examples/browser/pages/python/main.ts:11`).
- `tclsh → tcl`: tcl's wasm is named `tclsh.wasm`; consumers already
  refer to it directly.

**Step 1: Confirm VFS-builders use real binaries.** Run grep:

```bash
grep -rn 'sh.wasm\|tclsh.wasm\|python.wasm\|cpython.wasm' examples/browser/ | grep -v node_modules
```

Already verified by the planning agent: shell/lamp/wordpress builders
use `dash.wasm` + symlink for `/bin/sh`. No code change needed here;
this step is documentation.

**Step 2: Drop the sh alias bundle from stage-release.sh:**

```bash
# In scripts/stage-release.sh, delete lines 86–95 (the `sh` bundle that
# republishes dash.wasm):
#
#     # sh is a copy of dash, separate asset under the sh program name.
#     # Treat it as a publish-time alias so stage-release doesn't require a
#     # separately-built sh.wasm file — we just republish dash under the
#     # sh name.
#     run_xtask bundle-program --plain-wasm \
#         --program sh \
#         --upstream-version 0.5.12 \
#         --revision 1 \
#         --binary examples/libs/dash/bin/dash.wasm \
#         --out-dir "$STAGING"
```

Use `Edit` with the exact block from the file.

**Step 3: Commit:**

```bash
git add scripts/stage-release.sh
git commit -m "feat: drop sh release bundle — VFS demos use dash.wasm directly

Per V2 design decision 7 (no aliases in package system). VFS
builders already symlink /bin/sh -> /bin/dash, so a separate sh.wasm
asset in the binaries release is redundant. python and tclsh aliases
have no release entries today; their VFS builders use cpython.wasm
and tclsh.wasm directly."
```

**Spec review:** NO (mechanical removal).
**Code-quality review:** NO.

---

### Task B.9: Add `Registry::all_programs()` + per-dir program-metadata loader

**Files:**
- Modify: `xtask/src/build_deps.rs` — extend `Registry` impl.
- Test: `xtask/src/build_deps.rs`.

**What:**

To replace `load_program_metadata()`, we need a way to walk the
registry and return every `kind = "program"` manifest. Then a thin
shim function `program_meta_by_name() -> BTreeMap<String, DepsManifest>`
gives `bundle-program` and `build-manifest` the data they need.

`Registry` already has `find` (single-name lookup). Add:

```rust
impl Registry {
    /// Walk every registry root non-recursively (one level deep —
    /// `<root>/<name>/deps.toml`); load each manifest. Returns
    /// `(name, manifest)` pairs in deterministic name order. Errors
    /// from individual manifests propagate (don't silently skip).
    pub fn walk_all(&self) -> Result<Vec<(String, DepsManifest)>, String> {
        let mut out: BTreeMap<String, DepsManifest> = BTreeMap::new();
        for root in &self.roots {
            let rd = match std::fs::read_dir(root) {
                Ok(r) => r,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(e) => return Err(format!("read_dir {}: {e}", root.display())),
            };
            for entry in rd {
                let entry = entry.map_err(|e| format!("read_dir entry: {e}"))?;
                let path = entry.path();
                let toml = path.join("deps.toml");
                if !toml.is_file() {
                    continue;
                }
                let m = DepsManifest::load(&toml)
                    .map_err(|e| format!("{}: {e}", toml.display()))?;
                // First-root-wins, mirrors `find()`.
                out.entry(m.name.clone()).or_insert(m);
            }
        }
        Ok(out.into_iter().collect())
    }
}
```

Then a public helper for the kind=program filter:

```rust
/// Subset of [`Registry::walk_all`] containing only `kind = "program"`
/// manifests. Useful for `bundle-program` + `build-manifest` to
/// compose source+license decoration without depending on the
/// soon-deleted `program_metadata` module.
pub fn programs_by_name(registry: &Registry) -> Result<BTreeMap<String, DepsManifest>, String> {
    Ok(registry
        .walk_all()?
        .into_iter()
        .filter(|(_, m)| matches!(m.kind, ManifestKind::Program))
        .collect())
}
```

**Step 1: Failing test**

```rust
#[test]
fn walk_all_finds_libraries_and_programs() {
    let root = tempdir("walk-all");
    write_lib(&root, "libL", "1.0.0", &[], "true", "[outputs]\nlibs = [\"lib/libL.a\"]\n");
    write_program(&root, "progP", "0.1.0", &[], "true", &[("progP", "progP.wasm")]);
    let reg = Registry { roots: vec![root] };
    let all = reg.walk_all().unwrap();
    let names: Vec<_> = all.iter().map(|(n, _)| n.clone()).collect();
    assert_eq!(names, vec!["libL".to_string(), "progP".to_string()]);
}

#[test]
fn programs_by_name_filters_to_program_kind() {
    let root = tempdir("progs-by-name");
    write_lib(&root, "libL", "1.0.0", &[], "true", "[outputs]\nlibs = [\"lib/libL.a\"]\n");
    write_program(&root, "progP", "0.1.0", &[], "true", &[("progP", "progP.wasm")]);
    let reg = Registry { roots: vec![root] };
    let progs = programs_by_name(&reg).unwrap();
    assert_eq!(progs.len(), 1);
    assert!(progs.contains_key("progP"));
}
```

**Step 2: Run; verify fail; implement; verify pass.**

**Step 3: Commit:**

```bash
git add xtask/src/build_deps.rs
git commit -m "feat: Registry::walk_all + programs_by_name for kind=\"program\" filter

Used by bundle-program + build-manifest in subsequent tasks to
replace abi/program-metadata.toml's central index. Walk is
non-recursive (one level under each registry root) and
deterministic (BTreeMap by name)."
```

**Spec review:** YES (registry surface change).
**Code-quality review:** YES.

---

### Task B.10: Rewire `bundle-program` to use per-dir registry

**Files:**
- Modify: `xtask/src/bundle_program.rs`.

**What:**

`bundle_program::run` currently calls `load_program_metadata()` to
validate that `--program <name>` exists in `abi/program-metadata.toml`.
Replace that with `programs_by_name(&Registry::from_env(&repo))`.
The check is the same: "is this name registered as a program?"; the
data shape change matters only when `build-manifest` decorates entries
(B.11).

**Step 1: Edit `xtask/src/bundle_program.rs`:**

Replace:

```rust
use crate::program_metadata::load_program_metadata;
// ...
let meta = load_program_metadata()?;
if !meta.contains_key(&program) {
    return Err(format!(
        "program {program:?} is not in abi/program-metadata.toml — \
         add an entry with source + license before bundling"
    ));
}
```

With:

```rust
use crate::build_deps::{programs_by_name, Registry};
use crate::repo_root;
// ...
let registry = Registry::from_env(&repo_root());
let progs = programs_by_name(&registry)?;
if !progs.contains_key(&program) {
    return Err(format!(
        "program {program:?} has no examples/libs/{program}/deps.toml \
         with kind = \"program\" — add a manifest before bundling"
    ));
}
```

**Step 2: Run xtask tests** (should still pass — no functional change
beyond the lookup source):

```bash
cargo test -p xtask --target aarch64-apple-darwin
```

**Step 3: Manual smoke test:**

```bash
mkdir -p /tmp/bundle-smoke
cargo run -p xtask --target aarch64-apple-darwin -- bundle-program \
    --plain-wasm --program dash --upstream-version 0.5.12 --revision 1 \
    --binary examples/libs/dash/bin/dash.wasm \
    --out-dir /tmp/bundle-smoke
ls /tmp/bundle-smoke/
# Expected: dash-0.5.12-rev1-<hash>.wasm
```

If `examples/libs/dash/bin/dash.wasm` doesn't exist on this branch,
substitute any built wasm; the test is whether the lookup succeeds, not
whether the binary is real.

**Step 4: Commit:**

```bash
git add xtask/src/bundle_program.rs
git commit -m "feat: bundle-program reads kind=\"program\" manifests from per-dir registry

Replaces load_program_metadata() with programs_by_name(). The check
shape is unchanged — \"is this name registered as a program?\" —
but the source of truth is now examples/libs/<name>/deps.toml
instead of abi/program-metadata.toml."
```

**Spec review:** YES (CLI tool's data source change).
**Code-quality review:** YES.

---

### Task B.11: Rewire `build-manifest` to decorate entries from per-dir registry

**Files:**
- Modify: `xtask/src/build_manifest.rs`.

**What:**

`build_manifest::run` calls `load_program_metadata()` to get a
`BTreeMap<String, ProgramMetadata>` for source+license decoration.
Replace with `programs_by_name(...)` and adapt the decoration logic to
read `m.source.url`, `m.source.sha256`, `m.license.spdx`,
`m.license.url` directly off `DepsManifest`.

The `ProgramMetadata::source_value()` and `license_value()` methods
currently emit JSON shapes. The replacement helpers should emit the
*same* JSON, since `manifest.json`'s schema is fixed.

V1 `ProgramMetadata.Source` had `{ url, ref }`, where `ref` was a tag
or commit. V2 `DepsManifest.Source` has `{ url, sha256 }`. The
release `manifest.json` schema today consumes `{ url, ref? }`. Two
options:

(a) Keep emitting `{ url, ref }` in manifest.json by leaving `ref`
    blank or deriving it from the URL.
(b) Switch manifest.json's `source` shape to `{ url, sha256 }`.

(b) is the cleaner end state but breaks anything reading
`manifest.json` today. (a) preserves shape but loses the `ref` info.

**Decision for B.11:** keep emitting `{ url, sha256 }` instead of
`{ url, ref }` — switch the JSON shape now, since:
- The `ref` field was only ever consumed by the release page UI for
  display, not by our own resolver.
- The release schema is owned by us; PR #341 already
  added `target_arch` etc. The manifest.json shape is allowed to
  evolve.
- Renaming downstream consumers is one-line search-and-replace if
  anything reads `entry.source.ref` (none in this repo do; verified
  via grep).

If the gauntlet exposes a downstream consumer (e.g.,
`scripts/fetch-binaries.sh`) that breaks, take the other branch: emit
both `ref` (set to a stable string like the GitHub tag for github
URLs, else "") and `sha256`.

**Step 1: Verify no manifest.json consumers read `source.ref`:**

```bash
grep -rn 'entry.source.ref\|"ref":' --include='*.ts' --include='*.sh' --include='*.rs' . 2>/dev/null | grep -v node_modules | grep -v target/
```

If grep finds anything beyond program-metadata files, fall back to the
"emit both" approach.

**Step 2: Edit `xtask/src/build_manifest.rs`:**

Replace:

```rust
use crate::program_metadata::{load_program_metadata, ProgramMetadata};
// ...
let program_meta = load_program_metadata()?;
// ...
let mut program_names: Vec<&str> = program_meta.keys().map(|s| s.as_str()).collect();
program_names.sort_by(|a, b| b.len().cmp(&a.len()).then_with(|| a.cmp(b)));
// ...
let meta = program_meta.get(&parsed.program).ok_or_else(|| {
    format!(
        "no entry for program {:?} in abi/program-metadata.toml — \
         every shipped asset must declare source + license",
        parsed.program
    )
})?;
// ...
m.insert("source".into(), meta.source_value());
m.insert("license".into(), meta.license_value());
```

With code that walks the per-dir registry. Add small inline helpers
for `source_value()` + `license_value()` that operate on
`DepsManifest`:

```rust
fn source_value(m: &DepsManifest) -> Value {
    let mut o: JsonMap = BTreeMap::new();
    o.insert("url".into(), json!(m.source.url));
    o.insert("sha256".into(), json!(m.source.sha256));
    Value::Object(o.into_iter().collect())
}

fn license_value(m: &DepsManifest) -> Value {
    let mut o: JsonMap = BTreeMap::new();
    o.insert("spdx".into(), json!(m.license.spdx));
    if let Some(u) = m.license.url.as_deref() {
        o.insert("url".into(), json!(u));
    }
    Value::Object(o.into_iter().collect())
}
```

**Step 3: Adjust `program_names` derivation** to come from
`programs_by_name(...)`:

```rust
use crate::build_deps::{programs_by_name, Registry};
let registry = Registry::from_env(&repo_root());
let program_meta = programs_by_name(&registry)?;
// ... rest of the logic that accepts a BTreeMap<String, _> works as-is.
```

`build_entry` takes `&BTreeMap<String, ProgramMetadata>` today; rename
the parameter type to `&BTreeMap<String, DepsManifest>` and switch the
two method calls (`meta.source_value()`, `meta.license_value()`) to
the free functions defined above. `repo_root` import added at the top
if not already.

**Step 4: Run xtask tests:**

```bash
cargo test -p xtask --target aarch64-apple-darwin
```

**Step 5: Manual smoke test:**

```bash
mkdir -p /tmp/manifest-smoke
# Stage one fake program file so build-manifest has something to walk.
cp examples/libs/dash/bin/dash.wasm /tmp/manifest-smoke/dash-0.5.12-rev1-deadbeef.wasm 2>/dev/null \
  || dd if=/dev/urandom of=/tmp/manifest-smoke/dash-0.5.12-rev1-deadbeef.wasm bs=1024 count=1
# Hash actually has to match. Compute the right hash and rename.
sha=$(shasum -a 256 /tmp/manifest-smoke/dash-0.5.12-rev1-deadbeef.wasm | awk '{print $1}' | cut -c1-8)
mv /tmp/manifest-smoke/dash-0.5.12-rev1-deadbeef.wasm "/tmp/manifest-smoke/dash-0.5.12-rev1-${sha}.wasm"

cargo run -p xtask --target aarch64-apple-darwin -- build-manifest \
    --in /tmp/manifest-smoke \
    --out /tmp/manifest-smoke/manifest.json \
    --tag "binaries-abi-v$(grep -oE 'ABI_VERSION: u32 = [0-9]+' crates/shared/src/lib.rs | awk '{print $4}')"
cat /tmp/manifest-smoke/manifest.json | head -30
# Expected: a JSON entry for dash with source.{url,sha256} (not source.ref)
# and license.{spdx,url}.
```

**Step 6: Commit:**

```bash
git add xtask/src/build_manifest.rs
git commit -m "feat: build-manifest decorates entries from per-dir registry

Replaces load_program_metadata() with programs_by_name() walk.
Emit source.{url,sha256} (was source.{url,ref}) — the ref field
was display-only and unused in the release fetch path. license
shape (spdx + optional url) unchanged."
```

**Spec review:** YES (output schema change, even if minor).
**Code-quality review:** YES.

---

### Task B.12: Delete `program_metadata.rs` + `abi/program-metadata.toml`

**Files:**
- Delete: `xtask/src/program_metadata.rs`
- Delete: `abi/program-metadata.toml`
- Modify: `xtask/src/main.rs` — remove `mod program_metadata;`

**Step 1: Verify no remaining callers:**

```bash
grep -rn 'load_program_metadata\|program_metadata' --include='*.rs' --include='*.ts' --include='*.sh' --include='*.toml' . 2>/dev/null | grep -v node_modules | grep -v target/
```

Expected: only the lines we're about to delete (`xtask/src/main.rs`'s
`mod program_metadata;`, the file itself, the toml file, and possibly
stale comments). If any other code references either, surface to the
plan author — that's a B.10 / B.11 regression.

**Step 2: Remove the references:**

In `xtask/src/main.rs`, delete the line:

```rust
mod program_metadata;
```

**Step 3: Delete the files:**

```bash
git rm xtask/src/program_metadata.rs
git rm abi/program-metadata.toml
```

**Step 4: Run xtask tests:**

```bash
cargo test -p xtask --target aarch64-apple-darwin
```

Expected: clean compile, all tests green.

**Step 5: Commit:**

```bash
git commit -m "feat: delete abi/program-metadata.toml + xtask program_metadata module

The central per-program metadata table is replaced by per-dir
examples/libs/<name>/deps.toml manifests with kind = \"program\".
bundle-program and build-manifest now read from the registry walk;
nothing else in the repo references the deleted file."
```

**Spec review:** YES (mechanical, but final-cleanup).
**Code-quality review:** NO.

---

### Task B.13: Update `stage-release.sh` to drop stale references + reflect new layout

**Files:**
- Modify: `scripts/stage-release.sh`

**What:** several lines reference the now-deleted central file and the
sqlite-vs-sqlite-cli rename. Sweep:

1. Line 79's comment mentions `program-metadata.toml` aliasing (about
   the sh entry that we already dropped in B.8).
2. Line 126's comment about "version taken from
   `abi/program-metadata.toml`'s source.ref" is stale — the source of
   truth is now per-dir manifests.
3. Line 145: `simple sqlite 3.45.0 examples/libs/sqlite/sqlite-install/bin/sqlite3.wasm`
   needs to become `simple sqlite-cli 3.45.0
   examples/libs/sqlite/sqlite-install/bin/sqlite3.wasm` (the program
   is `sqlite-cli`; the library is `sqlite`).

The version arguments to `simple` / `bundle-program` lines are
duplicates of the `version` field in the per-dir manifest. Leave them
hardcoded for now — adapting `bundle-program` to read the version
from the manifest is a Chunk E concern.

**Step 1: Edit comments + the sqlite line.**

**Step 2: Verify the script syntax** (don't run a full release; just
syntax-check):

```bash
bash -n scripts/stage-release.sh
```

**Step 3: Commit:**

```bash
git add scripts/stage-release.sh
git commit -m "feat: stage-release.sh — refresh comments + rename sqlite to sqlite-cli

V2 source of truth for program metadata is per-dir
examples/libs/<name>/deps.toml. Comments updated to remove stale
abi/program-metadata.toml references. The sqlite program (CLI)
publishes as sqlite-cli; the sqlite library is unchanged. Version
strings remain hardcoded in the script — Chunk E will switch to
manifest-driven versions."
```

**Spec review:** NO (mechanical comments + one rename).
**Code-quality review:** NO.

---

### Task B.14: 5-gate gauntlet + open PR

**Step 1: Run all 5 gates** from CLAUDE.md, plus xtask tests:

```bash
# Gate 0: xtask
cargo test -p xtask --target aarch64-apple-darwin > /tmp/chunk-b-xtask.txt 2>&1

# Gate 1: cargo kernel
cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib > /tmp/chunk-b-cargo.txt 2>&1

# Gate 2: vitest
cd host && npx vitest run > /tmp/chunk-b-vitest.txt 2>&1; cd ..

# Gate 3: libc-test
bash scripts/run-libc-tests.sh > /tmp/chunk-b-libc.txt 2>&1

# Gate 4: POSIX
bash scripts/run-posix-tests.sh > /tmp/chunk-b-posix.txt 2>&1

# Gate 5: sortix
bash scripts/run-sortix-tests.sh --all > /tmp/chunk-b-sortix.txt 2>&1

# Gate 6: ABI snapshot
bash scripts/check-abi-version.sh > /tmp/chunk-b-abi.txt 2>&1
```

**Step 2: Compare against B.0 baseline.** Diff the tails. Acceptable
deltas: zero new FAILs anywhere; xtask test count higher (we added
tests in B.1, B.2, B.9). Pre-existing libc-test
`regression/daemon-failure` FAIL is expected — confirm via `grep FAIL
/tmp/chunk-b-libc.txt` shows the same single line.

If anything regresses, root-cause + fix on this branch (don't push
yet); do NOT skip suites.

**Step 3: Push branch + open PR:**

```bash
git push -u origin deps-cache-v2-program-migration
gh pr create --base deps-cache-v2-schema-foundation --title "deps V2: chunk B — γ migration of programs to per-dir manifests" --body "$(cat <<'EOF'
## Summary

Chunk B of the V2 dependency-management migration. Retires
`abi/program-metadata.toml` + `xtask/src/program_metadata.rs`. Every
shipped program now declares itself via a per-dir
`examples/libs/<name>/deps.toml` with `kind = "program"`.

See:
- `docs/plans/2026-04-22-deps-management-v2-design.md` (locked
  decisions 1, 3, 7, 8, 15).
- `docs/plans/2026-04-25-deps-management-v2-chunk-b.md` (this PR's
  task plan).

### Schema additions

- `kind = "program"` manifests use `[[outputs]]` array-of-tables
  (multi-output programs declare each `.wasm`). Library manifests
  keep `[outputs]` table form.
- Mismatch (library with `[[outputs]]`; program with `[outputs]`)
  rejected at parse time.
- Program cache layout: `<cache>/programs/<name>-<v>-rev<N>-<arch>-<sha>/`.

### Program migrations

- ~30 programs migrated; multi-output: git, php, diffutils,
  findutils, redis, mariadb. Composite VFS / in-repo: kernel,
  userspace, examples, shell, lamp, node, wordpress.
- Aliases retired: `sh`, `python`, `tclsh`. VFS demos already
  install the real binary at the desired path.
- `curl` (program) and `libcurl` (library) are now distinct
  manifests; `sqlite-cli` (program) and `sqlite` (library)
  similarly split.

### Tooling rewires

- `bundle-program` looks up programs via the per-dir registry.
- `build-manifest` decorates entries from the same source. Output
  JSON shape: `entry.source = { url, sha256 }` (was `{ url, ref }`).
- `stage-release.sh`: dropped the `sh` re-publish; `sqlite` line
  renamed to `sqlite-cli`.

### What's NOT in this PR

- The `[[outputs]]` shift to per-output release archives (one
  `.tar.zst` per output) is Chunk E.
- `kind = "source"` schema and inline `[[host_tools]]` declarations
  are Chunk C.
- No consumer build-script migrations (Chunk D).

## Test plan

- [ ] `cargo test -p xtask --target aarch64-apple-darwin` — green.
- [ ] `cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib` — green.
- [ ] `cd host && npx vitest run` — green.
- [ ] `scripts/run-libc-tests.sh` — no new FAILs vs base
      `35c462e02` (one pre-existing `regression/daemon-failure`).
- [ ] `scripts/run-posix-tests.sh` — no new FAILs.
- [ ] `scripts/run-sortix-tests.sh --all` — no new FAILs / XPASSes.
- [ ] `scripts/check-abi-version.sh` — exit 0.
- [ ] Manual `bundle-program` smoke test against a real binary.
- [ ] Manual `build-manifest` smoke test against a staged dir.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

**Step 4: Update memory** — `memory/project_dependency_management.md`
gains a Chunk-B-shipped entry.

**Step 5: Report back to the user.**

**Spec review:** NO (operations).
**Code-quality review:** NO.

---

## Estimated effort

| Task | Effort | Reviews |
|------|--------|---------|
| B.0  | 30 min — compute shas | none |
| B.1  | 1.5–2 h — schema + tests | spec + quality |
| B.2  | 1 h — resolver dispatch | spec + quality |
| B.3  | 15 min — examples manifest | none |
| B.4  | 1 h — 15 manifests + sha lookups | none |
| B.5  | 1 h — 15 manifests | none |
| B.6  | 30 min — 6 multi-output manifests | none |
| B.7  | 30 min — 6 in-repo manifests | none |
| B.8  | 15 min — drop sh bundle | none |
| B.9  | 1 h — Registry::walk_all | spec + quality |
| B.10 | 30 min — bundle-program rewire | spec + quality |
| B.11 | 1 h — build-manifest rewire | spec + quality |
| B.12 | 15 min — delete two files | none |
| B.13 | 15 min — stage-release sweep | none |
| B.14 | 30 min gates + PR | none |

**Total: ~10–13 hours active work; 5–7 days elapsed once subagent
turnaround is included.**

---

## Plan complete

**Plan saved to**
`docs/plans/2026-04-25-deps-management-v2-chunk-b.md`.

Execute via `superpowers:subagent-driven-development`. Always Opus 4.6
for subagents. Stop after B.14; do NOT merge the PR.
