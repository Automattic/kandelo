#!/usr/bin/env bash
# Assert what FFmpeg's configure and link actually produced.
#
# WHY: a configure that exits 0 with a feature silently missing, or that
# claims a libc function Kandelo does not provide, is the misleading-probe
# failure in the design's §4. The SDK links executables with
# --allow-undefined, so a link probe can succeed for a function that does
# not exist; only the real archive symbols can say whether it does.
#
#   audit-configure.sh config <configured-tree> <sysroot>
#   audit-configure.sh link <program.wasm>
#
# FFMPEG_AUDIT_EXPECT_DEPS=0 skips the external-library checks; only the
# hand-run rung-1 build (which disables them) sets it.
set -euo pipefail
cmd="${1:-}"; shift || true
case "$cmd" in
config)
    tree="$1"; sysroot="$2"
    h="$tree/config.h"; c="$tree/config_components.h"
    bad=0
    for want in HAVE_SIMD128 HAVE_PTHREADS; do
        grep -q "^#define $want 1" "$h" || { echo "audit: $want is not enabled" >&2; bad=1; }
    done
    if [ "${FFMPEG_AUDIT_EXPECT_DEPS:-1}" = 1 ]; then
        for want in CONFIG_ZLIB CONFIG_ICONV CONFIG_LIBXML2 CONFIG_SDL2; do
            grep -qh "^#define $want 1" "$h" "$c" 2>/dev/null \
                || { echo "audit: $want is not enabled" >&2; bad=1; }
        done
    fi
    # Every system function configure claims must be defined in libc.a.
    funcs=$(awk '/^SYSTEM_FUNCS="/{f=1;next} f&&/^"/{exit} f{print $1}' "$tree/configure")
    [ -n "$funcs" ] || { echo "audit: SYSTEM_FUNCS list not found in configure" >&2; exit 1; }
    defined=$(wasm32posix-nm --defined-only "$sysroot/lib/libc.a" | awk 'NF>=2{print $NF}' | sort -u)
    [ -n "$defined" ] || { echo "audit: no symbols read from $sysroot/lib/libc.a" >&2; exit 1; }
    for fn in $funcs; do
        up=$(printf '%s' "$fn" | tr '[:lower:]' '[:upper:]')
        # A here-string, not `printf | grep -q`: under pipefail, grep -q's
        # early exit can SIGPIPE the writer and report a present symbol as
        # missing.
        if grep -q "^#define HAVE_$up 1" "$h" && ! grep -qx -- "$fn" <<<"$defined"; then
            echo "audit: config.h claims HAVE_$up but $sysroot/lib/libc.a does not define $fn" >&2
            bad=1
        fi
    done
    [ "$bad" = 0 ] && echo "audit: configure results verified ($(printf '%s\n' $funcs | wc -l | tr -d ' ') system functions checked)"
    exit "$bad"
    ;;
link)
    wasm="$1"
    bad=0
    n=$(wasm-objdump -d "$wasm" | grep -cE '\b(v128|i8x16|i16x8|i32x4|i64x2|f32x4|f64x2)\.' || true)
    echo "audit: $(basename "$wasm") contains $n SIMD instructions"
    [ "$n" -gt 0 ] || { echo "audit: no SIMD instructions in $wasm" >&2; bad=1; }
    # The SDK links with --allow-undefined, so a missing function becomes a
    # host import that traps when called. Everything a program imports from
    # `env` must be something the platform actually provides.
    undefined=$(wasm-objdump -x -j Import "$wasm" \
        | sed -n 's/.*<- env\.\([A-Za-z0-9_]*\).*/\1/p' \
        | grep -vxE 'memory|__channel_base' || true)
    if [ -n "$undefined" ]; then
        echo "audit: $(basename "$wasm") imports symbols no library defines:" $undefined >&2
        bad=1
    fi
    exit "$bad"
    ;;
*) echo "usage: audit-configure.sh config <tree> <sysroot> | link <wasm>" >&2; exit 2 ;;
esac
