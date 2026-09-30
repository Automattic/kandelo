#!/usr/bin/env bash
#
# Build libinput.a for wasm32-posix-kernel, pinned to libinput 1.25.0.
#
# This is the REAL libinput core (path backend), replacing the historical
# libinput-lite no-op stub for the compositor path. SDL2 keeps depending on
# libinput-lite — it references zero libinput symbols and uses libinput only
# as an optional-detection stub — so this port is scoped to the Wayland
# compositor consumer (PR6/PR7) and its smoke test. See
# docs/plans/2026-07-08-dri-wayland-compositor-plan.md §5 (PR5c).
#
# We bypass upstream's meson build: its feature probes misreport against the
# wasm sysroot. Instead we mirror libxkbcommon / libevdev — compile the core
# TUs directly with a hand-curated config.h (src/config.h) and sed-substituted
# version headers. We DROP src/udev-seat.c (the udev enumerate+monitor
# backend); only the path backend (path-seat.c) is built, which is all the
# compositor needs to open explicit /dev/input/event* nodes.
#
# Link-time deps (resolved + passed by `cargo xtask build-deps resolve
# libinput`): libevdev (PR5a), libudev shim (PR5b), mtdev stub (PR5b).
#
# Honors the dep-resolver build-script contract (docs/package-management.md):
# the resolver sets WASM_POSIX_DEP_OUT_DIR / _VERSION / _SOURCE_URL /
# _SOURCE_SHA256 and WASM_POSIX_DEP_<DEP>_DIR for each depends_on entry.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
# Source, build scratch and patched copies live in the resolver-owned work
# root (or a direct run's private one), never under the reviewed checkout.
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_prepare_build_roots "$SCRIPT_DIR" wasm32
WORK_DIR="$KANDELO_PACKAGE_WORK_DIR"
SRC_DIR="$WORK_DIR/libinput-src"
VERIFIED_SOURCE_DIR="${WASM_POSIX_DEP_SOURCE_DIR:-}"
SOURCE_MARKER="$WORK_DIR/.kandelo-libinput-source"

LIBINPUT_VERSION="${WASM_POSIX_DEP_VERSION:-1.25.0}"
INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:-$SCRIPT_DIR/libinput-install}"
# The gitlab auto-archive sits behind an Anubis JS-PoW wall that curl cannot
# clear; the Ubuntu `orig` tarball is the byte-identical 1.25.0 tree (sha256
# below matches the gitlab archive) and its pool mirror is durable.
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-http://archive.ubuntu.com/ubuntu/pool/main/libi/libinput/libinput_${LIBINPUT_VERSION}.orig.tar.gz}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-f7e8425f185cadba5761d0a1dae6be041750d351163ffa04adc5b9a79a13c0ec}"

# --- Toolchain ----------------------------------------------------------
for tool in wasm32posix-cc wasm32posix-ar; do
    if ! command -v "$tool" &>/dev/null; then
        echo "ERROR: $tool not found. Enter scripts/dev-shell.sh (provides the" >&2
        echo "       wasm toolchain from flake.nix)." >&2
        exit 1
    fi
done

# --- Link-time deps from the resolver ----------------------------------
# Headers live under <prefix>/include, archives under <prefix>/lib.
LIBEVDEV_PREFIX="${WASM_POSIX_DEP_LIBEVDEV_DIR:?WASM_POSIX_DEP_LIBEVDEV_DIR not set (must be invoked via cargo xtask build-deps resolve libinput)}"
LIBUDEV_PREFIX="${WASM_POSIX_DEP_LIBUDEV_DIR:?WASM_POSIX_DEP_LIBUDEV_DIR not set (must be invoked via cargo xtask build-deps resolve libinput)}"
MTDEV_PREFIX="${WASM_POSIX_DEP_MTDEV_DIR:?WASM_POSIX_DEP_MTDEV_DIR not set (must be invoked via cargo xtask build-deps resolve libinput)}"

# --- Stage verified source ---------------------------------------------
# The resolver hands over an already-verified archive (source-only policy);
# a direct run downloads and checks the pinned sha256. A source tree staged
# for a different version, URL or hash is discarded rather than reused, so
# a version bump can never build from the previous release's tree.
expected_source_marker="$(printf '%s\n%s\n%s' "$LIBINPUT_VERSION" "$SOURCE_URL" "$SOURCE_SHA256")"
if [ -d "$SRC_DIR" ] && [ "$(cat "$SOURCE_MARKER" 2>/dev/null || true)" != "$expected_source_marker" ]; then
    rm -rf "$SRC_DIR"
fi
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Staging verified libinput $LIBINPUT_VERSION source..."
    kandelo_package_stage_verified_source libinput "$SRC_DIR" "$VERIFIED_SOURCE_DIR" \
        "$SOURCE_URL" "$SOURCE_SHA256" "$WORK_DIR"
    printf '%s\n' "$expected_source_marker" > "$SOURCE_MARKER"
fi

# Fresh build + install each run — stale objects would shadow config
# changes and the cache key varies per build.
BUILD_DIR="$WORK_DIR/libinput-build"
GEN_DIR="$BUILD_DIR/gen"
rm -rf "$BUILD_DIR"
# Empty the output prefix rather than replacing it: the resolver owns
# WASM_POSIX_DEP_OUT_DIR and records its inode identity, so an rm -rf +
# mkdir of the directory ITSELF makes the publish step reject the build
# ("build stage changed identity and was preserved").
mkdir -p "$INSTALL_DIR"
find "$INSTALL_DIR" -mindepth 1 -delete
mkdir -p "$GEN_DIR" "$INSTALL_DIR/lib" "$INSTALL_DIR/include"

SRC="$SRC_DIR/src"

# --- config.h + generated version headers ------------------------------
# Sources #include "config.h" / <config.h>; place all three generated
# headers in GEN_DIR and add it first on the include path.
cp "$SCRIPT_DIR/src/config.h" "$GEN_DIR/config.h"

# meson's configure_file for libinput-version.h / libinput-git-version.h,
# reproduced with sed (no git in the build sandbox → pin the git string).
sed -e 's/@LIBINPUT_VERSION_MAJOR@/1/' \
    -e 's/@LIBINPUT_VERSION_MINOR@/25/' \
    -e 's/@LIBINPUT_VERSION_MICRO@/0/' \
    -e "s/@LIBINPUT_VERSION@/${LIBINPUT_VERSION}/" \
    "$SRC/libinput-version.h.in" > "$GEN_DIR/libinput-version.h"
sed -e "s/@VCS_TAG@/${LIBINPUT_VERSION}/" \
    "$SRC/libinput-git-version.h.in" > "$GEN_DIR/libinput-git-version.h"

# The bundled <linux/input.h> opens with `#include <linux/types.h>`, which
# the musl wasm sysroot does not ship. Drop the shim into the bundled include
# tree so the full UAPI header set is self-consistent (see src/linux-types.h).
# We compile against libinput's *bundled* full linux headers
# (include/linux/linux/*) rather than the sysroot's minimal, ABI-locked
# <linux/input.h> subset, which lacks the *_MAX / *_CNT sentinels libinput's
# fixed-size capability arrays need — identical rationale to the libevdev port.
cp "$SCRIPT_DIR/src/linux-types.h" "$SRC_DIR/include/linux/linux/types.h"

# quirks.c with patches/0001: report an empty DMI identity where the
# platform has no DMI source (Kandelo exposes no SMBIOS/DMI or devicetree),
# so the quirks database loads instead of failing whole. Patched as a copy
# in GEN_DIR so the fetched source tree stays pristine across rebuilds;
# its quoted includes still resolve through -I$SRC.
cp "$SRC/quirks.c" "$GEN_DIR/quirks.c"
patch --no-backup-if-mismatch -s "$GEN_DIR/quirks.c" \
    < "$SCRIPT_DIR/patches/0001-quirks-empty-dmi-identity-without-dmi.patch"

# --- Compile ------------------------------------------------------------
CFLAGS=(
    -O2 -fPIC -fvisibility=hidden -std=gnu11
    # (config.h #defines _GNU_SOURCE; sources include it first)
    "-I$GEN_DIR"                    # config.h + version headers
    "-I$SRC"                        # internal headers (evdev.h, util-*.h, ...)
    "-I$SRC_DIR/include/linux"      # bundled full <linux/input.h> wins over sysroot
    "-I$LIBEVDEV_PREFIX/include"    # <libevdev/libevdev.h>
    "-I$LIBUDEV_PREFIX/include"     # <libudev.h>
    "-I$MTDEV_PREFIX/include"       # <mtdev.h>, <mtdev-plumbing.h>
    -Wno-unused-parameter
    -Wno-unused-function
    -Wno-unused-variable
)

# The path-backend TU set, mirroring upstream meson's src_libinput (=
# src_libfilter + core) plus the util + quirks static libs that link into
# libinput.so. udev-seat.c is intentionally omitted (udev enumerate/monitor
# backend; the compositor uses the path backend). Verified against
# libinput 1.25.0 meson.build.
TUS=(
    # filter (src_libfilter)
    filter.c filter-custom.c filter-flat.c filter-low-dpi.c filter-mouse.c
    filter-touchpad.c filter-touchpad-flat.c filter-touchpad-x230.c
    filter-tablet.c filter-trackpoint.c filter-trackpoint-flat.c
    # core libinput (src_libinput, minus udev-seat.c)
    libinput.c libinput-private-config.c
    evdev.c evdev-debounce.c evdev-fallback.c evdev-totem.c
    evdev-middle-button.c
    evdev-mt-touchpad.c evdev-mt-touchpad-tap.c evdev-mt-touchpad-thumb.c
    evdev-mt-touchpad-buttons.c evdev-mt-touchpad-edge-scroll.c
    evdev-mt-touchpad-gestures.c
    evdev-tablet.c evdev-tablet-pad.c evdev-tablet-pad-leds.c
    evdev-wheel.c
    path-seat.c timer.c
    # util (src_libinput_util) + quirks
    util-list.c util-ratelimit.c util-strings.c util-prop-parsers.c
    quirks.c
)

echo "==> Compiling ${#TUS[@]} TUs for wasm32..."
OBJS=()
for tu in "${TUS[@]}"; do
    obj="$BUILD_DIR/${tu%.c}.o"
    echo "    $tu" >&2
    src="$SRC/$tu"
    [ "$tu" = quirks.c ] && src="$GEN_DIR/quirks.c"
    wasm32posix-cc -c "${CFLAGS[@]}" "$src" -o "$obj"
    OBJS+=("$obj")
done

echo "==> Archiving libinput.a..."
wasm32posix-ar rcs "$INSTALL_DIR/lib/libinput.a" "${OBJS[@]}"

# --- Install public header ---------------------------------------------
# Consumers include only <libinput.h> (which pulls <stdlib.h> + <stdint.h>).
echo "==> Installing header..."
cp "$SRC/libinput.h" "$INSTALL_DIR/include/libinput.h"

# Device quirks: the data libinput reads at runtime from LIBINPUT_QUIRKS_DIR
# (/usr/share/libinput, src/config.h). Upstream installs quirks/ there
# (meson install_subdir). Without it libinput logs "Failed to load the device
# quirks" and applies no per-device fixups. A static library cannot carry a
# data directory to its consumer's image, so it ships as one declared file:
# a stored zip, sorted, with fixed timestamps and modes so its bytes follow
# the quirks alone. Image builders unpack it at LIBINPUT_QUIRKS_DIR.
mkdir -p "$INSTALL_DIR/share"
python3 - "$SRC_DIR/quirks" "$INSTALL_DIR/share/libinput-quirks.zip" <<'PY'
from pathlib import Path
import stat
import sys
import zipfile

root = Path(sys.argv[1])
files = sorted(p for p in root.iterdir() if p.is_file() and p.name.endswith(".quirks"))
if not files:
    sys.exit(f"no .quirks files under {root}")
with zipfile.ZipFile(sys.argv[2], "w", compression=zipfile.ZIP_STORED, strict_timestamps=True) as archive:
    for path in files:
        info = zipfile.ZipInfo(path.name, date_time=(1980, 1, 1, 0, 0, 0))
        info.create_system = 3
        info.external_attr = (stat.S_IFREG | 0o644) << 16
        archive.writestr(info, path.read_bytes())
PY

echo "==> libinput $LIBINPUT_VERSION installed at $INSTALL_DIR"
echo "    lib/libinput.a ($(wc -c < "$INSTALL_DIR/lib/libinput.a") bytes)"
