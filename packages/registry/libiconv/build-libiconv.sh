#!/usr/bin/env bash
#
# Build GNU libiconv for wasm32/wasm64-posix-kernel.
#
# Honors the dep-resolver build-script contract. Resolver-provided builds set:
#   WASM_POSIX_DEP_OUT_DIR
#   WASM_POSIX_DEP_VERSION
#   WASM_POSIX_DEP_SOURCE_URL
#   WASM_POSIX_DEP_SOURCE_SHA256
#
# Legacy invocation installs into packages/registry/libiconv/libiconv-install.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SRC_DIR="$SCRIPT_DIR/libiconv-src"

# Worktree-local SDK on PATH (no global npm link required).
# shellcheck source=/dev/null
source "$REPO_ROOT/sdk/activate.sh"

LIBICONV_VERSION="${WASM_POSIX_DEP_VERSION:-${LIBICONV_VERSION:-1.17}}"
INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:-$SCRIPT_DIR/libiconv-install}"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://ftp.gnu.org/pub/gnu/libiconv/libiconv-${LIBICONV_VERSION}.tar.gz}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-}"

if ! command -v wasm32posix-cc &>/dev/null; then
    echo "ERROR: wasm32posix-cc not found. Run inside nix develop or source sdk/activate.sh with LLVM available." >&2
    exit 1
fi

SYSROOT="${WASM_POSIX_SYSROOT:-$REPO_ROOT/sysroot}"
export WASM_POSIX_SYSROOT="$SYSROOT"

if [ ! -d "$SRC_DIR" ]; then
    echo "==> Downloading GNU libiconv $LIBICONV_VERSION..."
    TARBALL="/tmp/libiconv-${LIBICONV_VERSION}.tar.gz"
    curl --retry 10 --retry-delay 5 --retry-max-time 300 --retry-all-errors -fsSL "$SOURCE_URL" -o "$TARBALL"
    if [ -n "$SOURCE_SHA256" ]; then
        echo "==> Verifying source sha256..."
        echo "$SOURCE_SHA256  $TARBALL" | shasum -a 256 -c -
    else
        echo "==> (no SOURCE_SHA256 declared; skipping verification)"
    fi
    mkdir -p "$SRC_DIR"
    tar xzf "$TARBALL" -C "$SRC_DIR" --strip-components=1
    rm "$TARBALL"
fi

cd "$SRC_DIR"
make distclean 2>/dev/null || true
rm -rf "$INSTALL_DIR"

echo "==> Configuring GNU libiconv for Wasm..."
wasm32posix-configure \
    --disable-shared \
    --enable-static \
    --disable-nls \
    --prefix="$INSTALL_DIR" \
    CFLAGS="-O2"

echo "==> Building GNU libiconv..."
make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)"

echo "==> Installing to $INSTALL_DIR..."
make install

mkdir -p "$INSTALL_DIR/lib/pkgconfig"
cat > "$INSTALL_DIR/lib/pkgconfig/libiconv.pc" <<PCEOF
prefix=$INSTALL_DIR
exec_prefix=\${prefix}
libdir=\${exec_prefix}/lib
includedir=\${prefix}/include

Name: libiconv
Description: GNU character set conversion library
Version: $LIBICONV_VERSION
Libs: -L\${libdir} -liconv -lcharset
Cflags: -I\${includedir}
PCEOF

if [ -f "$INSTALL_DIR/lib/libiconv.a" ] && [ -f "$INSTALL_DIR/lib/libcharset.a" ]; then
    echo "==> GNU libiconv build complete!"
    ls -lh "$INSTALL_DIR/lib/libiconv.a" "$INSTALL_DIR/lib/libcharset.a"
else
    echo "ERROR: Build failed — libiconv/libcharset archive missing" >&2
    exit 1
fi
