# Building Packages Inside Kandelo: Design

Date: 2026-10-20
Status: Draft for review
Plan: [2026-10-20-build-inside-kandelo-plan.md](2026-10-20-build-inside-kandelo-plan.md)

## Why

Many upstream builds compile small helper programs, run them, and feed
their output into the final program. NetHack is the motivating example:
`makedefs`, `dgn_comp`, `lev_comp` and `dlb` generate headers and the
`nhdat` data archive. Kandelo cross-compiles packages today, so these
helpers are built with the build machine's compiler and run on the
build machine. They then describe the build machine, not the wasm32
target:

- NetHack's banner said `Version 3.6.7 MacOSX` because `makedefs` saw
  `__APPLE__`. A Linux build machine would have said `Unix` and produced
  different bytes.
- 64-bit `makedefs` wrote 8-byte `long` fields into `quest.dat` and data
  file headers that the 32-bit game reads as 4 bytes. The recipe carries
  three patches (`qtext.h`/`questpgr.c`/`makedefs.c`, `global.h`,
  `tradstdc.h`) that exist only to compensate for running helpers on the
  build machine.
- `VERSION_SANITY` struct-size checks are still computed with the build
  machine's layout.

Upstream's own answer is a native build: compile and run everything on
the target. Kandelo can now run clang, `make`, and a POSIX userland
inside a guest, so it can offer that. Building inside Kandelo also turns
packages into real workloads for the platform, which surfaces POSIX and
toolchain gaps as platform feedback instead of hiding them behind
cross-compile patches.

## Goal

A package recipe can run its whole build (configure, `make`, helper
programs, compiling and linking) inside a Kandelo machine through the
normal SDK path, and publish the result through the normal package
system. NetHack is the first package built this way.

Non-goals:

- Building inside a browser. Package builds run on the Node host; the
  browser has no host-directory mount backend. This is a documented
  host boundary, not a parity gap in user-visible behavior.
- Replacing cross-compilation for every package. Recipes opt in.
- Running the package system itself (resolver, cache, publication)
  inside Kandelo.

## Current state

- **Guest execution during builds already exists.** `coreutils-docs`
  depends on `kernel@0.1.0` and `rootfs@0.1.0` and runs `coreutils.wasm`
  in a booted kernel (`images/vfs/scripts/generate-coreutils-man.ts`).
  WordPress preinstall and the opcache and Python prewarms boot
  `NodeKernelHost` with a read-write host mount and deterministic time.
  There is no production runner module: `coreutils-docs` imports the test
  helper `host/test/centralized-test-helper.ts`.
- **A guest compiler exists.** `kandelo-sdk.zip` (from
  `kandelo-sdk-browser-bundle@21.1.7`) carries clang 21.1.7, `wasm-ld`,
  `llvm-ar/ranlib/nm`, the sysroot, glue objects, and the guest wrapper
  `sdk/kandelo/bin/wasm32posix-cc`. `host/test/clang-in-guest.test.ts`
  compiles single files and a static library. Nothing runs `make` in a
  guest today.
- **The guest wrapper is not equivalent to the host SDK.** After
  `wasm-ld` it stops. It does not write the compiler-facts code hash,
  run `wasm-fork-instrument`, run Binaryen `wasm-opt`, strip
  `kandelo.calltypes` sections, or define `__unix__`/`__unix`
  (`docs/sdk-guide.md` "Compile inside the base shell"). A program
  compiled in the guest that calls `fork()` cannot run. This is
  "Future work" item 2 in
  `docs/superpowers/specs/2026-08-26-in-kandelo-clang-toolchain-design.md`.
- **The rootfs has the userland a build needs:** bash (also `/bin/sh`),
  make 4.4.1, coreutils, sed, grep, gawk, m4, diffutils, findutils, and
  posix-utils-lite (`patch`, `lex`, `yacc`, `ar`, `nm`). Its tools are
  lazy references resolved from package outputs.
- **Host facts a runner must respect** (`host/src/node-kernel-host.ts`):
  - `extraMounts` give read-write host directories, but files the guest
    creates are stored on the host as mode `0600`. Guest `chmod` and
    `chown` survive only in memory.
  - Mount points must avoid the kernel tmpfs prefixes (`/tmp`,
    `/var/tmp`, `/var/log`, `/var/run`, `/home/maker`, `/root`,
    `/srv`).
  - `imageBuildDeterminism` gives every new process a clock that starts
    at the epoch. Successive processes can then write files with older
    mtimes than their inputs, which breaks `make`.
  - There is no per-spawn timeout except `ownedJob`, which keeps only
    the last 256 KiB of output.

## Design

The work lands as three PRs. A and B are independent of each other and
of PR #1548. C needs A, B and #1548.

| PR | Delivers | Depends on |
|---|---|---|
| A | Build-inside-Kandelo runner and build image | `main` |
| B | Fork instrumentation and Binaryen inside Kandelo | `main` |
| C | NetHack built entirely inside Kandelo | A, B, #1548 |

### PR A: runner and build image

**Build image.** A new package, `kandelo-build-image`, produces
`kandelo-build-image.vfs.zst`: the rootfs with every lazy tool materialized
eagerly from its package output, plus the contents of `kandelo-sdk.zip`
expanded under `/usr`. It is a build-time artifact, never shipped to
browsers. Making it fully eager means a recipe needs only
`kernel@0.1.0` and `kandelo-build-image` as dependencies, and the
runner needs no lazy-asset binding. The composer maps each rootfs lazy
file to its package through `images/rootfs/PACKAGES.toml`, and verifies
each file's SHA-256 against the digest the rootfs recorded.

It deliberately does not reuse `shell.vfs.zst`. The shell contains
`nethack.zip`, so building NetHack from it would create a dependency
cycle. The shell also carries many unrelated bundles.

**Runner.** A Node-only library, `host/src/node-guest-build.ts`,
exported to recipes through a CLI (`scripts/guest-build.ts`) and a bash
helper (`scripts/guest-build.sh`, sourced like
`scripts/install-local-binary.sh`). The runner:

1. boots `NodeKernelHost` with the kernel and build image;
2. mounts one host workspace read-write at `/build` and any declared
   inputs (dependency prefixes) at caller-chosen paths outside the tmpfs
   prefixes;
3. runs one command (normally `/bin/sh -c '...'`) as root with an exact
   environment: `PATH=/usr/bin:/bin`, `HOME=/build/.home`,
   `TMPDIR=/build/.tmp`, `LC_ALL=C`, `TZ=UTC0`, `SOURCE_DATE_EPOCH`, plus
   caller additions;
4. streams guest stdout and stderr to the recipe's stderr and to a log
   file under `WASM_POSIX_DEP_WORK_DIR`;
5. enforces a timeout by destroying the host and reporting exit 124;
6. returns the guest exit status as its own.

Recipes copy their source into a workspace under
`WASM_POSIX_DEP_WORK_DIR` (never the checkout), run the build, then copy
outputs to `WASM_POSIX_DEP_OUT_DIR` and set file modes on the host.
Modes are set on the host because the mount does not persist guest
modes. Outputs are wasm modules and data files, so this loses nothing.

**Time.** The runner uses the real clock, not `imageBuildDeterminism`,
so `make` sees correctly ordered mtimes. Outputs must not depend on the
clock: `SOURCE_DATE_EPOCH` is passed in, and the double-build check
proves determinism. A clock that is both deterministic and safe for
`make` would be new kernel work, recorded as future work.

**Cache identity.** A recipe that uses the runner lists the runner, the
host runtime closure, and `cargo:runtime-core` in `build.toml` `inputs`,
following `packages/registry/coreutils-docs/build.toml`. The kernel and
build image are `depends_on` entries, so their cache keys feed the
recipe's key.

**Proof.** A fixture under `host/test/fixtures/guest-build/` has the same
shape as NetHack: a Makefile builds a generator, runs it to write a
header, and builds the final program from it, with `make -j2`. The
generator writes `sizeof(long)`, so the test proves the helper ran on
the target (`4`), not the build machine (`8`). The fixture's program does
not call `fork()`, so PR A does not depend on PR B.

### PR B: a guest compiler equivalent to the host SDK

> **As landed (#1580).** PR B took a different route from the one below.
> Instead of teaching the Bash guest wrapper the host SDK's steps, the
> host driver was rewritten in Rust (`crates/kandelo-cc`) and the same
> program runs on both sides, so the two SDKs share every compiler, link
> and post-link decision. The guest ships `wasm-opt` (`binaryen@126`) and
> compiler facts (the plugin compiled into clang). It does not ship
> `wasm-fork-instrument`: the instrumenter's dependencies do not build
> for Kandelo yet, so a program that calls `fork()` links in the guest
> but is instrumented on the build machine. The text below is the
> original plan.

PR B makes the compiler that runs inside Kandelo produce exactly what the
host SDK (`wasm32posix-cc` on the build machine) produces for the same
sources and flags: the same bytes, including compiler facts and fork
instrumentation. Anything less would make a package's output depend on
where it was built, which is the problem this work exists to remove.

- **`binaryen@126` package.** Builds `wasm-opt` with the Kandelo SDK
  through the Kandelo CMake platform, modelled on
  `packages/registry/clang/build-clang.sh`. Version 126 matches the host
  pin (`pkgs.binaryen` in `flake.nix`). It runs single-threaded
  (`BINARYEN_CORES=1`). Acceptance: guest `wasm-opt` produces the same
  bytes as host `wasm-opt` 126 on the same input.
- **`fork-instrument` package.** Builds `crates/fork-instrument` for
  `wasm32-unknown-kandelo-std`. The tool starts `wasm-opt` through
  `std::process`, which imports `kernel_fork`, so the tool itself is
  fork-instrumented on the host when it is packaged. It already removes
  the `kandelo.calltypes*` sections from every module it writes, so the
  guest needs no `llvm-objcopy`. A new mode writes the
  `kandelo.calltypes.code-sha256` section, which the host SDK writes in
  TypeScript (`withCodeHashSection` in `sdk/src/lib/calltypes-plugin.ts`).
  Acceptance: guest instrumentation of a fixture produces the same bytes
  as host instrumentation.
- **Compiler facts in the guest clang.** The facts plugin
  (`sdk/src/plugin/KandeloCallTypes.cpp`, `KandeloFnCasts.cpp`) is a
  native shared library that host clang loads at startup. The guest
  `clang.wasm` is built without plugin support, PIC or shared
  libraries, so it is statically linked in instead:
  - the optimization-pass half is registered through LLVM's static
    plugin mechanism, and runs only when the SDK's flags request it;
  - the AST-plugin registration is force-linked, so
    `-add-plugin kandelo-fncasts` finds it;
  - `LLVM_ENABLE_ZLIB=ON` against the `zlib` package, because the
    plugin refuses to emit fact chunks of 1 MiB or more without zlib;
  - the clang package lists the plugin sources as build inputs, so a
    plugin change rebuilds clang.
  Loading the plugin as a wasm side module was rejected: clang would have
  to become a dlopen-capable program that exports LLVM's C++ symbols.
- **Guest wrapper equivalence.** `sdk/kandelo/bin/wasm32posix-cc` is
  audited against `sdk/src/bin/cc.ts` and `sdk/src/lib/flags.ts`, and every
  difference is either removed or recorded with its reason:
  - compile flags: the plugin flags (CFI in trap mode, `-flto-unit`,
    `-fwhole-program-vtables`, `-add-plugin`, `-fpass-plugin`),
    `-D__unix__=1 -D__unix=1`, and anything else the host passes;
  - link: `--keep-section=target_features` whenever `wasm-opt` will run,
    as the host relinks;
  - after linking, as the host: a module that imports
    `kernel.kernel_fork` gets its code-hash section and is then
    fork-instrumented with its facts and optimized with `wasm-opt -Os`;
    any other module has its facts removed and then gets the
    `wasm-opt <out> -O<n> -o <out>` pass clang schedules for `-O1` and
    above.
- **Bundle.** `kandelo-sdk.zip` gains `wasm-opt` and
  `wasm-fork-instrument`.
- **Acceptance.** For C and C++ fixtures, one that forks and one that
  does not, at `-O0`, `-O2` and `-Os`: the guest output is
  byte-identical to the host SDK's, the instrumenter reports that it used
  compiler facts rather than falling back, the runtime admits the
  program, and the forking program forks correctly on Node and in a
  browser.

The ABI contract stamp is not part of the compiler on either side. The
host SDK's `cc` does not stamp; the package system stamps every published
program output at cache-store time and refuses a second stamp. The guest
compiler matches that.

### PR C: NetHack built inside Kandelo

`build-nethack.sh` becomes a host wrapper plus a guest script
(`build-nethack-guest.sh`):

- **Host wrapper.** Stages verified source into the workspace, mounts
  the ncurses dependency read-only at `/deps/ncurses`, runs the guest
  script through the runner, copies `nethack.wasm` and
  `runtime/share/nethack/{nhdat,symbols,license}` to the output
  directory with their modes, and installs. Instrumentation already
  happened in the guest, so `install_local_binary` must accept a
  completely instrumented module without instrumenting it again.
- **Guest script.** Applies the target patches (curses, `COMPRESS`,
  `SYSCF`, `HACKDIR`/`VAR_PLAYGROUND`/`PORT_ID`, the `tputs` signature,
  the termcap backspace fallback, and the `src/Makefile` ncurses and
  `-DSECURE` changes). It then runs upstream's
  `sys/unix/setup.sh hints/linux` and `make` with `CC=cc`. It uses
  upstream's pre-generated parser sources (`sys/share/dgn_yacc.c`,
  `dgn_lex.c`, `lev_yacc.c`, `lev_lex.c`, `dgn_comp.h`, `lev_comp.h`)
  instead of running `yacc` and `lex`.
- **Removed.** The `qtext.h`/`questpgr.c`/`makedefs.c` and `global.h`
  layout patches, the `tradstdc.h` macOS patch, the host build phase,
  future-dating host artifacts, and the `make -C src clean` dance.
- **Kept.** `-DREPRODUCIBLE_BUILD` for `makedefs` and the
  `SOURCE_DATE_EPOCH` floor, because `makedefs` rejects dates before
  2015. `PORT_ID "Kandelo"` stays: a guest build without it would say
  `Unix`, and "Kandelo" is the product label.

Acceptance:

- `nhdat` from the guest build, without the layout patches, is
  byte-identical to `nhdat` from today's host build with them. That
  proves the patches only compensated for host helpers.
- Two builds in different work directories produce identical
  `nethack.wasm` and `nhdat`.
- Every existing NetHack test passes: the shared-playground save and
  restore test, the banner check, the package-system bridge test, and
  both browser specs.
- `scripts/test-package-build-roots.sh` asserts the recipe compiles
  nothing with the build machine's compiler.

## Decisions for review

1. **Node-only builds.** Building inside Kandelo is a Node host facility.
2. **Real clock during builds.** Determinism comes from
   `SOURCE_DATE_EPOCH` and is proven by double builds, not from a
   deterministic guest clock, because the current deterministic clock
   breaks `make`.
3. **Eager build image.** The image is larger, but a recipe needs two
   dependencies instead of a lazy-asset binding for every rootfs tool.
4. **The guest compiler is equivalent to the host SDK.** Same bytes for
   the same sources and flags, compiler facts included. Built inside or
   outside Kandelo, a package comes out the same.
5. **ABI stamping stays in the package system.** It is publication
   metadata applied to every package. "Entirely inside Kandelo" covers
   compiling, linking, helpers, instrumentation and optimization, not
   cache-store stamping.
6. **`PORT_ID "Kandelo"` stays** after NetHack moves into the guest.

## Risks

- **`make` in the guest is untested.** Parallel jobs use `posix_spawn`
  and the GNU make jobserver FIFO. Several concurrent clang processes
  may hit the process-memory budget.
- **Eager image size.** The clang tools are large. If the image does not
  fit the kernel's memory or the host's image handling, the fallback is
  a lazy image with closed lazy assets supplied by the runner.
- **Binaryen in the guest.** Exception use, deep recursion against
  engine stack limits (already seen with clang on WebKit), and memory
  under the 1 GiB process ceiling are unproven.
- **`wasm-fork-instrument` in the guest.** walrus holds the whole module
  in memory; very large inputs may exceed the ceiling.
- **Facts plugin in `clang.wasm`.** How LLVM 21 statically registers
  both plugin halves in this build is unconfirmed, the plugin and CFI
  flags raise compile memory under the 1 GiB process ceiling, and every
  plugin change now rebuilds clang (about 1.5 hours).
- **Build time.** clang running as wasm is slower than native clang.
  Neither the in-guest NetHack build nor the cost of the per-helper
  alternative has been measured.
- **Mount semantics.** `O_APPEND` on a host mount needs
  `exclusiveNativeWriters`, and `readonly` is advisory. Build logs and
  tools that append must be checked.

## Future work

- A deterministic guest clock that is safe for `make` (one logical clock
  shared by all processes).
- Build-inside-Kandelo for packages beyond NetHack, and an in-guest
  `pkg-config`, autotools and CMake.
