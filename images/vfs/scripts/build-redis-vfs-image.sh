#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
cd "$REPO_ROOT"
echo "==> Building Redis VFS image..."
# A resolver build writes the image under its own work root so the
# checkout stays untouched; a standalone run writes the browser demo copy.
VFS_DIR="$REPO_ROOT/apps/browser-demos/public"
if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
  : "${WASM_POSIX_DEP_WORK_DIR:?resolver VFS builds require WASM_POSIX_DEP_WORK_DIR}"
  VFS_DIR="$WASM_POSIX_DEP_WORK_DIR"
fi
VFS="$VFS_DIR/redis.vfs.zst"
npx tsx "$SCRIPT_DIR/build-redis-vfs-image.ts" "$VFS"
echo "==> Done."
ls -lh "$VFS"

# Mirror into local-binaries/ so the @binaries/ Vite alias resolves for
# pages/redis/main.ts. See sibling build-nginx-vfs-image.sh for rationale.
# A resolver caller owns the declared work and output roots. Keep the
# reviewed checkout read-only and suppress the developer-only local mirror.
if [ -n "${WASM_POSIX_DEP_WORK_DIR:-}" ] && [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
  export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
  export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=disabled
fi
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary redis-vfs "$VFS_DIR/redis.vfs.zst"
