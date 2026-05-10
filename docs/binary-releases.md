# Binary releases

Prebuilt Wasm binaries — the kernel, user programs, and library
archives — live in GitHub Releases rather than the Git repo. This
keeps the repo small and makes rebuilds optional for contributors:
fetch once, use everywhere.

The flow is **per-package**: each `examples/libs/<name>/package.toml`
points at its own published archive. Adding or rebuilding one package
only re-uploads that package's `.tar.zst`. There is no central
pinfile.

## Producer side: the matrix flow

Every staging-build run (PR push or `workflow_dispatch`) follows the
same matrix flow in `.github/workflows/staging-build.yml`:

```
preflight → toolchain-cache → matrix-build → test-gate → publish → generate-index → f2-status
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
- **matrix-build** runs once per `(package, arch)` matrix entry:
  download the toolchain artifact, run `xtask archive-stage` with
  pinned commit-bound `--build-timestamp` + `--build-host`, upload
  the resulting single `.tar.zst` as a per-entry artifact.
- **test-gate** materializes the full `binaries/` tree by writing
  `examples/libs/<pkg>/package.pr.toml` overlays for each
  matrix-built archive (file:// URLs into a runner-local stage dir),
  then runs `scripts/fetch-binaries.sh`. The resolver picks up the
  overlay first (matrix bytes) and falls back to the durable
  release for everything else. Then the standard test suite runs:
  `cargo test`, `vitest`, libc-test, POSIX, sortix.
- **publish** uploads the per-entry archives to the target tag
  (`pr-<NNN>-staging` for PRs, `binaries-abi-v<N>` for non-PR
  runs). `gh release upload --clobber`. A concurrency group on the
  tag serializes uploads to avoid metadata races.
- **generate-index** runs `xtask build-index --archives-dir <staging>
  --abi <N>` to emit `index.toml` (provenance manifest, not a
  contract — see [`index.toml`](#indextoml-provenance-not-contract))
  and uploads it as a release asset.
- **f2-status** posts/edits a sticky PR comment summarizing
  per-package outcomes.

`prepare-merge.yml` (triggered by the `ready-to-ship` label) and
`force-rebuild.yml` (manual `workflow_dispatch`) reuse the same
matrix shape. Their post-publish step amends in-tree
`examples/libs/<pkg>/package.toml` files (`xtask
set-package-binary` + `xtask set-build-commit`) on a bot PR, which
auto-merges to bump the durable URLs without tying every package to
a single pinfile.

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

The ABI version appears in the tag because a release is tied to a
specific kernel ABI. Programs from `binaries-abi-v6` cannot run
against a kernel on ABI 7 — the resolver's compatibility check
rejects them.

## Layout of a release

Flat asset namespace. Per-package archive filenames + a single
`index.toml` provenance file.

```
binaries-abi-v6 (release)
├── index.toml                                              ← provenance
├── zlib-1.3.1-rev1-abi6-wasm32-9acb9405.tar.zst            ← library
├── zlib-1.3.1-rev1-abi6-wasm64-b1773def.tar.zst            ← library
├── ncurses-6.5-rev1-abi6-wasm32-2a55c8e0.tar.zst           ← library
├── vim-9.1-rev1-abi6-wasm32-c4e2118a.tar.zst               ← program
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
manifest.toml              ← source package.toml + injected [compatibility]
artifacts/                 ← cache-tree contents
    lib/libz.a
    include/zlib.h
    include/zconf.h
    lib/pkgconfig/zlib.pc
```

The consumer (`xtask build-deps resolve`, calling
`remote_fetch::fetch_and_install`) flattens `artifacts/*` to the
cache root after extraction. See `docs/package-management.md`
"Release archives" for the full producer/consumer round-trip and
the `[compatibility]` block.

## index.toml: provenance, not contract

`index.toml` is emitted as a release asset by `generate-index`. It
records what was published in this run and when, but **the resolver
does not consume it**. The contract is the per-package
`[binary.<arch>].archive_url` + `archive_sha256` in
`examples/libs/<pkg>/package.toml`. `index.toml` exists for human
auditing and out-of-band tooling (CI scripts that want to inventory
a release without parsing every package.toml).

Schema:

```toml
abi_version = 6
generated_at = "2026-05-09T12:34:56Z"
generator = "cargo xtask build-index"

[[packages]]
name = "zlib"
version = "1.3.1"
revision = 1
arch = "wasm32"
archive_name = "zlib-1.3.1-rev1-abi6-wasm32-9acb9405.tar.zst"
archive_sha256 = "…"
short_sha = "9acb9405"

[[packages]]
…
```

## Per-package binary metadata

`examples/libs/<pkg>/package.toml` is the source of truth for what
the resolver fetches. Multi-arch shape:

```toml
[binary.wasm32]
archive_url = "https://github.com/.../zlib-1.3.1-rev1-abi6-wasm32-9acb9405.tar.zst"
archive_sha256 = "<64-hex>"

[binary.wasm64]
archive_url = "https://github.com/.../zlib-1.3.1-rev1-abi6-wasm64-b1773def.tar.zst"
archive_sha256 = "<64-hex>"
```

Single-arch shape (when `arches = ["wasm32"]` is the only declared
arch):

```toml
[binary]
archive_url = "https://github.com/.../foo-1.0-rev1-abi6-wasm32-deadbeef.tar.zst"
archive_sha256 = "<64-hex>"
```

A `package.toml` with no `[binary]` block is treated as
local-build-only (the resolver source-builds via
`scripts/dev-shell.sh`).

## PR overlays: `package.pr.toml`

For PR-staging builds, a sibling `examples/libs/<pkg>/package.pr.toml`
overrides `[binary.<arch>].archive_url` + `archive_sha256` without
touching the durable `package.toml`. The overlay is generated by
the staging-build matrix flow's test-gate step into the runner
workdir, so PR archives can reference `file://` URLs locally and
`https://` URLs once published.

The overlay parser (`xtask/src/pkg_manifest.rs::apply_pr_overlay`)
only accepts `[binary]` / `[binary.<arch>]` keys; anything else
errors out. This keeps overlays narrowly scoped: they cannot replace
build inputs or change the package's revision.

## Consumer: `scripts/fetch-binaries.sh`

```bash
bash scripts/fetch-binaries.sh
```

Walks every `examples/libs/<pkg>/package.toml` with a `[binary]` block
and runs:

```
cargo run -p xtask -- build-deps --arch <arch> \
    --binaries-dir <repo>/binaries resolve <pkg>
```

For each declared arch in the package's `arches = [...]` (default
`["wasm32"]`). The resolver:

1. Reads `[binary.<arch>]` from `package.toml`. If
   `package.pr.toml` exists alongside, applies it as an overlay
   (replaces `archive_url` + `archive_sha256` for that arch).
2. Fetches the archive into the content-addressed cache at
   `~/.cache/wasm-posix-kernel/...`.
3. Verifies `archive_sha256` against the file bytes.
4. Verifies the embedded `manifest.toml`'s `[compatibility]` block:
   `kernel_abi` must match the in-tree `ABI_VERSION`.
5. Places `binaries/programs/<arch>/<output>.wasm` symlinks pointing
   into the cache, so browser/Node demos can load by relative path
   without re-fetching.

On any verification failure, the resolver logs a warning and falls
through to a source build (the package's `[build]` script). This
makes ABI bumps and rev bumps non-fatal: as long as the source-build
path works, missing archives just slow the first run.

## Cache eviction

The cache is content-addressed. A different `archive_url` ⇒ a
different canonical path under `~/.cache/wasm-posix-kernel/`. Old
entries are never overwritten; they're orphaned. Disk-pressure
cleanup is the user's responsibility — no automated GC today.

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

## ABI bumps

Bumping `ABI_VERSION` in `crates/shared/src/lib.rs` invalidates every
durable archive against ABI mismatch (the resolver's `[compatibility]`
check rejects). The bump PR's matrix flow rebuilds every package
whose `cache_key_sha` is now stale (the ABI is part of the sha), and
the merge-time amend rewrites every `[binary.<arch>].archive_url` to
the freshly-published archive. See [`abi-versioning.md`](abi-versioning.md)
for the full ABI-bump checklist.
