#!/usr/bin/env bash
# Build Mozilla SpiderMonkey's JS shell for the Kandelo wasm32 POSIX target.
#
# This is the engine-only Phase 0 port. It produces `js.wasm`; the
# Node-compatible runtime is a later embedding layer built on top of the
# SpiderMonkey JSAPI once the shell is green under the kernel.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/sdk/activate.sh"

VERSION="${WASM_POSIX_DEP_VERSION:-$(tr -d '[:space:]' < "$SCRIPT_DIR/VERSION")}"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://ftp.mozilla.org/pub/firefox/releases/$VERSION/source/firefox-$VERSION.source.tar.xz}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-}"
ARCH="${WASM_POSIX_DEP_TARGET_ARCH:-wasm32}"

if [ "$ARCH" != "wasm32" ]; then
    echo "ERROR: SpiderMonkey package currently supports wasm32 only, got '$ARCH'." >&2
    exit 1
fi

SYSROOT="${WASM_POSIX_SYSROOT:-$REPO_ROOT/sysroot}"
BIN_DIR="$SCRIPT_DIR/bin"
DOWNLOAD_DIR="$SCRIPT_DIR/downloads"
SRC_PARENT="$SCRIPT_DIR/source"
OBJ_DIR="$SCRIPT_DIR/obj-wasm32"
MOZCONFIG_PATH="$SCRIPT_DIR/mozconfig-wasm32"
HOST_OS="$(uname -s)"
MACOS_SDK_DIR="${WASM_POSIX_MACOS_SDK_DIR:-}"

if [ "$HOST_OS" = "Darwin" ] && [ -z "$MACOS_SDK_DIR" ] && command -v xcrun >/dev/null 2>&1; then
    SYSTEM_DEVELOPER_DIR="/Applications/Xcode.app/Contents/Developer"
    if [ -d "$SYSTEM_DEVELOPER_DIR" ]; then
        MACOS_SDK_DIR="$(DEVELOPER_DIR="$SYSTEM_DEVELOPER_DIR" xcrun --sdk macosx --show-sdk-path 2>/dev/null || true)"
        if [ -n "$MACOS_SDK_DIR" ]; then
            export DEVELOPER_DIR="$SYSTEM_DEVELOPER_DIR"
            export SDKROOT="$MACOS_SDK_DIR"
        fi
    else
        MACOS_SDK_DIR="$(xcrun --sdk macosx --show-sdk-path 2>/dev/null || true)"
    fi
fi

if [ -n "$MACOS_SDK_DIR" ] && [ ! -d "$MACOS_SDK_DIR" ]; then
    echo "ERROR: macOS SDK not found at $MACOS_SDK_DIR." >&2
    exit 1
fi

if [ ! -f "$SYSROOT/lib/libc.a" ]; then
    echo "ERROR: sysroot not found at $SYSROOT. Run 'bash build.sh' first." >&2
    exit 1
fi

for required_tool in python3 rustc cargo cbindgen node curl make; do
    if ! command -v "$required_tool" >/dev/null 2>&1; then
        echo "ERROR: required host tool '$required_tool' not found in PATH." >&2
        exit 1
    fi
done

HOST_TARGET="$(rustc -vV | awk '/^host/ {print $2}')"
resolve_dep() {
    local name="$1"
    (cd "$REPO_ROOT" && cargo run -p xtask --target "$HOST_TARGET" --quiet -- build-deps resolve "$name")
}

LIBCXX_PREFIX="${WASM_POSIX_DEP_LIBCXX_DIR:-}"
if [ -z "$LIBCXX_PREFIX" ]; then
    echo "==> Resolving libcxx via cargo xtask build-deps..."
    LIBCXX_PREFIX="$(resolve_dep libcxx)"
fi
[ -f "$LIBCXX_PREFIX/lib/libc++.a" ] || {
    echo "ERROR: libcxx resolve missing libc++.a at $LIBCXX_PREFIX" >&2
    exit 1
}
[ -f "$LIBCXX_PREFIX/lib/libc++abi.a" ] || {
    echo "ERROR: libcxx resolve missing libc++abi.a at $LIBCXX_PREFIX" >&2
    exit 1
}
[ -d "$LIBCXX_PREFIX/include/c++/v1" ] || {
    echo "ERROR: libcxx resolve missing include/c++/v1 at $LIBCXX_PREFIX" >&2
    exit 1
}

# Mozilla's build uses the compiler driver directly and expects libc++ to be
# visible from the target sysroot. Keep the sysroot as an index of cache-managed
# libcxx artifacts, matching the MariaDB and C++ program build paths.
mkdir -p "$SYSROOT/lib" "$SYSROOT/include/c++"
ln -sf "$LIBCXX_PREFIX/lib/libc++.a" "$SYSROOT/lib/libc++.a"
ln -sf "$LIBCXX_PREFIX/lib/libc++abi.a" "$SYSROOT/lib/libc++abi.a"
rm -rf "$SYSROOT/include/c++/v1"
ln -sfn "$LIBCXX_PREFIX/include/c++/v1" "$SYSROOT/include/c++/v1"

mkdir -p "$BIN_DIR" "$DOWNLOAD_DIR" "$SRC_PARENT"

find_mach_dir() {
    local mach_path
    mach_path="$(find "$SRC_PARENT" -mindepth 1 -maxdepth 3 -type f -name mach -print -quit)"
    if [ -n "$mach_path" ]; then
        dirname "$mach_path"
    fi
}

SRC_DIR="${SPIDERMONKEY_SRC_DIR:-}"
if [ -z "$SRC_DIR" ] || [ ! -f "$SRC_DIR/mach" ]; then
    SRC_DIR="$(find_mach_dir || true)"
fi

if [ -z "$SRC_DIR" ] || [ ! -f "$SRC_DIR/mach" ]; then
    archive="$DOWNLOAD_DIR/firefox-$VERSION.source.tar.xz"
    if [ ! -f "$archive" ]; then
        echo "==> Downloading Firefox ESR $VERSION source..."
        curl -fL "$SOURCE_URL" -o "$archive"
    fi
    if [ -n "$SOURCE_SHA256" ]; then
        actual_sha="$(python3 - "$archive" <<'PY'
import hashlib
import sys

h = hashlib.sha256()
with open(sys.argv[1], "rb") as f:
    for chunk in iter(lambda: f.read(1024 * 1024), b""):
        h.update(chunk)
print(h.hexdigest())
PY
)"
        if [ "$actual_sha" != "$SOURCE_SHA256" ]; then
            echo "ERROR: source SHA256 mismatch for $archive" >&2
            echo "  expected: $SOURCE_SHA256" >&2
            echo "  actual:   $actual_sha" >&2
            exit 1
        fi
    fi

    echo "==> Extracting Firefox ESR $VERSION source..."
    rm -rf "$SRC_PARENT"
    mkdir -p "$SRC_PARENT"
    python3 - "$archive" "$SRC_PARENT" <<'PY'
from pathlib import Path
import os
import sys
import tarfile

archive = sys.argv[1]
dest = Path(sys.argv[2]).resolve()
with tarfile.open(archive, "r:xz") as tf:
    for member in tf.getmembers():
        target = (dest / member.name).resolve()
        if os.path.commonpath([str(dest), str(target)]) != str(dest):
            raise SystemExit(f"archive member escapes destination: {member.name}")
    tf.extractall(dest)
PY
    SRC_DIR="$(find_mach_dir || true)"
fi

if [ -z "$SRC_DIR" ] || [ ! -f "$SRC_DIR/mach" ]; then
    echo "ERROR: could not locate Mozilla source root with mach under $SRC_PARENT." >&2
    exit 1
fi

PATCH_DIR="$SCRIPT_DIR/patches"
if [ -d "$PATCH_DIR" ]; then
    for patch_file in "$PATCH_DIR"/*.patch; do
        [ -f "$patch_file" ] || continue
        if patch -p1 -N --dry-run --silent -d "$SRC_DIR" < "$patch_file" >/dev/null 2>&1; then
            echo "==> Applying $(basename "$patch_file")..."
            patch -p1 -N -d "$SRC_DIR" < "$patch_file"
        fi
    done
fi

WASM_RUST_TARGET_FEATURES='-Ctarget-feature=+atomics,+bulk-memory,+mutable-globals'
GETRANDOM_BACKEND_RUSTFLAG='--cfg=getrandom_backend=\"custom\"'
WASM_RUSTFLAGS="$WASM_RUST_TARGET_FEATURES $GETRANDOM_BACKEND_RUSTFLAG"

cat > "$MOZCONFIG_PATH" <<EOF
export RUSTFLAGS="\${RUSTFLAGS:+\$RUSTFLAGS }$WASM_RUSTFLAGS"
ac_add_options --enable-project=js
ac_add_options --target=wasm32-unknown-linux-musl
ac_add_options --disable-debug
ac_add_options --enable-optimize="-O2"
ac_add_options --disable-jit
ac_add_options --disable-jemalloc
ac_add_options --disable-stdcxx-compat
ac_add_options --without-system-zlib
ac_add_options --with-intl-api
ac_add_options --enable-icu4x
ac_add_options --disable-shared-js
ac_add_options --enable-shared-memory
ac_add_options --disable-clang-plugin
ac_add_options --disable-tests
ac_add_options --disable-debug-symbols
mk_add_options MOZ_OBJDIR=$OBJ_DIR
EOF
if [ -n "$MACOS_SDK_DIR" ]; then
    echo "ac_add_options --with-macos-sdk=$MACOS_SDK_DIR" >> "$MOZCONFIG_PATH"
fi

export MOZCONFIG="$MOZCONFIG_PATH"
export MOZBUILD_STATE_PATH="$SCRIPT_DIR/.mozbuild"
export MACH_BUILD_PYTHON_NATIVE_PACKAGE_SOURCE=system

TARGET_OS_DEFINES="${WASM_POSIX_TARGET_OS_DEFINES:--D__linux__=1 -D__unix__=1}"
export CC="${WASM_POSIX_TARGET_CC:-wasm32posix-cc} $TARGET_OS_DEFINES"
export CXX="${WASM_POSIX_TARGET_CXX:-wasm32posix-c++} $TARGET_OS_DEFINES"
export AS="${WASM_POSIX_TARGET_AS:-wasm32posix-cc} $TARGET_OS_DEFINES"
export AR="${WASM_POSIX_TARGET_AR:-wasm32posix-ar}"
export RANLIB="${WASM_POSIX_TARGET_RANLIB:-wasm32posix-ranlib}"
export NM="${WASM_POSIX_TARGET_NM:-wasm32posix-nm}"
export STRIP="${WASM_POSIX_TARGET_STRIP:-wasm32posix-strip}"
if [ "$HOST_OS" = "Darwin" ]; then
    export HOST_CC="${HOST_CC:-/usr/bin/cc}"
    export HOST_CXX="${HOST_CXX:-/usr/bin/c++}"
else
    export HOST_CC="${HOST_CC:-cc}"
    export HOST_CXX="${HOST_CXX:-c++}"
fi
export CFLAGS="${CFLAGS:-} -D_GNU_SOURCE"
export CXXFLAGS="${CXXFLAGS:-} -D_GNU_SOURCE -fexceptions"
export LDFLAGS="${LDFLAGS:-} -lc++ -lc++abi -Wl,-z,stack-size=16777216"

if [ -f "$OBJ_DIR/config.status" ] && {
    ! grep -q 'getrandom_backend' "$OBJ_DIR/config.status" ||
        grep -q 'getrandom_backend=custom' "$OBJ_DIR/config.status" ||
        ! grep -q 'target-feature=+atomics' "$OBJ_DIR/config.status"
}; then
    echo "==> Refreshing stale Mozilla configure state for Rust target flags..."
    rm -f "$OBJ_DIR/config.status" "$OBJ_DIR/.mozconfig.json"
fi

RUST_RELEASE_DIR="$OBJ_DIR/wasm32-unknown-unknown/release"
JSRUST_FINGERPRINT="$(
    find "$RUST_RELEASE_DIR/.fingerprint" -path '*/lib-jsrust.json' -type f -print -quit 2>/dev/null || true
)"
if [ -n "$JSRUST_FINGERPRINT" ] && ! grep -q 'target-feature=+atomics' "$JSRUST_FINGERPRINT"; then
    echo "==> Rebuilding stale SpiderMonkey Rust archive for wasm atomics..."
    rm -f "$RUST_RELEASE_DIR/libjsrust.a"
    rm -rf "$RUST_RELEASE_DIR/.fingerprint"/jsrust-*
fi

echo "==> Building SpiderMonkey JS shell for wasm32..."
(cd "$SRC_DIR" && ./mach --no-interactive build)

JS_BIN=""
for candidate in "$OBJ_DIR/dist/bin/js" "$OBJ_DIR/dist/bin/js.wasm"; do
    if [ -f "$candidate" ]; then
        JS_BIN="$candidate"
        break
    fi
done

if [ -z "$JS_BIN" ]; then
    echo "ERROR: SpiderMonkey build finished but no js shell was found under $OBJ_DIR/dist/bin." >&2
    exit 1
fi

cp "$JS_BIN" "$BIN_DIR/js.wasm"

WASM_OPT="${WASM_OPT:-wasm-opt}"
if command -v "$WASM_OPT" >/dev/null 2>&1; then
    echo "==> Optimizing js.wasm with wasm-opt -O2..."
    "$WASM_OPT" -O2 "$BIN_DIR/js.wasm" -o "$BIN_DIR/js.wasm"
else
    echo "WARNING: wasm-opt not found; leaving unoptimized js.wasm." >&2
fi

FORK_INSTRUMENT="$REPO_ROOT/scripts/run-wasm-fork-instrument.sh"
echo "==> Applying fork instrumentation to js.wasm..."
"$FORK_INSTRUMENT" "$BIN_DIR/js.wasm" -o "$BIN_DIR/js.wasm.instr"
mv "$BIN_DIR/js.wasm.instr" "$BIN_DIR/js.wasm"

JS_SIZE="$(wc -c < "$BIN_DIR/js.wasm" | tr -d ' ')"
echo "==> SpiderMonkey built successfully: $BIN_DIR/js.wasm ($JS_SIZE bytes)"

# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary spidermonkey "$BIN_DIR/js.wasm"
