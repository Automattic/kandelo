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
| Pull pre-built binaries without compiling | [`scripts/fetch-binaries.sh`](#release-archives) — walks every `package.toml`, calls the resolver. Run with `--allow-stale` in CI. |
| Add a new package to the registry | [Schema: `package.toml`](#schema-packagetoml) + [docs/porting-guide.md](porting-guide.md#adding-a-new-package-to-the-registry) for the end-to-end workflow. |
| Resolve one package on demand | `cargo xtask build-deps resolve <name>` — handles fetch/source-build, populates the cache. |
| Find where an output lands | `cargo xtask build-deps output-path <name> <declared-artifact>` — single source of truth for the layout convention (flat for a one-member output/runtime closure, nested under `<pkg>/` for two or more members). A basename is accepted only when unique. |
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

### `package.toml`

Required fields:

```toml
name = "zlib"              # logical library name; one safe path component
version = "1.3.1"          # upstream version; one safe path component
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
files = ["share/runtime-data.bin"]                   # other runtime data
```

The three in-tree Homebrew bridge recipes (`lsof`, `modeset`, and
`posix-utils-lite`) use a deliberately narrow `in-repository-source`
exception: `[source].url` is the authoritative Kandelo repository and an
all-zero SHA-256 is a mode sentinel, not a checksum. Homebrew publication
must bind such a recipe to a nonzero-checksum Formula URL of the exact form
`<source.url>/archive/<40-lowercase-hex-commit>.tar.gz`. Other recipes use a
normal source URL and checksum that must match the Formula exactly.

Source `package.toml` and project `build.toml` apply the same
`[build].script_path` contract: a nonempty ASCII repository-relative path of
normal components using only letters, digits, `.`, `_`, `@`, `+`, and `-`.
The complete path is at most 4096 bytes, each component is at most 255 bytes,
and absolute paths, empty components, `.`/`..`, backslashes, controls, and
whitespace are rejected. Historical archived manifests remain parseable for
artifact compatibility; the source-build resolver never executes their legacy
script field.

Program packages use `[[outputs]]` for executable/side-module artifacts. A
non-Wasm file required at runtime is declared separately so it remains part of
the same reproducible archive and cache key:

```toml
[[outputs]]
name = "php"
wasm = "php.wasm"

[[runtime_files]]
artifact = "icu.dat"                 # relative to the package cache/archive
guest_path = "/usr/lib/php/icu.dat"  # installation path in a VFS image
mode = 420                            # optional decimal TOML; default 0644
```

`[[runtime_files]]` is program-only. Artifact paths are normalized portable
relative paths; guest paths are normalized absolute POSIX paths; files,
ancestor paths, and resolver-mirror destinations may not collide. The resolver
requires regular non-symlink runtime files after fresh builds, cache hits, and
remote fetches. It mirrors them at
`{local-,}binaries/programs/<arch>/<package>/<artifact>` independently of the
number of `[[outputs]]` entries. Missing fetched files make the archive stale
and trigger source fallback (or a hard failure in fetch-only mode).

Build scripts install declared artifacts through
`scripts/install-local-binary.sh`. When
`WASM_POSIX_INSTALL_LOCAL_MIRROR=0` and `WASM_POSIX_DEP_OUT_DIR` are set,
both executable outputs and runtime files are copied only into that
caller-owned output root. The root is a single-writer scratch contract for the
duration of each install: the current user must own it and every destination
directory created or traversed within it, and group/other users may not write
those directories. The packaging-only shell helper enforces those observable
properties, publishes through a private create-once transaction, and compares
filesystem identity plus exact bytes before cleanup. It does not claim general
shared-directory race freedom; that would require dirfd/openat-style operations
rather than shell pathname commands. This mode does not require Rust, Cargo, or
`xtask`; the resolver validates the completed output root against `package.toml`
after the build script returns.

Repo-side VFS/test builders query the authoritative path and mode with
`xtask build-deps runtime-file-metadata <package> <artifact>`; they must not
scan library caches or invent environment-only guest paths. Published VFS
images contain the installed bytes already, so this query is a build-tool
contract rather than a runtime host API. The structured metadata also lists
the package's complete mirror closure (every `[[outputs]]` artifact plus every
`[[runtime_files]]` file). Repo-side consumers resolve that set from one
complete provenance root: a partial local override may fall back wholesale to
a complete fetched package, but local, fetched, and installed-package tiers
are never combined. If artifacts exist but no tier has the complete accepted
closure, resolution fails loudly.

The host resolver applies the same rule automatically when any member of a
program package with more than one total `[[outputs]]` plus
`[[runtime_files]]` entry is requested. This includes a package with one
executable and one runtime archive: both paths move under the package directory
and form one closure. Rust's complete TOML parser generates
`packages/registry/program-packages.json`, a closed, versioned projection of
package identity, target arches, exact source artifacts, resolver mirror paths,
fork policy, and runtime-file metadata. TypeScript and shell consumers read
that JSON; neither reparses `package.toml`.

Schema `kandelo-program-packages-v2` records every library, program, and source
package's manifest SHA-256 and cache key in both wasm32 and wasm64 consumer
contexts. A source package has the same cache key in both contexts because its
identity is architecture-independent. Each projected program also records its
complete transitive selected dependency identity for every supported
architecture. The host resolver, standalone shell bundle, and browser scanner
therefore validate the same first-hit registry context before accepting a
program mirror. Dependency order has no selection meaning and names must be
unique. The Rust generator emits a deterministic order so the checked-in JSON
is reproducible and CI can detect stale projections. Runtime consumers compare
the closure as a unique package-identity set, so reordering the same entries
does not change the accepted program identity.

An index describes the complete ordered registry context beginning at its
owning root, not only packages physically stored in that root. Its `identities`
map covers every first-hit package, and its `packages` map covers every
first-hit guest program across that root and all lower roots. The generator
reads each selected program's physical manifest for member policy, then
recomputes its cache key and dependency closure in the complete context. A
dependency-only external override can therefore rekey affected main-registry
programs without copying their manifests into the external root. The
highest-priority existing root's index is authoritative to consumers; lower
indexes are self-contained suffix-context fallbacks when higher roots are
absent, not fragments that consumers merge.

The program map covers guest programs published under
`binaries/programs/<arch>/`. A higher first-hit non-program package naturally
removes a same-named lower program from that map, while the lower physical
index retains a fail-closed claim against stale flat mirror fallback. The map
deliberately excludes Kandelo's first-party `kernel` and `userspace` boot
artifacts: their single outputs publish at `binaries/kernel.wasm` and
`binaries/userspace.wasm`, and retain their existing root-artifact ABI and
export validation instead of pretending to be guest program packages. Their
package identities remain in the all-package identity map so
dependency-context validation stays complete.

Generate or verify an index with:

```bash
cargo xtask build-deps program-index <registry-root> \
  <registry-root>/program-packages.json
cargo xtask build-deps program-index-check <registry-root> \
  <registry-root>/program-packages.json
cargo xtask build-deps program-index-context-check
```

The root passed to `program-index` or `program-index-check` must be the
highest-priority existing root in `WASM_POSIX_DEPS_REGISTRY`. Generate a lower
root's committed fallback with the registry suffix beginning at that root.
`build-deps check` verifies every present index against its own suffix context.
`program-index-context-check` is the stricter consumer boundary: it skips
nonexistent optional roots, requires an index for every existing configured
root, and validates each in its exact suffix context. Source-checkout program
resolution runs that Rust check before consuming generated policy.
The standalone `wasm-posix-host` package ships the same projection under
`wasm/`, so installed consumers retain closure and fork policy without carrying
source manifests.

`scripts/resolve-binary.sh` runs a checked-in standalone Node bundle generated
from the same TypeScript resolver, so clean checkouts do not need
`node_modules` merely to probe fetched artifacts. After changing the resolver
or its policy dependencies, regenerate and verify that bundle with
`scripts/build-resolve-binary-bundle.sh` and
`scripts/test-resolve-binary-bundle.sh`.
For program paths the wrapper incrementally builds the current release xtask
and exports its path as `WASM_POSIX_XTASK_BIN`. A direct caller may provide that
override, but doing so is an attestation that the executable was prepared from
the current source; the resolver deliberately does not rebuild an explicit
caller-owned tool path.

A registry directory without a regular `package.toml` is an ordinary
non-package path, matching Rust's lookup. A regular manifest is a first-hit
claim on that package name. If that selected package has no contextual
identity, a selected program has no program projection, or either manifest
digest is stale, package-owned lookup fails. Undeclared
nested members and the former flat spelling of a package-owned output are
errors too; they never fall through to scalar lookup. This also rejects stale
nested paths after a package changes from multi-member to scalar. All public
resolver entries reject
absolute, backslash, drive-prefixed, empty-component, `.`/`..`, and NUL path
spellings. `tryResolveBinary` returns `null` only for genuine absence and
rethrows corruption, policy rejection, and malformed package state.
Consumers that probe many unrelated optional programs synchronously use
`tryResolveBinaries`: it performs one source-projection freshness check, then
returns one path or `null` per request. This is intentionally different from
`tryResolveBinarySet`, which requires every requested path to be the complete
closure of one package and returns that closure from one provenance tier.
Batching independent probes does not weaken package closure validation:
requests that belong to the same package share one complete, pinned
generation, even when the caller requests only some members or repeats one.

Tier membership alone is not a package identity. Every selected symlink under
the mutable `local-binaries/` or `binaries/` mirrors must resolve through its
declared source-artifact suffix into one approved generation root. A fetched
generation root must be a canonically named direct child of the program-cache
namespace; a local generation root must be a direct child of that package's
hidden local-generation namespace. A preexisting directory whose links point
at different or arbitrary roots is rejected even when every mirror path
exists. A versioned installed host package is one immutable installation
identity, so a complete
all-regular-file closure under its `wasm/` tree remains supported;
regular-file/symlink mixtures and installed symlink closures are rejected.

Changing a package from a multi-member directory layout to a scalar flat path
does not delete the former package directory. The generated projection makes
that stale nested spelling inert immediately, while retaining the directory
avoids guessing whether another publisher or a user owns it. This safe
transition can leave stale mirror directories for explicit operational
cleanup; automatic ownership-marked retirement is deferred. An extensionless
scalar output whose exact flat name is that retained directory will fail
closed until the directory is deliberately retired.

Normal direct builds collect package closures under
`local-binaries/.kandelo-local-generations/<arch>/<package>/<cache-key>/<session>/`,
using the exact declared source suffix for each member. One sourced install
helper shares a session across its calls. The collector accepts only
create-once regular files, validates the complete tree, creates a one-shot
publication claim, and only then swaps the live package directory or scalar
link. A claimed generation is never recreated after its root disappears.
One-member packages retain their flat mirror name as a symlink to the
immutable generation member.

Scalar replacement and package-directory replacement reserve a unique private
transaction parent (mode 0700 on Unix), validate filesystem identity and exact
bytes or link maps before and after quarantine, and delete only unchanged
private entries. Scalar rollback uses an atomic no-replace rename, so a writer
that appears after a failed publication or quarantine check remains the winner;
changed or unvalidated quarantined state is preserved privately rather than
overwriting that winner. Concurrent publishers must replace resolver paths through
this pathname transaction; mutating an already quarantined regular file
through a previously held file descriptor is outside the supported writer
protocol and causes digest validation to fail whenever it is observed before
unlink.

For symlink-backed closures the host returns canonical generation-member paths,
not live mirror paths, so a later mirror-directory swap cannot retarget an
already resolved string. Local claimed generations are append-only unless a
user manually removes both resolver-owned state and backing bytes. Fetched
cache repair is a narrower boundary: force-source rebuild and stale-entry
recovery may remove and recreate the same cache-key directory, and the resolver
does not support that operation concurrently with same-package consumers. A
path retained across such repair can temporarily disappear or name replacement
bytes. See [Binary releases](binary-releases.md) for producer replacement,
rollback, crash-orphan, cache-repair, and platform boundaries.

Build scripts register executable outputs with `install_local_binary` and
declared data with `install_local_runtime_file`. Normal local builds mirror
both into `local-binaries/`. A normal executable install performs one
structured Rust lookup for the destination, exact declared artifact, and fork
policy before instrumentation or filesystem mutation. It never guesses a path
for an unregistered or malformed package. Package publication does not create
a second `sh` resolver output; guest images own their explicit `/bin/sh`
symlink to the shell they include.

A sealed publisher instead sets
`WASM_POSIX_INSTALL_LOCAL_MIRROR=0`, provides
`WASM_POSIX_DEP_OUT_DIR`, and supplies the reviewed fork-instrumentation policy
for executable outputs. In that mode the helpers copy the exact declared
artifacts only into caller-owned resolver scratch; they do not write into the
checkout or probe `rustc`, Cargo, or `xtask` merely to discover a local mirror
path. The resolver still validates every output against `package.toml` before
it can enter an archive.

Top-level keys are closed-schema: misspellings such as `[[runtime_file]]`
(singular) are rejected instead of silently dropping a runtime dependency.
Package names, versions, dependency names, and exact dependency-version tokens
must each be safe single filesystem components; `/`, `\`, NUL, `.` and `..`
spellings are rejected before cache, archive, or registry path construction.

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
inputs = ["packages/registry/zlib/build-zlib.sh"]
repo_url    = "https://github.com/Automattic/kandelo.git"
commit      = "<commit at last successful build>"
revision    = 1

[[git_inputs]]
name       = "homebrew_tap_core"
repository = "https://github.com/Kandelo-dev/homebrew-tap-core.git"
commit     = "<exact 40-character lowercase commit>"

[binary]
index_url = "https://github.com/Automattic/kandelo/releases/download/binaries-abi-v{abi}/index.toml"
```

- `script_path` typically equals `package.toml`'s `[build].script_path`;
  a project that monkey-patches a recipe sets its own override.
- `inputs` declares the complete repository-local source closure that can
  affect the built artifact. For JavaScript and TypeScript image builders,
  include every transitive runtime import from the declared source roots; the
  package-system import-closure test enforces that relationship for derived
  images. Type-only modules elided by `tsx` are not inferred, but an authored
  schema that belongs in artifact provenance may be declared explicitly.
  Canonical `packages/registry/<package>/...` inputs select the first registry
  root containing that package's `package.toml`, then require every declared
  file below that one selected package directory. A partial external shadow
  fails instead of filling missing files from a lower package generation, and
  a stray higher directory without `package.toml` cannot shadow main. The
  first-party non-package helper trees below `packages/registry` remain
  main-checkout inputs. Existing registry-relative input spellings apply the
  same package-level rule for third-party sources.
- `repo_url` + `commit` record the project's recipe provenance.
- `revision` is the publish-time counter the resolver hashes into
  the cache-key. Bump when output bytes legitimately change (build
  flag tweaks, fork-instrument output, etc.). Don't bump for doc-only
  changes — it triggers a needless rebuild across the matrix.
- `[[git_inputs]]` declares an external repository whose exact commit is part
  of the build recipe. Names start with a lowercase letter and contain only
  lowercase letters, digits, and underscores; repository URLs are anonymous
  HTTPS URLs; commits are full 40-character lowercase object IDs. The ordered
  `(name, repository, commit)` tuples are hashed into the package cache key
  before network access.
- `[binary]` declares where binaries are published. Two forms,
  exactly one of which must be present:

| Form | Example | Resolver behavior |
|---|---|---|
| Indexed (typical) | `index_url = "https://.../binaries-abi-v{abi}/index.toml"` | Fetch the index, look up `(name, version, arch)`, fetch the entry's `archive_url`. `{abi}` is substituted with `ABI_VERSION` at resolve time. |
| Direct | `url = "https://.../foo.tar.zst"` + `sha256 = "..."` | Fetch the inline URL directly; verify against the inline sha. No index. |

The resolver picks the form by structural deserialization — mixing
forms in one `[binary]` block is a parse error.

For each declared Git input, the source-build resolver performs an anonymous
exact-commit fetch with inherited Git credentials, configuration, and hooks
disabled. It rejects submodule gitlinks and symlinks that escape the checkout,
verifies a clean detached HEAD, seals the whole checkout read-only for the
build, and verifies it again afterward. A declaration named
`homebrew_tap_core` is exposed as:

- `WASM_POSIX_BUILD_GIT_HOMEBREW_TAP_CORE_DIR`
- `WASM_POSIX_BUILD_GIT_HOMEBREW_TAP_CORE_COMMIT`

Published archives record the same ordered declarations as
`[[compatibility.git_inputs]]`. Archive creation and remote consumption both
compare that vector exactly with the current `build.toml`; the archive SHA and
cache key are additional integrity bindings, not substitutes for that direct
provenance check.

### Homebrew bottles and package cache keys

Homebrew bottles are not Kandelo release archives. A formula may build a
Kandelo package by calling the same SDK and `packages/registry/<name>/build-*.sh`
script that a source build uses, but the resulting bottle is selected by
Homebrew's formula version, formula `revision`, bottle `rebuild`, bottle tag,
and `bottle do` block.

Kandelo records `cache_key_sha` in Homebrew sidecar metadata so VFS tooling can
reject stale bottle bytes. For a Homebrew bottle this key is the verified
bottle archive SHA-256, independent of whether the formula still has a legacy
package-registry entry. When package output bytes change, move the appropriate
Homebrew formula revision or bottle rebuild so Homebrew fetches new bytes. Bump
`build.toml` `revision` only when a legacy Kandelo package archive cache key
should change. Do not bump it for formula-only docs, tap metadata, or
browser-gallery wording.

Bottle-backed lazy VFS composition keeps the same archive as its transport
unit. The descriptor exposes bounded metadata for `stat` and `readdir`, but the
first content access downloads and verifies the complete Formula bottle and
atomically materializes its guest projection. It does not fetch individual TAR
members or use HTTP ranges. Dependency bottles have separate identities and
remain unfetched until a path owned by that dependency is used.

See [docs/homebrew-publishing.md](homebrew-publishing.md) for the Homebrew
formula, sidecar, GHCR, VFS, and runtime validation contract.

### Erlang/OTP target runtime contract

The `erlang` package cross-builds OTP; the Erlang executable in the developer
shell is a native OTP 28 bootstrap tool and is never a target artifact. The
recipe produces two coupled artifacts: the fork-instrumented `erlang.wasm`
executable output and `erlang-otp.tar.zst`, a declared runtime file containing
a relocatable core OTP tree. The archive
contains the kernel, stdlib, erts, and compiler applications, release boot
files, the installed `$ROOTDIR/bin/start.boot` contract, and target ERTS
helpers such as `erlexec` and `erl_child_setup`. Every Wasm helper carries the
package's declared Kandelo ABI and passes the ordinary artifact guards.

OTP's forker is part of the supported runtime path. Do not restore the retired
wasm32 patch that disabled it, and do not make allocator or database bounds
failures return synthetic success. BEAM starts the real forker, forks, and
execs `erl_child_setup`; Node validation must observe that descendant. The
remaining source changes are bounded compiler/portability workarounds (selected
translation units at `-O1`, explicit shadow-stack aggregate initialization,
and Wasm `call_indirect`-compatible driver signatures), not substitutes for
Kandelo POSIX behavior.

The trimmed core tree is an OTP embedded release. Launch it with
`-mode embedded`; its packaged modules are loaded from the release boot tree
instead of interactive code-server autoloading. This is not a claim that a
complete interactive OTP installation or every optional OTP application is
supported. A Homebrew Formula must test the exact keg through `erlexec` in
both the generic Node and Chromium runners, and the Node proof must require the
fork descendant rather than accepting output as a proxy for process exit.

The disabled legacy `erlang-vfs` compatibility recipe consumes `erlang`'s
declared runtime archive through the resolver; it does not read a
recipe-directory install tree or user cache. Its opt-in VFS image copies the
complete archive under `/usr/local/lib/erlang`, preserves executable modes,
and includes ABI metadata. Staging does not publish that image; the Homebrew
Formula turns the executable and runtime archive into the normal keg and
bottle distribution unit.

### `arches`

`arches = ["wasm32", "wasm64"]` declares which target architectures
the manifest opts into. Read by the matrix flow's preflight (which
generates one `(package, arch)` entry per declared arch) and by
`scripts/fetch-binaries.sh` (one `xtask build-deps resolve` call per
declared arch). Defaults to `["wasm32"]` when omitted.

The default reflects the project's wasm64 build policy: the kernel
is wasm64, but most ported user-space programs (dash, vim, perl,
etc.) ship wasm32 only. The packages that currently opt into
wasm64 are MariaDB, MariaDB-VFS, libcxx, zlib, OpenSSL, and SQLite.
PHP, libiconv, and libxml2 remain wasm32-only because their current recipes
invoke the wasm32 SDK explicitly. Adding a manifest to the wasm64 set is one
line, but the corresponding recipe and runtime/link validation must support
that architecture truthfully:

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
abi_version, declared outputs, declared build input digests, immutable
external Git identities, global
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
cargo xtask build-deps path    zlib   # → ~/.cache/kandelo/libs/zlib-1.3.1-rev1-wasm32-e33c5e9a4383afdd…
cargo xtask build-deps parse   zlib   # → normalized dump of package.toml
cargo xtask build-deps resolve zlib   # → build-if-needed, then print the path
```

## Resolution order

`resolve <name>` walks the dep graph depth-first. For each library
in turn, it checks:

1. **`<repo>/local-libs/<name>/build/`** — hand-patched, in-progress.
   Returned as-is; the build script never runs. Per-worktree,
   gitignored. Mirrors `local-binaries/`.
2. **`<cache_root>/libs/<name>-<ver>-rev<N>-<arch>-<cache-key-sha>/`** —
   canonical cache. The suffix is the complete 64-character SHA-256 so two
   identities that share an archive filename's eight-character label cannot
   alias locally. Packages with immutable Git inputs also require a matching
   adjacent provenance marker; users invalidate an entry by deleting it or
   bumping `revision`. Old short-key cache entries are left unused and rebuilt
   under the full-key path rather than migrated or trusted in place.

   The marker is a resolver-owned sibling named
   `.<canonical-cache-basename>.kandelo-provenance.toml`. It binds the schema,
   package identity and kind, target architecture (or `source-independent`),
   ABI when applicable, complete cache key, and ordered `git_inputs`. It is
   never copied into the package tree or release archive. Publication writes
   the marker before atomically installing the artifact, so a crash may leave
   a harmless marker-only orphan; the next build reuses it only if every field
   still matches and otherwise fails closed.
3. **Index-based remote fetch** — load `build.toml`, resolve its
   `[binary]` block (typically to an `index_url`), fetch
   `index.toml` from that URL (with offline cache fallback at
   `~/.cache/kandelo/indexes/`), look up
   `(name, version, arch)`. For `status = success` entries fetch
   `archive_url`; for `status = failed/pending/building` with a
   `fallback_archive_url` use the last-green fallback. Verify
   archive sha256 + internal `[compatibility]` block
   (target_arch, abi_versions, cache_key_sha, exact git_inputs). Any verification
   failure logs a warning and falls through to step 4.
4. **Build from source** — run the declared `build.script_path`,
   validate declared outputs, atomically install into the
   canonical cache.

`cache_root` is `WASM_POSIX_BINARY_CACHE_ROOT` when set, otherwise
`$XDG_CACHE_HOME/kandelo` or `$HOME/.cache/kandelo`. Rust, TypeScript, the
standalone resolver bundle, and Vite share this override. Absolute values are
used directly; relative values are anchored at the Kandelo repository root so
different process working directories cannot silently select different
caches. Installed npm consumers without a Kandelo source root must use an
absolute value.

## Build-script contract

The build script runs with these environment variables set. A script
that doesn't respect them cannot be cached safely.

| Variable | Meaning |
|---|---|
| `WASM_POSIX_DEP_OUT_DIR` | Caller-owned, single-writer temp dir the script must install into. The current user owns it and each destination directory traversed within it; none is group/other-writable. Layout matches `outputs.libs` / `outputs.headers` / `outputs.pkgconfig` / `outputs.files` relative paths. |
| `WASM_POSIX_DEP_NAME` | `name` from package.toml. |
| `WASM_POSIX_DEP_VERSION` | `version` from package.toml. |
| `WASM_POSIX_DEP_REVISION` | Effective package revision after `build.toml` is overlaid. |
| `WASM_POSIX_DEP_SOURCE_URL` | Upstream tarball URL (`source.url` from package.toml). |
| `WASM_POSIX_DEP_SOURCE_SHA256` | Expected sha256 of the downloaded tarball. Scripts **must** verify after download — the resolver does not fetch. |
| `WASM_POSIX_DEP_TARGET_ARCH` | Requested package architecture (`wasm32` or `wasm64`). A package that supports only one must reject the other before invoking its toolchain. |
| `WASM_POSIX_DEP_WORK_DIR` | Optional caller-owned scratch root. The sealed Homebrew Formula bridge sets this because its reviewed Kandelo checkout is read-only. Direct developer builds may retain a package-local default. |
| `WASM_POSIX_DEP_SOURCE_DIR` | Optional caller-verified, already-extracted source root. When present it takes precedence over downloading `SOURCE_URL`; the URL and SHA remain provenance/cache identity. |
| `WASM_POSIX_DEP_<UPPER>_DIR` | For each *direct* dep, the resolved path to that dep's build output. `<UPPER>` is the dep name upper-cased, with `-` → `_` (e.g. `zlib-ng` → `ZLIB_NG`). Transitive deps are not surfaced — scripts that need them should declare them in `depends_on`. |
| `WASM_POSIX_BUILD_GIT_<NAME>_DIR` | Read-only detached checkout for a `build.toml` `[[git_inputs]]` declaration. `<NAME>` is the injective uppercase form of the validated lowercase name. |
| `WASM_POSIX_BUILD_GIT_<NAME>_COMMIT` | Exact declared commit corresponding to that checkout. |

Scripts that accept the optional sealed-build roots should source
`scripts/package-build-roots.sh`. Explicit source, work, and output roots must
be absolute, normalized, real non-symlink directories with no pairwise overlap.
The source root is immutable input: copy it below the work root before patches,
configure steps, code generation, or compilation. Work products stay below the
work root, and only declared artifacts are installed into the output root. This
keeps the normal source-build path usable by Homebrew without granting write
access to either the reviewed Kandelo checkout or verified source tree.

The libcxx package is intentionally stricter than ordinary source-fetching
packages. It builds the C++ standard library from the exact LLVM source
derivations exported by `flake.nix` (`WASM_POSIX_LLVM_LIBCXX_SOURCE` and
`WASM_POSIX_LLVM_LIBUNWIND_SOURCE`) and hard-fails if `LLVM_VERSION`,
`clang --version`, and `packages/registry/libcxx/package.toml` disagree.
That Nix-only restriction applies to rebuilding the repo's libcxx package
from source; it does not restrict normal SDK users compiling against a
published sysroot/libc++ artifact.

After the script exits 0, the resolver verifies every path in
`outputs.{libs,headers,pkgconfig,files}` exists under `$WASM_POSIX_DEP_OUT_DIR`.
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
`{abi}` placeholder). Matrix jobs upload one `.tar.zst` per
`(package, arch)` entry and update the target release's package entry under a
state-lock. PR staging and Prepare-merge candidates are isolated releases.
Canonical ledgers use a marker, immutable generation, and transaction journal
so an interrupted replacement can be recovered without interpreting a missing
stable asset as an empty index.

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

By default, `archive-stage` preserves normal resolver behavior: a valid local
cache entry or indexed archive may satisfy the selected package. Exact source
execution proofs can add `--force-source-build`. That flag bypasses cache and
binary-index reuse only for the package passed to `--package`; dependencies
continue through ordinary resolution. For example, the main-shell proof uses
it to guarantee that the shell composer runs while its reviewed Homebrew
bottles remain ordinary immutable inputs.

When `archive-stage --cache-root <dir>` also uses `--binaries-dir`, later
processes consuming that symlink mirror must set
`WASM_POSIX_BINARY_CACHE_ROOT=<dir>`. This couples the mirror's canonical
targets to the same non-default cache in Rust, Node, shell, and browser
consumers instead of rejecting a valid generation as foreign.

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
entry via `xtask index-update`, uploads the content-addressed archive,
and publishes the new ledger before releasing the lock. Isolated PR
staging/candidate tags retain their mutable ledger. A canonical
`binaries-abi-v<N>` target delegates ledger publication to
`scripts/release-index-state.sh`; it never uses an unjournaled
`--clobber`. Different tags use different lock subjects, so
independent rebuilds do not block each other.

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
PR with CI write access. Prepare merge uses a separate run-specific
candidate initialized from canonical state; it never promotes the PR staging
ledger directly into the canonical release.

Staging reuse validates more than the release index. Its frozen snapshot binds
each package's version, revision, full cache key, archive size, and archive
SHA-256. Metadata-only preflight downloads every current entry that declares
`git_inputs` and compares the archive's embedded ordered vector with the fresh
expected ledger. A materialized candidate downloads and validates every archive
before exposing the localized `file://` index. Missing, extra, changed, or
reordered Git inputs; a mismatched archive identity; duplicate/noncanonical
`manifest.toml`; or a symlinked archive fails closed.

PR staging is not a durable dependency for a later workflow. When another
publication pipeline needs the exact selected closure after PR close, first
promote it through `promote-package-generation.yml` as described in
[Binary releases: durable package generations](binary-releases.md#durable-package-generations-for-cross-workflow-publication).
The promoter rebuilds a minimal index from only the fully materialized
archives. It deliberately drops unrelated staging entries and all last-green
fallbacks, then rewrites the selected archive URLs to one content-addressed
generation tag.

`.github/scripts/materialize-durable-package-generation.sh` activates such a
generation for a checkout. It downloads every asset anonymously, validates the
manifest/tag/release/direct-commit relationship and exact asset inventory,
revalidates archive manifests with current authority, and computes the
consumer checkout's own projection and expected ledger with its exact
credential-free `xtask`. Only exact equality exposes a local `file://` index.
The workflow authority commit, package-source commit, and consumer commit are
independent inputs; a newer consumer SHA alone is never evidence of package
compatibility.

For pre-push iteration on packages whose source build is fast,
just rely on the resolver's fall-through: edit `package.toml`,
run `./run.sh browser`, and accept a one-time source build for
the touched package. Outputs land under
`local-binaries/programs/<arch>/`, which the Vite resolver and
`scripts/resolve-binary.sh` already prefer over `binaries/`.

Both resolvers apply policy according to the requested artifact kind. A
`.wasm` executable must have an inspectable, current ABI and the required
exports and fork-instrumentation policy. A `.vfs` or `.vfs.zst` image must be
well formed and may not declare a different kernel ABI. Package archives,
Wasm side modules such as `.so` files, and declared runtime data do not use the
executable-Wasm policy; fetched copies have already been authenticated by the
package ledger, while `local-binaries/` remains an explicit developer override.

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
repo_url    = "https://github.com/Automattic/kandelo.git"
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
for this manifest. Release asset filenames use that compact transport
label, while the canonical local cache directory uses the full 64-character
key — `cargo xtask build-deps sha zlib` prints the full form).

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

`build.toml` is not rewritten after publication. Its ABI-templated
`index_url` remains stable; the ledger on the release is the
consumer-visible state.

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
and calls `xtask build-deps --binaries-dir <repo>/binaries resolve
<pkg>` once per declared arch. Packages without `build.toml` are skipped
silently — those are local-build-only and the resolver's fall-through to
source build covers them on demand.

Consumers that need a bounded artifact surface can repeat `--package <name>`:

```bash
bash scripts/fetch-binaries.sh --fetch-only \
  --package rootfs --package bash --package dash
```

With any `--package` flags, only those package roots are handed to the
resolver, in first-requested order; duplicate flags are ignored. The resolver
still traverses each root's declared dependency closure. Unknown packages,
packages without a publishable `build.toml`, unsafe names, and a package that
is simultaneously selected and listed in `WASM_POSIX_FETCH_SKIP_PKGS` fail
before materialization. Omitting `--package` preserves the full-registry walk.

The package workflows retain the same per-entry build shape but publish to
different lifecycle states. `staging-build.yml` writes a per-PR staging tag;
`prepare-merge.yml` writes and tests a run-specific isolated candidate; and
`force-rebuild.yml` is the manual canonical rebuild path. Post-merge
`activate-merge-candidate.yml` verifies the exact merged tree, copies all
required archives, then publishes one complete canonical ledger through the
journaled release-index state machine. There is no bot rewrite of
`package.toml` or `build.toml`.

## Atomic cache install

The script builds into `<canonical>.tmp-<pid>/`, not the final path.
On success the resolver calls `rename(2)` from temp to final. Readers
in other worktrees either see the full previous version of the cache
entry or the full new one — never a partial write.

If two builds of the same cache key race, the first `rename` wins.
The second notices the canonical path exists and discards its own
temp dir. Identical inputs yield identical outputs, so keeping either
copy is correct.

This race rule covers creation of a previously absent cache key. Maintenance
that deliberately removes an existing key—force-source rebuild or stale-cache
repair—uses the resolver's existing no-concurrent-same-package assumption.
Consumers must not retain or read canonical member paths concurrently with
that maintenance because the directory can be absent and then recreated under
the same pathname. Live mirror publication remains atomic; this boundary is
about maintenance of the backing cache itself.

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
own directory tree, generate that root's `program-packages.json`, and prepend
it to the registry path. Rust builds, TypeScript resolution, and
`scripts/resolve-binary.sh` use the same exact roots and first-hit package
selection.

Generate the external root's index against `external:main`. That complete top
index includes external programs and every selected lower program, each with
the exact combined first-hit cache key and dependency closure. An identical
higher-priority shadow leaves identities unchanged. A changed direct or
transitive dependency rekeys only the affected programs; those programs remain
eligible for normal exact-key fetch or source build instead of reusing
main-only bytes. Consumers do not synthesize or merge policy: they verify the
complete top projection. If the external root is absent, the main root's
committed suffix-context index becomes authoritative again.

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
<cache_root>/sources/<name>-<version>-rev<N>-<cache-key-sha>/
```

`<cache-key-sha>` is the complete 64-character SHA-256. No `<arch>` segment —
sources are arch-agnostic by definition.
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
