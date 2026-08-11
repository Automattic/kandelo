# Flat-Selection Lazy Shell Publication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the canonical ABI-42 shell as a sub-10-MiB lazy product derived solely from the active flat selection, rebuild every shell-derived image, and make immutable mirror publication, package activation, and GitHub Pages deployment work in the correct order.

**Architecture:** Adapt `HomebrewFlatVfsPlan` directly to the existing authenticated deferred-tree machinery instead of recreating retired campaign provenance. Derive a complete 3-embedded/1-bootstrap/37-deferred partition, publish the 37 original-bottle trees through the protected tap repository's immutable release lane, block activation until anonymous mirror readback succeeds, preserve lazy state in every derived image, and leave Pages as a verified consumer.

**Tech Stack:** TypeScript, MemoryFileSystem VFS v3 metadata, Vitest/Node test runner, Bash package recipes, GitHub Actions, Ruby workflow trust checks, Playwright Chromium/Firefox/WebKit.

## Global Constraints

- Follow the approved design in
  `docs/superpowers/specs/2026-08-11-flat-selection-lazy-shell-publication-design.md`.
- Treat `homebrew/main-shell-flat-selection.json` as the only bottle identity
  authority. Never revive the retired campaign, selection lock, migration
  lock, or lazy-artifact lock as current inputs.
- Do not fabricate tap commit, campaign, receipt, or catalog provenance that
  the flat selection does not authenticate.
- Derive partitions mechanically from the selection, dependency edges,
  materialization policy, and runtime roots. The current counts are evidence,
  not a second hand-maintained package list.
- Preserve immutable URL, digest, byte-count, source inventory, ownership,
  atomic-group, capacity, and ABI checks already enforced by the deferred-tree
  schema.
- Keep GitHub Pages a package consumer. Mirror publication remains in the
  protected Homebrew tap workflow whose token owns the mirror release.
- Mirror anonymous readback must precede package-index activation; activation
  must precede Pages dispatch.
- Keep ABI 42 and `abi/snapshot.json` unchanged.
- Run builds and verification through `scripts/dev-shell.sh`.
- Preserve unrelated worktree changes in `libc/musl`, `tests/sortix/os-test`,
  `.serena/`, and `apps/browser-demos/test-results/`.

---

## File Map and Authoritative Contracts

Create:

- `homebrew/main-shell-runtime-support-policy.json` — selection-relative
  bootstrap/runtime roots and activation policy with no bottle list or tap
  commit.
- `host/src/homebrew-flat-lazy-vfs-composer.ts` — exact flat selection lazy
  partition, original-tree registration, bootstrap cohort, and lineage report.
- `host/test/homebrew-flat-lazy-vfs-composer.test.ts` — partition and
  composition tests.
- `images/vfs/scripts/build-homebrew-flat-lazy-vfs-image.ts` — hermetic CLI
  producing the image, report, mirror bundle, and publication plan.
- `host/test/homebrew-flat-lazy-vfs-cli.test.ts` — CLI and cache input tests.
- `scripts/inspect-canonical-lazy-shell.ts` and
  `scripts/inspect-canonical-lazy-shell.test.ts` — release invariant inspector.
- `scripts/verify-public-homebrew-bottle-mirror.ts` and focused test — anonymous
  exact mirror readback for activation and rollout.

Modify:

- `host/src/homebrew-vfs-planner.ts`, `host/src/homebrew-lazy-layer.ts`,
  `host/src/homebrew-vfs-composer.ts`, and exports — add a truthful flat-plan
  entry point without campaign adapters.
- `host/src/homebrew-vfs-materialization-policy.ts` and tests — derive current
  embedded, bootstrap, runtime, and ordinary partitions.
- `images/vfs/scripts/shell-vfs-build.ts` and tests — preserve this exact lazy
  flat lineage in derived products.
- `packages/registry/shell/{build-shell.sh,build.toml,package.toml}` — use the
  new builder, restore the bootstrap dependency, enforce `<10 MiB`, revision
  24.
- `packages/registry/{node-vfs,lamp,wordpress,nginx-vfs,nginx-php-vfs}` — bump
  revisions to 16, 13, 14, 4, and 4 and retain the canonical lazy shell base.
- `scripts/recover-homebrew-bottle-mirror.ts`, mirror manifest/handoff scripts,
  and their tests — recover and seal from selection-backed lineage.
- `.github/workflows/reusable-homebrew-main-shell-mirror-publish.yml` — publish
  the candidate's exact immutable mirror from trusted tap context.
- `.github/workflows/activate-merge-candidate.yml` — verify anonymous mirror
  availability before index mutation.
- `.github/workflows/browser-demos-pages.yml` — verify and consume canonical
  lazy products only after activation.
- `.github/workflows/homebrew-main-shell-ci.yml` — retire stale campaign
  behavior while preserving the required-check display contract.
- `scripts/check-homebrew-publish-workflow-trust.rb`,
  `scripts/check-homebrew-main-shell-mirror-workflow.rb`,
  `scripts/test-homebrew-main-shell-mirror-workflow.sh`,
  `scripts/test-homebrew-main-shell-mirror-handoff.sh`,
  `scripts/test-pages-deployment-contract.sh`, and
  `tests/scripts/ci-run-test-suite-groups.test.sh` — enforce authority and
  ordering.
- `run.sh`, browser demo fixtures/tests, `docs/package-management.md`,
  `docs/browser-support.md`, `docs/future-improvements.md` — resolve the
  canonical companion bootstrap, exercise lazy downloads, and document the
  unsupported old-image/persistence work.

Use a distinct metadata binding so eager `homebrewFlat` images and the restored
lazy product cannot be confused:

```ts
interface HomebrewFlatLazyImageBinding {
  schema: 1;
  kind: "kandelo-homebrew-flat-selection-lazy-v1";
  selection: {
    sha256: string;
    name: string;
    arch: "wasm32";
    kandeloAbi: number;
    requestedVfsFilename: "shell.vfs.zst";
    resourcePolicy: "kandelo-homebrew-vfs-main-shell-v1";
    linkPolicy: "kandelo-homebrew-link-ownership-v1";
    runtimeSupport: "kandelo-homebrew-bootstrap-v1";
  };
  materializationPolicySha256: string;
  runtimeSupportPolicySha256: string;
  mirror: {
    repository: string;
    tag: string;
    collectionSha256: string;
    planSha256: string;
    planBytes: number;
    assetCount: number;
  };
  partition: {
    embeddedPackageOrder: string[];
    deferredPackageOrder: string[];
    bootstrapPackage: string;
    runtimeCohortPackageOrder: string[];
  };
}
```

Store it as `metadata.homebrewFlatLazy`. Retain top-level
`packageDeferredTrees` and `homebrewBootstrap` because the runtime already uses
those authenticated bindings. Reject any image mixing `homebrewFlatLazy` with
eager `homebrewFlat`, retired `homebrew`, or source-rootfs lineage.

---

## Task 1: Define Selection-Relative Runtime and Partition Policy

**Files:**

- Create: `homebrew/main-shell-runtime-support-policy.json`
- Modify: `host/src/homebrew-vfs-materialization-policy.ts`
- Modify: `host/test/homebrew-vfs-materialization-policy.test.ts`
- Modify: `host/src/homebrew-runtime-support.ts`
- Modify: `host/test/homebrew-runtime-support.test.ts`
- Remove after consumers migrate:
  `homebrew/main-shell-homebrew-runtime-support.json`

- [ ] Write failing parser tests for this exact policy shape:

```json
{
  "schema": 1,
  "kind": "kandelo-homebrew-flat-runtime-support-policy",
  "id": "homebrew-runtime-support",
  "bootstrap_package": "kandelo-dev/tap-core/homebrew-bootstrap",
  "runtime_roots": ["kandelo-dev/tap-core/ruby"],
  "activation": {
    "mode": "boot-prefetch",
    "capability": "homebrew:runtime",
    "root": "/usr/bin/brew",
    "atomic_group": "homebrew-runtime-support"
  }
}
```

- [ ] Reject extra keys, duplicate roots, noncanonical full names, an absent
  bootstrap descriptor, a runtime root absent from the selection, unsupported
  activation values, and any campaign/tap/bottle identity fields.

- [ ] Add a failing `deriveFlatLazyCompositionPartition()` test using the real
  selection and materialization policy. Derive dependency closures and assert:

```ts
expect(partition.embeddedPackageOrder).toEqual([
  "kandelo-dev/tap-core/libcxx",
  "kandelo-dev/tap-core/ncurses",
  "kandelo-dev/tap-core/bash",
]);
expect(partition.bootstrapPackage).toBe(
  "kandelo-dev/tap-core/homebrew-bootstrap",
);
expect(partition.runtimeCohortPackageOrder).toEqual([
  "kandelo-dev/tap-core/libyaml",
  "kandelo-dev/tap-core/ruby",
]);
expect(partition.ordinaryDeferredPackageOrder).toHaveLength(35);
expect(partition.deferredPackageOrder).toHaveLength(37);
```

- [ ] Prove every one of the selection's 41 package identities belongs to
  exactly one semantic role; the embedded/bootstrap/deferred union is exact;
  runtime additions are the runtime-root closure minus the ordinary closure;
  and a shared dependency such as zlib is not duplicated.

- [ ] Derive that subtraction without a second package list: compute the Ruby
  runtime closure first; use all selected keg descriptors outside that closure
  as ordinary roots; take their dependency closure together with the embedded
  boot closure; then subtract that base from the runtime closure. For the
  current selection zlib re-enters through ordinary dependencies, while only
  libyaml and ruby remain runtime additions.

- [ ] Add mutation tests for an empty deferred set, reordered materialization
  closure, missing dependency edge, duplicated role, and stale runtime root.

- [ ] Run and observe the missing-parser/partition failures:

```bash
scripts/dev-shell.sh npx --prefix host vitest run --root host \
  test/homebrew-vfs-materialization-policy.test.ts \
  test/homebrew-runtime-support.test.ts
```

- [ ] Implement a deeply frozen selection-relative policy parser and partition
  derivation. The algorithm must use descriptor dependencies, not current
  package names except for policy roots.

- [ ] Delete the campaign-era runtime-support policy only after `rg` shows no
  active package, workflow, or builder consumer. Historical docs may mention
  its filename as retired evidence.

- [ ] Re-run focused tests and commit:

```bash
scripts/dev-shell.sh npx --prefix host vitest run --root host \
  test/homebrew-vfs-materialization-policy.test.ts \
  test/homebrew-runtime-support.test.ts \
  test/homebrew-bottle-selection.test.ts
git add homebrew/main-shell-runtime-support-policy.json \
  host/src/homebrew-vfs-materialization-policy.ts \
  host/src/homebrew-runtime-support.ts \
  host/test/homebrew-vfs-materialization-policy.test.ts \
  host/test/homebrew-runtime-support.test.ts
git add -u homebrew/main-shell-homebrew-runtime-support.json
git commit -m "Homebrew: Derive lazy shell partitions from selection"
```

---

## Task 2: Project Flat Bottles into Authenticated Deferred Trees

**Files:**

- Modify: `host/src/homebrew-lazy-layer.ts`
- Modify: `host/src/homebrew-vfs-composer.ts`
- Modify: `host/src/homebrew-vfs-planner.ts`
- Modify: `host/src/index.ts`
- Modify: `host/src/browser.ts`
- Modify: `host/test/homebrew-vfs-builder.test.ts`
- Modify: `host/test/homebrew-flat-vfs-builder.test.ts`

- [ ] Add a failing overload/entry-point test for
  `buildHomebrewFlatOriginalBottleCollection(plan, options)`. The loader must
  receive `HomebrewBottleDescriptor`, not fabricated
  `HomebrewVfsPackagePlan`, and the result must contain one tree per selected
  keg descriptor requested by the caller.

- [ ] Prove the flat collection performs a complete private eager pour for
  ownership/collision truth, then projects only descriptor-owned keg paths,
  selected links, opt links, and required ancestor directories. Bootstrap
  staged/support/consumer paths must never enter an original-bottle tree.

- [ ] Compare a fixture's flat deferred trees against its full
  `buildHomebrewVfsSelection()` report: package order, link ownership,
  relocated bytes, inventory digests, collisions, and source paths must agree.

- [ ] Add failing cases for a descriptor from another selection, missing
  bottle bytes, digest/size mismatch, ownership collision, unassigned eager
  path, and a zero-tree collection.

- [ ] Run focused tests and record the type/runtime failures:

```bash
scripts/dev-shell.sh npx --prefix host vitest run --root host \
  test/homebrew-vfs-builder.test.ts \
  test/homebrew-flat-vfs-builder.test.ts
```

- [ ] Generalize internal tree projection over a provenance-free package
  contract containing only full name, package/version/rebuild, arch, ABI,
  dependencies, source URL/digest/bytes, relocation, and link manifest facts.
  Keep the public old-plan entry point unchanged for historical callers.

- [ ] Implement the explicit flat entry point. Pass `selectionSha256` as its
  authority binding and reject old `selectionSource`, `catalogCheckout`, and
  `migrationLock` arguments on the flat path.

- [ ] Export only the new typed entry point and result types required by the
  composer.

- [ ] Re-run focused tests and commit:

```bash
scripts/dev-shell.sh npx --prefix host vitest run --root host \
  test/homebrew-vfs-builder.test.ts \
  test/homebrew-flat-vfs-builder.test.ts \
  test/homebrew-bottle-mirror-browser.test.ts
git add host/src/homebrew-lazy-layer.ts host/src/homebrew-vfs-composer.ts \
  host/src/homebrew-vfs-planner.ts host/src/index.ts host/src/browser.ts \
  host/test/homebrew-vfs-builder.test.ts \
  host/test/homebrew-flat-vfs-builder.test.ts
git commit -m "Homebrew: Project flat selections into lazy trees"
```

---

## Task 3: Compose the Lazy Flat Shell and Bind Its Lineage

**Files:**

- Create: `host/src/homebrew-flat-lazy-vfs-composer.ts`
- Create: `host/test/homebrew-flat-lazy-vfs-composer.test.ts`
- Modify: `host/src/index.ts`
- Modify: `host/src/browser.ts`
- Modify: `host/src/vfs/memory-fs.ts` only if the metadata type requires the
  new `homebrewFlatLazy` property
- Modify: `host/test/homebrew-vfs-image-save.test.ts`

- [ ] Write a failing happy-path test using the real policy algorithms and a
  compact synthetic 41-role-equivalent fixture. Require:
  - all selected bottles are authenticated and included in the private eager
    ownership proof;
  - libcxx/ncurses/bash are eager in the output;
  - the bootstrap keg itself is absent;
  - 37 original-bottle trees have mirror transports;
  - the bootstrap ZIP plus libyaml/ruby share one sealed atomic activation
    group;
  - all other 35 trees activate independently;
  - `/bin/bash`, `/usr/bin/bash`, `/bin/sh`, and `/usr/bin/sh` resolve without
    fetching; and
  - `/usr/bin/brew` is bound to the bootstrap activation capability.

- [ ] Add a failing metadata assertion for exact
  `homebrewFlatLazy`, `packageDeferredTrees`, `homebrewBootstrap`, shell config,
  demo config, capacity, base-image identity, and ABI. Reject eager
  `homebrewFlat`, retired `homebrew`, or invented catalog fields.

- [ ] Add failing tests for changed selection digest, wrong ABI, incomplete or
  overlapping partition, empty mirror, missing/extra payload, mutable URL,
  payload digest/size mismatch, wrong bootstrap support output, unsealed atomic
  group, and a non-embedded Bash dependency.

- [ ] Add round-trip tests through `MemoryFileSystem.toImage()` and
  `fromImagePreservingCapacity()`. Require the same pending tree IDs, mirror
  transports, atomic group, package binding, source inventory, and metadata
  after import and `verifyImportedLazyAtomicGroupSeals()`.

- [ ] Run the new focused tests and confirm they fail for the missing composer:

```bash
scripts/dev-shell.sh npx --prefix host vitest run --root host \
  test/homebrew-flat-lazy-vfs-composer.test.ts \
  test/homebrew-vfs-image-save.test.ts
```

- [ ] Implement `composeHomebrewFlatLazyVfs()` with explicit inputs for the
  flat plan, materialization/runtime policies and bytes, base/output/scratch
  filesystems, exact bottle loader, bootstrap ZIP/environment bytes, mirror
  repository, shell/demo configuration, and deterministic timestamp.

- [ ] First call `buildHomebrewVfsSelection()` in a private scratch filesystem
  to retain the flat builder's full ownership and relocation proof. Partition
  only after that proof succeeds.

- [ ] Build original trees for every non-embedded keg descriptor, then remove
  the bootstrap descriptor from guest-keg registration. Materialize the three
  embedded bottle trees into the output and register the remaining 37 with the
  content-derived mirror plan.

- [ ] Use `prepareHomebrewRuntimeSupport()` for the selected bootstrap support
  outputs. Verify the provided ZIP and env against the descriptor's exact
  `supportOutputs` name, path, byte count, and digest before registering the
  bootstrap package tree.

- [ ] Register bootstrap ZIP, libyaml, and ruby as one
  `homebrew-runtime-support` atomic group, install consumer state through the
  existing bootstrap helper, then seal it. Do not duplicate zlib: it remains
  the one ordinary selected tree shared by runtime dependencies.

- [ ] Apply the flat selection's link ownership and profile once, install the
  shell/demo configurations, populate the conventional shell layout, and
  serialize only after partition, lazy-usage, closure, and seal checks pass.

- [ ] Produce a deterministic report containing selection/policy digests,
  partition identities, eager ownership evidence, mirror plan identity,
  bootstrap support identities, runtime cohort, lazy resource usage, and image
  identity. Do not include retired campaign fields.

- [ ] Re-run focused tests and commit:

```bash
scripts/dev-shell.sh npx --prefix host vitest run --root host \
  test/homebrew-flat-lazy-vfs-composer.test.ts \
  test/homebrew-vfs-image-save.test.ts \
  test/homebrew-runtime-support-materializer.test.ts \
  test/homebrew-bottle-mirror-browser.test.ts
git add host/src/homebrew-flat-lazy-vfs-composer.ts \
  host/src/index.ts host/src/browser.ts host/src/vfs/memory-fs.ts \
  host/test/homebrew-flat-lazy-vfs-composer.test.ts \
  host/test/homebrew-vfs-image-save.test.ts
git commit -m "Homebrew: Compose the flat selection as a lazy shell"
```

---

## Task 4: Build the Canonical Shell Package and Bootstrap Companion

**Files:**

- Create: `images/vfs/scripts/build-homebrew-flat-lazy-vfs-image.ts`
- Create: `host/test/homebrew-flat-lazy-vfs-cli.test.ts`
- Modify: `packages/registry/shell/build-shell.sh`
- Modify: `packages/registry/shell/prepare-build-tools.sh`
- Modify: `packages/registry/shell/build.toml`
- Modify: `packages/registry/shell/package.toml`
- Modify: `packages/registry/homebrew-bootstrap/package.toml`
- Modify: `packages/registry/homebrew-bootstrap/build.toml`
- Modify: `homebrew/homebrew-bootstrap-source-lock.json`
- Modify: bootstrap source-lock tests referenced by
  `packages/registry/homebrew-bootstrap/build.toml`

- [ ] Add failing CLI argument tests for these exact required inputs:

```text
--selection
--materialization-policy
--runtime-support-policy
--base-image
--bootstrap-zip
--bootstrap-env
--bottle-cache
--mirror-repository
--mirror-out
--shell-config
--demo-config
--out
--report
```

- [ ] Reject duplicate flags, colliding output paths, symlinks/non-regular
  inputs, oversized selection/policy/bootstrap/image files, an unsealed bottle
  cache, and any bottle cache object not named by its selected digest.

- [ ] Add a CLI integration fixture proving deterministic image, report,
  mirror plan, and 37 payload names across two builds with the same inputs.
  Require private build workspaces and atomic output publication on success;
  no partial output may survive failure.

- [ ] Add a package test that resolves the selected `homebrew-bootstrap`
  companion and compares `homebrew-bootstrap.zip` and `homebrew-brew.env`
  against the selected descriptor's support-output digests and sizes:

```text
homebrew-bootstrap.zip  5251369 bytes
sha256 26ac98e328573244d3e7c0c149f30114ef5d9c8882200f5a22e56f97d2541482

homebrew-brew.env       210 bytes
sha256 2eb3f05703b6a6f23feabda24f622bacd068115c7f74a0eac51bb4085e9eec5a
```

- [ ] Run CLI, package schema, and bootstrap source-lock tests and confirm the
  old eager recipe/stale companion fail the new contract:

```bash
scripts/dev-shell.sh npx --prefix host vitest run --root host \
  test/homebrew-flat-lazy-vfs-cli.test.ts
scripts/dev-shell.sh bash scripts/test-homebrew-bootstrap-source.sh
scripts/dev-shell.sh npx --prefix host vitest run --root . \
  tests/package-system
```

- [ ] Implement the hermetic CLI by reusing bounded no-follow reads, exact
  digest-addressed bottle caching, resource-policy limits, and atomic staging
  from `build-homebrew-flat-vfs-image.ts`. Keep the eager builder available for
  noncanonical diagnostics, but remove it from the shell package inputs.

- [ ] Align the `homebrew-bootstrap` package with the selection's upstream
  guest Homebrew commit
  `cf5bc21c6b127e168ef7cfa982ba7db62874690e`. Update its locked source archive,
  version to `6.0.12-153-gcf5bc21`, kernel ABI to 42, and build revision from 5
  to 6. Generate and verify the new source/archive hashes through the existing
  source-lock tooling; the output comparison above is the acceptance gate.

- [ ] Restore `homebrew-bootstrap` as a direct shell package dependency. The
  shell recipe must resolve it only through `WASM_POSIX_DEP_HOMEBREW_BOOTSTRAP_DIR`
  and must reject missing, extra, symlinked, or digest-mismatched outputs.

- [ ] Replace the eager CLI invocation in `build-shell.sh` with the lazy CLI.
  Emit `shell.vfs.zst`, the composition report, and sealed mirror handoff from
  one resolver-owned workspace. Do not download from or publish to the mirror
  during the package build.

- [ ] Enforce a strict compressed artifact invariant after creation:

```bash
if [ "$(wc -c < "$VFS")" -ge 10485760 ]; then
  echo "ERROR: canonical lazy shell must be smaller than 10 MiB" >&2
  exit 1
fi
```

- [ ] Update `build.toml` inputs to the new policy, composer, CLI, and
  bootstrap dependency. Advance shell revision 23 to 24 and keep
  `publication_state = "ready"` only because this build now produces every
  sealed artifact required by the candidate.

- [ ] Run focused tests, then build bootstrap and shell from the package
  resolver with a fresh cache. Record image bytes and digest; require `<10 MiB`
  and a nonempty deferred registry.

```bash
scripts/dev-shell.sh npx --prefix host vitest run --root host \
  test/homebrew-flat-lazy-vfs-cli.test.ts \
  test/homebrew-flat-lazy-vfs-composer.test.ts
scripts/dev-shell.sh npx --prefix host vitest run --root . \
  tests/package-system
KANDELO_LAZY_PLAN_BINARIES="$(mktemp -d)"
export KANDELO_LAZY_PLAN_BINARIES
scripts/dev-shell.sh cargo run -p xtask -- build-deps \
  --arch wasm32 --binaries-dir "$KANDELO_LAZY_PLAN_BINARIES" \
  --force-source-build resolve homebrew-bootstrap
scripts/dev-shell.sh cargo run -p xtask -- build-deps \
  --arch wasm32 --binaries-dir "$KANDELO_LAZY_PLAN_BINARIES" \
  --force-source-build resolve shell
```

- [ ] Commit this task:

```bash
git add images/vfs/scripts/build-homebrew-flat-lazy-vfs-image.ts \
  host/test/homebrew-flat-lazy-vfs-cli.test.ts \
  packages/registry/shell packages/registry/homebrew-bootstrap \
  homebrew/homebrew-bootstrap-source-lock.json
git commit -m "Packages: Restore the lightweight lazy shell product"
```

---

## Task 5: Preserve Lazy State in Every Shell-Derived Product

**Files:**

- Modify: `images/vfs/scripts/shell-vfs-build.ts`
- Modify: `host/test/shell-vfs-build.test.ts`
- Modify: `host/test/dinit-image-helpers.test.ts`
- Modify: `packages/registry/node-vfs/build.toml`
- Modify: `packages/registry/lamp/build.toml`
- Modify: `packages/registry/wordpress/build.toml`
- Modify: `packages/registry/nginx-vfs/build.toml`
- Modify: `packages/registry/nginx-php-vfs/build.toml`
- Modify: package-owned builder tests when they assert exact base metadata

- [ ] Add a failing `shell-vfs-build` fixture for a valid
  `homebrewFlatLazy` image with nonempty pending trees. Load it and save one
  derived image without installing a package; compare before/after:
  - pending deferred file and archive entries;
  - tree transports, digests, sizes, inventories, and package identities;
  - atomic-group membership and seals;
  - `packageDeferredTrees` and `homebrewBootstrap`;
  - `homebrewFlatLazy` selection/policy/mirror/partition binding;
  - capacity and ABI; and
  - direct base image digest and bytes.

- [ ] Add a fetch spy and prove load/save never materializes a tree or invokes
  a lazy fetcher. Add rejection cases for mixed eager/lazy-flat lineage,
  missing mirror binding, changed selection digest, empty pending state,
  invalid bootstrap ownership, and a requested ABI override.

- [ ] Extend service-image fixtures to prove replacing only the product's demo
  metadata and eager program files does not change inherited shell lazy state.

- [ ] Run focused tests and observe the current eager/legacy branch rejection:

```bash
scripts/dev-shell.sh npx --prefix host vitest run --root host \
  test/shell-vfs-build.test.ts \
  test/dinit-image-helpers.test.ts
```

- [ ] Add an exact lazy-flat branch to `shellDerivedImageMetadata()`. Copy only
  validated fields and freshly verify the guest shell/demo files and imported
  atomic seals. Keep source-rootfs, eager-flat, and retired lazy branches
  mutually exclusive.

- [ ] Update comments that currently claim the canonical flat shell is eager.
  The helper must describe transport preservation, not infer it from a product
  name.

- [ ] Advance every reverse-dependent build revision whose bytes change:

```text
node-vfs       15 -> 16
lamp           12 -> 13
wordpress      13 -> 14
nginx-vfs       3 -> 4
nginx-php-vfs   3 -> 4
```

- [ ] Ensure each `build.toml` cache-input list includes every changed shared
  helper and still declares `shell` as the direct base dependency through its
  package manifest. Do not add direct mirror or bottle dependencies to derived
  recipes.

- [ ] Re-run focused and package-system tests:

```bash
scripts/dev-shell.sh npx --prefix host vitest run --root host \
  test/shell-vfs-build.test.ts \
  test/dinit-image-helpers.test.ts
scripts/dev-shell.sh npx --prefix host vitest run --root . \
  tests/package-system
```

- [ ] Source-build the complete changed root closure into a fresh resolver
  directory, in dependency order, using the normal resolver contract:

```bash
KANDELO_LAZY_PLAN_BINARIES="$(mktemp -d)"
export KANDELO_LAZY_PLAN_BINARIES
for package in homebrew-bootstrap shell node-vfs lamp wordpress nginx-vfs nginx-php-vfs; do
  scripts/dev-shell.sh cargo run -p xtask -- build-deps \
    --arch wasm32 \
    --binaries-dir "$KANDELO_LAZY_PLAN_BINARIES" \
    --force-source-build \
    resolve "$package"
done
```

- [ ] Inspect each built image and prove it names the exact revision-24 shell
  archive as its direct base and retains the same pending selection. Record
  artifact digests rather than copying outputs into tracked fixture paths.

- [ ] Commit this task:

```bash
git add images/vfs/scripts/shell-vfs-build.ts \
  host/test/shell-vfs-build.test.ts host/test/dinit-image-helpers.test.ts \
  packages/registry/node-vfs/build.toml \
  packages/registry/lamp/build.toml \
  packages/registry/wordpress/build.toml \
  packages/registry/nginx-vfs/build.toml \
  packages/registry/nginx-php-vfs/build.toml
git commit -m "Packages: Preserve lazy shell state in derived images"
```

---

## Task 6: Replace Eager Inspection and Recover the Exact Mirror

**Files:**

- Create: `scripts/inspect-canonical-lazy-shell.ts`
- Create: `scripts/inspect-canonical-lazy-shell.test.ts`
- Remove: `scripts/inspect-canonical-flat-shell.ts`
- Remove: `scripts/inspect-canonical-flat-shell.test.ts`
- Modify: `scripts/recover-homebrew-bottle-mirror.ts`
- Modify: `tests/package-system/homebrew-bottle-mirror-recovery.test.ts`
- Modify: `scripts/create-homebrew-bottle-mirror-publish-manifest.ts`
- Modify: `scripts/test-homebrew-main-shell-mirror-handoff.sh`
- Modify: `scripts/verify-homebrew-main-shell-mirror-handoff.sh`
- Create: `scripts/verify-public-homebrew-bottle-mirror.ts`
- Create: `scripts/verify-public-homebrew-bottle-mirror.test.ts`

- [ ] Port the eager inspector fixtures to a failing lazy inspector. Require
  exact selection/policy/config digests, ABI 42, created-by identity,
  `homebrewFlatLazy`, nonempty mirror and deferred registries, the exact
  3/1/2/35 partition evidence, sealed bootstrap cohort, eager Bash closure,
  deferred independently selected command, and compressed bytes `<10485760`.

- [ ] Add mutation tests for every metadata field, partition overlap or gap,
  zero lazy entries, a 10-MiB-or-larger input, mutable/non-HTTPS URL, mirror
  plan mismatch, package ownership mismatch, unsealed cohort, and a deferred
  Bash dependency.

- [ ] Change recovery input to include the canonical selection file. Parse and
  bind its SHA-256 to `homebrewFlatLazy.selection.sha256`; then map all 37
  mirror assets to the selection descriptors' exact GHCR URL, digest, and byte
  count. Remove dependence on the retired guest catalog manifest.

- [ ] Update the recovery report to contain selection identity instead of
  `catalog`:

```ts
{
  schema: 1,
  kind: "kandelo-homebrew-bottle-mirror-recovery",
  repository: string,
  tag: string,
  collection_sha256: string,
  selection: { sha256: string; name: string; kandelo_abi: 42 },
  plan: { asset: string; sha256: string; bytes: number },
  assets: Array<MirrorAsset & { source_url: string }>,
}
```

- [ ] Require exactly the plan file plus 37 regular payload files in recovery,
  publish-manifest, and handoff validation. Reject missing/extra/symlinked
  files and any source URL not matching the selected GHCR digest path.

- [ ] Write a public verifier test with a fake fetch implementation. It must
  fetch the immutable plan and every declared asset with `credentials: "omit"`
  and `redirect: "error"`, verify status/content-length/bytes/digest, reject
  duplicate or unexpected assets, and emit a deterministic receipt binding
  repository, tag, collection, plan, and all 37 payloads.

- [ ] Run the new tests and observe eager/catalog assumptions fail:

```bash
scripts/dev-shell.sh npx tsx --test \
  scripts/inspect-canonical-lazy-shell.test.ts \
  scripts/verify-public-homebrew-bottle-mirror.test.ts
scripts/dev-shell.sh npx --prefix host vitest run --root . \
  tests/package-system/homebrew-bottle-mirror-recovery.test.ts
scripts/dev-shell.sh bash scripts/test-homebrew-main-shell-mirror-handoff.sh
```

- [ ] Implement the lazy inspector by reusing runtime parsers, imported seal
  verification, and mirror-plan parsing rather than duplicating schemas.
  Delete the eager inspector only after all callers migrate.

- [ ] Implement selection-backed recovery and anonymous public verification.
  Keep output staging atomic and size/count bounds intact.

- [ ] Re-run tests and commit:

```bash
scripts/dev-shell.sh npx tsx --test \
  scripts/inspect-canonical-lazy-shell.test.ts \
  scripts/verify-public-homebrew-bottle-mirror.test.ts
scripts/dev-shell.sh npx --prefix host vitest run --root . \
  tests/package-system/homebrew-bottle-mirror-recovery.test.ts
scripts/dev-shell.sh bash scripts/test-homebrew-main-shell-mirror-handoff.sh
git add scripts/inspect-canonical-lazy-shell.ts \
  scripts/inspect-canonical-lazy-shell.test.ts \
  scripts/recover-homebrew-bottle-mirror.ts \
  scripts/create-homebrew-bottle-mirror-publish-manifest.ts \
  scripts/verify-public-homebrew-bottle-mirror.ts \
  scripts/verify-public-homebrew-bottle-mirror.test.ts \
  scripts/verify-homebrew-main-shell-mirror-handoff.sh \
  scripts/test-homebrew-main-shell-mirror-handoff.sh \
  tests/package-system/homebrew-bottle-mirror-recovery.test.ts
git add -u scripts/inspect-canonical-flat-shell.ts \
  scripts/inspect-canonical-flat-shell.test.ts
git commit -m "Release: Inspect and recover the canonical lazy shell"
```

---

## Task 7: Seal, Publish, and Gate the Mirror Before Activation

**Files:**

- Modify: `.github/workflows/staging-build.yml`
- Modify: `.github/workflows/prepare-merge.yml`
- Modify: `.github/workflows/reusable-homebrew-main-shell-mirror-publish.yml`
- Modify: `.github/workflows/homebrew-main-shell-ci.yml`
- Modify: `.github/workflows/activate-merge-candidate.yml`
- Modify: `.github/scripts/activate-merge-candidate.sh`
- Modify: `.github/scripts/test-merge-candidate-workflows.sh`
- Modify: `tools/xtask/src/index_candidate.rs` and its tests if candidate
  receipts need the mirror-handoff identity
- Modify: `scripts/check-homebrew-publish-workflow-trust.rb`
- Modify: `scripts/check-homebrew-main-shell-mirror-workflow.rb`
- Modify: `scripts/test-homebrew-main-shell-mirror-workflow.sh`
- Modify: `tests/scripts/ci-run-test-suite-groups.test.sh`

- [ ] Add failing structural tests for the complete order:

```text
exact candidate build
  -> sealed mirror handoff
  -> protected tap mirror publication
  -> anonymous public readback
  -> canonical package-index activation
  -> Pages dispatch
```

  Assert neither a pull-request/push Pages job nor Kandelo's activation token
  can publish the tap-owned mirror. Assert action pins remain full 40-character
  SHAs.

- [ ] Extend candidate tests so a changed shell candidate must bind the exact
  handoff digest, selection digest, mirror collection digest, plan digest,
  plan bytes, and asset count. Unchanged candidates need no new mirror. Reject
  a shell candidate whose handoff does not match the shell archive selected by
  its candidate index.

- [ ] In staging/prepare, recover the mirror from the exact resolver-selected
  shell plus canonical selection and package the mirror plan, 37 payloads,
  bootstrap ZIP/env, shell report, and a closed manifest into one bounded,
  content-addressed handoff. Verify it before upload and carry its immutable
  digest into `candidate.json` and `ready.json`; never rerun the shell composer
  during prepare when the exact successful candidate handoff is available.

- [ ] Publish the handoff as a public immutable transport asset whose tag is
  derived from its complete digest. This is pre-activation evidence, not the
  Homebrew bottle mirror and not a package index. The protected tap publisher
  must verify it against merged default-branch code before using it.

- [ ] Refactor the reusable mirror workflow inputs to:

```yaml
kandelo-ref:       # exact merged Automattic/kandelo main SHA
candidate-tag:     # exact merge-candidate identity
handoff-url:       # immutable public Kandelo handoff asset
handoff-sha256:    # digest sealed by the candidate receipt
```

  Remove campaign-era catalog/canary/lifecycle modes. Continue requiring the
  caller repository `Kandelo-dev/homebrew-tap-core`, its protected main branch,
  and its exact caller workflow path. The tap caller's current commit remains
  the only release-write authority.

- [ ] Make the publisher anonymously download and verify the handoff, compare
  its selection and shell binding with exact `kandelo-ref`, create or verify
  the content-derived immutable release, and then run the public verifier
  against the unauthenticated release URLs. Existing identical releases are
  idempotent; conflicting assets fail closed and are never replaced.

- [ ] In `activate-merge-candidate.sh`, detect a candidate that changes shell
  revision 24 or its dependents. Before copying any candidate archive or
  invoking canonical `index-candidate activate`, extract the exact shell image
  selected by the candidate index, run the lazy inspector, and run the public
  mirror verifier using its embedded plan.

- [ ] If the exact mirror is absent, dispatch the protected tap publisher once
  using the candidate's sealed handoff and return a retryable, nonterminal
  result. Do not upload a rejection marker and do not mutate the canonical
  release. Scheduled reconciliation will retry and activate after anonymous
  readback succeeds.

- [ ] Keep all candidate resolution, test-workspace activation, inspection,
  and consumer execution inside the reviewed dev-shell boundary. Retain the
  regression assertion for both staging and prepare:

```text
dev_shell_line < activation_line < consumer_line
```

  Prepare's Node acceptance must still contain exactly one
  `scripts/dev-shell.sh` invocation and one quoted heredoc so exports cannot be
  stripped between activation and consumption.

- [ ] Replace the stale campaign body of
  `homebrew-main-shell-ci.yml` with a read-only selection-backed diagnostic, or
  remove its unused triggers after proving no caller remains. Preserve the
  branch-protection display name owned by
  `staging-build.yml`'s `homebrew-main-shell-gate` job.

- [ ] Run workflow, trust, and shell tests:

```bash
scripts/dev-shell.sh bash .github/scripts/test-merge-candidate-workflows.sh
scripts/dev-shell.sh bash scripts/test-homebrew-main-shell-mirror-workflow.sh
scripts/dev-shell.sh ruby scripts/check-homebrew-main-shell-mirror-workflow.rb
scripts/dev-shell.sh ruby scripts/check-homebrew-publish-workflow-trust.rb
scripts/dev-shell.sh bash tests/scripts/ci-run-test-suite-groups.test.sh
scripts/dev-shell.sh cargo test -p xtask index_candidate
```

- [ ] Audit workflow permissions and mutation points: the reusable publisher
  alone has tap `contents: write`; candidate preparation can write only
  Kandelo candidate/handoff state; activation can write the Kandelo package
  release only after public verification; Pages has no mirror publication
  step.

- [ ] Commit this task:

```bash
git add .github/workflows/staging-build.yml \
  .github/workflows/prepare-merge.yml \
  .github/workflows/reusable-homebrew-main-shell-mirror-publish.yml \
  .github/workflows/homebrew-main-shell-ci.yml \
  .github/workflows/activate-merge-candidate.yml \
  .github/scripts/activate-merge-candidate.sh \
  .github/scripts/test-merge-candidate-workflows.sh \
  tools/xtask/src/index_candidate.rs \
  scripts/check-homebrew-publish-workflow-trust.rb \
  scripts/check-homebrew-main-shell-mirror-workflow.rb \
  scripts/test-homebrew-main-shell-mirror-workflow.sh \
  tests/scripts/ci-run-test-suite-groups.test.sh
git commit -m "CI: Publish lazy shell mirrors before activation"
```

---

## Task 8: Make Pages Consume and Prove the Canonical Lazy Products

**Files:**

- Modify: `.github/workflows/browser-demos-pages.yml`
- Modify: `scripts/ci-check-pages-deployment.sh`
- Modify: `scripts/test-pages-deployment-contract.sh`
- Modify: `run.sh`
- Modify: `tests/package-system/browser-binary-dependencies.test.ts`
- Modify: `tests/package-system/shell-lazy-url-resolution.test.ts`
- Modify: `apps/browser-demos/test/kandelo-homebrew-main-shell.spec.ts`
- Remove: `apps/browser-demos/test/kandelo-canonical-flat-shell.spec.ts`
- Modify: `apps/browser-demos/test/kandelo-node.spec.ts`
- Modify: `scripts/homebrew-main-shell-node-smoke.ts`
- Modify: `scripts/homebrew-main-shell-image-contract.ts`
- Modify: related focused tests for those scripts

- [ ] Add failing Pages contract tests requiring dispatch-only deployment from
  an activation receipt, a fresh fetch-only package cache, canonical resolution
  of `shell`, `homebrew-bootstrap`, and `node-vfs`, the lazy inspector, the
  public mirror verifier, browser lazy-shell acceptance, and Node npm
  acceptance before deployment.

- [ ] Replace every eager assertion (`homebrewFlat`, zero lazy entries,
  `flat-self-contained`, `mirror_required: false`) with the exact
  `homebrewFlatLazy`/37-tree/immutable-mirror/sub-10-MiB contract. Delete the
  eager-only Playwright test after its coverage exists in the lazy test.

- [ ] Remove `homebrew-bootstrap` from `BROWSER_FETCH_SKIP_PKGS` in `run.sh`.
  Resolve its canonical package output with the same fetch-only index and copy
  the exact verified ZIP to
  `apps/browser-demos/public/homebrew-bootstrap.zip`. Retire
  `prepare-homebrew-browser-bootstrap.sh` from production preparation; retain
  it only for historical tooling if an explicit caller remains.

- [ ] Adapt `kandelo-homebrew-main-shell.spec.ts` to the new selection-relative
  runtime policy and public mirror. At boot readiness require completed ledger
  entries for the bootstrap ZIP, libyaml, and ruby, while all 35 ordinary
  bottle trees remain pending.

- [ ] Invoke one independently deferred command selected from the partition
  evidence. Require exactly its tree to download, complete, and enlarge the
  ledger; invoke it again and prove the row, event count, loaded bytes, and
  request count do not change. Require Bash startup before that command to make
  no ordinary bottle request.

- [ ] Add save/restore coverage and repeat the same checks against `node-vfs`,
  `lamp`, `wordpress`, `nginx-vfs`, and `nginx-php-vfs` fixtures. The pending
  selection and mirror identity must survive; product-specific eager files and
  demo config may differ.

- [ ] Rewrite `homebrew-main-shell-node-smoke.ts` and image-contract helpers to
  parse the flat selection/runtime policy instead of migration locks and old
  guest catalog fields. Prove Node and browser observe the same package
  partitions and completed/pending transitions.

- [ ] Ensure the Node demo's npm installation does not request a Homebrew
  mirror payload. Its only network traffic beyond app assets should be npm
  registry traffic through the browser network proxy boundary from the
  companion proxy plan.

- [ ] Run focused contract tests:

```bash
scripts/dev-shell.sh bash scripts/test-pages-deployment-contract.sh
scripts/dev-shell.sh bash scripts/ci-check-pages-deployment.sh
scripts/dev-shell.sh npx --prefix host vitest run --root . \
  tests/package-system/browser-binary-dependencies.test.ts \
  tests/package-system/shell-lazy-url-resolution.test.ts
scripts/dev-shell.sh npx tsx --test \
  scripts/homebrew-main-shell-image-contract.test.ts
```

- [ ] Run browser lazy-state parity in all engines with the exact locally built
  assets and a closed fixture mirror:

```bash
scripts/dev-shell.sh bash -c 'cd apps/browser-demos && \
  npx playwright test test/kandelo-homebrew-main-shell.spec.ts \
    --project=chromium --project=firefox --project=webkit'
```

- [ ] Run Chromium product acceptance against a production Vite build using
  the exact candidate shell/bootstrap/Node assets:

```bash
scripts/dev-shell.sh bash -c 'cd apps/browser-demos && npm run build && \
  KANDELO_PLAYWRIGHT_SERVE_DIST=1 npx playwright test \
    test/kandelo-homebrew-main-shell.spec.ts \
    test/kandelo-node.spec.ts --project=chromium'
```

- [ ] Commit this task:

```bash
git add .github/workflows/browser-demos-pages.yml \
  scripts/ci-check-pages-deployment.sh \
  scripts/test-pages-deployment-contract.sh run.sh \
  tests/package-system/browser-binary-dependencies.test.ts \
  tests/package-system/shell-lazy-url-resolution.test.ts \
  apps/browser-demos/test/kandelo-homebrew-main-shell.spec.ts \
  apps/browser-demos/test/kandelo-node.spec.ts \
  scripts/homebrew-main-shell-node-smoke.ts \
  scripts/homebrew-main-shell-image-contract.ts
git add -u apps/browser-demos/test/kandelo-canonical-flat-shell.spec.ts
git commit -m "Pages: Consume and prove canonical lazy images"
```

---

## Task 9: Document the Product, Validate the Closure, and Roll It Out

**Files:**

- Modify: `docs/package-management.md`
- Modify: `docs/binary-releases.md`
- Modify: `docs/browser-support.md`
- Modify: `docs/future-improvements.md`
- Modify: `docs/homebrew-publishing.md` where it still describes the retired
  campaign as active
- Modify: PR description prepared for this branch
- External companion after Kandelo merge:
  `Kandelo-dev/homebrew-tap-core/.github/workflows/publish-main-shell-mirror.yml`

- [ ] Update package-management docs to say the flat selection is bottle
  authority while output materialization is a separate policy. Document the
  3 embedded bottles, bootstrap descriptor, 37 deferred bottle trees, sealed
  bootstrap/libyaml/ruby cohort, independent ordinary trees, and `<10 MiB`
  compressed invariant as current behavior.

- [ ] Update binary-release and Homebrew publication docs with the exact trust
  sequence: candidate/handoff sealing, protected tap publication, anonymous
  mirror readback, Kandelo index activation, then Pages consumption. State
  clearly that Pages and pull-request jobs do not publish mirror assets.

- [ ] Add explicit future work for both unsupported areas the user deferred:
  - compatibility/migration for already-downloaded old lazy VFS images; and
  - persistence of lazy download ledgers and hydrated trees across kernel or
    browser-session replacement.

  State that current work rebuilds canonical images and deliberately does not
  promise either behavior. Keep the separate constrained-CORS-proxy future
  item from the companion plan.

- [ ] Run all focused unit and structural suites from a clean declared tool
  environment:

```bash
scripts/dev-shell.sh npx --prefix host vitest run --root host \
  test/homebrew-vfs-materialization-policy.test.ts \
  test/homebrew-runtime-support.test.ts \
  test/homebrew-flat-vfs-builder.test.ts \
  test/homebrew-vfs-builder.test.ts \
  test/homebrew-flat-lazy-vfs-composer.test.ts \
  test/homebrew-flat-lazy-vfs-cli.test.ts \
  test/homebrew-vfs-image-save.test.ts \
  test/shell-vfs-build.test.ts \
  test/dinit-image-helpers.test.ts
scripts/dev-shell.sh npx --prefix host vitest run --root . \
  tests/package-system
scripts/dev-shell.sh bash scripts/test-homebrew-main-shell-closure.sh
scripts/dev-shell.sh bash scripts/test-homebrew-main-shell-mirror-handoff.sh
scripts/dev-shell.sh bash scripts/test-homebrew-main-shell-mirror-workflow.sh
scripts/dev-shell.sh bash tests/scripts/ci-run-test-suite-groups.test.sh
scripts/dev-shell.sh bash scripts/test-pages-deployment-contract.sh
scripts/dev-shell.sh bash .github/scripts/test-merge-candidate-workflows.sh
```

- [ ] Run the full host suite because shared VFS serialization and import paths
  changed:

```bash
scripts/dev-shell.sh npm --prefix host test -- --run
```

- [ ] Source-build the exact changed package closure from a fresh cache and
  archive each package through normal `xtask archive-stage`/candidate workflow
  paths. Verify the revisions, cache keys, direct dependency receipts, and
  generated candidate index before using any browser asset.

- [ ] Inspect the real shell and every derived image. Record:
  - package revision, archive SHA-256, and VFS SHA-256;
  - shell compressed byte count `<10485760`;
  - exact 3/1/2/35 partition and 37 mirror payloads;
  - bootstrap cohort seals and readiness ledger;
  - one independent first-use download and zero repeat download; and
  - identical pending selection/mirror identity in every derived image.

- [ ] Run Node boot, deferred-command, repeat-command, and save/restore tests
  with closed assets. Then run Chromium, Firefox, and WebKit lazy transport
  tests and Chromium production acceptance for shell plus Node/npm.

- [ ] Manually run `./run.sh browser` with the locally built exact package
  generation. Verify prompt transfer size, boot readiness ledger, first-use
  command download, repeat invocation, save/restore, and the Node demo's
  `npm install --verbose cowsay` plus installed command execution. Capture
  browser console errors and network requests.

- [ ] Confirm ABI and repository hygiene:

```bash
git diff --check
git diff -- abi/snapshot.json crates/shared/src/lib.rs
rg -n 'uses: [^#\n]+@(v[0-9]|main|master)($|[[:space:]]+#)' .github
rg -n 'main-shell-(migration|selection|lazy-artifact)-lock|guest-prefix-campaign' \
  packages/registry/shell host/src images/vfs/scripts .github/workflows
```

- [ ] Explain in the PR description, with `## Why` first, that revision 23
  made the shell 45.6 MB by eagerly pouring all selected bottles, while this
  change restores authenticated first-use downloads without changing ABI.
  Follow with implementation, publication order, failure behavior, and exact
  validation evidence. Wrap prose at 72 columns.

- [ ] Commit documentation:

```bash
git add docs/package-management.md docs/binary-releases.md \
  docs/browser-support.md docs/future-improvements.md \
  docs/homebrew-publishing.md
git commit -m "Docs: Define lazy shell publication and future migration work"
```

- [ ] Request code review with `superpowers:requesting-code-review`. Resolve
  findings using `superpowers:receiving-code-review`, rerun affected evidence,
  and use `superpowers:verification-before-completion` before reporting the PR
  ready.

- [ ] After Kandelo merges, update the protected tap caller workflow to pin the
  merged Kandelo reusable workflow commit and supply the exact merged SHA,
  candidate tag, handoff URL, and handoff digest. Validate the tap change on a
  branch, merge it through that repository's protection, and dispatch the
  exact candidate.

- [ ] Observe the protected tap release publish and anonymous readback. Then
  rerun or wait for scheduled candidate reconciliation. Confirm the canonical
  index activates shell 24, node-vfs 16, lamp 13, wordpress 14, nginx-vfs 4,
  and nginx-php-vfs 4 before Pages is dispatched.

- [ ] Verify live Pages from a fresh browser profile: deployment manifest
  source/candidate/index identities, shell transfer below 10 MiB, readiness
  cohort ledger, independent first-use download with no repeat, and successful
  `npm install --verbose cowsay` plus execution. Report exact public URLs and
  digests; do not describe publication as complete until this evidence exists.

- [ ] If mirror publication, activation, or Pages fails, stop at that boundary.
  Leave the prior canonical index and deployed Pages generation intact; fix by
  advancing package revisions or handoff content, never by overwriting an
  immutable release.

POSIX conformance suites are considered but not automatically required by this
plan because it changes no syscall, process, libc, or ABI semantics. If
implementation touches those layers unexpectedly, stop and expand validation
according to `docs/agent-guidance/validation.md` before continuing.
