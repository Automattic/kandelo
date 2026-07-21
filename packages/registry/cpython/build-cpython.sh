#!/usr/bin/env bash
set -euo pipefail

# Build CPython for Kandelo through the package/resolver contract.
#
# A direct developer build uses this package directory for scratch and mirrors
# outputs into local-binaries. Resolver and Homebrew callers provide isolated,
# caller-owned work/output directories; in that mode this script does not write
# generated state into the reviewed checkout or its local-binaries mirror.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

PYTHON_VERSION="${WASM_POSIX_DEP_VERSION:-${PYTHON_VERSION:-3.13.3}}"
PYTHON_MAJOR_MINOR="$(printf '%s\n' "$PYTHON_VERSION" | awk -F. '{print $1 "." $2}')"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://www.python.org/ftp/python/${PYTHON_VERSION}/Python-${PYTHON_VERSION}.tar.xz}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-40f868bcbdeb8149a3149580bb9bfd407b3321cd48f0be631af955ac92c0e041}"
PACKAGE_NAME="${WASM_POSIX_DEP_NAME:-cpython}"
TARGET_ARCH="${WASM_POSIX_DEP_TARGET_ARCH:-wasm32}"

case "$TARGET_ARCH" in
    wasm32) ;;
    *)
        echo "ERROR: CPython currently supports only wasm32 (got $TARGET_ARCH)" >&2
        exit 2
        ;;
esac

WORK_DIR="${WASM_POSIX_DEP_WORK_DIR:-$SCRIPT_DIR}"
OUT_DIR="${WASM_POSIX_DEP_OUT_DIR:-$SCRIPT_DIR/bin}"
SRC_DIR="$WORK_DIR/cpython-src"
SOURCE_MARKER="$SRC_DIR/.kandelo-cpython-version"
HOST_BUILD_DIR="$WORK_DIR/cpython-host-build"
CROSS_BUILD_DIR="$WORK_DIR/cpython-cross-build"
RUNTIME_STAGE="$WORK_DIR/python-runtime-stage"
DOWNLOAD_DIR="$WORK_DIR/downloads"
SOURCE_SYSROOT="${WASM_POSIX_SYSROOT:-$REPO_ROOT/sysroot}"
GUEST_PREFIX="${WASM_POSIX_DEP_GUEST_PREFIX:-/usr}"
STABLE_SOURCE="/usr/src/cpython-${PYTHON_VERSION}"

mkdir -p "$WORK_DIR" "$OUT_DIR" "$DOWNLOAD_DIR"

# Worktree-local SDK on PATH (no global npm link required).
# shellcheck source=/dev/null
source "$REPO_ROOT/sdk/activate.sh"

for tool in wasm32posix-cc wasm32posix-ar wasm-opt wasm-objdump; do
    if ! command -v "$tool" >/dev/null 2>&1; then
        echo "ERROR: required CPython build tool is unavailable: $tool" >&2
        exit 1
    fi
done

if [ ! -f "$SOURCE_SYSROOT/lib/libc.a" ]; then
    echo "ERROR: sysroot not found at $SOURCE_SYSROOT. Run scripts/build-musl.sh first." >&2
    exit 1
fi

# CPython's WASI configure path names three empty emulation archives. A sealed
# publisher exposes the reviewed sysroot read-only, so augment a private copy
# rather than mutating that trusted input.
SYSROOT="$SOURCE_SYSROOT"
if [ -n "${WASM_POSIX_DEP_WORK_DIR:-}" ]; then
    SYSROOT="$WORK_DIR/cpython-sysroot"
    rm -rf "$SYSROOT"
    mkdir -p "$SYSROOT"
    cp -a "$SOURCE_SYSROOT/." "$SYSROOT/"
    if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
        export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
        export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto
    fi
fi
export WASM_POSIX_SYSROOT="$SYSROOT"

for lib in \
    libwasi-emulated-signal.a \
    libwasi-emulated-getpid.a \
    libwasi-emulated-process-clocks.a; do
    if [ ! -f "$SYSROOT/lib/$lib" ]; then
        wasm32posix-ar rcs "$SYSROOT/lib/$lib"
    fi
done

# Resolver-provided dependency roots are authoritative. Direct builds may ask
# the resolver, but Formula builds must never rediscover undeclared state.
ZLIB_PREFIX="${WASM_POSIX_DEP_ZLIB_DIR:-}"
if [ -z "$ZLIB_PREFIX" ]; then
    HOST_TARGET="$(rustc -vV | awk '/^host/ {print $2}')"
    echo "==> Resolving zlib through the package resolver..."
    ZLIB_PREFIX="$(
        cd "$REPO_ROOT"
        cargo run -p xtask --target "$HOST_TARGET" --quiet -- build-deps resolve zlib
    )"
fi
if [ ! -f "$ZLIB_PREFIX/lib/libz.a" ]; then
    echo "ERROR: zlib dependency is missing lib/libz.a: $ZLIB_PREFIX" >&2
    exit 1
fi
echo "==> zlib at $ZLIB_PREFIX"

if [ -d "$SRC_DIR" ] && [ "$(cat "$SOURCE_MARKER" 2>/dev/null || true)" != "$PYTHON_VERSION" ]; then
    echo "==> CPython source version changed; discarding stale caller-owned builds..."
    rm -rf "$SRC_DIR" "$HOST_BUILD_DIR" "$CROSS_BUILD_DIR" "$RUNTIME_STAGE"
fi

if [ ! -d "$SRC_DIR" ]; then
    archive="$DOWNLOAD_DIR/Python-${PYTHON_VERSION}.tar.xz"
    echo "==> Downloading CPython $PYTHON_VERSION..."
    curl --retry 10 --retry-delay 5 --retry-max-time 300 --retry-all-errors \
        -fsSL "$SOURCE_URL" -o "$archive"
    if [ -z "$SOURCE_SHA256" ]; then
        echo "ERROR: CPython source sha256 is required for a source build" >&2
        exit 1
    fi
    printf '%s  %s\n' "$SOURCE_SHA256" "$archive" | shasum -a 256 -c -
    mkdir -p "$SRC_DIR"
    tar xf "$archive" -C "$SRC_DIR" --strip-components=1
    printf '%s\n' "$PYTHON_VERSION" > "$SOURCE_MARKER"
fi

BUILD_TRIPLET="$("$SRC_DIR/config.guess")"
if [ -z "$BUILD_TRIPLET" ]; then
    echo "ERROR: CPython config.guess returned an empty native build triplet" >&2
    exit 1
fi

# CPython's cross build runs native generators. Build those from the same
# verified source under the caller-owned work root.
if [ ! -x "$HOST_BUILD_DIR/python" ] && [ ! -x "$HOST_BUILD_DIR/python.exe" ]; then
    echo "==> Building native CPython generators ($BUILD_TRIPLET)..."
    mkdir -p "$HOST_BUILD_DIR"
    (
        cd "$HOST_BUILD_DIR"
        CONFIG_SITE=/dev/null \
        py_cv_module__ctypes=n/a \
        py_cv_module__ctypes_test=n/a \
        py_cv_module__bz2=n/a \
        py_cv_module__dbm=n/a \
        py_cv_module_readline=n/a \
        py_cv_module_zlib=n/a \
        "$SRC_DIR/configure" \
            --prefix="$HOST_BUILD_DIR/install" \
            --without-ensurepip \
            --disable-test-modules
        make -j"${WASM_POSIX_BUILD_JOBS:-$(getconf _NPROCESSORS_ONLN 2>/dev/null || sysctl -n hw.ncpu)}"
    )
fi

if [ -x "$HOST_BUILD_DIR/python.exe" ]; then
    HOST_PYTHON="$HOST_BUILD_DIR/python.exe"
else
    HOST_PYTHON="$HOST_BUILD_DIR/python"
fi
"$HOST_PYTHON" --version

PREFIX_MAPS="-ffile-prefix-map=$SRC_DIR=$STABLE_SOURCE"
PREFIX_MAPS="$PREFIX_MAPS -fdebug-prefix-map=$SRC_DIR=$STABLE_SOURCE"
PREFIX_MAPS="$PREFIX_MAPS -fmacro-prefix-map=$SRC_DIR=$STABLE_SOURCE"
PREFIX_MAPS="$PREFIX_MAPS -ffile-prefix-map=$WORK_DIR=/usr/src/kandelo-build/cpython"
PREFIX_MAPS="$PREFIX_MAPS -fdebug-prefix-map=$WORK_DIR=/usr/src/kandelo-build/cpython"
PREFIX_MAPS="$PREFIX_MAPS -fmacro-prefix-map=$WORK_DIR=/usr/src/kandelo-build/cpython"
PREFIX_MAPS="$PREFIX_MAPS -ffile-prefix-map=$REPO_ROOT=/usr/src/kandelo"
PREFIX_MAPS="$PREFIX_MAPS -fdebug-prefix-map=$REPO_ROOT=/usr/src/kandelo"
PREFIX_MAPS="$PREFIX_MAPS -fmacro-prefix-map=$REPO_ROOT=/usr/src/kandelo"

echo "==> Configuring CPython for wasm32-posix..."
mkdir -p "$CROSS_BUILD_DIR"
if [ ! -f "$CROSS_BUILD_DIR/Makefile" ]; then
    (
        cd "$CROSS_BUILD_DIR"
        WASM_POSIX_SDK_CONFIG_SITE="$REPO_ROOT/sdk/config.site" \
        CONFIG_SITE="$SCRIPT_DIR/config.site-wasm32-posix" \
        PKG_CONFIG_PATH="$ZLIB_PREFIX/lib/pkgconfig" \
        CC=wasm32posix-cc \
        CXX=wasm32posix-c++ \
        AR=wasm32posix-ar \
        RANLIB=wasm32posix-ranlib \
        NM=wasm32posix-nm \
        STRIP=wasm32posix-strip \
        PKG_CONFIG=wasm32posix-pkg-config \
        py_cv_module__ssl=n/a \
        py_cv_module__hashlib=n/a \
        py_cv_module__decimal=n/a \
        py_cv_module__ctypes=n/a \
        py_cv_module__ctypes_test=n/a \
        py_cv_module__bz2=n/a \
        py_cv_module__lzma=n/a \
        py_cv_module__sqlite3=n/a \
        py_cv_module_readline=n/a \
        py_cv_module__tkinter=n/a \
        py_cv_module__dbm=n/a \
        py_cv_module__gdbm=n/a \
        "$SRC_DIR/configure" \
            --host=wasm32-unknown-wasi \
            --build="$BUILD_TRIPLET" \
            --with-build-python="$HOST_PYTHON" \
            --without-ensurepip \
            --disable-test-modules \
            --disable-shared \
            --without-mimalloc \
            --with-suffix=.wasm \
            --prefix="$GUEST_PREFIX" \
            CFLAGS="-O2 -gline-tables-only -fdebug-compilation-dir=$STABLE_SOURCE $PREFIX_MAPS -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_PROCESS_CLOCKS" \
            CPPFLAGS="-I$ZLIB_PREFIX/include" \
            LDFLAGS="-L$ZLIB_PREFIX/lib"
    )
fi

# CPython's generated getpath object embeds Makefile VPATH as a literal rather
# than a compiler source path, so prefix-map flags cannot rewrite it. Replace
# only that compile-time macro with the stable reviewed-source identity; leave
# Make's real VPATH untouched so the out-of-tree build still locates sources.
"$HOST_PYTHON" - "$CROSS_BUILD_DIR/Makefile" "$STABLE_SOURCE" <<'PY'
from pathlib import Path
import sys

makefile = Path(sys.argv[1])
stable_source = sys.argv[2]
text = makefile.read_text()
needle = "-DVPATH='\"$(VPATH)\"'"
replacement = f"-DVPATH='\"{stable_source}\"'"
if text.count(needle) == 1 and replacement not in text:
    makefile.write_text(text.replace(needle, replacement))
elif text.count(replacement) != 1:
    raise SystemExit(f"expected exactly one CPython getpath VPATH define in {makefile}")
PY

echo "==> Building CPython wasm32 runtime..."
(
    cd "$CROSS_BUILD_DIR"
    # CPython's generic WASI target forces --stack-first and its own initial
    # memory size through CONFIGURE_LDFLAGS_NODIST. Kandelo's SDK owns the
    # executable memory layout, stack floor, global base, and maximum instead;
    # mixing both contracts is rejected by wasm-ld. Preserve ordinary caller
    # LDFLAGS while dropping only that target-specific generated override.
    make CONFIGURE_LDFLAGS_NODIST= \
        -j"${WASM_POSIX_BUILD_JOBS:-$(getconf _NPROCESSORS_ONLN 2>/dev/null || sysctl -n hw.ncpu)}"
)

RAW_PYTHON="$CROSS_BUILD_DIR/python.wasm"
if [ ! -f "$RAW_PYTHON" ]; then
    RAW_PYTHON="$CROSS_BUILD_DIR/python"
fi
if [ ! -f "$RAW_PYTHON" ]; then
    echo "ERROR: CPython build did not produce python.wasm" >&2
    exit 1
fi

OPTIMIZED_PYTHON="$WORK_DIR/python.optimized.wasm"
FINAL_PYTHON="$WORK_DIR/python.wasm"
wasm-opt -O2 "$RAW_PYTHON" -o "$OPTIMIZED_PYTHON"
bash "$REPO_ROOT/scripts/run-wasm-fork-instrument.sh" \
    "$OPTIMIZED_PYTHON" -o "$FINAL_PYTHON"
chmod 0755 "$FINAL_PYTHON"

# Validate the exact bytes that leave the source-build realm.
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/wasm-artifact-guards.sh"
wasm_require_no_legacy_asyncify "$FINAL_PYTHON"
EXPECTED_ABI="$(wasm_current_abi_version "$REPO_ROOT")"
ARTIFACT_ABI="$(wasm_extract_abi_version "$FINAL_PYTHON")"
if [ -z "$EXPECTED_ABI" ] || [ "$ARTIFACT_ABI" != "$EXPECTED_ABI" ]; then
    echo "ERROR: CPython artifact ABI ${ARTIFACT_ABI:-missing} does not match $EXPECTED_ABI" >&2
    exit 1
fi
if ! wasm_imports_kernel_fork "$FINAL_PYTHON"; then
    echo "ERROR: CPython exposes os.fork but the linked runtime does not import kernel.kernel_fork" >&2
    exit 1
fi
wasm_require_fork_instrumentation_if_needed "$FINAL_PYTHON"

# Package the complete runtime library, excluding only CPython's upstream test
# suites and generated bytecode. Keep optional-module Python sources: imports
# then report the truthful missing native extension rather than silently hiding
# an otherwise available standard-library package.
rm -rf "$RUNTIME_STAGE"
mkdir -p "$RUNTIME_STAGE/lib/python${PYTHON_MAJOR_MINOR}" "$RUNTIME_STAGE/share/licenses/cpython"
"$HOST_PYTHON" - "$SRC_DIR/Lib" "$RUNTIME_STAGE/lib/python${PYTHON_MAJOR_MINOR}" <<'PY'
from pathlib import Path
import shutil
import sys

source = Path(sys.argv[1])
destination = Path(sys.argv[2])
excluded = {"__pycache__", "test", "tests"}
for path in sorted(source.rglob("*"), key=lambda item: item.as_posix()):
    relative = path.relative_to(source)
    if any(part in excluded for part in relative.parts):
        continue
    target = destination / relative
    if path.is_dir():
        target.mkdir(parents=True, exist_ok=True)
    elif path.is_file() and path.suffix not in {".pyc", ".pyo"}:
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, target)
PY
cp "$SRC_DIR/LICENSE" "$RUNTIME_STAGE/share/licenses/cpython/LICENSE"

RUNTIME_ZIP="$WORK_DIR/python-runtime.zip"
rm -f "$RUNTIME_ZIP"
"$HOST_PYTHON" - "$RUNTIME_STAGE" "$RUNTIME_ZIP" <<'PY'
from pathlib import Path
import stat
import sys
import zipfile

root = Path(sys.argv[1])
output = Path(sys.argv[2])
timestamp = (2023, 11, 14, 22, 13, 20)
with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_STORED, strict_timestamps=True) as archive:
    for path in sorted((item for item in root.rglob("*") if item.is_file()), key=lambda item: item.as_posix()):
        relative = path.relative_to(root).as_posix()
        info = zipfile.ZipInfo(relative, date_time=timestamp)
        info.create_system = 3
        info.external_attr = (stat.S_IFREG | 0o644) << 16
        info.compress_type = zipfile.ZIP_STORED
        archive.writestr(info, path.read_bytes())
PY

echo "==> CPython outputs"
ls -lh "$FINAL_PYTHON" "$RUNTIME_ZIP"

# The common installer re-runs artifact policy before mirroring or copying into
# resolver scratch. Both filenames exactly match package.toml outputs.
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary "$PACKAGE_NAME" "$FINAL_PYTHON"
if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    cp "$RUNTIME_ZIP" "$OUT_DIR/python-runtime.zip"
    echo "  installed $OUT_DIR/python-runtime.zip (resolver scratch)"
else
    install_local_runtime_file "$PACKAGE_NAME" "$RUNTIME_ZIP"
fi
