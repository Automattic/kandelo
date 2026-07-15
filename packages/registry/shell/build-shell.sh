#!/usr/bin/env bash
# package-system build wrapper. Delegates to the existing
# images/vfs/scripts/build-shell-vfs-image.sh which produces
# apps/browser-demos/public/shell.vfs.zst, then installs that file into
# local-binaries/programs/ + the resolver scratch dir.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

# Vim is already a resolver-owned vim-browser-bundle dependency, so the VFS
# builder consumes that exact zip. NetHack still uses its legacy on-the-fly
# bundle helper.
bash "$REPO_ROOT/images/vfs/scripts/build-nethack-zip.sh"

bash "$REPO_ROOT/images/vfs/scripts/build-shell-vfs-image.sh"

VFS="$REPO_ROOT/apps/browser-demos/public/shell.vfs.zst"
[ -f "$VFS" ] || { echo "ERROR: $VFS not produced by builder" >&2; exit 1; }

source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary shell "$VFS"
