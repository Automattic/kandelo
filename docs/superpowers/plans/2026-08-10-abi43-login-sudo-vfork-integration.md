# ABI 43 Login, Sudo, and vfork Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship ABI 43 with a real login and sudo stack, exact set-ID exec
authority, secure startup, a Homebrew-independent VFS security boundary, and
evidence that Kandelo's genuine vfork path is safe and removes the need for
the temporary CRuby patch.

**Architecture:** Forward-port behavior, not obsolete branch mechanics, into
the current linear ABI 43 batch. Generic VFS materialization and explicit
mount capabilities establish the executable trust boundary; one authoritative
process credential record and opaque prepared-exec targets make privilege
changes transactional. Existing genuine vfork remains an independent
shared-memory process path and must pass mechanism, integration, and final
artifact gates before pristine Ruby is released.

**Tech Stack:** Rust `no_std` kernel and shared ABI crates, C/musl guest
runtime and programs, TypeScript host runtime and VFS, Node.js workers,
browser Web Workers, Vitest, Playwright, Cargo, Homebrew Formulae, shell and
Python release tooling.

## Global Constraints

- Work only on `integration/abi43-batch-linear-20260801`; keep its history
  linear, retain conceptual commits, and require rebase-commit merging for
  PR #1240. Never squash this batch.
- Preserve the exact pre-login tip `bd8ac83e3` under
  `safety/abi43-pre-login-20260810` before implementation.
- Preserve unrelated dirty submodules, `.serena/`, and browser test results.
  Stage explicit paths, never `git add -A`.
- Forward-port, do not merge or mechanically cherry-pick,
  `8a66801e6353bed9ff55fa1dc5e3b7e1b0b53e24`,
  `ebde506115e7b4bfe26a5eaf0b7d097c3e1ee939`, or the final twelve commits
  from `emdash/support-logins-8yaz3`.
- Preserve Brandon Payton as author for materially derived VFS and login
  commits; the forward porter remains committer. Verify with `git range-diff`
  and `git log --format=fuller` before push.
- Do not restore Kandelo package-registry recipes or bridge login, sudo,
  sudo-lite, Ruby, or shell binaries through `packages/registry/`.
- POSIX conformance is the target. Do not add Linux `__WALL`, Linux clone
  child classes, System V compatibility, or package-specific kernel behavior.
- Node.js and browser hosts are peers. Shared host behavior requires matching
  Node and browser coverage; browser coverage means Chromium, Firefox, and
  WebKit wherever the path applies.
- ABI 43 requires the prepared-target protocol outright. Keep
  `ABI_VERSION = 43`, remove targetless exec interfaces, regenerate
  `abi/snapshot.json` and `host/src/generated/abi.ts`, and run snapshot checks.
- Do not add a new vfork import, fork mode, fork-instrument frame field, or
  shared-memory ownership protocol under this design. Stop for design review
  if evidence requires one.
- A vfork parent may resume after child memory access only after the exact
  child-generated `memory_quiescent` fence. Timeout or Worker termination
  return is never quiescence evidence.
- If browsers expose no exact forced-termination fence, retain loud
  whole-address-space containment and document vfork as partial; do not add a
  larger safe-point or coordinator architecture without a revised design and
  Brandon's approval.
- Mounts default to `nosuid`. Only a reviewed, root-owned, non-guest-writable
  product mount with stable executable identity may honor set-ID bits.
- Local bottles and sidecars have `local-test` provenance. Only reviewed
  GitHub workflows may create or promote authorized candidates.
- Do not modify, merge, or rebase
  `emdash/homebrew-pr-staging-1q1w6`. Consume its reviewed interfaces only
  after they land and become active.
- Run every build and validation command through `scripts/dev-shell.sh`.
  After any musl overlay or syscall-glue change, run
  `scripts/dev-shell.sh bash scripts/build-musl.sh` before `build.sh` or tests.
- Do not merge kernel, ABI, libc, host-runtime, or fork-instrument changes
  without Brandon's explicit approval.
- Commit and PR subjects use `Area: Purpose`. PR prose begins with `## Why`
  and wraps prose at 72 columns.

---

## Execution Amendment — 2026-08-12: CI-owned Homebrew bottle staging

Brandon directed that the costly ABI 43 Homebrew bottle build and its product
evidence move out of this worktree. This amendment supersedes only the
local-staging portions of the original Task 20 plan; it does not turn unrun
work into evidence and does not change the publication or promotion boundary.

Task 20 in this worktree now owns the checked-in product declarations,
selection and authority locks, privileged projection policy, provenance
rejection rules, CI invocation contract, and focused Node/browser fixture
contracts. `run-login-stack-local.sh` remains an implementation interface that
the staging lane may consume, but this worktree must not use it to build the
43-Formula closure or treat a local report as Task 20 completion evidence.

The staging worktree `emdash/homebrew-pr-staging-1q1w6` and GitHub CI own the
actual ABI 43 Formula builds, sidecars, composed image, Node/browser lifecycle,
and RSS evidence. Their CI report is the sole success evidence for those
operations. Task 20 produces a frozen handoff containing the exact Kandelo and
tap heads, ABI, Formula closure, and required lifecycle assertions; it does not
stage, merge, publish, promote, or relabel artifacts.

Accordingly, this amendment supersedes the original local-bottle statements in
the file/interface map, Task 18's local-harness direction, Task 20 Steps 6–10
and 12, Task 23's local product run and manual demonstration, and Task 24's
local-test rerun. Later tasks consume the GitHub CI evidence from the staging
owner instead. The original text remains below as a historical record.

## File and Interface Map

### New focused files

- `crates/kernel/src/credentials.rs` owns `Credentials`, `NGROUPS_MAX`, and
  POSIX UID/GID transition checks. `Process` is its sole owner.
- `crates/kernel/src/exec_target.rs` owns prepared-target tokens, owner and
  generation binding, exact OFD retention, target revalidation, set-ID
  proposals, and exactly-once cancellation or consumption.
- `host/src/vfs/materialization-plan.ts` owns generic bounded archive byte
  assertions, transforms, and exact byte identities.
- `host/src/homebrew-deferred-tree-adapter.ts` validates Homebrew receipts and
  erases Homebrew vocabulary into generic lazy-tree inputs.
- `host/src/exec-target.ts` defines the shared Node/browser opaque exec launch
  request and target reader; host-specific entry points consume this module.
- `images/vfs/lib/demo-login.ts` is the one source of demo account constants,
  password hash, and autologin message data.
- `apps/browser-demos/pages/kandelo/kernel-host/demo-terminal-sessions.ts`
  maps the demo product to the reusable session policy.
- `scripts/run-vfork-readiness.sh` makes the mechanism and integration vfork
  gates repeatable and records exact commands and browser engines.
- `scripts/run-login-stack-local.sh` defines the CI staging invocation and
  report contract. The staging worktree, not this worktree, runs its
  43-Formula bottle build and product evidence path.
- `docs/measurements/2026-08-10-vfork-readiness.md` records exact-head vfork
  mechanism and integration results without turning unrun checks into claims.

### Core interfaces

The kernel credential record is:

```rust
pub const NGROUPS_MAX: usize = 32;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Credentials {
    pub ruid: u32,
    pub euid: u32,
    pub suid: u32,
    pub rgid: u32,
    pub egid: u32,
    pub sgid: u32,
    pub supplementary_groups: Vec<u32>,
}
```

`Process` owns `credentials: Credentials`, `secure_exec: bool`,
`exec_generation: u64`, and `prepared_exec_targets: PreparedExecLedger`.
Callers use `real_uid()`, `effective_uid()`, `real_gid()`, and
`effective_gid()` accessors rather than caching identity elsewhere.

The ABI 43 prepared-target exports are:

```text
kernel_exec_target_prepare(
    pid: u32, caller_tid: u32, dirfd: i32,
    path_ptr: usize, path_len: usize, flags: u32
) -> i32
kernel_spawn_exec_target_prepare(
    parent_pid: u32, child_pid: u32,
    path_ptr: usize, path_len: usize
) -> i32
kernel_exec_target_size(owner_pid: u32, target: u32) -> i64
kernel_exec_target_read(
    owner_pid: u32, target: u32,
    offset_lo: u32, offset_hi: i32,
    buffer_ptr: usize, buffer_len: usize
) -> i32
kernel_exec_target_cancel(owner_pid: u32, target: u32) -> i32
kernel_exec_commit(pid: u32, caller_tid: u32, target: u32) -> i32
kernel_spawn_exec_commit(
    parent_pid: u32, child_pid: u32, target: u32
) -> i32
```

The host queries `kernel_process_secure_exec(pid: u32) -> i32` after an exec
commit and supplies the result in the kernel-owned Worker launch transaction.
The guest-facing required import remains the zero-argument
`kernel_get_secure_exec() -> i32`; `worker-main.ts` returns only the bound
launch value, never a guest or boot-descriptor field.

The shared host request is:

```ts
export interface PreparedExecLaunchRequest {
  readonly ownerPid: number;
  readonly callerTid: number;
  readonly target: number;
  readonly argv: readonly string[];
  readonly envp: readonly string[];
  readonly diagnosticPath: string;
}

export type ExecLaunchCallback = (
  request: PreparedExecLaunchRequest,
) => Promise<number>;
```

`diagnosticPath` is never execution authority. The host reads bytes only via
the target token and commits only that token.

Generic archive materialization uses:

```ts
export type LazyTreeDecoder = "zip-v1" | "tar-gzip-v1";

export interface LazyTreeByteIdentity {
  sha256: string;
  bytes: number;
}

export interface LazyTreeByteTransformRecipe {
  id: string;
  replacements: readonly {
    matchHex: string;
    replacementHex: string;
  }[];
  rejectHex: readonly string[];
}

export interface LazyTreeMaterializationPlan {
  schema: 1;
  kind: "archive-byte-transforms-v1";
  assertions: readonly { sourcePath: string; bytesHex: string }[];
  recipes: readonly LazyTreeByteTransformRecipe[];
  transforms: readonly {
    sourcePath: string;
    recipe: string;
    input: LazyTreeByteIdentity;
    output: LazyTreeByteIdentity;
  }[];
}
```

The mount security boundary is deliberately small:

```ts
export type MountSetIdCapability =
  | { kind: "nosuid" }
  | {
      kind: "trusted-root-product";
      guestWritable: false;
      stableExecutableIdentity: true;
    };

export interface MountConfig {
  mountPoint: string;
  backend: FileSystemBackend;
  readonly?: boolean;
  setIdCapability?: MountSetIdCapability;
}
```

Omission means `nosuid`. Mount construction rejects
`trusted-root-product` unless both booleans have the exact safe values and
the backend implements the stable executable-lease contract.

Reusable terminal supervision uses:

```ts
export interface TerminalProgram {
  programPath: string;
  programBytes?: ArrayBuffer;
  argv: string[];
  env?: string[];
  cwd?: string;
  uid?: number;
  gid?: number;
}

export interface TerminalSessionPolicy {
  initial: TerminalProgram;
  afterExit: TerminalProgram;
  shortRunThresholdMs: 2_000;
  initialRestartDelayMs: 250;
  maximumRestartDelayMs: 5_000;
}
```

Every logical PTY consumes `initial` once, then uses `afterExit` for all
later process generations. UI detach is not logical PTY removal.

## Gate Outcome Rule

Each gate below is a stop condition. If a required invariant fails, keep the
smallest reproducer red, trace the actual owning layer, insert a
purpose-scoped repair commit immediately after that gate, and rerun the whole
gate. Do not reinterpret a skip, timeout, containment shutdown, or narrow unit
test as passing evidence. If the repair needs an interface forbidden by the
approved design, stop implementation and ask Brandon to revise the design.

---

### Task 1: Preserve the pre-login tip and repair the launcher fixture

**Files:**

- Modify: `scripts/test-homebrew-patched-launcher.sh`
- Test: `scripts/test-homebrew-patched-launcher.sh`

**Interfaces:**

- Consumes: exact pre-login commit `bd8ac83e3`
- Produces: safety reference `safety/abi43-pre-login-20260810`; isolated
  launcher fixtures containing every source imported by `run-example.ts`

- [ ] **Step 1: Create and verify the safety reference**

```bash
git branch safety/abi43-pre-login-20260810 bd8ac83e3
test "$(git rev-parse safety/abi43-pre-login-20260810)" = \
  "bd8ac83e34f529887b0dd5ff4e1bb9d349bc7aed"
```

- [ ] **Step 2: Make the fixture test assert the missing dependency**

Add `examples/run-example-vfs.ts` beside the existing
`run-example-output.ts` and `run-example-paths.ts` checks in both isolated
fixture lists. The expected failing condition is module resolution failure
for `./run-example-vfs`.

- [ ] **Step 3: Run the focused test and observe the pre-fix failure**

Run:

```bash
scripts/dev-shell.sh bash scripts/test-homebrew-patched-launcher.sh
```

Expected before the copy-list repair: FAIL naming
`examples/run-example-vfs.ts` or its unresolved import.

- [ ] **Step 4: Copy the dependency into every isolated runtime**

In both source arrays, keep this complete adjacent set:

```bash
examples/run-example.ts
examples/run-example-output.ts
examples/run-example-paths.ts
examples/run-example-vfs.ts
```

- [ ] **Step 5: Rerun and commit**

```bash
scripts/dev-shell.sh bash scripts/test-homebrew-patched-launcher.sh
git add scripts/test-homebrew-patched-launcher.sh
git commit -m "Homebrew: Complete the isolated launcher fixture"
```

Expected: PASS with no use of the repository's ambient `examples/` tree.

### Task 2: Give fork-instrument fixtures the explicit ABI 43 mode

**Files:**

- Modify: `scripts/build-fork-instrumented-test-fixture.sh`
- Test: `scripts/test-homebrew-inspect-bottle.sh`
- Test: `scripts/test-homebrew-tap-native-sidecars.sh`

**Interfaces:**

- Consumes: ABI 43 `kernel_fork(mode: i32) -> i32`
- Produces: structurally valid wasm32 and wasm64 ordinary-fork fixtures

- [ ] **Step 1: Add a signature assertion to the generated fixture test**

Require the generated WAT to contain this import and call shape for both
pointer widths:

```wat
(import "kernel" "kernel_fork"
  (func $kernel_fork (param i32) (result i32)))
(drop (call $kernel_fork (i32.const 0)))
```

Keep the deliberately malformed zero-argument negative fixture around line
448 of `scripts/test-homebrew-inspect-bottle.sh` unchanged.

- [ ] **Step 2: Run the focused consumers and observe the structural failure**

```bash
scripts/dev-shell.sh bash scripts/test-homebrew-inspect-bottle.sh
scripts/dev-shell.sh bash scripts/test-homebrew-tap-native-sidecars.sh
```

Expected before the repair: the generated positive fixture fails the ABI 43
fork import signature check.

- [ ] **Step 3: Update both WAT templates**

Apply the exact import and call shown in Step 1 to the wasm32 and wasm64
branches of `build-fork-instrumented-test-fixture.sh`. Mode `0` remains
ordinary fork; do not turn this fixture into vfork.

- [ ] **Step 4: Rerun and commit**

```bash
scripts/dev-shell.sh bash scripts/test-homebrew-inspect-bottle.sh
scripts/dev-shell.sh bash scripts/test-homebrew-tap-native-sidecars.sh
git add scripts/build-fork-instrumented-test-fixture.sh \
  scripts/test-homebrew-inspect-bottle.sh \
  scripts/test-homebrew-tap-native-sidecars.sh
git commit -m "ABI: Give fork fixtures an explicit fork mode"
```

Expected: both scripts PASS and the malformed negative fixture is still
rejected.

### Task 3: Establish the vfork mechanism-readiness gate

**Files:**

- Create: `scripts/run-vfork-readiness.sh`
- Create: `docs/measurements/2026-08-10-vfork-readiness.md`
- Modify: `host/test/vfork-lifetime.test.ts`
- Modify: `host/test/vfork-lifecycle-guest.test.ts`
- Modify: `host/test/fork-process-continuation.test.ts`
- Modify: `host/test/fork-borrowed-replay.test.ts`
- Modify: `apps/browser-demos/test/vfork-lifecycle.spec.ts`
- Modify: `apps/browser-demos/test/borrowed-fork-replay.spec.ts`
- Test fixtures: `programs/vfork-lifecycle.c`
- Test fixtures: `programs/vfork-from-thread.c`
- Test fixtures: `programs/vfork-fatal-lifecycle.c`
- Test fixtures: `programs/vfork-external-signal.c`
- Test fixtures: `programs/vfork-posix-state.c`

**Interfaces:**

- Consumes: `VforkLifetimeCoordinator`, `BorrowedVforkWorkspace`,
  `runWithProcessWorkerQuiescence`, ordinary fork mode `0`, vfork mode `1`
- Produces: `scripts/run-vfork-readiness.sh mechanism|integration`; exact
  no-copy, suspension, isolation, rollback, lifecycle, and cross-host gate

- [ ] **Step 1: Add explicit no-allocation and suspension assertions**

In the host and browser guest lifecycle tests, set
`maxProcessMemoryBytes` equal to the parent memory's initial byte length and
assert all of these observations:

```ts
expect(childMemory).toBe(parentMemory);
expect(fullProcessMemoryCreations).toBe(0);
expect(events).toContain("child-entered");
expect(events).not.toContain("parent-resumed-before-release");
expect(events).toContain("parent-resumed-after-release");
```

Cover a main-thread caller, a pthread caller with a runnable sibling, repeated
calls, rejected overlap and nesting, a side module, and an ordinary fork
control that creates a distinct copied memory.

- [ ] **Step 2: Add exact terminal-path assertions**

Parameterize successful exec, failed exec followed by `_exit`, direct `_exit`,
cooperative signal death, trap, Worker crash before memory access, and forced
external kill after memory access. Assert one settlement and no parent wedge.
For the forced browser kill, require status 139, the containment diagnostic,
and absence of `UNSAFE_PARENT_RESUMED`; do not assert normal parent return.

- [ ] **Step 3: Add private-control-state and POSIX-state assertions**

Verify the child's syscall channel, replay prefix, imported mutable globals,
loader state, continuation controller, and scratch workspace are distinct.
Use `vfork-posix-state` to verify shared OFD offset semantics, independent fd
table changes, cwd, signal dispositions and masks, pgid/sid, parentage,
zombie/wait status, and exact reaping.

- [ ] **Step 4: Run focused tests and retain every smallest failure**

```bash
scripts/dev-shell.sh bash scripts/build-programs.sh
scripts/dev-shell.sh bash -lc \
  'cd host && npx vitest run \
    test/vfork-lifetime.test.ts \
    test/vfork-workspace.test.ts \
    test/vfork-lifecycle-guest.test.ts \
    test/fork-process-continuation.test.ts \
    test/fork-borrowed-replay.test.ts \
    test/fork-from-dlopen-side-module-e2e.test.ts \
    test/dylink-fork-archive.test.ts'
scripts/dev-shell.sh bash -lc \
  'cd apps/browser-demos && npx playwright test \
    test/vfork-lifecycle.spec.ts \
    test/borrowed-fork-replay.spec.ts \
    --project=chromium --project=firefox --project=webkit'
```

Expected: every named test executes; no missing-fixture skip is accepted.
Apply the Gate Outcome Rule before continuing if any invariant fails.

- [ ] **Step 5: Implement the repeatable gate wrapper**

The script accepts exactly `mechanism` or `integration`, rejects other
arguments with exit 2, asserts it is running from the repository root in the
dev shell, builds programs, runs the focused Vitest list, runs fork-instrument
tests on the host Rust target, and runs all three Playwright projects. The
`integration` mode additionally includes the credential, prepared-target,
secure-exec, and nosuid tests introduced later.

```bash
case "${1:-}" in
  mechanism) integration=false ;;
  integration) integration=true ;;
  *) echo "usage: scripts/run-vfork-readiness.sh mechanism|integration" >&2;
     exit 2 ;;
esac
test -n "${IN_NIX_SHELL:-}" || {
  echo "run through scripts/dev-shell.sh" >&2
  exit 2
}
```

- [ ] **Step 6: Record only observed evidence**

In the measurement document, record the exact commit, kernel and guest
artifact SHA-256 digests, Node version, browser versions, each command and
status, no-copy ceiling, forced-kill containment result, and any remaining
gap. Use `NOT RUN` for later integration and release columns.

- [ ] **Step 7: Run the wrapper and commit the gate**

```bash
scripts/dev-shell.sh bash scripts/run-vfork-readiness.sh mechanism
git add scripts/run-vfork-readiness.sh \
  docs/measurements/2026-08-10-vfork-readiness.md \
  host/test/vfork-lifetime.test.ts \
  host/test/vfork-lifecycle-guest.test.ts \
  host/test/fork-process-continuation.test.ts \
  host/test/fork-borrowed-replay.test.ts \
  apps/browser-demos/test/vfork-lifecycle.spec.ts \
  apps/browser-demos/test/borrowed-fork-replay.spec.ts \
  programs/vfork-lifecycle.c programs/vfork-from-thread.c \
  programs/vfork-fatal-lifecycle.c programs/vfork-external-signal.c \
  programs/vfork-posix-state.c
git commit -m "Tests: Make vfork readiness an explicit gate"
```

Expected: mechanism gate PASS, or a distinct, tested repair commit exists and
the rerun passes. The measurement file must still call external browser kill
partial if it uses containment.

### Task 4: Forward-port authenticated immutable bottle destinations

**Files:**

- Modify: `host/src/homebrew-bottle-relocation.ts`
- Modify: `host/src/homebrew-vfs-builder.ts`
- Modify: `host/src/homebrew-runtime-layer-consumer.ts`
- Create: `host/test/homebrew-bottle-relocation.test.ts`
- Modify: `host/test/homebrew-vfs-builder.test.ts`

**Interfaces:**

- Consumes: authenticated receipt destination and source commit
- Produces: immutable `destinationPrefix` that is authoritative for bottle
  relocation and runtime activation

- [ ] **Step 1: Add failing prefix-authority cases**

Test the retired prefix declared by the guest-layout contract and
`/opt/kandelo/homebrew`, plus a mismatch between receipt destination and an
ambient runtime default. The mismatch must fail before publication; it must
not silently relocate to the default.

- [ ] **Step 2: Run the focused tests to prove current behavior is wrong**

```bash
scripts/dev-shell.sh bash -lc \
  'cd host && npx vitest run \
    test/homebrew-bottle-relocation.test.ts \
    test/homebrew-vfs-builder.test.ts \
    test/homebrew-runtime-support-materializer.test.ts'
```

Expected before the forward port: at least the non-default authenticated
destination case fails.

- [ ] **Step 3: Make authenticated destination data authoritative**

Thread one normalized `destinationPrefix` from verified receipt parsing into
relocation, activation, sidecar identity, and runtime-layer validation.
Reject empty, relative, dot-segment, NUL-containing, or inconsistent values.
Never consult a Homebrew installation default after authentication.

- [ ] **Step 4: Rerun and commit with source authorship**

```bash
scripts/dev-shell.sh bash -lc \
  'cd host && npx vitest run \
    test/homebrew-bottle-relocation.test.ts \
    test/homebrew-vfs-builder.test.ts \
    test/homebrew-runtime-support-materializer.test.ts'
git add host/src/homebrew-bottle-relocation.ts \
  host/src/homebrew-vfs-builder.ts \
  host/src/homebrew-runtime-layer-consumer.ts \
  host/test/homebrew-bottle-relocation.test.ts \
  host/test/homebrew-vfs-builder.test.ts \
  host/test/homebrew-runtime-support-materializer.test.ts
git commit --author='Brandon Payton <brandon@happycode.net>' \
  -m "Homebrew: Honor authenticated bottle destinations"
```

Expected: both historical prefixes pass and ambient prefix drift fails closed.

### Task 5: Decouple generic VFS materialization from Homebrew

**Files:**

- Create: `host/src/vfs/materialization-plan.ts`
- Create: `host/src/homebrew-deferred-tree-adapter.ts`
- Modify: `host/src/vfs/memory-fs.ts`
- Modify: `host/src/homebrew-vfs-builder.ts`
- Modify: `host/src/homebrew-runtime-layer-consumer.ts`
- Modify: `host/src/homebrew-vfs-formula-layer.ts`
- Modify: `host/test/lazy-tree.test.ts`
- Modify: `host/test/homebrew-vfs-builder.test.ts`
- Modify: `host/test/homebrew-runtime-support-materializer.test.ts`
- Modify: `host/test/node-lazy-archive-runtime.test.ts`
- Modify: `apps/browser-demos/test/lazy-archive-runtime.spec.ts`
- Modify: `apps/browser-demos/test/browser-package-layer.spec.ts`

**Interfaces:**

- Consumes: authoritative `destinationPrefix` from Task 4
- Produces: `LazyTreeMaterializationPlan`, `tar-gzip-v1`, and
  `adaptHomebrewDeferredTree(tree): AdaptedHomebrewDeferredTree`

- [ ] **Step 1: Add closed-schema parser tests**

Construct a generic TAR fixture containing a directory, regular file,
symbolic link, and hard link. Test eager and lazy materialization with an
exact byte replacement. Reject unknown keys, duplicate recipes, duplicate
transforms, odd/non-hex byte strings, unbounded replacement counts, missing
source inventory entries, input/output digest drift, unsafe paths, and a
transformed output whose actual length or digest differs from its declaration.
Match and replacement lengths may differ because authenticated Homebrew
prefixes require bounded expansion; reject arithmetic overflow or expansion
past the named global VFS limit before allocating the output.

The success fixture uses this complete shape:

```ts
const plan: LazyTreeMaterializationPlan = {
  schema: 1,
  kind: "archive-byte-transforms-v1",
  assertions: [{ sourcePath: "bin/tool", bytesHex: "2f6f6c642f" }],
  recipes: [{
    id: "prefix",
    replacements: [{ matchHex: "2f6f6c642f", replacementHex: "2f6e65772f" }],
    rejectHex: ["2f666f7262696464656e2f"],
  }],
  transforms: [{
    sourcePath: "bin/tool",
    recipe: "prefix",
    input: {
      sha256: "0da8bba3f971e84a1cb42935a03959b06879abcffc01c472d41030227bb19cf7",
      bytes: 5,
    },
    output: {
      sha256: "92a2fb6a1bcf1f8af0366d946016ee2601311aae9106f6eccaf905b1bfc6ab04",
      bytes: 5,
    },
  }],
};
```

- [ ] **Step 2: Run the generic tests and observe missing interfaces**

```bash
scripts/dev-shell.sh bash -lc \
  'cd host && npx vitest run test/lazy-tree.test.ts'
```

Expected: FAIL because `materialization-plan.ts`, `tar-gzip-v1`, or the
generic transform contract is absent.

- [ ] **Step 3: Implement the bounded generic plan**

Implement and export these exact functions:

```ts
export function validateLazyTreeMaterializationPlan(
  value: unknown,
  inventory: LazyTreeMaterializationSourceInventory,
): LazyTreeMaterializationPlan;

export function encodeMaterializationBytes(bytes: Uint8Array): string;
export function decodeMaterializationBytes(hex: string): Uint8Array;

export function applyLazyTreeByteTransformRecipe(
  source: Uint8Array,
  recipe: LazyTreeByteTransformRecipe,
): Uint8Array;
```

Bound entries, recipes, replacements, assertions, byte-pattern lengths, and
total decoded plan bytes with named constants. Apply transforms from exact
source bytes, verify input before replacement and output afterward, and use
the same function for eager and lazy paths. Keep callbacks, regexes, scripts,
receipt fields, Formula names, Cellar paths, and keg terms out of this module
and `MemoryFileSystem`.

- [ ] **Step 4: Implement the Homebrew adapter**

The adapter owns receipt, changed-file, prefix, keg, canonical-hard-link, and
relocation validation and returns only:

```ts
export interface AdaptedHomebrewDeferredTree {
  decoder: LazyTreeDecoder;
  source?: LazyTreeSourceInventory;
  materialization?: LazyTreeMaterializationPlan;
  entries: LazyTreeRegistrationEntry[];
}

export function adaptHomebrewDeferredTree(
  tree: HomebrewDeferredTreeDescriptor,
): AdaptedHomebrewDeferredTree;
```

Map the former `homebrew-bottle-tar-gzip-v1` decoder to `tar-gzip-v1` only
after validating the complete Homebrew descriptor.

- [ ] **Step 5: Advance the runtime-layer schema and fail closed**

Emit schema 6 for the relocation-plan contract. Read schema 4 ZIP artifacts.
For schema 5, accept only artifacts that need no receipt relocation; reject a
schema-5 bottle that has relocation data. If current HEAD already uses 6 for a
different reviewed meaning, select 7 consistently and update this plan's task
notes before editing.

- [ ] **Step 6: Prove cancellation, rollback, and atomic publication**

Add tests that abort fetch, replace a lazy generation, exhaust VFS capacity,
fail one member of an atomic tree, and mutate source identity before commit.
Assert no destination entry becomes visible and the prior generation remains
intact. Verify restore/rebase preserves the generic plan and does not restore
Homebrew vocabulary into MemoryFS.

- [ ] **Step 7: Run Node and browser coverage**

```bash
scripts/dev-shell.sh bash -lc \
  'cd host && npx vitest run \
    test/lazy-tree.test.ts \
    test/homebrew-vfs-builder.test.ts \
    test/homebrew-runtime-support-materializer.test.ts \
    test/node-lazy-archive-runtime.test.ts'
scripts/dev-shell.sh bash -lc \
  'cd apps/browser-demos && npx playwright test \
    test/lazy-archive-runtime.spec.ts \
    test/browser-package-layer.spec.ts \
    --project=chromium --project=firefox --project=webkit'
```

Expected: generic and adapted Homebrew eager/lazy results are byte-identical,
and all malformed or partial states fail before publication.

- [ ] **Step 8: Commit with source authorship**

```bash
git add host/src/vfs/materialization-plan.ts \
  host/src/homebrew-deferred-tree-adapter.ts \
  host/src/vfs/memory-fs.ts \
  host/src/homebrew-vfs-builder.ts \
  host/src/homebrew-runtime-layer-consumer.ts \
  host/src/homebrew-vfs-formula-layer.ts \
  host/test/lazy-tree.test.ts \
  host/test/homebrew-vfs-builder.test.ts \
  host/test/homebrew-runtime-support-materializer.test.ts \
  host/test/node-lazy-archive-runtime.test.ts \
  apps/browser-demos/test/lazy-archive-runtime.spec.ts \
  apps/browser-demos/test/browser-package-layer.spec.ts
git commit --author='Brandon Payton <brandon@happycode.net>' \
  -m "VFS: Separate archive materialization from Homebrew policy"
```

### Task 6: Make set-ID execution an explicit mount capability

**Files:**

- Modify: `host/src/vfs/types.ts`
- Modify: `host/src/vfs/default-mounts.ts`
- Modify: `host/src/vfs/index.ts`
- Modify: `host/src/vfs/memory-fs.ts`
- Modify: `host/src/vfs/host-fs.ts`
- Modify: `host/src/vfs/sharedfs-vendor.ts`
- Modify: `host/src/platform/node.ts`
- Modify: `host/src/kernel-worker.ts`
- Modify: `crates/shared/src/lib.rs`
- Modify: `crates/kernel/src/syscalls.rs`
- Modify: `host/test/vfs/default-mounts.test.ts`
- Modify: `host/test/vfs.test.ts`
- Create: `host/test/nosuid-exec.test.ts`
- Create: `apps/browser-demos/test/nosuid-exec.spec.ts`

**Interfaces:**

- Consumes: generic materialized trees from Task 5
- Produces: `MountSetIdCapability`; authoritative `ST_NOSUID`; an internal
  immutable-handle-generation capability required by prepared targets

- [ ] **Step 1: Write default-deny mount tests**

Test that omitted capability, every writable scratch backend, every backend
without stable executable identity, and unknown mounts report `ST_NOSUID`.
Test that malformed `trusted-root-product` requests are rejected during mount
construction, not downgraded silently.

```ts
expect(statfs.flags & ST_NOSUID).toBe(ST_NOSUID);
expect(() => resolveMountSetIdCapability({
  backend: immutableProductBackend,
  readonly: true,
  setIdCapability: {
    kind: "trusted-root-product",
    guestWritable: true,
    stableExecutableIdentity: true,
  } as unknown as MountSetIdCapability,
})).toThrow(/trusted root product mount must not be guest-writable/);

expect(() => resolveMountSetIdCapability({
  backend: immutableProductBackend,
  readonly: false,
  setIdCapability: {
    kind: "trusted-root-product",
    guestWritable: false,
    stableExecutableIdentity: true,
  },
})).toThrow(/trusted root product mount must be read-only/);
```

- [ ] **Step 2: Run the focused tests and observe the missing policy**

```bash
scripts/dev-shell.sh bash -lc \
  'cd host && npx vitest run \
    test/vfs/default-mounts.test.ts test/vfs.test.ts \
    test/nosuid-exec.test.ts'
```

Expected: FAIL because mount configuration does not carry or enforce a
set-ID capability.

- [ ] **Step 3: Add the capability and backend eligibility contract**

Add the `MountSetIdCapability` and `MountConfig` fields from the interface map.
Add this optional backend-owned capability:

```ts
export interface FileSystemBackend {
  readonly executableIdentityKind?: "immutable-handle-generation";
}

export function resolveMountSetIdCapability(
  config: Pick<MountConfig, "backend" | "readonly" | "setIdCapability">,
): MountSetIdCapability;
```

Only the internal immutable product backend supplies that literal. Resolution
also requires `readonly === true`; the requested capability's literal
`guestWritable: false` cannot override a writable mount. Its existing open
handle retains one exact inode generation through unlink or rename. Mutable,
host, SharedFS, and user-provided backends omit it and cannot be mounted
`trusted-root-product`; configuration cannot manufacture it.
Prepared targets retain the exact OFD/host handle and the host rereads and
compares bytes immediately before commit.

- [ ] **Step 4: Derive `ST_NOSUID` from the mounted backend**

In `VirtualPlatformIO.statfs`, OR `ST_NOSUID` when the selected mount is
omitted, unknown, writable, identity-unstable, or explicitly `nosuid`. Keep
Node and browser on the same shared implementation. Add the ABI constant to
shared/generated bindings only if it is not already present.

- [ ] **Step 5: Test execution policy without granting credentials yet**

Expose the resolved mount capability and lease identity to the kernel's
future target record. Until Task 10 commits credentials, test the decision
helper directly: set-ID bits are ignored on nosuid and preserved as a proposed
transition only on a valid trusted mount.

- [ ] **Step 6: Run Node and browser tests**

```bash
scripts/dev-shell.sh bash -lc \
  'cd host && npx vitest run \
    test/vfs/default-mounts.test.ts test/vfs.test.ts \
    test/nosuid-exec.test.ts'
scripts/dev-shell.sh bash -lc \
  'cd apps/browser-demos && npx playwright test \
    test/nosuid-exec.spec.ts \
    --project=chromium --project=firefox --project=webkit'
```

Expected: every default and unsafe mount is nosuid on every host; the one
synthetic trusted mount is distinguishable but grants no credentials before
the target-aware commit exists.

- [ ] **Step 7: Commit**

```bash
git add host/src/vfs/types.ts host/src/vfs/default-mounts.ts \
  host/src/vfs/index.ts host/src/vfs/memory-fs.ts \
  host/src/vfs/host-fs.ts host/src/vfs/sharedfs-vendor.ts \
  host/src/platform/node.ts host/src/kernel-worker.ts \
  crates/shared/src/lib.rs crates/kernel/src/syscalls.rs \
  host/test/vfs/default-mounts.test.ts host/test/vfs.test.ts \
  host/test/nosuid-exec.test.ts \
  apps/browser-demos/test/nosuid-exec.spec.ts
git commit -m "VFS: Default executable mounts to nosuid"
```

### Task 7: Publish privileged programs as independent product inodes

**Files:**

- Create: `host/src/vfs/privileged-projection.ts`
- Modify: `host/src/homebrew-vfs-builder.ts`
- Modify: `host/src/homebrew-vfs-planner.ts`
- Modify: `host/src/homebrew-runtime-layer-consumer.ts`
- Modify: `images/vfs/scripts/build-homebrew-vfs-image.ts`
- Modify: `host/test/homebrew-vfs-builder.test.ts`
- Modify: `host/test/homebrew-vfs-planner.test.ts`
- Create: `host/test/privileged-projection.test.ts`
- Modify: `apps/browser-demos/test/browser-package-layer.spec.ts`

**Interfaces:**

- Consumes: generic archive inventory from Task 5 and trusted mount
  capability from Task 6
- Produces: `PrivilegedProgramProjection`; unique, root-owned regular inodes
  at `/usr/bin/login`, `/usr/bin/sudo-lite`, and `/usr/bin/sudo`

- [ ] **Step 1: Define and test the closed projection record**

Use this exact shape:

```ts
export interface PrivilegedProgramProjection {
  schema: 1;
  formula: string;
  bottleSha256: string;
  sourcePath: string;
  destinationPath: string;
  uid: 0;
  gid: 0;
  mode: number;
  mountPoint: string;
  artifactValidationSha256: string;
}
```

Require `mode` to be `0o4755`, destination to be one of the reviewed product
paths, and the mount to be `trusted-root-product`. Reject unknown keys and
duplicate destinations.

- [ ] **Step 2: Add alias and policy failure tests**

Reject a source symlink, a projected symlink, a preserved hard link, a shared
inode with the bottle tree, a writable alias, non-root owner, writable parent,
unstable backend, unrecognized mount, digest mismatch, and source member
absent from the complete inventory.

- [ ] **Step 3: Run the tests and observe missing projection support**

```bash
scripts/dev-shell.sh bash -lc \
  'cd host && npx vitest run \
    test/privileged-projection.test.ts \
    test/homebrew-vfs-builder.test.ts \
    test/homebrew-vfs-planner.test.ts'
```

Expected: FAIL because the product cannot yet create a separate privileged
tree.

- [ ] **Step 4: Materialize independent regular files atomically**

Resolve a bottle hard link to its canonical regular source, authenticate its
bytes, then create a fresh destination inode with uid 0, gid 0, and mode
`04755`. Register the ordinary bottle tree and privileged tree separately.
Before publication compare `(dev, ino, generation)` for every projection
against all writable bottle inodes; abort the whole projection group on any
collision.

- [ ] **Step 5: Run Node and browser product tests**

```bash
scripts/dev-shell.sh bash -lc \
  'cd host && npx vitest run \
    test/privileged-projection.test.ts \
    test/homebrew-vfs-builder.test.ts \
    test/homebrew-vfs-planner.test.ts \
    test/homebrew-runtime-support-materializer.test.ts'
scripts/dev-shell.sh bash -lc \
  'cd apps/browser-demos && npx playwright test \
    test/browser-package-layer.spec.ts \
    --project=chromium --project=firefox --project=webkit'
```

Expected: product inodes are regular, unique, root-owned, non-writable, and
stable while the Homebrew prefix remains writable and nosuid.

- [ ] **Step 6: Commit**

```bash
git add host/src/vfs/privileged-projection.ts \
  host/src/homebrew-vfs-builder.ts \
  host/src/homebrew-vfs-planner.ts \
  host/src/homebrew-runtime-layer-consumer.ts \
  images/vfs/scripts/build-homebrew-vfs-image.ts \
  host/test/homebrew-vfs-builder.test.ts \
  host/test/homebrew-vfs-planner.test.ts \
  host/test/privileged-projection.test.ts \
  apps/browser-demos/test/browser-package-layer.spec.ts
git commit -m "Homebrew: Isolate privileged product programs"
```

### Task 8: Replace simulated identities with one POSIX credential record

**Files:**

- Create: `crates/kernel/src/credentials.rs`
- Modify: `crates/kernel/src/lib.rs`
- Modify: `crates/kernel/src/process.rs`
- Modify: `crates/kernel/src/process_table.rs`
- Modify: `crates/kernel/src/syscalls.rs`
- Modify: `crates/kernel/src/signal.rs`
- Modify: `crates/kernel/src/procfs.rs`
- Modify: `crates/kernel/src/terminal.rs`
- Modify: `crates/kernel/src/pty.rs`
- Modify: `crates/kernel/src/wasm_api.rs`
- Test: inline Rust tests in the modified modules

**Interfaces:**

- Consumes: `Credentials` shape and `NGROUPS_MAX = 32` from the interface map
- Produces: authoritative process-wide POSIX IDs and group membership checks

- [ ] **Step 1: Write a transition table as failing Rust tests**

Cover root and non-root `setuid`, `seteuid`, `setresuid`, and UID value
`u32::MAX` as the unchanged sentinel. Mirror the table for GIDs. Include:

```rust
pub const ID_UNCHANGED: u32 = u32::MAX;

assert_eq!(
    nonroot.setresuid(ID_UNCHANGED, other, ID_UNCHANGED),
    Err(Errno::EPERM),
);
assert_eq!(
    nonroot.setresuid(ID_UNCHANGED, saved, ID_UNCHANGED),
    Ok(()),
);
assert_eq!(root.setresuid(user, user, user), Ok(()));
assert_eq!((root.ruid, root.euid, root.suid), (user, user, user));
```

Add tests that `setuid` by root sets all three IDs, while an unprivileged
caller may only select its real or saved ID for effective identity. Reject
partial mutation on every error.

- [ ] **Step 2: Add group-list and access-decision tests**

Test ordered supplementary groups, empty groups, exactly 32 groups, 33 groups,
root-only mutation, and effective-primary or supplementary group matching for
file access, signal permission, sticky directories, ownership, PTY access,
and process inspection.

- [ ] **Step 3: Run kernel tests and observe simulated behavior**

```bash
scripts/dev-shell.sh bash -lc \
  'host_target=$(rustc -vV | sed -n "s/^host: //p"); \
   cargo test -p wasm-posix-kernel --target "$host_target" \
     credentials -- --nocapture'
```

Expected: FAIL because saved IDs and supplementary groups do not exist or
current syscalls are simulated aliases.

- [ ] **Step 4: Implement `Credentials` and process accessors**

Move every process identity field into the single record. Initialize root as
all zeroes and an explicitly configured UID/GID as all three values on its
side. Provide these accessors and membership helper:

```rust
pub fn real_uid(&self) -> u32;
pub fn effective_uid(&self) -> u32;
pub fn saved_uid(&self) -> u32;
pub fn real_gid(&self) -> u32;
pub fn effective_gid(&self) -> u32;
pub fn saved_gid(&self) -> u32;
pub fn is_member_of_group(&self, gid: u32) -> bool;
pub fn setuid(&mut self, uid: u32) -> Result<(), Errno>;
pub fn seteuid(&mut self, uid: u32) -> Result<(), Errno>;
pub fn setresuid(&mut self, ruid: u32, euid: u32, suid: u32)
    -> Result<(), Errno>;
pub fn setgid(&mut self, gid: u32) -> Result<(), Errno>;
pub fn setegid(&mut self, gid: u32) -> Result<(), Errno>;
pub fn setresgid(&mut self, rgid: u32, egid: u32, sgid: u32)
    -> Result<(), Errno>;
```

Replace all direct `proc.uid`, `proc.euid`, `proc.gid`, and `proc.egid`
consumers. Do not introduce per-thread or host-side credential caches.

- [ ] **Step 5: Implement atomic syscall semantics**

Have transition methods compute a complete candidate record, validate it,
then assign once. `getgroups(0)` returns the count, insufficient nonzero
capacity returns `EINVAL`, and only effective uid 0 may call `setgroups`.
Credential-changing syscalls remain process-wide under the kernel entry gate.

- [ ] **Step 6: Run kernel and process behavior tests**

```bash
scripts/dev-shell.sh bash -lc \
  'host_target=$(rustc -vV | sed -n "s/^host: //p"); \
   cargo test -p wasm-posix-kernel --target "$host_target" \
     credentials -- --nocapture; \
   cargo test -p wasm-posix-kernel --target "$host_target" \
     permission -- --nocapture; \
   cargo test -p wasm-posix-kernel --target "$host_target" \
     signal_permission -- --nocapture'
```

Expected: all transition, membership, permission, and atomicity cases PASS.

- [ ] **Step 7: Commit with source authorship**

```bash
git add crates/kernel/src/credentials.rs crates/kernel/src/lib.rs \
  crates/kernel/src/process.rs crates/kernel/src/process_table.rs \
  crates/kernel/src/syscalls.rs crates/kernel/src/signal.rs \
  crates/kernel/src/procfs.rs crates/kernel/src/terminal.rs \
  crates/kernel/src/pty.rs crates/kernel/src/wasm_api.rs
git commit --author='Brandon Payton <brandon@happycode.net>' \
  -m "POSIX: Make process credentials authoritative"
```

### Task 9: Serialize credentials and marshal complete group lists

**Files:**

- Modify: `crates/kernel/src/fork.rs`
- Modify: `crates/kernel/src/channel_scratch.rs`
- Modify: `crates/kernel/src/wasm_api.rs`
- Modify: `crates/shared/src/host_abi.rs`
- Modify: `crates/shared/src/channel_scalar.rs`
- Modify: `crates/shared/src/lib.rs`
- Modify: `host/src/kernel-worker.ts`
- Modify: `host/src/channel-scalar-contract.ts`
- Modify: `host/test/kernel-worker-copyback.test.ts`
- Modify: `host/test/kernel-scratch-transfer-boundaries.test.ts`
- Modify: `host/test/host-process-pointer-width.test.ts`
- Modify: `abi/snapshot.json`
- Modify: `host/src/generated/abi.ts`

**Interfaces:**

- Consumes: `Credentials`, `NGROUPS_MAX`, and process-wide atomicity from
  Task 8
- Produces: fork state version 15; bounded ABI descriptors for `getgroups`
  and `setgroups`; wasm32/wasm64 parity

- [ ] **Step 1: Add exact fork-state rejection tests**

Round-trip real/effective/saved UID and GID, 0 and 32 supplementary groups,
and `secure_exec`. Reject version 14, version 16, count 33, truncation at each
new field, integer overflow, and trailing bytes where the current exact parser
rejects them. Assert a vfork child mutation changes only the child record.

- [ ] **Step 2: Add channel transfer tests for both pointer widths**

For `getgroups`, cover a zero-size query with no destination, nonzero null
destination (`EFAULT`), insufficient capacity (`EINVAL`), exact capacity,
unused trailing entries preserved, and a malicious count above 32. For
`setgroups`, lend exactly `count * 4` input bytes and reject multiplication or
scratch-capacity overflow before allocation.

```ts
expect(getgroups({ size: 0, pointer: 0 })).toEqual({ count: 3 });
expect(getgroups({ size: 2, pointer: valid })).toEqual({ errno: EINVAL });
expect(getgroups({ size: 3, pointer: valid }).tail).toEqual(originalTail);
expect(setgroups({ size: 33, pointer: valid })).toEqual({ errno: EINVAL });
```

- [ ] **Step 3: Run focused Rust and host tests**

```bash
scripts/dev-shell.sh bash -lc \
  'host_target=$(rustc -vV | sed -n "s/^host: //p"); \
   cargo test -p wasm-posix-kernel --target "$host_target" \
     fork -- --nocapture; \
   cargo test -p wasm-posix-shared --target "$host_target" \
     getgroups -- --nocapture'
scripts/dev-shell.sh bash -lc \
  'cd host && npx vitest run \
    test/kernel-worker-copyback.test.ts \
    test/kernel-scratch-transfer-boundaries.test.ts \
    test/host-process-pointer-width.test.ts'
```

Expected before implementation: new state and multi-group cases FAIL.

- [ ] **Step 4: Advance the exact fork format**

Set `FORK_VERSION` to 15. Serialize IDs in this order:

```text
ruid, euid, suid, rgid, egid, sgid,
supplementary_group_count,
supplementary_group[0] through
supplementary_group[supplementary_group_count - 1] in stored order,
secure_exec
```

Deserialize into local values, validate the complete buffer, then install one
`Credentials` value. Apply the same format to fork and exec-state transport.
Never serialize prepared-target tokens or vfork borrowed-workspace state.

- [ ] **Step 5: Replace the special one-group host handler**

Describe both syscalls in the existing shared `SyscallArgDescriptor` table.
Remove `handleGetgroups` and its interception from `kernel-worker.ts`; use the
normal bounded scratch copy-in/copy-out path. Copy back only the returned
group count so unused guest entries retain their original bytes.

- [ ] **Step 6: Regenerate and check the ABI**

```bash
scripts/dev-shell.sh bash scripts/check-abi-version.sh update
scripts/dev-shell.sh bash scripts/check-abi-version.sh
```

- [ ] **Step 7: Rerun all focused tests and commit**

```bash
scripts/dev-shell.sh bash -lc \
  'host_target=$(rustc -vV | sed -n "s/^host: //p"); \
   cargo test -p wasm-posix-kernel --target "$host_target" fork; \
   cargo test -p wasm-posix-shared --target "$host_target" getgroups'
scripts/dev-shell.sh bash -lc \
  'cd host && npx vitest run \
    test/kernel-worker-copyback.test.ts \
    test/kernel-scratch-transfer-boundaries.test.ts \
    test/host-process-pointer-width.test.ts'
git add crates/kernel/src/fork.rs crates/kernel/src/channel_scratch.rs \
  crates/kernel/src/wasm_api.rs crates/shared/src/host_abi.rs \
  crates/shared/src/channel_scalar.rs crates/shared/src/lib.rs \
  host/src/kernel-worker.ts host/src/channel-scalar-contract.ts \
  host/test/kernel-worker-copyback.test.ts \
  host/test/kernel-scratch-transfer-boundaries.test.ts \
  host/test/host-process-pointer-width.test.ts \
  abi/snapshot.json libc/glue/abi_constants.h \
  libc/musl-overlay/include/bits/kandelo_limits.h \
  libc/musl-overlay/include/bits/kandelo_process_layouts.h \
  libc/musl-overlay/include/bits/kandelo_channel_scalars.h \
  libc/musl-overlay/include/bits/kandelo_thread_syscalls.h \
  libc/musl-overlay/src/process/wasm32posix/spawn_contract.h \
  host/src/generated/abi.ts
git commit --author='Brandon Payton <brandon@happycode.net>' \
  -m "ABI: Preserve complete credentials across process images"
```

### Task 10: Make exact prepared targets the kernel exec authority

**Files:**

- Create: `crates/kernel/src/exec_target.rs`
- Modify: `crates/kernel/src/lib.rs`
- Modify: `crates/kernel/src/process.rs`
- Modify: `crates/kernel/src/ofd.rs`
- Modify: `crates/kernel/src/syscalls.rs`
- Modify: `crates/kernel/src/wasm_api.rs`
- Modify: `crates/shared/src/lib.rs`
- Modify: `tools/xtask/src/dump_abi.rs`
- Modify: `host/src/kernel-worker.ts`
- Modify: `host/src/worker-main.ts`
- Modify: `host/src/node-kernel-worker-entry.ts`
- Modify: `host/src/browser-kernel-worker-entry.ts`
- Modify: `host/src/node-kernel-protocol.ts`
- Modify: `host/src/browser-kernel-protocol.ts`
- Create: `host/test/prepared-exec-target.test.ts`
- Modify: `host/test/kernel-exec-entry.test.ts`
- Modify: `host/test/kernel-entry-context-audit.test.ts`
- Modify: `host/test/kernel-scratch-contract.test.ts`
- Modify: `abi/snapshot.json`
- Modify: `host/src/generated/abi.ts`

**Interfaces:**

- Consumes: exact OFDs, stable executable leases, mount capabilities, and
  credentials from Tasks 6, 8, and 9
- Produces: `PreparedExecLedger` and every `kernel_*exec_target*` export from
  the interface map; one atomic target-aware commit path

- [ ] **Step 1: Add token lifetime and authority tests**

Test positive nonzero monotonic tokens, exhaustion before wrap, wrong owner,
wrong caller TID, wrong exec generation, cross-process use, cancellation,
double cancel, double commit, stale token after a competing commit, and ledger
drain on exit, signal death, trap, failed vfork, containment, and host teardown.
Every failed operation returns a specific errno and releases exactly one
retained OFD/lease.

- [ ] **Step 2: Add exact-object tests for path and fd execution**

Prepare `execve`, pathname `execveat`, and `execveat(AT_EMPTY_PATH)` targets.
After preparation, close the guest fd, rename the path, unlink the file, and
replace the old pathname. Read and commit must still refer to the retained
original object. Reads at explicit offsets must not change the OFD cursor.

- [ ] **Step 3: Add transaction and set-ID failure tests**

Cover missing, directory, non-regular, non-executable, nosuid, unstable
backend, mutation before revalidation, stale mode/owner, `ETXTBSY`, `ENOTSUP`,
compile rejection before commit, address-space preparation failure, and a
race between two pthread exec calls. Assert credentials, CLOEXEC descriptors,
signal state, argv/environment, and exec generation remain unchanged before a
successful commit.

- [ ] **Step 4: Run focused tests and observe missing exports**

```bash
scripts/dev-shell.sh bash -lc \
  'cd host && npx vitest run \
    test/prepared-exec-target.test.ts \
    test/kernel-exec-entry.test.ts \
    test/kernel-entry-context-audit.test.ts \
    test/kernel-scratch-contract.test.ts'
```

Expected: FAIL because target preparation, reading, cancellation, and commit
exports do not exist.

- [ ] **Step 5: Implement the ledger and exact OFD lease**

Use focused internal types:

```rust
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PreparedExecOwner {
    Process { pid: u32, caller_tid: u32, generation: u64 },
    Spawn { parent_pid: u32, child_pid: u32, launch: u64 },
}

pub struct PreparedExecTarget {
    token: u32,
    owner: PreparedExecOwner,
    ofd_ref: OpenFileDescRef,
    ofd_id: OfdId,
    file_id: Option<FileId>,
    stat: WasmStat,
    statfs: WasmStatfs,
    diagnostic_path: Vec<u8>,
}
```

`PreparedExecLedger` owns the extra OFD reference and monotonically allocates
tokens. Path preparation opens an internal read-only OFD. Empty-path
preparation retains the exact existing OFD. Commit/cancel removes the ledger
entry before releasing resources so a reentrant failure cannot consume it
twice.

- [ ] **Step 6: Implement read, revalidation, and proposed credentials**

Read through the retained handle with explicit offsets. Revalidate file ID,
mode, uid/gid, mount ID, mount capability, source identity, and exact bytes or
pinned immutable generation. Return `ETXTBSY` for detected mutation and
`ENOTSUP` when stable identity cannot be proven for a credential-bearing
target. Ignore set-ID bits on scripts and nosuid; for the final binary compute
new effective and saved IDs in a local `Credentials` candidate.

- [ ] **Step 7: Replace targetless kernel commit**

Implement the seven exports from the interface map. `kernel_exec_commit`
validates owner and generation, consumes the token on success or failure,
then atomically closes CLOEXEC descriptors, resets exec-sensitive state,
installs credentials and `secure_exec`, and increments `exec_generation`.
`kernel_spawn_exec_commit` calls the same internal validator without inventing
a child caller TID.

Remove public `kernel_exec_prepare`, `kernel_exec_setup`, and
`kernel_exec_setup_for_thread`. Remove path-only `HostIO::host_exec`; no
compatibility fallback remains.

- [ ] **Step 8: Regenerate ABI artifacts and run Rust/host tests**

```bash
scripts/dev-shell.sh bash scripts/check-abi-version.sh update
scripts/dev-shell.sh bash scripts/check-abi-version.sh
scripts/dev-shell.sh bash -lc \
  'host_target=$(rustc -vV | sed -n "s/^host: //p"); \
   cargo test -p wasm-posix-kernel --target "$host_target" \
     exec_target -- --nocapture'
scripts/dev-shell.sh bash -lc \
  'cd host && npx vitest run \
    test/prepared-exec-target.test.ts \
    test/kernel-exec-entry.test.ts \
    test/kernel-entry-context-audit.test.ts \
    test/kernel-scratch-contract.test.ts'
```

Expected: exact-object, token, set-ID proposal, cleanup, and race cases PASS;
ABI snapshot contains only the target-aware interfaces.

- [ ] **Step 9: Commit**

```bash
git add crates/kernel/src/exec_target.rs crates/kernel/src/lib.rs \
  crates/kernel/src/process.rs crates/kernel/src/ofd.rs \
  crates/kernel/src/syscalls.rs crates/kernel/src/wasm_api.rs \
  crates/shared/src/lib.rs tools/xtask/src/dump_abi.rs \
  host/src/kernel-worker.ts host/src/worker-main.ts \
  host/src/node-kernel-worker-entry.ts \
  host/src/browser-kernel-worker-entry.ts \
  host/src/node-kernel-protocol.ts host/src/browser-kernel-protocol.ts \
  host/test/prepared-exec-target.test.ts \
  host/test/kernel-exec-entry.test.ts \
  host/test/kernel-entry-context-audit.test.ts \
  host/test/kernel-scratch-contract.test.ts \
  abi/snapshot.json libc/glue/abi_constants.h \
  libc/musl-overlay/include/bits/kandelo_limits.h \
  libc/musl-overlay/include/bits/kandelo_process_layouts.h \
  libc/musl-overlay/include/bits/kandelo_channel_scalars.h \
  libc/musl-overlay/include/bits/kandelo_thread_syscalls.h \
  libc/musl-overlay/src/process/wasm32posix/spawn_contract.h \
  host/src/generated/abi.ts
git commit -m "ABI: Bind exec commits to exact prepared targets"
```

### Task 11: Carry opaque exec targets through both host runtimes

**Files:**

- Create: `host/src/exec-target.ts`
- Modify: `host/src/kernel-worker.ts`
- Modify: `host/src/kernel.ts`
- Modify: `host/src/worker-main.ts`
- Modify: `host/src/node-kernel-worker-entry.ts`
- Modify: `host/src/browser-kernel-worker-entry.ts`
- Modify: `host/src/node-kernel-host.ts`
- Modify: `host/src/browser-kernel-host.ts`
- Modify: `host/src/browser-kernel-protocol.ts`
- Modify: `host/test/exec-state-tracking.test.ts`
- Modify: `host/test/kernel-exec-entry.test.ts`
- Modify: `host/test/node-worker-adapter.test.ts`
- Modify: `host/test/spawn-host-parity.test.ts`
- Modify: `host/test/wasm-memory-write-audit.test.ts`
- Modify: `host/test/support/kernel-scratch-instance.ts`
- Create: `apps/browser-demos/test/prepared-exec-target.spec.ts`

**Interfaces:**

- Consumes: target exports from Task 10
- Produces: shared `PreparedExecLaunchRequest`, exact target reader, and
  target-shaped Node/browser Worker messages

- [ ] **Step 1: Change test doubles to reject path authority**

Replace five-argument `onExec(pid, path, argv, envp, callerTid)` mocks with
`ExecLaunchCallback`. Assert no callback or Worker message has
`credentialPath`, executable bytes from a path lookup, or a targetless setup
method. Keep `diagnosticPath` display-only by mutating it in a test and proving
the executed bytes remain those read through `target`.

- [ ] **Step 2: Add shebang and post-commit launch-failure tests**

For a shebang, prepare the script, ignore its set-ID bits, prepare the
interpreter as the final target, rewrite argv once, and commit only the
interpreter. Simulate replacement Worker construction failure after commit;
assert the old image does not return, the process dies, target resources
drain, and a vfork parent releases through the fatal-child path.

- [ ] **Step 3: Run shared host tests and observe the old callback shape**

```bash
scripts/dev-shell.sh bash -lc \
  'cd host && npx vitest run \
    test/exec-state-tracking.test.ts \
    test/kernel-exec-entry.test.ts \
    test/node-worker-adapter.test.ts \
    test/spawn-host-parity.test.ts \
    test/wasm-memory-write-audit.test.ts'
```

Expected: FAIL because the host still resolves and authorizes execution by
pathname and calls targetless kernel setup.

- [ ] **Step 4: Implement one shared target reader**

`readPreparedExecTarget` first gets the signed 64-bit size, rejects negative
or unsafe JavaScript-number lengths, allocates once under the program-size
limit, and loops over `kernel_exec_target_read` until exact EOF. Split every
64-bit offset into `(offsetLo, offsetHi)` without precision loss. On any
precommit failure call cancel exactly once.

```ts
export interface PreparedExecKernel {
  execTargetSize(ownerPid: number, target: number): bigint;
  execTargetRead(
    ownerPid: number,
    target: number,
    offset: bigint,
    destination: Uint8Array,
  ): number;
  execTargetCancel(ownerPid: number, target: number): number;
}

export async function readPreparedExecTarget(
  kernel: PreparedExecKernel,
  ownerPid: number,
  target: number,
): Promise<Uint8Array>;
```

- [ ] **Step 5: Replace host and Worker protocol shapes**

Use `PreparedExecLaunchRequest` in shared kernel worker, Node entry, browser
entry, and browser protocol. The shared layer performs materialization hint,
final preparation, byte read, ABI validation, compilation, replacement-memory
preflight, final lease revalidation, and commit. Do not yield between final
revalidation and kernel commit.

- [ ] **Step 6: Preserve entry-gate and memory-write boundaries**

Marshal all target exports through `CentralizedKernelWorker` under the same
entry context. Update scratch and memory-write audits so target read writes
only the explicitly lent destination and commit has no guest-memory write.
Ensure cleanup callbacks run after entry revocation where they can re-enter.

- [ ] **Step 7: Run Node and all-browser tests**

```bash
scripts/dev-shell.sh bash -lc \
  'cd host && npx vitest run \
    test/exec-state-tracking.test.ts \
    test/kernel-exec-entry.test.ts \
    test/node-worker-adapter.test.ts \
    test/spawn-host-parity.test.ts \
    test/wasm-memory-write-audit.test.ts'
scripts/dev-shell.sh bash -lc \
  'cd apps/browser-demos && npx playwright test \
    test/prepared-exec-target.spec.ts \
    --project=chromium --project=firefox --project=webkit'
```

Expected: Node and browsers share the same target authority and every
precommit/postcommit failure has the specified old-image behavior.

- [ ] **Step 8: Commit**

```bash
git add host/src/exec-target.ts host/src/kernel-worker.ts host/src/kernel.ts \
  host/src/worker-main.ts host/src/node-kernel-worker-entry.ts \
  host/src/browser-kernel-worker-entry.ts host/src/node-kernel-host.ts \
  host/src/browser-kernel-host.ts host/src/browser-kernel-protocol.ts \
  host/test/exec-state-tracking.test.ts \
  host/test/kernel-exec-entry.test.ts \
  host/test/node-worker-adapter.test.ts \
  host/test/spawn-host-parity.test.ts \
  host/test/wasm-memory-write-audit.test.ts \
  host/test/support/kernel-scratch-instance.ts \
  apps/browser-demos/test/prepared-exec-target.spec.ts
git commit -m "Host: Launch exact prepared exec targets"
```

### Task 12: Make posix_spawn order credentials, actions, and commit once

**Files:**

- Modify: `crates/kernel/src/spawn.rs`
- Modify: `crates/kernel/src/process.rs`
- Modify: `crates/kernel/src/wasm_api.rs`
- Modify: `host/src/kernel-worker.ts`
- Modify: `host/src/node-kernel-worker-entry.ts`
- Modify: `host/src/browser-kernel-worker-entry.ts`
- Modify: `host/test/spawn-pid-authority.test.ts`
- Modify: `host/test/spawn-blob-transport.test.ts`
- Modify: `host/test/spawn-host-parity.test.ts`
- Create: `host/test/spawn-credential-order.test.ts`

**Interfaces:**

- Consumes: complete credentials and prepared spawn target export
- Produces: one pending-child launch transaction ordered as RESETIDS,
  remaining attributes, file actions, authoritative target, commit, launch

- [ ] **Step 1: Add an observable ordering fixture**

Create a pending child whose parent has differing real/effective IDs and
supplementary groups. Make a credential-sensitive `open`, `chdir`, and
`fchdir` file action. Assert `POSIX_SPAWN_RESETIDS` changes effective IDs to
real IDs before those actions, supplementary groups remain inherited, and
each action runs once.

- [ ] **Step 2: Add preflight/final-target divergence tests**

The side-effect-free path candidate preflight may compile bytes A. Arrange a
file action or CWD change so the child's authoritative target is bytes B.
Assert B is recompiled, actions are not replayed, B is committed, and A is
discarded. On target failure, assert pending child rollback and unchanged
parent credentials.

- [ ] **Step 3: Run focused tests and observe wrong ordering or authority**

```bash
scripts/dev-shell.sh bash -lc \
  'cd host && npx vitest run \
    test/spawn-credential-order.test.ts \
    test/spawn-pid-authority.test.ts \
    test/spawn-blob-transport.test.ts \
    test/spawn-host-parity.test.ts'
```

Expected: new order/target tests FAIL against the current path-shaped spawn.

- [ ] **Step 4: Implement the pending-child transaction**

Keep only side-effect-free path preflight before child creation. After
reservation, inherit the complete credential record, apply RESETIDS, apply
remaining attributes, drain file actions exactly once, prepare the target in
the child's final CWD/fd/credential state, recompile on digest difference,
call `kernel_spawn_exec_commit`, then launch. Every failure retires the child,
target, reserved PID, host mirrors, and scratch transaction exactly once.

- [ ] **Step 5: Run focused and regression tests**

```bash
scripts/dev-shell.sh bash -lc \
  'cd host && npx vitest run \
    test/spawn-credential-order.test.ts \
    test/spawn-pid-authority.test.ts \
    test/spawn-blob-transport.test.ts \
    test/spawn-host-parity.test.ts \
    test/exec-state-tracking.test.ts'
```

Expected: RESETIDS/action ordering, one-shot side effects, target replacement,
and rollback PASS on both host adapters.

- [ ] **Step 6: Commit**

```bash
git add crates/kernel/src/spawn.rs crates/kernel/src/process.rs \
  crates/kernel/src/wasm_api.rs host/src/kernel-worker.ts \
  host/src/node-kernel-worker-entry.ts \
  host/src/browser-kernel-worker-entry.ts \
  host/test/spawn-pid-authority.test.ts \
  host/test/spawn-blob-transport.test.ts \
  host/test/spawn-host-parity.test.ts \
  host/test/spawn-credential-order.test.ts
git commit -m "POSIX: Order spawn credentials before file actions"
```

### Task 13: Enter secure musl startup for set-ID images

**Files:**

- Modify: `libc/musl-overlay/src/env/__libc_start_main.c`
- Modify: `libc/glue/syscall_imports.h`
- Modify: `crates/kernel/src/wasm_api.rs`
- Modify: `crates/shared/src/lib.rs`
- Modify: `tools/xtask/src/dump_abi.rs`
- Create: `programs/secure-exec-probe.c`
- Create: `host/test/secure-exec.test.ts`
- Modify: `abi/snapshot.json`
- Modify: `libc/glue/abi_constants.h`
- Modify: `host/src/generated/abi.ts`

**Interfaces:**

- Consumes: process `secure_exec` set by target-aware commit
- Produces: host query `kernel_process_secure_exec(pid) -> i32`, required guest
  import `kernel_get_secure_exec() -> i32`, musl `libc.secure` before
  constructors, and guaranteed open descriptors 0, 1, and 2

- [ ] **Step 1: Add a guest probe and failing host matrix**

The probe prints `issetugid()`, whether `secure_getenv("UNTRUSTED")` is null,
constructor-observed security state, timezone/locale/message-catalog lookup
results, and open/closed status for fd 0, 1, and 2. Run it under ordinary
exec, trusted set-ID exec, nosuid exec, and spawn with and without RESETIDS.

For each of the eight closed-stdio masks from `000` through `111`, close the
selected descriptors before exec and assert all three are open in the new
secure image and any replacement reads/writes `/dev/null`.

- [ ] **Step 2: Run the focused test and observe insecure startup**

```bash
scripts/dev-shell.sh bash scripts/build-programs.sh
scripts/dev-shell.sh bash -lc \
  'cd host && npx vitest run test/secure-exec.test.ts'
```

Expected: FAIL because musl leaves `libc.secure` false and does not repair
closed standard descriptors.

- [ ] **Step 3: Export and bind the authoritative marker**

Add `kernel_process_secure_exec(pid: u32) -> i32` to the host/kernel ABI. The
central worker calls it after commit and puts the boolean in its private
process launch message. Add required guest import
`kernel_get_secure_exec() -> i32` in `worker-main.ts`; it closes over that
kernel-owned launch value. User boot descriptors and public spawn APIs cannot
supply or override the field. Do not inspect environment, argv, diagnostic
path, or host configuration. Missing import is an ABI mismatch.

- [ ] **Step 4: Set `libc.secure` before constructors**

In `__init_libc`, call `kernel_get_secure_exec()` before locale, environment,
constructors, or `main`, then assign:

```c
libc.secure = kernel_get_secure_exec() != 0;
```

The marker remains true for the image even if application code later changes
effective IDs.

- [ ] **Step 5: Repair standard descriptors through normal syscalls**

For each fd from 0 through 2, use `fcntl(fd, F_GETFD)` to detect `EBADF`. Open
`/dev/null` with `O_RDWR`; because fd allocation is lowest-first it should
occupy the missing slot. If it does not, use `dup2(opened, fd)` then close the
temporary fd. On open or duplication failure, write no forged success and
terminate startup with status 127.

```c
static void secure_standard_fds(void) {
    for (int fd = 0; fd != 3; ++fd) {
        if (__syscall(SYS_fcntl, fd, F_GETFD) != -EBADF) continue;
        int opened = __syscall(SYS_openat, AT_FDCWD, "/dev/null", O_RDWR, 0);
        if (opened < 0) __syscall(SYS_exit_group, 127);
        if (opened != fd && __syscall(SYS_dup2, opened, fd) < 0)
            __syscall(SYS_exit_group, 127);
        if (opened != fd) __syscall(SYS_close, opened);
    }
}
```

Call this only when `libc.secure` is true and before application code.

- [ ] **Step 6: Regenerate ABI files and rebuild musl**

```bash
scripts/dev-shell.sh bash scripts/check-abi-version.sh update
scripts/dev-shell.sh bash scripts/check-abi-version.sh
scripts/dev-shell.sh bash scripts/build-musl.sh
scripts/dev-shell.sh bash build.sh
scripts/dev-shell.sh bash scripts/build-programs.sh
```

Expected: ABI check PASS, musl rebuild PASS, and probe artifact uses ABI 43.

- [ ] **Step 7: Run the full secure-startup matrix**

```bash
scripts/dev-shell.sh bash -lc \
  'cd host && npx vitest run \
    test/secure-exec.test.ts test/nosuid-exec.test.ts \
    test/spawn-credential-order.test.ts'
```

Expected: secure consumers reject untrusted environment lookup, every closed
stdio mask is repaired, and ordinary/nosuid images remain non-secure.

- [ ] **Step 8: Commit**

```bash
git add libc/musl-overlay/src/env/__libc_start_main.c \
  libc/glue/syscall_imports.h crates/kernel/src/wasm_api.rs \
  crates/shared/src/lib.rs tools/xtask/src/dump_abi.rs \
  host/src/kernel-worker.ts host/src/worker-main.ts \
  host/src/node-kernel-worker-entry.ts \
  host/src/browser-kernel-worker-entry.ts \
  host/src/node-kernel-protocol.ts host/src/browser-kernel-protocol.ts \
  programs/secure-exec-probe.c host/test/secure-exec.test.ts \
  abi/snapshot.json libc/glue/abi_constants.h \
  libc/musl-overlay/include/bits/kandelo_limits.h \
  libc/musl-overlay/include/bits/kandelo_process_layouts.h \
  libc/musl-overlay/include/bits/kandelo_channel_scalars.h \
  libc/musl-overlay/include/bits/kandelo_thread_syscalls.h \
  libc/musl-overlay/src/process/wasm32posix/spawn_contract.h \
  host/src/generated/abi.ts
git commit -m "Libc: Enter secure startup for set-ID images"
```

### Task 14: Clear set-ID bits after qualifying file mutations

**Files:**

- Modify: `host/src/platform/native-metadata.ts`
- Modify: `host/src/platform/node.ts`
- Modify: `host/src/vfs/memory-fs.ts`
- Modify: `host/src/vfs/host-fs.ts`
- Modify: `host/src/vfs/sharedfs-vendor.ts`
- Modify: `host/src/vfs/index.ts`
- Modify: `host/test/chown-sentinel.test.ts`
- Modify: `host/test/platform/native-metadata.test.ts`
- Modify: `host/test/node-host-vfs-only-metadata.test.ts`
- Modify: `host/test/vfs/host-fs-uid-gid.test.ts`
- Modify: `host/test/vfs/sharedfs-uid-gid.test.ts`
- Modify: `host/test/vfs.test.ts`
- Modify: `apps/browser-demos/test/chown-sentinel.spec.ts`

**Interfaces:**

- Consumes: authoritative uid/gid/mode and unique privileged inodes
- Produces: identical set-ID invalidation across MemoryFS, SharedFS, host FS,
  Node, and browser paths

- [ ] **Step 1: Build a backend mutation matrix**

For every backend, create one `06755` regular file and exercise `write`,
positioned write, append, truncate, ftruncate, chown, fchown, and lchown.
Assert successful content mutation clears `S_ISUID` and the executable
`S_ISGID`; ownership mutation clears both. Assert failed and zero-byte
operations do not mutate mode. Verify path and fd stat agree after each case.

- [ ] **Step 2: Run the matrix and identify only current gaps**

```bash
scripts/dev-shell.sh bash -lc \
  'cd host && npx vitest run \
    test/chown-sentinel.test.ts \
    test/platform/native-metadata.test.ts \
    test/node-host-vfs-only-metadata.test.ts \
    test/vfs/host-fs-uid-gid.test.ts \
    test/vfs/sharedfs-uid-gid.test.ts \
    test/vfs.test.ts'
```

Expected: at least one backend or descriptor mutation path retains stale
set-ID bits. Retain existing passing implementations unchanged.

- [ ] **Step 3: Centralize the invalidation decision**

Use one helper in native metadata and the equivalent MemoryFS primitive:

```ts
export function modeAfterRegularFileMutation(
  mode: number,
  kind: "content" | "ownership",
): number {
  if ((mode & S_IFMT) !== S_IFREG) return mode;
  return mode & ~(S_ISUID | S_ISGID);
}
```

Call it only after a successful qualifying operation. Preserve reviewed uid,
gid, and mode for internal publication of authenticated lazy projection bytes;
subsequent guest-visible mutation follows the normal clearing rule.

- [ ] **Step 4: Run Node and browser coverage**

```bash
scripts/dev-shell.sh bash -lc \
  'cd host && npx vitest run \
    test/chown-sentinel.test.ts \
    test/platform/native-metadata.test.ts \
    test/node-host-vfs-only-metadata.test.ts \
    test/vfs/host-fs-uid-gid.test.ts \
    test/vfs/sharedfs-uid-gid.test.ts \
    test/vfs.test.ts'
scripts/dev-shell.sh bash -lc \
  'cd apps/browser-demos && npx playwright test \
    test/chown-sentinel.spec.ts \
    --project=chromium --project=firefox --project=webkit'
```

Expected: all backends expose identical metadata after the complete matrix.

- [ ] **Step 5: Commit with source authorship**

```bash
git add host/src/platform/native-metadata.ts host/src/platform/node.ts \
  host/src/vfs/memory-fs.ts host/src/vfs/host-fs.ts \
  host/src/vfs/sharedfs-vendor.ts host/src/vfs/index.ts \
  host/test/chown-sentinel.test.ts \
  host/test/platform/native-metadata.test.ts \
  host/test/node-host-vfs-only-metadata.test.ts \
  host/test/vfs/host-fs-uid-gid.test.ts \
  host/test/vfs/sharedfs-uid-gid.test.ts host/test/vfs.test.ts \
  apps/browser-demos/test/chown-sentinel.spec.ts
git commit --author='Brandon Payton <brandon@happycode.net>' \
  -m "VFS: Invalidate set-ID bits after file mutation"
```

### Task 15: Persist devpts ownership, mode, and permission checks

**Files:**

- Modify: `crates/kernel/src/pty.rs`
- Modify: `crates/kernel/src/terminal.rs`
- Modify: `crates/kernel/src/syscalls.rs`
- Modify: `crates/kernel/src/wasm_api.rs`
- Create: `programs/pty-ownership.c`
- Create: `host/test/pty-ownership.test.ts`
- Modify: `host/test/terminal-attributes-api.test.ts`
- Create: `apps/browser-demos/test/pty-ownership.spec.ts`

**Interfaces:**

- Consumes: authoritative credentials and group membership
- Produces: one persistent uid, gid, and mode per PTY pair; identical path/fd
  metadata and open decisions

- [ ] **Step 1: Add PTY lifetime and permission tests**

Allocate a PTY as uid/gid 1000. Assert slave defaults to uid 1000, the
caller's effective tty group where configured, and mode `0620`. Compare path
stat and open-fd stat. Exercise root and owner chmod/chown, unauthorized
mutation, owner/group read/write, supplementary-group access, unrelated-user
denial, close/reopen, and pair destruction.

- [ ] **Step 2: Run focused tests and observe synthesized metadata**

```bash
scripts/dev-shell.sh bash scripts/build-programs.sh
scripts/dev-shell.sh bash -lc \
  'cd host && npx vitest run \
    test/pty-ownership.test.ts test/terminal-attributes-api.test.ts'
```

Expected: new persistent metadata or permission cases FAIL.

- [ ] **Step 3: Store metadata on `PtyPair`**

Construct PTYs with caller identity and keep:

```rust
pub struct PtyPair {
    pub uid: u32,
    pub gid: u32,
    pub mode: u32,
    // existing transport and terminal state
}
```

Use one `pty_pair_stat` helper for devpts path and descriptor stat. Route
chmod/chown through the stored pair and check slave open against the current
process credential record. Do not mirror PTY identity in the browser UI.

- [ ] **Step 4: Run Rust, Node, and browser tests**

```bash
scripts/dev-shell.sh bash -lc \
  'host_target=$(rustc -vV | sed -n "s/^host: //p"); \
   cargo test -p wasm-posix-kernel --target "$host_target" pty'
scripts/dev-shell.sh bash -lc \
  'cd host && npx vitest run \
    test/pty-ownership.test.ts test/terminal-attributes-api.test.ts'
scripts/dev-shell.sh bash -lc \
  'cd apps/browser-demos && npx playwright test \
    test/pty-ownership.spec.ts \
    --project=chromium --project=firefox --project=webkit'
```

Expected: metadata and permission results agree for paths, fds, Node, and all
browser engines.

- [ ] **Step 5: Commit with source authorship**

```bash
git add crates/kernel/src/pty.rs crates/kernel/src/terminal.rs \
  crates/kernel/src/syscalls.rs crates/kernel/src/wasm_api.rs \
  programs/pty-ownership.c host/test/pty-ownership.test.ts \
  host/test/terminal-attributes-api.test.ts \
  apps/browser-demos/test/pty-ownership.spec.ts
git commit --author='Brandon Payton <brandon@happycode.net>' \
  -m "PTY: Preserve slave ownership and mode"
```

### Task 16: Gate ppoll and pselect interruption without Linux wait flags

**Files:**

- Modify if red: `crates/kernel/src/process.rs`
- Modify if red: `crates/kernel/src/signal.rs`
- Modify if red: `crates/kernel/src/fork.rs`
- Modify if red: `crates/kernel/src/wasm_api.rs`
- Modify if red: `crates/kernel/src/syscalls.rs`
- Modify if red: `libc/glue/channel_syscall.c`
- Modify if red: `libc/musl-overlay/src/signal/wasm32posix/sigsetjmp.c`
- Modify if red: `host/src/kernel-worker.ts`
- Modify: `examples/select_signal_test.c`
- Modify: `host/test/select-signal-guest.test.ts`
- Modify: `host/test/kernel-blocking-retry-snapshot.test.ts`
- Modify: `host/test/process-wait-lifecycle.test.ts`
- Create: `apps/browser-demos/test/select-signal-browser.spec.ts`
- Modify: `packages/registry/program-packages.json` (generated source-projection
  cache identities after the guest source changes)
- Validate: `host/test/select-signal-outcome.test.ts`
- Validate: `host/test/readiness-wakeup.test.ts`
- Validate: `host/test/readiness-deadline.test.ts`

**Interfaces:**

- Consumes: each TID's current and saved wait mask, caught-signal delivery
  record, libc handler-return/retry state, and readiness wakeups
- Produces: handler masks formed from the current temporary wait mask,
  exactly-once pre-wait restoration, real wasm32/wasm64 interruption
  evidence in Node and BrowserKernel peers, and truthful rejection of Linux
  all-children wait options
- Preserves: ABI 43 channel and signal-delivery layouts. This is a semantic
  correction to existing batch behavior, not a new structure, protocol, or
  ABI-version change.

- [ ] **Step 1: Add the source branch's exact interruption cases**

Use a real C guest through `CentralizedKernelWorker`, not synthetic channel
or signal-record flags. Run the 16 semantic combinations for both wasm32 and
wasm64 (32 end-to-end cases total): `ppoll` and `pselect`, a signal pending
before entry and one arriving while blocked, null and non-null replacement
masks, and `SA_RESTART` clear and set.

Give the original mask, replacement mask, `sa_mask`, and delivered signal
different sentinel bits. The catcher itself must query `sigprocmask()` and
prove that its actual mask is the current wait mask (the replacement mask when
non-null, otherwise the original mask), unioned with `sa_mask` and the
delivered signal; compare every supported signal membership rather than only
the sentinel bits. After the catcher returns, prove the original mask is
restored once, with neither temporary nor catcher-only bits retained. A
lower-level per-TID test must cover the cancellation/retry handoff so that a
consumed saved mask cannot be restored a second time, including a pthread TID.

Use a host-observed guest gate to queue a signal before the wait entry, and a
host timer to deliver one while the real wait is blocked. Keep a finite
deadline and a pipe-readiness check in every case so an interruption cannot
drop either a wakeup or ordinary readiness. Record the libc-visible result and
`errno` before follow-up checks.

Follow POSIX Issue 8 exactly: `sigaction()` forms a handler mask from the
current mask union `sa_mask` and, absent `SA_NODEFER`/`SA_RESETHAND`, the
delivered signal. `ppoll()` installs its non-null replacement mask before
examining descriptors and restores it before return. With `SA_RESTART` clear,
both waits report `EINTR` when no descriptor is ready. `pselect()` explicitly
makes `SA_RESTART` restart versus `EINTR` implementation-defined; Kandelo
chooses and tests `EINTR`. `ppoll()` has no such exception, so its
`SA_RESTART` cases resume and observe the catcher-produced pipe readiness
before their finite deadline. Preserve a restarted timeout no longer than the
original interval.

Add a second-signal restart-window case: hold the first catcher after it makes
the pipe ready, queue a signal blocked by the ppoll replacement mask, and
release the catcher. The second signal must not run until restarted ppoll has
observed readiness and terminal restoration has made the original mask
current. Prove both signal masks, no lost readiness, and exactly-once final
restoration for wasm32 and wasm64.

Also cover the other Rust-owned temporary-mask exits: `sigsuspend` and `pause`
must retain their replacement/current-at-delivery mask through the catcher and
restore their pre-wait mask once before final `EINTR`; masked pthread
cancellation must perform the same exact cleanup before returning
`ECANCELED`. A finite SA_RESTART `ppoll` whose catcher runs past the original
deadline must time out at that original absolute deadline, not start a fresh
interval. After a restarted ppoll completes with immediate readiness, repeat
the exact same argument addresses and prove the independent call receives a
fresh deadline rather than a stale remainder from the completed call.

Exercise waits nested inside a caught handler, including ppoll, pselect,
sigsuspend, and pause on the main task and ppoll on a pthread. Reuse the same
ppoll descriptor, timeout, and mask arguments in an inner handler call and
explicitly restore the outer replacement mask before that inner call; prove
handler-depth identity, LIFO mask restoration, and an independent outer
deadline. Then leave a nested handler nonlocally with real
`sigsetjmp`/`siglongjmp` and `setjmp`/`longjmp`, issue a later
same-argument mask-swapping wait, and prove that every abandoned wait context
and deadline was retired. Prove `siglongjmp` honors both saved-mask modes,
generic `longjmp` preserves an explicitly restored application mask, and an
ordinary non-handler jump does not over-clean.
Deadline identity must be per logical libc invocation rather than a numeric
argument tuple or channel-global carry.

Run the same guest through a direct BrowserKernel runner with an in-memory
empty VFS. Chromium, Firefox, and WebKit must run wasm32; engines whose
`WebAssembly.validate` accepts Memory64 must also run wasm64. Record WebKit's
current Memory64 rejection as an engine boundary. The guest's numeric wait4
unknown-option rejection must execute through that real browser worker path.
Use a guest-published atomic gate in the real process memory for host signal
injection so the acceptance gate is deterministic rather than delay-based.

References: [sigaction](https://pubs.opengroup.org/onlinepubs/9799919799/functions/sigaction.html),
[poll/ppoll](https://pubs.opengroup.org/onlinepubs/9799919799/functions/poll.html),
and [select/pselect](https://pubs.opengroup.org/onlinepubs/9799919799/functions/select.html).

- [ ] **Step 2: Run the exact focused set**

```bash
scripts/dev-shell.sh bash scripts/build-musl.sh
scripts/dev-shell.sh bash scripts/build-musl.sh --arch wasm64posix
scripts/dev-shell.sh bash build.sh
scripts/dev-shell.sh bash -lc \
  'host_target=$(rustc -vV | sed -n "s/^host: //p"); \
   cargo test -p kandelo --target "$host_target" --lib \
     temporary_wait_mask_forms_handler_mask_and_cancel_restores_once && \
   cargo test -p kandelo --target "$host_target" --lib \
     ordinary_handler_return_uses_the_current_mask'
scripts/dev-shell.sh bash -lc \
  'cd host && npx vitest run \
    test/select-signal-guest.test.ts \
    test/select-signal-outcome.test.ts \
    test/readiness-wakeup.test.ts \
    test/readiness-deadline.test.ts \
    test/kernel-blocking-retry-snapshot.test.ts \
    test/process-wait-lifecycle.test.ts'
scripts/dev-shell.sh bash scripts/check-abi-version.sh
KANDELO_PLAYWRIGHT_PORT=56116 scripts/dev-shell.sh bash -lc \
  'cd apps/browser-demos && npx playwright test \
   test/select-signal-browser.spec.ts \
   --output=/tmp/task16-playwright'
```

Expected outcome A: the real guest cases pass without a production change.

Expected outcome B: retain the red evidence, trace mask ownership through
`sys_ppoll`/`sys_pselect6`, `kernel_dequeue_signal`, handler setup,
`rt_sigreturn`, retry/cancel/failure, and pthread callers, then change only
the responsible install, wakeup, restart, or restoration layer. Do not copy
an advisory-lock or other unrelated mock change.

- [ ] **Step 3: Assert the Linux wait flag remains absent**

```bash
! rg -n '__WALL' \
  crates/kernel crates/shared host/src libc/musl-overlay \
  --glob '!**/*test*'
```

Expected: no production `__WALL` symbol/name. A raw `0x40000000` search is
not a valid assertion because unrelated production constants may share that
numeric value. Instead, add focused wait-family regression evidence that
`wait4` rejects `0x40000000` with `EINVAL` before polling or registering a
waiter. This proves the Linux all-children option cannot enable behavior by
numeric value. The sudo Formula patch in Task 18 removes its use while
preserving `WUNTRACED` and `WNOHANG`.

- [ ] **Step 4: Commit the focused boundary with source authorship**

Keep conceptual changes separate: plan clarification, signal-mask ownership,
ppoll restart classification, the real guest plus wait-option regressions, and
any deterministic source-projection refresh caused by the guest source. Use
purpose-prefixed subjects and Brandon Payton as author. Do not commit the local
Task 16 report or unrelated submodule state.

### Task 17: Add first-party login and sudo-lite through the normal guest path

**Files:**

- Create: `programs/login.c`
- Create: `programs/sudo-lite.c`
- Create: `images/vfs/lib/demo-login.ts`
- Modify: `images/rootfs/etc/passwd`
- Modify: `images/rootfs/etc/group`
- Modify: `images/rootfs/etc/shadow`
- Create: `images/rootfs/etc/sudoers`
- Create: `images/rootfs/etc/motd.autologin`
- Modify: `MANIFEST`
- Modify: `scripts/build-programs.sh`
- Create: `host/test/login.test.ts`
- Create: `host/test/sudo-lite.test.ts`
- Create: `host/test/demo-login-image.test.ts`
- Create: `apps/browser-demos/test/sudo-lite.spec.ts`

**Interfaces:**

- Consumes: credentials, secure exec, PTY, root-owned privileged projection
- Produces: first-party source programs and truthful demo account/policy data;
  product binaries still come from Homebrew Formulae

- [ ] **Step 1: Add guest behavior tests before source files**

For login, cover password success/failure, unknown user, `-p`, `-f`, non-root
rejection of either option, `setgroups` then `setgid` then `setuid`, home CWD,
safe environment, ordinary `/etc/motd`, preauth-only
`/etc/motd.autologin`, and shell exec failure. For sudo-lite, cover wheel and
non-wheel users, password success/failure, `sudo -l`, malformed sudoers,
root transition, supplementary groups, safe environment, and `execvp` failure.

- [ ] **Step 2: Run focused tests and observe missing programs**

```bash
scripts/dev-shell.sh bash scripts/build-programs.sh
scripts/dev-shell.sh bash -lc \
  'cd host && npx vitest run \
    test/login.test.ts test/sudo-lite.test.ts \
    test/demo-login-image.test.ts'
```

Expected: FAIL because first-party sources and image policy are absent.

- [ ] **Step 3: Forward-port the final source behavior**

Use the final versions from `emdash/support-logins-8yaz3` as behavioral
reference, not an old patch application. `login` permits `-p` and `-f` only
when real uid is 0, initializes groups before dropping IDs, changes home,
prints the ordinary motd every time and the credential motd only for `-f`,
then execs the account shell. `sudo-lite` reads normal passwd/group/shadow and
sudoers files, requires wheel policy and password, establishes root IDs and
groups through syscalls, sanitizes environment, and execs the requested argv.

- [ ] **Step 4: Make demo account data canonical**

Use these constants only in `demo-login.ts` and derive product files from
them:

```ts
export const DEMO_LOGIN_USERNAME = "maker";
export const DEMO_LOGIN_PASSWORD = "kandelo";
export const DEMO_LOGIN_PASSWORD_HASH =
  "$6$kandelo$DKNPruix37YeUx9j4kJIGJ2NvXdqzxDr5b1D3xJZzbwFsNYuep8j3AtxB7OaTD6HWnz/adonyTamRx4XQwJ06/";
```

Set maker uid/gid 1000, add `wheel:x:10:maker`, keep shadow root-owned and
non-world-readable, and write a minimal sudoers policy for wheel. The rootfs
does not contain host-side authentication or a preauthenticated shell.

- [ ] **Step 5: Keep local builds test-only**

Teach `build-programs.sh` to compile these sources as fixtures without placing
regular files into Homebrew/product-owned resolver paths. Product assembly
must consume Task 18 bottles and Task 7 projections.

- [ ] **Step 6: Run Node and browser behavior**

```bash
scripts/dev-shell.sh bash scripts/build-programs.sh
scripts/dev-shell.sh bash -lc \
  'cd host && npx vitest run \
    test/login.test.ts test/sudo-lite.test.ts \
    test/demo-login-image.test.ts \
    test/secure-exec.test.ts test/pty-ownership.test.ts'
scripts/dev-shell.sh bash -lc \
  'cd apps/browser-demos && npx playwright test \
    test/sudo-lite.spec.ts \
    --project=chromium --project=firefox --project=webkit'
```

Expected: authentication and denial are real guest results; no test inserts a
synthetic shell or host-native program.

- [ ] **Step 7: Commit with source authorship**

```bash
git add programs/login.c programs/sudo-lite.c \
  images/vfs/lib/demo-login.ts images/rootfs/etc/passwd \
  images/rootfs/etc/group images/rootfs/etc/shadow \
  images/rootfs/etc/sudoers images/rootfs/etc/motd.autologin \
  MANIFEST scripts/build-programs.sh \
  host/test/login.test.ts host/test/sudo-lite.test.ts \
  host/test/demo-login-image.test.ts \
  apps/browser-demos/test/sudo-lite.spec.ts
git commit --author='Brandon Payton <brandon@happycode.net>' \
  -m "POSIX: Add real login and sudo-lite programs"
```

### Task 18: Add login and sudo Formulae and preserve pristine Ruby

**Files in a separate clean `Kandelo-dev/homebrew-tap-core` worktree:**

- Create: `Formula/login.rb`
- Create: `Formula/sudo-lite.rb`
- Create: `Formula/sudo.rb`
- Create: `patches/sudo/0001-kandelo-portability.patch`
- Audit and modify if needed: `Formula/ruby.rb` and its declared build inputs
- Test: Formula `test do` blocks and Kandelo tap validation

**Interfaces:**

- Consumes: exact Kandelo Task 17 commit, SDK `kandelo_wasm_build`, ABI 43,
  and normal Homebrew sidecar contracts
- Produces: three source-built Formulae; no bottle metadata is promotable
  until reviewed GitHub candidate workflows build it

- [ ] **Step 1: Create an isolated tap branch without touching staging**

Use the worktree skill at execution time. Base the tap branch on the current
protected main commit, name it `emdash/abi43-login-sudo`, and verify it is a
clean checkout before editing:

```bash
git status --short
git rev-parse HEAD
git branch --show-current
```

Do not use or modify Kandelo branch
`emdash/homebrew-pr-staging-1q1w6` for this work.

- [ ] **Step 2: Write Formula tests first**

`login` and `sudo-lite` tests execute the installed Wasm through the tap's
normal Kandelo test helper and verify `--help` or a deterministic invalid-use
exit. `sudo` tests its installed executable and records that its patched wait
source contains `WUNTRACED` and `WNOHANG` but not `__WALL`.

- [ ] **Step 3: Define first-party Formulae from the exact Kandelo commit**

Each first-party Formula pins the Automattic/kandelo archive for the exact
Task 17 commit and its SHA-256, selects only `programs/login.c` or
`programs/sudo-lite.c`, and invokes `kandelo_wasm_build`. It declares ABI 43,
normal dependencies, output members, license, and tests through current tap
conventions. It must not set `KANDELO_REGISTRY_BRIDGE`, invoke a registry
recipe, or copy `local-binaries`.

- [ ] **Step 4: Port upstream sudo 1.9.17p2 at the narrow boundary**

Pin the upstream archive and checksum. The patch removes `__WALL` from the two
child-wait option expressions while retaining `WUNTRACED` and `WNOHANG`; it
does not define `__WALL`, change Kandelo wait ABI, or claim Linux clone-child
support. Keep all other port changes tied to missing platform or build-system
boundaries and exercise normal PTY, signal, and wait code.

- [ ] **Step 5: Keep generated bottle metadata out of the source commit**

Declare dependencies, architectures, source identity, outputs, ABI 43, and
tests in the Formulae using current tap helpers. Do not add bottle stanzas,
`Kandelo/formula` sidecars, link manifests, provenance reports, or candidate
identities by hand; Task 20 generates local-test copies outside the tap and
Task 24's reviewed workflow generates candidate copies.

- [ ] **Step 6: Run tap validation and local Formula builds**

From the Kandelo worktree, with `KANDELO_TAP_ROOT` set to the absolute clean
tap worktree, first parse all Formulae:

```bash
scripts/dev-shell.sh bash -lc \
  'for formula_name in login sudo-lite sudo; do \
     ruby -c "$KANDELO_TAP_ROOT/Formula/$formula_name.rb"; \
   done'
```

Then run Task 20's local harness for actual bottle builds; static validation
alone is not Formula build evidence.

- [ ] **Step 7: Commit in the tap with preserved source attribution**

```bash
git add Formula/login.rb Formula/sudo-lite.rb Formula/sudo.rb \
  patches/sudo/0001-kandelo-portability.patch
git commit --author='Brandon Payton <brandon@happycode.net>' \
  -m "POSIX: Package login and sudo for Kandelo"
```

After committing, validate the exact Formula source closures:

```bash
KANDELO_TAP_COMMIT="$(git -C "$KANDELO_TAP_ROOT" rev-parse HEAD)"
for formula_name in login sudo-lite sudo; do
  scripts/dev-shell.sh bash scripts/homebrew-validate-formula-source-closure.sh \
    --tap-root "$KANDELO_TAP_ROOT" \
    --tap-repository kandelo-dev/homebrew-tap-core \
    --formula "$formula_name" \
    --base-ref "$KANDELO_TAP_COMMIT"
done
```

- [ ] **Step 8: Preserve the existing pristine-Ruby selection**

Audit the migrated Ruby Formula against Brandon's existing Kandelo removal
commit `87d842814b050ba2c1acbaa880059b3d1aa0e321`. Require the pinned upstream
archive, no source patch, no `ac_cv_func_vfork=no`, positive
`HAVE_WORKING_VFORK` assertions, and a build-time check that extracted CRuby
source matches upstream before configure. If migration already preserved
these facts, make no commit. If it reintroduced the temporary path, remove
only that residue and commit the forward port independently:

```bash
git add Formula/ruby.rb
git commit --author='Brandon Payton <brandon@happycode.net>' \
  -m "Ruby: Preserve pristine upstream vfork selection"
```

Do not stage generated bottle or sidecar metadata. Record the resulting exact
tap commit for Task 20's migration lock.

Do not open or merge the companion tap PR until Task 22's local matrix passes.

### Task 19: Supervise one login lifecycle per logical browser PTY

**Files:**

- Modify: `web-libs/kandelo-session/src/kernel-host.ts`
- Modify: `web-libs/kandelo-session/src/index.ts`
- Modify: `web-libs/kandelo-session/test/kandelo-session.test.ts`
- Create: `apps/browser-demos/pages/kandelo/kernel-host/demo-terminal-sessions.ts`
- Modify: `apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts`
- Modify: `apps/browser-demos/pages/kandelo/kernel-host/react.tsx`
- Modify: `apps/browser-demos/pages/kandelo/panes/Shell.tsx`
- Create: `apps/browser-demos/test/login-terminal-session.spec.ts`

**Interfaces:**

- Consumes: `TerminalProgram` and `TerminalSessionPolicy` from the interface
  map; `/usr/bin/login` from the product projection
- Produces: initial autologin exactly once per logical PTY, ordinary login
  afterward, bounded restart, and explicit logical removal

- [ ] **Step 1: Add fake-clock session unit tests**

Cover first attachment, repeat UI attachment, first process exit, logout,
ordinary-login exit, processes shorter and longer than two seconds, restart
delays `250, 500, 1000, 2000, 4000, 5000, 5000`, start failure, logical PTY
removal, kernel detach, reboot, destroy, and stale exit callbacks. Assert one
active process and at most one timer for each session.

```ts
expect(spawns[0].argv).toEqual(["login", "-p", "-f", "maker"]);
expect(spawns[1].argv).toEqual(["login", "-p"]);
expect(reattachSpawnCount).toBe(0);
expect(activeRestartTimers(session)).toBeLessThanOrEqual(1);
```

- [ ] **Step 2: Run the unit test and observe current respawn behavior**

```bash
scripts/dev-shell.sh bash -lc \
  'cd web-libs/kandelo-session && npx vitest run \
    test/kandelo-session.test.ts'
```

Expected: FAIL because the current default shell record has no initial versus
post-exit policy or generation-safe restart.

- [ ] **Step 3: Extend `LivePtySession` and public lifecycle methods**

Store:

```ts
interface LivePtySession {
  // existing path, history, listeners, and process fields
  logicalGeneration: number;
  processGeneration: number;
  autologinConsumed: boolean;
  startedAt: number;
  restartDelayMs: number;
  restartTimer: ReturnType<typeof setTimeout> | null;
  removed: boolean;
}
```

Add `removePty(path: string): void` to `KernelHost`. UI handle `close()` only
detaches listeners; `removePty` cancels the timer, invalidates generations,
closes the process/PTY, and deletes the logical record.

- [ ] **Step 4: Implement generation-safe restart and diagnostics**

Consume `initial` before starting it so a failed launch cannot retry
autologin. On process exit, compare logical and process generations, compute
runtime, reset delay to 250 ms at or above 2000 ms, otherwise double to at
most 5000 ms, and schedule one `afterExit` launch. A start failure appends a
plain terminal diagnostic and schedules nothing. Detach, reboot, and destroy
invalidate callbacks before clearing timers.

- [ ] **Step 5: Configure the demo without moving auth into React**

Export this policy from `demo-terminal-sessions.ts`:

```ts
export const DEMO_TERMINAL_SESSION_POLICY: TerminalSessionPolicy = {
  initial: {
    programPath: "/usr/bin/login",
    argv: ["login", "-p", "-f", "maker"],
    uid: 0,
    gid: 0,
  },
  afterExit: {
    programPath: "/usr/bin/login",
    argv: ["login", "-p"],
    uid: 0,
    gid: 0,
  },
  shortRunThresholdMs: 2_000,
  initialRestartDelayMs: 250,
  maximumRestartDelayMs: 5_000,
};
```

React passes policy and calls `removePty` only when the user removes the
terminal. It never validates a password or advances generations.

- [ ] **Step 6: Run unit and all-browser lifecycle tests**

```bash
scripts/dev-shell.sh bash -lc \
  'cd web-libs/kandelo-session && npx vitest run \
    test/kandelo-session.test.ts'
scripts/dev-shell.sh bash -lc \
  'cd apps/browser-demos && npx playwright test \
    test/login-terminal-session.spec.ts \
    --project=chromium --project=firefox --project=webkit'
```

Expected: every new terminal autologins once, UI reattachment does not, logout
starts ordinary login, failed password stays failed, and restart/teardown is
bounded and generation-safe.

- [ ] **Step 7: Commit with source authorship**

```bash
git add web-libs/kandelo-session/src/kernel-host.ts \
  web-libs/kandelo-session/src/index.ts \
  web-libs/kandelo-session/test/kandelo-session.test.ts \
  apps/browser-demos/pages/kandelo/kernel-host/demo-terminal-sessions.ts \
  apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts \
  apps/browser-demos/pages/kandelo/kernel-host/react.tsx \
  apps/browser-demos/pages/kandelo/panes/Shell.tsx \
  apps/browser-demos/test/login-terminal-session.spec.ts
git commit --author='Brandon Payton <brandon@happycode.net>' \
  -m "Browser: Supervise real login sessions per terminal"
```

### Task 20: Compose the CI-ready Homebrew product and staging handoff

**Files:**

- Modify: `homebrew/main-shell.Brewfile`
- Modify: `homebrew/main-shell-default.json`
- Modify: `homebrew/main-shell-demo.json`
- Modify: `homebrew/main-shell-materialization-policy.json`
- Modify: `homebrew/main-shell-homebrew-runtime-support.json`
- Modify: `homebrew/main-shell-brew-package-tree.json`
- Modify: `homebrew/main-shell-migration-lock.json`
- Modify: `host/src/homebrew-vfs-builder.ts`
- Modify: `scripts/build-homebrew-main-shell-closure.sh`
- Modify: `scripts/homebrew-generate-sidecars-from-env.sh`
- Create: `scripts/run-login-stack-local.sh`
- Create: `scripts/measure-homebrew-vfork-rss.ts`
- Create: `host/test/homebrew-login-product.test.ts`
- Modify: `scripts/homebrew-main-shell-image-contract.test.ts`
- Modify: `scripts/homebrew-main-shell-node-smoke.ts`
- Modify: `scripts/create-homebrew-guest-lifecycle-fixture.ts`
- Create: `apps/browser-demos/test/homebrew-login-lifecycle.spec.ts`

**Interfaces:**

- Consumes: exact clean tap checkout, local Formulae, generic materialization,
  privileged projections, login session policy, and existing Homebrew bottle,
  sidecar, composition, Node smoke, and closed-mirror tools
- Produces: checked-in product and authority contracts plus a frozen CI staging
  handoff. `run-login-stack-local.sh --tap-root --work-root [--browser-demo]`
  is the staging invocation interface; this worktree does not build the
  43-Formula closure or claim its execution evidence.

> **Superseded execution steps:** Per the 2026-08-12 amendment above, original
> Steps 6–10 and 12 below are staging-owned. They are retained only as the
> historical interface specification. The staging worktree and GitHub CI run
> them and provide the success evidence; Task 20 here stops at reviewed source
> contracts and a frozen handoff.

- [ ] **Step 1: Add product contract tests**

Require login, sudo-lite, sudo, Ruby, and shell in the product closure; three
privileged projections with exact paths/owners/modes; ordinary Homebrew prefix
nosuid; no registry bridge; pristine upstream Ruby with no PR #1166 patch or
`ac_cv_func_vfork=no`; deferred upstream sudo allowed; and exact bottle,
sidecar, VFS, kernel, and ABI identities. Reject a local sidecar passed to any
publication, promotion, selection-lock, or authorized-candidate validator.

- [ ] **Step 2: Add an explicit local provenance class**

Permit this record only behind the local harness and
`--review-pending-artifact` composition path:

```json
{
  "schema": 1,
  "provenance_kind": "local-test",
  "promotable": false,
  "published": false
}
```

The local generator binds exact commits, Formula bytes, bottle digests,
dependency evidence, and runtime evidence, but never emits a GitHub run as
authority. Every remote publisher/selection validator rejects
`provenance_kind: local-test` before copying bytes or mutating state.

- [ ] **Step 3: Run product tests and observe missing inputs**

```bash
scripts/dev-shell.sh bash -lc \
  'cd host && npx vitest run test/homebrew-login-product.test.ts'
scripts/dev-shell.sh bash -lc \
  'npx vitest run scripts/homebrew-main-shell-image-contract.test.ts'
```

Expected: FAIL because product policy and local-test provenance do not yet
carry the new Formulae and projections.

- [ ] **Step 4: Add the Formulae and projection policy**

Select the normal Homebrew roots in the Brewfile and product JSON. Project
only `/usr/bin/login`, `/usr/bin/sudo-lite`, and `/usr/bin/sudo` into the
trusted product mount. Keep Ruby and shells in ordinary Homebrew placement.
Bind each projection to exact Formula, bottle, source member, destination,
artifact validation digest, uid 0, gid 0, and mode `04755`.

- [ ] **Step 5: Implement strict harness argument and checkout validation**

Accept exactly:

```text
scripts/run-login-stack-local.sh \
  --tap-root /absolute/clean/homebrew-tap-core \
  --work-root /absolute/new-exclusive-directory \
  [--browser-demo]
```

Require `IN_NIX_SHELL`, absolute real tap directory, clean tracked and
untracked tap state, 40-character tap and Kandelo commits, ABI 43, and a
nonexistent work root below a real parent. Require the tap commit to equal
`catalog.tap_commit` in `homebrew/main-shell-migration-lock.json`; Task 20
updates that lock to the exact Task 18 tap commit and complete selected
Formula closure. Before creating output, inspect the committed Ruby Formula,
its complete declared source closure, and the configured source marker. Reject
any reference to `kandelo-posix-spawn.patch`, PR #1166's patch digest,
`ac_cv_func_vfork=no`, or a source tree that differs from the pinned upstream
Ruby archive. Compute that tree identity immediately after extraction, before
configure creates build outputs; no Ruby source patch is permitted. Reject
`/`, symlinks, an existing work root, dirty tap checkout, lock drift, and
unknown flags before building.

After validation, create the exclusive work root and a detached Kandelo
worktree at `$KANDELO_LOGIN_WORK_ROOT/kandelo-source` from the exact current
Kandelo `HEAD`, then initialize its submodules:

```bash
git worktree add --detach \
  "$KANDELO_LOGIN_WORK_ROOT/kandelo-source" \
  "$KANDELO_LOGIN_KANDELO_COMMIT"
git -C "$KANDELO_LOGIN_WORK_ROOT/kandelo-source" \
  submodule update --init --recursive
```

All builds and tests below run from that detached source, not from the
possibly dirty invoking worktree. Preserve it with the reports as exact-head
evidence; any later cleanup must use `git worktree remove` on this resolved
path rather than recursively deleting an unresolved path.

- [ ] **Step 6: Build musl, platform, fixtures, and local bottles**

From the detached source, the harness runs, in order:

```bash
bash scripts/build-musl.sh
bash build.sh
bash scripts/build-programs.sh
```

For `login sudo-lite sudo ruby` and each resolved dependency, invoke
`scripts/homebrew-bottle-build.sh` with the exact tap, `--arch wasm32`, a
formula-specific output directory, and the canonical bottle root URL returned
by `homebrew_bottle_root_url`. Collect the produced archive, bottle JSON,
dependency provenance, and runtime evidence. Never set `GITHUB_ACTIONS=true`
or reuse an ambient Homebrew prefix/cache. For Ruby, retain `config.h`, the
configure transcript, the extracted upstream `process.c` digest, and the final
instrumented Wasm digest. Require `HAVE_VFORK`, `HAVE_WORKING_VFORK`, and
`HAVE_WORKING_FORK`, and reject any PR #1166 source residue before accepting
the local bottle.

- [ ] **Step 7: Generate local-test sidecars and a closed mirror**

Invoke the sidecar generator once per bottle with exact file identities and
an explicit `KANDELO_HOMEBREW_PROVENANCE_KIND=local-test`. Validate each
sidecar in local mode, then construct the bottle mirror with the existing
closed-mirror helper. The published-sidecar validator must reject the same
directory.

- [ ] **Step 8: Compose without replacing checked-in assets**

Call:

```bash
bash scripts/build-homebrew-main-shell-closure.sh \
  --tap-root "$KANDELO_LOGIN_TAP_ROOT" \
  --expected-tap-sha "$KANDELO_LOGIN_TAP_COMMIT" \
  --work-dir "$KANDELO_LOGIN_WORK_ROOT/composition" \
  --out "$KANDELO_LOGIN_WORK_ROOT/main-shell.vfs.zst" \
  --report "$KANDELO_LOGIN_WORK_ROOT/composition-report.json" \
  --bottle-cache "$KANDELO_LOGIN_WORK_ROOT/bottle-cache" \
  --lazy-shell --review-pending-artifact
```

Use task-specific variables, never `HOME`, and leave all output under the
exclusive work root.

- [ ] **Step 9: Run the Node and browser lifecycle**

Run the image contract and Node smoke against the generated image and closed
mirror. Generate a Playwright fixture with
`create-homebrew-guest-lifecycle-fixture.ts`, then run Chromium, Firefox, and
WebKit. The scripted interaction covers:

```text
automatic maker login
id
sudo -l
sudo id
failed-password rejection
ordinary login after logout
nosuid execution rejection
Ruby spawning through vfork
brew tap/install/execute
```

With `--browser-demo`, print the exact `./run.sh browser` environment/asset
arguments and preserve the image and mirror for manual use; do not overwrite
repository assets.

- [ ] **Step 10: Measure and write bound evidence**

`measure-homebrew-vfork-rss.ts` samples the complete Node and Chromium process
trees before boot, before Ruby, at peak, after child reaping, and after three
repetitions. The harness writes JSON and Markdown reports containing exact
Kandelo/tap commits, ABI, Formula and bottle identities, kernel/VFS digests,
commands/statuses, browser versions/projects, vfork fork-mode evidence, RSS,
and `local-test` provenance for every artifact.

- [ ] **Step 11: Commit Kandelo product integration**

Commit before the exact-head run so the detached evidence source contains
the complete harness and implementation:

```bash
git add homebrew/main-shell.Brewfile homebrew/main-shell-default.json \
  homebrew/main-shell-demo.json \
  homebrew/main-shell-materialization-policy.json \
  homebrew/main-shell-homebrew-runtime-support.json \
  homebrew/main-shell-brew-package-tree.json \
  homebrew/main-shell-migration-lock.json \
  host/src/homebrew-vfs-builder.ts \
  scripts/build-homebrew-main-shell-closure.sh \
  scripts/homebrew-generate-sidecars-from-env.sh \
  scripts/run-login-stack-local.sh scripts/measure-homebrew-vfork-rss.ts \
  host/test/homebrew-login-product.test.ts \
  scripts/homebrew-main-shell-image-contract.test.ts \
  scripts/homebrew-main-shell-node-smoke.ts \
  scripts/create-homebrew-guest-lifecycle-fixture.ts \
  apps/browser-demos/test/homebrew-login-lifecycle.spec.ts
git commit --author='Brandon Payton <brandon@happycode.net>' \
  -m "Homebrew: Compose the ABI 43 login product"
```

- [ ] **Step 12: Run the committed harness end to end**

```bash
KANDELO_LOGIN_WORK_PARENT="$(mktemp -d)"
scripts/dev-shell.sh bash scripts/run-login-stack-local.sh \
  --tap-root "$KANDELO_TAP_ROOT" \
  --work-root "$KANDELO_LOGIN_WORK_PARENT/login-stack" \
  --browser-demo
```

Expected: command exits 0, all scripted lifecycle markers are present, all
three browser projects ran, reports identify local-test provenance, and the
image, mirror, detached source, and exact-head report remain in the work root.
If this gate finds a defect, apply the Gate Outcome Rule and rerun it against
the new committed `HEAD`; never relabel evidence from the earlier commit.

### Task 21: Revalidate ordinary-fork admission, retirement, and alternatives

**Files:**

- Modify only if red: `host/src/process-memory.ts`
- Modify only if red: `host/src/process-memory-creator-gate.ts`
- Modify: `host/test/process-memory-allocator.test.ts`
- Modify: `host/test/process-memory-creator-gate.test.ts`
- Modify: `host/test/process-memory-reclamation-rss.test.ts`
- Modify: `host/test/fork-memory-clone-guest.test.ts`
- Modify: `host/test/multi-worker.test.ts`
- Modify: `benchmarks/measure-fork-memory-components.mjs`
- Modify: `docs/measurements/2026-07-31-affordable-fork-then-exec.md`

**Interfaces:**

- Consumes: exact memory ownership and retirement already in ABI 43
- Produces: final-head evidence for pre-copy `EAGAIN`, actual-byte accounting,
  bounded retirement fallback, sparse-clone decision, and Worker/module churn

- [ ] **Step 1: Assert admission precedes allocation and copy**

Saturate retired-memory debt with exact current byte lengths, spy on
`WebAssembly.Memory`, and call `acquireForkMemoryClone`. Require
`ProcessMemoryRetirementBacklogError` with errno 11, zero constructor calls,
unchanged parent bytes, no child PID/registration, and no extra retirement
record. Repeat for grown wasm32 and wasm64 memories.

- [ ] **Step 2: Assert exact ownership and bounded fallback**

Cover owner plus aliases, exec retirement, final exact release, forced
termination taint, optional `FinalizationRegistry` evidence, actual guest
growth, memory/byte thresholds, waiters, bounded time fallback, telemetry
trimming, and teardown. The timer may release admission debt after the
documented bound, but must never claim physical reclamation.

- [ ] **Step 3: Run the ordinary-memory tests**

```bash
scripts/dev-shell.sh bash -lc \
  'cd host && npx vitest run \
    test/process-memory-allocator.test.ts \
    test/process-memory-creator-gate.test.ts \
    test/process-memory-reclamation-rss.test.ts \
    test/fork-memory-clone-guest.test.ts \
    test/multi-worker.test.ts'
```

Expected: all admission, ownership, reclamation, exact clone, and guest errno
cases PASS. Apply the Gate Outcome Rule to any failure before measuring.

- [ ] **Step 4: Repeat component measurements twice**

```bash
scripts/dev-shell.sh node benchmarks/measure-fork-memory-components.mjs \
  > /tmp/kandelo-fork-components-a.json
scripts/dev-shell.sh node benchmarks/measure-fork-memory-components.mjs \
  > /tmp/kandelo-fork-components-b.json
```

Record worker-only, module-worker, shared-memory Worker, full clone, and sparse
clone elapsed time and RSS. Sparse cloning is selectable only if the real
Homebrew lifecycle in Task 23 also lowers peak process-tree RSS without an
unacceptable latency/CPU increase on Node and browsers. Component results
alone do not authorize changing the production clone.

- [ ] **Step 5: Record the final-head conclusion**

Update the measurement document with exact commit/artifact hashes and current
results. Explicitly state whether Worker/module churn is material, whether
sparse cloning remains rejected, the admission thresholds, the fallback time
bound, and which data is allocation accounting versus physical RSS evidence.

- [ ] **Step 6: Commit test or documentation changes**

```bash
git add host/src/process-memory.ts \
  host/src/process-memory-creator-gate.ts \
  host/test/process-memory-allocator.test.ts \
  host/test/process-memory-creator-gate.test.ts \
  host/test/process-memory-reclamation-rss.test.ts \
  host/test/fork-memory-clone-guest.test.ts host/test/multi-worker.test.ts \
  benchmarks/measure-fork-memory-components.mjs \
  docs/measurements/2026-07-31-affordable-fork-then-exec.md
git diff --cached --quiet || \
  git commit -m "Fork: Revalidate memory admission and cloning costs"
```

### Task 22: Pass the post-integration vfork safety gate

**Files:**

- Modify: `host/test/vfork-lifetime.test.ts`
- Modify: `host/test/vfork-lifecycle-guest.test.ts`
- Modify: `host/test/fork-borrowed-replay.test.ts`
- Modify: `apps/browser-demos/test/vfork-lifecycle.spec.ts`
- Modify: `apps/browser-demos/test/borrowed-fork-replay.spec.ts`
- Modify: `programs/vfork-posix-state.c`
- Modify: `scripts/run-vfork-readiness.sh`
- Modify: `docs/measurements/2026-08-10-vfork-readiness.md`
- Modify if partial: `docs/future-improvements.md`
- Modify if partial: `docs/posix-status.md`

**Interfaces:**

- Consumes: credentials, prepared targets, spawn, secure startup, nosuid, and
  existing exact `memory_quiescent` lifetime
- Produces: integration-readiness evidence and a truthful partial-vfork record
  if browser forced termination still lacks an exact fence

- [ ] **Step 1: Add child-only credential cases**

From main-thread and pthread vfork callers, have the child change real,
effective, saved, and supplementary IDs, then exercise successful exec,
failed exec followed by `_exit`, direct `_exit`, trap, cooperative signal, and
forced external signal. Assert the parked parent retains its exact original
credential record and secure marker in every surviving path.

- [ ] **Step 2: Add target lifetime cases under borrowed memory**

Cover failed prepare, cancelled token, failed target read, mutation before
commit, successful set-ID commit, competing stale token, post-commit Worker
creation failure, and ledger drain during containment. Assert child control
state remains private and parent continuation cannot observe token scratch or
credential changes.

- [ ] **Step 3: Re-audit every borrowed-memory start boundary**

Instrument the lifecycle transition to distinguish:

```text
pre_start -> child_may_access_memory -> memory_quiescent -> released
```

A pre-start failure may roll back with errno. After
`child_may_access_memory`, assert every normal parent release has exact
`memory_quiescent`. Inject timeout, removed process-map entry, resolved
`terminate()`, and unreachable Worker wrapper; none may release the parent.

- [ ] **Step 4: Search for a portable exact forced-kill fence only within the
existing architecture**

Test Node's awaited terminate/exit and the available Chromium, Firefox, and
WebKit Worker events. Accept a fence only when an event is specified and
observed after all accesses to the shared backing are impossible in all four
hosts. Do not use delay, polling, object reachability, or Node-only evidence.

- [ ] **Step 5: Preserve and document containment if no exact fence exists**

When the browser result remains negative, keep status 139 and whole-address-
space containment. Add a substantive future-work section recording:

```text
missing guarantee: externally killed compute-bound borrower cannot publish
                   memory_quiescent
current behavior:  loud whole-address-space containment, no parent resume
affected surfaces: browser Worker lifecycle; possible host/instrument ABI
acceptance proof:  safe parent resume after external kill, exact quiescence,
                   Node/Chromium/Firefox/WebKit parity
```

Cross-link `vfork()` in `docs/posix-status.md` and call it partial for this
case. Do not describe containment as full POSIX vfork.

- [ ] **Step 6: Run the integration gate**

```bash
scripts/dev-shell.sh bash scripts/run-vfork-readiness.sh integration
```

Expected: no full child Memory allocation or copy, exact caller-thread
suspension, sibling progress, private control state, coherent failure and
terminal paths, original parent credentials, exact target cleanup, ordinary
fork independence, and all Node/Chromium/Firefox/WebKit tests PASS. The
external-kill case either proves an exact portable fence or proves containment
without unsafe resume.

- [ ] **Step 7: Update exact-head evidence and commit**

```bash
git add host/test/vfork-lifetime.test.ts \
  host/test/vfork-lifecycle-guest.test.ts \
  host/test/fork-borrowed-replay.test.ts \
  apps/browser-demos/test/vfork-lifecycle.spec.ts \
  apps/browser-demos/test/borrowed-fork-replay.spec.ts \
  programs/vfork-posix-state.c scripts/run-vfork-readiness.sh \
  docs/measurements/2026-08-10-vfork-readiness.md \
  docs/future-improvements.md docs/posix-status.md
git commit -m "Vfork: Preserve isolation across credentialed exec"
```

Do not stage `docs/future-improvements.md` or `docs/posix-status.md` when an
exact portable fence has made the partial-state text factually unnecessary.

### Task 23: Run whole-batch validation, performance, and local demonstration

**Files:**

- Modify: `docs/architecture.md`
- Modify: `docs/abi-versioning.md`
- Modify: `docs/browser-support.md`
- Modify: `docs/homebrew-publishing.md`
- Modify: `docs/posix-status.md`
- Modify if surface changed: `docs/fork-instrumentation.md`
- Modify: `docs/measurements/2026-08-10-vfork-readiness.md`
- Create: `docs/measurements/2026-08-10-abi43-login-stack.md`

**Interfaces:**

- Consumes: exact Kandelo and tap heads after Tasks 1-22
- Produces: whole-batch local readiness evidence; no hosted publication claim

- [ ] **Step 1: Update authoritative documentation before validation**

Document credentials, groups, secure exec, target transactions, nosuid mount
default, trusted projections, PTY ownership, browser login lifecycle, local
versus authorized bottle provenance, vfork status, and ABI 43 exports. Do not
mark hosted candidates, publication, pristine Ruby release, or full vfork
conformance complete unless the later evidence exists.

- [ ] **Step 2: Rebuild every ABI-bound artifact**

```bash
scripts/dev-shell.sh bash scripts/build-musl.sh
scripts/dev-shell.sh bash build.sh
scripts/dev-shell.sh bash scripts/build-programs.sh
scripts/dev-shell.sh bash scripts/check-abi-version.sh
```

Expected: clean builds and exact ABI snapshot/generated files.

- [ ] **Step 3: Run Rust workspace and fork-instrument suites**

```bash
scripts/dev-shell.sh bash -lc \
  'host_target=$(rustc -vV | sed -n "s/^host: //p"); \
   cargo test --workspace --target "$host_target"'
scripts/dev-shell.sh bash -lc \
  'host_target=$(rustc -vV | sed -n "s/^host: //p"); \
   cargo test -p fork-instrument --target "$host_target"'
```

Expected: PASS with no fork-instrument ABI/frame change. If the frame surface
did change, stop because the approved design forbids it.

- [ ] **Step 4: Run complete host and reusable-session suites**

```bash
scripts/dev-shell.sh bash -lc 'cd host && npx vitest run'
scripts/dev-shell.sh bash -lc \
  'cd web-libs/kandelo-session && npx vitest run'
```

Expected: PASS with no skipped required fixture.

- [ ] **Step 5: Run libc, POSIX, and Sortix conformance**

```bash
scripts/dev-shell.sh bash scripts/run-libc-tests.sh
scripts/dev-shell.sh bash scripts/run-posix-tests.sh
scripts/dev-shell.sh bash scripts/run-sortix-tests.sh \
  process signal io paths pty
```

Expected: selected tests PASS or match existing documented non-compromising
xfails. Any new xfail needs root-cause evidence and design review; do not add
one merely to finish the batch.

- [ ] **Step 6: Run Homebrew and local product evidence**

```bash
scripts/dev-shell.sh bash scripts/test-homebrew-patched-launcher.sh
scripts/dev-shell.sh bash scripts/test-homebrew-inspect-bottle.sh
scripts/dev-shell.sh bash scripts/test-homebrew-tap-native-sidecars.sh
KANDELO_LOGIN_WORK_PARENT="$(mktemp -d)"
scripts/dev-shell.sh bash scripts/run-login-stack-local.sh \
  --tap-root "$KANDELO_TAP_ROOT" \
  --work-root "$KANDELO_LOGIN_WORK_PARENT/login-stack" \
  --browser-demo
```

Expected: Formula builds, sidecars, composition, Node lifecycle, closed
mirror, login/sudo/Ruby/brew lifecycle, and all local provenance checks PASS.

- [ ] **Step 7: Run focused browsers and the complete browser suite**

```bash
scripts/dev-shell.sh bash -lc \
  'cd apps/browser-demos && npx playwright test \
    test/vfork-lifecycle.spec.ts \
    test/borrowed-fork-replay.spec.ts \
    test/prepared-exec-target.spec.ts \
    test/nosuid-exec.spec.ts \
    test/pty-ownership.spec.ts \
    test/login-terminal-session.spec.ts \
    test/sudo-lite.spec.ts \
    test/homebrew-login-lifecycle.spec.ts \
    --project=chromium --project=firefox --project=webkit'
scripts/dev-shell.sh bash -lc \
  'cd apps/browser-demos && npx playwright test'
```

Expected: focused and complete browser suites PASS on applicable projects;
each platform-bound skip is named in the evidence report.

- [ ] **Step 8: Validate browser assets and perform manual demonstration**

```bash
scripts/dev-shell.sh bash scripts/ci-check-browser-assets.sh
./run.sh browser
```

Use the local harness's preserved image and mirror. Manually perform every
command in Task 20's lifecycle list and record browser engine, console errors,
renderer survival, and observed output. A code review or Playwright run does
not replace this manual check.

- [ ] **Step 9: Run all performance suites before and after**

Use the saved pre-login safety tip in an isolated worktree for `before` and the
current exact head in a second isolated worktree for `after`. Build each
worktree's own ABI-bound programs and application inputs; do not share build
outputs across the comparison:

```bash
KANDELO_PERF_PARENT="$(mktemp -d)"
KANDELO_PERF_BEFORE="$KANDELO_PERF_PARENT/before"
KANDELO_PERF_AFTER="$KANDELO_PERF_PARENT/after"
KANDELO_PERF_EVIDENCE="$KANDELO_PERF_PARENT/evidence"
mkdir "$KANDELO_PERF_EVIDENCE"
git worktree add --detach "$KANDELO_PERF_BEFORE" \
  safety/abi43-pre-login-20260810
git worktree add --detach "$KANDELO_PERF_AFTER" HEAD

for KANDELO_PERF_SOURCE in \
  "$KANDELO_PERF_BEFORE" "$KANDELO_PERF_AFTER"; do
  git -C "$KANDELO_PERF_SOURCE" submodule update --init --recursive
  (
    cd "$KANDELO_PERF_SOURCE"
    scripts/dev-shell.sh bash scripts/build-musl.sh
    scripts/dev-shell.sh bash build.sh
    scripts/dev-shell.sh bash scripts/build-programs.sh
    scripts/dev-shell.sh bash -lc 'cd sdk && npm link'
    scripts/dev-shell.sh bash packages/registry/php/build-php.sh
    scripts/dev-shell.sh bash packages/registry/wordpress/setup.sh
    scripts/dev-shell.sh bash packages/registry/wordpress/build-wordpress.sh
    scripts/dev-shell.sh bash packages/registry/mariadb/build-mariadb.sh
    scripts/dev-shell.sh bash packages/registry/mariadb/build-mariadb.sh \
      --wasm64
    scripts/dev-shell.sh bash \
      images/vfs/scripts/build-mariadb-vfs-image.sh
    scripts/dev-shell.sh bash \
      images/vfs/scripts/build-mariadb-vfs-image.sh --wasm64
  )
done

KANDELO_BEFORE_NODE_RESULT="$(
  cd "$KANDELO_PERF_BEFORE"
  scripts/dev-shell.sh npx tsx benchmarks/run.ts --rounds=3 2>&1 |
    tee "$KANDELO_PERF_EVIDENCE/before-node.log" |
    sed -n 's/^Results saved to //p' | tail -n 1
)"
test -f "$KANDELO_BEFORE_NODE_RESULT"
cp "$KANDELO_BEFORE_NODE_RESULT" \
  "$KANDELO_PERF_EVIDENCE/before-node.json"

KANDELO_BEFORE_BROWSER_RESULT="$(
  cd "$KANDELO_PERF_BEFORE"
  scripts/dev-shell.sh npx tsx benchmarks/run.ts \
    --host=browser --rounds=3 2>&1 |
    tee "$KANDELO_PERF_EVIDENCE/before-browser.log" |
    sed -n 's/^Results saved to //p' | tail -n 1
)"
test -f "$KANDELO_BEFORE_BROWSER_RESULT"
cp "$KANDELO_BEFORE_BROWSER_RESULT" \
  "$KANDELO_PERF_EVIDENCE/before-browser.json"

KANDELO_AFTER_NODE_RESULT="$(
  cd "$KANDELO_PERF_AFTER"
  scripts/dev-shell.sh npx tsx benchmarks/run.ts --rounds=3 2>&1 |
    tee "$KANDELO_PERF_EVIDENCE/after-node.log" |
    sed -n 's/^Results saved to //p' | tail -n 1
)"
test -f "$KANDELO_AFTER_NODE_RESULT"
cp "$KANDELO_AFTER_NODE_RESULT" \
  "$KANDELO_PERF_EVIDENCE/after-node.json"

KANDELO_AFTER_BROWSER_RESULT="$(
  cd "$KANDELO_PERF_AFTER"
  scripts/dev-shell.sh npx tsx benchmarks/run.ts \
    --host=browser --rounds=3 2>&1 |
    tee "$KANDELO_PERF_EVIDENCE/after-browser.log" |
    sed -n 's/^Results saved to //p' | tail -n 1
)"
test -f "$KANDELO_AFTER_BROWSER_RESULT"
cp "$KANDELO_AFTER_BROWSER_RESULT" \
  "$KANDELO_PERF_EVIDENCE/after-browser.json"

(
  cd "$KANDELO_PERF_AFTER"
  scripts/dev-shell.sh npx tsx benchmarks/compare.ts \
    "$KANDELO_PERF_EVIDENCE/before-node.json" \
    "$KANDELO_PERF_EVIDENCE/after-node.json" |
    tee "$KANDELO_PERF_EVIDENCE/node-comparison.md"
  scripts/dev-shell.sh npx tsx benchmarks/compare.ts \
    "$KANDELO_PERF_EVIDENCE/before-browser.json" \
    "$KANDELO_PERF_EVIDENCE/after-browser.json" |
    tee "$KANDELO_PERF_EVIDENCE/browser-comparison.md"
)
```

The four `test -f` checks make an aborted or skipped runner fail before a
comparison can be mislabeled. Preserve the evidence directory and record its
file hashes. Compare only common metrics as before/after evidence; name any
new or removed metric separately. Record Node and browser results plus Task
20's Node/Chromium process-tree RSS. Add Firefox/WebKit functional lifecycle
results; do not claim their RSS when the harness cannot measure a complete
engine process tree accurately.

- [ ] **Step 10: Write the measured result without broadening claims**

The dated measurement includes exact commits, artifacts, commands, statuses,
known skips, failure repairs, latency, RSS, retirement slopes, vfork no-copy
evidence, and the sparse-clone decision. Separate component, local product,
browser functional, and hosted release evidence.

- [ ] **Step 11: Commit documentation and measured evidence**

```bash
git add docs/architecture.md docs/abi-versioning.md \
  docs/browser-support.md docs/homebrew-publishing.md \
  docs/posix-status.md docs/fork-instrumentation.md \
  docs/measurements/2026-08-10-vfork-readiness.md \
  docs/measurements/2026-08-10-abi43-login-stack.md
git commit -m "Docs: Record ABI 43 login and vfork evidence"
```

Omit `docs/fork-instrumentation.md` from staging when the verified surface is
unchanged.

### Task 24: Consume active staging, prove pristine Ruby, and finish PRs

**Files:**

- Modify only after staging lands: reviewed product/staging declarations named
  by the landed `emdash/homebrew-pr-staging-1q1w6` interfaces
- Audit and modify if needed in tap: `Formula/ruby.rb` and its declared build
  inputs
- Generated remotely: Ruby candidate metadata required by the landed staging
  schema; do not edit it locally
- Modify: PR #1240 title and description
- Create: companion tap PR title and description

**Interfaces:**

- Consumes: active reviewed GitHub staging, exact final Kandelo/tap heads,
  protected policy, authorized candidate artifacts, and local readiness
- Produces: pristine upstream CRuby candidates, final lifecycle/RSS evidence,
  removal of PR #1166, and two reviewable rebase-merge PRs

- [ ] **Step 1: Verify staging is landed and enforcing before use**

Read the landed staging implementation and its approved roadmap. Confirm the
merge-gating workflow, exact-head request, required product manifest, evidence
schema, authorization, and promotion path are active rather than observe-only.
Do not copy or modify the old staging worktree. If it is not active, stop this
task; Tasks 1-23 remain locally complete but hosted/release readiness does not.

- [ ] **Step 2: Add only the landed canonical product declarations**

Declare ordinary login, sudo-lite, sudo, Ruby, and shell roots,
materialization, privileged projections, Node evidence, and browser evidence
through the landed schema. Let the tap planner resolve the exact tap snapshot
and dependency closure; do not add a hand-maintained Formula list or arbitrary
tap commit to the protocol.

- [ ] **Step 3: Make PR #1166 removal an exact tap-source invariant**

The current Kandelo history already contains Brandon's
`87d842814b050ba2c1acbaa880059b3d1aa0e321` pristine-CRuby selection. Audit
the migrated Ruby Formula and its entire declared build closure to ensure the
Homebrew move preserved that behavior. Reject the PR #1166 patch file or
digest, a `process.c` patch, `ac_cv_func_vfork=no`, missing working-vfork
configure assertions, or a source archive other than the pinned upstream
CRuby release.

If migration already removed every residue, record the exact clean tap commit
and make no empty or cosmetic commit. Otherwise remove only the temporary
patch selection, preserve all ordinary build inputs, increment the Formula
revision, and commit with Brandon as author because this is the Homebrew
forward port of his existing removal:

```bash
git add Formula/ruby.rb
git commit --author='Brandon Payton <brandon@happycode.net>' \
  -m "Ruby: Remove the temporary Kandelo spawn patch"
```

Do not hand-edit a bottle stanza, sidecar, candidate record, selection lock,
or published metadata in this commit.

- [ ] **Step 4: Bind pristine Ruby to the CI staging request**

If Step 3 changed the tap commit, update Kandelo's migration lock and commit
that exact selection independently:

```bash
git add homebrew/main-shell-migration-lock.json
git commit --author='Brandon Payton <brandon@happycode.net>' \
  -m "Homebrew: Select the pristine Ruby tap revision"
```

Bind the new tap commit to the GitHub CI staging request. CI must prove that the
pinned extracted source tree matches upstream before configure, that
`HAVE_VFORK`, `HAVE_WORKING_VFORK`, and `HAVE_WORKING_FORK` hold afterward,
and that uid 1000 takes vfork without child process Memory while the
root/privileged route takes ordinary fork with distinct copied child Memory.
This worktree does not rerun the 43-Formula local harness or produce
`local-test` outputs for this check.

- [ ] **Step 5: Request exact-head candidates through reviewed workflows**

The request binds PR #1240 head SHA, ABI 43, protected policy, the exact
pristine-Ruby tap commit, required products, Formulae, sidecars, Node/browser
evidence, and authorization identity. Review the resulting candidate metadata
and verify that every bottle was built by GitHub's isolated Formula builder.
Do not upload, relabel, or promote any local-test byte.

- [ ] **Step 6: Consume the exact GitHub CI lifecycle and RSS proof**

Review the GitHub CI report for real in-guest tap/install/execute for Ruby and
the complete closure, repeated at least three times, with Node and Chromium
process-tree baseline/peak/post-reap RSS, renderer survival, parent suspension,
and fork mode. The staging owner also supplies Firefox/WebKit functional
coverage and all required exact-head validation. Compare the CI result with
the checked-in product contracts and verify anonymous readback. No earlier
patched or local artifact may satisfy this evidence.

- [ ] **Step 7: Verify linear history and contributor attribution**

```bash
git log --merges origin/main..HEAD
git log --format=fuller origin/main..HEAD
git range-diff \
  8a66801e6^..ebde50611 \
  safety/abi43-pre-login-20260810..HEAD
git range-diff \
  c44ae8019^..3e30a7765 \
  safety/abi43-pre-login-20260810..HEAD
git diff --check origin/main...HEAD
```

Expected: zero merge commits, purpose-scoped commits, Brandon authorship on
derived work, current agent as committer where applicable, and no whitespace
errors. The first range names the two VFS source commits and the second names
the twelve login source commits. Inspect all fourteen directly when evaluating
the range diffs; divergent topology is expected, lost attribution is not.

- [ ] **Step 8: Update PR #1240 as an explicit batch PR**

Use a title no broader than:

```text
ABI: Batch ABI 43 process, VFS, login, sudo, and vfork changes
```

The description begins with `## Why`, lists every conceptual commit and source
PR/branch, explains ABI 43 and target removal, names the vfork partial boundary
if retained, links exact validation/evidence, names unrun or hosted-only gates,
and places this warning near the top and merge instructions:

```text
MUST be merged with rebase commits. DO NOT squash or create a merge commit.
```

Wrap prose to 72 columns. Do not claim that a PR is merge-gated until the
required staging lane is active.

- [ ] **Step 9: Open the companion tap PR**

Begin with `## Why`, list login, sudo-lite, upstream sudo, Ruby patch removal,
Formula sources, narrow `__WALL` portability patch, candidates, and exact
validation. Explain that local-test bottles were never promoted and that final
candidates bind the exact Kandelo ABI 43 head. Require rebase commits if the
tap PR also contains multiple conceptual commits.

- [ ] **Step 10: Stop before merge for Brandon's approval**

Report exact PR URLs, head SHAs, commit list, attribution audit, validation,
remaining skips, candidate identities, and Ruby patch-removal proof. Do not
merge the ABI, kernel, libc, host, VFS security, fork-instrument, Kandelo PR,
or companion tap PR without Brandon's explicit approval.

---

## Final Completion Checklist

- [ ] Pre-login safety reference resolves to the exact approved tip.
- [ ] Both baseline fixture defects are repaired independently.
- [ ] VFS generic materialization contains no Homebrew policy vocabulary.
- [ ] Writable and identity-unstable mounts enforce and report `nosuid`.
- [ ] Privileged programs are unique root-owned regular inodes with no
  writable aliases.
- [ ] Saved IDs, supplementary groups, permission checks, and fork state are
  authoritative and bounded.
- [ ] ABI 43 exposes only target-aware exec commit and secure-startup paths.
- [ ] `fexecve` and empty-path `execveat` retain the exact OFD through rename,
  unlink, close, and path replacement.
- [ ] Spawn RESETIDS, attributes, actions, target, commit, and launch order is
  proven without side-effect replay.
- [ ] Secure images set musl security state before constructors and repair
  every closed standard descriptor.
- [ ] Metadata mutation, devpts identity, poll interruption, login, sudo-lite,
  and upstream sudo pass through normal platform paths.
- [ ] Every logical browser PTY autologins once, then runs ordinary login with
  bounded generation-safe restart.
- [ ] vfork mechanism and integration gates prove no child memory allocation
  or copy, exact caller suspension, private control state, coherent failures,
  and ordinary-fork independence.
- [ ] Browser external-kill behavior has an exact portable fence or remains
  loudly contained and substantively documented as partial future work.
- [ ] Ordinary fork admits before allocation, charges actual bytes, returns
  truthful `EAGAIN`, and retains bounded documented retirement fallback.
- [ ] Sparse cloning and Worker/module churn conclusions use real RSS and are
  not promoted from component measurements alone.
- [ ] GitHub CI reports the Homebrew lifecycle and interactive browser product
  from exact reviewed heads. No private `local-test` run substitutes for it.
- [ ] Whole Rust, ABI, host, browser, libc, POSIX, Sortix, fork-instrument,
  Homebrew, performance, RSS, and manual validation evidence is recorded.
- [ ] Active hosted staging builds final candidates from exact reviewed heads.
- [ ] Pristine upstream Ruby uses vfork as uid 1000 and ordinary fork as root.
- [ ] PR #1166 is removed only from a rebuilt, republished, re-proven Ruby
  candidate.
- [ ] Kandelo and tap PRs preserve conceptual commits and require rebase merge,
  never squash.
