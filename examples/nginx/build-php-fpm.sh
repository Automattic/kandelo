#!/usr/bin/env bash
set -euo pipefail

PHP_VERSION="${PHP_VERSION:-8.3.15}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# FPM gets its own source dir to avoid interfering with the CLI build
SRC_DIR="$SCRIPT_DIR/php-fpm-src"
SYSROOT="$REPO_ROOT/sysroot"
export WASM_POSIX_SYSROOT="$SYSROOT"

if ! command -v wasm32posix-cc &>/dev/null; then
    echo "ERROR: wasm32posix-cc not found. Run 'npm link' in sdk/ first." >&2
    exit 1
fi

# Build shared PHP dependencies if not already present in sysroot
LIBS_DIR="$REPO_ROOT/examples/libs"

# SQLite
if [ ! -f "$SYSROOT/lib/libsqlite3.a" ]; then
    echo "==> Building SQLite..."
    bash "$LIBS_DIR/sqlite/build-sqlite.sh"
    SQLITE_DIR="$LIBS_DIR/sqlite/sqlite-install"
    cp "$SQLITE_DIR/include/sqlite3.h" "$SQLITE_DIR/include/sqlite3ext.h" "$SYSROOT/include/"
    cp "$SQLITE_DIR/lib/libsqlite3.a" "$SYSROOT/lib/"
    mkdir -p "$SYSROOT/lib/pkgconfig"
    sed "s|^prefix=.*|prefix=$SYSROOT|" "$SQLITE_DIR/lib/pkgconfig/sqlite3.pc" \
        > "$SYSROOT/lib/pkgconfig/sqlite3.pc"
fi

# zlib
if [ ! -f "$SYSROOT/lib/libz.a" ]; then
    echo "==> Building zlib..."
    bash "$LIBS_DIR/zlib/build-zlib.sh"
    ZLIB_DIR="$LIBS_DIR/zlib/zlib-install"
    cp "$ZLIB_DIR/include/zlib.h" "$ZLIB_DIR/include/zconf.h" "$SYSROOT/include/"
    cp "$ZLIB_DIR/lib/libz.a" "$SYSROOT/lib/"
fi

# OpenSSL
if [ ! -f "$SYSROOT/lib/libssl.a" ]; then
    echo "==> Building OpenSSL..."
    bash "$LIBS_DIR/openssl/build-openssl.sh"
    OPENSSL_DIR="$LIBS_DIR/openssl/openssl-install"
    cp -r "$OPENSSL_DIR/include/openssl" "$SYSROOT/include/"
    cp "$OPENSSL_DIR/lib/libssl.a" "$OPENSSL_DIR/lib/libcrypto.a" "$SYSROOT/lib/"
fi

# libxml2
if [ ! -f "$SYSROOT/lib/libxml2.a" ]; then
    echo "==> Building libxml2..."
    bash "$LIBS_DIR/libxml2/build-libxml2.sh"
    LIBXML2_DIR="$LIBS_DIR/libxml2/libxml2-install"
    cp -r "$LIBXML2_DIR/include/libxml" "$SYSROOT/include/"
    cp "$LIBXML2_DIR/lib/libxml2.a" "$SYSROOT/lib/"
fi

# Download PHP source
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Downloading PHP $PHP_VERSION..."
    TARBALL="php-${PHP_VERSION}.tar.gz"
    curl -fsSL "https://www.php.net/distributions/${TARBALL}" -o "/tmp/${TARBALL}"
    mkdir -p "$SRC_DIR"
    tar xzf "/tmp/${TARBALL}" -C "$SRC_DIR" --strip-components=1
    rm "/tmp/${TARBALL}"
fi

cd "$SRC_DIR"

# Patch for Wasm compatibility
echo "==> Patching PHP-FPM for Wasm..."
if ! grep -q 'ZEND_USE_ASM_ARITHMETIC 0' Zend/zend_multiply.h 2>/dev/null; then
    if [ -f Zend/zend_multiply.h ]; then
        sed -i.bak '1i\
#define ZEND_USE_ASM_ARITHMETIC 0
' Zend/zend_multiply.h && rm -f Zend/zend_multiply.h.bak
    fi
fi

echo "==> Configuring PHP-FPM for Wasm..."
if [ ! -f Makefile ]; then
    wasm32posix-configure \
        --disable-all \
        --disable-cgi \
        --disable-phpdbg \
        --disable-cli \
        --enable-fpm \
        --enable-mbstring \
        --disable-mbregex \
        --enable-ctype \
        --enable-tokenizer \
        --enable-filter \
        --without-valgrind \
        --without-pcre-jit \
        --disable-fiber-asm \
        --disable-zend-signals \
        --enable-session \
        --with-sqlite3 \
        --enable-pdo \
        --with-pdo-sqlite \
        --with-pdo-mysql=mysqlnd \
        --with-mysqli=mysqlnd \
        --with-zlib \
        --with-openssl \
        --with-libxml \
        --enable-xml \
        --enable-dom \
        --enable-simplexml \
        --enable-xmlreader \
        --enable-xmlwriter \
        --cache-file="$SCRIPT_DIR/php-fpm-config.cache" \
        --prefix="/usr/local/php" \
        CFLAGS="-O2 -DZEND_USE_ASM_ARITHMETIC=0"

    # Patch config.h
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
        -e 's/^#define HAVE_SETPROCTITLE_FAST 1/\/* #undef HAVE_SETPROCTITLE_FAST *\//' \
        -e 's/^#define HAVE_PRCTL 1/\/* #undef HAVE_PRCTL *\//' \
        -e 's/^#define HAVE_RAND_EGD 1/\/* #undef HAVE_RAND_EGD *\//' \
        main/php_config.h && rm -f main/php_config.h.bak

    # Remove dependency tracking flags
    echo "==> Patching Makefile..."
    sed -i.bak \
        -e 's/ -MMD -MF [^ ]* -MT [^ ]*//g' \
        Makefile && rm -f Makefile.bak
fi

echo "==> Building PHP-FPM..."
make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" fpm

# Copy FPM binary
cp sapi/fpm/php-fpm "$SCRIPT_DIR/php-fpm.wasm"

# Asyncify for fork support (FPM forks worker children)
WASM_OPT="$(command -v wasm-opt 2>/dev/null || true)"
if [ -n "$WASM_OPT" ]; then
    echo "==> Applying asyncify instrumentation..."
    "$WASM_OPT" --asyncify \
        --pass-arg="asyncify-imports@kernel.kernel_fork" \
        "$SCRIPT_DIR/php-fpm.wasm" -o "$SCRIPT_DIR/php-fpm.wasm"
fi

echo "==> PHP-FPM built successfully!"
ls -la "$SCRIPT_DIR/php-fpm.wasm"
