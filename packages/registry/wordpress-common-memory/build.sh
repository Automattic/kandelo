#!/usr/bin/env bash
set -euo pipefail
recipe="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$recipe/../../.." && pwd)"
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_prepare_build_roots "$recipe/work" wasm32
: "${WASM_POSIX_DEP_WORDPRESS_FAMILY_VFS_DIR:?resolve wordpress-family-vfs}"
: "${WASM_POSIX_DEP_PHP_COMMON_MEMORY_DIR:?resolve php-common-memory}"
: "${WASM_POSIX_DEP_OUT_DIR:?run through the package resolver}"
image="$KANDELO_PACKAGE_WORK_DIR/wordpress-common-memory.vfs.zst"
cd "$REPO_ROOT"
node --import tsx/esm "$recipe/compose.ts" \
    "$WASM_POSIX_DEP_WORDPRESS_FAMILY_VFS_DIR/wordpress-family-vfs.vfs.zst" \
    "$WASM_POSIX_DEP_PHP_COMMON_MEMORY_DIR/php-fpm.wasm" "$image"
node --import tsx/esm scripts/check-image-layout.ts "$image"
source "$REPO_ROOT/scripts/install-local-binary.sh"
WASM_POSIX_INSTALL_LOCAL_MIRROR=0 WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=disabled \
    install_local_binary wordpress-common-memory "$image" wordpress-common-memory.vfs.zst
