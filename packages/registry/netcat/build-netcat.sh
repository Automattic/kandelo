#!/usr/bin/env bash
set -euo pipefail

# Build GNU Netcat 0.7.1 for wasm32-posix-kernel.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
NETCAT_VERSION="${WASM_POSIX_DEP_VERSION:-${NETCAT_VERSION:-0.7.1}}"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://downloads.sourceforge.net/project/netcat/netcat/${NETCAT_VERSION}/netcat-${NETCAT_VERSION}.tar.gz}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-30719c9a4ffbcf15676b8f528233ccc54ee6cba96cb4590975f5fd60c68a066f}"
TARGET_ARCH="${WASM_POSIX_DEP_TARGET_ARCH:-wasm32}"
WORK_DIR="${WASM_POSIX_DEP_WORK_DIR:-$SCRIPT_DIR}"
SRC_DIR="$WORK_DIR/netcat-src"
BIN_DIR="$WORK_DIR/bin"
SYSROOT="${WASM_POSIX_SYSROOT:-$REPO_ROOT/sysroot}"

# Worktree-local SDK on PATH (no global npm link required).
# shellcheck source=/dev/null
source "$REPO_ROOT/sdk/activate.sh"

if [ "$TARGET_ARCH" != "wasm32" ]; then
    echo "ERROR: GNU Netcat is currently packaged for wasm32 only, got $TARGET_ARCH" >&2
    exit 2
fi

if ! command -v wasm32posix-cc &>/dev/null; then
    echo "ERROR: wasm32posix-cc not found after sourcing sdk/activate.sh." >&2
    exit 1
fi

if [ ! -f "$SYSROOT/lib/libc.a" ]; then
    echo "ERROR: sysroot not found. Run: bash scripts/build-musl.sh" >&2
    exit 1
fi

export WASM_POSIX_SYSROOT="$SYSROOT"
export WASM_POSIX_GLUE_DIR="$REPO_ROOT/libc/glue"

SOURCE_MARKER="$SRC_DIR/.kandelo-netcat-source"
expected_source_marker="$(printf '%s\n%s\n%s' "$NETCAT_VERSION" "$SOURCE_URL" "$SOURCE_SHA256")"
if [ -d "$SRC_DIR" ] && [ "$(cat "$SOURCE_MARKER" 2>/dev/null || true)" != "$expected_source_marker" ]; then
    echo "==> Existing GNU Netcat source does not match requested version/source; cleaning..."
    rm -rf "$SRC_DIR" "$BIN_DIR"
fi

if [ ! -d "$SRC_DIR" ]; then
    echo "==> Downloading GNU Netcat $NETCAT_VERSION..."
    DOWNLOAD_DIR="$(mktemp -d "${TMPDIR:-/tmp}/kandelo-netcat-src.XXXXXX")"
    trap 'rm -rf "$DOWNLOAD_DIR"' EXIT
    TARBALL="netcat-${NETCAT_VERSION}.tar.gz"
    curl --retry 10 --retry-delay 5 --retry-max-time 300 --retry-all-errors -fsSL "$SOURCE_URL" -o "$DOWNLOAD_DIR/$TARBALL"
    echo "==> Verifying source sha256..."
    echo "$SOURCE_SHA256  $DOWNLOAD_DIR/$TARBALL" | shasum -a 256 -c -
    mkdir -p "$SRC_DIR"
    tar xzf "$DOWNLOAD_DIR/$TARBALL" -C "$SRC_DIR" --strip-components=1
    printf '%s\n' "$expected_source_marker" > "$SOURCE_MARKER"
    trap - EXIT
    rm -rf "$DOWNLOAD_DIR"
fi

cd "$SRC_DIR"

PATCH_MARKER="$SRC_DIR/.kandelo-patches-applied"
PATCH_SET=(
    "listen-success-exit.patch"
    "udp-listen-single-socket.patch"
    "disable-pktinfo.patch"
    "disable-abortive-linger.patch"
)
echo "==> Verifying Kandelo netcat portability patches..."
for patch_name in "${PATCH_SET[@]}"; do
    patch_file="$SCRIPT_DIR/patches/$patch_name"
    if patch --reverse --dry-run -p1 < "$patch_file" >/dev/null 2>&1; then
        echo "    $patch_name already applied"
    elif patch --forward --dry-run -p1 < "$patch_file" >/dev/null 2>&1; then
        patch -p1 < "$patch_file"
    else
        echo "ERROR: $patch_name does not apply and is not already present" >&2
        exit 1
    fi
done
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

if ! grep -q "Kandelo cannot yet model abortive SO_LINGER" src/network.c; then
    echo "ERROR: disable-abortive-linger.patch is missing from src/network.c" >&2
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
(cd "$REPO_ROOT" && "$FORK_INSTRUMENT" "$NETCAT_BIN" -o "$NETCAT_BIN.instr")
mv "$NETCAT_BIN.instr" "$NETCAT_BIN"

mkdir -p "$BIN_DIR"
cp "$NETCAT_BIN" "$BIN_DIR/nc.wasm"

if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    # Resolver builds must publish only into the resolver-owned output
    # directory. Apply the same artifact guards as install_local_binary without
    # writing a local-binaries override into the source worktree.
    # shellcheck source=/dev/null
    source "$REPO_ROOT/scripts/wasm-artifact-guards.sh"
    if ! wasm_is_binary "$BIN_DIR/nc.wasm"; then
        echo "ERROR: refusing non-Wasm netcat artifact: $BIN_DIR/nc.wasm" >&2
        exit 1
    fi
    wasm_require_no_legacy_asyncify "$BIN_DIR/nc.wasm"
    wasm_require_fork_instrumentation_if_needed "$BIN_DIR/nc.wasm"
    mkdir -p "$WASM_POSIX_DEP_OUT_DIR"
    cp "$BIN_DIR/nc.wasm" "$WASM_POSIX_DEP_OUT_DIR/nc.wasm"
    echo "  installed $WASM_POSIX_DEP_OUT_DIR/nc.wasm (resolver scratch)"
else
    # Direct developer builds retain the normal local resolver override.
    # shellcheck source=/dev/null
    source "$REPO_ROOT/scripts/install-local-binary.sh"
    install_local_binary netcat "$BIN_DIR/nc.wasm"
fi

ls -lh "$BIN_DIR/nc.wasm"
