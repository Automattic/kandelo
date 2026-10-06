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
# Output layout:
#
#   $INSTALL_DIR/
#     bin/espeak-ng.wasm                       (executable wasm binary)
#     share/espeak-ng-data/                    (phoneme + voice data dir,
#                                              compiled by the native bin)
#     share/espeak-ng-data.zip                 (that dir packed as the
#                                              declared runtime file)
#
# Default install dir for legacy / ad-hoc invocation is
# ./espeak-ng-install/ next to this script. Sources and build trees live
# under the resolver work root ($WASM_POSIX_DEP_WORK_DIR), or next to this
# script for a standalone run.

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/package-build-roots.sh"
# WHY: two resolves of this recipe can run at once in one checkout (two
# test files missing the cache together). Each keeps its source and build
# tree under its own resolver work root so neither deletes the other's.
# A standalone run keeps them beside this script.
kandelo_package_prepare_build_roots "$HERE" wasm32
WORK_DIR="$KANDELO_PACKAGE_WORK_DIR"
PCAUDIO_SRC_DIR="$WORK_DIR/pcaudiolib-src"
SRC_DIR="$WORK_DIR/espeak-ng-src"

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
# The SDK sysroot is a read-only seed. libcxx is overlaid onto a private
# copy below, never into this shared tree.
SDK_SYSROOT="${WASM_POSIX_SYSROOT:-$REPO_ROOT/sysroot}"
export WASM_POSIX_SYSROOT="$SDK_SYSROOT"

if ! command -v wasm32posix-cc >/dev/null; then
    echo "ERROR: wasm32posix-cc not found on PATH after sourcing sdk/activate.sh." >&2
    exit 1
fi
if [ ! -f "$SDK_SYSROOT/lib/libc.a" ]; then
    echo "ERROR: kandelo sysroot not built at $SDK_SYSROOT. Run bash scripts/build-musl.sh first." >&2
    exit 1
fi
for tool in cmake curl tar shasum python3; do
    command -v "$tool" >/dev/null || {
        echo "ERROR: required build tool not found: $tool" >&2
        exit 1
    }
done

# --- Fetch upstream sources --------------------------------------------
# Both trees are staged under the work root. espeak-ng is the declared
# source, so a resolver handoff is copied rather than re-downloaded.
# pcaudiolib is a second pin this script verifies itself.
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

if [ ! -d "$SRC_DIR" ]; then
    echo "==> Staging verified espeak-ng $ESPEAK_VERSION source..."
    kandelo_package_stage_verified_source espeak-ng "$SRC_DIR" \
        "${WASM_POSIX_DEP_SOURCE_DIR:-}" "$ESPEAK_SOURCE_URL" "$ESPEAK_SOURCE_SHA256" \
        "$WORK_DIR"
fi
fetch_source "$PCAUDIO_SOURCE_URL" "$PCAUDIO_SOURCE_SHA256" "$PCAUDIO_SRC_DIR" "pcaudiolib $PCAUDIO_VERSION"

# --- Locate host LLVM (for glue obj compile + native build) ---
LLVM_PREFIX="${LLVM_PREFIX:-$(brew --prefix llvm 2>/dev/null || echo /opt/homebrew/opt/llvm)}"
LLVM_CLANG="$LLVM_PREFIX/bin/clang"

# --- Phase 0: kandelo glue objs ----------------------------------------
# Mirrors mariadb's mariadb-glue-objs/. crt1.o comes from the sysroot;
# the channel_syscall + compiler_rt objects come from the kandelo libc
# glue and are linked into every user program at exec time. They are
# compiled against the read-only SDK seed sysroot. The toolchain file finds
# them through ESPEAK_GLUE_OBJ_DIR.
GLUE_OBJ_DIR="$WORK_DIR/glue-objs"
export ESPEAK_GLUE_OBJ_DIR="$GLUE_OBJ_DIR"
GLUE_SRC_DIR="$REPO_ROOT/libc/glue"
mkdir -p "$GLUE_OBJ_DIR"
# Compile both objects on every build. They are two small files, and a
# timestamp check on channel_syscall.c alone missed changes to the headers it
# includes (abi_constants.h carries the ABI version) and to compiler_rt.c.
{
    echo "==> Compiling kandelo glue objs..."
    WASM_COMPILE_FLAGS="--target=wasm32-unknown-unknown -matomics -mbulk-memory -mexception-handling -mllvm -wasm-enable-sjlj -fno-trapping-math --sysroot=$SDK_SYSROOT"
    # shellcheck disable=SC2086
    "$LLVM_CLANG" $WASM_COMPILE_FLAGS -O2 -c "$GLUE_SRC_DIR/channel_syscall.c" -o "$GLUE_OBJ_DIR/channel_syscall.o"
    # shellcheck disable=SC2086
    "$LLVM_CLANG" $WASM_COMPILE_FLAGS -O2 -c "$GLUE_SRC_DIR/compiler_rt.c" -o "$GLUE_OBJ_DIR/compiler_rt.o"
}

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
PCAUDIO_BUILD_DIR="$WORK_DIR/pcaudiolib-build"
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
# file we mutate (in the work-root copy); the change is one
# find-and-replace and we keep a backup.
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
NATIVE_BUILD_DIR="$WORK_DIR/espeak-ng-host-build"
if [ ! -d "$NATIVE_BUILD_DIR/espeak-ng-data" ]; then
    echo "==> Native build of espeak-ng (for data tools)..."
    mkdir -p "$NATIVE_BUILD_DIR"
    # Use the wrapped cc/c++ drivers on PATH, not the bare LLVM binaries
    # CMake finds first. Only the wrappers carry the host C++ standard
    # library include paths, and speechPlayer is C++.
    #
    # The data step runs this tool with ESPEAK_DATA_PATH set to the build
    # dir. espeak-ng keeps that path in a 160-byte buffer on POSIX
    # (N_PATH_HOME_DEF in speech.h) and falls back to /usr/share when it
    # does not fit; a resolver work-root path is longer than that.
    # speech.h lets a build raise the limit with -DN_PATH_HOME, and every
    # dependent buffer is sized from it. Host tool only: the wasm binary
    # reads its data from the guest's short default path.
    cmake -S "$SRC_DIR" -B "$NATIVE_BUILD_DIR" \
        -DCMAKE_C_COMPILER=cc \
        -DCMAKE_CXX_COMPILER=c++ \
        -DCMAKE_C_FLAGS=-DN_PATH_HOME=4096 \
        -DCMAKE_CXX_FLAGS=-DN_PATH_HOME=4096 \
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

# --- Resolve libcxx, then overlay it onto a private sysroot ------------
# espeak-ng's speechPlayer synthesizer is C++, and upstream builds it
# unconditionally — src/CMakeLists.txt adds the subdirectory without
# testing USE_SPEECHPLAYER. Overlay the resolved header tree and archives
# onto a private copy of the SDK sysroot under the work root, as dinit and
# qtbase do, so the shared checkout sysroot is never mutated.
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

export WASM_POSIX_DEP_LIBCXX_DIR="$LIBCXX_PREFIX"
# The helper requires a declared work root; a standalone run uses the one
# beside this script.
SYSROOT="$(
    WASM_POSIX_DEP_WORK_DIR="$WORK_DIR" \
        kandelo_package_prepare_private_sysroot espeak-ng "$SDK_SYSROOT" libcxx
)"
export WASM_POSIX_SYSROOT="$SYSROOT"
echo "==> libcxx resolved at $LIBCXX_PREFIX (overlaid onto $SYSROOT)"

# --- Phase 3: cross build of espeak-ng ---------------------------------
CROSS_BUILD_DIR="$WORK_DIR/espeak-ng-cross-build"
# Configure from scratch. CMake applies a toolchain file's *_INIT flags only
# on the first configure of a build tree, so a reused tree silently kept the
# link line from whichever toolchain first configured it. The resolver runs
# this script only when the package's inputs changed; that is exactly when a
# stale cache would be wrong.
rm -rf "$CROSS_BUILD_DIR"
mkdir -p "$CROSS_BUILD_DIR"

echo "==> Cross-compiling espeak-ng for wasm32..."
# The toolchain file drives raw clang, so the SDK wrapper's automatic
# work-root prefix map does not apply. Map the work root (which carries a
# per-build PID under the resolver) here; CMake folds CFLAGS/CXXFLAGS into
# the toolchain's *_FLAGS_INIT on first configure.
CROSS_PREFIX_MAP="-ffile-prefix-map=$WORK_DIR=/usr/src/kandelo-build/espeak-ng"
CFLAGS="$CROSS_PREFIX_MAP" CXXFLAGS="$CROSS_PREFIX_MAP" \
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
mkdir -p "$INSTALL_DIR/bin" "$INSTALL_DIR/share"

# espeak-ng-bin produces a "espeak-ng" file with no extension; rename
# to .wasm for the package resolver's binary contract.
cp "$CROSS_BUILD_DIR/src/espeak-ng" "$INSTALL_DIR/bin/espeak-ng.wasm"

# Data dir: the native build wrote it under NATIVE_BUILD_DIR/espeak-ng-data/.
rm -rf "$INSTALL_DIR/share/espeak-ng-data"
cp -R "$NATIVE_BUILD_DIR/espeak-ng-data" "$INSTALL_DIR/share/espeak-ng-data"

# Restore data.cmake + deps.cmake so a reused standalone source tree stays
# clean for the next build.
mv "$DATA_CMAKE_BACKUP" "$DATA_CMAKE"
mv "$DEPS_CMAKE_BACKUP" "$DEPS_CMAKE"

# Pack the data dir into the declared runtime file. Stored-only, sorted, with
# a fixed timestamp and mode, so the archive bytes follow the voice data alone
# and the package cache key stays stable across rebuilds. Same shape as
# cpython's python-runtime.zip.
DATA_ZIP="$INSTALL_DIR/share/espeak-ng-data.zip"
rm -f "$DATA_ZIP"
python3 - "$INSTALL_DIR/share/espeak-ng-data" "$DATA_ZIP" <<'PY'
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
# A resolver caller owns the declared work and output roots. Keep the
# reviewed checkout read-only and suppress the developer-only local mirror.
if [ -n "${WASM_POSIX_DEP_WORK_DIR:-}" ] && [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
    export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto
fi
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary espeak-ng "$INSTALL_DIR/bin/espeak-ng.wasm"
# The resolver's validate_outputs checks $OUT_DIR/<artifact> at the root,
# but the data zip is built under share/, and install_local_runtime_file
# only publishes to the local-binaries mirror (not the OUT_DIR root) in the
# default mirror mode — so the resolver would report it "not produced".
# Publish it at the OUT_DIR root as resolver scratch, exactly as cpython
# does for python-runtime.zip; fall back to the mirror when OUT_DIR is unset
# (a direct, non-resolver invocation).
if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    cp "$DATA_ZIP" "$WASM_POSIX_DEP_OUT_DIR/espeak-ng-data.zip"
    echo "  installed $WASM_POSIX_DEP_OUT_DIR/espeak-ng-data.zip (resolver scratch)"
else
    install_local_runtime_file espeak-ng "$DATA_ZIP"
fi

echo "==> Done. Outputs:"
echo "    $INSTALL_DIR/bin/espeak-ng.wasm"
echo "    $DATA_ZIP"
