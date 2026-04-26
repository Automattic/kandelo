#!/usr/bin/env bash
set -euo pipefail

# Build Git 2.47.1 for wasm32-posix-kernel.
#
# Git uses a Makefile-based build system (no autoconf). Cross-compilation
# is done via config.mak overrides.
#
# Fork instrumentation is applied so fork+exec works properly (git gc --auto,
# hooks, pager, credential helpers, etc.). wasm-fork-instrument auto-discovers
# fork paths via call-graph analysis — no onlylist is needed.
#
# If libcurl is available in the sysroot, HTTP/HTTPS transport support is
# built (git-remote-http helper). HTTPS URLs are rewritten to HTTP at
# runtime via gitconfig; the browser's fetch() API + CORS proxy handles
# the actual TLS.
#
# Output: examples/libs/git/bin/git.wasm
#         examples/libs/git/bin/git-remote-http.wasm (if libcurl available)

GIT_VERSION="${GIT_VERSION:-2.47.1}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SRC_DIR="$SCRIPT_DIR/git-src"
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
export WASM_POSIX_GLUE_DIR="$REPO_ROOT/glue"

# Check for zlib (required)
if [ ! -f "$SYSROOT/lib/libz.a" ]; then
    echo "ERROR: zlib not found in sysroot. Build it first." >&2
    exit 1
fi

# Check for libcurl (optional — enables HTTP/HTTPS transport)
USE_CURL=no
if [ -f "$SYSROOT/lib/libcurl.a" ] && [ -f "$SYSROOT/include/curl/curl.h" ]; then
    USE_CURL=yes
    echo "==> libcurl found in sysroot, building with HTTP transport support"
else
    echo "==> libcurl not found, building without HTTP transport (git clone over HTTP won't work)"
fi

# Check for wasm-opt (required for -O2 optimization after build).
WASM_OPT="$(command -v wasm-opt 2>/dev/null || true)"
if [ -z "$WASM_OPT" ]; then
    echo "ERROR: wasm-opt not found. Install binaryen." >&2
    exit 1
fi

# Check for fork-instrument tool (required for fork support).
FORK_INSTRUMENT="$REPO_ROOT/tools/bin/wasm-fork-instrument"
if [ ! -x "$FORK_INSTRUMENT" ]; then
    echo "ERROR: wasm-fork-instrument not found at $FORK_INSTRUMENT." >&2
    echo "  Run 'bash build.sh' to build it." >&2
    exit 1
fi

# --- Download Git source ---
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Downloading git $GIT_VERSION..."
    TARBALL="git-${GIT_VERSION}.tar.xz"
    URL="https://www.kernel.org/pub/software/scm/git/${TARBALL}"
    curl -fsSL "$URL" -o "/tmp/$TARBALL"
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

# Optimization + debug info for symbolication. -gline-tables-only emits
# DWARF line tables without full debug info. The asyncify-onlylist
# requirement for function names is obsolete (wasm-fork-instrument uses
# call-graph analysis); the flag is retained for general debuggability.
CFLAGS = -O2 -gline-tables-only

# Increase shadow stack from default 64KB to 1MB — git's deeply nested
# calls (strbuf_realpath, config parsing, snprintf) overflow 64KB.
# --no-wasm-opt prevents clang's built-in wasm-opt from stripping the
# name section after linking; retained so later tooling (wasm-opt -O2,
# wasm-fork-instrument) has symbol names available.
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

# Use zlib from sysroot
ZLIB_PATH = $SYSROOT

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

# Add curl-specific config if libcurl is available
if [ "$USE_CURL" = "yes" ]; then
    cat >> config.mak << ENDCURL

# HTTP/HTTPS transport via libcurl
# Note: NO_CURL is NOT set — this enables git-remote-http/https
# All library flags go in CURL_LDFLAGS (not CURL_LIBCURL) because git's
# Makefile resets CURL_LIBCURL when CURLDIR is unset, then appends CURL_LDFLAGS.
CURL_CFLAGS = -I$SYSROOT/include
CURL_LDFLAGS = -L$SYSROOT/lib -lcurl -lssl -lcrypto -ldl -lz
ENDCURL
else
    echo "NO_CURL = YesPlease" >> config.mak
fi

# --- Build ---
echo "==> Building git..."
NCPU="$(sysctl -n hw.ncpu 2>/dev/null || nproc)"

# Override uname_S to prevent config.mak.uname from applying Darwin-specific
# settings (HAVE_BSD_SYSCTL, precompose_utf8, etc.). Must be on the command
# line so it takes effect before config.mak.uname conditionals.
BUILD_TARGETS="git"
if [ "$USE_CURL" = "yes" ]; then
    BUILD_TARGETS="git git-remote-http"
fi
make uname_S=Wasm32 -j"$NCPU" $BUILD_TARGETS 2>&1 | tail -50

echo "==> Collecting binaries..."
mkdir -p "$BIN_DIR"

if [ ! -f "$SRC_DIR/git" ]; then
    echo "ERROR: git binary not found after build" >&2
    exit 1
fi

cp "$SRC_DIR/git" "$BIN_DIR/git.wasm"

# Collect git-remote-http if built
if [ "$USE_CURL" = "yes" ] && [ -f "$SRC_DIR/git-remote-http" ]; then
    cp "$SRC_DIR/git-remote-http" "$BIN_DIR/git-remote-http.wasm"
    echo "==> Collected git-remote-http.wasm"
fi
SIZE_BEFORE=$(wc -c < "$BIN_DIR/git.wasm" | tr -d ' ')
echo "==> Pre-instrument size: $(echo "$SIZE_BEFORE" | numfmt --to=iec 2>/dev/null || echo "${SIZE_BEFORE} bytes")"

# --- Size optimization + fork instrumentation ---
# wasm-opt -O2 runs first to shrink the binary. wasm-fork-instrument must
# run LAST because it hardcodes mutable-global offsets at instrument time —
# any later pass that reorders globals would corrupt the fork buffer.
# wasm-fork-instrument auto-discovers fork paths via call-graph analysis,
# so no onlylist is needed.
echo "==> Optimizing git.wasm with wasm-opt -O2..."
"$WASM_OPT" -g -O2 "$BIN_DIR/git.wasm" -o "$BIN_DIR/git.wasm"

echo "==> Applying fork instrumentation to git.wasm..."
"$FORK_INSTRUMENT" "$BIN_DIR/git.wasm" -o "$BIN_DIR/git.wasm.instr"
mv "$BIN_DIR/git.wasm.instr" "$BIN_DIR/git.wasm"

SIZE_AFTER=$(wc -c < "$BIN_DIR/git.wasm" | tr -d ' ')
echo "==> Post-instrument size: $(echo "$SIZE_AFTER" | numfmt --to=iec 2>/dev/null || echo "${SIZE_AFTER} bytes")"

# Apply the same pipeline to git-remote-http — libcurl may call fork()
# internally (e.g., for DNS resolution when pthreads are unavailable).
if [ "$USE_CURL" = "yes" ] && [ -f "$BIN_DIR/git-remote-http.wasm" ]; then
    echo "==> Optimizing + instrumenting git-remote-http.wasm..."
    RH_SIZE_BEFORE=$(wc -c < "$BIN_DIR/git-remote-http.wasm" | tr -d ' ')
    "$WASM_OPT" -g -O2 "$BIN_DIR/git-remote-http.wasm" -o "$BIN_DIR/git-remote-http.wasm"
    "$FORK_INSTRUMENT" "$BIN_DIR/git-remote-http.wasm" -o "$BIN_DIR/git-remote-http.wasm.instr"
    mv "$BIN_DIR/git-remote-http.wasm.instr" "$BIN_DIR/git-remote-http.wasm"
    RH_SIZE_AFTER=$(wc -c < "$BIN_DIR/git-remote-http.wasm" | tr -d ' ')
    echo "==> git-remote-http: $(echo "$RH_SIZE_BEFORE" | numfmt --to=iec 2>/dev/null || echo "${RH_SIZE_BEFORE}") -> $(echo "$RH_SIZE_AFTER" | numfmt --to=iec 2>/dev/null || echo "${RH_SIZE_AFTER}")"
fi

echo ""
echo "==> git built successfully with fork support!"
echo "Binary: $BIN_DIR/git.wasm"
if [ "$USE_CURL" = "yes" ] && [ -f "$BIN_DIR/git-remote-http.wasm" ]; then
    echo "HTTP transport: $BIN_DIR/git-remote-http.wasm"
fi
