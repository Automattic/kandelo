#!/usr/bin/env bash
# Cross-compile CMake for Kandelo with the build machine's CMake and the
# SDK. Outputs cmake.wasm, ctest.wasm, cpack.wasm and cmake-data.zip (the
# Modules tree and the rest of share/cmake-<major>.<minor>, CMake's
# aclocal macro and its license files, mounted at /usr).
#
# The patches teach CMake the platform (packages/registry/cmake/README.md):
# CMake names a machine whose uname reports wasm-posix/kandelo "Kandelo",
# Modules/Platform/Kandelo.cmake describes it for native builds, and the
# bundled libuv uses its portable POSIX backend on Kandelo.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_load_source_metadata "$HERE"
kandelo_package_prepare_build_roots "$HERE" wasm32
WORK="$KANDELO_PACKAGE_WORK_DIR"
SRC="$WORK/cmake-src"
BUILD="$WORK/cmake-build"
STAGE="$WORK/cmake-stage"
VERSION="$WASM_POSIX_DEP_VERSION"
DATA_DIR="share/cmake-${VERSION%.*}"
source "$REPO_ROOT/sdk/activate.sh"

# The libraries come from their packages, through the resolver.
dep_dir() {
    local variable="WASM_POSIX_DEP_$1_DIR"
    local dir="${!variable:-}"
    [ -n "$dir" ] && [ -d "$dir" ] || {
        echo "ERROR: $variable is not set; build cmake through the resolver" >&2
        exit 1
    }
    printf '%s\n' "$dir"
}
LIBCXX_DIR="$(dep_dir LIBCXX)"
ZLIB_DIR="$(dep_dir ZLIB)"
EXPAT_DIR="$(dep_dir EXPAT)"
JSONCPP_DIR="$(dep_dir JSONCPP)"
CURL_DIR="$(dep_dir LIBCURL)"
OPENSSL_DIR="$(dep_dir OPENSSL)"

SYSROOT="${WASM_POSIX_SYSROOT:-$REPO_ROOT/sysroot}"
export WASM_POSIX_DEP_WORK_DIR="$WORK"
SYSROOT="$(kandelo_package_prepare_private_sysroot cmake "$SYSROOT" libcxx)"
export WASM_POSIX_SYSROOT="$SYSROOT"

rm -rf "$SRC" "$BUILD" "$STAGE"
kandelo_package_stage_primary_source cmake "$SRC" "$WORK"
for patch in "$HERE"/patches/*.patch; do
    kandelo_package_git_apply_patch "$SRC" "$patch"
done

# CMake reports errors by throwing; the SDK enables C++ exceptions itself.
FLAGS="-O2 -g0 -ffile-prefix-map=$WORK=/kandelo-build/cmake"
# libcurl.a is static: name the libraries it was linked against.
CURL_DEPS="$OPENSSL_DIR/lib/libssl.a $OPENSSL_DIR/lib/libcrypto.a $ZLIB_DIR/lib/libz.a"

echo "==> Configuring CMake $VERSION..."
# The SDK's toolchain file names the target (Platform/Kandelo, the SDK
# wrappers, the private sysroot). It is read again in every try_compile
# project, so the platform module is found there too. Probes link real
# executables rather than the SDK default static library: the SDK's
# executable link is strict, so a missing function fails its check. The
# dependencies are target roots as well as the sysroot, so find_library()
# accepts the library directories pkg-config names inside them.
TOOLCHAIN="$WORK/kandelo-cmake-toolchain.cmake"
cat > "$TOOLCHAIN" <<EOF
include("$REPO_ROOT/sdk/cmake/kandelo-toolchain.cmake")
set(CMAKE_TRY_COMPILE_TARGET_TYPE EXECUTABLE)
list(APPEND CMAKE_FIND_ROOT_PATH
  "$ZLIB_DIR" "$EXPAT_DIR" "$JSONCPP_DIR" "$CURL_DIR" "$OPENSSL_DIR")
EOF
# FindCURL consults pkg-config: give it the SDK's, which reads the target's
# .pc files, not the build machine's.
export PKG_CONFIG_PATH="$CURL_DIR/lib/pkgconfig:$OPENSSL_DIR/lib/pkgconfig:$ZLIB_DIR/lib/pkgconfig"
# musl's iconv is in libc. The SDK's platform module gives find_path() no
# search prefix inside the sysroot, so libarchive is told where iconv.h is.
cmake -G "Unix Makefiles" -S "$SRC" -B "$BUILD" \
    -DCMAKE_TOOLCHAIN_FILE="$TOOLCHAIN" \
    -DPKG_CONFIG_EXECUTABLE="$(command -v wasm32posix-pkg-config)" \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_C_FLAGS="$FLAGS" \
    -DCMAKE_CXX_FLAGS="$FLAGS" \
    -DCMAKE_C_FLAGS_RELEASE=-DNDEBUG \
    -DCMAKE_CXX_FLAGS_RELEASE=-DNDEBUG \
    -DCMAKE_CXX_STANDARD_LIBRARIES="$CURL_DEPS" \
    -DCMAKE_INSTALL_PREFIX=/usr \
    -DCMAKE_DOC_DIR="share/doc/cmake-${VERSION%.*}" \
    -DBUILD_TESTING=OFF \
    -DBUILD_CursesDialog=OFF \
    -DBUILD_QtDialog=OFF \
    -DCMake_ENABLE_DEBUGGER=OFF \
    -DCMAKE_USE_SYSTEM_ZLIB=ON \
    -DZLIB_INCLUDE_DIR="$ZLIB_DIR/include" \
    -DZLIB_LIBRARY="$ZLIB_DIR/lib/libz.a" \
    -DCMAKE_USE_SYSTEM_EXPAT=ON \
    -DEXPAT_INCLUDE_DIR="$EXPAT_DIR/include" \
    -DEXPAT_LIBRARY="$EXPAT_DIR/lib/libexpat.a" \
    -DCMAKE_USE_SYSTEM_JSONCPP=ON \
    -DJsonCpp_INCLUDE_DIR="$JSONCPP_DIR/include" \
    -DJsonCpp_LIBRARY="$JSONCPP_DIR/lib/libjsoncpp.a" \
    -DCMAKE_USE_SYSTEM_ZSTD=OFF \
    -DCMAKE_USE_SYSTEM_CURL=ON \
    -DCURL_INCLUDE_DIR="$CURL_DIR/include" \
    -DCURL_LIBRARY="$CURL_DIR/lib/libcurl.a" \
    -DICONV_INCLUDE_DIR="$SYSROOT/include" \
    -DCMAKE_USE_SYSTEM_LIBARCHIVE=OFF \
    -DCMAKE_USE_SYSTEM_LIBLZMA=OFF \
    -DCMAKE_USE_SYSTEM_BZIP2=OFF \
    -DCMAKE_USE_SYSTEM_LIBUV=OFF \
    -DCMAKE_USE_SYSTEM_LIBRHASH=OFF \
    > "$WORK/configure.log" 2>&1 || { tail -60 "$WORK/configure.log" >&2; exit 1; }
tail -20 "$WORK/configure.log"

echo "==> Building CMake..."
JOBS="$(sysctl -n hw.ncpu 2>/dev/null || nproc)"
cmake --build "$BUILD" -j"$JOBS" > "$WORK/build.log" 2>&1 || {
    grep -n -m 20 -E 'error:|Error [0-9]' "$WORK/build.log" >&2 || true
    tail -40 "$WORK/build.log" >&2
    exit 1
}
DESTDIR="$STAGE" cmake --install "$BUILD" > "$WORK/install.log" 2>&1 || {
    tail -40 "$WORK/install.log" >&2
    exit 1
}

for tool in cmake ctest cpack; do
    [ -f "$BUILD/bin/$tool.wasm" ] || { echo "ERROR: $tool was not built" >&2; exit 1; }
    cp "$BUILD/bin/$tool.wasm" "$WORK/$tool.wasm"
done
[ -f "$STAGE/usr/$DATA_DIR/Modules/CMake.cmake" ] || {
    echo "ERROR: CMake's Modules were not installed in /usr/$DATA_DIR" >&2
    exit 1
}
[ -f "$STAGE/usr/$DATA_DIR/Modules/Platform/Kandelo.cmake" ] || {
    echo "ERROR: Modules/Platform/Kandelo.cmake was not installed" >&2
    exit 1
}

DATA="$WORK/cmake-data"
rm -rf "$DATA"
mkdir -p "$DATA/share/aclocal" "$DATA/share/doc"
cp -R "$STAGE/usr/$DATA_DIR" "$DATA/$DATA_DIR"
cp "$STAGE/usr/share/aclocal/cmake.m4" "$DATA/share/aclocal/cmake.m4"
cp -R "$STAGE/usr/share/doc/cmake-${VERSION%.*}" "$DATA/share/doc/cmake-${VERSION%.*}"
bash "$REPO_ROOT/images/vfs/scripts/create-deterministic-zip.sh" "$DATA" "$WORK/cmake-data.zip"

cd "$REPO_ROOT"
if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
fi
source "$REPO_ROOT/scripts/install-local-binary.sh"
for tool in cmake ctest cpack; do
    WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto \
        install_local_binary cmake "$WORK/$tool.wasm" "$tool.wasm"
done
WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=disabled \
    install_local_binary cmake "$WORK/cmake-data.zip" cmake-data.zip
