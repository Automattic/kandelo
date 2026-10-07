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
| `kernel_abi` value | Current `ABI_VERSION` in `crates/shared/src/lib.rs`. Required with `[build]`; recorded as a floor but not yet enforced, so neighbouring manifests and doc examples carry stale values. Do not copy them. |
| C++ programs | `depends_on` libcxx plus `kandelo_package_prepare_private_sysroot`, as in `packages/registry/dinit/` |
| Fork-using programs | `docs/fork-instrumentation.md` |
| Large compiler builds or engine resource failures | `docs/porting-guide.md` "Large compiler builds and runtime limits"; `docs/browser-support.md` "Firefox executable-code limit" |
| Include it in `./run.sh setup` / `local-build` | Add a `[[packages]]` entry to `packages/sets/local-supported.toml` (the local-build set; an unlisted package is never built there) |
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

When a build fails, fix the first error, not the last: later errors and `BLOCKED` packages are usually fallout. Search the log (`rg -n`) and read around the hit rather than reading it whole. The resolver deletes the work directory on failure, so `config.log` is gone; to see it, re-run configure by hand in a scratch directory.

## Platform facts that make ports go wrong

- **Executable link probes reject unknown symbols.** The SDK permits only
  its declared host imports to remain undefined; side modules use a
  separate dynamic-linking policy. See `docs/sdk-guide.md` "Linker flags
  injected automatically". Seed cross-run probes from verified target
  facts in `sdk/config.site`, and put required libraries on `LIBS`
  explicitly. A linkable symbol alone does not prove its runtime
  semantics; check `docs/posix-status.md` before claiming support.
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
