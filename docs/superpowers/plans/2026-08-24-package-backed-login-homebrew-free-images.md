# Package-Backed Login and Homebrew-Free Images Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans` to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish and validate the in-progress migration from the private
Homebrew-backed login product to ordinary package-backed set-ID programs and a
shared experimental terminal-session contract.

**Architecture:** VFS mount flags and executable metadata are the only set-ID
authority. Registry packages place `login`, `sudo-lite`, and `sudo` into
package-built root images, while `web-libs/kandelo-session` parses one
untrusted terminal-session document used by both Node and browser hosts.
Homebrew code remains dormant but is unreachable from active products,
workflows, and aggregate validation.

**Tech Stack:** Rust/Wasm kernel ABI, TypeScript host and VFS, Vitest,
Playwright, shell package builders, Cargo xtask, Nix dev shell.

**Spec:**
`docs/superpowers/specs/2026-08-24-package-backed-login-homebrew-free-images-design.md`

## Global Constraints

- Preserve complete POSIX behavior: any executable on a non-`nosuid` mount
  derives set-user-ID and set-group-ID transitions from current inode metadata.
- Omitted `nosuid` means false; automatically created scratch mounts set it
  explicitly.
- `login` is eager; `sudo-lite` and upstream `sudo` are lazy; all are uid 0,
  gid 0, mode `04755` at their ordinary `/usr/bin` paths.
- `/etc/kandelo/experimental-terminal-session.json` has no legacy fallback.
- Node and browser hosts remain peers.
- Active products, workflows, aggregate commands, and tests do not consume
  Homebrew.
- Build and validation commands run through `scripts/dev-shell.sh`.
- Incompatible ABI changes require an `ABI_VERSION` bump and regenerated
  `abi/snapshot.json` in the same change.
- Preserve the existing dirty worktree; do not discard or overwrite user
  changes while completing the implementation.

---

### Task 1: Audit the Existing Implementation Boundary

**Files:**

- Inspect: `host/src/vfs/default-mounts.ts`
- Inspect: `host/src/vfs/vfs.ts`
- Inspect: `host/src/browser.ts`
- Inspect: `host/src/index.ts`
- Inspect: `web-libs/kandelo-session/src/experimental-terminal-session.ts`
- Inspect: `images/vfs/scripts/package-shell-vfs-build.ts`
- Inspect: `packages/registry/{login,sudo-lite,sudo}/**`
- Inspect: `.github/workflows/**`
- Inspect: `.github/disabled-workflows/**`

**Interfaces:**

- Consumes: the approved design and the staged/unstaged implementation already
  present in this linked worktree.
- Produces: a classified diff in which active runtime authority, package
  composition, terminal policy, and dormant Homebrew surfaces have explicit
  owners.

- [x] **Step 1: Confirm linked-worktree isolation**

  Run `git rev-parse --git-dir`, `git rev-parse --git-common-dir`,
  `git branch --show-current`, and
  `git rev-parse --show-superproject-working-tree`.

- [x] **Step 2: Separate staged implementation from unstaged follow-up fixes**

  Run `git status --short --branch`, `git diff --cached --stat`,
  `git diff --stat`, `git diff --cached --name-status`, and
  `git diff --name-status`.

- [x] **Step 3: Check the diff for malformed patches**

  Run `git diff --cached --check` and `git diff --check`.
  Expected: both commands exit zero without output.

- [x] **Step 4: Audit removed authority references**

  Search tracked, non-generated active source for `setIdCapability`,
  `TRUSTED_ROOT_PRODUCT`, privileged product publishers, login-specific Vite
  inputs, and immutable login mounts. Classify every remaining reference as
  dormant Homebrew implementation, historical documentation, or an active
  contract violation.

### Task 2: Verify Set-ID and Mount Semantics

**Files:**

- Test: `host/test/nosuid-exec.test.ts`
- Test: `host/test/secure-exec.test.ts`
- Test: `host/test/vfs/default-mounts.test.ts`
- Test: `host/test/lazy-vfs.test.ts`
- Test: `apps/browser-demos/test/nosuid-exec.spec.ts`
- Test: `apps/browser-demos/test/secure-exec-startup.spec.ts`
- Modify only after RED reproduction: the lowest owning file under
  `host/src/vfs/`, `host/src/*kernel*`, or `crates/kernel/`.

**Interfaces:**

- Consumes: `MountSpec.nosuid`, `VirtualPlatformIO.fileHandleIdentity`, current
  executable metadata, and the existing secure-exec transition.
- Produces: ordinary setuid, setgid, combined set-ID, explicit-`nosuid`, inode
  stability, and mutation-clearing behavior shared by Node and browser.

- [x] **Step 1: Run focused host contract tests**

  Run through the dev shell:

  ```bash
  cd host
  npx vitest run \
    test/nosuid-exec.test.ts \
    test/secure-exec.test.ts \
    test/vfs/default-mounts.test.ts \
    test/lazy-vfs.test.ts
  ```

  Expected: all selected tests pass with no worker or kernel traps.

- [x] **Step 2: Diagnose any failure before editing (not required; Step 1 passed)**

  Re-run the single failing test, trace the executable metadata and mount flags
  across open, identity validation, and secure-exec commit, and state one
  root-cause hypothesis. Add or tighten a focused regression test and observe
  the expected RED failure before changing production code.

- [x] **Step 3: Apply the minimal owning-layer fix and verify GREEN (not required)**

  Change only the layer shown faulty by Step 2, re-run the focused RED test,
  then re-run the complete Task 2 host selection.

- [x] **Step 4: Run the browser set-ID checks**

  Run through the dev shell:

  ```bash
  cd apps/browser-demos
  npx playwright test \
    test/nosuid-exec.spec.ts \
    test/secure-exec-startup.spec.ts \
    --project=chromium
  ```

  Expected: both browser runtime paths pass without page, console, service
  worker, or kernel errors.

### Task 3: Verify Package Recipes and Image Composition

**Files:**

- Test: `tests/package-system/rootfs-package-manifest.test.ts`
- Test: `tests/package-system/source-rootfs-shell-bridge.test.ts`
- Test: `tests/package-system/browser-binary-dependencies.test.ts`
- Test: `scripts/vfs-product-catalog.test.mjs`
- Test: `packages/registry/shell/test-build-shell.sh`
- Modify only after RED reproduction: `packages/registry/{login,sudo-lite,sudo,shell,rootfs}/**`,
  `images/vfs/scripts/package-shell-vfs-build.ts`, or the package resolver under
  `tools/xtask/src/`.

**Interfaces:**

- Consumes: registry recipes, resolver-owned output paths, the worktree-local
  SDK, source-only cache generations, and product manifests.
- Produces: package-built root images with eager `login`, lazy `sudo-lite` and
  `sudo`, preserved uid/gid/mode, and no Homebrew runtime inputs.

- [x] **Step 1: Run focused package and catalog tests**

  Run through the dev shell:

  ```bash
  cd host
  npx vitest run \
    ../tests/package-system/rootfs-package-manifest.test.ts \
    ../tests/package-system/source-rootfs-shell-bridge.test.ts \
    ../tests/package-system/browser-binary-dependencies.test.ts
  cd ..
  node --test scripts/vfs-product-catalog.test.mjs
  bash packages/registry/shell/test-build-shell.sh
  ```

  Expected: recipes, outputs, metadata, and active product catalog checks pass.

- [x] **Step 2: Validate the already-built source-only projection**

  Inspect
  `local-binaries/source-only-v1/.kandelo/source-only-program-projection-v1.json`
  and use the normal resolver/checker to prove its files correspond to the
  current package graph. Do not treat mere file presence as evidence.

- [x] **Step 3: Rebuild changed package outputs when inputs require it (not required; current projection authenticated)**

  Run `scripts/dev-shell.sh bash scripts/run-local-build.sh` with the exact
  selected package/product target required by the resolver failure. Expected:
  every declared output is installed only below `WASM_POSIX_DEP_OUT_DIR`, the
  fork guard accepts fork-using artifacts, and the resulting projection passes
  Step 1 again.

### Task 4: Verify the Experimental Terminal Session

**Files:**

- Test: `web-libs/kandelo-session/test/kandelo-session.test.ts`
- Test: `host/test/login.test.ts`
- Test: `host/test/sudo-lite.test.ts`
- Test: `apps/browser-demos/test/login-terminal-session.spec.ts`
- Test: `apps/browser-demos/test/sudo-lite.spec.ts`
- Modify only after RED reproduction:
  `web-libs/kandelo-session/src/experimental-terminal-session.ts`,
  `host/src/shell-runtime-layout.ts`, or the shared host launch path.

**Interfaces:**

- Consumes: the version-1 experimental JSON document and ordinary guest paths,
  argv, uid, and gid.
- Produces: one passwordless initial `maker` login, real login after logout,
  truthful configuration errors, and ordinary set-ID `sudo-lite`/`sudo`.

- [x] **Step 1: Run parser and Node session tests**

  Run through the dev shell:

  ```bash
  cd host
  npx vitest run \
    ../web-libs/kandelo-session/test/kandelo-session.test.ts \
    test/login.test.ts \
    test/sudo-lite.test.ts
  ```

  Expected: parser bounds, unknown fields, missing/malformed configuration,
  initial launch, logout restart, and credentials all pass.

- [x] **Step 2: Run browser login and privilege tests**

  Run through the dev shell:

  ```bash
  cd apps/browser-demos
  npx playwright test \
    test/login-terminal-session.spec.ts \
    test/sudo-lite.spec.ts \
    --project=chromium
  ```

  Expected: the default route auto-logs in `maker`, logout produces `login:`,
  failed authentication is rejected, and both privilege paths report the real
  guest credentials.

### Task 5: Prove Homebrew Is Dormant

**Files:**

- Test: `scripts/ci-run-test-suite.sh`
- Test: `scripts/ci-vitest-evidence-classes.tsv`
- Test: `images/vfs/products/generated/catalog.json`
- Test: `.github/workflows/**`
- Test: `.github/disabled-workflows/**`

**Interfaces:**

- Consumes: active workflow triggers, package/product catalogs, browser route
  inputs, aggregate test registration, and standard developer commands.
- Produces: a structural proof that Homebrew implementation remains available
  only on dormant, explicitly disabled paths.

- [x] **Step 1: Enumerate active workflow and product reachability**

  Search only `.github/workflows`, enabled aggregate scripts, generated active
  catalogs, app routes, and default commands for Homebrew entry points.
  Expected: no enabled Homebrew build, test, publish, or runtime dependency.

- [x] **Step 2: Verify disabled workflows cannot trigger**

  Prove each retired file is outside GitHub's `.github/workflows` discovery
  directory and that same-repository references no longer point to those files
  from enabled workflows. The retained `on:` documents are inert at their
  `.github/disabled-workflows` paths.

- [x] **Step 3: Run structural package/product authority checks**

  Run through the dev shell:

  ```bash
  bash scripts/test-abi-staging-product-authority.sh
  node --test scripts/vfs-product-catalog.test.mjs
  ```

  Expected: active authority and catalog checks pass without executing
  Homebrew-specific build or test code.

### Task 6: Run Required Integration and Conformance Evidence

**Files:**

- Validate: `crates/**`
- Validate: `tools/xtask/**`
- Validate: `host/**`
- Validate: `apps/browser-demos/**`
- Validate: `tests/{libc,posix,sortix}/**`
- Validate: `abi/snapshot.json`

**Interfaces:**

- Consumes: the complete changed platform and prepared package artifacts.
- Produces: exact evidence for Rust, package resolver, host, browser, POSIX,
  Sortix, libc, and ABI claims.

- [ ] **Step 1: Rebuild changed low-level artifacts**

  Because fork instrumentation changed, run the fork tool build and the normal
  package instrumentation path before runtime suites. If libc overlay/glue is
  unchanged, do not rebuild musl merely because the submodule worktree is
  dirty; first classify the submodule diff.

- [ ] **Step 2: Run Rust and xtask suites**

  ```bash
  scripts/dev-shell.sh bash scripts/ci-run-test-suite.sh cargo-workspace
  scripts/dev-shell.sh bash scripts/ci-run-test-suite.sh cargo-xtask
  ```

- [ ] **Step 3: Run the complete active Vitest suite**

  ```bash
  scripts/dev-shell.sh bash scripts/ci-run-test-suite.sh vitest
  ```

- [ ] **Step 4: Run browser and conformance suites**

  ```bash
  scripts/dev-shell.sh bash scripts/ci-run-test-suite.sh browser
  scripts/dev-shell.sh bash scripts/ci-run-test-suite.sh libc
  scripts/dev-shell.sh bash scripts/ci-run-test-suite.sh posix
  scripts/dev-shell.sh bash scripts/ci-run-test-suite.sh sortix
  ```

- [ ] **Step 5: Validate ABI compatibility**

  Run `scripts/dev-shell.sh bash scripts/check-abi-version.sh`. Review semantic
  compatibility separately from structural snapshot equality. Expected: either
  ABI 43 remains compatible with an unchanged valid snapshot, or the branch
  contains the required version bump, regenerated snapshot, and rebuilt
  artifacts.

### Task 7: Manually Verify the Browser Product

**Files:**

- Exercise: default root browser route via `./run.sh browser`
- Exercise: one custom image using the same experimental terminal contract

**Interfaces:**

- Consumes: final built browser assets and package-backed VFS images.
- Produces: user-visible evidence that the default and custom-image flows use
  the same guest-owned terminal/session and set-ID model.

- [ ] **Step 1: Launch the browser product through the supported command**

  Run `scripts/dev-shell.sh bash ./run.sh browser`, open the emitted local URL,
  and confirm cross-origin isolation and service-worker control.

- [ ] **Step 2: Exercise the default root login lifecycle**

  Confirm initial `maker` identity, `sudo-lite id`, `sudo id`, logout to a real
  `login:` prompt, one rejected password, and one successful maker login.

- [ ] **Step 3: Exercise custom-image parity and visible errors**

  Boot a custom image with a valid experimental terminal document, then a
  malformed document. Confirm the valid image launches its declared program
  without content recognition and the malformed image fails visibly.

### Task 8: Prepare and Deliver the Pull Request

**Files:**

- Update: authoritative docs already touched by the implementation
- Create/update: commit history and existing pull request metadata

**Interfaces:**

- Consumes: a clean, fully verified worktree and current `origin/main`.
- Produces: a linear, attribution-preserving branch pushed to the existing pull
  request targeting `main`, ready for rebase merge.

- [ ] **Step 1: Review documentation and the final diff**

  Run both diff checks, inspect all staged and unstaged changes, ensure
  generated/built outputs are excluded, and report any suites not run.

- [ ] **Step 2: Preserve authorship while committing the completed change**

  Inspect `git log --format=fuller` before rewriting history. Use purpose-led
  `Area: Purpose` subjects and retain original authors or co-author trailers for
  materially combined work.

- [ ] **Step 3: Rebase onto current `origin/main`**

  Fetch, record the pre-rebase range, rebase only after the worktree is clean,
  resolve conflicts by preserving both upstream contracts and this design, and
  rerun validation affected by conflict resolution.

- [ ] **Step 4: Verify range and attribution**

  Run `git range-diff` between pre- and post-rebase ranges and
  `git log --format=fuller origin/main..HEAD`. Expected: no unintended patch
  loss and contributor authorship preserved.

- [ ] **Step 5: Update and push the existing pull request**

  Write a 72-column-wrapped description beginning with `## Why`, followed by
  `## What changed` and exact `## Validation`. Confirm the base is `main`, then
  force-push with lease as required by the approved delivery contract.
