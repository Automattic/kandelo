#!/usr/bin/env bash
set -euo pipefail

PHP_VERSION="${PHP_VERSION:-8.3.15}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_DIR="$SCRIPT_DIR/php-src"
INSTALL_DIR="$SCRIPT_DIR/php-install"

if ! command -v wasm32posix-cc &>/dev/null; then
    echo "ERROR: wasm32posix-cc not found. Run 'npm link' in sdk/ first." >&2
    exit 1
fi

if [ ! -d "$SRC_DIR" ]; then
    echo "==> Downloading PHP $PHP_VERSION..."
    TARBALL="php-${PHP_VERSION}.tar.gz"
    curl -fsSL "https://www.php.net/distributions/${TARBALL}" -o "/tmp/${TARBALL}"
    mkdir -p "$SRC_DIR"
    tar xzf "/tmp/${TARBALL}" -C "$SRC_DIR" --strip-components=1
    rm "/tmp/${TARBALL}"
fi

cd "$SRC_DIR"

# Apply patches for Wasm compatibility
echo "==> Patching PHP for Wasm..."

# Disable inline assembly in Zend (safety net — Wasm doesn't match arch guards anyway)
if ! grep -q 'ZEND_USE_ASM_ARITHMETIC 0' Zend/zend_multiply.h 2>/dev/null; then
    if [ -f Zend/zend_multiply.h ]; then
        sed -i.bak '1i\
#define ZEND_USE_ASM_ARITHMETIC 0
' Zend/zend_multiply.h && rm -f Zend/zend_multiply.h.bak
    fi
fi

echo "==> Configuring PHP for Wasm..."
if [ ! -f Makefile ]; then
    wasm32posix-configure \
        --disable-all \
        --disable-cgi \
        --disable-phpdbg \
        --enable-cli \
        --without-valgrind \
        --without-pcre-jit \
        --disable-fiber-asm \
        --disable-zend-signals \
        --cache-file="$SCRIPT_DIR/config.cache" \
        --prefix="$INSTALL_DIR" \
        CFLAGS="-DZEND_USE_ASM_ARITHMETIC=0"

    # Patch config.h: disable features that pass link-time checks (--allow-undefined)
    # but don't actually exist in our musl sysroot
    echo "==> Patching main/php_config.h for Wasm..."
    sed -i.bak \
        -e 's/^#define HAVE_DNS_SEARCH 1/\/* #undef HAVE_DNS_SEARCH *\//' \
        -e 's/^#define HAVE_DNS_SEARCH_FUNC 1/\/* #undef HAVE_DNS_SEARCH_FUNC *\//' \
        -e 's/^#define HAVE_RES_NSEARCH 1/\/* #undef HAVE_RES_NSEARCH *\//' \
        -e 's/^#define HAVE_RES_NDESTROY 1/\/* #undef HAVE_RES_NDESTROY *\//' \
        -e 's/^#define HAVE_DN_EXPAND 1/\/* #undef HAVE_DN_EXPAND *\//' \
        -e 's/^#define HAVE_DN_SKIPNAME 1/\/* #undef HAVE_DN_SKIPNAME *\//' \
        -e 's/^#define HAVE_FOPENCOOKIE 1/\/* #undef HAVE_FOPENCOOKIE *\//' \
        -e 's/^#define HAVE_FUNOPEN 1/\/* #undef HAVE_FUNOPEN *\//' \
        -e 's/^#define HAVE_STD_SYSLOG 1/\/* #undef HAVE_STD_SYSLOG *\//' \
        -e 's/^#define HAVE_SETPROCTITLE 1/\/* #undef HAVE_SETPROCTITLE *\//' \
        -e 's/^#define HAVE_PRCTL 1/\/* #undef HAVE_PRCTL *\//' \
        main/php_config.h && rm -f main/php_config.h.bak
fi

echo "==> Building PHP..."
make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" cli

echo "==> PHP CLI built successfully!"
ls -la sapi/cli/php
