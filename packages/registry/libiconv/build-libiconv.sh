#!/usr/bin/env bash
#
# Build GNU libiconv for wasm32-posix-kernel.
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
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/kandelo-libiconv.XXXXXX")"
trap 'rm -rf "$WORK_DIR"' EXIT
SRC_DIR="$WORK_DIR/source"
STAGE_DIR="$WORK_DIR/stage"

# Worktree-local SDK on PATH (no global npm link required).
# shellcheck source=/dev/null
source "$REPO_ROOT/sdk/activate.sh"

LIBICONV_VERSION="${WASM_POSIX_DEP_VERSION:-${LIBICONV_VERSION:-1.17}}"
INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:-$SCRIPT_DIR/libiconv-install}"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://ftp.gnu.org/pub/gnu/libiconv/libiconv-${LIBICONV_VERSION}.tar.gz}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-8f74213b56238c85a50a5329f77e06198771e70dd9a739779f4c02f65d971313}"
TARGET_ARCH="${WASM_POSIX_DEP_TARGET_ARCH:-wasm32}"

if [ "$TARGET_ARCH" != "wasm32" ]; then
    echo "ERROR: libiconv currently supports only wasm32, got $TARGET_ARCH" >&2
    exit 1
fi

if ! command -v wasm32posix-cc &>/dev/null; then
    echo "ERROR: wasm32posix-cc not found. Run inside nix develop or source sdk/activate.sh with LLVM available." >&2
    exit 1
fi

SYSROOT="${WASM_POSIX_SYSROOT:-$REPO_ROOT/sysroot}"
export WASM_POSIX_SYSROOT="$SYSROOT"

echo "==> Downloading GNU libiconv $LIBICONV_VERSION..."
TARBALL="$WORK_DIR/libiconv.tar.gz"
curl --retry 10 --retry-delay 5 --retry-max-time 300 --retry-all-errors -fsSL "$SOURCE_URL" -o "$TARBALL"
echo "==> Verifying source sha256..."
echo "$SOURCE_SHA256  $TARBALL" | shasum -a 256 -c -
mkdir -p "$SRC_DIR"
tar xzf "$TARBALL" -C "$SRC_DIR" --strip-components=1

cd "$SRC_DIR"
rm -rf "$INSTALL_DIR"

echo "==> Configuring GNU libiconv for Wasm..."
wasm32posix-configure \
    --disable-shared \
    --enable-static \
    --disable-nls \
    --prefix=/usr \
    CFLAGS="-O2"

echo "==> Building GNU libiconv..."
make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)"

echo "==> Staging declared package outputs..."
make install DESTDIR="$STAGE_DIR"
rm -rf "$INSTALL_DIR"
mkdir -p "$INSTALL_DIR/lib" "$INSTALL_DIR/include"
cp "$STAGE_DIR/usr/lib/libiconv.a" "$INSTALL_DIR/lib/"
cp "$STAGE_DIR/usr/lib/libcharset.a" "$INSTALL_DIR/lib/"
cp "$STAGE_DIR/usr/include/iconv.h" "$INSTALL_DIR/include/"
cp "$STAGE_DIR/usr/include/libcharset.h" "$INSTALL_DIR/include/"
cp "$STAGE_DIR/usr/include/localcharset.h" "$INSTALL_DIR/include/"

mkdir -p "$INSTALL_DIR/lib/pkgconfig"
cat > "$INSTALL_DIR/lib/pkgconfig/libiconv.pc" <<PCEOF
prefix=\${pcfiledir}/../..
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
