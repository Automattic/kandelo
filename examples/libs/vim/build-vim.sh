#!/usr/bin/env bash
set -euo pipefail

# Build Vim 9.1 for wasm32-posix-kernel.
#
# Uses the SDK's wasm32posix-configure wrapper for cross-compilation.
# Links against ncurses (must be built first via build-ncurses.sh).
# Applies asyncify with an onlylist so fork+exec works (:!command, filters).
#
# Output: examples/libs/vim/bin/vim.wasm

VIM_VERSION="${VIM_VERSION:-9.1.0900}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SRC_DIR="$SCRIPT_DIR/vim-src"
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

if [ ! -f "$SYSROOT/lib/libncursesw.a" ]; then
    echo "ERROR: ncurses not found. Run: bash examples/libs/ncurses/build-ncurses.sh" >&2
    exit 1
fi

# Check for wasm-opt (required for asyncify)
WASM_OPT="$(command -v wasm-opt 2>/dev/null || true)"
if [ -z "$WASM_OPT" ]; then
    echo "ERROR: wasm-opt not found. Install binaryen." >&2
    exit 1
fi

export WASM_POSIX_SYSROOT="$SYSROOT"

# --- Download Vim source ---
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Downloading vim $VIM_VERSION..."
    TARBALL="v${VIM_VERSION}.tar.gz"
    URL="https://github.com/vim/vim/archive/refs/tags/${TARBALL}"
    curl -fsSL "$URL" -o "/tmp/vim-$TARBALL"
    mkdir -p "$SRC_DIR"
    tar xzf "/tmp/vim-$TARBALL" -C "$SRC_DIR" --strip-components=1
    rm "/tmp/vim-$TARBALL"
    echo "==> Source extracted to $SRC_DIR"
fi

cd "$SRC_DIR"

# --- Configure ---
if [ ! -f src/auto/config.mk ]; then
    echo "==> Configuring vim for wasm32..."

    # Cross-compilation cache variables — vim's configure runs many tests
    # that can't execute on wasm32 target.
    export vim_cv_toupper_broken=no
    export vim_cv_terminfo=yes
    export vim_cv_tgetent=zero
    export vim_cv_getcwd_broken=no
    export vim_cv_stat_ignores_slash=no
    export vim_cv_memmove_handles_overlap=yes
    export vim_cv_bcopy_handles_overlap=yes
    export vim_cv_memcpy_handles_overlap=yes
    export vim_cv_timer_create=no
    export vim_cv_timer_create_with_lrt=no

    # Prevent macOS detection — vim uses uname to detect Darwin and
    # enables macOS-specific code (os_macosx) that doesn't compile on wasm32
    export vim_cv_uname_output=Linux
    export vim_cv_uname_m_output=wasm32
    export vim_cv_uname_r_output=6.1.0

    # General cross-compile values
    export ac_cv_func_malloc_0_nonnull=yes
    export ac_cv_func_realloc_0_nonnull=yes
    export ac_cv_func_calloc_0_nonnull=yes
    export ac_cv_func_strerror_r=yes
    export ac_cv_func_strerror_r_char_p=no
    export ac_cv_have_decl_strerror_r=yes
    export ac_cv_header_sys_inotify_h=no

    # Wasm32 type sizes
    export ac_cv_sizeof_long=4
    export ac_cv_sizeof_long_long=8
    export ac_cv_sizeof_unsigned_long=4
    export ac_cv_sizeof_int=4
    export ac_cv_sizeof_size_t=4
    export ac_cv_sizeof_void_p=4
    export ac_cv_sizeof_off_t=8

    # Functions musl doesn't have
    export ac_cv_func_sigaltstack=yes
    export ac_cv_func_getpwuid=yes
    export ac_cv_func_getpwnam=yes

    # -gline-tables-only for asyncify-onlylist function name matching
    # --no-wasm-opt to preserve name section
    export CFLAGS="-O2 -gline-tables-only"
    export LDFLAGS="--no-wasm-opt -Wl,-z,stack-size=1048576"
    export LIBS="-lncursesw -ltinfow"

    wasm32posix-configure \
        --with-features=normal \
        --with-tlib=tinfow \
        --disable-gui \
        --without-x \
        --disable-gpm \
        --disable-sysmouse \
        --disable-nls \
        --enable-multibyte \
        --disable-netbeans \
        --disable-channel \
        --disable-terminal \
        --disable-sound \
        --disable-canberra \
        --disable-libsodium \
        --disable-smack \
        --disable-selinux \
        --disable-xsmp \
        --disable-xsmp-interact \
        --disable-darwin \
        --with-compiledby="wasm32-posix-kernel" \
        --with-vim-name=vim \
        --with-modified-by="" \
        2>&1 | tail -30

    echo "==> Configure complete."

fi

# --- Build ---
# First pass: generate auto/osdef.h (make will fail due to sigsetjmp conflict)
if [ ! -f src/auto/osdef.h ]; then
    echo "==> Generating osdef.h..."
    make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" 2>&1 | tail -5 || true
fi

# Patch osdef.h — musl defines sigsetjmp as a macro, so the extern
# declaration in osdef.h conflicts. The osdef.sh script that generates
# this file runs on the host and can't detect the target's macros.
if grep -q 'extern int.*sigsetjmp' src/auto/osdef.h 2>/dev/null; then
    sed -i.bak 's/extern int.*sigsetjmp.*/\/* sigsetjmp is a macro in musl *\//' src/auto/osdef.h
    rm -f src/auto/osdef.h.bak
    echo "==> Patched osdef.h (sigsetjmp macro conflict)"
fi

echo "==> Building vim..."
make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" 2>&1 | tail -30

echo "==> Collecting binary..."
mkdir -p "$BIN_DIR"

if [ ! -f "$SRC_DIR/src/vim" ]; then
    echo "ERROR: vim binary not found after build" >&2
    exit 1
fi

cp "$SRC_DIR/src/vim" "$BIN_DIR/vim.wasm"
SIZE_BEFORE=$(wc -c < "$BIN_DIR/vim.wasm" | tr -d ' ')
echo "==> Pre-asyncify size: $(echo "$SIZE_BEFORE" | numfmt --to=iec 2>/dev/null || echo "${SIZE_BEFORE} bytes")"

# --- Asyncify transform with onlylist ---
if [ -f "$ONLYLIST" ]; then
    echo "==> Applying asyncify with onlylist..."

    # Build comma-separated function list from onlylist file (skip comments and blanks)
    ONLY_FUNCS=$(grep -v '^#' "$ONLYLIST" | grep -v '^\s*$' | tr -d ' ' | tr '\n' ',' | sed 's/,$//')

    # -g tells wasm-opt to read the name section from the binary
    "$WASM_OPT" -g --asyncify \
        --pass-arg="asyncify-imports@kernel.kernel_fork" \
        --pass-arg="asyncify-onlylist@${ONLY_FUNCS}" \
        "$BIN_DIR/vim.wasm" -o "$BIN_DIR/vim.wasm"

    # Optimize after asyncify to clean up
    "$WASM_OPT" -O2 "$BIN_DIR/vim.wasm" -o "$BIN_DIR/vim.wasm"
else
    echo "==> No asyncify-onlylist.txt found, skipping asyncify."
fi

SIZE_AFTER=$(wc -c < "$BIN_DIR/vim.wasm" | tr -d ' ')
echo "==> Final size: $(echo "$SIZE_AFTER" | numfmt --to=iec 2>/dev/null || echo "${SIZE_AFTER} bytes")"

echo ""
echo "==> vim built successfully!"
echo "Binary: $BIN_DIR/vim.wasm"
