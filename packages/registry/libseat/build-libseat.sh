#!/usr/bin/env bash
#
# Build libseat (libseat.a) for wasm32-posix-kernel.
#
# seatd is meson-only, so the port builds through upstream's meson build
# with the SDK cross file (sdk/meson/wasm32posix.ini). Consumers use the
# noop backend (LIBSEAT_BACKEND=noop). Upstream refuses a noop-only build
# ("At least one backend must be enabled"), so the seatd client backend
# is also built; it is selected only when a seatd daemon is reachable,
# which Kandelo does not ship. No seatd server, logind or builtin backend.
#
# Honors the dep-resolver build-script contract (see
# docs/package-management.md). When invoked via
# `cargo xtask build-deps resolve libseat`, env vars are set by the
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
kandelo_package_load_source_metadata "$SCRIPT_DIR"
# shellcheck source=/dev/null
kandelo_package_prepare_build_roots "$SCRIPT_DIR" wasm32
SRC_DIR="$KANDELO_PACKAGE_WORK_DIR/libseat-src"

LIBSEAT_VERSION="$WASM_POSIX_DEP_VERSION"
INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:-$SCRIPT_DIR/libseat-install}"
SOURCE_URL="$WASM_POSIX_DEP_SOURCE_URL"
SOURCE_SHA256="$WASM_POSIX_DEP_SOURCE_SHA256"

BUILD_DIR="$KANDELO_PACKAGE_WORK_DIR/libseat-build"
CROSS_FILE="$REPO_ROOT/sdk/meson/wasm32posix.ini"

if ! command -v wasm32posix-cc &>/dev/null; then
    echo "ERROR: wasm32posix-cc not found. Enter scripts/dev-shell.sh." >&2
    exit 1
fi

# --- Stage verified source ---
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Staging verified libseat $LIBSEAT_VERSION source..."
    kandelo_package_stage_verified_source libseat "$SRC_DIR" \
        "${WASM_POSIX_DEP_SOURCE_DIR:-}" "$SOURCE_URL" "$SOURCE_SHA256" \
        "$KANDELO_PACKAGE_WORK_DIR"
fi

# Fresh build dir each run — meson bakes --prefix into the build tree.
rm -rf "$BUILD_DIR"
# The resolver-created output directory is itself publication authority, so
# a recipe must populate that inode rather than delete and recreate it.
if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    if [ -n "$(find "$INSTALL_DIR" -mindepth 1 -print -quit)" ]; then
        echo "ERROR: libseat resolver output directory must start empty" >&2
        exit 1
    fi
else
    rm -rf "$INSTALL_DIR"
fi

# Upstream defaults to werror=true; musl's CMSG_NXTHDR macro trips
# clang's -Wsign-compare in common/connection.c.
echo "==> Configuring libseat $LIBSEAT_VERSION for wasm32..."
meson setup "$BUILD_DIR" "$SRC_DIR" \
    --cross-file "$CROSS_FILE" \
    --prefix "$INSTALL_DIR" \
    --libdir lib \
    -Dbuildtype=plain \
    -Doptimization=2 \
    -Dwerror=false \
    -Dlibseat-seatd=enabled \
    -Dlibseat-logind=disabled \
    -Dlibseat-builtin=disabled \
    -Dserver=disabled \
    -Dexamples=disabled \
    -Dman-pages=disabled

echo "==> Building libseat..."
ninja -C "$BUILD_DIR"

echo "==> Installing to $INSTALL_DIR..."
meson install -C "$BUILD_DIR" --no-rebuild

if [ ! -f "$INSTALL_DIR/lib/libseat.a" ]; then
    echo "ERROR: Build failed — library not found at $INSTALL_DIR/lib/libseat.a" >&2
    exit 1
fi

echo "==> libseat $LIBSEAT_VERSION build complete!"
ls -lh "$INSTALL_DIR/lib/libseat.a"
