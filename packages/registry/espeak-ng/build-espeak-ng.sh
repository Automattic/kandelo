#!/usr/bin/env bash
#
# Build espeak-ng for wasm32-posix-kernel.
#
# Two-pass build:
#
#   1. Native build of espeak-ng on the host. Its binary compiles the
#      phoneme + intonation data out of phsource/ + dictsource/ via
#      the --compile-* commands, and that pass writes the data dir
#      this package ships.
#   2. Cross build of espeak-ng for wasm32, linked against upstream
#      pcaudiolib built with only its OSS backend. That backend opens
#      /dev/dsp, Kandelo's low-level audio API, so the resulting
#      espeak-ng.wasm produces audible speech inside the kandelo
#      browser preset. Neither source tree is patched.
#
# Honors the dep-resolver build-script contract — see
# packages/registry/libxml2/build-libxml2.sh for the pattern.
#
# Output layout — the two paths package.toml declares, and nothing else:
#
#   $INSTALL_DIR/
#     espeak-ng.wasm                           ([[outputs]].wasm)
#     espeak-ng-data.zip                       ([[runtime_files]].artifact:
#                                              the phoneme + voice data dir
#                                              compiled by the native bin,
#                                              packed)
#
# Default install dir for legacy / ad-hoc invocation is
# ./espeak-ng-install/ next to this script.

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
PCAUDIO_SRC_DIR="$HERE/pcaudiolib-src"
SRC_DIR="$HERE/espeak-ng-src"

# --- Resolver-contract env / legacy fallbacks ---
INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:-$HERE/espeak-ng-install}"

# --- Upstream source pins ---
# espeak-ng publishes no source archive as a release asset, so its pin is
# the tag archive. pcaudiolib publishes one.
ESPEAK_VERSION="${WASM_POSIX_DEP_VERSION:-1.52.0}"
ESPEAK_SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://github.com/espeak-ng/espeak-ng/archive/refs/tags/${ESPEAK_VERSION}.tar.gz}"
ESPEAK_SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-bb4338102ff3b49a81423da8a1a158b420124b055b60fa76cfb4b18677130a23}"

PCAUDIO_VERSION="1.3"
PCAUDIO_SOURCE_URL="https://github.com/espeak-ng/pcaudiolib/releases/download/${PCAUDIO_VERSION}/pcaudiolib-${PCAUDIO_VERSION}.tar.gz"
PCAUDIO_SOURCE_SHA256="e8bd15f460ea171ccd0769ea432e188532a7fb27fa73ec2d526088a082abaaad"

# Languages to compile. The full upstream list is ~80 languages and
# bloats the VFS image by ~25 MB. Default to English-only for the demo;
# override at build time with e.g. ESPEAK_LANG_LIST="en de fr".
ESPEAK_LANG_LIST="${ESPEAK_LANG_LIST:-en}"

# --- SDK + sysroot ---
# Source this worktree's SDK directly instead of relying on `npm link`.
source "$REPO_ROOT/sdk/activate.sh"
SYSROOT="${WASM_POSIX_SYSROOT:-$REPO_ROOT/sysroot}"
export WASM_POSIX_SYSROOT="$SYSROOT"

if ! command -v wasm32posix-cc >/dev/null; then
    echo "ERROR: wasm32posix-cc not found on PATH after sourcing sdk/activate.sh." >&2
    exit 1
fi
if [ ! -f "$SYSROOT/lib/libc.a" ]; then
    echo "ERROR: kandelo sysroot not built at $SYSROOT. Run bash scripts/build-musl.sh first." >&2
    exit 1
fi
for tool in cmake curl tar shasum python3; do
    command -v "$tool" >/dev/null || {
        echo "ERROR: required build tool not found: $tool" >&2
        exit 1
    }
done

# --- Fetch upstream sources --------------------------------------------
# Both trees are gitignored build inputs, not vendored files. Download
# and verify each once, then reuse it across resolves.
fetch_source() {
    local url="$1" sha256="$2" dest="$3" name="$4"
    [ -d "$dest" ] && return 0
    echo "==> Downloading $name..."
    local tarball="$dest.tar.gz"
    local staging="$dest.incoming"
    curl --retry 10 --retry-delay 5 --retry-max-time 300 --retry-all-errors \
        -fsSL "$url" -o "$tarball"
    echo "$sha256  $tarball" | shasum -a 256 -c -
    rm -rf "$staging"
    mkdir -p "$staging"
    tar xzf "$tarball" -C "$staging" --strip-components=1
    rm -f "$tarball"
    mv "$staging" "$dest"
}

fetch_source "$ESPEAK_SOURCE_URL" "$ESPEAK_SOURCE_SHA256" "$SRC_DIR" "espeak-ng $ESPEAK_VERSION"
fetch_source "$PCAUDIO_SOURCE_URL" "$PCAUDIO_SOURCE_SHA256" "$PCAUDIO_SRC_DIR" "pcaudiolib $PCAUDIO_VERSION"

# --- Locate host LLVM (for glue obj compile + native build) ---
LLVM_PREFIX="${LLVM_PREFIX:-$(brew --prefix llvm 2>/dev/null || echo /opt/homebrew/opt/llvm)}"
LLVM_CLANG="$LLVM_PREFIX/bin/clang"

# --- Phase 0: kandelo glue objs ----------------------------------------
# Mirrors mariadb's mariadb-glue-objs/. crt1.o comes from the sysroot;
# the channel_syscall + compiler_rt objects come from the kandelo libc
# glue and are linked into every user program at exec time.
GLUE_OBJ_DIR="$HERE/glue-objs"
GLUE_SRC_DIR="$REPO_ROOT/libc/glue"
mkdir -p "$GLUE_OBJ_DIR"
if [ ! -f "$GLUE_OBJ_DIR/channel_syscall.o" ] || \
   [ "$GLUE_SRC_DIR/channel_syscall.c" -nt "$GLUE_OBJ_DIR/channel_syscall.o" ]; then
    echo "==> Compiling kandelo glue objs..."
    WASM_COMPILE_FLAGS="--target=wasm32-unknown-unknown -matomics -mbulk-memory -mexception-handling -mllvm -wasm-enable-sjlj -fno-trapping-math --sysroot=$SYSROOT"
    # shellcheck disable=SC2086
    "$LLVM_CLANG" $WASM_COMPILE_FLAGS -O2 -c "$GLUE_SRC_DIR/channel_syscall.c" -o "$GLUE_OBJ_DIR/channel_syscall.o"
    # shellcheck disable=SC2086
    "$LLVM_CLANG" $WASM_COMPILE_FLAGS -O2 -c "$GLUE_SRC_DIR/compiler_rt.c" -o "$GLUE_OBJ_DIR/compiler_rt.o"
fi

# --- Phase 1: libpcaudio.a (OSS backend only) --------------------------
# We don't run pcaudiolib's autotools / libtool — for five files we just
# compile and archive directly. See packages/registry/libxml2/
# build-libxml2.sh for the same "skip libtool" rationale.
#
# pcaudiolib picks its backend from config.h, the header its autotools
# run generates. Defining only HAVE_SYS_SOUNDCARD_H leaves src/oss.c as
# the one live backend, and it opens /dev/dsp. The alsa, pulseaudio and
# qsa units compile to `return NULL` stubs; they are still built because
# create_audio_device_object in audio.c references their symbols and
# falls through them to the OSS object. No source file is patched.
PCAUDIO_BUILD_DIR="$HERE/pcaudiolib-build"
PCAUDIO_CONFIG_DIR="$PCAUDIO_BUILD_DIR/config"
mkdir -p "$PCAUDIO_CONFIG_DIR"
printf '#define HAVE_SYS_SOUNDCARD_H 1\n' > "$PCAUDIO_CONFIG_DIR/config.h"

echo "==> Building libpcaudio.a (OSS backend)..."
PCAUDIO_CFLAGS=(
    -O2
    -I"$PCAUDIO_CONFIG_DIR"
    -I"$PCAUDIO_SRC_DIR/src"
    -I"$PCAUDIO_SRC_DIR/src/include"
)
PCAUDIO_OBJS=()
for unit in audio oss alsa pulseaudio qsa; do
    wasm32posix-cc "${PCAUDIO_CFLAGS[@]}" -c "$PCAUDIO_SRC_DIR/src/$unit.c" -o "$PCAUDIO_BUILD_DIR/$unit.o"
    PCAUDIO_OBJS+=("$PCAUDIO_BUILD_DIR/$unit.o")
done
wasm32posix-ar rcs "$PCAUDIO_BUILD_DIR/libpcaudio.a" "${PCAUDIO_OBJS[@]}"

# Short-circuit the FetchContent of sonic in upstream cmake/deps.cmake.
# The upstream file unconditionally clones github.com/waywardgeek/sonic
# when find_library doesn't locate libsonic — which it won't on host
# or wasm32 — and that requires network at configure time and pulls
# a stale dep into both builds. We don't use libsonic anyway
# (USE_LIBSONIC=OFF). Replace the whole sonic block with a no-op.
DEPS_CMAKE="$SRC_DIR/cmake/deps.cmake"
DEPS_CMAKE_BACKUP="$DEPS_CMAKE.kandelo.orig"
if [ ! -f "$DEPS_CMAKE_BACKUP" ]; then
    cp "$DEPS_CMAKE" "$DEPS_CMAKE_BACKUP"
fi
python3 - "$DEPS_CMAKE_BACKUP" "$DEPS_CMAKE" <<'PYEOF'
import sys, re
src_path, dst_path = sys.argv[1], sys.argv[2]
text = open(src_path).read()
text = re.sub(
    r"if \(SONIC_LIB AND SONIC_INC\).*?endif\(\)",
    "if (SONIC_LIB AND SONIC_INC)\n  set(HAVE_LIBSONIC ON)\nendif()",
    text,
    count=1,
    flags=re.DOTALL,
)
open(dst_path, "w").write(text)
PYEOF

# Trim the dict list down to ESPEAK_LANG_LIST for the cross build so we
# don't bloat the VFS image with ~80 languages. data.cmake is the upstream
# file we mutate; the change is one find-and-replace and we keep a backup.
DATA_CMAKE="$SRC_DIR/cmake/data.cmake"
DATA_CMAKE_BACKUP="$DATA_CMAKE.kandelo.orig"
if [ ! -f "$DATA_CMAKE_BACKUP" ]; then
    cp "$DATA_CMAKE" "$DATA_CMAKE_BACKUP"
fi
echo "==> Restricting data.cmake to languages: $ESPEAK_LANG_LIST"
# Rewrite the _dict_compile_list literal. The upstream definition spans
# many lines; we replace the whole block with a single-line one.
python3 - "$DATA_CMAKE_BACKUP" "$DATA_CMAKE" "$ESPEAK_LANG_LIST" <<'PYEOF'
import sys, re
src_path, dst_path, langs = sys.argv[1], sys.argv[2], sys.argv[3]
text = open(src_path).read()
new_block = "list(APPEND _dict_compile_list " + langs + ")\n"
text = re.sub(
    r"list\(APPEND _dict_compile_list[^)]*\)\s*",
    new_block,
    text,
    count=1,
    flags=re.DOTALL,
)
open(dst_path, "w").write(text)
PYEOF

# --- Phase 2: native build of espeak-ng (for data-dir generation) ------
# The `data` target runs espeak-ng with --compile-intonations /
# --compile-phonemes / --compile=<lang> to write the phondata /
# phonindex / phontab / intonations / <lang>_dict files. cmake/data.cmake
# always invokes `$<TARGET_FILE:espeak-ng-bin>`, the binary of the tree
# it runs in, so the cross tree would try to execute a wasm module.
# Build the data here instead, after the two cmake rewrites above so this
# build honours ESPEAK_LANG_LIST too. The outputs are byte tables, not
# code, and both this host and wasm32 are little-endian, so the cross
# build consumes them unchanged.
NATIVE_BUILD_DIR="$HERE/espeak-ng-host-build"
if [ ! -d "$NATIVE_BUILD_DIR/espeak-ng-data" ]; then
    echo "==> Native build of espeak-ng (for data tools)..."
    mkdir -p "$NATIVE_BUILD_DIR"
    # Use the wrapped cc/c++ drivers on PATH, not the bare LLVM binaries
    # CMake finds first. Only the wrappers carry the host C++ standard
    # library include paths, and speechPlayer is C++.
    cmake -S "$SRC_DIR" -B "$NATIVE_BUILD_DIR" \
        -DCMAKE_C_COMPILER=cc \
        -DCMAKE_CXX_COMPILER=c++ \
        -DCMAKE_INSTALL_PREFIX=/usr \
        -DBUILD_SHARED_LIBS=OFF \
        -DUSE_MBROLA=OFF \
        -DUSE_LIBSONIC=OFF \
        -DUSE_LIBPCAUDIO=OFF \
        -DCOMPILE_INTONATIONS=ON \
        -DESPEAK_COMPAT=OFF \
        -DENABLE_TESTS=OFF \
        > /dev/null
    cmake --build "$NATIVE_BUILD_DIR" --target espeak-ng-bin -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)"
    cmake --build "$NATIVE_BUILD_DIR" --target data           -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)"
fi

# --- Resolve libcxx, then index it into the sysroot --------------------
# espeak-ng's speechPlayer synthesizer is C++, and upstream builds it
# unconditionally — src/CMakeLists.txt adds the subdirectory without
# testing USE_SPEECHPLAYER. Index the resolved header tree and archives
# into the sysroot the same way build-mariadb.sh does.
LIBCXX_PREFIX="${WASM_POSIX_DEP_LIBCXX_DIR:-}"
if [ -z "$LIBCXX_PREFIX" ]; then
    echo "==> Resolving libcxx via cargo xtask build-deps..."
    HOST_TARGET="$(rustc -vV | awk '/^host/ {print $2}')"
    LIBCXX_PREFIX="$(cd "$REPO_ROOT" && cargo run -p xtask --target "$HOST_TARGET" --quiet -- build-deps --arch=wasm32 resolve libcxx)"
fi
for artifact in lib/libc++.a lib/libc++abi.a include/c++/v1; do
    [ -e "$LIBCXX_PREFIX/$artifact" ] || {
        echo "ERROR: libcxx resolve missing $artifact at $LIBCXX_PREFIX" >&2
        exit 1
    }
done

# Under the resolver, project a private sysroot with the resolved libcxx
# overlaid: the worktree SDK seed is an input tree for every package build
# and must hold no symlink. A direct invocation has no resolver work dir
# and indexes the artifacts into the worktree sysroot instead.
if [ -n "${WASM_POSIX_DEP_WORK_DIR:-}" ]; then
    # shellcheck source=/dev/null
    source "$REPO_ROOT/scripts/package-build-roots.sh"
    export WASM_POSIX_DEP_LIBCXX_DIR="$LIBCXX_PREFIX"
    SYSROOT="$(
        kandelo_package_prepare_private_sysroot espeak-ng "$SYSROOT" libcxx
    )"
    export WASM_POSIX_SYSROOT="$SYSROOT"
fi

mkdir -p "$SYSROOT/lib" "$SYSROOT/include/c++"
ln -sf "$LIBCXX_PREFIX/lib/libc++.a"    "$SYSROOT/lib/libc++.a"
ln -sf "$LIBCXX_PREFIX/lib/libc++abi.a" "$SYSROOT/lib/libc++abi.a"
rm -rf "$SYSROOT/include/c++/v1"
ln -sfn "$LIBCXX_PREFIX/include/c++/v1" "$SYSROOT/include/c++/v1"
echo "==> libcxx resolved at $LIBCXX_PREFIX (projected into $SYSROOT)"

# --- Phase 3: cross build of espeak-ng ---------------------------------
# The private sysroot is a fresh directory per resolve, and cmake bakes
# --sysroot into CMAKE_CXX_FLAGS at configure time. Configure from scratch so
# a reused cache cannot pin a sysroot that no longer holds libc++.
CROSS_BUILD_DIR="$HERE/espeak-ng-cross-build"
rm -rf "$CROSS_BUILD_DIR"
mkdir -p "$CROSS_BUILD_DIR"

echo "==> Cross-compiling espeak-ng for wasm32..."
cmake -S "$SRC_DIR" -B "$CROSS_BUILD_DIR" \
    -DCMAKE_TOOLCHAIN_FILE="$HERE/wasm32-posix-toolchain.cmake" \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_INSTALL_PREFIX=/usr \
    -DBUILD_SHARED_LIBS=OFF \
    -DUSE_MBROLA=OFF \
    -DUSE_LIBSONIC=OFF \
    -DUSE_LIBPCAUDIO=ON \
    -DUSE_KLATT=ON \
    -DUSE_SPEECHPLAYER=ON \
    -DUSE_ASYNC=OFF \
    -DENABLE_TESTS=OFF \
    -DCOMPILE_INTONATIONS=ON \
    -DESPEAK_COMPAT=OFF \
    -DPCAUDIO_LIB="$PCAUDIO_BUILD_DIR/libpcaudio.a" \
    -DPCAUDIO_INC="$PCAUDIO_SRC_DIR/src/include" \
    -DHAVE_LIBPCAUDIO=ON \
    -DHAVE_PTHREAD=OFF

cmake --build "$CROSS_BUILD_DIR" --target espeak-ng-bin -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)"

# --- Phase 4: stage outputs --------------------------------------------
echo "==> Staging into $INSTALL_DIR..."
mkdir -p "$INSTALL_DIR"

# espeak-ng-bin produces a "espeak-ng" file with no extension; rename
# to .wasm for the package resolver's binary contract.
cp "$CROSS_BUILD_DIR/src/espeak-ng" "$INSTALL_DIR/espeak-ng.wasm"

# Restore data.cmake + deps.cmake so the source tree stays clean for next build.
mv "$DATA_CMAKE_BACKUP" "$DATA_CMAKE"
mv "$DEPS_CMAKE_BACKUP" "$DEPS_CMAKE"

# Pack the native build's data dir into the declared runtime file. Stored-only,
# sorted, with a fixed timestamp and mode, so the archive bytes follow the voice
# data alone and the package cache key stays stable across rebuilds. Same shape
# as cpython's python-runtime.zip.
DATA_ZIP="$INSTALL_DIR/espeak-ng-data.zip"
rm -f "$DATA_ZIP"
python3 - "$NATIVE_BUILD_DIR/espeak-ng-data" "$DATA_ZIP" <<'PY'
from pathlib import Path
import stat
import sys
import zipfile

root = Path(sys.argv[1])
output = Path(sys.argv[2])
timestamp = (1980, 1, 1, 0, 0, 0)
with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_STORED, strict_timestamps=True) as archive:
    for path in sorted((item for item in root.rglob("*") if item.is_file()), key=lambda item: item.as_posix()):
        info = zipfile.ZipInfo(path.relative_to(root).as_posix(), date_time=timestamp)
        info.create_system = 3
        info.external_attr = (stat.S_IFREG | 0o644) << 16
        info.compress_type = zipfile.ZIP_STORED
        archive.writestr(info, path.read_bytes())
PY

# Both filenames exactly match the package.toml [[outputs]] and
# [[runtime_files]] entries; the installer re-checks artifact policy.
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary espeak-ng "$INSTALL_DIR/espeak-ng.wasm"
install_local_runtime_file espeak-ng "$DATA_ZIP"

echo "==> Done. Outputs:"
echo "    $INSTALL_DIR/espeak-ng.wasm"
echo "    $DATA_ZIP"
