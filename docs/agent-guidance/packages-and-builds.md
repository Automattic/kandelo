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
the outputs declared in package metadata. A build script that relies on ambient
host tools, global SDK links, undeclared transitive deps, or files outside its
contract is not cache-safe.

Builds must use the worktree-local SDK. Source `sdk/activate.sh` from package
scripts; do not rely on `npm link` or a globally installed wrapper. If a build
only works because the host PATH leaks a tool, fix `flake.nix` or the build
inputs, not the user's shell.

Cross-compilation probes are part of the platform contract. Configure scripts
must be told the wasm target truth. If upstream `configure` detects host-only
functions, override the relevant `ac_cv_*` values. Do not let host feature
detection define what the wasm sysroot claims to support.

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
Homebrew production or mutate a durable generation, bottle, index, tap, or
release. Recheck its exact lowercase commit SHA immediately before each
mutation. Normally the archives are rebuilt after their source changes land
and record that exact `main` SHA.

One narrow, versioned compatibility path may preserve archives from a distinct
immutable producer commit `S`: `kandelo-package-generation-v2` records
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

The bounded migration-only
`identical-package-cache-projection-v1` method may admit distinct complete
trees without claiming payload equivalence. Current-main code must derive the
exact same selected package projection, expected ledger, and canonical
per-package build-input component closure from inert `S` and `M`. That closure
binds each package manifest, parsed build recipe and Git inputs, every declared
input digest, direct dependency cache identities, the global toolchain,
fork-instrument inputs when used, architecture, and ABI. In schema-2
selections, source-only dependencies remain bound by the full projection and
direct dependency records but never acquire archive components. Complete
non-truncated Git tree IDs remain bound for audit, and the exact validator
transition is pinned; unrelated host/runtime leaves are not package inputs and
therefore do not require a broad path exception.

This one-shot method is hard-bound to #1097 producer
`748c2609954d2809bbcbbcb642fa7d257fc0dbc6` and
the `pr-1097-staging` source capture; do not generalize it to another producer
or source. Before admission, current-main code must preserve that mutable
source as an evidence-only `preserved-package-generation-...` release. The
preserved manifest binds the complete selected archives, minimal index,
projection, expected ledger, same-run workflow artifacts, and root-job log,
and must claim `admission = "none"`. Cache-projection promotion takes the exact
published preservation tag, embeds and revalidates its complete manifest and
release inventory, and only then emits an admitted
`package-generation-...` tag. Never dispatch this method from the mutable PR
tag, and never materialize a preserved release directly. The audited H-to-M
comparison is equal only for the schema-1 `rootfs`/`wasm32` selection.
`lamp`, `nginx-php-vfs`, and `wordpress` changed cache identities in the
schema-2 browser selection, so this bridge must not admit that broader closure.
Any difference in the selected recipe, declared inputs, dependency identities,
toolchain, fork instrumentation, architecture, ABI, projection, expected
ledger, or preserved archive evidence fails closed. All selected archives
still use one coherent `S`; mixed producers remain invalid.

For either a normal exact-main rebuild or a producer admitted by one of these
versioned v2 methods, the selected archive's transitive buildable dependencies
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
