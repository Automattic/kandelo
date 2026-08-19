#!/usr/bin/env bash
#
# Build libevdev.a for wasm32-posix-kernel, pinned to libevdev 1.13.3.
#
# We bypass upstream's meson build: it runs host-side feature probes that
# misreport against the wasm sysroot. Instead we mirror libxkbcommon /
# libwayland — compile the core TUs directly with a hand-curated config.h
# (src/config.h) and a python-generated event-name table. See
# docs/plans/2026-07-08-dri-wayland-compositor-plan.md §5 (PR5).
#
# Honors the dep-resolver build-script contract (docs/package-management.md):
# when invoked via `cargo xtask build-deps resolve libevdev` the resolver
# sets WASM_POSIX_DEP_OUT_DIR / _VERSION / _SOURCE_URL / _SOURCE_SHA256.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_DIR="$SCRIPT_DIR/libevdev-src"

LIBEVDEV_VERSION="${WASM_POSIX_DEP_VERSION:-1.13.3}"
INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:-$SCRIPT_DIR/libevdev-install}"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://www.freedesktop.org/software/libevdev/libevdev-${LIBEVDEV_VERSION}.tar.xz}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-}"

# --- Toolchain ----------------------------------------------------------
for tool in wasm32posix-cc wasm32posix-ar python3; do
    if ! command -v "$tool" &>/dev/null; then
        echo "ERROR: $tool not found. Enter scripts/dev-shell.sh (provides the" >&2
        echo "       wasm toolchain + python3 from flake.nix)." >&2
        exit 1
    fi
done

# --- Fetch + verify source ---------------------------------------------
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Downloading libevdev $LIBEVDEV_VERSION..."
    TARBALL="/tmp/libevdev-${LIBEVDEV_VERSION}.tar.xz"
    curl --retry 10 --retry-delay 5 --retry-max-time 300 --retry-all-errors \
        -fsSL "$SOURCE_URL" -o "$TARBALL"
    if [ -n "$SOURCE_SHA256" ]; then
        echo "==> Verifying source sha256..."
        echo "$SOURCE_SHA256  $TARBALL" | shasum -a 256 -c -
    else
        echo "==> (no SOURCE_SHA256 declared; skipping verification)"
    fi
    mkdir -p "$SRC_DIR"
    tar xJf "$TARBALL" -C "$SRC_DIR" --strip-components=1
    rm "$TARBALL"
fi

# Fresh build + install each run — stale objects would shadow config
# changes and the cache key varies per build.
BUILD_DIR="$SCRIPT_DIR/libevdev-build"
rm -rf "$BUILD_DIR" "$INSTALL_DIR"
mkdir -p "$BUILD_DIR" "$INSTALL_DIR/lib" "$INSTALL_DIR/include/libevdev"

LE="$SRC_DIR/libevdev"

# --- config.h + generated event-name table ----------------------------
# Sources #include "config.h"; place it at the source root so -I"$SRC_DIR"
# resolves it for every TU.
cp "$SCRIPT_DIR/src/config.h" "$SRC_DIR/config.h"

# The bundled <linux/input.h> opens with `#include <linux/types.h>`, which
# the musl wasm sysroot does not ship. Drop a minimal shim into the bundled
# include tree so the full header set is self-consistent (see src/linux-types.h).
cp "$SCRIPT_DIR/src/linux-types.h" "$SRC_DIR/include/linux/linux/types.h"

# make-event-names.py emits event-names.h next to the sources so their
# quoted #include "event-names.h" finds it. We generate it from libevdev's
# *bundled* full linux UAPI headers (include/linux/linux/*), NOT the
# sysroot's curated <linux/input-event-codes.h>: the sysroot header is a
# deliberately minimal, ABI-locked subset (no EV_MAX / KEY_MAX sentinels,
# no SW_/LED_/FF_/INPUT_PROP_ ranges), against which libevdev's *_MAX-sized
# tables cannot compile. The bundled headers are the complete set upstream
# ships precisely so the library does not depend on the build host's kernel
# headers; the wire `struct input_event` layout (24 bytes) is identical.
echo "==> Generating event-names.h with $(python3 --version)..."
python3 "$LE/make-event-names.py" \
    "$SRC_DIR/include/linux/linux/input.h" \
    "$SRC_DIR/include/linux/linux/input-event-codes.h" \
    > "$LE/event-names.h"

# --- Compile ------------------------------------------------------------
CFLAGS=(
    -O2 -fPIC -fvisibility=hidden -std=gnu11
    # (config.h #defines _GNU_SOURCE; sources include it first)
    "-I$SRC_DIR"                    # config.h at source root
    "-I$LE"                         # libevdev.h, libevdev-int.h, event-names.h
    "-I$SRC_DIR/include/linux"      # bundled full <linux/input.h> wins over sysroot
    -Wno-unused-parameter
)

# uinput (device *creation*) is not part of the read/parse surface libinput
# uses; skip libevdev-uinput.c so the archive carries no uinput dependency.
TUS=(libevdev.c libevdev-names.c)

echo "==> Compiling ${#TUS[@]} TUs for wasm32..."
OBJS=()
for tu in "${TUS[@]}"; do
    obj="$BUILD_DIR/${tu%.c}.o"
    echo "    $tu" >&2
    wasm32posix-cc -c "${CFLAGS[@]}" "$LE/$tu" -o "$obj"
    OBJS+=("$obj")
done

echo "==> Archiving libevdev.a..."
wasm32posix-ar rcs "$INSTALL_DIR/lib/libevdev.a" "${OBJS[@]}"

# --- Install public header ---------------------------------------------
# libinput and consumers include only <libevdev/libevdev.h> (which pulls
# <linux/input.h> + <stdarg.h>); libevdev-uinput.h is not installed.
echo "==> Installing header..."
cp "$LE/libevdev.h" "$INSTALL_DIR/include/libevdev/libevdev.h"

echo "==> libevdev $LIBEVDEV_VERSION installed at $INSTALL_DIR"
echo "    lib/libevdev.a ($(wc -c < "$INSTALL_DIR/lib/libevdev.a") bytes)"
