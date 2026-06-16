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

Multi-output paths are resolver-owned. Do not hardcode
`binaries/programs/<arch>/...`; ask
`cargo xtask build-deps output-path <pkg> <wasm-basename>` or use the existing
helper in `run.sh`.
