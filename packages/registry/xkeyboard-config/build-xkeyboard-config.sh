#!/usr/bin/env bash
#
# Build the xkeyboard-config XKB database for Kandelo images.
#
# xkeyboard-config is data only. Its meson project declares no language,
# so meson never probes a compiler and a cross file changes nothing: the
# build is a plain native `meson setup`, which runs upstream's Python rules
# generator and Perl listing script on the host. The installed tree is the
# same bytes for every target architecture.
#
# Upstream installs the tree at <datadir>/xkeyboard-config-2 and adds
# <datadir>/X11/xkb as a symlink to that absolute path. Kandelo's
# libxkbcommon reads /usr/share/X11/xkb, and a cache entry cannot carry an
# absolute symlink into a guest path, so the build installs into a staging
# root and publishes the real tree at share/X11/xkb. The rest of the staging
# root (the .pc files, and the man page upstream builds whenever xsltproc
# is on PATH) is not published.
#
# Honors the dep-resolver build-script contract (docs/package-management.md):
# when invoked via `cargo xtask build-deps resolve xkeyboard-config` the
# resolver sets WASM_POSIX_DEP_OUT_DIR / _VERSION / _SOURCE_URL /
# _SOURCE_SHA256.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
source "$REPO_ROOT/scripts/package-build-roots.sh"
source "$REPO_ROOT/sdk/activate.sh"
kandelo_package_load_source_metadata "$SCRIPT_DIR"
# shellcheck source=/dev/null
kandelo_package_prepare_build_roots "$SCRIPT_DIR" wasm32
WORK_DIR="$KANDELO_PACKAGE_WORK_DIR"
SRC_DIR="$WORK_DIR/xkeyboard-config-src"
BUILD_DIR="$WORK_DIR/xkeyboard-config-build"
STAGE_DIR="$WORK_DIR/xkeyboard-config-stage"

XKC_VERSION="$WASM_POSIX_DEP_VERSION"
INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:-$SCRIPT_DIR/xkeyboard-config-install}"
SOURCE_URL="$WASM_POSIX_DEP_SOURCE_URL"
SOURCE_SHA256="$WASM_POSIX_DEP_SOURCE_SHA256"

for tool in meson ninja python3 perl; do
    if ! command -v "$tool" &>/dev/null; then
        echo "ERROR: $tool not found. Enter scripts/dev-shell.sh." >&2
        exit 1
    fi
done

if [ ! -d "$SRC_DIR" ]; then
    echo "==> Staging verified xkeyboard-config $XKC_VERSION source..."
    kandelo_package_stage_verified_source xkeyboard-config "$SRC_DIR" \
        "${WASM_POSIX_DEP_SOURCE_DIR:-}" "$SOURCE_URL" "$SOURCE_SHA256" \
        "$WORK_DIR"
fi

rm -rf "$BUILD_DIR" "$STAGE_DIR"
# The resolver-created output directory is itself publication authority, so
# a recipe must populate that inode rather than delete and recreate it.
mkdir -p "$INSTALL_DIR"
find "$INSTALL_DIR" -mindepth 1 -delete

# nls: translations of the layout descriptions only feed GUI layout
# pickers through libxkbregistry's gettext lookup; keymap compilation
# never reads them. compat-rules stays on (upstream default): it maps
# renamed layouts and variants to their current names, so configurations
# written against older releases keep compiling.
echo "==> Configuring xkeyboard-config $XKC_VERSION..."
meson setup "$BUILD_DIR" "$SRC_DIR" \
    --prefix /usr \
    -Dnls=false \
    -Dcompat-rules=true \
    -Dxorg-rules-symlinks=false \
    -Dnon-latin-layouts-list=false

echo "==> Building xkeyboard-config..."
ninja -C "$BUILD_DIR"

DESTDIR="$STAGE_DIR" meson install -C "$BUILD_DIR" --no-rebuild

XKB_TREE="$STAGE_DIR/usr/share/xkeyboard-config-2"
if [ -n "$(find "$XKB_TREE" -type l -print -quit)" ]; then
    echo "ERROR: xkeyboard-config tree contains symlinks:" >&2
    find "$XKB_TREE" -type l >&2
    exit 1
fi

mkdir -p "$INSTALL_DIR/share/X11"
cp -R "$XKB_TREE" "$INSTALL_DIR/share/X11/xkb"

# A library cannot carry a data directory into its consumer's image, so the
# tree also ships as one declared file: sorted entries, fixed timestamps and
# modes, so its bytes follow the tree alone. Image builders unpack it at
# /usr/share/X11/xkb.
python3 - "$INSTALL_DIR/share/X11/xkb" "$INSTALL_DIR/share/xkeyboard-config.zip" <<'PY'
from pathlib import Path
import stat
import sys
import zipfile

root = Path(sys.argv[1])
files = sorted(p for p in root.rglob("*") if p.is_file())
with zipfile.ZipFile(sys.argv[2], "w", compression=zipfile.ZIP_DEFLATED, strict_timestamps=True) as archive:
    for path in files:
        info = zipfile.ZipInfo(path.relative_to(root).as_posix(), date_time=(1980, 1, 1, 0, 0, 0))
        info.create_system = 3
        info.external_attr = (stat.S_IFREG | 0o644) << 16
        info.compress_type = zipfile.ZIP_DEFLATED
        archive.writestr(info, path.read_bytes())
PY

for output in \
    share/X11/xkb/rules/evdev \
    share/xkeyboard-config.zip
do
    if [ ! -f "$INSTALL_DIR/$output" ]; then
        echo "ERROR: Build failed — output not found at $INSTALL_DIR/$output" >&2
        exit 1
    fi
done

echo "==> xkeyboard-config $XKC_VERSION installed at $INSTALL_DIR"
