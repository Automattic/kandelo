---
name: porting-software-to-kandelo
description: Use when porting a program or library to Kandelo, adding or changing a package under packages/registry, or writing a package.toml, build.toml, or build-<name>.sh.
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
| Include it in `./run.sh setup` / `local-build` | Add a `[[packages]]` entry to `packages/sets/local-supported.toml` (the local-build set; an unlisted package is never built there) |
| Output paths | `cargo xtask build-deps output-path <pkg> <wasm>`, never hardcoded |

Read those sections by heading (`grep -n '^#'` then `Read` with offset/limit), not whole files.

## Build loop

```bash
bash .claude/skills/porting-software-to-kandelo/scripts/build-package.sh <pkg> [wasm32|wasm64]
```

It prints one status line and, on failure, a summary; the full log stays in `.context/build-<pkg>-<arch>.log`. Builds can be long: run it from the main session with `run_in_background` and wait for the completion notification. Do not have a subagent poll it. On failure use the diagnosing-kandelo-build-failures skill.

## Platform facts that make ports go wrong

- **Autoconf link probes always pass.** The SDK links with `-Wl,--allow-undefined`, so `AC_CHECK_FUNCS` says yes to functions musl lacks and `AC_SEARCH_LIBS` says "none required". Seed `ac_cv_func_*` from `wasm32posix-nm sysroot/lib/libc.a | grep ' T <name>'` (rule in `sdk/config.site`), and put required libraries on `LIBS` explicitly.
- **Never define `__linux__`** SDK-wide, and not per package without the maintainer's agreement. Kandelo is not a Linux target (`sdk/config.site` header). Look for a feature macro or cache variable the upstream already checks.
- **Main-thread stack is 8 MiB; pthreads get 128 KiB.** Deep recursion in a thread overflows silently; see `docs/sdk-guide.md`.
- **Wasm traces without names** mean `wasm-opt` stripped the name section; keep it for debugging rather than guessing from `wasm-function[N]`.
- **A missing POSIX API is a platform gap**, not a package patch. Stub honestly or implement it in the kernel/libc.
