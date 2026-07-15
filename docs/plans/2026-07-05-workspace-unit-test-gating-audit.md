# Workspace unit-test gating audit — broaden the cargo gate to `--workspace`

- **Bead:** kd-7yjx (initiative `validation-gates`, umbrella convoy kd-u7f)
- **Discovered from:** kd-872c (which gated `cargo test -p xtask`) → open question from kd-xc19
- **Author:** designer-adhoc-f8a9bbfb5b, 2026-07-05
- **Status:** design + audit complete; implementation deferred to a follow-up bead
- **Audited base:** `origin/main` @ `24668156b` (ABI 16), under `scripts/dev-shell.sh`
- **Evidence:** `test-runs/kd-7yjx/` (per-crate logs, workspace run, control run, outcome lists, SUMMARY.md)

## 1. Problem statement

The `validation-gates` initiative (kd-u7f) exists because CI test gates rotted
silently. kd-xc19 traced 7 stale `xtask` fixtures that went unnoticed for a month
because **CI never ran `xtask`'s unit tests**: `scripts/ci-run-test-suite.sh` runs
cargo tests for only two packages, and `prepare-merge` builds `xtask` but never runs
its unit tests. kd-872c repairs those fixtures and gates `cargo test -p xtask`.

kd-872c fixes *one* crate. The structural question this bead answers: **which other
workspace crates' unit tests does CI never run, are any of them silently rotting, and
should the gate be broadened to `cargo test --workspace` instead of accreting one
per-crate suite at a time?**

The deeper defect is not "xtask was un-gated." It is that **the gate is an explicit
allow-list of packages**, so every new crate — and every crate that already existed
when the allow-list was written — is un-gated *by default* until a human remembers to
add it. That is the exact failure mode that let the xtask fixtures rot. A per-crate
allow-list cannot fix the class of bug it is an instance of.

### Non-goals

- **Not** repairing the 7 xtask fixtures or gating xtask per-crate — that is kd-872c
  (PR #836), already done and depended upon here.
- **Not** changing what the kernel/fork-instrument suites assert. `--workspace` is a
  strict superset; those crates keep running exactly as today.
- **Not** adding new tests to under-tested crates (e.g. `userspace` has 0 tests). Test
  authorship is separate work; this bead is about *gating what already exists*.
- **Not** touching the non-cargo suites (vitest/browser/libc/posix/sortix). Those gate
  runtime/host/conformance behavior and are orthogonal.
- **Not** gating wasm-target builds. The kernel's *product* build targets wasm32; this
  is only about **host-run unit tests**.

## 2. Audit findings (evidence)

The workspace has **6 members** (`Cargo.toml`). Default build target is
`wasm32-unknown-unknown` (`.cargo/config.toml`), which has **no host test runner** —
so every cargo *test* invocation must pass an explicit `--target <host>`.

CI's cargo surface (`scripts/ci-run-test-suite.sh`, matrix in
`.github/workflows/prepare-merge.yml` lines 1378–1414) is exactly two suites:

- `cargo-kernel` → `cargo test -p kandelo --target <host> --lib`
- `fork-instrument` → `cargo test -p fork-instrument --target <host>`

`docs/agent-guidance/validation.md` documents only those two.

| Package | Member | Host tests | Result | CI-gated? | Notes |
|---|---|---|---|---|---|
| `kandelo` | `crates/kernel` | 963 (lib) | pass | **yes** | `--lib`; crate has no `tests/` dir |
| `fork-instrument` | `crates/fork-instrument` | 177 (25 lib + 152 integ) | pass | **yes** | includes `tests/` (no `--lib`) |
| `wasm-posix-shared` | `crates/shared` | 19 (lib) | pass | **no** | un-gated, clean |
| `wasm-posix-userspace` | `crates/userspace` | 0 | n/a | no | no tests to gate |
| `wasm-local-root-spill` | `crates/wasm-local-root-spill` | 13 (integration) | pass | **no** | un-gated, clean; see `--lib` trap below |
| `xtask` | `tools/xtask` | 314 (307 pass / **7 fail**) | fail | **no** | the kd-xc19/kd-872c fixtures; PR #836 pending |

**Latent rot found: none beyond xtask.** `wasm-posix-shared` (19) and
`wasm-local-root-spill` (13) are un-gated but green. `xtask`'s 7 failures are the
already-triaged (kd-xc19) and already-fixed (kd-872c/PR #836) stale fixtures — not a
new discovery, so no new failure-triage bead is warranted.

**The `--lib` trap (concrete reason to prefer `--workspace` over hand-written
per-crate lines):** `wasm-local-root-spill`'s 13 tests live in `tests/root_spill.rs`
and the crate also has a `main.rs` bin target. A gate written by pattern-matching the
existing `cargo-kernel` line (`-p <crate> --lib`) would compile the crate and run
**zero** tests while looking green. `--workspace` runs lib + bin + integration test
binaries uniformly, so it cannot fall into this trap.

### Two decisive experiments

1. **`cargo test --workspace --target aarch64-apple-darwin`** → builds clean in 22.5s;
   runs all 18 test binaries; **1479 passed, 7 failed (all xtask), 0 ignored**. It is a
   strict superset of today's two suites (same 963 kernel + 177 fork-instrument tests)
   plus the three un-gated crates. Once PR #836 lands, this run is fully green.

2. **Naive `cargo test --workspace` (default target `wasm32-unknown-unknown`)** →
   **fails to compile** (exit 101). `getrandom` hard-errors on wasm32-unknown-unknown;
   `xtask`'s host-only native deps (`ring`, `zstd-sys`) cannot cross-compile with host
   `cc` flags. **A workspace gate must therefore pass `--target <host>`** — you cannot
   drop `cargo test --workspace` into CI without it.

## 3. Users and operator workflows

- **PR author / reviewer:** wants merge-blocking CI to actually run the tests that
  exist. Today they can add a crate with tests and CI silently ignores it. After this
  change, any workspace crate's host tests block merges automatically.
- **Future crate author:** adds `crates/foo` to the workspace; its tests are gated with
  zero CI edits. This is the durable win — no allow-list to remember.
- **Local pre-merge:** one command mirrors the cargo gate:
  `bash scripts/dev-shell.sh cargo test --workspace --target "$(rustc -vV | awk '/^host/{print $2}')"`.
- **Debugger triaging a red gate:** the failing binary is named in the `test result:`
  line and the `failures:` block, per-package, exactly as today.

## 4. Architecture / control flow of the change

```
prepare-merge.yml (test-suite matrix)
  └─ suite: cargo-workspace           # replaces suites cargo-kernel + fork-instrument
       └─ scripts/ci-run-test-suite.sh cargo-workspace
            └─ cargo test --workspace --target "$(host_target)"
                 ├─ kandelo (963)        ┐
                 ├─ fork-instrument (177)│ superset of today
                 ├─ wasm-posix-shared(19)│ newly gated
                 ├─ wasm-local-root-spill(13)
                 ├─ wasm-posix-userspace (0)
                 └─ xtask (314)          ┘ requires PR #836 green first
```

`.cargo/config.toml` already sets `RUST_TEST_THREADS=1` (kernel globals assume
single-threaded access); this applies to every test binary, and cargo runs test
binaries sequentially by default, so `--workspace` preserves the serialization the
kernel tests rely on.

## 5. Decision

**Adopt a single `cargo-workspace` suite running
`cargo test --workspace --target <host>`, replacing the `cargo-kernel` and
`fork-instrument` suites, sequenced *after* kd-872c/PR #836 makes `xtask` green.**

Rationale:

1. **Root-cause fix, not another instance.** `--workspace` is closed-by-default:
   present and future crates are gated without anyone editing an allow-list. Per-crate
   gates re-implement the very "someone forgot to add it" mechanism that caused kd-xc19.
2. **No coverage regression.** It runs the same kernel + fork-instrument tests plus the
   currently-invisible `shared` and `wasm-local-root-spill` tests.
3. **Avoids the `--lib` trap** that a hand-written per-crate line for
   `wasm-local-root-spill` would fall into (0 tests run, looks green).
4. **Cheap and fast.** ~22.5s cold build; run dominated by xtask (~17s), kernel 963
   tests in 0.10s. Net CI cost is *lower* than today's two separate suites (one job,
   one compile of the shared dep graph instead of two).
5. **Simpler to maintain.** One suite line and one `validation.md` row, versus a growing
   list that must be hand-extended per crate (kd-872c would add a third; this collapses
   them).

## 6. Alternatives considered

- **A: Per-crate gates (add `cargo test -p wasm-posix-shared`, `-p wasm-local-root-spill`,
  keep xtask separate).** Rejected as the primary path: it perpetuates the allow-list
  failure mode, needs a new line per future crate, and invites the `--lib` trap. Kept as
  a **fallback** if `--workspace` proves undesirable in CI packaging (see risks) — the
  per-crate commands are known-good and green (except xtask/#836).
- **B: Do nothing; document that only kernel + fork-instrument are gated.** Rejected: the
  bead's parent initiative is *about* closing this gap; leaving `shared`/`spill` un-gated
  keeps the silent-rot door open.
- **C: `cargo test --workspace` without `--target`.** Rejected by experiment — it does
  not compile (wasm32 default target; host-only deps). Not viable.
- **D: Fold the workspace gate into kd-872c/PR #836.** Attractive if #836 is unmerged,
  but #836 is closed and scoped to xtask; retargeting it risks scope creep and re-review.
  Preferred: a small follow-up that supersedes #836's per-crate xtask suite once #836 is
  green. If #836 is still open when the follow-up starts, folding in is acceptable.
- **E: Keep `-p kandelo --lib` semantics (exclude integration tests) for consistency.**
  Rejected: `--workspace` should run integration tests where they exist
  (`fork-instrument`, `wasm-local-root-spill`); `--lib` would silence real coverage.

## 7. Risks and mitigations

- **R1 — Gate turns red on merge if landed before #836.** The workspace run is red today
  purely because of xtask. *Mitigation:* hard ordering — land the `cargo-workspace` suite
  only after PR #836 (xtask green) merges to `origin/main`. Same green-before-gate
  constraint kd-872c already operates under. The follow-up bead carries a `depends-on`
  edge to kd-872c.
- **R2 — Interaction with #836's per-crate xtask suite.** If #836 adds a `cargo-xtask`
  suite and this adds `cargo-workspace`, xtask would run twice. *Mitigation:* the
  follow-up **replaces** cargo-kernel + fork-instrument (+ xtask if #836 added it) with
  the single workspace suite; net suite count drops.
- **R3 — A future crate legitimately can't build/run on host** (e.g. a wasm-only crate
  with no host-runnable tests). `--workspace` would try to compile it. *Mitigation:*
  such a crate should carry `#![cfg(...)]`/`#[cfg(not(target_arch="wasm32"))]` test
  guards or be `default-members`-excluded; document the expectation in `validation.md`.
  Today all 6 members compile on host, so this is a forward-looking guard, not a current
  blocker.
- **R4 — CI caching / build-graph differences.** Merging two jobs into one changes the
  cache key and parallelism. *Mitigation:* the two cargo suites already share the same
  dep graph and toolchain; one job compiles it once instead of twice. Verify wall-clock
  on the impl PR; fall back to Alternative A if a packaging constraint surfaces.
- **R5 — Slower feedback: one red crate fails the whole suite.** True of any aggregated
  gate. *Mitigation:* `cargo test` reports per-binary results and the failing package is
  named; `--no-fail-fast` can be added if per-crate isolation is wanted without splitting
  suites.
- **R6 — Doctests.** The host `--workspace` run executed 0 doctests (every crate's
  doctest harness is empty; confirmed 0 in per-crate runs). No regression vs
  `-p kandelo --lib` (which also excludes doctests). If doctests are later added, decide
  explicitly whether the gate should include them (`--doc`).

## 8. Implementation sequence (for the follow-up bead)

1. **Precondition:** kd-872c/PR #836 merged to `origin/main`; confirm
   `cargo test -p xtask --target <host>` is green on main.
2. Add a `cargo-workspace` case to `scripts/ci-run-test-suite.sh`:
   `cargo test --workspace --target "$(host_target)"`.
3. In `.github/workflows/prepare-merge.yml` (and `staging-build.yml`,
   `force-rebuild.yml` which share the runner), replace the `cargo-kernel` and
   `fork-instrument` matrix entries (and any `cargo-xtask` #836 added) with a single
   `cargo-workspace` entry (`kernel_only: true`, no submodules/toolchain/workspace).
   Check `.github/actions/detect-change-scope` path rules so crate/tooling changes
   trigger the new suite.
4. Update `docs/agent-guidance/validation.md`: collapse the two cargo rows into one
   `Workspace unit tests | cargo test --workspace --target <host> | Any Rust crate change`
   row; keep the `<host-target>` computation note.
5. Run `bash scripts/dev-shell.sh bash scripts/ci-run-test-suite.sh cargo-workspace`
   locally; publish before/after outcome lists on the bead.
6. Open a PR to `Automattic/kandelo` (origin); record `github_pr`; run
   `kandelo_pr_remote_policy.sh patrol`.

## 9. Test and documentation plan

- **Test:** the change *is* a test-gate change; validate by running the new suite
  locally under dev-shell (green expected once #836 lands) and by observing the suite
  execute in the PR's own prepare-merge run. Outcome lists (passed/failed/skipped)
  published per the convoy artifact rule.
- **Docs:** `validation.md` suite table (step 4 above). No ABI, package, browser, or
  host-runtime docs are affected (no product behavior changes).

## 10. Open questions

1. **Fold-in vs supersede #836?** If PR #836 is still open when the follow-up begins,
   fold the workspace suite into it (single review); otherwise supersede. Coordinator to
   confirm which, based on #836's merge status.
2. **`--no-fail-fast`?** Should the workspace suite continue past the first failing crate
   to surface all failures in one run? Low-cost; recommend yes unless CI log volume is a
   concern.
3. **Forward guard for host-unbuildable crates (R3).** Do we want a documented convention
   now (cfg-guard test code / exclude from default-members) so the first wasm-only crate
   doesn't break the gate, or defer until such a crate appears? Recommend a one-line note
   in `validation.md` now.
4. **`default-members`.** The workspace sets no `default-members`; `--workspace` is
   explicit and unaffected, but if `default-members` is later narrowed, the gate must
   keep `--workspace` (not bare `cargo test`) to stay exhaustive.

---

## 11. Addendum — implementation (kd-i9oc, 2026-07-06)

Implementer: `designer-adhoc-f8a9bbfb5b`. Re-verified against `origin/main` @
`24668156b` (unchanged since the audit) under `scripts/dev-shell.sh`. This
addendum records a **gating asymmetry** that the body of the design did not
fully reckon with, the two coherent strategies it produces, and the resolution
of §10's open questions. **It changes the recommended implementation shape** and
requests one coordinator decision.

### 11.1 State of PR #836 at implementation time

`gh pr view 836`: `state=OPEN`, `mergeable=MERGEABLE`, `mergeStateStatus=BLOCKED`,
`reviewDecision=REVIEW_REQUIRED` — CI green (cargo-kernel, fork-instrument
SUCCESS) but **not merged** (needs review approval). The dependency bead kd-872c
is *closed*, but per the Kandelo PR convention (close on reviewable-PR-opened, not
on merge) closed ≠ merged. So `origin/main` still contains the 7 failing xtask
fixtures. The body's §8.1 precondition ("#836 merged to origin/main") is therefore
**not met today**.

### 11.2 The gating asymmetry the body missed

The body treated the two cargo suites as interchangeable (both `kernel_only:
true`). Inspecting what #836 actually did reveals they are not:

- #836 adds its `cargo-xtask` suite as **`kernel_only: false` (always-run)**, with
  the rationale "xtask regressions are independent of kernel changes." It does
  **not** touch `detect-change-scope`.
- The reason it must be always-run: `xtask` lives under `tools/xtask/`, which is
  **outside** the `kernel` change-scope. `kernel_runtime_changed_files()` fires
  `kernel=true` for `^(crates|libc|…)/` — i.e. all *five* non-xtask members
  (`crates/{kernel,fork-instrument,shared,userspace,wasm-local-root-spill}`) but
  **not** `tools/xtask/`.

So a single `cargo test --workspace` suite (which necessarily runs all six
members in one invocation) faces a **trilemma**, because one gate cannot be two
trigger-classes at once:

| Option | xtask-only change | non-crates/ PR (docs, packages) | verdict |
|---|---|---|---|
| `kernel_only: true` | **skips xtask** (silent-skip regression vs #836) | cheap (skipped) | ✗ reintroduces the class of bug |
| `kernel_only: false` (always run) | runs | **compiles the whole kernel on every PR** | ✗ recurring cost |
| `kernel_only: true` + add `tools/xtask` to kernel scope | runs | cheap | ✗ **over-triggers** libc/posix/sortix on xtask-only changes |

None is clean. The body's §4 diagram (xtask *inside* the workspace suite) implies
Option 2 (Strategy SUPERSEDE below) but did not price its always-run cost or the
#836 sequencing that Option 2 forces.

### 11.3 Two coherent strategies

**Strategy COMPLEMENT (recommended, and what this bead implements).** Replace
`cargo-kernel` + `fork-instrument` with a single `kernel_only: true`
`cargo-workspace` suite running `cargo test --workspace --exclude xtask --target
<host>`, and **keep #836's always-run `cargo-xtask` suite** untouched.

- Covers the five `crates/` members (adds the previously-invisible `shared` (19)
  and `wasm-local-root-spill` (13) — exactly the audit's finding) and remains
  closed-by-default for any *future* crate under `crates/`.
- `--exclude xtask` is a one-item, *justified* exclusion (xtask is separately and
  correctly gated), not the open-ended per-crate allow-list §5 warned against.
- **Green on `origin/main` today → no #836 dependency.** Measured
  `cargo test --workspace --exclude xtask --target aarch64-apple-darwin` =
  **1172 passed / 0 failed / 0 ignored** across 22 binaries (963 kernel + 177
  fork-instrument + 19 shared + 13 spill + 0 userspace = 1479 − 307 xtask-pass).
  Verified both directly and through `ci-run-test-suite.sh cargo-workspace`
  (evidence: `test-runs/kd-i9oc/`). It ran `spill`'s integration binary
  (`root_spill.rs`, 13) — confirming the `--lib` trap is avoided.
- Cost profile ≈ post-#836 baseline + shared/spill; non-`crates/` PRs still skip
  the kernel compile. Order-independent w.r.t. #836 (both edit adjacent matrix
  lines; second-to-merge rebases trivially).

**Strategy SUPERSEDE (the body's literal §5 decision).** One `kernel_only: false`
`cargo test --workspace` suite covering all six members, replacing
cargo-kernel + fork-instrument **and** #836's cargo-xtask.

- Purest closed-by-default (one suite, zero exclusions), unifies xtask in.
- Costs: (a) **blocked on #836 merging** (red on main until then — the 7 xtask
  failures); (b) compiles the full workspace incl. the kernel crate on **every**
  PR; (c) removes another lineage's just-added suite → needs a fold-vs-supersede
  ruling and touches #836's territory.

### 11.4 Resolution of §10 open questions

1. **Fold-in vs supersede #836 → resolved as COMPLEMENT (neither).** With #836
   *open*, the body offered "folding in is acceptable." But folding xtask into a
   single workspace suite forces the §11.2 trilemma. COMPLEMENT sidesteps it:
   don't fold, don't supersede — **complement**. kd-i9oc gates the `crates/`
   workspace; #836 keeps xtask. Orthogonal, both unblocked. *(Coordinator: confirm
   COMPLEMENT, or elect SUPERSEDE and accept its cost + #836 sequencing — see
   §11.5.)*
2. **`--no-fail-fast`? → No, for now.** The suite is one `cargo test` invocation;
   cargo already reports per-binary results and names the failing package, and the
   host run is <1s after compile, so a second failing crate is cheap to surface on
   the next push. Adding `--no-fail-fast` is a one-word change if a reviewer wants
   all-failures-in-one-run; not worth the (tiny) risk of masking an early hard
   error today. Documented so it's a conscious default, not an omission.
3. **Forward guard for host-unbuildable crates (R3) → documented convention.** A
   future wasm-only member must carry `#[cfg(not(target_arch = "wasm32"))]` test
   guards or be excluded from the suite (like xtask is). Captured here and in the
   `cargo-workspace` case comment; deferred a `validation.md` prose paragraph to
   avoid over-documenting a hypothetical (all six members build on host today).
4. **`default-members` → keep `--workspace` explicit.** Unchanged from the body;
   COMPLEMENT's `--workspace --exclude xtask` stays exhaustive-minus-one
   regardless of any future `default-members` narrowing.

### 11.5 Coordinator decision requested

**One decision:** confirm **COMPLEMENT** (recommended: unblocked, low-cost,
low-regret, gates the audit's actual finding now) or elect **SUPERSEDE** (single
always-run suite; accept every-PR kernel compile + wait for #836 + a
fold/supersede ruling on #836's suite). This bead implements COMPLEMENT; a switch
to SUPERSEDE is a small, documented pivot (drop `--exclude xtask`, set
`kernel_only: false`, and remove #836's `cargo-xtask` after #836 merges).

### 11.6 What shipped

`scripts/ci-run-test-suite.sh` (`cargo-workspace` case), the `test-suite` matrices
in `prepare-merge.yml` / `staging-build.yml` / `force-rebuild.yml` (one
`cargo-workspace` entry replacing the two cargo entries), and
`docs/agent-guidance/validation.md` (two cargo rows collapsed to one). No
`detect-change-scope` edit is needed under COMPLEMENT — all five gated members are
under `crates/`, already in the `kernel` scope; editing `ci-run-test-suite.sh`
itself also sets `kernel=true`, so the new suite self-exercises on this PR.
