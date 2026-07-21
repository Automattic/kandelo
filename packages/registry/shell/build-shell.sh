#!/usr/bin/env bash
# package-system build wrapper. Delegates to the existing
# images/vfs/scripts/build-shell-vfs-image.sh which produces
# apps/browser-demos/public/shell.vfs.zst, then installs that file into
# local-binaries/programs/ + the resolver scratch dir.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
VFS="$REPO_ROOT/apps/browser-demos/public/shell.vfs.zst"

HOMEBREW_TAP_ROOT="${KANDELO_HOMEBREW_MAIN_SHELL_TAP_ROOT:-}"
HOMEBREW_TAP_SHA="${KANDELO_HOMEBREW_MAIN_SHELL_TAP_SHA:-}"
if [ -n "$HOMEBREW_TAP_SHA" ] && [ -z "$HOMEBREW_TAP_ROOT" ]; then
    echo "ERROR: KANDELO_HOMEBREW_MAIN_SHELL_TAP_SHA requires KANDELO_HOMEBREW_MAIN_SHELL_TAP_ROOT" >&2
    exit 2
fi

if [ -n "$HOMEBREW_TAP_ROOT" ]; then
    # This is the strict migration path for the current shell artifact, not a
    # parallel demo image. The composer starts from platform-only rootfs state,
    # disables source and registry fallback, writes the canonical browser
    # shell.vfs.zst, and boots those exact bytes through NodeKernelHost.
    homebrew_args=(
        --tap-root "$HOMEBREW_TAP_ROOT"
        --out "$VFS"
    )
    if [ -n "$HOMEBREW_TAP_SHA" ]; then
        homebrew_args+=(--expected-tap-sha "$HOMEBREW_TAP_SHA")
    fi
    bash "$REPO_ROOT/scripts/build-homebrew-main-shell-closure.sh" \
        "${homebrew_args[@]}"
else
    # Keep direct/source package builds available until the pinned public
    # bottle catalog is the default release input. CI exercises the branch
    # above with the exact catalog commit from the migration lock.

    # `vim-browser-bundle` and `nethack-browser-bundle` own the exact ZIP
    # bytes. The resolver exposes those declared direct-dependency outputs to
    # the image composer; rebuilding either archive here would create a second
    # byte identity that browser delivery could not safely reproduce.
    bash "$REPO_ROOT/images/vfs/scripts/build-shell-vfs-image.sh"
fi

[ -f "$VFS" ] || { echo "ERROR: $VFS not produced by builder" >&2; exit 1; }

source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary shell "$VFS"
