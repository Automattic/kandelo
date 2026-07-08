#!/usr/bin/env bash
#
# Stage the vendored Wayland protocol XML into the dep cache.
#
# wayland-protocols is a `kind = "source"` package (see package.toml).
# There is no tarball to fetch: the protocol XML is vendored in-tree
# under `xml/`. This script just copies it into the resolver's
# `$WASM_POSIX_DEP_OUT_DIR` so consumers that list `wayland-protocols`
# in `depends_on` find it at
# `$WASM_POSIX_DEP_WAYLAND_PROTOCOLS_SRC_DIR/xml/`.
#
# Consumers generate C glue from these files with the host
# `wayland-scanner` (provided via flake.nix), e.g.:
#
#     wayland-scanner client-header \
#         "$WASM_POSIX_DEP_WAYLAND_PROTOCOLS_SRC_DIR/xml/xdg-shell.xml" \
#         xdg-shell-client-protocol.h
#     wayland-scanner private-code  \
#         "$WASM_POSIX_DEP_WAYLAND_PROTOCOLS_SRC_DIR/xml/xdg-shell.xml" \
#         xdg-shell-protocol.c
#
# See docs/package-management.md ("Source-kind manifests").

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_XML="$SCRIPT_DIR/xml"
INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:-$SCRIPT_DIR/wayland-protocols-install}"

if [ ! -f "$SRC_XML/wayland.xml" ] || [ ! -f "$SRC_XML/xdg-shell.xml" ]; then
    echo "ERROR: vendored protocol XML missing under $SRC_XML" >&2
    exit 1
fi

rm -rf "$INSTALL_DIR"
mkdir -p "$INSTALL_DIR/xml"
cp "$SRC_XML"/*.xml "$INSTALL_DIR/xml/"

echo "==> wayland-protocols staged at $INSTALL_DIR"
for f in "$INSTALL_DIR"/xml/*.xml; do
    echo "    xml/$(basename "$f") ($(wc -c < "$f") bytes)"
done
