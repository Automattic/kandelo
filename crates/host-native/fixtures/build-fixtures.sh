#!/bin/bash
# Rebuild the host-native guest fixtures (*.c -> *.wasm) through the SDK, using
# the same compile/link recipe scripts/build-programs.sh uses for the example
# programs. Run from inside scripts/dev-shell.sh (which sets $LLVM_BIN).
#
#   SYSROOT=<repo>/sysroot scripts/dev-shell.sh \
#     crates/host-native/fixtures/build-fixtures.sh
#
# SYSROOT must be a sysroot built for the CURRENT ABI (this branch's libc).
# The committed .wasm files must match the running kernel's ABI or the native
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
SYSROOT="${SYSROOT:-$REPO_ROOT/sysroot}"
SYSROOT64="${SYSROOT64:-$REPO_ROOT/sysroot64}"
GLUE="$REPO_ROOT/libc/glue"

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

: "${LLVM_BIN:?run inside scripts/dev-shell.sh so LLVM_BIN is set}"
if [ ! -f "$SYSROOT/lib/libc.a" ]; then
    echo "error: no sysroot at $SYSROOT (set SYSROOT=<repo>/sysroot)" >&2
    exit 1
fi

# One compile/link recipe, parameterised only by target triple and sysroot, so
# the two arms cannot drift apart in flags.
build_fixture() {
    local target="$1" sysroot="$2" src="$3" out="$4"
    "$LLVM_BIN/clang" \
        --target="$target" --sysroot="$sysroot" -nostdlib -O2 \
        -matomics -mbulk-memory -fno-trapping-math \
        -mllvm -wasm-enable-sjlj -mllvm -wasm-use-legacy-eh=false \
        "$src" \
        "$GLUE/channel_syscall.c" "$GLUE/compiler_rt.c" "$sysroot/lib/crt1.o" \
        "$sysroot/lib/libc.a" \
        -Wl,--no-entry -Wl,--export=_start -Wl,--import-memory -Wl,--shared-memory \
        -Wl,--max-memory=1073741824 -Wl,--allow-undefined -Wl,--table-base=3 \
        -Wl,--export-table -Wl,--growable-table \
        -Wl,--export=__wasm_init_tls -Wl,--export=__tls_base -Wl,--export=__tls_size \
        -Wl,--export=__tls_align -Wl,--export=__stack_pointer \
        -Wl,--export=__wasm_thread_init -Wl,--export=__abi_version \
        -o "$out"
}

for src in "$FIXTURES_DIR"/*.c; do
    name="$(basename "$src" .c)"
    echo "building $name.wasm"
    build_fixture wasm32-unknown-unknown "$SYSROOT" "$src" "$FIXTURES_DIR/$name.wasm"
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
    build_fixture wasm64-unknown-unknown "$SYSROOT64" "$src" \
        "$FIXTURES_DIR/$name.wasm64.wasm"
done
echo "done"
