# Unified Build Front Door Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace three overlapping build front doors with one hermetic
command (`./run.sh setup`) over one typed orchestrator (`xtask
bootstrap`) that owns freshness by content identity, feeds one artifact
tier, and deletes the parallel bash build/freshness/product/clean
machinery in `run.sh`.

**Architecture:** Add a `bootstrap` path *inside* `tools/xtask/src/local_build.rs`
that reuses the existing local-build engine (`run_aggregate` /
`load_and_plan`) — which already builds `kernel` and `rootfs` as
`class = "platform"` package nodes — and additionally drives the two
host-side steps that are not graph nodes (the `fork-instrument` host
tool and the TypeScript `host/dist` build). Then collapse the two
`local-binaries` tiers, rewire `run.sh`'s `need_*`/`build_*` to the
engine, fold `build_*_vfs` into the declared product catalog, and
derive `clean` from the graph.

**Tech Stack:** Rust (xtask, `serde`, the crate's `parse_named_flags`
arg parser), Bash (`run.sh`, `scripts/*.sh`, dev shell via `nix
develop`), TypeScript (`host/src/binary-resolver.ts`, Vitest), Nix dev
shell (`scripts/dev-shell.sh`).

**Spec:** `docs/plans/2026-08-26-unified-build-front-door-design.md`
(read it first — this plan argues from it).

## Global Constraints

- **Dev-shell is the verification boundary.** Every build/verify claim
  runs inside `scripts/dev-shell.sh` (`nix develop --ignore-environment`).
  The only bash that remains above `xtask` is the thin shell-entry shim
  (the existing `scripts/run-local-build.sh` pattern; PATH pinned to
  `KANDELO_DEV_SHELL_TOOL_PATH`).
- **xtask is host-only.** Always invoke with an explicit host target:
  `cargo run -p xtask --target "$(rustc -vV | awk '/^host/{print $2}')" -- …`
  (the workspace default target is `wasm32-unknown-unknown`).
- **No ABI change.** Preserve the kernel ABI-staleness validation in
  `scripts/wasm-artifact-guards.sh` exactly. If any ABI-adjacent
  behavior changes, STOP — that is out of scope for this plan.
- **Build commands move byte-for-byte.** Commands relocated from
  `build.sh`/`run.sh` into xtask must run the same underlying tool
  invocation; this is a front-door/freshness change, not a recipe
  change. Validate with package/conformance suites, not code reasoning.
- **Node and browser land together.** The tier collapse (Stage 2)
  changes what both hosts resolve; both must end at the same artifact in
  the same commit. No Node-first/browser-later split.
- **`--dev` kernel fast lane is NOT in scope** unless the Stage 0
  measurement shows it is needed AND the maintainer explicitly approves
  it. Do not implement `--dev` in this plan without that approval.
- **Delivery:** one branch, one PR, rebase-merged, **one dedicated
  commit per stage**. Every commit must build and pass tests so the
  history bisects cleanly. Stage 0 is a throwaway spike (findings go in
  the PR description, not a commit).
- **Characterize before you change untested code.** Where a surface has
  no tests (notably the resolver policy selection — zero host tests
  today), first add characterization tests that pin *current* behavior
  and pass against the UNCHANGED code, then make the change. Do not
  refactor untested code without this net.
- **The `"source-only-v1"` policy string is duplicated** across ~8
  scripts, `run.sh`, and the generated `scripts/resolve-binary.bundle.mjs`.
  Any rename touches every one; prefer NOT renaming (keep the tier
  string, change only which policy reads which root).

---

## File Structure

Files created or modified, by stage. Exact edits are in the tasks.

- `tools/xtask/src/local_build.rs` — add the `bootstrap` verb + orchestration (Stage 1). *Owns:* the typed build orchestration that reuses `run_aggregate`.
- `tools/xtask/src/main.rs` — dispatch the new top-level `bootstrap` subcommand (Stage 1).
- `scripts/setup.sh` — new thin dev-shell shim for `./run.sh setup` (Stage 1). *Owns:* enter dev shell → invoke `xtask bootstrap`.
- `build.sh` — becomes a ~5-line deprecated wrapper delegating to `./run.sh setup` (Stage 1).
- `run.sh` — add `setup` dispatch (Stage 1); rewire `need_*`/`build_*` and delete `has_*` (Stage 3); route products to the catalog (Stage 4); route `clean` to xtask (Stage 5).
- `host/src/binary-resolver.ts` — converge default + source-only policies on one tier (Stage 2). *Owns:* resolution policy.
- `host/test/binary-resolver.test.ts` — new policy-selection tests (Stage 2).
- `scripts/resolve-binary.bundle.mjs` — regenerated after Stage 2 resolver change.
- `tools/xtask/src/local_build.rs` (clean derivation) + a new `xtask clean` surface (Stage 5).

---

## Stage 0 — Measurement spike (throwaway, not a commit)

Purpose: produce the real numbers the spec's Dev Iteration section
depends on, so the "always hermetic" default and the fast-lane question
are decided by data, not estimate. **No code is kept.** Record the
three numbers in the PR description.

- [ ] **Step 1: Warm dev-shell entry overhead.** From a warm Nix store:

Run:
```bash
time scripts/dev-shell.sh true
```
Record wall-clock. Repeat 3× after a first warm-up run; report the
median. This is the fixed cost the front door adds on every invocation.

- [ ] **Step 2: Incremental kernel rebuild (release, through the engine).**

Run (inside the dev shell):
```bash
scripts/dev-shell.sh bash -c '
  set -e
  h=$(rustc -vV | awk "/^host/{print \$2}")
  # touch one kernel source line
  touch crates/kernel/src/lib.rs
  time cargo build --release -p kandelo -Z build-std=core,alloc
'
```
Record wall-clock. This is the dominant per-edit cost today in both
`build.sh` and any hermetic path.

- [ ] **Step 3: No-op engine pass.** Confirm the scheduler no-op cost:

Run:
```bash
time ./run.sh local-build
```
on an already-built tree (expect the ~7.5s figure from prior work).
Record it.

- [ ] **Step 4: Decide + write findings.** In the PR description, state:
  the warm shell-entry median (Step 1), the incremental kernel rebuild
  time (Step 2), the no-op pass (Step 3). Conclude explicitly: "hermetic
  default confirmed" and either "no fast lane needed" or "fast lane
  proposed, pending maintainer approval (out of scope for this PR)."
  **Do not implement a fast lane in this PR.**

---

## Stage 1 — `xtask bootstrap` + `./run.sh setup` single front door

Commit subject: `Packages: Add xtask bootstrap and unified ./run.sh setup`

**Files:**
- Modify: `tools/xtask/src/local_build.rs` (add bootstrap verb + orchestration; `run` dispatch at 347-357; verb enum at 242-247)
- Modify: `tools/xtask/src/main.rs:59,68-83` (add top-level `bootstrap` subcommand + usage line)
- Create: `scripts/setup.sh`
- Modify: `run.sh:3020-3037` (add `setup)` dispatch), add `cmd_setup`
- Modify: `build.sh` (delegate)
- Test: `tools/xtask/src/local_build.rs` (unit test module — the file already has scheduler unit tests to co-locate with)

**Interfaces:**
- Consumes (existing, exact signatures):
  - `fn run_aggregate(args: LocalBuildRunArgsV1) -> Result<(), String>` (`local_build.rs:550`)
  - `struct LocalBuildRunArgsV1 { set: PathBuf, source_cache_root: PathBuf, output_root: PathBuf, products: Vec<String>, jobs: usize, rebuild: bool, verify_cache: bool }` (`local_build.rs:249-258`)
  - `enum LocalBuildCommandV1 { Plan{set}, Run(..), RunNode(..) }` (`local_build.rs:242-247`)
  - `fn parse_named_flags(args, singletons: &[&str], repeated: &[&str], switches: &[&str]) -> Result<ParsedFlagsV1, String>` (`local_build.rs:3486`)
  - `fn select_job_count(explicit: Option<&str>, environment: Option<&str>, available: Option<NonZeroUsize>) -> Result<usize, String>` (`local_build.rs:3565`)
  - `fn crate::repo_root() -> PathBuf` (`main.rs:128`)
- Produces (new, later stages + run.sh rely on these):
  - CLI: `xtask bootstrap [--jobs <n>] [--rebuild] [--verify-cache]` — runs the platform+all closure through the engine, plus the two host-side steps, into `local-binaries/source-only-v1`.
  - `fn run_bootstrap(args: Vec<String>) -> Result<(), String>` in `local_build.rs`, called from `main.rs`.

- [ ] **Step 1: Write the failing test for host-side step ordering.**

`fork-instrument` is consumed by the `msmtpd` package node, so it must
exist before the engine runs; `host/dist` consumes the program index,
so it builds after the engine (which regenerates the index). Pin that
contract with a test over a pure ordering helper. Add to the test module
in `local_build.rs`:

```rust
#[test]
fn bootstrap_step_order_builds_host_tool_before_engine_and_host_after() {
    let steps = bootstrap_step_plan();
    let names: Vec<&str> = steps.iter().map(|s| s.name).collect();
    assert_eq!(
        names,
        vec!["fork-instrument-tool", "engine", "host-dist"],
        "fork-instrument must precede the engine (msmtpd needs it); host/dist must follow (needs the regenerated program index)"
    );
}
```

- [ ] **Step 2: Run it to verify it fails.**

Run: `cargo test -p xtask --target "$(rustc -vV | awk '/^host/{print $2}')" bootstrap_step_order -- --nocapture`
Expected: FAIL — `bootstrap_step_plan` not defined.

- [ ] **Step 3: Implement `bootstrap_step_plan` and the orchestration.**

Add to `local_build.rs`. `bootstrap_step_plan()` returns the ordered
step list (pure, testable). `run_bootstrap` executes them, reusing
`run_aggregate` for the `engine` step. Host-side steps shell out to the
existing scripts so their commands stay byte-for-byte identical to
`build.sh` today.

```rust
pub(crate) struct BootstrapStep { pub name: &'static str }

pub(crate) fn bootstrap_step_plan() -> Vec<BootstrapStep> {
    vec![
        BootstrapStep { name: "fork-instrument-tool" },
        BootstrapStep { name: "engine" },
        BootstrapStep { name: "host-dist" },
    ]
}

pub(crate) fn run_bootstrap(args: Vec<String>) -> Result<(), String> {
    let repo = crate::repo_root();
    let mut flags = parse_named_flags(&args, &["--jobs"], &[], &["--rebuild", "--verify-cache"])?;
    let jobs = select_job_count(
        flags.values.remove("--jobs").as_deref(),
        std::env::var("WASM_POSIX_LOCAL_BUILD_JOBS").ok().as_deref(),
        std::thread::available_parallelism().ok(),
    )?;
    for step in bootstrap_step_plan() {
        match step.name {
            "fork-instrument-tool" => run_repo_script(&repo, "scripts/build-fork-instrument-tool.sh", &[])?,
            "engine" => run_aggregate(LocalBuildRunArgsV1 {
                set: repo.join("packages/sets/local-supported.toml"),
                source_cache_root: default_source_cache_root()?,
                output_root: repo.join("local-binaries/source-only-v1"),
                products: vec!["all".to_string()],
                jobs,
                rebuild: flags.switches.contains("--rebuild"),
                verify_cache: flags.switches.contains("--verify-cache"),
            })?,
            "host-dist" => run_repo_script(&repo, "scripts/build-host.sh", &[])?,
            other => return Err(format!("bootstrap: unknown step {other:?}")),
        }
    }
    Ok(())
}
```

Add helper `run_repo_script(repo, rel, args)` that runs `bash <repo>/<rel>`
inheriting stdio and returns `Err` on non-zero exit. Extract the current
`build.sh:38-42` host build (`cd host; npm install --prefer-offline; npm
run build`) into a new `scripts/build-host.sh` so both the engine path
and any caller share one definition (kills the verbatim `need_host`
duplication early).

NOTE on the stdout JSON: `run_aggregate` writes the machine-JSON
envelope to stdout. For Stage 1, `bootstrap` runs the engine as one
step and lets that envelope pass through; the front door
(`scripts/setup.sh`) does NOT parse it (unlike `local-build`, `setup` is
human-facing). A machine mode can be added later if needed.

- [ ] **Step 4: Run the test to verify it passes.**

Run: `cargo test -p xtask --target "$(rustc -vV | awk '/^host/{print $2}')" bootstrap_step_order`
Expected: PASS.

- [ ] **Step 5: Wire the top-level subcommand in `main.rs`.**

In `main.rs:68-83` add the arm and extend the usage list at line 59:
```rust
"bootstrap" => local_build::run_bootstrap(rest),
```
Add `bootstrap` to the `subcommands:` usage string (line 59) and a
doc line in the header comment (lines 3-25).

- [ ] **Step 6: Create `scripts/setup.sh` (thin dev-shell shim).**

Mirror `scripts/run-local-build.sh` structure (require
`KANDELO_DEV_SHELL_TOOL_PATH`, pin PATH, derive host target), but exec
`bootstrap`:
```bash
#!/usr/bin/env bash
# Internal runner for `./run.sh setup`. Enters nothing itself; must be
# invoked inside the repository dev shell (run.sh does that).
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
: "${KANDELO_DEV_SHELL_TOOL_PATH:?setup must run in the repository dev shell}"
export PATH="$KANDELO_DEV_SHELL_TOOL_PATH"
host_target="$(rustc -vV | awk '/^host/{print $2}')"
[ -n "$host_target" ] || { echo "setup.sh: no rustc host target" >&2; exit 1; }
exec cargo run -p xtask --target "$host_target" -- bootstrap "$@"
```

- [ ] **Step 7: Add `cmd_setup` + dispatch in `run.sh`.**

Add a `cmd_setup` that enters the dev shell and runs the shim (mirror
`cmd_local_build`'s dev-shell entry at `run.sh:2613-2616`, minus the
JSON capture):
```bash
cmd_setup() {
    exec bash "$REPO_ROOT/scripts/dev-shell.sh" \
        bash "$REPO_ROOT/scripts/setup.sh" "$@"
}
```
Add to the dispatch `case` (`run.sh:3020`): `setup)  cmd_setup "${@:2}" ;;`
and a `cmd_list` help line describing it as the one-command setup.

- [ ] **Step 8: Make `build.sh` a deprecated delegator.**

Replace `build.sh` body with:
```bash
#!/bin/bash
set -euo pipefail
echo "build.sh is deprecated; delegating to ./run.sh setup" >&2
exec "$(dirname "$0")/run.sh" setup "$@"
```

- [ ] **Step 9: Fresh-tree end-to-end verification.**

Run (from a clean checkout / after `git clean -xdf` on a scratch
worktree — NOT the working tree unless intended):
```bash
./run.sh setup
```
Expected: exits 0; `host/wasm/rootfs.vfs`, `host/dist/`,
`tools/bin/wasm-fork-instrument`, and `local-binaries/source-only-v1/`
all exist. Then run `./run.sh setup` again; expected: fast (engine
no-op ~seconds, host tool/host build skip or rebuild cheaply). Capture
both wall-clock times for the PR description.

- [ ] **Step 10: Update the living docs to the one command.**

`bash build.sh` is documented as the canonical entrypoint in several
*reference* docs. Point each at `./run.sh setup` (noting `build.sh`
still works as a deprecated delegator). Update ONLY living reference
docs — do NOT edit `docs/plans/2026-*` historical records:
- `docs/sdk-guide.md:25` (and the musl note at `:571`)
- `docs/architecture.md:2626`
- `docs/profiling.md:86`
- `docs/software-unit-tests.md:910`
- `docs/porting-guide.md:994` ("kandelo-kernel.wasm not found" → `./run.sh setup`)
- `docs/package-management.md:15`
Grep after: `grep -rn 'bash build.sh' docs/ README.md | grep -v docs/plans/`
→ expected: no living-doc hits remain.

- [ ] **Step 11: Commit.**
```bash
git add tools/xtask/src/local_build.rs tools/xtask/src/main.rs \
        scripts/setup.sh scripts/build-host.sh run.sh build.sh \
        docs/sdk-guide.md docs/architecture.md docs/profiling.md \
        docs/software-unit-tests.md docs/porting-guide.md docs/package-management.md
git commit -m "Packages: Add xtask bootstrap and unified ./run.sh setup"
```

---

## Stage 2 — One artifact tier (single source of truth)

Commit subject: `Packages: Converge Node and browser on one binary tier`

**Why this is wider than it looks:** the default policy reads inline
roots `local-binaries/` + `binaries/` (`binary-resolver.ts:274-277`);
the source-only policy reads only
`local-binaries/source-only-v1/` via `sourceOnlyBinaryRoot()`
(`binary-resolver.ts:1238`). There are **zero** host tests for policy
selection. Converging means the default (Node/Vitest) path also reads
the hermetic `source-only-v1` tier so there is one kernel, not two.

**Files:**
- Modify: `host/src/binary-resolver.ts` (`binaryCandidateTiers` at 268; `resolveBinary` at 3262)
- Create tests in: `host/test/binary-resolver.test.ts` (co-locate with the `binary resolver artifact policy` describe at 1029)
- Regenerate: `scripts/resolve-binary.bundle.mjs` (generated from the resolver)
- Modify: `tools/xtask/src/local_build.rs` — a small `verify-fresh` *pre-test* freshness check (NOT a divergence guard; see Step 8)

**Interfaces:**
- Consumes: `sourceOnlyBinaryRoot(): string | null` (1238), `SOURCE_ONLY_RESOLUTION_POLICY = "source-only-v1"` (1170), `binaryCandidateTiers()` (268), `resolverRepoRoot()` (106).
- Produces: a single authoritative tier list used by both policies; `xtask verify-fresh` that confirms the one kernel/host/rootfs is current before tests. **No divergence guard** — the second kernel copy is eliminated (Stages 1+3), so there is nothing to reconcile.

- [ ] **Step 1: Characterize the CURRENTLY-UNTESTED policy selection (add tests first).**

The policy-selection surface has **zero** host tests today
(`sourceOnlyPolicyEnabled` at 1226, `sourceOnlyBinaryRoot` at 1238, and
the `if (sourceOnlyPolicyEnabled())` branches at 1871/2552/2575/3263/
3344/3445). Before changing anything, add characterization tests that
lock in current behavior, so the collapse cannot silently alter it. Add
a describe `binary resolver policy selection (characterization)` to
`host/test/binary-resolver.test.ts`:

```ts
it("uses the source-only root when WASM_POSIX_RESOLUTION_POLICY=source-only-v1", () => {
  const repo = makeTempRepo();
  const root = join(repo, "local-binaries/source-only-v1");
  writeSourceOnlyProjectionWithKernel(root); // build a minimal valid projection + member
  process.env.WASM_POSIX_RESOLUTION_POLICY = "source-only-v1";
  process.env.WASM_POSIX_SOURCE_ONLY_BINARY_ROOT = root;
  expect(resolveBinary("kandelo-kernel.wasm")).toContain("source-only-v1");
});

it("throws when source-only policy is on but WASM_POSIX_SOURCE_ONLY_BINARY_ROOT is unset", () => {
  process.env.WASM_POSIX_RESOLUTION_POLICY = "source-only-v1";
  delete process.env.WASM_POSIX_SOURCE_ONLY_BINARY_ROOT;
  expect(() => sourceOnlyBinaryRoot()).toThrow(/requires WASM_POSIX_SOURCE_ONLY_BINARY_ROOT/);
});

it("rejects a non-absolute source-only root", () => {
  process.env.WASM_POSIX_RESOLUTION_POLICY = "source-only-v1";
  process.env.WASM_POSIX_SOURCE_ONLY_BINARY_ROOT = "relative/path";
  expect(() => sourceOnlyBinaryRoot()).toThrow(); // absolute-path guard at 1248
});

it("default policy (no env) reads local-binaries then binaries, not source-only", () => {
  delete process.env.WASM_POSIX_RESOLUTION_POLICY;
  const repo = makeTempRepo();
  writeKernelArtifact(join(repo, "local-binaries")); // legacy tier only
  process.env.WASM_POSIX_BINARY_RESOLVER_REPO_ROOT = repo;
  expect(resolveBinary("kandelo-kernel.wasm")).toContain("local-binaries");
});
```
Export `sourceOnlyBinaryRoot` is already public (1238); if
`sourceOnlyPolicyEnabled` is needed by a test, export it too (small,
test-only surface change). Build the fixtures with the file's existing
kernel/projection helpers — mirror `scripts/build-local-vfs-asset-group.test.ts`
(the only current source-only exerciser) for the projection layout.

- [ ] **Step 2: Run the characterization tests — they must PASS as-is.**

Run: `cd host && npx vitest run test/binary-resolver.test.ts -t "policy selection"`
Expected: ALL PASS against the UNCHANGED resolver. (If any fail, the
test encodes a wrong assumption about current behavior — fix the test,
not the resolver, until they pass green. This is the safety net for the
refactor.) Commit-worthy on its own, but it rides in this stage's commit.

- [ ] **Step 3: Write the failing test — default policy reads the hermetic tier.**

Now the NEW behavior. Add to the same file, describe `binary resolver
unified tier`. Place a kernel artifact ONLY under
`local-binaries/source-only-v1/` and assert the default
(non-source-only) resolver finds it:

```ts
it("resolves a kernel present only in the source-only tier under the default policy", () => {
  delete process.env.WASM_POSIX_RESOLUTION_POLICY; // default policy
  const repo = makeTempRepo();
  writeKernelArtifact(join(repo, "local-binaries/source-only-v1")); // abi-current
  process.env.WASM_POSIX_BINARY_RESOLVER_REPO_ROOT = repo;
  expect(resolveBinary("kandelo-kernel.wasm")).toContain("local-binaries/source-only-v1");
});
```

- [ ] **Step 4: Run it to verify it fails.**

Run: `cd host && npx vitest run test/binary-resolver.test.ts -t "unified tier"`
Expected: FAIL — default tiers don't include `source-only-v1`.

- [ ] **Step 5: Add the hermetic tier to the default tier list.**

In `binaryCandidateTiers()` (`binary-resolver.ts:268-303`), extend the
inline root loop (274-277) to include the source-only root when it
exists on disk, as the FIRST (authoritative) tier:
```ts
const tiers: BinaryCandidateTier[] = [];
const sourceOnly = join(repo, "local-binaries", "source-only-v1");
if (existsSync(sourceOnly)) {
  tiers.push({ label: "source-only-v1", identity: "source-only-generation", root: sourceOnly });
}
for (const [label, root] of [
  ["local-binaries", join(repo, "local-binaries")],
  ["binaries", join(repo, "binaries")],
] as const) { /* unchanged */ }
```
Keep `local-binaries/` and `binaries/` as lower-priority tiers so
non-kernel local outputs (built programs) still resolve; the redundant
ambient *kernel* copy is what goes away (Stages 1+3 stop installing it),
so `source-only-v1` is the only place a kernel lives. (Follow the exact
`BinaryCandidateTier` shape used at 281-303 for `label`/`identity`/`root`.)

- [ ] **Step 6: Run the test to verify it passes.**

Run: `cd host && npx vitest run test/binary-resolver.test.ts -t "unified tier"`
Expected: PASS. Then run the whole file: `npx vitest run
test/binary-resolver.test.ts` — expected: all PASS (no regression in the
existing artifact-policy/closure describes, and the Step 1
characterization tests still green).

- [ ] **Step 7: Regenerate the resolver bundle.**

The minified `scripts/resolve-binary.bundle.mjs` is generated from the
resolver and is consumed by `scripts/resolve-binary.sh`. Regenerate it
with the repo's existing bundling command (grep the build for how it is
produced, e.g. an esbuild step referenced near the bundle or in
`package.json` scripts) and verify it still reads
`WASM_POSIX_RESOLUTION_POLICY` / `WASM_POSIX_SOURCE_ONLY_BINARY_ROOT`.
Run: `git diff --stat scripts/resolve-binary.bundle.mjs` — expected: a
regenerated bundle, no hand edits.

- [ ] **Step 8: Add `xtask verify-fresh` PRE-TEST freshness check (failing test first).**

This is NOT a divergence guard (there is only one kernel copy after
Stages 1+3, so nothing can diverge). It closes the documented hazard
that Vitest/conformance can silently run a stale kernel
(`docs/plans/2026-08-25-rust-first-runtime-design.md:673`). Add a test
in the `local_build.rs` test module: given a single-tier tree whose
kernel declares a stale ABI version, `verify_fresh_report(repo)` returns
an error naming the kernel; a current kernel returns Ok.

```rust
#[test]
fn verify_fresh_flags_a_stale_abi_kernel() {
    let repo = temp_repo_with_kernel(/* abi = current - 1 */);
    let err = verify_fresh_report(&repo).unwrap_err();
    assert!(err.contains("kandelo-kernel.wasm") && err.contains("ABI"),
        "names the stale kernel and why");
}

#[test]
fn verify_fresh_ok_for_current_kernel() {
    let repo = temp_repo_with_kernel(/* abi = current */);
    assert!(verify_fresh_report(&repo).is_ok());
}
```
Run to fail; implement `verify_fresh_report` reusing the ABI-version
extraction already relied on by `scripts/wasm-artifact-guards.sh`
(extract the artifact ABI, compare to the source ABI); run to pass. Add
a top-level `verify-fresh` subcommand in `main.rs` forwarding to it, and
call it from `cmd_test` in `run.sh` before the suites run so a stale
kernel fails loud instead of silently passing tests.

- [ ] **Step 9: Full host test + package resolution smoke.**

Run: `cd host && npx vitest run test/binary-resolver.test.ts`
Run (Node resolution end-to-end): `./run.sh test <a fast suite that
resolves a package binary>` — confirm it now resolves the hermetic
kernel. Both hosts (Node here; browser via `./run.sh browser` smoke or
the browser resolver test) must resolve the same artifact — record the
browser check per the Global Constraint.

- [ ] **Step 10: Commit.**
```bash
git add host/src/binary-resolver.ts host/test/binary-resolver.test.ts \
        scripts/resolve-binary.bundle.mjs tools/xtask/src/local_build.rs \
        tools/xtask/src/main.rs
git commit -m "Packages: Converge Node and browser on one binary tier"
```

---

## Stage 3 — Rewire `need_*`/`build_*` at xtask; delete the bash freshness engine

Commit subject: `Packages: Route run.sh build path through xtask, delete has_* engine`

**Files:**
- Modify: `run.sh` — `has_*` (332-337, 224-233 kernel), `need_*` (435-523), `build_*` (527-2081), `build_target` (2082-2158)

**Interfaces:**
- Consumes: `xtask bootstrap <target>` (Stage 1 produces the whole-tree
  build; this stage adds single-target selection). Extend `run_bootstrap`
  to accept an optional positional target that maps to a product/package
  id or one of `kernel|host|rootfs|sysroot|sysroot64|fork-instrument`.
- Produces: `need_*` helpers that are thin delegators (names unchanged,
  so run/test/browser call sites are untouched — Global Constraint).

- [ ] **Step 1: Extend `bootstrap` with single-target selection (failing test).**

Add a test that `bootstrap_target_to_selection("kernel")` yields the
engine `--product`/package selection for the kernel node, and that
`"host"`/`"fork-instrument"` map to the host-side steps only:
```rust
#[test]
fn bootstrap_single_target_maps_to_engine_or_host_step() {
    assert_eq!(bootstrap_target_to_selection("kernel"), Selection::Package("kernel".into()));
    assert_eq!(bootstrap_target_to_selection("host"), Selection::HostStep("host-dist"));
    assert_eq!(bootstrap_target_to_selection("fork-instrument"), Selection::HostStep("fork-instrument-tool"));
}
```
Run to fail; implement `bootstrap_target_to_selection` + thread it
through `run_bootstrap` (a bare `bootstrap` = all; `bootstrap <target>` =
that selection); run to pass.

- [ ] **Step 2: Preserve the kernel ABI-staleness semantics.**

The one real freshness check today is `has_valid_kernel_file`
(`run.sh:224-233` → `wasm-artifact-guards.sh`). The engine already
rebuilds the kernel node on content change, but the ABI/exports/asyncify
*validation* of an existing artifact must remain. Add a test that
`xtask bootstrap kernel` rebuilds when the on-disk kernel declares a
stale ABI. Concretely, assert the kernel node's cache key incorporates
the ABI version (it does via the resolver); if not already covered by an
engine test, add one. Do NOT delete `wasm-artifact-guards.sh` — it is
still used by CI checks.

- [ ] **Step 3: Convert each `need_*` to a delegator.**

Replace the bodies of the seven `need_*` (run.sh:435-523) so each calls
`xtask bootstrap <target>` inside the dev shell instead of the
`has_*`-guarded script. Keep the function NAMES and call signatures.
Exact mapping:
- `need_kernel` → `bootstrap kernel`
- `need_sysroot` → `bootstrap sysroot`
- `need_sysroot64` → `bootstrap sysroot64`
- `need_sdk` → `bootstrap sdk` (still errors if `wasm32posix-cc` absent after)
- `need_host` → `bootstrap host`
- `need_rootfs` → `bootstrap rootfs`
- `need_fork_instrument` → `bootstrap fork-instrument`
- `need_node_modules` → unchanged (root npm; not a build artifact) OR fold as `bootstrap node-modules` if trivial.

- [ ] **Step 4: Delete the `has_*` predicates.**

Remove `has_kernel`/`has_sysroot`/`has_sysroot64`/`has_sdk`/`has_host`/
`has_rootfs` (run.sh:332-337) and any now-unreferenced `has_*` helpers.
Grep to confirm no remaining callers: `grep -n 'has_kernel\|has_sysroot\|has_host\|has_rootfs\|has_sdk' run.sh` → expected: no matches outside the deleted region.

- [ ] **Step 5: Point `build_target` package builders at the engine.**

The `build_*` package builders (nginx/php/…, run.sh:574-2057) each call
`need_kernel`+`need_sdk` then a package build script. Since the engine
builds every package node, replace each `build_<pkg>` body with `xtask
bootstrap <pkg>` (or route `build_target` for package ids straight to
`bootstrap`). Keep platform builders (`build_kernel` etc.) as delegators
too. Preserve the `KANDELO_REBUILD_TARGET` behavior by mapping `rebuild`
to `bootstrap --rebuild <target>`.

- [ ] **Step 6: Confirm the ambient kernel copy is gone (single-tier proof).**

The single-kernel outcome depends on NOTHING installing a kernel into
ambient `local-binaries/` anymore. Grep for residual installers:
```bash
grep -rn 'install_local_binary kernel\|kandelo-kernel.wasm' \
  build.sh run.sh scripts/ packages/registry/kernel/ | grep -v source-only-v1
```
Expected: no path that writes `kandelo-kernel.wasm` into
`local-binaries/` (only the engine's `source-only-v1` install remains).
If `packages/registry/kernel/build-kernel.sh` still installs to the
ambient tier, remove that install (the engine owns kernel placement).

- [ ] **Step 7: Verify build + a representative package.**

Run: `./run.sh build kernel` then `./run.sh build php` (or another
source package) — expected: both resolve through xtask, exit 0, produce
the same artifacts. Run the xtask test suite:
`cargo test -p xtask --target "$(rustc -vV | awk '/^host/{print $2}')"` — PASS.

- [ ] **Step 8: Commit.**
```bash
git add run.sh tools/xtask/src/local_build.rs tools/xtask/src/main.rs \
        packages/registry/kernel/build-kernel.sh
git commit -m "Packages: Route run.sh build path through xtask, delete has_* engine"
```

---

## Stage 4 — Fold `build_*_vfs` into the declared product catalog

Commit subject: `Packages: Build VFS products from the declared catalog`

**Files:**
- Modify: `run.sh` — `build_*_vfs` functions (build_shell_vfs 1452, build_wp_vfs, build_lamp_vfs, …) and their `build_target` cases (2102-2153)
- Reference: `packages/sets/local-supported.toml` `[[products]]` (schema at `local_build.rs:81-91`), `images/vfs/products/generated/catalog.json`

**Interfaces:**
- Consumes: the engine's product build (`run_aggregate` with
  `products = [<id>]`) — products are already declared in
  `local-supported.toml` and the catalog is generated at engine start
  (`generate_vfs_product_catalog`, `local_build.rs:402`).
- Produces: `./run.sh build <product-id>` resolves to a catalog product
  via `bootstrap`, not a bespoke bash function.

- [ ] **Step 1: Enumerate the gap (test).**

Add an xtask test asserting every `build_*_vfs` target in `run.sh` has a
matching `[[products]]` id in `local-supported.toml`. Implement a small
helper `declared_product_ids(set) -> BTreeSet<String>` and, in the test,
compare against the known run.sh product list (shell-vfs → a product id,
wp-vfs → …). Any run.sh product with no declared counterpart is a gap to
add to the set BEFORE deleting the bash function.

- [ ] **Step 2: Add any missing product declarations.**

For each gap from Step 1, add a `[[products]]` entry to
`local-supported.toml` (`id`, `package`, `manifest` →
`images/vfs/products/<id>.toml`, optional `package_dependencies` /
`root_mirror_packages`) so the product is buildable by the engine.
Run: `xtask vfs products generate` (via `generate_vfs_product_catalog`)
and confirm `images/vfs/products/generated/catalog.json` includes them.

- [ ] **Step 3: Route product targets to `bootstrap`.**

In `build_target` (run.sh:2082-2158), map every `*-vfs`/product target
to `xtask bootstrap <product-id>` and delete the corresponding
`build_*_vfs` bash function bodies. Keep the target NAMES so
`./run.sh build shell-vfs` still works.

- [ ] **Step 4: Verify a product builds identically.**

Run: `./run.sh build shell-vfs` — expected: produces the same
`shell.vfs.zst` the bash builder did (compare presence + that the
browser demo still loads it via `./run.sh browser` smoke). Do this for
one representative product per package family.

- [ ] **Step 5: Commit.**
```bash
git add run.sh packages/sets/local-supported.toml images/vfs/products \
        tools/xtask/src/local_build.rs
git commit -m "Packages: Build VFS products from the declared catalog"
```

---

## Stage 5 — Derive `clean` from the graph (+ optional revision-drift warning)

Commit subject: `Packages: Derive clean from the build graph with cascade`

**Files:**
- Modify: `tools/xtask/src/local_build.rs` (add `clean` derivation)
- Modify: `tools/xtask/src/main.rs` (dispatch `clean`)
- Modify: `run.sh` — `clean_target` (2234-2544), route to xtask

**Interfaces:**
- Consumes: `PlannedGraphV1` (`local_build.rs:110-125`) — the graph
  knows each node's output paths and the products that embed it.
- Produces: `xtask clean <target>` that removes a node's outputs AND
  cascades to products that embed it (replacing the manual
  "also invalidated shell.vfs.zst" warnings).

- [ ] **Step 1: Failing test — clean cascade.**

Assert that cleaning a leaf package (e.g. `nethack`) returns a removal
set that includes the products embedding it (the shell product /
`shell.vfs.zst`), derived from graph edges, not a hand list:
```rust
#[test]
fn clean_cascades_to_products_embedding_the_package() {
    let graph = load_test_graph();
    let removal = clean_removal_set(&graph, &PlanNodeV1::Package{ name:"nethack".into(), target_arch:"wasm32".into() });
    assert!(removal.iter().any(|n| matches!(n, PlanNodeV1::Product{ id } if id.contains("shell"))),
        "cleaning nethack invalidates the shell product that embeds it");
}
```
Run to fail; implement `clean_removal_set(graph, node)` by walking
reverse edges over `PlannedGraphV1.dependencies`; run to pass.

- [ ] **Step 2: Implement `xtask clean` + dispatch.**

Add `clean_removal_set` → resolve each node's on-disk outputs → `rm`
them; print the derived cascade (what else was invalidated) instead of a
static `warn`. Add `"clean" => local_build::run_clean(rest)` in
`main.rs`.

- [ ] **Step 3: Route `run.sh clean` to xtask.**

Replace `clean_target` (run.sh:2234-2544) with a delegator to `xtask
clean <target>` inside the dev shell, keeping the immutable `binaries/`
protection note (run.sh:1462-1465). Keep the target names.

- [ ] **Step 4 (optional, gated): revision-drift warning.**

If time permits and the maintainer wants it, add an `xtask verify-fresh
--revisions` mode that warns when a package's source-tree hash changed
but `build.toml` `revision`/`commit` did not. Test with a fixture where
source changes without a revision bump → warning emitted. This is the
lowest-priority item; skip if it risks the single-PR scope.

- [ ] **Step 5: Verify clean cascade end-to-end.**

Run: `./run.sh clean nethack` — expected: removes nethack outputs AND
reports the shell product invalidation; `./run.sh build shell-vfs`
rebuilds cleanly afterward.

- [ ] **Step 6: Commit.**
```bash
git add tools/xtask/src/local_build.rs tools/xtask/src/main.rs run.sh
git commit -m "Packages: Derive clean from the build graph with cascade"
```

---

## Final verification (before opening the PR)

- [ ] Fresh worktree: `git clean -xdf` on a scratch checkout, then
  `./run.sh setup` → exits 0, all artifacts present, no prior `build.sh`.
- [ ] No-op speed: second `./run.sh setup` is fast; record the number.
- [ ] Freshness: touch `crates/kernel/src/lib.rs` → `./run.sh setup`
  rebuilds only the kernel closure; touch nothing → no-op.
- [ ] Divergence: `xtask verify-fresh` passes on the single-tier tree.
- [ ] `cargo test -p xtask --target <host>` green.
- [ ] `cd host && npx vitest run` green (includes new policy tests).
- [ ] Node and browser resolve the same single-tier kernel
  (`./run.sh test <fast suite>` + `./run.sh browser` smoke).
- [ ] Relevant conformance suites considered per the Validation
  Contract (any syscall/process/fd/ABI-adjacent surface untouched here,
  but confirm the moved build commands produced byte-identical package
  artifacts — spot-check sha256 of one rebuilt package vs pre-change).
- [ ] History: one commit per stage, each builds and tests green
  (`git rebase --exec 'cargo test -p xtask --target <host>' main` to
  confirm bisectability).

## Self-review notes (author checklist, done)

- **Spec coverage:** Stage 1 = Components 1+4 (bootstrap, front door,
  build.sh delegate); Stage 2 = Components 2+8 (single tier + verify-fresh);
  Stage 3 = Components 3+5 (content freshness, delete bash engine); Stage
  4 = Component 6 (product catalog); Stage 5 = Component 7 (+ optional
  revision drift). Stage 0 = the spec's measured-spike gate. All spec
  components mapped.
- **Fast-lane guard:** honored — `--dev` is explicitly out of scope
  pending measurement + approval (Global Constraints, Stage 0 Step 4).
- **Type consistency:** `run_bootstrap`, `bootstrap_step_plan`,
  `bootstrap_target_to_selection`, `verify_fresh_report`,
  `clean_removal_set` are the new names used consistently across stages;
  reused engine signatures copied verbatim from source
  (`LocalBuildRunArgsV1`, `run_aggregate`, `parse_named_flags`,
  `select_job_count`, `PlannedGraphV1`, `PlanNodeV1`).
