#!/usr/bin/env bash
set -euo pipefail

# Build Git 2.47.1 for wasm32-posix-kernel.
#
# Git uses a Makefile-based build system (no autoconf). Cross-compilation
# is done via config.mak overrides.
#
# Resolves zlib, openssl, and libcurl via
# `cargo xtask build-deps resolve <name>` — see
# docs/dependency-management.md. openssl is pulled in because static
# libcurl in our build references -lssl -lcrypto.
#
# Asyncify is applied (full, not onlylist) so fork+exec works properly
# (git gc --auto, hooks, pager, credential helpers, etc.).
#
# HTTP/HTTPS transport is always built (git-remote-http). HTTPS URLs
# are rewritten to HTTP at runtime via gitconfig; the browser's
# fetch() API + CORS proxy handles the actual TLS.
#
# Output: examples/libs/git/bin/git.wasm
#         examples/libs/git/bin/git-remote-http.wasm

GIT_VERSION="${GIT_VERSION:-2.47.1}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SRC_DIR="$SCRIPT_DIR/git-src"
BIN_DIR="$SCRIPT_DIR/bin"
# Explicit env wins; else the in-tree sysroot. Matches build-libcurl.sh:49.
SYSROOT="${WASM_POSIX_SYSROOT:-$REPO_ROOT/sysroot}"
ONLYLIST="$SCRIPT_DIR/asyncify-onlylist.txt"

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
export WASM_POSIX_GLUE_DIR="$REPO_ROOT/glue"

# --- Resolve zlib, openssl, and libcurl via the dep cache ---
# openssl is a transitive dep: our cached libcurl.a references
# -lssl/-lcrypto symbols, and the final link needs their .a files
# findable on -L. Env-var short-circuits (WASM_POSIX_DEP_<NAME>_DIR)
# let an outer resolver run pass prefixes through without re-invoking
# cargo for each dep.
HOST_TARGET="$(rustc -vV | awk '/^host/ {print $2}')"
resolve_dep() {
    local name="$1"
    (cd "$REPO_ROOT" && cargo run -p xtask --target "$HOST_TARGET" --quiet -- build-deps resolve "$name")
}

ZLIB_PREFIX="${WASM_POSIX_DEP_ZLIB_DIR:-}"
if [ -z "$ZLIB_PREFIX" ]; then
    echo "==> Resolving zlib via cargo xtask build-deps..."
    ZLIB_PREFIX="$(resolve_dep zlib)"
fi
if [ ! -f "$ZLIB_PREFIX/lib/libz.a" ]; then
    echo "ERROR: zlib resolve returned '$ZLIB_PREFIX' but libz.a missing" >&2
    exit 1
fi
echo "==> zlib at $ZLIB_PREFIX"

OPENSSL_PREFIX="${WASM_POSIX_DEP_OPENSSL_DIR:-}"
if [ -z "$OPENSSL_PREFIX" ]; then
    echo "==> Resolving openssl via cargo xtask build-deps..."
    OPENSSL_PREFIX="$(resolve_dep openssl)"
fi
if [ ! -f "$OPENSSL_PREFIX/lib/libssl.a" ] || [ ! -f "$OPENSSL_PREFIX/lib/libcrypto.a" ]; then
    echo "ERROR: openssl resolve returned '$OPENSSL_PREFIX' but libssl.a/libcrypto.a missing" >&2
    exit 1
fi
echo "==> openssl at $OPENSSL_PREFIX"

CURL_PREFIX="${WASM_POSIX_DEP_LIBCURL_DIR:-}"
if [ -z "$CURL_PREFIX" ]; then
    echo "==> Resolving libcurl via cargo xtask build-deps..."
    CURL_PREFIX="$(resolve_dep libcurl)"
fi
if [ ! -f "$CURL_PREFIX/lib/libcurl.a" ] || [ ! -f "$CURL_PREFIX/include/curl/curl.h" ]; then
    echo "ERROR: libcurl resolve returned '$CURL_PREFIX' but libcurl.a/curl.h missing" >&2
    exit 1
fi
echo "==> libcurl at $CURL_PREFIX"

# Check for wasm-opt (required for asyncify)
WASM_OPT="$(command -v wasm-opt 2>/dev/null || true)"
if [ -z "$WASM_OPT" ]; then
    echo "ERROR: wasm-opt not found. Install binaryen." >&2
    exit 1
fi

# --- Download Git source ---
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Downloading git $GIT_VERSION..."
    TARBALL="git-${GIT_VERSION}.tar.xz"
    URL="https://www.kernel.org/pub/software/scm/git/${TARBALL}"
    curl --retry 10 --retry-delay 5 --retry-max-time 300 --retry-all-errors -fsSL "$URL" -o "/tmp/$TARBALL"
    mkdir -p "$SRC_DIR"
    tar xJf "/tmp/$TARBALL" -C "$SRC_DIR" --strip-components=1
    rm "/tmp/$TARBALL"
    echo "==> Source extracted to $SRC_DIR"
fi

cd "$SRC_DIR"

# --- Create config.mak for cross-compilation ---
echo "==> Creating config.mak for wasm32 cross-compilation..."
cat > config.mak << ENDMAK
# Cross-compilation for wasm32-posix-kernel
CC = wasm32posix-cc
AR = wasm32posix-ar
RANLIB = wasm32posix-ranlib
STRIP = wasm32posix-strip

# Install paths — must match wasm VFS layout so git finds /etc/gitconfig
prefix = /usr
sysconfdir = /etc

# Optimization + debug info for function names (needed by asyncify-onlylist).
# -gline-tables-only emits DWARF line tables + function name section without
# full debug info, so wasm-opt can match function names in the onlylist.
CFLAGS = -O2 -gline-tables-only

# Increase shadow stack from default 64KB to 1MB — git's deeply nested
# calls (strbuf_realpath, config parsing, snprintf) overflow 64KB.
# --no-wasm-opt prevents clang's built-in wasm-opt from stripping the
# name section after linking (required for asyncify-onlylist to work).
# Must NOT use -Wl, prefix — this is a clang driver flag, not a linker flag.
LDFLAGS = -Wl,-z,stack-size=1048576 --no-wasm-opt

# Disable optional features that need unavailable infrastructure
NO_PERL = YesPlease
NO_PYTHON = YesPlease
NO_TCLTK = YesPlease
NO_GETTEXT = YesPlease
NO_EXPAT = YesPlease
NO_ICONV = YesPlease
NO_REGEX = NeedsStartEnd
NO_NSEC = YesPlease
NO_INSTALL_HARDLINKS = YesPlease

# Disable features that require runtime infrastructure we don't have
NO_OPENSSL = YesPlease

# Use zlib from the dep-cache prefix
ZLIB_PATH = $ZLIB_PREFIX

# SHA-1 backend: use the bundled block-sha1 (no OpenSSL dependency needed)
BLK_SHA1 = YesPlease

# SHA-256 backend: use the bundled sha256 implementation
OPENSSL_SHA256 =

# wasm32 has no pthreads
NO_PTHREADS = YesPlease

# Disable mmap — Git's mmap usage for packfiles would work but we want
# to keep things simple for the initial build.
NO_MMAP = YesPlease

# No /etc/passwd or getpwnam — use fallback
NO_GECOS_IN_PWENT = YesPlease

# Disable features that try to spawn helper programs we may not have
NO_EXTERNAL_DIFF = YesPlease

# Tell Git about platform capabilities
HAVE_CLOCK_GETTIME = YesPlease
HAVE_CLOCK_MONOTONIC = YesPlease
HAVE_GETDELIM = YesPlease
HAVE_PATHS_H = YesPlease
HAVE_DEV_TTY = YesPlease

# Cross-compilation: can't run test programs
CROSS_COMPILING = YesPlease

# Don't build git-daemon, git-http-backend, etc.
PROGRAMS =

# Link statically
EXTLIBS = -lz
ENDMAK

# HTTP/HTTPS transport via libcurl.
# Note: NO_CURL is NOT set — this enables git-remote-http/https.
# Setting CURLDIR triggers git's Makefile to derive CURL_CFLAGS =
# -I$CURLDIR/include. We can't just set CURL_CFLAGS directly because
# the Makefile resets it when CURLDIR is unset. CURL_LDFLAGS is
# consumed as-is (appended after CURL_LIBCURL).
cat >> config.mak << ENDCURL

CURLDIR = $CURL_PREFIX
CURL_LDFLAGS = -L$CURL_PREFIX/lib -L$OPENSSL_PREFIX/lib -L$ZLIB_PREFIX/lib -lcurl -lssl -lcrypto -ldl -lz
ENDCURL

# --- Build ---
echo "==> Building git..."
NCPU="$(sysctl -n hw.ncpu 2>/dev/null || nproc)"

# Override uname_S to prevent config.mak.uname from applying Darwin-specific
# settings (HAVE_BSD_SYSCTL, precompose_utf8, etc.). Must be on the command
# line so it takes effect before config.mak.uname conditionals.
make uname_S=Wasm32 -j"$NCPU" git git-remote-http 2>&1 | tail -50

echo "==> Collecting binaries..."
mkdir -p "$BIN_DIR"

if [ ! -f "$SRC_DIR/git" ]; then
    echo "ERROR: git binary not found after build" >&2
    exit 1
fi

cp "$SRC_DIR/git" "$BIN_DIR/git.wasm"

if [ ! -f "$SRC_DIR/git-remote-http" ]; then
    echo "ERROR: git-remote-http binary not found after build" >&2
    exit 1
fi
cp "$SRC_DIR/git-remote-http" "$BIN_DIR/git-remote-http.wasm"
echo "==> Collected git-remote-http.wasm"
SIZE_BEFORE=$(wc -c < "$BIN_DIR/git.wasm" | tr -d ' ')
echo "==> Pre-asyncify size: $(echo "$SIZE_BEFORE" | numfmt --to=iec 2>/dev/null || echo "${SIZE_BEFORE} bytes")"

# --- Asyncify transform ---
# Full asyncify (no onlylist) is required because asyncify's onlylist mode
# corrupts call_indirect instructions in transport_get_remote_refs, causing
# "null function or function signature mismatch" at runtime. This is a
# binaryen bug where asyncify changes function signatures for indirect call
# targets when using --asyncify-onlylist. Full asyncify avoids this by
# instrumenting all functions uniformly.
echo "==> Applying asyncify (full)..."

# -g tells wasm-opt to read the name section from the binary
"$WASM_OPT" -g --asyncify \
    --pass-arg="asyncify-imports@kernel.kernel_fork" \
    "$BIN_DIR/git.wasm" -o "$BIN_DIR/git.wasm"

# Optimize after asyncify to reduce binary size
"$WASM_OPT" -g -O2 "$BIN_DIR/git.wasm" -o "$BIN_DIR/git.wasm"

SIZE_AFTER=$(wc -c < "$BIN_DIR/git.wasm" | tr -d ' ')
echo "==> Post-asyncify size: $(echo "$SIZE_AFTER" | numfmt --to=iec 2>/dev/null || echo "${SIZE_AFTER} bytes")"

# Apply asyncify to git-remote-http too — libcurl may call fork()
# internally (e.g., for DNS resolution when pthreads are unavailable).
echo "==> Applying asyncify to git-remote-http.wasm..."
RH_SIZE_BEFORE=$(wc -c < "$BIN_DIR/git-remote-http.wasm" | tr -d ' ')
"$WASM_OPT" -g --asyncify \
    --pass-arg="asyncify-imports@kernel.kernel_fork" \
    "$BIN_DIR/git-remote-http.wasm" -o "$BIN_DIR/git-remote-http.wasm"
"$WASM_OPT" -g -O2 "$BIN_DIR/git-remote-http.wasm" -o "$BIN_DIR/git-remote-http.wasm"
RH_SIZE_AFTER=$(wc -c < "$BIN_DIR/git-remote-http.wasm" | tr -d ' ')
echo "==> git-remote-http: $(echo "$RH_SIZE_BEFORE" | numfmt --to=iec 2>/dev/null || echo "${RH_SIZE_BEFORE}") -> $(echo "$RH_SIZE_AFTER" | numfmt --to=iec 2>/dev/null || echo "${RH_SIZE_AFTER}")"

echo ""
echo "==> git built successfully with asyncify fork support!"
echo "Binary: $BIN_DIR/git.wasm"
echo "HTTP transport: $BIN_DIR/git-remote-http.wasm"

# Install into local-binaries/ (multi-binary program).
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary git "$BIN_DIR/git.wasm" git.wasm
install_local_binary git "$BIN_DIR/git-remote-http.wasm" git-remote-http.wasm
