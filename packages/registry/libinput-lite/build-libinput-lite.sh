#!/usr/bin/env bash
#
# Build libinput-lite (libinput.a) — an in-tree no-op stub of the
# libinput API surface — for wasm32-posix-kernel.
#
# The bundled `src/libinput_stub.c` + `include/libinput.h` are the
# entire upstream substitute; there is no source tarball to fetch.
# `package.toml`'s sentinel `[source]` block exists to satisfy the
# resolver schema, not to be downloaded.
#
# Honors the dep-resolver build-script contract (see
# docs/package-management.md). When invoked via
# `cargo xtask build-deps resolve libinput-lite`, env vars are set
# by the resolver and the build installs into the shared cache:
#
#     WASM_POSIX_DEP_OUT_DIR  # where to install lib/ + include/

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC="$SCRIPT_DIR/src/libinput_stub.c"
HDR="$SCRIPT_DIR/include/libinput.h"
INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:-$SCRIPT_DIR/libinput-lite-install}"

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

OBJ="$(mktemp -d)/libinput_stub.o"
trap 'rm -rf "$(dirname "$OBJ")"' EXIT

echo "==> Compiling libinput-lite stub..."
wasm32posix-cc -c -O2 -fPIC \
    -I"$SCRIPT_DIR/include" \
    "$SRC" -o "$OBJ"

echo "==> Archiving libinput.a..."
wasm32posix-ar rcs "$INSTALL_DIR/lib/libinput.a" "$OBJ"

cp "$HDR" "$INSTALL_DIR/include/libinput.h"

echo "==> libinput-lite installed at $INSTALL_DIR"
echo "    lib/libinput.a ($(wc -c < "$INSTALL_DIR/lib/libinput.a") bytes)"
