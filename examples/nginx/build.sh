#!/usr/bin/env bash
set -euo pipefail

NGINX_VERSION="${NGINX_VERSION:-1.24.0}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_DIR="$SCRIPT_DIR/nginx-src"
BUILD_DIR="$SRC_DIR/objs"

if ! command -v wasm32posix-cc &>/dev/null; then
    echo "ERROR: wasm32posix-cc not found. Run 'npm link' in sdk/ first." >&2
    exit 1
fi

REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SYSROOT="$REPO_ROOT/sysroot"
export WASM_POSIX_SYSROOT="$SYSROOT"

# Download nginx source
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Downloading nginx $NGINX_VERSION..."
    TARBALL="nginx-${NGINX_VERSION}.tar.gz"
    curl -fsSL "https://nginx.org/download/${TARBALL}" -o "/tmp/${TARBALL}"
    mkdir -p "$SRC_DIR"
    tar xzf "/tmp/${TARBALL}" -C "$SRC_DIR" --strip-components=1
    rm "/tmp/${TARBALL}"
fi

cd "$SRC_DIR"

# =============================================================================
# Patch nginx's auto/ scripts for Wasm cross-compilation
# =============================================================================

echo "==> Patching nginx for Wasm cross-compilation..."

# --- Patch auto/types/sizeof ---
# nginx runs compiled test programs to detect sizeof(types).
# Replace with hardcoded wasm32 ILP32 values (just sets ngx_size/ngx_max_value/ngx_max_len).
if ! grep -q 'wasm32 cross-compilation' auto/types/sizeof 2>/dev/null; then
    cat > auto/types/sizeof <<'SIZEOF_EOF'
# Copyright (C) Igor Sysoev
# Copyright (C) Nginx, Inc.

# Modified for wasm32 cross-compilation: hardcode ILP32 sizes

echo $ngx_n "checking for $ngx_type size ...$ngx_c"

# wasm32 ILP32: int=4, long=4, pointer=4, off_t=8, time_t=8, size_t=4
case "$ngx_type" in
    int)            ngx_size=4 ;;
    long)           ngx_size=4 ;;
    "long long")    ngx_size=8 ;;
    "void *")       ngx_size=4 ;;
    off_t)          ngx_size=8 ;;
    time_t)         ngx_size=8 ;;
    size_t)         ngx_size=4 ;;
    sig_atomic_t)   ngx_size=4 ;;
    *)              ngx_size=4 ;;
esac

echo " $ngx_size bytes"

case $ngx_size in
    4)
        ngx_max_value=2147483647
        ngx_max_len='(sizeof("-2147483648") - 1)'
    ;;
    8)
        ngx_max_value=9223372036854775807LL
        ngx_max_len='(sizeof("-9223372036854775808") - 1)'
    ;;
esac

rm -rf $NGX_AUTOTEST*
SIZEOF_EOF
fi

# --- Patch auto/types/typedef ---
# nginx runs test programs to check if types exist. Replace with compile-only.
if ! grep -q 'wasm32: compile-only' auto/types/typedef 2>/dev/null; then
    cat > auto/types/typedef <<'TYPEDEF_EOF'
# Copyright (C) Igor Sysoev
# Copyright (C) Nginx, Inc.

# wasm32: compile-only type detection (no run)

echo $ngx_n "checking for $ngx_type ...$ngx_c"

cat << END >> $NGX_AUTOTEST.c
#include <sys/types.h>
#include <signal.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <sys/resource.h>
#include <netinet/in.h>

int main(void) {
    $ngx_type dummy;
    (void)dummy;
    return 0;
}
END

ngx_found=no
if $CC $CC_TEST_FLAGS $CC_AUX_FLAGS \
    -o $NGX_AUTOTEST $NGX_AUTOTEST.c \
    $NGX_LD_OPT $ngx_feature_libs >/dev/null 2>&1; then
    ngx_found=yes
fi
rm -f $NGX_AUTOTEST $NGX_AUTOTEST.c

if [ $ngx_found = yes ]; then
    echo " found"
    ngx_type_value="$ngx_type"
else
    echo " not found"
    ngx_type_value="$ngx_default"
fi

cat << END >> $NGX_AUTO_CONFIG_H

#ifndef $ngx_param
#define $ngx_param  $ngx_type_value
#endif

END
TYPEDEF_EOF
fi

# --- Patch auto/feature ---
# nginx compiles AND runs test programs to detect features.
# Replace run-check with compile-only (link success = feature present).
if ! grep -q 'wasm32: compile-only feature' auto/feature 2>/dev/null; then
    cat > auto/feature <<'FEATURE_EOF'
# Copyright (C) Igor Sysoev
# Copyright (C) Nginx, Inc.

# wasm32: compile-only feature detection (no execution)

echo $ngx_n "checking for $ngx_feature ...$ngx_c"

cat << END > $NGX_AUTOTEST.c

$ngx_feature_incs

int main(void) {
    $ngx_feature_test;
    return 0;
}

END

ngx_found=no

if test -n "$ngx_feature_name"; then
    ngx_have=`echo $ngx_feature_name \
        | tr abcdefghijklmnopqrstuvwxyz ABCDEFGHIJKLMNOPQRSTUVWXYZ`
fi

if $CC -c $CC_TEST_FLAGS $CC_AUX_FLAGS \
    $ngx_feature_inc_opt $NGX_AUTOTEST.c \
    -o $NGX_AUTOTEST.o \
    $ngx_feature_libs >/dev/null 2>&1; then
    ngx_found=yes
fi

rm -f $NGX_AUTOTEST $NGX_AUTOTEST.c $NGX_AUTOTEST.o

if [ $ngx_found = yes ]; then
    echo " found"

    if test -n "$ngx_feature_name"; then
        cat << END >> $NGX_AUTO_CONFIG_H

#ifndef $ngx_have
#define $ngx_have  1
#endif

END
    fi

    eval "ngx_found=${ngx_feature_name:+yes}"

    CORE_INCS="$CORE_INCS $ngx_feature_incs_path"

    if [ -n "$ngx_feature_path" ]; then
        CORE_INCS="$CORE_INCS $ngx_feature_path"
    fi

    CORE_LIBS="$CORE_LIBS $ngx_feature_libs"
else
    echo " not found"

    echo "----------"    >> $NGX_AUTOCONF_ERR
    cat $NGX_AUTOTEST.c  >> $NGX_AUTOCONF_ERR 2>/dev/null || true
    echo "----------"    >> $NGX_AUTOCONF_ERR
fi

rm -f $NGX_AUTOTEST*
FEATURE_EOF
fi

# --- Patch auto/endianness ---
# Wasm32 is little-endian
if ! grep -q 'wasm32: hardcoded' auto/endianness 2>/dev/null; then
    cat > auto/endianness <<'ENDIAN_EOF'
# wasm32: hardcoded little-endian

echo "checking for system byte ordering ... little endian"

cat << END >> $NGX_AUTO_CONFIG_H

#ifndef NGX_HAVE_LITTLE_ENDIAN
#define NGX_HAVE_LITTLE_ENDIAN  1
#endif

END
ENDIAN_EOF
fi

# --- Patch auto/os/conf to force generic POSIX path (not Darwin/Linux) ---
if ! grep -q 'wasm32 cross-compile override' auto/os/conf 2>/dev/null; then
    cat > auto/os/conf <<'OSCONF_EOF'
# wasm32 cross-compile override — use generic POSIX, no platform-specific headers

echo "checking for Wasm/POSIX features"

CORE_INCS="$UNIX_INCS"
CORE_DEPS="$UNIX_DEPS $POSIX_DEPS"
CORE_SRCS="$UNIX_SRCS"

# Force wasm32 machine settings
have=NGX_ALIGNMENT value=16 . auto/define
NGX_MACH_CACHE_LINE=32

if test -z "$NGX_CPU_CACHE_LINE"; then
    NGX_CPU_CACHE_LINE=$NGX_MACH_CACHE_LINE
fi

have=NGX_CPU_CACHE_LINE value=$NGX_CPU_CACHE_LINE . auto/define
OSCONF_EOF
fi

# --- Patch auto/unix ---
# The tryrun tests in auto/unix need to be compile-only
# Most features will be detected via our patched auto/feature
# But some tests inline their own compile+run, patch those specifically
if ! grep -q 'wasm32-patched' auto/unix 2>/dev/null; then
    # Replace any "ngx_test" run-checks with compile-only
    # The key issue: auto/unix does `./$NGX_AUTOTEST` which fails for cross-compile
    sed -i.bak \
        -e 's|\./\$NGX_AUTOTEST|true # wasm32: skip run|g' \
        -e 's|`\./\$NGX_AUTOTEST`|4 # wasm32: default|g' \
        auto/unix
    rm -f auto/unix.bak
    echo "# wasm32-patched" >> auto/unix
fi

# =============================================================================
# Configure nginx
# =============================================================================

if [ ! -f Makefile ]; then
    echo "==> Configuring nginx for Wasm..."

    # nginx's configure expects CC to be the compiler command
    export CC="wasm32posix-cc"
    # Use CC for test compilation too
    export CC_TEST_FLAGS=""

    ./configure \
        --prefix=/usr/local/nginx \
        --with-cc="wasm32posix-cc" \
        --with-cc-opt="-Wno-unused-parameter -Wno-sign-compare" \
        --with-ld-opt="" \
        --without-http_rewrite_module \
        --without-http_gzip_module \
        --without-http_uwsgi_module \
        --without-http_scgi_module \
        --without-http_memcached_module \
        --without-http_empty_gif_module \
        --without-http_browser_module \
        --without-http_upstream_ip_hash_module \
        --without-http_upstream_least_conn_module \
        --without-http_upstream_keepalive_module \
        --with-poll_module \
        --without-select_module \
        --http-log-path=/dev/stderr \
        --error-log-path=/dev/stderr

    # Patch the generated objs/Makefile:
    # 1. Remove -Werror if present (cross-compile warnings are expected)
    # 2. Fix any hardcoded paths
    if [ -f objs/Makefile ]; then
        sed -i.bak 's/-Werror//g' objs/Makefile
        rm -f objs/Makefile.bak
    fi

    # Patch ngx_auto_config.h with wasm32-specific overrides
    cat >> objs/ngx_auto_config.h <<'CONFIG_EOF'

/* wasm32 overrides */
#ifndef NGX_PTR_SIZE
#define NGX_PTR_SIZE  4
#endif
#ifndef NGX_SIG_ATOMIC_T_SIZE
#define NGX_SIG_ATOMIC_T_SIZE  4
#endif
#ifndef NGX_TIME_T_SIZE
#define NGX_TIME_T_SIZE  8
#endif
#ifndef NGX_HAVE_EPOLL
#define NGX_HAVE_EPOLL  0
#endif
#ifndef NGX_HAVE_KQUEUE
#define NGX_HAVE_KQUEUE  0
#endif
#ifndef NGX_HAVE_POLL
#define NGX_HAVE_POLL  1
#endif
#ifndef NGX_HAVE_SENDFILE
#define NGX_HAVE_SENDFILE  0
#endif
#ifndef NGX_HAVE_PREAD
#define NGX_HAVE_PREAD  1
#endif
#ifndef NGX_HAVE_PWRITE
#define NGX_HAVE_PWRITE  1
#endif
/* mmap(MAP_ANON|MAP_SHARED) is supported — needed for nginx shared memory zones */
#ifndef NGX_HAVE_MAP_ANON
#define NGX_HAVE_MAP_ANON  1
#endif
CONFIG_EOF
fi

# =============================================================================
# Build nginx
# =============================================================================

echo "==> Building nginx..."

# Extract source file list from the generated Makefile (accurate per configure)
NGINX_SRCS=()
while IFS= read -r f; do
    NGINX_SRCS+=("$f")
done < <(grep '\.c' objs/Makefile | grep -oE 'src/[^ ]+\.c' | sort -u)

INCLUDE_FLAGS=(
    -I src/core
    -I src/event
    -I src/event/modules
    -I src/event/quic
    -I src/os/unix
    -I objs
    -I src/http
    -I src/http/modules
    -I src/http/v2
)

mkdir -p objs/src/core objs/src/event/modules objs/src/os/unix \
    objs/src/http/modules

echo "  Compiling ${#NGINX_SRCS[@]} source files..."
OBJS=()
for src in "${NGINX_SRCS[@]}"; do
    obj="objs/${src%.c}.o"
    mkdir -p "$(dirname "$obj")"
    if [ ! -f "$obj" ] || [ "$src" -nt "$obj" ]; then
        wasm32posix-cc -c "${INCLUDE_FLAGS[@]}" \
            -DNGX_PREFIX='"/usr/local/nginx/"' \
            -DNGX_SBIN_PATH='"/usr/local/nginx/sbin/nginx"' \
            -DNGX_CONF_PATH='"/usr/local/nginx/conf/nginx.conf"' \
            -DNGX_CONF_PREFIX='"/usr/local/nginx/conf/"' \
            -DNGX_PID_PATH='"/usr/local/nginx/logs/nginx.pid"' \
            -DNGX_LOCK_PATH='"/usr/local/nginx/logs/nginx.lock"' \
            -DNGX_ERROR_LOG_PATH='"/dev/stderr"' \
            -DNGX_HTTP_LOG_PATH='"/dev/stderr"' \
            -DNGX_HTTP_CLIENT_TEMP_PATH='"/tmp/nginx_client_temp"' \
            -DNGX_HTTP_PROXY_TEMP_PATH='"/tmp/nginx_proxy_temp"' \
            -DNGX_HTTP_FASTCGI_TEMP_PATH='"/tmp/nginx_fastcgi_temp"' \
            -Wno-unused-parameter -Wno-sign-compare \
            -O2 \
            "$src" -o "$obj"
    fi
    OBJS+=("$obj")
done

# Also compile the auto-generated module list
if [ -f objs/ngx_modules.c ]; then
    wasm32posix-cc -c "${INCLUDE_FLAGS[@]}" \
        -Wno-unused-parameter \
        objs/ngx_modules.c -o objs/ngx_modules.o
    OBJS+=(objs/ngx_modules.o)
fi

echo "  Linking nginx.wasm..."
wasm32posix-cc "${OBJS[@]}" -o "$SCRIPT_DIR/nginx.wasm" -lcrypt

# Asyncify for fork support (master_process on requires fork children to
# resume from the fork point rather than re-executing _start)
WASM_OPT="$(command -v wasm-opt 2>/dev/null || true)"
if [ -n "$WASM_OPT" ]; then
    echo "  Applying asyncify transform..."
    "$WASM_OPT" --asyncify \
        --pass-arg="asyncify-imports@kernel.kernel_fork" \
        "$SCRIPT_DIR/nginx.wasm" -o "$SCRIPT_DIR/nginx.wasm"
fi

echo "==> nginx.wasm built successfully!"
ls -la "$SCRIPT_DIR/nginx.wasm"

# Install into local-binaries/ so the resolver picks the freshly-built
# binary over the fetched release.
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary nginx "$SCRIPT_DIR/nginx.wasm"
