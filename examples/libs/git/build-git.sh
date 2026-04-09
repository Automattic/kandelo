#!/usr/bin/env bash
set -euo pipefail

# Build Git 2.47.1 for wasm32-posix-kernel.
#
# Git uses a Makefile-based build system (no autoconf). Cross-compilation
# is done via config.mak overrides.
#
# Asyncify is applied with an onlylist so fork+exec works properly
# (git gc --auto, hooks, pager, credential helpers, etc.).
#
# Output: examples/libs/git/bin/git.wasm

GIT_VERSION="${GIT_VERSION:-2.47.1}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SRC_DIR="$SCRIPT_DIR/git-src"
BIN_DIR="$SCRIPT_DIR/bin"
SYSROOT="$REPO_ROOT/sysroot"
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

# Check for zlib (required)
if [ ! -f "$SYSROOT/lib/libz.a" ]; then
    echo "ERROR: zlib not found in sysroot. Build it first." >&2
    exit 1
fi

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

if [ ! -f "$SRC_DIR/git" ]; then
    echo "ERROR: git binary not found after build" >&2
    exit 1
fi

cp "$SRC_DIR/git" "$BIN_DIR/git.wasm"
SIZE_BEFORE=$(wc -c < "$BIN_DIR/git.wasm" | tr -d ' ')
echo "==> Pre-asyncify size: $(echo "$SIZE_BEFORE" | numfmt --to=iec 2>/dev/null || echo "${SIZE_BEFORE} bytes")"

# --- Asyncify transform with onlylist ---
echo "==> Applying asyncify with onlylist..."

# Build comma-separated function list from onlylist file (skip comments and blanks)
ONLY_FUNCS=$(grep -v '^#' "$ONLYLIST" | grep -v '^\s*$' | tr -d ' ' | tr '\n' ',' | sed 's/,$//')

# -g tells wasm-opt to read the name section from the binary
"$WASM_OPT" -g --asyncify \
    --pass-arg="asyncify-imports@kernel.kernel_fork" \
    --pass-arg="asyncify-onlylist@${ONLY_FUNCS}" \
    "$BIN_DIR/git.wasm" -o "$BIN_DIR/git.wasm"

# Optimize after asyncify to clean up
"$WASM_OPT" -O2 "$BIN_DIR/git.wasm" -o "$BIN_DIR/git.wasm"

SIZE_AFTER=$(wc -c < "$BIN_DIR/git.wasm" | tr -d ' ')
echo "==> Post-asyncify size: $(echo "$SIZE_AFTER" | numfmt --to=iec 2>/dev/null || echo "${SIZE_AFTER} bytes")"

echo ""
echo "==> git built successfully with asyncify fork support!"
echo "Binary: $BIN_DIR/git.wasm"
