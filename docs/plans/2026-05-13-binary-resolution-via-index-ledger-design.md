# Binary Resolution via Index Ledger — Design

Date: 2026-05-13
Branch: `design/binary-resolution-via-index-ledger`

## §1. Context & goals

The package management system stores archive URLs in two places that aren't transactionally linked: per-package `examples/libs/<name>/package.toml`'s `[binary.<arch>]` block, and the GitHub release that physically hosts the `.tar.zst` archives. The CI job `amend-package-toml` keeps the first in sync with the second. When that wiring fails, `main` ships in a broken state.

Four bugs in two weeks were variations on this theme:

| PR | Failure |
|---|---|
| #454 | `publish.if` skip-cascade when one matrix wave is empty → publish ran but only by accident in some configurations. |
| #455 | Same `success()` implicit-gate bug one DAG layer deeper → `generate-index` / `amend-package-toml` / `merge-gate-finalize` cascade-skipped after publish succeeded. |
| #456 | `merge-gate-empty-matrix` granted merge when preflight saw archives present on `target_tag`, without checking that `package.toml` URLs *referenced* `target_tag`. |
| #439 fallout | ABI 7→8 bump merged with every `package.toml` still pointing at `binaries-abi-v7`; `binaries-abi-v8` had been pre-populated by an abandoned earlier run, so preflight emitted empty matrices and `amend-package-toml` never ran. `main` was broken for ~36 hours. |

The 2026-05-05 decoupled-package-builds design (§3.1) explicitly considered moving `[binary]` out of `package.toml` and rejected it on the rationale "the resolver fetches with `package.toml` alone, no round-trip to a catalog." The note ends "revisit when auto-update lands." We aren't waiting for auto-update — the CI-managed sync has been buggy enough to cost us four PRs, and one of those left `main` unbuildable. Time to revisit.

### Goals

1. **Eliminate the dual-storage bug class structurally.** The fix should make the bugs impossible to reintroduce, not merely catch them earlier.
2. **Make `package.toml` a pure package manifest.** What the package IS — name, version, recipe, license, dependencies, upstream source pin. Nothing about how a particular project happens to build or publish it.
3. **Make `index.toml` the source of truth for binary resolution state.** Per-package, per-arch, with explicit `status` instead of inferred-from-archive-presence.
4. **Support gradual rebuilds of large package repositories.** Bumping ABI on a third-party repo with hundreds of packages should be observable as it progresses, with per-package state visible in the index.
5. **Treat first-party and third-party packages symmetrically.** A third-party `package.toml` + `build.toml` drops into `examples/libs/<their-pkg>/` with zero special-casing in the resolver.
6. **Support partial publish + last-green fallback.** When a package fails its current rebuild, its index entry keeps the previous good archive's URL so consumers degrade gracefully.

### Non-goals

- **Auto-update.** The resolver does not poll for new versions of packages. Consumers explicitly choose what version they depend on.
- **Package signing.** Trust remains rooted in `archive_sha256` + HTTPS. Deferred as in the original design.
- **`wasm-posix-pkg` CLI tooling** (`sources add`, `search`, `add`). The schema and resolver are this design's scope; tooling is a separate effort.
- **Multi-source resolution.** A `build.toml`'s `[binary]` block names one source. Falling through to a different source when the first lacks the package is out of scope v1.

## §2. Architecture overview

```
┌──────────────────────────────────────────────────────────────────┐
│ Repo source tree (committed to git)                              │
│                                                                  │
│   .wasm-posix-pkg.toml                ← named source definitions │
│   examples/libs/<pkg>/                                           │
│     package.toml                      ← recipe (what the pkg IS) │
│     build.toml                        ← project's build + binary │
│                                         source declaration       │
│     build-<pkg>.sh                                               │
└────────────────────────┬─────────────────────────────────────────┘
                         │
                         │ resolver reads package.toml + build.toml
                         │
                         ▼
┌──────────────────────────────────────────────────────────────────┐
│ Resolver (xtask build-deps)                                      │
│                                                                  │
│   1. Read build.toml → [binary] source/index_url/url             │
│   2. Fetch index.toml from source (cache at ~/.cache/...)        │
│   3. Look up (name, version) → per-arch entry                    │
│   4. If status=success → fetch archive_url                       │
│      If status=failed && fallback present → fetch fallback       │
│      Else → source-build fallback                                │
│   5. Verify cache_key_sha inside archive matches local           │
└────────────────────────┬─────────────────────────────────────────┘
                         │
                         │ HTTP fetch via index → archive URL
                         │
                         ▼
┌──────────────────────────────────────────────────────────────────┐
│ Source / package repository (GitHub release)                     │
│                                                                  │
│   binaries-abi-v8/                                               │
│     index.toml                        ← LEDGER of build state    │
│     <pkg-A>-<ver>-rev<R>-abi<N>-wasm32-<sha>.tar.zst             │
│     <pkg-A>-<ver>-rev<R>-abi<N>-wasm64-<sha>.tar.zst             │
│     <pkg-B>-<ver>-rev<R>-abi<N>-wasm32-<sha>.tar.zst             │
│     ...                                                          │
└──────────────────────────────────────────────────────────────────┘
```

**Conceptual split:**

- `package.toml`: timeless, project-agnostic recipe. Same content across any project that defines this package.
- `build.toml`: this project's view of how to build + where to publish the package. Differs per project.
- `index.toml`: the registry's authoritative state record. Single source of truth for binary resolution. Updated atomically by CI via a workflow-level lock.

**Lifecycle of an archive:**

1. CI matrix-build job runs for `(package, arch)`. Builds archive locally.
2. Job acquires `state-lock binaries-abi-v<N>` (git-ref-based mutex, parameterized per target tag).
3. Job uploads archive to GitHub release.
4. Job downloads current `index.toml`, mutates this package's `(name, version, arch)` entry to `status = success` + the new archive's URL/sha/cache_key, re-uploads.
5. Job releases the lock.
6. Other matrix-build jobs serialize through the same lock for their own updates.

No separate `amend-package-toml` job. No separate `generate-index` job. The state-lock makes per-package atomic publish-and-update possible, and the resolver always sees a consistent `index.toml`.

## §3. Schema

### §3.1 `package.toml` — package recipe

```toml
name        = "mariadb"
version     = "10.5.28"
kernel_abi  = 7                          # minimum kernel ABI required
arches      = ["wasm32", "wasm64"]       # arches the recipe supports

depends_on  = ["pcre2-source@10.44"]

[source]                                 # upstream tarball pin
url    = "https://archive.mariadb.org/mariadb-10.5.28/source/mariadb-10.5.28.tar.gz"
sha256 = "0b5070..."

[license]
spdx = "GPL-2.0-or-later"
url  = "https://mariadb.com/kb/library-license/"

[build]                                  # recipe-level: how the package thinks it should be built
script_path = "examples/libs/mariadb/build-mariadb.sh"
```

**Removed fields vs. today's `package.toml`:**

- `revision` — moved to `index.toml`; a publish-time counter assigned by the registry, not a per-package property.
- `[binary.<arch>]` block (including `archive_url` and `archive_sha256`) — moved out of `package.toml` entirely.
- `[build].repo_url` — moved to `build.toml`; "where the recipe lives" is a project concern.
- `[build].commit` — moved to `build.toml`; "which commit built this archive" is a project concern.

**Why these are in the recipe:**

- `name`, `version`, `kernel_abi`, `arches`, `depends_on`, `[source]`, `[license]`: identity and constraints of the package, project-agnostic.
- `[build].script_path`: the package's recommended recipe. A consumer cloning a third-party `package.toml` learns where its build script lives.

### §3.2 `build.toml` — project's build + binary source declaration

```toml
# examples/libs/mariadb/build.toml — committed in THIS project
# Records what THIS project built and where it publishes.

script_path = "examples/libs/mariadb/build-mariadb.sh"   # what this project actually ran
repo_url    = "https://github.com/wasm-posix-kernel/wasm-posix-kernel.git"
commit      = "691b02ef9..."                              # commit at last successful build

# Where this project publishes the binary. Required. No defaults.
[binary]
source = "first-party"
```

`script_path` typically equals `package.toml`'s `[build].script_path`. A project that monkey-patches a recipe has its own `script_path` overriding. Redundancy is intentional: `package.toml` says what the recipe is; `build.toml` says what the project ran.

`[binary]` is required — every `build.toml` must explicitly declare where its binary lives. No inheritance, no defaults. First-party and third-party packages express their binary source identically; the file structure makes "where does this binary come from" answerable by reading one file.

`[binary]` has exactly one of three forms:

```toml
# Form 1 — named source. Definition lives in .wasm-posix-pkg.toml.
[binary]
source = "first-party"
```

```toml
# Form 2 — inline source URL. Self-contained; no .wasm-posix-pkg.toml entry needed.
[binary]
index_url = "https://other-host.example/releases/download/binaries-v{abi}/index.toml"
```

```toml
# Form 3 — direct archive URL. Bypass index lookup entirely; one specific archive.
[binary]
url    = "https://some-host.example/path/to/archive.tar.zst"
sha256 = "..."
```

Forms 1 and 2 fetch via index lookup. Form 3 is a one-off — useful for legacy archives that don't live in an indexed source, or for testing.

### §3.3 `.wasm-posix-pkg.toml` — repo-root named source definitions

```toml
# Repo root. Pure DRY mechanism for build.toml [binary] source = "<name>".

[sources.first-party]
index_url = "https://github.com/wasm-posix-kernel/wasm-posix-kernel/releases/download/binaries-abi-v{abi}/index.toml"

[sources.fun-pack]
index_url = "https://github.com/funpack/funpack/releases/download/binaries-v{abi}/index.toml"
```

`{abi}` is substituted with the current `ABI_VERSION` from `crates/shared/src/lib.rs` at resolve time.

The file is **optional**. A project that only uses Form 2 / Form 3 in `build.toml` doesn't need this file. It exists purely to factor common index URLs out of N `build.toml` files into one place.

A fork that wants to redirect first-party binaries to its own org edits one line here. Forks that only *consume* upstream binaries change nothing.

### §3.4 `index.toml` — ledger of build state

The single source of truth for binary resolution. Lives at the source's `index_url` (typically a GitHub release asset). Updated atomically by CI via a workflow-level state-lock.

```toml
abi_version  = 8
generated_at = "2026-05-13T..."             # last mutation timestamp
generator    = "wasm-posix-kernel CI @ 691b02ef9"

[[packages]]
name     = "mariadb"
version  = "10.5.28"
revision = 1

# wasm32 succeeded.
[packages.binary.wasm32]
status         = "success"
archive_url    = "mariadb-10.5.28-rev1-abi8-wasm32-a1180336.tar.zst"
archive_sha256 = "8ab959abfde98..."
cache_key_sha  = "a1180336deadbeefcafebabe..."
built_at       = "2026-05-13T..."
built_by       = "https://github.com/.../actions/runs/<id>"   # provenance

# wasm64 failed in this rebuild but a previous good build is preserved.
[packages.binary.wasm64]
status         = "failed"
error          = "linker: libc++abi missing for wasm64 toolchain"
last_attempt   = "2026-05-13T..."
last_attempt_by = "https://github.com/.../actions/runs/<id>"

# Last-green fallback: the previous successful build, preserved across the failed rebuild.
fallback_archive_url    = "mariadb-10.5.28-rev1-abi8-wasm64-87766332.tar.zst"
fallback_archive_sha256 = "..."
fallback_cache_key_sha  = "87766332..."
fallback_built_at       = "2026-05-12T..."
```

**Per-arch `status` values:**

| Value | Meaning | Resolver behavior |
|---|---|---|
| `pending` | Queued for rebuild; no current archive | Use `fallback_*` if present; else source-build |
| `building` | Build in progress | Use `fallback_*` if present; else source-build |
| `success` | Latest rebuild succeeded; `archive_url`/`sha`/`cache_key` are current | Fetch `archive_url`, verify, install |
| `failed` | Latest rebuild failed; `error` describes why | Use `fallback_*` if present; else source-build |

**Last-green fallback semantics:**

- When a successful build completes, its archive URL/sha/cache_key become the current `archive_url`/`archive_sha256`/`cache_key_sha`.
- When a subsequent rebuild for the same `(name, version, arch)` succeeds, the previous current values are **overwritten** — there's no need to retain them since the new build supersedes them.
- When a subsequent rebuild fails, the index entry transitions to `status = failed`, the previous current values are **moved into the `fallback_*` fields**, and the resolver continues using them. The next successful rebuild for that entry overwrites `archive_url` and clears `fallback_*`.

This preserves the property that consumers always have *some* working archive (modulo first-ever publish failures), without storing unbounded history.

**Filename format unchanged** from today: `<name>-<version>-rev<R>-abi<N>-<arch>-<sha8>.tar.zst`. The `rev<R>` slot stays for human-browsability of the release page. The resolver does not parse the filename; it reads `archive_url` from the index verbatim.

## §4. Resolver flow

Pseudocode for resolving one `(package, arch)`:

```
resolve(package_name, version, arch):
    pkg = read_package_toml(examples/libs/<package_name>/package.toml)
    build = read_build_toml(examples/libs/<package_name>/build.toml)

    index = load_index(build.binary)         # See "Loading an index" below
    if index is None:
        return source_build()                # No source configured or fetch failed offline

    entry = index.lookup(package_name, version, arch)
    if entry is None:
        return source_build()                # Package not in this source

    if entry.status == "success":
        archive = fetch(index.base_url + entry.archive_url)
        verify_sha256(archive, entry.archive_sha256)
        verify_cache_key(archive, local_cache_key_sha)
        return install(archive)

    if entry.status in ("failed", "pending", "building") and entry.fallback_archive_url:
        archive = fetch(index.base_url + entry.fallback_archive_url)
        verify_sha256(archive, entry.fallback_archive_sha256)
        verify_cache_key(archive, local_cache_key_sha)
        return install(archive)

    return source_build()
```

`load_index(binary)`:

```
load_index(binary):
    if binary is Form 3 (direct URL):
        return DirectIndex(binary.url, binary.sha256)   # synthetic single-entry index

    if binary is Form 1 (named source):
        defs = read_pkg_config(repo_root/.wasm-posix-pkg.toml)
        index_url = defs[binary.source].index_url
    else:  # Form 2 inline
        index_url = binary.index_url

    index_url = substitute(index_url, abi=ABI_VERSION)

    cache_path = ~/.cache/wasm-posix-kernel/index-<sha8(index_url)>.toml
    if online:
        try:
            content = http_get(index_url)
            write_atomic(cache_path, content)
            return parse(content)
        except FetchError:
            pass  # fall through to cache

    if cache_path exists:
        return parse(read(cache_path))

    return None    # neither online nor cached
```

**Offline behavior:** the resolver caches `index.toml` at `~/.cache/wasm-posix-kernel/index-<sha8(index_url)>.toml` on every successful online fetch. When `WASM_POSIX_OFFLINE=1` is set (or HTTP fetch fails), the cached copy is used. Fresh clones with no cache require one online resolve before offline works — same property the archive cache has today.

**Verification:** every archive download is verified two ways:

1. `archive_sha256` matches what the index says (catches transport corruption / asset replacement).
2. The archive's internal `cache_key_sha` (recorded inside the `.tar.zst`) matches the resolver's locally-computed `cache_key_sha` (catches "wrong archive for this source state" — e.g., archive built against a different `[source]` sha or a different build script).

A mismatch on either step falls through to source build.

## §5. CI / publishing

### §5.1 Per-package matrix-build with atomic index update

Today's `prepare-merge.yml` has separate `matrix-build`, `publish`, `generate-index`, and `amend-package-toml` jobs. With the new design, the last three collapse: every per-package matrix-build job becomes responsible for both publishing its archive AND updating `index.toml`.

Job steps per matrix entry `(package, arch)`:

```yaml
- name: Build archive
  run: bash scripts/dev-shell.sh bash -c '
    cargo run -p xtask -- archive-stage \
      --package "examples/libs/${{ matrix.package }}" \
      --arch "${{ matrix.arch }}" \
      --out "$RUNNER_TEMP/staged" \
      --build-timestamp "${{ steps.provenance.outputs.build-timestamp }}"
  '

- name: Acquire state-lock for target tag
  run: bash .github/scripts/state-lock.sh acquire ${{ needs.preflight.outputs.target_tag }}
  env:
    STATE_LOCK_POLL_SECONDS: 2   # tight poll: per-job updates are sub-second

- name: Upload archive to release
  run: |
    gh release upload "${{ needs.preflight.outputs.target_tag }}" \
      "$RUNNER_TEMP/staged/${ARCHIVE_NAME}" --clobber

- name: Update index.toml entry
  run: |
    bash .github/scripts/index-update.sh \
      --target-tag "${{ needs.preflight.outputs.target_tag }}" \
      --package "${{ matrix.package }}" \
      --version "${{ matrix.version }}" \
      --arch "${{ matrix.arch }}" \
      --status success \
      --archive-name "${ARCHIVE_NAME}" \
      --cache-key-sha "${{ matrix.sha }}"

- name: Release state-lock
  if: always()
  run: bash .github/scripts/state-lock.sh release

- name: Record failure (if build failed)
  if: failure()
  run: |
    bash .github/scripts/state-lock.sh acquire ${{ needs.preflight.outputs.target_tag }}
    bash .github/scripts/index-update.sh \
      --target-tag "${{ needs.preflight.outputs.target_tag }}" \
      --package "${{ matrix.package }}" \
      --version "${{ matrix.version }}" \
      --arch "${{ matrix.arch }}" \
      --status failed \
      --error "$(tail -c 4000 build.log)"
    bash .github/scripts/state-lock.sh release
```

**Atomicity:** if the build succeeds, upload-archive and update-index both happen inside the same locked region. The index only reports `status = success` for archives that physically exist on the release.

**Last-green preservation:** `index-update.sh --status success` overwrites the entry's current `archive_url` / `archive_sha256` / `cache_key_sha` / `built_at` / `built_by` and clears any `fallback_*` fields. `--status failed` reads the current `archive_url` / etc., moves them into `fallback_*` if not already present, then updates `status` / `error` / `last_attempt`.

**Per-arch matrix entries operate independently.** Matrix entries for `(mariadb, wasm32)` and `(mariadb, wasm64)` each acquire the lock, update their respective `[packages.binary.<arch>]` block, and release. They do not interfere with each other's per-arch state.

### §5.2 `state-lock.sh` — generalized durable-release-lock

Generalize the existing `.github/scripts/durable-release-lock.sh` to accept the lock subject as a parameter:

```bash
bash .github/scripts/state-lock.sh acquire <subject>
bash .github/scripts/state-lock.sh release
```

`<subject>` becomes part of the lock ref name. For the durable release publish flow today, `<subject>` is `durable-release` (matching today's ref `refs/heads/github-actions/durable-release-lock`). For per-target-tag index updates, `<subject>` is the target tag, e.g., `binaries-abi-v8`. Different tags use different lock refs, so an in-flight rebuild for `binaries-abi-v8` doesn't block one for `binaries-abi-v9` (e.g., during an ABI bump that targets both).

Implementation: the existing script is already 90% parameterized — its ref name lives in `DURABLE_RELEASE_LOCK_REF`. We rename to `STATE_LOCK_REF`, expose `<subject>` as a positional arg, and default it to `durable-release` for the existing call sites' continuity. Existing stale-detection (run-ID-based + time fallback) carries over verbatim.

### §5.3 No more `amend-package-toml` job

Deleted from `prepare-merge.yml`, `staging-build.yml`, and `force-rebuild.yml`. The per-package matrix-build job now does everything atomically. The bot-PR shape (where `amend-package-toml` opens a PR amending `package.toml` URLs, and `merge-gate-finalize` auto-merges it) goes away entirely: there's nothing to amend.

**Merge-gate posting:** without a bot PR, `merge-gate=success` is posted directly on the original PR's HEAD SHA. The existing `merge-gate-empty-matrix` job becomes the *only* path that posts merge-gate — it now fires unconditionally (not gated on empty matrices) when test-gate has passed. Auto-merge enables on the original PR.

This drops a large amount of workflow logic (~200 lines of YAML between the three workflows) and removes the entire bot-PR mechanism. Workflow changes still require manual merge due to OAuth `workflow` scope, same as today.

### §5.4 `check-package-toml-tags.sh` deleted

The CI guard added in #456 catches `package.toml` URLs pointing at a different tag than `target_tag`. With `[binary]` removed from `package.toml`, there are no URLs in `package.toml` to drift, and the guard has nothing to check. Delete the script and its invocations from `prepare-merge.yml`.

## §6. Migration

One PR, end-to-end. The atomicity matters because every component — resolver code, schema, all 53 packages, workflows, the new lock subject — is interdependent. A staged migration would require dual-path resolver code for the transition, which is more risk and more cleanup than the direct cutover.

### Migration steps in the single PR

1. **Add `state-lock.sh`** by generalizing `durable-release-lock.sh`. Keep backward-compatibility env vars so existing call sites continue to work.

2. **Update `xtask` schema parsers:**
   - `pkg_manifest.rs`: drop `archive_url`, `archive_sha256`, `revision` from the `package.toml` parser. Add a new `BuildToml` parser. Add `WasmPkgConfig` parser for `.wasm-posix-pkg.toml`. Drop `[build].repo_url` and `[build].commit` from `package.toml`'s `[build]`.
   - `build_deps.rs`: update `cmd_resolve` to load `build.toml` alongside `package.toml`, fetch the index, look up the entry, dispatch to fetch or fallback.
   - `remote_fetch.rs`: update to consume `IndexEntry` (with `status`, `fallback_*`) instead of a raw `[binary]` block.
   - `build_index.rs`: rewrite to produce the new `index.toml` schema with `status` and `fallback_*` fields.

3. **Add `scripts/index-update.sh`** — wrapper around `xtask index-update <args>` (new xtask subcommand) that handles the lock acquisition, download/mutate/upload sequence, and lock release.

4. **Add `.wasm-posix-pkg.toml`** at repo root with one named source: `first-party` pointing at `https://github.com/wasm-posix-kernel/wasm-posix-kernel/releases/download/binaries-abi-v{abi}/index.toml`.

5. **Migrate every `examples/libs/<pkg>/package.toml`:**
   - Strip `revision`, `[binary.<arch>]` blocks, `[build].repo_url`, `[build].commit`.
   - Keep everything else verbatim.

6. **Create `examples/libs/<pkg>/build.toml` for every package:**
   - Copy `[build].script_path` from the old `package.toml`.
   - Set `repo_url` = upstream.
   - Set `commit` = current main HEAD at PR creation.
   - Add `[binary] source = "first-party"`.

7. **Compose and upload the initial `index.toml`** for `binaries-abi-v8`: list every currently-published archive in the new format, with `status = success` for each. The release already has 68 archives; this one-shot composition seeds the ledger. CI doesn't need to do this; a `bash scripts/compose-initial-index.sh binaries-abi-v8` script run from a maintainer's machine is sufficient (the PR doesn't need to re-publish anything).

8. **Update workflows:**
   - `prepare-merge.yml`: delete `publish`, `generate-index`, `amend-package-toml`, `merge-gate-finalize` jobs. Fold archive upload + index update into `matrix-build`. `merge-gate-empty-matrix` fires unconditionally on test-gate success (rename it to `merge-gate-post`).
   - `staging-build.yml`: same shape change, plus `pr-<N>-staging` is its target tag (no durable release lock contention since different tag).
   - `force-rebuild.yml`: same shape change.

9. **Delete `scripts/check-package-toml-tags.sh`** and all invocations.

10. **Update docs:**
    - `docs/architecture.md`: describe the index-lookup resolver flow.
    - `docs/plans/2026-05-05-decoupled-package-builds-design.md`: mark §3.1's "kept duplication for resolver-fetches-with-package.toml-alone" as superseded by this design.
    - `docs/posix-status.md` / `docs/sdk-guide.md`: only touched if they reference the old `[binary]` block in `package.toml`.

### Verification

Big-bang requires careful end-to-end verification before merge:

- **xtask test suite passes** (`cargo test -p xtask`).
- **Resolver test suite passes**, including new tests for `build.toml` parsing, `.wasm-posix-pkg.toml`, index lookup, fallback behavior, offline cache.
- **Clean fetch test on a fresh cache**: `rm -rf ~/.cache/wasm-posix-kernel && bash scripts/fetch-binaries.sh` reports `resolved=63 total=63 skipped=6, 0 failures`. Same target as PR #456's verification.
- **Browser demo end-to-end**: `./run.sh clean all && bash scripts/build-musl.sh && bash build.sh && ./run.sh browser` succeeds on a clean machine.
- **CI dry-run on a synthetic package**: trigger a force-rebuild for one small package (e.g., `bc`) on a test branch; confirm the per-matrix-entry upload + index update + lock acquire/release lifecycle works.

## §7. Open questions / future work

- **Index update batching for huge repos.** For 100+ package rebuilds, serial lock acquisition is acceptable (~5s per update × 100 = ~10min serialized portion). If it becomes painful, we could batch updates: matrix-build jobs write per-package state to workflow artifacts, a single coordinator at workflow end takes the lock once and folds them into `index.toml`. Not needed v1 given staggered job completion times.
- **Multi-source resolution.** If a `build.toml` says `source = "first-party"` and the index doesn't have the package, today we fall through to source build. A future enhancement could try a list of fallback sources before source-building. Out of scope v1.
- **Index TTL / staleness for offline cache.** Currently we always refresh online and fall back to whatever cache exists offline. A future enhancement could surface "your cached index is N days old" warnings. Out of scope v1.
- **Signing.** `archive_sha256` in the index is the trust root today. A signed index (or signed archives) is a future hardening. Deferred per the original design.
- **Cleanup of fallback archives.** When a `fallback_archive_url` archive is no longer current AND its replacement has been successful for a long time, we could prune it from the release. Storage is cheap; defer indefinitely.
- **`wasm-posix-pkg` CLI tooling.** The schema supports the design doc's `sources add` / `search` / `add` commands. Implementation is a separate effort.

## §8. Risk register

| Risk | Mitigation |
|---|---|
| Lock-script bug causes a wedged lock during a rebuild | Existing stale-detection in `durable-release-lock.sh` (run-ID-based + 6h time fallback) carries over. Test the per-target-tag parameterization explicitly. |
| Initial `index.toml` composition mis-seeds state on first publish | Run the compose script against a test branch first; verify output before uploading to the real release. Ship the compose script as `scripts/compose-initial-index.sh` so it's auditable. |
| Resolver caches an `index.toml` that becomes stale and the user is offline | Cache invalidation is on every online fetch. Offline + stale cache fall back to source build. Same property as today. |
| Big-bang migration breaks `main` if anything is wrong | Pre-merge verification covers cargo tests, vitest, libc-test, POSIX tests, clean-fetch test, browser demo. All five must pass before merge. |
| `build.toml` lacks a `[binary]` block (forgotten) | xtask parser fails loud with "build.toml at <path> has no [binary] block". CI tests for every package's `build.toml` parses cleanly. |
| Forks that republish to their own org have 53 files to edit | One-shot `xtask retarget-binaries --source <name>` script bulk-edits all `build.toml`s. Cost is bounded; forks doing this is rare. |

## §9. Summary

Move binary URL resolution from `package.toml` to a CI-managed `index.toml` ledger. Split `package.toml` (recipe) from `build.toml` (project view). Serialize index updates via a workflow-level state-lock built on the existing `durable-release-lock.sh` pattern. Eliminate `amend-package-toml`, `generate-index`, and `check-package-toml-tags.sh`. Treat first-party and third-party packages symmetrically.

The bug class — stored URLs drifting from published archives — is structurally impossible after this lands: there are no stored URLs in the source tree to drift. The index is the single source of truth, updated atomically by CI, with explicit per-package state for resolver and humans alike.
