# Binary releases

Prebuilt Wasm binaries — the kernel, user programs, and VFS images —
live in GitHub Releases rather than the Git repo. This keeps the repo
small and makes rebuilds optional for contributors: fetch once, use
everywhere.

This document describes the format and conventions. The release
workflow itself is intentionally manual at first and will be
automated by a GitHub Actions workflow in a follow-up change.

## Release tag convention

```
binaries-abi-v<ABI_VERSION>-<YYYY>-<MM>-<DD>
```

Example: `binaries-abi-v2-2026-04-19`.

Tags are **immutable snapshots**. A new release cut on a later date
gets a new tag — we do not rewrite assets on an existing release.
This means:

- `binaries.lock` (the per-repo pin) always references a specific
  immutable tag. Consumers get byte-identical binaries regardless of
  when they fetch.
- The releases page is a visible history of what shipped when.
- If we rebuild the set, we cut a new release; old releases remain
  valid for anyone pinned to them.

The ABI version appears in the tag name because a release is tied to
a specific kernel ABI. Programs from `binaries-abi-v2-*` cannot run
against a kernel on ABI 3 — the mismatch check refuses them.

## Layout of a release

Flat asset namespace. No per-category directories. legacy wasm/zip
entries (kernel, userspace, vfs-images, legacy programs) and
the system `.tar.zst` entries (libraries + the archive-shaped programs) sit
side-by-side in the same release; the manifest entry's
`archive_name` field is the per-entry discriminator.

```
binaries-abi-v4-2026-04-26 (release)
├── manifest.json                                     ← the contract
├── wasm_posix_kernel.wasm                            ← legacy (kernel)
├── wasm_posix_userspace.wasm                         ← legacy (userspace)
├── exec-caller.wasm                                  ← legacy (program)
├── fork-exec.wasm                                    ← legacy (program)
├── shell.vfs.zst                                     ← legacy (vfs-image)
├── zlib-1.3.1-rev1-wasm32-9acb9405.tar.zst           ← the system (library)
├── zlib-1.3.1-rev1-wasm64-b1773def.tar.zst           ← the system (library)
├── ncurses-6.5-rev1-wasm32-2a55c8e0.tar.zst          ← the system (library)
├── vim-9.1-rev1-wasm32-c4e2118a.tar.zst              ← the system (program)
└── …
```

the system archive filenames follow
`<name>-<version>-rev<N>-<arch>-<short-cache-key-sha>.tar.zst`,
where the short sha is the first 8 chars of the cache-key sha
for that manifest. Two archives with the same `(name, version,
revision, arch)` but different transitive deps get distinct
shas and thus distinct names.

### the system archive interior layout

Each `.tar.zst` carries exactly two top-level entries:

```
manifest.toml              ← source package.toml + injected [compatibility]
artifacts/                 ← cache-tree contents
    lib/libz.a
    include/zlib.h
    include/zconf.h
    lib/pkgconfig/zlib.pc
```

The consumer (`xtask install-release`, calling
`remote_fetch::fetch_and_install`) flattens `artifacts/*` to
the cache root after extraction. See
`docs/package-management.md` "Release archives" for the full
producer/consumer round-trip and the `[compatibility]` block.

## `manifest.json` schema

The full machine-readable schema lives at
[`abi/manifest.schema.json`](../abi/manifest.schema.json) and is
exercised by `xtask`'s test suite. The prose below tracks the
fields a reader most often needs.

```json
{
  "abi_version": 4,
  "release_tag": "binaries-abi-v4-2026-04-26",
  "generated_at": "2026-04-26T10:00:00Z",
  "generator": "cargo xtask build-manifest",
  "entries": [
    {
      "name": "wasm_posix_kernel.wasm",
      "kind": "kernel",
      "size": 407264,
      "sha256": "<hex>",
      "abi_version": 4
    },
    {
      "name": "exec-caller.wasm",
      "kind": "program",
      "size": 25075,
      "sha256": "<hex>",
      "abi_version": 4
    },
    {
      "name": "zlib-1.3.1-rev1-wasm32-9acb9405.tar.zst",
      "program": "zlib",
      "kind": "library",
      "arch": "wasm32",
      "upstream_version": "1.3.1",
      "revision": 1,
      "size": 89614,
      "sha256": "<bytes-sha>",
      "archive_name": "zlib-1.3.1-rev1-wasm32-9acb9405.tar.zst",
      "archive_sha256": "<bytes-sha>",
      "compatibility": {
        "target_arch": "wasm32",
        "abi_versions": [4],
        "cache_key_sha": "9acb9405ef818905a193…"
      },
      "source": {
        "url": "https://github.com/madler/zlib/releases/download/v1.3.1/zlib-1.3.1.tar.gz",
        "sha256": "9a93b2b7…"
      },
      "license": { "spdx": "Zlib" },
      "advisories": []
    }
  ]
}
```

Entries are sorted alphabetically by `name` across both legacy and
the system shapes. Keys within each entry and at the top level are
sorted too (BTreeMap on the generator side) so `shasum -a 256
manifest.json` is deterministic.

### Top-level fields

- **`abi_version`** — duplicated from the tag name, for cross-check.
  A fetcher that finds `abi_version` disagreeing with the tag must
  fail loudly; the version is load-bearing and drift between
  representation and tag is a bug.
- **`release_tag`** — the GitHub release tag the manifest came from.
- **`generated_at`** — ISO 8601 UTC timestamp, for provenance only.
  Not used for any correctness check; two runs of
  `build-manifest` produce different `generated_at` values.
- **`generator`** — tool+version that produced the manifest, for
  debugging mysterious format drift.
- **`entries`** — flat array, sorted by `name`.

### Per-entry fields

Common to legacy and the system entries:

- **`name`** — the asset filename in the release. Unique.
- **`kind`** — one of `"kernel"`, `"userspace"`, `"program"`,
  `"vfs-image"`, `"library"`. The first four are legacy shapes;
  `"library"` is the system. `"program"` covers both shapes —
  `archive_name` is the discriminator.
- **`size`** — byte count.
- **`sha256`** — lowercase hex SHA-256 of the asset bytes. Fetcher
  verifies every download.
- **`abi_version`** — for wasm binaries that export `__abi_version`,
  the integer value the export returns. Null for assets that don't
  carry the marker (VFS images, the system archives, legacy binaries).

the system entries (`kind: library`, plus `kind: program` whose
filename ends in `.tar.zst`) also carry:

- **`program`** — logical name (`"zlib"`, `"vim"`). Multiple
  archives can share a `program` value across arches.
- **`arch`** — `"wasm32"`, `"wasm64"`, or `"any"`. Set per
  archive on the system entries; absent on legacy wasm/zip assets.
- **`upstream_version`** / **`revision`** — verbatim from the
  source `package.toml`. `revision` bumps when the build changes
  without an upstream version bump.
- **`archive_name`** — filename of the `.tar.zst`. Identical to
  `name` for the system entries; `null` (or absent) on legacy entries. The
  consumer-side fetch dispatcher branches on this field — the system
  flows through `xtask install-release`, legacy flows through the
  existing `place`/`extract_flat_zip` shell paths.
- **`archive_sha256`** — SHA-256 of the archive bytes. Equal to
  `sha256` for the system entries; the field is repeated under the
  `archive_*` prefix for symmetry with the consumer-side
  `[binary]` block in `package.toml`.
- **`compatibility`** — required on the system entries; absent on legacy.
  Object with three required fields:
  - `target_arch` — `"wasm32"` or `"wasm64"`.
  - `abi_versions` — non-empty list of integers ≥ 1; the
    consumer's kernel `ABI_VERSION` must appear in this list.
  - `cache_key_sha` — 64-char lowercase hex; the strict
    equivalence check against the consumer's locally-recomputed
    cache-key sha.
- **`source`** — `{url, sha256}` pair pointing at the upstream
  tarball this archive was built from. `sha256` is the field on
  the system-generated manifests; legacy-vintage manifests carry a `ref`
  instead (a git tag or upstream version label).
- **`license`** — `{spdx, url?}` block, verbatim from
  `package.toml`.
- **`advisories`** — array of known security advisories
  against the asset. Empty array if none.

See `abi/manifest.schema.json` for the authoritative
JSON-Schema definitions, including the `[compatibility]` shape
and value patterns. The compatibility block's verification
chain is documented in
[`docs/package-management.md`](package-management.md)
under "Release archives".

## How a fetcher validates a release

`scripts/fetch-binaries.sh` is the entry point. It:

1. Reads `binaries.lock` (`{abi, release_tag, manifest_sha256}`).
2. Fetches `manifest.json` from the release; verifies its
   SHA-256 matches `binaries.lock.manifest_sha256`.
3. Cross-checks `manifest.abi_version === binaries.lock.abi` and
   `manifest.release_tag === binaries.lock.release_tag`.
4. **For the system entries** (those carrying `archive_name`),
   delegates to `cargo xtask install-release --manifest … --archive-base
   <release-url>`. `install-release` walks `remote_fetch` for
   each archive — verifying the archive bytes against
   `archive_sha256`, parsing the embedded `manifest.toml`,
   checking `target_arch` against the resolver arch, the
   consumer ABI against `abi_versions`, and the locally-recomputed
   cache-key sha against the archive's `cache_key_sha` — and
   installs each archive into `<cache>/{libs,programs}/<canonical>/`.
   Program archives also mirror to `local-binaries/programs/<name>/`.
5. **For legacy entries** (no `archive_name`), checks the
   content-addressed cache at
   `~/.cache/wasm-posix-kernel/abi-v<N>/objects/<sha256>.<ext>`,
   downloads any missing object, then symlinks/extracts into
   `binaries/`. The kernel/userspace/vfs-image flow is
   unchanged from legacy.

Any SHA-256 mismatch, version mismatch, missing compatibility
field, or `cache_key_sha` mismatch is a hard error — we never
fall back to "best effort." For the system archives the full
verification chain is documented in
[`docs/package-management.md`](package-management.md)
under "Release archives". The `cache_key_sha` mismatch is
soft-skippable for local development via `./run.sh
--allow-stale` (or `WASM_POSIX_ALLOW_STALE=1`) — see
"Iterating on a package locally" in the same doc. CI never
passes the flag.

### PR-staging overlay (`binaries.lock.pr`)

When a PR's CI publishes per-PR archives to `pr-<NNN>-staging`, it
also uploads a `binaries.lock.pr` overlay listing which packages
were rebuilt. `scripts/fetch-binaries.sh` reads this file
(gitignored, never committed) and merges it over `binaries.lock`:
override entries are fetched from the staging release, the rest
from the durable release. The overlay schema is
`{ staging_tag, staging_manifest_sha256, overrides }` — see
`docs/plans/2026-04-29-pr-package-builds-design.md` §3 for the
full schema.

## Producing a release

For now, manual. Eventually a GitHub Actions workflow
(`release-binaries.yml`) will automate every step.

1. Build all binaries fresh against the current `ABI_VERSION`
   (kernel via `bash build.sh`, programs via
   `scripts/build-programs.sh`, ported software via each
   `examples/libs/*/build-*.sh`).
2. Run `bash scripts/stage-release.sh --out release-staging --tag
   binaries-abi-v<N>-YYYY-MM-DD`. The `--tag` is mandatory and must
   match the GitHub release tag you intend to publish under — it is
   baked into the manifest's `release_tag` field, which
   `scripts/fetch-binaries.sh` compares to `binaries.lock` on the
   consumer side. The script handles both halves:
   - legacy entries (kernel, userspace, hand-bundled test programs)
     are staged via `xtask bundle-program --plain-wasm`.
   - the system entries (every `kind=library` and `kind=program`
     manifest in `examples/libs/`) are staged via `xtask
     stage-release`, which fans out across {wasm32, wasm64},
     calls `ensure_built` to populate the resolver cache as
     needed, packs each cache tree into a `.tar.zst` archive
     under `release-staging/{libs,programs}/`, and emits the
     combined `manifest.json`.
3. Run `bash scripts/publish-release.sh --tag
   binaries-abi-v<N>-YYYY-MM-DD --staging release-staging` to create
   the GitHub release and upload every staged asset (flat wasm,
   legacy zip bundles, and the system `.tar.zst` archives). The
   script asserts the staged manifest's `release_tag` matches `--tag`
   before uploading, so a stage/publish tag drift fails fast.
4. Commit the generated manifest into `abi/manifest.json` as the
   repo's reference copy. Follow-up changes to `binaries.lock` pin
   consumers to this release.

See `scripts/stage-release.sh` and `scripts/publish-release.sh`
for the current scripts.

## PR package builds

Replaces the previous manual two-PR release flow (PR bumps a
package + merges → maintainer manually runs stage/publish-release →
second PR bumps `binaries.lock`) with a single-PR flow driven by
three GitHub Actions workflows. Full design in
[`docs/plans/2026-04-29-pr-package-builds-design.md`](plans/2026-04-29-pr-package-builds-design.md).

### Workflows at a glance

| Workflow | Trigger | What it does |
|---|---|---|
| `staging-build.yml` | Every push to a same-repo PR | Stages packages whose `cache_key_sha` differs from the durable release; uploads to `pr-<NNN>-staging` pre-release; posts sticky comment. |
| `prepare-merge.yml` | `ready-to-ship` label applied | Builds against PR HEAD merged with tip-of-main; publishes a fresh `binaries-abi-v<N>-YYYY-MM-DD[-<seq>]` durable release; pushes lockfile bump to PR branch; enables squash auto-merge. |
| `force-rebuild.yml` | Manual `workflow_dispatch` | Source-builds named manifests (or all) bypassing the cache and `[binary]` archive_url; publishes a fresh durable release; optionally opens a lockfile-bump PR. |
| `staging-cleanup.yml` | PR closed + daily 08:00 UTC cron + manual dispatch | Deletes `pr-<NNN>-staging` releases when their PR closes; daily sweep catches orphans. |

### Author flow

1. Edit `examples/libs/<name>/package.toml` (bump version, swap source
   URL/sha) and any associated build script. Other code/test changes
   may go in the same PR.
2. Locally: `cargo xtask build-deps build <name>` — resolver
   source-builds the new version into the local cache. Tests pass.
3. **Do not** touch `binaries.lock` or `binaries.lock.pr`.
4. Open the PR. CI publishes the staging release automatically.

### Reviewer flow

1. Read PR diff: `package.toml` + code/test changes only. No lockfile
   churn.
2. Read the sticky `pr-staging-build` comment for the list of
   archives that were rebuilt.
3. Optional, to exercise locally:
   ```
   gh pr checkout <N>
   scripts/fetch-binaries.sh
   ```
   `fetch-binaries.sh` auto-detects the PR via the public GitHub API
   and downloads `binaries.lock.pr` from the staging release;
   override entries fetched from staging, the rest from the durable
   release.
4. Approve. Apply the `ready-to-ship` label.

### After auto-merge

`prepare-merge.yml` publishes the durable release, pushes a single
`chore(binaries): bump lockfile to <new-tag>` commit to the PR
branch, and enables squash auto-merge. The squash merge collapses
code + `package.toml` + lockfile bump into one main commit — main is
never in a state where the lockfile disagrees with the `package.toml`.

### Overlay file lifecycle (`binaries.lock.pr`)

Gitignored. Created by `staging-build.yml` and uploaded as an asset
on the staging release. Downloaded on demand by `fetch-binaries.sh`
when the local clone is checked out on a PR branch. Never committed.
Schema is `{staging_tag, staging_manifest_sha256, overrides}` —
overrides are package names, not archive filenames, so a version-
string bump in a same-PR push doesn't invalidate the overlay.

### Branch protection setup (one-time)

When deploying these workflows for the first time, the maintainer
must:

- Create the `ready-to-ship` label:
  ```
  gh label create ready-to-ship --color 0E8A16 \
    --description "Trigger prepare-merge.yml: build, publish durable release, push lockfile bump, auto-merge."
  ```
- Allow `github-actions[bot]` to push to PR branches via repository
  permissions. The lockfile bump pushes to PR branches, not main.
- **Enable repository auto-merge.** `prepare-merge.yml`'s final step
  calls `gh pr merge --auto --squash`, which the GitHub API rejects
  with `Auto merge is not allowed for this repository` if the repo
  setting is off.

  ```
  gh api --method PATCH "/repos/<owner>/<repo>" -F allow_auto_merge=true
  ```
- **Require ONLY the `merge-gate` status check on `main`** in branch
  protection. `prepare-merge.yml` posts `merge-gate=success` on the
  lockfile-bump commit only after a fresh durable release has been
  published. Without this required check, PRs could be merged
  without ever cutting a fresh durable release — the lockfile on
  main would be a step behind whatever `package.toml` says. Admins
  retain bypass via the standard branch-protection override (or
  "Allow specified actors to bypass required pull requests").

  Do **not** also require `staging-build`'s `build` check. The
  lockfile-bump commit that `prepare-merge.yml` pushes uses
  `GITHUB_TOKEN`, and pushes authored by `GITHUB_TOKEN` deliberately
  do not re-trigger workflows (GitHub's anti-recursion rule). So the
  `build` check never appears on the lockfile-bump commit, and a
  required `build` would block auto-merge forever. `merge-gate`
  alone is sufficient: prepare-merge runs every test suite that
  staging-build runs (and more) before posting it.

  To configure via the GitHub UI: Settings → Branches → branch
  protection rule for `main` → "Require status checks to pass" →
  set the required-checks list to `merge-gate` only.

  To configure via the API (idempotent):
  ```
  echo '{"strict":true,"contexts":["merge-gate"]}' | \
    gh api --method PATCH \
      -H "Accept: application/vnd.github+json" \
      --input - \
      "/repos/<owner>/<repo>/branches/main/protection/required_status_checks"
  ```

  (`-f strict=true` would send the value as a string, which the API
  rejects with `\"true\" is not a boolean`. Pipe a JSON body instead.)

### Fork PRs

Not supported in v1 — they fall back to the resolver's source-build
path locally. Two-stage `workflow_run` support is documented as
future work in §9.1 of the design doc.

### Manual force-rebuild

`force-rebuild.yml` is the escape hatch for the case where the
content-addressed resolver's view of "unchanged" is wrong. The
normal flow (`staging-build` + `prepare-merge`) only source-builds a
package when its `cache_key_sha` differs from the durable release.
That key hashes manifest contents, source URL+sha, declared
dependencies, target arch, and ABI version — but if a build script
behavior depends on something *outside* that hash (a sysroot quirk,
a host-tool version pin that wasn't bumped in `host_tools`, a glue
file change that should have invalidated everything but didn't),
unchanged-from-cache might still be incorrect.

Trigger via Actions → "Force rebuild" → "Run workflow". Inputs:

- **packages** — `all` (default) or comma-separated names
  (e.g. `php,mariadb`). Names match the `name = "..."` field in
  each `examples/libs/<dir>/package.toml`.
- **arches** — comma-separated subset of `wasm32,wasm64` (default:
  both). Manifests whose `target_arches` don't include a requested
  arch are silently skipped.
- **ref** — git ref to build from (default: `main`).
- **skip_tests** — when true, publishes without running the 5 test
  suites. Defaults to false. `workflow_dispatch` is maintainer-only,
  so this is treated as deliberate.
- **bump_lockfile** — when true (default), opens a PR bumping
  `binaries.lock` to the new release. Disable for diagnostic
  rebuilds where you only want to compare archives — the release is
  still published, but main isn't repointed to it.

Mechanics:

1. Tests run BEFORE publish (vs `prepare-merge.yml`'s
   publish-then-test ordering). Force-rebuild is the place to
   investigate suspected cache problems; we don't want orphaned
   releases scattered around when an investigation fails.
2. The lockfile-bump PR carries its own `merge-gate=success` status
   posted by this workflow. Its bump PR does NOT go through
   `prepare-merge.yml` — that would cut a second redundant durable
   release. Auto-merge picks it up after any other required checks.
3. Shares the durable-release lock with `prepare-merge.yml`, so
   force-rebuild and prepare-merge can't both publish a durable
   release at the same moment. The lock is a Git ref rather than a
   GitHub Actions concurrency group because Actions keeps only one
   pending run per group and cancels/replaces additional queued runs.

Use `--force-rebuild`/`--force-rebuild-all` directly with
`scripts/stage-release.sh` for a local rebuild without publishing.

### Post-upload integrity check

Both `scripts/publish-release.sh` and `scripts/publish-pr-staging.sh`
run `scripts/verify-release.sh --tag <tag>` after the upload step. The
check downloads every archive listed in `manifest.json` and confirms
its bytes hash to the manifest's `archive_sha256`. Catches drift
between manifest entries and the actual asset bytes — the kind of
inconsistency that bit `binaries-abi-v6-2026-04-29` (manifest
re-uploaded with new shas while archive bytes stayed old, surfaced as
`./run.sh browser` failures days later).

`verify-release.sh` is also runnable standalone for diagnosing an
existing release:

```
scripts/verify-release.sh --tag binaries-abi-v6-2026-04-29
```

### Reproducible toolchain via Nix

`staging-build.yml` and `prepare-merge.yml` install Nix on the
runner and execute every build/stage step via `nix develop --command`
against the repo's `flake.nix`. The flake pins LLVM 21, the Rust
toolchain (per `rust-toolchain.toml`), Node 22, and Erlang 28, so
runner-host drift can't leak into archive bytes — the same
`cache_key_sha` reproduces across CI and contributor laptops that
also use `nix develop`. Cache hits across workflow runs come from
`DeterminateSystems/magic-nix-cache-action`.
