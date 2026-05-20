#!/usr/bin/env bash
set -euo pipefail

# Build small libX11 desktop demo clients. These are intentionally separate
# from scripts/build-programs.sh because they link against cached X11 libs.

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT_DIR="$REPO_ROOT/local-binaries/programs/wasm32"

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
    local prefix

    echo "==> Resolving $name dependency"
    prefix="$(resolve_build_dep "$name")"
    if [ ! -f "$prefix/lib/pkgconfig/$expected_pc" ]; then
        echo "$name pkg-config file not found at $prefix/lib/pkgconfig/$expected_pc" >&2
        exit 1
    fi
    append_pkg_config_dir "$prefix"
}

resolve_and_append_dep xorgproto xproto.pc
resolve_and_append_dep xtrans xtrans.pc
resolve_and_append_dep libxau xau.pc
resolve_and_append_dep xcb-proto xcb-proto.pc
resolve_and_append_dep pthread-stubs pthread-stubs.pc
resolve_and_append_dep libxcb xcb.pc
resolve_and_append_dep libx11 x11.pc

mkdir -p "$OUT_DIR"

cflags="$(
    PKG_CONFIG_PATH="$PKG_CONFIG_PATH_VALUE" \
    "$PKG_CONFIG_BIN" --cflags x11
)"
libs="$(
    PKG_CONFIG_PATH="$PKG_CONFIG_PATH_VALUE" \
    "$PKG_CONFIG_BIN" --libs --static x11
)"

echo "==> Building X11 demo clients"
echo "pcpath: $PKG_CONFIG_PATH_VALUE"
echo "cflags: $cflags"
echo "libs:   $libs"

build_one() {
    local name="$1"
    local src="$REPO_ROOT/programs/$name.c"
    local out="$OUT_DIR/$name.wasm"
    echo "  $name"
    # shellcheck disable=SC2086
    PKG_CONFIG_PATH="$PKG_CONFIG_PATH_VALUE" \
        "$CC" -O2 -Wall -Wextra -Wno-unused-parameter \
        $cflags "$src" $libs -lm \
        -o "$out"
    echo "wrote $out"
}

build_one xclock
build_one xeyes
