#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
cd "$REPO_ROOT"
if [ "$#" -ne 0 ] && [ "${1:-}" = "--vfs-product-manifest" ]; then
  exec node "$REPO_ROOT/node_modules/tsx/dist/cli.mjs" \
    "$SCRIPT_DIR/staged-product-inputs.ts" browser-nginx-php "$@"
fi
echo "==> Building nginx + PHP-FPM VFS image..."
VFS_DIR="$REPO_ROOT/apps/browser-demos/public"
if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
  : "${WASM_POSIX_DEP_WORK_DIR:?resolver VFS builds require WASM_POSIX_DEP_WORK_DIR}"
  VFS_DIR="$WASM_POSIX_DEP_WORK_DIR"
fi
VFS="$VFS_DIR/nginx-php-vfs.vfs.zst"
NGINX_PHP_VFS_TSX_TMP="$(mktemp -d /tmp/kandelo-nginx-php-vfs.XXXXXX)"
trap 'rm -rf -- "$NGINX_PHP_VFS_TSX_TMP"' EXIT
TMPDIR="$NGINX_PHP_VFS_TSX_TMP" npx tsx \
  "$SCRIPT_DIR/build-nginx-php-vfs-image.ts" "$VFS"
echo "==> Done."
ls -lh "$VFS"

# Mirror into local-binaries/ so the @binaries/ Vite alias resolves for
# pages/nginx-php/main.ts. See sibling build-nginx-vfs-image.sh for rationale.
if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
  export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
  export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=disabled
fi
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary nginx-php-vfs "$VFS_DIR/nginx-php-vfs.vfs.zst"
