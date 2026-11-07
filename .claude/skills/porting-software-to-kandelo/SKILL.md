---
name: porting-software-to-kandelo
description: Use when porting a program or library to Kandelo, adding or changing a package under packages/registry, or writing package.toml, build.toml, or package build scripts.
---

# Porting Software to Kandelo

## Overview

A port is a package built through the normal path: SDK, sysroot, resolver, cache. Build failures are platform feedback first (CLAUDE.md "Package And Build Contract"; `docs/agent-guidance/packages-and-builds.md`). This skill routes you to the authoritative sections and to current-contract reference packages so you do not have to reverse-engineer conventions from the registry.

## Start from a current-contract reference, not a nearby package

Many registry scripts predate the resolver contract (e.g. `bzip2` writes into its package directory and the sysroot). Copy the shape of one of these instead:

| Build system | Reference |
|---|---|
| autoconf program, no deps | `packages/registry/lhasa/` |
| autoconf program + library dep, honest `LIBS` | `packages/registry/nano/` (ncurses) |
| autoconf library | `packages/registry/readline/` |
| meson library | `packages/registry/libevdev/` |
| plain make program | `packages/registry/tyrquake/` |
| cmake program | `packages/registry/espeak-ng/` |
| multi-output program | `packages/registry/diffutils/` |
| runtime files as a lazy archive | vim, per `docs/porting-guide.md` "Reference implementation" |

The current shape: `source scripts/package-build-roots.sh`, `kandelo_package_prepare_build_roots`, `kandelo_package_stage_verified_source`, `source sdk/activate.sh`, configure/make under the work dir, then `install_local_binary` (usage in the header of `scripts/install-local-binary.sh`; it applies the manifest's fork policy).

## Where the contract lives

| Question | Read |
|---|---|
| Directory, `package.toml`, `build.toml` fields | `docs/porting-guide.md` "Adding a new package to the registry"; `docs/package-management.md` "Schema" |
| Env vars a build script gets and must honor | `docs/package-management.md` "Build-script contract" |
| Dep include/lib flags | `docs/package-management.md` "The CPPFLAGS/LDFLAGS contract" |
| `kernel_abi` value | Current `ABI_VERSION` in `crates/program-abi/src/lib.rs`. Required with `[build]`; recorded as a floor but not yet enforced, so neighbouring manifests and doc examples carry stale values. Do not copy them. |
| C++ programs | `depends_on` libcxx plus `kandelo_package_prepare_private_sysroot`, as in `packages/registry/dinit/` |
| Rust programs and dependency portability | `sdk/rust/README.md` "Porting Rust dependencies"; termchat is the standalone program reference, librsvg/rsvg-convert cover native dependencies |
| Fork-using programs | `docs/fork-instrumentation.md` |
| The build compiles helpers and runs them to generate headers or data the program reads (type sizes, struct layouts, OS names must be the target's) | Build inside a Kandelo machine with `scripts/guest-build.sh`: `docs/package-management.md` "Building inside Kandelo". `host/test/fixtures/guest-build/gen-header` is the smallest working example. Do not patch layouts to agree with a host-built helper |
| Large compiler builds or engine resource failures | `docs/porting-guide.md` "Large compiler builds and runtime limits"; `docs/browser-support.md` "Firefox executable-code limit" |
| Include it in `./run.sh setup` / `local-build` | Add a `[[packages]]` entry to `packages/sets/local-supported.toml` (the local-build set; an unlisted package is never built there) |
| Shared build changes affect dormant or unlisted image recipes | `docs/agent-guidance/packages-and-builds.md` "Image recipes outside the default build"; validate affected recipes without changing product exposure |
| Output paths | `cargo xtask build-deps output-path <pkg> <wasm>`, never hardcoded |

Read those sections by heading (`rg -n '^#'` then read the relevant
lines), not whole files.

## Build loop

```bash
bash .agents/skills/porting-software-to-kandelo/scripts/build-package.sh <pkg> [wasm32|wasm64]
```

It uses the declared dev-shell tool PATH without a login shell. It prints
one status line and, on failure, the first error lines and the end of the
log; the full log stays in `.context/build-<pkg>-<arch>.log`.

For a long build, use:

```bash
scripts/agent-job start -- bash .agents/skills/porting-software-to-kandelo/scripts/build-package.sh <pkg> [wasm32|wasm64]
scripts/agent-job wait <id>
```

Wait from the main session. See `docs/agent-guidance/validation.md`
"Waiting on long builds and suites"; do not have a subagent poll it.

Do not edit anything under `packages/registry/` while a local build
(`./run.sh setup`, `local-build`, `build <pkg>`, or the script above) is
running. The engine reads the registry once, and at publication it fails
with "package registry changed while generating program-packages.json;
retry from one stable registry snapshot", even when every node built.
Stop the build, make the edit, and start it again.

### Try it in a machine: a partial image, by default

Unless the user asked for the full build (or a canonical image by name),
port and test against a partial image, not the whole shell. **Tell the user
before you build**, in one sentence, for example: "I'll test this on a
partial shell (the rootfs base plus <pkg>) rather than building the whole
shell; say if you want the full build." Announce and proceed; do not wait
for permission, and do not switch silently. When to use the full build
instead, and what the final report must say: `docs/agent-guidance/packages-and-builds.md`
"Partial images are development builds".

Once the package builds, put
it in the canonical shell's contract (its role in
`packages/registry/shell/source-rootfs-shell-dependencies.json`, the same
`name@version` in `packages/registry/shell/package.toml` `depends_on`, and
its entry in the composer table that installs it: `SHELL_LAZY_BINARY_SPECS`
or `SHELL_LAZY_ARCHIVE_SPECS`), then compose a shell carrying only the
rootfs base and your package:

```bash
./run.sh partial shell <pkg> [<pkg>...]   # --with-tests runs packages/registry/<pkg>/test/
./run.sh browser --partial                # its own gallery machine; no full local-build
```

The image lands in `local-binaries/partial/`; its output names the
activities it kept and the packages each left-out activity needs. It is a
development build: never cached, not evidence for the canonical image. Build
the canonical shell (`./run.sh local-build`) once, as the integration check
before the PR, and say in the final report which partial image the evidence
came from and whether the canonical build ran. Details:
`docs/package-management.md` "Partial images".

When a build fails, fix the first error, not the last: later errors and `BLOCKED` packages are usually fallout. Search the log (`rg -n`) and read around the hit rather than reading it whole. The resolver deletes the work directory on failure, so `config.log` is gone; to see it, re-run configure by hand in a scratch directory.

A recipe that builds inside Kandelo runs its compiles in the guest, so
its failures show up in the guest's output (also written to
`$WASM_POSIX_DEP_WORK_DIR/guest-build.log`, which goes with the work
directory). To iterate, run the recipe by hand with the `WASM_POSIX_DEP_*`
variables pointing at a work directory you keep and at the cached
`kernel` and `kandelo-build-image` outputs, then rerun single commands in
that workspace with `kandelo_guest_build`. Things that differ from a
cross build:

- The guest compiler is `cc` (`c++`, `wasm32posix-ar`, ...). The build
  image is the rootfs with every tool resident (`make`, `m4`, `awk`, ...);
  check with `command -v` in the guest. `yacc` is Berkeley yacc and `lex`
  is flex, without their `-ly`/`-ll` libraries. Several other base tools
  from `posix-utils-lite` are placeholders that report success without
  doing the work (`patch`, `compress`, `iconv`, `ed`, ...): see
  "Base-image utilities that are placeholders" in `docs/posix-status.md`
  before relying on one in a build.
- Dependencies are `--input` mounts (`/deps/<name>`), so paths written into
  Makefiles must be the guest's, not the build machine's.
- Guest-created files reach the build machine as mode 0600; set modes when
  installing outputs.
- The base C/C++ SDK archive omits the fork instrumenter. Add the
  `wasm-fork-instrument` guest package when builds need preparation inside
  Kandelo; the self-contained Rust SDK includes it already (see
  `docs/rust-target.md` "Cargo inside Kandelo"). With only the base SDK,
  let `install_local_binary` instrument on the build machine.
- Each guest compile starts clang inside Kandelo and costs seconds, and a
  link several times that, so keep `make -j` where upstream allows it.
- A guest build that fails differently from the cross build may be a
  platform defect (a syscall, the host mount, the guest SDK). Treat it as
  one before patching the package.

## Platform facts that make ports go wrong

- **Executable link probes reject unknown symbols.** Since ABI 46, the
  SDK permits unresolved executable symbols only from its generated host
  import list; shared-library side modules resolve imports dynamically.
  Inspect `sdk/config.site` and upstream's actual cache keys before
  overriding probes: custom macros can need `ac_cv_funclib_*` or
  `ac_cv_lib_m_*` as well as `ac_cv_func_*`. Verify defined target
  functions (`T` or `W`, not `U`) with the target `nm`, and put required
  libraries on `LIBS` explicitly. Symbol presence does not prove runtime
  syscall support; check `docs/posix-status.md`. See
  `docs/porting-guide.md` "Step 1: Cross-compile" and
  `docs/sdk-guide.md` "Linker flags injected automatically" for details.
- **Never define `__linux__`** SDK-wide, and not per package without the maintainer's agreement. Kandelo is not a Linux target (`sdk/config.site` header). Look for a feature macro or cache variable the upstream already checks.
- **Main-thread shadow stack defaults to 8 MiB; pthreads default to
  128 KiB.** The SDK honors explicit main-stack requests, including
  smaller ones, with the last linker operand winning. Pthread attributes
  can change thread stacks. A shadow-stack overflow can silently corrupt
  linear memory. The browser's native Wasm call stack and executable-code
  arena are separate resources; see `docs/sdk-guide.md` "Why an 8 MiB
  main-thread stack" and the large-compiler section of
  `docs/porting-guide.md`.
- **Wasm traces without names** mean `wasm-opt` stripped the name section; keep it for debugging rather than guessing from `wasm-function[N]`.
- **A missing POSIX API is a platform gap**, not a package patch. Stub honestly or implement it in the kernel/libc.

## Feedback

End your final report with one line, so maintainers can see where this skill helped or misled:
`Skill feedback (porting-software-to-kandelo): used <what>; wrong: <what or none>; missing: <what or none>`
