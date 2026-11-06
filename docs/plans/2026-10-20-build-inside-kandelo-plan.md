# Building Packages Inside Kandelo: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps
> use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a package recipe run its entire build inside a Kandelo
machine through the normal SDK path, then build NetHack that way.

**Architecture:** PR A adds a Node-only runner (`host/src/node-guest-build.ts`
plus CLI and bash helper) and an eager build image package
(`kandelo-build-image`: rootfs plus the guest toolchain). PR B packages
Binaryen and `wasm-fork-instrument` for Kandelo and teaches the guest
`cc` wrapper the host SDK's post-link steps. PR C splits the NetHack
recipe into a host wrapper and a guest script that runs upstream's
native build.

**Tech Stack:** TypeScript (`NodeKernelHost`, `KandeloImageFs`), bash
recipes, Vitest, Rust (`crates/fork-instrument`), C++/CMake (Binaryen),
the guest clang 21.1.7 toolchain.

**Design:** [2026-10-20-build-inside-kandelo-design.md](2026-10-20-build-inside-kandelo-design.md)

## Global constraints

- Read `CLAUDE.md`, `docs/agent-guidance/packages-and-builds.md`,
  `docs/agent-guidance/host-runtime.md` and
  `docs/agent-guidance/validation.md` before starting each PR.
- Build and test only under `scripts/dev-shell.sh`. Use
  `scripts/agent-job` for anything over ten minutes.
- Recipes write only under `WASM_POSIX_DEP_WORK_DIR` and
  `WASM_POSIX_DEP_OUT_DIR`; never write the checkout.
- New Vitest files are listed in `scripts/ci-vitest-evidence-classes.tsv`
  (`prepared-product` when they need built artifacts).
- Commit subjects use `Area: Purpose` prefixes. End commit bodies with
  the session's `Co-Authored-By` trailer. Each PR begins its description
  with `## Why`.
- Bump a package's `build.toml` `revision` only when its output bytes
  change.
- PRs A and B branch from `main` independently. PR C branches from
  `main` after A, B and #1548 have merged.

---

## PR A: runner and build image

### Task A1: Runner request validation

**Files:**
- Create: `host/src/node-guest-build.ts`
- Test: `host/test/node-guest-build.test.ts`

- [ ] **Step 1: Write failing tests for request validation**

```ts
import { describe, expect, it } from "vitest";
import { validateGuestBuildRequest } from "../src/node-guest-build";

const base = {
  workspace: "/abs/work",
  argv: ["/bin/sh", "-c", "true"],
  sourceDateEpoch: 1704067200,
  timeoutMs: 60_000,
};

describe("validateGuestBuildRequest", () => {
  it("accepts a minimal request and mounts the workspace at /build", () => {
    expect(validateGuestBuildRequest(base).mounts).toEqual([
      { mountPoint: "/build", hostPath: "/abs/work" },
    ]);
  });

  it("refuses inputs mounted under a kernel tmpfs prefix", () => {
    expect(() => validateGuestBuildRequest({
      ...base,
      inputs: [{ guestPath: "/tmp/deps", hostPath: "/abs/deps" }],
    })).toThrow(/tmpfs/);
  });

  it("refuses relative paths and a second mount at /build", () => {
    expect(() => validateGuestBuildRequest({ ...base, workspace: "rel" }))
      .toThrow(/absolute/);
    expect(() => validateGuestBuildRequest({
      ...base,
      inputs: [{ guestPath: "/build", hostPath: "/abs/x" }],
    })).toThrow(/\/build/);
  });

  it("builds the exact guest environment", () => {
    expect(validateGuestBuildRequest({ ...base, env: { CC: "cc" } }).env)
      .toEqual([
        "PATH=/usr/bin:/bin",
        "HOME=/build/.home",
        "TMPDIR=/build/.tmp",
        "LC_ALL=C",
        "TZ=UTC0",
        "SOURCE_DATE_EPOCH=1704067200",
        "CC=cc",
      ]);
  });
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `scripts/dev-shell.sh npx vitest run --root . host/test/node-guest-build.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `validateGuestBuildRequest`**

Import `KERNEL_TMPFS_OWNED_PREFIXES` from `host/src/vfs/default-mounts.ts`.
A guest path is refused when it equals a prefix or starts with
`prefix + "/"`. Caller `env` entries cannot override the base keys;
reject duplicates rather than silently replacing them. Add a `WHY`
comment explaining that `/build/.home` and `/build/.tmp` keep tool
scratch on the workspace mount instead of tmpfs, which lives in kernel
memory.

- [ ] **Step 4: Run the tests and confirm they pass**

- [ ] **Step 5: Commit** (`Host: Validate guest build requests`)

### Task A2: Run a command and report its status

**Files:**
- Modify: `host/src/node-guest-build.ts`
- Test: `host/test/node-guest-build.test.ts`

- [ ] **Step 1: Write failing end-to-end tests** using the built rootfs
  (`tryResolveBinary("programs/rootfs.vfs.zst")` and `kernel.wasm`; skip
  when absent, as `host/test/man-shell-lazy-archive.test.ts` does):
  - `["/bin/sh","-c","echo hi > /build/out.txt; exit 3"]` returns
    `{ exitCode: 3, timedOut: false }` and `out.txt` on the host
    contains `hi`.
  - `["/bin/sh","-c","sleep 100"]` with `timeoutMs: 2000` returns
    `{ timedOut: true }` within ten seconds.
  - Guest output arrives through the `log` callback in order.
- [ ] **Step 2: Run them and confirm they fail**
- [ ] **Step 3: Implement `runGuestBuild(request)`**
  - Create `NodeKernelHost` with `rootfsImage`, `extraMounts` from the
    validated mounts (inputs with `readonly: true`), and
    `onStdout`/`onStderr` forwarding to `log`.
  - Create `/build/.home` and `/build/.tmp` on the host before boot.
  - `spawnFromVfs(argv[0], argv, { env, cwd, uid: 0, gid: 0 })`.
  - Race the exit promise against the timeout; on timeout call
    `host.destroy()` and return `{ exitCode: 124, timedOut: true }`.
  - Always `destroy()` in `finally`.
  - Do not set `imageBuildDeterminism`. Add a `WHY` comment: its
    per-process clock restarts at the epoch, so later processes write
    older mtimes than their inputs and `make` rebuilds or skips the
    wrong targets.
- [ ] **Step 4: Run the tests and confirm they pass**
- [ ] **Step 5: Commit** (`Host: Run a build command inside a Kandelo machine`)

### Task A3: CLI and recipe helper

**Files:**
- Create: `scripts/guest-build.ts`, `scripts/guest-build.sh`
- Test: `host/test/node-guest-build.test.ts` (CLI argument parsing)

- [ ] **Step 1: Write failing tests** for the CLI parser:
  `--kernel <path> --image <path> --workspace <dir> --input <guest>=<host>`
  (repeatable) `--env K=V` (repeatable) `--timeout-ms N` `--log <file>`
  `-- argv...`. Unknown flags and a missing `--` are errors.
- [ ] **Step 2: Run them and confirm they fail**
- [ ] **Step 3: Implement**
  - `scripts/guest-build.ts` parses arguments, reads the kernel and image,
    calls `runGuestBuild`, tees guest output to stderr and `--log`, and
    exits with the guest status.
  - `scripts/guest-build.sh` defines `kandelo_guest_build <workspace>
    <timeout-ms> [--input g=h ...] -- <argv...>`. It takes the kernel
    from `$WASM_POSIX_DEP_KERNEL_DIR/kandelo-kernel.wasm` and the image
    from `$WASM_POSIX_DEP_KANDELO_BUILD_IMAGE_DIR/kandelo-build-image.vfs.zst`,
    writes the log to `$WASM_POSIX_DEP_WORK_DIR/guest-build.log`, and
    runs `node node_modules/tsx/dist/cli.mjs` with a short `TMPDIR`, as
    `packages/registry/coreutils-docs/build-coreutils-docs.sh:42-51`
    does for the macOS socket-path limit.
- [ ] **Step 4: Run the tests and confirm they pass**
- [ ] **Step 5: Commit** (`Packages: Let recipes run their build inside Kandelo`)

### Task A4: `kandelo-build-image` package

**Files:**
- Create: `packages/registry/kandelo-build-image/{package.toml,build.toml,build-kandelo-build-image.sh}`
- Create: `images/vfs/scripts/build-kandelo-build-image.ts`
- Test: `tests/package-system/kandelo-build-image.test.ts`

- [ ] **Step 1: Write a failing test** that composes the image from
  fixture inputs and asserts:
  - every rootfs lazy file is now resident, with the bytes its package
    output provided and the SHA-256 the rootfs recorded;
  - `/usr/lib/llvm/bin/clang` and `/usr/bin/cc` are resident;
  - a byte mismatch against the recorded digest fails the build;
  - two compositions are byte-identical.
- [ ] **Step 2: Run it and confirm it fails**
- [ ] **Step 3: Implement the composer**
  - Load the rootfs image with `KandeloImageFs.loadImage`.
  - Map each lazy file to its package and artifact through
    `images/rootfs/PACKAGES.toml`. Read bytes from the matching
    `WASM_POSIX_DEP_<NAME>_DIR`. Refuse a digest mismatch.
  - Expand `kandelo-sdk.zip` under `/usr` with the archive's modes.
  - Export with `SOURCE_DATE_EPOCH` timestamps.
- [ ] **Step 4: Write the package**
  - `depends_on`: `rootfs@0.1.0`, `kandelo-sdk-browser-bundle@21.1.7`,
    and every package `images/rootfs/PACKAGES.toml` lists.
  - Output `kandelo-build-image.vfs.zst`.
  - `build.toml` `inputs`: the recipe, the composer and its runtime
    imports, `images/rootfs/PACKAGES.toml`,
    `images/vfs/lib/kandelo-image-fs.ts`, `cargo:kandelo-image-module`,
    `cargo:runtime-core`. Copy the shape of
    `packages/registry/coreutils-docs/build.toml`.
- [ ] **Step 5: Build it**
  Run: `scripts/dev-shell.sh ./run.sh build kandelo-build-image`, adding
  a `run.sh` target if needed. Record the image size. If the kernel or
  host cannot load it, stop and switch to the lazy fallback described
  under Risks in the design doc.
- [ ] **Step 6: Run the test and confirm it passes**
- [ ] **Step 7: Commit** (`Packages: Add a build image with the guest toolchain`)

### Task A5: Prove a native build through the runner

**Files:**
- Create: `host/test/fixtures/guest-build/gen-header/{Makefile,gen.c,main.c}`
- Create: `host/test/guest-build-make.test.ts`
- Modify: `scripts/ci-vitest-evidence-classes.tsv`

The fixture has the shape of NetHack's build:

```make
# Makefile
all: hello.wasm
gen: gen.c
	$(CC) -O2 -o $@ gen.c
generated.h: gen
	./gen > $@
main.o: main.c generated.h
	$(CC) -O2 -c main.c
hello.wasm: main.o
	$(CC) -o $@ main.o
```

```c
/* gen.c: runs during the build; must describe the target */
#include <stdio.h>
int main(void) {
  printf("#define GEN_SIZEOF_LONG %zu\n", sizeof(long));
  return 0;
}
```

```c
/* main.c */
#include <stdio.h>
#include "generated.h"
int main(void) {
  printf("sizeof(long) at build: %d\n", GEN_SIZEOF_LONG);
  return 0;
}
```

- [ ] **Step 1: Write the failing test.** Copy the fixture into a temp
  workspace, run `kandelo_guest_build`'s CLI with
  `["/bin/sh","-c","make -j2 CC=cc"]`, then assert:
  - exit 0;
  - `generated.h` contains `GEN_SIZEOF_LONG 4` (target, not the build
    machine's 8);
  - running `hello.wasm` under `NodeKernelHost` prints
    `sizeof(long) at build: 4`;
  - a second build in a different workspace path produces byte-identical
    `hello.wasm`.
- [ ] **Step 2: Run it.** Expected: FAIL until the image exists, then
  either PASS or a real in-guest `make` problem. Treat a `make`,
  `posix_spawn` or jobserver failure as a platform bug to fix in this
  PR, not a fixture to simplify.
- [ ] **Step 3: Fix what it surfaces; rerun until it passes**
- [ ] **Step 4: Register the test as `prepared-product`**
- [ ] **Step 5: Commit** (`Packages: Prove a generator-driven make build inside Kandelo`)

### Task A6: Documentation and validation

- [ ] Add "Building inside Kandelo" to `docs/package-management.md`: when
  to use it, the recipe contract, `inputs` and `depends_on`
  requirements, mode handling, the real-clock rule, and the Node-only
  boundary. Link it from `docs/agent-guidance/packages-and-builds.md`.
- [ ] Run `scripts/dev-shell.sh bash scripts/ci-run-test-suite.sh vitest`
  and `cargo-workspace`; report results, and re-run any timeouts in
  isolation as before.
- [ ] Commit (`Docs: Describe building packages inside Kandelo`) and open
  PR A.

---

## PR B: a guest compiler equivalent to the host SDK

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

Goal: for the same sources and flags, the compiler inside Kandelo
produces the same bytes as the host SDK, compiler facts and fork
instrumentation included. Expand each task into test/implement/verify/
commit steps when the PR starts; their exact shape depends on what the
Binaryen and plugin work surfaces.

### Task B1: Equivalence audit and harness

- Tabulate every step `sdk/src/bin/cc.ts` and `sdk/src/lib/flags.ts`
  take (compile flags, glue objects, link flags, the relink with
  `--keep-section=target_features`, code hash, facts stripping,
  `wasm-opt`) against `sdk/kandelo/bin/wasm32posix-cc`. Record the table
  in `docs/sdk-guide.md` ("Compile inside the base shell").
- Write the acceptance harness first: compile C and C++ fixtures (one
  that forks, one that does not) at `-O0`, `-O2` and `-Os` with the host
  SDK and inside the build image from PR A, and compare bytes. It fails
  until B2-B5 land; every remaining difference must be named.

### Task B2: `binaryen@126` package

- Recipe modelled on `packages/registry/clang/build-clang.sh`: Kandelo
  CMake platform, private sysroot with `libcxx`, static libc++,
  `-fwasm-exceptions` (Binaryen reports bad input by throwing),
  `BUILD_TESTS=OFF`, single-threaded at run time.
- **Gate:** guest `wasm-opt -O2`/`-Os` on fixture modules, including a
  fork-instrumented one, produces bytes identical to host `wasm-opt` 126.

### Task B3: `fork-instrument` package and the code-hash mode

- Add a mode to `crates/fork-instrument` that writes the
  `kandelo.calltypes.code-sha256` section exactly as
  `withCodeHashSection` (`sdk/src/lib/calltypes-plugin.ts`) does, with a
  Rust test comparing it against the TypeScript writer's output.
- Package the crate for `wasm32-unknown-kandelo-std` in a two-member
  workspace under the work dir, crates vendored from `Cargo.lock`. The
  tool spawns `wasm-opt`, so it is fork-instrumented on the host.
- **Gate:** inside a guest, instrumenting a fixture with facts produces
  bytes identical to the host tool's output, and `--sink-report` shows
  the facts were used.

### Task B4: Compiler facts in the guest clang

- Statically link `sdk/src/plugin/KandeloCallTypes.cpp` and
  `KandeloFnCasts.cpp` into the clang package build: register the pass
  half through LLVM's static plugin mechanism, gated on the SDK's flags;
  force-link the `kandelo-fncasts` frontend plugin registration.
- `LLVM_ENABLE_ZLIB=ON` against the `zlib` package; add it to the clang
  package's `depends_on`. Add the plugin sources to its `build.toml`
  inputs. Bump its revision.
- **Gate:** guest clang compiling a fixture with the SDK's plugin flags
  emits a `kandelo.calltypes` section byte-identical to host clang's.

### Task B5: Guest wrapper equivalence

- In `sdk/kandelo/bin/wasm32posix-cc`: add the plugin flags and
  `-D__unix__=1 -D__unix=1` to compiles; link with
  `--keep-section=target_features` when `wasm-opt` will run; after
  linking, a fork-capable module gets its code hash, then
  `wasm-fork-instrument` (facts on, `wasm-opt -Os`); any other module
  has its facts removed, then `wasm-opt <out> -O<n> -o <out>` for `-O1`
  and above.
- Include `wasm-opt` and `wasm-fork-instrument` in `kandelo-sdk.zip`
  (`images/vfs/scripts/build-kandelo-sdk-zip.sh`).

### Task B6: Acceptance and documentation

- The B1 harness passes with no recorded differences.
- Node (`host/test/clang-in-guest.test.ts`) and Chromium
  (`apps/browser-demos/test/kandelo-compiler.spec.ts`): a program that
  forks, waits and checks its child's status compiles in the guest,
  passes `describeWasmArtifactPolicyFailures` with no failures, and runs
  `fork()` correctly.
- Update `docs/sdk-guide.md` and mark future-work item 2 done in
  `docs/superpowers/specs/2026-08-26-in-kandelo-clang-toolchain-design.md`.

## PR C: NetHack built inside Kandelo

Starts after A, B and #1548 merge. Expand tasks into steps when it starts.

### Task C1: Record the baseline

- From the current host-built recipe, save `nhdat`, `nethack.wasm` and
  the generated `include/date.h` as comparison artifacts. Task C4 needs
  them.

### Task C2: Split the recipe

- `packages/registry/nethack/build-nethack.sh` becomes the host wrapper:
  stage verified source under `WASM_POSIX_DEP_WORK_DIR`, run
  `kandelo_guest_build` with `--input /deps/ncurses=$WASM_POSIX_DEP_NCURSES_DIR`,
  copy outputs to `WASM_POSIX_DEP_OUT_DIR` with modes, install.
- `packages/registry/nethack/build-nethack-guest.sh` runs inside the
  guest: target patches, `sh sys/unix/setup.sh hints/linux`, copy the
  `sys/share` parser sources where `util/Makefile` expects them, then
  `make` with `CC=cc`, `AR=wasm32posix-ar`, `RANLIB=wasm32posix-ranlib`
  and the ncurses paths.
- `package.toml`: add `kernel@0.1.0` and `kandelo-build-image` to
  `depends_on`. `build.toml`: add the guest script and the runner inputs;
  bump `revision`.
- Make `scripts/install-local-binary.sh` accept a completely
  instrumented module under `auto` without instrumenting it again, with
  a test.

### Task C3: Remove host-only patches

- Delete the `qtext.h`/`questpgr.c`/`makedefs.c` and `global.h` layout
  patches, the `tradstdc.h` patch, the host util build, the
  `touch -t 2040...` step, and the `make -C src clean` sequence.
- Keep `-DREPRODUCIBLE_BUILD`, the `SOURCE_DATE_EPOCH` floor, and
  `PORT_ID "Kandelo"`.

### Task C4: Acceptance

- `nhdat` equals the C1 baseline byte for byte.
- `date.h` names Kandelo and the pinned date. `nethack.wasm` contains no
  build-machine OS name.
- Two builds in different work directories are byte-identical.
- `scripts/test-package-build-roots.sh`: replace the check for
  `make -j1 CC=cc ...` with one asserting the recipe compiles nothing
  with the build machine's compiler.
- Existing tests pass: `host/test/nethack-shared-playground.test.ts`,
  `tests/package-system/source-rootfs-shell-bridge.test.ts`,
  `host/test/shell-lazy-archive-inputs.test.ts`,
  `apps/browser-demos/test/kandelo-merge-gate.spec.ts`,
  `apps/browser-demos/test/kandelo-source-rootfs-shell.spec.ts`.
- Browser check with `./run.sh browser`: save, restore, banner.
- Record the build time and `nethack.wasm` size against the host-built
  baseline. With an equivalent guest compiler, `nethack.wasm` should
  match a host build of the same sources; any difference is a PR B
  equivalence bug.

### Task C5: Documentation

- Update the NetHack notes in `docs/porting-guide.md` and
  `docs/software-targets.md` to describe the native build.
