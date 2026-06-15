#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
cd "$REPO_ROOT"
echo "==> Building Shell VFS image..."
npx tsx "$SCRIPT_DIR/build-shell-vfs-image.ts"
echo "==> Done."
ls -lh apps/browser-demos/public/shell.vfs.zst

# Mirror into local-binaries/ so the @binaries/ Vite alias resolves for
# pages/kandelo/kernel-host/live-setup.ts. See sibling build-nginx-vfs-image.sh for rationale.
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary shell "$REPO_ROOT/apps/browser-demos/public/shell.vfs.zst"
