# Binary releases

Prebuilt Wasm binaries - runtime platform artifacts, user programs,
and library archives - live in GitHub Releases rather than the Git repo. This
keeps the repo small and makes rebuilds optional for contributors:
fetch once, use everywhere.

Package artifacts use a **per-package + index-ledger** flow: every release tag carries
a single `index.toml` ledger that records every published archive's
URL + sha + cache-key. Each `packages/registry/<name>/build.toml` points
its `[binary]` entry at that ledger (typically via `index_url` with a
`{abi}` placeholder so one `build.toml` survives ABI bumps).

First-party runtime platform artifacts are owned separately by
`platform/artifacts/manifest.json`. That manifest records `kernel`,
`userspace`, and `kandelo-sdk` archive URLs, shas, ABI, source fallback,
provenance inputs, runtime paths, and required Node.js/browser smoke evidence.
They may still be present as bridge entries in `packages/registry/`, but fresh
materialization does not require their package identities.

Adding or rebuilding one package re-uploads that package's `.tar.zst`
**and** updates exactly that package's entry in `index.toml` —
atomically, under a workflow-level state-lock so concurrent
matrix-build jobs serialize their writes to the same ledger without
clobbering each other.

See [docs/plans/2026-05-13-binary-resolution-via-index-ledger-design.md](plans/2026-05-13-binary-resolution-via-index-ledger-design.md)
for the design rationale and [docs/package-management.md](package-management.md)
for the resolver behavior, schema, and build-script contract.
For third-party repositories that publish their own package archives,
see [docs/package-sources.md](package-sources.md).

Homebrew bottles use a separate publication model. Bottle tarballs are
Homebrew-native artifacts published through the `Automattic/kandelo-homebrew`
tap and GHCR/Homebrew bottle URL shape; Kandelo-specific sidecars, provenance,
and optional browser gallery assets publish to the tap's `bottles-abi-v<N>`
release. They do not appear in the main repository's `binaries-abi-v<N>`
`index.toml` ledger. See [docs/homebrew-publishing.md](homebrew-publishing.md)
for formula authoring and operations.

## Producer side: the matrix flow

Every staging-build run (PR push or `workflow_dispatch`) follows the
same matrix flow in `.github/workflows/staging-build.yml`. After this
PR's [Phase 10 workflow rewrite](plans/2026-05-13-binary-resolution-via-index-ledger-plan.md):

```
preflight → toolchain-cache → matrix-build → test-gate → merge-gate
```

- **preflight** computes the build matrix. For each package with a
  `[build]` block, for each declared `arches = [...]` entry, it
  runs `xtask compute-cache-key-sha`. If the resulting
  `<pkg>-<ver>-rev<N>-abi<N>-<arch>-<short8>.tar.zst` filename is
  already an asset on the target release tag, the entry is dropped
  (already published, nothing to rebuild). Otherwise it lands in
  the matrix.
- **toolchain-cache** does a one-shot build of the wasm32 + wasm64
  musl sysroot + libc++ headers, uploads them as a workflow
  artifact, and saves the same content into actions/cache. The
  cache key is content-addressed over the sysroot recipe + musl
  submodule SHA, so toolchain churn is rare.
- **matrix-build** runs once per `(package, arch)` matrix entry.
  Per-entry steps:
  1. Download the toolchain artifact.
  2. Run `xtask archive-stage` to produce the per-entry `.tar.zst`
     (pinned commit-bound `--build-timestamp` + `--build-host`).
  3. Invoke `scripts/index-update.sh --target-tag <tag> --package
     <name> --version <v> --revision <r> --arch <a> --status success
     --archive-path <staged> --archive-name <n> --cache-key-sha <s>`.
     The script acquires the state-lock for `<tag>`, downloads the
     current `index.toml` (or bootstraps an empty one for a fresh
     tag), runs `xtask index-update` to mutate this package's entry,
     uploads the archive + new `index.toml` with `--clobber`, and
     releases the lock.
  4. On failure: a separate `if: failure()` step runs
     `scripts/index-update.sh --status failed --error <msg>` so the
     ledger reflects the failure. If a prior successful build for
     this `(name, version, arch)` exists in the entry, it's
     preserved in `fallback_archive_url` — consumers can keep
     using the last-green archive while CI iterates on the rebuild.
- **test-gate** materializes the full `binaries/` tree by running
  `scripts/fetch-binaries.sh` — which now reads `build.toml`'s
  `index_url`, fetches `index.toml` from the target release, and
  resolves each `(package, arch)` from the ledger. Then the standard
  test suite runs: `cargo test`, `vitest`, libc-test, POSIX, sortix.
- **merge-gate** posts `merge-gate=success` on the PR's HEAD SHA
  once test-gate passes. No bot-PR amend step exists anymore — the
  ledger on the release IS the consumer-visible state, so there's
  nothing in-tree to amend.

`prepare-merge.yml` (triggered by the `ready-to-ship` label) reuses
the same shape but targets the durable `binaries-abi-v<N>` tag.
`force-rebuild.yml` is the manual escape hatch (`workflow_dispatch`)
for republishing selected packages.

## State-lock serialization

`scripts/index-update.sh` acquires the workflow-level state-lock
before mutating `index.toml`. The lock ref is per-subject:

```
refs/heads/github-actions/state-lock/<subject>
```

Where `<subject>` is the target release tag (`binaries-abi-v11`,
`pr-447-staging`, etc.). Different tags → different subjects →
independent locks, so concurrent rebuilds for the durable release
don't block per-PR staging publishes and vice versa.

The lock uses the existing stale-detection mechanism inherited from
`durable-release-lock.sh` (run-ID-based + 6h time fallback), so a
crashed workflow can't leave a wedged lock indefinitely.

## Release tag convention

```
binaries-abi-v<ABI_VERSION>
```

The tag is **mutable** — new packages and arches are added as new
assets over time. What's *immutable* is each archive: its filename
encodes the `cache_key_sha` of the build inputs, so a published
asset's bytes never change. Different inputs → different filename.

PR-staging releases use `pr-<NNN>-staging` (also mutable, but
ephemeral — closed PRs leave them as historical curios).

Homebrew tap releases use:

```text
bottles-abi-v<ABI_VERSION>
```

Those releases carry Kandelo/Homebrew sidecars, provenance reports, and
browser-gallery assets. They are intentionally separate from package archive
releases because Homebrew bottle selection is governed by Formula metadata and
Homebrew bottle tags, not by Kandelo's package resolver.

The ABI version appears in the tag because a release is tied to a
specific kernel ABI. Programs from `binaries-abi-v10` cannot run
against a kernel on ABI 11 — the resolver's compatibility check
rejects them.

## Layout of a release

Flat asset namespace. Per-package archive filenames + one
`index.toml` ledger.

```
binaries-abi-v11 (release)
├── index.toml                                              ← LEDGER (the contract)
├── zlib-1.3.1-rev1-abi11-wasm32-e33c5e9a.tar.zst           ← library
├── zlib-1.3.1-rev1-abi11-wasm64-e6c7a02b.tar.zst           ← library
├── ncurses-6.5-rev1-abi11-wasm32-3ef36fae.tar.zst          ← library
├── vim-9.1.0900-rev2-abi11-wasm32-0e8b5c34.tar.zst         ← program
└── …
```

Filename schema:
`<name>-<version>-rev<N>-abi<N>-<arch>-<short-cache-key-sha>.tar.zst`,
where `short-cache-key-sha` is the first 8 chars of the cache-key
sha for that manifest. Two archives with the same `(name, version,
revision, arch)` but different transitive deps get distinct shas
and thus distinct names.

### Archive interior layout

Each `.tar.zst` carries exactly two top-level entries:

```
manifest.toml              ← source package.toml + injected revision + [compatibility]
artifacts/                 ← cache-tree contents
    lib/libz.a
    include/zlib.h
    include/zconf.h
    lib/pkgconfig/zlib.pc
```

The consumer (`xtask build-deps resolve`, calling
`remote_fetch::fetch_and_install_direct`) flattens `artifacts/*` to
the cache root after extraction. See
[docs/package-management.md](package-management.md) "Release
archives" for the full producer/consumer round-trip and the
`[compatibility]` block.

## `index.toml`: the contract

`index.toml` is the **single source of truth** for binary resolution.
The resolver fetches it (with offline cache fallback at
`~/.cache/kandelo/indexes/`), looks up
`(name, version, arch)`, and decides which archive to install based
on the entry's `status`.

Schema (see [design §3.4](plans/2026-05-13-binary-resolution-via-index-ledger-design.md#34-indextoml--ledger-of-build-state)):

```toml
abi_version = 11
generated_at = "2026-05-13T..."
generator = "kandelo CI @ <sha>"

[[packages]]
name     = "zlib"
version  = "1.3.1"
revision = 1

[packages.binary.wasm32]
status         = "success"
archive_url    = "zlib-1.3.1-rev1-abi11-wasm32-e33c5e9a.tar.zst"
archive_sha256 = "<64-hex>"
cache_key_sha  = "<64-hex>"
built_at       = "2026-05-13T..."
built_by       = "https://github.com/.../actions/runs/<id>"

[packages.binary.wasm64]
status              = "failed"
error               = "linker: libc++abi missing for wasm64 toolchain"
last_attempt        = "2026-05-13T..."
last_attempt_by     = "https://github.com/.../actions/runs/<id>"
# Last-green fallback: the previous successful build, preserved across
# the failed rebuild.
fallback_archive_url    = "zlib-1.3.1-rev1-abi11-wasm64-87766332.tar.zst"
fallback_archive_sha256 = "<64-hex>"
fallback_cache_key_sha  = "<64-hex>"
fallback_built_at       = "2026-05-12T..."
```

### Status semantics

| Value | Meaning | Resolver behavior |
|---|---|---|
| `success` | Latest build succeeded; current archive fields are authoritative | Fetch `archive_url`, verify, install |
| `failed` | Latest build failed; `error` describes why | Use `fallback_*` if present; else fall through to source build |
| `pending` / `building` | Transient (rebuild queued or in flight) | Use `fallback_*` if present; else source build |

### ABI invariant

Each `index.toml` is single-ABI. Its top-level `abi_version` must
match every `archive_url` and `fallback_archive_url` filename segment
of the form `-abi<N>-`. Durable `binaries-abi-v<N>` releases use `N`
from the tag. Mutable `pr-<NNN>-staging` releases use the in-tree
`ABI_VERSION` from `crates/shared/src/lib.rs` at publish time.

`scripts/index-update.sh` passes the expected ABI into
`xtask index-update` on every publish. If a reused PR-staging release
still has an old `index.toml`, the top-level `abi_version` is
rewritten before the new entry is applied and old-ABI archive entries
are pruned. `xtask index-update` validates the final ledger before
upload, so mixed-ABI indexes are rejected rather than published.
Consumers also compare `index.toml`'s `abi_version` with the
resolver's requested ABI; a mismatch logs a warning and falls through
to source build.

### Last-green fallback

When a per-package rebuild for `(name, version, arch)` fails, the
prior successful `archive_url` / `archive_sha256` / `cache_key_sha`
move into the entry's `fallback_*` slots — consumers keep fetching
the last working archive while CI iterates on the rebuild. A
subsequent success clears the fallback (`update_entry_success`
overwrites current fields and clears `fallback_*`). A repeated
failure does NOT overwrite the fallback (it's the only working copy;
preserved across multiple consecutive failures).

## Per-package binary source: `build.toml`

`packages/registry/<pkg>/build.toml` declares where the resolver fetches
this package's binaries from. Typical shape:

```toml
script_path = "packages/registry/zlib/build-zlib.sh"
repo_url    = "https://github.com/brandonpayton/kandelo.git"
commit      = "<commit at last successful build>"
revision    = 1

[binary]
index_url = "https://github.com/Automattic/kandelo/releases/download/binaries-abi-v{abi}/index.toml"
```

- `{abi}` is substituted with the current `ABI_VERSION` at resolve
  time, so one `build.toml` survives ABI bumps.
- `revision` is the publish-time counter the resolver hashes into
  the cache-key — bump it when output bytes legitimately change.
- For a legacy archive that doesn't live in an index, replace the
  `index_url` line with `url = "https://..."` + `sha256 = "..."`.
  The resolver fetches that archive directly without consulting any
  `index.toml`.

A `package.toml` without a sibling `build.toml` is treated as
source-build-only (kernel, userspace, examples, source-kind
metadata packages) — the resolver source-builds via
`scripts/dev-shell.sh` instead of fetching.

## PR overlays: `package.pr.toml`

The legacy PR-overlay mechanism still exists for one-off local
swaps: a sibling `packages/registry/<pkg>/package.pr.toml` injects
`[binary.<arch>]` entries into the parsed `DepsManifest` at load
time (see `apply_pr_overlay` in `tools/xtask/src/pkg_manifest.rs`).
Gitignored.

For CI-driven PR testing, the matrix flow uses a dedicated
`pr-<NNN>-staging` release tag instead: that tag has its own
`index.toml` (separate state-lock subject from the durable
release). To consume that staging index locally, run through
`run.sh` with `--pr-staging`, or set `WASM_POSIX_USE_PR_STAGING=1`.
`run.sh` detects the current PR and repository with `gh`, verifies the
staging release has `index.toml`, and exports
`WASM_POSIX_BINARY_INDEX_URL=https://github.com/<owner>/<repo>/releases/download/pr-<NNN>-staging/index.toml`.
If `WASM_POSIX_BINARY_INDEX_URL` is already set, that manual override
remains authoritative.

## Consumer: `scripts/fetch-binaries.sh`

```bash
bash scripts/fetch-binaries.sh
```

First materializes platform artifacts:

```
cargo run -p xtask -- platform-artifacts materialize \
    --binaries-dir <repo>/binaries
```

Then walks every non-platform `packages/registry/<pkg>/` that has a
`build.toml` and runs:

```
cargo run -p xtask -- build-deps --arch <arch> \
    --binaries-dir <repo>/binaries resolve <pkg>
```

For each declared arch in the package's `arches = [...]` (default
`["wasm32"]`). The resolver:

1. Reads `package.toml` (recipe) + `build.toml` (project view) from
   `packages/registry/<pkg>/`. `revision` from `build.toml` overrides
   the `DepsManifest`'s default revision before cache-key
   computation.
2. Resolves `build.toml`'s `[binary]`:
   - Indexed form: fetches `index.toml` (with offline cache
     fallback), looks up `(name, version, arch)`, picks
     `archive_url` (status=success) or `fallback_archive_url`
     (status=failed/pending/building with fallback set).
   - Direct form: uses the inline `url` + `sha256`.
3. Fetches the archive into the content-addressed cache at
   `~/.cache/kandelo/...`.
4. Verifies `archive_sha256` against the file bytes.
5. Verifies the embedded `manifest.toml`'s `[compatibility]` block:
   - `target_arch` must match the requested arch.
   - `abi_versions` must contain the in-tree `ABI_VERSION`.
   - `cache_key_sha` must match the resolver's locally-computed
     cache-key sha (catches recipe drift).
6. Places `binaries/programs/<arch>/<output>.wasm` symlinks pointing
   into the cache, so browser/Node demos can load by relative path
   without re-fetching.

On any verification failure, the resolver logs a warning and falls
through to a source build (the package's build script). This
makes ABI bumps and rev bumps non-fatal: as long as the source-build
path works, missing archives just slow the first run.

`--fetch-only` is stricter for both layers. Platform artifacts must be present
locally or fetchable from their manifest archive URLs, and package artifacts
must be present in the release ledger; neither layer source-builds.

## Cache eviction

The cache is content-addressed. A different `archive_url` ⇒ a
different canonical path under `~/.cache/kandelo/`. Old
entries are never overwritten; they're orphaned. Disk-pressure
cleanup is the user's responsibility — no automated GC today.

The `index.toml` cache (`~/.cache/kandelo/indexes/`) is
keyed on the sha8 of the index URL, so different sources land in
distinct files. Each successful online fetch overwrites the cached
copy.

## Reproducibility

`xtask archive-stage` requires `--build-timestamp <ISO>` and
`--build-host <s>`. Both are pinned to commit-bound values in CI
(commit author date for timestamp, `<repo>@<sha>` for host) so
re-running the same SHA at any wall-clock time produces
byte-identical archives. This is load-bearing: test-gate re-installs
the same archives that publish later uploads, and the only way that
round-trip works is if both sides are deterministic.

The `[compatibility]` block injected into each archive's
`manifest.toml` is also a pure function of the build inputs (no
wall-clock or worker-local fields).

`index.toml` itself is also byte-deterministic for a given input
set: `IndexToml::write()` emits packages alphabetically by
`(name, version)`, per-arch entries in canonical `wasm32`→`wasm64`
order, and fields within each entry follow the design's
success-then-failure-then-fallback grouping.

## ABI bumps

Bumping `ABI_VERSION` in `crates/shared/src/lib.rs` invalidates every
durable archive against the resolver's ABI check. The bump PR's
matrix flow rebuilds every package whose `cache_key_sha` is now
stale (the ABI is part of the sha), and each matrix entry's
`scripts/index-update.sh` invocation atomically publishes its
archive + index entry to the new `binaries-abi-v<N+1>/` release.

Because the resolver substitutes `{abi}` in `build.toml`'s
`index_url`, no in-tree edit is required for the URL pivot — the
next fetch automatically hits the new release. The v(N) release
stays as historical state.

See [`abi-versioning.md`](abi-versioning.md) for the full ABI-bump
checklist.

## Seeding an index from existing archives

When migrating a release from the legacy schema (or recovering after
a corrupted index), `scripts/compose-initial-index.sh
<target-tag> <abi>` downloads every `.tar.zst` from the release,
extracts each archive's internal `manifest.toml` to recover
`cache_key_sha` + `build_timestamp`, and uploads a freshly composed
`index.toml`. The script acquires the same state-lock as the
matrix-build path, so it serializes against any active CI rebuilds.

Day-to-day publishes don't use this script — they go through
`scripts/index-update.sh` per-matrix-entry. compose-initial-index is
migration scaffolding kept in-tree for reproducibility.
