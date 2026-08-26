# Plan: Demote program-packages.json to a build-generated (unversioned) artifact

## Why

`packages/registry/program-packages.json` is a source-controlled projection of
package identity + per-arch build `cacheKey`s. The `manifestSha256` fields are
stable everywhere, but the `cacheKey`s are a content hash of the build/toolchain
trees (dominantly the `libc/musl` submodule, plus `sdk/*`, `libc/*`,
`scripts/*`). Because those trees are not byte-identical across checkouts (dirty
submodule working tree, untracked/generated overlay files), regenerating the
projection in any checkout other than the one that last committed it produces
different keys. Committing the file is therefore what *manufactures* the drift:

- `cargo test` gate `committed_program_package_projection_is_current` fails.
- ~66 host Vitest failures ("Program package source projection is not current").
- A stale committed file is a recurring friction point on every fresh/rebased
  worktree.

The key is deterministic *given a tree*, so generating it against the tree we
actually build makes the keys self-consistent and the drift structurally
impossible. A local-first build has no external counterparty that the committed
keys must agree with (the remote binary channel keys off a *separate* file,
`index.toml`, not this projection — see the companion #2 PR).

Goal: the projection is generated wherever it is consumed (build, dev resolve,
npm package-prep) and never committed — same treatment as `catalog.json`.

## Non-goals

- Changing the `cacheKey` *computation* (that is edinburgh's
  `skip-rebuild-with-cache` territory; keep this PR's `local_build.rs` footprint
  near zero to avoid conflict).
- Touching the remote binary channel `index.toml` / `remote_fetch` (that is the
  separate #2 PR).

## Consumers (must keep working)

1. TS resolver `host/src/binary-resolver.ts` — dev source-checkout program
   resolution; a *complete source checkout* runs the freshness gate
   `checkProgramIndexesInSourceContext()` → xtask `program-index-context-check`.
   The npm/browser consumer just reads the bundled `host/wasm/…` copy.
2. npm host package — `scripts/prepare-host-package.sh` copies the committed
   file into `host/wasm/program-packages.json` and refuses if stale.
3. `scripts/build-programs.sh` — reads it for package-owned mirror-path
   ownership.
4. CI/tests — the projection cargo test + several `tests/package-system/*` and
   `host/test/*` suites; `.github/actions/detect-change-scope` already excludes
   the file from archive-rebuild scope.

## Tasks

### Task 1: Stop tracking the file
- `git rm --cached packages/registry/program-packages.json`.
- Add it to `.gitignore` (near the `catalog.json` ignore, matching that idiom).
- Verify nothing else greps the committed path expecting it tracked.

### Task 2: Generate-on-demand in the dev resolver (ensure, don't check)
- Flip `checkProgramIndexesInSourceContext()` from *check-and-fail* to
  *ensure-and-write*: regenerate the index into its registry path when resolving
  from a complete source checkout. Prefer a new xtask subcommand
  `program-index-ensure` (write-if-absent-or-stale, atomic + advisory-locked,
  reusing the existing writer at build_deps.rs `serialize_program_package_index`
  / the lock at ~`:6238`) over the check-only `program-index-context-check`.
- Keep the source-root authentication argv exactly as today.

### Task 3: Generate at build/package time
- `scripts/prepare-host-package.sh`: run `xtask build-deps program-index …` to
  generate, then bundle into `host/wasm/`, instead of copy-committed + check.
- `scripts/build-programs.sh`: ensure the index exists (generate if absent)
  before reading the ownership set.
- `build.sh` / the normal build path: generate the index as an early step so a
  plain `bash build.sh` leaves a fresh index in place.

### Task 4: Remove the now-circular guard + fix tests
- Delete `committed_program_package_projection_is_current`
  (build_deps.rs ~:21038) — it only polices a committed file.
- Update `tests/package-system/*` and `host/test/*` suites that assume a
  committed on-disk file (they should generate a fixture / call the generator,
  not assert the tracked file's presence).
- Keep `program_index_source_root.rs` determinism tests (they test the
  generator, still valid).

### Task 5: CI sweep
- Grep `.github/` for any workflow that reads/writes/commits the committed file
  or fails on its absence; adjust to generate.

### Task 6: Validate
- `cargo test -p xtask --target <host>` green (minus the deleted test).
- `cd host && npx vitest run` — the projection-staleness failures gone.
- A real `./run.sh local-build` still succeeds and leaves a generated index.
- `git status` clean except the intended deletion + `.gitignore` + code.

## Coordination
- edinburgh `skip-rebuild-with-cache` touches `local_build.rs` cache-trust; this
  PR must not. Only shared file risk is `local_build.rs`'s in-memory projection
  regen — leave it untouched here.
