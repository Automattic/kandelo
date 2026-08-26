# Browser Service Lifecycle and Local Gallery Implementation Plan

> **For Codex:** Execute this plan in the current isolated worktree with
> `superpowers:executing-plans`. Use test-driven development for every behavior
> change and `superpowers:verification-before-completion` before the PR.

**Goal:** Keep dinit-managed browser services alive under concurrent kernel
activity, report service-start failures truthfully, and stop the demo app from
requesting third-party software gallery manifests.

**Architecture:** Async process-launch continuations in both hosts will retry
only the kernel entry gate's explicit temporary-contention error. Browser boot
progress will come only from the init process's existing output and the real
port, service, and HTTP readiness checks. A small pure status tracker will
distinguish successful and failed dinit services. The app will expose only
repository-defined gallery items and will not turn query parameters or
environment variables into remote manifest requests.

**Tech Stack:** TypeScript, React/Vite, BrowserKernel, dinit, Playwright.

---

## Task 1: Make dinit output authoritative

**Files:**

- Create:
  `apps/browser-demos/pages/kandelo/kernel-host/dinit-boot-status.ts`
- Create: `apps/browser-demos/test/dinit-boot-status.spec.ts`
- Modify: `apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts`

1. Add focused Playwright tests for complete and split dinit output. Assert
   that `[ OK ] php-fpm` records a successful service, while
   `[FAILED] php-fpm` records a failure and never satisfies readiness.
2. Run the focused test and confirm it fails before the tracker module exists.
3. Move the dinit output parsing and tracking into the pure module. Represent
   completion as an explicit `succeeded` or `failed` result and preserve the
   existing `Starting <service>...` progress message.
4. Integrate the tracker with `live-setup.ts`. A failed required service must
   place the boot and web preview into an error state instead of being counted
   as ready.
5. Run the focused test and confirm it passes.

## Task 2: Preserve process launches across temporary kernel contention

**Files:**

- Create: `host/src/kernel-entry-retry.ts`
- Create: `host/test/kernel-entry-retry.test.ts`
- Modify: `host/src/browser-kernel-worker-entry.ts`
- Modify: `host/src/node-kernel-worker-entry.ts`
- Modify: `apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts`
- Modify: `apps/browser-demos/test/kandelo-merge-gate.spec.ts`

1. Extend the WordPress and MariaDB browser test to make repeated PHP-backed
   readiness and WordPress requests after the first successful page, and to
   assert that the machine remains in its running state.
2. Reproduce the failure while observing process state. Confirm that an async
   fork or clone continuation receives `KernelReentrantEntryError` while an
   unrelated result-bearing kernel query temporarily owns the entry gate.
3. Add a focused unit test for retrying only that explicit contention error.
4. Add the shared retry helper and use it for asynchronous fork, `vfork`,
   `posix_spawn`, `exec`, and pthread `clone` launch continuations in both
   hosts. Ordinary lifecycle failures must still propagate immediately.
5. Delete the browser-side `dinitctl list` polling loop. It is diagnostic work,
   not authoritative readiness state, and unnecessarily creates competing
   guest processes during service startup.
6. Run the focused WordPress and MariaDB browser test once, then repeatedly to
   exercise the former timing window.

## Task 3: Keep the demo gallery local

**Files:**

- Modify: `apps/browser-demos/test/kandelo-gallery.spec.ts`
- Modify: `apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts`
- Modify: `docs/package-sources.md`
- Modify: `docs/package-management.md`
- Modify: `docs/porting-guide.md`
- Modify: `docs-site/guide/current-ui.md`
- Modify: `docs-site/guide/publish-software.md`
- Modify: `docs-site/reference/troubleshooting.md`

1. Change the gallery test to configure a third-party manifest URL and assert
   that it is not requested or added to the visible gallery, while built-in
   entries remain available.
2. Run the focused test and confirm it fails because the current app requests
   and loads the configured manifest.
3. Remove the background gallery refresh and the now-unreachable third-party
   manifest, index, profile, and archive-loading code. Preserve the local
   `PRESET_LIBRARY` gallery.
4. Update the package-source documentation so it no longer promises runtime
   manifest loading and directs external images to explicit VFS links.
5. Update the published docs site so its current-UI, publishing, stability,
   and troubleshooting pages describe the same local-gallery contract.
6. Run the focused gallery test and TypeScript/Vite build.

## Task 4: Verify and publish one PR

**Files:**

- Review all changed files and this plan.

1. Run `git diff --check` and the focused dinit tracker test through
   `scripts/dev-shell.sh`.
2. Run the focused gallery test through `scripts/dev-shell.sh`.
3. Run the WordPress and MariaDB browser end-to-end test repeatedly against
   the real LAMP virtual file-system image.
4. Run the relevant broader browser build and tests selected by the repository
   validation guide. Record any suite not run.
5. Regenerate and check `packages/registry/program-packages.json`, because
   `host/src` participates in the PHP/WordPress image cache identities. Add
   new Vitest files to `scripts/ci-vitest-evidence-classes.tsv` and verify that
   the inventory exactly covers the live test files.
6. Review the diff for accidental inclusion of the pre-existing musl submodule
   and `.serena` changes, then commit with purpose-led `Browser:` subjects.
7. Push the branch and open one PR with a junior-readable title and a wrapped
   description whose `## Why` section comes first.
