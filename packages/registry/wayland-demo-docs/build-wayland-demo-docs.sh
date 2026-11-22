#!/usr/bin/env bash
# Manual pages for Kandelo's Wayland desktop programs (wlcompositor, wlterm, wlclock, wlpaint, klauncher, kclipd, notify-send), as wayland-demo-docs.zip, a lazy archive mounted at /usr/.
# Kandelo writes these commands and their --help;
# kandelo_man_pages_own_commands lays out what each prints inside Kandelo.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_prepare_build_roots "$HERE" wasm32
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/install-package-man-pages.sh"
OWNER="${WASM_POSIX_DEP_WAYLAND_DEMO_DIR:?wayland-demo dependency dir required}"

kandelo_man_pages_own_commands wayland-demo-docs wayland-demo 0.1.0 \
    wlcompositor.1="$OWNER/wlcompositor.wasm" \
    wlterm.1="$OWNER/wlterm.wasm" \
    wlclock.1="$OWNER/wlclock.wasm" \
    wlpaint.1="$OWNER/wlpaint.wasm" \
    klauncher.1="$OWNER/klauncher.wasm" \
    kclipd.1="$OWNER/kclipd.wasm" \
    notify-send.1="$OWNER/notify-send.wasm"
