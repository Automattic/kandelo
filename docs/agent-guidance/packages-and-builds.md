# Package And Build Contract

Packages are consumers of the platform and distribution units for reproducible
artifacts. A package build should exercise the SDK, libc, resolver, sysroot,
VFS image tooling, fork instrumentation, and kernel assumptions through the
normal path. Do not make a package succeed by bypassing the SDK, libc,
resolver, VFS image, syscall, host, or kernel behavior that user software
normally relies on.

Package failures are platform feedback. Before patching upstream source or
adding package-specific build flags, ask whether Kandelo is missing a syscall,
libc behavior, SDK flag, VFS file, device, configure cache answer, fork
instrumentation step, or host parity behavior. Do not use package patches to
compensate for ordinary Kandelo POSIX gaps. If Kandelo has a documented
limitation because today's WebAssembly runtimes make the POSIX behavior
infeasible to implement faithfully, a package patch may adapt at that boundary.
Document the limitation, keep the patch scoped to that boundary, and do not let
it hide a fixable Kandelo defect. Package-local patches are appropriate for
upstream portability issues; they are suspect when they hide a Kandelo defect.

Each package has two distinct sources of truth:

| File | Owns |
|---|---|
| `package.toml` | Portable recipe contract: package identity, upstream source, license, direct deps, target arches, ABI expectation, declared outputs, and default source-build hook |
| `build.toml` | Kandelo project build/publish state: selected script path, source provenance, publish revision, cache invalidation, and binary index location |

`package.toml` describes what the package is and what a valid build must
produce. `build.toml` describes how this Kandelo project currently builds,
caches, and publishes that recipe. `build.toml.script_path` usually mirrors
`package.toml`'s `[build].script_path`, but may override it for this project.

Archive URLs belong in the per-release `index.toml` ledger, not in package
manifests. Never hand-edit `index.toml`; publish or recover it through the
supported scripts.

Build scripts must honor the resolver contract. They install only into
`WASM_POSIX_DEP_OUT_DIR`, verify downloaded source hashes, consume direct deps
through `WASM_POSIX_DEP_<NAME>_DIR`, declare every dep they use, and produce
the outputs declared in package metadata. Nested resolvers must honor the
resolver-supplied `WASM_POSIX_BINARY_CACHE_ROOT`; it identifies the same cache
that owns those direct dependencies, including an archive-stage override. A
build script that relies on ambient host tools, global SDK links, undeclared
transitive deps, or files outside its contract is not cache-safe.

Build scripts configure, fetch, patch, generate, and compile only under
`WASM_POSIX_DEP_WORK_DIR`, and install only into `WASM_POSIX_DEP_OUT_DIR`.
The checkout is reviewed input, not scratch. Two resolves of one recipe in
one worktree do run at once: two Vitest files that miss the same cache, a
`local-build` beside a test, or the wasm32 and wasm64 builds of one recipe.
A build tree at a fixed checkout path such as `$SCRIPT_DIR/<name>-build` is
shared between them, and one build's `rm -rf` deletes the other's tree
mid-build. Fixed `/tmp/<name>-<version>.tar.*` download paths collide the
same way. Derive every write path from `kandelo_package_prepare_build_roots`
(`$KANDELO_PACKAGE_WORK_DIR`) or `"${WASM_POSIX_DEP_WORK_DIR:-$SCRIPT_DIR}"`,
read primary identity with `kandelo_package_load_source_metadata` and stage
sources with the shared verified-source helpers, and export
`WASM_POSIX_INSTALL_LOCAL_MIRROR=0` before `install_local_binary` when the
resolver owns the roots. Standalone runs may keep package-local defaults.
The resolver enforces the recipe-directory part of this rule: it records the
package directory and the build script's directory before the script runs,
and fails the build, publishing nothing, if anything in them changed.

The persistent SourceOnly build cache lives at
`$HOME/.cache/kandelo/source-only` and is **shared across every worktree on
the machine** by default. This is deliberate: the cache is content-addressed,
so identical inputs are built once and reused everywhere, which is what keeps a
fresh `git worktree` fast instead of a from-scratch rebuild. Set
`KANDELO_SOURCE_CACHE_ROOT` to an absolute path to give a worktree its own
isolated cache instead; leave it unset to share. Both build front doors honor
it and must agree — the Rust default (`default_source_cache_root` in
`tools/xtask/src/local_build.rs`) and the shell runner
(`scripts/run-local-build.sh`). Reach for isolation only when an in-progress
change alters the *bytes* a cache key maps to — e.g. a change to the
build-stamp or artifact format — so that a worktree on the new format does not
contend with worktrees on the old one at the same content-addressed key.
Concurrency itself is safe: each build compiles in its own resolver work
root (see the build-script rule above), and the store stages into a per-pid
temp directory and publishes with an atomic, non-replacing `rename(2)`. The
shared default therefore never risks corruption; the override is about
avoiding churn, not preventing races. Do not reach for it as a routine
default — a per-worktree cache discards the cross-worktree reuse the shared
cache exists to provide.

Because the cache is shared, per-checkout maintenance must stay scoped to the
checkout's own keys. `xtask clean <target>` (behind `./run.sh clean` and
`./run.sh rebuild`) removes only the generation stored under the cache key
this checkout's inputs currently resolve to, for the target and its
reverse-dependency cascade, plus this checkout's mirrored outputs under
`local-binaries/source-only-v1`. Generations of the same package under other
keys were built from other inputs, usually another worktree's, and are left
in place; deleting them would silently force that worktree to rebuild the
package and everything built on it.

Stale generations are reclaimed only by cache garbage collection, never by a
per-checkout command: `./run.sh cache-gc` (a dry run unless `--apply`) and
the automatic collection a successful local build runs at most once a day.
It removes a generation only when no live checkout root names its key and it
has gone unused past the age limit (or, with `--below-abi N`, was built for an
ABI below `N`), and it skips while any build holds the cache lock. Do not hand-delete cache entries or add another sweeper: every
build that uses the cache must hold `cache_gc::CacheUseLock` for as long as it
can read a generation, or collection can remove an entry underneath it. Run
destructive collection against the shared cache only when the user asks;
test it against a scratch `KANDELO_SOURCE_CACHE_ROOT`, and set
`KANDELO_CACHE_GC_AUTO=0` when a build must not collect. See
[Cache garbage collection](../package-management.md#cache-garbage-collection).

## Line editing for REPL CLIs

A command-line program with an interactive REPL — a read-eval-print loop that
reads lines from a TTY, such as `sqlite3` or a language shell — should link a
line-editing library so users get history, cursor movement, and the REPL's own
Ctrl-D/EOF handling, unless the upstream maintainer explicitly omits it. A bare
`fgets`/`getline` reader is the fallback, not the default.

Choose the editor by the *consuming program's* license, because the standard
choice — GNU `readline` — is GPL-3.0-or-later, and linking it makes the
resulting **binary** a GPL aggregate. That aggregate is scoped to that one
binary; it does not relicense other libraries the binary also links (e.g.
`libsqlite3` stays public domain).

- Public-domain / MIT / BSD / Apache-2.0 / otherwise GPL-compatible program:
  GNU `readline` is the default — the `readline` package linked against
  `ncurses`' `libtinfow` (define `-DHAVE_READLINE=1`, link
  `-lreadline -lhistory -ltinfow`). Note in the package that the binary is a
  GPL aggregate.
- GPL-incompatible program (proprietary, GPLv2-only, or one that must stay
  under a permissive license): do NOT link GPL `readline`. Use a BSD line
  editor (libedit) or the program's built-in editor instead.

Record which shipped binaries link GPL `readline` so each binary's aggregate
license is known.

Builds must use the worktree-local SDK. Source `sdk/activate.sh` from package
scripts; do not rely on `npm link` or a globally installed wrapper. If a build
only works because the host PATH leaks a tool, fix `flake.nix` or the build
inputs, not the user's shell.

Cross-compilation probes are part of the platform contract. Configure scripts
must be told the wasm target truth. If upstream `configure` detects host-only
functions, override the relevant `ac_cv_*` values. Do not let host feature
detection define what the wasm sysroot claims to support.

## Platform identity: Kandelo is not Linux

Kandelo's compiler describes the target as WebAssembly with a Unix source
environment (`__wasm__`, `__unix__`). It does not define `__linux__`, and it
must not. Kandelo is a POSIX platform whose libc is musl. It implements some
interfaces that originated on Linux (`epoll`, `eventfd`, `/proc`), but it has
no Linux compatibility target. Defining `__linux__` in the SDK would tell
every package, and every agent reading the build, that it does.

Portable code often selects its musl or glibc path with `__linux__` (gnulib's
locale-name lookup, LLVM's choice of `<endian.h>`, Linux UAPI headers), and
without it falls into a BSD branch or an `#error`. When a package hits that:

1. **Never define `__linux__` in the SDK**, its compiler or linker flags,
   `sdk/config.site`, or the sysroot.
2. **Ask: is there another way than defining `__linux__`?** Look in this
   order:
   - A feature macro or configure cache variable the upstream code already
     consults. For example, LLVM's `llvm/ADT/bit.h` includes the BSD
     `<machine/endian.h>` only when `BYTE_ORDER` is undefined, so
     pre-including musl's `<endian.h>` answers it truthfully.
   - The capability the branch actually needs, expressed as a feature test.
     For example, gnulib's musl locale-name code is guarded by
     `defined __linux__ && defined NL_LOCALE_NAME`, where `NL_LOCALE_NAME`
     alone is the capability. Report that upstream, and carry the proposed or
     accepted upstream change as a documented package patch meanwhile.
   - A package-local patch or define that selects the portable path by
     feature, documented in the package.
3. **Only if none of these works**, a per-package `-D__linux__` in that
   package's build script is a last resort, and only after a conversation
   with the maintainer. Put a comment beside it that says it is a last
   resort, names what the upstream keys on, explains why each alternative
   above did not work, and states that it does not make Kandelo a Linux
   target.

Fork-using packages must be instrumented with
`scripts/run-wasm-fork-instrument.sh` after linking and after optimization.
Missing `wpk_fork_*` exports are a build/runtime error. Legacy Asyncify
artifacts are stale and must be rebuilt, not supported.

Package revisions are cache invalidation, not progress markers. Bump
`build.toml.revision` only when output bytes legitimately change: source,
patches, build flags, SDK/sysroot/glue inputs, VFS image builder inputs, or
instrumentation changes. Do not bump revisions for docs-only changes or to
force stale local state to disappear.

Binary materialization is not package rebuilding. Fetching, verifying,
overlaying, or symlinking existing archives should be tested as materialization
behavior. Rebuild package archives only when package archive inputs changed.

Current `main` is the only authority that may admit package archives into
production or mutate a durable generation, index, or
release. Recheck its exact lowercase commit SHA immediately before each
mutation. Normally the archives are rebuilt after their source changes land
and record that exact `main` SHA.

The ordinary versioned compatibility path may preserve archives from a
distinct immutable producer commit `S`: `kandelo-package-generation-v2` records
`validated_against_main` commit `M` using `identical-git-tree-v1`. The trusted
current-`main` implementation must independently bind the source release's
direct tag anchor `R`, require every selected archive to identify the same
producer `S`, and freshly prove `S^{tree} == M^{tree}`. It binds the release
and direct tag at `R`, producer and main commits and trees, the ABI snapshot,
release assets, selected projection, expected ledger, and archive bytes into
`generation.json`, then targets the durable release at `M`. The tag is an
independently rechecked asset-container locator, not archive provenance, so its
tree need not equal either `S` or `M`. Archives truthfully retain
`[build].commit = S`; do not rewrite their provenance. The producer checkout
is inert data and must never supply executable workflow authority. Ancestry,
reachability, a tag, a merge method, or equality of only selected files is not
this proof. Existing v1 generations remain readable, but new preparation uses
v2.

The bounded `identical-package-cache-projection-v1` method may admit distinct
trees only from a public, application-sealed preserved closure. Existing v1
preservation records one PR-staging run and keeps its direct tag at producer
`S`. V2 preservation records one completed, successful canonical
`force-rebuild.yml` run, requires `S` to be an ancestor of current authority
`M`, and targets its preservation release and tag at `M`. The seal binds the
observed source release and direct tag, run ID and attempt, event, workflow,
exact head, the unique successful selected-root job and its log, every selected
same-run artifact, and equality between workflow-artifact and release-archive
bytes. A preserved release must declare `admission = "none"`; it is evidence,
never a resolver input.

At admission, trusted current-main code must revalidate that public seal and
derive byte-identical selected projections, expected ledgers, and canonical
selected build-input component closures from inert `S` and `M`. That closure
binds every selected manifest, parsed recipe, declared and Git input, direct
dependency identity, global toolchain input, fork-instrument input when used,
architecture, and ABI. A difference in any bound input fails closed. Complete,
non-truncated Git tree IDs and the exact regular-file identities of both
validator sources are recorded for audit; unrelated leaves may differ because
they cannot affect the selected closure. Global program-index consumers and
deployment still validate the complete index rather than this selected subset.
For v2 canonical evidence, both admission jobs also prove that `S` is an
ancestor of preservation authority `M0` and that `M0` is an ancestor of the
current publishing `M`; the writer repeats that chain before every mutation.

The selected-input comparison proves package-input equivalence. It does not
prove whole-tree equality, ancestry, or reproducible payload bytes at `M`.
`identical-git-tree-v1` remains the preferred ordinary route. V1 preservation
remains valid only with its immutable PR semantics and cannot be reinterpreted
as canonical Force evidence. V2 canonical preservation avoids GitHub's
historical-workflow write restriction without changing the producer recorded
in its seal. All selected archives must still identify one coherent `S`;
mixed producers remain invalid.

For a normal exact-main rebuild under the active v2 method, the selected
archive's transitive buildable dependencies
must come from the same producer closure: partition it into topological levels,
consume only same-run artifacts across dependency edges, and fail rather than
falling back to an older cache-equivalent archive. Resolve those overlays
through an empty job-local cache so prior runner state cannot satisfy an edge.
Ordinary resolver/cache reuse outside this production path retains its existing
semantics.

Multi-output paths are resolver-owned. Do not hardcode
`binaries/programs/<arch>/...`; ask
`cargo xtask build-deps output-path <pkg> <wasm-basename>` or use the existing
helper in `run.sh`.

## Image recipes outside the default build

The default local-build set and browser deployment projection do not exercise
every registered image recipe. When changing shared SDK, ABI, resolver or image
builder contracts, identify affected recipes outside that set and validate them
through the normal package resolver for their declared architectures. A passing
default build does not establish that those recipes still work. Dormant status
controls product exposure; retain it while checking build compatibility. Do not
add a dormant product to the shipped projection just to validate its recipe.
