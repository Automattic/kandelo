#!/usr/bin/env bash
#
# Build PHP for the WordPress example.
# Minimal build: SQLite + essential WordPress extensions.
# Skips OpenSSL and libxml2 (not needed for local SQLite WordPress).
#
set -euo pipefail

PHP_VERSION="${PHP_VERSION:-8.3.15}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Reuse PHP source from the main PHP example
PHP_EXAMPLE_DIR="$REPO_ROOT/examples/libs/php"
SRC_DIR="$PHP_EXAMPLE_DIR/php-src"
PHP_BINARY="$SRC_DIR/sapi/cli/php"

# If PHP is already built, done
if [ -f "$PHP_BINARY" ]; then
    echo "==> PHP already built at $PHP_BINARY"
    exit 0
fi

if ! command -v wasm32posix-cc &>/dev/null; then
    echo "ERROR: wasm32posix-cc not found. Run 'npm link' in sdk/ first." >&2
    exit 1
fi

SYSROOT="$REPO_ROOT/sysroot"
export WASM_POSIX_SYSROOT="$SYSROOT"

# Build SQLite if not already built
SQLITE_DIR="$REPO_ROOT/examples/libs/sqlite/sqlite-install"
if [ ! -f "$SQLITE_DIR/lib/libsqlite3.a" ]; then
    echo "==> Building SQLite..."
    bash "$REPO_ROOT/examples/libs/sqlite/build-sqlite.sh"
fi

# Install SQLite into sysroot
echo "==> Installing SQLite into sysroot..."
cp "$SQLITE_DIR/include/sqlite3.h" "$SQLITE_DIR/include/sqlite3ext.h" "$SYSROOT/include/"
cp "$SQLITE_DIR/lib/libsqlite3.a" "$SYSROOT/lib/"
mkdir -p "$SYSROOT/lib/pkgconfig"
sed "s|^prefix=.*|prefix=$SYSROOT|" "$SQLITE_DIR/lib/pkgconfig/sqlite3.pc" \
    > "$SYSROOT/lib/pkgconfig/sqlite3.pc"

# Build zlib if not already built
ZLIB_DIR="$REPO_ROOT/examples/libs/zlib/zlib-install"
if [ ! -f "$ZLIB_DIR/lib/libz.a" ]; then
    echo "==> Building zlib..."
    bash "$REPO_ROOT/examples/libs/zlib/build-zlib.sh"
fi

# Install zlib into sysroot
echo "==> Installing zlib into sysroot..."
cp "$ZLIB_DIR/include/zlib.h" "$ZLIB_DIR/include/zconf.h" "$SYSROOT/include/"
cp "$ZLIB_DIR/lib/libz.a" "$SYSROOT/lib/"
mkdir -p "$SYSROOT/lib/pkgconfig"
sed "s|^prefix=.*|prefix=$SYSROOT|" "$ZLIB_DIR/lib/pkgconfig/zlib.pc" \
    > "$SYSROOT/lib/pkgconfig/zlib.pc"

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
echo "==> Patching PHP for Wasm..."
if ! grep -q 'ZEND_USE_ASM_ARITHMETIC 0' Zend/zend_multiply.h 2>/dev/null; then
    if [ -f Zend/zend_multiply.h ]; then
        sed -i.bak '1i\
#define ZEND_USE_ASM_ARITHMETIC 0
' Zend/zend_multiply.h && rm -f Zend/zend_multiply.h.bak
    fi
fi

echo "==> Configuring PHP for Wasm (minimal WordPress build)..."
if [ ! -f Makefile ]; then
    wasm32posix-configure \
        --disable-all \
        --disable-cgi \
        --disable-phpdbg \
        --enable-cli \
        --enable-mbstring \
        --disable-mbregex \
        --enable-ctype \
        --enable-tokenizer \
        --enable-filter \
        --enable-phar \
        --without-valgrind \
        --without-pcre-jit \
        --disable-fiber-asm \
        --disable-zend-signals \
        --enable-session \
        --with-sqlite3 \
        --enable-pdo \
        --with-pdo-sqlite \
        --enable-fileinfo \
        --enable-exif \
        --with-zlib \
        --cache-file="$PHP_EXAMPLE_DIR/config.cache" \
        --prefix="$SRC_DIR/../php-install" \
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
        -e 's/^#define HAVE_PRCTL 1/\/* #undef HAVE_PRCTL *\//' \
        main/php_config.h && rm -f main/php_config.h.bak

    # Remove dependency tracking flags that confuse libtool
    echo "==> Patching Makefile to remove dependency tracking flags..."
    sed -i.bak \
        -e 's/ -MMD -MF [^ ]* -MT [^ ]*//g' \
        Makefile && rm -f Makefile.bak
fi

echo "==> Building PHP..."
make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" cli

echo "==> PHP CLI built successfully!"
ls -la sapi/cli/php
