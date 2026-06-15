#!/usr/bin/env bash
#
# Build espeak-ng for wasm32-posix-kernel.
#
# Two-pass build:
#
#   1. Native build of espeak-ng on the host. We only need its
#      binary (espeak-ng) to compile phoneme + intonation data
#      out of phsource/ + dictsource/ via the --compile-* commands.
#      No data files are written until the cross-build's `data`
#      target runs.
#   2. Cross build of espeak-ng for wasm32. Uses our patched
#      pcaudiolib (kandelo backend baked into create_audio_device_object)
#      so the resulting espeak-ng.wasm opens /dev/snd/pcmC0D0p directly
#      and produces audible speech inside the kandelo browser preset.
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

# --- Phase 1: libpcaudio.a (kandelo backend) ---------------------------
# We don't run pcaudiolib's autotools / libtool — for two files we just
# compile and archive directly. See packages/registry/libxml2/
# build-libxml2.sh for the same "skip libtool" rationale.
PCAUDIO_BUILD_DIR="$HERE/pcaudiolib-build"
mkdir -p "$PCAUDIO_BUILD_DIR"

echo "==> Building libpcaudio.a (kandelo backend)..."
PCAUDIO_CFLAGS=(
    -O2
    -DHAVE_KANDELO
    -I"$PCAUDIO_SRC_DIR/src"
    -I"$PCAUDIO_SRC_DIR/src/include"
)
wasm32posix-cc "${PCAUDIO_CFLAGS[@]}" -c "$PCAUDIO_SRC_DIR/src/audio.c"          -o "$PCAUDIO_BUILD_DIR/audio.o"
wasm32posix-cc "${PCAUDIO_CFLAGS[@]}" -c "$PCAUDIO_SRC_DIR/src/audio_kandelo.c" -o "$PCAUDIO_BUILD_DIR/audio_kandelo.o"
wasm32posix-ar rcs "$PCAUDIO_BUILD_DIR/libpcaudio.a" \
    "$PCAUDIO_BUILD_DIR/audio.o" "$PCAUDIO_BUILD_DIR/audio_kandelo.o"

# --- Phase 2: native build of espeak-ng (for data-dir generation) ------
# The cross-build's `data` target runs the native espeak-ng under
# CMAKE_CROSSCOMPILING with --compile-intonations / --compile-phonemes /
# --compile=<lang> to write the phondata / phonindex / phontab /
# intonations / <lang>_dict binary files. We just need the binary; we
# don't ship anything from this build.
NATIVE_BUILD_DIR="$HERE/espeak-ng-host-build"
if [ ! -x "$NATIVE_BUILD_DIR/src/espeak-ng" ]; then
    echo "==> Native build of espeak-ng (for data tools)..."
    mkdir -p "$NATIVE_BUILD_DIR"
    cmake -S "$SRC_DIR" -B "$NATIVE_BUILD_DIR" \
        -DCMAKE_INSTALL_PREFIX=/usr \
        -DBUILD_SHARED_LIBS=OFF \
        -DUSE_MBROLA=OFF \
        -DUSE_LIBSONIC=OFF \
        -DUSE_LIBPCAUDIO=OFF \
        -DCOMPILE_INTONATIONS=OFF \
        -DESPEAK_COMPAT=OFF \
        -DENABLE_TESTS=OFF \
        > /dev/null
    cmake --build "$NATIVE_BUILD_DIR" --target espeak-ng-bin -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)"
fi

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

# --- Phase 3: cross build of espeak-ng ---------------------------------
CROSS_BUILD_DIR="$HERE/espeak-ng-cross-build"
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
    -DNativeBuild_DIR="$NATIVE_BUILD_DIR/src" \
    -DNativeBuild="$NATIVE_BUILD_DIR/src" \
    -DPCAUDIO_LIB="$PCAUDIO_BUILD_DIR/libpcaudio.a" \
    -DPCAUDIO_INC="$PCAUDIO_SRC_DIR/src/include" \
    -DHAVE_LIBPCAUDIO=ON \
    -DHAVE_PTHREAD=OFF

cmake --build "$CROSS_BUILD_DIR" --target espeak-ng-bin -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)"
cmake --build "$CROSS_BUILD_DIR" --target data           -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)"

# --- Phase 4: stage outputs --------------------------------------------
echo "==> Staging into $INSTALL_DIR..."
mkdir -p "$INSTALL_DIR/bin" "$INSTALL_DIR/share"

# espeak-ng-bin produces a "espeak-ng" file with no extension; rename
# to .wasm for the package resolver's binary contract.
cp "$CROSS_BUILD_DIR/src/espeak-ng" "$INSTALL_DIR/bin/espeak-ng.wasm"

# Data dir: the cross build wrote it under CROSS_BUILD_DIR/espeak-ng-data/.
rm -rf "$INSTALL_DIR/share/espeak-ng-data"
cp -R "$CROSS_BUILD_DIR/espeak-ng-data" "$INSTALL_DIR/share/espeak-ng-data"

# Restore data.cmake + deps.cmake so the source tree stays clean for next build.
mv "$DATA_CMAKE_BACKUP" "$DATA_CMAKE"
mv "$DEPS_CMAKE_BACKUP" "$DEPS_CMAKE"

# Register the wasm binary in local-binaries so the resolver picks it
# up alongside released archives. The data dir is consumed by the
# shell-VFS builder directly out of $INSTALL_DIR/share/ — no
# install_local_binary path since the data dir is not a wasm output
# (single [[outputs]] entry only).
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary espeak-ng "$INSTALL_DIR/bin/espeak-ng.wasm"

echo "==> Done. Outputs:"
echo "    $INSTALL_DIR/bin/espeak-ng.wasm"
echo "    $INSTALL_DIR/share/espeak-ng-data/"
