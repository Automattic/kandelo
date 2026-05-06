# Wasm Package Management — Future Work

Forward-looking list of items deferred from the package management
system as it stands today. The system is described in
`docs/package-management.md`; this file is the home for what's still
on the table.

Some items are blocked on real demand (e.g., semver ranges, multi-arch
fat archives); some are purely additive polish (`--gc`, `--format=json`).
None is on a committed schedule — pick up when the use case arrives.

## Schema / artifact

### Ship kernel.wasm + userspace.wasm in the release

Today's release excludes the kernel + userspace because their
manifests at `examples/libs/{kernel,userspace}/` lack build scripts —
`stage_release` skips manifests without a build script as composite
metadata. The browser demos import `binaries/kernel.wasm` and
`binaries/userspace.wasm` (≈23 sites) at Vite build time; without
those files Vite errors out unless the user has run `bash build.sh`
locally to populate `local-binaries/`.

Fix options:
1. **Add build wrappers** at `examples/libs/{kernel,userspace}/build-*.sh`
   that delegate to the `cargo build --release -p wasm-posix-{kernel,userspace}`
   pipeline already in `build.sh`. Manifest output names already match
   the cargo artifact paths. Once added, they ship as regular
   archives. Caveat: kernel.wasm changes with every kernel commit, so
   the cache_key_sha churns; users who want a stable kernel should
   pin to a specific commit / release tag. The local-binaries/
   override path remains the developer's escape hatch.
2. **Update demo imports** to use `local-binaries/...` paths and add
   a doc step ("run `bash build.sh` first"). Diverges from the
   priority-1/priority-2 resolver convention; doesn't help users
   without a Rust toolchain.

Option 1 is the cleaner long-term fix. Triggers when a fresh-clone
without-toolchain workflow becomes a real use case.

### Lazy-archive VFS support for `.tar.zst`

The system ships archives as `.tar.zst` uniformly.  That works for the
resolver path (xtask decompresses to disk on install), but it
**doesn't work for browser-demo lazy archives**.

Today `host/src/vfs/zip.ts` registers `vim.zip` as a lazy archive in
`shell.vfs` with mount prefix `/usr/`: the ZIP's central directory is
read up front, then individual entries are decompressed on demand
when the user touches `/usr/bin/vim` or `/usr/share/vim/vim91/...`.
The pattern only works for `.zip` because per-entry deflate gives
random access; `.tar.zst` is a monolithic compressed stream with no
per-entry seek.

**Today's workaround** (acceptable for now): the browser demo repacks
a separate `vim.zip` via `examples/browser/scripts/build-vim-zip.sh`
that includes vim.wasm + the runtime tree. The release ships
`vim-9.1.0900-...tar.zst` containing only `vim.wasm`. Two parallel
formats coexist; nothing in the release is consumed directly by
the lazy-mount VFS.

**Future work — two options:**

1. **`.tar.zst` lazy-archive reader.** Decompress the whole tar.zst
   once on first access, hold the uncompressed image in memory or
   cache it on disk under `binaries/objects/<sha>.tar` (fetch-binaries
   already does this for `.zip`). Then index the tar's entry headers
   for "lazy" reads.  Net cost: full decompression latency on first
   touch (vs. ZIP's per-entry latency), but consistent format across
   the whole release.

2. **Mixed formats in the release.** Extend `xtask::archive_stage`
   to take an `archive_format` per manifest (default `.tar.zst`,
   programs that need lazy-mount specify `.zip`).  `install_release`
   decompressors handle both. Vim ships as `.zip` directly; demos
   skip the repack step.  Schema doesn't need a new field — the
   filename extension is the format hint.

Trigger: when a real consumer wants to fetch a published archive +
lazy-mount its runtime tree without an intermediate repack step.
Most likely vim or texlive (huge runtime/font trees).

### Cross-package source-tree reads (mariadb-install pattern)

Three browser VFS-image scripts read from a sibling package's local
source-build tree rather than via the resolver
(`cargo xtask build-deps resolve <name>` → cache canonical dir):

- `examples/browser/scripts/build-mariadb-vfs-image.ts` (consumed
  by `mariadb-vfs`) reads
  `examples/libs/mariadb/mariadb-install{,-64}/{bin/mariadbd.wasm,
  share/mysql/mysql_system_tables{,_data}.sql}`.
- `examples/browser/scripts/build-mariadb-test-vfs-image.ts`
  (consumed by `mariadb-test`) additionally reads
  `examples/libs/mariadb/mariadb-install/mysql-test/`.
- `examples/browser/scripts/build-lamp-vfs-image.ts` (consumed by
  `lamp`) reads the same SQL files as mariadb-vfs.

The mariadb v6/v7 release archive only ships
`{mariadbd,mysqltest}.wasm` at the artifact root. The SQL files
(~2 MB) and `mysql-test/` (~217 MB uncompressed) aren't bundled.
So when mariadb is *cache-hit* (archive installed without
source-build), `examples/libs/mariadb/mariadb-install/` is empty
and any of these three downstream scripts fails on its first
`readFileSync` / `existsSync`.

The bug doesn't fire on routine staging-build CI today because
none of mariadb-vfs / mariadb-test / lamp's `cache_key_sha`
changes in typical PRs, so the resolver doesn't trigger their
source-build. It *does* fire on `force-rebuild` flows and any
future PR whose changes cascade into one of those packages' dep
graphs (cf. PR #410, where merging main brought nethack rev2 +
fbdoom rev2 in and cascaded into shell — exactly the same shape
of bug, just on a different consumer).

PR #410's shell fix is the symmetric template:

1. `examples/libs/mariadb/build-mariadb.sh` — stage
   `share/mysql/` into `$WASM_POSIX_DEP_OUT_DIR/share/mysql/`
   (same pattern build-vim.sh uses for `runtime/`).
2. `examples/libs/mariadb/package.toml` — add `[[outputs]]` entries
   for `share/mysql/mysql_system_tables.sql` +
   `mysql_system_tables_data.sql` so the v7 archive is treated
   as stale (`compatibility.cache_key_sha` mismatch) and the
   resolver source-rebuilds mariadb, picking up the new stage
   step. Cache key cascades to mariadb-vfs, mariadb-test, lamp —
   all source-rebuild on the next staging-build for any PR that
   touches them.
3. `build-{mariadb-vfs,mariadb-test,lamp}-vfs-image.ts` — call
   `cargo xtask build-deps resolve mariadb` and read
   `<cache-dir>/{bin,share}/...`, falling back to
   `examples/libs/mariadb/mariadb-install/` for direct
   invocations (mirroring build-{vim,nethack}-zip.sh).

`mysql-test/` (~217 MB) is the awkward part — 50–80 MB zstd'd
inside mariadb's archive isn't great. Options:

- **Bundle it in mariadb's archive anyway.** Smallest diff;
  affects every release.
- **Split into a separate `mariadb-test-data` package.** Its
  build script extracts the relevant `mysql-test/{main,include,
  std_data,suite}` subdirs from mariadb's already-fetched source
  tarball. mariadb-test depends on `mariadb-test-data` instead of
  reaching into mariadb's local install dir. Keeps mariadb's
  archive lean and gives mysql-test its own cache-key lifecycle.

The split is the cleaner path; the all-in-one staging is the
smaller diff if 50–80 MB extra in mariadb's archive is
acceptable.

Trigger: a PR ends up source-rebuilding mariadb-vfs /
mariadb-test / lamp (e.g. a kernel-ABI bump invalidates
everything, a mariadb revision bump, or a transitive cascade
similar to PR #410), and staging-build / prepare-merge fails on
"mariadbd.wasm not found at examples/libs/mariadb/mariadb-install/
bin/mariadbd.wasm".

### Multi-arch `[binary]` blocks

The `[binary]` block is single-URL.  A consumer's `package.toml` can
declare one `archive_url` + `archive_sha256`; the resolver uses it for
whatever arch it's currently resolving.  In practice we backfilled the
wasm32 archive URL because user programs are wasm32-only at the moment.
A `--arch wasm64` resolve falls through to source build.

When wasm64 user programs become real, extend the schema to either:
- per-arch keyed table:
  ```toml
  [binary.wasm32]
  archive_url = "..."
  archive_sha256 = "..."
  [binary.wasm64]
  archive_url = "..."
  archive_sha256 = "..."
  ```
- or a templated URL with a per-arch sha map.

Either is backwards-compatible with today's flat `[binary]` if we treat
the flat form as `[binary.wasm32]`.

### WASI artifact caching

`target_arch` is a closed enum: `wasm32 | wasm64`.  WASI binaries
are handled today by the runtime shim, not the artifact cache.  Decide
between composite enum values (`wasi-preview1-wasm32`) or splitting the
axis into `target_arch` / `target_abi` when we have a real first WASI
artifact to cache.

### Sibling source archive

For GPL-modified software we should ship an `.src.tar.zst` next to each
`.tar.zst` so users can rebuild from the exact source we built from.
Cargo's `cargo package` ships the same shape; this would mirror it.

### Semver range resolution for libraries / programs

The system keeps exact version pinning for `depends_on` and `[binary]`.  A
resolver that picks one version per logical lib across the dep graph
becomes load-bearing once two consumers want different patch versions
of the same library.  Until then, exact-pinning is a feature, not a bug
— it forces reproducibility.

### Compound version constraints for host-tools

The `version_constraint = ">=X.Y[.Z]"` syntax is intentionally minimal.
Compound forms (`>=3.20,<4.0` to exclude known-bad major versions)
become useful when a real case lands.

## Consumer convenience

### `WASM_POSIX_PREFER_LOCAL` opt-out

After the [binary] backfill (most consumers carry one today), `xtask build-deps resolve` for libs uses the
release archive by default.  A developer hand-editing a library's build
script can set `WASM_POSIX_PREFER_LOCAL=1` to skip the remote-fetch path
and force a source build.  Currently you achieve the same by populating
`local-libs/<name>/build/` with a hand-built tree (which the resolver's
priority-1 path picks up).  An env-var hatch is just shorter.

### `--format=json` for `build-deps env`

`xtask build-deps env vim` emits POSIX shell exports today.  A JSON
shape would let non-bash callers (e.g. Makefile-style or Python build
helpers) consume it without parsing shell.  Add behind a flag the day
a non-shell caller needs it.

### `--gc` cron-style cache clean

`xtask build-deps clean` is manual.  Add a hands-off mode with
conservative defaults: only entries older than N days, unreferenced by
any registry root.  Users would `0 4 * * 0 cargo xtask build-deps gc`
to trim weekly.

## Producer / release

### Auto-install of host tools

Resolver presence-checks host tools (cmake, wasm-opt, etc.) and prints
install hints on failure.  Auto-running `brew install cmake` was
explicitly rejected during system design — risky, users want control over
their machines.  Reopen if a consumer migration becomes painful enough
to justify it.

### Per-platform tool name aliases

macOS may have `gmake` instead of GNU `make`; Debian-derivatives may
ship `cmake` as `cmake3`.  Probe could try multiple commands.  Defer
until a real conflict.

### CI-driven dep builds

**Status (2026-04-29):** Partial — the per-PR staging release flow +
on-merge durable publish ship via three GHA workflows (see
[`docs/binary-releases.md`](binary-releases.md#pr-package-builds)
and design doc
[`docs/plans/2026-04-29-pr-package-builds-design.md`](plans/2026-04-29-pr-package-builds-design.md)).
Fork-PR support (§9.1 of the design doc) is the remaining open piece;
fork PRs continue to fall back to the resolver's source-build path
locally.

Manual `scripts/stage-release.sh` + `scripts/publish-release.sh` is
still the path for cutting a release outside the PR flow (e.g.,
hand-rebuilds, recovery from a CI outage). The `prepare-merge.yml`
workflow wraps those same two scripts.

### Hard-coded version strings in build scripts (lint)

A `build-<name>.sh` that hard-codes an upstream version string can drift
from its `package.toml`'s `version` field — `xtask build-deps check` would
ideally catch this.  Today the only signal is a sha mismatch on the
fetched tarball.  Lower priority since the sha catches the case
eventually; useful if cache invalidation becomes a debugging chore.

### Multi-arch fat archives

Per-arch archives separately (`zlib-1.3.1-rev1-wasm32-...` and
`zlib-1.3.1-rev1-wasm64-...`).  A "fat" archive containing both arches
would cut download size when consumers want both.  Not a priority while
download size for a single arch is small (zlib is ~200KB) but worth
revisiting if we ever publish a megabyte-scale lib.

## Security & trust

### Package signing

**Deferred from `docs/plans/2026-05-05-decoupled-package-builds-design.md` (§7, §10).**

Today's trust model is rooted in `archive_sha256` in the local
`package.toml` plus HTTPS for transport. That covers integrity for
already-pinned packages and tampering by random network adversaries.
Two threats it does not cover:

1. **Manifest tampering by a compromised source host.** A consumer who
   has added a third-party source URL trusts whatever bytes that URL
   returns on subsequent `index.toml` fetches. If the source host is
   compromised, an attacker could publish a malicious manifest pointing
   at malicious archives with valid (attacker-chosen) shas. HTTPS
   prevents in-flight tampering but not host compromise.
2. **Auto-update malice.** If/when the resolver grows an "is there a
   newer version?" check against a configured source, that check
   trusts the manifest content. A compromised source could push a
   malicious update without operator intervention.

Cryptographic signing of manifests (and optionally archives) addresses
both. Implementation requires picking a scheme (minisign / sigstore /
GPG / similar), a CI key-management story, key distribution for
third-party sources, and consumer-side verification UX. Real
engineering scope — defer until at least one of the following lands:

- Auto-update / update-check feature.
- Heterogeneous mirror network where archives are hosted on
  infrastructure not controlled by the publisher.
- A trust-authority concept (e.g. "this manifest must chain to the
  Kandelo root key").

The schema reserves no placeholder field; sign-related fields are
designed properly when the feature lands rather than retrofitted into
a stub.

### Auto-update / update-check

The source-manifest design (`index.toml`, `2026-05-05-decoupled-package-builds-design.md`)
makes "is there a newer version of package X in source Y?" a fetch + diff
operation. Not implemented. Triggers when consumers want a
non-manual upgrade path. Couples with package signing — auto-fetching
new shas without a signature check is the threat model that motivates
signing.

### Garbage collection of stale archives

Per-file uploads under `binaries-abi-v<N>` accumulate every sha ever
published. Storage is cheap on GitHub releases; old shas remain
reachable indefinitely (good for reproducibility). No GC is planned.
If storage pressure ever justifies it, the candidates are time-based
(prune unreferenced archives older than N days) or
reference-counted-against-`main`'s `package.toml` files (smallest
storage, harshest on stale branches).

## Resolver internals

### `compute_sha` memo keyed on arch

Surfaced during E.3 / E.4: `compute_sha`'s `memo` parameter is keyed by
`name@version`, not arch.  The hash itself includes arch, so re-using a
memo across arches returns a stale sha for the second arch.  Every
caller currently allocates a fresh memo per (manifest, arch) pair to
sidestep this.

Cleanup: fold arch into the memo key inside `compute_sha` itself.
Saves one allocation per arch, prevents future callers from hitting the
trap.

### Schema-level conditional requirement of `compatibility`

`abi/manifest.schema.json` currently allows `kind: "library"` or the archive-shape
`kind: "program"` entries WITHOUT a `compatibility` block.  The
producer (xtask::archive_stage / build_manifest) injects the block 100%
of the time so this is unreachable, but the schema doesn't enforce it.
A `dependentRequired` or `if/then` clause would tighten the contract.

### Pre-flight install-release covers only `cache_key_sha`

`xtask install-release` pre-flight verifies the manifest entry's
`cache_key_sha` matches local computation BEFORE invoking
`remote_fetch::fetch_and_install`.  The deeper 4-axis chain inside
`fetch_and_install` covers `target_arch` and `abi_versions`, but the
pre-flight could also short-circuit on those for clearer errors.

### Memoize failed builds within a stage-release run

`xtask::stage_release` iterates manifests alphabetically and calls
`stage_one` → `ensure_built` per (manifest, arch). When a manifest
fails (say, mariadb wasm32) every later dependent (lamp,
mariadb-test, mariadb-vfs, etc.) re-enters `ensure_built` for the
same failing dep and re-runs its build script from scratch.

In the force-rebuild run that diagnosed PR #406's six root causes,
mariadb's host CMake configure ran 6 times for one logical failure
(once per dependent — confirmed by `grep -c "Step 1: Host build"`
returning 6 in the run logs). CMake fails fast there
(~1.5s/attempt → ~9s wasted total), so the symptom was mild — but
a deeper failure (say, in `make` after 10 minutes of compile)
compounds into 6 × 10min = 1 hour of duplicate work.

Fix: a process-global `OnceLock<Mutex<BTreeMap<(name, TargetArch),
String>>>` in `build_deps.rs`. Before invoking the build script,
check the map; if a prior failure is recorded, return its cached
error string. After the build attempt, record success-or-failure.
Survives a single `xtask` process; intentionally NOT persisted
across runs (a fresh CI run should always retry).

Trigger: any time we observe a long-running build's failure being
re-attempted by its dependents in stage-release logs.

## Workflow

### Convert force-rebuild + staging-build to a tier-based job matrix

The current force-rebuild workflow runs every package source build
sequentially in one Ubuntu runner. Wall time is ~2 hours;
diagnostic visibility is poor (a single grep through 80k log lines
to find which package broke); single-package failures take a
~2-hour cycle to surface the next. PR #406's iteration history is
a concrete example: six independent root causes, each separated by
a multi-hour rebuild attempt.

Sketch:

1. New `xtask plan-tiers` subcommand walks every `package.toml`,
   topo-sorts by `depends_on`, and emits JSON tier arrays. No
   manifest changes — the dep graph already exists.
2. Workflow has four jobs: `plan` (emits tier outputs), `setup`
   (kernel + sysroot + libc++, uploaded as artifact), `tierN`
   (matrix per tier, each cell builds one package), and
   `publish` (collects archives, writes manifest, creates release).
3. Each `tierN` cell:
   - Downloads `setup` artifacts (sysroot, kernel.wasm).
   - Downloads its deps' archives from prior tiers' artifacts and
     re-populates `~/.cache/wasm-posix-kernel/`.
   - Runs `cargo xtask build-deps build <package>`.
   - Uploads its own archive as an artifact.

Wins:
- Wall time ~30-50 min (vs 2h) — true hardware parallelism per cell.
- Failure isolation — one bad package marks one cell red; the rest
  of the matrix still produces archives.
- Per-package logs are scoped to a single cell, easier to triage.
- Naturally subsumes the in-process memoization above (each cell
  builds exactly one package).

Costs:
- 2-3× compute (more runner-minutes; matters more on paid orgs).
- ~2-3 min per-cell Nix install + artifact transfer overhead — for
  a 2-min build, near 100% overhead. Net win because long-tail
  packages dominate wall time.
- Free-tier 20-job concurrency cap means tier 1 (~30 packages)
  queues into ~2 batches.
- Dynamic matrix needs `outputs:` + `fromJSON()` — non-trivial
  YAML. ~1-2 days implementation.

Trigger: once the current sequential workflow is durably green, or
sooner if force-rebuild runs continue to take >1 hour to surface
the next latent build bug.

### Re-enable TexLive in force-rebuild (currently `--allow-failure`)

PR #406's force-rebuild.yml passes `--allow-failure texlive` to keep
the workflow green while TexLive's source build is broken. The flag
downgrades a total-failure for that one package to a warning at the
stage-release exit-code level — every other package is still gated
strictly. The package's `package.toml` is intentionally untouched; the
release-policy decision lives at the call site (workflow YAML).

Re-enable when the underlying gmp.h chain is fixed:

* TexLive's `web2c` Phase-1 host build auto-generates `pmpost`'s C
  sources from `.w` files (the WEB literate-programming format).
  `pmpmathbinary.c` and `pmpmathinterval.c` hard-`#include <gmp.h>`
  regardless of `--disable-mp / --disable-ptex / --disable-uptex /
  --disable-euptex` — those flags only gate the resulting binary,
  not the source-file generation pass.
* The bundled `libs/gmp/native/` sub-configure clobbers `CC=` blank
  on recurse, autoconf re-detects `${build_alias}-gcc` (= the
  Nix-wrapped gcc on Linux CI), and the wrapper fails its
  compile-test because the cmdline `CFLAGS=` blank also strips its
  required spec injections. Same family of issues lurks under
  `libs/{mpfi,mpfr,cairo}/`.

The proper fix is most-likely:

1. Add `pkgs.gmp pkgs.mpfr pkgs.cairo` to `flake.nix` so their
   headers + libs land on the Nix wrapper's auto-included path for
   the host phase.
2. Switch the host configure to `--with-system-{gmp,mpfr,cairo}=yes`
   so TexLive uses the Nix-provided libs instead of trying to build
   bundled copies.
3. Phase-2 cross-build also needs these libs targeted at wasm32 —
   either build wasm32 ports of gmp/mpfr/cairo as new
   `examples/libs/<name>/` packages, OR keep the Phase-2 path on
   bundled libs and only fix Phase 1.
4. Drop `--allow-failure texlive` from `force-rebuild.yml`.

Trigger: when TexLive becomes a blocker for a release, or when
someone is willing to invest the ~half-day on the gmp/mpfr/cairo
flake additions and dual-phase wiring.
