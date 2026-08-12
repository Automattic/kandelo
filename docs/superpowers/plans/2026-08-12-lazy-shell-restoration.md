# Bottle-Backed Lazy Shell Restoration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` to execute these tasks in order.

**Goal:** Restore, publish, and deploy the lightweight bottle-backed shell and
make browser Node npm installation work again.

**Architecture:** Reuse the completed flat-selection adapter and Kandelo's
existing lazy VFS runtime. Change the canonical shell recipe, rebuild its
affected package closure, complete the proxy boundary, and use the existing
release workflows unless a real run exposes a compatibility defect.

**Tech Stack:** TypeScript, Bash, MemoryFileSystem VFS v3, package resolver,
GitHub Actions, Playwright.

## Global Constraints

- `homebrew/main-shell-flat-selection.json` is the sole bottle authority.
- Preserve the exact 3 embedded / 1 bootstrap / 37 deferred partition.
- Keep the bootstrap ZIP, libyaml, and Ruby as one sealed boot cohort.
- Keep 35 ordinary bottle trees lazy.
- Keep ABI 42 and `abi/snapshot.json` unchanged.
- Use `scripts/dev-shell.sh` for build and validation evidence.
- Preserve unrelated worktree changes and prioritize this PR over PR #1247.

## Task 1: Finish the canonical shell package

- Add the small hermetic CLI that invokes `composeHomebrewFlatLazyVfs()` with
  the selected bottles, policies, platform base, bootstrap companion, configs,
  and mirror output.
- Change `packages/registry/shell` from the eager flat builder to that CLI.
- Restore `homebrew-bootstrap` as a direct dependency and align its selected
  source/output identity only as required by the active selection.
- Bump changed revisions and enforce compressed shell size `< 10485760` bytes.
- Build the bootstrap and shell through the package resolver and inspect the
  exact lazy counts and boot transition.

## Task 2: Rebuild the affected image closure

- Make `shell-vfs-build.ts` preserve `homebrewFlatLazy`, pending transports,
  bootstrap binding, seals, capacity, and mirror identity without fetching.
- Bump and rebuild Node plus only reverse-dependent VFS packages whose bytes or
  package-index closure must change.
- Verify each derived image retains 35 ordinary pending trees after boot.

## Task 3: Complete the browser proxy boundary

- Finish service-worker/Vite wiring for the shared configured proxy.
- Add real browser coverage for the allowed-header preflight profile and npm
  registry traffic.
- Verify `npm install --verbose cowsay` locally in the production browser
  build, with no Homebrew bottle fetch caused by npm.

## Task 4: Publish through the existing release path

- Push a focused PR and let staging build the exact changed package closure.
- Fix only failures that block the existing mirror, candidate, activation, or
  Pages contracts.
- Merge after required checks, publish/read back the immutable lazy assets,
  activate the package generation, and dispatch Pages.

## Task 5: Verify the live product

- Confirm the deployed shell is under 10 MiB and has the expected boot and
  pending lazy state.
- Run the GitHub Pages Node demo and confirm `npm install --verbose cowsay`
  succeeds without the `pacote-req-type` preflight error.
- Record exact workflow runs, package revisions, artifact digests/sizes, and
  anything not exercised.
