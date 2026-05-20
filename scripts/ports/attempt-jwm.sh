#!/usr/bin/env bash
set -euo pipefail

# Build a minimal JWM (Joe's Window Manager) port for the Kandelo Xfbdev demo.
# Optional image/font/X extension integrations are disabled for the first
# reusable desktop milestone; the target is a small libX11 window manager that
# can decorate and manage ordinary X clients.

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
VERSION="2.4.6"
URL="https://github.com/joewing/jwm/releases/download/v${VERSION}/jwm-${VERSION}.tar.xz"
SHA256="b5871ec28317594b3fa22b83ed5524cc911d498c455eaab3ae68def195dd802d"
WORK_DIR="${WASM_POSIX_PORT_WORKDIR:-$REPO_ROOT/.build-cache/ports/jwm-${VERSION}}"
TARBALL="$WORK_DIR/jwm-${VERSION}.tar.xz"
SRC_DIR="$WORK_DIR/jwm-${VERSION}"
LOG="$WORK_DIR/attempt.log"
LOCAL_INSTALL="$REPO_ROOT/local-binaries/programs/wasm32/jwm.wasm"

mkdir -p "$WORK_DIR"

if [ ! -f "$TARBALL" ]; then
    echo "==> Fetching $URL"
    curl -L --fail "$URL" -o "$TARBALL"
fi

actual_sha="$(shasum -a 256 "$TARBALL" | awk '{print $1}')"
if [ "$actual_sha" != "$SHA256" ]; then
    echo "sha256 mismatch for $TARBALL" >&2
    echo "expected: $SHA256" >&2
    echo "actual:   $actual_sha" >&2
    exit 1
fi

rm -rf "$SRC_DIR"
echo "==> Extracting source"
tar -xf "$TARBALL" -C "$WORK_DIR"

PATCH_DIR="$REPO_ROOT/scripts/ports/patches/jwm-${VERSION}"
if [ -d "$PATCH_DIR" ]; then
    echo "==> Applying JWM source patches"
    for patch_file in "$PATCH_DIR"/*.patch; do
        [ -f "$patch_file" ] || continue
        echo "  Applying $(basename "$patch_file")"
        patch -p1 -d "$SRC_DIR" < "$patch_file"
    done
fi

if [ -x "$REPO_ROOT/sdk/bin/wasm32posix-cc" ]; then
    CC="$REPO_ROOT/sdk/bin/wasm32posix-cc"
else
    CC="$(command -v wasm32posix-cc || true)"
fi
if [ -z "$CC" ]; then
    echo "wasm32posix-cc not found in PATH" >&2
    exit 1
fi

if [ -x "$REPO_ROOT/sdk/bin/wasm32posix-pkg-config" ]; then
    PKG_CONFIG_BIN="$REPO_ROOT/sdk/bin/wasm32posix-pkg-config"
else
    PKG_CONFIG_BIN="$(command -v wasm32posix-pkg-config || command -v pkg-config || true)"
fi
if [ -z "$PKG_CONFIG_BIN" ]; then
    echo "wasm32posix-pkg-config not found in PATH" >&2
    exit 1
fi

resolve_build_dep() {
    local name="$1"
    local host_target
    host_target="$(rustc -vV | awk '/^host/ {print $2}')"
    (
        cd "$REPO_ROOT"
        cargo run -p xtask --target "$host_target" --quiet -- build-deps resolve "$name"
    )
}

PKG_CONFIG_PATH_VALUE="${PKG_CONFIG_PATH:-}"

append_pkg_config_dir() {
    local prefix="$1"
    if [ -d "$prefix/lib/pkgconfig" ]; then
        if [ -n "$PKG_CONFIG_PATH_VALUE" ]; then
            PKG_CONFIG_PATH_VALUE="$prefix/lib/pkgconfig:$PKG_CONFIG_PATH_VALUE"
        else
            PKG_CONFIG_PATH_VALUE="$prefix/lib/pkgconfig"
        fi
    fi
}

resolve_and_append_dep() {
    local name="$1"
    local expected_pc="$2"
    local outvar="$3"
    local prefix

    echo "==> Resolving $name dependency" >&2
    prefix="$(resolve_build_dep "$name")"
    if [ ! -f "$prefix/lib/pkgconfig/$expected_pc" ]; then
        echo "$name pkg-config file not found at $prefix/lib/pkgconfig/$expected_pc" >&2
        exit 1
    fi
    append_pkg_config_dir "$prefix"
    printf -v "$outvar" "%s" "$prefix"
}

resolve_and_append_dep xorgproto xproto.pc XORGPROTO_DIR
resolve_and_append_dep xtrans xtrans.pc XTRANS_DIR
resolve_and_append_dep libxau xau.pc LIBXAU_DIR
resolve_and_append_dep xcb-proto xcb-proto.pc XCB_PROTO_DIR
resolve_and_append_dep pthread-stubs pthread-stubs.pc PTHREAD_STUBS_DIR
resolve_and_append_dep libxcb xcb.pc LIBXCB_DIR
resolve_and_append_dep libx11 x11.pc LIBX11_DIR

cflags="$(
    PKG_CONFIG_PATH="$PKG_CONFIG_PATH_VALUE" \
    "$PKG_CONFIG_BIN" --cflags x11
) -Wno-error=incompatible-function-pointer-types"
libs="$(
    PKG_CONFIG_PATH="$PKG_CONFIG_PATH_VALUE" \
    "$PKG_CONFIG_BIN" --libs --static x11
)"

rm -f "$LOG"
build_triplet="$("$SRC_DIR/config.guess")"
echo "==> Configuring JWM"
echo "source: $SRC_DIR" | tee -a "$LOG"
echo "cc:     $CC" | tee -a "$LOG"
echo "pkgcfg: $PKG_CONFIG_BIN" | tee -a "$LOG"
echo "pcpath: $PKG_CONFIG_PATH_VALUE" | tee -a "$LOG"
echo "cflags: $cflags" | tee -a "$LOG"
echo "libs:   $libs" | tee -a "$LOG"

(
    cd "$SRC_DIR"
    PKG_CONFIG="$PKG_CONFIG_BIN" \
    PKG_CONFIG_PATH="$PKG_CONFIG_PATH_VALUE" \
    CC="$CC" \
    CFLAGS="$cflags" \
    LIBS="$libs" \
    ac_cv_func_setlocale=no \
    ac_cv_func_iconv=no \
    ac_cv_lib_iconv_iconv=no \
    ./configure \
        --build="$build_triplet" \
        --host=wasm32-unknown-linux \
        --prefix=/usr \
        --sysconfdir=/etc \
        --x-includes="$LIBX11_DIR/include" \
        --x-libraries="$LIBX11_DIR/lib" \
        --disable-confirm \
        --disable-icons \
        --disable-png \
        --disable-cairo \
        --disable-rsvg \
        --disable-jpeg \
        --disable-xft \
        --disable-xrender \
        --disable-pango \
        --disable-xpm \
        --disable-xbm \
        --disable-shape \
        --disable-xmu \
        --disable-xinerama \
        --disable-nls \
        >>"$LOG" 2>&1

    gmake -j"$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)" LDFLAGS="$libs" >>"$LOG" 2>&1
)

mkdir -p "$(dirname "$LOCAL_INSTALL")"
install -m 755 "$SRC_DIR/src/jwm" "$LOCAL_INSTALL"
echo "installed: $LOCAL_INSTALL"
echo "log: $LOG"
