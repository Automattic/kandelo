#!/usr/bin/env bash
#
# Build curl for wasm32-posix-kernel.
#
# Two modes:
#
#   Resolver mode (`cargo xtask build-deps resolve libcurl`):
#     Env vars WASM_POSIX_DEP_OUT_DIR / _ZLIB_DIR / _OPENSSL_DIR are
#     set. Builds libcurl + headers + pkgconfig, `make install` into
#     $WASM_POSIX_DEP_OUT_DIR, then drops bin/ and share/ — the CLI
#     is a consumer artifact, not a library output.
#
#   Legacy mode (`bash build-libcurl.sh`):
#     No resolver env. Builds the curl CLI in the source tree and
#     registers curl.wasm via install-local-binary. Relies on zlib
#     and openssl artifacts existing in $REPO_ROOT/sysroot/, the way
#     `run.sh build_libcurl` wires them up.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SRC_DIR="$SCRIPT_DIR/curl-src"

# --- Inputs from resolver, with legacy fallbacks ---
CURL_VERSION="${WASM_POSIX_DEP_VERSION:-${CURL_VERSION:-8.11.1}}"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://curl.se/download/curl-${CURL_VERSION}.tar.xz}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-}"

# Resolver vs legacy is decided by whether WASM_POSIX_DEP_OUT_DIR is
# set. In resolver mode INSTALL_DIR is the cache temp dir; in legacy
# mode it's the in-tree bin/ for curl.wasm.
RESOLVER_MODE=0
if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    RESOLVER_MODE=1
    INSTALL_DIR="$WASM_POSIX_DEP_OUT_DIR"
else
    INSTALL_DIR="$SCRIPT_DIR/bin"
fi

if ! command -v wasm32posix-cc &>/dev/null; then
    echo "ERROR: wasm32posix-cc not found. Run 'npm link' in sdk/ first." >&2
    exit 1
fi

# Use the SDK's sysroot resolver: explicit env var wins, else the
# in-tree $REPO_ROOT/sysroot. Keeps resolver invocations from
# neighbouring worktrees viable (WASM_POSIX_SYSROOT=<other>/sysroot).
SYSROOT="${WASM_POSIX_SYSROOT:-$REPO_ROOT/sysroot}"
if [ ! -f "$SYSROOT/lib/libc.a" ]; then
    echo "ERROR: sysroot not found at $SYSROOT. Run: bash build.sh && bash scripts/build-musl.sh" >&2
    exit 1
fi
export WASM_POSIX_SYSROOT="$SYSROOT"

# --- Locate zlib + openssl ---
# Resolver mode surfaces the per-dep install dirs via the contract
# env vars. Legacy mode falls back to the sysroot artifacts that
# `run.sh build_libcurl` installs alongside the build.
ZLIB_PREFIX="${WASM_POSIX_DEP_ZLIB_DIR:-}"
if [ -z "$ZLIB_PREFIX" ] && [ -f "$SYSROOT/lib/libz.a" ]; then
    ZLIB_PREFIX="$SYSROOT"
fi

OPENSSL_PREFIX="${WASM_POSIX_DEP_OPENSSL_DIR:-}"
if [ -z "$OPENSSL_PREFIX" ] \
    && [ -f "$SYSROOT/lib/libssl.a" ] \
    && [ -f "$SYSROOT/lib/libcrypto.a" ]; then
    OPENSSL_PREFIX="$SYSROOT"
fi

# --- Fetch + verify source ---
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Downloading curl $CURL_VERSION..."
    TARBALL="/tmp/curl-${CURL_VERSION}.tar.xz"
    curl --retry 10 --retry-delay 5 --retry-max-time 300 --retry-all-errors -fsSL "$SOURCE_URL" -o "$TARBALL"
    if [ -n "$SOURCE_SHA256" ]; then
        echo "==> Verifying source sha256..."
        echo "$SOURCE_SHA256  $TARBALL" | shasum -a 256 -c -
    else
        echo "==> (no SOURCE_SHA256 declared; skipping verification)"
    fi
    mkdir -p "$SRC_DIR"
    tar xJf "$TARBALL" -C "$SRC_DIR" --strip-components=1
    rm "$TARBALL"
    echo "==> Source extracted to $SRC_DIR"
fi

cd "$SRC_DIR"

# In resolver mode INSTALL_DIR varies per cache key (autoconf bakes
# it into the Makefile) — always reconfigure from scratch. Legacy
# mode keeps the "reconfigure only if no Makefile" shortcut that
# existing callers relied on.
if [ "$RESOLVER_MODE" = "1" ]; then
    make distclean 2>/dev/null || true
    rm -f Makefile
    rm -rf "$INSTALL_DIR"
    mkdir -p "$INSTALL_DIR"
fi

# --- Configure ---
if [ ! -f Makefile ]; then
    echo "==> Configuring curl for wasm32..."

    # Cross-compilation cache overrides. configure would otherwise
    # try to link-test against the host libc.
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

    # Wasm32 type sizes.
    export ac_cv_sizeof_long=4
    export ac_cv_sizeof_long_long=8
    export ac_cv_sizeof_int=4
    export ac_cv_sizeof_size_t=4
    export ac_cv_sizeof_off_t=8
    export ac_cv_sizeof_curl_off_t=8
    export ac_cv_sizeof_time_t=8

    # Cross-compilation results that can't be detected at configure time.
    export curl_cv_func_recv_args="int,void *,size_t,int,ssize_t"
    export curl_cv_func_send_args="int,const void *,size_t,int,ssize_t"
    export curl_cv_func_recvfrom_args="int,void *,size_t,int,struct sockaddr *,socklen_t *,ssize_t"
    export curl_cv_recv="yes"
    export curl_cv_send="yes"

    # Bypass OpenSSL link checks — cross-compilation can't run link
    # tests against wasm32 static libraries. We know they exist and are
    # valid because the resolver (or run.sh) produced them.
    export ac_cv_lib_crypto_HMAC_Update=yes
    export ac_cv_lib_crypto_HMAC_Init_ex=yes
    export ac_cv_lib_ssl_SSL_connect=yes
    export ac_cv_lib_crypto_EVP_DigestInit_ex=yes
    export ac_cv_lib_dl_dlopen=yes

    # --- SSL / TLS ---
    SSL_FLAGS=()
    if [ -n "$OPENSSL_PREFIX" ]; then
        SSL_FLAGS+=(--with-openssl="$OPENSSL_PREFIX")
        # Provide explicit OpenSSL flags so configure doesn't fall back
        # to pkg-config link tests (which would try to run host-linked
        # binaries).
        export OPENSSL_CFLAGS="-I$OPENSSL_PREFIX/include"
        export OPENSSL_LIBS="-L$OPENSSL_PREFIX/lib -lssl -lcrypto"
        echo "==> OpenSSL found at $OPENSSL_PREFIX, building with HTTPS support"
    else
        SSL_FLAGS+=(--without-ssl)
        echo "==> OpenSSL not found, building HTTP-only (no SSL)"
    fi

    # --- zlib ---
    ZLIB_FLAGS=()
    if [ -n "$ZLIB_PREFIX" ]; then
        ZLIB_FLAGS+=(--with-zlib="$ZLIB_PREFIX")
        echo "==> zlib found at $ZLIB_PREFIX"
    else
        ZLIB_FLAGS+=(--without-zlib)
        echo "==> zlib not found, building without compression"
    fi

    # Static OpenSSL depends on -ldl for its dlopen stubs.
    export LIBS="${LIBS:-} -ldl"

    # Install prefix: the cache dir in resolver mode. Omit in legacy
    # mode — we collect src/curl manually rather than `make install`.
    PREFIX_ARGS=()
    if [ "$RESOLVER_MODE" = "1" ]; then
        PREFIX_ARGS+=(--prefix="$INSTALL_DIR")
    fi

    wasm32posix-configure \
        ${PREFIX_ARGS[@]+"${PREFIX_ARGS[@]}"} \
        --disable-nls \
        --disable-shared \
        --enable-static \
        ${SSL_FLAGS[@]+"${SSL_FLAGS[@]}"} \
        ${ZLIB_FLAGS[@]+"${ZLIB_FLAGS[@]}"} \
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

if [ "$RESOLVER_MODE" = "1" ]; then
    # --- Install library + headers + pkgconfig into the cache ---
    # curl's `make install` copies src/curl and curl-config into
    # $INSTALL_DIR/bin/ and a manpage tree into $INSTALL_DIR/share/.
    # The CLI is a consumer artifact, and curl-config is a host-shell
    # shim that doesn't belong in the cached library output.
    #
    # When this script is invoked for the *curl* manifest (kind=program,
    # outputs.wasm = "curl.wasm"), the resolver also expects
    # `$INSTALL_DIR/curl.wasm` to exist post-build — so promote the CLI
    # binary to a flat location at the install root before pruning bin/.
    # When invoked for libcurl itself, the curl.wasm file is harmless
    # ballast in the cache (libcurl's outputs validator only checks
    # lib/libcurl.a + include/curl/*).
    echo "==> Installing libcurl to $INSTALL_DIR..."
    make install 2>&1 | tail -20
    if [ -f "$INSTALL_DIR/bin/curl" ]; then
        cp "$INSTALL_DIR/bin/curl" "$INSTALL_DIR/curl.wasm"
    fi
    rm -rf "$INSTALL_DIR/bin" "$INSTALL_DIR/share"

    if [ -f "$INSTALL_DIR/lib/libcurl.a" ]; then
        echo "==> libcurl install complete!"
        ls -lh "$INSTALL_DIR/lib/libcurl.a"
    else
        echo "ERROR: libcurl not installed at $INSTALL_DIR/lib/libcurl.a" >&2
        exit 1
    fi
else
    # --- Legacy mode: collect CLI, register with local-binaries/ ---
    echo "==> Collecting binary..."
    mkdir -p "$INSTALL_DIR"

    if [ -f "$SRC_DIR/src/curl" ]; then
        cp "$SRC_DIR/src/curl" "$INSTALL_DIR/curl.wasm"
        echo "==> Built curl"
        ls -lh "$INSTALL_DIR/curl.wasm"
    else
        echo "ERROR: curl binary not found after build" >&2
        exit 1
    fi

    echo ""
    echo "==> curl built successfully!"
    echo "Binary: $INSTALL_DIR/curl.wasm"

    # Install into local-binaries/ so the resolver picks the freshly-built
    # binary over the fetched release.
    source "$REPO_ROOT/scripts/install-local-binary.sh"
    install_local_binary curl "$INSTALL_DIR/curl.wasm"
fi
