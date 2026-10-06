# Unified Build Front Door — One Way to Set Up and Build — Design

Status: **Design proposal (research mode). Not approved for
implementation.** This document is the architecture and staged plan for
review. No implementation begins until the written spec is approved.

Related prior art (context only, not authority):
`docs/agent-guidance/packages-and-builds.md`,
`docs/package-management.md`, `docs/plans/2026-08-25-rust-first-runtime-design.md`.

## Why

A new contributor — or any of us on a fresh worktree — has no single,
obvious command that takes a clean checkout to a repo that can build
local packages and run demos. Instead there are **three overlapping
build front doors** feeding **two artifact tiers that can silently
disagree**. The result is exactly the pain that motivates this work:
setup is not easy for everyone, and there are recurring sources of
staleness and confusion.

The three front doors today:

| Path | Toolchain | Builds | Writes to |
|---|---|---|---|
| `bash build.sh` | ambient shell | kernel, fork-instrument tool, program index, TS host, rootfs | `local-binaries/` |
| `./run.sh build <target>` + `need_*` | ambient shell | any single target, lazily | `local-binaries/` + `sysroot/` |
| `./run.sh local-build` | hermetic (Nix dev shell) | the SourceOnly package set (self-bootstraps SDK + kernel) | `local-binaries/source-only-v1/` |

`./run.sh local-build` does **not** actually consume anything
`build.sh` produces — the two are independent pipelines that overlap
heavily. `local-build` self-bootstraps the SDK and kernel as package
nodes and regenerates the program index itself. The felt "local-build
needs build.sh first" is really "I needed `host/dist` or `rootfs.vfs`
to *run* a demo," produced only by the other path.

This confusion is not one bug. It has **five concrete, code-level
sources**, and the design targets each explicitly.

### The five staleness / confusion sources

**A. Two kernels that never reconcile.** `build.sh` installs an
*ambient-built* kernel into `local-binaries/` (`build.sh:5-15`, plain
`cargo build --release -p kandelo`). `./run.sh local-build` installs a
*hermetically-built* kernel into `local-binaries/source-only-v1/`.
Default (Node/Vitest) resolution reads the first
(`host/src/binary-resolver.ts:275-281`); the browser SourceOnly policy
reads only the second (`binary-resolver.ts:1226-1274`). Nothing
cross-checks them, so an edit rebuilt by one path leaves the other
silently stale. The repo's own runtime design doc names the hazard:
"stale wasm silently runs old code"
(`docs/plans/2026-08-25-rust-first-runtime-design.md:673`).

**B. Freshness is "does the file exist."** Six of the seven `need_*`
guards in `run.sh` decide freshness by bare existence: `sysroot`
(`libc.a` exists), `sysroot64`, `host` (`host/dist` dir exists),
`rootfs` (`rootfs.vfs` exists), `sdk` (PATH lookup), `fork_instrument`
(`tools/bin/...` exists). Only the kernel does real validation
(`has_valid_kernel_file` → ABI version + required exports + legacy
Asyncify content scan, in `scripts/wasm-artifact-guards.sh`). Every
other artifact can be arbitrarily out of date and still be treated as
fresh (`run.sh:332-337`, `435-523`).

**C. Hand-maintained `build.toml` `revision` / `commit`.** These fields
fold into the resolver cache key (`tools/xtask/src/build_deps.rs:6739`,
`7504`). Change a package's source or build script without bumping
`revision` and the resolver computes a matching key and serves an
out-of-date binary — silently.

**D. `program-packages.json` cache keys are environment-dependent.**
The projection's per-arch cache keys hash the build/toolchain trees, so
a local toolchain that differs from the publisher's diverges from the
committed `cache_key_sha`, the pinned binary is rejected
(`build_deps.rs:5332-5346`), and the package falls back to a full
source rebuild. Detected and auto-healed, but it forces spurious
rebuilds (the "cache-key drift" already recorded in project memory).

**E. Two toolchains produce non-identical artifacts.** Ambient `cargo`
vs. Nix-hermetic builds mean "which build is the real one" is genuinely
ambiguous.

The engine that already does the hard part correctly is **typed Rust**:
`tools/xtask` owns the dependency resolver, the local-build scheduler
(`local_build_executor.rs`), the projection finalizer
(`local_build.rs`), cache-key hashing, and ABI snapshotting. The bash
is front-door orchestration and dev-shell enforcement. So
"consolidate into xtask" is **not** rewriting the engine — it is
collapsing three front doors into one and moving the orchestration
*decisions* into the engine that already exists and is already tested.

## Goals

- **One command** takes a fresh checkout to "ready to build packages and
  run demos": `./run.sh setup`.
- **One artifact tier** is the single source of truth. No two-kernel
  divergence.
- **Freshness is content-addressed, not existence-based.** An outdated
  artifact is rebuilt or reported, never silently accepted.
- **One freshness/build engine** (xtask). Delete the parallel, weaker
  bash freshness engine in `run.sh`.
- **The declared product set is the only product set.** Fold the
  imperative `build_*_vfs` builders into the product catalog xtask
  already owns.
- **Clean is derived from the graph**, not a hand-maintained list.
- **Fast dev iteration is preserved.** Single source of truth does not
  mean slow inner loop (see Dev Iteration).

## Non-goals

- Rewriting `run.sh`'s run/test/demo *dispatch* into Rust. Those stay
  in bash; only the build/freshness/product/clean machinery moves.
- Changing any ABI, syscall, or package build semantics. Build commands
  are preserved byte-for-byte where they move; this is a front-door and
  freshness change, not a package-recipe change.
- Removing the Nix dev shell. It stays the reproducibility boundary; the
  thin shell-entry shim remains (see Principle).

## Design

### Principle

There is exactly **one** way to make the repo ready, it is **hermetic**,
and freshness is decided by **content identity**, not by whether a file
exists. A thin bash shim still enters the Nix dev shell and invokes the
compiled `xtask` — that shim is unavoidable (something must enter the
shell and compile the tool) and already exists as
`scripts/run-local-build.sh`. Everything above that shim is typed Rust.

This is deliberately *not* "eliminate bash." It is "reduce bash to a
boring, minimal shell-entry wrapper and move every build/freshness
*decision* into the typed, tested engine." That distinction is the
honest framing of the win.

### Component 1: `xtask bootstrap` — the single orchestrator

A new command group in `tools/xtask` that subsumes both `build.sh`'s
steps and `run.sh`'s `need_*` / `build_*` graph, as typed Rust that
shells out to the underlying tools (`cargo`, `npm`,
`scripts/build-musl.sh`, `scripts/build-rootfs.sh`).

Key architectural decision: **reuse the local-build engine's identity /
cache model instead of inventing a parallel freshness system.** The
kernel, SDK, and sysroot are *already* package nodes in
`packages/sets/local-supported.toml` (`class = "platform"`). So
`bootstrap` is essentially "local-build a superset that also covers
`host/dist`, `rootfs.vfs`, and the fork-instrument host tool."

Proposed surface (names illustrative, finalized in the plan):

- `xtask bootstrap all` — kernel, sysroot(64), SDK, fork-instrument,
  host/dist, rootfs, program index, and the local package set.
- `xtask bootstrap <target>` — a single artifact (kernel, host, rootfs,
  sysroot, …), with the *same* content-addressed freshness the graph
  uses. This is the replacement target for each `need_*`.
- `--dev` / `--release` — build profile selector for the kernel,
  **added only if the Stage 0 measurement shows a fast lane is needed
  AND the maintainer explicitly approves it** (see Dev Iteration). If
  added, both profiles write the one tier.

Steps that are not yet graph nodes (host `npm run build`, rootfs)
receive a real **input fingerprint** — a hash of their declared inputs
(`host/src` + `host/package.json` for the host; the rootfs input set
for rootfs) — replacing the current dir-exists check. This directly
closes source **B**.

### Component 2: One artifact tier (single source of truth)

Collapse the two `local-binaries` roots so the kernel, and every
platform artifact, has **one** location that *both* Node and browser
resolution read. This is the highest-value fix (closes source **A**).

Approach: make the hermetic tier authoritative and have default/Node
resolution read it, removing the ambient `local-binaries/` kernel as a
second, divergeable copy. The resolver policies that today read
disjoint roots (`binary-resolver.ts:275-281` vs `1226-1274`) converge
on the single tier. Where the two policies must still differ for real
reasons (e.g. fetched-binary tiers), that difference is explicit and
documented — but there is never a second copy of the *same* artifact
that can silently drift.

The fix is *elimination, not detection*: `build.sh`'s ambient kernel
install into `local-binaries/` (`build.sh:5-15`) is removed, so the
kernel is produced exactly once (the hermetic engine node) and lives in
exactly one place. There is no second copy to police, so no
divergence-detection guard is needed — a guard against a divergence you
have structurally removed is superfluous. (`local-binaries/` remains the
home for other local outputs such as built programs; only the redundant
kernel copy goes away.)

### Component 3: Content-addressed freshness everywhere

Delete `run.sh`'s `has_*` predicates as the freshness authority. Each
artifact's "is it current" decision comes from the xtask identity /
cache-key model — the same one the scheduler and projection already
use. The kernel's existing real validation (ABI version + required
exports + Asyncify scan) is **preserved**: it is the one guard that
already rebuilds a present-but-outdated artifact, and its semantics
move into the xtask kernel node unchanged.

### Component 4: One front door

`./run.sh setup` becomes the single entry point:

1. Enter the Nix dev shell (thin bash shim, the existing
   `run-local-build.sh` pattern; PATH pinned to
   `KANDELO_DEV_SHELL_TOOL_PATH`).
2. `cargo run -p xtask --target <host> -- bootstrap all`.
3. Emit one status summary of cached-vs-rebuilt nodes (the local-build
   JSON envelope already carries this).

`build.sh` becomes a ~3-line wrapper that calls the same command, for
back-compat, and is marked deprecated in its own header and in the
docs. `./run.sh local-build` remains as an alias / subset for people
who want only the package set.

### Component 5: Retarget `need_*` / `build_*` at xtask; delete the bash freshness engine

The `need_*` functions and `build_*` target functions in `run.sh` are
rewired to call `xtask bootstrap <target>`. The run/test/browser
dispatch keeps calling `need_*`-shaped helpers, but those helpers now
delegate to the one engine instead of the hand-rolled `has_*` checks.
The parallel bash freshness engine (`has_*` + exists-checks) is
removed. This is where most staleness actually dies: `run.sh` stops
maintaining a second, weaker build graph.

Universal prerequisite edges to preserve (from the current call graph):
`need_kernel` + `need_sdk` (→ `need_sysroot`) on nearly every package
builder; `need_sysroot64` on memory64 paths; `need_fork_instrument` on
msmtpd; `need_host` on `build host` and `run shell`;
`need_node_modules` on all `run` examples. These become dependency
edges the engine already understands, not ad-hoc bash calls.

### Component 6: Fold `build_*_vfs` into the declared product catalog

`run.sh` contains dozens of imperative `build_*_vfs` functions
(`build_shell_vfs`, `build_wp_vfs`, `build_lamp_vfs`, …) that
re-implement the product set already declared in
`packages/sets/local-supported.toml` (13 products) and generated by
`xtask vfs products generate` into
`images/vfs/products/generated/catalog.json`. Fold these into the
declared catalog so a VFS product is built one way, from one
declaration. `./run.sh build <product>` resolves to a catalog product,
not a bespoke bash function.

### Component 7: Derive clean from the graph

`clean_target` in `run.sh` hand-lists `rm -rf` for 60+ packages and
carries manual cross-invalidation warnings (e.g. "also invalidated
shell.vfs.zst"). Because the build system creates these trees, it knows
their paths. `xtask clean <target>` derives the removable set (and the
cascade) from the graph, so cleaning nethack/vim automatically
invalidates the products that embed them instead of relying on a
`warn` the user must read and act on.

### Component 8: Loud, not silent, staleness guards

- `xtask verify-fresh` — a **pre-test freshness** check: before Vitest /
  conformance runs, confirm the kernel/host/rootfs the tests will load
  are current for the source tree, and rebuild-or-fail-loud otherwise.
  This closes a *documented* hazard the repo names explicitly ("stale
  wasm silently runs old code",
  `docs/plans/2026-08-25-rust-first-runtime-design.md:673`). It is
  **not** a two-tier divergence guard — the divergence is removed by
  Component 2 (single kernel copy), so there is nothing to reconcile;
  this guard only answers "is the one artifact current before I test
  against it."
- Optional revision-drift warning — when a package's source-tree hash
  changed but its `build.toml` `revision` / `commit` did not, warn
  loudly (turns source **C** from silent to visible). Lower priority;
  can land last.

## Dev iteration and performance

The two-kernel divergence is a **tier** problem, not a build-speed
problem, so a single source of truth does **not** require a slow inner
loop:

- The kernel *compile* cost is identical ambient vs hermetic — same
  `cargo build -p kandelo`.
- The hermetic *wrapper* adds a bounded, roughly-constant overhead (Nix
  shell entry when warm + one scheduler pass; the scheduler no-op is
  already ~7.5s and single-package changes rebuild only their closure).
- The genuine iteration variable is build *profile*: release + LTO
  (`lto = true, opt-level = "s"`) relinks are slow, and that is already
  true in `build.sh` today.

The single source of truth is **unconditional**: there is one tier and
one kernel artifact regardless of how it was built. Whether we also add
a `--dev` kernel fast lane is **conditional on measurement**, not a
committed feature of this design:

- If an incremental hermetic kernel rebuild is already fast enough for
  iteration, we add **no** fast lane — simpler is better, and there is
  nothing to build.
- If release + LTO relinks are painful per edit, we *propose* a `--dev`
  profile that writes the **same one tier** (fast local builds, no
  second tier to diverge), while the reproducibility boundary (publish
  / commit) always uses the hermetic release build. A fast lane is
  added **only after the measurement shows it is needed and the
  maintainer explicitly approves it** — never on the measurement alone.

**Performance is unmeasured in this document.** Per the repository
performance contract, the Stage 0 spike (below) measures: (1) warm
dev-shell entry overhead, (2) incremental kernel rebuild time, (3)
release + LTO kernel rebuild time. The fast-lane question is answered
by those numbers, not by this reasoning — and the default answer is "no
fast lane" unless the measurement shows one is needed.

## Contract touchpoints (read before implementing)

- **Package and Build contract** — `docs/agent-guidance/packages-and-builds.md`.
  Build commands that move into xtask must honor the resolver contract
  and the worktree-local SDK, and produce the same declared outputs.
- **Build / dev-shell contract** — `docs/agent-guidance/build-docs-and-prs.md`.
  The dev shell stays the verification boundary; the shell-entry shim is
  the only bash that must remain. `bash build.sh` does not rebuild musl
  today — preserve or make explicit any musl behavior in `bootstrap`.
- **ABI contract** — no ABI change intended. Preserve the kernel
  ABI-staleness validation (`wasm-artifact-guards.sh`) exactly.
- **Host runtime / parity** — the single-tier change alters what Node
  and browser resolution read; both hosts must end at the same artifact.
  Node/browser parity is a landing requirement, not a follow-up.
- **Performance** — measured spike required before the hermetic default
  is locked (see above).

## Staging / delivery plan

This lands as **one PR, rebase-merged, with one dedicated commit per
stage** — an atomic change with a clean, bisectable history rather than
separate PRs. Stages are therefore not each required to leave `main`
shippable on their own (they are reviewed together), but **every commit
must build and pass tests** so the history bisects cleanly and review
can proceed commit by commit. The stage order below is the commit
order.

- **Stage 0 (spike, throwaway — not a commit):** measure dev-shell
  entry overhead and incremental vs release+LTO kernel rebuild times.
  Output: the numbers that decide the fast-lane question and confirm
  the hermetic default. No kept code; findings recorded in the PR
  description.
- **Stage 1:** `xtask bootstrap all` + `<target>` subsuming `build.sh`'s
  steps with real host/rootfs fingerprints; `./run.sh setup` single
  front door; `build.sh` delegates.
- **Stage 2:** single artifact tier + `verify-fresh` divergence guard;
  Node and browser resolution converge on it.
- **Stage 3:** retarget `run.sh` `need_*` / `build_*` at xtask; delete
  the parallel bash freshness engine.
- **Stage 4:** fold `build_*_vfs` into the declared product catalog.
- **Stage 5:** derive `clean` from the graph (with cascade); optional
  revision-drift warning.

## Risks and mitigations

- **Silent-divergence window during the tier collapse** → `verify-fresh`
  lands with/before the collapse and fails loud on disagreement.
- **Hermetic default slows kernel iteration** → Stage 0 measures the
  real cost; add a `--dev` fast lane to the one tier only if the numbers
  show it is needed and the maintainer explicitly approves.
- **A moved build command subtly changes a package output** → move
  commands byte-for-byte; validate with the existing package/conformance
  suites, not code reasoning.
- **Node-first / browser-later drift on the resolver change** → both
  hosts land together; parity is a Stage 2 acceptance gate.
- **`run.sh` run/test/demo paths regress when `need_*` is rewired** →
  keep the `need_*`-shaped helper names as thin delegators so call sites
  are unchanged; change only what they call.

## Open questions

- Final command naming: `xtask bootstrap` vs `xtask build` vs folding
  into `xtask local-build` as products.
- Does `bootstrap` own musl explicitly, or keep the current "not
  rebuilt by default" boundary and document it?
- Exact input-fingerprint definition for `host/dist` and `rootfs.vfs`.
- Whether `build.sh` is deleted at the end of staging or kept
  permanently as a deprecated one-line alias.

## Testing strategy

- Fresh-worktree end-to-end: `./run.sh setup` from a clean checkout
  produces a runnable repo with no prior `build.sh`.
- Freshness: touch a kernel source line → only the kernel closure
  rebuilds; touch nothing → no-op is fast and rebuilds nothing.
- Divergence: `verify-fresh` fails when two locations disagree; passes
  after a single-tier build.
- Package/conformance suites unchanged and green (moved build commands
  are behavior-preserving).
- Node and browser both resolve the same single-tier kernel.
