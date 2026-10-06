# Hermetic target dependency flags for package builds

Status: proposed (2026-10-01). Review before implementation.

## Why

A Kandelo package build compiles C and C++ for WebAssembly. Every header it
includes and every library it links must come from the package's own declared
dependencies (resolver outputs under the Kandelo build cache) or the Kandelo
sysroot. The developer's machine has its own copies of the same libraries —
built for macOS or Linux, at different versions — and none of them is valid
for a WebAssembly target.

Today a package build can silently pick up the host's copies. The route is
`pkg-config`:

- Upstream configure scripts call plain `pkg-config`. The build runs inside
  the Nix dev shell, which puts the host `pkg-config` on `PATH` and exports a
  `PKG_CONFIG_PATH` of about 48 `/nix/store/...` directories, one per host
  library.
- `pkg-config` searches `PKG_CONFIG_PATH` *in addition to*
  `PKG_CONFIG_LIBDIR`. A recipe that carefully sets `PKG_CONFIG_LIBDIR` to its
  dependencies (ScummVM, the Qt family) still reaches the host directories.
- The answer comes back as ordinary `-I/nix/store/...` and
  `-L/nix/store/...` flags, which the target compiler accepts.

Observed effects, from the 2026-09-30/10-01 builds:

| Package | What leaked | Consequence |
|---|---|---|
| ScummVM | `-I/nix/store/...libpng-apng-1.6.55-dev/include/libpng16` on all 763 compile lines; one `-L/nix/store/...libpng-apng-1.6.55/lib` | Compiled against libpng 1.6.55 (APNG-patched) headers while linking the libpng 1.6.43 package. Fixed in the recipe on 2026-10-01 by clearing `PKG_CONFIG_PATH`. |
| CPython | `-I` for host sqlite 3.50.4, ncurses 6.5, xz 5.8.1, zlib 1.3.2, libb2 0.98.1 | Modules compiled against host headers whose versions differ from the packages they link. Not yet fixed. |
| qtbase, qtdeclarative, qtshadertools, quickshell | Suspected: they set `PKG_CONFIG_LIBDIR` but leave `PKG_CONFIG_PATH` live, although qtbase's own comment says the host path must not stay live | Not yet confirmed from build logs. |

The census above covers only the 90 package builds that ran before an
interrupted full rebuild; the true list is larger.

Why this matters:

- **Silent wrongness.** A header/library version mismatch compiles and links,
  then misbehaves at runtime (struct layouts, macros, inline functions).
- **Unreproducible artifacts.** The output depends on whatever the dev
  shell happens to contain, not on declared inputs, so cache keys do not
  describe the build.
- **It violates the package contract** in CLAUDE.md: build scripts must use
  the worktree-local SDK and declare every dependency they use.

Fixing it recipe by recipe has already failed once: qtbase documents the
danger and still leaves the host path reachable. This spec makes the safe
behavior the default and turns any remaining leak into a loud build failure.

## Current state (verified 2026-10-01)

- `tools/xtask/src/build_deps.rs` launches each package build script. It
  scrubs credentials and proxies (`SOURCE_ONLY_RECIPE_AMBIENT_ENVIRONMENT`,
  `scrub_source_only_recipe_environment`), prepends `<repo>/sdk/bin` to
  `PATH`, and exports `WASM_POSIX_DEP_PKG_CONFIG_PATH`: the `lib/pkgconfig`
  directories of every transitive dependency (`compose_pkgconfig_path`). It
  does not touch `PKG_CONFIG_PATH`, `PKG_CONFIG_LIBDIR`, `PKG_CONFIG` or
  `PKG_CONFIG_SYSROOT_DIR`, so the dev shell's values reach the script.
- The SDK ships `wasm32posix-pkg-config` (`sdk/src/bin/pkg-config.ts`). It
  sets `PKG_CONFIG_LIBDIR` to the sysroot and filters the caller's
  `PKG_CONFIG_PATH`. The filter (`isWasmPosixPath`) keeps any path that
  merely *contains* `kandelo/` or `/sysroot/`, which also matches every
  checkout path on a developer machine (e.g.
  `/Users/<user>/conductor/workspaces/kandelo/<name>/...`). It is a substring
  heuristic, not a membership test.
- About 40 package scripts use pkg-config; about 10 call
  `wasm32posix-pkg-config` or set `PKG_CONFIG`. The rest rely on upstream
  configure finding `pkg-config` on `PATH`, which is the host one.
- The SDK compiler wrappers (`sdk/src/bin/cc.ts`, `c++.ts`, flag parsing in
  `sdk/src/lib/flags.ts`) already parse `-I`, `-isystem`, `-L` and friends
  but do not inspect their values.

## Design

Two layers. Layer 1 removes the cause; Layer 2 detects anything Layer 1
misses, from any route.

### Layer 1: launch package builds with target-only pkg-config

When xtask runs a package build script it will:

1. **Shadow `pkg-config`.** Put a directory first on `PATH` that contains a
   `pkg-config` (and `<triple>-pkg-config` variants that configure scripts
   probe for) which runs the SDK wrapper for the build's target arch. Also
   set `PKG_CONFIG` to it; autoconf and many hand-written configures honor
   `PKG_CONFIG`. ScummVM's configure hard-codes `_pkgconfig=pkg-config`, so
   `PATH` shadowing is required, not optional.
2. **Replace the search path.** Set `PKG_CONFIG_LIBDIR` to the sysroot's
   pkgconfig directories plus `WASM_POSIX_DEP_PKG_CONFIG_PATH` (the declared
   transitive dependencies), and set `PKG_CONFIG_PATH` to empty. Remove
   `PKG_CONFIG_SYSROOT_DIR` (our `.pc` files carry absolute prefixes; see the
   comment in `sdk/src/bin/pkg-config.ts`).
3. **Keep host pkg-config available by an explicit name.** Some recipes build
   native host tools (generators, a host interpreter) and legitimately need
   host libraries. Expose the dev shell's original `pkg-config` and its
   original `PKG_CONFIG_PATH` as `host-pkg-config` (a wrapper that restores
   the captured host environment). Using it is a visible, reviewable choice
   in the recipe.

The SDK wrapper itself changes from substring filtering to membership:

- Accept a `PKG_CONFIG_PATH` entry only if it is inside the sysroot, inside
  the resolver's compiled cache root, or inside the recipe's own work or
  output directory (staged `.pc` files during a build). Drop everything else,
  and print a one-line note naming what was dropped, so a recipe that tried to
  add a host directory learns why it vanished.
- Resolve allowed roots from the environment xtask already sets
  (`WASM_POSIX_DEP_*`, `WASM_POSIX_SYSROOT`, cache root variables) rather than
  from path substrings.

Recipes that already set these variables keep working: an explicit
`PKG_CONFIG_LIBDIR` naming dependency directories is a subset of what xtask
now provides.

### Layer 2: the target compiler rejects host paths

The SDK compiler wrappers (`wasm32posix-cc`, `wasm32posix-c++`, and the
wasm64 equivalents) check every directory argument of `-I`, `-isystem`,
`-iquote`, `-idirafter`, `-L` and `--sysroot`, in both attached and separated
forms, including those arriving through `@response` files and `-Wl,-L`:

- **Reject** any path under `/nix/store/`, `/usr/include`, `/usr/lib`,
  `/usr/local/include`, `/usr/local/lib`, `/opt/homebrew`, or the macOS SDK
  (`xcrun --show-sdk-path`). These can never be correct for a Wasm target.
- On rejection, fail with a message naming the flag, its value, and the
  likely sources (`pkg-config` / `*-config` scripts / `CPPFLAGS` /
  `LDFLAGS`), and point to this spec.

A deny-list of host locations is preferred over an allow-list of target
locations for the first version: the target side legitimately includes
recipe source trees, generated headers in work directories, and vendored
headers inside the repository, which an allow-list would have to enumerate.
The deny-list catches the observed failure class with no false positives in
target builds, since nothing under those host roots is a Wasm artifact.

Native host compilers (`cc`, `clang`) are untouched, so recipes building host
tools are unaffected.

### Rollout

1. **Report mode.** Land Layer 2 with an environment switch
   (`KANDELO_HOST_PATH_GUARD=report|error`, default `report`) that logs each
   offending flag once per invocation and continues. Land the SDK wrapper's
   membership filter in the same change.
2. **Census.** Run one full `./run.sh local-build` (both architectures the
   package set builds) and collect every report. Record the offender list in
   the PR (package → flag → source).
3. **Fix offenders at their source.** Known: CPython (sqlite, ncurses, xz,
   zlib, libb2), the Qt family (to confirm). Each fix makes the recipe
   resolve the dependency from its declared package, or declares the missing
   dependency. A host header that turns out to be genuinely needed for a
   *target* compile is a platform gap to raise, not to allow-list.
4. **Layer 1.** Add the xtask environment changes and the `host-pkg-config`
   escape hatch. Re-run the full build; the census should be empty.
5. **Error mode.** Flip the default to `error`. Keep `report` available for
   porting work only, documented as such.

Steps 1–3 can land as separate PRs. Step 5 must not land before the census
is empty.

## Cache and ABI implications

- Layer 1 changes the environment every recipe runs with, so recipe outputs
  can change wherever a recipe was leaking. Treat it like an SDK change:
  the affected packages' cache keys must change. If xtask's cache key does
  not already cover the launched environment and the SDK sources, the change
  must include them (see the build-freshness notes in
  `docs/package-management.md`). Packages that change output need their
  `build.toml` revision bumped per `docs/agent-guidance/packages-and-builds.md`.
- No guest ABI change. `ABI_VERSION` is unaffected.

## Testing

- `sdk/test/pkg-config.test.ts`:
  - **filter membership:** a `kandelo`-named checkout path that is not a cache
    or sysroot path is dropped; cache and sysroot paths are kept;
  - **drop note:** the note names each dropped entry.
- `sdk/test/cc.test.ts` / `flags.test.ts`:
  - **detected forms:** each flag form (attached, separated, `-Wl,-L`,
    response file) with a `/nix/store` path is reported in `report` mode and
    rejected in `error` mode;
  - **clean pass:** repository and cache paths pass.
- xtask unit test: the launched recipe environment has `PKG_CONFIG_PATH`
  empty, `PKG_CONFIG_LIBDIR` equal to sysroot plus declared dependencies,
  `pkg-config` on `PATH` resolving to the shim, and `host-pkg-config`
  restoring the captured host values.
- An end-to-end fixture recipe whose configure calls plain
  `pkg-config --cflags libpng` with a host libpng present in
  `PKG_CONFIG_PATH`: it must get the dependency package's flags, never the
  host's.
- The census build itself (rollout step 2), reported with counts.

## Documentation

- `docs/package-management.md`: the recipe environment contract (what
  `pkg-config`, `PKG_CONFIG_*` and `host-pkg-config` mean inside a recipe).
- `docs/sdk-guide.md`: the compiler host-path guard, its modes, and the error
  message's meaning.
- `docs/porting-guide.md`: "my configure can't find X" now means "declare X",
  not "point at the host's X".
- Remove the now-redundant per-recipe workarounds (ScummVM's
  `PKG_CONFIG_PATH=`, the Qt family's `PKG_CONFIG_LIBDIR` assembly) only after
  Layer 1 lands, and only if the xtask environment fully covers them.

## Open questions

1. Should the Layer 2 deny-list also cover Homebrew/MacPorts paths on all
   platforms, or only paths that exist on the build machine?
2. Do any recipes run `pkg-config` for host tools *without* realising it
   (e.g. meson native files, CMake toolchain probes)? The census should show
   these as build failures after Layer 1, which is the point, but they need a
   migration note.
3. Does `xcrun` exist in CI images, and should the guard skip the macOS SDK
   check when it is absent?
4. Should the cache key incorporate a digest of the launched recipe
   environment, rather than relying on the SDK source digest alone?
