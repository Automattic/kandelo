#!/usr/bin/env bash
set -euo pipefail

# Build curl 8.11.1 for wasm32-posix-kernel.
#
# Uses the SDK's wasm32posix-configure wrapper for cross-compilation.
# Requires OpenSSL and zlib already built and installed in the sysroot.
# Output: examples/libs/curl/bin/curl.wasm

CURL_VERSION="${CURL_VERSION:-8.11.1}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SRC_DIR="$SCRIPT_DIR/curl-src"
BIN_DIR="$SCRIPT_DIR/bin"
SYSROOT="$REPO_ROOT/sysroot"

# --- Prerequisites ---
if ! command -v wasm32posix-cc &>/dev/null; then
    echo "ERROR: wasm32posix-cc not found. Run 'npm link' in sdk/ first." >&2
    exit 1
fi

if [ ! -f "$SYSROOT/lib/libc.a" ]; then
    echo "ERROR: sysroot not found. Run: bash build.sh && bash scripts/build-musl.sh" >&2
    exit 1
fi

export WASM_POSIX_SYSROOT="$SYSROOT"

# Check for OpenSSL
USE_OPENSSL=no
if [ -f "$SYSROOT/lib/libssl.a" ] && [ -f "$SYSROOT/lib/libcrypto.a" ]; then
    USE_OPENSSL=yes
    echo "==> OpenSSL found in sysroot, building with HTTPS support"
else
    echo "==> OpenSSL not found, building HTTP-only (no SSL)"
fi

# Check for zlib
USE_ZLIB=no
if [ -f "$SYSROOT/lib/libz.a" ]; then
    USE_ZLIB=yes
    echo "==> zlib found in sysroot"
else
    echo "==> zlib not found, building without compression"
fi

# --- Download curl source ---
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Downloading curl $CURL_VERSION..."
    TARBALL="curl-${CURL_VERSION}.tar.xz"
    URL="https://curl.se/download/${TARBALL}"
    curl -fsSL "$URL" -o "/tmp/$TARBALL"
    mkdir -p "$SRC_DIR"
    tar xJf "/tmp/$TARBALL" -C "$SRC_DIR" --strip-components=1
    rm "/tmp/$TARBALL"
    echo "==> Source extracted to $SRC_DIR"
fi

cd "$SRC_DIR"

# --- Configure ---
if [ ! -f Makefile ]; then
    echo "==> Configuring curl for wasm32..."

    # Cross-compilation cache overrides
    export ac_cv_func_closesocket=no
    export ac_cv_func_CloseSocket=no
    export ac_cv_func_fcntl=yes
    export ac_cv_func_ioctl=yes
    export ac_cv_func_fchmod=yes
    export ac_cv_func_fnmatch=yes
    export ac_cv_func_basename=yes
    export ac_cv_func_connect=yes
    export ac_cv_func_gethostname=yes
    export ac_cv_func_gettimeofday=yes
    export ac_cv_func_poll=yes
    export ac_cv_func_select=yes
    export ac_cv_func_socket=yes
    export ac_cv_func_socketpair=yes
    export ac_cv_func_getifaddrs=no
    export ac_cv_func_if_nametoindex=no
    export ac_cv_func_freeifaddrs=no
    export ac_cv_func_getpwuid=yes
    export ac_cv_func_getpwuid_r=no
    export ac_cv_func_getrlimit=no
    export ac_cv_func_setrlimit=no
    export ac_cv_func_sigaction=yes
    export ac_cv_func_sigsetjmp=yes
    export ac_cv_func_alarm=yes
    export ac_cv_func_strtoll=yes
    export ac_cv_func_fsetxattr=no
    export ac_cv_func_ftruncate=yes
    export ac_cv_func_sched_yield=yes
    export ac_cv_func_sendmsg=yes
    export ac_cv_func_recvmsg=yes
    export ac_cv_func_getpass_r=no
    export ac_cv_func_arc4random=no

    # Wasm32 type sizes
    export ac_cv_sizeof_long=4
    export ac_cv_sizeof_long_long=8
    export ac_cv_sizeof_int=4
    export ac_cv_sizeof_size_t=4
    export ac_cv_sizeof_off_t=8
    export ac_cv_sizeof_curl_off_t=8
    export ac_cv_sizeof_time_t=8

    # Cross-compilation results that can't be detected
    export curl_cv_func_recv_args="int,void *,size_t,int,ssize_t"
    export curl_cv_func_send_args="int,const void *,size_t,int,ssize_t"
    export curl_cv_func_recvfrom_args="int,void *,size_t,int,struct sockaddr *,socklen_t *,ssize_t"
    export curl_cv_recv="yes"
    export curl_cv_send="yes"

    # Bypass OpenSSL link checks — cross-compilation can't run link tests
    # against wasm32 static libraries. We know they exist and are valid.
    export ac_cv_lib_crypto_HMAC_Update=yes
    export ac_cv_lib_crypto_HMAC_Init_ex=yes
    export ac_cv_lib_ssl_SSL_connect=yes
    export ac_cv_lib_crypto_EVP_DigestInit_ex=yes
    export ac_cv_lib_dl_dlopen=yes

    # Build SSL/TLS flags
    SSL_FLAGS=()
    if [ "$USE_OPENSSL" = "yes" ]; then
        SSL_FLAGS+=(--with-openssl)
        # Explicitly provide OpenSSL flags to avoid pkg-config link test issues
        export OPENSSL_CFLAGS="-I$SYSROOT/include"
        export OPENSSL_LIBS="-L$SYSROOT/lib -lssl -lcrypto"
    else
        SSL_FLAGS+=(--without-ssl)
    fi

    # Build zlib flags
    ZLIB_FLAGS=()
    if [ "$USE_ZLIB" = "yes" ]; then
        ZLIB_FLAGS+=(--with-zlib)
    else
        ZLIB_FLAGS+=(--without-zlib)
    fi

    # Extra LIBS needed for static OpenSSL (it depends on -ldl)
    export LIBS="${LIBS:-} -ldl"

    wasm32posix-configure \
        --disable-nls \
        --disable-shared \
        --enable-static \
        "${SSL_FLAGS[@]}" \
        "${ZLIB_FLAGS[@]}" \
        --without-brotli \
        --without-zstd \
        --without-nghttp2 \
        --without-libidn2 \
        --without-libssh2 \
        --without-librtmp \
        --without-winidn \
        --without-libpsl \
        --disable-ldap \
        --disable-ldaps \
        --disable-rtsp \
        --disable-dict \
        --disable-telnet \
        --disable-tftp \
        --disable-pop3 \
        --disable-imap \
        --disable-smb \
        --disable-smtp \
        --disable-gopher \
        --disable-mqtt \
        --disable-threaded-resolver \
        --disable-manual \
        --disable-docs \
        --disable-ntlm \
        --disable-unix-sockets \
        --without-libgsasl \
        --disable-tls-srp \
        2>&1 | tail -40

    echo "==> Configure complete."
fi

# --- Build ---
echo "==> Building curl..."
make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" 2>&1 | tail -30

echo "==> Collecting binary..."
mkdir -p "$BIN_DIR"

if [ -f "$SRC_DIR/src/curl" ]; then
    cp "$SRC_DIR/src/curl" "$BIN_DIR/curl.wasm"
    echo "==> Built curl"
    ls -lh "$BIN_DIR/curl.wasm"
else
    echo "ERROR: curl binary not found after build" >&2
    exit 1
fi

echo ""
echo "==> curl built successfully!"
echo "Binary: $BIN_DIR/curl.wasm"
