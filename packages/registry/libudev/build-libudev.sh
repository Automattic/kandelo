#!/usr/bin/env bash
#
# Build libudev (libudev.a) — a libinput-scoped SHIM of the libudev API,
# NOT a full libudev port — for wasm32-posix-kernel.
#
# The bundled `src/libudev_shim.c` + `include/libudev.h` are the entire
# substitute; there is no source tarball to fetch. libinput's PATH
# backend threads devices through `struct udev_device` and gates
# configuration on the ID_INPUT_* property tags; the shim's load-bearing
# job is to synthesize those tags from the device's evdev capability bits
# (the udev `input_id` classification), reproduced in the source. Every
# other udev call is a thin no-op / NULL. See
# docs/plans/2026-07-08-dri-wayland-compositor-plan.md §5 and
# include/libudev.h for the full rationale.
#
# `package.toml`'s sentinel `[source]` block exists to satisfy the
# resolver schema, not to be downloaded.
#
# Honors the dep-resolver build-script contract (see
# docs/package-management.md). When invoked via
# `cargo xtask build-deps resolve libudev`, env vars are set by the
# resolver and the build installs into the shared cache:
#
#     WASM_POSIX_DEP_OUT_DIR  # where to install lib/ + include/

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC="$SCRIPT_DIR/src/libudev_shim.c"
HDR="$SCRIPT_DIR/include/libudev.h"
INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:-$SCRIPT_DIR/libudev-install}"

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

OBJ="$(mktemp -d)/libudev_shim.o"
trap 'rm -rf "$(dirname "$OBJ")"' EXIT

echo "==> Compiling libudev libinput-scoped shim..."
wasm32posix-cc -c -O2 -fPIC \
    -I"$SCRIPT_DIR/include" \
    "$SRC" -o "$OBJ"

echo "==> Archiving libudev.a..."
wasm32posix-ar rcs "$INSTALL_DIR/lib/libudev.a" "$OBJ"

cp "$HDR" "$INSTALL_DIR/include/libudev.h"

echo "==> libudev (libinput-scoped shim) installed at $INSTALL_DIR"
echo "    lib/libudev.a ($(wc -c < "$INSTALL_DIR/lib/libudev.a") bytes)"
