#!/usr/bin/env bash
set -euo pipefail

# Build TCL 8.6.16 for wasm32-posix-kernel.
#
# Output:
#   tcl-install/lib/libtcl8.6.a   — static library
#   tcl-install/include/*.h        — headers
#   tcl-install/lib/tcl8.6/        — runtime library (init.tcl, encoding/, etc.)
#   bin/tclsh.wasm                 — standalone interpreter (optional validation)

TCL_VERSION="${TCL_VERSION:-8.6.16}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SRC_DIR="$SCRIPT_DIR/tcl-src"
BUILD_DIR="$SCRIPT_DIR/tcl-build"
INSTALL_DIR="$SCRIPT_DIR/tcl-install"
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

# --- Download TCL source ---
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Downloading TCL $TCL_VERSION..."
    TARBALL="tcl${TCL_VERSION}-src.tar.gz"
    URL="https://prdownloads.sourceforge.net/tcl/${TARBALL}"
    curl --retry 10 --retry-delay 5 --retry-max-time 300 --retry-all-errors -fsSL "$URL" -o "/tmp/$TARBALL"
    mkdir -p "$SRC_DIR"
    tar xzf "/tmp/$TARBALL" -C "$SRC_DIR" --strip-components=1
    rm "/tmp/$TARBALL"
    echo "==> Source extracted to $SRC_DIR"
fi

# --- Configure ---
mkdir -p "$BUILD_DIR"
cd "$BUILD_DIR"

if [ ! -f Makefile ]; then
    echo "==> Configuring TCL for wasm32..."

    CONFIG_SITE="$SCRIPT_DIR/config.site-wasm32-posix" \
    CC=wasm32posix-cc \
    AR=wasm32posix-ar \
    RANLIB=wasm32posix-ranlib \
    CFLAGS="-O2" \
    "$SRC_DIR/unix/configure" \
        --host=wasm32-unknown-none \
        --build="$(uname -m)-apple-darwin" \
        --prefix=/usr \
        --disable-threads \
        --disable-shared \
        --disable-load \
        --enable-corefoundation=no \
        2>&1 | tail -30

    echo "==> Configure complete."
fi

# --- Post-configure patches ---

# 1. Force tclLoadNone.o (no dynamic loading)
if grep -q 'DL_OBJS.*tclLoadDl' Makefile 2>/dev/null; then
    echo "==> Patching Makefile: force tclLoadNone.o..."
    sed -i.bak 's/DL_OBJS.*=.*/DL_OBJS = tclLoadNone.o/' Makefile
fi

# 2. Strip -ldl -lm -lpthread from link flags (SDK handles these)
if grep -q '\-ldl\|\-lpthread' Makefile 2>/dev/null; then
    echo "==> Patching Makefile: strip -ldl -lm -lpthread..."
    sed -i.bak \
        -e 's/-ldl//g' \
        -e 's/-lpthread//g' \
        Makefile
fi

# 3. Remove -lm from MATH_LIBS if present (musl libc includes math)
if grep -q 'MATH_LIBS.*=.*-lm' Makefile 2>/dev/null; then
    echo "==> Patching Makefile: strip -lm from MATH_LIBS..."
    sed -i.bak 's/MATH_LIBS[[:space:]]*=.*-lm.*/MATH_LIBS = /' Makefile
fi

# 4. Disable TCL_WIDE_CLICKS (only implemented for macOS mach_absolute_time)
if grep -q 'DTCL_WIDE_CLICKS' Makefile 2>/dev/null; then
    echo "==> Patching Makefile: disable TCL_WIDE_CLICKS..."
    sed -i.bak 's/-DTCL_WIDE_CLICKS=1//g' Makefile
fi

# 5. Disable TCL_LOAD_FROM_MEMORY (macOS-only feature)
if grep -q 'DTCL_LOAD_FROM_MEMORY' Makefile 2>/dev/null; then
    echo "==> Patching Makefile: disable TCL_LOAD_FROM_MEMORY..."
    sed -i.bak 's/-DTCL_LOAD_FROM_MEMORY=1//g' Makefile
fi

# 6. Disable chflags/getattrlist (macOS-only, configure detected via link test)
if grep -q 'DHAVE_CHFLAGS' Makefile 2>/dev/null; then
    echo "==> Patching Makefile: disable macOS-specific features..."
    sed -i.bak \
        -e 's/-DHAVE_CHFLAGS=1//g' \
        -e 's/-DHAVE_MKSTEMPS=1//g' \
        -e 's/-DHAVE_GETATTRLIST=1//g' \
        Makefile
fi

# 7. Remove -mdynamic-no-pic (macOS-only compiler flag)
if grep -q 'mdynamic-no-pic' Makefile 2>/dev/null; then
    echo "==> Patching Makefile: remove -mdynamic-no-pic..."
    sed -i.bak 's/-mdynamic-no-pic//g' Makefile
fi

# --- Build ---
# Build only the core library + tclsh, skip bundled packages (sqlite3, itcl,
# tdbc, etc.) — they fail on wasm32 and we don't need them.
echo "==> Building TCL core library..."
make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" libtcl8.6.a tclsh 2>&1 | tail -20

# --- Install ---
# Manual install (make install tries to build packages). Install just what we need:
#   lib/libtcl8.6.a, include/*.h, lib/tcl8.6/ (runtime), bin/tclsh8.6
echo "==> Installing to $INSTALL_DIR..."
rm -rf "$INSTALL_DIR"

# Headers
mkdir -p "$INSTALL_DIR/include"
cp "$SRC_DIR/generic/tcl.h" "$INSTALL_DIR/include/"
cp "$SRC_DIR/generic/tclDecls.h" "$INSTALL_DIR/include/"
cp "$SRC_DIR/generic/tclPlatDecls.h" "$INSTALL_DIR/include/"
cp "$SRC_DIR/generic/tclTomMath.h" "$INSTALL_DIR/include/"
cp "$SRC_DIR/generic/tclTomMathDecls.h" "$INSTALL_DIR/include/"
cp "$SRC_DIR/generic/tclOO.h" "$INSTALL_DIR/include/"
cp "$SRC_DIR/generic/tclOODecls.h" "$INSTALL_DIR/include/"

# Static library
mkdir -p "$INSTALL_DIR/lib"
cp "$BUILD_DIR/libtcl8.6.a" "$INSTALL_DIR/lib/"

# Runtime library (init.tcl, encoding/, etc.)
mkdir -p "$INSTALL_DIR/lib/tcl8.6"
cp -a "$SRC_DIR/library/"* "$INSTALL_DIR/lib/tcl8.6/"
# Also need the encoding files
if [ -d "$SRC_DIR/library/encoding" ]; then
    cp -a "$SRC_DIR/library/encoding" "$INSTALL_DIR/lib/tcl8.6/"
fi

# tclsh binary
mkdir -p "$INSTALL_DIR/bin"
if [ -f "$BUILD_DIR/tclsh" ]; then
    cp "$BUILD_DIR/tclsh" "$INSTALL_DIR/bin/tclsh8.6"
fi

# --- Asyncify for fork support ---
# TCL's exec command uses fork(). Apply asyncify to tclsh.
TCLSH="$INSTALL_DIR/bin/tclsh8.6"
if [ -f "$TCLSH" ]; then
    WASM_OPT="$(command -v wasm-opt 2>/dev/null || true)"
    if [ -n "$WASM_OPT" ]; then
        echo "==> Applying asyncify to tclsh..."
        "$WASM_OPT" --asyncify \
            --pass-arg="asyncify-imports@kernel.kernel_fork" \
            "$TCLSH" -o "$TCLSH"
    else
        echo "WARNING: wasm-opt not found. Fork (exec command) will not work in tclsh." >&2
    fi

    # Copy to bin/ with .wasm extension
    mkdir -p "$SCRIPT_DIR/bin"
    cp "$TCLSH" "$SCRIPT_DIR/bin/tclsh.wasm"
    echo "==> tclsh.wasm built:"
    ls -lh "$SCRIPT_DIR/bin/tclsh.wasm"
fi

# --- Verify ---
if [ -f "$INSTALL_DIR/lib/libtcl8.6.a" ]; then
    echo "==> TCL build complete!"
    ls -lh "$INSTALL_DIR/lib/libtcl8.6.a"
    echo ""
    echo "Validate with:"
    echo "  echo 'puts \"hello from tcl [info patchlevel]\"' | \\"
    echo "    TCL_LIBRARY=$INSTALL_DIR/lib/tcl8.6 npx tsx examples/run-example.ts tclsh"
else
    echo "ERROR: Build failed — libtcl8.6.a not found" >&2
    exit 1
fi

# Install into local-binaries/ so the resolver picks the freshly-built
# binary over the fetched release.
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary tcl "$SCRIPT_DIR/bin/tclsh.wasm"

# Manifest declares `wasm = "tclsh.wasm"` (not tcl.wasm), so the
# resolver's $WASM_POSIX_DEP_OUT_DIR scratch needs the file under that
# exact name. The helper's default-fallback uses <program>.<ext>.
if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    cp "$SCRIPT_DIR/bin/tclsh.wasm" "$WASM_POSIX_DEP_OUT_DIR/tclsh.wasm"
    echo "  installed $WASM_POSIX_DEP_OUT_DIR/tclsh.wasm (manifest output name)"
fi
