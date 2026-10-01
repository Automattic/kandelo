#!/usr/bin/env bash
#
# Stage hyprland-protocols 0.6.4 for wasm32-posix-kernel consumers.
#
# Upstream's meson.build installs protocols/*.xml under
# <datadir>/hyprland-protocols/protocols and configures
# hyprland-protocols.pc; nothing is compiled. The dev shell carries no
# meson, so this script reproduces that install layout from the verified
# source tree. The .pc is relocatable (prefix = its own location) like
# libdrm.pc, because the resolver publishes the prefix elsewhere.
#
# Honors the dep-resolver build-script contract (docs/package-management.md).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_prepare_build_roots "$SCRIPT_DIR" wasm32
WORK_DIR="$KANDELO_PACKAGE_WORK_DIR"
SRC_DIR="$WORK_DIR/hyprland-protocols-src"
INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:-$WORK_DIR/hyprland-protocols-install}"

PROTOCOLS_VERSION="${WASM_POSIX_DEP_VERSION:-0.6.4}"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://github.com/hyprwm/hyprland-protocols/archive/refs/tags/v${PROTOCOLS_VERSION}.tar.gz}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-0d4f99abc21b04fc126dd754e306bb84cd334131d542ff2e0c172190c6570384}"
VERIFIED_SOURCE_DIR="${WASM_POSIX_DEP_SOURCE_DIR:-}"

echo "==> Staging verified hyprland-protocols $PROTOCOLS_VERSION source..."
rm -rf "$SRC_DIR"
kandelo_package_stage_verified_source hyprland-protocols "$SRC_DIR" \
    "$VERIFIED_SOURCE_DIR" "$SOURCE_URL" "$SOURCE_SHA256" "$WORK_DIR"

if [ "$(tr -d '[:space:]' < "$SRC_DIR/VERSION")" != "$PROTOCOLS_VERSION" ]; then
    echo "ERROR: staged source is version $(cat "$SRC_DIR/VERSION"), expected $PROTOCOLS_VERSION" >&2
    exit 1
fi

# The resolver owns INSTALL_DIR and records its inode; empty it in place.
mkdir -p "$INSTALL_DIR"
find "$INSTALL_DIR" -mindepth 1 -delete
DATA_DIR="$INSTALL_DIR/share/hyprland-protocols/protocols"
PC_DIR="$INSTALL_DIR/share/pkgconfig"
mkdir -p "$DATA_DIR" "$PC_DIR"

echo "==> Installing protocol XML to $DATA_DIR..."
cp "$SRC_DIR"/protocols/*.xml "$DATA_DIR/"

echo "==> Writing hyprland-protocols.pc..."
cat > "$PC_DIR/hyprland-protocols.pc" <<PCEOF
prefix=\${pcfiledir}/../..
datarootdir=\${prefix}/share
pkgdatadir=\${datarootdir}/hyprland-protocols

Name: Hyprland Protocols
Description: Hyprland protocol files
Version: $PROTOCOLS_VERSION
PCEOF

for f in \
    share/hyprland-protocols/protocols/hyprland-global-shortcuts-v1.xml \
    share/hyprland-protocols/protocols/hyprland-focus-grab-v1.xml \
    share/hyprland-protocols/protocols/hyprland-toplevel-mapping-v1.xml \
    share/pkgconfig/hyprland-protocols.pc
do
    if [ ! -f "$INSTALL_DIR/$f" ]; then
        echo "ERROR: expected hyprland-protocols output missing: $f" >&2
        exit 1
    fi
done

echo "==> hyprland-protocols $PROTOCOLS_VERSION installed at $INSTALL_DIR"
