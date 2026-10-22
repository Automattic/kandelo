#!/usr/bin/env bash
# Build the image package builds boot when they build inside Kandelo.
#
# 1. The canonical rootfs builder, with every package output installed
#    eagerly (no lazy references to resolve at build time).
# 2. The guest toolchain archive expanded under /usr.
#
# Resolver-only: the image is composed from exact declared dependency
# outputs, so there is no standalone developer mode.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

for var in WASM_POSIX_DEP_OUT_DIR WASM_POSIX_DEP_WORK_DIR \
    WASM_POSIX_DEP_KANDELO_SDK_BROWSER_BUNDLE_DIR SOURCE_DATE_EPOCH; do
    if [ -z "${!var:-}" ]; then
        echo "ERROR: $var is required; build with ./run.sh build kandelo-build-image" >&2
        exit 2
    fi
done
OUT_DIR="$(cd "$WASM_POSIX_DEP_OUT_DIR" && pwd -P)"
WORK_DIR="$(cd "$WASM_POSIX_DEP_WORK_DIR" && pwd -P)"
SDK_ZIP="$WASM_POSIX_DEP_KANDELO_SDK_BROWSER_BUNDLE_DIR/kandelo-sdk.zip"
[ -f "$SDK_ZIP" ] || { echo "ERROR: $SDK_ZIP not found" >&2; exit 2; }

EAGER_ROOTFS="$WORK_DIR/rootfs-eager.vfs.zst"
# Same sealed settings packages/registry/rootfs/build-rootfs-package.sh
# uses, so the base is the canonical rootfs except for the install mode.
(
    cd "$REPO_ROOT"
    ROOTFS_OUT="$EAGER_ROOTFS" \
        ROOTFS_PACKAGE_MANIFEST="$WORK_DIR/rootfs-packages.MANIFEST" \
        ROOTFS_BINARIES_DIR="$WORK_DIR/rootfs-binaries" \
        ROOTFS_SKIP_PACKAGE_RESOLVE=1 \
        ROOTFS_STAGE_RESOLVER_BINARIES=1 \
        ROOTFS_SEALED_BUILD=1 \
        bash "$REPO_ROOT/scripts/build-rootfs.sh" --default-install eager
)
[ -f "$EAGER_ROOTFS" ] || { echo "ERROR: eager rootfs not produced" >&2; exit 1; }

# tsx opens an IPC socket under TMPDIR; keep its path under the macOS limit.
TSX_TMP="$(mktemp -d /tmp/kandelo-build-image.XXXXXX)"
trap 'rm -rf -- "$TSX_TMP"' EXIT
TMPDIR="$TSX_TMP" node "$REPO_ROOT/node_modules/tsx/dist/cli.mjs" \
    "$REPO_ROOT/images/vfs/scripts/build-kandelo-build-image.ts" \
    "$EAGER_ROOTFS" "$SDK_ZIP" "$OUT_DIR/kandelo-build-image.vfs.zst"

[ -f "$OUT_DIR/kandelo-build-image.vfs.zst" ] || {
    echo "ERROR: kandelo-build-image.vfs.zst was not produced" >&2
    exit 1
}
