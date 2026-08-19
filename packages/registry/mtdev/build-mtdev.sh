#!/usr/bin/env bash
#
# Build mtdev (libmtdev.a) — a libinput-scoped STUB of the mtdev API,
# NOT a full mtdev port — for wasm32-posix-kernel.
#
# The bundled `src/mtdev_stub.c` + `include/mtdev.h` +
# `include/mtdev-plumbing.h` are the entire substitute; there is no
# source tarball to fetch. libinput's evdev backend unconditionally
# includes <mtdev-plumbing.h> and links the mtdev symbols, but only
# calls them for legacy multitouch protocol-A devices
# (`evdev_need_mtdev()`), which the kernel's slot-less virtual devices
# never are. The stub exists to satisfy the link; each entry point
# aborts if actually reached. See
# docs/plans/2026-07-08-dri-wayland-compositor-plan.md §5 and
# include/mtdev-plumbing.h for the full rationale.
#
# `package.toml`'s sentinel `[source]` block exists to satisfy the
# resolver schema, not to be downloaded.
#
# Honors the dep-resolver build-script contract (see
# docs/package-management.md). When invoked via
# `cargo xtask build-deps resolve mtdev`, env vars are set by the
# resolver and the build installs into the shared cache:
#
#     WASM_POSIX_DEP_OUT_DIR  # where to install lib/ + include/

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC="$SCRIPT_DIR/src/mtdev_stub.c"
INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:-$SCRIPT_DIR/mtdev-install}"

if ! command -v wasm32posix-cc &>/dev/null; then
    echo "ERROR: wasm32posix-cc not found. Enter scripts/dev-shell.sh first." >&2
    exit 1
fi
if ! command -v wasm32posix-ar &>/dev/null; then
    echo "ERROR: wasm32posix-ar not found." >&2
    exit 1
fi

rm -rf "$INSTALL_DIR"
mkdir -p "$INSTALL_DIR/lib" "$INSTALL_DIR/include"

OBJ="$(mktemp -d)/mtdev_stub.o"
trap 'rm -rf "$(dirname "$OBJ")"' EXIT

echo "==> Compiling mtdev libinput-scoped stub..."
wasm32posix-cc -c -O2 -fPIC \
    -I"$SCRIPT_DIR/include" \
    "$SRC" -o "$OBJ"

echo "==> Archiving libmtdev.a..."
wasm32posix-ar rcs "$INSTALL_DIR/lib/libmtdev.a" "$OBJ"

cp "$SCRIPT_DIR/include/mtdev.h"           "$INSTALL_DIR/include/mtdev.h"
cp "$SCRIPT_DIR/include/mtdev-plumbing.h"  "$INSTALL_DIR/include/mtdev-plumbing.h"

echo "==> mtdev (libinput-scoped stub) installed at $INSTALL_DIR"
echo "    lib/libmtdev.a ($(wc -c < "$INSTALL_DIR/lib/libmtdev.a") bytes)"
