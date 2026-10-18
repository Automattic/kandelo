#!/usr/bin/env bash
#
# Build libxkbcommon.a for wasm32-posix-kernel.
#
# The port builds through upstream's meson build with the SDK cross file
# (sdk/meson/wasm32posix.ini). Only the libxkbcommon library target is
# compiled: upstream always defines its test executables, and they are
# not part of this package.
#
# Honors the dep-resolver build-script contract (docs/package-management.md):
# when invoked via `cargo xtask build-deps resolve libxkbcommon` the resolver
# sets WASM_POSIX_DEP_OUT_DIR / _VERSION / _SOURCE_URL / _SOURCE_SHA256.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_load_source_metadata "$SCRIPT_DIR"
# Source, build scratch and patched copies live in the resolver-owned work
# root (or a direct run's private one), never under the reviewed checkout.
# shellcheck source=/dev/null
kandelo_package_prepare_build_roots "$SCRIPT_DIR" wasm32
WORK_DIR="$KANDELO_PACKAGE_WORK_DIR"
SRC_DIR="$WORK_DIR/xkbcommon-src"
VERIFIED_SOURCE_DIR="${WASM_POSIX_DEP_SOURCE_DIR:-}"
SOURCE_MARKER="$WORK_DIR/.kandelo-libxkbcommon-source"

XKB_VERSION="$WASM_POSIX_DEP_VERSION"
INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:-$SCRIPT_DIR/libxkbcommon-install}"
SOURCE_URL="$WASM_POSIX_DEP_SOURCE_URL"
SOURCE_SHA256="$WASM_POSIX_DEP_SOURCE_SHA256"

BUILD_DIR="$WORK_DIR/xkbcommon-build"
CROSS_FILE="$REPO_ROOT/sdk/meson/wasm32posix.ini"

# --- Toolchain ----------------------------------------------------------
for tool in wasm32posix-cc meson ninja bison; do
    if ! command -v "$tool" &>/dev/null; then
        echo "ERROR: $tool not found. Enter scripts/dev-shell.sh (provides the" >&2
        echo "       wasm toolchain, meson, ninja and bison from flake.nix)." >&2
        exit 1
    fi
done

# --- Stage verified source ---------------------------------------------
# The resolver hands over an already-verified archive (source-only policy);
# a direct run downloads and checks the pinned sha256. A source tree staged
# for a different version, URL or hash is discarded rather than reused, so
# a version bump can never build from the previous release's tree.
expected_source_marker="$(printf '%s\n%s\n%s' "$XKB_VERSION" "$SOURCE_URL" "$SOURCE_SHA256")"
if [ -d "$SRC_DIR" ] && [ "$(cat "$SOURCE_MARKER" 2>/dev/null || true)" != "$expected_source_marker" ]; then
    rm -rf "$SRC_DIR"
fi
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Staging verified libxkbcommon $XKB_VERSION source..."
    kandelo_package_stage_verified_source libxkbcommon "$SRC_DIR" "$VERIFIED_SOURCE_DIR" \
        "$SOURCE_URL" "$SOURCE_SHA256" "$WORK_DIR"
    printf '%s\n' "$expected_source_marker" > "$SOURCE_MARKER"
fi

# Fresh build dir each run — meson bakes --prefix into the build tree.
rm -rf "$BUILD_DIR"
# Empty the output prefix rather than replacing it: the resolver owns
# WASM_POSIX_DEP_OUT_DIR and records its inode identity, so an rm -rf +
# mkdir of the directory ITSELF makes the publish step reject the build
# ("build stage changed identity and was preserved").
mkdir -p "$INSTALL_DIR"
find "$INSTALL_DIR" -mindepth 1 -delete

# The XKB data paths are compiled into the library and resolved inside
# the Kandelo machine, not under the install prefix: the xkeyboard-config
# package's rules sit at /usr/share/X11/xkb there. --datadir sets the
# legacy X11 root, which upstream derives from it and exposes no option
# for.
echo "==> Configuring libxkbcommon $XKB_VERSION for wasm32..."
meson setup "$BUILD_DIR" "$SRC_DIR" \
    --cross-file "$CROSS_FILE" \
    --prefix "$INSTALL_DIR" \
    --libdir lib \
    --datadir /usr/share \
    -Dbuildtype=plain \
    -Doptimization=2 \
    -Dxkb-config-root=/usr/share/X11/xkb \
    -Dxkb-config-extra-path=/etc/xkb \
    -Dx-locale-root=/usr/share/X11/locale \
    -Denable-tools=false \
    -Denable-x11=false \
    -Denable-wayland=false \
    -Denable-xkbregistry=false \
    -Denable-docs=false \
    -Denable-bash-completion=false

echo "==> Building libxkbcommon..."
meson compile -C "$BUILD_DIR" xkbcommon

echo "==> Installing to $INSTALL_DIR..."
meson install -C "$BUILD_DIR" --no-rebuild

if [ ! -f "$INSTALL_DIR/lib/libxkbcommon.a" ]; then
    echo "ERROR: Build failed — library not found at $INSTALL_DIR/lib/libxkbcommon.a" >&2
    exit 1
fi

echo "==> libxkbcommon $XKB_VERSION installed at $INSTALL_DIR"
echo "    lib/libxkbcommon.a ($(wc -c < "$INSTALL_DIR/lib/libxkbcommon.a") bytes)"
