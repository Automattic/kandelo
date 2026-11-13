#!/usr/bin/env bash
#
# Build xkbcli and xkbcli-compile-keymap for wasm32-posix-kernel.
#
# The port builds through upstream's meson build with the SDK cross file
# (sdk/meson/wasm32posix.ini), which links each executable through the
# SDK's strict link contract.
#
# Honors the dep-resolver build-script contract (see
# docs/package-management.md). When invoked via
# `cargo xtask build-deps resolve xkbcli`, env vars are set by the
# resolver:
#
#     WASM_POSIX_DEP_OUT_DIR          # install prefix
#     WASM_POSIX_DEP_VERSION          # upstream version
#     WASM_POSIX_DEP_SOURCE_URL       # tarball URL
#     WASM_POSIX_DEP_SOURCE_SHA256    # expected sha256 of the tarball

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
source "$REPO_ROOT/scripts/package-build-roots.sh"
source "$REPO_ROOT/sdk/activate.sh"
kandelo_package_load_source_metadata "$SCRIPT_DIR"
# shellcheck source=/dev/null
kandelo_package_prepare_build_roots "$SCRIPT_DIR" wasm32
SRC_DIR="$KANDELO_PACKAGE_WORK_DIR/xkbcommon-src"

XKB_VERSION="$WASM_POSIX_DEP_VERSION"
INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:-$SCRIPT_DIR/xkbcli-install}"
SOURCE_URL="$WASM_POSIX_DEP_SOURCE_URL"
SOURCE_SHA256="$WASM_POSIX_DEP_SOURCE_SHA256"

BUILD_DIR="$KANDELO_PACKAGE_WORK_DIR/xkbcommon-build"
CROSS_FILE="$REPO_ROOT/sdk/meson/wasm32posix.ini"

for tool in wasm32posix-cc meson ninja bison; do
    if ! command -v "$tool" &>/dev/null; then
        echo "ERROR: $tool not found. Enter scripts/dev-shell.sh." >&2
        exit 1
    fi
done

# --- Stage verified source ---
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Staging verified libxkbcommon $XKB_VERSION source..."
    kandelo_package_stage_verified_source xkbcli "$SRC_DIR" \
        "${WASM_POSIX_DEP_SOURCE_DIR:-}" "$SOURCE_URL" "$SOURCE_SHA256" \
        "$KANDELO_PACKAGE_WORK_DIR"
fi

rm -rf "$BUILD_DIR"
# The resolver-created output directory is itself publication authority, so
# a recipe must populate that inode rather than delete and recreate it.
if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    if [ -n "$(find "$INSTALL_DIR" -mindepth 1 -print -quit)" ]; then
        echo "ERROR: xkbcli resolver output directory must start empty" >&2
        exit 1
    fi
else
    rm -rf "$INSTALL_DIR"
fi
mkdir -p "$INSTALL_DIR"

# The prefix is the guest path: xkbcli execs its subcommands from
# <prefix>/libexec/xkbcommon, and the XKB data paths match the
# libxkbcommon package's.
echo "==> Configuring xkbcli $XKB_VERSION for wasm32..."
meson setup "$BUILD_DIR" "$SRC_DIR" \
    --cross-file "$CROSS_FILE" \
    --prefix /usr \
    -Dbuildtype=plain \
    -Doptimization=2 \
    -Dxkb-config-root=/usr/share/X11/xkb \
    -Dxkb-config-extra-path=/etc/xkb \
    -Dx-locale-root=/usr/share/X11/locale \
    -Denable-tools=true \
    -Denable-x11=false \
    -Denable-wayland=false \
    -Denable-xkbregistry=false \
    -Denable-docs=false \
    -Denable-bash-completion=false

echo "==> Building xkbcli..."
ninja -C "$BUILD_DIR" xkbcli xkbcli-compile-keymap

# A resolver caller owns the declared work and output roots. Keep the
# reviewed checkout read-only and suppress the developer-only local mirror.
if [ -n "${WASM_POSIX_DEP_WORK_DIR:-}" ] && [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
    # xkbcli replaces itself with execv and never forks.
    export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=disabled
fi
source "$REPO_ROOT/scripts/install-local-binary.sh"
for out in xkbcli xkbcli-compile-keymap; do
    cp "$BUILD_DIR/$out" "$BUILD_DIR/$out.wasm"
    install_local_binary xkbcli "$BUILD_DIR/$out.wasm" "$out.wasm"
done

echo "==> xkbcli $XKB_VERSION build complete!"
