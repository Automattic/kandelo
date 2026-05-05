#!/usr/bin/env bash
set -euo pipefail

# Builds two PHP binaries from one source tree:
#
#   sapi/cli/php        → php.wasm     (CLI; no asyncify)
#   sapi/fpm/php-fpm    → php-fpm.wasm (FastCGI Process Manager;
#                                       asyncified via onlylist for
#                                       fork support)
#
# The two builds were previously separate scripts (this one + the
# now-removed examples/nginx/build-php-fpm.sh). Unifying them lets a
# single autoconf invocation produce both sapis from one source tree
# and one set of patched config.h/Makefile.
#
# CFLAGS/LDFLAGS are set to FPM's stricter requirements (line tables
# preserved, clang's automatic wasm-opt step skipped) because they're
# needed for FPM's asyncify-onlylist to find function names. CLI just
# ships the same way without asyncify on top.

PHP_VERSION="${PHP_VERSION:-8.3.15}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_DIR="$SCRIPT_DIR/php-src"
INSTALL_DIR="$SCRIPT_DIR/php-install"

REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
# Worktree-local SDK on PATH (no global npm link required).
# shellcheck source=/dev/null
source "$REPO_ROOT/sdk/activate.sh"

if ! command -v wasm32posix-cc &>/dev/null; then
    echo "ERROR: wasm32posix-cc not found after sourcing sdk/activate.sh." >&2
    exit 1
fi

SYSROOT="${WASM_POSIX_SYSROOT:-$REPO_ROOT/sysroot}"
export WASM_POSIX_SYSROOT="$SYSROOT"

# --- Resolve cache deps via cargo xtask build-deps ---
HOST_TARGET="$(rustc -vV | awk '/^host/ {print $2}')"
resolve_dep() {
    local name="$1"
    (cd "$REPO_ROOT" && cargo run -p xtask --target "$HOST_TARGET" --quiet -- build-deps resolve "$name")
}

ZLIB_PREFIX="${WASM_POSIX_DEP_ZLIB_DIR:-}"
[ -z "$ZLIB_PREFIX" ] && { echo "==> Resolving zlib..."; ZLIB_PREFIX="$(resolve_dep zlib)"; }
SQLITE_PREFIX="${WASM_POSIX_DEP_SQLITE_DIR:-}"
[ -z "$SQLITE_PREFIX" ] && { echo "==> Resolving sqlite..."; SQLITE_PREFIX="$(resolve_dep sqlite)"; }
OPENSSL_PREFIX="${WASM_POSIX_DEP_OPENSSL_DIR:-}"
[ -z "$OPENSSL_PREFIX" ] && { echo "==> Resolving openssl..."; OPENSSL_PREFIX="$(resolve_dep openssl)"; }
LIBXML2_PREFIX="${WASM_POSIX_DEP_LIBXML2_DIR:-}"
[ -z "$LIBXML2_PREFIX" ] && { echo "==> Resolving libxml2..."; LIBXML2_PREFIX="$(resolve_dep libxml2)"; }
[ -f "$ZLIB_PREFIX/lib/libz.a" ] || { echo "ERROR: zlib resolve missing libz.a"; exit 1; }
[ -f "$SQLITE_PREFIX/lib/libsqlite3.a" ] || { echo "ERROR: sqlite resolve missing libsqlite3.a"; exit 1; }
[ -f "$OPENSSL_PREFIX/lib/libssl.a" ] || { echo "ERROR: openssl resolve missing libssl.a"; exit 1; }
[ -f "$LIBXML2_PREFIX/lib/libxml2.a" ] || { echo "ERROR: libxml2 resolve missing libxml2.a"; exit 1; }
echo "==> zlib at $ZLIB_PREFIX"
echo "==> sqlite at $SQLITE_PREFIX"
echo "==> openssl at $OPENSSL_PREFIX"
echo "==> libxml2 at $LIBXML2_PREFIX"

# Compose PKG_CONFIG_PATH for all 4 deps so wasm32posix-configure's
# pkg-config probes can find them in the cache instead of the sysroot.
DEP_PKG_CONFIG_PATH="$ZLIB_PREFIX/lib/pkgconfig:$SQLITE_PREFIX/lib/pkgconfig:$OPENSSL_PREFIX/lib/pkgconfig:$LIBXML2_PREFIX/lib/pkgconfig"

# Compose -I and -L flags for defense-in-depth (autoconf raw probes).
DEP_CPPFLAGS="-I$ZLIB_PREFIX/include -I$SQLITE_PREFIX/include -I$OPENSSL_PREFIX/include -I$LIBXML2_PREFIX/include"
DEP_LDFLAGS="-L$ZLIB_PREFIX/lib -L$SQLITE_PREFIX/lib -L$OPENSSL_PREFIX/lib -L$LIBXML2_PREFIX/lib"

if [ ! -d "$SRC_DIR" ]; then
    echo "==> Downloading PHP $PHP_VERSION..."
    TARBALL="php-${PHP_VERSION}.tar.gz"
    curl --retry 10 --retry-delay 5 --retry-max-time 300 --retry-all-errors -fsSL "https://www.php.net/distributions/${TARBALL}" -o "/tmp/${TARBALL}"
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

echo "==> Configuring PHP for Wasm (CLI + FPM, single tree)..."
# Drop a stale config.cache from a previous build whose env (CPPFLAGS,
# PKG_CONFIG_PATH, etc.) may not match this run. autoconf would
# otherwise reject the cache with "changes in the environment can
# compromise the build" — recovering requires a fresh cache anyway.
rm -f "$SCRIPT_DIR/config.cache"
if [ ! -f Makefile ]; then
    PKG_CONFIG_PATH="$DEP_PKG_CONFIG_PATH" \
    CPPFLAGS="$DEP_CPPFLAGS" \
    LDFLAGS="$DEP_LDFLAGS --no-wasm-opt" \
    wasm32posix-configure \
        --disable-all \
        --disable-cgi \
        --disable-phpdbg \
        --enable-cli \
        --enable-fpm \
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
        --with-pdo-mysql=mysqlnd \
        --with-mysqli=mysqlnd \
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
        CFLAGS="-O2 -gline-tables-only -DZEND_USE_ASM_ARITHMETIC=0"
    # CFLAGS includes -gline-tables-only and LDFLAGS sets --no-wasm-opt
    # to keep the wasm name section intact for FPM's asyncify-onlylist
    # to find function names. CLI doesn't need either but inheriting
    # the same flags doesn't change CLI's behaviour besides a slightly
    # larger binary.

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
        -e 's/^#define HAVE_SETPROCTITLE_FAST 1/\/* #undef HAVE_SETPROCTITLE_FAST *\//' \
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

echo "==> Building PHP CLI..."
make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" cli

echo "==> Building PHP FPM..."
make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" fpm

echo "==> Both PHP binaries built successfully!"

# Copy to bin/ with .wasm extension (needed for Vite browser demos)
mkdir -p "$SCRIPT_DIR/bin"
cp sapi/cli/php "$SCRIPT_DIR/bin/php.wasm"
cp sapi/fpm/php-fpm "$SCRIPT_DIR/bin/php-fpm.wasm"

# Both CLI and FPM are built with -gline-tables-only + --no-wasm-opt
# so FPM's asyncify-onlylist can find function names. That leaves CLI
# with ~18MB of unneeded debug info; wasm-opt -O2 strips it.
WASM_OPT="$(command -v wasm-opt 2>/dev/null || true)"
if [ -n "$WASM_OPT" ]; then
    echo "==> Optimizing CLI binary (strip debug info)..."
    "$WASM_OPT" -O2 "$SCRIPT_DIR/bin/php.wasm" -o "$SCRIPT_DIR/bin/php.wasm"

    # Asyncify FPM (it forks worker children). CLI is sequential.
    # The asyncify-onlylist restricts instrumentation to ~48 named
    # functions on the fork call path, keeping the binary small (~10MB
    # vs ~21MB for full asyncify) and avoiding V8 stack overflow in
    # browser web workers.
    #
    # Onlylist requires the wasm name section to be intact:
    #   - CFLAGS includes -gline-tables-only (set above)
    #   - LDFLAGS includes --no-wasm-opt (set above)
    #   - wasm-opt -g flag (below)
    ONLYLIST="$SCRIPT_DIR/asyncify-fpm-onlylist.txt"
    if [ -f "$ONLYLIST" ]; then
        ONLY_FUNCS=$(grep -v '^#' "$ONLYLIST" | grep -v '^$' | tr '\n' ',' | sed 's/,$//')
        FUNC_COUNT=$(echo "$ONLY_FUNCS" | tr ',' '\n' | wc -l | tr -d ' ')
        echo "==> Applying asyncify-onlylist to FPM ($FUNC_COUNT functions)..."
        "$WASM_OPT" -g --asyncify \
            --pass-arg="asyncify-imports@kernel.kernel_fork" \
            --pass-arg="asyncify-onlylist@${ONLY_FUNCS}" \
            "$SCRIPT_DIR/bin/php-fpm.wasm" -o "$SCRIPT_DIR/bin/php-fpm.wasm"
        echo "==> Optimizing asyncified FPM binary..."
        "$WASM_OPT" -O2 "$SCRIPT_DIR/bin/php-fpm.wasm" -o "$SCRIPT_DIR/bin/php-fpm.wasm"
    else
        echo "==> WARN: $ONLYLIST not found, skipping asyncify (FPM fork will not work)."
    fi
fi

ls -la "$SCRIPT_DIR/bin/php.wasm" "$SCRIPT_DIR/bin/php-fpm.wasm"

# Install into local-binaries/ so the resolver picks the freshly-built
# binaries over the fetched release.
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary php "$SCRIPT_DIR/bin/php.wasm"     php.wasm
install_local_binary php "$SCRIPT_DIR/bin/php-fpm.wasm" php-fpm.wasm
