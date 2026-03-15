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

REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SYSROOT="$REPO_ROOT/sysroot"
export WASM_POSIX_SYSROOT="$SYSROOT"
SQLITE_DIR="$SCRIPT_DIR/../sqlite/sqlite-install"

# Build SQLite if not already built
if [ ! -f "$SQLITE_DIR/lib/libsqlite3.a" ]; then
    echo "==> Building SQLite..."
    bash "$SCRIPT_DIR/../sqlite/build-sqlite.sh"
fi

# Install SQLite into sysroot so pkg-config can find it
echo "==> Installing SQLite into sysroot..."
cp "$SQLITE_DIR/include/sqlite3.h" "$SQLITE_DIR/include/sqlite3ext.h" "$SYSROOT/include/"
cp "$SQLITE_DIR/lib/libsqlite3.a" "$SYSROOT/lib/"
mkdir -p "$SYSROOT/lib/pkgconfig"
sed "s|^prefix=.*|prefix=$SYSROOT|" "$SQLITE_DIR/lib/pkgconfig/sqlite3.pc" \
    > "$SYSROOT/lib/pkgconfig/sqlite3.pc"

# Build zlib if not already built
ZLIB_DIR="$SCRIPT_DIR/../zlib/zlib-install"
if [ ! -f "$ZLIB_DIR/lib/libz.a" ]; then
    echo "==> Building zlib..."
    bash "$SCRIPT_DIR/../zlib/build-zlib.sh"
fi

# Install zlib into sysroot
echo "==> Installing zlib into sysroot..."
cp "$ZLIB_DIR/include/zlib.h" "$ZLIB_DIR/include/zconf.h" "$SYSROOT/include/"
cp "$ZLIB_DIR/lib/libz.a" "$SYSROOT/lib/"
mkdir -p "$SYSROOT/lib/pkgconfig"
sed "s|^prefix=.*|prefix=$SYSROOT|" "$ZLIB_DIR/lib/pkgconfig/zlib.pc" \
    > "$SYSROOT/lib/pkgconfig/zlib.pc"

# Build OpenSSL if not already built
OPENSSL_DIR="$SCRIPT_DIR/../openssl/openssl-install"
if [ ! -f "$OPENSSL_DIR/lib/libssl.a" ]; then
    echo "==> Building OpenSSL..."
    bash "$SCRIPT_DIR/../openssl/build-openssl.sh"
fi

# Install OpenSSL into sysroot
echo "==> Installing OpenSSL into sysroot..."
cp -r "$OPENSSL_DIR/include/openssl" "$SYSROOT/include/"
cp "$OPENSSL_DIR/lib/libssl.a" "$OPENSSL_DIR/lib/libcrypto.a" "$SYSROOT/lib/"
mkdir -p "$SYSROOT/lib/pkgconfig"
for pc in openssl.pc libssl.pc libcrypto.pc; do
    if [ -f "$OPENSSL_DIR/lib/pkgconfig/$pc" ]; then
        sed "s|^prefix=.*|prefix=$SYSROOT|" "$OPENSSL_DIR/lib/pkgconfig/$pc" \
            > "$SYSROOT/lib/pkgconfig/$pc"
    fi
done

# Build libxml2 if not already built
LIBXML2_DIR="$SCRIPT_DIR/../libxml2/libxml2-install"
if [ ! -f "$LIBXML2_DIR/lib/libxml2.a" ]; then
    echo "==> Building libxml2..."
    bash "$SCRIPT_DIR/../libxml2/build-libxml2.sh"
fi

# Install libxml2 into sysroot
echo "==> Installing libxml2 into sysroot..."
cp -r "$LIBXML2_DIR/include/libxml" "$SYSROOT/include/"
cp "$LIBXML2_DIR/lib/libxml2.a" "$SYSROOT/lib/"
mkdir -p "$SYSROOT/lib/pkgconfig"
sed "s|^prefix=.*|prefix=$SYSROOT|" "$LIBXML2_DIR/lib/pkgconfig/libxml-2.0.pc" \
    > "$SYSROOT/lib/pkgconfig/libxml-2.0.pc"

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
        --enable-session \
        --with-sqlite3 \
        --enable-pdo \
        --with-pdo-sqlite \
        --enable-fileinfo \
        --enable-exif \
        --with-zlib \
        --with-openssl \
        --with-libxml \
        --enable-xml \
        --enable-dom \
        --enable-simplexml \
        --enable-xmlreader \
        --enable-xmlwriter \
        --cache-file="$SCRIPT_DIR/config.cache" \
        --prefix="$INSTALL_DIR" \
        CFLAGS="-O2 -DZEND_USE_ASM_ARITHMETIC=0"

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
        -e 's/^#define HAVE_RAND_EGD 1/\/* #undef HAVE_RAND_EGD *\//' \
        main/php_config.h && rm -f main/php_config.h.bak

    # Remove -MMD/-MF/-MT dependency tracking flags from Makefile.
    # libtool doesn't understand these flags and misidentifies the source file,
    # causing "mv: rename foo.o" errors during compilation.
    echo "==> Patching Makefile to remove dependency tracking flags..."
    sed -i.bak \
        -e 's/ -MMD -MF [^ ]* -MT [^ ]*//g' \
        Makefile && rm -f Makefile.bak
fi

echo "==> Building PHP..."
make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" cli

echo "==> PHP CLI built successfully!"
ls -la sapi/cli/php
