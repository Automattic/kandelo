# Rootfs Artifact Setup Gate Plan

Date: 2026-06-30

Bead: `kd-1mr.3`

## Problem Statement

The `kd-bry6` Homebrew package wave completed its package-specific work, but
the full host Vitest gate did not finish cleanly because the managed worktree
did not have a usable root filesystem image. `cd host && npx vitest run`
reported 22 failed test files and 96 failed tests; 89 of those failures reported
that `rootfsImage:"default"` was requested but no `rootfs.vfs` artifact was
available.

The preserved evidence shows two separate setup failures:

- `scripts/build-programs.sh` successfully produced host test fixtures, but
  `ROOTFS_SKIP_PACKAGE_RESOLVE=1 scripts/build-rootfs.sh` failed while
  generating `target/rootfs-packages.MANIFEST` because
  `programs/wasm32/coreutils.wasm` was absent from both `local-binaries/` and
  `binaries/`.
- A broad `scripts/fetch-binaries.sh` recovery attempt was stopped after
  repeated release archive `cache_key_sha` mismatches caused source-build
  fallback for packages outside the immediate rootfs setup decision. The log
  reached `bash`, `bc`, `bzip2`, and `coreutils`, with 10 cache-key mismatch
  warnings, then stopped while `coreutils` source configuration was underway.

The problem is therefore not a host-runtime semantic failure. It is a missing
precondition for host and browser runtime tests: a worktree-local, current
`rootfs.vfs` plus the package Wasm outputs that the rootfs image maps into
`/usr/bin`, `/bin`, and support paths.

## Non-Goals

- Do not mask missing rootfs artifacts by skipping host tests or passing empty
  rootfs bytes.
- Do not make host Vitest silently source-build every registry package as a side
  effect of needing a rootfs.
- Do not bypass the package resolver, cache-key checks, ABI checks, SDK, or VFS
  image builder.
- Do not hand-edit release `index.toml` files or bump package revisions just to
  clear stale local state.
- Do not use the Homebrew tap fixture as the live production tap. The live tap
  target remains `Automattic/kandelo-homebrew`; the main repo owns schemas,
  validators, workflow generation, fixtures, and reviewable source changes.
- Do not implement a browser-only or Node-only rootfs path. `rootfs.vfs` is a
  shared product artifact used by both host surfaces.

## Users And Operator Workflows

Primary users:

- Package porters need a reliable way to prepare the artifacts required by full
  host Vitest after a package wave changes formulae, package scripts, SDK
  inputs, or package metadata.
- Test auditors need durable pass/fail/skip outcome lists that distinguish
  missing rootfs inputs from host-runtime test regressions.
- CI maintainers need a gate that materializes the rootfs package set without
  broad source-build fallback across unrelated registry packages.
- Browser maintainers need the same canonical `host/wasm/rootfs.vfs` asset that
  Vite and browser demos import through `@rootfs-vfs`.

Recommended operator workflow:

1. Enter the bead worktree and run worktree preflight.
2. Build or materialize the kernel and host test fixtures.
3. Run a targeted rootfs materialization step that reads
   `images/rootfs/PACKAGES.toml`, resolves only those packages for `wasm32`, and
   records per-package outcomes.
4. Build `host/wasm/rootfs.vfs` from `MANIFEST`, `images/rootfs/`, and the
   generated package manifest.
5. Run `cd host && npx vitest run`.
6. Publish host-gate passed, failed, and skipped outcome lists. If the rootfs
   materialization fails first, publish rootfs-materialization outcome lists and
   do not claim host Vitest coverage.

## Current Architecture And Data Flow

The rootfs path has three distinct contracts:

```text
packages/registry/<name>/
  -> package resolver
  -> local-binaries/ or binaries/
  -> images/rootfs/PACKAGES.toml
  -> scripts/generate-rootfs-package-manifest.mjs
  -> tools/mkrootfs
  -> host/wasm/rootfs.vfs
  -> NodeKernelHost rootfsImage:"default"
  -> BrowserKernelHost @rootfs-vfs import
```

`images/rootfs/PACKAGES.toml` names the package outputs that must be visible in
the rootfs. Most entries are lazy files: the VFS image contains executable
metadata and lazy URLs, while the actual Wasm bytes live under
`binaries/programs/wasm32/...` or `local-binaries/programs/wasm32/...`.

`scripts/generate-rootfs-package-manifest.mjs` is the strict check before image
creation. For every output in `images/rootfs/PACKAGES.toml`, it first looks in
`local-binaries/` and then in `binaries/`; if an output is absent, image
generation fails. This is the right failure mode, but `kd-bry6` skipped the
package resolve step and therefore reached that check without required package
outputs.

`scripts/build-rootfs.sh` can resolve rootfs packages itself when
`ROOTFS_SKIP_PACKAGE_RESOLVE` is not set. It extracts package names from
`images/rootfs/PACKAGES.toml` and runs:

```bash
cargo run --release -p xtask --target "$HOST_TARGET" -- \
  build-deps --arch wasm32 --binaries-dir "$REPO_ROOT/binaries" resolve "$pkg"
```

That is the right scope. The missing capability is an auditable gate mode:
operators need fetch-only versus source-build behavior to be explicit, failures
classified, and outcome lists recorded.

`NodeKernelHost.resolveRootfsArtifact()` checks the canonical artifact locations
in this order:

1. `resolveBinary("rootfs.vfs")`
2. `resolveBinary("programs/rootfs.vfs")`

That covers `local-binaries/rootfs.vfs`, `binaries/rootfs.vfs`,
`host/wasm/rootfs.vfs`, and the package-output form under
`programs/wasm32/rootfs.vfs`. Browser tests and demos import the canonical
`host/wasm/rootfs.vfs` asset. A correct gate should leave
`host/wasm/rootfs.vfs` present and, when package-building `rootfs`, may also
install `local-binaries/rootfs.vfs`.

## Design

Add a targeted rootfs artifact setup gate. It should be usable from CI and from
managed Gas City worktrees, and it should make the package materialization
state visible before any host Vitest result is interpreted.

### Rootfs Materialization Scope

The scope is exactly the package set in `images/rootfs/PACKAGES.toml`:

- `dash`
- `bash`
- `ncurses`
- `coreutils`
- `gawk`
- `grep`
- `sed`
- `bc`
- `file`
- `m4`
- `make`
- `findutils`
- `diffutils`
- `posix-utils-lite`

This list must be discovered from `images/rootfs/PACKAGES.toml` by shared code
or by a parser owned by the rootfs scripts. Do not duplicate it in CI YAML or
agent runbooks.

### Gate Shape

Introduce one explicit script or mode, for example:

```bash
bash scripts/prepare-rootfs-artifacts.sh \
  --arch wasm32 \
  --mode fetch-only \
  --outcome-dir test-runs/<bead>/rootfs-materialization/outcome-lists
```

The exact filename is less important than the contract:

- Read `images/rootfs/PACKAGES.toml`.
- Resolve only the packages used by the rootfs image.
- Support `fetch-only` mode for CI and trusted-publication validation.
- Support explicit `allow-source-build` mode for local development branches
  where matching durable or PR-staged archives do not exist yet.
- Never source-build as an implicit consequence of fetch-only mode.
- Record one row per package/arch with status, artifact source, and failure
  reason.
- Run `scripts/generate-rootfs-package-manifest.mjs` as the final input check.
- Leave `host/wasm/rootfs.vfs` to `scripts/build-rootfs.sh`; do not construct an
  alternate image path.

The existing `scripts/build-rootfs.sh` should either call this helper or expose
equivalent environment-controlled behavior:

- `ROOTFS_FETCH_ONLY=1` passes `--fetch-only` to resolver calls.
- `ROOTFS_OUTCOME_DIR=<dir>` writes durable materialization outcomes.
- `ROOTFS_SKIP_PACKAGE_RESOLVE=1` remains valid only when a preceding resolver
  step has already proved every package output required by
  `images/rootfs/PACKAGES.toml` is present.

### Outcome Lists

Rootfs materialization should publish:

- `passed-tests.tsv`: package/arch rows that fetched or source-built and whose
  required outputs were found.
- `failed-tests.tsv`: package/arch rows that could not be resolved or whose
  declared rootfs outputs remained missing.
- `skipped-tests.tsv`: rows skipped by explicit policy, with reasons. A host
  Vitest rootfs gate should normally have zero skipped rootfs packages; any
  skip is a blocker for a full host-gate claim.

Columns should include:

```text
suite    test    status    package    arch    source    details    log
```

`source` should be one of `local`, `durable-release`, `pr-staging`,
`source-build`, or `missing`. If this cannot be known cheaply from resolver
output on the first pass, record `resolved` versus `failed` now and create a
follow-up to expose precise source classification from `xtask`.

The host Vitest gate should publish its own outcome lists separately. If rootfs
materialization fails, host Vitest should be marked not-run or blocked by
missing prerequisites rather than failed as if 89 runtime tests had regressed.

### Resolver And Homebrew Interaction

The current rootfs image is still built from package resolver artifacts. The
Homebrew migration is changing package publication, but the rootfs setup gate
should preserve the normal package-resolver contract until a Homebrew-backed
rootfs image flow is explicitly implemented and verified.

Short-term:

- Use resolver outputs for `images/rootfs/PACKAGES.toml`.
- Consume PR-staged or durable package archives in fetch-only mode when they
  match this checkout's cache keys.
- If a package wave changes package build inputs and no matching archive exists
  yet, use targeted source-build mode for only the rootfs package set, not broad
  `scripts/fetch-binaries.sh`.

Medium-term:

- Validate that `packages/registry/rootfs/package.toml` stays in sync with
  `images/rootfs/PACKAGES.toml`. The rootfs package uses resolver transitive
  deps when built as a package, while `build-rootfs.sh` uses
  `PACKAGES.toml` directly; drift would make direct image builds and package
  builds disagree.
- Before republishing the `rootfs` package, review its package metadata. Its
  source URL and zero sha are historical placeholders, and its `kernel_abi`
  field may not tell the full story for an image that embeds current
  `--kernel-abi` metadata at build time.

Long-term:

- Decide whether `rootfs.vfs` should remain a resolver-built composite package,
  become a Homebrew-generated VFS image from bottle sidecars, or support both
  during migration. That decision should be made under the Homebrew-all convoy,
  not hidden inside a host Vitest repair.

## Alternatives Considered

1. Run broad `scripts/fetch-binaries.sh` before every host gate.

   This matches part of the current CI shape, but it is too broad for a local
   rootfs repair. `kd-bry6` showed that release cache-key drift can force
   source-build fallback for unrelated packages. A rootfs gate should resolve
   only rootfs packages and should make fallback mode explicit.

2. Always run `ROOTFS_SKIP_PACKAGE_RESOLVE=1 scripts/build-rootfs.sh`.

   This is only safe when another step has already materialized every rootfs
   package output. In `kd-bry6`, it failed correctly at `coreutils.wasm` because
   that precondition was false.

3. Let host Vitest fail and classify missing rootfs failures afterward.

   This preserves the raw failure but produces noisy runtime results. It makes
   89 setup failures look like host regressions and wastes time for reviewers.

4. Commit a checked-in `host/wasm/rootfs.vfs`.

   This would make the checkout heavier and risks stale ABI/package state. The
   project already treats VFS images as generated artifacts resolved through the
   package/binary system.

5. Build the rootfs entirely from Homebrew bottle sidecars now.

   This is directionally plausible, but the current rootfs image contract and
   host tests still consume resolver paths. A Homebrew-rootfs design needs its
   own evidence, sidecar validation, Node/browser smoke, and publication story.

## Risks And Mitigations

- Risk: fetch-only mode fails often on active package branches because durable
  archives do not match local cache keys.
  Mitigation: make the mode explicit. CI should use fetch-only against durable
  or PR-staged archives; local package branches can choose targeted source-build
  mode and record that source-built artifacts were used.

- Risk: targeted source-build mode hides a broken release index.
  Mitigation: treat fetch-only failure as its own durable result. Do not claim
  durable release materialization passed when source-build mode was used.

- Risk: `images/rootfs/PACKAGES.toml` and `packages/registry/rootfs/package.toml`
  drift.
  Mitigation: add a focused package-system test that compares the package names
  in `PACKAGES.toml` with rootfs package dependencies, allowing only documented
  exceptions.

- Risk: local overrides in `local-binaries/` make a gate pass with stale or
  unrelated bytes.
  Mitigation: log artifact source and, where feasible, sha256 for each package
  output used in the generated rootfs manifest.

- Risk: browser asset preparation diverges from host artifact preparation.
  Mitigation: keep `host/wasm/rootfs.vfs` as the canonical image output and run
  `scripts/ci-check-browser-assets.sh` or a browser smoke when browser asset
  wiring changes.

- Risk: rootfs package metadata promises more than the implementation supports.
  Mitigation: before publishing or Homebrew-porting `rootfs`, audit source
  provenance, ABI metadata, and dependency synchronization as part of the rootfs
  package change.

## Implementation Sequence

1. Preserve the `kd-bry6` baseline evidence on `kd-1mr.3`.
   - Record `host-vitest.log`, `host-vitest-failures.txt`,
     `fetch-binaries.log`, `build-programs-rootfs.log`, and
     `status.tsv`.
   - Record the known counts: 22 failed test files, 96 failed tests, 89 missing
     rootfs failures, and 10 cache-key mismatch warnings in the stopped broad
     fetch attempt.

2. Add a rootfs package-list helper.
   - Reuse or factor the parser from
     `scripts/generate-rootfs-package-manifest.mjs`.
   - Emit package names and output paths from `images/rootfs/PACKAGES.toml`.
   - Add unit coverage for multiline arrays and multi-output packages such as
     `ncurses`, `diffutils`, and `posix-utils-lite`.

3. Add the targeted rootfs materialization gate.
   - Resolve only rootfs packages for `wasm32`.
   - Support fetch-only and explicit source-build modes.
   - Write passed, failed, and skipped outcome lists.
   - Run the manifest generator as the final input check.

4. Wire `scripts/build-rootfs.sh`.
   - Either delegate package resolution to the new helper or honor
     `ROOTFS_FETCH_ONLY` and `ROOTFS_OUTCOME_DIR` directly.
   - Keep `ROOTFS_SKIP_PACKAGE_RESOLVE=1` for package-build contexts where
     resolver transitive deps have already been prepared.

5. Add drift checks for the `rootfs` package.
   - Compare `packages/registry/rootfs/package.toml.depends_on` package names
     to `images/rootfs/PACKAGES.toml` package names.
   - Fail clearly if a rootfs package output references a package that the
     rootfs package dependency graph will not resolve.

6. Reproduce the focused gate in the `kd-1mr.3` worktree.
   - Build kernel and host test fixtures through `scripts/dev-shell.sh`.
   - Run rootfs materialization in fetch-only mode. If it fails due expected
     branch cache-key drift, record that result and rerun in explicit targeted
     source-build mode.
   - Run `bash scripts/build-rootfs.sh`.
   - Confirm `host/wasm/rootfs.vfs` exists and can be resolved by
     `NodeKernelHost`.

7. Rerun host Vitest.
   - Run `cd host && npx vitest run`.
   - Publish host-gate outcome lists with pass/fail/skip counts and the complete
     failure list.
   - If failures remain after rootfs is present, classify them separately from
     rootfs setup.

8. Decide the Homebrew rootfs follow-up.
   - If package waves need `rootfs` as a Homebrew artifact, create a focused
     bead for the composite rootfs/Homebrew VFS decision.
   - Do not block `kd-1mr.3` on that larger migration unless host Vitest cannot
     be restored through the current resolver contract.

## Test And Documentation Plan

Focused checks for the implementation:

- Parser/helper unit tests for `images/rootfs/PACKAGES.toml`.
- Package-system test for rootfs package dependency drift.
- `bash scripts/dev-shell.sh bash scripts/prepare-rootfs-artifacts.sh --mode fetch-only`
  with outcome lists.
- If fetch-only cannot pass on the active branch, explicit targeted
  source-build mode with outcome lists and a note that durable release
  materialization did not pass.
- `bash scripts/dev-shell.sh bash scripts/build-rootfs.sh`.
- `test -f host/wasm/rootfs.vfs`.
- `cd host && npx vitest run`, with passed, failed, and skipped outcome lists.

Broader checks:

- `bash scripts/ci-check-browser-assets.sh` if browser asset resolution or
  `@rootfs-vfs` wiring changes.
- `./run.sh browser` and browser verification only if browser-facing behavior
  or asset preparation changes.
- Full project gate commands are not required for a docs-only design. They are
  required once implementation changes build scripts, resolver behavior, package
  metadata, or host/browser asset preparation in a way that supports a merge
  claim.

Documentation:

- Update `docs/package-management.md` or `docs/binary-releases.md` if the
  rootfs materialization command becomes an official developer or CI workflow.
- Update `docs/browser-support.md` only if browser asset behavior changes.
- Keep this plan as the implementation handoff and record final evidence on the
  bead.

## Open Questions

- Should the rootfs gate default to fetch-only in local worktrees, or should
  local developer mode default to targeted source-build with fetch-only reserved
  for CI?
- Should `scripts/build-rootfs.sh` own outcome-list writing directly, or should
  a separate preparation script own materialization evidence before image
  creation?
- Should `rootfs.vfs` be republished as a normal resolver package after the
  Homebrew migration, or should it become a generated Homebrew VFS image from
  bottle sidecars?
- Is `packages/registry/rootfs/package.toml` still accurate enough for
  publication, given its historical source placeholder and old `kernel_abi`
  field?
- Which package waves should be responsible for rebuilding or staging rootfs
  dependencies when package build inputs change but the host gate needs a fresh
  rootfs immediately?

## Handoff Summary

The next worker should not retry broad `scripts/fetch-binaries.sh` as the first
move. Build a targeted rootfs materialization gate from
`images/rootfs/PACKAGES.toml`, record outcome lists, build
`host/wasm/rootfs.vfs`, then rerun host Vitest. If durable archives mismatch
the active branch, record fetch-only failure and use explicit targeted
source-build mode for only the rootfs package set.
