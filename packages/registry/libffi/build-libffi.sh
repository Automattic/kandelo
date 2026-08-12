#!/usr/bin/env bash
#
# Build libffi (libffi.a) — the full libffi port for wasm32-posix-kernel
# (PR20): real type classification in ffi_call plus ffi_closure over a
# static trampoline pool. There is no source tarball to fetch: the port
# is `src/ffi_core.c` + `include/ffi.h` plus the two combinatorial TUs
# `gen-dispatch.sh` emits (the ffi_call signature switch and the closure
# trampoline pool). See include/ffi.h for the design and
# docs/plans/2026-07-14-build-hyprland-class-compositor-plan.md §4.
#
# The three objects stay separate in the archive on purpose: a consumer
# that never creates closures (libwayland) links ffi_core.o +
# ffi_dispatch.o and does not pay for the trampoline pool.
#
# `package.toml`'s sentinel `[source]` block exists to satisfy the
# resolver schema, not to be downloaded.
#
# Honors the dep-resolver build-script contract (see
# docs/package-management.md). When invoked via
# `cargo xtask build-deps resolve libffi`, env vars are set by the
# resolver and the build installs into the shared cache:
#
#     WASM_POSIX_DEP_OUT_DIR  # where to install lib/ + include/

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:-$SCRIPT_DIR/libffi-install}"

if ! command -v wasm32posix-cc &>/dev/null; then
    echo "ERROR: wasm32posix-cc not found. Run 'npm link' in sdk/ first." >&2
    exit 1
fi
if ! command -v wasm32posix-ar &>/dev/null; then
    echo "ERROR: wasm32posix-ar not found." >&2
    exit 1
fi

rm -rf "$INSTALL_DIR"
mkdir -p "$INSTALL_DIR/lib" "$INSTALL_DIR/include"

BUILD_DIR="$(mktemp -d)"
trap 'rm -rf "$BUILD_DIR"' EXIT

echo "==> Generating dispatch + closure pool..."
bash "$SCRIPT_DIR/gen-dispatch.sh" "$BUILD_DIR"

echo "==> Compiling libffi..."
for tu in ffi_core ffi_dispatch ffi_closure_pool; do
    src="$SCRIPT_DIR/src/$tu.c"
    [ -f "$src" ] || src="$BUILD_DIR/$tu.c"
    wasm32posix-cc -c -O2 -fPIC \
        -I"$SCRIPT_DIR/include" \
        -I"$SCRIPT_DIR/src" \
        "$src" -o "$BUILD_DIR/$tu.o"
done

echo "==> Archiving libffi.a..."
wasm32posix-ar rcs "$INSTALL_DIR/lib/libffi.a" \
    "$BUILD_DIR/ffi_core.o" \
    "$BUILD_DIR/ffi_dispatch.o" \
    "$BUILD_DIR/ffi_closure_pool.o"

cp "$SCRIPT_DIR/include/ffi.h" "$INSTALL_DIR/include/ffi.h"

echo "==> libffi installed at $INSTALL_DIR"
echo "    lib/libffi.a ($(wc -c < "$INSTALL_DIR/lib/libffi.a") bytes)"
