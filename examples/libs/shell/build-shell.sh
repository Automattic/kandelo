#!/usr/bin/env bash
# package-system build wrapper. Delegates to the existing
# examples/browser/scripts/build-shell-vfs-image.sh which produces
# examples/browser/public/shell.vfs, then installs that file into
# local-binaries/programs/ + the resolver scratch dir.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

bash "$REPO_ROOT/examples/browser/scripts/build-shell-vfs-image.sh"

VFS="$REPO_ROOT/examples/browser/public/shell.vfs"
[ -f "$VFS" ] || { echo "ERROR: $VFS not produced by builder" >&2; exit 1; }

source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary shell "$VFS"
