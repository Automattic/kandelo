#!/usr/bin/env bash
#
# Stage the vendored Wayland protocol XML into the dep cache.
#
# wayland-protocols is a `kind = "library"` package (see package.toml).
# There is no tarball to fetch: the protocol XML is vendored in-tree
# under `xml/`. This script just copies it into the resolver's
# `$WASM_POSIX_DEP_OUT_DIR` so consumers that list `wayland-protocols`
# in `depends_on` find it at
# `$WASM_POSIX_DEP_WAYLAND_PROTOCOLS_DIR/xml/`.
#
# Consumers generate C glue from these files with the host
# `wayland-scanner` (provided via flake.nix), e.g.:
#
#     wayland-scanner client-header \
#         "$WASM_POSIX_DEP_WAYLAND_PROTOCOLS_DIR/xml/xdg-shell.xml" \
#         xdg-shell-client-protocol.h
#     wayland-scanner private-code  \
#         "$WASM_POSIX_DEP_WAYLAND_PROTOCOLS_DIR/xml/xdg-shell.xml" \
#         xdg-shell-protocol.c

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_XML="$SCRIPT_DIR/xml"
INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:-$SCRIPT_DIR/wayland-protocols-install}"

if [ ! -f "$SRC_XML/wayland.xml" ] || [ ! -f "$SRC_XML/xdg-shell.xml" ]; then
    echo "ERROR: vendored protocol XML missing under $SRC_XML" >&2
    exit 1
fi

# The resolver-created output directory is itself publication authority, so
# a recipe must populate that inode rather than delete and recreate it.
if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    if [ -n "$(find "$INSTALL_DIR" -mindepth 1 -print -quit)" ]; then
        echo "ERROR: wayland-protocols resolver output directory must start empty" >&2
        exit 1
    fi
else
    rm -rf "$INSTALL_DIR"
fi
mkdir -p "$INSTALL_DIR/xml"
cp "$SRC_XML"/*.xml "$INSTALL_DIR/xml/"

# Upstream wayland-protocols installs its XML under
# share/wayland-protocols/<category>/<protocol>/ and announces that root
# through pkg-config's pkgdatadir. CMake consumers (Quickshell's
# pkg_get_variable) resolve protocol paths against that layout, so stage
# the vendored files a second time at their upstream 1.45 paths.
# wayland.xml (core wayland) and wlr-layer-shell-unstable-v1.xml
# (wlroots) are not wayland-protocols upstream — they stay flat-only.
DATA_DIR="$INSTALL_DIR/share/wayland-protocols"
while read -r file category protocol; do
    mkdir -p "$DATA_DIR/$category/$protocol"
    cp "$SRC_XML/$file" "$DATA_DIR/$category/$protocol/"
done <<'MAPEOF'
linux-dmabuf-v1.xml stable linux-dmabuf
presentation-time.xml stable presentation-time
viewporter.xml stable viewporter
xdg-shell.xml stable xdg-shell
cursor-shape-v1.xml staging cursor-shape
ext-background-effect-v1.xml staging ext-background-effect
ext-idle-notify-v1.xml staging ext-idle-notify
ext-workspace-v1.xml staging ext-workspace
fractional-scale-v1.xml staging fractional-scale
xdg-activation-v1.xml staging xdg-activation
idle-inhibit-unstable-v1.xml unstable idle-inhibit
keyboard-shortcuts-inhibit-unstable-v1.xml unstable keyboard-shortcuts-inhibit
pointer-gestures-unstable-v1.xml unstable pointer-gestures
primary-selection-unstable-v1.xml unstable primary-selection
tablet-unstable-v2.xml unstable tablet
text-input-unstable-v3.xml unstable text-input
xdg-decoration-unstable-v1.xml unstable xdg-decoration
xdg-foreign-unstable-v1.xml unstable xdg-foreign
xdg-output-unstable-v1.xml unstable xdg-output
xdg-shell-unstable-v6.xml unstable xdg-shell
MAPEOF

mkdir -p "$INSTALL_DIR/share/pkgconfig"
cat > "$INSTALL_DIR/share/pkgconfig/wayland-protocols.pc" <<'PCEOF'
prefix=${pcfiledir}/../..
datarootdir=${prefix}/share
pkgdatadir=${datarootdir}/wayland-protocols

Name: Wayland Protocols
Description: Wayland protocol files
Version: 1.45
PCEOF

echo "==> wayland-protocols staged at $INSTALL_DIR"
for f in "$INSTALL_DIR"/xml/*.xml; do
    echo "    xml/$(basename "$f") ($(wc -c < "$f") bytes)"
done
