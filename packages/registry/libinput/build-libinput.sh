#!/usr/bin/env bash
#
# Build libinput (libinput.a) for wasm32-posix-kernel through upstream's
# meson build with the SDK cross file (sdk/meson/wasm32posix.ini). Both
# backends are built: the udev seat backend over libudev-zero, which
# reads /sys and the uevent netlink socket, and the path backend.
#
# Patches (each states its boundary in its header):
#   0001  quirks: empty DMI identity where the platform has no DMI source
#   0002  bundled Linux UAPI headers off Linux and FreeBSD
#   0003  library() instead of shared_library() for libinput itself
# The bundled <linux/input.h> includes <linux/types.h>, which the
# Kandelo sysroot does not ship, so src/linux-types.h stands in for it
# on a private include path.
#
# Only the library target is built: upstream's tools, udev callouts and
# header compile tests are always-on executables, not library outputs.
#
# Honors the dep-resolver build-script contract (see
# docs/package-management.md). When invoked via
# `cargo xtask build-deps resolve libinput`, env vars are set by the
# resolver:
#
#     WASM_POSIX_DEP_OUT_DIR          # install prefix
#     WASM_POSIX_DEP_VERSION          # upstream version
#     WASM_POSIX_DEP_SOURCE_URL       # tarball URL
#     WASM_POSIX_DEP_SOURCE_SHA256    # expected sha256 of the tarball
#     WASM_POSIX_DEP_PKG_CONFIG_PATH  # every transitive dep's lib/pkgconfig

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_load_source_metadata "$SCRIPT_DIR"
# shellcheck source=/dev/null
kandelo_package_prepare_build_roots "$SCRIPT_DIR" wasm32
SRC_DIR="$KANDELO_PACKAGE_WORK_DIR/libinput-src"

LIBINPUT_VERSION="$WASM_POSIX_DEP_VERSION"
INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:-$SCRIPT_DIR/libinput-install}"
SOURCE_URL="$WASM_POSIX_DEP_SOURCE_URL"
SOURCE_SHA256="$WASM_POSIX_DEP_SOURCE_SHA256"

BUILD_DIR="$KANDELO_PACKAGE_WORK_DIR/libinput-build"
UAPI_DIR="$KANDELO_PACKAGE_WORK_DIR/libinput-uapi"
CROSS_FILE="$REPO_ROOT/sdk/meson/wasm32posix.ini"

if ! command -v wasm32posix-cc &>/dev/null; then
    echo "ERROR: wasm32posix-cc not found. Enter scripts/dev-shell.sh." >&2
    exit 1
fi

DEP_PKG_CONFIG_PATH="${WASM_POSIX_DEP_PKG_CONFIG_PATH:?WASM_POSIX_DEP_PKG_CONFIG_PATH not set (must be invoked via cargo xtask build-deps resolve libinput)}"

# --- Stage verified source ---
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Staging verified libinput $LIBINPUT_VERSION source..."
    kandelo_package_stage_verified_source libinput "$SRC_DIR" \
        "${WASM_POSIX_DEP_SOURCE_DIR:-}" "$SOURCE_URL" "$SOURCE_SHA256" \
        "$KANDELO_PACKAGE_WORK_DIR"
    for p in "$SCRIPT_DIR"/patches/*.patch; do
        patch -d "$SRC_DIR" -p1 < "$p"
    done
fi

# Fresh build dir each run — meson bakes --prefix into the build tree.
rm -rf "$BUILD_DIR" "$UAPI_DIR"
# The resolver-created output directory is itself publication authority, so
# a recipe must populate that inode rather than delete and recreate it.
if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    if [ -n "$(find "$INSTALL_DIR" -mindepth 1 -print -quit)" ]; then
        echo "ERROR: libinput resolver output directory must start empty" >&2
        exit 1
    fi
else
    rm -rf "$INSTALL_DIR"
fi

mkdir -p "$UAPI_DIR/linux"
cp "$SCRIPT_DIR/src/linux-types.h" "$UAPI_DIR/linux/types.h"

# The quirks directory and the override file are read at run time inside
# the VFS, so datadir and sysconfdir name guest paths, not the install
# prefix.
echo "==> Configuring libinput $LIBINPUT_VERSION for wasm32..."
PKG_CONFIG_PATH="$DEP_PKG_CONFIG_PATH" meson setup "$BUILD_DIR" "$SRC_DIR" \
    --cross-file "$CROSS_FILE" \
    --prefix "$INSTALL_DIR" \
    --libdir lib \
    --datadir /usr/share \
    --sysconfdir /etc \
    -Dbuildtype=plain \
    -Doptimization=2 \
    -Dc_args="-I$UAPI_DIR" \
    -Dlibwacom=false \
    -Ddebug-gui=false \
    -Dtests=false \
    -Dinstall-tests=false \
    -Ddocumentation=false \
    -Dzshcompletiondir=no

echo "==> Building libinput..."
ninja -C "$BUILD_DIR" libinput.a

# The devel tag installs the archive, libinput.h and libinput.pc.
echo "==> Installing to $INSTALL_DIR..."
meson install -C "$BUILD_DIR" --no-rebuild --tags devel

# Device quirks: the data libinput reads at run time from
# LIBINPUT_QUIRKS_DIR (/usr/share/libinput). A static library cannot carry
# a data directory to its consumer's image, so it ships as one declared
# file: a stored zip, sorted, with fixed timestamps and modes so its bytes
# follow the quirks alone. Image builders unpack it at LIBINPUT_QUIRKS_DIR.
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

for output in \
    lib/libinput.a \
    lib/pkgconfig/libinput.pc \
    include/libinput.h \
    share/libinput-quirks.zip
do
    if [ ! -f "$INSTALL_DIR/$output" ]; then
        echo "ERROR: Build failed — output not found at $INSTALL_DIR/$output" >&2
        exit 1
    fi
done

echo "==> libinput $LIBINPUT_VERSION build complete!"
ls -lh "$INSTALL_DIR/lib/libinput.a"
