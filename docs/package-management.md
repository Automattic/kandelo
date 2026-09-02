# Package management (Wasm packages)

How we declare, build, cache, and publish the artifacts the project
produces — static libraries (zlib, ncurses, openssl, libcurl,
libxml2, libpng, sqlite, libcxx, …), ported programs (vim, git, php, …),
source trees that consumer builds reach into (PCRE2 for MariaDB,
…), and the host-tool requirements that gate them all.

**Goal**: every artifact is reproducible from a manifest and cached by
content hash on the local machine. Package resolution is local-first:
every package is always source-built through the SDK/libc/resolver and
cached locally. There is no remote prebuilt-binary channel. The same
machinery serves two audiences:

- A developer running `./run.sh setup` or `./run.sh local-build` whose
  local edits invalidate the affected cache keys and trigger a source
  rebuild of exactly the changed packages.
- A developer overriding an artifact by hand via `local-libs/` or
  `local-binaries/`, which the resolver prefers over the cache.

**Scope**: static-library artifacts (`.a` + headers + pkgconfig),
ported program binaries (`.wasm`), composite VFS images (`.vfs.zst`),
and source-tree extracts. Programs continue to statically link;
this work caches the build outputs, not the linker step. Runtime
`.so` loading is out of scope (see "Out of scope" below).

## Quick reference (jump-table)

Most readers want one of these. Detailed sections follow further down.

| I want to…                                    | Look at                                                                                                                                                                                                                                                            |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Add a new package to the registry             | [Schema: `package.toml`](#schema-packagetoml) + [docs/porting-guide.md](porting-guide.md#adding-a-new-package-to-the-registry) for the end-to-end workflow.                                                                                                        |
| Resolve one package on demand                 | `cargo xtask build-deps resolve <name>` — source-builds if needed, populates the local cache.                                                                                                                                                                      |
| Build every local VFS product                 | [Local DAG build](#local-dag-build) — one parallel, resumable command for all seven products and their package dependencies.                                                                                                                                       |
| Find where an output lands                    | `cargo xtask build-deps output-path <name> <declared-artifact>` — single source of truth for the layout convention (flat for a one-member output/runtime closure, nested under `<pkg>/` for two or more members). A basename is accepted only when unique.         |
| Migrate a build script to consume cached deps | [Migrating a consumer to the cache](#migrating-a-consumer-to-the-cache) — the `WASM_POSIX_DEP_*_DIR` contract + CPPFLAGS/LDFLAGS pattern.                                                                                                                          |
| Override an artifact locally                   | Drop the file at `local-binaries/programs/<arch>/<rel>` or `local-libs/<pkg>/build/`. The resolver prefers these over the cache.                                                                                                                                   |
| Bump a package's revision number              | Edit `revision = N` in its `build.toml` (NOT `package.toml` — `revision` lives in the project-view file). Invalidates the local cache for that package. Only bump when output bytes legitimately change.                                                            |
| Isolate a worktree's build cache              | Set `KANDELO_SOURCE_CACHE_ROOT=<absolute path>` before `./run.sh local-build` / `setup` / `bootstrap`. The SourceOnly cache is shared across every worktree on the machine by default (content-addressed, so identical inputs build once and are reused everywhere — this is what keeps a fresh worktree fast); the override gives this worktree its own cache. Useful when an in-progress change alters cached artifact bytes and you don't want it churning the shared cache. Leave unset to share.                     |
| Publish package recipes from another repository | [docs/package-sources.md](package-sources.md) — package-source layout for source-built recipes consumed via `WASM_POSIX_DEPS_REGISTRY`.                                                                                                                          |
| Trace an ABI mismatch                         | [docs/abi-versioning.md](abi-versioning.md).                                                                                                                                                                                                                       |
| See what's missing                            | [docs/package-management-future-work.md](package-management-future-work.md).                                                                                                                                                                                       |

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

## Local DAG build

From the repository root, build all seven local VFS products and their
transitive package dependencies with:

```bash
./run.sh local-build
```

The wrapper uses an active direnv/Nix development shell when available and
enters the repository dev shell only when necessary. It selects every active
product, uses 16 concurrent jobs, stores verified sources below
`$HOME/.cache/kandelo/source-only`, and publishes the validated projection to
`local-binaries/source-only-v1`.

The default output ends with a concise node, cache, build, and product
summary. Pass `--json` to print the canonical machine-readable result instead:

```bash
./run.sh local-build --json
```

For custom product selections or paths, invoke the xtask `local-build run`
command directly. `--product all` selects every active product; omitting
`--product` has the same effect. Multiple `--product <id>` options select only
those products and their transitive package dependencies. `--jobs` bounds
concurrently running nodes; ready nodes start as soon as their own dependencies
finish.

The machine-readable result contains every selected node and whether it was
newly published or reused from cache. If a node fails, independent work drains
and the command exits nonzero after printing failed and blocked counts. Fix the
failure and run the same command again: successful content-addressed nodes are
reused, while the missing failed node runs again. `--rebuild` deliberately
forces the selected nodes and is not needed for ordinary recovery.

Retrying a failed node while the original aggregate process remains active is
not supported today; that additive workflow is recorded in
[package-management future work](package-management-future-work.md#retry-a-failed-node-during-an-active-aggregate).

## Artifact invalidation model

Use precise artifact concepts when changing CI gates or package cache
keys:

- **Kernel implementation**: Rust kernel behavior changed, but the
  guest-visible contract did not. Build and test a fresh `kernel.wasm`
  against existing package archives; do not rebuild package archives.
- **Guest ABI epoch**: the binary contract compiled into user programs
  changed incompatibly. This is `ABI_VERSION` in
  `crates/shared/src/lib.rs`; a bump intentionally changes every
  library/program cache key, so every package is rebuilt from source
  under the new key.
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

- **Package build input**: can change package cache keys or built
  output bytes; run the package build/validation for the affected
  packages and their transitive dependents.
- **Kernel/runtime**: can change the fresh kernel/runtime/test side of
  the system; build the package set from source and test it against the
  fresh kernel.

Do not use a package rebuild as a proxy for "tests should run."
Kernel/runtime PRs still run their targeted validation without
rebuilding unaffected packages. Unknown non-doc paths should also run
the non-package test gate as a fail-safe, but should not trigger a
package rebuild unless they are package build inputs.

### Current package-backed root and shell images (2026-08-24)

The package registry owns both the base rootfs and browser shell. Rootfs
revision 11 composes only declared Kandelo package outputs. Shell revision 29
extends that exact rootfs package artifact with shell demo assets and records
the base artifact's digest, byte length, and kernel ABI.

The rootfs package embeds `login` because the terminal session needs it at
boot. `sudo-lite`, upstream `sudo`, and the ordinary command set remain lazy
package outputs. All three privileged commands are installed as root-owned
`04755` files; ordinary VFS mode and mount semantics decide their credential
effect. The image-owned experimental terminal declaration starts
`login -p -f maker` once and then uses `login -p` after logout.

The shell and new login packages are pending publication while this change is
under review. Their `commit = "UNPUBLISHED"` placeholders must be stamped with
the truthful producer commit before release. Changes to the base image, shell
composition, or terminal declaration rebuild the reverse-dependent image
closure:

- `rootfs` revision 11;
- `shell` revision 29;
- `node-vfs` revision 22;
- `lamp` revision 17;
- `wordpress` revision 18; and
- `nginx-vfs` and `nginx-php-vfs` revision 7.

Each derived image verifies and records the exact package-shell digest and
bytes. It therefore cannot silently combine a new Node, nginx, PHP, or
WordPress payload with an older shell. The shell recipe also owns the complete
source closure used by its image tools; imported repository modules are
explicit build inputs.

### Canonical VFS product authority

Canonical VFS product manifests are the lasting product authority. The TOML
files under `images/vfs/products/` own stable product identity, architecture,
output filename, the builder adapter, product composition, declared software
roots and roles, embedded-versus-lazy intent, filesystem and boot intent, and
evidence definitions. Their generated catalog is a canonical projection, not
a second place to edit product intent.

Pages and tests select products through registries owned by those consumers.
Ordinary
software recipes in `packages/registry/` continue to own portable source,
license, dependency, output, and build facts. Obsolete package entries whose
primary product is a VFS wrapper are checked transitional adapters only: they
remain usable during rollout, cannot independently add software inputs, and
are listed for eventual removal in `abi/staging/legacy-retirement.toml`.

The staging builder boundary resolves every permitted software input before a
builder starts. A builder can request inputs only by declared stable ID and
must report every consumed digest, byte count, role, and placement. Missing,
extra, mismatched, or incompletely captured inputs fail closed. A declared
lazy product or package layer may stay lazy; resolving an input does not imply
embedding it.

This is currently a checked-in authority and local validation foundation. It
does not yet issue remote requests, publish candidates, or verify hosted
artifacts.

## Schema: `package.toml` (recipe) + `build.toml` (project view)

Every package ships TWO TOML files in `packages/registry/<name>/`:

```
packages/registry/zlib/
    package.toml              ← the recipe (project-agnostic)
    build.toml                ← project's build + publish state
    build-zlib.sh             ← builds it (invoked by the resolver)
```

The split separates the portable recipe from this project's build state:

- **`package.toml`** carries identity-and-constraints: who the
  package is, what it depends on, where its source comes from,
  what license it ships under. **Project-agnostic** — the exact
  same `package.toml` would work in any project that wants to
  consume this package.
- **`build.toml`** carries this project's view: which commit built
  it, its declared build inputs, and its cache-key `revision`.
  **Project-specific** — every fork or downstream consumer gets its
  own `build.toml`.

### `package.toml`

Required fields:

```toml
name = "zlib"              # logical library name; one safe path component
version = "1.3.1"          # upstream version; one safe path component
depends_on = []            # ["zlib@1.3.1", ...] — exact versions, no ranges

[source]
url = "https://github.com/madler/zlib/releases/download/v1.3.1/zlib-1.3.1.tar.gz"
sha256 = "9a93b2b7dfdac77ceba5a558a580e74667dd6fede4585b91eefb60f03b72df23"
provider = "archive"

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

`[source].provider` declares how source bytes enter a local build:

- `archive` requires a nonzero 64-character lowercase SHA-256 and a supported
  archive suffix. Query strings and fragments do not affect suffix detection.
- `repository` requires the all-zero SHA sentinel. Its source-only identity is
  the declared `build.toml.inputs` closure from the current repository, not a
  Git branch, `HEAD`, or `build.toml.commit`.
- `dev-shell` requires the all-zero SHA sentinel. It is currently used only by
  `libcxx`, whose identity binds the exact LLVM 21.1.7 compiler and Nix source
  paths supplied by the repository dev shell.

The checked-in local-supported authority must spell the provider explicitly.
For compatibility, source and archived manifests that predate this field still
parse: a nonzero SHA infers `archive`, while the all-zero sentinel infers
`repository`. Explicitness is migration metadata and never changes semantic
cache identity.

Source-only Repository and DevShell declared-input hashing currently requires
Unix descriptor-relative filesystem validation. Native Unix hosts, the Nix
development shell on Unix, and Linux under Windows Subsystem for Linux (WSL)
use that supported path. Native non-Unix hosts fail before cache lookup with a
stable unsupported-platform error; native Windows support requires a future,
separately reviewed reparse-safe handle traversal. This boundary does not
restrict Archive providers or the Default resolution policy.

`source.extract_exclude_members` is an exceptional Archive-only compatibility
boundary for a verified upstream archive whose members cannot coexist on the
host filesystem, such as a root `BUILD` file alongside a `build/` directory on
case-insensitive macOS volumes. Each value is the exact normalized portable
member path before single-wrapper-directory flattening. Values must be sorted,
unique, and may name only regular files. Extraction fails if an authorized
member is absent, duplicated, or has another type; no unlisted member is
omitted. The verified archive bytes remain unchanged in the shared source
cache, while the nonempty exclusion list participates in the SourceOnly cache
identity. Do not use this field to remove ordinary unwanted upstream content.

Archive bytes use only their verified SHA-256 as the immutable shared-source
identity. Provider, package, Application Binary Interface (ABI), and compiled
artifact policy do not enter that archive-cache address. Source-only compiled
keys separately bind provider semantics and declared build inputs.

The in-tree repository-backed recipes `lsof`, `modeset`, and
`posix-utils-lite` use `[source].url` as the authoritative Kandelo repository
and the all-zero SHA as a mode sentinel.

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
requires regular non-symlink runtime files after fresh builds and cache
hits. It mirrors them at
`{local-,}binaries/programs/<arch>/<package>/<artifact>` independently of the
number of `[[outputs]]` entries.

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

The repo-side bridge incrementally builds the current release `xtask` once and
then executes that prepared binary for metadata queries. CI and other direct
callers may provide `WASM_POSIX_XTASK_BIN`; as with program-index checking,
that override attests that the regular file was prepared from the current
source. The bridge does not rebuild or silently substitute an explicitly
provided tool.

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
deliberately excludes Kandelo's first-party `kernel` boot artifact: its
single output publishes at `binaries/kernel.wasm`, and retains its existing
root-artifact ABI and export validation instead of pretending to be a guest
program package. Its package identity remains in the all-package identity map
so dependency-context validation stays complete.

Generate or verify an index with:

```bash
KANDELO_ROOT="$(pwd -P)"
cargo xtask build-deps program-index --source-repo-root "$KANDELO_ROOT" \
  <registry-root> \
  <registry-root>/program-packages.json
cargo xtask build-deps program-index-check \
  --source-repo-root "$KANDELO_ROOT" \
  <registry-root> \
  <registry-root>/program-packages.json
cargo xtask build-deps program-index-context-check \
  --source-repo-root "$KANDELO_ROOT"
```

`--source-repo-root` names the canonical Kandelo checkout that owns every
repo-relative recipe input, global toolchain input, and fork-instrument Cargo
identity. This matters when several worktrees share a Cargo target directory:
the reused executable may have been compiled in another checkout. A copied or
reused xtask therefore must receive this flag. The no-flag form remains safe
only when the current checkout is the same canonical checkout in which xtask
was compiled; otherwise it fails before reading package identity.

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
Relocatable prepared workspaces preserve fetched package identity by copying
each referenced canonical generation under `.ci-test-binary-cache/programs/`
and rewriting the `binaries/` mirrors as contained relative symlinks. Consumers
must select that transported cache explicitly with
`WASM_POSIX_BINARY_CACHE_ROOT`; the resolver does not implicitly trust a hidden
directory merely because it is inside a source checkout. Formula-test
publication and conformance-workspace packing share one staging helper so
neither path can regress to identityless regular-file mirrors.

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
immutable generation member. The kernel package follows the same identity
contract even though its compatibility mirror lives at
`local-binaries/kernel.wasm` instead of below `programs/<arch>/`. A later
release materialization preserves either a complete package-directory closure
or a scalar mirror only when every link selects one claimed generation with
the exact current contextual cache key. Identityless regular or
non-generation kernel mirrors, mixed sessions, symlinked ownership ancestors,
and stale manifest or dependency identities fail closed instead of silently
replacing the exact local candidate with released bytes; rebuild the local
package to establish a current generation.

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
user manually removes both resolver-owned state and backing bytes. Cache
repair is a narrower boundary: force-source rebuild and stale-entry
recovery may remove and recreate the same cache-key directory, and the resolver
does not support that operation concurrently with same-package consumers. A
path retained across such repair can temporarily disappear or name replacement
bytes.

Build scripts register executable outputs with `install_local_binary` and
declared data with `install_local_runtime_file`. Normal local builds mirror
both into `local-binaries/`. A normal executable install performs one
structured Rust lookup for the destination, exact declared artifact, and fork
policy before instrumentation or filesystem mutation. It never guesses a path
for an unregistered or malformed package. Package publication does not create
a second `sh` resolver output; guest images own their explicit `/bin/sh`
symlink to the shell they include.

Executable registration also fails closed on unresolved imports in Kandelo's
reserved `env.__wasm_posix_*` namespace. The SDK deliberately permits undefined
symbols for real host APIs, but a new reserved import is accepted only after
the host implements it and the shared artifact guard explicitly allows it.
This prevents an ABI-current glue object linked against a stale musl sysroot
from turning a private libc helper into a runtime trap and then caching or
publishing that broken executable.

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

`package.toml` **must NOT** carry `revision`, `[build].repo_url`, or
`[build].commit`. Those are project-view fields that live in
`build.toml`; `validate_source` rejects them in `package.toml` with a
clear error message pointing at the new home.

### `build.toml`

Required (unless the package is `kind = "source"` with no `[build]`
block — those packages have no build output):

```toml
script_path = "packages/registry/zlib/build-zlib.sh"   # mirrors package.toml
inputs = ["packages/registry/zlib/build-zlib.sh"]
repo_url    = "https://github.com/Automattic/kandelo.git"
commit      = "<commit at last successful build>"
revision    = 1

[[git_inputs]]
name       = "vendor_recipes"
repository = "https://github.com/Kandelo-dev/vendor-recipes.git"
commit     = "<exact 40-character lowercase commit>"
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
  A `repository` or `dev-shell` provider makes this list mandatory and
  nonempty for source-only builds. Before a source-only cache key is computed,
  every authored label must already be its canonical portable
  repository-relative spelling. On Unix, one descriptor-relative traversal
  rejects missing or unreadable paths, symlink roots, ancestors, or
  descendants, filesystem escapes, and special nodes while hashing the exact
  opened regular files and directories. It revalidates the full descriptor
  chain before returning the digest, so validation cannot be followed by a
  pathname reopen of a substituted object. Native non-Unix hosts fail closed
  before cache lookup as described above. These stricter checks are limited to
  source-only Repository/DevShell inputs, so Archive, Default, and published
  cache-key bytes retain their historical behavior and identity.
- `repo_url` + `commit` record the project's recipe provenance.
- `revision` is the counter the resolver hashes into the cache-key.
  Bump when output bytes legitimately change (build flag tweaks,
  fork-instrument output, etc.). Don't bump for doc-only changes — it
  triggers a needless source rebuild of that package and its dependents.
  A new upstream version may restart the counter.
- `[[git_inputs]]` declares an external repository whose exact commit is part
  of the build recipe. Names start with a lowercase letter and contain only
  lowercase letters, digits, and underscores; repository URLs are anonymous
  HTTPS URLs; commits are full 40-character lowercase object IDs. The ordered
  declarations are hashed into the package cache key before network access.

For each declared Git input, the source-build resolver performs an anonymous
exact-commit fetch with inherited Git credentials, configuration, and hooks
disabled. It rejects submodule gitlinks and symlinks that escape the checkout,
verifies a clean detached HEAD, seals the whole checkout read-only for the
build, and verifies it again afterward. A narrowly scoped input that needs
Git-tracked but intentionally uninitialized submodule directories may declare
the exact commit tree as `tree` and set `allow_uninitialized_gitlinks = true`.
The permission defaults to false; both fields enter the package cache
identity. Every permitted gitlink must materialize as an empty real directory
without symlinked path components, while all ordinary tracked files remain
required. A declaration named
`vendor_recipes` is exposed as:

- `WASM_POSIX_BUILD_GIT_VENDOR_RECIPES_DIR`
- `WASM_POSIX_BUILD_GIT_VENDOR_RECIPES_COMMIT`

The ordered declarations are part of the package cache key, so a changed
Git input invalidates the cached build and triggers a source rebuild.

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
supported. The package recipe must test the exact runtime through `erlexec` in
both the generic Node and Chromium runners, and the Node proof must require the
fork descendant rather than accepting output as a proxy for process exit.

The disabled legacy `erlang-vfs` compatibility recipe consumes `erlang`'s
declared runtime archive through the resolver; it does not read a
recipe-directory install tree or user cache. Its opt-in VFS image copies the
complete archive under `/usr/local/lib/erlang`, preserves executable modes,
and includes ABI metadata. Staging does not publish that image.

### `arches`

`arches = ["wasm32", "wasm64"]` declares which target architectures
the manifest opts into. Read by the local-build DAG, which resolves one
`(package, arch)` entry per declared arch. Defaults to `["wasm32"]` when
omitted.

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
independent of this field — `arches` only governs which arches the
local-build DAG resolves for a package. A locally-built wasm64 artifact
still populates `local-binaries/programs/wasm64/...` regardless of what
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

Source-only cache keys add the stable semantic marker
`kandelo-source-provider-v1\0` followed by `archive\0`, `repository\0`, or
`dev-shell\0`. They never hash whether the provider spelling was explicit.
For Archive providers, a nonempty `extract_exclude_members` list is
length-delimited into the same SourceOnly identity; the legacy Default key is
unchanged.
Repository identities therefore follow declared bytes across Git checkouts and
ignore project refs and informational commits. The `libcxx` dev-shell identity
binds the locked `flake.nix` and `flake.lock` bytes through declared build
inputs. It also length-binds the exact LLVM 21.1.7 version, canonical compiler
prefix, complete bounded `clang --version` output, and canonical
libcxx/libcxxabi/libunwind Nix source roots. Missing, mismatched, symlinked,
non-store, non-UTF-8, oversized, or failing compiler/source inputs fail before
cache lookup. The declared Repository/DevShell byte traversal is currently a
Unix-only capability: native non-Unix hosts return the documented
unsupported-platform error rather than using a weaker pathname-based digest.

Program packages that use fork instrumentation also hash the
fork-instrument host tool inputs (`crates/fork-instrument`, the
target-unfiltered non-dev Cargo dependency closure selected from the
workspace lockfile, and the wrapper/build scripts). The dependency closure is
the union across build-host target predicates: package cache paths do not have
a build-host dimension, so filtering through the current macOS or Linux host
would give identical source trees different identities. Programs that declare
`fork_instrumentation = "disabled"` do not hash that tooling.

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
   never copied into the package tree. The build writes the marker before
   atomically installing the artifact, so a crash may leave a harmless
   marker-only orphan; the next build reuses it only if every field
   still matches and otherwise fails closed.

3. **Build from source** — run the declared `build.script_path`,
   validate declared outputs, atomically install into the
   canonical cache.

There is no remote-fetch tier: a cache miss always falls through to a
local source build.

`cache_root` is `WASM_POSIX_BINARY_CACHE_ROOT` when set, otherwise
`$XDG_CACHE_HOME/kandelo` or `$HOME/.cache/kandelo`. Rust, TypeScript, the
standalone resolver bundle, and Vite share this override. Absolute values are
used directly; relative values are anchored at the Kandelo repository root so
different process working directories cannot silently select different
caches. Installed npm consumers without a Kandelo source root must use an
absolute value. The resolver also exports the exact selected root to every
source-build child as `WASM_POSIX_BINARY_CACHE_ROOT`. This value comes from
that invocation's `ResolveOpts`, not from ambient child state, so nested
Rust, TypeScript, and standalone resolver calls share the direct
dependencies' cache identity.

The SDK's `pkg-config` wrapper filters inherited host-library search paths so a
native Nix library cannot satisfy a Wasm configure probe. Today that filter
recognizes package-cache paths by the `kandelo/` namespace used by the default
cache roots. An explicit cache root used for source builds must preserve that
namespace when its declared dependencies provide `.pc` metadata. A source
build that uses a private cache root (for example under `$RUNNER_TEMP/kandelo/`
in CI) therefore keeps the `kandelo/` namespace; the resolver still constructs
`WASM_POSIX_DEP_PKG_CONFIG_PATH` only from the selected dependency graph.

This pathname test is a target-versus-host contamination guard, not package
authentication. A future SDK change should instead canonicalize each candidate
path against the resolver-selected `WASM_POSIX_BINARY_CACHE_ROOT` and declared
`WASM_POSIX_DEP_<UPPER>_DIR` roots. Because `sdk/src` is a global package
toolchain input, that migration must be coordinated with a full package cache
identity rotation rather than folded into an isolated publication repair.

This is an identity and pathname contract, not an operating-system lease.
Normal same-user cache generations are immutable; force-source rebuild or
stale-cache repair must not remove or replace a generation while a build or
consumer is using it. See [Atomic cache install](#atomic-cache-install) for
the supported creation race and this maintenance boundary.

## Build-script contract

The build script runs with these environment variables set. A script
that doesn't respect them cannot be cached safely.

| Variable                             | Meaning                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `WASM_POSIX_DEP_OUT_DIR`             | Caller-owned, single-writer temp dir the script must install into. The current user owns it and each destination directory traversed within it; none is group/other-writable. Layout matches `outputs.libs` / `outputs.headers` / `outputs.pkgconfig` / `outputs.files` relative paths.                                                          |
| `WASM_POSIX_DEP_NAME`                | `name` from package.toml.                                                                                                                                                                                                                                                                                                                        |
| `WASM_POSIX_DEP_VERSION`             | `version` from package.toml.                                                                                                                                                                                                                                                                                                                     |
| `WASM_POSIX_DEP_REVISION`            | Effective package revision after `build.toml` is overlaid.                                                                                                                                                                                                                                                                                       |
| `WASM_POSIX_DEP_SOURCE_ARCHIVE`      | SourceOnlyV1 Archive providers only: canonical regular-file path to the resolver's immutable, digest-verified archive payload. It is absent for Repository and DevShell providers and from Default resolver builds.                                                                                                                                 |
| `WASM_POSIX_DEP_SOURCE_DIR`          | SourceOnlyV1 Archive providers only: fresh sealed extraction below a resolver-owned source-input root disjoint from this invocation's work and output roots. It is distinct from the immutable archive and is removed on every return path. Recipes must copy it below `WASM_POSIX_DEP_WORK_DIR` before modifying it.                              |
| `WASM_POSIX_DEP_SOURCE_URL`          | Archive acquisition metadata (`source.url` from package.toml). SourceOnlyV1 and Default Archive builds receive it; Repository and DevShell builds do not. It is not permission for a SourceOnlyV1 recipe to fetch.                                                                                                                                   |
| `WASM_POSIX_DEP_SOURCE_SHA256`       | Lowercase expected SHA-256 acquisition metadata for an Archive provider. SourceOnlyV1 receives it after resolver verification; Default recipes that download remain responsible for verification. Repository and DevShell builds do not receive it.                                                                                                |
| `WASM_POSIX_DEP_TARGET_ARCH`         | Requested package architecture (`wasm32` or `wasm64`). A package that supports only one must reject the other before invoking its toolchain.                                                                                                                                                                                                     |
| `WASM_POSIX_BINARY_CACHE_ROOT`       | Canonical absolute cache root selected by the current resolver invocation. It overrides inherited ambient state and keeps nested resolvers aligned with direct dependency paths.                                                                                                             |
| `WASM_POSIX_SOURCE_ONLY_CACHE_ROOT`  | SourceOnlyV1 only: canonical cache base that owns the exact `source-only-v1/compiled` binary-cache child and immutable verified archive payloads. It is absent under Default resolution.                                                                                                                                                           |
| `WASM_POSIX_SOURCE_ONLY_BINARY_ROOT` | SourceOnlyV1 non-Rust consumers only: normalized canonical absolute directory containing regular-file materializations and `.kandelo/source-only-program-projection-v1.json`. The TypeScript/shell resolver accepts this one aggregate-owned tier and never searches Default mirrors, the ordinary compiled cache, or an installed package. Each authority member is limited to 512 MiB; Vite also limits its complete pinned snapshot batch to 512 MiB. |
| `WASM_POSIX_DEP_WORK_DIR`            | Caller-owned, single-writer scratch root disjoint from `OUT_DIR`. The resolver creates a fresh private directory for every source build and removes it on success or failure. Direct ad-hoc script invocation may retain a package-local default.                                                                                                |
| `WASM_POSIX_DEP_<UPPER>_DIR`         | For each _direct_ dep, the resolved path to that dep's build output. `<UPPER>` is the dep name upper-cased, with `-` → `_` (e.g. `zlib-ng` → `ZLIB_NG`). Transitive deps are not surfaced — scripts that need them should declare them in `depends_on`.                                                                                          |
| `WASM_POSIX_DEP_<KEY>_SRC_DIR`       | SourceOnlyV1 direct source dependencies only: a fresh sealed per-consumer extraction below the same resolver-owned source-input root, disjoint from recipe work and output. `<KEY>` is exactly `K_` followed by the uppercase hexadecimal encoding of the package name's UTF-8 bytes (`foo-bar` → `K_666F6F2D626172`). Default source-kind dependencies retain the legacy uppercased-name spelling. |
| `WASM_POSIX_BUILD_GIT_<NAME>_DIR`    | Read-only detached checkout for a `build.toml` `[[git_inputs]]` declaration. `<NAME>` is the injective uppercase form of the validated lowercase name.                                                                                                                                                                                           |
| `WASM_POSIX_BUILD_GIT_<NAME>_COMMIT` | Exact declared commit corresponding to that checkout.                                                                                                                                                                                                                                                                                            |

Scripts that accept the optional sealed-build roots should source
`scripts/package-build-roots.sh`. Explicit source, work, and output roots must
be absolute, normalized, real non-symlink directories with no pairwise overlap.
The source root is immutable input: copy it below the work root before patches,
configure steps, code generation, or compilation. Work products stay below the
work root, and only declared artifacts are installed into the output root. This
keeps the normal source-build path usable by package recipes without granting
write access to either the reviewed Kandelo checkout or verified source tree.

`kandelo_package_stage_verified_source` has two distinct acquisition
boundaries. Under SourceOnlyV1 it requires both resolver-owned source paths,
revalidates the archive and source paths, requires an exact optional
positional-source match, and copies the tree only to a new destination below
the caller's work root. That branch never invokes `curl`, even when URL
arguments are present; only the private copy becomes owner-writable. Under the
Default policy, the helper retains its existing caller-verified-directory
precedence and URL/SHA download-and-verify fallback.

Known migration gap: 29 Archive-provider recipes in the current local build
set still use their legacy recipe-owned download path instead of the
SourceOnlyV1 source handoff. The directed acyclic graph (DAG) and compiled
artifact cache still apply—a cache hit does not run the recipe—but a cold miss
for one of these nodes does not reuse the resolver source cache and must not be
described as a hermetic SourceOnly build. Fifteen of the legacy recipes also
retain mutable checkout-local source or build state. Migrating these recipes
to `kandelo_package_stage_verified_source` and resolver-owned work directories
is explicit future work after the initial local-build restoration lands.

The affected recipes are `bzip2`, `cpython`, `curl`, `git`, `gzip`, `icu`,
`less`, `libcurl`, `libiconv`, `libpng`, `libxml2`, `libzip`, `msmtpd`,
`netcat`, `nginx`, `openssl`, `redis`, `ruby`, `sdl2`,
`sdl2-mixer-playwave`, `sdl3`, `tar`, `unzip`, `vim`, `wget`, `xz`, `zip`,
`zlib`, and `zstd`. Five legacy script defaults currently disagree with their
package manifests (`gzip`, `redis`, `wget`, `xz`, and `zstd`); those cold paths
also require version alignment during the migration.

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
must set both `PKG_CONFIG_PATH` _and_ `CPPFLAGS=-I` / `LDFLAGS=-L`.
Setting only one silently drops the dep.

Why: autoconf probes for a library along two independent paths
during `configure`, and which path runs depends on how the
project's `configure.ac` was written.

| Probe path   | What configure runs                                                    | What env it reads                       |
| ------------ | ---------------------------------------------------------------------- | --------------------------------------- |
| pkg-config   | `pkg-config --cflags <name>` / `--libs <name>`                         | `PKG_CONFIG_PATH`, `PKG_CONFIG`         |
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
succeed but caused CPython's _separate_ `py_cv_module_zlib`
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

## Iterating on a package locally

Package resolution is local-first: every package is source-built through
the SDK/libc/resolver and cached locally by content hash. There is no
remote prebuilt-binary channel to publish to or fetch from.

When you edit a `packages/registry/<name>/package.toml`, `build.toml`,
or any input that changes the package's cache-key sha (`revision`,
`source.url`, `source.sha256`, declared build inputs, transitive deps),
the previously cached artifact no longer matches. The next
`cargo xtask build-deps resolve <name>` recomputes the cache key, misses
the canonical cache path, and rebuilds from source via `build-<name>.sh`.
No stale-archive handling is needed — a changed recipe simply rebuilds.

For pre-push iteration, edit the recipe and run `./run.sh local-build`
(or `./run.sh browser`). The local DAG rebuilds the affected node and its
dependent products; unchanged content-addressed nodes are reused from
cache. See [Local DAG build](#local-dag-build) for the aggregate build
command and [Resolution order](#resolution-order) for the exact local
override, cache, and source-build tiers.

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
transitive dependency rekeys only the affected programs; those programs are
rebuilt from source under the new key instead of reusing main-only bytes.
Consumers do not synthesize or merge policy: they verify the complete top
projection. If the external root is absent, the main root's committed
suffix-context index becomes authoritative again.

The first external package source using this pattern is
[`brandonpayton/kandelo-software`](https://github.com/brandonpayton/kandelo-software):
it keeps package recipes under `packages/<name>/` that are overlaid into a
Kandelo checkout and source-built locally through the same resolver. See
[docs/package-sources.md](package-sources.md) for the package-source layout.

External package sources supply recipes, not prebuilt binaries; their
packages are source-built and cached locally like first-party recipes.

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
- `[source].provider` for checked-in local-supported manifests (`archive` for
  fetched source archives)
- `[license].spdx`

Optional:

- `depends_on` — same syntax as library/program manifests.
- `[build].script_path` — see "Override" below.
- `[[host_tools]]` — see the Host-tool requirements section below.

Rejected at parse time (the parser surfaces a clear error):

- `[outputs]` and `[[outputs]]` — sources have no built-artifact
  layout.
- `[binary]` and `[compatibility]` — these blocks belonged to the
  removed remote binary channel and are no longer accepted anywhere.

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

The manifest declares executable prerequisites; the source recipe still owns
any project-local dependency tree used by those executables. For example, a
recipe that runs a JavaScript tool from a committed `package-lock.json` must
install and verify that locked tree in its normal build path, below the
resolver-owned build output or scratch tree rather than in the shared source
checkout. Do not provision it only in selected CI callers: archive validation
can reject a same-run or published artifact and fall through to the source
recipe from any local, direct-dependency, transitive-dependency, or concurrent
resolve.

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
