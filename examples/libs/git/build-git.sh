#!/usr/bin/env bash
set -euo pipefail

# Build Git 2.47.1 for wasm32-posix-kernel.
#
# Git uses a Makefile-based build system (no autoconf). Cross-compilation
# is done via config.mak overrides.
# Output: examples/libs/git/bin/git.wasm

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

# Check for zlib (required)
if [ ! -f "$SYSROOT/lib/libz.a" ]; then
    echo "ERROR: zlib not found in sysroot. Build it first." >&2
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

# Optimization
CFLAGS = -O2

# Disable optional features that need unavailable infrastructure
NO_PERL = YesPlease
NO_PYTHON = YesPlease
NO_TCLTK = YesPlease
NO_GETTEXT = YesPlease
NO_EXPAT = YesPlease
NO_CURL = YesPlease
NO_ICONV = YesPlease
NO_REGEX = NeedsStartEnd
NO_NSEC = YesPlease
NO_INSTALL_HARDLINKS = YesPlease

# Disable features that require runtime infrastructure we don't have
NO_UNIX_SOCKETS = YesPlease

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

# --- Build ---
echo "==> Building git..."
# Override uname_S to prevent config.mak.uname from applying Darwin-specific
# settings (HAVE_BSD_SYSCTL, precompose_utf8, etc.). Must be on the command
# line so it takes effect before config.mak.uname conditionals.
make uname_S=Wasm32 -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" git 2>&1 | tail -50

echo "==> Collecting binary..."
mkdir -p "$BIN_DIR"

if [ -f "$SRC_DIR/git" ]; then
    cp "$SRC_DIR/git" "$BIN_DIR/git.wasm"
    echo "==> Built git"
    ls -lh "$BIN_DIR/git.wasm"
else
    echo "ERROR: git binary not found after build" >&2
    exit 1
fi

echo ""
echo "==> git built successfully!"
echo "Binary: $BIN_DIR/git.wasm"
