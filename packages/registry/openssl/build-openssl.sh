#!/usr/bin/env bash
#
# Build OpenSSL static libs (libssl.a, libcrypto.a) for
# wasm32-posix-kernel.
#
# Honors the dep-resolver build-script contract (see
# docs/dependency-management.md). Falls back to the in-tree
# openssl-install/ layout when invoked without resolver env vars.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

# shellcheck source=/dev/null
source "$REPO_ROOT/sdk/activate.sh"

# --- Resolver contract (with legacy fallbacks) ---
OPENSSL_VERSION="${WASM_POSIX_DEP_VERSION:-${OPENSSL_VERSION:-3.3.2}}"
INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:-$SCRIPT_DIR/openssl-install}"
WORK_DIR="${WASM_POSIX_DEP_WORK_DIR:-$SCRIPT_DIR}"
TARGET_ARCH="${WASM_POSIX_DEP_TARGET_ARCH:-wasm32}"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://github.com/openssl/openssl/releases/download/openssl-${OPENSSL_VERSION}/openssl-${OPENSSL_VERSION}.tar.gz}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-}"

case "$TARGET_ARCH" in
    wasm32)
        TOOL_PREFIX="wasm32posix"
        OPENSSL_TARGET="linux-generic32"
        SYSROOT="${WASM_POSIX_SYSROOT:-$REPO_ROOT/sysroot}"
        ;;
    wasm64)
        TOOL_PREFIX="wasm64posix"
        OPENSSL_TARGET="linux-generic64"
        SYSROOT="${WASM_POSIX_SYSROOT:-$REPO_ROOT/sysroot64}"
        ;;
    *)
        echo "ERROR: unsupported WASM_POSIX_DEP_TARGET_ARCH=$TARGET_ARCH" >&2
        exit 2
        ;;
esac

CC="${TOOL_PREFIX}-cc"
AR="${TOOL_PREFIX}-ar"
RANLIB="${TOOL_PREFIX}-ranlib"
SRC_DIR="$WORK_DIR/openssl-src-$TARGET_ARCH"
SOURCE_MARKER="$SRC_DIR/.kandelo-openssl-source"
export WASM_POSIX_SYSROOT="$SYSROOT"

if ! command -v "$CC" &>/dev/null; then
    echo "ERROR: $CC not found after sourcing sdk/activate.sh." >&2
    exit 1
fi

if [ ! -f "$SYSROOT/lib/libc.a" ]; then
    echo "ERROR: sysroot not found at $SYSROOT. Run scripts/build-musl.sh for $TARGET_ARCH first." >&2
    exit 1
fi

# --- Fetch + verify source ---
expected_marker="$(printf '%s\n%s\n%s\n' "$OPENSSL_VERSION" "$SOURCE_URL" "$SOURCE_SHA256")"
if [ -d "$SRC_DIR" ] && [ "$(cat "$SOURCE_MARKER" 2>/dev/null || true)" != "$expected_marker" ]; then
    echo "==> Existing OpenSSL source does not match requested version/source; cleaning..."
    rm -rf "$SRC_DIR"
fi

if [ ! -d "$SRC_DIR" ]; then
    echo "==> Downloading OpenSSL $OPENSSL_VERSION..."
    tmpdir="$(mktemp -d "${TMPDIR:-/tmp}/kandelo-openssl-src.XXXXXX")"
    trap 'rm -rf "$tmpdir"' EXIT
    TARBALL="$tmpdir/openssl-${OPENSSL_VERSION}.tar.gz"
    curl --retry 10 --retry-delay 5 --retry-max-time 300 --retry-all-errors -fsSL "$SOURCE_URL" -o "$TARBALL"
    if [ -n "$SOURCE_SHA256" ]; then
        echo "==> Verifying source sha256..."
        echo "$SOURCE_SHA256  $TARBALL" | shasum -a 256 -c -
    fi
    mkdir -p "$SRC_DIR"
    tar xzf "$TARBALL" -C "$SRC_DIR" --strip-components=1
    printf '%s\n' "$expected_marker" > "$SOURCE_MARKER"
    trap - EXIT
    rm -rf "$tmpdir"
fi

cd "$SRC_DIR"

# Clean previous build so a cache-miss rebuild starts from scratch.
if [ -f Makefile ]; then
    make clean 2>/dev/null || true
fi
rm -rf "$INSTALL_DIR"

# Configure for Wasm using OpenSSL's generic Linux targets. The SDK
# wrapper supplies the actual wasm target triple.
echo "==> Configuring OpenSSL for $TARGET_ARCH..."
CC="$CC" \
AR="$AR" \
RANLIB="$RANLIB" \
perl Configure "$OPENSSL_TARGET" \
    -DHAVE_FORK=0 \
    -DOPENSSL_NO_AFALGENG=1 \
    -DOPENSSL_NO_UI_CONSOLE=1 \
    -DNO_SYSLOG=1 \
    no-asm \
    no-threads \
    no-dso \
    no-shared \
    no-async \
    no-engine \
    no-afalgeng \
    no-ui-console \
    no-tests \
    no-apps \
    no-autoerrinit \
    no-posix-io \
    --prefix="$INSTALL_DIR" \
    --openssldir=/etc/ssl

# Patch Makefile: remove cross-compile prefix and host-only -m32/-m64
# switches that the linux-generic* targets assume.
echo "==> Patching Makefile..."
sed -i.bak 's/^CROSS_COMPILE=.*/CROSS_COMPILE=/' Makefile
sed -i.bak 's/ -m32 / /g' Makefile
sed -i.bak 's/ -m32$//' Makefile
sed -i.bak 's/ -m64 / /g' Makefile
sed -i.bak 's/ -m64$//' Makefile
rm -f Makefile.bak

NPROC="$(nproc 2>/dev/null || sysctl -n hw.ncpu)"

echo "==> Generating OpenSSL build headers..."
make -j"$NPROC" build_generated

echo "==> Building OpenSSL..."
make -j"$NPROC" libssl.a libcrypto.a

echo "==> Installing..."
make install_sw 2>/dev/null || true

# OpenSSL installs into lib/ on 32-bit targets and lib64/ on some
# 64-bit Linux hosts. The resolver contract pins outputs under lib/,
# so if install landed in lib64/ we merge it across.
if [ -d "$INSTALL_DIR/lib64" ] && [ ! -d "$INSTALL_DIR/lib" ]; then
    mv "$INSTALL_DIR/lib64" "$INSTALL_DIR/lib"
elif [ -d "$INSTALL_DIR/lib64" ]; then
    # Both exist — splice lib64's contents into lib/.
    cp -a "$INSTALL_DIR/lib64/." "$INSTALL_DIR/lib/"
    rm -rf "$INSTALL_DIR/lib64"
fi

if [ -f "$INSTALL_DIR/lib/libssl.a" ] && [ -f "$INSTALL_DIR/lib/libcrypto.a" ]; then
    echo "==> OpenSSL build complete!"
    echo "    Headers:   $INSTALL_DIR/include/openssl/"
    echo "    libssl:    $INSTALL_DIR/lib/libssl.a"
    echo "    libcrypto: $INSTALL_DIR/lib/libcrypto.a"
    ls -lh "$INSTALL_DIR/lib/libssl.a" "$INSTALL_DIR/lib/libcrypto.a"
else
    echo "ERROR: Build failed — libraries not found at expected paths" >&2
    find "$INSTALL_DIR" -name "*.a" 2>/dev/null || true
    exit 1
fi
