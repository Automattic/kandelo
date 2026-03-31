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

# --- Build ---
echo "==> Building dash..."
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
ls -lh "$DASH_BIN"
echo ""
echo "Run with:"
echo "  npx tsx examples/shell/serve.ts"
