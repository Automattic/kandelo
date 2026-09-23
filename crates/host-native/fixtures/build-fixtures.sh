#!/bin/bash
# Rebuild the host-native guest fixtures (*.c -> *.wasm).
#
# The C arm goes through the SDK wrappers (sdk/bin/wasm32posix-cc and
# sdk/bin/wasm64posix-cc), so these fixtures carry exactly the compile/link
# contract sdk/src/lib/flags.ts owns -- the same one scripts/build-programs.sh
# gives user programs, including --export=__heap_base and the 8 MiB
# main-thread shadow stack.
#
# It used to invoke "$LLVM_BIN/clang" with its own copy of those flags, and
# the copy had drifted: the fixtures were linked WITHOUT --export=__heap_base
# (so they ran on the 16 MiB brk fallback) and on wasm-ld's ~64 KiB default
# shadow stack rather than the SDK's 8 MiB. Do not hand-copy flags back in.
# Only the arch, the optimization level and the inputs belong here; every
# other compile/link choice belongs to the SDK.
#
# Run from inside scripts/dev-shell.sh:
#
#   scripts/dev-shell.sh crates/host-native/fixtures/build-fixtures.sh
#
# The sysroots must be built for the CURRENT ABI (this branch's libc). The
# committed .wasm files must match the running kernel's ABI or the native
# host rejects them at load — see fixtures/README.md.
#
# B27b — the wasm64 arm. A handful of fixtures are additionally built for
# wasm64 (LP64) as `<name>.wasm64.wasm`, from the SAME C source and the same
# recipe with only the target and sysroot changed. That arm needs
# `$REPO_ROOT/sysroot64`, which `scripts/build-musl.sh --arch wasm64posix`
# produces; without it those fixtures are SKIPPED LOUDLY rather than quietly
# left stale, because a stale wasm64 artifact against a current kernel is the
# failure this whole fixture family exists to catch.
set -euo pipefail

FIXTURES_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$FIXTURES_DIR/../../.." && pwd)"
# WHY: the SDK resolves each arch's sysroot and the glue dir by walking up
# from process.cwd() looking for libc/glue/abi_constants.h (findSysroot /
# findGlueDir via projectRootOrSdk, sdk/src/lib/toolchain.ts:13-31,112-131),
# not from this script's location. Invoked with a cwd inside a different
# kandelo worktree it would link against THAT worktree's sysroot while the
# checks below validated this one. Pin the cwd so both agree.
cd "$REPO_ROOT"

# The SDK picks each arch's sysroot BY ARCH: wasm32posix-cc takes
# <repo>/sysroot, wasm64posix-cc takes <repo>/sysroot64. The only env override
# that redirects it, WASM_POSIX_SYSROOT, is returned for every arch alike
# (toolchain.ts:112-114), so routing a caller-supplied SYSROOT through it
# would hand the wasm64 arm the wasm32 sysroot and produce a fixture with the
# wrong data model — precisely the failure that arm exists to catch.
#
# So these are no longer overridable. They name what the SDK will use, for the
# existence checks below, and a caller asking for anything else is refused
# rather than silently ignored. crates/host-native/src/fixtures.rs passes
# these two exact values.
for _sysroot_var in SYSROOT SYSROOT64; do
    _requested="${!_sysroot_var-}"
    case "$_sysroot_var" in
        SYSROOT)   _expected="$REPO_ROOT/sysroot" ;;
        SYSROOT64) _expected="$REPO_ROOT/sysroot64" ;;
    esac
    if [ -n "$_requested" ] && [ "$_requested" != "$_expected" ]; then
        echo "error: $_sysroot_var=$_requested cannot be honoured." >&2
        echo "       The SDK resolves the sysroot per arch from the repo" >&2
        echo "       root; this script builds both arches, so it cannot" >&2
        echo "       redirect one without redirecting the other." >&2
        echo "       Expected $_expected (or unset)." >&2
        exit 1
    fi
done
unset _sysroot_var _requested _expected
SYSROOT="$REPO_ROOT/sysroot"
SYSROOT64="$REPO_ROOT/sysroot64"

# Fixtures that are ALSO built at wasm64. Deliberately a short, explicit list
# rather than every `*.c`: a second artifact per fixture is a committed binary
# with an ABI lifetime, and only the fixtures whose subject is the caller's own
# DATA MODEL gain anything from a second data model. `native_process_layout` is
# exactly that fixture — its whole subject is records whose size is a property
# of the caller's pointer width, and `crates/host-native/src/lib.rs` asserts
# that each name below runs and covers the derived descriptor set at BOTH
# widths, so removing a name from this list fails that test rather than
# silently dropping coverage.
WASM64_FIXTURES=(native_process_layout)

# The SDK's findLlvmDir() reads LLVM_BIN (sdk/src/lib/toolchain.ts) before it
# falls back to PATH, so requiring it here is the same prerequisite, checked
# once with a message that names the fix.
: "${LLVM_BIN:?run inside scripts/dev-shell.sh so LLVM_BIN is set}"
if [ ! -f "$SYSROOT/lib/libc.a" ]; then
    echo "error: no sysroot at $SYSROOT — run scripts/build-musl.sh" >&2
    exit 1
fi

# Absolute paths to this worktree's SDK, never bare `wasm32posix-cc`: a bare
# name resolves through PATH and can pick up a different worktree's SDK, whose
# sysroot and glue would then disagree with the checks above.
#
# Deliberately NOT named CC/CXX. Those names are already exported in the dev
# shell, and bash keeps the export attribute when you assign to an exported
# name, so the value would reach every child process — including `wasm-tools`
# and the fork instrumenter below, and any cargo a caller wraps this script in.
WASM32_CC="$REPO_ROOT/sdk/bin/wasm32posix-cc"
WASM64_CC="$REPO_ROOT/sdk/bin/wasm64posix-cc"

# One compile/link recipe, parameterised only by the SDK driver (which fixes
# the arch, and with it the sysroot), so the two arms cannot drift apart in
# flags. Everything the SDK supplies is deliberately absent: compileFlags()
# owns --target, -matomics, -mbulk-memory, -mexception-handling,
# -fno-trapping-math and the -mllvm SjLj / modern-EH pair; cc.ts adds
# --sysroot from the resolved toolchain and injects -nostdlib, the syscall
# glue (channel_syscall.c, compiler_rt.c, cxxrt.c), crt1.o, the sysroot
# libc.a and linkFlags(). The optimization level is the only compile choice
# this script still makes for itself.
#
# `--kandelo-thread-slots -1` is THREAD_SLOT_USE_HOST_DEFAULT, and it is
# declared rather than inferred for a measured reason. Left to infer, the SDK
# reads the named source file and looks for `pthread_create`, `thrd_create`,
# `clone(`, `dlopen` and friends (inferThreadSlotDeclaration,
# sdk/src/lib/flags.ts); finding none it declares ZERO slots. That inference
# is textual and does not follow #include, and several fixtures here are a
# single `#include` of a shared source under examples/ -- deliberately, so the
# native host and the Node/browser host run byte-identical fixture code. Their
# text therefore mentions no thread API at all. Built on the inference,
# native_thread_churn and native_thread_concurrency linked with zero slots and
# their first pthread_create returned EAGAIN, failing smoke_pthread_* in
# crates/host-native/src/lib.rs.
#
# The pre-SDK recipe passed no thread-slot define at all, so every fixture got
# the host default. Declaring -1 keeps exactly that, uniformly, and states it
# as a choice instead of relying on a guess about source text.
build_fixture() {
    local cc="$1" src="$2" out="$3"
    "$cc" -O2 --kandelo-thread-slots -1 "$src" -o "$out"
}

for src in "$FIXTURES_DIR"/*.c; do
    name="$(basename "$src" .c)"
    echo "building $name.wasm"
    build_fixture "$WASM32_CC" "$src" "$FIXTURES_DIR/$name.wasm"
done

if [ ! -f "$SYSROOT64/lib/libc.a" ]; then
    echo "error: no wasm64 sysroot at $SYSROOT64, so the wasm64 fixture arm" >&2
    echo "       (${WASM64_FIXTURES[*]}) was NOT rebuilt and is now stale." >&2
    echo "       Build it with: scripts/build-musl.sh --arch wasm64posix" >&2
    exit 1
fi
for name in "${WASM64_FIXTURES[@]}"; do
    src="$FIXTURES_DIR/$name.c"
    if [ ! -f "$src" ]; then
        echo "error: WASM64_FIXTURES names $name, but $src does not exist" >&2
        exit 1
    fi
    echo "building $name.wasm64.wasm"
    build_fixture "$WASM64_CC" "$src" "$FIXTURES_DIR/$name.wasm64.wasm"
done

# The hand-written WAT arm. These exist because a live funcref/externref value
# held across fork() is not reachable from portable C on this SDK's toolchain
# -- see native_fork_refs.wat's own doc comment -- so they are assembled by
# WABT rather than compiled by clang.
#
# Listing only what a test loads keeps this file from producing binaries
# nobody reads.
WAT_FIXTURES=(
    native_fork_gc_array_cycle
    native_fork_gc_static_root
    native_fork_gc_struct_cycle
    native_fork_externref_table
    native_fork_gc_two_object_cycle
    native_fork_host_externref_field_refused
    native_fork_host_externref_refused
    native_fork_refs
)
for name in "${WAT_FIXTURES[@]}"; do
    src="$FIXTURES_DIR/$name.wat"
    if [ ! -f "$src" ]; then
        echo "error: WAT_FIXTURES names $name, but $src does not exist" >&2
        exit 1
    fi
    echo "assembling $name.wasm"
    # `wasm-tools parse`, not WABT's `wat2wasm`: the four GC fixtures use
    # types WABT 1.0.37 cannot assemble even with --enable-all, and
    # `wasm-tools` is what the commit that introduced them actually used
    # (the same `wat` crate the #[ignore]d regenerators reach for).
    wasm-tools parse "$src" -o "$FIXTURES_DIR/$name.wasm"
done

# The fork-instrumented arm. Every one of these goes through the REAL
# production instrumenter, the same script scripts/build-programs.sh uses, so
# a fixture cannot be instrumented by a private code path that drifts from
# what user programs get. The entry is uniform across all of them.
INSTRUMENTED_FIXTURES=(
    native_fork
    native_fork_externref_table
    native_fork_from_thread
    native_fork_gc_array_cycle
    native_fork_gc_static_root
    native_fork_gc_struct_cycle
    native_fork_gc_two_object_cycle
    native_fork_host_externref_field_refused
    native_fork_host_externref_refused
    native_fork_refs
    native_vfork
    native_vfork_exec
)
for name in "${INSTRUMENTED_FIXTURES[@]}"; do
    raw="$FIXTURES_DIR/$name.wasm"
    if [ ! -f "$raw" ]; then
        echo "error: INSTRUMENTED_FIXTURES names $name, but $raw was not built" >&2
        exit 1
    fi
    echo "instrumenting $name.instrumented.wasm"
    "$REPO_ROOT/scripts/run-wasm-fork-instrument.sh" \
        "$raw" -o "$FIXTURES_DIR/$name.instrumented.wasm" \
        --entry kernel.kernel_fork
done
echo "done"
