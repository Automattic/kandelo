#!/usr/bin/env bash
#
# PR2 proof: the host `wayland-scanner` turns the vendored v1 protocol
# XML into complete, well-formed C glue.
#
# Always-on checks (need only `wayland-scanner` on PATH):
#   1. Generate client-header + server-header + private-code for
#      xml/wayland.xml and xml/xdg-shell.xml.
#   2. Assert every v1 `wl_*`/`xdg_*` interface the compositor and
#      clients need is present in the generated code.
#
# Optional check (dev shell): if `wasm32posix-cc` is on PATH and a
# `wayland-util.h` is reachable (via $WAYLAND_UTIL_H, else skipped),
# compile the generated private-code for wasm32 to confirm it is
# wasm-clean. The header itself is owned by libwayland (PR3); this step
# is best-effort until that lands.
#
# Prints "wayland-protocols: ALL PASS" on success. Exit 2 (not failure)
# if wayland-scanner is absent, so callers can treat it as "skip".

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
XML_DIR="$HERE/../xml"

if ! command -v wayland-scanner >/dev/null 2>&1; then
    echo "wayland-protocols: SKIP (wayland-scanner not on PATH — add it via flake.nix / scripts/dev-shell.sh)"
    exit 2
fi

echo "wayland-protocols: using $(wayland-scanner --version 2>&1 | head -1)"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

gen() {
    local base="$1" xml="$2"
    wayland-scanner client-header "$xml" "$WORK/${base}-client-protocol.h"
    wayland-scanner server-header "$xml" "$WORK/${base}-server-protocol.h"
    wayland-scanner private-code  "$xml" "$WORK/${base}-protocol.c"
}

gen wayland         "$XML_DIR/wayland.xml"
gen xdg-shell       "$XML_DIR/xdg-shell.xml"
gen linux-dmabuf-v1 "$XML_DIR/linux-dmabuf-v1.xml"

# --- completeness: every v1 interface must appear in the generated code ---
failures=0
check_iface() {
    local file="$1" sym="$2"
    if grep -q "\b${sym}_interface\b" "$WORK/$file"; then
        echo "  OK   ${sym}_interface"
    else
        echo "  MISS ${sym}_interface (expected in $file)"
        failures=$((failures + 1))
    fi
}

echo "wayland-protocols: core (wayland.xml) interfaces:"
for i in wl_display wl_registry wl_callback wl_compositor wl_surface \
         wl_shm wl_shm_pool wl_buffer wl_seat wl_keyboard wl_pointer wl_output; do
    check_iface wayland-protocol.c "$i"
done

echo "wayland-protocols: xdg-shell interfaces:"
for i in xdg_wm_base xdg_surface xdg_toplevel; do
    check_iface xdg-shell-protocol.c "$i"
done

echo "wayland-protocols: linux-dmabuf-v1 interfaces:"
for i in zwp_linux_dmabuf_v1 zwp_linux_buffer_params_v1; do
    check_iface linux-dmabuf-v1-protocol.c "$i"
done

# --- optional wasm32 compile of the generated glue ------------------------
if command -v wasm32posix-cc >/dev/null 2>&1 && [ -n "${WAYLAND_UTIL_H:-}" ] \
   && [ -f "${WAYLAND_UTIL_H:-/nonexistent}" ]; then
    echo "wayland-protocols: wasm32-compiling generated glue (wayland-util.h=$WAYLAND_UTIL_H)"
    inc="$WORK/inc"; mkdir -p "$inc"; cp "$WAYLAND_UTIL_H" "$inc/wayland-util.h"
    for base in wayland xdg-shell linux-dmabuf-v1; do
        if wasm32posix-cc -c -O2 -fPIC -I"$inc" \
               "$WORK/${base}-protocol.c" -o "$WORK/${base}-protocol.o"; then
            echo "  OK   wasm32 ${base}-protocol.o ($(wc -c < "$WORK/${base}-protocol.o") bytes)"
        else
            echo "  FAIL wasm32 compile of ${base}-protocol.c"
            failures=$((failures + 1))
        fi
    done
else
    echo "wayland-protocols: (wasm32 compile skipped — set WAYLAND_UTIL_H to enable; header lands with libwayland in PR3)"
fi

if [ "$failures" -eq 0 ]; then
    echo "wayland-protocols: ALL PASS"
    exit 0
fi
echo "wayland-protocols: $failures FAILURE(S)"
exit 1
