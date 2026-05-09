#!/usr/bin/env bash
# package-system build wrapper. Delegates to the existing
# examples/browser/scripts/build-shell-vfs-image.sh which produces
# examples/browser/public/shell.vfs.zst, then installs that file into
# local-binaries/programs/ + the resolver scratch dir.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

# Build the lazy-archive zips that build-shell-vfs-image.ts mounts as
# /usr/bin/{vim,nethack} + /usr/share/{vim,nethack}/. These are NOT
# outputs of the vim/nethack registry packages (the release ships
# vim.wasm/nethack.wasm bare in tar.zst archives), so without this
# step the .ts script aborts with "vim.zip not found" on a clean
# source-build of `shell`. The vim/nethack deps in package.toml ensure
# the underlying wasms + runtime trees are already built by the
# resolver before we land here. Idempotent: each zip script
# short-circuits if its output is already present.
bash "$REPO_ROOT/examples/browser/scripts/build-vim-zip.sh"
bash "$REPO_ROOT/examples/browser/scripts/build-nethack-zip.sh"

bash "$REPO_ROOT/examples/browser/scripts/build-shell-vfs-image.sh"

VFS="$REPO_ROOT/examples/browser/public/shell.vfs.zst"
[ -f "$VFS" ] || { echo "ERROR: $VFS not produced by builder" >&2; exit 1; }

source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary shell "$VFS"
