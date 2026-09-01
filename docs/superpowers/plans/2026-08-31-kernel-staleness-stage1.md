# Kernel Staleness — Stage 1 (Kernel) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a stale `kernel.wasm` impossible to serve silently, by
(A) deriving the kernel's cache-key inputs from Cargo so no compile
input can be omitted, (B1) stamping the built kernel with its cache key
and failing loud in the pre-test gate when the staged artifact does not
match the current source, and (B3) failing loud when the committed ABI
snapshot has drifted from its sources.

**Architecture:** All changes are in the Rust `xtask` crate (the local
build engine, cache-key computation, and the `verify-fresh` gate). We
add a `cargo:<crate>` input-tag that expands (via `cargo metadata`) to
the crate's workspace path-dependency directories plus `.cargo/config.toml`,
feed that through the existing build-input digest machinery, write a
build-key custom section into the mirrored kernel artifact at
cache-store time, and extend `verify_fresh_report` to compare the
stamped key against the freshly-computed expected key and to run the
existing ABI-snapshot drift check locally.

**Tech Stack:** Rust (xtask), `sha2`, `wasmparser` (wasm read), `serde`,
`toml`; the existing `cargo metadata` shell-out pattern; the existing
source-only cache/mirror engine.

**Spec:** `docs/superpowers/specs/2026-08-31-kernel-staging-integrity-design.md`
(Parts A, B1, B3; this plan is Stage 1 of the staged rollout. Stages 2–4
— generalize A/B1 to `userspace.wasm` + the fork-instrument tool-hash;
Part C guest contract-digest enforcement; Part D legacy-path removal —
are separate plans authored after Stage 1 lands, because they build on
the shared key-function and stamp utility introduced here.)

## Global Constraints

- **No `ABI_VERSION` bump in this stage.** The build-key stamp is a new
  wasm custom section named in the `kandelo.build.*` namespace and must
  live **outside** `crates/shared/src/lib.rs`'s `pub mod abi` (any const
  added there is itself an ABI change). Verify the new section is ignored
  by every artifact-policy reader (`describeWasmArtifactPolicyFailures`,
  `extractAbiVersion` in `host/src/constants.ts`;
  `wasm_artifact_policy_failures_for` in `build_deps.rs`; fork-instrument
  `artifact_identity`) — none of them reject unknown custom sections.
- **Preserve the no-op speed win** (929s→7.5s): no `cargo` *compile* on
  the no-op path. `cargo metadata` (measured 0.07s warm / 0.36s cold) and
  a source-closure sha256 (0.03s) are the only added work; the snapshot
  drift check (B3) is gated to run only when `crates/shared` or the
  kernel changed.
- **Preserve the invalidation boundary:** nothing here adds kernel source
  to a guest program's inputs. Only the kernel package's own inputs
  change.
- **The build engine and `verify-fresh` compute the expected key through
  ONE shared function** — never two reimplementations.
- `ABI_VERSION` is currently `43` (`crates/shared/src/lib.rs:114`); tests
  use `TEST_ABI` / literal `4` per the existing xtask test fixtures — do
  not hardcode `43` in new tests; derive from `wasm_posix_shared::ABI_VERSION`
  where a real value is needed, or use the fixture ABI where a synthetic
  repo is built.
- Build/verify commands run under `scripts/dev-shell.sh`.

---

### Task 1: `cargo:<crate>` closure expansion helper

Expand a `cargo:<crate>` input tag into the concrete list of repo-relative
paths that determine that crate's compiled output: the crate's own
directory, its transitive **workspace-local** path-dependency
directories, and `.cargo/config.toml` (the input omitted today).
`rust-toolchain.toml` is already covered by `GLOBAL_PACKAGE_TOOLCHAIN_INPUTS`
and is intentionally not re-added here.

**Files:**
- Create: `tools/xtask/src/cargo_closure.rs`
- Modify: `tools/xtask/src/main.rs` (add `mod cargo_closure;` beside the other `mod` declarations)
- Test: inline `#[cfg(test)] mod tests` in `tools/xtask/src/cargo_closure.rs`

**Interfaces:**
- Produces:
  - `pub(crate) const CARGO_INPUT_PREFIX: &str = "cargo:";`
  - `pub(crate) fn cargo_closure_paths(repo_root: &Path, crate_name: &str) -> Result<Vec<String>, String>` — returns **sorted, deduped, repo-relative** path strings (directories and files), always including `.cargo/config.toml` when it exists, and the crate's own dir plus every workspace-member dependency dir in the crate's transitive dependency closure. Errors if `crate_name` is not a workspace member.
- Consumes: the existing `cargo metadata` shell-out pattern at
  `build_deps.rs:7003-7042` (`Command::new("cargo").args(["metadata","--format-version=1","--locked"]).current_dir(root).output()`, then `serde_json::from_slice`). Mirror it; do not import from `build_deps`.

- [ ] **Step 1: Write the failing test**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    // Uses the real checked-in workspace so `cargo metadata` resolves the
    // kernel crate ("kandelo") and its workspace path-deps.
    #[test]
    fn kandelo_closure_includes_runtime_core_shared_and_cargo_config() {
        let repo = crate::repo_root();
        let paths = cargo_closure_paths(&repo, "kandelo").expect("closure");
        assert!(paths.iter().any(|p| p == "crates/kernel"), "kernel dir: {paths:?}");
        assert!(paths.iter().any(|p| p == "crates/runtime-core"), "runtime-core dir: {paths:?}");
        assert!(paths.iter().any(|p| p == "crates/shared"), "shared dir: {paths:?}");
        assert!(paths.iter().any(|p| p == ".cargo/config.toml"), "cargo config: {paths:?}");
        // sorted + deduped
        let mut sorted = paths.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(paths, sorted, "must be sorted and deduped");
    }

    #[test]
    fn unknown_crate_is_an_error() {
        let repo = crate::repo_root();
        let err = cargo_closure_paths(&repo, "definitely-not-a-crate").unwrap_err();
        assert!(err.contains("definitely-not-a-crate"), "{err}");
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `scripts/dev-shell.sh cargo test -p xtask cargo_closure -- --nocapture`
Expected: FAIL — `cannot find function cargo_closure_paths` / module missing.

- [ ] **Step 3: Write minimal implementation**

```rust
//! Expand a `cargo:<crate>` build-input tag into the repo-relative paths
//! that determine that crate's compiled output. This makes the kernel's
//! cache-key inputs derive from Cargo's real dependency graph instead of
//! a hand-maintained list that can silently omit a compile input
//! (e.g. `.cargo/config.toml`, or a newly-added workspace crate).

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::process::Command;

pub(crate) const CARGO_INPUT_PREFIX: &str = "cargo:";

pub(crate) fn cargo_closure_paths(
    repo_root: &Path,
    crate_name: &str,
) -> Result<Vec<String>, String> {
    let output = Command::new("cargo")
        .args(["metadata", "--format-version=1", "--locked"])
        .current_dir(repo_root)
        .output()
        .map_err(|e| format!("run cargo metadata for `{crate_name}` closure: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "cargo metadata for `{crate_name}` closure failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    let meta: serde_json::Value = serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("parse cargo metadata json: {e}"))?;

    let packages = meta
        .get("packages")
        .and_then(|v| v.as_array())
        .ok_or("cargo metadata: missing packages array")?;
    let workspace_members: BTreeSet<&str> = meta
        .get("workspace_members")
        .and_then(|v| v.as_array())
        .ok_or("cargo metadata: missing workspace_members")?
        .iter()
        .filter_map(|v| v.as_str())
        .collect();

    // id -> (name, manifest_path, [dependency names]) for workspace members only.
    let mut by_name: BTreeMap<&str, (&str, &str, Vec<&str>)> = BTreeMap::new();
    for pkg in packages {
        let id = pkg.get("id").and_then(|v| v.as_str()).unwrap_or_default();
        if !workspace_members.contains(id) {
            continue;
        }
        let name = pkg.get("name").and_then(|v| v.as_str()).unwrap_or_default();
        let manifest = pkg
            .get("manifest_path")
            .and_then(|v| v.as_str())
            .unwrap_or_default();
        let deps = pkg
            .get("dependencies")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|d| d.get("name").and_then(|v| v.as_str()))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        by_name.insert(name, (name, manifest, deps));
    }

    if !by_name.contains_key(crate_name) {
        return Err(format!(
            "`{crate_name}` is not a workspace member (cargo:<crate> requires a workspace crate)"
        ));
    }

    // BFS the transitive workspace-local dependency closure.
    let mut seen: BTreeSet<&str> = BTreeSet::new();
    let mut queue = vec![crate_name];
    let mut dirs: BTreeSet<String> = BTreeSet::new();
    while let Some(name) = queue.pop() {
        if !seen.insert(name) {
            continue;
        }
        let Some((_, manifest, deps)) = by_name.get(name) else {
            continue; // registry crate: covered by Cargo.lock elsewhere
        };
        let dir = crate_dir_relative(repo_root, manifest)?;
        dirs.insert(dir);
        for dep in deps {
            if by_name.contains_key(dep) {
                queue.push(dep);
            }
        }
    }

    // `.cargo/config.toml` governs codegen/link flags but is not a graph
    // node — the exact input omitted today. Include it when present.
    if repo_root.join(".cargo/config.toml").exists() {
        dirs.insert(".cargo/config.toml".to_string());
    }

    Ok(dirs.into_iter().collect())
}

fn crate_dir_relative(repo_root: &Path, manifest_path: &str) -> Result<String, String> {
    let manifest = Path::new(manifest_path);
    let dir = manifest
        .parent()
        .ok_or_else(|| format!("manifest has no parent dir: {manifest_path}"))?;
    let rel = dir
        .strip_prefix(repo_root)
        .map_err(|_| format!("crate dir {} is outside repo root {}", dir.display(), repo_root.display()))?;
    Ok(rel.to_string_lossy().replace('\\', "/"))
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `scripts/dev-shell.sh cargo test -p xtask cargo_closure -- --nocapture`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git add tools/xtask/src/cargo_closure.rs tools/xtask/src/main.rs
git commit -m "Packages: Derive a crate's build-input closure from cargo metadata

Add cargo_closure_paths(): expand a cargo:<crate> tag into the crate's
workspace path-dependency dirs plus .cargo/config.toml, so no compile
input can be silently omitted from a cache key.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Wire the `cargo:` tag into build-input digests

Teach `build_input_digests_from_repo` to recognize a `cargo:<crate>`
entry in `build.toml`'s `inputs` and expand it (via Task 1) into concrete
path inputs that flow through the existing digest machinery. A plain path
input is unchanged.

**Files:**
- Modify: `tools/xtask/src/build_deps.rs` (`build_input_digests_from_repo`, ~7426-7521)
- Test: extend the `#[cfg(test)] mod tests` in `tools/xtask/src/build_deps.rs`

**Interfaces:**
- Consumes: `crate::cargo_closure::{CARGO_INPUT_PREFIX, cargo_closure_paths}` (Task 1); the existing `resolve_build_input_path_from_repo`, `strict_source_build_input_digest`, `hash_build_input`, and `BuildInputDigest` in this file.
- Produces: for each `cargo:<crate>` entry, one `BuildInputDigest` per expanded path, labelled `"cargo:<crate>::<relpath>"` so labels stay stable and human-readable. No change to the function signature.

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn cargo_input_tag_expands_and_includes_cargo_config() {
    // Real repo: a package that declares `inputs = ["cargo:kandelo"]`
    // must fold `.cargo/config.toml` into its key. We assert by building
    // the input-digest list directly for a synthetic manifest pointing at
    // the real repo root.
    let repo = crate::repo_root();
    let reg = Registry::from_env().expect("registry");
    let kernel = reg
        .load("kernel")
        .expect("kernel manifest present in registry");
    let digests = build_input_digests_from_repo(
        &kernel,
        &reg,
        &repo,
        ResolvePolicy::SourceOnlyV1,
    )
    .expect("input digests");
    let labels: Vec<&str> = digests.iter().map(|d| d.label.as_str()).collect();
    assert!(
        labels.iter().any(|l| l.starts_with("cargo:kandelo::") && l.ends_with(".cargo/config.toml")),
        "expected an expanded .cargo/config.toml input, got {labels:?}"
    );
    assert!(
        labels.iter().any(|l| *l == "cargo:kandelo::crates/runtime-core"),
        "expected runtime-core input, got {labels:?}"
    );
}
```

Note: this test assumes Task 4 has migrated `packages/registry/kernel/build.toml`
to use `cargo:kandelo`. If running Task 2 before Task 4, temporarily point
the assertion at a fixture package; the plan orders Task 4 immediately
after, and the final suite run in Task 4 validates this against the real
kernel manifest.

- [ ] **Step 2: Run test to verify it fails**

Run: `scripts/dev-shell.sh cargo test -p xtask cargo_input_tag_expands -- --nocapture`
Expected: FAIL — the `cargo:` label is treated as a literal path and
`resolve_build_input_path_from_repo` errors (or produces a single wrong
digest), so no `cargo:kandelo::...` labels appear.

- [ ] **Step 3: Write minimal implementation**

In `build_input_digests_from_repo`, replace the body of the
`for input in &build.inputs { ... }` loop so a `cargo:` entry expands.
Add, at the top of the loop body:

```rust
        if let Some(crate_name) = input.strip_prefix(crate::cargo_closure::CARGO_INPUT_PREFIX) {
            let crate_name = crate_name.trim();
            if crate_name.is_empty() {
                return Err(format!(
                    "{}: build.toml input `{input}` has an empty crate name",
                    target.spec()
                ));
            }
            for rel in crate::cargo_closure::cargo_closure_paths(main_repo_root, crate_name)? {
                let path = resolve_build_input_path_from_repo(target, registry, &rel, main_repo_root)?;
                let digest = if validate_declared_source_inputs {
                    let authority_root =
                        repository_source_authority_root(&path, registry, main_repo_root)?;
                    strict_source_build_input_digest(&authority_root, &path)?
                } else {
                    hash_build_input(&path)?
                };
                out.push(BuildInputDigest {
                    label: format!("{input}::{rel}"),
                    digest,
                });
            }
            continue;
        }
```

(Leave the existing plain-path branch below it unchanged. Note
`validate_repository_build_input_label(input)` is still called first for
the raw `cargo:...` label; extend `validate_build_input_path` /
`validate_repository_build_input_label` to accept a `cargo:` prefix as a
valid label — see Step 3b.)

- [ ] **Step 3b: Allow the `cargo:` label past input validation**

In `tools/xtask/src/pkg_manifest.rs`, `validate_build_input_path`
(~1100-1111), accept a `cargo:<name>` label (non-empty name, no path
traversal) as valid without treating it as a filesystem path:

```rust
    if let Some(name) = value.strip_prefix("cargo:") {
        if name.trim().is_empty() {
            return Err(format!("build.toml input `{value}` has an empty crate name"));
        }
        return Ok(());
    }
```

Apply the same acceptance in `validate_repository_build_input_label` in
`build_deps.rs` if it independently rejects the `:` character.

- [ ] **Step 4: Run test to verify it passes**

Run: `scripts/dev-shell.sh cargo test -p xtask cargo_input_tag_expands -- --nocapture`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tools/xtask/src/build_deps.rs tools/xtask/src/pkg_manifest.rs
git commit -m "Packages: Expand cargo:<crate> build-input tags into digests

build.toml inputs may now contain a cargo:<crate> tag that expands to the
crate's cargo-derived path closure (incl. .cargo/config.toml), each folded
into the cache key via the existing strict source-digest machinery.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Migrate the kernel package to `cargo:kandelo`

Replace the hand-listed crate paths in the kernel's `build.toml` with the
`cargo:kandelo` tag, keeping the genuinely non-Rust inputs explicit. Prove
the kernel key now folds `.cargo/config.toml`.

**Files:**
- Modify: `packages/registry/kernel/build.toml`
- Test: extend `tools/xtask/src/build_deps.rs` tests (a regression test)

**Interfaces:**
- Consumes: Tasks 1–2.
- Produces: the kernel cache key now changes when `.cargo/config.toml`
  changes.

- [ ] **Step 1: Write the failing test (regression: the reported bug)**

```rust
#[test]
fn kernel_key_changes_when_cargo_config_changes() {
    // Copy the real repo into a temp dir, compute the kernel key, mutate
    // .cargo/config.toml, recompute, and assert the key moved. Proves the
    // omission class (.cargo/config.toml absent from the key) is closed.
    let src = crate::repo_root();
    let tmp = tempdir("kernel-cargo-config");
    copy_dir_recursive(&src, &tmp).expect("copy repo");
    let reg = Registry { roots: vec![tmp.join("packages/registry")] };
    let kernel = reg.load("kernel").expect("kernel");

    let before = compute_cache_key_sha_for_package(
        &kernel, &reg, TargetArch::Wasm32, wasm_posix_shared::ABI_VERSION,
    ).expect("key before");

    // Append a harmless comment to .cargo/config.toml (codegen input).
    let cfg = tmp.join(".cargo/config.toml");
    let mut contents = std::fs::read_to_string(&cfg).unwrap();
    contents.push_str("\n# staleness-regression-probe\n");
    std::fs::write(&cfg, contents).unwrap();

    let after = compute_cache_key_sha_for_package(
        &kernel, &reg, TargetArch::Wasm32, wasm_posix_shared::ABI_VERSION,
    ).expect("key after");

    assert_ne!(before, after, ".cargo/config.toml must be a kernel cache input");
}
```

If a `copy_dir_recursive` helper does not exist in the test module, add a
small one beside the `tempdir` helper (recursive copy of files +
directories; skip `target/`, `.git/`, and `local-binaries/` for speed).

- [ ] **Step 2: Run test to verify it fails**

Run: `scripts/dev-shell.sh cargo test -p xtask kernel_key_changes_when_cargo_config -- --nocapture`
Expected: FAIL — with the pre-migration `build.toml`, `.cargo/config.toml`
is not an input, so `before == after`.

- [ ] **Step 3: Migrate the kernel build.toml**

Edit `packages/registry/kernel/build.toml` `inputs` to:

```toml
inputs = [
    "packages/registry/kernel/build-kernel.sh",
    "scripts/wasm-artifact-guards.sh",
    "Cargo.toml",
    "Cargo.lock",
    "cargo:kandelo",
]
```

(`crates/kernel`, `crates/runtime-core`, `crates/shared` are removed — the
`cargo:kandelo` tag now derives them plus `.cargo/config.toml`.
`Cargo.toml`/`Cargo.lock` and the two non-Rust scripts stay explicit.)

- [ ] **Step 4: Run test to verify it passes + full xtask suite**

Run: `scripts/dev-shell.sh cargo test -p xtask kernel_key_changes_when_cargo_config -- --nocapture`
Expected: PASS.
Then run the full xtask suite to catch fallout in existing key/receipt
tests: `scripts/dev-shell.sh cargo test -p xtask`
Expected: PASS. Also re-run the Task 2 real-manifest test — it now
asserts against the migrated kernel manifest.

- [ ] **Step 5: Commit**

```bash
git add packages/registry/kernel/build.toml tools/xtask/src/build_deps.rs
git commit -m "Packages: Key the kernel off its cargo-derived closure

Replace the hand-listed crates/{kernel,runtime-core,shared} inputs with
cargo:kandelo, which derives them plus .cargo/config.toml. Regression test
proves editing .cargo/config.toml now changes the kernel cache key —
closing the omission class behind the stale-kernel incidents.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Build-key stamp writer + reader

A small module that appends a `kandelo.build.key` custom section (32-byte
digest) to a wasm artifact and reads it back. Appending a custom section
to the tail of a valid module is itself valid, so no wasm re-encoder is
needed; reads use the existing `wasmparser` dependency.

**Files:**
- Create: `tools/xtask/src/build_stamp.rs`
- Modify: `tools/xtask/src/main.rs` (`mod build_stamp;`)
- Test: inline `#[cfg(test)] mod tests`

**Interfaces:**
- Produces:
  - `pub(crate) const BUILD_KEY_SECTION: &str = "kandelo.build.key";`
  - `pub(crate) fn stamp_build_key(wasm: &[u8], key: &[u8; 32]) -> Result<Vec<u8>, String>` — appends a `kandelo.build.key` custom section. Errors if the wasm already carries one (a fresh build never does — see design note), so a double-stamp is a loud bug, not a silent second section.
  - `pub(crate) fn read_build_key(wasm: &[u8]) -> Result<Option<[u8; 32]>, String>` — `Ok(None)` if the section is absent; error if present but not exactly 32 bytes.
- Consumes: `wasmparser` (already a dep) for reads; hand-encoded LEB128 for the write.

**Design note (append-only):** we stamp exactly once, on a freshly-built
artifact that has no prior stamp (Task 5). Appending a custom section to
the tail of a valid module is itself valid and needs no wasm re-encoder,
so `stamp_build_key` only appends. It does not rewrite or strip existing
sections; if a stamp is somehow already present it errors rather than
silently appending a second one.

- [ ] **Step 1: Write the failing test**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    // Minimal valid wasm module: magic + version, no sections.
    fn empty_module() -> Vec<u8> {
        vec![0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]
    }

    #[test]
    fn stamp_roundtrips() {
        let key = [7u8; 32];
        let stamped = stamp_build_key(&empty_module(), &key).unwrap();
        assert_eq!(read_build_key(&stamped).unwrap(), Some(key));
    }

    #[test]
    fn absent_section_reads_none() {
        assert_eq!(read_build_key(&empty_module()).unwrap(), None);
    }

    #[test]
    fn double_stamp_is_an_error() {
        let once = stamp_build_key(&empty_module(), &[1u8; 32]).unwrap();
        let err = stamp_build_key(&once, &[2u8; 32]).unwrap_err();
        assert!(err.contains("already"), "{err}");
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `scripts/dev-shell.sh cargo test -p xtask build_stamp -- --nocapture`
Expected: FAIL — module/functions missing.

- [ ] **Step 3: Write minimal implementation**

```rust
//! Write/read the `kandelo.build.key` custom section: the cache key a
//! locally-built wasm artifact was produced under. `verify-fresh` compares
//! this stamp against the freshly-computed expected key so a stale mirror
//! fails loud, independent of the ABI version.
//!
//! Append-only: we stamp exactly once, on a fresh build. Appending a
//! custom section to the tail of a valid module is valid and needs no
//! re-encoder; reads use the existing `wasmparser` dependency.

use wasmparser::{Parser, Payload};

pub(crate) const BUILD_KEY_SECTION: &str = "kandelo.build.key";

pub(crate) fn read_build_key(wasm: &[u8]) -> Result<Option<[u8; 32]>, String> {
    for payload in Parser::new(0).parse_all(wasm) {
        let payload = payload.map_err(|e| format!("parse wasm for build key: {e}"))?;
        if let Payload::CustomSection(section) = payload {
            if section.name() == BUILD_KEY_SECTION {
                let data = section.data();
                if data.len() != 32 {
                    return Err(format!(
                        "{BUILD_KEY_SECTION} custom section is {} bytes, expected 32",
                        data.len()
                    ));
                }
                let mut key = [0u8; 32];
                key.copy_from_slice(data);
                return Ok(Some(key));
            }
        }
    }
    Ok(None)
}

pub(crate) fn stamp_build_key(wasm: &[u8], key: &[u8; 32]) -> Result<Vec<u8>, String> {
    if read_build_key(wasm)?.is_some() {
        return Err(format!(
            "wasm already carries a {BUILD_KEY_SECTION} section; refusing to double-stamp"
        ));
    }
    // Custom section: id(0x00) | uleb size | uleb name-len | name | payload
    let name = BUILD_KEY_SECTION.as_bytes();
    let mut body = Vec::new();
    write_uleb128(&mut body, name.len() as u64);
    body.extend_from_slice(name);
    body.extend_from_slice(key);

    let mut out = wasm.to_vec();
    out.push(0x00);
    write_uleb128(&mut out, body.len() as u64);
    out.extend_from_slice(&body);
    Ok(out)
}

fn write_uleb128(out: &mut Vec<u8>, mut value: u64) {
    loop {
        let mut byte = (value & 0x7f) as u8;
        value >>= 7;
        if value != 0 {
            byte |= 0x80;
        }
        out.push(byte);
        if value == 0 {
            break;
        }
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `scripts/dev-shell.sh cargo test -p xtask build_stamp -- --nocapture`
Expected: PASS (all three tests).

- [ ] **Step 5: Commit**

```bash
git add tools/xtask/src/build_stamp.rs tools/xtask/src/main.rs
git commit -m "Packages: Add kandelo.build.key stamp writer/reader

Append/read a 32-byte build-key custom section on locally-built wasm
artifacts. Lives outside mod abi, so it is not an ABI change.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Stamp the kernel artifact at cache-store/mirror time

Write the kernel's cache key into the mirrored `kernel.wasm` at the point
the engine materializes it, so both the cached entry and the
`source-only-v1` mirror carry the stamp.

**Files:**
- Modify: `tools/xtask/src/build_deps.rs` — the `before_publish` closure passed to `materialize_source_only_program_target_with_cache_root` inside `resolve_local_build_package_node_with_projection_hooks` (~9204-9258)
- Test: `tools/xtask/src/local_build.rs` (or build_deps.rs) — verify a materialized kernel mirror carries a `kandelo.build.key` equal to the node's `cache_key_sha256`

**Interfaces:**
- Consumes: `crate::build_stamp::{stamp_build_key, read_build_key}` (Task 4); the `cache_key_sha256` already computed for the node (`PackageNodeReceiptV1.cache_key_sha256`, `build_deps.rs:2229`); the `before_publish: FnMut(&Path) -> Result<(), String>` hook (`materialize_source_only_program_target_with_cache_root`, `build_deps.rs:3428-3484`).
- Produces: the staged/cached kernel wasm has `read_build_key(bytes) == Some(<cache_key_bytes>)`.

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn materialized_kernel_carries_build_key_stamp() {
    // Build a temp repo with a fake "kernel"-like program package whose
    // build script emits a minimal wasm module, run the resolve/materialize
    // path, and assert the mirror file carries a build-key equal to the
    // node's cache_key_sha256. Reuse the local_build.rs `package(...)` +
    // `registry(...)` + temp cache/output-root helpers.
    let root = tempdir("stamp-mirror");
    // ... build a program package "kstamp" whose build-<name>.sh writes an
    // 8-byte empty wasm module to $WASM_POSIX_DEP_OUT_DIR/kstamp.wasm ...
    // (mirror the existing package(...) helper; set [[outputs]] wasm)
    let reg = registry(&root);
    let node = /* resolve_local_build_package_node(... "kstamp" ...) */;
    let mirror = /* output_root */.join("programs/wasm32/kstamp.wasm");
    let bytes = std::fs::read(&mirror).unwrap();
    let stamp = crate::build_stamp::read_build_key(&bytes).unwrap().expect("stamp present");
    let expected = hex_to_32(&node.cache_key_sha256);
    assert_eq!(stamp, expected, "mirror must be stamped with its cache key");
}
```

Fill the `...` using the exact `package(...)`/`registry(...)`/resolve
helpers shown in `local_build.rs:4502-4755`; `hex_to_32` decodes the
64-char hex `cache_key_sha256` into `[u8;32]`.

- [ ] **Step 2: Run test to verify it fails**

Run: `scripts/dev-shell.sh cargo test -p xtask materialized_kernel_carries_build_key -- --nocapture`
Expected: FAIL — `stamp present` panics; nothing writes the section yet.

- [ ] **Step 3: Write minimal implementation**

In `resolve_local_build_package_node_with_projection_hooks`, where the
`before_publish` closure is defined for the materialize call, stamp each
staged wasm member with the node's `cache_key_sha256` before publish:

```rust
let cache_key_bytes = hex_to_32(&cache_key_sha256)?; // 32-byte key for this node
let mut before_publish = |staged: &Path| -> Result<(), String> {
    // Only stamp wasm outputs; leave non-wasm members untouched.
    if staged.extension().and_then(|e| e.to_str()) == Some("wasm") {
        let bytes = std::fs::read(staged).map_err(|e| format!("read staged {}: {e}", staged.display()))?;
        let stamped = crate::build_stamp::stamp_build_key(&bytes, &cache_key_bytes)?;
        std::fs::write(staged, stamped).map_err(|e| format!("stamp {}: {e}", staged.display()))?;
    }
    Ok(())
};
```

Thread `&mut before_publish` into the existing
`materialize_source_only_program_target_with_cache_root(..., &mut after_copy, &mut before_publish)`
call. Add a `hex_to_32(&str) -> Result<[u8;32], String>` helper if one is
not already present.

Because the stamp is written into the staged bytes **before** the
transactional publish into the canonical cache dir, the canonical cache
entry and the `source-only-v1` mirror both carry it. The receipt's
`materialized_members[].sha256` is computed from these post-stamp bytes,
so provenance validation stays self-consistent.

- [ ] **Step 4: Run test to verify it passes**

Run: `scripts/dev-shell.sh cargo test -p xtask materialized_kernel_carries_build_key -- --nocapture`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tools/xtask/src/build_deps.rs
git commit -m "Packages: Stamp mirrored wasm outputs with their cache key

Every locally-built wasm output is stamped with the node's cache key at
materialize time, in both the cached entry and the source-only-v1 mirror.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: `verify-fresh` compares stamped key vs expected key (loud B1)

Extend the pre-test gate: recompute the kernel's expected cache key via
the same function the engine uses, read the stamp from the staged
`kernel.wasm`, and fail loud on mismatch. This catches same-ABI staleness
that the current ABI-only check misses.

**Files:**
- Modify: `tools/xtask/src/local_build.rs` (`verify_fresh_report`, 784-815)
- Test: `tools/xtask/src/local_build.rs` tests (near the existing verify-fresh tests, 5718-5804)

**Interfaces:**
- Consumes: `crate::build_stamp::read_build_key` (Task 4); a new
  `expected_source_only_cache_key(repo, "kernel") -> Result<[u8;32], String>`
  that loads the registry + kernel manifest and calls
  `crate::build_deps::compute_cache_key_sha_for_package(&kernel, &reg, TargetArch::Wasm32, wasm_posix_shared::ABI_VERSION)` (the existing shared key function).
- Produces: `verify_fresh_report` fails loud when
  `read_build_key(staged) != Some(expected)`.

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn verify_fresh_fails_on_build_key_mismatch() {
    let repo = temp_repo_with_kernel(wasm_posix_shared::ABI_VERSION); // existing helper
    // Stamp the staged kernel.wasm with a WRONG key.
    let kpath = repo.path().join("local-binaries/source-only-v1/kernel.wasm");
    let bytes = std::fs::read(&kpath).unwrap();
    let wrong = crate::build_stamp::stamp_build_key(&bytes, &[0xAB; 32]).unwrap();
    std::fs::write(&kpath, wrong).unwrap();

    let err = verify_fresh_report(repo.path()).unwrap_err();
    assert!(err.contains("stale"), "expected stale error, got: {err}");
    assert!(err.contains("build key") || err.contains("was built for key"), "{err}");
}

#[test]
fn verify_fresh_passes_when_stamp_matches_expected() {
    let repo = temp_repo_with_kernel(wasm_posix_shared::ABI_VERSION);
    let kpath = repo.path().join("local-binaries/source-only-v1/kernel.wasm");
    let bytes = std::fs::read(&kpath).unwrap();
    let expected = expected_source_only_cache_key(repo.path(), "kernel").unwrap();
    std::fs::write(&kpath, crate::build_stamp::stamp_build_key(&bytes, &expected)).unwrap();
    verify_fresh_report(repo.path()).expect("fresh");
}
```

`temp_repo_with_kernel` must also lay down enough of the registry/manifest
for `expected_source_only_cache_key` to resolve; extend the existing
helper (5708-5716) to copy or synthesize `packages/registry/kernel/*` and
the crates referenced by `cargo:kandelo`, or point the expected-key call
at a fixture package whose key is deterministic in the temp repo.

**Regression hazard — update the existing verify-fresh fixtures.** After
this task, `verify_fresh_report` returns an error when the staged kernel
carries *no* build-key stamp. The pre-existing verify-fresh tests
(`local_build.rs:5718-5804`) build an **unstamped** synthetic kernel via
`write_kernel_wasm`/`kernel_wasm_with_abi`. The ABI-mismatch tests still
pass (the ABI check runs first and returns early), but any test that
expects `verify_fresh_report(...) == Ok(())` on an unstamped kernel will
now fail on the no-stamp branch. Fix: have `temp_repo_with_kernel` (or a
new `stamp_synthetic_kernel` helper) stamp the synthetic kernel with
`expected_source_only_cache_key(repo, "kernel")` for the happy-path
fixtures. Update these fixtures in this task so the full verify-fresh
suite stays green.

- [ ] **Step 2: Run test to verify it fails**

Run: `scripts/dev-shell.sh cargo test -p xtask verify_fresh_fails_on_build_key -- --nocapture`
Expected: FAIL — current `verify_fresh_report` only checks the ABI export,
so a wrong-stamp artifact passes.

- [ ] **Step 3: Write minimal implementation**

Add, in `verify_fresh_report`, after the existing ABI check passes:

```rust
    // Same-ABI staleness: the staged kernel must carry the build key its
    // current source resolves to. A same-ABI internal change moves the key,
    // so a stale mirror's stamp no longer matches -> loud failure.
    let expected = expected_source_only_cache_key(repo, "kernel")?;
    match crate::build_stamp::read_build_key(&bytes)
        .map_err(|e| format!("{}: {e}", kernel_path.display()))?
    {
        Some(stamp) if stamp == expected => {}
        Some(stamp) => {
            return Err(format!(
                "{} is stale: it was built for key {}, but the current source \
                 tree resolves to key {}. Rebuild with `./run.sh setup` (or \
                 `cargo xtask bootstrap`).",
                kernel_path.display(),
                hex(&stamp),
                hex(&expected),
            ));
        }
        None => {
            return Err(format!(
                "{} carries no build key stamp; rebuild with `./run.sh setup` \
                 so freshness can be verified.",
                kernel_path.display()
            ));
        }
    }
```

And add:

```rust
pub(crate) fn expected_source_only_cache_key(
    repo: &Path,
    package: &str,
) -> Result<[u8; 32], String> {
    let reg = crate::pkg_manifest::Registry { roots: vec![repo.join("packages/registry")] };
    let manifest = reg.load(package)?;
    crate::build_deps::compute_cache_key_sha_for_package(
        &manifest,
        &reg,
        crate::build_deps::TargetArch::Wasm32,
        wasm_posix_shared::ABI_VERSION,
    )
}
```

(Use whichever `Registry` constructor the codebase exposes for a chosen
root; mirror `Registry::from_env` / the inline `Registry { roots: ... }`
form used in tests. `hex(&[u8;32])` already exists in `build_deps.rs`;
re-export or add a local helper.)

- [ ] **Step 4: Run test to verify it passes**

Run: `scripts/dev-shell.sh cargo test -p xtask verify_fresh -- --nocapture`
Expected: PASS (both new tests + the pre-existing verify-fresh ABI tests).

- [ ] **Step 5: Commit**

```bash
git add tools/xtask/src/local_build.rs
git commit -m "Packages: Fail verify-fresh loud on a stale kernel build key

verify-fresh now recomputes the kernel's expected cache key (via the same
function the build engine uses) and compares it to the stamp on the staged
kernel.wasm. Catches same-ABI staleness the ABI-only check missed.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Belt-and-suspenders — trusted cache-hit verifies the stamp

On the trusted (no-verify) cache-hit path, read the stamped key from the
cached artifact and confirm it equals the canonical entry's cache key.
Catches a corrupted/misfiled cache entry (the "wrong bytes at the right
key name", 933-vs-980 KB symptom) without a full re-hash.

**Files:**
- Modify: `tools/xtask/src/build_deps.rs` — `validate_cache_entry` (called by `source_only_cache_entry_is_trusted`, 8798-8814) or the trusted branch of `capture_source_only_package_authority` (8683-8723)
- Test: `tools/xtask/src/build_deps.rs` tests (near the trusted-entry tests, 35401-35455)

**Interfaces:**
- Consumes: `crate::build_stamp::read_build_key`; the `cache_key_sha` the entry is keyed under; the materialized wasm members' paths under `canonical`.
- Produces: a trusted hit whose wasm member's stamp ≠ the entry key is rejected loud.

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn trusted_entry_rejected_when_stamp_mismatches_key() {
    // Fabricate a compiled generation, then overwrite its wasm member with
    // bytes stamped for a DIFFERENT key. A trusted validate must reject it.
    let root = tempdir("trusted-stamp");
    // ... fabricate_compiled_generation(...) for a program "pkg" ...
    let canonical = /* fabricated canonical dir */;
    let member = canonical.join(/* mirror member path, e.g. "pkg.wasm" */);
    let bytes = std::fs::read(&member).unwrap();
    let tampered = crate::build_stamp::stamp_build_key(&bytes, &[0x99; 32]).unwrap();
    std::fs::write(&member, tampered).unwrap();

    let err = validate_cache_entry(
        &manifest, &canonical, TargetArch::Wasm32, TEST_ABI, &real_cache_key_hex,
    ).unwrap_err();
    assert!(err.contains("build key") || err.contains("stamp"), "{err}");
}
```

Use `fabricate_compiled_generation` (`local_build.rs:4723-4755`) — or its
build_deps equivalent — to produce a real canonical dir + receipt, and the
real `cache_key` hex it was fabricated under.

- [ ] **Step 2: Run test to verify it fails**

Run: `scripts/dev-shell.sh cargo test -p xtask trusted_entry_rejected_when_stamp -- --nocapture`
Expected: FAIL — `validate_cache_entry` does not inspect the stamp yet, so
the tampered entry validates.

- [ ] **Step 3: Write minimal implementation**

In `validate_cache_entry`, after the existing declared-output/wasm/provenance
checks, for each wasm member read its stamp and compare to the entry key:

```rust
    let expected_key = hex_to_32(cache_key_sha)?;
    for member in materialized_wasm_members(canonical)? {
        let bytes = std::fs::read(&member)
            .map_err(|e| format!("read cached member {}: {e}", member.display()))?;
        match crate::build_stamp::read_build_key(&bytes)? {
            Some(stamp) if stamp == expected_key => {}
            Some(stamp) => {
                return Err(format!(
                    "cached entry {} is corrupt: member {} carries build key {} \
                     but the entry is keyed {}. Rebuild with `--rebuild`.",
                    canonical.display(), member.display(), hex(&stamp), cache_key_sha
                ));
            }
            None => {
                return Err(format!(
                    "cached entry {} member {} has no build key stamp; rebuild.",
                    canonical.display(), member.display()
                ));
            }
        }
    }
```

Add `materialized_wasm_members(canonical) -> Result<Vec<PathBuf>, String>`
that reads the receipt sidecar (`read_source_only_cache_receipt`) and
returns the canonical paths of members whose `mirror_path` ends in
`.wasm`. This is a cheap section read, not a whole-tree re-hash, so the
trusted fast path stays fast.

- [ ] **Step 4: Run test to verify it passes**

Run: `scripts/dev-shell.sh cargo test -p xtask trusted_entry -- --nocapture`
Expected: PASS (new test + existing trusted-entry/receipt tests).

- [ ] **Step 5: Commit**

```bash
git add tools/xtask/src/build_deps.rs
git commit -m "Packages: Reject a trusted cache entry whose stamp != its key

The trusted (no-rehash) cache-hit path now reads each wasm member's
build-key stamp and rejects the entry if it does not match the key the
entry is stored under — catching wrong-bytes-at-right-key corruption.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: `verify-fresh` runs the ABI-snapshot drift check locally (B3)

Fold the CI-only snapshot freshness check into the local pre-test gate:
fail loud when the committed `abi/snapshot.json` has drifted from its
sources. Never overwrite the tracked file. Gate it so it only runs when
`crates/shared` or the kernel changed, keeping the no-op path clean.

**Files:**
- Modify: `tools/xtask/src/local_build.rs` (`verify_fresh_report`)
- Modify: `run.sh` (the `verify-fresh` invocation at 2631 already runs before the suites — no change needed if the check lives inside `verify_fresh_report`)
- Test: `tools/xtask/src/local_build.rs` tests

**Interfaces:**
- Consumes: the existing snapshot check. Prefer invoking
  `scripts/check-abi-version.sh` in check mode via the established
  `Command::new("bash")` pattern (`local_build.rs:433`), OR call the
  in-process `dump-abi --check` entry (`tools/xtask/src/dump_abi.rs`) if a
  library entry point is exposed. Do **not** reimplement the comparison.
- Produces: `verify_fresh_report` returns an error when the snapshot is
  stale, with the "run `bash scripts/check-abi-version.sh update`" hint;
  the tracked file is not modified.

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn verify_fresh_fails_on_snapshot_drift() {
    // temp repo whose abi/snapshot.json is deliberately out of sync with
    // its declared ABI sources; gate condition forced true.
    let repo = temp_repo_with_kernel(wasm_posix_shared::ABI_VERSION);
    // Corrupt the committed snapshot so it drifts from sources.
    let snap = repo.path().join("abi/snapshot.json");
    std::fs::write(&snap, r#"{"abi_version":4,"stale":"drifted"}"#).unwrap();
    let err = snapshot_drift_check(repo.path(), /*force=*/ true).unwrap_err();
    assert!(err.contains("snapshot") && err.contains("check-abi-version.sh update"), "{err}");
}

#[test]
fn verify_fresh_skips_snapshot_check_when_no_abi_sources_changed() {
    let repo = temp_repo_with_kernel(wasm_posix_shared::ABI_VERSION);
    // Gate false -> Ok even if the snapshot is nonsense.
    std::fs::write(repo.path().join("abi/snapshot.json"), "not-json").unwrap();
    snapshot_drift_check(repo.path(), /*force=*/ false).expect("gated off");
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `scripts/dev-shell.sh cargo test -p xtask verify_fresh_fails_on_snapshot_drift -- --nocapture`
Expected: FAIL — `snapshot_drift_check` does not exist.

- [ ] **Step 3: Write minimal implementation**

```rust
/// Fail loud if the committed abi/snapshot.json has drifted from its
/// sources. Regenerate-in-memory-and-compare only — never overwrite the
/// tracked file. `force` bypasses the change gate (used by tests / an
/// explicit flag); production callers pass the gate result.
pub(crate) fn snapshot_drift_check(repo: &Path, force: bool) -> Result<(), String> {
    if !force && !abi_sources_changed_since_snapshot(repo)? {
        return Ok(());
    }
    let status = std::process::Command::new("bash")
        .arg(repo.join("scripts/check-abi-version.sh"))
        .arg("check")
        .current_dir(repo)
        .status()
        .map_err(|e| format!("run check-abi-version.sh: {e}"))?;
    if !status.success() {
        return Err(
            "abi/snapshot.json has drifted from its sources. Run \
             `bash scripts/check-abi-version.sh update` and commit the result."
                .to_string(),
        );
    }
    Ok(())
}

/// Cheap gate: has any ABI-defining source changed more recently than the
/// committed snapshot? Compares snapshot mtime against the newest mtime
/// under crates/shared and the kernel crate. Conservative: any error or
/// ambiguity returns true (run the check) rather than skipping it.
fn abi_sources_changed_since_snapshot(repo: &Path) -> Result<bool, String> {
    let snap = repo.join("abi/snapshot.json");
    let snap_mtime = match std::fs::metadata(&snap).and_then(|m| m.modified()) {
        Ok(t) => t,
        Err(_) => return Ok(true),
    };
    for dir in ["crates/shared", "crates/kernel"] {
        if newest_mtime_under(&repo.join(dir))? > snap_mtime {
            return Ok(true);
        }
    }
    Ok(false)
}
```

Add a small `newest_mtime_under(dir) -> Result<SystemTime, String>` walker
(skip nothing; treat unreadable entries as "changed" → return a very
recent time / `Ok(true)` upstream). Then call
`snapshot_drift_check(repo, false)?` from `verify_fresh_report` after the
build-key check.

Rationale for mtime gating: it is a **gate**, not the safety check — a
false "changed" only costs one `check-abi-version.sh` run; the real
freshness guarantee is `check-abi-version.sh` itself. In CI (fresh
checkouts) mtimes are unreliable, so CI keeps running the full check
unconditionally via its own workflow; this gate only spares the local
no-op path.

- [ ] **Step 4: Run test to verify it passes**

Run: `scripts/dev-shell.sh cargo test -p xtask verify_fresh -- --nocapture`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tools/xtask/src/local_build.rs
git commit -m "Packages: Run the ABI-snapshot drift check in the local gate

verify-fresh now fails loud locally when the committed abi/snapshot.json
has drifted from its sources (regenerate-in-memory-and-compare via
check-abi-version.sh; never overwrites the tracked file), gated on ABI
sources changing so the no-op path stays fast.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: End-to-end validation of Stage 1

Prove the whole chain on the real repo: build the kernel through the
normal path, confirm the stamp lands, confirm a same-ABI edit is caught,
and confirm the no-op path speed is preserved.

**Files:** none (validation only).

- [ ] **Step 1: Provision + build the kernel through the normal path**

Run (under `scripts/dev-shell.sh`, from a clean state):
`./run.sh setup` (or `cargo xtask bootstrap kernel`)
Expected: builds `local-binaries/source-only-v1/kernel.wasm`.

- [ ] **Step 2: Confirm the stamp is present and correct**

Run: `scripts/dev-shell.sh cargo run -p xtask -- verify-fresh`
Expected: exit 0 (fresh: stamp matches expected key, ABI matches, snapshot
in sync).

- [ ] **Step 3: Same-ABI staleness is caught (the reported bug)**

Manually simulate the incident: edit a comment in `crates/kernel/src` (a
same-ABI change) **without** rebuilding, then:
Run: `scripts/dev-shell.sh cargo run -p xtask -- verify-fresh`
Expected: **exit non-zero**, "is stale: it was built for key … resolves to
key …". Then rebuild (`./run.sh setup`) and re-run: exit 0. Revert the
edit.

- [ ] **Step 4: `.cargo/config.toml` change invalidates the kernel key**

Confirm the Task 3 regression test passes against the real repo:
Run: `scripts/dev-shell.sh cargo test -p xtask kernel_key_changes_when_cargo_config`
Expected: PASS.

- [ ] **Step 5: No-op speed preserved**

With everything built and clean:
Run twice and compare: `time ./run.sh local-build` (no-op)
Expected: no-op stays within the measured budget (the memory baseline is
~7.5s; the added cost is `cargo metadata` + stamp reads + gated snapshot
check, all sub-second). Record the before/after numbers in the PR per the
Validation contract; do not claim "no regression" without the two numbers.

- [ ] **Step 6: Full xtask suite green**

Run: `scripts/dev-shell.sh cargo test -p xtask`
Expected: PASS. Commit nothing (validation task); note results for the PR.

---

## Stages 2–4 (separate plans, authored after Stage 1 lands)

- **Stage 2 — Generalize A + B1 + drift check.** Extend the `cargo:<crate>`
  tag and the build-key stamp/verify to `userspace.wasm` and any other
  Rust workspace-crate repository package; make the fork-instrument
  tool-input hash (`scripts/fork-instrument-tool-input-hash.sh`) derive
  from `cargo:fork-instrument`; add the loud drift check (a workspace-crate
  package that builds a crate but omits its `cargo:` tag fails loud). Spec
  Parts A (generalization), B1 (userspace), B2.
- **Stage 3 — Part C: guest contract-digest enforcement.** Stamp guests
  with `hash(abi/snapshot.json + ABI_VERSION)` and enforce it at exec in
  `host/src/worker-main.ts` (single shared check; digest threaded via
  `CentralizedWorkerInitMessage` in `worker-protocol.ts`, populated at the
  12 spawn sites in the two `*-worker-entry.ts` files, enforced once).
  Warn-then-enforce rollout. Requires resolving the guest injection point
  (no post-link rewrite step exists today — either a linker-emitted
  section or a walrus pass via fork-instrument). Node + browser parity.
- **Stage 4 — Part D: remove legacy read-paths.** Remove the
  `kernel.wasm`→`kandelo-kernel.wasm` alias (`binary-resolver.ts:233-234`),
  the `host/wasm/kandelo-kernel.wasm` staging (`run.sh:1961,1988,2756`) and
  npm exports (`host/package.json:101-104`), the hard-coded path in
  `teardown-reclaim.test.ts:26-32`, the browser fallbacks in
  `vite.config.ts:341-358`, and fix the doc drift in `main.rs:33-36`.
  Cross-host (Node + browser + npm).
