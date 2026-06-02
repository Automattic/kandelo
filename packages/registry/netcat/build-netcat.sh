#!/usr/bin/env bash
set -euo pipefail

# Build GNU Netcat 0.7.1 for wasm32-posix-kernel.

NETCAT_VERSION="${NETCAT_VERSION:-0.7.1}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SRC_DIR="$SCRIPT_DIR/netcat-src"
BIN_DIR="$SCRIPT_DIR/bin"
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
if [ "$(cat "$PATCH_MARKER" 2>/dev/null || true)" != "${PATCH_SET[*]}" ]; then
    echo "==> Applying Kandelo netcat portability patches..."
    for patch_name in "${PATCH_SET[@]}"; do
        patch_file="$SCRIPT_DIR/patches/$patch_name"
        if patch --forward --dry-run -p1 < "$patch_file" >/dev/null 2>&1; then
            patch -p1 < "$patch_file"
        else
            echo "    $patch_name already applied"
        fi
    done
    printf '%s\n' "${PATCH_SET[*]}" > "$PATCH_MARKER"
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
