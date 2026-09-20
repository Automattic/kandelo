#!/usr/bin/env bash
# Build the in-tree lsof.c (a small /proc reader) for wasm32-posix-kernel.
# Source: examples/lsof.c.  Not the upstream lsof — this is a minimal
# implementation tailored to this kernel's procfs.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_prepare_build_roots "$SCRIPT_DIR" wasm32
kandelo_package_select_source_root "$REPO_ROOT"
SOURCE_ROOT="$KANDELO_PACKAGE_SOURCE_ROOT"
SRC="$SOURCE_ROOT/examples/lsof.c"
WORK_DIR="$KANDELO_PACKAGE_WORK_DIR"
OUT_BIN="$WORK_DIR/lsof.wasm"

# A resolver/Formula caller owns the declared work and output roots. Keep the
# reviewed checkout read-only and suppress the developer-only local mirror.
if [ -n "${WASM_POSIX_DEP_WORK_DIR:-}" ] && [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
    export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto
fi

if [ ! -f "$SRC" ] || [ -L "$SRC" ]; then
    echo "ERROR: lsof source must be a regular file: $SRC" >&2
    exit 1
fi

# In sync with scripts/build-programs.sh, because both drive the SDK. The SDK
# owns the compile/link contract (sdk/src/lib/flags.ts): the target, the
# sysroot, the syscall glue, crt1/libc ordering, the pinned wasm-ld and the
# process memory layout. This file used to carry its own copy of all of that,
# and the copy had drifted -- lsof.wasm was linked WITHOUT
# --export=__heap_base, so the artifact was not binary-compatible with the
# rest of the release. At the time, a program with no __heap_base export was
# silently given a fixed 16 MiB brk base (FALLBACK_BRK_BASE,
# crates/shared/src/lib.rs:2208, surfaced to TypeScript as
# PROCESS_MEMORY_FALLBACK_BRK_BASE in host/src/generated/abi.ts:961) out of a
# process window that can be as small as 24 MiB. That fallback is GONE:
# commit 359cb468f made computeProcessMemoryLayout REFUSE a named program
# whose __heap_base cannot be read, because guessing hid exactly this defect.
# So a mis-linked artifact now fails loudly rather than running on a guessed
# break. It also ran on wasm-ld's ~64 KiB default shadow stack instead of the
# SDK's 8 MiB.
#
# Do not add flags back by hand to "catch up" -- that is what produced the
# drift. A missing flag is an SDK change.
SYSROOT="$REPO_ROOT/sysroot"

find_llvm_bin() {
    if [ -n "${LLVM_BIN:-}" ] && [ -x "$LLVM_BIN/clang" ]; then
        echo "$LLVM_BIN"
        return
    fi
    if [ -n "${LLVM_PREFIX:-}" ] && [ -x "$LLVM_PREFIX/bin/clang" ]; then
        echo "$LLVM_PREFIX/bin"
        return
    fi
    if command -v clang >/dev/null 2>&1; then
        dirname "$(command -v clang)"
        return
    fi
    echo "Error: LLVM/clang not found. Run scripts/dev-shell.sh or set LLVM_BIN/LLVM_PREFIX." >&2
    exit 1
}

LLVM_BIN="$(find_llvm_bin)"

# Absolute path into THIS worktree's SDK, matching the `<repo>/sdk/bin` the
# local-build engine prepends to PATH for recipe scripts (build_deps.rs). A
# bare `wasm32posix-cc` would resolve through PATH and, outside a resolver-run
# build, could pick up a different worktree's SDK and its foreign sysroot.
#
# Deliberately NOT named CC. That name is already exported in the dev shell,
# and bash keeps the export attribute when you assign to an exported name, so
# the value would reach every child process this recipe starts.
WASM32_CC="$REPO_ROOT/sdk/bin/wasm32posix-cc"
WASM_OPT="$(command -v wasm-opt 2>/dev/null || true)"

if [ ! -f "$SYSROOT/lib/libc.a" ]; then
    echo "ERROR: sysroot not found at $SYSROOT. Run scripts/build-musl.sh first." >&2
    exit 1
fi

# -O2 is the only compile choice this recipe still makes for itself. In
# particular there is no thread-slot declaration, so the SDK INFERS one:
# inferThreadSlotDeclaration (sdk/src/lib/flags.ts) scans the source for
# pthread_create/thrd_create/clone(/dlopen and finds none in examples/lsof.c,
# so it emits -DWASM_POSIX_THREAD_SLOT_DECL=0.
#
# THAT CHANGES WHAT THE SHIPPED ARTIFACT DECLARES ABOUT ITSELF. The old
# hand-rolled recipe passed no declaration at all, so lsof.wasm exported
# `__wasm_posix_thread_slots() == -1`, the host default
# (WASM_POSIX_THREAD_SLOT_DECL_DEFAULT, libc/glue/abi_constants.h:19); it now
# exports 0. Verified by disassembling both: `i32.const 4294967295` before,
# `i32.const 0` after.
#
# That is correct rather than merely tolerable. lsof creates no threads, 0 is
# the truthful declaration for it, and it is already what
# scripts/build-programs.sh produces from this same examples/lsof.c. The
# recipe and the normal platform path now agree. Do NOT "restore" -1 by
# declaring --kandelo-thread-slots here: that would be reinstating a stale
# value, not preserving a requirement.
#
# Contrast crates/host-native/fixtures/build-fixtures.sh, which DOES declare
# -1. Its fixtures are one-line `#include`s of a shared source, and the
# inference is textual and does not follow #include, so it declared 0 for
# fixtures that genuinely do create threads. There is no such indirection
# here: examples/lsof.c is the whole translation unit.
#
# Run in a subshell pinned to $REPO_ROOT: the SDK resolves the sysroot and
# glue dir by walking up from process.cwd() (findSysroot/findGlueDir via
# projectRootOrSdk, sdk/src/lib/toolchain.ts), and this recipe inherits
# whatever cwd its caller had. A subshell, not a plain `cd`, so the
# caller-owned work/output roots this script was handed are unaffected.
echo "==> Building lsof.wasm from $SRC"
( cd "$REPO_ROOT" && "$WASM32_CC" -O2 "$SRC" -o "$OUT_BIN" )

if [ -n "$WASM_OPT" ]; then
    "$WASM_OPT" -O2 "$OUT_BIN" -o "$OUT_BIN"
fi

ls -lh "$OUT_BIN"
echo "==> lsof built successfully!"

source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary lsof "$OUT_BIN"
