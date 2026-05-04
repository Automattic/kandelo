# Package management (Wasm packages)

How we declare, build, cache, and publish the artifacts the project
produces — static libraries (zlib, ncurses, openssl, libcurl,
libxml2, libpng, sqlite, …), ported programs (vim, git, php, …),
source trees that consumer builds reach into (PCRE2 for MariaDB,
…), and the host-tool requirements that gate them all.

**Goal**: every artifact is reproducible from a manifest, cached by
content hash, and optionally fetched from a published release archive
without rebuilding from source. The same machinery serves three
audiences:
- A developer running `bash build.sh` who wants their local edits
  to override published artifacts.
- A developer with no Rust toolchain who wants to pull pre-built
  binaries from a known release.
- A CI / release engineer staging the full set into a `binaries-abi-v<N>`
  GitHub release.

**Scope**: static-library artifacts (`.a` + headers + pkgconfig),
ported program binaries (`.wasm`), composite VFS images (`.vfs`),
and source-tree extracts. Programs continue to statically link;
this work caches the build outputs, not the linker step. Runtime
`.so` loading is out of scope (see "Out of scope" below).

## Why

The previous state: each program's `build-<prog>.sh` called its
prerequisite lib build scripts explicitly, everything installed into
`sysroot/`, and rebuilding one program re-ran every dep from source.
That worked when we had two or three libs. Now that 7+ libs back 20+
programs, we need:

- rebuilding one program not to rebuild its deps from source;
- explicit dep ordering, not convention-by-script;
- third parties bringing their own packages without patching this
  repo;
- lib artifacts shipped alongside programs in the binaries release
  and unpacked into a shared cache on fetch;
- rebuild-in-progress in one worktree not to corrupt a sibling
  worktree's read of the same cached lib.

## Schema: `deps.toml`

Every library declares one `deps.toml` file, next to its build script:

```
examples/libs/zlib/
    deps.toml              ← declares the lib
    build-zlib.sh          ← builds it (invoked by the resolver)
```

Required fields:

```toml
name = "zlib"              # logical library name
version = "1.3.1"          # upstream version
revision = 1               # our build revision; bump when build/config changes
depends_on = []            # ["zlib@1.3.1", ...] — exact versions, no ranges

[source]
url = "https://github.com/madler/zlib/releases/download/v1.3.1/zlib-1.3.1.tar.gz"
sha256 = "9a93b2b7dfdac77ceba5a558a580e74667dd6fede4585b91eefb60f03b72df23"

[license]
spdx = "Zlib"              # SPDX identifier
url = "https://github.com/madler/zlib/blob/v1.3.1/LICENSE"  # optional
```

Optional sections:

```toml
arches = ["wasm32"]        # opt-in target arches; default: ["wasm32"]

[build]
script = "build-zlib.sh"   # default: build-<name>.sh in this directory

[outputs]
libs = ["lib/libz.a"]                            # must exist post-build
headers = ["include/zlib.h", "include/zconf.h"]
pkgconfig = ["lib/pkgconfig/zlib.pc"]
```

### `arches`

`arches = ["wasm32", "wasm64"]` declares which target architectures
the manifest opts into. Read by `xtask stage-release`: any
`(manifest, arch)` pair where `arch` isn't listed is silently
skipped and no archive is staged. Defaults to `["wasm32"]` when
omitted.

The default reflects the project's wasm64 build policy: the kernel
is wasm64, but most ported user-space programs (dash, vim, perl,
etc.) ship wasm32 only. The packages that currently opt into
wasm64 are MariaDB, MariaDB-VFS, PHP, and the libraries PHP
depends on transitively (zlib, openssl, sqlite, libxml2). Adding
a manifest to the wasm64 set is one line:

```toml
arches = ["wasm32", "wasm64"]
```

The resolver cache and `binary-resolver.ts` are arch-aware
independent of this field — `arches` only governs what gets staged
into a release archive. A locally-built wasm64 artifact still
populates `local-binaries/programs/wasm64/...` regardless of what
the manifest declares.

### `[binary]` — per-arch remote-fetch pointers

The optional `[binary]` block tells the resolver where to download
a prebuilt archive when the cache misses. Two equivalent shapes:

```toml
# Single-arch (most packages — implicit wasm32):
[binary]
archive_url    = "https://.../foo-wasm32-<sha>.tar.zst"
archive_sha256 = "<64 hex>"

# Multi-arch (mariadb, php, and their deps):
[binary.wasm32]
archive_url    = "https://.../foo-wasm32-<sha>.tar.zst"
archive_sha256 = "<64 hex>"
[binary.wasm64]
archive_url    = "https://.../foo-wasm64-<sha>.tar.zst"
archive_sha256 = "<64 hex>"
```

The bare form is an alias for `[binary.wasm32]`; mixing both forms
in one manifest is a parse error. When `xtask build-deps resolve
<pkg> --arch <arch>` runs, the resolver looks up
`[binary.<arch>]`. If no entry exists for the requested arch, it
falls through to a source build — same behavior as no `[binary]`
block at all.

`fetch-binaries.sh` doesn't read `[binary]` at all — it walks
`manifest.json` and downloads every entry the manifest catalogs.
`[binary]` is the entry point for direct, single-package fetches.

**Keep top-level arrays (`depends_on`, etc.) above the first `[section]`.**
TOML binds a bare key inside whatever section most recently opened; a
key placed after `[license]` ends up as `license.depends_on`, which
silently parses to an empty top-level list. The resolver documents
this inline but the parser cannot detect the mistake.

## Versions are exact

`depends_on = ["ncurses@6.5"]` — no semver ranges, no resolver.
If two consumers of the graph ever need different versions of the
same lib, we revisit. Noted as future work; not a near-term priority.

## Cache-key hashing

The cache-key sha for a library is computed over
`(name, version, revision, source.url, source.sha256, sorted
transitive dep cache-key shas)`. That means:

- Same inputs → same sha → same cache path → shared artifact.
- Any change in the tree (including a distant transitive dep) invalidates
  every downstream consumer. No silent staleness.
- `revision` is the knob for "same upstream, different flags": bump
  it when the build script or cross-compile config changes in a way
  that affects the output.

Inspect:

```bash
cargo xtask build-deps sha     zlib   # → 9acb9405ef818905a193…
cargo xtask build-deps path    zlib   # → ~/.cache/wasm-posix-kernel/libs/zlib-1.3.1-rev1-9acb9405
cargo xtask build-deps parse   zlib   # → normalized dump of deps.toml
cargo xtask build-deps resolve zlib   # → build-if-needed, then print the path
```

## Resolution order

`resolve <name>` walks the dep graph depth-first. For each library
in turn, it checks:

1. **`<repo>/local-libs/<name>/build/`** — hand-patched, in-progress.
   Returned as-is; the build script never runs. Per-worktree,
   gitignored. Mirrors `local-binaries/`.
2. **`<cache_root>/libs/<name>-<ver>-rev<N>-<shortsha>/`** — canonical
   cache. Trusted by presence: users invalidate by deleting the
   directory or bumping `revision`.
3. **Build from source** — run the declared `build.script`, validate
   declared outputs, atomically install into the canonical cache.

`cache_root` is `$XDG_CACHE_HOME/wasm-posix-kernel` if set, else
`$HOME/.cache/wasm-posix-kernel`.

## Build-script contract

The build script runs with these environment variables set. A script
that doesn't respect them cannot be cached safely.

| Variable | Meaning |
|---|---|
| `WASM_POSIX_DEP_OUT_DIR` | Temp dir the script must install into. Layout matches `outputs.libs` / `outputs.headers` / `outputs.pkgconfig` relative paths. |
| `WASM_POSIX_DEP_NAME` | `name` from deps.toml. |
| `WASM_POSIX_DEP_VERSION` | `version` from deps.toml. |
| `WASM_POSIX_DEP_REVISION` | `revision` from deps.toml. |
| `WASM_POSIX_DEP_SOURCE_URL` | Upstream tarball URL (`source.url` from deps.toml). |
| `WASM_POSIX_DEP_SOURCE_SHA256` | Expected sha256 of the downloaded tarball. Scripts **must** verify after download — the resolver does not fetch. |
| `WASM_POSIX_DEP_<UPPER>_DIR` | For each *direct* dep, the resolved path to that dep's build output. `<UPPER>` is the dep name upper-cased, with `-` → `_` (e.g. `zlib-ng` → `ZLIB_NG`). Transitive deps are not surfaced — scripts that need them should declare them in `depends_on`. |

After the script exits 0, the resolver verifies every path in
`outputs.{libs,headers,pkgconfig}` exists under `$WASM_POSIX_DEP_OUT_DIR`.
A missing output fails the build (and the temp dir is cleaned up,
so a retry starts clean).

### Toolchain on PATH

The SDK CLI tools (`wasm{32,64}posix-{cc,c++,ar,ranlib,nm,strip,
pkg-config,configure}`) live as wrapper symlinks under `sdk/bin/`,
all pointing at `sdk/bin/_wasm-posix-dispatch`. Every build script
sources `sdk/activate.sh` near the top, which prepends
`<worktree>/sdk/bin/` to `PATH`. This makes the toolchain
worktree-local: a build in worktree A always uses worktree A's SDK
source, even if worktree B has run `npm link`.

Older docs reference `cd sdk && npm link` as a prerequisite. It
still works (the wrappers and the npm-link-installed binaries
coexist — the dispatcher exports `WASM_POSIX_INVOKED_AS` so
`detectArch()` can read it, and falls back to `argv[1]` when the
env var is absent). `npm link` is now optional, and intentionally
discouraged for multi-worktree development because the global
symlink it creates routes every shell to a single worktree's
source.

## Migrating a consumer to the cache

When converting a `build-<prog>.sh` from "call the prerequisite
`build-<lib>.sh` directly and install into the sysroot" to "resolve
via the package cache," follow the patterns below.

### 1. Standard resolve pattern

Every cache-using build script repeats the same shape near the
top. Minimal example for a single-dep consumer (zlib only):

```bash
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

# Worktree-local SDK on PATH (see "Toolchain on PATH" above).
source "$REPO_ROOT/sdk/activate.sh"

SYSROOT="${WASM_POSIX_SYSROOT:-$REPO_ROOT/sysroot}"
export WASM_POSIX_SYSROOT="$SYSROOT"

HOST_TARGET="$(rustc -vV | awk '/^host/ {print $2}')"
resolve_dep() {
    local name="$1"
    (cd "$REPO_ROOT" && cargo run -p xtask --target "$HOST_TARGET" --quiet -- build-deps resolve "$name")
}

ZLIB_PREFIX="${WASM_POSIX_DEP_ZLIB_DIR:-}"
if [ -z "$ZLIB_PREFIX" ]; then
    echo "==> Resolving zlib via cargo xtask build-deps..."
    ZLIB_PREFIX="$(resolve_dep zlib)"
fi
[ -f "$ZLIB_PREFIX/lib/libz.a" ] || {
    echo "ERROR: zlib resolve missing libz.a at $ZLIB_PREFIX" >&2
    exit 1
}
```

The pieces:

- **`source "$REPO_ROOT/sdk/activate.sh"`** — prepends
  `<worktree>/sdk/bin/` to `PATH`, so `wasm32posix-cc` and
  friends route through this worktree's SDK source. Replaces
  the old `cd sdk && npm link` step (PR #358).
- **`resolve_dep` helper** — pinned to the host target so cargo
  picks up the host toolchain even when a `.cargo/config.toml`
  in the tree sets a wasm default. Stdout is the resolved path;
  stderr carries log output (PR #355 redirected child build
  scripts to stderr — see caveat 1 below).
- **`WASM_POSIX_DEP_<NAME>_DIR` short-circuit** — when the outer
  caller (an aggregator script, or the parent resolver running a
  consumer that itself appears in the dep graph) already knows
  the dep's path, it sets the env var and the script skips the
  cargo invocation. Cuts redundant resolves when many consumers
  pull the same dep in series.
- **Presence-check after resolve** — verifies the expected file
  actually exists. Catches "build script returned 0 but produced
  the wrong artifacts" before the consumer's `configure` step
  emits a confusing diagnostic.

For each additional dep, repeat the `<NAME>_PREFIX` stanza
(uppercase the dep name, `-` → `_`). Multi-dep consumers do this
4–5 times in a row (see PHP: `ZLIB_PREFIX`, `SQLITE_PREFIX`,
`OPENSSL_PREFIX`, `LIBXML2_PREFIX`).

### 2. The CPPFLAGS/LDFLAGS contract

**This is the load-bearing rule for autoconf consumers.** Every
cache-using build script that runs an autoconf-style `configure`
must set both `PKG_CONFIG_PATH` *and* `CPPFLAGS=-I` / `LDFLAGS=-L`.
Setting only one silently drops the dep.

Why: autoconf probes for a library along two independent paths
during `configure`, and which path runs depends on how the
project's `configure.ac` was written.

| Probe path | What configure runs | What env it reads |
|---|---|---|
| pkg-config | `pkg-config --cflags <name>` / `--libs <name>` | `PKG_CONFIG_PATH`, `PKG_CONFIG` |
| Raw autoconf | `AC_CHECK_HEADER([zlib.h])`, `AC_CHECK_LIB([z], [...])`, `AC_TRY_LINK` | `CPPFLAGS`, `LDFLAGS`, `CFLAGS`, `LIBS` |

A consumer typically tries pkg-config first; if pkg-config
returns success, the resulting `-I` / `-L` flags are used. If
pkg-config fails (no `.pc` file, or the project never invoked
`PKG_CHECK_MODULES` for that lib), configure falls back to
`AC_CHECK_HEADER`/`AC_CHECK_LIB`. The raw probe finds headers
and libraries **only** in directories listed in `CPPFLAGS=-I…`
and `LDFLAGS=-L…`. There is no implicit fallback to
`PKG_CONFIG_PATH`.

Practical rule for every cache-using build script that runs
autoconf-style configure:

```bash
PKG_CONFIG_PATH="$ZLIB_PREFIX/lib/pkgconfig" \
CPPFLAGS="-I$ZLIB_PREFIX/include" \
LDFLAGS="-L$ZLIB_PREFIX/lib" \
wasm32posix-configure …
```

Concrete bug from PR #352 (D.1 cpython): an early draft set only
`PKG_CONFIG_PATH`, which let the pkg-config-based probe for zlib
succeed but caused CPython's *separate* `py_cv_module_zlib`
detection (raw `AC_CHECK_HEADER`) to report `missing` because no
`-I$ZLIB_PREFIX/include` was on `CPPFLAGS`. The build then
silently produced a Python without `import zlib`.

For multi-lib consumers, compose by colon-joining
`PKG_CONFIG_PATH` and space-joining the `-I` / `-L` flags:

```bash
DEP_PKG_CONFIG_PATH="$ZLIB_PREFIX/lib/pkgconfig:$SQLITE_PREFIX/lib/pkgconfig:$OPENSSL_PREFIX/lib/pkgconfig:$LIBXML2_PREFIX/lib/pkgconfig"
DEP_CPPFLAGS="-I$ZLIB_PREFIX/include -I$SQLITE_PREFIX/include -I$OPENSSL_PREFIX/include -I$LIBXML2_PREFIX/include"
DEP_LDFLAGS="-L$ZLIB_PREFIX/lib -L$SQLITE_PREFIX/lib -L$OPENSSL_PREFIX/lib -L$LIBXML2_PREFIX/lib"

PKG_CONFIG_PATH="$DEP_PKG_CONFIG_PATH" \
CPPFLAGS="$DEP_CPPFLAGS" \
LDFLAGS="$DEP_LDFLAGS" \
wasm32posix-configure …
```

This pattern is used verbatim in `build-php.sh` (PR #354 / D.3).

### 3. Source-kind workflow (worked example: pcre2 in MariaDB)

`kind = "source"` is the right choice when a consumer needs the
unbuilt source tree of a dep, not a pre-built static-library
prefix. The canonical case is **PCRE2 inside MariaDB** (PR #357 /
D.5): MariaDB's CMake expects to compile PCRE2 against its own
internal headers and link the result statically into `mariadbd`,
so a generic `libpcre2.a` would not satisfy it.

The pcre2-source manifest (`examples/libs/pcre2-source/deps.toml`):

```toml
kind = "source"
name = "pcre2-source"
version = "10.44"
revision = 1

[source]
url = "https://github.com/PCRE2Project/pcre2/releases/download/pcre2-10.44/pcre2-10.44.tar.gz"
sha256 = "86b9cb0aa3bcb7994faa88018292bc704cdbb708e785f7c74352ff6ea7d3175b"

[license]
spdx = "BSD-3-Clause"
```

No `[outputs]`, no `[build].script` — the resolver fetches and
extracts in-place into
`<cache_root>/sources/pcre2-source-10.44-rev1-<sha>/`. No
`<arch>` segment because source trees are arch-agnostic.

The MariaDB manifest (`examples/libs/mariadb/deps.toml`):

```toml
depends_on = ["pcre2-source@10.44"]
```

The MariaDB build script (`examples/libs/mariadb/build-mariadb.sh`,
abridged):

```bash
# Source-kind direct deps export under _SRC_DIR (note the suffix).
PCRE2_SOURCE_DIR="${WASM_POSIX_DEP_PCRE2_SOURCE_SRC_DIR:-}"
if [ -z "$PCRE2_SOURCE_DIR" ]; then
    PCRE2_SOURCE_DIR="$(resolve_dep pcre2-source)"
fi
[ -f "$PCRE2_SOURCE_DIR/CMakeLists.txt" ] || {
    echo "ERROR: pcre2-source missing CMakeLists.txt" >&2; exit 1; }

# Build PCRE2 statically into a script-local tree (NOT cached as
# a library — the build is mariadb-specific by configuration).
PCRE2_BUILD="$SCRIPT_DIR/pcre2-wasm-build"
if [ ! -f "$PCRE2_BUILD/libpcre2-8.a" ]; then
    cmake "$PCRE2_SOURCE_DIR" \
        -DCMAKE_C_COMPILER="$LLVM_CLANG" \
        -DCMAKE_C_FLAGS="--target=$WASM_TARGET … --sysroot=$SYSROOT -O2 -DNDEBUG" \
        -DCMAKE_SIZEOF_VOID_P=$PCRE2_SIZEOF_VOID_P \
        -DPCRE2_BUILD_TESTS=OFF -DBUILD_SHARED_LIBS=OFF …
    make -j"$NPROC" pcre2-8-static pcre2-posix-static
fi

# Install into sysroot for mariadb's main cmake to link against.
cp "$PCRE2_BUILD/libpcre2-8.a"     "$SYSROOT/lib/"
cp "$PCRE2_BUILD/libpcre2-posix.a" "$SYSROOT/lib/"
cp "$PCRE2_BUILD/pcre2.h"          "$SYSROOT/include/"
cp "$PCRE2_SOURCE_DIR/src/pcre2posix.h" "$SYSROOT/include/"
```

Key contracts illustrated:

- **`_SRC_DIR` suffix, not `_DIR`.** A source-kind dep exports
  `WASM_POSIX_DEP_<NAME>_SRC_DIR` so the consumer immediately
  knows it received an unpacked source tree, not a built-artifact
  prefix. See decision 12 in
  `docs/plans/2026-04-22-deps-management-v2-design.md`.
- **The cache holds source; the build is consumer-local.** The
  arch-agnostic source lives once in the shared cache; the
  arch-specific build output (`pcre2-wasm-build/` + sysroot
  copies) stays inside the consumer's worktree. Avoids forcing
  every consumer that vendors PCRE2 into the same flag matrix.
- **Light presence-check on the unpacked tree.** `[ -f
  CMakeLists.txt ]` catches a partial extract or the wrong tarball
  layout before cmake emits a more confusing error.

### 4. Caveats / known footguns

Real issues encountered during D.1–D.5 and how to avoid them.

1. **Build-script stdout flooding the captured path.** Pre-PR
   #355, on a cache miss, the inner build-script's stdout
   reached `resolve_dep`'s shell capture and corrupted the
   resolved path with build-log noise. Fixed in PR #355 (D.4):
   `cmd_resolve` now redirects child stdout to stderr, leaving
   only the canonical path on stdout. Until that fix is in your
   base branch, work around by warming the cache first
   (`cargo xtask build-deps resolve <name>` once, ignore stdout)
   so subsequent `resolve_dep` calls hit the cache and return
   the path cleanly.
2. **Silently dropped CPPFLAGS / LDFLAGS.** See section 2 above.
   If a consumer's `configure` reports a dep "missing" even
   though pkg-config swears it is there, the consumer almost
   certainly has a separate raw `AC_CHECK_HEADER` probe and you
   forgot `-I<prefix>/include` on `CPPFLAGS`.
3. **SDK invocation crossing worktrees.** Pre-D.6, the SDK was
   installed by `npm link`, which created a single global
   `wasm32posix-cc` symlink. Two worktrees taking turns to
   `npm link` would silently swap which source tree handled
   compilation — a build started in worktree A could be served
   by worktree B's SDK if the user `npm link`-ed B more
   recently. Fixed in PR #358 (D.6): `source sdk/activate.sh`
   prepends the worktree-local `sdk/bin/` to `PATH`. Always
   source it; do not rely on `npm link`.
4. **Sysroot `lib/pkgconfig/` directory.** Some sub-builds
   (libyaml inside ruby was the trigger) implicitly relied on
   an earlier zlib install creating `$SYSROOT/lib/pkgconfig/`.
   After migrating zlib out of `build-<prog>.sh`, that mkdir
   went with it, and the sub-build later failed trying to
   `cp foo.pc $SYSROOT/lib/pkgconfig/`. If your migrated script
   still installs anything into the sysroot's pkgconfig dir,
   add an explicit `mkdir -p "$SYSROOT/lib/pkgconfig"` near the
   top.

### 5. Optimization-level workarounds

A few cross-compiles trip LLVM 21 wasm32 codegen bugs at higher
`-O` levels. The migration pattern doesn't change this — these
are pre-existing issues that surface independent of the cache —
but consumers must keep the per-file workaround in place when
porting their build script:

- **Erlang `erl_unicode.c`** — compiled at `-O1` (rest of OTP
  builds at `-O2`). At `-O2`, LLVM miscompiles aggregate
  initialization of structs that hold shadow-stack pointers,
  breaking ESTACK iodata traversal. Adding `fprintf` inside the
  function changes code layout enough to mask the bug, hence the
  Heisenbug character. See `examples/libs/erlang/build-erlang.sh`
  comments.
- **Redis `tls.c`** — at `-O1` and above, LLVM 21.1.8 crashes
  inside `llvm::AsmPrinter::emitGlobalVariable`. Currently the
  file is stubbed out to dodge the issue; re-enabling TLS for
  the Redis build would require a per-target Makefile rule that
  compiles just `tls.c` at `-O0`.

The general pattern: identify the offending file, give it a
per-target rule in the consumer's Makefile (or invoke `clang`
on it directly with a different `-O` flag from the build
script), and leave the rest of the project at the original
optimization level. Document the rule inline so the next person
to touch the build doesn't quietly raise the level.

## Release archives

Not every contributor wants — or has the toolchain for — a
local cross-compile. Pre-built `.tar.zst` archives
alongside the existing release manifest so a fresh checkout can
fetch a binary, verify it against the consumer's source
`deps.toml`, and install it directly into the resolver's cache.
A subsequent `cargo xtask build-deps resolve` then hits the
canonical cache path with no source build.

### Producer / consumer round-trip

Two `xtask` subcommands bracket the pipeline. Both accept
`--abi <N>` (defaults to the kernel's current `ABI_VERSION`)
and emit machine-readable progress on stderr.

**Producer — `cargo xtask stage-release`:**

```bash
cargo xtask stage-release \
    --staging /tmp/release-staging \
    --abi 4 \
    --tag binaries-abi-v4-2026-04-26 \
    --arch wasm32 --arch wasm64 \
    --build-timestamp 2026-04-26T10:00:00Z \
    --build-host darwin-arm64
```

It walks the registry (`Registry::walk_all`), filters to
`kind=library` and `kind=program` manifests, fans out across
the requested arches, calls `ensure_built` to populate the
resolver cache when needed, then `archive_stage` to pack each
cache tree into

```
<staging>/{libs,programs}/<name>-<version>-rev<N>-<arch>-<shortsha>.tar.zst
```

Finally it delegates to `build-manifest` to emit
`<staging>/manifest.json` covering both legacy single-asset (kernel, userspace,
test programs) and archive (libs + programs) entries.

**Consumer — `cargo xtask install-release`:**

```bash
cargo xtask install-release \
    --manifest /path/to/manifest.json \
    --archive-base https://github.com/.../releases/download/<tag>
```

It iterates manifest entries that carry `archive_name` (archive
shape) and dispatches each one through `remote_fetch`, which
handles fetch + verify + install. `--archive-base` accepts both
`https://…` and `file://…/…` (the round-trip test uses the
latter); a relative path is rejected. Library entries land in
`<cache>/libs/<canonical>/`; program entries land in both the
cache and `local-binaries/programs/<name>/` so subsequent
program builds short-circuit through the same lookup path
hand-built programs use.

### The injected `[compatibility]` block

`stage-release` reads each consumer's source `deps.toml`,
appends a `[compatibility]` block, and writes the result as
`manifest.toml` at the root of the archive (alongside an
`artifacts/` subtree carrying the built files). The block
carries five fields:

```toml
[compatibility]
target_arch = "wasm32"        # required: wasm32 | wasm64
abi_versions = [4]            # required: list of integers ≥ 1
cache_key_sha = "9acb9405…"   # required: 64-char lowercase hex
build_timestamp = "2026-04-26T10:00:00Z"   # optional, informational
build_host = "darwin-arm64"                # optional, informational
```

`DepsManifest::parse_archived` is the validator. It rejects:

- a missing or empty `[compatibility]` block (a source
  `deps.toml` doesn't have one; an archived `manifest.toml` must),
- empty `abi_versions`,
- `cache_key_sha` that isn't 64 lowercase hex chars,
- a re-injected block on a manifest that already had one.

The producer round-trips its emitted text through
`parse_archived` before calling the tar/zstd writer, so
malformed output rejects at archive-creation time rather than
on a consumer machine.

### Why `cache_key_sha` is the strict equivalence check

The `target_arch` and `abi_versions` axes are coarse — many
archives might share `(wasm32, [4])`. The `cache_key_sha`
axis is the strict-equivalence axis: a consumer recomputes
the cache-key sha from its current source tree and rejects the
archive if the recorded value differs.

Concrete example. Suppose a contributor's local `deps.toml`
for ncurses has bumped `revision` from 1 to 2 (perhaps to pick
up a new compiler flag). The producer's archive recorded
`cache_key_sha` is whatever rev1 produced — say
`9acb9405…`. The consumer's local cache key is now a different
sha — say `b1773def…`. `remote_fetch` walks its 4-axis chain:

1. Verify archive bytes against `archive_sha256` from the
   manifest. Pass.
2. Parse `manifest.toml` from the archive. Pass.
3. `target_arch` matches the resolver's arch. Pass.
4. The consumer's ABI is in `abi_versions`. Pass.
5. `cache_key_sha` matches the locally-computed sha. **Fail.**

`remote_fetch` returns the cache-key-mismatch error, and
`install-release` errors hard (a manual install is an explicit
"trust this archive" gesture; falling back to source build
silently would defeat the point). In the implicit `resolve`
codepath that `build-deps` hits during a normal build, the same
rejection causes the resolver to fall through to source build
— same outcome as if no archive had been published.

That is the strict-equivalence check the design relies on:
the archive is honored if and only if its source-side inputs
hash to exactly what this checkout would produce.

### Iterating on a package locally

When you edit an `examples/libs/<name>/deps.toml` (or any input
that changes the package's `cache_key_sha` — `revision`,
`source.url`, `source.sha256`, transitive deps), the published
release manifest goes stale relative to your local state. By
default, `./run.sh fetch` and `./run.sh browser` then abort with:

```
xtask install-release: <name> (<arch>): manifest.json cache_key_sha
"<published>" does not match locally-computed "<local>" — the
manifest is stale relative to this consumer's deps.toml
```

That is the "Why `cache_key_sha` is the strict equivalence
check" rejection above, surfaced at the install-release seam.

The primary remedy is the per-PR overlay flow — push your
branch, let `staging-build.yml` rebuild the touched packages,
and `fetch-binaries.sh` will auto-detect the open PR and pull
its `pr-<NNN>-staging` archives via `binaries.lock.pr` (see
[binary-releases.md](binary-releases.md) "Per-PR staging
overlay"). That works for any `deps.toml` change pushed to a
PR with CI write access, and is the path code-review and merge
both use.

`--allow-stale` is the escape hatch for the cases the overlay
flow doesn't cover:

- pre-push iteration before any commit lands on the branch,
- fork PRs that lack write access to publish staging releases,
- `WIP:` commits where the staging build hasn't completed (or
  failed) and you want to see the demo locally,
- local edits past the last CI build on your own PR.

Pass it instead of waiting for the overlay:

```bash
./run.sh browser --allow-stale          # one-shot
./run.sh fetch   --allow-stale          # also works for any subcommand
WASM_POSIX_ALLOW_STALE=1 ./run.sh ...   # sticky for the shell session
```

With the flag set, `install-release` skips the mismatched
manifest entries (a one-line diagnostic per skip) and continues
with the rest of the manifest. The skipped packages then fall
through the resolver chain on the next `cargo xtask build-deps
resolve <name>` — `local-libs/` first, then the content-addressed
cache, then a source build via `build-<name>.sh`. Outputs land
under `local-binaries/programs/<arch>/`, which the Vite resolver
and `scripts/resolve-binary.sh` already prefer over `binaries/`.

`binaries/` itself stays release-pure regardless of the flag —
the entries it gets are the ones the manifest agreed on. CI does
not pass `--allow-stale` and remains strict-by-construction.

### Worked example: zlib

Source manifest at `examples/libs/zlib/deps.toml`:

```toml
kind = "library"
name = "zlib"
version = "1.3.1"
revision = 1
depends_on = []

[source]
url = "https://github.com/madler/zlib/releases/download/v1.3.1/zlib-1.3.1.tar.gz"
sha256 = "9a93b2b7dfdac77ceba5a558a580e74667dd6fede4585b91eefb60f03b72df23"

[license]
spdx = "Zlib"

[outputs]
libs = ["lib/libz.a"]
headers = ["include/zlib.h", "include/zconf.h"]
pkgconfig = ["lib/pkgconfig/zlib.pc"]
```

After `stage-release --arch wasm32`, one staged archive lands
as

```
<staging>/libs/zlib-1.3.1-rev1-wasm32-9acb9405.tar.zst
```

(short sha `9acb9405` is the first 8 chars of the cache-key sha
for this manifest, identical to the canonical cache directory
suffix — `cargo xtask build-deps sha zlib` prints the full
form). `manifest.json` carries the entry:

```json
{
  "name": "zlib-1.3.1-rev1-wasm32-9acb9405.tar.zst",
  "program": "zlib",
  "kind": "library",
  "arch": "wasm32",
  "upstream_version": "1.3.1",
  "revision": 1,
  "size": 12345,
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
```

On the consumer side, `install-release` fetches that archive,
verifies bytes against `archive_sha256`, runs the 4-axis check
above, then unpacks `artifacts/lib/libz.a`,
`artifacts/include/{zlib.h,zconf.h}`, and
`artifacts/lib/pkgconfig/zlib.pc` into

```
<cache_root>/libs/zlib-1.3.1-rev1-9acb9405/
```

A subsequent `cargo xtask build-deps resolve zlib` finds the
canonical path populated and returns it without re-running
`build-zlib.sh`.

### Shell-script wrappers

For the per-PR staging flow (single-PR-with-package-bumps,
auto-merge after a `ready-to-ship` label), see
[`docs/binary-releases.md`](binary-releases.md#pr-package-builds).

`scripts/stage-release.sh` and `scripts/fetch-binaries.sh` wrap
the xtask subcommands with the rest of the legacy release flow:

- `stage-release.sh` first stages legacy entries (kernel,
  userspace, hand-bundled test programs) via `xtask
  bundle-program --plain-wasm`, then delegates to `xtask
  stage-release` for the lib + program archives. Both halves
  land in the same flat staging directory with one combined
  `manifest.json`.
- `fetch-binaries.sh` reads `binaries.lock`, downloads
  `manifest.json`, and dispatches archive entries (those with
  `archive_name`) to `xtask install-release`. legacy entries
  continue through the existing bash `place`/`extract_flat_zip`
  codepaths into `binaries/`. The two halves coexist in one
  release with no schema-level separation; the `archive_name`
  field is the per-entry discriminator.

### Round-trip test

`host/test/release-roundtrip.test.ts` exercises the full
producer/consumer loop end-to-end with synthetic fixtures and
`file://` URLs. It stages a synthetic library + program,
installs back via `install-release`, then re-runs `xtask
build-deps resolve` against the populated cache and asserts
the consumer's build script does **not** run a second time
(verified via a sentinel file the script writes per
invocation). The whole suite skips on machines without `rustc`
on `PATH`, mirroring the existing host-tool skip pattern.

## Atomic cache install

The script builds into `<canonical>.tmp-<pid>/`, not the final path.
On success the resolver calls `rename(2)` from temp to final. Readers
in other worktrees either see the full previous version of the cache
entry or the full new one — never a partial write.

If two builds of the same cache key race, the first `rename` wins.
The second notices the canonical path exists and discards its own
temp dir. Identical inputs yield identical outputs, so keeping either
copy is correct.

A crashed build (process killed mid-script) leaves its `.tmp-<pid>/`
behind. The next resolve of the same key starts a fresh temp with a
new pid — no conflict — and the leftover is harmless until manually
pruned. A future `xtask clean-deps` subcommand can sweep them.

## Registry search path

By default the resolver looks in `<repo>/examples/libs/`. Override:

```bash
WASM_POSIX_DEPS_REGISTRY="./examples/libs:~/my-wasm-packages" \
    cargo xtask build-deps sha vim
```

Colon-separated. First hit wins — later entries have lower priority,
like `$PATH`. This is how third parties bring their own packages
without patching the repo: they drop a `<lib>/deps.toml` into their
own directory tree and prepend it to the registry path.

## Source-kind manifests

The system supports `kind = "source"` for declaring source trees that
consumers vendor or sub-build but that we do **not** publish as
standalone library or program artifacts. Typical cases:

- **PCRE2 inside MariaDB** — MariaDB's CMake expects to compile
  PCRE2 against its own internal headers and link statically into
  `mariadbd`. The PCRE2 sources are unpacked once into a shared
  cache and reused across MariaDB rebuilds.
- **PHP extensions** — extensions live in PHP's source tree and
  link into the PHP build, not as separate libs.
- **Erlang vendored code** — OTP ships several third-party libs
  inside its own tarball; they are arch-agnostic at the source
  level.

Source manifests are arch-agnostic and ABI-agnostic — they describe
unpacked source trees, not built artifacts.

**Schema fields**

Required:
- `kind = "source"`
- `name`, `version`, `revision`
- `[source].url`, `[source].sha256`
- `[license].spdx`

Optional:
- `depends_on` — same syntax as library/program manifests.
- `[build].script` — see "Override" below.
- `[[host_tools]]` — see the Host-tool requirements section below.

Rejected at parse time (the parser surfaces a clear error):
- `[outputs]` and `[[outputs]]` — sources have no built-artifact
  layout.
- `[binary]` and `[compatibility]` — those describe published
  binaries; sources are not published.

**Default fetch+extract behavior**

When `[build].script` is absent, the resolver fetches `source.url`,
verifies `source.sha256`, and extracts in-place. Format detection
is by URL extension: `.tar.gz` / `.tgz`, `.tar.xz` / `.txz`,
`.tar.bz2` / `.tbz2` / `.tbz`, `.tar.zst` / `.tzst`, `.zip`, and
plain `.tar`. Unrecognized extensions fail loudly rather than
guessing.

If the archive contains a single top-level directory (the
`pcre2-10.42/` shape), that wrapper is stripped — the cache
directory's contents are the contents of that single top-level
directory. Multi-top-level archives are kept as-is.

**Override `[build].script`**

When the default extract is not enough (patches, code generation,
in-tree configure), declare a script. The contract is the same as
library and program builds: the script reads the same
`WASM_POSIX_DEP_*` environment variables, installs into
`$WASM_POSIX_DEP_OUT_DIR`, and the resolver fails the build if
`OUT_DIR` is empty after the script returns.

**Cache layout**

```
<cache_root>/sources/<name>-<version>-rev<N>-<shortsha>/
```

No `<arch>` segment — sources are arch-agnostic by definition.
That is the visible difference from the `libs/` and `programs/`
cache trees.

**Direct-dep env var: `_SRC_DIR`**

A consumer (lib, program, or another source) listing a source-kind
manifest in `depends_on` gets `WASM_POSIX_DEP_<NAME>_SRC_DIR`
exported into its build script. The `_SRC_DIR` suffix (vs `_DIR`
for library/program deps) is the contract: scripts pointing at a
source dep know they receive an unpacked source tree, not a
built-artifact prefix.

See decisions 9 (kind discriminator) and 12 (default fetch+extract)
in `docs/plans/2026-04-22-deps-management-v2-design.md`.

## Host-tool requirements

A manifest can declare host-side prerequisites — `cmake`,
`make`, `patch`, `autoconf`, etc. — inline. The resolver probes
each one before invoking the build script, so a missing or
too-old tool fails up front with a platform-keyed install hint
rather than mid-build with a cryptic shell error.

**Inline declaration**

`[[host_tools]]` is an array-of-tables on the consumer manifest
(library, program, or source):

```toml
[[host_tools]]
name = "cmake"
version_constraint = ">=3.20"

[host_tools.probe]
args = ["--version"]
version_regex = '(\d+\.\d+(?:\.\d+)?)'

[host_tools.install_hints]
darwin = "brew install cmake"
linux = "apt install cmake (or your distro's equivalent)"
```

Per-entry fields:

- **`name`** (required) — executable name resolved against `PATH`.
- **`version_constraint`** (required) — see syntax below.
- **`probe`** (optional) — overrides the defaults below.
- **`install_hints`** (optional) — platform-keyed help strings,
  printed verbatim when the probe fails.

**Probe defaults**

If `probe` is omitted, the resolver uses:

- `args = ["--version"]`
- `version_regex = (\d+\.\d+(?:\.\d+)?)`

It runs `<name> <args...>`, captures combined stdout+stderr (some
tools print their version to stderr), matches against
`version_regex`, and parses capture group 1 as a numeric version
(`major.minor` or `major.minor.patch`).

**Version-constraint syntax**

Only `>=X.Y` and `>=X.Y.Z` are accepted. The parser rejects
anything else at manifest-load time:

- Other operators (`>`, `<`, `==`, `^`, `~`).
- Compound constraints (`>=3.20,<4.0`).
- Prerelease or build-metadata suffixes (`>=3.20.0-rc1`,
  `>=3.20.0+build5`).

Comparison is **numeric**, not lexicographic — `3.20` is greater
than `3.9`, never less.

**`install_hints` platform keys**

Use unix-style names. `darwin` matches `uname -s` on macOS;
`linux`, `windows`, and `freebsd` are the other recognised keys.
The resolver maps Rust's `target_os = "macos"` to the user-facing
key `darwin` so manifest authors don't have to think about
Rust-specific naming.

**Cache-key impact: zero**

Host-tool declarations do **not** contribute to the consumer's
cache-key sha. A `cmake` upgrade on a developer machine does not
invalidate the MariaDB cache entry. If a tool change actually
affects build output (a new compiler bug-fix that changes
generated code, say), bump the consumer's `revision` — that is
the existing knob. See decision 10.

**`xtask build-deps check`**

The `check` subcommand lints cross-consumer consistency: if two
manifests declare the same host-tool `name` with different
`version_constraint` or different `probe` settings, `check`
reports it. The intent is to keep the project's host-toolchain
floor coherent — one project-wide minimum per tool — without
forcing a single shared declaration file.

See decisions 10 (cache-key impact) and 11 (probe + install hint
contract) in `docs/plans/2026-04-22-deps-management-v2-design.md`.

## Out of scope

- **Runtime shared `.so` libraries**: evaluated but rejected. Current
  programs static-link everything; switching to dynamic loading across
  every demo is bigger architecture than caching warrants. A follow-up
  PR can add `.so` support on top of the same graph + cache, when the
  binary-bloat savings justify the dlopen complexity.
- **Semver ranges**: exact-pinning only. Adding a resolver that picks
  one version per lib across the overall graph is real work; we punt
  until two consumers actually conflict.
- **CI-driven dep builds**: deps are built manually and published
  manually via `publish-release.sh`.
