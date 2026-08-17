# POSIX Spawn Post-Commit Liveness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a committed `posix_spawn` child reach host Worker allocation without re-entering the kernel while its post-commit transaction is still draining.

**Architecture:** Remove the redundant pre-allocation child-liveness query from both host entries. Keep the existing post-allocation query as the single authoritative fence before registration, and lock that ordering into the shared spawn parity test.

**Tech Stack:** TypeScript, Vitest, Node worker host, browser worker host

## Global Constraints

- Preserve the kernel-entry reentrancy guard unchanged.
- Preserve Node/browser observable process behavior.
- Do not add an msmtpd-specific path.
- Do not register a Worker after a child exits during an asynchronous allocation.

---

### Task 1: Enforce post-allocation liveness ordering

**Files:**
- Modify: `host/test/spawn-host-parity.test.ts`
- Modify: `host/src/node-kernel-worker-entry.ts`
- Modify: `host/src/browser-kernel-worker-entry.ts`

**Interfaces:**
- Consumes: `CentralizedKernelWorker.shouldLaunchPendingChild(pid: number): boolean`
- Produces: one post-allocation liveness fence in each `handlePosixSpawn`

- [ ] **Step 1: Write the failing ordering regression**

Extract each `handlePosixSpawn` body with the test's existing helper. Locate
`createFreshProcessMemory`, `shouldLaunchPendingChild`, and `registerProcess`.
Assert that `shouldLaunchPendingChild` occurs exactly once, after allocation
and before registration:

```ts
expect(spawn.match(/shouldLaunchPendingChild/g)).toHaveLength(1);
expect(spawn.indexOf("createFreshProcessMemory")).toBeLessThan(
  spawn.indexOf("shouldLaunchPendingChild"),
);
expect(spawn.indexOf("shouldLaunchPendingChild")).toBeLessThan(
  spawn.indexOf("registerProcess"),
);
```

- [ ] **Step 2: Run the regression and verify RED**

Run:

```bash
scripts/dev-shell.sh bash -lc \
  'cd host && npx --no-install vitest run test/spawn-host-parity.test.ts'
```

Expected: FAIL for both Node and browser because each entry contains two
liveness queries and the first precedes allocation.

- [ ] **Step 3: Implement the minimal shared fix**

Delete only the first `shouldLaunchPendingChild` branch from each
`handlePosixSpawn`. Add a short comment explaining that the successful
prepared-target commit proves the child at callback entry and that the retained
post-allocation check owns kill-during-yield handling.

- [ ] **Step 4: Run focused spawn and lifecycle tests**

Run:

```bash
scripts/dev-shell.sh bash -lc \
  'cd host && npx --no-install vitest run \
    test/spawn-host-parity.test.ts \
    test/exec-state-tracking.test.ts \
    test/deferred-worker-start.test.ts \
    test/spawn-pid-authority.test.ts'
```

Expected: all selected tests pass.

- [ ] **Step 5: Commit the implementation**

```bash
git add host/test/spawn-host-parity.test.ts \
  host/src/node-kernel-worker-entry.ts \
  host/src/browser-kernel-worker-entry.ts
git commit -m "fix: defer spawn child liveness until after allocation"
```

### Task 2: Validate and publish the runtime repair

**Files:**
- Verify: all files from Task 1
- Verify: `abi/snapshot.json`

**Interfaces:**
- Consumes: the Task 1 branch
- Produces: a reviewable Kandelo pull request and hosted msmtpd retry input

- [ ] **Step 1: Run the complete host suite**

```bash
scripts/dev-shell.sh bash scripts/ci-run-test-suite.sh vitest
```

Expected: all host tests pass, including every resource-isolated case.

- [ ] **Step 2: Verify the ABI snapshot is unchanged**

```bash
scripts/dev-shell.sh bash scripts/check-abi-version.sh
```

Expected: the ABI check passes without changing `ABI_VERSION` or the snapshot.

- [ ] **Step 3: Review the exact branch diff**

```bash
git diff --check origin/main...HEAD
git status --short
git log --format=fuller origin/main..HEAD
```

Expected: only the approved design/plan, two host entries, and parity test are
changed; known submodule dirt remains unstaged.

- [ ] **Step 4: Open the purpose-first pull request**

Use a title describing the process-lifecycle outcome. Put `## Why` before
`## What changed`, list the exact validation, and state that hosted msmtpd is
not yet proven until its staging retry succeeds.

- [ ] **Step 5: Retry msmtpd after merge**

Dispatch the immutable ABI 43 request against the new Kandelo source only after
the runtime PR merges. Require the original standalone msmtpd service test to
build and pass before calling the end-to-end defect fixed.
