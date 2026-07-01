#!/usr/bin/env bash
set -euo pipefail

# Build GNU Netcat 0.7.1 for wasm32-posix-kernel.

NETCAT_VERSION="${NETCAT_VERSION:-0.7.1}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
WORK_DIR="${WASM_POSIX_DEP_WORK_DIR:-$SCRIPT_DIR}"
SRC_DIR="$WORK_DIR/netcat-src"
BIN_DIR="${WASM_POSIX_DEP_OUT_DIR:-$SCRIPT_DIR/bin}"
SYSROOT="${WASM_POSIX_SYSROOT:-$REPO_ROOT/sysroot}"

if ! command -v wasm32posix-cc &>/dev/null; then
    echo "ERROR: wasm32posix-cc not found. Run 'npm link' in sdk/ first." >&2
    exit 1
fi

if [ ! -f "$SYSROOT/lib/libc.a" ]; then
    echo "ERROR: sysroot not found. Run: bash scripts/build-musl.sh" >&2
    exit 1
fi

export WASM_POSIX_SYSROOT="$SYSROOT"
export WASM_POSIX_GLUE_DIR="$REPO_ROOT/libc/glue"

if [ ! -d "$SRC_DIR" ]; then
    echo "==> Downloading GNU Netcat $NETCAT_VERSION..."
    TARBALL="netcat-${NETCAT_VERSION}.tar.gz"
    URL="https://downloads.sourceforge.net/project/netcat/netcat/${NETCAT_VERSION}/${TARBALL}"
    curl --retry 10 --retry-delay 5 --retry-max-time 300 --retry-all-errors -fsSL "$URL" -o "/tmp/$TARBALL"
    mkdir -p "$SRC_DIR"
    tar xzf "/tmp/$TARBALL" -C "$SRC_DIR" --strip-components=1
    rm "/tmp/$TARBALL"
fi

cd "$SRC_DIR"

PATCH_MARKER="$SRC_DIR/.kandelo-patches-applied"
PATCH_SET=(
    "listen-success-exit.patch"
    "udp-listen-single-socket.patch"
    "disable-pktinfo.patch"
)
echo "==> Verifying Kandelo netcat portability patches..."

if awk '
    /if \(netcat_mode == NETCAT_LISTEN\)/ { in_listen = 1; next }
    in_listen && /glob_ret = EXIT_SUCCESS;/ { ok = 1; exit }
    in_listen && /if \(opt_exec\)/ { exit }
    END { exit ok ? 0 : 1 }
' src/netcat.c; then
    echo "    listen-success-exit.patch already applied"
else
    patch --batch -p1 < "$SCRIPT_DIR/patches/listen-success-exit.patch"
fi

udp_marker_count=$(grep -c "Kandelo exposes normal POSIX UDP sockets" src/core.c || true)
case "$udp_marker_count" in
    0) patch --batch -p1 < "$SCRIPT_DIR/patches/udp-listen-single-socket.patch" ;;
    1) echo "    udp-listen-single-socket.patch already applied" ;;
    *) echo "ERROR: udp-listen-single-socket.patch marker count is $udp_marker_count, expected 0 or 1" >&2; exit 1 ;;
esac

if grep -q "/\\* #  define USE_PKTINFO \\*/" src/netcat.h; then
    echo "    disable-pktinfo.patch already applied"
else
    patch --batch -p1 < "$SCRIPT_DIR/patches/disable-pktinfo.patch"
fi

printf '%s\n' "${PATCH_SET[*]}" > "$PATCH_MARKER"

if ! awk '
    /if \(netcat_mode == NETCAT_LISTEN\)/ { in_listen = 1; next }
    in_listen && /glob_ret = EXIT_SUCCESS;/ { ok = 1; exit }
    in_listen && /if \(opt_exec\)/ { exit }
    END { exit ok ? 0 : 1 }
' src/netcat.c; then
    echo "ERROR: listen-success-exit.patch is missing from src/netcat.c" >&2
    exit 1
fi

udp_marker_count=$(grep -c "Kandelo exposes normal POSIX UDP sockets" src/core.c || true)
if [ "$udp_marker_count" -ne 1 ]; then
    echo "ERROR: udp-listen-single-socket.patch marker count is $udp_marker_count, expected 1" >&2
    exit 1
fi

if ! grep -q "/\\* #  define USE_PKTINFO \\*/" src/netcat.h; then
    echo "ERROR: disable-pktinfo.patch is missing from src/netcat.h" >&2
    exit 1
fi

if [ ! -f Makefile ]; then
    echo "==> Configuring GNU Netcat for wasm32..."
    export ac_cv_func_malloc_0_nonnull=yes
    export ac_cv_func_realloc_0_nonnull=yes
    export ac_cv_func_gethostbyname=yes
    export ac_cv_func_getservbyname=yes
    export ac_cv_func_getaddrinfo=yes
    export ac_cv_func_inet_pton=yes
    export ac_cv_func_select=yes
    export ac_cv_header_resolv_h=no
    export ac_cv_lib_resolv_main=no
    export gl_cv_func_gettimeofday_clobber=no

    wasm32posix-configure \
        --build=arm-apple-darwin \
        --disable-nls \
        --without-included-gettext \
        2>&1 | tail -40
fi

echo "==> Building GNU Netcat..."
rm -f "$SRC_DIR/src/netcat" "$SRC_DIR/src/"*.o
make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" 2>&1 | tail -30

NETCAT_BIN="$SRC_DIR/src/netcat"
if [ ! -f "$NETCAT_BIN" ]; then
    echo "ERROR: netcat binary not found after build" >&2
    exit 1
fi

echo "==> Applying fork instrumentation metadata..."
FORK_INSTRUMENT="$REPO_ROOT/scripts/run-wasm-fork-instrument.sh"
"$FORK_INSTRUMENT" "$NETCAT_BIN" -o "$NETCAT_BIN.instr"
mv "$NETCAT_BIN.instr" "$NETCAT_BIN"

mkdir -p "$BIN_DIR"
cp "$NETCAT_BIN" "$BIN_DIR/nc.wasm"

source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary netcat "$BIN_DIR/nc.wasm"

ls -lh "$BIN_DIR/nc.wasm"
