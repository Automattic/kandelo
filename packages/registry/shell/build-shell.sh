#!/usr/bin/env bash
# package-system build wrapper. Delegates to the existing
# images/vfs/scripts/build-shell-vfs-image.sh which produces
# apps/browser-demos/public/shell.vfs.zst, then installs that file into
# local-binaries/programs/ + the resolver scratch dir.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

# `vim-browser-bundle` and `nethack-browser-bundle` own the exact ZIP bytes.
# The package resolver exposes those declared direct-dependency outputs to the
# image composer; rebuilding either archive here would create a second,
# unrelated byte identity that browser delivery could not safely reproduce.
bash "$REPO_ROOT/images/vfs/scripts/build-shell-vfs-image.sh"

VFS="$REPO_ROOT/apps/browser-demos/public/shell.vfs.zst"
[ -f "$VFS" ] || { echo "ERROR: $VFS not produced by builder" >&2; exit 1; }

source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary shell "$VFS"
