#!/usr/bin/env bash
set -euo pipefail

# Build dash 0.5.12 for wasm32-posix-kernel.
#
# Uses the SDK's wasm32posix-configure wrapper for cross-compilation.
# Output: examples/libs/dash/dash-src/src/dash (wasm32 binary)

DASH_VERSION="${DASH_VERSION:-0.5.12}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SRC_DIR="$SCRIPT_DIR/dash-src"
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

# --- Download dash source ---
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Downloading dash $DASH_VERSION..."
    TARBALL="dash-${DASH_VERSION}.tar.gz"
    URL="http://gondor.apana.org.au/~herbert/dash/files/${TARBALL}"
    curl -fsSL "$URL" -o "/tmp/$TARBALL"
    mkdir -p "$SRC_DIR"
    tar xzf "/tmp/$TARBALL" -C "$SRC_DIR" --strip-components=1
    rm "/tmp/$TARBALL"
    echo "==> Source extracted to $SRC_DIR"
fi

cd "$SRC_DIR"

# --- Configure ---
if [ ! -f Makefile ]; then
    echo "==> Configuring dash for wasm32..."

    # Cross-compilation can't run test programs, so link-based checks fail.
    # Override with correct results for musl on wasm32.
    wasm32posix-configure \
        --with-libedit=no \
        ac_cv_func_fnmatch_works=yes \
        ac_cv_func_strtod=yes \
        ac_cv_func_strtoimax=yes \
        ac_cv_func_strtoumax=yes \
        ac_cv_func_killpg=yes \
        ac_cv_func_signal=yes \
        ac_cv_func_sysconf=yes \
        ac_cv_func_strchrnul=yes \
        ac_cv_func_strsignal=yes \
        ac_cv_func_fnmatch=yes \
        ac_cv_func_bsearch=yes \
        ac_cv_func_getpwnam=yes \
        ac_cv_func_getrlimit=yes \
        ac_cv_func_isdigit=yes \
        ac_cv_func_mempcpy=no \
        ac_cv_func_sigsetmask=no \
        ac_cv_func_bsd_signal=no \
        ac_cv_func_imaxdiv=yes \
        ac_cv_func_open64=no \
        ac_cv_func_stat64=no \
        ac_cv_have_decl_stat64=no \
        ac_cv_func_glob64=no \
        dash_cv_type_rlim_t=long\ long \
        2>&1 | tail -20

    echo "==> Configure complete."
fi

# --- Fix signal name table ---
# mksignames runs on the build host and generates signames.c using macOS
# signal numbers (e.g., SIGUSR1=30). Replace with Linux/wasm32 numbers.
#
# We must write signames.c AFTER make would regenerate it. The Makefile rule
#   signames.c: mksignames
#       ./mksignames
# causes a pre-patched signames.c to be overwritten during make because
# mksignames is built during the same make run (via BUILT_SOURCES) and ends
# up with a newer mtime than the patched file. Two-pass build: run make
# once to generate mksignames and the (wrong) signames.c, then patch
# signames.c, bump its mtime so it beats mksignames, then rebuild.
#
# Dropping signames.o and the dash binary forces the linker to re-run with
# our patched signames.c.
echo "==> First build (generates mksignames + macOS-numbered signames.c)..."
make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" 2>&1 | tail -5

echo "==> Patching signames.c for Linux/wasm32 signal numbers..."
cat > src/signames.c << 'SIGEOF'
/* Linux/wasm32 signal names — generated from musl bits/signal.h.
   The host-generated version has macOS signal numbers which are wrong
   for wasm32 (e.g., SIGUSR1=30 on macOS vs 10 on Linux). */

#include <signal.h>

const char *const signal_names[NSIG + 1] = {
    "EXIT",     /*  0 */
    "HUP",      /*  1 */
    "INT",      /*  2 */
    "QUIT",     /*  3 */
    "ILL",      /*  4 */
    "TRAP",     /*  5 */
    "ABRT",     /*  6 */
    "BUS",      /*  7 */
    "FPE",      /*  8 */
    "KILL",     /*  9 */
    "USR1",     /* 10 */
    "SEGV",     /* 11 */
    "USR2",     /* 12 */
    "PIPE",     /* 13 */
    "ALRM",     /* 14 */
    "TERM",     /* 15 */
    "STKFLT",   /* 16 */
    "CHLD",     /* 17 */
    "CONT",     /* 18 */
    "STOP",     /* 19 */
    "TSTP",     /* 20 */
    "TTIN",     /* 21 */
    "TTOU",     /* 22 */
    "URG",      /* 23 */
    "XCPU",     /* 24 */
    "XFSZ",     /* 25 */
    "VTALRM",   /* 26 */
    "PROF",     /* 27 */
    "WINCH",    /* 28 */
    "IO",       /* 29 */
    "PWR",      /* 30 */
    "SYS",      /* 31 */
    /* entries 32..NSIG are implicitly zero-initialized (NULL) */
};
SIGEOF

# Ensure signames.c is newer than mksignames so `make` won't regenerate it.
touch src/signames.c

# --- Rebuild with patched signames.c ---
echo "==> Rebuilding with patched signames.c..."
rm -f src/signames.o src/dash
make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" 2>&1 | tail -10

DASH_BIN="$SRC_DIR/src/dash"
if [ ! -f "$DASH_BIN" ]; then
    echo "ERROR: dash binary not found after build" >&2
    exit 1
fi

# --- Asyncify for fork support ---
# Command substitution ($(...)), pipes, and subshells all use fork().
# Asyncify lets the fork child resume from the fork point.
WASM_OPT="$(command -v wasm-opt 2>/dev/null || true)"
if [ -n "$WASM_OPT" ]; then
    echo "==> Applying asyncify transform..."
    "$WASM_OPT" --asyncify \
        --pass-arg="asyncify-imports@kernel.kernel_fork" \
        "$DASH_BIN" -o "$DASH_BIN"
else
    echo "WARNING: wasm-opt not found. Fork (command substitution, pipes) will not work." >&2
fi

echo "==> dash built successfully!"

# Copy to bin/ with .wasm extension (consistent with coreutils/grep/sed, needed for Vite)
mkdir -p "$SCRIPT_DIR/bin"
cp "$DASH_BIN" "$SCRIPT_DIR/bin/dash.wasm"

# Install into local-binaries/ so the resolver picks it up as an override.
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary dash "$SCRIPT_DIR/bin/dash.wasm"
# sh ships as an alias for dash in the release; install the same bytes
# under that name so `programs/sh.wasm` also resolves locally.
install_local_binary sh "$SCRIPT_DIR/bin/dash.wasm"

ls -lh "$SCRIPT_DIR/bin/dash.wasm"
echo ""
echo "Run with:"
echo "  npx tsx examples/shell/serve.ts"
