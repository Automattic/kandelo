# Kandelo Agent Guidance

## Execution scope

Kandelo implements a POSIX-compatible operating-system environment
for WebAssembly, with browser and Node.js hosts.

Interpret runtime terminology in the component being changed.
Guest processes, guest credentials, guest filesystems, and virtual
network state are implemented by Kandelo. Distinguish these from
the embedding host's processes, credentials, filesystem, and network.

For each task, identify whether the affected behavior touches one or
more of:

- guest/kernel semantics;
- the browser or Node.js host adapter;
- a local development or conformance-test fixture; or
- an external service or deployed system.

Use the implementation and relevant architecture documentation to
establish that boundary. Name actual host paths and network targets
when they are involved.

When a concern arises, identify the concrete operation, resource,
and boundary at issue. Continue independent, permitted work and
report the specific remaining blocker.

This file is the loaded guidance for agents working in this repository. Treat
it as a contract router: it names the platform contracts that must be preserved
and points to the focused guidance and reference docs that carry the full
detail.

Kandelo is a POSIX-compatible multi-process kernel for WebAssembly. The project
is built around contracts between the platform and processes, between hosts and
the kernel, between packages and the build system, and between the platform and
users. When in doubt, identify which contract a change touches before editing.

If work touches a contract below, read the linked agent guide before making
substantive edits. The short rules here are the invariants agents must keep in
working memory; the linked files hold the operational detail.

## Platform Values Contract

Kandelo's north star is complete POSIX conformance for the system surface it
exposes. Known gaps and browser-imposed limits must be documented as gaps or
boundaries, not hidden behind package- or demo-specific behavior. Missing or
incomplete POSIX behavior is a platform gap to close, not permission to weaken
the model or add software-specific behavior.

Correct behavior must come from accurate internal system state. Process tables,
file descriptors, address spaces, signals, VFS metadata, devices, networking,
packages, and host adapters should reflect the real state of the system. Do not
shape terminal output, preset behavior, UI state, wrappers, or package scripts
to create the appearance of correctness when the underlying platform is wrong
or incomplete.

Prefer truthful failure over convenient illusion. A missing feature, failed
build, unsupported syscall, unavailable host capability, ABI mismatch, or stale
artifact should be visible as the real boundary it is, not disguised as success
through special-case behavior.

User software should build and run through the normal platform path: SDK, libc,
package resolver, VFS image, syscalls, host runtime, and kernel. A fix that
only makes one program, demo, package script, or button work is suspect unless
the special case is explicitly the product behavior being implemented.

When user software fails to build or run, first ask what the failure reveals
about Kandelo. Is a POSIX API missing? Is a syscall semantically wrong? Is
libc or the SDK misrepresenting the target? Is package resolution incomplete?
Is the VFS image wrong? Is Node/browser behavior diverging? Treat porting
failures as platform feedback before treating them as package quirks.

Workarounds are acceptable only at explicit compatibility boundaries: upstream
defects, browser sandbox limits, host platform constraints, unavailable
hardware capabilities, or intentionally unsupported behavior. A workaround must
document the boundary it belongs to and must not hide a platform defect.

Demos are consumers of Kandelo, not alternate implementations of Kandelo. Demo
code must not bypass, simulate, or paper over runtime, VFS, package, libc,
syscall, kernel, or host defects.

## Worktree Storage

Keep retained notes, checkpoints, and attachments in `.context/`. Conductor
preserves that directory when archiving a workspace. Put disposable bulk
data in gitignored `.scratch/`: temporary worktrees/checkouts, profiles,
traces, source/build experiments, and logs. Use a unique directory per run;
jobs provide `$KANDELO_AGENT_SCRATCH_DIR`. Playwright reports already live
outside `.context/` in `test-results/`. Copy any evidence needed after
archival into retained storage before removing the workspace. See
[`docs/repository-organization.md`](docs/repository-organization.md#worktree-local-storage)
for storage ownership and cleanup.

## Agent Work Loop

For nontrivial work:

1. Identify the contract touched.
2. Read the local implementation, the focused agent guide, and the relevant
   reference docs.
3. Trace root causes through the normal platform path.
4. Preserve Node.js/browser parity unless a documented platform boundary says
   otherwise.
5. Update the authoritative docs for any changed behavior.
6. Run validation that supports the exact claim you will make.
7. Report what changed, what was run, and what was not run.

For a reviewed patch integration, use the optional
[`scripts/agent-integrate` workflow](docs/agent-integration.md) to validate
pinned inputs, preserve unrelated work, and journal evidence/checkpoints.
It imports reviewed check results; command execution remains separate.

For long campaigns, maintain phase checkpoints yourself; do not require the
user to copy context or manage replacement chats. Read the focused
[campaign guide](docs/agent-guidance/campaigns.md) when preparing a dispatch
or handoff. Context reminders are advisory; worker rotation remains a trial.

Do not stop at code reasoning for browser demo bugs, syscall semantics, ABI
changes, package artifacts, or performance claims.

## Contract Map

| Contract | Agent guide | Reference docs |
|---|---|---|
| Validation and completion claims | `docs/agent-guidance/validation.md` | `docs/repository-organization.md` |
| Debugging, POSIX, process, VFS, devices | `docs/agent-guidance/debugging-and-posix.md` | `docs/architecture.md`, `docs/posix-status.md` |
| ABI versioning and snapshot policy | `docs/agent-guidance/abi.md` | `docs/abi-versioning.md`, `docs/fork-instrumentation.md` |
| Host runtime and Node/browser parity | `docs/agent-guidance/host-runtime.md` | `docs/architecture.md`, `docs/browser-support.md` |
| Package schema, builds, resolver, cache | `docs/agent-guidance/packages-and-builds.md` | `docs/package-management.md`, `docs/porting-guide.md`, `docs/sdk-guide.md` |
| Browser demos, VFS images, sharing, users | `docs/agent-guidance/browser-and-user.md` | `docs/browser-support.md` |
| Filesystem image hierarchy and installed guest paths | `docs/agent-guidance/images.md` | `docs/filesystem-layout.md` |
| Performance claims and benchmarks | `docs/agent-guidance/performance.md` | `docs/profiling.md` |
| Dev shell, docs, PR/final reports | `docs/agent-guidance/build-docs-and-prs.md` | `docs/repository-organization.md`, `README.md` |
| Optional Spacefast deployment, publication and examples | `docs/agent-guidance/spacefast-deployment.md` | `apps/spacefast-cors-proxy/README.md`, `.agents/skills/deploying-kandelo-to-spacefast/SKILL.md` |

## Validation Contract

Main agents: at task start, fetch `origin main`, then run
`python3 .claude/hooks/install-hooks.py --user --update-from-main`.
Repeat after merging a hook change. This refreshes an existing user
installation from fetched `origin/main`, preserves opt-in and never
downgrades; do it without asking the user to run the installer. Do not run
plain `--user` from a feature branch as an automatic update. If fetching
or updating fails, report it and continue independent work. Subagents
leave user hook maintenance to the parent.

Read [the validation guide](docs/agent-guidance/validation.md) before choosing
checks. Match evidence to the exact claim: unit tests do not prove POSIX
conformance, Node results do not prove browser behavior, and browser demos do
not prove ABI compatibility. Consider the relevant conformance suites for
runtime/kernel changes. Manually verify user-visible browser fixes with
`./run.sh browser` as well as browser tests.

Keep automated browser tests silent through the shared Playwright fixture,
including private diagnostics. Leave guest PCM and analysers running; never
mute system output. Audible playback needs explicit user intent and the
[documented opt-in](docs/agent-guidance/validation.md#keep-browser-tests-quiet).

Runs under 10 minutes: one foreground Bash call with output to a log file.
Longer runs: use `scripts/agent-job start`. Interactive main sessions: run
`scripts/agent-job wait <id> --timeout 0` once with Bash's
`run_in_background`, then act on its single completion notification.
Headless main sessions repeat foreground `scripts/agent-job wait <id>`
(up to 9 minutes per call). Subagents use `wait <id> --timeout 240` for
targeted work, one wait per Bash call; return known long jobs to the parent.
Repeat only on the still-running wait-window notice; `FAILED (exit 124)` is
final. Find peer builds with `list --all` and wait on their id (or
`wait --peer <text>`); after a selector timeout retry by resolved id.
Do not poll with Monitor/status-file loops, `sleep` or `pgrep -f`, end a
headless/subagent turn to wait, or make subagents wait on whole-tree builds.
See [waiting on long builds](docs/agent-guidance/validation.md#waiting-on-long-builds-and-suites).

## Debugging And POSIX Contract

Read [debugging and POSIX guidance](docs/agent-guidance/debugging-and-posix.md)
before changing syscalls, process lifecycle, VFS, memory or devices. Start
from POSIX semantics; when designs are otherwise equivalent, prefer
Linux-observable behavior. Keep process state, descriptors, OFDs, locks,
sockets, PTYs, memory, signals and zombie/reaping state coherent.

A workaround for an outside runtime or toolchain defect needs an entry in
`tests/runtime-workarounds/` and a `[RUNTIME-WORKAROUND: <ID>]` tag at every
code site. Without a standalone, self-judging reproduction containing no
Kandelo code, call the defect "suspected". Never file, comment on or vote on
upstream trackers unless the entry has `reports = "agents-allowed"` with a
named channel. See [the registry](tests/runtime-workarounds/README.md).

## ABI Contract

Read [ABI guidance](docs/agent-guidance/abi.md) and
[versioning](docs/abi-versioning.md) before ABI-adjacent edits. Every
incompatible change needs a version bump and regenerated `abi/snapshot.json`:
`ABI_VERSION` in `crates/program-abi/src/lib.rs` for program-visible changes,
`HOST_ADAPTER_VERSION` for kernel-host-only changes.

Syscall semantics, marshalling, process/channel memory layout, exported or
imported interfaces, fork instrumentation, generated constants and VFS
program bindings are ABI surface. The snapshot check alone does not prove
semantic compatibility. Stale or mismatched artifacts must fail loudly and
be rebuilt through the normal path; do not add implicit compatibility shims.

## Host Runtime Contract

Read [host runtime guidance](docs/agent-guidance/host-runtime.md) before
changing host runtime, worker protocols or adapters. Node.js and browser
hosts are peers; shared runtime changes need both, unless a real platform
boundary explains the difference. The kernel always runs in a dedicated
worker. Never instantiate `CentralizedKernelWorker` on the main thread.

Memory ceilings consume reservation budget on WebKit/JavaScriptCore at
construction. Account for that cost before adding or raising one; budgets
live in `host/src/runtime-memory-profile.ts`. The main thread must never own
a VFS `SharedArrayBuffer`: compose in a worker and transfer plain bytes.
Persistent browser/audio realms must never receive guest
`WebAssembly.Memory` or its views. Use bounded independent device buffers
and explicit asynchronous retirement. Memory/device/lifecycle changes need
`./run.sh test browser-memory` per the validation guide.

## Package And Build Contract

Read [package and build guidance](docs/agent-guidance/packages-and-builds.md)
before changing recipes, patches, build scripts, resolver/cache behavior,
indexes or package artifacts. `package.toml` owns the portable recipe;
`build.toml` owns project build/publish state. Declare every dependency,
install only into `WASM_POSIX_DEP_OUT_DIR`, honor the resolver contract and
produce declared outputs. SDK/sysroot-free recipes may declare
`[build].toolchain = "none"` only after reviewing the script and helpers.
Fork-using packages must use `scripts/run-wasm-fork-instrument.sh`.

Port against `./run.sh partial <image> <pkg>...` by default. Before building,
announce the image and packages and that the user can ask for a full build;
name the partial image in the final report. Use full builds for shared
platform code, whole-browser/suite/canonical-image claims or explicit user
requests, and build canonical products before a PR.

Kandelo is not Linux. Never define `__linux__` in SDK flags, `config.site` or
the sysroot. Prefer feature macros or cache variables for upstream probes;
a per-package `-D__linux__` is a commented last resort requiring a maintainer
conversation. Package patches must not hide ordinary Kandelo POSIX gaps.

## Browser And User Contract

Read [browser and user guidance](docs/agent-guidance/browser-and-user.md)
before changing browser demos, `KernelHost`, boot descriptors, sharing,
persistence, service-worker bridges or image metadata. Reusable session
contracts belong in `web-libs/kandelo-session`; React wiring and page
fixtures belong in `apps/browser-demos`.

Treat boot descriptors and shared URLs as untrusted input: version them,
bound their size/mounts and validate paths/source kinds. Describe persistence,
privacy and verification accurately. Image-owned demo metadata belongs in
`/etc/kandelo/demo.json` through the image builder, not app-loader fallbacks.

## Performance Contract

Read [performance guidance](docs/agent-guidance/performance.md) before
performance claims or syscall hot-path changes. Correctness and host parity
come first. Explicit performance work, broad claims and syscall hot-path
changes require all benchmark suites on Node and browser with before/after
comparison. Bound narrower evidence explicitly; if unmeasured, say so.

Do not repeat known-bad `host/src/kernel-worker.ts` changes: syscall argument
count tables, syscall classification sets, cached channel `DataView` or
`Int32Array` objects, or conditional debug-ring logging for trivial syscalls.

## Build, Documentation, And PR Contract

Read [build, documentation and PR guidance](docs/agent-guidance/build-docs-and-prs.md)
before changing these workflows or reporting completion. Build/verification
claims must run through `scripts/dev-shell.sh`, not undeclared host tools;
direnv is only an interactive convenience.

Build missing artifacts and continue: fresh worktrees inherit no sysroots,
kernel, programs, package binaries or images. Missing producible artifacts
are provisioning work; actual build failures are boundaries to report.
`./run.sh setup` checks both musl cores for freshness. After libc edits, run
`setup --all` to refresh linked packages and `scripts/build-programs.sh` for
example/test fixtures; rebuilding libc alone leaves stale linked programs.

Pin every third-party `.github/` action to a full 40-character SHA with its
version in a trailing comment. Same-repo `./.github/...` references are the
only exception. Never restore mutable tag or branch refs.

Use short `Area: Purpose` commit/PR titles. PR descriptions have `## Why`,
`## What changed` and `## Validation`; state what ran and what did not. Keep
prose plain and descriptions short. Do not hard-wrap PR prose; wrap commit
bodies at 72 columns except tables, code, generated text and URLs. Preserve
human contributor authorship when rewriting history and verify it before
force-pushing. Never credit AI tools in commits or PR descriptions.

Update authoritative reference docs for changed behavior. Do not promise
support without implementation and evidence, or duplicate long policies
across files. Historical plans are records, not current guidance.

## Key Directories

Use this map to route edits to the component that owns the contract. A symptom
may appear in a demo, package, script, or wrapper, but the fix belongs at the
layer whose platform behavior is wrong.

| Path | Owns |
|---|---|
| `crates/runtime-core/` | Engine-independent POSIX implementation: syscalls, process state, VFS, devices, memory, signals |
| `crates/kernel/` | Wasm interface and host-import adapter around runtime-core |
| `crates/program-abi/` | Program ABI version and artifact declarations |
| `crates/shared/` | Shared ABI constants, syscall/interface definitions, host/kernel contract types |
| `crates/fork-instrument/` | Wasm fork continuation instrumentation |
| `abi/` | Committed ABI snapshot and generated ABI evidence |
| `host/src/` | TypeScript host runtime shared by Node.js and browser |
| `host/test/` | Host/kernel runtime behavior tests |
| `web-libs/` | Browser-independent reusable UI/session contracts |
| `apps/browser-demos/` | Browser app, demo pages, app-local presentation helpers |
| `packages/registry/<name>/` | Package manifests, builds, patches, package-owned tests |
| `images/` | Rootfs sources, VFS/archive builders, image metadata |
| `sdk/` | Cross-compilation wrapper CLI and SDK support |
| `libc/` | musl submodule, musl overlay, syscall glue |
| `benchmarks/` | Performance suites, harnesses, and benchmark results |
| `tests/libc/`, `tests/posix/`, `tests/sortix/` | External conformance suites |
| `tests/package-system/` | Package registry and binary-fetch automation tests |
| `scripts/` | Build, test, package, release, and developer automation |
| `.github/` | CI workflows and GitHub release automation |
| `docs/` | Authoritative reference documentation and historical plans |
| `docs-site/` | Published documentation site |
