#!/usr/bin/env bash
set -euo pipefail

# First-pass Xfbdev port harness.
#
# This intentionally lives outside the package matrix until the dependency
# chain is understood. It fetches an upstream xorg-server release that still
# carries the KDrive/Xfbdev path, then runs configure with wasm32posix tools and
# records the first blocker.

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
VERSION="1.19.7"
URL="https://xorg.freedesktop.org/releases/individual/xserver/xorg-server-${VERSION}.tar.gz"
SHA256="5f6d3da0d1e341f27a7706779a24a5fa7174d5f161b5f8530f103753f0152de7"
WORK_DIR="${WASM_POSIX_PORT_WORKDIR:-$REPO_ROOT/.build-cache/ports/xorg-server-${VERSION}-xfbdev}"
TARBALL="$WORK_DIR/xorg-server-${VERSION}.tar.gz"
SRC_DIR="$WORK_DIR/xorg-server-${VERSION}"
BUILD_DIR="$WORK_DIR/build-wasm32"
LOG="$WORK_DIR/attempt.log"
COMPLETE_MARKER="$WORK_DIR/build-complete"
LOCAL_INSTALL="$REPO_ROOT/local-binaries/programs/wasm32/Xfbdev.wasm"

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

if [ ! -d "$SRC_DIR" ]; then
    echo "==> Extracting source"
    tar -xzf "$TARBALL" -C "$WORK_DIR"
fi

PATCH_DIR="$REPO_ROOT/scripts/ports/patches/xorg-server-${VERSION}-xfbdev"
if [ -d "$PATCH_DIR" ]; then
    echo "==> Applying Xfbdev source patches"
    for patch_file in "$PATCH_DIR"/*.patch; do
        [ -f "$patch_file" ] || continue
        patch_name="$(basename "$patch_file")"
        if patch -p1 -N --dry-run --silent -d "$SRC_DIR" < "$patch_file" >/dev/null 2>&1; then
            echo "  Applying $patch_name"
            patch -p1 -N -d "$SRC_DIR" < "$patch_file"
        else
            echo "  Skipping $patch_name (already applied or not applicable)"
        fi
    done
fi

if [ -x "$REPO_ROOT/sdk/bin/wasm32posix-cc" ]; then
    DEFAULT_CC="$REPO_ROOT/sdk/bin/wasm32posix-cc"
else
    DEFAULT_CC="$(command -v wasm32posix-cc || true)"
fi
CC="${CC:-$DEFAULT_CC}"
if [ -z "$CC" ]; then
    echo "wasm32posix-cc not found in PATH" >&2
    exit 1
fi
if [ -x "$REPO_ROOT/sdk/bin/wasm32posix-pkg-config" ]; then
    DEFAULT_PKG_CONFIG_BIN="$REPO_ROOT/sdk/bin/wasm32posix-pkg-config"
else
    DEFAULT_PKG_CONFIG_BIN="$(command -v wasm32posix-pkg-config || command -v pkg-config || true)"
fi
PKG_CONFIG_BIN="${PKG_CONFIG:-$DEFAULT_PKG_CONFIG_BIN}"
if [ -z "$PKG_CONFIG_BIN" ]; then
    echo "pkg-config not found in PATH" >&2
    exit 1
fi
AR_BIN="${AR:-$REPO_ROOT/sdk/bin/wasm32posix-ar}"
RANLIB_BIN="${RANLIB:-$REPO_ROOT/sdk/bin/wasm32posix-ranlib}"
NM_BIN="${NM:-$REPO_ROOT/sdk/bin/wasm32posix-nm}"

resolve_build_dep() {
    local name="$1"
    local host_target

    if ! command -v cargo >/dev/null || ! command -v rustc >/dev/null; then
        return 1
    fi

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

RESOLVED_DEPS_LOG=""

resolve_and_append_dep() {
    local name="$1"
    local override_prefix="$2"
    local expected_pc="$3"
    local prefix="$override_prefix"

    if [ -z "$prefix" ]; then
        echo "==> Resolving $name dependency"
        if ! prefix="$(resolve_build_dep "$name")"; then
            echo "warning: $name dependency could not be resolved; configure will report the blocker" >&2
            prefix=""
        fi
    fi

    if [ -n "$prefix" ]; then
        if [ -n "$expected_pc" ] && [ ! -f "$prefix/lib/pkgconfig/$expected_pc" ]; then
            echo "$name pkg-config file not found at $prefix/lib/pkgconfig/$expected_pc" >&2
            exit 1
        fi
        append_pkg_config_dir "$prefix"
    fi

    RESOLVED_DEPS_LOG="${RESOLVED_DEPS_LOG}${name}: ${prefix:-unresolved}
"
}

resolve_and_append_dep zlib "${XFBDEV_ZLIB_DIR:-}" "zlib.pc"
resolve_and_append_dep xorgproto "${XFBDEV_XORGPROTO_DIR:-}" "xproto.pc"
resolve_and_append_dep xtrans "${XFBDEV_XTRANS_DIR:-}" "xtrans.pc"
resolve_and_append_dep pixman "${XFBDEV_PIXMAN_DIR:-}" "pixman-1.pc"
resolve_and_append_dep libxau "${XFBDEV_LIBXAU_DIR:-}" "xau.pc"
resolve_and_append_dep xcb-proto "${XFBDEV_XCB_PROTO_DIR:-}" "xcb-proto.pc"
resolve_and_append_dep pthread-stubs "${XFBDEV_PTHREAD_STUBS_DIR:-}" "pthread-stubs.pc"
resolve_and_append_dep libxcb "${XFBDEV_LIBXCB_DIR:-}" "xcb.pc"
resolve_and_append_dep libx11 "${XFBDEV_LIBX11_DIR:-}" "x11.pc"
resolve_and_append_dep openssl "${XFBDEV_OPENSSL_DIR:-}" "openssl.pc"
resolve_and_append_dep libfontenc "${XFBDEV_LIBFONTENC_DIR:-}" "fontenc.pc"
resolve_and_append_dep libxfont2 "${XFBDEV_LIBXFONT2_DIR:-}" "xfont2.pc"
resolve_and_append_dep libxkbfile "${XFBDEV_LIBXKBFILE_DIR:-}" "xkbfile.pc"

rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"
rm -f "$LOG"
rm -f "$COMPLETE_MARKER"

build_triplet="$("$SRC_DIR/config.guess")"
host_triplet="${XFBDEV_HOST_TRIPLET:-wasm32-unknown-linux}"
port_cflags="${CFLAGS:-} -Wno-error=incompatible-function-pointer-types -Wno-incompatible-function-pointer-types -D__uid_t=uid_t -D__gid_t=gid_t"
zlib_libs="$(
    PKG_CONFIG_PATH="$PKG_CONFIG_PATH_VALUE" \
    "$PKG_CONFIG_BIN" --libs zlib
)"
port_libs="${LIBS:-} $zlib_libs"

echo "==> Configuring Xfbdev candidate"
echo "source: $SRC_DIR" | tee -a "$LOG"
echo "build:  $BUILD_DIR" | tee -a "$LOG"
echo "cc:     $CC" | tee -a "$LOG"
echo "pkgcfg: $PKG_CONFIG_BIN" | tee -a "$LOG"
echo "ar:     $AR_BIN" | tee -a "$LOG"
echo "ranlib: $RANLIB_BIN" | tee -a "$LOG"
echo "nm:     $NM_BIN" | tee -a "$LOG"
printf "%s" "$RESOLVED_DEPS_LOG" | sed 's/^/dep:    /' | tee -a "$LOG"
echo "pcpath: ${PKG_CONFIG_PATH_VALUE:-empty}" | tee -a "$LOG"
echo "host:   $host_triplet" | tee -a "$LOG"
echo "libs:   $port_libs" | tee -a "$LOG"

(
    cd "$BUILD_DIR"
    set +e
    PKG_CONFIG="$PKG_CONFIG_BIN" \
    PKG_CONFIG_PATH="$PKG_CONFIG_PATH_VALUE" \
    CC="$CC" \
    AR="$AR_BIN" \
    RANLIB="$RANLIB_BIN" \
    NM="$NM_BIN" \
    CFLAGS="$port_cflags" \
    LIBS="$port_libs" \
    ac_cv_func_backtrace=no \
    ac_cv_func_getpeereid=no \
    ac_cv_func_getpeerucred=no \
    ac_cv_func_getzoneid=no \
    ac_cv_func_timingsafe_memcmp=no \
    "$SRC_DIR/configure" \
        --build="$build_triplet" \
        --host="$host_triplet" \
        --prefix=/usr \
        --disable-xorg \
        --disable-xvfb \
        --disable-xnest \
        --disable-xquartz \
        --disable-xwin \
        --disable-xephyr \
        --enable-kdrive \
        --enable-xfbdev \
        --enable-kdrive-evdev \
        --disable-kdrive-kbd \
        --disable-kdrive-mouse \
        --disable-dmx \
        --disable-glx \
        --disable-dri \
        --disable-dri2 \
        --disable-dri3 \
        --disable-present \
        --disable-mitshm \
        --disable-secure-rpc \
        --disable-xinerama \
        --disable-xace \
        --disable-xselinux \
        --disable-config-udev \
        --disable-config-hal \
        --disable-systemd-logind \
        --disable-unit-tests \
        --without-dtrace \
        --with-sha1=libcrypto \
        >>"$LOG" 2>&1
    status=$?
    set -e
    if [ "$status" -ne 0 ]; then
        echo "==> configure stopped with status $status"
        echo "==> first blocker is in $LOG"
        tail -80 "$LOG"
        exit 0
    fi

    echo "==> Configure succeeded; attempting a build"
    set +e
    make -j"$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)" >>"$LOG" 2>&1
    status=$?
    set -e
    if [ "$status" -ne 0 ]; then
        echo "==> make stopped with status $status"
        echo "==> first blocker is in $LOG"
        tail -80 "$LOG"
        exit 0
    fi
    touch "$COMPLETE_MARKER"
)

if [ -f "$COMPLETE_MARKER" ]; then
    echo "==> Xfbdev candidate build completed"
    mkdir -p "$(dirname "$LOCAL_INSTALL")"
    install -m 755 "$BUILD_DIR/hw/kdrive/fbdev/Xfbdev" "$LOCAL_INSTALL"
    echo "installed: $LOCAL_INSTALL"
else
    echo "==> Xfbdev attempt completed; blocker recorded"
fi
echo "log: $LOG"
