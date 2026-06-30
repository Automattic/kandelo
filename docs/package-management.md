# Package management (Wasm packages)

How we declare, build, cache, and publish the artifacts the project
produces — static libraries (zlib, ncurses, openssl, libcurl,
libxml2, libpng, sqlite, libcxx, …), ported programs (vim, git, php, …),
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
ported program binaries (`.wasm`), composite VFS images (`.vfs.zst`),
and source-tree extracts. Programs continue to statically link;
this work caches the build outputs, not the linker step. Runtime
`.so` loading is out of scope (see "Out of scope" below).

## Quick reference (jump-table)

Most readers want one of these. Detailed sections follow further down.

| I want to… | Look at |
|---|---|
| Pull pre-built binaries without compiling | [`scripts/fetch-binaries.sh`](#release-archives) - materializes platform artifacts, then walks package `package.toml` files and calls the resolver. Run with `--allow-stale` in CI. |
| Work on kernel/userspace/SDK runtime artifacts | [`platform/artifacts/README.md`](../platform/artifacts/README.md) - owns `kernel`, `userspace`, and `kandelo-sdk`; these are not Homebrew package identities. |
| Add a new package to the registry | [Schema: `package.toml`](#schema-packagetoml) + [docs/porting-guide.md](porting-guide.md#adding-a-new-package-to-the-registry) for the end-to-end workflow. |
| Resolve one package on demand | `cargo xtask build-deps resolve <name>` — handles fetch/source-build, populates the cache. |
| Find where an output lands | `cargo xtask build-deps output-path <name> <wasm-basename>` — single source of truth for the layout convention (flat for 1-output packages, nested under `<pkg>/` for ≥2-output packages). |
| Migrate a build script to consume cached deps | [Migrating a consumer to the cache](#migrating-a-consumer-to-the-cache) — the `WASM_POSIX_DEP_*_DIR` contract + CPPFLAGS/LDFLAGS pattern. |
| Override a published archive locally | Drop the file at `local-binaries/programs/<arch>/<rel>` or `local-libs/<pkg>/build/`. The resolver prefers these. |
| Override an archive in a PR for testing | Per-PR builds publish to `pr-<N>-staging` tags. Locally, run `./run.sh --pr-staging <command>` or set `WASM_POSIX_USE_PR_STAGING=1` so `run.sh` exports the matching staging `WASM_POSIX_BINARY_INDEX_URL`. Manual `WASM_POSIX_BINARY_INDEX_URL` values still win. |
| Republish a stale archive | Dispatch `.github/workflows/force-rebuild.yml` with the comma-separated package list (or `all`). |
| Bump a package's revision number | Edit `revision = N` in its `build.toml` (NOT `package.toml` — revision moved to the project-view file during the binary-resolution-via-index-ledger migration). Invalidates the cache for that package. Only bump when output bytes legitimately change. |
| Understand the release flow | [docs/binary-releases.md](binary-releases.md). |
| Work on Homebrew bottle publishing | [docs/homebrew-publishing.md](homebrew-publishing.md) - formula authoring, trusted CI, sidecars, VFS images, and Node/browser gates. |
| Publish packages from another repository | [docs/package-sources.md](package-sources.md) — package-source layout, reusable workflow, and browser-gallery contract. |
| Trace an ABI mismatch | [docs/abi-versioning.md](abi-versioning.md). |
| See what's missing | [docs/package-management-future-work.md](package-management-future-work.md). |

The rest of this doc is the reference manual: schema details, cache-key
hashing, resolver ordering, the consumer-side migration pattern, and
release semantics.

## Why

The previous state: each program's `build-<prog>.sh` called its
prerequisite lib build scripts explicitly, everything installed into
`sysroot/`, and rebuilding one program re-ran every dep from source.
That worked when we had two or three libs. Now that 8+ libs (including
the libcxx package, which builds libc++/libc++abi and statically bundles
LLVM libunwind so C++ programs can throw exceptions) back 20+
programs, we need:

- rebuilding one program not to rebuild its deps from source;
- explicit dep ordering, not convention-by-script;
- third parties bringing their own packages without patching this
  repo;
- lib artifacts shipped alongside programs in the binaries release
  and unpacked into a shared cache on fetch;
- rebuild-in-progress in one worktree not to corrupt a sibling
  worktree's read of the same cached lib.

## Artifact invalidation model

Use precise artifact concepts when changing CI gates or package cache
keys:

- **Kernel implementation**: Rust kernel behavior changed, but the
  guest-visible contract did not. Build and test a fresh `kernel.wasm`
  against existing package archives; do not rebuild package archives.
- **Guest ABI epoch**: the binary contract compiled into user programs
  changed incompatibly. This is `ABI_VERSION` in
  `crates/shared/src/lib.rs`; a bump intentionally changes every
  library/program cache key and requires a new `binaries-abi-v<N>`
  release.
- **Additive guest ABI surface**: new syscall/export/metadata that keeps
  old binaries valid. Commit the updated ABI snapshot, but do not force a
  package rebuild unless a package's own source changed to use the new
  surface.
- **Package recipe/build input**: package source, manifest, build script,
  SDK wrapper, sysroot/glue input, VFS image builder, or package-system
  publish code changed. Rebuild only packages whose cache keys include
  that input, plus transitive dependents through `depends_on`.
- **Host adapter/runtime ABI**: host TypeScript and kernel-wasm boot
  metadata changed. Rebuild/test the host and kernel together; rebuild
  guest packages only if the guest ABI epoch or package build inputs also
  changed.

The PR change-scope detector should classify paths by effect:

- **Package archive**: can change archive bytes or package cache keys;
  this is the only category that should run the package matrix.
- **Package publish flow**: can change release/index/source-publish
  mechanics; run the publish-flow checks without rebuilding every
  archive.
- **Homebrew bottle publish flow**: can change formula bottle
  generation, GHCR upload, sidecar metadata, or Homebrew-derived VFS
  materialization. Run the Homebrew publish, validator, VFS builder,
  and Node/browser smoke checks that match the changed path; do not
  rebuild every Kandelo package archive unless a package recipe/build
  input also changed.
- **Binary materialization**: can change fetching, verifying, overlaying,
  or installing already-published archives; run the materialization
  checks, materialize durable binaries, and run runtime tests, but do
  not rebuild archives.
- **Kernel/runtime**: can change the fresh kernel/runtime/test side of
  the system; materialize the durable package release and test it
  against the fresh kernel.

Do not use package staging as a proxy for "tests should run."
Kernel/runtime, publish-flow, and binary-materialization PRs still run
their targeted validation without rebuilding package archives. Unknown
non-doc paths should also run the non-package test gate as a fail-safe,
but should not trigger the package matrix unless they are package
archive inputs.

## Schema: `package.toml` (recipe) + `build.toml` (project view)

Every package ships TWO TOML files in `packages/registry/<name>/`:

```
packages/registry/zlib/
    package.toml              ← the recipe (project-agnostic)
    build.toml                ← project's build + publish state
    build-zlib.sh             ← builds it (invoked by the resolver)
```

The split is load-bearing post the
[binary-resolution-via-index-ledger migration](plans/2026-05-13-binary-resolution-via-index-ledger-design.md):

- **`package.toml`** carries identity-and-constraints: who the
  package is, what it depends on, where its source comes from,
  what license it ships under. **Project-agnostic** — the exact
  same `package.toml` would work in any project that wants to
  consume this package.
- **`build.toml`** carries this project's view: which commit built
  it, where the binary is published, what publish-time revision
  it's at. **Project-specific** — every fork or downstream
  consumer gets its own `build.toml`.

Runtime platform artifacts are outside this package schema. `kernel`,
`userspace`, and `kandelo-sdk` are owned by
`platform/artifacts/manifest.json`; bridge TOML files may remain under
`packages/registry/` during migration, but `scripts/fetch-binaries.sh`
skips those names in the package loop and materializes them through
`xtask platform-artifacts` first.

### `package.toml`

Required fields:

```toml
name = "zlib"              # logical library name
version = "1.3.1"          # upstream version
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
kernel_abi = 11            # required when a [build] block is present
arches = ["wasm32"]        # opt-in target arches; default: ["wasm32"]

[build]
script_path = "packages/registry/zlib/build-zlib.sh"

[outputs]
libs = ["lib/libz.a"]                            # must exist post-build
headers = ["include/zlib.h", "include/zconf.h"]
pkgconfig = ["lib/pkgconfig/zlib.pc"]
```

`package.toml` **must NOT** carry `revision`, `[binary]`,
`[build].repo_url`, or `[build].commit`. Those moved to `build.toml`
during the binary-resolution-via-index-ledger migration;
`validate_source` rejects them with a clear error message pointing
at the new home. (Archived `manifest.toml` bytes inside historical
`.tar.zst` archives still carry the legacy shape;
`validate_archived` keeps accepting them for back-compat.)

### `build.toml`

Required (unless the package is `kind = "source"` with no `[build]`
block — those packages don't publish a binary):

```toml
script_path = "packages/registry/zlib/build-zlib.sh"   # mirrors package.toml
repo_url    = "https://github.com/brandonpayton/kandelo.git"
commit      = "<commit at last successful build>"
revision    = 1

[binary]
index_url = "https://github.com/Automattic/kandelo/releases/download/binaries-abi-v{abi}/index.toml"
```

- `script_path` typically equals `package.toml`'s `[build].script_path`;
  a project that monkey-patches a recipe sets its own override.
- `repo_url` + `commit` record the project's recipe provenance.
- `revision` is the publish-time counter the resolver hashes into
  the cache-key. Bump when output bytes legitimately change (build
  flag tweaks, fork-instrument output, etc.). Don't bump for doc-only
  changes — it triggers a needless rebuild across the matrix.
- `[binary]` declares where binaries are published. Two forms,
  exactly one of which must be present:

| Form | Example | Resolver behavior |
|---|---|---|
| Indexed (typical) | `index_url = "https://.../binaries-abi-v{abi}/index.toml"` | Fetch the index, look up `(name, version, arch)`, fetch the entry's `archive_url`. `{abi}` is substituted with `ABI_VERSION` at resolve time. |
| Direct | `url = "https://.../foo.tar.zst"` + `sha256 = "..."` | Fetch the inline URL directly; verify against the inline sha. No index. |

The resolver picks the form by structural deserialization — mixing
forms in one `[binary]` block is a parse error.

### Homebrew bottles and package cache keys

Homebrew bottles are not Kandelo release archives. A formula may build a
Kandelo package by calling the same SDK and `packages/registry/<name>/build-*.sh`
script that a source build uses, but the resulting bottle is selected by
Homebrew's formula version, formula `revision`, bottle `rebuild`, bottle tag,
and `bottle do` block.

Kandelo still records the package `cache_key_sha` in Homebrew sidecar metadata
so VFS tooling can reject stale bottle bytes. When package output bytes change,
move the appropriate Homebrew formula revision or bottle rebuild so Homebrew
fetches new bytes. Bump `build.toml` `revision` only when the Kandelo package
archive cache key should change. Do not bump it for formula-only docs, tap
metadata, or browser-gallery wording.

See [docs/homebrew-publishing.md](homebrew-publishing.md) for the Homebrew
formula, sidecar, GHCR, VFS, and runtime validation contract.

### `arches`

`arches = ["wasm32", "wasm64"]` declares which target architectures
the manifest opts into. Read by the matrix flow's preflight (which
generates one `(package, arch)` entry per declared arch) and by
`scripts/fetch-binaries.sh` (one `xtask build-deps resolve` call per
declared arch). Defaults to `["wasm32"]` when omitted.

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

The cache-key sha for a library or program is computed over
`(name, version, revision, source.url, source.sha256, target_arch,
abi_version, declared outputs, declared build input digests, global
toolchain/sysroot input digests, sorted transitive dep cache-key
shas)`, where `revision` is read from `build.toml` (overlaid onto the
parsed `DepsManifest` at load time) and defaults to 1 when
`build.toml` omits it or is absent.

Program packages that use fork instrumentation also hash the
fork-instrument host tool inputs (`crates/fork-instrument`, the
workspace Cargo lockfile, and the wrapper/build scripts). Programs
that declare `fork_instrumentation = "disabled"` do not hash that
tooling.

The global toolchain/sysroot fingerprint covers the reproducible build
environment and sysroot recipe: the Nix flake, Rust toolchain file,
`scripts/dev-shell.sh`, musl build inputs, libc overlay/glue, the musl
submodule gitlink, and SDK compiler-driver inputs. It is deliberately
separate from the guest ABI number: a guest ABI bump invalidates
ABI-bound archives through `abi_version`, while a toolchain or sysroot
change invalidates them through this fingerprint.

That means:

- Same inputs → same sha → same cache path → shared artifact.
- Any change in the tree (including a distant transitive dep) invalidates
  every downstream consumer. No silent staleness.
- `revision` is the knob for "same upstream, different flags": bump
  it in `build.toml` when the build script or cross-compile config
  changes in a way that affects the output.

Inspect:

```bash
cargo xtask build-deps sha     zlib   # → e33c5e9a4383afdd…
cargo xtask build-deps path    zlib   # → ~/.cache/kandelo/libs/zlib-1.3.1-rev1-wasm32-e33c5e9a
cargo xtask build-deps parse   zlib   # → normalized dump of package.toml
cargo xtask build-deps resolve zlib   # → build-if-needed, then print the path
```

## Resolution order

`resolve <name>` walks the dep graph depth-first. For each library
in turn, it checks:

1. **`<repo>/local-libs/<name>/build/`** — hand-patched, in-progress.
   Returned as-is; the build script never runs. Per-worktree,
   gitignored. Mirrors `local-binaries/`.
2. **`<cache_root>/libs/<name>-<ver>-rev<N>-<arch>-<shortsha>/`** —
   canonical cache. Trusted by presence: users invalidate by
   deleting the directory or bumping `revision`.
3. **Index-based remote fetch** — load `build.toml`, resolve its
   `[binary]` block (typically to an `index_url`), fetch
   `index.toml` from that URL (with offline cache fallback at
   `~/.cache/kandelo/indexes/`), look up
   `(name, version, arch)`. For `status = success` entries fetch
   `archive_url`; for `status = failed/pending/building` with a
   `fallback_archive_url` use the last-green fallback. Verify
   archive sha256 + internal `[compatibility]` block
   (target_arch, abi_versions, cache_key_sha). Any verification
   failure logs a warning and falls through to step 4.
4. **Build from source** — run the declared `build.script_path`,
   validate declared outputs, atomically install into the
   canonical cache.

`cache_root` is `$XDG_CACHE_HOME/kandelo` if set, else
`$HOME/.cache/kandelo`.

## Build-script contract

The build script runs with these environment variables set. A script
that doesn't respect them cannot be cached safely.

| Variable | Meaning |
|---|---|
| `WASM_POSIX_DEP_OUT_DIR` | Temp dir the script must install into. Layout matches `outputs.libs` / `outputs.headers` / `outputs.pkgconfig` relative paths. |
| `WASM_POSIX_DEP_NAME` | `name` from package.toml. |
| `WASM_POSIX_DEP_VERSION` | `version` from package.toml. |
| `WASM_POSIX_DEP_REVISION` | Effective package revision after `build.toml` is overlaid. |
| `WASM_POSIX_DEP_SOURCE_URL` | Upstream tarball URL (`source.url` from package.toml). |
| `WASM_POSIX_DEP_SOURCE_SHA256` | Expected sha256 of the downloaded tarball. Scripts **must** verify after download — the resolver does not fetch. |
| `WASM_POSIX_DEP_<UPPER>_DIR` | For each *direct* dep, the resolved path to that dep's build output. `<UPPER>` is the dep name upper-cased, with `-` → `_` (e.g. `zlib-ng` → `ZLIB_NG`). Transitive deps are not surfaced — scripts that need them should declare them in `depends_on`. |

The libcxx package is intentionally stricter than ordinary source-fetching
packages. It builds the C++ standard library from the exact LLVM source
derivations exported by `flake.nix` (`WASM_POSIX_LLVM_LIBCXX_SOURCE` and
`WASM_POSIX_LLVM_LIBUNWIND_SOURCE`) and hard-fails if `LLVM_VERSION`,
`clang --version`, and `packages/registry/libcxx/package.toml` disagree.
That Nix-only restriction applies to rebuilding the repo's libcxx package
from source; it does not restrict normal SDK users compiling against a
published sysroot/libc++ artifact.

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

### Sysroot libraries are not packages

Some APIs are part of the Kandelo sysroot rather than the package graph. The
DRI/EGL/GLES shims (`libdrm.a`, `libgbm.a`, `libEGL.a`, `libGLESv2.a`) are
built by `scripts/build-musl.sh` and exposed through
`wasm32posix-pkg-config`; they are not outputs of the `kernel` package and
should not be modeled as standalone package dependencies.

A package that depends on those libraries should:

1. Source `sdk/activate.sh` and set `WASM_POSIX_SYSROOT` to the active worktree
   sysroot, as other package build scripts do.
2. Link with `wasm32posix-pkg-config --cflags/--libs` for `libdrm`, `gbm`,
   `egl`, and/or `glesv2`.
3. Declare only the consumer artifact in `[[outputs]]`.
4. Add the relevant sysroot/glue inputs (`libc/glue/lib*_stub.c`,
   `libc/glue/gl_abi.h`, `scripts/build-musl.sh`, `scripts/build-dri-stubs.sh`,
   `scripts/build-gles-stubs.sh`) to `build.toml.inputs` so cache keys move
   when the sysroot implementation changes.

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

The pcre2-source manifest (`packages/registry/pcre2-source/package.toml`):

```toml
kind = "source"
name = "pcre2-source"
version = "10.44"

[source]
url = "https://github.com/PCRE2Project/pcre2/releases/download/pcre2-10.44/pcre2-10.44.tar.gz"
sha256 = "86b9cb0aa3bcb7994faa88018292bc704cdbb708e785f7c74352ff6ea7d3175b"

[license]
spdx = "BSD-3-Clause"
```

No `[outputs]`, no `[build].script_path` — the resolver fetches and
extracts in-place into
`<cache_root>/sources/pcre2-source-10.44-rev1-<sha>/`. No
`<arch>` segment because source trees are arch-agnostic.

The MariaDB manifest (`packages/registry/mariadb/package.toml`):

```toml
depends_on = ["pcre2-source@10.44"]
```

The MariaDB build script (`packages/registry/mariadb/build-mariadb.sh`,
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
  Heisenbug character. See `packages/registry/erlang/build-erlang.sh`
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
`package.toml`, and install it directly into the resolver's cache.
A subsequent `cargo xtask build-deps resolve` then hits the
canonical cache path with no source build.

### Producer / consumer round-trip

The pipeline is **per-package + index-ledger**. There is no central
manifest in-tree; instead, every release tag carries a single
`index.toml` ledger that records every published archive's URL +
sha + cache-key. Each `packages/registry/<pkg>/build.toml` points its
`[binary]` entry at that ledger (typically via `index_url` with a
`{abi}` placeholder). The matrix flow uploads one `.tar.zst` per
`(package, arch)` entry AND atomically updates that package's
entry in `index.toml` under a state-lock, so consumers see a
consistent ledger after every per-package publish.

See [docs/binary-releases.md](binary-releases.md) for the
release-side perspective and
[docs/plans/2026-05-13-binary-resolution-via-index-ledger-design.md](plans/2026-05-13-binary-resolution-via-index-ledger-design.md)
for the design rationale.

**Producer — `cargo xtask archive-stage`:**

```bash
cargo xtask archive-stage \
    --package packages/registry/zlib \
    --arch wasm32 \
    --out /tmp/archives \
    --build-timestamp 2026-04-26T10:00:00Z \
    --build-host github.com/foo/bar@<sha>
```

It loads the package manifest, calls `ensure_built` to populate
the resolver cache when needed, then `archive_stage` to pack the
cache tree into

```
/tmp/archives/<name>-<version>-rev<N>-abi<N>-<arch>-<shortsha>.tar.zst
```

Each matrix entry then publishes via `scripts/index-update.sh`:

```bash
bash scripts/index-update.sh \
    --target-tag binaries-abi-v11 \
    --package zlib --version 1.3.1 --revision 1 --arch wasm32 \
    --status success \
    --archive-path /tmp/archives/zlib-...-wasm32-e33c5e9a.tar.zst \
    --archive-name zlib-1.3.1-rev1-abi11-wasm32-e33c5e9a.tar.zst \
    --cache-key-sha e33c5e9a...
```

The wrapper acquires the workflow-level state-lock for the target
tag, downloads the current `index.toml`, mutates this package's
entry via `xtask index-update`, uploads the archive + new
`index.toml` with `--clobber`, and releases the lock. Different
tags (durable `binaries-abi-v<N>` vs `pr-<N>-staging`) use
different lock subjects, so independent rebuilds don't block each
other.

**Consumer — `cargo xtask build-deps resolve <pkg>`** (called once
per package by `scripts/fetch-binaries.sh`):

```bash
cargo run -p xtask -- build-deps --arch wasm32 \
    --binaries-dir <repo>/binaries \
    resolve zlib
```

The resolver:

1. Reads `packages/registry/zlib/package.toml` (recipe) +
   `packages/registry/zlib/build.toml` (project view); overlays
   `revision` from build.toml onto the parsed manifest. If
   `package.pr.toml` exists alongside, applies it as an overlay
   (injects `[binary.<arch>]` entries into the in-memory manifest;
   legacy mechanism, still functional).
2. Resolves `build.toml`'s `[binary]` block:
   - Indexed form: substitutes `{abi}` in `index_url`, fetches
     `index.toml` (with offline cache fallback at
     `~/.cache/kandelo/indexes/`), looks up
     `(name, version, arch)`. For `status = success` uses
     `archive_url`; for `status = failed/pending/building` with a
     `fallback_archive_url` uses the last-green fallback.
   - Direct form: uses the inline `url` + `sha256`.
3. Fetches the archive via `remote_fetch::fetch_and_install_direct`,
   which handles fetch + verify + install. Both `https://` and
   `file://` URLs are accepted (the latter is what tests use to
   pin runner-local archives).
4. Library entries land in `<cache>/libs/<canonical>/`; program
   entries land in both the cache and
   `binaries/programs/<arch>/<output>.wasm` (a symlink into the
   cache) so browser/Node demos load by relative path.

### The injected `[compatibility]` block

`archive-stage` reads each package's source `package.toml`,
appends a `[compatibility]` block, and writes the result as
`manifest.toml` at the root of the archive (alongside an
`artifacts/` subtree carrying the built files). The block
carries five fields:

```toml
[compatibility]
target_arch = "wasm32"        # required: wasm32 | wasm64
abi_versions = [11]           # required: list of integers ≥ 1
cache_key_sha = "9acb9405…"   # required: 64-char lowercase hex
build_timestamp = "2026-04-26T10:00:00Z"   # optional, informational
build_host = "darwin-arm64"                # optional, informational
```

`DepsManifest::parse_archived` is the validator. It rejects:

- a missing or empty `[compatibility]` block (a source
  `package.toml` doesn't have one; an archived `manifest.toml` must),
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

Concrete example. Suppose a contributor's local `package.toml`
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

`remote_fetch` returns the cache-key-mismatch error, the
resolver logs a warning, and falls through to source build —
same outcome as if no archive had been published. This makes
ABI bumps and rev bumps non-fatal: stale archives just slow the
first run.

That is the strict-equivalence check the design relies on:
the archive is honored if and only if its source-side inputs
hash to exactly what this checkout would produce.

### Iterating on a package locally

When you edit an `packages/registry/<name>/package.toml` (or any input
that changes the package's `cache_key_sha` — `revision`,
`source.url`, `source.sha256`, transitive deps), the published
archive goes stale relative to your local state. The resolver
detects the mismatch via the `[compatibility]` block, logs a
warning, and falls through to a source build (`build-<name>.sh`).
No `--allow-stale` flag is needed: stale archives just slow the
first run.

The primary remedy is the per-PR staging-tag flow — push your
branch, let `staging-build.yml` rebuild the touched packages, and
each matrix entry's `scripts/index-update.sh` invocation publishes
its archive + index entry to the PR's `pr-<NNN>-staging` release
atomically. To consume those artifacts locally, run
`./run.sh --pr-staging browser` or set `WASM_POSIX_USE_PR_STAGING=1`.
`run.sh` detects the PR with `gh`, points
`WASM_POSIX_BINARY_INDEX_URL` at
`https://github.com/<owner>/<repo>/releases/download/pr-<NNN>-staging/index.toml`,
and leaves a manually set `WASM_POSIX_BINARY_INDEX_URL` unchanged.
That works for any `package.toml` or `build.toml` change pushed to a
PR with CI write access, and is the path code-review and merge both
use.

For pre-push iteration on packages whose source build is fast,
just rely on the resolver's fall-through: edit `package.toml`,
run `./run.sh browser`, and accept a one-time source build for
the touched package. Outputs land under
`local-binaries/programs/<arch>/`, which the Vite resolver and
`scripts/resolve-binary.sh` already prefer over `binaries/`.

### Worked example: zlib

Source manifest at `packages/registry/zlib/package.toml` (recipe):

```toml
kind = "library"
name = "zlib"
version = "1.3.1"
kernel_abi = 11
arches = ["wasm32", "wasm64"]
depends_on = []

[source]
url = "https://github.com/madler/zlib/releases/download/v1.3.1/zlib-1.3.1.tar.gz"
sha256 = "9a93b2b7dfdac77ceba5a558a580e74667dd6fede4585b91eefb60f03b72df23"

[license]
spdx = "Zlib"

[build]
script_path = "packages/registry/zlib/build-zlib.sh"

[outputs]
libs = ["lib/libz.a"]
headers = ["include/zlib.h", "include/zconf.h"]
pkgconfig = ["lib/pkgconfig/zlib.pc"]
```

And the sibling `packages/registry/zlib/build.toml` (project view):

```toml
script_path = "packages/registry/zlib/build-zlib.sh"
repo_url    = "https://github.com/brandonpayton/kandelo.git"
commit      = "<commit>"
revision    = 1

[binary]
index_url = "https://github.com/Automattic/kandelo/releases/download/binaries-abi-v{abi}/index.toml"
```

After `xtask archive-stage --package packages/registry/zlib --arch wasm32`,
one archive lands as

```
<out>/zlib-1.3.1-rev1-abi11-wasm32-e33c5e9a.tar.zst
```

(short sha `e33c5e9a` is the first 8 chars of the cache-key sha
for this manifest, identical to the canonical cache directory
suffix — `cargo xtask build-deps sha zlib` prints the full
form).

After publish, the matrix flow's `scripts/index-update.sh`
invocation has added an entry to the release's `index.toml`:

```toml
[[packages]]
name     = "zlib"
version  = "1.3.1"
revision = 1

[packages.binary.wasm32]
status         = "success"
archive_url    = "zlib-1.3.1-rev1-abi11-wasm32-e33c5e9a.tar.zst"
archive_sha256 = "<64-hex>"
cache_key_sha  = "e33c5e9a..."
built_at       = "2026-05-13T..."
built_by       = "https://github.com/.../actions/runs/<id>"
```

`build.toml` is **NOT** rewritten — no bot-PR amend. The
ledger on the release IS the consumer-visible state.

On the consumer side, `xtask build-deps resolve zlib` reads
`package.toml` + `build.toml`, substitutes `{abi}` in the
index_url, fetches `index.toml`, looks up `(zlib, 1.3.1, wasm32)`,
fetches the entry's `archive_url`, verifies bytes against
`archive_sha256`, runs the compatibility check, then unpacks
`artifacts/lib/libz.a`, `artifacts/include/{zlib.h,zconf.h}`,
and `artifacts/lib/pkgconfig/zlib.pc` into

```
<cache_root>/libs/zlib-1.3.1-rev1-wasm32-9acb9405/
```

A subsequent `cargo xtask build-deps resolve zlib` finds the
canonical path populated and returns it without re-running
`build-zlib.sh`.

### Shell-script wrapper

`scripts/fetch-binaries.sh` walks every
`packages/registry/<pkg>/package.toml` that has a sibling `build.toml`
with a `[binary]` block and
calls `xtask build-deps --binaries-dir <repo>/binaries resolve
<pkg>` once per declared arch. Packages without a `[binary]`
block (kernel, userspace, source-only, and metadata-only entries)
are skipped silently — those are local-build-only and the resolver's
fall-through to source build covers them on demand.

The matrix flow's CI workflows (staging-build, prepare-merge,
force-rebuild) all use the same per-package shape: one matrix
entry produces one `archive-stage` archive and atomically uploads
that archive plus the mutated release `index.toml`. There is no
bot rewrite of `package.toml` or `build.toml`.

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

By default the resolver looks in `<repo>/packages/registry/`. Override:

```bash
WASM_POSIX_DEPS_REGISTRY="./packages/registry:~/my-wasm-packages" \
    cargo xtask build-deps sha vim
```

Colon-separated. First hit wins — later entries have lower priority,
like `$PATH`. This is how third parties bring their own packages
without patching the repo: they drop a `<lib>/package.toml` into their
own directory tree and prepend it to the registry path.

The first external package source using this pattern is
[`brandonpayton/kandelo-software`](https://github.com/brandonpayton/kandelo-software):
it keeps package recipes under `packages/<name>/`, overlays them into a
Kandelo checkout for source builds, and publishes an ABI-scoped
`binaries-abi-v<N>/index.toml` from GitHub Actions. See
[docs/package-sources.md](package-sources.md) for the reusable workflow
and script contract.

`kandelo-software` also publishes `gallery.json` beside the release
index. The browser gallery treats that file as presentation metadata
and the release `index.toml` as the source of truth: a third-party VFS
entry is shown only when all packages listed for that entry have
successful wasm32 records in the ABI-matching index.

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
- `name`, `version`
- `[source].url`, `[source].sha256`
- `[license].spdx`

Optional:
- `depends_on` — same syntax as library/program manifests.
- `[build].script_path` — see "Override" below.
- `[[host_tools]]` — see the Host-tool requirements section below.

Rejected at parse time (the parser surfaces a clear error):
- `[outputs]` and `[[outputs]]` — sources have no built-artifact
  layout.
- `[binary]` and `[compatibility]` — those describe published
  binaries; sources are not published.

**Default fetch+extract behavior**

When `[build].script_path` is absent, the resolver fetches `source.url`,
verifies `source.sha256`, and extracts in-place. Format detection
is by URL extension: `.tar.gz` / `.tgz`, `.tar.xz` / `.txz`,
`.tar.bz2` / `.tbz2` / `.tbz`, `.tar.zst` / `.tzst`, `.zip`, and
plain `.tar`. Unrecognized extensions fail loudly rather than
guessing.

If the archive contains a single top-level directory (the
`pcre2-10.42/` shape), that wrapper is stripped — the cache
directory's contents are the contents of that single top-level
directory. Multi-top-level archives are kept as-is.

**Override `[build].script_path`**

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
- **CI-driven dep builds**: the matrix flow in
  `.github/workflows/staging-build.yml` builds every changed
  `(package, arch)` entry on PR push and uploads each archive
  per-package. Merging via the `ready-to-ship` label runs the same
  matrix against the durable `binaries-abi-v<N>` tag and amends
  every `[binary.<arch>]` block in-tree on a bot PR. See
  [docs/binary-releases.md](binary-releases.md) for the producer-
  side flow.
