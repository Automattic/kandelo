#!/usr/bin/env bash
# package-system build wrapper for the WordPress VFS image.
# Delegates to images/vfs/scripts/build-wp-vfs-image.sh.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
source "$REPO_ROOT/scripts/package-build-roots.sh"

if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    if [ "${WASM_POSIX_RESOLUTION_POLICY:-}" = source-only-v1 ]; then
        : "${WASM_POSIX_DEP_SOURCE_DIR:?SourceOnly WordPress builds require verified core source}"
    fi
    WORDPRESS_SQLITE_SOURCE_DIR="$(
        kandelo_package_source_dependency_dir \
            wordpress-sqlite-integration-source
    )"
    export WORDPRESS_SQLITE_SOURCE_DIR
fi

# Resolver builds receive the verified WordPress and SQLite plugin sources;
# direct builds resolve the same package manifests themselves. `setup.sh`
# remains the local unpacked-demo entrypoint and creates a checkout-specific
# plugin symlink that is not a product-image input.

# Build-time opcache prewarming boots NodeKernelHost against the half-built VFS,
# so package builds need a host kernel even though wordpress itself is a
# wasm32 package. Build the local kernel artifact on demand; do not let the
# nested kernel build install into wordpress's package output directory.
if [ -n "${WASM_POSIX_DEP_KERNEL_DIR:-}" ] && \
   [ -f "$WASM_POSIX_DEP_KERNEL_DIR/kandelo-kernel.wasm" ]; then
    :
elif ! "$REPO_ROOT/scripts/resolve-binary.sh" kernel.wasm >/dev/null 2>&1; then
    echo "==> Building kernel.wasm for WordPress opcache prewarm..."
    env -u WASM_POSIX_DEP_OUT_DIR bash "$REPO_ROOT/packages/registry/kernel/build-kernel.sh"
fi

WORDPRESS_VFS_TSX_TMP="$(mktemp -d /tmp/kandelo-wordpress-vfs.XXXXXX)"
trap 'rm -rf -- "$WORDPRESS_VFS_TSX_TMP"' EXIT
VFS="$REPO_ROOT/apps/browser-demos/public/wordpress.vfs.zst"
if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    : "${WASM_POSIX_DEP_WORK_DIR:?resolver VFS builds require WASM_POSIX_DEP_WORK_DIR}"
    VFS="$WASM_POSIX_DEP_WORK_DIR/wordpress.vfs.zst"
fi
TMPDIR="$WORDPRESS_VFS_TSX_TMP" \
    bash "$REPO_ROOT/images/vfs/scripts/build-wp-vfs-image.sh" "$VFS"

[ -f "$VFS" ] || { echo "ERROR: $VFS not produced by builder" >&2; exit 1; }

if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
    export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=disabled
fi
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary wordpress "$VFS"
